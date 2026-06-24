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
//   set_cell_margin       { table, row, col, to_row?, to_col?, left?, right?, top?, bottom? }  // 셀 안 여백(mm); to_*로 범위
//   set_table_margin      { table, left?, right?, top?, bottom? }           // 표 바깥 여백(mm) = 표↔본문 간격
//   set_table_inner_margin{ table, left?, right?, top?, bottom? }           // 표 '모든 셀' 기본 안 여백(mm)
//   set_table_size        { table, width_mm?, height_mm? }                  // 표 전체 크기 — 열/행 비례 스케일(한컴이 sz를 셀합으로 재계산하므로)
//   set_table_props       { table, wrap?, page_split?, repeat_header? }     // wrap=inline|square|topbottom|front|behind; page_split=none|cell|table; repeat_header=bool(머리행 반복)
//   set_title_cell        { table, row, col, on? }                          // <hp:tc header="1"> (머리 행 셀)
//   set_cell_image        { table, row, col, source, ext?, width_mm?, height_mm? }   // 이미지를 셀 안에(inline) — 셀폭 자동맞춤+가운데+사방 여백
//   set_cell_shape        { table, row, col, shape, width_mm?, height_mm?, fill_color?, line_color?, line_width_mm? }  // 도형(rect/ellipse/line)을 셀 안에(inline)
//   set_cell_chart        { table, row, col, chart_type?, cat?, series?, width_mm?, height_mm? }   // 차트를 셀 안에(inline) — insert_chart와 같은 데이터, 셀 자동맞춤
//   set_cell_equation     { table, row, col, script, width_mm?, height_mm? }   // 수식을 셀 안에(inline)
//   set_table_split_border{ table, line_type?, width_mm?, color? }          // 여러 쪽 자동분할 표 경계선(borderFill breakCellSeparateLine + diagonal, pageBreak=CELL)
//   set_object_size       { target, index, width_mm?, height_mm? }          // 그림/도형/차트 크기 (target=image|shape|chart)
//   set_object_position   { target, index, x_mm?, y_mm?, wrap? }            // 위치(종이기준)+배치(wrap=inline|square|topbottom|front|behind)
//   set_object_margin     { target, index, left?, right?, top?, bottom? }   // 객체↔글 간격(mm)
//   set_object_border     { target, index, color?, width_mm?, line_type?, arrow_start?, arrow_end? }  // 선/화살표 (도형)
//   set_object_fill       { target, index, color?, transparency?, pattern?, pattern_color? }          // 채우기 색/투명도/무늬 (도형)
//   set_page_break        { index, on? }                                   // sets <hp:p pageBreak="1"> before paragraph index
//   set_bullet_list       { index, char?, level? }                        // bullet (• default; char="▶"|"◯"|"□"|"★" etc. registers a new bullet entry)
//   set_number_list       { index, level?, style? }                        // numbered list — `style: "korean"` → 1./가./1)/가); `style: "decimal"` → 1./1.1./1.1.1.; omit → use doc's existing numbering id=1 (varies by template)
//   clear_list            { index }                                        // removes list formatting
//   apply_text_style      { target, color?, bold?, italic?, underline?, size_pt? (points; or raw size? in HWP units), highlight?, strikethrough?, supscript?, subscript?, fontFace?, letter_spacing? (자간 %), char_ratio? (장평 %) }
//   apply_paragraph_style { index, align?, indent?, lineSpacing? }
//   insert_image          { source, ext?, width_mm?, height_mm? (or raw width?/height? in HWPUNIT) }
//   replace_image         { target, source }
//   delete_image          { target }
//   set_field_value       { name, value }
//   set_header            { text, applyPageType?, align? }   // applyPageType: BOTH|EVEN|ODD (default BOTH); align: LEFT|CENTER|RIGHT
//   set_footer            { text, applyPageType?, align? }
//   remove_header         { }
//   remove_footer         { }
//   insert_footnote       { index, text }    // appends a footnote at end of paragraph `index`
//   insert_endnote        { index, text }    // same shape, endnote
//   insert_hyperlink      { index, url, text } // appends a clickable URL link to paragraph `index`
//   insert_bookmark       { index, name }      // anchors a named bookmark at the start of paragraph `index`'s first run
//   insert_equation       { script, index? }   // inserts a Hancom equation (script = equation-syntax); new paragraph after index, else appended
//   set_columns           { count, gap_mm? }    // multi-column (단) layout; count=1 resets to single, count>=2 = newspaper columns
//   set_page_setup        { size?, orientation?, width_mm?, height_mm?, margin_mm? }  // 편집 용지 (paper size/orientation/margins)
//   insert_chart          { chart_type?, cat?, series? }  // chart: col/bar/line/area/pie (or 0-19); series=[{name,values:[]}], cat=[labels]
//   insert_shape          { shape, index?, width_mm?, height_mm?, fill_color?, line_color? }  // 도형: rect | ellipse | line
//   set_column_break      { index, on? }    // 단 나누기 (column break before paragraph index)
//   insert_table_row      { table, row, where?, cells? }  // 줄 추가 — before/after row index (renumbers rowAddr)
//   insert_table_column   { table, col, where?, cells? }  // 칸 추가 — before/after col index (renumbers colAddr)
//   distribute_table      { table, mode? }    // 높이/너비 같게 — mode: width | height | both
//   insert_textbox        { text, index?, width_mm?, height_mm?, fill_color?, line_color? }  // 글상자 (rect + drawText)
//   set_page_number       { where?, align? }   // 쪽 번호 — where: footer|header, align: LEFT|CENTER|RIGHT
//   split_cell            { table, row, col, rows?, cols? }  // 셀 나누기 — split one cell into rows×cols
//   set_caption           { target?, index?, text, side?, gap_mm? }  // 캡션 — target: image|chart|shape|table
//   apply_style           { index, style }   // 스타일 적용 — style: name ("개요 1"/"본문") or id
//   para_line             { index, fill_color?, border_color?, border_width_mm?, sides? }  // 문단 띠 (테두리·배경)
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
  // EVERY <hp:tbl> across sections — nested included — in document (pre-order)
  // order, each with absolute section offsets so spliceEl edits work on nested
  // tables too. Index matches `--inspect` table count. Many Korean 서식 wrap the
  // fillable grid in an outer table, so cell ops must reach nested tables.
  tablesDeep() {
    const list = [];
    for (const name of this.sectionNames()) {
      const xml = this.read(name);
      const walk = (s, base) => {
        for (const el of scanTopLevel(s, 'hp:tbl')) {
          list.push({ section: name, el: {
            start: base + el.start, end: base + el.end,
            openEnd: base + el.openEnd, attrs: el.attrs, inner: el.inner,
          } });
          walk(el.inner, base + el.openEnd);
        }
      };
      walk(xml, 0);
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
// Inline control elements Hancom embeds inside a text node, splitting the visible
// string (full-width space, tab, line break, hyphen…). They carry no char in `find`,
// so they're treated as zero-width when matching (a natural `find` still matches
// across them) and only the ones inside a match are dropped.
const INLINE_CTRL_SRC = '<hp:(?:fwSpace|tab|lineBreak|hyphen|nbSpace|titleMark|insertBegin|insertEnd)\\b[^>]*\\/>';

// Tokenize a text+inline-control stream into [{t:1,raw}|{t:0,raw}] tokens, copying
// any extra fields from `tag` (e.g. the source run index) onto each token.
function tokenizeStream(stream, tag) {
  const toks = []; const re = new RegExp(INLINE_CTRL_SRC, 'g'); let last = 0, m;
  while ((m = re.exec(stream))) {
    if (m.index > last) toks.push({ t: 1, raw: stream.slice(last, m.index), ...tag });
    toks.push({ t: 0, raw: m[0], ...tag });
    last = m.index + m[0].length;
  }
  if (last < stream.length) toks.push({ t: 1, raw: stream.slice(last), ...tag });
  return toks;
}

// Splice every `find`→`replace` in a token list, matching against the control-
// stripped text. Text/controls inside a match are dropped; the replacement lands in
// the first overlapped TEXT token (keeping its tag, e.g. run index); tokens outside
// the match are preserved. Returns {toks, count}.
function spliceTokenList(toks, find, replace) {
  let count = 0, guard = 0, cur = toks;
  for (;;) {
    if (guard++ > 4000) break;
    const norm = cur.map((x) => (x.t ? x.raw : '')).join('');
    const s = norm.indexOf(find); if (s < 0) break;
    const e = s + find.length;
    const out = []; let pos = 0, inserted = false;
    for (const x of cur) {
      if (!x.t) { if (!(pos > s && pos < e)) out.push(x); continue; } // control: drop only if strictly inside
      const ts = pos, te = pos + x.raw.length; pos = te;
      if (te <= s || ts >= e) { out.push(x); continue; } // text token outside the match
      const before = ts < s ? x.raw.slice(0, s - ts) : '';
      const after = te > e ? x.raw.slice(e - ts) : '';
      const merged = before + (inserted ? '' : xmlEscape(replace)) + after;
      inserted = true;
      if (merged) out.push({ ...x, raw: merged });
    }
    cur = out; count++;
  }
  return { toks: cur, count };
}

// Control-aware replace inside one <hp:t> body (single node). See INLINE_CTRL_SRC.
function spliceNodeTokens(content, find, replace) {
  const r = spliceTokenList(tokenizeStream(content, null), find, replace);
  return { content: r.toks.map((x) => x.raw).join(''), count: r.count };
}

// Replace `find` even when it spans several <hp:t> nodes / adjacent text-runs of a
// paragraph — a placeholder typed with mixed formatting, or a name/date/author line
// sprinkled with <hp:fwSpace/> across runs (both very common in Korean forms), is
// stored as multiple <hp:run> siblings so the per-node pass can't see it. We group
// maximal runs of consecutive TEXT runs (a run with no nested run and no embedded
// object), flatten their text+controls into one token list, splice, and rebuild each
// run — the replacement inherits the first overlapped run's formatting; emptied runs
// keep an empty <hp:t/>. Object/table runs are never grouped, so they stay intact;
// cell-paragraph runs ARE reached (so a split label inside a table cell still fills).
function replaceTextAcrossRuns(xml, find, replace) {
  const RUN = /<hp:run\b[^>]*>(?:(?!<\/?hp:run\b)[\s\S])*?<\/hp:run>/g;
  const OBJ = /<hp:(?:pic|chart|tbl|ellipse|rect|line|arc|polygon|curve|equation|container|ole|video|textart|connectLine|compose|dutmal|drawText)\b/;
  const isText = (r) => r.includes('<hp:t') && !OBJ.test(r);
  const runs = []; let m;
  while ((m = RUN.exec(xml))) runs.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  if (!runs.length) return { xml, count: 0 };
  // Group consecutive text runs separated only by whitespace (same paragraph).
  const groups = []; let g = null;
  for (const r of runs) {
    if (isText(r.raw) && g && /^\s*$/.test(xml.slice(g.end, r.start))) { g.runs.push(r); g.end = r.end; }
    else if (isText(r.raw)) { g = { runs: [r], start: r.start, end: r.end }; groups.push(g); }
    else g = null;
  }
  let count = 0, out = xml;
  for (let gi = groups.length - 1; gi >= 0; gi--) { // last→first so byte offsets stay valid
    const grp = groups[gi];
    let toks = []; const opens = [];
    grp.runs.forEach((r, idx) => {
      const open = r.raw.match(/^<hp:run\b[^>]*>/)[0];
      opens.push(open);
      const inner = r.raw.slice(open.length, r.raw.length - '</hp:run>'.length);
      const stream = inner.replace(/<hp:t(?:\s[^>]*)?>/g, '').replace(/<\/hp:t>/g, ''); // text + inline controls
      toks = toks.concat(tokenizeStream(stream, { run: idx }));
    });
    if (!toks.map((x) => (x.t ? x.raw : '')).join('').includes(find)) continue;
    const r = spliceTokenList(toks, find, replace);
    count += r.count;
    const byRun = grp.runs.map(() => []);
    for (const x of r.toks) byRun[x.run].push(x.raw);
    const rebuilt = grp.runs.map((_, idx) => `${opens[idx]}<hp:t>${byRun[idx].join('')}</hp:t></hp:run>`).join('');
    out = out.slice(0, grp.start) + rebuilt + out.slice(grp.end);
  }
  return { xml: out, count };
}

function opReplaceText(doc, find, replace) {
  if (!find) throw new Error('replace_text: "find" is required and non-empty');
  // Capture the WHOLE <hp:t> body ([\s\S]*?, not [^<]*) so inline controls inside
  // it are visible to the splicer; spliceNodeTokens then matches THROUGH them
  // (<hp:fwSpace/> etc. are zero-width for matching), so a natural `find` like
  // "2017. 3. 28(금)" fills even though it's stored "2017.<hp:fwSpace/> 3. 28(금)".
  const nodeRe = /(<hp:t(?:\s[^>]*)?>)([\s\S]*?)(<\/hp:t>)/g;
  let total = 0;
  for (const name of doc.sectionNames()) {
    let changed = false;
    // Pass 1 — within a single text node (control-aware).
    let xml = doc.read(name).replace(nodeRe, (m, open, text, close) => {
      const r = spliceNodeTokens(text, find, replace);
      if (!r.count) return m;
      total += r.count;
      changed = true;
      return open + r.content + close;
    });
    // Pass 2 — match across adjacent text-runs (placeholder split by formatting).
    const cross = replaceTextAcrossRuns(xml, find, replace);
    if (cross.count) { xml = cross.xml; total += cross.count; changed = true; }
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
  // Deep enumeration (nested tables included), document order == `--inspect`.
  const tables = doc.tablesDeep();
  if (tableIndex < 0 || tableIndex >= tables.length) throw new Error(`table index ${tableIndex} out of range (found ${tables.length})`);
  return tables[tableIndex];
}

// Set the inner text of one <hp:tc>, collapsing its first paragraph to a single
// run. Preserves the <hp:subList> wrapper and trailing cell metadata.
function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// Length-preserving fill for a positioning-layout cell ("라벨   (마커)" — label +
// padding spaces + a marker pinned at a fixed column). Whole-cell overwrite would
// shift the marker / wrap the line if the new string differs in length, so when
// `fit` is on we splice the value INTO the longest run of 2+ spaces and delete
// exactly as many spaces as we add (keeping one leading space off the label).
// Same algorithm as the .hwp path (cell-patch.js fitValueIntoLayout, commit bb02bfd).
// Falls back to the raw value when there's no padding run big enough to absorb it.
function fitValueIntoLayout(orig, value) {
  let best = null;
  const re = / {2,}/g;
  let m;
  while ((m = re.exec(orig)) !== null) {
    if (!best || m[0].length > best.len) best = { idx: m.index, len: m[0].length };
  }
  if (!best || best.len < value.length) return value; // not enough padding → no-op-ish (use value)
  const keep = best.len > value.length ? 1 : 0;
  return orig.slice(0, best.idx + keep) + value + orig.slice(best.idx + keep + value.length);
}

function setCellInner(tcInner, text, fit) {
  // The first <hp:p> inside the subList holds the cell content.
  const subs = scanTopLevel(tcInner, 'hp:subList');
  if (!subs.length) return tcInner;
  const sub = subs[0];
  const ps = scanTopLevel(sub.inner, 'hp:p');
  if (!ps.length) return tcInner;
  const p = ps[0];
  // fit = preserve the cell's visual length. Read the current text (merged <hp:t>
  // runs, un-escaped) and splice the value in without changing total length. Skip
  // when the paragraph hosts an inline control/object (field/image/nested table/…)
  // — we can't cleanly isolate the text there, so write the value as-is.
  if (fit) {
    const hasInline = /<hp:(ctrl|pic|tbl|chart|equation|rect|ellipse|line|arc|polygon|curve|connectLine|drawText)\b/.test(p.inner);
    if (!hasInline) {
      const orig = xmlUnescape((p.inner.match(/<hp:t>([^<]*)<\/hp:t>/g) || []).map((t) => t.replace(/<\/?hp:t>/g, '')).join(''));
      text = fitValueIntoLayout(orig, text);
    }
  }
  const charPrId = (p.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const newP = `<hp:p${p.attrs}>${runWithText(charPrId, text)}</hp:p>`;
  const newSubInner = spliceEl(sub.inner, p, newP);
  const newSub = `<hp:subList${sub.attrs}>${newSubInner}</hp:subList>`;
  return spliceEl(tcInner, sub, newSub);
}

function opSetCellText(doc, tableIndex, row, col, text, fit) {
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
  const newTcInner = setCellInner(tc.inner, text, fit);
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

// Insert a row at a position (줄 추가 — 위/아래). Clones row `row` for shape,
// fills `cells`, inserts before (default) or after it, then normalizes every
// cell's rowAddr to its row index so the cellAddr grid stays consistent.
function opInsertTableRow(doc, tableIndex, row, where, cells) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (!rows.length) throw new Error('insert_table_row: table has no rows');
  const refIdx = Math.max(0, Math.min(row != null ? Number(row) : rows.length - 1, rows.length - 1));
  const ref = rows[refIdx];
  const tcs = scanTopLevel(ref.inner, 'hp:tc');
  let acc = '';
  for (let ci = 0; ci < tcs.length; ci++) {
    const cellInner = setCellInner(tcs[ci].inner, (cells && cells[ci] != null) ? cells[ci] : '');
    acc += freshenIds(`<hp:tc${tcs[ci].attrs}>${cellInner}</hp:tc>`);
  }
  const newRow = `<hp:tr${ref.attrs}>${acc}</hp:tr>`;
  const refFull = `<hp:tr${ref.attrs}>${ref.inner}</hp:tr>`;
  tbl = spliceEl(tbl, ref, where === 'after' ? refFull + newRow : newRow + refFull);
  // Normalize rowAddr = row index (splice high→low so offsets stay valid).
  const all = scanTopLevel(tbl, 'hp:tr');
  for (let r = all.length - 1; r >= 0; r--) {
    const fixed = all[r].inner.replace(/(<hp:cellAddr\b[^>]*\browAddr=")\d+(")/g, (m, a, b) => a + r + b);
    if (fixed !== all[r].inner) tbl = spliceEl(tbl, all[r], `<hp:tr${all[r].attrs}>${fixed}</hp:tr>`);
  }
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${bumpRowCnt(el.attrs, +1)}>${tbl}</hp:tbl>`));
  return { table: tableIndex, insertedAt: where === 'after' ? refIdx + 1 : refIdx, rows: all.length };
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

// Insert a column at a position (칸 추가 — 왼/오른쪽). For each row clones cell
// `col`, fills `cells[r]`, inserts before/after it, then normalizes colAddr.
function opInsertTableColumn(doc, tableIndex, col, where, cells) {
  const { section, el } = getTable(doc, tableIndex);
  let tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  for (let r = rows.length - 1; r >= 0; r--) {
    const rowEl = rows[r];
    const tcs = scanTopLevel(rowEl.inner, 'hp:tc');
    if (!tcs.length) continue;
    const refIdx = Math.max(0, Math.min(col != null ? Number(col) : tcs.length - 1, tcs.length - 1));
    const ref = tcs[refIdx];
    const cellInner = setCellInner(ref.inner, (cells && cells[r] != null) ? cells[r] : '');
    const newTc = freshenIds(`<hp:tc${ref.attrs}>${cellInner}</hp:tc>`);
    const refFull = `<hp:tc${ref.attrs}>${ref.inner}</hp:tc>`;
    let rowInner = spliceEl(rowEl.inner, ref, where === 'after' ? refFull + newTc : newTc + refFull);
    const cells2 = scanTopLevel(rowInner, 'hp:tc');
    for (let c = cells2.length - 1; c >= 0; c--) {
      const fixedInner = cells2[c].inner.replace(/(<hp:cellAddr\b[^>]*\bcolAddr=")\d+(")/, (m, a, b) => a + c + b);
      rowInner = spliceEl(rowInner, cells2[c], `<hp:tc${cells2[c].attrs}>${fixedInner}</hp:tc>`);
    }
    tbl = spliceEl(tbl, rowEl, `<hp:tr${rowEl.attrs}>${rowInner}</hp:tr>`);
  }
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${bumpColCnt(el.attrs, +1)}>${tbl}</hp:tbl>`));
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

// Read/write the numeric attr of a tc's <hp:cellAddr|cellSpan|cellSz> child.
function tcTagAttr(inner, tag, name) {
  const m = inner.match(new RegExp(`<hp:${tag}\\b([^>]*?)/?>`));
  const v = m ? getAttr(m[1], name) : null;
  return v == null ? null : Number(v);
}
function setTcTagAttr(inner, tag, name, val) {
  return inner.replace(new RegExp(`(<hp:${tag}\\b[^>]*?\\b${name}=")\\d+(")`), `$1${val}$2`);
}

// Split one table cell into nRows × nCols sub-cells (셀 나누기). Grid model
// verified against Hancom-native ground truth (claw-hancomdocs split → download):
// splitting a 1×1 cell inserts (nCols-1) grid columns and/or (nRows-1) grid rows
// at the cell's position; every other cell that SPANS the split axis grows its
// span to keep covering it, and cells past the split shift their addr. The target
// becomes an N×M block of fresh 1×1 cells (top-left keeps the text, rest empty).
function opSplitCell(doc, tableIndex, row, col, nRows, nCols) {
  nRows = Math.max(1, Number(nRows) || 1);
  nCols = Math.max(1, Number(nCols) || 1);
  if (nRows < 2 && nCols < 2) throw new Error('split_cell: need rows>=2 or cols>=2');
  const { section, el } = getTable(doc, tableIndex);
  const rowsEls = scanTopLevel(el.inner, 'hp:tr');
  // Locate the target cell by its (colAddr, rowAddr) grid address.
  let targetTrIdx = -1, target = null;
  for (let r = 0; r < rowsEls.length; r++) {
    const hit = scanTopLevel(rowsEls[r].inner, 'hp:tc').find(
      (tc) => tcTagAttr(tc.inner, 'cellAddr', 'colAddr') === col && tcTagAttr(tc.inner, 'cellAddr', 'rowAddr') === row);
    if (hit) { targetTrIdx = r; target = hit; break; }
  }
  if (!target) throw new Error(`split_cell: cell (row ${row}, col ${col}) not found in table ${tableIndex}`);
  if ((tcTagAttr(target.inner, 'cellSpan', 'colSpan') || 1) !== 1 || (tcTagAttr(target.inner, 'cellSpan', 'rowSpan') || 1) !== 1)
    throw new Error('split_cell: target is a merged cell — unmerge (merge boundaries) before splitting');
  const tW = tcTagAttr(target.inner, 'cellSz', 'width') || 1, tH = tcTagAttr(target.inner, 'cellSz', 'height') || 1;
  const subW = Math.max(1, Math.round(tW / nCols)), subH = Math.max(1, Math.round(tH / nRows));
  const dM = nCols - 1, dN = nRows - 1;

  // Build one fresh 1×1 sub-cell from the target template at grid (c, r).
  const subCell = (c, r, empty) => {
    let inner = target.inner;
    inner = setTcTagAttr(setTcTagAttr(inner, 'cellAddr', 'colAddr', c), 'cellAddr', 'rowAddr', r);
    inner = setTcTagAttr(setTcTagAttr(inner, 'cellSpan', 'colSpan', 1), 'cellSpan', 'rowSpan', 1);
    inner = setTcTagAttr(setTcTagAttr(inner, 'cellSz', 'width', subW), 'cellSz', 'height', subH);
    if (empty) inner = setCellInner(inner, '');
    return freshenIds(`<hp:tc${target.attrs}>${inner}</hp:tc>`);
  };

  const newRows = [];
  for (let r = 0; r < rowsEls.length; r++) {
    const rowEl = rowsEls[r];
    const pieces = [];
    for (const tc of scanTopLevel(rowEl.inner, 'hp:tc')) {
      const ca = tcTagAttr(tc.inner, 'cellAddr', 'colAddr'), ra = tcTagAttr(tc.inner, 'cellAddr', 'rowAddr');
      const cs = tcTagAttr(tc.inner, 'cellSpan', 'colSpan') || 1, rs = tcTagAttr(tc.inner, 'cellSpan', 'rowSpan') || 1;
      if (r === targetTrIdx && ca === col && ra === row) {
        // Target's own (top) band: M sub-cells across, top-left keeps content.
        for (let dc = 0; dc < nCols; dc++) pieces.push(subCell(col + dc, row, dc !== 0));
        continue;
      }
      let inner = tc.inner, nca = ca, nra = ra, ncs = cs, nrs = rs;
      if (ca > col) nca = ca + dM;                              // shift cells right of the split
      else if (ca <= col && ca + cs - 1 >= col) ncs = cs + dM;  // grow cells spanning the split column
      if (ra > row) nra = ra + dN;                             // shift cells below the split
      else if (ra <= row && ra + rs - 1 >= row) nrs = rs + dN;  // grow cells spanning the split row
      inner = setTcTagAttr(setTcTagAttr(inner, 'cellAddr', 'colAddr', nca), 'cellAddr', 'rowAddr', nra);
      inner = setTcTagAttr(setTcTagAttr(inner, 'cellSpan', 'colSpan', ncs), 'cellSpan', 'rowSpan', nrs);
      pieces.push(`<hp:tc${tc.attrs}>${inner}</hp:tc>`);
    }
    newRows.push(`<hp:tr${rowEl.attrs}>${pieces.join('')}</hp:tr>`);
    // After the target's row, insert dN new grid rows, each holding only the M
    // target sub-cells (other columns are covered by the rowSpan-extended cells).
    if (r === targetTrIdx && dN > 0) {
      for (let dr = 1; dr <= dN; dr++) {
        const cells = [];
        for (let dc = 0; dc < nCols; dc++) cells.push(subCell(col + dc, row + dr, true));
        newRows.push(`<hp:tr${rowEl.attrs}>${cells.join('')}</hp:tr>`);
      }
    }
  }
  let newAttrs = el.attrs;
  if (dM) newAttrs = bumpColCnt(newAttrs, dM);
  if (dN) newAttrs = bumpRowCnt(newAttrs, dN);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${newAttrs}>${dropLinesegs(newRows.join(''))}</hp:tbl>`));
  return { table: tableIndex, row, col, intoRows: nRows, intoCols: nCols };
}

// Attach a caption (캡션, e.g. "그림 1." / "표 1.") to an object. Structure
// verified against Hancom-native ground truth (image caption via claw-hancomdocs
// → download): <hp:caption side= fullSz="0" width= gap= lastWidth="0"> holding a
// subList>p>run>t, placed as the LAST child of the object element (after
// shapeComment for pic/shape/chart). Tables carry it right after the shape-header
// group (sz/pos/outMargin/inMargin), before the rows.
const CAPTION_SIDES = new Set(['BOTTOM', 'TOP', 'LEFT', 'RIGHT']);
const CAPTION_TARGETS = { image: ['hp:pic'], chart: ['hp:chart'], shape: ['hp:rect', 'hp:ellipse', 'hp:line'], table: ['hp:tbl'] };
function opSetCaption(doc, target, index, text, side, gapMm) {
  target = String(target || 'image').toLowerCase();
  const tags = CAPTION_TARGETS[target];
  if (!tags) throw new Error(`set_caption: target must be one of ${Object.keys(CAPTION_TARGETS).join('/')}`);
  if (text == null || text === '') throw new Error('set_caption: text is required');
  const idx = Math.max(0, Number(index) || 0);
  const sd = String(side || 'BOTTOM').toUpperCase();
  if (!CAPTION_SIDES.has(sd)) throw new Error('set_caption: side must be BOTTOM/TOP/LEFT/RIGHT');
  const gap = gapMm != null ? Math.max(0, Math.round(Number(gapMm) * 283.46)) : 850; // ~3mm default
  let seen = 0;
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const matches = [];
    for (const tag of tags) for (const el of scanTopLevel(xml, tag)) matches.push({ tag, el });
    matches.sort((a, b) => a.el.start - b.el.start);
    for (const { tag, el } of matches) {
      if (seen++ !== idx) continue;
      const szM = el.inner.match(/<hp:sz\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
      const ow = szM ? Number(szM[1]) : 14173, oh = szM ? Number(szM[2]) : 8504;
      const capW = (sd === 'BOTTOM' || sd === 'TOP') ? ow : oh;
      const caption =
        `<hp:caption side="${sd}" fullSz="0" width="${capW}" gap="${gap}" lastWidth="0">` +
          `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
            `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run></hp:p>` +
          `</hp:subList></hp:caption>`;
      let inner = el.inner.replace(/<hp:caption\b[\s\S]*?<\/hp:caption>/, ''); // replace any existing caption
      let newInner;
      if (target === 'table') {
        const anchor = (inner.match(/<hp:inMargin\b[^>]*\/>/) || inner.match(/<hp:outMargin\b[^>]*\/>/) || [null])[0];
        if (anchor) { const at = inner.indexOf(anchor) + anchor.length; newInner = inner.slice(0, at) + caption + inner.slice(at); }
        else newInner = caption + inner;
      } else {
        newInner = inner + caption; // last child — matches pic ground truth
      }
      doc.write(name, spliceEl(xml, el, `<${tag}${el.attrs}>${newInner}</${tag}>`));
      return { target, index: idx, side: sd, gap, captionWidth: capW };
    }
  }
  throw new Error(`set_caption: no ${target} #${idx} found in document`);
}

// ── 개체(그림/도형/차트) 속성 편집 — claw-hancomdocs object-prop 흡수 (handoff §2) ──
// 객체는 target(image/chart/shape) + index 로 지목(set_caption 과 동일 주소 체계). 편집은
// 객체의 <hp:sz>(크기)·<hp:pos>(위치/글자처럼취급)·textWrap attr(배치)·<hp:outMargin>(글
// 과의 간격)·<hp:lineShape>(선·화살표)·<hc:winBrush>(채우기·투명도·무늬)를 in-place 수정.
const OBJECT_TARGETS = { image: ['hp:pic'], chart: ['hp:chart'], equation: ['hp:equation'], shape: ['hp:rect', 'hp:ellipse', 'hp:line', 'hp:arc', 'hp:polygon', 'hp:curve'] };
function findObject(doc, target, index) {
  const tags = OBJECT_TARGETS[String(target || '').toLowerCase()];
  if (!tags) throw new Error(`object target must be one of ${Object.keys(OBJECT_TARGETS).join('/')}`);
  const idx = Math.max(0, Number(index) || 0);
  let seen = 0;
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const matches = [];
    for (const tag of tags) for (const el of scanTopLevel(xml, tag)) matches.push({ tag, el });
    matches.sort((a, b) => a.el.start - b.el.start);
    for (const m of matches) { if (seen++ === idx) return { name, tag: m.tag, el: m.el }; }
  }
  throw new Error(`object not found: ${target} #${idx} (found ${seen})`);
}
function writeObject(doc, f, inner, attrs) {
  const xml = doc.read(f.name);
  doc.write(f.name, spliceEl(xml, f.el, `<${f.tag}${attrs ?? f.el.attrs}>${inner ?? f.el.inner}</${f.tag}>`));
}
// Set/add an attribute on a SELF-CLOSING tag string (e.g. `<hp:lineShape .../>`,
// `<hc:winBrush .../>`). Unlike setOrAddAttr (which expects a bare attrs string),
// this inserts a NEW attr just before the `/>` instead of prepending it outside
// the tag. Replaces in place if the attr already exists.
function setTagAttr(tag, name, value) {
  const re = new RegExp(`(\\b${name}=")[^"]*(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  return tag.replace(/\s*\/>\s*$/, ` ${name}="${value}"/>`);
}

// 크기 (hp:sz) — mm.
function opSetObjectSize(doc, target, index, widthMm, heightMm) {
  if (widthMm == null && heightMm == null) throw new Error('set_object_size: need width_mm and/or height_mm');
  const f = findObject(doc, target, index);
  const inner = f.el.inner.replace(/<hp:sz\b[^>]*\/>/, (m) => {
    let s = m;
    if (widthMm != null) s = s.replace(/width="[^"]*"/, `width="${mm2hu(widthMm)}"`);
    if (heightMm != null) s = s.replace(/height="[^"]*"/, `height="${mm2hu(heightMm)}"`);
    return s;
  });
  writeObject(doc, f, inner);
  return { target, index, width_mm: widthMm ?? null, height_mm: heightMm ?? null };
}

// 위치(종이 기준 x/y mm) + 배치(wrap) + 글자처럼취급. wrap=inline → treatAsChar=1, textWrap 제거.
// (wrap enum 매핑은 기존 OBJ_WRAP 재사용 — insert_shape 와 공유.)
function opSetObjectPosition(doc, target, index, opts) {
  const f = findObject(doc, target, index);
  let inner = f.el.inner, attrs = f.el.attrs;
  const out = { target, index };
  if (opts.wrap != null) {
    const w = String(opts.wrap).toLowerCase(), inline = w === 'inline';
    if (!inline && !(w in OBJ_WRAP)) throw new Error(`set_object_position: wrap must be inline/${Object.keys(OBJ_WRAP).join('/')}`);
    if (!inline) attrs = setOrAddAttr(attrs, 'textWrap', OBJ_WRAP[w]);
    // A floating object (treatAsChar=0) must also carry flowWithText="0" +
    // allowOverlap="1": with flowWithText="1" Hancom reserves vertical space for
    // it and GROWS the anchor cell/page even though it's "in front" — only "0"
    // truly floats over the text. (Switching an inline image to front used to
    // leave flowWithText="1", silently bloating the table.)
    inner = inner.replace(/<hp:pos\b[^>]*\/>/, (m) => m
      .replace(/treatAsChar="[^"]*"/, `treatAsChar="${inline ? 1 : 0}"`)
      .replace(/flowWithText="[^"]*"/, `flowWithText="${inline ? 1 : 0}"`)
      .replace(/allowOverlap="[^"]*"/, `allowOverlap="${inline ? 0 : 1}"`));
    out.wrap = w;
  }
  if (opts.frame != null) {
    // Position frame (= hp:pos vert/horzRelTo). para = anchor paragraph top-left
    // (Hancom CLAMPS it: can't rise above that paragraph's top, so a tall float
    // on a one-line body paragraph rests low); page = body content top-left,
    // paper = physical paper corner, column = text column — none of these have
    // the per-paragraph clamp, so use page/paper to place freely above a line.
    const fr = String(opts.frame).toUpperCase();
    if (!['PARA', 'PAGE', 'PAPER', 'COLUMN'].includes(fr)) throw new Error('set_object_position: frame must be para/page/paper/column');
    inner = inner.replace(/<hp:pos\b[^>]*\/>/, (m) => m
      .replace(/vertRelTo="[^"]*"/, `vertRelTo="${fr}"`)
      .replace(/horzRelTo="[^"]*"/, `horzRelTo="${fr}"`));
    out.frame = fr.toLowerCase();
  }
  if (opts.x_mm != null || opts.y_mm != null) {
    inner = inner.replace(/<hp:pos\b[^>]*\/>/, (m) => {
      let s = m;
      if (opts.x_mm != null) s = s.replace(/horzOffset="[^"]*"/, `horzOffset="${mm2hu(opts.x_mm)}"`);
      if (opts.y_mm != null) s = s.replace(/vertOffset="[^"]*"/, `vertOffset="${mm2hu(opts.y_mm)}"`);
      return s;
    });
    out.x_mm = opts.x_mm ?? null; out.y_mm = opts.y_mm ?? null;
  }
  writeObject(doc, f, inner, attrs);
  return out;
}

// 글과의 간격 (hp:outMargin) — mm.
function opSetObjectMargin(doc, target, index, opts) {
  const want = marginWant(opts);
  if (!Object.keys(want).length) throw new Error('set_object_margin: need left/right/top/bottom (mm)');
  const f = findObject(doc, target, index);
  const inner = f.el.inner.replace(/<hp:outMargin\b[^>]*\/>/, (m) => applyMm(m, want));
  writeObject(doc, f, inner);
  return { target, index, outMargin: want };
}

// 선(테두리) 색/굵기/종류 + 화살표 (hp:lineShape). NOTE: 우리는 XML 직접 emit 이라 표준
// HWPX style 값을 그대로 쓴다(파선=DASH, 점선=DOT). handoff 의 파선↔점선 swap 은 한컴 UI
// 클릭 보정용일 뿐 — 단, 한컴 web RENDER 는 그 둘을 바꿔 그리는 별도 버그가 있어 화면상
// 파선이 점선처럼 보일 수 있음(파일 type 은 표준이 맞음).
const OBJ_LINE_STYLE = { solid: 'SOLID', dashed: 'DASH', dotted: 'DOT', 'long-dash': 'LONG_DASH', 'dash-dot': 'DASH_DOT', 'dash-dot-dot': 'DASH_DOT_DOT', double: 'DOUBLE_SLIM', 'circle-dot': 'CIRCLE' };
// arrow title → [style enum, fill]. 채움 모양은 같은 enum + fill=1, 빈 모양은 fill=0.
const OBJ_ARROW = { none: ['NORMAL', 0], triangle: ['ARROW', 1], line: ['SPEAR', 0], sharp: ['CONCAVE_ARROW', 1], diamond: ['EMPTY_DIAMOND', 1], circle: ['EMPTY_CIRCLE', 1], square: ['EMPTY_BOX', 1], 'empty-diamond': ['EMPTY_DIAMOND', 0], 'empty-circle': ['EMPTY_CIRCLE', 0], 'empty-square': ['EMPTY_BOX', 0] };
function opSetObjectBorder(doc, target, index, opts) {
  const f = findObject(doc, target, index);
  if (!/<hp:lineShape\b/.test(f.el.inner)) throw new Error(`set_object_border: ${target} #${index} has no <hp:lineShape> (borders editable on shapes)`);
  const inner = f.el.inner.replace(/<hp:lineShape\b[^>]*\/>/, (m) => {
    let s = m;
    if (opts.color != null) s = setTagAttr(s, 'color', normHex(opts.color));
    if (opts.width_mm != null) s = setTagAttr(s, 'width', String(Math.round(Number(opts.width_mm) * 283.46)));
    if (opts.line_type != null) { const st = OBJ_LINE_STYLE[String(opts.line_type).toLowerCase()]; if (!st) throw new Error(`set_object_border: line_type must be ${Object.keys(OBJ_LINE_STYLE).join('/')}`); s = setTagAttr(s, 'style', st); }
    if (opts.arrow_start != null) { const a = OBJ_ARROW[String(opts.arrow_start).toLowerCase()]; if (!a) throw new Error(`set_object_border: arrow_start must be ${Object.keys(OBJ_ARROW).join('/')}`); s = setTagAttr(setTagAttr(s, 'headStyle', a[0]), 'headfill', String(a[1])); }
    if (opts.arrow_end != null) { const a = OBJ_ARROW[String(opts.arrow_end).toLowerCase()]; if (!a) throw new Error(`set_object_border: arrow_end must be ${Object.keys(OBJ_ARROW).join('/')}`); s = setTagAttr(setTagAttr(s, 'tailStyle', a[0]), 'tailfill', String(a[1])); }
    return s;
  });
  writeObject(doc, f, inner);
  return { target, index, border: opts };
}

// 채우기 색/투명도/무늬 (hc:winBrush). 투명도 0-100 → alpha = round(t×255/100). 무늬는
// hatchStyle + hatchColor(면 색=faceColor). 무늬 콤보는 swap 없음.
const OBJ_HATCH = { horizontal: 'HORIZONTAL', vertical: 'VERTICAL', 'down-diagonal': 'SLASH', 'up-diagonal': 'BACK_SLASH', grid: 'CROSS', cross: 'CROSS_DIAGONAL' };
function opSetObjectFill(doc, target, index, opts) {
  const f = findObject(doc, target, index);
  if (!/<hc:winBrush\b/.test(f.el.inner)) throw new Error(`set_object_fill: ${target} #${index} has no <hc:winBrush> (fill editable on shapes)`);
  const inner = f.el.inner.replace(/<hc:winBrush\b[^>]*?\/>/, (m) => {
    let s = m;
    if (opts.color != null) s = setTagAttr(s, 'faceColor', normHex(opts.color));
    if (opts.transparency != null) s = setTagAttr(s, 'alpha', String(Math.round(Number(opts.transparency) * 255 / 100)));
    if (opts.pattern != null) { const h = OBJ_HATCH[String(opts.pattern).toLowerCase()]; if (!h) throw new Error(`set_object_fill: pattern must be ${Object.keys(OBJ_HATCH).join('/')}`); s = setTagAttr(s, 'hatchStyle', h); }
    if (opts.pattern_color != null) s = setTagAttr(s, 'hatchColor', normHex(opts.pattern_color));
    return s;
  });
  writeObject(doc, f, inner);
  return { target, index, fill: opts };
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

    // Keep the source tbl's pre-row metadata (hp:sz, hp:pos, hp:outMargin, hp:inMargin)
    // but drop any caption — a fresh table shouldn't inherit the template's caption.
    const firstTrIdx = srcTbl.el.inner.indexOf('<hp:tr');
    tblMeta = (firstTrIdx >= 0 ? srcTbl.el.inner.slice(0, firstTrIdx) : '')
      .replace(/<hp:caption\b[\s\S]*?<\/hp:caption>/, '');
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

  // Size the new table to fit the page. Cloning a source table inherits its
  // per-cell width, which OVERFLOWS when the new table has more columns than the
  // source (GT 2026-06-18: a 4-col table cloning a 3-col table's 56mm cells →
  // 4×56 = 224mm cellSz-sum vs a 168mm <hp:sz> → inconsistent, so Hancom uses the
  // sum and runs off the page). Rescale every column to an equal width that fits
  // min(source table width, page text width), and make <hp:sz> match the sum so
  // column widths and table width stay consistent.
  {
    const pageW = pageTextWidth(doc, srcSection);
    const szM = tblMeta.match(/<hp:sz\b[^>]*\bwidth="(\d+)"/);
    const srcTableW = szM && Number(szM[1]) > 0 ? Number(szM[1]) : pageW;
    const cellW = Math.max(1, Math.round(Math.min(srcTableW, pageW) / cols));
    cellTemplateInner = cellTemplateInner.replace(/(<hp:cellSz\b[^>]*\bwidth=")\d+(")/, `$1${cellW}$2`);
    tblMeta = tblMeta.replace(/(<hp:sz\b[^>]*\bwidth=")\d+(")/, `$1${cellW * cols}$2`);
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

// Column break (단 나누기) — like set_page_break but the <hp:p columnBreak="1">
// flag, which pushes the paragraph to the next column in a multi-column layout.
function opSetColumnBreak(doc, index, on) {
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`set_column_break: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  const want = on === false ? '0' : '1';
  const newAttrs = /columnBreak="\d"/.test(el.attrs)
    ? el.attrs.replace(/columnBreak="\d"/, `columnBreak="${want}"`)
    : el.attrs + ` columnBreak="${want}"`;
  doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newAttrs}>${el.inner}</hp:p>`));
  return { index, columnBreak: want === '1' };
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

// Inject the Hancom-round-trip "fingerprint" that makes list paraPrs survive
// Hancom Docs web rendering, sourced from templates/hancom_native_stub.hwpx:
// native BULLET (stub id=2) + NUMBER (stub id=3) paraPrs, the bullets table,
// a korean numbering, the `xmlns:hwpunitchar` namespace on <hh:head> and in
// content.hpf, the Scripts/ manifest entries, and the Scripts/ files. The
// 24-cycle finding (mistakes-06) is that Hancom strips synthesised list
// paraPrs unless the WHOLE hwpx fingerprint matches a Hancom-authored doc —
// injecting just the paraPr (v22_stub) is not enough. After this runs,
// reuseExistingListParaPr() finds the freshly-injected native paraPr.
// Returns true if a BULLET or NUMBER paraPr was added.
function injectHancomListInfra(doc) {
  const stubPath = path.join(__dirname, 'templates', 'hancom_native_stub.hwpx');
  if (!fs.existsSync(stubPath)) return false;
  const headerName = doc.headerName();
  if (!headerName) return false;

  let header = doc.read(headerName);
  let stubFiles;
  try {
    stubFiles = unzipSync(new Uint8Array(fs.readFileSync(stubPath)));
  } catch {
    return false;
  }
  const stubHeader = strFromU8(stubFiles['Contents/header.xml']);
  if (!stubHeader) return false;

  // Pull stub snippets
  const stubBulletParaPr = (stubHeader.match(/<hh:paraPr id="2"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  const stubNumberParaPr = (stubHeader.match(/<hh:paraPr id="3"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  const stubBullets = (stubHeader.match(/<hh:bullets\b[^>]*>[\s\S]*?<\/hh:bullets>/) || [])[0];
  const stubNumbering = (stubHeader.match(/<hh:numbering id="1"[^>]*>[\s\S]*?<\/hh:numbering>/) || [])[0];

  // Avoid duplicate injection if a Hancom-authored list paraPr already lives in this doc.
  const hasBullet = /<hh:heading\s+type="BULLET"/.test(header);
  const hasNumber = /<hh:heading\s+type="NUMBER"/.test(header);

  // Renumber stub's paraPr ids to avoid clashing with existing ones.
  const existingIds = [...header.matchAll(/<hh:paraPr\s+id="(\d+)"/g)].map((m) => Number(m[1]));
  const maxId = existingIds.length ? Math.max(...existingIds) : 0;
  let bulletId = String(maxId + 1);
  let numberId = String(maxId + 2);

  let injected = 0;
  if (!hasBullet && stubBulletParaPr) {
    const newBullet = stubBulletParaPr.replace(/^<hh:paraPr id="2"/, `<hh:paraPr id="${bulletId}"`);
    header = header.replace('</hh:paraProperties>', newBullet + '</hh:paraProperties>');
    injected++;
  }
  if (!hasNumber && stubNumberParaPr) {
    const newNumber = stubNumberParaPr.replace(/^<hh:paraPr id="3"/, `<hh:paraPr id="${numberId}"`);
    header = header.replace('</hh:paraProperties>', newNumber + '</hh:paraProperties>');
    injected++;
  }
  if (injected > 0) {
    header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + injected) + b);
  }

  // Add the namespace `<hp:case hp:required-namespace="…HwpUnitChar">`
  // references so Hancom doesn't normalize the stub paraPrs back to NONE.
  if (!/<hh:head[^>]*xmlns:hwpunitchar=/.test(header)) {
    header = header.replace(
      /(<hh:head[^>]*?xmlns:ooxmlchart="[^"]+")/,
      '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"'
    );
  }
  header = header.replace(/(<hh:head[^>]*?)version="1\.2"/, '$1version="1.5"');

  // Inject bullets table if missing
  if (!/<hh:bullets/.test(header) && stubBullets) {
    header = header.replace('</hh:numberings>', '</hh:numberings>' + stubBullets);
  }
  // Replace placeholder numbering id=1 (empty paraHeads) with stub's korean one
  if (stubNumbering) {
    const cur1 = header.match(/<hh:numbering id="1"[^>]*>[\s\S]*?<\/hh:numbering>/);
    if (cur1 && !/<hh:paraHead\b[^/]*>[^<]+<\/hh:paraHead>/.test(cur1[0])) {
      header = header.replace(cur1[0], stubNumbering);
    }
  }
  doc.write(headerName, header);

  // Patch content.hpf — add xmlns:hwpunitchar + Scripts manifest entries
  const hpfName = Object.keys(doc.files).find((n) => /content\.hpf$/i.test(n));
  if (hpfName) {
    let hpf = doc.read(hpfName);
    if (!/xmlns:hwpunitchar=/.test(hpf)) {
      hpf = hpf.replace(
        /(xmlns:ooxmlchart="[^"]+")(\s+xmlns:epub=)/,
        '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"$2'
      );
    }
    if (!/headersc/.test(hpf)) {
      // Section-count-robust: the legacy "after section0, before settings"
      // anchor silently no-ops on multi-section docs (section1 sits between
      // section0 and settings). Native docs place the Scripts items right
      // after the section items / before settings, so anchor on settings
      // (falling back to </opf:manifest>); spine order among Scripts is not
      // significant, so append before </opf:spine>.
      const scriptItems =
        '<opf:item id="headersc" href="Scripts/headerScripts" media-type="application/x-javascript ;charset=utf-16"/>' +
        '<opf:item id="sourcesc" href="Scripts/sourceScripts" media-type="application/x-javascript ;charset=utf-16"/>';
      const scriptRefs =
        '<opf:itemref idref="headersc" linear="yes"/><opf:itemref idref="sourcesc" linear="yes"/>';
      if (/<opf:item id="settings"/.test(hpf)) {
        hpf = hpf.replace(/(<opf:item id="settings")/, scriptItems + '$1');
      } else {
        hpf = hpf.replace('</opf:manifest>', scriptItems + '</opf:manifest>');
      }
      hpf = hpf.replace('</opf:spine>', scriptRefs + '</opf:spine>');
      // Native round-trip docs carry linear="yes" on body itemrefs — match it.
      hpf = hpf.replace(/(<opf:itemref idref="(?:header|section\d+)")\/>/g, '$1 linear="yes"/>');
    }
    doc.write(hpfName, hpf);
  }

  // Copy Scripts/ verbatim from stub. These are binary (UTF-16 LE), so
  // assign raw bytes directly to doc.files. DON'T add to doc.dirty — the
  // save() loop runs strToU8(doc.text[name]) on every dirty entry, which
  // would crash for binary content where doc.text is undefined.
  for (const name of Object.keys(stubFiles)) {
    if (!name.startsWith('Scripts/')) continue;
    if (doc.files[name]) continue;
    doc.files[name] = stubFiles[name];
  }

  return injected > 0;
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
    // 1. Try reusing an existing Hancom-authored list paraPr.
    let reused = reuseExistingListParaPr(doc, t, lvl);
    // 2. If none exists, inject the Hancom-round-trip stub fingerprint into
    //    this doc (native BULLET + NUMBER paraPrs, bullets/numbering tables,
    //    xmlns:hwpunitchar, Scripts/ — from templates/hancom_native_stub.hwpx)
    //    then retry the reuse — the freshly-injected paraPr should now match.
    //    This lets users edit ANY plain hwpx and still get web-safe list
    //    rendering, not just docs that already round-tripped through Hancom.
    if (!reused) {
      const injected = injectHancomListInfra(doc);
      if (injected) reused = reuseExistingListParaPr(doc, t, lvl);
    }
    if (reused) {
      const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${reused}"`);
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newOpen}>${el.inner}</hp:p>`));
      return { index, type: t, level: lvl, paraPrId: reused, reusedHancomNative: true };
    }
    // 3. Stub inject failed (stub file missing, etc.) — fall back to a literal
    //    glyph prefix in the paragraph text. BULLET uses the requested char
    //    (default ▶); NUMBER uses `${options.number || 1}.`. This renders
    //    identically across web AND desktop but loses list semantics; multiple
    //    NUMBER paragraphs need separate `number` values (no auto-increment).
    const prefix = options && options.fallbackPrefix === false
      ? null
      : t === 'BULLET'
        ? `${(options && options.char) || '▶'} `
        : `${(options && options.number != null) ? Number(options.number) : 1}. `;
    if (prefix) {
      const escapedPrefix = xmlEscape(prefix);
      const newInner = el.inner.replace(
        /(<hp:t(?:\s[^>]*)?>)([^<]*)/,
        (_, open, text) => `${open}${escapedPrefix}${text}`
      );
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${el.attrs}>${newInner}</hp:p>`));
      return { index, type: t, level: lvl, fallback: 'text-prefix', prefix: prefix.trimEnd() };
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

// ── 표/셀 속성 다이얼로그(기본·표·여백/캡션·셀)의 빈 칸 채우기 ────────────────
// GT 구조: handoff/shared/SHARED_op-inventory-for-GT.md §1 (claw-hancomdocs 가
// 한컴 web 에서 실측한 native XML). margin/size 입력은 mm(다이얼로그 단위) → HWPUNIT.
const HU_PER_MM = 283.46;
const mm2hu = (v) => Math.round(Number(v) * HU_PER_MM);

// 표의 도형 메타(sz/pos/outMargin/inMargin)는 <hp:tbl> inner 의 맨 앞(첫 <hp:tr> 이전)에
// 산다. 그 영역만 고쳐서, 셀 단위 <hp:cellMargin>/<hp:cellSz>(모양이 비슷)을 안 건드린다.
function rewriteTblMeta(doc, tableIndex, opName, fn) {
  const { section, el } = getTable(doc, tableIndex);
  const trAt = el.inner.search(/<hp:tr\b/);
  const head = trAt >= 0 ? el.inner.slice(0, trAt) : el.inner;
  const rest = trAt >= 0 ? el.inner.slice(trAt) : '';
  const newHead = fn(head);
  if (newHead === head) throw new Error(`${opName}: table meta element not found`);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${newHead}${rest}</hp:tbl>`));
}
function applyMm(xml, want) { let s = xml; for (const k of Object.keys(want)) s = s.replace(new RegExp(`${k}="[^"]*"`), `${k}="${want[k]}"`); return s; }
function marginWant(opts) { const w = {}; for (const k of ['left', 'right', 'top', 'bottom']) if (opts[k] != null) w[k] = mm2hu(opts[k]); return w; }

// 셀 안 여백 (cellMargin) — 선택 셀, 또는 [row,col]..[to_row,to_col] 범위.
function opSetCellMargin(doc, tableIndex, row, col, opts) {
  const want = marginWant(opts);
  if (!Object.keys(want).length) throw new Error('set_cell_margin: need left/right/top/bottom (mm)');
  const { section, el } = getTable(doc, tableIndex);
  const rA = Math.min(row, opts.to_row ?? row), rB = Math.max(row, opts.to_row ?? row);
  const cA = Math.min(col, opts.to_col ?? col), cB = Math.max(col, opts.to_col ?? col);
  let inner = el.inner, touched = 0;
  for (let ri = rB; ri >= rA; ri--) {                       // bottom-up: splice offsets stay valid
    const rows = scanTopLevel(inner, 'hp:tr');
    if (ri < 0 || ri >= rows.length) continue;
    const tr = rows[ri];
    let trInner = tr.inner;
    for (let ci = cB; ci >= cA; ci--) {
      const tcs = scanTopLevel(trInner, 'hp:tc');
      if (ci < 0 || ci >= tcs.length) continue;
      const tc = tcs[ci];
      const cur = (tc.inner.match(/<hp:cellMargin\b[^>]*\/>/) || [])[0];
      const cm = cur ? applyMm(cur, want)
        : `<hp:cellMargin left="${want.left ?? 0}" right="${want.right ?? 0}" top="${want.top ?? 0}" bottom="${want.bottom ?? 0}"/>`;
      const tcInner = cur ? tc.inner.replace(cur, cm) : tc.inner + cm;   // append after cellSz if absent
      // hasMargin="1" tells Hancom to use THIS cell's cellMargin; hasMargin="0"
      // (the default) makes the cell ignore its cellMargin and inherit the table's
      // inMargin — so without this the per-cell margin is silently dropped on render.
      const tcAttrs = setOrAddAttr(tc.attrs, 'hasMargin', '1');
      trInner = spliceEl(trInner, tc, `<hp:tc${tcAttrs}>${tcInner}</hp:tc>`);
      touched++;
    }
    inner = spliceEl(inner, tr, `<hp:tr${tr.attrs}>${trInner}</hp:tr>`);
  }
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${inner}</hp:tbl>`));
  return { table: tableIndex, cells: touched, cellMargin: want };
}

// 표 바깥 여백 (outMargin) — 표↔본문 간격.
function opSetTableMargin(doc, tableIndex, opts) {
  const want = marginWant(opts);
  if (!Object.keys(want).length) throw new Error('set_table_margin: need left/right/top/bottom (mm)');
  rewriteTblMeta(doc, tableIndex, 'set_table_margin', (head) => {
    const cur = (head.match(/<hp:outMargin\b[^>]*\/>/) || [])[0];
    return cur ? head.replace(cur, applyMm(cur, want)) : head;
  });
  return { table: tableIndex, outMargin: want };
}

// 표 탭 '모든 셀에 적용되는 안 여백' (table-level inMargin 기본값).
function opSetTableInnerMargin(doc, tableIndex, opts) {
  const want = marginWant(opts);
  if (!Object.keys(want).length) throw new Error('set_table_inner_margin: need left/right/top/bottom (mm)');
  rewriteTblMeta(doc, tableIndex, 'set_table_inner_margin', (head) => {
    const cur = (head.match(/<hp:inMargin\b[^>]*\/>/) || [])[0];
    return cur ? head.replace(cur, applyMm(cur, want)) : head;
  });
  return { table: tableIndex, inMargin: want };
}

// 표 전체 너비/높이 (hp:sz). Hancom recomputes a table's <hp:sz> from the sum of
// its column widths / row heights on open, so setting <hp:sz> alone is ignored
// (GT round-trip: 120mm→Hancom rewrote it to the cell-width sum). To actually
// resize, scale every cell's <hp:cellSz> proportionally to hit the target, then
// update <hp:sz> to match. Rectangular tables resize exactly; merged cells are
// approximate (same caveat as distribute_table).
function opSetTableSize(doc, tableIndex, widthMm, heightMm) {
  if (widthMm == null && heightMm == null) throw new Error('set_table_size: need width_mm and/or height_mm');
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (!rows.length) throw new Error('set_table_size: table has no rows');
  const curW = scanTopLevel(rows[0].inner, 'hp:tc')
    .reduce((a, tc) => a + Number((tc.inner.match(/<hp:cellSz width="(\d+)"/) || [, 0])[1]), 0);
  const curH = rows.reduce((a, r) => {
    const c = scanTopLevel(r.inner, 'hp:tc')[0];
    return a + Number((c && c.inner.match(/<hp:cellSz width="\d+" height="(\d+)"/) || [, 0])[1]);
  }, 0);
  const tgtW = widthMm != null ? mm2hu(widthMm) : curW;
  const tgtH = heightMm != null ? mm2hu(heightMm) : curH;
  const sw = widthMm != null && curW > 0 ? tgtW / curW : 1;
  const sh = heightMm != null && curH > 0 ? tgtH / curH : 1;
  let inner = el.inner.replace(/<hp:cellSz width="(\d+)" height="(\d+)"\/>/g, (m, w, h) =>
    `<hp:cellSz width="${Math.round(Number(w) * sw)}" height="${Math.round(Number(h) * sh)}"/>`);
  inner = inner.replace(/<hp:sz\b[^>]*\/>/, (m) => {
    let s = m;
    if (widthMm != null) s = s.replace(/width="[^"]*"/, `width="${tgtW}"`).replace(/widthRelTo="[^"]*"/, 'widthRelTo="ABSOLUTE"');
    if (heightMm != null) s = s.replace(/height="[^"]*"/, `height="${tgtH}"`).replace(/heightRelTo="[^"]*"/, 'heightRelTo="ABSOLUTE"');
    return s;
  });
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${inner}</hp:tbl>`));
  return { table: tableIndex, width_mm: widthMm ?? null, height_mm: heightMm ?? null, scaledCols: sw !== 1, scaledRows: sh !== 1 };
}

// 표 배치(textWrap)/쪽경계(pageBreak)/머리행 반복(repeatHeader). GT §1:
// page_split cell→TABLE, table→CELL, none→NONE. wrap inline=글자처럼취급(treatAsChar=1).
const TBL_WRAP = { square: 'SQUARE', topbottom: 'TOP_AND_BOTTOM', front: 'IN_FRONT_OF_TEXT', behind: 'BEHIND_TEXT' };
const TBL_PAGESPLIT = { none: 'NONE', cell: 'TABLE', table: 'CELL' };
function opSetTableProps(doc, tableIndex, opts) {
  const { section, el } = getTable(doc, tableIndex);
  let attrs = el.attrs, inner = el.inner;
  const out = { table: tableIndex };
  if (opts.wrap != null) {
    const w = String(opts.wrap).toLowerCase();
    const inline = w === 'inline';
    if (!inline && !(w in TBL_WRAP)) throw new Error(`set_table_props: wrap must be inline/${Object.keys(TBL_WRAP).join('/')}`);
    if (!inline) attrs = setOrAddAttr(attrs, 'textWrap', TBL_WRAP[w]);
    const trAt = inner.search(/<hp:tr\b/); const head = inner.slice(0, trAt < 0 ? inner.length : trAt);
    const pos = (head.match(/<hp:pos\b[^>]*\/>/) || [])[0];
    if (pos) inner = inner.replace(pos, pos.replace(/treatAsChar="[^"]*"/, `treatAsChar="${inline ? 1 : 0}"`));
    out.wrap = w;
  }
  if (opts.page_split != null) {
    const p = String(opts.page_split).toLowerCase();
    if (!(p in TBL_PAGESPLIT)) throw new Error(`set_table_props: page_split must be ${Object.keys(TBL_PAGESPLIT).join('/')}`);
    attrs = setOrAddAttr(attrs, 'pageBreak', TBL_PAGESPLIT[p]);
    out.page_split = p;
  }
  if (opts.repeat_header != null) {
    attrs = setOrAddAttr(attrs, 'repeatHeader', opts.repeat_header === false ? '0' : '1');
    out.repeat_header = opts.repeat_header !== false;
  }
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${attrs}>${inner}</hp:tbl>`));
  return out;
}

// 머리 행 셀 지정 — <hp:tc ... header="1"> (한컴 UI 의미상 머리 행만, 코드는 임의 셀 가능).
function opSetTitleCell(doc, tableIndex, row, col, on) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`set_title_cell: row ${row} out of range`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  if (col < 0 || col >= tcs.length) throw new Error(`set_title_cell: col ${col} out of range`);
  const tc = tcs[col];
  const want = on === false ? '0' : '1';
  const newAttrs = setOrAddAttr(tc.attrs, 'header', want);
  const newRowInner = spliceEl(rows[row].inner, tc, `<hp:tc${newAttrs}>${tc.inner}</hp:tc>`);
  const newTbl = `<hp:tbl${el.attrs}>${spliceEl(el.inner, rows[row], `<hp:tr${rows[row].attrs}>${newRowInner}</hp:tr>`)}</hp:tbl>`;
  doc.write(section, spliceEl(doc.read(section), el, newTbl));
  return { table: tableIndex, row, col, header: want === '1' };
}

// 표가 여러 쪽에 자동분할될 때 잘린 가장자리에 그려지는 경계선(여백/캡션 탭의 '자동으로
// 나뉜 표의 경계선 설정'). GT(handoff §1): 표 borderFill 에 breakCellSeparateLine="1" 을
// 켜고 그 **<hh:diagonal> 슬롯**(top/bottomBorder 아님!)에 type/width/color 를 저장. 표는
// '나눔'(pageBreak="CELL") 모드여야 활성. 표의 기존 borderFill 을 복제(테두리 모양은 유지)
// 해 위 두 가지를 적용하고, 표를 새 borderFill 로 repoint. line_type 은 표준 HWPX style 직접
// emit(파선=DASH; 한컴 UI swap 은 클릭 보정용이라 코드 emit 엔 불필요). width 는 "N mm" 문자열.
function opSetTableSplitBorder(doc, tableIndex, opts) {
  const { section, el } = getTable(doc, tableIndex);
  const ref = getAttr(el.attrs, 'borderFillIDRef') || '1';
  const headerName = doc.headerName();
  if (!headerName) throw new Error('set_table_split_border: Contents/header.xml missing');
  const header = doc.read(headerName);
  const list = scanTopLevel(header, 'hh:borderFills')[0];
  if (!list) throw new Error('set_table_split_border: <hh:borderFills> missing');
  const bfs = scanTopLevel(list.inner, 'hh:borderFill');
  const src = bfs.find((b) => getAttr(b.attrs, 'id') === ref) || bfs[0];
  if (!src) throw new Error('set_table_split_border: table borderFill not found');
  const style = opts.line_type != null ? (OBJ_LINE_STYLE[String(opts.line_type).toLowerCase()] || 'SOLID') : 'SOLID';
  const w = opts.width_mm != null ? `${Number(opts.width_mm)} mm` : '0.5 mm';
  const color = opts.color != null ? normHex(opts.color) : '#000000';
  const diag = `<hh:diagonal type="${style}" width="${w}" color="${color}"/>`;
  let inner = /<hh:diagonal\b[^>]*\/>/.test(src.inner) ? src.inner.replace(/<hh:diagonal\b[^>]*\/>/, diag) : src.inner + diag;
  const newId = String(Math.max(0, ...bfs.map((b) => Number(getAttr(b.attrs, 'id') || 0))) + 1);
  let newAttrs = src.attrs.replace(/\s*id="\d+"/, ` id="${newId}"`);
  newAttrs = setOrAddAttr(newAttrs, 'breakCellSeparateLine', '1');
  const newBf = `<hh:borderFill${newAttrs}>${inner}</hh:borderFill>`;
  let newHeader = spliceEl(header, list, `<hh:borderFills${list.attrs}>${list.inner + newBf}</hh:borderFills>`);
  newHeader = bumpListCount(newHeader, 'hh:borderFills', +1);
  doc.write(headerName, newHeader);
  // 표를 '나눔' 모드 + 새 borderFill 로 repoint
  let tblAttrs = setOrAddAttr(el.attrs, 'pageBreak', 'CELL');
  tblAttrs = setOrAddAttr(tblAttrs, 'borderFillIDRef', newId);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${tblAttrs}>${el.inner}</hp:tbl>`));
  return { table: tableIndex, borderFillId: newId, line_type: opts.line_type || 'solid', width: w, color, pageBreak: 'CELL' };
}

