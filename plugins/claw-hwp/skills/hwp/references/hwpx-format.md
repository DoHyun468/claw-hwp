# HWPX format reference

Reference for editing `.hwpx` files by hand after `unpack.py`. This document is loaded into Claude's context when the user asks for edits — read it first before touching XML.

> **Status**: v0.1 skeleton. Covers file layout, namespaces, the three most common edit patterns (text replace, paragraph add, table cell edit), and pitfalls. Style/font/header-footer details deferred to v0.2.

HWPX is the ZIP-based variant of Hangul Word Processor format, defined by KS X 6101 / OWPML. It is structurally analogous to `.docx` (OOXML) — same archetype: zip + XML + binary parts + OPF manifest.

---

## File layout

After `python scripts/unpack.py file.hwpx /tmp/u/`, the directory looks like:

```
/tmp/u/
├── mimetype                    # always exactly: application/hwp+zip
├── version.xml                 # OWPML version + authoring app metadata
├── settings.xml                # cursor position, print prefs (safe to leave alone)
├── META-INF/
│   ├── container.xml           # OCF root file pointers (Contents/content.hpf etc.)
│   ├── container.rdf           # RDF describing pkg parts
│   └── manifest.xml            # ODF-style manifest stub (often empty)
├── Contents/
│   ├── content.hpf             # OPF manifest — list of every file in the pkg
│   ├── header.xml              # styles, fonts, paragraph/char shapes, layout refs
│   ├── section0.xml            # first body section — paragraphs, tables, images
│   ├── section1.xml, ...       # additional body sections (rare; one per <hs:sec>)
├── BinData/
│   ├── image1.png, image2.bmp, ...   # embedded images
│   └── (OLE objects, charts when present)
├── Scripts/                    # OPTIONAL — only if document has macros
│   ├── headerScripts
│   └── sourceScripts
└── Preview/
    ├── PrvText.txt             # plain-text preview
    └── PrvImage.png            # thumbnail
```

**You will edit**: `Contents/section*.xml` (body content) and occasionally `Contents/header.xml` (when style/font changes are needed).
**You will rarely edit**: `Contents/content.hpf` (let `pack.py` regenerate the manifest if you add files).
**Do not edit**: `mimetype`, `version.xml`, `META-INF/*`, `Preview/*`. They will be left alone by `pack.py`.

---

## Namespaces

All HWPX XML files declare a verbose namespace block at the root. Memorize the prefix → meaning map:

| Prefix | Purpose | URI |
|--------|---------|-----|
| `hp` | Paragraph, run, text, table, image — body content | `http://www.hancom.co.kr/hwpml/2011/paragraph` |
| `hh` | Head — fonts, styles, paragraph/char shapes, refs | `http://www.hancom.co.kr/hwpml/2011/head` |
| `hs` | Section root | `http://www.hancom.co.kr/hwpml/2011/section` |
| `hc` | Core — image data, transforms, common types | `http://www.hancom.co.kr/hwpml/2011/core` |
| `ha` | App settings | `http://www.hancom.co.kr/hwpml/2011/app` |
| `hm` | Master page | `http://www.hancom.co.kr/hwpml/2011/master-page` |
| `hp10` | Paragraph extensions (2016 revision) | `http://www.hancom.co.kr/hwpml/2016/paragraph` |
| `hv` | Version | `http://www.hancom.co.kr/hwpml/2011/version` |
| `hpf` | HPF schema | `http://www.hancom.co.kr/schema/2011/hpf` |
| `opf` | OPF (used in `content.hpf`) | `http://www.idpf.org/2007/opf/` |
| `dc` | Dublin Core (used in `content.hpf` metadata) | `http://purl.org/dc/elements/1.1/` |
| `ocf` | OCF container (used in `META-INF/container.xml`) | `urn:oasis:names:tc:opendocument:xmlns:container` |
| `odf` | ODF manifest (used in `META-INF/manifest.xml`) | `urn:oasis:names:tc:opendocument:xmlns:manifest:1.0` |

**Rule**: never strip or rename namespace declarations. When inserting new elements, always use the existing prefix from the file (typically `hp:` for body content).

---

## Anatomy of `section*.xml`

### Root

```xml
<hs:sec xmlns:hp="..." xmlns:hh="..." ...>
  <hp:p ...> ... </hp:p>
  <hp:p ...> ... </hp:p>
  ...
</hs:sec>
```

A section is a flat sequence of paragraphs (`<hp:p>`). Tables, images, etc. are all *contained inside* paragraphs (specifically, inside `<hp:run>` elements within paragraphs).

### Paragraph

```xml
<hp:p id="0" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
  <hp:run charPrIDRef="2">
    <hp:t>안녕하세요</hp:t>
  </hp:run>
  <hp:linesegarray>
    <hp:lineseg textpos="0" vertpos="0" vertsize="1000" .../>
  </hp:linesegarray>
</hp:p>
```

