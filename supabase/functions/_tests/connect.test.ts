// Pruebas de la lógica de Stripe Connect (sin red):
//   deno test supabase/functions/_tests/
import {
  cuentaPerteneceAlClub,
  esCuentaRevocada,
  estadoDeCuenta,
  requiereEnlaceOnboarding,
  slugDelClub,
  urlConParametros,
} from '../stripe-connect-onboarding/logica.ts';

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
