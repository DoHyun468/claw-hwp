// preview-viewer.js — Canvas-based HWP/HWPX viewer for the Claude Code
// preview pane. Direct vanilla-JS port of MyAgent-frontend's HwpViewer.tsx
// render path. The class names and identifiers below are kept close to the
// React source so cross-comparison stays trivial.
//
// Key points from MyAgent's tsx that you MUST preserve when editing:
//   - Set globalThis.measureTextWidth via a hidden <canvas> 2d context
//     BEFORE initialising rhwp WASM. rhwp calls it during text layout.
//   - Cap canvas pixel area at MAX_CANVAS_PIXELS so very large pages don't
//     blow GPU memory.
//   - In the render loop, run the full geometry sweep first
//     (getPageInfo for every page), THEN the render loop. Doing them
//     interleaved on the same doc handle leaks rhwp's internal borrow.
//   - Each page's <canvas> is position:absolute inside a position:relative
//     wrap sized in NATIVE page pixels. fit() updates only CSS width/height
//     to scale the canvas pixel buffer down to the container — no
//     re-rasterisation on resize.
//   - Call doc.getPageTextLayout(i) AFTER each renderPageToCanvas. It's
//     the side-effect that releases rhwp's per-page borrow; without it the
//     next render panics "attempted to take ownership of Rust value while
//     it was borrowed". We discard the payload — v0.10 doesn't surface a
//     selectable text layer.

// ── 1. measureTextWidth (must register BEFORE rhwp init) ──────────────────
{
  let ctx = null;
  let lastFont = "";
  globalThis.measureTextWidth = (font, text) => {
    if (!ctx) ctx = document.createElement("canvas").getContext("2d");
    if (font !== lastFont) { ctx.font = font; lastFont = font; }
    return ctx.measureText(text).width;
  };
}

// ── 2. rhwp WASM ──────────────────────────────────────────────────────────
const rhwp = await import("/vendor/rhwp/rhwp.js");
await rhwp.default({ module_or_path: "/vendor/rhwp/rhwp_bg.wasm" });

// ── 3. DOM lookups ────────────────────────────────────────────────────────
const els = {
  filename: document.getElementById("filename"),
  autofix: document.getElementById("autofix"),
  download: document.getElementById("download"),
  pagenav: document.getElementById("pagenav"),
  pagePrev: document.getElementById("page-prev"),
  pageNext: document.getElementById("page-next"),
  pageInput: document.getElementById("page-input"),
  pageTotal: document.getElementById("page-total"),
  container: document.getElementById("pages-container"),
  status: document.getElementById("status"),
};

// ── 4. State ──────────────────────────────────────────────────────────────
const state = {
  fileBytes: null,
  filename: "",
  filePath: "",
  // Auto-correction defaults to ON — for the vast majority of agent-emitted
  // and Hancom-saved hwp files, reflowLinesegs() produces the visually
  // expected output. The toolbar toggle still flips it for raw inspection.
  autoFix: true,
  pageCount: 0,
  currentPage: 1,
};

// ── 5. UI helpers ─────────────────────────────────────────────────────────
function syncAutofixButton() {
  const on = state.autoFix === true;
  els.autofix.textContent = `자동 보정 ${on ? "ON" : "OFF"}`;
  els.autofix.classList.toggle("on", on);
}
syncAutofixButton();

function setStatus(text, kind = "info") {
  els.status.textContent = text;
  els.status.className = `status${kind === "error" ? " error" : ""}`;
  els.status.style.display = "block";
}
function clearStatus() { els.status.style.display = "none"; }

function syncPageNav() {
  if (state.pageCount <= 0) {
    els.pagenav.hidden = true;
    return;
  }
  els.pagenav.hidden = false;
  els.pageInput.max = String(state.pageCount);
  els.pageInput.value = String(state.currentPage);
  els.pageTotal.textContent = String(state.pageCount);
  els.pagePrev.disabled = state.currentPage <= 1;
  els.pageNext.disabled = state.currentPage >= state.pageCount;
}