| Attribute | Meaning |
|-----------|---------|
| `id` | Paragraph local ID (often "0" — not always unique) |
| `paraPrIDRef` | References a `<hh:paraPr>` in `header.xml` (paragraph shape: indent, alignment, line height) |
| `styleIDRef` | References a `<hh:style>` in `header.xml` (named style) |
| `pageBreak` / `columnBreak` / `merged` | Boolean flags ("0" or "1") |

### Run

A run is a span of text with uniform character formatting (font, size, color, bold, etc.).

```xml
<hp:run charPrIDRef="2">
  <hp:t>한글</hp:t>
</hp:run>
<hp:run charPrIDRef="5">
  <hp:t>과 영어 mixed</hp:t>
</hp:run>
```

| Attribute | Meaning |
|-----------|---------|
| `charPrIDRef` | References a `<hh:charPr>` in `header.xml` (character shape: font, size, color, weight) |

A run can also contain `<hp:ctrl>` (page-break, footnote markers), `<hp:tbl>` (table inline), `<hp:pic>` (image), `<hp:secPr>` (section properties — only in the first run of the first paragraph). For pure text edits you only need `<hp:t>`.

### Text element

```xml
<hp:t>실제 텍스트가 여기에 들어감</hp:t>
```

UTF-8 plain text. Korean characters are written directly — **never XML-encode them as entities**. Special chars (`&`, `<`, `>`) are XML-escaped normally (`&amp;` `&lt;` `&gt;`).

### `<hp:linesegarray>` — leave alone

```xml
<hp:linesegarray>
  <hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000"
              baseline="850" spacing="600" horzpos="0" horzsize="47833" flags="393216"/>
</hp:linesegarray>
```

This is **rendering cache** — line segment positions computed by Hangul Office. After your edit, the values will be wrong, but rhwp / Hangul will recompute them on next open. You can leave the existing `<hp:linesegarray>` in place; it will not corrupt the file. Do not try to recompute these manually.

When inserting a brand-new paragraph, copy the `<hp:linesegarray>` from a sibling paragraph as a placeholder.

---

## Anatomy of tables

```xml
<hp:tbl rowCnt="2" colCnt="3" cellSpacing="0" borderFillIDRef="3" ...>
  <hp:sz width="6590" height="1280" .../>
  <hp:pos .../>
  <hp:outMargin .../>
  <hp:inMargin .../>
  <hp:tr>
    <hp:tc name="" header="0" hasMargin="0" borderFillIDRef="7" ...>
      <hp:subList id="" textDirection="HORIZONTAL" vertAlign="CENTER" ...>
        <hp:p id="0" paraPrIDRef="4" styleIDRef="0" ...>
          <hp:run charPrIDRef="6">
            <hp:t>셀 안의 텍스트</hp:t>
          </hp:run>
          <hp:linesegarray>...</hp:linesegarray>
        </hp:p>
      </hp:subList>
      <hp:cellAddr colAddr="0" rowAddr="0"/>
      <hp:cellSpan colSpan="1" rowSpan="1"/>
      <hp:cellSz width="6590" height="280"/>
      <hp:cellMargin left="0" right="0" top="0" bottom="0"/>
    </hp:tc>
    <!-- more <hp:tc> per column -->
  </hp:tr>
  <!-- more <hp:tr> per row -->
</hp:tbl>
```

Note the nesting: cell content is `<hp:tc>` → `<hp:subList>` → `<hp:p>` → `<hp:run>` → `<hp:t>`. The `<hp:subList>` wrapper is mandatory inside cells (does not exist outside tables).

`<hp:tbl>` always lives **inside a `<hp:run>`** in a paragraph, not directly under `<hs:sec>`:

```xml
<hp:p ...>
  <hp:run charPrIDRef="...">
    <hp:tbl ...>...</hp:tbl>
  </hp:run>
</hp:p>
```

| Attribute | Meaning |
|-----------|---------|
| `rowCnt` / `colCnt` | Total rows / columns. **Must match actual `<hp:tr>` / `<hp:tc>` counts**. |
| `cellSpan` (on `hp:tc`) | colSpan/rowSpan for merged cells |
| `cellAddr` (on `hp:tc`) | `colAddr` / `rowAddr` — must be consistent within the table grid |

---

## Common edit patterns

### Pattern 1 — Replace text inside a paragraph

Find the `<hp:t>` element containing the target text and edit its content directly:

```xml
<!-- BEFORE -->
<hp:run charPrIDRef="2">
  <hp:t>2025년 보고서</hp:t>
</hp:run>
```

```xml
<!-- AFTER (using Edit tool) -->
<hp:run charPrIDRef="2">
  <hp:t>2026년 보고서</hp:t>
</hp:run>
```

Multiple `<hp:t>` elements may exist if the original spans formatting changes. To find one, search for a unique substring with `Grep`, then `Edit` that line.

### Pattern 2 — Add a new paragraph

Copy an existing paragraph as a template (preserves all the `paraPrIDRef`/`styleIDRef`/`charPrIDRef` references), edit the text, and insert it before/after a known paragraph.

