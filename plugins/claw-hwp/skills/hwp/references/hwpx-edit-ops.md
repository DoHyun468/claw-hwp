# `hwpx-edit.js` operation vocabulary

`scripts/hwpx-edit.js` edits an existing **`.hwpx`** by applying named operations
directly to its OWPML XML (via the vendored `fflate` zip), then repackaging. It
never touches HWP 5.0 binary (`.hwp`) — that path is `cell-patch.js` / Path B.

> **Placing objects (charts/images/shapes) so they look natural?** See
> **`hwpx-object-placement.md`** — a decision table + verified recipe for every
> `wrap` mode (inline default / topbottom / square / behind / front) with size,
> margin, and position guidance. Picking the wrong mode for the content (e.g. a
> full-width chart with `square`) mangles the page; the manual says which to use.
>
> **Line spacing / paragraph gaps / heading sizes — what's the default, and how to
> match a template?** See **`hwpx-style-spacing.md`**. It has the EXACT spacing
> create.js auto-applies (body 150% line + 3.5mm after; headings 120% + per-level
> before/after; lists 140% + 2.5mm — from the `HEADING_DEFAULTS`/`BODY_*`/`LIST_*`
> source constants), and the rule: **filling a given template → inherit its styles
> (don't impose defaults); no template → those defaults are already applied (don't
> re-add — `apply_paragraph_style spacing_before` OVERWRITES, shrinking the gap).**

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
- **Table index** — 0-based, **document (pre-)order over EVERY `<hp:tbl>` including tables nested inside cells** — matches `--inspect`'s table count exactly. (Korean 서식 routinely wrap the fillable grid inside an outer table; cell/table ops reach those nested grids.) A parent table comes before its nested children, then the next sibling. **2026-06-19 change** — superseded the old "top-level only" rule; index now == `--inspect` order, so inspect → use that number directly.
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
| `replace_text` | `find`, `replace` | **Global** (every occurrence, all sections). **Control- and run-aware:** matches a placeholder even when split by inline controls (`<hp:fwSpace/>` full-width space, `<hp:tab/>`, line break — common in Korean form titles/dates/author lines) and when split **across differently-formatted runs**; the replacement takes the first overlapped run's char shape, controls inside the match are dropped, object/table runs are never disturbed. Reaches table-cell text incl. nested tables. Only caveat: `<`/`>`/`&` are stored escaped (`&lt;` …) so a `find` literally containing them won't match — search without the brackets. |
| `fill_template` | `values` (object `{ "{{k}}": "v" }`) | Multiple `replace_text` in one pass (same matching as above). Returns `total` + `perKey`. |
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
| `set_cell_text` | `table`, `row`, `col`, `text` | Sets one cell's text (**replaces the whole cell**, so `text` must be the complete final string). `table` index is document order incl. nested (== `--inspect`). **빈칸/괄호/밑줄 placeholder 셀 채우기** (`전화번호 (    )`, `(  )-(  )-(  )`, `___-__-_____`, `성명:____ 직위:____`): naive append/replace는 어느 괄호에 넣을지 못 정함 → **① 먼저 셀 내용을 읽고**(`--format markdown` 또는 `--inspect`) **② 어디에 무엇을 넣을지 에이전트가 판단해 ③ 완성된 셀 전체 문자열을 `set_cell_text`로 통째로 쓴다.** 예: `전화번호 (    )` 읽음 → `text:"전화번호 ( 02-100-2000 )"`, `(  )-(  )-(  )` → `text:"( 02 ) - ( 100 ) - ( 2000 )"`. 괄호 수·지역번호 분리 등 폼마다 의미가 달라 코드가 추측하지 말고 에이전트가 정함. (HWP 트랙 `set_cell_text_by_label`의 placeholder 규칙을 HWPX(index 기반)로 이식 — 한컴 렌더 검증 2026-06-19.) |
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
| `set_table_split_border` | `table` | `line_type` (same set as `set_object_border`), `width_mm`, `color` | Edge line drawn where a table auto-splits across pages (여백/캡션 탭 '자동으로 나뉜 표의 경계선'). Clones the table's borderFill with `breakCellSeparateLine="1"` and puts the line in its `<hh:diagonal>` slot (NOT top/bottom border), then sets the table to `pageBreak="CELL"` (나눔 mode, required). The line only shows when the table actually spans a page break, but the setting persists. |
| `set_cell_image` | `table`, `row`, `col`, `source` | `ext`, `width_mm`, `height_mm` | Embeds an image **inside a cell**, inline (`treatAsChar="1"` — flows like a glyph). `insert_image` can only append to the body, not into a cell. Default size 30×20mm. **Auto-fits with symmetric margin**: (1) the cell gets ~1.4mm left/right 안여백 (`hasMargin="1"` + `<hp:cellMargin>`) unless it already has explicit margins; (2) the object is clamped to the cell's content width (`cellSz` − 안여백) preserving aspect ratio — Hancom renders cells at their `cellSz` width and **clips** anything wider; (3) ~1.4mm top/bottom via the object's `<hp:outMargin>`; (4) the cell is centred (`set_cell_align CENTER/CENTER`). Net effect: the object sits centred with an even gap on all four sides, never clipped. |
| `set_cell_shape` | `table`, `row`, `col`, `shape` (`rect`/`ellipse`/`line`) | `width_mm`, `height_mm`, `fill_color`, `line_color`, `line_width_mm` | Draws a shape **inside a cell**, inline (`treatAsChar="1"`). Default size 20×12mm. Same cell-fit + symmetric-margin + centre behaviour as `set_cell_image`. |
| `set_cell_chart` | `table`, `row`, `col` | `chart_type`, `cat`, `series` (same as `insert_chart`), `width_mm`, `height_mm` | Renders a chart **inside a cell**, inline. Same chart data model as `insert_chart` (`chart_type` 0–19 or name; `cat`=labels; `series`=[{name,values}]). Default 45×28mm. A chart can't be shrunk into a narrow cell without its axes/legend collapsing, so this **auto-widens the chart's column** (only that column; the table grows) until the chart fits at a legible size, **capped to the page text width** — only if the cap is hit is the chart shrunk. Same symmetric-margin + centre behaviour. |
| `set_cell_equation` | `table`, `row`, `col`, `script` | `width_mm`, `height_mm` | Renders a Hancom equation **inside a cell**, inline (`script` = equation syntax, e.g. `x = {-b +- sqrt{b^2 -4ac}} over {2a}`). Hancom sizes the equation from the script, so a narrow cell would clip a long formula — like `set_cell_chart` this **auto-widens the equation's column** (default target 55mm, or `width_mm`, capped to page width) instead of clipping. Same centre + margin behaviour. |

