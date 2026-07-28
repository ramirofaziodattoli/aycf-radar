// Los watches salen de la env var WATCHES (JSON) o del archivo watches.json.
// En Vercel conviene la env var; self-hosteando, el archivo es más cómodo.

import { readFile } from 'node:fs/promises';

export async function readWatches() {
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
