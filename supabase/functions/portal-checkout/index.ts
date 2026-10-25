// =============================================================================
// Edge Function: portal-checkout — cobro en línea de reservas del Portal de
// Jugadores vía Stripe Connect (Standard, "direct charges").
//
// El jugador del Portal NO tiene sesión de Supabase Auth: se identifica con
// su token de sesión del Portal (v106, `portal_sesiones_jugador`).
//
// POST { accion: 'crear', club_id, slug, portal_token, cancha_id, fecha,
//        hora_inicio, duracion_minutos, return_url? }
//   → valida club ↔ slug, Stripe Connect activo, token del jugador, cancha,
//     horario y precio (calculado AQUÍ, nunca el del navegador); retiene el
//     horario (reserva 'procesando_pago', candado por cancha+fecha) y crea la
//     sesión de Checkout EN LA CUENTA DEL CLUB:
//       stripe.checkout.sessions.create({...}, { stripeAccount })
//     Sin application_fee: el 100 % va al club.
//   ← { url, reserva_id, monto, expira_en }
//
// POST { accion: 'liberar', club_id, portal_token, reserva_id }
//   → el jugador canceló el pago: expira la sesión en Stripe y libera el
//     horario (si la sesión ya se pagó, no se toca nada).
//
// Club sin Stripe conectado → 409 { codigo: 'pagos_en_linea_no_disponibles' }:
// el Portal sigue con "Pago Pendiente en Club".
//
// La confirmación del pago la hace `portal-stripe-webhook` (Connect).
// Secrets: STRIPE_SECRET_KEY, APP_URL (+ BILLING_ALLOWED_ORIGINS opcional).
// Deploy: supabase functions deploy portal-checkout
// =============================================================================
import { appUrl, corsHeaders, crearAdmin, crearStripe, mensajeStripe, origenes, preflight, respuestaJson } from '../_shared/billing.ts';
import { clubIdValido, urlDeRetornoValida } from '../_shared/billing_logica.ts';
import {
  centavos,
  costoCancha,
  cuentaConectadaActiva,
  esTokenPortal,
  MINUTOS_RETENCION,
  MONTO_MINIMO_MXN,
  slugDelClub,
  urlConParametros,
  validarSolicitudReserva,
} from './logica.ts';

// Encabezados CORS estándar (ver _shared/billing.ts), exportados también aquí.
export { corsHeaders };

let _stripe: ReturnType<typeof crearStripe> | null = null;
function clienteStripe(): ReturnType<typeof crearStripe> {
  if (!_stripe) _stripe = crearStripe();
  return _stripe;
}

// deno-lint-ignore no-explicit-any
type Admin = any;
type Fila = Record<string, unknown>;

/** Token del Portal → jugador_id (o null si no es válido / venció). */
async function jugadorDelToken(admin: Admin, token: string, clubId: number): Promise<string | null> {
  const { data, error } = await admin
    .from('portal_sesiones_jugador')
    .select('jugador_id, expira_en, revocado_en')
    .eq('token', token)
    .eq('club_id', String(clubId))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revocado_en || !data.expira_en || new Date(data.expira_en).getTime() <= Date.now()) return null;
  return String(data.jugador_id);
}

async function liberarRetencion(admin: Admin, reservaId: string): Promise<void> {
  await admin
    .from('reservas')
    .update({ estado: 'Cancelada', estado_pago: 'expirado', pago_en_linea_estado: 'expirado' })
    .eq('id', reservaId)
    .eq('pago_en_linea_estado', 'procesando');
}

