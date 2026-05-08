// preview-viewer.js — Vanilla JS HWP/HWPX renderer for the Claude Code
// preview pane. Loads ?path=<abs path> from the URL, fetches the bytes
// via the local preview-server, parses with rhwp WASM, and renders each
// page to a <canvas> via doc.renderPageToCanvas().
//
// 자동 보정 (auto-fix) toggles rhwp's reflowLinesegs() — same effect as
// stripping PARA_LINESEG records server-side, but applied at read time.
//
// Intentionally minimal: no file picker, no header, no i18n. The viewer
// is opened only as a Claude Code preview-pane sub-page; entry points
// like file picking happen through the agent.

// rhwp WASM imports as default. The browser version has fetch built in,
// so init() with no args reads /vendor/rhwp/rhwp_bg.wasm relative to the
// rhwp.js URL — but our page lives at /, so we point at the explicit URL.
const rhwp = await import("/vendor/rhwp/rhwp.js");
await rhwp.default({ module_or_path: "/vendor/rhwp/rhwp_bg.wasm" });

const els = {
  filename: document.getElementById("filename"),
  pages: document.getElementById("pages"),
  autofix: document.getElementById("autofix"),
  container: document.getElementById("pages-container"),
  status: document.getElementById("status"),
  modal: document.getElementById("autofix-modal"),
  modalAccept: document.getElementById("autofix-accept"),
  modalDecline: document.getElementById("autofix-decline"),
};

// autoFix === null means we haven't asked the user yet for this file.
// First successful load flips the value to true / false via the modal,
// after which the toolbar button toggles freely without re-prompting.
const state = {
  fileBytes: null,
  filename: "",
  autoFix: null,
  asked: false,
};

function syncAutofixButton() {
  const on = state.autoFix === true;
  els.autofix.textContent = `자동 보정 ${on ? "ON" : "OFF"}`;
  els.autofix.classList.toggle("on", on);
}
syncAutofixButton();

function showModal() { els.modal.hidden = false; }
function hideModal() { els.modal.hidden = true; }
hideModal();

function setStatus(text, kind = "info") {
  els.status.textContent = text;
  els.status.className = `status${kind === "error" ? " error" : ""}`;
  els.status.style.display = "block";
}
function clearStatus() { els.status.style.display = "none"; }

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
    state.filename = res.headers.get("x-filename") || p.split("/").pop() || "untitled";
    els.filename.textContent = state.filename;
    await render();
  } catch (err) {
    setStatus(`불러오기 실패: ${err.message}`, "error");
  }
}

async function render() {
  if (!state.fileBytes) return;
  setStatus("렌더링 중…");

  // Tear down previous canvases.
  els.container.querySelectorAll(".page-wrap").forEach((n) => n.remove());

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

    const pageCount = doc.pageCount();
    els.pages.textContent = `${pageCount} 페이지`;

    // First load — we have a parsed doc, ask the user once whether to apply.
    // The doc is rendered in raw mode behind the modal until they answer;
    // accepting flips state.autoFix=true and re-renders.
    if (!state.asked && state.autoFix === null) {
      state.asked = true;
      showModal();
    }

    const dpr = window.devicePixelRatio || 1;
    const containerWidth = els.container.clientWidth - 48;  // padding
    const targetCssWidth = Math.min(900, containerWidth);

    for (let i = 0; i < pageCount; i++) {
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      els.container.appendChild(wrap);

      // rhwp paints into the canvas at (intrinsic size) × scale. We render
      // at dpr × an oversampling factor so the canvas stays sharp when CSS
      // scales it down to fit the container width. No zoom controls — the
      // viewer auto-fits and the user can rely on the OS / Claude Code
      // pane resize to scale the layout.
      doc.renderPageToCanvas(i, canvas, dpr);

      const cssW = targetCssWidth;
      const cssH = (canvas.height / canvas.width) * cssW;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    clearStatus();
  } finally {
    if (typeof doc.free === "function") doc.free();
  }
}

els.autofix.addEventListener("click", () => {
  state.autoFix = state.autoFix === true ? false : true;
  state.asked = true;
  syncAutofixButton();
  render();
});

els.modalAccept.addEventListener("click", () => {
  state.autoFix = true;
  hideModal();
  syncAutofixButton();
  render();
});
els.modalDecline.addEventListener("click", () => {
  state.autoFix = false;
  hideModal();
  syncAutofixButton();
});

loadFromUrl();