function scrollToPage(n) {
  const idx = Math.max(1, Math.min(state.pageCount, n));
  const wrap = els.container.querySelector(`.hwp-page[data-page-num="${idx}"]`);
  if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  state.currentPage = idx;
  syncPageNav();
}

// ── 6. Layout helpers (copied directly from MyAgent HwpViewer.tsx) ────────
const MAX_CANVAS_PIXELS = 67_108_864; // ≈ 8192 × 8192
function pickEffectiveDpr(pageW, pageH, zoom, rawDpr) {
  const phys = pageW * zoom * rawDpr * pageH * zoom * rawDpr;
  if (phys <= MAX_CANVAS_PIXELS) return rawDpr;
  const limited = Math.sqrt(MAX_CANVAS_PIXELS / (pageW * zoom * pageH * zoom));
  return Math.max(1, Math.floor(limited));
}

function fit() {
  const wraps = els.container.querySelectorAll(".hwp-page");
  if (wraps.length === 0) return;
  const avail = Math.max(280, Math.min(1100, els.container.clientWidth - 32));
  wraps.forEach((wrap) => {
    const canvas = wrap.querySelector("canvas");
    if (!canvas) return;
    const pageW = parseFloat(canvas.dataset.pageWidth || "0");
    const pageH = parseFloat(canvas.dataset.pageHeight || "0");
    if (pageW <= 0 || pageH <= 0) return;
    const ratio = avail / pageW;
    const scaledH = pageH * ratio;
    wrap.style.width = `${avail}px`;
    wrap.style.height = `${scaledH}px`;
    canvas.style.width = `${avail}px`;
    canvas.style.height = `${scaledH}px`;
  });
}

const ro = new ResizeObserver(() => fit());
ro.observe(els.container);

const pageObserver = new IntersectionObserver(
  (entries) => {
    let bestIdx = state.currentPage;
    let bestRatio = 0;
    entries.forEach((e) => {
      if (e.intersectionRatio > bestRatio) {
        bestRatio = e.intersectionRatio;
        const num = Number(e.target.dataset.pageNum);
        if (Number.isFinite(num)) bestIdx = num;
      }
    });
    if (bestRatio > 0 && bestIdx !== state.currentPage) {
      state.currentPage = bestIdx;
      syncPageNav();
    }
  },
  { root: els.container, threshold: [0.1, 0.5, 0.9] },
);

// ── 7. Render pipeline ────────────────────────────────────────────────────
async function loadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const p = params.get("path");
  if (!p) {
    setStatus("미리보기할 파일 경로가 지정되지 않았습니다 (?path=).", "error");
    return;
  }
  setStatus("파일 불러오는 중…");
  try {
    const res = await fetch(`/file?path=${encodeURIComponent(p)}`);
    if (!res.ok) throw new Error(`서버 응답 ${res.status}: ${await res.text()}`);
    state.fileBytes = new Uint8Array(await res.arrayBuffer());
    state.filePath = p;
    const headerName = res.headers.get("x-filename");
    state.filename = headerName
      ? (() => { try { return decodeURIComponent(headerName); } catch { return headerName; } })()
      : (p.split("/").pop() || "untitled");
    els.filename.textContent = state.filename;
    els.download.href = `/file?path=${encodeURIComponent(p)}`;
    els.download.setAttribute("download", state.filename);
    await render();
  } catch (err) {
    setStatus(`불러오기 실패: ${err.message}`, "error");
  }
}

