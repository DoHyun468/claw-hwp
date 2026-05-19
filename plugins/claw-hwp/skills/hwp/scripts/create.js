#!/usr/bin/env node
// create.js — Generate a new .hwp / .hwpx via the rhwp WASM editor.
//
// Protocol (stdin → stdout, single JSON line):
//   stdin   → { "path": "out.hwp" | "out.hwpx", "operations": [...] }
//   stdout  → { "status": "success", "path": "...", "ops_applied": N, "log": [...] }
//   on fail → { "status": "error",  "message": "...", "op_index": N, "log": [...] }
//
// Output format is driven by the path extension. .hwp = binary HWP 5.x via
// exportHwp(); .hwpx = OOXML-style HWP via exportHwpx().
//
// rhwp's WASM editor is rich (insertText, applyCharFormat, createTable,
// insertPicture, applyParaFormat, ...). This worker exposes a subset shaped
// like docx-js' append-style vocabulary so callers don't need to track
// (section, paragraph, char_offset) coordinates by hand.
//
// All third-party deps live under `vendor/` and are wired below — no
// `npm install` is required to run this script.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import {
  unzipSync,
  zipSync,
  strFromU8,
  strToU8,
} from "./vendor/fflate/index.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const requireCJS = createRequire(import.meta.url);
const CFB = requireCJS("./vendor/cfb/cfb.js");

// Tiny JSZip-shaped wrapper over fflate. The post-export patchers below
// were originally written against jszip; mimicking its surface keeps the
// porting diff minimal. Operations supported:
//   zip.file(name)               → { async: (kind) => Promise<string|Uint8Array> } | null
//   zip.file(name, content)      → set/replace entry (string | Uint8Array)
//   zip.files                    → { [name]: Uint8Array }
//   zip.generateAsync({type})    → Uint8Array | Buffer (mimetype STORE-first)
const JSZipShim = {
  async load(buf) {
    const raw = unzipSync(new Uint8Array(buf));
    const api = {
      files: raw,
      file(name, content) {
        if (content !== undefined) {
          raw[name] =
            typeof content === "string" ? strToU8(content) : new Uint8Array(content);
          return api;
        }
        const data = raw[name];
        if (data === undefined) return null;
        return {
          async: async (kind) =>
            kind === "uint8array" ? data : strFromU8(data),
        };
      },
      async generateAsync(opts = {}) {
        const ordered = {};
        if (raw.mimetype !== undefined) {
          ordered.mimetype = [raw.mimetype, { level: 0 }];
        }
        for (const name of Object.keys(raw)) {
          if (name === "mimetype") continue;
          ordered[name] = raw[name];
        }
        const level = opts.compressionOptions?.level ?? 6;
        const out = zipSync(ordered, { level });
        return opts.type === "nodebuffer" ? Buffer.from(out) : out;
      },
    };
    return api;
  },
};
const JSZip = { loadAsync: (buf) => JSZipShim.load(buf) };

// ── WASM bootstrap ────────────────────────────────────────────────────────
//
// rhwp ships a WebAssembly binary that targets browsers. Two Node-specific
// concerns (lifted from k-skill-rhwp's wasm-init.js):
//   1. The WASM imports a globalThis.measureTextWidth(font, text) callback
//      used for line-breaking layout. Browsers wire it to a <canvas> 2D
//      context; Node has no canvas. Install a deterministic stub that
//      treats CJK as full-width and Latin as half-width — accurate enough
//      for round-trip editing, do NOT rely on it for pixel-perfect render.
//   2. The default init() path expects fetch(import.meta.url-relative);
//      Node has no such fetch target. Resolve the binary by require.resolve
//      and pass its bytes to init explicitly.

if (typeof globalThis.measureTextWidth !== "function") {
  globalThis.measureTextWidth = (font, text) => {
    const m = String(font || "").match(/([0-9.]+)px/);
    const size = m ? parseFloat(m[1]) : 12;
    let w = 0;
    for (const ch of String(text || "")) {
      const cp = ch.codePointAt(0) ?? 0;
      // U+1100..U+FFDC roughly covers CJK + full-width Hangul ranges.
      w += cp >= 0x1100 && cp <= 0xffdc ? size : size * 0.55;
    }
    return w;
  };
}

let core;
try {
  core = await import("./vendor/rhwp/rhwp.js");
  const wasmPath = path.join(__dirname, "vendor", "rhwp", "rhwp_bg.wasm");
  await core.default({ module_or_path: fs.readFileSync(wasmPath) });
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      message:
        "rhwp WASM failed to init. The vendored rhwp/ subdir may be missing. " +
        `Underlying error: ${err.message}`,
    }) + "\n",
  );
  process.exit(1);
}

const { HwpDocument } = core;

// ── Cursor + state helpers ───────────────────────────────────────────────
//
// rhwp positions every mutation by (section_idx, para_idx, char_offset). To
// keep the op vocabulary "append-style", we maintain a cursor and update it
// after each successful op. cursor.firstParaUsed flips false once we write
// the very first paragraph so the second append doesn't insert a stray
// leading newline.

function makeCursor(doc) {
  const sec = Math.max(0, doc.getSectionCount() - 1);
  const paras = doc.getParagraphCount(sec);
  const para = Math.max(0, paras - 1);
  const charOffset =
    paras > 0 ? doc.getParagraphLength(sec, para) : 0;
  return { sec, para, charOffset, firstParaUsed: paras > 1 || charOffset > 0 };
}

function unwrap(jsonStr, opName) {
  // Most rhwp methods return a JSON string {ok: true/false, ...}. A few
  // return numeric IDs or void. Caller decides whether to call this.
  if (typeof jsonStr !== "string") return jsonStr;
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`${opName}: rhwp returned non-JSON: ${jsonStr.slice(0, 200)}`);
  }
  if (parsed && parsed.ok === false) {
    throw new Error(`${opName}: rhwp rejected — ${parsed.error || JSON.stringify(parsed)}`);
  }
  return parsed;
}

// ── Inline run parsing ────────────────────────────────────────────────────
//
// Accepts plain strings with **bold** / *italic* markers and converts them
// into a list of {text, bold?, italic?} segments. Mirrors create_docx.js
// behavior so the agent's mental model carries over. If the caller passes
// a list directly, it's used as-is.

