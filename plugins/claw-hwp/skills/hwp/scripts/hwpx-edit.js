#!/usr/bin/env node
// hwpx-edit.js — Deterministic, function-level editing of .hwpx documents.
//
// HWPX ONLY. This script never touches HWP 5.0 binary (.hwp / CFB) files —
// that path lives in cell-patch.js. Input must be a ZIP-based .hwpx.
//
// Reads a JSON payload from stdin and applies a list of operations against the
// OWPML XML inside the .hwpx ZIP, then repackages. One ZIP load, N operations
// applied in order, one save — so a multi-step edit costs a single round-trip.
//
//   stdin → {
//     "path":   "in.hwpx",                 // required, must be .hwpx
//     "output": "out.hwpx",                // optional; default <in>_edited.hwpx
//     "operations": [ { "type": "...", ... }, ... ]
//   }
//
// Supported operation types (all .hwpx):
//   replace_text          { find, replace }
//   fill_template         { values: { "{{k}}": "v", ... } }
//   set_paragraph_text    { index, text }
//   append_paragraph      { text }
//   delete_paragraph      { index }
//   set_cell_text         { table, row, col, text }
//   append_table_row      { table, cells: [..] }
//   delete_table_row      { table, row }
//   append_table_column   { table, cells: [..] }   // cells top-to-bottom
//   delete_table_column   { table, col }
//   merge_cells           { table, mode: "horizontal"|"vertical", row|col, start, count }
//   insert_table          { index, rows, cols, cells? }  // appends a new table paragraph after paragraph `index` (use -1 to prepend)
//   set_cell_background   { table, row, col, color }
//   set_cell_border       { table, row, col, color, width?, sides? }
//   set_cell_diagonal     { table, row, col, direction, color?, width? }   // direction = BACKSLASH | SLASH
//   set_cell_align        { table, row, col, horizontal?, vertical? }      // horiz = LEFT/CENTER/RIGHT/JUSTIFY/DISTRIBUTE, vert = TOP/CENTER/BOTTOM
//   set_cell_size         { table, row, col, width?, height? }             // HWP units
//   set_page_break        { index, on? }                                   // sets <hp:p pageBreak="1"> before paragraph index
//   set_bullet_list       { index, char?, level? }                        // bullet (• default; char="▶"|"◯"|"□"|"★" etc. registers a new bullet entry)
//   set_number_list       { index, level?, style? }                        // numbered list — `style: "korean"` → 1./가./1)/가); `style: "decimal"` → 1./1.1./1.1.1.; omit → use doc's existing numbering id=1 (varies by template)
//   clear_list            { index }                                        // removes list formatting
//   apply_text_style      { target, color?, bold?, italic?, underline?, size?, highlight?, strikethrough?, supscript?, subscript?, fontFace? }
//   apply_paragraph_style { index, align?, indent?, lineSpacing? }
//   insert_image          { source, ext?, width?, height? }
//   replace_image         { target, source }
//   delete_image          { target }
//   set_field_value       { name, value }
//   set_header            { text, applyPageType? }   // BOTH | EVEN | ODD, default BOTH
//   set_footer            { text, applyPageType? }
//   remove_header         { }
//   remove_footer         { }
//   insert_footnote       { index, text }    // appends a footnote at end of paragraph `index`
//   insert_endnote        { index, text }    // same shape, endnote
//   insert_hyperlink      { index, url, text } // appends a clickable URL link to paragraph `index`
//   insert_bookmark       { index, name }      // anchors a named bookmark at the start of paragraph `index`'s first run
//
// Output: JSON to stdout — { ok, output, results: [ { type, ...stats } ] }.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from './vendor/fflate/index.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── small utils ─────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
let _idCounter = Math.floor(Math.random() * 1_000_000);
function freshId() {
  // OWPML ids are 32-bit-ish integers; uniqueness within the doc is what matters.
  _idCounter = (_idCounter + 1 + Math.floor(Math.random() * 97)) % 2_000_000_000;
  return String(_idCounter);
}

// Depth-aware scan of `tag` elements at the OUTERMOST level of `xml`.
// Correctly skips nested same-name tags (e.g. a <hp:tbl> inside a cell of
// another <hp:tbl>), where treesoop's non-greedy /<hp:tbl>[\s\S]*?<\/hp:tbl>/
// closes early on the inner table. Returns [{ start, end, openEnd, attrs, inner }].
function scanTopLevel(xml, tag) {
  const t = tag.replace(/:/g, '\\:');
  const re = new RegExp(`<${t}((?:\\s[^>]*?)?)(/?)>|</${t}\\s*>`, 'g');
  const out = [];
  let depth = 0, start = -1, openEnd = -1, attrs = '';
  let m;
  while ((m = re.exec(xml)) !== null) {
    const isClose = m[0].startsWith('</');
    if (!isClose && m[2] === '/') {
      // self-closing <tag .../>
      if (depth === 0) out.push({ start: m.index, end: re.lastIndex, openEnd: re.lastIndex, attrs: m[1] || '', inner: '', selfClosing: true });
      continue;
    }
    if (!isClose) {
      if (depth === 0) { start = m.index; openEnd = re.lastIndex; attrs = m[1] || ''; }
      depth++;
    } else {
      if (depth > 0) {
        depth--;
        if (depth === 0) out.push({ start, end: re.lastIndex, openEnd, attrs, inner: xml.slice(openEnd, m.index) });
      }
    }
  }
  return out;
}

// Replace the byte range [el.start, el.end) of `xml` with `replacement`.
function spliceEl(xml, el, replacement) {
  return xml.slice(0, el.start) + replacement + xml.slice(el.end);
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// ── document model over the loaded ZIP ───────────────────────────────────────

class Hwpx {
  constructor(files) {
    this.files = files; // { name: Uint8Array }
    this.text = {};     // name -> decoded string (lazy write-back on save)
    this.dirty = new Set();
  }
  sectionNames() {
    return Object.keys(this.files)
      .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
      .sort((a, b) => secIdx(a) - secIdx(b));
  }
  headerName() {
    return Object.keys(this.files).find((n) => /^Contents\/header\.xml$/i.test(n)) || null;
  }
  hpfName() {
    return Object.keys(this.files).find((n) => /^Contents\/content\.hpf$/i.test(n)) || null;
  }
  read(name) {
    if (!(name in this.text)) this.text[name] = strFromU8(this.files[name]);
    return this.text[name];
  }
  write(name, str) {
    this.text[name] = str;
    this.dirty.add(name);
  }
  // Flatten top-level <hp:p> across all sections into a global ordered list.
  // `scanTopLevel(xml, 'hp:p')` only walks same-tag nesting, so paragraphs
  // sitting inside table cells (depth-1 in document tree but depth-0 in
  // hp:p nesting) WOULD slip in. Filter them out by checking whether each
  // hit's start offset falls inside any top-level <hp:tbl> range.
  paragraphs() {
    const list = [];
    for (const name of this.sectionNames()) {
      const xml = this.read(name);
      const tblRanges = scanTopLevel(xml, 'hp:tbl').map((t) => [t.start, t.end]);
      for (const el of scanTopLevel(xml, 'hp:p')) {
        const insideTable = tblRanges.some(([a, b]) => a < el.start && el.start < b);
        if (!insideTable) list.push({ section: name, el });
      }
    }
    return list;
  }
  // All top-level <hp:tbl> across sections, in document order.
  tables() {
    const list = [];
    for (const name of this.sectionNames()) {
      const xml = this.read(name);
      for (const el of scanTopLevel(xml, 'hp:tbl')) list.push({ section: name, el });
    }
    return list;
  }
}

function secIdx(name) {
  const m = name.match(/section(\d+)\.xml/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Strip <hp:linesegarray> blocks. Linesegs are a precomputed line-break cache;
// after editing text / styles / table structure they're stale and on some
// strict readers (notably Hancom Docs) the result shows overlapping or
// mispositioned characters until the cache is recomputed. Dropping the cache
// forces a full relayout on open — cheap, and the safer default.
function dropLinesegs(s) {
  return s.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
}

// ── text operations ──────────────────────────────────────────────────────────

// Replace `find` with `replace` inside <hp:t>…</hp:t> nodes only (never touches
// tag names / attributes). Note: a match must sit within ONE <hp:t> node;
// targets split across runs are not joined (same as Hancom's text replace).
// Uses split/join per text node (not a re-scanning loop) so a replacement that
// itself contains `find` — e.g. '홍길동' → '홍길동(수정)' — can't loop forever.
function opReplaceText(doc, find, replace) {
  if (!find) throw new Error('replace_text: "find" is required and non-empty');
  const nodeRe = /(<hp:t(?:\s[^>]*)?>)([^<]*)(<\/hp:t>)/g;
  let total = 0;
  for (const name of doc.sectionNames()) {
    let changed = false;
    const xml = doc.read(name).replace(nodeRe, (m, open, text, close) => {
      if (!text.includes(find)) return m;
      const parts = text.split(find);
      total += parts.length - 1;
      changed = true;
      return open + parts.join(xmlEscape(replace)) + close;
    });
    if (changed) doc.write(name, dropLinesegs(xml));
  }
  return { replaced: total };
}

function opFillTemplate(doc, values) {
  if (!values || typeof values !== 'object') throw new Error('fill_template: "values" object required');
  const perKey = {};
  let total = 0;
  for (const [k, v] of Object.entries(values)) {
    const r = opReplaceText(doc, k, v);
    perKey[k] = r.replaced;
    total += r.replaced;
  }
  return { total, perKey };
}

// Build a minimal run that carries `text` with the given charPrIDRef.
function runWithText(charPrId, text) {
  return `<hp:run charPrIDRef="${charPrId}"><hp:t>${xmlEscape(text)}</hp:t></hp:run>`;
}

function opSetParagraphText(doc, index, text) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`set_paragraph_text: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  const open = el.attrs;
  const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const rebuilt = `<hp:p${open}>${runWithText(charPrId, text)}</hp:p>`;
  doc.write(section, spliceEl(doc.read(section), el, rebuilt));
  return { index, set: true };
}

function opAppendParagraph(doc, text) {
  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const paras = scanTopLevel(xml, 'hp:p');
  // Clone attributes of the last body paragraph for sane paraPr/style refs.
  let attrs = ' id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"';
  let charPrId = '0';
  if (paras.length) {
    attrs = paras[paras.length - 1].attrs.replace(/\s*id="\d+"/, ` id="${freshId()}"`);
    charPrId = (paras[paras.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  } else {
    attrs = attrs.replace(/id="0"/, `id="${freshId()}"`);
  }
  const para = `<hp:p${attrs}>${runWithText(charPrId, text)}</hp:p>`;
  if (/<\/hs:sec>\s*$/.test(xml)) xml = xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>');
  else xml += para;
  doc.write(last, xml);
  // Report the new paragraph's index so chained ops (set_bullet_list,
  // set_page_break, insert_hyperlink, etc.) can target it without the
  // caller having to track paragraph counts manually.
  const newIndex = doc.paragraphs().length - 1;
  return { appended: true, index: newIndex };
}

function opDeleteParagraph(doc, index) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`delete_paragraph: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  doc.write(section, spliceEl(doc.read(section), el, ''));
  return { index, deleted: true };
}

// ── table helpers ──────────────────────────────────────────────────────────

function getTable(doc, tableIndex) {
  const tables = doc.tables();
  if (tableIndex < 0 || tableIndex >= tables.length) throw new Error(`table index ${tableIndex} out of range (found ${tables.length})`);
  return tables[tableIndex];
}

// Set the inner text of one <hp:tc>, collapsing its first paragraph to a single
// run. Preserves the <hp:subList> wrapper and trailing cell metadata.
function setCellInner(tcInner, text) {
  // The first <hp:p> inside the subList holds the cell content.
  const subs = scanTopLevel(tcInner, 'hp:subList');
  if (!subs.length) return tcInner;
  const sub = subs[0];
  const ps = scanTopLevel(sub.inner, 'hp:p');
  if (!ps.length) return tcInner;
  const p = ps[0];
  const charPrId = (p.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const newP = `<hp:p${p.attrs}>${runWithText(charPrId, text)}</hp:p>`;
  const newSubInner = spliceEl(sub.inner, p, newP);
  const newSub = `<hp:subList${sub.attrs}>${newSubInner}</hp:subList>`;
  return spliceEl(tcInner, sub, newSub);
}

function opSetCellText(doc, tableIndex, row, col, text) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`set_cell_text: row ${row} out of range (0..${rows.length - 1})`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  // Prefer addressing by <hp:cellAddr>, which is correct even with merges.
  let targetIdx = tcs.findIndex((tc) => {
    const a = tc.inner.match(/<hp:cellAddr [^>]*colAddr="(\d+)"[^>]*rowAddr="(\d+)"|<hp:cellAddr [^>]*rowAddr="(\d+)"[^>]*colAddr="(\d+)"/);
    if (!a) return false;
    const c = a[1] !== undefined ? Number(a[1]) : Number(a[4]);
    return c === col;
  });
  if (targetIdx === -1) {
    if (col < 0 || col >= tcs.length) throw new Error(`set_cell_text: col ${col} out of range (0..${tcs.length - 1})`);
    targetIdx = col; // fall back to positional
  }
  const tc = tcs[targetIdx];
  const newTcInner = setCellInner(tc.inner, text);
  const newTc = `<hp:tc${tc.attrs}>${newTcInner}</hp:tc>`;
  const newRowInner = spliceEl(rows[row].inner, tc, newTc);
  const newRow = `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`;
  const newTblInner = spliceEl(tbl, rows[row], newRow);
  const newTbl = `<hp:tbl${el.attrs}>${newTblInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, col, set: true };
}

function bumpRowCnt(tblAttrs, delta) {
  const m = tblAttrs.match(/rowCnt="(\d+)"/);
  if (!m) return tblAttrs;
  return tblAttrs.replace(/rowCnt="\d+"/, `rowCnt="${Math.max(0, Number(m[1]) + delta)}"`);
}
function bumpColCnt(tblAttrs, delta) {
  const m = tblAttrs.match(/colCnt="(\d+)"/);
  if (!m) return tblAttrs;
  return tblAttrs.replace(/colCnt="\d+"/, `colCnt="${Math.max(0, Number(m[1]) + delta)}"`);
}

function freshenIds(s) {
  return s.replace(/\bid="\d+"/g, () => `id="${freshId()}"`)
          .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
}

function opAppendTableRow(doc, tableIndex, cells) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (!rows.length) throw new Error('append_table_row: table has no rows to clone');
  const last = rows[rows.length - 1];
  const newRowAddr = (() => {
    const a = last.inner.match(/rowAddr="(\d+)"/);
    return a ? Number(a[1]) + 1 : rows.length;
  })();
  let tcs = scanTopLevel(last.inner, 'hp:tc');
  let ci = 0;
  let newInner = last.inner;
  // Rebuild each cell with the supplied text and a bumped rowAddr.
  let acc = '';
  for (const tc of tcs) {
    const txt = (cells && cells[ci] !== undefined) ? cells[ci] : '';
    ci++;
    let cellInner = setCellInner(tc.inner, txt);
    let newTc = `<hp:tc${tc.attrs}>${cellInner}</hp:tc>`;
    newTc = newTc.replace(/(<hp:cellAddr [^>]*rowAddr=")\d+(")/,(m,a,b)=>a+newRowAddr+b);
    newTc = freshenIds(newTc);
    acc += newTc;
  }
  const newRow = `<hp:tr${last.attrs}>${acc}</hp:tr>`;
  const newTblInner = tbl + newRow; // append after last row (rows are last children before metadata? tbl puts trs at end)
  // Safer: insert right after the last </hp:tr>.
  const insertAt = tbl.lastIndexOf('</hp:tr>') + '</hp:tr>'.length;
  const finalInner = tbl.slice(0, insertAt) + newRow + tbl.slice(insertAt);
  const newTbl = `<hp:tbl${bumpRowCnt(el.attrs, +1)}>${finalInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, appendedCols: tcs.length };
}

function opDeleteTableRow(doc, tableIndex, row) {
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`delete_table_row: row ${row} out of range (0..${rows.length - 1})`);
  const newInner = spliceEl(tbl, rows[row], '');
  const newTbl = `<hp:tbl${bumpRowCnt(el.attrs, -1)}>${newInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, deleted: true, remaining: rows.length - 1 };
}

function opAppendTableColumn(doc, tableIndex, cells) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  // Rebuild from the end so earlier ranges stay valid.
  for (let r = rows.length - 1; r >= 0; r--) {
    const rowEl = rows[r];
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (!tcs.length) continue;
    const lastTc = tcs[tcs.length - 1];
    const newColAddr = (() => {
      const a = lastTc.inner.match(/colAddr="(\d+)"/);
      return a ? Number(a[1]) + 1 : tcs.length;
    })();
    let cellInner = setCellInner(lastTc.inner, (cells && cells[r] !== undefined) ? cells[r] : '');
    let newTc = `<hp:tc${lastTc.attrs}>${cellInner}</hp:tc>`;
    newTc = newTc.replace(/(<hp:cellAddr [^>]*colAddr=")\d+(")/,(m,a,b)=>a+newColAddr+b);
    newTc = freshenIds(newTc);
    const insertAt = rowEl.inner.lastIndexOf('</hp:tc>') + '</hp:tc>'.length;
    const newRowInner = rowEl.inner.slice(0, insertAt) + newTc + rowEl.inner.slice(insertAt);
    const newRow = `<hp:tr${rowEl.attrs}>${newRowInner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
  }
  const newTbl = `<hp:tbl${bumpColCnt(el.attrs, +1)}>${tbl}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, rows: rows.length };
}

function opDeleteTableColumn(doc, tableIndex, col) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  let affected = 0;
  for (let r = rows.length - 1; r >= 0; r--) {
    const rowEl = rows[r];
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (col < 0 || col >= tcs.length) continue;
    const newRowInner = spliceEl(rowEl.inner, tcs[col], '');
    const newRow = `<hp:tr${rowEl.attrs}>${newRowInner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
    affected++;
  }
  const newTbl = `<hp:tbl${bumpColCnt(el.attrs, -1)}>${tbl}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, col, rowsAffected: affected };
}

function opMergeCells(doc, tableIndex, mode, opts) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  const setSpan = (tcAttrsAndInner, spanAttr, n) => {
    // cellSpan lives as <hp:cellSpan colSpan=".." rowSpan=".."/> inside the tc.
    if (new RegExp(`${spanAttr}="\\d+"`).test(tcAttrsAndInner)) {
      return tcAttrsAndInner.replace(new RegExp(`${spanAttr}="\\d+"`), `${spanAttr}="${n}"`);
    }
    return tcAttrsAndInner.replace(/<hp:cellSpan /, `<hp:cellSpan ${spanAttr}="${n}" `);
  };
  if (mode === 'horizontal') {
    const { row, start, count } = opts;
    if (count < 2) throw new Error('merge_cells horizontal: count must be >= 2');
    const rowEl = rows[row];
    if (!rowEl) throw new Error(`merge_cells: row ${row} out of range`);
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (start < 0 || start + count > tcs.length) throw new Error('merge_cells horizontal: range out of bounds');
    let inner = rowEl.inner;
    // Remove absorbed cells from the end first.
    for (let i = count - 1; i >= 1; i--) inner = spliceEl(inner, scanTopLevel(inner, 'hp:tc')[start + i], '');
    const firstTcs = scanTopLevel(inner, 'hp:tc');
    const merged = setSpan(`<hp:tc${firstTcs[start].attrs}>${firstTcs[start].inner}</hp:tc>`, 'colSpan', count);
    inner = spliceEl(inner, firstTcs[start], merged);
    const newRow = `<hp:tr${rowEl.attrs}>${inner}</hp:tr>`;
    tbl = spliceEl(tbl, rowEl, newRow);
  } else if (mode === 'vertical') {
    const { col, start, count } = opts;
    if (count < 2) throw new Error('merge_cells vertical: count must be >= 2');
    if (start < 0 || start + count > rows.length) throw new Error('merge_cells vertical: range out of bounds');
    // Remove the cell at `col` from rows start+1..start+count-1 (bottom-up).
    for (let i = count - 1; i >= 1; i--) {
      const rEl = scanTopLevel(tbl, 'hp:tr')[start + i];
      const tcs = scanTopLevel(rEl.inner, 'hp:tc');
      if (col < tcs.length) {
        const newRow = `<hp:tr${rEl.attrs}>${spliceEl(rEl.inner, tcs[col], '')}</hp:tr>`;
        tbl = spliceEl(tbl, rEl, newRow);
      }
    }
    const firstREl = scanTopLevel(tbl, 'hp:tr')[start];
    const tcs = scanTopLevel(firstREl.inner, 'hp:tc');
    if (!tcs[col]) throw new Error(`merge_cells vertical: col ${col} out of range`);
    const merged = setSpan(`<hp:tc${tcs[col].attrs}>${tcs[col].inner}</hp:tc>`, 'rowSpan', count);
    const newRow = `<hp:tr${firstREl.attrs}>${spliceEl(firstREl.inner, tcs[col], merged)}</hp:tr>`;
    tbl = spliceEl(tbl, firstREl, newRow);
  } else {
    throw new Error(`merge_cells: unknown mode "${mode}" (use "horizontal" or "vertical")`);
  }
  const newTbl = `<hp:tbl${el.attrs}>${dropLinesegs(tbl)}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, mode, merged: opts.count };
}

