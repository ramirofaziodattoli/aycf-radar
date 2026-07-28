# AYCF Radar

Cron que a las **00:01 ART** —cuando JetSmart libera los cupos del día siguiente— consulta las
rutas de `ROUTES` y avisa por Telegram las que tengan asientos.

Los cupos AYCF son escasísimos (a Salta ~0,96 asientos por vuelo) y se los lleva el que entra
primero. El portal de go.jetsmart.com es lento justo en ese minuto.

Cero dependencias: Node 22 ya trae `fetch`.

## Cómo funciona

`vercel.json` dispara `/api/radar` a las **03:01 UTC = 00:01 ART** (Argentina es UTC-3 fijo, sin
DST desde 2009). El handler barre `ROUTES` contra **D+1** y notifica por Telegram las que tengan
`flightsOutbound` no vacío.

**No hay fechas en la config, solo rutas.** El horizonte está capado en D+1 por la propia API: el
inventario AYCF se libera a las 00:01 del día anterior (T&C: canje entre 24h y 120min antes de la
salida), así que D+2 siempre devuelve vacío. El barrido diario *es* el universo canjeable completo.

Por defecto **solo notifica cuando hay cupo** — un mensaje por noche diciendo "nada" es ruido.
`NOTIFY_EMPTY=true` fuerza el aviso igual, útil las noches en que un "no hay nada" dispara plan B.

Errores (sesión caída, respuesta no-JSON) **siempre** notifican: un cron que falla callado a las
00:01 es peor que no tenerlo.

### Contrato

```
POST https://go.jetsmart.com/es-ar/ja/subscriptions/availability/{passId}
Accept: application/vnd.cvo.subs.frontend+json
Cookie: <sesión>

{"flightType":"OW","origin":"AEP","destination":"SLA","departure":"2026-08-13",
 "arrival":null,"intervalSubtype":null,"outboundKey":null}
```

Respuesta ~34KB. Lo único que importa: `content.flights.flightsOutbound` (vacío = sin cupo).
Trae además `content.routes` (las 51 rutas de la red) y `content.blackoutDates`.

Backend: Caravelo (`Changeyourflight S.L.`), el mismo que procesa la suscripción. Auth por cookie
de sesión, sin `Authorization`. Un POST por ruta, sin paginado ni batch.

## Empezar acá: probarlo local (5 min, sin deployar nada)

Antes de tocar Vercel conviene verlo andar en la compu. Así confirmás que la cookie sirve y que
el mensaje llega, sin pelearte con el deploy al mismo tiempo.

1. **Bot:** hablale a [@BotFather](https://t.me/BotFather) → `/newbot`. Guardá el token.
2. **Chat:** mandale `/start` al bot **por privado** (el grupo con Ailu se suma después, es
   cambiar un número). Sacá tu `chat_id`:
   ```bash
   curl -s "https://api.telegram.org/bot<TU_TOKEN>/getUpdates" | grep -o '"id":[-0-9]*' | head -1
   ```
3. **Datos de JetSmart:** logueate, DevTools → Network → hacé una búsqueda → click en el request
   `availability/...`. De ahí salen el `passId` (el UUID al final de la URL) y el header `cookie`.
4. **Completá el `.env`:**
   ```bash
   cp .env.example .env   # y llenalo
   ```
5. **Corré:**
   ```bash
   node --env-file=.env run-local.mjs 2026-07-29
   ```
   Te tiene que llegar un mensaje al Telegram. Si dice "sin cupo", **funcionó igual**: consultó y
   no había lugar.

`ROUTES` ya trae AEP↔COR y AEP↔BRC (72% y 71%), que son los de mayor disponibilidad de la red:
son los que más chance tienen de devolver vuelos y mostrarte cómo se ve el mensaje cuando hay.
Si querés forzar el aviso aunque no haya nada, corré con `NOTIFY_EMPTY=true`.

## Pasarlo a producción

Una vez que anda local, el deploy es para que corra **solo a las 00:01** aunque la compu esté
apagada.

### 1. Bot de Telegram (si querés sumar a Ailu)
1. Creá un grupo, meté al bot y a Ailu.
2. **Mandá `/start` en el grupo** (tiene que empezar con `/`, ver abajo) y sacá el `chat_id`:
   ```bash
   curl -s "https://api.telegram.org/bot<TU_TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
   ```
   Es negativo en los grupos (ej. `-1001234567890`).

> ⚠️ **Gotcha:** los bots vienen con *privacy mode* activado y **no ven los mensajes normales de un
> grupo**, solo los que empiezan con `/` o son respuesta al bot. Si mandás "hola" y `getUpdates`
> vuelve vacío, no está roto: mandá `/start` y aparece.

> 🔑 **Si el token se te escapó** (captura, chat, commit): en BotFather `/revoke` → elegí el bot →
> te da uno nuevo y el viejo deja de servir. Con el token, cualquiera lee y escribe en el grupo.

### 2. La cookie de sesión
1. Logueate en go.jetsmart.com y andá a la página de canje.
2. DevTools → Network → hacé una búsqueda → click en el request `availability/...`
3. Copiá el header `cookie` entero.

⚠️ **La cookie es una credencial.** Va solo a env vars de Vercel. Nunca al repo, nunca a un chat.
El `.gitignore` ya bloquea `.env` y `*.har`.

### 3. Deploy
```bash
vercel --prod
```

⚠️ Tiene que ir a una cuenta **Pro**: en Hobby los crons corren una vez por día y **sin garantía
del minuto exacto**, que es justo lo único que importa acá. Ojo con cuál de las dos cuentas.

### 4. Env vars en Vercel
| Variable | Qué es |
|---|---|
| `AYCF_COOKIE` | El header `cookie` del paso 2 |
| `AYCF_PASS_ID` | El UUID que va en la URL de `availability/{passId}` |
| `TELEGRAM_TOKEN` | Del BotFather |
| `TELEGRAM_CHAT_ID` | Del chat privado o del grupo |
| `NOTIFY_EMPTY` | Opcional. `true` para que avise también cuando no hay cupo |
| `CRON_SECRET` | Inventalo. Vercel lo manda solo como Bearer y sin esto **cualquiera puede disparar el endpoint y usar tu cookie** |

### 5. Probar antes de que importe
```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://<tu-deploy>.vercel.app/api/radar?date=2026-07-29"
```
Barre las 10 rutas de `ROUTES`. Si aparecen vuelos, revisá que el mensaje se vea bien.

## Pendiente de calibrar

1. **La forma del objeto vuelo.** Las capturas del HAR vinieron todas vacías, así que
   `describeFlight()` prueba los nombres de campo más probables y, si no reconoce ninguno, manda el
   JSON crudo recortado. La primera corrida con cupo revela la forma real y ahí se ajusta.
2. **Cuánto vive la cookie.** Es el único riesgo serio. Si dura días, esto queda 100% automático.
   Si dura una hora, hay que recargarla antes de dormir las noches clave.
3. **El botón "Ir a canjear"** apunta a la página de canje, sin prellenar la búsqueda. Si la SPA
   acepta query params, se puede hacer un link directo al vuelo.

## Tests
```bash
npm test
```
Cubre el cálculo de D+1 (cruce de medianoche ART, de mes y de año), que toda ruta tenga su inversa,
la detección de sesión caída, la política de notificación y el formato del mensaje.

## Contexto
Ver `lifestyle/proyectos/aycf-radar-spec.md` y `viaje-salta-agosto-2026.md` en el segundo cerebro.
