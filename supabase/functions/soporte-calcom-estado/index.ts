// Edge Function: soporte-calcom-estado
// RETORNO desde Cal.com (cancelar / reagendar): cuando el club vuelve a
// QLUBOS después de cancelar o reagendar su reunión en Cal.com, el portal
// llama a esta función con los uid de las citas en cuestión. La función
// consulta el estado REAL de cada reserva en la API de Cal.com y lo aplica en
// Supabase al instante (sin esperar al webhook):
//   • cancelada              → fn_soporte_cita_cancelada (regla de 2 h)
//   • reagendada (nuevo uid) → fn_soporte_cita_reagendada (original al
//                              historial como 'reagendada' + cita nueva)
//   • aceptada con otro horario → fn_soporte_cita_agendada (sincroniza)
// El club solo puede consultar citas de SU club; el webhook de Cal.com sigue
// siendo el respaldo si el club cierra la ventana antes de volver.
//
// Secrets: CALCOM_API_KEY (Settings → Developer → API Keys de Cal.com).
// Sin API key responde { ok: false, motivo: 'sin_api_key' } y el portal espera
// al webhook (Realtime actualiza la pantalla en cuanto llega).
// Desplegar CON verificación de JWT (la llama el navegador con la sesión):
//   supabase functions deploy soporte-calcom-estado
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders, respuestaJson } from '../_shared/cors.ts';

const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSION = '2024-08-13';
const MAX_UIDS = 10;

