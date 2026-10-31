// =============================================================================
// portal-checkout — lógica pura (sin red). Réplica EXACTA del cálculo de
// precio y de las reglas de horario que usa el Portal (App.jsx:
// `calcularPrecioReserva`, `tarifasActivasDelDia`, `precioPorHoraDeCancha`,
// `minutosOperacionDelClub`, `precioDelBloque` de `ModalReservarCancha`).
// El servidor NUNCA confía en el monto que mande el navegador.
// Pruebas: supabase/functions/_tests/portal.test.ts
// =============================================================================

export const HORA_INICIO_MIN = 6 * 60;
export const HORA_FIN_MIN = 24 * 60;
export const DURACION_RESERVA_DEFAULT_MIN = 60;
export const PRECIO_POR_HORA_GENERICO = 700;
export const MONTO_MINIMO_MXN = 10; // mínimo de Stripe para MXN
export const MINUTOS_RETENCION = 30; // vida de la sesión de Checkout (mínimo de Stripe)

const CAMPOS_PRECIO_HORA_CANCHA = ['precio_por_hora', 'precio_hora', 'precioPorHora', 'precioHora', 'precio', 'tarifa_hora', 'tarifa'];
const PRECIOS_POR_NOMBRE_CANCHA: Array<{ patron: RegExp; precio: number }> = [
  { patron: /negra/i, precio: 700 },
  { patron: /panor[aá]mica/i, precio: 650 },
  { patron: /red\s*bull/i, precio: 300 },
];

type Fila = Record<string, unknown>;

export function parseHoraAMinutos(horaStr: unknown): number | null {
  if (!horaStr) return null;
  const partes = String(horaStr).split(':');
  const h = parseInt(partes[0], 10);
  const m = parseInt(partes[1] || '0', 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function minutosAHora(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function precioPorHoraDeCancha(cancha: Fila): number {
  for (const campo of CAMPOS_PRECIO_HORA_CANCHA) {
    const real = Number(cancha?.[campo]);
    if (Number.isFinite(real) && real > 0) return real;
  }
  const match = PRECIOS_POR_NOMBRE_CANCHA.find((p) => p.patron.test(String(cancha?.nombre ?? '')));
  return match ? match.precio : PRECIO_POR_HORA_GENERICO;
}

function esTarifaDeAcademia(t: Fila): boolean {
  return String(t?.modulo ?? '').toLowerCase() === 'academia';
}

// ---------------------------------------------------------------------------
// Reglas de Tarifa (migracion v124) — réplica EXACTA de App.jsx:
// `tarifasActivasDelDia`, `precioHoraDeRegla`, `cotizarReserva`,
// `calcularPrecioReserva` (prorrateo por tramos, sin prioridades).
// ---------------------------------------------------------------------------
// App-114: solo precio fijo por hora y % de descuento. Una fila vieja con
// 'RECARGO_PORCENTAJE' está descontinuada (v125 la apaga) y nunca aplica.
export const TIPO_AJUSTE_PRECIO_FIJO = 'PRECIO_FIJO';
export const TIPO_AJUSTE_DESCUENTO = 'DESCUENTO_PORCENTAJE';

export function tipoAjusteDeRegla(t: Fila): string {
  return String(t?.tipo_ajuste ?? '').toUpperCase() === TIPO_AJUSTE_DESCUENTO ? TIPO_AJUSTE_DESCUENTO : TIPO_AJUSTE_PRECIO_FIJO;
}

export function esAjusteDescontinuado(t: Fila): boolean {
  const tipo = String(t?.tipo_ajuste ?? '').toUpperCase();
  return tipo !== '' && tipo !== TIPO_AJUSTE_PRECIO_FIJO && tipo !== TIPO_AJUSTE_DESCUENTO;
}

function canchasDeRegla(t: Fila): string[] {
  return Array.isArray(t?.cancha_ids) ? (t.cancha_ids as unknown[]).filter((c) => c != null && c !== '').map(String) : [];
}

export function reglaTarifaAplicaACancha(t: Fila, canchaId: unknown): boolean {
  const ids = canchasDeRegla(t);
  return ids.length === 0 || ids.includes(String(canchaId));
}

export function reglaTarifaVigenteEn(t: Fila, fecha: string): boolean {
  const f = String(fecha ?? '').slice(0, 10);
  if (!f) return true;
  const desde = t?.vigencia_desde ? String(t.vigencia_desde).slice(0, 10) : null;
  const hasta = t?.vigencia_hasta ? String(t.vigencia_hasta).slice(0, 10) : null;
  if (desde && f < desde) return false;
  if (hasta && f > hasta) return false;
  return true;
}

/** `contexto` opcional: `{ fecha, canchaId }` filtra además por vigencia y canchas aplicables. */
export function tarifasActivasDelDia(
  listaTarifas: Fila[] | null | undefined,
  diaSemana: number,
  contexto: { fecha?: string | null; canchaId?: unknown } = {}
): Fila[] {
  const fecha = contexto?.fecha || null;
  const canchaId = contexto?.canchaId ?? null;
  return (Array.isArray(listaTarifas) ? listaTarifas : []).filter((t) => {
    if (esTarifaDeAcademia(t)) return false;
    if (t?.activo === false) return false;
    if (esAjusteDescontinuado(t)) return false;
    const dias = Array.isArray(t?.dias_semana) ? (t.dias_semana as unknown[]) : null;
    if (dias && dias.length > 0 && !dias.map(Number).includes(Number(diaSemana))) return false;
    if (fecha && !reglaTarifaVigenteEn(t, fecha)) return false;
    if (canchaId != null && !reglaTarifaAplicaACancha(t, canchaId)) return false;
    return true;
  });
}

function finMinutosRegla(t: Fila): number | null {
  const hasta = parseHoraAMinutos(t?.hora_fin ?? t?.horaFin);
  if (hasta === null) return null;
  const desde = parseHoraAMinutos(t?.hora_inicio ?? t?.horaInicio);
  return hasta === 0 && desde !== null && desde > 0 ? 24 * 60 : hasta;
}

export function precioHoraDeRegla(t: Fila, base: number): number | null {
  if (esAjusteDescontinuado(t)) return null;
  if (tipoAjusteDeRegla(t) === TIPO_AJUSTE_PRECIO_FIJO) {
    const fijo = Number(t?.precio_hora ?? t?.precioHora);
    return Number.isFinite(fijo) && fijo > 0 ? fijo : null;
  }
  const pct = Number(t?.porcentaje_ajuste);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100 || !(Number(base) > 0)) return null;
  return Math.round(Number(base) * (1 - pct / 100) * 100) / 100;
}

/** Sin prioridades automáticas: si dos reglas se sobreponen, gana la primera por hora de inicio y luego por id. */
function ordenListaReglasTarifa(a: Fila, b: Fila): number {
  const ha = String(a?.hora_inicio ?? a?.horaInicio ?? '');
  const hb = String(b?.hora_inicio ?? b?.horaInicio ?? '');
  if (ha !== hb) return ha.localeCompare(hb);
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''), undefined, { numeric: true });
}

