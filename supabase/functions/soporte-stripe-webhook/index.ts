// Edge Function: soporte-stripe-webhook
// Recibe los eventos de Stripe y, cuando un pago de horas extra queda
// confirmado, acredita los minutos a la bolsa del club (fn_soporte_acreditar_compra,
// idempotente: si Stripe reenvía el evento no se duplica nada).
//
// Desplegar SIN verificación de JWT (Stripe no manda uno):
//   supabase functions deploy soporte-stripe-webhook --no-verify-jwt
// En Stripe → Developers → Webhooks → endpoint:
//   https://<proyecto>.supabase.co/functions/v1/soporte-stripe-webhook
//   eventos: checkout.session.completed, checkout.session.async_payment_succeeded,
//            checkout.session.expired
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_...).
import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Método no permitido', { status: 405 });

  const firma = req.headers.get('Stripe-Signature');
  const cuerpo = await req.text();
  let evento: Stripe.Event;
  try {
    evento = await stripe.webhooks.constructEventAsync(
      cuerpo,
      firma ?? '',
      Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
      undefined,
      cryptoProvider
    );
  } catch (err) {
    console.error('[soporte-stripe-webhook] Firma inválida', err);
    return new Response('Firma inválida', { status: 400 });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const sesion = evento.data.object as Stripe.Checkout.Session;
    // Solo nos interesan las compras de horas extra de soporte.
    if (sesion?.metadata?.tipo !== 'soporte_horas_extra') {
      return new Response(JSON.stringify({ ignorado: true }), { status: 200 });
    }

    if (
      (evento.type === 'checkout.session.completed' && sesion.payment_status === 'paid') ||
      evento.type === 'checkout.session.async_payment_succeeded'
    ) {
      const paymentIntent = typeof sesion.payment_intent === 'string' ? sesion.payment_intent : sesion.payment_intent?.id ?? null;
      const { error } = await admin.rpc('fn_soporte_acreditar_compra', {
        p_stripe_session_id: sesion.id,
        p_payment_intent: paymentIntent,
      });
      if (error) throw error;
    } else if (evento.type === 'checkout.session.expired' || evento.type === 'checkout.session.async_payment_failed') {
      await admin.from('soporte_compras_extra').update({ estado: 'cancelada' }).eq('stripe_session_id', sesion.id).eq('estado', 'pendiente');
    }
    return new Response(JSON.stringify({ recibido: true }), { status: 200 });
  } catch (err) {
    console.error('[soporte-stripe-webhook]', err);
    // 500 → Stripe reintenta automáticamente.
    return new Response('Error procesando el evento', { status: 500 });
  }
});
