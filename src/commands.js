// Comandos del bot. Cada handler devuelve el texto a responder.

import { search } from './jetsmart.js';
import { tomorrowInAR } from './radar.js';
import { validateWatch, watchLabel, matchFlight } from './watches.js';
import { resolveWatches, saveWatches } from './config.js';
import { formatFlight } from './notify.js';

const AYUDA = `🛩️ *AYCF Radar*

/rutas — las rutas que estoy vigilando
/buscar \`ORIGEN DESTINO\` — busco ahora mismo (ej: \`/buscar AEP SLA\`)
/vigilar \`ORIGEN DESTINO [asientos]\` — sumo una ruta
/borrar \`N\` — saco la ruta N de la lista
/estado — cómo viene todo

_Solo se puede consultar el día siguiente: el pase libera los cupos a las 00:01
y no existe inventario más allá de eso._`;

function parseRuta(args) {
  const [from, to] = args.map((a) => a.toUpperCase());
  if (!/^[A-Z]{3}$/.test(from || '') || !/^[A-Z]{3}$/.test(to || '')) {
    throw new Error('Necesito dos códigos IATA de 3 letras. Ej: `AEP SLA`');
  }
  return { from, to };
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
  const { from, to } = parseRuta(args);
  const date = tomorrowInAR();
  const flights = await search(session, { from, to, date });
  if (!flights.length) return `❌ *${from}→${to}* — sin cupo para el ${date}.`;
  const lineas = flights
    .sort((a, b) => String(a.departsAt).localeCompare(String(b.departsAt)))
    .map((f) => `   • ${formatFlight(f)}`)
    .join('\n');
  return `✅ *${from}→${to}* — ${flights.length} vuelo(s) el ${date}\n${lineas}`;
}

async function cmdVigilar(store, args) {
  const { from, to } = parseRuta(args);
  const minSeats = args[2] ? Number(args[2]) : 1;
  const nuevo = validateWatch({ from, to, ...(minSeats > 1 ? { minSeats } : {}) }, 0);

  const watches = await resolveWatches(store);
  if (watches.some((w) => w.from === from && w.to === to && (w.minSeats ?? 1) === minSeats)) {
    return `Ya estaba vigilando *${from}→${to}*.`;
  }
  const actualizado = await saveWatches(store, [...watches, nuevo]);
  return `✅ Agregada *${from}→${to}*${minSeats > 1 ? ` con ≥${minSeats} asientos` : ''}.\n` +
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
  await search(session, { from: primera.from, to: primera.to, date });
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
    case '/estado':
      return cmdEstado(store, session);
    default:
      return `No conozco \`${cmd}\`.\n\n${AYUDA}`;
  }
}
