#!/usr/bin/env node
// convert.js — Convert between .hwp (HWP 5.0 binary) and .hwpx (ZIP) via
// the rhwp WASM library. Output format is decided by the output file's
// extension.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function printUsage() {
  process.stderr.write(
    `Usage: convert.js <input> <output>\n` +
    `\n` +
    `Converts between .hwp (HWP 5.0 binary) and .hwpx (ZIP).\n` +
    `Output format is determined by the output file extension.\n` +
    `\n` +
    `Examples:\n` +
    `  convert.js report.hwp  report.hwpx\n` +
    `  convert.js report.hwpx report.hwp\n`
  );
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  printUsage();
  process.exit(0);
}
if (args.length !== 2) {
  printUsage();
  process.exit(2);
}

const [inputPath, outputPath] = args;
const outExt = path.extname(outputPath).toLowerCase();
if (outExt !== '.hwp' && outExt !== '.hwpx') {
  process.stderr.write(`error: output extension must be .hwp or .hwpx (got: ${outExt})\n`);
  process.exit(2);
}

const inputBytes = fs.readFileSync(inputPath);

const wasmPath = path.join(__dirname, 'node_modules', '@rhwp', 'core', 'rhwp_bg.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const rhwp = await import('@rhwp/core');
await rhwp.default({ module_or_path: wasmBytes });

const doc = new rhwp.HwpDocument(new Uint8Array(inputBytes));
let outBytes;
try {
  outBytes = outExt === '.hwpx' ? doc.exportHwpx() : doc.exportHwp();
} finally {
  if (typeof doc.free === 'function') doc.free();
}

fs.writeFileSync(outputPath, outBytes);
process.stderr.write(`wrote ${outputPath} (${outBytes.length.toLocaleString()} bytes)\n`);
