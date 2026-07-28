import assert from 'node:assert/strict';
import { normalize, parseAmount } from './src/jetsmart.js';
import { validateWatch, loadWatches, appliesTo, matchFlight } from './src/watches.js';
import { tomorrowInAR, dedupeKey, groupByRoute, runSweep } from './src/radar.js';
import { formatFlight, formatReport } from './src/notify.js';
import { Session } from './src/session.js';

// --- fechas: el cron corre 03:01 UTC = 00:01 ART, cuando se libera D+1 ---
assert.equal(tomorrowInAR(new Date('2026-08-12T03:01:00Z')), '2026-08-13');
assert.equal(tomorrowInAR(new Date('2026-08-12T02:00:00Z')), '2026-08-12', 'antes de medianoche ART no rota');
assert.equal(tomorrowInAR(new Date('2026-08-31T03:01:00Z')), '2026-09-01', 'cruce de mes');
assert.equal(tomorrowInAR(new Date('2026-12-31T03:01:00Z')), '2027-01-01', 'cruce de año');

// --- parseo de la respuesta real de Caravelo ---
const CRUDO = {
  flightCode: 'JA3100', departure: '6:00 am', arrival: '7:28 am',
  departureStationCode: 'AEP', arrivalStationCode: 'COR',
  departureDateTimeIso: '2026-07-29 06:00:00', arrivalDateTimeIso: '2026-07-29 07:28:00',
  duration: '01h 28m', stops: 'Directo', availableSeats: 6,
  taxes: '15,103.85', currency: 'ARS', key: 'k', fareSellKey: 'fk',
};
const V = normalize(CRUDO);
assert.equal(V.code, 'JA3100');
assert.equal(V.seats, 6);
assert.equal(V.departsHHMM, '06:00');
assert.equal(V.taxes, 15103.85, 'coma de miles + punto decimal');
assert.equal(parseAmount('1,234,567.89'), 1234567.89);
assert.equal(parseAmount(undefined), null);

// --- validación de watches: que explote temprano y claro, no en producción ---
assert.throws(() => validateWatch({ from: 'AEP', to: 'AEP' }, 0), /iguales/);
assert.throws(() => validateWatch({ to: 'SLA' }, 0), /IATA/, 'falta "from"');
assert.throws(() => validateWatch({ from: 'BUENOS', to: 'SLA' }, 0), /IATA/, 'más de 3 letras');
assert.throws(() => validateWatch({ from: 'aep', to: 'SLA' }, 0), /IATA/, 'minúsculas no');
assert.throws(() => validateWatch({ from: 'AEP', to: 'SLA', weekdays: ['lunes'] }, 0), /inválido/);
assert.throws(() => validateWatch({ from: 'AEP', to: 'SLA', dateFrom: '13/08/2026' }, 0), /YYYY-MM-DD/);
assert.throws(() => validateWatch({ from: 'AEP', to: 'SLA', minSeats: 0 }, 0), /minSeats/);
assert.throws(() => loadWatches('[]'), /no hay watches/);
assert.doesNotThrow(() => validateWatch({ from: 'AEP', to: 'SLA', weekdays: ['fri'], minSeats: 2 }, 0));

// --- ventanas: los filtros silencian, no amplían el horizonte ---
const W = { from: 'AEP', to: 'SLA' };
assert.equal(appliesTo(W, '2026-08-13'), true, 'sin filtros, todos los días');
assert.equal(appliesTo({ ...W, enabled: false }, '2026-08-13'), false);
assert.equal(appliesTo({ ...W, dateFrom: '2026-08-01', dateTo: '2026-08-31' }, '2026-08-13'), true);
assert.equal(appliesTo({ ...W, dateTo: '2026-08-10' }, '2026-08-13'), false);
// 2026-08-13 es jueves.
assert.equal(appliesTo({ ...W, weekdays: ['thu'] }, '2026-08-13'), true);
assert.equal(appliesTo({ ...W, weekdays: ['fri', 'sat'] }, '2026-08-13'), false);

