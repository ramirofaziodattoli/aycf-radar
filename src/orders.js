// Pedidos de compra automática: "quiero este vuelo, comprámelo a las 00:00".
//
// Un pedido vive en el store del usuario (scoped) y recorre estados:
// borrador → confirmado → comprado | parcial | dudoso | fallido (o cancelado). Acá solo está el
// modelo, la persistencia y el lock; la compra en sí es de otro módulo.

import { randomBytes } from 'node:crypto';
import { tomorrowInAR } from './radar.js';

const IDX = 'orders';
const TTL_PEDIDO = 30 * 24 * 3600;
const rowKey = (id) => `order:${id}`;
const lockKey = (id) => `order-lock:${id}`;
const cancelKey = (id) => `order-cancel:${id}`;
const TTL_CANCEL = 48 * 3600;
const IATA = /^[A-Z]{3}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ESTADOS = ['borrador', 'confirmado', 'comprado', 'parcial', 'dudoso', 'fallido', 'cancelado'];

/** Tira Error en español si el pedido no se puede comprar tal cual está. */
export function validateOrder(o) {
  if (!o || typeof o !== 'object') throw new Error('el pedido está vacío');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.fechaVuelo ?? '') || Number.isNaN(Date.parse(o.fechaVuelo))) {
    throw new Error('fechaVuelo tiene que ser YYYY-MM-DD');
  }
  if (!Array.isArray(o.tramos) || o.tramos.length === 0) throw new Error('el pedido necesita al menos un tramo');
  o.tramos.forEach((t, i) => {
    if (!IATA.test(t?.from ?? '') || !IATA.test(t?.to ?? '')) {
      throw new Error(`el tramo ${i + 1} necesita from y to como código IATA de 3 letras mayúsculas`);
    }
    // Se declara, no se adivina: AEP→EZE entre tramos es un traslado que no compramos.
    if (i > 0 && t.from !== o.tramos[i - 1].to) {
      throw new Error(`los tramos no encadenan: el ${i + 1} sale de ${t.from} y el ${i} llega a ${o.tramos[i - 1].to}`);
    }
    if (t.ventana != null) {
      const v = t.ventana;
      if (!Array.isArray(v) || v.length !== 2 || !HHMM.test(v[0]) || !HHMM.test(v[1])) {
        throw new Error(`la ventana del tramo ${i + 1} tiene que ser [HH:MM, HH:MM]`);
      }
    }
  });
  if (o.escalaMinimaHoras !== undefined && !(typeof o.escalaMinimaHoras === 'number' && o.escalaMinimaHoras > 0)) {
    throw new Error('escalaMinimaHoras tiene que ser un número mayor a 0');
  }
  return o;
}

export function newOrder({ chatId, fechaVuelo, tramos, escalaMinimaHoras = 2.5, preferencia = 'cualquier horario', topeTasasPorTramoARS = 40000 }) {
  return validateOrder({
    id: 'ord_' + randomBytes(5).toString('hex'),
    chatId: String(chatId),
    estado: 'borrador',
    creado: new Date().toISOString(),
    fechaVuelo,
    tramos,
    escalaMinimaHoras,
    preferencia,
    topeTasasPorTramoARS,
    intentos: [],
    resultado: null,
  });
}

export async function saveOrder(store, order) {
  const ids = (await store.get(IDX)) ?? [];
  await store.set(rowKey(order.id), order, TTL_PEDIDO);
  if (!ids.includes(order.id)) await store.set(IDX, [...ids, order.id]);
  return order;
}

export const getOrder = (store, id) => store.get(rowKey(id));

export async function listOrders(store, { estados } = {}) {
  const ids = (await store.get(IDX)) ?? [];
  const out = [];
  for (const id of ids) {
    const o = await getOrder(store, id);
    if (o && (!estados || estados.includes(o.estado))) out.push(o);
  }
  return out;
}

/** Cambia el estado y mezcla `extra`; `extra.intento` se suma a la lista de intentos. */
export async function setEstado(store, id, estado, extra = {}) {
  const o = await getOrder(store, id);
  if (!o) throw new Error(`no existe el pedido ${id}`);
  if (!ESTADOS.includes(estado)) throw new Error(`estado desconocido: ${estado}`);
  // La identidad del pedido no se toca por la ventana de `extra`.
  const { intento, id: _id, chatId: _chatId, fechaVuelo: _fecha, ...resto } = extra;
  const next = { ...o, ...resto, estado, intentos: intento ? [...o.intentos, intento] : o.intentos };
  await saveOrder(store, next);
  return next;
}