// Insert a brand-new table (rows × cols) as a fresh paragraph at `index`.
// Hancom Docs is strict about table validity — every required inner element
// (cellAddr, cellSpan, cellSz, cellMargin, subList, etc.) must be present in
// the exact shape it expects. Hand-rolling that envelope from scratch tends to
// produce docs that the lenient renderer opens and Hancom Docs rejects, so we
// clone the first existing tbl in the document as the template and rebuild it
// at the requested size — same trick used by `buildPic` for images.
//
// When the doc has no existing table, we fall back to a minimal Hancom-native
// table envelope built from scratch — uses borderFillIDRef="1" (the unstyled
// "no borders" entry that every standard .hwpx ships with), a 5155×2075 HWP
// unit cell (the same size 한컴독스 itself uses for new tables on A4), and
// a plain body paragraph. Verified against a doc that 한컴독스 created via
// its own "표 삽입" menu.
const FALLBACK_TBL_ATTRS = ` id="0" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" cellSpacing="0" borderFillIDRef="1" noAdjust="0"`;
const FALLBACK_TBL_META = `<hp:sz width="42520" widthRelTo="ABSOLUTE" height="4150" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="286" right="286" top="286" bottom="286"/><hp:inMargin left="510" right="510" top="138" bottom="138"/>`;
const FALLBACK_CELL_ATTRS = ` name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"`;
const FALLBACK_CELL_INNER = `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="5155" height="2075"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/>`;

function opInsertTable(doc, index, rows, cols, cells) {
  if (!Number.isInteger(rows) || rows < 1) throw new Error('insert_table: rows must be a positive integer');
  if (!Number.isInteger(cols) || cols < 1) throw new Error('insert_table: cols must be a positive integer');

  const tables = doc.tables();
  const hasSource = tables.length > 0;

  let srcSection, srcPara, srcParaAttrs, templateRowAttrs, srcTblAttrs, tblMeta, cellTemplateAttrs, cellTemplateInner;

  if (hasSource) {
    const srcTbl = tables[0];
    srcSection = srcTbl.section;
    const srcXml = doc.read(srcSection);

    // Find the enclosing top-level paragraph of the source table.
    const paras = scanTopLevel(srcXml, 'hp:p');
    srcPara = paras.find((p) => p.start <= srcTbl.el.start && p.end >= srcTbl.el.end);
    if (!srcPara) throw new Error('insert_table: source table is not inside a top-level paragraph (unexpected)');
    srcParaAttrs = srcPara.attrs;

    // Pick a body cell as the template. Row 0 is usually a styled header
    // (grey fill in most government / report templates), so prefer row 1's
    // first cell when the source has more than one row — gives a clean
    // white-background body cell by default. Fall back to row 0 for
    // single-row source tables.
    const srcRows = scanTopLevel(srcTbl.el.inner, 'hp:tr');
    if (!srcRows.length) throw new Error('insert_table: source table has no rows');
    const templateRow = srcRows.length >= 2 ? srcRows[1] : srcRows[0];
    templateRowAttrs = templateRow.attrs;
    const srcTcs = scanTopLevel(templateRow.inner, 'hp:tc');
    if (!srcTcs.length) throw new Error('insert_table: source row has no cells');
    cellTemplateAttrs = srcTcs[0].attrs;
    cellTemplateInner = srcTcs[0].inner;
    srcTblAttrs = srcTbl.el.attrs;

    // Keep the source tbl's pre-row metadata (hp:sz, hp:pos, hp:outMargin, hp:inMargin).
    const firstTrIdx = srcTbl.el.inner.indexOf('<hp:tr');
    tblMeta = firstTrIdx >= 0 ? srcTbl.el.inner.slice(0, firstTrIdx) : '';
  } else {
    // Fallback path — no source table to clone. Hancom Docs's web viewer
    // suppresses cellzone fills when the table's own borderFill paints a
    // visible grid AND the cell's own borderFill also paints solid borders:
    // it picks one of those, the cellzone fill loses. Mirror the structure
    // the clone path inherits from real Hancom-authored tables:
    //   - tbl-wide borderFill: all sides NONE (invisible, no double-grid)
    //   - cell-self borderFill: 4-side SOLID 0.12mm black (the real grid)
    //     and NO diagonal, NO fillBrush (those would also break the fill).
    // With this split, set_cell_background cellzones paint the whole cell.
    const invisibleTblBfId = ensureBorderFill(doc,
      STD_SLASH_NONE +
      '<hh:leftBorder type="NONE" width="0.1 mm" color="none"/>' +
      '<hh:rightBorder type="NONE" width="0.1 mm" color="none"/>' +
      '<hh:topBorder type="NONE" width="0.1 mm" color="none"/>' +
      '<hh:bottomBorder type="NONE" width="0.1 mm" color="none"/>'
    );
    const visibleCellBfId = ensureBorderFill(doc, STD_SLASH_NONE + PLAIN_SIDES);
    srcSection = doc.sectionNames()[0];
    srcPara = null;
    srcParaAttrs = '';
    templateRowAttrs = '';
    cellTemplateAttrs = FALLBACK_CELL_ATTRS.replace(/borderFillIDRef="\d+"/, `borderFillIDRef="${visibleCellBfId}"`);
    cellTemplateInner = FALLBACK_CELL_INNER;
    srcTblAttrs = FALLBACK_TBL_ATTRS.replace(/borderFillIDRef="\d+"/, `borderFillIDRef="${invisibleTblBfId}"`);
    tblMeta = FALLBACK_TBL_META;
  }

  const cellTemplate = { attrs: cellTemplateAttrs, inner: cellTemplateInner };
  const templateRow = { attrs: templateRowAttrs };

  // Build cells row-by-row.
  const builtRows = [];
  for (let r = 0; r < rows; r++) {
    const cellStrs = [];
    for (let c = 0; c < cols; c++) {
      const text = (cells && cells[r] && cells[r][c] !== undefined) ? cells[r][c] : '';
      let cellInner = setCellInner(cellTemplate.inner, text);
      // cellAddr → (r, c)
      if (/<hp:cellAddr\b/.test(cellInner)) {
        cellInner = cellInner.replace(/<hp:cellAddr\s+[^>]*\/?>/, `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>`);
      } else {
        cellInner = cellInner.replace(/<\/hp:subList>/, `</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/>`);
      }
      // cellSpan → 1×1 (drop any inherited merge)
      if (/<hp:cellSpan\b/.test(cellInner)) {
        cellInner = cellInner.replace(/<hp:cellSpan\s+[^>]*\/?>/, '<hp:cellSpan colSpan="1" rowSpan="1"/>');
      }
      let tc = `<hp:tc${cellTemplate.attrs}>${cellInner}</hp:tc>`;
      tc = freshenIds(tc);
      cellStrs.push(tc);
    }
    builtRows.push(`<hp:tr${templateRow.attrs}>${cellStrs.join('')}</hp:tr>`);
  }

  let newTblAttrs = srcTblAttrs;
  if (/rowCnt="\d+"/.test(newTblAttrs)) newTblAttrs = newTblAttrs.replace(/rowCnt="\d+"/, `rowCnt="${rows}"`);
  else newTblAttrs = ` rowCnt="${rows}"` + newTblAttrs;
  if (/colCnt="\d+"/.test(newTblAttrs)) newTblAttrs = newTblAttrs.replace(/colCnt="\d+"/, `colCnt="${cols}"`);
  else newTblAttrs = ` colCnt="${cols}"` + newTblAttrs;

  const newTbl = `<hp:tbl${newTblAttrs}>${tblMeta}${builtRows.join('')}</hp:tbl>`;

  // Build the wrapper paragraph holding the new table. When we have a source
  // paragraph, clone its run/ctrl wrapping (which Hancom requires for body
  // tables). When we don't (fallback path), wrap the table in a minimal run
  // with a textWrap-friendly ctrl env.
  let newPara;
  if (srcPara) {
    const tblOffsetInPara = tables[0].el.start - srcPara.openEnd;
    const tblLen = tables[0].el.end - tables[0].el.start;
    const paraInnerWithNewTbl =
      srcPara.inner.slice(0, tblOffsetInPara) + newTbl + srcPara.inner.slice(tblOffsetInPara + tblLen);
    const newParaAttrs = srcParaAttrs.replace(/\sid="\d+"/, ` id="${freshId()}"`);
    newPara = `<hp:p${newParaAttrs}>${dropLinesegs(paraInnerWithNewTbl)}</hp:p>`;
  } else {
    // Hancom's own table-bearing paragraphs put <hp:tbl> DIRECTLY inside
    // <hp:run> — wrapping it in <hp:ctrl> here (which is what we used to
    // do) made the file unopenable in 한컴독스, even though the table XML
    // looked structurally fine.
    const wrapperPAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;
    const wrapperRun = `<hp:run charPrIDRef="0">${newTbl}</hp:run>`;
    newPara = `<hp:p${wrapperPAttrs}>${wrapperRun}</hp:p>`;
  }

  // Inject at the target paragraph index (global, ordered across sections).
  // index === -1 prepends at the start of the first section's body.
  const allParas = doc.paragraphs();
  if (!Number.isInteger(index) || index < -1 || index >= allParas.length) {
    throw new Error(`insert_table: index ${index} out of range (-1..${allParas.length - 1}; -1 to prepend)`);
  }
  if (index === -1) {
    const firstSec = doc.sectionNames()[0];
    let xml = doc.read(firstSec);
    const firstP = xml.match(/<hp:p(\s|>)/);
    if (firstP) xml = xml.slice(0, firstP.index) + newPara + xml.slice(firstP.index);
    else xml = xml.replace(/<\/hs:sec>/, newPara + '</hs:sec>');
    doc.write(firstSec, xml);
  } else {
    const target = allParas[index];
    const xml = doc.read(target.section);
    doc.write(target.section, xml.slice(0, target.el.end) + newPara + xml.slice(target.el.end));
  }
  return { inserted: true, rows, cols, afterIndex: index };
}

