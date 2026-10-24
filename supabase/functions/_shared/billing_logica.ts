// =============================================================================
// QLUBOS · Billing — lógica pura (sin red ni dependencias remotas).
// La usan billing-checkout, billing-portal y billing-webhook, y se prueba con
// `deno test` sin Stripe ni Supabase.
// =============================================================================

export type EstadoQlubos = 'prueba' | 'activa' | 'past_due' | 'bloqueada' | 'cancelada';
export type MotivoBloqueo = 'sin_suscripcion' | 'prueba_vencida' | 'pago_fallido' | 'manual';

export interface EstadoMapeado {
  estado: EstadoQlubos;
  motivo_bloqueo: MotivoBloqueo | null;
  /** La suscripción da acceso (activa / prueba / past_due con gracia). */
  vigente: boolean;
}

/** Estados de Stripe en los que la suscripción sigue "viva" (no se debe duplicar). */
export const STATUS_STRIPE_VIGENTES = ['active', 'trialing', 'past_due', 'unpaid'] as const;

/**
 * Estado de Stripe → estado QLUBOS (`club_suscripciones.estado_suscripcion`).
 *   active             → activa
 *   trialing           → prueba (prueba_fin = trial_end)
 *   past_due           → past_due (la BD calcula 7 días de gracia)
 *   unpaid             → bloqueada / pago_fallido
 *   canceled           → bloqueada / sin_suscripcion (misma salida que subscription.deleted)
 *   incomplete_expired → bloqueada / sin_suscripcion (nunca pagó el primer cargo)
 *   paused             → bloqueada / sin_suscripcion
 *   incomplete         → null: primer pago en proceso, NO se activa ni se bloquea.
 */
export function mapearEstadoStripe(status: string | null | undefined): EstadoMapeado | null {
  switch (status) {
    case 'active':
      return { estado: 'activa', motivo_bloqueo: null, vigente: true };
    case 'trialing':
      return { estado: 'prueba', motivo_bloqueo: null, vigente: true };
    case 'past_due':
      return { estado: 'past_due', motivo_bloqueo: null, vigente: true };
    case 'unpaid':
      return { estado: 'bloqueada', motivo_bloqueo: 'pago_fallido', vigente: false };
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return { estado: 'bloqueada', motivo_bloqueo: 'sin_suscripcion', vigente: false };
    case 'incomplete':
      return null;
    default:
      return null;
  }
}

/** Segundos Unix (Stripe) → ISO, o null. */
export function unixAIso(segundos: number | null | undefined): string | null {
  if (segundos == null || !Number.isFinite(Number(segundos)) || Number(segundos) <= 0) return null;
  return new Date(Number(segundos) * 1000).toISOString();
}

/** Centavos (Stripe) → pesos con 2 decimales, o null. */
export function centavosAPesos(c: number | null | undefined): number | null {
  if (c == null || !Number.isFinite(Number(c))) return null;
  return Math.round(Number(c)) / 100;
}

interface ItemConPeriodo {
  current_period_start?: number | null;
  current_period_end?: number | null;
  price?: { id?: string | null } | null;
}
export interface SuscripcionLite {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  cancel_at_period_end?: boolean | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  canceled_at?: number | null;
  metadata?: Record<string, string> | null;
  items?: { data?: ItemConPeriodo[] } | null;
}

export function idDe(valor: string | { id: string } | null | undefined): string | null {
  if (!valor) return null;
  return typeof valor === 'string' ? valor : valor.id ?? null;
}

/** Periodo actual: en la suscripción (API ≤ 2025-02) o en su primer item (API nueva). */
export function periodoDeSuscripcion(sub: SuscripcionLite): { inicio: string | null; fin: string | null } {
  const item = sub.items?.data?.[0];
  return {
    inicio: unixAIso(sub.current_period_start ?? item?.current_period_start ?? null),
    fin: unixAIso(sub.current_period_end ?? item?.current_period_end ?? null),
  };
}

export function priceIdDeSuscripcion(sub: SuscripcionLite): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

