---
name: hwp
description: Use this skill whenever the user wants to read, create, or edit Korean Hangul Word Processor documents (.hwp or .hwpx files). Triggers include any mention of 'hwp', 'hwpx', '한글 문서', '아래한글', '한컴오피스', or uploading/attaching .hwp/.hwpx files. Also use when extracting text from Korean reports or producing Korean-formatted official documents (공문, 보고서, 계약서, 사업계획서). Do NOT use for Word .docx files (use the docx skill instead) or general Korean text without Hangul Word Processor format.
license: MIT
---

# HWP / HWPX Skill

This skill helps Claude work with Korean Hangul Word Processor documents — reading, creating, and editing both the binary `.hwp` (HWP 5.0) and the ZIP-based `.hwpx` formats.

## Already installed — don't re-scaffold

If you're reading this SKILL.md, the `claw-hwp:hwp` skill is **already loaded** in this session. Everything below — read / create / edit / convert / preview for `.hwp` and `.hwpx` — is provided by this skill. You don't need to install, scaffold, or set anything up.

Treat the following user phrasings as **"show me a HWP file"** or **"edit a HWP file"** intent, not as setup requests:

| User says | Means | What to do |
|---|---|---|
| "claw-hwp 따라서 만들어줘" | "show me how to use it" | Wait for an actual `.hwp` / `.hwpx` file or task. Don't scaffold a new skill directory. |
| "preview 기능 설치해줘" / "preview 설정해줘" | "I want to view a HWP file" | The preview server is part of this skill. Start it with the launcher in the `Preview` section below. **No npm/node install step.** |
| "claw-hwp 스킬 설정해줘" / "set up the HWP plugin" | "make it work" | It already works. Ask the user which `.hwp` file they want to read / edit / preview. |

Do **not** run `npm install`, create new plugin/skill folders, or fetch dependencies — every script the user needs is already in `scripts/` (rhwp WASM and fflate are vendored under `scripts/vendor/`).

### Two "preview" terms that collide

- **Claude Code app's Preview side pane** (the side panel in the Code Desktop UI). This is a **host feature** of Claude Code itself. You don't install or configure it — it auto-discovers a process serving on `localhost:3737`. **Only available when the Code workspace is a local folder on this machine; disappears for server/remote folders.**
- **`scripts/preview-server.js`** — the **claw-hwp local server** that fills that pane. Start it via the launcher described in the `Preview` section. Default port is `3737`, the same port the Code pane auto-discovers.

When the user says "preview", they almost always mean "show me the file" — start the server, hand them the link or fire `preview_start` per the surface decision rule below. Do not interpret it as "install a new preview feature".

> **When `preview_start` / `preview_eval` / `preview_stop` tools are unavailable in this session, fall straight through to the self-host link path** (browser link to `http://localhost:3737/?path=<absolute>`). Don't tell the user "preview is not supported" — that's only true on cowork (remote sandbox). Server/remote folder workspaces in the Desktop app, plus all CLI sessions, simply run the local server and emit a browser link. The cowork drop-in viewer is the third option for sandbox-only setups.

## Quick reference

| Task | Approach |
|------|----------|
| Read text content | `node scripts/extract_text.js <file>` — works for both .hwp and .hwpx |
| Read as markdown (preserves headings/tables) | `node scripts/extract_text.js --format markdown <file>` |
| Inspect structure (pages, sections, tables) | `node scripts/extract_text.js --inspect <file>` |
| Create new document from scratch | `echo '{"path":"out.hwp","operations":[...]}' \| node scripts/create.js` |
| Edit existing `.hwpx` | `echo '{"path":"f.hwpx","operations":[...]}' \| node scripts/hwpx-edit.js` (op vocab in `references/hwpx-edit-ops.md`) |
| Edit existing `.hwp` | `echo '{"path":"f.hwp","operations":[...]}' \| node scripts/create.js` (raw-patch via `cell-patch.js` — byte-level in-place, preserves tables, Hancom-Docs compatible) |
| Convert `.hwp` ↔ `.hwpx` | `node scripts/convert.js <input> <output>` |
| Validate output | `python scripts/validate.py <file.hwpx>` |
| Preview file (Desktop = inline pane, CLI = browser link, cowork = drop-in viewer URL) | See Preview section for the surface decision rule |

