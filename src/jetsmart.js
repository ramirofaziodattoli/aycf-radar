// Cliente de la API de disponibilidad AYCF (backend Caravelo, Laravel).
//
//   POST /es-ar/ja/subscriptions/availability/{passId}
//   Accept: application/vnd.cvo.subs.frontend+json
//
// Horizonte: D+1 y nada más. Los T&C fijan la ventana de canje entre 24h y 120min
// antes de la salida, y el inventario se libera a las 00:01 por día calendario.
// Consultar D+2 devuelve vacío siempre.

import { SessionExpiredError, TOKEN_MISMATCH } from './session.js';
import { UA } from './login.js';
import { saveCatalog } from './airports.js';

const BASE = process.env.AYCF_BASE_URL || 'https://go.jetsmart.com/es-ar/ja/subscriptions';

export const REDEMPTION_URL = `${BASE}/spa/private-page/redemption`;

/** Normaliza el vuelo crudo a lo que nos importa. */
export function normalize(f) {
  return {
    code: f.flightCode,
    from: f.departureStationCode ?? f.departureStation,
    to: f.arrivalStationCode ?? f.arrivalStation,
    departsAt: f.departureDateTimeIso,
    arrivesAt: f.arrivalDateTimeIso,
    departsHHMM: (f.departureDateTimeIso ?? '').slice(11, 16) || f.departure,
    arrivesHHMM: (f.arrivalDateTimeIso ?? '').slice(11, 16) || f.arrival,
    duration: f.duration,
    stops: f.stops,
    seats: f.availableSeats ?? 0,
    taxes: parseAmount(f.taxes),
    taxesText: f.taxes,
    currency: f.currency,
    key: f.key,
    fareSellKey: f.fareSellKey,
  };
}

/** "15,103.85" -> 15103.85. Caravelo formatea con coma de miles y punto decimal. */
export function parseAmount(s) {
  if (typeof s !== 'string') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export class SinPaseError extends Error {
  constructor() {
    super('no sé cuál es tu pase AYCF. Mandame `/pase <uuid>` y lo guardo.');
    this.name = 'SinPaseError';
  }
}

/**
 * El pase es por persona. Está en la URL del request `availability/...` del portal,
 * pero pedírselo al usuario es fricción: primero probamos sacarlo del HTML de la
 * página privada. Lo que devuelve se VERIFICA con una búsqueda real antes de
 * guardarlo, así que un UUID equivocado no queda pegado.
 */
export async function discoverPassId(session) {
  const encontrados = new Set();
  // Dos páginas porque no sabemos en cuál lo embebe el SPA; el que sirve lo
  // decide la verificación, no nosotros.
  for (const url of [REDEMPTION_URL, `${BASE}/spa/private-page`, BASE]) {
    try {
      const res = await fetch(url, {
        headers: { cookie: session.header(), accept: 'text/html', 'user-agent': UA },
        signal: AbortSignal.timeout(20_000),
      });
      const html = await res.text();
      for (const m of html.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
        encontrados.add(m[0].toLowerCase());
      }
    } catch {
      // una página que no responde no invalida a las otras
    }
    if (encontrados.size) break;
  }
  // Cada candidato cuesta un request de verificación: no probamos veinte.
  return [...encontrados].slice(0, 6);
}

export async function search(session, { from, to, date }, store = null) {
  const passId = session.passId;
  if (!passId) throw new SinPaseError();

  const res = await fetch(`${BASE}/availability/${passId}`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.cvo.subs.frontend+json',
      'content-type': 'application/json',
      cookie: session.header(),
    },
    body: JSON.stringify({
      flightType: 'OW',
      origin: from,
      destination: to,
      departure: date,
      arrival: null,
      intervalSubtype: null,
      outboundKey: null,
    }),
  });

  if (res.status === 401 || res.status === 403) throw new SessionExpiredError();

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`respuesta no-JSON de Caravelo (${res.status}): ${text.slice(0, 200)}`);
  }

  // Caravelo también expulsa con 200 + redirectUri al login.
  if (payload.redirectUri) throw new SessionExpiredError();

  // Los errores vienen en un envelope anidado: content.exceptionMessage.
  const motivo = payload.content?.exceptionMessage ?? payload.exceptionMessage;
  if (motivo === TOKEN_MISMATCH) {
    throw new SessionExpiredError(
      'la cookie quedó superada. El ID de sesión rota en cada request: si seguiste ' +
      'navegando el portal después de copiarla, la tuya ya no vale. Copiala y no ' +
      'vuelvas a tocar el portal.'
    );
  }

  // CRÍTICO: sin esto un 500 se lee como "no hay cupo" y el radar te miente
  // diciendo que no hay lugar cuando en realidad el request falló.
  if (!res.ok) {
    throw new Error(`Caravelo respondió ${res.status}${motivo ? ` (${motivo})` : ''}`);
  }

  // Solo acá renovamos: la respuesta vino autenticada.
  await session.absorb(res);

  // La respuesta trae la red entera; la cacheamos para resolver nombres de ciudad
  // y para saber qué rutas existen sin hardcodear nada.
  if (store && payload.content?.routes?.length) {
    await saveCatalog(store, payload.content.routes).catch(() => {});
  }

  return (payload.content?.flights?.flightsOutbound ?? []).map(normalize);
}
