// Orquestación: barrer los watches activos, deduplicar y notificar.

import { createStore } from './store.js';
import { withSession, SessionExpiredError } from './session.js';
import { tieneCredenciales } from './login.js';
import { scoped, listUsers, envUser, usaSemilla } from './users.js';
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
 * La ventana arranca en :01 a propósito: una corrida a las 00:00 pega un minuto
 * antes de que se libere el inventario y no confirma nada.
 */
export function isReleaseRun(now = new Date()) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  return ar.getUTCHours() === 0 && ar.getUTCMinutes() >= 1 && ar.getUTCMinutes() <= 5;
}

/**
 * Bandera por usuario: la corrida de la liberación falló (Caravelo saturado a las
 * 00:01, medido el 06 y 07/10) y la próxima pasada tiene que hacer de 00:01,
 * con o sin cupo. Vale una hora: alcanza para los rescates de las 00:10 y 00:20.
 */
export const RELEASE_PENDING = 'release-pending';

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

// `_search` es una costura para testear sin pegarle a la red; `release` se decide
// afuera para que todos los usuarios de una corrida compartan el mismo criterio.
export async function runSweep({
  date, watches, store, session, chatId, notify = true, release = isReleaseRun(), _search = search,
}) {
  const activos = watches.filter((w) => appliesTo(w, date));
  if (activos.length === 0) return { date, scanned: 0, hits: [], skipped: watches.length };

  const rutas = groupByRoute(activos);
  const hits = [];
  const vistos = [];
  let scanned = 0;

  for (const ruta of rutas) {
    const flights = await _search(session, { from: ruta.from, to: ruta.to, date }, store);
    scanned++;

    for (const watch of ruta.watches) {
      const match = flights.filter((f) => matchFlight(watch, f));
      if (match.length === 0) continue;

      // Dedupe: si el barrido corre seguido, sin esto te spamea el mismo vuelo
      // hasta que salga. Solo avisamos de lo que no vimos antes. Se marca como
      // visto DESPUÉS de avisar: si el barrido muere en la ruta 2, lo de la ruta 1
      // tiene que seguir siendo nuevo para la pasada de rescate.
      const nuevos = [];
      for (const f of match) {
        const key = dedupeKey(date, watch, f);
        if (await store.get(key)) continue;
        vistos.push({ key, seats: f.seats });
        nuevos.push(f);
      }
      if (nuevos.length) hits.push({ watch, flights: nuevos });
    }
  }

  // En la corrida de la liberación se avisa siempre, con o sin cupo. Y si la de
  // las 00:01 falló y dejó la bandera, esta pasada hace de liberación.
  const pendiente = (await store.get(RELEASE_PENDING)) === date;
  const esLiberacion = release || pendiente;
  const avisar = hits.length > 0 || esLiberacion || process.env.NOTIFY_EMPTY === 'true';

  // Encontrar vuelos y no poder avisar es una falla, no un éxito: si el token de
  // Telegram murió, el radar seguiría reportando ok con el dashboard en verde.
  let notified = null;
  if (notify && avisar) {
    notified = hits.length
      ? await notifyHits(hits, date, esLiberacion, chatId)
      : await notifyEmpty(date, rutas.length, esLiberacion, chatId);
    if (!notified) console.error('¡No se pudo notificar por ningún canal!');
  }

  // Recién ahora queda registrado. Si Telegram falló, no se marca nada: la
  // próxima pasada lo vuelve a intentar en vez de darlo por avisado.
  if (notified !== false) {
    for (const { key, seats } of vistos) await store.set(key, { seats }, 60 * 60 * 36);
    if (pendiente) await store.set(RELEASE_PENDING, null, 1);
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

/**
 * Un barrido para UN usuario. El store viene ya acotado a su namespace, la sesión
 * usa sus credenciales y los avisos van a su chat.
 */
export async function runRadar({
  date, watchesRaw, user = envUser() ?? { env: true }, release = isReleaseRun(),
} = {}) {
  const base = createStore();
  const store = user.chatId ? scoped(base, user.chatId) : base;
  const chatId = user.env ? undefined : user.chatId; // el dueño usa el chat de env
  let session;
  let target;

  // TODO lo que pueda fallar va adentro del try. Antes, un WATCHES mal formado o
  // una sesión sin sembrar tiraban un 500 mudo: sin Telegram, sin log útil, y
  // desde afuera indistinguible de "no hay vuelos".
  try {
    const watches = await resolveWatches(store, watchesRaw, { seed: usaSemilla(user) });
    if (!watches.length) return { ok: true, chatId: user.chatId, skipped: 'sin rutas' };

    target = date || tomorrowInAR();
    return await withSession(store, (s) => {
      session = s;
      return runSweep({ date: target, watches, store, session: s, chatId, release });
    }, user);
  } catch (err) {
    // La liberación falló: que la pasada de rescate avise como si fuera esta.
    // Sin la bandera, el "sin cupo" que dispara el plan B se pierde.
    if (release && target) await store.set(RELEASE_PENDING, target, 60 * 60).catch(() => {});

    if (err instanceof SessionExpiredError) {
      // Si no la borramos, la sesión muerta le gana a AYCF_COOKIE en el próximo
      // load() y re-sembrar la semilla no arregla nada. `session` puede no existir
      // todavía si el load() fue justo lo que falló.
      if (session) await session.invalidate();
      await notifyError(
        `Sesión de JetSmart caída: ${err.detalle}\n\n` +
        (tieneCredenciales(user)
          ? 'El re-login automático también falló. Revisá tu mail y contraseña con `/conectar`.'
          : 'Conectá tu cuenta con `/conectar` para que me loguee solo, o mandame un `/cookie`.'),
        chatId
      );
      return { ok: false, chatId: user.chatId, error: 'session-expired', detalle: err.detalle };
    }
    await notifyError(`Error inesperado: ${err.message}`, chatId);
    return { ok: false, chatId: user.chatId, error: err.message };
  }
}

/** Punto de entrada del cron: todos los usuarios conectados, uno por uno. */
export async function runAllRadars({ date } = {}) {
  const users = await listUsers(createStore());
  if (!users.length) return [await runRadar({ date })];

  const out = [];
  // Se decide una vez: el usuario 8 arranca después de las 00:05 y sigue siendo
  // la corrida de la liberación.
  const release = isReleaseRun();
  // En serie a propósito: Caravelo es la API de un tercero y no hace falta
  // martillarla con N usuarios en paralelo. Además el orden en serie es lo que
  // hace que los últimos entren cuando la estampida de las 00:01 ya pasó.
  // ponytail: ~30 s por usuario con Caravelo saturado; con maxDuration 800 entran
  // ~25 usuarios. Pasado eso, fan-out por usuario (una invocación cada uno).
  for (const user of users) {
    const t0 = Date.now();
    try {
      out.push({ chatId: user.chatId, ...(await runRadar({ date, user, release })) });
      console.log(`usuario ${user.chatId}: ${Date.now() - t0} ms`);
    } catch (err) {
      // El fallo de un usuario no puede dejar sin barrido a los demás.
      console.error(`usuario ${user.chatId}: ${err.message}`);
      out.push({ chatId: user.chatId, ok: false, error: err.message });
    }
  }
  return out;
}
