// Edge Function: soporte-stripe-checkout
// Crea una sesión de Stripe Checkout para comprar horas extra de soporte
// ($350 MXN por hora, 1 a 3 horas). La llama el Panel del club con la sesión
// del propietario (Authorization: Bearer <jwt>).
//
// Flujo: valida usuario → valida que sea propietario del club (o staff) →
// crea la compra "pendiente" → crea la sesión de Stripe → devuelve { url }.
// Los minutos se acreditan SOLO cuando Stripe confirma el pago
// (soporte-stripe-webhook), nunca aquí.
//
// Secrets requeridos: STRIPE_SECRET_KEY, APP_URL (ej. https://app.qlubos.com).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.
import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders, respuestaJson } from '../_shared/cors.ts';

const PRECIO_HORA_MXN = 350;
const HORAS_PERMITIDAS = [1, 2, 3];

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return respuestaJson({ error: 'Método no permitido' }, 405);

  try {
    const appUrl = (Deno.env.get('APP_URL') || '').replace(/\/+$/, '');
    if (!appUrl || !Deno.env.get('STRIPE_SECRET_KEY')) {
      return respuestaJson({ error: 'Faltan STRIPE_SECRET_KEY o APP_URL en los secrets de la función.' }, 500);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUsuario = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseUsuario.auth.getUser();
    if (userError || !userData?.user) return respuestaJson({ error: 'Sesión inválida.' }, 401);
    const usuario = userData.user;

    const cuerpo = await req.json().catch(() => ({}));
    const clubId = Number(cuerpo?.club_id);
    const horas = Number(cuerpo?.horas);
    if (!Number.isFinite(clubId) || clubId <= 0) return respuestaJson({ error: 'club_id inválido.' }, 400);
    if (!HORAS_PERMITIDAS.includes(horas)) return respuestaJson({ error: 'Solo se pueden comprar 1, 2 o 3 horas.' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ¿Es propietario del club o staff de QLUBOS?
    const { data: club } = await admin
      .from('configuracion_club')
      .select('id, nombre, propietario_user_id')
      .eq('id', clubId)
      .maybeSingle();
    if (!club) return respuestaJson({ error: 'Club no encontrado.' }, 404);
    let autorizado = club.propietario_user_id === usuario.id;
    if (!autorizado) {
      const { data: staff } = await admin
        .from('plataforma_staff')
        .select('user_id')
        .eq('user_id', usuario.id)
        .eq('activo', true)
        .maybeSingle();
      autorizado = Boolean(staff);
    }
    if (!autorizado) return respuestaJson({ error: 'No tienes permiso para comprar horas para este club.' }, 403);

    const { data: compra, error: errorCompra } = await admin
      .from('soporte_compras_extra')
      .insert({
        club_id: clubId,
        horas,
        minutos: horas * 60,
        monto_mxn: horas * PRECIO_HORA_MXN,
        estado: 'pendiente',
        comprado_por: usuario.id,
      })
      .select()
      .single();
    if (errorCompra) throw errorCompra;

    const sesion = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: usuario.email ?? undefined,
      client_reference_id: String(clubId),
      line_items: [
        {
          quantity: horas,
          price_data: {
            currency: 'mxn',
            unit_amount: PRECIO_HORA_MXN * 100,
            product_data: {
              name: 'Hora extra de Soporte & Acompañamiento QLUBOS',
              description: `${club.nombre ?? 'Club'} · ${horas} ${horas === 1 ? 'hora' : 'horas'}`,
            },
          },
        },
      ],
      metadata: { tipo: 'soporte_horas_extra', compra_id: compra.id, club_id: String(clubId), horas: String(horas) },
      payment_intent_data: { metadata: { tipo: 'soporte_horas_extra', compra_id: compra.id, club_id: String(clubId) } },
      success_url: `${appUrl}/soporte?compra=exito&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/soporte?compra=cancelada`,
    });

    await admin.from('soporte_compras_extra').update({ stripe_session_id: sesion.id }).eq('id', compra.id);

    return respuestaJson({ url: sesion.url, compra_id: compra.id });
  } catch (err) {
    console.error('[soporte-stripe-checkout]', err);
    return respuestaJson({ error: (err as Error)?.message || 'No se pudo iniciar el pago.' }, 500);
  }
});
