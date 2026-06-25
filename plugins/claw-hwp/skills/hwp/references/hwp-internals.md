# `.hwp` raw-patch internals (developer reference)

> Byte/record-level mechanics behind the `.hwp` in-place ops (`create.js` →
> `cell-patch.js`). **Not needed to USE the ops** — `SKILL.md` documents the
> agent-facing behaviour and constraints. This file is for developers debugging or
> extending the raw-patch path. Moved out of SKILL.md (2026-06-25) to keep the
> agent-facing skill free of internal byte detail.

## Prop-name aliases (apply_text_style / apply_paragraph_style)

The ops accept friendly names and map them to the serializer's internal prop names:
`color` → `textColor`, `size` (pt) → `fontSize` (HWP units), `highlight` → `shadeColor`,
`font_family` → `fontFamilies[7]` (broadcast across all 7 language scripts),
`letter_spacing` → `spacings[7]`, `char_ratio` → `ratios[7]`. Highlight is the
non-obvious one — it is NOT called `highlight`/`background`/`charBgColor` internally.

## apply_text_style — in-place CharShape path (large files)

`applyTextStyleInPlace`: appends a new `CHAR_SHAPE` to DocInfo, bumps the matching
`HWPTAG_ID_MAPPINGS` count, splices the target range into the paragraph's
`PARA_CHAR_SHAPE` entries, and bumps the paragraph header's `num_char_shapes`. For
highlight it also inserts a `PARA_RANGE_TAG` (tag = `(0x02<<24)|BGR`) and bumps
`range_tags_count`. Font: registers the name in DocInfo's `FACE_NAME` table (appended
to all 7 language slots, per-slot `HWPTAG_ID_MAPPINGS` counts bumped) and writes the
7 resolved face-ids into the new `CHAR_SHAPE`. No whitelist — any name is registered;
whether it *renders* depends on the viewer's installed fonts.

## apply_paragraph_style — in-place ParaShape path (large files)

`applyParagraphStyleInPlace`: clones the target paragraph's `PARA_SHAPE`, overlays the
style props (align/indent/margins/line-spacing/spacing), dedupes against existing
entries or appends a new one to DocInfo, bumps the `HWPTAG_ID_MAPPINGS` PARA_SHAPE
count, and rewrites the paragraph header's `paraShapeId`. For `background_color` it
appends a solid-fill `HWPTAG_BORDER_FILL` and sets `ParaShape.border_fill_id` to its
**1-based** ID (HWP BorderFill refs are 1-based, 0 = "no fill").

## set_cell_text — empty-cell / inline-object / nesting mechanics

- **`text:""` clear**: writes Hancom's native empty paragraph (`PARA_HEADER` +
  `CHAR_SHAPE`, **no `PARA_TEXT`**, single `LINE_SEG`). A naive EOP-only `PARA_TEXT`
  makes Hancom Docs reject the file — always clear via the op.
- **inline object**: a paragraph whose anchor char hosts an embedded 그림 is refused;
  `clear_objects:true` drops the anchor char + the whole gso record cluster. The
  image's `BinData` stream is left orphaned (overwrite separately if sensitive).
- **nesting levels**: top-level cell text = PARA_TEXT level 3; a table nested in a
  cell puts its CTRL_HEADER at level 3, its cells (LIST_HEADER) at level 4, that
  cell's text at level 5 — +2 per nesting. `nested:[{control,cell}]` descends one
  step each; `locateCell` tracks `cellLevel` so the cell/para loops generalise.

## delete_object — empty-para + BinData renumber + thumbnail

- The gso paragraph is replaced **in place with an empty paragraph** (Hancom-shaped:
  `PARA_HEADER` + `CHAR_SHAPE`, no `PARA_TEXT`/`LINE_SEG`). Its `nchars` high bit
  `0x80000000` (section last-paragraph marker) is set **only** when the empty para is
  now the last one — setting it on a middle para makes Hancom read a ~2-billion char
  count and stop rendering everything after (clearing it on the last makes Hancom
  reject the file).
- image/chart: removes the `BinData` stream (bytes zeroed + chain freed) and the
  `HWPTAG_BIN_DATA` def, then **renumbers every higher storage id down by 1** (BIN_DATA
  defs + ID_MAPPINGS count + each remaining gso's `binDataID`; each higher `BIN000N`
  stream is **renamed** to close the gap, keeping its bytes/extension/sector-class —
  rotating slot pointers instead breaks Hancom across the mini↔regular boundary).
  Hancom resolves a `binDataID` by position, so a gap renders the *higher* objects as
  broken-image boxes; renumbering keeps them intact. Last/only binary → the empty
  `BinData` folder is removed.
- redaction: the page-1 thumbnail (`PrvImage`) is invalidated (zeroed + emptied) so a
  deleted page-1 object can't linger; Hancom regenerates it on open.
- Multiple deletes are sorted descending so an earlier delete never shifts a later
  target.

## Background-color leak between paragraphs (from-scratch path)

The leak comes from `splitParagraph` copying paragraph N's paraShape (incl. its
BorderFill ref) into N+1. The alternative — explicitly resetting fill on every
paragraph — produces visible 1px stripes (rhwp's auto-generated default BorderFill has
`borderTop/Bottom/Left = type:1 width:0`, which Hancom Docs renders as thin lines). So
the workaround (SKILL) is to reset the next paragraph's `background_color` explicitly,
or apply `background_color` last in the build.