async function render() {
  if (!state.fileBytes) return;

  // Tear down previous canvases + observer attachments.
  els.container.querySelectorAll(".hwp-page").forEach((n) => {
    pageObserver.unobserve(n);
    n.remove();
  });

  let doc;
  try {
    doc = new rhwp.HwpDocument(state.fileBytes);
  } catch (err) {
    setStatus(`문서 파싱 실패: ${err.message}`, "error");
    return;
  }

  try {
    if (state.autoFix === true) {
      try { doc.reflowLinesegs(); }
      catch (err) { console.warn("[claw-hwp] reflowLinesegs failed:", err); }
    }

    state.pageCount = doc.pageCount();
    state.currentPage = Math.min(state.currentPage || 1, state.pageCount);
    syncPageNav();

    // Geometry first — every getPageInfo call before any renderPageToCanvas.
    const geoms = [];
    for (let i = 0; i < state.pageCount; i++) {
      try {
        const info = JSON.parse(doc.getPageInfo(i));
        geoms.push({ width: Number(info.width) || 0, height: Number(info.height) || 0 });
      } catch (err) {
        console.error(`[claw-hwp] getPageInfo(${i}) failed:`, err);
        geoms.push({ width: 0, height: 0 });
      }
    }

    const rawDpr = window.devicePixelRatio || 1;
    const zoom = 1;
    const frag = document.createDocumentFragment();
    const wraps = [];

    for (let i = 0; i < state.pageCount; i++) {
      const { width: pageW, height: pageH } = geoms[i];
      if (pageW <= 0 || pageH <= 0) continue;
      const dpr = pickEffectiveDpr(pageW, pageH, zoom, rawDpr);
      const renderScale = zoom * dpr;

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(pageW * renderScale);
      canvas.height = Math.round(pageH * renderScale);
      canvas.dataset.pageWidth = String(pageW);
      canvas.dataset.pageHeight = String(pageH);
      canvas.style.display = "block";
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = `${pageW}px`;
      canvas.style.height = `${pageH}px`;
      canvas.style.background = "#fff";

      try {
        doc.renderPageToCanvas(i, canvas, renderScale);
      } catch (err) {
        console.error(`[claw-hwp] renderPageToCanvas(${i}) failed:`, err);
        continue;
      }

      // Always call getPageTextLayout (and discard) — without it rhwp keeps
      // its internal borrow on the doc and the next render panics.
      try { JSON.parse(doc.getPageTextLayout(i)); } catch {}

      const wrap = document.createElement("div");
      wrap.className = "hwp-page";
      wrap.dataset.pageNum = String(i + 1);
      wrap.style.position = "relative";
      wrap.style.background = "#fff";
      wrap.style.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.45)";
      wrap.style.width = `${pageW}px`;
      wrap.style.height = `${pageH}px`;
      wrap.appendChild(canvas);
      frag.appendChild(wrap);
      wraps.push(wrap);
    }

    els.container.appendChild(frag);
    wraps.forEach((wrap) => pageObserver.observe(wrap));
    requestAnimationFrame(() => fit());
    clearStatus();
  } finally {
    if (typeof doc.free === "function") doc.free();
  }
}

// ── 8. Event wiring ───────────────────────────────────────────────────────
els.autofix.addEventListener("click", () => {
  state.autoFix = !state.autoFix;
  syncAutofixButton();
  render();
});

els.pagePrev.addEventListener("click", () => scrollToPage(state.currentPage - 1));
els.pageNext.addEventListener("click", () => scrollToPage(state.currentPage + 1));
els.pageInput.addEventListener("change", () => {
  const v = Number(els.pageInput.value);
  if (Number.isFinite(v)) scrollToPage(v);
});
els.pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = Number(els.pageInput.value);
    if (Number.isFinite(v)) scrollToPage(v);
  }
});

// ── 9. Heartbeat ──────────────────────────────────────────────────────────
// While this tab is open, ping the server so it knows we're alive. When the
// tab closes the pings stop, the server's idle timer fires, and the process
// self-kills — sparing the user from having to remember to stop it.
setInterval(() => {
  fetch("/__heartbeat", { method: "GET", cache: "no-store" }).catch(() => {});
}, 30_000);

loadFromUrl();
