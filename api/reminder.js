// Recordatorio de las 23:45: chequear que la sesión llegue viva a la liberación.
//
// La sesión de Caravelo vence por tiempo ABSOLUTO (~40 min), no por inactividad,
// así que no hay keep-alive que la sostenga toda la noche. Lo que sí funciona es
// tenerla fresca en la ventana que importa.
//
// OJO: esto va por `withSession`, no por `Session.load()` a secas. Con load() una
// sesión vencida se reportaba como "🔴 caída" aunque el re-login automático la
// levantara sin problema dos minutos después: el bot avisaba que no estabas
// conectado estando perfectamente conectado.

import { createStore } from '../src/store.js';
import { withSession, SessionExpiredError } from '../src/session.js';
import { search } from '../src/jetsmart.js';
import { tomorrowInAR } from '../src/radar.js';
import { resolveWatches } from '../src/config.js';
import { reply } from '../src/notify.js';
import { scoped, listUsers, usaSemilla } from '../src/users.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const base = createStore();
  const users = await listUsers(base);
  const resultados = [];

  for (const user of users) {
    const store = scoped(base, user.chatId);
    const chatId = user.env ? undefined : user.chatId;
    const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) }).catch(() => []);
    // Sin rutas no hay liberación que esperar: no le tocamos el timbre a nadie.
    if (!watches.length) continue;

    let viva = false;
    let motivo = '';
    try {
      await withSession(
        store,
        (s) => search(s, { from: watches[0].from, to: watches[0].to, date: tomorrowInAR() }, store),
        user
      );
      viva = true;
    } catch (err) {
      motivo = err instanceof SessionExpiredError ? err.detalle : err.message;
      console.error(`reminder ${user.chatId}: ${motivo}`);
    }

    await reply(
      viva
        ? '🌙 *Faltan 16 minutos para la liberación de las 00:01.*\n\n' +
          'Tu sesión está viva y me relogueo solo si vence. No tenés que hacer nada.'
        : '🔴 *No puedo entrar a tu cuenta y en 16 minutos se libera el inventario.*\n\n' +
          `Motivo: ${motivo}\n\n` +
          'Reconectá con `/conectar tu@mail.com tucontraseña`, o mandame un `/cookie` fresco.\n\n' +
          '_Sin eso, el aviso de las 00:01 no va a salir._',
      chatId
    ).catch(() => {});

    resultados.push({ chatId: user.chatId, viva });
  }

  return res.status(200).json({ ok: true, users: resultados });
}
