// =============================================================================
// Edge Function: stripe-connect-onboarding — Stripe Connect (Standard) por club.
//
// POST (Authorization: Bearer <jwt del dueño del club o staff QLUBOS>)
//   { club_id, return_url?, accion?: 'onboarding' | 'estado' }
//
//   accion 'onboarding' (default):
//     • Si el club no tiene `stripe_account_id`, crea una cuenta Standard
//       (metadata: club_id, slug) y la guarda en `configuracion_club`.
//     • Devuelve el Account Link de onboarding:
//         { url, stripe_account_id, estado }
//       Si la cuenta ya está completa y cobrando: { url: null, ya_conectada: true, … }
//     • Regreso: return_url (validada) + ?stripe_connect=retorno&club=<slug>
//       Link vencido: return_url + ?stripe_connect=refrescar&club=<slug>
//
//   accion 'estado': lee la cuenta en Stripe y sincroniza
//     `stripe_onboarding_completed` / `stripe_connect_enabled`. Si el club
//     desconectó la cuenta desde Stripe, se desvincula en QLUBOS.
//
// Relación ESTRICTA club ↔ cuenta:
//   • Solo el dueño del club (o staff) puede operar ese club_id.
//   • `stripe_account_id` es UNIQUE y solo lo escribe esta función.
//   • Antes de usar una cuenta guardada se verifica que su metadata.club_id
//     sea este club; si no coincide, se rechaza (nunca se cruzan cobros).
//
// Secrets: STRIPE_SECRET_KEY, APP_URL (y BILLING_ALLOWED_ORIGINS opcional).
// Deploy:  supabase functions deploy stripe-connect-onboarding
// =============================================================================
import {
  appUrl,
  autorizarClub,
  corsHeaders,
  crearAdmin,
  crearStripe,
  mensajeStripe,
  origenes,
  preflight,
  respuestaJson,
  usuarioDeLaPeticion,
} from '../_shared/billing.ts';
import { clubIdValido, urlDeRetornoValida } from '../_shared/billing_logica.ts';
import {
  correoDelClub,
  cuentaPerteneceAlClub,
  esCuentaRevocada,
  ESTADO_SIN_CUENTA,
  estadoDeCuenta,
  requiereEnlaceOnboarding,
  slugDelClub,
  urlConParametros,
  type CuentaConectadaLite,
  type EstadoConnect,
} from './logica.ts';

// Encabezados CORS estándar (ver _shared/billing.ts), exportados también aquí.
export { corsHeaders };

let _stripe: ReturnType<typeof crearStripe> | null = null;
function clienteStripe(): ReturnType<typeof crearStripe> {
  if (!_stripe) _stripe = crearStripe();
  return _stripe;
}

// deno-lint-ignore no-explicit-any
type Admin = any;

/** Guarda en `configuracion_club` el estado que reporta Stripe (service_role). */
async function guardarEstado(admin: Admin, clubId: number, estado: EstadoConnect): Promise<void> {
  const { error } = await admin
    .from('configuracion_club')
    .update({
      stripe_connect_enabled: estado.cobros_habilitados,
      stripe_onboarding_completed: estado.onboarding_completado,
    })
    .eq('id', clubId)
    .eq('stripe_account_id', estado.stripe_account_id);
  if (error) throw error;
}