// Distribute row heights / column widths evenly (셀 높이를/너비를 같게). Sums the
// current row heights and column widths, divides by the count, and rewrites every
// cell's <hp:cellSz>. mode: "width" / "height" / "both" (default). Best on
// rectangular tables; merged cells (colSpan/rowSpan>1) would need proportional
// sizing this doesn't do.
function opDistributeTable(doc, tableIndex, mode) {
  mode = String(mode || 'both').toLowerCase();
  if (!['width', 'height', 'both'].includes(mode)) throw new Error('distribute_table: mode must be width / height / both');
  const { section, el } = getTable(doc, tableIndex);
  const tbl = el.inner;
  const rows = scanTopLevel(tbl, 'hp:tr');
  if (!rows.length) throw new Error('distribute_table: table has no rows');
  const rowH = rows.map((r) => { const c = scanTopLevel(r.inner, 'hp:tc')[0]; const m = c && c.inner.match(/<hp:cellSz width="\d+" height="(\d+)"/); return m ? Number(m[1]) : 0; });
  const cols = scanTopLevel(rows[0].inner, 'hp:tc');
  const colW = cols.map((c) => { const m = c.inner.match(/<hp:cellSz width="(\d+)"/); return m ? Number(m[1]) : 0; });
  const eqH = Math.round(rowH.reduce((a, b) => a + b, 0) / rows.length);
  const eqW = Math.round(colW.reduce((a, b) => a + b, 0) / (cols.length || 1));
  const newInner = tbl.replace(/<hp:cellSz width="(\d+)" height="(\d+)"\/>/g, (m, w, h) =>
    `<hp:cellSz width="${mode === 'height' ? w : eqW}" height="${mode === 'width' ? h : eqH}"/>`);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${newInner}</hp:tbl>`));
  return { table: tableIndex, mode, eqWidth: mode !== 'height' ? eqW : undefined, eqHeight: mode !== 'width' ? eqH : undefined, rows: rows.length, cols: cols.length };
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
  const charPrKeys = ['color', 'bold', 'italic', 'underline', 'size', 'size_pt', 'strikethrough', 'supscript', 'subscript', 'fontFace', 'letter_spacing', 'char_ratio'];
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
  // Font size: `size_pt` is points (the intuitive unit) → ×100 to HWP char-height
  // units (10pt = 1000). Raw `size` stays HWP units for back-compat — but note a
  // value like 22 there is 0.22pt (invisible), so prefer size_pt.
  if (style.size_pt != null) attrs = setOrAddAttr(attrs, 'height', String(Math.round(Number(style.size_pt) * 100)));
  else if (style.size) attrs = setOrAddAttr(attrs, 'height', String(style.size));
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
  // 장평(char width %) lives in <hh:ratio>, 자간(letter spacing %) in
  // <hh:spacing> — one value per language script. Every charPr has both, so
  // replace the existing element in place.
  if (style.char_ratio !== undefined) {
    const r = Number(style.char_ratio);
    inner = inner.replace(/<hh:ratio\b[^>]*\/>/, `<hh:ratio hangul="${r}" latin="${r}" hanja="${r}" japanese="${r}" other="${r}" symbol="${r}" user="${r}"/>`);
  }
  if (style.letter_spacing !== undefined) {
    const sp = Number(style.letter_spacing);
    inner = inner.replace(/<hh:spacing\b[^>]*\/>/, `<hh:spacing hangul="${sp}" latin="${sp}" hanja="${sp}" japanese="${sp}" other="${sp}" symbol="${sp}" user="${sp}"/>`);
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

// Web-safe paragraph alignment. A cloned-and-mutated paraPr is normalized away
// by Hancom Docs web (align reverts to LEFT + a spurious number appears) — but a
// paraPr that reuses an existing clean native one, or is injected from the
// Hancom-native stub, survives (verified by Hancom-web render + round-trip; same
// reason injected list paraPrs render). Returns a paraPr id to retarget to, or
// null if no stub is available (caller falls back to the clone path).
const ALIGN_VALUES = new Set(['LEFT', 'RIGHT', 'CENTER', 'JUSTIFY', 'DISTRIBUTE', 'BOTH']);
function paraPrIsPlain(inner) {
  const vals = [...inner.matchAll(/<h[hc]:(intent|left|right|prev|next)\b[^>]*\bvalue="(-?\d+)"/g)].map((m) => Number(m[2]));
  return vals.length > 0 && vals.every((v) => v === 0);
}
function ensureCleanAlignParaPr(doc, align) {
  const al = String(align || '').toUpperCase();
  if (!ALIGN_VALUES.has(al)) throw new Error(`apply_paragraph_style: align must be one of ${[...ALIGN_VALUES].join('/')}`);
  const headerName = doc.headerName();
  if (!headerName) return null;
  let header = doc.read(headerName);
  // 1. Reuse an existing clean (heading NONE, default margins) paraPr with this align.
  for (const pp of scanTopLevel(header, 'hh:paraPr')) {
    const h = (pp.inner.match(/<hh:heading\s+type="([^"]+)"/) || [])[1];
    const a = (pp.inner.match(/<hh:align\b[^>]*horizontal="([^"]+)"/) || [])[1];
    if (h === 'NONE' && a === al && paraPrIsPlain(pp.inner)) return getAttr(pp.attrs, 'id');
  }
  // 2. Inject a clean paraPr built from the Hancom-native stub (heading NONE, this align).
  const stubPath = path.join(__dirname, 'templates', 'hancom_native_stub.hwpx');
  if (!fs.existsSync(stubPath)) return null;
  let stubFiles;
  try { stubFiles = unzipSync(new Uint8Array(fs.readFileSync(stubPath))); } catch { return null; }
  const stubHeader = strFromU8(stubFiles['Contents/header.xml'] || new Uint8Array());
  const tmpl = (stubHeader.match(/<hh:paraPr id="2"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  if (!tmpl) return null;
  const ids = [...header.matchAll(/<hh:paraPr\s+id="(\d+)"/g)].map((m) => Number(m[1]));
  const newPpId = String((ids.length ? Math.max(...ids) : 0) + 1);
  const clean = tmpl
    .replace(/^<hh:paraPr id="2"/, `<hh:paraPr id="${newPpId}"`)
    .replace(/<hh:heading\s+type="[^"]*"\s+idRef="[^"]*"\s+level="[^"]*"\/>/, '<hh:heading type="NONE" idRef="0" level="0"/>')
    .replace(/<hh:align\b[^>]*\/>/, `<hh:align horizontal="${al}" vertical="BASELINE"/>`);
  header = header.replace('</hh:paraProperties>', clean + '</hh:paraProperties>');
  header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + 1) + b);
  if (!/<hh:head[^>]*xmlns:hwpunitchar=/.test(header)) {
    header = header.replace(/(<hh:head[^>]*?xmlns:ooxmlchart="[^"]+")/, '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"');
  }
  doc.write(headerName, header);
  return newPpId;
}

// Like ensureCleanAlignParaPr but also bakes margin (indent / left / right /
// spacingBefore / spacingAfter, all in HWPUNIT ≈283.46/mm) and lineSpacing
// (percent) into the Hancom-native hp:switch so they survive Hancom web — a
// plain <hh:margin> paraPr is stripped to 0 on open. Units (GT 한컴 para-shape):
// hp:case = mm×100, hp:default = mm×200; lineSpacing(%) is copied verbatim into
// both branches. Always injects from the stub when any margin/lineSpacing is set
// (an existing paraPr won't match those exact values); reuses for align-only.
// Read a paraPr's current align / indent / margins / lineSpacing by id, so a
// partial apply_paragraph_style can preserve what the caller didn't specify.
// Handles both a regular paraPr (<hh:margin> children in HWPUNIT) and the
// web-safe switch form (<hp:default><hh:margin><hc:*> in mm×200).
function readParaPrVals(doc, pprId) {
  const hn = doc.headerName();
  if (!hn) return {};
  const blk = (doc.read(hn).match(new RegExp(`<hh:paraPr\\b[^>]*\\bid="${pprId}"[\\s\\S]*?</hh:paraPr>`)) || [''])[0];
  if (!blk) return {};
  const reg = (t) => { const x = blk.match(new RegExp(`<hh:${t}\\b[^>]*value="([-\\d]+)"`)); return x ? Number(x[1]) : null; };
  const lsm = blk.match(/<hh:lineSpacing\b[^>]*value="([-\d]+)"/);
  const v = {
    align: (blk.match(/<hh:align\b[^>]*horizontal="([^"]+)"/) || [])[1] || null,
    indent: reg('intent'), marginLeft: reg('left'), marginRight: reg('right'),
    spacingBefore: reg('prev'), spacingAfter: reg('next'),
    lineSpacing: lsm ? Number(lsm[1]) : null,
  };
  if (v.spacingBefore == null && /<hp:default>/.test(blk)) {
    const def = (blk.match(/<hp:default>[\s\S]*?<\/hp:default>/) || [''])[0];
    const hc = (t) => { const x = def.match(new RegExp(`<hc:${t}\\b[^>]*value="([-\\d]+)"`)); return x ? Math.round((Number(x[1]) / 200) * 283.46) : null; };
    v.indent ??= hc('intent'); v.marginLeft ??= hc('left'); v.marginRight ??= hc('right');
    v.spacingBefore ??= hc('prev'); v.spacingAfter ??= hc('next');
  }
  return v;
}

function ensureCleanParaPr(doc, opts) {
  const al = opts.align ? String(opts.align).toUpperCase() : null;
  if (al && !ALIGN_VALUES.has(al)) throw new Error(`apply_paragraph_style: align must be one of ${[...ALIGN_VALUES].join('/')}`);
  const hasBox = ['indent', 'marginLeft', 'marginRight', 'spacingBefore', 'spacingAfter', 'lineSpacing'].some((k) => opts[k] != null);
  const headerName = doc.headerName();
  if (!headerName) return null;
  let header = doc.read(headerName);
  if (al && !hasBox) {
    for (const pp of scanTopLevel(header, 'hh:paraPr')) {
      const h = (pp.inner.match(/<hh:heading\s+type="([^"]+)"/) || [])[1];
      const a = (pp.inner.match(/<hh:align\b[^>]*horizontal="([^"]+)"/) || [])[1];
      if (h === 'NONE' && a === al && paraPrIsPlain(pp.inner)) return getAttr(pp.attrs, 'id');
    }
  }
  const stubPath = path.join(__dirname, 'templates', 'hancom_native_stub.hwpx');
  if (!fs.existsSync(stubPath)) return null;
  let stubFiles;
  try { stubFiles = unzipSync(new Uint8Array(fs.readFileSync(stubPath))); } catch { return null; }
  const stubHeader = strFromU8(stubFiles['Contents/header.xml'] || new Uint8Array());
  const tmpl = (stubHeader.match(/<hh:paraPr id="2"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  if (!tmpl) return null;
  const ids = [...header.matchAll(/<hh:paraPr\s+id="(\d+)"/g)].map((m) => Number(m[1]));
  const newPpId = String((ids.length ? Math.max(...ids) : 0) + 1);
  let clean = tmpl
    .replace(/^<hh:paraPr id="2"/, `<hh:paraPr id="${newPpId}"`)
    .replace(/<hh:heading\s+type="[^"]*"\s+idRef="[^"]*"\s+level="[^"]*"\/>/, '<hh:heading type="NONE" idRef="0" level="0"/>');
  if (al) clean = clean.replace(/<hh:align\b[^>]*\/>/, `<hh:align horizontal="${al}" vertical="BASELINE"/>`);
  if (hasBox) {
    const c = (v, mult) => Math.round((Number(v || 0) / 283.46) * mult);
    const mk = (mult) => `<hh:margin><hc:intent value="${c(opts.indent, mult)}" unit="HWPUNIT"/><hc:left value="${c(opts.marginLeft, mult)}" unit="HWPUNIT"/><hc:right value="${c(opts.marginRight, mult)}" unit="HWPUNIT"/><hc:prev value="${c(opts.spacingBefore, mult)}" unit="HWPUNIT"/><hc:next value="${c(opts.spacingAfter, mult)}" unit="HWPUNIT"/></hh:margin>`;
    clean = clean.replace(/(<hp:case\b[^>]*>)<hh:margin>[\s\S]*?<\/hh:margin>/, `$1${mk(100)}`);
    clean = clean.replace(/(<hp:default>)<hh:margin>[\s\S]*?<\/hh:margin>/, `$1${mk(200)}`);
    if (opts.lineSpacing != null) {
      clean = clean.replace(/<hh:lineSpacing\b[^>]*\/>/g, `<hh:lineSpacing type="PERCENT" value="${opts.lineSpacing}" unit="HWPUNIT"/>`);
    }
  }
  header = header.replace('</hh:paraProperties>', clean + '</hh:paraProperties>');
  header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + 1) + b);
  if (!/<hh:head[^>]*xmlns:hwpunitchar=/.test(header)) {
    header = header.replace(/(<hh:head[^>]*?xmlns:ooxmlchart="[^"]+")/, '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"');
  }
  doc.write(headerName, header);
  return newPpId;
}

function opApplyParagraphStyle(doc, index, style) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_paragraph_style: Contents/header.xml missing');
  // Web-safe path: align / indent / margins / spacing / lineSpacing baked into a
  // Hancom-native hp:switch paraPr so Hancom web keeps them (a plain paraPr is
  // stripped to 0 on open). background_color / page_break_before / keep_with_next
  // aren't part of the switch — those still take the clone path below.
  const nativeOpts = {
    align: style.align,
    indent: style.indent,
    marginLeft: style.margin_left ?? style.marginLeft,
    marginRight: style.margin_right ?? style.marginRight,
    spacingBefore: style.spacing_before ?? style.spacingBefore,
    spacingAfter: style.spacing_after ?? style.spacingAfter,
    lineSpacing: style.line_spacing ?? style.lineSpacing,
  };
  const wantsNative = Object.values(nativeOpts).some((v) => v != null);
  const noExtras = style.background_color == null && style.page_break_before == null && style.keep_with_next == null;
  if (wantsNative && noExtras) {
    // PRESERVE unspecified props: the clean paraPr is built from a stub (which
    // defaults to CENTER align + 0 margins), so applying e.g. only spacing_before
    // would otherwise reset the paragraph's align/indent/lineSpacing. Seed
    // nativeOpts from the target paragraph's CURRENT paraPr for anything the
    // caller didn't set, so only the requested property actually changes.
    const parasCur = doc.paragraphs();
    if (index >= 0 && index < parasCur.length) {
      const curId = (parasCur[index].el.attrs.match(/paraPrIDRef="(\d+)"/) || [])[1];
      const cur = curId != null ? readParaPrVals(doc, curId) : {};
      if (nativeOpts.align == null && cur.align) nativeOpts.align = cur.align;
      for (const k of ['indent', 'marginLeft', 'marginRight', 'spacingBefore', 'spacingAfter', 'lineSpacing']) {
        if (nativeOpts[k] == null && cur[k] != null) nativeOpts[k] = cur[k];
      }
    }
    const pprId = ensureCleanParaPr(doc, nativeOpts);
    if (pprId != null) {
      const paras0 = doc.paragraphs();
      if (index < 0 || index >= paras0.length) throw new Error(`apply_paragraph_style: index ${index} out of range`);
      const { section, el } = paras0[index];
      const newOpen = el.attrs.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${pprId}"`);
      doc.write(section, spliceEl(doc.read(section), el, `<hp:p${newOpen}>${dropLinesegs(el.inner)}</hp:p>`));
      return { index, paraPrId: pprId, webSafe: true };
    }
    // no stub available → fall through to the clone path
  }
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