// ── cell-level styling ──────────────────────────────────────────────────────
//
// Hancom Docs stores per-cell background / border / diagonal NOT on the
// <hp:tc> itself but as <hp:cellzone> entries inside an <hp:cellzoneList>
// child of <hp:tbl> (sitting between the table's meta and its <hp:tr> rows).
// Each cellzone maps a (startRow, startCol)–(endRow, endCol) area to a
// borderFillIDRef. The referenced <hh:borderFill> in header.xml carries the
// fill brush, side borders, and slash/backSlash diagonals. We mirror that
// pattern: build/find the right borderFill in header.xml, then append one
// cellzone to the table.
//
// Vertical align lives on the cell's <hp:subList vertAlign=>, horizontal
// align on the cell's first <hp:p> paraPrIDRef (rewritten through a
// paraPr clone-mutate in header.xml), and sizing on <hp:cellSz>. None of
// these touch cellzoneList.

const PLAIN_SIDES = `<hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>`;
const NONE_SIDES = `<hh:leftBorder type="NONE" width="0.12 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.12 mm" color="#000000"/><hh:topBorder type="NONE" width="0.12 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.12 mm" color="#000000"/>`;
const DEFAULT_DIAG = `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>`;
const STD_SLASH_NONE = `<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`;
const BF_ATTRS = ' threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"';

function normHex(c) { return `#${String(c).replace(/^#/, '').toUpperCase()}`; }

// Find an existing borderFill whose serialized inner matches `wantInner`,
// or append a new one and return its id. Bumps <hh:borderFills@itemCnt>.
function ensureBorderFill(doc, wantInner) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('cell style: Contents/header.xml missing');
  let header = doc.read(headerName);
  const list = scanTopLevel(header, 'hh:borderFills')[0];
  if (!list) throw new Error('cell style: <hh:borderFills> missing in header.xml');
  const existing = scanTopLevel(list.inner, 'hh:borderFill');
  for (const bf of existing) {
    if (bf.inner === wantInner) return getAttr(bf.attrs, 'id');
  }
  const newId = String(Math.max(0, ...existing.map((b) => Number(getAttr(b.attrs, 'id') || 0))) + 1);
  const newBf = `<hh:borderFill id="${newId}"${BF_ATTRS}>${wantInner}</hh:borderFill>`;
  let newHeader = spliceEl(header, list, `<hh:borderFills${list.attrs}>${list.inner + newBf}</hh:borderFills>`);
  newHeader = bumpListCount(newHeader, 'hh:borderFills', +1);
  doc.write(headerName, newHeader);
  return newId;
}

// Merge a new cell-area into the table's cellzoneList. When an existing
// cellzone has the SAME borderFillIDRef and is horizontally adjacent
// (same row range, col extends by 1) or vertically adjacent (same col
// range, row extends by 1), grow that cellzone's range instead of pushing
// a fresh `<hp:cellzone>`. This mirrors what Hancom Docs itself emits when
// the user paints the same color on a sequence of adjacent cells — and
// it's what unlocks Hancom Docs's "fill the whole cell" rendering: per-
// cell isolated cellzones render as glyph-height background strips only.
function addCellzone(doc, tableIndex, row, col, borderFillId) {
  const { section, el } = getTable(doc, tableIndex);
  const inner = el.inner;
  const lists = scanTopLevel(inner, 'hp:cellzoneList');
  // Parse existing cellzones (if any).
  const parseZones = (raw) => {
    const re = /<hp:cellzone\s+startRowAddr="(\d+)"\s+startColAddr="(\d+)"\s+endRowAddr="(\d+)"\s+endColAddr="(\d+)"\s+borderFillIDRef="(\d+)"\/>/g;
    const out = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      out.push({ startRow: +m[1], startCol: +m[2], endRow: +m[3], endCol: +m[4], bf: m[5] });
    }
    return out;
  };
  const zones = lists.length ? parseZones(lists[0].inner) : [];
  // Try to extend an existing zone (same bf + adjacent).
  let merged = false;
  for (const z of zones) {
    if (z.bf !== borderFillId) continue;
    // Single-cell add for this op — check horizontal adjacency first.
    const horizAdj = z.startRow === row && z.endRow === row &&
                     (z.endCol + 1 === col || z.startCol - 1 === col);
    const vertAdj = z.startCol === col && z.endCol === col &&
                    (z.endRow + 1 === row || z.startRow - 1 === row);
    // Already contained — silent no-op.
    const contained = z.startRow <= row && row <= z.endRow &&
                      z.startCol <= col && col <= z.endCol;
    if (contained) { merged = true; break; }
    if (horizAdj) {
      z.startCol = Math.min(z.startCol, col);
      z.endCol = Math.max(z.endCol, col);
      merged = true;
      break;
    }
    if (vertAdj) {
      z.startRow = Math.min(z.startRow, row);
      z.endRow = Math.max(z.endRow, row);
      merged = true;
      break;
    }
  }
  if (!merged) zones.push({ startRow: row, startCol: col, endRow: row, endCol: col, bf: borderFillId });
  const serialized = zones.map((z) =>
    `<hp:cellzone startRowAddr="${z.startRow}" startColAddr="${z.startCol}" endRowAddr="${z.endRow}" endColAddr="${z.endCol}" borderFillIDRef="${z.bf}"/>`
  ).join('');
  let newInner;
  if (lists.length) {
    newInner = spliceEl(inner, lists[0], `<hp:cellzoneList>${serialized}</hp:cellzoneList>`);
  } else {
    const firstTr = inner.indexOf('<hp:tr');
    if (firstTr < 0) throw new Error('cell style: table has no rows');
    newInner = inner.slice(0, firstTr) + `<hp:cellzoneList>${serialized}</hp:cellzoneList>` + inner.slice(firstTr);
  }
  const newTbl = `<hp:tbl${el.attrs}>${newInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
}

function opSetCellBackground(doc, tableIndex, row, col, color, mode) {
  const c = normHex(color);
  // `mode` controls how the color gets applied — Hancom's web viewer
  // doesn't always paint a cellzone fill across the full cell on tables
  // built without a clone source, so we offer the caller a choice:
  //   "cellzone": only `<hp:cellzone>` (whole-cell on most renderers, but
  //               on Hancom web fallback tables it may shrink to a glyph
  //               strip; matches what 한독 itself writes for desktop-
  //               authored tables).
  //   "shade":   only character shading (글자 모양 → 음영) — strictly
  //               glyph-height, no margins, but it ALWAYS renders.
  //   "both" (default): both at once — cellzone gives the full-cell look
  //               where supported, shade guarantees the visible color
  //               otherwise.
  const m = (mode || 'both').toLowerCase();
  if (!['cellzone', 'shade', 'both'].includes(m)) {
    throw new Error(`set_cell_background: mode must be "cellzone" | "shade" | "both" (got ${mode})`);
  }
  let bfId = null;
  if (m === 'cellzone' || m === 'both') {
    const brush = `<hc:fillBrush><hc:winBrush faceColor="${c}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
    bfId = ensureBorderFill(doc, STD_SLASH_NONE + NONE_SIDES + DEFAULT_DIAG + brush);
    addCellzone(doc, tableIndex, row, col, bfId);
  }
  if (m === 'shade' || m === 'both') {
    applyCellShadeColor(doc, tableIndex, row, col, c);
  }
  return { table: tableIndex, row, col, color: c, mode: m, borderFillId: bfId };
}

// Stamp shadeColor on the charPr of every run inside the cell at (row, col).
// Reuses a placeholder charPr (refCount=0) cloned from the cell's current
// charPr, so existing styling (font, size, color) is preserved.
function applyCellShadeColor(doc, tableIndex, row, col, color) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (row < 0 || row >= rows.length) return;
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  if (col < 0 || col >= tcs.length) return;
  const tc = tcs[col];
  const runMatch = tc.inner.match(/<hp:run\s+[^>]*charPrIDRef="(\d+)"/);
  if (!runMatch) return;
  const sourceRef = runMatch[1];
  const headerName = doc.headerName();
  if (!headerName) return;
  let header = doc.read(headerName);
  const charPrs = scanTopLevel(header, 'hh:charPr');
  if (!charPrs.length) return;
  const base = charPrs.find((c) => getAttr(c.attrs, 'id') === sourceRef) || charPrs[0];
  // Already shaded with same color? Reuse.
  for (const c of charPrs) {
    if (c.inner === base.inner && getAttr(c.attrs, 'shadeColor') === color) {
      const useId = getAttr(c.attrs, 'id');
      retargetCellRuns(doc, tableIndex, row, col, useId);
      return;
    }
  }
  // Otherwise mutate a placeholder (or append).
  const refCounts = buildCharPrRefCounts(doc);
  const placeholder = charPrs.find((c) => (refCounts[getAttr(c.attrs, 'id')] || 0) === 0 && getAttr(c.attrs, 'id') !== sourceRef);
  const useId = placeholder ? getAttr(placeholder.attrs, 'id')
                            : String(Math.max(...charPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0))) + 1);
  const newAttrs = setOrAddAttr(base.attrs, 'shadeColor', color).replace(/\s*id="\d+"/, ` id="${useId}"`);
  const updated = `<hh:charPr${newAttrs}>${base.inner}</hh:charPr>`;
  header = placeholder
    ? spliceEl(header, placeholder, updated)
    : bumpListCount(spliceEl(header, base, `<hh:charPr${base.attrs}>${base.inner}</hh:charPr>` + updated), 'hh:charProperties', +1);
  doc.write(headerName, header);
  retargetCellRuns(doc, tableIndex, row, col, useId);
}

