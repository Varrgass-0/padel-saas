// =============================================================================
// stripe-connect-onboarding — lógica pura (sin red), probada en
// supabase/functions/_tests/connect.test.ts.
// =============================================================================

/** Subconjunto de `Stripe.Account` que usa QLUBOS. */
export interface CuentaConectadaLite {
  id: string;
  type?: string | null;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  metadata?: Record<string, string> | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
}

export interface EstadoConnect {
  conectada: boolean;
  stripe_account_id: string | null;
  onboarding_completado: boolean;
  cobros_habilitados: boolean;
  pagos_habilitados: boolean;
  requisitos_pendientes: number;
  motivo_deshabilitada: string | null;
}

export const ESTADO_SIN_CUENTA: EstadoConnect = {
  conectada: false,
  stripe_account_id: null,
  onboarding_completado: false,
  cobros_habilitados: false,
  pagos_habilitados: false,
  requisitos_pendientes: 0,
  motivo_deshabilitada: null,
};

/** Estado que guarda QLUBOS a partir de la cuenta de Stripe. */
export function estadoDeCuenta(cuenta: CuentaConectadaLite): EstadoConnect {
  const req = cuenta.requirements ?? {};
  const pendientes = new Set<string>([...(req.currently_due ?? []), ...(req.past_due ?? [])]);
  return {
    conectada: true,
    stripe_account_id: cuenta.id,
    onboarding_completado: cuenta.details_submitted === true,
    cobros_habilitados: cuenta.charges_enabled === true,
    pagos_habilitados: cuenta.payouts_enabled === true,
    requisitos_pendientes: pendientes.size,
    motivo_deshabilitada: req.disabled_reason ?? null,
  };
}

/** ¿Hace falta mandar al club a Stripe (onboarding sin terminar o pendientes)? */
export function requiereEnlaceOnboarding(estado: EstadoConnect): boolean {
  return !estado.onboarding_completado || !estado.cobros_habilitados || estado.requisitos_pendientes > 0;
}

/**
 * Relación ESTRICTA club ↔ cuenta: la cuenta solo se usa si su metadata dice
 * que es de este club. Evita que un ID mal guardado cruce cobros entre clubes.
 */
export function cuentaPerteneceAlClub(cuenta: CuentaConectadaLite, clubId: number): boolean {
  return String(cuenta.metadata?.club_id ?? '') === String(clubId);
}

/** ¿El error de Stripe dice que la plataforma ya no tiene acceso a la cuenta? */
export function esCuentaRevocada(err: unknown): boolean {
  const e = err as { type?: string; code?: string; message?: string; raw?: { code?: string; message?: string } } | null;
  if (!e) return false;
  if (e.type === 'StripePermissionError') return true;
  const codigo = e.code ?? e.raw?.code ?? '';
  if (codigo === 'account_invalid') return true;
  const mensaje = e.message ?? e.raw?.message ?? '';
  return e.type === 'StripeInvalidRequestError' && /no such account|does not have access to account/i.test(mensaje);
}

/** slug del club (columna `slug` o, si falta, derivado del nombre). */
export function slugDelClub(fila: Record<string, unknown>): string {
  const directo = typeof fila.slug === 'string' ? fila.slug.trim().toLowerCase() : '';
  if (/^[a-z0-9-]+$/.test(directo)) return directo;
  const nombre = typeof fila.nombre === 'string' ? fila.nombre : '';
  const derivado = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return derivado || `club-${String(fila.id ?? '')}`;
}

/** Agrega/reemplaza parámetros de consulta en una URL ya validada. */
export function urlConParametros(base: string, parametros: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(parametros)) u.searchParams.set(k, v);
  return u.toString();
}

/** Correo de contacto del club (para prellenar el onboarding de Stripe). */
export function correoDelClub(fila: Record<string, unknown>): string | null {
  for (const k of ['correo', 'email', 'correo_contacto', 'email_contacto', 'correo_administrador']) {
    const v = fila[k];
    if (typeof v === 'string' && /.+@.+\..+/.test(v.trim())) return v.trim();
  }
  return null;
}
