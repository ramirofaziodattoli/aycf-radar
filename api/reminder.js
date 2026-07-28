// Recordatorio de las 23:45: sembrá la sesión antes de la liberación.
//
// La sesión de Caravelo vence por tiempo ABSOLUTO (~40 min), no por inactividad,
// así que no hay keep-alive que la sostenga toda la noche. Lo que sí funciona es
// tenerla fresca en la ventana que importa: sembrada 23:45, llega viva a las 00:01.

import { createStore } from '../src/store.js';
import { Session, SessionExpiredError } from '../src/session.js';
import { search } from '../src/jetsmart.js';
import { tomorrowInAR } from '../src/radar.js';
import { resolveWatches } from '../src/config.js';
import { reply } from '../src/notify.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let viva = false;
  try {
    const store = createStore();
    const session = await new Session(store).load();
    const watches = await resolveWatches(store);
    await search(session, { from: watches[0].from, to: watches[0].to, date: tomorrowInAR() }, store);
    viva = true;
  } catch (err) {
    if (!(err instanceof SessionExpiredError)) console.error(err.message);
  }

  await reply(
    viva
      ? '🌙 *Faltan 16 minutos para la liberación de las 00:01.*\n\n' +
        'La sesión está viva y debería aguantar. Si querés jugar seguro, mandame ' +
        'un `/cookie` fresco igual.'
      : '🔴 *La sesión está caída y en 16 minutos se libera el inventario.*\n\n' +
        'Entrá al portal, hacé una búsqueda, copiá el header `cookie` y mandámelo ' +
        'acá con `/cookie ...`\n\n_Sin eso, el aviso de las 00:01 no va a salir._'
  );

  return res.status(200).json({ ok: true, sesionViva: viva });
}