/** `club_id` positivo a partir de metadata / client_reference_id. */
export function clubIdValido(valor: unknown): number | null {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Orígenes permitidos para success/cancel/return URLs y CORS:
 * APP_URL + BILLING_ALLOWED_ORIGINS (coma). Sin barra final.
 */
export function origenesPermitidos(appUrl: string | undefined, extra: string | undefined): string[] {
  const lista = [appUrl || '', ...(extra || '').split(',')]
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return Array.from(new Set(lista));
}

/** Acepta solo URLs absolutas de un origen permitido (evita open redirects). */
export function urlDeRetornoValida(url: unknown, origenes: string[]): string | null {
  if (typeof url !== 'string' || !url.trim() || url.length > 2000) return null;
  try {
    const u = new URL(url.trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    if (!origenes.includes(u.origin)) return null;
    // Stripe necesita el marcador literal {CHECKOUT_SESSION_ID}; URL() lo codifica.
    return u.toString().replace(/%7BCHECKOUT_SESSION_ID%7D/g, '{CHECKOUT_SESSION_ID}');
  } catch {
    return null;
  }
}

/**
 * Cupones permitidos desde el Checkout: STRIPE_CUPONES_PERMITIDOS, ej.
 * "FUNDADOR15:mensual,ALIADO10". `:mensual`/`:anual` restringe la frecuencia.
 * Un cupón fuera de la lista se rechaza aunque exista en Stripe.
 */
export function parsearCuponesPermitidos(texto: string | undefined): Map<string, Array<'mensual' | 'anual'> | null> {
  const mapa = new Map<string, Array<'mensual' | 'anual'> | null>();
  (texto ?? 'FUNDADOR15:mensual')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entrada) => {
      const [id, ...frecs] = entrada.split(':').map((s) => s.trim());
      if (!id) return;
      const validas = frecs.filter((f): f is 'mensual' | 'anual' => f === 'mensual' || f === 'anual');
      mapa.set(id, validas.length ? validas : null);
    });
  return mapa;
}

export function cuponPermitido(
  couponId: string,
  frecuencia: string | null,
  permitidos: Map<string, Array<'mensual' | 'anual'> | null>
): boolean {
  if (!permitidos.has(couponId)) return false;
  const frecs = permitidos.get(couponId);
  return !frecs || (frecuencia != null && frecs.includes(frecuencia as 'mensual' | 'anual'));
}

/**
 * Si el club está en prueba (código QLUBOS) y aún le quedan > 48 h, la
 * suscripción arranca con `trial_end` = fin de su prueba: no pierde días y el
 * primer cobro llega al terminarla. Stripe exige trial_end ≥ 48 h a futuro.
 */
export function trialEndParaConversion(
  estado: string | null | undefined,
  pruebaFinIso: string | null | undefined,
  ahoraMs = Date.now()
): number | null {
  if (estado !== 'prueba' || !pruebaFinIso) return null;
  const fin = new Date(pruebaFinIso).getTime();
  if (!Number.isFinite(fin)) return null;
  const margenMs = 49 * 60 * 60 * 1000;
  return fin - ahoraMs > margenMs ? Math.floor(fin / 1000) : null;
}

/** Tipo de checkout por metadata (incluye la metadata vieja de soporte-stripe-checkout). */
export function tipoDeCheckout(metadata: Record<string, string> | null | undefined): 'suscripcion' | 'soporte' | null {
  const m = metadata ?? {};
  if (m.type === 'suscripcion') return 'suscripcion';
  if (m.type === 'soporte' || m.tipo === 'soporte_horas_extra') return 'soporte';
  return null;
}

/** Nombre legado para `configuracion_club.plan_nombre` (lo lee App.jsx). */
export function nombrePlanLegado(planNombre: string | null, planCanchas: string | null): string | null {
  if (!planNombre && !planCanchas) return null;
  const rango = planCanchas ? `${planCanchas.replace('-', ' – ')} Canchas` : '';
  return [planNombre, rango].filter(Boolean).join(' · ');
}

/** Equivalente mensual para `configuracion_club.plan_precio_mensual`. */
export function precioMensualLegado(montoMxn: number | null, frecuencia: string | null): number | null {
  if (montoMxn == null || !Number.isFinite(Number(montoMxn))) return null;
  return frecuencia === 'anual' ? Math.round(Number(montoMxn) / 12) : Number(montoMxn);
}

/** Errores que NO deben reintentarse (Stripe recibe 200 y el evento queda en 'error'). */
export class ErrorNoReintentable extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorNoReintentable';
  }
}