> Conversion to PDF / DOCX is **out of scope for v0**. Will be added in a later release via LibreOffice headless.

## Format primer

- **`.hwpx`** — ZIP container holding XML. Same archetype as `.docx`. Use the unpack/edit/pack workflow. Internal layout includes `Contents/section0.xml` (body), `Contents/header.xml` (styles, fonts), `Contents/content.hpf` (manifest). See `references/hwpx-format.md`.
- **`.hwp`** — HWP 5.0 binary (CFB/OLE container). NOT a ZIP. Direct XML editing is impossible, but **byte-level in-place editing via `cell-patch.js`** lets you do text replace, cell content changes, paragraph/table append, page setup, and Phase A styling (text & paragraph) while keeping the original bytes intact (Hancom-Docs compatible). `extract_text.js` handles binary `.hwp` transparently for read.

When in doubt about format, read the first two bytes — `PK` indicates ZIP (treat as HWPX even if extension is `.hwp`).

## Decision tree

### "Read this file" / "Summarize" / "Translate the content"

```bash
node scripts/extract_text.js path/to/file.hwp > /tmp/text.txt
# Then read /tmp/text.txt and respond
```

`extract_text.js` handles both `.hwp` and `.hwpx` via rhwp WASM. Default output is plaintext (one paragraph per line).

For structured content (headings, tables, lists preserved):
```bash
node scripts/extract_text.js --format markdown path/to/file.hwp > /tmp/text.md
```

For metadata only:
```bash
node scripts/extract_text.js --inspect path/to/file.hwp
# Returns JSON: { pageCount, sectionCount, paragraphCount, tableCount, hasImages, ... }
```

### "Create a new document" / "Write this as a hwp file"

`create.js` reads a JSON payload from stdin and writes the file to the path you supply. Output format is decided by the path extension (`.hwp` = HWP 5.0 binary, `.hwpx` = OOXML).

```bash
echo '{
  "path": "report.hwp",
  "operations": [
    {"type": "setup_document", "page_size": "a4", "margin_mm": 25},
    {"type": "append_heading", "level": 1, "text": "월간 보고서"},
    {"type": "append_paragraph", "text": "이번 달 핵심 지표 요약입니다. 주요 변화는 **매출 증가**와 *비용 절감*입니다."},
    {"type": "append_table",
      "headers": ["항목", "지난달", "이번달"],
      "rows": [["매출", "100억", "120억"], ["비용", "80억", "75억"]]
    },
    {"type": "append_image", "path": "/abs/path/chart.png", "width_cm": 12, "height_cm": 6.6}
  ]
}' | node scripts/create.js
```

`stdout` returns one JSON line:

```json
{ "status": "success", "path": "report.hwp", "bytes_written": 14336, "ops_applied": 5,
  "verify": { "pageCountAfter": 1, "recovered": true },
  "log": ["…", "stripped 4 PARA_LINESEG record(s)"] }
```

Errors come back as `{"status": "error", "message": "...", "op_index": N}`. Always read the JSON to confirm — exit code 0 even on op-level failures isn't guaranteed.

**Op vocabulary** (grouped by purpose):

*Creation / appending content (used while building a doc top-down):*

| Op | Required | Optional |
|----|----------|----------|
| `setup_document` | `page_size` (`a4`/`b5`/...), `orientation` (`portrait`/`landscape`) | `margin_mm`, `base_font` |
| `append_heading` | `level` (1–6), `text` | `align`, `runs` |
| `append_paragraph` | `text` | `align`, `line_spacing`, `spacing_before`, `spacing_after`, `runs` |
| `append_table` | `headers`, `rows` | `col_widths_cm`, `merges`, `cell_props` |
| `append_image` ⚠️ | `path` | `width_cm`, `height_cm`, `alt` |
| `append_bullet_list`, `append_numbered_list` | `items[]` | — |
| `append_page_break` | — | — |
| `apply_text_style` ⚠️ | `target` (string to find) | `color`, `bold`, `italic`, `underline`, `strikethrough`, `size` (pt), `highlight` (`true` / `"#RRGGBB"` / `false`), `font_family`, `superscript`, `subscript`, `underline_color`, `letter_spacing`, `char_ratio`, `emphasis_dot` |
| `apply_paragraph_style` ⚠️ | `index` (paragraph index, 0-based) | `align`, `indent`, `line_spacing` (% e.g. 130), `margin_left`, `margin_right`, `spacing_before`, `spacing_after`, `background_color`, `page_break_before`, `keep_with_next` |

