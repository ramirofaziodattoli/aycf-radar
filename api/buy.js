// Compra automática del dueño. Lo disparan los crons de la madrugada (00:00, 00:13,
// 00:30 y cada hora): cada invocación decide por la hora ART qué ventana le toca.
//
// Sólo el dueño: la tarjeta vive en una env var (AYCF_CARD) que cargó él en
// Vercel. Nunca se loguea ni viaja por Telegram.

import { createStore } from '../src/store.js';
import { withSession } from '../src/session.js';
import { scoped, envUser } from '../src/users.js';
import { ordersDueTonight, getOrder } from '../src/orders.js';
import { runBuy, deadlineAR } from '../src/buy.js';
import { reply } from '../src/notify.js';
import { tomorrowInAR } from '../src/radar.js';

const minutosART = (now) => {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  return ar.getUTCHours() * 60 + ar.getUTCMinutes();
};

/**
 * Vercel corta cada función a los 800 s, y la ventana de compra dura 20 minutos:
 * se reparte entre dos invocaciones. La de las 00:00 compra hasta las 00:12; la
 * de las 00:13 (el rescate) hasta las 00:20 y espera el lock de la anterior
 * (6 min), porque puede seguir viva. Esas dos avisan si no hubo cupo
 * (`avisarSinCupo`). Cualquier otra hora es una pasada corta, sin esperar y
 * callada: reintenta lo que haya quedado pendiente y suelta. Desde las 23:00
 * (`cierre`) la pasada es la última para los vuelos de mañana: lo que no se
 * compró ahí queda `fallido` (o `parcial`). El handler cruza `cierre` con la fecha
 * de cada pedido.
 */
export function ventanaDe(now = new Date()) {
  const m = minutosART(now);
  if (m >= 0 && m <= 4) return { deadline: deadlineAR('00:12', now), esperarLockMs: 0, avisarSinCupo: true, cierre: false };
  if (m >= 12 && m <= 16) return { deadline: deadlineAR('00:20', now), esperarLockMs: 360_000, avisarSinCupo: true, cierre: false };
  return { deadline: now.getTime() + 60_000, esperarLockMs: 0, avisarSinCupo: false, cierre: m >= 23 * 60 };
}

function leerTarjeta() {
  try {
    const c = JSON.parse(process.env.AYCF_CARD);
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null; // sin detalle: el mensaje de error de JSON.parse podría citar la tarjeta
  }
}

// `_runBuy` y `_withSession` son costuras de test: la compra real pega a Caravelo.
export default async function handler(req, res, {
  now = new Date(), _runBuy = runBuy, _withSession = withSession,
} = {}) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Kill switch: apagado no toca ni el store.
  if (process.env.AUTO_BUY !== 'on') return res.status(200).json({ ok: true, skipped: 'auto-buy-off' });
  // Prendido y sin secreto, cualquiera dispararía compras con la tarjeta: se falla cerrado.
  if (!secret) {
    console.error('buy: AUTO_BUY=on sin CRON_SECRET, no corro');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET requerido' });
  }

  try {
    const dueno = envUser();
    if (!dueno) {
      // Sin cuenta del dueño no hay sesión con la que comprar: que se entere.
      if (process.env.TELEGRAM_CHAT_ID) {
        await reply('🔴 AUTO_BUY está prendido pero no hay cuenta del dueño cargada (AYCF_EMAIL / AYCF_PASS_ID)').catch(() => {});
      }
      return res.status(200).json({ ok: true, skipped: 'sin-dueno' });
    }
    const store = scoped(createStore(), dueno.chatId);

    // ?order=<id> re-corre un pedido confirmado (para probar). No fuerza nada: un
    // pedido en otro estado llega a runBuy y vuelve sin tocarse.
    const q = req.query?.order;
    const id = Array.isArray(q) ? q[0] : q;
    const pedidos = id ? [await getOrder(store, id)].filter(Boolean) : await ordersDueTonight(store);
    if (!pedidos.length) return res.status(200).json({ ok: true, orders: [] });

    // Recién acá se pide la tarjeta: sin pedidos, que falte no es un problema.
    const card = leerTarjeta();
    if (!card) {
      await reply('🔴 Tengo pedidos para esta noche pero no está cargada la tarjeta (AYCF_CARD)').catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'sin-tarjeta' });
    }

    const { deadline, esperarLockMs, avisarSinCupo, cierre } = ventanaDe(now);
    // Hasta validar el parser de reservas con una compra real, apagado: un pago
    // ambiguo queda dudoso en vez de reintentarse.
    const bookingsCalibrado = process.env.AYCF_BOOKINGS_CALIBRADO === 'on';
    const mañana = tomorrowInAR(now);
    const orders = [];
    // En serie: un solo Caravelo y una sola tarjeta.
    for (const order of pedidos) {
      // Un pedido que revienta no puede dejar sin compra a los que siguen.
      try {
        const r = await _withSession(store, (session) => _runBuy({
          order, store, session, chatId: undefined, card, deadline, esperarLockMs,
          avisarSinCupo, bookingsCalibrado,
          // El cierre es sólo para el vuelo de mañana: un ?order de otra fecha no se cierra.
          cierre: cierre && order.fechaVuelo === mañana,
        }), dueno);
        orders.push({ id: order.id, estado: r.estado });
      } catch (err) {
        console.error(`buy ${order.id}: ${err.message}`); // sólo el mensaje: nunca el body ni la tarjeta
        orders.push({ id: order.id, error: 'interno' });
      }
    }
    const fallo = orders.every((o) => o.error);
    return res.status(fallo ? 500 : 200).json({ ok: !fallo, orders });
  } catch (err) {
    console.error(`buy: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'fallo interno' });
  }
}
