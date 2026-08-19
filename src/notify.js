// Salidas. Telegram es la principal; el webhook genérico existe para que cada uno
// lo enchufe a lo que use (Discord, Slack, ntfy, Home Assistant, lo que sea).

import { REDEMPTION_URL } from './jetsmart.js';
import { watchLabel } from './watches.js';

const money = (f) => (f.taxesText ? `${f.currency ?? ''} ${f.taxesText}`.trim() : null);

export function formatFlight(f) {
  return [
    `${f.code} · ${f.departsHHMM}→${f.arrivesHHMM}`,
    f.duration,
    `${f.seats} asiento${f.seats === 1 ? '' : 's'}`,
    money(f),
  ].filter(Boolean).join(' · ');
}

export function formatReport(hits, date, release = false) {
  const cuerpo = hits
    .map(({ watch, flights }) => {
      const lineas = [...flights]
        .sort((a, b) => String(a.departsAt).localeCompare(String(b.departsAt)))
        .map((f) => `   • ${formatFlight(f)}`)
        .join('\n');
      return `✅ *${watchLabel(watch)}*\n${lineas}`;
    })
    .join('\n\n');
  const total = hits.reduce((n, h) => n + h.flights.length, 0);
  const cabecera = release
    ? `🌙 *LIBERACIÓN 00:01* — ${total} vuelo(s) para el *${date}*`
    : `🛫 *AYCF* — ${total} vuelo(s) con cupo para el *${date}*`;
  return `${cabecera}\n\n${cuerpo}${release ? '\n\n⚡ Es el mejor momento del día: los cupos recién salieron.' : ''}`;
}

/** El "no hay nada" de las 00:01 es información, no ruido: dispara el plan B. */
export async function notifyEmpty(date, rutas, release = false, chatId) {
  const texto = release
    ? `🌙 *LIBERACIÓN 00:01* — sin cupo para el *${date}*\n\n` +
      `Se revisaron ${rutas} ruta(s) apenas salió el inventario. No hay nada.\n\n` +
      '_Si este vuelo era necesario, es momento del plan B._'
    : `🛫 *AYCF* — sin cupo para el *${date}* (${rutas} rutas).`;
  const [a, b] = await Promise.all([telegram(texto, false, chatId), webhook({ date, hits: [], release })]);
  return a || b;
}

// Ningún canal puede tumbar el barrido: que Telegram esté caído no es razón
// para perder el resto de la corrida. Cada uno se traga su error y devuelve false.
async function post(nombre, url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error(`${nombre}: ${r.status} ${await r.text().catch(() => '')}`);
    return r.ok;
  } catch (err) {
    console.error(`${nombre}: ${err.message}`);
    return false;
  }
}

/**
 * Respuesta directa del bot. `opts.buttons` es una grilla de [{text, data}] que
 * Telegram muestra como botones: para el que usa el bot, tocar es más fácil que
 * acordarse de un comando y un código IATA.
 */
export async function reply(text, chatId, opts = {}) {
  return telegram(text, opts.withButton ?? false, chatId, opts.buttons);
}

const teclado = (buttons) => ({
  inline_keyboard: buttons.map((fila) =>
    fila.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))
  ),
});

/** Reemplaza el mensaje anterior en vez de apilar uno nuevo por cada toque. */
export async function editMessage(chatId, messageId, text, buttons) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return false;
  return post('telegram-edit', `https://api.telegram.org/bot${token}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    ...(buttons?.length ? { reply_markup: teclado(buttons) } : {}),
  });
}

/** Telegram deja el botón "cargando" hasta que se contesta el callback. */
export async function answerCallback(id, text) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return false;
  return post('telegram-answer', `https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    callback_query_id: id,
    ...(text ? { text } : {}),
  });
}

// `chatId` es de quién es el mensaje. Sin él cae al chat del dueño del deploy,
// que es lo correcto para el modo de un solo usuario.
async function telegram(text, withButton, chatId, buttons) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const markup = buttons?.length
    ? teclado(buttons)
    : withButton
      ? { inline_keyboard: [[{ text: '🎟️ Canjear ahora', url: REDEMPTION_URL }]] }
      : null;
  return post('telegram', `https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });
}

/**
 * Borra un mensaje del chat. Se usa con `/conectar`: la contraseña queda escrita
 * en el historial de Telegram y ahí no tiene por qué vivir. Best-effort — si el
 * bot no puede borrar, el mensaje de respuesta le pide al usuario que lo borre.
 */
export async function deleteMessage(chatId, messageId) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token || !chatId || !messageId) return false;
  return post('telegram-delete', `https://api.telegram.org/bot${token}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function webhook(payload) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return false;
  return post('webhook', url, payload);
}

export async function notifyHits(hits, date, release = false, chatId) {
  const text = formatReport(hits, date, release);
  const payload = {
    date,
    hits: hits.map(({ watch, flights }) => ({ watch: watchLabel(watch), flights })),
  };
  const [a, b] = await Promise.all([telegram(text, true, chatId), webhook(payload)]);
  return a || b;
}

/** Los errores avisan siempre: un cron que falla callado es peor que no tenerlo. */
export async function notifyError(message, chatId) {
  console.error(message);
  await Promise.all([
    telegram(`🔴 *AYCF Radar*\n\n${message}`, false, chatId),
    webhook({ error: message }),
  ]);
}
