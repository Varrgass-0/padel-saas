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
    return 'Falta instalar una parte del módulo de Soporte en la base de datos. Corre en Supabase las migraciones v93, v94 y v95 de Soporte.';
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

// Verificación TEMPRANA de staff de la plataforma (se usa en el login, antes
// de resolver cualquier club). Consulta directa a `plataforma_staff` por el
// `user_id` de la sesión y `activo = true` (la política RLS de v94 solo deja
// leer la fila propia). Si esa lectura no está permitida todavía (v94 sin
// correr), se usa la función `fn_soporte_es_staff` de v93 como respaldo.
// Devuelve:
//   { ok: true, staff: { user_id, rol, nombre } }  → es SuperAdmin/staff
//   { ok: true, staff: null }                       → usuario normal de club
//   { ok: false, error }                            → no se pudo verificar
//     (red, reloj, etc.): quien llame NO debe asumir "usuario de club".
export async function obtenerStaffPlataforma(userId) {
  if (!userId) return { ok: true, staff: null };
  const directa = await supabase
    .from('plataforma_staff')
    .select('user_id, rol, nombre, activo')
    .eq('user_id', userId)
    .eq('activo', true)
    .maybeSingle();
  if (!directa.error) {
    const fila = directa.data;
    const esStaff = Boolean(fila) && (fila.rol === 'superadmin' || fila.rol === 'staff_qlubos');
    return { ok: true, staff: esStaff ? { user_id: fila.user_id, rol: fila.rol, nombre: fila.nombre || '' } : null };
  }
  const respaldo = await supabase.rpc('fn_soporte_es_staff');
  if (!respaldo.error) {
    return { ok: true, staff: respaldo.data === true ? { user_id: userId, rol: 'superadmin', nombre: '' } : null };
  }
  // Ni la tabla ni la función existen: el módulo de Soporte no está
  // instalado, así que no puede haber staff registrado.
  if (esErrorEsquemaSoporte(directa.error) && esErrorEsquemaSoporte(respaldo.error)) return { ok: true, staff: null };
  return { ok: false, error: respaldo.error || directa.error };
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

export async function registrarAtencionAdmin({ clubId, ticketId = null, canal, concepto, minutos, estado, inicio = null, meetUrl = null, notas = '' }) {
  const params = {
    p_club_id: Number(clubId),
    p_ticket_id: ticketId,
    p_canal: canal,
    p_concepto: concepto || null,
    p_minutos: Math.round(Number(minutos) || 0),
    p_estado: estado,
    p_inicio: inicio,
    p_meet_url: meetUrl || null,
  };
  // `p_notas` solo viaja si hay nota (así sigue funcionando sin la v95).
  if (notas && notas.trim()) params.p_notas = notas.trim();
  const { data, error } = await supabase.rpc('fn_soporte_admin_registrar_atencion', params);
  return { data: Array.isArray(data) ? data[0] : data, error };
}

// Abono (+) o corrección (−) administrativa de minutos (v95).
export async function ajustarBolsaAdmin({ clubId, minutos, motivo, notas = '' }) {
  const { data, error } = await supabase.rpc('fn_soporte_admin_ajustar_bolsa', {
    p_club_id: Number(clubId),
    p_minutos: Math.round(Number(minutos) || 0),
    p_motivo: motivo,
    p_notas: notas && notas.trim() ? notas.trim() : null,
  });
  return { data: Array.isArray(data) ? data[0] : data, error };
}

// Agenda global (staff): citas de todos los clubes en un rango de fechas.
export async function listarAgendaAdmin({ desde, hasta, limite = 500 }) {
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*')
    .gte('inicio', desde)
    .lte('inicio', hasta)
    .order('inicio', { ascending: true })
    .limit(limite);
  return { data: data || [], error };
}

// Ajustes de bolsa del club (el club también los ve, con su motivo).
export async function listarAjustes(clubId, limite = 50) {
  const { data, error } = await supabase
    .from('soporte_ajustes')
    .select('*')
    .eq('club_id', Number(clubId))
    .order('creado_en', { ascending: false })
    .limit(limite);
  return { data: data || [], error };
}

// Notas / diagnóstico interno del staff sobre el club (el club NO las ve).
export async function listarNotasInternas(clubId, limite = 50) {
  const { data, error } = await supabase
    .from('soporte_notas_internas')
    .select('*')
    .eq('club_id', Number(clubId))
    .order('creado_en', { ascending: false })
    .limit(limite);
  return { data: data || [], error };
}

// ---------------------------- Realtime --------------------------------------
// Escucha cambios de bolsa/tickets/compras. `clubId` null = todos (SuperAdmin;
// RLS sigue filtrando lo que cada quien puede ver).
export function suscribirCambiosSoporte(clubId, alCambiar) {
  const filtro = clubId != null ? { filter: `club_id=eq.${clubId}` } : {};
  const canal = supabase.channel(`soporte-${clubId ?? 'global'}-${Math.random().toString(36).slice(2, 8)}`);
  const tablas = ['soporte_bolsa', 'soporte_tickets', 'soporte_compras_extra', 'soporte_ajustes'];
  if (clubId == null) tablas.push('soporte_notas_internas');
  tablas.forEach((tabla) => {
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
