// =============================================================================
// SuperAdmin — Clubes y suscripciones (SaaS Health)
// Lee configuracion_club + actividad de reservas y log_actividad por club
// (fn_admin_salud_clubes). Solo lectura: no toca la operación de los clubes.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Search, Activity } from 'lucide-react';
import { listarSaludClubes, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import { AvisoError, Cargando, Chips, EncabezadoModulo, Metrica, Pastilla, Vacio, formatoFechaCorta, formatoMXN, haceCuanto } from './adminUi';

const DIA = 86_400_000;

export function estadoSaludClub(c, ahora = Date.now()) {
  if (c.eliminado) return { id: 'eliminado', label: 'Eliminado', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' };
  const fin = c.fecha_fin_prueba ? new Date(c.fecha_fin_prueba).getTime() : null;
  if (c.estado_suscripcion === 'bloqueada' || (c.estado_suscripcion === 'prueba' && fin != null && fin < ahora)) {
    return { id: 'vencido', label: 'Prueba vencida', clase: 'bg-rose-500/10 text-rose-500 ring-rose-500/30' };
  }
  if (c.estado_suscripcion === 'prueba') {
    const dias = fin != null ? Math.ceil((fin - ahora) / DIA) : null;
    const porVencer = dias != null && dias <= 7;
    return {
      id: 'prueba',
      porVencer,
      dias,
      label: dias != null ? `Prueba · ${dias} ${dias === 1 ? 'día' : 'días'}` : 'En prueba',
      clase: porVencer ? 'bg-amber-400/10 text-amber-600 ring-amber-400/30' : 'bg-sky-400/10 text-sky-600 ring-sky-400/30',
    };
  }
  return { id: 'activo', label: 'Plan activo', clase: 'bg-emerald-400/10 text-emerald-600 ring-emerald-400/30' };
}

export function clubInactivo(c) {
  return !c.eliminado && Number(c.reservas_periodo) === 0 && Number(c.eventos_periodo) === 0;
}

function normalizar(t) {
  return String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export default function AdminClubes() {
  const [clubes, setClubes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [dias, setDias] = useState(30);
  const [filtro, setFiltro] = useState('todos');
  const [busqueda, setBusqueda] = useState('');

  const cargar = useCallback(
    async ({ silencioso = false } = {}) => {
      if (!silencioso) setCargando(true);
      const { data, error: err } = await listarSaludClubes(dias);
      setCargando(false);
      if (err) return setError(mensajeErrorAdmin(err, 'No se pudo cargar la salud de los clubes.'));
      setError('');
      setClubes(data);
    },
    [dias]
  );

  useEffect(() => {
    cargar();
    let t = null;
    const quitar = suscribirTablas(['configuracion_club'], () => {
      clearTimeout(t);
      t = setTimeout(() => cargar({ silencioso: true }), 800);
    });
    return () => {
      clearTimeout(t);
      quitar();
    };
  }, [cargar]);

  const ahora = Date.now();
  const resumen = useMemo(() => {
    const r = { total: 0, activo: 0, prueba: 0, porVencer: 0, vencido: 0, inactivo: 0, onboarding: 0, mrr: 0 };
    clubes.forEach((c) => {
      const e = estadoSaludClub(c, ahora);
      if (e.id === 'eliminado') return;
      r.total += 1;
      r[e.id] += 1;
      if (e.porVencer) r.porVencer += 1;
      if (clubInactivo(c)) r.inactivo += 1;
      if (c.onboarding_completed === false) r.onboarding += 1;
      if (e.id === 'activo') r.mrr += Number(c.plan_precio_mensual) || 0;
    });
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubes]);

  const visibles = useMemo(() => {
    const q = normalizar(busqueda.trim());
    return clubes
      .filter((c) => {
        const e = estadoSaludClub(c, ahora);
        if (filtro === 'todos' && e.id === 'eliminado') return false;
        if (filtro === 'por_vencer' && !e.porVencer) return false;
        if (filtro === 'inactivo' && !clubInactivo(c)) return false;
        if (filtro === 'onboarding' && c.onboarding_completed !== false) return false;
        if (['activo', 'prueba', 'vencido', 'eliminado'].includes(filtro) && e.id !== filtro) return false;
        if (q && !normalizar(`${c.nombre} ${c.club_id} ${c.propietario_email} ${c.slug}`).includes(q)) return false;
        return true;
      })
      .sort((a, b) => Number(b.reservas_periodo) - Number(a.reservas_periodo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubes, filtro, busqueda]);

  return (
    <div className="space-y-4">
      <EncabezadoModulo
        icono={Building2}
        titulo="Clubes y suscripciones"
        descripcion="Salud de la base de clubes: plan, periodo de prueba y actividad reciente."
        acciones={
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Periodo de actividad" className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700">
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                Actividad: últimos {d} días
              </option>
            ))}
          </select>
        }
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 sm:gap-3">
        <Metrica etiqueta="Clubes" valor={resumen.total} onClick={() => setFiltro('todos')} activa={filtro === 'todos'} />
        <Metrica etiqueta="Plan activo" valor={resumen.activo} tono="emerald" onClick={() => setFiltro('activo')} activa={filtro === 'activo'} />
        <Metrica etiqueta="En prueba" valor={resumen.prueba} tono="sky" ayuda={`${resumen.porVencer} por vencer (≤7 días)`} onClick={() => setFiltro('prueba')} activa={filtro === 'prueba'} />
        <Metrica etiqueta="Prueba vencida" valor={resumen.vencido} tono="rose" onClick={() => setFiltro('vencido')} activa={filtro === 'vencido'} />
        <Metrica etiqueta={`Sin actividad (${dias} d)`} valor={resumen.inactivo} tono="amber" onClick={() => setFiltro('inactivo')} activa={filtro === 'inactivo'} />
        <Metrica etiqueta="MRR estimado" valor={formatoMXN(resumen.mrr)} tono="violet" ayuda="Suma de planes activos" />
      </div>
      <AvisoError texto={error} />
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <Chips
          opciones={[
            { id: 'todos', label: 'Todos' },
            { id: 'por_vencer', label: 'Prueba por vencer', cuenta: resumen.porVencer },
            { id: 'onboarding', label: 'Onboarding pendiente', cuenta: resumen.onboarding },
            { id: 'eliminado', label: 'Eliminados' },
          ]}
          valor={['todos', 'por_vencer', 'onboarding', 'eliminado'].includes(filtro) ? filtro : ''}
          onCambiar={setFiltro}
        />
        <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 lg:w-72">
          <Search size={14} className="text-slate-500" />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar club, ID o correo…" className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder-slate-400" />
        </div>
      </div>

      {cargando && clubes.length === 0 ? (
        <Cargando texto="Cargando clubes…" />
      ) : visibles.length === 0 ? (
        <Vacio texto="Ningún club coincide con el filtro." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Club</th>
                <th className="px-4 py-2.5 font-semibold">Plan</th>
                <th className="px-4 py-2.5 font-semibold">Suscripción</th>
                <th className="px-4 py-2.5 text-right font-semibold">Reservas ({dias} d)</th>
                <th className="px-4 py-2.5 font-semibold">Última reserva</th>
                <th className="px-4 py-2.5 font-semibold">Última actividad</th>
                <th className="px-4 py-2.5 font-semibold">Alta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {visibles.map((c) => {
                const e = estadoSaludClub(c, ahora);
                const inactivo = clubInactivo(c);
                return (
                  <tr key={c.club_id} className="text-slate-700">
                    <td className="px-4 py-2.5">
                      <p className="max-w-[240px] truncate font-bold text-slate-900">{c.nombre}</p>
                      <p className="max-w-[240px] truncate text-[11px] text-slate-500">
                        ID {c.club_id}
                        {c.propietario_email ? ` · ${c.propietario_email}` : ' · sin dueño'}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <p className="font-semibold">{c.plan_nombre || (c.plan_canchas ? `${c.plan_canchas} canchas` : '—')}</p>
                      {c.plan_precio_mensual ? <p className="text-[11px] text-slate-500">{formatoMXN(c.plan_precio_mensual)}/mes</p> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <Pastilla clase={e.clase}>{e.label}</Pastilla>
                        {c.onboarding_completed === false && <Pastilla clase="bg-violet-400/10 text-violet-600 ring-violet-400/30">Onboarding</Pastilla>}
                      </div>
                      {c.codigo_promo_usado && <p className="mt-0.5 font-mono text-[10px] text-slate-400">{c.codigo_promo_usado}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`inline-flex items-center gap-1 text-sm font-black ${inactivo ? 'text-amber-600' : 'text-slate-900'}`}>
                        {inactivo && <Activity size={13} />} {c.reservas_periodo}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs">{c.ultima_reserva ? haceCuanto(c.ultima_reserva) : 'nunca'}</td>
                    <td className="px-4 py-2.5 text-xs">{c.ultima_actividad ? haceCuanto(c.ultima_actividad) : 'nunca'}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatoFechaCorta(c.creado_en)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
