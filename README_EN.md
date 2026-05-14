<h1 align="center">claw-hwp</h1>

<p align="center">
  HWP/HWPX skill for Claude — read, create, and edit Korean Hangul documents in Claude Code, Desktop, and web.<br/>
  Built on <a href="https://github.com/edwardkim/rhwp">rhwp</a> WASM.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

<p align="center">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

---

## What is this?

`claw-hwp` is an [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) that lets Claude work directly with Korean Hangul documents (`.hwp` / `.hwpx`). The Korean office ecosystem is effectively standardized on Hancom's `.hwp` / `.hwpx` formats, and Claude can't read or edit them out of the box. Install this skill and Claude can:

- **read** — extract text, tables, and metadata from `.hwp` / `.hwpx`
- **create** — write new documents (headings, paragraphs, tables, images, page breaks). For tables, output as `.hwp` — see [Known limitations](#known-limitations)
- **edit** — text replace, paragraph insert, formatting changes on existing documents — by unpacking the XML and using Claude's native `Edit` tool
- **convert** — `.hwp ↔ .hwpx` both directions via rhwp WASM. Not lossless — round-tripping can damage tables and images
- **preview** — view rhwp-rendered pages inline or in a browser (the path differs by surface — see [Usage by surface](#usage-by-surface))

Read / create / edit / convert work everywhere Claude has Bash and filesystem access — Claude Code CLI, Claude Code Desktop (Code mode), Claude Desktop cowork mode, and claude.ai cowork.

The preview surface coverage:

| Surface | Preview |
|---|---|
| Claude Code Desktop (Code mode) | Inline pane next to the chat |
| Claude Code CLI | Browser link to local `localhost:3737` (agent self-launches the server) |
| Claude Desktop cowork mode | Drag-drop the file onto <https://dohyun468.github.io/claw-hwp/> (no Node install) |
| claude.ai cowork (web) | Drag-drop the file onto <https://dohyun468.github.io/claw-hwp/> (no Node install) |

No Hancom Office, no LibreOffice, no Windows COM required.

## Known limitations

These come from rhwp's serializer. Worth knowing before you start.

- **Tables are dropped when emitting `.hwpx`.** Whether you create a new `.hwpx` via `create.js` or convert `.hwp → .hwpx`, rhwp's `exportHwpx()` strips tables. **If you need tables, write `.hwp` instead.** If you really need `.hwpx`, opening and re-saving the result in Hancom Office or 한컴독스 will regenerate the table XML.
- **Editing existing `.hwp` files can lose tables.** The `.hwp` edit path internally converts to `.hwpx` first, which trips the same serializer. **If you need to edit while preserving existing tables, start from a `.hwpx` source** — that path edits the XML directly and tables are preserved.
- **`.hwp ↔ .hwpx` round-tripping is lossy.** Tables, images, and complex shapes can be damaged. Keep `.hwpx` as the canonical format when possible; only emit `.hwp` when explicitly required.
- **PDF / DOCX conversion is not yet supported.** Planned for a later release via LibreOffice headless.

## Built on

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — the Rust + WebAssembly viewer/editor core that powers all parsing, rendering, and `.hwp` ↔ `.hwpx` conversion. Without rhwp this project doesn't exist.
- **[golbin/hop](https://github.com/golbin/hop)** — the open-source HWP desktop app that wraps rhwp. Reference for editor UX patterns.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic's official skill repository. The `docx`, `pptx`, `xlsx` skills are the structural blueprint we mirror.

## Korean HWP open-source ecosystem

claw-hwp is part of a broader open-source movement around Korea's HWP formats. Each project occupies a different niche, complementing the others:

| Project | Role | When to use |
|---|---|---|
| **[rhwp](https://github.com/edwardkim/rhwp)** | HWP parser/renderer core (Rust + WASM) | foundation that everything else builds on |
| **[hop](https://github.com/golbin/hop)** | HWP desktop viewer (Tauri) | opening .hwp files on macOS / Linux |
| **claw-hwp** | HWP skill for Claude/AI workflows | working on .hwp with AI — generate, summarize, edit |

`rhwp` makes the whole ecosystem possible. Pick `hop` for desktop GUI, `claw-hwp` for AI-driven workflows.

## Status

🚧 v1.0 submitted to Anthropic's official marketplace on 2026-05-14, pending review. Read / create / edit / convert / preview pipeline verified across all four surfaces.

## Roadmap

- [x] v0 — `SKILL.md` decision tree
- [x] v0.1 — `references/hwpx-format.md` (XML schema cheatsheet for Claude to edit by hand)
- [x] v0.2 — Node scripts (`extract_text.js`, `convert.js`)
- [x] v0.3 — Python scripts (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — End-to-end smoke tests against rhwp `samples/` fixtures (round-trip verified)
- [x] v0.5 — Claude Code plugin manifest + single-plugin marketplace
- [x] v0.6 — `references/rhwp-api.md` (curated `@rhwp/core` API reference)
- [x] v0.7 — `create.js` core ops (setup_document, append_{heading,paragraph,table,list,image}, replace_text, page/column breaks, load-then-append, extension-based `.hwp`/`.hwpx` dispatch)
- [x] v0.8 — Vendored Node deps — zero-config install across Code / Desktop / web
- [x] v0.9 — Plugin icon
- [x] v1.0 — Submitted to Anthropic's official marketplace (pending review)
- [ ] v1.1 — Footnotes (`append_paragraph_with_footnotes`) + Markdown→HWP citation styles (numeric_inline / footnote / footnote_with_bibliography)
- [ ] v1.2+ — PDF / DOCX conversion, image extraction, viewer/editor React packages

## Install

Pick the path that matches your environment. All three surfaces use the same skill files.

### New here? — just ask Claude (Claude Desktop, claude.ai web)

Easiest path: ask Claude to install it for you. Paste this one line into any Claude chat (Desktop app or claude.ai web):

```
https://github.com/DoHyun468/claw-hwp help me install this skill
```

Claude walks you through the steps based on your OS (Mac / Windows) and surface (app / web). You won't type a single command.

<details>
<summary>Prefer to install it by hand? (manual steps)</summary>

**1. Download the repo as a zip**

Open <https://github.com/DoHyun468/claw-hwp> → click the green **`Code`** button above the file list → **`Download ZIP`**. You'll get something like `claw-hwp-main.zip`.

**2. Re-zip just the skill folder**

Double-click the downloaded zip to expand it. Inside `claw-hwp-main`, drill into `plugins` → `claw-hwp` → `skills` → `hwp` (you should see `SKILL.md`, `scripts/`, `references/`).

Compress that `hwp` folder into its own zip:
- **Mac**: right-click the `hwp` folder → **Compress** → `hwp.zip`
- **Windows**: right-click the `hwp` folder → **Send to → Compressed (zipped) folder** → `hwp.zip`

**3. Upload to Claude**

Pick your surface:

- **Claude Desktop app**: **Settings → Skills → Upload skill** → choose `hwp.zip`
- **claude.ai web** (Pro / Max / Team / Enterprise plans): **Settings → Capabilities → Skills → Add skill** → choose `hwp.zip`

Done. Attach a `.hwp` / `.hwpx` file or ask Claude to "draft a Korean report" and the skill kicks in.

</details>

### Claude Code (CLI) — one command (developers)

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. Install the plugin
claude plugin install claw-hwp@claw-hwp
```

That's it. Claude Code auto-loads the skill when you mention `.hwp` / `.hwpx` files. Updates land via `claude plugin marketplace update claw-hwp`.

> **Zero-config**. Node dependencies (`@rhwp/core` WASM ~5 MB, `fflate` ~80 KB) are vendored into `scripts/vendor/` so the plugin works on any machine with Node 18+ and Python 3.9+ — no `npm install` step.

See `plugins/claw-hwp/skills/hwp/SKILL.md` for the full decision tree (read / create / edit / convert / validate).

## Usage by surface

> This section covers only surfaces with Bash + filesystem access (Claude Code Desktop, Claude Code CLI, cowork modes). Plain chat surfaces without Bash (claude.ai web chat, Claude Desktop's non-cowork mode) can't run this skill at all — but the viewer page <https://dohyun468.github.io/claw-hwp/> itself works for anyone with a `.hwp` / `.hwpx` file (no skill/plugin install required).

Only the preview path differs by surface — the read/create/edit flow itself works the same everywhere. Find the row that matches your setup.

### Claude Code Desktop (Code mode) — the smoothest path

Drop a `.hwp`/`.hwpx` into chat (or just mention it by name). The rendered document opens **inline, in a pane next to your conversation** — the pane is the default and handles most of the flow. For a bigger view, side-by-side comparison, or sharing, Claude also emits an auxiliary link to the hosted viewer (<https://dohyun468.github.io/claw-hwp/>) — open it in your browser and drag the file in.

<!-- TODO(media): Desktop Code mode — inline preview pane screenshot/video -->

### Claude Code CLI

Drop a `.hwp`/`.hwpx` into chat. Claude prints a clickable link → click it → the document opens in your default browser. The tiny local server quietly turns itself off about 2 minutes after you close the tab — nothing to clean up.

<!-- TODO(media): CLI — markdown link emission + browser preview screenshot/video -->

### Cowork (claude.ai web cowork, Claude Desktop's cowork mode)

Cowork runs Claude in a remote sandbox, so it can't reach a preview server on your machine. Instead, the same viewer is hosted as a **static page on GitHub Pages**:

1. Claude gives you the `.hwp` / `.hwpx` file plus the viewer link — <https://dohyun468.github.io/claw-hwp/>
2. Download the file, then drop it onto that page (or pick it via the folder icon in the toolbar)
3. It renders right there in the browser. The file is not uploaded anywhere — rhwp WASM parses it locally in your tab.

No install, no Node, no permissions. Zoom (Ctrl+wheel or slider), page navigation, and the auto-correction toggle all work.

If you're offline or GitHub Pages is blocked, OS launchers (`.command` / `.bat` / `.sh`) are still available as a fallback — drop next to the file and double-click, Node.js 18+ required. Claude will offer them if needed.

<!-- TODO(media): cowork — drag-drop onto hosted viewer → rendered preview screenshot/video -->

## Requirements

- Node.js 18+
- Python 3.9+

LibreOffice / Hancom Office are **not** required. PDF/DOCX conversion (later releases) will use LibreOffice headless when available.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 RECON Labs Inc.

---

<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=160&v=4" width="72" alt="RECON Labs" />
  </a>
</p>

<h3 align="center">Built and maintained at <a href="https://www.reconlabs.ai/">RECON Labs</a></h3>

<p align="center">
  Generative-AI 3D content platform — <a href="https://www.reconlabs.ai/">reconlabs.ai</a> · <a href="https://github.com/RECON-Labs-Inc">@RECON-Labs-Inc</a>
</p>
