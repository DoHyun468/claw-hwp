// diagnose.mjs <profile> <transcript> — print the cold agent's reasoning +
// tool calls in order, with profile VALUES redacted, to see WHY it read the
// profile. Skips tool_result blocks (those hold PII). usage as above.
import { readFileSync } from 'fs';

const [, , profilePath, txPath] = process.argv;
function loadVals(p) {
  const raw = readFileSync(p, 'utf8'); const vals = [];
  if (p.endsWith('.json')) { const o = JSON.parse(raw); for (const v of Object.values(o)) if (typeof v === 'string' && v) vals.push(v); }
  else for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t || t.startsWith('#')) continue; const i = t.indexOf(':'); if (i > 0) { const v = t.slice(i + 1).trim(); if (v) vals.push(v); } }
  return vals;
}
const vals = loadVals(profilePath);
const redact = (s) => { let o = String(s); for (const v of vals) { o = o.split(v).join('•'.repeat(4)); const e = JSON.stringify(v).slice(1, -1); if (e !== v) o = o.split(e).join('•'.repeat(4)); } return o; };

const KW = /내정보|profile|secure-fill|keys|fill|확인|검증|cat|Read|읽|verify|값/i;
for (const line of readFileSync(txPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'assistant' || !o.message?.content) continue;
  for (const b of o.message.content) {
    if (b.type === 'text' && b.text && KW.test(b.text)) console.log('💬 ' + redact(b.text.replace(/\s+/g, ' ').trim()).slice(0, 240));
    if (b.type === 'tool_use') {
      const inp = redact(JSON.stringify(b.input || {})).slice(0, 180);
      if (KW.test(inp) || /Bash|Read/.test(b.name)) console.log(`🔧 ${b.name}  ${inp}`);
    }
  }
}