// Apply a built-in named paragraph style (스타일 적용 — e.g. "개요 1" heading,
// "본문", "바탕글"). Every .hwpx ships ~22 <hh:style> definitions in header.xml,
// each declaring its own paraPrIDRef + charPrIDRef. Applying one = point the
// paragraph's styleIDRef at the style id AND adopt the style's paraPr + char so
// it actually renders (and shows under that name in Hancom's style menu, feeding
// TOC/outline). Hancom re-indexes paraPr/char ids on its own save, so we use the
// style's declared refs from THIS doc's header (internally consistent).
function opApplyStyle(doc, index, style) {
  const headerName = doc.headerName();
  if (!headerName) throw new Error('apply_style: Contents/header.xml missing');
  const styles = scanTopLevel(doc.read(headerName), 'hh:style');
  if (!styles.length) throw new Error('apply_style: no <hh:style> in header.xml');
  const want = String(style == null ? '' : style).trim();
  if (!want) throw new Error('apply_style: style (name or id) required');
  const wl = want.toLowerCase();
  const hit = styles.find((s) => getAttr(s.attrs, 'id') === want
    || getAttr(s.attrs, 'name') === want
    || (getAttr(s.attrs, 'engName') || '').toLowerCase() === wl);
  if (!hit) {
    const avail = styles.map((s) => getAttr(s.attrs, 'name')).filter(Boolean).join(', ');
    throw new Error(`apply_style: style "${want}" not found. Available: ${avail}`);
  }
  const styleId = getAttr(hit.attrs, 'id');
  const ppr = getAttr(hit.attrs, 'paraPrIDRef');
  const cpr = getAttr(hit.attrs, 'charPrIDRef');
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`apply_style: index ${index} out of range (0..${paras.length - 1})`);
  const { section, el } = paras[index];
  let open = /styleIDRef="\d+"/.test(el.attrs) ? el.attrs.replace(/styleIDRef="\d+"/, `styleIDRef="${styleId}"`) : `${el.attrs} styleIDRef="${styleId}"`;
  if (ppr != null) open = /paraPrIDRef="\d+"/.test(open) ? open.replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${ppr}"`) : `${open} paraPrIDRef="${ppr}"`;
  let inner = el.inner;
  if (cpr != null) inner = inner.replace(/(<hp:run\b[^>]*\bcharPrIDRef=")\d+(")/g, `$1${cpr}$2`);
  doc.write(section, spliceEl(doc.read(section), el, `<hp:p${open}>${dropLinesegs(inner)}</hp:p>`));
  return { index, style: getAttr(hit.attrs, 'name'), styleId, paraPrId: ppr, charPrId: cpr };
}

