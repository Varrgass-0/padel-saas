// Pruebas de la lógica de Stripe Connect (sin red):
//   deno test supabase/functions/_tests/
import {
  cuentaPerteneceAlClub,
  cuerpoAccountLinkV2,
  cuerpoCuentaV2,
  esAccountsV2Bloqueado,
  esCuentaSoloV1,
  estadoDeCuentaV2,
  esCuentaRevocada,
  estadoDeCuenta,
  requiereEnlaceOnboarding,
  slugDelClub,
  urlConParametros,
} from '../stripe-connect-onboarding/logica.ts';
import { crearClienteStripeV2, ErrorStripeV2 } from '../stripe-connect-onboarding/stripe_v2.ts';

function igual(a: unknown, b: unknown, msg = '') {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n  esperado: ${jb}\n  obtenido: ${ja}`);
}

Deno.test('connect: estado de una cuenta recién creada (sin onboarding)', () => {
  const e = estadoDeCuenta({
    id: 'acct_1',
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    requirements: { currently_due: ['business_type', 'external_account'], past_due: ['external_account'], disabled_reason: 'requirements.past_due' },
  });
  igual([e.conectada, e.onboarding_completado, e.cobros_habilitados, e.requisitos_pendientes, e.motivo_deshabilitada], [
    true,
    false,
    false,
    2,
    'requirements.past_due',
  ]);
  igual(requiereEnlaceOnboarding(e), true);
});

Deno.test('connect: cuenta completa y cobrando no requiere enlace', () => {
  const e = estadoDeCuenta({ id: 'acct_2', details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [] } });
  igual([e.onboarding_completado, e.cobros_habilitados, e.pagos_habilitados, e.requisitos_pendientes], [true, true, true, 0]);
  igual(requiereEnlaceOnboarding(e), false);
});

Deno.test('connect: datos enviados pero Stripe aún no habilita cobros → requiere enlace', () => {
  const e = estadoDeCuenta({ id: 'acct_3', details_submitted: true, charges_enabled: false });
  igual(requiereEnlaceOnboarding(e), true);
});

Deno.test('connect: relación estricta club ↔ cuenta por metadata', () => {
  igual(cuentaPerteneceAlClub({ id: 'acct_1', metadata: { club_id: '10' } }, 10), true);
  igual(cuentaPerteneceAlClub({ id: 'acct_1', metadata: { club_id: '11' } }, 10), false);
  igual(cuentaPerteneceAlClub({ id: 'acct_1', metadata: {} }, 10), false);
  igual(cuentaPerteneceAlClub({ id: 'acct_1' }, 10), false);
});

Deno.test('connect: detección de cuenta desconectada desde Stripe', () => {
  igual(esCuentaRevocada({ type: 'StripePermissionError', message: 'x' }), true);
  igual(esCuentaRevocada({ type: 'StripeInvalidRequestError', code: 'account_invalid' }), true);
  igual(esCuentaRevocada({ type: 'StripeInvalidRequestError', message: "No such account: 'acct_9'" }), true);
  igual(esCuentaRevocada({ type: 'StripeConnectionError', message: 'socket hang up' }), false);
  igual(esCuentaRevocada({ type: 'StripeAPIError', message: 'No such account' }), false);
  igual(esCuentaRevocada(null), false);
});

Deno.test('connect: slug del club (columna o derivado del nombre)', () => {
  igual(slugDelClub({ id: 1, slug: 'Padel-Norte', nombre: 'X' }), 'padel-norte');
  igual(slugDelClub({ id: 1, slug: null, nombre: 'Pádel Club Ñandú 2' }), 'padel-club-nandu-2');
  igual(slugDelClub({ id: 7, slug: '', nombre: '' }), 'club-7');
});

Deno.test('connect: URL de regreso conserva la base y agrega club/estado', () => {
  igual(
    urlConParametros('https://qlub-os-mx.vercel.app/', { stripe_connect: 'retorno', club: 'padel-norte' }),
    'https://qlub-os-mx.vercel.app/?stripe_connect=retorno&club=padel-norte'
  );
  igual(
    urlConParametros('https://qlub-os-mx.vercel.app/?x=1&stripe_connect=viejo', { stripe_connect: 'refrescar', club: 'a' }),
    'https://qlub-os-mx.vercel.app/?x=1&stripe_connect=refrescar&club=a'
  );
});

// =============================================================================
// Accounts v2
// =============================================================================
Deno.test('connect v2: cuerpo de creación (merchant, dashboard full, MX, Stripe cobra comisiones y riesgo)', () => {
  const b = cuerpoCuentaV2({ clubId: 10, slug: 'padel-norte', nombre: 'Pádel Norte', correo: 'a@b.mx' }) as Record<string, unknown>;
  igual(b.dashboard, 'full');
  igual(b.identity, { country: 'mx' });
  igual(b.configuration, { merchant: { capabilities: { card_payments: { requested: true } } } });
  igual(b.defaults, { currency: 'mxn', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } });
  igual(b.metadata, { club_id: '10', slug: 'padel-norte', plataforma: 'qlubos' });
  igual([b.contact_email, b.display_name], ['a@b.mx', 'Pádel Norte']);
  const sinDatos = cuerpoCuentaV2({ clubId: 1, slug: 's', nombre: null, correo: null }) as Record<string, unknown>;
  igual(['contact_email' in sinDatos, 'display_name' in sinDatos], [false, false]);
});

Deno.test('connect v2: Account Link de onboarding para la configuración merchant', () => {
  igual(cuerpoAccountLinkV2('acct_1', 'https://x/r', 'https://x/f'), {
    account: 'acct_1',
    use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: 'https://x/r', refresh_url: 'https://x/f' } },
  });
});

Deno.test('connect v2: estado desde capacidades y requisitos', () => {
  const nueva = estadoDeCuentaV2({
    id: 'acct_1',
    configuration: { merchant: { capabilities: { card_payments: { status: 'restricted', status_details: [{ code: 'requirements_past_due' }] } } } },
    requirements: {
      entries: [
        { awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' } },
        { awaiting_action_from: 'user', minimum_deadline: { status: 'past_due' } },
        { awaiting_action_from: 'user', minimum_deadline: { status: 'eventually_due' } },
        { awaiting_action_from: 'stripe', minimum_deadline: { status: 'currently_due' } },
      ],
    },
  });
  igual([nueva.conectada, nueva.onboarding_completado, nueva.cobros_habilitados, nueva.requisitos_pendientes, nueva.motivo_deshabilitada], [
    true,
    false,
    false,
    2,
    'requirements_past_due',
  ]);
  igual(requiereEnlaceOnboarding(nueva), true);
  const activa = estadoDeCuentaV2({
    id: 'acct_2',
    configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, stripe_balance: { payouts: { status: 'active' } } } } },
    requirements: { entries: [] },
  });
  igual([activa.onboarding_completado, activa.cobros_habilitados, activa.pagos_habilitados, activa.motivo_deshabilitada], [true, true, true, null]);
  igual(requiereEnlaceOnboarding(activa), false);
  const cerrada = estadoDeCuentaV2({ id: 'acct_3', closed: true, configuration: { merchant: { capabilities: { card_payments: { status: 'active' } } } } });
  igual([cerrada.conectada, cerrada.cobros_habilitados], [false, false]);
});

Deno.test('connect v2: clasificación de errores (v1 heredada, v2 bloqueado, cuenta inexistente)', () => {
  igual(esCuentaSoloV1(new ErrorStripeV2(400, { code: 'v1_account_instead_of_v2_account' }, 'x')), true);
  igual(esCuentaSoloV1(new ErrorStripeV2(400, { code: 'account_not_yet_compatible_with_v2' }, 'x')), true);
  igual(esAccountsV2Bloqueado(new ErrorStripeV2(400, { code: 'accounts_v2_access_blocked' }, 'x')), true);
  igual(esCuentaRevocada(new ErrorStripeV2(404, { code: 'not_found' }, 'x')), true);
  igual(esCuentaRevocada(new ErrorStripeV2(403, { code: 'x' }, 'x')), true);
  igual(esCuentaRevocada(new ErrorStripeV2(null, null, 'red')), false);
  igual(esCuentaRevocada(new ErrorStripeV2(500, { code: 'x' }, 'x')), false);
});

Deno.test('connect v2: cliente REST (versión, idempotencia, include, errores con forma del SDK)', async () => {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const fetchFalso = ((url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    if (url.includes('/v2/core/accounts/acct_mal')) {
      return Promise.resolve(new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'not_found', message: 'Not found' } }), { status: 404 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ id: 'acct_1' }), { status: 200 }));
  }) as unknown as typeof fetch;
  const cli = crearClienteStripeV2('sk_test_1', '2025-12-15.clover', fetchFalso);
  igual(await cli.crearCuenta({ a: 1 }, { idempotencyKey: 'k1' }), { id: 'acct_1' });
  const h = new Headers(llamadas[0].init.headers);
  igual([llamadas[0].url, llamadas[0].init.method, h.get('Stripe-Version'), h.get('Idempotency-Key'), h.get('Authorization'), llamadas[0].init.body], [
    'https://api.stripe.com/v2/core/accounts',
    'POST',
    '2025-12-15.clover',
    'k1',
    'Bearer sk_test_1',
    '{"a":1}',
  ]);
  await cli.leerCuenta('acct_1', ['configuration.merchant', 'requirements']);
  igual(decodeURIComponent(llamadas[1].url), 'https://api.stripe.com/v2/core/accounts/acct_1?include[0]=configuration.merchant&include[1]=requirements');
  let error: ErrorStripeV2 | null = null;
  try {
    await cli.leerCuenta('acct_mal', []);
  } catch (e) {
    error = e as ErrorStripeV2;
  }
  igual([error?.type, error?.code, error?.statusCode, error?.raw.message], ['StripeInvalidRequestError', 'not_found', 404, 'Not found']);
});
