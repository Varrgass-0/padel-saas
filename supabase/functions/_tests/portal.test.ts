// Pruebas de pagos en línea del Portal (sin red):
//   deno test supabase/functions/_tests/
import {
  ahoraEnZona,
  calcularPrecioReserva,
  costoCancha,
  cuentaConectadaActiva,
  diaSemanaDeFecha,
  duracionesPermitidas,
  esTokenPortal,
  cotizarReserva,
  precioHoraDeRegla,
  precioPorHoraDeCancha,
  slugDelClub,
  tarifasActivasDelDia,
  urlConParametros,
  validarSolicitudReserva,
  cotizarArticulos,
  descuentoProntoPagoVigente,
  errorDeRetencion,
  esTipoPagoPortal,
  eventoYaInicio,
  membresiaActiva,
  montoInscripcionTorneo,
  montoParaUnirseATorneo,
  precioClase,
  precioDeReta,
  productoIgnoraStock,
  variantesVendibles,
} from '../portal-checkout/logica.ts';
import { procesarEventoPortal, type DepsPortal } from '../portal-stripe-webhook/procesar.ts';

function igual(a: unknown, b: unknown, msg = '') {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n  esperado: ${jb}\n  obtenido: ${ja}`);
}

const TARIFAS = [
  { hora_inicio: '18:00', hora_fin: '23:00', precio_hora: 800, dias_semana: [1, 2, 3, 4, 5] },
  { hora_inicio: '07:00', hora_fin: '12:00', precio_hora: 400, dias_semana: [] },
  { hora_inicio: '07:00', hora_fin: '23:00', precio_hora: 999, modulo: 'academia' },
  { hora_inicio: '13:00', hora_fin: '15:00', precio_hora: 1, activo: false },
];

Deno.test('portal: precio por hora de la cancha (columna, nombre, genérico)', () => {
  igual(precioPorHoraDeCancha({ precio_por_hora: 550 }), 550);
  igual(precioPorHoraDeCancha({ precio: '480' }), 480);
  igual(precioPorHoraDeCancha({ nombre: 'Cancha Panorámica 1' }), 650);
  igual(precioPorHoraDeCancha({ nombre: 'Cancha 9' }), 700);
});

Deno.test('portal: franjas activas del día (sin academia ni inactivas)', () => {
  // 2026-10-26 es lunes (1)
  igual(diaSemanaDeFecha('2026-10-26'), 1);
  igual(tarifasActivasDelDia(TARIFAS, 1).length, 2);
  igual(tarifasActivasDelDia(TARIFAS, 0).length, 1); // domingo: solo la de todos los días
});

Deno.test('portal: calcularPrecioReserva = mismo resultado que el Portal', () => {
  const lunes = tarifasActivasDelDia(TARIFAS, 1);
  igual(calcularPrecioReserva('19:00', 60, lunes, 500), 800);
  igual(calcularPrecioReserva('08:00', 90, lunes, 500), 600);
  igual(calcularPrecioReserva('11:30', 60, lunes, 500), 450); // prorrateo: 30 min a $400/h + 30 min a $500/h
  igual(calcularPrecioReserva('14:00', 60, lunes, 500), 500);
});

Deno.test('portal: 2 horas en club de 60 min = suma de 2 bloques (precio mixto)', () => {
  const club = { duracion_reserva_minutos: 60 };
  igual(costoCancha({ cancha: { precio_por_hora: 500 }, club, tarifas: TARIFAS, fecha: '2026-10-26', horaInicio: '17:00', duracionMin: 120 }), 1300);
  igual(costoCancha({ cancha: { precio_por_hora: 500 }, club, tarifas: TARIFAS, fecha: '2026-10-25', horaInicio: '17:00', duracionMin: 120 }), 1000);
  // Switch de tarifas apagado → solo precio de la cancha.
  igual(costoCancha({ cancha: { precio_por_hora: 500 }, club: { ...club, tarifas_habilitadas: false }, tarifas: TARIFAS, fecha: '2026-10-26', horaInicio: '19:00', duracionMin: 60 }), 500);
  // Club de 90 min: un solo bloque de 90.
  igual(costoCancha({ cancha: { precio_por_hora: 500 }, club: { duracion_reserva_minutos: 90 }, tarifas: [], fecha: '2026-10-26', horaInicio: '19:00', duracionMin: 90 }), 750);
});

// --- v124/v125 · App-114: Reglas de Tarifa (canchas, precio fijo / % descuento, vigencia, prorrateo) ---
const REGLAS_V124 = [
  { id: 1, nombre: 'Hora Pico', hora_inicio: '18:00', hora_fin: '22:00', precio_hora: 800 },
  { id: 2, nombre: 'Miércoles Valle', dias_semana: [3], hora_inicio: '07:00', hora_fin: '12:00', tipo_ajuste: 'DESCUENTO_PORCENTAJE', porcentaje_ajuste: 50, precio_hora: null },
  { id: 3, nombre: 'Panorámica Tarde', cancha_ids: ['9'], hora_inicio: '12:00', hora_fin: '18:00', tipo_ajuste: 'PRECIO_FIJO', precio_hora: 600 },
  { id: 4, nombre: 'Promo Lunes Noviembre', dias_semana: [1], hora_inicio: '07:00', hora_fin: '12:00', precio_hora: 300, vigencia_desde: '2026-11-01', vigencia_hasta: '2026-11-30' },
  { id: 5, nombre: 'Noche', hora_inicio: '22:00', hora_fin: '00:00', precio_hora: 400 },
];
const delDiaV124 = (fecha: string, canchaId: unknown) => tarifasActivasDelDia(REGLAS_V124, diaSemanaDeFecha(fecha), { fecha, canchaId });

Deno.test('v124: filtro por canchas aplicables y vigencia', () => {
  // 2026-10-28 es miércoles (3); 2026-11-02 es lunes (1)
  igual(delDiaV124('2026-10-28', 5).map((t) => t.id), [1, 2, 5]);
  igual(delDiaV124('2026-10-28', 9).map((t) => t.id), [1, 2, 3, 5]);
  igual(delDiaV124('2026-11-02', 5).map((t) => t.id), [1, 4, 5]); // lunes de noviembre: promo vigente
  igual(delDiaV124('2026-12-07', 5).map((t) => t.id), [1, 5]); // lunes de diciembre: vencida
  igual(tarifasActivasDelDia(REGLAS_V124, 3).length, 4); // sin contexto: solo día + activo (la promo es de lunes)
});

Deno.test('v124: precio fijo, % de descuento y vigencia', () => {
  const base = 500;
  igual(calcularPrecioReserva('10:00', 60, delDiaV124('2026-10-28', 5), base), 250); // −50%
  igual(calcularPrecioReserva('19:00', 60, delDiaV124('2026-10-28', 5), base), 800); // precio fijo
  igual(calcularPrecioReserva('13:00', 60, delDiaV124('2026-10-28', 9), base), 600); // precio fijo solo cancha 9
  igual(calcularPrecioReserva('13:00', 60, delDiaV124('2026-10-28', 5), base), 500);
  igual(calcularPrecioReserva('10:00', 60, delDiaV124('2026-11-02', 5), base), 300); // promo vigente
  igual(calcularPrecioReserva('10:00', 60, delDiaV124('2026-10-26', 5), base), 500); // promo aún no vigente
  igual(calcularPrecioReserva('23:00', 60, delDiaV124('2026-10-26', 5), base), 400); // 22:00–00:00 = hasta medianoche
  igual(precioHoraDeRegla(REGLAS_V124[1], 0), null); // % sin precio base → nunca $0
});

Deno.test('v124: prorrateo exacto de bloques que cruzan franjas (90 y 120 min)', () => {
  const base = 500;
  // 11:30–13:00 miércoles: 30 min a $250/h + 60 min a $500/h
  igual(calcularPrecioReserva('11:30', 90, delDiaV124('2026-10-28', 5), base), 625);
  // 17:00–19:00 lunes: 60 min estándar + 60 min Hora Pico
  igual(calcularPrecioReserva('17:00', 120, delDiaV124('2026-10-26', 5), base), 1300);
  // 17:30–19:00: 30 min estándar + 60 min Hora Pico
  igual(calcularPrecioReserva('17:30', 90, delDiaV124('2026-10-26', 5), base), 1050);
  // 21:30–23:00: Hora Pico → Noche
  igual(calcularPrecioReserva('21:30', 90, delDiaV124('2026-10-26', 5), base), 800);
  const c = cotizarReserva('17:30', 90, delDiaV124('2026-10-26', 5), base);
  igual([c.total, c.totalBase, c.conAjuste, c.tramos.length, c.reglas.map((r) => r.nombre)], [1050, 750, true, 2, ['Hora Pico']]);
  igual(c.tramos.map((t) => [t.minutos, t.precioHora, t.subtotal, t.regla?.nombre ?? null]), [[30, 500, 250, null], [60, 800, 800, 'Hora Pico']]);
});

Deno.test('v124: reglas sobrepuestas → sin prioridades, resultado determinista (primera por hora de inicio)', () => {
  const sobrepuestas = [
    { id: 2, nombre: 'Corta', hora_inicio: '10:00', hora_fin: '11:00', precio_hora: 200 },
    { id: 7, nombre: 'Amplia', hora_inicio: '09:00', hora_fin: '12:00', precio_hora: 400 },
  ];
  igual(calcularPrecioReserva('10:00', 60, sobrepuestas, 500), 400);
  igual(calcularPrecioReserva('10:00', 60, [...sobrepuestas].reverse(), 500), 400); // el orden de llegada no importa
  // Apagando la amplia (switch) aplica la corta.
  igual(calcularPrecioReserva('10:00', 60, tarifasActivasDelDia([sobrepuestas[0], { ...sobrepuestas[1], activo: false }], 3), 500), 200);
});

Deno.test('v125: el % de recargo está descontinuado (nunca aplica)', () => {
  const recargoViejo = { id: 8, nombre: 'Recargo viejo', hora_inicio: '07:00', hora_fin: '23:00', tipo_ajuste: 'RECARGO_PORCENTAJE', porcentaje_ajuste: 20, precio_hora: null };
  igual(tarifasActivasDelDia([recargoViejo], 3).length, 0);
  igual(precioHoraDeRegla(recargoViejo, 500), null);
  igual(calcularPrecioReserva('10:00', 60, [recargoViejo], 500), 500);
  igual(precioHoraDeRegla({ tipo_ajuste: 'DESCUENTO_PORCENTAJE', porcentaje_ajuste: 120 }, 500), null); // descuento > 100% inválido
});

Deno.test('App-114: solo los descuentos son "promo" para el jugador (Hora Pico nunca)', () => {
  const base = 500;
  const pico = cotizarReserva('19:00', 60, delDiaV124('2026-10-28', 5), base);
  igual([pico.total, pico.promos.length, pico.totalSinPromo], [800, 0, 800]); // precio mayor: sin promo, sin tachado
  const valle = cotizarReserva('10:00', 60, delDiaV124('2026-10-28', 5), base);
  igual([valle.total, valle.promos.map((r) => r.nombre), valle.totalSinPromo], [250, ['Miércoles Valle'], 500]);
  // Promo sobre una hora con precio fijo interno: el tachado es el precio SIN promo (incluye la Hora Pico en silencio).
  const reglas = [
    { id: 1, nombre: 'Hora Pico', hora_inicio: '18:00', hora_fin: '22:00', precio_hora: 800 },
    { id: 2, nombre: 'Promo Lunes Noche', hora_inicio: '20:00', hora_fin: '22:00', tipo_ajuste: 'DESCUENTO_PORCENTAJE', porcentaje_ajuste: 50 },
  ];
  const mixto = cotizarReserva('20:00', 60, [reglas[1]], base);
  igual([mixto.total, mixto.totalSinPromo], [250, 500]);
  const conPico = cotizarReserva('19:00', 120, [{ ...reglas[1], hora_inicio: '20:00' }, { ...reglas[0], hora_fin: '20:00' }], base);
  igual([conPico.total, conPico.totalSinPromo, conPico.promos.length], [1050, 1300, 1]); // 800 + 250 vs 800 + 500
});

Deno.test('v124: costoCancha usa cancha + fecha y prorratea', () => {
  const club = { duracion_reserva_minutos: 60 };
  igual(costoCancha({ cancha: { id: 9, precio_por_hora: 500 }, club, tarifas: REGLAS_V124, fecha: '2026-10-28', horaInicio: '13:00', duracionMin: 120 }), 1200);
  igual(costoCancha({ cancha: { id: 5, precio_por_hora: 500 }, club, tarifas: REGLAS_V124, fecha: '2026-10-28', horaInicio: '11:00', duracionMin: 120 }), 750); // 250 + 500
  igual(costoCancha({ cancha: { id: 5, precio_por_hora: 500 }, club: { duracion_reserva_minutos: 90 }, tarifas: REGLAS_V124, fecha: '2026-10-28', horaInicio: '11:30', duracionMin: 90 }), 625);
});

Deno.test('portal: duraciones permitidas', () => {
  igual(duracionesPermitidas(60), [60, 120]);
  igual(duracionesPermitidas(120), [60, 120]);
  igual(duracionesPermitidas(90), [90]);
});

Deno.test('portal: validación de horario (pasado, horario del club, duración)', () => {
  const ahora = new Date('2026-10-26T16:00:00Z'); // 10:00 en CDMX
  const club = { duracion_reserva_minutos: 60, hora_apertura: '07:00', hora_cierre: '23:00' };
  igual(ahoraEnZona('America/Mexico_City', ahora), { fecha: '2026-10-26', minutos: 600 });
  igual(validarSolicitudReserva({ fecha: '2026-10-26', horaInicio: '09:00', duracionMin: 60, club, ahora }).codigo, 'horario_pasado');
  igual(validarSolicitudReserva({ fecha: '2026-10-26', horaInicio: '10:00', duracionMin: 60, club, ahora }).codigo, 'horario_pasado');
  const ok = validarSolicitudReserva({ fecha: '2026-10-26', horaInicio: '11:00', duracionMin: 120, club, ahora });
  igual([ok.ok, ok.horaInicio, ok.horaFin], [true, '11:00', '13:00']);
  igual(validarSolicitudReserva({ fecha: '2026-10-27', horaInicio: '22:30', duracionMin: 60, club, ahora }).codigo, 'fuera_de_horario');
  igual(validarSolicitudReserva({ fecha: '2026-10-27', horaInicio: '06:00', duracionMin: 60, club, ahora }).codigo, 'fuera_de_horario');
  igual(validarSolicitudReserva({ fecha: '2026-10-27', horaInicio: '12:00', duracionMin: 90, club, ahora }).codigo, 'duracion_no_permitida');
  igual(validarSolicitudReserva({ fecha: '27/10/2026', horaInicio: '12:00', duracionMin: 60, club, ahora }).codigo, 'datos_invalidos');
  igual(validarSolicitudReserva({ fecha: '2026-10-27', horaInicio: "12:00'; drop", duracionMin: 60, club, ahora }).codigo, 'datos_invalidos');
  // Club sin horario configurado: 06:00–24:00
  igual(validarSolicitudReserva({ fecha: '2026-10-27', horaInicio: '23:00', duracionMin: 60, club: { duracion_reserva_minutos: 60 }, ahora }).horaFin, '24:00');
});

Deno.test('portal: club ↔ cuenta conectada, slug y token', () => {
  igual(cuentaConectadaActiva({ stripe_connect_enabled: true, stripe_account_id: 'acct_1A' }), 'acct_1A');
  igual(cuentaConectadaActiva({ stripe_connect_enabled: false, stripe_account_id: 'acct_1A' }), null);
  igual(cuentaConectadaActiva({ stripe_connect_enabled: true, stripe_account_id: null }), null);
  igual(cuentaConectadaActiva({ stripe_connect_enabled: true, stripe_account_id: 'cus_1' }), null);
  igual(slugDelClub({ slug: 'Club-A' }), 'club-a');
  igual(slugDelClub({ slug: null, nombre: 'Pádel Ñandú' }), 'padel-nandu');
  igual(esTokenPortal('aaaaaaaa-0000-0000-0000-000000000001'), true);
  igual(esTokenPortal('x'), false);
  igual(
    urlConParametros('https://qlub-os-mx.vercel.app/canchas/club-a', { pago: 'exito', reserva: '7' }),
    'https://qlub-os-mx.vercel.app/canchas/club-a?pago=exito&reserva=7'
  );
});

function depsFalsas(errorConfirmar: { code?: string; message?: string } | null = null) {
  const llamadas: Array<{ fn: string; args: unknown }> = [];
  const deps: DepsPortal = {
    confirmar: (args) => {
      llamadas.push({ fn: 'confirmar', args });
      return Promise.resolve({ data: { resultado: 'confirmada' }, error: errorConfirmar });
    },
    expirar: (args) => {
      llamadas.push({ fn: 'expirar', args });
      return Promise.resolve({ data: { resultado: 'liberada' }, error: null });
    },
    confirmarPago: (args) => {
      llamadas.push({ fn: 'confirmarPago', args });
      return Promise.resolve({ data: { resultado: 'confirmada' }, error: errorConfirmar });
    },
    expirarPago: (args) => {
      llamadas.push({ fn: 'expirarPago', args });
      return Promise.resolve({ data: { resultado: 'liberada' }, error: null });
    },
  };
  return { deps, llamadas };
}

const SESION = {
  id: 'cs_1',
  payment_status: 'paid',
  amount_total: 50000,
  currency: 'mxn',
  payment_intent: 'pi_1',
  client_reference_id: '7',
  metadata: { qlubos_tipo: 'reserva', reserva_id: '7', club_id: '1', jugador_id: '3' },
};

Deno.test('portal webhook: checkout.session.completed confirma con la cuenta del evento', async () => {
  const { deps, llamadas } = depsFalsas();
  const r = await procesarEventoPortal({ id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1A', data: { object: SESION } }, deps);
  igual(r.estado, 'procesado');
  igual(llamadas, [
    { fn: 'confirmar', args: { p_reserva_id: '7', p_session_id: 'cs_1', p_cuenta: 'acct_1A', p_payment_intent: 'pi_1', p_monto_centavos: 50000, p_moneda: 'mxn' } },
  ]);
});

Deno.test('portal webhook: ignora eventos sin cuenta conectada, ajenos o sin pagar', async () => {
  const { deps, llamadas } = depsFalsas();
  igual((await procesarEventoPortal({ id: 'e', type: 'checkout.session.completed', data: { object: SESION } }, deps)).estado, 'ignorado');
  igual(
    (await procesarEventoPortal({ id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: { ...SESION, metadata: { type: 'suscripcion' } } } }, deps)).estado,
    'ignorado'
  );
  igual(
    (await procesarEventoPortal({ id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: { ...SESION, payment_status: 'unpaid' } } }, deps)).estado,
    'ignorado'
  );
  igual(llamadas.length, 0);
});

Deno.test('portal webhook: expiración libera la retención', async () => {
  const { deps, llamadas } = depsFalsas();
  const r = await procesarEventoPortal({ id: 'e', type: 'checkout.session.expired', account: 'acct_1A', data: { object: { ...SESION, payment_status: 'unpaid' } } }, deps);
  igual([r.estado, llamadas[0]], ['procesado', { fn: 'expirar', args: { p_reserva_id: '7', p_session_id: 'cs_1' } }]);
});

Deno.test('portal webhook: inconsistencia (P0001) no se reintenta; error transitorio sí', async () => {
  let r = await procesarEventoPortal(
    { id: 'e', type: 'checkout.session.completed', account: 'acct_OTRA', data: { object: SESION } },
    depsFalsas({ code: 'P0001', message: 'cuenta no corresponde' }).deps
  );
  igual([r.estado, r.reintentar ?? false], ['error', false]);
  r = await procesarEventoPortal(
    { id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: SESION } },
    depsFalsas({ code: '08006', message: 'conexión' }).deps
  );
  igual([r.estado, r.reintentar], ['error', true]);
});

// =============================================================================
// v122 — todos los módulos del Portal
// =============================================================================
Deno.test('portal v122: precio de reta por alias y torneo con pareja / pronto pago', () => {
  igual(precioDeReta({ costo_inscripcion: '180' }), 180);
  igual(precioDeReta({ precio_inscripcion: null, precio_persona: 0, precio: 300 }), 0); // 0 es un valor capturado (igual que el Portal)
  igual(precioDeReta(null), 0);
  const torneo = { precio: 500, unidad_precio: 'jugador', descuentos_pronto_pago: [{ fecha_inicio: '2026-10-01', fecha_fin: '2026-10-31', porcentaje: 10 }, { fecha_inicio: '2026-10-20', fecha_fin: '2026-10-30', porcentaje: 15 }] };
  igual(descuentoProntoPagoVigente(torneo, '2026-10-26'), 15);
  igual(descuentoProntoPagoVigente(torneo, '2026-11-02'), 0);
  igual(montoInscripcionTorneo(torneo, { modo: 'nueva' }, '2026-11-02'), 1000); // por jugador × 2
  igual(montoInscripcionTorneo(torneo, { modo: 'ninguna' }, '2026-11-02'), 500);
  igual(montoInscripcionTorneo(torneo, { modo: 'registrada' }, '2026-10-26'), 850); // 1000 − 15 %
  igual(montoInscripcionTorneo({ precio: 600, unidad_precio: 'pareja' }, { modo: 'nueva' }, '2026-10-26'), 600);
  igual(montoParaUnirseATorneo(torneo, { monto: 500 }, '2026-11-02'), 500);
  igual(montoParaUnirseATorneo({ precio: 600, unidad_precio: 'pareja' }, { monto: 600 }, '2026-11-02'), 0);
});

Deno.test('portal v122: academia (precio, membresía vigente) y eventos iniciados', () => {
  const clase = { precio_mensualidad: 900, precio_clase_suelta: '250' };
  igual([precioClase(clase, 'mensualidad'), precioClase(clase, 'clase_suelta')], [900, 250]);
  const alumnos = [
    { jugador_id: 3, tipo_pago: 'mensualidad', estado_pago: 'pagado', estado: 'activo', creditos_restantes: 2, fecha_renovacion: '2026-11-20' },
    { jugador_id: 4, tipo_pago: 'mensualidad', estado_pago: 'pagado', estado: 'activo', creditos_restantes: 0, fecha_renovacion: '2026-11-20' },
    { jugador_id: 5, tipo_pago: 'mensualidad', estatus_pago: 'pagado', estado: 'baja', creditos_restantes: 3 },
  ];
  igual(Boolean(membresiaActiva(alumnos, '3', '2026-10-26')), true);
  igual(Boolean(membresiaActiva(alumnos, '3', '2026-11-21')), false); // vencida
  igual(Boolean(membresiaActiva(alumnos, '4', '2026-10-26')), false); // sin créditos
  igual(Boolean(membresiaActiva(alumnos, '5', '2026-10-26')), false); // baja
  const ahora = new Date('2026-10-26T18:00:00Z'); // 12:00 en CDMX
  igual(eventoYaInicio('2026-10-26', '11:30', 'America/Mexico_City', ahora), true);
  igual(eventoYaInicio('2026-10-26', '12:30', 'America/Mexico_City', ahora), false);
  igual(eventoYaInicio('2026-10-25', '23:00', 'America/Mexico_City', ahora), true);
  igual(eventoYaInicio(null, '10:00', 'America/Mexico_City', ahora), false);
  igual([esTipoPagoPortal('tienda'), esTipoPagoPortal('suscripcion')], [true, false]);
});

const CLUB_TIENDA = { id: 1, addons_habilitados: true, productos_addons_ids: [10, '13'] };
const PRODUCTOS = new Map<string, Record<string, unknown>>([
  ['10', { id: 10, club_id: 1, nombre: 'Grip', categoria: 'Pro-Shop', precio: 80, stock: 3 }],
  ['11', { id: 11, club_id: 1, nombre: 'Playera', categoria: 'Pro-Shop', precio: 400, variantes: [{ id: 'v1', nombre: 'M', stock: 1 }, { nombre: 'L', precio: 420, stock: 5 }, { nombre: 'XL', stock: 9, recibido: false }] }],
  ['12', { id: 12, club_id: 1, nombre: 'Raqueta', categoria: 'Pro-Shop', precio: 3000, stock: 2, disponible: false }],
  ['13', { id: 13, club_id: 1, nombre: 'Agua', categoria: 'Cafetería/Bar', subcategoria: 'alimentos', precio: 25, stock: 0 }],
  ['14', { id: 14, club_id: 1, nombre: 'Gorra', categoria: 'Accesorios', precio: 200, stock: 4 }],
]);

Deno.test('portal v122: variantes vendibles y productos sin control de stock', () => {
  igual(variantesVendibles(PRODUCTOS.get('11')!).map((v) => [v.id, v.precio, v.stock]), [['v1', null, 1], ['var-l', 420, 5]]);
  igual([productoIgnoraStock(PRODUCTOS.get('13')!), productoIgnoraStock({ maneja_stock: false }), productoIgnoraStock(PRODUCTOS.get('10')!)], [true, true, false]);
});

Deno.test('portal v122: cotización de tienda con precios de la BD (ignora el precio del navegador)', () => {
  const r = cotizarArticulos(
    [
      { producto_id: 10, cantidad: 2, precio: 1 },
      { producto_id: '11', variante_id: 'var-l', cantidad: 1 },
      { producto_id: '11', variante_id: 'v1', cantidad: 1 },
      { producto_id: 10, cantidad: 1 },
      { producto_id: 13, cantidad: 4 },
    ],
    PRODUCTOS,
    CLUB_TIENDA,
    'tienda'
  );
  if (!r.ok) throw new Error(r.error);
  igual(r.items.map((i) => [i.producto_id, i.variante_id, i.nombre, i.precio, i.cantidad, i.subtotal]), [
    ['10', null, 'Grip', 80, 3, 240],
    ['11', 'var-l', 'Playera — L', 420, 1, 420],
    ['11', 'v1', 'Playera — M', 400, 1, 400],
    ['13', null, 'Agua', 25, 4, 100], // alimentos: sin límite de stock
  ]);
  igual(r.subtotal, 1160);
});

Deno.test('portal v122: rechazos de la cotización (stock, variante, no disponible, cantidad, no curado)', () => {
  const codigo = (sol: unknown, modo: 'tienda' | 'addons' = 'tienda') => {
    const r = cotizarArticulos(sol, PRODUCTOS, CLUB_TIENDA, modo);
    return r.ok ? 'ok' : r.codigo;
  };
  igual(codigo([{ producto_id: 10, cantidad: 4 }]), 'sin_stock');
  igual(codigo([{ producto_id: 10, cantidad: 2 }, { producto_id: 10, cantidad: 2 }]), 'sin_stock'); // renglones repetidos se suman
  igual(codigo([{ producto_id: 11, cantidad: 1 }]), 'variante_invalida');
  igual(codigo([{ producto_id: 11, variante_id: 'var-xl', cantidad: 1 }]), 'variante_invalida'); // no recibida
  igual(codigo([{ producto_id: 10, variante_id: 'v9', cantidad: 1 }]), 'variante_invalida');
  igual(codigo([{ producto_id: 12, cantidad: 1 }]), 'producto_no_disponible');
  igual(codigo([{ producto_id: 14, cantidad: 1 }]), 'producto_no_disponible'); // ni Pro-Shop ni curado
  igual(codigo([{ producto_id: 99, cantidad: 1 }]), 'producto_no_disponible');
  igual(codigo([{ producto_id: 10, cantidad: 0 }]), 'cantidad_invalida');
  igual(codigo([{ producto_id: 10, cantidad: 1.5 }]), 'cantidad_invalida');
  igual(codigo('x'), 'articulos_invalidos');
  // Quick Sell: solo los curados por el club, y nada si el switch está apagado.
  igual(codigo([{ producto_id: 11, variante_id: 'v1', cantidad: 1 }], 'addons'), 'producto_no_disponible');
  igual(codigo([{ producto_id: 10, cantidad: 1 }], 'addons'), 'ok');
  const apagado = cotizarArticulos([{ producto_id: 10, cantidad: 1 }], PRODUCTOS, { ...CLUB_TIENDA, addons_habilitados: false }, 'addons');
  igual(apagado.ok, false);
  // Producto de otro club
  const ajeno = new Map([['10', { ...PRODUCTOS.get('10')!, club_id: 2 }]]);
  igual(cotizarArticulos([{ producto_id: 10, cantidad: 1 }], ajeno, CLUB_TIENDA, 'tienda').ok, false);
});

Deno.test('portal v122: errores de retención → código y mensaje para el Portal', () => {
  igual(errorDeRetencion('cupo_lleno')?.codigo, 'cupo_lleno');
  igual(errorDeRetencion('ERROR: ya_inscrito')?.codigo, 'ya_inscrito');
  igual(errorDeRetencion('otra cosa'), null);
});

const SESION_PAGO = {
  ...SESION,
  id: 'cs_9',
  amount_total: 158000,
  client_reference_id: 'b3b1c3a0-0000-4000-8000-000000000001',
  metadata: { qlubos_tipo: 'portal_pago', pago_id: 'b3b1c3a0-0000-4000-8000-000000000001', tipo: 'reserva', club_id: '1', jugador_id: '3' },
};

Deno.test('portal webhook v122: portal_pago confirma y expira con el pago genérico', async () => {
  const { deps, llamadas } = depsFalsas();
  let r = await procesarEventoPortal({ id: 'e1', type: 'checkout.session.completed', account: 'acct_1A', data: { object: SESION_PAGO } }, deps);
  igual(r.estado, 'procesado');
  r = await procesarEventoPortal({ id: 'e2', type: 'checkout.session.expired', account: 'acct_1A', data: { object: { ...SESION_PAGO, payment_status: 'unpaid' } } }, deps);
  igual(r.estado, 'procesado');
  igual(llamadas, [
    {
      fn: 'confirmarPago',
      args: { p_pago_id: 'b3b1c3a0-0000-4000-8000-000000000001', p_session_id: 'cs_9', p_cuenta: 'acct_1A', p_payment_intent: 'pi_1', p_monto_centavos: 158000, p_moneda: 'mxn' },
    },
    { fn: 'expirarPago', args: { p_pago_id: 'b3b1c3a0-0000-4000-8000-000000000001', p_session_id: 'cs_9' } },
  ]);
});

Deno.test('portal webhook v122: la ruta v121 (reserva) no cambia y P0001 no se reintenta', async () => {
  const { deps, llamadas } = depsFalsas();
  await procesarEventoPortal({ id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: SESION } }, deps);
  igual(llamadas[0].fn, 'confirmar');
  const r = await procesarEventoPortal(
    { id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: SESION_PAGO } },
    depsFalsas({ code: 'P0001', message: 'monto distinto' }).deps
  );
  igual([r.estado, r.reintentar ?? false], ['error', false]);
  const sinPago = await procesarEventoPortal(
    { id: 'e', type: 'checkout.session.completed', account: 'acct_1A', data: { object: { ...SESION_PAGO, client_reference_id: null, metadata: { qlubos_tipo: 'portal_pago' } } } },
    deps
  );
  igual(sinPago.estado, 'error');
});
