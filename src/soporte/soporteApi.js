// =============================================================================
// Soporte & Acompañamiento — acceso a Supabase (RPC, tablas, Realtime, Edge)
// =============================================================================
import { supabase } from '../supabaseClient';

// ¿El error viene de que la migración v93 todavía no se corrió?
export function esErrorEsquemaSoporte(error) {
  const code = error?.code || '';
  const msg = String(error?.message || '');
  return (
    ['42P01', '42883', 'PGRST202', 'PGRST205', 'PGRST204'].includes(code) ||
    /does not exist|Could not find the function|schema cache/i.test(msg)
  );
}

export function mensajeError(error, respaldo = 'Ocurrió un error inesperado.') {
  if (!error) return respaldo;
  if (esErrorEsquemaSoporte(error)) {
    return 'El módulo de Soporte aún no está instalado en la base de datos. Corre migracion_v93_soporte_acompanamiento.sql en Supabase.';
  }
  return error.message || respaldo;
}

export async function consultarEsStaffQlubos() {
  try {
    const { data, error } = await supabase.rpc('fn_soporte_es_staff');
    if (error) return false;
    return data === true;
  } catch (_e) {
    return false;
  }
}

export async function obtenerBolsa(clubId) {
  const { data, error } = await supabase.rpc('fn_soporte_bolsa_actual', { p_club_id: Number(clubId) });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

export async function listarTickets(clubId, limite = 200) {
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*')
    .eq('club_id', Number(clubId))
    .order('inicio', { ascending: false, nullsFirst: false })
    .limit(limite);
  return { data: data || [], error };
}

export async function listarComprasExtra(clubId, limite = 50) {
  const { data, error } = await supabase
    .from('soporte_compras_extra')
    .select('*')
    .eq('club_id', Number(clubId))
    .order('creado_en', { ascending: false })
    .limit(limite);
  return { data: data || [], error };
}

export async function registrarConexion(ticketId) {
  const { data, error } = await supabase.rpc('fn_soporte_registrar_conexion', { p_ticket_id: ticketId });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

// Inicia el pago en Stripe Checkout (Edge Function). Devuelve { url }.
export async function iniciarCompraHorasExtra({ clubId, horas }) {
  try {
    const { data, error } = await supabase.functions.invoke('soporte-stripe-checkout', {
      body: { club_id: Number(clubId), horas: Number(horas) },
    });
    if (error) {
      let detalle = error.message;
      try {
        const cuerpo = await error.context?.json?.();
        if (cuerpo?.error) detalle = cuerpo.error;
      } catch (_e) {
        /* sin cuerpo JSON */
      }
      return { data: null, error: new Error(detalle || 'No se pudo iniciar el pago.') };
    }
    if (!data?.url) return { data: null, error: new Error(data?.error || 'Stripe no devolvió la liga de pago.') };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error('No se pudo iniciar el pago.') };
  }
}

// ---------------------------- SuperAdmin ------------------------------------
export async function listarClubesAdmin(busqueda = '') {
  const { data, error } = await supabase.rpc('fn_soporte_admin_clubes', { p_busqueda: busqueda || null });
  return { data: data || [], error };
}

export async function registrarAtencionAdmin({ clubId, ticketId = null, canal, concepto, minutos, estado, inicio = null, meetUrl = null }) {
  const { data, error } = await supabase.rpc('fn_soporte_admin_registrar_atencion', {
    p_club_id: Number(clubId),
    p_ticket_id: ticketId,
    p_canal: canal,
    p_concepto: concepto || null,
    p_minutos: Math.round(Number(minutos) || 0),
    p_estado: estado,
    p_inicio: inicio,
    p_meet_url: meetUrl || null,
  });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

// ---------------------------- Realtime --------------------------------------
// Escucha cambios de bolsa/tickets/compras. `clubId` null = todos (SuperAdmin;
// RLS sigue filtrando lo que cada quien puede ver).
export function suscribirCambiosSoporte(clubId, alCambiar) {
  const filtro = clubId != null ? { filter: `club_id=eq.${clubId}` } : {};
  const canal = supabase.channel(`soporte-${clubId ?? 'global'}-${Math.random().toString(36).slice(2, 8)}`);
  ['soporte_bolsa', 'soporte_tickets', 'soporte_compras_extra'].forEach((tabla) => {
    canal.on('postgres_changes', { event: '*', schema: 'public', table: tabla, ...filtro }, () => alCambiar(tabla));
  });
  canal.subscribe();
  return () => {
    try {
      supabase.removeChannel(canal);
    } catch (_e) {
      /* canal ya cerrado */
    }
  };
}

export async function obtenerUsuarioActual() {
  try {
    const { data } = await supabase.auth.getUser();
    const u = data?.user;
    if (!u) return null;
    return { id: u.id, email: u.email || '', nombre: (u.user_metadata?.full_name || '').trim() };
  } catch (_e) {
    return null;
  }
}
