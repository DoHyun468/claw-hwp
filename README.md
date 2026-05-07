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
- [ ] v0.1 — `references/hwpx-format.md` (XML schema cheatsheet for Claude to edit by hand)
- [ ] v0.2 — Node scripts (`extract_text.js`, `create.js`, `convert.js`) with bundled `@rhwp/core` WASM
- [ ] v0.3 — Python scripts (`unpack.py`, `pack.py`, `validate.py`)
- [ ] v0.4 — End-to-end smoke tests against `samples/` HWPX fixtures
- [ ] v0.5 — `npx skills add` distribution + Claude Code plugin manifest
- [ ] v1.0 — Public release, npm/skill marketplace submission
- [ ] v1.1+ — PDF / DOCX conversion, image extraction, viewer/editor React packages

## Install (planned)

```bash
npx skills add https://github.com/DoHyun468/claw-hwp --skill hwp
```

Once installed, Claude automatically loads the skill when you mention `.hwp`/`.hwpx` files or Korean document tasks. See `skills/hwp/SKILL.md` for the full decision tree.

## Dependencies

- Node.js 18+
- Python 3.9+

LibreOffice / Hancom Office are **not** required. PDF/DOCX conversion (later releases) will use LibreOffice headless when available.

## License

MIT — see [LICENSE](LICENSE).

---

Built and maintained at [**RECON Labs**](https://www.reconlabs.ai/) · [@RECON-Labs-Inc](https://github.com/RECON-Labs-Inc)
