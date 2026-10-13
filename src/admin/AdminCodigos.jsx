// =============================================================================
// SuperAdmin — Códigos promocionales (tabla existente public.codigos_promocionales)
// Columnas: codigo, dias_prueba, activo, usos_maximos (NULL = ilimitado),
// usos_actuales, created_at. La app los valida en el Onboarding (v84).
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ticket, Plus, Loader2, Trash2, Infinity as InfinityIcon } from 'lucide-react';
import { ModalSoporte } from '../soporte/SoporteModal';
import { listarCodigos, crearCodigo, actualizarCodigo, eliminarCodigo, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import {
  AvisoError,
  Cargando,
  Chips,
  EncabezadoModulo,
  Metrica,
  Pastilla,
  Vacio,
  claseBotonPrimario,
  claseBotonSecundario,
  claseInput,
  formatoFechaCorta,
} from './adminUi';

function estadoCodigo(c) {
  if (!c.activo) return { id: 'inactivo', label: 'Inactivo', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' };
  if (c.usos_maximos != null && Number(c.usos_actuales) >= Number(c.usos_maximos)) {
    return { id: 'agotado', label: 'Agotado', clase: 'bg-amber-400/10 text-amber-600 ring-amber-400/30' };
  }
  return { id: 'activo', label: 'Activo', clase: 'bg-emerald-400/10 text-emerald-600 ring-emerald-400/30' };
}

function ModalCodigo({ codigo, onClose, onGuardado }) {
  const editando = Boolean(codigo);
  const [texto, setTexto] = useState(codigo?.codigo || '');
  const [dias, setDias] = useState(String(codigo?.dias_prueba ?? 15));
  const [ilimitado, setIlimitado] = useState(codigo ? codigo.usos_maximos == null : true);
  const [usos, setUsos] = useState(codigo?.usos_maximos != null ? String(codigo.usos_maximos) : '50');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  async function guardar() {
    setError('');
    const limpio = texto.trim().toUpperCase().replace(/\s+/g, '');
    if (!editando && !/^[A-Z0-9_-]{4,30}$/.test(limpio)) return setError('El código debe tener de 4 a 30 caracteres: letras, números, guion o guion bajo.');
    const d = Number(dias);
    if (!Number.isInteger(d) || d < 1 || d > 365) return setError('Los días de prueba deben estar entre 1 y 365.');
    const u = ilimitado ? null : Number(usos);
    if (!ilimitado && (!Number.isInteger(u) || u < 1)) return setError('Los usos máximos deben ser un número mayor a 0.');
    if (editando && u != null && u < Number(codigo.usos_actuales)) return setError(`Ya tiene ${codigo.usos_actuales} usos: el máximo no puede ser menor.`);
    setGuardando(true);
    const r = editando
      ? await actualizarCodigo(codigo.id, { dias_prueba: d, usos_maximos: u })
      : await crearCodigo({ codigo: limpio, diasPrueba: d, usosMaximos: u });
    setGuardando(false);
    if (r.error) {
      return setError(r.error.code === '23505' ? 'Ese código ya existe.' : mensajeErrorAdmin(r.error, 'No se pudo guardar el código.'));
    }
    onGuardado?.(r.data);
    onClose();
  }

  return (
    <ModalSoporte titulo={editando ? `Editar ${codigo.codigo}` : 'Nuevo código promocional'} subtitulo="Periodo de prueba canjeable en el Onboarding de clubes" onClose={guardando ? undefined : onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-bold text-slate-600">Código</span>
          <input
            value={texto}
            onChange={(e) => setTexto(e.target.value.toUpperCase())}
            disabled={editando}
            placeholder="Ej. PADELFEST30"
            className={`${claseInput} mt-1 font-mono uppercase tracking-wider`}
            maxLength={30}
          />
          {!editando && <span className="mt-1 block text-[11px] text-slate-500">Se guarda en mayúsculas y sin espacios, como lo valida la app.</span>}
        </label>
        <label className="block">
          <span className="text-xs font-bold text-slate-600">Días de prueba</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <input type="number" min={1} max={365} value={dias} onChange={(e) => setDias(e.target.value)} className={`${claseInput} w-24`} />
            {[7, 14, 15, 30, 60].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setDias(String(n))}
                className={`rounded-md border px-2 py-1 text-[11px] font-bold ${String(n) === dias ? 'border-orange-400 text-orange-500' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </label>
        <div>
          <span className="text-xs font-bold text-slate-600">Usos máximos</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <input type="checkbox" checked={ilimitado} onChange={(e) => setIlimitado(e.target.checked)} className="accent-orange-500" /> Ilimitado
            </label>
            {!ilimitado && <input type="number" min={1} value={usos} onChange={(e) => setUsos(e.target.value)} className={`${claseInput} w-28`} />}
          </div>
        </div>
        <AvisoError texto={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={claseBotonSecundario} onClick={onClose} disabled={guardando}>
          Cancelar
        </button>
        <button type="button" className={claseBotonPrimario} onClick={guardar} disabled={guardando}>
          {guardando ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {editando ? 'Guardar cambios' : 'Crear código'}
        </button>
      </div>
    </ModalSoporte>
  );
}

export default function AdminCodigos({ onToast }) {
  const [codigos, setCodigos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [modal, setModal] = useState(null); // { codigo? }

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setCargando(true);
    const { data, error: err } = await listarCodigos();
    setCargando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudieron cargar los códigos.'));
    setError('');
    setCodigos(data);
  }, []);

  useEffect(() => {
    cargar();
    return suscribirTablas(['codigos_promocionales'], () => cargar({ silencioso: true }));
  }, [cargar]);

  const conteo = useMemo(() => {
    const c = { todos: codigos.length, activo: 0, agotado: 0, inactivo: 0 };
    codigos.forEach((x) => (c[estadoCodigo(x).id] += 1));
    return c;
  }, [codigos]);
  const visibles = filtro === 'todos' ? codigos : codigos.filter((c) => estadoCodigo(c).id === filtro);
  const usosTotales = codigos.reduce((s, c) => s + (Number(c.usos_actuales) || 0), 0);

  async function alternar(c) {
    const activar = !c.activo;
    setCodigos((prev) => prev.map((x) => (x.id === c.id ? { ...x, activo: activar } : x)));
    const { error: err } = await actualizarCodigo(c.id, { activo: activar });
    if (err) {
      onToast?.({ titulo: 'No se pudo cambiar el código', detalle: mensajeErrorAdmin(err), tono: 'error' });
      cargar({ silencioso: true });
    } else {
      onToast?.({ titulo: activar ? 'Código activado' : 'Código desactivado', detalle: c.codigo });
    }
  }

  async function borrar(c) {
    if (Number(c.usos_actuales) > 0) return;
    const { error: err } = await eliminarCodigo(c.id);
    if (err) return onToast?.({ titulo: 'No se pudo eliminar', detalle: mensajeErrorAdmin(err), tono: 'error' });
    setCodigos((prev) => prev.filter((x) => x.id !== c.id));
    onToast?.({ titulo: 'Código eliminado', detalle: c.codigo });
  }

  return (
    <div className="space-y-4">
      <EncabezadoModulo
        icono={Ticket}
        titulo="Códigos promocionales"
        descripcion="Códigos de periodo de prueba que los clubes canjean al registrarse."
        acciones={
          <button type="button" className={claseBotonPrimario} onClick={() => setModal({})}>
            <Plus size={14} /> Nuevo código
          </button>
        }
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Metrica etiqueta="Códigos" valor={codigos.length} />
        <Metrica etiqueta="Activos" valor={conteo.activo} tono="emerald" />
        <Metrica etiqueta="Agotados" valor={conteo.agotado} tono="amber" />
        <Metrica etiqueta="Canjes totales" valor={usosTotales} tono="sky" />
      </div>
      <AvisoError texto={error} />
      <Chips
        opciones={[
          { id: 'todos', label: 'Todos', cuenta: conteo.todos },
          { id: 'activo', label: 'Activos', cuenta: conteo.activo },
          { id: 'agotado', label: 'Agotados', cuenta: conteo.agotado },
          { id: 'inactivo', label: 'Inactivos', cuenta: conteo.inactivo },
        ]}
        valor={filtro}
        onCambiar={setFiltro}
      />
      {cargando && codigos.length === 0 ? (
        <Cargando texto="Cargando códigos…" />
      ) : visibles.length === 0 ? (
        <Vacio texto="No hay códigos en esta categoría." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Código</th>
                <th className="px-4 py-2.5 font-semibold">Prueba</th>
                <th className="px-4 py-2.5 font-semibold">Uso</th>
                <th className="px-4 py-2.5 font-semibold">Estado</th>
                <th className="px-4 py-2.5 font-semibold">Creado</th>
                <th className="px-4 py-2.5 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {visibles.map((c) => {
                const est = estadoCodigo(c);
                const max = c.usos_maximos == null ? null : Number(c.usos_maximos);
                const usados = Number(c.usos_actuales) || 0;
                const pct = max ? Math.min(100, Math.round((usados / max) * 100)) : 0;
                return (
                  <tr key={c.id} className="text-slate-700">
                    <td className="px-4 py-2.5 font-mono text-sm font-black tracking-wider text-slate-900">{c.codigo}</td>
                    <td className="px-4 py-2.5 text-xs font-semibold">{c.dias_prueba} días</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
                        {usados} /{' '}
                        {max == null ? (
                          <span className="inline-flex items-center gap-0.5 text-slate-500">
                            <InfinityIcon size={13} /> ilimitado
                          </span>
                        ) : (
                          max
                        )}
                      </div>
                      {max != null && (
                        <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-200">
                          <div className={`h-full rounded-full ${pct >= 100 ? 'bg-amber-400' : 'bg-orange-400'}`} style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Pastilla clase={est.clase}>{est.label}</Pastilla>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatoFechaCorta(c.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={Boolean(c.activo)}
                          aria-label={c.activo ? `Desactivar ${c.codigo}` : `Activar ${c.codigo}`}
                          onClick={() => alternar(c)}
                          className={`relative h-5 w-9 rounded-full transition ${c.activo ? 'bg-emerald-500' : 'bg-slate-300'}`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${c.activo ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                        <button type="button" onClick={() => setModal({ codigo: c })} className="rounded-md px-2 py-1 text-[11px] font-bold text-orange-500 hover:bg-orange-400/10">
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => borrar(c)}
                          disabled={usados > 0}
                          title={usados > 0 ? 'Ya se usó: desactívalo en lugar de eliminarlo' : 'Eliminar'}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {modal && (
        <ModalCodigo
          codigo={modal.codigo || null}
          onClose={() => setModal(null)}
          onGuardado={(c) => {
            onToast?.({ titulo: modal.codigo ? 'Código actualizado' : 'Código creado', detalle: c?.codigo });
            cargar({ silencioso: true });
          }}
        />
      )}
    </div>
  );
}
