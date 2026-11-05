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
  const sess = { header: () => 'x', absorb: async () => false, passId: 'pase-de-prueba' };
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
  const session = { header: () => 'x', passId: 'pase-de-prueba' };
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
  const session = { header: () => 'x', passId: 'pase-de-prueba' };
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
  await assert.rejects(() => login(), /credenciales/, 'sin credenciales, error claro');

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
    // Ojo: la pagina POST-redirect NO puede traer el form, o login() cree que fallo.
    if (String(url).includes('/ok')) {
      return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => 'listo' };
    }
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

// --- multiusuario: cada chat con SU cuenta, sin pisarse ---
{
  const limpio = { ...process.env };
  process.env.SECRET_KEY = 'clave-de-prueba-larga';
  process.env.TELEGRAM_CHAT_ID = '111';
  const { encrypt, decrypt } = await import('./src/crypto.js');
  assert.equal(decrypt(encrypt('secreto con ñ y espacios')), 'secreto con ñ y espacios');
  assert.ok(!encrypt('hola').includes('hola'), 'la contraseña no queda en claro');

  const { scoped, saveUser, getUser, deleteUser, listUsers, usaSemilla, estaConectado } =
    await import('./src/users.js');
  const base = memStore();

  await saveUser(base, '222', { email: 'a@b.com', password: 'pw', passId: 'p-222' });
  await saveUser(base, '333', { email: 'c@d.com', password: 'pw2', passId: 'p-333' });

  const u222 = await getUser(base, '222');
  assert.equal(u222.password, 'pw', 'se descifra al leerla');
  assert.equal(u222.passId, 'p-222');
  assert.equal(estaConectado(u222), true);
  assert.equal((await getUser(base, '999')), null, 'un chat desconocido no es usuario');

  // Aislamiento: las claves de uno no las ve el otro, pero el catalogo es comun.
  const a = scoped(base, '222');
  const b = scoped(base, '333');
  await a.set('watches', [{ from: 'AEP', to: 'SLA' }]);
  await b.set('watches', [{ from: 'BRC', to: 'EZE' }]);
  assert.equal((await a.get('watches'))[0].to, 'SLA');
  assert.equal((await b.get('watches'))[0].to, 'EZE', 'no se pisan');
  await a.set('catalog:routes', { aeropuertos: { AEP: 'Aeroparque' }, rutas: [] });
  assert.ok(await b.get('catalog:routes'), 'el catalogo de la red es compartido');

  // La semilla WATCHES es del dueño del deploy, no de todos.
  assert.equal(usaSemilla({ chatId: '111' }), true, 'el dueño hereda WATCHES');
  assert.equal(usaSemilla({ chatId: '222' }), false, 'un usuario cualquiera NO');
  const { resolveWatches } = await import('./src/config.js');
  process.env.WATCHES = JSON.stringify([{ from: 'AEP', to: 'SLA' }]);
  assert.deepEqual(await resolveWatches(memStore(), undefined, { seed: false }), [],
    'usuario nuevo arranca sin rutas ajenas');
  delete process.env.WATCHES;

  // Baja: se va la cuenta y tambien la sesion guardada.
  await a.set('session:cookies', { laravel_session: 'x' });
  await deleteUser(base, '222');
  assert.equal(await getUser(base, '222'), null);
  assert.equal(await a.get('session:cookies'), null, 'la sesion no sobrevive a la baja');
  assert.equal((await listUsers(base)).length, 1, 'queda solo el otro');

  process.env = limpio;
}

// --- un usuario sin cuenta no puede consultar el pase de nadie ---
{
  const { NECESITA_SESION } = await import('./src/commands.js');
  const { estaConectado } = await import('./src/users.js');
  assert.ok(NECESITA_SESION.includes('/buscar'), '/buscar necesita cuenta');
  assert.equal(estaConectado(null), false);
  assert.equal(estaConectado({ email: 'a@b.com' }), false, 'sin pase no alcanza');
  assert.equal(estaConectado({ email: 'a@b.com', passId: 'x' }), true);
}

// --- sin comandos ni codigos: la gente escribe cualquier cosa ---
{
  const { comandoDe, handleCallback } = await import('./src/commands.js');
  const conectado = { chatId: '1', email: 'a@b.com', passId: 'x' };

  assert.equal(comandoDe('/rutas', conectado).cmd, '/rutas');
  assert.equal(comandoDe('/Buscar@mibot AEP SLA', conectado).cmd, '/buscar', 'mayusculas y @bot');
  assert.equal(comandoDe('mia@mail.com miclave', null).cmd, '/conectar', 'mail + pass = alta');
  assert.deepEqual(comandoDe('mia@mail.com miclave', null).args, ['mia@mail.com', 'miclave']);
  assert.equal(comandoDe('bariloche salta', conectado).cmd, '/buscar', 'texto suelto busca');
  assert.equal(comandoDe('hola', null).cmd, '/start', 'sin cuenta, todo lleva al alta');

  // Los botones tienen que caber en los 64 bytes de callback_data de Telegram.
  const store = memStore();
  store.name = 'memory';
  await store.set('catalog:routes', {
    aeropuertos: { BRC: 'Bariloche', AEP: 'Aeroparque', SLA: 'Salta' },
    rutas: ['BRC-AEP', 'AEP-SLA'],
  });
  const menu = await handleCallback('menu', { store, user: conectado, chatId: '1' });
  const datos = menu.buttons.flat().map((b) => b.data);
  assert.ok(datos.includes('o:BRC'), 'un boton por aeropuerto');
  assert.ok(datos.every((d) => Buffer.byteLength(d) <= 64), 'callback_data entra en 64 bytes');

  const destinos = await handleCallback('o:BRC', { store, user: conectado, chatId: '1' });
  assert.match(destinos.text, /Bariloche/);
  assert.ok(destinos.buttons.flat().some((b) => b.data === 'a:BRC:AEP'));

  const agregada = await handleCallback('a:BRC:AEP', { store, user: conectado, chatId: '1' });
  assert.match(agregada.text, /Agregada/);
  assert.ok(agregada.buttons.flat().length, 'no deja al usuario en un callejon');
  assert.equal((await store.get('watches')).length, 1, 'el boton guarda de verdad');

  // Cada rama del callback con los MISMOS argumentos que le pasa el webhook: un
  // parámetro de menos acá salía por Telegram como "Cannot read properties of
  // undefined (reading 'length')" y no lo veía ningún test.
  const sesionFalsa = { header: () => 'x', passId: 'p', absorb: async () => false };
  const ctx = { store, session: sesionFalsa, user: conectado, chatId: '1' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { getSetCookie: () => [] },
    text: async () => JSON.stringify({ content: { flights: { flightsOutbound: [] } } }),
  });
  for (const data of ['menu', 'o:BRC', 'a:BRC:AEP', 's:BRC:AEP', 'rutas']) {
    const r = await handleCallback(data, ctx);
    assert.ok(r?.text, `el callback ${data} contesta algo`);
    assert.ok(!/undefined|Cannot read/.test(r.text), `el callback ${data} no explota: ${r.text}`);
  }
  globalThis.fetch = origFetch;

  // Un bug interno no puede salir por Telegram como un TypeError crudo.
  const roto = await handleCallback('o:NOEXISTE', { store, user: conectado, chatId: '1' });
  assert.ok(!/Cannot read propert/i.test(roto.text ?? ''), 'los TypeError se traducen');

}


// --- la pasada de rescate avisa la liberación a quien le falló la de las 00:01 ---
{
  const store = memStore();
  const session = { header: () => 'x', passId: 'pase-de-prueba' };
  const watches = [{ from: 'AEP', to: 'COR', minSeats: 1 }];
  const orig = globalThis.fetch;
  const avisos = [];
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('api.telegram.org')) avisos.push(JSON.parse(opt.body).text);
    return { ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } };
  };
  process.env.TELEGRAM_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = 'y';
  const pasada = () => runSweep({
    date: '2026-07-29', watches, store, session, release: false, _search: async () => [],
  });

  await pasada();
  assert.equal(avisos.length, 0, 'una pasada común sin cupo no avisa');

  // La corrida de las 00:01 falló y dejó la bandera: esta pasada hace de liberación.
  await store.set('release-pending', '2026-07-29');
  await pasada();
  assert.equal(avisos.length, 1, 'la pasada de rescate avisa aunque no haya cupo');
  assert.match(avisos[0], /LIBERACIÓN/, 'con el formato de la liberación');
  assert.equal(await store.get('release-pending'), null, 'y limpia la bandera');

  // Una bandera de otra fecha es basura vieja, no dispara nada.
  await store.set('release-pending', '2026-07-28');
  await pasada();
  assert.equal(avisos.length, 1, 'bandera de otra fecha: silencio');

  globalThis.fetch = orig;
}

// --- si el barrido muere a mitad, lo visto antes NO queda marcado ---
{
  const store = memStore();
  const session = { header: () => 'x', passId: 'pase-de-prueba' };
  const watches = [{ from: 'AEP', to: 'COR' }, { from: 'BRC', to: 'EZE' }];
  const explota = async (_s, { from }) => {
    if (from === 'BRC') throw new Error('Caravelo respondió 504');
    return [V];
  };
  await assert.rejects(() => runSweep({
    date: '2026-07-29', watches, store, session, notify: false, release: false, _search: explota,
  }), /504/);
  assert.equal(await store.get(dedupeKey('2026-07-29', watches[0], V)), null,
    'el vuelo de la ruta 1 no quedó como visto: nadie lo recibió');
}

// --- la corrida de la liberación que falla deja la bandera para el rescate ---
{
  const { runRadar } = await import('./src/radar.js');
  const { createStore } = await import('./src/store.js');
  const { rm } = await import('node:fs/promises');
  const limpio = { ...process.env };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } });
  process.env.TELEGRAM_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = 'y';
  delete process.env.AYCF_COOKIE; delete process.env.AYCF_EMAIL; delete process.env.AYCF_PASSWORD; delete process.env.AYCF_PASS_ID;
  const RUTAS = JSON.stringify([{ from: 'AEP', to: 'COR' }]);

  process.env.STATE_FILE = '/tmp/aycf-test-rescate-1.json';
  await rm(process.env.STATE_FILE, { force: true });
  const falla = await runRadar({ watchesRaw: RUTAS, release: true });
  assert.equal(falla.error, 'session-expired', 'sin credenciales la corrida falla');
  assert.equal(await createStore().get('release-pending'), tomorrowInAR(),
    'la liberación fallida deja la bandera con la fecha buscada');

  process.env.STATE_FILE = '/tmp/aycf-test-rescate-2.json';
  await rm(process.env.STATE_FILE, { force: true });
  await runRadar({ watchesRaw: RUTAS, release: false });
  assert.equal(await createStore().get('release-pending'), null,
    'una corrida común que falla no deja bandera');

  globalThis.fetch = orig;
  process.env = limpio;
}

