// =============================================================================
// SuperAdmin — CRM de Leads (public.leads_landing + crm_leads_seguimiento)
// Embudo: Nuevo → Contactado → Demo agendada → En prueba → Convertido / Perdido.
// Leads de la landing + registro manual (visita presencial / venta directa,
// fn_admin_crear_lead de migracion_v98).
//
// Rediseño visual (v2): una sola fila de filtros arriba que acota TODO lo de
// abajo (KPIs, gráficas y Kanban), tarjetas KPI con píldora de variación vs el
// periodo anterior, gráfica de tendencia (nuevos vs convertidos) y embudo de
// conversión por etapa — en SVG propio, sin dependencias nuevas. Paleta de las
// gráficas validada (CVD/contraste) en modo claro y oscuro: naranja #ea580c
// (Nuevos, marca QLUBOS) y esmeralda #059669 (Convertidos).
// La funcionalidad es la misma de siempre: filtro por canchas, búsqueda,
// cambio rápido de estatus, notas internas, alta manual y conversión a club.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Users2,
  Search,
  MessageCircle,
  Mail,
  Rocket,
  Loader2,
  MapPin,
  LayoutGrid,
  UserPlus,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Clock,
  Building2,
  Phone,
} from 'lucide-react';
import { ModalSoporte } from '../soporte/SoporteModal';
import { listarLeads, cambiarEstadoLead, convertirLead, crearLeadManual, ORIGENES_LEAD_MANUAL, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import {
  AvisoError,
  Cargando,
  EncabezadoModulo,
  claseBotonPrimario,
  claseBotonSecundario,
  claseInput,
  formatoFechaCorta,
  haceCuanto,
  tamanoDesdeCanchas,
} from './adminUi';

export const ETAPAS_LEAD = [
  { id: 'nuevo', label: 'Nuevo Lead', color: 'border-t-sky-400', punto: 'bg-sky-400', pastilla: 'bg-sky-400/10 text-sky-600 ring-sky-400/30' },
  { id: 'contactado', label: 'Contactado', color: 'border-t-violet-400', punto: 'bg-violet-400', pastilla: 'bg-violet-400/10 text-violet-600 ring-violet-400/30' },
  { id: 'demo_agendada', label: 'Demo Agendada', color: 'border-t-amber-400', punto: 'bg-amber-400', pastilla: 'bg-amber-400/10 text-amber-600 ring-amber-400/30' },
  { id: 'en_prueba', label: 'En Prueba Gratis', color: 'border-t-orange-400', punto: 'bg-orange-400', pastilla: 'bg-orange-400/10 text-orange-600 ring-orange-400/30' },
  { id: 'convertido', label: 'Convertido', color: 'border-t-emerald-500', punto: 'bg-emerald-500', pastilla: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30' },
  { id: 'perdido', label: 'Perdido', color: 'border-t-slate-400', punto: 'bg-slate-400', pastilla: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' },
];
const ETAPA_POR_ID = Object.fromEntries(ETAPAS_LEAD.map((e) => [e.id, e]));
const ETIQUETA_ETAPA = Object.fromEntries(ETAPAS_LEAD.map((e) => [e.id, e.label]));
// Orden del embudo (Perdido queda fuera: se reporta aparte).
const ETAPAS_EMBUDO = ['nuevo', 'contactado', 'demo_agendada', 'en_prueba', 'convertido'];
const INDICE_EMBUDO = Object.fromEntries(ETAPAS_EMBUDO.map((id, i) => [id, i]));
// "Convertido" = cliente final. Los leads En Prueba Gratis NO cuentan como
// convertidos (ni en la gráfica, ni en el KPI, ni en el embudo).
const esConvertido = (lead) => String(lead?.estado ?? '').trim().toLowerCase() === 'convertido';

const TAMANOS = [
  { id: 'todos', label: 'Todos' },
  { id: '1-3', label: '1–3 canchas' },
  { id: '4-7', label: '4–7 canchas' },
  { id: '8-12', label: '8–12 canchas' },
  { id: '12+', label: 'Más de 12' },
  { id: 'sin_dato', label: 'Sin dato' },
];

const PERIODOS = [
  { id: 7, label: '7 días' },
  { id: 30, label: '30 días' },
  { id: 90, label: '90 días' },
];

// Colores de las gráficas (validados con el validador de paleta de dataviz:
// pasan banda de luminosidad, CVD y contraste en claro y en oscuro).
const COLOR_NUEVOS = '#ea580c';
const COLOR_CONVERTIDOS = '#059669';

const DIA_MS = 86_400_000;

// Mismas opciones que el formulario de la landing (OPCIONES_CANCHAS), para
// que los filtros por tamaño traten igual a los leads manuales.
const OPCIONES_CANCHAS = ['1 – 3 canchas', '4 – 7 canchas', '8 – 12 canchas', 'Más de 12 / varias sedes'];
// En Prueba / Convertido se alcanzan con "Convertir a Club Activo" (crea el club).
const ETAPAS_INICIALES = ['nuevo', 'contactado', 'demo_agendada', 'perdido'];

function esLeadManual(lead) {
  return ORIGENES_LEAD_MANUAL.includes(lead?.origen);
}

function digitos(t) {
  return String(t || '').replace(/\D/g, '').slice(-10);
}

function normalizar(t) {
  return String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function enlaceWhatsApp(numero, nombre, manual = false) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (!limpio) return null;
  const conLada = limpio.length === 10 ? `52${limpio}` : limpio;
  const saludo = manual ? `Hola ${nombre || ''}, te escribimos de QLUBOS. ` : `Hola ${nombre || ''}, te escribimos de QLUBOS por tu solicitud de demo. `;
  return `https://wa.me/${conLada}?text=${encodeURIComponent(saludo)}`;
}

function msDe(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

// Fecha de alta del lead (fn_admin_leads la expone como created_at; se
// acepta creado_en por compatibilidad).
function msAlta(lead) {
  return msDe(lead.created_at) ?? msDe(lead.creado_en);
}

// Fecha en que el lead pasó a su estatus actual: la del último cambio de
// estatus (crm_leads_seguimiento.actualizado_en), con respaldo a su alta.
function msConversion(lead) {
  return msDe(lead.actualizado_en) ?? msAlta(lead);
}

function formatoPorcentaje(v, decimales = 1) {
  return `${v.toFixed(decimales).replace(/\.0$/, '')}%`;
}

// Tema activo del panel (html.dark): las gráficas necesitan el color de
// superficie para el anillo de los puntos.
function useModoOscuro() {
  const leer = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [oscuro, setOscuro] = useState(leer);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => setOscuro(leer()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return oscuro;
}

function useAncho(ref) {
  const [ancho, setAncho] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const medir = () => setAncho(el.clientWidth || 0);
    medir();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return ancho;
}

/* ============================== UI compacta =============================== */

// Pestañas integradas (segmented control) para los filtros de una sola fila.
function Segmentado({ opciones, valor, onCambiar, etiqueta }) {
  return (
    <div role="tablist" aria-label={etiqueta} className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1">
      {opciones.map((o) => {
        const activo = valor === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={activo}
            onClick={() => onCambiar(o.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              activo ? 'bg-orange-400 text-slate-950 shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {o.label}
            {o.cuenta != null && (
              <span className={`rounded-md px-1.5 text-[10px] font-black ${activo ? 'bg-white/40 text-slate-900' : 'bg-slate-100 text-slate-500'}`}>{o.cuenta}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Píldora de variación vs el periodo anterior: color = dirección × si subir
// es bueno. Sin base de comparación se dice explícitamente, nunca se inventa.
function PildoraDelta({ delta }) {
  if (!delta) return null;
  const { tipo, valor, base } = delta;
  if (tipo === 'sin_base') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500" title={base}>
        <Minus size={10} /> sin base
      </span>
    );
  }
  const plano = Math.abs(valor) < 0.05;
  const sube = valor > 0;
  const Icono = plano ? Minus : sube ? TrendingUp : TrendingDown;
  const clase = plano
    ? 'bg-slate-100 text-slate-500'
    : sube
    ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20'
    : 'bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20';
  const texto = tipo === 'pp' ? `${sube ? '+' : ''}${valor.toFixed(1)} pp` : `${sube ? '+' : ''}${valor.toFixed(1)}%`;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black ${clase}`} title={base}>
      <Icono size={11} /> {plano ? '0%' : texto}
    </span>
  );
}

// Mini tendencia de una sola serie (tono de des-énfasis, último punto en acento).
function MiniTendencia({ valores }) {
  if (!valores || valores.length < 2) return null;
  const w = 96;
  const h = 28;
  const max = Math.max(1, ...valores);
  const paso = w / (valores.length - 1);
  const pts = valores.map((v, i) => [i * paso, h - 3 - (v / max) * (h - 6)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [ux, uy] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="overflow-visible text-slate-300">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={ux} cy={uy} r="3.5" fill={COLOR_NUEVOS} />
    </svg>
  );
}

function TarjetaKPI({ etiqueta, valor, delta, ayuda, tendencia }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold text-slate-500">{etiqueta}</p>
        <PildoraDelta delta={delta} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-3xl font-black leading-none text-slate-900">{valor}</p>
          {ayuda && <p className="mt-1.5 truncate text-[11px] text-slate-400">{ayuda}</p>}
        </div>
        {tendencia && <MiniTendencia valores={tendencia} />}
      </div>
    </div>
  );
}

function TarjetaGrafica({ titulo, descripcion, vistaTabla, onAlternarTabla, leyenda, children }) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-slate-900">{titulo}</h3>
          {descripcion && <p className="mt-0.5 text-[11px] text-slate-500">{descripcion}</p>}
        </div>
        <div className="flex items-center gap-3">
          {leyenda}
          <button
            type="button"
            onClick={onAlternarTabla}
            className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:border-orange-300 hover:text-orange-500"
          >
            {vistaTabla ? 'Ver gráfica' : 'Ver tabla'}
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

function ClaveLinea({ color, texto }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
      <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ backgroundColor: color }} />
      {texto}
    </span>
  );
}

/* ====================== Gráfica: tendencia de leads ======================= */

function GraficaTendencia({ cubetas, oscuro }) {
  const contRef = useRef(null);
  const ancho = useAncho(contRef);
  const [activo, setActivo] = useState(null);
  const superficie = oscuro ? '#1e293b' : '#ffffff';

  const alto = 220;
  const m = { izq: 30, der: 18, arr: 14, aba: 26 };
  const W = Math.max(ancho, 280);
  const anchoPlot = W - m.izq - m.der;
  const altoPlot = alto - m.arr - m.aba;
  const n = cubetas.length;
  const maxDato = Math.max(0, ...cubetas.map((c) => Math.max(c.nuevos, c.convertidos)));
  const maxY = maxDato <= 4 ? 4 : Math.ceil(maxDato / 4) * 4;
  const ticks = [0, maxY / 2, maxY];
  const x = (i) => m.izq + (n <= 1 ? anchoPlot / 2 : (i * anchoPlot) / (n - 1));
  const y = (v) => m.arr + altoPlot - (v / maxY) * altoPlot;

  const serie = (clave) => cubetas.map((c, i) => [x(i), y(c[clave])]);
  const linea = (pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = (pts) => `${linea(pts)} L${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)} L${pts[0][0].toFixed(1)},${y(0).toFixed(1)} Z`;
  const ptsNuevos = serie('nuevos');
  const ptsConv = serie('convertidos');

  // Etiquetas del eje X: inicio, mitad y fin (sin saturar).
  const indicesEje = n <= 1 ? [0] : Array.from(new Set([0, Math.round((n - 1) / 2), n - 1]));

  function indiceDesdeEvento(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (n <= 1) return 0;
    const i = Math.round(((px - m.izq) / anchoPlot) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  }

  const c = activo != null ? cubetas[activo] : null;
  const tooltipIzq = activo != null ? Math.min(Math.max(x(activo) - 70, 0), W - 140) : 0;

  return (
    <div ref={contRef} className="relative w-full">
      <svg
        width="100%"
        height={alto}
        viewBox={`0 0 ${W} ${alto}`}
        role="img"
        aria-label={`Leads nuevos y convertidos por ${n > 31 ? 'semana' : 'día'}. Usa las flechas para recorrer los puntos.`}
        tabIndex={0}
        className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
        onPointerMove={(e) => setActivo(indiceDesdeEvento(e))}
        onPointerLeave={() => setActivo(null)}
        onFocus={() => setActivo((a) => (a == null ? n - 1 : a))}
        onBlur={() => setActivo(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setActivo((a) => Math.max(0, (a ?? n - 1) - 1));
          if (e.key === 'ArrowRight') setActivo((a) => Math.min(n - 1, (a ?? 0) + 1));
        }}
      >
        {/* Rejilla mínima: hairlines sólidas, recesivas */}
        {ticks.map((t) => (
          <g key={t} className="text-slate-300">
            <line x1={m.izq} x2={W - m.der} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.9 : 0.45} strokeWidth="1" />
            <text x={m.izq - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="currentColor" className="text-slate-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {t}
            </text>
          </g>
        ))}
        {indicesEje.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={alto - 8}
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="currentColor"
            className="text-slate-400"
          >
            {cubetas[i]?.etiqueta}
          </text>
        ))}

        {n > 1 && (
          <>
            <path d={area(ptsNuevos)} fill={COLOR_NUEVOS} fillOpacity="0.1" />
            <path d={area(ptsConv)} fill={COLOR_CONVERTIDOS} fillOpacity="0.1" />
            <path d={linea(ptsNuevos)} fill="none" stroke={COLOR_NUEVOS} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            <path d={linea(ptsConv)} fill="none" stroke={COLOR_CONVERTIDOS} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}

        {/* Punto final de cada serie (anillo del color de la superficie) */}
        {[
          [ptsNuevos, COLOR_NUEVOS],
          [ptsConv, COLOR_CONVERTIDOS],
        ].map(([pts, color]) => {
          const [px, py] = pts[pts.length - 1] || [0, 0];
          return <circle key={color} cx={px} cy={py} r="4" fill={color} stroke={superficie} strokeWidth="2" />;
        })}

        {/* Crosshair que encuentra la X más cercana */}
        {activo != null && (
          <g pointerEvents="none">
            <line x1={x(activo)} x2={x(activo)} y1={m.arr} y2={y(0)} className="text-slate-400" stroke="currentColor" strokeWidth="1" />
            <circle cx={x(activo)} cy={y(c.nuevos)} r="4.5" fill={COLOR_NUEVOS} stroke={superficie} strokeWidth="2" />
            <circle cx={x(activo)} cy={y(c.convertidos)} r="4.5" fill={COLOR_CONVERTIDOS} stroke={superficie} strokeWidth="2" />
          </g>
        )}
      </svg>

      {c && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-[140px] rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg"
          style={{ left: tooltipIzq }}
          role="status"
        >
          <p className="text-[10px] font-semibold text-slate-500">{c.etiquetaLarga}</p>
          <div className="mt-1 space-y-0.5">
            <p className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: COLOR_NUEVOS }} /> Nuevos
              </span>
              <span className="font-black text-slate-900">{c.nuevos}</span>
            </p>
            <p className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-slate-500">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: COLOR_CONVERTIDOS }} /> Convertidos
              </span>
              <span className="font-black text-slate-900">{c.convertidos}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function TablaTendencia({ cubetas }) {
  return (
    <div className="max-h-[220px] overflow-y-auto rounded-xl border border-slate-200">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Periodo</th>
            <th className="px-3 py-2 text-right">Nuevos</th>
            <th className="px-3 py-2 text-right">Convertidos</th>
          </tr>
        </thead>
        <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
          {[...cubetas].reverse().map((c) => (
            <tr key={c.clave} className="border-b border-slate-200/70 last:border-0">
              <td className="px-3 py-1.5 text-slate-600">{c.etiquetaLarga}</td>
              <td className="px-3 py-1.5 text-right font-bold text-slate-900">{c.nuevos}</td>
              <td className="px-3 py-1.5 text-right font-bold text-slate-900">{c.convertidos}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ====================== Gráfica: embudo de conversión ===================== */

function EmbudoConversion({ embudo }) {
  const [activo, setActivo] = useState(null);
  const base = embudo.filas[0]?.cantidad || 0;
  return (
    <div className="space-y-2.5">
      {embudo.filas.map((f, i) => {
        const etapa = ETAPA_POR_ID[f.id];
        const pctTotal = base > 0 ? (f.cantidad / base) * 100 : 0;
        const etiquetaAdentro = pctTotal >= 18;
        return (
          <div
            key={f.id}
            className="relative grid grid-cols-[minmax(0,8.75rem)_minmax(0,1fr)_3.25rem] items-center gap-3 outline-none"
            tabIndex={0}
            onPointerEnter={() => setActivo(i)}
            onPointerLeave={() => setActivo(null)}
            onFocus={() => setActivo(i)}
            onBlur={() => setActivo(null)}
            aria-label={`${etapa.label}: ${f.cantidad} leads, ${formatoPorcentaje(pctTotal)} del total${i > 0 ? `, ${formatoPorcentaje(f.pctAnterior)} de la etapa anterior` : ''}`}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-slate-600">
              <span className={`h-2 w-2 shrink-0 rounded-full ${etapa.punto}`} />
              <span className="truncate">{etapa.label}</span>
            </span>
            <div className="relative h-5 rounded-r-[4px] bg-orange-400/10">
              <div
                className="flex h-full items-center rounded-r-[4px] transition-[width,opacity] duration-500"
                style={{ width: `${Math.max(pctTotal, f.cantidad > 0 ? 1.5 : 0)}%`, backgroundColor: COLOR_NUEVOS, opacity: activo == null || activo === i ? 1 : 0.55 }}
              >
                {etiquetaAdentro && <span className="pl-2 text-[11px] font-black text-white">{f.cantidad}</span>}
              </div>
              {!etiquetaAdentro && (
                <span className="absolute top-1/2 -translate-y-1/2 pl-1.5 text-[11px] font-black text-slate-700" style={{ left: `${Math.max(pctTotal, f.cantidad > 0 ? 1.5 : 0)}%` }}>
                  {f.cantidad}
                </span>
              )}
            </div>
            <span className="text-right text-xs font-black text-slate-900" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {i === 0 ? '100%' : formatoPorcentaje(f.pctAnterior)}
            </span>
            {activo === i && (
              <div className="pointer-events-none absolute -top-9 left-1/3 z-10 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg">
                <b className="text-slate-900">{f.cantidad}</b> <span className="text-slate-500">leads · {formatoPorcentaje(pctTotal)} del total</span>
                {i > 0 && <span className="text-slate-500"> · {formatoPorcentaje(f.pctAnterior)} de {ETIQUETA_ETAPA[ETAPAS_EMBUDO[i - 1]]}</span>}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        <span>
          Conversión total <b className="text-slate-900">{formatoPorcentaje(embudo.conversionTotal)}</b> · columna derecha: % que avanza desde la etapa anterior
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-slate-400" /> Perdidos <b className="text-slate-900">{embudo.perdidos}</b>
        </span>
      </div>
    </div>
  );
}

function TablaEmbudo({ embudo }) {
  const base = embudo.filas[0]?.cantidad || 0;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Etapa</th>
            <th className="px-3 py-2 text-right">Leads</th>
            <th className="px-3 py-2 text-right">% del total</th>
            <th className="px-3 py-2 text-right">% vs anterior</th>
          </tr>
        </thead>
        <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
          {embudo.filas.map((f, i) => (
            <tr key={f.id} className="border-b border-slate-200/70 last:border-0">
              <td className="px-3 py-1.5 text-slate-600">{ETIQUETA_ETAPA[f.id]}</td>
              <td className="px-3 py-1.5 text-right font-bold text-slate-900">{f.cantidad}</td>
              <td className="px-3 py-1.5 text-right text-slate-600">{formatoPorcentaje(base > 0 ? (f.cantidad / base) * 100 : 0)}</td>
              <td className="px-3 py-1.5 text-right text-slate-600">{i === 0 ? '—' : formatoPorcentaje(f.pctAnterior)}</td>
            </tr>
          ))}
          <tr>
            <td className="px-3 py-1.5 text-slate-600">Perdidos</td>
            <td className="px-3 py-1.5 text-right font-bold text-slate-900">{embudo.perdidos}</td>
            <td className="px-3 py-1.5 text-right text-slate-600">{formatoPorcentaje(base > 0 ? (embudo.perdidos / base) * 100 : 0)}</td>
            <td className="px-3 py-1.5 text-right text-slate-600">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* =============================== Kanban ================================== */

function SelectorEtapa({ valor, onCambiar, compacto = false, etiqueta = 'Mover a etapa' }) {
  const etapa = ETAPA_POR_ID[valor] || ETAPA_POR_ID.nuevo;
  return (
    <label className="relative flex w-full min-w-0 items-center">
      <span className={`pointer-events-none absolute left-2.5 h-2 w-2 rounded-full ${etapa.punto}`} />
      <select
        aria-label={etiqueta}
        value={valor}
        onChange={(e) => onCambiar(e.target.value)}
        className={`w-full min-w-0 cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-6 pr-6 font-semibold text-slate-700 outline-none transition hover:border-slate-300 focus:border-orange-400 focus:ring-1 focus:ring-orange-400 ${
          compacto ? 'text-[11px]' : 'text-xs'
        }`}
      >
        {ETAPAS_LEAD.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 text-[9px] text-slate-400">▼</span>
    </label>
  );
}

function TarjetaLead({ lead, onAbrir, onMover }) {
  const wa = enlaceWhatsApp(lead.whatsapp, lead.nombre, esLeadManual(lead));
  return (
    <article className="group rounded-xl border border-slate-200 bg-white p-3 transition hover:border-orange-300 hover:shadow-md">
      <button type="button" onClick={() => onAbrir(lead)} className="block w-full text-left">
        <p className="truncate text-sm font-black text-slate-900 group-hover:text-orange-600">{lead.club}</p>
        <p className="truncate text-xs text-slate-500">{lead.nombre}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] font-bold">
          {lead.canchas && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-400/10 px-2 py-0.5 text-orange-600 ring-1 ring-orange-400/20">
              <LayoutGrid size={10} /> {lead.canchas}
            </span>
          )}
          {lead.ciudad && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
              <MapPin size={10} /> {lead.ciudad}
            </span>
          )}
          {lead.plan_interes && <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-sky-600">{lead.plan_interes}</span>}
          {esLeadManual(lead) && <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-violet-600">{lead.origen}</span>}
        </div>
      </button>
      <div className="mt-2.5 border-t border-slate-200/70 pt-2.5">
        <SelectorEtapa valor={lead.estado} onCambiar={(estado) => onMover(lead, estado)} compacto />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <p className="flex min-w-0 flex-1 items-center gap-1 truncate text-[10px] text-slate-400">
          <Clock size={10} className="shrink-0" /> <span className="truncate" title={`Llegó ${haceCuanto(lead.created_at)}`}>{haceCuanto(lead.created_at)}</span>
        </p>
        {wa ? (
          <a
            href={wa}
            target="_blank"
            rel="noopener noreferrer"
            title="Escribir por WhatsApp"
            aria-label={`WhatsApp de ${lead.nombre}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-emerald-600 ring-1 ring-slate-200 transition hover:bg-emerald-500/10 hover:ring-emerald-500/30"
          >
            <MessageCircle size={14} />
          </a>
        ) : null}
        {lead.correo ? (
          <a
            href={`mailto:${lead.correo}`}
            title="Enviar correo"
            aria-label={`Correo de ${lead.nombre}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sky-600 ring-1 ring-slate-200 transition hover:bg-sky-500/10 hover:ring-sky-500/30"
          >
            <Mail size={14} />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function ColumnaKanban({ etapa, leads, onAbrir, onMover }) {
  return (
    <div className="flex min-h-[220px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70">
      <div className={`h-0.5 w-full ${etapa.punto}`} />
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-black text-slate-700">
          <span className={`h-2 w-2 shrink-0 rounded-full ${etapa.punto}`} />
          <span className="truncate">{etapa.label}</span>
        </p>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">{leads.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2" style={{ maxHeight: 600 }}>
        {leads.length === 0 ? (
          <p className="mx-1 rounded-xl border border-dashed border-slate-200 px-2 py-6 text-center text-[11px] text-slate-400">Sin leads</p>
        ) : (
          leads.map((l) => <TarjetaLead key={l.id} lead={l} onAbrir={onAbrir} onMover={onMover} />)
        )}
      </div>
    </div>
  );
}

/* ============================ Modal: nuevo lead =========================== */

const FORM_VACIO = {
  nombre: '',
  club: '',
  whatsapp: '',
  correo: '',
  canchas: '',
  ciudad: '',
  estado: 'nuevo',
  notas: '',
  origen: ORIGENES_LEAD_MANUAL[0],
};

// Mismas reglas que valida fn_admin_crear_lead (y la política de la landing).
function validarLead(f) {
  const e = {};
  const largo = (v) => v.trim().length;
  if (largo(f.nombre) < 2 || largo(f.nombre) > 120) e.nombre = 'Escribe el nombre completo (2 a 120 caracteres).';
  if (largo(f.club) < 2 || largo(f.club) > 120) e.club = 'Escribe el nombre del club (2 a 120 caracteres).';
  if (largo(f.whatsapp) < 8 || largo(f.whatsapp) > 20 || digitos(f.whatsapp).length < 8) e.whatsapp = 'WhatsApp a 10 dígitos (puede incluir lada).';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.correo.trim()) || largo(f.correo) > 160) e.correo = 'Correo electrónico inválido.';
  if (largo(f.ciudad) > 120) e.ciudad = 'Máximo 120 caracteres.';
  return e;
}

function SeccionFormulario({ titulo, children }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[10px] font-black uppercase tracking-wider text-slate-400">{titulo}</legend>
      {children}
    </fieldset>
  );
}

function ModalNuevoLead({ leadsExistentes, onClose, onCreado }) {
  const [f, setF] = useState(FORM_VACIO);
  const [errores, setErrores] = useState({});
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [duplicadoAceptado, setDuplicadoAceptado] = useState(false);
  const set = (campo) => (e) => {
    setF((prev) => ({ ...prev, [campo]: e.target.value }));
    setErrores((prev) => ({ ...prev, [campo]: undefined }));
    if (campo === 'whatsapp' || campo === 'correo') setDuplicadoAceptado(false);
  };

  // Aviso (no bloqueo) si ya hay un lead con el mismo WhatsApp o correo.
  const duplicado = useMemo(() => {
    const tel = digitos(f.whatsapp);
    const correo = f.correo.trim().toLowerCase();
    return (
      leadsExistentes.find(
        (l) => (tel.length >= 8 && digitos(l.whatsapp) === tel) || (correo.includes('@') && String(l.correo || '').trim().toLowerCase() === correo)
      ) || null
    );
  }, [leadsExistentes, f.whatsapp, f.correo]);

  async function guardar() {
    const e = validarLead(f);
    setErrores(e);
    if (Object.keys(e).length) return;
    if (duplicado && !duplicadoAceptado) return setDuplicadoAceptado(true);
    setGuardando(true);
    setError('');
    const { data, error: err } = await crearLeadManual({
      nombre: f.nombre.trim(),
      club: f.club.trim(),
      whatsapp: f.whatsapp.trim(),
      correo: f.correo.trim(),
      canchas: f.canchas,
      ciudad: f.ciudad.trim(),
      estado: f.estado,
      notas: f.notas.trim(),
      origen: f.origen,
    });
    setGuardando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudo registrar el lead.'));
    onCreado(data);
  }

  const campo = (clave, etiqueta, props = {}) => (
    <label className="block">
      <span className="text-xs font-semibold text-slate-600">{etiqueta}</span>
      <input value={f[clave]} onChange={set(clave)} className={`${claseInput} mt-1 ${errores[clave] ? 'border-rose-400' : ''}`} {...props} />
      {errores[clave] && <span className="mt-1 block text-[11px] font-semibold text-rose-500">{errores[clave]}</span>}
    </label>
  );

  return (
    <ModalSoporte titulo="Nuevo lead" subtitulo="Prospecto de una visita presencial o venta directa" onClose={guardando ? undefined : onClose} ancho="max-w-2xl">
      <div className="space-y-5">
        <div role="radiogroup" aria-label="Origen del lead" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
          {ORIGENES_LEAD_MANUAL.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={f.origen === o}
              onClick={() => setF((prev) => ({ ...prev, origen: o }))}
              className={`rounded-lg px-3 py-2 text-xs font-bold transition ${
                f.origen === o ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {o}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <SeccionFormulario titulo="Contacto">
            {campo('nombre', 'Nombre completo *', { maxLength: 120, autoComplete: 'off', placeholder: 'Ej. Mariana López' })}
            {campo('whatsapp', 'WhatsApp *', { maxLength: 20, inputMode: 'tel', autoComplete: 'off', placeholder: '55 1234 5678' })}
            {campo('correo', 'Correo electrónico *', { maxLength: 160, type: 'email', autoComplete: 'off', placeholder: 'dueno@club.mx' })}
          </SeccionFormulario>
          <SeccionFormulario titulo="Club">
            {campo('club', 'Nombre del club *', { maxLength: 120, autoComplete: 'off', placeholder: 'Ej. Pádel Cumbres' })}
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">Número de canchas</span>
              <select value={f.canchas} onChange={set('canchas')} className={`${claseInput} mt-1`}>
                <option value="">Sin dato</option>
                {OPCIONES_CANCHAS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            {campo('ciudad', 'Ciudad', { maxLength: 120, placeholder: 'Ej. Monterrey' })}
          </SeccionFormulario>
        </div>

        <SeccionFormulario titulo="Seguimiento">
          <div>
            <span className="text-xs font-semibold text-slate-600">Estado inicial</span>
            <div role="radiogroup" aria-label="Estado inicial" className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {ETAPAS_INICIALES.map((id) => {
                const etapa = ETAPA_POR_ID[id];
                const activo = f.estado === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={activo}
                    onClick={() => setF((prev) => ({ ...prev, estado: id }))}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-bold transition ${
                      activo ? 'border-orange-400 bg-orange-400/10 text-slate-900' : 'border-slate-200 bg-white text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${etapa.punto}`} /> {etapa.label}
                  </button>
                );
              })}
            </div>
            <span className="mt-1.5 block text-[11px] text-slate-400">"En Prueba Gratis" se activa con Convertir a Club Activo, que crea el club.</span>
          </div>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Notas internas</span>
            <textarea
              value={f.notas}
              onChange={set('notas')}
              rows={3}
              maxLength={2000}
              placeholder="Ej. Visitado el martes; usa Excel, interesado en Smart POS."
              className={`${claseInput} mt-1 resize-y`}
            />
          </label>
        </SeccionFormulario>

        {duplicado && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Ya existe un lead con este {digitos(duplicado.whatsapp) === digitos(f.whatsapp) ? 'WhatsApp' : 'correo'}: <b>{duplicado.club}</b> ({ETIQUETA_ETAPA[duplicado.estado] || duplicado.estado}).
              {duplicadoAceptado ? ' Vuelve a pulsar Guardar para registrarlo de todos modos.' : ''}
            </span>
          </p>
        )}
        <AvisoError texto={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-slate-200 pt-4">
        <button type="button" className={claseBotonSecundario} onClick={onClose} disabled={guardando}>
          Cancelar
        </button>
        <button type="button" className={claseBotonPrimario} onClick={guardar} disabled={guardando}>
          {guardando ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} {duplicado && duplicadoAceptado ? 'Guardar de todos modos' : 'Guardar lead'}
        </button>
      </div>
    </ModalSoporte>
  );
}

/* =========================== Modal: detalle lead ========================== */

function DatoLead({ etiqueta, valor, completo = false }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 ${completo ? 'sm:col-span-2' : ''}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{etiqueta}</p>
      <p className="mt-0.5 break-words text-sm font-semibold text-slate-900">{valor || '—'}</p>
    </div>
  );
}

function ModalDetalleLead({ lead, onClose, onGuardarNotas, onMover, onConvertir }) {
  const [notas, setNotas] = useState(lead.notas || '');
  const [dias, setDias] = useState('14');
  const [confirmando, setConfirmando] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState('');
  const yaConvertido = Boolean(lead.club_id);
  const etapa = ETAPA_POR_ID[lead.estado] || ETAPA_POR_ID.nuevo;
  const wa = enlaceWhatsApp(lead.whatsapp, lead.nombre, esLeadManual(lead));
  const notasCambiaron = (notas || '') !== (lead.notas || '');

  async function convertir() {
    setTrabajando(true);
    setError('');
    const r = await onConvertir(lead, dias);
    setTrabajando(false);
    if (r?.error) setError(r.error.message || 'No se pudo convertir.');
    else onClose();
  }

  return (
    <ModalSoporte titulo={lead.club} subtitulo={lead.nombre} onClose={trabajando ? undefined : onClose} ancho="max-w-2xl">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black ring-1 ${etapa.pastilla}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${etapa.punto}`} /> {etapa.label}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <Clock size={11} /> Llegó {haceCuanto(lead.created_at)} · {formatoFechaCorta(lead.created_at)}
            </span>
          </div>
          <div className="w-48">
            <SelectorEtapa valor={lead.estado} onCambiar={(estado) => onMover(lead, estado)} etiqueta="Cambiar estatus del lead" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer" className={`${claseBotonSecundario} py-2.5`}>
              <MessageCircle size={14} className="text-emerald-600" /> WhatsApp
            </a>
          ) : (
            <span className={`${claseBotonSecundario} cursor-not-allowed py-2.5 opacity-50`}>
              <MessageCircle size={14} /> Sin WhatsApp
            </span>
          )}
          {lead.correo ? (
            <a href={`mailto:${lead.correo}`} className={`${claseBotonSecundario} py-2.5`}>
              <Mail size={14} className="text-sky-600" /> Correo
            </a>
          ) : (
            <span className={`${claseBotonSecundario} cursor-not-allowed py-2.5 opacity-50`}>
              <Mail size={14} /> Sin correo
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <DatoLead etiqueta="WhatsApp" valor={lead.whatsapp} />
          <DatoLead etiqueta="Correo" valor={lead.correo} />
          <DatoLead etiqueta="Canchas" valor={lead.canchas} />
          <DatoLead etiqueta="Ciudad" valor={lead.ciudad} />
          <DatoLead etiqueta="Plan de interés" valor={lead.plan_interes} />
          <DatoLead etiqueta="Origen" valor={lead.origen} />
          {lead.gestion_actual && <DatoLead etiqueta="Gestión actual" valor={lead.gestion_actual} completo />}
        </div>

        {lead.mensaje && (
          <div className="rounded-xl border border-slate-200 px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Mensaje del prospecto</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{lead.mensaje}</p>
          </div>
        )}

        <div>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Notas internas</span>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} maxLength={2000} className={`${claseInput} mt-1.5 resize-y`} />
          </label>
          <div className="mt-2 flex justify-end">
            <button type="button" className={claseBotonSecundario} disabled={!notasCambiaron} onClick={() => onGuardarNotas(lead, notas)}>
              Guardar notas
            </button>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-4">
          {yaConvertido ? (
            <p className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2.5 text-xs font-semibold text-emerald-600">
              <Building2 size={14} /> Este lead ya tiene club (ID {lead.club_id}).
            </p>
          ) : !confirmando ? (
            <button type="button" className={`${claseBotonPrimario} w-full py-2.5 text-sm`} onClick={() => setConfirmando(true)}>
              <Rocket size={15} /> Convertir a Club Activo
            </button>
          ) : (
            <div className="space-y-3 rounded-xl border border-orange-400/40 bg-orange-400/5 p-4">
              <p className="text-xs text-slate-700">
                Se creará el club <b>{lead.club}</b> en periodo de prueba y se enviará una invitación a <b>{lead.correo}</b> para que el dueño defina su contraseña. Si ese
                correo ya tiene un club, solo se enlaza.
              </p>
              <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
                Días de prueba
                <input type="number" min={1} max={90} value={dias} onChange={(e) => setDias(e.target.value)} className={`${claseInput} w-20`} />
              </label>
              {error && <AvisoError texto={error} />}
              <div className="flex justify-end gap-2">
                <button type="button" className={claseBotonSecundario} disabled={trabajando} onClick={() => setConfirmando(false)}>
                  Cancelar
                </button>
                <button type="button" className={claseBotonPrimario} disabled={trabajando} onClick={convertir}>
                  {trabajando ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Confirmar conversión
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalSoporte>
  );
}

/* ============================== Métricas ================================= */

// Variación porcentual con base explícita; sin base (anterior = 0) no se
// inventa un porcentaje.
function deltaPct(actual, anterior, etiquetaBase) {
  if (!anterior) return actual ? { tipo: 'sin_base', valor: 0, base: `Sin datos en ${etiquetaBase}` } : { tipo: 'pct', valor: 0, base: etiquetaBase };
  return { tipo: 'pct', valor: ((actual - anterior) / anterior) * 100, base: `vs ${etiquetaBase}` };
}

function construirCubetas(leads, dias, ahora) {
  const tamanoCubeta = dias > 31 ? 7 : 1;
  const numero = Math.ceil(dias / tamanoCubeta);
  const finHoy = new Date(ahora);
  finHoy.setHours(24, 0, 0, 0);
  const fin = finHoy.getTime();
  const inicio = fin - numero * tamanoCubeta * DIA_MS;
  const cubetas = Array.from({ length: numero }, (_, i) => {
    const desde = new Date(inicio + i * tamanoCubeta * DIA_MS);
    const hasta = new Date(inicio + (i + 1) * tamanoCubeta * DIA_MS - 1);
    const corto = (d) => d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    return {
      clave: i,
      nuevos: 0,
      convertidos: 0,
      etiqueta: corto(desde),
      etiquetaLarga: tamanoCubeta === 1 ? desde.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }) : `${corto(desde)} – ${corto(hasta)}`,
    };
  });
  const indice = (ms) => (ms == null || ms < inicio || ms >= fin ? -1 : Math.floor((ms - inicio) / (tamanoCubeta * DIA_MS)));
  leads.forEach((l) => {
    // Naranja: solo por fecha de alta, sin importar el estatus.
    const iN = indice(msAlta(l));
    if (iN >= 0) cubetas[iN].nuevos += 1;
    // Verde: solo leads en estatus Convertido (cliente final).
    if (esConvertido(l)) {
      const iC = indice(msConversion(l));
      if (iC >= 0) cubetas[iC].convertidos += 1;
    }
  });
  return cubetas;
}

function construirEmbudo(leads) {
  const perdidos = leads.filter((l) => l.estado === 'perdido').length;
  const filas = ETAPAS_EMBUDO.map((id, i) => ({
    id,
    // Etapa alcanzada según el estatus actual; los perdidos solo cuentan en la primera.
    cantidad: i === 0 ? leads.length : leads.filter((l) => (INDICE_EMBUDO[l.estado] ?? -1) >= i).length,
  }));
  filas.forEach((f, i) => {
    f.pctAnterior = i === 0 ? 100 : filas[i - 1].cantidad > 0 ? (f.cantidad / filas[i - 1].cantidad) * 100 : 0;
  });
  const total = filas[0].cantidad;
  const conversionTotal = total > 0 ? (filas[filas.length - 1].cantidad / total) * 100 : 0;
  return { filas, perdidos, conversionTotal };
}

/* ============================= Componente ================================ */

export default function AdminLeads({ onToast }) {
  const [leads, setLeads] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [tamano, setTamano] = useState('todos');
  const [periodo, setPeriodo] = useState(30);
  const [busqueda, setBusqueda] = useState('');
  const [abierto, setAbierto] = useState(null);
  const [creando, setCreando] = useState(false);
  const [tablaTendencia, setTablaTendencia] = useState(false);
  const [tablaEmbudo, setTablaEmbudo] = useState(false);
  const oscuro = useModoOscuro();

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setCargando(true);
    const { data, error: err } = await listarLeads();
    setCargando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudieron cargar los leads.'));
    setError('');
    setLeads(data);
  }, []);

  useEffect(() => {
    cargar();
    return suscribirTablas(['crm_leads_seguimiento'], () => cargar({ silencioso: true }));
  }, [cargar]);

  // Un solo filtro de canchas + búsqueda: acota KPIs, gráficas y Kanban, para
  // que todas las cifras de la pantalla coincidan entre sí.
  const filtrados = useMemo(() => {
    const q = normalizar(busqueda.trim());
    return leads.filter((l) => {
      if (tamano !== 'todos' && tamanoDesdeCanchas(l.canchas) !== tamano) return false;
      if (q && !normalizar(`${l.club} ${l.nombre} ${l.ciudad} ${l.correo} ${l.whatsapp}`).includes(q)) return false;
      return true;
    });
  }, [leads, tamano, busqueda]);

  const porEtapa = useMemo(() => {
    const m = Object.fromEntries(ETAPAS_LEAD.map((e) => [e.id, []]));
    filtrados.forEach((l) => (m[l.estado] || m.nuevo).push(l));
    return m;
  }, [filtrados]);

  const conteoTamano = useMemo(() => {
    const c = { todos: leads.length };
    leads.forEach((l) => {
      const t = tamanoDesdeCanchas(l.canchas);
      c[t] = (c[t] || 0) + 1;
    });
    return c;
  }, [leads]);

  const metricas = useMemo(() => {
    const ahora = Date.now();
    const p = periodo * DIA_MS;
    const iniActual = ahora - p;
    const iniPrevio = iniActual - p;
    const etiquetaBase = `los ${periodo} días anteriores`;
    const enVentana = (ms, a, b) => ms != null && ms >= a && ms < b;

    const total = filtrados.length;
    const totalAntes = filtrados.filter((l) => (msAlta(l) ?? 0) < iniActual).length;
    const nuevos = filtrados.filter((l) => enVentana(msAlta(l), iniActual, ahora + 1));
    const nuevosPrev = filtrados.filter((l) => enVentana(msAlta(l), iniPrevio, iniActual));
    const enPrueba = filtrados.filter((l) => l.estado === 'en_prueba').length;
    const entradasPrueba = filtrados.filter((l) => l.estado === 'en_prueba' && enVentana(msConversion(l), iniActual, ahora + 1)).length;
    const entradasPruebaPrev = filtrados.filter((l) => l.estado === 'en_prueba' && enVentana(msConversion(l), iniPrevio, iniActual)).length;
    const convertidos = filtrados.filter(esConvertido).length;
    const conversion = total ? (convertidos / total) * 100 : 0;
    // Conversión por cohorte: de los leads que llegaron en cada ventana, ¿qué % ya avanzó?
    const tasa = (lista) => (lista.length ? (lista.filter(esConvertido).length / lista.length) * 100 : null);
    const cohorteActual = tasa(nuevos);
    const cohortePrev = tasa(nuevosPrev);

    const cubetas = construirCubetas(filtrados, periodo, ahora);
    return {
      total,
      deltaTotal: deltaPct(total, totalAntes, `el total de hace ${periodo} días`),
      nuevos: nuevos.length,
      deltaNuevos: deltaPct(nuevos.length, nuevosPrev.length, etiquetaBase),
      enPrueba,
      deltaPrueba: deltaPct(entradasPrueba, entradasPruebaPrev, etiquetaBase),
      entradasPrueba,
      conversion,
      deltaConversion:
        cohorteActual == null || cohortePrev == null
          ? { tipo: 'sin_base', valor: 0, base: 'Se necesitan leads en ambos periodos para comparar' }
          : { tipo: 'pp', valor: cohorteActual - cohortePrev, base: `Conversión de los leads llegados en los últimos ${periodo} días vs ${etiquetaBase}` },
      cubetas,
      embudo: construirEmbudo(filtrados),
    };
  }, [filtrados, periodo]);

  async function mover(lead, estado, notas = null) {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, estado, notas: notas ?? l.notas, actualizado_en: new Date().toISOString() } : l)));
    const { error: err } = await cambiarEstadoLead(lead.id, estado, notas);
    if (err) {
      onToast?.({ titulo: 'No se pudo actualizar el lead', detalle: mensajeErrorAdmin(err), tono: 'error' });
      cargar({ silencioso: true });
    }
  }

  async function convertir(lead, dias) {
    const r = await convertirLead(lead.id, dias);
    if (!r.error) {
      onToast?.({ titulo: 'Lead convertido', detalle: r.data?.mensaje || 'Club creado en prueba.' });
      cargar({ silencioso: true });
    }
    return r;
  }

  const hayFiltro = tamano !== 'todos' || busqueda.trim();

  return (
    <div className="space-y-5">
      <EncabezadoModulo
        icono={Users2}
        titulo="CRM de Leads"
        descripcion="Solicitudes de la landing, visitas presenciales y venta directa."
        acciones={
          <button type="button" className={claseBotonPrimario} onClick={() => setCreando(true)}>
            <UserPlus size={14} /> Nuevo Lead
          </button>
        }
      />

      {/* Fila única de filtros: acota todo lo de abajo */}
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Segmentado etiqueta="Filtrar por número de canchas" opciones={TAMANOS.map((t) => ({ ...t, cuenta: conteoTamano[t.id] || 0 }))} valor={tamano} onCambiar={setTamano} />
          <Segmentado etiqueta="Periodo de comparación" opciones={PERIODOS} valor={periodo} onCambiar={setPeriodo} />
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 xl:w-72">
          <Search size={14} className="shrink-0 text-slate-400" />
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar club, nombre, ciudad…"
            aria-label="Buscar leads"
            className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder-slate-400"
          />
        </label>
      </div>
      {hayFiltro && (
        <p className="-mt-2 text-[11px] text-slate-500">
          Mostrando {filtrados.length} de {leads.length} leads.
        </p>
      )}

      <AvisoError texto={error} />

      {cargando && leads.length === 0 ? (
        <Cargando texto="Cargando leads…" />
      ) : (
        <div className={`space-y-5 transition-opacity ${cargando ? 'opacity-60' : ''}`}>
          {/* KPIs con variación vs el periodo anterior */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <TarjetaKPI etiqueta="Leads totales" valor={metricas.total} delta={metricas.deltaTotal} ayuda={`Crecimiento en los últimos ${periodo} días`} />
            <TarjetaKPI
              etiqueta={`Nuevos (${periodo} días)`}
              valor={metricas.nuevos}
              delta={metricas.deltaNuevos}
              ayuda={`vs los ${periodo} días anteriores`}
              tendencia={metricas.cubetas.map((c) => c.nuevos)}
            />
            <TarjetaKPI
              etiqueta="En prueba"
              valor={metricas.enPrueba}
              delta={metricas.deltaPrueba}
              ayuda={`${metricas.entradasPrueba} entraron en los últimos ${periodo} días`}
            />
            <TarjetaKPI etiqueta="Conversión" valor={formatoPorcentaje(metricas.conversion)} delta={metricas.deltaConversion} ayuda="Solo estatus Convertido · por cohorte" />
          </div>

          {/* Gráficas */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <TarjetaGrafica
                titulo="Tendencia de leads"
                descripcion={`Leads nuevos (por fecha de alta) vs convertidos a cliente por ${periodo > 31 ? 'semana' : 'día'}`}
                vistaTabla={tablaTendencia}
                onAlternarTabla={() => setTablaTendencia((v) => !v)}
                leyenda={
                  <div className="hidden items-center gap-3 sm:flex">
                    <ClaveLinea color={COLOR_NUEVOS} texto="Nuevos" />
                    <ClaveLinea color={COLOR_CONVERTIDOS} texto="Convertidos" />
                  </div>
                }
              >
                <div className="mb-2 flex items-center gap-3 sm:hidden">
                  <ClaveLinea color={COLOR_NUEVOS} texto="Nuevos" />
                  <ClaveLinea color={COLOR_CONVERTIDOS} texto="Convertidos" />
                </div>
                {tablaTendencia ? <TablaTendencia cubetas={metricas.cubetas} /> : <GraficaTendencia cubetas={metricas.cubetas} oscuro={oscuro} />}
              </TarjetaGrafica>
            </div>
            <div className="min-w-0 lg:col-span-2">
              <TarjetaGrafica
                titulo="Embudo de conversión"
                descripcion="Leads que alcanzaron cada etapa (según su estatus actual)"
                vistaTabla={tablaEmbudo}
                onAlternarTabla={() => setTablaEmbudo((v) => !v)}
              >
                {tablaEmbudo ? <TablaEmbudo embudo={metricas.embudo} /> : <EmbudoConversion embudo={metricas.embudo} />}
              </TarjetaGrafica>
            </div>
          </div>

          {/* Kanban */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-black text-slate-900">Pipeline</h3>
              <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Phone size={11} /> Actualiza el estatus desde cada tarjeta
              </p>
            </div>
            <div className="-mx-1 overflow-x-auto pb-2">
              <div className="grid min-w-[1140px] grid-cols-6 gap-3 px-1">
                {ETAPAS_LEAD.map((etapa) => (
                  <ColumnaKanban key={etapa.id} etapa={etapa} leads={porEtapa[etapa.id]} onAbrir={setAbierto} onMover={(lead, est) => mover(lead, est)} />
                ))}
              </div>
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400 xl:hidden">
              <LayoutGrid size={12} /> Desliza horizontalmente para ver todas las etapas.
            </p>
          </section>
        </div>
      )}

      {creando && (
        <ModalNuevoLead
          leadsExistentes={leads}
          onClose={() => setCreando(false)}
          onCreado={(lead) => {
            setCreando(false);
            // Aparece de inmediato en su columna; el realtime/recarga lo confirma.
            if (lead?.id) setLeads((prev) => [lead, ...prev.filter((l) => l.id !== lead.id)]);
            setTamano('todos');
            setBusqueda('');
            onToast?.({ titulo: 'Lead registrado', detalle: `${lead?.club || 'Nuevo lead'} · ${ETIQUETA_ETAPA[lead?.estado] || 'Nuevo Lead'}` });
            cargar({ silencioso: true });
          }}
        />
      )}

      {abierto && (
        <ModalDetalleLead
          lead={leads.find((l) => l.id === abierto.id) || abierto}
          onClose={() => setAbierto(null)}
          onMover={(lead, estado) => mover(lead, estado)}
          onGuardarNotas={(lead, notas) => {
            mover(lead, lead.estado, notas);
            onToast?.({ titulo: 'Notas guardadas', detalle: lead.club });
          }}
          onConvertir={convertir}
        />
      )}
    </div>
  );
}
