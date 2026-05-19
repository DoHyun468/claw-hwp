---
name: hwp
description: Use this skill whenever the user wants to read, create, or edit Korean Hangul Word Processor documents (.hwp or .hwpx files). Triggers include any mention of 'hwp', 'hwpx', '한글 문서', '아래한글', '한컴오피스', or uploading/attaching .hwp/.hwpx files. Also use when extracting text from Korean reports or producing Korean-formatted official documents (공문, 보고서, 계약서, 사업계획서). Do NOT use for Word .docx files (use the docx skill instead) or general Korean text without Hangul Word Processor format.
license: MIT
---

# HWP / HWPX Skill

This skill helps Claude work with Korean Hangul Word Processor documents — reading, creating, and editing both the binary `.hwp` (HWP 5.0) and the ZIP-based `.hwpx` formats.

## Quick reference

| Task | Approach |
|------|----------|
| Read text content | `node scripts/extract_text.js <file>` — works for both .hwp and .hwpx |
| Read as markdown (preserves headings/tables) | `node scripts/extract_text.js --format markdown <file>` |
| Inspect structure (pages, sections, tables) | `node scripts/extract_text.js --inspect <file>` |
| Create new document from scratch | `echo '{"path":"out.hwp","operations":[...]}' \| node scripts/create.js` |
| Edit existing `.hwpx` | unpack → edit XML directly with `Edit` tool → pack |
| Edit existing `.hwp` (HWP 5.0 binary) | convert to `.hwpx` via `convert.js` first, then edit-as-hwpx |
| Convert `.hwp` ↔ `.hwpx` | `node scripts/convert.js <input> <output>` |
| Validate output | `python scripts/validate.py <file.hwpx>` |
| Preview file (Desktop = inline pane, CLI = browser link, cowork = drop-in viewer URL) | See Preview section for the surface decision rule |

> Conversion to PDF / DOCX is **out of scope for v0**. Will be added in a later release via LibreOffice headless.

## Format primer

- **`.hwpx`** — ZIP container holding XML. Same archetype as `.docx`. Use the unpack/edit/pack workflow. Internal layout includes `Contents/section0.xml` (body), `Contents/header.xml` (styles, fonts), `Contents/content.hpf` (manifest). See `references/hwpx-format.md`.
- **`.hwp`** — HWP 5.0 binary (CFB/OLE container). NOT a ZIP. Direct XML editing is impossible. For edits, convert to `.hwpx` via `convert.js`. For read-only operations, `extract_text.js` handles binary `.hwp` transparently via the rhwp WASM library.

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
| `append_image` | `path` | `width_cm`, `height_cm`, `alt` |
| `append_bullet_list`, `append_numbered_list` | `items[]` | — |
| `append_page_break` | — | — |

*In-place editing (run on an existing file — omit `setup_document` so create.js loads the path instead of starting blank):*

| Op | Required | Optional | Notes |
|----|----------|----------|-------|
| `replace_text` | `query`, `replacement` | `case_sensitive` | **Body text only.** rhwp's `searchText` does NOT walk into table cells, so anchor text inside `<hp:tbl>` is invisible — use `set_cell_text*` instead. |
| `set_cell_text` | `section`, `para`, `control`, (`row`+`col`) or `cell`, `text` | `cell_para` | Replaces one cell's text. `row`+`col` is recommended; `cell` is the flat row-major index. |
| `set_cell_text_by_label` | `label`, `text` | `row_offset`, `col_offset`, `occurrence`, `case_sensitive`, `cell_para`, `section`+`para`+`control` (to scope to one table) | Find a cell whose text contains `label`, then write to the cell at `(label_row + row_offset, label_col + col_offset)`. Doc-wide sweep by default. |

Inline `**bold**` and `*italic*` are parsed automatically inside `text` and table cell strings. `runs:[{text, bold?, italic?, fontSize?, color?}]` overrides the parser when you need finer control.

**Known limitations** (rhwp serializer constraints — applies to anything emitted via this skill):

- **HWPX tables are dropped by rhwp's `exportHwpx()`**. If a doc has tables, write `.hwp` and (if HWPX is required) round-trip through Hancom Office or 한컴독스 to re-emit the table XML. `convert.js` won't help — it goes through the same rhwp serializer.
- **HWP→HWPX downconversion is lossy** (tables, images, complex shapes). Default to `.hwp` for tables; default to `.hwpx` only when the document is text-heavy.
- **`replace_text` doesn't see table cells** (see op table above). For table-cell edits on an existing file, the `set_cell_text*` ops are the only path.

### "Edit this document" / "Replace X with Y" / "Add a new paragraph"

There are **two editing paths** with different capabilities. Pick by checking the input file extension AND whether the edit touches a table.

#### Decision rule

| Input | Edit touches a table cell? | Use |
|-------|----------------------------|-----|
| `.hwpx` | yes or no | **Path A** — unpack + XML edit + pack |
| `.hwp` | no (body text / paragraph only) | **Path A** — convert to `.hwpx` first, then unpack/edit/pack. Save back to `.hwp` only if required. |
| `.hwp` | **yes** | **Path B** — wasm op vocab on the original `.hwp`. Do NOT convert: rhwp's hwp→hwpx step drops tables. |