// Replace charPrIDRef on every <hp:run> inside a specific cell.
function retargetCellRuns(doc, tableIndex, row, col, newCharPrId) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  const tc = tcs[col];
  const newCellInner = tc.inner.replace(/(<hp:run\s+[^>]*?charPrIDRef=")\d+(")/g, `$1${newCharPrId}$2`);
  const newTc = `<hp:tc${tc.attrs}>${newCellInner}</hp:tc>`;
  const newRowInner = spliceEl(rows[row].inner, tc, newTc);
  const newRow = `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`;
  const newTblInner = spliceEl(el.inner, rows[row], newRow);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${newTblInner}</hp:tbl>`));
}

function opSetCellBorder(doc, tableIndex, row, col, color, width, sides) {
  const c = normHex(color);
  const w = width || '0.3 mm';
  const want = (sides && sides.length) ? new Set(sides.map((s) => s.toUpperCase())) : new Set(['LEFT', 'RIGHT', 'TOP', 'BOTTOM']);
  const side = (name) => want.has(name.toUpperCase())
    ? `<hh:${name.toLowerCase()}Border type="SOLID" width="${w}" color="${c}"/>`
    : `<hh:${name.toLowerCase()}Border type="SOLID" width="0.12 mm" color="#000000"/>`;
  const sidesXml = side('left') + side('right') + side('top') + side('bottom');
  const inner = STD_SLASH_NONE + sidesXml + DEFAULT_DIAG;
  const bfId = ensureBorderFill(doc, inner);
  addCellzone(doc, tableIndex, row, col, bfId);
  return { table: tableIndex, row, col, color: c, width: w, sides: [...want], borderFillId: bfId };
}

function opSetCellDiagonal(doc, tableIndex, row, col, direction, color, width) {
  const dir = String(direction || 'BACKSLASH').toUpperCase();
  if (dir !== 'BACKSLASH' && dir !== 'SLASH') throw new Error('set_cell_diagonal: direction must be "BACKSLASH" or "SLASH"');
  const c = normHex(color || '#000000');
  const w = width || '0.3 mm';
  const slashes = dir === 'BACKSLASH'
    ? `<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="CENTER" Crooked="0" isCounter="0"/>`
    : `<hh:slash type="CENTER" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`;
  const diagonal = `<hh:diagonal type="SOLID" width="${w}" color="${c}"/>`;
  const inner = slashes + NONE_SIDES + diagonal;
  const bfId = ensureBorderFill(doc, inner);
  addCellzone(doc, tableIndex, row, col, bfId);
  return { table: tableIndex, row, col, direction: dir, color: c, borderFillId: bfId };
}

function opSetCellAlign(doc, tableIndex, row, col, horizontal, vertical) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`set_cell_align: row ${row} out of range`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  if (col < 0 || col >= tcs.length) throw new Error(`set_cell_align: col ${col} out of range`);
  const tc = tcs[col];
  let tcInner = tc.inner;

  // Vertical → <hp:subList vertAlign="TOP|CENTER|BOTTOM">
  if (vertical) {
    const v = String(vertical).toUpperCase();
    if (!['TOP', 'CENTER', 'BOTTOM'].includes(v)) throw new Error('set_cell_align: vertical must be TOP/CENTER/BOTTOM');
    tcInner = tcInner.replace(/(<hp:subList\b[^>]*?\svertAlign=")[^"]+(")/, `$1${v}$2`);
  }

  // Horizontal → rewrite first <hp:p>'s paraPrIDRef to a paraPr with the
  // requested align. Uses the same clone-and-bump pattern as
  // apply_paragraph_style. Falls through quietly if no horizontal arg.
  let paraInfo = null;
  if (horizontal) {
    const align = String(horizontal).toUpperCase();
    if (!['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'DISTRIBUTE'].includes(align)) {
      throw new Error('set_cell_align: horizontal must be LEFT/CENTER/RIGHT/JUSTIFY/DISTRIBUTE');
    }
    const headerName = doc.headerName();
    if (!headerName) throw new Error('set_cell_align: Contents/header.xml missing');
    let header = doc.read(headerName);
    const paraPrs = scanTopLevel(header, 'hh:paraPr');
    if (!paraPrs.length) throw new Error('set_cell_align: no <hh:paraPr> in header.xml');
    const subs = scanTopLevel(tcInner, 'hp:subList');
    if (!subs.length) throw new Error('set_cell_align: cell has no <hp:subList>');
    const ps = scanTopLevel(subs[0].inner, 'hp:p');
    if (!ps.length) throw new Error('set_cell_align: cell has no <hp:p>');
    const p = ps[0];
    const srcParaRef = (p.attrs.match(/paraPrIDRef="(\d+)"/) || [, '0'])[1];
    const base = paraPrs.find((pr) => getAttr(pr.attrs, 'id') === srcParaRef) || paraPrs[0];
    // placeholder reuse — same Hancom-native trick as charPr ops.
    const refCounts = {};
    for (const name of doc.sectionNames()) {
      for (const m of doc.read(name).matchAll(/paraPrIDRef="(\d+)"/g)) {
        refCounts[m[1]] = (refCounts[m[1]] || 0) + 1;
      }
    }
    const placeholder = paraPrs.find((pr) => (refCounts[getAttr(pr.attrs, 'id')] || 0) === 0 && getAttr(pr.attrs, 'id') !== srcParaRef);
    const useId = placeholder ? getAttr(placeholder.attrs, 'id')
                              : String(Math.max(...paraPrs.map((pr) => Number(getAttr(pr.attrs, 'id') || 0))) + 1);
    let mutAttrs = base.attrs.replace(/\s*id="\d+"/, ` id="${useId}"`);
    let mutInner = base.inner;
    const alignXml = `<hh:align horizontal="${align}" vertical="BASELINE"/>`;
    mutInner = /<hh:align [^>]*\/>/.test(mutInner) ? mutInner.replace(/<hh:align [^>]*\/>/, alignXml) : alignXml + mutInner;
    const updated = `<hh:paraPr${mutAttrs}>${mutInner}</hh:paraPr>`;
    header = placeholder
      ? spliceEl(header, placeholder, updated)
      : bumpListCount(spliceEl(header, base, `<hh:paraPr${base.attrs}>${base.inner}</hh:paraPr>` + updated), 'hh:paraProperties', +1);
    doc.write(headerName, header);
    // Retarget the cell paragraph's paraPrIDRef in tcInner
    const newPOpen = p.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${useId}"`);
    const newP = `<hp:p${newPOpen}>${p.inner}</hp:p>`;
    const newSubInner = spliceEl(subs[0].inner, p, newP);
    const newSub = `<hp:subList${subs[0].attrs}>${newSubInner}</hp:subList>`;
    tcInner = spliceEl(tcInner, subs[0], newSub);
    paraInfo = { paraPrId: useId, basedOn: srcParaRef, placeholderReused: Boolean(placeholder) };
  }

  const newTc = `<hp:tc${tc.attrs}>${tcInner}</hp:tc>`;
  const newRowInner = spliceEl(rows[row].inner, tc, newTc);
  const newRow = `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`;
  const newTblInner = spliceEl(el.inner, rows[row], newRow);
  const newTbl = `<hp:tbl${el.attrs}>${newTblInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, col, horizontal: horizontal || null, vertical: vertical || null, ...(paraInfo || {}) };
}

// Insert a page break BEFORE the paragraph at `index` — Hancom stores this
// as a single attribute on the paragraph: <hp:p ... pageBreak="1">.
function opSetPageBreak(doc, index, on) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`set_page_break: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  const want = on === false ? '0' : '1';
  let newAttrs = /pageBreak="\d"/.test(el.attrs)
    ? el.attrs.replace(/pageBreak="\d"/, `pageBreak="${want}"`)
    : el.attrs + ` pageBreak="${want}"`;
  const rebuilt = `<hp:p${newAttrs}>${el.inner}</hp:p>`;
  doc.write(section, spliceEl(doc.read(section), el, rebuilt));
  return { index, pageBreak: want === '1' };
}

// Look up a <hh:bullet> by its `char` attribute, or append a new one to
// <hh:bullets> and return its id. char="▶" / "◯" / "□" / "★" all work —
// Hancom Docs reads the char and renders it. When `char` is empty/missing,
// returns "1" (the default idRef every standard doc carries).
function ensureBullet(doc, char) {
  if (!char) return '1';
  const headerName = doc.headerName();
  if (!headerName) throw new Error('ensureBullet: Contents/header.xml missing');
  let header = doc.read(headerName);
  const headBody = `<hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/>`;
  const list = scanTopLevel(header, 'hh:bullets')[0];
  if (!list) {
    // Doc has no <hh:bullets> at all — create one (positioned right after
    // <hh:numberings>, the way Hancom Docs lays out its standard headers).
    // Place the requested char at id=1: Hancom Docs web ignores idRef and
    // only renders bullets[0], so a placeholder at id=1 would hide the char.
    const newBullet = `<hh:bullet id="1" char="${char}" useImage="0">${headBody}</hh:bullet>`;
    const block = `<hh:bullets itemCnt="1">${newBullet}</hh:bullets>`;
    let newHeader;
    if (/<\/hh:numberings>/.test(header)) {
      newHeader = header.replace(/(<\/hh:numberings>)/, `$1${block}`);
    } else {
      // Last-resort: drop right before </hh:head>.
      newHeader = header.replace(/(<\/hh:head>)/, `${block}$1`);
    }
    doc.write(headerName, newHeader);
    return '1';
  }
  const bulletEls = scanTopLevel(list.inner, 'hh:bullet');
  // Hancom Docs web ignores BULLET heading idRef and only renders the first
  // <hh:bullet> entry it sees. To make the requested glyph visible in web,
  // ensure the lowest-id <hh:bullet> carries this char. If a char="" placeholder
  // sits at a lower id, swap their `char` attrs (preserving ids so existing
  // BULLET heading idRefs keep working everywhere).
  const matched = bulletEls.find((b) => getAttr(b.attrs, 'char') === char);
  const placeholder = bulletEls.find((b) => getAttr(b.attrs, 'char') === '');
  if (matched) {
    const matchedId = getAttr(matched.attrs, 'id');
    if (placeholder && Number(getAttr(placeholder.attrs, 'id')) < Number(matchedId)) {
      const placeId = getAttr(placeholder.attrs, 'id');
      const placeUpd = `<hh:bullet${setOrAddAttr(placeholder.attrs, 'char', char)}>${placeholder.inner}</hh:bullet>`;
      const matchedUpd = `<hh:bullet${setOrAddAttr(matched.attrs, 'char', '')}>${matched.inner}</hh:bullet>`;
      // Splice the later one first so the earlier one's offsets stay valid.
      const [first, second] = placeholder.start < matched.start ? [placeholder, matched] : [matched, placeholder];
      const [firstUpd, secondUpd] = placeholder.start < matched.start ? [placeUpd, matchedUpd] : [matchedUpd, placeUpd];
      let newInner = spliceEl(list.inner, second, secondUpd);
      newInner = spliceEl(newInner, first, firstUpd);
      doc.write(headerName, spliceEl(header, list, `<hh:bullets${list.attrs}>${newInner}</hh:bullets>`));
      return placeId;
    }
    return matchedId;
  }
  if (placeholder) {
    const placeId = getAttr(placeholder.attrs, 'id');
    const newPlaceAttrs = setOrAddAttr(placeholder.attrs, 'char', char);
    const updated = `<hh:bullet${newPlaceAttrs}>${placeholder.inner}</hh:bullet>`;
    const newListInner = spliceEl(list.inner, placeholder, updated);
    doc.write(headerName, spliceEl(header, list, `<hh:bullets${list.attrs}>${newListInner}</hh:bullets>`));
    return placeId;
  }
  const ids = bulletEls.map((b) => Number(getAttr(b.attrs, 'id') || 0));
  const newId = String(Math.max(0, ...ids) + 1);
  const newBullet = `<hh:bullet id="${newId}" char="${char}" useImage="0">${headBody}</hh:bullet>`;
  let newHeader = spliceEl(header, list, `<hh:bullets${list.attrs}>${list.inner + newBullet}</hh:bullets>`);
  newHeader = bumpListCount(newHeader, 'hh:bullets', +1);
  doc.write(headerName, newHeader);
  return newId;
}

// Register (or reuse) an <hh:numbering> entry whose paraHead text is the
// literal bullet glyph (e.g. ▶). Hancom Docs web silently downgrades
// freshly-emitted <hh:heading type="BULLET"> to NONE on load — public OSS
// writers (pypandoc-hwpx, honeypot) work around this by rerouting bullets
// through type="NUMBER" with the glyph in <hh:paraHead> as literal text,
// numFormat="DIGIT" and no `^N` placeholder. Hancom prints the literal char
// for every level (1–10).
function ensureBulletAsNumbering(doc, char) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('ensureBulletAsNumbering: Contents/header.xml missing');
  let header = doc.read(headerName);
  const list = scanTopLevel(header, 'hh:numberings')[0];
  if (!list) throw new Error('ensureBulletAsNumbering: <hh:numberings> missing');
  const escaped = xmlEscape(char);
  // Reuse a numbering whose level=1 paraHead text exactly equals `char`.
  const numberingEls = scanTopLevel(list.inner, 'hh:numbering');
  for (const n of numberingEls) {
    const m = n.inner.match(/<hh:paraHead\b[^>]*\slevel="1"[^>]*>([^<]*)<\/hh:paraHead>/);
    if (m && m[1] === escaped) return getAttr(n.attrs, 'id');
  }
  const ids = numberingEls.map((n) => Number(getAttr(n.attrs, 'id') || 0));
  const newId = String(Math.max(0, ...ids) + 1);
  const head = (lvl) =>
    `<hh:paraHead start="1" level="${lvl}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">${escaped}</hh:paraHead>`;
  const body = [1,2,3,4,5,6,7,8,9,10].map(head).join('');
  const newNum = `<hh:numbering id="${newId}" start="1">${body}</hh:numbering>`;
  let newHeader = spliceEl(header, list, `<hh:numberings${list.attrs}>${list.inner + newNum}</hh:numberings>`);
  newHeader = bumpListCount(newHeader, 'hh:numberings', +1);
  doc.write(headerName, newHeader);
  return newId;
}

