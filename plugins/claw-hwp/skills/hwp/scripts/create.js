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
import { describeTable, enumerateTables } from "./cell-inspect.js";

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

// Resolved page margins (HWPUNIT) from setup_document, or null when the caller
// didn't request any. rhwp's exportHwpx ignores PageDef margins for .hwpx, so
// patchHwpxPageMargin stamps these into the section pagePr post-export.
let hwpxPageMargin = null;

// True only when setup_document requested landscape. rhwp emits
// landscape="WIDELY" for PORTRAIT docs too (the enum is not a reliable
// orientation signal), so patchHwpxLandscape must gate on this actual request —
// never on the enum — or it would flip every portrait .hwpx to landscape.
let requestedLandscape = false;

// Per-table outMargin overrides, in document (append_table) order. Each entry is
// { before, after } in HWPUNIT (or null to use the default). patchHwpxTableOutMargin
// consumes these in order so a caller can set spacing_before / spacing_after on an
// individual table. The below-table gap is outMargin.bottom; above is outMargin.top
// (Hancom renders table top/bottom ~symmetrically — it clamps an asymmetric pair).
const tableSpacingSpecs = [];

// Per-table header-row fill colour (pale tint, dark text — suits Hancom). The
// caller (LLM) may pick `header_fill` per append_table for full freedom; null →
// fall back to the theme's headerFill (derived pale tint of the heading colour).
// patchHwpxTableHeaderFill consumes the header-table entries in document order
// (rhwp drops the cell fill, so the colour has to be re-injected post-export).
const tableHeaderFills = [];

// Tracks headings emitted by append_heading. rhwp's HWPX serializer correctly
// creates the <hh:charPr> definition (large height + bold) in header.xml but
// then writes the heading run with charPrIDRef="0" (default body), so the
// heading renders at body size. We post-fix section0.xml by looking up the
// matching charPr id (height + bold) in header.xml and rewriting the run
// reference. The binary HWP path is unaffected — its PARA_CHARSHAPE record
// already references the correct shape id.
const headingPatches = [];

// Tracks body paragraphs (append_paragraph) whose run carries char styling
// (size / colour / bold / italic / underline). Same rhwp .hwpx-export quirk as
// headings: rhwp creates the <hh:charPr> in header.xml but writes the run with
// charPrIDRef="0", so create-time styling silently vanished. We re-link via a
// richer key (height:bold:italic:underline:colour). Only paragraphs whose runs
// share ONE uniform non-default style are tracked (the common "style this label"
// case); mixed multi-style runs are left to apply_text_style (edit path).
const bodyStylePatches = [];

// ── Char-style normalization (shared by uniform re-link + mixed-run re-split) ──
//
// Both post-export fixes match a run against a header <hh:charPr> by a composite
// style key. The key MUST cover every managed char attribute rhwp can emit, or a
// run carrying an un-keyed attribute (highlight / strikeout / letter-spacing /
// char-ratio) gets matched to a charPr that lacks it and the attribute is lost
// (the v1.5.33 mixed-run regression). normRunStyle (our run input) and
// charPrStyleFromXml (a header charPr) produce the SAME normalized shape so
// styleBaseKey compares them apples-to-apples. `font` is kept OUT of the base key
// and matched via the dual lookup in the patches (a run with no explicit font
// must still match a charPr that carries the document default face).
function normRunStyle(r) {
  const pt = r.fontSize ?? r.size ?? r.size_pt;
  const hl = r.highlight;
  let shade = "NONE";
  if (hl === true) shade = "#FFFF00";
  else if (typeof hl === "string" && hl.toLowerCase() !== "none") shade = normalizeHexColor(hl).toUpperCase();
  return {
    height: pt != null ? Math.round(Number(pt) * 100) : 1000,
    bold: !!r.bold, italic: !!r.italic, underline: !!r.underline,
    strike: !!(r.strikethrough ?? r.strike),
    color: normalizeHexColor(r.color ?? r.textColor ?? "#000000").toUpperCase(),
    shade,
    spacing: Number(r.letter_spacing ?? r.letterSpacing ?? 0),
    ratio: Number(r.char_ratio ?? r.charRatio ?? 100),
    font: r.font_family ?? r.fontFamily ?? "",
  };
}

function styleBaseKey(s) {
  return `${s.height}:${s.bold ? 1 : 0}:${s.italic ? 1 : 0}:${s.underline ? 1 : 0}:${s.strike ? 1 : 0}:${s.color}:${s.shade}:${s.spacing}:${s.ratio}`;
}

// Parse a header <hh:charPr> XML string into the same normalized shape as
// normRunStyle. `faceById` maps a fontRef id → face NAME (HANGUL block).
function charPrStyleFromXml(s, faceById) {
  const g = (re, d) => { const m = re.exec(s); return m ? m[1] : d; };
  let shade = (g(/\bshadeColor="([^"]*)"/, "NONE") || "NONE").toUpperCase();
  if (shade === "NONE" || shade === "#FFFFFF") shade = "NONE";
  return {
    height: g(/\bheight="(\d+)"/, "1000"),
    bold: /<hh:bold\b/.test(s), italic: /<hh:italic\b/.test(s),
    underline: /<hh:underline\b[^>]*type="(?!NONE)/.test(s),
    // GT: 취소선은 shape 로 제어 (SOLID=보임, NONE=안보임), type 아님.
    strike: /<hh:strikeout\b[^>]*shape="(?!NONE)/.test(s),
    color: g(/\btextColor="([^"]*)"/, "#000000").toUpperCase(),
    shade,
    spacing: Number(g(/<hh:spacing\b[^>]*hangul="(-?\d+)"/, "0")),
    ratio: Number(g(/<hh:ratio\b[^>]*hangul="(\d+)"/, "100")),
    font: faceById.get(g(/<hh:fontRef\s+hangul="(\d+)"/, "")) || "",
  };
}

// Inject a Hancom-native strikeout (shape="SOLID") into a charPr XML. GT (한컴
// format-text --strike → download): 취소선 is controlled by `shape` (SOLID=on,
// NONE=off), NOT `type`, and sits after <hh:underline> (or <hh:offset>). rhwp
// never emits a strikeout charPr on the .hwpx create path, so for a strike run we
// clone the equivalent non-strike charPr and splice this tag in.
function injectStrikeout(charPrXml) {
  const tag = '<hh:strikeout shape="SOLID" color="#000000"/>';
  if (/<hh:strikeout\b/.test(charPrXml)) return charPrXml.replace(/<hh:strikeout\b[^>]*\/>/, tag);
  if (/<hh:underline\b[^>]*\/>/.test(charPrXml)) return charPrXml.replace(/(<hh:underline\b[^>]*\/>)/, `$1${tag}`);
  if (/<hh:offset\b[^>]*\/>/.test(charPrXml)) return charPrXml.replace(/(<hh:offset\b[^>]*\/>)/, `$1${tag}`);
  return charPrXml.replace(/<\/hh:charPr>/, `${tag}</hh:charPr>`);
}

// Returns the uniform char style of `runs` when every text run shares the same
// non-default style, else null. The uniformity test includes font (so a
// mixed-font line returns null → handled by mixedRunSegments instead).
function uniformRunStyle(runs) {
  const styled = (runs || []).filter((r) => r && r.text);
  if (!styled.length) return null;
  const first = normRunStyle(styled[0]);
  const fullKey = (s) => `${styleBaseKey(s)}:${s.font}`;
  if (!styled.every((r) => fullKey(normRunStyle(r)) === fullKey(first))) return null; // mixed → skip
  // Default = nothing to re-link. font is excluded here on purpose: a font-only
  // uniform paragraph is left to rhwp + the charPr-0 remap, not the re-link.
  const isDefault = first.height === 1000 && !first.bold && !first.italic
    && !first.underline && !first.strike && first.color === "#000000"
    && first.shade === "NONE" && first.spacing === 0 && first.ratio === 100;
  return isDefault ? null : first;
}

// Paragraphs whose runs carry MIXED char styling (e.g. "일반 **굵게** 일반", or
// explicit runs with different bold/colour/font/highlight). rhwp's .hwpx
// serializer COALESCES every run in a paragraph into ONE run (dropping
// mid-paragraph char shapes), so inline styling set at create time silently
// vanishes — even though rhwp DOES create the per-run <hh:charPr> in header.xml.
// We re-split the coalesced run back into per-run <hp:run>s post-export.
const mixedRunPatches = [];

// Ordered per-run style segments {text, ...normRunStyle} for a paragraph that
// needs re-splitting, else null (fewer than 2 text runs, or all runs uniform).
function mixedRunSegments(runs) {
  const styled = (runs || []).filter((r) => r && r.text);
  if (styled.length < 2) return null;
  const seg = styled.map((r) => ({ text: String(r.text), ...normRunStyle(r) }));
  const fullKey = (s) => `${styleBaseKey(s)}:${s.font}`;
  if (new Set(seg.map(fullKey)).size < 2) return null; // uniform → not our job
  return seg;
}

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
  // arrive already in HWP units (HEADING_DEFAULTS path). Accept the documented
  // user-facing aliases `size` / `size_pt` (points) as well as `fontSize` —
  // SKILL.md advertises `size` (pt), so dropping it silently lost create-time
  // font sizing.
  const ptSize = input.fontSize ?? input.size ?? input.size_pt;
  if (ptSize != null) props.fontSize = Math.round(Number(ptSize) * 100);
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
  //
  // Per-run fontIds win; otherwise inherit the defaults' fontIds. This is how
  // the active theme's body/heading font flows: append_* passes the theme font
  // as a default, while a per-run `font_family` still overrides it run-by-run.
  if (Array.isArray(input.fontIds)) props.fontIds = input.fontIds;
  else if (Array.isArray(defaults.fontIds)) props.fontIds = defaults.fontIds;
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
  // Bumped 2026-06-17: 1300/800 read as "모자라" (insufficient) on Hancom — a
  // section heading needs a clear band above it and breathing room to its body.
  // Values kept byte-identical to the HWPX track (shared §B default spec) so the
  // rhwp builder emits the same spacing whether serialized to .hwp or .hwpx.
  1: { fontSize: 18,   color: "#1A1A1A", spacingBefore: 2200, spacingAfter: 1100 },
  2: { fontSize: 14,   color: "#2D2D2D", spacingBefore: 1700, spacingAfter: 900 },
  3: { fontSize: 12,   color: "#404040", spacingBefore: 1400, spacingAfter: 750 },
  4: { fontSize: 11,   color: "#595959", spacingBefore: 1100, spacingAfter: 600 },
  5: { fontSize: 10.5, color: "#595959", spacingBefore: 900,  spacingAfter: 520 },
  6: { fontSize: 10,   color: "#595959", spacingBefore: 800,  spacingAfter: 450 },
};

// Body line spacing. 130% read as 빽빽 (cramped) on Hancom once the version.xml
// xmlVersion 1.2→1.5 fix stopped paraPr margins from being halved; 150% gives a
// report comfortable line rhythm without the 160% rhwp-default airiness.
const BODY_LINE_SPACING = 150;
const HEADING_LINE_SPACING = 120;
// List items: a touch tighter than body line spacing, clearly separated from
// each other (LIST_SPACING_AFTER ≈ 2.5mm) but grouped as a list.
const LIST_LINE_SPACING = 140;
const LIST_SPACING_AFTER = 700;
// Body paragraph trailing gap. 600 HWPUNIT (~2.1mm) read as "packed" on Hancom web
// (the title↔section gap at 1300 looked right), so use ~1000 (~3.5mm) for a clear
// but not airy para↔para rhythm.
const BODY_SPACING_AFTER = 1000;

// Table cell inner margin. GT-confirmed (2026-06-21, hancomdocs capture A/B vs
// the HWPX track): Hancom-web's .hwp renderer ignores the PER-CELL inner margin
// and lays out cell content/height from the TABLE record's DEFAULT inMargin
// instead. rhwp emits that default as left/right=510, top/bottom=141 → rows
// render cramped no matter what padding we set on the cells. Post-export we set
// the TABLE inMargin to 400 on ALL FOUR sides — byte-identical to the HWPX
// track's <hp:cellMargin left/right/top/bottom="400"> (hasMargin=1) — so our
// .hwp tables render with the same breathing room AND the same horizontal
// padding. See setTableInMarginInPlace(). Per-cell paddings (append_table) are
// kept at the same 400 so desktop Hancom (which honors per-cell) matches too.
const TABLE_DEFAULT_INNER_MARGIN = 400;

// Table outer BOTTOM margin (gap below a table). GT-matched to the HWPX track's
// <hp:outMargin bottom="500"> (~10px). rhwp emits 283 (~1mm, ~5px) by default and
// Hancom-web ignores the host paragraph's spacingAfter for a table-only paragraph,
// so this is raw-patched into the table CTRL_HEADER post-export (see
// setTableInMarginInPlace). Unscaled — it's a table-object attribute, not a paraPr
// margin. Env override for empirical re-derivation only.
const TABLE_OUTER_BOTTOM_MARGIN = Number(process.env.TABLE_OUTER_BOTTOM ?? 500);

// .hwp paragraph-spacing render-match factor. GT-confirmed (2026-06-21, hancomdocs
// capture A/B vs the HWPX track): the shared spacing constants above (HEADING_DEFAULTS,
// BODY/LIST_SPACING_AFTER) are byte-identical to the HWPX track, but the two tracks
// SERIALIZE them differently. The HWPX track wraps every paraPr margin in an
// <hp:switch> whose rendered branch (<hp:default>) carries the constant scaled by
// 0.7056 (e.g. H1 2200→1552, body-after 1000→706); Hancom-web renders that branch, so
// a .hwpx heading sits ~0.7× as far from its neighbour as the raw constant would imply.
// Our .hwp path writes the constant straight into PARA_SHAPE (1.0×), so an identical
// document renders consistently LOOSER (+~7px per heading gap, ~+40px over a one-page
// report). To land the SAME render we apply the same 0.7056 scale at the one chokepoint
// where every heading/body/list margin reaches rhwp — WITHOUT editing the shared
// constants (keeps the byte-identical merge surface intact, exactly like the HWPX track
// keeps its constants raw and scales only on export). Applies to spacingBefore/After
// only — lineSpacing is a PERCENT, identical in both tracks, and must stay unscaled.
// Env overrides SCALE_BEFORE / SCALE_AFTER / SCALE_HEADING_AFTER are for empirical
// re-derivation only; the defaults below are the locked values.
// Empirically (band-for-band A/B vs the HWPX render): scaling EVERY before/after
// margin uniformly by 0.7056 lands 14 of 16 row gaps exactly on the HWPX render, but
// the body paragraph that immediately FOLLOWS a heading then sits too far below it.
// That boundary is governed by the heading's spacingAfter, and because paragraphs
// snapToGrid (="1", same as the HWPX track) it quantises NON-monotonically — shrinking
// the heading's spacingAfter pushes the next body line down to a further grid line, so
// the gap grows instead of shrinking. So spacingAfter on HEADINGS is left effectively
// unscaled (it already lands ~right at 1.0×); everything else (all spacingBefore, plus
// body/list/title spacingAfter) takes the 0.7056 render-match factor. Splitting the two
// keeps all 16 gaps on the HWPX render. None of this touches the shared constants.
const SCALE_BEFORE = Number(process.env.SCALE_BEFORE ?? 0.7056);
const SCALE_AFTER = Number(process.env.SCALE_AFTER ?? 0.7056);
const SCALE_HEADING_AFTER = Number(process.env.SCALE_HEADING_AFTER ?? 1.0);
const scaleBy = (v, f) => (v == null ? v : Math.round(v * f));

