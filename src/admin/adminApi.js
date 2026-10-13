// =============================================================================
// SuperAdmin QLUBOS — acceso a datos (migracion_v97 + tablas existentes)
// =============================================================================
// Lecturas cross-club por funciones SECURITY DEFINER que exigen ser staff
// (fn_soporte_es_staff). Ninguna tabla existente se modifica en estructura.
import { supabase } from '../supabaseClient';

export function esErrorEsquemaAdmin(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '');
  return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(code) || /Could not find the function|does not exist|schema cache/i.test(msg);
}

export function mensajeErrorAdmin(error, respaldo = 'Ocurrió un error inesperado.') {
  if (!error) return respaldo;
  if (esErrorEsquemaAdmin(error)) return 'Falta instalar el panel en la base de datos: corre migracion_v97_superadmin_torre_control.sql en Supabase.';
  return error.message || respaldo;
}

async function rpc(nombre, params) {
  const { data, error } = await supabase.rpc(nombre, params);
  return { data, error };
}

// ------------------------------- Leads -------------------------------------
export async function listarLeads() {
  const { data, error } = await rpc('fn_admin_leads');
  return { data: data || [], error };
}

export async function cambiarEstadoLead(leadId, estado, notas = null) {
  return rpc('fn_admin_lead_estado', { p_lead_id: leadId, p_estado: estado, p_notas: notas });
}

// Registro manual (visita presencial / venta directa) — migracion_v98.
// Inserta en leads_landing + estado inicial en crm_leads_seguimiento y
// devuelve el lead con la misma forma que fn_admin_leads().
export const ORIGENES_LEAD_MANUAL = ['Visita Presencial', 'Venta Directa'];

export async function crearLeadManual({ nombre, club, whatsapp, correo, canchas, ciudad, estado, notas, origen }) {
  const { data, error } = await rpc('fn_admin_crear_lead', {
    p_nombre: nombre,
    p_club: club,
    p_whatsapp: whatsapp,
    p_correo: correo,
    p_canchas: canchas || null,
    p_ciudad: ciudad || null,
    p_estado: estado || 'nuevo',
    p_notas: notas || null,
    p_origen: origen,
  });
  if (error && esErrorEsquemaAdmin(error)) {
    return { data: null, error: { message: 'Falta instalar el registro manual de leads: corre migracion_v98_crm_lead_manual.sql en Supabase.' } };
  }
  return { data, error };
}

export async function convertirLead(leadId, diasPrueba) {
  try {
    const { data, error } = await supabase.functions.invoke('admin-convertir-lead', {
      body: { lead_id: leadId, dias_prueba: Number(diasPrueba) || 14 },
    });
    if (error) {
      let detalle = error.message;
      try {
        const cuerpo = await error.context?.json?.();
        if (cuerpo?.error) detalle = cuerpo.error;
      } catch (_e) {
        /* sin cuerpo */
      }
      return { data: null, error: new Error(detalle || 'No se pudo convertir el lead.') };
    }
    if (!data?.ok) return { data: null, error: new Error(data?.error || 'No se pudo convertir el lead.') };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error('No se pudo convertir el lead.') };
  }
}

// ---------------------- Códigos promocionales (tabla existente) ------------
export async function listarCodigos() {
  const { data, error } = await supabase.from('codigos_promocionales').select('*').order('created_at', { ascending: false });
  return { data: data || [], error };
}

export async function crearCodigo({ codigo, diasPrueba, usosMaximos }) {
  const { data, error } = await supabase
    .from('codigos_promocionales')
    .insert({
      codigo: String(codigo).trim().toUpperCase(),
      dias_prueba: Number(diasPrueba),
      usos_maximos: usosMaximos == null || usosMaximos === '' ? null : Number(usosMaximos),
      activo: true,
    })
    .select()
    .single();
  return { data, error };
}

export async function actualizarCodigo(id, cambios) {
  const { data, error } = await supabase.from('codigos_promocionales').update(cambios).eq('id', id).select().single();
  return { data, error };
}

