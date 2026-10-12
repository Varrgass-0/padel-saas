// =============================================================================
// Soporte & Acompañamiento — reglas de negocio y utilidades (funciones puras)
// =============================================================================
// La fuente de verdad de la bolsa vive en Supabase (migracion_v93). Este
// archivo replica las reglas SOLO para mostrarlas en pantalla y para validar
// antes de llamar al servidor; nunca decide cobros por su cuenta.

export const MINUTOS_POR_PLAN = { '1-3': 180, '4-7': 300, '8-12': 600 };
export const PRECIO_HORA_EXTRA_MXN = 350;
export const HORAS_EXTRA_OPCIONES = [1, 2, 3];
export const TOLERANCIA_MINUTOS = 10;
export const ANTICIPACION_CANCELACION_HORAS = 2;
export const PENALIZACION_CANCELACION_TARDIA = 0.5;
export const MINUTOS_MINIMOS_PARA_AGENDAR = 30;
export const VENTANA_APERTURA_SALA_MIN = 15;

// Mismo criterio que fn_soporte_minutos_plan (SQL): se toma el número mayor
// del rango ('1-3' → 3) y se asigna la bolsa.
export function minutosPlanDe(planCanchas) {
  const m = String(planCanchas ?? '').match(/(\d+)\s*$/);
  const max = m ? Number(m[1]) : null;
  if (!max || max <= 3) return 180;
  if (max <= 7) return 300;
  return 600;
}

// Política de cancelación: ≥ 2 h antes libera todo; < 2 h cobra el 50 %.
export function evaluarCancelacion(inicio, minutosReservados, ahora = new Date()) {
  const ms = new Date(inicio).getTime() - new Date(ahora).getTime();
  const horas = ms / 3_600_000;
  if (horas >= ANTICIPACION_CANCELACION_HORAS) {
    return { tardia: false, minutosCobrados: 0, mensaje: 'Cancelación anticipada: se liberan todos tus minutos.' };
  }
  const cobrados = Math.ceil((Number(minutosReservados) || 0) * PENALIZACION_CANCELACION_TARDIA);
  return {
    tardia: true,
    minutosCobrados: cobrados,
    mensaje: `Faltan menos de ${ANTICIPACION_CANCELACION_HORAS} h: se descontarán ${cobrados} min (50 %) de tu bolsa.`,
  };
}

// Estado de la "sala" de una cita agendada respecto a la tolerancia.
// 'pronto' (todavía no abre) | 'abierta' | 'vencida' (pasó la tolerancia).
export function estadoSalaCita(cita, ahora = new Date()) {
  if (!cita?.inicio) return 'pronto';
  const t = new Date(ahora).getTime();
  const inicio = new Date(cita.inicio).getTime();
  if (cita.conectado_en) {
    const fin = cita.fin ? new Date(cita.fin).getTime() : inicio + (Number(cita.minutos_reservados) || 30) * 60_000;
    return t <= fin + 30 * 60_000 ? 'abierta' : 'vencida';
  }
  if (t < inicio - VENTANA_APERTURA_SALA_MIN * 60_000) return 'pronto';
  if (t <= inicio + TOLERANCIA_MINUTOS * 60_000) return 'abierta';
  return 'vencida';
}

// Lectura de la bolsa tal como la devuelve fn_soporte_bolsa_actual.
export function resumenBolsa(bolsa) {
  const plan = Number(bolsa?.minutos_plan_mes) || 0;
  const consumidos = Number(bolsa?.minutos_consumidos_mes) || 0;
  const retenidos = Number(bolsa?.minutos_retenidos) || 0;
  const extra = Number(bolsa?.minutos_extra_saldo) || 0;
  const disponiblesCrudo = Number(bolsa?.minutos_disponibles_mes) || 0;
  const disponibles = Math.max(0, disponiblesCrudo);
  const total = plan + Math.max(0, extra);
  const usados = Math.max(0, total - disponibles);
  const porcentajeUsado = total > 0 ? Math.min(100, Math.round((usados / total) * 100)) : 0;
  return {
    plan,
    consumidos,
    retenidos,
    extra,
    disponibles,
    sobregiro: disponiblesCrudo < 0 ? Math.abs(disponiblesCrudo) : 0,
    total,
    usados,
    porcentajeUsado,
    saldoBajo: disponibles < MINUTOS_MINIMOS_PARA_AGENDAR,
    puedeAgendar30: disponibles >= 30,
    puedeAgendar60: disponibles >= 60,
  };
}

export function formatoMinutos(min) {
  const n = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export function formatoMXN(monto) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(monto) || 0);
}

export function formatoFechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatoFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

export const CANALES_SOPORTE = {
  videollamada: { label: 'Videollamada' },
  whatsapp: { label: 'WhatsApp' },
  llamada: { label: 'Llamada' },
  presencial: { label: 'Presencial' },
};

