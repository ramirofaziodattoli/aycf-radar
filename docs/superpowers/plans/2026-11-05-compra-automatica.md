# Compra automática AYCF — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el bot compre solo el pasaje AYCF que Ramiro pidió en lenguaje natural, en un loop desde las 00:00 hasta las 00:15, y lo confirme por Telegram.

**Architecture:** Dos mitades desacopladas por un pedido estructurado en KV. La entrada (Telegram → Claude API → pedido confirmado con botón) corre horas antes. El camino caliente (`/api/buy`, cron 00:00) es código determinista: disponibilidad → elección → cotización → INIT Spreedly → tokenización → `do-purchase` → verificación, con lock por pedido y verificación antes de cualquier reintento de pago.

**Tech Stack:** Node ≥ 20 ESM, cero dependencias (la API de Claude se llama con `fetch`, como todo lo demás del repo), Vercel Pro (Fluid, `maxDuration` 800), Upstash Redis vía REST, Telegram Bot API. Tests: `test.mjs` con `node:assert/strict` (`npm test`).

**Spec:** `/Users/rfd/segundo-cerebro/lifestyle/proyectos/aycf-compra-automatica-diseno.md` (aprobado 2026-11-05). Relevamiento de la API: `/Users/rfd/segundo-cerebro/lifestyle/notas/2026-11-05-aycf-relevamiento-flujo-de-canje.md`.

## Global Constraints

- Sólo el chat `TELEGRAM_CHAT_ID` puede crear, ver o confirmar pedidos. Para cualquier otro chat la función no existe (ni mensaje de "no habilitada" en los menús: sólo si la invoca a mano).
- `AUTO_BUY` distinto de `on` apaga toda la compra: ni intake, ni `/api/buy`, ni botones.
- La tarjeta llega SOLO por la env var `AYCF_CARD` (JSON `{"number","month","year","cvv","holder"}`). Ningún módulo la loguea, la persiste ni la manda a Telegram. Ningún `console.log` imprime bodies de requests de pago.
- Todo request a Caravelo/Spreedly lleva `signal: AbortSignal.timeout(30_000)`.
- Nunca se repite `do-purchase` sin consultar `bookings` antes. Si `bookings` falla, el pedido queda `dudoso` y se avisa.
- Hora: Argentina es UTC-3 fijo. Fecha de vuelo `YYYY-MM-DD`; la compra de un pedido corre la noche en que `fechaVuelo === tomorrowInAR()`.
- Estados del pedido: `borrador` · `confirmado` · `comprado` · `parcial` · `dudoso` · `fallido` · `cancelado`. Las pasadas de rescate sólo tocan `confirmado`.
- Mensajes del bot en el tono de `commands.js`/`notify.js` (voseo, Markdown de Telegram, sin jerga técnica).
- Modelo para interpretar el pedido: `claude-opus-5-5`, `output_config: { effort: "low", format: { type: "json_schema", schema } }`, `max_tokens: 1024`, header `anthropic-version: 2026-10-21`.
- Cron de Vercel en UTC: 00:00 ART = `0 3 * * *`.

## Review Focus

1. Tramo con cupo pero cotización por encima de `topeTasasPorTramoARS` (ruta internacional, 133.324): no se compra y el aviso dice el monto. → test en Task 4.
2. Timeout en `do-purchase` seguido de `bookings` que SÍ muestra la reserva: el pedido pasa a `comprado`, sin segundo pago. → test en Task 4.
3. Dos invocaciones de `/api/buy` solapadas (la de las 00:00 viva y la de rescate de las 00:08): la segunda no toca el pedido. → test en Task 1 (lock) y Task 5.
4. Pedido con escala que cruza AEP↔EZE: margen de 4 h, no 2,5. → test en Task 2.
5. Texto libre del admin que es una búsqueda ("bariloche salta") y no un pedido: sigue yendo a `/buscar`, no crea pedido. → test en Task 6.

---

### Task 1: Pedidos en el store y lock atómico

**Files:**
- Modify: `src/store.js` (los tres backends)
- Create: `src/orders.js`
- Test: `test.mjs` (bloque `// --- pedidos: modelo, store y lock ---`)

**Interfaces:**
- Consumes: `scoped(store, chatId)` de `src/users.js`; `tomorrowInAR()` de `src/radar.js`.
- Produces:
  - `store.setnx(key, value, ttlSeconds) → Promise<boolean>` en `RedisStore` (`SET key val EX ttl NX`, true si devolvió `OK`), `FileStore` y `MemoryStore` (true si no había fila viva).
  - `validateOrder(o) → o` (tira `Error` con mensaje en español si falla).
  - `newOrder({ chatId, fechaVuelo, tramos, escalaMinimaHoras?, preferencia?, topeTasasPorTramoARS? }) → order` con `id: 'ord_' + 10 hex`, `estado: 'borrador'`, `creado` ISO, `intentos: []`, `resultado: null`, defaults `escalaMinimaHoras: 2.5`, `preferencia: 'cualquier horario'`, `topeTasasPorTramoARS: 40000`.
  - `saveOrder(store, order)`, `getOrder(store, id)`, `listOrders(store, { estados? })` (índice `orders` = array de ids; TTL de cada `order:{id}` 30 días).
  - `setEstado(store, id, estado, extra = {})` (merge; `extra.intento` se agrega a `intentos`).
  - `ordersDueTonight(store, date = tomorrowInAR()) → order[]` (estado `confirmado` y `fechaVuelo === date`).
  - `lockOrder(store, id, ttlSeconds = 900) → Promise<boolean>` sobre `order-lock:{id}`; `unlockOrder(store, id)`.