// --- /usuarios: el dueño ve quién usa el bot; para los demás no existe ---
{
  const { handleCommand } = await import('./src/commands.js');
  const { saveUser, scoped, nombreDe } = await import('./src/users.js');
  const limpio = { ...process.env };
  delete process.env.AYCF_EMAIL; delete process.env.AYCF_PASS_ID;
  process.env.TELEGRAM_CHAT_ID = '1';

  assert.equal(nombreDe({ username: 'juan_p', first_name: 'Juan' }), '@juan_p', 'el @ manda');
  assert.equal(nombreDe({ first_name: 'Juan', last_name: 'Pérez' }), 'Juan Pérez');
  assert.equal(nombreDe(undefined), null);

  const base = memStore();
  base.name = 'memory';
  const juan = await saveUser(base, '2', { email: 'juan_perez@mail.com', passId: 'p2', nombre: '@juan_p' });
  assert.ok(juan.createdAt, 'el alta queda fechada');
  const otraVez = await saveUser(base, '2', { passId: 'p2b' });
  assert.equal(otraVez.createdAt, juan.createdAt, 'la fecha de alta no se pisa');
  assert.equal(otraVez.nombre, '@juan_p', 'el nombre tampoco');
  await scoped(base, '2').set('watches', [{ from: 'AEP', to: 'COR' }]);

  const dueno = { store: scoped(base, '1'), user: { chatId: '1' }, chatId: '1' };
  const lista = await handleCommand('/usuarios', dueno);
  assert.match(lista, /1 usuario/);
  assert.match(lista, /juan_p/);
  assert.match(lista, /juan_perez@mail\.com/);
  assert.match(lista, /1 ruta/);
  assert.doesNotMatch(lista, /p2b/, 'el pase no se lista');

  const otro = { store: scoped(base, '2'), user: otraVez, chatId: '2' };
  assert.match(await handleCommand('/usuarios', otro), /No conozco/, 'para los demás el comando no existe');
  assert.match(await handleCommand('/ayuda', dueno), /\/usuarios/, 'el dueño lo ve en la ayuda');
  assert.doesNotMatch(await handleCommand('/ayuda', otro), /\/usuarios/);

  process.env = limpio;
}

// --- precalentado de las 23:55: loguea a todos y avisa SOLO si no puede ---
{
  const { default: warmup } = await import('./api/reminder.js');
  const { createStore } = await import('./src/store.js');
  const { saveUser, scoped } = await import('./src/users.js');
  const { rm } = await import('node:fs/promises');
  const limpio = { ...process.env };
  const orig = globalThis.fetch;
  process.env.SECRET_KEY = 'clave-de-prueba-larga';
  process.env.TELEGRAM_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = '1';
  delete process.env.CRON_SECRET; delete process.env.AYCF_EMAIL; delete process.env.AYCF_PASS_ID;
  process.env.STATE_FILE = '/tmp/aycf-test-warmup.json';
  await rm(process.env.STATE_FILE, { force: true });

  const base = createStore();
  await saveUser(base, '7', { email: 'ana@mail.com', password: 'secreto', passId: 'p7' });
  await scoped(base, '7').set('watches', [{ from: 'AEP', to: 'COR' }]);
  const res = () => ({ status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const avisos = [];

  // Keycloak no contesta: hay que avisarle a Ana que en 6 minutos se libera y no entro.
  globalThis.fetch = async (url, opt = {}) => {
    if (String(url).includes('api.telegram.org')) {
      avisos.push(JSON.parse(opt.body));
      return { ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } };
    }
    throw new Error('fetch failed');
  };
  const caido = await warmup({ headers: {} }, res());
  assert.equal(caido.body.users.length, 1);
  assert.equal(caido.body.users[0].viva, false);
  assert.equal(avisos.length, 1, 'avisa cuando no puede entrar');
  assert.equal(String(avisos[0].chat_id), '7', 'al chat de Ana, no al del dueño');
  assert.match(avisos[0].text, /no puedo entrar/i);

  // Login OK: sesión fresca guardada y ni un mensaje.
  const FORM = '<form id="kc-form-login" action="https://x/auth"></form>';
  globalThis.fetch = async (url, opt = {}) => {
    if (String(url).includes('api.telegram.org')) { avisos.push(JSON.parse(opt.body)); return { ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } }; }
    if (opt.method === 'POST') return {
      status: 302, text: async () => '',
      headers: { get: (h) => (h === 'location' ? 'https://go.jetsmart.com/ok' : null), getSetCookie: () => ['laravel_session=FRESCA'] },
    };
    if (String(url).includes('/ok')) return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => 'listo' };
    return { status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => FORM };
  };
  const vivo = await warmup({ headers: {} }, res());
  assert.equal(vivo.body.users[0].viva, true);
  assert.equal(avisos.length, 1, 'si entró, silencio: nadie quiere un mensaje a las 23:55 para decir que todo anda');
  assert.match((await scoped(base, '7').get('session:cookies'))?.laravel_session ?? '', /FRESCA/,
    'la sesión fresca queda guardada para las 00:01');

  globalThis.fetch = orig;
  process.env = limpio;
}

// --- pedidos: modelo, store y lock ---
{
  const { rm } = await import('node:fs/promises');
  const { newOrder, validateOrder, saveOrder, getOrder, listOrders, setEstado, ordersDueTonight, lockOrder, unlockOrder, formatPedido } = await import('./src/orders.js');
  const { createStore } = await import('./src/store.js');
  const { scoped } = await import('./src/users.js');
  const limpio = { ...process.env };
  process.env.STATE_FILE = '/tmp/aycf-test-orders.json'; await rm(process.env.STATE_FILE, { force: true });
  const store = scoped(createStore(), '1');

  assert.throws(() => validateOrder({ fechaVuelo: '08/11/2026', tramos: [{ from: 'BRC', to: 'AEP' }] }), /YYYY-MM-DD/);
  assert.throws(() => validateOrder({ fechaVuelo: '2026-11-08', tramos: [] }), /tramo/);
  assert.throws(() => validateOrder({ fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'EZE', to: 'COR' }] }), /encaden/,
    'el segundo tramo tiene que salir de donde llegó el primero (AEP≠EZE se declara, no se adivina)');
  const o = newOrder({ chatId: '1', fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'AEP', to: 'COR' }] });
  assert.match(o.id, /^ord_[0-9a-f]{10}$/); assert.equal(o.estado, 'borrador');
  assert.equal(o.escalaMinimaHoras, 2.5); assert.equal(o.topeTasasPorTramoARS, 40000);
  assert.equal(formatPedido(o, { hoy: '2026-11-05' }), '📌 *Pedido* · domingo 08/11 · BRC → AEP (cualquier horario) · AEP → COR, escala ≥ 2,5 h · lo busco el sábado 07/11 a las 00:00');

  await saveOrder(store, o);
  assert.equal((await getOrder(store, o.id)).fechaVuelo, '2026-11-08');
  assert.equal((await ordersDueTonight(store, '2026-11-08')).length, 0, 'un borrador no se compra');
  await setEstado(store, o.id, 'confirmado');
  assert.equal((await ordersDueTonight(store, '2026-11-08')).length, 1);
  assert.equal((await ordersDueTonight(store, '2026-11-09')).length, 0);
  await setEstado(store, o.id, 'fallido', { intento: { hora: 'x', paso: 'quotation', error: 'boom' } });
  assert.equal((await getOrder(store, o.id)).intentos.length, 1);
  assert.equal((await listOrders(store, { estados: ['fallido'] })).length, 1);

  assert.equal(await lockOrder(store, o.id, 60), true);
  assert.equal(await lockOrder(store, o.id, 60), false, 'el segundo cron no entra');
  await unlockOrder(store, o.id);
  assert.equal(await lockOrder(store, o.id, 60), true);
  await unlockOrder(store, o.id);

  // Lock con dueño: otra corrida no lo puede soltar ni renovar.
  const { renovarLock } = await import('./src/orders.js');
  assert.equal(await lockOrder(store, o.id, 60, 'run-A'), true);
  assert.equal(await unlockOrder(store, o.id, 'run-B'), false, 'un dueño ajeno no suelta el lock');
  assert.equal(await lockOrder(store, o.id, 60, 'run-B'), false, 'el lock sigue puesto');
  assert.equal(await renovarLock(store, o.id, 'run-B', 60), false);
  assert.equal(await renovarLock(store, o.id, 'run-A', 900), true);
  assert.equal(await unlockOrder(store, o.id, 'run-A'), true);
  assert.equal(await lockOrder(store, o.id, 60, 'run-B'), true, 'el dueño sí lo suelta');
  await unlockOrder(store, o.id);

  await assert.rejects(() => setEstado(store, o.id, 'comprando'), /estado desconocido/);
  await setEstado(store, o.id, 'parcial', { id: 'ord_x', chatId: '9', fechaVuelo: '2030-01-01', resultado: 'ok' });
  const p = await getOrder(store, o.id);
  assert.deepEqual([p.id, p.chatId, p.fechaVuelo, p.resultado], [o.id, '1', '2026-11-08', 'ok'], 'extra no pisa la identidad');

  // RedisStore.setnx: SET key val EX ttl NX, y OK/null se traducen a true/false.
  const orig = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'; process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  const { createStore: createRedis } = await import('./src/store.js?redis-setnx');
  const respuestas = [{ result: 'OK' }, { result: null }]; const cuerpos = [];
  globalThis.fetch = async (url, opt) => { cuerpos.push(JSON.parse(opt.body)); return { ok: true, json: async () => respuestas.shift() }; };
  try {
    const redis = createRedis();
    assert.equal(redis.name, 'redis');
    assert.equal(await redis.setnx('k', { a: 1 }, 60), true);
    assert.equal(await redis.setnx('k', { a: 1 }, 60), false);
    assert.deepEqual(cuerpos[0], ['SET', 'k', '{"a":1}', 'EX', '60', 'NX']);
    respuestas.push({ result: 1 });
    await unlockOrder(scoped(redis, '1'), 'ord_abc');
    assert.deepEqual(cuerpos[2], ['DEL', 'u:1:order-lock:ord_abc']);
  } finally { globalThis.fetch = orig; process.env = limpio; }
}

