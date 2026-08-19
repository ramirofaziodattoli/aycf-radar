// Webhook del bot. Telegram postea acá cada mensaje.
//
// El bot es multi-usuario: cada chat trae SU cuenta de JetSmart (`/conectar`) y
// vive en su propio namespace del store. Lo que protege esto:
//   1. El secreto del webhook, que Telegram manda en un header. Sin esto
//      cualquiera que adivine la URL le habla al bot.
//   2. El namespace por chat: nadie puede consultar el pase de otro, porque la
//      sesión y las credenciales se resuelven a partir del chat que escribe.
//   3. TELEGRAM_ALLOWED_CHATS (opcional): si querés que sea un bot privado, poné
//      ahí los chats permitidos separados por coma.

import { createStore } from '../src/store.js';
import { withSession, SessionExpiredError } from '../src/session.js';
import { handleCommand, NECESITA_SESION, NO_CONECTADO } from '../src/commands.js';
import { reply, deleteMessage } from '../src/notify.js';
import { scoped, getUser, estaConectado } from '../src/users.js';

const permitido = (chatId) => {
  const lista = (process.env.TELEGRAM_ALLOWED_CHATS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return lista.length === 0 || lista.includes(String(chatId));
};

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

  if (!permitido(chatId)) {
    console.warn(`chat no autorizado: ${chatId}`);
    return res.status(200).json({ ok: true, skipped: 'chat no autorizado' });
  }

  try {
    const base = createStore();
    const store = scoped(base, chatId);
    const user = await getUser(base, chatId);

    const cmd = texto.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');

    // La contraseña no se queda en el historial del chat si podemos evitarlo.
    if (cmd === '/conectar') await deleteMessage(chatId, msg.message_id).catch(() => {});
    if (NECESITA_SESION.includes(cmd) && !estaConectado(user)) {
      await reply(NO_CONECTADO, chatId);
      return res.status(200).json({ ok: true, skipped: 'sin cuenta' });
    }

    // Solo los comandos que tocan JetSmart necesitan sesión. withSession se
    // encarga de reloguear y reintentar si la que había estaba vencida.
    const ctx = { store, user, chatId };
    const respuesta = NECESITA_SESION.includes(cmd)
      ? await withSession(store, (session) => handleCommand(texto, { ...ctx, session }), user)
      : await handleCommand(texto, { ...ctx, session: null });
    await reply(respuesta, chatId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const detalle = err instanceof SessionExpiredError
      ? `Sesión de JetSmart caída: ${err.detalle}\n\nReconectá con \`/conectar\`.`
      : `Error: ${err.message}`;
    await reply(`🔴 ${detalle}`, chatId).catch(() => {});
    return res.status(200).json({ ok: false, error: err.message });
  }
}
