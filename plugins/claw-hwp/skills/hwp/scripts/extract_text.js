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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function printUsage() {
  process.stderr.write(
    `Usage: extract_text.js [--format text|markdown] [--inspect] <file.hwp|file.hwpx>\n` +
    `\n` +
    `  --format text       (default) plain text, one paragraph per line\n` +
    `  --format markdown   structured markdown (preserves tables)\n` +
    `  --inspect           emit JSON metadata only\n` +
    `  -h, --help          show this message\n`
  );
}

function parseArgs(argv) {
  const opts = { format: 'text', inspect: false, input: null };
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

// For --inspect on .hwp input, count tables via rhwp wasm directly. We can't
// reuse the hwpx-XML path here because rhwp.exportHwpx() drops every table,
// so an inspect that goes through the hwpx zip always reports tableCount=0
// on .hwp inputs. That made the "form has tables → use form-fill flow"
// heuristic in SKILL.md silently misfire and convinced past agent sessions
// that empty-looking forms were genuinely empty. We talk to rhwp directly.
if (opts.inspect && !isHwpxZip) {
  process.stdout.write(JSON.stringify(await inspectHwpViaRhwp(inputBytes), null, 2) + '\n');
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
  process.stdout.write(JSON.stringify(inspect(sectionXmls, isHwpxZip), null, 2) + '\n');
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
process.stdout.write(lines.join('\n') + '\n');

// ---

// Count structure of a .hwp file by talking to rhwp directly, without
// going through the lossy exportHwpx() conversion. Mirrors the table sweep
// pattern used by create.js's enumerateTables(): walk every (section,
// paragraph, controlIdx) triple up to MAX_CONTROL_IDX=64 and ask rhwp for
// cell info. Breaking on the first non-table control would miss the table
// at ctrl=3 on Korean government form cover pages (logo at 0, checkbox at
// 1, textbox at 2, table at 3) — the exact bug we hit in 1.3.0.
async function inspectHwpViaRhwp(bytes) {
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
    return {
      fileType: 'hwp',
      sectionCount,
      paragraphCount,
      tableCount,
      cellCount,
      imageCount: null,  // rhwp doesn't surface this directly; skip for now
    };
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
