// Comandos del bot. Cada handler devuelve el texto a responder.

import { search, discoverPassId, SinPaseError } from './jetsmart.js';
import { tomorrowInAR } from './radar.js';
import { validateWatch, watchLabel } from './watches.js';
import { resolveWatches, saveWatches } from './config.js';
import { formatFlight } from './notify.js';
import { getCatalog, resolveAirport, airportName, routeExists, destinationsFrom } from './airports.js';
import { Session } from './session.js';
import { saveUser, deleteUser, estaConectado, usaSemilla } from './users.js';
import { haySecreto } from './crypto.js';

const BIENVENIDA = `🛩️ *Te aviso apenas hay cupo AYCF.*

El pase de JetSMART libera los asientos a las 00:01 y son pocos. Yo miro por vos
todas las noches apenas se liberan y te escribo si aparece uno en tus rutas.

*Para empezar, mandame tu mail y tu contraseña de go.jetsmart.com en un mensaje:*

\`tu@mail.com tucontraseña\`

_Son las mismas con las que entrás al portal del pase. Se guardan cifradas, solo
se usan para consultar TU disponibilidad, y borro ese mensaje del chat apenas lo
recibo. Cuando quieras te vas con /desconectar._`;

const AYUDA = `🛩️ *AYCF Radar*

/vigilar — sumo una ruta (te muestro botones)
/rutas — las rutas que estoy vigilando
/buscar — busco ahora mismo
/borrar \`N\` — saco la ruta N de la lista
/aeropuertos \`[ORIGEN]\` — la red de JetSMART, o los destinos desde un origen
/cookie — pegame una sesión nueva (queda viva al instante)
/pase \`uuid\` — si no pude detectar tu pase solo
/desconectar — borro tus credenciales y tus rutas
/estado — cómo viene todo

También podés escribirme suelto *bariloche salta* y busco esa ruta, sin comando
ni códigos.

_Solo se puede consultar el día siguiente: el pase libera los cupos a las 00:01
y no existe inventario más allá de eso._`;

/**
 * Acepta códigos ("BRC") o nombres ("bariloche"). Los nombres pueden traer varias
 * palabras, así que partimos por la mitad solo si no son dos tokens sueltos.
 */
async function parseRuta(args, store) {
  const cat = await getCatalog(store);

  if (!cat) {
    // Sin catálogo todavía (nunca corrió un barrido): solo códigos.
    const [from, to] = args.map((a) => a.toUpperCase());
    if (!/^[A-Z]{3}$/.test(from || '') || !/^[A-Z]{3}$/.test(to || '')) {
      throw new Error('Todavía no tengo el catálogo de aeropuertos. Usá códigos IATA: `AEP SLA`');
    }
    return { from, to, cat: null };
  }

  if (args.length < 2) throw new Error('Necesito origen y destino. Ej: `/buscar bariloche salta`');

  const mitad = Math.ceil(args.length / 2);
  const pares = args.length === 2
    ? [[args[0]], [args[1]]]
    : [args.slice(0, mitad), args.slice(mitad)];

  const resueltos = [];
  for (const [i, tokens] of pares.entries()) {
    const texto = tokens.join(' ');
    const r = resolveAirport(texto, cat.aeropuertos);
    if (r.opciones) {
      throw new Error(`"${texto}" es ambiguo. ¿Cuál?\n${r.opciones.map((o) => `• ${o}`).join('\n')}`);
    }
    if (!r.iata) {
      throw new Error(`No encontré "${texto}". Mirá /aeropuertos para la lista.`);
    }
    resueltos[i] = r.iata;
  }
  const [from, to] = resueltos;
  if (from === to) throw new Error('Origen y destino son el mismo.');
  return { from, to, cat };
}

function rutaLegible(from, to, cat) {
  if (!cat) return `${from}→${to}`;
  return `${airportName(from, cat.aeropuertos)} → ${airportName(to, cat.aeropuertos)}`;
}

