// AYCF Radar — barre las rutas de interés contra D+1 y notifica lo que tenga cupo.
//
// Horizonte: D+1 y nada más. El inventario AYCF se libera a las 00:01 del día anterior
// (T&C: canje entre 24h y 120min antes de la salida), así que D+2 siempre vuelve vacío.
// El barrido diario ES el universo canjeable completo.

const API = 'https://go.jetsmart.com/es-ar/ja/subscriptions/availability';
const CANJE = 'https://go.jetsmart.com/es-ar/ja/subscriptions/spa/private-page/redemption';

// Rutas de interés. Direccionales: la API toma origin/destination, así que la vuelta
// se declara aparte. Agregar o sacar acá, sin fechas.
export const ROUTES = [
  { from: 'BRC', to: 'AEP' },
  { from: 'BRC', to: 'EZE' },
  { from: 'AEP', to: 'BRC' },
  { from: 'EZE', to: 'BRC' },
  { from: 'COR', to: 'AEP' },
  { from: 'AEP', to: 'COR' },
  { from: 'AEP', to: 'SLA' },
  { from: 'EZE', to: 'SLA' },
  { from: 'SLA', to: 'AEP' },
  { from: 'SLA', to: 'EZE' },
];

// --- lógica pura ---

/** D+1 en ART. Argentina es UTC-3 fijo, sin DST desde 2009. */
export function tomorrowInAR(now = new Date()) {
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  ar.setUTCDate(ar.getUTCDate() + 1);
  return ar.toISOString().slice(0, 10);
}

/** flightsOutbound vacío = sin cupo. Única señal que expone el endpoint. */
export function seatsIn(payload) {
  return payload?.content?.flights?.flightsOutbound ?? [];
}

/** Sesión caída: 401/403, o redirectUri seteado (Caravelo redirige al login con 200). */
export function sessionDead(res, payload) {
  return res.status === 401 || res.status === 403 || Boolean(payload?.redirectUri);
}

/** Shape confirmado contra la API el 28/7. `availableSeats` es el dato que manda. */
export function describeFlight(f) {
  if (!f.flightCode && !f.departure) return `⚠️ shape inesperado: ${JSON.stringify(f).slice(0, 300)}`;
  const hhmm = (f.departureDateTimeIso ?? '').slice(11, 16) || f.departure;
  const llega = (f.arrivalDateTimeIso ?? '').slice(11, 16) || f.arrival;
  const asientos = f.availableSeats;
  const tasas = f.taxes ? `${f.currency ?? ''} ${f.taxes}`.trim() : null;
  return [
    `${f.flightCode} · ${hhmm}→${llega}`,
    f.duration,
    asientos != null ? `${asientos} asiento${asientos === 1 ? '' : 's'}` : null,
    tasas,
  ].filter(Boolean).join(' · ');
}

/** Con dos pasajeros, un vuelo de 1 asiento no sirve para viajar juntos. */
export function enoughSeats(flight, minSeats) {
  return (flight.availableSeats ?? 1) >= minSeats;
}

export function buildMessage(hits, date, totalRutas, minSeats = 1) {
  const cuerpo = hits
    .map((r) => {
      const vuelos = [...r.seats]
        .sort((a, b) => String(a.departureDateTimeIso).localeCompare(String(b.departureDateTimeIso)))
        .map((f) => `   • ${describeFlight(f)}`)
        .join('\n');
      const total = r.seats.reduce((n, f) => n + (f.availableSeats ?? 0), 0);
      return `✅ *${r.from}→${r.to}* — ${r.seats.length} vuelo(s), ${total} asiento(s)\n${vuelos}`;
    })
    .join('\n\n');
  const filtro = minSeats > 1 ? ` · filtrando ≥${minSeats} asientos` : '';
  return `🛫 *AYCF* — cupo para el *${date}*\n\n${cuerpo}\n\n` +
    `_${hits.length}/${totalRutas} rutas${filtro}. Se van en minutos._`;
}

/**
 * Barrido diario: por defecto solo notifica si hay algo, si no es spam todas las noches.
 * NOTIFY_EMPTY=true lo fuerza — sirve las noches en que un "no hay nada" dispara plan B.
 */
export function shouldNotify(hits, notifyEmpty) {
  return hits.length > 0 || notifyEmpty;
}

// --- IO ---

async function telegram(text, botones) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...(botones?.length ? { reply_markup: { inline_keyboard: botones } } : {}),
    }),
  });
  if (!r.ok) console.error('telegram:', r.status, await r.text());
}

async function consultar({ from, to }, date) {
  const res = await fetch(`${API}/${process.env.AYCF_PASS_ID}`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.cvo.subs.frontend+json',
      'content-type': 'application/json',
      cookie: process.env.AYCF_COOKIE,
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
  const texto = await res.text();
  try {
    return { res, payload: JSON.parse(texto) };
  } catch {
    return { res, payload: null, roto: texto.slice(0, 200) };
  }
}

export default async function handler(req, response) {
  // Vercel manda Authorization: Bearer $CRON_SECRET. Sin el check, la URL queda
  // pública y cualquiera dispara requests autenticados con la cookie de Ramiro.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return response.status(401).json({ error: 'unauthorized' });
  }

  const date = req.query?.date || tomorrowInAR();
  // Viajando de a dos, un vuelo con 1 asiento no sirve. MIN_SEATS=2 los filtra.
  const minSeats = Number(req.query?.minSeats ?? process.env.MIN_SEATS ?? 1);
  const results = [];

  for (const route of ROUTES) {
    const { res, payload, roto } = await consultar(route, date);

    if (!payload) {
      await telegram(`🔴 *AYCF Radar*: respuesta no-JSON de Caravelo (${res.status}).\n\`${roto}\``);
      return response.status(200).json({ ok: false, error: 'non-json', status: res.status });
    }
    if (sessionDead(res, payload)) {
      await telegram('🔴 *AYCF Radar*: sesión caída.\n\nRefrescá `AYCF_COOKIE` en Vercel.');
      return response.status(200).json({ ok: false, error: 'session-dead' });
    }
    results.push({ ...route, seats: seatsIn(payload).filter((f) => enoughSeats(f, minSeats)) });
  }

  const hits = results.filter((r) => r.seats.length > 0);

  if (shouldNotify(hits, process.env.NOTIFY_EMPTY === 'true')) {
    const texto = hits.length
      ? buildMessage(hits, date, ROUTES.length, minSeats)
      : `🛫 *AYCF* — sin cupo${minSeats > 1 ? ` de ≥${minSeats} asientos` : ''} en las ${ROUTES.length} rutas para el *${date}*.`;
    await telegram(texto, hits.length ? [[{ text: '🎟️ Canjear', url: CANJE }]] : []);
  }

  return response.status(200).json({
    ok: true,
    date,
    scanned: ROUTES.length,
    hits: hits.map((r) => ({ ruta: `${r.from}→${r.to}`, cupo: r.seats.length })),
  });
}