function parseInlineRuns(input) {
  if (Array.isArray(input)) return input;
  const text = String(input ?? "");
  if (!text) return [{ text: "" }];
  const runs = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        runs.push({ text: text.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        runs.push({ text: text.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }
    // accumulate plain run until next marker
    let j = i;
    while (j < text.length && text[j] !== "*") j++;
    runs.push({ text: text.slice(i, j) });
    i = j;
  }
  return runs.filter((r) => r.text.length > 0);
}

// ── Op handlers ───────────────────────────────────────────────────────────

const log = [];

// Tracks images inserted by append_image so the .hwpx post-export patch can
// inject the matching <hp:pic> nodes into section0.xml. rhwp's hwpx serializer
// packs the binary into BinData/ + registers it in content.hpf manifest, but
// emits a paragraph with empty <hp:t/> in place of the picture run — Hancom
// then has nothing to draw against. We patch each tracked paragraph with a
// reference-shaped picture run after export.
const imagePatches = [];

// Tracks headings emitted by append_heading. rhwp's HWPX serializer correctly
// creates the <hh:charPr> definition (large height + bold) in header.xml but
// then writes the heading run with charPrIDRef="0" (default body), so the
// heading renders at body size. We post-fix section0.xml by looking up the
// matching charPr id (height + bold) in header.xml and rewriting the run
// reference. The binary HWP path is unaffected — its PARA_CHARSHAPE record
// already references the correct shape id.
const headingPatches = [];

function startNewParagraph(doc, cursor) {
  // First write goes into the existing empty paragraph; later writes split a
  // new paragraph at the current cursor position.
  //
  // CRITICAL: insertText("\n") does NOT split paragraphs in rhwp — it just
  // inserts a soft-break character into the current paragraph. The real
  // paragraph-creation primitive is splitParagraph(sec, para, char_offset),
  // which returns {ok, paraIdx, charOffset:0} pointing at the new empty
  // paragraph. Earlier versions of this worker used insertText("\n"), which
  // caused every op to prepend to the same paragraph in reverse order.
  if (!cursor.firstParaUsed) {
    cursor.firstParaUsed = true;
    return;
  }
  const result = unwrap(
    doc.splitParagraph(cursor.sec, cursor.para, cursor.charOffset),
    "splitParagraph",
  );
  cursor.para = typeof result.paraIdx === "number"
    ? result.paraIdx
    : doc.getParagraphCount(cursor.sec) - 1;
  cursor.charOffset = result.charOffset ?? 0;

  // splitParagraph copies the source paragraph's paraShape onto the new one.
  // If the previous paragraph had paragraph borders applied, wipe them on
  // the new (otherwise plain) paragraph so the ladder-of-horizontal-rules
  // bug doesn't appear.
  if (cursor.clearBordersOnNextSplit) {
    cursor.clearBordersOnNextSplit = false;
    try {
      doc.applyParaFormat(cursor.sec, cursor.para, JSON.stringify({
        borderTop: ZERO_BORDER,
        borderBottom: ZERO_BORDER,
        borderLeft: ZERO_BORDER,
        borderRight: ZERO_BORDER,
      }));
    } catch {
      // best-effort
    }
  }
}

function writeRunsAt(doc, cursor, runs, defaults = {}) {
  // ALWAYS apply char format to every run, even plain ones. Reason: rhwp's
  // splitParagraph carries the previous paragraph's last char format onto
  // the new paragraph's empty cursor, so a heading at 16pt makes the body
  // paragraph that follows inherit 16pt unless we explicitly reset it.
  // `defaults` carries per-op intent (e.g. heading wants {fontSize, bold, color});
  // per-run inline markers (**bold** / *italic*) override defaults.
  const baseFontSize = defaults.fontSize ?? 1000; // HWP units (1pt = 100)
  let off = cursor.charOffset;
  for (const run of runs) {
    if (!run.text) continue;
    unwrap(
      doc.insertText(cursor.sec, cursor.para, off, run.text),
      "insertText",
    );
    const props = {
      fontSize: run.fontSize ? Math.round(run.fontSize * 100) : baseFontSize,
      bold: run.bold || defaults.bold || false,
      italic: run.italic || defaults.italic || false,
    };
    if (run.underline) props.underline = true;
    const textColor = run.color || defaults.color;
    if (textColor) props.textColor = textColor;
    doc.applyCharFormat(
      cursor.sec,
      cursor.para,
      off,
      off + run.text.length,
      JSON.stringify(props),
    );
    off += run.text.length;
  }
  cursor.charOffset = off;
}

// ── Heading defaults — Korean gov-style gray gradient ────────────────────
//
// rhwp's blank2010 template renders headings indistinguishable from body text
// unless we explicitly override fontSize/bold/color/spacing. We don't use the
// 22 built-in styles (개요 1~10) because they carry auto-numbering AND indent
// margins that conflict with manually-numbered Korean reports. Defaults below
// are pure visual override applied at every append_heading call.
//
// Spacing units: HWP uses HWPUNIT (1/7200 inch). 1mm ≈ 283 HWPUNIT. Probed
// empirically — { spacingBefore: 1500 } shows ~5.3mm of space before in 한컴.
const HEADING_DEFAULTS = {
  // Natural HWP values. Earlier iterations pumped 4-5× to compensate for
  // viewer dampening, but that bloated page contents enough that tables
  // got pushed to next pages with empty bottom space. Frontend §5(k) #1+#3
  // fixes (single-<text> merge, scale removal) should make natural values
  // visible enough now. spacer paragraphs supplement vertical breathing.
  1: { fontSize: 18,   color: "#1A1A1A", spacingBefore: 1300, spacingAfter: 800 },
  2: { fontSize: 14,   color: "#2D2D2D", spacingBefore: 1000, spacingAfter: 600 },
  3: { fontSize: 12,   color: "#404040", spacingBefore: 800,  spacingAfter: 500 },
  4: { fontSize: 11,   color: "#595959", spacingBefore: 600,  spacingAfter: 400 },
  5: { fontSize: 10.5, color: "#595959", spacingBefore: 500,  spacingAfter: 350 },
  6: { fontSize: 10,   color: "#595959", spacingBefore: 450,  spacingAfter: 300 },
};

// Body line spacing 130% (rhwp default 160% is too airy). Heading 115% tighter.
const BODY_LINE_SPACING = 130;
const HEADING_LINE_SPACING = 115;
// Body paragraph trailing gap (natural HWP value).
const BODY_SPACING_AFTER = 600;

function applyParaProps(doc, cursor, opts = {}) {
  // Apply paragraph-level properties: alignment + line spacing + before/after.
  // CRITICAL: splitParagraph copies the previous paragraph's paraShape, so
  // every paragraph MUST set its own props or it inherits the prior shape.
  //
  // ALSO CRITICAL: paraShape includes the pageBreakBefore bit. If a previous
  // paragraph (e.g., a heading) set pageBreakBefore=true, every subsequent
  // paragraph that splits from it inherits the bit → page break before
  // every paragraph → blank-page explosion. Always reset pageBreakBefore
  // here unless the caller explicitly sets it true.
  const align = opts.align ? String(opts.align).toLowerCase() : "justify";
  const alignMap = {
    left: "left", center: "center", right: "right",
    justify: "justify", justified: "justify",
  };
  const props = {
    alignment: alignMap[align] || "justify",
    pageBreakBefore: opts.pageBreakBefore ?? false,
  };
  if (opts.lineSpacing != null) props.lineSpacing = opts.lineSpacing;
  if (opts.spacingBefore != null) props.spacingBefore = opts.spacingBefore;
  if (opts.spacingAfter != null) props.spacingAfter = opts.spacingAfter;
  unwrap(
    doc.applyParaFormat(cursor.sec, cursor.para, JSON.stringify(props)),
    "applyParaFormat(props)",
  );
}

const ZERO_BORDER = { type: 0, width: 0, color: "#000000" };

function applyParaBorders(doc, cursor, op) {
  // Paragraph-level top/bottom/left/right borders. Used to draw horizontal
  // rules above/below a title without using a table — matches the Korean
  // government 보고서 cover-page convention of double rules around the
  // 사업수행계획서 type-of-document line.
  //
  // border_top_pt / border_bottom_pt: width in points (visual line thickness).
  //   rhwp's borderTop/borderBottom width field is in 1/8 pt — 1pt → width:8.
  //   Multiplier here is *8 (so border_top_pt:1 → width:8).
  const props = {};
  const mk = (pt, color) => ({
    type: 1,
    width: Math.max(1, Math.round(pt * 8)),
    color: color || "#000000",
  });
  if (op.border_top_pt !== undefined) props.borderTop = mk(op.border_top_pt, op.border_color);
  if (op.border_bottom_pt !== undefined) props.borderBottom = mk(op.border_bottom_pt, op.border_color);
  if (op.border_left_pt !== undefined) props.borderLeft = mk(op.border_left_pt, op.border_color);
  if (op.border_right_pt !== undefined) props.borderRight = mk(op.border_right_pt, op.border_color);
  if (Object.keys(props).length === 0) return;
  // Always specify ALL four border sides — rhwp seems to fall back to a
  // default (visible) border for unspecified sides when ANY side is set,
  // producing a full rectangle when the caller asked for just top/bottom.
  // Force zero-width borders on sides the caller didn't request.
  for (const side of ["borderTop", "borderBottom", "borderLeft", "borderRight"]) {
    if (!(side in props)) props[side] = ZERO_BORDER;
  }
  unwrap(
    doc.applyParaFormat(cursor.sec, cursor.para, JSON.stringify(props)),
    "applyParaFormat(borders)",
  );
  // Mark cursor so the NEXT startNewParagraph wipes inherited borders. rhwp's
  // splitParagraph copies the source paragraph's paraShape (including borders)
  // onto the new paragraph, which would otherwise produce a ladder of
  // horizontal rules between every subsequent spacer.
  cursor.clearBordersOnNextSplit = true;
}

const HANDLERS = {
  setup_document(doc, op, cursor) {
    // Apply page-level overrides via setPageDef. The blank2010 template
    // ships A4 portrait + 30mm margins; we only mutate fields the caller
    // supplied so unspecified options keep template defaults.
    const pd = JSON.parse(doc.getPageDef(cursor.sec));
    if (op.orientation) {
      const wantLandscape = String(op.orientation).toLowerCase() === "landscape";
      if (wantLandscape !== pd.landscape) {
        [pd.width, pd.height] = [pd.height, pd.width];
        pd.landscape = wantLandscape;
      }
    }
    if (op.page_size) {
      // HWPUNIT (1/7200 inch). 1 mm = 283.46. Common sizes:
      const SIZES = {
        a4: [59528, 84186],   // 210 × 297 mm
        a5: [42040, 59528],   // 148 × 210 mm
        a3: [84186, 119055],  // 297 × 420 mm
        letter: [61560, 79200], // 8.5 × 11 in
        legal: [61560, 100800], // 8.5 × 14 in
      };
      const sz = SIZES[String(op.page_size).toLowerCase()];
      if (sz) {
        let [w, h] = sz;
        if (pd.landscape) [w, h] = [h, w];
        pd.width = w;
        pd.height = h;
      }
    }
    if (op.margin_mm !== undefined) {
      const m = Math.round(op.margin_mm * 283.46);
      pd.marginLeft = m; pd.marginRight = m;
      pd.marginTop = m; pd.marginBottom = m;
    }
    if (op.margin_top_mm !== undefined) pd.marginTop = Math.round(op.margin_top_mm * 283.46);
    if (op.margin_bottom_mm !== undefined) pd.marginBottom = Math.round(op.margin_bottom_mm * 283.46);
    if (op.margin_left_mm !== undefined) pd.marginLeft = Math.round(op.margin_left_mm * 283.46);
    if (op.margin_right_mm !== undefined) pd.marginRight = Math.round(op.margin_right_mm * 283.46);

    unwrap(doc.setPageDef(cursor.sec, JSON.stringify(pd)), "setPageDef");
    log.push(`setup_document: ${op.page_size || "default"} ${op.orientation || pd.landscape ? "landscape" : "portrait"}, margin=${op.margin_mm ?? "?"}mm, base_font=${op.base_font || "default"}`);
  },

  append_paragraph(doc, op, cursor) {
    startNewParagraph(doc, cursor);
    const runs = parseInlineRuns(op.text ?? op.runs ?? "");
    writeRunsAt(doc, cursor, runs);
    applyParaProps(doc, cursor, {
      align: op.align,
      lineSpacing: op.line_spacing ?? BODY_LINE_SPACING,
      // Critical: explicitly set spacingBefore=0 to OVERRIDE the inheritance
      // from the prior paragraph (splitParagraph copies the prior paraShape,
      // so body inherits heading's spacingBefore otherwise — turning every
      // body paragraph into a heading-sized leading gap).
      spacingBefore: op.spacing_before ?? 0,
      // Trailing gap on every body paragraph — combined with the next
      // element's spacingBefore (heading / next paragraph / table outer
      // margin), this yields a uniform "paragraph break" rhythm everywhere.
      spacingAfter: op.spacing_after ?? BODY_SPACING_AFTER,
    });
    applyParaBorders(doc, cursor, op);
    log.push(`append_paragraph (${cursor.charOffset} chars)`);
  },

  append_heading(doc, op, cursor) {
    startNewParagraph(doc, cursor);
    const level = Math.max(1, Math.min(6, op.level || 1));
    const def = HEADING_DEFAULTS[level];
    const runs = parseInlineRuns(op.text || "");
    const heightHU = Math.round(def.fontSize * 100);
    writeRunsAt(doc, cursor, runs, {
      fontSize: heightHU,
      bold: true,
      color: def.color,
    });
    headingPatches.push({
      paraIdx: cursor.para,
      heightHU,
      bold: true,
    });
    // Headings: left-aligned (justify makes 16pt headings look weird with
    // the inter-word stretch), tight line spacing, generous before/after.
    applyParaProps(doc, cursor, {
      align: op.align ?? "left",
      lineSpacing: HEADING_LINE_SPACING,
      spacingBefore: def.spacingBefore,
      spacingAfter: def.spacingAfter,
    });
    applyParaBorders(doc, cursor, op);
    log.push(`append_heading L${level} (${cursor.charOffset} chars)`);
  },

  append_table(doc, op, cursor) {
    const headers = op.headers || [];
    const rows = op.rows || [];
    const cols = headers.length || (rows[0] ? rows[0].length : 0);
    if (cols === 0) throw new Error("append_table: need headers or non-empty rows");
    const totalRows = (headers.length ? 1 : 0) + rows.length;
    if (totalRows === 0) throw new Error("append_table: no rows to write");

    // Open a fresh paragraph that the table will live in.
    startNewParagraph(doc, cursor);

    // Use createTableEx when explicit column widths or treat-as-char are
    // provided — falls back to the simpler createTable otherwise.
    let tableResult;
    if (op.col_widths_cm && Array.isArray(op.col_widths_cm)) {
      const colWidthsHwp = op.col_widths_cm.map((cm) => Math.round(cm * 2835));
      tableResult = unwrap(
        doc.createTableEx(JSON.stringify({
          sectionIdx: cursor.sec,
          paraIdx: cursor.para,
          charOffset: cursor.charOffset,
          rowCount: totalRows,
          colCount: cols,
          colWidths: colWidthsHwp,
          treatAsChar: op.treat_as_char ?? false,
        })),
        "createTableEx",
      );
    } else {
      tableResult = unwrap(
        doc.createTable(cursor.sec, cursor.para, cursor.charOffset, totalRows, cols),
        "createTable",
      );
    }
    const controlIdx = tableResult.controlIdx;
    const tableParaIdx = tableResult.paraIdx;

    const allRows = headers.length ? [headers, ...rows] : rows;
    // NOTE: `op.row_height_hu` and `setTableProperties({pageBreak, repeatHeader})`
    // were both attempted to equalize row heights and force row-level page
    // breaks. Hancom Office ignores both, but the rhwp-based web viewer
    // RESPECTS them — and respects them BADLY: forced cell heights cause
    // overlapping rendering, and pageBreak setting produces black-band page
    // separators with cells shifted out of column alignment. Both removed
    // (2026-04-29 visual iter). If a future rhwp release fixes the renderer
    // they can be re-added through `op.row_height_hu` (translator already
    // supports the field; worker just needs to re-wire it).
    // Korean gov-style header — light gray cell bg via the "all 4 borders"
    // trigger.
    //
    // Critical undocumented rhwp behavior (found by reading
    // `src/document_core/commands/table_ops.rs:422` in the rhwp source):
    //
    //     let has_border = json.contains("\"borderLeft\"");
    //     if has_border {
    //         let new_bf_id = self.create_border_fill_from_json(json);
    //         ...
    //     }
    //
    // setCellProperties ONLY allocates a new BorderFill (with our fill color)
    // when ALL FOUR border keys are present in the JSON. fillType+fillColor
    // alone are silently dropped — the path is gated by the borderLeft check.
    // The studio's `cell-border-bg-dialog.ts` always sends all 4 borders
    // together with fill, which is why their UI works and our earlier
    // single-key calls didn't. This is the same recipe.
    const DEFAULT_BORDER = { type: 1, width: 1, color: "#000000" };
    const HEADER_BG = "#EAEAEA";   // soft Office-style header gray
    const HEADER_PAD = 600;        // ~2.1mm vertical — taller header row
    const BODY_PAD = 400;          // ~1.4mm — generous breathing room (vs default 141)
    // createTableEx ignores per-column colWidths in the rhwp build we use:
    // header row 0 ends up with width=1 (≈0cm) and body rows get total/cols
    // evenly distributed regardless of the colWidths argument. Reapplying
    // the column widths via setCellProperties on every cell fixes both:
    // header gets the proper width AND body cells get the intended ratio.
    const colWidthsHwp = (op.col_widths_cm && Array.isArray(op.col_widths_cm))
      ? op.col_widths_cm.map((cm) => Math.round(cm * 2835))
      : null;
    for (let r = 0; r < allRows.length; r++) {
      const row = allRows[r];
      const isHeader = r === 0 && headers.length;
      for (let c = 0; c < cols; c++) {
        const cellIdx = r * cols + c;
        // Parse inline `**bold**` / `*italic*` markers in the cell text so
        // they don't end up rendered verbatim. Runs let us overlay per-range
        // formatting on top of the cell's base props.
        const cellRuns = parseInlineRuns(row[c] ?? "");
        const cellText = cellRuns.map((r) => r.text).join("");
        // Cell properties — width (override createTableEx's broken
        // distribution) + padding + (header only) borders & fill.
        const cellProps = {
          paddingTop: isHeader ? HEADER_PAD : BODY_PAD,
          paddingBottom: isHeader ? HEADER_PAD : BODY_PAD,
          paddingLeft: 510,
          paddingRight: 510,
        };
        if (colWidthsHwp) cellProps.width = colWidthsHwp[c];
        if (isHeader) {
          cellProps.borderLeft = DEFAULT_BORDER;
          cellProps.borderRight = DEFAULT_BORDER;
          cellProps.borderTop = DEFAULT_BORDER;
          cellProps.borderBottom = DEFAULT_BORDER;
          cellProps.fillType = "solid";
          cellProps.fillColor = HEADER_BG;
          cellProps.patternColor = HEADER_BG;
          cellProps.patternType = 0;
        }
        try {
          doc.setCellProperties(
            cursor.sec, tableParaIdx, controlIdx, cellIdx,
            JSON.stringify(cellProps),
          );
        } catch { /* best-effort */ }
        // Cell paragraph: tighten line spacing 160% → 110%. No fill/border
        // on the paragraph (cell-level fill above handles it).
        try {
          doc.applyParaFormatInCell(
            cursor.sec, tableParaIdx, controlIdx, cellIdx, 0,
            JSON.stringify({
              alignment: "left",
              lineSpacing: 110,
              spacingBefore: 0,
              spacingAfter: 0,
            }),
          );
        } catch { /* best-effort */ }
        if (!cellText) continue;
        unwrap(
          doc.insertTextInCell(cursor.sec, tableParaIdx, controlIdx, cellIdx, 0, 0, cellText),
          "insertTextInCell",
        );
        // Body cells: 9.5pt for density. Header: 10.5pt bold black on light
        // gray bg (textColor stays black — light bg makes white unreadable
        // and the rhwp char_shape readback for textColor is misleading;
        // empirically black on #EAEAEA reads cleanly).
        const baseProps = { fontSize: 950 };
        if (isHeader) {
          baseProps.bold = true;
          baseProps.fontSize = 1050;
        }
        doc.applyCharFormatInCell(
          cursor.sec, tableParaIdx, controlIdx, cellIdx,
          0, 0, cellText.length,
          JSON.stringify(baseProps),
        );
        // Overlay per-run bold/italic on top of the base. Headers are already
        // bold so an explicit **bold** marker is a no-op there; in body cells
        // it's how we surface emphasis (e.g. summary rows like "**합계**").
        let runOffset = 0;
        for (const run of cellRuns) {
          const len = run.text.length;
          if (len > 0 && (run.bold || run.italic)) {
            const overlay = { ...baseProps };
            if (run.bold) overlay.bold = true;
            if (run.italic) overlay.italic = true;
            doc.applyCharFormatInCell(
              cursor.sec, tableParaIdx, controlIdx, cellIdx,
              0, runOffset, runOffset + len,
              JSON.stringify(overlay),
            );
          }
          runOffset += len;
        }
      }
    }

    // After all cells are filled, configure table-level behavior: pageBreak
    // value (HWP 5.x spec: 0 = default, 1 = split-cell-mode). Empirically
    // 한컴 ignores both rhwp's enum value 2 (RowBreak — rhwp-only extension)
    // and the JSON path setting; behavior we observed in screenshots was
    // identical to the default. Repeat-header for multi-page tables works
    // similarly. We still send these on best-effort — if a future rhwp build
    // wires the serialization correctly, files start respecting them.
    try {
      doc.setTableProperties(
        cursor.sec, tableParaIdx, controlIdx,
        JSON.stringify({ pageBreak: 0, repeatHeader: true }),
      );
    } catch { /* best-effort — older builds */ }

    // Reset the table host paragraph's spacingBefore/After to 0 + break
    // the keep-together chain. Without this:
    //   1. Table paragraph inherits heading's sb≈53/sa≈37 from splitParagraph
    //      → adds to table height in page-fit calculation
    //   2. rhwp typeset bundles [table + everything after] for keep-together
    //      → if entire run doesn't fit on current page, table gets pushed
    //   keepWithNext: false tells rhwp the table can be the LAST element on
    //   a page (next paragraphs evaluate separately). Diagnosed via
    //   getPageRenderTree y-positions on a 3-table doc — page 2 had ~570pt
    //   empty bottom while a 150pt table waited on page 3.
    try {
      doc.applyParaFormat(
        cursor.sec, tableParaIdx,
        JSON.stringify({
          spacingBefore: 0,
          spacingAfter: 0,
          keepWithNext: false,
          keepLines: false,
        }),
      );
    } catch { /* best-effort */ }

    // Apply per-cell merges (for triangular tables, header spans, etc.).
    // Each merge is {from_row, from_col, to_row, to_col} (0-indexed,
    // both bounds inclusive). Merges happen AFTER text fill so cells we
    // wrote text into get merged properly.
    if (Array.isArray(op.merges)) {
      for (const m of op.merges) {
        unwrap(
          doc.mergeTableCells(
            cursor.sec, tableParaIdx, controlIdx,
            m.from_row, m.from_col, m.to_row, m.to_col,
          ),
          `mergeTableCells(${m.from_row},${m.from_col}→${m.to_row},${m.to_col})`,
        );
      }
    }

    // Apply per-cell property overrides (background, padding, vertical align).
    // Each entry: {row, col, ...rhwpCellProps}. After merges, cell indices
    // reference the surviving (top-left) cell of each merged region.
    if (Array.isArray(op.cell_styles)) {
      for (const s of op.cell_styles) {
        const cellIdx = s.row * cols + s.col;
        const props = {};
        if (s.bg_color) props.borderFillId = s.border_fill_id; // explicit id wins
        if (s.padding_mm) {
          const pHwp = Math.round(s.padding_mm * 283.46);
          props.paddingLeft = pHwp; props.paddingRight = pHwp;
          props.paddingTop = pHwp; props.paddingBottom = pHwp;
        }
        if (s.vertical_align) {
          // 0=top, 1=center, 2=bottom
          props.verticalAlign = { top: 0, center: 1, bottom: 2 }[s.vertical_align] ?? 1;
        }
        if (Object.keys(props).length === 0) continue;
        try {
          doc.setCellProperties(cursor.sec, tableParaIdx, controlIdx, cellIdx, JSON.stringify(props));
        } catch (e) {
          log.push(`cell_styles warn: ${e.message?.slice(0, 80)}`);
        }
      }
    }

    // After table insertion, the cursor sits in the paragraph after the table.
    // rhwp pushes the original paragraph after the table; its index is
    // tableParaIdx + 1 (the table itself replaces the at-cursor position).
    // Re-derive from getParagraphCount to stay safe.
    //
    // CRITICAL: leave firstParaUsed = false so the NEXT op writes into this
    // auto-created trailing paragraph instead of splitParagraph-ing again.
    // Without this, every table emits a phantom blank line before the next
    // heading/paragraph (createTable trailing para + new split = 2 paras).
    const newParaCount = doc.getParagraphCount(cursor.sec);
    cursor.para = newParaCount - 1;
    cursor.charOffset = 0;
    cursor.firstParaUsed = false;
    const mergeStr = op.merges ? ` +${op.merges.length} merge` : "";
    log.push(`append_table ${allRows.length}x${cols}${mergeStr}`);
  },

  setup_columns(doc, op, cursor) {
    // Multi-column layout (2단/3단). column_type: 0=일반, 1=배분, 2=평행.
    // spacing_mm is the gap between columns in mm (HWP unit conversion: ×283.46).
    const count = Math.max(1, op.count || 2);
    const columnType = op.column_type ?? 1;
    const sameWidth = op.same_width === false ? 0 : 1;
    const spacingHu = Math.round((op.spacing_mm ?? 8) * 283.46);
    unwrap(
      doc.setColumnDef(cursor.sec, count, columnType, sameWidth, spacingHu),
      "setColumnDef",
    );
    log.push(`setup_columns count=${count} spacing=${op.spacing_mm ?? 8}mm`);
  },

  insert_column_break(doc, op, cursor) {
    startNewParagraph(doc, cursor);
    unwrap(
      doc.insertColumnBreak(cursor.sec, cursor.para, cursor.charOffset),
      "insertColumnBreak",
    );
    cursor.para = doc.getParagraphCount(cursor.sec) - 1;
    cursor.charOffset = doc.getParagraphLength(cursor.sec, cursor.para);
    cursor.firstParaUsed = true;
    log.push("insert_column_break");
  },

  append_page_break(doc, op, cursor) {
    // insertPageBreak splits the current paragraph at char_offset and
    // marks the right-half new paragraph with column_type=Page. The next
    // op should then write INTO that empty break-paragraph (so the
    // heading/table text inherits the page-break marker) — NOT split it
    // again. Setting firstParaUsed=false makes startNewParagraph in the
    // next handler skip its splitParagraph call. Without this we'd get
    // a chain of empty paragraphs each carrying column_type=Page,
    // producing one blank page per chain link before the actual content.
    unwrap(
      doc.insertPageBreak(cursor.sec, cursor.para, cursor.charOffset),
      "insertPageBreak",
    );
    cursor.para = doc.getParagraphCount(cursor.sec) - 1;
    cursor.charOffset = 0;
    cursor.firstParaUsed = false;
    log.push("append_page_break");
  },

  append_bullet_list(doc, op, cursor) {
    const items = op.items || [];
    for (const item of items) {
      const text = typeof item === "string" ? item : String(item.text ?? "");
      const prefix = "• ";
      startNewParagraph(doc, cursor);
      const runs = [{ text: prefix }, ...parseInlineRuns(text)];
      writeRunsAt(doc, cursor, runs);
      // Tighter spacing for list items — 100 HWPUNIT after = ~0.35mm.
      applyParaProps(doc, cursor, {
        align: "left",
        lineSpacing: 120,
        spacingBefore: 0,
        spacingAfter: 100,
      });
    }
    log.push(`append_bullet_list (${items.length} items)`);
  },

  append_numbered_list(doc, op, cursor) {
    const items = op.items || [];
    items.forEach((item, idx) => {
      const text = typeof item === "string" ? item : String(item.text ?? "");
      const prefix = `${idx + 1}. `;
      startNewParagraph(doc, cursor);
      const runs = [{ text: prefix }, ...parseInlineRuns(text)];
      writeRunsAt(doc, cursor, runs);
      applyParaProps(doc, cursor, {
        align: "left",
        lineSpacing: 120,
        spacingBefore: 0,
        spacingAfter: 100,
      });
    });
    log.push(`append_numbered_list (${items.length} items)`);
  },

  append_image(doc, op, cursor) {
    if (!op.path) throw new Error("append_image: 'path' is required");
    const imgPath = path.resolve(op.path);
    if (!fs.existsSync(imgPath)) throw new Error(`append_image: file not found: ${imgPath}`);
    const bytes = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).slice(1).toLowerCase() || "png";
    // rhwp's insertPicture takes width/height in HWPUNIT (1/7200 inch). The
    // conversion factor is 1 cm = 2834.6 HWPUNIT — we round to 2835. Earlier
    // versions used cm * 1000 thinking the unit was 1/100 mm, which made
    // every embedded image render at ~35% of the requested size.
    const CM_TO_HWPUNIT = 2835;
    const widthCm = op.width_cm || 12;
    const heightCm = op.height_cm || (widthCm * 0.66); // 3:2 default if unspecified
    const widthHwp = Math.round(widthCm * CM_TO_HWPUNIT);
    const heightHwp = Math.round(heightCm * CM_TO_HWPUNIT);
    // Parse PNG IHDR for natural pixel size BEFORE insertPicture — rhwp's
    // 7th/8th args are naturalWidthPx/naturalHeightPx (NOT a duplicate of
    // the HU display size). Passing widthHwp there made rhwp write
    // imgDim = widthHwp × 75 instead of pixel × 75, which a strict viewer
    // (e.g. our local renderer) interprets as "image is 75× larger than
    // displayed" → image rendered at ~1/75 scale. Hancom Docs masks the
    // bug by rewriting imgDim from PNG IHDR on round-trip.
    let nativePxW = 0, nativePxH = 0;
    if (ext === "png" && bytes.length >= 24 && bytes.readUInt32BE(12) === 0x49484452 /* 'IHDR' */) {
      nativePxW = bytes.readUInt32BE(16);
      nativePxH = bytes.readUInt32BE(20);
    }
    // Non-PNG fallback: approximate pixels from display HU at ~96dpi
    // (HU per px ≈ 75) so imgDim/orgSz ratio stays sane.
    const naturalW = nativePxW || Math.max(1, Math.round(widthHwp / 75));
    const naturalH = nativePxH || Math.max(1, Math.round(heightHwp / 75));
    startNewParagraph(doc, cursor);
    unwrap(
      doc.insertPicture(
        cursor.sec,
        cursor.para,
        cursor.charOffset,
        new Uint8Array(bytes),
        widthHwp,
        heightHwp,
        naturalW,
        naturalH,
        ext,
        op.alt || "",
      ),
      "insertPicture",
    );
    // Refresh cursor after picture insertion.
    cursor.charOffset = doc.getParagraphLength(cursor.sec, cursor.para);
    // Record the position so the hwpx post-export patcher can inject a
    // matching <hp:pic> node here. binaryItemIDRef follows rhwp's BinData/
    // numbering which is 1-based by insertion order.
    imagePatches.push({
      paraIdx: cursor.para,
      widthHwp,
      heightHwp,
      nativePxW,
      nativePxH,
      binaryItemIDRef: `image${imagePatches.length + 1}`,
    });
    log.push(`append_image (${widthCm}cm x ${heightCm}cm${nativePxW ? `, native ${nativePxW}x${nativePxH}px` : ""})`);
  },

  replace_text(doc, op, cursor) {
    if (!op.query) throw new Error("replace_text: 'query' is required");
    const replacement = op.replacement ?? "";
    if (/[\n\r\u2028\u2029]/.test(replacement)) {
      throw new Error("replace_text: replacement cannot contain paragraph-break characters");
    }
    // replaceOne returns {ok, replaced_count}. NOTE: rhwp's searchText (and
    // therefore replaceOne) does NOT walk into table cells — anchor text
    // inside a <hp:tbl> is invisible to this op. Use `set_cell_text` /
    // `set_cell_text_by_label` for table cells.
    const r = unwrap(
      doc.replaceOne(op.query, replacement, !!op.case_sensitive),
      "replaceOne",
    );
    log.push(`replace_text "${op.query}" → "${replacement}" (${r.replaced_count ?? r.count ?? "?"} matches)`);
  },

  // ── Table cell ops ────────────────────────────────────────────────────────
  //
  // rhwp's searchText/replaceText skip table cells, so editing existing
  // tables needs dedicated coordinate-based ops. The wasm uses a flat
  // row-major cell_idx (header row counts as row 0). We expose row+col on
  // the public op for readability and convert internally — column count is
  // auto-detected by walking cells via getCellInfo until it errors.

  set_cell_text(doc, op, cursor) {
    const sec = requireInt(op, "section");
    const para = requireInt(op, "para");
    const ctrl = requireInt(op, "control");
    const text = op.text ?? "";
    if (/[\n\r\u2028\u2029]/.test(text)) {
      throw new Error("set_cell_text: 'text' cannot contain paragraph-break characters");
    }
    const cellPara = op.cell_para ?? 0;
    const cellIdx = resolveCellIdx(doc, sec, para, ctrl, op);
    applyCellText(doc, sec, para, ctrl, cellIdx, cellPara, text);
    log.push(`set_cell_text sec=${sec} para=${para} ctrl=${ctrl} cell=${cellIdx} "${truncForLog(text)}"`);
  },

  set_cell_text_by_label(doc, op, cursor) {
    if (typeof op.label !== "string" || op.label.length === 0) {
      throw new Error("set_cell_text_by_label: 'label' is required");
    }
    const text = op.text ?? "";
    if (/[\n\r\u2028\u2029]/.test(text)) {
      throw new Error("set_cell_text_by_label: 'text' cannot contain paragraph-break characters");
    }
    const rowOff = op.row_offset ?? 0;
    const colOff = op.col_offset ?? 0;
    const occurrence = op.occurrence ?? 0;
    const caseSensitive = !!op.case_sensitive;
    const cellPara = op.cell_para ?? 0;

    // Optional scoping: if (section, para, control) given, only search that
    // table; otherwise walk every table in the document.
    let candidates;
    if (op.section != null || op.para != null || op.control != null) {
      const sec = requireInt(op, "section");
      const para = requireInt(op, "para");
      const ctrl = requireInt(op, "control");
      candidates = [{ sec, para, ctrl }];
    } else {
      candidates = enumerateTables(doc);
    }

    const hits = [];
    for (const { sec, para, ctrl } of candidates) {
      const grid = describeTable(doc, sec, para, ctrl);
      if (!grid) continue;
      for (const cell of grid.cells) {
        const txt = caseSensitive ? cell.text : cell.text.toLowerCase();
        const needle = caseSensitive ? op.label : op.label.toLowerCase();
        if (txt.includes(needle)) hits.push({ sec, para, ctrl, grid, cell });
      }
    }
    if (hits.length === 0) {
      throw new Error(`set_cell_text_by_label: no cell containing "${op.label}" found`);
    }
    if (occurrence >= hits.length) {
      throw new Error(`set_cell_text_by_label: occurrence ${occurrence} out of range (${hits.length} hits)`);
    }
    const hit = hits[occurrence];
    const targetRow = hit.cell.row + rowOff;
    const targetCol = hit.cell.col + colOff;
    const targetCellIdx = hit.grid.indexByRowCol(targetRow, targetCol);
    if (targetCellIdx == null) {
      throw new Error(`set_cell_text_by_label: target (row=${targetRow}, col=${targetCol}) is outside the table`);
    }
    applyCellText(doc, hit.sec, hit.para, hit.ctrl, targetCellIdx, cellPara, text);
    log.push(
      `set_cell_text_by_label label="${op.label}" → ` +
      `sec=${hit.sec} para=${hit.para} ctrl=${hit.ctrl} ` +
      `anchor=(${hit.cell.row},${hit.cell.col}) target=(${targetRow},${targetCol}) cell=${targetCellIdx} ` +
      `"${truncForLog(text)}"`,
    );
  },
};

// ── Cell-op helpers ─────────────────────────────────────────────────────────
//
// Module-private (not exposed on OPS) — shared infrastructure for
// set_cell_text / set_cell_text_by_label.

function requireInt(op, key) {
  const v = op[key];
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`set_cell_*: '${key}' must be a non-negative integer (got ${JSON.stringify(v)})`);
  }
  return v;
}