> ⚠️ **`append_image` rules of thumb (Hancom Docs compatibility — verified 2026-05-22):**
>
> - **Fresh `.hwp` from scratch (start with `setup_document`) + `append_image`** → Hancom Docs ✓. rhwp emit path produces a valid file; this is the same path Hop uses for new documents.
> - **`append_image` on an existing `.hwp` (in-place add)** → Hancom Docs ✗ in v1. We have a raw-patch implementation that lands all three required pieces (new `BinData/BIN000N.<ext>` stream, DocInfo `HWPTAG_BIN_DATA` registration, body `gso` + `SHAPE_COMPONENT_PICTURE` referencing the new `bin_data_id`), but on small mini-stream Section0 files the cluster expansion truncates and Hancom rejects. Falling back to rhwp emit doesn't help: rhwp's own `exportHwp()` round-trip is Hancom-Docs–rejected for any non-trivial existing file — **verified directly: Hop hits the same wall when it opens a big form and either modifies a cell or inserts an image, then saves** (2026-05-22 user-driven tests). The limitation is intrinsic to rhwp's serializer, not solvable by going through Hop's path or any rhwp-emit path.
> - **Workarounds for the in-place case:** (a) build the document from scratch in a single payload so the file never round-trips (rhwp emit + image works end-to-end), (b) pre-design the template with an image placeholder + use `replace_text` / `set_cell_text` to fill surrounding fields (those go through raw-patch and stay Hancom-compatible), or (c) use Hancom Office desktop which accepts the rhwp emit path for round-trip.

> ⚠️ **`apply_text_style` / `apply_paragraph_style` rules of thumb (Hancom Docs compatibility — verified 2026-05-27):**
>
> - **From-scratch `.hwp` + styling ops** → Hancom Docs ✓. Path: rhwp emit (same WASM Hop uses). All decorations (highlight = `shadeColor`, strikethrough, underline w/ color, bold, italic, font color/size, font family, letter spacing, super/subscript, emphasis dot) ride through `applyCharFormat`. `apply_paragraph_style` does the same via `applyParaFormat`.
> - **In-place styling on small `.hwp` (mini-stream Section0)** → Hancom Docs ✓. Same rhwp emit path; the same files that accept in-place image add are the ones that accept in-place styling.
> - **In-place `apply_text_style` on big `.hwp` (50+ pages, ktx-style)** → Hancom Docs ✓ (Phase B raw-patch CharShape, verified). Dispatcher routes `apply_text_style` through `cell-patch.js applyTextStyleInPlace` — appends a new CHAR_SHAPE to DocInfo, bumps `HWPTAG_ID_MAPPINGS` CHAR_SHAPE count, splices the target range into the paragraph's PARA_CHAR_SHAPE, bumps PARA_HEADER `num_char_shapes`. For highlight, also inserts a PARA_RANGE_TAG (tag=`(0x02<<24)|BGR`) and bumps `range_tags_count`. All Hancom-Docs–compatible.
> - **In-place `apply_paragraph_style` on big `.hwp`** → Hancom Docs ✗ in v1 (still on rhwp emit path). raw-patch ParaShape / BorderFill extension is the next planned step.
> - **Key rhwp prop names** (the op accepts user-friendly aliases — listed → internal): `color` → `textColor`, `size` (pt) → `fontSize` (HWP units), `highlight` → `shadeColor`, `font_family` → `fontFamilies[7]` broadcast across all 7 language scripts, `letter_spacing` → `spacings[7]`, `char_ratio` → `ratios[7]`. Highlight is the **non-obvious one** — it's NOT called `highlight` / `background` / `charBgColor` in rhwp internals. We map for you.
> - **Targeting**: `apply_text_style` finds the **first body-text occurrence** of `target` (top-level paragraphs only — table cells, headers, footers, footnotes not yet searched). For multiple occurrences, use a longer unique substring or apply once at a time. Cell styling: Phase B work item.
> - **`font_family`** works for any installed font (e.g., "맑은 고딕", "함초롬돋움", "굴림", "바탕", "Arial"). Internally the op calls `rhwp.findOrCreateFontId(name)` to register the font in DocInfo's FACE_NAME table (all 7 language scripts at once), then writes `fontIds: [id × 7]` on the CharShape. If the name resolves to a valid ID, Hancom Docs renders with that font; if not (negative ID return), it silently falls back to the default `함초롬바탕`. There is no built-in shape-check — the font must exist on the reader's system for the glyphs to render correctly, but the file's CharShape will carry the requested name either way.
> - **`apply_paragraph_style` index aliases**: pass `index: "last"` (or `-1`) to target the most recently appended paragraph. Useful when intermediate `append_heading` / `append_paragraph` ops would otherwise force you to count: just append + style + repeat.
> - **Hancom Docs renderer limits (writes ride through but the web viewer ignores them):**
>   - **`emphasis_dot`** (강조점) — written into CharShape; Hancom Office Desktop renders it, but **한컴독스 (web/cloud) silently drops it**. Use sparingly if 한컴독스 is the primary reader.

