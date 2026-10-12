// =============================================================================
// Soporte & Acompañamiento — modales
//   • ModalSoporte (base)            • ModalComprarHorasExtra (Stripe)
//   • ModalAgendarVideollamada (Cal.com + Google Calendar/Meet)
//   • ModalRegistrarAtencion (SuperAdmin: registrar / ajustar minutos reales)
// =============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, CreditCard, Video, ExternalLink, AlertTriangle, Check, Info } from 'lucide-react';
import {
  PRECIO_HORA_EXTRA_MXN,
  HORAS_EXTRA_OPCIONES,
  CANALES_SOPORTE,
  ESTADOS_TICKET,
  formatoMXN,
  formatoMinutos,
  formatoFechaHora,
  urlCalcom,
} from './soporteReglas';
import { iniciarCompraHorasExtra, registrarAtencionAdmin, mensajeError } from './soporteApi';

const claseInput =
  'w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-orange-400 focus:ring-1 focus:ring-orange-400';

export function ModalSoporte({ titulo, subtitulo, onClose, children, ancho = 'max-w-lg' }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', onKey);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflowPrevio;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-900/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[92vh] w-full ${ancho} flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-900">{titulo}</h2>
            {subtitulo && <p className="mt-0.5 text-xs text-slate-500">{subtitulo}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// -----------------------------------------------------------------------------
// Comprar horas extra ($350 MXN / hr) → Stripe Checkout
// -----------------------------------------------------------------------------
export function ModalComprarHorasExtra({ clubId, nombreClub, onClose }) {
  const [horas, setHoras] = useState(1);
  const [procesando, setProcesando] = useState(false);
  const [error, setError] = useState('');
  const total = horas * PRECIO_HORA_EXTRA_MXN;

  async function pagar() {
    setProcesando(true);
    setError('');
    const { data, error: err } = await iniciarCompraHorasExtra({ clubId, horas });
    if (err || !data?.url) {
      setError(mensajeError(err, 'No se pudo iniciar el pago.'));
      setProcesando(false);
      return;
    }
    window.location.assign(data.url);
  }

  return (
    <ModalSoporte titulo="Comprar horas extra" subtitulo={`${formatoMXN(PRECIO_HORA_EXTRA_MXN)} MXN por hora · ${nombreClub || 'tu club'}`} onClose={procesando ? undefined : onClose}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">¿Cuántas horas necesitas?</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {HORAS_EXTRA_OPCIONES.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setHoras(h)}
            aria-pressed={horas === h}
            className={`rounded-xl border px-3 py-3 text-center transition ${
              horas === h ? 'border-orange-400 bg-orange-400/10 text-orange-500 ring-1 ring-orange-400' : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-orange-300'
            }`}
          >
            <span className="block text-lg font-black">{h} h</span>
            <span className="block text-[11px] font-semibold text-slate-500">{formatoMXN(h * PRECIO_HORA_EXTRA_MXN)}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
        <div className="flex items-center justify-between">
          <span>
            {horas} {horas === 1 ? 'hora' : 'horas'} × {formatoMXN(PRECIO_HORA_EXTRA_MXN)}
          </span>
          <span className="text-base font-black text-slate-900">{formatoMXN(total)} MXN</span>
        </div>
        <p className="mt-2 flex items-start gap-1.5">
          <Info size={13} className="mt-0.5 shrink-0" />
          Se suman {formatoMinutos(horas * 60)} a tu bolsa en cuanto Stripe confirma el pago. Las horas extra no vencen: se usan después de las horas de tu plan.
        </p>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-500">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={procesando} className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-900 disabled:opacity-50">
          Cancelar
        </button>
        <button
          type="button"
          onClick={pagar}
          disabled={procesando}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-400 px-4 py-2 text-sm font-black text-slate-950 transition hover:bg-orange-300 disabled:opacity-60"
        >
          {procesando ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
          Pagar {formatoMXN(total)} con Stripe
        </button>
      </div>
    </ModalSoporte>
  );
}

// -----------------------------------------------------------------------------
// Agendar videollamada / capacitación — widget de Cal.com (sincronizado con
// Google Calendar: solo muestra horarios libres y bloquea los ya tomados por
// otros clubes o por la agenda corporativa).
// -----------------------------------------------------------------------------
export function ModalAgendarVideollamada({ config, clubId, contacto, resumen, onClose }) {
  const opciones = [
    { minutos: 30, url: config?.calcomUrl30, habilitada: resumen?.puedeAgendar30 },
    { minutos: 60, url: config?.calcomUrl60, habilitada: resumen?.puedeAgendar60 },
  ].filter((o) => o.url);
  const primeraHabilitada = opciones.find((o) => o.habilitada) || null;
  const [duracion, setDuracion] = useState(primeraHabilitada?.minutos ?? null);
  const elegida = opciones.find((o) => o.minutos === duracion && o.habilitada) || null;
  const tema = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';

  const urlEmbed = useMemo(
    () => (elegida ? urlCalcom(elegida.url, { clubId, nombre: contacto?.nombre, email: contacto?.email, tema }) : null),
    [elegida, clubId, contacto?.nombre, contacto?.email, tema]
  );
  const urlNuevaPestana = elegida ? urlCalcom(elegida.url, { clubId, nombre: contacto?.nombre, email: contacto?.email, embed: false }) : null;

  return (
    <ModalSoporte titulo="Agendar videollamada / capacitación" subtitulo="Horarios en vivo de nuestro calendario · Google Meet" onClose={onClose} ancho="max-w-3xl">
      {opciones.length === 0 ? (
        <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-3 text-sm text-amber-600">
          La agenda en línea aún no está configurada (faltan VITE_CALCOM_URL_30 / VITE_CALCOM_URL_60). Escríbenos por WhatsApp para agendar.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {opciones.map((o) => (
              <button
                key={o.minutos}
                type="button"
                disabled={!o.habilitada}
                onClick={() => setDuracion(o.minutos)}
                aria-pressed={duracion === o.minutos}
                className={`rounded-lg border px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  duracion === o.minutos ? 'border-orange-400 bg-orange-400/10 text-orange-500' : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-orange-300'
                }`}
              >
                <Video size={13} className="mr-1 inline" /> Sesión de {o.minutos} min
              </button>
            ))}
            <span className="text-[11px] text-slate-500">Disponible: {formatoMinutos(resumen?.disponibles)}</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Al confirmar se retienen los minutos. Cancela con 2 h o más de anticipación para liberarlos completos; con menos de 2 h se descuenta el 50 %. Si no te
            conectas en los primeros 10 min, la sesión se marca como "No asistió" y se descuenta completa.
          </p>

          {!elegida ? (
            <p className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-3 text-sm font-semibold text-rose-500">
              No tienes minutos suficientes para agendar. Compra horas extra para continuar.
            </p>
          ) : (
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <iframe
                key={urlEmbed}
                title="Agenda de soporte QLUBOS"
                src={urlEmbed || undefined}
                className="h-[620px] w-full bg-white"
                loading="lazy"
                allow="payment"
              />
            </div>
          )}
          {urlNuevaPestana && (
            <a href={urlNuevaPestana} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-orange-500 hover:underline">
              ¿No carga la agenda? Ábrela en otra pestaña <ExternalLink size={12} />
            </a>
          )}
        </>
      )}
    </ModalSoporte>
  );
}

// -----------------------------------------------------------------------------
// SuperAdmin: registrar una atención nueva o ajustar una existente con los
// minutos REALES (ej. cita de 30 min que duró 20).
// -----------------------------------------------------------------------------
const ESTADOS_ADMIN = ['completada', 'no_show', 'cancelada_tardia', 'cancelada'];
const MINUTOS_RAPIDOS = [10, 15, 20, 30, 45, 60];

function aInputLocal(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ModalRegistrarAtencion({ clubes, clubIdInicial, ticketsDelClub, ticketInicial, onClose, onGuardado }) {
  const [clubId, setClubId] = useState(clubIdInicial ?? ticketInicial?.club_id ?? '');
  const [ticketId, setTicketId] = useState(ticketInicial?.id ?? '');
  const ticket = (ticketsDelClub || []).find((t) => t.id === ticketId) || (ticketInicial?.id === ticketId ? ticketInicial : null);
  const [canal, setCanal] = useState(ticket?.canal || 'videollamada');
  const [concepto, setConcepto] = useState(ticket?.concepto || '');
  const [minutos, setMinutos] = useState(ticket ? String(ticket.minutos_reservados || ticket.minutos_consumidos || 30) : '30');
  const [estado, setEstado] = useState(ticket && ticket.estado !== 'agendada' ? ticket.estado : 'completada');
  const [inicio, setInicio] = useState(aInputLocal(ticket?.inicio));
  const [meetUrl, setMeetUrl] = useState(ticket?.meet_url || '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  // Al elegir otra atención existente, precargar sus datos.
  function elegirTicket(id) {
    setTicketId(id);
    const t = (ticketsDelClub || []).find((x) => x.id === id);
    if (t) {
      setCanal(t.canal || 'videollamada');
      setConcepto(t.concepto || '');
      setMinutos(String(t.minutos_reservados || t.minutos_consumidos || 30));
      setEstado(t.estado !== 'agendada' ? t.estado : 'completada');
      setInicio(aInputLocal(t.inicio));
      setMeetUrl(t.meet_url || '');
    } else {
      setConcepto('');
      setMinutos('30');
      setEstado('completada');
      setInicio(aInputLocal(null));
      setMeetUrl('');
    }
  }

  const ticketsAjustables = (ticketsDelClub || []).filter((t) => String(t.club_id) === String(clubId)).slice(0, 50);

  async function guardar() {
    setError('');
    const min = Number(minutos);
    if (!clubId) return setError('Elige un club.');
    if (!Number.isFinite(min) || min < 0 || min > 600) return setError('Los minutos deben estar entre 0 y 600.');
    if (!ticketId && !concepto.trim()) return setError('Describe brevemente el concepto de la atención.');
    if (meetUrl && !/^https:\/\//i.test(meetUrl)) return setError('El enlace de Meet debe empezar con https://');
    setGuardando(true);
    const fecha = inicio ? new Date(inicio) : null;
    const { data, error: err } = await registrarAtencionAdmin({
      clubId,
      ticketId: ticketId || null,
      canal,
      concepto: concepto.trim() || null,
      minutos: estado === 'cancelada' ? 0 : min,
      estado,
      inicio: fecha && !Number.isNaN(fecha.getTime()) ? fecha.toISOString() : null,
      meetUrl: meetUrl.trim() || null,
    });
    setGuardando(false);
    if (err) return setError(mensajeError(err, 'No se pudo guardar la atención.'));
    onGuardado?.(data);
    onClose?.();
  }

  return (
    <ModalSoporte titulo={ticketId ? 'Ajustar atención' : 'Registrar atención'} subtitulo="Los minutos reales se descuentan de la bolsa del club al guardar" onClose={guardando ? undefined : onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-bold text-slate-600">Club</span>
          <select value={clubId} onChange={(e) => { setClubId(e.target.value); elegirTicket(''); }} className={`${claseInput} mt-1`} disabled={Boolean(ticketInicial)}>
            <option value="">Selecciona un club…</option>
            {(clubes || []).map((c) => (
              <option key={c.club_id} value={c.club_id}>
                {c.nombre} · disp. {formatoMinutos(c.minutos_disponibles_mes)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">Atención</span>
          <select value={ticketId} onChange={(e) => elegirTicket(e.target.value)} className={`${claseInput} mt-1`} disabled={!clubId}>
            <option value="">+ Nueva atención</option>
            {ticketsAjustables.map((t) => (
              <option key={t.id} value={t.id}>
                {formatoFechaHora(t.inicio)} · {CANALES_SOPORTE[t.canal]?.label || t.canal} · {ESTADOS_TICKET[t.estado]?.label || t.estado} · {formatoMinutos(t.minutos_reservados)}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Canal</span>
            <select value={canal} onChange={(e) => setCanal(e.target.value)} className={`${claseInput} mt-1`}>
              {Object.entries(CANALES_SOPORTE).map(([v, m]) => (
                <option key={v} value={v}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Fecha y hora</span>
            <input type="datetime-local" value={inicio} onChange={(e) => setInicio(e.target.value)} className={`${claseInput} mt-1`} />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">Concepto</span>
          <input value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej. Capacitación de Smart POS" className={`${claseInput} mt-1`} maxLength={200} />
        </label>

        <div>
          <span className="text-xs font-bold text-slate-600">Estatus</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {ESTADOS_ADMIN.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEstado(e)}
                aria-pressed={estado === e}
                className={`rounded-full px-3 py-1 text-[11px] font-bold ring-1 transition ${
                  estado === e ? ESTADOS_TICKET[e].clase : 'bg-slate-50 text-slate-500 ring-slate-200 hover:text-slate-900'
                }`}
              >
                {estado === e && <Check size={11} className="mr-1 inline" />}
                {ESTADOS_TICKET[e].label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="text-xs font-bold text-slate-600">Minutos reales consumidos</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={600}
              value={estado === 'cancelada' ? '0' : minutos}
              disabled={estado === 'cancelada'}
              onChange={(e) => setMinutos(e.target.value)}
              className={`${claseInput} w-24`}
            />
            {MINUTOS_RAPIDOS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={estado === 'cancelada'}
                onClick={() => setMinutos(String(m))}
                className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-bold text-slate-600 hover:border-orange-300 disabled:opacity-40"
              >
                {m}
              </button>
            ))}
          </div>
          {ticket && (
            <p className="mt-1 text-[11px] text-slate-500">
              Agendada por {formatoMinutos(ticket.minutos_reservados)}
              {ticket.minutos_consumidos ? ` · cobrado hoy: ${formatoMinutos(ticket.minutos_consumidos)}` : ''}
            </p>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">Enlace de Meet (opcional)</span>
          <input value={meetUrl} onChange={(e) => setMeetUrl(e.target.value)} placeholder="https://meet.google.com/…" className={`${claseInput} mt-1`} />
        </label>

        {error && (
          <p className="flex items-start gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-500">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={guardando} className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-900 disabled:opacity-50">
          Cancelar
        </button>
        <button
          type="button"
          onClick={guardar}
          disabled={guardando}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-400 px-4 py-2 text-sm font-black text-slate-950 transition hover:bg-orange-300 disabled:opacity-60"
        >
          {guardando ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          Guardar y recalcular bolsa
        </button>
      </div>
    </ModalSoporte>
  );
}

export default ModalSoporte;