// Paragraph band (문단 띠 — 강조 띠/콜아웃). A paragraph border/background set on
// the paraPr does NOT survive Hancom Docs web: it silently strips the border+fill
// AND adds spurious numbering (the documented paraPr-normalization trap — same
// root cause as the BULLET list-strip; verified by round-trip). The robust way to
// get a full-width coloured band that DOES survive Hancom web is a 1×1 table whose
// single cell carries the fill + border via cellzones (the proven cell-styling
// path). So para_line replaces the target paragraph with a 1-cell callout table:
// extract its text → delete it → insert a 1×1 table in its place → fill + border
// the cell with the existing (Hancom-verified) cell ops.
const PARA_SIDE_SETS = {
  all: ['left', 'right', 'top', 'bottom'], 'top-bottom': ['top', 'bottom'],
  'left-right': ['left', 'right'], top: ['top'], bottom: ['bottom'], left: ['left'], right: ['right'], none: [],
};
function opParaLine(doc, index, opts) {
  opts = opts || {};
  const fillColor = opts.fill_color ? normHex(opts.fill_color) : null;
  const wantBorder = !!(opts.border || opts.border_color || opts.border_width_mm != null || (opts.sides && String(opts.sides).toLowerCase() !== 'none'));
  if (!fillColor && !wantBorder) throw new Error('para_line: need fill_color and/or a border (border_color / sides)');
  const paras = doc.paragraphs();
  if (index < 0 || index >= paras.length) throw new Error(`para_line: index ${index} out of range (0..${paras.length - 1})`);
  // 1. Extract the paragraph's visible text (its <hp:t> runs, un-escaped).
  const text = [...paras[index].el.inner.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((m) => m[1]).join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // 2. Remove the original paragraph, then 3. drop a 1×1 table into its slot
  //    (insert_table inserts AFTER its index, so index-1; -1 prepends).
  opDeleteParagraph(doc, index);
  opInsertTable(doc, index === 0 ? -1 : index - 1, 1, 1, [[text]]);
  // 4. Find the table that now occupies body slot `index`.
  const bodyP = doc.paragraphs()[index];
  const tbls = doc.tables();
  let tblIdx = tbls.findIndex((t) => t.section === bodyP.section && t.el.start >= bodyP.el.start && t.el.end <= bodyP.el.end);
  if (tblIdx < 0) tblIdx = tbls.length - 1;
  // 4b. Widen the single cell to the table's full content width — the fallback
  //     1×1 cell is otherwise narrow and the text wraps to a tall sliver.
  const tszW = (tbls[tblIdx].el.inner.match(/<hp:sz\b[^>]*\bwidth="(\d+)"/) || [])[1];
  if (tszW) opSetCellSize(doc, tblIdx, 0, 0, Number(tszW), undefined);
  // 5. Fill (cellzone + char shade, so the colour shows on Hancom web) + border.
  if (fillColor) opSetCellBackground(doc, tblIdx, 0, 0, fillColor, 'both');
  if (wantBorder) {
    const bColor = opts.border_color ? normHex(opts.border_color) : '#000000';
    const w = opts.border_width_mm != null ? `${Number(opts.border_width_mm)} mm` : '0.4 mm';
    const sideSet = PARA_SIDE_SETS[String(opts.sides || 'all').toLowerCase()] || PARA_SIDE_SETS.all;
    opSetCellBorder(doc, tblIdx, 0, 0, bColor, w, sideSet.map((s) => s.toUpperCase()));
  }
  return { index, table: tblIdx, fill: fillColor, bordered: wantBorder, text };
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

// Renumber a part family so its numbers are contiguous (1..N), matching what
// Hancom itself does on delete (GT delete-obj-*: deleting the middle image
// renumbers image3→image2, no gap). `prefix`='image'|'chart', `dir`='BinData'|
// 'Chart', `refStyle`='id' (image → binaryItemIDRef=the id) | 'href' (chart →
// chartIDRef=the part name). Renames the file, the manifest item's id+href, and
// every section ref — atomically per move, ascending so targets are always free.
function renumberParts(doc, prefix, dir, refStyle) {
  const hpf = doc.hpfName();
  if (!hpf) return 0;
  let manifest = doc.read(hpf);
  const items = [];
  for (const m of manifest.matchAll(/<opf:item\b[^>]*\/>/g)) {
    const idm = m[0].match(new RegExp(`id="(${prefix}(\\d+))"`));
    const hm = m[0].match(/href="([^"]+)"/);
    if (idm && hm && hm[1].indexOf(`${dir}/`) === 0) items.push({ id: idm[1], n: Number(idm[2]), href: hm[1] });
  }
  items.sort((a, b) => a.n - b.n);
  let moved = 0;
  items.forEach((it, i) => {
    const target = i + 1;
    if (it.n === target) return;
    const ext = (it.href.match(/\.([^.\/]+)$/) || [, ''])[1];
    const newHref = `${dir}/${prefix}${target}${ext ? '.' + ext : ''}`;
    const newId = `${prefix}${target}`;
    if (doc.files[it.href]) { doc.files[newHref] = doc.files[it.href]; delete doc.files[it.href]; }
    manifest = manifest.replace(`id="${it.id}"`, `id="${newId}"`).replace(`href="${it.href}"`, `href="${newHref}"`);
    for (const sn of doc.sectionNames()) {
      let sx = doc.read(sn);
      sx = refStyle === 'href'
        ? sx.split(`chartIDRef="${it.href}"`).join(`chartIDRef="${newHref}"`)
        : sx.split(`binaryItemIDRef="${it.id}"`).join(`binaryItemIDRef="${newId}"`);
      doc.write(sn, sx);
    }
    moved++;
  });
  doc.write(hpf, manifest);
  return moved;
}

// Generic floating-object delete by (target, index) — same addressing as the
// set_object_* family (findObject): target = image / chart / shape (rect·ellipse·
// line·arc·polygon·curve, incl. textbox) / equation, index = 0-based in document
// order. Removes the object's enclosing top-level <hp:p> (insert_* gives each
// object its own paragraph → no empty line left), then drops its external part +
// manifest item (image → BinData/, chart → Chart/). Shape/textbox/equation carry
// no external part → only the paragraph is removed.
// NUMBERING: by default we RENUMBER the remaining parts contiguous (image3→image2)
// to match Hancom's own delete byte-for-byte (GT delete-obj-after-mid-removed).
// `renumber:false` keeps the gap (image1+image3) — also valid (refs are by id so
// it renders identically, and insert is gap-safe).
function opDeleteObject(doc, target, index, renumber) {
  const f = findObject(doc, target, index); // throws if not found
  const blob = (f.el.attrs || '') + (f.el.inner || '');
  const binRef = (blob.match(/binaryItemIDRef="([^"]+)"/) || [])[1] || null;
  const chartHref = (blob.match(/chartIDRef="([^"]+)"/) || [])[1] || null;
  // 1) drop the enclosing top-level paragraph (fallback: just the element)
  let xml = doc.read(f.name);
  const host = scanTopLevel(xml, 'hp:p').find((p) => p.start <= f.el.start && f.el.end <= p.end);
  xml = host ? spliceEl(xml, host, '') : spliceEl(xml, f.el, '');
  doc.write(f.name, dropLinesegs(xml));
  // 2) drop the external part + its manifest item (no dangling ref)
  let removedPart = null;
  let renumbered = 0;
  const hpf = doc.hpfName();
  const doRenumber = renumber !== false; // default ON (match Hancom GT)
  if (binRef && hpf) {
    let s = doc.read(hpf);
    const hm = s.match(new RegExp(`<opf:item [^>]*id="${escapeRegex(binRef)}"[^>]*href="([^"]+)"[^>]*/>|<opf:item [^>]*href="([^"]+)"[^>]*id="${escapeRegex(binRef)}"[^>]*/>`));
    removedPart = hm ? (hm[1] || hm[2]) : null;
    s = s.replace(new RegExp(`<opf:item [^>]*id="${escapeRegex(binRef)}"[^>]*/>`), '');
    doc.write(hpf, s);
    if (removedPart && doc.files[removedPart]) delete doc.files[removedPart];
    if (doRenumber) renumbered = renumberParts(doc, 'image', 'BinData', 'id');
  } else if (chartHref && hpf) {
    let s = doc.read(hpf);
    s = s.replace(new RegExp(`<opf:item [^>]*href="${escapeRegex(chartHref)}"[^>]*/>`), '');
    doc.write(hpf, s);
    if (doc.files[chartHref]) delete doc.files[chartHref];
    removedPart = chartHref;
    if (doRenumber) renumbered = renumberParts(doc, 'chart', 'Chart', 'href');
  }
  return { target, index: Math.max(0, Number(index) || 0), tag: f.tag, removedPart, renumbered, deleted: true };
}

function opInsertImage(doc, sourcePath, ext, width, height, index) {
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
  const pic = buildPic(doc, itemId, width, height);
  const plainAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;
  // `index` optional: place the image's paragraph AFTER top-level paragraph
  // `index` (so an image lands next to its reference text, like insert_chart)
  // instead of always appending to the doc end. Omit → append.
  const allParas = doc.paragraphs();
  const idx = Number.isInteger(index) ? index : null;
  if (idx != null && idx >= 0 && idx < allParas.length) {
    const { section, el } = allParas[idx];
    const cpr = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
    const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${cpr}">${pic}</hp:run></hp:p>`;
    const sxml = doc.read(section);
    doc.write(section, sxml.slice(0, el.end) + para + sxml.slice(el.end));
    return { entry, itemId, inserted: true, afterIndex: idx };
  }
  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const lastParas = scanTopLevel(xml, 'hp:p');
  const charPrId = lastParas.length ? (lastParas[lastParas.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1] : '0';
  const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${pic}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { entry, itemId, inserted: true, appended: true };
}

// Embed an image binary + manifest entry, return its itemId (shared by
// insert_image-into-cell). Mirrors opInsertImage's embed half.
function embedImageBinary(doc, sourcePath, ext) {
  ext = (ext || path.extname(sourcePath).slice(1) || 'png').toLowerCase();
  if (!MIME[ext]) throw new Error(`image: unsupported ext .${ext} (png/jpg/bmp/gif)`);
  const existing = Object.keys(doc.files).filter((n) => /^BinData\//i.test(n));
  const usedIds = new Set();
  const hpf = doc.hpfName();
  if (hpf) for (const m of doc.read(hpf).matchAll(/<opf:item [^>]*id="([^"]+)"/g)) usedIds.add(m[1]);
  let n = 1;
  while (existing.some((p) => p.endsWith(`/image${n}.${ext}`) || p.endsWith(`/img${n}.${ext}`)) || usedIds.has(`image${n}`)) n++;
  const entry = `BinData/image${n}.${ext}`, itemId = `image${n}`;
  doc.files[entry] = new Uint8Array(fs.readFileSync(sourcePath));
  if (hpf) {
    let s = doc.read(hpf);
    if (!s.includes(`href="${entry}"`)) {
      s = s.replace(/<\/opf:manifest>/, `<opf:item id="${itemId}" href="${entry}" media-type="${MIME[ext]}" isEmbeded="1"/></opf:manifest>`);
      doc.write(hpf, s);
    }
  }
  return { entry, itemId };
}

// Place ANY inline object XML (pic / shape / chart …) into a table cell. The
// object must be treated-as-char (treatAsChar="1") so it flows inside the cell
// like a glyph instead of floating out (user insight: "글자처럼 취급하면 글처럼
// 들어간다"). insert_image/insert_shape only append to the body — this is the
// shared path for getting objects INTO a cell. Appended as a run on the cell's
// first paragraph (after any existing text).
// Place a seal/signature image RELATIVE TO an anchor text ("서명 또는 인" / "(서명)"
// / "(인)" …). ALWAYS FLOATING (앞으로/front) so it NEVER grows the cell/table/page
// (inline would push layout — forbidden). The horizontal position is COMPUTED from
// the width of the text BEFORE the anchor (font metrics) — no render needed; render
// is only for verify/feedback. Works in a body paragraph OR a table cell (offset is
// relative to that paragraph's / cell's left edge — same math).
//   mode "overlap" — seal CENTER on the anchor center (동심/concentric). Use when
//     there's no room to the right (e.g. anchor near a cell edge / right margin).
//   mode "right" (default) — seal just to the RIGHT of the anchor (right-parallel).
// dx_mm / dy_mm OVERRIDE the computed offsets (para-left / para-top relative) when a
// render shows it needs a nudge. size_mm = seal size (default 16). font_pt overrides
// the auto-detected font size used for width estimation.
const PT2MM = 25.4 / 72;
function estTextWidthMm(s, pt) {
  const em = pt * PT2MM;
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3000 && c <= 0x303F) || (c >= 0x3130 && c <= 0x318F) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xFF00 && c <= 0xFFEF);
    w += wide ? em : em * 0.5; // full-width (Hangul/CJK) vs half-width (ASCII/space/punct)
  }
  return w;
}
function charPrFontPt(doc, charPrId) {
  if (charPrId == null) return 10;
  for (const n of Object.keys(doc.files)) {
    if (!/header\.xml$/i.test(n)) continue;
    const h = doc.read(n);
    const m = h.match(new RegExp(`<hh:charPr\\b[^>]*\\bid="${charPrId}"[^>]*?\\bheight="(\\d+)"`))
           || h.match(new RegExp(`<hh:charPr\\b[^>]*\\bheight="(\\d+)"[^>]*?\\bid="${charPrId}"`));
    if (m) return Math.max(6, Number(m[1]) / 100);
  }
  return 10;
}
// Natural aspect ratio (width / height) of an image file, so a non-square
// signature (e.g. a wide handwritten "홍 길 동") keeps its shape instead of
// being squashed into a square. PNG/JPEG/BMP headers; defaults to 1 (square).
function imageAspectWH(p) {
  try {
    const b = fs.readFileSync(p);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) { // PNG: IHDR w@16 h@20
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
      if (w && h) return w / h;
    } else if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: scan SOFn markers
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7);
          if (w && h) return w / h;
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    } else if (b[0] === 0x42 && b[1] === 0x4d && b.length > 26) { // BMP
      const w = Math.abs(b.readInt32LE(18)), h = Math.abs(b.readInt32LE(22));
      if (w && h) return w / h;
    }
  } catch { /* fall through */ }
  return 1;
}