### Object properties (그림·도형 속성 — image/shape/chart)

Edit an existing object's geometry/border/fill. The object is addressed by `target` (`image`/`shape`/`chart`) + `index` (0-based, in document order — same scheme as `set_caption`). mm → HWPUNIT. GT: `handoff/shared/SHARED_op-inventory-for-GT.md` §2; round-trip-verified on Hancom (size/textWrap/lineShape/winBrush all preserved).

| Op | Required | Optional | Notes |
|----|----------|----------|-------|
| `set_object_size` | `target`, `index` | `width_mm`, `height_mm` | Rewrites `<hp:sz>`. |
| `set_object_position` | `target`, `index` | `x_mm`, `y_mm`, `wrap` (`inline`/`square`/`topbottom`/`front`/`behind`), `frame` (`para`/`page`/`paper`/`column`) | `<hp:pos>` horz/vertOffset + `treatAsChar`. `wrap` sets `textWrap` (`inline` = 글자처럼 취급, `treatAsChar="1"`); a **floating** wrap also sets `flowWithText="0"`+`allowOverlap="1"` so the **table/page won't grow** (a front object with flowWithText="1" still makes Hancom grow the cell). `frame` = the offset origin (`page`/`paper` have no per-paragraph clamp — use them to place a float above a body line; `para` clamps to the paragraph top). See the floating-placement note for frame origins. |
| `set_object_margin` | `target`, `index` | `left`, `right`, `top`, `bottom` (mm) | `<hp:outMargin>` — gap between the object and surrounding text. |
| `set_object_border` | `target`, `index` | `color`, `width_mm`, `line_type` (`solid`/`dashed`/`dotted`/`long-dash`/`dash-dot`/`dash-dot-dot`/`double`/`circle-dot`), `arrow_start`, `arrow_end` (`none`/`triangle`/`line`/`sharp`/`diamond`/`circle`/`square`/`empty-diamond`/`empty-circle`/`empty-square`) | `<hp:lineShape>` (shapes/lines). `line_type` is **not** `type` (that key is the op dispatch). Arrows apply to lines/open shapes only. ⚠️ Hancom web RENDER swaps `DASH`↔`DOT` visually (a `dashed` line looks dotted on screen) — the file's `style` is the standard value; trust it, not the screen. |
| `set_object_fill` | `target`, `index` | `color`, `transparency` (0–100), `pattern` (`horizontal`/`vertical`/`down-diagonal`/`up-diagonal`/`grid`/`cross`), `pattern_color` | `<hc:winBrush>`: `faceColor` + `alpha` (= transparency×255/100) + `hatchStyle`/`hatchColor` (pattern). Shapes only. |
| `delete_object` | `target` (`image`/`chart`/`shape`/`equation`), `index` | `renumber?` (default `true`) | **Deletes a floating object.** Removes its enclosing `<hp:p>` (no empty line left) + drops its external part & manifest item (image→`BinData/`, chart→`Chart/`). shape/textbox(=rect)/equation have no external part → only the paragraph goes. `index` is 0-based in document order (same addressing as `set_object_*`). **NUMBERING:** by default `renumber:true` shifts the remaining parts contiguous (deleting the middle image renames `image3`→`image2`, file + manifest id/href + section ref all together) so the output is **structurally identical to Hancom's own delete** (GT `delete-obj-after-mid-removed`, verified byte-for-byte). `renumber:false` keeps the gap (`image1`+`image3`) — also valid: refs are by id so it renders identically and the next insert fills the gap (gap-safe). (`delete_image` is the older by-name variant — leaves an empty paragraph, no renumber; prefer `delete_object`.) |

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
| `insert_hyperlink` | `index?`, `url`, `text` | Appends a clickable hyperlink to paragraph `index` (**`index` optional — defaults to the last top-level paragraph**, so a quick "link at the end of the doc" needs only `url`+`text`). Built as a paired Hancom field (`<hp:fieldBegin type="HYPERLINK">` … `<hp:t>text</hp:t>` … `<hp:fieldEnd>`) inside a new run, mirroring the verified structure from a real government doc. `text` is what the reader sees; `url` is the target. **Link-only paragraph pattern:** the op appends the link to whatever's in paragraph `index`, so to produce a paragraph that's just the link, first `append_paragraph` with empty `text: ""`, then `insert_hyperlink` targeting that new paragraph's index. |