/** El club desconectó la cuenta desde Stripe: se desvincula en QLUBOS. */
async function desvincular(admin: Admin, clubId: number, accountId: string): Promise<void> {
  const { error } = await admin
    .from('configuracion_club')
    .update({ stripe_account_id: null, stripe_connect_enabled: false, stripe_onboarding_completed: false })
    .eq('id', clubId)
    .eq('stripe_account_id', accountId);
  if (error) throw error;
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
    if (!clubId) return respuestaJson(req, { error: 'club_id inválido.' }, 400);
    const accion = cuerpo?.accion === 'estado' ? 'estado' : 'onboarding';

    const admin = crearAdmin();
    const club = await autorizarClub(admin, usuario, clubId);
    if (!club) return respuestaJson(req, { error: 'No tienes permiso para configurar los cobros de este club.' }, 403);

    const fila = club.fila as Record<string, unknown>;
    if (!('stripe_account_id' in fila)) {
      return respuestaJson(req, { error: 'Falta correr la migración v120 (Stripe Connect) en Supabase.', codigo: 'sin_migracion' }, 500);
    }
    const slug = slugDelClub(fila);
    let accountId = typeof fila.stripe_account_id === 'string' && fila.stripe_account_id ? fila.stripe_account_id : null;

    // ---- Cuenta existente: verificar pertenencia y sincronizar estado -----
    let estado: EstadoConnect = ESTADO_SIN_CUENTA;
    if (accountId) {
      let cuenta: CuentaConectadaLite | null = null;
      try {
        cuenta = (await stripe.accounts.retrieve(accountId)) as unknown as CuentaConectadaLite;
      } catch (err) {
        if (!esCuentaRevocada(err)) throw err;
        console.warn(`[stripe-connect-onboarding] Club ${clubId}: sin acceso a ${accountId} (desconectada desde Stripe); se desvincula.`);
        await desvincular(admin, clubId, accountId);
        accountId = null;
        if (accion === 'estado') return respuestaJson(req, { ...ESTADO_SIN_CUENTA, revocada: true });
      }
      if (cuenta) {
        if (!cuentaPerteneceAlClub(cuenta, clubId)) {
          console.error(
            `[stripe-connect-onboarding] ALERTA: ${accountId} guardada en el club ${clubId} pertenece a club_id=${cuenta.metadata?.club_id ?? '∅'}.`
          );
          return respuestaJson(
            req,
            { error: 'La cuenta de Stripe vinculada no corresponde a este club. Escríbenos a soporte QLUBOS.', codigo: 'cuenta_de_otro_club' },
            409
          );
        }
        estado = estadoDeCuenta(cuenta);
        await guardarEstado(admin, clubId, estado);
      }
    }

    if (accion === 'estado') return respuestaJson(req, estado);

    // ---- Onboarding --------------------------------------------------------
    if (accountId && !requiereEnlaceOnboarding(estado)) {
      return respuestaJson(req, { ...estado, url: null, ya_conectada: true });
    }

    // URL de regreso: solo orígenes permitidos; si no sirve, la de APP_URL.
    let retornoBase = `${base}/`;
    if (cuerpo?.return_url != null) {
      const valida = urlDeRetornoValida(cuerpo.return_url, origenes());
      if (valida) retornoBase = valida;
      else console.warn(`[stripe-connect-onboarding] return_url no permitida (${String(cuerpo.return_url).slice(0, 120)}); se usa APP_URL.`);
    }

    if (!accountId) {
      const cuentaNueva = await stripe.accounts.create(
        {
          type: 'standard',
          country: 'MX',
          email: correoDelClub(fila) ?? usuario.email ?? undefined,
          business_profile: { name: club.nombre ?? undefined },
          metadata: { club_id: String(clubId), slug, plataforma: 'qlubos' },
        },
        { idempotencyKey: `qlubos-connect-club-${clubId}` }
      );
      // Solo se guarda si el club sigue sin cuenta (dos pestañas a la vez).
      const { error: errGuardar } = await admin
        .from('configuracion_club')
        .update({ stripe_account_id: cuentaNueva.id, stripe_connect_enabled: false, stripe_onboarding_completed: false })
        .eq('id', clubId)
        .is('stripe_account_id', null);
      if (errGuardar) {
        if (errGuardar.code === '23505') {
          console.error(`[stripe-connect-onboarding] ${cuentaNueva.id} ya está ligada a otro club (UNIQUE).`);
          return respuestaJson(req, { error: 'Esa cuenta de Stripe ya está vinculada a otro club.', codigo: 'cuenta_duplicada' }, 409);
        }
        throw errGuardar;
      }
      const { data: releida, error: errLeer } = await admin.from('configuracion_club').select('stripe_account_id').eq('id', clubId).single();
      if (errLeer) throw errLeer;
      accountId = releida?.stripe_account_id ?? cuentaNueva.id;
      if (accountId !== cuentaNueva.id) {
        console.warn(`[stripe-connect-onboarding] Club ${clubId}: otra petición guardó ${accountId}; ${cuentaNueva.id} queda sin usar.`);
      }
      estado = { ...ESTADO_SIN_CUENTA, conectada: true, stripe_account_id: accountId };
    }

    const enlace = await stripe.accountLinks.create({
      account: accountId!,
      type: 'account_onboarding',
      return_url: urlConParametros(retornoBase, { stripe_connect: 'retorno', club: slug }),
      refresh_url: urlConParametros(retornoBase, { stripe_connect: 'refrescar', club: slug }),
    });

    return respuestaJson(req, { ...estado, url: enlace.url, ya_conectada: false });
  } catch (err) {
    console.error('[stripe-connect-onboarding]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo conectar con Stripe. Intenta de nuevo.') }, 500);
  }
});
