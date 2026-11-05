// El loop de compra: de las 00:00 a las 00:15 (hora argentina) busca cupo para
// un pedido confirmado y decide cuándo pagar.
//
// Compone lo que ya existe: `itinerary.js` elige qué vuelos, `purchase.js` sabe
// hablar con Caravelo/Spreedly y `orders.js` guarda el estado y el lock. Acá vive
// sólo la máquina de estados y una regla que manda sobre todas: NUNCA dos
// `doPurchase` del mismo vuelo sin mirar las reservas en el medio. Un timeout en
// el pago no dice si cobró; reintentar a ciegas puede cobrar dos veces.
//
// La tarjeta llega por parámetro (quien llama lee AYCF_CARD): este módulo no lee
// env ni loguea bodies. Los errores que se anotan pasan por `limpiar()`.

import { chooseItinerary, ordenDeCompra, superaTope } from './itinerary.js';
import { setEstado, lockOrder, unlockOrder } from './orders.js';
import { quote, initPayment, tokenizeCard, doPurchase, listBookings, hayReserva } from './purchase.js';
import { search } from './jetsmart.js';
import { reply } from './notify.js';
import { SessionExpiredError } from './session.js';

// Ramiro: «no exageres, nos van a bloquear». Un request por tramo cada 10–20 s.
const PAUSA_VACIA = 10_000;
const PAUSA_ERROR = 20_000;
const FALLO = Symbol('fallo');

/** Epoch ms de HOY (en Argentina) a las `hhmm` ART. Si ya pasó, el mismo instante: no rueda a mañana. */
export function deadlineAR(hhmm = '00:15', now = new Date()) {
  // Argentina es UTC-3 fijo (sin DST desde 2009): restar 3 h da la fecha local.
  const hoy = new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [y, m, d] = hoy.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h + 3, min);
}

const NUM = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ars = (n) => `ARS ${NUM.format(n)}`;
const hhmm = (s) => String(s ?? '').slice(11, 16);
const ruta = (t) => `${t.from} → ${t.to}`;

/** Una línea por tramo comprado y, si es parcial, cuál falta. */
export function formatCompra(order, resultado) {
  const lineas = resultado.tramos.map((t) => {
    const llega = hhmm(t.arrivesAt);
    return [
      '✅ *Comprado*',
      `${t.code} ${t.from} ${hhmm(t.departsAt)} → ${t.to}${llega ? ` ${llega}` : ''}`,
      `tasas ${ars(t.tasas)}`,
      t.pnr ? `PNR ${t.pnr}` : 'PNR en el mail de JetSMART',
    ].join(' · ');
  });
  if (resultado.faltan?.length) {
    const faltan = resultado.faltan.map((i) => ruta(order.tramos[i])).join(' y ');
    lineas.push(`⚠️ Falta el tramo ${faltan}: no lo persigo, se ve con Ramiro.`);
  }
  return lineas.join('\n');
}

const MOTIVOS = {
  tope: (d) => `las tasas de ${d?.ruta ?? 'un tramo'} dan ${ars(d?.monto)} y el tope es ${ars(d?.tope)}`,
  // El desafío del banco queda atado a la sesión del bot: nadie más lo puede completar.
  '3ds': () => 'el banco pidió validar la compra (3DS) y ese paso no lo puedo hacer: comprala a mano en el portal',
  rechazada: () => 'el banco rechazó la tarjeta',
  'sin-cupo': () => 'no apareció cupo hasta las 00:15',
};

/** Mensaje de fallo (o de duda) con el motivo y el último error. Corto. */
export function formatFallo(order, intentos = []) {
  const rutas = order.tramos.map(ruta).join(' · ');
  const cabeza = order.estado === 'dudoso'
    ? `🟡 *No sé si compré* ${rutas}: el pago no dio una respuesta clara y no pude confirmar la reserva. Mirá el mail de JetSMART antes de reintentar.`
    : `🔴 *No pude comprar* ${rutas}: ${(MOTIVOS[order.motivo] ?? (() => order.motivo ?? 'error'))(order.detalle)}.`;
  const ult = intentos.at(-1);
  return ult ? `${cabeza}\n${intentos.length} intento(s) · último: ${ult.paso}: ${ult.error}` : cabeza;
}

/**
 * Corre el loop hasta `deadline` y deja el pedido en su estado final.
 * Devuelve { estado, resultado, intentos, motivo } o { estado: 'confirmado' } si
 * otro proceso tiene el lock.
 */