```xml
<!-- BEFORE: insert after the "안내" paragraph -->
<hp:p id="0" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
  <hp:run charPrIDRef="2"><hp:t>안내</hp:t></hp:run>
  <hp:linesegarray>...</hp:linesegarray>
</hp:p>
```

```xml
<!-- AFTER -->
<hp:p id="0" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
  <hp:run charPrIDRef="2"><hp:t>안내</hp:t></hp:run>
  <hp:linesegarray>...</hp:linesegarray>
</hp:p>
<hp:p id="0" paraPrIDRef="2" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
  <hp:run charPrIDRef="2"><hp:t>아래 표를 참고하세요.</hp:t></hp:run>
  <hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="47833" flags="393216"/></hp:linesegarray>
</hp:p>
```

The `id="0"` collision is fine — IDs in `section*.xml` are not strictly unique. The `paraPrIDRef` / `charPrIDRef` MUST already exist in `header.xml` (you reused them from the sibling paragraph, so they do).

### Pattern 3 — Edit a table cell value

Locate the `<hp:tc>` by its `<hp:cellAddr colAddr="C" rowAddr="R">`, then edit the `<hp:t>` inside its `<hp:subList>`:

```xml
<!-- BEFORE: cell at row 0, col 1 -->
<hp:tc ...>
  <hp:subList ...>
    <hp:p ...>
      <hp:run charPrIDRef="6"><hp:t>2024</hp:t></hp:run>
      <hp:linesegarray>...</hp:linesegarray>
    </hp:p>
  </hp:subList>
  <hp:cellAddr colAddr="1" rowAddr="0"/>
  ...
</hp:tc>
```

```xml
<!-- AFTER -->
<hp:tc ...>
  <hp:subList ...>
    <hp:p ...>
      <hp:run charPrIDRef="6"><hp:t>2025</hp:t></hp:run>
      <hp:linesegarray>...</hp:linesegarray>
    </hp:p>
  </hp:subList>
  <hp:cellAddr colAddr="1" rowAddr="0"/>
  ...
</hp:tc>
```

For numeric tables filled programmatically, this is the simplest pattern: search by the existing value (or by `cellAddr`), edit the `<hp:t>` content.

To **add a row**: clone an existing `<hp:tr>` block, increment `cellAddr` `rowAddr` on each `<hp:tc>` inside the new row, and bump `rowCnt` on the parent `<hp:tbl>`. Same for adding a column (clone `<hp:tc>` per row, bump `colCnt`).

---

## Pitfalls

- **Never invent IDRef values.** `paraPrIDRef`, `charPrIDRef`, `styleIDRef`, `borderFillIDRef`, etc. must reference an existing item in `header.xml`'s `<hh:refList>`. When adding new content, copy the IDRef from a sibling element with similar formatting. To introduce a new style, you must also add the matching `<hh:paraPr>` / `<hh:charPr>` to `header.xml` — this is a v0.2 topic, deferred.
- **`rowCnt` / `colCnt` must match actual `<hp:tr>` / `<hp:tc>` counts.** When adding/removing rows or columns, update both. Hangul Office is forgiving on this; rhwp may not be.
- **`cellAddr` consistency in tables.** Every `<hp:tc>` has `colAddr` / `rowAddr`. After insertion/deletion, these must form a consistent grid (no gaps, no duplicates). For rectangular tables, addresses go (0,0), (0,1), ..., (0,colCnt-1), (1,0), ...
- **Don't edit `<hp:linesegarray>` values.** They are recomputed on render. Leave the existing array; if inserting new paragraphs, copy a sibling's `<hp:linesegarray>` as-is.
- **Encoding.** All HWPX XML is UTF-8. Korean text is written directly (`한글` not `&#54620;&#44544;`). XML escape only `&`, `<`, `>` (and `"` / `'` inside attribute values).
- **Whitespace in `<hp:t>`.** Leading/trailing spaces are preserved. If you need a newline within a paragraph, use a separate `<hp:lineBreak/>` element (not `\n` inside `<hp:t>`).
- **`content.hpf` manifest sync.** When you add a new image to `BinData/`, `pack.py` regenerates the manifest. When deleting an image, also remove its `<opf:item>` from `Contents/content.hpf` (or let `pack.py --rebuild-manifest` handle it).
- **Misnamed extension as binary.** If `unpack.py` reports "not a zip", the file is HWP 5.0 binary, not HWPX. Convert via `node scripts/convert.js file.hwp /tmp/file.hwpx` first.

---

## What this document does not cover (yet)

- `header.xml` schema — fonts, styles, paragraph/char shapes, layout refs (v0.2)
- Adding new fonts, paragraph shapes, character shapes (requires editing `header.xml`)
- Headers / footers / footnotes / endnotes
- Master pages, page numbering, columns, sections beyond the first
- Equations (`<hp:eqn>`), charts (`<ooxmlchart:...>`), drawing objects (`<hp:drawing>`)
- Tracked changes / revision history
- Forms / fields / hyperlinks
- OLE objects

For these, fall back to `node scripts/extract_text.js --inspect <file>` to reason about structure, or punt to a v0.2 release of this reference.
