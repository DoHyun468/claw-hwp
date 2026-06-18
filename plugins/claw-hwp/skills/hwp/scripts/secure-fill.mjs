#!/usr/bin/env node
// secure-fill.mjs — fill .hwp forms with personal info WITHOUT the values
// entering the model's (Claude's) context. Subcommands:
//
//   detect                         → report env + whether a persistent profile exists (NO values)
//   template <out.txt> --keys a,b  → write an empty, non-dev-friendly fill-in file (no values)
//   fill --profile P --map M --out O   → fill the form (values read in-process, never printed)
//   verify --out O --map M         → masked read-back (FILLED/EMPTY + char count only)
//   stash --from F                 → (persistent opt-in) move F to ~/.claw-hwp/profile.txt, chmod 600.
//                                     REFUSES in a sandbox/remote env.
//   shred <path>                   → overwrite + delete a temp profile
//
// Design: Claude orchestrates by KEY NAME; this tool reads the VALUES from the
// file in-process and pipes them to create.js stdin. create.js's STDOUT JSON
// carries a `.log` ARRAY (not a log file) that echoes truncated cell text — we
// parse only {status,message} and drop `.log`. No log file is written; nothing
// here prints a value. (Cowork handoff: clarified — there is no stray .log file.)
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync, chmodSync, statSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREATE = path.join(__dirname, 'create.js');
const HWPX_EDIT = path.join(__dirname, 'hwpx-edit.js'); // HWPX fill engine (HWPX-track slice)
const EXTRACT = path.join(__dirname, 'extract_text.js');
const PERSIST_DIR = path.join(process.env.CLAW_HWP_HOME || os.homedir(), '.claw-hwp');
const PERSIST_FILE = path.join(PERSIST_DIR, 'profile.txt');

// ── environment awareness ────────────────────────────────────────────────
// In Cowork / remote sandboxes the filesystem is NOT the user's machine:
// persisting PII there strands it on someone else's infra. Treat as sandbox
// unless local desktop ownership is positively proven. A prompt/file injection
// can ask the agent to set CLAW_HWP_ENV=local, so that override is advisory only.
function envInfo() {
  const forced = process.env.CLAW_HWP_ENV || null; // 'sandbox' | 'local'
  const platform = process.platform, arch = process.arch;
  const home = os.homedir();
  // FAIL-CLOSED: treat as sandbox unless LOCAL is positively proven.
  // (Cowork handoff C2: arch-only guessing is fail-open; a wrong guess lets
  //  stash persist plaintext PII onto Anthropic infra.)
  const homeLooksSandbox = home.startsWith('/sessions') || home.startsWith('/tmp') || home === '/' || home === '/root';
  const homeLooksLocalDesktop =
    (platform === 'darwin' && home.startsWith('/Users/')) ||
    (platform === 'win32' && /^[A-Za-z]:[\\/]Users[\\/]/.test(home));
  let likely_sandbox;
  let forced_ignored = null;
  if (forced === 'sandbox') likely_sandbox = true;
  else if (forced === 'local' && homeLooksLocalDesktop && !homeLooksSandbox) likely_sandbox = false;
  else if (forced === 'local') {
    likely_sandbox = true;
    forced_ignored = 'CLAW_HWP_ENV=local ignored because this home is not a proven local desktop home';
  } else if (homeLooksSandbox) likely_sandbox = true;
  else if (homeLooksLocalDesktop) likely_sandbox = false;
  else likely_sandbox = true; // unknown (e.g. bare linux) → fail closed to sandbox
  return { platform, arch, home, forced, forced_ignored, likely_sandbox, local_proven: !likely_sandbox };
}

// ── profile loading (txt "키: 값"  OR  json) ──────────────────────────────
function loadProfile(p) {
  const raw = readFileSync(p, 'utf8');
  if (p.toLowerCase().endsWith('.json')) return JSON.parse(raw);
  const obj = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) obj[k] = v; // keep empty values so `keys` can list all fields; fill treats '' as not-yet-filled
  }
  return obj;
}