// --- filtros de vuelo ---
assert.equal(matchFlight({ minSeats: 2 }, V), true, '6 asientos pasan un mínimo de 2');
assert.equal(matchFlight({ minSeats: 2 }, { ...V, seats: 1 }), false, 'de a dos, 1 asiento no sirve');
assert.equal(matchFlight({ maxTaxes: 10000 }, V), false, 'tasas por encima del tope');
assert.equal(matchFlight({ maxTaxes: 20000 }, V), true);
assert.equal(matchFlight({ departAfter: '15:00' }, V), false, 'sale 06:00');
assert.equal(matchFlight({ departBefore: '15:00' }, V), true);

// --- agrupado: dos watches sobre la misma ruta = un solo request ---
const rutas = groupByRoute([
  { from: 'AEP', to: 'SLA', minSeats: 1 },
  { from: 'AEP', to: 'SLA', minSeats: 2 },
  { from: 'BRC', to: 'AEP' },
]);
assert.equal(rutas.length, 2, 'AEP→SLA se consulta una vez sola');
assert.equal(rutas[0].watches.length, 2);

// --- formato ---
assert.equal(formatFlight(V), 'JA3100 · 06:00→07:28 · 01h 28m · 6 asientos · ARS 15,103.85');
assert.match(formatFlight({ ...V, seats: 1 }), /1 asiento(?!s)/, 'singular');
const reporte = formatReport([{ watch: { label: 'Ida a Salta' }, flights: [V] }], '2026-07-29');
assert.match(reporte, /Ida a Salta/);
assert.match(reporte, /JA3100/);
assert.match(reporte, /1 vuelo\(s\)/);

// --- sesión: rota la cookie, ignora analytics, no pisa con valores vacíos ---
const memStore = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
};
{
  process.env.AYCF_COOKIE = 'laravel_session=ORIGINAL; _ga=basura; XSRF-TOKEN=tok';
  const s = await new Session(memStore()).load();
  assert.match(s.header(), /laravel_session=ORIGINAL/);
  assert.doesNotMatch(s.header(), /_ga/, 'las de analytics no se guardan');

  const res = {
    headers: {
      getSetCookie: () => [
        'laravel_session=ROTADA; path=/; max-age=1800; httponly',
        '_gid=ruido; path=/',
      ],
    },
  };
  assert.equal(await s.absorb(res), true, 'detecta que cambió');
  assert.match(s.header(), /laravel_session=ROTADA/, 'la sesión se renovó sola');
  assert.doesNotMatch(s.header(), /_gid/);
  assert.equal(await s.absorb(res), false, 'misma cookie, sin reescritura');
}

// --- un 5xx NO puede leerse como "no hay cupo": es el peor modo de falla ---
{
  const { search } = await import('./src/jetsmart.js');
  const sess = { header: () => 'x', absorb: async () => false };
  const orig = globalThis.fetch;

  const responder = (status, body) => {
    globalThis.fetch = async () => ({
      status, ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
      headers: { getSetCookie: () => [] },
    });
  };

  responder(500, { content: { exceptionMessage: 'error.token.mismatch' } });
  await assert.rejects(() => search(sess, { from: 'AEP', to: 'COR', date: '2026-07-29' }),
    /superada/i, 'token.mismatch => sesion superada, con la explicacion correcta');

  responder(500, { content: {} });
  await assert.rejects(() => search(sess, { from: 'AEP', to: 'COR', date: '2026-07-29' }),
    /500/, 'un 500 cualquiera tiene que explotar, no devolver []');

  responder(200, { content: { flights: { flightsOutbound: [CRUDO] } } });
  assert.equal((await search(sess, { from: 'AEP', to: 'COR', date: '2026-07-29' })).length, 1);

  globalThis.fetch = orig;
}

// --- dedupe: correr cada 15 min no puede spamear el mismo vuelo ---
{
  const store = memStore();
  const session = { header: () => 'x' };
  const watches = [{ from: 'AEP', to: 'COR', minSeats: 1 }];
  const fake = async () => [V];

  // Inyectamos el search vía runSweep para no pegarle a la red en los tests.
  const sweep = (s) => runSweep({
    date: '2026-07-29', watches, store, session, notify: false, _search: s,
  });
  assert.equal(dedupeKey('2026-07-29', watches[0], V), 'seen:2026-07-29|AEP-COR|JA3100');

  const uno = await sweep(fake);
  assert.equal(uno.hits.length, 1, 'primera pasada: avisa');
  const dos = await sweep(fake);
  assert.equal(dos.hits.length, 0, 'segunda pasada: ya lo vio, no repite');
}

