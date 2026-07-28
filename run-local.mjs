// Corre un barrido en tu máquina, sin deployar.
//
//   node --env-file=.env run-local.mjs              → los vuelos de mañana
//   node --env-file=.env run-local.mjs 2026-08-13   → una fecha puntual
//
// El estado (sesión + dedupe) va a .state.json salvo que configures Redis.

import { runRadar } from './src/radar.js';
import { readWatches } from './src/config.js';

const date = process.argv[2];

const faltan = ['AYCF_COOKIE', 'AYCF_PASS_ID'].filter((k) => !process.env[k]);
if (faltan.length) {
  console.error(`❌ Faltan en .env: ${faltan.join(', ')}. Mirá .env.example`);
  process.exit(1);
}
if (!process.env.TELEGRAM_TOKEN) {
  console.warn('⚠️  Sin TELEGRAM_TOKEN: no se notifica, solo se imprime acá.\n');
}

try {
  const out = await runRadar({ date, watchesRaw: await readWatches() });
  console.log(JSON.stringify(out, null, 2));
  if (out.hits?.length === 0) {
    console.log('\nSin novedades. Ojo: lo ya notificado no se repite (dedupe).');
    console.log('Para volver a verlo todo: rm .state.json');
  }
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