// Look up (or register) a numbering definition matching `style`. Returns the
// id of the <hh:numbering> entry to point heading@idRef at.
//   "korean"  → 1./가./1)/가)/(1)/(가) (Hancom's stock multi-level format)
//   "decimal" → 1./1.1./1.1.1./...
// Without a style, returns '1' (use whatever numbering id=1 the doc carries —
// some templates carry korean, some carry decimal, so the visual result
// depends on the doc unless an explicit style is requested).
function ensureNumbering(doc, style) {
  if (!style) return '1';
  const s = String(style).toLowerCase();
  if (s !== 'korean' && s !== 'decimal') throw new Error(`ensureNumbering: style must be "korean" or "decimal" (got ${style})`);
  const headerName = doc.headerName();
  if (!headerName) throw new Error('ensureNumbering: Contents/header.xml missing');
  let header = doc.read(headerName);
  const list = scanTopLevel(header, 'hh:numberings')[0];
  if (!list) throw new Error('ensureNumbering: <hh:numberings> missing');
  // Match on the level=2 paraHead text — that's where korean (`^2.`) and
  // decimal (`^1.^2.`) diverge.
  const want = s === 'decimal' ? '^1.^2.' : '^2.';
  const numberingEls = scanTopLevel(list.inner, 'hh:numbering');
  for (const n of numberingEls) {
    const m = n.inner.match(/<hh:paraHead\b[^>]*\slevel="2"[^>]*>([^<]*)<\/hh:paraHead>/);
    if (m && m[1] === want) return getAttr(n.attrs, 'id');
  }
  // Build new numbering definition.
  const ids = numberingEls.map((n) => Number(getAttr(n.attrs, 'id') || 0));
  const newId = String(Math.max(0, ...ids) + 1);
  const head = (lvl, fmt, text) =>
    `<hh:paraHead start="1" level="${lvl}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="0">${text}</hh:paraHead>`;
  const emptyHead = (lvl) =>
    `<hh:paraHead start="1" level="${lvl}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/>`;
  let body;
  if (s === 'decimal') {
    const parts = [];
    for (let lvl = 1; lvl <= 10; lvl++) {
      const txt = Array.from({ length: lvl }, (_, i) => `^${i + 1}.`).join('');
      parts.push(head(lvl, 'DIGIT', txt));
    }
    body = parts.join('');
  } else {
    body =
      head(1, 'DIGIT', '^1.') +
      head(2, 'HANGUL_SYLLABLE', '^2.') +
      head(3, 'DIGIT', '^3)') +
      head(4, 'HANGUL_SYLLABLE', '^4)') +
      head(5, 'DIGIT', '(^5)') +
      head(6, 'HANGUL_SYLLABLE', '(^6)') +
      emptyHead(7) + emptyHead(8) + emptyHead(9) + emptyHead(10);
  }
  // Hancom Docs web also mis-renders NUMBER heading idRef the same way it
  // mis-renders BULLET (only the first numbering entry is honored). If the
  // doc carries a placeholder numbering at id=1 (every paraHead is empty
  // self-closing, i.e. text=""), rewrite that placeholder in-place so the
  // requested format lands at the lowest idRef.
  const isPlaceholderNumbering = (n) =>
    !/<hh:paraHead\b[^/]*>[^<]+<\/hh:paraHead>/.test(n.inner);
  const placeholder = numberingEls.find(isPlaceholderNumbering);
  if (placeholder) {
    const placeId = getAttr(placeholder.attrs, 'id');
    const updated = `<hh:numbering${placeholder.attrs}>${body}</hh:numbering>`;
    const newListInner = spliceEl(list.inner, placeholder, updated);
    doc.write(headerName, spliceEl(header, list, `<hh:numberings${list.attrs}>${newListInner}</hh:numberings>`));
    return placeId;
  }
  const newNum = `<hh:numbering id="${newId}" start="1">${body}</hh:numbering>`;
  let newHeader = spliceEl(header, list, `<hh:numberings${list.attrs}>${list.inner + newNum}</hh:numberings>`);
  newHeader = bumpListCount(newHeader, 'hh:numberings', +1);
  doc.write(headerName, newHeader);
  return newId;
}

// Find an existing paraPr in header.xml that already declares the requested
// heading (type/level) — preferably one authored by Hancom (i.e. cloned in
// from a doc that round-tripped through Hancom Docs). Returns the paraPr id
// to retarget, or null if no compatible paraPr exists. Critical: Hancom Docs
// web rejects our synthesised list paraPrs even when byte-level identical to
// stock, so reusing an existing one is the only reliable path to list
// rendering surviving cloud open.
function reuseExistingListParaPr(doc, type, lvl) {
  const headerName = doc.headerName();
  if (!headerName) return null;
  const header = doc.read(headerName);
  const paraPrs = scanTopLevel(header, 'hh:paraPr');
  for (const pp of paraPrs) {
    const hm = pp.inner.match(/<hh:heading\s+type="([^"]+)"\s+idRef="[^"]*"\s+level="(\d+)"/);
    if (!hm) continue;
    if (hm[1] !== type) continue;
    if (Number(hm[2]) !== lvl) continue;
    return getAttr(pp.attrs, 'id');
  }
  return null;
}

// Bullet / numbered list — Hancom's mechanism is a paraPr with
//   <hh:heading type="BULLET|NUMBER" idRef="N" level="L"/>
// retargeting the paragraph's paraPrIDRef. For NUMBER, level=0/1/2/3 cycles
// through Hancom's default numbering formats (1./가./1)/가)). For BULLET,
// idRef points into <hh:bullets>; we keep the default id=1 unless `char` is
// supplied, in which case we register (or reuse) a bullet entry for that
// glyph. type="NONE" clears the list by stripping the heading element.
function opSetParagraphList(doc, index, type, level, options) {
  const t = String(type || '').toUpperCase();
  if (!['BULLET', 'NUMBER', 'NONE'].includes(t)) throw new Error('set_paragraph_list: type must be BULLET / NUMBER / NONE');
  const lvl = Number(level || 0);
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`set_paragraph_list: index ${index} out of range`);
  const { section, el } = paras[index];

  const headerName = doc.headerName();
  if (!headerName) throw new Error('set_paragraph_list: Contents/header.xml missing');

  // Hancom Docs web (cloud viewer) silently strips synthesised
  // <hh:heading type="BULLET|NUMBER"> from any paraPr it didn't author —
  // even when our paraPr inner is byte-level identical to a Hancom-native
  // paraPr. So before creating a new paraPr, scan the doc for a Hancom-
  // authored paraPr already carrying the desired heading type/level and
  // reuse it (just retarget the paragraph's paraPrIDRef). This honors the
  // honeypot pattern: don't synthesise list paraPrs from scratch, ride on
  // the host doc's existing ones if it has any.
  if (t === 'BULLET' || t === 'NUMBER') {
    const reused = reuseExistingListParaPr(doc, t, lvl);
    if (reused) {
      const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${reused}"`);
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newOpen}>${el.inner}</hp:p>`));
      return { index, type: t, level: lvl, paraPrId: reused, reusedHancomNative: true };
    }
    // No Hancom-native list paraPr in the host doc. Synthesising one fails
    // on Hancom Docs web (silent BULLET→NONE / NUMBER→BULLET downgrade), so
    // fall back to a literal glyph prefix in the paragraph text. This is
    // what every public OSS hwpx writer (airmang, chrisryugj, kordoc) does
    // for cross-viewer reliability — the bullet "▶ " becomes plain text but
    // renders identically across web AND desktop, every time.
    const prefix = options && options.fallbackPrefix === false
      ? null
      : t === 'BULLET' ? `${(options && options.char) || '▶'} ` : null;
    if (prefix) {
      const escapedPrefix = xmlEscape(prefix);
      const newInner = el.inner.replace(
        /(<hp:t(?:\s[^>]*)?>)([^<]*)/,
        (_, open, text) => `${open}${escapedPrefix}${text}`
      );
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${el.attrs}>${newInner}</hp:p>`));
      return { index, type: t, level: lvl, fallback: 'text-prefix', char: (options && options.char) || '▶' };
    }
  }

  // ensureBullet / ensureNumbering may mutate header.xml — call them FIRST so
  // subsequent header reads (for paraPrs) see the new lists. Doing it after
  // caching `header` makes the trailing doc.write overwrite the lists change.
  const bulletChar = options && options.char ? String(options.char) : '';
  const numberStyle = options && options.style ? options.style : null;
  let listIdRef = '1';
  // Effective heading type — Hancom Docs web silently strips synthesised
  // type="BULLET" back to NONE, so route bullets through type="NUMBER" with
  // the glyph living as the numbering's <hh:paraHead> text content
  // (pypandoc-hwpx pattern, the only public OSS approach proven to survive
  // 한컴 docs web normalize).
  let emittedType = t;
  if (t === 'BULLET') {
    listIdRef = ensureBulletAsNumbering(doc, bulletChar || '▶');
    emittedType = 'NUMBER';
  }
  else if (t === 'NUMBER') listIdRef = ensureNumbering(doc, numberStyle);

  let header = doc.read(headerName);
  const paraPrs = scanTopLevel(header, 'hh:paraPr');

  // Base = the paragraph's current paraPr (for its margin/lineSpacing/etc).
  const srcParaRef = (el.attrs.match(/paraPrIDRef="(\d+)"/) || [, '0'])[1];
  const base = paraPrs.find((pp) => getAttr(pp.attrs, 'id') === srcParaRef) || paraPrs[0];

  // Build the EXACT desired inner — base.inner with the heading set/replaced/cleared.
  // Hancom's standard placement puts <hh:heading> right after <hh:align>.
  let wantInner;
  if (t === 'NONE') {
    wantInner = base.inner.replace(/<hh:heading\b[^/]*\/>/g, '');
  } else {
    const heading = `<hh:heading type="${emittedType}" idRef="${listIdRef}" level="${lvl}"/>`;
    if (/<hh:heading\b[^/]*\/>/.test(base.inner)) {
      wantInner = base.inner.replace(/<hh:heading\b[^/]*\/>/, heading);
    } else {
      wantInner = /<hh:align\s+[^>]*\/>/.test(base.inner)
        ? base.inner.replace(/(<hh:align\s+[^>]*\/>)/, `$1${heading}`)
        : heading + base.inner;
    }
    // Hancom Docs web silently drops the bullet/number glyph when the
    // paragraph aligns to JUSTIFY. LEFT renders identically for single-line
    // body text and keeps the glyph visible across both web and desktop.
    wantInner = wantInner.replace(
      /<hh:align\s+horizontal="JUSTIFY"/,
      '<hh:align horizontal="LEFT"'
    );
    // Hancom Docs normalizes paraPr inner format on load and silently strips
    // <hh:heading type="BULLET|NUMBER"> back to NONE when the surrounding
    // child layout doesn't match its stock template. The stock template has
    // <hh:autoSpacing> right after <hh:breakSetting>, then <hp:switch>
    // wrapping margin+lineSpacing (HwpUnitChar compat), with margin children
    // in the hc: namespace. Rewrite our inner to match before Hancom can.
    wantInner = stockizeParaPrInner(wantInner);
  }

  // Reuse only a paraPr whose inner matches wantInner EXACTLY (i.e. one we
  // produced earlier in this batch from the same base). Hancom's stock list
  // paraPrs (e.g. baseline paraPr 38) carry default indents like
  // margin.left=1000 — matching merely on heading type/level would inherit
  // those indents and produce visually different output from the user's body.
  for (const pp of paraPrs) {
    if (pp.inner === wantInner) {
      const useId = getAttr(pp.attrs, 'id');
      const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${useId}"`);
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newOpen}>${el.inner}</hp:p>`));
      return { index, type: t, level: lvl, paraPrId: useId, reusedExisting: true };
    }
  }

  // Otherwise — reuse a placeholder paraPr (Hancom-native trick) or append new.
  const refCounts = {};
  for (const name of doc.sectionNames()) {
    for (const m of doc.read(name).matchAll(/paraPrIDRef="(\d+)"/g)) {
      refCounts[m[1]] = (refCounts[m[1]] || 0) + 1;
    }
  }
  const placeholder = paraPrs.find((pp) => (refCounts[getAttr(pp.attrs, 'id')] || 0) === 0 && getAttr(pp.attrs, 'id') !== srcParaRef);
  const useId = placeholder ? getAttr(placeholder.attrs, 'id')
                            : String(Math.max(...paraPrs.map((pp) => Number(getAttr(pp.attrs, 'id') || 0))) + 1);
  const mutAttrs = base.attrs.replace(/\s*id="\d+"/, ` id="${useId}"`);
  const updated = `<hh:paraPr${mutAttrs}>${wantInner}</hh:paraPr>`;
  header = placeholder
    ? spliceEl(header, placeholder, updated)
    : bumpListCount(spliceEl(header, base, `<hh:paraPr${base.attrs}>${base.inner}</hh:paraPr>` + updated), 'hh:paraProperties', +1);
  doc.write(headerName, header);
  const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${useId}"`);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newOpen}>${el.inner}</hp:p>`));
  return { index, type: t, level: lvl, paraPrId: useId, basedOn: srcParaRef, placeholderReused: Boolean(placeholder) };
}

function opSetCellSize(doc, tableIndex, row, col, width, height) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`set_cell_size: row ${row} out of range`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  if (col < 0 || col >= tcs.length) throw new Error(`set_cell_size: col ${col} out of range`);
  const tc = tcs[col];
  const csMatch = tc.inner.match(/<hp:cellSz width="(\d+)" height="(\d+)"\/>/);
  if (!csMatch) throw new Error('set_cell_size: cell has no <hp:cellSz>');
  const w = width !== undefined ? width : Number(csMatch[1]);
  const h = height !== undefined ? height : Number(csMatch[2]);
  const newInner = tc.inner.replace(/<hp:cellSz width="\d+" height="\d+"\/>/, `<hp:cellSz width="${w}" height="${h}"/>`);
  const newTc = `<hp:tc${tc.attrs}>${newInner}</hp:tc>`;
  const newRowInner = spliceEl(rows[row].inner, tc, newTc);
  const newRow = `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`;
  const newTblInner = spliceEl(el.inner, rows[row], newRow);
  const newTbl = `<hp:tbl${el.attrs}>${newTblInner}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, col, width: w, height: h };
}

// ── style operations (clone-mutate-retarget in header.xml) ───────────────────

// Find the <hp:run> that actually CONTAINS the first <hp:t> holding `target`,
// and return both the run element and its current charPrIDRef. The current
// ref matters because apply_text_style now clones THAT charPr as the base
// (instead of always charPr[0]) — keeping font / size / borderFill consistent
// with the body context. A new charPr cloned from a mismatched base (e.g.
// header style 0 cloned for body text using style 26) gets reinterpreted by
// Hancom Docs on open and our additive attributes (shadeColor, strikeout)
// are dropped along with it.
//
// Uses a balanced run scan so an empty self-closing <hp:run/> sitting just
// before the text node isn't mistaken for its parent.
function findRunForText(xml, target) {
  const tRe = new RegExp(`<hp:t(?:\\s[^>]*)?>[^<]*${escapeRegex(target)}`);
  for (const r of scanTopLevel(xml, 'hp:run')) {
    if (r.selfClosing) continue;
    if (r.inner.includes('<hp:tbl')) continue;
    if (!tRe.test(r.inner)) continue;
    const m = r.attrs.match(/charPrIDRef="(\d+)"/);
    return { run: r, sourceRef: m ? m[1] : '0' };
  }
  return null;
}

