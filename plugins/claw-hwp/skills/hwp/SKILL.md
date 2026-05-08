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

**Op vocabulary** (in the order you'd typically use them):

| Op | Required | Optional |
|----|----------|----------|
| `setup_document` | `page_size` (`a4`/`b5`/...), `orientation` (`portrait`/`landscape`) | `margin_mm`, `base_font` |
| `append_heading` | `level` (1–6), `text` | `align`, `runs` |
| `append_paragraph` | `text` | `align`, `line_spacing`, `spacing_before`, `spacing_after`, `runs` |
| `append_table` | `headers`, `rows` | `col_widths_cm`, `merges`, `cell_props` |
| `append_image` | `path` | `width_cm`, `height_cm`, `alt` |
| `append_bullet_list`, `append_numbered_list` | `items[]` | — |
| `append_page_break` | — | — |
| `replace_text` | `query`, `replacement` | `case_sensitive` |

Inline `**bold**` and `*italic*` are parsed automatically inside `text` and table cell strings. `runs:[{text, bold?, italic?, fontSize?, color?}]` overrides the parser when you need finer control.

**Known limitations** (rhwp serializer constraints — applies to anything emitted via this skill):

- **HWPX tables are dropped by rhwp's `exportHwpx()`**. If a doc has tables, write `.hwp` and (if HWPX is required) round-trip through Hancom Office or 한컴독스 to re-emit the table XML. `convert.js` won't help — it goes through the same rhwp serializer.
- **HWP→HWPX downconversion is lossy** (tables, images, complex shapes). Default to `.hwp` for tables; default to `.hwpx` only when the document is text-heavy.

### "Edit this document" / "Replace X with Y" / "Add a new paragraph"

**For `.hwpx` files (recommended path):**

1. Unpack:
   ```bash
   python scripts/unpack.py path/to/file.hwpx /tmp/unpacked/
   ```
2. Edit XML files directly using your `Edit` tool. Key files:
   - `/tmp/unpacked/Contents/section0.xml` — main body content
   - `/tmp/unpacked/Contents/header.xml` — document-level styles, fonts, page settings
   - `/tmp/unpacked/Contents/content.hpf` — manifest
   See `references/hwpx-format.md` for element references and common edit patterns.
3. Repack:
   ```bash
   python scripts/pack.py /tmp/unpacked/ output.hwpx --original path/to/file.hwpx
   ```
4. Validate:
   ```bash
   python scripts/validate.py output.hwpx
   ```

**For `.hwp` (HWP 5.0 binary) files:**

```bash
# 1. Convert to .hwpx via rhwp WASM
node scripts/convert.js input.hwp /tmp/converted.hwpx
# 2. Then proceed with the .hwpx workflow above
```

**Output format default**: save edits as `.hwpx`. The HWPX format is the modern Hangul Office standard and avoids the lossy round-trip back to HWP 5.0 binary. Only convert back to `.hwp` if the user explicitly requires HWP 5.0 output (use `node scripts/convert.js output.hwpx final.hwp` and warn that some formatting may be lost).

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

## Dependencies

- **Python 3.9+** — `unpack.py`, `pack.py`, `validate.py` (standard library only)
- **Node.js 18+** — `extract_text.js`, `create.js`, `convert.js`. `@rhwp/core` (WASM parser, ~5 MB), `fflate` (zip, ~80 KB), and `cfb` (Compound File Binary, ~62 KB) are bundled in `scripts/vendor/` — **no `npm install` step required**.

## References

- `references/hwpx-format.md` — HWPX file structure, XML schema cheatsheet, common edit patterns
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/convert operations