### Images

| `type` | Args | Notes |
|--------|------|-------|
| `insert_image` | `source` (disk path), `ext?` (png/jpg/bmp/gif), `width_mm?`, `height_mm?` (preferred — millimetres), or raw `width?`/`height?` (HWPUNIT; default ~100mm), **`index?`** | Adds bytes to `BinData/`, registers a unique `<opf:item>` in the manifest, inserts a paragraph with an inline `<hp:pic>`. **`index` optional — places the image's paragraph AFTER top-level paragraph `index`** (like `insert_chart`), so the image lands next to its reference text; omit → appends to doc end. (2026-06-19: index added — previously it ALWAYS appended, which buried images on a trailing page in long docs.) **Use `width_mm`/`height_mm`** — raw `width`/`height` are HWPUNIT (1mm ≈ 283.46), so `50` is sub-mm and renders as a dot. |
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
| `insert_chart` | `chart_type?`, `cat?`, `series?`, `colors?`, `color?`, `point_colors?`, `width_mm?`, `height_mm?`, `wrap?`, `margin_mm?`, `x_mm?`, `y_mm?` | Appends a chart at the end of the last section. `width_mm`/`height_mm` set the chart size (default ≈114 × 66 mm); `wrap` = `inline` (글자처럼, **default** — chart sits on its own line where inserted; text flows above/below, no side-wrap mangling, and it can't drift to a later page) / `topbottom` (자리차지, floats but text only above/below) / `square` (어울림 — text wraps around; only when you want a side-by-side layout) / `front` / `behind`. **Default changed 2026-06-19 from `square`→`inline`** after a side-by-side render test (square mangled report section headings; behind overlapped text; inline & topbottom were clean — inline chosen for predictable in-place anchoring). **`margin_mm` = outer margin so surrounding text isn't crowded/covered (default ≈2.5 mm — keeps a gap above/below).** `x_mm`/`y_mm` nudge the position. `chart_type` accepts a **name** — `column` (default) / `bar` / `line` / `area` / `pie` / `doughnut` / `scatter` / `radar` — **or a numeric 0–19** covering Hancom's full type list (incl. stacked, 3D, exploded pie): 0 col · 1 col-stacked · 2 line · 3 bar · 4 bar-stacked · 5 scatter · 6 pie · 7 pie-exploded · 8 doughnut · 9 area · 10 area-stacked · 11 radar · 12–15 3D bar · 16–17 3D pie · 18–19 3D area. `cat` = category labels `["1월","2월","3월"]` (for `scatter`, numeric X values). `series` = `[{ "name": "매출", "values": [120,135,150] }, …]` (pie/doughnut use the first series only; values map to categories in order). The OOXML chart part is generated from this data; **all 20 types verified rendering on Hancom Docs web** (clustered/stacked bar, line, area, pie/doughnut/exploded, scatter, radar, 3D). |

```json
{"type":"insert_chart","chart_type":"column",
 "cat":["1월","2월","3월"],
 "series":[{"name":"매출","values":[120,135,150]},{"name":"비용","values":[80,75,90]}]}
{"type":"insert_chart","chart_type":"pie","cat":["A","B","C","D"],"series":[{"name":"점유율","values":[40,30,20,10]}]}
```

테마색 차트 예 (문서 테마에 맞춘 색):
```json
{"type":"insert_chart","chart_type":"column","cat":["1Q","2Q","3Q","4Q"],
 "series":[{"name":"매출","values":[980,1010,1046,1240]}],
 "point_colors":["#A9C4DE","#6F93BC","#3E6592","#1F3D5E"]}
{"type":"insert_chart","chart_type":"column","cat":["1Q","2Q","3Q"],
 "series":[{"name":"매출","values":[120,135,150]},{"name":"비용","values":[80,75,90]}],
 "colors":["#304D68","#9CC3E6"]}
```
- `point_colors` = 단일 계열 막대를 막대마다 다른 색(테마 연→진 그라데이션). `colors` = 다계열에서 계열마다 색. `color` = 전부 한 색. 색은 `#RRGGBB`(테마색 매칭) 권장.

### Shape (도형)

| `type` | Args | Notes |
|--------|------|-------|
| `insert_textbox` | `text`, `index?`, `width_mm?`, `height_mm?`, `fill_color?`, `line_color?`, `line_width_mm?`, `wrap?` | Inserts a text box (글상자) — a rectangle carrying `text` as one vertically-centered paragraph. Default ≈106 × 35 mm, `wrap` defaults `square` (글이 옆으로 흐름). `line_width_mm` = border thickness; `wrap` values as in `insert_chart`. Also `x_mm`/`y_mm` (position) and `margin_mm` (outer gap, default ~2 mm). |
| `insert_shape` | `shape`, `index?`, `width_mm?`, `height_mm?`, `fill_color?`, `line_color?`, `line_width_mm?`, `wrap?` | Inserts a drawing shape — `shape`: `rect` / `ellipse` / `line`. `line_width_mm` = border thickness; `wrap` = `front` (default) / `square` / `topbottom` / `behind` / `inline`. Also `x_mm`/`y_mm` (nudge position so stacked objects don't overlap) and `margin_mm` (outer gap from text). `width_mm` × `height_mm` set the size (default ≈53 × 24 mm; for `line` the line runs corner-to-corner of that box, so `height_mm: 0` = horizontal). `fill_color` (rect/ellipse, hex) + `line_color` (border, hex). **`wrap:"inline"` now sits the shape in the text flow (`treatAsChar="1"`) on its own line — no float/overlap** (2026-06-19 fix; before, inline was ignored and the shape floated over the next text). Floating wraps (front/square/topbottom/behind) still float relative to paragraph `index`; multiple floats at one spot overlap — vary `index` or `x_mm`/`y_mm`. Renders on Hancom Docs web (rect + ellipse verified). |
| `set_page_number` | `where?` (`footer` default / `header`), `align?` (`LEFT` / `CENTER` default / `RIGHT`) | Inserts a page number (쪽 번호) into the footer (or header) — a control that Hancom fills with the live page number on each page. `align` is best-effort: it reuses an existing paragraph style that already declares that horizontal alignment, otherwise it stays left. Adds a fresh footer/header; if the section already has one, the number is added as a new footer/header instance. |
| `set_caption` | `text`, `target?` (`image` default / `chart` / `shape` / `table`), `index?` (which one of that kind, default 0), `side?` (`BOTTOM` default / `TOP` / `LEFT` / `RIGHT`), `gap_mm?` (gap to the object, default ~3 mm) | Attaches a caption (캡션 — e.g. "그림 1." / "표 1.") to an object. Adds an `<hp:caption>` as the object's last child (after `shapeComment` for image/chart/shape, after the size/margin header for a table). Re-running replaces the existing caption. Verified against Hancom-native ground truth (image) + Hancom-web render (image and table). The caption width auto-matches the object's width (`TOP`/`BOTTOM`) or height (`LEFT`/`RIGHT`). |
| `place_seal` | `anchor` (text to find, e.g. "서명 또는 인"), `source` (seal/signature PNG path — square stamp **or** wide signature; aspect preserved), `mode?` (`auto` default / `overlap` / `right`), `size_mm?` (auto-sized from font + box when omitted — drives HEIGHT; width follows aspect), `dx_mm?` / `dy_mm?` (nudge, or absolute override in the chosen frame), `font_pt?`, `frame?` (auto per location; override `para`/`page`/`paper`), `ext?` | Overlays a seal/signature image **on** (`overlap` = concentric with the phrase) or **beside** (`right` = parallel, just right of it) an anchor phrase, as a **fixed floating object that never grows the table or page**. `auto` picks `right` when there's comfortable room beside the anchor, else `overlap`. Size auto-scales to the anchor's font (height ≈ line-height × 1.6, clamped 7–18 mm), capped by the cell/space; a wide signature keeps its aspect (not squashed). **Position is computed from font metrics + paragraph geometry — no render needed** (render is verification only). **Vertical alignment is automatic**: table cells use the table-relative frame, free body text uses the page frame so the stamp sits centred ON the line (it sums the heights of the blocks above to find the line). `dy_mm`/`frame` override (e.g. push a stamp up when a signature sits on a cell's bottom border). See the floating-placement note below. |

### Floating ("앞으로" / in-front) placement model — frames & the body-line clamp

A fixed floating object (`<hp:pos treatAsChar="0">`, `textWrap="IN_FRONT_OF_TEXT"`) is positioned by an offset from a **frame origin** (`vert/horzRelTo`), measured from Hancom render:

| `frame` | origin (offset 0,0 lands here) | clamp |
|---|---|---|
| `para` (default) | the **anchor paragraph's** top-left | ⚠️ can't rise **above that paragraph's top** |
| `page` | the **body content** top-left (inside margins) | none per-paragraph (only the page body top) |
| `paper` | the physical **paper** (0,0) corner | none |

- **Body-line clamp (why `place_seal` defaults to the page frame for free text):** in the `para` frame Hancom won't let the object rise above its anchor paragraph's top — a negative `vertOffset` is ignored, so a stamp taller than a one-line body paragraph would rest low (peek downward). The `page` frame has no such clamp, so `place_seal` uses it for free body text — summing the heights of the blocks above the anchor (real paraPr line-spacing + 문단여백) to land the stamp centred ON the line. Table cells don't have this clamp (their frame is the tall table), so they centre cleanly as-is. Override with `frame`/`dy_mm` if the estimate is off on an unusual layout.
- **No-grow rule:** a floating object with `flowWithText="1"` makes Hancom **grow the cell/row/page** to contain it *even though it's "in front"* — only `flowWithText="0"` stops that (place_seal always emits `0`, so a too-big stamp peeks out instead of stretching the table).
- **In a table cell** the floating origin is the **table's** anchor (table top / text-area left), *not* the cell — place_seal adds the preceding column widths + row heights + margins automatically so the stamp lands in the right cell. Cells have no clamp, so `dy_mm` moves the stamp freely up or down (e.g. push it up when the signature sits on a cell's bottom border).
- Seal/signature images are personal data — keep them in the user's private folder (chmod 600), out of the working dir; never display or echo them. A 4-character red square seal can be generated with `scripts/make_seal.py` when the user has no signature image.

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
