# `@rhwp/core` API reference (curated)

Reference for the `@rhwp/core` WASM library (Edward Kim, MIT). The full `rhwp.d.ts` is ~1600 lines and ~250 methods — this document curates the ~30 methods you actually need to read, edit, or generate Korean Hangul documents from Node scripts.

> **Status**: v0.6. Covers init / load / read / edit (text & tables) / styles / export. Bookmarks, footnotes, equations, drawings, and field/form objects are not covered yet.

---

## Loading the library in Node

The package ships as a wasm-bindgen `--target web` build, so init takes WASM bytes explicitly. The vendored copy lives at `scripts/vendor/rhwp/`.

```js
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const wasmBytes = fs.readFileSync(path.join(__dirname, 'vendor', 'rhwp', 'rhwp_bg.wasm'));
const rhwp = await import('./vendor/rhwp/rhwp.js');
await rhwp.default({ module_or_path: wasmBytes });

// Library is now ready. Bindings are on `rhwp`:
//   rhwp.HwpDocument       — main document class
//   rhwp.HwpViewer         — rendering wrapper (out of scope for scripts)
//   rhwp.extractThumbnail  — pull preview PNG without parsing the whole doc
//   rhwp.version()         — rhwp build version string
//   rhwp.init_panic_hook() — opt-in, sends Rust panic info to console
```

---

## Document lifecycle

### `new HwpDocument(bytes: Uint8Array)`

Loads a `.hwp` (HWP 5.0 binary) **or** `.hwpx` (zip). Format auto-detected from the bytes.

```js
const fileBytes = fs.readFileSync('report.hwp');
const doc = new rhwp.HwpDocument(new Uint8Array(fileBytes));
```

### `HwpDocument.createEmpty(): HwpDocument` — static

Creates a blank document. Useful as the starting point for `create.js`-style generation. The empty doc has 1 section with 1 empty paragraph.

```js
const doc = rhwp.HwpDocument.createEmpty();
```

### `doc.free(): void`

Releases the WASM-backed memory. **Always call this for short-lived scripts** — wasm-bindgen FinalizationRegistry exists, but explicit `free()` is the safe path. Wrap in try/finally:

```js
try {
  doc.insertText(0, 0, 0, '안녕하세요');
  fs.writeFileSync('out.hwpx', doc.exportHwpx());
} finally {
  doc.free();
}
```

---

## Export

### `doc.exportHwp(): Uint8Array`

Serialize as HWP 5.0 binary (CFB / OLE container).

### `doc.exportHwpx(): Uint8Array`

Serialize as HWPX (zip + XML). **Prefer this** — losslessly round-trips through claw-hwp's other scripts and is the modern Hangul Office default since 2021.

```js
fs.writeFileSync('out.hwpx', doc.exportHwpx());
```

### `doc.exportHwpVerify(): string`

Returns a JSON string with internal verification metadata (record counts, IDRef integrity). Useful for debugging save-time corruption.

---

## Reading structure

### Counts

```ts
doc.getSectionCount(): number
doc.getParagraphCount(secIdx: number): number
doc.getParagraphLength(secIdx: number, paraIdx: number): number   // char count
doc.pageCount(): number
```

### Document metadata

```ts
doc.getDocumentInfo(): string   // JSON: title, author, created/modified dates, etc.
```

### Body text — read

```ts
doc.getTextRange(secIdx: number, paraIdx: number, charOffset: number, count: number): string
```

Walks runs and concatenates `<hp:t>` content. To dump a whole paragraph:

```js
const text = doc.getTextRange(0, 5, 0, doc.getParagraphLength(0, 5));
```

### Cell text — read

```ts
doc.getCellParagraphCount(secIdx, parentParaIdx, controlIdx, cellIdx): number
doc.getCellParagraphLength(secIdx, parentParaIdx, controlIdx, cellIdx, cellParaIdx): number
doc.getTextInCell(secIdx, parentParaIdx, controlIdx, cellIdx, cellParaIdx, charOffset, count): string
```

`controlIdx` is the index of the table control within the parent paragraph's run sequence. Most documents have one table per parent paragraph (controlIdx=0).

---

## Editing — body text

| Method | Notes |
|--------|-------|
| `insertText(secIdx, paraIdx, charOffset, text)` | Insert at cursor position |
| `deleteText(secIdx, paraIdx, charOffset, count)` | Delete a range of chars |
| `replaceText(secIdx, paraIdx, charOffset, length, newText)` | Atomic swap |
| `replaceOne(query, newText, caseSensitive)` | Find first occurrence, replace |
| `replaceAll(query, newText, caseSensitive)` | Find all, replace |
| `deleteRange(secIdx, startPara, startOffset, endPara, endOffset)` | Multi-paragraph delete |
| `insertParagraph(secIdx, paraIdx)` | Inserts an empty paragraph BEFORE index |
| `deleteParagraph(secIdx, paraIdx)` | |
| `insertPageBreak(secIdx, paraIdx, charOffset)` | |
| `insertColumnBreak(secIdx, paraIdx, charOffset)` | |