function retargetRun(xml, run, newId) {
  const newOpen = /charPrIDRef="\d+"/.test(run.attrs)
    ? run.attrs.replace(/charPrIDRef="\d+"/, `charPrIDRef="${newId}"`)
    : ` charPrIDRef="${newId}"${run.attrs}`;
  return xml.slice(0, run.start) + `<hp:run${newOpen}>` + run.inner + '</hp:run>' + xml.slice(run.end);
}

// If `target` is a SUBSTRING of the run's <hp:t>, split the run into 3 runs
// — [before / target / after] — so the new charPr only applies to the target
// substring. Effects like 위첨자 / 아래첨자 / bold etc. visually depend on
// being scoped to just the styled letters; retargeting the whole line's run
// makes Hancom Docs ignore the effect on screen.
// If `target` already IS the whole hp:t, falls back to a plain retarget (no
// gratuitous splitting). Returns the rewritten xml, or null if the run's
// inner is more complex than a single <hp:t> (e.g. has tabs, line breaks,
// embedded controls) and can't be safely split.
function splitRunAroundText(xml, run, target, newId) {
  const tMatch = run.inner.match(/^<hp:t(\s[^>]*)?>([^<]*)<\/hp:t>$/);
  if (!tMatch) return null;
  const tAttrs = tMatch[1] || '';
  const text = tMatch[2];
  const idx = text.indexOf(target);
  if (idx < 0) return null;
  if (idx === 0 && idx + target.length === text.length) return retargetRun(xml, run, newId);
  const before = text.slice(0, idx);
  const after = text.slice(idx + target.length);
  const oldAttrs = run.attrs;
  const newAttrs = /charPrIDRef="\d+"/.test(oldAttrs)
    ? oldAttrs.replace(/charPrIDRef="\d+"/, `charPrIDRef="${newId}"`)
    : ` charPrIDRef="${newId}"${oldAttrs}`;
  const beforeRun = before ? `<hp:run${oldAttrs}><hp:t${tAttrs}>${before}</hp:t></hp:run>` : '';
  const targetRun = `<hp:run${newAttrs}><hp:t${tAttrs}>${target}</hp:t></hp:run>`;
  const afterRun = after ? `<hp:run${oldAttrs}><hp:t${tAttrs}>${after}</hp:t></hp:run>` : '';
  return xml.slice(0, run.start) + beforeRun + targetRun + afterRun + xml.slice(run.end);
}

// Highlight (마커펜 / 형광펜) in OWPML is an INLINE marker pair, not a
// charPr attribute. Hancom Docs stores it as
//   <hp:t>...<hp:markpenBegin color="#FFFF00"/>대상<hp:markpenEnd/>...</hp:t>
// inside the existing <hp:t> node. We mirror that exactly: find the first
// <hp:t> containing `target`, splice the marker tags around the target
// substring. shadeColor on charPr is unrelated and Hancom ignores it for
// highlighting purposes.
function applyHighlight(doc, target, highlight) {
  if (highlight === false || highlight === null) {
    let stripped = 0;
    for (const name of doc.sectionNames()) {
      const xml = doc.read(name);
      const next = xml.replace(/<hp:markpenBegin\b[^>]*\/>/g, '').replace(/<hp:markpenEnd\b[^>]*\/>/g, '');
      if (next !== xml) { doc.write(name, dropLinesegs(next)); stripped += 1; }
    }
    return { highlight: false, sectionsStripped: stripped };
  }
  const color = highlight === true ? '#FFFF00' : `#${String(highlight).replace(/^#/, '')}`;
  const begin = `<hp:markpenBegin color="${color}"/>`;
  const end = `<hp:markpenEnd/>`;
  const tRe = new RegExp(`(<hp:t(?:\\s[^>]*)?>)([^<]*?)(${escapeRegex(target)})([^<]*?)(</hp:t>)`);
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const m = xml.match(tRe);
    if (!m) continue;
    const at = m.index;
    const newXml = xml.slice(0, at) + m[1] + m[2] + begin + m[3] + end + m[4] + m[5] + xml.slice(at + m[0].length);
    doc.write(name, dropLinesegs(newXml));
    return { highlight: color, retargeted: 1 };
  }
  return { highlight: color, retargeted: 0 };
}

// Build a {id → ref count} map across all sections for the current doc.
// Used to find an unused "placeholder" charPr — Hancom Docs' native pattern
// for adding a styled variant is to repurpose one of these unused charPrs
// in place rather than appending a brand-new charPr to the list. Empirically
// (verified via round-trip in Hancom Docs), appending a new charPr ends up
// with its discriminating attrs (strikeout/supscript/fontRef) sanitized away
// on next open, so the visible effect never lands. In-place placeholder
// reuse mirrors how Hancom itself stores these edits.
// Look up a font's id by face name in the HANGUL fontface block. Hancom's own
// `폰트 변경` writes the same id into every lang slot of <hh:fontRef> when
// the same face name exists across lang lists (the common case for fonts
// registered through 한컴독스). Returns null if the face isn't registered —
// caller raises so we don't silently no-op.
function findFontIdByFace(doc, face) {
  const headerName = doc.headerName();
  if (!headerName) return null;
  const header = doc.read(headerName);
  const hf = header.match(/<hh:fontface\s+lang="HANGUL"[\s\S]*?<\/hh:fontface>/);
  if (!hf) return null;
  const re = new RegExp(`<hh:font\\s+id="(\\d+)"\\s+face="${escapeRegex(face)}"`);
  const m = hf[0].match(re);
  return m ? m[1] : null;
}

function buildCharPrRefCounts(doc) {
  const counts = {};
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    for (const m of xml.matchAll(/charPrIDRef="(\d+)"/g)) {
      counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
  }
  return counts;
}

function opApplyTextStyle(doc, target, style) {
  // Highlight is an inline <hp:markpen> marker pair — processed independently
  // of the charPr-based attributes below.
  let highlightOut = null;
  if (style.highlight !== undefined) {
    highlightOut = applyHighlight(doc, target, style.highlight);
  }
  const charPrKeys = ['color', 'bold', 'italic', 'underline', 'size', 'strikethrough', 'supscript', 'subscript', 'fontFace'];
  const wantsCharPr = charPrKeys.some((k) => style[k] !== undefined);
  if (!wantsCharPr) {
    return highlightOut ? { target, ...highlightOut } : { target, retargeted: 0 };
  }

  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_text_style: Contents/header.xml missing');
  const header = doc.read(headerName);
  const charPrs = scanTopLevel(header, 'hh:charPr');
  if (!charPrs.length) throw new Error('apply_text_style: no <hh:charPr> in header.xml');

  // Locate the target run — if absent, don't pollute header.xml.
  let hitSection = null, hitRun = null, sourceRef = null;
  for (const name of doc.sectionNames()) {
    const found = findRunForText(doc.read(name), target);
    if (found) { hitSection = name; hitRun = found.run; sourceRef = found.sourceRef; break; }
  }
  if (!hitSection) return highlightOut ? { target, ...highlightOut } : { target, retargeted: 0 };

  // Base = the charPr the run currently uses (font/size/borderFill family).
  const base = charPrs.find((c) => getAttr(c.attrs, 'id') === sourceRef) || charPrs[0];

  // Pick a placeholder charPr (reference count 0) to rewrite in place; this
  // mirrors Hancom's own pattern. Fall back to appending a brand-new charPr
  // only if every charPr in the doc is already referenced. The placeholder's
  // attrs/inner are fully replaced with base's content + our style mutations,
  // so the body text keeps the base font/size family.
  const refCounts = buildCharPrRefCounts(doc);
  const placeholder = charPrs.find((c) => (refCounts[getAttr(c.attrs, 'id')] || 0) === 0 && getAttr(c.attrs, 'id') !== sourceRef);

  const useId = placeholder ? getAttr(placeholder.attrs, 'id')
                            : String(Math.max(...charPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0))) + 1);

  let attrs = base.attrs.replace(/\s*id="\d+"/, ` id="${useId}"`);
  let inner = base.inner;
  if (style.size) attrs = setOrAddAttr(attrs, 'height', String(style.size));
  if (style.color) attrs = setOrAddAttr(attrs, 'textColor', `#${String(style.color).replace(/^#/, '')}`);
  if (style.bold !== undefined) inner = toggleChild(inner, 'hh:bold', style.bold);
  if (style.italic !== undefined) inner = toggleChild(inner, 'hh:italic', style.italic);
  if (style.underline !== undefined) {
    inner = style.underline
      ? ensureChild(inner, '<hh:underline type="BOTTOM" shape="SOLID" color="#000000"/>', 'hh:underline')
      : inner.replace(/<hh:underline[^>]*\/>/g, '');
  }
  if (style.strikethrough !== undefined) {
    const shape = style.strikethrough ? 'SOLID' : 'NONE';
    const so = `<hh:strikeout shape="${shape}" color="#000000"/>`;
    inner = /<hh:strikeout\b[^>]*\/>/.test(inner)
      ? inner.replace(/<hh:strikeout\b[^>]*\/>/, so)
      : inner + so;
  }
  // Sup/subscript are mutually exclusive child elements at the end of charPr.
  if (style.supscript !== undefined || style.subscript !== undefined) {
    inner = inner.replace(/<hh:supscript\b[^>]*\/>/g, '').replace(/<hh:subscript\b[^>]*\/>/g, '');
    if (style.supscript) inner = inner + '<hh:supscript/>';
    else if (style.subscript) inner = inner + '<hh:subscript/>';
  }
  // fontFace: rewrite every lang slot of <hh:fontRef> to the font's id, the
  // way Hancom Docs stores 폰트 변경.
  if (style.fontFace) {
    const fid = findFontIdByFace(doc, style.fontFace);
    if (fid === null) throw new Error(`apply_text_style: font "${style.fontFace}" not registered in <hh:fontfaces> — register it first or pick an existing face`);
    inner = inner.replace(
      /<hh:fontRef\s+[^>]*\/>/,
      `<hh:fontRef hangul="${fid}" latin="${fid}" hanja="${fid}" japanese="${fid}" other="${fid}" symbol="${fid}" user="${fid}"/>`,
    );
  }
  const updatedCharPr = `<hh:charPr${attrs}>${inner}</hh:charPr>`;
  let h2;
  if (placeholder) {
    h2 = spliceEl(header, placeholder, updatedCharPr); // in-place rewrite, itemCnt unchanged
  } else {
    h2 = spliceEl(header, base, `<hh:charPr${base.attrs}>${base.inner}</hh:charPr>` + updatedCharPr);
    h2 = bumpListCount(h2, 'hh:charProperties', +1);
  }
  doc.write(headerName, h2);
  const sectionXml = doc.read(hitSection);
  const splitXml = splitRunAroundText(sectionXml, hitRun, target, useId);
  doc.write(hitSection, dropLinesegs(splitXml || retargetRun(sectionXml, hitRun, useId)));
  return {
    target, charPrId: useId, baseCharPrId: sourceRef,
    placeholderReused: Boolean(placeholder),
    runSplit: splitXml !== null && !(splitXml === retargetRun(sectionXml, hitRun, useId)),
    retargeted: 1,
    ...(highlightOut || {}),
  };
}

function opApplyParagraphStyle(doc, index, style) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_paragraph_style: Contents/header.xml missing');
  let header = doc.read(headerName);
  const paraPrs = scanTopLevel(header, 'hh:paraPr');
  if (!paraPrs.length) throw new Error('apply_paragraph_style: no <hh:paraPr> in header.xml');
  const maxId = Math.max(...paraPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0)));
  const newId = String(maxId + 1);
  const base = paraPrs[0];
  let mutAttrs = base.attrs.replace(/\s*id="\d+"/, ` id="${newId}"`);
  let mutInner = base.inner;
  if (style.align) {
    if (/<hh:align [^>]*\/>/.test(mutInner)) mutInner = mutInner.replace(/<hh:align [^>]*\/>/, `<hh:align horizontal="${style.align}" vertical="BASELINE"/>`);
    else mutInner = `<hh:align horizontal="${style.align}" vertical="BASELINE"/>` + mutInner;
  }
  if (style.lineSpacing !== undefined) {
    const ls = `<hh:lineSpacing type="PERCENT" value="${style.lineSpacing}" unit="HWPUNIT"/>`;
    mutInner = /<hh:lineSpacing[^>]*\/>/.test(mutInner) ? mutInner.replace(/<hh:lineSpacing[^>]*\/>/, ls) : ls + mutInner;
  }
  if (style.indent !== undefined) {
    mutInner = mutInner.replace(/(<hh:intent unit="[^"]*" value=")[-\d]+(")/, (m, a, b) => a + style.indent + b);
  }
  const newParaPr = `<hh:paraPr${mutAttrs}>${mutInner}</hh:paraPr>`;
  header = spliceEl(header, base, `<hh:paraPr${base.attrs}>${base.inner}</hh:paraPr>` + newParaPr);
  header = bumpListCount(header, 'hh:paraProperties', +1);
  doc.write(headerName, header);
  // Retarget the Nth body paragraph.
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`apply_paragraph_style: index ${index} out of range`);
  const { section, el } = paras[index];
  const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${newId}"`);
  const rebuilt = `<hp:p${newOpen}>${dropLinesegs(el.inner)}</hp:p>`;
  doc.write(section, spliceEl(doc.read(section), el, rebuilt));
  return { index, paraPrId: newId };
}

// Increment itemCnt="N" on the named OWPML list wrapper (e.g. hh:charPrList),
// so Hancom's strict reader doesn't ignore an appended definition.
function bumpListCount(header, listTag, delta) {
  const re = new RegExp(`(<${listTag.replace(/:/g, '\\:')}\\b[^>]*itemCnt=")(\\d+)(")`);
  return header.replace(re, (m, a, n, b) => a + (Number(n) + delta) + b);
}

