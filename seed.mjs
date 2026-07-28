// Siembra la cookie de sesión desde el portapapeles y la valida al instante.
//
//   npm run seed
//
// laravel_session vive 30 minutos. Copiar de DevTools, pegar en algún lado y
// probar a mano suele tardar más que eso. Esto lo reduce a un comando.
//
// Acepta cualquiera de estas formas:
//   - el header `cookie` completo (Network > Request Headers)
//   - los valores sueltos de Application > Cookies, uno por línea, en cualquier
//     orden: prueba cuál es laravel_session y cuál XSRF-TOKEN por descarte.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PASS_ID = process.env.AYCF_PASS_ID;
if (!PASS_ID) {
  console.error('❌ Falta AYCF_PASS_ID en .env');
  process.exit(1);
}

function clipboard() {
  const cmd = process.platform === 'darwin' ? 'pbpaste'
    : process.platform === 'win32' ? 'powershell -command Get-Clipboard'
    : 'xclip -selection clipboard -o';
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch {
    console.error('❌ No pude leer el portapapeles. Pasá la cookie como argumento.');
    process.exit(1);
  }
}

const raw = (process.argv[2] ?? clipboard()).trim();
if (!raw) {
  console.error('❌ Portapapeles vacío.');
  process.exit(1);
}

/** Candidatos a header `cookie`, del más probable al menos. */
function candidates(input) {
  if (input.includes('laravel_session=')) return [input.replace(/\s*\n\s*/g, ' ')];

  const vals = input.split(/[\s\n]+/).map((v) => v.trim()).filter((v) => v.length > 40);
  if (vals.length === 0) return [];
  if (vals.length === 1) return [`laravel_session=${vals[0]}`];
  // Sin saber cuál es cuál, probamos ambos órdenes.
  return [
    `laravel_session=${vals[0]}; XSRF-TOKEN=${vals[1]}`,
    `laravel_session=${vals[1]}; XSRF-TOKEN=${vals[0]}`,
  ];
}

async function probe(cookie) {
  const r = await fetch(`https://go.jetsmart.com/es-ar/ja/subscriptions/availability/${PASS_ID}`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.cvo.subs.frontend+json',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      flightType: 'OW', origin: 'AEP', destination: 'COR',
      departure: new Date(Date.now() + 86400e3 - 3 * 3600e3).toISOString().slice(0, 10),
      arrival: null, intervalSubtype: null, outboundKey: null,
    }),
  });
  if (r.status === 401 || r.status === 403) return { ok: false, why: `${r.status} Unauthorized` };
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    return { ok: false, why: `respuesta no-JSON (${r.status})` };
  }
  if (j.redirectUri) return { ok: false, why: 'redirige al login' };
  const motivo = j.content?.exceptionMessage ?? j.exceptionMessage;
  if (motivo === 'error.token.mismatch') return { ok: false, why: 'SUPERADA', mismatch: true };
  if (!r.ok) return { ok: false, why: `${r.status}${motivo ? ` ${motivo}` : ''}` };
  return { ok: true, flights: j.content?.flights?.flightsOutbound?.length ?? 0 };
}

const opciones = candidates(raw);
if (opciones.length === 0) {
  console.error('❌ No reconocí ninguna cookie en lo que pegaste.');
  process.exit(1);
}

const fallos = [];
for (const [i, cookie] of opciones.entries()) {
  process.stdout.write(`Probando ${i + 1}/${opciones.length}… `);
  const res = await probe(cookie);
  if (!res.ok) {
    console.log(`no (${res.why})`);
    fallos.push(res);
    continue;
  }
  console.log('✅');

  const env = readFileSync('.env', 'utf8');
  const linea = `AYCF_COOKIE=${cookie}`;
  writeFileSync(
    '.env',
    env.includes('AYCF_COOKIE=')
      ? env.replace(/^AYCF_COOKIE=.*$/m, linea)
      : `${env.trimEnd()}\n${linea}\n`,
    { mode: 0o600 }
  );

  console.log(`\nSesión viva y guardada en .env (${res.flights} vuelo(s) en AEP→COR mañana).`);
  console.log('\nAhora, mientras siga fresca:');
  console.log('  npm run dev                                  # barrido local');
  console.log('  vercel env add AYCF_COOKIE production        # pegá la MISMA línea');
  console.log('  vercel --prod');
  process.exit(0);
}

if (fallos.some((f) => f.mismatch)) {
  console.error('\n❌ La cookie quedó SUPERADA (error.token.mismatch).');
  console.error('   El ID de sesión rota en cada request. Si seguiste navegando el portal');
  console.error('   después de copiarla, la que tenés ya no vale.');
  console.error('\n   Hacelo así:');
  console.error('     1. En el portal, hacé UNA búsqueda');
  console.error('     2. Application → Cookies → copiá laravel_session Y XSRF-TOKEN');
  console.error('     3. CERRÁ la pestaña — no toques más el portal');
  console.error('     4. npm run seed');
} else {
  console.error('\n❌ Ninguna sirvió: la sesión venció (30 min de inactividad).');
  console.error('   Volvé al portal, hacé una búsqueda y copiá de nuevo.');
}
process.exit(1);
