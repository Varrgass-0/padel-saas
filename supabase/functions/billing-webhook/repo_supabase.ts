// Repositorio de billing-webhook sobre Supabase (service_role).
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import type { FilaSuscripcion, PrecioCatalogo, RepoBilling, ResultadoRegistro } from './procesar.ts';

const COLUMNAS_FILA = 'club_id, estado_suscripcion, stripe_customer_id, stripe_subscription_id, stripe_status, prueba_inicio';

function lanzar(error: unknown): never {
  throw error instanceof Error ? error : new Error(JSON.stringify(error));
}

export function crearRepoSupabase(admin: SupabaseClient): RepoBilling {
  async function una(columna: string, valor: unknown): Promise<FilaSuscripcion | null> {
    const { data, error } = await admin.from('club_suscripciones').select(COLUMNAS_FILA).eq(columna, valor).maybeSingle();
    if (error) lanzar(error);
    return (data as FilaSuscripcion | null) ?? null;
  }

  return {
    async registrarEvento(e): Promise<ResultadoRegistro> {
      const { data: insertado, error } = await admin
        .from('stripe_eventos')
        .upsert({ ...e, estado: 'recibido' }, { onConflict: 'event_id', ignoreDuplicates: true })
        .select('event_id');
      if (error) lanzar(error);
      if (Array.isArray(insertado) && insertado.length > 0) return 'nuevo';

      const { data: existente, error: errLeer } = await admin
        .from('stripe_eventos')
        .select('estado, intentos')
        .eq('event_id', e.event_id)
        .maybeSingle();
      if (errLeer) lanzar(errLeer);
      if (!existente) return 'nuevo';
      if (existente.estado === 'procesado' || existente.estado === 'ignorado') return 'duplicado';
      // 'recibido' o 'error': reintento de Stripe → se vuelve a procesar.
      const { error: errUpd } = await admin
        .from('stripe_eventos')
        .update({ intentos: (Number(existente.intentos) || 1) + 1, estado: 'recibido', error: null })
        .eq('event_id', e.event_id);
      if (errUpd) lanzar(errUpd);
      return 'reintentar';
    },

    async cerrarEvento(eventId, estado, extra) {
      const { error } = await admin
        .from('stripe_eventos')
        .update({
          estado,
          club_id: extra.club_id ?? null,
          dominio: extra.dominio ?? null,
          objeto_id: extra.objeto_id ?? null,
          error: extra.error ?? null,
          procesado_en: new Date().toISOString(),
        })
        .eq('event_id', eventId);
      if (error) console.error('[billing-webhook] No se pudo cerrar el evento', eventId, error);
    },

    suscripcionPorClub: (clubId) => una('club_id', clubId),
    suscripcionPorCustomer: (customerId) => una('stripe_customer_id', customerId),
    suscripcionPorSubscription: (subscriptionId) => una('stripe_subscription_id', subscriptionId),

    async guardarSuscripcion(clubId, cambios) {
      const { error } = await admin.from('club_suscripciones').upsert({ club_id: clubId, ...cambios }, { onConflict: 'club_id' });
      if (error) lanzar(error);
    },

    async precioPorStripeId(priceId): Promise<PrecioCatalogo | null> {
      const { data, error } = await admin
        .from('billing_precios')
        .select('clave, plan_clave, plan_nombre, plan_canchas, frecuencia, monto_mxn, stripe_price_id')
        .eq('stripe_price_id', priceId)
        .maybeSingle();
      if (error) lanzar(error);
      return data ? { ...data, monto_mxn: data.monto_mxn != null ? Number(data.monto_mxn) : null } : null;
    },

    async actualizarPlanLegado(clubId, plan) {
      // Columnas que App.jsx todavía lee (límite de canchas, bolsa de soporte).
      const { error } = await admin.from('configuracion_club').update(plan).eq('id', clubId);
      if (error) console.warn('[billing-webhook] No se pudo actualizar el plan legado', clubId, error);
      // Ancla del ciclo de la bolsa de soporte: solo la primera vez.
      const { error: errAncla } = await admin
        .from('configuracion_club')
        .update({ plan_activado_en: new Date().toISOString() })
        .eq('id', clubId)
        .is('plan_activado_en', null);
      if (errAncla) console.warn('[billing-webhook] No se pudo fijar plan_activado_en', clubId, errAncla);
    },

    async guardarFactura(fila) {
      const { error } = await admin.from('billing_facturas').upsert(fila, { onConflict: 'stripe_invoice_id' });
      if (error) lanzar(error);
    },

    async vincularCompraSoporte(compraId, sessionId) {
      const { error } = await admin
        .from('soporte_compras_extra')
        .update({ stripe_session_id: sessionId })
        .eq('id', compraId)
        .is('stripe_session_id', null);
      if (error) console.warn('[billing-webhook] No se pudo vincular la compra de soporte', compraId, error);
    },

    async acreditarCompraSoporte(a) {
      const { data, error } = await admin.rpc('fn_billing_acreditar_compra_soporte', {
        p_stripe_session_id: a.sessionId,
        p_payment_intent: a.paymentIntent,
        p_monto_total_centavos: a.montoCentavos,
        p_moneda: a.moneda,
        p_stripe_customer_id: a.customerId,
        p_stripe_evento_id: a.eventoId,
      });
      if (error) lanzar(error);
      return { ok: Boolean(data?.ok), motivo: String(data?.motivo ?? 'desconocido') };
    },

    async cancelarCompraSoporte(sessionId) {
      const { error } = await admin
        .from('soporte_compras_extra')
        .update({ estado: 'cancelada' })
        .eq('stripe_session_id', sessionId)
        .eq('estado', 'pendiente');
      if (error) lanzar(error);
    },
  };
}
