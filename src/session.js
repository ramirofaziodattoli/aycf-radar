// Sesión viva contra Caravelo.
//
// La cookie dice `max-age=1800` y Laravel la rota en cada respuesta, lo que hace
// pensar en una ventana deslizante. NO LO ES: medido en producción, la sesión
// muere ~40 min después del login pase lo que pase (éxito 03:00, muerta 03:15,
// con el cron pegándole cada 15). Es un tope absoluto, casi seguro el token de
// Keycloak de atrás.
//
// Por eso el único camino a que esto sea autónomo es re-loguearse: ver login.js.
// La cookie manual (AYCF_COOKIE) queda como semilla opcional para arrancar sin
// guardar credenciales.

import { login, tieneCredenciales, LoginError } from './login.js';

const KEY = 'session:cookies';

// Solo las cookies que el backend realmente usa. Las otras ~50 son analytics
// (utag, _tt, _ga, AWSALB...) y solo hacen que el estado pese 5KB al pedo.
const RELEVANTES = /^(laravel_session|XSRF-TOKEN|KEYCLOAK_|cart_cookie|smuuid)/i;

export class SessionExpiredError extends Error {
  constructor(detalle = 'venció por inactividad (30 min)') {
    super(`sesión de JetSmart inutilizable: ${detalle}`);
    this.name = 'SessionExpiredError';
    this.detalle = detalle;
  }
}

/**
 * El ID de sesión rota. Si seguís usando el portal en el navegador después de
 * copiar la cookie, la que copiaste queda superada: Caravelo responde 500 con
 * `error.token.mismatch` en vez de un 401 limpio. Se detecta aparte porque la
 * solución es distinta — no alcanza con copiar de nuevo, hay que copiar y
 * NO volver a tocar el portal.
 */
export const TOKEN_MISMATCH = 'error.token.mismatch';

function parseCookieHeader(str) {
  return Object.fromEntries(
    (str || '')
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.includes('='))
      .map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
      })
      .filter(([n]) => RELEVANTES.test(n))
  );
}

/**
 * Carga la sesión, corre `fn`, y si la sesión estaba muerta se reloguea y
 * reintenta UNA vez. Vive acá para que el cron y el bot compartan exactamente
 * el mismo comportamiento: tenerlo duplicado ya causó que el bot rebotara
 * mientras el cron se recuperaba solo.
 */
export async function withSession(store, fn) {
  const session = await new Session(store).load();
  try {
    return await fn(session);
  } catch (err) {
    if (!(err instanceof SessionExpiredError) || !tieneCredenciales()) throw err;
    console.log('sesión caída, relogueando…');
    await session.relogin();
    return await fn(session);
  }
}

export class Session {
  constructor(store) {
    this.store = store;
    this.jar = null;
  }

  /**
   * Store → semilla AYCF_COOKIE → login automático.
   * El login va último porque es el más caro, pero es el que hace que esto
   * funcione sin que nadie lo toque.
   */
  async load() {
    this.jar = await this.store.get(KEY);
    if (this.jar?.laravel_session) return this;

    const seed = parseCookieHeader(process.env.AYCF_COOKIE);
    if (seed.laravel_session) {
      this.jar = seed;
      await this.persist();
      return this;
    }

    if (tieneCredenciales()) return this.relogin();
    throw new SessionExpiredError('no hay cookie sembrada ni credenciales para loguearme');
  }

  /**
   * Descarta lo que haya y se loguea de cero. Es la salida de la trampa: la
   * sesión vence por tiempo absoluto, así que tarde o temprano SIEMPRE hay que
   * volver a loguearse.
   */
  async relogin() {
    if (!tieneCredenciales()) {
      throw new SessionExpiredError('sin AYCF_EMAIL / AYCF_PASSWORD no puedo re-loguearme');
    }
    const cookies = await login();
    this.jar = Object.fromEntries(
      Object.entries(cookies).filter(([n]) => RELEVANTES.test(n))
    );
    if (!this.jar.laravel_session) throw new LoginError('el login no devolvió laravel_session');
    await this.persist();
    return this;
  }

  header() {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * Absorbe los Set-Cookie de una respuesta AUTENTICADA y persiste.
   * Ojo: en un 401 Laravel también manda cookie nueva, pero de sesión anónima.
   * Guardar esa pisaría la buena, así que el caller solo llama acá con 2xx.
   */
  async absorb(response) {
    const nuevas = response.headers.getSetCookie?.() ?? [];
    let cambio = false;
    for (const raw of nuevas) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!RELEVANTES.test(name) || !value || value === 'deleted') continue;
      if (this.jar[name] !== value) {
        this.jar[name] = value;
        cambio = true;
      }
    }
    if (cambio) await this.persist();
    return cambio;
  }

  /**
   * Borra la sesión guardada para que la próxima corrida re-siembre desde AYCF_COOKIE.
   * Sin esto, una sesión muerta en el store gana sobre la env var y actualizar la
   * semilla no sirve de nada: quedás en un 401 permanente.
   */
  async invalidate() {
    this.jar = null;
    await this.store.set(KEY, null, 1);
  }

  async persist() {
    // TTL holgado contra los 30 min de Laravel: si el proceso estuvo caído más
    // que eso la sesión ya murió igual, pero no queremos perder el registro antes.
    await this.store.set(KEY, this.jar, 60 * 60 * 24 * 7);
  }
}