function truncForLog(s) {
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}

// Convert public {row,col} or {cell} on the op into a flat cell_idx using
// the actual table dimensions read from rhwp. We prefer (row,col) — the flat
// cell index ordering is row-major but the count includes header rows and
// spans, so hand-counting is error-prone.
function resolveCellIdx(doc, sec, para, ctrl, op) {
  if (op.cell != null) return requireInt(op, "cell");
  const row = requireInt(op, "row");
  const col = requireInt(op, "col");
  const grid = describeTable(doc, sec, para, ctrl);
  if (!grid) throw new Error(`set_cell_text: no table at sec=${sec} para=${para} ctrl=${ctrl}`);
  const idx = grid.indexByRowCol(row, col);
  if (idx == null) {
    throw new Error(`set_cell_text: (row=${row}, col=${col}) is outside the table (rows=${grid.rowCount}, cols=${grid.colCount})`);
  }
  return idx;
}

// Walk a table's cells via getCellInfo until rhwp errors (= past last cell).
// Returns { rowCount, colCount, cells: [{idx,row,col,rowSpan,colSpan,text}],
//           indexByRowCol(r,c) } or null if the control isn't a table.
function describeTable(doc, sec, para, ctrl) {
  const cells = [];
  let rowCount = 0, colCount = 0;
  for (let i = 0; i < 10000; i++) {
    let info;
    try {
      info = JSON.parse(doc.getCellInfo(sec, para, ctrl, i));
    } catch {
      break;
    }
    if (!info || typeof info.row !== "number") break;
    let text = "";
    try { text = doc.getTextInCell(sec, para, ctrl, i, 0, 0, 100000); } catch {}
    cells.push({
      idx: i,
      row: info.row,
      col: info.col,
      rowSpan: info.rowSpan ?? 1,
      colSpan: info.colSpan ?? 1,
      text,
    });
    rowCount = Math.max(rowCount, info.row + (info.rowSpan ?? 1));
    colCount = Math.max(colCount, info.col + (info.colSpan ?? 1));
  }
  if (cells.length === 0) return null;
  const byRowCol = new Map();
  for (const c of cells) byRowCol.set(`${c.row},${c.col}`, c.idx);
  return {
    rowCount,
    colCount,
    cells,
    indexByRowCol(r, c) {
      return byRowCol.get(`${r},${c}`);
    },
  };
}

