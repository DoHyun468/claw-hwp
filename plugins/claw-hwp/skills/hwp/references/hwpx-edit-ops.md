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
| `set_column_break` | `index`, `on?` (default `true`) | Sets `columnBreak="1"` on paragraph `index` so it jumps to the next column in a multi-column (`set_columns`) layout. `"on": false` clears it. |

### Tables

| `type` | Args | Notes |
|--------|------|-------|
| `set_cell_text` | `table`, `row`, `col`, `text` | Sets one cell's text. |
| `append_table_row` | `table`, `cells` (string[]) | Clones the last row; fills cells left-to-right; updates `rowCnt`. Inherits the last row's column count. |
| `insert_table_row` | `table`, `row`, `where?` (`before` default / `after`), `cells?` (string[]) | Inserts a row relative to row `row` (clones it for shape, fills `cells`), updates `rowCnt`, and renumbers every cell's `rowAddr` to its row index. Best on rectangular tables — a table with `rowSpan` merges may need manual `cellAddr` fixup. |
| `insert_table_column` | `table`, `col`, `where?` (`before`/`after`), `cells?` (string[], top→bottom) | Inserts a column relative to col `col` in every row, updates `colCnt`, renumbers `colAddr`. Same merge caveat as `insert_table_row`. |
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
| `set_cell_align` | `table`, `row`, `col`, `horizontal?` (`"LEFT"`/`"CENTER"`/`"RIGHT"`/`"JUSTIFY"`/`"DISTRIBUTE"`), `vertical?` (`"TOP"`/`"CENTER"`/`"BOTTOM"`) | `vertical` swaps `<hp:subList vertAlign>`. `horizontal` repurposes an existing unreferenced paraPr in place (placeholder reuse) and points the cell's first `<hp:p>` at it. Either or both. **Hancom-web-safe** (verified render: cell text centers) — because it reuses an existing paraPr *id* rather than appending a new one (the thing Hancom web normalizes). Only the rare no-unreferenced-paraPr fallback (append) would lose web fidelity. |
| `set_cell_size` | `table`, `row`, `col`, `width?`, `height?` (HWP units; one or both) | Rewrites the cell's `<hp:cellSz>` attrs. Hancom usually keeps row/column sizes consistent — changing one cell may make the row/column visually uneven until you set sibling cells to the same value. |
| `distribute_table` | `table`, `mode?` (`width` / `height` / `both`, default `both`) | Evenly distributes column widths and/or row heights across the whole table (셀 너비를/높이를 같게): sums the current sizes, divides by the count, rewrites every `<hp:cellSz>`. Best on rectangular tables; merged cells aren't sized proportionally. |
| `split_cell` | `table`, `row`, `col`, `rows?` (default 1), `cols?` (default 1) | Splits one cell into `rows` × `cols` sub-cells (셀 나누기). Inserts `cols-1` grid columns and/or `rows-1` grid rows at the cell; the cells above/below/beside it grow their span to keep covering the area, and cells past the split shift their address — the same grid bookkeeping Hancom does natively (verified against Hancom-native ground truth + web render for row, column, and 2×2 splits). The top-left sub-cell keeps the original text; the rest are empty. Target must be a normal (un-merged) cell — unmerge first if it spans. Addressed by grid `row`/`col` (the `<hp:cellAddr>` coordinates), so it's correct even when the table has other merges. |

### Table / cell properties (표·셀 속성 다이얼로그)

Mirrors the 4-tab 표/셀 속성 dialog. Margin/size inputs are **mm** → HWPUNIT (≈283.46/mm). Structures cross-checked against claw-hancomdocs's Hancom-web ground truth (`handoff/shared/SHARED_op-inventory-for-GT.md` §1) and round-trip-verified (Hancom preserves them 1:1).

