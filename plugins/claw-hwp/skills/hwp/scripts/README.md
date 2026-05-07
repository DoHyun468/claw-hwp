# scripts/

Bundled scripts referenced by `SKILL.md`. Each script is intentionally low-level — Claude does the high-level reasoning and invokes these only for operations it can't do natively (zip handling, WASM calls).

## Status

End-to-end edit pipeline working. `create.js` deferred pending alignment with MyAgent's existing HWP creation tool.

| Script | Status | Notes |
|--------|--------|-------|
| `extract_text.js` | ✅ v0 | Default plaintext, `--format markdown` (skips empty layout tables), `--inspect` for JSON metadata. Handles both `.hwp` and `.hwpx` (in-memory rhwp conversion for binary) |
| `convert.js` | ✅ v0 | `.hwp ↔ .hwpx` via rhwp WASM. Output format from extension |
| `unpack.py` | ✅ v0 | `zipfile` + `xml.dom.minidom` pretty-print. `--no-pretty` flag for raw mode |
| `pack.py` | ✅ v0 | mimetype-first uncompressed entry per OPF spec. Sorted file order for reproducibility |
| `validate.py` | ✅ v0 | Zip integrity + mimetype + required files + XML well-formedness |
| `create.js` | ⏳ deferred | Must align with MyAgent's existing HWP creation tool — see project memory |
| `vendor/` | not needed (yet) | Currently using `npm install`. May bundle `@rhwp/core` files directly later for offline / sandbox use |

## Verified pipeline

End-to-end round-trip tested against rhwp's `samples/`:

1. `convert.js report.hwp report.hwpx` — convert HWP 5.0 binary to HWPX
2. `validate.py report.hwpx` — sanity check
3. `unpack.py report.hwpx /tmp/u/` — extract pretty-printed XML
4. *Edit XML files in `/tmp/u/Contents/section*.xml` using your `Edit` tool*
5. `pack.py /tmp/u/ output.hwpx` — repackage
6. `validate.py output.hwpx` — confirm structural integrity
7. `extract_text.js output.hwpx` — verify edits propagate

437-paragraph document survives round-trip with edit applied; structural counts preserved.

## One-time setup

```bash
cd skills/hwp/scripts
npm install
```

Installs `@rhwp/core` (~5MB WASM) and `fflate` (~45KB zip lib) into `node_modules/`. Required before any `*.js` script runs. Python scripts use the standard library only.
