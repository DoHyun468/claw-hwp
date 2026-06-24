// verify-fill.mjs — confirm a filled form WITHOUT exposing the values.
// Reads the grid in-process, reports per-field FILLED/EMPTY + char count +
// a masked preview (•). The actual text never leaves this process.
//
// usage: node verify-fill.mjs <filled.hwp> <mapping.json>
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EXTRACT = path.join(REPO, 'plugins/claw-hwp/skills/hwp/scripts/extract_text.js');

const [, , filledPath, mappingPath] = process.argv;
const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));

const res = spawnSync('node', [EXTRACT, '--inspect', '--with-cell-text', filledPath], { encoding: 'utf8', maxBuffer: 1 << 26 });
const root = JSON.parse(res.stdout);                 // contains PII — kept in-process only
const tables = Array.isArray(root) ? root : (root.tables || root.cellText || []);

const findLabel = (sub) => {
  for (const t of tables) for (const c of t.cells) if ((c.text || '').includes(sub)) return c;
  return null;
};
const findCell = (row, col) => {
  for (const t of tables) for (const c of t.cells) if (c.row === row && c.col === col) return c;
  return null;
};

const verified = [];
for (const f of mapping.fields) {
  const lab = findLabel(f.label);
  if (!lab) { verified.push({ field: f.label, status: 'LABEL_NOT_FOUND' }); continue; }
  const tr = lab.row + (f.row_offset ?? 0);
  const tc = lab.col + (f.col_offset ?? 0);
  const cell = findCell(tr, tc);
  const txt = cell ? (cell.text || '') : '';
  verified.push({
    field: f.label,
    target: `(${tr},${tc})`,
    status: txt.length ? 'FILLED' : 'EMPTY',
    chars: txt.length,
    masked: txt.length ? '•'.repeat(Math.min(txt.length, 16)) : '',
  });
}

console.log(JSON.stringify({ verified, note: 'values masked — fill confirmed without exposing PII' }, null, 2));
