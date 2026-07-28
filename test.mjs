import assert from 'node:assert/strict';
import {
  ROUTES, tomorrowInAR, seatsIn, sessionDead, describeFlight, buildMessage, shouldNotify, enoughSeats,
} from './api/radar.js';

// El cron dispara 03:01 UTC = 00:01 ART, justo cuando se libera D+1.
assert.equal(tomorrowInAR(new Date('2026-08-12T03:01:00Z')), '2026-08-13');
// Antes de medianoche ART el target todavía no rota.
assert.equal(tomorrowInAR(new Date('2026-08-12T02:00:00Z')), '2026-08-12');
// Cruce de mes y de año.
assert.equal(tomorrowInAR(new Date('2026-08-31T03:01:00Z')), '2026-09-01');
assert.equal(tomorrowInAR(new Date('2026-12-31T03:01:00Z')), '2027-01-01');

// Rutas direccionales: si está la ida tiene que estar la vuelta.
for (const { from, to } of ROUTES) {
  assert.ok(ROUTES.some((r) => r.from === to && r.to === from),
    `falta la inversa de ${from}→${to}`);
}

// flightsOutbound vacío = sin cupo, y no puede explotar si falta el nodo.
assert.deepEqual(seatsIn({ content: { flights: { flightsOutbound: [] } } }), []);
assert.deepEqual(seatsIn({}), []);
assert.equal(seatsIn({ content: { flights: { flightsOutbound: [{ a: 1 }] } } }).length, 1);

// Caravelo redirige al login con 200 + redirectUri, no con 401.
assert.equal(sessionDead({ status: 401 }, {}), true);
assert.equal(sessionDead({ status: 200 }, { redirectUri: '/login' }), true);
assert.equal(sessionDead({ status: 200 }, { redirectUri: null }), false);

// Shape inesperado → crudo, no silencio.
assert.match(describeFlight({ campoRaro: 'x' }), /shape inesperado/);

// Shape real, capturado de la API el 28/7.
const VUELO = {
  flightCode: 'JA3100', departure: '6:00 am', arrival: '7:28 am',
  departureDateTimeIso: '2026-07-29 06:00:00', arrivalDateTimeIso: '2026-07-29 07:28:00',
  duration: '01h 28m', availableSeats: 6, taxes: '15,103.85', currency: 'ARS',
};
assert.equal(describeFlight(VUELO), 'JA3100 · 06:00→07:28 · 01h 28m · 6 asientos · ARS 15,103.85');
assert.match(describeFlight({ ...VUELO, availableSeats: 1 }), /1 asiento(?!s)/, 'singular');

// availableSeats es lo que decide si podemos viajar los dos.
assert.equal(enoughSeats({ availableSeats: 6 }, 2), true);
assert.equal(enoughSeats({ availableSeats: 1 }, 2), false);
assert.equal(enoughSeats({ availableSeats: 1 }, 1), true);
assert.equal(enoughSeats({}, 2), false, 'sin el campo, asumir 1 y no prometer de más');

// Barrido diario: sin hits no se notifica (si no, spam todas las noches).
assert.equal(shouldNotify([], false), false);
assert.equal(shouldNotify([{}], false), true);
assert.equal(shouldNotify([], true), true, 'NOTIFY_EMPTY fuerza el aviso de "no hay nada"');

const msg = buildMessage([{ from: 'AEP', to: 'COR', seats: [VUELO] }], '2026-07-29', 10);
assert.match(msg, /✅ \*AEP→COR\*/);
assert.match(msg, /JA3100/);
assert.match(msg, /1 vuelo\(s\), 6 asiento\(s\)/);
assert.match(msg, /1\/10 rutas/);
assert.match(buildMessage([{ from: 'AEP', to: 'COR', seats: [VUELO] }], '2026-07-29', 10, 2), /≥2 asientos/);

// Los vuelos se listan por hora de salida, no en el orden que vino la API.
const dos = buildMessage([{ from: 'AEP', to: 'COR', seats: [
  { ...VUELO, flightCode: 'TARDE', departureDateTimeIso: '2026-07-29 19:00:00' },
  { ...VUELO, flightCode: 'TEMPRANO', departureDateTimeIso: '2026-07-29 06:00:00' },
]}], '2026-07-29', 10);
assert.ok(dos.indexOf('TEMPRANO') < dos.indexOf('TARDE'), 'ordenado por salida');

console.log('✅ todo ok');