// --- itinerario: ventana, escala, escasez y tope ---
{
  const { chooseItinerary, ordenDeCompra, superaTope, enVentana, escalaMinima } = await import('./src/itinerary.js');
  const v = (code, from, to, dep, arr, seats, taxes = 15103.85) => ({ code, from, to, departsAt: `2026-11-08 ${dep}:00`, arrivesAt: `2026-11-08 ${arr}:00`, departsHHMM: dep, seats, taxes });
  const order = { fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'AEP', to: 'COR' }], escalaMinimaHoras: 2.5, preferencia: 'cualquier horario', topeTasasPorTramoARS: 40000 };

  const brc = [v('JA3100', 'BRC', 'AEP', '06:00', '08:10', 2), v('JA3106', 'BRC', 'AEP', '19:40', '21:50', 6)];
  const cor = [v('JA3020', 'AEP', 'COR', '09:30', '10:50', 1), v('JA3024', 'AEP', 'COR', '15:00', '16:20', 3)];
  const it = chooseItinerary(order, [brc, cor]);
  assert.deepEqual(it.tramos.map((f) => f.code), ['JA3100', 'JA3024'], '06:00+2:10+2,5h > 09:30 → descarta el de las 09:30; el de las 19:40 no deja nada');
  assert.equal(it.faltan, undefined);
  assert.deepEqual(ordenDeCompra(it), [0, 1].sort((a, b) => it.tramos[a].seats - it.tramos[b].seats), 'primero el escaso');

  const soloIda = chooseItinerary(order, [brc, []]);
  assert.deepEqual(soloIda.tramos.map((f) => f.code), ['JA3106'], 'sin segundo tramo, el primero es libre: cualquier horario → el que sale más tarde');
  assert.deepEqual(soloIda.faltan, [1]);

  assert.equal(chooseItinerary(order, [[], cor]).tramos.length, 0, 'sin el primero no hay parcial: el segundo solo no sirve');
  assert.equal(enVentana(v('x', 'A', 'B', '08:00', '09:00', 1), ['06:00', '12:00']), true);
  assert.equal(enVentana(v('x', 'A', 'B', '13:00', '14:00', 1), ['06:00', '12:00']), false);
  assert.equal(escalaMinima({ ...order, tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'EZE', to: 'COR' }] }, 1), 4, 'AEP→EZE son dos aeropuertos');
  assert.equal(superaTope(v('x', 'A', 'B', '08:00', '09:00', 1, 133324), order), true);
  assert.equal(superaTope(v('x', 'A', 'B', '08:00', '09:00', 1, 15103.85), order), false);

  // Extras: sin cupo, preferencias, vuelo que cruza medianoche y escala del tramo 0.
  assert.equal(escalaMinima(order, 0), 0);
  const sinCupo = chooseItinerary(order, [[v('Z', 'BRC', 'AEP', '06:00', '08:10', 0)], cor]);
  assert.deepEqual([sinCupo.tramos.length, sinCupo.faltan], [0, [0, 1]], 'seats 0 no se compra');
  const todo = chooseItinerary({ ...order, preferencia: 'lo más temprano posible' }, [[...brc, v('JA3102', 'BRC', 'AEP', '05:00', '07:10', 4)], [...cor, v('JA3030', 'AEP', 'COR', '20:00', '21:20', 5)]]);
  assert.equal(todo.tramos[0].code, 'JA3102', 'más temprano = sale primero el primer tramo');
  const tarde = chooseItinerary({ ...order, preferencia: 'lo más tarde posible' }, [[...brc, v('JA3104', 'BRC', 'AEP', '12:00', '14:10', 3)], [v('JA3030', 'AEP', 'COR', '23:30', '23:59', 5)]]);
  assert.equal(tarde.tramos[0].code, 'JA3104', 'más tarde posible: el último primer tramo que todavía conecta (el de las 19:40 ya no)');
  const noche = { ...v('N', 'BRC', 'AEP', '22:04', '00:11', 2), arrivesAt: '2026-11-09 00:11:00' };
  const dia = { ...v('D', 'AEP', 'COR', '01:00', '02:00', 2), departsAt: '2026-11-09 01:00:00', arrivesAt: '2026-11-09 02:00:00' };
  assert.equal(chooseItinerary(order, [[noche], [dia]]).tramos.length, 1, 'llega 00:11 + 2,5 h > 01:00 del día siguiente');
  const margen = chooseItinerary(order, [[brc[0]], [cor[1], v('JA3026', 'AEP', 'COR', '12:00', '13:20', 2)]]);
  assert.equal(margen.tramos[1].code, 'JA3024', 'cualquier horario con varios tramos: más margen total');
}

