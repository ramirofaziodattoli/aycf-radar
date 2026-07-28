# AYCF Radar

Te avisa apenas hay cupo en las rutas que te interesan del pase **All You Can Fly** de JetSMART.

El pase libera los asientos a las 00:01 del día anterior, en cantidades mínimas —en algunas rutas
menos de un asiento por vuelo— y el portal es lento justo en ese minuto. Este radar consulta solo,
cada 15 minutos, y te manda un Telegram con los vuelos que aparecieron.

Cero dependencias. Corre en Vercel, en una VPS o en tu máquina.

```
🛫 AYCF — 3 vuelo(s) con cupo para el 2026-07-29

✅ Bariloche → Buenos Aires
   • JA3100 · 06:00→07:28 · 01h 28m · 6 asientos · ARS 15,103.85
   • JA3106 · 19:40→21:08 · 01h 28m · 2 asientos · ARS 15,103.85

✅ Salta → Buenos Aires
   • JA3241 · 12:15→14:35 · 02h 20m · 1 asiento · ARS 18,440.10

                    [ 🎟️ Canjear ahora ]
```

## Cómo anda

Un cron pega cada 15 min al endpoint de disponibilidad de Caravelo (el proveedor del pase),
filtra por tus criterios, y notifica **solo lo que no te avisó antes**.

**Horizonte: D+1, y no es una limitación del radar.** Los T&C fijan la ventana de canje entre 24h
y 120 min antes de la salida, y el inventario se libera por día calendario a medianoche. Consultar
D+2 devuelve vacío siempre. El barrido diario *es* el universo canjeable completo.

### La sesión se renueva sola

`laravel_session` vence a los **30 minutos de inactividad**, pero Caravelo devuelve una cookie
nueva en cada respuesta autenticada: es una ventana deslizante. El radar guarda esa cookie rotada,
así que **mientras corra más seguido que cada 30 min, la sesión no vence nunca**.

Solo la primera semilla es manual (el login va por Keycloak y no lo automatizamos: implicaría
guardarte usuario y contraseña). Si el radar estuvo caído más de 30 min, te avisa por Telegram
que hay que re-sembrarla.

> Por eso hace falta almacenamiento persistente. En Vercel el filesystem es efímero: sin Redis, la
> cookie renovada se pierde entre invocaciones y volvés al problema de origen.

## Configurar los watches

`watches.json` (o la env var `WATCHES` con el mismo JSON). Solo `from` y `to` son obligatorios:

```jsonc
[
  { "label": "Bariloche → Buenos Aires", "from": "BRC", "to": "AEP" },

  {
    "label": "Escapada de finde, los dos juntos",
    "from": "AEP", "to": "SLA",
    "minSeats": 2,                    // ignora vuelos donde no entran los dos
    "weekdays": ["thu", "fri"],       // solo avisa jueves y viernes
    "departAfter": "15:00"            // no me sirve salir a la mañana
  },

  {
    "label": "Vuelta en agosto y barata",
    "from": "SLA", "to": "AEP",
    "dateFrom": "2026-08-01",
    "dateTo": "2026-08-31",
    "maxTaxes": 25000                 // el pase cubre la tarifa, NO las tasas
  },

  { "from": "COR", "to": "AEP", "enabled": false }
]
```

| Campo | Default | Qué hace |
|---|---|---|
| `from`, `to` | — | IATA de 3 letras. Obligatorios |
| `label` | `FROM→TO` | Cómo aparece en la notificación |
| `minSeats` | `1` | Cupo mínimo **en el mismo vuelo** |
| `weekdays` | todos | `sun mon tue wed thu fri sat` |
| `dateFrom` / `dateTo` | — | Rango `YYYY-MM-DD` |
| `departAfter` / `departBefore` | — | Franja horaria, `HH:MM` |
| `maxTaxes` | — | Tope de tasas por tramo |
| `enabled` | `true` | `false` lo pausa sin borrarlo |

