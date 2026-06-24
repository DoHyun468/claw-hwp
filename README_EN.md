<h1 align="center">claw-hwp</h1>

<p align="center">
  Read · create · edit Korean Hangul documents (<b>.hwp · .hwpx</b>) with <b>Claude · Codex</b><br/>
  No Hancom Office, no coding required.
</p>

<p align="center">
  <img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/DoHyun468/claw-hwp/main/.github/traffic-summary.json" alt="Clones (14-day)" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

<p align="center">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

---

## What is this?

Korea runs on Hangul (`.hwp`) documents — reports, official letters, plans, table-heavy forms.

Install `claw-hwp` and you can **just tell an AI like Claude or Codex, in plain language**, to read, create, and edit those Hangul documents for you.

> - "In this report's table, change the revenue cell to 12 billion."
> - "Make the title blue and bold, body in Malgun Gothic."
> - "Split the body into two columns."
> - "Make a table and put a page number in the footer."

That's all it takes. The result file **opens cleanly in Hancom Office and Hancom Docs (the Hangul web app) — nothing breaks.**

Hancom Office · LibreOffice · Windows-only programs — **none required.**

## Who is it for?

- **Office workers · civil servants · practitioners** who deal with Hangul (`.hwp`) documents often
- Anyone using AI agents like Claude Code / Codex
- **No coding required** — install once, then just ask in plain language.

---

## What can it do?

Organized by the features people actually use in Hangul documents — here's **what works today (✅).**

### 📖 Read
- ✅ Pull out document text · tables · info
- ✅ Extract even the contents of individual table cells

### ✍️ Character formatting
- ✅ Bold · italic · underline · strikethrough
- ✅ Highlight · text color
- ✅ Font size · font family
- ✅ Superscript · subscript
- ✅ Letter spacing · character width
- ⬜ Outline · shadow · emphasis dots

### 📐 Paragraph formatting
- ✅ Alignment (left · center · right · justify · distribute · divide)
- ✅ Line spacing
- ✅ Indent · left/right margins · spacing before/after
- ✅ Paragraph background color
- ✅ Bullets · numbering · promote/demote level

### 📊 Tables
- ✅ Create tables
- ✅ Enter · replace cell content
- ✅ Cell background · borders · diagonals
- ✅ Merge · split cells
- ✅ Add · delete rows/columns
- ✅ Equalize cell width/height · vertical alignment
- ✅ Header-row color · cell margins · table size · split-border for tables crossing a page

### 🧩 Insert
- ✅ Images
- ✅ Shapes (rectangle · ellipse · line · arc)
- ✅ **Charts — 20 types** (column · line · pie · doughnut · 3D, etc.) + direct row/column data + **automatic document-theme colors**
- ✅ Text boxes
- ✅ Equations
- ✅ Special characters
- ✅ Footnotes · endnotes
- ✅ Input fields · hyperlinks · bookmarks
- ✅ Paragraph rules
- ✅ **Signature · seal** (place a stamp/signature on the signature line — precisely, without growing the table/page)
- ✅ **Object placement** (in-front · square · top-bottom · behind) + position · size · line · fill
- ✅ **Object deletion** (remove images · shapes · charts · tables · equations)
- ⬜ Comments *(dropped on save, so excluded)*

### 📄 Page
- ✅ Paper size · **orientation (landscape/portrait)** · margins
- ✅ Headers · footers (text)
- ✅ Page numbers (header/footer × left/center/right)
- ✅ Columns (2 · 3)
- ✅ Page breaks · column breaks
- ⬜ Page borders · background