*In-place editing (run on an existing file — omit `setup_document` so create.js loads the path instead of starting blank):*

| Op | Required | Optional | Notes |
|----|----------|----------|-------|
| `replace_text` | `query`, `replacement` | `case_sensitive` | **Body text only.** rhwp's `searchText` does NOT walk into table cells, so anchor text inside `<hp:tbl>` is invisible — use `set_cell_text*` instead. |
| `set_cell_text` | `section`, `para`, `control`, (`row`+`col`) or `cell`, `text` | `cell_para` | Replaces one cell's text. `row`+`col` is recommended; `cell` is the flat row-major index. |
| `set_cell_text_by_label` | `label`, `text` | `row_offset`, `col_offset`, `occurrence`, `case_sensitive`, `cell_para`, `section`+`para`+`control` (to scope to one table) | Find a cell whose text contains `label`, then write to the cell at `(label_row + row_offset, label_col + col_offset)`. Doc-wide sweep by default. |

Inline `**bold**` and `*italic*` are parsed automatically inside `text` and table cell strings. `runs:[{text, bold?, italic?, underline?, strikethrough?, fontSize?, color?, highlight?, font_family?, superscript?, subscript?, underline_color?, letter_spacing?, char_ratio?, emphasis_dot?}]` overrides the parser when you need finer control over a run. All `apply_text_style` props are available per-run too (same Phase A limits as the standalone op — works on from-scratch + small files, big-form in-place styling is Phase B).

**Known limitations** (rhwp serializer constraints — applies to anything emitted via this skill):

- **`.hwpx` from-scratch drops tables**: rhwp's `exportHwpx()` strips tables when `create.js` writes a fresh `.hwpx` or `convert.js` runs `.hwp → .hwpx`. For a new `.hwpx` with tables, write `.hwp` instead — or start from an existing `.hwpx` with tables and add/edit via `hwpx-edit.js` (`insert_table`, cell ops). **Editing an existing `.hwpx` preserves its tables in place.**
- **`.hwp ↔ .hwpx` conversion via `convert.js` is lossy** (tables, images, complex shapes can break). Editing in the original format (`.hwp` raw-patch / `.hwpx` XML edit) keeps everything intact — only run `convert.js` when the user explicitly asks for a format change.
- **`replace_text` doesn't see table cells** (see op table above). For table-cell edits on an existing file, the `set_cell_text*` ops are the only path.
- **Big-form (50+ page) in-place `apply_text_style`** is supported via raw-patch CharShape (verified). **`apply_paragraph_style`** on big forms is still rhwp emit and will be raised onto raw-patch in a follow-up (ParaShape / BorderFill).

### "Edit this document" / "Replace X with Y" / "Add a new paragraph"

**Edit in the input's original format.** `.hwp` stays `.hwp`, `.hwpx` stays `.hwpx` — both paths preserve tables, both are Hancom-Docs compatible, no conversion needed.

#### Decision rule

| Input | Use | What's available |
|-------|-----|------------------|
| `.hwpx` | **`hwpx-edit.js`** | text · paragraph · table (`insert_table`, cell content/background/border/diagonal/align/size, row/column, merge) · image (insert/replace/delete) · char & paragraph styling · header/footer · page break · bullet/number lists (style: korean/decimal, custom bullet glyph) · footnote/endnote · hyperlink |
| `.hwp` | **`create.js`** (raw-patch via `cell-patch.js`) | set_cell_text · replace_text · append_paragraph/heading/table/list/break · setup_document · apply_text_style · apply_paragraph_style |

