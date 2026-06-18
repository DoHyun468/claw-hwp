// fill-from-profile.mjs — fill a .hwp form from a local profile WITHOUT the
// personal values ever crossing into the orchestrating Claude's context.
//
// Boundary:
//   - profile.local.json (PII)  -> read ONLY inside this process
//   - mapping.json (labels+keys) -> authored by Claude, no values
//   - values flow: profile file -> this process -> create.js stdin -> .hwp
//   - create.js logs truncated cell text in its .log array; we DROP it and
//     surface only {status} + a redacted per-field report (key, char count).
//
// usage: node fill-from-profile.mjs <profile.json> <mapping.json> <out.hwp>
import { readFileSync, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CREATE = path.join(REPO, 'plugins/claw-hwp/skills/hwp/scripts/create.js');

const [, , profilePath, mappingPath, outPath] = process.argv;
if (!profilePath || !mappingPath || !outPath) {
  console.error('usage: fill-from-profile.mjs <profile.json> <mapping.json> <out.hwp>');
  process.exit(1);
}

const profile = JSON.parse(readFileSync(profilePath, 'utf8')); // PII — never printed
const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
const template = path.resolve(REPO, mapping.template);

copyFileSync(template, outPath); // raw-patch edits the file in place

const operations = [];
const attempted = [];
for (const f of mapping.fields) {
  const val = profile[f.key];
  if (val == null) { attempted.push({ field: f.label, key: f.key, status: 'KEY_MISSING' }); continue; }
  operations.push({
    type: 'set_cell_text_by_label',
    label: f.label,
    text: String(val),
    col_offset: f.col_offset ?? 0,
    row_offset: f.row_offset ?? 0,
  });
  attempted.push({ field: f.label, key: f.key, chars: String(val).length });
}

const payload = JSON.stringify({ path: outPath, operations });
const res = spawnSync('node', [CREATE], { input: payload, encoding: 'utf8', maxBuffer: 1 << 26 });

// Scrub the engine output: read status + message ONLY, drop .log (it echoes
// truncated cell text). The .message is structural (op/cell errors), no PII.
let engineStatus = 'parse_error', engineMessage = null;
try { const o = JSON.parse(res.stdout) || {}; engineStatus = o.status ?? 'unknown'; engineMessage = o.message ?? null; } catch {}
const ok = engineStatus === 'ok' || engineStatus === 'success';

console.log(JSON.stringify({
  out: outPath,
  engine_status: engineStatus,
  ...(ok ? { filled: attempted } : { engine_message: engineMessage, attempted: attempted.map((a) => a.field) }),
  note: 'values never printed; engine .log scrubbed',
}, null, 2));

if (!ok) process.exit(2);