Detect format by reading the first two bytes — `PK` = HWPX (treat as `.hwpx` regardless of extension).

#### Path A — `.hwpx` XML edit (preferred for non-table edits)

Same archetype as `.docx`. Unpack → edit XML directly with the `Edit` tool → pack.

1. Unpack:
   ```bash
   python scripts/unpack.py path/to/file.hwpx /tmp/unpacked/
   ```
2. Edit files in `/tmp/unpacked/Contents/`:
   - `section0.xml` (plus `section1.xml`, ...) — body content
   - `header.xml` — document-level styles, fonts, page settings
   - `content.hpf` — manifest

   Common patterns:

   ```xml
   <!-- Body paragraph -->
   <hp:p id="..."><hp:run charPrIDRef="..."><hp:t>본문 텍스트</hp:t></hp:run>
     <hp:linesegarray>
       <hp:lineseg textpos="0" .../>
     </hp:linesegarray>
   </hp:p>

   <!-- Table cell -->
   <hp:tbl rowCnt="3" colCnt="2" ...>
     <hp:tr>
       <hp:tc rowSpan="1" colSpan="1">
         <hp:subList>
           <hp:p><hp:run charPrIDRef="..."><hp:t>100만원</hp:t></hp:run>
             <hp:linesegarray><hp:lineseg textpos="0" .../></hp:linesegarray>
           </hp:p>
         </hp:subList>
       </hp:tc>
     </hp:tr>
   </hp:tbl>
   ```

   **Lineseg cache invalidation.** `<hp:linesegarray>` is a precomputed line-break cache. If you change a `<hp:t>` text, the cache becomes stale and non-Hancom readers will draw text at wrong positions. Two ways to fix:
   - **Delete the `<hp:linesegarray>` block** on edited paragraphs. Hancom recalculates on open; the preview viewer's "자동 보정 ON" (default) does the same via `reflowLinesegs()`.
   - **Or** leave the cache and accept that the inline preview may show slight offsets until 자동 보정 is toggled.

3. Repack:
   ```bash
   python scripts/pack.py /tmp/unpacked/ output.hwpx --original path/to/file.hwpx
   ```
4. Validate:
   ```bash
   python scripts/validate.py output.hwpx
   ```

**When the input is `.hwp` but the edit doesn't touch tables**: convert first, then proceed.
```bash
node scripts/convert.js input.hwp /tmp/converted.hwpx
# Then unpack /tmp/converted.hwpx as above.
# To save back to .hwp afterwards:
node scripts/convert.js output.hwpx final.hwp
```

#### Path B — `.hwp` wasm ops (only path for in-place table-cell edits)

When the input is `.hwp` and a table cell needs to change, the hwpx round-trip drops the whole table — wasm op vocab is the only safe route. The flow is the same as create.js's normal flow, just on an existing file:

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

**Output format default**: save edits as `.hwpx`. The HWPX format is the modern Hangul Office standard and avoids the lossy round-trip back to HWP 5.0 binary. Only convert back to `.hwp` if the user explicitly requires HWP 5.0 output (use `node scripts/convert.js output.hwpx final.hwp` and warn that some formatting may be lost).

### "Show me what this looks like" / "Preview this HWP file"

The skill ships a tiny Node HTTP server (`scripts/preview-server.js`) that serves a vanilla-JS canvas-based viewer; rhwp WASM does the actual rendering in the browser, so the result matches Hancom Office closely. No LibreOffice, no external browser plugin.

**The preview path depends on which Claude surface you're running in.** The decision rule, applied first thing every time the user wants to view a file:

| Surface | Detection | What you do |
|---|---|---|
| **Claude Code Desktop** (Code mode in the desktop app) | `preview_start` / `preview_eval` / `preview_stop` tools are present | Use the host-managed inline pane. See "Inline pane path" below. |
| **Claude Code CLI** (and any other surface where Bash runs on the user's machine but no `preview_*` tools exist) | `uname -s` returns `Darwin` / `Linux` / `MINGW*` *and* no `preview_*` tools | Self-host: bash launches `preview-server.js`, then hand the user a markdown link. See "Self-host link path" below. |
| **Cowork** (claude.ai web cowork, Claude Desktop's cowork mode) | No `preview_*` tools, and you're inside a remote Linux sandbox (Bash can't reach the user's `localhost`) | Emit the file plus a one-line link to the hosted browser viewer; user downloads the file and drops it onto the viewer page. The OS-launcher block is the offline fallback. See "Cowork drop-in viewer path" below. Do not run `preview-server.js` inside the sandbox — its `localhost` is unreachable from the user's browser. |
| **Claude API direct** (developer's app embedding the SDK) | Depends on developer's deployment | If their Bash is on the user's machine, treat as CLI. If it's on a remote server, treat as cowork. |

#### Inline pane path (Claude Code Desktop only)

This is the only surface that exposes `preview_start` / `preview_eval` / `preview_stop`. Setup once per workspace via `.claude/launch.json`:

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
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/convert operations
