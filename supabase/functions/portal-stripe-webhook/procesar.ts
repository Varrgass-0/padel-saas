// =============================================================================
// portal-stripe-webhook — procesamiento de eventos de Connect (puro, con
// dependencias inyectadas). Pruebas: supabase/functions/_tests/portal.test.ts
// =============================================================================

/** Subconjunto del evento de Stripe que se usa. `account` = cuenta conectada. */
export interface EventoConnectLite {
  id: string;
  type: string;
  account?: string | null;
  livemode?: boolean;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface DepsPortal {
  /** RPC fn_portal_confirmar_pago_reserva. */
  confirmar(args: {
    p_reserva_id: string;
    p_session_id: string;
    p_cuenta: string;
    p_payment_intent: string | null;
    p_monto_centavos: number;
    p_moneda: string;
  }): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  /** RPC fn_portal_expirar_reserva_en_linea. */
  expirar(args: { p_reserva_id: string; p_session_id: string }): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface ResultadoPortal {
  estado: 'procesado' | 'ignorado' | 'error';
  nota?: string;
  club_id?: string | null;
  objeto_id?: string | null;
  /** true = error transitorio: responder 500 para que Stripe reintente. */
  reintentar?: boolean;
}

function texto(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export async function procesarEventoPortal(evento: EventoConnectLite, deps: DepsPortal): Promise<ResultadoPortal> {
  const cuenta = texto(evento.account);
  if (!cuenta) return { estado: 'ignorado', nota: 'evento de la plataforma (sin cuenta conectada)' };

  const s = evento.data?.object ?? {};
  const metadata = (s.metadata ?? {}) as Record<string, string>;
  const sesionId = texto(s.id);
  const clubId = texto(metadata.club_id);
  if (metadata.qlubos_tipo !== 'reserva') return { estado: 'ignorado', nota: 'no es una reserva del Portal', objeto_id: sesionId };
  const reservaId = texto(metadata.reserva_id) ?? texto(s.client_reference_id);
  if (!reservaId || !sesionId) return { estado: 'error', nota: 'sesión sin reserva_id', objeto_id: sesionId, club_id: clubId };

  const evaluar = (error: { code?: string; message?: string } | null, okNota: string): ResultadoPortal => {
    if (!error) return { estado: 'procesado', nota: okNota, club_id: clubId, objeto_id: sesionId };
    // P0001 = dato inconsistente (monto/cuenta/sesión): reintentar no lo arregla.
    if (error.code === 'P0001') return { estado: 'error', nota: error.message ?? 'inconsistencia', club_id: clubId, objeto_id: sesionId };
    return { estado: 'error', nota: error.message ?? 'error', club_id: clubId, objeto_id: sesionId, reintentar: true };
  };

  switch (evento.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (s.payment_status !== 'paid') return { estado: 'ignorado', nota: `payment_status=${String(s.payment_status)}`, club_id: clubId, objeto_id: sesionId };
      const pi = s.payment_intent;
      const paymentIntent = typeof pi === 'string' ? pi : texto((pi as Record<string, unknown> | null)?.id);
      const { error } = await deps.confirmar({
        p_reserva_id: reservaId,
        p_session_id: sesionId,
        p_cuenta: cuenta,
        p_payment_intent: paymentIntent,
        p_monto_centavos: Number(s.amount_total),
        p_moneda: String(s.currency ?? ''),
      });
      return evaluar(error, `reserva ${reservaId} pagada`);
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const { error } = await deps.expirar({ p_reserva_id: reservaId, p_session_id: sesionId });
      return evaluar(error, `retención de la reserva ${reservaId} liberada`);
    }
    default:
      return { estado: 'ignorado', nota: evento.type, club_id: clubId, objeto_id: sesionId };
  }
}