- [ ] **Step 1: Write the failing tests**

```js
// --- pedidos: modelo, store y lock ---
{
  const { newOrder, validateOrder, saveOrder, getOrder, listOrders, setEstado, ordersDueTonight, lockOrder, unlockOrder } = await import('./src/orders.js');
  const { createStore } = await import('./src/store.js');
  const { scoped } = await import('./src/users.js');
  process.env.STATE_FILE = '/tmp/aycf-test-orders.json'; await rm(process.env.STATE_FILE, { force: true });
  const store = scoped(createStore(), '1');

  assert.throws(() => validateOrder({ fechaVuelo: '08/11/2026', tramos: [{ from: 'BRC', to: 'AEP' }] }), /YYYY-MM-DD/);
  assert.throws(() => validateOrder({ fechaVuelo: '2026-11-08', tramos: [] }), /tramo/);
  assert.throws(() => validateOrder({ fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'EZE', to: 'COR' }] }), /encaden/,
    'el segundo tramo tiene que salir de donde llegó el primero (AEP≠EZE se declara, no se adivina)');
  const o = newOrder({ chatId: '1', fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'AEP', to: 'COR' }] });
  assert.match(o.id, /^ord_[0-9a-f]{10}$/); assert.equal(o.estado, 'borrador');
  assert.equal(o.escalaMinimaHoras, 2.5); assert.equal(o.topeTasasPorTramoARS, 40000);

  await saveOrder(store, o);
  assert.equal((await getOrder(store, o.id)).fechaVuelo, '2026-11-08');
  assert.equal((await ordersDueTonight(store, '2026-11-08')).length, 0, 'un borrador no se compra');
  await setEstado(store, o.id, 'confirmado');
  assert.equal((await ordersDueTonight(store, '2026-11-08')).length, 1);
  assert.equal((await ordersDueTonight(store, '2026-11-09')).length, 0);
  await setEstado(store, o.id, 'fallido', { intento: { hora: 'x', paso: 'quotation', error: 'boom' } });
  assert.equal((await getOrder(store, o.id)).intentos.length, 1);
  assert.equal((await listOrders(store, { estados: ['fallido'] })).length, 1);

  assert.equal(await lockOrder(store, o.id, 60), true);
  assert.equal(await lockOrder(store, o.id, 60), false, 'el segundo cron no entra');
  await unlockOrder(store, o.id);
  assert.equal(await lockOrder(store, o.id, 60), true);
}
```

Un caso aparte para `RedisStore.setnx`: con `globalThis.fetch` falso que devuelva `{result:'OK'}` y luego `{result:null}`, comprobar que el body enviado es `["SET",key,json,"EX","60","NX"]` y que devuelve `true` / `false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (módulo `./src/orders.js` inexistente).

- [ ] **Step 3: Implement `setnx` in `src/store.js` and `src/orders.js`**

`scoped()` en `users.js` tiene que exponer `setnx` también (una línea: `setnx: (key, value, ttl) => store.setnx(k(key), value, ttl)`). Encadenamiento: `tramos[i].from === tramos[i-1].to`, IATA de 3 letras mayúsculas, `escalaMinimaHoras` número > 0, `ventana` nula o `[HH:MM, HH:MM]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: `✅ todo ok`.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/users.js src/orders.js test.mjs
git commit -m "pedidos: modelo en el store y lock atómico por pedido"
```

---

### Task 2: Elegir el itinerario (puro)

**Files:**
- Create: `src/itinerary.js`
- Test: `test.mjs` (bloque `// --- itinerario: ventana, escala, escasez y tope ---`)

