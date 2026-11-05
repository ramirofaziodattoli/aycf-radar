// Pedido en lenguaje natural: el dueño escribe "el sábado bariloche a aeroparque
// y después a córdoba" y sale un pedido estructurado para comprar a las 00:00.
//
// Claude hace la parte difícil (fechas relativas, nombres de ciudad, dos tramos en
// una frase) con structured outputs, así que la respuesta ya viene con la forma
// del schema. Nada se compra sin que el dueño toque ✅ Confirmar: el modelo puede
// entender mal, y el eco del pedido es donde se ve.
//
// Si la API no está (sin key, caída, respuesta rara) queda el formato estricto
// `comprar 2026-11-08 BRC-AEP AEP-COR`, que se parsea acá sin red.

import { getCatalog, routeExists } from './airports.js';
import { newOrder, saveOrder, listOrders, formatPedido, fechaLarga, hoyEnAR } from './orders.js';

const API = 'https://api.anthropic.com/v1/messages';

// Memoria corta del intake: si el bot preguntó «¿Qué día querés viajar?», la
// respuesta «Sabado» sola no es un pedido. Se guarda el ida y vuelta pendiente y
// se le manda al modelo como turnos anteriores. Diez minutos y 6 entradas (tres
// preguntas) alcanzan; si no cerró en eso, mejor arrancar de cero.
export const CTX = 'intake:ctx';
const TTL_CTX = 600;
const MAX_CTX = 6;
// El store de los tests no tiene `del`: ahí alcanza con pisar en null.
const borrarCtx = (store) => (store.del ? store.del(CTX) : store.set(CTX, null));
const TIMEOUT_MS = 30_000;

const PREFERENCIAS = ['cualquier horario', 'lo más temprano posible', 'lo más tarde posible'];

// Structured outputs exige `additionalProperties: false` en cada objeto, todas las
// propiedades en `required` (lo opcional va como null) y no admite min/max.
export const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tipo', 'fechaVuelo', 'tramos', 'escalaMinimaHoras', 'preferencia', 'aclaracion'],
  properties: {
    tipo: { type: 'string', enum: ['pedido', 'busqueda', 'otro'] },
    fechaVuelo: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
    tramos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'ventana'],
        properties: {
          from: { type: 'string', description: 'IATA de 3 letras' },
          to: { type: 'string', description: 'IATA de 3 letras' },
          ventana: {
            anyOf: [
              { type: 'array', items: { type: 'string', description: 'HH:MM' }, description: '[desde, hasta]' },
              { type: 'null' },
            ],
          },
        },
      },
    },
    escalaMinimaHoras: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    preferencia: { type: 'string', enum: PREFERENCIAS },
    aclaracion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

const AYUDA_ESTRICTA = 'No pude interpretar el pedido. Probá el formato: `comprar 2026-11-08 BRC-AEP AEP-COR`';

/**
 * Lo que viene del modelo o de un Error va dentro de un mensaje con Markdown de
 * Telegram: un `_` o un `[` suelto hace que la API rechace el mensaje entero.
 */
