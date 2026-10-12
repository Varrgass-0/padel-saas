// =============================================================================
// Soporte — Panel SuperAdmin (/admin/soporte)
// Exclusivo para staff de QLUBOS (tabla plataforma_staff). El candado real
// está en Supabase (RLS + funciones que validan fn_soporte_es_staff); esta
// pantalla además vuelve a consultar el rol antes de mostrar nada.
//
// Dos vistas:
//   • Clubes: métricas que funcionan como filtros rápidos, lista de
//     clubes y ficha del club (bolsa, diagnóstico interno, ajustes, historial).
//   • Agenda & Citas: calendario mensual (estilo Google Calendar) de las
//     reuniones de todos los clubes, navegable a cualquier mes/año, con
//     detalle de cada cita (Meet, reagendar, registrar resultado). También
//     tiene vista de lista del mes.
// Sin botón "Actualizar": todo se refresca solo con Supabase Realtime.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  List,
  LifeBuoy,
  Loader2,
  Lock,
  Plus,
  Search,
  ShieldAlert,
  Video,
  X,
} from 'lucide-react';
import {
  duracionCitaMin,
  etiquetaDiaAgenda,
  formatoFecha,
  formatoFechaHora,
  formatoHora,
  formatoMinutos,
  formatoMinutosConSigno,
  conceptoReunion,
  grupoAgenda,
  resumenBolsa,
  reunionDestacada,
  urlSeguraHttp,
  ESTADOS_TICKET,
  NOMBRES_MESES,
  DIAS_SEMANA_CORTOS,
  diasCuadriculaMes,
  rangoCuadriculaMes,
  agruparCitasPorDia,
  claveDiaLocal,
  enlacesGestionCalcom,
} from './soporteReglas';
import {
  consultarEsStaffQlubos,
  listarAgendaAdmin,
  listarAjustes,
  listarClubesAdmin,
  listarNotasInternas,
  listarTickets,
  obtenerBolsa,
  suscribirCambiosSoporte,
  mensajeError,
  sincronizarCalcom,
} from './soporteApi';
import { ModalRegistrarAtencion, ModalSoporte } from './SoporteModal';
import { WidgetBolsaHoras, TablaHistorialSoporte, BadgeEstadoTicket, resolverConfigCalcom } from './Soporte';

const REFRESCO_SILENCIOSO_MS = 120_000; // respaldo por si Realtime se desconecta
const SALDO_CRITICO_MIN = 30;

function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function tieneCitaProxima(club) {
  return Boolean(club?.proxima_cita);
}

function saldoCritico(club) {
  return (Number(club?.minutos_disponibles_mes) || 0) < SALDO_CRITICO_MIN;
}

// -----------------------------------------------------------------------------
// Piezas de UI
// -----------------------------------------------------------------------------
function TarjetaMetricaFiltro({ etiqueta, valor, ayuda, textoActivo = 'Filtro activo', tono = 'orange', activa, onClick }) {
  const color = tono === 'rose' ? 'text-rose-500' : tono === 'sky' ? 'text-sky-500' : 'text-orange-500';
  const anillo = tono === 'rose' ? 'ring-rose-400 border-rose-400/60' : tono === 'sky' ? 'ring-sky-400 border-sky-400/60' : 'ring-orange-400 border-orange-400/60';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activa}
      className={`group rounded-2xl border bg-white px-3 py-3 text-left transition sm:px-4 hover:-translate-y-0.5 hover:shadow-md ${
        activa ? `ring-2 shadow-lg ${anillo}` : 'border-slate-200'
      }`}
    >
      <p className="min-h-[2.5em] text-[10px] font-semibold uppercase leading-tight tracking-wide text-slate-500 sm:min-h-0">{etiqueta}</p>
      <p className={`text-2xl font-black ${color}`}>{valor}</p>
      <p className={`mt-0.5 hidden text-[10px] font-semibold sm:block ${activa ? color : 'text-slate-400 group-hover:text-slate-500'}`}>{activa ? textoActivo : ayuda}</p>
    </button>
  );
}

function BotonMeet({ url, compacto = false }) {
  const meet = urlSeguraHttp(url);
  if (!meet) {
    return <span className="text-[11px] font-semibold text-slate-400">Sin enlace de Meet</span>;
  }
  return (
    <a
      href={meet}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 font-black text-white shadow-sm transition hover:bg-emerald-400 ${
        compacto ? 'px-3 py-2 text-xs' : 'px-4 py-2.5 text-sm'
      }`}
    >
      <Video size={compacto ? 14 : 16} /> Unirse a Google Meet
    </a>
  );
}

function BannerReunion({ destacada, nombreClub, onVerClub }) {
  if (!destacada) return null;
  const { ticket, enCurso, minutosParaInicio, total } = destacada;
  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
        enCurso ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-orange-400/40 bg-orange-400/10'
      }`}
      role="status"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className={`relative mt-1 flex h-3 w-3 shrink-0 ${enCurso ? 'text-emerald-500' : 'text-orange-500'}`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
        </span>
        <div className="min-w-0">
          <p className={`text-xs font-black uppercase tracking-wide ${enCurso ? 'text-emerald-600' : 'text-orange-500'}`}>
            {enCurso ? 'Reunión en curso' : `Próxima reunión · empieza en ${minutosParaInicio} min`}
            {total > 1 ? ` · +${total - 1} más` : ''}
          </p>
          <button type="button" onClick={onVerClub} className="mt-0.5 block truncate text-left text-base font-black text-slate-900 hover:underline">
            {nombreClub} <span className="text-xs font-semibold text-slate-500">· ID {ticket.club_id}</span>
          </button>
          <p className="truncate text-xs text-slate-600">
            {formatoHora(ticket.inicio)} · {formatoMinutos(duracionCitaMin(ticket))} · {conceptoReunion(ticket)}
          </p>
        </div>
      </div>
      <BotonMeet url={ticket.meet_url} />
    </div>
  );
}