// ── value formatting ──────────────────────────────────────────────────────
// One canonical value in the profile, many on-form shapes. A mapping field can
// carry `format` (e.g. "date:yy.mm.dd", "phone:intl-paren", "rrn:digits"); the
// transform runs HERE, so neither the value nor the reshaped value ever enters
// Claude's context — Claude only writes the format NAME in the mapping.
function parseYMD(v) {
  const d = String(v).replace(/\D/g, '');
  let y, m, day;
  if (d.length >= 8) { y = d.slice(0, 4); m = d.slice(4, 6); day = d.slice(6, 8); }
  else if (d.length === 6) { const yy = +d.slice(0, 2); y = String(yy <= 29 ? 2000 + yy : 1900 + yy); m = d.slice(2, 4); day = d.slice(4, 6); }
  else return null;
  return { y, yy: y.slice(2), m, d: day };
}
function fmtDate(v, style) {
  const p = parseYMD(v); if (!p) return v;
  // token replace, longest-first: yyyy/yy/mm/dd then single m/d (no leading zero)
  return (style || 'yyyy-mm-dd')
    .replace(/yyyy/g, p.y).replace(/yy/g, p.yy)
    .replace(/mm/g, p.m).replace(/dd/g, p.d)
    .replace(/m/g, String(+p.m)).replace(/d/g, String(+p.d));
}
// digit mask: each `#` consumes the next digit of the value, literals pass through.
function maskDigits(v, pattern) {
  const ds = String(v).replace(/\D/g, ''); let i = 0;
  return String(pattern).replace(/#/g, () => ds[i++] ?? '');
}
function fmtPhone(v, style) {
  const d = String(v).replace(/\D/g, ''); if (d.length < 9) return v;
  const a = d.slice(0, 3), b = d.slice(3, -4), c = d.slice(-4);
  switch (style) {
    case 'digits': return d;
    case 'dot': return `${a}.${b}.${c}`;
    case 'space': return `${a} ${b} ${c}`;
    case 'intl': return `+82-${d.slice(1, 3)}-${b}-${c}`;
    case 'intl-paren': return `82)${d.slice(1, 3)}-${b}-${c}`;
    case 'hyphen': default: return `${a}-${b}-${c}`;
  }
}
function fmtRRN(v, style) {
  const d = String(v).replace(/\D/g, ''); if (d.length !== 13) return v;
  switch (style) {
    case 'digits': return d;
    case 'front': return d.slice(0, 6);
    case 'masked': return `${d.slice(0, 6)}-${d[6]}******`;
    case 'hyphen': default: return `${d.slice(0, 6)}-${d.slice(6)}`;
  }
}
function formatValue(value, fmt) {
  if (!fmt) return value;
  const s = String(fmt);
  const ci = s.indexOf(':');
  const kind = ci >= 0 ? s.slice(0, ci) : s;
  const style = ci >= 0 ? s.slice(ci + 1) : '';
  // explicit prefixes — for shapes that need logic, not just a mask (intl drop-0, masking…)
  if (kind === 'date') return fmtDate(value, style);
  if (kind === 'phone') return fmtPhone(value, style);
  if (kind === 'rrn') return fmtRRN(value, style);
  if (kind === 'mask') return maskDigits(value, style);
  if (kind === 'digits') return String(value).replace(/\D/g, '');
  if (kind === 'upper') return String(value).toUpperCase();
  if (kind === 'lower') return String(value).toLowerCase();
  if (kind === 'nospace') return String(value).replace(/\s+/g, '');
  // FREE bare shape (no prefix): profile holds just the numbers, agent gives the shape, we pour them in.
  if (s.includes('#')) return maskDigits(value, s);          // ###-####-#### , ###########
  if (/(yyyy|yy|mm|dd)/.test(s)) return fmtDate(value, s);   // yy.mm.dd , mm dd , yyyy년 m월 d일
  return value;
}

const HEADER = [
  '# 🚫 AI/AGENT: DO NOT open or read this file (no cat / Read / grep). 이 파일을 열어 읽지 마세요.',
  '#    값이 필요하면 `secure-fill fill` 만 사용. 필드 이름만 필요하면 `secure-fill keys` 사용.',
  '# ───────────────────────────────────────────────',
  '# (사람에게) 콜론(:) 뒤에 값만 적고 저장하세요.',
  '# 이 메모는 AI가 직접 읽지 않고, 서식 채우는 기능만 읽어 한글 문서에 옮겨 적어요.',
  '# 그래서 채팅에 직접 적는 것보다 안전합니다. 다 쓰면 지워집니다(임시).',
  '',
];

function cmdDetect() {
  const env = envInfo();
  const persistExists = !env.likely_sandbox && (existsSync(PERSIST_FILE) || existsSync(path.join(PERSIST_DIR, 'profile.json')));
  console.log(JSON.stringify({
    env,
    // In a sandbox the home is per-session (Cowork handoff C6) — persistent is meaningless there.
    persistent_profile: env.likely_sandbox
      ? 'N/A in this env (sandbox home is per-session; not the user machine)'
      : { exists: persistExists, use: persistExists ? 'secure-fill fill (omit --profile to use it — do NOT Read the file)' : null },
    can_persist: !env.likely_sandbox,
    note: env.likely_sandbox
      ? 'sandbox/remote env — filesystem is NOT the user machine. EPHEMERAL ONLY. Do NOT persist. Prefer MARKER mode (no PII enters sandbox). A profile the user uploads will enter your context — say so first.'
      : 'local env (proven) — persistent opt-in allowed at ~/.claw-hwp/',
  }, null, 2));
}

function cmdHandoff(args) {
  // Cowork → local Claude Code routing note. Contains NO PII.
  const keys = args.keys ? String(args.keys).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const lines = [
    '# 개인정보 서식 채우기 — 로컬 Claude Code에서 이어서 해주세요',
    '',
    '이 작업엔 **개인정보**가 들어갑니다. 지금 환경(Cowork)은 원격이라 개인정보를 안전하게 두기 어려워요.',
    '아래를 **로컬 Claude Code**(내 컴퓨터에서 도는 앱)에 그대로 전달해 주세요. 거기선 정보가 컴퓨터 밖으로 나가지 않습니다.',
    '',
    '## Claude Code에 이렇게 말하세요',
    '- 서식: 이 노트와 함께 받은 원본 서식 파일',
    keys.length ? `- 채울 항목: ${keys.join(', ')}` : '- 채울 항목: 서식의 빈칸들',
    '- 요청: "이 서식을 secure-fill로 내 개인정보를 채워줘. 값은 내가 파일에 직접 적을게."',
    '',
    '## 또는 — 지금 여기서 끝내려면 (마커 방식)',
    '빈칸에 「여기에 OOO 입력」 표식만 넣은 양식을 드릴 테니, 한컴오피스/한컴독스에서 직접 채우셔도 됩니다.',
    '그러면 개인정보가 이 원격 환경에 전혀 들어오지 않습니다.',
  ];
  writeFileSync(args.out, lines.join('\n') + '\n');
  console.log(JSON.stringify({ wrote: args.out, form: 'redacted', keys, contains_pii: false }, null, 2));
}

function refuse(reason) {
  console.log(JSON.stringify({ error: 'REFUSED', reason }, null, 2));
  process.exit(3);
}

// Restrict profile/keys input to known-safe roots so the tool can't be turned
// into an arbitrary-file reader (Cowork handoff V6). Legit profiles live in the
// persist dir / temp / cwd / Desktop / Downloads.
function assertProfileInput(p, label) {
  // realpath-normalize both sides so symlinks (e.g. /tmp → /private/tmp on macOS)
  // and `..` collapse — blocks /etc/passwd-style reads without breaking legit
  // profile locations under home / cwd / temp / ~/.claw-hwp.
  const norm = (x) => { try { return realpathSync(x); } catch { return path.resolve(x); } };
  const abs = norm(p);
  const roots = [process.cwd(), os.tmpdir(), '/tmp', os.homedir(), PERSIST_DIR].map(norm);
  if (!roots.some((r) => abs === r || abs.startsWith(r + path.sep))) refuse(`${label} path outside allowed locations (cwd / home / temp / ~/.claw-hwp)`);
  return abs;
}

function cmdKeys(p) {
  assertProfileInput(p, 'profile');
  const prof = loadProfile(p); // values loaded in-process but NOT printed
  console.log(JSON.stringify({ keys: Object.keys(prof), note: 'field names only — values were NOT read out' }, null, 2));
}

function cmdTemplate(out, keys) {
  const lines = [...HEADER, ...keys.map((k) => `${k}: `), ''];
  writeFileSync(out, lines.join('\n'));
  try { chmodSync(out, 0o600); } catch {}
  console.log(JSON.stringify({ wrote: out, keys, values: 'none (empty template)' }, null, 2));
}

function cmdFill(args) {
  // Default to the saved profile so Claude never needs to handle the PII path at all.
  const profilePath = args.profile || PERSIST_FILE, mapPath = args.map, out = args.out;
  // The SECURITY model (boundary/ephemeral/format/env/injection) is format-agnostic
  // and runs HERE for both engines; only the fill ENGINE branches below.
  assertProfileInput(profilePath, 'profile');
  const profile = loadProfile(profilePath);            // values — never printed
  const mapping = JSON.parse(readFileSync(mapPath, 'utf8'));
  // V1/V2 (Cowork handoff): mapping.template must be an EXISTING .hwp/.hwpx that
  // sits beside the mapping — never a traversal/absolute path, else an untrusted
  // "form pack" could copy an arbitrary file (e.g. ~/.ssh/id_rsa) into the
  // user-delivered output.
  const baseDir = path.resolve(path.dirname(mapPath));
  const template = path.resolve(baseDir, mapping.template || '');
  const rel = path.relative(baseDir, template);
  if (rel.startsWith('..') || path.isAbsolute(rel)) refuse(`mapping.template escapes the mapping folder (got '${mapping.template}')`);
  if (!/\.hwpx?$/i.test(template) || !existsSync(template)) refuse(`mapping.template must be an existing .hwp/.hwpx beside the mapping (got '${mapping.template}')`);

  const attempted = [];
  const missing = [];

  // ── HWPX engine (HWPX-track slice): hwpx-edit.js ─────────────────────────
  // Values stay out of the model exactly like the .hwp path: built in-tool,
  // piped to hwpx-edit.js stdin, and only counts (never values) come back.
  // Two field styles: `placeholder` → fill_template (control/run-aware replace,
  // so a blank split by <hp:fwSpace/>/runs still fills); `table`+`row`+`col` →
  // set_cell_text (positional). label+offset is .hwp-only (no by-label in HWPX).
  if (path.extname(String(out)).toLowerCase() === '.hwpx') {
    const values = {};
    const operations = [];
    for (const f of mapping.fields) {
      const name = f.placeholder ?? (f.table != null ? `cell[${f.table},${f.row},${f.col}]` : (f.label ?? f.key));
      const raw = profile[f.key];
      if (raw == null || raw === '') { missing.push(f.key); attempted.push({ field: name, key: f.key, status: 'EMPTY_KEY' }); continue; }
      const val = formatValue(String(raw), f.format); // reshape in-tool (date/phone/rrn/…)
      if (f.placeholder != null) values[f.placeholder] = val;
      else if (f.table != null && f.row != null && f.col != null) operations.push({ type: 'set_cell_text', table: f.table, row: f.row, col: f.col, text: val });
      else refuse(`.hwpx field '${f.key}' needs 'placeholder' OR 'table'+'row'+'col' (label+offset is .hwp-only)`);
      attempted.push({ field: name, key: f.key, chars: val.length, ...(f.format ? { format: f.format } : {}) });
    }
    if (Object.keys(values).length) operations.unshift({ type: 'fill_template', values });
    const res = spawnSync('node', [HWPX_EDIT], { input: JSON.stringify({ path: template, output: out, operations }), encoding: 'utf8', maxBuffer: 1 << 26 });
    let ok = false, message = null;
    try { const o = JSON.parse(res.stdout) || {}; ok = o.ok === true; message = o.error ?? null; } catch {}
    console.log(JSON.stringify({
      out, engine: 'hwpx-edit.js', engine_ok: ok,
      ...(ok ? { filled: attempted } : { engine_message: message, attempted: attempted.map((a) => a.field) }),
      missing_keys: missing,
      note: 'values never printed; hwpx-edit stdout result body (counts only) dropped',
    }, null, 2));
    if (!ok) process.exit(2);
    return;
  }

  // ── HWP engine: create.js raw-patch (set_cell_text_by_label) ─────────────
  copyFileSync(template, out);
  const operations = [];
  for (const f of mapping.fields) {
    const raw = profile[f.key];
    if (raw == null || raw === '') { missing.push(f.key); attempted.push({ field: f.label, key: f.key, status: 'EMPTY_KEY' }); continue; }
    const val = formatValue(String(raw), f.format); // reshape per-field (date/phone/rrn/…), in-tool
    operations.push({ type: 'set_cell_text_by_label', label: f.label, text: val, col_offset: f.col_offset ?? 0, row_offset: f.row_offset ?? 0 });
    attempted.push({ field: f.label, key: f.key, chars: val.length, ...(f.format ? { format: f.format } : {}) });
  }
  const res = spawnSync('node', [CREATE], { input: JSON.stringify({ path: out, operations }), encoding: 'utf8', maxBuffer: 1 << 26 });
  let status = 'parse_error', message = null;
  try { const o = JSON.parse(res.stdout) || {}; status = o.status ?? 'unknown'; message = o.message ?? null; } catch {}
  const ok = status === 'ok' || status === 'success';
  console.log(JSON.stringify({
    out, engine_status: status,
    ...(ok ? { filled: attempted } : { engine_message: message, attempted: attempted.map((a) => a.field) }),
    missing_keys: missing,
    note: 'values never printed; create.js stdout .log array (not a file) dropped',
  }, null, 2));
  if (!ok) process.exit(2);
}

function cmdVerify(args) {
  const mapping = JSON.parse(readFileSync(args.map, 'utf8'));
  // ── HWPX verify (HWPX-track slice) ───────────────────────────────────────
  // --with-cell-text is .hwp-only (rhwp getCellInfo sweep), so for .hwpx we read
  // the rendered text once and report masked FILLED/EMPTY: a `placeholder` field
  // is FILLED when its blank text is gone; a positional field is checked by the
  // value never being shown (only presence). Values stay masked.
  if (path.extname(String(args.out)).toLowerCase() === '.hwpx') {
    const res = spawnSync('node', [EXTRACT, '--format', 'markdown', args.out], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const text = res.stdout || '';
    const verified = mapping.fields.map((f) => {
      if (f.placeholder != null) return { field: f.placeholder, status: text.includes(f.placeholder) ? 'EMPTY' : 'FILLED' };
      return { field: `cell[${f.table},${f.row},${f.col}]`, status: 'POSITIONAL', note: 'positional cell — open in 한컴 to confirm' };
    });
    console.log(JSON.stringify({ verified, note: 'values masked; .hwpx placeholder presence check' }, null, 2));
    return;
  }
  const res = spawnSync('node', [EXTRACT, '--inspect', '--with-cell-text', args.out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const root = JSON.parse(res.stdout);
  const tables = Array.isArray(root) ? root : (root.tables || []);
  const findLabel = (s) => { for (const t of tables) for (const c of t.cells) if ((c.text || '').includes(s)) return c; return null; };
  const findCell = (r, c2) => { for (const t of tables) for (const c of t.cells) if (c.row === r && c.col === c2) return c; return null; };
  const verified = [];
  for (const f of mapping.fields) {
    const lab = findLabel(f.label);
    if (!lab) { verified.push({ field: f.label, status: 'LABEL_NOT_FOUND' }); continue; }
    const cell = findCell(lab.row + (f.row_offset ?? 0), lab.col + (f.col_offset ?? 0));
    const txt = cell ? (cell.text || '') : '';
    verified.push({ field: f.label, status: txt.length ? 'FILLED' : 'EMPTY', chars: txt.length, masked: '•'.repeat(Math.min(txt.length, 16)) });
  }
  console.log(JSON.stringify({ verified, note: 'values masked' }, null, 2));
}

function cmdStash(args) {
  const env = envInfo();
  if (env.likely_sandbox) {
    console.log(JSON.stringify({ error: 'REFUSED', reason: 'sandbox/remote env — cannot persist PII to a machine that is not the user\'s. Deliver the file back to the user instead.' }, null, 2));
    process.exit(3);
  }
  if (!existsSync(PERSIST_DIR)) mkdirSync(PERSIST_DIR, { recursive: true });
  copyFileSync(args.from, PERSIST_FILE);
  try { chmodSync(PERSIST_FILE, 0o600); } catch {}
  try { unlinkSync(args.from); } catch {}
  console.log(JSON.stringify({ stashed: PERSIST_FILE, perms: '600', source_removed: args.from, warning: '평문 PII. 중고판매·동기화 주의. 삭제하려면 secure-fill shred 사용.' }, null, 2));
}

function cmdShred(p) {
  try {
    const sz = statSync(p).size;
    writeFileSync(p, Buffer.alloc(sz, 0)); // overwrite once
  } catch {}
  try { unlinkSync(p); } catch {}
  console.log(JSON.stringify({ shredded: p }, null, 2));
}

// ── arg parse ──────────────────────────────────────────────────────────
function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'detect': cmdDetect(); break;
  case 'keys': cmdKeys(rest[0]); break;
  case 'handoff': cmdHandoff(flags(rest)); break;
  case 'template': { const f = flags(rest); cmdTemplate(rest[0], (f.keys ? String(f.keys).split(',') : []).map((s) => s.trim()).filter(Boolean)); break; }
  case 'fill': cmdFill(flags(rest)); break;
  case 'verify': cmdVerify(flags(rest)); break;
  case 'stash': cmdStash(flags(rest)); break;
  case 'shred': cmdShred(rest[0]); break;
  default:
    console.log('usage: secure-fill.mjs <detect|keys|template|fill|verify|stash|shred|handoff> ...');
    process.exit(1);
}
