// Edge Function: soporte-calcom-webhook
// Sincroniza las videollamadas agendadas en Cal.com (conectado a Google
// Calendar + Google Meet) con la bolsa de horas de cada club:
//   • BOOKING_CREATED      → crea la cita "agendada" y RETIENE sus minutos.
//   • BOOKING_RESCHEDULED  → la cita original pasa al Historial como
//                            'reagendada' (regla de 2 h) y se crea la nueva
//                            'agendada' que retiene sus minutos (v101).
//   • BOOKING_CANCELLED    → aplica la política: ≥ 2 h antes libera todo,
//                            < 2 h antes cobra el 50 %.
// Es el RESPALDO asíncrono del retorno al portal (soporte-calcom-estado): si
// el club cierra la ventana de Cal.com sin volver a QLUBOS, este webhook
// actualiza igual la cita, el historial y las horas (Realtime lo refleja).
// Webhook + retorno pueden llegar ambos: las funciones son idempotentes.
// Cal.com ya evita el overbooking: revisa en vivo la disponibilidad de tu
// Google Calendar corporativo y de todas las citas de todos los clubes.
//
// El club se identifica por `metadata[club_id]` (lo agrega el Panel al abrir
// el widget) y, de respaldo, por el correo del propietario.
//
// Desplegar SIN verificación de JWT (Cal.com no manda uno):
//   supabase functions deploy soporte-calcom-webhook --no-verify-jwt
// En Cal.com → Settings → Developer → Webhooks:
//   URL: https://<proyecto>.supabase.co/functions/v1/soporte-calcom-webhook
//   Eventos: Booking Created, Booking Rescheduled, Booking Cancelled
//   Secret: el mismo valor que CALCOM_WEBHOOK_SECRET.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const encoder = new TextEncoder();

async function firmaValida(cuerpo: string, firmaRecibida: string | null, secreto: string): Promise<boolean> {
  if (!secreto) return false;
  if (!firmaRecibida) return false;
  const llave = await crypto.subtle.importKey('raw', encoder.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', llave, encoder.encode(cuerpo));
  const hex = Array.from(new Uint8Array(firma)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const recibida = firmaRecibida.trim().toLowerCase();
  if (hex.length !== recibida.length) return false;
  let diferencia = 0;
  for (let i = 0; i < hex.length; i++) diferencia |= hex.charCodeAt(i) ^ recibida.charCodeAt(i);
  return diferencia === 0;
}

function urlMeet(p: Record<string, any>): string | null {
  const candidatos = [p?.metadata?.videoCallUrl, p?.videoCallData?.url, p?.location];
  for (const c of candidatos) {
    if (typeof c === 'string' && /^https:\/\//i.test(c)) return c;
  }
  return null;
}

function clubIdDe(p: Record<string, any>): number | null {
  const crudo = p?.metadata?.club_id ?? p?.responses?.club_id?.value ?? p?.responses?.club_id;
  const n = Number(crudo);
  return Number.isFinite(n) && n > 0 ? n : null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Método no permitido', { status: 405 });

  const cuerpo = await req.text();
  const ok = await firmaValida(cuerpo, req.headers.get('X-Cal-Signature-256'), Deno.env.get('CALCOM_WEBHOOK_SECRET') ?? '');
  if (!ok) return new Response('Firma inválida', { status: 401 });

  let evento: Record<string, any>;
  try {
    evento = JSON.parse(cuerpo);
  } catch (_e) {
    return new Response('JSON inválido', { status: 400 });
  }

  const tipo = evento?.triggerEvent;
  const p = evento?.payload ?? {};
  if (tipo === 'PING') return new Response(JSON.stringify({ pong: true }), { status: 200 });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const correo = p?.attendees?.[0]?.email ?? p?.responses?.email?.value ?? null;

  try {
    if (tipo === 'BOOKING_CREATED') {
      const { error } = await admin.rpc('fn_soporte_cita_agendada', {
        p_uid: p.uid,
        p_club_id: clubIdDe(p),
        p_email: correo,
        p_inicio: p.startTime,
        p_fin: p.endTime,
        p_concepto: p?.responses?.notes?.value || p?.description || p?.title || 'Videollamada de soporte',
        p_meet_url: urlMeet(p),
      });
      if (error) throw error;
    } else if (tipo === 'BOOKING_RESCHEDULED') {
      const uidAnterior = p.rescheduleUid ?? p.rescheduledFromUid ?? p.fromReschedule ?? p?.metadata?.rescheduleUid ?? null;
      let movida = null;
      if (uidAnterior) {
        const { data, error } = await admin.rpc('fn_soporte_cita_reagendada', {
          p_uid_anterior: uidAnterior,
          p_uid: p.uid,
          p_inicio: p.startTime,
          p_fin: p.endTime,
          p_meet_url: urlMeet(p),
        });
        if (error) throw error;
        movida = data?.id ? data : null;
      }
      if (!movida) {
        const { error } = await admin.rpc('fn_soporte_cita_agendada', {
          p_uid: p.uid,
          p_club_id: clubIdDe(p),
          p_email: correo,
          p_inicio: p.startTime,
          p_fin: p.endTime,
          p_concepto: p?.title || 'Videollamada de soporte',
          p_meet_url: urlMeet(p),
        });
        if (error) throw error;
      }
    } else if (tipo === 'BOOKING_CANCELLED') {
      // Una reserva reagendada también se "cancela" en Cal.com: de eso se
      // encarga BOOKING_RESCHEDULED (si llegara primero esta cancelación,
      // fn_soporte_cita_reagendada la corrige a 'reagendada').
      if (p?.rescheduled === true || p?.rescheduledToUid) {
        return new Response(JSON.stringify({ recibido: true, omitido: 'reagendada' }), { status: 200 });
      }
      const { error } = await admin.rpc('fn_soporte_cita_cancelada', {
        p_uid: p.uid,
        p_cancelado_en: new Date().toISOString(),
      });
      if (error) throw error;
    }
    return new Response(JSON.stringify({ recibido: true }), { status: 200 });
  } catch (err) {
    console.error('[soporte-calcom-webhook]', tipo, err);
    return new Response('Error procesando el evento', { status: 500 });
  }
});
