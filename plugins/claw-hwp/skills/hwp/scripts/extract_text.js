#!/usr/bin/env node
// extract_text.js — Read text or metadata from .hwp / .hwpx files.
//
// Default mode prints plain text (one paragraph per line). Use --format
// markdown to preserve table structure, or --inspect for a JSON metadata
// summary.
//
// HWPX inputs are read directly (zip + XML). HWP 5.0 binary inputs are
// converted to HWPX in-memory via @rhwp/core (no LibreOffice needed).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { unzipSync, strFromU8 } from './vendor/fflate/index.mjs';
import { dumpTables } from './cell-inspect.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function printUsage() {
  process.stderr.write(
    `Usage: extract_text.js [--format text|markdown] [--inspect] <file.hwp|file.hwpx>\n` +
    `\n` +
    `  --format text       (default) plain text, one paragraph per line\n` +
    `  --format markdown   structured markdown (preserves tables)\n` +
    `  --inspect           emit JSON metadata only\n` +
    `  --with-cell-text    with --inspect on a .hwp: also dump every table's\n` +
    `                      cells (row/col/text) under a "tables" field\n` +
    `  -h, --help          show this message\n`
  );
}

function parseArgs(argv) {
  const opts = { format: 'text', inspect: false, withCellText: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') {
      const v = argv[++i];
      if (v !== 'text' && v !== 'markdown') {
        throw new Error(`Unknown format: ${v}. Use 'text' or 'markdown'.`);
      }
      opts.format = v;
    } else if (a === '--inspect') {
      opts.inspect = true;
    } else if (a === '--with-cell-text') {
      opts.withCellText = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (!opts.input) {
      opts.input = a;
    } else {
      throw new Error('Multiple input files not supported');
    }
  }
  return opts;
}

// process.stdout.write() is ASYNC for pipes — a large payload (a 100 KB+ --inspect
// JSON dump of a many-table form) followed immediately by process.exit(0) is truncated
// mid-buffer, so a downstream JSON.parse fails intermittently (only on big forms; small
// ones fit one buffer and slip through). Write synchronously to fd 1, looping on partial
// pipe writes and retrying EAGAIN, so the whole payload lands before we exit.
function writeOut(str) {
  const buf = Buffer.from(str, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); }
    catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
  }
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`error: ${e.message}\n\n`);
  printUsage();
  process.exit(2);
}
if (opts.help || !opts.input) {
  printUsage();
  process.exit(opts.help ? 0 : 2);
}

const inputBytes = fs.readFileSync(opts.input);
const isHwpxZip = inputBytes[0] === 0x50 && inputBytes[1] === 0x4b; // 'PK'

if (opts.withCellText && !opts.inspect) {
  process.stderr.write('note: --with-cell-text has no effect without --inspect; ignoring.\n');
}

// For --inspect on .hwp input, count tables by talking to rhwp directly
// (the getCellInfo/getTextInCell sweep) rather than via exportHwpx → hwpx-XML.
// The direct sweep yields per-table cell counts (and the --with-cell-text
// dump) in one pass and addresses cells in the original .hwp's coordinate
// space — that's what set_cell_text uses. (Historical note: older rhwp builds
// dropped tables on exportHwpx, so the hwpx-XML path reported tableCount=0 and
// convinced past sessions that table-heavy forms were empty; rhwp 0.7.x
// preserves tables, but the direct sweep is still what gives cell-level data.)
if (opts.inspect && !isHwpxZip) {
  writeOut(JSON.stringify(await inspectHwpViaRhwp(inputBytes, opts.withCellText), null, 2) + '\n');
  process.exit(0);
}

let hwpxBytes;
if (isHwpxZip) {
  hwpxBytes = inputBytes;
} else {
  hwpxBytes = await convertHwpToHwpx(inputBytes);
}

const files = unzipSync(hwpxBytes);
const sectionXmls = Object.entries(files)
  .filter(([n]) => /^Contents\/section\d+\.xml$/.test(n))
  .sort(([a], [b]) => sectionIndex(a) - sectionIndex(b))
  .map(([, b]) => strFromU8(b));

