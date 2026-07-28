// Valida el .env sin imprimir valores. node check-env.mjs
import { readFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('❌ No hay .env. Copiá .env.example a .env.');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const CHECKS = [
  ['TELEGRAM_TOKEN', /^\d{8,12}:[A-Za-z0-9_-]{35}$/, '<id>:<35 chars> del BotFather', true],
  ['TELEGRAM_CHAT_ID', /^-?\d{5,}$/, 'numérico (negativo si es grupo)', true],
  ['AYCF_PASS_ID', /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, 'UUID de availability/{passId}', true],
  ['AYCF_COOKIE', /=/, 'pares k=v separados por ";"', true],
  ['CRON_SECRET', /^.{16,}$/, '>=16 chars (solo hace falta en Vercel)', false],
];

let fatal = 0;
for (const [key, rx, desc, required] of CHECKS) {
  const v = env[key];
  if (!v) {
    console.log(`  [ ] ${key.padEnd(17)} vacío — ${desc}`);
    if (required) fatal++;
    continue;
  }
  const ok = rx.test(v);
  let nota = `${String(v.length).padStart(4)} chars`;
  if (key === 'AYCF_COOKIE') {
    const names = v.split(';').filter((c) => c.includes('=')).map((c) => c.split('=')[0].trim());
    nota += ` · ${names.length} cookies: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`;
    if (!names.some((n) => /sess|auth|token|sid/i.test(n))) {
      nota += '\n       ⚠️ ninguna parece de sesión — ¿copiaste el header entero?';
    }
  }
  if (key === 'TELEGRAM_CHAT_ID') nota += v.startsWith('-') ? ' · grupo' : ' · chat privado';
  console.log(`  [${ok ? 'OK' : '!!'}] ${key.padEnd(17)} ${nota}`);
  if (!ok) {
    console.log(`       ↳ formato inesperado, debería ser: ${desc}`);
    if (required) fatal++;
  }
}

console.log(fatal ? `\n❌ ${fatal} problema(s).` : '\n✅ .env listo. Corré: node --env-file=.env run-local.mjs');
process.exit(fatal ? 1 : 0);
