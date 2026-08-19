// Login automático contra Keycloak.
//
// La sesión de Caravelo vence por tiempo absoluto (~40 min) y no hay keep-alive
// que la sostenga. La única forma de que el radar sea autónomo es que sepa
// re-loguearse solo.
//
// Flujo (auth code estándar, realm `ja`, client `cvo-laravel`):
//   1. GET  /es-ar/ja/subscriptions/auth/login   → 302 a Keycloak
//   2. GET  /auth/realms/ja/…/openid-connect/auth → HTML con el form kc-form-login
//   3. POST al action del form con username/password → 302 con ?code=…
//   4. Seguir el redirect: Laravel canjea el code y setea laravel_session
//
// Las credenciales llegan por parámetro: las del dueño del deploy salen de env
// vars, las de cada usuario del bot salen del store cifradas. Este módulo nunca
// las loguea ni las persiste: solo las manda a Keycloak.

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const LOGIN_ENTRY = process.env.AYCF_LOGIN_URL ||
  'https://go.jetsmart.com/es-ar/ja/subscriptions/auth/login';

export class LoginError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'LoginError';
  }
}

/** Cookie jar mínimo: nombre → valor, sin dominios ni paths. */
class Jar {
  #c = new Map();

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || value === 'deleted') this.#c.delete(name);
      else this.#c.set(name, value);
    }
  }

  header() {
    return [...this.#c].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.#c.get(name);
  }

  toObject() {
    return Object.fromEntries(this.#c);
  }
}

/** Sigue redirects a mano acumulando cookies. Devuelve la última respuesta con body. */
async function follow(jar, url, init = {}, maxHops = 12) {
  let actual = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(actual, {
      ...init,
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        ...(init.headers ?? {}),
        cookie: jar.header(),
      },
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(res);

    const loc = res.headers.get('location');
    if (!loc) return { res, url: actual };

    actual = new URL(loc, actual).toString();
    // Después del primer salto ya no reenviamos el body ni el método.
    init = {};
  }
  throw new LoginError('demasiados redirects en el login');
}

function extraerForm(html) {
  const form = html.match(/<form[^>]*id="kc-form-login"[^>]*>/i)?.[0];
  if (!form) return null;
  const action = form.match(/action="([^"]+)"/i)?.[1];
  if (!action) return null;
  return action.replace(/&amp;/g, '&');
}

/** Keycloak devuelve el mismo form con un cartel de error si las credenciales fallan. */
function extraerError(html) {
  const m = html.match(/<span[^>]*class="[^"]*kc-feedback-text[^"]*"[^>]*>([^<]+)</i)
    || html.match(/id="input-error[^"]*"[^>]*>([^<]+)</i);
  return m?.[1]?.trim() ?? null;
}

/**
 * Se loguea y devuelve las cookies de la sesión autenticada.
 * Tira LoginError si faltan credenciales o si Keycloak las rechaza.
 */
export async function login(creds = {}) {
  const { email, password } = credenciales(creds);
  const username = email;
  if (!username || !password) {
    throw new LoginError('no tengo tus credenciales de JetSmart: conectá tu cuenta con /conectar');
  }

  const jar = new Jar();

  // 1-2. Hasta el form de Keycloak.
  const { res: formRes } = await follow(jar, LOGIN_ENTRY);
  const html = await formRes.text();

  // Si ya había sesión válida, Caravelo no muestra el form y volvemos directo.
  if (jar.get('laravel_session') && !/kc-form-login/i.test(html)) {
    return jar.toObject();
  }

  const action = extraerForm(html);
  if (!action) {
    throw new LoginError('no encontré el formulario de Keycloak (¿cambió el login?)');
  }

  // 3. Credenciales. rememberMe pide la sesión SSO más larga que ofrezca el realm.
  const body = new URLSearchParams({
    username,
    password,
    rememberMe: 'on',
    credentialId: '',
  });

  const { res: post } = await follow(jar, action, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

  // 4. Si seguimos viendo el form, las credenciales no pasaron.
  const finalHtml = await post.text().catch(() => '');
  if (/kc-form-login/i.test(finalHtml)) {
    const motivo = extraerError(finalHtml);
    throw new LoginError(
      motivo
        ? `Keycloak rechazó el login: ${motivo}`
        : 'Keycloak rechazó el login (credenciales, MFA o captcha)'
    );
  }

  if (!jar.get('laravel_session')) {
    throw new LoginError('el login terminó sin laravel_session');
  }

  return jar.toObject();
}

/**
 * Las de env son del dueño del deploy y SOLO valen para él: mezclar el mail de un
 * usuario con la contraseña de env sería intentar entrar a la cuenta equivocada.
 */
export function credenciales(creds = {}) {
  const esEnv = Boolean(creds.env) || !creds.chatId;
  return esEnv
    ? { email: creds.email || process.env.AYCF_EMAIL, password: creds.password || process.env.AYCF_PASSWORD }
    : { email: creds.email, password: creds.password };
}

export const tieneCredenciales = (creds = {}) => {
  const { email, password } = credenciales(creds);
  return Boolean(email && password);
};
