<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=200&v=4" width="96" alt="RECON Labs" />
  </a>
</p>

<h1 align="center">claw-hwp</h1>

<p align="center">
  HWP/HWPX skill for Claude — read, create, and edit Korean Hangul documents in Claude Code, Desktop, and web.<br/>
  한글 문서를 Claude 어디서든. <a href="https://github.com/edwardkim/rhwp">rhwp</a> WASM 기반.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <a href="https://www.reconlabs.ai/"><img src="https://img.shields.io/badge/built%20at-RECON%20Labs-0f172a" alt="Built at RECON Labs" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

---

## What is this?

`claw-hwp` brings native HWP / HWPX support to Claude as an [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview). Most of the Korean office ecosystem is locked into Hancom's `.hwp` / `.hwpx` formats, and Claude can't read or edit them out of the box. This skill closes that gap so Claude can:

- **read** HWP/HWPX text, tables, and metadata
- **create** new HWPX documents from scratch
- **edit** existing documents (text replace, table fill, formatting) by unpacking the XML and using Claude's native `Edit` tool
- **convert** `.hwp ↔ .hwpx` losslessly via the rhwp WASM library

It runs in Claude Code, Claude Desktop, and claude.ai — no Hancom Office, no LibreOffice, no Windows COM required.

## Built on

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — the Rust + WebAssembly viewer/editor core that powers all parsing, rendering, and `.hwp` ↔ `.hwpx` conversion. Without rhwp this project doesn't exist.
- **[golbin/hop](https://github.com/golbin/hop)** — the open-source HWP desktop app that wraps rhwp. Reference for editor UX patterns.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic's official skill repository. The `docx`, `pptx`, `xlsx` skills are the structural blueprint we mirror.

## Status

🚧 Early development. v0 contract (`skills/hwp/SKILL.md`) is in place; bundled scripts coming next.

## Roadmap

- [x] v0 contract — `SKILL.md` decision tree
- [x] v0.1 — `references/hwpx-format.md` (XML schema cheatsheet for Claude to edit by hand)
- [x] v0.2 — Node scripts (`extract_text.js` ✅, `convert.js` ✅, `create.js` deferred — see project notes)
- [x] v0.3 — Python scripts (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — End-to-end smoke tests against rhwp `samples/` fixtures (round-trip verified)
- [x] v0.5 — Claude Code plugin manifest (`.claude-plugin/plugin.json`) + single-plugin marketplace (`.claude-plugin/marketplace.json`)
- [ ] v0.6 — `references/rhwp-api.md` (curated `@rhwp/core` API reference)
- [ ] v0.7 — `create.js` (aligned with MyAgent's existing HWP creation tool)
- [ ] v0.8 — Bundle Node deps in `vendor/` so plugin works without `npm install`
- [ ] v1.0 — Public release, submit plugin to Anthropic's official marketplace
- [ ] v1.1+ — PDF / DOCX conversion, image extraction, viewer/editor React packages

## Install

The same skill folder works across Claude surfaces. Pick the one you use.

### Claude Code (CLI) — recommended

```bash
# 1. Add the marketplace (one-time)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. Install the plugin
claude plugin install claw-hwp@claw-hwp

# 3. Install Node deps (one-time, in the plugin's scripts dir)
cd ~/.claude/plugins/cache/claw-hwp/claw-hwp/*/plugins/claw-hwp/skills/hwp/scripts
npm install
```

Claude Code auto-loads the skill when you mention `.hwp`/`.hwpx` files. Updates land via `claude plugin marketplace update claw-hwp`.

### Claude Desktop (macOS / Windows app)

1. Clone or download this repo.
2. Run `npm install` in `plugins/claw-hwp/skills/hwp/scripts/`.
3. Open Claude Desktop → **Settings → Skills** → *Upload skill* → select the `plugins/claw-hwp/skills/hwp/` folder (or zip it first).
4. The skill auto-loads when you attach a `.hwp`/`.hwpx` file or mention Korean document tasks.

### claude.ai (web, Pro / Max / Team / Enterprise)

1. Clone or download this repo.
2. Open claude.ai → **Settings → Capabilities → Skills** → *Add skill*.
3. Upload the `plugins/claw-hwp/skills/hwp/` folder (zip it first).
4. The web sandbox installs Node deps automatically on first use.

> **One-time `npm install`** — in all three surfaces the Node scripts depend on `@rhwp/core` (HWPX/HWP WASM, ~5 MB) and `fflate` (~45 KB). Claude Code and Desktop need this run once on the user's machine; claude.ai's sandbox handles it for you.

See `plugins/claw-hwp/skills/hwp/SKILL.md` for the full decision tree (read / create / edit / convert / validate).

## Dependencies

- Node.js 18+
- Python 3.9+

LibreOffice / Hancom Office are **not** required. PDF/DOCX conversion (later releases) will use LibreOffice headless when available.

## License

MIT — see [LICENSE](LICENSE).

---

Built and maintained at [**RECON Labs**](https://www.reconlabs.ai/) · [@RECON-Labs-Inc](https://github.com/RECON-Labs-Inc)