async function cmdAeropuertos(store, args) {
  const cat = await getCatalog(store);
  if (!cat) return 'Todavía no tengo el catálogo. Se llena solo con el primer barrido.';

  if (args.length) {
    const r = resolveAirport(args.join(' '), cat.aeropuertos);
    if (!r.iata) return `No encontré "${args.join(' ')}".`;
    const destinos = destinationsFrom(r.iata, cat.rutas, cat.aeropuertos);
    if (!destinos.length) return `Desde ${airportName(r.iata, cat.aeropuertos)} no hay directos en la red.`;
    return `✈️ *Directos desde ${airportName(r.iata, cat.aeropuertos)}* (${destinos.length})\n\n` +
      destinos.map((d) => `• ${d}`).join('\n');
  }

  const lista = Object.entries(cat.aeropuertos)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([iata, nombre]) => `\`${iata}\` ${nombre}`);
  return `✈️ *${lista.length} aeropuertos en la red*\n\n${lista.join('\n')}\n\n` +
    '_Podés escribir el nombre en vez del código._';
}

async function cmdRutas(store, user) {
  const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) });
  if (!watches.length) {
    return '📋 Todavía no vigilás ninguna ruta.\n\nSumá una: `/vigilar bariloche salta`';
  }
  const lineas = watches.map((w, i) => {
    const extras = [
      w.minSeats > 1 ? `≥${w.minSeats} asientos` : null,
      w.weekdays?.length ? w.weekdays.join('/') : null,
      w.maxTaxes ? `≤${w.maxTaxes}` : null,
      w.enabled === false ? 'PAUSADA' : null,
    ].filter(Boolean);
    return `${i + 1}. ${watchLabel(w)}${extras.length ? ` _(${extras.join(', ')})_` : ''}`;
  });
  return `📋 *Vigilando ${watches.length} ruta(s)*\n\n${lineas.join('\n')}`;
}

async function cmdBuscar(store, session, user, args) {
  if (!args.length) {
    const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) });
    if (watches.length) {
      return {
        text: '¿Cuál busco ahora?',
        buttons: filas(watches.map((w) => ({ text: watchLabel(w), data: `s:${w.from}:${w.to}` })), 1),
      };
    }
    return (await botonesOrigen(store, '¿Desde dónde volás?')) ?? 'Decime la ruta: `/buscar bariloche salta`';
  }
  const { from, to, cat } = await parseRuta(args, store);
  const nombre = rutaLegible(from, to, cat);
  if (cat && !routeExists(from, to, cat.rutas)) {
    return `⚠️ *${nombre}* no existe como vuelo directo en la red de JetSMART.\n\n` +
      `Probá /aeropuertos ${from} para ver los destinos desde ahí.`;
  }
  const date = tomorrowInAR();
  const flights = await search(session, { from, to, date }, store);
  if (!flights.length) return `❌ *${nombre}* — sin cupo para el ${date}.`;
  const lineas = flights
    .sort((a, b) => String(a.departsAt).localeCompare(String(b.departsAt)))
    .map((f) => `   • ${formatFlight(f)}`)
    .join('\n');
  return `✅ *${nombre}* — ${flights.length} vuelo(s) el ${date}\n${lineas}`;
}

