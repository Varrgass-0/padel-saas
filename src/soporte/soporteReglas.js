
/
MacBook Neo de Jimena, Conectado
Creó 2 archivos, compartió 3 archivos, y 30 pasos más
Listo: cancelar o reagendar en Cal.com ya actualiza la cita, el historial y las horas del club sin recargar la página. Probé las reglas de cobro en un Postgres local y la pantalla del club con Cal.com simulado. No pude probarlo contra Cal.com real: falta confirmar que su página de cancelar/reagendar abra dentro de QLUBOS, y que su API marque la cita original como reagendada y dé el identificador de la nueva.

Para activarlo:

Corre migracion_v101_soporte_cancelar_reagendar.sql en Supabase.
Despliega dos funciones de Supabase, la nueva soporte-calcom-estado y la versión actualizada de soporte-calcom-webhook.
En Cal.com, revisa que el webhook tenga marcados Booking Cancelled y Booking Rescheduled.
1. Retorno desde Cal.com. Cal.com no ofrece una redirección de regreso al cancelar, así que no podía depender de esa URL. En su lugar:

“Cancelar” y “Reagendar” ahora abren Cal.com en una ventana dentro de QLUBOS.
QLUBOS confirma el cambio consultando a Cal.com cuando el club cierra esa ventana, cuando regresa a la pestaña o cuando Cal.com avisa que reagendó.
Con esa respuesta actualiza Supabase al instante. Solo consulta citas del propio club.
También dejé lista una URL de retorno, /soporte?calcom=retorno&uid=…, por si quieres usarla en Cal.com. No es necesaria para que funcione.
Si Cal.com no carga dentro de la ventana, hay un enlace para abrirlo en otra pestaña; al volver a QLUBOS se confirma igual.
2. Pantalla de Soporte.

Próximas citas: la cita sale en cuanto se confirma el cambio. Si es reagendada, la nueva fecha aparece en Próximas.
Historial de reuniones: la cita entra como “Cancelada”, “Cancelación tardía” o “Reagendada”. “Reagendada” es un estatus nuevo; antes la cita solo cambiaba de horario y no quedaba registro.
Minutos: se aplica la regla de anticipación también al reagendar: con 2 h o más vuelve el 100 %, con menos se cobra el 50 %. La ventana avisa el costo antes de confirmar.
Tarjetas de horas: Horas disponibles, Consumido y Retenido se actualizan solas, y aparece un aviso con los minutos devueltos.
Si el club cierra la ventana sin cambiar nada, la cita deja de aparecer “en espera”.
3. Webhook de respaldo. El webhook ya recibía Booking Cancelled y Booking Rescheduled; lo ajusté para el nuevo historial.

Si el club cierra todo sin volver a QLUBOS, el webhook hace el cambio y la pantalla se entera en tiempo real.
Si el webhook y el retorno llegan los dos, la cita no se cobra dos veces.
Si Cal.com avisa “cancelada” antes que “reagendada”, la cita se corrige a reagendada.
Para la confirmación inmediata necesitas la clave de la API de Cal.com (CALCOM_API_KEY); la sincronización actual ya la usa. Sin ella, el cambio llega por el webhook en segundos.

En “Claude outputs” quedaron soporte-cancelar-reagendar-v105.zip, Soporte.jsx y la migración v101. El zip también incluye los cambios en soporteReglas.js, soporteApi.js y un ajuste menor en AdminSoporte.jsx para el nuevo estatus. Agregué estos pasos a SOPORTE_SETUP.md y guardé esa guía en el proyecto.


Soporte cancelar reagendar v105
ZIP 

Soporte
Código·JSX 

Migracion v101 soporte cancelar reagendar
Código·SQL 

Soporte setup
Documento·MD 
De aqui en adelante no me des los archivos en zip, dame los que haya tenido modificaciones y dame los archivos individuales, omite darme el documento setup, gracias

Compartió 5 archivos, usó Computer, guardó archivos en tu computadora
Entendido: a partir de ahora te entrego solo los archivos que cambien, uno por uno, sin zip ni documentos de setup.

Para que no te falte nada del cambio anterior, ya te mandé por separado los archivos que solo venían dentro del zip:

soporteReglas.js
soporteApi.js
AdminSoporte.jsx
Las dos funciones de Supabase. Ambas se llaman index.ts, así que en “Claude outputs” las dejé en carpetas separadas, supabase/functions/soporte-calcom-estado/ y supabase/functions/soporte-calcom-webhook/, para que no se sobrescriban.
Soporte.jsx y la migración v101 ya te los había enviado sueltos.

En esta sesión no tengo dónde guardar esta preferencia de forma permanente. Si en una conversación nueva vuelvo a mandar un zip, basta con recordármelo.


Soportereglas
JS 

Soporteapi
JS 

Adminsoporte
Código·JSX 

Index
TS 

Index
TS 



Claude es una IA y puede cometer errores.
Soportereglas · JS
// =============================================================================
// Soporte — reglas de negocio y utilidades (funciones puras)
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
 