// ── Themes (heading colour + font) — shared with the HWPX track ──────────────
// Ported byte-identical from the HWPX track (create.js is a shared file). Only the
// rhwp-emit application (append_heading/paragraph colour+font via applyCharFormat →
// binary CharShape) is used on the .hwp path; the .hwpx post-export patchers
// (patchHwpxHeadings / patchHwpxTableHeaderFill …) are NOT part of the .hwp route.
const THEMES = {
  government: {
    label: "정부·공문서 (회색, 기본값)",
    bodyFont: null,
    headingFont: null,
    headingColors: {
      1: HEADING_DEFAULTS[1].color, 2: HEADING_DEFAULTS[2].color,
      3: HEADING_DEFAULTS[3].color, 4: HEADING_DEFAULTS[4].color,
      5: HEADING_DEFAULTS[5].color, 6: HEADING_DEFAULTS[6].color,
    },
    accent: "#1F3864",
    headerFill: "#EAEAEA",   // 표 머리행 회색(사용자 선호, 유지). 타 테마는 헤딩색 틴트 자동.
  },
  corporate: {
    label: "기업·비즈니스 (네이비)",
    bodyFont: "맑은 고딕",
    headingFont: "맑은 고딕",
    headingColors: {
      1: "#304D68", 2: "#405E7A", 3: "#496888",
      4: "#5A7A9E", 5: "#5A7A9E", 6: "#5A7A9E",
    },
    accent: "#1F4E79",
  },
  modern: {
    label: "모던·테크 (블루)",
    bodyFont: "Pretendard",
    headingFont: "Pretendard SemiBold",
    headingColors: {
      1: "#212836", 2: "#1F2937", 3: "#374151",
      4: "#4B5563", 5: "#4B5563", 6: "#4B5563",
    },
    accent: "#2563EB",
  },
  clean: {
    label: "클린·미니멀 (틸)",
    bodyFont: "해피니스 산스 레귤러",
    headingFont: "해피니스 산스 볼드",
    headingColors: {
      1: "#1F2638", 2: "#1E293B", 3: "#334155",
      4: "#475569", 5: "#475569", 6: "#475569",
    },
    accent: "#0F766E",
  },
  warm: {
    label: "따뜻한·문화 (오렌지)",
    bodyFont: "Apple SD 산돌고딕 Neo",
    headingFont: "HY헤드라인M",
    headingColors: {
      1: "#382B21", 2: "#4F3C2D", 3: "#5E4433",
      4: "#7C5A3E", 5: "#7C5A3E", 6: "#7C5A3E",
    },
    accent: "#C2410C",
  },
};

// The theme in force for the current run; resolved once from the payload before
// the op loop. Defaults to government so any code path that runs before
// resolveTheme() (or a payload that omits `theme`) behaves exactly as before.
let activeTheme = THEMES.government;

// Load a converted theme from themes/<name>.md (the borrowed Anthropic
// theme-factory set, re-fonted to the Hancom A-set). frontmatter → activeTheme
// shape; the single headingColor fills all six heading levels. Returns null if
// the file is missing/malformed so resolveTheme can fall back cleanly.
const THEMES_DIR = path.join(__dirname, "..", "themes");
function loadThemeFile(name) {
  if (!/^[a-z0-9-]+$/i.test(String(name || ""))) return null;
  const p = path.join(THEMES_DIR, `${name}.md`);
  if (!fs.existsSync(p)) return null;
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, "utf8"));
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = /^([A-Za-z]+):\s*"?(.*?)"?\s*$/.exec(line);
    if (mm) fm[mm[1]] = mm[2];
  }
  if (!fm.name) return null;
  const hc = normalizeHexColor(fm.headingColor || "#1A1A1A");
  return {
    label: fm.label || name,
    bodyFont: fm.bodyFont || null,
    headingFont: fm.headingFont || null,
    headingColors: { 1: hc, 2: hc, 3: hc, 4: hc, 5: hc, 6: hc },
    accent: fm.accent ? normalizeHexColor(fm.accent) : "#1F3864",
  };
}