// Walk every paragraph in every section, asking rhwp for table cells at
// each (sec, para, ctrl) tuple. Returns [{sec, para, ctrl}] for every
// table control encountered.
//
// Why we don't break on the first failing control index: a paragraph can
// hold non-table controls (textboxes, pictures, fields) interleaved with
// tables — government forms in particular use cover paragraphs that pack
// a logo (ctrl 0), a checkbox (ctrl 1), a textbox (ctrl 2), and only
// THEN the actual table (ctrl 3). rhwp errors "지정된 컨트롤이 표가
// 아닙니다" for those non-table indices, which is a "skip" signal, not a
// "no more controls" signal. We keep scanning up to MAX_CONTROL_IDX —
// well past anything seen in real forms — and only stop on a different
// error class. The cost is ~64 cheap wasm calls per paragraph, negligible.
const MAX_CONTROL_IDX = 64;
function enumerateTables(doc) {
  const out = [];
  const sectionCount = (() => {
    try { return doc.getSectionCount(); } catch { return 1; }
  })();
  for (let sec = 0; sec < sectionCount; sec++) {
    const paraCount = (() => {
      try { return doc.getParagraphCount(sec); } catch { return 0; }
    })();
    for (let p = 0; p < paraCount; p++) {
      for (let c = 0; c < MAX_CONTROL_IDX; c++) {
        let info;
        try { info = JSON.parse(doc.getCellInfo(sec, p, c, 0)); } catch { continue; }
        if (!info || typeof info.row !== "number") continue;
        out.push({ sec, para: p, ctrl: c });
      }
    }
  }
  return out;
}

