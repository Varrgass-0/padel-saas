// =============================================================================
// Edge Function: portal-stripe-webhook — endpoint de Stripe CONNECT para los
// cobros en línea del Portal (eventos que ocurren en las cuentas de los clubes).
//
// Stripe → Developers → Webhooks → "Add endpoint" → "Listen to events on
// Connected accounts":
//   URL: https://<proyecto>.supabase.co/functions/v1/portal-stripe-webhook
//   Eventos: checkout.session.completed, checkout.session.expired,
//            checkout.session.async_payment_succeeded,
//            checkout.session.async_payment_failed
//   Versión de API: 2023-10-16 (igual que STRIPE_API_VERSION)
// Secret: STRIPE_CONNECT_WEBHOOK_SECRET (whsec_… de ESE endpoint).
// Deploy: supabase functions deploy portal-stripe-webhook --no-verify-jwt
//
// Seguridad: firma verificada; la reserva solo se marca pagada si la sesión,
// la cuenta conectada (`event.account`) y el monto coinciden con lo que
// guardó portal-checkout (ver fn_portal_confirmar_pago_reserva, v121).
// Idempotencia: tabla `stripe_eventos` (dominio 'portal').
// Respuestas: 400 firma inválida · 200 procesado/ignorado/duplicado/dato
// inconsistente · 500 error transitorio (Stripe reintenta).
// =============================================================================
import { corsHeaders, crearAdmin, crearStripe, proveedorCripto } from '../_shared/billing.ts';
import { unixAIso } from '../_shared/billing_logica.ts';
import { procesarEventoPortal, type EventoConnectLite } from './procesar.ts';

// Encabezados CORS estándar (ver _shared/billing.ts), exportados también aquí.
export { corsHeaders };

let _clientes: { stripe: ReturnType<typeof crearStripe>; admin: ReturnType<typeof crearAdmin> } | null = null;
function clientes() {
  if (!_clientes) _clientes = { stripe: crearStripe(), admin: crearAdmin() };
  return _clientes;
}

function texto(cuerpo: unknown, status: number): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  try {
    return await atender(req);
  } catch (err) {
    console.error('[portal-stripe-webhook] Error inesperado', (err as Error)?.message || err);
    return texto({ error: 'Error interno del webhook' }, 500);
  }
});

async function atender(req: Request): Promise<Response> {
  if (req.method !== 'POST') return texto({ error: 'Método no permitido' }, 405);
  const secreto = Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET');
  if (!secreto) {
    console.error('[portal-stripe-webhook] Falta STRIPE_CONNECT_WEBHOOK_SECRET.');
    return texto({ error: 'Webhook sin configurar' }, 500);
  }
  const { stripe, admin } = clientes();

  const firma = req.headers.get('stripe-signature') ?? '';
  const cuerpo = await req.text();
  let evento: EventoConnectLite;
  try {
    evento = (await stripe.webhooks.constructEventAsync(cuerpo, firma, secreto, undefined, proveedorCripto)) as unknown as EventoConnectLite;
  } catch (err) {
    console.error('[portal-stripe-webhook] Firma inválida', (err as Error)?.message);
    return texto({ error: 'Firma inválida' }, 400);
  }

  // Idempotencia.
  const { data: previo, error: errPrevio } = await admin.from('stripe_eventos').select('estado, intentos').eq('event_id', evento.id).maybeSingle();
  if (errPrevio) throw errPrevio;
  if (previo && (previo.estado === 'procesado' || previo.estado === 'ignorado')) return texto({ recibido: true, duplicado: true }, 200);
  const objeto = evento.data?.object ?? {};
  if (previo) {
    await admin.from('stripe_eventos').update({ intentos: (Number(previo.intentos) || 1) + 1, estado: 'recibido' }).eq('event_id', evento.id);
  } else {
    const { error: errIns } = await admin.from('stripe_eventos').insert({
      event_id: evento.id,
      tipo: evento.type,
      livemode: Boolean(evento.livemode),
      creado_stripe: unixAIso(evento.created ?? null),
      objeto_id: typeof objeto.id === 'string' ? objeto.id : null,
      dominio: 'portal',
      payload: evento,
    });
    if (errIns && errIns.code !== '23505') throw errIns;
  }

  const r = await procesarEventoPortal(evento, {
    confirmar: (args) => admin.rpc('fn_portal_confirmar_pago_reserva', args),
    expirar: (args) => admin.rpc('fn_portal_expirar_reserva_en_linea', args),
  });

  const clubNum = r.club_id && /^\d+$/.test(r.club_id) ? Number(r.club_id) : null;
  await admin
    .from('stripe_eventos')
    .update({
      estado: r.estado,
      error: r.estado === 'error' ? String(r.nota ?? '').slice(0, 1000) : null,
      club_id: clubNum,
      objeto_id: r.objeto_id ?? null,
      procesado_en: new Date().toISOString(),
    })
    .eq('event_id', evento.id);

  console.log(`[portal-stripe-webhook] ${evento.type} ${evento.id} (${evento.account ?? 'plataforma'}): ${r.estado}${r.nota ? ` — ${r.nota}` : ''}`);
  if (r.reintentar) return texto({ error: 'Error procesando el evento' }, 500);
  return texto({ recibido: true, estado: r.estado }, 200);
}
