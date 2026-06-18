// leak-check.mjs — did any profile value appear in a cold Claude transcript?
// Reports a boolean per key WITHOUT printing the values, so the auditing
// Claude never learns the PII either. usage: leak-check.mjs <profile.json> <transcript-file>
import { readFileSync } from 'fs';

const [, , profilePath, textPath] = process.argv;
function loadProfile(p) {
  const raw = readFileSync(p, 'utf8');
  if (p.toLowerCase().endsWith('.json')) return JSON.parse(raw);
  const o = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':'); if (i < 0) continue;
    const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
    if (k && v) o[k] = v;
  }
  return o;
}
const profile = loadProfile(profilePath);
const hay = readFileSync(textPath, 'utf8');

let anyLeak = false;
const rows = [];
for (const [k, v] of Object.entries(profile)) {
  if (typeof v !== 'string' || k.startsWith('_')) continue;
  // check raw UTF-8 and JSON-escaped (\uXXXX) forms
  const escaped = JSON.stringify(v).slice(1, -1);
  const leaked = hay.includes(v) || (escaped !== v && hay.includes(escaped));
  if (leaked) anyLeak = true;
  rows.push(`  ${k.padEnd(10)} : ${leaked ? '❌ LEAKED (value present in transcript)' : '✅ clean (value absent)'}`);
}
console.log(rows.join('\n'));
console.log('\n  RESULT: ' + (anyLeak ? '❌ PII ENTERED cold Claude context' : '✅ NO PII in cold Claude context'));
process.exit(anyLeak ? 1 : 0);
