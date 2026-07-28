// Comandos del bot. Cada handler devuelve el texto a responder.

import { search } from './jetsmart.js';
import { tomorrowInAR } from './radar.js';
import { validateWatch, watchLabel, matchFlight } from './watches.js';
import { resolveWatches, saveWatches } from './config.js';
import { formatFlight } from './notify.js';
import { getCatalog, resolveAirport, airportName, routeExists, destinationsFrom } from './airports.js';

const AYUDA = `🛩️ *AYCF Radar*

/rutas — las rutas que estoy vigilando
/buscar \`ORIGEN DESTINO\` — busco ahora mismo
/vigilar \`ORIGEN DESTINO [asientos]\` — sumo una ruta
/borrar \`N\` — saco la ruta N de la lista
/aeropuertos \`[ORIGEN]\` — la red de JetSMART, o los destinos desde un origen
/estado — cómo viene todo

Podés escribir el nombre de la ciudad en vez del código:
\`/buscar bariloche salta\` es lo mismo que \`/buscar BRC SLA\`.

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

async function cmdRutas(store) {
  const watches = await resolveWatches(store);
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

async function cmdBuscar(store, session, args) {
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

async function cmdVigilar(store, args) {
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

  const watches = await resolveWatches(store);
  if (watches.some((w) => w.from === from && w.to === to && (w.minSeats ?? 1) === minSeats)) {
    return `Ya estaba vigilando *${nombre}*.`;
  }
  const actualizado = await saveWatches(store, [...watches, { ...nuevo, label: nombre }]);
  return `✅ Agregada *${nombre}*${minSeats > 1 ? ` con ≥${minSeats} asientos` : ''}.\n` +
    `Ahora vigilo ${actualizado.length} rutas.`;
}

async function cmdBorrar(store, args) {
  const n = Number(args[0]);
  const watches = await resolveWatches(store);
  if (!Number.isInteger(n) || n < 1 || n > watches.length) {
    return `Decime un número del 1 al ${watches.length}. Mirá /rutas.`;
  }
  const [fuera] = watches.splice(n - 1, 1);
  await saveWatches(store, watches);
  return `🗑️ Saqué *${watchLabel(fuera)}*. Quedan ${watches.length}.`;
}

async function cmdEstado(store, session) {
  const watches = await resolveWatches(store);
  const date = tomorrowInAR();
  // Un request real: si la sesión estuviera caída, esto tira SessionExpiredError.
  const primera = watches[0];
  await search(session, { from: primera.from, to: primera.to, date }, store);
  return `✅ *Todo en orden*\n\n` +
    `Sesión: viva\nRutas: ${watches.length}\nBuscando para: ${date}\n` +
    `Store: ${store.name}\n\n_Barrido cada 15 min + uno dedicado a las 00:01._`;
}

export async function handleCommand(text, { store, session }) {
  const [raw, ...args] = text.trim().split(/\s+/);
  const cmd = raw.toLowerCase().replace(/@.*$/, '');

  try {
    return await dispatch(cmd, args, { store, session });
  } catch (err) {
    // Un error de tipeo se contesta; los de sesión suben para que el webhook
    // dé la instrucción concreta de re-sembrar la cookie.
    if (err.name === 'SessionExpiredError') throw err;
    return `⚠️ ${err.message}`;
  }
}

async function dispatch(cmd, args, { store, session }) {
  switch (cmd) {
    case '/start':
    case '/ayuda':
    case '/help':
      return AYUDA;
    case '/rutas':
      return cmdRutas(store);
    case '/buscar':
      return cmdBuscar(store, session, args);
    case '/vigilar':
      return cmdVigilar(store, args);
    case '/borrar':
      return cmdBorrar(store, args);
    case '/aeropuertos':
    case '/red':
      return cmdAeropuertos(store, args);
    case '/estado':
      return cmdEstado(store, session);
    default:
      return `No conozco \`${cmd}\`.\n\n${AYUDA}`;
  }
}