export interface TramoTarifa {
  desde: number;
  hasta: number;
  minutos: number;
  regla: Fila | null;
  precioHora: number;
  subtotal: number;
}

export interface CotizacionReserva {
  total: number;
  totalBase: number;
  /** Lo que costaría el bloque sin las reglas de % de descuento (precio tachado del Portal). */
  totalSinPromo: number;
  tramos: TramoTarifa[];
  reglas: Fila[];
  /** Reglas de % de descuento aplicadas (las únicas que se anuncian al jugador). */
  promos: Fila[];
  conAjuste: boolean;
}

/**
 * Cotización con PRORRATEO por tramos: el bloque se corta en cada inicio/fin de
 * regla que caiga dentro; cada tramo se cobra con la regla que lo cubre (o con
 * el precio/hora de la cancha) × minutos / 60. Réplica exacta de App.jsx.
 */
export function cotizarReserva(horaInicio: string, duracionMinutos: number, listaTarifas: Fila[], precioBase: number): CotizacionReserva {
  const duracion = Number(duracionMinutos) > 0 ? Number(duracionMinutos) : 60;
  const base = Number(precioBase) > 0 ? Number(precioBase) : 0;
  const redondear = (n: number) => Math.round(n * 100) / 100;
  const totalBase = redondear(base * (duracion / 60));
  const inicioMin = parseHoraAMinutos(horaInicio);
  if (inicioMin === null) return { total: totalBase, totalBase, totalSinPromo: totalBase, tramos: [], reglas: [], promos: [], conAjuste: false };
  const finMin = inicioMin + duracion;
  const reglas = (Array.isArray(listaTarifas) ? listaTarifas : [])
    .map((t) => ({ t, desde: parseHoraAMinutos(t?.hora_inicio ?? t?.horaInicio), hasta: finMinutosRegla(t), precioHora: precioHoraDeRegla(t, base) }))
    .filter((r) => r.desde !== null && r.hasta !== null && (r.hasta as number) > (r.desde as number) && r.precioHora !== null)
    .sort((x, y) => ordenListaReglasTarifa(x.t, y.t)) as Array<{ t: Fila; desde: number; hasta: number; precioHora: number }>;
  const cortes = new Set<number>([inicioMin, finMin]);
  reglas.forEach((r) => {
    if (r.desde > inicioMin && r.desde < finMin) cortes.add(r.desde);
    if (r.hasta > inicioMin && r.hasta < finMin) cortes.add(r.hasta);
  });
  const puntos = Array.from(cortes).sort((x, y) => x - y);
  const tramos: TramoTarifa[] = [];
  let total = 0;
  for (let i = 0; i < puntos.length - 1; i += 1) {
    const desde = puntos[i];
    const hasta = puntos[i + 1];
    const r = reglas.find((x) => x.desde <= desde && x.hasta >= hasta) ?? null;
    const precioHora = r ? r.precioHora : base;
    const subtotal = precioHora * ((hasta - desde) / 60);
    total += subtotal;
    const previo = tramos[tramos.length - 1];
    if (previo && previo.regla === (r ? r.t : null)) {
      previo.hasta = hasta;
      previo.minutos += hasta - desde;
      previo.subtotal = redondear(previo.subtotal + subtotal);
    } else {
      tramos.push({ desde, hasta, minutos: hasta - desde, regla: r ? r.t : null, precioHora, subtotal: redondear(subtotal) });
    }
  }
  const aplicadas: Fila[] = [];
  tramos.forEach((tr) => {
    if (tr.regla && !aplicadas.includes(tr.regla)) aplicadas.push(tr.regla);
  });
  const totalFinal = redondear(total);
  const promos = aplicadas.filter((t) => tipoAjusteDeRegla(t) === TIPO_AJUSTE_DESCUENTO);
  const totalSinPromo =
    promos.length > 0
      ? cotizarReserva(horaInicio, duracion, reglas.map((r) => r.t).filter((t) => tipoAjusteDeRegla(t) !== TIPO_AJUSTE_DESCUENTO), base).total
      : totalFinal;
  return { total: totalFinal, totalBase, totalSinPromo, tramos, reglas: aplicadas, promos, conAjuste: aplicadas.length > 0 };
}

