// =============================================================================
// SuperAdmin — Pagos y transacciones
//   • Hoy: compras de horas extra de soporte (Stripe Checkout, tabla
//     soporte_compras_extra) de todos los clubes.
//   • Suscripciones: estructura lista para cuando se integre Stripe Billing;
//     mientras tanto muestra el MRR esperado según el plan de cada club.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, ExternalLink, Repeat } from 'lucide-react';
import { listarPagos, listarSaludClubes, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import { estadoSaludClub } from './AdminClubes';
import { AvisoError, Cargando, Chips, EncabezadoModulo, Metrica, Pastilla, Vacio, formatoFechaHoraCorta, formatoMXN } from './adminUi';

const ESTADO_PAGO = {
  pagada: { label: 'Pagado', clase: 'bg-emerald-400/10 text-emerald-600 ring-emerald-400/30' },
  pendiente: { label: 'Pendiente', clase: 'bg-amber-400/10 text-amber-600 ring-amber-400/30' },
  cancelada: { label: 'Cancelado', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' },
  reembolsada: { label: 'Reembolsado', clase: 'bg-rose-500/10 text-rose-500 ring-rose-500/30' },
};

function rangoPeriodo(periodo) {
  const ahora = new Date();
  if (periodo === 'mes') return { desde: new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString(), hasta: null };
  if (periodo === '30') return { desde: new Date(Date.now() - 30 * 86_400_000).toISOString(), hasta: null };
  if (periodo === '90') return { desde: new Date(Date.now() - 90 * 86_400_000).toISOString(), hasta: null };
  return { desde: null, hasta: null };
}

export default function AdminPagos() {
  const [periodo, setPeriodo] = useState('mes');
  const [pagos, setPagos] = useState([]);
  const [clubes, setClubes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const cargar = useCallback(
    async ({ silencioso = false } = {}) => {
      if (!silencioso) setCargando(true);
      const [p, c] = await Promise.all([listarPagos(rangoPeriodo(periodo)), listarSaludClubes(30)]);
      setCargando(false);
      if (p.error) return setError(mensajeErrorAdmin(p.error, 'No se pudieron cargar los pagos.'));
      setError('');
      setPagos(p.data);
      if (!c.error) setClubes(c.data);
    },
    [periodo]
  );

  useEffect(() => {
    cargar();
    return suscribirTablas(['soporte_compras_extra'], () => cargar({ silencioso: true }));
  }, [cargar]);

  const totales = useMemo(() => {
    const t = { cobrado: 0, pagos: 0, pendiente: 0, cancelado: 0 };
    pagos.forEach((p) => {
      if (p.estado === 'pagada') {
        t.cobrado += Number(p.monto_mxn) || 0;
        t.pagos += 1;
      } else if (p.estado === 'pendiente') t.pendiente += 1;
      else t.cancelado += 1;
    });
    return t;
  }, [pagos]);

  const suscripciones = useMemo(
    () =>
      clubes
        .filter((c) => estadoSaludClub(c).id === 'activo' && Number(c.plan_precio_mensual) > 0)
        .sort((a, b) => Number(b.plan_precio_mensual) - Number(a.plan_precio_mensual)),
    [clubes]
  );
  const mrr = suscripciones.reduce((s, c) => s + (Number(c.plan_precio_mensual) || 0), 0);

  return (
    <div className="space-y-4">
      <EncabezadoModulo icono={CreditCard} titulo="Pagos y transacciones" descripcion="Cobros procesados por Stripe y suscripciones esperadas." />
      <Chips
        opciones={[
          { id: 'mes', label: 'Este mes' },
          { id: '30', label: '30 días' },
          { id: '90', label: '90 días' },
          { id: 'todo', label: 'Todo' },
        ]}
        valor={periodo}
        onCambiar={setPeriodo}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Metrica etiqueta="Cobrado (horas extra)" valor={formatoMXN(totales.cobrado)} tono="emerald" ayuda={`${totales.pagos} pagos`} />
        <Metrica etiqueta="Ticket promedio" valor={formatoMXN(totales.pagos ? totales.cobrado / totales.pagos : 0)} />
        <Metrica etiqueta="Checkouts pendientes" valor={totales.pendiente} tono="amber" ayuda="Abiertos sin pagar" />
        <Metrica etiqueta="MRR esperado" valor={formatoMXN(mrr)} tono="violet" ayuda={`${suscripciones.length} planes activos`} />
      </div>
      <AvisoError texto={error} />

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Transacciones</p>
        {cargando && pagos.length === 0 ? (
          <Cargando texto="Cargando pagos…" />
        ) : pagos.length === 0 ? (
          <Vacio texto="Sin transacciones en este periodo." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Fecha</th>
                  <th className="px-4 py-2.5 font-semibold">Club</th>
                  <th className="px-4 py-2.5 font-semibold">Concepto</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Monto</th>
                  <th className="px-4 py-2.5 font-semibold">Estado</th>
                  <th className="px-4 py-2.5 font-semibold">Stripe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {pagos.map((p) => {
                  const e = ESTADO_PAGO[p.estado] || ESTADO_PAGO.cancelada;
                  return (
                    <tr key={p.id} className="text-slate-700">
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">{formatoFechaHoraCorta(p.pagado_en || p.creado_en)}</td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-xs font-semibold">
                        {p.club_nombre} <span className="text-slate-400">· ID {p.club_id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs">{p.concepto}</td>
                      <td className="px-4 py-2.5 text-right font-black text-slate-900">{formatoMXN(p.monto_mxn)}</td>
                      <td className="px-4 py-2.5">
                        <Pastilla clase={e.clase}>{e.label}</Pastilla>
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {p.stripe_payment_intent ? (
                          <a
                            href={`https://dashboard.stripe.com/payments/${encodeURIComponent(p.stripe_payment_intent)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-bold text-orange-500 hover:underline"
                          >
                            Ver pago <ExternalLink size={11} />
                          </a>
                        ) : (
                          <span className="font-mono text-[10px] text-slate-400">{p.stripe_session_id ? `${p.stripe_session_id.slice(0, 14)}…` : '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <p className="flex items-center gap-1.5 text-sm font-black text-slate-900">
          <Repeat size={15} className="text-orange-500" /> Suscripciones de clubes
        </p>
        <p className="text-xs text-slate-500">
          Lista preparada para Stripe Billing: hoy muestra el cobro mensual esperado por plan. Cuando se integre, aquí aparecerán el estado de cada cobro,
          la fecha de renovación y los pagos fallidos.
        </p>
        {suscripciones.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-500">Ningún club con plan activo y precio definido.</p>
        ) : (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {suscripciones.slice(0, 50).map((c) => (
              <div key={c.club_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-semibold text-slate-800">
                  {c.nombre} <span className="text-slate-400">· {c.plan_nombre || `${c.plan_canchas || '—'} canchas`}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-black text-slate-900">{formatoMXN(c.plan_precio_mensual)}/mes</span>
                  <Pastilla clase="bg-slate-400/10 text-slate-500 ring-slate-400/30">Cobro fuera de Stripe</Pastilla>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