// --- un WATCHES roto tiene que avisar, no morir mudo ---
{
  const { runRadar } = await import('./src/radar.js');
  const orig = globalThis.fetch;
  const avisos = [];
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('api.telegram.org')) avisos.push(JSON.parse(opt.body).text);
    return { ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } };
  };
  process.env.TELEGRAM_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = 'y';
  process.env.STATE_FILE = '/tmp/aycf-test-state.json';

  const out = await runRadar({ watchesRaw: '{ esto no es json' });
  assert.equal(out.ok, false, 'no explota: devuelve el error');
  assert.ok(avisos.some((a) => /Error inesperado/.test(a)),
    'un WATCHES roto tiene que llegar por Telegram, no ser un 500 mudo');

  globalThis.fetch = orig;
}

// --- encontrar cupo y no poder avisar NO es un exito ---
{
  const store = memStore();
  const session = { header: () => 'x' };
  const watches = [{ from: 'AEP', to: 'COR', minSeats: 1 }];
  const orig = globalThis.fetch;

  // Telegram caido (token revocado): el fetch falla.
  globalThis.fetch = async () => { throw new Error('401 Unauthorized'); };
  process.env.TELEGRAM_TOKEN = 'muerto'; process.env.TELEGRAM_CHAT_ID = 'y';

  const out = await runSweep({
    date: '2026-07-29', watches, store, session, _search: async () => [V],
  });
  assert.equal(out.ok, false, 'hubo cupo pero no se pudo avisar => NO es ok');
  assert.equal(out.error, 'notify-failed');

  globalThis.fetch = orig;
}

// --- la corrida de las 00:01 avisa siempre, con o sin cupo ---
{
  const { isReleaseRun } = await import('./src/radar.js');
  assert.equal(isReleaseRun(new Date('2026-07-29T03:01:00Z')), true, '00:01 ART');
  assert.equal(isReleaseRun(new Date('2026-07-29T03:00:00Z')), false,
    '00:00 ART NO: el inventario sale un minuto despues');
  assert.equal(isReleaseRun(new Date('2026-07-29T03:05:00Z')), true);
  assert.equal(isReleaseRun(new Date('2026-07-29T03:06:00Z')), false);
  assert.equal(isReleaseRun(new Date('2026-07-29T15:01:00Z')), false, 'mediodia no');
}

// --- comandos del bot ---
{
  const { handleCommand } = await import('./src/commands.js');
  const store = memStore();
  store.name = 'memory';
  process.env.WATCHES = JSON.stringify([{ from: 'AEP', to: 'SLA' }]);

  const rutas = await handleCommand('/rutas', { store });
  assert.match(rutas, /AEP→SLA/);
  assert.match(rutas, /1 ruta/);

  await handleCommand('/vigilar BRC EZE 2', { store });
  const conNueva = await handleCommand('/rutas', { store });
  assert.match(conNueva, /BRC→EZE/, 'la ruta nueva persiste en el store');
  assert.match(conNueva, /≥2 asientos/);

  // Lo guardado tiene que ganarle a la env var, si no el cron ignoraria /vigilar.
  const { resolveWatches } = await import('./src/config.js');
  assert.equal((await resolveWatches(store)).length, 2, 'el store manda sobre WATCHES');

  assert.match(await handleCommand('/vigilar BRC EZE 2', { store }), /Ya estaba/);
  assert.match(await handleCommand('/vigilar AEP', { store }), /IATA/, 'falta destino');
  assert.match(await handleCommand('/borrar 99', { store }), /del 1 al 2/);
  assert.match(await handleCommand('/borrar 2', { store }), /BRC→EZE/);
  assert.equal((await resolveWatches(store)).length, 1);
  assert.match(await handleCommand('/comandoinventado', { store }), /No conozco/);
  assert.match(await handleCommand('/ayuda', { store }), /\/buscar/);
  delete process.env.WATCHES;
}

console.log('✅ todo ok');
