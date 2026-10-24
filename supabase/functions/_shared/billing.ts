// =============================================================================
// QLUBOS · Billing — utilidades compartidas con dependencias remotas:
// cliente de Stripe, cliente de Supabase (service_role), CORS y autorización.
//
// Secrets (supabase secrets set …):
//   STRIPE_SECRET_KEY            sk_test_… / sk_live_…
//   STRIPE_WEBHOOK_SECRET        whsec_… (solo billing-webhook)
//   APP_URL                      https://app.qlubos.com
//   BILLING_ALLOWED_ORIGINS      (opcional) orígenes extra, coma: https://staging.qlubos.com,http://localhost:5173
//   STRIPE_CUPONES_PERMITIDOS    (opcional) default "FUNDADOR15:mensual"
//   STRIPE_PORTAL_CONFIGURATION_ID (opcional) bpc_… si usas una configuración no-default del Portal
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.
// =============================================================================
import Stripe from 'https://esm.sh/stripe@14.24.0?target=deno';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { origenesPermitidos } from './billing_logica.ts';

// Versión de API fijada (la que trae stripe-node 14.x). Crea el endpoint del
// webhook en Stripe con esta MISMA versión.
export const STRIPE_API_VERSION = '2023-10-16';

export function crearStripe(): Stripe {
  const clave = Deno.env.get('STRIPE_SECRET_KEY');
  if (!clave) throw new Error('Falta el secret STRIPE_SECRET_KEY.');
  return new Stripe(clave, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: 'QLUBOS Billing' },
  });
}

export const proveedorCripto = Stripe.createSubtleCryptoProvider();

/** Cliente con service_role: salta RLS. SOLO en Edge Functions. */
export function crearAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function appUrl(): string {
  return (Deno.env.get('APP_URL') || '').replace(/\/+$/, '');
}

export function origenes(): string[] {
  return origenesPermitidos(Deno.env.get('APP_URL'), Deno.env.get('BILLING_ALLOWED_ORIGINS'));
}

// ---------------------------------------------------------------------------
// CORS (solo billing-checkout / billing-portal; el webhook no lo necesita)
// ---------------------------------------------------------------------------
export function cabecerasCors(req: Request): Record<string, string> {
  const permitidos = origenes();
  const origen = req.headers.get('Origin') ?? '';
  const permitido = permitidos.includes(origen) ? origen : permitidos[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function respuestaJson(req: Request, cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...cabecerasCors(req), 'Content-Type': 'application/json' },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 204, headers: cabecerasCors(req) });
  if (req.method !== 'POST') return respuestaJson(req, { error: 'Método no permitido.' }, 405);
  return null;
}

// ---------------------------------------------------------------------------
// Autenticación y autorización
// ---------------------------------------------------------------------------
export interface Usuario {
  id: string;
  email: string | null;
}

/** Valida el JWT del llamante (Authorization: Bearer …). */
export async function usuarioDeLaPeticion(req: Request): Promise<Usuario | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const cliente = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await cliente.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export interface ClubAutorizado {
  id: number;
  nombre: string | null;
  propietario_user_id: string | null;
  fila: Record<string, unknown>;
  esStaff: boolean;
}

/** El usuario es dueño del club o staff activo de QLUBOS. */
export async function autorizarClub(admin: SupabaseClient, usuario: Usuario, clubId: number): Promise<ClubAutorizado | null> {
  const { data: club, error } = await admin.from('configuracion_club').select('*').eq('id', clubId).maybeSingle();
  if (error) throw error;
  if (!club || club.eliminado_en) return null;
  if (club.propietario_user_id === usuario.id) {
    return { id: club.id, nombre: club.nombre ?? null, propietario_user_id: club.propietario_user_id, fila: club, esStaff: false };
  }
  const { data: staff } = await admin.from('plataforma_staff').select('user_id').eq('user_id', usuario.id).eq('activo', true).maybeSingle();
  if (!staff) return null;
  return { id: club.id, nombre: club.nombre ?? null, propietario_user_id: club.propietario_user_id, fila: club, esStaff: true };
}

/** Lee (o crea en 'bloqueada') la fila de control del club. */
// deno-lint-ignore no-explicit-any
export async function filaSuscripcion(admin: SupabaseClient, clubId: number): Promise<Record<string, any>> {
  const { data, error } = await admin.from('club_suscripciones').select('*').eq('club_id', clubId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: creada, error: errCrear } = await admin
    .from('club_suscripciones')
    .upsert({ club_id: clubId, estado_suscripcion: 'bloqueada', motivo_bloqueo: 'sin_suscripcion', origen: 'stripe' }, { onConflict: 'club_id', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();
  if (errCrear) throw errCrear;
  if (creada) return creada;
  const { data: releida, error: errLeer } = await admin.from('club_suscripciones').select('*').eq('club_id', clubId).single();
  if (errLeer) throw errLeer;
  return releida;
}

/** Mensaje legible de un error de Stripe (sin filtrar detalles internos). */
export function mensajeStripe(err: unknown, porDefecto: string): string {
  const e = err as { type?: string; message?: string; raw?: { message?: string } };
  if (e?.type && String(e.type).startsWith('Stripe')) return e.raw?.message || e.message || porDefecto;
  return porDefecto;
}