Deno.serve(async (req) => {
  // Preflight CORS: respuesta inmediata, antes de cualquier otra lógica.
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  const corto = preflight(req);
  if (corto) return corto;

  try {
    const cuerpo = await req.json().catch(() => ({}));
    const accion = cuerpo?.accion === 'liberar' ? 'liberar' : 'crear';
    const clubId = clubIdValido(cuerpo?.club_id);
    if (!clubId) return respuestaJson(req, { error: 'club_id inválido.' }, 400);
    if (!esTokenPortal(cuerpo?.portal_token)) {
      return respuestaJson(req, { error: 'Inicia sesión en el Portal para pagar en línea.', codigo: 'sesion_portal' }, 401);
    }

    const admin = crearAdmin();
    const { data: club, error: errClub } = await admin.from('configuracion_club').select('*').eq('id', clubId).maybeSingle();
    if (errClub) throw errClub;
    if (!club || club.eliminado_en) return respuestaJson(req, { error: 'Club no encontrado.' }, 404);

    const jugadorId = await jugadorDelToken(admin, cuerpo.portal_token, clubId);
    if (!jugadorId) return respuestaJson(req, { error: 'Tu sesión del Portal expiró. Vuelve a iniciar sesión.', codigo: 'sesion_portal' }, 401);

    const cuenta = cuentaConectadaActiva(club);

    // ---- Liberar (el jugador canceló en la pantalla de Stripe) -------------
    if (accion === 'liberar') {
      const reservaId = cuerpo?.reserva_id != null ? String(cuerpo.reserva_id) : '';
      const { data: reserva, error: errR } = await admin.from('reservas').select('*').eq('id', reservaId).maybeSingle();
      if (errR) throw errR;
      if (!reserva || String(reserva.club_id) !== String(clubId) || String(reserva.jugador_id) !== jugadorId) {
        return respuestaJson(req, { error: 'Reserva no encontrada.' }, 404);
      }
      if (reserva.pago_en_linea_estado !== 'procesando') return respuestaJson(req, { estado: reserva.pago_en_linea_estado ?? null });
      const sesionId = typeof reserva.stripe_checkout_session_id === 'string' ? reserva.stripe_checkout_session_id : null;
      const cuentaReserva = typeof reserva.stripe_account_id === 'string' ? reserva.stripe_account_id : null;
      if (sesionId && cuentaReserva) {
        try {
          await clienteStripe().checkout.sessions.expire(sesionId, {}, { stripeAccount: cuentaReserva });
        } catch (err) {
          // Ya pagada o ya expirada: se consulta su estado real.
          const s = await clienteStripe().checkout.sessions.retrieve(sesionId, {}, { stripeAccount: cuentaReserva });
          if (s?.status === 'complete') return respuestaJson(req, { estado: 'pagada' });
          console.warn('[portal-checkout] No se pudo expirar la sesión', sesionId, mensajeStripe(err, ''));
        }
        const { error: errExp } = await admin.rpc('fn_portal_expirar_reserva_en_linea', { p_reserva_id: reservaId, p_session_id: sesionId });
        if (errExp) throw errExp;
      } else {
        await liberarRetencion(admin, reservaId);
      }
      return respuestaJson(req, { estado: 'liberada' });
    }

    // ---- Crear ---------------------------------------------------------------
    const slug = typeof cuerpo?.slug === 'string' ? cuerpo.slug.trim().toLowerCase() : '';
    if (!slug || slug !== slugDelClub(club)) return respuestaJson(req, { error: 'El club no coincide con la dirección del Portal.' }, 400);
    if (!cuenta) {
      return respuestaJson(
        req,
        { error: 'Este club todavía no acepta pagos en línea. Tu reserva se paga en el club.', codigo: 'pagos_en_linea_no_disponibles' },
        409
      );
    }

    const { data: jugador, error: errJ } = await admin.from('jugadores').select('*').eq('id', jugadorId).maybeSingle();
    if (errJ) throw errJ;
    if (!jugador || String(jugador.club_id) !== String(clubId)) return respuestaJson(req, { error: 'Jugador no encontrado en este club.' }, 403);

    const canchaId = cuerpo?.cancha_id != null ? String(cuerpo.cancha_id) : '';
    const { data: cancha, error: errC } = await admin.from('canchas').select('*').eq('id', canchaId).maybeSingle();
    if (errC) throw errC;
    if (!cancha || String(cancha.club_id) !== String(clubId) || cancha.activa === false) {
      return respuestaJson(req, { error: 'Esa cancha no está disponible.' }, 400);
    }

    const validacion = validarSolicitudReserva({
      fecha: cuerpo?.fecha,
      horaInicio: cuerpo?.hora_inicio,
      duracionMin: cuerpo?.duracion_minutos,
      club,
    });
    if (!validacion.ok) return respuestaJson(req, { error: validacion.error, codigo: validacion.codigo }, 400);

    let tarifas: Fila[] = [];
    if (club.tarifas_habilitadas !== false) {
      const { data: filasTarifas, error: errT } = await admin.from('tarifas_horarios').select('*').eq('club_id', clubId);
      if (!errT && Array.isArray(filasTarifas)) tarifas = filasTarifas;
    }
    const monto = costoCancha({ cancha, club, tarifas, fecha: cuerpo.fecha, horaInicio: validacion.horaInicio!, duracionMin: Number(cuerpo.duracion_minutos) });
    if (!(monto >= MONTO_MINIMO_MXN)) {
      return respuestaJson(req, { error: `El monto mínimo para pagar en línea es de $${MONTO_MINIMO_MXN} MXN.`, codigo: 'monto_minimo' }, 400);
    }

    // URLs de regreso: página del Portal del club (origen permitido) o APP_URL.
    const base = appUrl();
    let retorno = base ? `${base}/canchas/${slug}` : '';
    if (cuerpo?.return_url != null) {
      const valida = urlDeRetornoValida(cuerpo.return_url, origenes());
      if (valida) retorno = valida;
    }
    if (!retorno) return respuestaJson(req, { error: 'Falta APP_URL en los secrets de la función.' }, 500);

    // Retención del horario (candado por cancha + fecha en la BD).
    const expiraEn = new Date(Date.now() + (MINUTOS_RETENCION + 1) * 60_000);
    const { data: reservaId, error: errHold } = await admin.rpc('fn_portal_reservar_con_pago_en_linea', {
      p_reserva: {
        club_id: clubId,
        cancha_id: cancha.id,
        jugador_id: jugador.id,
        jugador_nombre: jugador.nombre ?? null,
        fecha: cuerpo.fecha,
        hora_inicio: validacion.horaInicio,
        hora_fin: validacion.horaFin,
        estado: 'Reservada',
        estado_pago: 'procesando_pago',
        metodo_pago: 'Tarjeta en línea (Stripe)',
        monto_total: monto,
        monto_addons: 0,
        saldo_wallet_aplicado: 0,
        saldo_pendiente: 0,
        canal_origen: 'PORTAL_WEB',
        pago_en_linea_estado: 'procesando',
        pago_en_linea_monto: monto,
        pago_en_linea_expira_en: expiraEn.toISOString(),
        stripe_account_id: cuenta,
      },
    });
    if (errHold) {
      if (String(errHold.message ?? '').includes('horario_ocupado')) {
        return respuestaJson(req, { error: 'Ese horario se acaba de ocupar. Elige otro.', codigo: 'horario_ocupado' }, 409);
      }
      throw errHold;
    }
    const idReserva = String(reservaId);

    let sesion;
    try {
      const metadata = { qlubos_tipo: 'reserva', reserva_id: idReserva, club_id: String(clubId), jugador_id: String(jugador.id) };
      sesion = await clienteStripe().checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          locale: 'es-419',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'mxn',
                unit_amount: centavos(monto),
                product_data: {
                  name: `Reserva ${String(cancha.nombre ?? 'Cancha')}`,
                  description: `${String(club.nombre ?? 'Club')} · ${cuerpo.fecha} · ${validacion.horaInicio}–${validacion.horaFin}`,
                },
              },
            },
          ],
          client_reference_id: idReserva,
          customer_email: typeof jugador.correo === 'string' && jugador.correo.includes('@') ? jugador.correo : undefined,
          metadata,
          payment_intent_data: { metadata, description: `Reserva QLUBOS ${idReserva}` },
          expires_at: Math.floor(Date.now() / 1000) + MINUTOS_RETENCION * 60,
          success_url: urlConParametros(retorno, { pago: 'exito', reserva: idReserva }),
          cancel_url: urlConParametros(retorno, { pago: 'cancelado', reserva: idReserva }),
        },
        { stripeAccount: cuenta, idempotencyKey: `qlubos-portal-reserva-${idReserva}` }
      );
    } catch (err) {
      await liberarRetencion(admin, idReserva);
      console.error('[portal-checkout] Stripe rechazó la sesión; se liberó el horario.', mensajeStripe(err, ''));
      return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago en línea. Intenta de nuevo.') }, 502);
    }

    const { error: errSesion } = await admin.from('reservas').update({ stripe_checkout_session_id: sesion.id }).eq('id', idReserva);
    if (errSesion) {
      await liberarRetencion(admin, idReserva);
      throw errSesion;
    }

    return respuestaJson(req, { url: sesion.url, reserva_id: idReserva, monto, expira_en: expiraEn.toISOString() });
  } catch (err) {
    console.error('[portal-checkout]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago en línea. Intenta de nuevo.') }, 500);
  }
});