if (opts.inspect) {
  if (opts.withCellText) {
    process.stderr.write(
      'note: --with-cell-text is only available for .hwp inputs; for .hwpx, ' +
      'table cell text is included via --format markdown.\n'
    );
  }
  writeOut(JSON.stringify(inspect(sectionXmls, isHwpxZip), null, 2) + '\n');
  process.exit(0);
}

const lines = [];
for (let i = 0; i < sectionXmls.length; i++) {
  if (i > 0) lines.push('');
  if (opts.format === 'markdown') {
    extractMarkdown(sectionXmls[i], lines);
  } else {
    extractParagraphs(sectionXmls[i], lines);
  }
}
writeOut(lines.join('\n') + '\n');

// ---

// Count structure of a .hwp file by talking to rhwp directly, without
// going through the lossy exportHwpx() conversion. Mirrors the table sweep
// pattern used by create.js's enumerateTables(): walk every (section,
// paragraph, controlIdx) triple up to MAX_CONTROL_IDX=64 and ask rhwp for
// cell info. Breaking on the first non-table control would miss the table
// at ctrl=3 on Korean government form cover pages (logo at 0, checkbox at
// 1, textbox at 2, table at 3) — the exact bug we hit in 1.3.0.
async function inspectHwpViaRhwp(bytes, withCellText = false) {
  const wasmPath = path.join(__dirname, 'vendor', 'rhwp', 'rhwp_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  const rhwp = await import('./vendor/rhwp/rhwp.js');
  await rhwp.default({ module_or_path: wasmBytes });
  // rhwp's layout pass calls globalThis.measureTextWidth during inspection;
  // a cheap stub is enough for table counting.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) =>
      text.length * (parseFloat(font) || 10) * 0.55;
  }
  const doc = new rhwp.HwpDocument(new Uint8Array(bytes));
  try {
    const sectionCount = doc.getSectionCount();
    let paragraphCount = 0, tableCount = 0, cellCount = 0;
    for (let s = 0; s < sectionCount; s++) {
      const pc = doc.getParagraphCount(s);
      paragraphCount += pc;
      for (let p = 0; p < pc; p++) {
        for (let c = 0; c < 64; c++) {
          let info;
          try { info = JSON.parse(doc.getCellInfo(s, p, c, 0)); } catch { continue; }
          if (!info || typeof info.row !== 'number') continue;
          tableCount++;
          // Count cells in this table by walking until rhwp errors.
          for (let i = 0; i < 10000; i++) {
            let ci;
            try { ci = JSON.parse(doc.getCellInfo(s, p, c, i)); } catch { break; }
            if (!ci || typeof ci.row !== 'number') break;
            cellCount++;
          }
        }
      }
    }
    const result = {
      fileType: 'hwp',
      sectionCount,
      paragraphCount,
      tableCount,
      cellCount,
      imageCount: null,  // rhwp doesn't surface this directly; skip for now
    };
    // --with-cell-text: attach the full per-table cell inventory. dumpTables
    // re-walks the tables to read each cell's text (getTextInCell); the count
    // loop above only touched getCellInfo, so the text reads happen just once.
    if (withCellText) result.tables = dumpTables(doc);
    return result;
  } finally {
    if (typeof doc.free === 'function') doc.free();
  }
}

async function convertHwpToHwpx(bytes) {
  // Lazy-load rhwp only for binary .hwp inputs.
  const wasmPath = path.join(__dirname, 'vendor', 'rhwp', 'rhwp_bg.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  const rhwp = await import('./vendor/rhwp/rhwp.js');
  await rhwp.default({ module_or_path: wasmBytes });
  // exportHwpx() runs rhwp's layout pass, which calls globalThis.measureTextWidth.
  // Without this stub it throws "measureTextWidth is not a function" on any form
  // whose content triggers layout (e.g. table-heavy government forms) — so plain
  // text / markdown extraction of such .hwp files crashed and returned nothing.
  // Mirrors the stub in inspectHwpViaRhwp / create.js / cell-patch.js.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) =>
      text.length * (parseFloat(font) || 10) * 0.55;
  }
  const doc = new rhwp.HwpDocument(new Uint8Array(bytes));
  try {
    return doc.exportHwpx();
  } finally {
    if (typeof doc.free === 'function') doc.free();
  }
}

