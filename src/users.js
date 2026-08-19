// Multi-usuario: cada chat de Telegram tiene SU cuenta de JetSmart, sus rutas y
// su sesión. Nadie ve ni usa el pase de otro.
//
// El aislamiento es una sola idea: el store se envuelve y todas las claves quedan
// bajo `u:{chatId}:`. Así session.js, config.js y radar.js siguen escribiendo las
// mismas claves de siempre sin enterarse de que hay más de un usuario.
// La única excepción es el catálogo de aeropuertos, que es de la red y es igual
// para todos.

import { encrypt, decrypt, haySecreto } from './crypto.js';

const IDX = 'users';
const rowKey = (chatId) => `user:${chatId}`;

/** Vista del store con las claves prefijadas por usuario. */
export function scoped(store, ns) {
  const k = (key) => (key.startsWith('catalog:') ? key : `u:${ns}:${key}`);
  return {
    name: store.name,
    // `raw` es el store sin prefijo: el registro de usuarios es global, no de nadie.
    raw: store,
    get: (key) => store.get(k(key)),
    set: (key, value, ttl) => store.set(k(key), value, ttl),
  };
}

/**
 * El dueño del deploy, configurado por env vars. Existe para que el que hostea
 * no tenga que registrarse contra su propio bot, y para que los deploys que ya
 * venían andando de a uno sigan andando igual.
 */
export function envUser() {
  if (!process.env.AYCF_EMAIL && !process.env.AYCF_PASS_ID) return null;
  return {
    chatId: process.env.TELEGRAM_CHAT_ID || 'env',
    email: process.env.AYCF_EMAIL || null,
    password: process.env.AYCF_PASSWORD || null,
    passId: process.env.AYCF_PASS_ID || null,
    env: true,
  };
}

export const esDueno = (chatId) =>
  Boolean(process.env.TELEGRAM_CHAT_ID) && String(chatId) === String(process.env.TELEGRAM_CHAT_ID);

export async function getUser(store, chatId) {
  const row = await store.get(rowKey(chatId));
  if (!row) return esDueno(chatId) ? envUser() : null;
  return {
    chatId: String(chatId),
    email: row.email ?? null,
    passId: row.passId ?? null,
    password: row.password ? decrypt(row.password) : null,
  };
}

/** Alta o actualización parcial. La contraseña entra cifrada o no entra. */
export async function saveUser(store, chatId, data) {
  const id = String(chatId);
  const previo = (await store.get(rowKey(id))) ?? {};
  const row = { ...previo };

  if (data.email !== undefined) row.email = data.email;
  if (data.passId !== undefined) row.passId = data.passId;
  if (data.password !== undefined) {
    if (!haySecreto()) throw new Error('el bot no tiene SECRET_KEY configurada: no puedo guardar tu contraseña');
    row.password = encrypt(data.password);
  }

  await store.set(rowKey(id), row);
  const lista = (await store.get(IDX)) ?? [];
  if (!lista.includes(id)) await store.set(IDX, [...lista, id]);
  return getUser(store, id);
}

export async function deleteUser(store, chatId) {
  const id = String(chatId);
  await store.set(rowKey(id), null, 1);
  const lista = (await store.get(IDX)) ?? [];
  await store.set(IDX, lista.filter((x) => x !== id));
  // La sesión guardada también se va: si no, queda una cookie viva de una cuenta
  // que el usuario pidió desconectar.
  await scoped(store, id).set('session:cookies', null, 1);
}

/** Todos los que hay que barrer en el cron, con el dueño incluido una sola vez. */
export async function listUsers(store) {
  const ids = (await store.get(IDX)) ?? [];
  const users = [];
  for (const id of ids) {
    const u = await getUser(store, id);
    if (u) users.push(u);
  }
  const dueno = envUser();
  if (dueno && !users.some((u) => String(u.chatId) === String(dueno.chatId))) users.push(dueno);
  return users;
}

/**
 * ¿A este usuario le sembramos las rutas de la env var WATCHES? Solo al dueño del
 * deploy. Al resto le arrancaríamos el bot vigilando rutas ajenas.
 */
export const usaSemilla = (user) => Boolean(user?.env) || !user?.chatId || esDueno(user?.chatId);

export const estaConectado = (u) => Boolean(u?.passId && (u.email || u.env));
