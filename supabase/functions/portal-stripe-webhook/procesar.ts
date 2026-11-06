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
  /** v122 · RPC fn_portal_pago_confirmar (todos los módulos del Portal). */
  confirmarPago?(args: {
    p_pago_id: string;
    p_session_id: string;
    p_cuenta: string;
    p_payment_intent: string | null;
    p_monto_centavos: number;
    p_moneda: string;
  }): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  /** v122 · RPC fn_portal_pago_expirar. */
  expirarPago?(args: { p_pago_id: string; p_session_id: string }): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  /**
   * v141 · RPC fn_portal_asegurar_notificacion_pago: garantiza que el club
   * tenga su aviso en `notificaciones_club` (Realtime → campana + sonido)
   * después de confirmar el pago. Idempotente. Opcional: sin v141 no se llama.
   */
  asegurarNotificacion?(args: { p_pago_id: string | null; p_reserva_id: string | null }): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface ResultadoPortal {
  estado: 'procesado' | 'ignorado' | 'error';
  nota?: string;
  club_id?: string | null;
  objeto_id?: string | null;
  /** true = error transitorio: responder 500 para que Stripe reintente. */
  reintentar?: boolean;
  /**
   * v141 · Estado del aviso al club: 'creada' | 'existente' | 'error: …' |
   * 'omitida: …'. Nunca cambia `estado` (el pago ya quedó confirmado).
   */
  notificacion?: string;
}

/** Llama a `asegurarNotificacion` sin que un fallo afecte el resultado del pago. */
async function asegurarAviso(deps: DepsPortal, pagoId: string | null, reservaId: string | null): Promise<string | undefined> {
  if (!deps.asegurarNotificacion) return undefined;
  try {
    const { data, error } = await deps.asegurarNotificacion({ p_pago_id: pagoId, p_reserva_id: reservaId });
    if (error) return `error: ${error.message ?? error.code ?? 'desconocido'}`;
    const d = (data ?? {}) as Record<string, unknown>;
    const estado = typeof d.estado === 'string' ? d.estado : 'desconocido';
    return estado === 'error' ? `error: ${String(d.error ?? 'sin detalle')}` : estado;
  } catch (err) {
    return `error: ${(err as Error)?.message ?? String(err)}`;
  }
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
  const esPagoPortal = metadata.qlubos_tipo === 'portal_pago';
  if (metadata.qlubos_tipo !== 'reserva' && !esPagoPortal) return { estado: 'ignorado', nota: 'no es un cobro del Portal', objeto_id: sesionId };
  const reservaId = esPagoPortal ? null : texto(metadata.reserva_id) ?? texto(s.client_reference_id);
  const pagoId = esPagoPortal ? texto(metadata.pago_id) ?? texto(s.client_reference_id) : null;
  if (!sesionId || (!reservaId && !pagoId)) {
    return { estado: 'error', nota: esPagoPortal ? 'sesión sin pago_id' : 'sesión sin reserva_id', objeto_id: sesionId, club_id: clubId };
  }
  if (esPagoPortal && (!deps.confirmarPago || !deps.expirarPago)) {
    return { estado: 'error', nota: 'webhook sin soporte de portal_pago', objeto_id: sesionId, club_id: clubId, reintentar: true };
  }
  const etiqueta = esPagoPortal ? `pago ${pagoId} (${texto(metadata.tipo) ?? 'portal'})` : `reserva ${reservaId}`;

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
      const comun = {
        p_session_id: sesionId,
        p_cuenta: cuenta,
        p_payment_intent: paymentIntent,
        p_monto_centavos: Number(s.amount_total),
        p_moneda: String(s.currency ?? ''),
      };
      const { error } = esPagoPortal
        ? await deps.confirmarPago!({ p_pago_id: pagoId!, ...comun })
        : await deps.confirmar({ p_reserva_id: reservaId!, ...comun });
      const r = evaluar(error, `${etiqueta} pagado`);
      // v141 · Con el pago ya confirmado, garantizar el aviso al club. Se hace
      // aunque el pago estuviera confirmado de antes (reintento de Stripe):
      // la RPC es idempotente y repone el aviso si se había perdido.
      if (r.estado === 'procesado') {
        const aviso = await asegurarAviso(deps, pagoId, reservaId);
        if (aviso) r.notificacion = aviso;
      }
      return r;
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const { error } = esPagoPortal
        ? await deps.expirarPago!({ p_pago_id: pagoId!, p_session_id: sesionId })
        : await deps.expirar({ p_reserva_id: reservaId!, p_session_id: sesionId });
      return evaluar(error, `retención del ${etiqueta} liberada`);
    }
    default:
      return { estado: 'ignorado', nota: evento.type, club_id: clubId, objeto_id: sesionId };
  }
}
