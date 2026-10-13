// =============================================================================
// SuperAdmin — Logs del sistema y notificaciones
//   • Log de actividad (public.log_actividad) de todos los clubes, con filtros
//     por fecha, club y tipo de evento.
//   • Estado de notificaciones enviadas (notificaciones_club y
//     notificaciones_jugador): totales, leídas, por tipo y recientes.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollText, Bell } from 'lucide-react';
import { listarLogGlobal, listarSaludClubes, resumenNotificaciones, mensajeErrorAdmin } from './adminApi';
import { AvisoError, Cargando, Chips, EncabezadoModulo, Metrica, Pastilla, Vacio, claseInput, formatoFechaHoraCorta } from './adminUi';

function hoyLocal(desplazamientoDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + desplazamientoDias);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inicioDia(fechaLocal) {
  if (!fechaLocal) return null;
  const [y, m, d] = fechaLocal.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

function resumenDetalle(detalle) {
  if (!detalle || typeof detalle !== 'object') return '';
  return Object.entries(detalle)
    .filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join(' · ');
}

function etiquetaTipo(tipo) {
  return String(tipo || 'evento').replace(/_/g, ' ');
}

function VistaLog() {
  const [clubes, setClubes] = useState([]);
  const [desde, setDesde] = useState(hoyLocal(-7));
  const [hasta, setHasta] = useState(hoyLocal(0));
  const [clubId, setClubId] = useState('');
  const [tipo, setTipo] = useState('');
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listarSaludClubes(30).then(({ data }) => setClubes(data || []));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    const finDia = hasta ? new Date(new Date(inicioDia(hasta)).getTime() + 86_400_000).toISOString() : null;
    const { data, error: err } = await listarLogGlobal({ desde: inicioDia(desde), hasta: finDia, clubId: clubId || null, tipo: tipo || null, limite: 1000 });
    setCargando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudo cargar el log.'));
    setError('');
    setFilas(data);
  }, [desde, hasta, clubId, tipo]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const tipos = useMemo(() => [...new Set(filas.map((f) => f.tipo).filter(Boolean))].sort(), [filas]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <label className="block">
          <span className="text-[11px] font-bold text-slate-500">Desde</span>
          <input type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} className={`${claseInput} mt-1`} />
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-slate-500">Hasta</span>
          <input type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} className={`${claseInput} mt-1`} />
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-slate-500">Club</span>
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} className={`${claseInput} mt-1`}>
            <option value="">Todos los clubes</option>
            {clubes.map((c) => (
              <option key={c.club_id} value={c.club_id}>
                {c.nombre} · ID {c.club_id}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-slate-500">Tipo de evento</span>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={`${claseInput} mt-1`}>
            <option value="">Todos</option>
            {[...new Set([...tipos, tipo].filter(Boolean))].map((t) => (
              <option key={t} value={t}>
                {etiquetaTipo(t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <AvisoError texto={error} />
      {cargando ? (
        <Cargando texto="Cargando log…" />
      ) : filas.length === 0 ? (
        <Vacio texto="Sin eventos con estos filtros." />
      ) : (
        <>
          <p className="text-[11px] text-slate-500">
            {filas.length} {filas.length === 1 ? 'evento' : 'eventos'}
            {filas.length >= 1000 ? ' (se muestran los 1,000 más recientes; acota el rango para ver más)' : ''}
          </p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Fecha</th>
                  <th className="px-4 py-2.5 font-semibold">Club</th>
                  <th className="px-4 py-2.5 font-semibold">Evento</th>
                  <th className="px-4 py-2.5 font-semibold">Operador</th>
                  <th className="px-4 py-2.5 font-semibold">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filas.map((f, i) => (
                  <tr key={f.id || i} className="align-top text-slate-700">
                    <td className="whitespace-nowrap px-4 py-2 text-xs">{formatoFechaHoraCorta(f.created_at)}</td>
                    <td className="max-w-[180px] truncate px-4 py-2 text-xs font-semibold">{f.club_nombre}</td>
                    <td className="px-4 py-2">
                      <button type="button" onClick={() => setTipo(f.tipo || '')} className="capitalize" title="Filtrar por este tipo">
                        <Pastilla clase="bg-orange-400/10 text-orange-600 ring-orange-400/30">{etiquetaTipo(f.tipo)}</Pastilla>
                      </button>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {f.empleado_nombre || '—'}
                      {f.empleado_rol ? <span className="text-slate-400"> · {f.empleado_rol}</span> : null}
                    </td>
                    <td className="max-w-[320px] px-4 py-2 text-[11px] text-slate-500" title={JSON.stringify(f.detalle || {})}>
                      <span className="line-clamp-2">{resumenDetalle(f.detalle) || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function TarjetaNotificaciones({ titulo, bloque }) {
  if (!bloque?.existe) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">
        <p className="font-bold text-slate-700">{titulo}</p>La tabla no existe en este proyecto.
      </div>
    );
  }
  const total = Number(bloque.total) || 0;
  const leidas = Number(bloque.leidas) || 0;
  const pct = total ? Math.round((leidas / total) * 100) : 0;
  const tipos = Object.entries(bloque.por_tipo || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-black text-slate-900">{titulo}</p>
      <div className="grid grid-cols-3 gap-2">
        <Metrica etiqueta="Enviadas" valor={total} />
        <Metrica etiqueta="Leídas" valor={`${pct}%`} tono="emerald" ayuda={`${leidas} de ${total}`} />
        <Metrica etiqueta="Sin leer" valor={Number(bloque.no_leidas) || 0} tono="amber" />
      </div>
      {tipos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tipos.map(([t, n]) => (
            <Pastilla key={t}>
              <span className="capitalize">{etiquetaTipo(t)}</span>&nbsp;· {n}
            </Pastilla>
          ))}
        </div>
      )}
      <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
        {(bloque.recientes || []).length === 0 ? (
          <p className="p-4 text-center text-xs text-slate-500">Sin notificaciones en el periodo.</p>
        ) : (
          bloque.recientes.map((n) => (
            <div key={n.id} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-800">{n.titulo || etiquetaTipo(n.tipo)}</p>
                <p className="truncate text-[11px] text-slate-500">
                  {n.club_nombre || `Club ${n.club_id}`} · {formatoFechaHoraCorta(n.created_at)}
                </p>
              </div>
              <Pastilla clase={n.leida ? 'bg-emerald-400/10 text-emerald-600 ring-emerald-400/30' : 'bg-amber-400/10 text-amber-600 ring-amber-400/30'}>
                {n.leida ? 'Leída' : 'Sin leer'}
              </Pastilla>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function VistaNotificaciones() {
  const [dias, setDias] = useState(7);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let vivo = true;
    setDatos(null);
    resumenNotificaciones(dias).then(({ data, error: err }) => {
      if (!vivo) return;
      if (err) setError(mensajeErrorAdmin(err));
      else {
        setError('');
        setDatos(data);
      }
    });
    return () => {
      vivo = false;
    };
  }, [dias]);
  return (
    <div className="space-y-3">
      <Chips
        opciones={[
          { id: 1, label: 'Hoy' },
          { id: 7, label: '7 días' },
          { id: 30, label: '30 días' },
        ]}
        valor={dias}
        onCambiar={setDias}
      />
      <AvisoError texto={error} />
      {!datos && !error ? (
        <Cargando />
      ) : datos ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <TarjetaNotificaciones titulo="Notificaciones a clubes" bloque={datos.notificaciones_club} />
          <TarjetaNotificaciones titulo="Notificaciones a jugadores" bloque={datos.notificaciones_jugador} />
        </div>
      ) : null}
    </div>
  );
}

export default function AdminLogs() {
  const [vista, setVista] = useState('log');
  return (
    <div className="space-y-4">
      <EncabezadoModulo icono={ScrollText} titulo="Logs y auditoría" descripcion="Actividad registrada en todos los clubes y estado de las notificaciones." />
      <div role="tablist" className="inline-grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
        {[
          { id: 'log', label: 'Log de actividad', icon: ScrollText },
          { id: 'notificaciones', label: 'Notificaciones', icon: Bell },
        ].map((t) => {
          const Icono = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={vista === t.id}
              onClick={() => setVista(t.id)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition ${
                vista === t.id ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icono size={14} className={vista === t.id ? 'text-orange-500' : ''} /> {t.label}
            </button>
          );
        })}
      </div>
      {vista === 'log' ? <VistaLog /> : <VistaNotificaciones />}
    </div>
  );
}
