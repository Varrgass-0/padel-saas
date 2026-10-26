// =============================================================================
// Cliente mínimo de la API v2 de Stripe (Accounts v2 + Account Links v2).
//
// Stripe ya no recomienda Accounts v1 (`POST /v1/accounts`) para integraciones
// nuevas de Connect y responde:
//   "Stripe no longer recommends Accounts v1 for new Connect integrations.
//    Create connected accounts with POST /v2/core/accounts instead"
// El SDK fijado del proyecto (stripe@14.24.0, API 2023-10-16) no trae los
// recursos v2, así que aquí se llaman por REST (JSON) con su propia versión:
//   POST /v2/core/accounts          crear la cuenta conectada del club
//   GET  /v2/core/accounts/:id      leer estado (configuración merchant + requisitos)
//   POST /v2/core/account_links     link de onboarding hospedado por Stripe
// El resto del proyecto (Checkout con { stripeAccount }, webhooks, billing)
// sigue con el SDK v1: los IDs `acct_…` de Accounts v2 son compatibles con
// los cargos directos de la API v1 (encabezado Stripe-Account).
//
// Versión: STRIPE_V2_API_VERSION (secret opcional); por defecto
// 2025-12-15.clover, la primera versión GA de Accounts v2.
// =============================================================================

export const STRIPE_V2_API_VERSION_DEFAULT = '2025-12-15.clover';
const API_BASE = 'https://api.stripe.com';

/**
 * Error con la MISMA forma que los errores del SDK de Stripe (`type`, `code`,
 * `statusCode`, `raw`) para que `mensajeStripe` y `esCuentaRevocada` sigan
 * funcionando igual.
 */
export class ErrorStripeV2 extends Error {
  type: string;
  code: string | null;
  statusCode: number | null;
  raw: { code: string | null; message: string; type: string | null };

  constructor(statusCode: number | null, cuerpo: { type?: string; code?: string; message?: string } | null, mensajePorDefecto: string) {
    const message = cuerpo?.message || mensajePorDefecto;
    super(message);
    this.name = 'ErrorStripeV2';
    this.statusCode = statusCode;
    this.code = cuerpo?.code ?? null;
    this.type = tipoDeError(statusCode);
    this.raw = { code: this.code, message, type: cuerpo?.type ?? null };
  }
}

function tipoDeError(status: number | null): string {
  if (status == null) return 'StripeConnectionError';
  if (status === 401) return 'StripeAuthenticationError';
  if (status === 403) return 'StripePermissionError';
  if (status === 429) return 'StripeRateLimitError';
  if (status >= 500) return 'StripeAPIError';
  return 'StripeInvalidRequestError';
}

export interface OpcionesV2 {
  idempotencyKey?: string;
}

export interface ClienteStripeV2 {
  crearCuenta(cuerpo: Record<string, unknown>, opciones?: OpcionesV2): Promise<Record<string, unknown>>;
  leerCuenta(id: string, include: string[]): Promise<Record<string, unknown>>;
  crearAccountLink(cuerpo: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function crearClienteStripeV2(
  claveSecreta: string,
  version: string = STRIPE_V2_API_VERSION_DEFAULT,
  fetchImpl: typeof fetch = fetch
): ClienteStripeV2 {
  async function llamar(metodo: 'GET' | 'POST', ruta: string, cuerpo?: Record<string, unknown>, opciones: OpcionesV2 = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${claveSecreta}`,
      'Stripe-Version': version,
    };
    if (cuerpo) headers['Content-Type'] = 'application/json';
    if (opciones.idempotencyKey) headers['Idempotency-Key'] = opciones.idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(`${API_BASE}${ruta}`, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    } catch (err) {
      throw new ErrorStripeV2(null, null, `No se pudo conectar con Stripe: ${(err as Error)?.message ?? 'error de red'}`);
    }
    const texto = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = texto ? (JSON.parse(texto) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const error = (json?.error ?? null) as { type?: string; code?: string; message?: string } | null;
      throw new ErrorStripeV2(res.status, error, `Stripe respondió ${res.status}.`);
    }
    return json ?? {};
  }

  return {
    crearCuenta: (cuerpo, opciones) => llamar('POST', '/v2/core/accounts', cuerpo, opciones),
    leerCuenta: (id, include) => {
      const q = new URLSearchParams();
      include.forEach((valor, i) => q.append(`include[${i}]`, valor));
      const consulta = q.toString();
      return llamar('GET', `/v2/core/accounts/${encodeURIComponent(id)}${consulta ? `?${consulta}` : ''}`);
    },
    crearAccountLink: (cuerpo) => llamar('POST', '/v2/core/account_links', cuerpo),
  };
}
