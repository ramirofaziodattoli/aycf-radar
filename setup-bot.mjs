// Configura el bot: menú de comandos + webhook. Idempotente, corrélo las veces que quieras.
//
//   node --env-file=.env setup-bot.mjs https://tu-deploy.vercel.app
//
// Hay que volver a correrlo cada vez que rotes el TELEGRAM_TOKEN: el webhook y su
// secreto viven atados al token, así que un /revoke deja al bot mudo hasta que
// se vuelva a registrar.

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.argv[2]?.replace(/\/$/, '');

if (!TOKEN) {
  console.error('❌ Falta TELEGRAM_TOKEN.');
  process.exit(1);
}

const COMANDOS = [
  { command: 'rutas', description: 'Las rutas que estoy vigilando' },
  { command: 'buscar', description: 'Buscar ahora — /buscar AEP SLA' },
  { command: 'vigilar', description: 'Sumar una ruta — /vigilar BRC EZE 2' },
  { command: 'borrar', description: 'Sacar una ruta — /borrar 3' },
  { command: 'estado', description: 'Ver si está todo funcionando' },
  { command: 'ayuda', description: 'Cómo se usa' },
];

async function api(metodo, body, intento = 1) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // La API de Telegram a veces cuelga la conexión (o el IPv6 no resuelve).
    if (intento < 3) return api(metodo, body, intento + 1);
    throw new Error(`${metodo}: no pude conectar con Telegram (${err.message})`);
  }
  const j = await r.json();
  if (!j.ok) throw new Error(`${metodo}: ${j.description}`);
  return j.result;
}

const yo = await api('getMe', {});
console.log(`Bot: @${yo.username}`);

await api('setMyCommands', { commands: COMANDOS });
console.log(`✅ ${COMANDOS.length} comandos en el menú`);

await api('setMyShortDescription', {
  short_description: 'Te aviso apenas hay cupo AYCF de JetSMART en tus rutas.',
});
await api('setMyDescription', {
  description:
    'Radar del pase All You Can Fly de JetSMART. Reviso tus rutas cada 15 minutos y ' +
    'te aviso apenas aparece cupo, con aviso garantizado a las 00:01 cuando se libera ' +
    'el día siguiente. Escribí /ayuda para empezar.',
});
console.log('✅ descripciones');

if (base) {
  if (!SECRET) {
    console.warn('⚠️  Sin TELEGRAM_WEBHOOK_SECRET: el webhook quedaría sin candado. Abortando.');
    process.exit(1);
  }
  await api('setWebhook', {
    url: `${base}/api/telegram`,
    secret_token: SECRET,
    allowed_updates: ['message'],
  });
  const info = await api('getWebhookInfo', {});
  console.log(`✅ webhook → ${info.url}`);
  if (info.last_error_message) console.warn(`⚠️  último error: ${info.last_error_message}`);
} else {
  console.log('\n(Pasá la URL del deploy como argumento para registrar también el webhook.)');
}
