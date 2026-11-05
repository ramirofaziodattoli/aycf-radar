// Cliente de los pasos de compra de Caravelo: cotizar, pagar y verificar.
//
// Es lo que hace el navegador cuando un socio canjea un vuelo: cotización →
// INIT del orquestador de pagos → tokenización de la tarjeta en Spreedly →
// do-purchase → payment-summary (PNR). Formas calibradas con la compra real del
// 05/11 (W7F5SS). La tarjeta SOLO viaja a Spreedly (PCI): a Caravelo le llega el
// token. Cada función recibe `{ _fetch }` al final para poder testear sin red.
//
// Regla de logs: jamás un body (lleva tarjeta o datos de la cuenta). Si algo
// falla en Caravelo se loguea `status` + los primeros 120 chars de la RESPUESTA.
// Spreedly es la excepción: su respuesta refleja datos de la tarjeta
// (`first_six`, `last_four`, `full_name`), así que de ella sólo sale el status y
// las `errors[].key`.

import { SessionExpiredError, TOKEN_MISMATCH } from './session.js';
import { UA } from './login.js';
import { BASE, parseAmount } from './jetsmart.js';

const LOGIN_RE = /\/auth\/login|\/auth\/realms\/|openid-connect|\/login/i;
const SPREEDLY_URL = 'https://core.spreedly.com/v1/payment_methods/restricted.json?from=iframe&v=1.193';

function exigirPase(session) {
  if (!session.passId) throw new Error('no hay pase AYCF para comprar');
  return session.passId;
}

/**
 * Único camino a Caravelo. Mismo criterio que `search()`: 401/403, `redirectUri`
 * y token-mismatch son sesión muerta, y `absorb` (renovar cookie) va SOLO en 2xx
 * porque un 401 trae cookie anónima que pisaría la buena.
 * Devuelve { res, text, json } con json=null si el body no es JSON.
 */
async function pedir(session, url, init, { _fetch = fetch } = {}) {
  const res = await _fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...init.headers, cookie: session.header() },
    // Mismo techo explícito de 30 s que la búsqueda (CloudFront corta ahí).
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401 || res.status === 403) throw new SessionExpiredError();

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no-JSON: lo decide el caller */ }

  // Un redirectUri que no apunta a login/auth no es sesión muerta: lo decide el caller.
  if (json?.redirectUri && LOGIN_RE.test(String(json.redirectUri))) throw new SessionExpiredError();
  const motivo = json?.content?.exceptionMessage ?? json?.exceptionMessage;
  if (motivo === TOKEN_MISMATCH) {
    throw new SessionExpiredError('la cookie quedó superada (error.token.mismatch)');
  }

  // Solo acá la respuesta vino autenticada.
  if (res.status >= 200 && res.status < 300) await session.absorb(res);
  return { res, text, json };
}

const falla = (que, res, text) =>
  new Error(`${que}: Caravelo respondió ${res.status} ${text.slice(0, 120)}`);