// Read a paraPr's line-spacing % and 위/아래 문단여백 (mm) for height estimation.
// Prefers the HwpUnitChar <hp:case> margin — the one Hancom web actually renders.
function sealParaPrMetrics(doc, paraPrId) {
  const out = { pct: 160, prevMm: 0, nextMm: 0 };
  if (paraPrId == null) return out;
  for (const n of Object.keys(doc.files)) {
    if (!/header\.xml$/i.test(n)) continue;
    const h = doc.read(n);
    const i = h.indexOf(`<hh:paraPr id="${paraPrId}"`);
    if (i < 0) continue;
    const end = h.indexOf('</hh:paraPr>', i);
    const blk = h.slice(i, end < 0 ? i + 5000 : end);
    const caseM = blk.match(/HwpUnitChar[\s\S]*?<hh:margin>([\s\S]*?)<\/hh:margin>/);
    const marg = (caseM ? caseM[1] : (blk.match(/<hh:margin>([\s\S]*?)<\/hh:margin>/) || [, ''])[1]) || '';
    const prev = marg.match(/<hc:prev value="(\d+)"/);
    const next = marg.match(/<hc:next value="(\d+)"/);
    if (prev) out.prevMm = Number(prev[1]) / 283.46;
    if (next) out.nextMm = Number(next[1]) / 283.46;
    const ls = blk.match(/<hh:lineSpacing[^>]*type="PERCENT"[^>]*value="(\d+)"/);
    if (ls) out.pct = Number(ls[1]);
    return out;
  }
  return out;
}
// Horizontal alignment of a paragraph (LEFT/CENTER/RIGHT/JUSTIFY/...) from its
// paraPr — cells in real Korean forms are usually CENTER, so a seal anchored to
// such a line must account for the line being centred in its box, not left-hugged.
function sealParaAlign(doc, paraPrId) {
  if (paraPrId == null) return 'LEFT';
  for (const n of Object.keys(doc.files)) {
    if (!/header\.xml$/i.test(n)) continue;
    const h = doc.read(n);
    const i = h.indexOf(`<hh:paraPr id="${paraPrId}"`);
    if (i < 0) continue;
    const blk = h.slice(i, h.indexOf('</hh:paraPr>', i) + 12);
    const m = blk.match(/<hh:align\b[^>]*\bhorizontal="([^"]*)"/);
    return m ? m[1].toUpperCase() : 'LEFT';
  }
  return 'LEFT';
}
// Vertical advance (mm) from a paragraph's top to the next block's top.
function sealParaAdvanceMm(doc, pInner, pAttrs, pageTextWmm) {
  const pt = charPrFontPt(doc, (pInner.match(/charPrIDRef="(\d+)"/) || [, null])[1]);
  const m = sealParaPrMetrics(doc, (pAttrs.match(/paraPrIDRef="(\d+)"/) || [, null])[1]);
  const txt = (pInner.match(/<hp:t>([^<]*)<\/hp:t>/g) || []).map((s) => s.replace(/<\/?hp:t>/g, '')).join('');
  const lines = Math.max(1, Math.ceil(estTextWidthMm(txt, pt) / Math.max(10, pageTextWmm)));
  return m.prevMm + lines * (pt * PT2MM * (m.pct / 100)) + m.nextMm;
}
// Vertical advance (mm) of a table block = outMargin top/bottom + Σ row heights.
function sealTableAdvanceMm(doc, tblInner) {
  const om = tblInner.match(/<hp:outMargin\b[^>]*\btop="(\d+)"[^>]*\bbottom="(\d+)"/);
  const top = om ? Number(om[1]) / 283.46 : 0;
  const bot = om ? Number(om[2]) / 283.46 : 0;
  let h = 0;
  for (const r of scanTopLevel(tblInner, 'hp:tr')) {
    let rh = 0;
    for (const c of scanTopLevel(r.inner, 'hp:tc')) {
      const sub = scanTopLevel(c.inner, 'hp:subList')[0];
      const lines = sub ? Math.max(1, scanTopLevel(sub.inner, 'hp:p').filter((pp) => /<hp:t>/.test(pp.inner)).length) : 1;
      const ptc = charPrFontPt(doc, (c.inner.match(/charPrIDRef="(\d+)"/) || [, null])[1]);
      const cm = c.inner.match(/<hp:cellMargin\b[^>]*\btop="(\d+)"[^>]*\bbottom="(\d+)"/);
      const mv = cm ? (Number(cm[1]) + Number(cm[2])) / 283.46 : 2.8;
      rh = Math.max(rh, lines * (ptc * PT2MM * 1.3) + mv);
    }
    h += rh || 7;
  }
  return top + h + bot;
}

// Locate the (possibly NESTED) table cell whose own text contains `anchor`, and
// return the seal origin (mm) measured from the TOP-LEVEL table's top-left,
// accumulated down the nesting path (a table inside a cell sits at that cell's
// content corner). Floating offsets are relative to the top-level table anchor,
// so a deep cell is just the path sum — and the seal run can be spliced into the
// top-level cell (its render position is offset-driven, not run-location-driven).
// Without this, a signature cell inside a nested table matched the OUTER cell and
// the stamp landed on the wrong (outer) row — the nested-cell-width bug.
function sealDescend(doc, tblInner, anchor, accX, accY, H) {
  const ptxt = (inner) => (inner.match(/<hp:t>([^<]*)<\/hp:t>/g) || []).map((s) => s.replace(/<\/?hp:t>/g, '')).join('');
  // A cell's OWN cellAddr/cellSpan/cellSz/cellMargin come AFTER its <hp:subList>.
  // If the cell holds a NESTED table, that table's cellAddr/Sz/... sit inside the
  // subList and would be matched first by a plain .match() — reading the inner
  // cell's attrs instead of this cell's. So read own attrs from the tail after
  // the cell's last </hp:subList>. (This was the nested-cell-width bug.)
  const own = (ti) => { const k = ti.lastIndexOf('</hp:subList>'); return k >= 0 ? ti.slice(k) : ti; };
  const rows = scanTopLevel(tblInner, 'hp:tr');
  if (!rows.length) return null;
  const tblW = Number((tblInner.match(/<hp:sz\b[^>]*\bwidth="(\d+)"/) || [, 0])[1]);
  const om = tblInner.match(/<hp:outMargin\b[^>]*\bleft="(\d+)"[^>]*\btop="(\d+)"/);
  const outL = om ? Number(om[1]) / H : 0;
  const outT = om ? Number(om[2]) / H : 0;
  let colCnt = 1; const colW = {};
  for (const r of rows) for (const c of scanTopLevel(r.inner, 'hp:tc')) {
    const o = own(c.inner);
    const ca = Number((o.match(/\bcolAddr="(\d+)"/) || [, -1])[1]);
    if (ca + 1 > colCnt) colCnt = ca + 1;
    const w = Number((o.match(/<hp:cellSz\b[^>]*\bwidth="(\d+)"/) || [, 0])[1]);
    if (ca >= 0 && w > 100 && colW[ca] == null) colW[ca] = w;
  }
  const colWmm = (c) => (colW[c] != null ? colW[c] : (tblW ? tblW / colCnt : 0)) / H;
  const rowHmm = (rEl) => {
    let h = 0;
    for (const c of scanTopLevel(rEl.inner, 'hp:tc')) {
      const o = own(c.inner);
      const csH = Number((o.match(/<hp:cellSz\b[^>]*\bheight="(\d+)"/) || [, 0])[1]);
      const rs = Math.max(1, Number((o.match(/\browSpan="(\d+)"/) || [, 1])[1]));
      let hi;
      if (csH > 300) {
        hi = (csH / rs) / H;
      } else {
        const sub = scanTopLevel(c.inner, 'hp:subList')[0];
        const lines = sub ? Math.max(1, scanTopLevel(sub.inner, 'hp:p').filter((pp) => /<hp:t>/.test(pp.inner)).length) : 1;
        const ptc = charPrFontPt(doc, (c.inner.match(/charPrIDRef="(\d+)"/) || [, null])[1]);
        const cm = o.match(/<hp:cellMargin\b[^>]*\btop="(\d+)"[^>]*\bbottom="(\d+)"/);
        const mv = cm ? (Number(cm[1]) + Number(cm[2])) / H : 2.8;
        hi = lines * (ptc * PT2MM * 1.3) + mv;
      }
      h = Math.max(h, hi);
    }
    return h || 7;
  };
  for (let ri = rows.length - 1; ri >= 0; ri--) {
    const tcs = scanTopLevel(rows[ri].inner, 'hp:tc');
    for (let ci = tcs.length - 1; ci >= 0; ci--) {
      const tc = tcs[ci];
      if (!ptxt(tc.inner).includes(anchor)) continue;
      const o = own(tc.inner);
      const tcCol = Number((o.match(/\bcolAddr="(\d+)"/) || [, ci])[1]);
      const tcRow = Number((o.match(/\browAddr="(\d+)"/) || [, ri])[1]);
      let colX = 0; for (let c = 0; c < tcCol; c++) colX += colWmm(c);
      let rowY = 0; for (let r = 0; r < tcRow; r++) rowY += rowHmm(rows[r]);
      const cm = o.match(/<hp:cellMargin\b[^>]*\bleft="(\d+)"[^>]*\bright="(\d+)"[^>]*\btop="(\d+)"/);
      const cmL = cm ? Number(cm[1]) / H : 1.41, cmR = cm ? Number(cm[2]) / H : 1.41, cmT = cm ? Number(cm[3]) / H : 1.41;
      const cellX = accX + outL + colX + cmL;     // content-left from top-level table top-left
      const cellTopY = accY + outT + rowY + cmT;   // content-top
      // A table nested inside this cell that also carries the anchor → recurse.
      const nested = scanTopLevel(tc.inner, 'hp:tbl').find((nt) => ptxt(nt.inner).includes(anchor));
      if (nested) {
        const deep = sealDescend(doc, nested.inner, anchor, cellX, cellTopY, H);
        if (deep) return deep;
      }
      const sub = scanTopLevel(tc.inner, 'hp:subList')[0];
      if (!sub) continue;
      const p = scanTopLevel(sub.inner, 'hp:p')[0];
      if (!p) continue;
      const tcH = Number((o.match(/<hp:cellSz\b[^>]*\bheight="(\d+)"/) || [, 0])[1]);
      const tcRs = Math.max(1, Number((o.match(/\browSpan="(\d+)"/) || [, 1])[1]));
      const vAlign = (sub.attrs.match(/vertAlign="([^"]*)"/) || [, 'CENTER'])[1].toUpperCase();
      const centred = tcH > 300 && vAlign !== 'TOP';
      const originYMm = centred ? (accY + outT + rowY + (tcH / tcRs) / H / 2) : cellTopY;
      const alignH = sealParaAlign(doc, (p.attrs.match(/paraPrIDRef="(\d+)"/) || [, null])[1]);
      const boxWidthMm = Math.max(2, colWmm(tcCol) - cmL - cmR);
      return { pInner: p.inner, originXMm: cellX, originYMm, boxWidthMm, vFactor: centred ? 0 : -0.08, alignH };
    }
  }
  return null;
}

