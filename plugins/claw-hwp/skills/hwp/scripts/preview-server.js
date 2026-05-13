#!/usr/bin/env node
// preview-server.js — Tiny static + file-passthrough HTTP server that backs
// the Claude Code preview pane for HWP / HWPX files. All HWP parsing and
// rendering happens in the browser via the vendored rhwp WASM; this server
// only ships static assets and (on demand) the user's HWP bytes by absolute
// path.
//
// Wired to Claude's preview pane via .claude/launch.json — see SKILL.md.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PORT = Number(process.env.CLAW_HWP_PREVIEW_PORT || 3737);
const HOST = process.env.CLAW_HWP_PREVIEW_HOST || "127.0.0.1";

// Auto-shutdown: the viewer pings /__heartbeat every 30s while open. If no
// heartbeat (or any other request) arrives for IDLE_TIMEOUT_MS, the server
// kills itself. MIN_LIFETIME_MS keeps it alive long enough for the user to
// notice the chat link and click it even if no client ever connects.
const IDLE_TIMEOUT_MS = Number(process.env.CLAW_HWP_PREVIEW_IDLE_MS || 120_000);
const MIN_LIFETIME_MS = Number(process.env.CLAW_HWP_PREVIEW_MIN_LIFETIME_MS || 180_000);
const startTime = Date.now();
let lastActivity = startTime;
const touch = () => { lastActivity = Date.now(); };

// Files we know how to serve from the script directory. Anything outside
// this list is rejected so the server can't be used as a generic file
// browser even though it accepts absolute paths on /file (those go through
// a separate, narrower check).
const STATIC_ROUTES = {
  "/": ["preview-viewer.html", "text/html; charset=utf-8"],
  "/preview-viewer.js": ["preview-viewer.js", "application/javascript; charset=utf-8"],
  "/vendor/rhwp/rhwp.js": ["vendor/rhwp/rhwp.js", "application/javascript; charset=utf-8"],
  "/vendor/rhwp/rhwp_bg.wasm": ["vendor/rhwp/rhwp_bg.wasm", "application/wasm"],
};

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

const ALLOWED_EXT = new Set([".hwp", ".hwpx"]);

const server = createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    return send(res, 400, "text/plain", "bad URL");
  }

  touch();

  // Liveness ping from the viewer — also resets the idle timer via touch()
  // above. Kept lightweight so a tab can fire it on a tight interval without
  // showing up in DevTools network noise too much.
  if (parsed.pathname === "/__heartbeat") {
    return send(res, 204, "text/plain", "");
  }

  // Explicit shutdown for ❌-style kill buttons or agent commands. Writes
  // the response first, then exits on the next tick so the client sees the
  // 204 before the socket closes.
  if (parsed.pathname === "/__shutdown" && req.method === "POST") {
    send(res, 204, "text/plain", "");
    setTimeout(() => process.exit(0), 50);
    return;
  }

  // Static assets — viewer page, vendored WASM/JS.
  const route = STATIC_ROUTES[parsed.pathname];
  if (route) {
    const [file, ct] = route;
    try {
      const data = await readFile(path.join(__dirname, file));
      return send(res, 200, ct, data);
    } catch (err) {
      return send(res, 500, "text/plain", `failed to read ${file}: ${err.message}`);
    }
  }

  // /file?path=<absolute path to .hwp / .hwpx>
  if (parsed.pathname === "/file") {
    const p = parsed.searchParams.get("path");
    if (!p) return send(res, 400, "text/plain", "missing ?path=");
    const abs = path.resolve(p);
    if (!existsSync(abs)) return send(res, 404, "text/plain", `not found: ${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (!ALLOWED_EXT.has(ext))
      return send(res, 415, "text/plain", `unsupported extension: ${ext}`);
    try {
      const stat = statSync(abs);
      const data = await readFile(abs);
      // x-filename must be ASCII (RFC 7230); percent-encode so Korean
      // filenames survive the round-trip. Client decodes via decodeURIComponent.
      return send(res, 200, "application/octet-stream", data, {
        "content-length": String(stat.size),
        "x-filename": encodeURIComponent(path.basename(abs)),
      });
    } catch (err) {
      return send(res, 500, "text/plain", `failed to read file: ${err.message}`);
    }
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`claw-hwp preview server listening on http://${HOST}:${PORT}\n`);
});

setInterval(() => {
  const now = Date.now();
  if (now - startTime < MIN_LIFETIME_MS) return;
  if (now - lastActivity > IDLE_TIMEOUT_MS) {
    process.stderr.write(
      `claw-hwp preview server: idle for ${Math.round((now - lastActivity) / 1000)}s, shutting down\n`,
    );
    process.exit(0);
  }
}, 30_000).unref();