Detect format by reading the first two bytes — `PK` = HWPX (treat as `.hwpx` regardless of extension).

Conversion between formats (`.hwp ↔ .hwpx`) is a **separate** tool — only use when the user explicitly requests a format change. It goes through rhwp's serializer which drops tables.

#### `.hwpx` editing — `hwpx-edit.js`

`scripts/hwpx-edit.js` applies deterministic, named operations to a `.hwpx` directly on its OWPML XML — no hand-editing. Pipe a JSON payload to stdin: one ZIP load, N ops applied in order, one save. It mirrors `create.js`'s stdin-JSON shape.

```bash
echo '{
  "path": "path/to/file.hwpx",
  "output": "out.hwpx",
  "operations": [
    {"type": "fill_template", "values": {"{{이름}}": "남대현", "{{회사}}": "RECON Labs"}},
    {"type": "set_cell_text", "table": 2, "row": 1, "col": 1, "text": "100만원"},
    {"type": "append_paragraph", "text": "새 문단"}
  ]
}' | node scripts/hwpx-edit.js
```

Returns JSON `{ ok, output, results: [...] }`. The whole batch is **atomic** — if any op errors, nothing is saved and the error names the failing op index. `output` defaults to `<input>_edited.hwpx`; pass `"output": "<same path>"` to overwrite in place.

The full operation vocabulary (text · paragraph · table including `insert_table` + cell content/background/border/diagonal/align/size + row/column + merge · char/paragraph styling · image insert/replace/delete · header/footer · page break · bullet/number lists · footnote/endnote · hyperlink · field) is documented in **`references/hwpx-edit-ops.md`** — read it before composing a payload. Table/paragraph indices are **document-order, 0-based**; discover them with `extract_text.js --inspect` and `--format markdown`.

Notes:
- `hwpx-edit.js` is **`.hwpx` only** — it rejects `.hwp` with a clear error. Use the `.hwp` path (next section) for `.hwp` input.
- It strips the stale `<hp:linesegarray>` cache on paragraphs/rows it rebuilds, so Hancom relayouts correctly on open (no manual lineseg surgery needed).
- It keeps `mimetype` stored-uncompressed and bumps `itemCnt` on `hh:charProperties` / `hh:paraProperties` when adding styles, so output stays Hancom-strict-valid.

