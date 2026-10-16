// =============================================================================
// Soporte — Vista del CLUB (/soporte)
// Visible para Owner / Admin del club. Horas de soporte del mes, videollamada
// (Cal.com + Google Calendar/Meet, canal único), próximas citas e historial.
// Sin botón "Actualizar": todo se refresca solo con Supabase Realtime.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LifeBuoy,
  Video,
  CalendarClock,
  Clock,
  CreditCard,
  ExternalLink,
  AlertTriangle,
  Loader2,
  Info,
  Lock,
} from 'lucide-react';
import {
  ESTADOS_TICKET,
  TOLERANCIA_MINUTOS,
  ANTICIPACION_CANCELACION_HORAS,
  configSoporte,
  enlacesGestionCalcom,
  estadoSalaCita,
  evaluarCancelacion,
  formatoFecha,
  formatoFechaHora,
  formatoMinutos,
  formatoMXN,
  resumenBolsa,
  urlSeguraHttp,
  conceptoReunion,
  conciliarRetenido,
  extraerReservaCal,
  esMensajeReservaCal,
  leerAccionesCalcomPendientes,
  registrarAccionCalcomPendiente,
  quitarAccionCalcomPendiente,
  leerRetornoCalcom,
  tipoMensajeGestionCal,
  minutosLiberadosCita,
  urlEmbebidaCal,
} from './soporteReglas';
import {
  obtenerBolsa,
  listarTickets,
  listarComprasExtra,
  listarAjustes,
  listarCitasProximas,
  registrarCitaPortal,
  sincronizarCalcom,
  registrarConexion,
  suscribirCambiosSoporte,
  obtenerUsuarioActual,
  mensajeError,
  esErrorEsquemaSoporte,
  verificarCitasCalcom,
  cancelarCitaDesdePortal,
} from './soporteApi';
import { ModalComprarHorasExtra, ModalAgendarVideollamada, ModalSoporte } from './SoporteModal';

// Lectura de variables de entorno de Vite tolerante (sin `import.meta.env`
// definido, p. ej. en pruebas, devuelve '').
function leerEnvSoporte(nombre) {
  try {
    // @ts-ignore — import.meta.env lo inyecta Vite.
    const valor = import.meta.env?.[nombre];
    return typeof valor === 'string' ? valor.trim() : '';
  } catch (_e) {
    return '';
  }
}

// URLs de Cal.com con respaldo: además de VITE_CALCOM_URL_30 / _60 acepta
// una sola VITE_CALCOM_URL (ej. https://cal.com/qlubos) y arma los eventos
// `soporte-30` / `soporte-60`. Nunca se mezcla una duración con la otra.
export function resolverConfigCalcom() {
  const base = configSoporte();
  const raiz = leerEnvSoporte('VITE_CALCOM_URL').replace(/\/+$/, '');
  return {
    ...base,
    calcomUrl30: base.calcomUrl30 || (raiz ? `${raiz}/soporte-30` : ''),
    calcomUrl60: base.calcomUrl60 || (raiz ? `${raiz}/soporte-60` : ''),
  };
}