export const ESTADOS_TICKET = {
  agendada: { label: 'Agendada', clase: 'bg-sky-400/10 text-sky-500 ring-sky-400/30' },
  completada: { label: 'Completada', clase: 'bg-emerald-400/10 text-emerald-500 ring-emerald-400/30' },
  cancelada: { label: 'Cancelada', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' },
  cancelada_tardia: { label: 'Cancelación tardía', clase: 'bg-amber-400/10 text-amber-500 ring-amber-400/30' },
  no_show: { label: 'No asistió (No-Show)', clase: 'bg-rose-500/10 text-rose-500 ring-rose-500/30' },
};

// ---------------------------------------------------------------------------
// Variables de entorno (Vite) — todas opcionales; la UI avisa si faltan.
// ---------------------------------------------------------------------------
function leerEnv(nombre) {
  try {
    // @ts-ignore — import.meta.env lo inyecta Vite.
    const valor = import.meta.env?.[nombre];
    return typeof valor === 'string' ? valor.trim() : '';
  } catch (_e) {
    return '';
  }
}

export function configSoporte() {
  return {
    whatsappNumero: leerEnv('VITE_WHATSAPP_SUPPORT_NUMBER').replace(/\D/g, ''),
    calcomUrl30: leerEnv('VITE_CALCOM_URL_30'),
    calcomUrl60: leerEnv('VITE_CALCOM_URL_60'),
  };
}

export function enlaceWhatsAppSoporte({ numero, nombreClub, clubId, nombreUsuario }) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (!limpio) return null;
  const texto =
    `Hola equipo QLUBOS 👋, soy ${nombreUsuario || 'el administrador'} de ${nombreClub || 'mi club'}` +
    `${clubId ? ` (ID ${clubId})` : ''}. Necesito apoyo con: `;
  return `https://wa.me/${limpio}?text=${encodeURIComponent(texto)}`;
}

// URL del widget de Cal.com con el club identificado (metadata[club_id]) y
// los datos del contacto precargados. `embed` = true para iframe.
export function urlCalcom(base, { clubId, nombre, email, embed = true, tema = 'light' } = {}) {
  if (!base) return null;
  let url;
  try {
    url = new URL(base);
  } catch (_e) {
    return null;
  }
  if (embed) {
    url.searchParams.set('embed', 'true');
    url.searchParams.set('embedType', 'inline');
    url.searchParams.set('theme', tema);
  }
  if (nombre) url.searchParams.set('name', nombre);
  if (email) url.searchParams.set('email', email);
  if (clubId != null) url.searchParams.set('metadata[club_id]', String(clubId));
  return url.toString();
}

// Enlaces de Cal.com para cancelar/reagendar una reserva existente.
export function enlacesGestionCalcom(base, uid) {
  if (!uid) return { cancelar: null, reagendar: null };
  let origen = 'https://cal.com';
  try {
    if (base) origen = new URL(base).origin;
  } catch (_e) {
    /* origen por defecto */
  }
  return {
    cancelar: `${origen}/booking/${encodeURIComponent(uid)}?cancel=true`,
    reagendar: `${origen}/reschedule/${encodeURIComponent(uid)}`,
  };
}

export function urlSeguraHttp(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

// ---------------------------------------------------------------------------
// Agenda del SuperAdmin
// ---------------------------------------------------------------------------
// Grupo de una cita en la agenda: 'proximas' | 'completadas' | 'canceladas'
// (canceladas incluye cancelación tardía y No-Show).
export function grupoAgenda(ticket) {
  if (ticket?.estado === 'agendada') return 'proximas';
  if (ticket?.estado === 'completada') return 'completadas';
  return 'canceladas';
}

export function duracionCitaMin(ticket) {
  const reservado = Number(ticket?.minutos_reservados) || 0;
  if (reservado > 0) return reservado;
  if (ticket?.inicio && ticket?.fin) {
    const m = Math.round((new Date(ticket.fin).getTime() - new Date(ticket.inicio).getTime()) / 60000);
    if (m > 0) return m;
  }
  return 30;
}

// Reunión "en curso" o "por empezar" (faltan ≤ 15 min) entre las citas
// agendadas. Devuelve la más próxima, o null.
export function reunionDestacada(tickets, ahora = new Date()) {
  const t = new Date(ahora).getTime();
  const candidatas = (tickets || [])
    .filter((x) => x?.estado === 'agendada' && x.inicio)
    .map((x) => {
      const inicio = new Date(x.inicio).getTime();
      const fin = x.fin ? new Date(x.fin).getTime() : inicio + duracionCitaMin(x) * 60000;
      return { ticket: x, inicio, fin };
    })
    .filter(({ inicio, fin }) => t >= inicio - VENTANA_APERTURA_SALA_MIN * 60000 && t <= fin)
    .sort((a, b) => a.inicio - b.inicio);
  if (!candidatas.length) return null;
  const { ticket, inicio } = candidatas[0];
  const minutosParaInicio = Math.ceil((inicio - t) / 60000);
  return { ticket, enCurso: t >= inicio, minutosParaInicio: Math.max(0, minutosParaInicio), total: candidatas.length };
}

// Etiqueta de día para agrupar la agenda ("Hoy", "Mañana", "lunes 14 de octubre").
export function etiquetaDiaAgenda(iso, ahora = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Sin fecha';
  const base = new Date(ahora);
  const clave = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const manana = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  const ayer = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);
  if (clave(d) === clave(base)) return 'Hoy';
  if (clave(d) === clave(manana)) return 'Mañana';
  if (clave(d) === clave(ayer)) return 'Ayer';
  const txt = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

export function formatoHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
}

export function formatoMinutosConSigno(min) {
  const n = Math.round(Number(min) || 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatoMinutos(Math.abs(n))}`;
}
