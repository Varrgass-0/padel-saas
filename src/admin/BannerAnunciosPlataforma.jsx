// =============================================================================
// Banners de anuncios de QLUBOS en el panel de los clubes
// Lee anuncios_plataforma (RLS: solo los vigentes). Si la tabla aún no
// existe (migración v97 sin correr) no muestra nada y no rompe el panel.
// El club puede ocultar cada anuncio (se recuerda en este navegador).
// =============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Megaphone, Wrench, AlertTriangle, Gift, X, ExternalLink } from 'lucide-react';
import { listarAnunciosVigentes, suscribirTablas } from './adminApi';

const ESTILO_TIPO = {
  novedad: { icono: Megaphone, clase: 'border-sky-400/40 bg-sky-500/10', icon: 'text-sky-500' },
  mantenimiento: { icono: Wrench, clase: 'border-amber-400/50 bg-amber-400/10', icon: 'text-amber-500' },
  alerta: { icono: AlertTriangle, clase: 'border-rose-500/40 bg-rose-500/10', icon: 'text-rose-500' },
  promocion: { icono: Gift, clase: 'border-orange-400/50 bg-orange-400/10', icon: 'text-orange-500' },
};

const LS_OCULTOS = 'qlubos_anuncios_ocultos_v1';

function leerOcultos() {
  try {
    const v = JSON.parse(window.localStorage.getItem(LS_OCULTOS) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_e) {
    return [];
  }
}

function guardarOcultos(ids) {
  try {
    window.localStorage.setItem(LS_OCULTOS, JSON.stringify(ids.slice(-100)));
  } catch (_e) {
    /* sin almacenamiento: se oculta solo en esta sesión */
  }
}

export function BannerAnuncio({ anuncio, onCerrar }) {
  const estilo = ESTILO_TIPO[anuncio.tipo] || ESTILO_TIPO.novedad;
  const Icono = estilo.icono;
  const enlace = typeof anuncio.enlace_url === 'string' && /^https:\/\//i.test(anuncio.enlace_url) ? anuncio.enlace_url : null;
  return (
    <div role="status" className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${estilo.clase}`}>
      <Icono size={18} className={`mt-0.5 shrink-0 ${estilo.icon}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-black text-slate-900">{anuncio.titulo}</p>
        {anuncio.mensaje && <p className="mt-0.5 whitespace-pre-line text-xs text-slate-600">{anuncio.mensaje}</p>}
        {enlace && (
          <a href={enlace} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-orange-500 hover:underline">
            {anuncio.enlace_texto || 'Ver más'} <ExternalLink size={11} />
          </a>
        )}
      </div>
      {onCerrar && (
        <button type="button" onClick={onCerrar} aria-label="Ocultar aviso" className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/60 hover:text-slate-900">
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export default function BannerAnunciosPlataforma() {
  const [anuncios, setAnuncios] = useState([]);
  const [ocultos, setOcultos] = useState(() => leerOcultos());

  const cargar = useCallback(async () => {
    const { data, error } = await listarAnunciosVigentes();
    if (!error) setAnuncios(data);
  }, []);

  useEffect(() => {
    cargar();
    const quitar = suscribirTablas(['anuncios_plataforma'], () => cargar());
    const intervalo = setInterval(cargar, 10 * 60_000); // respeta inicios/fines programados
    return () => {
      quitar();
      clearInterval(intervalo);
    };
  }, [cargar]);

  const visibles = anuncios.filter((a) => !ocultos.includes(a.id)).slice(0, 3);
  if (visibles.length === 0) return null;
  return (
    <div className="space-y-2">
      {visibles.map((a) => (
        <BannerAnuncio
          key={a.id}
          anuncio={a}
          onCerrar={() => {
            const nuevos = [...ocultos, a.id];
            setOcultos(nuevos);
            guardarOcultos(nuevos);
          }}
        />
      ))}
    </div>
  );
}