function opPlaceSeal(doc, op) {
  const anchor = op.anchor;
  if (!anchor) throw new Error('place_seal: "anchor" text is required (e.g. "서명 또는 인")');
  if (!op.source) throw new Error('place_seal: "source" (seal/signature PNG) is required');
  const fixedMm = op.size_mm != null ? Number(op.size_mm) : null;
  const { itemId } = embedImageBinary(doc, op.source, op.ext);
  // size_mm / auto-size drive the HEIGHT; width follows the image's aspect so a
  // wide signature stays wide (never forced square).
  const aspect = imageAspectWH(op.source) || 1;
  const forcedMode = op.mode && String(op.mode).toLowerCase() !== 'auto'
    ? (String(op.mode).toLowerCase() === 'overlap' ? 'overlap' : 'right')
    : null; // null = decide automatically from the room beside the anchor
  // Coordinate frame for the floating offsets (= hp:pos vert/horzRelTo):
  //   PARA  (default) — origin = anchor paragraph top-left. Hancom CLAMPS the
  //         object so it can't rise above that paragraph's top, so a stamp
  //         taller than a one-line body paragraph rests on the line and peeks
  //         downward (can't be vertically centred on the text by offset).
  //   PAGE  — origin = body content top-left (inside margins). NO per-paragraph
  //         clamp → with explicit dx_mm/dy_mm (page coords) the agent can centre
  //         a stamp on any free-text line. (dx_mm/dy_mm strongly recommended;
  //         the auto offsets below are PARA-relative.)
  //   PAPER — origin = physical paper (0,0) corner.
  // Default frame is chosen per location below: PARA for table cells (the cell's
  // table is tall, no clamp), PAGE for free body text (so it aligns ON the line
  // instead of being clamped low). op.frame overrides.
  const userFrame = op.frame ? String(op.frame).toUpperCase() : null;
  const paraText = (inner) => (inner.match(/<hp:t>([^<]*)<\/hp:t>/g) || []).map((s) => s.replace(/<\/?hp:t>/g, '')).join('');
  const H = 283.46; // HWPUNIT per mm
  // Sense a sensible seal size from the spot it lands in, unless size_mm is
  // given. A name seal reads well at ~1.8× the anchor text's line height, so a
  // bigger font gets a bigger seal and a small one-line cell gets a small one
  // (it just peeks if the cell is shorter — see flowWithText note below). The
  // size is then capped by the room available so it can't overflow: by the
  // space to the right of the anchor (right mode) or by the box width (overlap),
  // and finally clamped to a real-stamp range.
  const clampMm = (v) => Math.max(7, Math.min(18, v));
  // Returns the HEIGHT (mm); width = height × aspect. Caps the height so the
  // (possibly wide) width still fits the room: by the space to the right of the
  // anchor (right mode) or the box width (overlap).
  const senseMm = (pt, ov, boxWidthMm, roomRightMm) => {
    let h = pt * PT2MM * 1.3 * 1.6;
    if (!ov && roomRightMm != null) h = Math.min(h, roomRightMm / aspect);
    if (ov && boxWidthMm != null) h = Math.min(h, (boxWidthMm * 0.95) / aspect);
    return Math.round(clampMm(h) * 10) / 10;
  };
  const sealRun = (sealMm, dxMm, dyMm, frm) => {
    const hHwp = Math.round(sealMm * H);
    const wHwp = Math.round(sealMm * aspect * H);
    // treatAsChar="0" + flowWithText="0" = a truly fixed floating overlay: it
    // NEVER reserves vertical space inside its anchor cell/paragraph, so the
    // table row (and the page) can't grow to "fit" the seal. NOTE: a front /
    // floating object with flowWithText="1" STILL makes Hancom auto-grow the
    // cell to contain it — only flowWithText="0" stops that. A seal taller than
    // the line then just peeks out above/below, by design, instead of stretching
    // the cell. allowOverlap lets it sit on top of the text.
    const pic = buildPic(doc, itemId, wHwp, hHwp)
      .replace(/treatAsChar="[^"]*"/, 'treatAsChar="0"')
      .replace(/flowWithText="[^"]*"/, 'flowWithText="0"')
      .replace(/allowOverlap="[^"]*"/, 'allowOverlap="1"')
      .replace(/textWrap="[^"]*"/, 'textWrap="IN_FRONT_OF_TEXT"')
      .replace(/vertRelTo="[^"]*"/, `vertRelTo="${frm}"`)
      .replace(/horzRelTo="[^"]*"/, `horzRelTo="${frm}"`)
      .replace(/horzOffset="[^"]*"/, `horzOffset="${Math.round(dxMm * H)}"`)
      .replace(/vertOffset="[^"]*"/, `vertOffset="${Math.round(dyMm * H)}"`);
    return `<hp:run charPrIDRef="0">${pic}</hp:run>`;
  };
  // Compute the floating offset from the font metrics of the text before the
  // anchor. A fixed (flowWithText="0") object's offsets are PARA-relative for a
  // body paragraph, but for an object inside a TABLE CELL the origin is the
  // table's anchor paragraph (text-area-left, table-top) — NOT the cell. So the
  // caller passes originXMm/originYMm = the cell's content-corner measured from
  // that origin (preceding column widths + row heights + table/cell margins),
  // and 0/0 for free body text. boxWidthMm = the box's usable inner width (mm);
  // roomWidthMm = the width within which "room to the right" is measured.
  const calc = (inner, o) => {
    const { originXMm = 0, originYMm = 0, boxWidthMm = null, roomWidthMm = null, vFactor = -0.08, alignH = 'LEFT' } = o || {};
    const txt = paraText(inner);
    const pt = op.font_pt != null ? Number(op.font_pt) : charPrFontPt(doc, (inner.match(/charPrIDRef="(\d+)"/) || [, null])[1]);
    const idx = txt.indexOf(anchor);
    const startX = estTextWidthMm(idx >= 0 ? txt.slice(0, idx) : txt, pt);
    const aw = estTextWidthMm(anchor, pt);
    // The whole line may be centred/right-aligned in its box (default for cells),
    // so the anchor doesn't start at the content left — shift by where the line
    // actually begins.
    const fullW = estTextWidthMm(txt, pt);
    let lineLeft = 0;
    if (boxWidthMm != null && fullW < boxWidthMm) {
      if (alignH === 'CENTER' || alignH === 'DISTRIBUTE') lineLeft = (boxWidthMm - fullW) / 2;
      else if (alignH === 'RIGHT') lineLeft = boxWidthMm - fullW;
    }
    const roomRight = roomWidthMm != null ? Math.max(0, roomWidthMm - (lineLeft + startX + aw)) : null;
    // Auto mode: park it to the right when there's comfortably room beside the
    // anchor (the object's WIDTH must fit), otherwise sit on top (overlap).
    const prov = fixedMm != null ? fixedMm : senseMm(pt, false, null, null);
    const ov = forcedMode ? forcedMode === 'overlap'
      : !(roomRight != null && roomRight >= prov * aspect + 2);
    const sealMm = fixedMm != null ? fixedMm : senseMm(pt, ov, boxWidthMm, roomRight);
    const wMm = sealMm * aspect;
    // Vertical centre of the text line in the offset frame. vFactor × em:
    // ≈ -0.08 when the origin is the line's own top (PARA cell / clamped body),
    // ≈ +0.2 when the origin is the page/content top and originYMm carried the
    // line's distance down to it (free-text PAGE frame). dy_mm overrides.
    const lineMidMm = pt * PT2MM * vFactor;
    let dx = originXMm + lineLeft + (ov ? (startX + aw / 2 - wMm / 2) : (startX + aw + 2));
    let dy = originYMm + (lineMidMm - sealMm / 2);
    if (op.dx_mm != null) dx = Number(op.dx_mm);
    if (op.dy_mm != null) dy = Number(op.dy_mm);
    return { sealMm, wMm, dx, dy, mode: ov ? 'overlap' : 'right' };
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  // 1) body top-level paragraphs (skip table-wrapper paragraphs). Free body text
  // defaults to the PAGE frame so the stamp aligns ON the line: the PARA frame
  // clamps a tall stamp to the line top (it then rests low), but PAGE has no
  // such clamp. We compute the anchor line's distance from the page content top
  // by summing the heights of the blocks above it (real paraPr line-spacing +
  // 문단여백), then centre on the line. op.frame / dy_mm override.
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const roomWidthMm = pageTextWidth(doc, name) / H;
    const blocks = scanTopLevel(xml, 'hp:p');
    let k = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].inner.includes('<hp:tbl')) continue;
      if (paraText(blocks[i].inner).includes(anchor)) { k = i; break; }
    }
    if (k < 0) continue;
    const p = blocks[k];
    const frm = userFrame || 'PAGE';
    let o;
    if (frm === 'PAGE') {
      let topMm = 0;
      for (let i = 0; i < k; i++) {
        const b = blocks[i];
        if (b.inner.includes('<hp:tbl')) topMm += sealTableAdvanceMm(doc, scanTopLevel(b.inner, 'hp:tbl')[0].inner);
        else topMm += sealParaAdvanceMm(doc, b.inner, b.attrs, roomWidthMm);
      }
      o = { originYMm: topMm, roomWidthMm, vFactor: 0.2 };
    } else {
      o = { roomWidthMm }; // user forced PARA/PAPER (PARA rests low — its choice)
    }
    const { sealMm, wMm, dx, dy, mode } = calc(p.inner, o);
    doc.write(name, dropLinesegs(spliceEl(xml, p, `<hp:p${p.attrs}>${p.inner}${sealRun(sealMm, dx, dy, frm)}</hp:p>`)));
    return { placed: true, anchor, mode, frame: frm.toLowerCase(), where: 'paragraph', size_mm: sealMm, width_mm: r1(wMm), dx_mm: r1(dx), dy_mm: r1(dy) };
  }
  // 2) table cells. sealDescend() finds the cell whose own text holds the anchor
  // — recursing through NESTED tables — and returns the seal origin summed down
  // the nesting path (relative to the top-level table's top-left). The seal run
  // is then spliced into the TOP-LEVEL cell that contains the anchor: because the
  // object is floating, its render position is the offset, not where the run
  // lives, so we never have to rebuild deeply-nested XML.
  for (const name of doc.sectionNames()) {
    let xml = doc.read(name);
    const tbls = scanTopLevel(xml, 'hp:tbl');
    for (let ti = tbls.length - 1; ti >= 0; ti--) {
      const tbl = tbls[ti];
      if (!paraText(tbl.inner).includes(anchor)) continue;
      const geom = sealDescend(doc, tbl.inner, anchor, 0, 0, H);
      if (!geom) continue;
      const { sealMm, wMm, dx, dy, mode } = calc(geom.pInner, {
        originXMm: geom.originXMm,
        originYMm: geom.originYMm,
        boxWidthMm: geom.boxWidthMm,
        roomWidthMm: geom.boxWidthMm,
        vFactor: geom.vFactor,
        alignH: geom.alignH,
      });
      // Splice the seal run into the top-level cell that contains the anchor.
      const rows = scanTopLevel(tbl.inner, 'hp:tr');
      for (let ri = rows.length - 1; ri >= 0; ri--) {
        const tcs = scanTopLevel(rows[ri].inner, 'hp:tc');
        for (let ci = tcs.length - 1; ci >= 0; ci--) {
          const tc = tcs[ci];
          if (!paraText(tc.inner).includes(anchor)) continue;
          const sub = scanTopLevel(tc.inner, 'hp:subList')[0];
          const p = scanTopLevel(sub.inner, 'hp:p')[0];
          const newSub = `<hp:subList${sub.attrs}>${spliceEl(sub.inner, p, `<hp:p${p.attrs}>${p.inner}${sealRun(sealMm, dx, dy, 'PARA')}</hp:p>`)}</hp:subList>`;
          const newTc = `<hp:tc${tc.attrs}>${spliceEl(tc.inner, sub, newSub)}</hp:tc>`;
          const newRow = `<hp:tr${rows[ri].attrs}>${spliceEl(rows[ri].inner, tc, newTc)}</hp:tr>`;
          xml = spliceEl(xml, tbl, `<hp:tbl${tbl.attrs}>${spliceEl(tbl.inner, rows[ri], newRow)}</hp:tbl>`);
          doc.write(name, dropLinesegs(xml));
          return { placed: true, anchor, mode, where: 'cell', table: ti, row: ri, col: ci, size_mm: sealMm, width_mm: r1(wMm), dx_mm: r1(dx), dy_mm: r1(dy) };
        }
      }
    }
  }
  throw new Error(`place_seal: anchor "${anchor}" not found in any paragraph or cell`);
}

