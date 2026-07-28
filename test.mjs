import assert from 'node:assert/strict';
import {
  ROUTES, tomorrowInAR, seatsIn, sessionDead, describeFlight, buildMessage, shouldNotify,
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

// Shape desconocido → crudo, no silencio.
assert.match(describeFlight({ campoRaro: 'x' }), /shape desconocido/);
assert.equal(describeFlight({ flightNumber: 'JA3044', departureDate: '2026-08-13T19:20:00' }),
  'JA3044 · 2026-08-13 19:20');

// Barrido diario: sin hits no se notifica (si no, spam todas las noches).
assert.equal(shouldNotify([], false), false);
assert.equal(shouldNotify([{}], false), true);
assert.equal(shouldNotify([], true), true, 'NOTIFY_EMPTY fuerza el aviso de "no hay nada"');

const msg = buildMessage(
  [{ from: 'EZE', to: 'SLA', seats: [{ flightNumber: 'JA3044', departureDate: '2026-08-13T19:20:00' }] }],
  '2026-08-13', 10);
assert.match(msg, /✅ \*EZE→SLA\*/);
assert.match(msg, /JA3044/);
assert.match(msg, /1\/10 rutas/);

console.log('✅ todo ok');