export function calcularPrecioReserva(horaInicio: string, duracionMinutos: number, listaTarifas: Fila[], precioBase: number): number {
  return cotizarReserva(horaInicio, duracionMinutos, listaTarifas, precioBase).total;
}

// -----------------------------------------------------------------------------
// Promoción de Segunda Hora (App-123/124, migraciones v130 + v131) — réplica
// EXACTA de App.jsx (`promoSegundaHoraDelClub` / `cotizarReservaConPromo`).
// • Solo la 2ª hora consecutiva (minutos 60–120) lleva el descuento; 1 h /
//   1.5 h a precio normal; 3 h o más: no se acumula, la 3ª en adelante normal.
// • Solo en las canchas participantes (vacío = todas) y si la reserva
//   COMPLETA cae dentro de la ventana Hora Inicio–Hora Fin (sin ventana =
//   todo el horario del club).
// -----------------------------------------------------------------------------
export const PROMO_SEGUNDA_HORA_MIN_DURACION = 120;

export interface PromoSegundaHora {
  activa: boolean;
  porcentaje: number;
  canchaIds: string[];
  horaInicio: string | null;
  horaFin: string | null;
}

export interface DesgloseSegundaHora {
  porcentaje: number;
  hora1: number;
  hora2: number;
  descuento: number;
  hora2ConDescuento: number;
  minutosRestantes: number;
  horasRestantes: number;
  totalAntesDescuento: number;
}

export interface CotizacionReservaConPromo extends CotizacionReserva {
  segundaHora: DesgloseSegundaHora | null;
}

export function normalizarPorcentajePromoSegundaHora(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** Canchas participantes como texto, sin vacíos ni repetidos ([] = todas). */
export function normalizarCanchasPromoSegundaHora(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  const ids = valor.filter((c) => c !== null && c !== undefined && String(c).trim() !== '').map((c) => String(c).trim());
  return Array.from(new Set(ids));
}

/** 'HH:MM' (acepta 'HH:MM:SS'); una hora FIN '00:00' = medianoche ('24:00'). */
export function normalizarHoraPromoSegundaHora(valor: unknown, esFin = false): string | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const min = parseHoraAMinutos(valor);
  if (min === null || min < 0 || min > 24 * 60) return null;
  return minutosAHora(esFin && min === 0 ? 24 * 60 : min);
}

/** Ventana válida solo con ambas horas e Inicio < Fin; si no, `null` (todo el día). */
export function ventanaPromoSegundaHora(horaInicio: unknown, horaFin: unknown): { horaInicio: string; horaFin: string } | null {
  const desde = normalizarHoraPromoSegundaHora(horaInicio);
  const hasta = normalizarHoraPromoSegundaHora(horaFin, true);
  if (!desde || !hasta || (parseHoraAMinutos(desde) as number) >= (parseHoraAMinutos(hasta) as number)) return null;
  return { horaInicio: desde, horaFin: hasta };
}