export async function eliminarCodigo(id) {
  const { error } = await supabase.from('codigos_promocionales').delete().eq('id', id).eq('usos_actuales', 0);
  return { error };
}

// ------------------------------ Clubes -------------------------------------
export async function listarSaludClubes(dias = 30) {
  const { data, error } = await rpc('fn_admin_salud_clubes', { p_dias: Number(dias) || 30 });
  return { data: data || [], error };
}

// ------------------------------ Logs ---------------------------------------
export async function listarLogGlobal({ desde = null, hasta = null, clubId = null, tipo = null, limite = 500 } = {}) {
  const { data, error } = await rpc('fn_admin_log_actividad', {
    p_desde: desde,
    p_hasta: hasta,
    p_club_id: clubId != null && clubId !== '' ? Number(clubId) : null,
    p_tipo: tipo || null,
    p_limite: limite,
  });
  return { data: data || [], error };
}

export async function resumenNotificaciones(dias = 7) {
  const { data, error } = await rpc('fn_admin_notificaciones_resumen', { p_dias: Number(dias) || 7 });
  return { data: data || {}, error };
}

// ---------------------------- Anuncios -------------------------------------
export async function listarAnunciosAdmin() {
  const { data, error } = await supabase.from('anuncios_plataforma').select('*').order('creado_en', { ascending: false }).limit(200);
  return { data: data || [], error };
}

export async function guardarAnuncio(anuncio) {
  const fila = {
    titulo: anuncio.titulo,
    mensaje: anuncio.mensaje || null,
    tipo: anuncio.tipo,
    enlace_url: anuncio.enlace_url || null,
    enlace_texto: anuncio.enlace_texto || null,
    activo: anuncio.activo !== false,
    inicia_en: anuncio.inicia_en || new Date().toISOString(),
    termina_en: anuncio.termina_en || null,
  };
  if (anuncio.id) {
    const { data, error } = await supabase.from('anuncios_plataforma').update(fila).eq('id', anuncio.id).select().single();
    return { data, error };
  }
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('anuncios_plataforma')
    .insert({ ...fila, creado_por: userData?.user?.id || null })
    .select()
    .single();
  return { data, error };
}

export async function eliminarAnuncio(id) {
  const { error } = await supabase.from('anuncios_plataforma').delete().eq('id', id);
  return { error };
}

export async function notificarClubes({ titulo, mensaje, clubIds = null, estadoSuscripcion = null }) {
  return rpc('fn_admin_notificar_clubes', {
    p_titulo: titulo,
    p_mensaje: mensaje || null,
    p_club_ids: clubIds && clubIds.length ? clubIds.map(Number) : null,
    p_estado_suscripcion: estadoSuscripcion || null,
  });
}

// Anuncios vigentes para el panel de un club (RLS: solo vigentes).
export async function listarAnunciosVigentes() {
  const { data, error } = await supabase.from('anuncios_plataforma').select('*').order('inicia_en', { ascending: false }).limit(10);
  // Doble filtro (además de RLS) por si el reloj del servidor y el del
  // navegador difieren unos segundos en los límites programados.
  const ahora = Date.now();
  const vigentes = (data || []).filter(
    (a) =>
      a.activo !== false &&
      (!a.inicia_en || new Date(a.inicia_en).getTime() <= ahora) &&
      (!a.termina_en || new Date(a.termina_en).getTime() > ahora)
  );
  return { data: vigentes.slice(0, 5), error };
}

// ------------------------------ Pagos --------------------------------------
export async function listarPagos({ desde = null, hasta = null } = {}) {
  const { data, error } = await rpc('fn_admin_pagos', { p_desde: desde, p_hasta: hasta });
  return { data: data || [], error };
}

// ------------------------------ Realtime -----------------------------------
export function suscribirTablas(tablas, alCambiar) {
  const canal = supabase.channel(`admin-${tablas.join('-')}-${Math.random().toString(36).slice(2, 8)}`);
  tablas.forEach((t) => canal.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => alCambiar(t)));
  canal.subscribe();
  return () => {
    try {
      supabase.removeChannel(canal);
    } catch (_e) {
      /* ya cerrado */
    }
  };
}