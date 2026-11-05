// Cliente de los pasos de compra de Caravelo: cotizar, pagar y verificar.
//
// Es lo que hace el navegador cuando un socio canjea un vuelo: cotización →
// INIT del orquestador de pagos → tokenización de la tarjeta en Spreedly →
// do-purchase. La tarjeta SOLO viaja a Spreedly (PCI): a Caravelo le llega el
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
  if (!res.ok || !token) throw fallaSpreedly(res, json);
  return token;
}

/** Error de Spreedly sin nada del body: status y, si vienen, las claves de error (`errors.blank`). */
function fallaSpreedly(res, json) {
  const errores = json?.errors ?? json?.transaction?.payment_method?.errors ?? json?.transaction?.errors;
  const claves = (Array.isArray(errores) ? errores : [])
    .map((e) => e?.key).filter((k) => typeof k === 'string' && /^[\w.-]{1,60}$/.test(k));
  return new Error(`tokenización: Spreedly respondió ${res.status}${claves.length ? ` (${claves.join(', ')})` : ''}`);
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
  // Los <script> de la página traen strings de error genéricos ("declined"): no cuentan.
  const visible = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const marcador = `${msg ?? ''} ${visible}`;
  const es2xx = res.status >= 200 && res.status < 300;

  // Un 5xx no dice nada del pago: «Service Unavailable» / «temporarily unavailable»
  // NO es sin cupo (leerlo así habilitaba pagar otro vuelo). Siempre desconocido.
  if (res.status >= 500) return { ok: false, motivo: 'desconocido', raw };

  // En un 2xx el texto NUNCA decide un fallo: si el cobro pasó, reintentar por un
  // "sin cupo" falso cobraría dos veces. Solo el exceptionMessage JSON es confiable.
  if (/declin|rechaz/i.test(es2xx ? (msg ?? '') : marcador)) return { ok: false, motivo: 'rechazada', raw };

  // Éxito SOLO con señal positiva: un 2xx pelado no prueba nada (Caravelo devuelve
  // 200 con {"success":false} o con páginas de error). Sin señal → 'desconocido' y
  // el loop verifica contra las reservas antes de reintentar.
  if (es2xx && !msg) {
    const pnr = señalDeExito(json, visible);
    if (pnr !== null) return { ok: true, pnr: pnr || undefined, raw };
  }

  // CALIBRAR: sin-cupo sólo en un 4xx y con señal inequívoca: un exceptionMessage
  // que es un CÓDIGO (sin espacios) y nombra asientos/cupo/availability, o una frase
  // explícita en el texto visible. Nada de `availab` suelto: matchea «unavailable».
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

// CALIBRAR: reglas de éxito positivo provisorias; se confirman con la compra real.
// Devuelve el PNR ('' si hay éxito sin PNR legible) o null si no hay señal de éxito.
function señalDeExito(json, text) {
  const j = json?.content ?? json;
  const pnr = j?.pnr ?? j?.bookingReference ?? j?.recordLocator;
  if (typeof pnr === 'string' && pnr) return pnr;
  if (/^(ok|confirmed|success)$/i.test(String(json?.status ?? j?.status ?? ''))) return '';
  const plano = text.replace(/<[^>]+>/g, ' ');
  // "no confirmada" / "unconfirmed" no son confirmación.
  const m = /(?<!\bno\s)(?<!\bun)(?:confirmad|confirmed)|éxito|exitosa/i.exec(plano);
  if (!m) return null;
  const cerca = plano.slice(Math.max(0, m.index - 120), m.index + 120);
  // El PNR lleva al menos un dígito y no es un código de vuelo (JA3021 también tiene 6).
  const code = [...cerca.matchAll(/\b[A-Z0-9]{6}\b/g)].map((x) => x[0])
    .find((c) => /\d/.test(c) && !/^JA\d{3,4}$/.test(c));
  return code ?? null;
}

const ok2xx = (res) => res.status >= 200 && res.status < 300;

function fechaISO(t) {
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(t);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Reservas del pase, para verificar después de comprar (o ante un timeout).
 * PROVISORIO (CALIBRAR): no sabemos si el endpoint responde JSON o solo HTML.
 * `[]` solo si hay prueba positiva de "lista vacía"; ante un body que no
 * reconocemos (login, error con 200) tiramos, porque un [] falso haría recomprar.
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

  let ult = null;
  for (const accept of ['application/vnd.cvo.subs.frontend+json', 'application/json']) {
    const r = await intentar(accept);
    if (r) ult = r;
    const lista = r && ok2xx(r.res) ? (r.json?.content?.content ?? (Array.isArray(r.json) ? r.json : null)) : null;
    if (Array.isArray(lista)) {
      return lista.map((b) => ({
        pnr: b.pnr ?? b.recordLocator ?? b.code,
        flightCode: b.flightCode ?? b.code,
        date: b.date ?? b.departureDate ?? null,
        from: b.from ?? b.origin ?? null,
        to: b.to ?? b.destination ?? null,
      }));
    }
  }

  const h = await intentar('text/html');
  if (h) ult = h;
  if (h && ok2xx(h.res)) {
    const html = h.text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    const filas = [];
    for (const m of html.matchAll(/<(tr|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const t = m[2].replace(/<[^>]+>/g, ' ');
      const flightCode = /\bJA\d{3,4}\b/.exec(t)?.[0];
      if (!flightCode) continue; // sin código de vuelo la fila no sirve para hayReserva
      const pnr = [...t.matchAll(/\b[A-Z0-9]{6}\b/g)].map((x) => x[0]).find((c) => c !== flightCode);
      if (!pnr) continue;
      const date = fechaISO(t);
      filas.push(date ? { pnr, flightCode, date } : { pnr, flightCode });
    }
    if (filas.length) return filas;
    // Sin filas: vacío solo si la página dice ser la de reservas.
    if (/<h[1-6][^>]*>[^<]*(reserva|booking)/i.test(html)) return [];
  }

  if (ult) console.log(`bookings: status ${ult.res.status} ${ult.text.slice(0, 120)}`);
  throw new Error('bookings-unavailable');
}

/** Día YYYY-MM-DD de una fila de reservas, o null si no trae una fecha legible. */
export function diaDeReserva(b) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(b?.date ?? ''));
  return m ? m[1] : null;
}

/**
 * ¿Ya hay una reserva de este vuelo (mismo código y mismo día)?
 * Una fila sin fecha legible no prueba nada: el mismo número de vuelo sale todos
 * los días, así que no cuenta (quien verifica decide qué hacer si TODAS vienen sin fecha).
 */
// CALIBRAR: el parser de reservas no se validó con una compra real; hasta entonces
// este match es la única prueba de «compró» y por eso exige código + día.
export function hayReserva(bookings, flight) {
  const dia = String(flight.departsAt ?? '').slice(0, 10);
  return bookings.some((b) => (b.flightCode ?? b.code) === flight.code && diaDeReserva(b) === dia);
}
