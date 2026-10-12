// CORS para las Edge Functions de Soporte que llama el navegador
// (solo soporte-stripe-checkout; los webhooks los llama Stripe/Cal.com).
// APP_URL limita el origen permitido; sin APP_URL se acepta cualquiera.
const ORIGEN_PERMITIDO = Deno.env.get('APP_URL') || '*';

export const corsHeaders = {
  'Access-Control-Allow-Origin': ORIGEN_PERMITIDO,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function respuestaJson(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
