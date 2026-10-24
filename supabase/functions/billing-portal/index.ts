// =============================================================================
// Edge Function: billing-portal  — sesión del Stripe Customer Portal.
//
// POST (Authorization: Bearer <jwt del dueño o staff>)
//   { club_id, return_url? }
// → { url }
//
// El Portal (configurado en Stripe → Settings → Billing → Customer portal)
// permite actualizar la tarjeta, ver facturas, cambiar de plan y cancelar al
// final del periodo. Todos los cambios llegan a Supabase por billing-webhook.
// =============================================================================
import {
  appUrl,
  autorizarClub,
  crearAdmin,
  crearStripe,
  mensajeStripe,
  origenes,
  preflight,
  respuestaJson,
  usuarioDeLaPeticion,
} from '../_shared/billing.ts';
import { clubIdValido, urlDeRetornoValida } from '../_shared/billing_logica.ts';

const stripe = crearStripe();

Deno.serve(async (req) => {
  const corto = preflight(req);
  if (corto) return corto;

  try {
    const base = appUrl();
    if (!base) return respuestaJson(req, { error: 'Falta APP_URL en los secrets de la función.' }, 500);

    const usuario = await usuarioDeLaPeticion(req);
    if (!usuario) return respuestaJson(req, { error: 'Sesión inválida. Vuelve a iniciar sesión.' }, 401);

    const cuerpo = await req.json().catch(() => ({}));
    const clubId = clubIdValido(cuerpo?.club_id);
    if (!clubId) return respuestaJson(req, { error: 'club_id inválido.' }, 400);

    const returnUrl = cuerpo?.return_url != null ? urlDeRetornoValida(cuerpo.return_url, origenes()) : `${base}/?billing=portal`;
    if (!returnUrl) return respuestaJson(req, { error: 'return_url no permitida.' }, 400);

    const admin = crearAdmin();
    const club = await autorizarClub(admin, usuario, clubId);
    if (!club) return respuestaJson(req, { error: 'No tienes permiso para gestionar la suscripción de este club.' }, 403);

    const { data: suscripcion, error } = await admin
      .from('club_suscripciones')
      .select('stripe_customer_id')
      .eq('club_id', clubId)
      .maybeSingle();
    if (error) throw error;
    if (!suscripcion?.stripe_customer_id) {
      return respuestaJson(
        req,
        { error: 'Este club todavía no tiene una suscripción de pago. Elige un plan primero.', codigo: 'sin_cliente_stripe' },
        409
      );
    }

    const configuracion = Deno.env.get('STRIPE_PORTAL_CONFIGURATION_ID') || undefined;
    const sesion = await stripe.billingPortal.sessions.create({
      customer: suscripcion.stripe_customer_id,
      return_url: returnUrl,
      locale: 'es-419',
      ...(configuracion ? { configuration: configuracion } : {}),
    });

    return respuestaJson(req, { url: sesion.url });
  } catch (err) {
    console.error('[billing-portal]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo abrir la gestión de la suscripción.') }, 500);
  }
});
