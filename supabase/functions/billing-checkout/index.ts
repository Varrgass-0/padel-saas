// =============================================================================
// Edge Function: billing-checkout  — Stripe Checkout de la suscripción SaaS.
//
// POST (Authorization: Bearer <jwt del dueño o staff>)
//   { club_id, price_id, success_url?, cancel_url? }
// → { url, session_id, descuento_aplicado }
//
// Reglas:
//   • price_id debe existir ACTIVO en `billing_precios` (tipo 'suscripcion'):
//     el navegador no puede mandar un precio arbitrario.
//   • Descuento de bienvenida ("Precio Fundador") DINÁMICO: lo decide el
//     servidor leyendo `billing_parametros.cupon_bienvenida_activo` (ver
//     `resolverCuponBienvenida`). Valor vacío / sin fila → precio regular.
//     El `coupon_id` que mande el navegador se IGNORA.
//   • Si Stripe rechaza el descuento (cupón vencido, agotado, borrado, no
//     aplica al producto…), se reintenta el Checkout SIN descuento: la compra
//     nunca se bloquea por el cupón.
//   • Sin descuento, Checkout acepta códigos promocionales creados en Stripe.
//   • success_url / cancel_url solo de orígenes permitidos (APP_URL…).
//   • Reutiliza el Customer del club (`club_suscripciones.stripe_customer_id`)
//     o lo crea con el correo del club y lo guarda.
//   • No permite una segunda suscripción vigente (usar el Customer Portal).
//   • Club en prueba con > 48 h restantes: la suscripción arranca al terminar
//     la prueba (trial_end), sin perder días.
//   • Solo tarjeta (crédito/débito). La activación la hace billing-webhook.
//
// Activar / desactivar el Precio Fundador (SQL Editor):
//   INSERT INTO public.billing_parametros (clave, valor, descripcion)
//   VALUES ('cupon_bienvenida_activo', 'FUNDADOR15', 'Cupón de Stripe del Precio Fundador. Vacío = sin descuento.')
//   ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now();
//   -- Apagar: UPDATE public.billing_parametros SET valor = '' WHERE clave = 'cupon_bienvenida_activo';
// =============================================================================
import {
  appUrl,
  autorizarClub,
  corsHeaders,
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

// Encabezados CORS estándar (ver _shared/billing.ts), exportados también aquí.
export { corsHeaders };

// Cliente de Stripe perezoso: si falta un secret, la función igual arranca y
// el preflight (OPTIONS) responde con CORS; el error sale como JSON con CORS.
let _stripe: ReturnType<typeof crearStripe> | null = null;
function clienteStripe(): ReturnType<typeof crearStripe> {
  if (!_stripe) _stripe = crearStripe();
  return _stripe;
}
const VIGENTES = new Set<string>(STATUS_STRIPE_VIGENTES);

// Clave del parámetro con el cupón de bienvenida en `billing_parametros`.
const CLAVE_CUPON_BIENVENIDA = 'cupon_bienvenida_activo';

// Suscripciones que NO cuentan como "compra previa" para el cupón de
// bienvenida: un primer intento cuyo pago nunca se completó.
const STATUS_SIN_COMPRA = new Set<string>(['incomplete', 'incomplete_expired']);

function correoDelClub(fila: Record<string, unknown>): string | null {
  for (const k of ['correo', 'email', 'correo_contacto', 'email_contacto', 'correo_administrador']) {
    const v = fila[k];
    if (typeof v === 'string' && /.+@.+\..+/.test(v.trim())) return v.trim();
  }
  return null;
}

/**
 * Cupón de bienvenida a aplicar, o `null` (precio regular). Nunca lanza: si
 * la lectura falla o el cupón no sirve, simplemente no hay descuento.
 *   1. `billing_parametros.cupon_bienvenida_activo` con valor no vacío.
 *   2. Si ese cupón aparece en STRIPE_CUPONES_PERMITIDOS con frecuencia
 *      (default "FUNDADOR15:mensual"), solo aplica a esa frecuencia — así el
 *      Precio Fundador sigue siendo solo para planes mensuales, como lo
 *      muestra la app. Un cupón que no está en la lista aplica a todo.
 *   3. Primera compra: el Customer no debe haber tenido antes una suscripción
 *      pagada (evita cancelar y volver a contratar para repetir el descuento).
 *   4. Vigente en Stripe (`coupon.valid`: no vencido, no agotado, no borrado).
 */
async function resolverCuponBienvenida(opciones: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  stripe: ReturnType<typeof crearStripe>;
  frecuencia: string | null;
  suscripcionesPrevias: Array<{ status: string }>;
  clubId: number;
}): Promise<string | null> {
  const { admin, stripe, frecuencia, suscripcionesPrevias, clubId } = opciones;
  let cupon = '';
  try {
    const { data, error } = await admin.from('billing_parametros').select('valor').eq('clave', CLAVE_CUPON_BIENVENIDA).maybeSingle();
    if (error) throw error;
    cupon = typeof data?.valor === 'string' ? data.valor.trim() : '';
  } catch (err) {
    console.warn(`[billing-checkout] No se pudo leer ${CLAVE_CUPON_BIENVENIDA}; se cobra precio regular.`, (err as Error)?.message || err);
    return null;
  }
  if (!cupon) return null;

  const lista = parsearCuponesPermitidos(Deno.env.get('STRIPE_CUPONES_PERMITIDOS'));
  if (lista.has(cupon) && !cuponPermitido(cupon, frecuencia, lista)) {
    console.log(`[billing-checkout] Club ${clubId}: el cupón ${cupon} no aplica a la frecuencia "${frecuencia}".`);
    return null;
  }

  if (suscripcionesPrevias.some((s) => !STATUS_SIN_COMPRA.has(s.status))) {
    console.log(`[billing-checkout] Club ${clubId}: ya tuvo una suscripción; no aplica el cupón de bienvenida ${cupon}.`);
    return null;
  }

  try {
    const detalle = await stripe.coupons.retrieve(cupon);
    if (!detalle?.valid) {
      console.warn(`[billing-checkout] El cupón ${cupon} ya no está vigente en Stripe; se cobra precio regular.`);
      return null;
    }
  } catch (err) {
    console.warn(`[billing-checkout] El cupón ${cupon} no existe en Stripe; se cobra precio regular.`, mensajeStripe(err, ''));
    return null;
  }
  return cupon;
}

