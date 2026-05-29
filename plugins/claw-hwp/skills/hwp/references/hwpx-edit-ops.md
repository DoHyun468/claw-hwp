# `hwpx-edit.js` operation vocabulary

`scripts/hwpx-edit.js` edits an existing **`.hwpx`** by applying named operations
directly to its OWPML XML (via the vendored `fflate` zip), then repackaging. It
never touches HWP 5.0 binary (`.hwp`) — that path is `cell-patch.js` / Path B.

## Invocation

```bash
echo '{ "path": "in.hwpx", "output": "out.hwpx", "operations": [ ... ] }' \
  | node scripts/hwpx-edit.js
```

- **`path`** (required) — input `.hwpx`. Rejected with a clear error if it isn't a ZIP-based `.hwpx`.
- **`output`** (optional) — defaults to `<input>_edited.hwpx`. Set it equal to `path` to overwrite in place.
- **`operations`** — array applied **in order** in a single load→save.

Returns JSON: `{ "ok": true, "output": "...", "results": [ { "type": ..., ...stats } ] }`.

**Atomic:** if any op throws, **nothing is saved** and the response is
`{ "ok": false, "error": "operation <i> (<type>) failed: ..." }`. Fix the args and re-run the whole batch.

## Indexing model

- **Paragraph index** — 0-based, document order, counting **top-level `<hp:p>`** across all `Contents/section*.xml` (a table-bearing paragraph counts as one). Paragraphs inside table cells are not in this index.
- **Table index** — 0-based, document order, **top-level `<hp:tbl>`** only (a table nested inside a cell is not separately indexed). This differs from a naive "all `<hp:tbl>`" count.
- **row / col** — 0-based within a table. `set_cell_text` targets by `<hp:cellAddr>` (merge-aware) and falls back to positional.

Discover indices with `node scripts/extract_text.js --inspect file.hwpx` (counts) and
`--format markdown` (table contents in order). **Note:** `extract_text.js`'s plain-text
output skips cell content — to locate a specific cell, use `--format markdown` (renders
each table) or rely on `--inspect`'s `cellCount` and open the doc to confirm.

> **Indexing trap** — `--inspect`'s `paragraphCount` counts EVERY `<hp:p>` in the doc, including ones inside table cells (e.g. 46 for a doc whose op-facing top-level count is 4). Op `index` args are top-level only — the two numbers DIVERGE on any doc with tables. To count top-level paragraphs reliably, run `--format markdown` (one block per top-level paragraph) or read `Contents/section0.xml` and walk `<hp:p>` at depth 1.

## Operations

### Text

| `type` | Args | Notes |
|--------|------|-------|
| `replace_text` | `find`, `replace` | Replaces inside `<hp:t>` nodes only. A match must sit within one text node — targets split across runs (e.g. "산업"+"AI") are not joined. |
| `fill_template` | `values` (object `{ "{{k}}": "v" }`) | Multiple `replace_text` in one pass. Returns `total` + `perKey`. |
| `set_paragraph_text` | `index`, `text` | Replaces the whole paragraph body with one run (keeps its first `charPrIDRef`). |
| `set_field_value` | `name`, `value` | Sets text inside the first `<hp:fldBegin name=...>`…`<hp:fldEnd>` pair. `set: 0` if no such field. |

### Paragraphs

| `type` | Args | Notes |
|--------|------|-------|
| `append_paragraph` | `text` | Appends to the last section, cloning the last paragraph's para/char refs. **Returns `index` of the new paragraph in the response — use it to chain follow-up index-based ops without manual counting.** **Char-style inheritance:** if the immediately preceding paragraph carries inline styling (bold / italic / highlight via its charPr), the new paragraph inherits that ref and renders with the same style. **paraPr inheritance** is the same — alignment (CENTER / JUSTIFY / etc.), line spacing, indent all clone from the previous paragraph. Drop unwanted inheritance with a follow-up `apply_text_style` (`bold: false`, etc.) or `apply_paragraph_style` (`align: "LEFT"`, etc.). |
| `delete_paragraph` | `index` | Removes the Nth top-level paragraph. |
| `set_page_break` | `index`, `on?` (default `true`) | Sets `pageBreak="1"` on paragraph `index` so it starts a new page (the break renders **before** the paragraph). Pass `"on": false` to clear an existing break. |

