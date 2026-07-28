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

// --- catalogo de aeropuertos: sale de la propia API, no hardcodeado ---
{
  const { parseCatalog, resolveAirport, routeExists, destinationsFrom, normalize } =
    await import('./src/airports.js');

  const CRUDO_RUTAS = [
    { departureStation: { id: 'AEP', name: 'Buenos Aires, Aeroparque' },
      arrivalStations: [{ id: 'SLA', name: 'Salta' }, { id: 'COR', name: 'Córdoba' }] },
    { departureStation: { id: 'BRC', name: 'Bariloche' },
      arrivalStations: [{ id: 'EZE', name: 'Buenos Aires, Ezeiza' }] },
  ];
  const cat = parseCatalog(CRUDO_RUTAS);
  assert.equal(Object.keys(cat.aeropuertos).length, 5);
  assert.equal(cat.aeropuertos.SLA, 'Salta');
  assert.ok(cat.rutas.includes('AEP-SLA'));

  // Acentos y mayusculas no pueden importar.
  assert.equal(normalize('Córdoba'), 'cordoba');
  assert.equal(resolveAirport('BRC', cat.aeropuertos).iata, 'BRC');
  assert.equal(resolveAirport('brc', cat.aeropuertos).iata, 'BRC');
  assert.equal(resolveAirport('bariloche', cat.aeropuertos).iata, 'BRC');
  assert.equal(resolveAirport('Bariloche', cat.aeropuertos).iata, 'BRC');
  assert.equal(resolveAirport('cordoba', cat.aeropuertos).iata, 'COR');
  assert.equal(resolveAirport('Córdoba', cat.aeropuertos).iata, 'COR');
  assert.equal(resolveAirport('salta', cat.aeropuertos).iata, 'SLA');

  // "buenos aires" matchea dos aeropuertos: hay que preguntar, no adivinar.
  const amb = resolveAirport('buenos aires', cat.aeropuertos);
  assert.ok(!amb.iata && amb.opciones?.length === 2, 'ambiguo => opciones');
  assert.ok(amb.opciones.some((o) => o.includes('AEP')));
  assert.deepEqual(resolveAirport('tokio', cat.aeropuertos), {});

  // Rutas que no existen: Cordoba-Salta no esta en la red y por eso el viaje
  // a Salta tuvo que triangular por Buenos Aires.
  assert.equal(routeExists('AEP', 'SLA', cat.rutas), true);
  assert.equal(routeExists('COR', 'SLA', cat.rutas), false);
  assert.equal(routeExists('AEP', 'SLA', []), true, 'sin catalogo no bloqueamos');
  assert.equal(destinationsFrom('AEP', cat.rutas, cat.aeropuertos).length, 2);
}

// --- el bot con nombres de ciudad ---
{
  const { handleCommand } = await import('./src/commands.js');
  const { saveCatalog } = await import('./src/airports.js');
  const store = memStore();
  store.name = 'memory';
  process.env.WATCHES = JSON.stringify([{ from: 'AEP', to: 'SLA' }]);
  await saveCatalog(store, [
    { departureStation: { id: 'AEP', name: 'Buenos Aires, Aeroparque' },
      arrivalStations: [{ id: 'SLA', name: 'Salta' }] },
    { departureStation: { id: 'BRC', name: 'Bariloche' },
      arrivalStations: [{ id: 'EZE', name: 'Buenos Aires, Ezeiza' }] },
  ]);

  const ok = await handleCommand('/vigilar bariloche ezeiza', { store });
  assert.match(ok, /Bariloche → Buenos Aires, Ezeiza/, 'resuelve nombres y etiqueta lindo');

  // Vigilar algo que no existe en la red te deja esperando para siempre.
  const noExiste = await handleCommand('/vigilar salta bariloche', { store });
  assert.match(noExiste, /no existe como directo/, 'avisa en vez de aceptar');

  assert.match(await handleCommand('/vigilar tokio salta', { store }), /No encontré/);
  assert.match(await handleCommand('/aeropuertos', { store }), /Bariloche/);
  assert.match(await handleCommand('/aeropuertos AEP', { store }), /Directos desde/);
  delete process.env.WATCHES;
}

