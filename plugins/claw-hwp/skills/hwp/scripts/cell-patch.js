// cell-patch.js — Hancom-Docs-compatible in-place table cell editor.
//
// Why this exists: rhwp's exportHwp() emits a CFB layout (Sh33tJ5 marker,
// reordered streams) that Hancom Docs' strict cloud parser rejects with
// "문서를 열 수 없습니다." Hancom Office Desktop accepts it; Hancom Docs
// does not. Every roundtrip through rhwp.exportHwp() — including create.js
// loading an existing file just to write one cell — picks up that
// fingerprint and breaks the file for the cloud.
//
// Two-path strategy:
//
//   (1) In-place sector patch (default). Parse just enough header + FAT to
//       find the target Section's sector chain, inflate, walk HWP records,
//       patch PARA_HEADER.text_count + replace/insert PARA_TEXT, deflate
//       at higher levels until the result fits in the existing chain,
//       write back into the same sector offsets. Only the directory
//       entry's size field is changed outside that chain. Every other
//       byte stays identical to the input — no Sh33tJ5 marker added.
//
//   (2) sheetjs CFB fallback. Used only when the patched payload grows
//       past the existing chain capacity (e.g. a one-line cell becoming
//       a paragraph). sheetjs's CFB.write auto-injects a Sh33tJ5 marker
//       stream, but that does NOT block Hancom Docs — the 1.4.0 raw-
//       patch shipped this exact code and the verified KEIT form opens
//       cleanly in the cloud editor. We just don't take this path by
//       default because (1) preserves more bytes against the original.
//
// What Hancom Docs rejects is rhwp.exportHwp()'s combination of stream
// reordering, FAT layout changes, and record-framing differences, not
// the Sh33tJ5 marker by itself. Either path here is safe; (1) is just
// byte-cleaner.
//
// rhwp is still useful for *inspecting* coordinates (which paragraph holds
// which control, which cell sits at (row, col)). We only avoid it on the
// emit side.
//
// HWP 5.0 record header (LE u32): TagID(10) | Level(10) | Size(12)
//   When Size == 0xFFF, the real size follows as a separate u32.
// Relevant tags:
//   0x42 PARA_HEADER       data[0..3] = text_count (high bit = paragraph
//                          flag; preserve it, only touch low 31 bits)
//   0x43 PARA_TEXT         body = UTF-16LE chars (HWP terminator is 0x000D)
//   0x44 PARA_CHAR_SHAPE   pairs of (charPos u32, shapeId u32)
//   0x47 CTRL_HEADER       a control inside a paragraph
//   0x48 LIST_HEADER       starts a table cell (level 2 when inside table)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync, deflateRawSync, constants } from 'node:zlib';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const TAG_PARA_HEADER = 0x42;
const TAG_PARA_TEXT = 0x43;
const TAG_PARA_CHAR_SHAPE = 0x44;
const TAG_PARA_LINE_SEG = 0x45;
const TAG_CTRL_HEADER = 0x47;
const TAG_LIST_HEADER = 0x48;

const PARA_TEXT_EOP = '\r'; // HWP paragraph terminator char (U+000D)

// CFB sentinel sector values
const ENDOFCHAIN = -2;   // 0xFFFFFFFE
const FREESECT = -1;     // 0xFFFFFFFF

// ── HWP record walk ───────────────────────────────────────────────────────

function* walkRecords(raw) {
  let p = 0;
  let idx = 0;
  while (p + 4 <= raw.length) {
    const headOff = p;
    const hdr = raw.readUInt32LE(p);
    p += 4;
    const tag = hdr & 0x3FF;
    const level = (hdr >> 10) & 0x3FF;
    let size = (hdr >> 20) & 0xFFF;
    let ext = false;
    if (size === 0xFFF) {
      size = raw.readUInt32LE(p);
      p += 4;
      ext = true;
    }
    const dataOff = p;
    yield { idx, tag, level, size, headOff, dataOff, ext };
    p += size;
    idx++;
  }
}

function parseRecords(raw) {
  const out = [];
  for (const r of walkRecords(raw)) out.push(r);
  return out;
}

// ── HWP cell location ─────────────────────────────────────────────────────
//
// Given (sectionParaIdx, controlIdx, cellIndex) and the record array for a
// Section stream, find the cell paragraph record cluster. Returns:
//   { listHeaderRec, paraHeaderRec, paraTextRec | null, charShapeRec | null }
//
// We use cellIndex (flat row-major index, the same value rhwp's getCellInfo
// returns) rather than (row, col) because the LIST_HEADER body layout in
// HWP 5.0 is not fully stable — different tables encode cell metadata at
// different offsets, and parsing each variant in pure JS is fragile.
// rhwp's WASM parses them correctly, so we let it tell us the index and
// then count LIST_HEADERs at the raw level.

function locateCell(records, sectionParaIdx, controlIdx, cellIndex, cellPara = 0) {
  // Find the target paragraph header (level 0)
  let para = -1;
  let paraStart = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) {
      para++;
      if (para === sectionParaIdx) { paraStart = i; break; }
    }
  }
  if (paraStart < 0) throw new Error(`paragraph ${sectionParaIdx} not found`);

  // Find the target control inside this paragraph
  let ctrl = -1;
  let tableCtrlIdx = -1;
  for (let i = paraStart + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break; // next paragraph
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) {
      ctrl++;
      if (ctrl === controlIdx) { tableCtrlIdx = i; break; }
    }
  }
  if (tableCtrlIdx < 0) throw new Error(`control ${controlIdx} not found in paragraph ${sectionParaIdx}`);

  // Walk forward looking for LIST_HEADER (level 2) cell starts.
  // The table ends when we hit a level-0 PARA_HEADER (next paragraph) or a
  // level-1 CTRL_HEADER (next control on the same paragraph).
  let cellStartRec = -1;
  let listCount = 0;
  for (let i = tableCtrlIdx + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break;
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) break;
    if (r.tag !== TAG_LIST_HEADER || r.level !== 2) continue;
    if (listCount === cellIndex) { cellStartRec = i; break; }
    listCount++;
  }
  if (cellStartRec < 0) throw new Error(`cell index ${cellIndex} not found in table at paragraph ${sectionParaIdx} control ${controlIdx} (only ${listCount} cells seen)`);

  // Inside this cell: the cellPara-th PARA_HEADER (level 2). A cell's paragraphs
  // are level-2 PARA_HEADERs between this LIST_HEADER and the next cell's
  // LIST_HEADER (or table end at level < 2); their text/shape children are level
  // 3. cellPara 0 = the first paragraph (the common case). Higher indices target
  // later paragraphs of a multi-paragraph cell (e.g. clearing each line of a form
  // cell that holds several paragraphs of content).
  let paraHeaderRec = -1, paraSeen = -1;
  for (let i = cellStartRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_LIST_HEADER && r.level === 2) break; // next cell
    if (r.level < 2) break;                                  // back to table/section level
    if (r.tag === TAG_PARA_HEADER && r.level === 2) {
      paraSeen++;
      if (paraSeen === cellPara) { paraHeaderRec = i; break; }
    }
  }
  if (paraHeaderRec < 0) throw new Error(`cell paragraph ${cellPara} not found (cell has ${paraSeen + 1} paragraph(s))`);

  // Optional PARA_TEXT / PARA_CHAR_SHAPE / PARA_LINE_SEG that follow (level 3).
  // Also flag whether the paragraph hosts an inline object (a CTRL_HEADER child,
  // e.g. an embedded 그림/figure): its anchor char lives in PARA_TEXT, so editing
  // or clearing the text orphans the control and Hancom Docs rejects the file.
  const paraLevel = records[paraHeaderRec].level;
  let paraTextRec = null, charShapeRec = null, lineSegRec = null, hasInlineObject = false;
  for (let i = paraHeaderRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.level <= paraLevel) break; // back to cell/paragraph level
    if (r.tag === TAG_PARA_TEXT && paraTextRec === null) paraTextRec = i;
    else if (r.tag === TAG_PARA_CHAR_SHAPE && charShapeRec === null) charShapeRec = i;
    else if (r.tag === TAG_PARA_LINE_SEG && lineSegRec === null) lineSegRec = i;
    else if (r.tag === TAG_CTRL_HEADER) hasInlineObject = true;
  }
  return { listHeaderRec: cellStartRec, paraHeaderRec, paraTextRec, charShapeRec, lineSegRec, hasInlineObject };
}

// ── HWP cell patching ─────────────────────────────────────────────────────
//
// applyCellText returns the new raw Buffer with one cell's text replaced.
// We update PARA_HEADER.text_count and replace (or insert) the PARA_TEXT
// record. text_count counts the EOP terminator, so 5 chars of text → 6.

function makeParaTextRecord(text) {
  const body = Buffer.from(text + PARA_TEXT_EOP, 'utf16le');
  const size = body.length;
  // JS bitwise ops use i32. (size << 20) goes negative for size >= 2048,
  // and (0xFFF << 20) is always negative. >>> 0 reinterprets as u32 for
  // writeUInt32LE.
  if (size > 0xFFE) {
    // Extended size encoding: header size field = 0xFFF then u32 size.
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (3 << 10) | TAG_PARA_TEXT) >>> 0, 0);
    head.writeUInt32LE(size, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((size << 20) | (3 << 10) | TAG_PARA_TEXT) >>> 0, 0);
  return Buffer.concat([head, body]);
}

function applyCellText(raw, records, sectionParaIdx, controlIdx, cellIndex, text, cellPara = 0, removeObjects = false) {
  const loc = locateCell(records, sectionParaIdx, controlIdx, cellIndex, cellPara);
  if (loc.hasInlineObject && !(text === '' && removeObjects)) {
    // The paragraph hosts an inline object (e.g. an embedded 그림/figure). Rewriting
    // its PARA_TEXT drops the object's anchor char and orphans the control, which
    // Hancom Docs rejects ("문서를 열 수 없습니다"). Refuse rather than silently
    // corrupt — clear it with text:"" + clear_objects:true to remove the object too,
    // or target a text-only paragraph via cell_para.
    throw new Error(`set_cell_text: cell paragraph ${cellPara} hosts an inline object (e.g. an embedded image) — editing its text would orphan the object. Pass clear_objects:true with text:"" to remove the object, or target a text-only paragraph via cell_para.`);
  }
  const paraHeader = records[loc.paraHeaderRec];
  const oldCount = raw.readUInt32LE(paraHeader.dataOff);

  if (text === '') {
    // Empty paragraph — match HWP's native empty form: text_count = 1 and NO
    // PARA_TEXT record at all (the EOP is implicit), with CHAR_SHAPE collapsed to
    // its single run at charPos 0. Writing an explicit EOP-only PARA_TEXT, or
    // leaving multi-run char shapes whose positions now exceed the 1-char
    // paragraph, makes Hancom Docs reject the whole file ("문서를 열 수 없습니다").
    // GT: native blank-form cells have PARA_HEADER(tc=1) + CHAR_SHAPE + LINE_SEG and
    // NO PARA_TEXT. (cell-patch previously inserted a [EOP] PARA_TEXT here — the
    // bug that broke every cleared cell on the cloud viewer.)
    raw.writeUInt32LE((((oldCount & 0x80000000) >>> 0) | 1) >>> 0, paraHeader.dataOff);
    // Collapse the layout caches to their first entry so they match the now 1-char
    // (EOP-only) paragraph, then drop PARA_TEXT. Native empty cells keep CHAR_SHAPE
    // at 1 run (8 B) and LINE_SEG at 1 segment (36 B); leaving a multi-line LINE_SEG
    // or multi-run CHAR_SHAPE on a 1-char paragraph also makes Hancom reject the file.
    // Splice back-to-front (LINE_SEG → CHAR_SHAPE → PARA_TEXT) so each record's
    // original byte offset stays valid through the prior splice. Headers keep the
    // original tag+level, only the size shrinks (so a small size is non-extended).
    const recEnd = (r) => r.headOff + (r.ext ? 8 : 4) + r.size;
    // Remove inline objects first (they sit AFTER the paragraph's PARA_TEXT/CHAR_SHAPE/
    // LINE_SEG, so removing them keeps those lower offsets valid). An inline object is a
    // CTRL_HEADER at paraLevel+1 plus every deeper record under it (the gso's caption
    // paragraph, SHAPE_COMPONENT, etc.), up to the next record at paraLevel+1. Dropping
    // the anchor control chars from PARA_TEXT (below) without removing the control would
    // orphan it; removing both leaves a clean empty paragraph. (GT: handoff gso cluster.)
    if (removeObjects) {
      const paraLevel = records[loc.paraHeaderRec].level;
      const ranges = [];
      for (let i = loc.paraHeaderRec + 1; i < records.length; i++) {
        const r = records[i];
        if (r.level <= paraLevel) break;
        if (r.tag === TAG_CTRL_HEADER && r.level === paraLevel + 1) {
          let end = recEnd(r), j = i + 1;
          for (; j < records.length && records[j].level > paraLevel + 1; j++) end = recEnd(records[j]);
          ranges.push([r.headOff, end]); i = j - 1;
        }
      }
      for (const [s, e] of ranges.sort((a, b) => b[0] - a[0])) raw = Buffer.concat([raw.slice(0, s), raw.slice(e)]);
    }
    const shrinkRec = (recIdx, newSize) => {
      const r = records[recIdx]; if (r.size <= newSize) return;
      const head = Buffer.alloc(4);
      head.writeUInt32LE(((newSize << 20) | (r.level << 10) | r.tag) >>> 0, 0);
      const rLen = (r.ext ? 8 : 4) + r.size;
      raw = Buffer.concat([raw.slice(0, r.headOff), head, raw.slice(r.dataOff, r.dataOff + newSize), raw.slice(r.headOff + rLen)]);
    };
    if (loc.lineSegRec !== null) shrinkRec(loc.lineSegRec, 36); // 1 line segment
    if (loc.charShapeRec !== null) shrinkRec(loc.charShapeRec, 8); // 1 (charPos, shapeId) run
    if (loc.paraTextRec !== null) {
      const old = records[loc.paraTextRec];
      const oldLen = (old.ext ? 8 : 4) + old.size;
      raw = Buffer.concat([raw.slice(0, old.headOff), raw.slice(old.headOff + oldLen)]);
    }
    return raw;
  }

  const newTextCount = text.length + 1; // + EOP
  // Update PARA_HEADER.text_count, preserving the high-bit flag.
  const newCount = ((oldCount & 0x80000000) >>> 0) | (newTextCount >>> 0);
  raw.writeUInt32LE(newCount >>> 0, paraHeader.dataOff);

  const newRecord = makeParaTextRecord(text);

  if (loc.paraTextRec !== null) {
    // Replace existing PARA_TEXT record.
    const old = records[loc.paraTextRec];
    const oldLen = (old.ext ? 8 : 4) + old.size;
    return Buffer.concat([
      raw.slice(0, old.headOff),
      newRecord,
      raw.slice(old.headOff + oldLen),
    ]);
  }
  // Insert PARA_TEXT between PARA_HEADER (data ends at dataOff+size) and the
  // next record (PARA_CHAR_SHAPE if present, else whatever's next).
  const insertAt = paraHeader.dataOff + paraHeader.size;
  return Buffer.concat([
    raw.slice(0, insertAt),
    newRecord,
    raw.slice(insertAt),
  ]);
}

// ── CFB layout (minimal, in-place) ────────────────────────────────────────
//
// We parse only what's needed to (a) find each Section stream's chain of
// regular-FAT sectors and (b) locate the directory entry so we can update
// its size field. We never re-emit; the original buffer is mutated.
//
// HWP 5.0 .hwp files always use the regular FAT for Section streams because
// they're far larger than the mini-stream cutoff (4096 bytes). If a future
// edge case puts one in the mini-stream we throw with a clear message.

function parseCfbHeader(buf) {
  if (buf.length < 512 || buf[0] !== 0xD0 || buf[1] !== 0xCF || buf[2] !== 0x11 || buf[3] !== 0xE0) {
    throw new Error('not a CFB (Compound File Binary) container');
  }
  const mver = buf.readUInt16LE(0x1A);
  const sectorShift = buf.readUInt16LE(0x1E);
  const ssz = 1 << sectorShift;
  if (mver !== 3 && mver !== 4) throw new Error(`unsupported CFB major version: ${mver}`);
  if ((mver === 3 && ssz !== 512) || (mver === 4 && ssz !== 4096)) {
    throw new Error(`CFB sector size ${ssz} inconsistent with version ${mver}`);
  }
  const miniSectorShift = buf.readUInt16LE(0x20);
  const mssz = 1 << miniSectorShift; // typically 64 bytes
  const dirStart = buf.readInt32LE(0x30);
  const minifatStart = buf.readInt32LE(0x3C);
  const numMinifat = buf.readInt32LE(0x40);
  const difatStart = buf.readInt32LE(0x44);
  const difatCount = buf.readInt32LE(0x48);

  // Collect FAT sector indices: first 109 are in the header, the rest live
  // in DIFAT sectors chained together.
  const fatAddrs = [];
  for (let i = 0; i < 109; i++) {
    const sec = buf.readInt32LE(0x4C + i * 4);
    if (sec === FREESECT) break;
    fatAddrs.push(sec);
  }
  let difatSec = difatStart;
  let guard = 0;
  while (difatSec >= 0 && difatSec !== ENDOFCHAIN && guard++ < difatCount + 1) {
    const off = (difatSec + 1) * ssz;
    const entriesPerSec = (ssz >>> 2) - 1; // last u32 chains to next DIFAT sec
    for (let i = 0; i < entriesPerSec; i++) {
      const sec = buf.readInt32LE(off + i * 4);
      if (sec === FREESECT) break;
      fatAddrs.push(sec);
    }
    difatSec = buf.readInt32LE(off + (ssz - 4));
  }
  return { mver, ssz, mssz, dirStart, fatAddrs, minifatStart, numMinifat };
}

// Read the entire mini-FAT as a flat array. Mini-FAT sectors themselves
// live in the regular FAT (we walk that chain from minifatStart), and each
// mini-FAT sector is the usual ssz bytes packed with i32 entries that point
// to the next mini-sector index in a mini-stream's chain.
function readMinifat(buf, fat, ssz, minifatStart) {
  if (minifatStart < 0 || minifatStart === ENDOFCHAIN) return new Int32Array(0);
  const minifatSectors = walkChain(fat, minifatStart);
  const entriesPerSec = ssz >>> 2;
  const minifat = new Int32Array(minifatSectors.length * entriesPerSec);
  for (let s = 0; s < minifatSectors.length; s++) {
    const off = (minifatSectors[s] + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      minifat[s * entriesPerSec + i] = buf.readInt32LE(off + i * 4);
    }
  }
  return minifat;
}

// Mini-stream content lives inside the root entry's regular-FAT chain.
// A mini-sector index addresses a 64-byte slot inside that chain: slot N
// is at offset (rootChain[N / slotsPerSec] + 1) * ssz + (N % slotsPerSec) * mssz.
function miniSectorFileOffset(miniIdx, rootChain, ssz, mssz) {
  const slotsPerSec = ssz / mssz;
  const regSecIdx = Math.floor(miniIdx / slotsPerSec);
  const inSec = miniIdx % slotsPerSec;
  if (regSecIdx >= rootChain.length) throw new Error(`mini-sector ${miniIdx} outside root chain (${rootChain.length} regular sectors)`);
  return (rootChain[regSecIdx] + 1) * ssz + inSec * mssz;
}

function readMiniChainBytes(buf, miniChain, rootChain, ssz, mssz, size) {
  const out = Buffer.alloc(size);
  let written = 0;
  for (const mIdx of miniChain) {
    if (written >= size) break;
    const off = miniSectorFileOffset(mIdx, rootChain, ssz, mssz);
    const take = Math.min(mssz, size - written);
    buf.copy(out, written, off, off + take);
    written += take;
  }
  return out;
}

// Mirror of writeChainBytes for mini-streams. The error message is kept
// in lock-step with the regular-chain version so patchCellsInPlace's
// fallback regex catches both overflow cases identically.
function writeMiniChainBytes(buf, miniChain, rootChain, ssz, mssz, data) {
  const capacity = miniChain.length * mssz;
  if (data.length > capacity) {
    throw new Error(`mini-stream of ${data.length} bytes does not fit in ${miniChain.length} mini-sectors (${capacity} bytes). exceeds sector chain capacity.`);
  }
  let written = 0;
  for (const mIdx of miniChain) {
    const off = miniSectorFileOffset(mIdx, rootChain, ssz, mssz);
    if (written >= data.length) {
      buf.fill(0, off, off + mssz);
      continue;
    }
    const take = Math.min(mssz, data.length - written);
    data.copy(buf, off, written, written + take);
    written += take;
    if (take < mssz) {
      buf.fill(0, off + take, off + mssz);
    }
  }
}

// Read the entire FAT as a flat array of i32 entries by concatenating every
// FAT sector in order. fat[i] = next sector after i (or ENDOFCHAIN, etc).
function readFat(buf, fatAddrs, ssz) {
  const entriesPerSec = ssz >>> 2;
  const fat = new Int32Array(fatAddrs.length * entriesPerSec);
  for (let s = 0; s < fatAddrs.length; s++) {
    const sec = fatAddrs[s];
    const off = (sec + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      fat[s * entriesPerSec + i] = buf.readInt32LE(off + i * 4);
    }
  }
  return fat;
}

// Walk a sector chain in the FAT, starting at `start`.
function walkChain(fat, start) {
  const chain = [];
  let cur = start;
  while (cur >= 0 && cur !== ENDOFCHAIN) {
    chain.push(cur);
    if (chain.length > fat.length) throw new Error('FAT chain longer than total sector count (cycle?)');
    cur = fat[cur];
  }
  return chain;
}

// Slice the file bytes that belong to a sector chain, taking `size` bytes
// from the front (the rest of the last sector is allocated slack).
function readChainBytes(buf, chain, ssz, size) {
  const out = Buffer.alloc(size);
  let written = 0;
  for (const sec of chain) {
    if (written >= size) break;
    const off = (sec + 1) * ssz;
    const take = Math.min(ssz, size - written);
    buf.copy(out, written, off, off + take);
    written += take;
  }
  return out;
}

// Write `data` into the sector chain in `buf`. Requires data.length <=
// chain.length * ssz. Pads the final sector with zeros so allocated slack
// is clean — this isn't strictly required by readers, which respect the
// size field, but matches the on-disk layout other CFB tools produce.
function writeChainBytes(buf, chain, ssz, data) {
  if (data.length > chain.length * ssz) {
    throw new Error(`stream of ${data.length} bytes does not fit in ${chain.length} sectors (${chain.length * ssz} bytes). In-place patch cannot expand sector chains.`);
  }
  let written = 0;
  for (const sec of chain) {
    const off = (sec + 1) * ssz;
    if (written >= data.length) {
      buf.fill(0, off, off + ssz);
      continue;
    }
    const take = Math.min(ssz, data.length - written);
    data.copy(buf, off, written, written + take);
    written += take;
    if (take < ssz) {
      // Last data-bearing sector: zero out the slack.
      buf.fill(0, off + take, off + ssz);
    }
  }
}

// ── Sector chain expansion (Phase 3) ─────────────────────────────────────
//
// allocateAndExtendChain grows an existing FAT sector chain by N sectors
// by appending fresh sectors at the end of the file buffer and threading
// them onto the tail of the chain via FAT updates.
//
// Returns { buf, fat, chain }:
//   - buf : new Buffer (length grew by N * ssz, plus the new FAT sector
//           if we needed to allocate one)
//   - fat : same Int32Array reference, mutated entries written; may be a
//           new (longer) Int32Array if a new FAT sector was required
//   - chain : the original chain with the new sector indices appended
//
// The original buf/fat are NOT mutated — caller must take the return
// values. (We can't grow Buffer in place; Int32Array we could mutate but
// the symmetric API is simpler.)
//
// FAT capacity: each FAT sector holds ssz/4 entries (128 for v3). If the
// chain extension needs sector indices past the current FAT capacity, we
// allocate a new FAT sector. That itself is a new sector in the file;
// the DIFAT (header slots 0x4C..0xFF, 109 entries) registers it. Going
// past 109 FAT sectors requires DIFAT chain extension — we don't
// implement that yet and throw with a clear message. HWP forms are tiny
// enough that 109 FAT sectors (= 55MB of streams at ssz=512) is well
// beyond any real document.
function writeFatEntry(buf, ssz, fatAddrs, secIdx, value) {
  const entriesPerSec = ssz >>> 2;
  const fatSecIdx = Math.floor(secIdx / entriesPerSec);
  const offsetInSec = secIdx % entriesPerSec;
  if (fatSecIdx >= fatAddrs.length) {
    throw new Error(`writeFatEntry: sector ${secIdx} outside current FAT capacity (${fatAddrs.length} FAT sectors); call expandFatCapacity first`);
  }
  const fileOff = (fatAddrs[fatSecIdx] + 1) * ssz + offsetInSec * 4;
  buf.writeInt32LE(value, fileOff);
}

// Append a fresh empty sector to the end of buf. Returns { buf, newSecIdx }.
// The new sector's bytes are zero-initialized. FAT entry is NOT touched —
// caller is responsible for marking it (ENDOFCHAIN for a fresh tail,
// FATSECT for a new FAT sector, etc).
function appendBlankSector(buf, ssz) {
  if (buf.length % ssz !== 0) {
    throw new Error(`buf length ${buf.length} is not a multiple of sector size ${ssz}`);
  }
  const newSecIdx = (buf.length / ssz) - 1; // header sits at -1, first sector at 0
  const newBuf = Buffer.alloc(buf.length + ssz);
  buf.copy(newBuf);
  return { buf: newBuf, newSecIdx };
}

// Ensure the FAT can address at least `requiredCapacity` sectors. Grows
// the FAT by allocating additional FAT sectors at the end of the file
// when needed, registers them in the header's DIFAT slots, and extends
// the in-memory `fat` Int32Array.
function expandFatCapacity(buf, ssz, fat, fatAddrs, requiredCapacity) {
  const entriesPerSec = ssz >>> 2;
  while (fat.length < requiredCapacity) {
    if (fatAddrs.length >= 109) {
      throw new Error('FAT capacity exhausted: DIFAT chain extension beyond 109 slots not yet implemented (file is unusually large for an HWP document)');
    }
    // Allocate a new sector that will hold the next FAT page.
    let result = appendBlankSector(buf, ssz);
    buf = result.buf;
    const newFatSecIdx = result.newSecIdx;
    // Initialize all entries to FREESECT, then mark this sector's own
    // entry as FATSECT.
    const newFatSecOff = (newFatSecIdx + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      buf.writeInt32LE(FREESECT, newFatSecOff + i * 4);
    }
    // Extend the in-memory fat. Old fat[0..fat.length] preserved; new
    // entries FREESECT except newFatSecIdx which is FATSECT (-3).
    const oldLen = fat.length;
    const newFat = new Int32Array(oldLen + entriesPerSec);
    newFat.set(fat);
    for (let i = oldLen; i < newFat.length; i++) newFat[i] = FREESECT;
    newFat[newFatSecIdx] = -3; // FATSECT
    // The on-disk entry for newFatSecIdx (now FATSECT) lives in *this* new
    // FAT sector; write it accordingly.
    const idxInNewFat = newFatSecIdx - oldLen;
    buf.writeInt32LE(-3, newFatSecOff + idxInNewFat * 4);
    // Register in DIFAT slot (header 0x4C + slot*4 for slots 0..108).
    buf.writeInt32LE(newFatSecIdx, 0x4C + fatAddrs.length * 4);
    fatAddrs.push(newFatSecIdx);
    // Update the FAT-sector count field (header 0x2C, u32 little-endian).
    buf.writeUInt32LE(fatAddrs.length, 0x2C);
    fat = newFat;
  }
  return { buf, fat };
}

// Extend `chain` (a sector-index array) by `additionalSectors` new
// sectors. Returns { buf, fat, chain } as described above.
function extendFatChain(buf, ssz, fat, fatAddrs, chain, additionalSectors) {
  if (additionalSectors <= 0) return { buf, fat, chain };
  let currentBuf = buf;
  let currentFat = fat;
  let lastSec = chain[chain.length - 1];
  const newChain = [...chain];
  for (let i = 0; i < additionalSectors; i++) {
    // Make sure FAT can index one more sector beyond what we're about to
    // allocate. The new sector will sit at idx = (currentBuf.length/ssz)-1
    // AFTER appendBlankSector, so we need capacity for that idx + 1.
    const projectedNewSecIdx = currentBuf.length / ssz - 1 + 1; // +1 for the slot we'll fill
    const exp = expandFatCapacity(currentBuf, ssz, currentFat, fatAddrs, projectedNewSecIdx + 1);
    currentBuf = exp.buf;
    currentFat = exp.fat;
    // Now actually allocate the new sector.
    const alloc = appendBlankSector(currentBuf, ssz);
    currentBuf = alloc.buf;
    const newSecIdx = alloc.newSecIdx;
    // FAT updates: link the chain tail to the new sector, mark new sector
    // as ENDOFCHAIN.
    writeFatEntry(currentBuf, ssz, fatAddrs, lastSec, newSecIdx);
    writeFatEntry(currentBuf, ssz, fatAddrs, newSecIdx, ENDOFCHAIN);
    currentFat[lastSec] = newSecIdx;
    currentFat[newSecIdx] = ENDOFCHAIN;
    newChain.push(newSecIdx);
    lastSec = newSecIdx;
  }
  return { buf: currentBuf, fat: currentFat, chain: newChain };
}

// ── Mini-FAT / mini-stream expansion (Phase 3b) ───────────────────────────
//
// Mini-streams in CFB sit inside the root entry's regular-FAT chain, cut
// into mini-sectors (typically 64 bytes). The mini-FAT (a regular stream
// whose FAT chain starts at header offset 0x3C) holds next-pointers for
// each mini-sector — same shape as the FAT, just for the 64-byte slots.
//
// Extending a mini-stream means:
//   (1) make sure the mini-FAT can index one more mini-sector
//   (2) make sure the root chain can hold one more mini-sector worth of
//       bytes (if not, extend the root chain via extendFatChain — that's
//       a regular-FAT chain underneath)
//   (3) write the new mini-FAT entry (chain tail → new idx, new idx →
//       ENDOFCHAIN)
//   (4) bump the root entry's size field (number of allocated mini bytes)
//   (5) bump the mini-FAT sector count at header 0x40
//
// We don't yet promote a mini-stream to the regular FAT — that's a
// separate Phase 3b-2. For now mini-stream extension is the natural
// path when the patched Section stays under the 4096-byte mini-stream
// cutoff but the existing chain ran out of room.

function writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, miniIdx, value) {
  // Mini-FAT sectors are regular sectors strung together via a regular-
  // FAT chain starting at minifatStart. miniIdx addresses entries
  // across that concatenation: each regular sector holds ssz/4 entries
  // (128 for v3). We walk the chain to find which sector and offset
  // within it.
  const entriesPerSec = ssz >>> 2;
  const sectorIdxInChain = Math.floor(miniIdx / entriesPerSec);
  const offsetInSector = miniIdx % entriesPerSec;
  const minifatChain = walkChain(fat, minifatStart);
  if (sectorIdxInChain >= minifatChain.length) {
    throw new Error(`writeMinifatEntry: idx ${miniIdx} outside mini-FAT (${minifatChain.length} sectors); call expandMinifatCapacity first`);
  }
  const fatSec = minifatChain[sectorIdxInChain];
  const fileOff = (fatSec + 1) * ssz + offsetInSector * 4;
  buf.writeInt32LE(value, fileOff);
}

// Make sure the mini-FAT has enough capacity to address `requiredCapacity`
// mini-sectors. Allocates new regular sectors and links them into the
// mini-FAT chain (header 0x3C onwards). Each added mini-FAT sector adds
// ssz/4 = 128 entries (v3).
function expandMinifatCapacity(buf, ssz, fat, fatAddrs, minifat, minifatStart, requiredCapacity) {
  const entriesPerSec = ssz >>> 2;
  let currentBuf = buf;
  let currentFat = fat;
  let currentMinifat = minifat;
  let currentMinifatStart = minifatStart;
  while (currentMinifat.length < requiredCapacity) {
    // Allocate a fresh regular sector for the mini-FAT page. Make sure
    // the regular FAT can index it first.
    const projectedSecIdx = currentBuf.length / ssz - 1 + 1;
    const exp = expandFatCapacity(currentBuf, ssz, currentFat, fatAddrs, projectedSecIdx + 1);
    currentBuf = exp.buf;
    currentFat = exp.fat;
    const alloc = appendBlankSector(currentBuf, ssz);
    currentBuf = alloc.buf;
    const newSec = alloc.newSecIdx;
    // Initialize all entries in the new mini-FAT sector to FREESECT.
    const newSecOff = (newSec + 1) * ssz;
    for (let i = 0; i < entriesPerSec; i++) {
      currentBuf.writeInt32LE(FREESECT, newSecOff + i * 4);
    }
    // Mark the new mini-FAT sector as ENDOFCHAIN in regular FAT, then
    // link it onto the mini-FAT regular-FAT chain.
    writeFatEntry(currentBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
    currentFat[newSec] = ENDOFCHAIN;
    if (currentMinifatStart < 0 || currentMinifatStart === ENDOFCHAIN) {
      // No mini-FAT existed yet — point the header at this new sector.
      currentMinifatStart = newSec;
      currentBuf.writeInt32LE(newSec, 0x3C);
    } else {
      // Walk to the tail of the mini-FAT chain and link.
      const minifatChain = walkChain(currentFat, currentMinifatStart);
      const tail = minifatChain[minifatChain.length - 1];
      writeFatEntry(currentBuf, ssz, fatAddrs, tail, newSec);
      currentFat[tail] = newSec;
    }
    // Bump mini-FAT sector count at header 0x40.
    const newMinifatSecCount = walkChain(currentFat, currentMinifatStart).length;
    currentBuf.writeUInt32LE(newMinifatSecCount, 0x40);
    // Grow in-memory minifat array.
    const newMinifat = new Int32Array(currentMinifat.length + entriesPerSec);
    newMinifat.set(currentMinifat);
    for (let i = currentMinifat.length; i < newMinifat.length; i++) newMinifat[i] = FREESECT;
    currentMinifat = newMinifat;
  }
  return { buf: currentBuf, fat: currentFat, minifat: currentMinifat, minifatStart: currentMinifatStart };
}

// Make sure the root mini-stream chain has room for `requiredMiniSectors`
// mini-sectors (i.e. `requiredMiniSectors * mssz` bytes). Each regular
// sector in the root chain holds ssz/mssz mini-sector slots; if the
// existing root chain is too short, extend it via extendFatChain.
// Returns { buf, fat, rootChain, rootEntrySize }.
function ensureRootChainForMiniSectors(buf, ssz, mssz, fat, fatAddrs, rootChain, requiredMiniSectors) {
  const slotsPerSec = ssz / mssz;
  const currentSlots = rootChain.length * slotsPerSec;
  if (requiredMiniSectors <= currentSlots) {
    return { buf, fat, rootChain, addedRegularSectors: 0 };
  }
  const additionalRegularSectors = Math.ceil((requiredMiniSectors - currentSlots) / slotsPerSec);
  const ext = extendFatChain(buf, ssz, fat, fatAddrs, rootChain, additionalRegularSectors);
  return { buf: ext.buf, fat: ext.fat, rootChain: ext.chain, addedRegularSectors: additionalRegularSectors };
}

// Extend a mini-stream's mini-FAT chain by `additionalMiniSectors`.
// Handles all four steps: mini-FAT capacity, root chain capacity,
// mini-FAT entry writes, and the root entry's mini-stream-size field.
// Returns { buf, fat, minifat, minifatStart, rootChain, miniChain }.
function extendMinifatChain(ctx, miniChain, additionalMiniSectors) {
  if (additionalMiniSectors <= 0) return { ...ctx, miniChain };
  let { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry } = ctx;
  const slotsPerSec = ssz / mssz;
  // Figure out the highest mini-sector index we'll need to address.
  // We pick free entries from the mini-FAT (FREESECT == -1); if there
  // aren't enough, we append to the tail by indexing past the current
  // mini-FAT length (after expanding capacity).
  let lastMini = miniChain[miniChain.length - 1];
  const newChain = [...miniChain];
  for (let i = 0; i < additionalMiniSectors; i++) {
    // Look for an existing FREESECT slot in the mini-FAT first.
    let newMini = -1;
    for (let m = 0; m < minifat.length; m++) {
      if (minifat[m] === FREESECT) { newMini = m; break; }
    }
    if (newMini === -1) {
      // No free slot; the next idx past the current capacity.
      newMini = minifat.length;
    }
    // Make sure mini-FAT can index newMini.
    const mfExp = expandMinifatCapacity(buf, ssz, fat, fatAddrs, minifat, minifatStart, newMini + 1);
    buf = mfExp.buf;
    fat = mfExp.fat;
    minifat = mfExp.minifat;
    minifatStart = mfExp.minifatStart;
    // Make sure the root chain has bytes for mini-sector newMini.
    const rcExp = ensureRootChainForMiniSectors(buf, ssz, mssz, fat, fatAddrs, rootChain, newMini + 1);
    buf = rcExp.buf;
    fat = rcExp.fat;
    rootChain = rcExp.rootChain;
    // Zero out the new mini-sector bytes (only on first-time use; if
    // we're reusing a FREESECT slot, the underlying bytes might be old
    // tombstones, which is fine for a stream that will get overwritten
    // by writeMiniChainBytes anyway).
    const miniOff = miniSectorFileOffset(newMini, rootChain, ssz, mssz);
    buf.fill(0, miniOff, miniOff + mssz);
    // Link in the mini-FAT: prev tail → newMini, newMini → ENDOFCHAIN.
    writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, lastMini, newMini);
    writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, newMini, ENDOFCHAIN);
    minifat[lastMini] = newMini;
    minifat[newMini] = ENDOFCHAIN;
    newChain.push(newMini);
    lastMini = newMini;
  }
  // Bump the root entry's size field if our highest used mini-sector
  // goes past what the root chain previously advertised. Root.size in
  // CFB v3 holds the mini-stream's total byte length.
  const highestMini = Math.max(...newChain);
  const minBytesNeeded = (highestMini + 1) * mssz;
  const oldRootSize = buf.readUInt32LE(rootEntry.entryFileOffset + 0x78);
  if (minBytesNeeded > oldRootSize) {
    buf.writeUInt32LE(minBytesNeeded, rootEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, rootEntry.entryFileOffset + 0x7C);
  }
  return { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry, miniChain: newChain };
}

// Parse the directory entry chain into a list of records. For each entry
// we record the *file offset* of its 128-byte slot so we can mutate the
// size field later without re-emitting anything. Returns:
//   { entries: [{name, type, child, leftSibling, rightSibling, start, size,
//                 entryFileOffset}], dirChain }
function readDirectory(buf, fat, ssz, dirStart) {
  const dirChain = walkChain(fat, dirStart);
  const slotsPerSector = ssz >>> 7; // 128 bytes per entry
  const entries = [];
  for (let s = 0; s < dirChain.length; s++) {
    const sectorFileOff = (dirChain[s] + 1) * ssz;
    for (let i = 0; i < slotsPerSector; i++) {
      const entryFileOffset = sectorFileOff + i * 128;
      const namelen = buf.readUInt16LE(entryFileOffset + 0x40);
      const type = buf.readUInt8(entryFileOffset + 0x42);
      // Skip unused entries (type 0) but keep their slot index for indexing.
      let name = '';
      if (namelen > 0) {
        const nameBytes = buf.slice(entryFileOffset, entryFileOffset + Math.max(0, namelen - 2));
        name = nameBytes.toString('utf16le');
      }
      const leftSibling = buf.readInt32LE(entryFileOffset + 0x44);
      const rightSibling = buf.readInt32LE(entryFileOffset + 0x48);
      const child = buf.readInt32LE(entryFileOffset + 0x4C);
      const start = buf.readInt32LE(entryFileOffset + 0x74);
      const size = buf.readUInt32LE(entryFileOffset + 0x78);
      entries.push({
        name, type, leftSibling, rightSibling, child, start, size,
        entryFileOffset,
      });
    }
  }
  return { entries, dirChain };
}

// Find a stream by hierarchical path like "BodyText/Section0". We walk the
// red-black tree rooted at each storage's child to find the entry by name.
function findStreamEntry(entries, pathParts) {
  // Root entry is always at index 0 with type 5.
  let cur = entries[0];
  for (const part of pathParts) {
    // Children of `cur` are reachable via cur.child as a binary tree root.
    // Each tree node has leftSibling / rightSibling pointers to other
    // entries at the same level. Names are compared case-insensitively per
    // CFB rules, but for our use everything is ASCII so we can use exact
    // match.
    let node = cur.child >= 0 ? entries[cur.child] : null;
    let found = null;
    const queue = node ? [node] : [];
    const visited = new Set();
    while (queue.length && !found) {
      const n = queue.shift();
      if (visited.has(n.entryFileOffset)) continue;
      visited.add(n.entryFileOffset);
      if (n.name === part) { found = n; break; }
      if (n.leftSibling >= 0) queue.push(entries[n.leftSibling]);
      if (n.rightSibling >= 0) queue.push(entries[n.rightSibling]);
    }
    if (!found) throw new Error(`CFB directory entry not found: ${pathParts.join('/')} (looking for "${part}" inside "${cur.name}")`);
    cur = found;
  }
  return cur;
}

// ── Public entry ──────────────────────────────────────────────────────────
//
// patchCellsInPlace(filePath, edits) edits = [{ section, para, control, row, col, text }, ...]
// Mutates the file at filePath. Returns a summary array.

// Resolve (section, para, control, row, col) → cellIndex via rhwp inspect.
// We open the doc, walk getCellInfo until we find the matching (row, col),
// then immediately discard the doc — rhwp is never used to write bytes.
async function resolveCellIndexes(filePath, edits) {
  // Windows: a bare `${__dirname}/…` string is parsed by the ESM loader as a
  // URL whose scheme is the drive letter ("c:") and rejected. pathToFileURL
  // yields a valid file:// URL on every platform (no-op shape change on POSIX).
  const rhwp = await import(url.pathToFileURL(path.join(__dirname, 'vendor/rhwp/rhwp.js')).href);
  await rhwp.default({
    module_or_path: readFileSync(`${__dirname}/vendor/rhwp/rhwp_bg.wasm`),
  });
  // rhwp's text-layout pass calls globalThis.measureTextWidth; supply a
  // cheap stub so we can construct the document for inspection only.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) =>
      text.length * (parseFloat(font) || 10) * 0.55;
  }
  const doc = new rhwp.HwpDocument(new Uint8Array(readFileSync(filePath)));
  try {
    return edits.map((e) => {
      // If the caller already passed a cellIndex, trust it.
      if (Number.isInteger(e.cellIndex)) {
        return { ...e, cellIndex: e.cellIndex };
      }
      const sec = e.section ?? 0;
      const para = e.para ?? 0;
      const ctrl = e.control ?? 0;
      // Walk cells until we find (row, col). Tables are bounded; 10k is a
      // safe ceiling well above any real form.
      for (let i = 0; i < 10000; i++) {
        let info;
        try { info = JSON.parse(doc.getCellInfo(sec, para, ctrl, i)); }
        catch { break; }
        if (!info || typeof info.row !== 'number') break;
        if (info.row === e.row && info.col === e.col) {
          return { ...e, cellIndex: i };
        }
      }
      throw new Error(`cell (row=${e.row}, col=${e.col}) not found via rhwp at sec=${sec} para=${para} ctrl=${ctrl}`);
    });
  } finally {
    try { doc.free(); } catch { /* ignore */ }
  }
}

// Try deflating at successively higher levels to find one that fits within
// `capacity` bytes. We start at the default (6) because for typical HWP
// content it matches the original size well; if the patched content grew,
// stronger compression usually claws back the difference.
function deflateToFit(data, capacity) {
  // Level 9 (max compression) first — NOT the zlib default (6). Hancom's HWP
  // inflater rejects some valid level-6 bitstreams (content-dependent: the file
  // opens nowhere, "손상/형식 오류"), while the same content deflated at level 9
  // opens — and level 9 is what rhwp / Hancom themselves emit. Level 9 is also
  // the smallest, so it fits whenever any lower level would. (GT-confirmed
  // 2026-06-18: a table-row insert produced byte-identical records + CFB to an
  // rhwp-valid file, differing ONLY in the Section0 deflate; level 9 fixed it.)
  const levels = [9, 8, 7, constants.Z_DEFAULT_COMPRESSION];
  let best = null;
  for (const level of levels) {
    const out = deflateRawSync(data, { level });
    if (out.length <= capacity) return out;
    if (!best || out.length < best.length) best = out;
  }
  throw new Error(`deflated payload (${best.length} bytes, best of attempted levels) exceeds sector chain capacity (${capacity} bytes). Patch cannot expand sectors in-place; refusing to overflow.`);
}

// Allocate a fresh regular-FAT chain of N sectors at the end of the file.
// Threads them together in the FAT, returns { buf, fat, chain }.
function allocateRegularChain(buf, ssz, fat, fatAddrs, sectorCount) {
  let workBuf = buf;
  let workFat = fat;
  const chain = [];
  for (let i = 0; i < sectorCount; i++) {
    const projectedIdx = workBuf.length / ssz - 1 + 1;
    const exp = expandFatCapacity(workBuf, ssz, workFat, fatAddrs, projectedIdx + 1);
    workBuf = exp.buf;
    workFat = exp.fat;
    const alloc = appendBlankSector(workBuf, ssz);
    workBuf = alloc.buf;
    const newSec = alloc.newSecIdx;
    if (chain.length === 0) {
      writeFatEntry(workBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
      workFat[newSec] = ENDOFCHAIN;
    } else {
      const prev = chain[chain.length - 1];
      writeFatEntry(workBuf, ssz, fatAddrs, prev, newSec);
      writeFatEntry(workBuf, ssz, fatAddrs, newSec, ENDOFCHAIN);
      workFat[prev] = newSec;
      workFat[newSec] = ENDOFCHAIN;
    }
    chain.push(newSec);
  }
  return { buf: workBuf, fat: workFat, chain };
}

// Phase 3b helper for mini-stream Sections. Mirrors
// deflateAndFitWithExpansion but works through mini-FAT / root-chain
// machinery. Two outcomes for an overflow:
//   - patched payload still fits under 4096 bytes (the mini-stream
//     cutoff) → extend the mini-FAT chain via extendMinifatChain
//   - patched payload would be >= 4096 bytes → promote to the regular
//     FAT (allocate a new chain, free the old mini-sectors, signal the
//     caller via `promoted: true` so it updates dir entry start/size)
function deflateMiniChainWithExpansion(ctx, raw, miniChain) {
  const { ssz, mssz, minifatStart, fatAddrs, rootChain, rootEntry } = ctx;
  let { buf, fat, minifat } = ctx;
  const capacity = miniChain.length * mssz;
  try {
    const compressed = deflateToFit(raw, capacity);
    return { ...ctx, miniChain, compressed, promoted: false };
  } catch (err) {
    if (!/exceeds sector chain capacity/.test(err.message)) throw err;
    const minimal = deflateRawSync(raw, { level: 9 });

    if (minimal.length >= 4096) {
      // ── Promotion: mini-stream → regular FAT ────────────────────────
      const neededSectors = Math.ceil(minimal.length / ssz);
      const alloc = allocateRegularChain(buf, ssz, fat, fatAddrs, neededSectors);
      buf = alloc.buf;
      fat = alloc.fat;
      const newChain = alloc.chain;
      // Release the old mini-sector chain (each entry → FREESECT).
      for (const miniIdx of miniChain) {
        writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, miniIdx, FREESECT);
        minifat[miniIdx] = FREESECT;
      }
      const compressed = deflateToFit(raw, newChain.length * ssz);
      return {
        buf, fat, fatAddrs, minifat, minifatStart, ssz, mssz, rootChain, rootEntry,
        newRegularChain: newChain, compressed, promoted: true,
      };
    }

    // ── Mini-FAT chain extension (stays in mini-stream) ──────────────
    const neededMiniSectors = Math.ceil(minimal.length / mssz);
    const additionalMiniSectors = neededMiniSectors - miniChain.length;
    const ext = extendMinifatChain(ctx, miniChain, additionalMiniSectors);
    const newCapacity = ext.miniChain.length * mssz;
    const compressed = deflateToFit(raw, newCapacity);
    return { ...ext, compressed, promoted: false };
  }
}

// Phase 3 helper: try deflateToFit; if it overflows, extend the FAT chain
// (regular FAT only) and retry. Returns { buf, fat, chain, compressed }.
// For mini-stream chains, use deflateMiniChainWithExpansion above.
function deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, inMiniStream) {
  try {
    const compressed = deflateToFit(raw, capacity);
    return { buf, fat, chain, capacity, compressed };
  } catch (err) {
    if (!/exceeds sector chain capacity/.test(err.message)) throw err;
    if (inMiniStream) throw err;
    // Estimate worst-case deflated size at max level and allocate enough
    // extra sectors to hold it. deflateRawSync at level 9 is the best
    // case we can produce; if even that exceeds chain*ssz we know how
    // many sectors short we are.
    const minimal = deflateRawSync(raw, { level: 9 });
    const neededSectors = Math.ceil(minimal.length / ssz);
    const additionalSectors = neededSectors - chain.length;
    if (additionalSectors <= 0) throw err;
    const ext = extendFatChain(buf, ssz, fat, fatAddrs, chain, additionalSectors);
    const newCapacity = ext.chain.length * ssz;
    const compressed = deflateToFit(raw, newCapacity);
    return { buf: ext.buf, fat: ext.fat, chain: ext.chain, capacity: newCapacity, compressed };
  }
}

// In-place sector patch. Throws when the patched payload doesn't fit in the
// existing sector chain (the caller falls back to patchViaSheetjs). The file
// on disk is only touched at the very end via writeFileSync, so a mid-edit
// overflow leaves the file untouched and a fallback can start clean.
function patchInPlaceSectors(filePath, resolved) {
  // buf/fat/minifat/minifatStart/rootChain are all `let` because Phase 3's
  // regular-FAT expansion and Phase 3b's mini-FAT expansion can each
  // produce longer buffers / new in-memory structures.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  // The mini-stream content lives in the root storage entry's regular-FAT
  // chain. We lazily walk it when (and only when) at least one Section to
  // patch is in the mini-stream.
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Group edits by section to amortise inflate/deflate per stream.
  const bySection = new Map();
  for (const e of resolved) {
    const sec = e.section ?? 0;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(e);
  }

  const summary = [];
  for (const [secIdx, secEdits] of bySection) {
    const dirEntry = findStreamEntry(entries, ['BodyText', `Section${secIdx}`]);

    // Mini-stream vs regular FAT routing. CFB uses size < 4096 (the mini
    // stream cutoff in the header) to mean "this stream lives in the mini-
    // stream addressed by mini-FAT mini-sector indices". Tiny report
    // templates (h22_work_report-style) hit this; larger forms don't.
    const inMiniStream = dirEntry.size < 4096;
    let chain, capacity, compressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      chain = walkChain(minifat, dirEntry.start);
      capacity = chain.length * mssz;
      compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
    } else {
      chain = walkChain(fat, dirEntry.start);
      capacity = chain.length * ssz;
      compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
    }
    let raw = Buffer.from(inflateRawSync(compressed));

    // Apply edits back-to-front in record order so byte offsets stay valid.
    // cell_para descending too, so a multi-paragraph cell's later paragraphs are
    // patched before its earlier ones (records are re-parsed per edit, and an
    // empty replacement keeps the paragraph, so indices stay stable either way).
    const editsSorted = [...secEdits].sort((a, b) =>
      (b.para - a.para) || (b.control - a.control) || (b.cellIndex - a.cellIndex) || ((b.cell_para ?? 0) - (a.cell_para ?? 0))
    );
    for (const e of editsSorted) {
      const records = parseRecords(raw);
      raw = applyCellText(raw, records, e.para ?? 0, e.control ?? 0, e.cellIndex, e.text ?? '', e.cell_para ?? 0, !!e.clear_objects);
      summary.push({
        section: secIdx, para: e.para, control: e.control,
        row: e.row, col: e.col, cellIndex: e.cellIndex, text: e.text ?? '',
      });
    }

    // Deflate + fit. Regular-FAT chains auto-expand if the patched payload
    // grew past capacity (Phase 3); mini-stream chains do the same via
    // mini-FAT expansion, and promote to regular FAT when the payload
    // crosses the 4096-byte mini-stream cutoff (Phase 3b).
    let newCompressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
        raw, chain
      );
      buf = ext.buf;
      fat = ext.fat;
      minifat = ext.minifat;
      minifatStart = ext.minifatStart;
      newCompressed = ext.compressed;
      if (ext.promoted) {
        // Stream just moved from mini → regular FAT. Update dir entry's
        // start field; CFB readers infer storage from size (>= 4096 →
        // regular FAT, < 4096 → mini-stream), so updating size below
        // also flips the interpretation.
        chain = ext.newRegularChain;
        writeChainBytes(buf, chain, ssz, newCompressed);
        buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        chain = ext.miniChain;
        writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
      }
    } else {
      const r = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
      buf = r.buf;
      fat = r.fat;
      chain = r.chain;
      newCompressed = r.compressed;
      writeChainBytes(buf, chain, ssz, newCompressed);
    }

    // Update the size field in the directory entry. CFB v3 stores u64 but
    // only the low 32 bits are meaningful (file sizes are bounded by u32).
    buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);
  }

  writeFileSync(filePath, buf);
  return summary;
}

// sheetjs CFB fallback. Used when an edit grows beyond the original
// sector-chain capacity (e.g. replacing a short cell with a paragraph of
// text). sheetjs's CFB.write auto-injects a "Sh33tJ5" marker stream
// — that does NOT block Hancom Docs (the 1.4.0 raw-patch shipped this
// exact code and the verified KEIT form opens cleanly in Hancom Docs), but
// it does mean output here is not byte-clean against the input. We only
// take this path when the in-place patch can't fit, never by default.
async function patchViaSheetjs(filePath, resolved) {
  // file:// URL so the ESM loader doesn't read the Windows drive letter as a
  // URL scheme (see resolveCellIndexes above); identical resolution on POSIX.
  const CFB = await import(url.pathToFileURL(path.join(__dirname, 'vendor/cfb/cfb.js')).href);
  const cfb = CFB.parse(readFileSync(filePath));

  const bySection = new Map();
  for (const e of resolved) {
    const sec = e.section ?? 0;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(e);
  }

  const summary = [];
  for (const [secIdx, secEdits] of bySection) {
    const streamPath = `Root Entry/BodyText/Section${secIdx}`;
    const fileIdx = cfb.FullPaths.indexOf(streamPath);
    if (fileIdx < 0) throw new Error(`stream not found: ${streamPath}`);
    let raw = Buffer.from(inflateRawSync(Buffer.from(cfb.FileIndex[fileIdx].content)));

    const editsSorted = [...secEdits].sort((a, b) =>
      (b.para - a.para) || (b.control - a.control) || (b.cellIndex - a.cellIndex)
    );
    for (const e of editsSorted) {
      const records = parseRecords(raw);
      raw = applyCellText(raw, records, e.para ?? 0, e.control ?? 0, e.cellIndex, e.text ?? '');
      summary.push({
        section: secIdx, para: e.para, control: e.control,
        row: e.row, col: e.col, cellIndex: e.cellIndex, text: e.text ?? '',
      });
    }

    const compressed = deflateRawSync(raw, { level: constants.Z_DEFAULT_COMPRESSION });
    cfb.FileIndex[fileIdx].content = compressed;
    cfb.FileIndex[fileIdx].size = compressed.length;
  }

  writeFileSync(filePath, CFB.write(cfb, { type: 'buffer' }));
  return summary;
}

export async function patchCellsInPlace(filePath, edits) {
  // Step 1: resolve cell coordinates to flat cell indices via rhwp.
  const resolved = await resolveCellIndexes(filePath, edits);

  // Step 2: try in-place sector-chain patch first. This preserves every
  // byte outside the patched section (no Sh33tJ5 marker, no re-emit).
  try {
    const summary = patchInPlaceSectors(filePath, resolved);
    summary.mode = 'in-place';
    return summary;
  } catch (err) {
    // Fall back to sheetjs for any limitation the in-place patcher can't
    // handle:
    //   - sector-chain overflow: patched payload grew past the existing
    //     chain (e.g. a short cell turning into a paragraph)
    //   - mini-stream Section: tiny forms keep Section0 inside the CFB
    //     mini-stream, which the in-place patcher doesn't navigate
    //     (h22_work_report-style 27KB report templates hit this)
    // Other errors (corrupt CFB, bad cell coordinates, etc.) surface
    // unchanged so the caller sees them.
    const fallbackTriggers = /exceeds sector chain capacity|mini-stream patch path not implemented/;
    if (!fallbackTriggers.test(err.message)) throw err;

    const summary = await patchViaSheetjs(filePath, resolved);
    summary.mode = 'sheetjs-fallback';
    return summary;
  }
}

// ── replace_text raw-patch (Phase 1: equal-length only) ───────────────────
//
// Finds `query` inside any body PARA_TEXT record (level-1) and rewrites
// those bytes to `replacement` directly. PARA_TEXT body is UTF-16LE so the
// search is byte-level on the encoded form, which keeps surrogate pairs
// and HWP inline-control codes intact.
//
// This first cut only handles `Buffer.byteLength(query, 'utf16le') ===
// Buffer.byteLength(replacement, 'utf16le')` — same encoded length. Under
// that constraint:
//   - PARA_TEXT record header (size field) is unchanged
//   - PARA_HEADER text_count is unchanged
//   - PARA_CHAR_SHAPE charPos entries stay valid (no position shift)
// so the only mutation is the bytes inside the existing PARA_TEXT body.
//
// Different-length replacements need char_shape shifting + PARA_TEXT
// header rewriting (extended size encoding crossover) + PARA_HEADER
// text_count update. That comes in the next phase.
//
// Only body paragraphs (PARA_HEADER level 0, PARA_TEXT level 1) are
// searched. Table cell text is invisible to this op — same as rhwp's
// replaceOne and SKILL.md docs the constraint. Use set_cell_text* for
// cells.

function findReplaceTextTarget(records, raw, query, caseSensitive) {
  const queryBuf = Buffer.from(query, 'utf16le');
  const queryLower = query.toLowerCase();
  // Track the most recent level-0 PARA_HEADER as we walk — that's the
  // paragraph whose text_count we update when the replacement changes
  // length, and whose level-1 PARA_CHAR_SHAPE we shift.
  let paraHeaderIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) paraHeaderIdx = i;
    if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
    const body = raw.slice(r.dataOff, r.dataOff + r.size);
    let byteOffset;
    if (caseSensitive) {
      byteOffset = body.indexOf(queryBuf);
    } else {
      const bodyStr = body.toString('utf16le').toLowerCase();
      const charIdx = bodyStr.indexOf(queryLower);
      byteOffset = charIdx >= 0 ? charIdx * 2 : -1;
    }
    if (byteOffset >= 0 && paraHeaderIdx >= 0) {
      // Walk forward looking for the level-1 PARA_CHAR_SHAPE that belongs
      // to this paragraph. Stop at the next level-0 PARA_HEADER.
      let charShape = null;
      for (let j = i + 1; j < records.length; j++) {
        const r2 = records[j];
        if (r2.tag === TAG_PARA_HEADER && r2.level === 0) break;
        if (r2.tag === TAG_PARA_CHAR_SHAPE && r2.level === 1) { charShape = r2; break; }
      }
      return {
        paraHeaderRec: records[paraHeaderIdx],
        paraTextRec: r,
        charShapeRec: charShape,
        byteOffset,
      };
    }
  }
  return null;
}

// Builds a raw PARA_TEXT record (header + body) for the given level. The
// header uses inline 12-bit size when body fits in 0xFFE bytes, otherwise
// extended encoding (12-bit field set to 0xFFF followed by a u32 real
// size). JS bitwise is i32, so we coerce to u32 with `>>> 0`.
function buildParaTextRecord(body, level) {
  const size = body.length;
  if (size > 0xFFE) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (level << 10) | TAG_PARA_TEXT) >>> 0, 0);
    head.writeUInt32LE(size, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((size << 20) | (level << 10) | TAG_PARA_TEXT) >>> 0, 0);
  return Buffer.concat([head, body]);
}

// Equal-length replace: bytes-in-place. Returns { raw, replaced }. raw is
// the same buffer object (mutated). No record-size or text_count changes.
function applyReplaceTextEqualLength(raw, op) {
  const queryBuf = Buffer.from(op.query, 'utf16le');
  const replBuf = Buffer.from(op.replacement ?? '', 'utf16le');
  const records = parseRecords(raw);
  const caseSensitive = op.case_sensitive !== false;
  const target = findReplaceTextTarget(records, raw, op.query, caseSensitive);
  if (!target) return { raw, replaced: false };
  replBuf.copy(raw, target.paraTextRec.dataOff + target.byteOffset);
  return { raw, replaced: true };
}

// Different-length replace: rebuild the PARA_TEXT record, shift the
// paragraph's PARA_CHAR_SHAPE charPos entries past the match, and update
// PARA_HEADER text_count. Returns { raw, replaced } where raw is a NEW
// buffer (length changes because the record header and/or body grew or
// shrank).
//
// The three coordinated edits, in order:
//   (1) char_shape charPos shift — must happen on the old buffer so the
//       paraTextRec.dataOff offsets we read are still valid
//   (2) PARA_HEADER text_count update — same reason
//   (3) PARA_TEXT record swap — last, builds the new buffer
function applyReplaceTextDifferentLength(raw, op) {
  const queryBuf = Buffer.from(op.query, 'utf16le');
  const replBuf = Buffer.from(op.replacement ?? '', 'utf16le');
  const records = parseRecords(raw);
  const caseSensitive = op.case_sensitive !== false;
  const target = findReplaceTextTarget(records, raw, op.query, caseSensitive);
  if (!target) return { raw, replaced: false };

  const { paraHeaderRec, paraTextRec, charShapeRec, byteOffset } = target;
  const queryChars = queryBuf.length / 2;
  const replChars = replBuf.length / 2;
  const deltaChars = replChars - queryChars;
  const matchCharPos = byteOffset / 2;

  // (1) PARA_CHAR_SHAPE entries shift. Each entry is 8 bytes:
  //     [u32 charPos, u32 shapeId]. We touch only charPos.
  if (charShapeRec) {
    const csOff = charShapeRec.dataOff;
    const entryCount = Math.floor(charShapeRec.size / 8);
    for (let i = 0; i < entryCount; i++) {
      const entryOff = csOff + i * 8;
      const pos = raw.readUInt32LE(entryOff);
      let newPos;
      if (pos <= matchCharPos) {
        newPos = pos;
      } else if (pos >= matchCharPos + queryChars) {
        newPos = pos + deltaChars;
      } else {
        // Entry sits *inside* the replaced span. Clamp to match start so
        // the entry still references a valid character position.
        newPos = matchCharPos;
      }
      raw.writeUInt32LE((newPos >>> 0) >>> 0, entryOff);
    }
  }

  // (2) PARA_HEADER.text_count update. The high bit is a paragraph flag we
  // must preserve; only the low 31 bits hold the char count.
  const oldCount = raw.readUInt32LE(paraHeaderRec.dataOff);
  const high = (oldCount & 0x80000000) >>> 0;
  const low = oldCount & 0x7FFFFFFF;
  const newLow = (low + deltaChars) >>> 0;
  raw.writeUInt32LE((high | newLow) >>> 0, paraHeaderRec.dataOff);

  // (3) PARA_TEXT swap. Build the new body, then a fresh record, then
  // splice it into raw.
  const oldBody = raw.slice(paraTextRec.dataOff, paraTextRec.dataOff + paraTextRec.size);
  const newBody = Buffer.concat([
    oldBody.slice(0, byteOffset),
    replBuf,
    oldBody.slice(byteOffset + queryBuf.length),
  ]);
  const newRecord = buildParaTextRecord(newBody, 1);
  const oldRecordLen = (paraTextRec.ext ? 8 : 4) + paraTextRec.size;
  const newRaw = Buffer.concat([
    raw.slice(0, paraTextRec.headOff),
    newRecord,
    raw.slice(paraTextRec.headOff + oldRecordLen),
  ]);
  return { raw: newRaw, replaced: true };
}

function applyReplaceText(raw, op) {
  const qLen = Buffer.byteLength(op.query, 'utf16le');
  const rLen = Buffer.byteLength(op.replacement ?? '', 'utf16le');
  if (qLen === rLen) return applyReplaceTextEqualLength(raw, op);
  return applyReplaceTextDifferentLength(raw, op);
}

export async function replaceTextInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', replaced_count: 0 });
  }
  // Validate ops up front — surface "different length" before we touch the
  // file, so a partial run can't leave the file partially patched.
  for (const op of ops) {
    if (typeof op.query !== 'string' || op.query.length === 0) {
      throw new Error("replace_text: 'query' is required");
    }
    const replacement = op.replacement ?? '';
    if (/[\n\r]/.test(replacement) || replacement.indexOf('\u2028') !== -1 || replacement.indexOf('\u2029') !== -1) {
      throw new Error("replace_text: replacement cannot contain paragraph-break characters");
    }
  }

  // buf/fat/minifat/minifatStart/rootChain are all `let` so Phase 3 /
  // Phase 3b expansion paths can replace them.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Walk every BodyText/SectionN stream once, applying every op to it (an
  // op might match in any section). We bail with a clear error when a
  // section can't be located — that means a malformed input file, not a
  // user-correctable condition.
  const summary = [];
  let totalReplaced = 0;

  for (let secIdx = 0; ; secIdx++) {
    let dirEntry;
    try {
      dirEntry = findStreamEntry(entries, ['BodyText', `Section${secIdx}`]);
    } catch {
      break; // no more sections
    }

    const inMiniStream = dirEntry.size < 4096;
    let chain, capacity, compressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      chain = walkChain(minifat, dirEntry.start);
      capacity = chain.length * mssz;
      compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
    } else {
      chain = walkChain(fat, dirEntry.start);
      capacity = chain.length * ssz;
      compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
    }
    let raw = Buffer.from(inflateRawSync(compressed));
    let dirty = false;
    const sectionReplacements = [];

    for (const op of ops) {
      const r = applyReplaceText(raw, op);
      // Different-length replacements return a freshly-allocated buffer;
      // equal-length returns the same buffer mutated. Either way, reassign
      // so the next op (and the deflate below) sees the latest state.
      if (r.replaced) {
        raw = r.raw;
        dirty = true;
        totalReplaced++;
        sectionReplacements.push({ section: secIdx, query: op.query, replacement: op.replacement ?? '' });
      }
    }
    if (!dirty) continue;

    // Deflate + fit. Both regular-FAT and mini-stream chains auto-expand,
    // and mini-stream Sections promote to regular FAT when the patched
    // payload exceeds the 4096-byte mini-stream cutoff (Phase 3 / 3b).
    let newCompressed;
    if (inMiniStream) {
      const rc = ensureRootChain();
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
        raw, chain
      );
      buf = ext.buf;
      fat = ext.fat;
      minifat = ext.minifat;
      minifatStart = ext.minifatStart;
      newCompressed = ext.compressed;
      if (ext.promoted) {
        chain = ext.newRegularChain;
        writeChainBytes(buf, chain, ssz, newCompressed);
        buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        chain = ext.miniChain;
        writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
      }
    } else {
      const r = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
      buf = r.buf;
      fat = r.fat;
      chain = r.chain;
      newCompressed = r.compressed;
      writeChainBytes(buf, chain, ssz, newCompressed);
    }
    buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

    summary.push(...sectionReplacements);
  }

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.replaced_count = totalReplaced;
  return result;
}

// ── setup_document raw-patch (Phase 5) ────────────────────────────────────
//
// Mutates the PAGE_DEF record (tag 0x49) inside BodyText/Section0.
// PAGE_DEF body is exactly 40 bytes per HWP 5.0 / rhwp:
//   offset 0..3   width  (u32, HWPUNIT)
//   offset 4..7   height (u32, HWPUNIT)
//   offset 8..11  margin_left
//   offset 12..15 margin_right
//   offset 16..19 margin_top
//   offset 20..23 margin_bottom
//   offset 24..27 margin_header
//   offset 28..31 margin_footer
//   offset 32..35 margin_gutter
//   offset 36..39 attr (u32) — bit 0 = landscape, bits 1..2 = binding
//
// HWPUNIT = 1/7200 inch. 1 mm = 283.46 HWPUNIT.

const TAG_PAGE_DEF = 0x49;

const PAGE_SIZES = {
  // HWPUNIT values match rhwp-studio's PAPER_DEFAULTS (which mirrors
  // Hancom coreEngine.js IDS_PAPER_*). Off-by-one/two integers (e.g. the
  // old 59528/84186) leave Hancom Docs displaying portrait even with the
  // landscape attr bit set.
  a4: [59527, 84188],    // 210 × 297 mm
  a5: [42040, 59527],    // 148 × 210 mm
  a3: [84188, 119055],   // 297 × 420 mm
  b4: [72852, 103180],   // 257 × 364 mm
  b5: [51591, 72852],    // 182 × 257 mm
  letter: [61560, 79200], // 8.5 × 11 in
  legal: [61560, 100800], // 8.5 × 14 in
};

const MM_PER_HWPUNIT = 283.46;

export async function setupDocumentInPlace(filePath, op) {
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  // Find the PAGE_DEF record (typically 1 per section).
  const records = parseRecords(raw);
  let pageDefRec = null;
  for (const r of records) {
    if (r.tag === TAG_PAGE_DEF) { pageDefRec = r; break; }
  }
  if (!pageDefRec) throw new Error('setup_document: PAGE_DEF record not found in section');
  if (pageDefRec.size < 40) throw new Error(`setup_document: PAGE_DEF body too short (${pageDefRec.size}, need 40)`);

  // Read current values.
  let width = raw.readUInt32LE(pageDefRec.dataOff);
  let height = raw.readUInt32LE(pageDefRec.dataOff + 4);
  let marginL = raw.readUInt32LE(pageDefRec.dataOff + 8);
  let marginR = raw.readUInt32LE(pageDefRec.dataOff + 12);
  let marginT = raw.readUInt32LE(pageDefRec.dataOff + 16);
  let marginB = raw.readUInt32LE(pageDefRec.dataOff + 20);
  let attr = raw.readUInt32LE(pageDefRec.dataOff + 36);
  let landscape = (attr & 0x01) !== 0;

  // Apply op overrides (only fields the caller specified).
  //
  // Convention (rhwp-studio PageSetupDialog): PageDef stores portrait-
  // oriented width/height regardless of orientation. The landscape flag
  // (attr bit 0) is the sole rotation signal. Earlier code swapped
  // width/height on landscape — that produced a page Hancom Docs renders
  // in portrait orientation even when the bit was set.
  if (op.orientation) {
    const wantLandscape = String(op.orientation).toLowerCase() === 'landscape';
    landscape = wantLandscape;
    attr = wantLandscape ? (attr | 0x01) >>> 0 : (attr & ~0x01) >>> 0;
  }
  if (op.page_size) {
    const sz = PAGE_SIZES[String(op.page_size).toLowerCase()];
    if (sz) {
      // Always store portrait dimensions; landscape flag handles rotation.
      width = sz[0];
      height = sz[1];
    }
  }
  if (op.margin_mm !== undefined) {
    const m = Math.round(op.margin_mm * MM_PER_HWPUNIT);
    marginL = m; marginR = m; marginT = m; marginB = m;
  }
  if (op.margin_top_mm !== undefined) marginT = Math.round(op.margin_top_mm * MM_PER_HWPUNIT);
  if (op.margin_bottom_mm !== undefined) marginB = Math.round(op.margin_bottom_mm * MM_PER_HWPUNIT);
  if (op.margin_left_mm !== undefined) marginL = Math.round(op.margin_left_mm * MM_PER_HWPUNIT);
  if (op.margin_right_mm !== undefined) marginR = Math.round(op.margin_right_mm * MM_PER_HWPUNIT);

  // Write back into raw.
  raw.writeUInt32LE(width >>> 0, pageDefRec.dataOff);
  raw.writeUInt32LE(height >>> 0, pageDefRec.dataOff + 4);
  raw.writeUInt32LE(marginL >>> 0, pageDefRec.dataOff + 8);
  raw.writeUInt32LE(marginR >>> 0, pageDefRec.dataOff + 12);
  raw.writeUInt32LE(marginT >>> 0, pageDefRec.dataOff + 16);
  raw.writeUInt32LE(marginB >>> 0, pageDefRec.dataOff + 20);
  raw.writeUInt32LE(attr >>> 0, pageDefRec.dataOff + 36);

  // Deflate + write back. raw length doesn't change so capacity should
  // be unchanged; expansion paths are wired for defense.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  return {
    mode: 'in-place',
    applied: {
      width, height, landscape,
      margin_left: marginL, margin_right: marginR,
      margin_top: marginT, margin_bottom: marginB,
    },
  };
}

// ── append_table raw-patch (Phase 4-6) ────────────────────────────────────
//
// Strategy: find an existing table-container paragraph in the section
// (a level-0 paragraph whose cluster contains a CTRL_HEADER with id
// 'tbl ' and an HWPTAG_TABLE record), and clone its entire cluster
// byte-for-byte at the new location. Cell text is then emptied so the
// caller gets an empty table.
//
// LIMITATIONS (raw-patch can't synthesize new control records from
// scratch — too much HWP 5.0 spec). The cloned table:
//   - keeps the source table's rows × cols (the user can't pick a
//     custom size; pick the form's smallest table as the template, or
//     use set_cell_text on an existing form table)
//   - keeps border / cell width / cell height from the source
//   - has cell PARA_TEXT records dropped (cells become empty)
// Documented in SKILL.md as the append_table limitation.

const TAG_TABLE = 0x4D;
const TBL_CTRL_ID = 0x74626c20; // 'tbl '

// Find a table-container paragraph cluster: level-0 PARA_HEADER whose
// cluster contains a CTRL_HEADER ('tbl ') + HWPTAG_TABLE.
// Returns { paraStartIdx, clusterEndIdx, rows, cols } for the smallest
// table in the section. We prefer small tables as templates so the
// cloned cluster bytes are minimal.
function findTemplateTableCluster(records, raw) {
  // Two trackers:
  //   - best: smallest by area among ALL tables (fallback)
  //   - bestContent: smallest by area among tables with rows>=2 AND cols>=2
  //     (filters out single-row/column layout tables — those are often
  //     borderless cosmetic-alignment tables and cloning them produces a
  //     visually-invisible result. Concrete case observed: h22 work_report
  //     has 4 tables — a 1x2 borderless header layout (area 2) and two
  //     real 9x4 content tables with visible borders; the old "smallest
  //     overall" rule picked the 1x2 and the inserted table came out
  //     invisible. The rows/cols filter picks 9x4 instead, which renders.)
  let best = null;
  let bestContent = null;
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag !== TAG_PARA_HEADER || records[i].level !== 0) continue;
    // Locate cluster end (next level-0 PARA_HEADER or records.length)
    let end = records.length;
    for (let j = i + 1; j < records.length; j++) {
      if (records[j].tag === TAG_PARA_HEADER && records[j].level === 0) { end = j; break; }
    }
    // Look for CTRL_HEADER 'tbl ' + TABLE inside this cluster
    for (let j = i + 1; j < end - 1; j++) {
      const r = records[j];
      if (r.tag !== TAG_CTRL_HEADER || r.level !== 1) continue;
      if (r.size < 4) continue;
      const ctrlId = raw.readUInt32LE(r.dataOff);
      if (ctrlId !== TBL_CTRL_ID) continue;
      // Next record should be HWPTAG_TABLE
      if (records[j + 1].tag !== TAG_TABLE || records[j + 1].level !== 2) continue;
      const tableBody = raw.slice(records[j + 1].dataOff, records[j + 1].dataOff + records[j + 1].size);
      if (tableBody.length < 8) continue;
      const rows = tableBody.readUInt16LE(4);
      const cols = tableBody.readUInt16LE(6);
      const area = rows * cols;
      const candidate = { paraStartIdx: i, clusterEndIdx: end, rows, cols, area };
      if (!best || area < best.area) best = candidate;
      if (rows >= 2 && cols >= 2) {
        if (!bestContent || area < bestContent.area) bestContent = candidate;
      }
      break;
    }
  }
  const chosen = bestContent || best;
  if (!chosen) throw new Error('append_table: no existing table found in section to use as a template — raw-patch needs a template (form-design tables in advance, or call append_table on a form that already has at least one table)');
  return chosen;
}

// Clone the table cluster while emptying cell content.
//
// Three positions for PARA_TEXT records in a table cluster:
//   - level 1 PARA_TEXT  → table-container paragraph's own text. Holds
//                          the inline extended-ctrl char that references
//                          child CTRL_HEADER ('tbl ') by index. MUST
//                          be kept verbatim.
//   - level 3 PARA_TEXT  → text inside a cell paragraph (the cell's
//                          actual content). Drop these to empty cells.
//   - higher-level PARA_TEXT (>3) → text inside nested cells (cell-in-
//                          cell). Drop too. Same logic applies.
//
// Each level-2 PARA_HEADER (cell paragraph) whose PARA_TEXT we drop
// gets its text_count rewritten to 1 (EOP only) so the header/body
// match. Top-level (level 0) PARA_HEADER's MSB last-paragraph flag is
// cleared so the new table doesn't claim to terminate the section.
function cloneTableClusterBytes(records, raw, startIdx, endIdx) {
  const parts = [];
  const topLevel = records[startIdx].level;
  // First pass: figure out which level-2+ PARA_HEADERs have their
  // PARA_TEXT dropped (so we can rewrite their text_count). Map from
  // record index → true.
  const parasNeedingCountReset = new Set();
  for (let i = startIdx + 1; i < endIdx; i++) {
    const r = records[i];
    if (r.tag !== TAG_PARA_TEXT || r.level <= topLevel + 1) continue;
    // Find the most recent PARA_HEADER above this with matching level
    // (PARA_TEXT level = PARA_HEADER level + 1).
    const targetHdrLevel = r.level - 1;
    for (let j = i - 1; j > startIdx; j--) {
      if (records[j].tag === TAG_PARA_HEADER && records[j].level === targetHdrLevel) {
        parasNeedingCountReset.add(j);
        break;
      }
    }
  }
  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    // Drop PARA_TEXT inside cells (level > top+1) but keep the table-
    // container paragraph's own PARA_TEXT (level == top+1).
    if (r.tag === TAG_PARA_TEXT && r.level > topLevel + 1) continue;
    const headLen = r.ext ? 8 : 4;
    if (r.tag === TAG_PARA_HEADER && r.size >= 4) {
      const head = raw.slice(r.headOff, r.headOff + headLen);
      const body = Buffer.from(raw.slice(r.dataOff, r.dataOff + r.size));
      const old = body.readUInt32LE(0);
      let newCount;
      if (i === startIdx) {
        // top-level: clear MSB, keep its char_count
        newCount = (old & 0x7FFFFFFF) >>> 0;
      } else if (parasNeedingCountReset.has(i)) {
        // cell paragraph whose PARA_TEXT we dropped → text_count = 1 (EOP)
        newCount = ((old & 0x80000000) >>> 0) | 1;
      } else {
        newCount = old;
      }
      body.writeUInt32LE(newCount >>> 0, 0);
      parts.push(head);
      parts.push(body);
    } else {
      parts.push(raw.slice(r.headOff, r.dataOff + r.size));
    }
  }
  return Buffer.concat(parts);
}

// ── synthesize-path helpers (approach A) ──────────────────────────────────
//
// When the caller provides `_templateBytes` (a small .hwp produced by rhwp
// containing exactly one table with the user's rows×cols), extract that
// table cluster and splice it into the target. The cells in the
// rhwp-produced cluster reference rhwp's own BorderFill IDs (typically 3
// for the all-1-thick visible style). Those IDs in the target's DocInfo
// may not match — concretely, the target's BF #3 has different border
// styling than rhwp's BF #3. Remap to a uniform-visible BF in the target.
//
// borderFillId is consistently the LAST u16 of a level-2 LIST_HEADER body
// (offset = bodySize - 2), confirmed by inspecting both rhwp's 34-byte
// cell LIST_HEADER bodies and h22's 46-byte ones (the extra trailing
// bytes in h22 are after the borderFillId, not before).

// Read a named stream's decompressed bytes from a CFB buffer using
// cell-patch's own primitives (no sheetjs dependency). The stream is
// inflated via raw deflate (HWP's standard section compression).
function readDecodedStreamFromCfb(buf, streamPathParts) {
  const { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  const fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  const dirEntry = findStreamEntry(entries, streamPathParts);
  let compressed;
  if (dirEntry.size < 4096) {
    const minifat = readMinifat(buf, fat, ssz, minifatStart);
    if (entries[0].start < 0) throw new Error('mini-stream needed but root entry has no chain');
    const rc = walkChain(fat, entries[0].start);
    const chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    const chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  return Buffer.from(inflateRawSync(compressed));
}

// Pull the table cluster's raw bytes out of an rhwp-generated template.
// Returns the byte slice (head of top-level PARA_HEADER through to the
// end of the cluster, before the next top-level PARA_HEADER).
function extractTableClusterFromTemplate(templateBytes) {
  const raw = readDecodedStreamFromCfb(templateBytes, ['BodyText', 'Section0']);
  const recs = parseRecords(raw);
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].tag !== TAG_PARA_HEADER || recs[i].level !== 0) continue;
    let end = recs.length;
    for (let j = i + 1; j < recs.length; j++) {
      if (recs[j].tag === TAG_PARA_HEADER && recs[j].level === 0) { end = j; break; }
    }
    for (let j = i + 1; j < end; j++) {
      const r = recs[j];
      if (r.tag === TAG_CTRL_HEADER && r.level === 1 && r.size >= 4
          && raw.readUInt32LE(r.dataOff) === TBL_CTRL_ID) {
        const startByte = recs[i].headOff;
        const endByte = end < recs.length ? recs[end].headOff : raw.length;
        return Buffer.from(raw.slice(startByte, endByte));  // mutable copy
      }
    }
  }
  throw new Error('synthesize: no table cluster found in template');
}

// Walk the target's DocInfo and return the 1-based ID of a BorderFill
// with uniform visible borders (kind=0 solid, thickness 1 on all four
// sides). Falls back to any BF with all four borders > 0. Returns null
// if nothing visible exists.
function findUniformVisibleBorderFillId(diRaw) {
  const TAG_BORDER_FILL_DI = 20;  // HWPTAG_BORDER_FILL in DocInfo space
  const recs = parseRecords(diRaw);
  // Prefer uniform 1/1/1/1 ("normal" looking table border)
  let bfIdx = 0;
  for (const r of recs) {
    if (r.tag !== TAG_BORDER_FILL_DI) continue;
    bfIdx++;
    const body = diRaw.slice(r.dataOff, r.dataOff + r.size);
    if (body.length < 22) continue;
    const lt = body.readUInt8(3), rt = body.readUInt8(9);
    const tt = body.readUInt8(15), bt = body.readUInt8(21);
    if (lt > 0 && rt > 0 && tt > 0 && bt > 0 && lt === rt && rt === tt && tt === bt) {
      return bfIdx;
    }
  }
  // Fallback: any BF with all four sides > 0 (even if uneven)
  bfIdx = 0;
  for (const r of recs) {
    if (r.tag !== TAG_BORDER_FILL_DI) continue;
    bfIdx++;
    const body = diRaw.slice(r.dataOff, r.dataOff + r.size);
    if (body.length < 22) continue;
    if (body.readUInt8(3) > 0 && body.readUInt8(9) > 0
        && body.readUInt8(15) > 0 && body.readUInt8(21) > 0) {
      return bfIdx;
    }
  }
  return null;
}

// Rewrite every level-2 LIST_HEADER's borderFillId in the cluster bytes
// to `newBfId`. Mutates the buffer in place.
function remapClusterCellBorderFillId(clusterBytes, newBfId) {
  const recs = parseRecords(clusterBytes);
  let count = 0;
  for (const r of recs) {
    if (r.tag !== TAG_LIST_HEADER || r.level !== 2) continue;
    if (r.size < 2) continue;
    clusterBytes.writeUInt16LE(newBfId & 0xFFFF, r.dataOff + r.size - 2);
    count++;
  }
  return count;
}

// Read DocInfo bytes from a CFB buffer. Used by the synthesize path so it
// can find a target-side visible BorderFill ID to remap cell references to.
function readDocInfoRawFromCfb(buf) {
  return readDecodedStreamFromCfb(buf, ['DocInfo']);
}

export async function appendTableInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', appended_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const records = parseRecords(raw);

    // Two paths:
    //   (A) synthesize — caller pre-built an rhwp template (.hwp bytes
    //       with exactly one user-sized table); we extract that cluster,
    //       remap its cell borderFillIds to a visible BF in the target's
    //       DocInfo, and splice. Honors user-supplied rows/cols.
    //   (B) clone (legacy) — pick the smallest "real content" table
    //       already in the section (rows≥2 AND cols≥2 preferred) and
    //       clone it byte-for-byte with cells emptied. Doesn't honor
    //       user-supplied rows/cols.
    // Path (A) requires DocInfo lookup; we read it once per op (could be
    // hoisted out of the loop if perf matters, but tables are usually
    // single-op).
    let cluster, entry;
    if (Buffer.isBuffer(op._templateBytes) && op._templateBytes.length > 0) {
      const tplCluster = extractTableClusterFromTemplate(op._templateBytes);
      const tplRecs = parseRecords(tplCluster);
      // Read out tpl rows/cols for the summary entry
      let tplRows = 0, tplCols = 0;
      for (const r of tplRecs) {
        if (r.tag === TAG_TABLE && r.level === 2 && r.size >= 8) {
          tplRows = tplCluster.readUInt16LE(r.dataOff + 4);
          tplCols = tplCluster.readUInt16LE(r.dataOff + 6);
          break;
        }
      }
      // Remap cell borderFillId to target's uniform-visible BF if available
      const diRaw = readDocInfoRawFromCfb(buf);
      const targetBfId = findUniformVisibleBorderFillId(diRaw);
      let remappedCellCount = 0;
      let remappedTo = null;
      if (targetBfId !== null) {
        remappedCellCount = remapClusterCellBorderFillId(tplCluster, targetBfId);
        remappedTo = targetBfId;
      }
      cluster = tplCluster;
      // Even on the synth path, cell text content is NOT filled — we
      // build an empty rows×cols frame and let the user follow up with
      // set_cell_text. Flag this so create.js can surface it.
      const contentMismatches = [];
      const hdrs = Array.isArray(op.headers) ? op.headers : null;
      const dataRows = Array.isArray(op.rows) ? op.rows : null;
      if (hdrs && hdrs.length > 0) {
        contentMismatches.push(`headers=${JSON.stringify(op.headers)} not filled into cells (cells emit empty — call set_cell_text after to populate)`);
      }
      if (dataRows && dataRows.length > 0 && Array.isArray(dataRows[0]) && dataRows[0].some((v) => v !== '' && v != null)) {
        contentMismatches.push(`rows data not filled into cells (cells emit empty — call set_cell_text after to populate)`);
      }
      entry = {
        section: 0,
        rows: tplRows,
        cols: tplCols,
        note: 'synthesized via rhwp template + spliced surgically — shape honors user input, cell content empty',
        border_fill_id_remap: { to: remappedTo, cells_remapped: remappedCellCount },
      };
      if (contentMismatches.length > 0) entry.user_input_ignored = contentMismatches;
    } else {
      const tpl = findTemplateTableCluster(records, raw);
      cluster = cloneTableClusterBytes(records, raw, tpl.paraStartIdx, tpl.clusterEndIdx);

      // Mismatch detection (clone path only — synthesize honors user input).
      const userRowsLen = Array.isArray(op.rows) ? op.rows.length : null;
      const userCols = typeof op.cols === 'number' ? op.cols
        : (Array.isArray(op.headers) ? op.headers.length : null);
      const userHeaders = Array.isArray(op.headers) ? op.headers.length : 0;
      const mismatches = [];
      if (userRowsLen !== null && tpl.rows !== (userRowsLen + (userHeaders ? 1 : 0))) {
        mismatches.push(`requested ${userRowsLen} data row(s)${userHeaders ? ' + headers' : ''} but cloned table has rows=${tpl.rows}`);
      }
      if (userCols !== null && userCols !== tpl.cols) {
        mismatches.push(`requested cols=${userCols} but cloned table has cols=${tpl.cols}`);
      }
      if (userHeaders > 0) {
        mismatches.push(`headers=${JSON.stringify(op.headers)} ignored (cells emit empty — fill with set_cell_text or set_cell_text_by_label after)`);
      }

      entry = { section: 0, rows: tpl.rows, cols: tpl.cols, note: 'cloned from existing table template (raw-patch can only clone, not synthesize)' };
      if (mismatches.length > 0) entry.user_input_ignored = mismatches;
    }

    // Insert after the last simple body paragraph (same anchor as
    // append_paragraph) so the new table lands in a reasonable place.
    const insertCluster = findLastSimpleBodyParagraph(records);
    const insertAt = insertCluster.endIdx < records.length
      ? records[insertCluster.endIdx].headOff
      : raw.length;
    raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);

    summary.push(entry);
  }

  // Deflate + write back
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.appended_count = summary.length;
  return result;
}

// ── append_paragraph raw-patch (Phase 4-1) ────────────────────────────────
//
// Strategy: clone the last body-level paragraph cluster (PARA_HEADER +
// PARA_TEXT + PARA_CHAR_SHAPE + ...) and append it right after the
// original. text_count and the PARA_TEXT body are swapped for the new
// text; everything else — paraShape ref, charShape pairs, styleRef,
// control_mask — comes from the cloned paragraph and inherits the
// existing form's styling. The high-bit "this is the last paragraph"
// flag is moved from the original onto the clone so the cursor still
// terminates at the end.
//
// Why clone the last paragraph specifically: it's the only one that
// definitely exists in every document and is guaranteed to be a regular
// body paragraph (not a heading, list, table, etc.). For
// append_heading and friends in later phases we'll let the caller pick
// a template.

// A "simple body paragraph" cluster contains only PARA_HEADER + PARA_TEXT
// + PARA_CHAR_SHAPE (+ optional PARA_LINE_SEG, PARA_RANGE_TAG). No table
// (CTRL_HEADER / LIST_HEADER / level-2+ records). Cloning a simple
// paragraph keeps Hancom happy; cloning a table-container paragraph drags
// the table along and corrupts the section.
function findClusterBoundaries(records) {
  // Returns array of { startIdx, endIdx, hasControls } per level-0
  // paragraph. endIdx points to the first record NOT in the cluster
  // (i.e. the next level-0 PARA_HEADER or records.length).
  const clusters = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag !== TAG_PARA_HEADER || records[i].level !== 0) continue;
    let end = records.length;
    for (let j = i + 1; j < records.length; j++) {
      if (records[j].tag === TAG_PARA_HEADER && records[j].level === 0) { end = j; break; }
    }
    let hasControls = false;
    for (let j = i + 1; j < end; j++) {
      const r = records[j];
      // Anything that smells like a table/control/list. Even a single
      // CTRL_HEADER means this paragraph isn't a simple text-only one.
      if (r.tag === TAG_CTRL_HEADER || r.tag === TAG_LIST_HEADER || r.level >= 2) {
        hasControls = true;
        break;
      }
    }
    clusters.push({ startIdx: i, endIdx: end, hasControls });
  }
  return clusters;
}

function findLastSimpleBodyParagraph(records) {
  // Walk clusters from the end backwards, return the last one with no
  // controls. That's the safest template — its trailer is just
  // PARA_CHAR_SHAPE / line-seg and clones cleanly.
  const clusters = findClusterBoundaries(records);
  for (let i = clusters.length - 1; i >= 0; i--) {
    if (!clusters[i].hasControls) return clusters[i];
  }
  throw new Error('append_paragraph: no simple body paragraph found in section to use as a template');
}

function findLastLevel0Paragraph(records) {
  // The paragraph that currently carries the "last paragraph" flag —
  // we need to clear that flag on it before our new paragraph takes
  // over the role. Returns the cluster of the trailing level-0
  // PARA_HEADER (which may or may not have controls).
  const clusters = findClusterBoundaries(records);
  if (clusters.length === 0) {
    throw new Error('append_paragraph: no level-0 PARA_HEADER found in section');
  }
  return clusters[clusters.length - 1];
}

// PARA_HEADER body layout (per rhwp serializer / HWP 5.0 v5.0+):
//   0..3:   char_count_raw (u32) — low 31 bits = char count, MSB = last-paragraph flag
//   4..7:   control_mask (u32)
//   8..9:   para_shape_id (u16)
//   10:     style_id (u8)
//   11:     break_val (u8) — bit flags (0x01 section / 0x02 multicol / 0x04 page / 0x08 col break)
//   12..13: num_char_shapes (u16)
//   14..15: range_tags_count (u16)
//   16..17: line_segs_count (u16)
//   18..21: instance_id (u32) — must be unique within the document
//   22..23: trailing 2 bytes (kept as-is from the source)
//
// Build a fresh PARA_HEADER body cloning the source paragraph's shape
// (para_shape_id, style_id, control_mask, break_val) but rewriting:
//   - char_count to newCharCount + flag
//   - num_char_shapes to 1 (a single charPos=0 char shape we'll emit)
//   - line_segs_count to 0 (Hancom recomputes line layout from text)
//   - range_tags_count to 0
//   - instance_id to a fresh unique value
function buildClonedParaHeader(srcParaHeaderRec, raw, newCharCount, paragraphFlag, newInstanceId, breakValOverride, lineSegCount) {
  const bodySize = srcParaHeaderRec.size;
  // PARA_HEADER body layout:
  //   bytes  0..3   char_count_raw (u32, MSB=paragraph flag)
  //   bytes  4..7   control_mask   (u32)
  //   bytes  8..9   para_shape_id  (u16)
  //   byte   10     style_id       (u8)
  //   byte   11     break_val      (u8)
  //   bytes 12..13  num_char_shapes (u16)
  //   bytes 14..15  range_tags_count (u16)
  //   bytes 16..17  line_segs_count  (u16)
  //   bytes 18..21  instance_id    (u32)
  //   bytes 22..23  change_tracking_state (u16, HWP 5.0.3+)
  //
  // Older forms (HWP 5.0.0 pre-change-tracking — e.g. some Hop-exported
  // h22-style files) emit 22-byte PARA_HEADER bodies without the
  // trailing change_tracking_state field. All our writes stay within
  // offsets 0..21, so 22-byte bodies clone correctly — the trailing 2
  // bytes simply don't exist, and the emitted record stays 22 bytes too
  // (consistent with the source format Hancom Office already accepts
  // for this file).
  if (bodySize < 22) throw new Error(`PARA_HEADER body too short to clone properly: ${bodySize} (need >= 22)`);
  const body = Buffer.alloc(bodySize);
  raw.copy(body, 0, srcParaHeaderRec.dataOff, srcParaHeaderRec.dataOff + bodySize);
  // char_count_raw with optional MSB flag.
  const flag = paragraphFlag ? 0x80000000 : 0;
  body.writeUInt32LE(((flag | (newCharCount & 0x7FFFFFFF)) >>> 0), 0);
  // control_mask, para_shape_id, style_id: keep from source.
  // break_val (offset 11) → override if provided. Bit flags:
  //   0x01 section break, 0x02 multi-column, 0x04 page break, 0x08 column break.
  if (typeof breakValOverride === 'number') body.writeUInt8(breakValOverride & 0xFF, 11);
  // num_char_shapes (offset 12) → 1 (we emit a single charPos=0 entry)
  body.writeUInt16LE(1, 12);
  // range_tags_count (offset 14) → 0
  body.writeUInt16LE(0, 14);
  // line_segs_count (offset 16) → caller-supplied. 0 for plain paragraphs
  // (Hancom recomputes layout from text), 1 for break paragraphs (where
  // we emit a PARA_LINE_SEG record to match the structure Hancom Office
  body.writeUInt16LE(lineSegCount | 0, 16);
  // instance_id (offset 18..21) → fresh unique value
  body.writeUInt32LE(newInstanceId >>> 0, 18);
  // bytes 22..23 (change_tracking_state) stay as cloned from source if
  // present; absent in 22-byte (older HWP 5.0.0) bodies.

  // Header: level 0, tag PARA_HEADER, size field matches body.
  if (bodySize > 0xFFE) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (0 << 10) | TAG_PARA_HEADER) >>> 0, 0);
    head.writeUInt32LE(bodySize, 4);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((bodySize << 20) | (0 << 10) | TAG_PARA_HEADER) >>> 0, 0);
  return Buffer.concat([head, body]);
}

// Find a fresh instance_id by walking every PARA_HEADER in the section
// and returning max + 1. Hancom doesn't restrict the value beyond
// "unique within the section" as far as we've observed.
function pickFreshInstanceId(records, raw) {
  let max = 0;
  for (const r of records) {
    if (r.tag !== TAG_PARA_HEADER) continue;
    if (r.size < 22) continue;
    const id = raw.readUInt32LE(r.dataOff + 18);
    if (id > max) max = id;
  }
  return max + 1;
}

// Build a level-1 PARA_TEXT record for new body text. EOP appended.
function buildBodyParaTextRecord(text) {
  const body = Buffer.from(text + PARA_TEXT_EOP, 'utf16le');
  return buildParaTextRecord(body, 1);
}

// Find any level-1 PARA_LINE_SEG record in the section and return its
// body bytes (36 bytes / line-seg entry). Used to seed a sensible
// line_seg for break paragraphs we emit — Hancom recomputes line layout
// on open anyway, so the source values don't have to be accurate; they
// just have to be present and well-formed.
function findAnyLineSegBody(records, raw) {
  const TAG_PARA_LINE_SEG = 0x45;
  for (const r of records) {
    if (r.tag === TAG_PARA_LINE_SEG && r.level === 1 && r.size >= 36) {
      // Take exactly one entry (36 bytes) — the first.
      return Buffer.from(raw.slice(r.dataOff, r.dataOff + 36));
    }
  }
  // No reference available — fall back to all-zero entry. Hancom will
  // recompute layout from text + paraShape, and an all-zero entry is
  // still well-formed in shape (just doesn't describe anything yet).
  return Buffer.alloc(36);
}

function buildLineSegRecord(body36, level) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((36 << 20) | (level << 10) | 0x45) >>> 0, 0);
  return Buffer.concat([head, body36]);
}

// Emit a fresh PARA_CHAR_SHAPE record with a single entry (charPos=0,
// shapeId from the source paragraph's first char_shape entry). This
// keeps num_char_shapes in PARA_HEADER (which we set to 1) consistent
// with the actual char-shape record contents — a mismatch is one of
// the things Hancom Docs's strict validator rejects.
function buildSingleCharShapeRecord(records, raw, clusterStartIdx, clusterEndIdx, level) {
  // Find the source PARA_CHAR_SHAPE inside the cluster; read its first
  // entry's shapeId (bytes 4..7 of the body — the structure is
  // u32 charPos followed by u32 shapeId, repeated).
  let firstShapeId = 0;
  for (let i = clusterStartIdx + 1; i < clusterEndIdx; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_CHAR_SHAPE && r.level === 1 && r.size >= 8) {
      firstShapeId = raw.readUInt32LE(r.dataOff + 4);
      break;
    }
  }
  // Body: [u32 charPos=0, u32 shapeId]
  const body = Buffer.alloc(8);
  body.writeUInt32LE(0, 0);
  body.writeUInt32LE(firstShapeId >>> 0, 4);
  // Header: inline size encoding (body is 8 bytes, well under 0xFFE).
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((body.length << 20) | (level << 10) | TAG_PARA_CHAR_SHAPE) >>> 0, 0);
  return Buffer.concat([head, body]);
}

export async function appendParagraphInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', appended_count: 0 });
  }
  // Op-type aliases the dispatcher routes through this entry point:
  //   append_paragraph     -> break_val 0       (regular paragraph)
  //   append_page_break    -> break_val 0x04    (page break)
  //   insert_column_break  -> break_val 0x08    (column break)
  // text is optional for break variants (empty string = pure break para).
  for (const op of ops) {
    if (typeof op.text !== 'string') op.text = '';
    if (/[\n\r]/.test(op.text) || op.text.indexOf('\u2028') !== -1 || op.text.indexOf('\u2029') !== -1) {
      throw new Error("append_paragraph: 'text' cannot contain paragraph-break characters (one op = one paragraph; use multiple ops)");
    }
  }

  // Load the file and the CFB structures we need.
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Target stream: BodyText/Section0 by default (we don't yet support
  // multi-section append; SKILL.md gates that for callers).
  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  // Append each paragraph onto raw.
  //
  // Where exactly does "append" mean? We can't just push to the end of
  // the stream because the section's last level-0 PARA_HEADER is often
  // a cover-page paragraph that contains every table as nested
  // controls; its cluster extends to end-of-stream. Inserting our new
  // paragraph after that cluster breaks the structure (Hancom rejects
  // the file).
  //
  // Safe choice: insert right after the LAST SIMPLE BODY paragraph
  // (a paragraph with no controls/tables). For a typical multi-page form
  // the simple body sits before the cover-page paragraph, so the new
  // text shows up between the running body text and the table block.
  // The section's last-paragraph flag (high bit on text_count) stays
  // on the cover-page paragraph, untouched, so Hancom's notion of
  // "section ends here" is preserved.
  const summary = [];
  for (const op of ops) {
    const records = parseRecords(raw);
    const template = findLastSimpleBodyParagraph(records);
    const srcHeader = records[template.startIdx];

    const isBreakOnly = (op.breakVal | 0) !== 0 && op.text === '';
    const newCharCount = isBreakOnly ? 1 : (op.text.length + 1); // EOP only for break-only
    const newInstanceId = pickFreshInstanceId(records, raw);
    // Two shapes:
    //   - Plain paragraph: PARA_HEADER + PARA_TEXT + PARA_CHAR_SHAPE
    //     (line_segs_count=0; Hancom recomputes line layout)
    //   - Break-only paragraph: PARA_HEADER + PARA_CHAR_SHAPE + PARA_LINE_SEG
    //     (no PARA_TEXT; matches Hancom-Office-saved files' empty page-break paragraphs).
    //     Hancom-Office samples' page-break paragraphs carry line_segs_count=1 and a
    //     PARA_LINE_SEG record. Hancom Docs rejects break paragraphs
    //     that have line_segs_count=0 (the v1 attempt of Phase 4-2/3).
    const lineSegCount = isBreakOnly ? 1 : 0;
    const newHeader = buildClonedParaHeader(srcHeader, raw, newCharCount, false, newInstanceId, op.breakVal, lineSegCount);
    const newCharShape = buildSingleCharShapeRecord(records, raw, template.startIdx, template.endIdx, 1);

    let newCluster;
    if (isBreakOnly) {
      const lineSegBody = findAnyLineSegBody(records, raw);
      const newLineSeg = buildLineSegRecord(lineSegBody, 1);
      newCluster = Buffer.concat([newHeader, newCharShape, newLineSeg]);
    } else {
      const newText = buildBodyParaTextRecord(op.text);
      newCluster = Buffer.concat([newHeader, newText, newCharShape]);
    }

    // Insert at the end of the template cluster — i.e. right between
    // the last simple paragraph and whatever comes next (typically a
    // cover-page paragraph or stream end).
    const insertAt = template.endIdx < records.length
      ? records[template.endIdx].headOff
      : raw.length;
    raw = Buffer.concat([raw.slice(0, insertAt), newCluster, raw.slice(insertAt)]);
    summary.push({ section: 0, text: op.text });
  }

  // Deflate + write back (Phase 3/3b infrastructure).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.appended_count = summary.length;
  return result;
}


// ── 문단 띠 / 가로 구분선 (para-line horizontal divider) raw-patch ──────────
//
// GT-first (paraline_native.hwp, captured from Hancom's "문단 띠"): Hancom
// inserts a NEW paragraph whose only content is a gso (drawing object)
// holding a thin, full-text-width rectangle — i.e. a horizontal divider
// line. The cluster is self-contained in BodyText/Section0: the line's fill
// color lives inline in SHAPE_COMPONENT and a vector rectangle needs no
// BinData stream, so DocInfo is left untouched (no new BorderFill/style).
//
// Cluster shape (6 records, verbatim from GT except the noted patches):
//   PARA_HEADER  lvl0  control_mask=0x800 (has-gso), 9 chars, line_segs=0
//   PARA_TEXT    lvl1  inline extended gso ctrl char (8 code units) + EOP
//   PARA_CHAR_SHAPE lvl1  charPos0 / charShape0
//   CTRL_HEADER  lvl1  'gso ' CommonObjAttr — instance_id refreshed
//   SHAPE_COMPONENT lvl2 '$rec' — width scaled to page text-width
//   SHAPE_COMPONENT_RECTANGLE lvl3 — 4 corner points, width scaled
//
// GT rectangle width 0xa618 (42520) == its page text-width (paperW −
// marginL − marginR). For A4 docs this equals 42520, so the emitted bytes
// match GT exactly; for other page widths we scale the SHAPE_COMPONENT and
// rectangle extents. Hancom itself leaves the CommonObjAttr width nominal
// (10000) — the SHAPE_COMPONENT extent governs the rendered line — so we
// keep CTRL_HEADER verbatim aside from the instance_id refresh.
const PARALINE_GSO_CTRL_HEX  = '206f736710a329100000000000000000102700002c010000000000000000000000000000e0169142000000000d0038bbe8b260b75cb82000acc001ac15d6200085c7c8b2e4b22e00';
const PARALINE_SHAPE_HEX     = '636572246365722400000000000000000000010018a600002c01000018a600002c01000000000b00000000000000000000000100000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000000000000000000c000010000000000000000000000ffffffff000000000000000000b2b2b2000000000000000000e11691020000';
const PARALINE_RECT_HEX      = '00000000000000000018a600000000000018a600002c010000000000002c010000';
const PARALINE_GT_TEXT_WIDTH = 42520; // 0xa618 — GT base doc's page text-width

const TAG_SHAPE_COMPONENT = 0x4c;
const TAG_SHAPE_COMPONENT_RECTANGLE = 0x4f;

function buildParaLineCluster(textWidth, paraInstanceId, gsoInstanceId) {
  // PARA_HEADER (24B — the change-tracking-aware form Hancom emits in the GT;
  // trailing 2 bytes = change_tracking_state, left 0). The last-paragraph flag
  // (MSB of char_count) is left clear here and normalized across the section
  // after the splice.
  const ph = Buffer.alloc(24);
  ph.writeUInt32LE(9, 0);              // char_count = 9 (gso 8 units + EOP)
  ph.writeUInt32LE(0x800, 4);         // control_mask: has-gso bit
  ph.writeUInt16LE(0, 8);             // para_shape_id 0
  ph.writeUInt8(0, 10);               // style_id
  ph.writeUInt8(0, 11);               // break_val
  ph.writeUInt16LE(1, 12);            // num_char_shapes
  ph.writeUInt16LE(0, 14);            // range_tags_count
  ph.writeUInt16LE(0, 16);            // line_segs_count = 0 (GT; Hancom relays out)
  ph.writeUInt32LE(paraInstanceId >>> 0, 18);
  // bytes 22..23: change_tracking_state = 0

  // PARA_TEXT (18B): inline extended gso ctrl char (8 code units) + EOP.
  const pt = Buffer.alloc(18);
  pt.writeUInt16LE(0x000b, 0);
  pt[2] = 0x20; pt[3] = 0x6f; pt[4] = 0x73; pt[5] = 0x67; // 'gso '
  pt.writeUInt16LE(0x000b, 14);
  pt.writeUInt16LE(0x000d, 16);        // EOP

  const cs = Buffer.alloc(8);          // PARA_CHAR_SHAPE: charPos 0, charShape 0

  const ch = Buffer.from(PARALINE_GSO_CTRL_HEX, 'hex');
  ch.writeUInt32LE(gsoInstanceId >>> 0, 36); // refresh gso instance_id (CommonObjAttr@36)

  const sc = Buffer.from(PARALINE_SHAPE_HEX, 'hex');
  const rc = Buffer.from(PARALINE_RECT_HEX, 'hex');
  if (textWidth !== PARALINE_GT_TEXT_WIDTH) {
    sc.writeUInt32LE(textWidth >>> 0, 20); // SHAPE_COMPONENT curWidth
    sc.writeUInt32LE(textWidth >>> 0, 28); // SHAPE_COMPONENT initWidth
    rc.writeUInt32LE(textWidth >>> 0, 9);  // rectangle x of points 1,2 (right edge)
    rc.writeUInt32LE(textWidth >>> 0, 17);
  }

  const parts = [
    [TAG_PARA_HEADER, 0, ph],
    [TAG_PARA_TEXT, 1, pt],
    [TAG_PARA_CHAR_SHAPE, 1, cs],
    [TAG_CTRL_HEADER, 1, ch],
    [TAG_SHAPE_COMPONENT, 2, sc],
    [TAG_SHAPE_COMPONENT_RECTANGLE, 3, rc],
  ];
  const chunks = [];
  for (const [tag, lvl, body] of parts) {
    chunks.push(buildRecordHeader(tag, lvl, body.length), body);
  }
  return Buffer.concat(chunks);
}

// Shift every record's nesting level by `delta` (preserving tag + size). Used to
// drop a body-built gso cluster (image/shape) into a table cell, whose paragraphs
// sit two levels deeper than the body (cell PARA_HEADER = level 2 vs body level 0).
function relevelCluster(cluster, delta) {
  const out = Buffer.from(cluster);
  let p = 0;
  while (p + 4 <= out.length) {
    const h = out.readUInt32LE(p);
    let size = (h >>> 20) & 0xfff;
    let hd = 4;
    if (size === 0xfff) { size = out.readUInt32LE(p + 4); hd = 8; }
    const level = (((h >>> 10) & 0x3ff) + delta) & 0x3ff;
    out.writeUInt32LE(((h & ~(0x3ff << 10)) | (level << 10)) >>> 0, p);
    p += hd + size;
  }
  return out;
}

// Set the gso object's outer top+bottom margin (개체 위/아래 여백) inside a built
// cluster — finds the ' osg' CTRL_HEADER and writes u16 HWPUNIT at the top(@32)/
// bottom(@34) slots of its CommonObjAttr outMargin (left@28/right@30 left as-is).
// Used so objects dropped into a cell get a little vertical breathing room (the
// cell row grows to fit). Left/right stay default per user.
function setGsoOutMarginTopBottom(cluster, hu) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p);
    const tag = h & 0x3ff; let size = (h >>> 20) & 0xfff; let hd = 4;
    if (size === 0xfff) { size = cluster.readUInt32LE(p + 4); hd = 8; }
    const body = p + hd;
    if (tag === TAG_CTRL_HEADER && size >= 36 && cluster.slice(body, body + 4).toString('latin1') === GSO_CTRL_ID) {
      cluster.writeUInt16LE(hu & 0xFFFF, body + 32);
      cluster.writeUInt16LE(hu & 0xFFFF, body + 34);
      return;
    }
    p += hd + size;
  }
}
const CELL_OBJ_VMARGIN_HU = 283; // ~1 mm default top/bottom margin for in-cell objects

// Set the first PARA_HEADER's para_shape_id (body @8) in a built object cluster —
// used to center an object paragraph dropped into a cell.
function setClusterParaShape(cluster, psId) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p);
    const tag = h & 0x3ff; let size = (h >>> 20) & 0xfff; let hd = 4;
    if (size === 0xfff) { size = cluster.readUInt32LE(p + 4); hd = 8; }
    if (tag === TAG_PARA_HEADER) { cluster.writeUInt16LE(psId & 0xFFFF, p + hd + 8); return; }
    p += hd + size;
  }
}

// Drop a body-built self-contained gso cluster (image / shape / chart) into a table
// cell: re-level +2, center it, add the default vertical margin, splice at the cell
// end, bump the cell's paragraph count, fix the cell's last-para flag. Returns the
// new `raw`. (locateCell-by-row/col via tableCellRecords.)
function spliceGsoIntoCell(raw, cluster, para, control, row, col, centerPsId) {
  const target = tableCellRecords(parseRecords(raw), raw, para, control)
    .find((c) => c.row === row && c.col === col);
  if (!target) throw new Error(`cell (row=${row}, col=${col}) not found in table at para ${para} control ${control}`);
  const cellCluster = relevelCluster(cluster, 2);
  setClusterParaShape(cellCluster, centerPsId);
  setGsoOutMarginTopBottom(cellCluster, CELL_OBJ_VMARGIN_HU);
  raw = Buffer.concat([raw.slice(0, target.endByte), cellCluster, raw.slice(target.endByte)]);
  const t2 = tableCellRecords(parseRecords(raw), raw, para, control)
    .find((c) => c.row === row && c.col === col);
  const lhDataOff = t2.startByte + 4;
  raw.writeUInt16LE((raw.readUInt16LE(lhDataOff) + 1) & 0xFFFF, lhDataOff); // nParagraphs++
  normalizeCellLastParaFlag(raw, t2.startByte, t2.endByte, 2);
  return raw;
}

// Inside a cell whose first paragraph is at `cellParaLevel` (2 for table cells):
// set the last-paragraph flag (MSB of char_count) on the LAST PARA_HEADER of that
// level within [startByte, endByte) and clear it on the earlier ones. Mirrors
// normalizeLastParaFlag but scoped to a cell (whose paragraphs are level 2).
function normalizeCellLastParaFlag(raw, startByte, endByte, cellParaLevel) {
  const records = parseRecords(raw);
  let lastIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.headOff < startByte || r.headOff >= endByte) continue;
    if (r.tag === TAG_PARA_HEADER && r.level === cellParaLevel) lastIdx = i;
  }
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.headOff < startByte || r.headOff >= endByte) continue;
    if (r.tag !== TAG_PARA_HEADER || r.level !== cellParaLevel || r.size < 4) continue;
    const low = raw.readUInt32LE(r.dataOff) & 0x7FFFFFFF;
    raw.writeUInt32LE(((i === lastIdx ? 0x80000000 : 0) | low) >>> 0, r.dataOff);
  }
}

// Ensure exactly the last level-0 PARA_HEADER carries the last-paragraph
// flag (MSB of char_count). Length-preserving in-place edit on `raw`.
// Hancom moves this flag onto a newly-inserted trailing paragraph, and
// rejects sections where it is absent or duplicated.
function normalizeLastParaFlag(raw) {
  const records = parseRecords(raw);
  let lastIdx = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag === TAG_PARA_HEADER && records[i].level === 0) lastIdx = i;
  }
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag !== TAG_PARA_HEADER || r.level !== 0 || r.size < 4) continue;
    const low = raw.readUInt32LE(r.dataOff) & 0x7FFFFFFF;
    raw.writeUInt32LE(((i === lastIdx ? 0x80000000 : 0) | low) >>> 0, r.dataOff);
  }
}

// Page text-width (HWPUNIT) = paper width − left margin − right margin,
// read from the section's PAGE_DEF. Falls back to the GT A4 text-width.
function readTextWidthFromPageDef(records, raw) {
  for (const r of records) {
    if (r.tag === TAG_PAGE_DEF && r.size >= 16) {
      const tw = raw.readUInt32LE(r.dataOff) - raw.readUInt32LE(r.dataOff + 8) - raw.readUInt32LE(r.dataOff + 12);
      if (tw > 0) return tw >>> 0;
    }
  }
  return PARALINE_GT_TEXT_WIDTH;
}

// Insert a horizontal divider line (문단 띠) as a new paragraph. Each op:
//   { anchor?: string }   — insert right after the paragraph whose text
//                           contains `anchor`; if omitted, after the last
//                           simple body paragraph.
export async function insertParaLineInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const records = parseRecords(raw);
    const textWidth = readTextWidthFromPageDef(records, raw);

    // Insertion point.
    let insertAt;
    let anchorUsed = null;
    if (op.anchor && typeof op.anchor === 'string') {
      const clusters = findClusterBoundaries(records);
      let found = null;
      for (const c of clusters) {
        // Scan PARA_TEXT at ANY level inside the cluster: in fully
        // table-based forms the anchor text lives in cell paragraphs
        // (level 3+), not the top-level body. We insert the divider after
        // the whole top-level cluster that contains the match.
        let text = '';
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT) {
            text += raw.slice(r.dataOff, r.dataOff + r.size).toString('utf16le');
          }
        }
        if (text.includes(op.anchor)) { found = c; break; }
      }
      if (!found) throw new Error(`insert_para_line: anchor not found: ${JSON.stringify(op.anchor)}`);
      insertAt = found.endIdx < records.length ? records[found.endIdx].headOff : raw.length;
      anchorUsed = op.anchor;
    } else {
      const template = findLastSimpleBodyParagraph(records);
      insertAt = template.endIdx < records.length ? records[template.endIdx].headOff : raw.length;
    }

    const paraInstanceId = pickFreshInstanceId(records, raw);
    const gsoInstanceId = (paraInstanceId + 0x100) >>> 0;
    const cluster = buildParaLineCluster(textWidth, paraInstanceId, gsoInstanceId);
    raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);
    normalizeLastParaFlag(raw);
    summary.push({ section: 0, anchor: anchorUsed, text_width: textWidth });
  }

  // Deflate + write back (same infrastructure as appendParagraphInPlace).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 누름틀 / 입력 필드 (form field) raw-patch ──────────────────────────────
//
// GT-first (field_native.hwp, captured from Hancom's 입력 › 필드/누름틀): a
// 누름틀 is the HWP "field" mechanism — an inline field-begin char (0x0003)
// and field-end char (0x0004) wrapping the guide text, plus a CTRL_HEADER
// ('%clk', stored reversed as "klc%") carrying the field command string, and
// a small 0x57 field-data record. Self-contained in Section0 — no DocInfo
// change (it reuses existing char shapes).
//
//   PARA_TEXT: <existing text up to anchor> [FIELD_BEGIN 8u] <guide> [FIELD_END 8u] …
//   PARA_HEADER: char_count += 16 (begin+end) + guide.length;
//                control_mask |= 0x18  (control-char bitmask: chars 0x03 & 0x04 now present)
//   + CTRL_HEADER '%clk' (lvl1) at the end of the paragraph's controls
//   + 0x57 field-data record (lvl2)
//
// control_mask is a bitmask of which control-char codes (0..31) appear in the
// paragraph, so OR-ing in (1<<3)|(1<<4) is correct for any document.
//
// The same field mechanism backs hyperlinks (0x0003/0x0004 + a CTRL command
// string), so this is also the anchor-based path to hyperlinks that avoids
// the cloud editor's fragile drag-select.
const FIELD_BEGIN_HEX = '03006b6c632500000000000000000300'; // 0x0003 + '%clk' + 0x0003 (8 units)
const FIELD_END_HEX   = '04006b6c630901000000000000000400'; // 0x0004 + '%clk' + 0x0004 (8 units)
const FIELD_CTRL_ID   = Buffer.from('6b6c6325', 'hex');      // 'klc%' (= '%clk' reversed)
// 0x57 field-data record body (18 bytes) — reproduced from GT verbatim.
const FIELD_DATA_HEX  = '1b020100000000400100030085c725b880b7';
const TAG_FIELD_DATA  = 0x57;

// Build the field command string Hancom stores in the '%clk' CTRL_HEADER.
function buildFieldCommand(guide) {
  return `Clickhere:set:56:Direction:wstring:${guide.length}:${guide} HelpState:wstring:0:  `;
}

// CTRL_HEADER '%clk' body: ctrlId + 01000000 + 09 + u16 cmdLen + cmd(UTF16) + u32 instanceId + 00000000
function buildFieldCtrlRecord(guide, instanceId) {
  const cmd = buildFieldCommand(guide);
  const cmdBuf = Buffer.from(cmd, 'utf16le');
  const body = Buffer.concat([
    FIELD_CTRL_ID,
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x09]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(cmd.length, 0); return b; })(),
    cmdBuf,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(instanceId >>> 0, 0); return b; })(),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
  return Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, body.length), body]);
}

function buildFieldDataRecord() {
  const body = Buffer.from(FIELD_DATA_HEX, 'hex');
  return Buffer.concat([buildRecordHeader(TAG_FIELD_DATA, 2, body.length), body]);
}

// Insert a 누름틀 form field after the anchor text. Each op:
//   { anchor: string, guide?: string, field_name?: string }
//   - anchor: text to place the field right after (must be plain text in a
//             level-1 PARA_TEXT of a top-level paragraph)
//   - guide:  the placeholder/guide text shown in the field (default '입력')
export async function insertFieldInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') {
      throw new Error('insert_field: an "anchor" string is required');
    }
    const guide = (typeof op.guide === 'string' && op.guide) ? op.guide : '입력';
    const records = parseRecords(raw);

    // Locate the top-level paragraph cluster containing the anchor, and the
    // level-1 PARA_TEXT record holding the anchor text.
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null, anchorByteOff = -1;
    const anchorBuf = Buffer.from(op.anchor, 'utf16le');
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
        const body = raw.slice(r.dataOff, r.dataOff + r.size);
        const at = body.indexOf(anchorBuf);
        if (at !== -1) { cluster = c; ptRec = r; anchorByteOff = at + anchorBuf.length; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error(`insert_field: anchor not found in a top-level paragraph: ${JSON.stringify(op.anchor)}`);

    const paraHeaderRec = records[cluster.startIdx];
    const instanceId = pickFreshInstanceId(records, raw);

    // 1) Build the new PARA_TEXT body: insert FIELD_BEGIN + guide + FIELD_END
    //    right after the anchor text.
    const fieldBegin = Buffer.from(FIELD_BEGIN_HEX, 'hex');
    const fieldEnd = Buffer.from(FIELD_END_HEX, 'hex');
    const guideBuf = Buffer.from(guide, 'utf16le');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const newBody = Buffer.concat([
      oldBody.slice(0, anchorByteOff), fieldBegin, guideBuf, fieldEnd, oldBody.slice(anchorByteOff),
    ]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) Field control records appended at the end of the paragraph's cluster.
    const ctrlRec = buildFieldCtrlRecord(guide, instanceId);
    const dataRec = buildFieldDataRecord();
    const fieldCtrlBlock = Buffer.concat([ctrlRec, dataRec]);
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch (length-preserving): char_count += (16 + guide.len),
    //    control_mask |= 0x18 (chars 0x03 & 0x04 now present).
    const addedUnits = 8 + guide.length + 8; // begin(8u) + guide + end(8u)
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    const newCount = ((flag | ((curCount & 0x7FFFFFFF) + addedUnits)) >>> 0);
    const newMask = (raw.readUInt32LE(phOff + 4) | 0x18) >>> 0;

    // Apply: header edit in place, then splice high→low (cluster-end first,
    // then PARA_TEXT replacement) so earlier offsets stay valid.
    raw.writeUInt32LE(newCount, phOff);
    raw.writeUInt32LE(newMask, phOff + 4);
    raw = Buffer.concat([raw.slice(0, clusterEndOff), fieldCtrlBlock, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([
      raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size),
    ]);

    summary.push({ section: 0, anchor: op.anchor, guide, field_name: op.field_name ?? null });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 책갈피 (bookmark) raw-patch ────────────────────────────────────────────
// GT-first (Hancom's 입력 › 책갈피): a bookmark is an invisible point-marker in
// the same inline-control family as fields/gso. After the anchor text it adds
// an 8-unit inline control (char 0x0016 + 'bokm' id + reserved + 0x0016), then
// a 'bokm' CTRL_HEADER and a 0x57 FIELD_DATA record holding the mark name:
//   PARA_TEXT:  … <anchor> [0x16 'bokm' 0×4u 0x16  (8 units)] …
//   PARA_HEADER: char_count += 8; control_mask |= 0x400000 (char 0x16 present)
//   + CTRL_HEADER 'bokm' (lvl1, 4-byte id) + FIELD_DATA 0x57 (lvl2: 10-byte
//     GT prefix + nameLen + UTF-16 name)
// Self-contained in Section0 — no DocInfo change. Renders nothing visible;
// verify by reopening in Hancom (책갈피 목록) — there is no visual mark.
const BOOKMARK_MARK_HEX = '16006d6b6f6200000000000000001600'; // 0x16 + 'bokm'(rev) + reserved + 0x16 (8 units)
const BOOKMARK_CTRL_ID = Buffer.from('6d6b6f62', 'hex');      // 'bokm' stored reversed
const BOOKMARK_DATA_PREFIX = Buffer.from('1b020100000000400100', 'hex'); // 10-byte GT-verbatim prefix

function buildBookmarkCtrlRecord() {
  return Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, BOOKMARK_CTRL_ID.length), BOOKMARK_CTRL_ID]);
}
function buildBookmarkDataRecord(name) {
  const nameBuf = Buffer.from(name, 'utf16le');
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16LE(name.length, 0);
  const body = Buffer.concat([BOOKMARK_DATA_PREFIX, lenBuf, nameBuf]);
  return Buffer.concat([buildRecordHeader(TAG_FIELD_DATA, 2, body.length), body]);
}

// Insert a bookmark at `anchor`. Each op: { anchor: string, mark_name: string }
export async function insertBookmarkInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') throw new Error('insert_bookmark: an "anchor" string is required');
    const markName = (typeof op.mark_name === 'string' && op.mark_name) ? op.mark_name : '책갈피';
    const records = parseRecords(raw);

    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null, anchorByteOff = -1;
    const anchorBuf = Buffer.from(op.anchor, 'utf16le');
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
        const at = raw.slice(r.dataOff, r.dataOff + r.size).indexOf(anchorBuf);
        if (at !== -1) { cluster = c; ptRec = r; anchorByteOff = at + anchorBuf.length; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error(`insert_bookmark: anchor not found in a top-level paragraph: ${JSON.stringify(op.anchor)}`);

    const paraHeaderRec = records[cluster.startIdx];

    // 1) Insert the 8-unit inline bookmark marker right after the anchor text.
    const mark = Buffer.from(BOOKMARK_MARK_HEX, 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const newBody = Buffer.concat([oldBody.slice(0, anchorByteOff), mark, oldBody.slice(anchorByteOff)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) bokm control records appended at the end of the paragraph cluster.
    const ctrlBlock = Buffer.concat([buildBookmarkCtrlRecord(), buildBookmarkDataRecord(markName)]);
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER: char_count += 8, control_mask |= 0x400000 (char 0x16).
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0, phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x400000) >>> 0, phOff + 4);

    // Splice high→low so earlier offsets stay valid.
    raw = Buffer.concat([raw.slice(0, clusterEndOff), ctrlBlock, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, anchor: op.anchor, mark_name: markName });
  }

  // Deflate + write back (identical to insertFieldInPlace).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] }, raw, chain);
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart; newCompressed = ext.compressed;
    if (ext.promoted) { chain = ext.newRegularChain; writeChainBytes(buf, chain, ssz, newCompressed); buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74); }
    else { rootChain = ext.rootChain; chain = ext.miniChain; writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed); }
  } else {
    const ext = deflateAndFitWithExpansion(raw, chain.length * ssz, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain; newCompressed = ext.compressed; writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 하이퍼링크 (hyperlink) raw-patch ───────────────────────────────────────
//
// GT-first (hyperlink_native.hwp, captured from Hancom's 입력 › 하이퍼링크):
// a hyperlink is the same HWP field mechanism as 누름틀 (insertFieldInPlace),
// except it WRAPS existing anchor text instead of inserting guide text, uses
// ctrl id '%hlk' (stored reversed as "klh%"), carries a different field
// command string, and has no 0x57 data record:
//
//   PARA_TEXT: … [FIELD_BEGIN 8u] <anchor text> [FIELD_END 8u] …
//   PARA_HEADER: char_count += 16; control_mask |= 0x18 (chars 0x03 & 0x04)
//   + CTRL_HEADER '%hlk' (lvl1) with command  "<url>;1;0;0;"  (':' → '\:')
//
// v1 ships a FUNCTIONAL link (correct URL, clickable) but does NOT recolor
// the anchor text blue/underline — Hancom stores that as extra char-shape
// ranges referencing DocInfo char shapes, which would need DocInfo synthesis.
// Callers wanting the blue underline can layer apply_text_style on the same
// anchor text. Self-contained in Section0 — no DocInfo change.
const HLINK_BEGIN_HEX = '03006b6c682500000000000000000300'; // 0x0003 + '%hlk' + 0x0003
const HLINK_END_HEX   = '04006b6c680000000000000000000400'; // 0x0004 + '%hlk' + 0x0004
const HLINK_CTRL_ID   = Buffer.from('6b6c6825', 'hex');      // 'klh%' (= '%hlk' reversed)
// 5-byte property prefix between ctrlId and the command length (GT verbatim).
const HLINK_CTRL_PREFIX = Buffer.from([0x00, 0x28, 0x00, 0x00, 0x00]);

function buildHyperlinkCommand(url) {
  // Hancom escapes ':' as '\:' in the field command (':' is its separator).
  return `${String(url).replace(/:/g, '\\:')};1;0;0;`;
}

function buildHyperlinkCtrlRecord(url, instanceId) {
  const cmd = buildHyperlinkCommand(url);
  const cmdBuf = Buffer.from(cmd, 'utf16le');
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16LE(cmd.length, 0);
  const instBuf = Buffer.alloc(4); instBuf.writeUInt32LE(instanceId >>> 0, 0);
  const body = Buffer.concat([
    HLINK_CTRL_ID, HLINK_CTRL_PREFIX, lenBuf, cmdBuf, instBuf, Buffer.from([0, 0, 0, 0]),
  ]);
  return Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, body.length), body]);
}

// Turn existing anchor text into a hyperlink. Each op:
//   { anchor: string, url: string }
//   - anchor must be plain text in a level-1 PARA_TEXT of a top-level paragraph
export async function insertHyperlinkInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') throw new Error('hyperlink: an "anchor" string is required');
    if (!op.url || typeof op.url !== 'string') throw new Error('hyperlink: a "url" string is required');
    const records = parseRecords(raw);

    // Locate the anchor text inside a level-1 PARA_TEXT of a top-level paragraph.
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null, anchorStart = -1;
    const anchorBuf = Buffer.from(op.anchor, 'utf16le');
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
        const body = raw.slice(r.dataOff, r.dataOff + r.size);
        const at = body.indexOf(anchorBuf);
        if (at !== -1) { cluster = c; ptRec = r; anchorStart = at; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error(`hyperlink: anchor not found in a top-level paragraph: ${JSON.stringify(op.anchor)}`);

    const paraHeaderRec = records[cluster.startIdx];
    const instanceId = pickFreshInstanceId(records, raw);

    // 1) Wrap the anchor text: FIELD_BEGIN before it, FIELD_END after it.
    const fieldBegin = Buffer.from(HLINK_BEGIN_HEX, 'hex');
    const fieldEnd = Buffer.from(HLINK_END_HEX, 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const anchorEnd = anchorStart + anchorBuf.length;
    const newBody = Buffer.concat([
      oldBody.slice(0, anchorStart), fieldBegin,
      oldBody.slice(anchorStart, anchorEnd), fieldEnd,
      oldBody.slice(anchorEnd),
    ]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) CTRL_HEADER '%hlk' appended at the end of the paragraph's controls.
    const ctrlRec = buildHyperlinkCtrlRecord(op.url, instanceId);
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 16 (begin+end), control_mask |= 0x18.
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 16)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x18) >>> 0, phOff + 4);

    // Splice high→low: CTRL at cluster end first, then PARA_TEXT replacement.
    raw = Buffer.concat([raw.slice(0, clusterEndOff), ctrlRec, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, anchor: op.anchor, url: op.url });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 각주 (footnote) raw-patch ──────────────────────────────────────────────
//
// GT-first (footnote_native.hwp, captured from Hancom's 입력 › 주석 › 각주):
//   - Main paragraph: an inline footnote-reference char (0x0011, ctrl id
//     "fn  ") is inserted at the anchor; PARA_HEADER char_count += 8 and
//     control_mask |= (1<<0x11)=0x20000.
//   - The footnote content is appended as a nested cluster on the same
//     paragraph (after its other controls):
//       CTRL_HEADER "fn  "  (lvl1)
//       LIST_HEADER         (lvl2, nParas=1)
//       PARA_HEADER         (lvl2) — style = the doc's "Footnote" style index,
//                                    para_shape/char_shape = that style's refs
//       PARA_TEXT           (lvl3) — auto-number ctrl (0x0012 "onta") + " " +
//                                    footnote text + EOP
//       PARA_CHAR_SHAPE     (lvl3)
//       CTRL_HEADER "onta"  (lvl3) — the auto-number control
//
// DocInfo is only READ, never written: every HWP doc ships a standard
// "Footnote" style, and the footnote separator line + numbering are rendered
// by Hancom from the always-present FOOTNOTE_SHAPE records. So this is a
// resolution (not synthesis) op — self-contained writes stay in Section0.
// 각주(footnote) / 미주(endnote) share the same structure — they differ only
// in the field ctrl id ('fn  ' vs 'en  '), the named style they resolve, and
// the auto-number control's note-type byte (1 = footnote, 2 = endnote).
const NOTE_KINDS = {
  footnote: { refCharHex: '110020206e6600000000000000001100', ctrlId: '20206e66', styleName: 'Footnote', ontaType: 1 },
  endnote:  { refCharHex: '110020206e6500000000000000001100', ctrlId: '20206e65', styleName: 'Endnote',  ontaType: 2 },
};
const NOTE_LIST_HEADER_HEX = '01000000000000000000000000000000'; // nParas=1
const NOTE_AUTONUM_HEX     = '12006f6e746100000000000000001200'; // 0x0012 + 'onta' + 0x0012

const TAG_STYLE_DI = 0x1a;  // HWPTAG_STYLE in DocInfo

// Read a named style by its Korean OR English name: its index (0-based among
// STYLE records) plus the para_shape and char_shape ids it references. The
// returned `found` flag distinguishes a real match from the {0,0,0} fallback.
function resolveNoteStyle(buf, styleName) {
  const di = readDecodedStreamFromCfb(buf, ['DocInfo']);
  let sidx = 0;
  for (const r of parseRecords(di)) {
    if (r.tag !== TAG_STYLE_DI) continue;
    const sb = di.slice(r.dataOff, r.dataOff + r.size);
    const nlen = sb.readUInt16LE(0);
    let off = 2;
    const kor = sb.slice(off, off + nlen * 2).toString('utf16le'); off += nlen * 2;
    const elen = sb.readUInt16LE(off); off += 2;
    const eng = sb.slice(off, off + elen * 2).toString('utf16le'); off += elen * 2;
    // off → prop(u8) next(u8) lang(u16) paraShape(u16) charShape(u16)
    if (eng === styleName || kor === styleName) {
      return { index: sidx, paraShape: sb.readUInt16LE(off + 4), charShape: sb.readUInt16LE(off + 6), found: true };
    }
    sidx++;
  }
  // Fallback: no such named style — use style 0 / shape 0.
  return { index: 0, paraShape: 0, charShape: 0, found: false };
}

// List every style's (korean, english) names — used to report choices when a
// requested style name isn't found.
function listStyleNames(buf) {
  const di = readDecodedStreamFromCfb(buf, ['DocInfo']);
  const names = [];
  for (const r of parseRecords(di)) {
    if (r.tag !== TAG_STYLE_DI) continue;
    const sb = di.slice(r.dataOff, r.dataOff + r.size);
    const nlen = sb.readUInt16LE(0);
    const kor = sb.slice(2, 2 + nlen * 2).toString('utf16le');
    const elen = sb.readUInt16LE(2 + nlen * 2);
    const eng = sb.slice(4 + nlen * 2, 4 + nlen * 2 + elen * 2).toString('utf16le');
    names.push(kor || eng);
  }
  return names;
}

// Apply a named paragraph style to the paragraph containing `anchor`. This is
// a length-preserving PARA_HEADER edit: style id (offset 10) and para_shape id
// (offset 8) are repointed to the resolved style. Character shapes are left
// as-is (matching Hancom's 스타일 combo, which sets paragraph-level style only).
export async function applyNamedStyleInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', applied_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') throw new Error('apply_style: an "anchor" string is required');
    if (!op.style || typeof op.style !== 'string') throw new Error('apply_style: a "style" name is required');
    const style = resolveNoteStyle(buf, op.style);
    if (!style.found) {
      throw new Error(`apply_style: style not found: ${JSON.stringify(op.style)} (available: ${listStyleNames(buf).join(', ')})`);
    }
    const records = parseRecords(raw);
    const clusters = findClusterBoundaries(records);
    let phRec = null;
    const anchorBuf = Buffer.from(op.anchor, 'utf16le');
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag === TAG_PARA_TEXT && r.level === 1 &&
            raw.slice(r.dataOff, r.dataOff + r.size).indexOf(anchorBuf) !== -1) {
          phRec = records[c.startIdx]; break;
        }
      }
      if (phRec) break;
    }
    if (!phRec) throw new Error(`apply_style: anchor not found in a top-level paragraph: ${JSON.stringify(op.anchor)}`);

    // Length-preserving: para_shape id @8 (u16), style id @10 (u8).
    raw.writeUInt16LE(style.paraShape & 0xFFFF, phRec.dataOff + 8);
    raw.writeUInt8(style.index & 0xFF, phRec.dataOff + 10);
    summary.push({ section: 0, anchor: op.anchor, style: op.style, style_index: style.index });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.applied_count = summary.length;
  return result;
}

// Build a note (footnote/endnote) content cluster (6 records).
function buildNoteCluster(text, style, noteInstanceId, kind) {
  // CTRL_HEADER 'fn  '/'en  ' (20B): ctrlId + 01000000 + 00002900 + 00000000 + instanceId
  const ctrlBody = Buffer.concat([
    Buffer.from(kind.ctrlId, 'hex'),
    Buffer.from('010000000000290000000000', 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(noteInstanceId >>> 0, 0); return b; })(),
  ]);
  const ctrl = Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, ctrlBody.length), ctrlBody]);

  const listHeader = Buffer.concat([
    buildRecordHeader(TAG_LIST_HEADER, 2, 16), Buffer.from(NOTE_LIST_HEADER_HEX, 'hex'),
  ]);

  // PARA_TEXT (lvl3): auto-number ctrl + " " + text + EOP
  const ptBody = Buffer.concat([
    Buffer.from(NOTE_AUTONUM_HEX, 'hex'), Buffer.from(' ' + text + PARA_TEXT_EOP, 'utf16le'),
  ]);
  const charCount = 8 + 1 + text.length + 1; // autonum(8u) + space + text + EOP

  // PARA_HEADER (lvl2, 24B): last-para flag set; style/para_shape resolved.
  const ph = Buffer.alloc(24);
  ph.writeUInt32LE(((0x80000000 | (charCount & 0x7FFFFFFF)) >>> 0), 0);
  ph.writeUInt32LE(0x40000, 4);             // control_mask: char 0x12 (auto-number) present
  ph.writeUInt16LE(style.paraShape & 0xFFFF, 8);
  ph.writeUInt8(style.index & 0xFF, 10);    // style id = resolved note-style index
  ph.writeUInt8(0, 11);
  ph.writeUInt16LE(1, 12);                  // num_char_shapes
  ph.writeUInt16LE(0, 14);
  ph.writeUInt16LE(0, 16);                  // line_segs_count
  ph.writeUInt32LE(0, 18);
  const paraHeader = Buffer.concat([buildRecordHeader(TAG_PARA_HEADER, 2, 24), ph]);

  const paraText = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 3, ptBody.length), ptBody]);

  const csBody = Buffer.alloc(8);
  csBody.writeUInt32LE(0, 0);
  csBody.writeUInt32LE(style.charShape >>> 0, 4);
  const charShape = Buffer.concat([buildRecordHeader(TAG_PARA_CHAR_SHAPE, 3, 8), csBody]);

  // Auto-number CTRL_HEADER 'onta': ctrlId + u32 noteType (1=footnote,2=endnote)
  // + 01000000 + 00002900
  const ontaBody = Buffer.concat([
    Buffer.from('6f6e7461', 'hex'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(kind.ontaType >>> 0, 0); return b; })(),
    Buffer.from('0100000000002900', 'hex'),
  ]);
  const onta = Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 3, 16), ontaBody]);

  return Buffer.concat([ctrl, listHeader, paraHeader, paraText, charShape, onta]);
}

// Insert a footnote/endnote anchored to text. `kind` is NOTE_KINDS.footnote
// or NOTE_KINDS.endnote. Each op:
//   { anchor: string, text: string }
//   - anchor: text the note mark goes right after (level-1 PARA_TEXT of a
//             top-level paragraph)
//   - text:   the note content (footnote: bottom of page; endnote: doc end)
async function insertNoteInPlace(filePath, ops, kind) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const noteStyle = resolveNoteStyle(buf, kind.styleName);

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') throw new Error(`${kind.styleName}: an "anchor" string is required`);
    const text = (typeof op.text === 'string') ? op.text : '';
    const records = parseRecords(raw);

    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null, anchorEnd = -1;
    const anchorBuf = Buffer.from(op.anchor, 'utf16le');
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag !== TAG_PARA_TEXT || r.level !== 1) continue;
        const body = raw.slice(r.dataOff, r.dataOff + r.size);
        const at = body.indexOf(anchorBuf);
        if (at !== -1) { cluster = c; ptRec = r; anchorEnd = at + anchorBuf.length; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error(`${kind.styleName}: anchor not found in a top-level paragraph: ${JSON.stringify(op.anchor)}`);

    const paraHeaderRec = records[cluster.startIdx];
    const noteInstanceId = pickFreshInstanceId(records, raw);

    // 1) Insert the note-reference char after the anchor in PARA_TEXT.
    const refChar = Buffer.from(kind.refCharHex, 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const newBody = Buffer.concat([oldBody.slice(0, anchorEnd), refChar, oldBody.slice(anchorEnd)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) Note content cluster appended at the end of the paragraph's records.
    const fnCluster = buildNoteCluster(text, noteStyle, noteInstanceId, kind);
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 8, control_mask |= 0x20000 (char 0x11).
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x20000) >>> 0, phOff + 4);

    // Splice high→low: content cluster at cluster end, then PARA_TEXT replace.
    raw = Buffer.concat([raw.slice(0, clusterEndOff), fnCluster, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, anchor: op.anchor, text });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}

export function insertFootnoteInPlace(filePath, ops) {
  return insertNoteInPlace(filePath, ops, NOTE_KINDS.footnote);
}
export function insertEndnoteInPlace(filePath, ops) {
  return insertNoteInPlace(filePath, ops, NOTE_KINDS.endnote);
}


// ── 쪽 번호 (page number, footer) raw-patch ────────────────────────────────
//
// GT-first (pagenum_native.hwp, captured from Hancom's 쪽 › 꼬리말 › 쪽 번호):
// a page number is a footer control holding a paragraph whose only content is
// the page-number auto-field. Structurally like a footnote, but at the
// section's first paragraph and with note-type 0 (page number):
//   - first paragraph: inline footer char (0x0010, ctrl id "foot") + EOP;
//     PARA_HEADER char_count += 8, control_mask |= 0x10000.
//   - footer cluster appended on that paragraph:
//       CTRL_HEADER "foot"  (lvl1)
//       LIST_HEADER         (lvl2, width = text column, height = footer margin)
//       PARA_HEADER         (lvl2) — style = "Header" index; para_shape chosen
//                                    to match the requested alignment
//       PARA_TEXT           (lvl3) — auto-number ctrl (0x0012 "onta") + EOP
//       PARA_CHAR_SHAPE     (lvl3) — "Page Number" style's char shape
//       CTRL_HEADER "onta"  (lvl3) — note-type 0 (page number)
//
// Alignment note: Hancom stores alignment in the footer paragraph's
// para_shape. To stay Section0-only (no DocInfo write), we reference an
// EXISTING para_shape whose alignment matches `align`; if the document has
// none, we fall back to para_shape 0 (the number then follows that shape's
// alignment). Section0-only — no DocInfo change.
const PAGENUM_FOOTER_CHAR_HEX = '1000746f6f6600000000000000001000'; // 0x0010 + 'foot' + 0x0010
const PAGENUM_FOOT_CTRL_HEX    = '746f6f660000000001000000';          // CTRL_HEADER 'foot' body
const PAGENUM_HEADER_CHAR_HEX = '10006461656800000000000000001000'; // 0x0010 + 'head' + 0x0010 (GT pn_header)
const PAGENUM_HEAD_CTRL_HEX    = '646165680000000001000000';          // CTRL_HEADER 'head' body
const PAGENUM_ONTA_HEX         = '6f6e7461000000000100000000000000'; // auto-number CTRL, note-type 0
const ALIGN_BITS = { justify: 0, left: 1, right: 2, center: 3, distribute: 4 };

// Find an existing para_shape (DocInfo) whose attr1 alignment bits (2..4)
// match `align`; return its index, or 0 if none.
function findParaShapeByAlign(buf, align) {
  const want = ALIGN_BITS[align];
  if (want === undefined) return 0;
  const di = readDecodedStreamFromCfb(buf, ['DocInfo']);
  let idx = 0;
  for (const r of parseRecords(di)) {
    if (r.tag !== TAG_PARA_SHAPE) continue;
    if (((di.readUInt32LE(r.dataOff) >> 2) & 7) === want) return idx;
    idx++;
  }
  return 0;
}

// PAGE_DEF footer margin (HWPUNIT) — offset 28.
function readFooterMarginFromPageDef(records, raw) {
  for (const r of records) {
    if (r.tag === TAG_PAGE_DEF && r.size >= 32) return raw.readUInt32LE(r.dataOff + 28);
  }
  return 0x109c; // sensible default (~15mm)
}

// PAGE_DEF header margin (HWPUNIT) — offset 24.
function readHeaderMarginFromPageDef(records, raw) {
  for (const r of records) {
    if (r.tag === TAG_PAGE_DEF && r.size >= 28) return raw.readUInt32LE(r.dataOff + 24);
  }
  return 0x109c;
}

// Return the DocInfo para_shape index whose alignment matches `align`, creating
// one (a clone of para_shape 0 with the alignment set) if none exists. Writes
// the modified DocInfo back to the file. Used by the page-number op so its
// auto-number paragraph can be left/center/right regardless of what alignments
// the document already happens to define.
async function ensureAlignedParaShapeInFile(filePath, align) {
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRC = () => rootChain || (rootChain = walkChain(fat, entries[0].start));
  const diEntry = findStreamEntry(entries, ['DocInfo']);
  const inMini = diEntry.size < 4096;
  let chain, comp;
  if (inMini) { const rc = ensureRC(); chain = walkChain(minifat, diEntry.start); comp = readMiniChainBytes(buf, chain, rc, ssz, mssz, diEntry.size); }
  else { chain = walkChain(fat, diEntry.start); comp = readChainBytes(buf, chain, ssz, diEntry.size); }
  let diRaw = Buffer.from(inflateRawSync(comp));

  const want = ALIGN_BITS[align];
  const bodies = readParaShapeBodies(diRaw);
  for (let i = 0; i < bodies.length; i++) if (((bodies[i].readUInt32LE(0) >> 2) & 7) === want) return i;
  if (bodies.length === 0) return 0;

  const newBody = buildParaShapeBody(bodies[0], { alignment: align });
  const r = appendParaShapeToDocInfo(diRaw, newBody);
  diRaw = r.newDi;

  let newComp;
  if (inMini) {
    const rc = ensureRC();
    const ext = deflateMiniChainWithExpansion({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] }, diRaw, chain);
    buf = ext.buf; newComp = ext.compressed;
    if (ext.promoted) { writeChainBytes(buf, ext.newRegularChain, ssz, newComp); buf.writeInt32LE(ext.newRegularChain[0], diEntry.entryFileOffset + 0x74); }
    else { writeMiniChainBytes(buf, ext.miniChain, ext.rootChain, ssz, mssz, newComp); }
  } else {
    const ext = deflateAndFitWithExpansion(diRaw, chain.length * ssz, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; newComp = ext.compressed; writeChainBytes(buf, ext.chain, ssz, newComp);
  }
  buf.writeUInt32LE(newComp.length, diEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
  writeFileSync(filePath, buf);
  return r.newPsId;
}

// Insert a page number in the footer. Each op: { align?: "left"|"center"|"right" }
export async function insertPageNumberInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  // Pre-pass: ensure DocInfo has a para_shape for each requested alignment
  // (appends one if missing) so the auto-number paragraph aligns reliably.
  // This writes DocInfo, so it must run before we read the body buffer below.
  const alignToIdx = {};
  for (const op of ops) {
    const align = (op.align && ALIGN_BITS[op.align] !== undefined) ? op.align : 'center';
    if (!(align in alignToIdx)) alignToIdx[align] = await ensureAlignedParaShapeInFile(filePath, align);
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const headerStyle = resolveNoteStyle(buf, 'Header');
  const pageNumStyle = resolveNoteStyle(buf, 'Page Number');

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const align = (op.align && ALIGN_BITS[op.align] !== undefined) ? op.align : 'center';
    const where = op.where === 'header' ? 'header' : 'footer'; // default footer (back-compat)
    const isHeader = where === 'header';
    const records = parseRecords(raw);
    const textWidth = readTextWidthFromPageDef(records, raw);
    const margin = isHeader ? readHeaderMarginFromPageDef(records, raw) : readFooterMarginFromPageDef(records, raw);
    const paraShape = alignToIdx[align];

    // The header/footer attaches to the section's first top-level paragraph
    // that has a level-1 PARA_TEXT.
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null;
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag === TAG_PARA_TEXT && r.level === 1) { cluster = c; ptRec = r; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error('page_number: no top-level body paragraph found to host the footer');

    const paraHeaderRec = records[cluster.startIdx];
    const noteInstanceId = pickFreshInstanceId(records, raw);

    // 1) Insert the header/footer char right before the paragraph's EOP.
    const hfChar = Buffer.from(isHeader ? PAGENUM_HEADER_CHAR_HEX : PAGENUM_FOOTER_CHAR_HEX, 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const insAt = oldBody.length >= 2 ? oldBody.length - 2 : oldBody.length; // before EOP
    const newBody = Buffer.concat([oldBody.slice(0, insAt), hfChar, oldBody.slice(insAt)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) Header/footer cluster (header listAttr 0x00, footer 0x40).
    const ctrl = Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, 12), Buffer.from(isHeader ? PAGENUM_HEAD_CTRL_HEX : PAGENUM_FOOT_CTRL_HEX, 'hex')]);
    const lh = Buffer.alloc(34);
    lh.writeUInt32LE(1, 0);          // nParas
    lh.writeUInt32LE(isHeader ? 0x00 : 0x40, 4); // attr
    lh.writeUInt32LE(textWidth >>> 0, 8);
    lh.writeUInt32LE(margin >>> 0, 12);
    const listHeader = Buffer.concat([buildRecordHeader(TAG_LIST_HEADER, 2, 34), lh]);
    const ph = Buffer.alloc(24);
    ph.writeUInt32LE(((0x80000000 | 9) >>> 0), 0); // char_count 9 (autonum 8 + EOP), last-para flag
    ph.writeUInt32LE(0x40000, 4);                  // control_mask: char 0x12 (auto-number)
    ph.writeUInt16LE(paraShape & 0xFFFF, 8);
    ph.writeUInt8(headerStyle.index & 0xFF, 10);
    ph.writeUInt8(0, 11);
    ph.writeUInt16LE(1, 12);
    const phRec = Buffer.concat([buildRecordHeader(TAG_PARA_HEADER, 2, 24), ph]);
    const ptBody2 = Buffer.concat([Buffer.from(NOTE_AUTONUM_HEX, 'hex'), Buffer.from(PARA_TEXT_EOP, 'utf16le')]);
    const ptRec2 = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 3, ptBody2.length), ptBody2]);
    const csBody = Buffer.alloc(8); csBody.writeUInt32LE(pageNumStyle.charShape >>> 0, 4);
    const csRec = Buffer.concat([buildRecordHeader(TAG_PARA_CHAR_SHAPE, 3, 8), csBody]);
    const onta = Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 3, 16), Buffer.from(PAGENUM_ONTA_HEX, 'hex')]);
    const footerCluster = Buffer.concat([ctrl, listHeader, phRec, ptRec2, csRec, onta]);

    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 8, control_mask |= 0x10000 (char 0x10).
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x10000) >>> 0, phOff + 4);

    raw = Buffer.concat([raw.slice(0, clusterEndOff), footerCluster, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, where, align });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 다단 (multi-column) raw-patch ─────────────────────────────────────────
// GT-first (claw-hancomdocs `columns --count N` on a .hwp): the section's
// column layout lives in the "cold" (단 정의) CTRL_HEADER, a fixed 16-byte
// record: id "dloc" + attribute(u16) + gap(u16) + 8 reserved bytes. The
// attribute is 0x1000 (same-width flag) | (count << 2) | type(bits 0-1, 0 =
// 일반/newspaper). GT-confirmed: 1단=0x1004 gap0, 2단=0x1008 gap2268(8mm),
// 3단=0x100c gap1134(4mm). Every section already has a 1-단 cold control, so
// we just patch the count + gap in place (length-preserving, Section0-only,
// no DocInfo change). The body reflows into N columns.
const TAG_CTRL_HEADER_COLD = 0x47;
export async function setColumnsInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const count = [1, 2, 3].includes(op.count) ? op.count : 2;
    const gapHu = op.spacing_mm != null ? Math.round(op.spacing_mm * 283.46) : (count === 1 ? 0 : count === 3 ? 1134 : 2268);
    let patched = false;
    for (const r of parseRecords(raw)) {
      if (r.tag === TAG_CTRL_HEADER_COLD && r.size >= 8 && raw.slice(r.dataOff, r.dataOff + 4).toString('latin1') === 'dloc') {
        raw.writeUInt16LE((0x1000 | (count << 2)) & 0xFFFF, r.dataOff + 4); // same-width | count | type 0
        raw.writeUInt16LE(gapHu & 0xFFFF, r.dataOff + 6);                   // 단 사이 간격
        patched = true;
        break; // first section's column definition
      }
    }
    if (!patched) throw new Error('set_columns: no column-definition (cold) control found in Section0');
    summary.push({ section: 0, count, spacing_mm: op.spacing_mm ?? (count === 1 ? 0 : count === 3 ? 4 : 8) });
  }

  // Deflate + write back (length-preserving patch, but re-deflate to be safe).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] }, raw, chain);
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart; newCompressed = ext.compressed;
    if (ext.promoted) { chain = ext.newRegularChain; writeChainBytes(buf, chain, ssz, newCompressed); buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74); }
    else { rootChain = ext.rootChain; chain = ext.miniChain; writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed); }
  } else {
    const ext = deflateAndFitWithExpansion(raw, chain.length * ssz, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain; newCompressed = ext.compressed; writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 머리말 / 꼬리말 텍스트 (header / footer text) raw-patch ────────────────
//
// Derived from the verified page-number footer/header control structure
// (insertPageNumberInPlace) — same control + LIST_HEADER — but the content
// paragraph holds USER TEXT instead of the page-number auto-field (no
// auto-number control, control_mask 0). The header uses ctrl id "head"
// (GT pagenum_header.hwp) and the footer "foot" (GT pagenum_native.hwp);
// LIST_HEADER attr/height differ (header: attr 0, height = header margin;
// footer: attr 0x40, height = footer margin). Section0-only — no DocInfo
// write (resolves the existing "Header" style for the paragraph).
const HF_KINDS = {
  header: { ctrlId: '64616568', listAttr: 0x00, marginOff: 24 }, // 'head'
  footer: { ctrlId: '746f6f66', listAttr: 0x40, marginOff: 28 }, // 'foot'
};

// PAGE_DEF margin (HWPUNIT) at the given offset (24 = header, 28 = footer).
function readPageDefMargin(records, raw, off) {
  for (const r of records) {
    if (r.tag === TAG_PAGE_DEF && r.size >= off + 4) return raw.readUInt32LE(r.dataOff + off);
  }
  return 0x109c;
}

// Insert header/footer text. Each op: { where: "header"|"footer", text: string }
export async function insertHeaderFooterTextInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const hdrStyle = resolveNoteStyle(buf, 'Header');

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const where = (op.where === 'header') ? 'header' : 'footer';
    const kind = HF_KINDS[where];
    const text = (typeof op.text === 'string') ? op.text : '';
    if (!text) throw new Error(`${where}_text: a "text" string is required`);
    const records = parseRecords(raw);
    const textWidth = readTextWidthFromPageDef(records, raw);
    const margin = readPageDefMargin(records, raw, kind.marginOff);

    // Attach to the section's first top-level paragraph that has PARA_TEXT.
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null;
    for (const c of clusters) {
      for (let i = c.startIdx + 1; i < c.endIdx; i++) {
        const r = records[i];
        if (r.tag === TAG_PARA_TEXT && r.level === 1) { cluster = c; ptRec = r; break; }
      }
      if (ptRec) break;
    }
    if (!ptRec) throw new Error(`${where}_text: no top-level body paragraph found`);

    const paraHeaderRec = records[cluster.startIdx];

    // 1) Inline header/footer char (0x0010 + ctrlId) before the paragraph's EOP.
    const hfChar = Buffer.alloc(16);
    hfChar.writeUInt16LE(0x10, 0);
    Buffer.from(kind.ctrlId, 'hex').copy(hfChar, 2);
    hfChar.writeUInt16LE(0x10, 14);
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const insAt = oldBody.length >= 2 ? oldBody.length - 2 : oldBody.length;
    const newBody = Buffer.concat([oldBody.slice(0, insAt), hfChar, oldBody.slice(insAt)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) Header/footer cluster with a user-text paragraph.
    const ctrlBody = Buffer.concat([Buffer.from(kind.ctrlId, 'hex'), Buffer.from('0000000001000000', 'hex')]);
    const ctrl = Buffer.concat([buildRecordHeader(TAG_CTRL_HEADER, 1, 12), ctrlBody]);
    const lh = Buffer.alloc(34);
    lh.writeUInt32LE(1, 0);
    lh.writeUInt32LE(kind.listAttr, 4);
    lh.writeUInt32LE(textWidth >>> 0, 8);
    lh.writeUInt32LE(margin >>> 0, 12);
    const listHeader = Buffer.concat([buildRecordHeader(TAG_LIST_HEADER, 2, 34), lh]);
    const ph = Buffer.alloc(24);
    ph.writeUInt32LE(((0x80000000 | ((text.length + 1) & 0x7FFFFFFF)) >>> 0), 0); // text + EOP, last-para
    ph.writeUInt32LE(0, 4);                       // control_mask: plain text
    ph.writeUInt16LE(0, 8);                       // para_shape 0 (default alignment)
    ph.writeUInt8(hdrStyle.index & 0xFF, 10);
    ph.writeUInt8(0, 11);
    ph.writeUInt16LE(1, 12);
    const phRec = Buffer.concat([buildRecordHeader(TAG_PARA_HEADER, 2, 24), ph]);
    const ptBody2 = Buffer.from(text + PARA_TEXT_EOP, 'utf16le');
    const ptRec2 = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 3, ptBody2.length), ptBody2]);
    const csBody = Buffer.alloc(8); csBody.writeUInt32LE(hdrStyle.charShape >>> 0, 4);
    const csRec = Buffer.concat([buildRecordHeader(TAG_PARA_CHAR_SHAPE, 3, 8), csBody]);
    const hfCluster = Buffer.concat([ctrl, listHeader, phRec, ptRec2, csRec]);

    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 8, control_mask |= 0x10000 (char 0x10).
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x10000) >>> 0, phOff + 4);

    raw = Buffer.concat([raw.slice(0, clusterEndOff), hfCluster, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, where, text });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 이미지 (image) raw-patch — Hancom-Docs compatible ─────────────────────
//
// GT-first (image_native.hwp from Hancom's 입력 › 그림): an image is a gso
// "$pic" drawing object in a NEW paragraph, backed by a deflated image stream
// in a `BinData/BIN000N.<ext>` CFB stream and a DocInfo HWPTAG_BIN_DATA def.
// The earlier Phase-6 attempt failed Hancom Docs render (donor-template
// cluster) and could not create a BinData folder; this op reproduces Hancom's
// exact $pic cluster + creates the BinData storage folder when missing.
//   3 steps (each re-writes the file):
//     1. CFB: create the BinData storage folder if absent, add a
//        BIN000N.<ext> stream holding deflate(image bytes).
//     2. DocInfo: HWPTAG_BIN_DATA def (attr 0x0001 = Embedding/Default,
//        matching the GT, NOT Phase-6's 0x0101) + ID_MAPPINGS bin-data count++.
//     3. Section0: insert the gso "$pic" cluster (GT template) as a new
//        paragraph; CTRL_DATA[71] = the storage id.
const IMG_GSO_CTRL_HEX  = '206f736711230a14000000000000000070170000a60e000000000000000000000000000065969a42000000000000';
const IMG_PIC_COMP_HEX  = '636970246369702400000000000000000000010070170000a60e000070170000a60e000000000b20000000000000000000000100000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000';
const IMG_CTRL_DATA_HEX = '0000000000000000000000000000000000000000701700000000000070170000a60e000000000000a60e0000000000000000000070170000c40e0000000000000000000000000001000066969a020000000070170000c40e000000';
const TAG_CTRL_DATA = 0x55;

// Build the image's new-paragraph gso "$pic" cluster (6 records).
function buildImagePicCluster(storageId, paraInstanceId, gsoInstanceId) {
  const ph = Buffer.alloc(24);
  ph.writeUInt32LE(9, 0);              // char_count 9 (last-para flag normalized later)
  ph.writeUInt32LE(0x800, 4);         // control_mask: gso bit
  ph.writeUInt16LE(0, 8);             // para_shape 0
  ph.writeUInt8(0, 10); ph.writeUInt8(0, 11);
  ph.writeUInt16LE(1, 12);            // num_char_shapes
  ph.writeUInt16LE(0, 14); ph.writeUInt16LE(0, 16);
  ph.writeUInt32LE(paraInstanceId >>> 0, 18);

  const pt = Buffer.from('0b00206f736700000000000000000b000d00', 'hex'); // gso char + EOP
  const cs = Buffer.alloc(8);

  const ch = Buffer.from(IMG_GSO_CTRL_HEX, 'hex'); ch.writeUInt32LE(gsoInstanceId >>> 0, 36);
  const pic = Buffer.from(IMG_PIC_COMP_HEX, 'hex');
  const cd = Buffer.from(IMG_CTRL_DATA_HEX, 'hex'); cd.writeUInt16LE(storageId & 0xFFFF, 71);

  const parts = [
    [TAG_PARA_HEADER, 0, ph], [TAG_PARA_TEXT, 1, pt], [TAG_PARA_CHAR_SHAPE, 1, cs],
    [TAG_CTRL_HEADER, 1, ch], [TAG_SHAPE_COMPONENT, 2, pic], [TAG_CTRL_DATA, 3, cd],
  ];
  const chunks = [];
  for (const [tag, lvl, body] of parts) chunks.push(buildRecordHeader(tag, lvl, body.length), body);
  return Buffer.concat(chunks);
}

export async function insertImageInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  // Images dropped into a table cell are centered by default (user pref): ensure
  // a centered ParaShape exists (DocInfo write) before the per-image Section0 step.
  let centerPsId = 0;
  if (ops.some((o) => o.cell && (Number.isInteger(o.cell.row) || Number.isInteger(o.cell.col)))) {
    centerPsId = await ensureAlignedParaShapeInFile(filePath, 'center');
  }

  const summary = [];
  for (const op of ops) {
    if (!op.path) throw new Error('insert_image: op.path (image file) is required');
    const imgBuf = readFileSync(op.path);
    const ext = (op.path.split('.').pop() || 'png').toLowerCase();
    const stored = deflateRawSync(imgBuf, { level: 9 });
    if (stored.length >= 4096) throw new Error(`insert_image: image too large for mini-stream (${stored.length} deflated bytes)`);

    // ── Step 1: CFB — ensure BinData folder, add the image stream ──────────
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    if (!mssz) mssz = MSSZ_DEFAULT_IMG;
    let fat = readFat(buf, fatAddrs, ssz);
    let dir = readDirectory(buf, fat, ssz, dirStart);
    let rootChain = walkChain(fat, dir.entries[0].start);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);

    let binDataIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    if (binDataIdx < 0) {
      ({ buf, fat } = ensureDirSlot(buf, ssz, fat, fatAddrs, dirStart));
      dir = readDirectory(buf, fat, ssz, dirStart);
      const folderSlot = findUnusedDirSlot(dir.entries);
      if (folderSlot < 0) throw new Error('insert_image: no free directory slot for the BinData folder');
      writeDirEntry(buf, dir.entries[folderSlot], 'BinData', 1, 0, 0); // storage: start 0, size 0
      insertEntryIntoTree(buf, dir.entries, 0, folderSlot);            // link under Root Entry
      binDataIdx = folderSlot;
    }

    dir = readDirectory(buf, fat, ssz, dirStart);
    rootChain = walkChain(fat, dir.entries[0].start);
    binDataIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    const newName = pickFreeBinDataName(dir.entries, ext);
    ({ buf, fat } = ensureDirSlot(buf, ssz, fat, fatAddrs, dirStart));
    dir = readDirectory(buf, fat, ssz, dirStart);
    binDataIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    const streamSlot = findUnusedDirSlot(dir.entries);
    if (streamSlot < 0) throw new Error('insert_image: no free directory slot for the image stream');
    const alloc = allocMiniChain({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry: dir.entries[0] }, stored.length);
    buf = alloc.buf; fat = alloc.fat; minifat = alloc.minifat; minifatStart = alloc.minifatStart; rootChain = alloc.rootChain;
    writeMiniChainBytes(buf, alloc.chain, rootChain, ssz, mssz, stored);
    dir = readDirectory(buf, fat, ssz, dirStart);
    binDataIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    writeDirEntry(buf, dir.entries[streamSlot], newName, 2, alloc.chain[0], stored.length, 0);
    insertEntryIntoTree(buf, dir.entries, binDataIdx, streamSlot);
    const storageId = parseInt(newName.match(/BIN(\d{4})\./)[1], 10);
    writeFileSync(filePath, buf);

    // ── Step 2: DocInfo BIN_DATA def (attr 0x0001) + ID_MAPPINGS count++ ───
    await addBinDataDefToDocInfo(filePath, storageId, ext, 0x0001);

    // ── Step 3: Section0 — insert the gso "$pic" cluster as a new paragraph ─
    {
      let b2 = readFileSync(filePath);
      let h = parseCfbHeader(b2);
      let f2 = readFat(b2, h.fatAddrs, h.ssz);
      const { entries } = readDirectory(b2, f2, h.ssz, h.dirStart);
      let mf2 = readMinifat(b2, f2, h.ssz, h.minifatStart);
      const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
      const secInMini = secEntry.size < 4096;
      let rc2 = null; const ensureRC = () => rc2 || (rc2 = walkChain(f2, entries[0].start));
      let sChain, sComp;
      if (secInMini) { const rc = ensureRC(); sChain = walkChain(mf2, secEntry.start); sComp = readMiniChainBytes(b2, sChain, rc, h.ssz, h.mssz, secEntry.size); }
      else { sChain = walkChain(f2, secEntry.start); sComp = readChainBytes(b2, sChain, h.ssz, secEntry.size); }
      let raw = Buffer.from(inflateRawSync(sComp));

      const records = parseRecords(raw);
      const paraInst = pickFreshInstanceId(records, raw);
      const cluster = buildImagePicCluster(storageId, paraInst, (paraInst + 0x100) >>> 0);
      // size — aspect preserved from the image's NATIVE pixel ratio (give one
      // axis → the other follows; give both → explicit squeeze).
      const px = readImagePixelSize(imgBuf);
      applyGsoSize(cluster, resolveAspectSize(op, px && px.w > 0 && px.h > 0 ? px.w / px.h : gsoCtrlRatio(cluster)));
      // Placement: inline (글자처럼, default — back-compat) or a floating wrap
      // (front/behind/square/topbottom) + optional pos_x_mm/pos_y_mm. Lets an image
      // float "앞으로" at an absolute position (seal/도장 placement) — same gso
      // CTRL wrap+offset path that insert_shape/set_object_property use. Default
      // resolves to inline, so existing insert_image stays byte-identical.
      applyGsoPlacement(cluster, op, resolveWrapMode(op));
      if (op.cell && (Number.isInteger(op.cell.row) || Number.isInteger(op.cell.col))) {
        // ── Insert into a table CELL — the image becomes a new (treat-as-char)
        // paragraph inside the cell. The body-built gso cluster is dropped two
        // levels deeper (cell paragraphs are level 2) and spliced at the cell's
        // end; the cell's paragraph count is bumped and its last-para flag fixed.
        const para = op.cell.para ?? 0, control = op.cell.control ?? 0;
        const target = tableCellRecords(records, raw, para, control)
          .find((c) => c.row === op.cell.row && c.col === op.cell.col);
        if (!target) throw new Error(`insert_image: cell (row=${op.cell.row}, col=${op.cell.col}) not found in table at para ${para} control ${control}`);
        const cellCluster = relevelCluster(cluster, 2);
        cellCluster.writeUInt16LE(centerPsId & 0xFFFF, 12); // PARA_HEADER body off8 = para_shape_id (centered)
        setGsoOutMarginTopBottom(cellCluster, CELL_OBJ_VMARGIN_HU); // top/bottom breathing room
        raw = Buffer.concat([raw.slice(0, target.endByte), cellCluster, raw.slice(target.endByte)]);
        const t2 = tableCellRecords(parseRecords(raw), raw, para, control)
          .find((c) => c.row === op.cell.row && c.col === op.cell.col);
        const lhDataOff = t2.startByte + 4; // LIST_HEADER header = 4 bytes (body < 0xFFF)
        raw.writeUInt16LE((raw.readUInt16LE(lhDataOff) + 1) & 0xFFFF, lhDataOff); // nParagraphs++
        normalizeCellLastParaFlag(raw, t2.startByte, t2.endByte, 2);
      } else {
        const wrapMode = resolveWrapMode(op);
        const clusters = findClusterBoundaries(records);
        // FLOATING image with an anchor → attach the gso to the anchor paragraph itself
        // (like insert_shape) instead of opening a NEW paragraph after it. The gso's PARA
        // frame origin is then the anchor's OWN line, so pos_x/pos_y place the image on
        // that line; a new paragraph below sits under the anchor and the PARA frame clamps
        // the image down (can't lift above its para top). Inline keeps the new-paragraph
        // path (byte-identical, back-compat).
        let attached = false;
        if (wrapMode !== 'inline' && op.anchor && typeof op.anchor === 'string') {
          const ab = Buffer.from(op.anchor, 'utf16le');
          // Find the anchor PARA_TEXT at ANY depth — body (level 1) OR a table cell
          // (level 3). The gso attaches to that paragraph wherever it lives.
          let ptIdx = -1;
          for (let i = 0; i < records.length; i++) {
            const r = records[i];
            if (r.tag === TAG_PARA_TEXT && raw.slice(r.dataOff, r.dataOff + r.size).indexOf(ab) !== -1) { ptIdx = i; break; }
          }
          if (ptIdx !== -1) {
            const ptRec = records[ptIdx];
            const phLevel = ptRec.level - 1;        // PARA_HEADER is one level above its text (body 0 / cell 2)
            const delta = ptRec.level - 1;          // shift the body-built gso part down into the cell's depth (+2 for cells)
            let phIdx = -1;                          // anchor PARA_HEADER = nearest preceding header at phLevel
            for (let i = ptIdx - 1; i >= 0; i--) { if (records[i].tag === TAG_PARA_HEADER && records[i].level === phLevel) { phIdx = i; break; } }
            let endIdx = records.length;            // paragraph end = next record at level <= phLevel (next para / cell / table edge)
            for (let i = ptIdx + 1; i < records.length; i++) { if (records[i].level <= phLevel) { endIdx = i; break; } }
            if (phIdx !== -1) {
              const cr = parseRecords(cluster);                       // the full-para image cluster
              const ctrlR = cr.find((r) => r.tag === TAG_CTRL_HEADER);
              let gsoPart = Buffer.from(cluster.slice(ctrlR.headOff)); // CTRL_HEADER + SHAPE_COMPONENT + CTRL_DATA (size/wrap/pos already applied)
              if (delta !== 0) gsoPart = relevelCluster(gsoPart, delta); // re-level into the cell (CTRL 1→3, COMP/DATA 2→4)
              const gsoChar = Buffer.from('0b00206f736700000000000000000b00', 'hex'); // inline gso anchor (8 wchars), before EOP
              const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
              const insAt = oldBody.length >= 2 ? oldBody.length - 2 : oldBody.length;
              const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, ptRec.level, oldBody.length + gsoChar.length), oldBody.slice(0, insAt), gsoChar, oldBody.slice(insAt)]);
              const phOff = records[phIdx].dataOff;                   // anchor PARA_HEADER: char_count += 8, control_mask |= 0x800
              const curCount = raw.readUInt32LE(phOff);
              raw.writeUInt32LE((((curCount & 0x80000000) >>> 0) | ((curCount & 0x7FFFFFFF) + 8)) >>> 0, phOff);
              raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x800) >>> 0, phOff + 4);
              const paraEndOff = endIdx < records.length ? records[endIdx].headOff : raw.length;
              raw = Buffer.concat([raw.slice(0, paraEndOff), gsoPart, raw.slice(paraEndOff)]); // gso at para end (after PARA_TEXT → ptRec offsets stay valid)
              raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);
              attached = true;
            }
          }
        }
        if (!attached) {
          // ── Inline (or floating w/ no anchor match): open a new paragraph. ──
          let insertAt = raw.length;
          if (op.anchor && typeof op.anchor === 'string') {
            const ab = Buffer.from(op.anchor, 'utf16le');
            for (const c of clusters) {
              let hit = false;
              for (let i = c.startIdx + 1; i < c.endIdx; i++) { const r = records[i]; if (r.tag === TAG_PARA_TEXT && raw.slice(r.dataOff, r.dataOff + r.size).indexOf(ab) !== -1) { hit = true; break; } }
              if (hit) { insertAt = c.endIdx < records.length ? records[c.endIdx].headOff : raw.length; break; }
            }
          } else {
            const t = findLastSimpleBodyParagraph(records);
            insertAt = t.endIdx < records.length ? records[t.endIdx].headOff : raw.length;
          }
          raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);
          normalizeLastParaFlag(raw);
        }
      }

      let newComp;
      if (secInMini) {
        const rc = ensureRC();
        const e = deflateMiniChainWithExpansion({ buf: b2, ssz: h.ssz, mssz: h.mssz, fat: f2, fatAddrs: h.fatAddrs, minifat: mf2, minifatStart: h.minifatStart, rootChain: rc, rootEntry: entries[0] }, raw, sChain);
        b2 = e.buf; f2 = e.fat; mf2 = e.minifat; h.minifatStart = e.minifatStart; newComp = e.compressed;
        if (e.promoted) { sChain = e.newRegularChain; writeChainBytes(b2, sChain, h.ssz, newComp); b2.writeInt32LE(sChain[0], secEntry.entryFileOffset + 0x74); }
        else { rc2 = e.rootChain; sChain = e.miniChain; writeMiniChainBytes(b2, sChain, rc2, h.ssz, h.mssz, newComp); }
      } else {
        const e = deflateAndFitWithExpansion(raw, sChain.length * h.ssz, h.ssz, f2, h.fatAddrs, sChain, b2, false);
        b2 = e.buf; f2 = e.fat; sChain = e.chain; newComp = e.compressed; writeChainBytes(b2, sChain, h.ssz, newComp);
      }
      b2.writeUInt32LE(newComp.length, secEntry.entryFileOffset + 0x78);
      b2.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      writeFileSync(filePath, b2);
    }

    summary.push({ section: 0, image: op.path, storage_id: storageId, stream: `BinData/${newName}` });
  }

  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── place_seal: font-metric seal/signature placement ──────────────────────
// HWP PARA_TEXT mixes glyphs with inline control chars. A control char occupies
// either 1 wchar ("char" controls: 0,10,13,24-31) or 8 wchars (inline/extended
// controls: everything else < 0x20 — the char + 6 param wchars + a closing copy).
// We need both to walk to the anchor's byte offset AND to add zero width for them.
function sealCtrlWcharLen(code) {
  if (code >= 0x20) return 1;
  if (code === 0 || code === 10 || code === 13 || (code >= 24 && code <= 31)) return 1;
  return 8;
}
// Visual advance of one code unit, in ems. CJK/Hangul/fullwidth = 1 em; ASCII and
// halfwidth (incl. space) = 0.5 em; control chars = 0. (handoff §2 metric.)
function sealGlyphEm(code) {
  if (code < 0x20) return 0;
  if (code <= 0x7e) return 0.5;   // ASCII incl. space ≈ half-width
  if (code >= 0xff61 && code <= 0xffdc) return 0.5; // halfwidth forms
  return 1.0;
}

// A center/right-aligned paragraph shifts its whole text block away from the left
// edge, which a left-anchored startX walk doesn't see — on a center-aligned form
// cell that makes the seal drift symmetrically off the marker. Read the anchor
// paragraph's alignment (PARA_SHAPE) and, for center/right, return the block shift
// (mm) to add to the seal's x: center → (availW − textW)/2, right → availW − textW.
// availW = the cell's content width (forms put signature lines in cells) or a body
// text-area default. textW = font-metric width of the whole paragraph.
function sealAlignShift(buf, records, ptIdx, body, em, textAreaMm) {
  const ptRec = records[ptIdx];
  const phLevel = ptRec.level - 1;
  let phIdx = -1;
  for (let i = ptIdx - 1; i >= 0; i--) { if (records[i].tag === TAG_PARA_HEADER && records[i].level === phLevel) { phIdx = i; break; } }
  if (phIdx === -1) return 0;
  const raw = readDecodedStreamFromCfb(buf, ['BodyText', 'Section0']);
  const psId = raw.readUInt16LE(records[phIdx].dataOff + 8); // PARA_HEADER body off8 = para_shape_id
  let docInfo;
  try { docInfo = readDecodedStreamFromCfb(buf, ['DocInfo']); } catch { return 0; }
  const di = parseRecords(docInfo);
  const shapes = di.filter((r) => r.tag === 0x19); // HWPTAG_PARA_SHAPE
  if (psId >= shapes.length) return 0;
  const align = (docInfo.readUInt32LE(shapes[psId].dataOff) >> 2) & 0x7; // 0 just,1 left,2 right,3 center
  if (align !== 2 && align !== 3) return 0;
  // available width: cell content width if the anchor lives in a table cell, else body text area
  let availMm = textAreaMm;
  if (ptRec.level >= 3) {
    let lh = -1;
    for (let i = ptIdx - 1; i >= 0; i--) { if (records[i].tag === TAG_LIST_HEADER && records[i].level === 2) { lh = i; break; } }
    if (lh !== -1) {
      const d = records[lh].dataOff;
      const w = raw.readUInt32LE(d + 16), mL = raw.readUInt16LE(d + 24), mR = raw.readUInt16LE(d + 26);
      availMm = (w - mL - mR) / HWPUNIT_PER_MM;
    }
  }
  const textW = sealMeasureWidthMM(body, body.length, em);
  return align === 3 ? (availMm - textW) / 2 : (availMm - textW);
}
// Sum the glyph advance (mm) of the PARA_TEXT body up to `uptoByteOff`, skipping
// inline-control runs by their wchar length so the offset walk stays aligned.
function sealMeasureWidthMM(body, uptoByteOff, em_mm) {
  let off = 0, w = 0;
  while (off < uptoByteOff && off + 2 <= body.length) {
    const code = body.readUInt16LE(off);
    if (code >= 0x20) w += sealGlyphEm(code) * em_mm;
    off += sealCtrlWcharLen(code) * 2;
  }
  return w;
}

// Place a seal/signature PNG floating ("front") onto an anchor phrase, positioned
// by FONT METRICS — no render needed to find the spot (render is verify/calibrate
// only, handoff §2). overlap → seal centred on the phrase; right → seal just past
// the phrase. Auto-size = line × 1.6 clamped [7,18]mm. Frame: 'para' anchors to the
// line (cells have headroom above → true vertical centre, rule D; a free body line
// near the page top clamps the seal ~2.6mm low — rule C — so pass frame:'page' for
// those, with dy_mm to fine-tune). Delegates to insertImageInPlace's GT-verified
// floating-attach path, so the produced gso is byte-equivalent to insert_image.
export async function placeSealInPlace(filePath, ops) {
  const summary = [];
  for (const op of ops) {
    if (!op.anchor || typeof op.anchor !== 'string') throw new Error('place_seal: anchor (text) required');
    const source = op.source || op.path;
    if (!source) throw new Error('place_seal: source (seal PNG path) required');
    if (!existsSync(source)) throw new Error(`place_seal: source not found: ${source}`);

    const buf = readFileSync(filePath);
    const raw = readDecodedStreamFromCfb(buf, ['BodyText', 'Section0']);
    const records = parseRecords(raw);
    const ab = Buffer.from(op.anchor, 'utf16le');
    let ptRec = null, ptIdx = -1, anchorByteInBody = -1;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.tag !== TAG_PARA_TEXT || r.size <= 0) continue;
      const idx = raw.slice(r.dataOff, r.dataOff + r.size).indexOf(ab);
      if (idx !== -1) { ptRec = r; ptIdx = i; anchorByteInBody = idx; break; }
    }
    if (!ptRec) throw new Error(`place_seal: anchor "${op.anchor}" not found in body text`);
    const body = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);

    const fontPt = op.font_pt || 10;
    const em = (fontPt * 25.4) / 72;          // 1 em in mm at this point size
    const lineH = em;                          // body line ≈ 1 em tall
    const startX = sealMeasureWidthMM(body, anchorByteInBody, em);
    let aw = 0;
    for (const ch of op.anchor) aw += sealGlyphEm(ch.codePointAt(0)) * em;

    let size = op.size_mm != null ? op.size_mm : Math.max(7, Math.min(18, lineH * 1.6));
    // mode auto: sit beside the phrase when there's ≥ seal+2mm of room, else overlap.
    const TEXT_AREA_W = op.text_area_mm || 150; // typical A4 body width
    let mode = String(op.mode || 'auto').toLowerCase();
    if (mode === 'auto') mode = (TEXT_AREA_W - (startX + aw) >= size + 2) ? 'right' : 'overlap';
    if (mode !== 'overlap' && mode !== 'right') throw new Error('place_seal: mode must be overlap / right / auto');

    let posX = mode === 'right' ? startX + aw + 2 : startX + aw / 2 - size / 2;
    // Center/right-aligned paragraphs (common in form cells) shift the whole text
    // block — add that shift so the seal tracks the on-screen marker, not the
    // left-anchored estimate. (No-op for left/justify; agent can still nudge dx.)
    const alignShift = sealAlignShift(buf, records, ptIdx, body, em, TEXT_AREA_W);
    posX += alignShift + (op.dx_mm || 0);
    const frame = String(op.frame || 'para').toLowerCase();
    // Centre the seal on the line: lift it by half the overhang. PARA clamps this to
    // 0 on a free top line (→ top-aligned, GT-equivalent); cells & PAGE frame honour it.
    let posY = -(size - lineH) / 2 + (op.dy_mm || 0);

    const imgOp = {
      type: 'insert_image', path: source, anchor: op.anchor, wrap: 'front', frame,
      pos_x_mm: posX, pos_y_mm: posY, width_mm: size, height_mm: size,
    };
    const r = await insertImageInPlace(filePath, [imgOp]);
    summary.push({
      anchor: op.anchor, mode, frame,
      pos_x_mm: +posX.toFixed(2), pos_y_mm: +posY.toFixed(2), size_mm: +size.toFixed(2),
      ...(r[0] || {}),
    });
  }
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── chart data editing (rows/cols/values via OOXMLChartContents) ──────────
// Hancom Docs renders a chart from the OOXMLChartContents XML inside the OLE
// (verified by capture: editing only that XML's category label changed the
// rendered chart, while the legacy VtChart "Contents" stream stayed stale).
// So we edit that XML to set category count (rows), series count (cols),
// labels, and values, then repack the inner CFB and re-deflate the OLE.
// The inner OLE is a minimal v3 CFB (512-B sectors, single FAT sector, no
// mini stream — both real streams are >4 KB regular streams).
const _chXmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _chStrCache = (labels) => `<c:ptCount val="${labels.length}"/>` + labels.map((l, i) => `<c:pt idx="${i}"><c:v>${_chXmlEsc(l)}</c:v></c:pt>`).join('');
const _chNumCache = (vals) => `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
function _chReplaceBlock(s, openTag, closeTag, fromIdx, newInner) {
  const a = s.indexOf(openTag, fromIdx); if (a < 0) return { s, end: fromIdx };
  const b = s.indexOf(closeTag, a); if (b < 0) return { s, end: fromIdx };
  return { s: s.slice(0, a + openTag.length) + newInner + s.slice(b), end: a + openTag.length + newInner.length + closeTag.length };
}
function _chEditSer(ser, idx, name, categories, values) {
  let out = ser.replace(/<c:idx val="\d+"\/>/, `<c:idx val="${idx}"/>`).replace(/<c:order val="\d+"\/>/, `<c:order val="${idx}"/>`);
  let r = _chReplaceBlock(out, '<c:strCache>', '</c:strCache>', 0, _chStrCache([name])); out = r.s;       // series name
  r = _chReplaceBlock(out, '<c:strCache>', '</c:strCache>', r.end, _chStrCache(categories)); out = r.s;   // categories (rows)
  r = _chReplaceBlock(out, '<c:numCache>', '</c:numCache>', 0, _chNumCache(values)); out = r.s;           // values
  return out;
}
function _chEditXml(xml, model) {
  const first = xml.indexOf('<c:ser>'); const lastClose = xml.lastIndexOf('</c:ser>');
  if (first < 0 || lastClose < 0) throw new Error('chart data edit: no <c:ser> blocks (unsupported chart structure)');
  if (xml.indexOf('<c:cat>') < 0 || xml.indexOf('<c:val>') < 0) throw new Error('chart data edit: this chart type has no category/value axis (e.g. scatter/bubble) — data editing not supported');
  const serTpl = xml.slice(first, xml.indexOf('</c:ser>') + 8);
  const sers = model.series.map((s, i) => _chEditSer(serTpl, i, s.name, model.categories, s.values));
  return xml.slice(0, first) + sers.join('') + xml.slice(lastClose + 8);
}
// minimal inner-CFB primitives (simple v3 CFB only)
const _icHdr = (cfb) => { const ssz = 1 << cfb.readUInt16LE(30); const mssz = 1 << cfb.readUInt16LE(32); const nFat = cfb.readUInt32LE(44); const dirStart = cfb.readUInt32LE(48); const miniCutoff = cfb.readUInt32LE(56); const minifatStart = cfb.readUInt32LE(60); const difat = []; for (let i = 0; i < 109; i++) { const v = cfb.readUInt32LE(76 + i * 4); if (v <= 0xFFFFFFFA) difat.push(v); } return { ssz, mssz, nFat, dirStart, miniCutoff, minifatStart, difat }; };
const _icFat = (cfb, difat, ssz) => { const fat = []; for (const fs of difat) { const off = 512 + fs * ssz; for (let i = 0; i < ssz / 4; i++) fat.push(cfb.readUInt32LE(off + i * 4)); } return fat; };
const _icChain = (fat, start) => { const c = []; let s = start; while (s <= 0xFFFFFFFA && s < fat.length) { c.push(s); s = fat[s]; if (c.length > 100000) break; } return c; };
const _icSecOff = (idx, ssz) => 512 + idx * ssz;
function _icFindEntry(cfb, hdr, fat, name) {
  for (const sec of _icChain(fat, hdr.dirStart)) for (let e = 0; e < hdr.ssz / 128; e++) {
    const off = _icSecOff(sec, hdr.ssz) + e * 128; const nameLen = cfb.readUInt16LE(off + 64); if (nameLen <= 0) continue;
    if (cfb.slice(off, off + nameLen - 2).toString('utf16le') === name) return off;
  }
  return -1;
}
// Mini-stream support. Inner CFBs classify any stream < miniCutoff (4096) as a
// mini-stream: its bytes live in 64-byte mini-sectors packed inside the Root Entry's
// regular chain, indexed by the mini-FAT (not the regular FAT). Pie/doughnut chart
// templates store OOXMLChartContents (~3.4 KB) natively here, so reading them needs
// this path (the regular reader would walk the wrong FAT and return garbage).
const _icMiniFat = (cfb, hdr, fat) => {
  const mf = []; if (hdr.minifatStart > 0xFFFFFFFA) return mf;
  for (const sec of _icChain(fat, hdr.minifatStart)) { const off = _icSecOff(sec, hdr.ssz); for (let i = 0; i < hdr.ssz / 4; i++) mf.push(cfb.readUInt32LE(off + i * 4)); }
  return mf;
};
const _icReadRootStream = (cfb, hdr, fat) => {
  // Root Entry = first dir entry (dirStart sector, offset 0); its regular chain is the mini-stream container.
  const rootOff = _icSecOff(hdr.dirStart, hdr.ssz);
  const chain = _icChain(fat, cfb.readUInt32LE(rootOff + 116)); const rsize = cfb.readUInt32LE(rootOff + 120);
  const out = Buffer.alloc(chain.length * hdr.ssz); let p = 0;
  for (const sec of chain) { const off = _icSecOff(sec, hdr.ssz); cfb.copy(out, p, off, off + hdr.ssz); p += hdr.ssz; }
  return rsize > 0 && rsize < out.length ? out.slice(0, rsize) : out;
};
function _icReadMini(cfb, hdr, fat, entryOff) {
  const size = cfb.readUInt32LE(entryOff + 120); const miniFat = _icMiniFat(cfb, hdr, fat); const root = _icReadRootStream(cfb, hdr, fat);
  const out = Buffer.alloc(size); let p = 0; let s = cfb.readUInt32LE(entryOff + 116);
  while (s <= 0xFFFFFFFA && p < size) { const off = s * hdr.mssz; const n = Math.min(hdr.mssz, size - p); root.copy(out, p, off, off + n); p += n; s = miniFat[s]; if (s === undefined) break; }
  return out;
}
function _icReadStream(cfb, hdr, fat, entryOff) {
  const size = cfb.readUInt32LE(entryOff + 120);
  if (size > 0 && size < hdr.miniCutoff) return _icReadMini(cfb, hdr, fat, entryOff);
  const chain = _icChain(fat, cfb.readUInt32LE(entryOff + 116));
  const out = Buffer.alloc(size); let p = 0;
  for (const sec of chain) { const off = _icSecOff(sec, hdr.ssz); const n = Math.min(hdr.ssz, size - p); cfb.copy(out, p, off, off + n); p += n; if (p >= size) break; }
  return out;
}
function _icWriteOoxml(cfb, newXml) {
  const hdr = _icHdr(cfb); const ssz = hdr.ssz; let fat = _icFat(cfb, hdr.difat, ssz);
  const entryOff = _icFindEntry(cfb, hdr, fat, 'OOXMLChartContents'); if (entryOff < 0) throw new Error('chart data edit: OOXMLChartContents not found');
  const data = Buffer.from(newXml, 'utf8');
  const oldSize = cfb.readUInt32LE(entryOff + 120);
  const wasMini = oldSize > 0 && oldSize < hdr.miniCutoff;
  if (!wasMini) {
    const chain = _icChain(fat, cfb.readUInt32LE(entryOff + 116)); const capacity = chain.length * ssz;
    if (data.length <= capacity) {
      let p = 0; for (const sec of chain) { const off = _icSecOff(sec, ssz); const n = Math.min(ssz, data.length - p); if (n > 0) data.copy(cfb, off, p, p + n); if (n < ssz) cfb.fill(0, off + Math.max(0, n), off + ssz); p += n; }
      cfb.writeUInt32LE(data.length, entryOff + 120); return cfb;
    }
    if (hdr.nFat !== 1 || hdr.difat.length !== 1) throw new Error('chart data edit: multi-FAT OLE not supported');
    const needSectors = Math.ceil(data.length / ssz); const addSectors = needSectors - chain.length; let buf = cfb; const added = [];
    for (let i = 0; i < addSectors; i++) { const idx = (buf.length - 512) / ssz; const tmp = Buffer.alloc(buf.length + ssz); buf.copy(tmp); buf = tmp; added.push(idx); }
    while (fat.length < (buf.length - 512) / ssz) fat.push(0xFFFFFFFF);
    const full = chain.concat(added); for (let i = 0; i < full.length - 1; i++) fat[full[i]] = full[i + 1]; fat[full[full.length - 1]] = 0xFFFFFFFE;
    const maxEntries = ssz / 4; if (fat.length > maxEntries) throw new Error('chart data edit: OLE exceeded single-FAT capacity (too many rows/cols)');
    const fatOff = _icSecOff(hdr.difat[0], ssz); for (let i = 0; i < maxEntries; i++) buf.writeUInt32LE((i < fat.length ? fat[i] : 0xFFFFFFFF) >>> 0, fatOff + i * 4);
    let p = 0; for (const sec of full) { const off = _icSecOff(sec, ssz); const n = Math.min(ssz, data.length - p); if (n > 0) data.copy(buf, off, p, p + n); if (n < ssz) buf.fill(0, off + Math.max(0, n), off + ssz); p += n; }
    buf.writeUInt32LE(data.length, entryOff + 120); return buf;
  }
  // The entry was a MINI stream (pie/doughnut templates store OOXMLChartContents
  // natively at ~3.4 KB, below the 4096 cutoff). The edited+padded XML is regular-sized
  // (buildChartOleWithData pads to >= MIN_OOXML), so MOVE the entry out of the mini-stream
  // into a fresh regular chain: allocate sectors at the tail, repoint the dir entry, and
  // set a regular size. The old mini-sectors are left orphaned in the mini-stream container
  // (harmless — nothing references them once the entry points elsewhere).
  if (hdr.nFat !== 1 || hdr.difat.length !== 1) throw new Error('chart data edit: multi-FAT OLE not supported');
  if (data.length < hdr.miniCutoff) throw new Error('chart data edit: mini-stream entry under cutoff (expected padded >= 4096)');
  const needSectors = Math.ceil(data.length / ssz); let buf = cfb; const newChain = [];
  for (let i = 0; i < needSectors; i++) { const idx = (buf.length - 512) / ssz; const tmp = Buffer.alloc(buf.length + ssz); buf.copy(tmp); buf = tmp; newChain.push(idx); }
  while (fat.length < (buf.length - 512) / ssz) fat.push(0xFFFFFFFF);
  for (let i = 0; i < newChain.length - 1; i++) fat[newChain[i]] = newChain[i + 1]; fat[newChain[newChain.length - 1]] = 0xFFFFFFFE;
  const maxEntries = ssz / 4; if (fat.length > maxEntries) throw new Error('chart data edit: OLE exceeded single-FAT capacity (too many rows/cols)');
  const fatOff = _icSecOff(hdr.difat[0], ssz); for (let i = 0; i < maxEntries; i++) buf.writeUInt32LE((i < fat.length ? fat[i] : 0xFFFFFFFF) >>> 0, fatOff + i * 4);
  let p = 0; for (const sec of newChain) { const off = _icSecOff(sec, ssz); const n = Math.min(ssz, data.length - p); if (n > 0) data.copy(buf, off, p, p + n); if (n < ssz) buf.fill(0, off + Math.max(0, n), off + ssz); p += n; }
  buf.writeUInt32LE(newChain[0], entryOff + 116);  // dir entry → fresh regular chain
  buf.writeUInt32LE(data.length, entryOff + 120);   // regular size (>= cutoff)
  return buf;
}
// ── chart series / point colour (theme matching) ─────────────────────────
// Inject colour into the OOXMLChartContents, mirroring the HWPX track's
// buildChartSpace colour model so .hwp and .hwpx charts match a document theme
// the same way. Hancom stores the colour differently per chart family (verified,
// GT in handoff/shared/gt/chart-*-schemeclr.hwpx):
//   - fill families (bar/area/scatter/bubble): bare <a:solidFill> in <c:spPr>
//   - stroke families (line/radar): <a:solidFill> inside <a:ln> (a bare fill
//     leaves the stroke colour unchanged)
//   - pie/doughnut: one series, colour each slice via <c:dPt>
// accent1-6 → <a:schemeClr> (Hancom's built-in chart palette); #RRGGBB →
// <a:srgbClr> (literal — use this to MATCH a document theme colour).
function _chColorFill(c) {
  const s = String(c == null ? '' : c).trim();
  if (/^accent[1-6]$/i.test(s)) return `<a:solidFill><a:schemeClr val="${s.toLowerCase()}"/></a:solidFill>`;
  const hex = s.replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
  return null; // unrecognised → leave the template colour
}
function _chApplyColors(xml, op) {
  const colors = Array.isArray(op.colors) && op.colors.length ? op.colors.map(String) : null;
  const single = (op.color != null) ? String(op.color) : null;
  const pointColors = Array.isArray(op.point_colors) && op.point_colors.length ? op.point_colors.map(String) : null;
  if (!colors && !single && !pointColors) return xml;
  const famM = xml.match(/<c:(\w+)Chart>/);           // bar, line, pie, bar3D, area3D, …
  const famRaw = famM ? famM[1].toLowerCase() : 'bar';
  const isStroke = /^(line|radar)/.test(famRaw);      // colour goes in <a:ln>, not a bare fill
  const isPie = /^(pie|doughnut|ofpie)/.test(famRaw); // one series, colour each slice via <c:dPt>
  // The series-level spPr — empty self-closing (bar/area templates), a populated
  // one (rare), or ABSENT (line templates: tx → marker → cat, no spPr). When
  // absent we INSERT one right after </c:tx> (its schema position, before marker).
  const SPPR = /<c:spPr\/>|<c:spPr>[\s\S]*?<\/c:spPr>/;
  const insertAfterTx = (ser, frag) => {
    const i = ser.indexOf('</c:tx>');
    if (i >= 0) return ser.slice(0, i + 7) + frag + ser.slice(i + 7);
    return ser.replace(/(<c:order val="\d+"\/>)/, (m) => m + frag);
  };
  const putSpPr = (ser, spPrXml) => SPPR.test(ser) ? ser.replace(SPPR, spPrXml) : insertAfterTx(ser, spPrXml);
  // Colour a line/radar series' point marker to match its line. The template marker
  // is <c:marker><c:symbol/><c:size/></c:marker> with no spPr (→ default accent); add
  // a spPr (fill + outline) right before </c:marker>, only if it has none yet. `fill`
  // is an <a:solidFill> fragment (same one used for the line).
  const colorMarker = (s, fill) => {
    const i = s.indexOf('<c:marker>'); if (i < 0) return s;
    const j = s.indexOf('</c:marker>', i); if (j < 0) return s;
    if (s.slice(i, j).includes('<c:spPr>')) return s;
    return s.slice(0, j) + `<c:spPr>${fill}<a:ln>${fill}</a:ln></c:spPr>` + s.slice(j);
  };
  let out = '', cur = 0, si = 0;
  for (;;) {
    const a = xml.indexOf('<c:ser>', cur);
    if (a < 0) { out += xml.slice(cur); break; }
    const b = xml.indexOf('</c:ser>', a) + 8;
    out += xml.slice(cur, a);
    let ser = xml.slice(a, b);
    // Build <c:dPt> per-point colour blocks and splice them in at their schema
    // position — right before <c:cat> (dPt precedes cat/val in a <c:ser>).
    const mkDpts = (arr) => arr.map((c, i) => { const f = _chColorFill(c); return f ? `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${f}</c:spPr></c:dPt>` : ''; }).join('');
    const insertDpt = (s, dpts) => { const ci = s.indexOf('<c:cat>'); const vi = s.indexOf('<c:val>'); const at = ci >= 0 ? ci : (vi >= 0 ? vi : -1); return at >= 0 ? s.slice(0, at) + dpts + s.slice(at) : (SPPR.test(s) ? s.replace(SPPR, (m) => m + dpts) : insertAfterTx(s, dpts)); };
    if (isPie) {
      // Pie/doughnut: one series, one colour per slice (point_colors > colors).
      // Pie/doughnut templates already carry one <c:dPt> per slice (accent1-4);
      // strip those so our colours don't collide with the template's at the same
      // <c:idx> (duplicate dPt for one index renders ambiguously). Then splice ours
      // in at the schema position (before <c:cat>).
      const dpts = mkDpts(pointColors || colors || (single ? [single] : []));
      if (dpts) { ser = ser.replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, ''); ser = insertDpt(ser, dpts); }
    } else if (pointColors) {
      // Per-bar / per-point gradient on the FIRST series (single-series bar/area →
      // theme gradient, like the HWPX reference). Each data point gets its own <c:dPt>.
      if (si === 0) { const dpts = mkDpts(pointColors); if (dpts) ser = insertDpt(ser, dpts); }
    } else {
      const col = colors ? colors[si % colors.length] : single;
      const f = _chColorFill(col);
      if (f) {
        const spPr = isStroke
          ? `<c:spPr><a:ln w="28575" cap="flat" cmpd="sng" algn="ctr">${f}<a:prstDash val="solid"/><a:round/></a:ln></c:spPr>`
          : `<c:spPr>${f}</c:spPr>`;
        ser = putSpPr(ser, spPr);
        // line/radar: our colour only sets the LINE (<a:ln>); the marker keeps its
        // template default accent (so a purple line ends up with an orange marker).
        // Give the marker the same fill + outline so it tracks the line colour.
        if (isStroke) ser = colorMarker(ser, f);
      }
    }
    out += ser; cur = b; si++;
  }
  return out;
}
// Line/radar charts: the HWPX track renders these with visible circle markers
// (its buildChartSpace emits <c:symbol val="circle"/> + a chart-level <c:marker
// val="1"/> for line). The .hwp templates ship markers off (<c:symbol val="none"/>),
// so when we're already editing the OLE we turn them on to keep .hwp and .hwpx
// visually identical. Line: flip the per-series symbols AND add the chart-level
// marker (CT_LineChart, position: after the sers, before <c:axId>). Radar
// (CT_RadarChart has no chart-level marker element): flip the symbols only. Opt
// out with op.markers === false. No-op for any other family.
function _chApplyMarkers(xml) {
  const fam = (xml.match(/<c:(line|radar)Chart>/) || [])[1];
  if (!fam) return xml;
  let out = xml.replace(/<c:symbol val="none"\/>/g, '<c:symbol val="circle"/>');
  if (fam === 'line' && !/<c:marker val="1"\/>/.test(out)) {
    const i = out.indexOf('<c:axId');
    if (i >= 0) out = out.slice(0, i) + '<c:marker val="1"/>' + out.slice(i);
  }
  return out;
}
function buildChartOleWithData(baseOleBytes, model, op) {
  const inner = Buffer.from(inflateRawSync(baseOleBytes));
  let cfb = Buffer.from(inner.slice(4));
  const hdr = _icHdr(cfb); const fat = _icFat(cfb, hdr.difat, hdr.ssz);
  const xEntry = _icFindEntry(cfb, hdr, fat, 'OOXMLChartContents'); if (xEntry < 0) throw new Error('chart data edit: OLE has no OOXMLChartContents');
  let newXml = _icReadStream(cfb, hdr, fat, xEntry).toString('utf8');
  if (model) newXml = _chEditXml(newXml, model);
  if (op) newXml = _chApplyColors(newXml, op);
  if (!op || op.markers !== false) newXml = _chApplyMarkers(newXml);
  // Keep OOXMLChartContents a REGULAR inner-CFB stream (>= the 4096-byte mini-stream
  // cutoff). Editing a 3-series template down to a single short-labelled series can
  // shrink it just under 4096 (e.g. categories "Q1"/"a" → ~4085 B); the CFB then
  // classifies it as a mini-stream while _icWriteOoxml still writes it into the
  // regular FAT, and Hancom renders the whole chart OLE BLANK. Pad with an ignored
  // XML comment so the byte length stays comfortably above the cutoff and the stream
  // stays regular. (GT: render flips exactly at 4096 — 4095 B blank, 4097 B renders.)
  const MIN_OOXML = 4160;
  let xb = Buffer.byteLength(newXml, 'utf8');
  if (xb < MIN_OOXML && newXml.indexOf('</c:chartSpace>') !== -1) {
    const pad = '<!--' + ' '.repeat(Math.max(1, MIN_OOXML - xb - 7)) + '-->';
    newXml = newXml.replace('</c:chartSpace>', pad + '</c:chartSpace>');
  }
  cfb = _icWriteOoxml(cfb, newXml);
  const newInner = Buffer.alloc(4 + cfb.length); newInner.writeUInt32LE(cfb.length, 0); cfb.copy(newInner, 4);
  return deflateRawSync(newInner); // caller (insertChartInPlace) routes < 4096 B to the mini-stream
}
// Set/clear the gso "treat-as-character" bit (attribute bit 0) on the chart
// cluster's CTRL_HEADER. As a floating object the chart reserves no line height,
// so following paragraphs wrap into a cramped column beside it (the overlap the
// user reported); as a like-char object it sits on its own line and text flows
// cleanly above and below it. We default to like-char for that reason.
function setGsoLikeChar(cluster, likeChar) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = cluster.readUInt32LE(p); p += 4; }
    if (tag === 0x47 && cluster.slice(p, p + 4).toString('latin1') === ' osg') {
      const attrOff = p + 4; const attr = cluster.readUInt32LE(attrOff);
      cluster.writeUInt32LE((likeChar ? (attr | 1) : (attr & ~1)) >>> 0, attrOff);
    }
    p += sz;
  }
  return cluster;
}

// Multi-chart-per-doc identity patch (GT: a Hancom 한컴독스 doc with two charts diffed
// against the one-chart version). For each chart beyond the first, Hancom changes
// exactly TWO bytes in the gso cluster: the gso CTRL_HEADER (tag 0x47, ' osg')
// CommonObjAttr zOrder (INT32 @ body+24) and the SHAPE_COMPONENT_OLE (tag 0x54)
// binDataID (u16 @ body+12). binDataID == the BIN_DATA storage ordinal N
// (BIN000N.OLE); zOrder is prev+1 (0 for the first object). CommonObjAttr layout:
// attr@4, yOff@8, xOff@12, w@16, h@20, zOrder@24, outerMargin@28..35, instanceId@36.
// Hancom leaves instanceId@36 = 0 on BOTH charts (it needn't be unique when there's
// no caption), and the PARA_HEADER instance_id likewise stays 0 — so only zOrder +
// binDataID need patching on the template clusterHex; everything else is identical.
function setChartClusterIds(cluster, binDataId, zOrder) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = cluster.readUInt32LE(p); p += 4; }
    if (tag === 0x47 && cluster.slice(p, p + 4).toString('latin1') === ' osg') {
      if (sz >= 28) cluster.writeInt32LE(zOrder | 0, p + 24);           // CommonObjAttr zOrder
    } else if (tag === 0x54) {                                          // SHAPE_COMPONENT_OLE
      if (sz >= 14) cluster.writeUInt16LE(binDataId & 0xFFFF, p + 12);  // binDataID = storage ordinal
    }
    p += sz;
  }
  return cluster;
}

// Next gso zOrder = (max existing gso CTRL_HEADER zOrder @ body+24) + 1, or 0 when the
// section has no drawing objects yet. Scans the inflated Section0 bytes so the new
// chart stacks above every gso object already in the doc (charts, images, shapes),
// matching how Hancom assigns zOrder sequentially per insertion.
function nextGsoZOrder(raw) {
  let p = 0, max = -1;
  while (p + 4 <= raw.length) {
    const h = raw.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = raw.readUInt32LE(p); p += 4; }
    if (tag === 0x47 && raw.slice(p, p + 4).toString('latin1') === ' osg' && sz >= 28) {
      max = Math.max(max, raw.readInt32LE(p + 24));
    }
    p += sz;
  }
  return max + 1;
}

// ── 개체 배치 (object placement / wrap) — unified across insert_* ops ─────────
// One placement vocabulary shared with the HWPX track + set_object_property:
//   wrap = inline (글자처럼, DEFAULT) | topbottom (자리차지) | square (어울림)
//        | behind (글 뒤) | front (글 앞)
// inline keeps the object on its own line/flow (object reserves height → text
// flows above/below cleanly, never drifts to a later page); the floating modes
// use the GT-verified TABLE_WRAP bit field (same as set_object_property.wrap).
function resolveWrapMode(op) {
  if (op.wrap != null) {
    const w = String(op.wrap).toLowerCase();
    if (!(w in TABLE_WRAP)) {
      throw new Error('wrap must be inline / topbottom / square / behind / front');
    }
    return w;
  }
  // Back-compat: the old `float:true` / `like_char:false` meant "the floating
  // original" (text wraps beside it) = square.
  if (op.float === true || op.like_char === false) return 'square';
  return 'inline';
}

// Apply wrap + optional floating position (x/y, mm from page) + outer margins
// to the gso CTRL_HEADER inside an assembled cluster. Reuses the exact byte
// offsets and TABLE_WRAP encoding that set_object_property (GT-verified across
// all 5 modes) writes, so insert+wrap is byte-equivalent to insert then
// set_object_property — no separate Tier-2 proof needed per mode.
function applyGsoPlacement(cluster, op, mode) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = cluster.readUInt32LE(p); p += 4; }
    if (tag === 0x47 && cluster.slice(p, p + 4).toString('latin1') === ' osg') {
      const d = p; // CTRL_HEADER data start (' osg' id at d, attribute at d+4)
      let attr = cluster.readUInt32LE(d + 4);
      attr = ((attr & ~TABLE_WRAP_MASK) | TABLE_WRAP[mode]) >>> 0;
      // Position-reference frame (the "개체 위치 기준" enum). GT-confirmed from the
      // gso common-attribute bit field (vert=bits3-4, horz=bits8-9): a PARA-relative
      // gso decodes vert=2/horz=3, matching the HWPX `vertRelTo="PARA"/horzRelTo="PARA"`
      // ground-truth — so the standard enum holds (vert {0:paper,1:page,2:para};
      // horz {0:paper,1:page,2:column,3:para}). The default template is PARA, which
      // clamps the object to its anchor-paragraph top (rule C) → can't vertically
      // centre a tall seal on a one-line body run. `frame:"page"`/`"paper"` lifts that
      // clamp so pos_y can place the object's centre on the text line. X origin is the
      // same left-margin line for para/page, so switching keeps pos_x meaning.
      if (op.frame != null) {
        const f = String(op.frame).toLowerCase();
        const VERT = { paper: 0, page: 1, para: 2 };
        const HORZ = { paper: 0, page: 1, column: 2, para: 3 };
        if (!(f in VERT)) throw new Error('frame must be para / page / paper');
        attr = ((attr & ~0x18 & ~0x300) | (VERT[f] << 3) | ((HORZ[f] ?? 3) << 8)) >>> 0;
      }
      cluster.writeUInt32LE(attr, d + 4);
      // Floating position (frame-relative; default paper/para per `op.frame`).
      // Meaningful for square/behind/front;
      // inline ignores it. Only written when the caller supplies it.
      if (op.pos_x_mm != null && d + GSO_POS_X_OFF + 4 <= cluster.length) {
        cluster.writeUInt32LE(Math.round(op.pos_x_mm * HWPUNIT_PER_MM) >>> 0, d + GSO_POS_X_OFF);
      }
      if (op.pos_y_mm != null && d + GSO_POS_Y_OFF + 4 <= cluster.length) {
        cluster.writeUInt32LE(Math.round(op.pos_y_mm * HWPUNIT_PER_MM) >>> 0, d + GSO_POS_Y_OFF);
      }
      if ((op.margin_mm != null || Array.isArray(op.margins)) && d + GSO_OUTMARGIN_OFF + 8 <= cluster.length) {
        const m = Array.isArray(op.margins)
          ? op.margins
          : [op.margin_mm, op.margin_mm, op.margin_mm, op.margin_mm];
        for (let i = 0; i < 4; i++) {
          cluster.writeUInt16LE(Math.round(m[i] * HWPUNIT_PER_MM) & 0xFFFF, d + GSO_OUTMARGIN_OFF + i * 2);
        }
      }
    }
    p += sz;
  }
  return cluster;
}

// Per-shape-record byte offsets of the W / H coordinates, keyed by the shape
// record tag. Hancom draws each shape from its record geometry (literal local
// coords), so resizing means rewriting these too — not just the CTRL/COMP
// bounding box. GT-decoded from the templates (15000×6750 = 53×24 mm markers):
//   rect (0x4f): 4 corners — W at the two right-edge x's, H at the two bottom y's
//   ellipse (0x50): bounding box right/bottom
//   line (0x4e): the endpoint vector (dx, dy)
//   arc (0x51): bounding box
// Each entry [byteOffset, factor]: write round(axisLen × factor). Most are ×1
// (a literal corner/endpoint coordinate); the ellipse stores center + axis
// endpoints, so its center/axis-x's are half the width, etc.
const SHAPE_REC_SIZE = {
  0x4f: { w: [[9, 1], [17, 1]], h: [[21, 1], [29, 1]] },          // RECTANGLE — 4 corners (verified)
  0x4e: { w: [[8, 1]], h: [[12, 1]] },                            // LINE — endpoint vector (verified)
  0x50: { w: [[4, 0.5], [12, 1], [20, 0.5]], h: [[8, 0.5], [16, 0.5]] }, // ELLIPSE — center(W/2,H/2)+axis(W,H/2) endpoints
  // arc (0x51) is center+axis+sweep-angle (W@17 H@13, irregular) — resizing W/H
  // alone won't preserve the curve; kept guarded (see resize guard below).
};

// Set the gso object's size (width/height, mm → HWPUNIT). Writes every place the
// size lives so they stay consistent: CTRL_HEADER bounding (W@16 H@20),
// SHAPE_COMPONENT curWidth/curHeight pairs (@20/24 + @28/32), and the shape
// RECORD's local geometry (per SHAPE_REC_SIZE — Hancom draws from these). Only
// the axes the caller supplies are touched. Unknown record tags get CTRL+COMP
// only (bounding resizes; geometry may not — caller should verify).
function applyGsoSize(cluster, op) {
  if (op.width_mm == null && op.height_mm == null) return cluster;
  const W = op.width_mm != null ? Math.round(op.width_mm * HWPUNIT_PER_MM) : null;
  const H = op.height_mm != null ? Math.round(op.height_mm * HWPUNIT_PER_MM) : null;
  const put = (off, v) => { if (v != null && off + 4 <= cluster.length) cluster.writeUInt32LE(v >>> 0, off); };
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = cluster.readUInt32LE(p); p += 4; }
    const d = p;
    if (tag === 0x47 && cluster.slice(d, d + 4).toString('latin1') === ' osg') {
      put(d + 16, W); put(d + 20, H);
    } else if (tag === 0x4C) { // SHAPE_COMPONENT: curWidth/curHeight pairs
      put(d + 20, W); put(d + 28, W); put(d + 24, H); put(d + 32, H);
    } else if (SHAPE_REC_SIZE[tag]) {
      const m = SHAPE_REC_SIZE[tag];
      if (W != null) for (const [o, f] of m.w) put(d + o, Math.round(W * f));
      if (H != null) for (const [o, f] of m.h) put(d + o, Math.round(H * f));
    }
    p += sz;
  }
  return cluster;
}

// Aspect-ratio resolution for object size. The default is to PRESERVE aspect:
// when the caller gives only one axis, the other is derived from `refRatio`
// (= refWidth / refHeight — native pixels for an image, the template's default
// extent for shapes/charts) so the object never distorts. Giving BOTH axes is
// the explicit override — the agent deliberately squeezing an object to fit a
// fixed slot without breaking the form. Returns a {width_mm, height_mm} object
// to hand straight to applyGsoSize (either field may stay null = use default).
function resolveAspectSize(op, refRatio) {
  const w = op.width_mm, h = op.height_mm;
  if (w != null && h != null) return { width_mm: w, height_mm: h };          // explicit override
  if (w != null && h == null && refRatio) return { width_mm: w, height_mm: w / refRatio };
  if (h != null && w == null && refRatio) return { width_mm: h * refRatio, height_mm: h };
  return { width_mm: w, height_mm: h };
}

// refRatio (W/H) from a cluster's gso CTRL_HEADER default extent (W@16, H@20).
function gsoCtrlRatio(cluster) {
  let p = 0;
  while (p + 4 <= cluster.length) {
    const h = cluster.readUInt32LE(p); p += 4;
    const tag = h & 0x3FF; let sz = (h >> 20) & 0xFFF;
    if (sz === 0xFFF) { sz = cluster.readUInt32LE(p); p += 4; }
    if (tag === 0x47 && cluster.slice(p, p + 4).toString('latin1') === ' osg') {
      const w = cluster.readUInt32LE(p + 16), hh = cluster.readUInt32LE(p + 20);
      if (w > 0 && hh > 0) return w / hh;
    }
    p += sz;
  }
  return null;
}

// Native pixel WxH of a PNG or JPEG buffer (for image aspect preservation).
function readImagePixelSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) { // PNG: IHDR W@16 H@20 (BE)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: scan SOF markers
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
      }
      if (p + 4 > buf.length) break;
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  return null;
}

// Build a {categories, series:[{name,values}]} model from op params, or null if
// the op carries no data overrides (then the template's default chart is used).

// Build a {categories, series:[{name,values}]} model from op params, or null if
// the op carries no data overrides (then the template's default chart is used).
function buildChartDataModel(op) {
  const hasData = Array.isArray(op.categories) || Array.isArray(op.series) || Array.isArray(op.data) || Number.isInteger(op.rows) || Number.isInteger(op.cols);
  if (!hasData) return null;
  let categories = Array.isArray(op.categories) ? op.categories.map(String) : null;
  const rows = Number.isInteger(op.rows) ? op.rows : (categories ? categories.length : 4);
  if (!categories) categories = Array.from({ length: rows }, (_, i) => `항목 ${i + 1}`);
  else if (categories.length !== rows) categories = categories.slice(0, rows).concat(Array.from({ length: Math.max(0, rows - categories.length) }, (_, i) => `항목 ${categories.length + i + 1}`));
  let series = null;
  if (Array.isArray(op.series)) series = op.series.map((s, i) => ({ name: String(s && s.name != null ? s.name : `계열 ${i + 1}`), values: (s && Array.isArray(s.values) ? s.values : []).map(Number) }));
  else if (Array.isArray(op.data)) series = op.data.map((vals, i) => ({ name: `계열 ${i + 1}`, values: (Array.isArray(vals) ? vals : []).map(Number) }));
  const cols = Number.isInteger(op.cols) ? op.cols : (series ? series.length : 3);
  if (!series) series = Array.from({ length: cols }, (_, c) => ({ name: `계열 ${c + 1}`, values: [] }));
  else if (series.length !== cols) series = series.slice(0, cols).concat(Array.from({ length: Math.max(0, cols - series.length) }, (_, c) => ({ name: `계열 ${series.length + c + 1}`, values: [] })));
  series = series.map((s, c) => { const v = s.values.slice(0, rows); while (v.length < rows) v.push(((v.length + c) % 5) + 1); return { name: s.name, values: v }; });
  return { categories, series };
}

// ── 차트 (chart) raw-patch — Hancom-Docs compatible ───────────────────────
//
// GT-first (each type GT'd from Hancom's 입력 › 차트 into a clean doc): a chart
// is ONE "ole$" gso object in a new paragraph, backed by a deflated OLE in
// BinData/BIN0001.OLE (regular-FAT, >4 KB). Hancom re-renders the chart from
// that OLE — no cached PNG needed. The gso cluster is type-INDEPENDENT (shared
// across all 20 types); only the OLE differs, so each chart-<N>.json template
// pairs the one shared cluster with its type's verbatim OLE. DocInfo gets one
// BIN_DATA def (attr 0x0002 = OLE storage, ext "OLE"); ID_MAPPINGS += 1.
//
// Optional data params (rows/cols/categories/series/data) edit the chart's
// OOXMLChartContents to change the grid; otherwise the default chart is used.
// Insertion targets a doc whose BinData starts empty (the common case).
export async function insertChartInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }
  // Charts dropped into a table cell are centered by default (user pref): ensure a
  // centered ParaShape exists (DocInfo write) before the per-chart Section0 step.
  let centerPsId = 0;
  if (ops.some((o) => o.cell && (Number.isInteger(o.cell.row) || Number.isInteger(o.cell.col)))) {
    centerPsId = await ensureAlignedParaShapeInFile(filePath, 'center');
  }
  const summary = [];
  for (const op of ops) {
    const type = Number.isInteger(op.chart_type) && op.chart_type >= 0 && op.chart_type <= 19 ? op.chart_type : 0;
    const tplName = (typeof op.template_override === 'string' && /^[A-Za-z0-9_-]+$/.test(op.template_override)) ? op.template_override : `chart-${type}`;
    const tplPath = `${__dirname}/references/chart-templates/${tplName}.json`;
    if (!existsSync(tplPath)) throw new Error(`insert_chart: no template for type ${type} (${tplPath})`);
    const tpl = JSON.parse(readFileSync(tplPath, 'utf8'));
    let oleBytes = Buffer.from(tpl.oleB64, 'base64');

    // Optional rows/cols/data editing — edit the OOXMLChartContents in the OLE.
    const dataModel = buildChartDataModel(op);
    const hasColor = (Array.isArray(op.colors) && op.colors.length > 0) || op.color != null || (Array.isArray(op.point_colors) && op.point_colors.length > 0);
    if (dataModel || hasColor) oleBytes = buildChartOleWithData(oleBytes, dataModel, op);

    // A sub-4096 OLE goes in the mini-stream (below). Re-deflate it at max
    // compression first: a mini-stream that exactly fills a 128-entry mini-FAT
    // sector makes Hancom drop the object (3-D pies, the largest small OLEs,
    // hit this). Maximal compression keeps the mini footprint well under 128.
    if (oleBytes.length < 4096) oleBytes = deflateRawSync(Buffer.from(inflateRawSync(oleBytes)), { level: 9 });

    // ── Step 1: CFB — ensure BinData folder + add the BIN000N.OLE stream ───
    // A clean doc → BIN0001.OLE; a doc that already holds chart/image BinData →
    // the next free BIN000N.OLE (so a second chart no longer collides). CFB routes
    // a stream by size: < 4096 B → mini-stream, else regular FAT. Hancom is strict
    // about this (a small OLE forced into the regular FAT renders as a broken-object
    // placeholder), so match the cutoff exactly — bigger bar/line charts go regular,
    // smaller pie/doughnut go mini. GT (handoff gt 2-chart) confirms the multi-chart
    // shape: append BIN000N + a 2nd BIN_DATA def (storage id N) + ID_MAPPINGS++.
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    if (!mssz) mssz = MSSZ_DEFAULT_IMG;
    let fat = readFat(buf, fatAddrs, ssz);
    let dir = readDirectory(buf, fat, ssz, dirStart);
    let rootChain = walkChain(fat, dir.entries[0].start);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);

    let binIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    if (binIdx < 0) {
      ({ buf, fat } = ensureDirSlot(buf, ssz, fat, fatAddrs, dirStart));
      dir = readDirectory(buf, fat, ssz, dirStart);
      const folderSlot = findUnusedDirSlot(dir.entries);
      if (folderSlot < 0) throw new Error('insert_chart: no free directory slot for the BinData folder');
      writeDirEntry(buf, dir.entries[folderSlot], 'BinData', 1, 0, 0);
      insertEntryIntoTree(buf, dir.entries, 0, folderSlot);
    }
    dir = readDirectory(buf, fat, ssz, dirStart);
    rootChain = walkChain(fat, dir.entries[0].start);
    const newName = pickFreeBinDataName(dir.entries, 'OLE');     // BIN000N.OLE (N = next free ordinal)
    const storageId = parseInt(newName.match(/BIN(\d{4})\./)[1], 10);
    ({ buf, fat } = ensureDirSlot(buf, ssz, fat, fatAddrs, dirStart));
    dir = readDirectory(buf, fat, ssz, dirStart);
    binIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    const oleSlot = findUnusedDirSlot(dir.entries);
    if (oleSlot < 0) throw new Error('insert_chart: no free directory slot for the OLE stream');

    let oleStartSec;
    if (oleBytes.length < 4096) {
      const alloc = allocMiniChain({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry: dir.entries[0] }, oleBytes.length);
      buf = alloc.buf; fat = alloc.fat; minifat = alloc.minifat; minifatStart = alloc.minifatStart; rootChain = alloc.rootChain;
      writeMiniChainBytes(buf, alloc.chain, rootChain, ssz, mssz, oleBytes);
      oleStartSec = alloc.chain[0];
    } else {
      const oa = allocRegularChain(buf, ssz, fat, fatAddrs, oleBytes.length);
      buf = oa.buf; fat = oa.fat;
      writeChainBytes(buf, oa.chain, ssz, oleBytes);
      oleStartSec = oa.chain[0];
    }
    dir = readDirectory(buf, fat, ssz, dirStart);
    binIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
    writeDirEntry(buf, dir.entries[oleSlot], newName, 2, oleStartSec, oleBytes.length, 0);
    insertEntryIntoTree(buf, dir.entries, binIdx, oleSlot);
    writeFileSync(filePath, buf);

    // ── Step 2: DocInfo — BIN_DATA def (attr 0x0002 = OLE storage), storage id N ──
    await addBinDataDefToDocInfo(filePath, storageId, 'OLE', 0x0002);

    // ── Step 3: Section0 — insert the chart cluster (one ole$ paragraph) ───
    {
      let b2 = readFileSync(filePath);
      let h = parseCfbHeader(b2);
      let f2 = readFat(b2, h.fatAddrs, h.ssz);
      const { entries } = readDirectory(b2, f2, h.ssz, h.dirStart);
      let mf2 = readMinifat(b2, f2, h.ssz, h.minifatStart);
      const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
      const secInMini = secEntry.size < 4096;
      let rc2 = null; const ensureRC = () => rc2 || (rc2 = walkChain(f2, entries[0].start));
      let sChain, sComp;
      if (secInMini) { const rc = ensureRC(); sChain = walkChain(mf2, secEntry.start); sComp = readMiniChainBytes(b2, sChain, rc, h.ssz, h.mssz, secEntry.size); }
      else { sChain = walkChain(f2, secEntry.start); sComp = readChainBytes(b2, sChain, h.ssz, secEntry.size); }
      let raw = Buffer.from(inflateRawSync(sComp));

      const records = parseRecords(raw);
      const cluster = Buffer.from(tpl.clusterHex, 'hex');
      // Stamp this chart's identity into the template cluster: binDataID = its storage
      // ordinal N, zOrder = one past the section's current max gso zOrder. For the first
      // chart these are 1 and 0 — the template's own values, so a no-op (byte-identical
      // to the prior single-chart output). For a 2nd+ chart they make it reference
      // BIN000N and stack above the existing object. (GT: handoff gt 2-chart.)
      setChartClusterIds(cluster, storageId, nextGsoZOrder(raw));
      // Default to like-char so the chart reserves its height and surrounding
      // text flows above/below it (set op.float:true for the floating original).
      if (op.cell && (Number.isInteger(op.cell.row) || Number.isInteger(op.cell.col))) {
        // ── Drop the chart INSIDE a table cell (centered, like-char). ──
        setGsoLikeChar(cluster, true);
        raw = spliceGsoIntoCell(raw, cluster, op.cell.para ?? 0, op.cell.control ?? 0, op.cell.row, op.cell.col, centerPsId);
      } else {
        applyGsoPlacement(cluster, op, resolveWrapMode(op));
        applyGsoSize(cluster, resolveAspectSize(op, gsoCtrlRatio(cluster))); // size, aspect-preserved (chart scales to frame)
        let insertAt = raw.length;
        const clusters = findClusterBoundaries(records);
        if (op.anchor && typeof op.anchor === 'string') {
          const ab = Buffer.from(op.anchor, 'utf16le');
          for (const c of clusters) { let hit = false; for (let i = c.startIdx + 1; i < c.endIdx; i++) { const r = records[i]; if (r.tag === TAG_PARA_TEXT && raw.slice(r.dataOff, r.dataOff + r.size).indexOf(ab) !== -1) { hit = true; break; } } if (hit) { insertAt = c.endIdx < records.length ? records[c.endIdx].headOff : raw.length; break; } }
        } else {
          const t = findLastSimpleBodyParagraph(records);
          insertAt = t.endIdx < records.length ? records[t.endIdx].headOff : raw.length;
        }
        // The chart goes at the requested position (end when no anchor) — even the
        // document's terminal paragraph renders fine now that inline charts carry
        // the correct like-char attribute (TABLE_WRAP.inline = 0x1, matching Hancom's
        // own floating→글자처럼 output and insert_image). The earlier 0x200001 bit-21
        // was what made a terminal OLE chart render blank; no trailing-paragraph
        // workaround is needed.
        raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);
        normalizeLastParaFlag(raw);
      }

      let newComp;
      if (secInMini) {
        const rc = ensureRC();
        const e = deflateMiniChainWithExpansion({ buf: b2, ssz: h.ssz, mssz: h.mssz, fat: f2, fatAddrs: h.fatAddrs, minifat: mf2, minifatStart: h.minifatStart, rootChain: rc, rootEntry: entries[0] }, raw, sChain);
        b2 = e.buf; f2 = e.fat; mf2 = e.minifat; h.minifatStart = e.minifatStart; newComp = e.compressed;
        if (e.promoted) { sChain = e.newRegularChain; writeChainBytes(b2, sChain, h.ssz, newComp); b2.writeInt32LE(sChain[0], secEntry.entryFileOffset + 0x74); }
        else { rc2 = e.rootChain; sChain = e.miniChain; writeMiniChainBytes(b2, sChain, rc2, h.ssz, h.mssz, newComp); }
      } else {
        const e = deflateAndFitWithExpansion(raw, sChain.length * h.ssz, h.ssz, f2, h.fatAddrs, sChain, b2, false);
        b2 = e.buf; f2 = e.fat; sChain = e.chain; newComp = e.compressed; writeChainBytes(b2, sChain, h.ssz, newComp);
      }
      b2.writeUInt32LE(newComp.length, secEntry.entryFileOffset + 0x78);
      b2.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      writeFileSync(filePath, b2);
    }

    summary.push({ section: 0, chart_type: type, ole: `BinData/${newName}` });
  }

  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}

// ── delete a floating object (image / chart / shape) — raw-patch ──────────
// Removes the targeted gso object completely. For BinData-backed objects
// (images/charts) it then shifts every higher storage id down by 1 so the
// BIN_DATA defs / stream pointers / gso binDataIDs stay contiguous: Hancom Docs
// resolves a binDataID by position, so leaving a gap renders the higher objects
// as broken-image placeholders (GT: claw-hancomdocs delete renumbers; the gap
// case is render-confirmed broken, the renumbered case render-confirmed clean).
// CFB streams are NOT renamed or removed (no red-black-tree surgery): the
// dir-entry chain pointers among BIN000{S..N} are rotated so each name serves the
// next object's bytes, the deleted object's bytes are zeroed, and BIN000N is left
// as a harmless orphan (no def references it). op.index = 0-based gso ordinal in
// document order (find_objects / extract order). To delete several, sort indices
// descending — each delete re-reads the file and shifts lower indices.
const PIC_BINID_OFF = 71;   // HWPTAG_SHAPE_COMPONENT_PICTURE (0x55) binItem id (u16)
const OLE_BINID_OFF = 12;   // HWPTAG_SHAPE_COMPONENT_OLE (0x54) binData id (u16)
function gsoBinIdOffset(raw, recs, gsoRecIdx) {
  const lvl = recs[gsoRecIdx].level;
  for (let j = gsoRecIdx + 1; j < recs.length && recs[j].level > lvl; j++) {
    const r = recs[j];
    if (r.tag === 0x55 && r.size >= PIC_BINID_OFF + 2) return r.dataOff + PIC_BINID_OFF;
    if (r.tag === 0x54 && r.size >= OLE_BINID_OFF + 2) return r.dataOff + OLE_BINID_OFF;
  }
  return -1; // shape / non-BinData object
}
const _isGso = (buf, r) => r.tag === TAG_CTRL_HEADER && buf.slice(r.dataOff, r.dataOff + 4).toString('latin1') === ' osg';
// read+inflate, mutate, deflate+write one CFB stream in place (mini or regular)
function _rewriteStream(filePath, pathParts, mutate) {
  let b2 = readFileSync(filePath);
  const h = parseCfbHeader(b2);
  let f2 = readFat(b2, h.fatAddrs, h.ssz);
  const { entries } = readDirectory(b2, f2, h.ssz, h.dirStart);
  let mf2 = readMinifat(b2, f2, h.ssz, h.minifatStart);
  const ent = findStreamEntry(entries, pathParts);
  const inMini = ent.size < 4096;
  const rc = walkChain(f2, entries[0].start);
  let chain = inMini ? walkChain(mf2, ent.start) : walkChain(f2, ent.start);
  const comp = inMini ? readMiniChainBytes(b2, chain, rc, h.ssz, h.mssz, ent.size) : readChainBytes(b2, chain, h.ssz, ent.size);
  const out = mutate(Buffer.from(inflateRawSync(comp)));
  let newComp;
  if (inMini) {
    const e = deflateMiniChainWithExpansion({ buf: b2, ssz: h.ssz, mssz: h.mssz, fat: f2, fatAddrs: h.fatAddrs, minifat: mf2, minifatStart: h.minifatStart, rootChain: rc, rootEntry: entries[0] }, out, chain);
    b2 = e.buf; newComp = e.compressed;
    if (e.promoted) { writeChainBytes(b2, e.newRegularChain, h.ssz, newComp); b2.writeInt32LE(e.newRegularChain[0], ent.entryFileOffset + 0x74); }
    else writeMiniChainBytes(b2, e.miniChain, e.rootChain, h.ssz, h.mssz, newComp);
  } else {
    const e = deflateAndFitWithExpansion(out, chain.length * h.ssz, h.ssz, f2, h.fatAddrs, chain, b2, false);
    b2 = e.buf; newComp = e.compressed; writeChainBytes(b2, e.chain, h.ssz, newComp);
  }
  b2.writeUInt32LE(newComp.length, ent.entryFileOffset + 0x78);
  b2.writeUInt32LE(0, ent.entryFileOffset + 0x7C);
  writeFileSync(filePath, b2);
}

export async function deleteObjectInPlace(filePath, ops) {
  const summary = [];
  for (const op of ops) {
    const targetIndex = Number.isInteger(op.index) ? op.index : 0;
    let delId = null;

    // ── Step 1: Section0 — drop gso #targetIndex's paragraph, shift higher gso ids ──
    _rewriteStream(filePath, ['BodyText', 'Section0'], (raw) => {
      const recs = parseRecords(raw);
      let seen = -1, gi = -1;
      for (let i = 0; i < recs.length; i++) if (_isGso(raw, recs[i])) { seen++; if (seen === targetIndex) { gi = i; break; } }
      if (gi < 0) throw new Error(`delete_object: object index ${targetIndex} not found (${seen + 1} object(s))`);
      const bidOff = gsoBinIdOffset(raw, recs, gi);
      delId = bidOff >= 0 ? raw.readUInt16LE(bidOff) : null;
      let a = gi; while (a > 0 && !(recs[a].tag === TAG_PARA_HEADER && recs[a].level === 0)) a--;
      let b = a + 1; while (b < recs.length && !(recs[b].tag === TAG_PARA_HEADER && recs[b].level === 0)) b++;
      // Replace the object's paragraph with an EMPTY paragraph in place — don't drop it.
      // GT: Hancom deleting an object empties that paragraph (a blank line stays where
      // the object was). This also matches Hancom for a MIDDLE object and is REQUIRED for
      // the section's LAST object (else the section ends on a gso cluster → cannot_open),
      // so one uniform rule keeps us GT-faithful in every position and internally
      // consistent. Built from the deleted para's own PARA_HEADER + CHAR_SHAPE so the
      // para_shape/char_shape ids stay valid; PARA_TEXT (inline anchor) + the gso cluster
      // are dropped and the header rewritten to Hancom's empty-paragraph byte-shape
      // (PARA_HEADER + CHAR_SHAPE, no PARA_TEXT/LINE_SEG; nchars per the rule below).
      const phRec = recs[a];
      const ph = Buffer.from(raw.slice(phRec.headOff, phRec.dataOff + phRec.size));
      const phDataOff = phRec.dataOff - phRec.headOff;
      // nchars: 1 char (the paragraph break). The high bit 0x80000000 marks the section's
      // LAST paragraph — GT shows EXACTLY one para per section carries it (the terminator).
      // If our empty para is now the last paragraph it MUST set it (else Hancom can't find
      // the section end → cannot_open); if it's a MIDDLE para it must NOT (the high bit
      // makes Hancom read a ~2-billion char count and stop rendering every following para).
      const isLastPara = b >= recs.length;
      ph.writeUInt32LE(isLastPara ? 0x80000001 : 1, phDataOff);
      ph.writeUInt32LE(0, phDataOff + 4);          // control_mask: no controls remain
      ph.writeUInt16LE(0, phDataOff + 16);         // line-seg count → 0: we keep no LINE_SEG (Hancom recomputes layout). GT confirms 0.
      let csRec = null;
      for (let k = a + 1; k < recs.length && !(recs[k].tag === TAG_PARA_HEADER && recs[k].level === 0); k++) {
        if (recs[k].tag === TAG_PARA_CHAR_SHAPE) { csRec = recs[k]; break; }
      }
      const cs = csRec ? raw.slice(csRec.headOff, csRec.dataOff + csRec.size) : Buffer.alloc(0);
      const emptyPara = Buffer.concat([ph, cs]);
      let out = Buffer.concat([raw.slice(0, recs[a].headOff), emptyPara, raw.slice(b < recs.length ? recs[b].headOff : raw.length)]);
      if (delId != null) {
        const r2 = parseRecords(out);
        for (let i = 0; i < r2.length; i++) if (_isGso(out, r2[i])) { const o = gsoBinIdOffset(out, r2, i); if (o >= 0) { const v = out.readUInt16LE(o); if (v > delId) out.writeUInt16LE(v - 1, o); } }
      }
      return out;
    });

    if (delId == null) { summary.push({ deleted_object: targetIndex, binData: null }); continue; }

    // ── Step 2: DocInfo — remove BIN_DATA def delId, decrement higher ids + count ──
    _rewriteStream(filePath, ['DocInfo'], (di) => {
      for (const r of parseRecords(di)) if (r.tag === TAG_BIN_DATA_DEF && di.readUInt16LE(r.dataOff + 2) === delId) { di = Buffer.concat([di.slice(0, r.headOff), di.slice(r.headOff + (r.ext ? 8 : 4) + r.size)]); break; }
      for (const r of parseRecords(di)) {
        if (r.tag === TAG_BIN_DATA_DEF) { const sid = di.readUInt16LE(r.dataOff + 2); if (sid > delId) di.writeUInt16LE(sid - 1, r.dataOff + 2); }
        if (r.tag === TAG_ID_MAPPINGS) di.writeUInt32LE((di.readUInt32LE(r.dataOff) - 1) >>> 0, r.dataOff);
      }
      return di;
    });

    // ── Step 3: CFB — remove BIN000{delId} + renumber survivors to a contiguous
    // BIN0001..BIN000(N-1), then rebuild the BinData child tree ──────────────────
    // We RENAME each higher survivor's slot (k → k-1), keeping its own (start, size,
    // ext) in place, rather than ROTATING (start,size) pointers between slots. A
    // rotation makes Hancom reject the file whenever a renumber crosses the mini↔
    // regular storage boundary (e.g. a chart's >4 KB regular stream and an image's
    // <4 KB mini stream trading slots): sheetjs CFB.read tolerates the slot whose
    // size no longer matches its sector class, but Hancom does not. Renaming leaves
    // every stream in its own slot so its storage class never moves — and it mirrors
    // Hancom's own delete, which renames image3→image2 and keeps N-1 entries.
    {
      let b2 = readFileSync(filePath);
      const h = parseCfbHeader(b2);
      const f2 = readFat(b2, h.fatAddrs, h.ssz);
      const { entries } = readDirectory(b2, f2, h.ssz, h.dirStart);
      const mf2 = readMinifat(b2, f2, h.ssz, h.minifatStart);
      const rc = entries[0].start >= 0 ? walkChain(f2, entries[0].start) : [];
      const slotOfBin = {}; let N = 0;
      entries.forEach((e, idx) => { const m = e.type === 2 && /^BIN(\d{4})\./.exec(e.name); if (m) { const n = parseInt(m[1], 10); slotOfBin[n] = idx; if (n > N) N = n; } });
      if (slotOfBin[delId] != null) {
        const dEnt = entries[slotOfBin[delId]];
        // 1. zero + free the deleted stream's own chain (prevents content extraction).
        const dStart = b2.readInt32LE(dEnt.entryFileOffset + 0x74);
        const dSize = b2.readUInt32LE(dEnt.entryFileOffset + 0x78);
        const dMini = dSize > 0 && dSize < 4096;
        const dChain = dStart >= 0 ? (dMini ? walkChain(mf2, dStart) : walkChain(f2, dStart)) : [];
        for (const s of dChain) { if (dMini) { const bo = s * h.mssz; const o = (512 + rc[Math.floor(bo / h.ssz)] * h.ssz) + (bo % h.ssz); b2.fill(0, o, o + h.mssz); } else b2.fill(0, 512 + s * h.ssz, 512 + s * h.ssz + h.ssz); }
        for (const s of dChain) { if (dMini) writeMinifatEntry(b2, h.ssz, h.mssz, f2, h.minifatStart, s, FREESECT); else writeFatEntry(b2, h.ssz, h.fatAddrs, s, FREESECT); }
        // 2. free the deleted directory slot (zero it, NOSTREAM the pointers, type 0).
        { const off = dEnt.entryFileOffset; b2.fill(0, off, off + 128); b2.writeInt32LE(-1, off + 0x44); b2.writeInt32LE(-1, off + 0x48); b2.writeInt32LE(-1, off + 0x4C); dEnt.type = 0; dEnt.name = ''; }
        // 3. renumber survivors: BIN000k → BIN000(k-1) for k > delId. The 4 digits sit
        //    at byte 6 (after "BIN", UTF-16LE); ext + start/size are untouched so each
        //    stream keeps its sector class. Lower (k < delId) keep their names.
        const survivors = [];
        for (let k = 1; k <= N; k++) {
          if (k === delId || slotOfBin[k] == null) continue;
          const e = entries[slotOfBin[k]];
          if (k > delId) { const nn = String(k - 1).padStart(4, '0'); Buffer.from(nn, 'utf16le').copy(b2, e.entryFileOffset + 6); e.name = 'BIN' + nn + e.name.slice(7); }
          survivors.push(slotOfBin[k]);
        }
        // 4. rebuild the BinData child tree from the survivors — or, if none remain,
        //    drop the now-empty BinData storage (a clean no-binary .hwp has NO BinData
        //    folder; an empty folder makes Hancom reject the document).
        const binDataIdx = entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
        if (binDataIdx >= 0) {
          if (survivors.length > 0) {
            rebuildChildTree(b2, entries, binDataIdx, survivors);
          } else {
            const rootKids = collectTreeNodes(entries, entries[0].child).filter((i) => i !== binDataIdx);
            const off = entries[binDataIdx].entryFileOffset; b2.fill(0, off, off + 128); b2.writeInt32LE(-1, off + 0x44); b2.writeInt32LE(-1, off + 0x48); b2.writeInt32LE(-1, off + 0x4C); entries[binDataIdx].type = 0; entries[binDataIdx].name = '';
            rebuildChildTree(b2, entries, 0, rootKids);
          }
        }
      }
      writeFileSync(filePath, b2);
    }
    summary.push({ deleted_object: targetIndex, binDataId: delId });
  }
  // The stored page-1 thumbnail (PrvImage) is now stale — for an object that sat on page 1
  // it would still show the thing we just deleted (a redaction leak). We can't render a
  // faithful new thumbnail in a raw patch, so invalidate it; Hancom regenerates PrvImage on
  // the next open/save and a file manager shows a blank thumbnail instead of a stale one.
  if (summary.length) _invalidatePreviewImage(filePath);
  return Object.assign(summary, { mode: 'in-place', deleted_count: summary.length });
}

// Zero + empty the PrvImage stream (see deleteObjectInPlace). PrvText is left intact —
// deleting an object changes no body text, so the text preview stays valid.
function _invalidatePreviewImage(filePath) {
  const b = readFileSync(filePath);
  const h = parseCfbHeader(b);
  const fat = readFat(b, h.fatAddrs, h.ssz);
  const { entries } = readDirectory(b, fat, h.ssz, h.dirStart);
  const mf = readMinifat(b, fat, h.ssz, h.minifatStart);
  const rc = entries[0].start >= 0 ? walkChain(fat, entries[0].start) : [];
  const e = entries.find((x) => x.type === 2 && x.name === 'PrvImage');
  if (!e) return;
  const start = b.readInt32LE(e.entryFileOffset + 0x74);
  const size = b.readUInt32LE(e.entryFileOffset + 0x78);
  if (size > 0 && start >= 0) {
    const mini = size < 4096;
    for (const s of (mini ? walkChain(mf, start) : walkChain(fat, start))) {
      if (mini) { const bo = s * h.mssz; const o = (512 + rc[Math.floor(bo / h.ssz)] * h.ssz) + (bo % h.ssz); b.fill(0, o, o + h.mssz); writeMinifatEntry(b, h.ssz, h.mssz, fat, h.minifatStart, s, FREESECT); }
      else { b.fill(0, 512 + s * h.ssz, 512 + s * h.ssz + h.ssz); writeFatEntry(b, h.ssz, h.fatAddrs, s, FREESECT); }
    }
  }
  b.writeInt32LE(ENDOFCHAIN, e.entryFileOffset + 0x74); // empty stream → Hancom regenerates
  b.writeUInt32LE(0, e.entryFileOffset + 0x78);
  writeFileSync(filePath, b);
}


// ── 도형 (shapes: rectangle / ellipse) raw-patch ──────────────────────────
//
// GT-first (shape_rect.hwp / shape_ellipse from Hancom's 입력 › 도형): a shape
// is a gso drawing object (same family as 문단 띠) attached to the anchor
// paragraph — an inline gso char (0x000b "gso ") goes into the paragraph's
// PARA_TEXT (char_count += 8, control_mask |= 0x800), and a gso cluster is
// appended: CTRL_HEADER "gso " + SHAPE_COMPONENT (id "cer$"=rect / "lle$"=
// ellipse) + the shape record (RECTANGLE 0x4f / ELLIPSE 0x50). The rect and
// ellipse SHAPE_COMPONENTs are byte-identical except the 8-byte id prefix.
// Default size 15000×6750 HWPUNIT (~53×24mm), floating. Section0-only.
// rect & ellipse share a 62-byte gso CTRL and a 252-byte SHAPE_COMPONENT
// (identical except the 8-byte shape-id prefix). line has its own 58-byte
// gso CTRL and 239-byte SHAPE_COMPONENT. Each kind: {gsoCtrl, comp, recTag,
// recHex}; the SHAPE_COMPONENT instance id sits at comp.length-6.
const SHAPE_GSO_CTRL_HEX = '206f736700406a144a2e00002c4c0000983a00005e1a0000000000000000000000000000ec969a42000000000800acc001ac15d6200085c7c8b2e4b22e00';
const SHAPE_COMP_RECT_HEX = '6365722463657224000000000000000000000100983a00005e1a0000983a00005e1a000000000b00000000000000000000000100000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000021000000410000c00001000000ffffff0000000000ffffffff000000000000000000b2b2b2000000000000000000ed969a020000';
const SHAPE_LINE_GSO_HEX  = '206f736700406a144a2e00002c4c0000983a00005e1a0000000000000000000000000000fb5a9b4200000000060020c1200085c7c8b2e4b22e00';
const SHAPE_LINE_COMP_HEX = '6e696c246e696c24000000000000000000000100983a00005e1a0000983a00005e1a000000000b00000000000000000000000100000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000021000000410000c000000000000000000000000000b2b2b2000000000000000000fc5a9b020000';
const SHAPE_KINDS = {
  rect:    { gsoCtrl: SHAPE_GSO_CTRL_HEX, comp: SHAPE_COMP_RECT_HEX, recTag: TAG_SHAPE_COMPONENT_RECTANGLE, recHex: '000000000000000000983a000000000000983a00005e1a0000000000005e1a0000' },
  ellipse: { gsoCtrl: SHAPE_GSO_CTRL_HEX, comp: SHAPE_COMP_RECT_HEX, idPrefix: '6c6c65246c6c6524', recTag: 0x50, recHex: '000000004c1d00002f0d0000983a00002f0d00004c1d0000000000000000000000000000000000000000000000000000000000000000000000000000' },
  line:    { gsoCtrl: SHAPE_LINE_GSO_HEX, comp: SHAPE_LINE_COMP_HEX, recTag: 0x4e, recHex: '0000000000000000983a00005e1a000000000000' },
  arc:     { gsoCtrl: SHAPE_LINE_GSO_HEX, comp: SHAPE_COMP_RECT_HEX, idPrefix: '6372612463726124', recTag: 0x51, recHex: '000000000000000000000000005e1a0000983a000000000000' },
};

export async function insertShapeInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  // Objects dropped into a table cell are centered by default (user pref): make
  // sure a centered ParaShape exists (DocInfo write) before we touch Section0.
  let centerPsId = 0;
  if (ops.some((o) => o.cell && (Number.isInteger(o.cell.row) || Number.isInteger(o.cell.col)))) {
    centerPsId = await ensureAlignedParaShapeInFile(filePath, 'center');
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const shapeName = SHAPE_KINDS[op.shape] ? op.shape : 'rect';
    const kind = SHAPE_KINDS[shapeName];
    if ((op.width_mm != null || op.height_mm != null) && shapeName === 'arc') {
      // arc geometry is center+axis+sweep-angle; resizing W/H alone won't keep the
      // curve, and the layout isn't GT-mapped — reject cleanly rather than distort.
      throw new Error('insert_shape: width_mm/height_mm not yet supported for arc (rect/ellipse/line only — resize the arc in Hancom desktop)');
    }
    const records = parseRecords(raw);

    if (op.cell && (Number.isInteger(op.cell.row) || Number.isInteger(op.cell.col))) {
      // ── Insert the shape INSIDE a table cell as a new treat-as-char paragraph.
      // Build a self-contained shape paragraph (like the image path), force the gso
      // to like-char (글자처럼 취급, attr bit 0) so it sits in the cell flow, drop it
      // two levels deeper, and splice it at the cell's end (count++ + last-para flag).
      const para = op.cell.para ?? 0, control = op.cell.control ?? 0;
      const target = tableCellRecords(records, raw, para, control)
        .find((c) => c.row === op.cell.row && c.col === op.cell.col);
      if (!target) throw new Error(`insert_shape: cell (row=${op.cell.row}, col=${op.cell.col}) not found in table at para ${para} control ${control}`);
      const inst = pickFreshInstanceId(records, raw);
      const ph = Buffer.alloc(24);
      ph.writeUInt32LE(9, 0); ph.writeUInt32LE(0x800, 4);
      ph.writeUInt16LE(centerPsId & 0xFFFF, 8); // centered paragraph (object centered in cell)
      ph.writeUInt16LE(1, 12); ph.writeUInt32LE(inst >>> 0, 18);
      const pt = Buffer.from('0b00206f736700000000000000000b000d00', 'hex'); // gso char + EOP
      const cs = Buffer.alloc(8);
      const ch = Buffer.from(kind.gsoCtrl, 'hex');
      ch.writeUInt32LE((inst + 0x10) >>> 0, 36);
      ch.writeUInt32LE((ch.readUInt32LE(4) | 1) >>> 0, 4); // 글자처럼 취급
      const sc = Buffer.from(kind.comp, 'hex');
      if (kind.idPrefix) Buffer.from(kind.idPrefix, 'hex').copy(sc, 0);
      sc.writeUInt32LE((inst + 0x11) >>> 0, sc.length - 6);
      const rec = Buffer.from(kind.recHex, 'hex');
      const shapePara = Buffer.concat([
        buildRecordHeader(TAG_PARA_HEADER, 0, ph.length), ph,
        buildRecordHeader(TAG_PARA_TEXT, 1, pt.length), pt,
        buildRecordHeader(TAG_PARA_CHAR_SHAPE, 1, cs.length), cs,
        buildRecordHeader(TAG_CTRL_HEADER, 1, ch.length), ch,
        buildRecordHeader(TAG_SHAPE_COMPONENT, 2, sc.length), sc,
        buildRecordHeader(kind.recTag, 3, rec.length), rec,
      ]);
      const shapeCell = relevelCluster(shapePara, 2);
      setGsoOutMarginTopBottom(shapeCell, CELL_OBJ_VMARGIN_HU); // top/bottom breathing room
      raw = Buffer.concat([raw.slice(0, target.endByte), shapeCell, raw.slice(target.endByte)]);
      const t2 = tableCellRecords(parseRecords(raw), raw, para, control)
        .find((c) => c.row === op.cell.row && c.col === op.cell.col);
      const lhDataOff = t2.startByte + 4;
      raw.writeUInt16LE((raw.readUInt16LE(lhDataOff) + 1) & 0xFFFF, lhDataOff); // nParagraphs++
      normalizeCellLastParaFlag(raw, t2.startByte, t2.endByte, 2);
      summary.push({ section: 0, shape: shapeName, cell: { row: op.cell.row, col: op.cell.col } });
      continue;
    }

    // Anchor paragraph + its level-1 PARA_TEXT.
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null;
    if (op.anchor && typeof op.anchor === 'string') {
      const anchorBuf = Buffer.from(op.anchor, 'utf16le');
      for (const c of clusters) {
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT && r.level === 1 &&
              raw.slice(r.dataOff, r.dataOff + r.size).indexOf(anchorBuf) !== -1) { cluster = c; ptRec = r; break; }
        }
        if (ptRec) break;
      }
    }
    if (!ptRec) {
      for (const c of clusters) {
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT && r.level === 1) { cluster = c; ptRec = r; break; }
        }
        if (ptRec) break;
      }
    }
    if (!ptRec) throw new Error('insert_shape: no top-level body paragraph found to anchor the shape');

    const paraHeaderRec = records[cluster.startIdx];
    const inst = pickFreshInstanceId(records, raw);

    // 1) Inline gso char (0x000b "gso ") before the paragraph's EOP.
    const gsoChar = Buffer.from('0b00206f736700000000000000000b00', 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const insAt = oldBody.length >= 2 ? oldBody.length - 2 : oldBody.length;
    const newBody = Buffer.concat([oldBody.slice(0, insAt), gsoChar, oldBody.slice(insAt)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) gso cluster: CTRL_HEADER + SHAPE_COMPONENT + shape record.
    const ch = Buffer.from(kind.gsoCtrl, 'hex'); ch.writeUInt32LE(inst >>> 0, 36);
    const sc = Buffer.from(kind.comp, 'hex');
    if (kind.idPrefix) Buffer.from(kind.idPrefix, 'hex').copy(sc, 0); // ellipse: swap rect→ellipse id
    sc.writeUInt32LE((inst + 1) >>> 0, sc.length - 6);          // fresh shape instance id
    const rec = Buffer.from(kind.recHex, 'hex');
    const cluster2 = Buffer.concat([
      buildRecordHeader(TAG_CTRL_HEADER, 1, ch.length), ch,
      buildRecordHeader(TAG_SHAPE_COMPONENT, 2, sc.length), sc,
      buildRecordHeader(kind.recTag, 3, rec.length), rec,
    ]);
    // Placement: inline (글자처럼) by default, or wrap=topbottom/square/behind/front.
    applyGsoPlacement(cluster2, op, resolveWrapMode(op));
    applyGsoSize(cluster2, resolveAspectSize(op, gsoCtrlRatio(cluster2))); // size, aspect-preserved
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 8, control_mask |= 0x800 (char 0x0b).
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x800) >>> 0, phOff + 4);

    raw = Buffer.concat([raw.slice(0, clusterEndOff), cluster2, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, shape: shapeName, anchor: op.anchor ?? null });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 수식 (equation: EQEDIT) raw-patch ─────────────────────────────────────
// GT-first (Hancom 입력 › 수식, downloaded as .hwp & byte-reversed — no HWPX
// conversion): an equation is a self-contained like-char control paragraph —
//   PARA_HEADER + PARA_TEXT(inline eqedit char 0x000b "deqe") + PARA_CHAR_SHAPE
//   + CTRL_HEADER "deqe" (CommonObjAttr, like-char) + EQEDIT(0x58) record.
// The EQEDIT(0x58) record carries the script: 00000000 + u16(script char count)
// + UTF-16(script) + a 72-byte GT-verbatim tail (base size 1000=10pt, color,
// "Equation Version 60" / "HancomEQN" engine strings). Only the script region
// varies. Default object size ~5200×1163 HWPUNIT. Section0-only (no BinData /
// DocInfo). Centered (+ a default top/bottom margin) when dropped into a cell.
const TAG_EQEDIT = 0x58;
const EQ_PARA_TEXT_HEX = '0b006465716500000000000000000b000d00'; // eqedit inline char + EOP
const EQ_CHAR_SHAPE_HEX = '0000000008000000';
const EQ_DEQE_CTRL_HEX = '6465716511232a1c0000000000000000501400008b040000000000003800380000000000ca56a94200000000070018c2ddc2200085c7c8b2e4b22e00';
const EQ_DATA_SUFFIX_HEX = 'e8030000000000005900000013004500710075006100740069006f006e002000560065007200730069006f006e002000360030000900480061006e0063006f006d00450051004e00';

// Build a self-contained equation paragraph for `script` (the EQEDIT source,
// e.g. "x^2 + y^2 = z^2"). psId = the paragraph's para_shape (alignment).
// inst seeds a fresh instance id (deqe CTRL @36 = inst+0x10). cellMarginHu
// (optional) sets the deqe CommonObjAttr top/bottom outMargin (off 32/34) so an
// in-cell equation gets a little vertical breathing room (the row grows to fit).
function buildEquationCluster(script, inst, psId, cellMarginHu) {
  const ph = Buffer.alloc(24);
  ph.writeUInt32LE(9, 0); ph.writeUInt32LE(0x800, 4);
  ph.writeUInt16LE((psId || 0) & 0xFFFF, 8); // para_shape (alignment)
  ph.writeUInt16LE(1, 12); ph.writeUInt32LE(inst >>> 0, 18);
  const pt = Buffer.from(EQ_PARA_TEXT_HEX, 'hex');
  const cs = Buffer.from(EQ_CHAR_SHAPE_HEX, 'hex');
  const ch = Buffer.from(EQ_DEQE_CTRL_HEX, 'hex');
  ch.writeUInt32LE((inst + 0x10) >>> 0, 36);
  if (Number.isInteger(cellMarginHu)) {
    ch.writeUInt16LE(cellMarginHu & 0xFFFF, 32); // deqe outMargin top
    ch.writeUInt16LE(cellMarginHu & 0xFFFF, 34); // deqe outMargin bottom
  }
  const lenField = Buffer.alloc(2); lenField.writeUInt16LE(script.length & 0xFFFF, 0);
  const eq = Buffer.concat([
    Buffer.from('00000000', 'hex'), lenField, Buffer.from(script, 'utf16le'),
    Buffer.from(EQ_DATA_SUFFIX_HEX, 'hex'),
  ]);
  return Buffer.concat([
    buildRecordHeader(TAG_PARA_HEADER, 0, ph.length), ph,
    buildRecordHeader(TAG_PARA_TEXT, 1, pt.length), pt,
    buildRecordHeader(TAG_PARA_CHAR_SHAPE, 1, cs.length), cs,
    buildRecordHeader(TAG_CTRL_HEADER, 1, ch.length), ch,
    buildRecordHeader(TAG_EQEDIT, 2, eq.length), eq,
  ]);
}

// Insert an equation. Each op: { script: string, anchor?: string,
// cell?: {row, col, para?, control?} }. `script` is the EQEDIT (Hancom 수식)
// source string. In a cell the equation is centered + given a default vertical
// margin (matching insert_image/shape/chart). Size/spacing tuning is deferred
// to the HWPX-team coordination (per user) — default object size goes in as-is.
export async function insertEquationInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }
  // Equations dropped into a table cell are centered by default (user pref):
  // make sure a centered ParaShape exists (DocInfo write) before Section0.
  let centerPsId = 0;
  if (ops.some((o) => o.cell && (Number.isInteger(o.cell.row) || Number.isInteger(o.cell.col)))) {
    centerPsId = await ensureAlignedParaShapeInFile(filePath, 'center');
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const script = (typeof op.script === 'string' && op.script.length) ? op.script : 'x^2 + y^2 = z^2';
    const records = parseRecords(raw);
    const inst = pickFreshInstanceId(records, raw);

    if (op.cell && (Number.isInteger(op.cell.row) || Number.isInteger(op.cell.col))) {
      // ── Drop the equation INSIDE a table cell — centered, with vertical margin.
      // spliceGsoIntoCell re-levels +2, sets the centered para_shape, splices at
      // the cell end, bumps nParagraphs, fixes the last-para flag. Its gso-margin
      // step is a no-op for "deqe" (not ' osg'), so we pre-set the deqe outMargin.
      const cluster = buildEquationCluster(script, inst, centerPsId, CELL_OBJ_VMARGIN_HU);
      raw = spliceGsoIntoCell(raw, cluster, op.cell.para ?? 0, op.cell.control ?? 0, op.cell.row, op.cell.col, centerPsId);
      summary.push({ section: 0, equation: script, cell: { row: op.cell.row, col: op.cell.col } });
      continue;
    }

    // ── Body: insert as a new paragraph after the anchor (or last body para),
    // cloning that paragraph's para_shape so the equation line matches its
    // alignment.
    const clusters = findClusterBoundaries(records);
    let psId = 0, insertAt = raw.length;
    if (op.anchor && typeof op.anchor === 'string') {
      const ab = Buffer.from(op.anchor, 'utf16le');
      for (const c of clusters) {
        let hit = false;
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT && raw.slice(r.dataOff, r.dataOff + r.size).indexOf(ab) !== -1) { hit = true; break; }
        }
        if (hit) {
          psId = raw.readUInt16LE(records[c.startIdx].dataOff + 8);
          insertAt = c.endIdx < records.length ? records[c.endIdx].headOff : raw.length;
          break;
        }
      }
    } else {
      const t = findLastSimpleBodyParagraph(records);
      psId = raw.readUInt16LE(records[t.startIdx].dataOff + 8);
      insertAt = t.endIdx < records.length ? records[t.endIdx].headOff : raw.length;
    }
    const cluster = buildEquationCluster(script, inst, psId);
    raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);
    normalizeLastParaFlag(raw);
    summary.push({ section: 0, equation: script, anchor: op.anchor ?? null });
  }

  // Deflate + write back (mirror insert_shape's Section0-only path).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
    newCompressed = ext.compressed;
    if (ext.promoted) {
      chain = ext.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext.rootChain;
      chain = ext.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain;
    newCompressed = ext.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);
  writeFileSync(filePath, buf);

  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── 글상자 (text box) raw-patch ───────────────────────────────────────────
// GT-first (Hancom's 입력 › 글상자): a text box is a rect gso object carrying
// inner text. Same anchor-attach as insert_shape (inline gso char 0x000b in
// the anchor PARA_TEXT, char_count += 8, control_mask |= 0x800), but the gso
// cluster is richer: CTRL_HEADER "gso " + SHAPE_COMPONENT "cer$" + LIST_HEADER
// + an inner text paragraph (PARA_HEADER/PARA_TEXT/CHAR_SHAPE, level 3-4) +
// the RECTANGLE record. Only the inner paragraph varies with the user's text;
// the geometry records are GT-verbatim (so the default-text box is byte-
// identical to Hancom's). Default size ~53×24mm, floating. Section0-only.
const TB_PREFIX_HEX = '4704e003206f736700406a14b42d00002c4c0000983a00005e1a0000000000000000000000000000537a9b42000000000800acc001ac15d6200085c7c8b2e4b22e004c08c00f6365722463657224000000000000000000000100983a00005e1a0000983a00005e1a000000000b01000000000000000000000100000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f0000000000000000000000000000f03f000000000000000000000000000000000000000000000000000000000000f03f00000000000000000000000021000000410000c00001000000ffffff0000000000ffffffff000000000000000000b2b2b2000000000000000000547a9b020000480c100201000000200000001b011b011b011b01ffffffff00000000000000000000000000';
const TB_INNER_PARAHEADER_HEX = '420c80010a0000800000000000000000010000000000000000000000'; // char_count field rewritten per text
const TB_INNER_CHARSHAPE_HEX = '441080000000000000000000';
const TB_RECTANGLE_HEX = '4f0c1002000000000000000000983a000000000000983a00005e1a0000000000005e1a0000';

// Build the text box's gso cluster for the given inner text.
function buildTextboxCluster(text) {
  const prefix = Buffer.from(TB_PREFIX_HEX, 'hex');
  // inner PARA_HEADER with char_count = text chars + 1 (the trailing 0x000d),
  // high bit preserved (HWP sets it on the last paragraph of a list).
  const ph = Buffer.from(TB_INNER_PARAHEADER_HEX, 'hex');
  ph.writeUInt32LE((0x80000000 | (text.length + 1)) >>> 0, 4); // data starts at offset 4
  // inner PARA_TEXT = text (UTF-16) + 0x000d paragraph terminator.
  const txt = Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.from('0d00', 'hex')]);
  const ptRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 4, txt.length), txt]);
  return Buffer.concat([prefix, ph, ptRec, Buffer.from(TB_INNER_CHARSHAPE_HEX, 'hex'), Buffer.from(TB_RECTANGLE_HEX, 'hex')]);
}

// Insert a text box. Each op: { anchor?: string, text: string }
export async function insertTextboxInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  const summary = [];
  for (const op of ops) {
    const text = (typeof op.text === 'string') ? op.text : '';
    const records = parseRecords(raw);
    const clusters = findClusterBoundaries(records);
    let cluster = null, ptRec = null;
    if (op.anchor && typeof op.anchor === 'string') {
      const anchorBuf = Buffer.from(op.anchor, 'utf16le');
      for (const c of clusters) {
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT && r.level === 1 && raw.slice(r.dataOff, r.dataOff + r.size).indexOf(anchorBuf) !== -1) { cluster = c; ptRec = r; break; }
        }
        if (ptRec) break;
      }
    }
    if (!ptRec) {
      for (const c of clusters) {
        for (let i = c.startIdx + 1; i < c.endIdx; i++) {
          const r = records[i];
          if (r.tag === TAG_PARA_TEXT && r.level === 1) { cluster = c; ptRec = r; break; }
        }
        if (ptRec) break;
      }
    }
    if (!ptRec) throw new Error('insert_textbox: no top-level body paragraph found to anchor the text box');

    const paraHeaderRec = records[cluster.startIdx];

    // 1) Inline gso char (0x000b "gso ") before the paragraph's EOP.
    const gsoChar = Buffer.from('0b00206f736700000000000000000b00', 'hex');
    const oldBody = raw.slice(ptRec.dataOff, ptRec.dataOff + ptRec.size);
    const insAt = oldBody.length >= 2 ? oldBody.length - 2 : oldBody.length;
    const newBody = Buffer.concat([oldBody.slice(0, insAt), gsoChar, oldBody.slice(insAt)]);
    const newPtRec = Buffer.concat([buildRecordHeader(TAG_PARA_TEXT, 1, newBody.length), newBody]);

    // 2) text box gso cluster.
    const cluster2 = buildTextboxCluster(text);
    // Placement: inline (글자처럼) by default, or wrap=topbottom/square/behind/front.
    applyGsoPlacement(cluster2, op, resolveWrapMode(op));
    applyGsoSize(cluster2, resolveAspectSize(op, gsoCtrlRatio(cluster2))); // size, aspect-preserved
    const clusterEndOff = cluster.endIdx < records.length ? records[cluster.endIdx].headOff : raw.length;

    // 3) PARA_HEADER patch: char_count += 8, control_mask |= 0x800.
    const phOff = paraHeaderRec.dataOff;
    const curCount = raw.readUInt32LE(phOff);
    const flag = curCount & 0x80000000;
    raw.writeUInt32LE(((flag | ((curCount & 0x7FFFFFFF) + 8)) >>> 0), phOff);
    raw.writeUInt32LE((raw.readUInt32LE(phOff + 4) | 0x800) >>> 0, phOff + 4);

    raw = Buffer.concat([raw.slice(0, clusterEndOff), cluster2, raw.slice(clusterEndOff)]);
    raw = Buffer.concat([raw.slice(0, ptRec.headOff), newPtRec, raw.slice(ptRec.dataOff + ptRec.size)]);

    summary.push({ section: 0, anchor: op.anchor ?? null, text });
  }

  // Deflate + write back.
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext = deflateMiniChainWithExpansion({ buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] }, raw, chain);
    buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart; newCompressed = ext.compressed;
    if (ext.promoted) { chain = ext.newRegularChain; writeChainBytes(buf, chain, ssz, newCompressed); buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74); }
    else { rootChain = ext.rootChain; chain = ext.miniChain; writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed); }
  } else {
    const ext = deflateAndFitWithExpansion(raw, chain.length * ssz, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext.buf; fat = ext.fat; chain = ext.chain; newCompressed = ext.compressed; writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.inserted_count = summary.length;
  return result;
}


// ── Phase 6: append_image raw-patch ──────────────────────────────────────
//
// Step 1: add a new BinData/BIN000N.<ext> CFB stream containing the user's
// image bytes. No DocInfo or section changes yet — purely add the stream so
// we can verify Hancom Docs still opens the file with an orphan binary
// stream present. Steps 2/3 (DocInfo BinDataDef + body image control) will
// build on top.
//
// CFB add-stream flow:
//   1. Allocate a fresh mini-FAT chain for the image bytes (image < 4096
//      bytes for v1 — most embedded icons / 1x1 png / small bitmaps fit).
//      Larger images need regular FAT allocation; deferred.
//   2. Pick an unused directory slot (type=0). the typical pre-allocated count is around 3; if none we'd
//      need to expand the directory chain (deferred).
//   3. Write the new entry: name = "BIN000<N>.<ext>" UTF-16LE, type=2
//      (stream), color=0 (red), L/R/C=-1, start=miniChain[0],
//      size=imageBuffer.length.
//   4. Insert into BinData parent's child tree via simple BST insert
//      (no red-black rebalancing — testing whether Hancom tolerates that).

const MSSZ_DEFAULT_IMG = 64;

function pickFreeBinDataName(entries, ext) {
  const used = new Set();
  for (const e of entries) {
    if (e.type !== 2) continue;
    const m = e.name.match(/^BIN(\d{4})\./i);
    if (m) used.add(parseInt(m[1], 10));
  }
  for (let i = 1; i < 10000; i++) {
    if (!used.has(i)) return `BIN${String(i).padStart(4, '0')}.${ext}`;
  }
  throw new Error('append_image: no free BIN000N slot');
}

function findUnusedDirSlot(entries) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === 0) return i;
  }
  return -1;
}

// Ensure the directory has at least one unused (type 0) entry slot. CFB stores
// directory entries in a chain of sectors (ssz/128 entries each); when every slot
// is taken, append a fresh zeroed sector to the chain so the next stream has a
// home. Without this, a doc whose directory sector is exactly full (common after
// a few streams) rejects a SECOND image/chart ("no free directory slot"). Returns
// the (possibly reallocated) { buf, fat }. Caller must re-read the directory.
function ensureDirSlot(buf, ssz, fat, fatAddrs, dirStart) {
  const slotsPerSector = ssz >>> 7;
  const dirChain = walkChain(fat, dirStart);
  for (const s of dirChain) {
    const base = (s + 1) * ssz;
    for (let i = 0; i < slotsPerSector; i++) {
      if (buf.readUInt8(base + i * 128 + 0x42) === 0) return { buf, fat }; // a free slot exists
    }
  }
  // No free slot — append a new directory sector and link it to the chain's tail.
  const exp = expandFatCapacity(buf, ssz, fat, fatAddrs, (buf.length / ssz) + 1);
  buf = exp.buf; fat = exp.fat;
  const a = appendBlankSector(buf, ssz); buf = a.buf;
  const newSec = a.newSecIdx;
  writeFatEntry(buf, ssz, fatAddrs, newSec, ENDOFCHAIN); fat[newSec] = ENDOFCHAIN;
  const last = dirChain[dirChain.length - 1];
  writeFatEntry(buf, ssz, fatAddrs, last, newSec); fat[last] = newSec;
  const base = (newSec + 1) * ssz; // init 4 unused entries (type 0, siblings/child = NOSTREAM)
  for (let i = 0; i < slotsPerSector; i++) {
    const o = base + i * 128;
    buf.writeInt32LE(FREESECT, o + 0x44);
    buf.writeInt32LE(FREESECT, o + 0x48);
    buf.writeInt32LE(FREESECT, o + 0x4C);
  }
  return { buf, fat };
}

function cfbNameCompare(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  const au = a.toUpperCase();
  const bu = b.toUpperCase();
  return au < bu ? -1 : au > bu ? 1 : 0;
}

function allocMiniChain(ctx, byteCount) {
  let { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry } = ctx;
  const sectorsNeeded = Math.max(1, Math.ceil(byteCount / mssz));
  const chain = [];
  for (let n = 0; n < sectorsNeeded; n++) {
    let slot = -1;
    for (let m = 0; m < minifat.length; m++) {
      if (minifat[m] === FREESECT && !chain.includes(m)) { slot = m; break; }
    }
    if (slot === -1) slot = minifat.length + n;
    const mfExp = expandMinifatCapacity(buf, ssz, fat, fatAddrs, minifat, minifatStart, slot + 1);
    buf = mfExp.buf; fat = mfExp.fat; minifat = mfExp.minifat; minifatStart = mfExp.minifatStart;
    const rcExp = ensureRootChainForMiniSectors(buf, ssz, mssz, fat, fatAddrs, rootChain, slot + 1);
    buf = rcExp.buf; fat = rcExp.fat; rootChain = rcExp.rootChain;
    chain.push(slot);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, chain[i], chain[i + 1]);
    minifat[chain[i]] = chain[i + 1];
  }
  writeMinifatEntry(buf, ssz, mssz, fat, minifatStart, chain[chain.length - 1], ENDOFCHAIN);
  minifat[chain[chain.length - 1]] = ENDOFCHAIN;
  const highest = Math.max(...chain);
  const minRootBytes = (highest + 1) * mssz;
  const oldRootSize = buf.readUInt32LE(rootEntry.entryFileOffset + 0x78);
  if (minRootBytes > oldRootSize) {
    buf.writeUInt32LE(minRootBytes, rootEntry.entryFileOffset + 0x78);
    buf.writeUInt32LE(0, rootEntry.entryFileOffset + 0x7C);
  }
  return { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry, chain };
}

// Allocate a fresh regular-FAT chain large enough for `byteLen` bytes (for a
// new stream stored in the regular FAT, e.g. a chart OLE > 4096 bytes).
function allocRegularChain(buf, ssz, fat, fatAddrs, byteLen) {
  const totalSectors = Math.max(1, Math.ceil(byteLen / ssz));
  // First sector: ensure FAT capacity, append a blank sector, mark ENDOFCHAIN.
  let exp = expandFatCapacity(buf, ssz, fat, fatAddrs, (buf.length / ssz) + 1);
  buf = exp.buf; fat = exp.fat;
  let alloc = appendBlankSector(buf, ssz); buf = alloc.buf;
  const first = alloc.newSecIdx;
  writeFatEntry(buf, ssz, fatAddrs, first, ENDOFCHAIN); fat[first] = ENDOFCHAIN;
  let chain = [first];
  if (totalSectors > 1) {
    const e = extendFatChain(buf, ssz, fat, fatAddrs, chain, totalSectors - 1);
    buf = e.buf; fat = e.fat; chain = e.chain;
  }
  return { buf, fat, chain };
}

function insertEntryIntoTree(buf, entries, parentIdx, newIdx) {
  const parent = entries[parentIdx];
  const newName = entries[newIdx].name;
  if (parent.child < 0) {
    buf.writeInt32LE(newIdx, parent.entryFileOffset + 0x4C);
    parent.child = newIdx;
    return;
  }
  let curIdx = parent.child;
  while (true) {
    const cur = entries[curIdx];
    const cmp = cfbNameCompare(newName, cur.name);
    if (cmp < 0) {
      if (cur.leftSibling < 0) {
        buf.writeInt32LE(newIdx, cur.entryFileOffset + 0x44);
        cur.leftSibling = newIdx;
        return;
      }
      curIdx = cur.leftSibling;
    } else if (cmp > 0) {
      if (cur.rightSibling < 0) {
        buf.writeInt32LE(newIdx, cur.entryFileOffset + 0x48);
        cur.rightSibling = newIdx;
        return;
      }
      curIdx = cur.rightSibling;
    } else {
      throw new Error(`insertEntryIntoTree: duplicate name "${newName}"`);
    }
  }
}

// Collect every node in a storage's child tree — the left/right-sibling BST rooted at
// `rootSlot`. Does NOT descend into nodes' own `child` subtrees, so it returns only the
// direct children of one storage (e.g. all of Root Entry's top-level entries).
function collectTreeNodes(entries, rootSlot) {
  const out = [];
  if (rootSlot == null || rootSlot < 0) return out;
  const stack = [rootSlot];
  const seen = new Set();
  while (stack.length) {
    const i = stack.pop();
    if (i < 0 || i >= entries.length || seen.has(i)) continue;
    seen.add(i);
    out.push(i);
    if (entries[i].leftSibling >= 0) stack.push(entries[i].leftSibling);
    if (entries[i].rightSibling >= 0) stack.push(entries[i].rightSibling);
  }
  return out;
}

// Rebuild a storage's child tree from scratch over `kids` (slot indices): clear the
// parent's child pointer and each kid's SIBLING links (left/right) — never a kid's own
// `child`, so folders keep their subtrees — then re-insert each via the same simple-BST
// insert used on creation. Lets us remove an entry from a tree by collecting the
// survivors and rebuilding, without implementing general BST node deletion.
function rebuildChildTree(buf, entries, parentIdx, kids) {
  buf.writeInt32LE(-1, entries[parentIdx].entryFileOffset + 0x4C);
  entries[parentIdx].child = -1;
  for (const idx of kids) {
    const off = entries[idx].entryFileOffset;
    buf.writeInt32LE(-1, off + 0x44); entries[idx].leftSibling = -1;
    buf.writeInt32LE(-1, off + 0x48); entries[idx].rightSibling = -1;
  }
  for (const idx of kids) insertEntryIntoTree(buf, entries, parentIdx, idx);
}

function writeDirEntry(buf, entry, name, type, startSector, byteSize, color = 0) {
  const off = entry.entryFileOffset;
  buf.fill(0, off, off + 128);
  const nameBytes = Buffer.from(name + '\0', 'utf16le');
  if (nameBytes.length > 64) throw new Error(`writeDirEntry: name too long (${nameBytes.length})`);
  nameBytes.copy(buf, off);
  buf.writeUInt16LE(nameBytes.length, off + 0x40);
  buf.writeUInt8(type, off + 0x42);
  buf.writeUInt8(color, off + 0x43);
  buf.writeInt32LE(-1, off + 0x44);
  buf.writeInt32LE(-1, off + 0x48);
  buf.writeInt32LE(-1, off + 0x4C);
  buf.writeInt32LE(startSector, off + 0x74);
  buf.writeUInt32LE(byteSize >>> 0, off + 0x78);
  buf.writeUInt32LE(0, off + 0x7C);
  entry.name = name;
  entry.type = type;
  entry.leftSibling = -1;
  entry.rightSibling = -1;
  entry.child = -1;
  entry.start = startSector;
  entry.size = byteSize;
}

export async function appendImageInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', appended_count: 0 });
  }
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  if (!mssz) mssz = MSSZ_DEFAULT_IMG;
  let fat = readFat(buf, fatAddrs, ssz);
  let dir = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = walkChain(fat, dir.entries[0].start);

  const binDataIdx = dir.entries.findIndex((e) => e.type === 1 && e.name === 'BinData');
  if (binDataIdx < 0) {
    throw new Error('append_image: BinData storage not found — Step 1 needs the form to already have a BinData folder');
  }

  const summary = [];
  for (const op of ops) {
    if (!op.path) throw new Error('append_image: op.path is required');
    const imgBuf = readFileSync(op.path);
    const ext = (op.path.split('.').pop() || 'png').toLowerCase();
    if (imgBuf.length >= 4096) {
      throw new Error(`append_image: image > 4096 bytes (${imgBuf.length}) — Step 1 supports mini-stream images only`);
    }
    dir = readDirectory(buf, fat, ssz, dirStart);
    rootChain = walkChain(fat, dir.entries[0].start);
    const newName = pickFreeBinDataName(dir.entries, ext);
    const slotIdx = findUnusedDirSlot(dir.entries);
    if (slotIdx < 0) throw new Error('append_image: no unused directory slot');

    // BinData stream: deflate the raw image bytes so the stored form
    // matches what rhwp's exportHwp produces (attr=Default + deflated
    // payload). Empirically Hancom Docs renders images only when the
    // stream content + DocInfo attr are consistent; raw bytes with
    // attr=NoCompress reach the doc but Hancom shows an empty frame.
    const storedBytes = deflateRawSync(imgBuf, { level: 9 });

    const alloc = allocMiniChain({
      buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain, rootEntry: dir.entries[0]
    }, storedBytes.length);
    buf = alloc.buf; fat = alloc.fat; minifat = alloc.minifat; minifatStart = alloc.minifatStart;
    rootChain = alloc.rootChain;
    writeMiniChainBytes(buf, alloc.chain, rootChain, ssz, mssz, storedBytes);

    dir = readDirectory(buf, fat, ssz, dirStart);
    const newEntry = dir.entries[slotIdx];
    writeDirEntry(buf, newEntry, newName, 2, alloc.chain[0], storedBytes.length, 0);
    insertEntryIntoTree(buf, dir.entries, binDataIdx, slotIdx);

    // storage_id = the numeric part of "BIN000N" (1-based per CFB convention).
    const storageId = parseInt(newName.match(/BIN(\d{4})\./)[1], 10);
    summary.push({ added: `BinData/${newName}`, size: storedBytes.length, rawImageSize: imgBuf.length, slot: slotIdx, storage_id: storageId, ext, miniChain: alloc.chain });
  }

  // Step 1 writes CFB stream — flush before Step 2 re-opens the file.
  writeFileSync(filePath, buf);

  // ── Step 2: register each new stream in DocInfo (HWPTAG_BIN_DATA + bump
  // ID_MAPPINGS bin_data_count). Re-opens the file fresh so the CFB
  // mutations from Step 1 are visible.
  for (const item of summary) {
    const docInfoResult = await addBinDataDefToDocInfo(filePath, item.storage_id, item.ext);
    item.docInfo = docInfoResult;
  }

  // ── Step 3: emit body image control (CTRL_HEADER 'gso ' + SHAPE_COMPONENT
  // + CTRL_DATA + SHAPE_COMPONENT_PICTURE + inline ctrl char) so the new
  // BinData isn't orphaned. Template-clone source comes from item._templateBytes
  // (caller passes the bytes of a fresh `rhwp exportHwp` of the same image
  // — clean cluster with no nested footer/table baggage) when present;
  // otherwise we fall back to cloning from filePath itself (only works
  // if the user's file already contains an image cluster).
  for (let i = 0; i < summary.length; i++) {
    const item = summary[i];
    // Image height in HWPUNIT — let the donor-extracted PARA_LINE_SEG
    // know how much vertical space to reserve. Falls back to ~5cm if
    // op.height_cm isn't set.
    const heightCm = (ops[i] && ops[i].height_cm) || 5;
    const imageHeightHwp = Math.round(heightCm * 2835);
    const opTemplate = ops[i] && ops[i]._templateBytes;
    const bodyResult = await appendImageBodyControl(filePath, item.storage_id, imageHeightHwp, opTemplate);
    item.bodyControl = bodyResult;
  }

  const result = Object.assign([], summary);
  result.mode = 'in-place';
  result.appended_count = summary.length;
  return result;
}

// ── Phase 6 Step 2 — DocInfo BinDataDef record ────────────────────────────
//
// After Step 1 creates the BinData/BIN000N.<ext> CFB stream, Step 2
// registers that stream in DocInfo so it has an ID the body section can
// reference. Two mutations inside DocInfo:
//
//   1. ID_MAPPINGS record (tag 0x11, body offset 0..3) — bump bin_data_count
//      by 1. The body holds u32 counts for each ID-mapped resource type
//      starting with BinData at offset 0.
//   2. HWPTAG_BIN_DATA record (tag 0x12) — insert a new one after the last
//      existing HWPTAG_BIN_DATA. Body: attr u16 + storage_id u16 + extension
//      hwp_string (u16 char_count + UTF-16LE chars).
//
// attr bits per rhwp parser:
//   bits 0..3 = data_type (0=Link, 1=Embedding, 2=Storage)
//   bits 4..5 = compression (0=Default, 1=Compress, 2=NoCompress)
//   bits 8..9 = status (0=NotAccessed, 1=Success, 2=Error, 3=Ignored)
// We use Embedding + Default + NotAccessed → attr = 0x0001.

const TAG_ID_MAPPINGS = 0x11;
const TAG_BIN_DATA_DEF = 0x12;

// attr bits per rhwp parser:
//   bits 0..3 = data_type (1=Embedding)
//   bits 4..5 = compression (0=Default, 1=Compress, 2=NoCompress)
//   bits 8..9 = status (0=NotAccessed, 1=Success)
// Already-compressed image formats (jpg/png/gif) use NoCompress so Hancom
// doesn't try to deflate them again on load. BMP / raw bitmaps use Default.
// Matches the byte pattern Hancom Office writes for these stream types: jpg → 0x21, bmp → 0x01.
const COMPRESSED_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function buildBinDataDefBody(storageId, ext, attrOverride) {
  let attr;
  if (typeof attrOverride === 'number') {
    attr = attrOverride;
  } else {
    // data_type = 1 (Embedding), compression = 0 (Default — Hancom
    // deflates the stored bytes on load). status = 1 (Success — image
    // accessed at least once). Matches rhwp exportHwp's output:
    // attr=0x0101 for PNG/JPG/etc. The BinData stream itself is
    // deflated raw bytes; together attr=Default + deflated payload is
    // the one combination Hancom Docs consistently accepts.
    attr = (1 << 8) | (0 << 4) | 0x01;
  }
  const extChars = ext;
  const extBytes = Buffer.from(extChars, 'utf16le');
  const body = Buffer.alloc(2 + 2 + 2 + extBytes.length);
  body.writeUInt16LE(attr, 0);
  body.writeUInt16LE(storageId, 2);
  body.writeUInt16LE(extChars.length, 4);
  extBytes.copy(body, 6);
  return body;
}

function buildRecordHeader(tag, level, size) {
  // Standard 4-byte header: tag(10) + level(10) + size(12)
  // If size >= 0xFFF, use extended (4-byte header + 4-byte size); for our
  // 12-byte BinData body we always fit in standard.
  if (size >= 0xFFF) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(((0xFFF << 20) | (level << 10) | tag) >>> 0, 0);
    head.writeUInt32LE(size, 4);
    return head;
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((size << 20) | (level << 10) | tag) >>> 0, 0);
  return head;
}

// Walk DocInfo records, return [{tag, level, size, headOff, dataOff, ext}].
// (Same shape as parseRecords for body sections, just on DocInfo bytes.)
function parseDocInfoRecords(raw) {
  return parseRecords(raw); // identical record format
}

async function addBinDataDefToDocInfo(filePath, storageId, ext, attrOverride) {
  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const dirEntry = findStreamEntry(entries, ['DocInfo']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));

  // Find ID_MAPPINGS record and bump bin_data_count.
  const records = parseDocInfoRecords(raw);
  const idMap = records.find((r) => r.tag === TAG_ID_MAPPINGS);
  if (!idMap) throw new Error('addBinDataDefToDocInfo: HWPTAG_ID_MAPPINGS record not found in DocInfo');
  if (idMap.size < 4) throw new Error(`addBinDataDefToDocInfo: ID_MAPPINGS body too small (${idMap.size})`);
  const oldCount = raw.readUInt32LE(idMap.dataOff);
  raw.writeUInt32LE(oldCount + 1, idMap.dataOff);

  // Build new HWPTAG_BIN_DATA record.
  const body = buildBinDataDefBody(storageId, ext, attrOverride);
  const header = buildRecordHeader(TAG_BIN_DATA_DEF, 1, body.length);
  const newRec = Buffer.concat([header, body]);

  // Insert position: right after the last existing HWPTAG_BIN_DATA record
  // (so all BinData defs stay grouped). If there are no existing ones,
  // insert right after ID_MAPPINGS.
  let insertAfterEnd = idMap.dataOff + idMap.size;
  for (const r of records) {
    if (r.tag !== TAG_BIN_DATA_DEF) continue;
    const end = r.dataOff + r.size;
    if (end > insertAfterEnd) insertAfterEnd = end;
  }
  raw = Buffer.concat([raw.slice(0, insertAfterEnd), newRec, raw.slice(insertAfterEnd)]);

  // Deflate + write back (same pipeline as other in-place edits).
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext2 = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext2.buf; fat = ext2.fat; minifat = ext2.minifat; minifatStart = ext2.minifatStart;
    newCompressed = ext2.compressed;
    if (ext2.promoted) {
      chain = ext2.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext2.rootChain;
      chain = ext2.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext2 = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext2.buf; fat = ext2.fat; chain = ext2.chain;
    newCompressed = ext2.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);

  writeFileSync(filePath, buf);
  return { binDataCountBefore: oldCount, binDataCountAfter: oldCount + 1, storageId, ext };
}

// ── Phase 6 Step 3 — body image control via template clone ──────────────
//
// Last-ditch attempt: clone an entire image-bearing paragraph cluster from
// a reference form (h22-style: paragraph #6 with control_mask 0x10800 +
// nested 'gso' CTRL_HEADER + SHAPE_COMPONENT $pic + CTRL_DATA). Strip the
// last-paragraph MSB on the top-level PARA_HEADER and rewrite every u16
// instance of the template's bin_data_id with our new storage_id. Insert
// after the last simple body paragraph.
//
// LIMITATIONS:
//   - The template cluster carries footer + image + other nested content,
//     not just an image. The result will have those artifacts appear at
//     the insertion point too.
//   - bin_data_id u16 search is heuristic; we rewrite all matches inside
//     SHAPE_COMPONENT bodies. If the template's bin_data_id happens to
//     also appear as some other unrelated u16 inside the body, that gets
//     rewritten too — could break image positioning.
//   - Cluster requires a reference form with the exact h22 pattern.

function findImageTemplateCluster(records, raw, templateBinDataId) {
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag !== TAG_PARA_HEADER || records[i].level !== 0) continue;
    let end = records.length;
    for (let j = i + 1; j < records.length; j++) {
      if (records[j].tag === TAG_PARA_HEADER && records[j].level === 0) { end = j; break; }
    }
    // Look for CTRL_HEADER 'gso ' (id 0x206f7367) inside this cluster.
    for (let j = i + 1; j < end; j++) {
      const r = records[j];
      if (r.tag !== TAG_CTRL_HEADER || r.size < 4) continue;
      const id = raw.readUInt32LE(r.dataOff);
      // 'gso ' (g s o space) → readUInt32LE = 0x67736f20
      if (id !== 0x67736f20) continue;
      return { paraStartIdx: i, clusterEndIdx: end };
    }
  }
  return null;
}

// Clone cluster + rewrite bin_data_id u16 instances in SHAPE_COMPONENT bodies.
// Uses records' absolute file offsets directly (delta to cluster start) so we
// don't depend on a cumulative offset walk that can drift.
function cloneImageClusterBytes(records, raw, startIdx, endIdx, oldBinDataId, newBinDataId, anchorParaShape, anchorCharShape) {
  const startOff = records[startIdx].headOff;
  const endOff = endIdx < records.length ? records[endIdx].headOff : raw.length;
  const out = Buffer.from(raw.slice(startOff, endOff));
  // Clear paragraph_flag MSB on EVERY PARA_HEADER in the cluster (top-level
  // and nested cell paragraphs at lvl 2/3). h22's image-bearing paragraph
  // #6 happens to be the section's last paragraph, so all its PARA_HEADERs
  // (including cells inside the footer) have MSB=1. Cloning verbatim would
  // leave multiple "I'm the last paragraph" flags in the section — Hancom
  // Docs's strict validator rejects that.
  // Also clear the footer bit (0x10000) on the top-level PARA_HEADER so
  // the cloned paragraph doesn't claim to be a footer container at the new
  // body position. Keep the table bit (0x800) for the inline ctrl char →
  // CTRL_HEADER linkage.
  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    if (r.tag !== TAG_PARA_HEADER || r.size < 4) continue;
    const bodyStart = r.dataOff - startOff;
    const oldWord = out.readUInt32LE(bodyStart);
    out.writeUInt32LE((oldWord & 0x7FFFFFFF) >>> 0, bodyStart);
    if (i === startIdx && r.size >= 8) {
      // Top-level only: clear footer bit in control_mask
      const oldCm = out.readUInt32LE(bodyStart + 4);
      out.writeUInt32LE((oldCm & ~0x10000) >>> 0, bodyStart + 4);
      // paraShape / styleId ID rewrite (PARA_HEADER body offset 8..11):
      //   offset 8..9   paraShape u16
      //   offset 10     styleId u8
      //   offset 11     break_val u8
      // The cluster's paraShape is the fresh-template's #0 which doesn't
      // exist in the user's DocInfo (different table) (different table). Point the
      // cluster at the anchor paragraph's paraShape so the rendering
      // engine resolves it correctly.
      if (typeof anchorParaShape === 'number' && r.size >= 10) {
        out.writeUInt16LE(anchorParaShape & 0xFFFF, bodyStart + 8);
      }
    }
  }
  // PARA_CHAR_SHAPE (tag 0x44) — first entry's charShape u32 at body offset 4.
  // Same reasoning as paraShape: fresh-template's charShape #0 isn't the
  // same character role as the donor file's first numbering entry (different DocInfo tables). Point the
  // top-level paragraph's first char_shape entry at the anchor's charShape.
  if (typeof anchorCharShape === 'number') {
    for (let i = startIdx; i < endIdx; i++) {
      const r = records[i];
      if (r.tag !== TAG_PARA_CHAR_SHAPE || r.level !== 1 || r.size < 8) continue;
      const bodyStart = r.dataOff - startOff;
      out.writeUInt32LE(anchorCharShape >>> 0, bodyStart + 4);
      break; // top-level paragraph's char_shape only — nested cell char_shapes left alone
    }
  }
  // Walk records inside the cluster; for each SHAPE_COMPONENT (0x4c), use
  // its absolute dataOff to compute its position inside the cloned buffer.
  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    if (r.tag !== 0x4c) continue;
    const bodyStart = r.dataOff - startOff; // position within `out`
    // Scan body for u16 instances of oldBinDataId. Use byte-level loop
    // so we catch unaligned matches too (rhwp's binary layout isn't
    // always 16-bit aligned within the body).
    for (let p = 0; p < r.size - 1; p++) {
      if (out.readUInt16LE(bodyStart + p) === oldBinDataId) {
        out.writeUInt16LE(newBinDataId, bodyStart + p);
      }
    }
  }
  // Rewrite CTRL_HEADER (tag 0x47) instance_ids so they don't collide with
  // the template's existing controls. CommonObjAttr layout per rhwp:
  //   body[0..3]   ctrl_id
  //   body[4..7]   attr
  //   body[8..23]  vert/horz/width/height (4 × u32)
  //   body[24..27] z_order
  //   body[28..35] margin (4 × i16)
  //   body[36..39] instance_id  ← rewrite this
  // We use a timestamp-derived base + per-record bump for uniqueness.
  const idBase = (Date.now() & 0x7FFFFFFF) >>> 0;
  let idBump = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const r = records[i];
    if (r.tag !== TAG_CTRL_HEADER || r.size < 40) continue;
    const bodyStart = r.dataOff - startOff;
    out.writeUInt32LE((idBase + idBump) >>> 0, bodyStart + 36);
    idBump++;
  }
  return out;
}

// Synthesize a simple image-only paragraph cluster from "donor" image
// records the caller has already extracted from somewhere. Two-step shape:
//
//   PARA_HEADER lvl 0 (control_mask=0x800, paraShape from caller)
//     PARA_TEXT lvl 1 — single 16-byte inline extended ctrl char (gso ref)
//                       + EOP. 9 chars total.
//     PARA_CHAR_SHAPE lvl 1 — single entry (charPos=0, charShape from caller)
//     PARA_LINE_SEG lvl 1 — single entry with vertSize = image height
//     CTRL_HEADER lvl 1 — donor's gso CommonObjAttr (level-shifted from 3→1)
//     SHAPE_COMPONENT lvl 2 — donor's $pic body (level-shifted from 4→2)
//     CTRL_DATA lvl 3 — donor's body (level-shifted from 5→3)
//
// The donor records come from the user's existing image (e.g. a nested
// paragraph #11 lvl-3-5 image). Cloning their bodies verbatim keeps every
// DocInfo reference (paraShape ref inside CommonObjAttr, BorderFill, etc)
// resolved against the same DocInfo. We only rewrite:
//   - PARA_HEADER body: char_count (9), control_mask (0x800), paraShape,
//     instance_id (fresh), line_segs_count (1)
//   - SHAPE_COMPONENT body: every u16 == oldBinDataId → newBinDataId
//   - CTRL_HEADER body: instance_id at offset 36 (fresh)
function buildImageOnlyParagraphCluster({
  donorCtrlHeaderBody,   // 'gso ' CommonObjAttr (46 bytes typically)
  donorShapeComponentBody, // $pic body (196 bytes typically)
  donorCtrlDataBody,     // CTRL_DATA body (91 bytes typically)
  donorParaCharShapeBody, // PARA_CHAR_SHAPE level-1 first 8 bytes (or undefined)
  donorParaLineSegBody,  // PARA_LINE_SEG level-1 first 36 bytes (or undefined)
  paraShape, charShape,
  oldBinDataId, newBinDataId,
  imageHeightHwp,
}) {
  // 1. PARA_HEADER body (22 bytes)
  const ph = Buffer.alloc(22);
  ph.writeUInt32LE(9 >>> 0, 0);                     // char_count=9, flag=0
  ph.writeUInt32LE(0x800 >>> 0, 4);                 // control_mask: image bit
  ph.writeUInt16LE(paraShape & 0xFFFF, 8);
  ph.writeUInt8(0, 10);                             // styleId
  ph.writeUInt8(0, 11);                             // break_val
  ph.writeUInt16LE(1, 12);                          // num_char_shapes
  ph.writeUInt16LE(0, 14);                          // range_tags_count
  ph.writeUInt16LE(1, 16);                          // line_segs_count
  ph.writeUInt32LE(0, 18);                           // instance_id (fresh template uses 0)
  // bytes 22..23 left as zeros (extra padding observed in Hancom-Office-saved files)
  // But canonical PARA_HEADER size in fresh template is 22 — keep 22.

  // 2. PARA_TEXT body (18 bytes): inline extended ctrl char (16) + EOP (2)
  const pt = Buffer.alloc(18);
  pt.writeUInt16LE(0x000b, 0);                      // start marker
  pt[2] = 0x20; pt[3] = 0x6f; pt[4] = 0x73; pt[5] = 0x67; // 'gso ' (LE order in memory)
  // bytes 6..13 reserved (zero) — ctrl_idx / position placeholder
  pt.writeUInt16LE(0x000b, 14);                     // end marker
  pt.writeUInt16LE(0x000d, 16);                     // EOP

  // 3. PARA_CHAR_SHAPE body (8 bytes): charPos=0, charShape
  const cs = Buffer.alloc(8);
  cs.writeUInt32LE(0, 0);                           // charPos=0
  cs.writeUInt32LE(charShape >>> 0, 4);             // charShape

  // 4. PARA_LINE_SEG body (36 bytes). Empirically the dispatch-based
  //    baseline (Hancom-Docs verified `fresh_image_100px.hwp` produced
  //    via setup_document + append_paragraph + append_image + ...)
  //    sets specific paragraph-layout fields that the bare
  //    insertText+insertPicture shortcut we use for the template
  //    doesn't reproduce. Hard-code the baseline's PARA_LINE_SEG body
  //    so the image paragraph reproduces verified layout exactly.
  //    A4 portrait, 25mm margin baseline values:
  //      textStart=0  vertPos=0x0514  vertSize=0x0384  textHeight=0x0384
  //      baseLineGap=0x02fd  lineSpaceGap=0x010e  segWidth=0
  //      segXPos=0xb12c  flag=0x00000600
  const ls = Buffer.from('00000000140500008403000084030000fd0200000e010000000000002cb1000000000600', 'hex');

  // 5. CTRL_HEADER body — donor verbatim (instance_id stays 0, matching
  //    fresh template behavior).
  const ch = Buffer.from(donorCtrlHeaderBody);

  // 6. SHAPE_COMPONENT body: keep donor verbatim. The u16 instances of
  //    "1" we used to rewrite at offsets 18/50 are NOT bin_data_id —
  //    they're image-pixel-size fields that happen to equal storage_id
  //    by coincidence for the template's image. Confirmed by Hop's
  //    output (storage_id=2 image still has u16=1 at SHAPE_COMPONENT
  //    18/50 and only CTRL_DATA[71] reflects the real bin_data_id).
  const sc = Buffer.from(donorShapeComponentBody);

  // 7. CTRL_DATA body: rewrite bin_data_id at offset 71 (u16).
  //    Verified against Hop's fresh_image_100px_v3.hwp where the new
  //    image's CTRL_DATA[71] = its actual storage_id.
  const cd = Buffer.from(donorCtrlDataBody);
  if (cd.length >= 73) {
    cd.writeUInt16LE(newBinDataId & 0xFFFF, 71);
  }

  // Assemble records with correct headers (tag, level, size)
  const records = [
    { tag: TAG_PARA_HEADER,     level: 0, body: ph },
    { tag: TAG_PARA_TEXT,       level: 1, body: pt },
    { tag: TAG_PARA_CHAR_SHAPE, level: 1, body: cs },
    { tag: TAG_PARA_LINE_SEG,   level: 1, body: ls },
    { tag: TAG_CTRL_HEADER,     level: 1, body: ch },     // gso, was lvl 3
    { tag: 0x4c,                level: 2, body: sc },     // SHAPE_COMPONENT, was lvl 4
    { tag: 0x55,                level: 3, body: cd },     // CTRL_DATA, was lvl 5
  ];

  const out = [];
  for (const r of records) {
    out.push(buildRecordHeader(r.tag, r.level, r.body.length));
    out.push(r.body);
  }
  return Buffer.concat(out);
}

// Extract donor image-record bodies from a CFB-formatted HWP file.
// Returns { ctrlHeaderBody, shapeComponentBody, ctrlDataBody, oldBinDataId,
//           paraCharShapeBody, paraLineSegBody, paraShape, charShape } from
// the first simple nested 'gso' (size==46 CTRL_HEADER ⇒ no caption, no extras).
function extractDonorImageRecords(donorBuf) {
  const hdr = parseCfbHeader(donorBuf);
  const fat = readFat(donorBuf, hdr.fatAddrs, hdr.ssz);
  const dir = readDirectory(donorBuf, fat, hdr.ssz, hdr.dirStart);
  const sec = findStreamEntry(dir.entries, ['BodyText', 'Section0']);
  let comp;
  if (sec.size < 4096) {
    const minifat = readMinifat(donorBuf, fat, hdr.ssz, hdr.minifatStart);
    const root = walkChain(fat, dir.entries[0].start);
    const chain = walkChain(minifat, sec.start);
    comp = readMiniChainBytes(donorBuf, chain, root, hdr.ssz, hdr.mssz, sec.size);
  } else {
    const chain = walkChain(fat, sec.start);
    comp = readChainBytes(donorBuf, chain, hdr.ssz, sec.size);
  }
  const raw = Buffer.from(inflateRawSync(comp));
  const records = parseRecords(raw);

  // Find first simple gso (CTRL_HEADER, ctrl_id 'gso ' LE = 0x67736f20,
  // size == 46 → CommonObjAttr only, no caption / extras).
  let gsoIdx = -1;
  for (let i = 0; i < records.length - 2; i++) {
    const r = records[i];
    if (r.tag !== TAG_CTRL_HEADER || r.size !== 46) continue;
    if (raw.readUInt32LE(r.dataOff) !== 0x67736f20) continue;
    // Confirm next two are SHAPE_COMPONENT (0x4c) + CTRL_DATA (0x55).
    if (records[i + 1].tag === 0x4c && records[i + 2].tag === 0x55) {
      gsoIdx = i;
      break;
    }
  }
  if (gsoIdx < 0) throw new Error('extractDonorImageRecords: no simple gso image cluster found in donor');

  const ctrlHeaderBody = raw.slice(records[gsoIdx].dataOff, records[gsoIdx].dataOff + records[gsoIdx].size);
  const shapeComponentBody = raw.slice(records[gsoIdx + 1].dataOff, records[gsoIdx + 1].dataOff + records[gsoIdx + 1].size);
  const ctrlDataBody = raw.slice(records[gsoIdx + 2].dataOff, records[gsoIdx + 2].dataOff + records[gsoIdx + 2].size);

  // bin_data_id from SHAPE_COMPONENT body offset 18 (or 50 — same value)
  const oldBinDataId = shapeComponentBody.readUInt16LE(18);

  // Find the paraShape and charShape of the paragraph that owns this gso.
  let paraShape, charShape, paraCharShapeBody, paraLineSegBody;
  // Walk backward to the enclosing PARA_HEADER level 0.
  for (let j = gsoIdx - 1; j >= 0; j--) {
    if (records[j].tag === TAG_PARA_HEADER && records[j].level === 0) {
      paraShape = raw.readUInt16LE(records[j].dataOff + 8);
      // First PARA_CHAR_SHAPE level 1 after this PARA_HEADER
      for (let k = j + 1; k < records.length; k++) {
        if (records[k].tag === TAG_PARA_HEADER && records[k].level === 0) break;
        if (records[k].tag === TAG_PARA_CHAR_SHAPE && records[k].level === 1) {
          charShape = raw.readUInt32LE(records[k].dataOff + 4);
          paraCharShapeBody = raw.slice(records[k].dataOff, records[k].dataOff + Math.min(records[k].size, 8));
        }
        if (records[k].tag === TAG_PARA_LINE_SEG && records[k].level === 1) {
          paraLineSegBody = raw.slice(records[k].dataOff, records[k].dataOff + Math.min(records[k].size, 36));
        }
        if (paraCharShapeBody && paraLineSegBody) break;
      }
      break;
    }
  }
  return { ctrlHeaderBody, shapeComponentBody, ctrlDataBody, oldBinDataId, paraShape, charShape, paraCharShapeBody, paraLineSegBody };
}

async function appendImageBodyControl(filePath, newBinDataId, imageHeightHwp, templateOverride) {
  // Hybrid path. Two donors:
  //   - filePath donor (user file's own image cluster) → provides paraShape,
  //     charShape that exist in user's DocInfo
  //   - templateOverride donor (fresh rhwp insertPicture output) → provides
  //     clean CTRL_HEADER body with correct image size, clean CTRL_DATA,
  //     SHAPE_COMPONENT body with correct image attrs
  // Falls back to filePath-only if no template.
  const donorBuf = readFileSync(filePath);
  const fileDonor = extractDonorImageRecords(donorBuf);
  const tmplDonor = Buffer.isBuffer(templateOverride)
    ? extractDonorImageRecords(templateOverride)
    : null;
  const donor = tmplDonor ? {
    // body parts from fresh template (clean image-size attrs)
    ctrlHeaderBody: tmplDonor.ctrlHeaderBody,
    shapeComponentBody: tmplDonor.shapeComponentBody,
    ctrlDataBody: tmplDonor.ctrlDataBody,
    paraLineSegBody: tmplDonor.paraLineSegBody,
    oldBinDataId: tmplDonor.oldBinDataId,
    // shape IDs from user file (so DocInfo refs resolve in the target)
    paraShape: fileDonor.paraShape,
    charShape: fileDonor.charShape,
    paraCharShapeBody: fileDonor.paraCharShapeBody,
  } : fileDonor;

  // Load target's Section0
  let buf = donorBuf; // already loaded
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };
  const dirEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const inMiniStream = dirEntry.size < 4096;
  let chain, compressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    chain = walkChain(minifat, dirEntry.start);
    compressed = readMiniChainBytes(buf, chain, rc, ssz, mssz, dirEntry.size);
  } else {
    chain = walkChain(fat, dirEntry.start);
    compressed = readChainBytes(buf, chain, ssz, dirEntry.size);
  }
  let raw = Buffer.from(inflateRawSync(compressed));
  const records = parseRecords(raw);
  const anchor = findLastSimpleBodyParagraph(records);

  // Synthesize cluster
  const cluster = buildImageOnlyParagraphCluster({
    donorCtrlHeaderBody: donor.ctrlHeaderBody,
    donorShapeComponentBody: donor.shapeComponentBody,
    donorCtrlDataBody: donor.ctrlDataBody,
    donorParaCharShapeBody: donor.paraCharShapeBody,
    donorParaLineSegBody: donor.paraLineSegBody,
    paraShape: donor.paraShape,
    charShape: donor.charShape,
    oldBinDataId: donor.oldBinDataId,
    newBinDataId,
    imageHeightHwp,
  });

  const insertAt = anchor.endIdx < records.length ? records[anchor.endIdx].headOff : raw.length;
  raw = Buffer.concat([raw.slice(0, insertAt), cluster, raw.slice(insertAt)]);

  // Deflate + write
  let newCompressed;
  if (inMiniStream) {
    const rc = ensureRootChain();
    const ext2 = deflateMiniChainWithExpansion(
      { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: rc, rootEntry: entries[0] },
      raw, chain
    );
    buf = ext2.buf; fat = ext2.fat; minifat = ext2.minifat; minifatStart = ext2.minifatStart;
    newCompressed = ext2.compressed;
    if (ext2.promoted) {
      chain = ext2.newRegularChain;
      writeChainBytes(buf, chain, ssz, newCompressed);
      buf.writeInt32LE(chain[0], dirEntry.entryFileOffset + 0x74);
    } else {
      rootChain = ext2.rootChain;
      chain = ext2.miniChain;
      writeMiniChainBytes(buf, chain, rootChain, ssz, mssz, newCompressed);
    }
  } else {
    const capacity = chain.length * ssz;
    const ext2 = deflateAndFitWithExpansion(raw, capacity, ssz, fat, fatAddrs, chain, buf, false);
    buf = ext2.buf; fat = ext2.fat; chain = ext2.chain;
    newCompressed = ext2.compressed;
    writeChainBytes(buf, chain, ssz, newCompressed);
  }
  buf.writeUInt32LE(newCompressed.length, dirEntry.entryFileOffset + 0x78);
  buf.writeUInt32LE(0, dirEntry.entryFileOffset + 0x7C);
  writeFileSync(filePath, buf);
  return { clusterSize: cluster.length, newBinDataId };
}

// ── Phase B: text styling via raw-patch (DocInfo CharShape + Section0 PARA_CHAR_SHAPE) ─
//
// Big-form .hwp files can't go through rhwp's exportHwp (round-trip is
// Hancom-Docs–rejected for large documents). The styling ops added in
// Phase A (apply_text_style / apply_paragraph_style) consequently work
// only on from-scratch / small forms.
//
// Phase B closes that gap by editing the underlying records directly:
//   1. read DocInfo, find the default CharShape ID at the target text
//      (the csId active at that char offset in the paragraph)
//   2. clone that CharShape's body, mutate the requested style fields
//      (attr bits, color words, baseSize) into a fresh 74-byte body
//   3. append the new CharShape to DocInfo (assign next csId)
//   4. update the paragraph's PARA_CHAR_SHAPE record so the target range
//      maps to the new csId (with a sentinel entry at the range end to
//      restore the previous csId)
//   5. deflate + write back — original bytes untouched everywhere else
//
// Ground truth was learned by comparing Hancom-Office-saved sample
// files against the pre-edit base — see the commit log for the
// detailed byte-level analysis.
// CharShape body layout (74 bytes):
//   0-13   font_ids[7]     (u16 × 7)
//   14-20  ratios[7]       (u8 × 7)
//   21-27  spacings[7]     (i8 × 7)
//   28-34  relative_sizes  (u8 × 7)
//   35-41  char_offsets    (i8 × 7)
//   42-45  base_size       (i32, HWP units = pt × 100)
//   46-49  attr            (u32 — see bit map below)
//   50-51  shadow_offset_x/y (i8 × 2)
//   52-55  text_color      (u32 BGR)
//   56-59  underline_color (u32 BGR)
//   60-63  shade_color     (u32 BGR) — highlight (also lives in PARA_RANGE_TAG)
//   64-67  shadow_color    (u32 BGR)
//   68-69  border_fill_id  (u16)
//   70-73  strike_color    (u32 BGR)
//
// attr u32 bit map (verified against Hancom Office output):
//   bit 0   italic
//   bit 1   bold
//   bits 2-3 underline (bit 2 alone = type 1 = Bottom; full type field)
//   bit 3 is ALSO set by Hancom when strikethrough is on (paired with
//   bit 18) — we faithfully replicate that pattern (attr=0x00040008 for
//   strike-only) rather than dissect why; the Hancom-emitted bytes are
//   the ground truth that round-trips through Hancom Docs.
//   bit 15  superscript
//   bit 16  subscript
//   bit 18  strikethrough (low bit of type field, but single-bit set
//           suffices for Hancom-emitted "취소선만 적용" case)

const TAG_CHAR_SHAPE = 21;        // HWPTAG_CHAR_SHAPE in DocInfo
const TAG_PARA_RANGE_TAG = 0x46;  // HWPTAG_PARA_RANGE_TAG in Section0

// ColorRef format: u32 little-endian = 0x00BBGGRR.
function parseColorBGR(hex) {
  if (typeof hex !== 'string') throw new Error(`color must be hex string, got ${typeof hex}`);
  const s = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`invalid color: ${hex}`);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return (b << 16) | (g << 8) | r;  // 0x00BBGGRR
}

// (We reuse the existing buildRecordHeader() defined above — same signature.)

// Synthesize a 74-byte CharShape body by cloning `base` and overlaying
// style props. `base` must be a CharShape body the target paragraph
// already uses, so font/ratio/spacing fields stay consistent with the
// surrounding text.
//
// CHAR_SHAPE size by HWP version (mirrors the 22 vs 24 PARA_HEADER and
// 46 vs 58 PARA_SHAPE patterns observed in h22-style files):
//   70 bytes — HWP 5.0.0 pre-strike-color (some older forms, e.g. h22).
//              Covers everything up to border_fill_id (offsets 0..69).
//              No strike_color field.
//   74 bytes — HWP 5.0.3+ (full layout with trailing strike_color u32).
// We always emit 74 bytes (zero-pad missing strike_color when base is
// 70 bytes — `style.strikethrough_color` then writes into the padded
// region). Hancom Office and Hancom Docs both accept the longer body
// because records are self-describing — each record carries its own
// length and the reader simply reads what's there. The h22-side test
// `apply_text_style({target: "주간업무보고서", bold: true})` exercises
// this path (h22's existing CharShapes are 70-byte; emitting 74 bytes
// for the new style keeps the file Hancom-Docs compatible).
function buildCharShapeBody(base, style) {
  if (!Buffer.isBuffer(base) || base.length < 70) {
    throw new Error(`CharShape base must be ≥70 bytes (got ${base ? base.length : typeof base})`);
  }
  // Match the base's size — emitting a 74-byte CharShape into a document
  // whose existing CharShapes are uniformly 70 bytes produces mixed-size
  // CHAR_SHAPE records, which Hancom Docs rejects on open. Concrete case:
  // h22-style files have all 70-byte CharShapes. Adding a 74-byte one
  // (even with zero-padded strike_color) caused
  // `apply_text_style({highlight: ...})` outputs to reject in Hancom Docs
  // even though the structural patch was otherwise correct. The
  // strike_color field at offset 70-73 is only used when the document's
  // format is 74-byte; if the base is 70-byte, we skip the
  // strikethrough_color write further below (out of bounds in 70-byte
  // body, but more importantly, Hancom Docs expects all CHAR_SHAPEs in
  // a 70-byte document to remain 70-byte).
  const outSize = base.length;
  const buf = Buffer.alloc(outSize);
  base.copy(buf, 0, 0, Math.min(base.length, outSize));

  // face-ids: 7 WORDs at offset 0-13 (one per language slot). When a font is
  // requested the caller resolves it to 7 face-ids via findOrCreateFaceNameIds
  // and passes them here; otherwise the base's face-ids are inherited.
  if (Array.isArray(style.faceIds) && style.faceIds.length === 7) {
    for (let i = 0; i < 7; i++) buf.writeUInt16LE(style.faceIds[i] & 0xffff, i * 2);
  }

  // attr u32 at offset 46 — start from base, clear managed bits, then OR
  // requested flags. This way unmanaged fields (outline / shadow /
  // emboss / engrave / emphasis_dot / kerning) inherited from base are
  // preserved.
  let attr = buf.readUInt32LE(46);
  const MANAGED_MASK = (
      0x00000001 |  // italic
      0x00000002 |  // bold
      0x0000000C |  // bits 2-3: underline type
      0x00008000 |  // bit 15: superscript
      0x00010000 |  // bit 16: subscript
      0x001C0000    // bits 18-20: strike type
  ) >>> 0;
  attr = (attr & ~MANAGED_MASK) >>> 0;
  if (style.italic) attr |= 0x00000001;
  if (style.bold) attr |= 0x00000002;
  if (style.underline) attr |= 0x00000004;  // bit 2: underline on, default type=Bottom
  if (style.strikethrough) attr |= 0x00040008;  // bit 3 + bit 18 (Hancom Office's strike pattern)
  if (style.superscript) attr |= 0x00008000;
  if (style.subscript) attr |= 0x00010000;
  buf.writeUInt32LE(attr >>> 0, 46);

  // baseSize at 42-45 (i32 HWP units = pt × 100)
  if (style.size != null) {
    buf.writeInt32LE(Math.round(style.size * 100), 42);
  }

  // text_color at 52-55 (always emit when caller passes color; otherwise inherit base)
  if (style.color) {
    buf.writeUInt32LE(parseColorBGR(style.color) >>> 0, 52);
  }
  // underline_color at 56-59
  if (style.underline_color) {
    buf.writeUInt32LE(parseColorBGR(style.underline_color) >>> 0, 56);
  }
  // strike_color at 70-73 (only present in 74-byte HWP 5.0.3+ format —
  // 70-byte older format has no slot for it. Skip when out of bounds.)
  if (style.strikethrough_color && buf.length >= 74) {
    buf.writeUInt32LE(parseColorBGR(style.strikethrough_color) >>> 0, 70);
  }
  // shade_color at 60-63 (highlight) — kept here as a fallback path for
  // renderers that look at CharShape rather than PARA_RANGE_TAG; the
  // primary highlight write happens via PARA_RANGE_TAG (see callers).
  if (style.highlight && style.highlight !== false) {
    const hex = style.highlight === true ? '#ffff00' : style.highlight;
    buf.writeUInt32LE(parseColorBGR(hex) >>> 0, 60);
  }

  // 장평 (char width ratio %, 7× u8 at 14-20; default 100) and 자간 (letter
  // spacing %, 7× i8 at 21-27; default 0). Offsets are GT-confirmed against
  // Hancom's char-shape --width/--spacing output. Broadcast to all 7 slots.
  const charRatio = style.char_ratio ?? style.charRatio;
  if (charRatio != null) {
    const v = Math.max(1, Math.min(255, Math.round(charRatio)));
    for (let i = 0; i < 7; i++) buf.writeUInt8(v, 14 + i);
  }
  const letterSpacing = style.letter_spacing ?? style.letterSpacing;
  if (letterSpacing != null) {
    const v = Math.max(-128, Math.min(127, Math.round(letterSpacing)));
    for (let i = 0; i < 7; i++) buf.writeInt8(v, 21 + i);
  }

  return buf;
}

// Walk DocInfo records, returning array of CharShape record bodies in ID order.
function readCharShapeBodies(diRaw) {
  const out = [];
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_CHAR_SHAPE) {
      out.push(diRaw.slice(r.dataOff, r.dataOff + r.size));
    }
  }
  return out;
}

// Append a new CharShape record to DocInfo (at end of last CharShape
// run). Returns the new csId and the updated DocInfo buffer.
//
// ALSO bumps the CHAR_SHAPE count in HWPTAG_ID_MAPPINGS — Hancom Docs
// rejects the file when DocInfo's actual record counts disagree with
// ID_MAPPINGS. ID_MAPPINGS body is a fixed-order u32 array; CHAR_SHAPE
// lives at index 9 (offset 36): BIN_DATA, FACE_NAME × 7, BORDER_FILL,
// **CHAR_SHAPE**, TAB_DEF, NUMBERING, BULLET, PARA_SHAPE, STYLE,
// MEMO_SHAPE, TRACK_CHANGE, TRACK_AUTHOR.
const ID_MAPPINGS_CHAR_SHAPE_OFFSET = 9 * 4;

function appendCharShapeToDocInfo(diRaw, body) {
  // Accept both 70-byte (HWP 5.0.0) and 74-byte (HWP 5.0.3+) sizes —
  // buildCharShapeBody emits whichever size the document's existing
  // CHAR_SHAPEs use to avoid mixed-size records that Hancom Docs rejects.
  if (body.length !== 70 && body.length !== 74) {
    throw new Error(`CharShape body must be 70 or 74 bytes (got ${body.length})`);
  }
  // Find the byte offset right after the last existing CharShape record.
  let insertAt = -1;
  let csCount = 0;
  let idMappingsDataOff = -1;
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_CHAR_SHAPE) {
      csCount++;
      insertAt = r.dataOff + r.size;
    }
    if (r.tag === 17) {  // HWPTAG_ID_MAPPINGS
      idMappingsDataOff = r.dataOff;
    }
  }
  if (insertAt < 0) insertAt = diRaw.length;
  if (idMappingsDataOff < 0) {
    throw new Error('HWPTAG_ID_MAPPINGS not found in DocInfo — file looks malformed');
  }
  const header = buildRecordHeader(TAG_CHAR_SHAPE, 0, body.length);
  const newRec = Buffer.concat([header, body]);
  const newDi = Buffer.concat([
    diRaw.slice(0, insertAt),
    newRec,
    diRaw.slice(insertAt),
  ]);
  // Bump CHAR_SHAPE count in ID_MAPPINGS. ID_MAPPINGS lives BEFORE
  // any CHAR_SHAPE record in DocInfo (ID_MAPPINGS tag=17, CHAR_SHAPE
  // tag=21, and DocInfo records are grouped by tag in ascending
  // order), so the dataOff we captured remains valid after the splice.
  const off = idMappingsDataOff + ID_MAPPINGS_CHAR_SHAPE_OFFSET;
  if (off + 4 > newDi.length) {
    throw new Error('ID_MAPPINGS body too short to hold CHAR_SHAPE count');
  }
  const oldCount = newDi.readUInt32LE(off);
  newDi.writeUInt32LE(oldCount + 1, off);
  return { newDi, newCsId: csCount };
}

// ── Font (글꼴) registration for raw-patch text styling ────────────────────
// HWP keeps fonts in a DocInfo FACE_NAME table grouped by 7 language slots
// (Korean, Latin, Hanja, Japanese, Other, Symbol, User), stored contiguously
// slot-by-slot. A CHAR_SHAPE carries 7 face-ids (one per slot) indexing into
// each slot's sub-list. To apply an arbitrary font we register it in every
// slot (so every script renders in it) and point the new CHAR_SHAPE's 7
// face-ids at it. ID_MAPPINGS holds the per-slot font counts at array indices
// 1..7 (right after BIN_DATA at index 0).
const TAG_FACE_NAME = 0x13;
const ID_MAPPINGS_FACE_NAME_OFFSET = 1 * 4; // first (Korean) FACE_NAME count

// Minimal FACE_NAME record body: attribute=0 (no substitute / type / base
// font) + nameLen(WORD, in WCHARs) + UTF-16LE name. Valid for any installed
// font — Hancom renders by name; the optional substitute font only matters
// when the face is absent on the rendering system.
function buildFaceNameBody(name) {
  const nm = Buffer.from(name, 'utf16le');
  const body = Buffer.alloc(3 + nm.length);
  body.writeUInt8(0, 0);
  body.writeUInt16LE(name.length, 1);
  nm.copy(body, 3);
  return body;
}

// Ensure `fontName` exists in all 7 FACE_NAME language slots; returns the
// updated DocInfo buffer and the 7 face-ids to write into a CHAR_SHAPE.
function findOrCreateFaceNameIds(diRaw, fontName) {
  let idMapOff = -1;
  for (const r of walkRecords(diRaw)) { if (r.tag === TAG_ID_MAPPINGS) { idMapOff = r.dataOff; break; } }
  if (idMapOff < 0) throw new Error('apply_text_style(font): HWPTAG_ID_MAPPINGS not found');
  const counts = [];
  for (let i = 0; i < 7; i++) counts.push(diRaw.readUInt32LE(idMapOff + ID_MAPPINGS_FACE_NAME_OFFSET + i * 4));

  const faces = [];
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_FACE_NAME) {
      const len = diRaw.readUInt16LE(r.dataOff + 1);
      faces.push({ name: diRaw.slice(r.dataOff + 3, r.dataOff + 3 + len * 2).toString('utf16le'), headOff: r.headOff, endOff: r.dataOff + r.size });
    }
  }
  if (faces.length === 0) throw new Error('apply_text_style(font): no FACE_NAME records in DocInfo');

  // Per-slot insert offset (end of slot's run) and current font names.
  const faceIds = new Array(7);
  const inserts = [];
  let i = 0;
  let prevEnd = faces[0].headOff;
  for (let s = 0; s < 7; s++) {
    const cnt = counts[s];
    const slot = faces.slice(i, i + cnt);
    const insOff = cnt > 0 ? slot[slot.length - 1].endOff : prevEnd;
    const existing = slot.findIndex((f) => f.name === fontName);
    if (existing >= 0) {
      faceIds[s] = existing;
    } else {
      faceIds[s] = cnt;
      const body = buildFaceNameBody(fontName);
      inserts.push({ offset: insOff, bytes: Buffer.concat([buildRecordHeader(TAG_FACE_NAME, 0, body.length), body]), slot: s });
    }
    if (cnt > 0) prevEnd = slot[slot.length - 1].endOff;
    i += cnt;
  }
  if (inserts.length === 0) return { newDi: diRaw, faceIds };

  // Splice in descending offset order so earlier offsets stay valid.
  let out = diRaw;
  for (const ins of [...inserts].sort((a, b) => b.offset - a.offset)) {
    out = Buffer.concat([out.slice(0, ins.offset), ins.bytes, out.slice(ins.offset)]);
  }
  // Bump per-slot ID_MAPPINGS counts (ID_MAPPINGS precedes FACE_NAME, so its
  // offset is unaffected by the splices above).
  for (const ins of inserts) {
    const off = idMapOff + ID_MAPPINGS_FACE_NAME_OFFSET + ins.slot * 4;
    out.writeUInt32LE(out.readUInt32LE(off) + 1, off);
  }
  return { newDi: out, faceIds };
}

// Locate the target string in Section0 raw. Returns the FIRST occurrence:
//   { paraIdx, paraHeaderRec, paraTextRec, paraCharShapeRec, start, end, paraLevel, isInCell }
// `paraIdx` counts level-0 PARA_HEADER records (0-based, document order),
// so it identifies the **outer** paragraph the match lives under (which
// equals the cell's containing top-level paragraph when the match is
// inside a table). `start` / `end` are character offsets within the
// paragraph text. `paraLevel` is the level of the matching PARA_TEXT
// (1 for body text, 3 for table-cell text, 5+ for nested table cells).
// `isInCell` is `paraLevel >= 3`.
//
// Search policy (preserves prior Phase B body-only behavior):
//   1. FIRST PASS — level-1 PARA_TEXT (body) only. Returns immediately on
//      match. Preserves the previously-shipped behavior where ktx-style
//      forms with multiple "추진배경" matches (some in cells, some in
//      body) consistently picked the body match. Without this two-pass
//      policy, an earlier table-of-contents cell match would shadow the
//      real body section heading and the RANGE_TAG would land at level 3
//      inside a cell, which Hancom Docs rejects.
//   2. SECOND PASS — all higher levels (cell text at level 3+) only if
//      the body pass found nothing. This is the h22-style support added
//      for task #12 — forms whose visible content lives entirely inside
//      table cells (e.g. h22 work_report has "주간업무보고서" as a 1×2
//      borderless header table's first cell). For matches at level ≥ 3
//      the function returns the cell's level-(L-1) PARA_HEADER and
//      level-L PARA_CHAR_SHAPE so the caller can write styling into the
//      correct cell paragraph.
function findTextRangeInSection(secRaw, target) {
  const records = parseRecords(secRaw);

  // Two-pass search: body-only (level 1) first, then cell levels (≥ 3).
  // The passes share record tracking but apply different level filters
  // when checking PARA_TEXT matches.
  for (const passMinLevel of [1, 3]) {
    const passMaxLevel = passMinLevel === 1 ? 1 : Infinity;
    let paraIdx = -1;
    const headerByLevel = {};  // level → most recent PARA_HEADER at that level
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.tag === TAG_PARA_HEADER) {
        headerByLevel[r.level] = r;
        if (r.level === 0) paraIdx++;
      }
      if (r.tag === TAG_PARA_TEXT) {
        if (r.level < passMinLevel || r.level > passMaxLevel) continue;
        const text = secRaw.slice(r.dataOff, r.dataOff + r.size).toString('utf16le');
        const idx = text.indexOf(target);
        if (idx >= 0) {
          // The owning PARA_HEADER is one level above the PARA_TEXT.
          // Body: PARA_TEXT lvl 1 → PARA_HEADER lvl 0.
          // Cell: PARA_TEXT lvl 3 → PARA_HEADER lvl 2.
          // Nested cell: PARA_TEXT lvl 5 → PARA_HEADER lvl 4. Etc.
          const ownerHeader = headerByLevel[r.level - 1];
          if (!ownerHeader) continue;  // orphan PARA_TEXT — malformed; skip

          // Find the PARA_CHAR_SHAPE at the SAME level as the PARA_TEXT.
          // Walk forward stopping at the next PARA_HEADER at the same or
          // shallower level (that's the boundary of the current paragraph).
          let csRec = null;
          for (let j = i + 1; j < records.length; j++) {
            const r2 = records[j];
            if (r2.tag === TAG_PARA_CHAR_SHAPE && r2.level === r.level) {
              csRec = r2;
              break;
            }
            if (r2.tag === TAG_PARA_HEADER && r2.level <= r.level - 1) break;
          }

          return {
            paraIdx,
            paraHeaderRec: ownerHeader,
            paraTextRec: r,
            paraCharShapeRec: csRec,
            start: idx,
            end: idx + target.length,
            textLength: Math.floor(r.size / 2),
            paraLevel: r.level,
            isInCell: r.level >= 3,
          };
        }
      }
    }
  }
  return null;
}

// Bump PARA_HEADER count fields after we add records to the paragraph
// cluster. Both counters live in the PARA_HEADER body — Hancom Docs
// validates them against the actual record count and rejects the file
// if they're out of sync.
//   body offset 12-13 (u16): num_char_shapes  (= PARA_CHAR_SHAPE entries)
//   body offset 14-15 (u16): range_tags_count (= PARA_RANGE_TAG records)
function bumpParaHeaderCounts(secRaw, paraHeaderRec, deltaCharShapes, deltaRangeTags) {
  if (paraHeaderRec.size < 16) return secRaw;  // malformed; skip
  if (!deltaCharShapes && !deltaRangeTags) return secRaw;
  const out = Buffer.from(secRaw);
  if (deltaCharShapes) {
    const off = paraHeaderRec.dataOff + 12;
    out.writeUInt16LE(((out.readUInt16LE(off) + deltaCharShapes) & 0xFFFF) >>> 0, off);
  }
  if (deltaRangeTags) {
    const off = paraHeaderRec.dataOff + 14;
    out.writeUInt16LE(((out.readUInt16LE(off) + deltaRangeTags) & 0xFFFF) >>> 0, off);
  }
  return out;
}

// Insert (start, newCsId) + (end, prevCsId) entries into a PARA_CHAR_SHAPE
// record. Returns { secRaw, deltaEntries } — deltaEntries = (new entries -
// old entries), caller propagates that into the PARA_HEADER count.
function updateParaCharShapeRange(secRaw, csRec, start, end, newCsId) {
  // Parse existing entries: (pos u32, csId u32) × N
  const oldBody = secRaw.slice(csRec.dataOff, csRec.dataOff + csRec.size);
  const entries = [];
  for (let off = 0; off + 8 <= oldBody.length; off += 8) {
    entries.push({
      pos: oldBody.readUInt32LE(off),
      csId: oldBody.readUInt32LE(off + 4),
    });
  }
  if (entries.length === 0) {
    throw new Error('PARA_CHAR_SHAPE record is empty');
  }
  // Determine csId active immediately after `end` so we can restore it.
  let csIdAtEnd = entries[0].csId;
  for (const e of entries) {
    if (e.pos <= end) csIdAtEnd = e.csId;
  }
  // Remove entries strictly inside (start, end] — they'll be replaced.
  const filtered = entries.filter(e => e.pos <= start || e.pos > end);
  filtered.push({ pos: start, csId: newCsId });
  filtered.push({ pos: end, csId: csIdAtEnd });
  // Sort by pos, deduplicate (later entry at same pos wins).
  filtered.sort((a, b) => a.pos - b.pos);
  const dedup = [];
  for (const e of filtered) {
    if (dedup.length && dedup[dedup.length - 1].pos === e.pos) {
      dedup[dedup.length - 1] = e;
    } else {
      dedup.push(e);
    }
  }
  // Build new body
  const newBody = Buffer.alloc(dedup.length * 8);
  dedup.forEach((e, i) => {
    newBody.writeUInt32LE(e.pos >>> 0, i * 8);
    newBody.writeUInt32LE(e.csId >>> 0, i * 8 + 4);
  });
  // Preserve the original PARA_CHAR_SHAPE level. Body PARA_TEXT uses level 1,
  // so the matching PARA_CHAR_SHAPE is also level 1. Cell PARA_TEXT (level 3)
  // matches PARA_CHAR_SHAPE at level 3. Hardcoding level=1 was correct for
  // body-only callers but broke the cell path (task #12): the rewritten
  // record came out at level 1 inside a level-3 cluster, so the subsequent
  // `findTextRangeInSection` couldn't locate it again (looks for the same
  // level as the matching PARA_TEXT), returning paraCharShapeRec=null and
  // crashing the highlight branch on `csRec.ext`.
  const newHeader = buildRecordHeader(TAG_PARA_CHAR_SHAPE, csRec.level, newBody.length);
  const newRec = Buffer.concat([newHeader, newBody]);
  // Splice into stream — replace old record bytes with new record bytes.
  const oldHeaderLen = csRec.ext ? 8 : 4;
  const oldTotalLen = oldHeaderLen + csRec.size;
  const newSecRaw = Buffer.concat([
    secRaw.slice(0, csRec.headOff),
    newRec,
    secRaw.slice(csRec.headOff + oldTotalLen),
  ]);
  return { secRaw: newSecRaw, deltaEntries: dedup.length - entries.length };
}

// Insert a PARA_RANGE_TAG record (tag=0x46) for a highlight range inside
// a paragraph cluster. The record goes right after the paragraph's
// PARA_CHAR_SHAPE (or, if absent, right after the PARA_TEXT).
//
// PARA_RANGE_TAG body: start u32, end u32, tag u32
//   tag upper 8 bits = kind (0x02 = highlight)
//   tag lower 24 bits = data (BGR color, e.g. 0x00FFFF for #FFFF00 yellow)
//
// The new record's level must match the surrounding paragraph cluster:
// body PARA_CHAR_SHAPE is level 1 → RANGE_TAG level 1; cell PARA_CHAR_SHAPE
// is level 3 → RANGE_TAG level 3. Hardcoding level=1 (the body-only
// assumption) for cell targets produced a level-1 RANGE_TAG dangling
// inside a level-3 cluster, which Hancom Docs validates as malformed and
// rejects on open. Pass the csRec's actual level through.
function insertParaRangeTagForHighlight(secRaw, csRec, start, end, hex) {
  const color = parseColorBGR(hex) >>> 0;
  const tagWord = (0x02 << 24) | (color & 0xFFFFFF);
  const body = Buffer.alloc(12);
  body.writeUInt32LE(start >>> 0, 0);
  body.writeUInt32LE(end >>> 0, 4);
  body.writeUInt32LE(tagWord >>> 0, 8);
  const newRec = Buffer.concat([buildRecordHeader(TAG_PARA_RANGE_TAG, csRec.level, body.length), body]);
  // Insert right after csRec (so it's part of the paragraph cluster).
  const csHeaderLen = csRec.ext ? 8 : 4;
  const insertAt = csRec.headOff + csHeaderLen + csRec.size;
  return Buffer.concat([
    secRaw.slice(0, insertAt),
    newRec,
    secRaw.slice(insertAt),
  ]);
}

// Resolve the csId active at `pos` within a PARA_CHAR_SHAPE record.
function csIdAtOffset(csRec, secRaw, pos) {
  const oldBody = secRaw.slice(csRec.dataOff, csRec.dataOff + csRec.size);
  let id = oldBody.readUInt32LE(4);
  for (let off = 0; off + 8 <= oldBody.length; off += 8) {
    const p = oldBody.readUInt32LE(off);
    if (p <= pos) id = oldBody.readUInt32LE(off + 4);
  }
  return id;
}

/**
 * Apply text styles to existing `.hwp` content via raw-patch.
 *
 * Each op: `{ target, bold?, italic?, underline?, strikethrough?,
 *             color?, highlight?, size?, font_family?,
 *             superscript?, subscript?, underline_color? }`
 *
 * Resolution model: target is matched as the FIRST occurrence in the
 * body's PARA_TEXT records (top-level paragraphs only — table cells
 * and nested controls are not searched in v1). The style applies to
 * just that occurrence.
 *
 * For highlight specifically, two writes happen: (a) `shade_color` on
 * a fresh CharShape so renderers that look at CharShape see the color,
 * and (b) a PARA_RANGE_TAG record so Hancom's primary highlight path
 * (markpen marker in HWPX terminology) is also satisfied.
 */
export async function applyTextStyleInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    if (typeof op.target !== 'string' || op.target.length === 0) {
      throw new Error("apply_text_style: 'target' is required");
    }
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  // Load DocInfo + Section0.
  const diEntry = findStreamEntry(entries, ['DocInfo']);
  const diInMini = diEntry.size < 4096;
  let diChain, diCompressed;
  if (diInMini) {
    const rc = ensureRootChain();
    diChain = walkChain(minifat, diEntry.start);
    diCompressed = readMiniChainBytes(buf, diChain, rc, ssz, mssz, diEntry.size);
  } else {
    diChain = walkChain(fat, diEntry.start);
    diCompressed = readChainBytes(buf, diChain, ssz, diEntry.size);
  }
  let diRaw = Buffer.from(inflateRawSync(diCompressed));

  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const summary = [];
  for (const op of ops) {
    const hit = findTextRangeInSection(secRaw, op.target);
    if (!hit) {
      throw new Error(`apply_text_style: target "${op.target}" not found in body`);
    }
    if (!hit.paraCharShapeRec) {
      throw new Error(`apply_text_style: PARA_CHAR_SHAPE not found for target "${op.target}"`);
    }

    // Determine base CharShape (the one active at the target start).
    const baseCsId = csIdAtOffset(hit.paraCharShapeRec, secRaw, hit.start);

    // Font: register the requested face in DocInfo's FACE_NAME table (every
    // language slot) and resolve it to 7 face-ids for the new CharShape. This
    // mutates diRaw, so it must run before readCharShapeBodies below.
    const fontName = op.font_family || op.fontFamily || op.font;
    let faceIds = null;
    if (typeof fontName === 'string' && fontName.length > 0) {
      const fr = findOrCreateFaceNameIds(diRaw, fontName);
      diRaw = fr.newDi;
      faceIds = fr.faceIds;
    }

    const csBodies = readCharShapeBodies(diRaw);
    if (baseCsId >= csBodies.length) {
      throw new Error(`apply_text_style: base csId ${baseCsId} out of range (have ${csBodies.length})`);
    }
    // Build new CharShape from base + style overlay (incl. resolved font face-ids).
    const styleInput = { ...op };
    if (op.size != null && styleInput.fontSize == null) styleInput.fontSize = op.size;
    if (faceIds) styleInput.faceIds = faceIds;
    const newBody = buildCharShapeBody(csBodies[baseCsId], styleInput);

    // Dedup: if a CharShape with identical body already exists, reuse it.
    let newCsId = csBodies.findIndex(b => b.equals(newBody));
    if (newCsId < 0) {
      const r = appendCharShapeToDocInfo(diRaw, newBody);
      diRaw = r.newDi;
      newCsId = r.newCsId;
    }

    // Update PARA_CHAR_SHAPE on the target paragraph. Re-locate `hit` —
    // every section mutation invalidates the previous offsets.
    let refreshed = findTextRangeInSection(secRaw, op.target);
    if (!refreshed) throw new Error('internal: target disappeared after CharShape append');
    const csUpd = updateParaCharShapeRange(
      secRaw, refreshed.paraCharShapeRec,
      refreshed.start, refreshed.end, newCsId,
    );
    secRaw = csUpd.secRaw;
    // Bump PARA_HEADER.num_char_shapes by the entry delta — Hancom Docs
    // rejects the file when this counter doesn't match the actual
    // entries in PARA_CHAR_SHAPE.
    if (csUpd.deltaEntries !== 0) {
      refreshed = findTextRangeInSection(secRaw, op.target);
      if (refreshed) secRaw = bumpParaHeaderCounts(secRaw, refreshed.paraHeaderRec, csUpd.deltaEntries, 0);
    }

    // Highlight side: add a PARA_RANGE_TAG so Hancom's primary highlight
    // path (the markpen-equivalent) is satisfied. Also bumps the
    // PARA_HEADER.range_tags_count by 1 (one new RANGE_TAG record).
    //
    // CELL EXCEPTION (level >= 3): empirically, emitting PARA_RANGE_TAG
    // inside a cell cluster (level 3) is rejected by Hancom Docs even
    // though the structural emit looks correct (RANGE_TAG at csRec.level,
    // range_tags_count bumped on the cell PARA_HEADER, CHAR_SHAPE size
    // matched to the document's format). The rhwp-native cell-text
    // highlighting code path doesn't emit a RANGE_TAG either — it relies
    // on CharShape.shade_color alone. So for cell targets, we skip the
    // RANGE_TAG emit. The shade_color is already in the new CharShape
    // (buildCharShapeBody writes it at offset 60-63 when op.highlight is
    // set), so highlight visually still applies — just without the
    // RANGE_TAG-based primary path.
    if (op.highlight !== undefined && op.highlight !== false && !hit.isInCell) {
      const hex = op.highlight === true ? '#ffff00' : op.highlight;
      refreshed = findTextRangeInSection(secRaw, op.target);
      if (!refreshed) throw new Error('internal: target disappeared after PARA_CHAR_SHAPE update');
      secRaw = insertParaRangeTagForHighlight(
        secRaw, refreshed.paraCharShapeRec,
        refreshed.start, refreshed.end, hex,
      );
      refreshed = findTextRangeInSection(secRaw, op.target);
      if (refreshed) secRaw = bumpParaHeaderCounts(secRaw, refreshed.paraHeaderRec, 0, 1);
    }

    summary.push({
      target: op.target,
      paraIdx: hit.paraIdx,
      start: hit.start,
      end: hit.end,
      baseCsId,
      newCsId,
    });
  }

  // Deflate + write DocInfo. mini-stream paths must use ext.miniChain /
  // ext.newRegularChain — NOT ext.chain (that field doesn't exist on
  // deflateMiniChainWithExpansion's return). Promotion happens when the new
  // compressed size crosses the 4096-byte mini-stream cutoff (e.g. h22 mini
  // DocInfo growing past the threshold after appending a new ParaShape).
  // Previously this branch was missing and produced a runtime
  // `Cannot read properties of undefined` crash for mini-stream forms.
  {
    const inMini = diInMini;
    const capacity = inMini ? diChain.length * mssz : diChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        diRaw, diChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        diChain = ext.newRegularChain;
        writeChainBytes(buf, diChain, ssz, ext.compressed);
        buf.writeInt32LE(diChain[0], diEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        diChain = ext.miniChain;
        writeMiniChainBytes(buf, diChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(diRaw, capacity, ssz, fat, fatAddrs, diChain, buf, false);
      buf = ext.buf; fat = ext.fat; diChain = ext.chain;
      writeChainBytes(buf, diChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    }
  }

  // Deflate + write Section0. Same mini-stream pattern as DocInfo above.
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}

// ── applyParagraphStyleInPlace ──────────────────────────────────────────────
//
// Raw-patch path for paragraph-level styles (alignment / indent / margins /
// line spacing / spacing before-after / background) on large multi-page
// `.hwp` files where round-tripping through rhwp's `exportHwp()` produces
// output Hancom Docs rejects. Mirrors applyTextStyleInPlace's architecture:
// clone the paragraph's current PARA_SHAPE, overlay style props, dedup
// against existing entries or append to DocInfo (bumping the matching
// HWPTAG_ID_MAPPINGS count), then rewrite the PARA_HEADER's paraShapeId.
//
// PARA_SHAPE body layout (58 bytes, per rhwp serializer):
//   0-3:   attr1 (u32) — bits 0-1 line_spacing_type, bits 2-4 alignment
//   4-7:   margin_left (i32)
//   8-11:  margin_right (i32)
//   12-15: indent (i32)
//   16-19: spacing_before (i32)
//   20-23: spacing_after (i32)
//   24-27: line_spacing (i32, default 160)
//   28-29: tab_def_id (u16)
//   30-31: numbering_id (u16)
//   32-33: border_fill_id (u16)
//   34-41: border_spacing[4] (i16: left, right, top, bottom)
//   42-45: attr2 (u32)
//   46-49: attr3 (u32)
//   50-53: line_spacing_v2 (u32)
//   54-57: trailing tail (Hancom-emitted .hwp always has it; write 0)
//
// BORDER_FILL body for a solid-fill background (53 bytes):
//   0-1:   attr (u16) = 0
//   2-25:  borders[4] (each: type u8 + width u8 + color u32) = 24 bytes
//   26-31: diagonal (type u8 + width u8 + color u32) = 6 bytes
//   32-35: fill_type (u32) = 1 (solid)
//   36-39: background_color (ColorRef u32 = 0x00BBGGRR)
//   40-43: pattern_color (ColorRef) = 0x00FFFFFF
//   44-47: pattern_type (i32) = -1 (no pattern overlay)
//   48-51: size_marker (u32) = 0
//   52:    alpha (u8) = 0

const TAG_PARA_SHAPE = 25;
const TAG_BORDER_FILL = 20;

// ID_MAPPINGS body is 18 u32 entries (per rhwp serialize_id_mappings):
//   0  bin_data_count
//   1..7  font_count[0..6] (7 languages)
//   8  border_fill_count          ← offset 32
//   9  char_shape_count           ← offset 36 (ID_MAPPINGS_CHAR_SHAPE_OFFSET)
//   10 tab_def_count
//   11 numbering_count
//   12 bullet_count
//   13 para_shape_count           ← offset 52
//   14 style_count
//   15 memo_shape_count
//   16-17 reserved
const ID_MAPPINGS_BORDER_FILL_OFFSET = 8 * 4;
const ID_MAPPINGS_PARA_SHAPE_OFFSET = 13 * 4;
const ID_MAPPINGS_NUMBERING_OFFSET = 11 * 4;
const ID_MAPPINGS_BULLET_OFFSET = 12 * 4;
const TAG_NUMBERING = 23;
const TAG_BULLET = 24;
// Native Hancom records, GT-extracted (cell-style/list via Hancom web → .hwp):
//   NUMBERING = standard decimal "^1." per level (^1 = the auto-number).
//   BULLET    = "●" glyph (U+F06C). Replayed verbatim so a numbered/bulleted
//   paragraph that references them renders identically to Hancom's own output.
const NUMBERING_TEMPLATE_HEX = '0c00000000003200ffffffff03005e0031002e000c01000000003200ffffffff03005e0032002e000c00000000003200ffffffff03005e00330029000c01000000003200ffffffff03005e00340029000c00000000003200ffffffff040028005e00350029000c01000000003200ffffffff040028005e00360029002c00000000003200ffffffff02005e0037000100010000000100000001000000010000000100000001000000010000002c01000000003200ffffffff02005e0038000c00000000003200ffffffff00000c00000000003200ffffffff0000010000000100000001000000';
const BULLET_TEMPLATE_HEX = '0800000000003200ffffffff6cf00000000000000000002000';

const ALIGNMENT_MAP = {
  justify: 0,
  justified: 0,
  left: 1,
  right: 2,
  center: 3,
  distribute: 4,
  split: 5,
};

const LINE_SPACING_TYPE_MAP = {
  percent: 0,
  fixed: 1,
  space_only: 2,
  spaceonly: 2,
  minimum: 3,
};

// Synthesize a 58-byte ParaShape body by cloning `base` and overlaying style
// props. `base` must be the ParaShape body the target paragraph already
// uses, so unmanaged fields (border_spacing, attr2, attr3, tab_def_id,
// numbering_id) stay consistent with surrounding paragraphs.
//
// PARA_SHAPE size by HWP version (mirrors the 22 vs 24 PARA_HEADER pattern):
//   46 bytes — HWP 5.0.0 pre-attr3 (some older forms, e.g. h22-style).
//              Covers attr1 + margins + indent + spacings + line_spacing +
//              tab_def_id + numbering_id + border_fill_id + border_spacing[4]
//              + attr2 (offsets 0..45). No attr3, line_spacing_v2, or tail.
//   54 bytes — Intermediate (attr3 + line_spacing_v2 present, no tail).
//   58 bytes — HWP 5.0.3+ (full layout with 4-byte trailing tail).
// We always emit 58 bytes (zero-pad missing tail fields). Hancom Office and
// Hancom Docs both accept the longer body in older forms because record sizes
// are self-describing — each record carries its own length and the reader
// just reads what's there. Concrete check: 46-byte h22 → 58-byte emit →
// Hancom Docs ✓ (verified 2026-05-28 with the apply_paragraph_style test).
function buildParaShapeBody(base, style) {
  if (!Buffer.isBuffer(base) || base.length < 46) {
    throw new Error(`ParaShape base must be ≥46 bytes (got ${base ? base.length : typeof base})`);
  }
  // Always pad/truncate to 58 bytes (Hancom-emitted .hwp expects the trailing 4-byte tail).
  const buf = Buffer.alloc(58);
  base.copy(buf, 0, 0, Math.min(base.length, 58));

  let attr1 = buf.readUInt32LE(0);
  if (style.alignment != null) {
    const a = ALIGNMENT_MAP[String(style.alignment).toLowerCase()];
    if (a == null) throw new Error(`apply_paragraph_style: unknown alignment "${style.alignment}"`);
    attr1 = ((attr1 & ~(0x07 << 2)) | (a << 2)) >>> 0;
  }
  if (style.lineSpacingType != null) {
    const t = LINE_SPACING_TYPE_MAP[String(style.lineSpacingType).toLowerCase()];
    if (t == null) throw new Error(`apply_paragraph_style: unknown lineSpacingType "${style.lineSpacingType}"`);
    attr1 = ((attr1 & ~0x03) | t) >>> 0;
  }
  // 문단 머리 종류 (heading kind) — attr1 bits 23-24: 0=none, 1=outline,
  // 2=number, 3=bullet. GT-confirmed (a Hancom-authored list: numbered para
  // attr1 0x01000180 vs plain 0x00000180 = bit 24; bullet 0x01800180 = bits
  // 23+24). The id ref at offset 30 then points to the matching NUMBERING
  // (kind 2) or BULLET (kind 3) record.
  if (style.headingKind != null) {
    attr1 = ((attr1 & ~(0x3 << 23)) | ((style.headingKind & 0x3) << 23)) >>> 0;
  }
  buf.writeUInt32LE(attr1 >>> 0, 0);

  if (style.marginLeft != null) buf.writeInt32LE(Math.round(style.marginLeft), 4);
  if (style.marginRight != null) buf.writeInt32LE(Math.round(style.marginRight), 8);
  if (style.indent != null) buf.writeInt32LE(Math.round(style.indent), 12);
  if (style.spacingBefore != null) buf.writeInt32LE(Math.round(style.spacingBefore), 16);
  if (style.spacingAfter != null) buf.writeInt32LE(Math.round(style.spacingAfter), 20);
  if (style.lineSpacing != null) {
    const v = Math.round(style.lineSpacing);
    buf.writeInt32LE(v, 24);
    buf.writeUInt32LE(v >>> 0, 50);  // line_spacing_v2 — keep in sync (5.0.2.5+ readers prefer this)
  }
  if (style.borderFillId != null) {
    buf.writeUInt16LE(style.borderFillId & 0xFFFF, 32);
  }
  // numbering_id / bullet_id share this u16 (which one is decided by the
  // heading kind in attr1 above).
  if (style.headingId != null) {
    buf.writeUInt16LE(style.headingId & 0xFFFF, 30);
  }
  return buf;
}

function readParaShapeBodies(diRaw) {
  const out = [];
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_PARA_SHAPE) {
      out.push(diRaw.slice(r.dataOff, r.dataOff + r.size));
    }
  }
  return out;
}

// Append a new PARA_SHAPE record at the end of the existing PARA_SHAPE run
// in DocInfo, AND bump the count in HWPTAG_ID_MAPPINGS. Returns the new
// paraShapeId (0-based, document order) and the updated DocInfo buffer.
function appendParaShapeToDocInfo(diRaw, body) {
  let psCount = 0;
  let lastParaShapeRecEnd = -1;
  let idMappingsDataOff = -1;
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_PARA_SHAPE) {
      psCount++;
      lastParaShapeRecEnd = r.dataOff + r.size;
    }
    if (r.tag === 17) idMappingsDataOff = r.dataOff;
  }
  if (idMappingsDataOff < 0) {
    throw new Error('HWPTAG_ID_MAPPINGS not found in DocInfo — file looks malformed');
  }
  const insertAt = lastParaShapeRecEnd >= 0 ? lastParaShapeRecEnd : diRaw.length;
  const header = buildRecordHeader(TAG_PARA_SHAPE, 0, body.length);
  const newRec = Buffer.concat([header, body]);
  const newDi = Buffer.concat([
    diRaw.slice(0, insertAt),
    newRec,
    diRaw.slice(insertAt),
  ]);
  // ID_MAPPINGS (tag=17) lives BEFORE any PARA_SHAPE (tag=25 — DocInfo is
  // grouped by tag in ascending order), so idMappingsDataOff stays valid.
  const off = idMappingsDataOff + ID_MAPPINGS_PARA_SHAPE_OFFSET;
  if (off + 4 > newDi.length) {
    throw new Error('ID_MAPPINGS body too short to hold PARA_SHAPE count');
  }
  const oldCount = newDi.readUInt32LE(off);
  newDi.writeUInt32LE(oldCount + 1, off);
  return { newDi, newPsId: psCount };
}

// Append a NUMBERING (tag 23) or BULLET (tag 24) record (built from a native
// template) into DocInfo, keeping the tag-ascending record order, and bump the
// matching HWPTAG_ID_MAPPINGS count. Returns { newDi, newId } with newId 1-based
// (paragraph numbering/bullet id refs are 1-based, like BorderFill).
function appendHeadingRecordToDocInfo(diRaw, tag, body, idMappingsOffset) {
  let count = 0;
  let lastSameTagEnd = -1;
  let lastLowerTagEnd = -1;   // fallback insert point: after the last record whose tag < target (but ≥ ID_MAPPINGS)
  let idMappingsDataOff = -1;
  for (const r of walkRecords(diRaw)) {
    if (r.tag === tag) { count++; lastSameTagEnd = r.dataOff + r.size; }
    else if (r.tag >= 17 && r.tag < tag) lastLowerTagEnd = r.dataOff + r.size;
    if (r.tag === 17) idMappingsDataOff = r.dataOff;
  }
  if (idMappingsDataOff < 0) {
    throw new Error('HWPTAG_ID_MAPPINGS not found in DocInfo — file looks malformed');
  }
  const insertAt = lastSameTagEnd >= 0 ? lastSameTagEnd
    : (lastLowerTagEnd >= 0 ? lastLowerTagEnd : diRaw.length);
  const header = buildRecordHeader(tag, 0, body.length);
  const newRec = Buffer.concat([header, body]);
  const newDi = Buffer.concat([diRaw.slice(0, insertAt), newRec, diRaw.slice(insertAt)]);
  const off = idMappingsDataOff + idMappingsOffset;
  if (off + 4 > newDi.length) {
    throw new Error('ID_MAPPINGS body too short to hold numbering/bullet count');
  }
  newDi.writeUInt32LE(newDi.readUInt32LE(off) + 1, off);
  return { newDi, newId: count + 1 };
}
function appendNumberingToDocInfo(diRaw) {
  return appendHeadingRecordToDocInfo(diRaw, TAG_NUMBERING, Buffer.from(NUMBERING_TEMPLATE_HEX, 'hex'), ID_MAPPINGS_NUMBERING_OFFSET);
}
function appendBulletToDocInfo(diRaw) {
  return appendHeadingRecordToDocInfo(diRaw, TAG_BULLET, Buffer.from(BULLET_TEMPLATE_HEX, 'hex'), ID_MAPPINGS_BULLET_OFFSET);
}

/**
 * Apply list formatting (numbered / bulleted) to existing `.hwp` paragraphs via
 * raw-patch. Ops: `set_numbered_list` / `set_bullet_list`, each targeting one
 * body paragraph by `target` (string, first paragraph containing it) or `index`
 * (0-based level-0 paragraph in Section0) — same addressing apply_paragraph_style
 * uses.
 *
 * Mechanism (GT-confirmed): HWP renders a paragraph's number/bullet purely from
 * its PARA_SHAPE — attr1 heading-kind bits (2=number, 3=bullet) + a NUMBERING /
 * BULLET id ref at offset 30; NO inline text control char is needed. We append a
 * native NUMBERING (or BULLET) record to DocInfo ONCE per call (so multiple items
 * share one id and number continuously), then for each target clone its
 * PARA_SHAPE with the heading kind + id set, dedup/append, and repoint the
 * PARA_HEADER. Section0 only.
 */
export async function applyListInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', listed_count: 0 });
  }
  for (const op of ops) {
    const hasTarget = typeof op.target === 'string' && op.target.length > 0;
    const hasIdx = Number.isInteger(op.index) && op.index >= 0;
    if (!hasTarget && !hasIdx) {
      throw new Error(`${op.type}: 'target' (string) or 'index' (non-negative integer) is required`);
    }
    if (op.type !== 'set_numbered_list' && op.type !== 'set_bullet_list') {
      throw new Error(`applyListInPlace: unsupported op type "${op.type}"`);
    }
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const diEntry = findStreamEntry(entries, ['DocInfo']);
  const diInMini = diEntry.size < 4096;
  let diChain, diCompressed;
  if (diInMini) {
    const rc = ensureRootChain();
    diChain = walkChain(minifat, diEntry.start);
    diCompressed = readMiniChainBytes(buf, diChain, rc, ssz, mssz, diEntry.size);
  } else {
    diChain = walkChain(fat, diEntry.start);
    diCompressed = readChainBytes(buf, diChain, ssz, diEntry.size);
  }
  let diRaw = Buffer.from(inflateRawSync(diCompressed));

  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  // One shared NUMBERING / BULLET record per call → continuous numbering.
  let sharedNumberingId = null, sharedBulletId = null;
  const summary = [];
  for (const op of ops) {
    const kind = op.type === 'set_numbered_list' ? 2 : 3;
    let hit;
    if (typeof op.target === 'string' && op.target.length > 0) {
      hit = findTextRangeInSection(secRaw, op.target);
      if (!hit) throw new Error(`${op.type}: target "${op.target}" not found in body`);
      hit.start = 0; hit.end = hit.textLength;
    } else {
      hit = findParagraphByIndexInSection(secRaw, op.index);
      if (!hit) throw new Error(`${op.type}: index ${op.index} not found in section`);
    }
    if (hit.paraHeaderRec.size < 10) {
      throw new Error(`${op.type}: PARA_HEADER body too short to read paraShapeId`);
    }
    const basePsId = secRaw.readUInt16LE(hit.paraHeaderRec.dataOff + 8);
    const psBodies = readParaShapeBodies(diRaw);
    if (basePsId >= psBodies.length) {
      throw new Error(`${op.type}: basePsId ${basePsId} out of range (have ${psBodies.length})`);
    }
    const base = psBodies[basePsId];

    let headingId;
    if (kind === 2) {
      if (sharedNumberingId == null) { const r = appendNumberingToDocInfo(diRaw); diRaw = r.newDi; sharedNumberingId = r.newId; }
      headingId = sharedNumberingId;
    } else {
      if (sharedBulletId == null) { const r = appendBulletToDocInfo(diRaw); diRaw = r.newDi; sharedBulletId = r.newId; }
      headingId = sharedBulletId;
    }

    const newPsBody = buildParaShapeBody(base, { headingKind: kind, headingId });
    let newPsId = readParaShapeBodies(diRaw).findIndex((b) => b.equals(newPsBody));
    if (newPsId < 0) {
      const psRes = appendParaShapeToDocInfo(diRaw, newPsBody);
      diRaw = psRes.newDi;
      newPsId = psRes.newPsId;
    }
    secRaw = setParaHeaderShapeId(secRaw, hit.paraHeaderRec, newPsId);

    summary.push({ op: op.type, target: op.target, index: op.index, paraIdx: hit.paraIdx, basePsId, newPsId, headingId });
  }

  // Deflate + write DocInfo (mirror applyParagraphStyleInPlace).
  {
    const inMini = diInMini;
    const capacity = inMini ? diChain.length * mssz : diChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        diRaw, diChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        diChain = ext.newRegularChain;
        writeChainBytes(buf, diChain, ssz, ext.compressed);
        buf.writeInt32LE(diChain[0], diEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        diChain = ext.miniChain;
        writeMiniChainBytes(buf, diChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(diRaw, capacity, ssz, fat, fatAddrs, diChain, buf, false);
      buf = ext.buf; fat = ext.fat; diChain = ext.chain;
      writeChainBytes(buf, diChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    }
  }
  // Deflate + write Section0.
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', listed_count: summary.length });
}

// Build a 53-byte BORDER_FILL body with a solid background fill at the
// requested color. Borders are all type=0 (none) so the paragraph gets a
// flat color without 1px frame artifacts.
//
// Two byte patterns produce a working solid fill in Hancom Docs:
//   - 'rhwp'  (default): diagonal_type=0, size_marker=1 — the pattern
//             rhwp's `exportHwp()` writes for new documents.
//   - 'hancom': diagonal_type=1, size_marker=0 — the pattern Hancom
//             Office desktop writes when it saves a `.hwp` natively.
// Both render identically. Default to 'rhwp'. Debug callers can opt
// into the Hancom-native pattern via `_bfPattern: 'hancom'`.
function buildBorderFillSolidBody(hexColor, pattern = 'rhwp') {
  const buf = Buffer.alloc(53);
  if (pattern === 'hancom') {
    buf.writeUInt8(0x01, 26);  // diagonal type=1
    // size_marker stays 0
  } else {
    // rhwp pattern: diagonal type stays 0, size_marker=1
    buf.writeUInt32LE(1, 48);
  }
  buf.writeUInt32LE(1, 32);           // fill_type = solid
  buf.writeUInt32LE(parseColorBGR(hexColor) >>> 0, 36);
  buf.writeUInt32LE(0x00999999, 40);  // pattern_color = #999999
  buf.writeInt32LE(-1, 44);           // pattern_type = -1
  return buf;
}

function appendBorderFillToDocInfo(diRaw, body) {
  let bfCount = 0;
  let lastBorderFillRecEnd = -1;
  let idMappingsDataOff = -1;
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_BORDER_FILL) {
      bfCount++;
      lastBorderFillRecEnd = r.dataOff + r.size;
    }
    if (r.tag === 17) idMappingsDataOff = r.dataOff;
  }
  if (idMappingsDataOff < 0) {
    throw new Error('HWPTAG_ID_MAPPINGS not found in DocInfo — file looks malformed');
  }
  const insertAt = lastBorderFillRecEnd >= 0 ? lastBorderFillRecEnd : diRaw.length;
  const header = buildRecordHeader(TAG_BORDER_FILL, 0, body.length);
  const newRec = Buffer.concat([header, body]);
  const newDi = Buffer.concat([
    diRaw.slice(0, insertAt),
    newRec,
    diRaw.slice(insertAt),
  ]);
  const off = idMappingsDataOff + ID_MAPPINGS_BORDER_FILL_OFFSET;
  if (off + 4 > newDi.length) {
    throw new Error('ID_MAPPINGS body too short to hold BORDER_FILL count');
  }
  const oldCount = newDi.readUInt32LE(off);
  newDi.writeUInt32LE(oldCount + 1, off);
  // Return the **1-based** ID for ParaShape references.
  // ParaShape.border_fill_id (and similar HWP BorderFill-reference
  // fields) are 1-based, with 0 reserved as the "no fill" sentinel,
  // even though the BorderFill array itself is stored 0-indexed.
  // Verified against a Hancom-Office-saved sample: a paragraph that
  // visibly renders the gray BorderFill at array index 1 carries
  // border_fill_id = 2 in its ParaShape — i.e. (id - 1) is the
  // array index. We mirror that convention.
  return { newDi, newBfId: bfCount + 1 };
}

// Read every HWPTAG_BORDER_FILL body in DocInfo, in document order. The
// array is 0-indexed; a cell/paragraph's 1-based borderFillId references
// element (id - 1). Mirrors readParaShapeBodies.
function readBorderFillBodies(diRaw) {
  const out = [];
  for (const r of walkRecords(diRaw)) {
    if (r.tag === TAG_BORDER_FILL) {
      out.push(diRaw.slice(r.dataOff, r.dataOff + r.size));
    }
  }
  return out;
}

// Merge a solid background fill into an EXISTING BorderFill body, preserving
// that body's border + diagonal styling. This is what makes cell shading
// safe: a table cell already references a BorderFill that draws its 4
// borders, so we must keep those bytes and only (re)write the fill block —
// otherwise the cell loses its borders and becomes a bare colored box.
//
// Layout: the border + diagonal block is a FIXED 32 bytes regardless of
// fill type —
//   [0-1]   attribute u16
//   [2-7]   left border    (type, width, COLORREF)
//   [8-13]  right border
//   [14-19] top border
//   [20-25] bottom border
//   [26-31] diagonal       (type, width, COLORREF)
// The fill block starts at offset 32 and its length depends on fill_type,
// so a cell with NO current fill has a shorter body. We therefore rebuild a
// full 53-byte body: copy [0..31] from the base, then append the same solid
// fill block buildBorderFillSolidBody emits (which the paragraph-shading
// path has verified renders in Hancom Docs).
function mergeSolidFillIntoBorderFillBody(baseBody, hexColor, pattern = 'rhwp') {
  const out = Buffer.alloc(53);
  // Preserve borders + diagonal. A valid BorderFill body is always >= 32
  // bytes (all four borders + diagonal are present even when "none"); the
  // Math.min guard is purely defensive against a malformed short record.
  baseBody.copy(out, 0, 0, Math.min(32, baseBody.length));
  // Solid fill block — identical to buildBorderFillSolidBody, EXCEPT we do
  // not touch the diagonal-type byte at offset 26 (that belongs to the
  // preserved border block above; the 'hancom' size_marker variant only
  // differs in offset 48).
  if (pattern !== 'hancom') {
    out.writeUInt32LE(1, 48);           // size_marker (rhwp pattern)
  }
  out.writeUInt32LE(1, 32);             // fill_type = solid
  out.writeUInt32LE(parseColorBGR(hexColor) >>> 0, 36);
  out.writeUInt32LE(0x00999999, 40);    // pattern_color = #999999
  out.writeInt32LE(-1, 44);             // pattern_type = -1
  return out;
}

// HWP border/diagonal line "종류" (type) enum. 0=none, 1=solid, then dashed/
// dotted/double. We expose the common few; others fall back to solid.
const LINE_TYPE = { none: 0, solid: 1, dash: 2, dashed: 2, dot: 3, dotted: 3, double: 4 };
// Byte offset of each border side inside a BorderFill body. Each side is 6
// bytes: type[+0], width[+1], color COLORREF[+2..+5].
const BORDER_SIDE_OFF = { left: 2, right: 8, top: 14, bottom: 20 };

// Set one or more cell borders, PRESERVING the body's fill + diagonal + the
// other sides. `sides` = 'all' or an array of 'left'|'right'|'top'|'bottom'.
// Default is a thin solid black line — the exact encoding existing Hancom
// table cells use for their visible grid (type=1, width=1, color=#000000).
function mergeBordersIntoBorderFillBody(baseBody, sides, hexColor = '#000000', lineType = 1, width = 1) {
  const out = Buffer.alloc(Math.max(baseBody.length, 32)); // ensure full border block
  baseBody.copy(out, 0);
  const color = parseColorBGR(hexColor) >>> 0;
  const list = (sides === 'all' || (Array.isArray(sides) && sides.includes('all')))
    ? ['left', 'right', 'top', 'bottom']
    : (Array.isArray(sides) ? sides : [sides]);
  for (const side of list) {
    const o = BORDER_SIDE_OFF[side];
    if (o == null) throw new Error(`set_cell_border: unknown side "${side}" (use left/right/top/bottom/all)`);
    out.writeUInt8(lineType & 0xFF, o);
    out.writeUInt8(width & 0xFF, o + 1);
    out.writeUInt32LE(color, o + 2);
  }
  return out;
}

// Diagonal direction → BorderFill attribute(u16) bits. The attribute carries
// two 3-bit diagonal fields (value 1 = basic straight diagonal) at bits 3-5
// and 6-8. Mapped here by the GLYPH each value actually RENDERS (capture-
// verified 2026-06-16), which is what users expect:
//   slash ／  (bottom-left→top-right)  → bit 3 = 0x08
//   backslash ＼ (top-left→bottom-right) → bit 6 = 0x40
//   x ╳ (both)                          → 0x48
// NOTE the field/glyph naming is counter-intuitive: 0x08 lives in the byte
// the HWP spec labels "BackSlash" yet Hancom draws it as ／, and the Hancom
// web `cell-style --diagonal backslash` likewise emits 0x08 (= ／). We name
// by rendered glyph, not the spec/tool label. The diagonal LINE at [26-31]
// (type/width/color via parseColorBGR) matches Hancom rendering byte-for-byte.
const DIAG_ATTR = { slash: 1 << 3, backslash: 1 << 6, x: (1 << 3) | (1 << 6), both: (1 << 3) | (1 << 6) };

// Set a cell diagonal (대각선), PRESERVING fill + borders. Writes the diagonal
// line at [26-31] (type/width/color) AND OR-s the direction bits into the
// attribute u16 [0-1]. `kind` = 'slash'(／) | 'backslash'(＼) | 'x'(╳).
function mergeDiagonalIntoBorderFillBody(baseBody, kind, hexColor = '#000000', lineType = 1, width = 1) {
  const out = Buffer.alloc(Math.max(baseBody.length, 32));
  baseBody.copy(out, 0);
  const bits = DIAG_ATTR[kind];
  if (bits == null) throw new Error(`set_cell_diagonal: unknown direction "${kind}" (use slash/backslash/x)`);
  out.writeUInt16LE((out.readUInt16LE(0) | bits) & 0xFFFF, 0); // attribute direction bits
  out.writeUInt8(lineType & 0xFF, 26);                          // diagonal line type
  out.writeUInt8(width & 0xFF, 27);                             // diagonal width
  // Diagonal color = standard COLORREF 0x00BBGGRR, SAME as the border/fill
  // fields (parseColorBGR). Capture-verified: #ff0000 must render red, which
  // needs 0x000000ff (BGR), not 0x00ff0000. (The Hancom-web cell-style GT
  // happens to store it straight-RGB = its own R↔B quirk that renders the
  // wrong color; we don't copy that — we store what renders correctly.)
  out.writeUInt32LE(parseColorBGR(hexColor) >>> 0, 28);         // diagonal color (BGR)
  return out;
}

// Rewrite PARA_HEADER body offset 8-9 (u16) with `newPsId`. Returns updated
// section buffer.
function setParaHeaderShapeId(secRaw, paraHeaderRec, newPsId) {
  if (paraHeaderRec.size < 10) return secRaw;
  const out = Buffer.from(secRaw);
  out.writeUInt16LE(newPsId & 0xFFFF, paraHeaderRec.dataOff + 8);
  return out;
}

// Locate a paragraph by its level-0 PARA_HEADER index. Returns the same
// shape as findTextRangeInSection but with start/end spanning the whole
// paragraph (so applyShadeAcrossParagraph can highlight the whole thing).
function findParagraphByIndexInSection(secRaw, targetIdx) {
  const records = parseRecords(secRaw);
  let paraIdx = -1;
  let curHeader = null;
  let curText = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) {
      paraIdx++;
      curHeader = r;
      curText = null;
    }
    if (paraIdx === targetIdx && r.tag === TAG_PARA_TEXT && curHeader && !curText) {
      curText = r;
    }
    if (paraIdx === targetIdx && r.tag === TAG_PARA_CHAR_SHAPE && r.level === 1 && curHeader) {
      const len = curText ? Math.floor(curText.size / 2) : 0;
      return {
        paraIdx,
        paraHeaderRec: curHeader,
        paraTextRec: curText,
        paraCharShapeRec: r,
        start: 0,
        end: len,
        textLength: len,
      };
    }
    if (paraIdx > targetIdx) break;
  }
  return null;
}

// Apply shadeColor across ALL chars in a paragraph. Mirrors the
// "auto char shadeColor when background_color is set" pattern from Phase
// A's apply_paragraph_style (create.js:1241-1258) — Hancom expects per-char
// shade to coexist with paragraph fill so the page-margin grid doesn't
// bleed through. Returns { diRaw, secRaw, deltaCharShapes }.
function applyShadeAcrossParagraph(diRaw, secRaw, hit, hexColor) {
  if (!hit.paraCharShapeRec || hit.textLength === 0) {
    return { diRaw, secRaw, deltaCharShapes: 0 };
  }
  const baseCsId = csIdAtOffset(hit.paraCharShapeRec, secRaw, 0);
  const csBodies = readCharShapeBodies(diRaw);
  if (baseCsId >= csBodies.length) {
    throw new Error(`apply_paragraph_style: baseCsId ${baseCsId} out of range (have ${csBodies.length})`);
  }
  const newBody = buildCharShapeBody(csBodies[baseCsId], { highlight: hexColor });
  let newCsId = csBodies.findIndex(b => b.equals(newBody));
  if (newCsId < 0) {
    const r = appendCharShapeToDocInfo(diRaw, newBody);
    diRaw = r.newDi;
    newCsId = r.newCsId;
  }
  const csUpd = updateParaCharShapeRange(
    secRaw, hit.paraCharShapeRec,
    0, hit.textLength, newCsId,
  );
  return { diRaw, secRaw: csUpd.secRaw, deltaCharShapes: csUpd.deltaEntries };
}

// Convert apply_paragraph_style op props into the internal style shape used
// by buildParaShapeBody. Mirrors create.js:1323 buildParaFormatProps but
// only emits the fields raw-patch supports (no borders / no page-break /
// no keep flags — those still need rhwp emit).
function normalizeParaStyleOp(op) {
  const style = {};
  if (op.align != null || op.alignment != null) {
    style.alignment = op.alignment ?? op.align;
  }
  if (op.line_spacing != null) {
    style.lineSpacing = op.line_spacing;
  } else if (op.lineSpacing != null) {
    style.lineSpacing = op.lineSpacing;
  }
  if (op.line_spacing_type != null || op.lineSpacingType != null) {
    style.lineSpacingType = op.lineSpacingType ?? op.line_spacing_type;
  }
  if (op.indent != null) style.indent = op.indent;
  if (op.margin_left != null) style.marginLeft = op.margin_left;
  else if (op.marginLeft != null) style.marginLeft = op.marginLeft;
  if (op.margin_right != null) style.marginRight = op.margin_right;
  else if (op.marginRight != null) style.marginRight = op.marginRight;
  if (op.spacing_before != null) style.spacingBefore = op.spacing_before;
  else if (op.spacingBefore != null) style.spacingBefore = op.spacingBefore;
  if (op.spacing_after != null) style.spacingAfter = op.spacing_after;
  else if (op.spacingAfter != null) style.spacingAfter = op.spacingAfter;
  return style;
}

function resolveBackgroundColor(op) {
  const v = op.background_color ?? op.backgroundColor ?? op.fillColor;
  if (v == null || v === false) return null;
  if (v === true) return '#ffff00';
  return v;
}

const HWPUNIT_PER_MM = 283.46;
// Cell vertical alignment — LIST_HEADER attribute(u32 @ offset 2) bits 21-22.
// GT-confirmed: h22 cells default to middle (0x00200000); valign bottom →
// 0x00400000; the merged top cells sit at 0x00000000 (top). So top=0/middle=1/
// bottom=2 in those 2 bits.
const CELL_VALIGN = { top: 0, middle: 1, center: 1, bottom: 2 };

/**
 * Apply table-cell properties (vertical align / height / width / inner margins)
 * to existing `.hwp` cells via raw-patch. Patches the cell's LIST_HEADER body
 * directly in Section0 — NO DocInfo change.
 *
 * Op `set_cell_property`: `{ section?, para?, control?, row, col, valign?,
 *   height_mm?, width_mm?, margin_mm? | margins?:[l,r,t,b] }`. Addressing matches
 *   set_cell_text. LIST_HEADER layout (GT-confirmed): attr@2 (valign bits 21-22),
 *   width@16 / height@20 (u32 HWPUNIT = mm×283.46), margins L/R/T/B@24/26/28/30
 *   (u16 HWPUNIT). Section 0 only.
 */
export async function applyCellPropertyInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) {
      throw new Error(`set_cell_property: only section 0 is supported (got section ${op.section})`);
    }
    const has = op.valign != null || op.height_mm != null || op.width_mm != null || op.margin_mm != null || Array.isArray(op.margins) || op.header != null;
    if (!has) throw new Error('set_cell_property: at least one of valign / height_mm / width_mm / margin_mm / header is required');
    if (op.valign != null && CELL_VALIGN[String(op.valign).toLowerCase()] == null) {
      throw new Error(`set_cell_property: valign must be top / middle / bottom (got "${op.valign}")`);
    }
  }
  const resolved = await resolveCellIndexes(filePath, ops);

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };
  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const mm = (v) => Math.round(v * HWPUNIT_PER_MM);
  const summary = [];
  for (const e of resolved) {
    const para = e.para ?? 0, ctrl = e.control ?? 0;
    const records = parseRecords(secRaw);
    const loc = locateCell(records, para, ctrl, e.cellIndex);
    const o = records[loc.listHeaderRec].dataOff;
    // Self-check the cell-attr layout (col@8 / row@10) before patching.
    if (secRaw.readUInt16LE(o + 8) !== e.col || secRaw.readUInt16LE(o + 10) !== e.row) {
      throw new Error(`set_cell_property: cell-attr layout mismatch at (${e.row},${e.col}) — refusing to patch`);
    }
    if (e.valign != null) {
      const v = CELL_VALIGN[String(e.valign).toLowerCase()];
      const attr = secRaw.readUInt32LE(o + 2);
      secRaw.writeUInt32LE(((attr & ~(0x3 << 21)) | (v << 21)) >>> 0, o + 2);
    }
    if (e.width_mm != null) secRaw.writeUInt32LE(mm(e.width_mm) >>> 0, o + 16);
    if (e.height_mm != null) secRaw.writeUInt32LE(mm(e.height_mm) >>> 0, o + 20);
    const margins = Array.isArray(e.margins) ? e.margins
      : (e.margin_mm != null ? [e.margin_mm, e.margin_mm, e.margin_mm, e.margin_mm] : null);
    if (margins) for (let i = 0; i < 4; i++) secRaw.writeUInt16LE(mm(margins[i]) & 0xFFFF, o + 24 + i * 2);
    // Header / title cell (제목 셀): LIST_HEADER offset 6 (u16). GT-confirmed
    // (gt_title: claw-hancomdocs table-cell-prop --title-cell, .hwp download) —
    // base 0 → 4 (bit 2). On the top row this is HWP's repeat-header-row behavior.
    if (e.header != null) secRaw.writeUInt16LE(e.header ? 4 : 0, o + 6);
    summary.push({ op: e.type, para, control: ctrl, cellIndex: e.cellIndex, row: e.row, col: e.col,
      valign: e.valign ?? null, height_mm: e.height_mm ?? null, width_mm: e.width_mm ?? null, header: e.header ?? null });
  }

  // Deflate + write Section0 (only fixed-width fields changed → size unchanged).
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}

// ── 표 바깥 여백 (table outer margin) raw-patch ──────────────────────────────
//
// GT-first (gt_margin: claw-hancomdocs `table-cell-prop --table-margin "5,5,3,3"`
// applied in 한컴 web, downloaded as .hwp — NOT converted from .hwpx). The table's
// outer margin lives in the table CTRL_HEADER (tag 0x47, ctrl_id " lbt" = "tbl "
// reversed in-stream, body size 46). In-record offset 28/30/32/34 = u16
// left/right/top/bottom in HWPUNIT (mm × 283.46). Default 283 (=1mm) all sides;
// GT 5,5,3,3mm → 1417,1417,850,850 (exact byte match vs Hancom). Length-preserving
// fixed-width edit, Section 0 only. (Verify long+short docs Tier-1 both — CFB path
// differs.)
//
// Each op: { table_index?, margins?:[l,r,t,b] | margin_mm? }.
const TABLE_CTRL_ID = ' lbt'; // "tbl " stored reversed (little-endian ctrl_id)
const TABLE_OUTMARGIN_OFF = 28; // in-record offset of the 4 outer-margin u16s
// Page-split mode = TABLE record (0x4d) attribute bits 0-1. GT-confirmed
// (claw-hancomdocs table-cell-prop --page-split, .hwp download): none→0,
// cell→1, table→2 (table == the default). 한컴 spec: 0 나누지않음 / 1 셀단위로나눔 / 2 나눔.
const TABLE_PAGE_SPLIT = { none: 0, cell: 1, table: 2 };
// Text-wrap / placement = bits in the gso/table CTRL_HEADER attribute (offset 4).
// mask 0x600001 = bit0 (글자처럼 취급 / like-char) + bits 21-22 (float wrap mode).
// inline (글자처럼) = ONLY the like-char bit (0x1); the wrap-mode bits stay 0 because
// an inline object doesn't wrap text. The float modes clear like-char and set the
// 2-bit wrap (square 00 / topbottom 01 / behind 10 / front 11).
// ⚠️ inline was 0x200001 (like-char + an errant topbottom bit) — GT (a chart set to
// 글자처럼 in Hancom + downloaded, and insert_image's $pic) both encode inline as a
// bare 0x1. The stray bit 21 made a terminal-paragraph OLE chart render blank; 0x1
// renders everywhere (verified). Only the attribute changes (record size unchanged).
const TABLE_WRAP_MASK = 0x600001;
const TABLE_WRAP = { inline: 0x1, square: 0x0, topbottom: 0x200000, behind: 0x400000, front: 0x600000 };

// Each table = its CTRL_HEADER (" lbt", outer margin) + the TABLE record (0x4d,
// rows/cols/attr) that follows it. Return both so one op can patch either.
function findTables(records, secRaw) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_CTRL_HEADER && r.level === 1 && r.size >= TABLE_OUTMARGIN_OFF + 8
        && secRaw.slice(r.dataOff, r.dataOff + 4).toString('latin1') === TABLE_CTRL_ID) {
      let table = null;
      for (let j = i + 1; j < records.length; j++) {
        const rj = records[j];
        if (rj.tag === TAG_PARA_HEADER && rj.level === 0) break;
        if (rj.tag === TAG_CTRL_HEADER && rj.level === 1) break;
        if (rj.tag === TAG_TABLE) { table = rj; break; }
      }
      out.push({ ctrl: r, table });
    }
  }
  return out;
}

export async function applyTablePropertyInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`set_table_property: only section 0 is supported (got ${op.section})`);
    if (!Array.isArray(op.margins) && op.margin_mm == null && op.page_split == null && op.table_wrap == null) {
      throw new Error('set_table_property: margins:[l,r,t,b] / margin_mm / page_split / table_wrap is required');
    }
    if (Array.isArray(op.margins) && op.margins.length !== 4) {
      throw new Error('set_table_property: margins must be [left,right,top,bottom] (4 values, mm)');
    }
    if (op.page_split != null && TABLE_PAGE_SPLIT[String(op.page_split).toLowerCase()] == null) {
      throw new Error('set_table_property: page_split must be none / cell / table');
    }
    if (op.table_wrap != null && TABLE_WRAP[String(op.table_wrap).toLowerCase()] == null) {
      throw new Error('set_table_property: table_wrap must be inline / square / topbottom / behind / front');
    }
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };
  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const mm = (v) => Math.round(v * HWPUNIT_PER_MM);
  const summary = [];
  for (const op of ops) {
    const records = parseRecords(secRaw);
    const tables = findTables(records, secRaw);
    const idx = op.table_index ?? 0;
    if (idx < 0 || idx >= tables.length) {
      throw new Error(`set_table_property: table_index ${idx} out of range (found ${tables.length} table(s))`);
    }
    const { ctrl, table } = tables[idx];
    const rec = { op: 'set_table_property', table_index: idx };
    if (Array.isArray(op.margins) || op.margin_mm != null) {
      const o = ctrl.dataOff;
      const margins = Array.isArray(op.margins)
        ? op.margins
        : [op.margin_mm, op.margin_mm, op.margin_mm, op.margin_mm];
      for (let i = 0; i < 4; i++) secRaw.writeUInt16LE(mm(margins[i]) & 0xFFFF, o + TABLE_OUTMARGIN_OFF + i * 2);
      rec.margins_mm = margins;
    }
    if (op.page_split != null) {
      if (!table) throw new Error(`set_table_property: TABLE record not found for table_index ${idx}`);
      const v = TABLE_PAGE_SPLIT[String(op.page_split).toLowerCase()];
      const attr = secRaw.readUInt32LE(table.dataOff);
      secRaw.writeUInt32LE(((attr & ~0x3) | v) >>> 0, table.dataOff);
      rec.page_split = String(op.page_split).toLowerCase();
    }
    if (op.table_wrap != null) {
      const bits = TABLE_WRAP[String(op.table_wrap).toLowerCase()];
      const attr = secRaw.readUInt32LE(ctrl.dataOff + 4);
      secRaw.writeUInt32LE(((attr & ~TABLE_WRAP_MASK) | bits) >>> 0, ctrl.dataOff + 4);
      rec.table_wrap = String(op.table_wrap).toLowerCase();
    }
    summary.push(rec);
  }

  // Deflate + write Section0 (only fixed-width fields changed → size unchanged).
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}

// ── 객체(그림/도형) 속성 (object fill / border / outer margin) raw-patch ────
//
// GT-first (claw-hancomdocs object-prop --fill/--border/--border-width/--margin
// on a gso shape, downloaded as .hwp and diffed vs a round-trip baseline). A
// drawing object = a gso CTRL_HEADER (ctrl_id ' osg' = "gso " reversed, a
// CommonObjAttr like the table's ' lbt') followed by a SHAPE_COMPONENT (0x4c)
// that carries the inline fill + line. GT-confirmed offsets:
//   gso CTRL_HEADER  off 28-35 = outer margin, 4× u16 L/R/T/B HWPUNIT (same
//                                layout as the table outer margin)
//   SHAPE_COMPONENT  off 196 = border (line) color, u32 BGR (0x00BBGGRR)
//                    off 200 = border (line) width, u16 HWPUNIT
//                    off 213 = fill color, u32 BGR
// Verified: --fill #FF0000 → 0x000000FF @213, --border #0000FF → 0x00FF0000
// @196, --border-width 2mm → 566 @200, --margin 4mm → 1133×4 @28. Section 0 only.
//
// Each op: { object_index?, fill?, border_color?, border_width_mm?,
//            margins?:[l,r,t,b] | margin_mm? }.
const GSO_CTRL_ID = ' osg'; // "gso " stored reversed (little-endian ctrl_id)
const GSO_OUTMARGIN_OFF = 28;
// Object position (floating objects). GT-confirmed (object-prop --pos "80,120"):
// gso CTRL off8 = vertical offset (y), off12 = horizontal offset (x), u32 HWPUNIT.
const GSO_POS_Y_OFF = 8;
const GSO_POS_X_OFF = 12;
const COMP_BORDER_COLOR_OFF = 196;
const COMP_BORDER_WIDTH_OFF = 200;
const COMP_FILL_OFF = 213;
const COMP_FILL_ALPHA_OFF = 229; // fill transparency: alpha byte = round(t% × 255/100)
const COMP_BORDER_TYPE_OFF = 204; // line style byte = 0x40 | enum
// GT-confirmed (object-prop --border-type, .hwp download). claw-hancomdocs already
// corrects Hancom's UI dash↔dot combo swap, so these are the standard values —
// no swap needed here.
const BORDER_TYPE = {
  solid: 0x41, dotted: 0x42, dashed: 0x43, 'dash-dot': 0x44,
  'dash-dot-dot': 0x45, 'long-dash': 0x46, 'circle-dot': 0x47, double: 0x48,
};
const COMP_HATCH_COLOR_OFF = 217; // fill pattern (hatch) color, u32 BGR
const COMP_HATCH_STYLE_OFF = 221; // fill pattern (hatch) style, u32 (0xFFFFFFFF = none)
// GT-confirmed (object-prop --fill-pattern, .hwp download). 0xFFFFFFFF = solid (no
// hatch); 0-5 = hatch style.
const FILL_PATTERN = {
  horizontal: 0, vertical: 1, 'down-diagonal': 2, 'up-diagonal': 3, grid: 4, cross: 5,
};
// Line arrow endpoints (선 끝모양). GT-confirmed on a Hancom-native line: head
// style @205, tail style @206 (enum), and a flag byte @207 whose 0x10 bit = "has
// arrow". none 0 / triangle 1 / line 2 / sharp 3 / diamond 4 / circle 5 / square 6.
// (Arrows are a line/connector property — Hancom ignores them on closed shapes.)
const COMP_ARROW_HEAD_OFF = 205;
const COMP_ARROW_TAIL_OFF = 206;
const COMP_ARROW_FLAG_OFF = 207;
const ARROW_STYLE = { none: 0, triangle: 1, line: 2, sharp: 3, diamond: 4, circle: 5, square: 6 };

// Each drawing object = its gso CTRL_HEADER + the SHAPE_COMPONENT (0x4c) that
// immediately follows it (holds the inline fill/line).
function findGsoObjects(records, secRaw) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_CTRL_HEADER && r.level === 1 && r.size >= GSO_OUTMARGIN_OFF + 8
        && secRaw.slice(r.dataOff, r.dataOff + 4).toString('latin1') === GSO_CTRL_ID) {
      let comp = null;
      for (let j = i + 1; j < records.length; j++) {
        const rj = records[j];
        if (rj.tag === TAG_PARA_HEADER && rj.level === 0) break;
        if (rj.tag === TAG_CTRL_HEADER && rj.level === 1) break;
        if (rj.tag === TAG_SHAPE_COMPONENT) { comp = rj; break; }
      }
      out.push({ ctrl: r, comp });
    }
  }
  return out;
}

export async function applyObjectPropertyInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`set_object_property: only section 0 is supported (got ${op.section})`);
    const has = op.fill != null || op.border_color != null || op.border_width_mm != null
      || Array.isArray(op.margins) || op.margin_mm != null || op.wrap != null
      || op.fill_transparency != null || op.border_type != null || op.fill_pattern != null
      || op.arrow_start != null || op.arrow_end != null
      || op.pos_x_mm != null || op.pos_y_mm != null;
    if (!has) throw new Error('set_object_property: at least one of fill / border_color / border_width_mm / border_type / fill_pattern / arrow_start / arrow_end / margins / margin_mm / wrap / fill_transparency is required');
    for (const k of ['arrow_start', 'arrow_end']) {
      if (op[k] != null && ARROW_STYLE[String(op[k]).toLowerCase()] == null) {
        throw new Error(`set_object_property: ${k} must be one of ${Object.keys(ARROW_STYLE).join(' / ')}`);
      }
    }
    if (op.fill_transparency != null && (op.fill_transparency < 0 || op.fill_transparency > 100)) {
      throw new Error('set_object_property: fill_transparency must be 0-100');
    }
    if (op.border_type != null && BORDER_TYPE[String(op.border_type).toLowerCase()] == null) {
      throw new Error(`set_object_property: border_type must be one of ${Object.keys(BORDER_TYPE).join(' / ')}`);
    }
    if (op.fill_pattern != null && op.fill_pattern !== 'none' && FILL_PATTERN[String(op.fill_pattern).toLowerCase()] == null) {
      throw new Error(`set_object_property: fill_pattern must be 'none' or one of ${Object.keys(FILL_PATTERN).join(' / ')}`);
    }
    if (Array.isArray(op.margins) && op.margins.length !== 4) {
      throw new Error('set_object_property: margins must be [left,right,top,bottom] (4 values, mm)');
    }
    if (op.wrap != null && TABLE_WRAP[String(op.wrap).toLowerCase()] == null) {
      throw new Error('set_object_property: wrap must be inline / square / topbottom / behind / front');
    }
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };
  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const mm = (v) => Math.round(v * HWPUNIT_PER_MM);
  const summary = [];
  for (const op of ops) {
    const records = parseRecords(secRaw);
    const objs = findGsoObjects(records, secRaw);
    const idx = op.object_index ?? 0;
    if (idx < 0 || idx >= objs.length) {
      throw new Error(`set_object_property: object_index ${idx} out of range (found ${objs.length} drawing object(s))`);
    }
    const { ctrl, comp } = objs[idx];
    const rec = { op: 'set_object_property', object_index: idx };
    if (Array.isArray(op.margins) || op.margin_mm != null) {
      const margins = Array.isArray(op.margins)
        ? op.margins
        : [op.margin_mm, op.margin_mm, op.margin_mm, op.margin_mm];
      for (let i = 0; i < 4; i++) secRaw.writeUInt16LE(mm(margins[i]) & 0xFFFF, ctrl.dataOff + GSO_OUTMARGIN_OFF + i * 2);
      rec.margins_mm = margins;
    }
    if (op.pos_x_mm != null) { secRaw.writeUInt32LE(mm(op.pos_x_mm) >>> 0, ctrl.dataOff + GSO_POS_X_OFF); rec.pos_x_mm = op.pos_x_mm; }
    if (op.pos_y_mm != null) { secRaw.writeUInt32LE(mm(op.pos_y_mm) >>> 0, ctrl.dataOff + GSO_POS_Y_OFF); rec.pos_y_mm = op.pos_y_mm; }
    if (op.wrap != null) {
      // Object text-wrap = the gso CTRL_HEADER attribute, GT-confirmed to use the
      // SAME bit field as the table (mask 0x600001: bit0 like-char + bits 21-22).
      const bits = TABLE_WRAP[String(op.wrap).toLowerCase()];
      const attr = secRaw.readUInt32LE(ctrl.dataOff + 4);
      secRaw.writeUInt32LE(((attr & ~TABLE_WRAP_MASK) | bits) >>> 0, ctrl.dataOff + 4);
      rec.wrap = String(op.wrap).toLowerCase();
    }
    if (op.fill != null || op.border_color != null || op.border_width_mm != null
        || op.fill_transparency != null || op.border_type != null || op.fill_pattern != null
        || op.arrow_start != null || op.arrow_end != null) {
      if (!comp) throw new Error(`set_object_property: no SHAPE_COMPONENT for object ${idx} (fill/border need a shape)`);
      if (op.arrow_start != null) {
        secRaw.writeUInt8(ARROW_STYLE[String(op.arrow_start).toLowerCase()], comp.dataOff + COMP_ARROW_HEAD_OFF);
        rec.arrow_start = String(op.arrow_start).toLowerCase();
      }
      if (op.arrow_end != null) {
        secRaw.writeUInt8(ARROW_STYLE[String(op.arrow_end).toLowerCase()], comp.dataOff + COMP_ARROW_TAIL_OFF);
        rec.arrow_end = String(op.arrow_end).toLowerCase();
      }
      if (op.arrow_start != null || op.arrow_end != null) {
        const head = secRaw.readUInt8(comp.dataOff + COMP_ARROW_HEAD_OFF);
        const tail = secRaw.readUInt8(comp.dataOff + COMP_ARROW_TAIL_OFF);
        let flag = secRaw.readUInt8(comp.dataOff + COMP_ARROW_FLAG_OFF);
        flag = (head || tail) ? (flag | 0x10) : (flag & ~0x10);
        secRaw.writeUInt8(flag & 0xFF, comp.dataOff + COMP_ARROW_FLAG_OFF);
      }
      if (op.border_type != null) {
        secRaw.writeUInt8(BORDER_TYPE[String(op.border_type).toLowerCase()], comp.dataOff + COMP_BORDER_TYPE_OFF);
        rec.border_type = String(op.border_type).toLowerCase();
      }
      if (op.fill_pattern != null) {
        const style = op.fill_pattern === 'none' ? 0xFFFFFFFF : FILL_PATTERN[String(op.fill_pattern).toLowerCase()];
        secRaw.writeUInt32LE(style >>> 0, comp.dataOff + COMP_HATCH_STYLE_OFF);
        if (op.fill_pattern_color != null) {
          secRaw.writeUInt32LE(parseColorBGR(op.fill_pattern_color) >>> 0, comp.dataOff + COMP_HATCH_COLOR_OFF);
        }
        rec.fill_pattern = String(op.fill_pattern).toLowerCase();
      }
      if (op.fill != null && op.fill !== 'none') {
        secRaw.writeUInt32LE(parseColorBGR(op.fill) >>> 0, comp.dataOff + COMP_FILL_OFF);
        rec.fill = op.fill;
      }
      if (op.border_color != null) {
        secRaw.writeUInt32LE(parseColorBGR(op.border_color) >>> 0, comp.dataOff + COMP_BORDER_COLOR_OFF);
        rec.border_color = op.border_color;
      }
      if (op.border_width_mm != null) {
        secRaw.writeUInt16LE(mm(op.border_width_mm) & 0xFFFF, comp.dataOff + COMP_BORDER_WIDTH_OFF);
        rec.border_width_mm = op.border_width_mm;
      }
      // Fill transparency (0-100%): alpha byte = round(t × 255/100). GT-confirmed
      // (--fill-transparency 60 → 153 @229). 0 = opaque.
      if (op.fill_transparency != null) {
        secRaw.writeUInt8(Math.round(op.fill_transparency * 255 / 100) & 0xFF, comp.dataOff + COMP_FILL_ALPHA_OFF);
        rec.fill_transparency = op.fill_transparency;
      }
    }
    summary.push(rec);
  }

  // Deflate + write Section0 (only fixed-width fields changed → size unchanged).
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}

// ── 셀 너비/높이 같게 (equalize table columns / rows) raw-patch ────────────
//
// GT-first (eqw_1row.hwp, table-op equal-width on a single-row table): making
// a uniform table's columns equal is a clean width set — each column becomes
// tableWidth / cols, total preserved (verified: 19567+28623 → 24095+24095).
// No re-grid: re-gridding (column-boundary union) only happens when a PARTIAL
// selection misaligns rows; equalizing the WHOLE table keeps every row
// aligned, so it stays a length-preserving LIST_HEADER width@16 / height@20
// edit. Merged cells get span × the equal unit. Section0-only, no DocInfo.
//
// Each op: { section?, para?, control?, dim: 'width'|'height' }.
export async function equalizeTableInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', equalized_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`equalize_table: only section 0 is supported (got ${op.section})`);
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };
  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0;
    const dim = op.dim === 'height' ? 'height' : 'width';
    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const rows = secRaw.readUInt16LE(tableRec.dataOff + 4);
    const cols = secRaw.readUInt16LE(tableRec.dataOff + 6);
    const cells = tableCellRecords(records, secRaw, para, ctrl);

    if (dim === 'width') {
      // Total = sum of widths of the cells in row 0 (covers all columns).
      let total = 0;
      for (const c of cells) if (c.row === 0) total += secRaw.readUInt32LE(c.lhDataOff + 16);
      if (cols < 1 || total < 1) { summary.push({ para, control: ctrl, dim, cols, skipped: true }); continue; }
      const unit = Math.floor(total / cols);
      const rem = total - unit * cols; // give the remainder to the last column
      for (const c of cells) {
        let w = c.colSpan * unit;
        if (c.col + c.colSpan >= cols) w += rem;
        secRaw.writeUInt32LE(w >>> 0, c.lhDataOff + 16);
      }
      summary.push({ para, control: ctrl, dim, cols, unit });
    } else {
      let total = 0;
      for (const c of cells) if (c.col === 0) total += secRaw.readUInt32LE(c.lhDataOff + 20);
      if (rows < 1 || total < 1) { summary.push({ para, control: ctrl, dim, rows, skipped: true }); continue; }
      const unit = Math.floor(total / rows);
      const rem = total - unit * rows;
      for (const c of cells) {
        let h = c.rowSpan * unit;
        if (c.row + c.rowSpan >= rows) h += rem;
        secRaw.writeUInt32LE(h >>> 0, c.lhDataOff + 20);
      }
      summary.push({ para, control: ctrl, dim, rows, unit });
    }
  }

  // Deflate + write Section0 (length-preserving — only width/height fields).
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', equalized_count: summary.length });
}

// The TAG_TABLE record (table grid: rows, cols, and the per-row cell-count
// array at body offset 18) for the table at (sectionParaIdx, controlIdx).
function findTableRecord(records, sectionParaIdx, controlIdx) {
  let para = -1, start = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag === TAG_PARA_HEADER && records[i].level === 0) { para++; if (para === sectionParaIdx) { start = i; break; } }
  }
  if (start < 0) throw new Error(`merge_cells: paragraph ${sectionParaIdx} not found`);
  let ctrl = -1, tStart = -1;
  for (let i = start + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break;
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) { ctrl++; if (ctrl === controlIdx) { tStart = i; break; } }
  }
  if (tStart < 0) throw new Error(`merge_cells: control ${controlIdx} not found`);
  for (let i = tStart + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break;
    if (r.tag === TAG_TABLE && r.level === 2) return r;
  }
  throw new Error('merge_cells: TABLE record not found');
}

// Byte range [startByte, endByte) of one cell's whole cluster (its level-2
// LIST_HEADER record + the cell's paragraphs) — i.e. up to the next cell's
// LIST_HEADER, or the end of the table.
function cellClusterByteRange(records, secRaw, sectionParaIdx, controlIdx, cellIndex) {
  const loc = locateCell(records, sectionParaIdx, controlIdx, cellIndex);
  const lhIdx = loc.listHeaderRec;
  const startByte = records[lhIdx].headOff;
  let endByte = secRaw.length;
  for (let i = lhIdx + 1; i < records.length; i++) {
    const r = records[i];
    if ((r.tag === TAG_PARA_HEADER && r.level === 0) ||
        (r.tag === TAG_CTRL_HEADER && r.level === 1) ||
        (r.tag === TAG_LIST_HEADER && r.level === 2)) { endByte = r.headOff; break; }
  }
  return { startByte, endByte };
}

// Enumerate every cell of the table at (paraIdx, ctrlIdx): its grid address
// (col@8, row@10, colSpan@12, rowSpan@14), the LIST_HEADER body offset, and the
// cluster byte range [startByte, endByte) (LIST_HEADER + the cell's paragraphs).
function tableCellRecords(records, secRaw, sectionParaIdx, controlIdx) {
  let para = -1, start = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].tag === TAG_PARA_HEADER && records[i].level === 0) { para++; if (para === sectionParaIdx) { start = i; break; } }
  }
  if (start < 0) throw new Error(`paragraph ${sectionParaIdx} not found`);
  let ctrl = -1, tStart = -1;
  for (let i = start + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) break;
    if (r.tag === TAG_CTRL_HEADER && r.level === 1) { ctrl++; if (ctrl === controlIdx) { tStart = i; break; } }
  }
  if (tStart < 0) throw new Error(`control ${controlIdx} not found in paragraph ${sectionParaIdx}`);
  // table end = next level-0 PARA_HEADER or level-1 CTRL_HEADER
  let tEnd = records.length;
  for (let i = tStart + 1; i < records.length; i++) {
    const r = records[i];
    if ((r.tag === TAG_PARA_HEADER && r.level === 0) || (r.tag === TAG_CTRL_HEADER && r.level === 1)) { tEnd = i; break; }
  }
  const lhIdxs = [];
  for (let i = tStart + 1; i < tEnd; i++) if (records[i].tag === TAG_LIST_HEADER && records[i].level === 2) lhIdxs.push(i);
  return lhIdxs.map((recIdx, k) => {
    const r = records[recIdx];
    const nextHead = k + 1 < lhIdxs.length ? records[lhIdxs[k + 1]].headOff : (tEnd < records.length ? records[tEnd].headOff : secRaw.length);
    return {
      recIdx, lhDataOff: r.dataOff,
      col: secRaw.readUInt16LE(r.dataOff + 8), row: secRaw.readUInt16LE(r.dataOff + 10),
      colSpan: secRaw.readUInt16LE(r.dataOff + 12), rowSpan: secRaw.readUInt16LE(r.dataOff + 14),
      startByte: r.headOff, endByte: nextHead,
    };
  });
}

/**
 * Delete a whole table row (`delete_table_row`) from an existing `.hwp` via
 * raw-patch. Op: `{ section?, para?, control?, row }`. GT-confirmed: TABLE
 * rows−1 + its row-size array entry for `row` removed (record shrinks), the
 * row's cell clusters deleted, every cell below renumbered (row−1), and any
 * cell vertically spanning across the deleted row has its rowSpan−1. A cell
 * that *starts* in the deleted row with rowSpan>1 is rejected (unmerge first).
 * Section 0 only.
 */
export async function deleteTableRowInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', deleted_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`delete_table_row: only section 0 supported (got ${op.section})`);
    if (!Number.isInteger(op.row)) throw new Error("delete_table_row: 'row' (integer) is required");
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0, delRow = op.row;
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const rows = secRaw.readUInt16LE(tableRec.dataOff + 4);
    if (delRow < 0 || delRow >= rows) throw new Error(`delete_table_row: row ${delRow} out of range (table has ${rows} rows)`);
    const cells = tableCellRecords(records, secRaw, para, ctrl);

    const removeRanges = [];
    for (const c of cells) {
      if (c.row === delRow) {
        if (c.rowSpan > 1) throw new Error(`delete_table_row: cell (${c.row},${c.col}) spans down (rowSpan ${c.rowSpan}) through row ${delRow} — unmerge first`);
        removeRanges.push({ startByte: c.startByte, endByte: c.endByte });
      } else if (c.row < delRow && c.row + c.rowSpan > delRow) {
        secRaw.writeUInt16LE((c.rowSpan - 1) & 0xFFFF, c.lhDataOff + 14); // spans across → rowSpan−1
      } else if (c.row > delRow) {
        secRaw.writeUInt16LE((c.row - 1) & 0xFFFF, c.lhDataOff + 10);     // below → row−1
      }
    }

    // Rebuild the TABLE record: rows−1, drop the deleted row's row-size entry.
    const oldBody = secRaw.slice(tableRec.dataOff, tableRec.dataOff + tableRec.size);
    const cut = 18 + delRow * 2;
    const newBody = Buffer.concat([oldBody.slice(0, cut), oldBody.slice(cut + 2)]);
    newBody.writeUInt16LE((rows - 1) & 0xFFFF, 4);
    const newTableRec = Buffer.concat([buildRecordHeader(TAG_TABLE, 2, newBody.length), newBody]);

    // Apply all splices high→low so earlier offsets stay valid (TABLE record is
    // at the lowest offset, so it's applied last). Renumber writes above were
    // in-place on survivor cells (preserved through the concats).
    const splices = [
      { start: tableRec.headOff, end: tableRec.dataOff + tableRec.size, repl: newTableRec },
      ...removeRanges.map((r) => ({ start: r.startByte, end: r.endByte, repl: Buffer.alloc(0) })),
    ].sort((a, b) => b.start - a.start);
    for (const s of splices) secRaw = Buffer.concat([secRaw.slice(0, s.start), s.repl, secRaw.slice(s.end)]);

    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, row: delRow, removed: removeRanges.length });
  }
  return Object.assign(summary, { mode: 'in-place', deleted_count: summary.length });
}

/**
 * Split one table cell into N stacked rows (`split_cell`) in an existing
 * `.hwp` via raw-patch. Op: `{ section?, para?, control?, row, col, into_rows? }`
 * (into_rows default 2). GT-confirmed (Hancom 셀 나누기, 3 samples): the cell
 * keeps its content as the top piece; N−1 new blank cells appear below it in
 * the same column; every OTHER cell in the row grows rowSpan by N−1 to keep the
 * grid rectangular; the table gains N−1 rows (each new row-size entry = 1, since
 * only the split column has a fresh cell there); cells below are renumbered.
 * Only a plain 1×1 cell can be split. Section 0 only. (Vertical split only —
 * the Hancom tool emits this regardless of its row/col args.)
 */
export async function splitCellInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', split_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`split_cell: only section 0 supported (got ${op.section})`);
    if (!Number.isInteger(op.row) || !Number.isInteger(op.col)) throw new Error("split_cell: 'row' and 'col' (integers) are required");
    if (op.into_rows != null && (!Number.isInteger(op.into_rows) || op.into_rows < 2)) throw new Error('split_cell: into_rows must be an integer ≥ 2');
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0, R = op.row, C = op.col, N = op.into_rows ?? 2;
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const rows = secRaw.readUInt16LE(tableRec.dataOff + 4);
    const cells = tableCellRecords(records, secRaw, para, ctrl);
    const target = cells.find((c) => c.row === R && c.col === C);
    if (!target) throw new Error(`split_cell: cell (${R},${C}) not found`);
    if (target.colSpan > 1 || target.rowSpan > 1) throw new Error(`split_cell: cell (${R},${C}) is merged (${target.colSpan}×${target.rowSpan}) — only a plain 1×1 cell can be split`);

    // other cells in the same row grow rowSpan by N−1 (keep grid rectangular)
    for (const c of cells) if (c.row === R && c.col !== C) secRaw.writeUInt16LE((c.rowSpan + N - 1) & 0xFFFF, c.lhDataOff + 14);
    // cells below shift down
    for (const c of cells) if (c.row > R) secRaw.writeUInt16LE((c.row + N - 1) & 0xFFFF, c.lhDataOff + 10);

    // N−1 new blank cells at (R+1..R+N−1, C), cloned from an empty cell in col C
    const make = cellCloner(cells, secRaw, C);
    if (!make) throw new Error(`split_cell: no plain 1×1 cell to clone for the new cell(s)`);
    const newCells = [];
    for (let k = 1; k < N; k++) newCells.push(make(R + k, C));
    const newCellsBuf = Buffer.concat(newCells);
    let insOff = null;
    for (const c of cells) { if (c.row >= R + 1) { insOff = c.startByte; break; } }
    if (insOff == null) insOff = cells.length ? cells[cells.length - 1].endByte : (tableRec.dataOff + tableRec.size);

    // TABLE: rows + (N−1); insert (N−1) row-size entries (=1) at index R+1
    const oldBody = secRaw.slice(tableRec.dataOff, tableRec.dataOff + tableRec.size);
    const insAt = 18 + (R + 1) * 2;
    const rsEntries = Buffer.alloc((N - 1) * 2); for (let k = 0; k < N - 1; k++) rsEntries.writeUInt16LE(1, k * 2);
    const newBody = Buffer.concat([oldBody.slice(0, insAt), rsEntries, oldBody.slice(insAt)]);
    newBody.writeUInt16LE((rows + N - 1) & 0xFFFF, 4);
    const newTableRec = Buffer.concat([buildRecordHeader(TAG_TABLE, 2, newBody.length), newBody]);

    const splices = [
      { start: insOff, end: insOff, repl: newCellsBuf },
      { start: tableRec.headOff, end: tableRec.dataOff + tableRec.size, repl: newTableRec },
    ].sort((a, b) => b.start - a.start);
    for (const s of splices) secRaw = Buffer.concat([secRaw.slice(0, s.start), s.repl, secRaw.slice(s.end)]);

    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, row: R, col: C, into_rows: N });
  }
  return Object.assign(summary, { mode: 'in-place', split_count: summary.length });
}

// True if a cell cluster holds just an empty paragraph (PARA_HEADER text_count
// ≤ 1 = the EOP terminator only) — safe to clone as a fresh blank cell.
function isEmptyCellCluster(clusterBytes) {
  for (const r of parseRecords(clusterBytes)) {
    if (r.tag === TAG_PARA_HEADER && r.level === 2) {
      return (clusterBytes.readUInt32LE(r.dataOff) & 0x7FFFFFFF) <= 1;
    }
  }
  return false;
}

// Clone a cell cluster, overwriting its LIST_HEADER grid address (col@8, row@10).
function cloneCellCluster(clusterBytes, newRow, newCol) {
  const out = Buffer.from(clusterBytes);
  const lh = parseRecords(out).find((r) => r.tag === TAG_LIST_HEADER && r.level === 2);
  if (!lh) throw new Error('cloneCellCluster: no LIST_HEADER in cluster');
  out.writeUInt16LE(newCol & 0xFFFF, lh.dataOff + 8);
  out.writeUInt16LE(newRow & 0xFFFF, lh.dataOff + 10);
  return out;
}

// Build a blank cell by cloning a cell (even a non-empty one) and stripping it
// down to a single empty paragraph — the FALLBACK for a fully-populated table
// with no empty 1×1 cell to clone. Keeps the source cell's width/borderFill (so
// the new cell matches its column) but reduces its content to one empty
// paragraph (char_count 1 = just the 0x000d EOP) so the result satisfies
// isEmptyCellCluster. nParagraphs→1, col@8/row@10 rewritten to (newRow, newCol);
// the first paragraph's PARA_CHAR_SHAPE / PARA_LINE_SEG are kept (so the cell
// looks like a real Hancom cell — line layout is recomputed on render).
function emptyCellClusterFromClone(clusterBytes, newRow, newCol) {
  const recs = parseRecords(clusterBytes);
  const lh = recs.find((r) => r.tag === TAG_LIST_HEADER && r.level === 2);
  if (!lh) throw new Error('emptyCellClusterFromClone: no LIST_HEADER in cluster');
  const phIdx = recs.findIndex((r) => r.tag === TAG_PARA_HEADER && r.level === 2 && r.headOff > lh.headOff);
  if (phIdx < 0) throw new Error('emptyCellClusterFromClone: no cell paragraph');
  // The first paragraph runs [phIdx, endIdx) — up to the next level-2 PARA_HEADER.
  let endIdx = recs.length;
  for (let i = phIdx + 1; i < recs.length; i++) { if (recs[i].tag === TAG_PARA_HEADER && recs[i].level === 2) { endIdx = i; break; } }
  const out = [];
  // LIST_HEADER record (verbatim) with nParagraphs→1 and the new grid address.
  const lhRec = Buffer.from(clusterBytes.slice(lh.headOff, recs[phIdx].headOff));
  const lhBody = lh.dataOff - lh.headOff;
  lhRec.writeUInt16LE(1, lhBody + 0);                 // nParagraphs = 1
  lhRec.writeUInt16LE(newCol & 0xFFFF, lhBody + 8);
  lhRec.writeUInt16LE(newRow & 0xFFFF, lhBody + 10);
  out.push(lhRec);
  // Keep ONLY the first paragraph, reduced to a real Hancom EMPTY-cell shape:
  //   PARA_HEADER (char_count 1) + PARA_CHAR_SHAPE + PARA_LINE_SEG, NO PARA_TEXT.
  // A genuine empty cell paragraph OMITS the PARA_TEXT record entirely (just the
  // implicit 0x000d EOP) and keeps its line seg; emitting a PARA_TEXT or dropping
  // the line seg makes Hancom reject the file. The line seg is cloned from the
  // source cell (same column → right width); Hancom recomputes layout on open.
  for (let i = phIdx; i < endIdx; i++) {
    const r = recs[i];
    if (r.tag === TAG_PARA_TEXT) continue;               // omit — empty para has no text record
    const recBytes = Buffer.from(clusterBytes.slice(r.headOff, r.dataOff + r.size));
    const bodyOff = r.dataOff - r.headOff;
    if (r.tag === TAG_PARA_HEADER) {
      const flag = recBytes.readUInt32LE(bodyOff) & 0x80000000;
      recBytes.writeUInt32LE((flag | 1) >>> 0, bodyOff); // char_count = 1 (keep last-para flag)
      out.push(recBytes);
    } else {
      out.push(recBytes);                                 // PARA_CHAR_SHAPE / PARA_LINE_SEG as-is
    }
  }
  return Buffer.concat(out);
}

// Pick a cloneable 1×1 cell + a builder for a new blank cell. The source MUST
// carry the column's real width: rhwp emits header-row cells with a degenerate
// width (1 HWPUNIT), and dropping a width-1 cell into a DATA row makes Hancom
// reject the table as a grid-width mismatch (the data rows say the column is
// ~20977, the new row says 1). So we pick the WIDEST 1×1 cell in `preferCol`
// (the representative full-width cell), and clone it verbatim if it is already
// empty, else clone+empty it. Returns make(row,col) → Buffer, or null if the
// table has no plain 1×1 cell to clone.
function cellCloner(cells, secRaw, preferCol) {
  const width = (c) => secRaw.readUInt32LE(c.lhDataOff + 16);
  const oneByOne = cells.filter((c) => c.colSpan === 1 && c.rowSpan === 1);
  const inCol = oneByOne.filter((c) => c.col === preferCol);
  const pool = inCol.length ? inCol : oneByOne;
  if (!pool.length) return null;
  const src = pool.reduce((a, b) => (width(b) > width(a) ? b : a)); // widest = real column width
  const bytes = secRaw.slice(src.startByte, src.endByte);
  return isEmptyCellCluster(bytes)
    ? (row, col) => cloneCellCluster(bytes, row, col)
    : (row, col) => emptyCellClusterFromClone(bytes, row, col);
}

/**
 * Insert a blank table row (`insert_table_row`) into an existing `.hwp` via
 * raw-patch. Op: `{ section?, para?, control?, row, position? }` where
 * `position` = 'below' (default) or 'above' relative to `row`. GT-confirmed:
 * TABLE rows+1 with a new row-size entry (value = cols) inserted at the new
 * row's index (record grows), every cell at/after the new row renumbered
 * (row+1), and `cols` blank cell clusters synthesized and spliced in. Each
 * blank cell is cloned from an existing EMPTY 1×1 cell in that column (so it
 * inherits the right width/border), with its address rewritten — no record
 * field surgery. A column with no empty 1×1 cell to clone is rejected. Sec 0.
 */
export async function insertTableRowInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`insert_table_row: only section 0 supported (got ${op.section})`);
    if (!Number.isInteger(op.row)) throw new Error("insert_table_row: 'row' (integer) is required");
    if (op.position && op.position !== 'above' && op.position !== 'below') throw new Error("insert_table_row: position must be 'above' or 'below'");
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0;
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const rows = secRaw.readUInt16LE(tableRec.dataOff + 4);
    const cols = secRaw.readUInt16LE(tableRec.dataOff + 6);
    if (op.row < 0 || op.row >= rows) throw new Error(`insert_table_row: row ${op.row} out of range (table has ${rows} rows)`);
    const insertRow = (op.position ?? 'below') === 'below' ? op.row + 1 : op.row;
    const cells = tableCellRecords(records, secRaw, para, ctrl);

    // synthesize the new row's blank cells (clone an empty 1×1 cell per column)
    const newClusters = [];
    for (let c = 0; c < cols; c++) {
      const make = cellCloner(cells, secRaw, c);
      if (!make) throw new Error(`insert_table_row: no plain 1×1 cell in the table to clone as the new cell`);
      newClusters.push(make(insertRow, c));
    }
    const newCellsBuf = Buffer.concat(newClusters);

    // document insertion point: before the first cell at/after the new row.
    let insOff = null;
    for (const cc of cells) { if (cc.row >= insertRow) { insOff = cc.startByte; break; } }
    if (insOff == null) insOff = cells.length ? cells[cells.length - 1].endByte : (tableRec.dataOff + tableRec.size);

    // renumber cells at/after the new row (in-place, before splicing)
    for (const cc of cells) if (cc.row >= insertRow) secRaw.writeUInt16LE((cc.row + 1) & 0xFFFF, cc.lhDataOff + 10);

    // TABLE record: rows+1 and a new row-size entry (cols) at index insertRow.
    const oldBody = secRaw.slice(tableRec.dataOff, tableRec.dataOff + tableRec.size);
    const insAt = 18 + insertRow * 2;
    const entry = Buffer.alloc(2); entry.writeUInt16LE(cols, 0);
    const newBody = Buffer.concat([oldBody.slice(0, insAt), entry, oldBody.slice(insAt)]);
    newBody.writeUInt16LE((rows + 1) & 0xFFFF, 4);
    const newTableRec = Buffer.concat([buildRecordHeader(TAG_TABLE, 2, newBody.length), newBody]);

    const splices = [
      { start: insOff, end: insOff, repl: newCellsBuf },
      { start: tableRec.headOff, end: tableRec.dataOff + tableRec.size, repl: newTableRec },
    ].sort((a, b) => b.start - a.start);
    for (const s of splices) secRaw = Buffer.concat([secRaw.slice(0, s.start), s.repl, secRaw.slice(s.end)]);

    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, insertRow, added: cols });
  }
  return Object.assign(summary, { mode: 'in-place', inserted_count: summary.length });
}

/**
 * Insert a blank table column (`insert_table_col`) into an existing `.hwp` via
 * raw-patch. Op: `{ section?, para?, control?, col, position? }` where
 * `position` = 'right' (default) or 'left' relative to `col`. GT-confirmed:
 * TABLE cols+1, every cell to the right renumbered (col+1), a cell SPANNING
 * across the new column gets colSpan+1 (so a merged title cell grows and that
 * row gets no separate new cell), and every other row gets one blank cell
 * cloned at the new column. Blank cells are cloned from an existing empty 1×1
 * cell; a table with none is rejected. Section 0 only.
 */
export async function insertTableColInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', inserted_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`insert_table_col: only section 0 supported (got ${op.section})`);
    if (!Number.isInteger(op.col)) throw new Error("insert_table_col: 'col' (integer) is required");
    if (op.position && op.position !== 'left' && op.position !== 'right') throw new Error("insert_table_col: position must be 'left' or 'right'");
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0;
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const rows = secRaw.readUInt16LE(tableRec.dataOff + 4);
    const cols = secRaw.readUInt16LE(tableRec.dataOff + 6);
    if (op.col < 0 || op.col >= cols) throw new Error(`insert_table_col: col ${op.col} out of range (table has ${cols} cols)`);
    const newCol = (op.position ?? 'right') === 'right' ? op.col + 1 : op.col;
    const cells = tableCellRecords(records, secRaw, para, ctrl);

    // expand cells spanning across the new column; track which rows they cover.
    const covered = new Set();
    for (const c of cells) {
      if (c.col < newCol && c.col + c.colSpan > newCol) {
        secRaw.writeUInt16LE((c.colSpan + 1) & 0xFFFF, c.lhDataOff + 12);
        for (let rr = c.row; rr < c.row + c.rowSpan; rr++) covered.add(rr);
      }
    }
    // renumber cells to the right of the new column (in-place).
    for (const c of cells) if (c.col >= newCol) secRaw.writeUInt16LE((c.col + 1) & 0xFFFF, c.lhDataOff + 8);

    // one blank cell per uncovered row, at the new column.
    const inserts = [];
    for (let r = 0; r < rows; r++) {
      if (covered.has(r)) continue;
      // prefer an empty cell from the REFERENCE column (op.col) so the new
      // column inherits a sensible width; if the table has no empty 1×1 cell at
      // all, cellCloner clones any 1×1 cell and empties it.
      const make = cellCloner(cells, secRaw, op.col);
      if (!make) throw new Error(`insert_table_col: no plain 1×1 cell to clone for row ${r}`);
      const cluster = make(r, newCol);
      let off = null;
      for (const cc of cells) { if (cc.row === r && cc.col >= newCol) { off = cc.startByte; break; } }
      if (off == null) { const rc = cells.filter((cc) => cc.row === r); off = rc.length ? rc[rc.length - 1].endByte : (tableRec.dataOff + tableRec.size); }
      inserts.push({ off, cluster });
      const rsOff = tableRec.dataOff + 18 + r * 2;
      secRaw.writeUInt16LE((secRaw.readUInt16LE(rsOff) + 1) & 0xFFFF, rsOff);
    }
    secRaw.writeUInt16LE((cols + 1) & 0xFFFF, tableRec.dataOff + 6); // TABLE cols+1 (in place)

    inserts.sort((a, b) => b.off - a.off);
    for (const ins of inserts) secRaw = Buffer.concat([secRaw.slice(0, ins.off), ins.cluster, secRaw.slice(ins.off)]);

    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, newCol, added: inserts.length });
  }
  return Object.assign(summary, { mode: 'in-place', inserted_count: summary.length });
}

/**
 * Delete a whole table column (`delete_table_col`) from an existing `.hwp` via
 * raw-patch. Op: `{ section?, para?, control?, col }`. GT-confirmed: TABLE
 * cols−1 (in place — no record resize, unlike row delete), each affected row's
 * cell-count decremented, the column's cell clusters deleted, every cell to the
 * right renumbered (col−1), and any cell spanning across the column has its
 * colSpan−1. A cell starting in the column with colSpan>1 is rejected. Sec 0.
 */
export async function deleteTableColInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', deleted_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`delete_table_col: only section 0 supported (got ${op.section})`);
    if (!Number.isInteger(op.col)) throw new Error("delete_table_col: 'col' (integer) is required");
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0, delCol = op.col;
    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    const tableRec = findTableRecord(records, para, ctrl);
    const cols = secRaw.readUInt16LE(tableRec.dataOff + 6);
    if (delCol < 0 || delCol >= cols) throw new Error(`delete_table_col: col ${delCol} out of range (table has ${cols} cols)`);
    const cells = tableCellRecords(records, secRaw, para, ctrl);

    const removeRanges = [];
    for (const c of cells) {
      if (c.col === delCol) {
        if (c.colSpan > 1) throw new Error(`delete_table_col: cell (${c.row},${c.col}) spans right (colSpan ${c.colSpan}) from col ${delCol} — unmerge first`);
        removeRanges.push({ startByte: c.startByte, endByte: c.endByte });
        const off = tableRec.dataOff + 18 + c.row * 2;       // that row loses a cell
        secRaw.writeUInt16LE(Math.max(0, secRaw.readUInt16LE(off) - 1), off);
      } else if (c.col < delCol && c.col + c.colSpan > delCol) {
        secRaw.writeUInt16LE((c.colSpan - 1) & 0xFFFF, c.lhDataOff + 12); // spans across → colSpan−1
      } else if (c.col > delCol) {
        secRaw.writeUInt16LE((c.col - 1) & 0xFFFF, c.lhDataOff + 8);      // right of it → col−1
      }
    }
    secRaw.writeUInt16LE((cols - 1) & 0xFFFF, tableRec.dataOff + 6);      // TABLE cols−1 (in place)

    removeRanges.sort((a, b) => b.startByte - a.startByte);
    for (const r of removeRanges) secRaw = Buffer.concat([secRaw.slice(0, r.startByte), secRaw.slice(r.endByte)]);

    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, col: delCol, removed: removeRanges.length });
  }
  return Object.assign(summary, { mode: 'in-place', deleted_count: summary.length });
}

/**
 * Merge a rectangular block of table cells into one, in `.hwp`, via raw-patch.
 *
 * Op `merge_cells`: `{ section?, para?, control?, from_row, from_col, to_row,
 * to_col }`. GT-confirmed mechanism (diff of a Hancom table-op merge):
 *   1. the top-left cell's LIST_HEADER gets colSpan = cols, rowSpan = rows;
 *   2. every other cell in the block has its whole cluster (LIST_HEADER +
 *      paragraphs) deleted — remaining cells keep their original col/row
 *      addresses (no renumber);
 *   3. the TABLE record's per-row cell-count array (body offset 18, one u16
 *      per row) is decremented once per removed cell's row.
 * Section 0 only.
 */
export async function mergeCellsInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', merged_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) throw new Error(`merge_cells: only section 0 is supported (got section ${op.section})`);
    for (const k of ['from_row', 'from_col', 'to_row', 'to_col']) {
      if (!Number.isInteger(op[k])) throw new Error(`merge_cells: '${k}' (integer) is required`);
    }
  }
  const summary = [];
  for (const op of ops) {
    const para = op.para ?? 0, ctrl = op.control ?? 0;
    const r0 = Math.min(op.from_row, op.to_row), r1 = Math.max(op.from_row, op.to_row);
    const c0 = Math.min(op.from_col, op.to_col), c1 = Math.max(op.from_col, op.to_col);
    if (r0 === r1 && c0 === c1) throw new Error('merge_cells: region must span more than one cell');

    const region = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) region.push({ section: 0, para, control: ctrl, row: r, col: c });
    const resolved = await resolveCellIndexes(filePath, region);

    let buf = readFileSync(filePath);
    let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
    let fat = readFat(buf, fatAddrs, ssz);
    const { entries } = readDirectory(buf, fat, ssz, dirStart);
    let minifat = readMinifat(buf, fat, ssz, minifatStart);
    let rootChain = null;
    const ensureRootChain = () => {
      if (rootChain) return rootChain;
      if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) throw new Error('mini-stream needed but root entry has no chain');
      rootChain = walkChain(fat, entries[0].start);
      return rootChain;
    };
    const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
    const secInMini = secEntry.size < 4096;
    let secChain, secCompressed;
    if (secInMini) {
      const rc = ensureRootChain();
      secChain = walkChain(minifat, secEntry.start);
      secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
    } else {
      secChain = walkChain(fat, secEntry.start);
      secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
    }
    let secRaw = Buffer.from(inflateRawSync(secCompressed));

    const records = parseRecords(secRaw);
    // 1. top-left cell → colSpan / rowSpan
    const tl = resolved.find((e) => e.row === r0 && e.col === c0);
    if (!tl) throw new Error(`merge_cells: top-left cell (${r0},${c0}) not resolved`);
    const tlOff = records[locateCell(records, para, ctrl, tl.cellIndex).listHeaderRec].dataOff;
    if (secRaw.readUInt16LE(tlOff + 8) !== c0 || secRaw.readUInt16LE(tlOff + 10) !== r0) {
      throw new Error(`merge_cells: top-left cell-attr layout mismatch at (${r0},${c0})`);
    }
    secRaw.writeUInt16LE((c1 - c0 + 1) & 0xFFFF, tlOff + 12);  // colSpan
    secRaw.writeUInt16LE((r1 - r0 + 1) & 0xFFFF, tlOff + 14);  // rowSpan

    // 2/3. compute clusters to delete + decrement TABLE row-size (in-place,
    // before any deletion — all offsets below are still original).
    const tableRec = findTableRecord(records, para, ctrl);
    const toRemove = resolved.filter((e) => !(e.row === r0 && e.col === c0));
    const ranges = toRemove.map((e) => ({ row: e.row, ...cellClusterByteRange(records, secRaw, para, ctrl, e.cellIndex) }));
    for (const rng of ranges) {
      const off = tableRec.dataOff + 18 + rng.row * 2;
      secRaw.writeUInt16LE(Math.max(0, secRaw.readUInt16LE(off) - 1), off);
    }
    // delete clusters high→low so earlier byte offsets stay valid.
    ranges.sort((a, b) => b.startByte - a.startByte);
    for (const rng of ranges) secRaw = Buffer.concat([secRaw.slice(0, rng.startByte), secRaw.slice(rng.endByte)]);

    // writeback Section0 (length shrank).
    {
      const inMini = secInMini;
      const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
      if (inMini) {
        const ext = deflateMiniChainWithExpansion(
          { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
          secRaw, secChain,
        );
        buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
        if (ext.promoted) {
          secChain = ext.newRegularChain;
          writeChainBytes(buf, secChain, ssz, ext.compressed);
          buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
        } else {
          rootChain = ext.rootChain;
          secChain = ext.miniChain;
          writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
        }
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      } else {
        const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
        buf = ext.buf; fat = ext.fat; secChain = ext.chain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
        buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
      }
    }
    writeFileSync(filePath, buf);
    summary.push({ op: op.type, para, control: ctrl, from: [r0, c0], to: [r1, c1], removed: toRemove.length });
  }
  return Object.assign(summary, { mode: 'in-place', merged_count: summary.length });
}

/**
 * Apply cell-level styling (background / border / diagonal) to existing `.hwp`
 * table cells via raw-patch (no rhwp round-trip, Hancom-Docs-safe).
 *
 * Ops (by `type`):
 *   - `set_cell_background` — `{ section?, para?, control?, row, col, background_color }`
 *   - `set_cell_border`     — `{ ..., sides, color?, width?, line_type? }`
 *   - `set_cell_diagonal`   — `{ ..., direction, color?, width?, line_type? }`
 *       direction = 'slash' ／ | 'backslash' ＼ | 'x' ╳ (GT/capture-verified).
 *   section/para/control default to 0 (first table on the first body paragraph
 *   of Section0). row/col are 0-based; resolveCellIndexes maps them to a flat
 *   cell index via rhwp — the same addressing set_cell_text uses.
 *
 * Mechanism: a cell's styling all lives in ONE BorderFill that its LIST_HEADER
 * references (the borderFillID u16 at a FIXED offset 32 in the level-2
 * LIST_HEADER body — NOT the last u16; see locateCell usage below). For each
 * op we read the cell's current BorderFill body, MERGE only the requested
 * change while preserving the rest (background keeps borders+diagonal; border
 * keeps fill+diagonal; diagonal keeps fill+borders), append the result to
 * DocInfo (or reuse an identical existing one), and repoint just this cell.
 * Sibling cells keep their own BorderFill, so only the targeted cell changes.
 *
 * First cut: Section0 only (matching applyParagraphStyleInPlace). A non-zero
 * section throws a clear error.
 */
export async function applyCellStyleInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    if ((op.section ?? 0) !== 0) {
      throw new Error(`${op.type}: only section 0 is supported in the raw-patch path (got section ${op.section})`);
    }
    if (op.type === 'set_cell_background' && !resolveBackgroundColor(op)) {
      throw new Error('set_cell_background: background_color is required (e.g. "#dfe6f0")');
    }
    if (op.type === 'set_cell_border' && !op.sides) {
      throw new Error('set_cell_border: sides is required ("all" or ["top","bottom","left","right"])');
    }
    if (op.type === 'set_cell_diagonal' && !(op.direction || op.kind)) {
      throw new Error('set_cell_diagonal: direction is required (slash / backslash / x)');
    }
  }

  // Resolve (row,col) → flat cellIndex via rhwp (same as set_cell_text).
  const resolved = await resolveCellIndexes(filePath, ops);

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const diEntry = findStreamEntry(entries, ['DocInfo']);
  const diInMini = diEntry.size < 4096;
  let diChain, diCompressed;
  if (diInMini) {
    const rc = ensureRootChain();
    diChain = walkChain(minifat, diEntry.start);
    diCompressed = readMiniChainBytes(buf, diChain, rc, ssz, mssz, diEntry.size);
  } else {
    diChain = walkChain(fat, diEntry.start);
    diCompressed = readChainBytes(buf, diChain, ssz, diEntry.size);
  }
  let diRaw = Buffer.from(inflateRawSync(diCompressed));

  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const summary = [];
  for (const e of resolved) {
    const para = e.para ?? 0;
    const ctrl = e.control ?? 0;
    const bg = resolveBackgroundColor(e);

    // Re-parse per op: the only secRaw mutation below is a 2-byte in-place
    // borderFillId write, which doesn't shift record offsets, so a fresh
    // parse stays valid across ops.
    const records = parseRecords(secRaw);
    const loc = locateCell(records, para, ctrl, e.cellIndex);
    const listRec = records[loc.listHeaderRec];
    // A table-cell LIST_HEADER body lays out (after an 8-byte generic list
    // header): col@8, row@10, colSpan@12, rowSpan@14, width@16, height@20,
    // margins L/R/T/B @24/26/28/30, then borderFillID @32. The borderFillID
    // is at a FIXED offset 32 — NOT the last u16. (rhwp emits exactly-34-byte
    // cell bodies so size-2 lands on 32 by coincidence, but real-form cell
    // bodies carry trailing bytes after the borderFillID; remapCluster's
    // size-2 trick only works on rhwp's synthesized clusters.)
    const CELL_BFID_OFFSET = 32;
    if (listRec.size < CELL_BFID_OFFSET + 2) {
      throw new Error(`set_cell_background: LIST_HEADER body too short (${listRec.size}b) for a table-cell borderFillID`);
    }
    // Self-check the layout: col@8 / row@10 must match the resolved cell, or
    // the fixed offset assumption is wrong for this file — fail loudly rather
    // than corrupt an unrelated u16.
    const bodyCol = secRaw.readUInt16LE(listRec.dataOff + 8);
    const bodyRow = secRaw.readUInt16LE(listRec.dataOff + 10);
    if (bodyCol !== e.col || bodyRow !== e.row) {
      throw new Error(`set_cell_background: cell-attr layout mismatch (body col/row ${bodyCol}/${bodyRow} != requested ${e.col}/${e.row}); borderFillID offset unreliable for this file`);
    }
    const bfRefOff = listRec.dataOff + CELL_BFID_OFFSET;
    const curBfId = secRaw.readUInt16LE(bfRefOff);

    // Base body to merge onto: the cell's current BorderFill (1-based;
    // 0 = "no fill" sentinel → start from a full all-zero body, which carries
    // the border+diagonal block and an explicit fill_type=0).
    const bfBodies = readBorderFillBodies(diRaw);
    const baseBody = (curBfId >= 1 && curBfId - 1 < bfBodies.length)
      ? bfBodies[curBfId - 1]
      : Buffer.alloc(53);

    // Read-merge-write per op type — each preserves the parts it doesn't touch
    // (background keeps borders/diagonal; border keeps fill/diagonal; diagonal
    // keeps fill/borders).
    let newBody;
    if (e.type === 'set_cell_border') {
      newBody = mergeBordersIntoBorderFillBody(
        baseBody, e.sides ?? 'all',
        e.color ?? e.border_color ?? '#000000',
        LINE_TYPE[String(e.line_type ?? 'solid').toLowerCase()] ?? 1,
        Number(e.width ?? 1));
    } else if (e.type === 'set_cell_diagonal') {
      newBody = mergeDiagonalIntoBorderFillBody(
        baseBody, String(e.direction ?? e.kind).toLowerCase(),
        e.color ?? e.diagonal_color ?? '#000000',
        LINE_TYPE[String(e.line_type ?? 'solid').toLowerCase()] ?? 1,
        Number(e.width ?? 1));
    } else {
      newBody = mergeSolidFillIntoBorderFillBody(baseBody, bg, e._bfPattern || 'rhwp');
    }

    // Dedup: reuse an identical existing BorderFill if present (1-based; 0
    // means "not found" → append).
    let newBfId = bfBodies.findIndex((b) => b.equals(newBody)) + 1;
    if (newBfId === 0) {
      const bfRes = appendBorderFillToDocInfo(diRaw, newBody);
      diRaw = bfRes.newDi;
      newBfId = bfRes.newBfId;
    }

    // Repoint just this cell.
    secRaw.writeUInt16LE(newBfId & 0xFFFF, bfRefOff);

    summary.push({
      op: e.type, para, control: ctrl, cellIndex: e.cellIndex,
      row: e.row, col: e.col,
      background_color: bg, sides: e.sides ?? null, diagonal: e.direction ?? e.kind ?? null,
      oldBfId: curBfId, newBfId,
    });
  }

  // Deflate + write DocInfo (BorderFill run grew). Same mini/regular and
  // mini→regular promotion handling as applyParagraphStyleInPlace.
  {
    const inMini = diInMini;
    const capacity = inMini ? diChain.length * mssz : diChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        diRaw, diChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        diChain = ext.newRegularChain;
        writeChainBytes(buf, diChain, ssz, ext.compressed);
        buf.writeInt32LE(diChain[0], diEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        diChain = ext.miniChain;
        writeMiniChainBytes(buf, diChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(diRaw, capacity, ssz, fat, fatAddrs, diChain, buf, false);
      buf = ext.buf; fat = ext.fat; diChain = ext.chain;
      writeChainBytes(buf, diChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    }
  }

  // Deflate + write Section0 (only cell borderFillId u16s changed, so size
  // is unchanged — written back through the same path for uniformity).
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}

/**
 * Apply paragraph-level styles to existing `.hwp` content via raw-patch.
 *
 * Each op: `{ target | index, align?, line_spacing?, indent?,
 *             margin_left?, margin_right?, spacing_before?, spacing_after?,
 *             background_color? }`
 *
 * Targeting: prefer `target` (a string — first paragraph whose PARA_TEXT
 * contains it). Fallback to `index` (0-based level-0 paragraph index in
 * Section0). Same coordinate space as apply_text_style for consistency.
 *
 * For background_color, we ALSO apply the same color as character
 * shadeColor across the whole paragraph (matching Hancom's
 * "문단 모양 + 글자 모양" combo behavior — without the per-char shade the
 * page-margin grid bleeds through gaps between glyph cells).
 */
export async function applyParagraphStyleInPlace(filePath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return Object.assign([], { mode: 'in-place', styled_count: 0 });
  }
  for (const op of ops) {
    const hasTarget = typeof op.target === 'string' && op.target.length > 0;
    const hasIdx = Number.isInteger(op.index) && op.index >= 0;
    if (!hasTarget && !hasIdx) {
      throw new Error("apply_paragraph_style: 'target' (string) or 'index' (non-negative integer) is required");
    }
    const style = normalizeParaStyleOp(op);
    const bg = resolveBackgroundColor(op);
    if (Object.keys(style).length === 0 && !bg) {
      throw new Error("apply_paragraph_style: at least one style prop required (align / line_spacing / indent / margin_* / spacing_* / background_color)");
    }
  }

  let buf = readFileSync(filePath);
  let { ssz, mssz, dirStart, fatAddrs, minifatStart } = parseCfbHeader(buf);
  let fat = readFat(buf, fatAddrs, ssz);
  const { entries } = readDirectory(buf, fat, ssz, dirStart);
  let minifat = readMinifat(buf, fat, ssz, minifatStart);
  let rootChain = null;
  const ensureRootChain = () => {
    if (rootChain) return rootChain;
    if (entries[0].start < 0 || entries[0].start === ENDOFCHAIN) {
      throw new Error('mini-stream needed but root entry has no chain');
    }
    rootChain = walkChain(fat, entries[0].start);
    return rootChain;
  };

  const diEntry = findStreamEntry(entries, ['DocInfo']);
  const diInMini = diEntry.size < 4096;
  let diChain, diCompressed;
  if (diInMini) {
    const rc = ensureRootChain();
    diChain = walkChain(minifat, diEntry.start);
    diCompressed = readMiniChainBytes(buf, diChain, rc, ssz, mssz, diEntry.size);
  } else {
    diChain = walkChain(fat, diEntry.start);
    diCompressed = readChainBytes(buf, diChain, ssz, diEntry.size);
  }
  let diRaw = Buffer.from(inflateRawSync(diCompressed));

  const secEntry = findStreamEntry(entries, ['BodyText', 'Section0']);
  const secInMini = secEntry.size < 4096;
  let secChain, secCompressed;
  if (secInMini) {
    const rc = ensureRootChain();
    secChain = walkChain(minifat, secEntry.start);
    secCompressed = readMiniChainBytes(buf, secChain, rc, ssz, mssz, secEntry.size);
  } else {
    secChain = walkChain(fat, secEntry.start);
    secCompressed = readChainBytes(buf, secChain, ssz, secEntry.size);
  }
  let secRaw = Buffer.from(inflateRawSync(secCompressed));

  const summary = [];
  for (const op of ops) {
    // Locate paragraph: prefer target (consistent with apply_text_style),
    // fall back to index.
    let hit;
    if (typeof op.target === 'string' && op.target.length > 0) {
      hit = findTextRangeInSection(secRaw, op.target);
      if (!hit) {
        throw new Error(`apply_paragraph_style: target "${op.target}" not found in body`);
      }
      // Override start/end to span the whole paragraph (the text-range hit
      // is just for paragraph identification; styling targets the whole para).
      hit.start = 0;
      hit.end = hit.textLength;
    } else {
      hit = findParagraphByIndexInSection(secRaw, op.index);
      if (!hit) {
        throw new Error(`apply_paragraph_style: index ${op.index} not found in section`);
      }
    }

    // Read current paraShapeId.
    if (hit.paraHeaderRec.size < 10) {
      throw new Error('apply_paragraph_style: PARA_HEADER body too short to read paraShapeId');
    }
    const basePsId = secRaw.readUInt16LE(hit.paraHeaderRec.dataOff + 8);
    const psBodies = readParaShapeBodies(diRaw);
    if (basePsId >= psBodies.length) {
      throw new Error(`apply_paragraph_style: basePsId ${basePsId} out of range (have ${psBodies.length})`);
    }

    const style = normalizeParaStyleOp(op);
    const bg = resolveBackgroundColor(op);

    // Background: create a new BorderFill + reference it from the new
    // ParaShape. Hancom Docs uses 1-based indexing for ParaShape's
    // border_fill_id field (0 means "no fill"); the 1-based conversion
    // is encapsulated inside appendBorderFillToDocInfo's return value
    // so callers can just write it directly onto the ParaShape.
    let newBfId = null;
    if (bg) {
      if (Number.isInteger(op._useExistingBfId)) {
        newBfId = op._useExistingBfId;
      } else {
        const bfBody = buildBorderFillSolidBody(bg, op._bfPattern || 'rhwp');
        const bfRes = appendBorderFillToDocInfo(diRaw, bfBody);
        diRaw = bfRes.newDi;
        newBfId = bfRes.newBfId;
      }
      style.borderFillId = newBfId;
    }

    // Build new ParaShape body overlaying style props on base.
    const newPsBody = buildParaShapeBody(psBodies[basePsId], style);

    // Dedup: reuse an identical existing ParaShape if any. (Refresh the
    // bodies list because appending a BorderFill shifts nothing for
    // PARA_SHAPE indices, but we re-read for safety.)
    let newPsId = readParaShapeBodies(diRaw).findIndex(b => b.equals(newPsBody));
    if (newPsId < 0) {
      const psRes = appendParaShapeToDocInfo(diRaw, newPsBody);
      diRaw = psRes.newDi;
      newPsId = psRes.newPsId;
    }

    // Rewrite PARA_HEADER paraShapeId. PARA_HEADER body offset 8-9.
    secRaw = setParaHeaderShapeId(secRaw, hit.paraHeaderRec, newPsId);

    // Background: the paragraph fill set above is enough on its own to
    // produce the uniform colored rectangle Hancom Office desktop emits
    // when a user applies "문단 모양 - 배경" — the desktop app doesn't
    // touch per-character shade either (the CharShape used by the
    // styled paragraph keeps shade_color = 0xFFFFFFFF / "no shade").
    // On this raw-patch path the layout cache (PARA_LINE_SEG records)
    // stays intact, so the paragraph fill covers between-glyph gaps
    // uniformly. The opt-in `_applyCharShade: true` knob is retained
    // for parity experiments; it is OFF by default.
    if (bg && op._applyCharShade === true) {
      const refreshed = typeof op.target === 'string' && op.target.length > 0
        ? (() => { const h = findTextRangeInSection(secRaw, op.target); if (h) { h.start = 0; h.end = h.textLength; } return h; })()
        : findParagraphByIndexInSection(secRaw, op.index);
      if (refreshed && refreshed.paraCharShapeRec && refreshed.textLength > 0) {
        const shadeRes = applyShadeAcrossParagraph(diRaw, secRaw, refreshed, bg);
        diRaw = shadeRes.diRaw;
        secRaw = shadeRes.secRaw;
        if (shadeRes.deltaCharShapes !== 0) {
          const refreshed2 = typeof op.target === 'string' && op.target.length > 0
            ? findTextRangeInSection(secRaw, op.target)
            : findParagraphByIndexInSection(secRaw, op.index);
          if (refreshed2) secRaw = bumpParaHeaderCounts(secRaw, refreshed2.paraHeaderRec, shadeRes.deltaCharShapes, 0);
        }
      }
    }

    summary.push({
      target: op.target,
      index: op.index,
      paraIdx: hit.paraIdx,
      basePsId,
      newPsId,
      newBfId,
    });
  }

  // Deflate + write DocInfo. mini-stream paths must use ext.miniChain /
  // ext.newRegularChain — NOT ext.chain (that field doesn't exist on
  // deflateMiniChainWithExpansion's return). Promotion happens when the new
  // compressed size crosses the 4096-byte mini-stream cutoff (e.g. h22 mini
  // DocInfo growing past the threshold after appending a new ParaShape).
  // Previously this branch was missing and produced a runtime
  // `Cannot read properties of undefined` crash for mini-stream forms.
  {
    const inMini = diInMini;
    const capacity = inMini ? diChain.length * mssz : diChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        diRaw, diChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        diChain = ext.newRegularChain;
        writeChainBytes(buf, diChain, ssz, ext.compressed);
        buf.writeInt32LE(diChain[0], diEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        diChain = ext.miniChain;
        writeMiniChainBytes(buf, diChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(diRaw, capacity, ssz, fat, fatAddrs, diChain, buf, false);
      buf = ext.buf; fat = ext.fat; diChain = ext.chain;
      writeChainBytes(buf, diChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, diEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, diEntry.entryFileOffset + 0x7C);
    }
  }

  // Deflate + write Section0. Same mini-stream pattern as DocInfo above.
  {
    const inMini = secInMini;
    const capacity = inMini ? secChain.length * mssz : secChain.length * ssz;
    if (inMini) {
      const ext = deflateMiniChainWithExpansion(
        { buf, ssz, mssz, fat, fatAddrs, minifat, minifatStart, rootChain: ensureRootChain(), rootEntry: entries[0] },
        secRaw, secChain,
      );
      buf = ext.buf; fat = ext.fat; minifat = ext.minifat; minifatStart = ext.minifatStart;
      if (ext.promoted) {
        secChain = ext.newRegularChain;
        writeChainBytes(buf, secChain, ssz, ext.compressed);
        buf.writeInt32LE(secChain[0], secEntry.entryFileOffset + 0x74);
      } else {
        rootChain = ext.rootChain;
        secChain = ext.miniChain;
        writeMiniChainBytes(buf, secChain, rootChain, ssz, mssz, ext.compressed);
      }
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    } else {
      const ext = deflateAndFitWithExpansion(secRaw, capacity, ssz, fat, fatAddrs, secChain, buf, false);
      buf = ext.buf; fat = ext.fat; secChain = ext.chain;
      writeChainBytes(buf, secChain, ssz, ext.compressed);
      buf.writeUInt32LE(ext.compressed.length, secEntry.entryFileOffset + 0x78);
      buf.writeUInt32LE(0, secEntry.entryFileOffset + 0x7C);
    }
  }

  writeFileSync(filePath, buf);
  return Object.assign(summary, { mode: 'in-place', styled_count: summary.length });
}
