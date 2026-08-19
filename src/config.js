// De dónde salen los watches, por orden de prioridad:
//   1. El store (Redis/archivo) — lo que edités desde el bot con /vigilar
//   2. La env var WATCHES (JSON)
//   3. El archivo watches.json
//
// La env var y el archivo son la SEMILLA. En cuanto tocás algo desde Telegram,
// manda el store: si no, el bot te dejaría agregar rutas y el cron las ignoraría.

import { readFile } from 'node:fs/promises';
import { loadWatches } from './watches.js';

export const WATCHES_KEY = 'watches';

export async function readSeed() {
  if (process.env.WATCHES) return process.env.WATCHES;
  const path = process.env.WATCHES_FILE || 'watches.json';
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No hay watches: definí la env var WATCHES (JSON) o creá ${path}. ` +
      'Tenés un ejemplo en watches.example.json'
    );
  }
}

/**
 * Devuelve los watches vigentes, sembrando el store la primera vez.
 *
 * `seed: false` para los usuarios del bot: la semilla de env es la lista de rutas
 * del dueño del deploy, y arrancar a todo el mundo vigilando las rutas de otro
 * sería spam. Ellos arrancan vacíos y suman con /vigilar.
 */
export async function resolveWatches(store, raw, { seed = true } = {}) {
  const guardados = await store.get(WATCHES_KEY);
  if (Array.isArray(guardados)) return guardados.length ? loadWatches(guardados) : [];
  if (!seed) return [];

  const semilla = loadWatches(raw ?? (await readSeed()));
  await store.set(WATCHES_KEY, semilla);
  return semilla;
}

export async function saveWatches(store, list) {
  // Vaciar la lista es una operación válida desde el bot; loadWatches no la acepta.
  const validos = Array.isArray(list) && list.length === 0 ? [] : loadWatches(list);
  await store.set(WATCHES_KEY, validos);
  return validos;
}

// Compatibilidad con el runner local y el cron.
export const readWatches = readSeed;
