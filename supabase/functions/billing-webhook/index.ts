// =============================================================================
// Edge Function: billing-webhook  (endpoint ÚNICO de Stripe para QLUBOS)
//   • Suscripciones SaaS: checkout.session.completed (type 'suscripcion'),
//     customer.subscription.created/updated/deleted, invoice.*.
//   • Horas extra de soporte: checkout.session.completed (type 'soporte' o la
//     metadata vieja tipo 'soporte_horas_extra') → acredita verificando monto.
//
// Desplegar SIN verificación de JWT (Stripe no manda uno):
//   supabase functions deploy billing-webhook --no-verify-jwt
// Stripe → Developers → Webhooks → endpoint:
//   https://<proyecto>.supabase.co/functions/v1/billing-webhook
//   (misma versión de API que STRIPE_API_VERSION en _shared/billing.ts)
//
// Respuestas: 400 firma inválida · 200 procesado/ignorado/duplicado ·
// 500 error transitorio (Stripe reintenta con backoff hasta 3 días).
// Idempotencia: tabla `stripe_eventos` (v113).
// =============================================================================
import { crearAdmin, crearStripe, proveedorCripto } from '../_shared/billing.ts';
import { ErrorNoReintentable, unixAIso } from '../_shared/billing_logica.ts';
import { dominioDeEvento, procesarEvento, type EventoLite, type StripeMin } from './procesar.ts';
import { crearRepoSupabase } from './repo_supabase.ts';

const stripe = crearStripe();
const admin = crearAdmin();
const repo = crearRepoSupabase(admin);

function texto(cuerpo: unknown, status: number): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return texto({ error: 'Método no permitido' }, 405);

  const secreto = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secreto) {
    console.error('[billing-webhook] Falta STRIPE_WEBHOOK_SECRET.');
    return texto({ error: 'Webhook sin configurar' }, 500);
  }

  // 1) Firma (sobre el cuerpo CRUDO, sin parsear).
  const firma = req.headers.get('stripe-signature') ?? '';
  const cuerpo = await req.text();
  let evento: EventoLite;
  try {
    evento = (await stripe.webhooks.constructEventAsync(cuerpo, firma, secreto, undefined, proveedorCripto)) as unknown as EventoLite;
  } catch (err) {
    console.error('[billing-webhook] Firma inválida', (err as Error)?.message);
    return texto({ error: 'Firma inválida' }, 400);
  }

  // 2) Idempotencia.
  let registro;
  try {
    registro = await repo.registrarEvento({
      event_id: evento.id,
      tipo: evento.type,
      livemode: Boolean(evento.livemode),
      api_version: evento.api_version ?? null,
      creado_stripe: unixAIso(evento.created),
      objeto_id: (evento.data?.object?.id as string) ?? null,
      payload: evento,
    });
  } catch (err) {
    console.error('[billing-webhook] No se pudo registrar el evento', evento.id, err);
    return texto({ error: 'No se pudo registrar el evento' }, 500);
  }
  if (registro === 'duplicado') return texto({ recibido: true, duplicado: true }, 200);

  // 3) Procesamiento.
  try {
    const r = await procesarEvento(evento, { stripe: stripe as unknown as StripeMin, repo });
    await repo.cerrarEvento(evento.id, r.estado, { club_id: r.club_id ?? null, dominio: r.dominio, objeto_id: r.objeto_id ?? null, error: null });
    console.log(`[billing-webhook] ${evento.type} ${evento.id}: ${r.estado}${r.nota ? ` — ${r.nota}` : ''}`);
    return texto({ recibido: true, estado: r.estado }, 200);
  } catch (err) {
    const mensaje = (err as Error)?.message || String(err);
    await repo.cerrarEvento(evento.id, 'error', { dominio: dominioDeEvento(evento), error: mensaje.slice(0, 1000) });
    if (err instanceof ErrorNoReintentable) {
      // Dato inconsistente que un reintento no arregla: queda en stripe_eventos
      // con estado 'error' para revisión del staff.
      console.error(`[billing-webhook] ${evento.type} ${evento.id} (sin reintento): ${mensaje}`);
      return texto({ recibido: true, estado: 'error' }, 200);
    }
    console.error(`[billing-webhook] ${evento.type} ${evento.id} (se reintentará): ${mensaje}`);
    return texto({ error: 'Error procesando el evento' }, 500);
  }
});
