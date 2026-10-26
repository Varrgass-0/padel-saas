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
// CORS (autocontenido en este archivo, no depende de _shared): TODAS las
// respuestas — preflight OPTIONS, éxito y errores 400/401/403/405/409/500 —
// salen con Access-Control-Allow-Origin '*', Allow-Headers y Allow-Methods.
// Así un error interno nunca se ve en Chrome DevTools como "CORS error".
// '*' es seguro aquí: no se usan cookies; la seguridad está en el JWT del
// dueño/staff (Authorization: Bearer …) y en la validación de return_url.
//
// Secrets: STRIPE_SECRET_KEY, APP_URL (y BILLING_ALLOWED_ORIGINS opcional).
// Deploy:  supabase functions deploy stripe-connect-onboarding --no-verify-jwt
//   (--no-verify-jwt: la función YA valida la sesión con usuarioDeLaPeticion;
//    así un JWT rechazado responde 401 desde AQUÍ, con CORS, en vez de un
//    rechazo del gateway de Supabase que el navegador reporta como CORS.)
// =============================================================================
import { appUrl, autorizarClub, crearAdmin, crearStripe, mensajeStripe, origenes, usuarioDeLaPeticion } from '../_shared/billing.ts';
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

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region, x-supabase-api-version, accept, prefer',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** Preflight: 200 'ok' + CORS. Acepta cualquier encabezado que pida el navegador. */
function respuestaPreflight(req: Request): Response {
  const pedidos = req.headers.get('Access-Control-Request-Headers');
  const headers = { ...corsHeaders };
  if (pedidos) headers['Access-Control-Allow-Headers'] = `${corsHeaders['Access-Control-Allow-Headers']}, ${pedidos}`;
  return new Response('ok', { status: 200, headers });
}

/** JSON con CORS (éxito o error). */
function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Garantiza CORS en cualquier respuesta (por si alguna rama futura no usa `json`). */
function conCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
  if (req.method === 'OPTIONS') return respuestaPreflight(req);
  try {
    return conCors(await atender(req));
  } catch (err) {
    // Último recurso: nada sale sin CORS.
    console.error('[stripe-connect-onboarding] Error no controlado', err);
    return json({ error: 'No se pudo conectar con Stripe. Intenta de nuevo.' }, 500);
  }
});

async function atender(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  try {
    const stripe = clienteStripe();
    const base = appUrl();
    if (!base) return json({ error: 'Falta APP_URL en los secrets de la función.' }, 500);

    const usuario = await usuarioDeLaPeticion(req);
    if (!usuario) return json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' }, 401);

    const cuerpo = await req.json().catch(() => ({}));
    const clubId = clubIdValido(cuerpo?.club_id);
    if (!clubId) return json({ error: 'club_id inválido.' }, 400);
    const accion = cuerpo?.accion === 'estado' ? 'estado' : 'onboarding';

    const admin = crearAdmin();
    const club = await autorizarClub(admin, usuario, clubId);
    if (!club) return json({ error: 'No tienes permiso para configurar los cobros de este club.' }, 403);

    const fila = club.fila as Record<string, unknown>;
    if (!('stripe_account_id' in fila)) {
      return json({ error: 'Falta correr la migración v120 (Stripe Connect) en Supabase.', codigo: 'sin_migracion' }, 500);
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
        if (accion === 'estado') return json({ ...ESTADO_SIN_CUENTA, revocada: true });
      }
      if (cuenta) {
        if (!cuentaPerteneceAlClub(cuenta, clubId)) {
          console.error(
            `[stripe-connect-onboarding] ALERTA: ${accountId} guardada en el club ${clubId} pertenece a club_id=${cuenta.metadata?.club_id ?? '∅'}.`
          );
          return json(
            { error: 'La cuenta de Stripe vinculada no corresponde a este club. Escríbenos a soporte QLUBOS.', codigo: 'cuenta_de_otro_club' },
            409
          );
        }
        estado = estadoDeCuenta(cuenta);
        await guardarEstado(admin, clubId, estado);
      }
    }

    if (accion === 'estado') return json(estado);

    // ---- Onboarding --------------------------------------------------------
    if (accountId && !requiereEnlaceOnboarding(estado)) {
      return json({ ...estado, url: null, ya_conectada: true });
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
          return json({ error: 'Esa cuenta de Stripe ya está vinculada a otro club.', codigo: 'cuenta_duplicada' }, 409);
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

    return json({ ...estado, url: enlace.url, ya_conectada: false });
  } catch (err) {
    console.error('[stripe-connect-onboarding]', err);
    return json({ error: mensajeStripe(err, 'No se pudo conectar con Stripe. Intenta de nuevo.') }, 500);
  }
}