### 🆕 Create · edit
- ✅ Create new documents (.hwp · .hwpx)
- ✅ Edit existing documents **in their original format** — no format change, so **nothing breaks**
- ✅ **Document themes** (colors · fonts · chart colors · table headers in one shot) — see [🎨 Themes](#-themes--colors--fonts--charts--table-headers-in-one-shot)
- ✅ **Privacy-safe form filling** — see [📝 Form filling](#-form-filling)
- ✅ Preview
- ⬜ PDF · Word (docx) conversion *(planned for a later version)*

> 💡 **You'll rarely need ".hwp ↔ .hwpx conversion."**
> `.hwp` stays `.hwp`, `.hwpx` stays `.hwpx` — files are opened, edited, and saved **in their original format.** Conversion exists (tables and text survive), but some things like images can shift, so **prefer staying in the original format.**

> ✅ = works right now · ⬜ = not yet, or planned for a later version.

---

## 🎨 Themes — colors · fonts · charts · table headers in one shot

A phrase like *"government-document look,"* *"keep it modern,"* or *"warm tone"* unifies **the heading colors and body fonts — plus chart colors and table header colors** into one consistent look. Below is the **same report with only the theme changed** — chart type (column · line · pie · doughnut) and portrait/landscape are free too.

<table>
  <tr>
    <td align="center"><img src="assets/theme-gov-column.png" width="320" alt="Government theme · column chart"/><br/><sub><b>Government</b> · column</sub></td>
    <td align="center"><img src="assets/theme-modern-line.png" width="320" alt="Modern theme · line chart"/><br/><sub><b>Modern</b> · line</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/theme-warm-doughnut.png" width="320" alt="Warm theme · doughnut chart"/><br/><sub><b>Warm</b> · doughnut</sub></td>
    <td align="center"><img src="assets/theme-clean-landscape.png" width="320" alt="Clean theme · landscape"/><br/><sub><b>Clean</b> · landscape</sub></td>
  </tr>
</table>

---

## ✍️ Signature · seal — drop a stamp onto the signature line, precisely

For documents with a signature line or a "(signature or seal)" cell, claw-hwp places your **stamp / signature image** neatly on the line. It auto-positions whether it's a table cell or a free-text line, and **never grows the table or page.** Square stamp or a wide signature — the aspect ratio is preserved. No stamp image? It generates a **red square name seal** for you.

<table>
  <tr>
    <td align="center"><img src="assets/seal-holgildong.png" width="150" alt="generated red name seal"/><br/><sub>Generated red name seal</sub></td>
    <td align="center"><img src="assets/seal-placed.png" width="440" alt="placed precisely on the signature line"/><br/><sub>Placed precisely — cell unchanged</sub></td>
  </tr>
</table>

> Stamp / signature images are treated as personal data — never shown on screen, cleaned up when done.

---

## 📝 Form filling

For standard forms you fill out all the time — official letters, applications, plans, résumés — claw-hwp **fills in your information.** Say "fill this application with my info" and blanks like name, address, and phone get populated.

### 🔒 Personal data, kept safe
Sensitive data like national ID or business numbers go into these forms. So it works like this:
- **Values are never written into the chat.** Your info lives only in a memo file on your computer, and **the AI never looks at the values** — only the fill tool reads that file. (No need to paste your national ID into chat.)
- Default is **use-and-erase** (ephemeral). If re-entering each time is tedious, it's stored on your computer only when you say "keep it," and you can delete it anytime.
- Even verification is done **with values masked** (••••).

### 🔁 It adapts to each form's shape
The same info is shaped differently per form. A birthdate as `970605` here, `97.06.05` there; a phone as `010-1234-5678` · `01012345678` · `82)10-1234-5678` — claw-hwp **reshapes it to match that field** automatically. Write it once, and it fits any form.

---

## 👀 See the result with your own eyes — Hancom Docs capture *(optional)*

"You say you fixed it — but does it actually look right in Hancom?" There's a separate helper that lets you **verify with a real on-screen image: `hancomdocs-capture`.**

- With your consent, a browser window opens **just once** to log in to Hancom Docs.
  *(Passwords are not stored. Login stays **on your computer only** — like logging into a browser once and not being asked again. So one setup, and you keep using it without logging in again.)*
- From then on, it automatically uploads the document to Hancom Docs and **takes a photo of how it actually looks.**
- That photo is **seen by both you and Claude** — so instead of "it works, trust me," you get **results verified with your own eyes.** Quality goes up sharply.

| Pick the area you want | Zoom in |
|:---:|:---:|
| <img src="assets/capture_select.png" width="380"/> | <img src="assets/capture_zoom.png" width="380"/> |

> Everything works without it — this is an optional helper that adds "see it with your eyes." Install instructions are just below.

---

## 📥 Install

> **Works on both Claude and Codex** (install + operation verified on both). Same GitHub repo, only the commands differ. Find the method that matches your setup.

### Regular users — Claude desktop app (Mac · Windows)

1. In the **Code** tab, click **Customize** on the left
2. Next to **Personal plugins**, click **`+`** → **Add marketplace**
3. Paste this URL and click **Sync**:

   ```
   https://github.com/DoHyun468/claw-hwp
   ```

**Done!** Now drop a Hangul file into chat or mention its name, and it kicks in automatically.

> 💡 **Try saying:** `Show me report.hwp` · `Open this Hangul file` · `Add a line to meeting-notes.hwp`
> (Mentioning **the file or its name** works better than an abstract "install it / set it up.")

### Add the "see-it-with-your-eyes" helper too *(optional)*

To use the Hancom Docs capture above — one line in Claude Code (CLI):

```
claude plugin install https://github.com/DoHyun468/hancomdocs-capture
```

Log in to Hancom Docs once, and you're set.

### Developers — Claude Code (CLI)

```bash
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp
claude plugin install claw-hwp@claw-hwp
```

> After updating, open a **new session (new window)** — an open session keeps running the old version.

### Codex app — works exactly the same ✅ *(verified)*

Codex uses **the same repo, as-is.** Add it via marketplace and install; the `claw-hwp:hwp` skill auto-loads, and **the preview viewer opens in the Codex in-app browser** (just like the Claude Code app).

```bash
codex plugin marketplace add https://github.com/DoHyun468/claw-hwp
codex plugin add claw-hwp@claw-hwp
```

> Claude uses `claude plugin …`, Codex uses `codex plugin …` — **only the command differs; same repo, same install.**

---

## 🐞 If something's broken or not working

- We'll soon add a way to **report errors straight from a GitHub issue page.** *(in progress)*
- Until then, please write **which file and what didn't work** in [Issues](https://github.com/DoHyun468/claw-hwp/issues). Attaching the Hangul file helps us fix it fast.

---

## Preview — see your edited Hangul document on screen

Here, **"preview"** means **drawing your edited/created Hangul (`.hwp`) document on screen so you can see how it looks.** Read/create/edit work the same everywhere; only **where the Hangul preview appears** differs by surface:

| Surface | Hangul preview |
|---|---|
| **Claude app (Code mode) · Codex app** | Both the same — shown right beside you in the app (localhost preview) |
| **Claude Code (CLI · terminal)** | localhost preview as a clickable link → in an external browser |
| **Claude Cowork** | (remote, can't run localhost) → drag the file onto the github.io viewer |

> 📄 **To just open and view a Hangul file with no install / login** — anyone can drag it onto <https://dohyun468.github.io/claw-hwp/> and see it in the browser. (Works even where skills can't be installed, like claude.ai web.)
> 🔍 **To review/edit exactly 1:1 with Hancom** — open it in the **Hancom Office (Hangul) app or Hancom Docs.** This preview is for "quick checks while working"; Hancom-compatibility **verification** is handled by the [Hancom Docs capture](#-see-the-result-with-your-own-eyes--hancom-docs-capture-optional) above.

---

## Built on

Reads documents via [rhwp](https://github.com/edwardkim/rhwp) (open-source Hangul format core), with **edit-in-place** and **save-without-breaking-in-Hancom-Office/Docs** infrastructure built on top.

## License

MIT