**Interfaces:**
- Consumes: vuelos normalizados de `normalize()` en `src/jetsmart.js` (`departsAt`/`arrivesAt` `YYYY-MM-DD HH:MM:SS`, `departsHHMM`, `seats`, `taxes`, `from`, `to`, `key`, `fareSellKey`).
- Produces:
  - `escalaMinima(order, i) → number` — `order.escalaMinimaHoras`, salvo que `tramos[i-1].to` y `tramos[i].from` sean uno AEP y otro EZE: entonces `max(order.escalaMinimaHoras, 4)`. (Por validación de Task 1 son iguales; esta regla queda por si se relaja el encadenamiento con un campo `traslado` futuro — YAGNI: implementar sólo el `max` con 4 cuando `{to, from}` es `{AEP, EZE}`.)
  - `enVentana(flight, ventana) → boolean` (ventana nula = siempre).
  - `chooseItinerary(order, flightsPorTramo: Array<flight[]>) → { tramos: flight[] } | { tramos: flight[], faltan: number[] }` — devuelve la combinación completa si existe; si no, la mejor parcial (los primeros tramos que sí encajan, `faltan` = índices sin vuelo). Reglas: `seats >= 1`, en ventana, llegada de i-1 + escala ≤ salida de i. Con `preferencia === 'cualquier horario'` gana la combinación con más margen total; con `'lo más temprano posible'` la de salida más temprana del primer tramo.
  - `ordenDeCompra(itinerario) → number[]` — índices ordenados por `seats` ascendente (empate: orden de viaje).
  - `superaTope(flight, order) → boolean` — `flight.taxes > order.topeTasasPorTramoARS`.

- [ ] **Step 1: Write the failing tests**

```js
// --- itinerario: ventana, escala, escasez y tope ---
{
  const { chooseItinerary, ordenDeCompra, superaTope, enVentana, escalaMinima } = await import('./src/itinerary.js');
  const v = (code, from, to, dep, arr, seats, taxes = 15103.85) => ({ code, from, to, departsAt: `2026-11-08 ${dep}:00`, arrivesAt: `2026-11-08 ${arr}:00`, departsHHMM: dep, seats, taxes });
  const order = { fechaVuelo: '2026-11-08', tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'AEP', to: 'COR' }], escalaMinimaHoras: 2.5, preferencia: 'cualquier horario', topeTasasPorTramoARS: 40000 };

  const brc = [v('JA3100', 'BRC', 'AEP', '06:00', '08:10', 2), v('JA3106', 'BRC', 'AEP', '19:40', '21:50', 6)];
  const cor = [v('JA3020', 'AEP', 'COR', '09:30', '10:50', 1), v('JA3024', 'AEP', 'COR', '15:00', '16:20', 3)];
  const it = chooseItinerary(order, [brc, cor]);
  assert.deepEqual(it.tramos.map((f) => f.code), ['JA3100', 'JA3024'], '06:00+2:10+2,5h > 09:30 → descarta el de las 09:30; el de las 19:40 no deja nada');
  assert.equal(it.faltan, undefined);
  assert.deepEqual(ordenDeCompra(it), [0, 1].sort((a, b) => it.tramos[a].seats - it.tramos[b].seats), 'primero el escaso');

  const soloIda = chooseItinerary(order, [brc, []]);
  assert.deepEqual(soloIda.tramos.map((f) => f.code), ['JA3106'], 'sin segundo tramo, el primero es libre: cualquier horario → el que sale más tarde');
  assert.deepEqual(soloIda.faltan, [1]);

  assert.equal(chooseItinerary(order, [[], cor]).tramos.length, 0, 'sin el primero no hay parcial: el segundo solo no sirve');
  assert.equal(enVentana(v('x', 'A', 'B', '08:00', '09:00', 1), ['06:00', '12:00']), true);
  assert.equal(enVentana(v('x', 'A', 'B', '13:00', '14:00', 1), ['06:00', '12:00']), false);
  assert.equal(escalaMinima({ ...order, tramos: [{ from: 'BRC', to: 'AEP' }, { from: 'EZE', to: 'COR' }] }, 1), 4, 'AEP→EZE son dos aeropuertos');
  assert.equal(superaTope(v('x', 'A', 'B', '08:00', '09:00', 1, 133324), order), true);
  assert.equal(superaTope(v('x', 'A', 'B', '08:00', '09:00', 1, 15103.85), order), false);
}
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test`, FAIL por módulo inexistente.
- [ ] **Step 3: Implement `src/itinerary.js`** — sin estado, sin I/O. Enumerar combinaciones por producto cartesiano filtrado tramo a tramo (≤ 10 vuelos por tramo: no hace falta podar).
- [ ] **Step 4: Run tests** — `npm test` → `✅ todo ok`.
- [ ] **Step 5: Commit** — `git add src/itinerary.js test.mjs && git commit -m "itinerario: elección pura con ventana, escala, escasez y tope de tasas"`

---

### Task 3: Cliente de cotización, pago y verificación (Caravelo + Spreedly)

**Files:**
- Create: `src/purchase.js`
- Modify: `src/jetsmart.js` (exportar `BASE`)
- Test: `test.mjs` (bloque `// --- compra: requests a Caravelo y Spreedly con la forma relevada ---`)

