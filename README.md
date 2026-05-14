<h1 align="center">claw-hwp</h1>

<p align="center">
  Claude 에서 한글 문서 (.hwp / .hwpx) 를 다룰 수 있게 해주는 스킬입니다. 읽기 · 만들기 · 편집을 Claude Code · Desktop · 웹 어디서든.<br/>
  <a href="https://github.com/edwardkim/rhwp">rhwp</a> WASM 기반.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/status-WIP-orange" alt="WIP" />
</p>

<p align="center">
  <strong>한국어</strong> · <a href="README_EN.md">English</a>
</p>

---

## 소개

`claw-hwp` 는 Claude 가 한글 문서 (.hwp / .hwpx) 를 직접 다룰 수 있도록 해주는 [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 입니다. 한국 사무 환경에서는 한컴오피스 형식이 사실상 표준인데, Claude 는 기본적으로 이 형식을 읽거나 편집하지 못합니다. 이 스킬을 설치하면 Claude 가 다음 작업을 할 수 있습니다:

- **읽기** — .hwp / .hwpx 의 본문, 표, 메타데이터 추출
- **만들기** — 새 문서 작성 (제목·문단·표·이미지·페이지 나누기 포함). 단, 표가 들어가야 하면 `.hwp` 로 출력해야 합니다 — 아래 [현재 제한사항](#현재-제한사항) 참조
- **편집** — 기존 문서의 텍스트 치환, 문단 추가, 서식 변경 등 — XML 을 풀어서 Claude 의 `Edit` 툴로 직접 수정
- **변환** — `.hwp ↔ .hwpx` 양방향 변환 (rhwp WASM). 무손실은 아닙니다 — 라운드트립 시 표·이미지가 손상될 수 있습니다
- **미리보기** — rhwp 가 렌더한 페이지를 인라인 또는 브라우저에서 확인 (환경별로 방식이 다름 — 아래 [환경별 사용법](#환경별-사용법) 참조)

읽기 / 만들기 / 편집 / 변환은 Claude 가 Bash 와 파일 시스템을 쓸 수 있는 모든 환경에서 작동합니다 — Claude Code CLI, Claude Code Desktop (Code 모드), Claude Desktop cowork 모드, claude.ai cowork.

미리보기는 환경마다 방식이 다릅니다:

| 환경 | 미리보기 |
|---|---|
| Claude Code Desktop (Code 모드) | 대화 옆 인라인 패널 |
| Claude Code CLI | 로컬 `localhost:3737` 브라우저 링크 (에이전트가 서버 자동 기동) |
| Claude Desktop cowork 모드 | <https://dohyun468.github.io/claw-hwp/> 페이지에 파일 끌어 놓기 (Node 설치 불필요) |
| claude.ai cowork (웹) | <https://dohyun468.github.io/claw-hwp/> 페이지에 파일 끌어 놓기 (Node 설치 불필요) |

한컴오피스 / LibreOffice / Windows COM 모두 **필요 없습니다**.

## 현재 제한사항

rhwp 직렬화 한계에서 오는 제약입니다. 사용 전에 아시면 좋습니다.

- **`.hwpx` 로 출력할 때 표가 사라집니다.** `create.js` 로 새 `.hwpx` 를 만들거나 `.hwp → .hwpx` 변환을 하면 rhwp 의 `exportHwpx()` 가 표를 드롭합니다. **표가 들어가야 하면 `.hwp` 로 출력하세요.** 정 `.hwpx` 가 필요하면 한컴오피스나 한컴독스에서 한 번 열었다 저장하면 표 XML 이 다시 만들어집니다.
- **기존 `.hwp` 파일을 편집하면 그 안의 표가 사라질 수 있습니다.** `.hwp` 편집 경로는 내부적으로 `.hwpx` 변환을 한 번 거치는데, 그 단계에서 표가 드롭됩니다. **기존 표를 보존하면서 편집해야 한다면 `.hwpx` 원본으로 시작하세요** — 이 경로는 XML 을 직접 편집하므로 표가 그대로 유지됩니다.
- **`.hwp ↔ .hwpx` 라운드트립은 손실이 있습니다.** 표 / 이미지 / 복잡한 도형이 손상될 수 있으니, 가능하면 `.hwpx` 를 원본 형식으로 두고 `.hwp` 출력은 명시적으로 필요한 경우에만 사용하세요.
- **PDF / DOCX 변환은 아직 지원하지 않습니다.** 추후 LibreOffice headless 연동으로 추가할 예정입니다.

## 의존하는 프로젝트

- **[edwardkim/rhwp](https://github.com/edwardkim/rhwp)** — Rust + WebAssembly HWP 뷰어/에디터 코어. 이 스킬의 모든 파싱·렌더링·`.hwp` ↔ `.hwpx` 변환을 담당합니다. rhwp 가 없었으면 이 프로젝트 자체가 시작될 수 없었습니다.
- **[golbin/hop](https://github.com/golbin/hop)** — rhwp 를 감싼 오픈소스 HWP 데스크탑 앱. 에디터 UX 패턴을 참고했습니다.
- **[anthropics/skills](https://github.com/anthropics/skills)** — Anthropic 공식 스킬 저장소. `docx`, `pptx`, `xlsx` 스킬의 구조를 본떠서 만들었습니다.

## 한국 HWP 오픈소스 생태계

claw-hwp 는 한국 HWP 형식을 오픈소스로 다루려는 더 큰 흐름의 일부입니다. 각 프로젝트가 다른 자리에서 보완 관계로 작동합니다:

| 프로젝트 | 역할 | 언제 쓰나 |
|---|---|---|
| **[rhwp](https://github.com/edwardkim/rhwp)** | HWP 파싱/렌더 코어 (Rust + WASM) | 다른 프로젝트들의 기반 |
| **[hop](https://github.com/golbin/hop)** | HWP 데스크탑 뷰어 (Tauri) | macOS / Linux 에서 .hwp 열어보기 |
| **claw-hwp** | Claude/AI 워크플로우용 HWP 스킬 | AI 와 함께 한글 문서 생성·요약·편집 |

`rhwp` 가 없으면 이 생태계 자체가 성립하지 않습니다. 데스크탑 GUI 가 필요하면 `hop`, AI 워크플로우가 필요하면 `claw-hwp` 를 보세요.

## 상태

🚧 v1.0 공식 마켓플레이스 검토 대기 중 (2026-05-14 제출). 읽기 / 만들기 / 편집 / 변환 / 미리보기 파이프라인은 네 가지 환경에서 모두 동작 확인.

## 로드맵

- [x] v0 — `SKILL.md` 결정 트리
- [x] v0.1 — `references/hwpx-format.md` (Claude 가 직접 편집할 때 참조하는 XML 스키마)
- [x] v0.2 — Node 스크립트 (`extract_text.js`, `convert.js`)
- [x] v0.3 — Python 스크립트 (`unpack.py`, `pack.py`, `validate.py`)
- [x] v0.4 — rhwp `samples/` fixture 대상 end-to-end 스모크 테스트 (round-trip 검증)
- [x] v0.5 — Claude Code 플러그인 manifest + 마켓플레이스 정의
- [x] v0.6 — `references/rhwp-api.md` (`@rhwp/core` API 레퍼런스)
- [x] v0.7 — `create.js` 핵심 op (setup_document, append_{heading,paragraph,table,list,image}, replace_text, page/column break, load-then-append, 확장자 기반 `.hwp`/`.hwpx` 디스패치)
- [x] v0.8 — Node 의존성 vendoring — Code / Desktop / 웹 어디서든 zero-config 설치
- [x] v0.9 — 플러그인 아이콘
- [x] v1.0 — 공식 마켓플레이스 제출 (검토 대기)
- [ ] v1.1 — 각주 (`append_paragraph_with_footnotes`) + Markdown→HWP 인용 스타일 (numeric_inline / footnote / footnote_with_bibliography)
- [ ] v1.2+ — PDF / DOCX 변환, 이미지 추출, 뷰어/에디터 React 패키지

## 설치

본인이 쓰는 환경에 따라 한 가지 길만 따라하면 됩니다. 세 환경 모두 같은 스킬 파일을 씁니다.

### 처음이세요? — Claude 에게 부탁하세요 (Claude Desktop, claude.ai 웹)

가장 쉬운 길은 Claude 한테 직접 시키는 겁니다. Claude 채팅 (Desktop 앱이든 claude.ai 웹이든) 에 아래 한 줄을 그대로 붙여넣으세요:

```
https://github.com/DoHyun468/claw-hwp 이 스킬 설치 도와줘
```

사용 중인 OS (Mac / Windows) 와 환경 (앱 / 웹) 에 맞춰 Claude 가 단계별로 안내해 줍니다. 명령어 한 줄도 직접 안 칩니다.

<details>
<summary>직접 손으로 깔고 싶다면 (수동 단계)</summary>

**1. GitHub 에서 zip 받기**

<https://github.com/DoHyun468/claw-hwp> 페이지를 엽니다 → 파일 목록 위쪽의 녹색 **`Code`** 버튼 클릭 → **`Download ZIP`**. `claw-hwp-main.zip` 같은 파일이 다운로드 됩니다.

**2. 스킬 폴더만 다시 zip 으로 묶기**

받은 zip 을 더블클릭해서 풀면 `claw-hwp-main` 폴더가 생깁니다. 그 안에서 `plugins` → `claw-hwp` → `skills` → `hwp` 폴더까지 들어갑니다 (`SKILL.md` 파일과 `scripts/`, `references/` 폴더가 보이면 맞아요).

이 `hwp` 폴더를 통째로 다시 zip 으로 압축합니다:
- **Mac**: `hwp` 폴더 우클릭 → **압축** → `hwp.zip` 생성됨
- **Windows**: `hwp` 폴더 우클릭 → **보내기 → 압축(zip) 폴더** → `hwp.zip` 생성됨

**3. Claude 에 업로드**

본인 환경에 따라:

- **Claude Desktop 앱**: **Settings → Skills → Upload skill** → 방금 만든 `hwp.zip` 선택
- **claude.ai 웹** (Pro / Max / Team / Enterprise 플랜 필요): **Settings → Capabilities → Skills → Add skill** → 방금 만든 `hwp.zip` 선택

업로드 후 `.hwp` / `.hwpx` 파일을 채팅에 첨부하거나 "한글 보고서 만들어줘" 같이 한글 문서 관련 작업을 시키면 자동으로 스킬이 작동합니다.

</details>

### Claude Code (CLI) — 명령어 한 줄 (개발자용)

```bash
# 1. 마켓플레이스 등록 (한 번만)
claude plugin marketplace add https://github.com/DoHyun468/claw-hwp

# 2. 플러그인 설치
claude plugin install claw-hwp@claw-hwp
```

설치하면 끝입니다. `.hwp` / `.hwpx` 파일을 언급하면 Claude Code 가 자동으로 스킬을 불러옵니다. 업데이트는 `claude plugin marketplace update claw-hwp`.

> **별도 의존성 설치 불필요**. Node 의존성 (`@rhwp/core` WASM 약 5 MB, `fflate` 약 80 KB) 이 `scripts/vendor/` 에 vendoring 돼 있어, Node 18+ / Python 3.9+ 만 있으면 바로 작동합니다 — `npm install` 단계 없습니다.

전체 결정 트리 (read / create / edit / convert / validate) 는 `plugins/claw-hwp/skills/hwp/SKILL.md` 를 참조하세요.

## 환경별 사용법

미리보기 동작 방식만 환경마다 조금씩 다릅니다 (읽기/만들기/편집 흐름 자체는 어디서든 같음). 본인 환경에 맞는 항목을 보세요.

> 이 섹션은 Bash + 파일시스템 접근이 있는 환경 (Claude Code Desktop / Claude Code CLI / cowork 모드) 만 다룹니다. Bash 가 없는 일반 chat (claude.ai 웹 chat, Claude Desktop 의 비-cowork 모드) 에서는 이 스킬 자체가 실행되지 않습니다 — 단, 미리보기 페이지 <https://dohyun468.github.io/claw-hwp/> 자체는 누구나 `.hwp` / `.hwpx` 파일만 있으면 브라우저에서 바로 쓸 수 있습니다 (스킬/플러그인 설치 불필요).

### Claude Code Desktop (Code 모드) — 가장 매끄러운 경험

`.hwp`/`.hwpx` 파일을 채팅에 드롭하거나 파일 이름을 언급하면 됩니다. 렌더된 문서가 **대화 옆 패널에 인라인으로** 열립니다 — 기본은 패널 안에서 끝납니다. 큰 화면 / 사이드-바이-사이드 비교 / 다른 사람한테 공유가 필요하면 같이 emit 되는 웹 뷰어 링크 (<https://dohyun468.github.io/claw-hwp/>) 로 브라우저에서 열어 드래그 드롭하면 됩니다. 대화하면서 문서를 빠르게 넘겨볼 때 가장 편합니다.

<!-- TODO(media): Desktop Code 모드 — 인라인 미리보기 패널 스크린샷/영상 -->

### Claude Code CLI

`.hwp`/`.hwpx` 파일을 채팅에 드롭하면 Claude 가 클릭할 수 있는 링크를 출력합니다. 클릭하면 기본 브라우저에서 문서가 열립니다. 작은 로컬 서버는 탭을 닫고 약 2 분 후 알아서 종료되므로 따로 정리할 게 없습니다.

<!-- TODO(media): CLI — 마크다운 링크 + 브라우저 미리보기 스크린샷/영상 -->

### Cowork (claude.ai 웹 cowork, Claude Desktop 의 cowork 모드)

Cowork 는 Claude 가 원격 샌드박스에서 돌기 때문에 미리보기 서버에 직접 접근할 수 없습니다. 대신 같은 뷰어를 **GitHub Pages 정적 페이지** 로 호스팅해 둡니다:

1. Claude 가 `.hwp` / `.hwpx` 파일과 함께 뷰어 링크를 줍니다 — <https://dohyun468.github.io/claw-hwp/>
2. 파일을 내려받아서 그 페이지에 끌어 놓거나 우측 상단 폴더 아이콘으로 선택합니다.
3. 브라우저 안에서 바로 렌더됩니다. 파일은 외부로 업로드되지 않습니다 — rhwp WASM 이 사용자 브라우저 안에서 직접 파싱합니다.

설치 / Node / 권한 모두 불필요합니다. 줌 (Ctrl+휠 또는 슬라이더), 페이지 이동, 자동 보정 토글 모두 작동합니다.

오프라인 환경이거나 GitHub Pages 가 막혀 있는 경우의 대안으로 OS 별 launcher 도 있습니다 (`.command` / `.bat` / `.sh` — 파일 옆에 두고 더블클릭, Node.js 18+ 필요). Claude 가 필요할 때 알려줍니다.

<!-- TODO(media): cowork — 호스팅 뷰어에 드래그 드롭 → 렌더 스크린샷/영상 -->

## 요구사항

- Node.js 18+
- Python 3.9+

LibreOffice / 한컴오피스는 **필요 없습니다**. 단 추후 PDF / DOCX 변환을 추가할 때는 LibreOffice headless 가 있으면 사용할 예정입니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참조. Copyright © 2026 RECON Labs Inc.

---

<p align="center">
  <a href="https://www.reconlabs.ai/">
    <img src="https://avatars.githubusercontent.com/u/82856082?s=160&v=4" width="72" alt="RECON Labs" />
  </a>
</p>

<h3 align="center"><a href="https://www.reconlabs.ai/">RECON Labs</a> 에서 만들고 유지보수합니다</h3>

<p align="center">
  Generative-AI 3D 콘텐츠 플랫폼 — <a href="https://www.reconlabs.ai/">reconlabs.ai</a> · <a href="https://github.com/RECON-Labs-Inc">@RECON-Labs-Inc</a>
</p>
