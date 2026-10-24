// =============================================================================
// billing-webhook · procesamiento de eventos (sin dependencias remotas).
// `index.ts` le inyecta el cliente real de Stripe y el repositorio de Supabase;
// las pruebas le inyectan dobles en memoria.
//
// Regla clave: ante cualquier evento de suscripción se LEE la suscripción
// fresca desde Stripe (`subscriptions.retrieve`) y se sincroniza ese estado.
// Así el orden en que lleguen los webhooks no importa.
// =============================================================================
import {
  centavosAPesos,
  clubIdValido,
  ErrorNoReintentable,
  idDe,
  mapearEstadoStripe,
  nombrePlanLegado,
  periodoDeSuscripcion,
  precioMensualLegado,
  priceIdDeSuscripcion,
  STATUS_STRIPE_VIGENTES,
  type SuscripcionLite,
  tipoDeCheckout,
  unixAIso,
} from '../_shared/billing_logica.ts';

// ---------------------------------------------------------------------------
// Tipos mínimos (subconjunto de Stripe que usamos)
// ---------------------------------------------------------------------------
export interface EventoLite {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  api_version?: string | null;
  // deno-lint-ignore no-explicit-any
  data: { object: Record<string, any> };
}

export interface StripeMin {
  subscriptions: { retrieve(id: string): Promise<SuscripcionLite> };
  customers: { retrieve(id: string): Promise<{ id: string; deleted?: boolean | null; metadata?: Record<string, string> | null }> };
}

export interface FilaSuscripcion {
  club_id: number;
  estado_suscripcion: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  prueba_inicio: string | null;
}

export interface PrecioCatalogo {
  clave: string;
  plan_clave: string | null;
  plan_nombre: string | null;
  plan_canchas: string | null;
  frecuencia: string | null;
  monto_mxn: number | null;
  stripe_price_id: string | null;
}

export type ResultadoRegistro = 'nuevo' | 'reintentar' | 'duplicado';

export interface RepoBilling {
  registrarEvento(e: {
    event_id: string;
    tipo: string;
    livemode: boolean;
    api_version: string | null;
    creado_stripe: string | null;
    objeto_id: string | null;
    payload: unknown;
  }): Promise<ResultadoRegistro>;
  cerrarEvento(
    eventId: string,
    estado: 'procesado' | 'ignorado' | 'error',
    extra: { club_id?: number | null; dominio?: string | null; objeto_id?: string | null; error?: string | null }
  ): Promise<void>;
  suscripcionPorClub(clubId: number): Promise<FilaSuscripcion | null>;
  suscripcionPorCustomer(customerId: string): Promise<FilaSuscripcion | null>;
  suscripcionPorSubscription(subscriptionId: string): Promise<FilaSuscripcion | null>;
  guardarSuscripcion(clubId: number, cambios: Record<string, unknown>): Promise<void>;
  precioPorStripeId(priceId: string): Promise<PrecioCatalogo | null>;
  actualizarPlanLegado(
    clubId: number,
    plan: { plan_canchas: string | null; plan_nombre: string | null; plan_precio_mensual: number | null }
  ): Promise<void>;
  guardarFactura(fila: Record<string, unknown>): Promise<void>;
  vincularCompraSoporte(compraId: string, sessionId: string): Promise<void>;
  acreditarCompraSoporte(a: {
    sessionId: string;
    paymentIntent: string | null;
    montoCentavos: number;
    moneda: string;
    customerId: string | null;
    eventoId: string;
  }): Promise<{ ok: boolean; motivo: string }>;
  cancelarCompraSoporte(sessionId: string): Promise<void>;
}

export interface Deps {
  stripe: StripeMin;
  repo: RepoBilling;
}

export interface ResultadoProceso {
  estado: 'procesado' | 'ignorado';
  dominio: 'suscripcion' | 'soporte' | 'otro';
  club_id?: number | null;
  objeto_id?: string | null;
  nota?: string;
}

const VIGENTES = new Set<string>(STATUS_STRIPE_VIGENTES);