/** Fila de `configuracion_club` (o config camelCase, o su propio resultado) → promoción vigente. */
export function promoSegundaHoraDelClub(fuente: Fila | PromoSegundaHora | null | undefined): PromoSegundaHora {
  const f = fuente as Fila | null | undefined;
  const activaCruda = f?.promoSegundaHoraActiva ?? f?.promo_segunda_hora_activa ?? f?.activa;
  const porcentaje = normalizarPorcentajePromoSegundaHora(
    f?.promoSegundaHoraPorcentaje ?? f?.promo_segunda_hora_porcentaje ?? f?.porcentaje,
  );
  const canchaIds = normalizarCanchasPromoSegundaHora(f?.promoSegundaHoraCanchaIds ?? f?.promo_segunda_hora_cancha_ids ?? f?.canchaIds);
  const ventana = ventanaPromoSegundaHora(
    f?.promoSegundaHoraHoraInicio ?? f?.promo_segunda_hora_hora_inicio ?? f?.horaInicio,
    f?.promoSegundaHoraHoraFin ?? f?.promo_segunda_hora_hora_fin ?? f?.horaFin,
  );
  return {
    activa: activaCruda === true && porcentaje !== null,
    porcentaje: porcentaje ?? 0,
    canchaIds,
    horaInicio: ventana ? ventana.horaInicio : null,
    horaFin: ventana ? ventana.horaFin : null,
  };
}

/** ¿La promo está activa y participa esta cancha? */
export function promoSegundaHoraAplicaACancha(promo: Fila | PromoSegundaHora | null | undefined, canchaId: unknown): boolean {
  const p = promoSegundaHoraDelClub(promo);
  if (!p.activa) return false;
  return p.canchaIds.length === 0 || (canchaId !== null && canchaId !== undefined && p.canchaIds.includes(String(canchaId)));
}

/** ¿La reserva [inicioMin, finMin] cae completa dentro de la ventana? */
export function promoSegundaHoraCubreHorario(promo: Fila | PromoSegundaHora | null | undefined, inicioMin: number, finMin: number): boolean {
  const p = promoSegundaHoraDelClub(promo);
  if (!p.horaInicio || !p.horaFin) return true;
  return inicioMin >= (parseHoraAMinutos(p.horaInicio) as number) && finMin <= (parseHoraAMinutos(p.horaFin) as number);
}

export function cotizarReservaConPromo(
  horaInicio: string,
  duracionMinutos: number,
  listaTarifas: Fila[],
  precioBase: number,
  promo: Fila | PromoSegundaHora | null | undefined,
  canchaId: unknown = null,
): CotizacionReservaConPromo {
  const cotizacion = cotizarReserva(horaInicio, duracionMinutos, listaTarifas, precioBase);
  const config = promoSegundaHoraDelClub(promo);
  const duracion = Number(duracionMinutos) > 0 ? Number(duracionMinutos) : 60;
  const inicioMin = parseHoraAMinutos(horaInicio);
  if (
    !config.activa ||
    duracion < PROMO_SEGUNDA_HORA_MIN_DURACION ||
    inicioMin === null ||
    cotizacion.tramos.length === 0 ||
    !promoSegundaHoraAplicaACancha(config, canchaId) ||
    !promoSegundaHoraCubreHorario(config, inicioMin, inicioMin + duracion)
  ) {
    return { ...cotizacion, segundaHora: null };
  }
  const redondear = (n: number) => Math.round(n * 100) / 100;
  const costoEntre = (desde: number, hasta: number) =>
    redondear(
      cotizacion.tramos.reduce((acc, tr) => {
        const minutos = Math.min(tr.hasta, hasta) - Math.max(tr.desde, desde);
        return minutos > 0 ? acc + tr.precioHora * (minutos / 60) : acc;
      }, 0),
    );
  const hora1 = costoEntre(inicioMin, inicioMin + 60);
  const hora2 = costoEntre(inicioMin + 60, inicioMin + 120);
  const descuento = redondear(hora2 * (config.porcentaje / 100));
  if (!(descuento > 0)) return { ...cotizacion, segundaHora: null };
  const total = redondear(cotizacion.total - descuento);
  return {
    ...cotizacion,
    total,
    totalSinPromo: redondear(cotizacion.totalSinPromo),
    segundaHora: {
      porcentaje: config.porcentaje,
      hora1,
      hora2,
      descuento,
      hora2ConDescuento: redondear(hora2 - descuento),
      minutosRestantes: duracion - 120,
      horasRestantes: redondear(Math.max(0, cotizacion.total - hora1 - hora2)),
      totalAntesDescuento: cotizacion.total,
    },
  };
}

/** Duración base del bloque del club (`duracion_reserva_minutos`). */
export function duracionBaseDelClub(club: Fila): number {
  const cruda = Number(club?.duracion_reserva_minutos);
  return Number.isFinite(cruda) && cruda > 0 ? cruda : DURACION_RESERVA_DEFAULT_MIN;
}

/** Duraciones que el Portal ofrece: 60/120 si la base es 60 o 120; si no, solo la base. */
export function duracionesPermitidas(baseMin: number): number[] {
  if (baseMin === 60 || baseMin === 120) return [60, 120];
  return [baseMin];
}

