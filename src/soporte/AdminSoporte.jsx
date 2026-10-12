// =============================================================================
// Soporte & Acompañamiento — Panel SuperAdmin (/admin/soporte)
// Exclusivo para staff de QLUBOS (tabla plataforma_staff). El candado real
// está en Supabase (RLS + funciones que validan fn_soporte_es_staff); esta
// pantalla además vuelve a consultar el rol antes de mostrar nada.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, Search, Plus, RefreshCw, AlertTriangle, ShieldAlert, Loader2, Building2 } from 'lucide-react';
import { formatoFecha, formatoFechaHora, formatoMinutos, resumenBolsa } from './soporteReglas';
import {
  consultarEsStaffQlubos,
  listarClubesAdmin,
  listarTickets,
  obtenerBolsa,
  suscribirCambiosSoporte,
  mensajeError,
} from './soporteApi';
import { ModalRegistrarAtencion } from './SoporteModal';
import { WidgetBolsaHoras, TablaHistorialSoporte } from './Soporte';

function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export default function AdminSoporte({ onToast }) {
  const [acceso, setAcceso] = useState('verificando'); // 'verificando' | 'permitido' | 'denegado'
  const [clubes, setClubes] = useState([]);
  const [cargandoClubes, setCargandoClubes] = useState(false);
  const [error, setError] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [clubSel, setClubSel] = useState(null);
  const [bolsaSel, setBolsaSel] = useState(null);
  const [ticketsSel, setTicketsSel] = useState([]);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [modal, setModal] = useState(null); // { ticket?: object } | null
  const clubSelRef = useRef(null);
  clubSelRef.current = clubSel;
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  useEffect(() => {
    let vivo = true;
    consultarEsStaffQlubos().then((ok) => vivo && setAcceso(ok ? 'permitido' : 'denegado'));
    return () => {
      vivo = false;
    };
  }, []);

  const cargarClubes = useCallback(async () => {
    setCargandoClubes(true);
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
    const [b, t] = await Promise.all([obtenerBolsa(clubId), listarTickets(clubId)]);
    if (String(clubSelRef.current?.club_id) !== String(clubId)) return;
    if (!b.error) setBolsaSel(b.data || null);
    if (!t.error) setTicketsSel(t.data);
    if (b.error || t.error) setError(mensajeError(b.error || t.error));
    setCargandoDetalle(false);
  }, []);

  useEffect(() => {
    if (acceso !== 'permitido') return undefined;
    cargarClubes();
    const quitar = suscribirCambiosSoporte(null, () => {
      cargarClubes();
      const actual = clubSelRef.current;
      if (actual) cargarDetalle(actual.club_id, { silencioso: true });
    });
    return quitar;
  }, [acceso, cargarClubes, cargarDetalle]);

  function seleccionar(club) {
    setClubSel(club);
    setBolsaSel(null);
    setTicketsSel([]);
    clubSelRef.current = club;
    cargarDetalle(club.club_id);
  }

  const clubesFiltrados = useMemo(() => {
    const q = normalizar(busqueda);
    if (!q) return clubes;
    return clubes.filter((c) => normalizar(c.nombre).includes(q) || String(c.club_id) === q);
  }, [clubes, busqueda]);

  const totales = useMemo(() => {
    const saldoBajo = clubes.filter((c) => (Number(c.minutos_disponibles_mes) || 0) < 30).length;
    const conCita = clubes.filter((c) => c.proxima_cita).length;
    return { clubes: clubes.length, saldoBajo, conCita };
  }, [clubes]);

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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Headphones size={14} /> Panel SuperAdmin · Soporte
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => cargarClubes()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:border-orange-300 hover:text-orange-500"
          >
            <RefreshCw size={13} className={cargandoClubes ? 'animate-spin' : ''} /> Actualizar
          </button>
          <button
            type="button"
            onClick={() => setModal({})}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-400 px-3 py-1.5 text-xs font-black text-slate-950 hover:bg-orange-300"
          >
            <Plus size={14} /> Registrar / Ajustar Atención
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Metrica etiqueta="Clubes" valor={totales.clubes} />
        <Metrica etiqueta="Saldo menor a 30 min" valor={totales.saldoBajo} tono="rose" />
        <Metrica etiqueta="Con cita próxima" valor={totales.conCita} tono="sky" />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-500">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

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
          <div className="max-h-[560px] divide-y divide-slate-200 overflow-y-auto rounded-2xl border border-slate-200 bg-white">
            {cargandoClubes && clubes.length === 0 ? (
              <p className="flex items-center justify-center gap-2 p-6 text-xs text-slate-500">
                <Loader2 size={14} className="animate-spin" /> Cargando clubes…
              </p>
            ) : clubesFiltrados.length === 0 ? (
              <p className="p-6 text-center text-xs text-slate-500">Ningún club coincide.</p>
            ) : (
              clubesFiltrados.map((c) => {
                const r = resumenBolsa(c);
                const activo = String(clubSel?.club_id) === String(c.club_id);
                return (
                  <button
                    key={c.club_id}
                    type="button"
                    onClick={() => seleccionar(c)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${activo ? 'bg-orange-400/10' : 'hover:bg-slate-50'}`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Building2 size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{c.nombre}</p>
                      <p className="text-[11px] text-slate-500">
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
              Selecciona un club para ver su bolsa de horas y su historial.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-lg font-black text-slate-900">{clubSel.nombre}</p>
                  <p className="text-xs text-slate-500">
                    ID {clubSel.club_id} · Plan {clubSel.plan_canchas || '—'} · Renueva {formatoFecha(bolsaSel?.ciclo_fin || clubSel.ciclo_fin)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setModal({ clubId: clubSel.club_id })}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/40 bg-orange-400/10 px-3 py-1.5 text-xs font-bold text-orange-500 hover:bg-orange-400/20"
                >
                  <Plus size={14} /> Registrar atención
                </button>
              </div>
              {cargandoDetalle && !bolsaSel ? (
                <div className="h-48 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" />
              ) : (
                <WidgetBolsaHoras bolsa={bolsaSel || clubSel} />
              )}
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Historial del club</p>
              <TablaHistorialSoporte tickets={ticketsSel} onAjustar={(t) => setModal({ clubId: clubSel.club_id, ticket: t })} />
            </>
          )}
        </div>
      </div>

      {modal && (
        <ModalRegistrarAtencion
          clubes={clubes}
          clubIdInicial={modal.clubId ?? clubSel?.club_id ?? ''}
          ticketsDelClub={String(modal.clubId ?? clubSel?.club_id) === String(clubSel?.club_id) ? ticketsSel : []}
          ticketInicial={modal.ticket || null}
          onClose={() => setModal(null)}
          onGuardado={(t) => {
            toastRef.current?.({ titulo: 'Atención guardada', detalle: `Se descontaron ${formatoMinutos(t?.minutos_consumidos)} de la bolsa.` });
            cargarClubes();
            const objetivo = t?.club_id ?? modal.clubId;
            const club = clubes.find((c) => String(c.club_id) === String(objetivo));
            if (club && String(clubSelRef.current?.club_id) !== String(objetivo)) seleccionar(club);
            else if (objetivo != null) cargarDetalle(objetivo, { silencioso: true });
          }}
        />
      )}
    </div>
  );
}

function Metrica({ etiqueta, valor, tono = 'orange' }) {
  const color = tono === 'rose' ? 'text-rose-500' : tono === 'sky' ? 'text-sky-500' : 'text-orange-500';
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{etiqueta}</p>
      <p className={`text-2xl font-black ${color}`}>{valor}</p>
    </div>
  );
}
