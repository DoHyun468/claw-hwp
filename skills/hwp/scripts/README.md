# scripts/

Bundled scripts referenced by `SKILL.md`. Each script is intentionally low-level — Claude does the high-level reasoning and invokes these only for operations it can't do natively (zip handling, WASM calls, LibreOffice subprocess).

## Status

🚧 v0 in progress. Scripts not yet implemented.

| Script | Status | Notes |
|--------|--------|-------|
| `extract_text.js` | not started | Node + bundled `@rhwp/core` WASM. Two modes: text dump (default) or `--inspect` JSON metadata |
| `create.js` | not started | Template script. User/Claude edits content blocks before running. Uses `@rhwp/core` `HwpDocument.createEmpty()` + `exportHwpx()` |
| `unpack.py` | not started | `zipfile` + `xml.etree` for pretty-print. Mirrors `anthropics/skills/docx/scripts/office/unpack.py` |
| `pack.py` | not started | Inverse of unpack. Auto-repair common HWPX issues |
| `validate.py` | not started | Structural checks (manifest matches files, XML well-formedness, root elements) |
| `soffice.py` | not started | `subprocess` wrapper around `soffice --headless --convert-to <fmt>`. Mirrors docx skill's `soffice.py` |
| `vendor/` | not started | Bundled `@rhwp/core` (`rhwp.js` + `rhwp_bg.wasm`) for offline operation |