/** Día de la semana (0 = domingo) de una fecha 'YYYY-MM-DD', sin depender de la zona del servidor. */
export function diaSemanaDeFecha(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * Cotización completa del bloque, igual que `cotizacionDelBloque` del Portal:
 * prorrateo por tramos + Promoción de Segunda Hora del club (App-123; canchas y horario App-124).
 */
export function cotizacionCancha(opciones: {
  cancha: Fila;
  club: Fila;
  tarifas: Fila[];
  fecha: string;
  horaInicio: string;
  duracionMin: number;
}): CotizacionReservaConPromo {
  const { cancha, club, tarifas, fecha, horaInicio, duracionMin } = opciones;
  const tarifasHabilitadas = club?.tarifas_habilitadas !== false;
  const delDia = tarifasHabilitadas ? tarifasActivasDelDia(tarifas, diaSemanaDeFecha(fecha), { fecha, canchaId: cancha?.id ?? null }) : [];
  return cotizarReservaConPromo(horaInicio, duracionMin, delDia, precioPorHoraDeCancha(cancha), promoSegundaHoraDelClub(club), cancha?.id ?? null);
}

/** Precio del bloque (lo que se cobra), igual que `cotizacionDelBloque(...).total` del Portal. */
export function costoCancha(opciones: {
  cancha: Fila;
  club: Fila;
  tarifas: Fila[];
  fecha: string;
  horaInicio: string;
  duracionMin: number;
}): number {
  return cotizacionCancha(opciones).total;
}

/** Fecha y minutos actuales en la zona del club. */
export function ahoraEnZona(zona: string, ahora: Date = new Date()): { fecha: string; minutos: number } {
  let partes: Intl.DateTimeFormatPart[];
  try {
    partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(ahora);
  } catch {
    return ahoraEnZona('America/Mexico_City', ahora);
  }
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '00';
  return { fecha: `${v('year')}-${v('month')}-${v('day')}`, minutos: Number(v('hour')) * 60 + Number(v('minute')) };
}

export interface ResultadoValidacion {
  ok: boolean;
  codigo?: string;
  error?: string;
  horaInicio?: string;
  horaFin?: string;
}

/** Reglas de horario del Portal: fecha/hora válidas, futuras, dentro del horario del club y duración permitida. */
export function validarSolicitudReserva(opciones: {
  fecha: unknown;
  horaInicio: unknown;
  duracionMin: unknown;
  club: Fila;
  ahora?: Date;
}): ResultadoValidacion {
  const { club } = opciones;
  const fecha = typeof opciones.fecha === 'string' ? opciones.fecha.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) {
    return { ok: false, codigo: 'datos_invalidos', error: 'Fecha inválida.' };
  }
  const horaTxt = typeof opciones.horaInicio === 'string' ? opciones.horaInicio.trim() : '';
  const inicio = /^\d{1,2}:\d{2}$/.test(horaTxt) ? parseHoraAMinutos(horaTxt) : null;
  if (inicio === null || inicio < 0 || inicio >= 24 * 60) return { ok: false, codigo: 'datos_invalidos', error: 'Hora inválida.' };
  const duracion = Number(opciones.duracionMin);
  if (!duracionesPermitidas(duracionBaseDelClub(club)).includes(duracion)) {
    return { ok: false, codigo: 'duracion_no_permitida', error: 'Esa duración no está disponible en este club.' };
  }
  const fin = inicio + duracion;
  const apertura = parseHoraAMinutos(club?.hora_apertura);
  const cierre = parseHoraAMinutos(club?.hora_cierre);
  const aperturaMin = apertura !== null ? apertura : HORA_INICIO_MIN;
  const cierreMin = cierre !== null && cierre > aperturaMin ? cierre : HORA_FIN_MIN;
  if (inicio < aperturaMin || fin > cierreMin) return { ok: false, codigo: 'fuera_de_horario', error: 'Ese horario está fuera del horario del club.' };
  const zona = typeof club?.zona_horaria === 'string' && club.zona_horaria ? club.zona_horaria : 'America/Mexico_City';
  const hoy = ahoraEnZona(zona, opciones.ahora);
  if (fecha < hoy.fecha || (fecha === hoy.fecha && inicio <= hoy.minutos)) {
    return { ok: false, codigo: 'horario_pasado', error: 'Ese horario ya pasó.' };
  }
  return { ok: true, horaInicio: minutosAHora(inicio), horaFin: minutosAHora(fin) };
}

/** slug del club (columna `slug` o derivado del nombre, como el Portal). */
export function slugDelClub(fila: Fila): string {
  const directo = typeof fila.slug === 'string' ? fila.slug.trim().toLowerCase() : '';
  if (directo) return directo;
  const nombre = typeof fila.nombre === 'string' ? fila.nombre : '';
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** ¿El club puede cobrar en línea? (Connect activo + cuenta válida). */
export function cuentaConectadaActiva(club: Fila): string | null {
  const cuenta = typeof club?.stripe_account_id === 'string' ? club.stripe_account_id : '';
  return club?.stripe_connect_enabled === true && /^acct_[A-Za-z0-9]+$/.test(cuenta) ? cuenta : null;
}

export function esTokenPortal(valor: unknown): valor is string {
  return typeof valor === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor);
}

export function centavos(monto: number): number {
  return Math.round(monto * 100);
}

