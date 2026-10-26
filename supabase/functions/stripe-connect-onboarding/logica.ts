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
  // Accounts v2: la cuenta ya no existe para la plataforma (404 not_found).
  if (e.type === 'StripeInvalidRequestError' && codigo === 'not_found') return true;
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

// =============================================================================
// Accounts v2 (POST /v2/core/accounts) — reemplaza a la creación con
// Accounts v1, que Stripe ya no recomienda para integraciones nuevas.
// =============================================================================

/** Subconjunto de `v2.core.account` que usa QLUBOS. */
export interface CuentaV2Lite {
  id: string;
  closed?: boolean | null;
  dashboard?: string | null;
  metadata?: Record<string, string> | null;
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: { status?: string | null; status_details?: Array<{ code?: string | null }> | null } | null;
        stripe_balance?: { payouts?: { status?: string | null } | null } | null;
      } | null;
    } | null;
  } | null;
  requirements?: {
    entries?: Array<{
      awaiting_action_from?: string | null;
      description?: string | null;
      minimum_deadline?: { status?: string | null } | null;
    }> | null;
  } | null;
}

/** Datos para crear la cuenta conectada del club (equivalente a Standard). */
export function cuerpoCuentaV2(datos: { clubId: number; slug: string; nombre: string | null; correo: string | null }): Record<string, unknown> {
  return {
    ...(datos.correo ? { contact_email: datos.correo } : {}),
    ...(datos.nombre ? { display_name: datos.nombre.slice(0, 100) } : {}),
    // Dashboard completo de Stripe: el club administra su propia cuenta.
    dashboard: 'full',
    identity: { country: 'mx' },
    // Rol "merchant": el club acepta pagos con tarjeta de SUS jugadores
    // (cargos directos desde el Portal; 100 % para el club).
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    // Stripe cobra sus comisiones al club y asume el riesgo de saldos
    // negativos (igual que una cuenta Standard). QLUBOS no cobra comisión.
    defaults: { currency: 'mxn', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
    metadata: { club_id: String(datos.clubId), slug: datos.slug, plataforma: 'qlubos' },
    include: ['configuration.merchant', 'requirements'],
  };
}

/** Link de onboarding hospedado por Stripe (Account Links v2). */
export function cuerpoAccountLinkV2(accountId: string, returnUrl: string, refreshUrl: string): Record<string, unknown> {
  return {
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: { configurations: ['merchant'], return_url: returnUrl, refresh_url: refreshUrl },
    },
  };
}

export const INCLUDE_CUENTA_V2 = ['configuration.merchant', 'requirements'];

const PLAZOS_PENDIENTES = new Set(['currently_due', 'past_due']);

/** Estado que guarda QLUBOS a partir de una cuenta de Accounts v2. */
export function estadoDeCuentaV2(cuenta: CuentaV2Lite): EstadoConnect {
  const caps = cuenta.configuration?.merchant?.capabilities ?? {};
  const tarjeta = caps?.card_payments ?? null;
  const entradas = cuenta.requirements?.entries ?? [];
  // Solo cuenta lo que el CLUB debe capturar (lo que revisa Stripe no).
  const pendientes = entradas.filter(
    (e) => PLAZOS_PENDIENTES.has(String(e?.minimum_deadline?.status ?? '')) && e?.awaiting_action_from !== 'stripe'
  ).length;
  const cobros = tarjeta?.status === 'active' && cuenta.closed !== true;
  const motivo = !cobros ? tarjeta?.status_details?.[0]?.code ?? (tarjeta?.status ? `card_payments.${tarjeta.status}` : null) : null;
  return {
    conectada: cuenta.closed !== true,
    stripe_account_id: cuenta.id,
    onboarding_completado: pendientes === 0 && Boolean(tarjeta?.status) && tarjeta?.status !== 'unsupported',
    cobros_habilitados: cobros,
    pagos_habilitados: caps?.stripe_balance?.payouts?.status === 'active',
    requisitos_pendientes: pendientes,
    motivo_deshabilitada: motivo,
  };
}

/** La cuenta guardada se creó con Accounts v1 (antes de este cambio). */
export function esCuentaSoloV1(err: unknown): boolean {
  const e = err as { code?: string | null; raw?: { code?: string | null } } | null;
  const codigo = e?.code ?? e?.raw?.code ?? '';
  return codigo === 'v1_account_instead_of_v2_account' || codigo === 'account_not_yet_compatible_with_v2';
}

/** La plataforma aún no tiene habilitado Accounts v2 en Stripe. */
export function esAccountsV2Bloqueado(err: unknown): boolean {
  const e = err as { code?: string | null; raw?: { code?: string | null } } | null;
  const codigo = e?.code ?? e?.raw?.code ?? '';
  return codigo === 'accounts_v2_access_blocked' || codigo === 'non_connect_platform_accounts_v2_access_blocked';
}