type Reserva = Record<string, any>;

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function inicioDe(b: Reserva): string | null {
  return texto(b.start) || texto(b.startTime) || null;
}
function finDe(b: Reserva): string | null {
  const fin = texto(b.end) || texto(b.endTime);
  if (fin) return fin;
  const ini = inicioDe(b);
  const dur = Number(b.duration);
  return ini && dur > 0 ? new Date(new Date(ini).getTime() + dur * 60000).toISOString() : null;
}
function meetDe(b: Reserva): string | null {
  for (const c of [b.meetingUrl, b.videoCallUrl, b?.metadata?.videoCallUrl, b.location]) {
    if (typeof c === 'string' && /^https:\/\//i.test(c)) return c;
  }
  return null;
}
// uid de la reserva NUEVA cuando la original se reagendó (varía según la versión de la API).
function uidReagendadaDe(b: Reserva): string {
  return texto(b.rescheduledToUid) || texto(b?.rescheduledTo?.uid) || texto(b?.metadata?.rescheduledToUid) || '';
}
function esReagendada(b: Reserva): boolean {
  return Boolean(uidReagendadaDe(b)) || b.rescheduled === true || b.fromReschedule === true;
}
// Hora real de la cancelación (para la regla de 2 h); si no viene, ahora.
function canceladaEn(b: Reserva): string {
  for (const c of [b.cancelledAt, b.updatedAt]) {
    const t = typeof c === 'string' ? new Date(c).getTime() : NaN;
    if (Number.isFinite(t) && t <= Date.now()) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

async function calGet(apiKey: string, ruta: string): Promise<any> {
  const r = await fetch(`${CAL_API}${ruta}`, { headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': CAL_VERSION } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Cal.com respondió ${r.status}`);
  const cuerpo = await r.json();
  return cuerpo?.data ?? null;
}

// Busca la reserva nueva que viene de `uidAnterior` cuando la API no trae
// `rescheduledToUid` en la original.
async function buscarReagendada(apiKey: string, uidAnterior: string): Promise<Reserva | null> {
  const datos = await calGet(apiKey, '/bookings?status=upcoming&take=100');
  const lista: Reserva[] = Array.isArray(datos) ? datos : Array.isArray(datos?.bookings) ? datos.bookings : [];
  return lista.find((b) => texto(b.rescheduledFromUid) === uidAnterior || texto(b.fromReschedule) === uidAnterior) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return respuestaJson({ error: 'Método no permitido' }, 405);

  const apiKey = Deno.env.get('CALCOM_API_KEY') ?? '';
  if (!apiKey) return respuestaJson({ ok: false, motivo: 'sin_api_key' });

  try {
    const supabaseUsuario = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData } = await supabaseUsuario.auth.getUser();
    const usuario = userData?.user;
    if (!usuario) return respuestaJson({ error: 'Sesión inválida.' }, 401);

    const cuerpo = await req.json().catch(() => ({}));
    const clubId = Number(cuerpo?.club_id);
    const uids: string[] = (Array.isArray(cuerpo?.uids) ? cuerpo.uids : [])
      .map((u: unknown) => texto(u).trim())
      .filter((u: string) => u && u.length <= 200)
      .slice(0, MAX_UIDS);
    if (!Number.isFinite(clubId) || clubId <= 0) return respuestaJson({ error: 'Falta club_id.' }, 400);
    if (uids.length === 0) return respuestaJson({ ok: true, resultados: [] });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: club } = await admin.from('configuracion_club').select('id, propietario_user_id').eq('id', clubId).maybeSingle();
    if (!club) return respuestaJson({ error: 'Club no encontrado.' }, 404);
    if (club.propietario_user_id !== usuario.id) {
      const { data: staff } = await admin.from('plataforma_staff').select('user_id').eq('user_id', usuario.id).eq('activo', true).maybeSingle();
      if (!staff) return respuestaJson({ error: 'Sin acceso a este club.' }, 403);
    }

    const resultados: Record<string, unknown>[] = [];
    for (const uid of uids) {
      // Solo citas de ESTE club (nunca se toca una reserva ajena aunque se conozca su uid).
      const { data: ticket } = await admin.from('soporte_tickets').select('*').eq('calcom_uid', uid).maybeSingle();
      if (!ticket || Number(ticket.club_id) !== clubId) {
        resultados.push({ uid, resultado: 'no_encontrada' });
        continue;
      }
      if (ticket.estado !== 'agendada') {
        resultados.push({ uid, resultado: ticket.estado, ticket });
        continue;
      }
      try {
        const b: Reserva | null = await calGet(apiKey, `/bookings/${encodeURIComponent(uid)}`);
        if (!b) {
          resultados.push({ uid, resultado: 'sin_cambios' });
          continue;
        }
        const estado = texto(b.status).toLowerCase();
        if (estado === 'cancelled' || estado === 'rejected') {
          if (esReagendada(b)) {
            let nueva: Reserva | null = null;
            const uidNueva = uidReagendadaDe(b);
            nueva = uidNueva ? await calGet(apiKey, `/bookings/${encodeURIComponent(uidNueva)}`) : await buscarReagendada(apiKey, uid);
            if (nueva && inicioDe(nueva) && finDe(nueva)) {
              const { data, error } = await admin.rpc('fn_soporte_cita_reagendada', {
                p_uid_anterior: uid,
                p_uid: texto(nueva.uid) || uidNueva,
                p_inicio: inicioDe(nueva),
                p_fin: finDe(nueva),
                p_meet_url: meetDe(nueva),
              });
              if (error) throw error;
              resultados.push({ uid, resultado: 'reagendada', nueva: data });
              continue;
            }
            // Reagendada pero aún sin datos de la nueva: el webhook la completará.
            resultados.push({ uid, resultado: 'pendiente' });
            continue;
          }
          const { data, error } = await admin.rpc('fn_soporte_cita_cancelada', { p_uid: uid, p_cancelado_en: canceladaEn(b) });
          if (error) throw error;
          resultados.push({ uid, resultado: 'cancelada', ticket: data });
          continue;
        }
        // Sigue activa: si cambió de horario, se sincroniza.
        const inicio = inicioDe(b);
        const fin = finDe(b);
        if (inicio && fin && new Date(inicio).getTime() !== new Date(ticket.inicio).getTime()) {
          const { data, error } = await admin.rpc('fn_soporte_cita_agendada', {
            p_uid: uid,
            p_club_id: clubId,
            p_email: null,
            p_inicio: inicio,
            p_fin: fin,
            p_concepto: null,
            p_meet_url: meetDe(b),
          });
          if (error) throw error;
          resultados.push({ uid, resultado: 'actualizada', ticket: data });
          continue;
        }
        resultados.push({ uid, resultado: 'sin_cambios' });
      } catch (err) {
        resultados.push({ uid, resultado: 'error', error: (err as Error)?.message || 'Error consultando Cal.com' });
      }
    }
    return respuestaJson({ ok: true, resultados });
  } catch (err) {
    console.error('[soporte-calcom-estado]', err);
    return respuestaJson({ ok: false, error: (err as Error)?.message || 'No se pudo consultar Cal.com.' }, 500);
  }
});