// ---------------------------------------------------------------------------
// Resolución del club
// ---------------------------------------------------------------------------
async function resolverClubId(
  deps: Deps,
  opciones: { forzado?: number | null; metadata?: Record<string, string> | null; subscriptionId?: string | null; customerId?: string | null }
): Promise<number | null> {
  const directo = clubIdValido(opciones.forzado) ?? clubIdValido(opciones.metadata?.club_id);
  if (directo) return directo;
  if (opciones.subscriptionId) {
    const fila = await deps.repo.suscripcionPorSubscription(opciones.subscriptionId);
    if (fila) return fila.club_id;
  }
  if (opciones.customerId) {
    const fila = await deps.repo.suscripcionPorCustomer(opciones.customerId);
    if (fila) return fila.club_id;
    // billing-checkout crea el Customer con metadata.club_id.
    const cliente = await deps.stripe.customers.retrieve(opciones.customerId);
    if (cliente && !cliente.deleted) {
      const desdeCliente = clubIdValido(cliente.metadata?.club_id);
      if (desdeCliente) return desdeCliente;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sincronización de una suscripción (fuente: Stripe)
// ---------------------------------------------------------------------------
export async function sincronizarSuscripcion(
  deps: Deps,
  subscriptionId: string,
  opciones: { eventoId: string; clubIdForzado?: number | null; forzarFin?: boolean }
): Promise<ResultadoProceso> {
  const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idDe(sub.customer);
  const clubId = await resolverClubId(deps, {
    forzado: opciones.clubIdForzado,
    metadata: sub.metadata,
    subscriptionId: sub.id,
    customerId,
  });
  if (!clubId) throw new ErrorNoReintentable(`No se pudo identificar el club de la suscripción ${sub.id}.`);

  const actual = await deps.repo.suscripcionPorClub(clubId);
  const ahora = new Date().toISOString();
  const comun = {
    stripe_customer_id: customerId ?? actual?.stripe_customer_id ?? null,
    ultimo_evento_stripe_id: opciones.eventoId,
    ultimo_evento_en: ahora,
  };

  // `subscription.deleted` o status canceled: fin de la suscripción.
  const mapeo = mapearEstadoStripe(opciones.forzarFin ? 'canceled' : sub.status);

  // ¿El club ya tiene OTRA suscripción vigente? Entonces los eventos de la
  // suscripción anterior no deben pisarla (ej. cancelación tardía de la vieja).
  const otraVigente =
    !!actual?.stripe_subscription_id &&
    actual.stripe_subscription_id !== sub.id &&
    VIGENTES.has(actual.stripe_status ?? '') &&
    ['activa', 'prueba', 'past_due'].includes(actual.estado_suscripcion);

  if (!mapeo) {
    // `incomplete`: primer cobro en proceso → NO se activa ni se bloquea.
    // Solo se dejan vinculados los IDs si no hay otra suscripción vigente.
    if (!otraVigente) {
      await deps.repo.guardarSuscripcion(clubId, {
        ...comun,
        stripe_subscription_id: sub.id,
        stripe_status: sub.status,
        stripe_price_id: priceIdDeSuscripcion(sub),
      });
    }
    return { estado: 'procesado', dominio: 'suscripcion', club_id: clubId, objeto_id: sub.id, nota: `status ${sub.status}: sin cambio de acceso` };
  }

  if (otraVigente && !mapeo.vigente) {
    return { estado: 'ignorado', dominio: 'suscripcion', club_id: clubId, objeto_id: sub.id, nota: 'evento de una suscripción anterior' };
  }

  const priceId = priceIdDeSuscripcion(sub);
  const plan = priceId ? await deps.repo.precioPorStripeId(priceId) : null;
  const periodo = periodoDeSuscripcion(sub);

  const cambios: Record<string, unknown> = {
    ...comun,
    estado_suscripcion: mapeo.estado,
    motivo_bloqueo: mapeo.motivo_bloqueo,
    origen: 'stripe',
    es_cortesia: false,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    stripe_status: opciones.forzarFin ? 'canceled' : sub.status,
    current_period_start: periodo.inicio,
    current_period_end: periodo.fin,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    cancelada_en: unixAIso(sub.canceled_at),
  };
  if (plan) {
    cambios.plan_clave = plan.plan_clave;
    cambios.plan_canchas = plan.plan_canchas;
    cambios.frecuencia = plan.frecuencia;
  }
  if (mapeo.estado === 'prueba') {
    // Prueba de Stripe (conversión desde un código QLUBOS): conserva su fin.
    cambios.prueba_fin = unixAIso(sub.trial_end);
    if (!actual?.prueba_inicio) cambios.prueba_inicio = unixAIso(sub.trial_start) ?? ahora;
  }

  await deps.repo.guardarSuscripcion(clubId, cambios);

  if (plan && mapeo.vigente) {
    await deps.repo.actualizarPlanLegado(clubId, {
      plan_canchas: plan.plan_canchas,
      plan_nombre: nombrePlanLegado(plan.plan_nombre, plan.plan_canchas),
      plan_precio_mensual: precioMensualLegado(plan.monto_mxn, plan.frecuencia),
    });
  }

  return {
    estado: 'procesado',
    dominio: 'suscripcion',
    club_id: clubId,
    objeto_id: sub.id,
    nota: `${sub.status} → ${mapeo.estado}${mapeo.motivo_bloqueo ? ` (${mapeo.motivo_bloqueo})` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Facturas (invoice.*)
// ---------------------------------------------------------------------------
const ESTADOS_FACTURA = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);

// deno-lint-ignore no-explicit-any
export function filaFactura(invoice: Record<string, any>, clubId: number): Record<string, unknown> {
  const descuentos = Array.isArray(invoice.total_discount_amounts)
    ? invoice.total_discount_amounts.reduce((acc: number, d: { amount?: number }) => acc + (Number(d?.amount) || 0), 0)
    : 0;
  const linea = invoice.lines?.data?.[0];
  return {
    stripe_invoice_id: invoice.id,
    club_id: clubId,
    stripe_customer_id: idDe(invoice.customer),
    stripe_subscription_id: idDe(invoice.subscription),
    numero: invoice.number ?? null,
    estado: ESTADOS_FACTURA.has(invoice.status) ? invoice.status : 'open',
    motivo_factura: invoice.billing_reason ?? null,
    moneda: invoice.currency ?? 'mxn',
    subtotal_mxn: centavosAPesos(invoice.subtotal),
    descuento_mxn: centavosAPesos(descuentos),
    total_mxn: centavosAPesos(invoice.total),
    pagado_mxn: centavosAPesos(invoice.amount_paid),
    pendiente_mxn: centavosAPesos(invoice.amount_remaining),
    periodo_inicio: unixAIso(linea?.period?.start ?? invoice.period_start),
    periodo_fin: unixAIso(linea?.period?.end ?? invoice.period_end),
    intentos_cobro: invoice.attempt_count ?? null,
    proximo_intento: unixAIso(invoice.next_payment_attempt),
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    invoice_pdf: invoice.invoice_pdf ?? null,
    creada_stripe: unixAIso(invoice.created),
    pagada_en: unixAIso(invoice.status_transitions?.paid_at),
    actualizado_en: new Date().toISOString(),
  };
}

async function procesarFactura(deps: Deps, evento: EventoLite): Promise<ResultadoProceso> {
  const invoice = evento.data.object;
  const subscriptionId = idDe(invoice.subscription);
  if (!subscriptionId) {
    // Facturas sin suscripción (no las genera QLUBOS hoy) no son del SaaS.
    return { estado: 'ignorado', dominio: 'otro', objeto_id: invoice.id, nota: 'factura sin suscripción' };
  }
  let clubId = await resolverClubId(deps, {
    metadata: invoice.subscription_details?.metadata ?? null,
    subscriptionId,
    customerId: idDe(invoice.customer),
  });
  if (!clubId) {
    // Respaldo: la metadata de la propia suscripción (la pone billing-checkout).
    const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
    clubId = clubIdValido(sub.metadata?.club_id);
  }
  if (!clubId) throw new ErrorNoReintentable(`No se pudo identificar el club de la factura ${invoice.id}.`);

  await deps.repo.guardarFactura(filaFactura(invoice, clubId));

  // El estado de la suscripción siempre se toma fresco de Stripe.
  const r = await sincronizarSuscripcion(deps, subscriptionId, { eventoId: evento.id, clubIdForzado: clubId });

  if (evento.type === 'invoice.payment_failed') {
    // Respaldo: un cobro de RENOVACIÓN fallido deja al club en past_due (7 días
    // de gracia, los calcula la BD) aunque Stripe todavía reporte 'active'.
    // El primer cobro (subscription_create) no aplica: ese club nunca activó.
    const sub = await deps.repo.suscripcionPorClub(clubId);
    const esRenovacion = invoice.billing_reason !== 'subscription_create';
    if (esRenovacion && sub?.stripe_subscription_id === subscriptionId && sub.estado_suscripcion === 'activa') {
      await deps.repo.guardarSuscripcion(clubId, { estado_suscripcion: 'past_due', ultimo_evento_stripe_id: evento.id, ultimo_evento_en: new Date().toISOString() });
      return { ...r, nota: `${r.nota ?? ''} · pago fallido → past_due` };
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Checkout (suscripción y horas de soporte)
// ---------------------------------------------------------------------------
async function procesarCheckoutCompletado(deps: Deps, evento: EventoLite): Promise<ResultadoProceso> {
  const sesion = evento.data.object;
  const tipo = tipoDeCheckout(sesion.metadata);

  if (tipo === 'suscripcion') {
    if (sesion.mode !== 'subscription') {
      return { estado: 'ignorado', dominio: 'suscripcion', objeto_id: sesion.id, nota: 'checkout de suscripción sin mode=subscription' };
    }
    const clubId = clubIdValido(sesion.metadata?.club_id) ?? clubIdValido(sesion.client_reference_id);
    if (!clubId) throw new ErrorNoReintentable(`Checkout ${sesion.id} sin club_id.`);
    const customerId = idDe(sesion.customer);
    const subscriptionId = idDe(sesion.subscription);
    if (customerId) await deps.repo.guardarSuscripcion(clubId, { stripe_customer_id: customerId });
    if (!subscriptionId) throw new Error(`Checkout ${sesion.id} completado sin suscripción todavía.`);
    return sincronizarSuscripcion(deps, subscriptionId, { eventoId: evento.id, clubIdForzado: clubId });
  }

  if (tipo === 'soporte') {
    if (sesion.payment_status !== 'paid') {
      return { estado: 'ignorado', dominio: 'soporte', objeto_id: sesion.id, nota: `payment_status ${sesion.payment_status}` };
    }
    const compraId = sesion.metadata?.compra_id;
    // soporte-stripe-checkout guarda el session_id DESPUÉS de crear la sesión:
    // si el webhook llega antes, se vincula aquí por compra_id.
    if (compraId) await deps.repo.vincularCompraSoporte(String(compraId), sesion.id);
    const r = await deps.repo.acreditarCompraSoporte({
      sessionId: sesion.id,
      paymentIntent: idDe(sesion.payment_intent),
      montoCentavos: Number(sesion.amount_total) || 0,
      moneda: String(sesion.currency || ''),
      customerId: idDe(sesion.customer),
      eventoId: evento.id,
    });
    const clubId = clubIdValido(sesion.metadata?.club_id);
    if (!r.ok && r.motivo === 'compra_no_encontrada') {
      throw new Error(`Compra de soporte de la sesión ${sesion.id} no encontrada todavía.`); // reintento
    }
    if (!r.ok) {
      throw new ErrorNoReintentable(`Compra de soporte ${sesion.id}: ${r.motivo}.`);
    }
    return { estado: 'procesado', dominio: 'soporte', club_id: clubId, objeto_id: sesion.id, nota: r.motivo };
  }

  return { estado: 'ignorado', dominio: 'otro', objeto_id: sesion.id, nota: 'checkout sin metadata de QLUBOS' };
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------
export async function procesarEvento(evento: EventoLite, deps: Deps): Promise<ResultadoProceso> {
  const objeto = evento.data?.object ?? {};
  switch (evento.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return procesarCheckoutCompletado(deps, evento);

    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      if (tipoDeCheckout(objeto.metadata) === 'soporte') {
        await deps.repo.cancelarCompraSoporte(objeto.id);
        return { estado: 'procesado', dominio: 'soporte', club_id: clubIdValido(objeto.metadata?.club_id), objeto_id: objeto.id, nota: 'compra cancelada' };
      }
      return { estado: 'ignorado', dominio: 'suscripcion', objeto_id: objeto.id, nota: 'checkout de suscripción no completado' };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return sincronizarSuscripcion(deps, objeto.id, { eventoId: evento.id });

    case 'customer.subscription.deleted':
      // Fin de la suscripción → 'bloqueada' / 'sin_suscripcion'.
      return sincronizarSuscripcion(deps, objeto.id, { eventoId: evento.id, forzarFin: true });

    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
    case 'invoice.finalized':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      return procesarFactura(deps, evento);

    default:
      return { estado: 'ignorado', dominio: 'otro', objeto_id: objeto.id ?? null, nota: `evento ${evento.type} no manejado` };
  }
}

/** Dominio aproximado de un evento (para `stripe_eventos.dominio`). */
export function dominioDeEvento(evento: EventoLite): 'suscripcion' | 'soporte' | 'otro' {
  if (evento.type.startsWith('customer.subscription.') || evento.type.startsWith('invoice.')) return 'suscripcion';
  if (evento.type.startsWith('checkout.session.')) {
    const tipo = tipoDeCheckout(evento.data?.object?.metadata);
    return tipo ?? 'otro';
  }
  return 'otro';
}
