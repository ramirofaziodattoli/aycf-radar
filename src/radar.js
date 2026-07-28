// Orquestación: barrer los watches activos, deduplicar y notificar.

import { createStore } from './store.js';
import { Session, SessionExpiredError } from './session.js';
import { search } from './jetsmart.js';
import { appliesTo, matchFlight, loadWatches, watchLabel } from './watches.js';
import { notifyHits, notifyError } from './notify.js';

/** D+1 en hora argentina. Argentina es UTC-3 fijo, sin DST desde 2009. */
export function tomorrowInAR(now = new Date()) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  ar.setUTCDate(ar.getUTCDate() + 1);
  return ar.toISOString().slice(0, 10);
}

export function dedupeKey(date, watch, flight) {
  return `seen:${date}|${watch.from}-${watch.to}|${flight.code}`;
}

/** Agrupa por ruta para no repetir el request cuando dos watches comparten tramo. */
export function groupByRoute(watches) {
  const m = new Map();
  for (const w of watches) {
    const k = `${w.from}-${w.to}`;
    if (!m.has(k)) m.set(k, { from: w.from, to: w.to, watches: [] });
    m.get(k).watches.push(w);
  }
  return [...m.values()];
}

// `_search` es una costura para testear sin pegarle a la red.
export async function runSweep({ date, watches, store, session, notify = true, _search = search }) {
  const activos = watches.filter((w) => appliesTo(w, date));
  if (activos.length === 0) return { date, scanned: 0, hits: [], skipped: watches.length };

  const rutas = groupByRoute(activos);
  const hits = [];
  let scanned = 0;

  for (const ruta of rutas) {
    const flights = await _search(session, { from: ruta.from, to: ruta.to, date });
    scanned++;

    for (const watch of ruta.watches) {
      const match = flights.filter((f) => matchFlight(watch, f));
      if (match.length === 0) continue;

      // Dedupe: si esto corre cada 15 min, sin esto te spamea el mismo vuelo
      // hasta que salga. Solo avisamos de lo que no vimos antes.
      const nuevos = [];
      for (const f of match) {
        const key = dedupeKey(date, watch, f);
        if (await store.get(key)) continue;
        await store.set(key, { seats: f.seats }, 60 * 60 * 36);
        nuevos.push(f);
      }
      if (nuevos.length) hits.push({ watch, flights: nuevos });
    }
  }

  if (notify && hits.length) await notifyHits(hits, date);

  return {
    date,
    scanned,
    hits: hits.map(({ watch, flights }) => ({
      watch: watchLabel(watch),
      flights: flights.map((f) => ({ code: f.code, at: f.departsHHMM, seats: f.seats })),
    })),
  };
}

/** Punto de entrada compartido por el cron y el runner local. */
export async function runRadar({ date, watchesRaw } = {}) {
  const store = createStore();
  const watches = loadWatches(watchesRaw ?? process.env.WATCHES ?? '[]');
  const session = await new Session(store).load();
  const target = date || tomorrowInAR();

  try {
    return await runSweep({ date: target, watches, store, session });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // Clave: si no la borramos, la sesión muerta le gana a AYCF_COOKIE en el
      // próximo load() y re-sembrar la semilla no arregla nada.
      await session.invalidate();
      await notifyError(
        'Sesión de JetSmart vencida.\n\n' +
        'Entrá al portal, copiá la cookie nueva y actualizá `AYCF_COOKIE`.\n' +
        '_(El keep-alive la renueva sola mientras el cron corra cada <30 min; ' +
        'si llegaste acá es que estuvo caído más que eso.)_'
      );
      return { ok: false, error: 'session-expired' };
    }
    await notifyError(`Error inesperado: ${err.message}`);
    throw err;
  }
}
