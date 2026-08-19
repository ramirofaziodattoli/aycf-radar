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

/** Respuesta directa del bot, sin pasar por el formato de reporte. */
export async function reply(text, chatId, withButton = false) {
  return telegram(text, withButton, chatId);
}

// `chatId` es de quién es el mensaje. Sin él cae al chat del dueño del deploy,
// que es lo correcto para el modo de un solo usuario.
async function telegram(text, withButton, chatId) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  return post('telegram', `https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    ...(withButton
      ? { reply_markup: { inline_keyboard: [[{ text: '🎟️ Canjear ahora', url: REDEMPTION_URL }]] } }
      : {}),
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