async function cmdVigilar(store, user, args) {
  if (!args.length) {
    return (await botonesOrigen(store, '¿Desde dónde volás?')) ??
      'Decime la ruta: `/vigilar bariloche salta`';
  }
  // El último argumento puede ser el mínimo de asientos.
  const ultimo = args[args.length - 1];
  const minSeats = /^\d+$/.test(ultimo ?? '') ? Number(ultimo) : 1;
  const tokens = minSeats > 1 ? args.slice(0, -1) : args;

  const { from, to, cat } = await parseRuta(tokens, store);
  const nombre = rutaLegible(from, to, cat);

  // Vigilar una ruta que no existe te deja esperando algo que nunca va a llegar.
  if (cat && !routeExists(from, to, cat.rutas)) {
    return `⚠️ *${nombre}* no existe como directo en la red de JetSMART, así que ` +
      `nunca va a haber cupo.\n\nMirá /aeropuertos ${from} para ver qué sí hay.`;
  }
  const nuevo = validateWatch({ from, to, ...(minSeats > 1 ? { minSeats } : {}) }, 0);

  const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) });
  if (watches.some((w) => w.from === from && w.to === to && (w.minSeats ?? 1) === minSeats)) {
    return `Ya estaba vigilando *${nombre}*.`;
  }
  const actualizado = await saveWatches(store, [...watches, { ...nuevo, label: nombre }]);
  return `✅ Agregada *${nombre}*${minSeats > 1 ? ` con ≥${minSeats} asientos` : ''}.\n` +
    `Ahora vigilo ${actualizado.length} rutas.`;
}

async function cmdBorrar(store, user, args) {
  const n = Number(args[0]);
  const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) });
  if (!Number.isInteger(n) || n < 1 || n > watches.length) {
    return `Decime un número del 1 al ${watches.length}. Mirá /rutas.`;
  }
  const [fuera] = watches.splice(n - 1, 1);
  await saveWatches(store, watches);
  return `🗑️ Saqué *${watchLabel(fuera)}*. Quedan ${watches.length}.`;
}

/**
 * Re-sembrar la sesión desde el chat. Es el camino rápido: no hay que tocar
 * Vercel ni redeployar, queda en el store y la próxima corrida ya la usa.
 *
 * La sesión de Caravelo tiene vencimiento ABSOLUTO (~40 min), no por inactividad,
 * así que esto hay que hacerlo seguido. Lo importante es tenerla fresca antes
 * de las 00:01, que es cuando se libera el inventario.
 */
async function cmdCookie(store, user, args) {
  const crudo = args.join(' ').trim();
  if (!crudo) {
    return '🍪 Pegame la sesión así:\n\n' +
      '`/cookie ` + el header `cookie` del portal\n\n' +
      'DevTools → Network → el request `availability/...` → Request Headers → `cookie`.\n' +
      'También sirven los valores sueltos de `laravel_session` y `XSRF-TOKEN`.';
  }

  const candidatos = crudo.includes('laravel_session=')
    ? [crudo.replace(/\s*\n\s*/g, ' ')]
    : (() => {
        const vals = crudo.split(/[\s\n]+/).filter((v) => v.length > 40);
        if (vals.length < 2) return vals.length === 1 ? [`laravel_session=${vals[0]}`] : [];
        return [
          `laravel_session=${vals[0]}; XSRF-TOKEN=${vals[1]}`,
          `laravel_session=${vals[1]}; XSRF-TOKEN=${vals[0]}`,
        ];
      })();

  if (!candidatos.length) return '⚠️ No reconocí ninguna cookie ahí.';

  for (const cookie of candidatos) {
    const probe = new Session(store, user ?? {});
    probe.jar = Object.fromEntries(
      cookie.split(';').map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
      }).filter(([n]) => n)
    );
    try {
      const date = tomorrowInAR();
      const [w] = await resolveWatches(store, undefined, { seed: false });
      await search(probe, { from: w?.from ?? 'AEP', to: w?.to ?? 'COR', date }, store);
      await probe.persist();
      return '✅ *Sesión nueva, funcionando.*\n\n' +
        'Ya quedó guardada: la próxima corrida la usa sin redeployar nada.\n' +
        '_Ojo que vence en ~40 min (es absoluto, no por inactividad)._';
    } catch {
      // probamos el siguiente orden
    }
  }
  return '❌ No sirvió: puede estar vencida o mal copiada.\n\n' +
    'Hacé UNA búsqueda en el portal, copiá el header `cookie` completo y mandámelo de nuevo.';
}


