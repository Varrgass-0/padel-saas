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
  precioPorHoraDeCancha,
  slugDelClub,
  tarifasActivasDelDia,
  urlConParametros,
  validarSolicitudReserva,
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
  igual(calcularPrecioReserva('11:30', 60, lunes, 500), 500); // no cabe completo en la franja
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