export function BadgeEstadoTicket({ estado }) {
  const meta = ESTADOS_TICKET[estado] || { label: estado || '—', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${meta.clase}`}>{meta.label}</span>;
}

export function WidgetBolsaHoras({ bolsa, onComprar, compacto = false }) {
  const r = resumenBolsa(bolsa);
  const colorBarra = r.porcentajeUsado >= 90 ? 'bg-rose-500' : r.porcentajeUsado >= 70 ? 'bg-amber-400' : 'bg-orange-400';
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Horas de soporte</p>
          <p className="mt-1 text-3xl font-black text-slate-900">
            {formatoMinutos(r.disponibles)}
            <span className="ml-2 text-sm font-semibold text-slate-500">disponibles de {formatoMinutos(r.total)}</span>
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p className="font-semibold">Se renueva el</p>
          <p className="text-sm font-black text-slate-900">{formatoFecha(bolsa?.ciclo_fin)}</p>
        </div>
      </div>

      <div className="mt-4">
        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200/80" role="progressbar" aria-valuenow={r.porcentajeUsado} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all duration-500 ${colorBarra}`} style={{ width: `${r.porcentajeUsado}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] font-semibold text-slate-500">{r.porcentajeUsado}% utilizado este ciclo</p>
      </div>

      {!compacto && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Dato etiqueta="Plan del mes" valor={formatoMinutos(r.plan)} />
          <Dato etiqueta="Consumido del plan" valor={formatoMinutos(r.consumidos)} />
          <Dato etiqueta="Retenido en citas" valor={formatoMinutos(r.retenidos)} />
          <Dato etiqueta="Extra y bonificaciones" valor={formatoMinutos(Math.max(0, r.extra))} />
        </div>
      )}

      {r.sobregiro > 0 && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-600">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> Tus citas agendadas superan tu saldo por {formatoMinutos(r.sobregiro)}.
        </p>
      )}

      {onComprar &&
        (r.saldoBajo ? (
          <button
            type="button"
            onClick={onComprar}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-400 px-4 py-3 text-sm font-black text-slate-950 transition hover:bg-orange-300 sm:w-auto"
          >
            <CreditCard size={16} /> + Comprar horas extra
          </button>
        ) : (
          <button type="button" onClick={onComprar} className="mt-4 text-xs font-bold text-orange-500 hover:underline">
            ¿Necesitas más tiempo? + Comprar horas extra
          </button>
        ))}
    </div>
  );
}

function Dato({ etiqueta, valor }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{etiqueta}</p>
      <p className="text-sm font-black text-slate-900">{valor}</p>
    </div>
  );
}

export function TablaHistorialSoporte({ tickets, onAjustar }) {
  if (!tickets?.length) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        Aún no hay atenciones registradas.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="w-full min-w-[620px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Fecha</th>
            <th className="px-4 py-2.5 font-semibold">Concepto</th>
            <th className="px-4 py-2.5 text-right font-semibold">Minutos</th>
            <th className="px-4 py-2.5 font-semibold">Estatus</th>
            <th className="px-4 py-2.5 font-semibold">Meet</th>
            {onAjustar && <th className="px-4 py-2.5" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {tickets.map((t) => {
            const meet = urlSeguraHttp(t.meet_url);
            return (
              <tr key={t.id} className="text-slate-700">
                <td className="whitespace-nowrap px-4 py-2.5 text-xs">{formatoFechaHora(t.inicio || t.creado_en)}</td>
                <td className="max-w-[260px] truncate px-4 py-2.5 text-xs" title={conceptoReunion(t)}>
                  {conceptoReunion(t)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs font-bold text-slate-900">
                  {t.estado === 'agendada' ? (
                    <span className="font-semibold text-slate-500">{formatoMinutos(t.minutos_reservados)} retenidos</span>
                  ) : (
                    formatoMinutos(t.minutos_consumidos)
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <BadgeEstadoTicket estado={t.estado} />
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {meet ? (
                    <a href={meet} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-orange-500 hover:underline">
                      Abrir <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                {onAjustar && (
                  <td className="px-4 py-2.5 text-right">
                    <button type="button" onClick={() => onAjustar(t)} className="rounded-md px-2 py-1 text-[11px] font-bold text-orange-500 hover:bg-orange-400/10">
                      Ajustar
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TarjetaProximaCita({ cita, ahora, calcomBase, onUnirme, uniendose, pendiente, onGestionar, onVerificar, onDescartar, verificando }) {
  const sala = estadoSalaCita(cita, ahora);
  const meet = urlSeguraHttp(cita.meet_url);
  const gestion = enlacesGestionCalcom(calcomBase, cita.calcom_uid);
  const politica = evaluarCancelacion(cita.inicio, cita.minutos_reservados, ahora);
  const fecha = cita.inicio ? new Date(cita.inicio) : null;
  const fechaLarga = fecha ? fecha.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
  const fechaTexto = fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1);
  const horaTexto = fecha ? fecha.toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }) : '—';
  const enRevision = sala === 'vencida';
  return (
    <div className={`flex flex-col gap-3 rounded-2xl border bg-white p-4 sm:flex-row sm:items-center sm:justify-between ${sala === 'abierta' ? 'border-emerald-500/50 ring-1 ring-emerald-500/30' : 'border-slate-200'}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-orange-400/10 text-orange-500">
          <span className="text-[10px] font-bold uppercase leading-none">{fecha ? fecha.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '') : ''}</span>
          <span className="text-lg font-black leading-none">{fecha ? fecha.getDate() : '—'}</span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-900" title={conceptoReunion(cita)}>
            {conceptoReunion(cita)}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            <span>{fechaTexto}</span> · <span className="font-bold text-slate-900">{horaTexto}</span> ·{' '}
            {formatoMinutos(cita.minutos_reservados)}
          </p>
          {pendiente ? (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-violet-600">
              <Loader2 size={11} className="animate-spin" />
              {pendiente.accion === 'reagendar' ? 'Reagendando en Cal.com…' : 'Cancelando en Cal.com…'} se actualizará al confirmarse.
              <button type="button" onClick={() => onVerificar?.(cita)} disabled={verificando} className="font-bold text-orange-500 hover:underline disabled:opacity-50">
                {verificando ? 'Verificando…' : 'Ya lo hice, verificar'}
              </button>
              <button type="button" onClick={() => onDescartar?.(cita)} className="font-semibold text-slate-400 hover:text-slate-600">
                Descartar
              </button>
            </p>
          ) : enRevision ? (
            <p className="mt-1 text-[11px] font-semibold text-slate-500">Reunión finalizada: soporte está registrando los minutos usados.</p>
          ) : (
            sala !== 'abierta' &&
            gestion.cancelar && <p className={`mt-1 text-[11px] font-semibold ${politica.tardia ? 'text-amber-600' : 'text-slate-500'}`}>{politica.mensaje}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {meet && !enRevision && (
          <button
            type="button"
            onClick={() => onUnirme(cita)}
            disabled={uniendose || sala !== 'abierta'}
            title={sala === 'pronto' ? 'Se habilita 15 minutos antes de la reunión' : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-black text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uniendose ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />} Unirme a Google Meet
          </button>
        )}
        {sala === 'pronto' && meet && <span className="text-[11px] font-semibold text-slate-500">Se habilita 15 min antes</span>}
        {sala === 'pronto' && !meet && <span className="text-[11px] font-semibold text-slate-500">El enlace de Meet llega en tu correo de confirmación</span>}
        {sala === 'pronto' && gestion.reagendar && (
          <button
            type="button"
            onClick={() => onGestionar?.(cita, 'reagendar', gestion.reagendar)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-orange-300 hover:text-orange-500"
          >
            Reagendar
          </button>
        )}
        {sala === 'pronto' && gestion.cancelar && (
          <button
            type="button"
            onClick={() => onGestionar?.(cita, 'cancelar', gestion.cancelar)}
            className="rounded-lg px-3 py-2 text-xs font-bold text-slate-500 hover:text-rose-500"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

// Cancelar / Reagendar se hace en Cal.com, pero DENTRO de QLUBOS (ventana
// embebida): al cerrar esta ventana — o cuando Cal.com avisa que reagendó —
// el portal verifica el cambio y actualiza cita, historial y horas.
function ModalGestionCita({ gestion, ahora, onClose, onConfirmar, confirmando, errorConfirmacion, permitirForzar }) {
  const { cita, accion, url } = gestion;
  const politica = evaluarCancelacion(cita.inicio, cita.minutos_reservados, ahora);
  const urlEmbebida = urlEmbebidaCal(url);
  return (
    <ModalSoporte
      titulo={accion === 'reagendar' ? 'Reagendar reunión de soporte' : 'Cancelar reunión de soporte'}
      subtitulo={`${conceptoReunion(cita)} · ${formatoFechaHora(cita.inicio)}`}
      onClose={confirmando ? undefined : onClose}
      ancho="max-w-3xl"
    >
      <p
        className={`mb-3 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${
          politica.tardia ? 'bg-amber-400/10 text-amber-700' : 'bg-emerald-500/10 text-emerald-700'
        }`}
      >
        <Info size={13} className="mt-0.5 shrink-0" />
        {accion === 'reagendar'
          ? politica.tardia
            ? `Faltan menos de ${ANTICIPACION_CANCELACION_HORAS} h: al reagendar se descontarán ${politica.minutosCobrados} min (50 %) de la reunión original.`
            : 'Reagendar con anticipación no tiene costo: los minutos se mueven a la nueva fecha.'
          : politica.mensaje}
      </p>
      {urlEmbebida ? (
        <iframe title="Gestionar reunión en Cal.com" src={urlEmbebida} className="h-[60vh] min-h-[420px] w-full rounded-xl border border-slate-200 bg-white" />
      ) : null}
      {errorConfirmacion && (
        <div className="mt-3 flex flex-wrap items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{errorConfirmacion}</span>
          {permitirForzar && (
            <button type="button" onClick={() => onConfirmar(true)} disabled={confirmando} className="font-black text-orange-600 hover:underline disabled:opacity-50">
              {accion === 'reagendar' ? 'Ya la reagendé, actualizar de todos modos' : 'Ya la cancelé, actualizar de todos modos'}
            </button>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] text-slate-500">
          Cuando Cal.com te confirme el cambio, presiona el botón: tu cita pasa al historial y tus horas se actualizan.{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-bold text-orange-500 hover:underline">
            ¿No carga? Ábrelo en otra pestaña
          </a>
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={confirmando}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-50"
          >
            Cerrar sin cambios
          </button>
          <button
            type="button"
            onClick={() => onConfirmar(false)}
            disabled={confirmando}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-400 px-4 py-2 text-xs font-black text-slate-950 hover:bg-orange-300 disabled:opacity-60"
          >
            {confirmando && <Loader2 size={13} className="animate-spin" />}
            {accion === 'reagendar' ? 'Cerrar y confirmar reagenda' : 'Cerrar y confirmar cancelación'}
          </button>
        </div>
      </div>
    </ModalSoporte>
  );
}

export default function Soporte({ clubId, nombreClub, nombreUsuario, puedeGestionar = true, onToast }) {
  const config = useMemo(() => resolverConfigCalcom(), []);
  const [bolsa, setBolsa] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [compras, setCompras] = useState([]);
  const [ajustes, setAjustes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [esquemaFaltante, setEsquemaFaltante] = useState(false);
  const [modal, setModal] = useState(null); // 'comprar' | 'agendar' | null
  const [contacto, setContacto] = useState(null);
  const [ahora, setAhora] = useState(() => new Date());
  const [uniendoseId, setUniendoseId] = useState(null);
  const montadoRef = useRef(true);
  // Detección de una cita recién agendada en Cal.com (el webhook puede
  // tardar unos segundos en registrarla en Supabase).
  const ticketsRef = useRef([]);
  ticketsRef.current = tickets;
  const esperaCitaRef = useRef(null);
  const agendadasPreviasRef = useRef(new Set());
  const reservaConfirmadaRef = useRef(false);
  const duracionElegidaRef = useRef(30);
  const uidsRegistradosRef = useRef(new Set());
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  // Cancelar / Reagendar en Cal.com (v101): acciones en espera de confirmar,
  // ventana de gestión abierta y verificación en curso.
  const [acciones, setAcciones] = useState(() => (typeof window === 'undefined' ? {} : leerAccionesCalcomPendientes()));
  const accionesRef = useRef(acciones);
  accionesRef.current = acciones;
  const [gestion, setGestion] = useState(null); // { cita, accion, url } | null
  const [verificandoUid, setVerificandoUid] = useState(null);
  const esperaResolucionRef = useRef(null);
  const verificarRetornoRef = useRef(null);
  const [confirmandoGestion, setConfirmandoGestion] = useState(false);
  const [errorGestion, setErrorGestion] = useState('');
  const [intentosGestion, setIntentosGestion] = useState(0);
  // Datos de la reserva NUEVA que Cal.com informa al reagendar en la ventana.
  const reservaReagendadaRef = useRef(null);

  const cargar = useCallback(
    async ({ silencioso = false } = {}) => {
      if (clubId == null) return;
      if (!silencioso) setCargando(true);
      const [b, t, c, aj, px] = await Promise.all([
        obtenerBolsa(clubId),
        listarTickets(clubId),
        listarComprasExtra(clubId),
        listarAjustes(clubId),
        listarCitasProximas(clubId),
      ]);
      // Las citas próximas (agendadas desde hace 2 h en adelante) se leen
      // aparte y se mezclan con el historial, para que nunca queden fuera
      // por el límite de filas del historial.
      if (!t.error && !px.error && px.data.length) {
        const ids = new Set(t.data.map((x) => x.id));
        t.data = [...px.data.filter((x) => !ids.has(x.id)), ...t.data];
      }
      // Ajustes (v95) son opcionales: si la tabla no existe aún, se ignoran.
      if (!aj.error) setAjustes(aj.data);
      if (!montadoRef.current) return;
      const primerError = b.error || t.error || c.error;
      setEsquemaFaltante(Boolean(primerError && esErrorEsquemaSoporte(primerError)));
      setError(primerError ? mensajeError(primerError, 'No se pudo cargar tu información de soporte.') : '');
      if (!b.error) setBolsa(b.data || null);
      if (!t.error) setTickets(t.data);
      if (!c.error) setCompras(c.data);
      setCargando(false);
      return t.error ? null : t.data;
    },
    [clubId]
  );

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!puedeGestionar) return undefined;
    // Al entrar (o recargar): después de leer Supabase, se revisan las citas
    // activas contra Cal.com para limpiar las que se cancelaron o
    // reagendaron fuera de QLUBOS. Silencioso: si la verificación no está
    // disponible, no hace nada (el webhook es el respaldo).
    cargar().then((lista) => {
      const uids = (lista || []).filter((t) => t.estado === 'agendada' && t.calcom_uid).map((t) => t.calcom_uid);
      if (!uids.length) return;
      verificarCitasCalcom(clubId, uids).then((r) => {
        const cambios = (r?.ok ? r.resultados || [] : []).filter((x) => ['cancelada', 'reagendada', 'actualizada'].includes(x.resultado));
        if (!cambios.length || !montadoRef.current) return;
        cargar({ silencioso: true });
        const noPendientes = cambios.filter((x) => !accionesRef.current[x.uid]);
        if (noPendientes.length) {
          toastRef.current?.({
            titulo: 'Reuniones actualizadas desde Cal.com',
            detalle: `${noPendientes.length} ${noPendientes.length === 1 ? 'reunión cambió' : 'reuniones cambiaron'} en Cal.com: tu historial y tus horas ya están al día.`,
          });
        }
      });
    });
    obtenerUsuarioActual().then((u) => montadoRef.current && setContacto(u));
    // Tiempo real: cualquier cambio en horas, citas, compras o ajustes del
    // club recarga en silencio (agrupando ráfagas de eventos).
    let temporizador = null;
    const quitar = suscribirCambiosSoporte(clubId, () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(() => cargar({ silencioso: true }), 400);
    });
    // Respaldo silencioso: refleja No-Shows/cierres que dependen de la hora
    // aunque Realtime se haya desconectado. No es un botón.
    const respaldo = setInterval(() => cargar({ silencioso: true }), 120_000);
    const reloj = setInterval(() => setAhora(new Date()), 30_000);
    // Al volver a la pestaña, ponerse al día de inmediato.
    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      const pendientes = Object.keys(leerAccionesCalcomPendientes());
      // Regreso de Cal.com en otra pestaña: se verifica la acción al instante.
      if (pendientes.length) verificarRetornoRef.current?.(pendientes);
      else cargar({ silencioso: true });
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      quitar();
      clearTimeout(temporizador);
      clearInterval(respaldo);
      clearInterval(reloj);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [cargar, clubId, puedeGestionar]);

  // ---------------- Cancelar / Reagendar: retorno desde Cal.com ----------------
  // 1) Verifica con la API de Cal.com (Edge Function soporte-calcom-estado) y
  //    aplica el cambio en Supabase al instante. 2) Si la verificación no está
  //    disponible, el webhook de Cal.com hace el cambio y Realtime lo trae;
  //    mientras tanto se recarga en silencio cada pocos segundos.
  const verificarRetorno = useCallback(
    async (uids, { manual = false, alCerrar = false } = {}) => {
      const lista = [...new Set((uids || []).filter(Boolean))];
      if (clubId == null || lista.length === 0) return;
      if (manual) setVerificandoUid(lista[0]);
      const r = await verificarCitasCalcom(clubId, lista);
      if (manual) setVerificandoUid(null);
      await cargar({ silencioso: true });
      if (!r?.ok) {
        // Sin verificación directa: se espera al webhook (máx. ~1 min).
        clearInterval(esperaResolucionRef.current);
        let intentos = 0;
        esperaResolucionRef.current = setInterval(() => {
          intentos += 1;
          cargar({ silencioso: true });
          if (intentos >= 15 || Object.keys(accionesRef.current).length === 0) clearInterval(esperaResolucionRef.current);
        }, 4000);
        return;
      }
      // Cerró la ventana sin cancelar ni reagendar: deja de esperar.
      if (alCerrar) {
        (r.resultados || [])
          .filter((x) => x.resultado === 'sin_cambios')
          .forEach((x) => setAcciones(quitarAccionCalcomPendiente(x.uid)));
      }
      if (manual) {
        const sinCambios = (r.resultados || []).every((x) => x.resultado === 'sin_cambios' || x.resultado === 'pendiente');
        if (sinCambios) {
          toastRef.current?.({
            titulo: 'Cal.com aún no registra el cambio',
            detalle: 'Si ya confirmaste en Cal.com, en unos segundos se actualizará aquí.',
            tono: 'error',
          });
        }
      }
    },
    [cargar, clubId]
  );
  verificarRetornoRef.current = verificarRetorno;

  function abrirGestion(cita, accion, url) {
    setAcciones(registrarAccionCalcomPendiente(cita.calcom_uid, accion, cita.id));
    reservaReagendadaRef.current = null;
    setErrorGestion('');
    setIntentosGestion(0);
    setGestion({ cita, accion, url });
  }

  // "Cerrar y confirmar": la base de datos se actualiza SIEMPRE antes de
  // cerrar. 1) Si la verificación con Cal.com está disponible, se usa su
  // estado real (y no se marca nada si Cal.com dice que sigue activa).
  // 2) Si no está disponible (sin API key / función no desplegada), el club
  // confirma directamente (fn_soporte_club_cancelar_cita, regla de 2 h en el
  // servidor). Después se recargan tarjetas, Próximas e Historial.
  async function confirmarGestion(forzar = false) {
    if (!gestion) return;
    const { cita, accion } = gestion;
    setConfirmandoGestion(true);
    setErrorGestion('');
    let aplicado = false;
    if (!forzar) {
      const r = await verificarCitasCalcom(clubId, [cita.calcom_uid]);
      const res = r?.ok ? (r.resultados || []).find((x) => x.uid === cita.calcom_uid) : null;
      if (res && ['cancelada', 'cancelada_tardia', 'reagendada', 'completada', 'no_show'].includes(res.resultado)) {
        aplicado = true;
      } else if (res && (res.resultado === 'sin_cambios' || res.resultado === 'actualizada')) {
        // Cal.com confirma que la reunión sigue activa: no se libera nada.
        const intentos = intentosGestion + 1;
        setIntentosGestion(intentos);
        setErrorGestion(
          accion === 'reagendar'
            ? 'Cal.com todavía muestra tu reunión en su horario original. Termina de reagendar en la ventana y vuelve a confirmar.'
            : 'Cal.com todavía muestra tu reunión como activa. Termina la cancelación en la ventana y vuelve a confirmar.'
        );
        setConfirmandoGestion(false);
        await cargar({ silencioso: true });
        return;
      }
    }
    if (!aplicado) {
      const { error: err } = await cancelarCitaDesdePortal(cita.id, accion);
      if (err) {
        setErrorGestion(mensajeError(err, 'No se pudo actualizar la reunión.'));
        setConfirmandoGestion(false);
        return;
      }
      // Reagenda: si Cal.com informó la nueva reserva en la ventana, se
      // registra de inmediato (el webhook después completa la misma fila).
      if (accion === 'reagendar' && reservaReagendadaRef.current) {
        await registrarCitaPortal({ clubId, ...reservaReagendadaRef.current });
      } else if (accion === 'reagendar') {
        sincronizarCalcom(clubId);
      }
    }
    setConfirmandoGestion(false);
    setGestion(null);
    await cargar({ silencioso: true });
  }

  function cerrarGestion() {
    const uid = gestion?.cita?.calcom_uid;
    setGestion(null);
    if (uid) verificarRetorno([uid], { alCerrar: true });
  }

  function descartarAccion(uid) {
    setAcciones(quitarAccionCalcomPendiente(uid));
  }

  // Cuando una cita en espera deja de estar "agendada" (por el retorno, el
  // webhook o la sincronización), sale de Próximas, entra al Historial y se
  // avisa cuántos minutos volvieron a las horas disponibles.
  useEffect(() => {
    const uids = Object.keys(acciones);
    if (uids.length === 0) return;
    let restantes = acciones;
    uids.forEach((uid) => {
      const t = tickets.find((x) => x.calcom_uid === uid);
      if (!t || t.estado === 'agendada') return;
      restantes = quitarAccionCalcomPendiente(uid);
      const { liberados, cobrados } = minutosLiberadosCita(t);
      if (t.estado === 'reagendada') {
        const nueva = t.reagendado_a_uid ? tickets.find((x) => x.calcom_uid === t.reagendado_a_uid) : null;
        toastRef.current?.({
          titulo: 'Reunión reagendada',
          detalle: `${nueva?.inicio ? `Nueva fecha: ${formatoFechaHora(nueva.inicio)} · ` : ''}${
            cobrados > 0 ? `Se descontaron ${formatoMinutos(cobrados)} (50 %) por reagendar con menos de ${ANTICIPACION_CANCELACION_HORAS} h.` : 'Sin cargo por el cambio.'
          }`,
        });
      } else if (t.estado === 'cancelada' || t.estado === 'cancelada_tardia') {
        toastRef.current?.({
          titulo: t.estado === 'cancelada_tardia' ? 'Reunión cancelada (tardía)' : 'Reunión cancelada',
          detalle:
            cobrados > 0
              ? `Se descontaron ${formatoMinutos(cobrados)} (50 %) y volvieron ${formatoMinutos(liberados)} a tus horas disponibles.`
              : `Volvieron ${formatoMinutos(liberados)} a tus horas disponibles.`,
        });
      }
    });
    if (restantes !== acciones) setAcciones(restantes);
  }, [tickets, acciones]);

  // Mientras haya una acción en espera, se verifica periódicamente (por si el
  // club canceló en otra pestaña y no ha vuelto) — máximo 30 min por acción.
  useEffect(() => {
    if (!puedeGestionar || Object.keys(acciones).length === 0) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') verificarRetorno(Object.keys(accionesRef.current));
    }, 20_000);
    return () => clearInterval(id);
  }, [acciones, puedeGestionar, verificarRetorno]);

  useEffect(() => () => clearInterval(esperaResolucionRef.current), []);

  // URL de retorno desde Cal.com: /soporte?calcom=retorno[&uid=…]. Si llega
  // dentro de la ventana embebida, se avisa a la ventana principal.
  useEffect(() => {
    if (typeof window === 'undefined' || clubId == null) return;
    const retorno = leerRetornoCalcom(window.location.search);
    if (!retorno) return;
    const params = new URLSearchParams(window.location.search);
    retorno.claves.forEach((k) => params.delete(k));
    const resto = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${resto ? `?${resto}` : ''}`);
    const uids = [...new Set([...retorno.uids, ...Object.keys(leerAccionesCalcomPendientes())])];
    if (window.top && window.top !== window.self) {
      try {
        window.top.postMessage({ tipo: 'qlubos:calcom-retorno', uids }, window.location.origin);
      } catch (_e) {
        /* ventana principal en otro origen */
      }
      return;
    }
    if (uids.length) {
      toastRef.current?.({ titulo: 'Confirmando con Cal.com…', detalle: 'Actualizando tu reunión y tus horas de soporte.' });
      verificarRetorno(uids);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  // Mensajes de la ventana de gestión: Cal.com avisa al reagendar (y en
  // versiones recientes al cancelar); QLUBOS avisa si su URL de retorno se
  // abrió dentro de la ventana embebida.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    function alMensaje(evento) {
      const d = evento?.data;
      if (evento.origin === window.location.origin && d && d.tipo === 'qlubos:calcom-retorno') {
        setGestion(null);
        verificarRetorno([...(Array.isArray(d.uids) ? d.uids : []), ...Object.keys(accionesRef.current)]);
        return;
      }
      if (!gestion) return;
      let host = '';
      try {
        host = new URL(evento.origin).hostname;
      } catch (_e) {
        return;
      }
      if (host !== 'cal.com' && !host.endsWith('.cal.com')) {
        try {
          if (host !== new URL(gestion.url).hostname) return;
        } catch (_e) {
          return;
        }
      }
      if (tipoMensajeGestionCal(d)) {
        const uid = gestion.cita.calcom_uid;
        if (tipoMensajeGestionCal(d) === 'reagendada') {
          const nueva = extraerReservaCal(d, Number(gestion.cita.minutos_reservados) || 30);
          if (nueva && nueva.uid !== uid) reservaReagendadaRef.current = nueva;
        }
        // Pequeña espera: Cal.com termina de guardar antes de responder su API.
        setTimeout(() => verificarRetorno([uid]), 1500);
      }
    }
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
  }, [gestion, verificarRetorno]);

  // Cal.com (iframe con ?embed=true) avisa por postMessage cuando se confirma
  // una reserva: en ese momento se empieza a buscar la cita nueva sin
  // esperar a que el club cierre el modal.
  useEffect(() => {
    if (modal !== 'agendar' || typeof window === 'undefined') return undefined;
    const hostsCal = new Set(['cal.com', 'app.cal.com']);
    [config.calcomUrl30, config.calcomUrl60].forEach((u) => {
      try {
        if (u) hostsCal.add(new URL(u).hostname);
      } catch (_e) {
        /* URL inválida: se ignora */
      }
    });
    function alMensaje(evento) {
      let host = '';
      try {
        host = new URL(evento.origin).hostname;
      } catch (_e) {
        return;
      }
      if (!hostsCal.has(host) && !host.endsWith('.cal.com')) return;
      if (!esMensajeReservaCal(evento.data)) return;
      reservaConfirmadaRef.current = true;
      registrarReservaConfirmada(evento.data);
    }
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, config.calcomUrl30, config.calcomUrl60]);

  useEffect(() => () => clearInterval(esperaCitaRef.current), []);

  // Regreso desde Stripe Checkout: avisa y refresca hasta ver los minutos.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    const resultado = params.get('compra');
    if (!resultado) return undefined;
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (resultado === 'cancelada') {
      toastRef.current?.({ titulo: 'Pago cancelado', detalle: 'No se realizó ningún cargo.', tono: 'error' });
      return undefined;
    }
    toastRef.current?.({ titulo: '¡Pago recibido!', detalle: 'Estamos acreditando tus horas extra…' });
    let intentos = 0;
    const id = setInterval(() => {
      intentos += 1;
      cargar({ silencioso: true });
      if (intentos >= 6) clearInterval(id);
    }, 2000);
    return () => clearInterval(id);
  }, [cargar]);

  // "Retenido en citas" siempre cuadra con las citas agendadas que se ven en
  // pantalla, aunque la foto del servidor llegue un instante después.
  const bolsaVista = useMemo(() => conciliarRetenido(bolsa, tickets), [bolsa, tickets]);
  const resumen = resumenBolsa(bolsaVista);
  // Próximas = todas las citas agendadas (retienen minutos) hasta que se
  // registren como completadas / No-Show / canceladas; entonces pasan al
  // historial y su tiempo se mueve de "Retenido" a "Consumido".
  const proximas = useMemo(
    () => tickets.filter((t) => t.estado === 'agendada').sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime()),
    [tickets]
  );
  const historial = useMemo(() => tickets.filter((t) => t.estado !== 'agendada'), [tickets]);
  const hayAgenda = Boolean(config.calcomUrl30 || config.calcomUrl60);
  // Saldo para el modal de agenda: si la información de horas todavía no
  // cargó (o no se pudo leer), NO se bloquea la agenda en el frontend — el
  // servidor (webhook de Cal.com) es quien retiene y cobra los minutos.
  const saldoConocido = bolsa != null && !esquemaFaltante;
  const resumenAgenda = saldoConocido ? resumen : { ...resumen, puedeAgendar30: true, puedeAgendar60: true };

  function detenerEsperaCita() {
    clearInterval(esperaCitaRef.current);
    esperaCitaRef.current = null;
  }

  // Recarga cada 3 s (hasta ~45 s) hasta que aparezca la cita nueva que creó
  // el webhook de Cal.com; en cuanto llega, avisa y se detiene.
  function esperarNuevaCita() {
    detenerEsperaCita();
    let intentos = 0;
    const revisar = async () => {
      intentos += 1;
      const lista = await cargar({ silencioso: true });
      const nueva = (lista || []).find((t) => t.estado === 'agendada' && !agendadasPreviasRef.current.has(t.id));
      if (nueva) {
        detenerEsperaCita();
        reservaConfirmadaRef.current = false;
        toastRef.current?.({
          titulo: 'Reunión de soporte agendada',
          detalle: `${formatoFechaHora(nueva.inicio)} · ${formatoMinutos(nueva.minutos_reservados)} retenidos de tus horas.`,
        });
        return;
      }
      if (intentos >= 15) {
        detenerEsperaCita();
        if (reservaConfirmadaRef.current) {
          reservaConfirmadaRef.current = false;
          toastRef.current?.({
            titulo: 'Tu reunión se está registrando',
            detalle: 'Cal.com confirmó la cita, pero aún no llega a QLUBOS. Aparecerá aquí en cuanto se registre.',
            tono: 'error',
          });
        }
      }
    };
    revisar();
    esperaCitaRef.current = setInterval(revisar, 3000);
  }

  // Registro DIRECTO en Supabase de la reserva que Cal.com acaba de confirmar
  // (no espera al webhook): la cita aparece al instante en "Próximas citas" y
  // suma a "Retenido en citas". El webhook después actualiza la MISMA fila
  // (mismo uid de Cal.com), así que nunca se duplica.
  async function registrarReservaConfirmada(datosCal) {
    const reserva = extraerReservaCal(datosCal, duracionElegidaRef.current);
    if (reserva && !uidsRegistradosRef.current.has(reserva.uid)) {
      uidsRegistradosRef.current.add(reserva.uid);
      const { data, error: err } = await registrarCitaPortal({ clubId, ...reserva });
      if (!err && data) {
        agendadasPreviasRef.current.add(data.id);
        reservaConfirmadaRef.current = false;
        await cargar({ silencioso: true });
        toastRef.current?.({
          titulo: 'Reunión de soporte agendada',
          detalle: `${formatoFechaHora(data.inicio)} · ${formatoMinutos(data.minutos_reservados)} retenidos de tus horas.`,
        });
        return;
      }
      uidsRegistradosRef.current.delete(reserva.uid);
      console.warn('[Soporte] No se pudo registrar la cita desde el portal; se espera al webhook/sincronización.', err);
    }
    // Sin datos suficientes o falló el registro: respaldo con la API de
    // Cal.com + búsqueda periódica.
    sincronizarCalcom(clubId);
    esperarNuevaCita();
  }

  function abrirAgenda() {
    agendadasPreviasRef.current = new Set(ticketsRef.current.filter((t) => t.estado === 'agendada').map((t) => t.id));
    reservaConfirmadaRef.current = false;
    setModal('agendar');
  }

  function cerrarAgenda() {
    setModal(null);
    // Respaldo al cerrar: sincroniza con la API de Cal.com (si está
    // configurada) y busca la cita nueva unos segundos.
    sincronizarCalcom(clubId).then((r) => {
      if (r?.registradas > 0) cargar({ silencioso: true });
    });
    esperarNuevaCita();
  }

  const recordarDuracion = useCallback((min) => {
    duracionElegidaRef.current = min;
  }, []);

  async function unirme(cita) {
    const meet = urlSeguraHttp(cita.meet_url);
    if (!meet) return;
    // Se abre la pestaña en el mismo clic (evita el bloqueador de ventanas)
    // y después se registra la conexión para la tolerancia de 10 min.
    const ventana = window.open('about:blank', '_blank');
    setUniendoseId(cita.id);
    const { error: err } = await registrarConexion(cita.id);
    setUniendoseId(null);
    if (err) {
      ventana?.close();
      toastRef.current?.({ titulo: 'No se pudo abrir la sala', detalle: mensajeError(err), tono: 'error' });
      cargar({ silencioso: true });
      return;
    }
    if (ventana) {
      ventana.opener = null;
      ventana.location.href = meet;
    } else {
      window.location.assign(meet);
    }
    cargar({ silencioso: true });
  }

  if (clubId == null) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
        No hay un club activo en esta sesión. Vuelve a iniciar sesión para ver tus horas de soporte.
      </div>
    );
  }

  if (!puedeGestionar) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <Lock size={22} className="mx-auto text-slate-400" />
        <p className="mt-2 text-sm font-bold text-slate-900">Soporte</p>
        <p className="mt-1 text-xs text-slate-500">Esta sección es exclusiva del Owner / Administrador del club.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
        <LifeBuoy size={20} className="text-orange-500" /> Soporte
      </h1>

      {error && (
        <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${esquemaFaltante ? 'border-amber-400/40 bg-amber-400/10 text-amber-600' : 'border-rose-500/40 bg-rose-500/10 text-rose-500'}`}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {cargando && !bolsa ? (
            <div className="h-56 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
          ) : (
            <WidgetBolsaHoras bolsa={bolsaVista} onComprar={esquemaFaltante ? null : () => setModal('comprar')} />
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reunión de soporte</p>
          <div className="mt-3 space-y-2">
            {/* Siempre clicable: el modal decide qué duraciones ofrecer según el
                saldo y explica qué falta si la agenda no está configurada. */}
            <button
              type="button"
              onClick={abrirAgenda}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-orange-400/40 bg-orange-400/10 px-4 py-3 text-left text-sm font-bold text-orange-500 transition hover:bg-orange-400/20"
            >
              <CalendarClock size={18} /> Agendar reunión de soporte
            </button>
            {saldoConocido && !resumen.puedeAgendar30 && !cargando && (
              <p className="text-[11px] font-semibold text-amber-600">
                Tienes {formatoMinutos(resumen.disponibles)} disponibles. Para agendar necesitas al menos 30 min: compra horas extra en el recuadro de tus horas de soporte.
              </p>
            )}
          </div>

          <div className="mt-4 space-y-1.5 border-t border-slate-200 pt-3 text-[11px] text-slate-500">
            <p className="flex items-start gap-1.5">
              <Clock size={12} className="mt-0.5 shrink-0" /> Tolerancia de {TOLERANCIA_MINUTOS} min: sin conexión se marca "No asistió" y se descuenta completa.
            </p>
            <p className="flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 shrink-0" /> Cancela con {ANTICIPACION_CANCELACION_HORAS} h o más y recuperas todo; con menos se descuenta el 50 %.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Próximas citas{proximas.length > 0 ? ` · ${proximas.length}` : ''}
        </p>
        {cargando && tickets.length === 0 ? (
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
        ) : proximas.length === 0 ? (
          <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-dashed border-slate-300 px-4 py-4 sm:flex-row sm:items-center">
            <p className="text-sm text-slate-500">No tienes reuniones de soporte agendadas.</p>
            <button type="button" onClick={abrirAgenda} className="text-xs font-bold text-orange-500 hover:underline">
              Agendar reunión de soporte
            </button>
          </div>
        ) : (
          proximas.map((c) => (
            <TarjetaProximaCita
              key={c.id}
              cita={c}
              ahora={ahora}
              calcomBase={config.calcomUrl30 || config.calcomUrl60}
              onUnirme={unirme}
              uniendose={uniendoseId === c.id}
              pendiente={c.calcom_uid ? acciones[c.calcom_uid] : null}
              onGestionar={abrirGestion}
              onVerificar={(cita) => verificarRetorno([cita.calcom_uid], { manual: true })}
              onDescartar={(cita) => descartarAccion(cita.calcom_uid)}
              verificando={verificandoUid === c.calcom_uid}
            />
          ))
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Historial de reuniones</p>
        {cargando && tickets.length === 0 ? <div className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" /> : <TablaHistorialSoporte tickets={historial} />}
      </div>

      {ajustes.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ajustes</p>
          <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
            {ajustes.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
                <span className="text-slate-500">{formatoFechaHora(a.creado_en)}</span>
                <span className="min-w-0 flex-1 truncate px-2 text-slate-700" title={a.motivo}>
                  {a.motivo}
                </span>
                <span className={`font-black ${Number(a.minutos) > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {Number(a.minutos) > 0 ? '+' : '−'}
                  {formatoMinutos(Math.abs(Number(a.minutos)))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {compras.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Compras de horas extra</p>
          <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
            {compras.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
                <span className="text-slate-500">{formatoFechaHora(c.pagado_en || c.creado_en)}</span>
                <span className="font-bold text-slate-900">
                  {c.horas} {c.horas === 1 ? 'hora' : 'horas'} · {formatoMXN(c.monto_mxn)}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 font-bold ring-1 ${
                    c.estado === 'pagada'
                      ? 'bg-emerald-400/10 text-emerald-500 ring-emerald-400/30'
                      : c.estado === 'pendiente'
                      ? 'bg-amber-400/10 text-amber-500 ring-amber-400/30'
                      : 'bg-slate-400/10 text-slate-500 ring-slate-400/30'
                  }`}
                >
                  {c.estado === 'pagada' ? 'Acreditada' : c.estado === 'pendiente' ? 'Pendiente de pago' : c.estado === 'reembolsada' ? 'Reembolsada' : 'Cancelada'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {gestion && (
        <ModalGestionCita
          gestion={gestion}
          ahora={ahora}
          onClose={cerrarGestion}
          onConfirmar={confirmarGestion}
          confirmando={confirmandoGestion}
          errorConfirmacion={errorGestion}
          permitirForzar={intentosGestion >= 1}
        />
      )}
      {modal === 'comprar' && <ModalComprarHorasExtra clubId={clubId} nombreClub={nombreClub} onClose={() => setModal(null)} />}
      {modal === 'agendar' && (
        <ModalAgendarVideollamada
          config={config}
          clubId={clubId}
          contacto={{ nombre: nombreUsuario || contacto?.nombre, email: contacto?.email }}
          resumen={resumenAgenda}
          onClose={cerrarAgenda}
          onCambioDuracion={recordarDuracion}
        />
      )}
    </div>
  );
}
