// Cifrado de las credenciales que la gente le pasa al bot.
//
// El store es Redis compartido: guardar ahí la contraseña de JetSmart de otro en
// texto plano no es una opción. AES-256-GCM con clave derivada de SECRET_KEY.
// Sin SECRET_KEY el bot se niega a guardar contraseñas (no las guarda "por ahora
// en claro": eso es exactamente cómo se filtran).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Leído en cada uso, no al importar: cachear el env al cargar el módulo hace que
// el orden de los imports decida si hay clave o no.
const raw = () => process.env.SECRET_KEY || process.env.ENCRYPTION_KEY || '';

export const haySecreto = () => Boolean(raw());

// scrypt es caro a propósito (~100ms), así que la clave derivada se cachea.
const cache = new Map();
function key() {
  const secreto = raw();
  if (!secreto) throw new Error('falta SECRET_KEY: sin eso no guardo contraseñas');
  if (!cache.has(secreto)) cache.set(secreto, scryptSync(secreto, 'aycf-radar', 32));
  return cache.get(secreto);
}

export function encrypt(texto) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