**Return values** of edit methods are typically a JSON string like `{"ok":true,"paraIdx":N,"charOffset":M}`. Parse with `JSON.parse()` to follow the cursor. On failure: `{"ok":false,"error":"..."}`.

```js
const result = JSON.parse(doc.insertText(0, 0, 0, '제목'));
if (!result.ok) throw new Error(`insertText failed: ${result.error}`);
```

---

## Editing — tables

### Create a table

```ts
doc.createTable(secIdx, paraIdx, charOffset, rowCount, colCount): string
doc.createTableEx(optionsJson: string): string   // for advanced config
```

```js
// 3x4 table, anchored at the start of paragraph 0
doc.createTable(0, 0, 0, 3, 4);
```

The table is inserted as an inline control inside the run sequence at the given position.

### Add / remove rows and columns

```ts
doc.insertTableRow(secIdx, parentParaIdx, controlIdx, rowIdx, below: boolean): string
doc.insertTableColumn(secIdx, parentParaIdx, controlIdx, colIdx, right: boolean): string
doc.deleteTableRow(secIdx, parentParaIdx, controlIdx, rowIdx): string
doc.deleteTableColumn(secIdx, parentParaIdx, controlIdx, colIdx): string
doc.deleteTableControl(secIdx, parentParaIdx, controlIdx): string   // delete entire table
```

### Cell text

```ts
doc.insertTextInCell(secIdx, parentParaIdx, controlIdx, cellIdx, cellParaIdx, charOffset, text): string
doc.deleteTextInCell(secIdx, parentParaIdx, controlIdx, cellIdx, cellParaIdx, charOffset, count): string
```

`cellIdx` is row-major: row 0 col 0 → cellIdx=0, row 0 col 1 → cellIdx=1, ..., row 1 col 0 → cellIdx=colCount.

```js
// Fill a 3x4 table with row headers
const colCount = 4;
const headers = ['항목', '단가', '수량', '합계'];
for (let c = 0; c < colCount; c++) {
  doc.insertTextInCell(0, 0, /*tbl ctrl*/ 0, /*cell*/ c, /*paraInCell*/ 0, /*offset*/ 0, headers[c]);
}
```

### Formula

```ts
doc.evaluateTableFormula(secIdx, parentParaIdx, controlIdx, targetRow, targetCol, formula, writeResult): string
```

Hangul Office spreadsheet-like formulas: `=SUM(A1:A3)`, `=AVERAGE(B1:B5)`, etc.

---

## Pictures

```ts
doc.insertPicture(
  secIdx, paraIdx, charOffset,
  imageData: Uint8Array,            // raw PNG / JPEG / BMP bytes
  widthHU: number,                  // display width in HWP units
  heightHU: number,                 // display height in HWP units
  naturalWidthPx: number, naturalHeightPx: number,
  extension: string,                // 'png' / 'jpg' / 'bmp'
  description: string               // alt text
): string
```

HWP unit (HU) ≈ 1/7200 of an inch. Common conversions: 1 mm ≈ 283 HU, 1 cm ≈ 2835 HU.

```js
const png = fs.readFileSync('chart.png');
doc.insertPicture(0, 5, 0, new Uint8Array(png), 8500, 6000, 800, 565, 'png', 'Quarterly chart');
```

For reading embedded images:

```ts
doc.getControlImageData(secIdx, paraIdx, controlIdx): Uint8Array
doc.getControlImageMime(secIdx, paraIdx, controlIdx): string   // e.g. 'image/png'
```

---

## Styles and formatting

### Fonts

```ts
doc.findOrCreateFontId(name: string): number
doc.findOrCreateFontIdForLang(lang: number, name: string): number   // lang: 0=HANGUL, 1=LATIN, 2=HANJA, 3=JAPANESE, 4=OTHER, 5=SYMBOL, 6=USER
```

Idempotent — returns existing ID if the font is already registered.

### Apply character formatting (run-level)

```ts
doc.applyCharFormat(secIdx, paraIdx, startOffset, endOffset, propsJson: string): string
```

`propsJson` shape (subset):

```json
{
  "fontId": 3,
  "size": 1100,
  "bold": true,
  "italic": false,
  "underline": "SINGLE",
  "color": "#0F172A",
  "shadeColor": null
}
```

Sizes are in HU/100 — e.g. `1100` = 11pt × 100. Color is hex string with leading `#`.

