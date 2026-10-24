// =============================================================================
// Edge Function: billing-checkout  — Stripe Checkout de la suscripción SaaS.
//
// POST (Authorization: Bearer <jwt del dueño o staff>)
//   { club_id, price_id, coupon_id?, success_url?, cancel_url? }
// → { url, session_id }
//
// Reglas:
//   • price_id debe existir ACTIVO en `billing_precios` (tipo 'suscripcion'):
//     el navegador no puede mandar un precio arbitrario.
//   • coupon_id solo si está en STRIPE_CUPONES_PERMITIDOS (y para su
//     frecuencia, ej. FUNDADOR15 solo mensual) y es válido en Stripe. Sin
//     coupon_id, Checkout acepta códigos promocionales creados en Stripe.
//   • success_url / cancel_url solo de orígenes permitidos (APP_URL…).
//   • Reutiliza el Customer del club (`club_suscripciones.stripe_customer_id`)
//     o lo crea con el correo del club y lo guarda.
//   • No permite una segunda suscripción vigente (usar el Customer Portal).
//   • Club en prueba con > 48 h restantes: la suscripción arranca al terminar
//     la prueba (trial_end), sin perder días.
//   • Solo tarjeta (crédito/débito). La activación la hace billing-webhook.
// =============================================================================
import {
  appUrl,
  autorizarClub,
  crearAdmin,
  crearStripe,
  filaSuscripcion,
  mensajeStripe,
  origenes,
  preflight,
  respuestaJson,
  usuarioDeLaPeticion,
} from '../_shared/billing.ts';
import {
  clubIdValido,
  cuponPermitido,
  parsearCuponesPermitidos,
  STATUS_STRIPE_VIGENTES,
  trialEndParaConversion,
  urlDeRetornoValida,
} from '../_shared/billing_logica.ts';

const stripe = crearStripe();
const VIGENTES = new Set<string>(STATUS_STRIPE_VIGENTES);