### Tables

| `type` | Args | Notes |
|--------|------|-------|
| `set_cell_text` | `table`, `row`, `col`, `text` | Sets one cell's text. |
| `append_table_row` | `table`, `cells` (string[]) | Clones the last row; fills cells left-to-right; updates `rowCnt`. Inherits the last row's column count. |
| `delete_table_row` | `table`, `row` | Removes a row; updates `rowCnt`. |
| `append_table_column` | `table`, `cells` (string[], top→bottom) | Adds a cell to every row's end; updates `colCnt`. |
| `delete_table_column` | `table`, `col` | Removes the cell at `col` in every row; updates `colCnt`. |
| `merge_cells` | `table`, `mode`, + range | `mode:"horizontal"` → `row`, `start`, `count` (sets `colSpan`); `mode:"vertical"` → `col`, `start`, `count` (sets `rowSpan`). `count >= 2`. Absorbed cells removed. Assumes no prior merge in the range. |
| `insert_table` | `index`, `rows`, `cols`, `cells?` (string[][]) | Inserts a fresh `rows × cols` table as a new paragraph **after** paragraph `index` (use `-1` to prepend at the start of the first section). `cells[r][c]` fills each cell (missing entries → empty). When the doc already contains a table, clones the first existing `<hp:tbl>` as the template so the new table inherits its borderFill / cellSz / cellMargin. When the doc has **no existing table**, falls back to hard-coded `FALLBACK_TBL_*` / `FALLBACK_CELL_*` templates verified against a Hancom-Docs-created table (registers a SOLID 0.12mm black-border `<hh:borderFill>` if one isn't already present). Works on any base doc. |

### Cell styling (cellzoneList / cellSz / subList / paraPr)

Per-cell appearance (background fill, borders, diagonals) lives in
`<hp:cellzoneList>` inside the table — NOT on `<hp:tc>`. Each cellzone
maps a `(startRow, startCol)–(endRow, endCol)` area to a `<hh:borderFill>`
in `header.xml`. Vertical align lives on the cell's `<hp:subList vertAlign>`,
horizontal align on the cell's first `<hp:p>` paraPrIDRef, and size on
`<hp:cellSz>`. These ops produce exactly the structure Hancom Docs writes
when the same edit is performed through its UI.

| `type` | Args | Notes |
|--------|------|-------|
| `set_cell_background` | `table`, `row`, `col`, `color` (hex), `mode?` (`"cellzone"` / `"shade"` / `"both"`, default `"both"`) | Adds a cellzone for that cell pointing at a borderFill with `<hc:fillBrush><hc:winBrush faceColor=...>`. Note the `hc:` namespace — `hh:fillBrush` is silently ignored. **mode trade-off:** `"cellzone"` writes the Hancom-native cellzone fill but **한컴독스 web viewer** sometimes paints only a glyph-height strip on tables not cloned from an existing one (fallback path). `"shade"` writes character shading (글자 모양 → 음영) on the cell text's charPr — strictly behind glyphs but always renders. `"both"` (default) writes both: cellzone for wide fill where supported, shade as a guaranteed fallback. Pick `"cellzone"` if the doc will be opened in Hancom desktop only; default `"both"` for web safety. |
| `set_cell_border` | `table`, `row`, `col`, `color` (hex), `width?` (e.g. `"0.3 mm"`, default `"0.3 mm"`), `sides?` (subset of `["LEFT","RIGHT","TOP","BOTTOM"]`, default all four) | Cellzone + borderFill whose chosen sides are `type="SOLID"`. Others stay `type="SOLID" width="0.12 mm" color="#000000"` (the doc default). |
| `set_cell_diagonal` | `table`, `row`, `col`, `direction` (`"BACKSLASH"` `\` or `"SLASH"` `/`), `color?` (default `"#000000"`), `width?` (default `"0.3 mm"`) | Cellzone + borderFill whose `<hh:slash>` or `<hh:backSlash>` has `type="CENTER"` (Hancom's chosen enum for a solid diagonal — not `"SOLID"`). |
| `set_cell_align` | `table`, `row`, `col`, `horizontal?` (`"LEFT"`/`"CENTER"`/`"RIGHT"`/`"JUSTIFY"`/`"DISTRIBUTE"`), `vertical?` (`"TOP"`/`"CENTER"`/`"BOTTOM"`) | `vertical` swaps `<hp:subList vertAlign>`. `horizontal` rewrites the cell's first `<hp:p>` paraPrIDRef through the same placeholder-paraPr trick as `apply_paragraph_style`. Either or both. |
| `set_cell_size` | `table`, `row`, `col`, `width?`, `height?` (HWP units; one or both) | Rewrites the cell's `<hp:cellSz>` attrs. Hancom usually keeps row/column sizes consistent — changing one cell may make the row/column visually uneven until you set sibling cells to the same value. |

### Styling (clone-mutate-retarget in `header.xml`)

| `type` | Args | Notes |
|--------|------|-------|
| `apply_text_style` | `target`, + any of `color` (hex "FF0000"), `bold`, `italic`, `underline`, `size` (HWP units, 1000≈10pt), `highlight` (true → yellow / hex / false → strip), `strikethrough` (bool), `supscript` (bool), `subscript` (bool — mutually exclusive with `supscript`), `fontFace` (face name, must already exist in `<hh:fontfaces>` like "맑은 고딕" / "함초롬바탕") | Two independent paths inside one op: **highlight** splices `<hp:markpenBegin color>...<hp:markpenEnd/>` around `target` inside its `<hp:t>` node (charPr untouched). Everything else **rewrites an unreferenced placeholder `<hh:charPr>` in place** (the pattern Hancom Docs itself uses — appending a new charPr survives load but Hancom strips the discriminating attr on next open). The placeholder's attrs/inner are replaced with the run's current charPr + the requested style mutation, then the run's `charPrIDRef` is retargeted to the placeholder's id. Returns `placeholderReused: true` when a placeholder was found, `false` (and bumps `hh:charProperties@itemCnt`) only when every charPr was already referenced. Restyles **only the first run** whose text contains `target`. |
| `apply_paragraph_style` | `index`, + any of `align` ("LEFT"/"CENTER"/"RIGHT"/"JUSTIFY"/"DISTRIBUTE"), `indent` (HWP units), `lineSpacing` (percent, e.g. 160) | Clones `paraPr[0]`, mutates, retargets paragraph `index`. Bumps `hh:paraProperties@itemCnt`. |

> **Ordering trap** — when applying both `highlight` AND a charPr-based attr (`bold` / `color` / etc.) to the **same target text**, do the charPr-based op **first**. `highlight` splices `<hp:markpenBegin/>...<hp:markpenEnd/>` inside the `<hp:t>` node, and the charPr-side run-split matcher expects the run's inner to be a single plain `<hp:t>…</hp:t>`. If highlight runs first, the later style call falls back to a whole-run retarget (the bold/color paints the entire paragraph run, not just the target word). Either reorder or pass both in one `apply_text_style` call.

### Lists (글머리 기호 / 번호 매기기)

Bullet / numbered list formatting works by retargeting the paragraph's
`paraPrIDRef` to a `<hh:paraPr>` whose `<hh:heading>` child sets type
(`BULLET` / `NUMBER`) and level. The bullet glyph itself lives in
`<hh:bullets>`; the number format lives in `<hh:numbering>`. New entries
are registered on demand.

| `type` | Args | Notes |
|--------|------|-------|
| `set_bullet_list` | `index`, `char?` (e.g. `"▶"`, `"◯"`, `"□"`, `"★"`, `"■"`, `"◆"`, `"✓"`), `level?` (default `0`) | Marks paragraph `index` as a bullet item. **Hancom Docs web behavior:** Hancom's web viewer silently strips `<hh:heading type="BULLET">` from any paraPr it judges as foreign — including ones whose XML is byte-identical to Hancom-native paraPrs. The op handles this in two ways: (1) if the host doc already carries a Hancom-authored BULLET paraPr (a doc that round-tripped through Hancom Office / Hancom Docs at least once will have one), the paragraph's `paraPrIDRef` is retargeted to it (`reusedHancomNative: true` in the response) — the glyph survives web rendering. (2) Otherwise it falls back to prepending the bullet char + a space to the paragraph text as a literal prefix (`fallback: "text-prefix"` in the response) — visually identical, works across web and desktop, but loses the structural list semantics. Hancom Office desktop has no such restriction; both paths render fine there. **To get real list semantics on web:** start from a hwpx that has already been opened/saved by Hancom Office or Hancom Docs at least once. `create.js` stamps newly-generated hwpx files with a Hancom-round-trip fingerprint so list paraPrs survive, but this is best-effort. |
| `set_number_list` | `index`, `level?` (default `0`), `style?` (`"korean"` or `"decimal"`) | Marks paragraph `index` as a numbered item. With `style: "korean"`, registers a numbering whose levels cycle `1.` / `가.` / `1)` / `가)` / `(1)` / `(가)`. With `style: "decimal"`, registers one whose levels are `1.` / `1.1.` / `1.1.1.` / …. Without `style`, uses the doc's existing numbering id=1 (visual format depends on the template). `level` 0–5 picks the format on that numbering's level chain. **Hancom Docs web behavior:** same `reuseExistingListParaPr` path as `set_bullet_list` — if the host doc carries a Hancom-authored NUMBER paraPr, web rendering survives (`reusedHancomNative: true`); otherwise the synthesised heading gets stripped by Hancom Docs web on open, and there is **no text-prefix fallback** for numbered items (NUMBER auto-increment can't be reconstructed at op time without doc-wide state). For numbered lists on web from a non-round-tripped doc, prepend `"1. "`, `"2. "`, … to the paragraph text yourself via `append_paragraph` / `set_paragraph_text`. |
| `clear_list` | `index` | Strips any `<hh:heading>` from the paragraph's paraPr, leaving it as plain text. |

> Lists clone the paragraph's CURRENT paraPr and splice the heading in, so the margin/lineSpacing of the body is preserved. The Hancom stock list paraPrs that carry default indents (margin.left=1000+) are intentionally NOT reused — bullet/numbered items render at the body's own left margin.

### Header / Footer (머리말 / 꼬리말)

In HWPX a header/footer is a `<hp:ctrl>` control element embedded in body XML
(`<hp:p><hp:run><hp:ctrl><hp:header applyPageType="BOTH">…</hp:header></hp:ctrl>…`),
not a top-level `<hp:secPr>` reference. `applyPageType` is `BOTH` | `EVEN` | `ODD`.

| `type` | Args | Notes |
|--------|------|-------|
| `set_header` | `text`, `applyPageType?` (default `"BOTH"`) | If a header already exists, replaces its text + updates `applyPageType` (returns `updated: true`). If none exists, inserts a new wrapper paragraph right after the first body paragraph of the first section (returns `inserted: true`). **Index-shift warning:** the `inserted: true` path adds a body paragraph, so every subsequent index-based op (`set_page_break`, `insert_hyperlink`, `apply_paragraph_style`, `delete_paragraph`, etc.) shifts by +1. Easiest fix: place `set_header` **last** in the batch, after all index-dependent ops resolve. |
| `set_footer` | `text`, `applyPageType?` (default `"BOTH"`) | Same as `set_header` for `<hp:footer>`. |
| `remove_header` | — | Removes the `<hp:run>` hosting each `<hp:ctrl><hp:header>` (leaves the enclosing paragraph). Returns `removed: N`. |
| `remove_footer` | — | Same for `<hp:footer>`. |

> First-time insertion uses safe defaults (`paraPrIDRef="0"` / `charPrIDRef="0"`), which exist in every standard `.hwpx`. To use a custom font/color, follow with `apply_text_style` targeting the header text.

### Footnote / Endnote (각주 / 미주)

A footnote / endnote is a `<hp:ctrl>` control with the same envelope as
header/footer (`<hp:run><hp:ctrl><hp:footNote|endNote><hp:subList>…`). The
reference marker (¹ ²) and page-bottom placement are computed by Hancom at
render time — we only place the control at the end of the target paragraph.

| `type` | Args | Notes |
|--------|------|-------|
| `insert_footnote` | `index`, `text` | Appends a footnote at end of paragraph `index`. The reference marker appears in the body where the control sits; the footnote text shows at the bottom of that page. |
| `insert_endnote` | `index`, `text` | Same shape as `insert_footnote` for `<hp:endNote>`. Text appears at the end of the document instead of per-page. |

> rhwp's `.hwp → .hwpx` conversion drops actual notes (it only writes the `<hp:footNotePr>` style declaration), so this template is built from the OWPML envelope rather than cloned from a real instance — visually verify in Hancom Docs on first use. To restyle the marker, follow with `apply_text_style` on a unique anchor before the insertion.

### Bookmark (책갈피)

A bookmark is a named anchor placed at the start of a paragraph's first
`<hp:run>`, wrapped in `<hp:ctrl>`:

```
<hp:run charPrIDRef="N">
  <hp:ctrl><hp:bookmark name="이름"/></hp:ctrl>
  <hp:t>그 자리의 텍스트</hp:t>