function TarjetaCita({ cita, nombreClub, ahora, onVerClub, onRegistrar, onDetalle }) {
  const inicio = cita.inicio ? new Date(cita.inicio).getTime() : 0;
  const fin = inicio + duracionCitaMin(cita) * 60_000;
  const t = ahora.getTime();
  const pendienteCerrar = cita.estado === 'agendada' && t > fin;
  const enCurso = cita.estado === 'agendada' && t >= inicio && t <= fin;
  const duracion = duracionCitaMin(cita);
  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border bg-white p-4 sm:flex-row sm:items-center ${
        enCurso ? 'border-emerald-500/50 ring-1 ring-emerald-500/30' : 'border-slate-200'
      }`}
    >
      <div className="flex shrink-0 items-center gap-3 sm:w-28 sm:flex-col sm:items-start sm:gap-0.5">
        <p className="text-lg font-black text-slate-900">{formatoHora(cita.inicio)}</p>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">{duracion} min</span>
      </div>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onVerClub} className="block max-w-full truncate text-left text-sm font-black text-slate-900 hover:text-orange-500">
          {nombreClub} <span className="text-xs font-semibold text-slate-500">· ID {cita.club_id}</span>
        </button>
        <p className="truncate text-xs text-slate-600" title={cita.concepto || ''}>
          {conceptoReunion(cita)}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <BadgeEstadoTicket estado={cita.estado} />
          {enCurso && <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-bold text-white">En curso</span>}
          {pendienteCerrar && (
            <span className="rounded-full bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-bold text-amber-600 ring-1 ring-amber-400/30">Pendiente de registrar</span>
          )}
          {cita.estado !== 'agendada' && cita.minutos_consumidos > 0 && (
            <span className="text-[11px] font-semibold text-slate-500">· {formatoMinutos(cita.minutos_consumidos)} descontados</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {cita.estado === 'agendada' && !pendienteCerrar && <BotonMeet url={cita.meet_url} compacto />}
        {onDetalle && (
          <button type="button" onClick={onDetalle} className="rounded-lg px-2.5 py-2 text-xs font-bold text-slate-500 hover:text-orange-500">
            Detalle
          </button>
        )}
        {cita.estado === 'agendada' && (
          <button
            type="button"
            onClick={onRegistrar}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition ${
              pendienteCerrar ? 'border-amber-400/50 bg-amber-400/10 text-amber-600 hover:bg-amber-400/20' : 'border-slate-200 text-slate-600 hover:border-orange-300 hover:text-orange-500'
            }`}
          >
            <ClipboardCheck size={14} /> Registrar resultado
          </button>
        )}
      </div>
    </div>
  );
}

// Color de cada cita en el calendario según su estado.
const COLOR_CITA = {
  agendada: 'bg-sky-500/15 text-sky-700 ring-sky-500/30 hover:bg-sky-500/25',
  completada: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 hover:bg-emerald-500/25',
  no_show: 'bg-rose-500/15 text-rose-600 ring-rose-500/30 hover:bg-rose-500/25',
  cancelada_tardia: 'bg-amber-400/20 text-amber-700 ring-amber-400/40 hover:bg-amber-400/30',
  cancelada: 'bg-slate-400/15 text-slate-500 line-through ring-slate-400/30 hover:bg-slate-400/25',
};
const PUNTO_CITA = {
  agendada: 'bg-sky-500',
  completada: 'bg-emerald-500',
  no_show: 'bg-rose-500',
  cancelada_tardia: 'bg-amber-400',
  cancelada: 'bg-slate-400',
};
const MAX_CITAS_POR_CELDA = 3;

