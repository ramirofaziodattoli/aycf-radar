// Precalentado de las 23:55: loguear a todos ANTES de la estampida de las 00:01.
//
// La sesión de Caravelo vence por tiempo ABSOLUTO (~40 min), así que la de ayer
// está muerta cuando se libera el inventario. Un login fresco a las 23:55 llega
// vivo a las 00:01 y a las pasadas de rescate de las 00:10 y 00:20, y convierte a
// cada usuario de la liberación en UN request (la búsqueda) en vez de cinco (login
// + búsqueda) en el minuto en que Caravelo está saturado: medido el 06 y 07/10, a
// esa hora el login tardaba más de 20 s y la búsqueda más de 30 s, y los 7
// usuarios fallaban.
//
// Avisa SOLO si no puede entrar: a las 23:55 nadie quiere un "todo bien". Y si
// igual falla, el barrido de las 00:01 reintenta el login por su cuenta.

import { createStore } from '../src/store.js';
import { Session } from '../src/session.js';
import { tieneCredenciales } from '../src/login.js';
import { resolveWatches } from '../src/config.js';
import { reply } from '../src/notify.js';
import { scoped, listUsers, usaSemilla, envUser } from '../src/users.js';
import { ordersPendientes, formatPedido } from '../src/orders.js';
import { tomorrowInAR } from '../src/radar.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const base = createStore();
  const resultados = [];

  for (const user of await listUsers(base)) {
    const store = scoped(base, user.chatId);
    const watches = await resolveWatches(store, undefined, { seed: usaSemilla(user) }).catch(() => []);
    // Sin rutas no hay liberación que esperar; sin credenciales (usuarios de
    // /cookie) no hay login que hacer.
    if (!watches.length || !tieneCredenciales(user)) continue;

    let viva = true;
    try {
      // Incondicional: aunque la sesión esté viva, una fresca garantiza los 40 min.
      await new Session(store, user).relogin();
    } catch (err) {
      viva = false;
      console.error(`warmup ${user.chatId}: ${err.message}`);
      await reply(
        '🔴 *No puedo entrar a tu cuenta y en 6 minutos se libera el inventario.*\n\n' +
        `Motivo: ${err.message}\n\n` +
        'Reconectá mandándome tu mail y contraseña en un mensaje.\n\n' +
        '_Sin eso, el aviso de las 00:01 no va a salir._',
        user.env ? undefined : user.chatId
      ).catch(() => {});
    }
    resultados.push({ chatId: user.chatId, viva });
  }

  // Repaso de lo que el bot va a pagar solo: TODOS los pedidos confirmados con
  // vuelo de mañana (de la noche que arranca) en adelante, porque cada pasada los
  // intenta. Son las 23:55, o sea que "mañana" de la noche que arranca sale sólo
  // sumando los minutos que faltan.
  if (process.env.AUTO_BUY === 'on') {
    const dueno = envUser();
    if (dueno) {
      const date = tomorrowInAR(new Date(Date.now() + 10 * 60 * 1000));
      const pedidos = await ordersPendientes(scoped(base, dueno.chatId), { desde: date }).catch(() => []);
      for (const order of pedidos) {
        await reply(
          formatPedido(order) + '\n\n_Lo compro solo apenas aparezca cupo (la próxima pasada es a las 00:00). Si ya no lo querés, cancelalo ahora._',
          undefined,
          { buttons: [[{ text: '❌ Cancelar', data: `ord:no:${order.id}` }]] }
        ).catch((err) => console.error(`recordatorio ${order.id}: ${err.message}`));
      }
    }
  }

  return res.status(200).json({ ok: true, users: resultados });
}