// --- compra: requests a Caravelo y Spreedly con la forma relevada ---
{
  const { quote, initPayment, tokenizeCard, doPurchase, listBookings, hayReserva } = await import('./src/purchase.js');
  const session = { passId: 'PASS', header: () => 'laravel_session=S', absorb: async () => false };
  const calls = []; const json = (b, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json', getSetCookie: () => [] }, text: async () => JSON.stringify(b) });
  const f = (resp) => async (url, opt = {}) => { calls.push({ url: String(url), method: opt.method ?? 'GET', headers: opt.headers, body: opt.body }); return resp; };
  const flight = { key: 'K', fareSellKey: 'FK', from: 'SLA', to: 'EZE', departsAt: '2026-11-06 22:04:00', code: 'JA3021' };

  const q = await quote(session, flight, { _fetch: f(json({ pricingBreakdown: [{ description: 'Tasa', amount: '6,500.00', code: 'TQ' }], total: { qty: 15103.85, text: 'ARS 15103.85' } })) });
  assert.equal(q.total, 15103.85);
  assert.match(calls.at(-1).url, /\/json\/PASS\/quotation$/);
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.outboundKey, 'K'); assert.equal(body.referenceOutbound, 'K'); assert.equal(body.outboundFareSellKey, 'FK'); assert.equal(body.departure, '2026-11-06 22:04:00'); assert.equal(body.inboundKey, null);

  const init = await initPayment(session, { _fetch: f(json({ paymentGateway: 'spreedly', additionalData: { certificateToken: 'C', signature: 'S', nonce: 'N', timestamp: '1' } })) });
  assert.deepEqual(init, { certificateToken: 'C', signature: 'S', nonce: 'N', timestamp: '1' });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { type: 'INIT', paymentGateway: 'spreedly' });

  const card = { number: '4111111111111111', month: '12', year: '2030', cvv: '123', holder: 'RAMIRO FAZIO' };
  const tok = await tokenizeCard(card, init, { _fetch: f(json({ transaction: { payment_method: { token: 'TOK' } } })) });
  assert.equal(tok, 'TOK');
  assert.match(calls.at(-1).url, /core\.spreedly\.com\/v1\/payment_methods\.json$/);
  const sp = JSON.parse(calls.at(-1).body);
  assert.equal(sp.payment_method.credit_card.number, card.number); assert.equal(sp.certificate_token, 'C'); assert.equal(sp.signature, 'S');
  assert.ok(!calls.at(-1).headers.cookie, 'a Spreedly no va la cookie de Caravelo');

  const ok = await doPurchase(session, { token: 'TOK', card, quotation: q }, { _fetch: f({ ok: true, status: 200, headers: { get: () => 'text/html', getSetCookie: () => [] }, text: async () => '<h1>Compra confirmada</h1> PNR ABC123' }) });
  assert.equal(ok.ok, true);
  assert.match(calls.at(-1).url, /\/PASS\/do-purchase$/);
  assert.match(calls.at(-1).body, /payment-method-token=TOK/); assert.match(calls.at(-1).body, /txvariant=card/);
  assert.ok(!calls.at(-1).body.includes(card.number), 'el número de tarjeta nunca va a Caravelo');

  const rechazo = await doPurchase(session, { token: 'TOK', card, quotation: q }, { _fetch: f(json({ content: { exceptionMessage: 'payment.declined' } }, 402)) });
  assert.equal(rechazo.ok, false); assert.equal(rechazo.motivo, 'rechazada');

  await assert.rejects(() => quote(session, flight, { _fetch: f(json({ redirectUri: '/login' })) }), /sesión/);

  const bk = await listBookings(session, { _fetch: f(json({ content: { content: [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-06', from: 'SLA', to: 'EZE' }] } })) });
  assert.equal(bk[0].pnr, 'ABC123');
  assert.equal(hayReserva(bk, { code: 'JA3021', departsAt: '2026-11-06 22:04:00' }), true);
  assert.equal(hayReserva(bk, { code: 'JA3100', departsAt: '2026-11-06 06:00:00' }), false);
}

// --- compra: arreglos de la revisión (éxito positivo, redirects, total, reservas) ---
{
  const { quote, doPurchase, listBookings, hayReserva } = await import('./src/purchase.js');
  const { SessionExpiredError } = await import('./src/session.js');
  const seen = [];
  const session = { passId: 'PASS', header: () => 'laravel_session=S', absorb: async () => false };
  const R = (status, text, headers = {}) => async (url, opt = {}) => {
    seen.push({ url: String(url), opt });
    return { ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => [] }, text: async () => (typeof text === 'string' ? text : JSON.stringify(text)) };
  };
  const card = { number: '4111111111111111', month: '12', year: '2030', cvv: '987', holder: 'RAMIRO FAZIO' };
  const buy = (fetcher) => doPurchase(session, { token: 'TOK', card, quotation: {} }, { _fetch: fetcher });

  assert.equal((await buy(R(200, { success: false }))).motivo, 'desconocido', '2xx sin señal positiva no es éxito');
  assert.equal((await buy(R(200, '<p>No hay asientos disponibles</p>'))).motivo, 'desconocido', '2xx nunca es sin-cupo');
  assert.equal((await buy(R(409, '<p>No hay asientos disponibles</p>'))).motivo, 'sin-cupo');
  const conScript = await buy(R(200, '<script>var e="payment declined"</script><h1>Compra confirmada</h1> PNR ABC123'));
  assert.equal(conScript.ok, true); assert.equal(conScript.pnr, 'ABC123');
  assert.equal((await buy(R(200, '<p>Vuelo JA3021 confirmado. PNR ABC123</p>'))).pnr, 'ABC123');
  assert.equal((await buy(R(200, 'COMPRA CONFIRMADA ... ABC123'))).pnr, 'ABC123');
  assert.equal((await buy(R(200, 'compra no confirmada JA3021'))).motivo, 'desconocido');
  const conf = await buy(R(200, '<h1>Reserva confirmada</h1> Código ABC123'));
  assert.equal(conf.ok, true); assert.equal(conf.pnr, 'ABC123');
  assert.equal((await buy(R(200, { pnr: 'XYZ789' }))).pnr, 'XYZ789');
  await assert.rejects(() => buy(R(302, '', { location: 'https://go.jetsmart.com/auth/realms/x/protocol/openid-connect/auth' })), SessionExpiredError);
  const bank = await buy(R(302, '', { location: 'https://acs.bank.com/challenge' }));
  assert.equal(bank.motivo, '3ds'); assert.match(bank.raw, /acs\.bank\.com/);
  assert.equal((await buy(R(302, '', { location: '/es-ar/ja/subscriptions/confirmation' }))).motivo, 'desconocido');
  // redirectUri que no es login no es sesión muerta
  assert.equal((await buy(R(200, { redirectUri: '/es-ar/ja/subscriptions/thanks' }))).motivo, 'desconocido');

  const flight = { key: 'K', fareSellKey: 'FK', from: 'SLA', to: 'EZE', departsAt: '2026-11-06 22:04:00', code: 'JA3021' };
  assert.equal((await quote(session, flight, { _fetch: R(200, { total: { qty: 15103.85 } }) })).total, 15103.85);
  await assert.rejects(() => quote(session, flight, { _fetch: R(200, { total: { text: '' } }) }), /cotización sin total/);

  await assert.rejects(() => listBookings(session, { _fetch: R(200, '<html><form>Ingresá tu usuario</form></html>', {}) }), /bookings-unavailable/);
  const filas = await listBookings(session, { _fetch: R(200, '<table><tr><td>ABC123</td><td>JA3021</td><td>06/11/2026</td></tr></table>') });
  assert.deepEqual(filas, [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-06' }]);
  assert.equal(hayReserva(filas, { code: 'JA3021', departsAt: '2026-11-06 22:04:00' }), true);
  assert.deepEqual(await listBookings(session, { _fetch: R(200, '<h2>Mis reservas</h2><p>Nada</p>') }), []);

  seen.length = 0;
  await buy(R(200, { success: false }));
  const c = seen.at(-1);
  for (const k of ['month=12', 'year=2030', 'full_name=RAMIRO', 'payment_method_reference=']) assert.ok(c.opt.body.includes(k), k);
  assert.ok(!c.opt.body.includes('987'), 'el cvv no va a Caravelo');
  assert.ok(c.opt.headers['user-agent'] && c.opt.headers.cookie && c.opt.signal, 'UA, cookie y timeout');
}

// --- buy: loop 00:00–00:15, parcial, dudoso, tope ---
{
  const { rm } = await import('node:fs/promises');
  const { runBuy, deadlineAR, formatCompra } = await import('./src/buy.js');
  const { unlockOrder } = await import('./src/orders.js');
  const { newOrder, saveOrder, setEstado, getOrder, lockOrder } = await import('./src/orders.js');
  const { createStore } = await import('./src/store.js');
  const { scoped } = await import('./src/users.js');
  const { SessionExpiredError } = await import('./src/session.js');
  const limpio = { ...process.env };
  process.env.STATE_FILE = '/tmp/aycf-test-buy.json'; await rm(process.env.STATE_FILE, { force: true });
  const store = scoped(createStore(), '1');

  assert.equal(deadlineAR('00:15', new Date('2026-11-08T03:00:00Z')), Date.parse('2026-11-08T03:15:00Z'));
  assert.equal(deadlineAR('00:15', new Date('2026-11-08T03:20:00Z')), Date.parse('2026-11-08T03:15:00Z'), 'si ya pasó, el mismo instante de hoy');

  const v = (code, from, to, dep, arr, seats, taxes = 15103.85) => ({ code, from, to, departsAt: `2026-11-08 ${dep}:00`, arrivesAt: `2026-11-08 ${arr}:00`, departsHHMM: dep, arrivesHHMM: arr, seats, taxes });
  const IDA = v('JA3100', 'BRC', 'AEP', '06:00', '08:10', 2);
  const VUELTA = v('JA3024', 'AEP', 'COR', '15:00', '16:20', 3);
  const SLA = { ...v('JA3021', 'SLA', 'EZE', '22:04', '00:11', 4), arrivesAt: '2026-11-09 00:11:00' };
  const card = { number: '4111111111111111', month: '12', year: '2030', cvv: '987', holder: 'RAMIRO FAZIO' };

  // Pedido nuevo y confirmado en el store; dos tramos BRC→AEP→COR o uno SLA→EZE.
  const pedido = async (tramos = [{ from: 'BRC', to: 'AEP' }, { from: 'AEP', to: 'COR' }]) => {
    const o = newOrder({ chatId: '1', fechaVuelo: '2026-11-08', tramos });
    await saveOrder(store, o);
    return setEstado(store, o.id, 'confirmado');
  };
  // api falsa programable por llamada: cada clave es un valor o una función (args, n) → valor | Error.
  const fakeApi = (prog) => {
    const calls = { search: [], quote: [], initPayment: [], tokenizeCard: [], doPurchase: [], listBookings: [] };
    const api = {};
    for (const k of Object.keys(calls)) {
      api[k] = async (...args) => {
        calls[k].push(args);
        const p = prog[k];
        const r = await (typeof p === 'function' ? p(args, calls[k].length) : p);
        if (r instanceof Error) throw r;
        return r;
      };
    }
    return { api, calls };
  };
  const base = {
    quote: ([, f]) => ({ total: 15103.85, breakdown: [], code: f.code }),
    initPayment: { certificateToken: 'C', signature: 'S', nonce: 'N', timestamp: '1' },
    tokenizeCard: 'TOK',
  };
  const T0 = Date.parse('2026-11-08T03:00:05Z');
  const DEADLINE = Date.parse('2026-11-08T03:15:00Z');
  // `prog` puede ser una función del reloj, para mover la hora desde adentro de un fake.
  const correr = async (order, prog, extra = {}) => {
    const reloj = { t: T0 }; const sleeps = []; const msgs = [];
    const session = { relogins: 0, relogin: async function () { this.relogins++; return this; } };
    const { api, calls } = fakeApi({ ...base, ...(typeof prog === 'function' ? prog(reloj) : prog) });
    const r = await runBuy({
      order, store, session, chatId: '1', card, deadline: DEADLINE,
      now: () => reloj.t, sleep: async (ms) => { sleeps.push(ms); reloj.t += ms; },
      api, notify: async (text, chatId) => { msgs.push({ text, chatId }); return true; }, ...extra,
    });
    return { r, sleeps, msgs, calls, session };
  };
  const sinTarjeta = (x) => { const s = JSON.stringify(x); assert.ok(!s.includes(card.number) && !s.includes(card.cvv), 'la tarjeta no aparece en mensajes ni intentos'); };

  // 1) Caravelo muerto 3 vueltas, después hay cupo: compra los dos tramos.
  {
    const order = await pedido();
    let vueltas = 0;
    const { r, sleeps, msgs, calls } = await correr(order, {
      search: ([, tramo]) => {
        if (tramo.from === 'BRC') vueltas++;
        if (vueltas <= 3) return new Error('timeout');
        return tramo.from === 'BRC' ? [IDA] : [VUELTA];
      },
      doPurchase: ([, { quotation }]) => ({ ok: true, pnr: quotation.code === 'JA3100' ? 'ABC123' : 'DEF456', raw: '' }),
    });
    assert.equal(r.estado, 'comprado');
    assert.deepEqual(r.resultado.tramos.map((x) => [x.code, x.pnr]), [['JA3100', 'ABC123'], ['JA3024', 'DEF456']]);
    assert.deepEqual(Object.keys(r.resultado.tramos[0]).filter((k) => ['code', 'from', 'to', 'departsAt', 'pnr', 'tasas'].includes(k)).length, 6);
    assert.equal(r.resultado.tramos[0].tasas, 15103.85);
    assert.deepEqual(sleeps, [20000, 20000, 20000], 'tres vueltas con error = tres pausas de 20 s');
    assert.ok(sleeps.every((ms) => ms >= 10000), 'nunca menos de 10 s entre vueltas');
    assert.equal(calls.search.length, 3 + 2, 'una vuelta con error corta en el primer tramo: no hay ráfagas');
    assert.equal(calls.listBookings.length, 0);
    assert.equal(msgs.length, 1); assert.match(msgs[0].text, /ABC123/); assert.match(msgs[0].text, /DEF456/);
    assert.equal(msgs[0].chatId, '1');
    assert.equal(r.intentos.length, 3, 'cada timeout queda anotado');
    assert.deepEqual(Object.keys(r.intentos[0]).sort(), ['error', 'hora', 'paso']);
    assert.equal((await getOrder(store, order.id)).estado, 'comprado', 'el estado queda persistido');
    assert.equal(await lockOrder(store, order.id, 60), true, 'al salir suelta el lock');
    sinTarjeta([msgs, r]);
  }

  // 2) Sólo el primer tramo tiene cupo: compra ese y queda parcial, sin perseguir el otro.
  {
    const order = await pedido();
    const { r, msgs, calls, sleeps } = await correr(order, {
      search: ([, tramo]) => (tramo.from === 'BRC' ? [IDA] : []),
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(r.estado, 'parcial');
    assert.deepEqual(r.resultado.faltan, [1]);
    assert.deepEqual(r.resultado.tramos.map((x) => x.code), ['JA3100']);
    assert.equal(calls.doPurchase.length, 1);
    assert.equal(sleeps.length, 0, 'el parcial no se persigue');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].text, /AEP → COR/); assert.match(msgs[0].text, /Ramiro/); assert.match(msgs[0].text, /ABC123/);
  }

  // 3) do-purchase tira timeout y la reserva aparece: comprado, sin repagar.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, msgs, calls } = await correr(order, {
      search: [SLA],
      doPurchase: new Error('The operation was aborted due to timeout'),
      listBookings: [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-08' }],
    });
    assert.equal(r.estado, 'comprado');
    assert.equal(calls.doPurchase.length, 1, 'con la reserva a la vista no se vuelve a pagar');
    assert.equal(calls.listBookings.length, 1);
    assert.equal(r.resultado.tramos[0].pnr, 'ABC123', 'el PNR sale de la reserva');
    assert.equal(msgs[0].text, '✅ *Comprado* · JA3021 SLA 22:04 → EZE 00:11 · tasas ARS 15.103,85 · PNR ABC123');
    assert.equal(formatCompra(order, r.resultado), msgs[0].text);
  }

  // 4) do-purchase tira timeout y las reservas no se pueden leer: dudoso, mirar el mail.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, msgs, calls } = await correr(order, {
      search: [SLA],
      doPurchase: new Error('timeout'),
      listBookings: new Error('bookings-unavailable'),
    });
    assert.equal(r.estado, 'dudoso');
    assert.equal(calls.doPurchase.length, 1, 'sin poder verificar, jamás se reintenta el pago');
    assert.equal(msgs.length, 1); assert.match(msgs[0].text, /mail/);
    assert.equal((await getOrder(store, order.id)).estado, 'dudoso');
  }

  // 5) Las tasas cotizadas superan el tope: fallido por tope, sin tocar el pago.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, msgs, calls } = await correr(order, { search: [SLA], quote: { total: 133324, breakdown: [] } });
    assert.equal(r.estado, 'fallido'); assert.equal(r.motivo, 'tope');
    assert.equal(calls.initPayment.length, 0); assert.equal(calls.tokenizeCard.length, 0); assert.equal(calls.doPurchase.length, 0);
    assert.match(msgs[0].text, /No pude comprar/); assert.match(msgs[0].text, /133\.324/); assert.match(msgs[0].text, /40\.000/);
  }

  // 6) Nunca hay cupo: a las 00:15 se rinde con un solo mensaje.
  {
    const order = await pedido();
    const { r, msgs, sleeps, calls } = await correr(order, { search: [] });
    assert.equal(r.estado, 'fallido'); assert.equal(r.motivo, 'sin-cupo');
    assert.ok(r.intentos.length > 0);
    assert.equal(msgs.length, 1); assert.match(msgs[0].text, /No pude comprar/);
    assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms === 10000), 'vueltas vacías = 10 s');
    assert.ok(calls.search.length <= 2 * (sleeps.length + 1), 'un request por tramo por vuelta');
    assert.equal(calls.doPurchase.length, 0);
  }

  // 7) Otro proceso tiene el lock: no busca, no compra, no avisa.
  {
    const order = await pedido();
    assert.equal(await lockOrder(store, order.id, 60), true);
    const { r, msgs, calls } = await correr(order, { search: [IDA] });
    assert.deepEqual(r, { estado: 'confirmado' });
    assert.equal(calls.search.length, 0); assert.equal(msgs.length, 0);
  }

  // 8) Resultado desconocido y sin reserva: un solo reintento, con verificación en el medio.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const orden = [];
    const { r, calls } = await correr(order, {
      search: [SLA],
      doPurchase: (_, n) => { orden.push('pay'); return n === 1 ? { ok: false, motivo: 'desconocido', raw: '' } : { ok: true, pnr: 'ABC123', raw: '' }; },
      listBookings: () => { orden.push('check'); return []; },
    });
    assert.equal(r.estado, 'comprado');
    assert.deepEqual(orden, ['pay', 'check', 'pay'], 'entre dos pagos siempre hay una verificación');
    assert.equal(calls.doPurchase.length, 2);
    assert.equal(calls.tokenizeCard.length, 2, 'el token de Spreedly es de un solo uso: el reintento tokeniza de nuevo');
    assert.equal(calls.initPayment.length, 2);
  }

  // 9) Dos desconocidos seguidos: no hay tercer pago, queda dudoso.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, {
      search: [SLA], doPurchase: { ok: false, motivo: 'desconocido', raw: '' }, listBookings: [],
    });
    assert.equal(r.estado, 'dudoso');
    assert.equal(calls.doPurchase.length, 2);
    assert.equal(calls.listBookings.length, 2);
  }

  // 10) sin-cupo al pagar: verifica reservas, espera y busca otro vuelo.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const otro = { ...SLA, code: 'JA3023', departsAt: '2026-11-08 23:00:00' };
    const orden = [];
    const { r, sleeps } = await correr(order, {
      search: (_, n) => (n === 1 ? [SLA] : [otro]),
      doPurchase: ([, { quotation }]) => { orden.push(`pay ${quotation.code}`); return quotation.code === 'JA3021' ? { ok: false, motivo: 'sin-cupo', raw: '' } : { ok: true, pnr: 'XYZ789', raw: '' }; },
      listBookings: () => { orden.push('check'); return []; },
    });
    assert.equal(r.estado, 'comprado');
    assert.deepEqual(orden, ['pay JA3021', 'check', 'pay JA3023']);
    assert.deepEqual(sleeps, [10000], 'después de un sin-cupo, la pausa normal antes de volver a buscar');
    assert.equal(r.resultado.tramos[0].code, 'JA3023');
  }

  // 11) sin-cupo pero la reserva sí estaba: comprado, no busca otro.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, {
      search: [SLA], doPurchase: { ok: false, motivo: 'sin-cupo', raw: '' },
      listBookings: [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-08' }],
    });
    assert.equal(r.estado, 'comprado'); assert.equal(calls.doPurchase.length, 1); assert.equal(calls.search.length, 1);
  }

  // 12) 3DS: fallido y a mano; rechazada: fallido.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, msgs, calls } = await correr(order, { search: [SLA], doPurchase: { ok: false, motivo: '3ds', raw: '' } });
    assert.equal(r.estado, 'fallido'); assert.equal(r.motivo, '3ds');
    assert.equal(calls.doPurchase.length, 1); assert.match(msgs[0].text, /a mano/);
    const o2 = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const x = await correr(o2, { search: [SLA], doPurchase: { ok: false, motivo: 'rechazada', raw: '' } });
    assert.equal(x.r.estado, 'fallido'); assert.equal(x.r.motivo, 'rechazada'); assert.equal(x.calls.listBookings.length, 0);
  }

  // 13) Sesión vencida en la búsqueda: un relogin y sigue en la misma vuelta.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, session, sleeps } = await correr(order, {
      search: (_, n) => (n === 1 ? new SessionExpiredError() : [SLA]),
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(r.estado, 'comprado'); assert.equal(session.relogins, 1); assert.equal(sleeps.length, 0);
  }

  // 14) Un paso previo al pago que falla se reintenta una vez al toque.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, {
      search: [SLA], initPayment: (_, n) => (n === 1 ? new Error('INIT de pago: 502') : base.initPayment),
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(r.estado, 'comprado'); assert.equal(calls.initPayment.length, 2);
    assert.equal(r.intentos.at(-1).paso, 'initPayment');
  }

  // --- fix ronda 1 ---
  const RESERVA = [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-08' }];

  // C1a/b) Antes de pagar queda marcado el pago en vuelo; al comprar, el tramo se persiste y el marcador se limpia.
  {
    const order = await pedido();
    const vistos = [];
    const { r } = await correr(order, {
      search: ([, t]) => (t.from === 'BRC' ? [IDA] : [VUELTA]),
      doPurchase: async ([, { quotation }]) => {
        const o = await getOrder(store, order.id);
        vistos.push([o.pagoEnVuelo?.code, o.pagoEnVuelo?.tramo, (o.resultado?.tramos ?? []).map((x) => x.code)]);
        return { ok: true, pnr: quotation.code === 'JA3100' ? 'ABC123' : 'DEF456', raw: '' };
      },
    });
    assert.equal(r.estado, 'comprado');
    assert.deepEqual(vistos, [['JA3100', 0, []], ['JA3024', 1, ['JA3100']]], 'marcador antes de cada pago y lo comprado ya persistido');
    assert.equal((await getOrder(store, order.id)).pagoEnVuelo ?? null, null);
  }

  // C1c) Un proceso anterior murió con un pago en vuelo: primero se verifica.
  const conPagoEnVuelo = async () => {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    return setEstado(store, order.id, 'confirmado', { pagoEnVuelo: { tramo: 0, code: 'JA3021', departsAt: SLA.departsAt, arrivesAt: SLA.arrivesAt, hora: 'x' } });
  };
  {
    const order = await conPagoEnVuelo();
    const { r, calls, msgs } = await correr(order, { search: [SLA], listBookings: RESERVA });
    assert.equal(r.estado, 'comprado'); assert.equal(r.resultado.tramos[0].pnr, 'ABC123');
    assert.equal(calls.doPurchase.length, 0); assert.equal(calls.search.length, 0);
    assert.match(msgs[0].text, /ABC123/);
  }
  {
    const order = await conPagoEnVuelo();
    const { r, calls } = await correr(order, { search: [SLA], listBookings: [] });
    assert.equal(r.estado, 'dudoso', 'pago en vuelo sin reserva a la vista: no se sabe, no se repaga');
    assert.equal(calls.doPurchase.length, 0); assert.equal(calls.search.length, 0);
  }
  {
    const order = await conPagoEnVuelo();
    const { r, calls } = await correr(order, { search: [], listBookings: new Error('bookings-unavailable') });
    assert.equal(r.estado, 'dudoso', 'nunca fallido sin-cupo con un pago en vuelo sin resolver');
    assert.equal(calls.doPurchase.length, 0);
  }
  // C1c) Un pedido que ya no está confirmado (lo terminó otra corrida) no se toca.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    await setEstado(store, order.id, 'comprado');
    const { r, calls, msgs } = await correr(order, { search: [SLA] });
    assert.equal(r.estado, 'comprado'); assert.equal(calls.search.length, 0); assert.equal(msgs.length, 0);
  }

  // C1d) esperarLockMs: reintenta el lock cada 10 s.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    await lockOrder(store, order.id, 60);
    const { r, sleeps, calls } = await correr(order, { search: [SLA] }, { esperarLockMs: 30000 });
    assert.deepEqual(r, { estado: 'confirmado' }); assert.deepEqual(sleeps, [10000, 10000, 10000]); assert.equal(calls.search.length, 0);
    const o2 = await pedido([{ from: 'SLA', to: 'EZE' }]);
    await lockOrder(store, o2.id, 60);
    let t = T0; const sl = [];
    const { api } = fakeApi({ ...base, search: [SLA], doPurchase: { ok: true, pnr: 'ABC123', raw: '' } });
    const r2 = await runBuy({
      order: o2, store, session: { relogin: async () => {} }, chatId: '1', card, deadline: Date.parse('2026-11-08T03:15:00Z'),
      now: () => t, sleep: async (ms) => { sl.push(ms); t += ms; if (sl.length === 1) await unlockOrder(store, o2.id); },
      api, notify: async () => true, esperarLockMs: 60000,
    });
    assert.equal(r2.estado, 'comprado'); assert.deepEqual(sl, [10000]);
  }

  // C2) desconocido → sin reserva → reintento sin-cupo → sin reserva: dudoso, sin buscar otro vuelo.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const otro = { ...SLA, code: 'JA3023', departsAt: '2026-11-08 23:00:00' };
    const { r, calls } = await correr(order, {
      search: (_, n) => (n === 1 ? [SLA] : [otro]),
      doPurchase: (_, n) => (n === 1 ? { ok: false, motivo: 'desconocido', raw: '' } : { ok: false, motivo: 'sin-cupo', raw: '' }),
      listBookings: [],
    });
    assert.equal(r.estado, 'dudoso');
    assert.equal(calls.doPurchase.length, 2); assert.equal(calls.search.length, 1, 'no hay tercer search-y-pago');
  }

  // I1) Reintento que da rechazada sin reserva a la vista: dudoso, nunca fallido.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, {
      search: [SLA],
      doPurchase: (_, n) => (n === 1 ? new Error('timeout') : { ok: false, motivo: 'rechazada', raw: '' }),
      listBookings: [],
    });
    assert.equal(r.estado, 'dudoso');
    assert.equal(calls.listBookings.length, 2, 'el resultado del reintento también se verifica');
    assert.equal(calls.tokenizeCard.length, 2);
  }
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r } = await correr(order, {
      search: [SLA],
      doPurchase: (_, n) => (n === 1 ? new Error('timeout') : { ok: false, motivo: '3ds', raw: '' }),
      listBookings: (_, n) => (n === 1 ? [] : RESERVA),
    });
    assert.equal(r.estado, 'comprado', 'si el reintento dice 3ds pero la reserva está, se compró');
  }

  // I2) Parcial por 3DS en el segundo tramo: el mensaje dice por qué falta.
  {
    const order = await pedido();
    const { r, msgs } = await correr(order, {
      search: ([, t]) => (t.from === 'BRC' ? [IDA] : [VUELTA]),
      doPurchase: ([, { quotation }]) => (quotation.code === 'JA3100' ? { ok: true, pnr: 'ABC123', raw: '' } : { ok: false, motivo: '3ds', raw: '' }),
    });
    assert.equal(r.estado, 'parcial'); assert.equal(r.motivo, '3ds');
    assert.match(msgs[0].text, /ABC123/); assert.match(msgs[0].text, /3DS/); assert.match(msgs[0].text, /a mano/);
  }

  // I3) Cancelado a mitad del loop: no paga y no se pisa el estado.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls, msgs } = await correr(order, {
      search: async () => { await setEstado(store, order.id, 'cancelado'); return [SLA]; },
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(calls.quote.length, 0); assert.equal(calls.doPurchase.length, 0);
    assert.equal(r.estado, 'cancelado');
    assert.equal((await getOrder(store, order.id)).estado, 'cancelado');
    assert.equal(msgs.length, 1); assert.match(msgs[0].text, /cancelado/);
  }
  {
    // Cancelado mientras pagaba el último tramo: el estado final no pisa el cancelado.
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r } = await correr(order, {
      search: [SLA],
      doPurchase: async () => { await setEstado(store, order.id, 'cancelado'); return { ok: true, pnr: 'ABC123', raw: '' }; },
    });
    const g = await getOrder(store, order.id);
    assert.equal(g.estado, 'cancelado'); assert.equal(r.estado, 'cancelado');
    assert.equal(g.resultado.tramos[0].pnr, 'ABC123', 'lo comprado queda registrado igual');
  }

  // --- fix ronda 2: dos corridas no pueden pagar a la vez ---
  const lockKeyDe = (id) => `order-lock:${id}`;
  // Store espía: registra los TTL y dueños que pide runBuy sin cambiar el comportamiento.
  const espiar = () => {
    const log = { setnx: [], set: [] };
    return { log, store: {
      get: (k) => store.get(k), del: (k) => store.del(k),
      set: (k, val, ttl) => { log.set.push([k, val, ttl]); return store.set(k, val, ttl); },
      setnx: (k, val, ttl) => { log.setnx.push([k, val, ttl]); return store.setnx(k, val, ttl); },
    } };
  };

  // TTL que cubre la vida del proceso, dueño propio y renovación antes de pagar.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { log, store: espia } = espiar();
    let renovadoAntesDePagar = false;
    const { r } = await correr(order, {
      search: [SLA],
      doPurchase: () => { renovadoAntesDePagar = log.set.some(([k]) => k === lockKeyDe(order.id)); return { ok: true, pnr: 'ABC123', raw: '' }; },
    }, { store: espia });
    assert.equal(r.estado, 'comprado');
    const [k, owner, ttl] = log.setnx[0];
    assert.equal(k, lockKeyDe(order.id));
    assert.ok(ttl >= 860, `TTL ${ttl} cubre los 800 s del maxDuration + margen`);
    assert.ok(typeof owner === 'string' && owner.length >= 8, 'el lock lleva un dueño aleatorio');
    assert.ok(renovadoAntesDePagar, 'renovarLock antes de doPurchase');
    const renov = log.set.find(([kk]) => kk === lockKeyDe(order.id));
    assert.equal(renov[1], owner); assert.ok(renov[2] >= 860);
  }

  // Otra corrida se quedó con el lock: no se paga, no se escribe nada y el finally no se lo borra.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls, msgs } = await correr(order, {
      search: async () => { await unlockOrder(store, order.id); await lockOrder(store, order.id, 60, 'otra-corrida'); return [SLA]; },
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(calls.doPurchase.length, 0, 'sin el lock no se paga');
    assert.equal(msgs.length, 0);
    assert.equal((await getOrder(store, order.id)).estado, 'confirmado', 'lo resuelve la otra corrida');
    assert.equal(r.estado, 'confirmado');
    assert.equal(await lockOrder(store, order.id, 60, 'x'), false, 'el lock ajeno sigue puesto');
    await unlockOrder(store, order.id);
  }

  // La ventana se cierra entre la búsqueda y la compra: cero pagos.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, (reloj) => ({
      search: () => { reloj.t = DEADLINE; return [SLA]; },
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    }));
    assert.equal(calls.doPurchase.length, 0); assert.equal(calls.quote.length, 0);
    assert.equal(r.estado, 'fallido'); assert.equal(r.motivo, 'sin-cupo');
  }

  // Un reintento (paso previo que falló) que termina después del cierre en un tramo no ambiguo: no paga.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, (reloj) => ({
      search: [SLA],
      quote: ([, f], n) => { if (n === 1) { reloj.t = DEADLINE + 1000; return new Error('timeout'); } return { total: 15103.85, breakdown: [], code: f.code }; },
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    }));
    assert.equal(calls.quote.length, 2); assert.equal(calls.doPurchase.length, 0);
    assert.equal(r.estado, 'fallido'); assert.equal(r.motivo, 'sin-cupo');
  }

  // Tramo ambiguo y la ventana se cierra durante la verificación: no hay segundo pago, queda dudoso.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls } = await correr(order, (reloj) => ({
      search: [SLA],
      doPurchase: { ok: false, motivo: 'desconocido', raw: '' },
      listBookings: () => { reloj.t = DEADLINE + 1000; return []; },
    }));
    assert.equal(calls.doPurchase.length, 1); assert.equal(calls.listBookings.length, 1);
    assert.equal(r.estado, 'dudoso');
  }

  // El pedido pasó a otro estado que no es cancelado: «interrumpido», con el estado en el mensaje.
  {
    const order = await pedido([{ from: 'SLA', to: 'EZE' }]);
    const { r, calls, msgs } = await correr(order, {
      search: async () => { await setEstado(store, order.id, 'fallido'); return [SLA]; },
      doPurchase: { ok: true, pnr: 'ABC123', raw: '' },
    });
    assert.equal(calls.doPurchase.length, 0); assert.equal(r.estado, 'fallido');
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].text, /ya no está confirmado \(estado fallido\), no compré nada más/);
  }
  process.env = limpio;
}

