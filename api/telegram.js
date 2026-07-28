// Webhook del bot. Telegram postea acá cada mensaje.
//
// La URL es pública, así que hay DOS candados y los dos son necesarios:
//   1. El secreto del webhook, que Telegram manda en un header. Sin esto
//      cualquiera que adivine la URL le habla al bot.
//   2. El chat autorizado. Sin esto, alguien que sume el bot a otro grupo
//      podría consultar tu cuenta de JetSmart.

import { createStore } from '../src/store.js';
import { withSession, SessionExpiredError } from '../src/session.js';
import { handleCommand } from '../src/commands.js';
import { reply } from '../src/notify.js';

export default async function handler(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const msg = req.body?.message ?? req.body?.edited_message;
  const texto = msg?.text;
  const chatId = String(msg?.chat?.id ?? '');

  // Siempre 200: si devolvemos error, Telegram reintenta el mismo update en loop.
  if (!texto) return res.status(200).json({ ok: true, skipped: 'sin texto' });

  if (chatId !== String(process.env.TELEGRAM_CHAT_ID)) {
    console.warn(`chat no autorizado: ${chatId}`);
    return res.status(200).json({ ok: true, skipped: 'chat no autorizado' });
  }

  try {
    const store = createStore();

    // Solo /buscar y /estado tocan JetSmart; el resto no necesita sesión.
    // withSession se encarga de reloguear y reintentar si estaba vencida.
    const necesitaSesion = /^\/(buscar|estado)\b/i.test(texto.trim());
    const respuesta = necesitaSesion
      ? await withSession(store, (session) => handleCommand(texto, { store, session }))
      : await handleCommand(texto, { store, session: null });
    await reply(respuesta);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const detalle = err instanceof SessionExpiredError
      ? `Sesión de JetSmart caída: ${err.detalle}\n\nActualizá \`AYCF_COOKIE\`.`
      : `Error: ${err.message}`;
    await reply(`🔴 ${detalle}`).catch(() => {});
    return res.status(200).json({ ok: false, error: err.message });
  }
}
