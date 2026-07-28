// Mantiene viva la sesión con UN request, sin barrer nada.
//
// Solo hace falta si el barrido corre cada más de 30 min (el max-age de
// laravel_session). Si el cron principal va cada 15, esto es redundante:
// cada búsqueda ya renueva la cookie.

import { createStore } from '../src/store.js';
import { Session, SessionExpiredError } from '../src/session.js';
import { search } from '../src/jetsmart.js';
import { tomorrowInAR } from '../src/radar.js';
import { loadWatches } from '../src/watches.js';
import { readWatches } from '../src/config.js';
import { notifyError } from '../src/notify.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const store = createStore();
    const session = await new Session(store).load();
    const [primero] = loadWatches(await readWatches());

    // Un request cualquiera alcanza: lo que renueva la sesión es la respuesta.
    await search(session, { from: primero.from, to: primero.to, date: tomorrowInAR() });

    return res.status(200).json({ ok: true, alive: true });
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      await notifyError('Keep-alive: la sesión venció. Actualizá `AYCF_COOKIE`.');
      return res.status(200).json({ ok: false, error: 'session-expired' });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
}