**Interfaces:**
- Consumes: `session.header()`, `session.passId`, `session.absorb(res)` de `src/session.js`; `SessionExpiredError`; `UA` de `src/login.js`.
- Produces (todas reciben `{ _fetch = fetch }` como último parámetro para test):
  - `quote(session, flight) → { total: number, breakdown: [{description, amount, code}] }` — `POST {BASE}/json/{passId}/quotation`, headers `content-type: application/json`, `accept: application/json`, cookie; body con `outboundKey` y `referenceOutbound` = `flight.key`, `outboundFareSellKey` = `flight.fareSellKey`, `origin`, `destination`, `departure` = `flight.departsAt`, y `outboundFareBasisCode`, `inboundKey`, `inboundFareBasisCode`, `inboundOrigin`, `inboundDestination`, `arrival`, `referenceInbound`, `inboundFareSellKey` en `null`. `total` = `parseAmount(total.text)` o `total.qty`.
  - `initPayment(session) → { certificateToken, signature, nonce, timestamp }` — `POST {BASE}/json/payments/orchestrator/resource` body `{"type":"INIT","paymentGateway":"spreedly"}`; lee `additionalData`.
  - `tokenizeCard(card, init) → string` (token) — `POST https://core.spreedly.com/v1/payment_methods.json` con body `{ payment_method: { credit_card: { full_name, number, month, year, verification_value } }, certificate_token, nonce, timestamp, signature }`. **Forma provisoria**: se ajusta en la compra de calibración (Task 8). Devuelve `transaction.payment_method.token`.
  - `doPurchase(session, { token, card, quotation }) → { ok: true, raw } | { ok: false, motivo, raw }` — `POST {BASE}/{passId}/do-purchase` como `application/x-www-form-urlencoded` con `payment-method-token`, `month`, `year`, `full_name`, `payment_method_reference` (vacío), `txvariant=card`. **Forma provisoria** (ídem). `motivo` ∈ `'rechazada' | 'sin-cupo' | '3ds' | 'desconocido'` según texto/redirect de la respuesta.
  - `listBookings(session) → [{ pnr, flightCode, date, from, to }]` — `GET {BASE}/profile/{passId}/bookings` probando `accept: application/json` y, si da 500 o no-JSON, `accept: text/html` parseando PNRs (`/[A-Z0-9]{6}/` dentro de la sección de reservas). Devuelve `[]` si no hay; tira `Error('bookings-unavailable')` si ninguna variante responde.
  - `hayReserva(bookings, flight) → boolean` — mismo `flightCode` y fecha.
  - Errores de sesión (401/403/`redirectUri`) → `SessionExpiredError`, igual que `search()`.
  - Ningún `console.log` de bodies. Los errores se loguean sólo con `status` y los primeros 120 chars de la respuesta sin el body enviado.

- [ ] **Step 1: Write the failing tests** — con un `fetch` falso que registra `{url, method, headers, body}`:

```js
// --- compra: requests a Caravelo y Spreedly con la forma relevada ---
{
  const { quote, initPayment, tokenizeCard, doPurchase, listBookings, hayReserva } = await import('./src/purchase.js');
  const session = { passId: 'PASS', header: () => 'laravel_session=S', absorb: async () => false };
  const calls = []; const json = (b, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json', getSetCookie: () => [] }, text: async () => JSON.stringify(b) });
  const f = (resp) => async (url, opt = {}) => { calls.push({ url: String(url), method: opt.method ?? 'GET', headers: opt.headers, body: opt.body }); return resp; };
  const flight = { key: 'K', fareSellKey: 'FK', from: 'SLA', to: 'EZE', departsAt: '2026-11-06 22:04:00', code: 'JA3021' };

  const q = await quote(session, flight, { _fetch: f(json({ pricingBreakdown: [{ description: 'Tasa', amount: '6,500.00', code: 'TQ' }], total: { qty: 15103.85, text: 'ARS 15103.85' } })) });
  assert.equal(q.total, 15103.85);
  assert.match(calls.at(-1).url, /\/json\/PASS\/quotation$/);
  const body = JSON.parse(calls.at(-1).body);
  assert.equal(body.outboundKey, 'K'); assert.equal(body.referenceOutbound, 'K'); assert.equal(body.outboundFareSellKey, 'FK'); assert.equal(body.departure, '2026-11-06 22:04:00'); assert.equal(body.inboundKey, null);

  const init = await initPayment(session, { _fetch: f(json({ paymentGateway: 'spreedly', additionalData: { certificateToken: 'C', signature: 'S', nonce: 'N', timestamp: '1' } })) });
  assert.deepEqual(init, { certificateToken: 'C', signature: 'S', nonce: 'N', timestamp: '1' });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { type: 'INIT', paymentGateway: 'spreedly' });

  const card = { number: '4111111111111111', month: '12', year: '2030', cvv: '123', holder: 'RAMIRO FAZIO' };
  const tok = await tokenizeCard(card, init, { _fetch: f(json({ transaction: { payment_method: { token: 'TOK' } } })) });
  assert.equal(tok, 'TOK');
  assert.match(calls.at(-1).url, /core\.spreedly\.com\/v1\/payment_methods\.json$/);
  const sp = JSON.parse(calls.at(-1).body);
  assert.equal(sp.payment_method.credit_card.number, card.number); assert.equal(sp.certificate_token, 'C'); assert.equal(sp.signature, 'S');
  assert.ok(!calls.at(-1).headers.cookie, 'a Spreedly no va la cookie de Caravelo');

  const ok = await doPurchase(session, { token: 'TOK', card, quotation: q }, { _fetch: f({ ok: true, status: 200, headers: { get: () => 'text/html', getSetCookie: () => [] }, text: async () => '<h1>Compra confirmada</h1> PNR ABC123' }) });
  assert.equal(ok.ok, true);
  assert.match(calls.at(-1).url, /\/PASS\/do-purchase$/);
  assert.match(calls.at(-1).body, /payment-method-token=TOK/); assert.match(calls.at(-1).body, /txvariant=card/);
  assert.ok(!calls.at(-1).body.includes(card.number), 'el número de tarjeta nunca va a Caravelo');

  const rechazo = await doPurchase(session, { token: 'TOK', card, quotation: q }, { _fetch: f(json({ content: { exceptionMessage: 'payment.declined' } }, 402)) });
  assert.equal(rechazo.ok, false); assert.equal(rechazo.motivo, 'rechazada');

  await assert.rejects(() => quote(session, flight, { _fetch: f(json({ redirectUri: '/login' })) }), /sesión/);

  const bk = await listBookings(session, { _fetch: f(json({ content: { content: [{ pnr: 'ABC123', flightCode: 'JA3021', date: '2026-11-06', from: 'SLA', to: 'EZE' }] } })) });
  assert.equal(bk[0].pnr, 'ABC123');
  assert.equal(hayReserva(bk, { code: 'JA3021', departsAt: '2026-11-06 22:04:00' }), true);
  assert.equal(hayReserva(bk, { code: 'JA3100', departsAt: '2026-11-06 06:00:00' }), false);
}
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test`.
- [ ] **Step 3: Implement `src/purchase.js`** — un helper interno `pedir(session, url, init, { _fetch })` que pone UA, cookie, timeout, mapea 401/403/`redirectUri`/`TOKEN_MISMATCH` a `SessionExpiredError` y llama `session.absorb` sólo en 2xx (copiar el criterio de `search()`). Marcar con `// CALIBRAR:` las dos formas provisorias.
- [ ] **Step 4: Run tests** — `✅ todo ok`.
- [ ] **Step 5: Commit** — `git add src/purchase.js src/jetsmart.js test.mjs && git commit -m "compra: cotización, INIT de Spreedly, tokenización, do-purchase y reservas"`