// Canal único actual: videollamada. Las demás etiquetas se conservan solo
// para mostrar correctamente registros históricos.
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
  // v101: la cita original de una reunión reagendada en Cal.com.
  reagendada: { label: 'Reagendada', clase: 'bg-violet-400/10 text-violet-500 ring-violet-400/30' },
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
    calcomUrl30: leerEnv('VITE_CALCOM_URL_30'),
    calcomUrl60: leerEnv('VITE_CALCOM_URL_60'),
  };
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
 
// Concepto visible de una reunión. El webhook de Cal.com guarda
// "Videollamada de soporte" cuando la reserva no trae notas: se muestra con
// el nombre estándar "Reunión de soporte".
export function conceptoReunion(ticket) {
  const c = String(ticket?.concepto || '').trim();
  if (!c || /^videollamada de soporte$/i.test(c)) return 'Reunión de soporte';
  return c;
}
 
// Concilia "Retenido en citas" con la lista real de citas agendadas: si la
// foto de la bolsa del servidor todavía no refleja una cita recién creada
// (o ya cerrada), se corrige retenido y disponible en pantalla al instante.
export function conciliarRetenido(bolsa, tickets) {
  if (!bolsa || !Array.isArray(tickets)) return bolsa;
  const retenidoCitas = tickets
    .filter((t) => t?.estado === 'agendada')
    .reduce((suma, t) => suma + (Number(t.minutos_reservados) || 0), 0);
  const retenidoServidor = Number(bolsa.minutos_retenidos) || 0;
  if (retenidoCitas === retenidoServidor) return bolsa;
  return {
    ...bolsa,
    minutos_retenidos: retenidoCitas,
    minutos_disponibles_mes: (Number(bolsa.minutos_disponibles_mes) || 0) - (retenidoCitas - retenidoServidor),
  };
}
 
// ---------------------------------------------------------------------------
// Cal.com → datos de la reserva a partir del postMessage del iframe
// ---------------------------------------------------------------------------
// Cal.com (iframe con ?embed=true) avisa al portal con mensajes
// { originator: 'CAL', type/fullType: 'bookingSuccessful' | 'bookingSuccessfulV2', data }.
// Devuelve { uid, inicio, fin, concepto, meetUrl } o null si el mensaje no es
// una reserva confirmada o le falta el uid (sin uid no se registra para no
// duplicar con el webhook).
export function esMensajeReservaCal(datos) {
  if (!datos || typeof datos !== 'object') return false;
  const tipo = `${datos.type || ''} ${datos.method || ''} ${datos.fullType || ''}`;
  return /bookingSuccessful/i.test(tipo);
}
 
export function extraerReservaCal(datos, duracionRespaldoMin = 30) {
  if (!esMensajeReservaCal(datos)) return null;
  const d = datos.data && typeof datos.data === 'object' ? datos.data : {};
  const b = d.booking && typeof d.booking === 'object' ? d.booking : d;
  const uid = String(b.uid || d.uid || '').trim();
  const inicioCrudo = b.startTime || b.start || d.startTime || d.start || d.date || null;
  if (!uid || !inicioCrudo) return null;
  const inicio = new Date(inicioCrudo);
  if (Number.isNaN(inicio.getTime())) return null;
  const finCrudo = b.endTime || b.end || d.endTime || d.end || null;
  let fin = finCrudo ? new Date(finCrudo) : null;
  if (!fin || Number.isNaN(fin.getTime()) || fin <= inicio) {
    const dur = Number(d.duration || b.duration || d.eventType?.length || duracionRespaldoMin) || 30;
    fin = new Date(inicio.getTime() + dur * 60000);
  }
  const candidatosMeet = [b.videoCallUrl, b.meetingUrl, b.metadata?.videoCallUrl, d.videoCallUrl, b.location];
  const meetUrl = candidatosMeet.find((u) => typeof u === 'string' && /^https:\/\//i.test(u)) || null;
  const notas = b.responses?.notes;
  const concepto = String(b.description || (typeof notas === 'string' ? notas : notas?.value) || '').trim() || null;
  return { uid, inicio: inicio.toISOString(), fin: fin.toISOString(), concepto, meetUrl };
}
 
// ---------------------------------------------------------------------------
// Calendario mensual (SuperAdmin)
// ---------------------------------------------------------------------------
export const NOMBRES_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const DIAS_SEMANA_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
 
export function claveDiaLocal(fecha) {
  const d = new Date(fecha);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
 
// 6 semanas (42 días) que cubren el mes, empezando en domingo. Hora local.
export function diasCuadriculaMes(anio, mes) {
  const primero = new Date(anio, mes, 1);
  const inicio = new Date(anio, mes, 1 - primero.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const fecha = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
    return { fecha, clave: claveDiaLocal(fecha), delMes: fecha.getMonth() === mes };
  });
}
 
// Rango [desde, hasta) en ISO para consultar las citas de la cuadrícula.
export function rangoCuadriculaMes(anio, mes) {
  const dias = diasCuadriculaMes(anio, mes);
  const desde = dias[0].fecha;
  const ultimo = dias[dias.length - 1].fecha;
  const hasta = new Date(ultimo.getFullYear(), ultimo.getMonth(), ultimo.getDate() + 1);
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}
 
export function agruparCitasPorDia(citas) {
  const mapa = new Map();
  (citas || []).forEach((c) => {
    if (!c?.inicio) return;
    const k = claveDiaLocal(c.inicio);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(c);
  });
  mapa.forEach((lista) => lista.sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime()));
  return mapa;
}
 
