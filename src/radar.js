// Orquestación: barrer los watches activos, deduplicar y notificar.

import { createStore } from './store.js';
import { withSession, SessionExpiredError } from './session.js';
import { tieneCredenciales } from './login.js';
import { search } from './jetsmart.js';
import { appliesTo, matchFlight, watchLabel } from './watches.js';
import { resolveWatches } from './config.js';
import { notifyHits, notifyEmpty, notifyError } from './notify.js';

/** D+1 en hora argentina. Argentina es UTC-3 fijo, sin DST desde 2009. */
export function tomorrowInAR(now = new Date()) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  ar.setUTCDate(ar.getUTCDate() + 1);
  return ar.toISOString().slice(0, 10);
}

/**
 * ¿Es la corrida de la liberación? A las 00:01 ART sale el inventario del día
 * siguiente y es EL momento del día: ahí se avisa siempre, aunque no haya nada,
 * porque un "no hay cupo" a esa hora es lo que dispara el plan B.
 *
 * La ventana arranca en :01 a propósito: el cron de cada 15 minutos pega a las
 * 00:00, un minuto antes de que se libere, y esa corrida no confirma nada.
 */
export function isReleaseRun(now = new Date()) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  return ar.getUTCHours() === 0 && ar.getUTCMinutes() >= 1 && ar.getUTCMinutes() <= 5;
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
    const flights = await _search(session, { from: ruta.from, to: ruta.to, date }, store);
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

  // En la corrida de la liberación se avisa siempre, con o sin cupo.
  const release = isReleaseRun();
  const avisar = hits.length > 0 || release || process.env.NOTIFY_EMPTY === 'true';

  // Encontrar vuelos y no poder avisar es una falla, no un éxito: si el token de
  // Telegram murió, el radar seguiría reportando ok con el dashboard en verde.
  let notified = null;
  if (notify && avisar) {
    notified = hits.length
      ? await notifyHits(hits, date, release)
      : await notifyEmpty(date, rutas.length, release);
    if (!notified) console.error('¡No se pudo notificar por ningún canal!');
  }

  return {
    date,
    scanned,
    ...(notified === false ? { ok: false, error: 'notify-failed' } : {}),
    hits: hits.map(({ watch, flights }) => ({
      watch: watchLabel(watch),
      flights: flights.map((f) => ({ code: f.code, at: f.departsHHMM, seats: f.seats })),
    })),
  };
}

/** Punto de entrada compartido por el cron y el runner local. */
export async function runRadar({ date, watchesRaw } = {}) {
  const store = createStore();
  let session;

  // TODO lo que pueda fallar va adentro del try. Antes, un WATCHES mal formado o
  // una sesión sin sembrar tiraban un 500 mudo: sin Telegram, sin log útil, y
  // desde afuera indistinguible de "no hay vuelos".
  try {
    const watches = await resolveWatches(store, watchesRaw);
    const target = date || tomorrowInAR();
    return await withSession(store, (s) => {
      session = s;
      return runSweep({ date: target, watches, store, session: s });
    });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // Si no la borramos, la sesión muerta le gana a AYCF_COOKIE en el próximo
      // load() y re-sembrar la semilla no arregla nada. `session` puede no existir
      // todavía si el load() fue justo lo que falló.
      if (session) await session.invalidate();
      await notifyError(
        `Sesión de JetSmart caída: ${err.detalle}\n\n` +
        (tieneCredenciales()
          ? 'El re-login automático también falló. Revisá `AYCF_EMAIL` / `AYCF_PASSWORD`.'
          : 'Cargá `AYCF_EMAIL` y `AYCF_PASSWORD` para que me loguee solo, o mandame un `/cookie`.')
      );
      return { ok: false, error: 'session-expired', detalle: err.detalle };
    }
    await notifyError(`Error inesperado: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
