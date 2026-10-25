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

export function tarifasActivasDelDia(listaTarifas: Fila[] | null | undefined, diaSemana: number): Fila[] {
  return (Array.isArray(listaTarifas) ? listaTarifas : []).filter((t) => {
    if (esTarifaDeAcademia(t)) return false;
    if (t?.activo === false) return false;
    const dias = Array.isArray(t?.dias_semana) ? (t.dias_semana as unknown[]) : null;
    return !dias || dias.length === 0 || dias.includes(diaSemana);
  });
}

export function calcularPrecioReserva(horaInicio: string, duracionMinutos: number, listaTarifas: Fila[], precioBase: number): number {
  const inicioMin = parseHoraAMinutos(horaInicio);
  const duracion = Number(duracionMinutos) > 0 ? Number(duracionMinutos) : 60;
  const base = Number(precioBase) > 0 ? Number(precioBase) : 0;
  let precioHora = base;
  if (inicioMin !== null) {
    const finMin = inicioMin + duracion;
    const franja = (Array.isArray(listaTarifas) ? listaTarifas : []).find((t) => {
      const desde = parseHoraAMinutos(t?.hora_inicio ?? t?.horaInicio);
      const hasta = parseHoraAMinutos(t?.hora_fin ?? t?.horaFin);
      if (desde === null || hasta === null) return false;
      return inicioMin >= desde && finMin <= hasta;
    });
    const precioFranja = franja ? Number(franja.precio_hora ?? franja.precioHora) : null;
    if (precioFranja !== null && Number.isFinite(precioFranja) && precioFranja > 0) precioHora = precioFranja;
  }
  return Math.round(precioHora * (duracion / 60) * 100) / 100;
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

/** Precio del bloque, igual que `precioDelBloque` del Portal. */
export function costoCancha(opciones: {
  cancha: Fila;
  club: Fila;
  tarifas: Fila[];
  fecha: string;
  horaInicio: string;
  duracionMin: number;
}): number {
  const { cancha, club, tarifas, fecha, horaInicio, duracionMin } = opciones;
  const tarifasHabilitadas = club?.tarifas_habilitadas !== false;
  const delDia = tarifasHabilitadas ? tarifasActivasDelDia(tarifas, diaSemanaDeFecha(fecha)) : [];
  const base = precioPorHoraDeCancha(cancha);
  const permiteDosHoras = duracionesPermitidas(duracionBaseDelClub(club)).includes(120);
  if (permiteDosHoras && duracionMin === 120) {
    const segunda = minutosAHora((parseHoraAMinutos(horaInicio) ?? 0) + 60);
    return Math.round((calcularPrecioReserva(horaInicio, 60, delDia, base) + calcularPrecioReserva(segunda, 60, delDia, base)) * 100) / 100;
  }
  return calcularPrecioReserva(horaInicio, duracionMin, delDia, base);
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