// ---------------------------------------------------------------------------
// Cancelar / Reagendar en Cal.com — retorno a QLUBOS (v101)
// ---------------------------------------------------------------------------
// Cuando el club abre "Cancelar" o "Reagendar", se recuerda la acción (en
// sessionStorage, por pestaña) para verificarla con Cal.com en cuanto vuelva
// a QLUBOS: al cerrar la ventana de gestión, al regresar a la pestaña o al
// volver por la URL de retorno. Caduca a los 30 min (el webhook sigue
// actualizando la cita aunque ya no se espere aquí).
const LS_ACCIONES_CALCOM = 'qlubos_soporte_acciones_calcom_v1';
const VIGENCIA_ACCION_CALCOM_MS = 30 * 60_000;
 
export function leerAccionesCalcomPendientes() {
  try {
    const crudo = JSON.parse(window.sessionStorage.getItem(LS_ACCIONES_CALCOM) || '{}');
    const ahora = Date.now();
    const vigentes = {};
    Object.entries(crudo && typeof crudo === 'object' ? crudo : {}).forEach(([uid, a]) => {
      if (a && ahora - Number(a.desde || 0) < VIGENCIA_ACCION_CALCOM_MS) vigentes[uid] = a;
    });
    return vigentes;
  } catch (_e) {
    return {};
  }
}
 
function guardarAccionesCalcom(acciones) {
  try {
    window.sessionStorage.setItem(LS_ACCIONES_CALCOM, JSON.stringify(acciones));
  } catch (_e) {
    /* sin almacenamiento: la verificación al cerrar la ventana sigue funcionando */
  }
}
 
export function registrarAccionCalcomPendiente(uid, accion, ticketId = null) {
  if (!uid) return leerAccionesCalcomPendientes();
  const acciones = { ...leerAccionesCalcomPendientes(), [uid]: { accion, ticketId, desde: Date.now() } };
  guardarAccionesCalcom(acciones);
  return acciones;
}
 
export function quitarAccionCalcomPendiente(uid) {
  const acciones = { ...leerAccionesCalcomPendientes() };
  delete acciones[uid];
  guardarAccionesCalcom(acciones);
  return acciones;
}
 
// Parámetros de la URL de retorno desde Cal.com (/soporte?calcom=retorno&…).
// Acepta los nombres que usa Cal.com al reenviar parámetros y los propios.
export function leerRetornoCalcom(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch (_e) {
    return null;
  }
  const marca = params.get('calcom') || params.get('calcom_retorno') || params.get('calcom_accion');
  const uids = ['calcom_uid', 'uid', 'bookingUid', 'rescheduleUid', 'rescheduledFromUid', 'fromReschedule']
    .map((k) => String(params.get(k) || '').trim())
    .filter((u) => u && u.length <= 200);
  if (!marca && uids.length === 0) return null;
  const claves = ['calcom', 'calcom_retorno', 'calcom_accion', 'calcom_uid', 'uid', 'bookingUid', 'rescheduleUid', 'rescheduledFromUid',
    'fromReschedule', 'isRescheduling', 'cancelled', 'email', 'name', 'title', 'startTime', 'endTime', 'eventTypeSlug'];
  return { accion: params.get('calcom_accion') || null, uids: [...new Set(uids)], claves };
}
 
// Mensajes de la ventana embebida de Cal.com al reagendar / cancelar.
export function tipoMensajeGestionCal(datos) {
  if (!datos || typeof datos !== 'object') return null;
  const tipo = `${datos.type || ''} ${datos.method || ''} ${datos.fullType || ''}`;
  if (/rescheduleBookingSuccessful/i.test(tipo)) return 'reagendada';
  if (/bookingCancel/i.test(tipo)) return 'cancelada';
  return null;
}
 
// Minutos que vuelven al saldo cuando una cita sale de "Próximas".
export function minutosLiberadosCita(ticket) {
  const reservados = Number(ticket?.minutos_reservados) || 0;
  const cobrados = Number(ticket?.minutos_consumidos) || 0;
  return { liberados: Math.max(0, reservados - cobrados), cobrados };
}
 
// Enlace de gestión para abrir DENTRO de QLUBOS (ventana embebida).
export function urlEmbebidaCal(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('embed', 'true');
    return u.toString();
  } catch (_e) {
    return null;
  }
}
 
Claude terminó la respuesta