// --- /api/buy: sólo el dueño, sólo con AUTO_BUY, y el radar del dueño se saltea ---
{
  const { default: buy, ventanaDe } = await import('./api/buy.js');
  const { default: recordatorio } = await import('./api/reminder.js');
  const { runAllRadars, tomorrowInAR } = await import('./src/radar.js');
  const { createStore } = await import('./src/store.js');
  const { saveUser, scoped } = await import('./src/users.js');
  const { newOrder, saveOrder } = await import('./src/orders.js');
  const { rm } = await import('node:fs/promises');
  const limpio = { ...process.env };
  const orig = globalThis.fetch;
  process.env.SECRET_KEY = 'clave-de-prueba-larga';
  process.env.TELEGRAM_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = '1';
  process.env.AYCF_EMAIL = 'dueno@mail.com'; process.env.AYCF_PASSWORD = 'x'; process.env.AYCF_PASS_ID = 'p1';
  delete process.env.CRON_SECRET; delete process.env.AYCF_CARD; delete process.env.AUTO_BUY;
  process.env.STATE_FILE = '/tmp/aycf-test-buy.json';
  await rm(process.env.STATE_FILE, { force: true });
  const res = () => ({ status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const msgs = [];
  globalThis.fetch = async (url, opt = {}) => {
    if (String(url).includes('api.telegram.org')) { msgs.push(JSON.parse(opt.body)); return { ok: true, status: 200, text: async () => '{}', headers: { getSetCookie: () => [] } }; }
    throw new Error(`fetch inesperado: ${url}`);
  };

  // Ventanas: el reparto de los 20 min en dos invocaciones de ≤ 800 s.
  const art = (hh, mm, ss = 0) => new Date(Date.UTC(2026, 10, 6, hh + 3, mm, ss));
  assert.deepEqual(ventanaDe(art(0, 0, 5)), { deadline: Date.UTC(2026, 10, 6, 3, 12), esperarLockMs: 0 });
  assert.deepEqual(ventanaDe(art(0, 13, 2)), { deadline: Date.UTC(2026, 10, 6, 3, 20), esperarLockMs: 360_000 });
  const corta = ventanaDe(art(14, 0));
  assert.equal(corta.deadline, art(14, 0).getTime() + 60_000); assert.equal(corta.esperarLockMs, 0);

  // (a) sin el secreto correcto: 401.
  process.env.CRON_SECRET = 's3';
  assert.equal((await buy({ headers: {}, query: {} }, res())).code, 401);
  assert.equal((await buy({ headers: { authorization: 'Bearer s3' }, query: {} }, res())).code, 200);
  delete process.env.CRON_SECRET;

  // (b) apagado: ni toca el store.
  const r0 = await buy({ headers: {}, query: {} }, res());
  assert.equal(r0.code, 200); assert.deepEqual(r0.body, { ok: true, skipped: 'auto-buy-off' });
  assert.equal(msgs.length, 0);

  // Prendido y sin pedidos: nada que avisar aunque falte la tarjeta.
  process.env.AUTO_BUY = 'on';
  assert.deepEqual((await buy({ headers: {}, query: {} }, res())).body, { ok: true, orders: [] });
  assert.equal(msgs.length, 0);

  // (c) con un pedido para mañana y sin tarjeta: aviso al dueño y nada más.
  const base = createStore();
  const duenoStore = scoped(base, '1');
  const pedido = newOrder({ chatId: '1', fechaVuelo: tomorrowInAR(), tramos: [{ from: 'BRC', to: 'AEP' }] });
  await saveOrder(duenoStore, { ...pedido, estado: 'confirmado' });
  const r1 = await buy({ headers: {}, query: {} }, res());
  assert.deepEqual(r1.body, { ok: true, skipped: 'sin-tarjeta' });
  assert.equal(msgs.length, 1); assert.match(msgs[0].text, /AYCF_CARD/);
  process.env.AYCF_CARD = '{esto no es json 4111111111111111';
  const r2 = await buy({ headers: {}, query: {} }, res());
  assert.equal(r2.body.skipped, 'sin-tarjeta', 'JSON roto = tarjeta no cargada');
  assert.ok(!JSON.stringify(r2.body).includes('4111'), 'la tarjeta no se devuelve');
  msgs.length = 0;

  // El loop con tarjeta válida y costuras: dos pedidos, uno que revienta, ?order, y la tarjeta no se filtra.
  {
    const CARD = { number: '4111111111111111', month: '12', year: '2030', cvv: '123', holder: 'A B' };
    process.env.AYCF_CARD = JSON.stringify(CARD);
    const o2 = newOrder({ chatId: '1', fechaVuelo: tomorrowInAR(), tramos: [{ from: 'AEP', to: 'COR' }] });
    await saveOrder(duenoStore, { ...o2, estado: 'confirmado' });
    const fallido = newOrder({ chatId: '1', fechaVuelo: '2030-01-01', tramos: [{ from: 'COR', to: 'AEP' }] });
    await saveOrder(duenoStore, { ...fallido, estado: 'fallido' });
    const sesion = (_s, fn) => fn({ fake: true });
    const llamadas = [];
    const ok = async (a) => { llamadas.push(a); return { estado: 'comprado' }; };

    const r1 = await buy({ headers: {}, query: {} }, res(), { _runBuy: ok, _withSession: sesion });
    assert.equal(r1.code, 200);
    assert.deepEqual(llamadas.map((a) => a.order.id).sort(), [pedido.id, o2.id].sort());
    assert.deepEqual(r1.body.orders.map((o) => o.id), llamadas.map((a) => a.order.id), 'en el orden en que se procesaron');
    assert.equal(llamadas.length, 2);
    assert.deepEqual(r1.body.orders.map((o) => o.estado), ['comprado', 'comprado']);
    assert.deepEqual(llamadas[0].card, CARD, 'la tarjeta llega entera a runBuy');
    assert.ok(!JSON.stringify(r1.body).includes(CARD.number) && !JSON.stringify(r1.body).includes('cvv'));

    llamadas.length = 0;
    let n = 0;
    const rompe = async (a) => { llamadas.push(a); if (++n === 1) throw new Error(`boom ${CARD.number}`); return { estado: 'comprado' }; };
    const r2 = await buy({ headers: {}, query: {} }, res(), { _runBuy: rompe, _withSession: sesion });
    assert.equal(r2.code, 200); assert.equal(llamadas.length, 2, 'el segundo corre igual');
    assert.deepEqual(r2.body.orders[0], { id: llamadas[0].order.id, error: 'interno' });
    assert.equal(r2.body.orders[1].estado, 'comprado');

    const r3 = await buy({ headers: {}, query: {} }, res(), { _runBuy: async () => { throw new Error('x'); }, _withSession: sesion });
    assert.equal(r3.code, 500); assert.equal(r3.body.orders.length, 2);

    llamadas.length = 0;
    const r4 = await buy({ headers: {}, query: { order: [fallido.id, 'otro'] } }, res(), { _runBuy: ok, _withSession: sesion });
    assert.equal(llamadas.length, 1); assert.equal(llamadas[0].order.id, fallido.id, '?order fuerza uno en cualquier estado');
    assert.deepEqual(r4.body.orders, [{ id: fallido.id, estado: 'comprado' }]);

    // Sin cuenta del dueño y con AUTO_BUY on: aviso al chat del dueño.
    msgs.length = 0;
    const { AYCF_EMAIL, AYCF_PASS_ID } = process.env;
    delete process.env.AYCF_EMAIL; delete process.env.AYCF_PASS_ID;
    const r5 = await buy({ headers: {}, query: {} }, res());
    assert.equal(r5.body.skipped, 'sin-dueno'); assert.equal(msgs.length, 1);
    process.env.AYCF_EMAIL = AYCF_EMAIL; process.env.AYCF_PASS_ID = AYCF_PASS_ID;
    delete process.env.AYCF_CARD;
    msgs.length = 0;
  }

  // (d) el radar: el dueño se saltea en noche de compra, el otro corre.
  await saveUser(base, '7', { email: 'ana@mail.com', password: 'x', passId: 'p7' });
  await scoped(base, '7').set('watches', [{ from: 'AEP', to: 'COR' }]);
  const out = await runAllRadars({ date: tomorrowInAR() });
  const dueno = out.find((o) => String(o.chatId) === '1');
  assert.equal(dueno.skipped, 'compra-en-curso');
  assert.ok(out.find((o) => String(o.chatId) === '7' && o.skipped !== 'compra-en-curso'), 'Ana sigue con su barrido');
  // Sin pedidos para esta noche (inyectado) o con AUTO_BUY apagado, el dueño barre como siempre.
  const sinPedidos = await runAllRadars({ date: tomorrowInAR(), _dueTonight: async () => [] });
  assert.notEqual(sinPedidos.find((o) => String(o.chatId) === '1').skipped, 'compra-en-curso');
  process.env.AUTO_BUY = 'off';
  const apagado = await runAllRadars({ date: tomorrowInAR() });
  assert.notEqual(apagado.find((o) => String(o.chatId) === '1').skipped, 'compra-en-curso');
  process.env.AUTO_BUY = 'on';
  msgs.length = 0;

  // Recordatorio de las 23:55: un mensaje por pedido de LA NOCHE (vuelo pasado mañana de hoy ART), con botón de cancelar.
  const real = Date.now;
  Date.now = () => Date.UTC(2026, 10, 6, 2, 55); // 23:55 ART del 5/11
  try {
    const noche = newOrder({ chatId: '1', fechaVuelo: '2026-11-07', tramos: [{ from: 'BRC', to: 'AEP' }] });
    await saveOrder(duenoStore, { ...noche, estado: 'confirmado' });
    await recordatorio({ headers: {} }, res());
  } finally { Date.now = real; }
  const rec = msgs.filter((m) => /Lo compro solo a las 00:00/.test(m.text));
  assert.equal(rec.length, 1, 'sólo el pedido de esta noche');
  assert.equal(JSON.parse(JSON.stringify(rec[0].reply_markup)).inline_keyboard[0][0].text, '❌ Cancelar');
  assert.match(rec[0].reply_markup.inline_keyboard[0][0].callback_data, /^ord:no:/);

  globalThis.fetch = orig;
  process.env = limpio;
}

// --- intake: del texto al pedido, con confirmación ---
{
  const { parseOrderText, parseOrderStrict, cmdPedido, cmdPedidos, ORDER_SCHEMA } = await import('./src/intake.js');
  const { comandoDe, handleCallback, handleCommand } = await import('./src/commands.js');
  const { getOrder, listOrders, newOrder, saveOrder, formatPedido } = await import('./src/orders.js');
  const limpio = { ...process.env };
  process.env.TELEGRAM_CHAT_ID = '1'; process.env.AUTO_BUY = 'on'; process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const store = memStore();
  await store.set('catalog:routes', {
    aeropuertos: { BRC: 'Bariloche', AEP: 'Aeroparque', COR: 'Córdoba', SLA: 'Salta' },
    rutas: ['BRC-AEP', 'AEP-COR', 'AEP-SLA'],
  });
  const aeropuertos = (await store.get('catalog:routes')).aeropuertos;
  const HOY = '2026-11-05'; // jueves

  // El schema de structured outputs no admite objetos abiertos ni topes numéricos.
  const revisar = (n, ruta = 'schema') => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object' || n.properties) {
      assert.equal(n.additionalProperties, false, `${ruta} necesita additionalProperties: false`);
      assert.deepEqual([...(n.required ?? [])].sort(), Object.keys(n.properties).sort(), `${ruta}: todo requerido`);
    }
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems']) {
      assert.ok(!(k in n), `${ruta} no puede tener ${k}`);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => revisar(x, `${ruta}.${k}[${i}]`));
      else if (typeof v === 'object') revisar(v, `${ruta}.${k}`);
    }
  };
  revisar(ORDER_SCHEMA);

  const respuesta = (obj, stop_reason = 'end_turn') => ({
    ok: true, status: 200,
    json: async () => ({ stop_reason, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }),
  });
  const PEDIDO = {
    tipo: 'pedido', fechaVuelo: '2026-11-07',
    tramos: [{ from: 'BRC', to: 'AEP', ventana: null }, { from: 'AEP', to: 'COR', ventana: null }],
    escalaMinimaHoras: null, preferencia: 'cualquier horario', aclaracion: null,
  };

  // (a) el request a la API de Claude con la forma de la referencia.
  let visto;
  const fakeFetch = async (url, init) => { visto = { url, init, body: JSON.parse(init.body) }; return respuesta(PEDIDO); };
  const parsed = await parseOrderText('el sábado bariloche a aeroparque', { hoy: HOY, aeropuertos, _fetch: fakeFetch });
  assert.deepEqual(parsed, PEDIDO);
  assert.equal(visto.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(visto.init.method, 'POST');
  assert.equal(visto.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(visto.init.headers['anthropic-version'], '2026-10-21');
  assert.equal(visto.init.headers['content-type'], 'application/json');
  assert.ok(visto.init.signal, 'con timeout');
  assert.equal(visto.body.model, 'claude-opus-5-5');
  assert.equal(visto.body.max_tokens, 1024);
  assert.equal(visto.body.output_config.effort, 'low');
  assert.equal(visto.body.output_config.format.type, 'json_schema');
  assert.deepEqual(visto.body.output_config.format.schema, ORDER_SCHEMA);
  assert.deepEqual(visto.body.messages, [{ role: 'user', content: 'el sábado bariloche a aeroparque' }]);
  assert.match(visto.body.system, /2026-11-05/);
  assert.match(visto.body.system, /jueves/);
  assert.match(visto.body.system, /GMT-3/);
  assert.match(visto.body.system, /BRC — Bariloche/);
  assert.ok(!visto.body.system.includes('sk-ant-test'), 'la key no viaja en el prompt');
  await assert.rejects(parseOrderText('x', { hoy: HOY, aeropuertos, _fetch: async () => respuesta(PEDIDO, 'max_tokens') }), /no-entendi/);
  await assert.rejects(parseOrderText('x', { hoy: HOY, aeropuertos, _fetch: async () => respuesta('{roto') }), /no-entendi/);

  // (b) lenguaje natural → borrador con dos tramos y botones de confirmar/cancelar.
  const out = await cmdPedido(store, '1', 'el sábado bariloche a aeroparque y después a córdoba, no me importa el horario', { _fetch: fakeFetch, hoy: HOY });
  const [[ok, no]] = out.buttons;
  assert.equal(ok.text, '✅ Confirmar'); assert.equal(no.text, '❌ Cancelar');
  const id = ok.data.replace(/^ord:ok:/, '');
  assert.equal(no.data, `ord:no:${id}`);
  assert.ok(Buffer.byteLength(ok.data) <= 64, 'callback_data entra en 64 bytes');
  const borrador = await getOrder(store, id);
  assert.equal(borrador.estado, 'borrador');
  assert.equal(borrador.fechaVuelo, '2026-11-07', 'el próximo sábado respecto de hoy');
  assert.equal(borrador.tramos.length, 2);
  assert.equal(borrador.escalaMinimaHoras, 2.5, 'null del modelo = el default');
  assert.equal(out.text, formatPedido(borrador, { hoy: HOY }) + '\n\n¿Lo confirmo?');
  assert.equal(formatPedido(borrador, { hoy: HOY }),
    '📌 *Pedido* · sábado 07/11 · BRC → AEP (cualquier horario) · AEP → COR, escala ≥ 2,5 h · lo busco el viernes 06/11 a las 00:00');
  assert.equal(formatPedido({ ...borrador, tramos: [{ from: 'BRC', to: 'AEP', ventana: ['06:00', '12:00'] }] }, { hoy: HOY }),
    '📌 *Pedido* · sábado 07/11 · BRC → AEP (06:00–12:00) · lo busco el viernes 06/11 a las 00:00');
  // Vuelo de mañana: el inventario ya salió a las 00:01 de hoy y lo levantan las pasadas horarias.
  assert.equal(formatPedido({ ...borrador, fechaVuelo: '2026-11-06' }, { hoy: HOY }),
    '📌 *Pedido* · viernes 06/11 · BRC → AEP (cualquier horario) · AEP → COR, escala ≥ 2,5 h · lo busco en la próxima pasada (cada hora hasta las 20:00)');

  // (c) los botones: confirmar, cancelar, id que no existe, y sólo para el dueño.
  const noDueno = await handleCallback(`ord:ok:${id}`, { store, user: null, chatId: '2' });
  assert.equal((await getOrder(store, id)).estado, 'borrador', 'otro chat no confirma nada');
  assert.ok(!/Listo/.test(noDueno.text));
  const conf = await handleCallback(`ord:ok:${id}`, { store, user: null, chatId: '1', hoy: HOY });
  assert.equal((await getOrder(store, id)).estado, 'confirmado');
  assert.equal(conf.text, '✅ Listo, lo compro el viernes 06/11 a las 00:00. Te aviso con el PNR.');
  const canc = await handleCallback(`ord:no:${id}`, { store, user: null, chatId: '1' });
  assert.equal((await getOrder(store, id)).estado, 'cancelado');
  assert.equal(canc.text, '❌ Pedido cancelado.');
  const revive = await handleCallback(`ord:ok:${id}`, { store, user: null, chatId: '1' });
  assert.equal((await getOrder(store, id)).estado, 'cancelado', 'un botón viejo no resucita un cancelado');
  assert.ok(!/Listo/.test(revive.text));
  assert.equal((await handleCallback('ord:ok:ord_nada', { store, user: null, chatId: '1' })).text, 'Ese pedido ya no existe.');

  // (d) y (e) ruteo: dos tokens siguen siendo búsqueda; el resto del dueño, pedido.
  const dueno = { chatId: '1', email: 'a@b.com', passId: 'x', env: true };
  assert.equal(comandoDe('bariloche salta', dueno, { chatId: '1' }).cmd, '/buscar', 'Review Focus 5');
  assert.deepEqual(comandoDe('el lunes necesito ir a aeroparque', dueno, { chatId: '1' }),
    { cmd: '/pedido', args: ['el lunes necesito ir a aeroparque'] });
  assert.equal(comandoDe('el lunes necesito ir a aeroparque', { ...dueno, chatId: '2', env: false }, { chatId: '2' }).cmd, '/buscar');
  assert.equal(comandoDe('/rutas', dueno, { chatId: '1' }).cmd, '/rutas');
  assert.equal(comandoDe('mia@mail.com mi clave larga', dueno, { chatId: '1' }).cmd, '/conectar');
  process.env.AUTO_BUY = 'off';
  assert.equal(comandoDe('el lunes necesito ir a aeroparque', dueno, { chatId: '1' }).cmd, '/buscar', 'sin AUTO_BUY no hay pedidos');
  process.env.AUTO_BUY = 'on';

  // (f) el formato estricto, el salvavidas cuando la API no está.
  assert.deepEqual(parseOrderStrict('comprar 2026-11-08 BRC-AEP AEP-COR'), {
    tipo: 'pedido', fechaVuelo: '2026-11-08',
    tramos: [{ from: 'BRC', to: 'AEP', ventana: null }, { from: 'AEP', to: 'COR', ventana: null }],
    escalaMinimaHoras: null, preferencia: 'cualquier horario', aclaracion: null,
  });
  assert.equal(parseOrderStrict('Comprar 2026-11-08 brc-aep').tramos.length, 1);
  assert.equal(parseOrderStrict('el sábado a córdoba'), null);

  // (g) la API se cae: sin formato estricto, ayuda y ningún pedido; con formato, sale igual.
  const antes = (await listOrders(store)).length;
  const caida = async () => { throw new Error('ECONNRESET'); };
  const sinApi = await cmdPedido(store, '1', 'el sábado a córdoba', { _fetch: caida, hoy: HOY });
  assert.match(sinApi.text, /comprar 2026-11-08 BRC-AEP AEP-COR/);
  assert.ok(!sinApi.buttons, 'sin botones');
  assert.equal((await listOrders(store)).length, antes, 'no crea pedido');
  delete process.env.ANTHROPIC_API_KEY;
  const estricto = await cmdPedido(store, '1', 'comprar 2026-11-08 BRC-AEP AEP-COR', { _fetch: caida, hoy: HOY });
  assert.match(estricto.buttons[0][0].data, /^ord:ok:ord_/, 'sin key igual entra por el formato estricto');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

  // Aclaración, búsqueda, validación y vuelo al que ya no se llega.
  const pregunta = await cmdPedido(store, '1', 'quiero viajar', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, tipo: 'pedido', fechaVuelo: null, tramos: [], aclaracion: '¿Qué día y a dónde?' }),
  });
  assert.deepEqual(pregunta, { text: '¿Qué día y a dónde?' });
  const busq = await cmdPedido(store, '1', 'bariloche a córdoba', { hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, tipo: 'busqueda' }) });
  assert.match(busq.text, /\/buscar/);
  const desencadenado = await cmdPedido(store, '1', 'x', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, tramos: [{ from: 'BRC', to: 'AEP', ventana: null }, { from: 'EZE', to: 'COR', ventana: null }] }),
  });
  assert.match(desencadenado.text, /encaden/);
  assert.ok(!desencadenado.buttons);
  // Mañana vale (las pasadas horarias lo compran); hoy o antes, no.
  const manana = await cmdPedido(store, '1', 'mañana a aeroparque', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, fechaVuelo: '2026-11-06', tramos: [{ from: 'BRC', to: 'AEP', ventana: null }] }),
  });
  assert.match(manana.text, /lo busco en la próxima pasada \(cada hora hasta las 20:00\)/);
  const idManana = manana.buttons[0][0].data.replace(/^ord:ok:/, '');
  assert.equal((await getOrder(store, idManana)).estado, 'borrador');
  const confManana = await handleCallback(`ord:ok:${idManana}`, { store, user: null, chatId: '1', hoy: HOY });
  assert.equal(confManana.text, '✅ Listo, lo busco en la próxima pasada horaria. Te aviso con el PNR.');
  const hoyMismo = await cmdPedido(store, '1', 'hoy a aeroparque', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, fechaVuelo: HOY, tramos: [{ from: 'BRC', to: 'AEP', ventana: null }] }),
  });
  assert.match(hoyMismo.text, /ya está en el pasado o es hoy: el canje cierra 2 h antes de la salida/);
  assert.ok(!hoyMismo.buttons);

  // Ruta que no existe en la red: no se guarda.
  const sinRuta = await cmdPedido(store, '1', 'el sábado bariloche a salta', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, tramos: [{ from: 'BRC', to: 'SLA', ventana: null }] }),
  });
  assert.match(sinRuta.text, /BRC → SLA no existe como vuelo directo en la red/);
  assert.ok(!sinRuta.buttons);

  // Lo que viene del modelo o de un Error no puede romper el Markdown de Telegram.
  const md = await cmdPedido(store, '1', 'x', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, fechaVuelo: null, tramos: [], aclaracion: '¿*Córdoba* o COR_1 [`x`]?' }),
  });
  assert.equal(md.text, '¿\\*Córdoba\\* o COR\\_1 \\[\\`x\\`]?');
  const ventanaRota = await cmdPedido(store, '1', 'x', {
    hoy: HOY, _fetch: async () => respuesta({ ...PEDIDO, tramos: [{ from: 'BRC', to: 'AEP', ventana: ['6', '12'] }] }),
  });
  assert.match(ventanaRota.text, /\\\[HH:MM, HH:MM\]/, 'el [ del error va escapado');

  assert.equal((await listOrders(store)).length, antes + 2, 'quedan el estricto y el de mañana');

  // /pedidos: los vivos con su botón de cancelar; vacío, invita a pedir.
  assert.equal((await cmdPedidos(memStore())).text, 'No tenés pedidos vivos. Contame qué pasaje necesitás.');
  const lista = await cmdPedidos(store);
  assert.equal(lista.buttons.length, 2, 'el cancelado no aparece');
  assert.equal(lista.buttons[0][0].data, `ord:no:${estricto.buttons[0][0].data.slice(7)}`);
  assert.match(lista.text, /BRC → AEP/);

  // El webhook: /pedidos por comando y la ayuda del dueño.
  const porComando = await handleCommand('/pedidos', { store, session: null, user: dueno, chatId: '1' });
  assert.equal(porComando.buttons.length, 2);
  const ayuda = await handleCommand('/ayuda', { store, session: null, user: dueno, chatId: '1' });
  assert.match(ayuda, /\/pedidos — mis pedidos de compra automática/);
  assert.match(ayuda, /lo compro solo a las 00:00/);
  const { NECESITA_SESION } = await import('./src/commands.js');
  assert.ok(!NECESITA_SESION.includes('/pedido') && !NECESITA_SESION.includes('/pedidos'));

  process.env = limpio;
}

console.log('✅ todo ok');
