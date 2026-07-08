// test-formats.mjs — verify free-form value shaping with a NUMBERS-ONLY profile.
import { spawnSync } from 'child_process';
import { writeFileSync, copyFileSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SF = path.resolve(__dirname, '..', 'plugins/claw-hwp/skills/hwp/scripts/secure-fill.mjs');
const EX = path.resolve(__dirname, '..', 'plugins/claw-hwp/skills/hwp/scripts/extract_text.js');

const D = mkdtempSync(path.join(os.tmpdir(), 'fmt_'));
copyFileSync(path.join(__dirname, 'form_template.hwp'), path.join(D, 'form.hwp'));
const prof = path.join(D, 'p.txt');
writeFileSync(prof, '생년월일: 970605\n전화번호: 01012345678\n주민등록번호: 9012311234567\n');
console.log('프로필(숫자만): 생년월일=970605 · 전화=01012345678 · 주민=9012311234567\n');

function cell22(hwp) {
  const r = spawnSync('node', [EX, '--inspect', '--with-cell-text', hwp], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const root = JSON.parse(r.stdout); const t = (Array.isArray(root) ? root : root.tables)[0];
  const c = t.cells.find((x) => x.row === 2 && x.col === 2);
  return ((c && c.text) || '').trim();
}
function run(key, pattern) {
  const map = path.join(D, 'm.json');
  writeFileSync(map, JSON.stringify({ template: 'form.hwp', fields: [{ label: '①성', key, col_offset: 1, format: pattern }] }));
  const out = path.join(D, 'o.hwp');
  spawnSync('node', [SF, 'fill', '--profile', prof, '--map', map, '--out', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  console.log(`  ${pattern.padEnd(18)} → ${cell22(out)}`);
}
console.log('=== 날짜 (접두어 없이 모양만) ===');
['mm dd', 'yy.mm.dd', 'yyyy년 m월 d일', 'yyyy-mm-dd', 'yy.mm'].forEach((p) => run('생년월일', p));
console.log('=== 전화 (# 마스크) ===');
['###-####-####', '###########', '### #### ####'].forEach((p) => run('전화번호', p));
console.log('=== 주민번호 (# 마스크) ===');
['######-#######', '######'].forEach((p) => run('주민등록번호', p));