/** ¿Es un rechazo de la PETICIÓN (p. ej. el descuento), no de red/servidor? */
function esRechazoDeStripe(err: unknown): boolean {
  const tipo = (err as { type?: string })?.type ?? '';
  return tipo === 'StripeInvalidRequestError';
}

Deno.serve(async (req) => {
  // Preflight CORS: respuesta inmediata, antes de cualquier otra lógica.
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  const corto = preflight(req);
  if (corto) return corto;

  try {
    const stripe = clienteStripe();
    const base = appUrl();
    if (!base) return respuestaJson(req, { error: 'Falta APP_URL en los secrets de la función.' }, 500);

    const usuario = await usuarioDeLaPeticion(req);
    if (!usuario) return respuestaJson(req, { error: 'Sesión inválida. Vuelve a iniciar sesión.' }, 401);

    const cuerpo = await req.json().catch(() => ({}));
    const clubId = clubIdValido(cuerpo?.club_id);
    const priceId = typeof cuerpo?.price_id === 'string' ? cuerpo.price_id.trim() : '';
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

    // Descuento de bienvenida (Precio Fundador), decidido por el servidor.
    const cuponBienvenida = await resolverCuponBienvenida({
      admin,
      stripe,
      frecuencia: precio.frecuencia ?? null,
      suscripcionesPrevias: existentes.data as Array<{ status: string }>,
      clubId,
    });

    const metadata = {
      club_id: String(clubId),
      type: 'suscripcion',
      plan_clave: String(precio.plan_clave ?? ''),
      frecuencia: String(precio.frecuencia ?? ''),
    };
    const trialEnd = trialEndParaConversion(suscripcion.estado_suscripcion, suscripcion.prueba_fin);

    // Parámetros de la sesión. `discounts` y `allow_promotion_codes` son
    // excluyentes en Stripe: sin cupón se permite escribir códigos promo.
    const parametrosSesion = (cupon: string | null) => ({
      mode: 'subscription' as const,
      customer: customerId!,
      client_reference_id: String(clubId),
      line_items: [{ price: priceId, quantity: 1 }],
      payment_method_types: ['card' as const],
      locale: 'es-419' as const,
      ...(cupon ? { discounts: [{ coupon: cupon }] } : { allow_promotion_codes: true }),
      metadata,
      subscription_data: {
        metadata,
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    let descuentoAplicado: string | null = cuponBienvenida;
    let sesion;
    try {
      sesion = await stripe.checkout.sessions.create(parametrosSesion(cuponBienvenida));
    } catch (err) {
      // Solo se reintenta si había descuento y Stripe RECHAZÓ la petición
      // (cupón vencido/agotado/no aplicable…). Errores de red o de Stripe se
      // propagan tal cual al catch general.
      if (!cuponBienvenida || !esRechazoDeStripe(err)) throw err;
      console.warn(
        `[billing-checkout] Club ${clubId}: Stripe rechazó el cupón ${cuponBienvenida}; se reintenta sin descuento.`,
        mensajeStripe(err, '')
      );
      descuentoAplicado = null;
      sesion = await stripe.checkout.sessions.create(parametrosSesion(null));
    }

    return respuestaJson(req, { url: sesion.url, session_id: sesion.id, descuento_aplicado: descuentoAplicado });
  } catch (err) {
    console.error('[billing-checkout]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago. Intenta de nuevo.') }, 500);
  }
});
