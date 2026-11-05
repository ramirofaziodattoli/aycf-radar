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
import { setEstado, getOrder, lockOrder, unlockOrder, renovarLock, fueCancelado } from './orders.js';
import { randomBytes } from 'node:crypto';
import { quote, initPayment, tokenizeCard, doPurchase, listBookings, hayReserva, diaDeReserva } from './purchase.js';
import { search } from './jetsmart.js';
import { reply } from './notify.js';
import { SessionExpiredError } from './session.js';

// Ramiro: «no exageres, nos van a bloquear». Un request por tramo cada 10–20 s.
const PAUSA_VACIA = 10_000;
const PAUSA_ERROR = 20_000;
const FALLO = Symbol('fallo');
// El lock tiene que durar lo que puede vivir el proceso, no lo que dura la ventana:
// la función sigue viva hasta que Vercel la mata (maxDuration 800 s desde SU
// arranque) y el deadline sólo se mira entre pasos. Con un TTL más corto, el
// rescate entra mientras la corrida vieja todavía puede pagar. El dueño evita
// que una corrida le borre el lock a otra.
const LOCK_MARGEN_S = 60;
const VIDA_MAXIMA_S = 800;
const ESPERA_LOCK = 10_000;
const DUDOSO = { tipo: 'fin', estado: 'dudoso', motivo: 'dudoso' };
// Con el parser de reservas calibrado, cuánto se espera a que una compra recién
// hecha aparezca en «Mis reservas» antes de mirar.
const ESPERA_RESERVA = 15_000;
// Los motivos de doPurchase que son una respuesta clara. Cualquier otro (desconocido,
// un throw) es ambiguo: el pago pudo haber cobrado.
const MOTIVOS_CLAROS = ['sin-cupo', 'rechazada', '3ds'];
const CANCELADO_TXT = '⏹️ Pedido cancelado, no compré nada más.';

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
      `tasas ${t.tasas != null ? ars(t.tasas) : 'en el mail'}`,
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
  'sin-cupo': () => 'no apareció cupo en ninguna pasada hasta el cierre (23:00 del día anterior al vuelo)',
};

/** Por qué no se compró, en una frase. */
export const motivoTexto = (motivo, detalle) => (MOTIVOS[motivo] ?? (() => motivo ?? 'error'))(detalle);

/** Mensaje de fallo (o de duda) con el motivo y el último error. Corto. */
export function formatFallo(order, intentos = []) {
  const rutas = order.tramos.map(ruta).join(' · ');
  const cabeza = order.estado === 'dudoso'
    ? `🟡 *No sé si compré* ${rutas}: el pago no dio una respuesta clara y no pude confirmar la reserva. Mirá el mail de JetSMART antes de reintentar.`
    : `🔴 *No pude comprar* ${rutas}: ${motivoTexto(order.motivo, order.detalle)}.`;
  const ult = intentos.at(-1);
  return ult ? `${cabeza}\n${intentos.length} intento(s) · último: ${ult.paso}: ${ult.error}` : cabeza;
}

/**
 * Ensayo de compra (`/ensayo`): una sola pasada de search → elegir → quote por tramo
 * → initPayment, sin lock, sin escribir en el store, sin tokenizar ni pagar.
 * Devuelve el itinerario, lo cotizado y si el INIT de Spreedly anduvo, o el paso
 * que falló. Sin reintentos ni relogin: es para mirar, no para insistir.
 */
