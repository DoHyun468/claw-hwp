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

function locateCell(records, sectionParaIdx, controlIdx, cellIndex) {
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

  // Inside this cell: first PARA_HEADER right after LIST_HEADER (level 2).
  let paraHeaderRec = -1;
  for (let i = cellStartRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 2) { paraHeaderRec = i; break; }
    if (r.tag === TAG_LIST_HEADER && r.level === 2) break; // next cell
  }
  if (paraHeaderRec < 0) throw new Error('cell paragraph header not found');

  // Optional PARA_TEXT and PARA_CHAR_SHAPE that follow (level 3).
  let paraTextRec = null, charShapeRec = null;
  for (let i = paraHeaderRec + 1; i < records.length; i++) {
    const r = records[i];
    if (r.level <= 2) break; // back to cell-level
    if (r.tag === TAG_PARA_TEXT && paraTextRec === null) paraTextRec = i;
    else if (r.tag === TAG_PARA_CHAR_SHAPE && charShapeRec === null) charShapeRec = i;
  }
  return { listHeaderRec: cellStartRec, paraHeaderRec, paraTextRec, charShapeRec };
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

function applyCellText(raw, records, sectionParaIdx, controlIdx, cellIndex, text) {
  const loc = locateCell(records, sectionParaIdx, controlIdx, cellIndex);
  const newTextCount = text.length + 1; // + EOP
  const paraHeader = records[loc.paraHeaderRec];
  // Update PARA_HEADER.text_count, preserving the high-bit flag.
  const oldCount = raw.readUInt32LE(paraHeader.dataOff);
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
  const rhwp = await import(`${__dirname}/vendor/rhwp/rhwp.js`);
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
  const levels = [
    constants.Z_DEFAULT_COMPRESSION,
    7, 8, 9,
  ];
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
  const CFB = await import(`${__dirname}/vendor/cfb/cfb.js`);
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

async function addBinDataDefToDocInfo(filePath, storageId, ext) {
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
  const body = buildBinDataDefBody(storageId, ext);
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
function buildCharShapeBody(base, style) {
  if (!Buffer.isBuffer(base) || base.length !== 74) {
    throw new Error(`CharShape base must be a 74-byte Buffer (got ${base ? base.length : typeof base})`);
  }
  const buf = Buffer.from(base);

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
  // strike_color at 70-73
  if (style.strikethrough_color) {
    buf.writeUInt32LE(parseColorBGR(style.strikethrough_color) >>> 0, 70);
  }
  // shade_color at 60-63 (highlight) — kept here as a fallback path for
  // renderers that look at CharShape rather than PARA_RANGE_TAG; the
  // primary highlight write happens via PARA_RANGE_TAG (see callers).
  if (style.highlight && style.highlight !== false) {
    const hex = style.highlight === true ? '#ffff00' : style.highlight;
    buf.writeUInt32LE(parseColorBGR(hex) >>> 0, 60);
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
  if (body.length !== 74) {
    throw new Error(`CharShape body must be 74 bytes (got ${body.length})`);
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

// Locate the target string in Section0 raw. Returns the FIRST occurrence:
//   { paraIdx, paraHeaderRec, paraTextRec, paraCharShapeRec, start, end }
// `paraIdx` counts level-0 PARA_HEADER records (0-based, document order).
// `start` / `end` are character offsets within the paragraph text.
function findTextRangeInSection(secRaw, target) {
  const records = parseRecords(secRaw);
  let paraIdx = -1;
  let curHeader = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.tag === TAG_PARA_HEADER && r.level === 0) {
      paraIdx++;
      curHeader = r;
    }
    if (r.tag === TAG_PARA_TEXT && curHeader) {
      const text = secRaw.slice(r.dataOff, r.dataOff + r.size).toString('utf16le');
      const idx = text.indexOf(target);
      if (idx >= 0) {
        // Find the matching PARA_CHAR_SHAPE within the same cluster.
        let csRec = null;
        for (let j = i + 1; j < records.length; j++) {
          if (records[j].tag === TAG_PARA_CHAR_SHAPE && records[j].level === 1) {
            csRec = records[j];
            break;
          }
          if (records[j].tag === TAG_PARA_HEADER && records[j].level === 0) break;
        }
        return {
          paraIdx,
          paraHeaderRec: curHeader,
          paraTextRec: r,
          paraCharShapeRec: csRec,
          start: idx,
          end: idx + target.length,
          textLength: Math.floor(r.size / 2),
        };
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
  const newHeader = buildRecordHeader(TAG_PARA_CHAR_SHAPE, 1, newBody.length);
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
function insertParaRangeTagForHighlight(secRaw, csRec, start, end, hex) {
  const color = parseColorBGR(hex) >>> 0;
  const tagWord = (0x02 << 24) | (color & 0xFFFFFF);
  const body = Buffer.alloc(12);
  body.writeUInt32LE(start >>> 0, 0);
  body.writeUInt32LE(end >>> 0, 4);
  body.writeUInt32LE(tagWord >>> 0, 8);
  const newRec = Buffer.concat([buildRecordHeader(TAG_PARA_RANGE_TAG, 1, body.length), body]);
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
    const csBodies = readCharShapeBodies(diRaw);
    if (baseCsId >= csBodies.length) {
      throw new Error(`apply_text_style: base csId ${baseCsId} out of range (have ${csBodies.length})`);
    }
    // Build new CharShape from base + style overlay.
    // Apply size=pt → fontSize, font_family handling (Phase B v1: defer fontId resolution).
    const styleInput = { ...op };
    if (op.size != null && styleInput.fontSize == null) styleInput.fontSize = op.size;
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
    if (op.highlight !== undefined && op.highlight !== false) {
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