</hp:run>
```

The `name` is what cross-references / "Go to" jumps target. The element
itself is invisible in body rendering.

| `type` | Args | Notes |
|--------|------|-------|
| `insert_bookmark` | `index`, `name` | Splices `<hp:ctrl><hp:bookmark name="…"/></hp:ctrl>` into the first `<hp:run>` of paragraph `index`, right after its opening tag (so it sits before the run's text). If the paragraph has no run yet (or only a self-closing one), wraps the bookmark in a fresh `<hp:run charPrIDRef="0">`. |

### Hyperlink (하이퍼링크)

| `type` | Args | Notes |
|--------|------|-------|
| `insert_hyperlink` | `index`, `url`, `text` | Appends a clickable hyperlink to paragraph `index`. Built as a paired Hancom field (`<hp:fieldBegin type="HYPERLINK">` … `<hp:t>text</hp:t>` … `<hp:fieldEnd>`) inside a new run, mirroring the verified structure from a real government doc. `text` is what the reader sees; `url` is the target. **Link-only paragraph pattern:** the op appends the link to whatever's in paragraph `index`, so to produce a paragraph that's just the link, first `append_paragraph` with empty `text: ""`, then `insert_hyperlink` targeting that new paragraph's index. |

### Images

| `type` | Args | Notes |
|--------|------|-------|
| `insert_image` | `source` (disk path), `ext?` (png/jpg/bmp/gif), `width?`, `height?` (HWP units, default ~100mm) | Adds bytes to `BinData/`, registers a unique `<opf:item>` in the manifest (id avoids existing ids), appends a paragraph with an inline `<hp:pic>`. |
| `replace_image` | `target` (any of: `"image1"` / `"image1.png"` / `"BinData/image1"` / `"BinData/image1.png"`), `source` | Swaps the bytes of an existing `BinData/` entry. Stem (extension-less) match works, so the manifest id is fine even when you don't know the file extension. |
| `delete_image` | `target` (same matching rules as `replace_image`) | Removes the `BinData/` entry **and** its manifest item **and** every `<hp:pic>` that referenced it (no dangling reference). |

## Examples

Template fill + a cell edit + a styled run, saved in place:
```bash
echo '{
  "path": "form.hwpx", "output": "form.hwpx",
  "operations": [
    {"type": "fill_template", "values": {"{{이름}}": "남대현", "{{날짜}}": "2026-05-21"}},
    {"type": "set_cell_text", "table": 0, "row": 2, "col": 1, "text": "100만원"},
    {"type": "apply_text_style", "target": "합계", "bold": true, "color": "FF0000"}
  ]
}' | node scripts/hwpx-edit.js
```

Grow a table and merge a header row:
```bash
echo '{
  "path": "report.hwpx",
  "operations": [
    {"type": "append_table_row", "table": 1, "cells": ["4분기", "120", "98%"]},
    {"type": "merge_cells", "table": 1, "mode": "horizontal", "row": 0, "start": 0, "count": 3}
  ]
}' | node scripts/hwpx-edit.js
```

## Known limits

- **Cross-run text** — a find target split across two `<hp:t>` nodes won't match (same as Hancom's text replace).
- **`append_table_row` column count** — clones the *last* row; if that row is merged to fewer cells, the new row inherits that shape.
- **`merge_cells`** assumes the target range has no prior merge.
- For OWPML the op set doesn't reach, fall back to manual unpack/edit/pack (see SKILL.md Path A fallback).