**Fallback — manual unpack/edit/pack** (only for edits no op covers, e.g. exotic OWPML the op set doesn't reach):

1. Unpack: `python scripts/unpack.py path/to/file.hwpx /tmp/unpacked/`
2. Edit `/tmp/unpacked/Contents/section0.xml` (body), `header.xml` (styles/fonts), `content.hpf` (manifest) with the `Edit` tool.
   **Lineseg cache:** after changing any `<hp:t>`, delete that paragraph's `<hp:linesegarray>` block — it's a stale line-break cache; Hancom recomputes on open (the preview viewer's "자동 보정 ON" does the same via `reflowLinesegs()`).
3. Repack: `python scripts/pack.py /tmp/unpacked/ output.hwpx --original path/to/file.hwpx`
4. Validate: `python scripts/validate.py output.hwpx`

#### `.hwp` editing — `create.js` (raw-patch via `cell-patch.js`)

For `.hwp` input, route through `create.js`. When the path already exists and the first op is NOT `setup_document`, `create.js` loads the file and dispatches `RAW_PATCH_OPS` (set_cell_text · replace_text · append_paragraph/heading/table/list/break · setup_document · apply_text_style · apply_paragraph_style) through `cell-patch.js` for **byte-level in-place editing** — the original bytes stay intact, only the modified records are patched, and the output is Hancom-Docs compatible (verified). No `.hwp → .hwpx` conversion involved, so tables are preserved end-to-end.

1. Write a JSON op script and pipe it into `create.js`. Because the path already exists and the first op is NOT `setup_document`, create.js loads the existing file:
   ```bash
   echo '{
     "path": "/Users/me/budget.hwp",
     "operations": [
       {"type": "set_cell_text_by_label",
        "label": "1차년도 현금", "col_offset": 1, "text": "100만원"},
       {"type": "set_cell_text",
        "section": 0, "para": 1, "control": 0, "row": 2, "col": 1, "text": "50만원"}
     ]
   }' | node scripts/create.js
   ```

2. To discover the right `section / para / control / row / col` coordinates when you don't already know them, dump table structure with `extract_text.js --inspect` (table count + per-table dimensions), or write a tiny probe that calls rhwp's `getCellInfo(sec, para, ctrl, idx)` until it errors. The `set_cell_text_by_label` op handles the common case ("set the cell next to the row labeled X") with no coordinates needed.

3. **`replace_text` will silently miss table cells.** rhwp's `searchText` (and therefore `replaceOne`) does not enter `<hp:tbl>`. If `replace_text` reports 0 matches on what looks like a present anchor, the anchor is almost certainly inside a table — switch to `set_cell_text_by_label`.

4. **Auto-preview after writes.** Per the trigger guidance below, fire `preview_start` / `preview_eval` immediately after the write so the user sees the edit, instead of asking them to verify.

**Output format default**: **keep the input's original format**. `.hwp` in → `.hwp` out (raw-patch via `cell-patch.js`, tables preserved). `.hwpx` in → `.hwpx` out (XML edit via `hwpx-edit.js`, tables preserved). Use `convert.js` only when the user explicitly requests a `.hwp ↔ .hwpx` format change — it routes through rhwp's serializer which drops tables.

### "Show me what this looks like" / "Preview this HWP file"

The skill ships a tiny Node HTTP server (`scripts/preview-server.js`) that serves a vanilla-JS canvas-based viewer; rhwp WASM does the actual rendering in the browser, so the result matches Hancom Office closely. No LibreOffice, no external browser plugin.

**The preview path depends on which Claude surface you're running in.** The decision rule, applied first thing every time the user wants to view a file:

| Surface | Detection | What you do |
|---|---|---|
| **Claude Code Desktop — local folder** (Code mode pointing at a directory on this machine) | `preview_start` / `preview_eval` / `preview_stop` tools are present | Use the host-managed inline pane. See "Inline pane path" below. |
| **Claude Code Desktop — server / remote folder**, **Claude Code CLI**, and any other surface where Bash runs on the user's machine but no `preview_*` tools exist | No `preview_*` tools, and `curl -fsS http://localhost:3737/__heartbeat` (or trying to start a Node server there) succeeds. The Desktop inline pane **disappears when the workspace is a server/remote folder** — don't insist on `preview_start`, just fall straight through to this row and self-host. | Self-host: bash launches `preview-server.js` on `localhost:3737`, then emit a markdown link the user clicks to open in their browser. See "Self-host link path" below. |
| **Cowork** (claude.ai web cowork, Claude Desktop's cowork mode) | No `preview_*` tools, and you're inside a remote Linux sandbox — Bash on Anthropic's container, **not on the user's machine**. The sandbox's `localhost:3737` is reachable from the sandbox itself but **not from the user's browser** (the two networks are isolated by design). | Emit the file plus a one-line link to the hosted browser viewer; user downloads the file and drops it onto the viewer page. The OS-launcher block is the offline fallback. See "Cowork drop-in viewer path" below. **Do not run `preview-server.js` inside the sandbox** — the user's browser can't reach it. |
| **Claude API direct** (developer's app embedding the SDK) | Depends on developer's deployment | If their Bash is on the user's machine, treat as the self-host row above. If it's on a remote server they own, treat as cowork. |

#### Inline pane path (Claude Code Desktop — local folder only)

This is the only surface that exposes `preview_start` / `preview_eval` / `preview_stop`. Detection: try invoking `preview_start` (or check the tool inventory). If the tools aren't there, the workspace is a server/remote folder — skip this section and go to "Self-host link path" below. Setup once per workspace via `.claude/launch.json`:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "claw-hwp-preview",
      "runtimeExecutable": "node",
      "runtimeArgs": ["${CLAUDE_PLUGIN_ROOT}/skills/hwp/scripts/preview-server.js"],
      "port": 3737
    }
  ]
}
```

If missing, create or merge before calling `preview_start`. Code substitutes `CLAUDE_PLUGIN_ROOT` at load time. (When typing the path manually for debugging, an installed plugin lives at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.) Port `3737` is the default; override via `CLAW_HWP_PREVIEW_PORT`.

Lifecycle — the viewer is a long-lived page in a long-lived pane. You do NOT spawn a fresh server per file.

1. **`preview_start`** with `name: "claw-hwp-preview"`. Returns either a fresh pane or `reused: true` if one is already open.
2. **`preview_eval`** to set `window.location.href = "http://localhost:3737/?path=<absolute path>"`. Use this both for the first navigation and for swapping files. Do not start a second server.
3. **`preview_stop`** when you need to recover a stuck pane (below).

Stuck pane recovery — when `preview_start` returns `reused: true` but nothing is visible (the prior pane was closed/hidden), hard-reset: `preview_stop` → `preview_start` → `preview_eval`. Don't ask the user, just do it.

Pair with hosted-viewer link — after the inline pane is up, append a single auxiliary line so the user has a one-click escape to a full browser window (bigger view, side-by-side compare, easy sharing). The pane stays the primary path; this just gives them options:

```
큰 화면이나 공유가 필요하면 [브라우저에서 열기](https://dohyun468.github.io/claw-hwp/) — 파일을 끌어 놓으세요.
```

Don't repeat the link on every preview swap inside the same conversation — once per session is enough.

#### Self-host link path (Claude Code CLI, local-bash API setups)

No host-managed pane available, but Bash can reach the user's localhost. Health-check first; if dead, start it yourself — never ask the user to run anything.

> **UX caveat:** the browser preview is a lightweight inspection viewer (zoom, page navigation, text selection) — not a full-fidelity Hangul renderer. **For careful review or editing**, mention these alternatives in the same response as the preview link:
> - **[Hop desktop app](https://github.com/golbin/hop)** (macOS / Windows / Linux) — open-source Hangul viewer/editor on the same rhwp WASM core, with a real editor UX.
> - **한컴오피스 한글 / 한컴독스** — original-fidelity rendering if the user has a license or 한컴독스 account.
> - **PDF export via Hop** — file → PDF 내보내기. Our plugin's `.hwp → .pdf` conversion is on the v2 roadmap (LibreOffice headless / Hop CLI), not in v1.
> CLI preview is for "quick check while working." Detail review goes elsewhere.

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-}/skills/hwp/scripts/preview-server.js"
[ -f "$SCRIPT" ] || SCRIPT=$(find "$HOME/.claude/plugins/cache/claw-hwp" \
  -path '*/skills/hwp/scripts/preview-server.js' 2>/dev/null | sort -V | tail -1)
curl -fsS -o /dev/null http://localhost:3737/__heartbeat || \
  node "$SCRIPT" >/tmp/claw-hwp-preview.log 2>&1 &
disown 2>/dev/null || true
sleep 0.5
```

Then emit a markdown link the user clicks to open in their default browser:

```
[열기 — <filename>](http://localhost:3737/?path=<absolute path>)
```

`preview-server.js` self-exits ~2 minutes after the last viewer tab closes (heartbeat-based), so on a return visit you may need to repeat the health-check + relaunch. The script handles that — just always run the snippet above before emitting a link.

#### Cowork drop-in viewer path (cowork = remote sandbox, no local Bash)

The sandbox's `localhost:3737` is unreachable from the user's browser, so we can't open the viewer from the agent side. Instead, the same viewer is hosted as a **static page on GitHub Pages**: the user opens the URL once in their browser and then drag-drops (or file-picks) the `.hwp`/`.hwpx` to render it locally in-tab. No download, no install, no Node required — rhwp WASM runs directly in the browser.

After writing the HWP file, append this block to your reply:

```
**미리보기:** 위 파일을 받아서 아래 페이지에 끌어 놓으면 바로 열려요:
<https://dohyun468.github.io/claw-hwp/>

(Drag-drop 또는 우측 상단 폴더 아이콘으로 파일 선택. 파일은 브라우저 안에서만 열리고 서버에 업로드되지 않습니다.)
```

Fallback — if the user is offline or the GitHub Pages URL is unreachable, the OS launcher path still works. It runs the same viewer locally via `preview-server.js`. Only emit this if the user reports the URL doesn't work:

```
**오프라인 미리보기 (대안):** OS 별 launcher 받아서 위 파일과 같은 폴더에 두고 더블클릭. Node.js 18+ 필요.

- macOS: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-mac.command>
- Windows: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-windows.bat>
- Linux: <https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/plugins/claw-hwp/skills/hwp/scripts/launcher/preview-linux.sh>
```

What the launcher does on the user's machine (kept for the fallback path):
1. Looks for `preview-server.js` in the local Claude plugin cache (`~/.claude/plugins/cache/claw-hwp/...`). If found, uses it.
2. Otherwise downloads `scripts/` from the GitHub `main` tarball into `~/.claw-hwp-launcher/` (~5 MB, one-time).
3. Boots `preview-server.js` on `localhost:3737` if not already up (idempotent — health-checks first).
4. Opens the user's default browser at `http://localhost:3737/?path=<absolute path of the .hwp/.hwpx>`.

Auto-detection: if no file argument is passed, the launcher picks the most recent `.hwp`/`.hwpx` in its own directory. Server lifetime: `preview-server.js` self-exits ~2 minutes after the last viewer tab closes.

#### When to fire preview (all paths)

Don't ask, just do it. Visual verification is your job.

1. Right after `create.js` / `convert.js` writes a new file or finishes a format conversion.
2. Right after the user uploads a `.hwp` / `.hwpx` or mentions one by path.
3. Right after edits (`replace_text`, unpack-edit-pack round-trip).

In Desktop and CLI paths, "fire preview" means open the viewer / link directly. In cowork, "fire preview" means emit the hosted-viewer URL block alongside the file (launcher block only if asked or offline). Never write "please check if the file looks right" — give the user a working preview path.

## Common pitfalls

- **HWP 5.0 lossy round-trip**: `.hwp` → `.hwpx` → `.hwp` may drop formatting. Default to `.hwpx` output. Only round-trip back to `.hwp` on explicit user request, and warn first.
- **Misnamed extensions**: a `.hwp` file may actually be HWPX (starts with `PK`). Detect by reading the magic bytes before deciding on workflow.
- **Encoding**: all HWPX XML is UTF-8. Never transcode. Don't escape Korean characters as XML entities — write them as-is.
- **Whitespace preservation**: HWPX uses `xml:space="preserve"` on text runs. When inserting new text via `Edit`, keep the attribute on the parent element or wrapping `<hp:t>` so leading/trailing spaces survive.
- **`.hpf` manifest sync**: when adding/removing files in the unpacked dir, `pack.py` regenerates the manifest. Do not hand-edit `Contents/content.hpf` unless you know the schema.

## Bundled scripts

| Script | Runtime | Purpose |
|--------|---------|---------|
| `scripts/extract_text.js` | Node | Read text, markdown, or metadata from .hwp/.hwpx via rhwp WASM |
| `scripts/create.js` | Node | Generate a new .hwp / .hwpx from a stdin JSON op script via rhwp |
| `scripts/hwpx-edit.js` | Node | Edit an existing **.hwpx** via stdin JSON ops (text/table/style/image) — direct OWPML XML, no rhwp. See `references/hwpx-edit-ops.md` |
| `scripts/convert.js` | Node | Convert `.hwp ↔ .hwpx` via rhwp WASM (no LibreOffice required) |
| `scripts/unpack.py` | Python | Unzip .hwpx → directory of pretty-printed XML |
| `scripts/pack.py` | Python | Repack directory → .hwpx with auto-repair |
| `scripts/validate.py` | Python | HWPX schema and structural validation |
| `scripts/preview-server.js` | Node | Static HTTP server backing the Claude Code preview pane viewer |
| `scripts/preview-viewer.html` + `scripts/preview-viewer.js` | static | Canvas-based vanilla-JS HWP viewer (vendored rhwp WASM, no React) |

## Dependencies

- **Python 3.9+** — `unpack.py`, `pack.py`, `validate.py` (standard library only)
- **Node.js 18+** — `extract_text.js`, `create.js`, `convert.js`. `@rhwp/core` (WASM parser, ~5 MB), `fflate` (zip, ~80 KB), and `cfb` (Compound File Binary, ~62 KB) are bundled in `scripts/vendor/` — **no `npm install` step required**.

## References

- `references/hwpx-format.md` — HWPX file structure, XML schema cheatsheet, common edit patterns
- `references/hwpx-edit-ops.md` — `hwpx-edit.js` operation vocabulary (every op, its args, and examples)
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/convert operations