const escapeMd = (s) => String(s).replace(/([_*[`])/g, '\\$1');

function reglas(hoy, aeropuertos) {
  const red = Object.entries(aeropuertos ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iata, nombre]) => `${iata} — ${nombre}`)
    .join('\n');
  return [
    'Convertís un pedido de pasaje de JetSMART escrito en castellano rioplatense en un objeto del schema.',
    `Hoy es ${fechaLarga(hoy).split(' ')[0]} ${hoy}, hora argentina (GMT-3).`,
    '',
    'Aeropuertos de la red (IATA — nombre):',
    red || '(sin catálogo: usá el IATA que corresponda a la ciudad)',
    '',
    'Reglas:',
    '- Las fechas relativas van siempre hacia adelante: "el sábado" es el próximo sábado después de hoy, "mañana" es hoy + 1. fechaVuelo en YYYY-MM-DD.',
    '- Los nombres de ciudad o aeropuerto se convierten al IATA de la lista ("bariloche" → BRC, "aeroparque" → AEP).',
    '- "No me importa el horario" o sin horario → ventana: null. Un rango ("a la mañana", "entre las 6 y las 12") → ventana ["HH:MM","HH:MM"].',
    '- Dos tramos el mismo día ("a aeroparque y después a córdoba") son tramos encadenados: el segundo sale de donde llega el primero.',
    '- Un mensaje que sólo nombra dos lugares, sin fecha ni intención de comprar, es tipo "busqueda".',
    '- Si hay mensajes anteriores, son parte del mismo pedido: completá con ellos lo que falte.',
    '- Si falta algo esencial (la fecha o el destino), tipo "pedido" con aclaracion = UNA sola pregunta corta; si no falta nada, aclaracion: null.',
    '- escalaMinimaHoras: null salvo que el mensaje la diga.',
    '- preferencia: "cualquier horario" salvo que pida lo más temprano o lo más tarde posible.',
    '- Algo que no es un pedido de pasaje ni una búsqueda → tipo "otro".',
  ].join('\n');
}

/**
 * Texto libre → objeto del schema, vía la API de Claude. `previos` son los turnos
 * de la charla pendiente (ver CTX), en el formato de `messages`. Tira `Error('no-entendi')`
 * si la respuesta no terminó bien o no es JSON. La key nunca sale en un log ni en
 * un mensaje de error: los errores llevan sólo el status.
 */
export async function parseOrderText(texto, { hoy = hoyEnAR(), aeropuertos = {}, previos = [], _fetch = fetch } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('sin ANTHROPIC_API_KEY');
  const res = await _fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-5-5',
      // Con Opus 5.5 el pensamiento cuenta dentro de max_tokens: 1024 cortaba la respuesta.
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ORDER_SCHEMA } },
      system: reglas(hoy, aeropuertos),
      messages: [...previos, { role: 'user', content: texto }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok === false) throw new Error(`claude ${res.status}`);
  const data = await res.json();
  if (data?.stop_reason !== 'end_turn') throw new Error('no-entendi');
  const json = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('no-entendi');
  }
}

/** `comprar YYYY-MM-DD BRC-AEP[ AEP-COR …]` → objeto del schema, o null si no es eso. */
export function parseOrderStrict(texto) {
  const m = String(texto).trim().match(/^comprar\s+(\d{4}-\d{2}-\d{2})((?:\s+[a-z]{3}-[a-z]{3})+)$/i);
  if (!m) return null;
  const tramos = m[2].trim().split(/\s+/).map((t) => {
    const [from, to] = t.toUpperCase().split('-');
    return { from, to, ventana: null };
  });
  return {
    tipo: 'pedido', fechaVuelo: m[1], tramos,
    escalaMinimaHoras: null, preferencia: 'cualquier horario', aclaracion: null,
  };
}

/**
 * Del texto al borrador con botones. Cualquier falla de la API cae al formato
 * estricto; si tampoco es eso, se le muestra el formato y no se guarda nada.
 *
 * Si el modelo pregunta algo, la pregunta y lo que la motivó quedan en CTX para
 * el próximo mensaje; cualquier respuesta que no sea otra pregunta cierra la
 * charla. Si la API se cae, la charla queda: el dueño puede reintentar.
 */
export async function cmdPedido(store, chatId, texto, { _fetch = fetch, hoy = hoyEnAR() } = {}) {
  const cat = await getCatalog(store);
  const previos = (await store.get(CTX))?.mensajes ?? [];
  let p;
  try {
    p = await parseOrderText(texto, { hoy, aeropuertos: cat?.aeropuertos ?? {}, previos, _fetch });
  } catch (err) {
    console.error(`intake: ${err.message}`);
    p = parseOrderStrict(texto);
  }
  if (p?.aclaracion && p.tipo === 'pedido') {
    const mensajes = [...previos, { role: 'user', content: texto }, { role: 'assistant', content: p.aclaracion }];
    // De a pares, así el primer turno que viaja siempre es del usuario.
    await store.set(CTX, { mensajes: mensajes.slice(-MAX_CTX) }, TTL_CTX);
    return { text: escapeMd(p.aclaracion) };
  }
  if (p && previos.length) await borrarCtx(store);
  if (!p || p.tipo === 'otro') return { text: AYUDA_ESTRICTA };
  if (p.tipo === 'busqueda') {
    return { text: 'Parece una búsqueda. Mandame `/buscar <origen> <destino>` o los dos nombres sueltos.' };
  }

  let order;
  try {
    order = newOrder({
      chatId,
      fechaVuelo: p.fechaVuelo,
      tramos: (p.tramos ?? []).map((t) => ({
        from: String(t.from ?? '').toUpperCase(), to: String(t.to ?? '').toUpperCase(), ventana: t.ventana ?? null,
      })),
      // null = "no lo dijo": que mande el default de newOrder, no un null que no valida.
      ...(p.escalaMinimaHoras != null ? { escalaMinimaHoras: p.escalaMinimaHoras } : {}),
      ...(PREFERENCIAS.includes(p.preferencia) ? { preferencia: p.preferencia } : {}),
    });
  } catch (err) {
    return { text: `⚠️ No pude armar el pedido: ${escapeMd(err.message)}.` };
  }

  // Mañana todavía se llega (las pasadas horarias de hoy compran el inventario
  // que salió a las 00:01); hoy o antes, no.
  if (order.fechaVuelo <= hoy) {
    return { text: `⚠️ El ${fechaLarga(order.fechaVuelo)} ya está en el pasado o es hoy: el canje cierra 2 h antes de la salida.` };
  }

  // Un tramo que no existe en la red nunca va a tener cupo: mejor decirlo ahora
  // que dejar un pedido confirmado que falla solo a las 00:00. Sin catálogo no se bloquea.
  const inexistente = cat && order.tramos.find((t) => !routeExists(t.from, t.to, cat.rutas));
  if (inexistente) {
    return { text: `⚠️ ${inexistente.from} → ${inexistente.to} no existe como vuelo directo en la red.` };
  }

  await saveOrder(store, order);
  return {
    text: `${formatPedido(order, { hoy })}\n\`${order.id}\` · /ensayo para probarlo sin pagar\n\n¿Lo confirmo?`,
    buttons: [[
      { text: '✅ Confirmar', data: `ord:ok:${order.id}` },
      { text: '❌ Cancelar', data: `ord:no:${order.id}` },
    ]],
  };
}

/** Los que todavía pueden pasar (o en duda), en el orden en que se crearon. `/ensayo N` usa este orden. */
export const pedidosVivos = (store) => listOrders(store, { estados: ['borrador', 'confirmado', 'dudoso'] });

/** Los pedidos vivos, cada uno con su id (para `/ensayo`) y su Cancelar. */
export async function cmdPedidos(store) {
  const vivos = await pedidosVivos(store);
  if (!vivos.length) return { text: 'No tenés pedidos vivos. Contame qué pasaje necesitás.' };
  const lineas = vivos.map((o, i) => `${i + 1}. \`${o.id}\` · ${formatPedido(o)} — _${o.estado}_`);
  return {
    text: `🧾 *${vivos.length} pedido(s)*\n\n${lineas.join('\n')}`,
    buttons: vivos.map((o, i) => [{ text: `❌ Cancelar ${i + 1}`, data: `ord:no:${o.id}` }]),
  };
}