---

### Task 4: El loop de compra y la máquina de estados

**Files:**
- Create: `src/buy.js`
- Test: `test.mjs` (bloque `// --- buy: loop 00:00–00:15, parcial, dudoso, tope ---`)

**Interfaces:**
- Consumes: Task 1 (`setEstado`, `lockOrder`, `unlockOrder`), Task 2 (`chooseItinerary`, `ordenDeCompra`, `superaTope`), Task 3 (todas), `search()` de `src/jetsmart.js`, `reply()` de `src/notify.js`.
- Produces:
  - `runBuy({ order, store, session, chatId, card, deadline, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), api = { search, quote, initPayment, tokenizeCard, doPurchase, listBookings }, notify = reply }) → { estado, resultado, intentos }`.
  - `deadlineAR(hhmm = '00:15', now = new Date()) → number` (epoch ms de hoy a esa hora ART; si ya pasó, el mismo instante).
  - `formatCompra(order, resultado) → string` y `formatFallo(order, intentos) → string` (mensajes Markdown).
  - Estados de salida: `comprado` (todos los tramos), `parcial` (al menos uno comprado, `faltan` no vacío), `dudoso`, `fallido` (motivo `rechazada` | `3ds` | `tope` | `sin-cupo` tras deadline), `confirmado` sin cambio sólo si no se pudo tomar el lock.
  - Algoritmo del loop (la única parte que las firmas no determinan):
    1. `lockOrder` o salir. Hasta `deadline`: por cada tramo pendiente `api.search(session, tramo, date)`; si todos vacíos → `sleep(10_000)` y seguir; si algún `search` tiró error/timeout → `sleep(20_000)` (Ramiro: «no exageres, nos van a bloquear»: un request por tramo cada 10–20 s, nunca ráfagas). 401 → `session.relogin()` una vez por vuelta.
    2. `chooseItinerary`; si `tramos.length === 0` → sleep y seguir.
    3. Por cada índice de `ordenDeCompra`: `quote` (si `superaTope` → `fallido` motivo `tope`, salir del loop); `initPayment`; `tokenizeCard`; `doPurchase`. Cada paso con un reintento inmediato en error/timeout, **salvo `doPurchase`**: ante error/timeout → `listBookings`; `hayReserva` → tomar como comprado; `[]` → un reintento de `doPurchase`; `bookings-unavailable` → `dudoso`, salir.
    4. `doPurchase` `ok:false` con `sin-cupo` → volver al paso 1 (otro vuelo); `rechazada`/`3ds` → `fallido` con ese motivo, salir.
    5. Si compró todos → `comprado`; si compró alguno y `faltan` → `parcial` (no se persigue el faltante). Registrar `resultado: { tramos: [{ code, from, to, departsAt, pnr, tasas }] }`.
    6. Al salir, siempre `unlockOrder` y `notify` con `formatCompra`/`formatFallo`. Cada paso fallido agrega `{ hora, paso, error }` a `intentos`.

