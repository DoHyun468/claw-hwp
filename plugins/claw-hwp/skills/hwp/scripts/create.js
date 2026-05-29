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

// ── Character-format prop translation (user-facing → rhwp internal) ──────
//
// Empirically probed (2026-05-26) which JSON keys rhwp's applyCharFormat
// stores on the CharShape record. The user-facing names below mirror the
// hwpx-edit-module `apply_text_style` op so cold-start Claude calls the
// same vocabulary regardless of input format; the dispatcher routes by
// extension. Key non-obvious mappings:
//   - HIGHLIGHT (형광펜) is `shadeColor` in rhwp, NOT `highlight` /
//     `background` / `charBgColor` (those are silently ignored).
//   - Font family / letter spacing / char ratio are stored as
//     per-language ARRAYS of 7 entries (one per language script: Hangul,
//     Latin, Hanja, Japanese, Other, Symbol, User). A scalar form is
//     silently ignored — must broadcast to all 7.
//   - fontSize is in HWP units (1pt = 100); callers pass points and we
//     multiply.
//
// IMPORTANT: rhwp's applyCharFormat does a MERGE with the existing
// CharShape, so any prop we don't include retains the prior run's value.
// For the "managed" flag set (bold/italic/underline/strikethrough/super/
// sub/textColor/shadeColor) we ALWAYS emit a value — false / neutral
// when not requested — so styling from one run never leaks into the
// next. This matches the original writeRunsAt's bold/italic behavior
// and extends it to the new prop set.
const MANAGED_NEUTRAL = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  textColor: "#000000",
  shadeColor: "#ffffff",
};

function buildCharFormatProps(input = {}, defaults = {}) {
  const props = {};

  // Managed booleans — always emit (default false so leaks are killed)
  for (const flag of ['bold', 'italic', 'underline', 'strikethrough',
                       'superscript', 'subscript']) {
    if (input[flag] !== undefined) props[flag] = !!input[flag];
    else if (defaults[flag] !== undefined) props[flag] = !!defaults[flag];
    else props[flag] = MANAGED_NEUTRAL[flag];
  }

  // Unmanaged boolean extras — only emit when the caller asks. These are
  // rarely used and don't show up in HEADING_DEFAULTS, so the leak risk
  // is low.
  for (const flag of ['emboss', 'engrave', 'kerning']) {
    if (input[flag] !== undefined) props[flag] = !!input[flag];
    else if (defaults[flag] !== undefined) props[flag] = !!defaults[flag];
  }

  // fontSize — input in points, rhwp expects HWP units (×100). Defaults
  // arrive already in HWP units (HEADING_DEFAULTS path).
  if (input.fontSize != null) props.fontSize = Math.round(input.fontSize * 100);
  else if (defaults.fontSize != null) props.fontSize = defaults.fontSize;

  // textColor — managed (always emit). User-facing `color` or `textColor`.
  const textColor = input.color ?? input.textColor ?? defaults.color ?? defaults.textColor;
  props.textColor = textColor ? normalizeHexColor(textColor) : MANAGED_NEUTRAL.textColor;

  // highlight — managed (always emit). Input "#RRGGBB" or `true` (=yellow)
  // or `false` (=clear). rhwp prop is `shadeColor`.
  const highlight = input.highlight ?? defaults.highlight;
  if (highlight === undefined || highlight === false) {
    props.shadeColor = MANAGED_NEUTRAL.shadeColor;
  } else if (highlight === true) {
    props.shadeColor = "#ffff00";
  } else {
    props.shadeColor = normalizeHexColor(highlight);
  }

  // Underline detail — color / position / shape. Underline must be true
  // for these to render.
  const underlineColor = input.underline_color ?? input.underlineColor;
  if (underlineColor) props.underlineColor = normalizeHexColor(underlineColor);
  if (input.underline_type ?? input.underlineType) props.underlineType = input.underline_type ?? input.underlineType;
  if (input.underline_shape != null) props.underlineShape = input.underline_shape;
  else if (input.underlineShape != null) props.underlineShape = input.underlineShape;

  // Strikethrough detail — color / shape.
  const strikeColor = input.strikethrough_color ?? input.strikeColor;
  if (strikeColor) props.strikeColor = normalizeHexColor(strikeColor);
  if (input.strike_shape != null) props.strikeShape = input.strike_shape;
  else if (input.strikeShape != null) props.strikeShape = input.strikeShape;

  // emphasis_dot (강조점) removed 1.5.x — Hancom Docs (web/cloud) silently
  // drops it on render even though the CharShape write round-trips through
  // Hancom Office Desktop. No reliable visual path through 한컴독스, so the
  // prop is no longer mapped. Callers that still pass `emphasis_dot` /
  // `emphasisDot` see it silently ignored.

  // fontFamily — rhwp's CharShape stores font references as IDs into a
  // FACE_NAME table in DocInfo (DocInfo HWPTAG_FACE_NAME records).
  // Passing fontFamilies as NAMES is silently ignored — the lookup
  // falls back to the default "함초롬바탕" because new names aren't
  // auto-registered. The correct field is `fontIds` (array of 7 u16
  // IDs). Caller (writeRunsAt / apply_text_style handler) is responsible
  // for resolving font_family → fontIds via doc.findOrCreateFontId()
  // BEFORE calling this builder, and passing `fontIds` directly. The
  // legacy `fontFamilies` name input is preserved here for back-compat
  // but won't actually change the font.
  if (Array.isArray(input.fontIds)) props.fontIds = input.fontIds;
  if (Array.isArray(input.fontFamilies)) props.fontFamilies = input.fontFamilies;

  // letterSpacing — broadcast scalar to all 7 slots. rhwp prop is
  // `spacings`. Units: 1/100 em (HWP convention).
  const letterSpacing = input.letter_spacing ?? input.letterSpacing;
  if (Array.isArray(input.spacings)) props.spacings = input.spacings;
  else if (letterSpacing != null) props.spacings = Array(7).fill(letterSpacing);

  // charRatio — broadcast scalar to all 7 slots. rhwp prop is `ratios`.
  // Percent (100 = default width).
  const charRatio = input.char_ratio ?? input.charRatio;
  if (Array.isArray(input.ratios)) props.ratios = input.ratios;
  else if (charRatio != null) props.ratios = Array(7).fill(charRatio);

  return props;
}

// Resolve a font_family name → broadcast fontIds[7]. Registers the
// font in DocInfo's FACE_NAME table if not already there (rhwp's
// findOrCreateFontId handles dedup). Returns the same input shape but
// with `fontIds` populated and `font_family` removed so downstream
// builders don't try the silent-fallback name path.
function resolveFontFamily(doc, input) {
  if (!input) return input;
  const name = input.font_family ?? input.fontFamily;
  if (!name) return input;
  const id = doc.findOrCreateFontId(String(name));
  if (id < 0) return input;
  const out = { ...input, fontIds: Array(7).fill(id) };
  delete out.font_family;
  delete out.fontFamily;
  return out;
}

function normalizeHexColor(c) {
  if (typeof c !== 'string') return c;
  const s = c.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return c;
  return `#${s.toLowerCase()}`;
}