function applyCellText(doc, sec, para, ctrl, cellIdx, cellPara, text) {
  // Read current cell text, then delete + insert. We avoid `replaceText`
  // here because that API takes (sec, para, charOffset, length) — operates
  // on body paragraphs, not on a cell's inner paragraph.
  let current = "";
  try {
    current = doc.getTextInCell(sec, para, ctrl, cellIdx, cellPara, 0, 100000) ?? "";
  } catch (e) {
    throw new Error(`set_cell_text: cell access failed (sec=${sec} para=${para} ctrl=${ctrl} cell=${cellIdx}): ${e.message}`);
  }
  if (current.length > 0) {
    doc.deleteTextInCell(sec, para, ctrl, cellIdx, cellPara, 0, current.length);
  }
  if (text.length > 0) {
    doc.insertTextInCell(sec, para, ctrl, cellIdx, cellPara, 0, text);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

// ── HWPX picture post-patch ───────────────────────────────────────────────
//
// rhwp 0.7.7's hwpx serializer:
//   - DOES pack image binary into BinData/imageN.png (correct)
//   - DOES register it in Contents/content.hpf <opf:manifest> (correct)
//   - DOES emit a paragraph at the picture position (correct)
//   - DOES NOT emit the <hp:pic> + <hc:img binaryItemIDRef="imageN"> nodes
//     inside that paragraph's <hp:run> (BUG — paragraph stays as <hp:t/>)
// Result: Hancom opens the file, sees the binary in BinData/ but no draw
// instruction in section0.xml, and silently skips it.
//
// Fix: locate the Nth empty-text paragraph (matching the Nth append_image
// op in insertion order, since rhwp preserves paragraph order in section0)
// and rewrite its <hp:run charPrIDRef="X"><hp:t/></hp:run> to include a
// reference-shaped <hp:pic> node followed by the empty <hp:t/>.
//
// Pic node attributes were captured from a Hancom-saved hwpx (drag-drop
// image into 한컴 → 다른 이름 저장 → .hwpx). bindataList in header.xml is
// optional — Hancom's own output omits it too.

function buildPicXml(widthHwp, heightHwp, binaryItemIDRef, nativePxW, nativePxH) {
  // id / instid need to be unique-ish numerics; Hancom doesn't validate
  // semantic meaning. Using high-entropy values from Date.now() avoids
  // collisions across multiple images in a single doc.
  const id = (Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff);
  const instid = (Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff);
  // imgClip / imgDim represent the image's intrinsic pixel rectangle in
  // HWPUNIT. Hancom-saved hwpx uses native_px × 75 HWPUNIT (= 7200 / 96dpi).
  // Our local rhwp viewer scales the bitmap by orgSz / imgDim — too small
  // imgDim leaves the rendered image larger than the orgSz frame and clips
  // its right/bottom edges (visible when imgDim ≈ sz: only top-left of the
  // bitmap survives). Matching Hancom's 96dpi factor reproduces the same
  // ratio Hancom emits and renders cleanly in both viewers.
  const HWPUNIT_PER_PX = 75;
  const clipW = nativePxW > 0 ? Math.round(nativePxW * HWPUNIT_PER_PX) : widthHwp;
  const clipH = nativePxH > 0 ? Math.round(nativePxH * HWPUNIT_PER_PX) : heightHwp;
  return (
    `<hp:pic id="${id}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" ` +
    `textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" ` +
    `instid="${instid}" reverse="0">` +
    `<hp:offset x="0" y="0"/>` +
    `<hp:orgSz width="${widthHwp}" height="${heightHwp}"/>` +
    `<hp:curSz width="0" height="0"/>` +
    `<hp:flip horizontal="0" vertical="0"/>` +
    `<hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="0"/>` +
    `<hp:renderingInfo>` +
    `<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
    `<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
    `<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>` +
    `</hp:renderingInfo>` +
    `<hc:img binaryItemIDRef="${binaryItemIDRef}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
    `<hp:imgRect>` +
    `<hc:pt0 x="0" y="0"/>` +
    `<hc:pt1 x="${widthHwp}" y="0"/>` +
    `<hc:pt2 x="${widthHwp}" y="${heightHwp}"/>` +
    `<hc:pt3 x="0" y="${heightHwp}"/>` +
    `</hp:imgRect>` +
    `<hp:imgClip left="0" right="${clipW}" top="0" bottom="${clipH}"/>` +
    `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
    `<hp:imgDim dimwidth="${clipW}" dimheight="${clipH}"/>` +
    `<hp:effects/>` +
    `<hp:sz width="${widthHwp}" widthRelTo="ABSOLUTE" height="${heightHwp}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" ` +
    `holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" ` +
    `horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
    `</hp:pic>`
  );
}

async function patchHwpxPictures(filePath, patches) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);

  // content.hpf manifest needs `isEmbeded="1"` (sic — typo in OWPML spec)
  // on every image item, otherwise Hancom treats the BinData/ entry as an
  // external reference and renders the missing-image placeholder even when
  // section0.xml has a fully-formed <hp:pic>. rhwp's hwpx serializer
  // omits this attribute. We splice it in for every image item that's
  // missing it.
  const hpfEntry = zip.file("Contents/content.hpf");
  if (hpfEntry) {
    let hpf = await hpfEntry.async("string");
    const before = hpf;
    hpf = hpf.replace(
      /(<opf:item\b[^>]*?\bmedia-type="image\/[^"]+")(\s*\/>)/g,
      (_match, head, tail) =>
        head.includes("isEmbeded=") ? _match : `${head} isEmbeded="1"${tail}`,
    );
    if (hpf !== before) zip.file("Contents/content.hpf", hpf);
  }

  const sectionEntry = zip.file("Contents/section0.xml");
  if (!sectionEntry) throw new Error("section0.xml missing from hwpx");
  let xml = await sectionEntry.async("string");

  // Hancom-saved hwpx declares xmlns:hwpunitchar on <hs:sec>; rhwp omits it.
  // It's referenced indirectly by Hancom's own picture rendering path —
  // splice it in if not present so the document validates against the
  // same namespace surface as Hancom's reference output.
  if (!xml.includes('xmlns:hwpunitchar=')) {
    xml = xml.replace(
      /<hs:sec\b([^>]*?)>/,
      '<hs:sec$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">',
    );
  }

  // Strategy: walk top-level <hp:p> blocks, rewrite the run inside the
  // paragraph at each tracked paraIdx. Match the empty-text run pattern
  // that rhwp leaves behind. We DON'T touch paragraphs without that
  // pattern so any other empty paragraphs (spacers) stay untouched.
  // Match an empty-text run in either self-closing (<hp:t/>) or paired
  // (<hp:t></hp:t>) form — rhwp serializes the paired form, the spec
  // allows both.
  const emptyRunRe =
    /<hp:run\s+charPrIDRef="(\d+)"\s*>\s*(?:<hp:t\s*\/>|<hp:t\s*>\s*<\/hp:t>)\s*<\/hp:run>/;

  // Index every <hp:p>...</hp:p> region.
  const pRe = /<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g;
  const regions = [];
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }

  // Apply patches in reverse so earlier offsets stay valid as we splice.
  const applied = [];
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p.paraIdx < 0 || p.paraIdx >= regions.length) {
      applied.unshift({ ok: false, reason: `paraIdx ${p.paraIdx} out of range (${regions.length} paragraphs)` });
      continue;
    }
    const region = regions[p.paraIdx];
    const before = xml.slice(0, region.start);
    const body = xml.slice(region.start, region.end);
    const after = xml.slice(region.end);
    const picXml = buildPicXml(p.widthHwp, p.heightHwp, p.binaryItemIDRef, p.nativePxW || 0, p.nativePxH || 0);
    let newBody = body.replace(
      emptyRunRe,
      (match, charPrIDRef) =>
        `<hp:run charPrIDRef="${charPrIDRef}">${picXml}<hp:t/></hp:run>`,
    );
    if (newBody === body) {
      applied.unshift({ ok: false, reason: `empty-run pattern not found at paraIdx ${p.paraIdx}` });
      continue;
    }
    // Linesegarray is stripped globally by stripHwpxLayoutCache after this
    // pass, so we don't need to remove it here per-paragraph anymore.
    xml = before + newBody + after;
    applied.unshift({ ok: true, paraIdx: p.paraIdx });
  }

  // Bail BEFORE writing if any patch failed — otherwise a partially-patched
  // hwpx ends up on disk and the caller can't tell from the file alone which
  // images are missing their <hp:pic> nodes.
  const failures = applied.filter((a) => !a.ok);
  if (failures.length) {
    throw new Error(
      `hwpx_patch incomplete: ${failures.length} of ${patches.length} not applied (${failures.map((f) => f.reason).join("; ")})`,
    );
  }

  // mimetype must stay STORE-compressed per OWPML packaging rules; everything
  // else is fine with default DEFLATE. JSZip preserves the original
  // compression for entries we don't replace, so we only re-stamp section0.
  zip.file("Contents/section0.xml", xml);
  const newBuf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(filePath, newBuf);
}

// ── Heading charPrIDRef fix ───────────────────────────────────────────────
//
// rhwp's HWPX serializer emits <hh:charPr id="N" height="..." ><hh:bold/></hh:charPr>
// in header.xml for the styles writeRunsAt requested, but writes every run
// in section0.xml with charPrIDRef="0" (the default body shape). Result: the
// heading definition exists but is never referenced, so the heading renders
// at body size. Look up the matching charPr id in header.xml by (height, bold)
// and rewrite the run that owns the heading text.

async function patchHwpxHeadings(filePath, patches) {
  if (patches.length === 0) return 0;
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const headerEntry = zip.file("Contents/header.xml");
  const sectionEntry = zip.file("Contents/section0.xml");
  if (!headerEntry || !sectionEntry) return 0;
  const headerXml = await headerEntry.async("string");
  const sectionXml = await sectionEntry.async("string");

  // Parse <hh:charPr> blocks (self-closing or paired). Build a (height, bold) → id map.
  // Multiple charPrs may share the same (height, bold) — pick the first; rhwp dedupes.
  const charPrRe = /<hh:charPr\b[^>]*?(?:\/>|>(?:[^<]|<(?!\/hh:charPr>))*?<\/hh:charPr>)/g;
  const lookup = new Map();
  for (const m of headerXml.matchAll(charPrRe)) {
    const s = m[0];
    const idM = /\bid="(\d+)"/.exec(s);
    const heightM = /\bheight="(\d+)"/.exec(s);
    if (!idM || !heightM) continue;
    const id = idM[1];
    const height = heightM[1];
    const bold = /<hh:bold\b/.test(s);
    const key = `${height}:${bold ? 1 : 0}`;
    if (!lookup.has(key)) lookup.set(key, id);
  }

  // Find every <hp:p>...</hp:p> region and rewrite the text-bearing run's
  // charPrIDRef in each tracked heading paragraph.
  const pRe = /<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g;
  const regions = [];
  for (const m of sectionXml.matchAll(pRe)) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }
  let xml = sectionXml;
  let fixed = 0;
  // Apply in reverse so offsets stay valid.
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p.paraIdx < 0 || p.paraIdx >= regions.length) continue;
    const key = `${p.heightHU}:${p.bold ? 1 : 0}`;
    const targetId = lookup.get(key);
    if (!targetId) continue;
    const region = regions[p.paraIdx];
    const before = xml.slice(0, region.start);
    const body = xml.slice(region.start, region.end);
    const after = xml.slice(region.end);
    // Match <hp:run charPrIDRef="N">...<hp:t>...</hp:t>...</hp:run> and
    // rewrite its charPrIDRef. Other runs in the same paragraph (e.g. the
    // secPr/ctrl-only first run) stay untouched.
    const runRe = /<hp:run\s+charPrIDRef="(\d+)"\s*>([\s\S]*?)<\/hp:run>/g;
    const newBody = body.replace(runRe, (full, currentId, inner) => {
      if (!/<hp:t\b/.test(inner)) return full;
      if (currentId === targetId) return full;
      fixed++;
      return `<hp:run charPrIDRef="${targetId}">${inner}</hp:run>`;
    });
    if (newBody !== body) xml = before + newBody + after;
  }

  if (fixed > 0) {
    zip.file("Contents/section0.xml", xml);
    const newBuf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    fs.writeFileSync(filePath, newBuf);
  }
  return fixed;
}

// ── Layout-cache strip ────────────────────────────────────────────────────
//
// rhwp's HWP/HWPX serializer pre-fills PARA_LINESEG (binary) /
// <hp:linesegarray> (xml) records with placeholder vertpos/vertsize values
// that ignore image and table heights. A strict viewer that trusts those
// cached layouts (our local renderer) places later paragraphs at the wrong
// vertical position — the picture overflows its 1-line "vsize=900" cache
// and pushes following text onto the next page. Hancom strips these on
// every save and lets the next viewer recompute layout from scratch; we
// mirror that.

async function stripHwpxLayoutCache(filePath) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  let stripped = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    const newXml = xml.replace(
      /<hp:linesegarray\b[^>]*>[\s\S]*?<\/hp:linesegarray>/g,
      () => { stripped++; return ""; },
    );
    if (newXml !== xml) zip.file(name, newXml);
  }
  if (stripped > 0) {
    const newBuf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    fs.writeFileSync(filePath, newBuf);
  }
  return stripped;
}

// PARA_LINESEG = HWPTAG_BEGIN(0x10) + 53 = 69 in HWP 5.0 binary records.
// Each record: 32-bit LE header { tag:10, level:10, size:12 }; if size==0xFFF
// an extra 32-bit size follows. We drop tag=69 records and keep everything
// else verbatim.
function stripParaLineSegRecords(decompressed) {
  const chunks = [];
  let pos = 0;
  let dropped = 0;
  while (pos < decompressed.length) {
    if (pos + 4 > decompressed.length) {
      chunks.push(decompressed.slice(pos));
      break;
    }
    const h = decompressed.readUInt32LE(pos);
    const tag = h & 0x3FF;
    let size = (h >>> 20) & 0xFFF;
    let headSize = 4;
    if (size === 0xFFF) {
      size = decompressed.readUInt32LE(pos + 4);
      headSize = 8;
    }
    const total = headSize + size;
    if (tag === 69) {
      dropped++;
    } else {
      chunks.push(decompressed.slice(pos, pos + total));
    }
    pos += total;
  }
  return { buffer: Buffer.concat(chunks), dropped };
}

function stripHwpLayoutCache(filePath) {
  const buf = fs.readFileSync(filePath);
  const cfb = CFB.read(buf, { type: "buffer" });
  const fh = CFB.find(cfb, "/FileHeader");
  if (!fh) return 0;
  const compressed = (Buffer.from(fh.content)[36] & 1) === 1;
  let totalDropped = 0;
  // BodyText/SectionN streams contain the paragraph records. Iterate every
  // matching stream so multi-section docs are covered.
  for (const fp of cfb.FullPaths || []) {
    const m = fp.match(/^Root Entry\/BodyText\/(Section\d+)$/);
    if (!m) continue;
    const path = `/BodyText/${m[1]}`;
    const stream = CFB.find(cfb, path);
    if (!stream) continue;
    const raw = Buffer.from(stream.content);
    let body;
    try {
      body = compressed ? zlib.inflateRawSync(raw) : raw;
    } catch (err) {
      // Skip streams we can't decompress — leave them untouched.
      continue;
    }
    const { buffer: newBody, dropped } = stripParaLineSegRecords(body);
    if (dropped === 0) continue;
    const newRaw = compressed
      ? zlib.deflateRawSync(newBody, { level: 9 })
      : newBody;
    CFB.utils.cfb_add(cfb, path, newRaw);
    totalDropped += dropped;
  }
  if (totalDropped > 0) {
    const out = CFB.write(cfb, { type: "buffer" });
    fs.writeFileSync(filePath, out);
  }
  return totalDropped;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

(async () => {
  let payload;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(JSON.stringify({ status: "error", message: `bad stdin JSON: ${err.message}` }) + "\n");
    process.exit(1);
  }

  const outPath = payload.path;
  const ops = payload.operations || [];
  if (!outPath) {
    process.stdout.write(JSON.stringify({ status: "error", message: "'path' is required" }) + "\n");
    process.exit(1);
  }

  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".hwp" && ext !== ".hwpx") {
    process.stdout.write(JSON.stringify({ status: "error", message: `path must end in .hwp or .hwpx (got ${ext})` }) + "\n");
    process.exit(1);
  }

  // Decide whether to start blank or load an existing file. If the path
  // already exists AND `setup_document` is NOT the first op, we treat it as
  // an edit-in-place. Otherwise blank.
  let doc;
  const firstOp = ops[0]?.type;
  if (fs.existsSync(outPath) && firstOp !== "setup_document") {
    doc = new HwpDocument(new Uint8Array(fs.readFileSync(outPath)));
    log.push(`loaded existing ${path.basename(outPath)} (${doc.getSectionCount()} sections, ${doc.getParagraphCount(0)} paras [sec0])`);
  } else {
    doc = HwpDocument.createEmpty();
    unwrap(doc.createBlankDocument(), "createBlankDocument");
    log.push(`created blank document → will write to ${path.basename(outPath)}`);
  }

  const cursor = makeCursor(doc);

  // Apply page-level setup (orientation, size, margins) BEFORE entering
  // batch mode so pagination uses the right page dimensions for everything
  // that follows. Anything else stays inside the batch.
  let opIdx = 0;
  while (opIdx < ops.length && ops[opIdx].type === "setup_document") {
    HANDLERS.setup_document(doc, ops[opIdx], cursor);
    opIdx++;
  }

  doc.beginBatch();

  try {
    for (; opIdx < ops.length; opIdx++) {
      const op = ops[opIdx];
      const handler = HANDLERS[op.type];
      if (!handler) throw new Error(`unknown op type '${op.type}'`);
      handler(doc, op, cursor);
    }
  } catch (err) {
    try { doc.endBatch(); } catch {}
    const msg = err && err.message
      ? err.message
      : (typeof err === "string" ? err : JSON.stringify(err) || "(unknown error)");
    process.stdout.write(
      JSON.stringify({
        status: "error",
        message: msg,
        op_index: opIdx,
        op_type: ops[opIdx]?.type,
        log,
      }) + "\n",
    );
    process.exit(1);
  }

  doc.endBatch();

  // Serialize and save based on extension.
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  let bytes;
  try {
    bytes = ext === ".hwp" ? doc.exportHwp() : doc.exportHwpx();
  } catch (err) {
    process.stdout.write(JSON.stringify({ status: "error", message: `export failed: ${err.message}`, log }) + "\n");
    process.exit(1);
  }
  fs.writeFileSync(outPath, bytes);

  // .hwpx post-processing: rhwp's hwpx serializer leaves the picture
  // paragraph empty even though it packs the binary + manifest entry.
  // Patch the picture run in section0.xml so Hancom actually renders it.
  // .hwp uses a different (binary-record) emit path that already includes
  // the picture control, so the picture-injection step only runs for .hwpx.
  if (ext === ".hwpx" && imagePatches.length > 0) {
    try {
      await patchHwpxPictures(outPath, imagePatches);
      log.push(`hwpx_patch: injected ${imagePatches.length} <hp:pic> node(s)`);
    } catch (err) {
      log.push(`hwpx_patch failed: ${err.message}`);
    }
  }

  // Fix heading run references in hwpx (rhwp emits charPrIDRef="0" instead
  // of the heading's own charPr id).
  if (ext === ".hwpx" && headingPatches.length > 0) {
    try {
      const n = await patchHwpxHeadings(outPath, headingPatches);
      if (n > 0) log.push(`hwpx_patch: fixed ${n} heading charPrIDRef`);
    } catch (err) {
      log.push(`hwpx_heading_patch failed: ${err.message}`);
    }
  }

  // Strip rhwp's stale layout cache regardless of whether images are
  // present — tables and ordinary paragraphs hit the same wrong-layout
  // problem when the renderer trusts cached lineseg vertpos values.
  try {
    if (ext === ".hwpx") {
      const n = await stripHwpxLayoutCache(outPath);
      if (n > 0) log.push(`stripped ${n} <hp:linesegarray> block(s)`);
    } else if (ext === ".hwp") {
      const n = stripHwpLayoutCache(outPath);
      if (n > 0) log.push(`stripped ${n} PARA_LINESEG record(s)`);
    }
  } catch (err) {
    log.push(`layout_cache_strip failed: ${err.message}`);
  }

  let verify = null;
  try {
    if (ext === ".hwp") verify = JSON.parse(doc.exportHwpVerify());
  } catch {
    // exportHwpVerify is best-effort; ignore failures.
  }

  process.stdout.write(
    JSON.stringify({
      status: "success",
      path: outPath,
      bytes_written: bytes.byteLength,
      ops_applied: ops.length,
      verify,
      log,
    }) + "\n",
  );
})().catch((err) => {
  process.stdout.write(JSON.stringify({ status: "error", message: `fatal: ${err.message}` }) + "\n");
  process.exit(1);
});