- [ ] **Step 1: Write the failing tests** — con `api` falso programable por llamada, `now` que avanza con cada `sleep` y `notify` que acumula:

```js
// --- buy: loop 00:00–00:15, parcial, dudoso, tope ---
{
  const { runBuy, deadlineAR } = await import('./src/buy.js');
  // (helpers: order de 2 tramos como en Task 2, store scoped a /tmp, session falsa con relogin contado, card falsa)
  // 1) Caravelo muerto 3 vueltas (search tira timeout), después aparece cupo: compra los dos, estado 'comprado', notify 1 vez con los dos PNR, sleep llamado 3 veces con 20000 (error) y nunca menos de 10000 entre vueltas.
  // 2) Sólo el primer tramo tiene cupo todo el tiempo: compra el primero, estado 'parcial', faltan [1], el mensaje dice que el tramo AEP→COR se ve con Ramiro.
  // 3) do-purchase tira timeout y listBookings devuelve la reserva: estado 'comprado', doPurchase llamado UNA vez.
  // 4) do-purchase tira timeout y listBookings tira 'bookings-unavailable': estado 'dudoso', doPurchase UNA vez, mensaje pide mirar el mail.
  // 5) quote devuelve 133324 con tope 40000: estado 'fallido' motivo 'tope', ni initPayment ni doPurchase llamados.
  // 6) Nunca hay cupo y now pasa el deadline: estado 'fallido' motivo 'sin-cupo', intentos.length > 0, un solo mensaje.
  // 7) lockOrder ya tomado: runBuy devuelve { estado: 'confirmado' } sin llamar a search.
  assert.equal(deadlineAR('00:15', new Date('2026-11-08T03:00:00Z')), Date.parse('2026-11-08T03:15:00Z'));
}
```

Escribir los 7 casos como asserts concretos (uno por bloque `{}`), no como comentarios.

- [ ] **Step 2: Run tests to verify they fail** — `npm test`.
- [ ] **Step 3: Implement `src/buy.js`** — el loop de arriba; `card` llega por parámetro (quien lo llama lee `AYCF_CARD`), el módulo nunca lee env.
- [ ] **Step 4: Run tests** — `✅ todo ok`.
- [ ] **Step 5: Commit** — `git add src/buy.js test.mjs && git commit -m "buy: loop hasta las 00:15 con parcial, dudoso y verificación antes de repagar"`

---

### Task 5: Endpoint `/api/buy`, crons y convivencia con el radar

**Files:**
- Create: `api/buy.js`
- Modify: `vercel.json`, `src/radar.js` (`runAllRadars`), `api/reminder.js`, `README.md`
- Test: `test.mjs` (bloque `// --- /api/buy: sólo el dueño, sólo con AUTO_BUY, y el radar del dueño se saltea ---`)

**Interfaces:**
- Consumes: Task 1 (`ordersDueTonight`, `getOrder`), Task 4 (`runBuy`, `deadlineAR`), `envUser()`/`esDueno`/`scoped` de `src/users.js`, `withSession` de `src/session.js`.
- Produces:
  - `api/buy.js` handler: 401 sin `CRON_SECRET`; 200 `{ ok: true, skipped: 'auto-buy-off' }` si `AUTO_BUY !== 'on'`; lee `AYCF_CARD` (JSON) y si falta → avisa al dueño y 200 `{ skipped: 'sin-tarjeta' }`; por cada pedido de `ordersDueTonight` del store del dueño, `withSession(store, s => runBuy({...}), envUser())` con `deadline = deadlineAR('00:15')`; acepta `?order=<id>` para forzar uno (rescates y pruebas). Responde `{ ok, orders: [{ id, estado }] }`.
  - `vercel.json`: `"api/buy.js": { "maxDuration": 800 }`; crons `0 3`, `8 3`, `16 3`, `30 3` y `0 4-23 * * *` → `/api/buy`. Los existentes quedan.
  - `runAllRadars`: antes del barrido del dueño, `skipOwnerTonight = AUTO_BUY === 'on' && (await ordersDueTonight(scoped(base, dueño))).length > 0`; en ese caso `out.push({ chatId, skipped: 'compra-en-curso' })` y no corre `runRadar` para él.
  - `api/reminder.js`: después del precalentado, si el dueño tiene pedidos para esta noche, un mensaje por pedido con `formatPedido(order)` (Task 6) y botón `[{ text: '❌ Cancelar', data: 'ord:no:<id>' }]`.
  - README: sección «Compra automática (opcional, sólo el dueño)» con las env vars `AUTO_BUY`, `AYCF_CARD`, `ANTHROPIC_API_KEY`, la advertencia de T&C y el kill switch.