function placeObjectInCell(doc, tableIndex, row, col, objXml, opName) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (row < 0 || row >= rows.length) throw new Error(`${opName}: row ${row} out of range`);
  const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
  if (col < 0 || col >= tcs.length) throw new Error(`${opName}: col ${col} out of range`);
  const tc = tcs[col];
  const subs = scanTopLevel(tc.inner, 'hp:subList');
  if (!subs.length) throw new Error(`${opName}: cell has no <hp:subList>`);
  const ps = scanTopLevel(subs[0].inner, 'hp:p');
  if (!ps.length) throw new Error(`${opName}: cell has no <hp:p>`);
  const p = ps[0];
  const charPrId = (p.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const newPInner = p.inner + `<hp:run charPrIDRef="${charPrId}">${objXml}</hp:run>`;
  const newSub = `<hp:subList${subs[0].attrs}>${spliceEl(subs[0].inner, p, `<hp:p${p.attrs}>${newPInner}</hp:p>`)}</hp:subList>`;
  const newTc = `<hp:tc${tc.attrs}>${spliceEl(tc.inner, subs[0], newSub)}</hp:tc>`;
  const newRow = `<hp:tr${rows[row].attrs}>${spliceEl(rows[row].inner, tc, newTc)}</hp:tr>`;
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${spliceEl(el.inner, rows[row], newRow)}</hp:tbl>`));
}

// Default breathing margin (여백) around an in-cell object, per side.
const CELL_OBJ_MARGIN = Math.round(1.4 * 283.46); // HWPUNIT (~1.4mm)
const CELL_OBJ_MARGIN_MM = 1.4;

// Read a table cell's usable inner content width (HWPUNIT) — what an inline
// object must fit inside. Hancom renders cells at their <hp:cellSz> width (it
// recomputes the table <hp:sz> from the column-width sum, so cellSz, not table
// sz, is authoritative) and clips an object wider than the cell. The content
// area is cellSz minus the cell's left/right 안여백: the cell's own cellMargin
// when it carries one (hasMargin="1"), otherwise the inherited table inMargin
// (GT 2026-06-18: a hasMargin="0" cell inherits table inMargin left/right 510
// ≈ 1.8mm — ignoring it made the object overflow the content area and hug the
// right border). Returns null when cellSz looks like rhwp garbage (width ≤ 100).
function cellContentWidth(doc, tableIndex, row, col) {
  try {
    const { el } = getTable(doc, tableIndex);
    const rows = scanTopLevel(el.inner, 'hp:tr');
    if (row < 0 || row >= rows.length) return null;
    const tcs = scanTopLevel(rows[row].inner, 'hp:tc');
    if (col < 0 || col >= tcs.length) return null;
    const tc = tcs[col];
    const szM = tc.inner.match(/<hp:cellSz\b[^>]*\bwidth="(\d+)"/);
    if (!szM) return null;
    const w = Number(szM[1]);
    if (!(w > 100)) return null; // rhwp garbage width="1" → caller default
    const sumLR = (s) => s ? Number((s.match(/\bleft="(\d+)"/) || [, 0])[1]) + Number((s.match(/\bright="(\d+)"/) || [, 0])[1]) : 0;
    const lr = /hasMargin="1"/.test(tc.attrs)
      ? sumLR((tc.inner.match(/<hp:cellMargin\b[^>]*\/?>/) || [])[0])        // cell's own
      : sumLR((el.inner.match(/<hp:inMargin\b[^>]*\/?>/) || [])[0]);        // inherited table inMargin
    return Math.max(0, w - lr);
  } catch { return null; }
}

// Clamp an inline object's [w,h] so it fits the cell's content width (cellSz −
// 안여백), preserving aspect ratio. No-op when the cell width is unknown
// (garbage cellSz) or it already fits. This is the "적당한 크기 자동조절" rule
// (table size fixed → shrink the object); ⚠️ keep it aligned with the HWP track
// (cell-patch.js) — memory hwpx-cell-object-sizing-align-hwp.
function fitToCell(doc, tableIndex, row, col, w, h) {
  const cw = cellContentWidth(doc, tableIndex, row, col);
  if (cw == null) return [w, h];
  if (w <= cw) return [w, h];
  return [cw, Math.max(1, Math.round(h * (cw / w)))];
}

// Ensure an object cell carries explicit left/right 안여백 so the inline object
// renders inset symmetrically from the side borders. Skips a cell the caller
// already padded (hasMargin="1"), to respect an explicit set_cell_margin. Uses
// the verified set_cell_margin mechanism (hasMargin="1" + <hp:cellMargin>);
// horizontal margin = this cellMargin (object clamped to fill the content
// width), vertical margin = the object's outMargin top/bottom + centre align.
function ensureCellObjPadding(doc, tableIndex, row, col) {
  const { el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  const tc = rows[row] && scanTopLevel(rows[row].inner, 'hp:tc')[col];
  if (tc && /hasMargin="1"/.test(tc.attrs)) return;
  opSetCellMargin(doc, tableIndex, row, col, { left: CELL_OBJ_MARGIN_MM, right: CELL_OBJ_MARGIN_MM });
}

// Give an in-cell object vertical breathing room via <hp:outMargin> top/bottom
// only. Horizontal margin comes from the cell's cellMargin (ensureCellObjPadding)
// + the width clamp, not from left/right outMargin — an inline object's
// left/right outMargin renders one-sided (the object is a glyph on the line, so
// it can't centre that way; GT-measured L≈2mm / R≈0.5mm). top/bottom instead
// grows the line/row height so vertical-centre alignment yields an even gap.
function withCellMargin(xml, m) {
  const om = `<hp:outMargin left="0" right="0" top="${m}" bottom="${m}"/>`;
  return /<hp:outMargin\b[^>]*\/>/.test(xml) ? xml.replace(/<hp:outMargin\b[^>]*\/>/, om) : xml;
}

// 이미지를 표 셀 안에 (inline). width/height HWPUNIT.
function opSetCellImage(doc, tableIndex, row, col, sourcePath, ext, width, height) {
  const { entry, itemId } = embedImageBinary(doc, sourcePath, ext);
  ensureCellObjPadding(doc, tableIndex, row, col); // 좌우 셀 안여백(대칭)
  // 기본 크기는 작게(30×20mm; 본문 insert_image 100mm 와 달리), 그리고 fitToCell 로 셀
  // content 너비(cellSz − 안여백)에 클램프해 셀을 넘지 않게 한다(넘으면 한컴이 잘라버림).
  // 호출자가 width_mm 로 지정해도 content 보다 크면 비율 유지하며 줄인다.
  // ⚠️ 이 기본/맞춤 규칙은 HWP 트랙과 정합 필요 — 메모리 hwpx-cell-object-sizing-align-hwp.
  width = width || Math.round(30 * 283.46);
  height = height || Math.round(20 * 283.46);
  [width, height] = fitToCell(doc, tableIndex, row, col, width, height);
  let pic = buildPic(doc, itemId, width, height).replace(/treatAsChar="[^"]*"/, 'treatAsChar="1"');
  pic = withCellMargin(pic, CELL_OBJ_MARGIN); // 상하 여백
  placeObjectInCell(doc, tableIndex, row, col, pic, 'set_cell_image');
  opSetCellAlign(doc, tableIndex, row, col, 'CENTER', 'CENTER'); // 셀 안에서 가운데
  return { table: tableIndex, row, col, entry, itemId, inCell: true, width, height };
}

// 도형(사각형/타원/선)을 표 셀 안에 (inline, 글자처럼 취급).
function opSetCellShape(doc, op) {
  const shape = ({ rect: 'rect', rectangle: 'rect', box: 'rect', ellipse: 'ellipse', oval: 'ellipse', circle: 'ellipse', line: 'line' })[String(op.shape || 'rect').toLowerCase()];
  if (!shape) throw new Error('set_cell_shape: shape must be rect / ellipse / line');
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  ensureCellObjPadding(doc, op.table, op.row, op.col); // 좌우 셀 안여백(대칭)
  // 셀에 무난히 들어가는 작은 기본(20×12mm); 정확한 크기는 호출자가 지정. 그 뒤 fitToCell
  // 로 content 너비에 클램프(넘으면 비율 유지하며 줄여 잘림 방지). HWP 정합 필요.
  let w = op.width_mm != null ? toHu(op.width_mm) : toHu(20);
  let h = op.height_mm != null ? toHu(op.height_mm) : toHu(12);
  [w, h] = fitToCell(doc, op.table, op.row, op.col, w, h);
  const fill = op.fill_color ? normHex(op.fill_color) : '#FFFFFF';
  const line = op.line_color ? normHex(op.line_color) : '#000000';
  const lw = op.line_width_mm != null ? toHu(op.line_width_mm) : 33;
  let shapeXml = buildShape(shape, w, h, fill, line, lw, 'IN_FRONT_OF_TEXT', 0, 0, 0).replace(/treatAsChar="[^"]*"/, 'treatAsChar="1"');
  shapeXml = withCellMargin(shapeXml, CELL_OBJ_MARGIN); // 상하 여백
  placeObjectInCell(doc, op.table, op.row, op.col, shapeXml, 'set_cell_shape');
  opSetCellAlign(doc, op.table, op.row, op.col, 'CENTER', 'CENTER'); // 셀 안에서 가운데
  return { table: op.table, row: op.row, col: op.col, shape, inCell: true };
}

// Usable page text width (HWPUNIT) = page width − left/right margins. Caps how
// far a chart column may grow. Falls back to ~170mm (A4 portrait text width).
function pageTextWidth(doc, section) {
  try {
    const xml = doc.read(section);
    const pp = (xml.match(/<hp:pagePr\b[^>]*>/) || [''])[0];
    const W = Number((pp.match(/\bwidth="(\d+)"/) || [, 59528])[1]);
    const mg = (xml.match(/<hp:margin\b[^>]*\/?>/) || [''])[0];
    const L = Number((mg.match(/\bleft="(\d+)"/) || [, 8504])[1]);
    const R = Number((mg.match(/\bright="(\d+)"/) || [, 8504])[1]);
    return Math.max(10000, W - L - R);
  } catch { return 48188; }
}

// For chart/equation cells: these objects are sized by Hancom itself (a chart
// from its data, an equation from its script), so they CANNOT be shrunk to fit
// a narrow cell — they just clip (chart axes/legend collapse; a long formula is
// cut off). Instead of shrinking we WIDEN the object's column until it fits the
// target width — capped to the page text width. Sets the target column's
// <hp:cellSz width> in every row + grows the table <hp:sz>; leaves other columns
// untouched. Merged-cell tables are approximate (same caveat as set_table_size).
function widenColumnForObject(doc, tableIndex, row, col, chartW, margin) {
  const { section, el } = getTable(doc, tableIndex);
  const rows = scanTopLevel(el.inner, 'hp:tr');
  if (!rows.length) return;
  const colWidthIn = (tr) => {
    const tc = scanTopLevel(tr.inner, 'hp:tc')[col];
    return tc ? Number((tc.inner.match(/<hp:cellSz width="(\d+)"/) || [, 0])[1]) : 0;
  };
  const oldColW = colWidthIn(rows[row]) || colWidthIn(rows[0]);
  if (!(oldColW > 0)) return; // garbage cellSz → let fitToCell handle it
  const neededCol = chartW + 2 * margin;
  if (oldColW >= neededCol) return; // already wide enough
  const tableW = scanTopLevel(rows[0].inner, 'hp:tc')
    .reduce((a, tc) => a + Number((tc.inner.match(/<hp:cellSz width="(\d+)"/) || [, 0])[1]), 0);
  const room = Math.max(0, pageTextWidth(doc, section) - tableW);
  const allowedColW = Math.min(neededCol, oldColW + room);
  if (allowedColW <= oldColW) return; // no page room → chart will clamp to current cell
  let inner = el.inner;
  for (let ri = rows.length - 1; ri >= 0; ri--) { // bottom-up so splice offsets stay valid
    const tr = scanTopLevel(inner, 'hp:tr')[ri];
    const tcs = scanTopLevel(tr.inner, 'hp:tc');
    if (col < 0 || col >= tcs.length) continue;
    const tc = tcs[col];
    const newTc = `<hp:tc${tc.attrs}>${tc.inner.replace(/<hp:cellSz width="\d+"/, `<hp:cellSz width="${allowedColW}"`)}</hp:tc>`;
    inner = spliceEl(inner, tr, `<hp:tr${tr.attrs}>${spliceEl(tr.inner, tc, newTc)}</hp:tr>`);
  }
  const newTableW = tableW - oldColW + allowedColW;
  inner = inner.replace(/<hp:sz\b[^>]*\/>/, (m) =>
    m.replace(/width="[^"]*"/, `width="${newTableW}"`).replace(/widthRelTo="[^"]*"/, 'widthRelTo="ABSOLUTE"'));
  doc.write(section, spliceEl(doc.read(section), el, `<hp:tbl${el.attrs}>${inner}</hp:tbl>`));
}

// 차트를 표 셀 안에 (inline). chart_type/cat/series + width_mm/height_mm.
// 차트는 좁은 셀에서 깨지므로(축·범례 뭉개짐) 줄이는 대신 그 열을 차트가 읽힐 만큼 자동
// 확장(페이지 폭 상한). 그 다음 좌우 cellMargin·상하 outMargin·가운데정렬은 셀 객체 공통.
// 기본 크기 45×28mm. ⚠️ HWP 트랙 정합 필요 — 메모리 hwpx-cell-object-sizing-align-hwp.
function opSetCellChart(doc, op) {
  ensureCellObjPadding(doc, op.table, op.row, op.col); // 좌우 셀 안여백(대칭)
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  let w = op.width_mm != null ? toHu(op.width_mm) : toHu(45);
  let h = op.height_mm != null ? toHu(op.height_mm) : toHu(28);
  widenColumnForObject(doc, op.table, op.row, op.col, w, CELL_OBJ_MARGIN); // 좁으면 열 넓힘
  [w, h] = fitToCell(doc, op.table, op.row, op.col, w, h);                  // 상한 걸렸을 때만 축소
  let chartXml = buildChartObject(doc, op, w, h);
  chartXml = withCellMargin(chartXml, CELL_OBJ_MARGIN); // 상하 여백
  placeObjectInCell(doc, op.table, op.row, op.col, chartXml, 'set_cell_chart');
  opSetCellAlign(doc, op.table, op.row, op.col, 'CENTER', 'CENTER'); // 셀 안에서 가운데
  return { table: op.table, row: op.row, col: op.col, chart: true, width: w, height: h };
}

// 수식을 표 셀 안에 (inline). script(수식 문법) + optional width_mm/height_mm.
// 한컴이 <hp:sz>를 script로 재계산하므로 셀이 좁으면 식이 잘림 → 차트와 동일하게 그 열을
// 넉넉히 넓힌다(기본 목표폭 55mm, width_mm로 override, 페이지 폭 상한). sz는 클램프하지 않고
// 한컴이 자연 크기로 그리게 둔다. 상하 여백 + 가운데정렬은 셀 객체 공통.
function opSetCellEquation(doc, op) {
  if (op.script == null || !String(op.script).trim()) throw new Error('set_cell_equation: script is required');
  ensureCellObjPadding(doc, op.table, op.row, op.col); // 좌우 셀 안여백(대칭)
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  const eqColW = op.width_mm != null ? toHu(op.width_mm) : toHu(55); // 수식이 들어갈 목표 폭
  widenColumnForObject(doc, op.table, op.row, op.col, eqColW, CELL_OBJ_MARGIN);
  const w = op.width_mm != null ? toHu(op.width_mm) : 9200; // sz는 힌트(한컴이 script로 재계산)
  const h = op.height_mm != null ? toHu(op.height_mm) : 2588;
  let eqXml = buildEquationXml(String(op.script), w, h);
  eqXml = withCellMargin(eqXml, CELL_OBJ_MARGIN); // 상하 여백 (수식 기본 outMargin 대체)
  placeObjectInCell(doc, op.table, op.row, op.col, eqXml, 'set_cell_equation');
  opSetCellAlign(doc, op.table, op.row, op.col, 'CENTER', 'CENTER'); // 셀 안에서 가운데
  return { table: op.table, row: op.row, col: op.col, equation: true, script: String(op.script) };
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
        .replace(/\binstid="\d+"/, `instid="${freshId()}"`)
        // Don't inherit the template pic's caption — a fresh image has none, and
        // Hancom Docs rejects a stray caption cloned onto a new pic.
        .replace(/<hp:caption\b[\s\S]*?<\/hp:caption>/, '');
      // Heal orgSz/imgDim=0 (rhwp/external pics ship 0 → Hancom renders nothing).
      // Natural size from the cloned pic's imgClip, else its curSz.
      const clip = pic.match(/<hp:imgClip\b[^>]*\bright="(\d+)"[^>]*\bbottom="(\d+)"/);
      const cur = pic.match(/<hp:curSz\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
      const natW = clip ? clip[1] : (cur && cur[1] !== '0' ? cur[1] : (width || 28350));
      const natH = clip ? clip[2] : (cur && cur[2] !== '0' ? cur[2] : (height || 28350));
      pic = pic
        .replace(/<hp:orgSz\s+width="0"\s+height="0"\s*\/>/, `<hp:orgSz width="${natW}" height="${natH}"/>`)
        .replace(/<hp:imgDim\s+dimwidth="0"\s+dimheight="0"\s*\/>/, `<hp:imgDim dimwidth="${natW}" dimheight="${natH}"/>`);
      // Honor the requested display size (the cloned source's curSz/sz would
      // otherwise win, ignoring the caller's width/height).
      if (width && height) {
        pic = pic
          .replace(/<hp:curSz\b[^>]*\/>/, `<hp:curSz width="${width}" height="${height}"/>`)
          .replace(/<hp:imgRect>[\s\S]*?<\/hp:imgRect>/, `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${width}" y="0"/><hc:pt2 x="${width}" y="${height}"/><hc:pt3 x="0" y="${height}"/></hp:imgRect>`)
          .replace(/(<hp:sz\b[^>]*\bwidth=")\d+("[^>]*\bheight=")\d+/, `$1${width}$2${height}`);
      }
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

function opSetHeaderFooter(doc, kind, text, applyPageType, align) {
  const tag = `hp:${kind}`;
  const apply = String(applyPageType || 'BOTH').toUpperCase();
  if (!VALID_APPLY.has(apply)) throw new Error(`set_${kind}: applyPageType must be one of BOTH/EVEN/ODD`);

  // Optional horizontal alignment (LEFT/CENTER/RIGHT). GT (2026-06-17, 한컴독스
  // round-trip): Hancom records header/footer alignment as the INNER paragraph's
  // paraPrIDRef pointing at a paraPr that carries <hh:align horizontal=...>
  // (머리말 center → CENTER paraPr, 꼬리말 right → RIGHT paraPr; it survives the
  // Hancom-web round-trip). We reuse/inject that exact clean native paraPr via the
  // same helper apply_paragraph_style uses. null align → leave the default
  // (paraPrIDRef 0). pprId may be null if header.xml/stub is missing → also default.
  let pprId = null;
  if (align != null && String(align).trim() !== '') {
    const al = String(align).toUpperCase();
    if (!ALIGN_VALUES.has(al)) throw new Error(`set_${kind}: align must be one of ${[...ALIGN_VALUES].join('/')}`);
    pprId = ensureCleanAlignParaPr(doc, al);
  }
  const innerRef = pprId != null ? pprId : '0';
  const resultAlign = pprId != null ? String(align).toUpperCase() : undefined;

  // Update first existing instance anywhere across sections.
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const els = scanTopLevel(xml, tag);
    if (!els.length) continue;
    const el = els[0];
    let newInner = setCellInner(el.inner, text); // header/footer share subList>p>run>t shape with cells
    // Retarget the inner paragraph's alignment when requested (first inner hp:p).
    if (pprId != null) newInner = newInner.replace(/(<hp:p\b[^>]*\bparaPrIDRef=")\d+(")/, `$1${pprId}$2`);
    let attrs = el.attrs;
    attrs = /applyPageType="[^"]*"/.test(attrs)
      ? attrs.replace(/applyPageType="[^"]*"/, `applyPageType="${apply}"`)
      : `${attrs} applyPageType="${apply}"`;
    const replacement = `<${tag}${attrs}>${newInner}</${tag}>`;
    doc.write(name, dropLinesegs(spliceEl(xml, el, replacement)));
    return { kind, applyPageType: apply, align: resultAlign, updated: true };
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
              `<hp:p id="0" paraPrIDRef="${innerRef}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
                `<hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run>` +
              `</hp:p>` +
            `</hp:subList>` +
          `</${tag}>` +
        `</hp:ctrl>` +
      `</hp:run>` +
    `</hp:p>`;
  const insertAt = paras[0].end;
  doc.write(firstSec, dropLinesegs(xml.slice(0, insertAt) + wrapper + xml.slice(insertAt)));
  return { kind, applyPageType: apply, align: resultAlign, inserted: true };
}

// Page number (쪽번호) — a header/footer whose paragraph holds an <hp:autoNum
// numType="PAGE"> control (Hancom fills the live number). Inserts a new
// header/footer; `align` (left/center/right) is best-effort: reuse a paraPr that
// already declares that horizontal align, else fall back to the default (left).
function opSetPageNumber(doc, where, align) {
  const kind = String(where || 'footer').toLowerCase() === 'header' ? 'header' : 'footer';
  const tag = `hp:${kind}`;
  const al = String(align || 'CENTER').toUpperCase();
  let pprId = '0';
  const headerName = doc.headerName();
  if (headerName && al !== 'LEFT') {
    const hit = scanTopLevel(doc.read(headerName), 'hh:paraPr').find((pp) => new RegExp(`<hh:align\\b[^>]*horizontal="${al}"`).test(pp.inner));
    if (hit) pprId = getAttr(hit.attrs, 'id');
  }
  const firstSec = doc.sectionNames()[0];
  if (!firstSec) throw new Error('set_page_number: no Contents/section*.xml found');
  let xml = doc.read(firstSec);
  const paras = scanTopLevel(xml, 'hp:p');
  if (!paras.length) throw new Error('set_page_number: no <hp:p> to anchor insertion');
  const autoNum = `<hp:ctrl><hp:autoNum num="1" numType="PAGE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl><hp:t/>`;
  const wrapper =
    `<hp:p id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:ctrl>` +
      `<${tag} id="0" applyPageType="BOTH"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${kind === 'footer' ? 'BOTTOM' : 'TOP'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
        `<hp:p id="0" paraPrIDRef="${pprId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${autoNum}</hp:run></hp:p>` +
      `</hp:subList></${tag}>` +
    `</hp:ctrl></hp:run></hp:p>`;
  const at = paras[0].end;
  doc.write(firstSec, dropLinesegs(xml.slice(0, at) + wrapper + xml.slice(at)));
  return { where: kind, align: al, paraPrId: pprId, inserted: true };
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
  // `index` optional → default to the last top-level paragraph (append at doc end)
  // instead of crashing on an undefined index.
  if (paragraphIndex == null) paragraphIndex = paras.length - 1;
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

// Insert a Hancom equation. The equation script (e.g.
// "x = {-b +- sqrt{b^2 -4ac}} over {2a}") goes verbatim in <hp:script>;
// Hancom renders the math from the script on open. The element structure
// mirrors exactly what Hancom Docs itself writes (verified by round-tripping a
// real equation through 한컴독스): an inline (treatAsChar) shape with
// font="HancomEQN", "Equation Version 60". The <hp:sz> is a render-size hint
// Hancom recomputes from the script. Placed as its own new paragraph after
// paragraph `index` (or appended to the last section when `index` is omitted).
// Build the inline <hp:equation> XML (treatAsChar) for an equation script.
// Shared by insert_equation and set_cell_equation. <hp:sz> is a render-size hint
// Hancom recomputes from the script on open. Defaults match Hancom's own insert.
function buildEquationXml(scriptText, width = 9200, height = 2588) {
  return `<hp:equation id="${freshId()}" zOrder="0" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" ` +
    `textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="71" ` +
    `textColor="#000000" baseUnit="1000" lineMode="CHAR" font="HancomEQN">` +
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" ` +
    `vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="56" right="56" top="0" bottom="0"/>` +
    `<hp:script>${xmlEscape(scriptText)}</hp:script></hp:equation>`;
}

function opInsertEquation(doc, script, index) {
  if (script == null || !String(script).trim()) throw new Error('insert_equation: script is required');
  const scriptText = String(script);
  const eq = buildEquationXml(scriptText);

  // Equation sits in its own fresh PLAIN paragraph (paraPrIDRef="0"). Hancom's
  // own insert does the same — it does NOT inherit the anchor paragraph's
  // paraPr, so an equation dropped next to a bullet/numbered item must not pick
  // up that list heading (otherwise the equation renders with a stray ▶ / "3.").
  const plainAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;

  if (index != null) {
    const paras = doc.paragraphs();
    if (index < 0 || index >= paras.length) throw new Error(`insert_equation: index ${index} out of range`);
    const { section, el } = paras[index];
    const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
    const newPara = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${eq}</hp:run></hp:p>`;
    const elFull = `<hp:p${el.attrs}>${el.inner}</hp:p>`;
    doc.write(section, spliceEl(doc.read(section), el, elFull + newPara));
    return { inserted: true, after: index, script: scriptText };
  }

  const names = doc.sectionNames();
  const last = names[names.length - 1];
  let xml = doc.read(last);
  const paras = scanTopLevel(xml, 'hp:p');
  const charPrId = paras.length ? (paras[paras.length - 1].inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1] : '0';
  const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${eq}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { inserted: true, appended: true, script: scriptText };
}

// Multi-column (단) layout. Each section's <hp:secPr> carries one
// <hp:colPr type="NEWSPAPER" colCount="N" sameSz="1" sameGap="G"/>; every plain
// hwpx ships with colCount="1". Setting colCount=N makes body text flow
// newspaper-style across N equal columns — verified by capture (the colCount
// attribute alone drives it; no <hp:colSz> children needed when sameSz="1").
// `count`=1 resets to single column. `gap_mm` is the inter-column gap.
function opSetColumns(doc, count, gapMm) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new Error('set_columns: count must be an integer >= 1');
  const gap = n > 1 ? (gapMm != null ? Math.round(Number(gapMm) * 283.46) : 1134) : 0; // mm -> HWPUNIT, default ~4mm
  let sectionsChanged = 0;
  for (const name of doc.sectionNames()) {
    const xml = doc.read(name);
    const m = xml.match(/<hp:colPr\b[^>]*\/>/);
    if (!m) continue;
    let colPr = m[0]
      .replace(/\bcolCount="\d+"/, `colCount="${n}"`)
      .replace(/\bsameSz="\d+"/, 'sameSz="1"');
    colPr = /\bsameGap="\d+"/.test(colPr)
      ? colPr.replace(/\bsameGap="\d+"/, `sameGap="${gap}"`)
      : colPr.replace(/\s*\/>$/, ` sameGap="${gap}"/>`);
    doc.write(name, xml.replace(m[0], colPr));
    sectionsChanged++;
  }
  if (!sectionsChanged) throw new Error('set_columns: no <hp:colPr> found (unexpected for a valid .hwpx)');
  return { count: n, gapHwpUnit: gap, sectionsChanged };
}

// Page setup (편집 용지) — paper size, orientation, margins. Each section's
// <hp:secPr> holds <hp:pagePr width="W" height="H"> (HWPUNIT; A4 portrait =
// 59528 x 84186) and <hp:margin top/bottom/left/right/header/footer/gutter>.
// Orientation follows width-vs-height (W>H = landscape); the pagePr `landscape`
// enum is a separate binding hint we leave alone. Applies to every section.
const PAGE_SIZES_MM = { a3: [297, 420], a4: [210, 297], a5: [148, 210], b4: [257, 364], b5: [176, 250], letter: [215.9, 279.4], legal: [215.9, 355.6] };
function opSetPageSetup(doc, opts) {
  opts = opts || {};
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  let sectionsChanged = 0;
  for (const name of doc.sectionNames()) {
    let xml = doc.read(name);
    const pm = xml.match(/<hp:pagePr\b[^>]*?>/);
    if (!pm) continue;
    let pagePr = pm[0];
    let w = Number((pagePr.match(/\bwidth="(\d+)"/) || [])[1] || 59528);
    let h = Number((pagePr.match(/\bheight="(\d+)"/) || [])[1] || 84186);
    const preset = opts.size && PAGE_SIZES_MM[String(opts.size).toLowerCase()];
    if (preset) { w = toHu(preset[0]); h = toHu(preset[1]); }
    if (opts.width_mm != null) w = toHu(opts.width_mm);
    if (opts.height_mm != null) h = toHu(opts.height_mm);
    if (opts.orientation) {
      const land = String(opts.orientation).toLowerCase() === 'landscape';
      if ((land && w < h) || (!land && w > h)) [w, h] = [h, w];
    }
    pagePr = pagePr.replace(/\bwidth="\d+"/, `width="${w}"`).replace(/\bheight="\d+"/, `height="${h}"`);
    xml = xml.replace(pm[0], pagePr);
    if (opts.margin_mm != null) {
      const g = toHu(opts.margin_mm);
      xml = xml.replace(/<hp:margin\b[^>]*?\/>/, (m) =>
        m.replace(/\bleft="\d+"/, `left="${g}"`).replace(/\bright="\d+"/, `right="${g}"`)
         .replace(/\btop="\d+"/, `top="${g}"`).replace(/\bbottom="\d+"/, `bottom="${g}"`));
    }
    doc.write(name, xml);
    sectionsChanged++;
  }
  if (!sectionsChanged) throw new Error('set_page_setup: no <hp:pagePr> found (unexpected for a valid .hwpx)');
  return { sectionsChanged };
}

// Insert a chart. Hancom renders a chart from its OOXML <c:chartSpace> part
// (Chart/chartN.xml) — the BinData OLE that Hancom Docs also writes is NOT
// needed for rendering (verified: a chart renders with the OLE removed). So we
// emit <hp:chart chartIDRef="Chart/chartN.xml"> + generate the chartSpace from
// {type, cat, series}. Standard families (column/bar/line/area) carry cat+val
// axes; pie is single-series with no axes.
// Full 0-19 type spec (Hancom's chart type list / chart-types.md). Each entry
// drives the OOXML chart-type element + grouping + axes. Verified families:
// barChart/bar3DChart (col|bar, clustered|stacked), lineChart, areaChart/
// area3DChart, pieChart/pie3DChart/doughnutChart, scatterChart, radarChart.
const CHART_TYPES = {
  0:  { el: 'barChart', dir: 'col', grp: 'clustered' },
  1:  { el: 'barChart', dir: 'col', grp: 'stacked', overlap: 100 },
  2:  { el: 'lineChart', grp: 'standard', marker: true },
  3:  { el: 'barChart', dir: 'bar', grp: 'clustered' },
  4:  { el: 'barChart', dir: 'bar', grp: 'stacked', overlap: 100 },
  5:  { el: 'scatterChart', scatter: true },
  6:  { el: 'pieChart', pie: true },
  7:  { el: 'pieChart', pie: true, explode: true },
  8:  { el: 'doughnutChart', pie: true, hole: 50 },
  9:  { el: 'areaChart', grp: 'standard' },
  10: { el: 'areaChart', grp: 'stacked' },
  11: { el: 'radarChart', radar: true },
  12: { el: 'bar3DChart', dir: 'col', grp: 'clustered' },
  13: { el: 'bar3DChart', dir: 'col', grp: 'stacked', overlap: 100 },
  14: { el: 'bar3DChart', dir: 'bar', grp: 'clustered' },
  15: { el: 'bar3DChart', dir: 'bar', grp: 'stacked', overlap: 100 },
  16: { el: 'pie3DChart', pie: true },
  17: { el: 'pie3DChart', pie: true, explode: true },
  18: { el: 'area3DChart', grp: 'standard' },
  19: { el: 'area3DChart', grp: 'stacked' },
};
const CHART_ALIAS = { column: 0, col: 0, bar: 3, line: 2, area: 9, pie: 6, doughnut: 8, donut: 8, scatter: 5, radar: 11,
  column_stacked: 1, bar_stacked: 4, area_stacked: 10, pie3d: 16, bar3d: 12, column3d: 12 };
function chartSpec(t) {
  if (t == null) return CHART_TYPES[0];
  const key = typeof t === 'string' ? (CHART_ALIAS[t.toLowerCase()] ?? Number(t)) : Number(t);
  return CHART_TYPES[key] || CHART_TYPES[0];
}
function colLetter(i) { return String.fromCharCode(66 + i); } // 0->B
function strCachePts(vals) {
  return `<c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join('');
}
function numCachePts(vals) {
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join('');
}
// Chart series/point colour. GT (chart-theme-schemeclr.hwpx, 한컴독스 author):
// Hancom serialises a coloured series as <c:spPr><a:solidFill>…</a:solidFill></c:spPr>.
// Two colour forms are accepted:
//   - "accent1".."accent6" → <a:schemeClr> (follows Hancom's built-in chart theme
//     palette — the .hwpx carries no embedded OOXML theme, so accentN resolves to
//     Hancom's default accents, NOT the document theme).
//   - "#RRGGBB" / "RRGGBB" → <a:srgbClr> (literal colour — use this to MATCH the
//     document theme, e.g. corporate navy #304D68).
// No colour → empty <c:spPr/> (unchanged: Hancom auto-assigns its default palette).
function chartColorFill(color) {
  if (color == null) return null;
  const c = String(color).trim();
  if (/^accent[1-6]$/i.test(c)) return `<a:solidFill><a:schemeClr val="${c.toLowerCase()}"/></a:solidFill>`;
  const hex = c.replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
  return null; // unknown token → ignore, keep default palette
}
// `stroke` series (line/radar) carry colour in <a:ln> (GT chart-line-stroke-
// schemeclr.hwpx), not a bare fill; fill series (bar/area/pie) use bare solidFill.
function serSpPr(color, stroke) {
  const f = chartColorFill(color);
  if (!f) return '<c:spPr/>';
  return stroke
    ? `<c:spPr><a:ln w="28575" cap="flat" cmpd="sng" algn="ctr">${f}<a:prstDash val="solid"/><a:round/></a:ln></c:spPr>`
    : `<c:spPr>${f}</c:spPr>`;
}
// Per-point (per-bar / per-slice) colour overrides via <c:dPt>. Used for pie
// slices and for single-series bar/column charts that want each bar its own colour.
// `pie` → fuller dPt body (invertIfNegative/explosion) per GT chart-pie-dPt-schemeclr.
function dPtXml(pointColors, pie) {
  if (!Array.isArray(pointColors) || !pointColors.length) return '';
  return pointColors.map((col, i) => {
    const f = chartColorFill(col);
    if (!f) return '';
    const mid = pie
      ? '<c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:explosion val="0"/>'
      : '<c:bubble3D val="0"/>';
    return `<c:dPt><c:idx val="${i}"/>${mid}<c:spPr>${f}</c:spPr></c:dPt>`;
  }).join('');
}
// Standard series (cat + val): bar / line / area / radar / pie / doughnut.
// `color` = whole-series colour (fill, or line stroke when `stroke`); `pointColors`
// = per-point overrides (pie slices / per-bar). All optional — omitted → Hancom
// default palette (back-compat). `pie` selects the pie-flavoured dPt body.
function stdSer(idx, name, cat, values, explode, color, pointColors, stroke, pie) {
  const cl = colLetter(idx);
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>`
    + `<c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `${serSpPr(color, stroke)}<c:invertIfNegative val="0"/>`
    + (explode ? `<c:explosion val="25"/>` : '')
    + dPtXml(pointColors, pie)
    + `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${cat.length + 1}</c:f><c:strCache>${strCachePts(cat)}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${values.length + 1}</c:f><c:numCache>${numCachePts(values)}</c:numCache></c:numRef></c:val>`
    + `</c:ser>`;
}
// Scatter series: xVal + yVal (numeric X shared from `cat`).
function scatterSer(idx, name, xvals, yvals) {
  const cl = colLetter(idx);
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>`
    + `<c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `<c:spPr><a:ln w="28575"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/></c:marker>`
    + `<c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$${xvals.length + 1}</c:f><c:numCache>${numCachePts(xvals)}</c:numCache></c:numRef></c:xVal>`
    + `<c:yVal><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${yvals.length + 1}</c:f><c:numCache>${numCachePts(yvals)}</c:numCache></c:numRef></c:yVal>`
    + `</c:ser>`;
}
function catAxXml(id, pos, cross) {
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
}
function valAxXml(id, pos, cross) {
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
}
// Build an OOXML chartSpace for any of the 20 type specs (see CHART_TYPES).
function buildChartSpace(spec, cat, series) {
  const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
  const ax1 = '111111111', ax2 = '222222222';
  let plot;
  if (spec.scatter) {
    // X values: use numeric categories where given, else a 1-based index. Sized
    // to the longest series so xVal/yVal counts match (non-numeric labels like
    // "A"/"B" would otherwise all collapse to x=0, stacking every point).
    const n = Math.max(0, ...series.map((s) => (s.values || []).length));
    const xs = Array.from({ length: n }, (_, i) => {
      const c = cat && cat[i];
      const v = Number(c);
      return (c !== undefined && c !== '' && Number.isFinite(v)) ? v : i + 1;
    });
    const sers = series.map((s, i) => scatterSer(i, s.name, xs, s.values)).join('');
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}<c:axId val="${ax1}"/><c:axId val="${ax2}"/></c:scatterChart>`
      + valAxXml(ax1, 'b', ax2) + valAxXml(ax2, 'l', ax1);
  } else if (spec.pie) {
    const s0 = series[0];
    plot = `<c:${spec.el}><c:varyColors val="1"/>${stdSer(0, s0.name, cat, s0.values, spec.explode, s0.color, s0.pointColors, false, true)}<c:firstSliceAng val="0"/>`
      + (spec.hole != null ? `<c:holeSize val="${spec.hole}"/>` : '') + `</c:${spec.el}>`;
  } else {
    // line/radar render a stroke, not a fill — colour goes inside <a:ln>.
    const stroke = spec.el === 'lineChart' || spec.el === 'radarChart' || !!spec.radar;
    const sers = series.map((s, i) => stdSer(i, s.name, cat, s.values, false, s.color, s.pointColors, stroke, false)).join('');
    const horiz = spec.dir === 'bar';
    let inner = '';
    if (spec.dir) inner += `<c:barDir val="${spec.dir}"/>`;
    if (spec.grp) inner += `<c:grouping val="${spec.grp}"/>`;
    if (spec.radar) inner += `<c:radarStyle val="standard"/>`;
    inner += `<c:varyColors val="0"/>${sers}`;
    if (spec.marker) inner += `<c:marker val="1"/>`;
    if (spec.el.indexOf('bar') === 0) inner += `<c:gapWidth val="150"/><c:overlap val="${spec.overlap != null ? spec.overlap : 0}"/>`;
    inner += `<c:axId val="${ax1}"/><c:axId val="${ax2}"/>`;
    plot = `<c:${spec.el}>${inner}</c:${spec.el}>` + catAxXml(ax1, horiz ? 'l' : 'b', ax2) + valAxXml(ax2, horiz ? 'b' : 'l', ax1);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>`
    + `<c:chartSpace ${NS}><c:date1904 val="0"/><c:roundedCorners val="0"/>`
    + `<c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>`
    + `<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>`
    + `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
// Object wrap (배치): how text flows around a floating object.
const OBJ_WRAP = { inline: 'INLINE', square: 'SQUARE', 어울림: 'SQUARE', topbottom: 'TOP_AND_BOTTOM', 자리차지: 'TOP_AND_BOTTOM', front: 'IN_FRONT_OF_TEXT', behind: 'BEHIND_TEXT' };
function wrapVal(w, def) { return OBJ_WRAP[String(w == null ? '' : w).toLowerCase()] || def; }
// Normalize a chart op's {chart_type, cat, series, colors} into {spec, cat, series}.
// Shared by insert_chart and set_cell_chart. Colour (optional):
//   - `colors`: array (or single `color`). For a pie/doughnut → per-slice colours;
//     for bar/line/area → per-series colours (cycled if fewer than series).
//   - `point_colors`: array → per-bar colours of the first series (any standard
//     chart) so a single-series column chart can be a theme gradient.
// Each colour is "#RRGGBB"/"RRGGBB" (literal, matches the document theme) or
// "accent1".."accent6" (Hancom's built-in chart accents). See chartColorFill.
function chartData(op) {
  const spec = chartSpec(op.chart_type);
  const cat = Array.isArray(op.cat) ? op.cat.map(String) : ['항목 1', '항목 2', '항목 3'];
  let series = Array.isArray(op.series) && op.series.length ? op.series : [{ name: '계열 1', values: cat.map(() => 0) }];
  series = series.map((s, i) => ({ name: s.name != null ? String(s.name) : `계열 ${i + 1}`, values: Array.isArray(s.values) ? s.values : [] }));
  if (spec.pie) series = [series[0]];
  const colors = Array.isArray(op.colors) ? op.colors.map(String)
    : (op.color != null ? [String(op.color)] : null);
  const pointColors = Array.isArray(op.point_colors) ? op.point_colors.map(String) : null;
  if (spec.pie) {
    // Pie is inherently one colour per slice → colors (or point_colors) map to slices.
    const slice = colors || pointColors;
    if (slice) series[0].pointColors = slice;
  } else {
    if (colors) series.forEach((s, i) => { s.color = colors[i % colors.length]; });
    if (pointColors && series[0]) series[0].pointColors = pointColors;
  }
  return { spec, cat, series };
}

// Create a Chart/chartN.xml chartSpace part (+ manifest entry) and return its
// part name. Shared by insert_chart and set_cell_chart.
function embedChartSpace(doc, spec, cat, series) {
  let n = 1;
  while (doc.files[`Chart/chart${n}.xml`]) n++;
  const partName = `Chart/chart${n}.xml`;
  doc.files[partName] = strToU8(buildChartSpace(spec, cat, series));
  const hpf = doc.hpfName();
  if (hpf) {
    let s = doc.read(hpf);
    if (!s.includes(`href="${partName}"`)) {
      s = s.replace(/<\/opf:manifest>/, `<opf:item id="chart${n}" href="${partName}" media-type="application/xml"/></opf:manifest>`);
      doc.write(hpf, s);
    }
  }
  return partName;
}

// Build an inline (treatAsChar) <hp:chart> for a cell, w/h HWPUNIT. Reuses the
// chart part/manifest pipeline; outMargin set later by the caller.
function buildChartObject(doc, op, width, height) {
  const { spec, cat, series } = chartData(op);
  const partName = embedChartSpace(doc, spec, cat, series);
  return `<hp:chart id="${freshId()}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" chartIDRef="${partName}">`
    + `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:chart>`;
}

function opInsertChart(doc, op) {
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  const cw = op.width_mm != null ? toHu(op.width_mm) : 32250;
  const ch = op.height_mm != null ? toHu(op.height_mm) : 18750;
  // Default INLINE (글자처럼): chart sits on its own line where inserted — text
  // flows above/below, never squeezed into a narrow column beside a floating
  // chart (the SQUARE/어울림 default mangled report sections), and the chart
  // can't drift onto a later page. Override via `wrap` (square/topbottom/front/
  // behind) when a floating layout is wanted.
  const wrap = wrapVal(op.wrap, 'INLINE');
  // Outer margin (바깥 여백) so surrounding text isn't crowded/covered by the
  // chart. Default ~2.5mm all round; override with margin_mm. + optional x/y.
  const cmargin = op.margin_mm != null ? toHu(op.margin_mm) : 709;
  const cx = op.x_mm != null ? toHu(op.x_mm) : 0;
  const cy = op.y_mm != null ? toHu(op.y_mm) : 0;
  const { spec, cat, series } = chartData(op);
  const partName = embedChartSpace(doc, spec, cat, series);
  // INLINE wrap means the chart is a character in the text flow (treatAsChar=1),
  // so it stays right where it's inserted instead of floating to wherever it fits
  // (the cause of charts drifting onto a later page). Other wraps stay floating.
  const inlineChar = wrap === 'INLINE';
  const chart = `<hp:chart id="${freshId()}" zOrder="0" numberingType="PICTURE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" chartIDRef="${partName}">`
    + `<hp:sz width="${cw}" widthRelTo="ABSOLUTE" height="${ch}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="${inlineChar ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="${inlineChar ? 'PARA' : 'COLUMN'}" vertAlign="TOP" horzAlign="LEFT" vertOffset="${cy}" horzOffset="${cx}"/>`
    + `<hp:outMargin left="${cmargin}" right="${cmargin}" top="${cmargin}" bottom="${cmargin}"/></hp:chart>`;
  const plainAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;
  // Place after paragraph `index` (so a chart lands next to its reference text),
  // or append to the end when index is omitted / out of range.
  const paras = doc.paragraphs();
  const idx = Number.isInteger(op.index) ? op.index : null;
  if (idx != null && idx >= 0 && idx < paras.length) {
    const { section, el } = paras[idx];
    const charPrId = (el.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
    const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${chart}</hp:run></hp:p>`;
    const sxml = doc.read(section);
    doc.write(section, sxml.slice(0, el.end) + para + sxml.slice(el.end));
    return { inserted: true, part: partName, chartEl: spec.el, series: series.length, cats: cat.length, afterIndex: idx };
  }
  const last = doc.sectionNames().slice(-1)[0];
  let xml = doc.read(last);
  const charPrId = (scanTopLevel(xml, 'hp:p').slice(-1)[0]?.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${chart}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { inserted: true, part: partName, chartEl: spec.el, series: series.length, cats: cat.length, appended: true };
}

// Insert a drawing shape (도형): rectangle / ellipse / line. Structure mirrors
// what Hancom Docs writes (verified by round-trip): a floating shape with
// renderingInfo matrices, lineShape (border) + fillBrush (rect/ellipse) and the
// shape-specific geometry (rect = pt0..pt3, ellipse = center/ax, line =
// startPt/endPt). Placed floating relative to its paragraph (PARA/COLUMN).
function buildShape(shape, w, h, fillColor, lineColor, lineWidth, wrap, x, y, margin) {
  const id = freshId(), inst = freshId();
  const lw = lineWidth || 33;
  const tw = wrap || 'IN_FRONT_OF_TEXT';
  const hx = Math.round(Number(x) || 0), vy = Math.round(Number(y) || 0);
  const om = margin != null ? Math.round(Number(margin)) : 0;
  const hw = Math.round(w / 2), hh = Math.round(h / 2);
  const common = `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="0" height="0"/>`
    + `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>`
    + `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    + `<hp:lineShape color="${lineColor}" width="${lw}" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>`;
  const fill = `<hc:fillBrush><hc:winBrush faceColor="${fillColor}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`;
  const shadow = `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`;
  // INLINE wrap → treat the shape as a character (sits in the text line / its own
  // paragraph) instead of floating. Otherwise text overlaps it (the bug where an
  // inline-requested shape still floated left and the next text wrapped over it).
  const tac = tw === 'INLINE' ? '1' : '0';
  const tail = `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="${tac}" affectLSpacing="0" flowWithText="${tac === '1' ? '1' : '0'}" allowOverlap="${tac === '1' ? '0' : '1'}" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="${tac === '1' ? 'PARA' : 'COLUMN'}" vertAlign="TOP" horzAlign="LEFT" vertOffset="${vy}" horzOffset="${hx}"/>`
    + `<hp:outMargin left="${om}" right="${om}" top="${om}" bottom="${om}"/>`;
  const open = (extra) => `<hp:${shape} id="${id}" zOrder="0" numberingType="PICTURE" textWrap="${tw}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${inst}"${extra}>`;
  if (shape === 'line') {
    return open(' isReverseHV="0"') + common + shadow
      + `<hc:startPt x="0" y="0"/><hc:endPt x="${w}" y="${h}"/>` + tail + `<hp:shapeComment>선</hp:shapeComment></hp:line>`;
  }
  if (shape === 'ellipse') {
    return open(' intervalDirty="0" hasArcPr="0" arcType="NORMAL"') + common + fill + shadow
      + `<hc:center x="${hw}" y="${hh}"/><hc:ax1 x="${w}" y="${hh}"/><hc:ax2 x="${hw}" y="0"/><hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/><hc:start2 x="0" y="0"/><hc:end2 x="0" y="0"/>`
      + tail + `<hp:shapeComment>타원</hp:shapeComment></hp:ellipse>`;
  }
  return open(' ratio="0"') + common + fill + shadow
    + `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/>`
    + tail + `<hp:shapeComment>사각형</hp:shapeComment></hp:rect>`;
}
function opInsertShape(doc, op) {
  const shape = ({ rect: 'rect', rectangle: 'rect', box: 'rect', ellipse: 'ellipse', oval: 'ellipse', circle: 'ellipse', line: 'line' })[String(op.shape || 'rect').toLowerCase()];
  if (!shape) throw new Error('insert_shape: shape must be rect / ellipse / line');
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  const w = op.width_mm != null ? toHu(op.width_mm) : 15000;
  const h = op.height_mm != null ? toHu(op.height_mm) : 6750;
  const fill = op.fill_color ? normHex(op.fill_color) : '#FFFFFF';
  const line = op.line_color ? normHex(op.line_color) : '#000000';
  const lw = op.line_width_mm != null ? Math.round(Number(op.line_width_mm) * 283.46) : undefined;
  const mm = (v) => Number(v) * 283.46;
  const el = buildShape(shape, w, h, fill, line, lw, wrapVal(op.wrap),
    op.x_mm != null ? mm(op.x_mm) : 0, op.y_mm != null ? mm(op.y_mm) : 0, op.margin_mm != null ? mm(op.margin_mm) : 0);
  const plainAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;
  const index = op.index;
  if (index != null) {
    const paras = doc.paragraphs();
    if (index < 0 || index >= paras.length) throw new Error(`insert_shape: index ${index} out of range`);
    const { section, el: pel } = paras[index];
    const charPrId = (pel.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
    const newPara = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${el}</hp:run></hp:p>`;
    const elFull = `<hp:p${pel.attrs}>${pel.inner}</hp:p>`;
    doc.write(section, spliceEl(doc.read(section), pel, elFull + newPara));
    return { inserted: true, shape, after: index };
  }
  const last = doc.sectionNames().slice(-1)[0];
  let xml = doc.read(last);
  const charPrId = (scanTopLevel(xml, 'hp:p').slice(-1)[0]?.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${el}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { inserted: true, shape, appended: true };
}

// Insert a text box (글상자) — a rect shape carrying an <hp:drawText> with the
// text (one paragraph). Same floating placement as insert_shape; drawText sits
// between the shape's <hp:shadow> and <hc:pt0> (the order Hancom writes).
function opInsertTextbox(doc, op) {
  const text = String(op.text != null ? op.text : '');
  const toHu = (mm) => Math.round(Number(mm) * 283.46);
  const w = op.width_mm != null ? toHu(op.width_mm) : 30000;
  const h = op.height_mm != null ? toHu(op.height_mm) : 10000;
  const fill = op.fill_color ? normHex(op.fill_color) : '#FFFFFF';
  const line = op.line_color ? normHex(op.line_color) : '#000000';
  const drawText = `<hp:drawText lastWidth="4294967295" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${xmlEscape(text)}</hp:t></hp:run></hp:p></hp:subList></hp:drawText>`;
  const lw = op.line_width_mm != null ? Math.round(Number(op.line_width_mm) * 283.46) : undefined;
  const mm = (v) => Number(v) * 283.46;
  const el = buildShape('rect', w, h, fill, line, lw, wrapVal(op.wrap, 'SQUARE'),
    op.x_mm != null ? mm(op.x_mm) : 0, op.y_mm != null ? mm(op.y_mm) : 0, op.margin_mm != null ? mm(op.margin_mm) : 567)
    .replace('<hc:pt0 x="0" y="0"/>', drawText + '<hc:pt0 x="0" y="0"/>')
    .replace('<hp:shapeComment>사각형</hp:shapeComment>', '<hp:shapeComment>글상자</hp:shapeComment>');
  const plainAttrs = ` id="${freshId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"`;
  if (op.index != null) {
    const paras = doc.paragraphs();
    if (op.index < 0 || op.index >= paras.length) throw new Error(`insert_textbox: index ${op.index} out of range`);
    const { section, el: pel } = paras[op.index];
    const charPrId = (pel.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
    const newPara = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${el}</hp:run></hp:p>`;
    doc.write(section, spliceEl(doc.read(section), pel, `<hp:p${pel.attrs}>${pel.inner}</hp:p>` + newPara));
    return { inserted: true, textbox: true, after: op.index };
  }
  const last = doc.sectionNames().slice(-1)[0];
  let xml = doc.read(last);
  const charPrId = (scanTopLevel(xml, 'hp:p').slice(-1)[0]?.inner.match(/charPrIDRef="(\d+)"/) || [, '0'])[1];
  const para = `<hp:p${plainAttrs}><hp:run charPrIDRef="${charPrId}">${el}</hp:run></hp:p>`;
  xml = /<\/hs:sec>\s*$/.test(xml) ? xml.replace(/<\/hs:sec>\s*$/, para + '</hs:sec>') : xml + para;
  doc.write(last, xml);
  return { inserted: true, textbox: true, appended: true };
}

function applyOp(doc, op) {
  switch (op.type) {
    case 'replace_text': return opReplaceText(doc, op.find, op.replace);
    case 'fill_template': return opFillTemplate(doc, op.values);
    case 'set_paragraph_text': return opSetParagraphText(doc, op.index, op.text);
    case 'append_paragraph': return opAppendParagraph(doc, op.text);
    case 'delete_paragraph': return opDeleteParagraph(doc, op.index);
    case 'set_cell_text': return opSetCellText(doc, op.table, op.row, op.col, op.text, op.fit);
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
    case 'set_cell_margin': return opSetCellMargin(doc, op.table, op.row, op.col, op);
    case 'set_table_margin': return opSetTableMargin(doc, op.table, op);
    case 'set_table_inner_margin': return opSetTableInnerMargin(doc, op.table, op);
    case 'set_table_size': return opSetTableSize(doc, op.table, op.width_mm, op.height_mm);
    case 'set_table_props': return opSetTableProps(doc, op.table, op);
    case 'set_title_cell': return opSetTitleCell(doc, op.table, op.row, op.col, op.on);
    case 'set_table_split_border': return opSetTableSplitBorder(doc, op.table, op);
    case 'set_page_break': return opSetPageBreak(doc, op.index, op.on);
    case 'set_bullet_list': return opSetParagraphList(doc, op.index, 'BULLET', op.level, { char: op.char });
    case 'set_number_list': return opSetParagraphList(doc, op.index, 'NUMBER', op.level, { style: op.style });
    case 'clear_list': return opSetParagraphList(doc, op.index, 'NONE', 0);
    case 'apply_text_style': return opApplyTextStyle(doc, op.target, op);
    case 'apply_paragraph_style': return opApplyParagraphStyle(doc, op.index, op);
    case 'insert_image': return opInsertImage(doc, op.source, op.ext,
      op.width_mm != null ? Math.round(Number(op.width_mm) * 283.46) : op.width,
      op.height_mm != null ? Math.round(Number(op.height_mm) * 283.46) : op.height,
      op.index);
    case 'replace_image': return opReplaceImage(doc, op.target, op.source);
    case 'delete_image': return opDeleteImage(doc, op.target);
    case 'delete_object': return opDeleteObject(doc, op.target, op.index, op.renumber);
    case 'place_seal': return opPlaceSeal(doc, op);
    case 'set_field_value': return opSetFieldValue(doc, op.name, op.value);
    case 'set_header': return opSetHeaderFooter(doc, 'header', op.text, op.applyPageType, op.align);
    case 'set_footer': return opSetHeaderFooter(doc, 'footer', op.text, op.applyPageType, op.align);
    case 'remove_header': return opRemoveHeaderFooter(doc, 'header');
    case 'remove_footer': return opRemoveHeaderFooter(doc, 'footer');
    case 'insert_footnote': return opInsertNote(doc, 'footNote', op.index, op.text);
    case 'insert_endnote': return opInsertNote(doc, 'endNote', op.index, op.text);
    case 'insert_hyperlink': return opInsertHyperlink(doc, op.index, op.url, op.text);
    case 'insert_bookmark': return opInsertBookmark(doc, op.index, op.name);
    case 'insert_equation': return opInsertEquation(doc, op.script, op.index);
    case 'set_columns': return opSetColumns(doc, op.count, op.gap_mm);
    case 'set_page_setup': return opSetPageSetup(doc, op);
    case 'insert_chart': return opInsertChart(doc, op);
    case 'insert_shape': return opInsertShape(doc, op);
    case 'set_object_size': return opSetObjectSize(doc, op.target, op.index, op.width_mm, op.height_mm);
    case 'set_object_position': return opSetObjectPosition(doc, op.target, op.index, op);
    case 'set_object_margin': return opSetObjectMargin(doc, op.target, op.index, op);
    case 'set_object_border': return opSetObjectBorder(doc, op.target, op.index, op);
    case 'set_object_fill': return opSetObjectFill(doc, op.target, op.index, op);
    case 'set_cell_image': return opSetCellImage(doc, op.table, op.row, op.col, op.source, op.ext,
      op.width_mm != null ? Math.round(Number(op.width_mm) * 283.46) : op.width,
      op.height_mm != null ? Math.round(Number(op.height_mm) * 283.46) : op.height);
    case 'set_cell_shape': return opSetCellShape(doc, op);
    case 'set_cell_chart': return opSetCellChart(doc, op);
    case 'set_cell_equation': return opSetCellEquation(doc, op);
    case 'set_column_break': return opSetColumnBreak(doc, op.index, op.on);
    case 'insert_table_row': return opInsertTableRow(doc, op.table, op.row, op.where, op.cells);
    case 'insert_table_column': return opInsertTableColumn(doc, op.table, op.col, op.where, op.cells);
    case 'distribute_table': return opDistributeTable(doc, op.table, op.mode);
    case 'insert_textbox': return opInsertTextbox(doc, op);
    case 'set_page_number': return opSetPageNumber(doc, op.where, op.align);
    case 'split_cell': return opSplitCell(doc, op.table, op.row, op.col, op.rows, op.cols);
    case 'set_caption': return opSetCaption(doc, op.target, op.index, op.text, op.side, op.gap_mm);
    case 'apply_style': return opApplyStyle(doc, op.index, op.style);
    case 'para_line': return opParaLine(doc, op.index, op);
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
