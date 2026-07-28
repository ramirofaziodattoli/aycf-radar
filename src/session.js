// Sesión viva contra Caravelo.
//
// `laravel_session` vence a los 30 min de INACTIVIDAD (max-age=1800), pero Laravel
// devuelve una cookie nueva en cada respuesta autenticada. O sea: es una ventana
// deslizante. Si pegamos más seguido que cada 30 min y guardamos la cookie rotada,
// la sesión no vence nunca. Ese es todo el truco del keep-alive.
//
// El seed inicial (AYCF_COOKIE) sí es manual: el login va por Keycloak y no lo
// automatizamos, porque implicaría guardar usuario y contraseña.

const KEY = 'session:cookies';

// Solo las cookies que el backend realmente usa. Las otras ~50 son analytics
// (utag, _tt, _ga, AWSALB...) y solo hacen que el estado pese 5KB al pedo.
const RELEVANTES = /^(laravel_session|XSRF-TOKEN|KEYCLOAK_|cart_cookie|smuuid)/i;

export class SessionExpiredError extends Error {
  constructor() {
    super('sesión de JetSmart vencida: hay que re-sembrar AYCF_COOKIE');
    this.name = 'SessionExpiredError';
  }
}

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

export class Session {
  constructor(store) {
    this.store = store;
    this.jar = null;
  }

  /** Carga del store; si está vacío, siembra desde AYCF_COOKIE. */
  async load() {
    this.jar = await this.store.get(KEY);
    if (!this.jar || !this.jar.laravel_session) {
      const seed = parseCookieHeader(process.env.AYCF_COOKIE);
      if (!seed.laravel_session) throw new SessionExpiredError();
      this.jar = seed;
      await this.persist();
    }
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

  async persist() {
    // TTL holgado contra los 30 min de Laravel: si el proceso estuvo caído más
    // que eso la sesión ya murió igual, pero no queremos perder el registro antes.
    await this.store.set(KEY, this.jar, 60 * 60 * 24 * 7);
  }
}