export function urlConParametros(base: string, parametros: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(parametros)) u.searchParams.set(k, v);
  return u.toString().replace(/%7BCHECKOUT_SESSION_ID%7D/g, '{CHECKOUT_SESSION_ID}');
}

// =============================================================================
// v122 — Todos los módulos del Portal (Torneos, Retas, Academia, Tienda y
// Quick Sell en reservas). Réplica EXACTA de los cálculos del Portal
// (App.jsx: `precioDeReta`, `montoInscripcionTorneo`,
// `descuentoProntoPagoVigente`, `montoParaUnirseATorneo`, `inscribirseAClase`,
// `normalizarVarianteJSONB`, `productoIgnoraStockRigido`,
// `agregarAlCarritoPortal`). El servidor siempre los recalcula desde la BD.
// =============================================================================

export const CUPOS_RETA = 4;
export const PAQUETE_CREDITOS_DEFECTO = 4;
export const CANTIDAD_MAXIMA_ARTICULO = 99;
export const TIPOS_PAGO_PORTAL = ['reserva', 'torneo', 'torneo_union', 'reta', 'academia', 'tienda'] as const;
export type TipoPagoPortal = (typeof TIPOS_PAGO_PORTAL)[number];

export function esTipoPagoPortal(v: unknown): v is TipoPagoPortal {
  return typeof v === 'string' && (TIPOS_PAGO_PORTAL as readonly string[]).includes(v);
}

/** Redondeo a centavos (evita 0.1 + 0.2). */
export function redondear2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function precioDeReta(reta: Fila | null | undefined): number {
  if (!reta) return 0;
  const candidatos = [reta.precio_inscripcion, reta.costo_inscripcion, reta.precio_persona, reta.precio_individual, reta.precio, reta.costo];
  const encontrado = candidatos.find((c) => c !== null && c !== undefined && c !== '');
  return Number(encontrado) || 0;
}

export function descuentoProntoPagoVigente(torneo: Fila | null | undefined, fechaISO: string): number {
  const reglas = Array.isArray(torneo?.descuentos_pronto_pago) ? (torneo!.descuentos_pronto_pago as Fila[]) : [];
  const vigentes = reglas.filter(
    (r) => r?.fecha_inicio && r?.fecha_fin && fechaISO >= String(r.fecha_inicio) && fechaISO <= String(r.fecha_fin)
  );
  if (vigentes.length === 0) return 0;
  const maxPorcentaje = Math.max(...vigentes.map((r) => Number(r.porcentaje) || 0));
  return Math.min(100, Math.max(0, maxPorcentaje));
}

export type ModoPareja = 'ninguna' | 'sin' | 'nueva' | 'registrada';

export function montoInscripcionTorneo(torneo: Fila, pareja: { modo?: string } | null, fechaISO: string): number {
  const precioBase = Number(torneo?.precio) || 0;
  const incluyePareja = pareja?.modo === 'registrada' || pareja?.modo === 'nueva';
  const precioConPareja = incluyePareja && torneo?.unidad_precio === 'jugador' ? precioBase * 2 : precioBase;
  const descuentoPct = descuentoProntoPagoVigente(torneo, fechaISO);
  return descuentoPct > 0 ? Math.round(precioConPareja * (1 - descuentoPct / 100)) : precioConPareja;
}

/** Lo que le falta cubrir a quien se une a una inscripción "en busca de pareja". */
export function montoParaUnirseATorneo(torneo: Fila, participanteExistente: Fila, fechaISO: string): number {
  const montoEquipo = montoInscripcionTorneo(torneo, { modo: 'nueva' }, fechaISO);
  const montoYaCubierto = Number(participanteExistente?.monto) || 0;
  return Math.max(0, montoEquipo - montoYaCubierto);
}

export function precioClase(clase: Fila, tipoPago: string): number {
  return tipoPago === 'mensualidad' ? Number(clase?.precio_mensualidad) || 0 : Number(clase?.precio_clase_suelta) || 0;
}

/** ¿La fila ocupa lugar? (mismo criterio que `inscripcionOcupaLugar` / bajas de Academia). */
export function filaActiva(fila: Fila, tabla: 'torneo_participantes' | 'reta_inscripciones' | 'academia_alumnos'): boolean {
  if (tabla === 'academia_alumnos') return fila?.estado !== 'baja';
  return fila?.estado !== 'cancelado' && fila?.estado !== 'retenido';
}

/** Membresía de Academia vigente (`buscarMembresiaActivaDeJugador`). */
export function membresiaActiva(alumnos: Fila[], jugadorId: string, hoyISO: string): Fila | null {
  return (
    (alumnos || []).find(
      (a) =>
        String(a.jugador_id) === String(jugadorId) &&
        a.tipo_pago === 'mensualidad' &&
        (a.estado_pago ?? a.estatus_pago) === 'pagado' &&
        a.estado !== 'baja' &&
        Number(a.creditos_restantes) > 0 &&
        (!a.fecha_renovacion || String(a.fecha_renovacion) >= hoyISO)
    ) || null
  );
}

