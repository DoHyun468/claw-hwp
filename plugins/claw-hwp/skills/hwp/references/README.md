# references/

Reference docs that Claude consults when reasoning about HWPX format edits or `@rhwp/core` API usage. These are loaded on-demand (not always in context).

## Status

🚧 v0 in progress.

| File | Status | Purpose |
|------|--------|---------|
| `hwpx-format.md` | not started | HWPX file structure, key XML elements (`<hp:p>`, `<hp:run>`, `<hp:tbl>`, etc.), namespaces, common edit patterns. Mirrors `anthropics/skills/docx/ooxml.md` |
| `rhwp-api.md` | not started | Curated `@rhwp/core` API surface: how to load bytes, extract text, create paragraphs/tables, export. Filtered from the full 1300-line `rhwp.d.ts` |