// --- login automatico: el unico camino a que esto sea autonomo ---
{
  const { login, LoginError, tieneCredenciales } = await import('./src/login.js');
  const orig = globalThis.fetch;
  const limpio = { ...process.env };

  delete process.env.AYCF_EMAIL; delete process.env.AYCF_PASSWORD;
  assert.equal(tieneCredenciales(), false);
  await assert.rejects(() => login(), /faltan AYCF_EMAIL/, 'sin credenciales, error claro');

  process.env.AYCF_EMAIL = 'yo@ejemplo.com';
  process.env.AYCF_PASSWORD = 'secreto';
  assert.equal(tieneCredenciales(), true);

  const FORM = '<form id="kc-form-login" action="https://go.jetsmart.com/auth/realms/ja/' +
    'login-actions/authenticate?session_code=abc&amp;execution=xyz">' +
    '<input name="username"><input name="password"></form>';

  // Camino feliz: form -> POST -> redirect -> laravel_session.
  let posteado = null;
  globalThis.fetch = async (url, opt = {}) => {
    const u = String(url);
    if (opt.method === 'POST') {
      posteado = opt.body?.toString();
      return {
        status: 302, headers: {
          get: (h) => (h === 'location' ? 'https://go.jetsmart.com/es-ar/ja/ok' : null),
          getSetCookie: () => ['laravel_session=NUEVA; path=/; httponly'],
        }, text: async () => '',
      };
    }
    if (u.includes('/ok')) {
      return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => 'listo' };
    }
    return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => FORM };
  };

  const cookies = await login();
  assert.equal(cookies.laravel_session, 'NUEVA', 'devuelve la sesion autenticada');
  assert.match(posteado, /username=yo%40ejemplo\.com/, 'manda el usuario');
  assert.match(posteado, /rememberMe=on/, 'pide la sesion SSO mas larga');

  // Credenciales malas: Keycloak devuelve el mismo form. No puede pasar por exito.
  globalThis.fetch = async () => ({
    status: 200, headers: { get: () => null, getSetCookie: () => [] },
    text: async () => FORM + '<span class="kc-feedback-text">Usuario o contraseña inválidos</span>',
  });
  await assert.rejects(() => login(), /rechaz/i, 'credenciales malas => LoginError, no exito mudo');

  globalThis.fetch = orig;
  process.env = limpio;
}

// --- withSession: una sesion muerta se reloguea y reintenta, sin rebotar ---
{
  const { withSession } = await import('./src/session.js');
  const { SessionExpiredError } = await import('./src/session.js');
  const limpio = { ...process.env };
  const orig = globalThis.fetch;

  process.env.AYCF_EMAIL = 'yo@ejemplo.com';
  process.env.AYCF_PASSWORD = 'secreto';
  process.env.AYCF_COOKIE = 'laravel_session=MUERTA';

  const FORM = '<form id="kc-form-login" action="https://x/auth"></form>';
  globalThis.fetch = async (url, opt = {}) => {
    if (opt.method === 'POST') return {
      status: 302,
      headers: { get: (h) => (h === 'location' ? 'https://go.jetsmart.com/ok' : null),
                 getSetCookie: () => ['laravel_session=FRESCA'] },
      text: async () => '',
    };
    return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => FORM };
  };

  const store = memStore();
  let intentos = 0;
  const out = await withSession(store, (s) => {
    intentos++;
    if (intentos === 1) throw new SessionExpiredError('vencida');
    return s.header();
  });
  assert.equal(intentos, 2, 'reintenta una vez');
  assert.match(out, /laravel_session=FRESCA/, 'reintenta con la sesion nueva');

  // Si vuelve a fallar, NO reintenta de nuevo: seria loop de logins.
  let n = 0;
  await assert.rejects(
    () => withSession(store, () => { n++; throw new SessionExpiredError('vencida'); }),
    /inutilizable/, 'no reintenta infinito');
  assert.equal(n, 2, 'un solo reintento');

  globalThis.fetch = orig;
  process.env = limpio;
}

console.log('✅ todo ok');