function writeRunsAt(doc, cursor, runs, defaults = {}) {
  // ALWAYS apply char format to every run via buildCharFormatProps so
  // every managed flag (bold/italic/underline/strikethrough/super/sub/
  // textColor/shadeColor) is explicitly reset to its neutral value
  // when not requested — kills leakage from rhwp's splitParagraph,
  // which copies the prior paragraph's last CharShape onto the new
  // empty cursor.
  //
  // `defaults` carries per-op intent (e.g. heading wants
  // {fontSize, bold, color}). Per-run flags override defaults; the
  // builder handles the merge.
  //
  // fontSize convention:
  //   - per-run input (run.fontSize): POINTS — multiplied ×100 inside
  //   - defaults (HEADING_DEFAULTS path): already HWP UNITS
  //   - if neither set: fallback to 1000 HU (=10pt body)
  const baseFontSize = defaults.fontSize ?? 1000;
  let off = cursor.charOffset;
  // Resolve any font_family on defaults once — defaults rarely change
  // across runs, and registering the same font twice is a no-op via
  // findOrCreateFontId's dedup.
  const resolvedDefaults = resolveFontFamily(doc, defaults);
  for (const run of runs) {
    if (!run.text) continue;
    unwrap(
      doc.insertText(cursor.sec, cursor.para, off, run.text),
      "insertText",
    );
    // Resolve per-run font_family (may differ from defaults) before
    // handing to the prop builder.
    const resolvedRun = resolveFontFamily(doc, run);
    const props = buildCharFormatProps(resolvedRun, resolvedDefaults);
    if (props.fontSize == null) props.fontSize = baseFontSize;
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
    // NOTE: do NOT pass fillType / fillColor / border* here. rhwp's
    // applyParaFormat serializes any fill or border touch as a NEW
    // BorderFill record in DocInfo, AND its generated BorderFill has
    // borderTop/Bottom/Left = type:1 (solid) width:0. Hancom Docs
    // renders type:1 width:0 as a 1px line, so every paragraph that
    // referenced that BorderFill gets thin horizontal stripes (the
    // visual issue verified 2026-05-26). Leave default paragraphs
    // pointing at the original blank-template BorderFill (clean,
    // no-border, white-fill) by not touching fill/border fields at
    // all. Side effect: apply_paragraph_style {background_color: ...}
    // on paragraph N can bleed into a freshly appended N+1 via
    // splitParagraph's paraShape copy — accept that as a smaller
    // issue than stripes-on-every-paragraph; the user can always
    // re-apply default fill on the next paragraph if it matters.
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
    //
    // Convention (mirrors rhwp-studio's PageSetupDialog): PageDef.width
    // and PageDef.height ALWAYS store the portrait-oriented dimensions
    // (width < height for normal paper sizes). The `landscape` boolean
    // is the only thing that tells the renderer to rotate. Earlier code
    // swapped width/height when landscape was selected — that produced
    // the wrong layout in Hancom Docs (page rendered portrait even with
    // the landscape bit set).
    const pd = JSON.parse(doc.getPageDef(cursor.sec));
    if (op.orientation) {
      pd.landscape = String(op.orientation).toLowerCase() === "landscape";
    }
    if (op.page_size) {
      // HWPUNIT (1/7200 inch). Values match rhwp-studio's PAPER_DEFAULTS
      // (which mirrors Hancom coreEngine.js IDS_PAPER_*) — the exact
      // integer rhwp's setPageDef expects.
      const SIZES = {
        a4: [59527, 84188],    // 210 × 297 mm
        a5: [42040, 59527],    // 148 × 210 mm
        a3: [84188, 119055],   // 297 × 420 mm
        b4: [72852, 103180],   // 257 × 364 mm
        b5: [51591, 72852],    // 182 × 257 mm
        letter: [61560, 79200], // 8.5 × 11 in
        legal: [61560, 100800], // 8.5 × 14 in
      };
      const sz = SIZES[String(op.page_size).toLowerCase()];
      if (sz) {
        // Always store portrait orientation; landscape flag handles rotation.
        pd.width = sz[0];
        pd.height = sz[1];
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
    // op.runs (structured, per-run styling like {text, bold, color, highlight, ...})
    // wins over op.text (markdown-parsed only — **bold** / *italic*). Previously
    // this was `parseInlineRuns(op.text ?? op.runs ?? "")` which silently
    // dropped op.runs when op.text was non-empty (which it almost always is),
    // making every from-scratch character styling (highlight / underline /
    // strikethrough / superscript / etc.) silently no-op. Cold-start session
    // 2026-05-28 caught this: agents that correctly passed runs per SKILL.md
    // ended up with attr=0x00000000 CharShapes (no styling) on every paragraph.
    const runs = Array.isArray(op.runs) && op.runs.length > 0
      ? op.runs
      : parseInlineRuns(op.text ?? "");
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
    // Same precedence as append_paragraph: structured op.runs wins over markdown op.text.
    const runs = Array.isArray(op.runs) && op.runs.length > 0
      ? op.runs
      : parseInlineRuns(op.text || "");
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

  // ── Styling ops (rhwp-driven path) ────────────────────────────────────
  //
  // apply_text_style / apply_paragraph_style mirror the .hwpx editor's op
  // names so a cold-started Claude calls the same vocabulary regardless of
  // input format. These run through rhwp's WASM applyCharFormat /
  // applyParaFormat, which means they're stuck behind rhwp's exportHwp
  // round-trip behavior:
  //   - building a new document from scratch ✓ Hancom-Docs compatible
  //   - in-place edits on small single-page .hwp files ✓
  //   - in-place edits on large multi-page .hwp files (50+ pages) ✗
  //     (rhwp's serializer can't round-trip large existing files through
  //     Hancom Docs). The large-file path lives in cell-patch.js
  //     applyTextStyleInPlace and applyParagraphStyleInPlace, which the
  //     RAW_PATCH_OPS dispatcher below routes to first.

  apply_text_style(doc, op, cursor) {
    if (typeof op.target !== "string" || op.target.length === 0) {
      throw new Error("apply_text_style: 'target' is required");
    }
    // Build the rhwp CharShape JSON from the op's style props. We treat
    // the op itself as the input — every styling key (bold, italic,
    // underline, strikethrough, color, highlight, size, font_family,
    // ...) is read off it. `size` is points (matches hwpx-edit) and
    // maps to fontSize internally.
    const styleInput = { ...op };
    delete styleInput.type;
    delete styleInput.target;
    if (op.size != null && op.fontSize == null) styleInput.fontSize = op.size;
    // Resolve font_family → fontIds via rhwp's font registry. See
    // resolveFontFamily and buildCharFormatProps for why this is
    // necessary (rhwp ignores name-based font lookup in applyCharFormat).
    const resolvedInput = resolveFontFamily(doc, styleInput);
    const props = buildCharFormatPropsForApply(resolvedInput);
    if (Object.keys(props).length === 0) {
      throw new Error("apply_text_style: at least one style prop is required (bold/italic/underline/strikethrough/color/highlight/size/font_family/...)");
    }

    // Find the target in top-level body paragraphs (cells excluded —
    // mirrors hwpx-edit's behavior where apply_text_style searches
    // <hp:t> nodes outside table subLists in the simple form).
    const hit = findFirstTextInBody(doc, op.target);
    if (!hit) {
      throw new Error(`apply_text_style: target "${truncForLog(op.target)}" not found in body text`);
    }
    doc.applyCharFormat(hit.sec, hit.para, hit.start, hit.end, JSON.stringify(props));
    log.push(
      `apply_text_style "${truncForLog(op.target)}" @ sec=${hit.sec} para=${hit.para} range=[${hit.start},${hit.end}) ` +
      `props=${Object.keys(props).join(",")}`
    );
  },

  apply_paragraph_style(doc, op, cursor) {
    if (op.index == null && op.paragraph == null) {
      throw new Error("apply_paragraph_style: 'index' (paragraph index, 0-based) is required (use \"last\" or -1 to target the most recently appended paragraph)");
    }
    const sec = op.section ?? 0;
    const paraCount = doc.getParagraphCount(sec);
    let idx = op.index ?? op.paragraph;
    // "last" / -1 → the most recently appended paragraph in this
    // section. Lets payloads stop counting headings/intros and just say
    // "the paragraph I just added".
    if (idx === "last" || idx === -1) {
      idx = paraCount - 1;
    }
    if (typeof idx !== "number" || idx < 0) {
      throw new Error(`apply_paragraph_style: 'index' must be a non-negative integer (or "last" / -1); got ${JSON.stringify(op.index)}`);
    }
    if (idx >= paraCount) {
      throw new Error(`apply_paragraph_style: index ${idx} out of range (section ${sec} has ${paraCount} paragraphs)`);
    }
    const props = buildParaFormatProps(op);
    if (Object.keys(props).length === 0) {
      throw new Error("apply_paragraph_style: at least one style prop is required (align/indent/line_spacing/margin_*/spacing_*/background_color/...)");
    }
    doc.applyParaFormat(sec, idx, JSON.stringify(props));
    log.push(
      `apply_paragraph_style sec=${sec} para=${idx} props=${Object.keys(props).join(",")}`
    );

    // Mirror Hancom Office's "문단 모양 + 글자 모양" combo behavior: when
    // a paragraph background_color is set, Hancom expects the same color
    // to also live on each character's shadeColor inside that paragraph
    // (otherwise the page-margin's row grid and other Hancom-internal
    // visuals can show through the per-character cells). User-verified
    // 2026-05-26: setting both 문단/글자 모양 to the same gray is the
    // canonical way to get a "uniform tinted paragraph". We auto-apply
    // the character shadeColor across the whole paragraph here so callers
    // don't need a separate apply_text_style call. Opt out by passing
    // `char_bg: false`.
    const bg = op.background_color ?? op.backgroundColor ?? op.fillColor;
    const charBgEnabled = op.char_bg !== false && op.charBg !== false;
    if (bg && bg !== false && charBgEnabled) {
      const shadeColor = bg === true ? "#ffff00" : normalizeHexColor(bg);
      const len = doc.getParagraphLength(sec, idx);
      if (len > 0) {
        doc.applyCharFormat(sec, idx, 0, len, JSON.stringify({ shadeColor }));
        log.push(`apply_paragraph_style → auto char shadeColor=${shadeColor} on para ${idx} (${len} chars)`);
      }
    }
  },
};

// ── Styling-op helpers ──────────────────────────────────────────────────
//
// buildCharFormatPropsForApply is a variant of buildCharFormatProps used by
// apply_text_style. The difference from writeRunsAt's path: we DON'T emit
// neutral defaults for unrequested managed flags, because the user is
// patching an existing CharShape — they want bold ON, not bold OFF (which
// would clobber the existing italic). Only props the caller explicitly
// specifies survive.
function buildCharFormatPropsForApply(input) {
  const props = {};

  // Booleans — only emit when caller specified (so partial styling
  // overlays cleanly on existing CharShape).
  for (const flag of ['bold', 'italic', 'underline', 'strikethrough',
                       'superscript', 'subscript',
                       'emboss', 'engrave', 'kerning']) {
    if (input[flag] !== undefined) props[flag] = !!input[flag];
  }

  if (input.fontSize != null) props.fontSize = Math.round(input.fontSize * 100);

  const textColor = input.color ?? input.textColor;
  if (textColor) props.textColor = normalizeHexColor(textColor);

  if (input.highlight !== undefined) {
    if (input.highlight === false) props.shadeColor = "#ffffff";
    else if (input.highlight === true) props.shadeColor = "#ffff00";
    else props.shadeColor = normalizeHexColor(input.highlight);
  }

  const underlineColor = input.underline_color ?? input.underlineColor;
  if (underlineColor) props.underlineColor = normalizeHexColor(underlineColor);
  if (input.underline_type ?? input.underlineType) props.underlineType = input.underline_type ?? input.underlineType;
  if (input.underline_shape != null) props.underlineShape = input.underline_shape;
  else if (input.underlineShape != null) props.underlineShape = input.underlineShape;

  const strikeColor = input.strikethrough_color ?? input.strikeColor;
  if (strikeColor) props.strikeColor = normalizeHexColor(strikeColor);
  if (input.strike_shape != null) props.strikeShape = input.strike_shape;
  else if (input.strikeShape != null) props.strikeShape = input.strikeShape;

  // emphasis_dot removed 1.5.x — Hancom Docs silently drops it. See
  // buildCharFormatProps for the rationale; same handling here (silently
  // ignore any incoming emphasis_dot / emphasisDot).

  // font_family is resolved to fontIds upstream via resolveFontFamily.
  // See buildCharFormatProps for the rationale.
  if (Array.isArray(input.fontIds)) props.fontIds = input.fontIds;
  if (Array.isArray(input.fontFamilies)) props.fontFamilies = input.fontFamilies;

  const letterSpacing = input.letter_spacing ?? input.letterSpacing;
  if (Array.isArray(input.spacings)) props.spacings = input.spacings;
  else if (letterSpacing != null) props.spacings = Array(7).fill(letterSpacing);

  const charRatio = input.char_ratio ?? input.charRatio;
  if (Array.isArray(input.ratios)) props.ratios = input.ratios;
  else if (charRatio != null) props.ratios = Array(7).fill(charRatio);

  return props;
}

function buildParaFormatProps(input) {
  const props = {};
  if (input.align != null) {
    const a = String(input.align).toLowerCase();
    const map = { left: "left", center: "center", right: "right", justify: "justify", justified: "justify", distribute: "distribute" };
    if (map[a]) props.alignment = map[a];
  }
  if (input.line_spacing != null) {
    props.lineSpacing = input.line_spacing;
    props.lineSpacingType = "Percent";
  } else if (input.lineSpacing != null) {
    props.lineSpacing = input.lineSpacing;
    props.lineSpacingType = "Percent";
  }
  for (const [opKey, rhwpKey] of [
    ['indent', 'indent'],
    ['margin_left', 'marginLeft'], ['marginLeft', 'marginLeft'],
    ['margin_right', 'marginRight'], ['marginRight', 'marginRight'],
    ['spacing_before', 'spacingBefore'], ['spacingBefore', 'spacingBefore'],
    ['spacing_after', 'spacingAfter'], ['spacingAfter', 'spacingAfter'],
  ]) {
    if (input[opKey] != null) props[rhwpKey] = input[opKey];
  }
  for (const flag of ['pageBreakBefore', 'page_break_before', 'keepWithNext', 'keep_with_next', 'keepLines', 'keep_lines', 'widowOrphan', 'widow_orphan']) {
    if (input[flag] !== undefined) {
      const camel = flag.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      props[camel] = !!input[flag];
    }
  }

  // Borders. rhwp's applyParaFormat has a quirk: passing fillType:"solid"
  // implicitly flips all four borders from type=0 (none) to type=1 (solid,
  // width=0). Hancom Docs then renders those as thin lines around the
  // paragraph — the "찌부" / boxed-in look. To kill it, we always emit
  // explicit ZERO borders when the caller didn't request any. Callers can
  // override per-side via border_top_pt / border_bottom_pt / etc.
  const mkBorder = (pt, color) => ({
    type: 1,
    width: Math.max(1, Math.round(pt * 8)),
    color: color || "#000000",
  });
  const borderColor = input.border_color;
  const sides = [
    ['border_top_pt', 'borderTop'],
    ['border_bottom_pt', 'borderBottom'],
    ['border_left_pt', 'borderLeft'],
    ['border_right_pt', 'borderRight'],
  ];
  let anyBorderRequested = false;
  for (const [opKey, rhwpKey] of sides) {
    if (input[opKey] !== undefined) {
      props[rhwpKey] = mkBorder(input[opKey], borderColor);
      anyBorderRequested = true;
    }
  }
  // Fill — paragraph background. Always emit fillType + fillColor +
  // patternType:-1 so EVERY apply_paragraph_style call resets the bg
  // back to neutral; this kills the splitParagraph bleed where Para N
  // with background_color=#cccccc would leak the gray fill into a
  // freshly-appended Para N+1 (verified 2026-05-26).
  //
  // patternType:-1 is critical. rhwp's applyParaFormat with just
  // {fillType:"solid", fillColor} resets patternType to 0 (HWP spec:
  // 0 = horizontal stripes overlay), which Hancom Docs renders as
  // thin stripes drawn over the solid fill. Forcing patternType:-1
  // (no pattern) makes the solid fill render alone. patternColor is
  // irrelevant when patternType=-1, but we mirror rhwp's blank-template
  // default (#999999) so the BorderFill record matches the pristine
  // structure.
  const bg = input.background_color ?? input.backgroundColor ?? input.fillColor;
  props.fillType = "solid";
  props.fillColor = (bg && bg !== false) ? normalizeHexColor(bg) : "#ffffff";
  props.patternType = -1;
  props.patternColor = "#999999";
  // Force the un-requested sides to ZERO. Since fill is now ALWAYS
  // emitted (above), rhwp will create a new BorderFill record on every
  // applyParaFormat call — and without explicit borders, rhwp's
  // serializer defaults them to type:1 (solid) width:0, which Hancom
  // Docs renders as a 1px frame around the paragraph. Explicit zeros
  // here prevent that.
  for (const [, rhwpKey] of sides) {
    if (!(rhwpKey in props)) props[rhwpKey] = { type: 0, width: 0, color: "#000000" };
  }
  return props;
}

// Walk top-level body paragraphs (skips table cells, header/footer,
// footnotes — those need their own scoping). Returns { sec, para, start,
// end } for the first paragraph containing `target`. Char offsets are
// rhwp character units (1 surrogate pair = 1 unit for CJK; matches
// applyCharFormat's coordinate system).
function findFirstTextInBody(doc, target) {
  const secCount = doc.getSectionCount();
  for (let s = 0; s < secCount; s++) {
    const paraCount = doc.getParagraphCount(s);
    for (let p = 0; p < paraCount; p++) {
      const len = doc.getParagraphLength(s, p);
      if (len === 0) continue;
      const text = doc.getTextRange(s, p, 0, len);
      const idx = text.indexOf(target);
      if (idx >= 0) {
        return { sec: s, para: p, start: idx, end: idx + target.length };
      }
    }
  }
  return null;
}

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

// ── Raw-patch helper ──────────────────────────────────────────────────────
//
// For the Hancom Docs raw-patch fast path. Converts each op into the shape
// cell-patch.js expects: {section, para, control, row, col, text}. For
// set_cell_text we already have those. For set_cell_text_by_label we open
// rhwp briefly to find the anchor cell, then compute the target (row, col).
async function resolveLabelEditsViaRhwp(filePath, ops) {
  // Lazy-init rhwp once. We already loaded the WASM at module init.
  if (typeof globalThis.measureTextWidth !== 'function') {
    globalThis.measureTextWidth = (font, text) =>
      text.length * (parseFloat(font) || 10) * 0.55;
  }
  const needsLabel = ops.some((o) => o.type === 'set_cell_text_by_label');
  let doc = null;
  if (needsLabel) {
    doc = new HwpDocument(new Uint8Array(fs.readFileSync(filePath)));
  }
  try {
    const out = [];
    for (const op of ops) {
      if (op.type === 'set_cell_text') {
        const sec = requireInt(op, 'section');
        const para = requireInt(op, 'para');
        const ctrl = requireInt(op, 'control');
        const text = op.text ?? '';
        if (op.row != null && op.col != null) {
          out.push({ section: sec, para, control: ctrl, row: op.row, col: op.col, text });
        } else if (op.cell != null) {
          // Convert flat cellIndex back to (row, col) via rhwp inspect.
          if (!doc) doc = new HwpDocument(new Uint8Array(fs.readFileSync(filePath)));
          const info = JSON.parse(doc.getCellInfo(sec, para, ctrl, op.cell));
          out.push({ section: sec, para, control: ctrl, row: info.row, col: info.col, text });
        } else {
          throw new Error("set_cell_text: provide row+col or cell");
        }
        continue;
      }
      // set_cell_text_by_label — sweep tables, find the anchor, apply offset.
      if (typeof op.label !== 'string' || op.label.length === 0) {
        throw new Error("set_cell_text_by_label: 'label' is required");
      }
      const rowOff = op.row_offset ?? 0;
      const colOff = op.col_offset ?? 0;
      const occurrence = op.occurrence ?? 0;
      const caseSensitive = !!op.case_sensitive;
      const text = op.text ?? '';

      const scoped = (op.section != null || op.para != null || op.control != null);
      const candidates = scoped
        ? [{ sec: requireInt(op, 'section'), para: requireInt(op, 'para'), ctrl: requireInt(op, 'control') }]
        : enumerateTables(doc);

      const hits = [];
      for (const { sec, para, ctrl } of candidates) {
        const grid = describeTable(doc, sec, para, ctrl);
        if (!grid) continue;
        for (const cell of grid.cells) {
          const txt = caseSensitive ? cell.text : cell.text.toLowerCase();
          const needle = caseSensitive ? op.label : op.label.toLowerCase();
          if (txt.includes(needle)) hits.push({ sec, para, ctrl, cell });
        }
      }
      if (hits.length === 0) throw new Error(`set_cell_text_by_label: no cell containing "${op.label}" found`);
      if (occurrence >= hits.length) throw new Error(`set_cell_text_by_label: occurrence ${occurrence} out of range (${hits.length} hits)`);
      const hit = hits[occurrence];
      out.push({
        section: hit.sec, para: hit.para, control: hit.ctrl,
        row: hit.cell.row + rowOff, col: hit.cell.col + colOff, text,
      });
    }
    return out;
  } finally {
    if (doc) { try { doc.free(); } catch { /* ignore */ } }
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

// Patch hwpx with Hancom-round-trip "fingerprint" so 한컴 docs web treats it
// as Hancom-native and preserves list rendering. Without this, Hancom Docs
// web silently strips any <hh:heading type="BULLET|NUMBER"> we emit — even
// when our paraPr inner is byte-level identical to a Hancom-authored one.
// Sources for the injected bits: a v7_debug stub that was round-tripped
// through Hancom Docs (see scripts/templates/hancom_native_stub.hwpx).
//
// The patches applied:
//   1. content.hpf: add xmlns:hwpunitchar (referenced by <hp:switch>), and
//      Scripts/headerScripts + sourceScripts manifest+spine entries.
//   2. header.xml <hh:head>: add xmlns:hwpunitchar, bump version 1.2 → 1.5
//      (Hancom-native fingerprint).
//   3. header.xml: append Hancom-native BULLET + NUMBER paraPrs (renumbered
//      to avoid id collisions) + bullets[1]="▶" + numberings[1] korean
//      (if missing). hwpx-edit.js's reuseExistingListParaPr will then find
//      and reuse these for set_bullet_list / set_numbered_list ops.
//   4. Copy Scripts/headerScripts + Scripts/sourceScripts verbatim from stub.
//
// Caveat (2026-05-29): empirically these patches alone may NOT be enough —
// v22_stub verification showed Hancom still strips our list headings even
// after injecting paraPrs + namespace + Scripts. The full fix likely
// requires settings.xml + version.xml + other metadata to match a Hancom-
// round-tripped file. Keep this as best-effort; the BULLET text-prefix
// fallback in hwpx-edit.js's opSetParagraphList covers the remaining gap.
async function patchHwpxStubFingerprint(filePath) {
  const stubPath = path.join(__dirname, "templates", "hancom_native_stub.hwpx");
  if (!fs.existsSync(stubPath)) return { patched: false, reason: "stub missing" };

  const out = await JSZip.loadAsync(fs.readFileSync(filePath));
  const stub = await JSZip.loadAsync(fs.readFileSync(stubPath));

  // ── 1. Copy Scripts/ from stub ──────────────────────────────────────────
  for (const name of Object.keys(stub.files)) {
    if (name.startsWith("Scripts/") && !out.file(name)) {
      const data = await stub.file(name).async("uint8array");
      out.file(name, data);
    }
  }

  // ── 2. Patch content.hpf — namespace + Scripts manifest entries ─────────
  const hpfEntry = out.file("Contents/content.hpf");
  if (hpfEntry) {
    let hpf = await hpfEntry.async("string");
    if (!/xmlns:hwpunitchar=/.test(hpf)) {
      hpf = hpf.replace(
        /(xmlns:ooxmlchart="[^"]+")(\s+xmlns:epub=)/,
        '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"$2'
      );
    }
    if (!/headersc/.test(hpf)) {
      hpf = hpf.replace(
        /(<opf:item id="section0"[^>]*\/>)(\s*<opf:item id="settings")/,
        '$1<opf:item id="headersc" href="Scripts/headerScripts" media-type="application/x-javascript ;charset=utf-16"/><opf:item id="sourcesc" href="Scripts/sourceScripts" media-type="application/x-javascript ;charset=utf-16"/>$2'
      );
      hpf = hpf.replace(
        /(<opf:itemref idref="section0")\/>(\s*<\/opf:spine>)/,
        '$1 linear="yes"/><opf:itemref idref="headersc" linear="yes"/><opf:itemref idref="sourcesc" linear="yes"/>$2'
      );
      hpf = hpf.replace(/<opf:itemref idref="header"\/>/, '<opf:itemref idref="header" linear="yes"/>');
    }
    out.file("Contents/content.hpf", hpf);
  }

  // ── 3. Patch header.xml — namespace + version + Hancom-native list bits ─
  const headerEntry = out.file("Contents/header.xml");
  if (!headerEntry) return { patched: true, paraPrInjected: false };
  let header = await headerEntry.async("string");

  // Namespace on <hh:head>
  if (!/<hh:head[^>]*xmlns:hwpunitchar=/.test(header)) {
    header = header.replace(
      /(<hh:head[^>]*?xmlns:ooxmlchart="[^"]+")/,
      '$1 xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"'
    );
  }
  // Version bump
  header = header.replace(/(<hh:head[^>]*?)version="1\.2"/, '$1version="1.5"');

  // Pull Hancom-native paraPr/bullets/numbering snippets from stub
  const stubHeader = await stub.file("Contents/header.xml").async("string");
  const stubBulletParaPr = (stubHeader.match(/<hh:paraPr id="2"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  const stubNumberParaPr = (stubHeader.match(/<hh:paraPr id="3"[^>]*>[\s\S]*?<\/hh:paraPr>/) || [])[0];
  const stubBullets = (stubHeader.match(/<hh:bullets\b[^>]*>[\s\S]*?<\/hh:bullets>/) || [])[0];
  const stubNumberings = (stubHeader.match(/<hh:numbering id="1"[^>]*>[\s\S]*?<\/hh:numbering>/) || [])[0];

  // Renumber paraPrs to avoid id conflicts with rhwp's existing ones
  const existingIds = [...header.matchAll(/<hh:paraPr\s+id="(\d+)"/g)].map(m => Number(m[1]));
  const maxId = existingIds.length ? Math.max(...existingIds) : 0;
  const bulletId = String(maxId + 1);
  const numberId = String(maxId + 2);

  // Check if a BULLET / NUMBER paraPr already exists (e.g. user already
  // round-tripped). Skip injection if so.
  const hasBullet = /<hh:heading\s+type="BULLET"/.test(header);
  const hasNumber = /<hh:heading\s+type="NUMBER"/.test(header);

  let injected = 0;
  if (!hasBullet && stubBulletParaPr) {
    const newBullet = stubBulletParaPr.replace(/^<hh:paraPr id="2"/, `<hh:paraPr id="${bulletId}"`);
    header = header.replace("</hh:paraProperties>", newBullet + "</hh:paraProperties>");
    injected++;
  }
  if (!hasNumber && stubNumberParaPr) {
    const newNumber = stubNumberParaPr.replace(/^<hh:paraPr id="3"/, `<hh:paraPr id="${numberId}"`);
    header = header.replace("</hh:paraProperties>", newNumber + "</hh:paraProperties>");
    injected++;
  }
  if (injected > 0) {
    header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + injected) + b);
  }

  // Inject bullets table if missing
  if (!/<hh:bullets/.test(header) && stubBullets) {
    header = header.replace("</hh:numberings>", "</hh:numberings>" + stubBullets);
  }

  // If numberings[1] exists but is a placeholder (no paraHead text content), replace it
  if (stubNumberings) {
    const cur1 = header.match(/<hh:numbering id="1"[^>]*>[\s\S]*?<\/hh:numbering>/);
    if (cur1 && !/<hh:paraHead\b[^/]*>[^<]+<\/hh:paraHead>/.test(cur1[0])) {
      header = header.replace(cur1[0], stubNumberings);
    }
  }

  out.file("Contents/header.xml", header);

  const newBytes = await out.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(filePath, newBytes);
  return { patched: true, paraPrInjected: injected, bulletId, numberId };
}

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
    // TEMP DISABLED for hypothesis test — CFB.write injects sheetjs Sh33tJ5
    // marker which Hancom Docs rejects. If skipping strip produces a
    // Hancom-Docs-compatible file, we replace this branch with a raw-patch
    // (in-place Section byte modify) instead of full CFB rewrite.
    // const out = CFB.write(cfb, { type: "buffer" });
    // fs.writeFileSync(filePath, out);
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

  // ── Hancom Docs raw-patch fast path ─────────────────────────────────────
  //
  // rhwp.exportHwp() produces .hwp output that Hancom Office Desktop accepts
  // but Hancom Docs (cloud) rejects with "문서를 열 수 없습니다." — the
  // CFB layout it emits (a Sh33tJ5 fingerprint stream, reordered directory
  // entries) trips Hancom Docs' strict parser. To stay compatible with the
  // cloud, payloads that ONLY edit table cells of an existing .hwp skip
  // rhwp.exportHwp() entirely and instead patch the original Section bytes
  // surgically (see cell-patch.js).
  //
  // Eligibility:
  //   - target file already exists (we need an authentic CFB to patch)
  //   - extension is .hwp (raw-patch covers HWP 5.0 binary; hwpx goes
  //     through the unpack/edit/pack flow elsewhere)
  //   - every op is set_cell_text or set_cell_text_by_label
  // Mixed payloads (set_cell_text* alongside append_*, replace_text, etc.)
  // are NOT eligible — they fall through to the normal rhwp path and the
  // result is Hancom-Office-only. We surface that with a log line so the
  // caller knows their output may not open in Hancom Docs.
  // Op types eligible for the raw-patch fast path. Cell ops have been here
  // since 1.4.0; replace_text was added in the v1.5 line (equal-length only
  // for the first cut — see cell-patch.js / replaceTextInPlace).
  const CELL_OPS = new Set(['set_cell_text', 'set_cell_text_by_label']);
  const REPLACE_TEXT_OPS = new Set(['replace_text']);
  const APPEND_TABLE_OPS = new Set(['append_table']);
  const SETUP_DOC_OPS = new Set(['setup_document']);
  const APPEND_IMAGE_OPS = new Set(['append_image']);
  // Text styling via raw-patch — applies CharShape edits at the byte
  // level on top of an existing .hwp without round-tripping through
  // rhwp's serializer. Required for large multi-page files (50+ pages)
  // where the rhwp-driven path can't reproduce a Hancom-Docs-compatible
  // output. See cell-patch.js applyTextStyleInPlace for the CharShape
  // body, HWPTAG_ID_MAPPINGS counter bumps, and PARA_CHAR_SHAPE handling.
  const APPLY_TEXT_STYLE_OPS = new Set(['apply_text_style']);
  // Paragraph styling via raw-patch. Same overall flow as
  // apply_text_style but operates on PARA_SHAPE rather than CHAR_SHAPE,
  // and additionally appends a HWPTAG_BORDER_FILL when
  // background_color is set. See cell-patch.js applyParagraphStyleInPlace
  // for the PARA_SHAPE body, HWPTAG_ID_MAPPINGS counter bumps, and
  // PARA_HEADER paraShapeId handling.
  const APPLY_PARAGRAPH_STYLE_OPS = new Set(['apply_paragraph_style']);
  // All paragraph-shaped append ops route through appendParagraphInPlace.
  // Some carry a break_val (page/column break); the rest just add text.
  //   append_paragraph                    → break_val 0
  //   append_heading                      → break_val 0 (no styling — see SKILL.md limitation)
  //   append_bullet_list                  → break_val 0 (no marker — see SKILL.md limitation)
  //   append_numbered_list                → break_val 0 (no marker — see SKILL.md limitation)
  //   append_page_break                   → break_val 0x04 (empty paragraph)
  //   insert_column_break                 → break_val 0x08 (empty paragraph)
  //   setup_columns                       → break_val 0x02 (multi-column / empty paragraph)
  // append_heading / append_*_list run as plain paragraphs in raw-patch:
  // raw-patch can't synthesize new char-shape entries in DocInfo, so
  // visual styling (font size, bold, list markers) doesn't change. The
  // text shows up in the right position; users wanting visual headings
  // pre-design the form with heading paragraphs and use replace_text.
  const APPEND_PARA_OPS = new Set([
    'append_paragraph',
    'append_heading',
    'append_bullet_list',
    'append_numbered_list',
    'append_page_break',
    'insert_column_break',
    'setup_columns',
  ]);
  // APPEND_IMAGE_OPS removed from RAW_PATCH_OPS — image add goes through
  // the standard rhwp emit path (Hop-equivalent: doc.fromBytes →
  // insertPicture → exportHwp). Our raw-patch image-cluster synthesis
  // matches Hop's bytes 99% but fails Hancom Docs's render check due to
  // an as-yet-unidentified cascading DocInfo reference. Going through
  // rhwp's emit produces the exact bytes Hop produces.
  const RAW_PATCH_OPS = new Set([...CELL_OPS, ...REPLACE_TEXT_OPS, ...APPEND_PARA_OPS, ...APPEND_TABLE_OPS, ...SETUP_DOC_OPS, ...APPLY_TEXT_STYLE_OPS, ...APPLY_PARAGRAPH_STYLE_OPS]);
  // TEMP HYPOTHESIS TEST: force rhwp emit path to check whether sheetjs
  // CFB.write was the only Hancom-Docs reject cause. If FORCE_RHWP_EMIT=1
  // is set, bypass raw-patch and run everything through HANDLERS + exportHwp.
  const forceRhwpEmit = process.env.FORCE_RHWP_EMIT === '1';
  const allRawPatch = !forceRhwpEmit && ops.length > 0 && ops.every((o) => RAW_PATCH_OPS.has(o.type));
  if (ext === '.hwp' && fs.existsSync(outPath) && allRawPatch) {
    try {
      const cellOps = ops.filter((o) => CELL_OPS.has(o.type));
      const replaceOps = ops.filter((o) => REPLACE_TEXT_OPS.has(o.type));
      const appendOps = ops.filter((o) => APPEND_PARA_OPS.has(o.type));
      const subModes = [];
      const allEdits = [];

      if (cellOps.length > 0) {
        const { patchCellsInPlace } = await import('./cell-patch.js');
        const resolvedEdits = await resolveLabelEditsViaRhwp(outPath, cellOps);
        const cellSummary = await patchCellsInPlace(outPath, resolvedEdits);
        subModes.push(`cells:${cellSummary.mode || 'in-place'}`);
        for (const e of cellSummary) allEdits.push({ kind: 'cell', ...e });
      }
      if (replaceOps.length > 0) {
        const { replaceTextInPlace } = await import('./cell-patch.js');
        const repSummary = await replaceTextInPlace(outPath, replaceOps);
        subModes.push(`replace:${repSummary.mode || 'in-place'}`);
        for (const e of repSummary) allEdits.push({ kind: 'replace', ...e });
      }
      const setupOps = ops.filter((o) => SETUP_DOC_OPS.has(o.type));
      if (setupOps.length > 0) {
        const { setupDocumentInPlace } = await import('./cell-patch.js');
        // Multiple setup_document ops collapse to the last one (later
        // settings override earlier ones).
        const sSummary = await setupDocumentInPlace(outPath, setupOps[setupOps.length - 1]);
        subModes.push(`setup:${sSummary.mode || 'in-place'}`);
        allEdits.push({ kind: 'setup_document', ...sSummary.applied });
      }
      const imageOps = ops.filter((o) => APPEND_IMAGE_OPS.has(o.type));
      if (imageOps.length > 0) {
        // Generate a fresh image-bearing .hwp via rhwp (createBlankDocument
        // + insertText 'x' + insertPicture + exportHwp) for each image op.
        // The synthesized cluster will:
        //   - take the entire fresh paragraph cluster (clean, correct
        //     CTRL_HEADER size / SHAPE_COMPONENT body / CTRL_DATA, valid
        //     PARA_LINE_SEG for the image height)
        //   - rewrite paraShape / charShape IDs to point at the user
        //     file's existing image paragraph (in the sample form we
        //     tested, that's paraShape index 29 on a nested paragraph
        //     within an image cell)
        const rhwp = (await import("./vendor/rhwp/rhwp.js"));
        if (!globalThis.__rhwp_loaded_for_template) {
          await rhwp.default({
            module_or_path: fs.readFileSync(
              path.resolve(path.dirname(new URL(import.meta.url).pathname), "vendor/rhwp/rhwp_bg.wasm")
            ),
          });
          if (typeof globalThis.measureTextWidth !== "function") {
            globalThis.measureTextWidth = (font, text) =>
              text.length * (parseFloat(font) || 10) * 0.55;
          }
          globalThis.__rhwp_loaded_for_template = true;
        }
        const opsWithTemplate = [];
        for (const op of imageOps) {
          const imgPath = path.resolve(op.path);
          if (!fs.existsSync(imgPath)) throw new Error(`append_image: file not found: ${imgPath}`);
          const imgBytes = fs.readFileSync(imgPath);
          const ext = (path.extname(imgPath).slice(1) || "png").toLowerCase();
          const CM_TO_HWPUNIT = 2835;
          const widthCm = op.width_cm || 12;
          const heightCm = op.height_cm || widthCm * 0.66;
          const widthHwp = Math.round(widthCm * CM_TO_HWPUNIT);
          const heightHwp = Math.round(heightCm * CM_TO_HWPUNIT);
          let nativePxW = 0, nativePxH = 0;
          if (ext === "png" && imgBytes.length >= 24 && imgBytes.readUInt32BE(12) === 0x49484452) {
            nativePxW = imgBytes.readUInt32BE(16);
            nativePxH = imgBytes.readUInt32BE(20);
          }
          const naturalW = nativePxW || Math.max(1, Math.round(widthHwp / 75));
          const naturalH = nativePxH || Math.max(1, Math.round(heightHwp / 75));
          // Use the standard create.js append_image flow (the one the
          // baseline `fresh_image_100px.hwp` came from — Hancom Docs
          // verified). startNewParagraph + insertPicture produces the
          // PARA_LINE_SEG layout cache (vertSize=900, the text-default
          // height) that Hancom expects; the bare insertText+insertPicture
          // shortcut sets vertSize=imageHeight which Hancom Docs renders
          // as an empty frame.
          const freshDoc = rhwp.HwpDocument.createEmpty();
          freshDoc.createBlankDocument();
          freshDoc.beginBatch();
          // Mirror HANDLERS.append_image: splitParagraph to ensure
          // dedicated paragraph, then insertPicture at offset 0.
          // splitParagraph isn't exposed cleanly — emulate by inserting
          // a real paragraph break (insertText \r) so insertPicture
          // attaches to a fresh paragraph the same way the real handler
          // does.
          freshDoc.insertText(0, 0, 0, "x");
          freshDoc.splitParagraph?.(0, 0, 1);  // optional — only if exposed
          freshDoc.insertPicture(0, 1, 0, new Uint8Array(imgBytes), widthHwp, heightHwp, naturalW, naturalH, ext, "");
          freshDoc.endBatch();
          const templateBytes = Buffer.from(freshDoc.exportHwp());
          freshDoc.free();
          opsWithTemplate.push({ ...op, _templateBytes: templateBytes });
        }
        const { appendImageInPlace } = await import("./cell-patch.js");
        const iSummary = await appendImageInPlace(outPath, opsWithTemplate);
        subModes.push(`image:${iSummary.mode || "in-place"}`);
        for (const e of iSummary) allEdits.push({ kind: "image", ...e });
      }
      const tableOps = ops.filter((o) => APPEND_TABLE_OPS.has(o.type));
      if (tableOps.length > 0) {
        const { appendTableInPlace } = await import('./cell-patch.js');

        // When the user provides shape input (rows / cols / headers),
        // pre-generate a per-op rhwp template containing a table of the
        // requested shape. cell-patch's appendTableInPlace will splice the
        // template's table cluster (with cell borderFillIds remapped to a
        // visible BF in the target's DocInfo) instead of cloning a
        // source-form table. Without shape input, fall back to clone.
        //
        // Inferring shape:
        //   rows  = (user.rows?.length ?? 0) + (user.headers ? 1 : 0)
        //   cols  = user.headers?.length ?? user.cols ?? user.rows?.[0]?.length
        // If we can't infer both ≥1, leave _templateBytes unset → clone path.
        const tableOpsWithTemplate = [];
        let rhwpForTable = null;
        for (const op of tableOps) {
          const dataRowCount = Array.isArray(op.rows) ? op.rows.length : 0;
          const headerCount = Array.isArray(op.headers) ? op.headers.length : 0;
          const wantRows = dataRowCount + (headerCount > 0 ? 1 : 0);
          const wantCols = headerCount
            || (typeof op.cols === 'number' ? op.cols : 0)
            || (Array.isArray(op.rows) && Array.isArray(op.rows[0]) ? op.rows[0].length : 0);
          if (wantRows >= 1 && wantCols >= 1) {
            // Lazily init rhwp once
            if (!rhwpForTable) {
              rhwpForTable = await import('./vendor/rhwp/rhwp.js');
              if (!globalThis.__rhwp_loaded_for_template) {
                await rhwpForTable.default({
                  module_or_path: fs.readFileSync(
                    path.resolve(path.dirname(new URL(import.meta.url).pathname), 'vendor/rhwp/rhwp_bg.wasm')
                  ),
                });
                if (typeof globalThis.measureTextWidth !== 'function') {
                  globalThis.measureTextWidth = (font, text) =>
                    String(text || '').length * (parseFloat(font) || 10) * 0.55;
                }
                globalThis.__rhwp_loaded_for_template = true;
              }
            }
            const tmpDoc = rhwpForTable.HwpDocument.createEmpty();
            tmpDoc.createBlankDocument();
            tmpDoc.beginBatch();
            tmpDoc.createTable(0, 0, 0, wantRows, wantCols);
            tmpDoc.endBatch();
            const templateBytes = Buffer.from(tmpDoc.exportHwp());
            tmpDoc.free();
            tableOpsWithTemplate.push({ ...op, _templateBytes: templateBytes });
          } else {
            tableOpsWithTemplate.push(op);
          }
        }

        const tSummary = await appendTableInPlace(outPath, tableOpsWithTemplate);
        subModes.push(`table:${tSummary.mode || 'in-place'}`);
        for (const e of tSummary) allEdits.push({ kind: 'table', ...e });
      }
      const textStyleOps = ops.filter((o) => APPLY_TEXT_STYLE_OPS.has(o.type));
      if (textStyleOps.length > 0) {
        const { applyTextStyleInPlace } = await import('./cell-patch.js');
        const tsSummary = await applyTextStyleInPlace(outPath, textStyleOps);
        subModes.push(`text_style:${tsSummary.mode || 'in-place'}`);
        for (const e of tsSummary) allEdits.push({ kind: 'text_style', ...e });
      }
      const paraStyleOps = ops.filter((o) => APPLY_PARAGRAPH_STYLE_OPS.has(o.type));
      if (paraStyleOps.length > 0) {
        const { applyParagraphStyleInPlace } = await import('./cell-patch.js');
        const psSummary = await applyParagraphStyleInPlace(outPath, paraStyleOps);
        subModes.push(`paragraph_style:${psSummary.mode || 'in-place'}`);
        for (const e of psSummary) allEdits.push({ kind: 'paragraph_style', ...e });
      }
      if (appendOps.length > 0) {
        const { appendParagraphInPlace } = await import('./cell-patch.js');
        // Map op type to break_val (HWP PARA_HEADER body offset 11).
        // Plain paragraph / heading / list ops carry break_val 0 — the
        // dispatcher treats them all as paragraphs with text. Break-
        // family ops set their corresponding bit and have empty text
        // (the break paragraph itself is empty; user adds text via a
        // following append_paragraph).
        const BREAK_VAL = {
          'append_paragraph': 0,
          'append_heading': 0,
          'append_bullet_list': 0,
          'append_numbered_list': 0,
          'append_page_break': 0x04,
          'insert_column_break': 0x08,
          'setup_columns': 0x02,
        };
        // Expand bullet_list / numbered_list ops into N append_paragraph
        // ops (one per item), each carrying a marker prefix in its text.
        // The raw-patch path under the hood (appendParagraphInPlace) is
        // text-per-paragraph and doesn't iterate `items[]` on its own; the
        // expansion has to happen here in the dispatcher.
        //
        // Concrete marker strings:
        //   bullet_list   → "• " (BULLET, U+2022 + space). Rendered as a
        //                   plain text bullet — Hancom doesn't get a real
        //                   numbering record on this path, just a visible
        //                   marker glyph in the cell text. Same approach a
        //                   user takes when typing bullets manually.
        //   numbered_list → "1. ", "2. ", ... (decimal + period + space).
        //                   Same plain-text approach.
        // Drawback vs a real HWP numbering record: re-ordering items
        // doesn't auto-renumber; the markers are baked into the text.
        // Acceptable for the in-place raw-patch use case (LLM-driven
        // edits where the user gets visible bullets/numbers).
        const expandedAppendOps = [];
        for (const o of appendOps) {
          if ((o.type === 'append_bullet_list' || o.type === 'append_numbered_list')
              && Array.isArray(o.items) && o.items.length > 0) {
            const isNumbered = o.type === 'append_numbered_list';
            o.items.forEach((item, idx) => {
              const marker = isNumbered ? `${idx + 1}. ` : '• ';
              expandedAppendOps.push({
                type: 'append_paragraph',
                text: `${marker}${String(item)}`,
                breakVal: 0,
                _expandedFrom: o.type,
                _itemIndex: idx,
              });
            });
          } else {
            expandedAppendOps.push({
              ...o,
              text: o.text ?? '',
              breakVal: BREAK_VAL[o.type] ?? 0,
            });
          }
        }
        const appSummary = await appendParagraphInPlace(outPath, expandedAppendOps);
        subModes.push(`append:${appSummary.mode || 'in-place'}`);
        for (const e of appSummary) allEdits.push({ kind: 'append', ...e });
      }

      const subMode = subModes.join('+');

      // Collect per-edit warnings into a top-level "warnings" array. The
      // raw-patch path emits some ops that don't fully honor user input
      // (e.g. append_table clones an existing table and ignores
      // user-supplied rows/cols/headers — see appendTableInPlace). When
      // the caller is an LLM agent, surface this prominently so it can
      // tell the user instead of reporting bare "success".
      const warnings = [];
      for (const e of allEdits) {
        if (e.kind === 'table' && Array.isArray(e.user_input_ignored) && e.user_input_ignored.length > 0) {
          // Synth path keeps rows/cols honored — only flags content
          // not filled. Clone path flags rows/cols + content + headers.
          const isSynth = (e.note || '').startsWith('synthesized');
          const intro = isSynth
            ? `append_table synthesized a ${e.rows}×${e.cols} table (shape matches your request).`
            : `append_table cloned an existing table (rows=${e.rows}, cols=${e.cols}). The raw-patch path can only clone, not synthesize.`;
          warnings.push({
            op: 'append_table',
            message: `${intro} Tell the user: ${e.user_input_ignored.join('; ')}.`,
          });
        }
      }

      const response = {
        status: 'success',
        path: outPath,
        bytes_written: fs.statSync(outPath).size,
        ops_applied: allEdits.length,
        mode: 'raw-patch',
        sub_mode: subMode,
        edits: allEdits,
        log: [`raw-patch path (Hancom Docs compatible, ${subMode}) — ${allEdits.length} edit(s) applied`],
      };
      if (warnings.length > 0) response.warnings = warnings;

      process.stdout.write(JSON.stringify(response) + "\n");
      return;
    } catch (err) {
      process.stdout.write(JSON.stringify({
        status: 'error', message: `raw-patch failed: ${err.message}`,
      }) + "\n");
      process.exit(1);
    }
  }

  // ── Overwrite-existing-form guard ───────────────────────────────────────
  //
  // The single most damaging recurring failure of this skill is: agent gets
  // an existing form, extract_text returns mostly empty (because table
  // cells are invisible to that API), agent concludes "the form is empty",
  // and emits `create.js` with `setup_document` as the first op — which
  // BLOWS AWAY the original form, including its tables / header art / page
  // numbering, and writes a brand-new bare document at the same path.
  //
  // SKILL.md tries to prevent this in several places, but agents still hit
  // it in fresh sessions (snapshot races, reflex behavior, etc.). So we
  // enforce it in code. The rule: starting with `setup_document` on a path
  // that already exists is treated as "you are about to destroy an existing
  // file". We refuse unless the caller passes a top-level
  // `"allow_overwrite": true` in the payload — an explicit opt-in that
  // surfaces in the SKILL guide for the rare cases where overwriting is
  // genuinely intended.
  const firstOpType = ops[0]?.type;
  if (
    fs.existsSync(outPath) &&
    firstOpType === "setup_document" &&
    !payload.allow_overwrite
  ) {
    process.stdout.write(JSON.stringify({
      status: "error",
      message:
        `'${outPath}' already exists. Starting with 'setup_document' would overwrite the file with a brand-new blank document, destroying any form layout, tables, header art, or page numbering it contains. ` +
        `If the user asked you to FILL IN or ADD TO this form, use set_cell_text or set_cell_text_by_label ops instead (no setup_document) — see SKILL.md "Filling in an existing form". ` +
        `If you genuinely intend to overwrite the existing file with a brand-new one, re-send the same payload with "allow_overwrite": true at the top level.`,
      hint: "set_cell_text* for form-fill; allow_overwrite:true to force overwrite",
    }) + "\n");
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

  // Force PARA_LINE_SEG regeneration before serialization. applyParaFormat
  // and applyCharFormat update the paraShape / charShape records but
  // don't invalidate the cached line layout — Hancom Docs renders based
  // on PARA_LINE_SEG, so without this an apply_paragraph_style
  // {align:center} on para 8 would update paraShape but the rendered
  // line in Hancom would still show the old (justify) alignment from
  // the cached lineseg. reflowLinesegs() walks every paragraph and
  // regenerates the layout cache against the current shape state.
  try {
    const reflowed = doc.reflowLinesegs();
    if (typeof reflowed === "number" && reflowed > 0) {
      log.push(`reflowLinesegs: ${reflowed} paragraph(s) recomputed`);
    }
  } catch (err) {
    log.push(`reflowLinesegs: skipped (${err.message})`);
  }

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

  // Stamp the hwpx with a Hancom-round-trip fingerprint so 한컴 docs web
  // accepts list paragraphs. rhwp's output reads as "foreign" to Hancom and
  // any <hh:heading type="BULLET|NUMBER"> we emit gets silently stripped on
  // open. Injecting Hancom-native paraPrs + xmlns:hwpunitchar + Scripts/
  // (from scripts/templates/hancom_native_stub.hwpx) lets hwpx-edit.js's
  // reuseExistingListParaPr land on a paraPr Hancom will preserve. Best
  // effort — the BULLET text-prefix fallback in opSetParagraphList covers
  // any remaining gap.
  if (ext === ".hwpx") {
    try {
      const r = await patchHwpxStubFingerprint(outPath);
      if (r.patched) log.push(`hwpx_stub_fingerprint: paraPr injected=${r.paraPrInjected || 0}`);
    } catch (err) {
      log.push(`hwpx_stub_fingerprint failed: ${err.message}`);
    }
  }

  // Layout-cache strip removed (was Hancom-Docs-incompatible via sheetjs
  // CFB.write inside stripHwpLayoutCache). Hop's save flow does not strip
  // either — `tauri-bridge.ts:writeCurrentHwpToPath` writes
  // `super.exportHwp()` verbatim. The PARA_LINESEG / <hp:linesegarray>
  // placeholder values rhwp emits still cause our local renderer to
  // mis-place text occasionally, but that's a renderer concern not a
  // save-path one. See CLAUDE.md for the principle.

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