/** Cotiza el vuelo: total a pagar + desglose de tasas. */
export async function quote(session, flight, { _fetch = fetch } = {}) {
  const passId = exigirPase(session);
  const body = {
    outboundKey: flight.key,
    referenceOutbound: flight.key,
    outboundFareSellKey: flight.fareSellKey,
    origin: flight.from,
    destination: flight.to,
    departure: flight.departsAt,
    outboundFareBasisCode: null,
    inboundKey: null,
    inboundFareBasisCode: null,
    inboundOrigin: null,
    inboundDestination: null,
    arrival: null,
    referenceInbound: null,
    inboundFareSellKey: null,
  };
  const { res, text, json } = await pedir(session, `${BASE}/json/${passId}/quotation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }, { _fetch });

  if (!res.ok || !json) throw falla('cotización', res, text);
  const c = json.content ?? json;
  // qty manda si es número; el texto ("ARS 15103.85") es respaldo. Vacío NUNCA es 0.
  const limpio = String(c.total?.text ?? '').replace(/[^\d.,]/g, '');
  const total = Number.isFinite(c.total?.qty) ? c.total.qty : (limpio ? parseAmount(limpio) : null);
  if (!Number.isFinite(total)) throw new Error('cotización sin total');
  const breakdown = (c.pricingBreakdown ?? []).map((p) => ({
    description: p.description, amount: p.amount, code: p.code,
  }));
  return { total, breakdown };
}

/** INIT del orquestador: devuelve lo que Spreedly pide para firmar la tokenización. */
export async function initPayment(session, { _fetch = fetch } = {}) {
  const { res, text, json } = await pedir(session, `${BASE}/json/payments/orchestrator/resource`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'INIT', paymentGateway: 'spreedly' }),
  }, { _fetch });

  const d = (json?.content ?? json)?.additionalData ?? json?.additionalData;
  if (!res.ok || !d?.certificateToken) throw falla('INIT de pago', res, text);
  return {
    certificateToken: d.certificateToken, signature: d.signature,
    nonce: d.nonce, timestamp: d.timestamp,
  };
}

/**
 * Tokeniza la tarjeta directo en Spreedly, como el iframe (number-frame-1.193):
 * flujo con certificado de Caravelo, así que no hay environment key ni cookie.
 * Es otro host y otro contrato: fuera del mapeo de sesión.
 */
export async function tokenizeCard(card, init, { _fetch = fetch } = {}) {
  const res = await _fetch(SPREEDLY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      certificate_token: init.certificateToken,
      nonce: init.nonce,
      timestamp: init.timestamp,
      signature: init.signature,
      payment_method: {
        credit_card: {
          full_name: card.holder, number: card.number,
          month: card.month, year: card.year, verification_value: card.cvv,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* se informa abajo */ }
  const token = json?.transaction?.payment_method?.token;
  if (!res.ok || typeof token !== 'string' || !token) throw fallaSpreedly(res, json);
  return token;
}

/** Error de Spreedly sin nada del body: status y, si vienen, las claves de error (`errors.blank`). */
function fallaSpreedly(res, json) {
  const errores = json?.errors ?? json?.transaction?.payment_method?.errors ?? json?.transaction?.errors;
  const claves = (Array.isArray(errores) ? errores : [])
    .map((e) => e?.key).filter((k) => typeof k === 'string' && /^[\w.-]{1,60}$/.test(k));
  return new Error(`tokenización: Spreedly respondió ${res.status}${claves.length ? ` (${claves.join(', ')})` : ''}`);
}

// Lo que manda el navegador en `browserInfo` (datos para el 3DS del banco). Fijo:
// es el mismo UA del login y una pantalla de escritorio común.
const BROWSER_DATA = {
  userAgent: UA, javaEnabled: false, javascriptEnabled: true, language: 'es-419',
  colorDepth: 24, screenHeight: 1080, screenWidth: 1920, tz: '180',
  acceptHeader: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

const redirects = (json) => [json?.redirectUri].flat().filter((u) => typeof u === 'string');

/**
 * Ejecuta la compra con el token. Forma relevada de la compra real del 05/11
 * (W7F5SS): JSON con las claves del vuelo y el token; la tarjeta nunca va a
 * Caravelo. Éxito = 2xx JSON con un `redirectUri` a `payment-summary`; de ahí
 * sale el PNR (`paymentSummary`). Clasifica el fallo para que el caller sepa si
 * reintentar (sin-cupo), pedir al usuario (3ds) o frenar (rechazada).
 */
export async function doPurchase(session, { token, flight }, { _fetch = fetch } = {}) {
  const passId = exigirPase(session);
  const body = {
    paymentGateway: 'spreedly', lang: 'es-ar', currency: 'ARS',
    outboundKey: flight.key, outboundFareSellKey: flight.fareSellKey,
    browserInfo: { browserData: BROWSER_DATA },
    token,
  };
  // `redirect: manual` porque un 3xx hacia el ACS del banco ES la señal de 3DS.
  const { res, text, json } = await pedir(session, `${BASE}/${passId}/do-purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/vnd.cvo.subs.frontend+json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  }, { _fetch });

  const raw = text.slice(0, 300);
  const msg = json?.content?.exceptionMessage ?? json?.exceptionMessage ?? null;
  // Los <script> de la página traen strings de error genéricos ("declined"): no cuentan.
  const visible = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const marcador = `${msg ?? ''} ${visible}`;
  const es2xx = res.status >= 200 && res.status < 300;

  // Un 5xx no dice nada del pago: «Service Unavailable» / «temporarily unavailable»
  // NO es sin cupo (leerlo así habilitaba pagar otro vuelo). Siempre desconocido.
  if (res.status >= 500) return { ok: false, motivo: 'desconocido', raw };

  // Éxito SOLO con la señal medida: 2xx JSON, sin exceptionMessage y con el
  // redirect a payment-summary. Un 2xx con otra cosa no prueba nada → 'desconocido'
  // y el loop verifica contra las reservas antes de reintentar.
  if (es2xx && json && !msg && redirects(json).some((u) => /payment-summary/.test(u))) {
    let pnr = null;
    try { pnr = (await paymentSummary(session, { _fetch })).pnr; } catch { /* el PNR llega por mail */ }
    return { ok: true, pnr, raw };
  }

  // En un 2xx el texto NUNCA decide un fallo: si el cobro pasó, reintentar por un
  // "sin cupo" falso cobraría dos veces. Solo el exceptionMessage JSON es confiable.
  if (/declin|rechaz/i.test(es2xx ? (msg ?? '') : marcador)) return { ok: false, motivo: 'rechazada', raw };

  // Sin-cupo sólo en un 4xx y con señal inequívoca: un exceptionMessage que es un
  // CÓDIGO (sin espacios) y nombra asientos/cupo/availability, o una frase explícita
  // en el texto visible. Nada de `availab` suelto: matchea «unavailable».
  // (No se vio ningún sin-cupo real todavía: estas reglas siguen siendo las de la revisión.)
  const es4xx = res.status >= 400 && res.status < 500;
  const codigoSinCupo = typeof msg === 'string' && /^[\w.:-]+$/.test(msg) && /seat|cupo|availability/i.test(msg);
  if (es4xx && (codigoSinCupo || /no hay asientos|sin cupo|no seats available/i.test(marcador))) {
    return { ok: false, motivo: 'sin-cupo', raw };
  }

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers?.get?.('location') ?? '';
    if (LOGIN_RE.test(loc)) throw new SessionExpiredError();
    let mismoHost = true;
    try { mismoHost = new URL(loc, BASE).host === new URL(BASE).host; } catch { /* location ilegible */ }
    // Otro host = ACS del banco (3DS). Mismo host = redirect a una página de
    // confirmación: no sabemos si compró, que lo resuelva la verificación.
    return mismoHost ? { ok: false, motivo: 'desconocido', raw: loc.slice(0, 300) || raw }
                     : { ok: false, motivo: '3ds', raw: loc.slice(0, 300) };
  }
  if (!es2xx && /3ds|three.?d|challenge|acs/i.test(marcador)) return { ok: false, motivo: '3ds', raw };
  return { ok: false, motivo: 'desconocido', raw };
}

