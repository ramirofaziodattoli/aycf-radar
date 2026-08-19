// Webhook del bot. Telegram postea acá cada mensaje y cada toque de botón.
//
// El bot es multi-usuario y de entrada abierta: cada chat trae SU cuenta de
// JetSmart y vive en su propio namespace del store. Lo que protege esto:
//   1. El secreto del webhook, que Telegram manda en un header. Sin esto
//      cualquiera que adivine la URL le habla al bot.
//   2. El namespace por chat: nadie puede consultar el pase de otro, porque la
//      sesión y las credenciales se resuelven a partir del chat que escribe.
//   3. TELEGRAM_ALLOWED_CHATS (opcional): si querés que sea un bot privado, poné
//      ahí los chats permitidos separados por coma.

import { createStore } from '../src/store.js';
import { withSession, SessionExpiredError } from '../src/session.js';
import { handleCommand, handleCallback, comandoDe, NECESITA_SESION, NO_CONECTADO } from '../src/commands.js';
import { reply, editMessage, answerCallback, deleteMessage } from '../src/notify.js';
import { scoped, getUser, estaConectado } from '../src/users.js';

const permitido = (chatId) => {
  const lista = (process.env.TELEGRAM_ALLOWED_CHATS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return lista.length === 0 || lista.includes(String(chatId));
};

/** Los handlers devuelven texto o { text, buttons }. */
const normalizar = (r) => (typeof r === 'string' ? { text: r } : r ?? { text: '…' });

export default async function handler(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const cb = req.body?.callback_query;
  const msg = cb?.message ?? req.body?.message ?? req.body?.edited_message;
  const texto = cb ? cb.data : msg?.text;
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
    const ctx = { store, user, chatId };

    // Un toque de botón no necesita el mismo ruteo que un comando: siempre
    // pertenece a alguien conectado y siempre reemplaza el mensaje anterior.
    if (cb) {
      await answerCallback(cb.id);
      if (!estaConectado(user)) {
        await editMessage(chatId, msg.message_id, NO_CONECTADO);
        return res.status(200).json({ ok: true, skipped: 'sin cuenta' });
      }
      const out = normalizar(await withSession(
        store, (session) => handleCallback(texto, { ...ctx, session }), user
      ));
      await editMessage(chatId, msg.message_id, out.text, out.buttons);
      return res.status(200).json({ ok: true });
    }

    // Qué quiso decir: puede no haber escrito ningún comando.
    const { cmd } = comandoDe(texto, user);

    // La contraseña no se queda en el historial del chat si podemos evitarlo.
    if (cmd === '/conectar') await deleteMessage(chatId, msg.message_id).catch(() => {});

    if (NECESITA_SESION.includes(cmd) && !estaConectado(user)) {
      await reply(NO_CONECTADO, chatId);
      return res.status(200).json({ ok: true, skipped: 'sin cuenta' });
    }

    // Solo los comandos que tocan JetSmart necesitan sesión. withSession se
    // encarga de reloguear y reintentar si la que había estaba vencida.
    const out = normalizar(NECESITA_SESION.includes(cmd)
      ? await withSession(store, (session) => handleCommand(texto, { ...ctx, session }), user)
      : await handleCommand(texto, { ...ctx, session: null }));
    await reply(out.text, chatId, { buttons: out.buttons });
    return res.status(200).json({ ok: true });
  } catch (err) {
    const detalle = err instanceof SessionExpiredError
      ? `No pude entrar a tu cuenta: ${err.detalle}\n\nReconectá mandándome tu mail y contraseña.`
      : `Error: ${err.message}`;
    await reply(`🔴 ${detalle}`, chatId).catch(() => {});
    return res.status(200).json({ ok: false, error: err.message });
  }
}