- [ ] **Step 1: Write the failing tests** — importando `./api/buy.js` como hace el test del precalentado: (a) sin `CRON_SECRET` correcto → 401; (b) `AUTO_BUY=off` → `skipped: 'auto-buy-off'` sin tocar el store; (c) `AUTO_BUY=on`, sin `AYCF_CARD` → aviso al dueño y `skipped: 'sin-tarjeta'`; (d) `runAllRadars` con un pedido confirmado para mañana del dueño y un segundo usuario: el dueño sale `skipped: 'compra-en-curso'` y el otro corre (`_search` contado).
- [ ] **Step 2: Run tests to verify they fail** — `npm test`.
- [ ] **Step 3: Implement** — `api/buy.js`, `vercel.json`, el salto en `runAllRadars` (inyectar `_dueTonight` para test), el recordatorio en `api/reminder.js`, README.
- [ ] **Step 4: Run tests** — `✅ todo ok`.
- [ ] **Step 5: Commit** — `git add api/buy.js vercel.json src/radar.js api/reminder.js README.md test.mjs && git commit -m "/api/buy: cron 00:00 con rescates, el radar del dueño se saltea en noche de compra"`

---

### Task 6: Pedido en lenguaje natural (Claude API) y botones

**Files:**
- Create: `src/intake.js`
- Modify: `src/commands.js` (`comandoDe`, `dispatch`, `handleCallback`, `AYUDA_ADMIN`), `api/telegram.js` (sin cambios de ruteo si `comandoDe` resuelve; verificar)
- Test: `test.mjs` (bloque `// --- intake: del texto al pedido, con confirmación ---`)

**Interfaces:**
- Consumes: Task 1, `getCatalog`/`resolveAirport` de `src/airports.js`, `esDueno`.
- Produces:
  - `ORDER_SCHEMA` (JSON Schema, `additionalProperties: false` en todos los objetos): `{ tipo: 'pedido'|'busqueda'|'otro', fechaVuelo: string(date)|null, tramos: [{ from, to, ventana: [string,string]|null }], escalaMinimaHoras: number|null, preferencia: 'cualquier horario'|'lo más temprano posible'|'lo más tarde posible', aclaracion: string|null }`.
  - `parseOrderText(texto, { hoy, aeropuertos, _fetch = fetch }) → objeto del schema` — `POST https://api.anthropic.com/v1/messages` con headers `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2026-10-21`, `content-type: application/json`; body `{ model: 'claude-opus-5-5', max_tokens: 1024, output_config: { effort: 'low', format: { type: 'json_schema', schema: ORDER_SCHEMA } }, system: <reglas>, messages: [{ role: 'user', content: texto }] }`. `system` incluye: hoy (`YYYY-MM-DD`, día de la semana, GMT-3), la lista `IATA — nombre` de la red, "el sábado" = próximo sábado, "mañana" = hoy+1, nombres de ciudad → IATA, "no me interesa el horario" → `ventana: null`, dos tramos el mismo día → `tramos` encadenados, y que un mensaje que sólo nombra dos lugares sin fecha es `tipo: 'busqueda'`. Parsear `content[0].text` como JSON; si `stop_reason !== 'end_turn'` o no parsea → `Error('no-entendi')`.
  - `parseOrderStrict(texto) → objeto | null` — formato `comprar YYYY-MM-DD BRC-AEP[ AEP-COR]`.
  - `formatPedido(order) → string` — «📌 *Pedido* · sábado 08/11 · BRC → AEP (cualquier horario) · AEP → COR, escala ≥ 2,5 h · lo busco el viernes 07/11 a las 00:00».
  - `cmdPedido(store, chatId, texto)` → `{ text, buttons: [[{ text: '✅ Confirmar', data: 'ord:ok:<id>' }, { text: '❌ Cancelar', data: 'ord:no:<id>' }]] }` guardando el `borrador`; si `aclaracion` → sólo el texto de la pregunta.
  - `cmdPedidos(store)` → lista de pedidos no terminales con botón Cancelar cada uno.
  - Callbacks `ord:ok:<id>` → `setEstado(..., 'confirmado')` + «Listo, lo compro el …»; `ord:no:<id>` → `cancelado`.
  - `comandoDe(text, user, { chatId })`: si `esDueno(chatId)` y `AUTO_BUY === 'on'` y el texto no empieza con `/`, no es `mail contraseña`, y **no** son exactamente dos tokens resolubles como aeropuertos → `{ cmd: '/pedido', args: [texto] }`. Dos tokens → `/buscar` como hoy. (`/pedido` no necesita sesión: va en `dispatch` sin `withSession`.)
  - `AYUDA_ADMIN` suma `/pedidos` y la frase «o contame qué pasaje necesitás y lo compro solo».

