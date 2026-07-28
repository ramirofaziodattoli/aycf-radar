// Corre el radar en tu compu, sin deployar nada. Sirve para ver que funciona
// y para descubrir la forma real de un vuelo antes de que importe de verdad.
//
//   node --env-file=.env run-local.mjs              → busca los vuelos de mañana
//   node --env-file=.env run-local.mjs 2026-07-29   → busca una fecha puntual
//
// (Node trae --env-file nativo desde la v20, no hace falta instalar nada.)

import handler from './api/radar.js';

const date = process.argv[2];

const faltan = ['AYCF_COOKIE', 'AYCF_PASS_ID', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID']
  .filter((k) => !process.env[k]);
if (faltan.length) {
  console.error(`❌ Faltan variables en .env: ${faltan.join(', ')}`);
  console.error('   Copiá .env.example a .env y completalo.');
  process.exit(1);
}

// Imitamos lo que Vercel le pasa al handler: un request y un response.
// Incluido el Bearer con CRON_SECRET, que en prod lo inyecta Vercel solo.
const req = {
  headers: process.env.CRON_SECRET
    ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
    : {},
  query: date ? { date } : {},
};
const res = {
  status(code) {
    this.code = code;
    return this;
  },
  json(body) {
    console.log(`\n[${this.code}]`, JSON.stringify(body, null, 2));
    if (body.results?.every((r) => r.cupo === 0)) {
      console.log('\nSin cupo en ninguna ruta. El mensaje igual se mandó a Telegram.');
    }
  },
};

console.log(`Consultando ${date ? `el ${date}` : 'los vuelos de mañana'}...`);
await handler(req, res);