/** ¿El evento (fecha + hora en la zona del club) ya empezó? Sin fecha → no. */
export function eventoYaInicio(fecha: unknown, hora: unknown, zona: string, ahora: Date = new Date()): boolean {
  const f = typeof fecha === 'string' ? fecha.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const min = parseHoraAMinutos(hora ?? '00:00') ?? 0;
  const hoy = ahoraEnZona(zona, ahora);
  return f < hoy.fecha || (f === hoy.fecha && min <= hoy.minutos);
}

export function zonaDelClub(club: Fila): string {
  return typeof club?.zona_horaria === 'string' && club.zona_horaria ? club.zona_horaria : 'America/Mexico_City';
}

// ---------------------------------------------------------------------------
// Productos (Tienda y Quick Sell)
// ---------------------------------------------------------------------------
export interface VarianteNormalizada {
  id: string;
  nombre: string;
  precio: number | null;
  stock: number | null;
  activo: boolean;
  recibido: boolean;
}

function nombreDeVariante(v: Fila): string {
  const crudo = v?.nombre ?? v?.variante ?? v?.label ?? v?.nombre_variante ?? v?.id;
  return crudo == null ? '' : String(crudo).trim();
}

function claveStockVariante(v: Fila): string | null {
  if (v == null) return null;
  if (Object.prototype.hasOwnProperty.call(v, 'stock')) return 'stock';
  if (Object.prototype.hasOwnProperty.call(v, 'cantidad')) return 'cantidad';
  if (Object.prototype.hasOwnProperty.call(v, 'existencias')) return 'existencias';
  return null;
}

export function idEstableVariante(v: Fila, indice: number): string {
  if (v?.id != null && v.id !== '') return String(v.id);
  const nombre = nombreDeVariante(v);
  return nombre ? `var-${nombre.toLowerCase().replace(/\s+/g, '-')}` : `var-${indice}`;
}

export function normalizarVariante(v: Fila, indice: number): VarianteNormalizada {
  const clave = claveStockVariante(v);
  return {
    id: idEstableVariante(v, indice),
    nombre: nombreDeVariante(v) || `Variante ${indice + 1}`,
    precio: v?.precio != null ? Number(v.precio) : null,
    stock: clave ? Number(v[clave]) || 0 : null,
    activo: v?.activo !== false,
    recibido: v?.recibido !== false,
  };
}

/** Variantes que el Portal deja vender (activas y recibidas). */
export function variantesVendibles(producto: Fila): VarianteNormalizada[] {
  if (!Array.isArray(producto?.variantes)) return [];
  return (producto.variantes as Fila[]).map(normalizarVariante).filter((v) => v.activo !== false && v.recibido !== false);
}

export function productoIgnoraStock(producto: Fila): boolean {
  if (!producto) return false;
  if (producto.maneja_stock === false) return true;
  return producto.categoria === 'Cafetería/Bar' && producto.subcategoria === 'alimentos';
}

function productoVendible(p: Fila): boolean {
  return p?.disponible !== false && p?.recibido !== false;
}

/** Add-ons curados por el club (Quick Sell). Vacío si el switch está apagado. */
export function idsAddonsDelClub(club: Fila): Set<string> {
  if (club?.addons_habilitados === false) return new Set();
  const ids = Array.isArray(club?.productos_addons_ids) ? (club.productos_addons_ids as unknown[]) : [];
  return new Set(ids.map((id) => String(id)));
}

/**
 * Productos que se pueden cobrar en línea:
 *  - 'addons' (Quick Sell en la reserva): solo los curados por el club.
 *  - 'tienda' (carrito del Portal): Pro-Shop + los curados (el carrito también
 *    ofrece las sugerencias "Para ti").
 */
export function productoPermitido(producto: Fila, club: Fila, modo: 'addons' | 'tienda'): boolean {
  if (!producto || !productoVendible(producto)) return false;
  if (String(producto.club_id) !== String(club?.id)) return false;
  const curado = idsAddonsDelClub(club).has(String(producto.id));
  return modo === 'addons' ? curado : producto.categoria === 'Pro-Shop' || curado;
}

export interface SolicitudArticulo {
  producto_id: unknown;
  variante_id?: unknown;
  cantidad: unknown;
}

export interface ArticuloCobrado {
  tipo: 'producto';
  producto_id: string;
  variante_id: string | null;
  variante_nombre: string | null;
  es_variante: boolean;
  cancha_id: null;
  nombre: string;
  precio: number;
  cantidad: number;
  subtotal: number;
}

export type ResultadoArticulos =
  | { ok: true; items: ArticuloCobrado[]; subtotal: number }
  | { ok: false; codigo: string; error: string };

/**
 * Valida y cotiza los artículos contra la BD: producto del club y permitido,
 * variante obligatoria si el producto tiene variantes, cantidad entera 1..99 y
 * existencias suficientes (salvo productos sin control de stock). Junta
 * renglones repetidos del mismo producto/variante.
 */