Los filtros de fecha **silencian**, no amplían: el horizonte lo fija la API. Varios watches sobre
la misma ruta se resuelven con un solo request.

## Arrancar

```bash
git clone … && cd aycf-radar
cp .env.example .env
cp watches.example.json watches.json
```

**1. Datos del pase.** Logueate en go.jetsmart.com, DevTools → Network, hacé una búsqueda y
clickeá el request `availability/…`. De ahí salen `AYCF_PASS_ID` (el UUID de la URL) y
`AYCF_COOKIE` (el header `cookie`).

**2. Telegram.** [@BotFather](https://t.me/BotFather) → `/newbot`. Mandale `/start` al bot y sacá
tu chat:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"id":[-0-9]*' | head -1
```

> Los bots traen *privacy mode*: en grupos solo ven mensajes que empiezan con `/`. Si `getUpdates`
> vuelve vacío, mandá `/start`. Si el token se te escapó alguna vez, rotalo con `/revoke`.

**3. Probalo.**

```bash
npm run dev              # los vuelos de mañana
npm run dev 2026-08-13   # una fecha puntual
```

## Deploy

### Vercel
```bash
vercel --prod
```

Env vars: `AYCF_PASS_ID`, `AYCF_COOKIE`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `WATCHES`,
`CRON_SECRET`, más las de Redis.

- **Plan Pro:** en Hobby los crons corren una vez por día y sin garantía del minuto exacto — con
  eso la sesión se muere y te perdés el momento de la liberación.
- **Redis obligatorio:** Upstash desde el Marketplace, o cualquier Redis con REST. También lee las
  `KV_REST_API_*` de Vercel KV.
- **`CRON_SECRET`:** Vercel lo manda como Bearer. Sin esto la URL queda pública y cualquiera
  dispara requests con tu sesión.

### VPS / Raspberry / lo que tengas
Sin Redis el estado va a `.state.json`. Un cron del sistema cada 15 min:

```cron
*/15 * * * * cd /opt/aycf-radar && /usr/bin/node --env-file=.env run-local.mjs >> radar.log 2>&1
```

## Sé buen vecino

Cada corrida hace **un request por ruta distinta**. Con 10 rutas cada 15 min son ~960 requests
diarios contra JetSMART. Es tu propia cuenta y tu propio cupo, pero no hay motivo para apretar más:
el inventario cambia en la liberación de medianoche y cuando alguien cancela. Si tenés muchas
rutas, alargá el intervalo. Si lo alargás más de 30 min, agregá un cron a `/api/keepalive` para
que la sesión no se muera.

## Endpoints

| Ruta | Para qué |
|---|---|
| `GET /api/cron` | Barrido completo. Acepta `?date=YYYY-MM-DD` |
| `GET /api/keepalive` | Un solo request, solo para mantener viva la sesión |

Ambos exigen `Authorization: Bearer $CRON_SECRET` si la env var está definida.

## Tests

```bash
npm test
```

Cubre el cálculo de D+1 (cruces de medianoche, mes y año), el parseo de la respuesta real de
Caravelo, la validación de watches, los filtros, la rotación de cookie y el dedupe. Sin red: el
`search` se inyecta.

## Limitaciones conocidas

- **Horizonte D+1.** Impuesto por la ventana de canje. El payload manda `intervalSubtype: null` y
  la respuesta trae `intervalDatesOw: []`, lo que sugiere un modo calendario multi-fecha sin
  documentar. Si alguien lo descifra, se puede ampliar.
- **Semilla manual de la cookie.** Automatizarla implicaría el flow de Keycloak y guardar
  credenciales.
- **El botón va a la home del canje**, no al vuelo. Cada vuelo trae `key` y `fareSellKey`; si la
  SPA acepta prellenar por query param se puede hacer deep link.
- **Solo `flightType: "OW"`.** Ida y vuelta en un request está sin explorar.

Proyecto no oficial, sin relación con JetSMART ni Caravelo. Usá tu propia cuenta y tu propio pase.

MIT.
