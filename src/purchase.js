// Cliente de los pasos de compra de Caravelo: cotizar, pagar y verificar.
//
// Es lo que hace el navegador cuando un socio canjea un vuelo: cotización →
// INIT del orquestador de pagos → tokenización de la tarjeta en Spreedly →
// do-purchase. La tarjeta SOLO viaja a Spreedly (PCI): a Caravelo le llega el
// token. Cada función recibe `{ _fetch }` al final para poder testear sin red.
//
// Regla de logs: jamás un body (lleva tarjeta o datos de la cuenta). Si algo
// falla se loguea `status` + los primeros 120 chars de la RESPUESTA.

import { SessionExpiredError, TOKEN_MISMATCH } from './session.js';
import { UA } from './login.js';
import { BASE, parseAmount } from './jetsmart.js';

const SPREEDLY_URL = 'https://core.spreedly.com/v1/payment_methods.json';

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

  if (json?.redirectUri) throw new SessionExpiredError();
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
  const total = parseAmount(String(c.total?.text ?? '').replace(/[^\d.,]/g, '')) ?? c.total?.qty;
  if (!Number.isFinite(total)) throw falla('cotización sin total', res, text);
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
 * Tokeniza la tarjeta directo en Spreedly. SIN cookie de Caravelo y fuera del
 * mapeo de sesión: es otro host y otro contrato.
 */
// CALIBRAR: esta forma de body es la relevada del frontend pero no está confirmada;
// se ajusta con la compra de calibración real (Task 8).
export async function tokenizeCard(card, init, { _fetch = fetch } = {}) {
  const res = await _fetch(SPREEDLY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      payment_method: {
        credit_card: {
          full_name: card.holder, number: card.number,
          month: card.month, year: card.year, verification_value: card.cvv,
        },
      },
      certificate_token: init.certificateToken,
      nonce: init.nonce,
      timestamp: init.timestamp,
      signature: init.signature,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* se informa abajo */ }
  const token = json?.transaction?.payment_method?.token;
  if (!res.ok || !token) throw falla('tokenización', res, text);
  return token;
}

/**
 * Ejecuta la compra con el token. Clasifica el fallo para que el caller sepa si
 * reintentar (sin-cupo), pedir al usuario (3ds) o frenar (rechazada).
 */
// CALIBRAR: body form-urlencoded y parseo de la respuesta son provisorios; se
// confirman con la compra de calibración real (Task 8).
export async function doPurchase(session, { token, card, quotation }, { _fetch = fetch } = {}) {
  const passId = exigirPase(session);
  const form = new URLSearchParams({
    'payment-method-token': token,
    month: card.month,
    year: card.year,
    full_name: card.holder,
    payment_method_reference: '',
    txvariant: 'card',
  });
  // `redirect: manual` porque un 3xx hacia el ACS del banco ES la señal de 3DS.
  const { res, text, json } = await pedir(session, `${BASE}/${passId}/do-purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json, text/html' },
    body: form.toString(),
    redirect: 'manual',
  }, { _fetch });

  const raw = text.slice(0, 300);
  const msg = json?.content?.exceptionMessage ?? json?.exceptionMessage ?? null;
  const marcador = `${msg ?? ''} ${text}`;

  if (/declin|rechaz/i.test(marcador)) return { ok: false, motivo: 'rechazada', raw };
  if (res.status >= 300 && res.status < 400) return { ok: false, motivo: '3ds', raw };
  if (res.status >= 200 && res.status < 300 && !msg) return { ok: true, raw };

  // Fuera del 2xx limpio sí miramos el texto: en una página de éxito, palabras
  // como "acs" o "availab" podrían aparecer de casualidad y NO deben abortar.
  if (/no.?seat|sin cupo|availab/i.test(marcador)) return { ok: false, motivo: 'sin-cupo', raw };
  if (/3ds|three.?d|challenge|acs/i.test(marcador)) return { ok: false, motivo: '3ds', raw };
  return { ok: false, motivo: 'desconocido', raw };
}

const ok2xx = (res) => res.status >= 200 && res.status < 300;

/**
 * Reservas del pase, para verificar después de comprar (o ante un timeout).
 * PROVISORIO: no sabemos si el endpoint responde JSON o solo HTML; probamos las
 * dos variantes y la de HTML es best effort. Se confirma en la calibración.
 */
export async function listBookings(session, { _fetch = fetch } = {}) {
  const passId = exigirPase(session);
  const url = `${BASE}/profile/${passId}/bookings`;
  const intentar = async (accept) => {
    try {
      return await pedir(session, url, { method: 'GET', headers: { accept } }, { _fetch });
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      return null; // red caída o timeout: probamos la otra variante
    }
  };

  const a = await intentar('application/vnd.cvo.subs.frontend+json');
  const lista = a && ok2xx(a.res) ? a.json?.content?.content : null;
  if (Array.isArray(lista)) {
    return lista.map((b) => ({
      pnr: b.pnr ?? b.recordLocator ?? b.code,
      flightCode: b.flightCode ?? b.code,
      date: b.date ?? b.departureDate ?? null,
      from: b.from ?? b.origin ?? null,
      to: b.to ?? b.destination ?? null,
    }));
  }

  const h = await intentar('text/html');
  if (h && ok2xx(h.res)) {
    // Solo miramos líneas que hablan de PNR/Reserva para no confundir con ids ajenos.
    const lineas = h.text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/?(li|tr|div|p|section|article|h\d|td|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n');
    const vistos = new Set();
    for (const l of lineas) {
      if (!/PNR|Reserva/.test(l)) continue;
      for (const m of l.matchAll(/\b[A-Z0-9]{6}\b/g)) vistos.add(m[0]);
    }
    return [...vistos].map((pnr) => ({ pnr }));
  }

  const ult = h ?? a;
  if (ult) console.log(`bookings: status ${ult.res.status} ${ult.text.slice(0, 120)}`);
  throw new Error('bookings-unavailable');
}

/** ¿Ya hay una reserva de este vuelo (mismo código y mismo día)? */
export function hayReserva(bookings, flight) {
  const dia = String(flight.departsAt ?? '').slice(0, 10);
  return bookings.some((b) => {
    if ((b.flightCode ?? b.code) !== flight.code) return false;
    return b.date ? String(b.date).slice(0, 10) === dia : true;
  });
}