### Apply paragraph formatting

```ts
doc.applyParaFormat(secIdx, paraIdx, propsJson: string): string
```

`propsJson` covers indentation, alignment, line spacing, tab stops, etc. See the rhwp source for the exact schema; common fields:

```json
{
  "align": "CENTER",        // LEFT | CENTER | RIGHT | JUSTIFY | DISTRIBUTE
  "lineSpacing": { "type": "PERCENT", "value": 160 },
  "indentLeft": 0,
  "indentRight": 0,
  "indentFirst": 0
}
```

### Named styles

```ts
doc.createStyle(json: string): number   // returns style ID
doc.applyStyle(secIdx, paraIdx, styleId): string
doc.deleteStyle(styleId): boolean
```

Use named styles when you'll apply the same combo of paragraph + character props to many paragraphs. Otherwise inline `applyCharFormat` / `applyParaFormat` is fine.

---

## Standalone helpers

### `extractThumbnail(data: Uint8Array): Uint8Array`

Returns the embedded PNG preview from the doc bytes, without constructing a `HwpDocument`. Fast — useful for file picker thumbnails.

```js
const thumb = rhwp.extractThumbnail(new Uint8Array(fs.readFileSync('big.hwp')));
fs.writeFileSync('thumb.png', thumb);
```

### `version(): string`

Returns the rhwp library version. Useful in error reports.

---

## Common pitfalls

- **Edit method return values are JSON strings**, not booleans. `JSON.parse()` and check `.ok`. Failures are silent without parsing.
- **`free()` is mandatory in long-running processes**. wasm-bindgen has a finalizer but Node's GC may not run before the script exits, leaking WASM memory across calls. Always wrap in try/finally.
- **`paraPrIDRef` / `charPrIDRef` / `styleIDRef` are integers**, not strings. They reference the doc's internal style table populated by `findOrCreateFontId` / `createStyle`. Inventing arbitrary integers will silently corrupt the doc.
- **Inserting a paragraph then text** — `insertParagraph(sec, idx)` inserts BEFORE `idx`. To append at end: `insertParagraph(sec, getParagraphCount(sec))`. Then `insertText(sec, newParaIdx, 0, "text")`.
- **HU-vs-px confusion in `insertPicture`** — the first two size args are HWP units (display size), the second two are pixels (natural / source size). Mixing them gives huge or tiny images.
- **HWP 5.0 round-trip is lossy.** Prefer `exportHwpx()`. Round-tripping `.hwp → .hwpx → .hwp` may lose minor formatting (footnote spacing, complex shapes).
- **Font fallback warnings** — if a `fontId` references a font name not on the rendering machine (e.g., `함초롬바탕`), the renderer falls back to the system default. The serialized HWPX still contains the original `fontId` reference. To suppress fallback warnings programmatically, call `doc.setFallbackFont(path)` with a known-installed font path.

---

## End-to-end: create a new HWPX with title + paragraph + table

```js
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const wasmBytes = fs.readFileSync(path.join(__dirname, 'vendor', 'rhwp', 'rhwp_bg.wasm'));
const rhwp = await import('./vendor/rhwp/rhwp.js');
await rhwp.default({ module_or_path: wasmBytes });

const doc = rhwp.HwpDocument.createEmpty();
try {
  // 1) title at paragraph 0
  doc.insertText(0, 0, 0, '2026년 4월 보고서');
  doc.applyCharFormat(0, 0, 0, '2026년 4월 보고서'.length, JSON.stringify({
    fontId: doc.findOrCreateFontId('함초롬바탕'),
    size: 2000,   // 20pt × 100
    bold: true,
  }));
  doc.applyParaFormat(0, 0, JSON.stringify({ align: 'CENTER' }));

  // 2) body paragraph
  doc.insertParagraph(0, 1);  // empty paragraph at index 1
  doc.insertText(0, 1, 0, '아래 표는 4월 매출 요약입니다.');

  // 3) 3x4 table after the body paragraph
  doc.insertParagraph(0, 2);
  doc.createTable(0, 2, 0, 3, 4);

  // table is now an inline control inside paragraph 2 — fill the header row
  const headers = ['항목', '단가', '수량', '합계'];
  for (let c = 0; c < 4; c++) {
    doc.insertTextInCell(0, 2, 0, c, 0, 0, headers[c]);
  }

  // 4) export
  fs.writeFileSync('output.hwpx', doc.exportHwpx());
} finally {
  doc.free();
}
```

This pattern — `createEmpty` → mutate via insert/apply methods → `exportHwpx` → `free` — is the canonical scaffold for `create.js`. Note that `create.js` itself should align with MyAgent's existing HWP creation tool (see project notes); the example above is the rhwp-side primitive set, not a finished implementation.