/**
 * La página de resumen después de pagar (~75 KB de JSON). Trae el PNR de la
 * última compra en `content.booking.recordLocator` y el historial del pase en
 * `content.pass.eventsLog`. Tira si no es un 2xx JSON con `content`.
 */
async function leerResumen(session, _fetch) {
  const passId = exigirPase(session);
  const { res, text, json } = await pedir(session, `${BASE}/availability/${passId}/payment-summary`, {
    method: 'GET',
    headers: { accept: 'application/vnd.cvo.subs.frontend+json' },
  }, { _fetch });
  if (!(res.status >= 200 && res.status < 300) || !json?.content) {
    console.log(`payment-summary: status ${res.status} ${text.slice(0, 120)}`);
    throw new Error('bookings-unavailable');
  }
  return json;
}

/** PNR de la última compra según payment-summary (null si no viene). */
export async function paymentSummary(session, { _fetch = fetch } = {}) {
  const json = await leerResumen(session, _fetch);
  const pnr = json.content.booking?.recordLocator;
  return { pnr: typeof pnr === 'string' && pnr ? pnr : null, raw: json };
}

/** Epoch ms → 'YYYY-MM-DD HH:MM:SS' en hora argentina (UTC-3 fijo), como `departsAt` de la búsqueda. */
const enAR = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Compras del pase, para verificar después de pagar (o ante un timeout). Sale del
 * `eventsLog` de payment-summary: sólo FLIGHT_PURCHASE confirmadas, una fila por
 * evento con el primer tramo de su ruta. Si el endpoint no responde o el log no
 * está, tira `bookings-unavailable`: un [] falso haría recomprar.
 * (`profile/{passId}/bookings` no sirve: 500 con el pase, `bookings: []` con la billetera.)
 */
export async function listBookings(session, { _fetch = fetch } = {}) {
  const json = await leerResumen(session, _fetch);
  const log = json.content.pass?.eventsLog;
  if (!Array.isArray(log)) throw new Error('bookings-unavailable');
  return log
    .filter((e) => e?.eventType === 'FLIGHT_PURCHASE' && /^confirmed$/i.test(String(e.status ?? '')))
    .filter((e) => e.route?.[0]?.departure && Number.isFinite(e.route[0].flightDate))
    .map((e) => ({
      pnr: e.recordLocator ?? null,
      from: e.route[0].departure,
      to: e.route[0].arrival,
      departsAt: enAR(e.route[0].flightDate),
      status: e.status,
      timestamp: e.timestamp ?? null,
    }));
}

/**
 * ¿Ya hay una reserva de este vuelo? Misma ruta y misma salida al minuto: el
 * eventsLog no trae el número de vuelo, y dos vuelos de la misma ruta no salen
 * a la misma hora.
 */
export function hayReserva(bookings, flight) {
  const salida = String(flight.departsAt ?? '').slice(0, 16);
  if (salida.length < 16) return false;
  return bookings.some((b) => b.from === flight.from && b.to === flight.to && String(b.departsAt ?? '').slice(0, 16) === salida);
}
