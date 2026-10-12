// Edge Function: soporte-calcom-sync
// RESPALDO del webhook de Cal.com: consulta la API de Cal.com y registra en
// Supabase las reuniones de soporte que todavía no existan (o que hayan
// cambiado de horario). Nunca duplica: todo pasa por fn_soporte_cita_agendada,
// que hace upsert por `calcom_uid`.
//
//   • Club (owner): POST { club_id }  → solo reservas de SU club (por
//     metadata.club_id o por el correo del propietario como asistente).
//   • SuperAdmin:   POST {}           → todas las reservas próximas.
//
// Si no hay CALCOM_API_KEY configurada responde { ok: false, motivo: 'sin_api_key' }
// (200) y la app simplemente la ignora.
//
// Secrets: CALCOM_API_KEY (Settings → Developer → API Keys de Cal.com).
// Desplegar CON verificación de JWT (la llama el navegador con la sesión):
//   supabase functions deploy soporte-calcom-sync
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders, respuestaJson } from '../_shared/cors.ts';

const CAL_API = 'https://api.cal.com/v2';
const CAL_VERSION = '2024-08-13';

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
  if (ini && dur > 0) return new Date(new Date(ini).getTime() + dur * 60000).toISOString();
  return null;
}

function meetDe(b: Reserva): string | null {
  const candidatos = [b.meetingUrl, b.videoCallUrl, b?.metadata?.videoCallUrl, b.location];
  for (const c of candidatos) if (typeof c === 'string' && /^https:\/\//i.test(c)) return c;
  return null;
}

function correosDe(b: Reserva): string[] {
  return (Array.isArray(b.attendees) ? b.attendees : []).map((a: any) => String(a?.email || '').toLowerCase()).filter(Boolean);
}

async function reservasCal(apiKey: string, estado: string): Promise<Reserva[]> {
  const url = `${CAL_API}/bookings?status=${encodeURIComponent(estado)}&take=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': CAL_VERSION } });
  if (!r.ok) throw new Error(`Cal.com respondió ${r.status}`);
  const cuerpo = await r.json();
  const datos = cuerpo?.data;
  if (Array.isArray(datos)) return datos;
  if (Array.isArray(datos?.bookings)) return datos.bookings;
  return [];
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

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const cuerpo = await req.json().catch(() => ({}));
    const clubId = cuerpo?.club_id != null ? Number(cuerpo.club_id) : null;

    const { data: staff } = await admin.from('plataforma_staff').select('user_id').eq('user_id', usuario.id).eq('activo', true).maybeSingle();
    const esStaff = Boolean(staff);

    let correoPropietario = '';
    if (clubId != null) {
      const { data: club } = await admin.from('configuracion_club').select('id, propietario_user_id').eq('id', clubId).maybeSingle();
      if (!club) return respuestaJson({ error: 'Club no encontrado.' }, 404);
      if (club.propietario_user_id !== usuario.id && !esStaff) return respuestaJson({ error: 'Sin acceso a este club.' }, 403);
      correoPropietario = String(usuario.email || '').toLowerCase();
    } else if (!esStaff) {
      return respuestaJson({ error: 'Falta club_id.' }, 400);
    }

    const proximas = await reservasCal(apiKey, 'upcoming');
    let registradas = 0;
    const errores: string[] = [];
    for (const b of proximas) {
      const uid = texto(b.uid);
      const inicio = inicioDe(b);
      const fin = finDe(b);
      if (!uid || !inicio || !fin) continue;
      const clubMeta = Number(b?.metadata?.club_id);
      const correos = correosDe(b);
      if (clubId != null) {
        const esDelClub = clubMeta === clubId || (!clubMeta && correoPropietario && correos.includes(correoPropietario));
        if (!esDelClub) continue;
      }
      const { error } = await admin.rpc('fn_soporte_cita_agendada', {
        p_uid: uid,
        p_club_id: clubId ?? (clubMeta > 0 ? clubMeta : null),
        p_email: correos[0] ?? null,
        p_inicio: inicio,
        p_fin: fin,
        p_concepto: texto(b.description) || texto(b.title) || null,
        p_meet_url: meetDe(b),
      });
      if (error) errores.push(`${uid}: ${error.message}`);
      else registradas += 1;
    }
    return respuestaJson({ ok: true, revisadas: proximas.length, registradas, errores: errores.slice(0, 10) });
  } catch (err) {
    console.error('[soporte-calcom-sync]', err);
    return respuestaJson({ ok: false, error: (err as Error)?.message || 'No se pudo sincronizar con Cal.com.' }, 500);
  }
});