export function cotizarArticulos(
  solicitud: unknown,
  productosPorId: Map<string, Fila>,
  club: Fila,
  modo: 'addons' | 'tienda'
): ResultadoArticulos {
  if (solicitud == null) return { ok: true, items: [], subtotal: 0 };
  if (!Array.isArray(solicitud)) return { ok: false, codigo: 'articulos_invalidos', error: 'Lista de artículos inválida.' };
  if (solicitud.length > 50) return { ok: false, codigo: 'articulos_invalidos', error: 'Demasiados artículos en una sola compra.' };
  const agrupados = new Map<string, { producto: Fila; variante: VarianteNormalizada | null; cantidad: number }>();
  for (const s of solicitud as SolicitudArticulo[]) {
    const productoId = s?.producto_id != null ? String(s.producto_id) : '';
    const producto = productosPorId.get(productoId);
    if (!producto || !productoPermitido(producto, club, modo)) {
      return { ok: false, codigo: 'producto_no_disponible', error: 'Uno de los artículos ya no está disponible.' };
    }
    const cantidad = Number(s?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > CANTIDAD_MAXIMA_ARTICULO) {
      return { ok: false, codigo: 'cantidad_invalida', error: `Cantidad inválida para ${String(producto.nombre ?? 'un artículo')}.` };
    }
    const variantes = variantesVendibles(producto);
    let variante: VarianteNormalizada | null = null;
    if (variantes.length > 0) {
      const varianteId = s?.variante_id != null ? String(s.variante_id) : '';
      variante = variantes.find((v) => v.id === varianteId) ?? null;
      if (!variante) return { ok: false, codigo: 'variante_invalida', error: `Elige una opción válida de ${String(producto.nombre ?? 'el producto')}.` };
    } else if (s?.variante_id != null && s.variante_id !== '') {
      return { ok: false, codigo: 'variante_invalida', error: `${String(producto.nombre ?? 'El producto')} no tiene esa opción.` };
    }
    const clave = `${productoId}|${variante?.id ?? ''}`;
    const previo = agrupados.get(clave);
    agrupados.set(clave, { producto, variante, cantidad: (previo?.cantidad ?? 0) + cantidad });
  }
  const items: ArticuloCobrado[] = [];
  for (const { producto, variante, cantidad } of agrupados.values()) {
    if (cantidad > CANTIDAD_MAXIMA_ARTICULO) {
      return { ok: false, codigo: 'cantidad_invalida', error: `Cantidad inválida para ${String(producto.nombre ?? 'un artículo')}.` };
    }
    const nombre = variante ? `${String(producto.nombre ?? 'Producto')} — ${variante.nombre}` : String(producto.nombre ?? 'Producto');
    if (!productoIgnoraStock(producto)) {
      const disponible = variante ? variante.stock : producto.maneja_stock === false || producto.stock == null ? null : Number(producto.stock);
      if (disponible != null && Number.isFinite(disponible) && cantidad > disponible) {
        return {
          ok: false,
          codigo: 'sin_stock',
          error: disponible > 0 ? `${nombre} solo tiene ${disponible} disponible(s).` : `${nombre} está agotado.`,
        };
      }
    }
    const precio = variante && variante.precio != null ? variante.precio : Number(producto.precio) || 0;
    if (!(precio > 0)) return { ok: false, codigo: 'producto_no_disponible', error: `${nombre} no tiene precio de venta.` };
    items.push({
      tipo: 'producto',
      producto_id: String(producto.id),
      variante_id: variante ? variante.id : null,
      variante_nombre: variante ? variante.nombre : null,
      es_variante: Boolean(variante),
      cancha_id: null,
      nombre,
      precio: redondear2(precio),
      cantidad,
      subtotal: redondear2(precio * cantidad),
    });
  }
  return { ok: true, items, subtotal: redondear2(items.reduce((acc, i) => acc + i.subtotal, 0)) };
}

/** Texto corto y seguro (nombres, categorías) para guardar en filas. */
export function textoCorto(v: unknown, max = 80): string | null {
  if (typeof v !== 'string') return null;
  const limpio = Array.from(v, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('').trim();
  return limpio ? limpio.slice(0, max) : null;
}

/** Teléfono a 10 dígitos (o null). */
export function telefonoLimpio(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = String(v).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/** Mensaje y status HTTP de los errores de retención (P0001 de v122). */
export function errorDeRetencion(mensaje: string): { codigo: string; error: string } | null {
  const mapa: Record<string, string> = {
    horario_ocupado: 'Ese horario se acaba de ocupar. Elige otro.',
    ya_inscrito: 'Ya tienes un lugar en este evento.',
    cupo_lleno: 'Ya no hay lugares disponibles.',
    pareja_completa: 'Esa pareja ya se completó.',
    evento_no_disponible: 'Ese evento ya no está disponible.',
  };
  for (const codigo of Object.keys(mapa)) {
    if (mensaje.includes(codigo)) return { codigo, error: mapa[codigo] };
  }
  return null;
}
