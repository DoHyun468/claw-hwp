---
name: hwp
description: Use this skill whenever the user wants to read, create, or edit Korean Hangul Word Processor documents (.hwp or .hwpx files). Triggers include any mention of 'hwp', 'hwpx', '한글 문서', '아래한글', '한컴오피스', or uploading/attaching .hwp/.hwpx files. Also use when converting Korean documents to PDF, extracting text from Korean reports, or producing Korean-formatted official documents (공문, 보고서, 계약서, 사업계획서). Do NOT use for Word .docx files (use the docx skill instead) or general Korean text without Hangul Word Processor format.
license: MIT
---

# HWP / HWPX Skill

This skill helps Claude work with Korean Hangul Word Processor documents — reading, creating, and editing both the binary `.hwp` (HWP 5.0) and the ZIP-based `.hwpx` formats.

## Quick reference

| Task | Approach |
|------|----------|
| Read text content | `node scripts/extract_text.js <file>` — works for both .hwp and .hwpx |
| Inspect structure (pages, sections, tables) | `node scripts/extract_text.js --inspect <file>` |
| Create new document from scratch | `node scripts/create.js` (edit content in-script first) |
| Edit existing `.hwpx` | unpack → edit XML directly with `Edit` tool → pack |
| Edit existing `.hwp` (HWP 5.0 binary) | convert to `.hwpx` via `soffice.py` first, then edit-as-hwpx |
| Convert `.hwp` ↔ `.hwpx` | `python scripts/soffice.py <input> <output>` |
| Convert to PDF / DOCX | `python scripts/soffice.py <input> <output.pdf>` |
| Validate output | `python scripts/validate.py <file.hwpx>` |

## Format primer

- **`.hwpx`** — ZIP container holding XML. Same archetype as `.docx`. Use the unpack/edit/pack workflow. Internal layout includes `Contents/section0.xml` (body), `Contents/header.xml` (styles, fonts), `Contents/content.hpf` (manifest). See `references/hwpx-format.md`.
- **`.hwp`** — HWP 5.0 binary (CFB/OLE container). NOT a ZIP. Direct XML editing is impossible. For edits, convert to `.hwpx` first via `soffice.py`. For read-only operations, `extract_text.js` handles binary `.hwp` transparently via the rhwp WASM library.

When in doubt about format, read the first two bytes — `PK` indicates ZIP (treat as HWPX even if extension is `.hwp`).

## Decision tree

### "Read this file" / "Summarize" / "Translate the content"

```bash
node scripts/extract_text.js path/to/file.hwp > /tmp/text.md
# Then read /tmp/text.md and respond
```

`extract_text.js` handles both `.hwp` and `.hwpx` via rhwp WASM. Output is markdown-formatted (paragraphs, tables, headings preserved).

For metadata only:
```bash
node scripts/extract_text.js --inspect path/to/file.hwp
# Returns JSON: { pageCount, sectionCount, paragraphCount, tableCount, hasImages, ... }
```

### "Create a new document" / "Write this as a hwp file"

```bash
node scripts/create.js
```

Default output is `output.hwpx`. The script is a template — edit the content blocks (paragraphs, tables, headings) inline before running. See `references/rhwp-api.md` for the @rhwp/core API.

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
# 1. Convert to .hwpx first
python scripts/soffice.py input.hwp /tmp/converted.hwpx
# 2. Then proceed with the .hwpx workflow above
```

Warn the user: HWP 5.0 → HWPX → HWP 5.0 round-trip may lose some formatting. If preserving original `.hwp` is critical, edit a copy and explain the lossiness.

### "Convert to PDF" / "Save as Word"

```bash
python scripts/soffice.py input.hwp output.pdf
python scripts/soffice.py input.hwpx output.docx
```

`soffice.py` wraps LibreOffice headless. Supported targets: `.pdf`, `.docx`, `.hwpx`, `.odt`, `.txt`, image formats.

## Common pitfalls

- **Korean fonts**: claude.ai sandbox may not have Hangul fonts. PDF/image output can show `□□□` instead of Korean characters. Install via `apt-get install -y fonts-nanum fonts-nanum-coding` if needed.
- **HWP 5.0 lossy round-trip**: round-tripping `.hwp` through `.hwpx` and back can drop formatting. Communicate this to the user before they overwrite an original `.hwp`.
- **Misnamed extensions**: a `.hwp` file may actually be HWPX (starts with `PK`). Detect by reading the magic bytes before deciding on workflow.
- **Encoding**: all HWPX XML is UTF-8. Never transcode. Don't escape Korean characters as XML entities — write them as-is.
- **Whitespace preservation**: HWPX uses `xml:space="preserve"` on text runs. When inserting new text via `Edit`, keep the attribute on the parent element or wrapping `<hp:t>` so leading/trailing spaces survive.

## Bundled scripts

| Script | Runtime | Purpose |
|--------|---------|---------|
| `scripts/extract_text.js` | Node | Read text or metadata from .hwp/.hwpx via rhwp WASM |
| `scripts/create.js` | Node | Generate a new .hwpx from scratch via @rhwp/core |
| `scripts/unpack.py` | Python | Unzip .hwpx → directory of pretty-printed XML |
| `scripts/pack.py` | Python | Repack directory → .hwpx with auto-repair |
| `scripts/validate.py` | Python | HWPX schema and structural validation |
| `scripts/soffice.py` | Python | LibreOffice headless wrapper for format conversion |

## Dependencies

- **Python 3.9+** — `unpack.py`, `pack.py`, `validate.py`, `soffice.py` (standard library only)
- **Node.js 18+** — `extract_text.js`, `create.js` (uses `@rhwp/core`, bundled in `scripts/vendor/`)
- **LibreOffice** — for `soffice.py`. Install: `brew install --cask libreoffice` (macOS) or `apt install libreoffice` (Linux). Pre-installed in claude.ai sandbox.

## References

- `references/hwpx-format.md` — HWPX file structure, XML schema cheatsheet, common edit patterns
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/edit operations
