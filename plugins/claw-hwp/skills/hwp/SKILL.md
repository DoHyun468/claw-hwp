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
| Create new document from scratch | `node scripts/create.js` (edit content in-script first) |
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
| `scripts/create.js` | Node | Generate a new .hwpx from scratch via @rhwp/core |
| `scripts/convert.js` | Node | Convert `.hwp ↔ .hwpx` via rhwp WASM (no LibreOffice required) |
| `scripts/unpack.py` | Python | Unzip .hwpx → directory of pretty-printed XML |
| `scripts/pack.py` | Python | Repack directory → .hwpx with auto-repair |
| `scripts/validate.py` | Python | HWPX schema and structural validation |

## Dependencies

- **Python 3.9+** — `unpack.py`, `pack.py`, `validate.py` (standard library only)
- **Node.js 18+** — `extract_text.js`, `create.js`, `convert.js`. Depends on `@rhwp/core` and `fflate` declared in `scripts/package.json`.

**One-time setup** (after installing the skill):

```bash
cd skills/hwp/scripts
npm install
```

This installs `@rhwp/core` (HWP/HWPX WASM parser) and `fflate` (in-memory zip). Required before any Node script runs.

## References

- `references/hwpx-format.md` — HWPX file structure, XML schema cheatsheet, common edit patterns
- `references/rhwp-api.md` — `@rhwp/core` API surface for create/convert operations