| Op | Required | Optional | Notes |
|----|----------|----------|-------|
| `set_cell_margin` | `table`, `row`, `col` | `to_row`, `to_col`, `left`, `right`, `top`, `bottom` (mm) | Sets the cell's `<hp:cellMargin>` (셀 안 여백) **and `hasMargin="1"` on the cell** — without that flag (rhwp default `hasMargin="0"`) Hancom ignores the cell's own cellMargin and inherits the table's `<hp:inMargin>`, so the margin is silently dropped on render (GT-confirmed). `to_row`/`to_col` apply to the `[row,col]..[to_row,to_col]` rectangle. Only the given sides change. For a uniform table-wide padding you can instead use `set_table_inner_margin` (all `hasMargin="0"` cells inherit it). |
| `set_table_margin` | `table` | `left`, `right`, `top`, `bottom` (mm) | Table's `<hp:outMargin>` (표 바깥 여백 = 표↔본문 간격). |
| `set_table_inner_margin` | `table` | `left`, `right`, `top`, `bottom` (mm) | Table-level `<hp:inMargin>` (표 탭 '모든 셀에 적용되는 안 여백' 기본값). Doesn't override cells that already carry an explicit `cellMargin`. |
| `set_table_size` | `table` | `width_mm`, `height_mm` | Resizes the whole table. **Scales every `<hp:cellSz>` proportionally** to hit the target (then updates `<hp:sz>`) — Hancom recomputes a table's `<hp:sz>` from its column-width sum, so setting `<hp:sz>` alone is ignored. Rectangular tables hit the target exactly; merged cells are approximate. |
| `set_table_props` | `table` | `wrap` (`inline`/`square`/`topbottom`/`front`/`behind`), `page_split` (`none`/`cell`/`table`), `repeat_header` (bool) | `<hp:tbl textWrap=…/pageBreak=…/repeatHeader=…>`. `wrap:"inline"` = 글자처럼 취급 (`<hp:pos treatAsChar="1">`, no textWrap); others set textWrap + `treatAsChar="0"`. `page_split` maps `cell→TABLE`, `table→CELL`, `none→NONE` (Hancom's inverted naming, per GT). `repeat_header` repeats the header row across page breaks. |
| `set_title_cell` | `table`, `row`, `col` | `on?` (default true) | Marks the cell as a header cell (`<hp:tc header="1">`). Hancom's UI only enables this on the top row, but the op accepts any cell. |

### Styling (clone-mutate-retarget in `header.xml`)

| `type` | Args | Notes |
|--------|------|-------|
| `apply_text_style` | `target`, + any of `color` (hex "FF0000"), `bold`, `italic`, `underline`, **`size_pt` (font size in points, e.g. `22` — preferred)** or raw `size` (HWP units, 1000≈10pt; ⚠️ a value like `22` here is 0.22pt = invisible, so use `size_pt`), `highlight` (true → yellow / hex / false → strip), `strikethrough` (bool), `supscript` (bool), `subscript` (bool — mutually exclusive with `supscript`), `fontFace` (face name, must already exist in `<hh:fontfaces>` like "맑은 고딕" / "함초롬바탕"), `letter_spacing` (자간 — spacing %, e.g. `50`), `char_ratio` (장평 — character width %, e.g. `150` wide / `50` narrow) | All Hancom-web-verified (render): bold/italic/underline/strike/color/highlight/size_pt/letter_spacing/char_ratio all reflect correctly. | Two independent paths inside one op: **highlight** splices `<hp:markpenBegin color>...<hp:markpenEnd/>` around `target` inside its `<hp:t>` node (charPr untouched). Everything else **rewrites an unreferenced placeholder `<hh:charPr>` in place** (the pattern Hancom Docs itself uses — appending a new charPr survives load but Hancom strips the discriminating attr on next open). The placeholder's attrs/inner are replaced with the run's current charPr + the requested style mutation, then the run's `charPrIDRef` is retargeted to the placeholder's id. Returns `placeholderReused: true` when a placeholder was found, `false` (and bumps `hh:charProperties@itemCnt`) only when every charPr was already referenced. Restyles **only the first run** whose text contains `target`. |
| `apply_paragraph_style` | `index`, + any of `align` ("LEFT"/"CENTER"/"RIGHT"/"JUSTIFY"/"DISTRIBUTE"), `indent` (HWP units), `lineSpacing` (percent, e.g. 160), `spacing_before` / `spacing_after` (HWP units), `margin_left` / `margin_right` (HWP units), `background_color`, `page_break_before`, `keep_with_next` | Sets paragraph properties on paragraph `index`. **`align` / `indent` / `lineSpacing` / `spacing_before` / `spacing_after` / `margin_left` / `margin_right` are all Hancom-web-safe** (`webSafe: true`): they're baked into a Hancom-native `hp:switch`(`hp:case`[hwpunitchar] + `hp:default`) paraPr injected from the stub — the only form Hancom web preserves (a plain paraPr margin is stripped to 0 on open). GT-verified by round-trip: align + spacing + indent + lineSpacing all survive (Hancom re-scales the case values ~½ on its own save — a unit nuance, gap stays). Units: HWP units (≈283.46/mm) → converted to hp:case mm×100 / hp:default mm×200; lineSpacing is percent. **⚠️ `background_color` / `page_break_before` / `keep_with_next` still take the clone path** (clone `paraPr[0]`, mutate) and may be stripped by Hancom web; `background_color` survives better as a 1×1 table cell fill. Tip: keep `background_color` etc. in a separate call from the web-safe props. |
| `apply_style` | `index`, `style` (built-in style **name** like `"개요 1"` / `"본문"` / `"바탕글"`, English `engName` like `"Body"`, or numeric **id**) | Applies a built-in named paragraph style (스타일 적용) to paragraph `index` — points its `styleIDRef` at the style and adopts the style's `paraPr` + `charPr`. Unlike `apply_paragraph_style` (which sets ad-hoc formatting), this is a *semantic* style, so the paragraph shows under that name in Hancom's style menu and feeds TOC / outline numbering. Every `.hwpx` ships ~22 styles (바탕글, 본문, 개요 1–10, 머리말, 캡션, 차례…). Verified by Hancom round-trip: the paragraph resolves to the chosen style name. (Outline styles may look like body text until you add outline numbering — the *style* is still applied.) |
| `para_line` | `index`, `fill_color?` (hex band colour), `border_color?` (hex), `border_width_mm?` (default 0.4), `sides?` (`all` default / `top-bottom` / `top` / `bottom` / `left-right` / `left` / `right`) | Wraps paragraph `index` in a full-width **highlight band / callout** (문단 띠). Needs `fill_color` and/or a border. **Implemented as a 1-cell table, not a paraPr border** — a paragraph-level border/background is silently stripped by Hancom Docs web (the documented paraPr-normalization trap, same root cause as the BULLET strip), so para_line extracts the paragraph's text, deletes it, and drops a full-width 1×1 table in its place with the cell filled + bordered via the (Hancom-verified) cellzone path. Verified by Hancom-web render. Caveat: only the paragraph's plain text is carried into the band (inline run styling is not preserved); complex paragraphs are better built as a real table. |

> **Ordering trap** — when applying both `highlight` AND a charPr-based attr (`bold` / `color` / etc.) to the **same target text**, do the charPr-based op **first**. `highlight` splices `<hp:markpenBegin/>...<hp:markpenEnd/>` inside the `<hp:t>` node, and the charPr-side run-split matcher expects the run's inner to be a single plain `<hp:t>…</hp:t>`. If highlight runs first, the later style call falls back to a whole-run retarget (the bold/color paints the entire paragraph run, not just the target word). Either reorder or pass both in one `apply_text_style` call.

### Lists (글머리 기호 / 번호 매기기)

Bullet / numbered list formatting works by retargeting the paragraph's
`paraPrIDRef` to a `<hh:paraPr>` whose `<hh:heading>` child sets type
(`BULLET` / `NUMBER`) and level. The bullet glyph itself lives in
`<hh:bullets>`; the number format lives in `<hh:numbering>`. New entries
are registered on demand.

| `type` | Args | Notes |
|--------|------|-------|
| `set_bullet_list` | `index`, `char?` (e.g. `"▶"`, `"◯"`, `"□"`, `"★"`, `"■"`, `"◆"`, `"✓"`), `level?` (default `0`) | Marks paragraph `index` as a bullet item. **Hancom Docs web compatibility is automatic.** Hancom's web viewer silently strips a `<hh:heading type="BULLET">` from any paraPr it judges as foreign — even one byte-identical to a Hancom-native paraPr — so the op survives this in three escalating steps: (1) if the doc already carries a Hancom-authored BULLET paraPr, the paragraph's `paraPrIDRef` is retargeted to it (`reusedHancomNative: true`); (2) otherwise the op injects the Hancom-native list structure (bullet/numbering definitions, the `HwpUnitChar` namespace, and the `Scripts/` parts) into the doc and retries step 1 — so **even a plain hwpx that never passed through Hancom renders correctly on the web** (`reusedHancomNative: true`); (3) only if that injection can't run (the bundled template is missing) does it fall back to prepending the bullet char as literal text (`fallback: "text-prefix"`, loses list semantics but renders everywhere). `char` picks the glyph (default `▶`). Desktop Hancom Office renders every path. |
| `set_number_list` | `index`, `level?` (default `0`), `style?` (`"korean"` or `"decimal"`), `number?` (fallback only) | Marks paragraph `index` as a numbered item. With `style: "korean"`, levels cycle `1.` / `가.` / `1)` / `가)` / `(1)` / `(가)`. With `style: "decimal"`, levels are `1.` / `1.1.` / `1.1.1.` / …. Without `style`, uses the doc's existing numbering id=1. `level` 0–5 picks the format. **Hancom Docs web compatibility is automatic** — same three-step path as `set_bullet_list` (reuse a native NUMBER paraPr → else inject the Hancom-native list structure and retry → `reusedHancomNative: true`). **Numbered lists now survive the web viewer on any hwpx, including plain ones that never round-tripped through Hancom.** Only if the injection can't run (template missing) does it fall back to a literal `"1. "`-style text prefix using the optional `number` arg (`fallback: "text-prefix"`; no auto-increment across calls, so pass `number` per paragraph). |
| `clear_list` | `index` | Strips any `<hh:heading>` from the paragraph's paraPr, leaving it as plain text. |

> Lists clone the paragraph's CURRENT paraPr and splice the heading in, so the margin/lineSpacing of the body is preserved. The Hancom stock list paraPrs that carry default indents (margin.left=1000+) are intentionally NOT reused — bullet/numbered items render at the body's own left margin.

### Header / Footer (머리말 / 꼬리말)

In HWPX a header/footer is a `<hp:ctrl>` control element embedded in body XML
(`<hp:p><hp:run><hp:ctrl><hp:header applyPageType="BOTH">…</hp:header></hp:ctrl>…`),
not a top-level `<hp:secPr>` reference. `applyPageType` is `BOTH` | `EVEN` | `ODD`.

| `type` | Args | Notes |
|--------|------|-------|
| `set_header` | `text`, `applyPageType?` (default `"BOTH"`), `align?` (`LEFT`/`CENTER`/`RIGHT`) | `align` sets the header text's horizontal alignment — it reuses (or injects from the Hancom-native stub) a clean paraPr declaring that align, the same path `apply_paragraph_style` uses, so it survives the 한컴독스 web round-trip (GT-verified 2026-06-17). Omit `align` to keep the default (left). If a header already exists, replaces its text + updates `applyPageType` (returns `updated: true`). If none exists, inserts a new wrapper paragraph right after the first body paragraph of the first section (returns `inserted: true`). **Index-shift warning:** the `inserted: true` path adds a body paragraph, so every subsequent index-based op (`set_page_break`, `insert_hyperlink`, `apply_paragraph_style`, `delete_paragraph`, etc.) shifts by +1. Easiest fix: place `set_header` **last** in the batch, after all index-dependent ops resolve. |
| `set_footer` | `text`, `applyPageType?` (default `"BOTH"`), `align?` (`LEFT`/`CENTER`/`RIGHT`) | Same as `set_header` for `<hp:footer>` (incl. `align`). |
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
| `insert_image` | `source` (disk path), `ext?` (png/jpg/bmp/gif), `width_mm?`, `height_mm?` (preferred — millimetres), or raw `width?`/`height?` (HWPUNIT; default ~100mm) | Adds bytes to `BinData/`, registers a unique `<opf:item>` in the manifest (id avoids existing ids), appends a paragraph with an inline `<hp:pic>`. **Use `width_mm`/`height_mm`** — the raw `width`/`height` are HWPUNIT (1mm ≈ 283.46), so a value like `50` is sub-millimetre and renders as a dot. Sizing applies when the doc has no existing image to clone from. |
| `replace_image` | `target` (any of: `"image1"` / `"image1.png"` / `"BinData/image1"` / `"BinData/image1.png"`), `source` | Swaps the bytes of an existing `BinData/` entry. Stem (extension-less) match works, so the manifest id is fine even when you don't know the file extension. |
| `delete_image` | `target` (same matching rules as `replace_image`) | Removes the `BinData/` entry **and** its manifest item **and** every `<hp:pic>` that referenced it (no dangling reference). |

### Equation (수식)

A Hancom equation is an inline shape (`<hp:equation>`) whose math is written in
Hancom's equation-script syntax inside `<hp:script>`. Hancom renders it from the
script on open **and recomputes its size**, so you don't supply dimensions.

> ⚠️ **Hancom equation-script is NOT LaTeX.** It looks similar but has no
> backslash commands — writing LaTeX renders as literal text, not math. Map the
> common ones:
>
> | want | LaTeX (✗) | Hancom-script (✓) |
> |---|---|---|
> | fraction | `\frac{a}{b}` | `{a} over {b}` |
> | square root | `\sqrt{x}` | `sqrt{x}` |
> | n-th root | `\sqrt[3]{x}` | `root 3 of x` |
> | Greek | `\alpha` `\pi` | `alpha` `pi` (bare; caps `PI`) |
> | times / ± | `\times` `\pm` | `TIMES` `+-` |
> | ≤ ≠ → ∞ | `\leq` `\neq` `\to` `\infty` | `<=` `!=` `rightarrow` (or `->`) `INF` |
> | sum / integral | `\sum_{i=1}^{n}` `\int_0^\infty` | `sum from {i=1} to n` `int _0 ^inf` |
> | vector / bar | `\vec{a}` `\bar{x}` | `vec{a}` `bar{x}` |
>
> Same as LaTeX: superscript `a^b`, subscript `a_b`, and `{ }` grouping. Everything
> else is bare words, never `\commands`.

| `type` | Args | Notes |
|--------|------|-------|
| `insert_equation` | `script`, `index?` | Inserts an equation as its own new plain paragraph (never inherits a neighbouring list's bullet/number). `script` is Hancom equation-script. With `index`, the equation paragraph goes right **after** paragraph `index`; without it, it's appended to the last section. Renders on both Hancom Docs web and desktop (verified). |

Equation-script quick reference (case-sensitive): superscript `a^b`, subscript
`a_b`, group `{ }`, space `~`, fraction `{ } over { }`, root `sqrt{ }` /
`root n of x`, big operators `sum`/`int` with `_{ } ^{ }` limits (e.g.
`int _0 ^inf`), auto-size brackets `LEFT ( RIGHT )`, matrices
`matrix{ a & b # c & d }` (`&`=column, `#`=row), Greek `alpha`…`omega` /
`ALPHA`…`OMEGA`, symbols `+-` (±) `TIMES` (×) `<=` (≤) `!=` (≠) `rightarrow` (→)
`INF` (∞) `THEREFORE` (∴), decorations `vec{ }` `bar{ }` `hat{ }`. Examples:

```
x = {-b +- sqrt{b^2 -4ac}} over {2a}      → 근의 공식
int _0 ^inf e^{-x} dx = 1                 → 적분
sum from {i=1} to n i = {n(n+1)} over 2   → 시그마 합
A = LEFT [ matrix{1 & 0 # 0 & 1} RIGHT ]  → 행렬
```

`<` `>` `&` in a script are XML-escaped automatically — write them as-is.

### Columns (다단)

Multi-column layout lives on each section's `<hp:secPr>` as
`<hp:colPr type="NEWSPAPER" colCount="N" sameSz="1" sameGap="G"/>`; every plain
hwpx ships with `colCount="1"`.

| `type` | Args | Notes |
|--------|------|-------|
| `set_columns` | `count`, `gap_mm?` | Sets newspaper-style multi-column layout on **every** section. `count` = number of equal columns (`1` resets to single column; `2`+ makes body text flow top-to-bottom down one column then into the next). `gap_mm` = inter-column gap in mm (default ~4 mm). Renders on Hancom Docs web and desktop. Note: you need enough body text to actually fill column 1 before the flow into column 2 is visible. |

### Page setup (편집 용지)

| `type` | Args | Notes |
|--------|------|-------|
| `set_page_setup` | `size?`, `orientation?`, `width_mm?`, `height_mm?`, `margin_mm?` | Rewrites every section's `<hp:pagePr>` (paper size) + `<hp:margin>`. `size` preset: `a3`/`a4`/`a5`/`b4`/`b5`/`letter`/`legal`. `orientation`: `portrait` / `landscape` (swaps width↔height — landscape = width > height; the pagePr `landscape` enum is a separate binding hint, left as-is). `width_mm` / `height_mm` set an exact size instead of a preset. `margin_mm` sets all four page margins (mm). Renders on Hancom Docs web (landscape capture-verified). |

### Chart (차트)

A chart is a floating object — `<hp:chart chartIDRef="Chart/chartN.xml">` in the
body plus a generated OOXML `<c:chartSpace>` part. Hancom renders from that OOXML
part (no OLE binary needed).

| `type` | Args | Notes |
|--------|------|-------|
| `insert_chart` | `chart_type?`, `cat?`, `series?`, `width_mm?`, `height_mm?`, `wrap?`, `margin_mm?`, `x_mm?`, `y_mm?` | Appends a chart at the end of the last section. `width_mm`/`height_mm` set the chart size (default ≈114 × 66 mm); `wrap` = `square` (어울림, default) / `topbottom` (자리차지) / `front` / `behind` / `inline`. **`margin_mm` = outer margin so surrounding text isn't crowded/covered (default ≈2.5 mm — keeps a gap above/below).** `x_mm`/`y_mm` nudge the position. `chart_type` accepts a **name** — `column` (default) / `bar` / `line` / `area` / `pie` / `doughnut` / `scatter` / `radar` — **or a numeric 0–19** covering Hancom's full type list (incl. stacked, 3D, exploded pie): 0 col · 1 col-stacked · 2 line · 3 bar · 4 bar-stacked · 5 scatter · 6 pie · 7 pie-exploded · 8 doughnut · 9 area · 10 area-stacked · 11 radar · 12–15 3D bar · 16–17 3D pie · 18–19 3D area. `cat` = category labels `["1월","2월","3월"]` (for `scatter`, numeric X values). `series` = `[{ "name": "매출", "values": [120,135,150] }, …]` (pie/doughnut use the first series only; values map to categories in order). The OOXML chart part is generated from this data; **all 20 types verified rendering on Hancom Docs web** (clustered/stacked bar, line, area, pie/doughnut/exploded, scatter, radar, 3D). |

```json
{"type":"insert_chart","chart_type":"column",
 "cat":["1월","2월","3월"],
 "series":[{"name":"매출","values":[120,135,150]},{"name":"비용","values":[80,75,90]}]}
{"type":"insert_chart","chart_type":"pie","cat":["A","B","C","D"],"series":[{"name":"점유율","values":[40,30,20,10]}]}
```

### Shape (도형)

| `type` | Args | Notes |
|--------|------|-------|
| `insert_textbox` | `text`, `index?`, `width_mm?`, `height_mm?`, `fill_color?`, `line_color?`, `line_width_mm?`, `wrap?` | Inserts a text box (글상자) — a rectangle carrying `text` as one vertically-centered paragraph. Default ≈106 × 35 mm, `wrap` defaults `square` (글이 옆으로 흐름). `line_width_mm` = border thickness; `wrap` values as in `insert_chart`. Also `x_mm`/`y_mm` (position) and `margin_mm` (outer gap, default ~2 mm). |
| `insert_shape` | `shape`, `index?`, `width_mm?`, `height_mm?`, `fill_color?`, `line_color?`, `line_width_mm?`, `wrap?` | Inserts a drawing shape — `shape`: `rect` / `ellipse` / `line`. `line_width_mm` = border thickness; `wrap` = `front` (default) / `square` / `topbottom` / `behind` / `inline`. Also `x_mm`/`y_mm` (nudge position so stacked objects don't overlap) and `margin_mm` (outer gap from text). `width_mm` × `height_mm` set the size (default ≈53 × 24 mm; for `line` the line runs corner-to-corner of that box, so `height_mm: 0` = horizontal). `fill_color` (rect/ellipse, hex) + `line_color` (border, hex). The shape floats relative to paragraph `index` (or is appended); multiple shapes inserted at the same spot overlap — give them different `index` or move them in Hancom afterwards. Renders on Hancom Docs web (rect + ellipse verified). |
| `set_page_number` | `where?` (`footer` default / `header`), `align?` (`LEFT` / `CENTER` default / `RIGHT`) | Inserts a page number (쪽 번호) into the footer (or header) — a control that Hancom fills with the live page number on each page. `align` is best-effort: it reuses an existing paragraph style that already declares that horizontal alignment, otherwise it stays left. Adds a fresh footer/header; if the section already has one, the number is added as a new footer/header instance. |
| `set_caption` | `text`, `target?` (`image` default / `chart` / `shape` / `table`), `index?` (which one of that kind, default 0), `side?` (`BOTTOM` default / `TOP` / `LEFT` / `RIGHT`), `gap_mm?` (gap to the object, default ~3 mm) | Attaches a caption (캡션 — e.g. "그림 1." / "표 1.") to an object. Adds an `<hp:caption>` as the object's last child (after `shapeComment` for image/chart/shape, after the size/margin header for a table). Re-running replaces the existing caption. Verified against Hancom-native ground truth (image) + Hancom-web render (image and table). The caption width auto-matches the object's width (`TOP`/`BOTTOM`) or height (`LEFT`/`RIGHT`). |

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