/**
 * Un TypeError de JS no le dice nada a nadie: "Cannot read properties of
 * undefined" llegó a salir por Telegram como si fuera un aviso. Los errores que
 * escribimos nosotros SÍ son útiles (dicen qué ruta no existe, qué falta), así
 * que solo tapamos los que tienen pinta de bug y los dejamos en el log.
 */
function mensajeDeError(err) {
  const bug = err instanceof TypeError || err instanceof RangeError ||
    /is not a function|Cannot read propert|undefined is not/i.test(err.message);
  if (!bug) return `⚠️ ${err.message}`;
  console.error(err);
  return '⚠️ Se me rompió algo acá adentro. Probá de nuevo, y si sigue igual avisá.';
}

// --- Botones -----------------------------------------------------------------
// Tocar es más fácil que acordarse de un código IATA. Los callbacks son cortos
// porque Telegram los corta a 64 bytes: `o:AEP` (origen), `a:AEP:SLA` (agregar),
// `s:AEP:SLA` (buscar), `menu`.

const filas = (items, porFila = 3) =>
  items.reduce((acc, it, i) => {
    if (i % porFila === 0) acc.push([]);
    acc[acc.length - 1].push(it);
    return acc;
  }, []);

async function botonesOrigen(store, titulo) {
  const cat = await getCatalog(store);
  if (!cat) return null;
  const items = Object.entries(cat.aeropuertos)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([iata, nombre]) => ({ text: nombre, data: `o:${iata}` }));
  return { text: titulo, buttons: filas(items, 2) };
}

async function botonesDestino(store, from, accion = 'a') {
  const cat = await getCatalog(store);
  if (!cat) return null;
  const items = cat.rutas
    .filter((r) => r.startsWith(`${from}-`))
    .map((r) => r.split('-')[1])
    .sort((x, y) => airportName(x, cat.aeropuertos).localeCompare(airportName(y, cat.aeropuertos)))
    .map((to) => ({ text: airportName(to, cat.aeropuertos), data: `${accion}:${from}:${to}` }));
  if (!items.length) return { text: `Desde ${airportName(from, cat.aeropuertos)} no hay vuelos directos.`, buttons: [] };
  return {
    text: `Desde *${airportName(from, cat.aeropuertos)}*, ¿a dónde?`,
    buttons: [...filas(items, 2), [{ text: '⬅️ Otro origen', data: 'menu' }]],
  };
}

/** Un toque de botón. Devuelve { text, buttons } para reemplazar el mensaje. */
export async function handleCallback(data, { store, session, user, chatId }) {
  const perfil = user ?? (chatId ? { chatId: String(chatId) } : null);
  const [accion, from, to] = String(data).split(':');
  try {
    if (accion === 'menu') {
      return (await botonesOrigen(store, '¿Desde dónde volás?')) ??
        { text: 'Todavía no tengo el mapa de la red. Probá `/vigilar bariloche salta`.' };
    }
    if (accion === 'o') return await botonesDestino(store, from);
    if (accion === 'a') {
      // Confirmar y dejar el camino abierto: sin botones acá el flujo termina
      // en un callejón y hay que volver a acordarse de un comando.
      return {
        text: await cmdVigilar(store, perfil, [from, to]),
        buttons: [[
          { text: '➕ Sumar otra', data: 'menu' },
          { text: '🔍 Buscar ahora', data: `s:${from}:${to}` },
        ]],
      };
    }
    if (accion === 's') {
      return {
        text: await cmdBuscar(store, session, perfil, [from, to]),
        buttons: [[{ text: '🔄 Buscar de nuevo', data: `s:${from}:${to}` }, { text: '📋 Mis rutas', data: 'rutas' }]],
      };
    }
    if (accion === 'rutas') return { text: await cmdRutas(store, perfil), buttons: [[{ text: '➕ Sumar otra', data: 'menu' }]] };
    return { text: 'Ese botón ya no vale, mandá /rutas.' };
  } catch (err) {
    if (err.name === 'SessionExpiredError') throw err;
    return { text: mensajeDeError(err) };
  }
}

