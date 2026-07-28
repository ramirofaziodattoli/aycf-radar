// Catálogo de aeropuertos y rutas, sacado de la propia API.
//
// Cada respuesta de disponibilidad trae `content.routes`: las 51 rutas de la red
// con el nombre de cada estación. Lo cacheamos en vez de hardcodear una lista que
// se desactualiza cuando JetSMART agrega o saca destinos.
//
// Sirve para dos cosas:
//   1. Escribir "bariloche" en vez de "BRC".
//   2. Avisarte cuando una ruta NO existe en la red, en lugar de dejarte vigilando
//      algo que va a devolver vacío para siempre (ej: Córdoba–Salta no está).

const KEY = 'catalog:routes';
const TTL = 60 * 60 * 24 * 7;

/** Sin acentos, minúsculas: "Córdoba" y "cordoba" tienen que matchear. */
export function normalize(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** De `content.routes` a { aeropuertos: {IATA: nombre}, rutas: Set("AEP-SLA") }. */
export function parseCatalog(routes = []) {
  const aeropuertos = {};
  const rutas = new Set();
  for (const r of routes) {
    const from = r.departureStation;
    if (!from?.id) continue;
    aeropuertos[from.id] = from.name || from.id;
    for (const to of r.arrivalStations ?? []) {
      if (!to?.id) continue;
      aeropuertos[to.id] = to.name || to.id;
      rutas.add(`${from.id}-${to.id}`);
    }
  }
  return { aeropuertos, rutas: [...rutas] };
}

export async function saveCatalog(store, routes) {
  const cat = parseCatalog(routes);
  if (Object.keys(cat.aeropuertos).length) await store.set(KEY, cat, TTL);
  return cat;
}

export async function getCatalog(store) {
  const c = await store.get(KEY);
  return c && c.aeropuertos ? c : null;
}

/**
 * Resuelve lo que escribió el usuario a un IATA.
 * Devuelve { iata } si hay uno solo, o { opciones } si es ambiguo.
 */
export function resolveAirport(query, aeropuertos) {
  const q = normalize(query);
  const entradas = Object.entries(aeropuertos);

  const porCodigo = entradas.find(([iata]) => normalize(iata) === q);
  if (porCodigo) return { iata: porCodigo[0] };

  const exactos = entradas.filter(([, nombre]) => normalize(nombre) === q);
  if (exactos.length === 1) return { iata: exactos[0][0] };

  const parciales = entradas.filter(([, nombre]) => normalize(nombre).includes(q));
  if (parciales.length === 1) return { iata: parciales[0][0] };
  if (parciales.length > 1) {
    return { opciones: parciales.map(([iata, nombre]) => `${iata} (${nombre})`) };
  }
  return {};
}

export function airportName(iata, aeropuertos) {
  return aeropuertos?.[iata] || iata;
}

export function routeExists(from, to, rutas) {
  if (!rutas?.length) return true; // sin catálogo todavía, no bloqueamos
  return rutas.includes(`${from}-${to}`);
}

/** Destinos directos desde un aeropuerto. */
export function destinationsFrom(from, rutas, aeropuertos) {
  return rutas
    .filter((r) => r.startsWith(`${from}-`))
    .map((r) => r.split('-')[1])
    .map((iata) => `${iata} — ${airportName(iata, aeropuertos)}`)
    .sort();
}