- [ ] **Step 1: Write the failing tests** — con `_fetch` falso que devuelve `{ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({...}) }] }`: (a) el body enviado tiene `model: 'claude-opus-5-5'`, `output_config.format.type === 'json_schema'` y el `system` contiene la fecha de hoy y `BRC`; (b) «el sábado bariloche a aeroparque y después a córdoba, no me importa el horario» → `cmdPedido` guarda un borrador con `fechaVuelo` del próximo sábado respecto de `hoy` y 2 tramos, y devuelve botones `ord:ok:`/`ord:no:`; (c) callback `ord:ok:<id>` deja `confirmado`; (d) `comandoDe('bariloche salta', userDueño, { chatId: '1' })` → `/buscar` (Review Focus 5); (e) `comandoDe('el lunes necesito ir a aeroparque', userDueño, { chatId: '1' })` → `/pedido`, y con `chatId: '2'` → `/buscar`; (f) `parseOrderStrict('comprar 2026-11-08 BRC-AEP AEP-COR')` → 2 tramos; (g) `_fetch` que tira → `cmdPedido` responde con el formato estricto como ayuda, sin crear pedido.
- [ ] **Step 2: Run tests to verify they fail** — `npm test`.
- [ ] **Step 3: Implement `src/intake.js` y los cambios en `src/commands.js`** — `handleCommand` ya pasa `chatId`; agregar el tercer parámetro a `comandoDe` y actualizar su llamada en `api/telegram.js`.
- [ ] **Step 4: Run tests** — `✅ todo ok`.
- [ ] **Step 5: Commit** — `git add src/intake.js src/commands.js api/telegram.js test.mjs && git commit -m "pedido en lenguaje natural: Claude API, confirmación con botones y /pedidos"`

---

### Task 7: `/ensayo` — todo el flujo menos pagar

**Files:**
- Modify: `src/commands.js`, `src/buy.js` (opción `dryRun`)
- Test: `test.mjs` (bloque `// --- /ensayo: llega hasta INIT y no paga ---`)

**Interfaces:**
- `runBuy({ ..., dryRun: true })`: ejecuta search → chooseItinerary → quote → initPayment y devuelve `{ estado: 'ensayo', itinerario, cotizaciones, init: { ok: true } }` sin llamar `tokenizeCard` ni `doPurchase` ni cambiar el estado del pedido.
- `/ensayo <id>` (sólo dueño, `NECESITA_SESION`): corre `runBuy` con `dryRun` para ese pedido con `deadline = now + 60 s` y contesta el itinerario elegido, las tasas cotizadas y «INIT de Spreedly OK» o el error en el paso que falló.

- [ ] **Step 1: Write the failing test** — `runBuy({ dryRun: true, ... })` con `api` falso: `tokenizeCard` y `doPurchase` no llamados, estado del pedido en el store sigue `confirmado`, resultado `estado: 'ensayo'`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — `✅ todo ok`.
- [ ] **Step 5: Commit** — `git commit -am "/ensayo: el flujo completo hasta INIT sin pagar"` (rutas explícitas: `src/commands.js src/buy.js test.mjs`).

---

### Task 8: Compra de calibración (manual, con Ramiro)

No es código: fija las dos formas marcadas `// CALIBRAR:` en `src/purchase.js`.

- [ ] **Step 1:** Antes, un `/ensayo` real contra un pedido con cupo (ver qué devuelve `bookings` de verdad y corregir `listBookings`).
- [ ] **Step 2:** En la próxima compra real de Ramiro, Claude abre el portal en Chrome con el logger de `fetch`/XHR y del `submit` del `#payment-form`; Ramiro tipea la tarjeta en el iframe de Spreedly y confirma. Capturar: request de tokenización del iframe (URL, campos, respuesta), body y respuesta de `do-purchase`, redirect/3DS si hay, y la respuesta de `bookings` con la reserva nueva.
- [ ] **Step 3:** Ajustar `tokenizeCard`, `doPurchase`, `hayReserva` y sus tests a lo capturado. Commit `"compra: formas de tokenización y do-purchase calibradas con una compra real"`.
- [ ] **Step 4:** Deploy a producción, `AUTO_BUY=on`, `AYCF_CARD` cargada por Ramiro en Vercel, y la primera compra automática con un pedido real; Claude mira los logs de la corrida a la mañana.

---

## Self-review (hecho al escribir)

- **Cobertura del spec:** pedido/estados (T1), elección (T2), API de pago (T3), loop y verificación (T4), cron/lock/convivencia/recordatorio 23:55/README (T5), intake + confirmación + `/pedidos` (T6), dry-run (T7), calibración (T8). El Plan B (headless) no tiene tarea a propósito: sólo si T8 muestra que Spreedly rechaza la tokenización servidor-a-servidor.
- **Nombres cruzados:** `ordersDueTonight`, `lockOrder`/`unlockOrder`, `chooseItinerary`, `ordenDeCompra`, `superaTope`, `quote`/`initPayment`/`tokenizeCard`/`doPurchase`/`listBookings`/`hayReserva`, `runBuy`/`deadlineAR`, `formatPedido` — usados con el mismo nombre en todas las tareas.
- **Review Focus:** 1→T4 caso 5, 2→T4 caso 3, 3→T1 lock + T4 caso 7 + T5, 4→T2 `escalaMinima`, 5→T6 caso (d).
