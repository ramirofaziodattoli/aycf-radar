// Estado persistente: la cookie de sesión rotada y el registro de lo ya notificado.
//
// Tres backends según dónde corras. Se elige solo por env, sin configurar nada:
//   - Redis (Upstash / Vercel KV): serverless. Es el que hace falta en Vercel,
//     porque el filesystem de una function es efímero y la cookie se perdería.
//   - Archivo: self-hosting en una VPS, un Raspberry, o local.
//   - Memoria: fallback. Avisa fuerte, porque la sesión no sobrevive al proceso.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

class RedisStore {
  name = 'redis';

  async #cmd(...args) {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
    return (await r.json()).result;
  }

  async get(key) {
    const v = await this.#cmd('GET', key);
    return v ? JSON.parse(v) : null;
  }

  async set(key, value, ttlSeconds) {
    const args = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds) args.push('EX', String(ttlSeconds));
    await this.#cmd(...args);
  }
}

class FileStore {
  name = 'file';

  constructor(path) {
    this.path = path;
  }

  async #read() {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      return {};
    }
  }

  async get(key) {
    const db = await this.#read();
    const row = db[key];
    if (!row) return null;
    if (row.exp && Date.now() > row.exp) return null;
    return row.v;
  }

  async set(key, value, ttlSeconds) {
    const { writeFile } = await import('node:fs/promises');
    const db = await this.#read();
    db[key] = { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
    await writeFile(this.path, JSON.stringify(db, null, 2), { mode: 0o600 });
  }
}

class MemoryStore {
  name = 'memory';
  #m = new Map();

  async get(key) {
    const row = this.#m.get(key);
    if (!row) return null;
    if (row.exp && Date.now() > row.exp) return null;
    return row.v;
  }

  async set(key, value, ttlSeconds) {
    this.#m.set(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }
}

export function createStore() {
  if (REDIS_URL && REDIS_TOKEN) return new RedisStore();
  if (process.env.STATE_FILE) return new FileStore(process.env.STATE_FILE);
  if (!process.env.VERCEL) return new FileStore('.state.json');
  console.warn(
    '⚠️  Sin Redis en un entorno serverless: la sesión NO va a sobrevivir entre invocaciones.\n' +
    '   Configurá UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (o las KV_* de Vercel).'
  );
  return new MemoryStore();
}