function sectionIndex(name) {
  const m = name.match(/section(\d+)\.xml/);
  return m ? parseInt(m[1], 10) : 0;
}

function inspect(sectionXmls, isHwpxZip) {
  let paragraphCount = 0, tableCount = 0, cellCount = 0, imageCount = 0;
  for (const xml of sectionXmls) {
    paragraphCount += countOpenTags(xml, 'hp:p');
    tableCount += countOpenTags(xml, 'hp:tbl');
    cellCount += countOpenTags(xml, 'hp:tc');
    imageCount += countOpenTags(xml, 'hp:pic');
  }
  return {
    fileType: isHwpxZip ? 'hwpx' : 'hwp',
    sectionCount: sectionXmls.length,
    paragraphCount,
    tableCount,
    cellCount,
    imageCount,
  };
}

function countOpenTags(xml, name) {
  // Match `<name ` (attribute follows) or `<name>` (no attrs) or `<name/>`.
  const re = new RegExp(`<${name.replace(':', '\\:')}(\\s|>|/)`, 'g');
  return (xml.match(re) || []).length;
}

function extractParagraphs(xml, lines) {
  // Split on </hp:p> to keep paragraphs as units. Cell text is included
  // because <hp:t> matches reach into <hp:tc> as well — that's fine for
  // plaintext extraction (table content is read in row-major order).
  const parts = xml.split(/<\/hp:p>/);
  for (const part of parts) {
    const text = collectText(part);
    if (text.trim()) lines.push(text);
  }
}

function extractMarkdown(xml, lines) {
  // Walk top-level tables and emit them as markdown tables. The non-table
  // remainder is processed as plaintext paragraphs.
  const tableRe = /<hp:tbl([^>]*)>([\s\S]*?)<\/hp:tbl>/g;
  let lastEnd = 0;
  let m;
  while ((m = tableRe.exec(xml)) !== null) {
    extractParagraphs(xml.slice(lastEnd, m.index), lines);
    formatMarkdownTable(m[1], m[2], lines);
    lastEnd = m.index + m[0].length;
  }
  extractParagraphs(xml.slice(lastEnd), lines);
}

function formatMarkdownTable(attrs, body, lines) {
  const rowMatches = [...body.matchAll(/<hp:tr[^>]*>([\s\S]*?)<\/hp:tr>/g)];
  const rows = rowMatches.map((rm) => {
    const cellMatches = [...rm[1].matchAll(/<hp:tc[^>]*>([\s\S]*?)<\/hp:tc>/g)];
    return cellMatches.map((cm) => {
      const cellText = collectText(cm[1]).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
      return cellText || ' ';
    });
  });
  if (rows.length === 0) return;

  // Skip tables where every cell is whitespace — almost always layout
  // spacing artifacts in HWPX, not data the user cares about.
  if (!rows.some((r) => r.some((c) => c.trim()))) return;

  const colCount = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const out = [...r];
    while (out.length < colCount) out.push(' ');
    return out;
  });

  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  lines.push('| ' + padded[0].join(' | ') + ' |');
  lines.push('| ' + padded[0].map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < padded.length; i++) {
    lines.push('| ' + padded[i].join(' | ') + ' |');
  }
  lines.push('');
}

function collectText(xml) {
  // <hp:t> can contain inline marker children (<hp:markpenBegin/>,
  // <hp:markpenEnd/>, etc.) that Hancom Docs splices around highlighted
  // text. A `[^<]*` body match stops at the first child tag and silently
  // drops the rest of the text node. Grab the whole hp:t span, then strip
  // any inner element tags before decoding.
  const matches = xml.match(/<hp:t[^>]*>[\s\S]*?<\/hp:t>/g) || [];
  return matches
    .map((s) => s.replace(/^<hp:t[^>]*>|<\/hp:t>$/g, ''))
    .map((s) => s.replace(/<[^>]+>/g, ''))
    .map(decodeXmlEntities)
    .join('');
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
