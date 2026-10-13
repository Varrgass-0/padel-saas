// Edge Function: admin-convertir-lead
// SuperAdmin → "Convertir a Club Activo".
// Toma un lead de public.leads_landing y:
//   1) Crea (o reutiliza) la cuenta del dueño en Supabase Auth enviándole una
//      INVITACIÓN por correo (inviteUserByEmail) para que defina su contraseña.
//   2) Crea su club en public.configuracion_club con las MISMAS columnas que
//      usa el registro normal de la app (nombre, slug, propietario_user_id,
//      onboarding_completed=false) + periodo de prueba (estado_suscripcion =
//      'prueba', fecha_fin_prueba, codigo_promo_usado) y el plan de canchas.
//      Al entrar, el dueño ve el Onboarding normal de QLUBOS.
//   3) Marca el lead como 'en_prueba' en crm_leads_seguimiento (tabla nueva).
// Si el correo ya tiene un club, NO crea otro: solo enlaza el lead.
//
// Solo staff de QLUBOS (plataforma_staff). Usa la service_role SOLO aquí.
// Secrets: APP_URL (a dónde lleva el enlace de la invitación).
// Desplegar CON verificación de JWT: supabase functions deploy admin-convertir-lead
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders, respuestaJson } from '../_shared/cors.ts';

const DIAS_PRUEBA_DEFAULT = 14;

function planDesdeCanchas(texto: string | null): string | null {
  const t = String(texto || '').toLowerCase();
  if (!t) return null;
  if (/m[aá]s de 12|varias|sedes|\+ ?12/.test(t)) return '8-12';
  const nums = (t.match(/\d+/g) || []).map(Number);
  const max = nums.length ? Math.max(...nums) : null;
  if (max == null) return null;
  if (max <= 3) return '1-3';
  if (max <= 7) return '4-7';
  return '8-12';
}

function slugificar(texto: string): string {
  return (
    String(texto || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'club'
  );
}

function columnaFaltante(error: any): string | null {
  const msg = String(error?.message || '');
  const m = msg.match(/Could not find the '([^']+)' column/i) || msg.match(/column "?([a-z_]+)"? .*does not exist/i);
  return m ? m[1] : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return respuestaJson({ error: 'Método no permitido' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const supabaseUsuario = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: userData } = await supabaseUsuario.auth.getUser();
    const usuario = userData?.user;
    if (!usuario) return respuestaJson({ error: 'Sesión inválida.' }, 401);

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: staff } = await admin.from('plataforma_staff').select('user_id').eq('user_id', usuario.id).eq('activo', true).maybeSingle();
    if (!staff) return respuestaJson({ error: 'Acceso exclusivo para SuperAdmin de QLUBOS.' }, 403);

    const cuerpo = await req.json().catch(() => ({}));
    const leadId = String(cuerpo?.lead_id || '');
    const diasPrueba = Math.min(Math.max(Number(cuerpo?.dias_prueba) || DIAS_PRUEBA_DEFAULT, 1), 90);
    if (!leadId) return respuestaJson({ error: 'Falta lead_id.' }, 400);

    const { data: lead, error: errLead } = await admin.from('leads_landing').select('*').eq('id', leadId).maybeSingle();
    if (errLead) throw errLead;
    if (!lead) return respuestaJson({ error: 'Lead no encontrado.' }, 404);
    const correo = String(lead.correo || '').trim().toLowerCase();
    if (!correo.includes('@')) return respuestaJson({ error: 'El lead no tiene un correo válido.' }, 400);

    // 1) Cuenta del dueño: invitar o reutilizar.
    let propietarioId: string | null = null;
    let invitado = false;
    const appUrl = (Deno.env.get('APP_URL') || '').replace(/\/+$/, '') || undefined;
    const invitacion = await admin.auth.admin.inviteUserByEmail(correo, {
      data: { full_name: lead.nombre || '' },
      redirectTo: appUrl,
    });
    if (invitacion.error) {
      const { data: existente, error: errBusca } = await admin.rpc('fn_admin_usuario_por_correo', { p_correo: correo });
      if (errBusca || !existente) throw invitacion.error;
      propietarioId = String(existente);
    } else {
      propietarioId = invitacion.data.user?.id ?? null;
      invitado = true;
    }
    if (!propietarioId) throw new Error('No se pudo crear la cuenta del dueño.');

    // 2) ¿Ya tiene club? Entonces solo se enlaza (nunca se duplica).
    const { data: clubExistente } = await admin.from('configuracion_club').select('*').eq('propietario_user_id', propietarioId).maybeSingle();
    let club = clubExistente;
    let creado = false;
    if (!club) {
      const fechaFinPrueba = new Date(Date.now() + diasPrueba * 86400000).toISOString();
      const base: Record<string, unknown> = {
        nombre: String(lead.club || 'Mi Club').trim().slice(0, 120),
        propietario_user_id: propietarioId,
        onboarding_completed: false,
        estado_suscripcion: 'prueba',
        fecha_fin_prueba: fechaFinPrueba,
        codigo_promo_usado: 'CRM-LEAD',
        plan_canchas: planDesdeCanchas(lead.canchas),
        telefono_contacto: String(lead.whatsapp || '').replace(/\D/g, '') || null,
      };
      const opcionales = ['onboarding_completed', 'estado_suscripcion', 'fecha_fin_prueba', 'codigo_promo_usado', 'plan_canchas', 'telefono_contacto'];
      const slugBase = slugificar(String(base.nombre));
      for (let intento = 0; intento < 8 && !club; intento++) {
        const slug = intento === 0 ? slugBase : `${slugBase}-${Math.random().toString(36).slice(2, 6)}`;
        const { data, error } = await admin.from('configuracion_club').insert({ ...base, slug }).select().single();
        if (!error) {
          club = data;
          creado = true;
          break;
        }
        const falta = columnaFaltante(error);
        if (falta && opcionales.includes(falta) && falta in base) {
          delete base[falta];
          continue;
        }
        if (String(error.code) === '23505' && /slug/i.test(String(error.message))) continue;
        throw error;
      }
      if (!club) throw new Error('No se pudo crear el club.');
    }

    // 3) Seguimiento del lead.
    await admin.from('crm_leads_seguimiento').upsert(
      {
        lead_id: leadId,
        estado: 'en_prueba',
        club_id: club.id,
        actualizado_por: usuario.id,
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: 'lead_id' }
    );

    return respuestaJson({
      ok: true,
      club_id: club.id,
      club_nombre: club.nombre,
      creado,
      invitado,
      mensaje: creado
        ? `Club creado en prueba por ${diasPrueba} días.${invitado ? ' Se envió la invitación al correo del dueño.' : ' El dueño ya tenía cuenta: puede iniciar sesión.'}`
        : 'Ese correo ya tenía un club: se enlazó el lead sin crear otro.',
    });
  } catch (err) {
    console.error('[admin-convertir-lead]', err);
    return respuestaJson({ ok: false, error: (err as Error)?.message || 'No se pudo convertir el lead.' }, 500);
  }
});
