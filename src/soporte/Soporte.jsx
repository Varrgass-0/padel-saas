// =============================================================================
// Soporte & Acompañamiento — Vista del CLUB (/soporte)
// Visible para Owner / Admin del club. Bolsa mensual de horas, canales de
// atención (WhatsApp y videollamada en Cal.com + Google Calendar), próximas
// citas y el historial de atenciones.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LifeBuoy,
  MessageCircle,
  Video,
  CalendarClock,
  Clock,
  CreditCard,
  ExternalLink,
  AlertTriangle,
  RefreshCw,
  Loader2,
  Info,
  Lock,
} from 'lucide-react';
import {
  CANALES_SOPORTE,
  ESTADOS_TICKET,
  PRECIO_HORA_EXTRA_MXN,
  TOLERANCIA_MINUTOS,
  ANTICIPACION_CANCELACION_HORAS,
  configSoporte,
  enlaceWhatsAppSoporte,
  enlacesGestionCalcom,
  estadoSalaCita,
  evaluarCancelacion,
  formatoFecha,
  formatoFechaHora,
  formatoMinutos,
  formatoMXN,
  resumenBolsa,
  urlSeguraHttp,
} from './soporteReglas';
import {
  obtenerBolsa,
  listarTickets,
  listarComprasExtra,
  registrarConexion,
  suscribirCambiosSoporte,
  obtenerUsuarioActual,
  mensajeError,
  esErrorEsquemaSoporte,
} from './soporteApi';
import { ModalComprarHorasExtra, ModalAgendarVideollamada } from './SoporteModal';

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
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bolsa de horas de soporte</p>
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
          <Dato etiqueta="Horas extra" valor={formatoMinutos(Math.max(0, r.extra))} />
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
            <CreditCard size={16} /> + Comprar horas extra ({formatoMXN(PRECIO_HORA_EXTRA_MXN)} MXN / hr)
          </button>
        ) : (
          <button type="button" onClick={onComprar} className="mt-4 text-xs font-bold text-orange-500 hover:underline">
            ¿Necesitas más tiempo? + Comprar horas extra ({formatoMXN(PRECIO_HORA_EXTRA_MXN)} MXN / hr)
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
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2.5 font-semibold">Fecha</th>
            <th className="px-4 py-2.5 font-semibold">Canal</th>
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
                <td className="px-4 py-2.5 text-xs font-semibold">{CANALES_SOPORTE[t.canal]?.label || t.canal}</td>
                <td className="max-w-[260px] truncate px-4 py-2.5 text-xs" title={t.concepto || ''}>
                  {t.concepto || '—'}
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

function TarjetaProximaCita({ cita, ahora, calcomBase, onUnirme, uniendose }) {
  const sala = estadoSalaCita(cita, ahora);
  const meet = urlSeguraHttp(cita.meet_url);
  const gestion = enlacesGestionCalcom(calcomBase, cita.calcom_uid);
  const politica = evaluarCancelacion(cita.inicio, cita.minutos_reservados, ahora);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-400/10 text-orange-500">
          <Video size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900">{formatoFechaHora(cita.inicio)}</p>
          <p className="truncate text-xs text-slate-500">
            {formatoMinutos(cita.minutos_reservados)} · {cita.concepto || 'Videollamada de soporte'}
          </p>
          {sala !== 'abierta' && gestion.cancelar && (
            <p className={`mt-1 text-[11px] font-semibold ${politica.tardia ? 'text-amber-600' : 'text-slate-500'}`}>{politica.mensaje}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sala === 'abierta' && meet && (
          <button
            type="button"
            onClick={() => onUnirme(cita)}
            disabled={uniendose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-black text-white transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {uniendose ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />} Unirme a la llamada
          </button>
        )}
        {sala === 'pronto' && <span className="text-[11px] font-semibold text-slate-500">La sala abre 15 min antes</span>}
        {sala !== 'vencida' && gestion.reagendar && (
          <a href={gestion.reagendar} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:border-orange-300 hover:text-orange-500">
            Reagendar
          </a>
        )}
        {sala !== 'vencida' && gestion.cancelar && (
          <a href={gestion.cancelar} target="_blank" rel="noopener noreferrer" className="rounded-lg px-3 py-2 text-xs font-bold text-slate-500 hover:text-rose-500">
            Cancelar
          </a>
        )}
      </div>
    </div>
  );
}

export default function Soporte({ clubId, nombreClub, nombreUsuario, puedeGestionar = true, onToast }) {
  const config = useMemo(() => configSoporte(), []);
  const [bolsa, setBolsa] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [compras, setCompras] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [esquemaFaltante, setEsquemaFaltante] = useState(false);
  const [modal, setModal] = useState(null); // 'comprar' | 'agendar' | null
  const [contacto, setContacto] = useState(null);
  const [ahora, setAhora] = useState(() => new Date());
  const [uniendoseId, setUniendoseId] = useState(null);
  const montadoRef = useRef(true);
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const cargar = useCallback(
    async ({ silencioso = false } = {}) => {
      if (clubId == null) return;
      if (!silencioso) setCargando(true);
      const [b, t, c] = await Promise.all([obtenerBolsa(clubId), listarTickets(clubId), listarComprasExtra(clubId)]);
      if (!montadoRef.current) return;
      const primerError = b.error || t.error || c.error;
      setEsquemaFaltante(Boolean(primerError && esErrorEsquemaSoporte(primerError)));
      setError(primerError ? mensajeError(primerError, 'No se pudo cargar tu información de soporte.') : '');
      if (!b.error) setBolsa(b.data || null);
      if (!t.error) setTickets(t.data);
      if (!c.error) setCompras(c.data);
      setCargando(false);
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
    cargar();
    obtenerUsuarioActual().then((u) => montadoRef.current && setContacto(u));
    const quitar = suscribirCambiosSoporte(clubId, () => cargar({ silencioso: true }));
    const reloj = setInterval(() => setAhora(new Date()), 30_000);
    return () => {
      quitar();
      clearInterval(reloj);
    };
  }, [cargar, clubId, puedeGestionar]);

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

  const resumen = resumenBolsa(bolsa);
  const proximas = useMemo(
    () =>
      tickets
        .filter((t) => t.estado === 'agendada' && estadoSalaCita(t, ahora) !== 'vencida')
        .sort((a, b) => new Date(a.inicio).getTime() - new Date(b.inicio).getTime()),
    [tickets, ahora]
  );
  const linkWhatsApp = enlaceWhatsAppSoporte({
    numero: config.whatsappNumero,
    nombreClub,
    clubId,
    nombreUsuario: nombreUsuario || contacto?.nombre,
  });
  const hayAgenda = Boolean(config.calcomUrl30 || config.calcomUrl60);

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
        No hay un club activo en esta sesión. Vuelve a iniciar sesión para ver tu bolsa de soporte.
      </div>
    );
  }

  if (!puedeGestionar) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <Lock size={22} className="mx-auto text-slate-400" />
        <p className="mt-2 text-sm font-bold text-slate-900">Soporte & Acompañamiento</p>
        <p className="mt-1 text-xs text-slate-500">Esta sección es exclusiva del Owner / Administrador del club.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <LifeBuoy size={14} /> Soporte & Acompañamiento
        </p>
        <button
          type="button"
          onClick={() => cargar()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:border-orange-300 hover:text-orange-500"
        >
          <RefreshCw size={13} className={cargando ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

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
            <WidgetBolsaHoras bolsa={bolsa} onComprar={esquemaFaltante ? null : () => setModal('comprar')} />
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Canales de atención</p>
          <div className="mt-3 space-y-2">
            {linkWhatsApp ? (
              <a
                href={linkWhatsApp}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-600 transition hover:bg-emerald-500/20"
              >
                <MessageCircle size={18} /> WhatsApp directo
              </a>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-xs text-slate-500">
                WhatsApp de soporte no configurado (VITE_WHATSAPP_SUPPORT_NUMBER).
              </p>
            )}
            <button
              type="button"
              onClick={() => setModal('agendar')}
              disabled={!hayAgenda || !resumen.puedeAgendar30 || esquemaFaltante}
              className="flex w-full items-center gap-3 rounded-xl border border-orange-400/40 bg-orange-400/10 px-4 py-3 text-left text-sm font-bold text-orange-500 transition hover:bg-orange-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CalendarClock size={18} /> Agendar videollamada / capacitación
            </button>
            {hayAgenda && !resumen.puedeAgendar30 && !cargando && (
              <p className="text-[11px] font-semibold text-rose-500">Necesitas al menos 30 min disponibles para agendar.</p>
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

      {proximas.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Próximas citas</p>
          {proximas.map((c) => (
            <TarjetaProximaCita
              key={c.id}
              cita={c}
              ahora={ahora}
              calcomBase={config.calcomUrl30 || config.calcomUrl60}
              onUnirme={unirme}
              uniendose={uniendoseId === c.id}
            />
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Historial de atenciones</p>
        {cargando && tickets.length === 0 ? <div className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-slate-100" /> : <TablaHistorialSoporte tickets={tickets} />}
      </div>

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

      {modal === 'comprar' && <ModalComprarHorasExtra clubId={clubId} nombreClub={nombreClub} onClose={() => setModal(null)} />}
      {modal === 'agendar' && (
        <ModalAgendarVideollamada
          config={config}
          clubId={clubId}
          contacto={{ nombre: nombreUsuario || contacto?.nombre, email: contacto?.email }}
          resumen={resumen}
          onClose={() => {
            setModal(null);
            cargar({ silencioso: true });
          }}
        />
      )}
    </div>
  );
}