function correoDelClub(fila: Record<string, unknown>): string | null {
  for (const k of ['correo', 'email', 'correo_contacto', 'email_contacto', 'correo_administrador']) {
    const v = fila[k];
    if (typeof v === 'string' && /.+@.+\..+/.test(v.trim())) return v.trim();
  }
  return null;
}

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
    const priceId = typeof cuerpo?.price_id === 'string' ? cuerpo.price_id.trim() : '';
    const couponId = typeof cuerpo?.coupon_id === 'string' && cuerpo.coupon_id.trim() ? cuerpo.coupon_id.trim() : null;
    if (!clubId) return respuestaJson(req, { error: 'club_id inválido.' }, 400);
    if (!priceId) return respuestaJson(req, { error: 'price_id requerido.' }, 400);

    // URLs de regreso: solo orígenes permitidos (evita redirecciones abiertas).
    const permitidos = origenes();
    const successUrl =
      cuerpo?.success_url != null
        ? urlDeRetornoValida(cuerpo.success_url, permitidos)
        : `${base}/?billing=exito&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = cuerpo?.cancel_url != null ? urlDeRetornoValida(cuerpo.cancel_url, permitidos) : `${base}/?billing=cancelado`;
    if (!successUrl || !cancelUrl) return respuestaJson(req, { error: 'success_url / cancel_url no permitidas.' }, 400);

    const admin = crearAdmin();
    const club = await autorizarClub(admin, usuario, clubId);
    if (!club) return respuestaJson(req, { error: 'No tienes permiso para gestionar la suscripción de este club.' }, 403);

    // Precio del catálogo (no se confía en el navegador).
    const { data: precio, error: errPrecio } = await admin
      .from('billing_precios')
      .select('clave, plan_clave, plan_nombre, plan_canchas, frecuencia, monto_mxn, stripe_price_id')
      .eq('stripe_price_id', priceId)
      .eq('tipo', 'suscripcion')
      .eq('activo', true)
      .maybeSingle();
    if (errPrecio) throw errPrecio;
    if (!precio) return respuestaJson(req, { error: 'Ese plan no está disponible.' }, 400);

    // Cupón (lista blanca + vigente en Stripe).
    if (couponId) {
      const lista = parsearCuponesPermitidos(Deno.env.get('STRIPE_CUPONES_PERMITIDOS'));
      if (!cuponPermitido(couponId, precio.frecuencia, lista)) {
        return respuestaJson(req, { error: 'Ese cupón no aplica para este plan.' }, 400);
      }
      try {
        const cupon = await stripe.coupons.retrieve(couponId);
        if (!cupon?.valid) return respuestaJson(req, { error: 'Ese cupón ya no está vigente.' }, 400);
      } catch (err) {
        return respuestaJson(req, { error: mensajeStripe(err, 'Ese cupón no existe.') }, 400);
      }
    }

    const suscripcion = await filaSuscripcion(admin, clubId);
    if (suscripcion.stripe_subscription_id && VIGENTES.has(suscripcion.stripe_status ?? '')) {
      return respuestaJson(
        req,
        { error: 'Este club ya tiene una suscripción. Usa "Gestionar suscripción" para cambiar de plan.', codigo: 'suscripcion_existente' },
        409
      );
    }

    // Customer: reutilizar o crear (idempotente por club).
    let customerId: string | null = suscripcion.stripe_customer_id ?? null;
    if (!customerId) {
      let correo = correoDelClub(club.fila);
      if (!correo && club.propietario_user_id) {
        const { data: duenio } = await admin.auth.admin.getUserById(club.propietario_user_id);
        correo = duenio?.user?.email ?? null;
      }
      correo = correo ?? usuario.email;
      const cliente = await stripe.customers.create(
        {
          email: correo ?? undefined,
          name: club.nombre ?? undefined,
          metadata: { club_id: String(clubId) },
          preferred_locales: ['es-419'],
        },
        { idempotencyKey: `qlubos-customer-club-${clubId}` }
      );
      // Solo se guarda si nadie lo guardó antes (dos pestañas a la vez).
      const { error: errGuardar } = await admin
        .from('club_suscripciones')
        .update({ stripe_customer_id: cliente.id })
        .eq('club_id', clubId)
        .is('stripe_customer_id', null);
      if (errGuardar) throw errGuardar;
      const { data: releida } = await admin.from('club_suscripciones').select('stripe_customer_id').eq('club_id', clubId).single();
      customerId = releida?.stripe_customer_id ?? cliente.id;
    }

    // Doble candado en Stripe: ¿ya hay una suscripción viva que el webhook
    // todavía no sincronizó? Y se expiran Checkouts abiertos anteriores para
    // que no terminen en dos suscripciones.
    const existentes = await stripe.subscriptions.list({ customer: customerId!, status: 'all', limit: 20 });
    if (existentes.data.some((s: { status: string }) => VIGENTES.has(s.status))) {
      return respuestaJson(
        req,
        { error: 'Este club ya tiene una suscripción en Stripe. Usa "Gestionar suscripción".', codigo: 'suscripcion_existente' },
        409
      );
    }
    const abiertas = await stripe.checkout.sessions.list({ customer: customerId!, status: 'open', limit: 10 });
    for (const s of abiertas.data) {
      if (s.mode === 'subscription') {
        try {
          await stripe.checkout.sessions.expire(s.id);
        } catch (_e) {
          /* ya expirada o completada */
        }
      }
    }

    const metadata = {
      club_id: String(clubId),
      type: 'suscripcion',
      plan_clave: String(precio.plan_clave ?? ''),
      frecuencia: String(precio.frecuencia ?? ''),
    };
    const trialEnd = trialEndParaConversion(suscripcion.estado_suscripcion, suscripcion.prueba_fin);

    const sesion = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId!,
      client_reference_id: String(clubId),
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card'],
      locale: 'es-419',
      ...(couponId ? { discounts: [{ coupon: couponId }] } : { allow_promotion_codes: true }),
      metadata,
      subscription_data: {
        metadata,
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return respuestaJson(req, { url: sesion.url, session_id: sesion.id });
  } catch (err) {
    console.error('[billing-checkout]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago. Intenta de nuevo.') }, 500);
  }
});
