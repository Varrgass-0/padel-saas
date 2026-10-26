// =============================================================================
// Edge Function: portal-checkout — cobros en línea del Portal de Jugadores vía
// Stripe Connect (Standard, "direct charges" en la cuenta del club).
//
// El jugador del Portal NO tiene sesión de Supabase Auth: se identifica con su
// token de sesión del Portal (v106, `portal_sesiones_jugador`). El club se
// identifica por `club_id` + `slug` (la dirección /canchas/:slug del Portal).
//
// POST { accion: 'crear', tipo, club_id, slug, portal_token, return_url?, ... }
//   tipo = 'reserva'      { cancha_id, fecha, hora_inicio, duracion_minutos,
//                           items?: [{ producto_id, variante_id?, cantidad }] }
//                           (cancha + Quick Sell en UNA sola transacción)
//        = 'torneo'       { torneo_id, categoria?, pareja?: { modo, nombre,
//                           telefono, correo, jugador_id } }
//        = 'torneo_union' { participante_id }  ("Unirme a pareja")
//        = 'reta'         { reta_id }
//        = 'academia'     { clase_id, tipo_pago: 'clase_suelta'|'mensualidad' }
//        = 'tienda'       { items: [{ producto_id, variante_id?, cantidad }] }
//   Sin `tipo` = 'reserva' (compatible con App-101).
//   → valida club ↔ slug, Stripe Connect activo, token del jugador, el evento
//     y TODOS los precios/existencias contra la BD (nunca el monto del
//     navegador); retiene el lugar (fn_portal_pago_retener, v122) y crea la
//     sesión de Checkout EN LA CUENTA DEL CLUB:
//       stripe.checkout.sessions.create({...}, { stripeAccount })
//     Sin application_fee: el 100 % va al club.
//   ← { url, pago_id, tipo, monto, expira_en, referencia_ids, reserva_id? }
//
// POST { accion: 'liberar', club_id, portal_token, pago_id | reserva_id }
//   → el jugador canceló en la pantalla de Stripe: expira la sesión y libera
//     el lugar (si la sesión ya se pagó, no se toca nada).
//
// Club sin Stripe conectado → 409 { codigo: 'pagos_en_linea_no_disponibles' }:
// el Portal sigue con el pago presencial en recepción.
//
// La confirmación (marcar pagado, ticket en ventas, descuento de inventario
// POS + Kardex) la hace `portal-stripe-webhook` (Connect).
// Secrets: STRIPE_SECRET_KEY, APP_URL (+ BILLING_ALLOWED_ORIGINS opcional).
// Deploy: supabase functions deploy portal-checkout
// =============================================================================
import { appUrl, corsHeaders, crearAdmin, crearStripe, mensajeStripe, origenes, preflight, respuestaJson } from '../_shared/billing.ts';
import { clubIdValido, urlDeRetornoValida } from '../_shared/billing_logica.ts';
import {
  ahoraEnZona,
  type ArticuloCobrado,
  centavos,
  costoCancha,
  cotizarArticulos,
  CUPOS_RETA,
  cuentaConectadaActiva,
  errorDeRetencion,
  esTipoPagoPortal,
  esTokenPortal,
  eventoYaInicio,
  filaActiva,
  membresiaActiva,
  MINUTOS_RETENCION,
  MONTO_MINIMO_MXN,
  montoInscripcionTorneo,
  montoParaUnirseATorneo,
  PAQUETE_CREDITOS_DEFECTO,
  precioClase,
  precioDeReta,
  redondear2,
  slugDelClub,
  telefonoLimpio,
  textoCorto,
  type TipoPagoPortal,
  urlConParametros,
  validarSolicitudReserva,
  zonaDelClub,
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

const ORIGEN_PORTAL = 'PORTAL_WEB';

interface LineaStripe {
  nombre: string;
  descripcion?: string;
  centavos: number;
  cantidad: number;
}

/** Lo que cada módulo necesita para retener y cobrar. */
interface Plan {
  concepto: string;
  items: ArticuloCobrado[];
  detalle: Fila;
  filas: Fila[];
  lineas: LineaStripe[];
}

interface Contexto {
  req: Request;
  admin: Admin;
  club: Fila;
  clubId: number;
  jugador: Fila;
  cuerpo: Fila;
  hoy: string;
  zona: string;
}

type ResultadoPlan = { plan: Plan } | { respuesta: Response };

class ErrorPortal extends Error {
  constructor(public status: number, public codigo: string | null, mensaje: string) {
    super(mensaje);
  }
}

function falla(status: number, codigo: string | null, mensaje: string): never {
  throw new ErrorPortal(status, codigo, mensaje);
}

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

async function filaDelClub(admin: Admin, tabla: string, id: unknown, clubId: number): Promise<Fila | null> {
  if (id == null || id === '') return null;
  const { data, error } = await admin.from(tabla).select('*').eq('id', String(id)).maybeSingle();
  if (error) throw error;
  if (!data || String(data.club_id) !== String(clubId)) return null;
  return data as Fila;
}

async function productosDelClub(admin: Admin, clubId: number): Promise<Map<string, Fila>> {
  const { data, error } = await admin.from('productos').select('*').eq('club_id', clubId);
  if (error) throw error;
  return new Map(((data ?? []) as Fila[]).map((p) => [String(p.id), p]));
}

function lineasDeArticulos(items: ArticuloCobrado[]): LineaStripe[] {
  return items.map((i) => ({ nombre: i.nombre, centavos: centavos(i.precio), cantidad: i.cantidad }));
}

function filaJugadorBase(ctx: Contexto): Fila {
  return {
    club_id: ctx.clubId,
    jugador_id: ctx.jugador.id,
    nombre: ctx.jugador.nombre ?? null,
    telefono: ctx.jugador.telefono ?? null,
    canal_origen: ORIGEN_PORTAL,
  };
}

// ---------------------------------------------------------------------------
// Planes por módulo (precios SIEMPRE desde la BD)
// ---------------------------------------------------------------------------
async function planReserva(ctx: Contexto): Promise<Plan> {
  const { admin, club, clubId, jugador, cuerpo } = ctx;
  const cancha = await filaDelClub(admin, 'canchas', cuerpo.cancha_id, clubId);
  if (!cancha || cancha.activa === false) falla(400, null, 'Esa cancha no está disponible.');

  const validacion = validarSolicitudReserva({ fecha: cuerpo.fecha, horaInicio: cuerpo.hora_inicio, duracionMin: cuerpo.duracion_minutos, club });
  if (!validacion.ok) falla(400, validacion.codigo ?? null, validacion.error ?? 'Horario inválido.');

  let tarifas: Fila[] = [];
  if (club.tarifas_habilitadas !== false) {
    const { data: filasTarifas, error: errT } = await admin.from('tarifas_horarios').select('*').eq('club_id', clubId);
    if (!errT && Array.isArray(filasTarifas)) tarifas = filasTarifas;
  }
  const fecha = String(cuerpo.fecha);
  const costo = costoCancha({ cancha: cancha!, club, tarifas, fecha, horaInicio: validacion.horaInicio!, duracionMin: Number(cuerpo.duracion_minutos) });

  // Quick Sell: mismos artículos curados que ofrece el modal de reserva.
  let items: ArticuloCobrado[] = [];
  let subtotalArticulos = 0;
  if (Array.isArray(cuerpo.items) && cuerpo.items.length > 0) {
    const cotizacion = cotizarArticulos(cuerpo.items, await productosDelClub(admin, clubId), club, 'addons');
    if (!cotizacion.ok) falla(400, cotizacion.codigo, cotizacion.error);
    items = cotizacion.items;
    subtotalArticulos = cotizacion.subtotal;
  }

  const nombreCancha = String(cancha!.nombre ?? 'Cancha');
  return {
    concepto: `Reserva ${nombreCancha} · ${fecha} ${validacion.horaInicio}`,
    items,
    detalle: {
      monto_cancha: costo,
      monto_addons: subtotalArticulos,
      cancha_id: cancha!.id,
      fecha,
      hora_inicio: validacion.horaInicio,
      hora_fin: validacion.horaFin,
    },
    filas: [
      {
        club_id: clubId,
        cancha_id: cancha!.id,
        jugador_id: jugador.id,
        jugador_nombre: jugador.nombre ?? null,
        fecha,
        hora_inicio: validacion.horaInicio,
        hora_fin: validacion.horaFin,
        estado: 'Reservada',
        estado_pago: 'procesando_pago',
        metodo_pago: 'Tarjeta en línea (Stripe)',
        // `monto_total` = renta pura de cancha (lo que usa toda la app para
        // ingresos de canchas); los artículos van en monto_addons/addons_detalle.
        monto_total: costo,
        monto_addons: subtotalArticulos,
        saldo_wallet_aplicado: 0,
        saldo_pendiente: 0,
        addons_detalle: items.map((i) => ({
          producto_id: i.producto_id,
          variante_id: i.variante_id,
          variante_nombre: i.variante_nombre,
          es_variante: i.es_variante,
          nombre: i.nombre,
          precio: i.precio,
          cantidad: i.cantidad,
          subtotal: i.subtotal,
        })),
        canal_origen: ORIGEN_PORTAL,
      },
    ],
    lineas: [
      {
        nombre: `Reserva ${nombreCancha}`,
        descripcion: `${String(club.nombre ?? 'Club')} · ${fecha} · ${validacion.horaInicio}–${validacion.horaFin}`,
        centavos: centavos(costo),
        cantidad: 1,
      },
      ...lineasDeArticulos(items),
    ],
  };
}

function torneoAbierto(torneo: Fila | null): boolean {
  return Boolean(torneo) && !torneo!.deleted_at && torneo!.archivado !== true && torneo!.estado !== 'finalizado';
}

async function planTorneo(ctx: Contexto): Promise<Plan> {
  const { admin, clubId, jugador, cuerpo, hoy } = ctx;
  const torneo = await filaDelClub(admin, 'torneos', cuerpo.torneo_id, clubId);
  if (!torneoAbierto(torneo)) falla(409, 'evento_no_disponible', 'Ese torneo ya no está disponible.');

  const parejaCruda = (cuerpo.pareja && typeof cuerpo.pareja === 'object' ? cuerpo.pareja : {}) as Fila;
  const modo = ['nueva', 'registrada', 'ninguna', 'sin'].includes(String(parejaCruda.modo)) ? String(parejaCruda.modo) : 'sin';
  let nombrePareja = modo === 'nueva' || modo === 'registrada' ? textoCorto(parejaCruda.nombre) : null;
  let telefonoPareja = modo === 'nueva' || modo === 'registrada' ? telefonoLimpio(parejaCruda.telefono) : null;
  let parejaJugadorId: unknown = null;
  if ((modo === 'nueva' || modo === 'registrada') && parejaCruda.jugador_id != null && parejaCruda.jugador_id !== '') {
    const companero = await filaDelClub(admin, 'jugadores', parejaCruda.jugador_id, clubId);
    if (!companero) falla(400, 'pareja_invalida', 'No encontramos a tu pareja en el directorio del club.');
    if (String(companero!.id) === String(jugador.id)) falla(400, 'pareja_invalida', 'No puedes ser tu propia pareja.');
    parejaJugadorId = companero!.id;
    if (modo === 'registrada') {
      nombrePareja = textoCorto(companero!.nombre) ?? nombrePareja;
      telefonoPareja = telefonoLimpio(companero!.telefono) ?? telefonoPareja;
    }
  }
  if (modo === 'registrada' && !parejaJugadorId) falla(400, 'pareja_invalida', 'Elige a tu pareja del directorio.');
  if (modo === 'nueva' && !nombrePareja) falla(400, 'pareja_invalida', 'Escribe el nombre de tu pareja.');

  const pareja = { modo };
  const monto = montoInscripcionTorneo(torneo!, pareja, hoy);
  const categoria = textoCorto(cuerpo.categoria);
  const esDupla = (modo === 'nueva' || modo === 'registrada') && Boolean(nombrePareja);
  const montoPorFila = esDupla ? redondear2(monto / 2) : monto;
  const grupo = esDupla ? crypto.randomUUID() : null;

  const titular: Fila = {
    ...filaJugadorBase(ctx),
    torneo_id: torneo!.id,
    categoria,
    monto: montoPorFila,
    estado_pago: 'procesando_pago',
    estatus_pago: 'procesando_pago',
    pareja_nombre: nombrePareja,
    nombre_pareja: nombrePareja,
    pareja_telefono: telefonoPareja,
    telefono_pareja: telefonoPareja,
    pareja_correo: modo === 'nueva' ? textoCorto(parejaCruda.correo, 120) : null,
    pareja_jugador_id: parejaJugadorId,
    busca_pareja: modo === 'ninguna',
    pareja_grupo_id: grupo,
    metodo_pago: 'tarjeta_portal',
    estado: 'confirmado',
  };
  const filas: Fila[] = [titular];
  if (esDupla) {
    filas.push({
      club_id: ctx.clubId,
      torneo_id: torneo!.id,
      nombre: nombrePareja,
      telefono: telefonoPareja,
      correo: modo === 'nueva' ? textoCorto(parejaCruda.correo, 120) : null,
      jugador_id: parejaJugadorId,
      categoria,
      monto: redondear2(monto - montoPorFila),
      estado_pago: 'procesando_pago',
      estatus_pago: 'procesando_pago',
      pareja_nombre: jugador.nombre ?? null,
      nombre_pareja: jugador.nombre ?? null,
      pareja_telefono: jugador.telefono ?? null,
      telefono_pareja: jugador.telefono ?? null,
      pareja_jugador_id: jugador.id,
      busca_pareja: false,
      pareja_grupo_id: grupo,
      metodo_pago: 'tarjeta_portal',
      estado: 'confirmado',
    });
  }
  const nombreTorneo = String(torneo!.nombre ?? 'Torneo');
  const detallePareja = modo === 'ninguna' ? ' · En busca de pareja' : nombrePareja ? ` · Pareja: ${nombrePareja}` : '';
  return {
    concepto: `Torneo ${nombreTorneo}${categoria ? ` · ${categoria}` : ''}${detallePareja}`,
    items: [],
    detalle: { torneo_id: torneo!.id, categoria, pareja_modo: modo, pareja_grupo_id: grupo },
    filas,
    lineas: [
      {
        nombre: `Inscripción · ${nombreTorneo}`,
        descripcion: `${categoria ? `${categoria} · ` : ''}${esDupla ? `Pareja con ${nombrePareja}` : 'Individual'}`,
        centavos: centavos(monto),
        cantidad: 1,
      },
    ],
  };
}

async function planTorneoUnion(ctx: Contexto): Promise<Plan> {
  const { admin, clubId, jugador, cuerpo, hoy } = ctx;
  const existente = await filaDelClub(admin, 'torneo_participantes', cuerpo.participante_id, clubId);
  if (!existente || existente.busca_pareja !== true || !filaActiva(existente, 'torneo_participantes')) {
    falla(409, 'pareja_completa', 'Esa pareja ya se completó.');
  }
  if (String(existente!.jugador_id ?? '') === String(jugador.id)) falla(400, 'pareja_invalida', 'No puedes unirte a tu propia inscripción.');
  const torneo = await filaDelClub(admin, 'torneos', existente!.torneo_id, clubId);
  if (!torneoAbierto(torneo)) falla(409, 'evento_no_disponible', 'Ese torneo ya no está disponible.');

  const monto = montoParaUnirseATorneo(torneo!, existente!, hoy);
  const grupo = (typeof existente!.pareja_grupo_id === 'string' && existente!.pareja_grupo_id) || crypto.randomUUID();
  const nombreTorneo = String(torneo!.nombre ?? 'Torneo');
  return {
    concepto: `Torneo ${nombreTorneo} · Unirme a ${String(existente!.nombre ?? 'pareja')}`,
    items: [],
    detalle: { torneo_id: torneo!.id, titular_id: String(existente!.id), pareja_grupo_id: grupo },
    filas: [
      {
        ...filaJugadorBase(ctx),
        torneo_id: existente!.torneo_id,
        categoria: existente!.categoria ?? null,
        monto,
        estado_pago: 'procesando_pago',
        estatus_pago: 'procesando_pago',
        pareja_nombre: existente!.nombre ?? null,
        nombre_pareja: existente!.nombre ?? null,
        pareja_telefono: existente!.telefono ?? null,
        telefono_pareja: existente!.telefono ?? null,
        pareja_jugador_id: existente!.jugador_id ?? null,
        busca_pareja: false,
        pareja_grupo_id: grupo,
        metodo_pago: 'tarjeta_portal',
        estado: 'confirmado',
      },
    ],
    lineas: [
      {
        nombre: `Inscripción · ${nombreTorneo}`,
        descripcion: `Pareja de ${String(existente!.nombre ?? 'jugador')}`,
        centavos: centavos(monto),
        cantidad: 1,
      },
    ],
  };
}

async function planReta(ctx: Contexto): Promise<Plan> {
  const { admin, clubId, cuerpo, zona } = ctx;
  const reta = await filaDelClub(admin, 'retas', cuerpo.reta_id, clubId);
  if (
    !reta ||
    reta.deleted_at ||
    reta.archivado === true ||
    String(reta.estado ?? 'abierta') === 'cancelada' ||
    eventoYaInicio(reta.fecha, reta.hora_inicio, zona)
  ) {
    falla(409, 'evento_no_disponible', 'Esa reta ya no está disponible.');
  }
  const monto = precioDeReta(reta);
  const nombreReta = String(reta!.nombre ?? 'Reta');
  return {
    concepto: `Reta ${nombreReta}`,
    items: [],
    detalle: { reta_id: reta!.id, cupo_maximo: CUPOS_RETA, nivel: reta!.nivel ?? null },
    filas: [
      {
        ...filaJugadorBase(ctx),
        reta_id: reta!.id,
        monto,
        estado_pago: 'procesando_pago',
        estatus_pago: 'procesando_pago',
        estado: 'confirmado',
        metodo_pago: 'tarjeta_portal',
      },
    ],
    lineas: [
      {
        nombre: `Lugar en ${nombreReta}`,
        descripcion: `${String(reta!.fecha ?? '')} ${String(reta!.hora_inicio ?? '').slice(0, 5)}`.trim() || undefined,
        centavos: centavos(monto),
        cantidad: 1,
      },
    ],
  };
}

async function planAcademia(ctx: Contexto): Promise<Plan> {
  const { admin, clubId, jugador, cuerpo, zona, hoy } = ctx;
  const tipoPago = cuerpo.tipo_pago === 'mensualidad' ? 'mensualidad' : 'clase_suelta';
  const clase = await filaDelClub(admin, 'academia_clases', cuerpo.clase_id, clubId);
  if (!clase || clase.estado === 'cancelada' || clase.deleted_at || eventoYaInicio(clase.fecha, clase.hora_inicio, zona)) {
    falla(409, 'evento_no_disponible', 'Esa clase ya no está disponible.');
  }
  // Con membresía vigente la clase se cubre con créditos (sin cobro).
  const { data: alumnos, error } = await admin.from('academia_alumnos').select('*').eq('club_id', clubId).eq('jugador_id', String(jugador.id));
  if (error) throw error;
  if (membresiaActiva((alumnos ?? []) as Fila[], String(jugador.id), hoy)) {
    falla(409, 'cubierto_por_membresia', 'Tu membresía vigente cubre esta clase con créditos; no necesitas pagar.');
  }
  const monto = precioClase(clase!, tipoPago);
  const nombreClase = String(clase!.nombre ?? 'Clase');
  const etiqueta = tipoPago === 'mensualidad' ? 'Mensualidad' : clase!.tipo_clase !== 'privada' ? 'Clase Grupal (Cuota Individual)' : 'Clase suelta';
  return {
    concepto: `${nombreClase} · ${etiqueta}`,
    items: [],
    detalle: { clase_id: clase!.id, tipo_pago: tipoPago, paquete_creditos: PAQUETE_CREDITOS_DEFECTO },
    filas: [
      {
        ...filaJugadorBase(ctx),
        clase_id: clase!.id,
        tipo_pago: tipoPago,
        estado_pago: 'procesando_pago',
        monto,
        estado: 'activo',
        metodo_pago: 'tarjeta_portal',
        ...(clase!.tipo_clase !== 'privada' ? { acepto_politicas_grupo_en: new Date().toISOString() } : {}),
      },
    ],
    lineas: [{ nombre: `${nombreClase} · ${etiqueta}`, centavos: centavos(monto), cantidad: 1 }],
  };
}

async function planTienda(ctx: Contexto): Promise<Plan> {
  const { admin, club, clubId, cuerpo } = ctx;
  if (!Array.isArray(cuerpo.items) || cuerpo.items.length === 0) falla(400, 'articulos_invalidos', 'Tu carrito está vacío.');
  const cotizacion = cotizarArticulos(cuerpo.items, await productosDelClub(admin, clubId), club, 'tienda');
  if (!cotizacion.ok) falla(400, cotizacion.codigo, cotizacion.error);
  const n = cotizacion.items.reduce((acc, i) => acc + i.cantidad, 0);
  return {
    concepto: `Tienda · ${n} artículo${n === 1 ? '' : 's'}`,
    items: cotizacion.items,
    detalle: {},
    filas: [],
    lineas: lineasDeArticulos(cotizacion.items),
  };
}

const PLANES: Record<TipoPagoPortal, (ctx: Contexto) => Promise<Plan>> = {
  reserva: planReserva,
  torneo: planTorneo,
  torneo_union: planTorneoUnion,
  reta: planReta,
  academia: planAcademia,
  tienda: planTienda,
};

// ---------------------------------------------------------------------------
// Liberar (el jugador canceló en la pantalla de Stripe)
// ---------------------------------------------------------------------------
async function expirarSesion(sesionId: string, cuenta: string): Promise<'expirada' | 'pagada'> {
  try {
    await clienteStripe().checkout.sessions.expire(sesionId, {}, { stripeAccount: cuenta });
  } catch (err) {
    // Ya pagada o ya expirada: se consulta su estado real.
    const s = await clienteStripe().checkout.sessions.retrieve(sesionId, {}, { stripeAccount: cuenta });
    if (s?.status === 'complete') return 'pagada';
    console.warn('[portal-checkout] No se pudo expirar la sesión', sesionId, mensajeStripe(err, ''));
  }
  return 'expirada';
}

async function liberar(req: Request, admin: Admin, clubId: number, jugadorId: string, cuerpo: Fila): Promise<Response> {
  // v122: pago genérico.
  if (cuerpo.pago_id != null) {
    const { data: pago, error } = await admin.from('portal_pagos').select('*').eq('id', String(cuerpo.pago_id)).maybeSingle();
    if (error) throw error;
    if (!pago || String(pago.club_id) !== String(clubId) || String(pago.jugador_id) !== jugadorId) {
      return respuestaJson(req, { error: 'Pago no encontrado.' }, 404);
    }
    if (pago.estado !== 'procesando') return respuestaJson(req, { estado: pago.estado });
    const sesionId = typeof pago.stripe_checkout_session_id === 'string' ? pago.stripe_checkout_session_id : null;
    if (sesionId && (await expirarSesion(sesionId, String(pago.stripe_account_id))) === 'pagada') {
      return respuestaJson(req, { estado: 'pagada' });
    }
    const { error: errExp } = await admin.rpc('fn_portal_pago_expirar', { p_pago_id: pago.id, p_session_id: sesionId });
    if (errExp) throw errExp;
    return respuestaJson(req, { estado: 'liberada' });
  }

  // v121: reserva sin portal_pagos.
  const reservaId = cuerpo.reserva_id != null ? String(cuerpo.reserva_id) : '';
  const { data: reserva, error: errR } = await admin.from('reservas').select('*').eq('id', reservaId).maybeSingle();
  if (errR) throw errR;
  if (!reserva || String(reserva.club_id) !== String(clubId) || String(reserva.jugador_id) !== jugadorId) {
    return respuestaJson(req, { error: 'Reserva no encontrada.' }, 404);
  }
  if (reserva.pago_en_linea_id) return liberar(req, admin, clubId, jugadorId, { pago_id: reserva.pago_en_linea_id });
  if (reserva.pago_en_linea_estado !== 'procesando') return respuestaJson(req, { estado: reserva.pago_en_linea_estado ?? null });
  const sesionId = typeof reserva.stripe_checkout_session_id === 'string' ? reserva.stripe_checkout_session_id : null;
  const cuentaReserva = typeof reserva.stripe_account_id === 'string' ? reserva.stripe_account_id : null;
  if (sesionId && cuentaReserva) {
    if ((await expirarSesion(sesionId, cuentaReserva)) === 'pagada') return respuestaJson(req, { estado: 'pagada' });
    const { error: errExp } = await admin.rpc('fn_portal_expirar_reserva_en_linea', { p_reserva_id: reservaId, p_session_id: sesionId });
    if (errExp) throw errExp;
  } else {
    await admin
      .from('reservas')
      .update({ estado: 'Cancelada', estado_pago: 'expirado', pago_en_linea_estado: 'expirado' })
      .eq('id', reservaId)
      .eq('pago_en_linea_estado', 'procesando');
  }
  return respuestaJson(req, { estado: 'liberada' });
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  // Preflight CORS: respuesta inmediata, antes de cualquier otra lógica.
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders });
  const corto = preflight(req);
  if (corto) return corto;

  try {
    const cuerpo = ((await req.json().catch(() => ({}))) ?? {}) as Fila;
    const accion = cuerpo.accion === 'liberar' ? 'liberar' : 'crear';
    const clubId = clubIdValido(cuerpo.club_id);
    if (!clubId) return respuestaJson(req, { error: 'club_id inválido.' }, 400);
    if (!esTokenPortal(cuerpo.portal_token)) {
      return respuestaJson(req, { error: 'Inicia sesión en el Portal para pagar en línea.', codigo: 'sesion_portal' }, 401);
    }

    const admin = crearAdmin();
    const { data: club, error: errClub } = await admin.from('configuracion_club').select('*').eq('id', clubId).maybeSingle();
    if (errClub) throw errClub;
    if (!club || club.eliminado_en) return respuestaJson(req, { error: 'Club no encontrado.' }, 404);

    const jugadorId = await jugadorDelToken(admin, cuerpo.portal_token as string, clubId);
    if (!jugadorId) return respuestaJson(req, { error: 'Tu sesión del Portal expiró. Vuelve a iniciar sesión.', codigo: 'sesion_portal' }, 401);

    if (accion === 'liberar') return await liberar(req, admin, clubId, jugadorId, cuerpo);

    // ---- Crear ---------------------------------------------------------------
    const slug = typeof cuerpo.slug === 'string' ? cuerpo.slug.trim().toLowerCase() : '';
    if (!slug || slug !== slugDelClub(club)) return respuestaJson(req, { error: 'El club no coincide con la dirección del Portal.' }, 400);
    const cuenta = cuentaConectadaActiva(club);
    if (!cuenta) {
      return respuestaJson(
        req,
        { error: 'Este club todavía no acepta pagos en línea. Paga en el club.', codigo: 'pagos_en_linea_no_disponibles' },
        409
      );
    }
    const tipo = cuerpo.tipo == null ? 'reserva' : cuerpo.tipo;
    if (!esTipoPagoPortal(tipo)) return respuestaJson(req, { error: 'Tipo de pago inválido.', codigo: 'tipo_invalido' }, 400);

    const { data: jugador, error: errJ } = await admin.from('jugadores').select('*').eq('id', jugadorId).maybeSingle();
    if (errJ) throw errJ;
    if (!jugador || String(jugador.club_id) !== String(clubId)) return respuestaJson(req, { error: 'Jugador no encontrado en este club.' }, 403);

    const zona = zonaDelClub(club);
    const ctx: Contexto = { req, admin, club, clubId, jugador, cuerpo, zona, hoy: ahoraEnZona(zona).fecha };
    const plan = await PLANES[tipo](ctx);

    const totalCentavos = plan.lineas.reduce((acc, l) => acc + l.centavos * l.cantidad, 0);
    const monto = totalCentavos / 100;
    if (!(monto >= MONTO_MINIMO_MXN)) {
      return respuestaJson(req, { error: `El monto mínimo para pagar en línea es de $${MONTO_MINIMO_MXN} MXN.`, codigo: 'monto_minimo' }, 400);
    }

    // URLs de regreso: página del Portal del club (origen permitido) o APP_URL.
    const base = appUrl();
    let retorno = base ? `${base}/canchas/${slug}` : '';
    if (cuerpo.return_url != null) {
      const valida = urlDeRetornoValida(cuerpo.return_url, origenes());
      if (valida) retorno = valida;
    }
    if (!retorno) return respuestaJson(req, { error: 'Falta APP_URL en los secrets de la función.' }, 500);

    // Retención del lugar (candados por evento en la BD).
    const expiraEn = new Date(Date.now() + (MINUTOS_RETENCION + 1) * 60_000);
    const { data: retencion, error: errHold } = await admin.rpc('fn_portal_pago_retener', {
      p_pago: {
        club_id: clubId,
        jugador_id: String(jugador.id),
        jugador_nombre: jugador.nombre ?? null,
        tipo,
        concepto: plan.concepto,
        monto,
        items: plan.items,
        detalle: plan.detalle,
        stripe_account_id: cuenta,
        expira_en: expiraEn.toISOString(),
      },
      p_filas: plan.filas,
    });
    if (errHold) {
      const conocido = errorDeRetencion(String(errHold.message ?? ''));
      if (conocido) return respuestaJson(req, conocido, 409);
      throw errHold;
    }
    const pagoId = String((retencion as Fila)?.pago_id ?? '');
    const referencias = Array.isArray((retencion as Fila)?.referencia_ids) ? ((retencion as Fila).referencia_ids as string[]) : [];
    if (!pagoId) throw new Error('La retención no devolvió pago_id.');

    const liberarRetencion = async () => {
      const { error } = await admin.rpc('fn_portal_pago_expirar', { p_pago_id: pagoId, p_session_id: null });
      if (error) console.error('[portal-checkout] No se pudo liberar la retención', pagoId, error.message);
    };

    let sesion;
    try {
      const metadata = { qlubos_tipo: 'portal_pago', pago_id: pagoId, tipo, club_id: String(clubId), jugador_id: String(jugador.id) };
      const parametrosRetorno = { pago: 'exito', pago_id: pagoId, tipo };
      sesion = await clienteStripe().checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          locale: 'es-419',
          line_items: plan.lineas.map((l) => ({
            quantity: l.cantidad,
            price_data: {
              currency: 'mxn',
              unit_amount: l.centavos,
              product_data: { name: l.nombre.slice(0, 250), ...(l.descripcion ? { description: l.descripcion.slice(0, 500) } : {}) },
            },
          })),
          client_reference_id: pagoId,
          customer_email: typeof jugador.correo === 'string' && jugador.correo.includes('@') ? jugador.correo : undefined,
          metadata,
          payment_intent_data: { metadata, description: `QLUBOS ${plan.concepto}`.slice(0, 500) },
          expires_at: Math.floor(Date.now() / 1000) + MINUTOS_RETENCION * 60,
          success_url: urlConParametros(retorno, parametrosRetorno),
          cancel_url: urlConParametros(retorno, { pago: 'cancelado', pago_id: pagoId, tipo }),
        },
        { stripeAccount: cuenta, idempotencyKey: `qlubos-portal-pago-${pagoId}` }
      );
    } catch (err) {
      await liberarRetencion();
      console.error('[portal-checkout] Stripe rechazó la sesión; se liberó el lugar.', mensajeStripe(err, ''));
      return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago en línea. Intenta de nuevo.') }, 502);
    }

    const { error: errSesion } = await admin.rpc('fn_portal_pago_asignar_sesion', { p_pago_id: pagoId, p_session_id: sesion.id });
    if (errSesion) {
      await liberarRetencion();
      throw errSesion;
    }

    return respuestaJson(req, {
      url: sesion.url,
      pago_id: pagoId,
      tipo,
      monto,
      expira_en: expiraEn.toISOString(),
      referencia_ids: referencias,
      ...(tipo === 'reserva' ? { reserva_id: referencias[0] ?? null } : {}),
    });
  } catch (err) {
    if (err instanceof ErrorPortal) {
      return respuestaJson(req, err.codigo ? { error: err.message, codigo: err.codigo } : { error: err.message }, err.status);
    }
    console.error('[portal-checkout]', err);
    return respuestaJson(req, { error: mensajeStripe(err, 'No se pudo iniciar el pago en línea. Intenta de nuevo.') }, 500);
  }
});