export async function runBuy({
  order, store, session, chatId, card, deadline,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  api = { search, quote, initPayment, tokenizeCard, doPurchase, listBookings },
  notify = reply,
}) {
  // El TTL cubre el loop entero y un margen: si el proceso muere, el lock se cae solo,
  // pero nunca antes de que termine la ventana (otro cron entraría a pagar de nuevo).
  const ttl = Math.max(60, Math.ceil((deadline - now()) / 1000) + 300);
  if (!(await lockOrder(store, order.id, ttl))) return { estado: 'confirmado' };

  const n = order.tramos.length;
  const nuevos = [];
  const comprados = new Map(); // índice de tramo → { flight, pnr, tasas }

  const limpiar = (e) => {
    let msg = String(e?.message ?? e ?? '');
    // Defensa en profundidad: ningún error debería traer la tarjeta, pero si un
    // body ajeno la refleja, no llega ni al store ni a Telegram.
    for (const s of [card?.number, card?.cvv]) if (s) msg = msg.split(s).join('***');
    return msg.replace(/[*_`[\]]/g, '').slice(0, 160);
  };
  const anotar = (paso, e) => nuevos.push({ hora: new Date(now()).toISOString(), paso, error: limpiar(e) });

  const relogin = async () => {
    try { await session.relogin(); return true; } catch (e) { anotar('relogin', e); return false; }
  };

  // Pasos previos al pago: no cobran, así que un reintento inmediato es inocuo.
  const paso = async (nombre, fn) => {
    try { return await fn(); } catch (e) {
      anotar(nombre, e);
      if (e instanceof SessionExpiredError && !(await relogin())) return FALLO;
    }
    try { return await fn(); } catch (e) { anotar(nombre, e); return FALLO; }
  };

  // ¿Quedó reservado? null = no se pudo saber (y entonces no se paga de nuevo).
  const verificar = async (flight) => {
    for (let k = 0; k < 2; k++) {
      try {
        const bookings = await api.listBookings(session);
        const fila = bookings.find((b) => hayReserva([b], flight));
        return { reservado: hayReserva(bookings, flight), pnr: fila?.pnr ?? null };
      } catch (e) {
        anotar('listBookings', e);
        // Relogin no cobra nada: vale la pena una vez antes de rendirse.
        if (!(e instanceof SessionExpiredError) || k > 0 || !(await relogin())) return null;
      }
    }
    return null;
  };

  // El único lugar donde se llama a doPurchase. Entre dos llamadas SIEMPRE hay
  // un `verificar` que devolvió "no reservado".
  const pagar = async (flight, args) => {
    const intento = async () => {
      try { return await api.doPurchase(session, args); } catch (e) {
        anotar('doPurchase', e);
        return { ok: false, motivo: 'desconocido', lanzo: true };
      }
    };
    let r = await intento();
    for (let k = 0; ; k++) {
      if (r.ok) return { tipo: 'comprado', pnr: r.pnr ?? null };
      if (!r.lanzo) anotar('doPurchase', r.motivo);
      if (r.motivo === 'rechazada' || r.motivo === '3ds') return { tipo: 'fin', estado: 'fallido', motivo: r.motivo };
      // sin-cupo o desconocido: antes de buscar otro vuelo o repagar, ¿ya está reservado?
      const v = await verificar(flight);
      if (!v) return { tipo: 'fin', estado: 'dudoso', motivo: 'dudoso' };
      if (v.reservado) return { tipo: 'comprado', pnr: v.pnr };
      if (r.motivo === 'sin-cupo') return { tipo: 'sin-cupo' };
      // Dos respuestas sin señal y ninguna reserva a la vista: no hay tercer pago.
      if (k > 0) return { tipo: 'fin', estado: 'dudoso', motivo: 'dudoso' };
      r = await intento();
    }
  };

  const comprarTramo = async (flight) => {
    const q = await paso('quote', () => api.quote(session, flight));
    if (q === FALLO) return { tipo: 'error' };
    // El tope se mide contra lo cotizado, que es lo que se cobra (no lo que dijo la búsqueda).
    if (superaTope({ ...flight, taxes: q.total }, order)) {
      anotar('quote', `tasas ${q.total} superan el tope ${order.topeTasasPorTramoARS}`);
      return { tipo: 'fin', estado: 'fallido', motivo: 'tope',
        detalle: { ruta: ruta(flight), monto: q.total, tope: order.topeTasasPorTramoARS } };
    }
    const init = await paso('initPayment', () => api.initPayment(session));
    if (init === FALLO) return { tipo: 'error' };
    const token = await paso('tokenizeCard', () => api.tokenizeCard(card, init));
    if (token === FALLO) return { tipo: 'error' };
    const r = await pagar(flight, { token, card, quotation: q });
    return r.tipo === 'comprado' ? { ...r, tasas: q.total } : r;
  };

  let final = null;
  try {
    let pausa = 0;
    for (let vuelta = 0; ; vuelta++) {
      if (vuelta > 0) await sleep(pausa);
      if (now() >= deadline) break;
      pausa = PAUSA_VACIA;

      // 1) Buscar sólo lo que falta comprar. Ante el primer error se corta la vuelta:
      //    seguir con el otro tramo sería sumar requests a un Caravelo que ya está mal.
      const vuelos = [];
      let relogueado = false;
      let error = false;
      for (let i = 0; i < n && !error; i++) {
        if (comprados.has(i)) continue;
        const consulta = { from: order.tramos[i].from, to: order.tramos[i].to, date: order.fechaVuelo };
        try {
          vuelos[i] = await api.search(session, consulta, store);
        } catch (e) {
          if (e instanceof SessionExpiredError && !relogueado) {
            relogueado = true; // un relogin por vuelta, no un loop de logins
            if (await relogin()) {
              try { vuelos[i] = await api.search(session, consulta, store); continue; } catch (e2) { e = e2; }
            }
          }
          anotar('search', e);
          error = true;
        }
      }
      if (error) { pausa = PAUSA_ERROR; continue; }

      // 2) Elegir. Lo ya comprado entra fijo para que el resto encadene con él.
      const porTramo = order.tramos.map((_, i) =>
        comprados.has(i) ? [{ ...comprados.get(i).flight, seats: Math.max(1, comprados.get(i).flight.seats ?? 1) }] : vuelos[i]);
      const it = chooseItinerary(order, porTramo);
      const aComprar = ordenDeCompra(it).filter((i) => !comprados.has(i));
      if (aComprar.length === 0) {
        // Ya hay algo comprado y lo que falta no aparece: parcial, no se persigue.
        if (comprados.size) final = { estado: 'parcial' };
        if (final) break;
        continue;
      }

      // 3) Comprar, primero el tramo más escaso.
      let reBuscar = false;
      for (const i of aComprar) {
        const flight = it.tramos[i];
        const r = await comprarTramo(flight);
        if (r.tipo === 'comprado') { comprados.set(i, { flight, pnr: r.pnr, tasas: r.tasas }); continue; }
        if (r.tipo === 'error') pausa = PAUSA_ERROR;
        if (r.tipo === 'fin') final = { estado: r.estado, motivo: r.motivo, detalle: r.detalle };
        reBuscar = true;
        break;
      }
      if (final) break;
      if (comprados.size === n) { final = { estado: 'comprado' }; break; }
      if (!reBuscar && it.faltan?.length && comprados.size) { final = { estado: 'parcial' }; break; }
    }

    if (!final) {
      // Se terminó la ventana.
      final = { estado: 'fallido', motivo: 'sin-cupo' };
      anotar('search', 'sin cupo hasta el cierre de la ventana');
    }
    // Un fallo después de haber comprado algún tramo es un parcial: hay plata gastada.
    if (final.estado === 'fallido' && comprados.size) final = { ...final, estado: 'parcial' };

    const resultado = {
      tramos: [...comprados.keys()].sort((a, b) => a - b).map((i) => {
        const { flight: f, pnr, tasas } = comprados.get(i);
        return { code: f.code, from: f.from, to: f.to, departsAt: f.departsAt, arrivesAt: f.arrivesAt, pnr, tasas };
      }),
    };
    if (final.estado === 'parcial') resultado.faltan = order.tramos.map((_, i) => i).filter((i) => !comprados.has(i));

    // setEstado suma de a un intento: los previos van primero, el último con el resultado.
    let guardado = order;
    for (const intento of nuevos.slice(0, -1)) guardado = await setEstado(store, order.id, final.estado, { intento });
    guardado = await setEstado(store, order.id, final.estado, {
      resultado, motivo: final.motivo ?? null, detalle: final.detalle ?? null,
      ...(nuevos.length ? { intento: nuevos.at(-1) } : {}),
    });

    const partes = [];
    if (comprados.size) partes.push(formatCompra(order, resultado));
    if (final.estado === 'dudoso' || final.estado === 'fallido') partes.push(formatFallo(guardado, nuevos));
    try { await notify(partes.join('\n\n'), chatId); } catch (e) { console.error(`buy: no pude avisar: ${limpiar(e)}`); }

    return { estado: guardado.estado, resultado, intentos: guardado.intentos, motivo: final.motivo ?? null };
  } finally {
    await unlockOrder(store, order.id);
  }
}
