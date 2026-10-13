// =============================================================================
// SuperAdmin — Torre de control de QLUBOS (/admin/<seccion>)
// Contenedor de navegación de las secciones de plataforma. Cada sección es un
// módulo independiente que lee/escribe solo a través de funciones que exigen
// staff (fn_soporte_es_staff) — este archivo no consulta Supabase.
// =============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LifeBuoy, Users, TicketPercent, Building2, ScrollText, Megaphone, CreditCard } from 'lucide-react';
import AdminSoporte from '../soporte/AdminSoporte';
import AdminLeads from './AdminLeads';
import AdminCodigos from './AdminCodigos';
import AdminClubes from './AdminClubes';
import AdminLogs from './AdminLogs';
import AdminAnuncios from './AdminAnuncios';
import AdminPagos from './AdminPagos';

export const SECCIONES_ADMIN = [
  { id: 'soporte', label: 'Soporte', icon: LifeBuoy },
  { id: 'leads', label: 'CRM Leads', icon: Users },
  { id: 'codigos', label: 'Códigos', icon: TicketPercent },
  { id: 'clubes', label: 'Clubes', icon: Building2 },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'anuncios', label: 'Anuncios', icon: Megaphone },
  { id: 'pagos', label: 'Pagos', icon: CreditCard },
];

const SECCION_DEFECTO = 'soporte';

/** '/admin/leads' → 'leads'. Cualquier ruta desconocida cae en Soporte. */
export function seccionDesdeRuta(pathname) {
  const m = String(pathname || '').match(/^\/admin\/([^/?#]+)/);
  const id = m ? m[1].toLowerCase() : '';
  return SECCIONES_ADMIN.some((s) => s.id === id) ? id : SECCION_DEFECTO;
}

export function rutaDeSeccion(id) {
  return `/admin/${id}`;
}

export default function PanelAdminQlubos({ onToast }) {
  const [seccion, setSeccion] = useState(() => (typeof window === 'undefined' ? SECCION_DEFECTO : seccionDesdeRuta(window.location.pathname)));

  // Normaliza la URL al montar (p. ej. /admin → /admin/soporte) y sigue el
  // botón atrás/adelante del navegador.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const ruta = rutaDeSeccion(seccionDesdeRuta(window.location.pathname));
    if (window.location.pathname.replace(/\/+$/, '') !== ruta) window.history.replaceState(window.history.state, '', ruta);
    const alNavegar = () => setSeccion(seccionDesdeRuta(window.location.pathname));
    window.addEventListener('popstate', alNavegar);
    return () => window.removeEventListener('popstate', alNavegar);
  }, []);

  // En móvil la barra de secciones se desliza: mantiene visible la activa.
  const refNav = useRef(null);
  useEffect(() => {
    const boton = refNav.current?.querySelector('[aria-selected="true"]');
    if (boton && typeof boton.scrollIntoView === 'function') boton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [seccion]);

  const irA = useCallback((id) => {
    setSeccion(id);
    if (typeof window !== 'undefined') {
      const ruta = rutaDeSeccion(id);
      if (window.location.pathname !== ruta) window.history.pushState(window.history.state, '', ruta);
      window.scrollTo({ top: 0 });
    }
  }, []);

  return (
    <div className="space-y-5">
      <nav ref={refNav} aria-label="Secciones de la plataforma" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" className="inline-flex min-w-full gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm sm:min-w-0">
          {SECCIONES_ADMIN.map((s) => {
            const Icono = s.icon;
            const activa = seccion === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={activa}
                onClick={() => irA(s.id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-bold transition sm:text-sm ${
                  activa ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icono size={15} className={activa ? 'text-orange-400' : ''} />
                {s.label}
              </button>
            );
          })}
        </div>
      </nav>

      <section role="tabpanel" aria-label={SECCIONES_ADMIN.find((s) => s.id === seccion)?.label}>
        {seccion === 'soporte' && <AdminSoporte onToast={onToast} />}
        {seccion === 'leads' && <AdminLeads onToast={onToast} />}
        {seccion === 'codigos' && <AdminCodigos onToast={onToast} />}
        {seccion === 'clubes' && <AdminClubes />}
        {seccion === 'logs' && <AdminLogs />}
        {seccion === 'anuncios' && <AdminAnuncios onToast={onToast} />}
        {seccion === 'pagos' && <AdminPagos />}
      </section>
    </div>
  );
}