// Derive a pale table-header fill from a heading colour: keep the hue, cap chroma
// (한글다운 muted), force a light L so a colored-but-subtle band reads under dark
// header text. Neutral source (government #1A1A1A) → light gray. So each theme's
// 표 머리행 takes its own tint (docx-style) instead of a fixed gray.
function tintColor(hex, light = 0.86, satCap = 0.34) {
  const h = String(hex || "#1A1A1A").replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l0 = (max + min) / 2;
  let hue = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue /= 6;
  }
  const S = Math.min(s, satCap), L = light;
  const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let R, G, B;
  if (S === 0) { R = G = B = L; }
  else { const q = L < 0.5 ? L * (1 + S) : L + S - L * S; const p = 2 * L - q; R = hue2rgb(p, q, hue + 1 / 3); G = hue2rgb(p, q, hue); B = hue2rgb(p, q, hue - 1 / 3); }
  const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${to2(R)}${to2(G)}${to2(B)}`;
}

// Resolve the active theme from the payload. Unknown `theme` names fall back to
// government with a logged note (a typo must never abort a document). The
// optional `theme_overrides` object deep-patches the chosen theme — bodyFont /
// headingFont / accent / headingColors{level:hex} — so a caller can tweak the
// look without defining a whole theme. Returns a fresh object; THEMES is never
// mutated.
function resolveTheme(payload, log) {
  const name = payload.theme;
  let base = THEMES.government;
  if (name != null) {
    if (THEMES[name]) base = THEMES[name];
    else {
      const loaded = loadThemeFile(name);
      if (loaded) base = loaded;
      else if (log) log.push(`theme '${name}' unknown — using 'government'. Valid: ${Object.keys(THEMES).join(", ")} + themes/*.md`);
    }
  }
  const theme = { ...base, headingColors: { ...base.headingColors } };
  const ov = payload.theme_overrides;
  if (ov && typeof ov === "object") {
    if (ov.bodyFont != null) theme.bodyFont = ov.bodyFont;
    if (ov.headingFont != null) theme.headingFont = ov.headingFont;
    if (ov.accent != null) theme.accent = ov.accent;
    if (ov.headingColors && typeof ov.headingColors === "object") {
      for (const k of Object.keys(ov.headingColors)) theme.headingColors[k] = ov.headingColors[k];
    }
    if (log) log.push(`theme_overrides applied (${Object.keys(ov).join(", ")})`);
  }
  // 표 머리행 채움색: 명시값(government 회색) 우선, 없으면 헤딩 L1 색에서 연한 틴트 파생.
  // theme_overrides.headerFill 로 직접 지정 가능.
  theme.headerFill = (ov && ov.headerFill) ? normalizeHexColor(ov.headerFill)
    : (base.headerFill ?? tintColor(theme.headingColors[1] || "#1A1A1A"));
  return theme;
}

// Resolve the active theme's font for a role ('body' | 'heading') to a
// broadcast fontIds[7] on the supplied props object, registering the face in
// DocInfo if needed. No-op when the theme leaves that role's font null
// (government). Per-run / per-op fontIds set elsewhere still take precedence
// because buildCharFormatProps prefers input.fontIds over defaults.fontIds.
function themeFontIds(doc, role) {
  const name = role === "heading" ? activeTheme.headingFont : activeTheme.bodyFont;
  if (!name) return null;
  const id = doc.findOrCreateFontId(String(name));
  return id >= 0 ? Array(7).fill(id) : null;
}

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
  if (opts.spacingBefore != null) props.spacingBefore = scaleBy(opts.spacingBefore, SCALE_BEFORE);
  if (opts.spacingAfter != null) {
    props.spacingAfter = scaleBy(opts.spacingAfter, opts.isHeading ? SCALE_HEADING_AFTER : SCALE_AFTER);
  }
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
      requestedLandscape = pd.landscape;
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
    // rhwp's exportHwpx ignores the PageDef margins and writes the blank2010
    // template's <hp:margin> (left/right 30mm, top 20mm, bottom 15mm) — so a
    // requested margin_mm silently has no effect in the .hwpx. Record the
    // resolved margins so the .hwpx post-export pass can stamp them into the
    // section's pagePr (see patchHwpxPageMargin). Only when the caller actually
    // asked for a margin, otherwise we leave the template default untouched.
    if (op.margin_mm !== undefined || op.margin_top_mm !== undefined || op.margin_bottom_mm !== undefined
        || op.margin_left_mm !== undefined || op.margin_right_mm !== undefined) {
      hwpxPageMargin = {
        left: pd.marginLeft, right: pd.marginRight, top: pd.marginTop, bottom: pd.marginBottom,
        header: pd.marginHeader, footer: pd.marginFooter, gutter: pd.marginGutter,
      };
    }
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
    // Theme body font flows in as a default; per-run font_family still wins.
    const bodyDefaults = {};
    const bFontIds = themeFontIds(doc, "body");
    if (bFontIds) bodyDefaults.fontIds = bFontIds;
    writeRunsAt(doc, cursor, runs, bodyDefaults);
    // rhwp drops the run's charPrIDRef on .hwpx export — track uniform run
    // styling so we can re-link it post-export (same fix as headings). A
    // paragraph is EITHER uniform (re-link one charPr) OR mixed (re-split into
    // per-run charPrs) — never both.
    const bstyle = uniformRunStyle(runs);
    if (bstyle) {
      bodyStylePatches.push({ paraIdx: cursor.para, ...bstyle });
    } else {
      const seg = mixedRunSegments(runs);
      if (seg) mixedRunPatches.push({ paraIdx: cursor.para, segments: seg });
    }
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

  // Insert a Hancom equation (수식) from a Hancom equation script. rhwp's
  // insertEquation builds a native HYhwpEQ object — the same equation engine
  // Hancom's own editor uses — so every token in references/equation-syntax.md
  // renders identically to the UI editor (verified: 21-case syntax sweep all
  // embed + render). Routes through the rhwp emit path (NOT raw-patch), so it's
  // a from-scratch / small-file feature like append_image.
  append_equation(doc, op, cursor) {
    const script = String(op.script ?? "").trim();
    if (!script) throw new Error("append_equation: 'script' (Hancom equation script) is required");
    startNewParagraph(doc, cursor);
    const size = Number.isFinite(op.size) ? op.size : 1000;   // HWP units/100 (1000 ≈ 10pt)
    const color = op.color ?? "#000000";
    unwrap(
      doc.insertEquation(cursor.sec, cursor.para, cursor.charOffset, script, size, color),
      "insertEquation",
    );
    // Advance past the equation control so the next op splits after it.
    try { cursor.charOffset = doc.getParagraphLength(cursor.sec, cursor.para); } catch {}
    applyParaProps(doc, cursor, {
      align: op.align,
      spacingBefore: op.spacing_before ?? 0,
      spacingAfter: op.spacing_after ?? BODY_SPACING_AFTER,
    });
    log.push(`append_equation (${script.length} chars)`);
  },

  // Header / footer (머리말 / 꼬리말). Document-level, via rhwp createHeaderFooter
  // + insertTextInHeaderFooter — renders in Hancom (verified). apply_to 0 = both
  // pages. Doesn't touch the body cursor. from-scratch / rhwp-emit path only.
  set_header(doc, op, cursor) {
    const text = String(op.text ?? "");
    const applyTo = Number.isFinite(op.apply_to) ? op.apply_to : 0;
    unwrap(doc.createHeaderFooter(cursor.sec, true, applyTo), "createHeaderFooter(header)");
    if (text) unwrap(doc.insertTextInHeaderFooter(cursor.sec, true, applyTo, 0, 0, text), "insertTextInHeaderFooter(header)");
    log.push(`set_header ("${truncForLog(text)}")`);
  },
  set_footer(doc, op, cursor) {
    const text = String(op.text ?? "");
    const applyTo = Number.isFinite(op.apply_to) ? op.apply_to : 0;
    unwrap(doc.createHeaderFooter(cursor.sec, false, applyTo), "createHeaderFooter(footer)");
    if (text) unwrap(doc.insertTextInHeaderFooter(cursor.sec, false, applyTo, 0, 0, text), "insertTextInHeaderFooter(footer)");
    log.push(`set_footer ("${truncForLog(text)}")`);
  },

  // Footnote (각주). Attaches a footnote to the END of the current paragraph
  // (the cursor) — add it right after the append_paragraph it should annotate.
  // rhwp insertFootnote + insertTextInFootnote, renders in Hancom (verified).
  append_footnote(doc, op, cursor) {
    const text = String(op.text ?? "");
    if (!text) throw new Error("append_footnote: 'text' is required");
    const r = unwrap(doc.insertFootnote(cursor.sec, cursor.para, cursor.charOffset), "insertFootnote");
    const ctrl = (r && typeof r.controlIdx === "number") ? r.controlIdx : 0;
    unwrap(doc.insertTextInFootnote(cursor.sec, cursor.para, ctrl, 0, 0, text), "insertTextInFootnote");
    try { cursor.charOffset = doc.getParagraphLength(cursor.sec, cursor.para); } catch {}
    log.push(`append_footnote ("${truncForLog(text)}")`);
  },

  // Bookmark (책갈피) at the cursor — invisible nav/reference mark. rhwp addBookmark.
  add_bookmark(doc, op, cursor) {
    const name = String(op.name ?? "");
    if (!name) throw new Error("add_bookmark: 'name' is required");
    unwrap(doc.addBookmark(cursor.sec, cursor.para, cursor.charOffset, name), "addBookmark");
    log.push(`add_bookmark ("${name}")`);
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
    // Theme controls colour + font; HEADING_DEFAULTS still owns size/spacing.
    // A per-op `color` or per-run color overrides the theme (handled downstream).
    const headingColor = op.color ? normalizeHexColor(op.color) : (activeTheme.headingColors[level] ?? def.color);
    const headingDefaults = {
      fontSize: heightHU,
      bold: true,
      color: headingColor,
    };
    const hFontIds = themeFontIds(doc, "heading");
    if (hFontIds) headingDefaults.fontIds = hFontIds;
    writeRunsAt(doc, cursor, runs, headingDefaults);
    // Record the intended ink colour: patchHwpxHeadings re-links the run to a
    // charPr matching (size, bold, COLOUR) — without colour in the key it would
    // collapse every same-size heading onto the first charPr (all one colour).
    const inkColor = (runs[0] && runs[0].color) ? normalizeHexColor(runs[0].color) : headingColor;
    headingPatches.push({
      paraIdx: cursor.para,
      heightHU,
      bold: true,
      color: inkColor,
      // Top gap (HWPUNIT) so a table directly before this heading can carry it on
      // its outMargin.bottom (Hancom eats a heading's own prev below a table).
      topGap: op.spacing_before ?? def.spacingBefore,
    });
    // Headings: left-aligned (justify makes 16pt headings look weird with
    // the inter-word stretch), tight line spacing, generous before/after.
    // spacing_before / spacing_after (HWPUNIT, ~283/mm) override the per-level
    // defaults so a caller can tune a heading's section gap. Headings are normal
    // paragraphs, so these margins COLLAPSE with neighbours (gap = the larger).
    applyParaProps(doc, cursor, {
      align: op.align ?? "left",
      lineSpacing: op.line_spacing ?? HEADING_LINE_SPACING,
      spacingBefore: op.spacing_before ?? def.spacingBefore,
      spacingAfter: op.spacing_after ?? def.spacingAfter,
    });
    applyParaBorders(doc, cursor, op);
    log.push(`append_heading L${level} (${cursor.charOffset} chars)`);
  },

  append_table(doc, op, cursor) {
    // Header-row safety net. Report/grid tables almost always lead with a
    // header row, but the model sometimes packs that row into `rows` and omits
    // `headers` — which silently skips the theme header tint + bold, since the
    // whole header treatment is gated on `headers.length`. When `headers` is
    // absent we promote `rows[0]` to the header so the top row reliably gets
    // the theme tint (the user can still override the colour with
    // `header_fill`). A genuinely header-less table opts out via
    // `no_header: true`.
    let headers = op.headers || [];
    let rows = op.rows || [];
    if (!headers.length && rows.length && op.no_header !== true) {
      headers = rows[0];
      rows = rows.slice(1);
    }
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
    // 머리행 채움색: 호출자(LLM)가 op.header_fill 로 자유 지정 > 테마 파생 틴트 > 회색.
    const HEADER_BG = op.header_fill ? normalizeHexColor(op.header_fill) : (activeTheme.headerFill || "#EAEAEA");
    // Uniform 1.4mm cell padding on all four sides. NOTE: this only renders once
    // the cell's hasMargin="1" is set (patchHwpxCellHasMargin post-export) — rhwp
    // leaves it 0, which makes Hancom ignore the per-cell margin entirely.
    const HEADER_PAD = 400;        // ~1.4mm vertical (docx 80 twip ×5)
    const BODY_PAD = 400;          // ~1.4mm vertical
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
          paddingLeft: 400,   // ~1.4mm — uniform all four sides
          paddingRight: 400,
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
        // Theme font for table content: header cells use the heading font
        // (falling back to body), body cells use the body font. No-op for the
        // government theme (null fonts → keeps rhwp default).
        const cellFontIds = themeFontIds(doc, isHeader ? "heading" : "body")
          ?? themeFontIds(doc, "body");
        if (cellFontIds) baseProps.fontIds = cellFontIds;
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
    // The gap BELOW the table is NOT set here: Hancom-web ignores the host
    // paragraph's spacingAfter when the paragraph holds a table (verified — 500
    // landed in the bytes but the render didn't budge). It's governed by the
    // table object's outer BOTTOM margin instead, which setTableInMarginInPlace()
    // raw-patches post-export to match the HWPX track. So keep both 0 here.
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
    // Table vertical rhythm: give the table's WRAPPER PARAGRAPH normal block
    // margins (before == after == body gap) and zero the table's own outMargin
    // (patchHwpxTableOutMargin). Hancom COLLAPSES adjacent paragraph margins
    // (GT: 10mm-after + 10mm-before renders 10mm, not 20mm), so with om=0 the
    // table behaves like a paragraph: the gap above/below it is max(neighbour's
    // margin, table's margin). A heading after a table then gets max(table 3.5mm,
    // heading 6mm) = 6mm — the SAME gap a heading gets after body text — so the
    // two read identically (user: 표 뒤 제목과 본문 뒤 제목 간격이 같아야 한다).
    // The earlier outMargin approach ADDED on top of the collapsed gap (sum),
    // which over-spaced 표→heading.
    // The table must space EXACTLY like a body paragraph: its top gap should
    // come ONLY from the preceding element's spacingAfter, so 제목→표 == 제목→글
    // and 글→표 == 글→글. So wrapper spacingBefore = 0 (a body paragraph's prev is
    // 0) AND the table's own outMargin.top = 0 (set in patchHwpxTableOutMargin) —
    // otherwise the two stack and over-space above the table. Keep spacingAfter
    // for the below-table rhythm.
    applyParaProps(doc, { sec: cursor.sec, para: tableParaIdx, charOffset: 0 }, {
      align: "left",
      lineSpacing: BODY_LINE_SPACING,
      spacingBefore: 0,
      spacingAfter: BODY_SPACING_AFTER,
    });
    // Record this table's spacing override (HWPUNIT) for patchHwpxTableOutMargin,
    // which sets the table's outMargin (the lever Hancom actually renders above /
    // below a table). null → use TABLE_OUTMARGIN default. Order matches the
    // top-level <hp:tbl> order in the section, so the Nth table gets the Nth spec.
    tableSpacingSpecs.push({
      before: op.spacing_before ?? null,
      after: op.spacing_after ?? null,
    });
    // Header fill per table (only header tables get a shaded row → only these are
    // re-injected). Document order matches patchHwpxTableHeaderFill's header scan.
    tableHeaderFills.push({
      hasHeader: headers.length > 0,
      fill: op.header_fill ? normalizeHexColor(op.header_fill) : null,
    });

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
      const liDefaults = {};
      const liFontIds = themeFontIds(doc, "body");
      if (liFontIds) liDefaults.fontIds = liFontIds;
      writeRunsAt(doc, cursor, runs, liDefaults);
      // List items breathe between each other but stay tighter than body
      // paragraphs (700 HWPUNIT after ≈ 2.5mm) — 100 (≈0.35mm) read as packed.
      applyParaProps(doc, cursor, {
        align: "left",
        lineSpacing: LIST_LINE_SPACING,
        spacingBefore: 0,
        spacingAfter: LIST_SPACING_AFTER,
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
      const liDefaults = {};
      const liFontIds = themeFontIds(doc, "body");
      if (liFontIds) liDefaults.fontIds = liFontIds;
      writeRunsAt(doc, cursor, runs, liDefaults);
      applyParaProps(doc, cursor, {
        align: "left",
        lineSpacing: LIST_LINE_SPACING,
        spacingBefore: 0,
        spacingAfter: LIST_SPACING_AFTER,
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
    // Image paragraph spacing: spacing_before / spacing_after (HWPUNIT) tune the
    // gap above/below the picture; default to the body trailing gap. align lets a
    // caller centre the image. These are paragraph margins (collapse like text).
    applyParaProps(doc, { sec: cursor.sec, para: cursor.para, charOffset: 0 }, {
      align: op.align ?? "center",
      spacingBefore: op.spacing_before ?? 0,
      spacingAfter: op.spacing_after ?? BODY_SPACING_AFTER,
    });
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

// describeTable / enumerateTables / MAX_CONTROL_IDX live in ./cell-inspect.js
// (imported at the top). They were moved out so the table-cell read sweep has
// a single source shared with extract_text.js — read and write must walk
// tables identically or in-place edits would target the wrong cell.

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
        const sec = op.section ?? 0; // default section 0 — consistent with set_cell_background/border/etc.
        const para = requireInt(op, 'para');
        const ctrl = requireInt(op, 'control');
        const text = op.text ?? '';
        const cellPara = op.cell_para ?? 0; // which paragraph inside a multi-paragraph cell (default first)
        const clearObjects = !!op.clear_objects; // with text:"" — also remove inline objects in that paragraph
        if (op.row != null && op.col != null) {
          out.push({ section: sec, para, control: ctrl, row: op.row, col: op.col, text, cell_para: cellPara, clear_objects: clearObjects, fit: !!op.fit, nested: op.nested ?? null, collapse: !!op.collapse });
        } else if (op.cell != null) {
          // Convert flat cellIndex back to (row, col) via rhwp inspect.
          if (!doc) doc = new HwpDocument(new Uint8Array(fs.readFileSync(filePath)));
          const info = JSON.parse(doc.getCellInfo(sec, para, ctrl, op.cell));
          out.push({ section: sec, para, control: ctrl, row: info.row, col: info.col, text, cell_para: cellPara, clear_objects: clearObjects, fit: !!op.fit, nested: op.nested ?? null, collapse: !!op.collapse });
        } else {
          throw new Error("set_cell_text: provide row+col or cell");
        }
        continue;
      }
      // set_cell_text_by_label — sweep tables, find the anchor, apply offset.
      if (typeof op.label !== 'string' || op.label.length === 0) {
        throw new Error("set_cell_text_by_label: 'label' is required");
      }
      // When NO offset is given, auto-target the value cell right after the label
      // (col + the label cell's colSpan) — so "set_cell_text_by_label(상호, …)"
      // fills the empty cell next to 상호 instead of overwriting the label, and a
      // label that spans 2 cols (대표자 c6-7) still lands on c8. Pass an explicit
      // col_offset/row_offset (incl. 0 to overwrite the label cell) to override.
      const autoTarget = (op.row_offset == null && op.col_offset == null);
      const rowOff = op.row_offset ?? 0;
      const colOff = op.col_offset ?? 0;
      const occurrence = op.occurrence ?? 0;
      const caseSensitive = !!op.case_sensitive;
      const text = op.text ?? '';

      const scoped = (op.section != null || op.para != null || op.control != null);
      const candidates = scoped
        ? [{ sec: op.section ?? 0, para: requireInt(op, 'para'), ctrl: requireInt(op, 'control') }]
        : enumerateTables(doc);

      const hits = [];
      for (const { sec, para, ctrl } of candidates) {
        const grid = describeTable(doc, sec, para, ctrl);
        if (!grid) continue;
        // Strip whitespace (incl. \r\n between a cell's paragraphs and the
        // full-width spaces Korean forms pad labels with) from BOTH sides before
        // matching — a label like "사업장소재지" is often stored as two cell
        // paragraphs "사업장\r소재지", and "사업자등록번호" as "사 업 자등록번호".
        const norm = (s) => s.replace(/[\s　]+/g, '');
        for (const cell of grid.cells) {
          const txt = norm(caseSensitive ? cell.text : cell.text.toLowerCase());
          const needle = norm(caseSensitive ? op.label : op.label.toLowerCase());
          if (txt.includes(needle)) hits.push({ sec, para, ctrl, cell });
        }
      }
      if (hits.length === 0) throw new Error(`set_cell_text_by_label: no cell containing "${op.label}" found`);
      if (occurrence >= hits.length) throw new Error(`set_cell_text_by_label: occurrence ${occurrence} out of range (${hits.length} hits)`);
      const hit = hits[occurrence];
      if (op.append) {
        // The label cell ITSELF is the write area — "건 명 : ___" / underline /
        // colon-style fields where the value is typed after the label in the same
        // cell, not in an adjacent cell. Keep the label text and append the value.
        const labelText = (hit.cell.text || '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '');
        out.push({
          section: hit.sec, para: hit.para, control: hit.ctrl,
          row: hit.cell.row, col: hit.cell.col,
          text: labelText ? `${labelText} ${text}` : text,
        });
      } else {
        out.push({
          section: hit.sec, para: hit.para, control: hit.ctrl,
          row: hit.cell.row + (autoTarget ? 0 : rowOff),
          col: hit.cell.col + (autoTarget ? (hit.cell.colSpan ?? 1) : colOff),
          text, fit: !!op.fit,
        });
      }
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

  // Index every TOP-LEVEL <hp:p> region (table-cell paras excluded — see helper).
  const regions = topLevelParaRegions(xml);

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
      // Newer rhwp serializers emit a native <hp:pic> in the paragraph instead
      // of leaving an empty-text run (the pattern above). That native pic ships
      // with <hp:orgSz width="0" height="0"/> (and sometimes imgDim 0) — Hancom
      // renders nothing when the original size is 0 (invisible), so we patch it
      // in place rather than failing. Natural size comes from the pic's own
      // imgClip (the source pixel rect in HWPUNIT), falling back to curSz then
      // the requested display size.
      if (/<hp:pic\b/.test(body)) {
        const clip = body.match(/<hp:imgClip\b[^>]*\bright="(\d+)"[^>]*\bbottom="(\d+)"/);
        const cur = body.match(/<hp:curSz\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
        const natW = clip ? clip[1] : (cur && cur[1] !== "0" ? cur[1] : p.widthHwp);
        const natH = clip ? clip[2] : (cur && cur[2] !== "0" ? cur[2] : p.heightHwp);
        const fixed = body
          .replace(/<hp:orgSz\s+width="0"\s+height="0"\s*\/>/g, `<hp:orgSz width="${natW}" height="${natH}"/>`)
          .replace(/<hp:imgDim\s+dimwidth="0"\s+dimheight="0"\s*\/>/g, `<hp:imgDim dimwidth="${natW}" dimheight="${natH}"/>`);
        xml = before + fixed + after;
        // ok either way: pic exists; isEmbeded manifest fix (above) still applies.
        applied.unshift({ ok: true, paraIdx: p.paraIdx, nativePicPatched: fixed !== body });
        continue;
      }
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

// rhwp's exportHwpx writes the blank2010 template's <hp:margin> into every
// section's pagePr regardless of the PageDef margins set via setPageDef — so a
// requested margin_mm has no effect on the .hwpx. Stamp the resolved margins
// (HWPUNIT) into each section's <hp:margin>. Only sides present in `m` are set.
async function patchHwpxPageMargin(filePath, m) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  let changed = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    let xml = await zip.file(name).async("string");
    const before = xml;
    xml = xml.replace(/<hp:margin\b[^>]*\/>/g, (tag) => {
      let t = tag;
      for (const [attr, val] of [["left", m.left], ["right", m.right], ["top", m.top],
        ["bottom", m.bottom], ["header", m.header], ["footer", m.footer], ["gutter", m.gutter]]) {
        if (val == null) continue;
        const re = new RegExp(`\\b${attr}="[^"]*"`);
        t = re.test(t) ? t.replace(re, `${attr}="${val}"`) : t.replace(/\s*\/>$/, ` ${attr}="${val}"/>`);
      }
      return t;
    });
    if (xml !== before) { zip.file(name, xml); changed++; }
  }
  if (changed) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    fs.writeFileSync(filePath, out);
  }
  return changed;
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

  // ── 2b. Patch version.xml — xmlVersion 1.2 → 1.5 ────────────────────────
  // rhwp's exportHwpx writes version.xml with xmlVersion="1.2" (HWP 11 legacy
  // format), while <hh:head version="..."> is bumped to 1.5 below. Hancom Docs
  // web reads version.xml's xmlVersion; when it says "1.2" it treats the whole
  // document as a LEGACY-format file and HALVES every paraPr margin (문단
  // 위/아래/좌/우) value on import — the long-standing "문단 간격이 절반으로
  // 나온다" bug. GT-confirmed (2026-06-17, byte-isolated round-trip): flipping
  // ONLY xmlVersion 1.2→1.5 makes Hancom preserve our margins verbatim (case=
  // mm×100, default=mm×200, no rescale). Keep consistent with the head version.
  const verEntry = out.file("version.xml");
  if (verEntry) {
    let ver = await verEntry.async("string");
    if (/xmlVersion="1\.2"/.test(ver)) {
      out.file("version.xml", ver.replace(/xmlVersion="1\.2"/, 'xmlVersion="1.5"'));
    }
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

// Section regions for TOP-LEVEL <hp:p> only — depth-tracked so table-cell
// <hp:p> (nested inside <hp:tbl>) are NOT counted, and a table's wrapper
// paragraph closes at its REAL </hp:p> (not the first cell's). This matches
// doc.paragraphs() (a table = one wrapper para), so post-export paraIdx ↔ region
// indices stay aligned even when the doc has tables. Without this, the re-link
// patches mis-target cells (e.g. a table header cell "2025년" getting a
// heading's 14pt-bold charPr). The old `<hp:p>…?</hp:p>` regex broke on both
// counts (it included cell paras AND truncated the wrapper at the first cell).
function topLevelParaRegions(xml) {
  const re = /<hp:p\b[^>]*?(\/?)>|<\/hp:p>/g;
  const out = [];
  let m, depth = 0, start = -1;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === "</hp:p>") {
      if (depth > 0 && --depth === 0 && start >= 0) { out.push({ start, end: re.lastIndex }); start = -1; }
    } else if (m[1] === "/") {
      if (depth === 0) out.push({ start: m.index, end: re.lastIndex }); // self-closing top-level <hp:p/>
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
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
  const lookup = new Map();    // height:bold → first id (colour-agnostic fallback)
  const lookupC = new Map();   // height:bold:TEXTCOLOR → id (so per-heading colour survives)
  for (const m of headerXml.matchAll(charPrRe)) {
    const s = m[0];
    const idM = /\bid="(\d+)"/.exec(s);
    const heightM = /\bheight="(\d+)"/.exec(s);
    if (!idM || !heightM) continue;
    const id = idM[1];
    const height = heightM[1];
    const bold = /<hh:bold\b/.test(s);
    const colorM = /\btextColor="(#[0-9A-Fa-f]{6})"/.exec(s);
    const color = (colorM ? colorM[1] : "#000000").toUpperCase();
    const key = `${height}:${bold ? 1 : 0}`;
    if (!lookup.has(key)) lookup.set(key, id);
    const keyC = `${key}:${color}`;
    if (!lookupC.has(keyC)) lookupC.set(keyC, id);
  }

  // Find every <hp:p>...</hp:p> region and rewrite the text-bearing run's
  // charPrIDRef in each tracked heading paragraph.
  const regions = topLevelParaRegions(sectionXml);
  let xml = sectionXml;
  let fixed = 0;
  // Apply in reverse so offsets stay valid.
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p.paraIdx < 0 || p.paraIdx >= regions.length) continue;
    const key = `${p.heightHU}:${p.bold ? 1 : 0}`;
    const keyC = p.color ? `${key}:${String(p.color).toUpperCase()}` : null;
    // Prefer the charPr that also matches the heading's intended colour; fall
    // back to the colour-agnostic match (old behaviour) if none exists.
    const targetId = (keyC && lookupC.get(keyC)) || lookup.get(key);
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

// Re-link body-paragraph runs to their styled <hh:charPr> (the rhwp .hwpx-export
// quirk: charPr exists in header.xml but the run points at id 0). Matches on the
// full style key (height + bold + italic + underline + textColor) so colour and
// emphasis survive, then retargets every text-bearing run in the paragraph.
async function patchHwpxBodyRunStyles(filePath, patches) {
  if (!patches.length) return 0;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const headerEntry = zip.file("Contents/header.xml");
  const sectionEntry = zip.file("Contents/section0.xml");
  if (!headerEntry || !sectionEntry) return 0;
  const headerXml = await headerEntry.async("string");
  const sectionXml = await sectionEntry.async("string");

  // Map a fontRef face id → face NAME (HANGUL block is representative — rhwp
  // assigns the same id across every language block). Lets us key charPrs on
  // their font so paragraphs that differ ONLY by font (e.g. a font-sample sheet,
  // or a 14pt 궁서 line next to a 14pt 바탕 line) re-link to the RIGHT charPr
  // instead of collapsing onto the first one that matches size+colour.
  const faceById = new Map();
  const hangulBlock = (/<hh:fontface lang="HANGUL"[^>]*>[\s\S]*?<\/hh:fontface>/.exec(headerXml) || [])[0] || "";
  for (const fm of hangulBlock.matchAll(/<hh:font id="(\d+)"[^>]*\bface="([^"]*)"/g)) {
    faceById.set(fm[1], fm[2]);
  }

  // header charPr → composite style-key lookup. `lookupFull` keys on font too
  // (for patches with an explicit font); `lookup` ignores font (fallback for
  // font-less styled paragraphs). The key now covers every managed attribute
  // (incl. highlight/strike/spacing/ratio) via the shared normalizers.
  const charPrRe = /<hh:charPr\b[^>]*?(?:\/>|>(?:[^<]|<(?!\/hh:charPr>))*?<\/hh:charPr>)/g;
  const lookup = new Map();
  const lookupFull = new Map();
  const charPrById = new Map();
  let maxCharId = 0;
  for (const m of headerXml.matchAll(charPrRe)) {
    const s = m[0];
    const id = (/\bid="(\d+)"/.exec(s) || [])[1];
    if (!id) continue;
    charPrById.set(id, s);
    if (Number(id) > maxCharId) maxCharId = Number(id);
    const st = charPrStyleFromXml(s, faceById);
    const base = styleBaseKey(st);
    if (!lookup.has(base)) lookup.set(base, id);
    if (!lookupFull.has(`${base}:${st.font}`)) lookupFull.set(`${base}:${st.font}`, id);
  }
  const headerSynth = [];
  let nextCharId = maxCharId + 1;

  const regions = topLevelParaRegions(sectionXml);
  let xml = sectionXml;
  let fixed = 0;
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p.paraIdx < 0 || p.paraIdx >= regions.length) continue;
    const base = styleBaseKey(p);
    // Explicit font → match the charPr with that font; otherwise fall back to
    // the font-agnostic match (font-less styled paragraphs).
    let targetId = (p.font && lookupFull.get(`${base}:${p.font}`)) || lookup.get(base);
    // Strike paragraph with no strikeout charPr (rhwp create-path) → synthesize
    // from the non-strike equivalent (same as the mixed-run path).
    if (!targetId && p.strike) {
      const cb = styleBaseKey({ ...p, strike: false });
      const coreId = (p.font && lookupFull.get(`${cb}:${p.font}`)) || lookup.get(cb);
      if (coreId != null && charPrById.has(coreId)) {
        targetId = String(nextCharId++);
        const nx = injectStrikeout(charPrById.get(coreId).replace(/\bid="\d+"/, `id="${targetId}"`));
        headerSynth.push(nx);
        charPrById.set(targetId, nx);
        lookup.set(base, targetId);
      }
    }
    if (!targetId) continue;
    const region = regions[p.paraIdx];
    const body = xml.slice(region.start, region.end);
    const runRe = /<hp:run\s+charPrIDRef="(\d+)"\s*>([\s\S]*?)<\/hp:run>/g;
    const newBody = body.replace(runRe, (full, currentId, inner) => {
      if (!/<hp:t\b/.test(inner) || currentId === targetId) return full;
      fixed++;
      return `<hp:run charPrIDRef="${targetId}">${inner}</hp:run>`;
    });
    if (newBody !== body) xml = xml.slice(0, region.start) + newBody + xml.slice(region.end);
  }

  if (fixed > 0) {
    zip.file("Contents/section0.xml", xml);
    if (headerSynth.length) {
      let nh = headerXml.replace("</hh:charProperties>", headerSynth.join("") + "</hh:charProperties>");
      nh = nh.replace(/(<hh:charProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + headerSynth.length) + b);
      zip.file("Contents/header.xml", nh);
    }
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return fixed;
}

// Re-split paragraphs whose mixed-style runs rhwp coalesced into ONE run on
// .hwpx export (inline **bold**, per-run colour/font, etc.). For each tracked
// paragraph we rebuild the single coalesced text run as a sequence of per-
// segment <hp:run>s, each pointing at the header <hh:charPr> that matches that
// segment's style (rhwp DID create those charPrs; it just dropped the per-run
// references). HEAVILY GUARDED: if the paragraph isn't the expected single
// plain-text coalesced run (count != 1, markup inside <hp:t>, text drift, or any
// segment's charPr missing) we leave it untouched — worst case is the prior
// coalesced output, never corruption.
async function patchHwpxMixedRuns(filePath, patches) {
  if (!patches.length) return 0;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const headerEntry = zip.file("Contents/header.xml");
  const sectionEntry = zip.file("Contents/section0.xml");
  if (!headerEntry || !sectionEntry) return 0;
  const headerXml = await headerEntry.async("string");
  const sectionXml = await sectionEntry.async("string");

  // face id → name + charPr lookups (font-agnostic `lookup`, font-keyed `lookupFull`).
  const faceById = new Map();
  const hangulBlock = (/<hh:fontface lang="HANGUL"[^>]*>[\s\S]*?<\/hh:fontface>/.exec(headerXml) || [])[0] || "";
  for (const fm of hangulBlock.matchAll(/<hh:font id="(\d+)"[^>]*\bface="([^"]*)"/g)) faceById.set(fm[1], fm[2]);
  const charPrRe = /<hh:charPr\b[^>]*?(?:\/>|>(?:[^<]|<(?!\/hh:charPr>))*?<\/hh:charPr>)/g;
  const lookup = new Map();
  const lookupFull = new Map();
  const charPrById = new Map();
  let maxCharId = 0;
  for (const m of headerXml.matchAll(charPrRe)) {
    const s = m[0];
    const id = (/\bid="(\d+)"/.exec(s) || [])[1];
    if (!id) continue;
    charPrById.set(id, s);
    if (Number(id) > maxCharId) maxCharId = Number(id);
    const st = charPrStyleFromXml(s, faceById);
    const base = styleBaseKey(st);
    if (!lookup.has(base)) lookup.set(base, id);
    if (!lookupFull.has(`${base}:${st.font}`)) lookupFull.set(`${base}:${st.font}`, id);
  }
  const headerSynth = [];     // synthesized charPrs to append to header
  let nextCharId = maxCharId + 1;

  const escXml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unescXml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const segCharPr = (sg) => {
    const base = styleBaseKey(sg);
    if (sg.font && lookupFull.has(`${base}:${sg.font}`)) return lookupFull.get(`${base}:${sg.font}`);
    if (lookup.has(base)) return lookup.get(base);
    // Strike run: rhwp never emits a strikeout charPr on the create path, so
    // synthesize one — clone the equivalent NON-strike charPr and inject the
    // native <hh:strikeout shape="SOLID"> (GT reverse-engineered).
    if (sg.strike) {
      const cb = styleBaseKey({ ...sg, strike: false });
      const coreId = (sg.font && lookupFull.get(`${cb}:${sg.font}`)) || lookup.get(cb);
      if (coreId != null && charPrById.has(coreId)) {
        const newId = String(nextCharId++);
        const nx = injectStrikeout(charPrById.get(coreId).replace(/\bid="\d+"/, `id="${newId}"`));
        headerSynth.push(nx);
        charPrById.set(newId, nx);
        lookup.set(base, newId);
        return newId;
      }
    }
    // Last-resort fallback: match the core size+weight+colour so the run keeps
    // what IS available even if one attribute couldn't be resolved/synthesized.
    const core = styleBaseKey({ ...sg, strike: false, shade: "NONE", spacing: 0, ratio: 100 });
    if (lookup.has(core)) return lookup.get(core);
    return null;
  };

  const regions = topLevelParaRegions(sectionXml);
  let xml = sectionXml;
  let fixed = 0;
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i];
    if (p.paraIdx < 0 || p.paraIdx >= regions.length) continue;
    const ids = p.segments.map(segCharPr);
    if (ids.some((x) => !x)) continue;                 // a segment style isn't in header → bail
    const region = regions[p.paraIdx];
    const body = xml.slice(region.start, region.end);
    // Collect text-bearing runs; expect exactly one (the coalesced run).
    const runRe = /<hp:run\b[^>]*>([\s\S]*?)<\/hp:run>/g;
    const textRuns = [];
    let mm;
    while ((mm = runRe.exec(body)) !== null) {
      const tm = /<hp:t>([\s\S]*?)<\/hp:t>/.exec(mm[1]);
      if (tm) textRuns.push({ t: tm[1], start: mm.index, end: mm.index + mm[0].length });
    }
    if (textRuns.length !== 1) continue;               // not the simple coalesced shape
    const run = textRuns[0];
    if (/<hp:/.test(run.t)) continue;                  // markup inside <hp:t> → leave alone
    if (unescXml(run.t) !== p.segments.map((s) => s.text).join("")) continue; // text drift → bail
    const rebuilt = p.segments
      .map((s, k) => `<hp:run charPrIDRef="${ids[k]}"><hp:t>${escXml(s.text)}</hp:t></hp:run>`)
      .join("");
    const newBody = body.slice(0, run.start) + rebuilt + body.slice(run.end);
    xml = xml.slice(0, region.start) + newBody + xml.slice(region.end);
    fixed++;
  }

  if (fixed > 0) {
    zip.file("Contents/section0.xml", xml);
    if (headerSynth.length) {
      let nh = headerXml.replace("</hh:charProperties>", headerSynth.join("") + "</hh:charProperties>");
      nh = nh.replace(/(<hh:charProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (Number(n) + headerSynth.length) + b);
      zip.file("Contents/header.xml", nh);
    }
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return fixed;
}

// Convert rhwp's PLAIN <hh:margin>+<hh:lineSpacing> paraPrs into the Hancom-
// native <hp:switch>(hp:case[hwpunitchar] + hp:default) form so paragraph
// spacing / indent / left-right margin / lineSpacing survive the Hancom-web
// round-trip. GT (한컴 para-shape → download): a plain paraPr margin is stripped
// to 0 on open; only the hp:switch form persists. Units (GT): hp:case = mm×100,
// hp:default = mm×200, where rhwp's values are standard HWPUNIT (≈283.46/mm).
// Also moves <hh:autoSpacing> ahead of the switch to match the native child order
// (align, heading, breakSetting, autoSpacing, switch, border).
async function patchHwpxParaSpacing(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const he = zip.file("Contents/header.xml");
  if (!he) return 0;
  let header = await he.async("string");
  let n = 0;
  header = header.replace(/<hh:paraPr\b[^>]*>[\s\S]*?<\/hh:paraPr>/g, (pp) => {
    if (pp.includes("<hp:switch")) return pp;                 // already native
    const mar = /<hh:margin>([\s\S]*?)<\/hh:margin>/.exec(pp);
    if (!mar) return pp;
    const val = (tag) => { const m = new RegExp(`<hh:${tag}\\b[^>]*value="(-?\\d+)"`).exec(mar[1]); return m ? Number(m[1]) : 0; };
    const I = val("intent"), L = val("left"), R = val("right"), P = val("prev"), N = val("next");
    const lsM = /<hh:lineSpacing\b[^>]*\/>/.exec(pp);
    const ls = lsM ? lsM[0] : '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>';
    const mk = (mult) => {
      const c = (hu) => Math.round((hu / 283.46) * mult);
      return `<hh:margin><hc:intent value="${c(I)}" unit="HWPUNIT"/><hc:left value="${c(L)}" unit="HWPUNIT"/><hc:right value="${c(R)}" unit="HWPUNIT"/><hc:prev value="${c(P)}" unit="HWPUNIT"/><hc:next value="${c(N)}" unit="HWPUNIT"/></hh:margin>`;
    };
    // UNIT (2026-06-17, GT-RESOLVED): emit case = mm×100, default = mm×200 — this
    // is exactly Hancom-native (실험1: para-shape N mm → stored case = N×100,
    // default = N×200, no hidden factor). These values now survive Hancom web
    // round-trip 1:1 thanks to the version.xml xmlVersion 1.2→1.5 fix in
    // patchHwpxStubFingerprint. The earlier "Hancom ignores case / round-trip is
    // a fixed ~mm×50" note was WRONG — that halving was caused solely by
    // xmlVersion="1.2" (legacy-doc rescale), not by the case value. So the input
    // HWPUNIT margins (HEADING_DEFAULTS, BODY_SPACING_AFTER) now render at their
    // true mm size on Hancom; tune those constants, not this conversion.
    const sw = `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${mk(100)}${ls}</hp:case><hp:default>${mk(200)}${ls}</hp:default></hp:switch>`;
    let out = pp;
    // pull autoSpacing out (re-inserted right before the switch, native order)
    const autoM = /<hh:autoSpacing\b[^>]*\/>/.exec(out);
    const auto = autoM ? autoM[0] : "";
    if (auto) out = out.replace(/<hh:autoSpacing\b[^>]*\/>/, "");
    out = out.replace(/<hh:margin>[\s\S]*?<\/hh:margin>/, " SW ");
    out = out.replace(/<hh:lineSpacing\b[^>]*\/>/, "");        // drop the now-duplicate plain lineSpacing
    out = out.replace(" SW ", auto + sw);
    n++;
    return out;
  });
  if (n > 0) {
    zip.file("Contents/header.xml", header);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return n;
}

// Zero each top-level table's outMargin (top/bottom) so a table's vertical
// spacing comes purely from its WRAPPER PARAGRAPH's margins (set in
// append_table), which COLLAPSE with neighbours like any paragraph.
// GT (2026-06-17): Hancom COLLAPSES adjacent paragraph margins — a 10mm-after
// next to a 10mm-before renders 10mm, not 20mm ("둘 중 큰 값으로 대체", the user's
// rule). But the table object's <hp:outMargin> is NOT a paragraph margin: any
// non-zero value ADDS on top of the collapsed paragraph gap (sum), so an inflated
// outMargin over-spaced tables and made 표→heading ≠ body→heading. Zeroing it and
// giving the wrapper paragraph normal block margins lets the table collapse like
// a paragraph: 표→heading = max(table 3.5mm, heading 6mm) = 6mm = body→heading.
// left/right preserved (horizontal cell padding is unaffected).
//
// UPDATE (GT, render-mapped): below a table Hancom EATS paragraph margins (both
// the wrapper's after AND the next element's before) and renders ONLY
// outMargin.bottom; above a table the preceding paragraph's margin DOES render
// (+ outMargin.top). So om=0 makes 표→heading touch. To make 표→heading match
// body→heading (≈6mm, the heading's collapsed section gap), set outMargin to that
// gap so the below-table gap (=outMargin.bottom) equals it.
const TABLE_OUTMARGIN = 1700; // HWPUNIT ≈ 6mm — below-table section gap
const TABLE_TOP_MARGIN = 500; // HWPUNIT ≈ 1.8mm — small above-table margin (~¼ of section gap);
                              // wrapper para prev=0, so above-gap ≈ preceding.after + this (no double-stack)
async function patchHwpxTableOutMargin(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const headerEntry = zip.file("Contents/header.xml");
  let header = headerEntry ? await headerEntry.async("string") : null;
  let nextPprId = header
    ? Math.max(0, ...[...header.matchAll(/<hh:paraPr\s+id="(\d+)"/g)].map((m) => Number(m[1])))
    : 0;
  let total = 0;       // also indexes tableSpacingSpecs in document order
  let headerChanged = false;
  for (const name of Object.keys(zip.files).sort()) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    let xml = await zip.file(name).async("string");
    let changed = false;

    // Per-table bottom margin: if a HEADING follows the table, use that heading's
    // top gap so 표→제목 == 제목 위 여백 (Hancom eats a heading's own prev below a
    // table, so the below-gap must live on the table's outMargin.bottom). Else the
    // small default before body. headingPatches.paraIdx aligns with
    // topLevelParaRegions on section0 (same indexing patchHwpxHeadings relies on).
    const isSec0 = name === "Contents/section0.xml";
    const headTopGap = new Map(headingPatches.map((h) => [h.paraIdx, h.topGap]));
    const regionsPre = topLevelParaRegions(xml);
    const tableBottoms = [];
    for (let i = 0; i < regionsPre.length; i++) {
      if (!/<hp:tbl\b/.test(xml.slice(regionsPre[i].start, regionsPre[i].end))) continue;
      tableBottoms.push((isSec0 && headTopGap.has(i + 1)) ? headTopGap.get(i + 1) : null);
    }
    let tIdx = 0;

    // 1. outMargin top/bottom on each top-level table. above-gap (top) = small
    //    dedicated table margin (wrapper para prev=0 → above-gap = preceding.after
    //    collapsed + this small top ≈ 제목→글). below-gap (bottom) = the following
    //    heading's top gap (표→제목 == 글→제목) or the small default before body.
    //    A per-table spacing_before/after (tableSpacingSpecs) still overrides.
    const xml2 = xml.replace(/<hp:tbl\b[\s\S]*?<hp:tr\b/g, (seg) =>
      seg.replace(/<hp:outMargin\b[^>]*\/>/, (m) => {
        const left = TABLE_TOP_MARGIN;   // 양옆도 500(≈1.8mm)로 통일 — 사방 대칭
        const right = TABLE_TOP_MARGIN;
        const spec = tableSpacingSpecs[total] || {};
        const top = spec.before ?? TABLE_TOP_MARGIN;
        const bottom = spec.after ?? tableBottoms[tIdx] ?? TABLE_TOP_MARGIN;
        total++; tIdx++;
        return `<hp:outMargin left="${left}" right="${right}" top="${top}" bottom="${bottom}"/>`;
      }),
    );
    if (xml2 !== xml) { xml = xml2; changed = true; }

    // 2. Above a table, the preceding paragraph's margin DOES render and would
    //    ADD to outMargin.top (sum) — the user's rule is max, not sum. Neutralise
    //    the preceding top-level paragraph's spacingAfter (clone its paraPr with
    //    next=0, repoint only that paragraph) so the above-table gap is
    //    outMargin.top alone — matching the below-table gap.
    if (header) {
      const regions = topLevelParaRegions(xml);
      const edits = [];
      for (let i = 1; i < regions.length; i++) {
        if (!/<hp:tbl\b/.test(xml.slice(regions[i].start, regions[i].end))) continue;
        const prevSeg = xml.slice(regions[i - 1].start, regions[i - 1].end);
        if (/<hp:tbl\b/.test(prevSeg)) continue;
        const ref = (prevSeg.match(/paraPrIDRef="(\d+)"/) || [])[1];
        if (!ref) continue;
        const src = header.match(new RegExp(`<hh:paraPr id="${ref}"[\\s\\S]*?</hh:paraPr>`));
        if (!src) continue;
        nextPprId += 1;
        const cloneId = String(nextPprId);
        const clone = src[0]
          .replace(/^<hh:paraPr id="\d+"/, `<hh:paraPr id="${cloneId}"`)
          .replace(/(<h[hc]:next\b[^>]*\bvalue=")(-?\d+)(")/g, "$10$3");
        header = header.replace("</hh:paraProperties>", clone + "</hh:paraProperties>");
        header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (mm, a, n, b) => a + (Number(n) + 1) + b);
        headerChanged = true;
        edits.push({ region: regions[i - 1], cloneId });
      }
      edits.sort((a, b) => b.region.start - a.region.start);
      for (const e of edits) {
        const seg = xml.slice(e.region.start, e.region.end).replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${e.cloneId}"`);
        xml = xml.slice(0, e.region.start) + seg + xml.slice(e.region.end);
        changed = true;
      }
    }

    if (changed) zip.file(name, xml);
  }
  if (headerChanged && headerEntry) zip.file("Contents/header.xml", header);
  if (total > 0 || headerChanged) {
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return total;
}

// rhwp's setCellProperties writes our per-cell <hp:cellMargin> but leaves the
// cell's hasMargin="0" — which tells Hancom to IGNORE the per-cell margin and
// inherit the table/document default. So every cellMargin we set (esp. the
// vertical top/bottom) silently rendered at Hancom's tight default (GT pixel-
// measured 2026-06-19: a 737 top margin rendered ~3px until hasMargin flipped).
// set_cell_margin (hwpx-edit) sets hasMargin="1" — that's the verified mechanism.
// Flip hasMargin 0→1 on every cell that actually carries a <hp:cellMargin>, so
// our padding becomes authoritative. Tempered match stays inside each <hp:tc>.
async function patchHwpxCellHasMargin(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  let total = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    let xml = await zip.file(name).async("string");
    const before = xml;
    xml = xml.replace(
      /(<hp:tc\b[^>]*?)hasMargin="0"((?:(?!<\/hp:tc>)[^>])*>(?:(?!<\/hp:tc>)[\s\S])*?<hp:cellMargin\b)/g,
      (_m, pre, post) => { total++; return `${pre}hasMargin="1"${post}`; },
    );
    if (xml !== before) zip.file(name, xml);
  }
  if (total > 0) {
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return total;
}

// Landscape fix. rhwp exports a landscape page as <hp:pagePr landscape="WIDELY">
// but KEEPS the portrait dimensions (width < height). Hancom Docs web ignores the
// landscape enum and lays the page out from width/height alone → it renders
// portrait and wide content overflows the right edge. Force width > height (swap)
// so the web viewer renders true landscape. This mirrors hwpx-edit's set_page_setup
// (W>H is what Hancom honours).
// CALLER MUST GATE on the actual landscape request (requestedLandscape): rhwp
// stamps landscape="WIDELY" on PORTRAIT docs too, so this function does NOT look at
// the enum — it just swaps any W<H page to W>H. Calling it on a portrait doc would
// wrongly rotate it (regression fixed 2026-06-22).
async function patchHwpxLandscape(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  let total = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    let xml = await zip.file(name).async("string");
    const m = xml.match(/<hp:pagePr\b[^>]*?>/);
    if (!m) continue;
    const w = Number((m[0].match(/\bwidth="(\d+)"/) || [])[1]);
    const h = Number((m[0].match(/\bheight="(\d+)"/) || [])[1]);
    if (w && h && w < h) {
      const tag = m[0].replace(/\bwidth="\d+"/, `width="${h}"`).replace(/\bheight="\d+"/, `height="${w}"`);
      xml = xml.replace(m[0], tag);
      zip.file(name, xml);
      total++;
    }
  }
  if (total > 0) {
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return total;
}

// Inject the header-row gray shade that rhwp's setCellProperties silently drops.
// rhwp builds the header cell's BorderFill (4 solid borders) from our JSON but
// serializes an EMPTY <hc:fillBrush> — the fill color (#EAEAEA) never reaches the
// file, so the header renders unshaded on Hancom (GT 2026-06-19). We can't fix it
// in rhwp (HWP-team vendor), so we stamp the winBrush post-export. A BorderFill is
// a header target IFF it is referenced EXCLUSIVELY by row-0 cells (rowAddr==0)
// across the whole doc: append_table gives the header row its own BorderFill
// (distinct props), while a header-less table's row 0 shares the body BorderFill
// (its rowAddr set includes 1,2,… → not exclusive → left untouched). Only an
// already-EMPTY fillBrush is filled (never clobber a real fill).
const HEADER_SHADE_COLOR = "#EAEAEA";   // soft Office-style header gray (== HEADER_BG)
async function patchHwpxTableHeaderFill(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const headerEntry = zip.file("Contents/header.xml");
  if (!headerEntry) return 0;
  let header = await headerEntry.async("string");
  // borderFillIDRef -> Set of rowAddr values on cells that reference it.
  const rowsByBf = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    const re = /<hp:tc\b[^>]*\bborderFillIDRef="(\d+)"[^>]*>[\s\S]*?<hp:cellAddr\b[^>]*\browAddr="(\d+)"/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const bf = m[1], row = Number(m[2]);
      if (!rowsByBf.has(bf)) rowsByBf.set(bf, new Set());
      rowsByBf.get(bf).add(row);
    }
  }
  const headerBfs = [...rowsByBf.entries()]
    .filter(([, rows]) => rows.size === 1 && rows.has(0))
    .map(([bf]) => bf);
  if (!headerBfs.length) return 0;
  const themeShade = activeTheme.headerFill || HEADER_SHADE_COLOR;
  // Per-table caller fills (op.header_fill), in document order of header tables.
  // headerBfs is also in document order, so index n ↔ nth header table — unless
  // counts disagree (nested/odd tables), in which case fall back to the theme tint.
  const perTable = tableHeaderFills.filter((t) => t.hasHeader).map((t) => t.fill);
  const aligned = perTable.length === headerBfs.length;
  let n = 0;
  for (let idx = 0; idx < headerBfs.length; idx++) {
    const bf = headerBfs[idx];
    const shade = (aligned && perTable[idx]) || themeShade;
    const SHADE = `<hc:fillBrush><hc:winBrush faceColor="${shade}" hatchColor="${shade}" alpha="0"/></hc:fillBrush>`;
    // Tempered match keeps us inside THIS BorderFill block; only an empty fillBrush.
    const re = new RegExp(`(<hh:borderFill id="${bf}"(?:(?!</hh:borderFill>)[\\s\\S])*?)(<hc:fillBrush\\s*/>|<hc:fillBrush>\\s*</hc:fillBrush>)`);
    const before = header;
    header = header.replace(re, (_full, pre) => `${pre}${SHADE}`);
    if (header !== before) n++;
  }
  if (n > 0) {
    zip.file("Contents/header.xml", header);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return n;
}

// Remap the default char shape (charPr id=0) to the theme body font. rhwp
// resets a fair number of run charPrIDRefs to "0" on .hwpx export — notably
// in-table-cell runs (applyCharFormatInCell creates a styled charPr in
// header.xml but the cell run still serializes as id 0). Those leaked runs
// then render in the document default (함초롬), ignoring the theme. Rewriting
// charPr id=0's <hh:fontRef> to the theme body face id makes every such leaked
// run pick up the theme font — a catch-all on top of the per-paragraph
// re-links above. No-op for the government theme (bodyFont null → not called).
// The face is already registered (every body op resolved it via
// findOrCreateFontId), so we only look up its id, never add it.
async function patchHwpxDefaultFont(filePath, bodyFontName) {
  if (!bodyFontName) return 0;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const headerEntry = zip.file("Contents/header.xml");
  if (!headerEntry) return 0;
  let headerXml = await headerEntry.async("string");

  // Find the body font's face id from the HANGUL fontface block (rhwp assigns
  // the same id across every language block, so HANGUL is representative).
  const hangulBlock = (/<hh:fontface lang="HANGUL"[^>]*>[\s\S]*?<\/hh:fontface>/.exec(headerXml) || [])[0];
  if (!hangulBlock) return 0;
  const esc = bodyFontName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const faceM = new RegExp(`<hh:font id="(\\d+)"[^>]*\\bface="${esc}"`).exec(hangulBlock);
  if (!faceM) return 0; // font not registered (no body op ran) → nothing to remap
  const faceId = faceM[1];

  // Rewrite charPr id=0's fontRef so all seven language slots point at faceId.
  let patched = 0;
  headerXml = headerXml.replace(
    /(<hh:charPr id="0"[^>]*>[\s\S]*?)<hh:fontRef\b[^>]*\/>/,
    (full, head) => {
      patched++;
      return `${head}<hh:fontRef hangul="${faceId}" latin="${faceId}" hanja="${faceId}" japanese="${faceId}" other="${faceId}" symbol="${faceId}" user="${faceId}"/>`;
    },
  );

  if (patched > 0) {
    zip.file("Contents/header.xml", headerXml);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  }
  return patched;
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

// GT-confirmed table-spacing fix (see TABLE_DEFAULT_INNER_MARGIN +
// TABLE_OUTER_BOTTOM_MARGIN). Two raw-patches per table: (1) the TABLE record's
// default inner margin → `margin` on all 4 sides (cell roominess / HWPX-matched
// padding); (2) the table CTRL_HEADER's outer BOTTOM margin → `outerBottom` (gap
// below the table — Hancom-web ignores the host paragraph's spacingAfter, so this
// table-object margin is the only lever, matching HWPX's <hp:outMargin bottom>).
// True in-place raw-patch: parse the CFB ourselves and overwrite the compressed
// Section stream within its existing sector chain — NEVER CFB.write (injects the
// sheetjs Sh33tJ5 marker Hancom rejects, the reason stripHwpLayoutCache above is
// disabled). Best-effort: any section that would grow past its allocated chain is
// left untouched (the re-deflate delta is a few bytes, so this ~never happens).
function setTableInMarginInPlace(filePath, margin, outerBottom) {
  const buf = fs.readFileSync(filePath); // mutated in place, then written back
  // --- minimal CFB structural parse (read-only; no sheetjs write path) ---
  const ssz = 1 << buf.readUInt16LE(30);
  const mssz = 1 << buf.readUInt16LE(32);
  const miniCutoff = buf.readUInt32LE(56);
  const dirStart = buf.readUInt32LE(48);
  const miniFatStart = buf.readUInt32LE(60);
  const sect = (n) => 512 + n * ssz;
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v < 0xFFFFFFFE) difat.push(v);
  }
  const FAT = [];
  for (const f of difat) {
    const base = sect(f);
    for (let i = 0; i < ssz / 4; i++) FAT.push(buf.readUInt32LE(base + i * 4));
  }
  const chain = (start) => {
    const out = []; let s = start, g = 0;
    while (s !== 0xFFFFFFFE && s < 0xFFFFFFF0 && g++ < 1e6) { out.push(s); s = FAT[s]; }
    return out;
  };
  const dirSectors = chain(dirStart);
  const perDir = ssz / 128;
  const dirEntry = (i) => sect(dirSectors[Math.floor(i / perDir)]) + (i % perDir) * 128;
  const entName = (o) => {
    const len = buf.readUInt16LE(o + 64); let s = "";
    for (let i = 0; i < len / 2 - 1; i++) s += String.fromCharCode(buf.readUInt16LE(o + i * 2));
    return s;
  };
  let rootOff = null;
  const sections = [];
  for (let i = 0; i < dirSectors.length * perDir; i++) {
    const o = dirEntry(i);
    const t = buf[o + 66];
    if (!t) continue;
    if (t === 5) rootOff = o;
    if (/^Section\d+$/.test(entName(o))) sections.push(o);
  }
  if (rootOff == null || sections.length === 0) return 0;
  // Section compression follows the global FileHeader flag (byte 36, bit 0).
  // CFB.read here is read-only — the banned path is CFB.write, not CFB.read.
  let compressed = true;
  try {
    const fhc = CFB.find(CFB.read(buf, { type: "buffer" }), "/FileHeader");
    if (fhc) compressed = (Buffer.from(fhc.content)[36] & 1) === 1;
  } catch { /* default to compressed */ }
  // mini-stream plumbing (only needed for streams below the mini cutoff)
  let miniFat = [], rootChain = [], miniOff = null;
  const buildMini = () => {
    if (miniOff) return;
    const mf = chain(miniFatStart);
    const mb = Buffer.alloc(mf.length * ssz);
    mf.forEach((x, i) => buf.copy(mb, i * ssz, sect(x), sect(x) + ssz));
    for (let i = 0; i < mb.length / 4; i++) miniFat.push(mb.readUInt32LE(i * 4));
    rootChain = chain(buf.readUInt32LE(rootOff + 116));
    miniOff = (mi) => sect(rootChain[Math.floor(mi / (ssz / mssz))]) + (mi % (ssz / mssz)) * mssz;
  };
  const miniChain = (start) => {
    const out = []; let s = start, g = 0;
    while (s !== 0xFFFFFFFE && s < 0xFFFFFFF0 && g++ < 1e6) { out.push(s); s = miniFat[s]; }
    return out;
  };
  const readChain = (offs, unit, size) => {
    const o = Buffer.alloc(offs.length * unit);
    offs.forEach((dst, i) => buf.copy(o, i * unit, dst, dst + unit));
    return o.slice(0, size);
  };
  let patched = 0;
  for (const secOff of sections) {
    const secSize = buf.readUInt32LE(secOff + 120);
    const secStart = buf.readUInt32LE(secOff + 116);
    if (secSize === 0) continue;
    const inMini = secSize < miniCutoff;
    let sectorOffs;
    if (inMini) { buildMini(); sectorOffs = miniChain(secStart).map(miniOff); }
    else sectorOffs = chain(secStart).map(sect);
    const unit = inMini ? mssz : ssz;
    const comp = readChain(sectorOffs, unit, secSize);
    let data;
    try { data = compressed ? zlib.inflateRawSync(comp) : comp; }
    catch { continue; }
    // walk records; patch two things per table:
    //  (1) TABLE (tag 0x4D) inMargin → `margin` on all 4 sides (left@10, right@12,
    //      top@14, bottom@16, INT16) — the cell inner margin / row roominess.
    //  (2) the table's CTRL_HEADER (tag 0x47, ctrlId "tbl ") outer BOTTOM margin
    //      → `outerBottom`. The host paragraph's spacingAfter is IGNORED by
    //      Hancom-web for a table-only paragraph, so the gap below a table is
    //      governed by the table object's own outer margin (the .hwp analog of
    //      HWPX's <hp:outMargin bottom="500">). rhwp emits the 4 outer margins
    //      (left@28/right@30/top@32/bottom@34, INT16) as 283 (~1mm) → ~5px below
    //      the table; HWPX uses 500 → ~10px. We bump ONLY the bottom (top already
    //      matches via the preceding paragraph's spacingAfter), and only when all
    //      four read the rhwp 283 default — that confirms the offset and skips any
    //      non-default layout (e.g. treat-as-char tables) rather than risk a clobber.
    let off = 0, tablesHit = 0, ctrlHit = 0;
    while (off + 4 <= data.length) {
      const h = data.readUInt32LE(off);
      const tag = h & 0x3FF;
      let size = (h >>> 20) & 0xFFF, hl = 4;
      if (size === 0xFFF) { size = data.readUInt32LE(off + 4); hl = 8; }
      if (tag === 0x4D && size >= 18) {
        const d = off + hl;
        let changed = false;
        for (const o of [10, 12, 14, 16]) {
          if (data.readInt16LE(d + o) !== margin) { data.writeInt16LE(margin, d + o); changed = true; }
        }
        if (changed) tablesHit++;
      } else if (tag === 0x47 && size >= 36 && outerBottom != null) {
        const d = off + hl;
        // ctrlId is stored reversed: bytes ' lbt' == "tbl "
        const isTbl = data[d] === 0x20 && data[d + 1] === 0x6C && data[d + 2] === 0x62 && data[d + 3] === 0x74;
        const om = [28, 30, 32, 34];
        if (isTbl && om.every((o) => data.readInt16LE(d + o) === 283)) {
          if (data.readInt16LE(d + 34) !== outerBottom) { data.writeInt16LE(outerBottom, d + 34); ctrlHit++; }
        }
      }
      off += hl + size;
    }
    if (tablesHit === 0 && ctrlHit === 0) continue;
    const newComp = compressed ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const capacity = sectorOffs.length * unit;
    if (newComp.length > capacity) continue; // would grow the chain — skip (best-effort)
    for (let i = 0; i < sectorOffs.length; i++) {
      const dst = sectorOffs[i];
      for (let j = 0; j < unit; j++) {
        const di = i * unit + j;
        buf[dst + j] = di < newComp.length ? newComp[di] : 0;
      }
    }
    buf.writeUInt32LE(newComp.length, secOff + 120);
    patched += tablesHit + ctrlHit;
  }
  if (patched > 0) fs.writeFileSync(filePath, buf);
  return patched;
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
  // Resolve the run's theme (heading colour + font) from the payload before the
  // op loop. Defaults to government; unknown names fall back with a logged note.
  // Applies to the from-scratch / rhwp-emit path (append_*); raw-patch ops keep
  // the existing document's styling.
  activeTheme = resolveTheme(payload, log);
  if (!outPath) {
    process.stdout.write(JSON.stringify({ status: "error", message: "'path' is required" }) + "\n");
    process.exit(1);
  }

  const ext = path.extname(outPath).toLowerCase();
  if (ext !== ".hwp" && ext !== ".hwpx") {
    process.stdout.write(JSON.stringify({ status: "error", message: `path must end in .hwp or .hwpx (got ${ext})` }) + "\n");
    process.exit(1);
  }

  // Resolve the document theme once, up front, so every append_* op below sees
  // the right fonts/colours. `theme` selects a base; `theme_overrides` tweaks
  // it. Defaults to government (== prior behaviour) when omitted.
  activeTheme = resolveTheme(payload, log);

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
  // Cell styling via raw-patch — background shading, borders, diagonals.
  // Each merges its change into the cell's EXISTING BorderFill (preserving the
  // parts it doesn't touch) and repoints just that cell's LIST_HEADER
  // borderFillId. See cell-patch.js applyCellStyleInPlace.
  const CELL_STYLE_OPS = new Set(['set_cell_background', 'set_cell_border', 'set_cell_diagonal']);
  // Paragraph list formatting via raw-patch — turns an existing paragraph into
  // a numbered/bulleted item by setting its PARA_SHAPE heading kind + a
  // NUMBERING/BULLET id ref (records appended to DocInfo). See cell-patch.js
  // applyListInPlace.
  const LIST_OPS = new Set(['set_numbered_list', 'set_bullet_list']);
  // Table-cell properties (valign / size / margins) via raw-patch — patches the
  // cell LIST_HEADER directly (no DocInfo change). See applyCellPropertyInPlace.
  const CELL_PROP_OPS = new Set(['set_cell_property']);
  // Table-level properties (outer margin) via raw-patch — patches the table
  // CTRL_HEADER " lbt" directly (no DocInfo change). See applyTablePropertyInPlace.
  const TABLE_PROP_OPS = new Set(['set_table_property']);
  // Drawing-object (shape/image) properties (fill / border / outer margin) via
  // raw-patch — patches the gso CTRL_HEADER + SHAPE_COMPONENT. See applyObjectPropertyInPlace.
  const OBJECT_PROP_OPS = new Set(['set_object_property']);
  // Table structure: merge a rectangular block of cells (raw-patch — sets the
  // top-left cell's span, deletes the absorbed cell clusters, fixes the TABLE
  // row-size array). See cell-patch.js mergeCellsInPlace.
  const MERGE_OPS = new Set(['merge_cells']);
  // Table structure: delete a whole row (raw-patch — TABLE rows−1 + row-size
  // entry removed, the row's cells deleted, cells below renumbered). See
  // cell-patch.js deleteTableRowInPlace.
  const DELROW_OPS = new Set(['delete_table_row', 'delete_table_col']);
  // Table structure: insert a blank row (raw-patch — TABLE rows+1, new row-size
  // entry, blank cells cloned from empty cells, cells below renumbered). See
  // cell-patch.js insertTableRowInPlace.
  const INSROW_OPS = new Set(['insert_table_row', 'insert_table_col']);
  // Table structure: split one cell into N stacked rows (raw-patch). See
  // cell-patch.js splitCellInPlace.
  const SPLIT_OPS = new Set(['split_cell']);
  // 문단 띠 / horizontal divider line (raw-patch — inserts a new paragraph
  // holding a gso rectangle the width of the text column). Self-contained in
  // Section0; no DocInfo change. See cell-patch.js insertParaLineInPlace.
  const PARALINE_OPS = new Set(['insert_para_line']);
  // 누름틀 / form field (raw-patch — HWP field mechanism: inline field-begin/
  // end chars + a '%clk' CTRL_HEADER command string). Self-contained in
  // Section0; no DocInfo change. See cell-patch.js insertFieldInPlace.
  const FIELD_OPS = new Set(['insert_field']);
  // 하이퍼링크 (raw-patch — same HWP field mechanism, '%hlk', wraps existing
  // anchor text). Functional link; not auto-styled blue/underline (layer
  // apply_text_style for that). See cell-patch.js insertHyperlinkInPlace.
  const HYPERLINK_OPS = new Set(['insert_hyperlink']);
  // 책갈피 (raw-patch — invisible point-marker: inline char 0x16 + 'bokm' ctrl
  // + 0x57 name data; byte-identical to Hancom's own bookmark). No DocInfo
  // change. See cell-patch.js insertBookmarkInPlace.
  const BOOKMARK_OPS = new Set(['insert_bookmark']);
  // 글상자 (raw-patch — rect gso + inner text). See cell-patch.js insertTextboxInPlace.
  const TEXTBOX_OPS = new Set(['insert_textbox']);
  // 각주/미주 (raw-patch — inline note-ref char + a nested note-content
  // cluster; resolves the doc's standard "Footnote"/"Endnote" style, no
  // DocInfo write). See cell-patch.js insertFootnoteInPlace/insertEndnoteInPlace.
  const FOOTNOTE_OPS = new Set(['insert_footnote']);
  const ENDNOTE_OPS = new Set(['insert_endnote']);
  // 쪽 번호 (raw-patch — footer control holding the page-number auto-field;
  // alignment references an existing matching para_shape, no DocInfo write).
  // See cell-patch.js insertPageNumberInPlace.
  const PAGENUM_OPS = new Set(['insert_page_number']);
  // 다단 (raw-patch — patch the section's 'cold' column-def control to N
  // columns). For editing existing docs; new docs can use setup_columns on the
  // rhwp create path. See cell-patch.js setColumnsInPlace.
  const SET_COLUMNS_OPS = new Set(['set_columns']);
  // 스타일 적용 (raw-patch — repoint a paragraph's style + para_shape to a
  // named style; length-preserving, no DocInfo write). See cell-patch.js
  // applyNamedStyleInPlace.
  const STYLE_OPS = new Set(['apply_style']);
  // 머리말/꼬리말 텍스트 (raw-patch — header/footer control holding a user-text
  // paragraph; same infra as page-number, no DocInfo write). See cell-patch.js
  // insertHeaderFooterTextInPlace.
  const HEADERFOOTER_OPS = new Set(['insert_header_text', 'insert_footer_text']);
  // 셀 너비/높이 같게 (raw-patch — make a whole table's columns/rows equal;
  // length-preserving LIST_HEADER width/height edit, no DocInfo write).
  // See cell-patch.js equalizeTableInPlace.
  const EQUALIZE_OPS = new Set(['equalize_table_columns', 'equalize_table_rows']);
  // 도형 (raw-patch — gso drawing object: rectangle / ellipse, floating, no
  // DocInfo write). See cell-patch.js insertShapeInPlace.
  const SHAPE_OPS = new Set(['insert_shape']);
  // 그림/이미지 (raw-patch — Hancom-Docs compatible: creates the BinData
  // storage folder + stream, DocInfo BIN_DATA def, and a gso "$pic" cluster
  // reproduced from Hancom's own output). See cell-patch.js insertImageInPlace.
  const IMAGE_RAWPATCH_OPS = new Set(['insert_image']);
  // 차트 (raw-patch — gso "ole$" object + a deflated chart OLE stream, one of
  // 20 GT'd per-type templates; Hancom re-renders from the OLE's embedded
  // OOXMLChartContents). op fields: chart_type 0-19, anchor, optional
  // rows/cols/categories/series/data (edit the chart's grid), float:true to
  // keep it floating instead of the default like-char placement. Clean docs
  // only for now. See cell-patch.js insertChartInPlace.
  const CHART_OPS = new Set(['insert_chart']);
  // 도장/서명 (seal) — anchor 어구에 PNG floating("front") 배치, 폰트메트릭 자동위치 (raw-patch). See cell-patch.js placeSealInPlace.
  const PLACE_SEAL_OPS = new Set(['place_seal']);
  // 객체 삭제 (그림·차트·도형) — gso 제거 + BinData 리넘버링 (raw-patch). See cell-patch.js deleteObjectInPlace.
  const DELETE_OBJECT_OPS = new Set(['delete_object']);
  // 수식 (equation) — raw-patch into an existing doc / table cell (EQEDIT "deqe"
  // control). op fields: script (Hancom equation source), anchor, or
  // cell:{row,col,para?,control?} to drop it inside a cell (centered). NOTE:
  // distinct from append_equation, which is the from-scratch rhwp-emit path.
  // See cell-patch.js insertEquationInPlace.
  const EQUATION_OPS = new Set(['insert_equation']);
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
  const RAW_PATCH_OPS = new Set([...CELL_OPS, ...REPLACE_TEXT_OPS, ...APPEND_PARA_OPS, ...APPEND_TABLE_OPS, ...SETUP_DOC_OPS, ...APPLY_TEXT_STYLE_OPS, ...APPLY_PARAGRAPH_STYLE_OPS, ...CELL_STYLE_OPS, ...LIST_OPS, ...CELL_PROP_OPS, ...TABLE_PROP_OPS, ...OBJECT_PROP_OPS, ...MERGE_OPS, ...DELROW_OPS, ...INSROW_OPS, ...SPLIT_OPS, ...PARALINE_OPS, ...FIELD_OPS, ...HYPERLINK_OPS, ...BOOKMARK_OPS, ...FOOTNOTE_OPS, ...ENDNOTE_OPS, ...PAGENUM_OPS, ...SET_COLUMNS_OPS, ...STYLE_OPS, ...HEADERFOOTER_OPS, ...EQUALIZE_OPS, ...SHAPE_OPS, ...TEXTBOX_OPS, ...IMAGE_RAWPATCH_OPS, ...CHART_OPS, ...PLACE_SEAL_OPS, ...DELETE_OBJECT_OPS, ...EQUATION_OPS]);
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
              // __dirname (via fileURLToPath) — NOT new URL(...).pathname, which
              // on Windows yields "/C:/…" and path.resolve doubles it to "C:\C:\…".
              path.resolve(__dirname, "vendor/rhwp/rhwp_bg.wasm")
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
                    // __dirname (fileURLToPath) — new URL(...).pathname gives
                    // "/C:/…" on Windows, which path.resolve doubles to "C:\C:\…".
                    path.resolve(__dirname, 'vendor/rhwp/rhwp_bg.wasm')
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
      const cellStyleOps = ops.filter((o) => CELL_STYLE_OPS.has(o.type));
      if (cellStyleOps.length > 0) {
        const { applyCellStyleInPlace } = await import('./cell-patch.js');
        const csSummary = await applyCellStyleInPlace(outPath, cellStyleOps);
        subModes.push(`cell_style:${csSummary.mode || 'in-place'}`);
        for (const e of csSummary) allEdits.push({ kind: 'cell_style', ...e });
      }
      const listOps = ops.filter((o) => LIST_OPS.has(o.type));
      if (listOps.length > 0) {
        const { applyListInPlace } = await import('./cell-patch.js');
        const lsSummary = await applyListInPlace(outPath, listOps);
        subModes.push(`list:${lsSummary.mode || 'in-place'}`);
        for (const e of lsSummary) allEdits.push({ kind: 'list', ...e });
      }
      const cellPropOps = ops.filter((o) => CELL_PROP_OPS.has(o.type));
      if (cellPropOps.length > 0) {
        const { applyCellPropertyInPlace } = await import('./cell-patch.js');
        const cpSummary = await applyCellPropertyInPlace(outPath, cellPropOps);
        subModes.push(`cell_prop:${cpSummary.mode || 'in-place'}`);
        for (const e of cpSummary) allEdits.push({ kind: 'cell_prop', ...e });
      }
      const tablePropOps = ops.filter((o) => TABLE_PROP_OPS.has(o.type));
      if (tablePropOps.length > 0) {
        const { applyTablePropertyInPlace } = await import('./cell-patch.js');
        const tpSummary = await applyTablePropertyInPlace(outPath, tablePropOps);
        subModes.push(`table_prop:${tpSummary.mode || 'in-place'}`);
        for (const e of tpSummary) allEdits.push({ kind: 'table_prop', ...e });
      }
      // NOTE: set_object_property is dispatched LATER (after the object-insert
      // blocks below) so a single batch can insert a shape/chart and then style
      // it — object inserts must run before the property edit can find them.
      const mergeOps = ops.filter((o) => MERGE_OPS.has(o.type));
      if (mergeOps.length > 0) {
        const { mergeCellsInPlace } = await import('./cell-patch.js');
        const mgSummary = await mergeCellsInPlace(outPath, mergeOps);
        subModes.push(`merge:${mgSummary.mode || 'in-place'}`);
        for (const e of mgSummary) allEdits.push({ kind: 'merge', ...e });
      }
      const delRowOps = ops.filter((o) => o.type === 'delete_table_row');
      if (delRowOps.length > 0) {
        const { deleteTableRowInPlace } = await import('./cell-patch.js');
        const drSummary = await deleteTableRowInPlace(outPath, delRowOps);
        subModes.push(`delrow:${drSummary.mode || 'in-place'}`);
        for (const e of drSummary) allEdits.push({ kind: 'delete_row', ...e });
      }
      const delColOps = ops.filter((o) => o.type === 'delete_table_col');
      if (delColOps.length > 0) {
        const { deleteTableColInPlace } = await import('./cell-patch.js');
        const dcSummary = await deleteTableColInPlace(outPath, delColOps);
        subModes.push(`delcol:${dcSummary.mode || 'in-place'}`);
        for (const e of dcSummary) allEdits.push({ kind: 'delete_col', ...e });
      }
      const insRowOps = ops.filter((o) => o.type === 'insert_table_row');
      if (insRowOps.length > 0) {
        const { insertTableRowInPlace } = await import('./cell-patch.js');
        const irSummary = await insertTableRowInPlace(outPath, insRowOps);
        subModes.push(`insrow:${irSummary.mode || 'in-place'}`);
        for (const e of irSummary) allEdits.push({ kind: 'insert_row', ...e });
      }
      const insColOps = ops.filter((o) => o.type === 'insert_table_col');
      if (insColOps.length > 0) {
        const { insertTableColInPlace } = await import('./cell-patch.js');
        const icSummary = await insertTableColInPlace(outPath, insColOps);
        subModes.push(`inscol:${icSummary.mode || 'in-place'}`);
        for (const e of icSummary) allEdits.push({ kind: 'insert_col', ...e });
      }
      const splitOps = ops.filter((o) => SPLIT_OPS.has(o.type));
      if (splitOps.length > 0) {
        const { splitCellInPlace } = await import('./cell-patch.js');
        const spSummary = await splitCellInPlace(outPath, splitOps);
        subModes.push(`split:${spSummary.mode || 'in-place'}`);
        for (const e of spSummary) allEdits.push({ kind: 'split', ...e });
      }
      // insert_para_line is dispatched LATER (after the object-insert + table
      // ops) — it adds a new body paragraph, which would shift the absolute
      // para indices that table-cell-targeting ops rely on if it ran first.
      const fieldOps = ops.filter((o) => FIELD_OPS.has(o.type));
      if (fieldOps.length > 0) {
        const { insertFieldInPlace } = await import('./cell-patch.js');
        const fSummary = await insertFieldInPlace(outPath, fieldOps);
        subModes.push(`field:${fSummary.mode || 'in-place'}`);
        for (const e of fSummary) allEdits.push({ kind: 'field', ...e });
      }
      const hyperlinkOps = ops.filter((o) => HYPERLINK_OPS.has(o.type));
      if (hyperlinkOps.length > 0) {
        const { insertHyperlinkInPlace } = await import('./cell-patch.js');
        const hlSummary = await insertHyperlinkInPlace(outPath, hyperlinkOps);
        subModes.push(`hyperlink:${hlSummary.mode || 'in-place'}`);
        for (const e of hlSummary) allEdits.push({ kind: 'hyperlink', ...e });
      }
      const bookmarkOps = ops.filter((o) => BOOKMARK_OPS.has(o.type));
      if (bookmarkOps.length > 0) {
        const { insertBookmarkInPlace } = await import('./cell-patch.js');
        const bmSummary = await insertBookmarkInPlace(outPath, bookmarkOps);
        subModes.push(`bookmark:${bmSummary.mode || 'in-place'}`);
        for (const e of bmSummary) allEdits.push({ kind: 'bookmark', ...e });
      }
      const textboxOps = ops.filter((o) => TEXTBOX_OPS.has(o.type));
      if (textboxOps.length > 0) {
        const { insertTextboxInPlace } = await import('./cell-patch.js');
        const tbSummary = await insertTextboxInPlace(outPath, textboxOps);
        subModes.push(`textbox:${tbSummary.mode || 'in-place'}`);
        for (const e of tbSummary) allEdits.push({ kind: 'textbox', ...e });
      }
      const footnoteOps = ops.filter((o) => FOOTNOTE_OPS.has(o.type));
      if (footnoteOps.length > 0) {
        const { insertFootnoteInPlace } = await import('./cell-patch.js');
        const fnSummary = await insertFootnoteInPlace(outPath, footnoteOps);
        subModes.push(`footnote:${fnSummary.mode || 'in-place'}`);
        for (const e of fnSummary) allEdits.push({ kind: 'footnote', ...e });
      }
      const endnoteOps = ops.filter((o) => ENDNOTE_OPS.has(o.type));
      if (endnoteOps.length > 0) {
        const { insertEndnoteInPlace } = await import('./cell-patch.js');
        const enSummary = await insertEndnoteInPlace(outPath, endnoteOps);
        subModes.push(`endnote:${enSummary.mode || 'in-place'}`);
        for (const e of enSummary) allEdits.push({ kind: 'endnote', ...e });
      }
      const pageNumOps = ops.filter((o) => PAGENUM_OPS.has(o.type));
      if (pageNumOps.length > 0) {
        const { insertPageNumberInPlace } = await import('./cell-patch.js');
        const pnSummary = await insertPageNumberInPlace(outPath, pageNumOps);
        subModes.push(`page_number:${pnSummary.mode || 'in-place'}`);
        for (const e of pnSummary) allEdits.push({ kind: 'page_number', ...e });
      }
      const setColumnsOps = ops.filter((o) => SET_COLUMNS_OPS.has(o.type));
      if (setColumnsOps.length > 0) {
        const { setColumnsInPlace } = await import('./cell-patch.js');
        const scSummary = await setColumnsInPlace(outPath, setColumnsOps);
        subModes.push(`set_columns:${scSummary.mode || 'in-place'}`);
        for (const e of scSummary) allEdits.push({ kind: 'set_columns', ...e });
      }
      const styleOps = ops.filter((o) => STYLE_OPS.has(o.type));
      if (styleOps.length > 0) {
        const { applyNamedStyleInPlace } = await import('./cell-patch.js');
        const stSummary = await applyNamedStyleInPlace(outPath, styleOps);
        subModes.push(`apply_style:${stSummary.mode || 'in-place'}`);
        for (const e of stSummary) allEdits.push({ kind: 'apply_style', ...e });
      }
      const hfOps = ops.filter((o) => HEADERFOOTER_OPS.has(o.type)).map((o) => ({
        ...o, where: o.type === 'insert_header_text' ? 'header' : 'footer',
      }));
      if (hfOps.length > 0) {
        const { insertHeaderFooterTextInPlace } = await import('./cell-patch.js');
        const hfSummary = await insertHeaderFooterTextInPlace(outPath, hfOps);
        subModes.push(`header_footer:${hfSummary.mode || 'in-place'}`);
        for (const e of hfSummary) allEdits.push({ kind: 'header_footer', ...e });
      }
      const eqOps = ops.filter((o) => EQUALIZE_OPS.has(o.type)).map((o) => ({
        ...o, dim: o.type === 'equalize_table_rows' ? 'height' : 'width',
      }));
      if (eqOps.length > 0) {
        const { equalizeTableInPlace } = await import('./cell-patch.js');
        const eqSummary = await equalizeTableInPlace(outPath, eqOps);
        subModes.push(`equalize:${eqSummary.mode || 'in-place'}`);
        for (const e of eqSummary) allEdits.push({ kind: 'equalize', ...e });
      }
      const shapeOps = ops.filter((o) => SHAPE_OPS.has(o.type));
      if (shapeOps.length > 0) {
        const { insertShapeInPlace } = await import('./cell-patch.js');
        const shSummary = await insertShapeInPlace(outPath, shapeOps);
        subModes.push(`shape:${shSummary.mode || 'in-place'}`);
        for (const e of shSummary) allEdits.push({ kind: 'shape', ...e });
      }
      const imgRawOps = ops.filter((o) => IMAGE_RAWPATCH_OPS.has(o.type));
      if (imgRawOps.length > 0) {
        const { insertImageInPlace } = await import('./cell-patch.js');
        const imSummary = await insertImageInPlace(outPath, imgRawOps);
        subModes.push(`image:${imSummary.mode || 'in-place'}`);
        for (const e of imSummary) allEdits.push({ kind: 'image', ...e });
      }
      const sealOps = ops.filter((o) => o.type === 'place_seal');
      if (sealOps.length > 0) {
        const { placeSealInPlace } = await import('./cell-patch.js');
        const sealSummary = await placeSealInPlace(outPath, sealOps);
        subModes.push(`place_seal:${sealSummary.mode || 'in-place'}`);
        for (const e of sealSummary) allEdits.push({ kind: 'place_seal', ...e });
      }
      const chartOps = ops.filter((o) => CHART_OPS.has(o.type));
      if (chartOps.length > 0) {
        const { insertChartInPlace } = await import('./cell-patch.js');
        const chSummary = await insertChartInPlace(outPath, chartOps);
        subModes.push(`chart:${chSummary.mode || 'in-place'}`);
        for (const e of chSummary) allEdits.push({ kind: 'chart', ...e });
      }
      const deleteObjOps = ops.filter((o) => DELETE_OBJECT_OPS.has(o.type));
      if (deleteObjOps.length > 0) {
        const { deleteObjectInPlace } = await import('./cell-patch.js');
        // Delete highest index first so a delete never shifts a later target's index.
        const ordered = [...deleteObjOps].sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
        const delSummary = await deleteObjectInPlace(outPath, ordered);
        subModes.push(`delete_object:${delSummary.mode || 'in-place'}`);
        for (const e of delSummary) allEdits.push({ kind: 'delete_object', ...e });
      }
      const equationOps = ops.filter((o) => EQUATION_OPS.has(o.type));
      if (equationOps.length > 0) {
        const { insertEquationInPlace } = await import('./cell-patch.js');
        const eqSummary = await insertEquationInPlace(outPath, equationOps);
        subModes.push(`equation:${eqSummary.mode || 'in-place'}`);
        for (const e of eqSummary) allEdits.push({ kind: 'equation', ...e });
      }
      // set_object_property runs AFTER the object-insert blocks above so an
      // insert-then-style batch (e.g. insert_shape + set_object_property) finds
      // the just-inserted object instead of running before it exists.
      const objectPropOps = ops.filter((o) => OBJECT_PROP_OPS.has(o.type));
      if (objectPropOps.length > 0) {
        const { applyObjectPropertyInPlace } = await import('./cell-patch.js');
        const opSummary = await applyObjectPropertyInPlace(outPath, objectPropOps);
        subModes.push(`object_prop:${opSummary.mode || 'in-place'}`);
        for (const e of opSummary) allEdits.push({ kind: 'object_prop', ...e });
      }
      // Body-paragraph inserts that shift absolute para indices run LAST (after
      // every table-cell-targeting op) so they don't move a table out from under
      // an op that addresses it by para index.
      const paraLineOps = ops.filter((o) => PARALINE_OPS.has(o.type));
      if (paraLineOps.length > 0) {
        const { insertParaLineInPlace } = await import('./cell-patch.js');
        const plSummary = await insertParaLineInPlace(outPath, paraLineOps);
        subModes.push(`para_line:${plSummary.mode || 'in-place'}`);
        for (const e of plSummary) allEdits.push({ kind: 'para_line', ...e });
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

  // Page margins: rhwp ignores PageDef margins for .hwpx, so stamp the
  // requested ones into the section pagePr.
  if (ext === ".hwpx" && hwpxPageMargin) {
    try {
      const n = await patchHwpxPageMargin(outPath, hwpxPageMargin);
      if (n) log.push(`hwpx_patch: page margin L${hwpxPageMargin.left}/R${hwpxPageMargin.right}/T${hwpxPageMargin.top}/B${hwpxPageMargin.bottom} HWPUNIT (${n} section)`);
    } catch (err) {
      log.push(`hwpx_page_margin failed: ${err.message}`);
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

  // Same re-link fix for body-paragraph run styling (size/colour/bold/etc.),
  // which rhwp likewise drops to charPrIDRef="0" on .hwpx export.
  if (ext === ".hwpx" && bodyStylePatches.length > 0) {
    try {
      const n = await patchHwpxBodyRunStyles(outPath, bodyStylePatches);
      if (n > 0) log.push(`hwpx_patch: fixed ${n} body run charPrIDRef`);
    } catch (err) {
      log.push(`hwpx_bodystyle_patch failed: ${err.message}`);
    }
  }

  // Re-split mixed-style paragraphs rhwp coalesced into one run (inline
  // **bold**, per-run colour/font). Runs after the uniform re-link (disjoint
  // paragraph sets) and before the default-font remap.
  if (ext === ".hwpx" && mixedRunPatches.length > 0) {
    try {
      const n = await patchHwpxMixedRuns(outPath, mixedRunPatches);
      if (n > 0) log.push(`hwpx_patch: re-split ${n} mixed-run paragraph(s)`);
    } catch (err) {
      log.push(`hwpx_mixedrun_patch failed: ${err.message}`);
    }
  }

  // Theme body font: remap default charPr id=0 → theme body face, so any run
  // rhwp left pointing at id 0 (notably table-cell text) still renders in the
  // theme font. No-op for the government theme (bodyFont null).
  if (ext === ".hwpx" && activeTheme.bodyFont) {
    try {
      const n = await patchHwpxDefaultFont(outPath, activeTheme.bodyFont);
      if (n > 0) log.push(`hwpx_patch: remapped default font → ${activeTheme.bodyFont}`);
    } catch (err) {
      log.push(`hwpx_defaultfont_patch failed: ${err.message}`);
    }
  }

  // Convert plain paraPr margins → Hancom-native hp:switch so paragraph spacing
  // (heading before/after, indent, lineSpacing) survives the Hancom-web open.
  if (ext === ".hwpx") {
    try {
      const n = await patchHwpxParaSpacing(outPath);
      if (n > 0) log.push(`hwpx_patch: ${n} paraPr → hp:switch spacing`);
    } catch (err) {
      log.push(`hwpx_paraspacing_patch failed: ${err.message}`);
    }
  }

  // Tables: zero outMargin so the wrapper paragraph's margins (set in
  // append_table) collapse with neighbours like any paragraph — see
  // patchHwpxTableOutMargin. Keeps 표→heading == body→heading (collapse, not sum).
  if (ext === ".hwpx") {
    try {
      const n = await patchHwpxTableOutMargin(outPath);
      if (n > 0) log.push(`hwpx_patch: ${n} table outMargin → 0 (collapse via wrapper para)`);
    } catch (err) {
      log.push(`hwpx_tableoutmargin_patch failed: ${err.message}`);
    }
  }

  // Cell padding: flip hasMargin 0→1 so Hancom honors our per-cell <hp:cellMargin>
  // (rhwp leaves it 0 → margins silently ignored). See patchHwpxCellHasMargin.
  if (ext === ".hwpx") {
    try {
      const n = await patchHwpxCellHasMargin(outPath);
      if (n > 0) log.push(`hwpx_patch: ${n} cell hasMargin 0→1 (honor cellMargin)`);
    } catch (err) {
      log.push(`hwpx_cellhasmargin_patch failed: ${err.message}`);
    }
  }

  // Landscape: rhwp keeps portrait W<H even with landscape="WIDELY" → Hancom web
  // renders portrait. Swap to W>H so it lays out landscape. ONLY when the caller
  // actually requested landscape — rhwp stamps landscape="WIDELY" on portrait docs
  // too, so gating on the enum would flip every portrait page. See patchHwpxLandscape.
  if (ext === ".hwpx" && requestedLandscape) {
    try {
      const n = await patchHwpxLandscape(outPath);
      if (n > 0) log.push(`hwpx_patch: landscape page W↔H swap (Hancom-web orientation)`);
    } catch (err) {
      log.push(`hwpx_landscape_patch failed: ${err.message}`);
    }
  }

  // Header-row shade: stamp the gray winBrush rhwp dropped (setCellProperties
  // builds the borderFill but emits an empty <hc:fillBrush>). See
  // patchHwpxTableHeaderFill — only borderFills used exclusively by row-0 cells.
  if (ext === ".hwpx") {
    try {
      const n = await patchHwpxTableHeaderFill(outPath);
      if (n > 0) log.push(`hwpx_patch: ${n} header-row borderFill → gray shade`);
    } catch (err) {
      log.push(`hwpx_tableheaderfill_patch failed: ${err.message}`);
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

  // Strip rhwp's <hp:linesegarray> layout cache from .hwpx sections. rhwp pre-fills
  // cached line positions (placeholder vertpos/vertsize, e.g. table-cell paras get
  // vertsize=1000 + a garbage cellSz width="1"). Hancom web TRUSTS that cache for
  // the first render and pins text to it — which is why a cell's <hp:cellMargin>
  // (셀 안 여백) was stored but NOT shown (GT debug 2026-06-18: Hancom-native tables
  // carry NO linesegarray and DO render cellMargin; our rhwp tables carried it and
  // didn't). Stripping it makes Hancom recompute layout from paraPr/cell props on
  // open — exactly what Hancom does on its own save. .hwpx only (pure XML); the .hwp
  // CFB variant stays disabled (sheetjs CFB.write was Hancom-Docs-incompatible).
  if (ext === ".hwpx") {
    try {
      const n = await stripHwpxLayoutCache(outPath);
      if (n > 0) log.push(`hwpx_patch: stripped ${n} linesegarray layout-cache block(s)`);
    } catch (err) {
      log.push(`hwpx_layoutcache_strip failed: ${err.message}`);
    }
  }

  // .hwp table-spacing fix (raw-patch, no CFB.write): (1) every TABLE record's
  // default inner margin → 400 on all 4 sides (cell roominess + HWPX-matched
  // horizontal padding — Hancom-web lays out from the table default, not per-cell);
  // (2) each table CTRL_HEADER's outer BOTTOM margin → 500 so the gap below the
  // table matches the HWPX track (~10px). See setTableInMarginInPlace().
  if (ext === ".hwp") {
    try {
      const n = setTableInMarginInPlace(outPath, TABLE_DEFAULT_INNER_MARGIN, TABLE_OUTER_BOTTOM_MARGIN);
      if (n > 0) log.push(`hwp_patch: ${n} table margin field(s) → inMargin ${TABLE_DEFAULT_INNER_MARGIN} (4 sides) + outer-bottom ${TABLE_OUTER_BOTTOM_MARGIN} (HWPX-matched)`);
    } catch (err) {
      log.push(`hwp_table_margin_patch failed: ${err.message}`);
    }
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