async function ensayar({ order, store, session, api }) {
  const fresco = (await getOrder(store, order.id)) ?? order;
  const msg = (e) => String(e?.message ?? e ?? '').replace(/[*_`[\]]/g, '').slice(0, 160);
  const falla = (paso, e, extra) => ({ estado: 'ensayo', paso, error: msg(e), ...extra });

  // Sin `store` en el search: con store, search() guarda el catálogo de aeropuertos.
  const vuelos = [];
  for (let i = 0; i < fresco.tramos.length; i++) {
    try {
      vuelos[i] = await api.search(session, { from: fresco.tramos[i].from, to: fresco.tramos[i].to, date: fresco.fechaVuelo });
    } catch (e) { return falla('search', e); }
  }
  const it = chooseItinerary(fresco, vuelos);
  const itinerario = it.faltan?.length ? { tramos: it.tramos, faltan: it.faltan } : { tramos: it.tramos };

  const cotizaciones = [];
  for (const i of ordenDeCompra(it)) {
    const f = it.tramos[i];
    try {
      const q = await api.quote(session, f);
      cotizaciones.push({ code: f.code, total: q.total });
    } catch (e) { return falla('quote', e, { itinerario, cotizaciones }); }
  }
  if (!it.tramos.length) return { estado: 'ensayo', itinerario, cotizaciones, init: null };

  try { await api.initPayment(session); } catch (e) { return falla('initPayment', e, { itinerario, cotizaciones }); }
  return { estado: 'ensayo', itinerario, cotizaciones, init: { ok: true } };
}

/** «HH:MM» en hora argentina (UTC-3 fijo) de un epoch ms. */
const horaAR = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(11, 16);

/**
 * Corre el loop hasta `deadline` y deja el pedido en su estado.
 * Devuelve { estado, resultado, intentos, motivo }, o { estado: 'confirmado' } si
 * otro proceso tiene el lock (y no se liberó en `esperarLockMs`).
 *
 * Sin cupo al terminar la ventana el pedido SIGUE `confirmado` (lo retoman los
 * rescates); sólo con `cierre` (la pasada de las 23:00 del día anterior al vuelo)
 * queda `fallido` o `parcial`. `avisarSinCupo` (00:00 y 00:13) avisa que sigue
 * intentando; las pasadas horarias callan salvo que compren algo.
 *
 * `bookingsCalibrado`: hasta validar el parser de reservas con una compra real,
 * una lista legible sin la reserva NO prueba que no se compró. Apagado (default),
 * un pago ambiguo deja el pedido `dudoso` sin reintentar.
 */
export async function runBuy({
  order, store, session, chatId, card, deadline,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  api = { search, quote, initPayment, tokenizeCard, doPurchase, listBookings },
  notify = reply,
  esperarLockMs = 0,
  dryRun = false,
  bookingsCalibrado = false,
  avisarSinCupo = false,
  cierre = false,
}) {
  // Ensayo: antes del lock y de cualquier escritura. Es una función aparte que ni
  // siquiera recibe `card` ni `api.tokenizeCard`/`doPurchase`: no hay camino al pago.
  if (dryRun) return ensayar({ order, store, session, api });

  // El rescate de las 00:13 espera a que la corrida anterior suelte el lock (o
  // a que venza su TTL si la mató el maxDuration) en vez de rendirse al toque.
  const ttl = () => Math.max(Math.ceil((deadline - now()) / 1000) + LOCK_MARGEN_S, VIDA_MAXIMA_S + LOCK_MARGEN_S);
  const dueño = `run_${randomBytes(6).toString('hex')}`;
  const inicio = now();
  let tengo = await lockOrder(store, order.id, ttl(), dueño);
  while (!tengo && now() - inicio < esperarLockMs) {
    await sleep(ESPERA_LOCK);
    tengo = await lockOrder(store, order.id, ttl(), dueño);
  }
  if (!tengo) return { estado: 'confirmado' };

  try {
    // El `order` que nos pasaron puede estar viejo: lo que manda es el store.
    const fresco = (await getOrder(store, order.id)) ?? order;
    if (fresco.estado !== 'confirmado') {
      return { estado: fresco.estado, resultado: fresco.resultado ?? null, intentos: fresco.intentos ?? [], motivo: fresco.motivo ?? null };
    }

    const n = order.tramos.length;
    const nuevos = [];
    let compradosAhora = 0; // tramos pagados en ESTA corrida (los de antes no se avisan de nuevo)
    let persistidos = 0;
    const comprados = new Map(); // índice de tramo → { flight, pnr, tasas }
    // Lo que una corrida anterior ya pagó no se vuelve a comprar.
    for (const t of fresco.resultado?.tramos ?? []) {
      const i = order.tramos.findIndex((x) => x.from === t.from && x.to === t.to);
      if (i >= 0) comprados.set(i, { flight: { ...t, seats: 1 }, pnr: t.pnr, tasas: t.tasas });
    }

    const limpiar = (e) => {
      let msg = String(e?.message ?? e ?? '');
      // Defensa en profundidad: ningún error debería traer la tarjeta, pero si un
      // body ajeno la refleja, no llega ni al store ni a Telegram.
      for (const s of [card?.number, card?.cvv]) if (s) msg = msg.split(s).join('***');
      return msg.replace(/[*_`[\]]/g, '').slice(0, 160);
    };
    const anotar = (paso, e) => nuevos.push({ hora: new Date(now()).toISOString(), paso, error: limpiar(e) });

    const armarResultado = () => ({
      tramos: [...comprados.keys()].sort((a, b) => a - b).map((i) => {
        const { flight: f, pnr, tasas } = comprados.get(i);
        return { code: f.code, from: f.from, to: f.to, departsAt: f.departsAt, arrivesAt: f.arrivesAt, pnr, tasas };
      }),
    });

    // Persiste sin pisar un estado que no pusimos nosotros (un `cancelado` del
    // usuario a mitad del loop gana). Los intentos pendientes van primero, de a uno.
    const guardar = async (extra = {}, estado = 'confirmado') => {
      const actual = await getOrder(store, order.id);
      const e = actual?.estado === 'confirmado' ? estado : actual?.estado ?? estado;
      while (persistidos < nuevos.length) await setEstado(store, order.id, e, { intento: nuevos[persistidos++] });
      return setEstado(store, order.id, e, extra);
    };

    // Lo pagado se escribe apenas se sabe: si el proceso muere, el rescate lo ve.
    const registrar = async (i, flight, pnr, tasas) => {
      comprados.set(i, { flight, pnr: pnr ?? null, tasas });
      compradosAhora++;
      await guardar({ resultado: armarResultado(), pagoEnVuelo: null });
    };

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
          // Filas sin fecha legible no prueban nada (ni que sí ni que no): si son
          // todas así, es lo mismo que no haber podido leer.
          if (bookings.length && !bookings.some(diaDeReserva)) {
            anotar('listBookings', 'reservas sin fecha legible');
            return null;
          }
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

    // El único lugar donde se llama a doPurchase. Reglas:
    // - con `bookingsCalibrado` apagado, un resultado ambiguo termina en `dudoso`
    //   sin segundo pago (se mira una vez las reservas: si está, se compró);
    // - con el flag prendido, entre dos pagos SIEMPRE hay una espera de 15 s y un
    //   `verificar` legible sin la reserva;
    // - una cancelación (clave aparte) se mira antes del marcador y antes de pagar;
    // - un intento ambiguo (desconocido o timeout sin reserva a la vista) deja el
    //   tramo "en duda": desde ahí, cualquier resultado que no sea ok es `dudoso`,
    //   nunca otro vuelo ni `fallido` (el primer pago pudo haber cobrado);
    // - el reintento tokeniza de nuevo: el token de Spreedly es de un solo uso.
    const comprarTramo = async (i, flight) => {
      const q = await paso('quote', () => api.quote(session, flight));
      if (q === FALLO) return { tipo: 'error' };
      // El tope se mide contra lo cotizado, que es lo que se cobra (no lo que dijo la búsqueda).
      if (superaTope({ ...flight, taxes: q.total }, order)) {
        anotar('quote', `tasas ${q.total} superan el tope ${order.topeTasasPorTramoARS}`);
        return { tipo: 'fin', estado: 'fallido', motivo: 'tope',
          detalle: { ruta: ruta(flight), monto: q.total, tope: order.topeTasasPorTramoARS } };
      }
      let ambiguo = false;
      for (let k = 0; k < 2; k++) {
        const init = await paso('initPayment', () => api.initPayment(session));
        const token = init === FALLO ? FALLO : await paso('tokenizeCard', () => api.tokenizeCard(card, init));
        if (token === FALLO) return ambiguo ? DUDOSO : { tipo: 'error' };
        // Pasada la ventana no se paga más: un tramo ya ambiguo queda dudoso (está
        // verificado y sin reserva a la vista, no hay pago en vuelo sin resolver);
        // uno limpio cierra como cualquier fin de ventana.
        if (now() >= deadline) return ambiguo ? DUDOSO : { tipo: 'ventana' };
        // Sin el lock, otra corrida puede estar pagando este mismo pedido.
        if (!(await renovarLock(store, order.id, dueño, ttl()))) return ambiguo ? DUDOSO : { tipo: 'sin-lock' };
        // El usuario canceló: la clave aparte no la pisa ningún `guardar`.
        if (await fueCancelado(store, order.id)) return ambiguo ? DUDOSO : { tipo: 'cancelado' };

        // Marcador ANTES de pagar: si el proceso muere acá, el rescate verifica en vez de repagar.
        const g = await guardar({ pagoEnVuelo: {
          tramo: i, code: flight.code, departsAt: flight.departsAt, arrivesAt: flight.arrivesAt,
          tasas: q.total, hora: new Date(now()).toISOString(),
        } });
        if (g.estado !== 'confirmado') return ambiguo ? DUDOSO : { tipo: 'fin', estado: 'interrumpido' };
        // Entre la lectura de `guardar` y su escritura pudo entrar un cancel que el
        // marcador pisó: la clave aparte lo delata. Justo antes de pagar, se mira otra vez.
        if (await fueCancelado(store, order.id)) {
          if (ambiguo) return DUDOSO;
          await guardar({ pagoEnVuelo: null });
          return { tipo: 'cancelado' };
        }

        let r;
        try { r = await api.doPurchase(session, { token, card, quotation: q }); } catch (e) {
          anotar('doPurchase', e);
          r = { ok: false, motivo: 'desconocido', lanzo: true };
        }
        if (r.ok) return { tipo: 'comprado', pnr: r.pnr ?? null, tasas: q.total };
        if (!r.lanzo) anotar('doPurchase', r.motivo);
        const esAmbiguo = !MOTIVOS_CLAROS.includes(r.motivo);
        if (!ambiguo && (r.motivo === 'rechazada' || r.motivo === '3ds')) {
          await guardar({ pagoEnVuelo: null });
          return { tipo: 'fin', estado: 'fallido', motivo: r.motivo };
        }
        if (esAmbiguo && !bookingsCalibrado) {
          // CALIBRAR: sin el parser validado, una lista legible sin la reserva no
          // prueba que no cobró. Se mira una vez (si está, se compró); si no, dudoso
          // y sin reintento. Nunca hay un segundo doPurchase por este camino.
          const v = await verificar(flight);
          return v?.reservado ? { tipo: 'comprado', pnr: v.pnr, tasas: q.total } : DUDOSO;
        }
        // Flag prendido: se le da tiempo a la reserva a aparecer antes de mirar.
        if (esAmbiguo || ambiguo) await sleep(ESPERA_RESERVA);
        const v = await verificar(flight);
        if (!v) return DUDOSO;
        if (v.reservado) return { tipo: 'comprado', pnr: v.pnr, tasas: q.total };
        if (ambiguo) return DUDOSO;
        if (r.motivo === 'sin-cupo') { await guardar({ pagoEnVuelo: null }); return { tipo: 'sin-cupo' }; }
        ambiguo = true; // desconocido sin reserva a la vista: un solo reintento
      }
      return DUDOSO;
    };

    let final = null;

    // Una corrida anterior murió con un pago en vuelo: primero se resuelve eso.
    const pev = fresco.pagoEnVuelo;
    if (pev && !comprados.has(pev.tramo)) {
      const v = await verificar(pev);
      if (v?.reservado) {
        const t = order.tramos[pev.tramo];
        await registrar(pev.tramo, { code: pev.code, from: t.from, to: t.to, departsAt: pev.departsAt, arrivesAt: pev.arrivesAt, seats: 1 }, v.pnr, pev.tasas ?? null);
      } else {
        if (v) anotar('recuperacion', `pago en vuelo de ${pev.code} sin reserva a la vista`);
        final = { estado: 'dudoso', motivo: 'dudoso' };
      }
    }
    if (!final && comprados.size === n) final = { estado: 'comprado' };

    let pausa = 0;
    let cerrado = false; // la ventana se cerró a mitad de una vuelta
    for (let vuelta = 0; !final && !cerrado; vuelta++) {
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
        // Ya hay algo comprado y lo que falta no aparece: en el cierre es parcial;
        // antes, se sigue buscando (lo comprado queda fijo y no se recompra).
        if (comprados.size && cierre) final = { estado: 'parcial' };
        continue;
      }

      // 3) Comprar, primero el tramo más escaso.
      let reBuscar = false;
      for (const i of aComprar) {
        // El usuario pudo cancelar mientras buscábamos: se mira justo antes de cotizar.
        if ((await getOrder(store, order.id))?.estado !== 'confirmado') { final = { estado: 'interrumpido' }; break; }
        // La búsqueda pudo comerse lo que quedaba de la ventana.
        if (now() >= deadline) { cerrado = true; break; }
        const flight = it.tramos[i];
        const r = await comprarTramo(i, flight);
        if (r.tipo === 'comprado') { await registrar(i, flight, r.pnr, r.tasas); continue; }
        if (r.tipo === 'ventana') { cerrado = true; break; }
        if (r.tipo === 'sin-lock') { final = { estado: 'sin-lock' }; break; }
        if (r.tipo === 'cancelado') { final = { estado: 'cancelado' }; break; }
        if (r.tipo === 'error') pausa = PAUSA_ERROR;
        if (r.tipo === 'fin') final = { estado: r.estado, motivo: r.motivo, detalle: r.detalle };
        reBuscar = true;
        break;
      }
      if (final || cerrado) break;
      if (comprados.size === n) { final = { estado: 'comprado' }; break; }
      if (!reBuscar && it.faltan?.length && comprados.size && cierre) final = { estado: 'parcial' };
    }

    // Otra corrida tiene el lock: ella escribe y avisa. Acá no se toca nada.
    if (final?.estado === 'sin-lock') {
      const o = await getOrder(store, order.id);
      return { estado: o?.estado ?? 'confirmado', resultado: o?.resultado ?? null, intentos: o?.intentos ?? [], motivo: null };
    }
    // Interrumpido sin nada comprado: el estado y el resultado son de quien lo cambió.
    if (final?.estado === 'interrumpido' && !comprados.size) {
      const o = await getOrder(store, order.id);
      const estado = o?.estado ?? 'desconocido';
      const texto = estado === 'cancelado'
        ? CANCELADO_TXT
        : `⏹️ El pedido ya no está confirmado (estado ${estado}), no compré nada más.`;
      try { await notify(texto, chatId); } catch (e) { console.error(`buy: no pude avisar: ${limpiar(e)}`); }
      return { estado, resultado: o?.resultado ?? null, intentos: o?.intentos ?? [], motivo: null };
    }

    if (!final && !cierre) {
      // Se terminó la ventana sin cupo (o sin todo el cupo): el pedido sigue
      // `confirmado` para los rescates, con lo comprado y los intentos persistidos.
      anotar('search', `sin cupo hasta las ${horaAR(deadline)}`);
      const resultado = armarResultado();
      const guardado = await guardar(comprados.size ? { resultado } : {});
      const partes = [];
      if (compradosAhora) partes.push(formatCompra(order, resultado));
      if (guardado.estado === 'cancelado') {
        if (compradosAhora) partes.push(CANCELADO_TXT);
      } else if (avisarSinCupo || compradosAhora) {
        partes.push(`⏳ Sin cupo hasta las ${horaAR(deadline)}, sigo intentando en los rescates.`);
      }
      if (partes.length) {
        try { await notify(partes.join('\n\n'), chatId); } catch (e) { console.error(`buy: no pude avisar: ${limpiar(e)}`); }
      }
      return { estado: guardado.estado, resultado, intentos: guardado.intentos, motivo: null };
    }
    if (!final) {
      // El cierre (23:00 del día anterior al vuelo): ya no hay más pasadas.
      final = { estado: 'fallido', motivo: 'sin-cupo' };
      anotar('search', 'sin cupo hasta el cierre');
    }
    // Un fallo después de haber comprado algún tramo es un parcial: hay plata gastada.
    if (final.estado === 'fallido' && comprados.size) final = { ...final, estado: 'parcial' };

    const resultado = armarResultado();
    if (final.estado === 'parcial') resultado.faltan = order.tramos.map((_, i) => i).filter((i) => !comprados.has(i));

    // `guardar` relee: un `cancelado` del usuario no se pisa, pero lo comprado queda registrado.
    const guardado = await guardar({
      resultado, motivo: final.motivo ?? null, detalle: final.detalle ?? null,
      ...(final.estado === 'dudoso' ? {} : { pagoEnVuelo: null }),
    }, final.estado === 'interrumpido' ? 'confirmado' : final.estado);
    // `cancelado` desde la clave aparte: `guardar` lo escribe si el estado había quedado pisado.

    const partes = [];
    if (comprados.size) partes.push(formatCompra(order, resultado));
    if (final.estado === 'dudoso') partes.push(formatFallo({ ...guardado, estado: 'dudoso' }, nuevos));
    else if (guardado.estado === 'cancelado') partes.push(CANCELADO_TXT);
    else if (final.estado === 'interrumpido') partes.push(`⏹️ El pedido ya no está confirmado (estado ${guardado.estado}), no compré nada más.`);
    else if (final.estado === 'fallido') partes.push(formatFallo(guardado, nuevos));
    else if (final.estado === 'parcial' && final.motivo) partes.push(`🔴 No compré el resto: ${motivoTexto(final.motivo, final.detalle)}.`);
    try { await notify(partes.join('\n\n'), chatId); } catch (e) { console.error(`buy: no pude avisar: ${limpiar(e)}`); }

    return { estado: guardado.estado, resultado, intentos: guardado.intentos, motivo: final.motivo ?? null };
  } finally {
    // Sólo el propio: si el TTL venció y otra corrida lo tomó, el suyo queda.
    await unlockOrder(store, order.id, dueño);
  }
}