/**
 * Cancela un pedido por dos caminos. `setEstado` es leer-mezclar-escribir: si el
 * loop de compra está escribiendo su marcador de pago justo en ese momento, puede
 * pisar el `cancelado`. Por eso además va una clave aparte, un `set` plano que
 * nadie más escribe, y el loop la mira justo antes de pagar.
 */
export async function cancelOrder(store, id) {
  await store.set(cancelKey(id), new Date().toISOString(), TTL_CANCEL);
  return setEstado(store, id, 'cancelado');
}

/** ¿El usuario canceló este pedido? Lee sólo la clave aparte (ver `cancelOrder`). */
export const fueCancelado = async (store, id) => Boolean(await store.get(cancelKey(id)));

/** Los que hay que comprar esta noche: confirmados y para el vuelo de `date`. */
export async function ordersDueTonight(store, date = tomorrowInAR()) {
  return (await listOrders(store, { estados: ['confirmado'] })).filter((o) => o.fechaVuelo === date);
}

/**
 * Un pedido se compra una sola vez aunque lleguen dos crons juntos. El TTL es
 * la red de seguridad: si la función muere sin soltarlo, se libera solo.
 */
export const lockOrder = (store, id, ttlSeconds = 900, owner = 1) => store.setnx(lockKey(id), owner, ttlSeconds);

/**
 * Con `owner`, suelta el lock SOLO si sigue siendo nuestro: una corrida que se
 * pasó de su TTL no le puede borrar el lock a la que vino después. Leer, comparar
 * y borrar son tres pasos (no es atómico): la carrera es de milisegundos justo al
 * vencer el TTL y se acepta. Sin `owner`, borra a secas (uso manual).
 */
export async function unlockOrder(store, id, owner) {
  if (owner !== undefined && (await store.get(lockKey(id))) !== owner) return false;
  await store.del(lockKey(id));
  return true;
}

/** Re-`set` del lock con el mismo dueño y TTL nuevo. false = ya no es nuestro (no pagar). */
export async function renovarLock(store, id, owner, ttlSeconds) {
  if ((await store.get(lockKey(id))) !== owner) return false;
  await store.set(lockKey(id), owner, ttlSeconds);
  return true;
}

/** Hoy en Argentina (UTC-3 fijo, sin DST): a las 22 h ART en UTC ya es mañana. */
export const hoyEnAR = (now = new Date()) => new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

const sumarDias = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * ¿Lo compra una pasada horaria de hoy? El inventario de mañana ya se liberó a las
 * 00:01 de hoy y las pasadas (cada hora hasta las 23:00 ART) lo levantan; el resto
 * espera a la corrida de las 00:00 del día anterior al vuelo.
 */
export const esDeMañana = (o, hoy = hoyEnAR()) => o.fechaVuelo === sumarDias(hoy, 1);

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "2026-11-07" → "sábado 07/11". UTC a propósito: es una fecha de calendario, no un instante. */
export function fechaLarga(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dia = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dia} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/**
 * El día de la corrida que lo compra. El inventario de D+1 se libera a las 00:00
 * de D, así que un vuelo del sábado se compra al arrancar el viernes.
 */
export function nocheDeCompra(o) {
  return fechaLarga(sumarDias(o.fechaVuelo, -1));
}

/**
 * Una línea Markdown con todo lo que se va a pagar, para leerla antes de
 * confirmar: «📌 *Pedido* · sábado 07/11 · BRC → AEP (cualquier horario) · AEP → COR,
 * escala ≥ 2,5 h · lo busco el viernes 06/11 a las 00:00». El horario del primer
 * tramo es la ventana o, sin ventana, la preferencia; los siguientes dependen de
 * la escala, así que muestran eso (y su ventana si la tienen). Un vuelo de mañana
 * no espera a las 00:00: lo busca la próxima pasada horaria.
 */
export function formatPedido(o, { hoy = hoyEnAR() } = {}) {
  const tramos = o.tramos.map((t, i) => {
    const horario = t.ventana ? ` (${t.ventana[0]}–${t.ventana[1]})`
      : i === 0 ? ` (${o.preferencia ?? 'cualquier horario'})` : '';
    const escala = i > 0 ? `, escala ≥ ${String(o.escalaMinimaHoras).replace('.', ',')} h` : '';
    return `${t.from} → ${t.to}${horario}${escala}`;
  });
  const cuando = esDeMañana(o, hoy)
    ? 'lo busco en la próxima pasada (cada hora hasta las 23:00)'
    : `lo busco el ${nocheDeCompra(o)} a las 00:00`;
  return ['📌 *Pedido*', fechaLarga(o.fechaVuelo), ...tramos, cuando].join(' · ');
}
