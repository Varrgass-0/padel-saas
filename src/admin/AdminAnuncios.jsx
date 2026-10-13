// =============================================================================
// SuperAdmin — Anuncios y notificaciones masivas
//   • Banners (anuncios_plataforma, tabla nueva): aparecen arriba del panel de
//     cada club mientras estén vigentes. El club puede ocultarlos.
//   • Notificación masiva: inserta en la tabla EXISTENTE notificaciones_club
//     (tipo 'anuncio_qlubos') → llega a la campana de alertas de cada club.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Megaphone, Plus, Loader2, Send, Trash2 } from 'lucide-react';
import { ModalSoporte } from '../soporte/SoporteModal';
import { BannerAnuncio } from './BannerAnunciosPlataforma';
import { listarAnunciosAdmin, guardarAnuncio, eliminarAnuncio, notificarClubes, listarSaludClubes, suscribirTablas, mensajeErrorAdmin } from './adminApi';
import { AvisoError, Cargando, EncabezadoModulo, Pastilla, Vacio, claseBotonPrimario, claseBotonSecundario, claseInput, formatoFechaHoraCorta } from './adminUi';

export const TIPOS_ANUNCIO = [
  { id: 'novedad', label: 'Novedad' },
  { id: 'mantenimiento', label: 'Mantenimiento' },
  { id: 'alerta', label: 'Alerta' },
  { id: 'promocion', label: 'Promoción' },
];

function estadoAnuncio(a, ahora = Date.now()) {
  if (!a.activo) return { label: 'Inactivo', clase: 'bg-slate-400/10 text-slate-500 ring-slate-400/30' };
  if (new Date(a.inicia_en).getTime() > ahora) return { label: 'Programado', clase: 'bg-sky-400/10 text-sky-600 ring-sky-400/30' };
  if (a.termina_en && new Date(a.termina_en).getTime() <= ahora) return { label: 'Expirado', clase: 'bg-amber-400/10 text-amber-600 ring-amber-400/30' };
  return { label: 'Publicado', clase: 'bg-emerald-400/10 text-emerald-600 ring-emerald-400/30' };
}

function aLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ModalAnuncio({ anuncio, onClose, onGuardado }) {
  const [f, setF] = useState(() => ({
    id: anuncio?.id,
    titulo: anuncio?.titulo || '',
    mensaje: anuncio?.mensaje || '',
    tipo: anuncio?.tipo || 'novedad',
    enlace_url: anuncio?.enlace_url || '',
    enlace_texto: anuncio?.enlace_texto || '',
    activo: anuncio ? anuncio.activo : true,
    inicia: aLocal(anuncio?.inicia_en) || aLocal(new Date().toISOString()),
    termina: aLocal(anuncio?.termina_en),
  }));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  async function guardar() {
    setError('');
    if (f.titulo.trim().length < 3) return setError('El título debe tener al menos 3 caracteres.');
    if (f.enlace_url && !/^https:\/\//i.test(f.enlace_url)) return setError('El enlace debe empezar con https://');
    const inicia = f.inicia ? new Date(f.inicia) : new Date();
    const termina = f.termina ? new Date(f.termina) : null;
    if (termina && termina <= inicia) return setError('La fecha de fin debe ser posterior al inicio.');
    setGuardando(true);
    const { data, error: err } = await guardarAnuncio({
      ...f,
      titulo: f.titulo.trim(),
      mensaje: f.mensaje.trim(),
      inicia_en: inicia.toISOString(),
      termina_en: termina ? termina.toISOString() : null,
    });
    setGuardando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudo guardar el anuncio.'));
    onGuardado?.(data);
    onClose();
  }

  const vistaPrevia = { titulo: f.titulo || 'Título del anuncio', mensaje: f.mensaje, tipo: f.tipo, enlace_url: f.enlace_url, enlace_texto: f.enlace_texto };
  return (
    <ModalSoporte titulo={anuncio ? 'Editar anuncio' : 'Nuevo anuncio'} subtitulo="Banner visible en el panel de todos los clubes" onClose={guardando ? undefined : onClose} ancho="max-w-2xl">
      <div className="space-y-3">
        <BannerAnuncio anuncio={vistaPrevia} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="text-xs font-bold text-slate-600">Título</span>
            <input value={f.titulo} onChange={set('titulo')} maxLength={120} className={`${claseInput} mt-1`} placeholder="Ej. Mantenimiento programado el domingo" />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Tipo</span>
            <select value={f.tipo} onChange={set('tipo')} className={`${claseInput} mt-1`}>
              {TIPOS_ANUNCIO.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-bold text-slate-600">Mensaje (opcional)</span>
          <textarea value={f.mensaje} onChange={set('mensaje')} rows={3} maxLength={600} className={`${claseInput} mt-1 resize-y`} />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Enlace (opcional)</span>
            <input value={f.enlace_url} onChange={set('enlace_url')} placeholder="https://…" className={`${claseInput} mt-1`} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Texto del enlace</span>
            <input value={f.enlace_texto} onChange={set('enlace_texto')} placeholder="Ver detalles" maxLength={40} className={`${claseInput} mt-1`} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Publicar desde</span>
            <input type="datetime-local" value={f.inicia} onChange={set('inicia')} className={`${claseInput} mt-1`} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Hasta (vacío = sin fin)</span>
            <input type="datetime-local" value={f.termina} onChange={set('termina')} className={`${claseInput} mt-1`} />
          </label>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
          <input type="checkbox" checked={f.activo} onChange={set('activo')} className="accent-orange-500" /> Activo
        </label>
        <AvisoError texto={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={claseBotonSecundario} onClick={onClose} disabled={guardando}>
          Cancelar
        </button>
        <button type="button" className={claseBotonPrimario} onClick={guardar} disabled={guardando}>
          {guardando ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />} {anuncio ? 'Guardar' : 'Publicar anuncio'}
        </button>
      </div>
    </ModalSoporte>
  );
}

function NotificacionMasiva({ onToast }) {
  const [clubes, setClubes] = useState([]);
  const [titulo, setTitulo] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [destino, setDestino] = useState('todos'); // todos | prueba | activa | seleccion
  const [seleccion, setSeleccion] = useState([]);
  const [enviando, setEnviando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    listarSaludClubes(30).then(({ data }) => setClubes((data || []).filter((c) => !c.eliminado)));
  }, []);

  const alcance = useMemo(() => {
    if (destino === 'seleccion') return seleccion.length;
    if (destino === 'todos') return clubes.length;
    return clubes.filter((c) => (c.estado_suscripcion || 'activa') === destino).length;
  }, [destino, seleccion, clubes]);

  async function enviar() {
    setError('');
    setEnviando(true);
    const { data, error: err } = await notificarClubes({
      titulo: titulo.trim(),
      mensaje: mensaje.trim(),
      clubIds: destino === 'seleccion' ? seleccion : null,
      estadoSuscripcion: destino === 'prueba' || destino === 'activa' ? destino : null,
    });
    setEnviando(false);
    setConfirmar(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudo enviar la notificación.'));
    onToast?.({ titulo: 'Notificación enviada', detalle: `Llegó a ${data ?? 0} ${data === 1 ? 'club' : 'clubes'}.` });
    setTitulo('');
    setMensaje('');
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <p className="flex items-center gap-1.5 text-sm font-black text-slate-900">
        <Send size={15} className="text-orange-500" /> Notificación masiva a administradores
      </p>
      <p className="text-xs text-slate-500">Llega a la campana de alertas del panel de cada club elegido.</p>
      <input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={300} placeholder="Título (ej. Nueva función: Calendario de Soporte)" className={claseInput} />
      <textarea value={mensaje} onChange={(e) => setMensaje(e.target.value)} rows={3} maxLength={1000} placeholder="Mensaje (opcional)" className={`${claseInput} resize-y`} />
      <div className="flex flex-wrap items-center gap-2">
        <select value={destino} onChange={(e) => setDestino(e.target.value)} className={`${claseInput} w-auto`}>
          <option value="todos">Todos los clubes</option>
          <option value="prueba">Solo en periodo de prueba</option>
          <option value="activa">Solo con plan activo</option>
          <option value="seleccion">Elegir clubes…</option>
        </select>
        <span className="text-xs font-semibold text-slate-500">
          Alcance: {alcance} {alcance === 1 ? 'club' : 'clubes'}
        </span>
      </div>
      {destino === 'seleccion' && (
        <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 p-2">
          {clubes.map((c) => (
            <label key={c.club_id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
              <input
                type="checkbox"
                className="accent-orange-500"
                checked={seleccion.includes(c.club_id)}
                onChange={(e) => setSeleccion((prev) => (e.target.checked ? [...prev, c.club_id] : prev.filter((x) => x !== c.club_id)))}
              />
              {c.nombre} <span className="text-slate-400">· ID {c.club_id}</span>
            </label>
          ))}
        </div>
      )}
      <AvisoError texto={error} />
      {!confirmar ? (
        <button type="button" className={claseBotonPrimario} disabled={titulo.trim().length < 3 || alcance === 0} onClick={() => setConfirmar(true)}>
          <Send size={14} /> Enviar notificación
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-400/40 bg-orange-400/5 p-3 text-xs text-slate-700">
          ¿Enviar a {alcance} {alcance === 1 ? 'club' : 'clubes'}? No se puede deshacer.
          <button type="button" className={claseBotonSecundario} onClick={() => setConfirmar(false)} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" className={claseBotonPrimario} onClick={enviar} disabled={enviando}>
            {enviando ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Sí, enviar
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminAnuncios({ onToast }) {
  const [anuncios, setAnuncios] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setCargando(true);
    const { data, error: err } = await listarAnunciosAdmin();
    setCargando(false);
    if (err) return setError(mensajeErrorAdmin(err, 'No se pudieron cargar los anuncios.'));
    setError('');
    setAnuncios(data);
  }, []);

  useEffect(() => {
    cargar();
    return suscribirTablas(['anuncios_plataforma'], () => cargar({ silencioso: true }));
  }, [cargar]);

  async function alternar(a) {
    setAnuncios((prev) => prev.map((x) => (x.id === a.id ? { ...x, activo: !a.activo } : x)));
    const { error: err } = await guardarAnuncio({ ...a, activo: !a.activo });
    if (err) {
      onToast?.({ titulo: 'No se pudo cambiar el anuncio', detalle: mensajeErrorAdmin(err), tono: 'error' });
      cargar({ silencioso: true });
    }
  }

  async function borrar(a) {
    const { error: err } = await eliminarAnuncio(a.id);
    if (err) return onToast?.({ titulo: 'No se pudo eliminar', detalle: mensajeErrorAdmin(err), tono: 'error' });
    setAnuncios((prev) => prev.filter((x) => x.id !== a.id));
  }

  return (
    <div className="space-y-4">
      <EncabezadoModulo
        icono={Megaphone}
        titulo="Anuncios y notificaciones"
        descripcion="Avisos de novedades o mantenimiento en el panel de los clubes."
        acciones={
          <button type="button" className={claseBotonPrimario} onClick={() => setModal({})}>
            <Plus size={14} /> Nuevo anuncio
          </button>
        }
      />
      <AvisoError texto={error} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="space-y-2 xl:col-span-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Banners</p>
          {cargando && anuncios.length === 0 ? (
            <Cargando />
          ) : anuncios.length === 0 ? (
            <Vacio texto="Aún no hay anuncios." />
          ) : (
            anuncios.map((a) => {
              const e = estadoAnuncio(a);
              return (
                <div key={a.id} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
                  <BannerAnuncio anuncio={a} />
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <Pastilla clase={e.clase}>{e.label}</Pastilla>
                    <span>
                      {formatoFechaHoraCorta(a.inicia_en)} → {a.termina_en ? formatoFechaHoraCorta(a.termina_en) : 'sin fin'}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={Boolean(a.activo)}
                        aria-label={a.activo ? 'Desactivar anuncio' : 'Activar anuncio'}
                        onClick={() => alternar(a)}
                        className={`relative h-5 w-9 rounded-full transition ${a.activo ? 'bg-emerald-500' : 'bg-slate-300'}`}
                      >
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${a.activo ? 'left-[18px]' : 'left-0.5'}`} />
                      </button>
                      <button type="button" onClick={() => setModal({ anuncio: a })} className="rounded-md px-2 py-1 font-bold text-orange-500 hover:bg-orange-400/10">
                        Editar
                      </button>
                      <button type="button" onClick={() => borrar(a)} aria-label="Eliminar anuncio" className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/10 hover:text-rose-500">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="xl:col-span-2">
          <NotificacionMasiva onToast={onToast} />
        </div>
      </div>
      {modal && (
        <ModalAnuncio
          anuncio={modal.anuncio || null}
          onClose={() => setModal(null)}
          onGuardado={() => {
            onToast?.({ titulo: modal.anuncio ? 'Anuncio actualizado' : 'Anuncio publicado' });
            cargar({ silencioso: true });
          }}
        />
      )}
    </div>
  );
}
