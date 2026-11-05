// Elegir qué vuelos comprar para un pedido. Puro: sin estado ni I/O, así se testea
// con vuelos armados a mano y la compra (otro módulo) sólo ejecuta lo que sale de acá.

const MIN_ENTRE_AEROPUERTOS = 4; // AEP↔EZE: hay un traslado de por medio

/** Horas mínimas entre la llegada del tramo i-1 y la salida del tramo i. */
export function escalaMinima(order, i) {
  if (i === 0) return 0;
  const a = order.tramos[i - 1].to;
  const b = order.tramos[i].from;
  const cambiaDeAeropuerto = (a === 'AEP' && b === 'EZE') || (a === 'EZE' && b === 'AEP');
  return cambiaDeAeropuerto ? Math.max(order.escalaMinimaHoras, MIN_ENTRE_AEROPUERTOS) : order.escalaMinimaHoras;
}

// "YYYY-MM-DD HH:MM:SS" son horas locales sin zona: se parsean como UTC sólo para poder
// restarlas. Aeropuertos argentinos, un solo huso: no hace falta más (y cruza medianoche).
const ms = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
const HORA = 3600 * 1000;

/** ventana = [HH:MM, HH:MM] inclusiva sobre la salida; nula = cualquier hora. */
export function enVentana(flight, ventana) {
  if (!ventana) return true;
  const hhmm = flight.departsAt.slice(11, 16);
  return hhmm >= ventana[0] && hhmm <= ventana[1];
}

/**
 * Sólo se compran vuelos directos. Uno con escala es otro producto: la cotización
 * y el pago son de varios segmentos, la escala mínima entre tramos del pedido no
 * contempla la conexión interna y la verificación (ruta + salida en el eventsLog)
 * se diseñó con un segmento. Sin el dato (lo ya comprado entra fijo sin `stops`)
 * cuenta como directo; cualquier valor explícito que no sea 0/«Directo» queda afuera.
 */
export function esDirecto(flight) {
  const s = flight.stops;
  return s == null || s === 0 || String(s).trim() === '0' || /^direct[oa]?$/i.test(String(s).trim());
}

export function superaTope(flight, order) {
  return flight.taxes > order.topeTasasPorTramoARS;
}

/** Orden de compra: primero el vuelo con menos asientos (se agota antes); empate, orden de viaje. */
export function ordenDeCompra(itinerario) {
  const tramos = Array.isArray(itinerario) ? itinerario : itinerario.tramos;
  return tramos.map((_, i) => i).sort((a, b) => tramos[a].seats - tramos[b].seats || a - b);
}

// Todas las cadenas completas de los primeros `k` tramos.
function combinaciones(order, candidatos, k) {
  const out = [];
  const rec = (i, acc) => {
    if (i === k) return out.push(acc);
    for (const f of candidatos[i]) {
      if (i > 0 && ms(acc[i - 1].arrivesAt) + escalaMinima(order, i) * HORA > ms(f.departsAt)) continue;
      rec(i + 1, [...acc, f]);
    }
  };
  rec(0, []);
  return out;
}

const margenTotal = (c) => c.slice(1).reduce((s, f, i) => s + (ms(f.departsAt) - ms(c[i].arrivesAt)), 0);

function mejor(order, combos) {
  const sale = (c) => ms(c[0].departsAt);
  const cmp = {
    'lo más temprano posible': (a, b) => sale(a) - sale(b) || margenTotal(b) - margenTotal(a),
    'lo más tarde posible': (a, b) => sale(b) - sale(a) || margenTotal(b) - margenTotal(a),
    // Más holgura = más aire ante demoras; con un solo tramo no hay holgura y desempata la salida tardía.
  }[order.preferencia] ?? ((a, b) => margenTotal(b) - margenTotal(a) || sale(b) - sale(a));
  return [...combos].sort(cmp)[0];
}

/**
 * Devuelve la combinación completa si existe; si no, el prefijo más largo de tramos que
 * encadena (un tramo posterior solo no sirve) y `faltan` con los índices sin vuelo.
 */
export function chooseItinerary(order, flightsPorTramo) {
  const candidatos = order.tramos.map((t, i) =>
    (flightsPorTramo[i] ?? []).filter((f) => f.seats >= 1 && esDirecto(f) && enVentana(f, t.ventana)));
  const n = order.tramos.length;
  for (let k = n; k >= 1; k--) {
    const combos = combinaciones(order, candidatos, k);
    if (combos.length === 0) continue;
    const tramos = mejor(order, combos);
    return k === n ? { tramos } : { tramos, faltan: Array.from({ length: n - k }, (_, j) => k + j) };
  }
  return { tramos: [], faltan: order.tramos.map((_, i) => i) };
}
