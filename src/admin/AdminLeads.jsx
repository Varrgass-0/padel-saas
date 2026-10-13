// =============================================================================
// SuperAdmin — CRM de Leads (public.leads_landing + crm_leads_seguimiento)
// Embudo: Nuevo → Contactado → Demo agendada → En prueba → Convertido / Perdido.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users2, Search, MessageCircle, Mail, Rocket, Loader2, MapPin, LayoutGrid } from 'lucide-react';
import { ModalSoporte } from '../soporte/SoporteModal';
import { listarLeads, cambiarEstadoLead, convertirLead, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import {
  AvisoError,
  Cargando,
  Chips,
  EncabezadoModulo,
  Metrica,
  claseBotonPrimario,
  claseBotonSecundario,
  claseInput,
  formatoFechaCorta,
  haceCuanto,
  tamanoDesdeCanchas,
} from './adminUi';

export const ETAPAS_LEAD = [
  { id: 'nuevo', label: 'Nuevo Lead', color: 'border-t-sky-400', punto: 'bg-sky-400' },
  { id: 'contactado', label: 'Contactado', color: 'border-t-violet-400', punto: 'bg-violet-400' },
  { id: 'demo_agendada', label: 'Demo Agendada', color: 'border-t-amber-400', punto: 'bg-amber-400' },
  { id: 'en_prueba', label: 'En Prueba Gratis', color: 'border-t-orange-400', punto: 'bg-orange-400' },
  { id: 'convertido', label: 'Convertido', color: 'border-t-emerald-500', punto: 'bg-emerald-500' },
  { id: 'perdido', label: 'Perdido', color: 'border-t-slate-400', punto: 'bg-slate-400' },
];
const ETIQUETA_ETAPA = Object.fromEntries(ETAPAS_LEAD.map((e) => [e.id, e.label]));

const TAMANOS = [
  { id: 'todos', label: 'Todos' },
  { id: '1-3', label: '1–3 canchas' },
  { id: '4-7', label: '4–7 canchas' },
  { id: '8-12', label: '8–12 canchas' },
  { id: '12+', label: 'Más de 12' },
  { id: 'sin_dato', label: 'Sin dato' },
];

function normalizar(t) {
  return String(t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function enlaceWhatsApp(numero, nombre) {
  const limpio = String(numero || '').replace(/\D/g, '');
  if (!limpio) return null;
  const conLada = limpio.length === 10 ? `52${limpio}` : limpio;
  return `https://wa.me/${conLada}?text=${encodeURIComponent(`Hola ${nombre || ''}, te escribimos de QLUBOS por tu solicitud de demo. `)}`;
}

function TarjetaLead({ lead, onAbrir, onMover }) {
  const wa = enlaceWhatsApp(lead.whatsapp, lead.nombre);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <button type="button" onClick={() => onAbrir(lead)} className="block w-full text-left">
        <p className="truncate text-sm font-black text-slate-900">{lead.club}</p>
        <p className="truncate text-xs text-slate-600">{lead.nombre}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] font-semibold text-slate-500">
          {lead.canchas && <span className="rounded-full bg-slate-100 px-2 py-0.5">{lead.canchas}</span>}
          {lead.ciudad && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-2 py-0.5">
              <MapPin size={10} /> {lead.ciudad}
            </span>
          )}
          {lead.plan_interes && <span className="rounded-full bg-orange-400/10 px-2 py-0.5 text-orange-600">{lead.plan_interes}</span>}
        </div>
        <p className="mt-1.5 text-[10px] text-slate-400">Llegó {haceCuanto(lead.created_at)}</p>
      </button>
      <div className="mt-2 flex items-center gap-1.5 border-t border-slate-100 pt-2">
        {wa && (
          <a href={wa} target="_blank" rel="noopener noreferrer" title="WhatsApp" className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-500/10">
            <MessageCircle size={14} />
          </a>
        )}
        {lead.correo && (
          <a href={`mailto:${lead.correo}`} title="Correo" className="rounded-md p-1.5 text-sky-600 hover:bg-sky-500/10">
            <Mail size={14} />
          </a>
        )}
        <select
          aria-label="Mover a etapa"
          value={lead.estado}
          onChange={(e) => onMover(lead, e.target.value)}
          className="ml-auto min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-semibold text-slate-700 outline-none focus:border-orange-400"
        >
          {ETAPAS_LEAD.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ModalDetalleLead({ lead, onClose, onGuardarNotas, onConvertir }) {
  const [notas, setNotas] = useState(lead.notas || '');
  const [dias, setDias] = useState('14');
  const [confirmando, setConfirmando] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState('');
  const yaConvertido = Boolean(lead.club_id);
  const fila = (etiqueta, valor) =>
    valor ? (
      <div className="flex items-start justify-between gap-4 py-2 text-sm">
        <span className="shrink-0 text-xs font-semibold text-slate-500">{etiqueta}</span>
        <span className="break-words text-right font-semibold text-slate-900">{valor}</span>
      </div>
    ) : null;

  async function convertir() {
    setTrabajando(true);
    setError('');
    const r = await onConvertir(lead, dias);
    setTrabajando(false);
    if (r?.error) setError(r.error.message || 'No se pudo convertir.');
    else onClose();
  }

  return (
    <ModalSoporte titulo={lead.club} subtitulo={`${lead.nombre} · ${ETIQUETA_ETAPA[lead.estado] || lead.estado}`} onClose={trabajando ? undefined : onClose}>
      <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 px-3">
        {fila('WhatsApp', lead.whatsapp)}
        {fila('Correo', lead.correo)}
        {fila('Canchas', lead.canchas)}
        {fila('Ciudad', lead.ciudad)}
        {fila('Plan de interés', lead.plan_interes)}
        {fila('Gestión actual', lead.gestion_actual)}
        {fila('Origen', lead.origen)}
        {fila('Fecha', formatoFechaCorta(lead.created_at))}
      </div>
      {lead.mensaje && (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Mensaje</p>
          <p className="mt-1 whitespace-pre-line">{lead.mensaje}</p>
        </div>
      )}
      <label className="mt-3 block">
        <span className="text-xs font-bold text-slate-600">Notas internas</span>
        <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} maxLength={2000} className={`${claseInput} mt-1 resize-y`} />
      </label>
      <div className="mt-2 flex justify-end">
        <button type="button" className={claseBotonSecundario} onClick={() => onGuardarNotas(lead, notas)}>
          Guardar notas
        </button>
      </div>

      <div className="mt-4 border-t border-slate-200 pt-3">
        {yaConvertido ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-600">Este lead ya tiene club (ID {lead.club_id}).</p>
        ) : !confirmando ? (
          <button type="button" className={`${claseBotonPrimario} w-full py-2.5 text-sm`} onClick={() => setConfirmando(true)}>
            <Rocket size={15} /> Convertir a Club Activo
          </button>
        ) : (
          <div className="space-y-2 rounded-xl border border-orange-400/40 bg-orange-400/5 p-3">
            <p className="text-xs text-slate-700">
              Se creará el club <b>{lead.club}</b> en periodo de prueba y se enviará una invitación a <b>{lead.correo}</b> para que el dueño defina su contraseña.
              Si ese correo ya tiene un club, solo se enlaza.
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
    </ModalSoporte>
  );
}

export default function AdminLeads({ onToast }) {
  const [leads, setLeads] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [tamano, setTamano] = useState('todos');
  const [busqueda, setBusqueda] = useState('');
  const [abierto, setAbierto] = useState(null);

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

  const conversion = leads.length ? Math.round((leads.filter((l) => l.estado === 'convertido' || l.estado === 'en_prueba').length / leads.length) * 100) : 0;
  const nuevosSemana = leads.filter((l) => Date.now() - new Date(l.created_at).getTime() < 7 * 86_400_000).length;

  async function mover(lead, estado, notas = null) {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, estado, notas: notas ?? l.notas } : l)));
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

  return (
    <div className="space-y-4">
      <EncabezadoModulo icono={Users2} titulo="CRM de Leads" descripcion="Solicitudes de demo desde la landing de QLUBOS." />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Metrica etiqueta="Leads totales" valor={leads.length} />
        <Metrica etiqueta="Nuevos (7 días)" valor={nuevosSemana} tono="sky" />
        <Metrica etiqueta="En prueba" valor={leads.filter((l) => l.estado === 'en_prueba').length} tono="amber" />
        <Metrica etiqueta="Conversión" valor={`${conversion}%`} tono="emerald" ayuda="En prueba + convertidos" />
      </div>
      <AvisoError texto={error} />
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <Chips opciones={TAMANOS.map((t) => ({ ...t, cuenta: conteoTamano[t.id] || 0 }))} valor={tamano} onCambiar={setTamano} />
        <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 lg:w-72">
          <Search size={14} className="text-slate-500" />
          <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar club, nombre, ciudad…" className="w-full bg-transparent text-sm text-slate-900 outline-none placeholder-slate-400" />
        </div>
      </div>

      {cargando && leads.length === 0 ? (
        <Cargando texto="Cargando leads…" />
      ) : (
        <div className="-mx-1 overflow-x-auto pb-2">
          <div className="grid min-w-[1080px] grid-cols-6 gap-3 px-1">
            {ETAPAS_LEAD.map((etapa) => (
              <div key={etapa.id} className={`flex min-h-[200px] flex-col rounded-2xl border border-t-4 border-slate-200 bg-slate-50/70 ${etapa.color}`}>
                <div className="flex items-center justify-between px-3 py-2">
                  <p className="flex items-center gap-1.5 text-xs font-black text-slate-700">
                    <span className={`h-2 w-2 rounded-full ${etapa.punto}`} /> {etapa.label}
                  </p>
                  <span className="rounded-full bg-white px-2 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">{porEtapa[etapa.id].length}</span>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2" style={{ maxHeight: 560 }}>
                  {porEtapa[etapa.id].length === 0 ? (
                    <p className="px-2 py-4 text-center text-[11px] text-slate-400">Sin leads</p>
                  ) : (
                    porEtapa[etapa.id].map((l) => <TarjetaLead key={l.id} lead={l} onAbrir={setAbierto} onMover={(lead, est) => mover(lead, est)} />)
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <LayoutGrid size={12} /> Desliza horizontalmente en pantallas pequeñas para ver todas las etapas.
      </p>

      {abierto && (
        <ModalDetalleLead
          lead={leads.find((l) => l.id === abierto.id) || abierto}
          onClose={() => setAbierto(null)}
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
