// cell-inspect.js — Read .hwp table structure + cell text via rhwp WASM.
//
// `describeTable` and `enumerateTables` were moved here verbatim from
// create.js (logic unchanged) so that every consumer shares ONE table-cell
// read mechanism:
//   - create.js   — set_cell_text / set_cell_text_by_label cell sweep (write)
//   - extract_text.js — --inspect --with-cell-text cell-text dump (read)
// Keeping the sweep in a single place is deliberate: if the dump read a cell
// differently than the writer addresses it, edits would silently target the
// wrong cell. Read and write must walk tables identically.
//
// All functions take an already-constructed rhwp `HwpDocument`. Loading the
// WASM and installing the `globalThis.measureTextWidth` layout stub (required
// before `new HwpDocument(...)`) is the caller's responsibility.

// Walk a table's cells via getCellInfo until rhwp errors (= past last cell).
// Returns { rowCount, colCount, cells: [{idx,row,col,rowSpan,colSpan,text}],
//           indexByRowCol(r,c) } or null if the control isn't a table.
export function describeTable(doc, sec, para, ctrl) {
  const cells = [];
  let rowCount = 0, colCount = 0;
  for (let i = 0; i < 10000; i++) {
    let info;
    try {
      info = JSON.parse(doc.getCellInfo(sec, para, ctrl, i));
    } catch {
      break;
    }
    if (!info || typeof info.row !== "number") break;
    let text = "";
    try { text = doc.getTextInCell(sec, para, ctrl, i, 0, 0, 100000); } catch {}
    cells.push({
      idx: i,
      row: info.row,
      col: info.col,
      rowSpan: info.rowSpan ?? 1,
      colSpan: info.colSpan ?? 1,
      text,
    });
    rowCount = Math.max(rowCount, info.row + (info.rowSpan ?? 1));
    colCount = Math.max(colCount, info.col + (info.colSpan ?? 1));
  }
  if (cells.length === 0) return null;
  const byRowCol = new Map();
  for (const c of cells) byRowCol.set(`${c.row},${c.col}`, c.idx);
  return {
    rowCount,
    colCount,
    cells,
    indexByRowCol(r, c) {
      return byRowCol.get(`${r},${c}`);
    },
  };
}

// Walk every paragraph in every section, asking rhwp for table cells at
// each (sec, para, ctrl) tuple. Returns [{sec, para, ctrl}] for every
// table control encountered.
//
// Why we don't break on the first failing control index: a paragraph can
// hold non-table controls (textboxes, pictures, fields) interleaved with
// tables — government forms in particular use cover paragraphs that pack
// a logo (ctrl 0), a checkbox (ctrl 1), a textbox (ctrl 2), and only
// THEN the actual table (ctrl 3). rhwp errors "지정된 컨트롤이 표가
// 아닙니다" for those non-table indices, which is a "skip" signal, not a
// "no more controls" signal. We keep scanning up to MAX_CONTROL_IDX —
// well past anything seen in real forms — and only stop on a different
// error class. The cost is ~64 cheap wasm calls per paragraph, negligible.
export const MAX_CONTROL_IDX = 64;
export function enumerateTables(doc) {
  const out = [];
  const sectionCount = (() => {
    try { return doc.getSectionCount(); } catch { return 1; }
  })();
  for (let sec = 0; sec < sectionCount; sec++) {
    const paraCount = (() => {
      try { return doc.getParagraphCount(sec); } catch { return 0; }
    })();
    for (let p = 0; p < paraCount; p++) {
      for (let c = 0; c < MAX_CONTROL_IDX; c++) {
        let info;
        try { info = JSON.parse(doc.getCellInfo(sec, p, c, 0)); } catch { continue; }
        if (!info || typeof info.row !== "number") continue;
        out.push({ sec, para: p, ctrl: c });
      }
    }
  }
  return out;
}

// Convenience for the cell-text dump path: enumerate every table in the doc
// and read all of its cells. Returns
//   [{ sec, para, ctrl, rowCount, colCount,
//      cells: [{idx,row,col,rowSpan,colSpan,text}] }]
// in deterministic document order (section ASC, paragraph ASC, control ASC —
// the enumerateTables sweep order). The caller must have constructed `doc`
// with the measureTextWidth layout stub already installed.
export function dumpTables(doc) {
  const tables = [];
  for (const { sec, para, ctrl } of enumerateTables(doc)) {
    const grid = describeTable(doc, sec, para, ctrl);
    if (!grid) continue;
    tables.push({
      sec,
      para,
      ctrl,
      rowCount: grid.rowCount,
      colCount: grid.colCount,
      cells: grid.cells,
    });
  }
  return tables;
}