const NO_CONECTADO =
  '🔌 Todavía no conectaste tu cuenta.\n\n' +
  'Mandame `/conectar tu@mail.com tucontraseña` y me encargo del resto.\n' +
  '_Son tus credenciales de go.jetsmart.com. Se guardan cifradas y solo se usan ' +
  'para consultar TU disponibilidad._';

/**
 * Alta de un usuario. El login se prueba en el momento: guardar credenciales que
 * no funcionan es garantizar que el aviso de las 00:01 no salga.
 *
 * El pase se intenta detectar solo y se verifica con una búsqueda real; si no sale,
 * se lo pedimos con /pase en vez de guardar un UUID cualquiera.
 */
async function cmdConectar(store, chatId, user, args) {
  const [email, ...resto] = args;
  const password = resto.join(' ');
  if (!email || !password) {
    return '🔑 Así: `/conectar tu@mail.com tucontraseña`\n\n' +
      'Son las de go.jetsmart.com (el portal del pase).\n' +
      '_Borrá el mensaje después de mandarlo: Telegram lo deja en el historial._';
  }
  if (!email.includes('@')) return '⚠️ Eso no parece un mail. `/conectar tu@mail.com tucontraseña`';
  if (!haySecreto()) {
    return '🔴 Este bot no tiene `SECRET_KEY` configurada, así que no puedo guardar ' +
      'contraseñas cifradas. Avisale a quien lo hostea.';
  }

  const creds = { chatId: String(chatId), email, password };
  const session = new Session(store, creds);
  await session.relogin(); // tira LoginError con el motivo real si Keycloak rechaza

  // Pase: el que ya tenía guardado, o el que podamos detectar en la página privada.
  const candidatos = [...(user?.passId ? [user.passId] : []), ...(await discoverPassId(session))];
  let passId = null;
  for (const c of candidatos) {
    session.creds.passId = c;
    try {
      await search(session, { from: 'AEP', to: 'COR', date: tomorrowInAR() }, store);
      passId = c;
      break;
    } catch {
      session.creds.passId = null;
    }
  }

  await saveUser(store.raw ?? store, chatId, { email, password, ...(passId ? { passId } : {}) });
  await session.persist();

  if (!passId) {
    return '🔓 *Entré a tu cuenta, pero no encontré tu pase AYCF.*\n\n' +
      'Puede que no tengas un pase activo. Si lo tenés: entrá a go.jetsmart.com, ' +
      'abrí la sección del pase, y pegame acá el link de la barra de direcciones ' +
      'con `/pase ` adelante. Yo saco el código solo.';
  }
  return (await botonesOrigen(store, '✅ *Listo, ya estás conectado.*\n\n¿Desde dónde volás?')) ?? {
    text: '✅ *Listo, ya estás conectado.*\n\nSumá tu primera ruta: `/vigilar bariloche salta`',
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function cmdPase(store, chatId, user, args) {
  // Acepta el UUID pelado o cualquier cosa que lo contenga (una URL del portal
  // pegada de la barra de direcciones, por ejemplo). Pedirle a alguien que
  // extraiga un UUID a mano es pedirle que se equivoque.
  const uuid = (args.join(' ').match(UUID)?.[0] || '').toLowerCase();
  if (!uuid) {
    return 'Pegame el link del portal o el código del pase.\n\n' +
      'Sirve cualquier URL de go.jetsmart.com que tenga el código adentro, ' +
      'o el código solo: `/pase 1a2b3c4d-....`';
  }
  // Verificar antes de guardar: un pase equivocado da 4xx en cada barrido.
  const session = new Session(store, { ...user, chatId: String(chatId), passId: uuid });
  await session.load();
  await search(session, { from: 'AEP', to: 'COR', date: tomorrowInAR() }, store);
  await saveUser(store.raw ?? store, chatId, { passId: uuid });
  return '✅ Pase guardado y verificado.';
}

async function cmdDesconectar(store, chatId) {
  await deleteUser(store.raw ?? store, chatId);
  await saveWatches(store, []);
  return '👋 Listo: borré tus credenciales, tu sesión y tus rutas. ' +
    'Cuando quieras volver, `/conectar`.';
}

async function cmdEstado(store, session) {
  const watches = await resolveWatches(store);
  const date = tomorrowInAR();
  // Un request real: si la sesión estuviera caída, esto tira SessionExpiredError.
  const primera = watches[0];
  await search(session, { from: primera.from, to: primera.to, date }, store);
  return `✅ *Todo en orden*\n\n` +
    `Sesión: viva\nRutas: ${watches.length}\nBuscando para: ${date}\n` +
    `Store: ${store.name}\n\n_Barrido diario en la liberación de las 00:01._`;
}

/**
 * Qué quiso decir el usuario. Escribir comandos es una barrera: si manda
 * "mail contraseña" es un alta, y si manda "bariloche salta" es una búsqueda.
 */
export function comandoDe(text, user) {
  const tokens = String(text).trim().split(/\s+/);
  if (tokens[0].startsWith('/')) {
    return { cmd: tokens[0].toLowerCase().replace(/@.*$/, ''), args: tokens.slice(1) };
  }
  if (tokens.length >= 2 && tokens[0].includes('@') && tokens[0].includes('.')) {
    return { cmd: '/conectar', args: tokens };
  }
  if (estaConectado(user)) return { cmd: '/buscar', args: tokens };
  return { cmd: '/start', args: [] };
}

export async function handleCommand(text, { store, session, user, chatId }) {
  const { cmd, args } = comandoDe(text, user);

  // Un chat sin cuenta conectada igual es un chat: sin el chatId, `usaSemilla`
  // lo confundiría con el dueño del deploy y le sembraría las rutas ajenas.
  const perfil = user ?? (chatId ? { chatId: String(chatId) } : null);

  try {
    return await dispatch(cmd, args, { store, session, user: perfil, chatId });
  } catch (err) {
    // Un error de tipeo se contesta; los de sesión suben para que el webhook
    // dé la instrucción concreta de reconectar.
    if (err.name === 'SessionExpiredError') throw err;
    if (err.name === 'LoginError') return `🔴 ${err.message}`;
    if (err instanceof SinPaseError) return `⚠️ ${err.message}`;
    return mensajeDeError(err);
  }
}

/** Los que le pegan a JetSmart: sin cuenta conectada no hay nada que consultar. */
export const NECESITA_SESION = ['/buscar', '/estado', '/pase'];

async function dispatch(cmd, args, { store, session, user, chatId }) {
  switch (cmd) {
    case '/start':
      return estaConectado(user)
        ? (await botonesOrigen(store, '👋 Ya estás conectado. ¿Desde dónde volás?')) ?? AYUDA
        : BIENVENIDA;
    case '/ayuda':
    case '/help':
      return estaConectado(user) ? AYUDA : `${AYUDA}\n\n${BIENVENIDA}`;
    case '/conectar':
      return cmdConectar(store, chatId, user, args);
    case '/pase':
      return cmdPase(store, chatId, user, args);
    case '/desconectar':
    case '/borrarcuenta':
      return cmdDesconectar(store, chatId);
    case '/rutas':
      return cmdRutas(store, user);
    case '/buscar':
      return cmdBuscar(store, session, user, args);
    case '/vigilar':
      return cmdVigilar(store, user, args);
    case '/borrar':
      return cmdBorrar(store, user, args);
    case '/cookie':
    case '/sesion':
      return cmdCookie(store, user, args);
    case '/aeropuertos':
    case '/red':
      return cmdAeropuertos(store, args);
    case '/estado':
      return cmdEstado(store, session, user);
    default:
      return `No conozco \`${cmd}\`.\n\n${AYUDA}`;
  }
}

export { NO_CONECTADO };
