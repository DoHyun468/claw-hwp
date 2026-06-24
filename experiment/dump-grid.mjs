// dump-grid.mjs — print a .hwp's table grid (row,col,label). Use on BLANK
// templates only (no PII). usage: node dump-grid.mjs <file.hwp>
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACT = path.resolve(__dirname, '..', 'plugins/claw-hwp/skills/hwp/scripts/extract_text.js');
const res = spawnSync('node', [EXTRACT, '--inspect', '--with-cell-text', process.argv[2]], { encoding: 'utf8', maxBuffer: 1 << 26 });
const root = JSON.parse(res.stdout);
const tables = Array.isArray(root) ? root : (root.tables || []);
tables.forEach((t, ti) => {
  console.log(`-- table#${ti} sec${t.sec} para${t.para} ctrl${t.ctrl} ${t.rowCount}x${t.colCount} --`);
  t.cells.forEach((c) => {
    const x = (c.text || '').replace(/\s+/g, ' ').trim().slice(0, 34);
    if (x) console.log(`  (${c.row},${c.col}) "${x}"`);
  });
});
