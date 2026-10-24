// Pruebas de la lógica de billing (sin red): `deno test supabase/functions/_tests/`
import {
  cuponPermitido,
  ErrorNoReintentable,
  mapearEstadoStripe,
  origenesPermitidos,
  parsearCuponesPermitidos,
  tipoDeCheckout,
  trialEndParaConversion,
  urlDeRetornoValida,
  type SuscripcionLite,
} from '../_shared/billing_logica.ts';
import {
  procesarEvento,
  type EventoLite,
  type FilaSuscripcion,
  type PrecioCatalogo,
  type RepoBilling,
  type StripeMin,
} from '../billing-webhook/procesar.ts';

function igual(a: unknown, b: unknown, msg = '') {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n  esperado: ${jb}\n  obtenido: ${ja}`);
}
async function lanza(fn: () => Promise<unknown>, clase?: new (...a: never[]) => Error): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    if (clase && !(e instanceof clase)) throw new Error(`Se esperaba ${clase.name}, llegó ${(e as Error).name}: ${(e as Error).message}`);
    return e as Error;
  }
  throw new Error('Se esperaba un error');
}

// ---------------------------------------------------------------------------
// Dobles en memoria
// ---------------------------------------------------------------------------
type Fila = FilaSuscripcion & Record<string, unknown>;

function crearEntorno() {
  const filas = new Map<number, Fila>();
  const legado = new Map<number, Record<string, unknown>>();
  const facturas = new Map<string, Record<string, unknown>>();
  const compras = new Map<string, { id: string; session: string | null; monto: number; estado: string }>();
  const subs = new Map<string, SuscripcionLite>();
  const clientes = new Map<string, { id: string; metadata: Record<string, string> }>();
  const precios: PrecioCatalogo[] = [
    { clave: 'club_mensual', plan_clave: 'club', plan_nombre: 'Club', plan_canchas: '4-7', frecuencia: 'mensual', monto_mxn: 2499, stripe_price_id: 'price_club_m' },
    { clave: 'pro_anual', plan_clave: 'pro', plan_nombre: 'Pro', plan_canchas: '8-12', frecuencia: 'anual', monto_mxn: 31490, stripe_price_id: 'price_pro_a' },
  ];
  const fila = (clubId: number): Fila =>
    filas.get(clubId) ?? {
      club_id: clubId,
      estado_suscripcion: 'bloqueada',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      stripe_status: null,
      prueba_inicio: null,
    };

  const repo: RepoBilling = {
    registrarEvento: () => Promise.resolve('nuevo'),
    cerrarEvento: () => Promise.resolve(),
    suscripcionPorClub: (id) => Promise.resolve(filas.get(id) ?? null),
    suscripcionPorCustomer: (c) => Promise.resolve([...filas.values()].find((f) => f.stripe_customer_id === c) ?? null),
    suscripcionPorSubscription: (s) => Promise.resolve([...filas.values()].find((f) => f.stripe_subscription_id === s) ?? null),
    guardarSuscripcion: (clubId, cambios) => {
      filas.set(clubId, { ...fila(clubId), ...cambios } as Fila);
      return Promise.resolve();
    },
    precioPorStripeId: (p) => Promise.resolve(precios.find((x) => x.stripe_price_id === p) ?? null),
    actualizarPlanLegado: (clubId, plan) => {
      legado.set(clubId, { ...plan });
      return Promise.resolve();
    },
    guardarFactura: (f) => {
      facturas.set(String(f.stripe_invoice_id), f);
      return Promise.resolve();
    },
    vincularCompraSoporte: (compraId, sessionId) => {
      const c = compras.get(compraId);
      if (c && !c.session) c.session = sessionId;
      return Promise.resolve();
    },
    acreditarCompraSoporte: (a) => {
      const c = [...compras.values()].find((x) => x.session === a.sessionId);
      if (!c) return Promise.resolve({ ok: false, motivo: 'compra_no_encontrada' });
      if (c.estado === 'pagada') return Promise.resolve({ ok: true, motivo: 'ya_acreditada' });
      if (a.moneda !== 'mxn' || a.montoCentavos / 100 < c.monto) return Promise.resolve({ ok: false, motivo: 'monto_no_coincide' });
      c.estado = 'pagada';
      return Promise.resolve({ ok: true, motivo: 'acreditada' });
    },
    cancelarCompraSoporte: (sessionId) => {
      const c = [...compras.values()].find((x) => x.session === sessionId);
      if (c && c.estado === 'pendiente') c.estado = 'cancelada';
      return Promise.resolve();
    },
  };
  const stripe: StripeMin = {
    subscriptions: {
      retrieve: (id) => {
        const s = subs.get(id);
        return s ? Promise.resolve(structuredClone(s)) : Promise.reject(new Error(`No such subscription: ${id}`));
      },
    },
    customers: {
      retrieve: (id) => Promise.resolve(clientes.get(id) ?? { id, deleted: true, metadata: null }),
    },
  };
  return { filas, legado, facturas, compras, subs, clientes, deps: { stripe, repo } };
}

const T0 = Math.floor(Date.UTC(2026, 9, 24) / 1000);
const MES = 30 * 86400;
function sub(id: string, status: string, extra: Partial<SuscripcionLite> = {}): SuscripcionLite {
  return {
    id,
    status,
    customer: 'cus_10',
    cancel_at_period_end: false,
    current_period_start: T0,
    current_period_end: T0 + MES,
    metadata: { club_id: '10', type: 'suscripcion' },
    items: { data: [{ price: { id: 'price_club_m' } }] },
    ...extra,
  };
}
const ev = (id: string, type: string, object: Record<string, unknown>): EventoLite => ({ id, type, data: { object } });

// ---------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------
Deno.test('mapeo de estados Stripe → QLUBOS', () => {
  igual(mapearEstadoStripe('active')?.estado, 'activa');
  igual(mapearEstadoStripe('trialing')?.estado, 'prueba');
  igual(mapearEstadoStripe('past_due')?.estado, 'past_due');
  igual(mapearEstadoStripe('unpaid'), { estado: 'bloqueada', motivo_bloqueo: 'pago_fallido', vigente: false });
  igual(mapearEstadoStripe('canceled'), { estado: 'bloqueada', motivo_bloqueo: 'sin_suscripcion', vigente: false });
  igual(mapearEstadoStripe('incomplete'), null);
});

Deno.test('URLs de retorno: solo orígenes permitidos', () => {
  const o = origenesPermitidos('https://app.qlubos.com/', 'http://localhost:5173, https://staging.qlubos.com');
  igual(o, ['https://app.qlubos.com', 'http://localhost:5173', 'https://staging.qlubos.com']);
  igual(
    urlDeRetornoValida('https://app.qlubos.com/?billing=exito&session_id={CHECKOUT_SESSION_ID}', o),
    'https://app.qlubos.com/?billing=exito&session_id={CHECKOUT_SESSION_ID}'
  );
  igual(urlDeRetornoValida('https://evil.com/?x=1', o), null);
  igual(urlDeRetornoValida('javascript:alert(1)', o), null);
  igual(urlDeRetornoValida('http://app.qlubos.com/', o), null, 'http fuera de localhost');
  igual(urlDeRetornoValida('http://localhost:5173/cuenta', o), 'http://localhost:5173/cuenta');
});

Deno.test('cupones: lista blanca y frecuencia', () => {
  const l = parsearCuponesPermitidos('FUNDADOR15:mensual, ALIADO10');
  igual(cuponPermitido('FUNDADOR15', 'mensual', l), true);
  igual(cuponPermitido('FUNDADOR15', 'anual', l), false);
  igual(cuponPermitido('ALIADO10', 'anual', l), true);
  igual(cuponPermitido('GRATIS100', 'mensual', l), false);
  igual(cuponPermitido('FUNDADOR15', 'mensual', parsearCuponesPermitidos(undefined)), true, 'default');
});

Deno.test('conversión de prueba: trial_end solo con > 48 h', () => {
  const ahora = Date.UTC(2026, 9, 24);
  igual(trialEndParaConversion('prueba', new Date(ahora + 5 * 86400000).toISOString(), ahora), Math.floor((ahora + 5 * 86400000) / 1000));
  igual(trialEndParaConversion('prueba', new Date(ahora + 24 * 3600000).toISOString(), ahora), null);
  igual(trialEndParaConversion('activa', new Date(ahora + 5 * 86400000).toISOString(), ahora), null);
});

Deno.test('tipo de checkout (incluye metadata vieja de soporte)', () => {
  igual(tipoDeCheckout({ type: 'suscripcion' }), 'suscripcion');
  igual(tipoDeCheckout({ type: 'soporte' }), 'soporte');
  igual(tipoDeCheckout({ tipo: 'soporte_horas_extra' }), 'soporte');
  igual(tipoDeCheckout({}), null);
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
Deno.test('checkout.session.completed (suscripción) → activa + plan + legado', async () => {
  const e = crearEntorno();
  e.subs.set('sub_1', sub('sub_1', 'active'));
  const r = await procesarEvento(
    ev('evt_1', 'checkout.session.completed', {
      id: 'cs_1', mode: 'subscription', customer: 'cus_10', subscription: 'sub_1', client_reference_id: '10',
      metadata: { club_id: '10', type: 'suscripcion' },
    }),
    e.deps
  );
  igual(r.estado, 'procesado');
  const f = e.filas.get(10)!;
  igual([f.estado_suscripcion, f.stripe_customer_id, f.stripe_subscription_id, f.plan_clave, f.frecuencia, f.es_cortesia], ['activa', 'cus_10', 'sub_1', 'club', 'mensual', false]);
  igual(f.current_period_end, new Date((T0 + MES) * 1000).toISOString());
  igual(e.legado.get(10), { plan_canchas: '4-7', plan_nombre: 'Club · 4 – 7 Canchas', plan_precio_mensual: 2499 });
});

Deno.test('subscription.updated: cancelación programada y cambio a plan anual', async () => {
  const e = crearEntorno();
  e.subs.set('sub_1', sub('sub_1', 'active', { cancel_at_period_end: true, items: { data: [{ price: { id: 'price_pro_a' } }] } }));
  await procesarEvento(ev('evt_2', 'customer.subscription.updated', { id: 'sub_1' }), e.deps);
  const f = e.filas.get(10)!;
  igual([f.estado_suscripcion, f.cancel_at_period_end, f.plan_clave, f.frecuencia], ['activa', true, 'pro', 'anual']);
  igual(e.legado.get(10)?.plan_precio_mensual, Math.round(31490 / 12));
});

Deno.test('subscription.created en trialing (conversión de prueba) → prueba con prueba_fin', async () => {
  const e = crearEntorno();
  e.subs.set('sub_t', sub('sub_t', 'trialing', { trial_start: T0, trial_end: T0 + 10 * 86400 }));
  await procesarEvento(ev('evt_t', 'customer.subscription.created', { id: 'sub_t' }), e.deps);
  const f = e.filas.get(10)!;
  igual([f.estado_suscripcion, f.prueba_fin], ['prueba', new Date((T0 + 10 * 86400) * 1000).toISOString()]);
});

Deno.test('invoice.payment_failed de renovación → past_due + factura', async () => {
  const e = crearEntorno();
  e.subs.set('sub_1', sub('sub_1', 'past_due'));
  await procesarEvento(
    ev('evt_3', 'invoice.payment_failed', {
      id: 'in_1', customer: 'cus_10', subscription: 'sub_1', status: 'open', billing_reason: 'subscription_cycle',
      total: 249900, amount_paid: 0, amount_remaining: 249900, attempt_count: 1, subscription_details: { metadata: { club_id: '10' } },
    }),
    e.deps
  );
  igual(e.filas.get(10)!.estado_suscripcion, 'past_due');
  igual([e.facturas.get('in_1')?.estado, e.facturas.get('in_1')?.total_mxn], ['open', 2499]);
});

Deno.test('invoice.payment_failed con Stripe aún en active → se fuerza past_due', async () => {
  const e = crearEntorno();
  e.subs.set('sub_1', sub('sub_1', 'active'));
  await procesarEvento(
    ev('evt_4', 'invoice.payment_failed', { id: 'in_2', customer: 'cus_10', subscription: 'sub_1', status: 'open', billing_reason: 'subscription_cycle' }),
    e.deps
  );
  igual(e.filas.get(10)!.estado_suscripcion, 'past_due');
});

Deno.test('primer cobro fallido (incomplete) → NO activa ni pasa a past_due', async () => {
  const e = crearEntorno();
  e.subs.set('sub_i', sub('sub_i', 'incomplete'));
  await procesarEvento(
    ev('evt_5', 'invoice.payment_failed', { id: 'in_3', customer: 'cus_10', subscription: 'sub_i', status: 'open', billing_reason: 'subscription_create' }),
    e.deps
  );
  const f = e.filas.get(10)!;
  igual([f.estado_suscripcion, f.stripe_subscription_id, f.stripe_status], ['bloqueada', 'sub_i', 'incomplete']);
});

Deno.test('subscription.deleted → bloqueada / sin_suscripcion', async () => {
  const e = crearEntorno();
  e.subs.set('sub_1', sub('sub_1', 'canceled', { canceled_at: T0 + 5 }));
  await procesarEvento(ev('evt_6', 'customer.subscription.deleted', { id: 'sub_1' }), e.deps);
  const f = e.filas.get(10)!;
  igual([f.estado_suscripcion, f.motivo_bloqueo, f.stripe_status], ['bloqueada', 'sin_suscripcion', 'canceled']);
  igual(f.cancelada_en, new Date((T0 + 5) * 1000).toISOString());
});

Deno.test('evento de una suscripción anterior no pisa la vigente', async () => {
  const e = crearEntorno();
  e.filas.set(10, { club_id: 10, estado_suscripcion: 'activa', stripe_customer_id: 'cus_10', stripe_subscription_id: 'sub_nueva', stripe_status: 'active', prueba_inicio: null });
  e.subs.set('sub_vieja', sub('sub_vieja', 'canceled'));
  const r = await procesarEvento(ev('evt_7', 'customer.subscription.deleted', { id: 'sub_vieja' }), e.deps);
  igual(r.estado, 'ignorado');
  igual(e.filas.get(10)!.estado_suscripcion, 'activa');
});

Deno.test('club resuelto por metadata del Customer cuando la suscripción no la trae', async () => {
  const e = crearEntorno();
  e.clientes.set('cus_20', { id: 'cus_20', metadata: { club_id: '20' } });
  e.subs.set('sub_20', sub('sub_20', 'active', { customer: 'cus_20', metadata: {} }));
  await procesarEvento(ev('evt_8', 'customer.subscription.updated', { id: 'sub_20' }), e.deps);
  igual(e.filas.get(20)?.estado_suscripcion, 'activa');
});

Deno.test('sin club identificable → ErrorNoReintentable', async () => {
  const e = crearEntorno();
  e.subs.set('sub_x', sub('sub_x', 'active', { customer: 'cus_x', metadata: {} }));
  await lanza(() => procesarEvento(ev('evt_9', 'customer.subscription.updated', { id: 'sub_x' }), e.deps), ErrorNoReintentable);
});

Deno.test('soporte: acredita con monto correcto (metadata vieja y nueva)', async () => {
  const e = crearEntorno();
  e.compras.set('c1', { id: 'c1', session: null, monto: 700, estado: 'pendiente' });
  const r = await procesarEvento(
    ev('evt_s1', 'checkout.session.completed', {
      id: 'cs_s1', mode: 'payment', payment_status: 'paid', amount_total: 70000, currency: 'mxn',
      metadata: { tipo: 'soporte_horas_extra', compra_id: 'c1', club_id: '10' },
    }),
    e.deps
  );
  igual([r.estado, r.nota, e.compras.get('c1')!.estado, e.compras.get('c1')!.session], ['procesado', 'acreditada', 'pagada', 'cs_s1']);
  const r2 = await procesarEvento(
    ev('evt_s2', 'checkout.session.completed', { id: 'cs_s1', payment_status: 'paid', amount_total: 70000, currency: 'mxn', metadata: { type: 'soporte', compra_id: 'c1' } }),
    e.deps
  );
  igual(r2.nota, 'ya_acreditada');
});

Deno.test('soporte: monto que no coincide → ErrorNoReintentable; compra inexistente → reintento', async () => {
  const e = crearEntorno();
  e.compras.set('c2', { id: 'c2', session: 'cs_s3', monto: 1050, estado: 'pendiente' });
  await lanza(
    () => procesarEvento(ev('evt_s3', 'checkout.session.completed', { id: 'cs_s3', payment_status: 'paid', amount_total: 35000, currency: 'mxn', metadata: { type: 'soporte' } }), e.deps),
    ErrorNoReintentable
  );
  const err = await lanza(() =>
    procesarEvento(ev('evt_s4', 'checkout.session.completed', { id: 'cs_zz', payment_status: 'paid', amount_total: 35000, currency: 'mxn', metadata: { type: 'soporte' } }), e.deps)
  );
  igual(err instanceof ErrorNoReintentable, false);
});

Deno.test('soporte: checkout expirado → compra cancelada', async () => {
  const e = crearEntorno();
  e.compras.set('c3', { id: 'c3', session: 'cs_s5', monto: 350, estado: 'pendiente' });
  await procesarEvento(ev('evt_s5', 'checkout.session.expired', { id: 'cs_s5', metadata: { type: 'soporte' } }), e.deps);
  igual(e.compras.get('c3')!.estado, 'cancelada');
});

Deno.test('eventos no manejados se ignoran', async () => {
  const e = crearEntorno();
  igual((await procesarEvento(ev('evt_x', 'charge.refunded', { id: 'ch_1' }), e.deps)).estado, 'ignorado');
});