function setOrAddAttr(attrs, name, value) {
  if (new RegExp(`${name}="[^"]*"`).test(attrs)) return attrs.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`);
  return ` ${name}="${value}"` + attrs.replace(/^\s*/, ' ');
}

// Rewrite a paraPr inner so Hancom Docs accepts the BULLET/NUMBER heading
// without normalizing-then-stripping it. The fingerprint Hancom requires:
//   align → heading → breakSetting → autoSpacing → hp:switch{ margin+lineSpacing } → border
// Margin children must live in the `hc:` namespace under <hp:switch>, not
// inline <hh:margin> with hh: children. Any other order/wrapping triggers the
// silent BULLET→NONE rewrite on load.
function stockizeParaPrInner(inner) {
  const grab = (re) => { const m = inner.match(re); return m ? m[0] : ''; };
  const align = grab(/<hh:align\b[^/]*\/>/);
  const heading = grab(/<hh:heading\b[^/]*\/>/);
  const breakSetting = grab(/<hh:breakSetting\b[^/]*\/>/);
  const autoSpacing = grab(/<hh:autoSpacing\b[^/]*\/>/);
  const margin = grab(/<hh:margin\b[^>]*>[\s\S]*?<\/hh:margin>/) || grab(/<hh:margin\b[^/]*\/>/);
  const lineSpacing = grab(/<hh:lineSpacing\b[^/]*\/>/);
  const border = grab(/<hh:border\b[^/]*\/>/);
  if (!margin || !lineSpacing) return inner;  // unfamiliar shape — leave as-is
  // Convert margin's inner children hh:* → hc:* AND force attr order to
  // `value="..." unit="..."`. Hancom's stock margin children use that order;
  // if ours emit `unit="..." value="..."` instead, Hancom's load-time
  // normalizer treats the paraPr as foreign and silently downgrades any
  // BULLET/NUMBER heading on it (BULLET→NONE, NUMBER→BULLET) — which is
  // what was killing our list rendering in 한컴 docs web.
  const marginHc = margin
    .replace(/<hh:(intent|left|right|prev|next)\b([^/]*)\/>/g, (_, tag, attrs) => {
      const unitM = attrs.match(/unit="([^"]*)"/);
      const valueM = attrs.match(/value="([^"]*)"/);
      const v = valueM ? valueM[1] : '0';
      const u = unitM ? unitM[1] : 'HWPUNIT';
      return `<hc:${tag} value="${v}" unit="${u}"/>`;
    })
    .replace(/<\/hh:(intent|left|right|prev|next)>/g, '</hc:$1>');
  const block = marginHc + lineSpacing;
  const switchBlock =
    '<hp:switch>' +
      '<hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">' +
        block +
      '</hp:case>' +
      '<hp:default>' +
        block +
      '</hp:default>' +
    '</hp:switch>';
  return align + heading + breakSetting + autoSpacing + switchBlock + border;
}
function toggleChild(inner, tag, on) {
  const has = new RegExp(`<${tag.replace(/:/g, '\\:')}\\b[^>]*/?>`).test(inner);
  if (on && !has) return `<${tag}/>` + inner;
  if (!on && has) return inner.replace(new RegExp(`<${tag.replace(/:/g, '\\:')}\\b[^>]*/?>`, 'g'), '');
  return inner;
}
function ensureChild(inner, snippet, tag) {
  const has = new RegExp(`<${tag.replace(/:/g, '\\:')}\\b`).test(inner);
  return has ? inner : snippet + inner;
}

// ── image operations ─────────────────────────────────────────────────────────

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif' };

function findBinEntry(doc, target) {
  // Accept any of: "image1.png" / "image1" (stem only) / "BinData/image1.png" /
  // "BinData/image1". The stem fallback catches the common case where the
  // caller has the manifest id (extension-less) instead of the file name.
  const stem = (s) => s.replace(/\.[^/.]+$/, '');
  const bare = target.replace(/^BinData\//i, '');
  const bareStem = stem(bare);
  const names = Object.keys(doc.files).filter((n) => /^BinData\//i.test(n));
  return names.find((n) => {
    const base = n.replace(/^BinData\//i, '');
    return base === bare || stem(base) === bareStem;
  }) || null;
}

function opReplaceImage(doc, target, sourcePath) {
  const entry = findBinEntry(doc, target);
  if (!entry) throw new Error(`replace_image: target not found in BinData/: ${target}`);
  doc.files[entry] = new Uint8Array(fs.readFileSync(sourcePath));
  return { entry, bytes: doc.files[entry].byteLength };
}

function opDeleteImage(doc, target) {
  const entry = findBinEntry(doc, target);
  if (!entry) throw new Error(`delete_image: target not found in BinData/: ${target}`);
  // Resolve the manifest item id bound to this entry so we can also remove the
  // inline <hp:pic> that references it — otherwise the doc keeps a dangling
  // image reference (the bug in treesoop's delete: bytes gone, ref left).
  let itemId = null;
  const hpf = doc.hpfName();
  if (hpf) {
    let s = doc.read(hpf);
    const im = s.match(new RegExp(`<opf:item [^>]*id="([^"]+)"[^>]*href="${escapeRegex(entry)}"[^>]*/>|<opf:item [^>]*href="${escapeRegex(entry)}"[^>]*id="([^"]+)"[^>]*/>`));
    if (im) itemId = im[1] || im[2];
    s = s.replace(new RegExp(`<opf:item [^>]*href="${escapeRegex(entry)}"[^>]*/>`), '');
    doc.write(hpf, s);
  }
  let picsRemoved = 0;
  if (itemId) {
    for (const name of doc.sectionNames()) {
      let xml = doc.read(name);
      const pics = scanTopLevel(xml, 'hp:pic');
      let touched = false;
      // Splice from the end so earlier ranges stay valid.
      for (let i = pics.length - 1; i >= 0; i--) {
        if (new RegExp(`binaryItemIDRef="${escapeRegex(itemId)}"`).test(pics[i].inner)) {
          xml = spliceEl(xml, pics[i], '');
          picsRemoved++;
          touched = true;
        }
      }
      if (touched) doc.write(name, dropLinesegs(xml));
    }
  }
  delete doc.files[entry];
  return { entry, itemId, picsRemoved, deleted: true };
}

function opInsertImage(doc, sourcePath, ext, width, height) {
  ext = (ext || path.extname(sourcePath).slice(1) || 'png').toLowerCase();
  if (!MIME[ext]) throw new Error(`insert_image: unsupported ext .${ext} (png/jpg/bmp/gif)`);
  const existing = Object.keys(doc.files).filter((n) => /^BinData\//i.test(n));
  // itemId must be unique against existing manifest ids, not just filenames.
  const usedIds = new Set();
  const hpfPeek = doc.hpfName();
  if (hpfPeek) for (const m of doc.read(hpfPeek).matchAll(/<opf:item [^>]*id="([^"]+)"/g)) usedIds.add(m[1]);
  let n = 1;
  while (existing.some((p) => p.endsWith(`/image${n}.${ext}`) || p.endsWith(`/img${n}.${ext}`)) || usedIds.has(`image${n}`)) n++;
  const entry = `BinData/image${n}.${ext}`;
  const itemId = `image${n}`;
  doc.files[entry] = new Uint8Array(fs.readFileSync(sourcePath));
  // manifest
  const hpf = doc.hpfName();
  if (hpf) {
    let s = doc.read(hpf);
    if (!s.includes(`href="${entry}"`)) {
      s = s.replace(/<\/opf:manifest>/, `<opf:item id="${itemId}" href="${entry}" media-type="${MIME[ext]}" isEmbeded="1"/></opf:manifest>`);
      doc.write(hpf, s);
    }
  }
  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const paras = scanTopLevel(xml, 'hp:p');
  const charPrId = paras.length ? (paras[paras.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1] : '0';
  const attrs = paras.length ? paras[paras.length - 1].attrs.replace(/\s*id="\d+"/, ` id="${freshId()}"`) : ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0"`;
  const pic = buildPic(doc, itemId, width, height);
  const para = `<hp:p${attrs}><hp:run charPrIDRef="${charPrId}">${pic}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { entry, itemId, inserted: true };
}

// Build an inline <hp:pic> for a freshly-added image. Hancom Docs validates the
// shape schema strictly (requires hp:renderingInfo, hp:shapeComment; rejects a
// stray hp:caption), so we CLONE an existing pic from the document when one is
// present — guaranteed-valid structure — and only repoint its binary ref + ids.
// Falls back to a schema-complete template when the doc has no images yet.
function buildPic(doc, itemId, width, height) {
  for (const name of doc.sectionNames()) {
    const pics = scanTopLevel(doc.read(name), 'hp:pic');
    if (pics.length) {
      const xml = doc.read(name);
      let pic = xml.slice(pics[0].start, pics[0].end);
      pic = pic
        .replace(/binaryItemIDRef="[^"]*"/, `binaryItemIDRef="${itemId}"`)
        .replace(/\bid="\d+"/, `id="${freshId()}"`)
        .replace(/\binstid="\d+"/, `instid="${freshId()}"`);
      return pic;
    }
  }
  const w = width || 28350, h = height || 28350; // ~100mm fallback
  return `<hp:pic id="${freshId()}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${freshId()}" reverse="0">`
    + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>`
    + `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>`
    + `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
    + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:imgDim dimwidth="${w}" dimheight="${h}"/>`
    + `<hc:img binaryItemIDRef="${itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>inserted image</hp:shapeComment>`
    + `</hp:pic>`;
}

// ── header / footer operations ───────────────────────────────────────────────

// HWPX models headers and footers as control elements embedded in body XML:
// <hp:p><hp:run charPrIDRef="..."><hp:ctrl>
//   <hp:header id="0" applyPageType="BOTH"> | <hp:footer ...>
//     <hp:subList ...><hp:p ...><hp:run ...><hp:t>대외주의</hp:t></hp:run></hp:p></hp:subList>
//   </hp:header>
// </hp:ctrl></hp:run></hp:p>
//
// set: update existing one's text + applyPageType, or insert a new wrapper
//      paragraph right after the section's first <hp:p> (which holds <hp:secPr>).
// remove: drop the <hp:run> hosting the <hp:ctrl><hp:header/footer>; leave the
//         enclosing paragraph in place (it may have other content).

const VALID_APPLY = new Set(['BOTH', 'EVEN', 'ODD']);

function opSetHeaderFooter(doc, kind, text, applyPageType) {
  const tag = `hp:${kind}`;
  const apply = String(applyPageType || 'BOTH').toUpperCase();
  if (!VALID_APPLY.has(apply)) throw new Error(`set_${kind}: applyPageType must be one of BOTH/EVEN/ODD`);

  // Update first existing instance anywhere across sections.
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const els = scanTopLevel(xml, tag);
    if (!els.length) continue;
    const el = els[0];
    const newInner = setCellInner(el.inner, text); // header/footer share subList>p>run>t shape with cells
    let attrs = el.attrs;
    attrs = /applyPageType="[^"]*"/.test(attrs)
      ? attrs.replace(/applyPageType="[^"]*"/, `applyPageType="${apply}"`)
      : `${attrs} applyPageType="${apply}"`;
    const replacement = `<${tag}${attrs}>${newInner}</${tag}>`;
    doc.write(name, dropLinesegs(spliceEl(xml, el, replacement)));
    return { kind, applyPageType: apply, updated: true };
  }

  // None present — insert into the first section after its first body paragraph.
  const firstSec = doc.sectionNames()[0];
  if (!firstSec) throw new Error(`set_${kind}: no Contents/section*.xml found`);
  let xml = doc.read(firstSec);
  const paras = scanTopLevel(xml, 'hp:p');
  if (!paras.length) throw new Error(`set_${kind}: no <hp:p> in first section to anchor insertion`);
  const wrapper =
    `<hp:p id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
      `<hp:run charPrIDRef="0">` +
        `<hp:ctrl>` +
          `<${tag} id="0" applyPageType="${apply}">` +
            `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
              `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
                `<hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run>` +
              `</hp:p>` +
            `</hp:subList>` +
          `</${tag}>` +
        `</hp:ctrl>` +
      `</hp:run>` +
    `</hp:p>`;
  const insertAt = paras[0].end;
  doc.write(firstSec, dropLinesegs(xml.slice(0, insertAt) + wrapper + xml.slice(insertAt)));
  return { kind, applyPageType: apply, inserted: true };
}

function opRemoveHeaderFooter(doc, kind) {
  const tag = `hp:${kind}`;
  let removed = 0;
  for (const name of doc.sectionNames()) {
    let xml = doc.read(name);
    if (!xml.includes(`<${tag}`)) continue;
    const runs = scanTopLevel(xml, 'hp:run');
    let changed = false;
    // Splice from the end so earlier offsets remain valid.
    for (let i = runs.length - 1; i >= 0; i--) {
      if (!runs[i].self && runs[i].inner.includes(`<${tag}`)) {
        xml = spliceEl(xml, runs[i], '');
        removed++;
        changed = true;
      }
    }
    if (changed) doc.write(name, dropLinesegs(xml));
  }
  return { kind, removed };
}

// ── footnote / endnote operations ────────────────────────────────────────────

// Footnotes (각주) and endnotes (미주) are ctrl-embedded notes — same envelope
// shape as headers/footers (<hp:run><hp:ctrl><hp:footNote|endNote ...>subList>
// p>run>t). The reference marker (¹ ²) and bottom-of-page placement are
// rendered by Hancom from the control's position; we only place the control
// at the end of the target body paragraph.
//
// Note: rhwp's .hwp→.hwpx conversion drops actual notes (only emits the
// <hp:footNotePr> style declaration), so we can't clone a known-good real
// example — the template below follows the OWPML envelope used by the other
// ctrl elements in this skill and reuses safe default refs (id=0).

function opInsertNote(doc, kind, paragraphIndex, text) {
  const tag = `hp:${kind}`; // "footNote" or "endNote"
  const paras = doc.paragraphs();
  if (paragraphIndex < 0 || paragraphIndex >= paras.length) {
    throw new Error(`insert_${kind === 'footNote' ? 'footnote' : 'endnote'}: paragraph index ${paragraphIndex} out of range (0..${paras.length - 1})`);
  }
  const { section, el } = paras[paragraphIndex];
  const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const noteRun =
    `<hp:run charPrIDRef="${charPrId}">` +
      `<hp:ctrl>` +
        `<${tag} id="0">` +
          `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
            `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
              `<hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run>` +
            `</hp:p>` +
          `</hp:subList>` +
        `</${tag}>` +
      `</hp:ctrl>` +
    `</hp:run>`;
  const rebuilt = `<hp:p${el.attrs}>${el.inner + noteRun}</hp:p>`;
  doc.write(section, dropLinesegs(spliceEl(doc.read(section), el, rebuilt)));
  return { kind: kind === 'footNote' ? 'footnote' : 'endnote', index: paragraphIndex, inserted: true };
}

// ── hyperlink ────────────────────────────────────────────────────────────────

// HWPX models a hyperlink as a paired Hancom *field* embedded in a run:
// <hp:run>
//   <hp:ctrl><hp:fieldBegin id=B type="HYPERLINK" fieldid=F>
//              <hp:parameters cnt=6>… Path/Command/Category/TargetType/DocOpenType …</hp:parameters>
//            </hp:fieldBegin></hp:ctrl>
//   <hp:t>표시 텍스트</hp:t>
//   <hp:ctrl><hp:fieldEnd beginIDRef=B fieldid=F/></hp:ctrl>
// </hp:run>
// Template here mirrors a real government-doc instance verbatim (only the URL,
// display text, and id pair vary). Hancom renders the run's <hp:t> as a
// clickable link.
// Bookmark = named anchor at the start of a paragraph's first run, used as
// the jump target for cross-references / "Go to". The OWPML shape is a
// minimal self-closing element wrapped in <hp:ctrl>:
//   <hp:run charPrIDRef="N"><hp:ctrl><hp:bookmark name="…"/></hp:ctrl><hp:t>…</hp:t></hp:run>
function opInsertBookmark(doc, index, name) {
  if (!name) throw new Error('insert_bookmark: "name" is required');
  const paras = doc.paragraphs();
  if (!Number.isInteger(index) || index < 0 || index >= paras.length) {
    throw new Error(`insert_bookmark: index ${index} out of range (0..${paras.length - 1})`);
  }
  const { section, el } = paras[index];
  const ctrl = `<hp:ctrl><hp:bookmark name="${xmlEscape(name)}"/></hp:ctrl>`;
  let inner = el.inner;
  const runs = scanTopLevel(inner, 'hp:run');
  if (runs.length && !runs[0].selfClosing) {
    inner = inner.slice(0, runs[0].openEnd) + ctrl + inner.slice(runs[0].openEnd);
  } else {
    inner = `<hp:run charPrIDRef="0">${ctrl}</hp:run>` + inner;
  }
  doc.write(section, spliceEl(doc.read(section), el, `<hp:p${el.attrs}>${inner}</hp:p>`));
  return { index, name, inserted: true };
}

// Clone the paragraph's current charPr + paint it blue with a solid blue
// underline, then reuse a placeholder charPr (refCount=0) — same trick as
// apply_text_style. Result: the hyperlink run looks like a standard web
// link (blue + underline) on first render, instead of inheriting body text.
function ensureHyperlinkCharPr(doc, baseCharPrId) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('insert_hyperlink: Contents/header.xml missing');
  let header = doc.read(headerName);
  const charPrs = scanTopLevel(header, 'hh:charPr');
  if (!charPrs.length) throw new Error('insert_hyperlink: no <hh:charPr> in header.xml');
  const base = charPrs.find((c) => getAttr(c.attrs, 'id') === baseCharPrId) || charPrs[0];

  // wantInner = base.inner with underline set to BOTTOM SOLID #0000FF.
  const ul = '<hh:underline type="BOTTOM" shape="SOLID" color="#0000FF"/>';
  const wantInner = /<hh:underline\b[^/]*\/>/.test(base.inner)
    ? base.inner.replace(/<hh:underline\b[^/]*\/>/, ul)
    : base.inner + ul;
  // wantAttrs = base.attrs with textColor=#0000FF.
  const wantBaseAttrs = setOrAddAttr(base.attrs, 'textColor', '#0000FF').replace(/\s*id="\d+"/, '');

  // Exact reuse?
  for (const c of charPrs) {
    if (c.inner === wantInner && c.attrs.replace(/\s*id="\d+"/, '') === wantBaseAttrs) {
      return getAttr(c.attrs, 'id');
    }
  }

  // Placeholder reuse / append.
  const refCounts = buildCharPrRefCounts(doc);
  const placeholder = charPrs.find((c) => (refCounts[getAttr(c.attrs, 'id')] || 0) === 0 && getAttr(c.attrs, 'id') !== baseCharPrId);
  const useId = placeholder ? getAttr(placeholder.attrs, 'id')
                            : String(Math.max(...charPrs.map((c) => Number(getAttr(c.attrs, 'id') || 0))) + 1);
  const newAttrs = setOrAddAttr(base.attrs, 'textColor', '#0000FF').replace(/\s*id="\d+"/, ` id="${useId}"`);
  const updated = `<hh:charPr${newAttrs}>${wantInner}</hh:charPr>`;
  header = placeholder
    ? spliceEl(header, placeholder, updated)
    : bumpListCount(spliceEl(header, base, `<hh:charPr${base.attrs}>${base.inner}</hh:charPr>` + updated), 'hh:charProperties', +1);
  doc.write(headerName, header);
  return useId;
}

function opInsertHyperlink(doc, paragraphIndex, url, text) {
  if (!url) throw new Error('insert_hyperlink: "url" is required');
  if (!text) throw new Error('insert_hyperlink: "text" (display label) is required');
  const paras = doc.paragraphs();
  if (paragraphIndex < 0 || paragraphIndex >= paras.length) {
    throw new Error(`insert_hyperlink: paragraph index ${paragraphIndex} out of range (0..${paras.length - 1})`);
  }
  const { section, el } = paras[paragraphIndex];
  const baseCharPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const charPrId = ensureHyperlinkCharPr(doc, baseCharPrId);
  const beginId = freshId();
  const fieldid = freshId();
  const u = xmlEscape(url);
  const run =
    `<hp:run charPrIDRef="${charPrId}">` +
      `<hp:ctrl>` +
        `<hp:fieldBegin id="${beginId}" type="HYPERLINK" name="" editable="0" dirty="1" zorder="-1" fieldid="${fieldid}">` +
          `<hp:parameters cnt="6" name="">` +
            `<hp:integerParam name="Prop">0</hp:integerParam>` +
            `<hp:stringParam name="Command">${u};1;0;0;</hp:stringParam>` +
            `<hp:stringParam name="Path">${u}</hp:stringParam>` +
            `<hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam>` +
            `<hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_BOOKMARK</hp:stringParam>` +
            `<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam>` +
          `</hp:parameters>` +
        `</hp:fieldBegin>` +
      `</hp:ctrl>` +
      `<hp:t>${xmlEscape(text)}</hp:t>` +
      `<hp:ctrl><hp:fieldEnd beginIDRef="${beginId}" fieldid="${fieldid}"/></hp:ctrl>` +
    `</hp:run>`;
  // If the paragraph already has a single plain-text run, replace it — that
  // run's text is the user-visible label, which insert_hyperlink overwrites.
  // Without this, the original text and the hyperlink display label render
  // back-to-back. Multi-run or ctrl-bearing paragraphs append (don't drop
  // structural runs blindly).
  const runs = scanTopLevel(el.inner, 'hp:run');
  const onlyPlainText = (r) =>
    !/<hp:ctrl\b/.test(r.inner) &&
    /^\s*<hp:t[^>]*>[^<]*<\/hp:t>\s*$/.test(r.inner);
  const newInner = runs.length === 1 && onlyPlainText(runs[0])
    ? spliceEl(el.inner, runs[0], run)
    : el.inner + run;
  const rebuilt = `<hp:p${el.attrs}>${newInner}</hp:p>`;
  doc.write(section, dropLinesegs(spliceEl(doc.read(section), el, rebuilt)));
  return { index: paragraphIndex, url, text, beginId, fieldid, inserted: true };
}

// ── field operation ──────────────────────────────────────────────────────────

function opSetFieldValue(doc, name, value) {
  let done = 0;
  for (const sec of doc.sectionNames()) {
    if (done) break;
    let xml = doc.read(sec);
    const beginRe = new RegExp(`<hp:fldBegin[^>]*name="${escapeRegex(name)}"[^>]*/?>`);
    const bm = beginRe.exec(xml);
    if (!bm) continue;
    const after = bm.index + bm[0].length;
    const endRe = /<hp:fldEnd[^>]*\/?>/g; endRe.lastIndex = after;
    const em = endRe.exec(xml);
    if (!em) continue;
    const between = xml.slice(after, em.index).replace(/<hp:t>[^<]*<\/hp:t>/, `<hp:t>${xmlEscape(value)}</hp:t>`);
    doc.write(sec, xml.slice(0, after) + between + xml.slice(em.index));
    done = 1;
  }
  return { name, value, set: done };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function applyOp(doc, op) {
  switch (op.type) {
    case 'replace_text': return opReplaceText(doc, op.find, op.replace);
    case 'fill_template': return opFillTemplate(doc, op.values);
    case 'set_paragraph_text': return opSetParagraphText(doc, op.index, op.text);
    case 'append_paragraph': return opAppendParagraph(doc, op.text);
    case 'delete_paragraph': return opDeleteParagraph(doc, op.index);
    case 'set_cell_text': return opSetCellText(doc, op.table, op.row, op.col, op.text);
    case 'append_table_row': return opAppendTableRow(doc, op.table, op.cells);
    case 'delete_table_row': return opDeleteTableRow(doc, op.table, op.row);
    case 'append_table_column': return opAppendTableColumn(doc, op.table, op.cells);
    case 'delete_table_column': return opDeleteTableColumn(doc, op.table, op.col);
    case 'merge_cells': return opMergeCells(doc, op.table, op.mode, op);
    case 'insert_table': return opInsertTable(doc, op.index, op.rows, op.cols, op.cells);
    case 'set_cell_background': return opSetCellBackground(doc, op.table, op.row, op.col, op.color);
    case 'set_cell_border': return opSetCellBorder(doc, op.table, op.row, op.col, op.color, op.width, op.sides);
    case 'set_cell_diagonal': return opSetCellDiagonal(doc, op.table, op.row, op.col, op.direction, op.color, op.width);
    case 'set_cell_align': return opSetCellAlign(doc, op.table, op.row, op.col, op.horizontal, op.vertical);
    case 'set_cell_size': return opSetCellSize(doc, op.table, op.row, op.col, op.width, op.height);
    case 'set_page_break': return opSetPageBreak(doc, op.index, op.on);
    case 'set_bullet_list': return opSetParagraphList(doc, op.index, 'BULLET', op.level, { char: op.char });
    case 'set_number_list': return opSetParagraphList(doc, op.index, 'NUMBER', op.level, { style: op.style });
    case 'clear_list': return opSetParagraphList(doc, op.index, 'NONE', 0);
    case 'apply_text_style': return opApplyTextStyle(doc, op.target, op);
    case 'apply_paragraph_style': return opApplyParagraphStyle(doc, op.index, op);
    case 'insert_image': return opInsertImage(doc, op.source, op.ext, op.width, op.height);
    case 'replace_image': return opReplaceImage(doc, op.target, op.source);
    case 'delete_image': return opDeleteImage(doc, op.target);
    case 'set_field_value': return opSetFieldValue(doc, op.name, op.value);
    case 'set_header': return opSetHeaderFooter(doc, 'header', op.text, op.applyPageType);
    case 'set_footer': return opSetHeaderFooter(doc, 'footer', op.text, op.applyPageType);
    case 'remove_header': return opRemoveHeaderFooter(doc, 'header');
    case 'remove_footer': return opRemoveHeaderFooter(doc, 'footer');
    case 'insert_footnote': return opInsertNote(doc, 'footNote', op.index, op.text);
    case 'insert_endnote': return opInsertNote(doc, 'endNote', op.index, op.text);
    case 'insert_hyperlink': return opInsertHyperlink(doc, op.index, op.url, op.text);
    case 'insert_bookmark': return opInsertBookmark(doc, op.index, op.name);
    default: throw new Error(`unknown operation type: ${op.type}`);
  }
}

function save(doc, outputPath) {
  // Write dirty text files back into the byte map, then zip.
  for (const name of doc.dirty) doc.files[name] = strToU8(doc.text[name]);
  // mimetype must be the first entry and STORED (uncompressed) per HWPX spec.
  const zippable = {};
  if (doc.files['mimetype']) zippable['mimetype'] = [doc.files['mimetype'], { level: 0 }];
  for (const [name, bytes] of Object.entries(doc.files)) {
    if (name === 'mimetype') continue;
    zippable[name] = bytes;
  }
  const out = zipSync(zippable, { level: 6 });
  fs.writeFileSync(outputPath, out);
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { fail(`invalid JSON on stdin: ${e.message}`); }
  const inputPath = payload.path;
  if (!inputPath) fail('payload.path is required');
  if (!/\.hwpx$/i.test(inputPath)) fail(`hwpx-edit.js is .hwpx only — got ${path.extname(inputPath)} (use cell-patch.js / convert.js for .hwp)`);
  if (!fs.existsSync(inputPath)) fail(`file not found: ${inputPath}`);
  const bytes = fs.readFileSync(inputPath);
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) fail('not a ZIP-based .hwpx (first bytes are not "PK")');

  const outputPath = payload.output && payload.output.length
    ? payload.output
    : inputPath.replace(/\.hwpx$/i, '_edited.hwpx');

  const doc = new Hwpx(unzipSync(bytes));
  const ops = Array.isArray(payload.operations) ? payload.operations : [];
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      results.push({ type: ops[i].type, ...applyOp(doc, ops[i]) });
    } catch (e) {
      fail(`operation ${i} (${ops[i] && ops[i].type}) failed: ${e && e.message ? e.message : String(e)}`, { results });
    }
  }
  save(doc, outputPath);
  process.stdout.write(JSON.stringify({ ok: true, output: outputPath, results }, null, 2) + '\n');
}

function fail(message, extra) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...(extra || {}) }, null, 2) + '\n');
  process.exit(1);
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