function EncabezadoMes({ mesVista, onCambiar }) {
  const hoy = new Date();
  const { anio, mes } = mesVista;
  const anios = useMemo(() => {
    const base = hoy.getFullYear();
    const desde = Math.min(base - 5, anio);
    const hasta = Math.max(base + 3, anio);
    return Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anio]);
  function mover(delta) {
    const f = new Date(anio, mes + delta, 1);
    onCambiar({ anio: f.getFullYear(), mes: f.getMonth() });
  }
  const esMesActual = anio === hoy.getFullYear() && mes === hoy.getMonth();
  const claseSelect = 'rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-bold text-slate-900 outline-none focus:border-orange-400';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onCambiar({ anio: hoy.getFullYear(), mes: hoy.getMonth() })}
        disabled={esMesActual}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-500 disabled:opacity-50"
      >
        Hoy
      </button>
      <div className="flex items-center">
        <button type="button" onClick={() => mover(-1)} aria-label="Mes anterior" className="rounded-lg p-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900">
          <ChevronLeft size={18} />
        </button>
        <button type="button" onClick={() => mover(1)} aria-label="Mes siguiente" className="rounded-lg p-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900">
          <ChevronRight size={18} />
        </button>
      </div>
      <h2 className="mr-1 text-lg font-black text-slate-900">
        {NOMBRES_MESES[mes]} {anio}
      </h2>
      <select aria-label="Mes" value={mes} onChange={(e) => onCambiar({ anio, mes: Number(e.target.value) })} className={claseSelect}>
        {NOMBRES_MESES.map((m, i) => (
          <option key={m} value={i}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label="Año" value={anio} onChange={(e) => onCambiar({ anio: Number(e.target.value), mes })} className={claseSelect}>
        {anios.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </div>
  );
}

function CalendarioMensual({ mesVista, citas, clubesPorId, diaSel, onElegirDia, onAbrirCita }) {
  const dias = useMemo(() => diasCuadriculaMes(mesVista.anio, mesVista.mes), [mesVista.anio, mesVista.mes]);
  const porDia = useMemo(() => agruparCitasPorDia(citas), [citas]);
  const claveHoy = claveDiaLocal(new Date());
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
        {DIAS_SEMANA_CORTOS.map((d) => (
          <div key={d} className="px-1 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500 sm:text-[11px]">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {dias.map(({ fecha, clave, delMes }, i) => {
          const lista = porDia.get(clave) || [];
          const esHoy = clave === claveHoy;
          const seleccionado = clave === diaSel;
          const ocultas = lista.length - MAX_CITAS_POR_CELDA;
          return (
            <div
              key={clave}
              role="button"
              tabIndex={0}
              onClick={() => onElegirDia(clave)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onElegirDia(clave);
                }
              }}
              aria-label={`${fecha.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}: ${lista.length} reuniones`}
              className={`min-h-[64px] cursor-pointer border-slate-200 p-1 text-left transition sm:min-h-[112px] sm:p-1.5 ${i % 7 !== 6 ? 'border-r' : ''} ${
                i < 35 ? 'border-b' : ''
              } ${delMes ? 'bg-white hover:bg-orange-50/60' : 'bg-slate-50/70 hover:bg-slate-100'} ${seleccionado ? 'ring-2 ring-inset ring-orange-400' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold sm:text-xs ${
                    esHoy ? 'bg-orange-400 text-slate-950' : delMes ? 'text-slate-800' : 'text-slate-400'
                  }`}
                >
                  {fecha.getDate()}
                </span>
                {lista.length > 0 && <span className="text-[10px] font-bold text-slate-400 sm:hidden">{lista.length}</span>}
              </div>
              {/* Móvil: puntos de color. Escritorio: hora + club + estado. */}
              <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                {lista.slice(0, 4).map((c) => (
                  <span key={c.id} className={`h-1.5 w-1.5 rounded-full ${PUNTO_CITA[c.estado] || 'bg-slate-400'}`} />
                ))}
              </div>
              <div className="mt-1 hidden space-y-0.5 sm:block">
                {lista.slice(0, MAX_CITAS_POR_CELDA).map((c) => {
                  const club = clubesPorId.get(String(c.club_id));
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAbrirCita(c);
                      }}
                      title={`${formatoHora(c.inicio)} · ${club?.nombre || `Club ${c.club_id}`} · ${ESTADOS_TICKET[c.estado]?.label || c.estado}`}
                      className={`flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold ring-1 transition ${COLOR_CITA[c.estado] || COLOR_CITA.cancelada}`}
                    >
                      <span className="shrink-0 font-black">{formatoHora(c.inicio)}</span>
                      <span className="truncate">{club?.nombre || `Club ${c.club_id}`}</span>
                    </button>
                  );
                })}
                {ocultas > 0 && <p className="px-1 text-[10px] font-bold text-slate-500">+{ocultas} más</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeyendaEstados() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
      {['agendada', 'completada', 'no_show', 'cancelada_tardia', 'cancelada'].map((e) => (
        <span key={e} className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${PUNTO_CITA[e]}`} /> {ESTADOS_TICKET[e]?.label}
        </span>
      ))}
    </div>
  );
}

function VistaAgenda({ citas, cargando, clubesPorId, ahora, mesVista, onCambiarMes, onVerClub, onAbrirCita, onRegistrar }) {
  const [modo, setModo] = useState('calendario'); // 'calendario' | 'lista'
  const [filtro, setFiltro] = useState('todas');
  const [diaSel, setDiaSel] = useState(() => claveDiaLocal(new Date()));

  // Al cambiar de mes se selecciona el día 1 (o hoy si es el mes actual).
  function cambiarMes(siguiente) {
    const hoy = new Date();
    const esActual = siguiente.anio === hoy.getFullYear() && siguiente.mes === hoy.getMonth();
    setDiaSel(claveDiaLocal(esActual ? hoy : new Date(siguiente.anio, siguiente.mes, 1)));
    onCambiarMes(siguiente);
  }

  const delMes = useMemo(
    () =>
      citas.filter((c) => {
        const d = new Date(c.inicio);
        return d.getFullYear() === mesVista.anio && d.getMonth() === mesVista.mes;
      }),
    [citas, mesVista.anio, mesVista.mes]
  );

  const conteos = useMemo(() => {
    const c = { proximas: 0, completadas: 0, canceladas: 0, todas: delMes.length };
    delMes.forEach((x) => {
      c[grupoAgenda(x)] += 1;
    });
    return c;
  }, [delMes]);

  const visibles = useMemo(() => {
    const lista = filtro === 'todas' ? [...delMes] : delMes.filter((x) => grupoAgenda(x) === filtro);
    return lista.sort((a, b) => new Date(a.inicio || 0).getTime() - new Date(b.inicio || 0).getTime());
  }, [delMes, filtro]);

  const grupos = useMemo(() => {
    const mapa = new Map();
    visibles.forEach((c) => {
      const k = etiquetaDiaAgenda(c.inicio, ahora);
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k).push(c);
    });
    return [...mapa.entries()];
  }, [visibles, ahora]);

  const citasDiaSel = useMemo(
    () => citas.filter((c) => c.inicio && claveDiaLocal(c.inicio) === diaSel).sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime()),
    [citas, diaSel]
  );
  const etiquetaDiaSel = useMemo(() => {
    const [y, m, d] = diaSel.split('-').map(Number);
    const f = new Date(y, m - 1, d);
    const t = f.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }, [diaSel]);

  const FILTROS = [
    { id: 'todas', label: 'Todas' },
    { id: 'proximas', label: 'Agendadas' },
    { id: 'completadas', label: 'Completadas' },
    { id: 'canceladas', label: 'Canceladas / No-Show' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EncabezadoMes mesVista={mesVista} onCambiar={cambiarMes} />
        <div className="flex items-center gap-2">
          {cargando && <Loader2 size={15} className="animate-spin text-slate-400" />}
          <div role="tablist" aria-label="Modo de la agenda" className="flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
            {[
              { id: 'calendario', label: 'Mes', icon: CalendarDays },
              { id: 'lista', label: 'Lista', icon: List },
            ].map((m) => {
              const Icono = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={modo === m.id}
                  onClick={() => setModo(m.id)}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition ${
                    modo === m.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  <Icono size={13} /> {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {modo === 'calendario' ? (
        <>
          <CalendarioMensual mesVista={mesVista} citas={citas} clubesPorId={clubesPorId} diaSel={diaSel} onElegirDia={setDiaSel} onAbrirCita={onAbrirCita} />
          <LeyendaEstados />
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-500">
              <CalendarDays size={13} /> {etiquetaDiaSel}
              <span className="font-semibold text-slate-400">· {citasDiaSel.length} {citasDiaSel.length === 1 ? 'reunión' : 'reuniones'}</span>
            </p>
            {citasDiaSel.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">Sin reuniones este día.</p>
            ) : (
              citasDiaSel.map((c) => (
                <TarjetaCita
                  key={c.id}
                  cita={c}
                  ahora={ahora}
                  nombreClub={clubesPorId.get(String(c.club_id))?.nombre || `Club ${c.club_id}`}
                  onVerClub={() => onVerClub(c.club_id)}
                  onRegistrar={() => onRegistrar(c)}
                  onDetalle={() => onAbrirCita(c)}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTROS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFiltro(f.id)}
                aria-pressed={filtro === f.id}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  filtro === f.id ? 'bg-orange-400 text-slate-950' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900'
                }`}
              >
                {f.label} <span className={filtro === f.id ? 'text-slate-800' : 'text-slate-400'}>{conteos[f.id]}</span>
              </button>
            ))}
          </div>
          {grupos.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
              No hay reuniones en {NOMBRES_MESES[mesVista.mes].toLowerCase()} de {mesVista.anio}
              {filtro !== 'todas' ? ' con este filtro' : ''}.
            </div>
          ) : (
            grupos.map(([dia, lista]) => (
              <div key={dia} className="space-y-2">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-500">
                  <CalendarDays size={13} /> {dia} <span className="font-semibold text-slate-400">· {lista.length}</span>
                </p>
                {lista.map((c) => (
                  <TarjetaCita
                    key={c.id}
                    cita={c}
                    ahora={ahora}
                    nombreClub={clubesPorId.get(String(c.club_id))?.nombre || `Club ${c.club_id}`}
                    onVerClub={() => onVerClub(c.club_id)}
                    onRegistrar={() => onRegistrar(c)}
                    onDetalle={() => onAbrirCita(c)}
                  />
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// Detalle completo de una cita (al hacer clic en el calendario o en la lista).
function ModalDetalleCita({ cita, nombreClub, ahora, onClose, onVerClub, onRegistrar }) {
  const config = useMemo(() => resolverConfigCalcom(), []);
  const gestion = enlacesGestionCalcom(config.calcomUrl30 || config.calcomUrl60, cita.calcom_uid);
  const inicio = cita.inicio ? new Date(cita.inicio) : null;
  const fin = inicio ? new Date(inicio.getTime() + duracionCitaMin(cita) * 60_000) : null;
  const t = ahora.getTime();
  const agendada = cita.estado === 'agendada';
  const futura = inicio && t < inicio.getTime();
  const enCurso = agendada && inicio && t >= inicio.getTime() && t <= fin.getTime();
  const fechaLarga = inicio ? inicio.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const fila = (etiqueta, valor) => (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="shrink-0 text-xs font-semibold text-slate-500">{etiqueta}</span>
      <span className="text-right font-semibold text-slate-900">{valor}</span>
    </div>
  );
  return (
    <ModalSoporte titulo={conceptoReunion(cita)} subtitulo={`${nombreClub} · ID ${cita.club_id}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-1.5">
        <BadgeEstadoTicket estado={cita.estado} />
        {enCurso && <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[11px] font-bold text-white">En curso</span>}
        {cita.conectado_en && <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">El club se conectó {formatoHora(cita.conectado_en)}</span>}
      </div>
      <div className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 px-3">
        {fila('Fecha', fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1))}
        {fila('Horario', inicio ? `${formatoHora(cita.inicio)} – ${formatoHora(fin.toISOString())}` : '—')}
        {fila('Duración', `${duracionCitaMin(cita)} min`)}
        {cita.estado !== 'agendada' && fila('Minutos descontados', formatoMinutos(cita.minutos_consumidos))}
        {cita.contacto_email && fila('Contacto', cita.contacto_email)}
        {cita.origen && fila('Registrada por', { portal: 'Portal del club', calcom_webhook: 'Cal.com', calcom_sync: 'Cal.com (sincronización)', manual: 'SuperAdmin' }[cita.origen] || cita.origen)}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {agendada && <BotonMeet url={cita.meet_url} />}
        <div className="flex flex-wrap gap-2">
          {agendada && futura && gestion.reagendar && (
            <a
              href={gestion.reagendar}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:border-orange-300 hover:text-orange-500"
            >
              <ExternalLink size={13} /> Reagendar en Cal.com
            </a>
          )}
          {agendada && futura && gestion.cancelar && (
            <a
              href={gestion.cancelar}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-rose-300 hover:text-rose-500"
            >
              <ExternalLink size={13} /> Cancelar en Cal.com
            </a>
          )}
          <button type="button" onClick={() => onVerClub(cita.club_id)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-orange-300 hover:text-orange-500">
            Ver club
          </button>
        </div>
      </div>

      <div className="mt-4 border-t border-slate-200 pt-3">
        <p className="mb-2 text-xs font-bold text-slate-600">{agendada ? 'Registrar resultado' : 'Corregir registro'}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { estado: 'completada', label: 'Completada', clase: 'border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10' },
            { estado: 'no_show', label: 'No asistió', clase: 'border-rose-500/40 text-rose-500 hover:bg-rose-500/10' },
            { estado: 'cancelada_tardia', label: 'Cancel. tardía', clase: 'border-amber-400/50 text-amber-600 hover:bg-amber-400/10' },
            { estado: 'cancelada', label: 'Cancelada', clase: 'border-slate-300 text-slate-600 hover:bg-slate-100' },
          ].map((op) => (
            <button key={op.estado} type="button" onClick={() => onRegistrar(cita, op.estado)} className={`rounded-lg border px-2 py-2 text-xs font-bold transition ${op.clase}`}>
              {op.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Se abre el registro para confirmar los minutos reales antes de descontarlos.</p>
      </div>
    </ModalSoporte>
  );
}

function PanelNotasInternas({ notas, ajustes }) {
  const [verTodas, setVerTodas] = useState(false);
  const lista = verTodas ? notas : notas.slice(0, 3);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Lock size={12} /> Diagnóstico interno
        </p>
        {notas.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">Sin notas todavía. Agrégalas al registrar una reunión o un ajuste.</p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {lista.map((n) => (
              <li key={n.id} className="border-l-2 border-orange-400/60 pl-3">
                <p className="whitespace-pre-line text-xs text-slate-700">{n.nota}</p>
                <p className="mt-0.5 text-[10px] text-slate-400">
                  {formatoFechaHora(n.creado_en)}
                  {n.autor_nombre ? ` · ${n.autor_nombre}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
        {notas.length > 3 && (
          <button type="button" onClick={() => setVerTodas((v) => !v)} className="mt-2 text-[11px] font-bold text-orange-500 hover:underline">
            {verTodas ? 'Ver menos' : `Ver las ${notas.length} notas`}
          </button>
        )}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ajustes</p>
        {ajustes.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">Sin bonificaciones ni correcciones.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200">
            {ajustes.slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                <span className="min-w-0">
                  <span className="block truncate text-slate-700" title={a.motivo}>
                    {a.motivo}
                  </span>
                  <span className="text-[10px] text-slate-400">{formatoFechaHora(a.creado_en)}</span>
                </span>
                <span className={`shrink-0 font-black ${Number(a.minutos) > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{formatoMinutosConSigno(a.minutos)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Panel principal
// -----------------------------------------------------------------------------
export default function AdminSoporte({ onToast }) {
  const [acceso, setAcceso] = useState('verificando'); // 'verificando' | 'permitido' | 'denegado'
  const [vista, setVista] = useState('clubes'); // 'clubes' | 'agenda'
  const [clubes, setClubes] = useState([]);
  const [cargandoClubes, setCargandoClubes] = useState(false);
  const [error, setError] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [filtroClubes, setFiltroClubes] = useState('todos'); // 'todos' | 'saldo_bajo' | 'con_cita'
  const [clubSelId, setClubSelId] = useState(null);
  const [bolsaSel, setBolsaSel] = useState(null);
  const [ticketsSel, setTicketsSel] = useState([]);
  const [notasSel, setNotasSel] = useState([]);
  const [ajustesSel, setAjustesSel] = useState([]);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [agenda, setAgenda] = useState([]); // citas del mes visible (cuadrícula de 6 semanas)
  const [cargandoAgenda, setCargandoAgenda] = useState(false);
  const [citasProximas, setCitasProximas] = useState([]); // para el banner y el contador
  const [mesVista, setMesVista] = useState(() => {
    const h = new Date();
    return { anio: h.getFullYear(), mes: h.getMonth() };
  });
  const mesVistaRef = useRef(mesVista);
  mesVistaRef.current = mesVista;
  const [citaDetalle, setCitaDetalle] = useState(null);
  const [ahora, setAhora] = useState(() => new Date());
  const [modal, setModal] = useState(null); // { clubId?, ticket?, modo? } | null
  const [enVivo, setEnVivo] = useState(false);

  const clubSelIdRef = useRef(null);
  clubSelIdRef.current = clubSelId;
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  useEffect(() => {
    let vivo = true;
    consultarEsStaffQlubos().then((ok) => vivo && setAcceso(ok ? 'permitido' : 'denegado'));
    return () => {
      vivo = false;
    };
  }, []);

  const cargarClubes = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setCargandoClubes(true);
    const { data, error: err } = await listarClubesAdmin('');
    setCargandoClubes(false);
    if (err) {
      setError(mensajeError(err, 'No se pudo cargar la lista de clubes.'));
      return;
    }
    setError('');
    setClubes(data);
  }, []);

  const cargarDetalle = useCallback(async (clubId, { silencioso = false } = {}) => {
    if (clubId == null) return;
    if (!silencioso) setCargandoDetalle(true);
    const [b, t, n, a] = await Promise.all([obtenerBolsa(clubId), listarTickets(clubId), listarNotasInternas(clubId), listarAjustes(clubId)]);
    if (String(clubSelIdRef.current) !== String(clubId)) return;
    if (!b.error) setBolsaSel(b.data || null);
    if (!t.error) setTicketsSel(t.data);
    // Notas y ajustes son de la v95: si aún no existe, se omiten sin error.
    setNotasSel(n.error ? [] : n.data);
    setAjustesSel(a.error ? [] : a.data);
    if (b.error || t.error) setError(mensajeError(b.error || t.error));
    setCargandoDetalle(false);
  }, []);

  // Citas del mes visible (cualquier mes de cualquier año) + citas próximas
  // (para el banner "Reunión en curso" y el contador de la pestaña).
  const cargarAgenda = useCallback(async ({ silencioso = false, mes = null } = {}) => {
    if (!silencioso) setCargandoAgenda(true);
    const objetivo = mes || mesVistaRef.current;
    const rango = rangoCuadriculaMes(objetivo.anio, objetivo.mes);
    const base = Date.now();
    const [delMes, proximas] = await Promise.all([
      listarAgendaAdmin({ desde: rango.desde, hasta: rango.hasta, limite: 1000 }),
      listarAgendaAdmin({ desde: new Date(base - 2 * 3_600_000).toISOString(), hasta: new Date(base + 366 * 86_400_000).toISOString(), limite: 500 }),
    ]);
    // Si mientras tanto se cambió de mes, se descarta esta respuesta.
    const actual = mesVistaRef.current;
    if (!mes && (actual.anio !== objetivo.anio || actual.mes !== objetivo.mes)) return;
    setCargandoAgenda(false);
    if (delMes.error || proximas.error) {
      setError(mensajeError(delMes.error || proximas.error, 'No se pudo cargar la agenda.'));
      return;
    }
    setAgenda(delMes.data);
    setCitasProximas(proximas.data.filter((c) => c.estado === 'agendada'));
  }, []);

  function cambiarMesAgenda(siguiente) {
    setMesVista(siguiente);
    mesVistaRef.current = siguiente;
    setAgenda([]);
    cargarAgenda({ mes: siguiente });
  }

  // Carga inicial + Realtime (con un pequeño "debounce" para agrupar ráfagas
  // de cambios: un registro mueve ticket + bolsa casi al mismo tiempo).
  useEffect(() => {
    if (acceso !== 'permitido') return undefined;
    cargarClubes();
    cargarAgenda();
    let temporizador = null;
    // Respaldo del webhook: trae de la API de Cal.com las reservas que no
    // hayan llegado (si la Edge Function soporte-calcom-sync está desplegada).
    const sincronizar = () =>
      sincronizarCalcom(null).then((r) => {
        if (r?.registradas > 0) {
          cargarAgenda({ silencioso: true });
          cargarClubes({ silencioso: true });
        }
      });
    sincronizar();
    const refrescarTodo = () => {
      cargarClubes({ silencioso: true });
      cargarAgenda({ silencioso: true });
      const actual = clubSelIdRef.current;
      if (actual != null) cargarDetalle(actual, { silencioso: true });
    };
    const quitar = suscribirCambiosSoporte(null, () => {
      setEnVivo(true);
      clearTimeout(temporizador);
      temporizador = setTimeout(refrescarTodo, 400);
    });
    setEnVivo(true);
    // Respaldo silencioso (no es un botón): procesa No-Shows vencidos aunque
    // no esté activo pg_cron y cubre una reconexión de Realtime.
    const intervalo = setInterval(() => {
      refrescarTodo();
      sincronizar();
    }, REFRESCO_SILENCIOSO_MS);
    const reloj = setInterval(() => setAhora(new Date()), 30_000);
    return () => {
      quitar();
      clearTimeout(temporizador);
      clearInterval(intervalo);
      clearInterval(reloj);
    };
  }, [acceso, cargarClubes, cargarAgenda, cargarDetalle]);

  const clubesPorId = useMemo(() => new Map(clubes.map((c) => [String(c.club_id), c])), [clubes]);
  const clubSel = clubSelId != null ? clubesPorId.get(String(clubSelId)) || null : null;

  function seleccionarClub(clubId) {
    setClubSelId(clubId);
    clubSelIdRef.current = clubId;
    setBolsaSel(null);
    setTicketsSel([]);
    setNotasSel([]);
    setAjustesSel([]);
    cargarDetalle(clubId);
  }

  function verClubDesdeAgenda(clubId) {
    setVista('clubes');
    setFiltroClubes('todos');
    setBusqueda('');
    seleccionarClub(clubId);
  }

  function aplicarFiltro(f) {
    setVista('clubes');
    setFiltroClubes(f);
    if (f === 'todos') setBusqueda('');
  }

  const totales = useMemo(
    () => ({
      clubes: clubes.length,
      saldoBajo: clubes.filter(saldoCritico).length,
      conCita: clubes.filter(tieneCitaProxima).length,
    }),
    [clubes]
  );

  const clubesFiltrados = useMemo(() => {
    const q = normalizar(busqueda);
    let lista = clubes;
    if (filtroClubes === 'saldo_bajo') lista = lista.filter(saldoCritico);
    if (filtroClubes === 'con_cita') {
      lista = lista.filter(tieneCitaProxima).sort((a, b) => new Date(a.proxima_cita).getTime() - new Date(b.proxima_cita).getTime());
    }
    if (q) lista = lista.filter((c) => normalizar(c.nombre).includes(q) || String(c.club_id) === q);
    return lista;
  }, [clubes, busqueda, filtroClubes]);

  const destacada = useMemo(() => reunionDestacada(citasProximas, ahora), [citasProximas, ahora]);
  const proximasCount = useMemo(() => citasProximas.filter((c) => new Date(c.inicio).getTime() >= ahora.getTime() - 3_600_000).length, [citasProximas, ahora]);

  if (acceso === 'verificando') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-10 text-sm text-slate-500">
        <Loader2 size={16} className="animate-spin" /> Verificando permisos…
      </div>
    );
  }

  if (acceso === 'denegado') {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-10 text-center">
        <ShieldAlert size={26} className="mx-auto text-rose-500" />
        <p className="mt-2 text-sm font-black text-slate-900">Acceso restringido</p>
        <p className="mt-1 text-xs text-slate-500">Este panel es exclusivo para el equipo SuperAdmin de QLUBOS.</p>
      </div>
    );
  }

  const ETIQUETA_FILTRO = { saldo_bajo: `Saldo menor a ${SALDO_CRITICO_MIN} min`, con_cita: 'Con cita próxima' };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
          <LifeBuoy size={20} className="text-orange-500" /> Soporte
          {/* Indicador discreto de actualización en tiempo real (sin texto). */}
          <span
            title={enVivo ? 'Actualización en tiempo real activa' : 'Conectando…'}
            aria-label={enVivo ? 'Actualización en tiempo real activa' : 'Conectando'}
            className={`h-2 w-2 rounded-full ${enVivo ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
        </h1>
        <button
          type="button"
          onClick={() => setModal({ clubId: clubSelId ?? '' })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-400 px-3.5 py-2 text-xs font-black text-slate-950 shadow-sm hover:bg-orange-300"
        >
          <Plus size={14} /> Registrar reunión
          {clubSel && <span className="hidden max-w-[10rem] truncate font-semibold text-slate-800 sm:inline">· {clubSel.nombre}</span>}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <TarjetaMetricaFiltro etiqueta="Clubes" valor={totales.clubes} ayuda="Ver todos" textoActivo="Mostrando todos" activa={vista === 'clubes' && filtroClubes === 'todos'} onClick={() => aplicarFiltro('todos')} />
        <TarjetaMetricaFiltro
          etiqueta={`Saldo menor a ${SALDO_CRITICO_MIN} min`}
          valor={totales.saldoBajo}
          ayuda="Filtrar saldo crítico"
          tono="rose"
          activa={vista === 'clubes' && filtroClubes === 'saldo_bajo'}
          onClick={() => aplicarFiltro(filtroClubes === 'saldo_bajo' ? 'todos' : 'saldo_bajo')}
        />
        <TarjetaMetricaFiltro
          etiqueta="Con cita próxima"
          valor={totales.conCita}
          ayuda="Filtrar con reunión agendada"
          tono="sky"
          activa={vista === 'clubes' && filtroClubes === 'con_cita'}
          onClick={() => aplicarFiltro(filtroClubes === 'con_cita' ? 'todos' : 'con_cita')}
        />
      </div>

      <BannerReunion
        destacada={destacada}
        nombreClub={destacada ? clubesPorId.get(String(destacada.ticket.club_id))?.nombre || `Club ${destacada.ticket.club_id}` : ''}
        onVerClub={() => destacada && verClubDesdeAgenda(destacada.ticket.club_id)}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-500">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div role="tablist" aria-label="Vista del panel" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 sm:inline-grid sm:w-auto">
        {[
          { id: 'clubes', label: 'Vista Clubes', icon: Building2 },
          { id: 'agenda', label: 'Vista Agenda & Citas', icon: CalendarDays, badge: proximasCount },
        ].map((t) => {
          const Icono = t.icon;
          const activa = vista === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activa}
              onClick={() => setVista(t.id)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition sm:px-4 ${
                activa ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icono size={14} className={activa ? 'text-orange-500' : ''} /> {t.label}
              {t.badge > 0 && <span className="rounded-full bg-sky-400/15 px-1.5 text-[10px] font-black text-sky-500">{t.badge}</span>}
            </button>
          );
        })}
      </div>

      {vista === 'agenda' ? (
        <VistaAgenda
          citas={agenda}
          cargando={cargandoAgenda}
          clubesPorId={clubesPorId}
          ahora={ahora}
          mesVista={mesVista}
          onCambiarMes={cambiarMesAgenda}
          onVerClub={verClubDesdeAgenda}
          onAbrirCita={(c) => setCitaDetalle(c)}
          onRegistrar={(c) => setModal({ clubId: c.club_id, ticket: c })}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="space-y-2 lg:col-span-2">
            <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 focus-within:border-orange-400">
              <Search size={14} className="text-slate-500" />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar club por nombre o ID…"
                className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder-slate-400"
              />
            </div>
            {filtroClubes !== 'todos' && (
              <div className="flex items-center justify-between rounded-lg bg-orange-400/10 px-3 py-1.5 text-[11px] font-bold text-orange-600">
                <span>
                  Filtro: {ETIQUETA_FILTRO[filtroClubes]} · {clubesFiltrados.length} {clubesFiltrados.length === 1 ? 'club' : 'clubes'}
                </span>
                <button type="button" onClick={() => aplicarFiltro('todos')} className="inline-flex items-center gap-0.5 hover:underline">
                  <X size={12} /> Quitar
                </button>
              </div>
            )}
            <div className="max-h-[560px] divide-y divide-slate-200 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
              {cargandoClubes && clubes.length === 0 ? (
                <p className="flex items-center justify-center gap-2 p-6 text-xs text-slate-500">
                  <Loader2 size={14} className="animate-spin" /> Cargando clubes…
                </p>
              ) : clubesFiltrados.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500">
                  {filtroClubes === 'saldo_bajo' ? 'Ningún club con saldo crítico.' : filtroClubes === 'con_cita' ? 'Ningún club tiene citas próximas.' : 'Ningún club coincide.'}
                </p>
              ) : (
                clubesFiltrados.map((c) => {
                  const r = resumenBolsa(c);
                  const activo = String(clubSelId) === String(c.club_id);
                  return (
                    <button
                      key={c.club_id}
                      type="button"
                      onClick={() => seleccionarClub(c.club_id)}
                      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${activo ? 'bg-orange-400/10' : 'hover:bg-slate-50'}`}
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                        <Building2 size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900">{c.nombre}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          Plan {c.plan_canchas || '—'} · ID {c.club_id}
                          {c.proxima_cita ? ` · Cita: ${formatoFechaHora(c.proxima_cita)}` : ''}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-black ${r.saldoBajo ? 'text-rose-500' : 'text-slate-900'}`}>{formatoMinutos(r.disponibles)}</p>
                        <p className="text-[10px] text-slate-500">de {formatoMinutos(r.total)}</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="space-y-4 lg:col-span-3">
            {!clubSel ? (
              <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
                Selecciona un club para ver sus horas de soporte, su diagnóstico y su historial.
              </div>
            ) : (
              <>
                <div>
                  <p className="text-lg font-black text-slate-900">{clubSel.nombre}</p>
                  <p className="text-xs text-slate-500">
                    ID {clubSel.club_id} · Plan {clubSel.plan_canchas || '—'} · Renueva {formatoFecha(bolsaSel?.ciclo_fin || clubSel.ciclo_fin)}
                  </p>
                </div>
                {cargandoDetalle && !bolsaSel ? (
                  <div className="h-48 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
                ) : (
                  <WidgetBolsaHoras bolsa={bolsaSel || clubSel} />
                )}
                <PanelNotasInternas notas={notasSel} ajustes={ajustesSel} />
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Historial del club</p>
                <TablaHistorialSoporte tickets={ticketsSel} onAjustar={(t) => setModal({ clubId: clubSel.club_id, ticket: t })} />
              </>
            )}
          </div>
        </div>
      )}

      {citaDetalle && (
        <ModalDetalleCita
          cita={agenda.find((c) => c.id === citaDetalle.id) || citaDetalle}
          nombreClub={clubesPorId.get(String(citaDetalle.club_id))?.nombre || `Club ${citaDetalle.club_id}`}
          ahora={ahora}
          onClose={() => setCitaDetalle(null)}
          onVerClub={(clubId) => {
            setCitaDetalle(null);
            verClubDesdeAgenda(clubId);
          }}
          onRegistrar={(c, estado) => {
            setCitaDetalle(null);
            setModal({ clubId: c.club_id, ticket: c, estado });
          }}
        />
      )}

      {modal && (
        <ModalRegistrarAtencion
          clubes={clubes}
          clubIdInicial={modal.clubId ?? ''}
          ticketInicial={modal.ticket || null}
          modoInicial={modal.modo || 'atencion'}
          estadoInicial={modal.estado || null}
          onClose={() => setModal(null)}
          onGuardado={(r) => {
            if (r?.modo === 'ajuste') {
              toastRef.current?.({ titulo: 'Ajuste aplicado', detalle: `${formatoMinutosConSigno(r.ajuste?.minutos)} en las horas de soporte del club.` });
            } else {
              toastRef.current?.({ titulo: 'Reunión registrada', detalle: `Se descontaron ${formatoMinutos(r?.ticket?.minutos_consumidos)} de las horas de soporte.` });
            }
            cargarClubes({ silencioso: true });
            cargarAgenda({ silencioso: true });
            if (r?.clubId != null) {
              if (String(clubSelIdRef.current) !== String(r.clubId) && vista === 'clubes') seleccionarClub(r.clubId);
              else cargarDetalle(r.clubId, { silencioso: true });
            }
          }}
        />
      )}
    </div>
  );
}
