// =============================================================================
// SuperAdmin QLUBOS — piezas de UI compartidas (mismo lenguaje visual que
// el resto del panel: slate + naranja, compatible con el Modo Oscuro global).
// =============================================================================
import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export const claseInput =
  'w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition placeholder-slate-400 focus:border-orange-400 focus:ring-1 focus:ring-orange-400';

export const claseBotonPrimario =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-orange-400 px-3.5 py-2 text-xs font-black text-slate-950 shadow-sm transition hover:bg-orange-300 disabled:opacity-60';

export const claseBotonSecundario =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:border-orange-300 hover:text-orange-500 disabled:opacity-50';

export function EncabezadoModulo({ icono: Icono, titulo, descripcion, acciones }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-black text-slate-900">
          {Icono && <Icono size={18} className="text-orange-500" />} {titulo}
        </h2>
        {descripcion && <p className="mt-0.5 text-xs text-slate-500">{descripcion}</p>}
      </div>
      {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
    </div>
  );
}

const TONOS = {
  orange: 'text-orange-500',
  sky: 'text-sky-500',
  emerald: 'text-emerald-500',
  rose: 'text-rose-500',
  amber: 'text-amber-500',
  slate: 'text-slate-700',
  violet: 'text-violet-500',
};

export function Metrica({ etiqueta, valor, ayuda, tono = 'orange', activa = false, onClick }) {
  const contenido = (
    <>
      <p className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-slate-500">{etiqueta}</p>
      <p className={`mt-0.5 text-2xl font-black ${TONOS[tono] || TONOS.orange}`}>{valor}</p>
      {ayuda && <p className="mt-0.5 truncate text-[10px] font-semibold text-slate-400">{ayuda}</p>}
    </>
  );
  const base = 'rounded-2xl border bg-white px-4 py-3 text-left';
  if (!onClick) return <div className={`${base} border-slate-200`}>{contenido}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activa}
      className={`${base} transition hover:-translate-y-0.5 hover:shadow-md ${activa ? 'border-orange-400/60 shadow-lg ring-2 ring-orange-400' : 'border-slate-200'}`}
    >
      {contenido}
    </button>
  );
}

export function AvisoError({ texto }) {
  if (!texto) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-500">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{texto}</span>
    </div>
  );
}

export function Cargando({ texto = 'Cargando…' }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-10 text-sm text-slate-500">
      <Loader2 size={16} className="animate-spin" /> {texto}
    </div>
  );
}

export function Vacio({ texto }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">{texto}</div>;
}

export function Pastilla({ children, clase = 'bg-slate-400/10 text-slate-500 ring-slate-400/30' }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${clase}`}>{children}</span>;
}

export function Chips({ opciones, valor, onCambiar }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {opciones.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onCambiar(o.id)}
          aria-pressed={valor === o.id}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
            valor === o.id ? 'bg-orange-400 text-slate-950' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900'
          }`}
        >
          {o.label}
          {o.cuenta != null && <span className={valor === o.id ? 'ml-1 text-slate-800' : 'ml-1 text-slate-400'}>{o.cuenta}</span>}
        </button>
      ))}
    </div>
  );
}

export function formatoFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatoFechaHoraCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function haceCuanto(iso, ahora = new Date()) {
  if (!iso) return 'nunca';
  const ms = new Date(ahora).getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const dias = Math.floor(ms / 86_400_000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'hace 1 mes' : `hace ${meses} meses`;
}

export function formatoMXN(monto) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(monto) || 0);
}

// Tamaño del club a partir del texto libre de canchas del lead ("1 – 3 canchas").
export function tamanoDesdeCanchas(texto) {
  const t = String(texto || '').toLowerCase();
  if (!t) return 'sin_dato';
  if (/m[aá]s de 12|varias|sedes|\+ ?12/.test(t)) return '12+';
  const nums = (t.match(/\d+/g) || []).map(Number);
  if (!nums.length) return 'sin_dato';
  const max = Math.max(...nums);
  if (max <= 3) return '1-3';
  if (max <= 7) return '4-7';
  if (max <= 12) return '8-12';
  return '12+';
}
