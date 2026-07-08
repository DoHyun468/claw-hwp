# SKILL.md 정리 제안서 (HWPX 세션 → HWP 세션 검토용)

작성: 2026-06-25, HWPX 트랙 세션. 대상: `plugins/claw-hwp/skills/hwp/SKILL.md` (657줄, **공유 핫스팟**).
요청 배경: 사용자 — "skill에 **우리만 아는 내부지식을 일반 팁처럼 일반화**한 것 대체/삭제, **중복**·**HWP↔HWPX 혼재** 점검."

> 검토 방식: 각 항목 `[ ]` 채택 / `[~]` 수정채택 / `[x]` 반려 표시해서 회신.
> **소유권 표기**: `HWPX`=HWPX 세션이 수정, `HWP`=HWP 세션 영역(당신이 결정·수정), `SHARED`=합의 필요.
> SKILL.md은 콜드스타트 검증 Claude가 auto-load → **claw-hancomdocs/내부 진행상황/테스트파일명 0** 유지가 목표.

---

## ① 내부지식을 문서/팁처럼 노출 (대체·삭제)

### (a) 우리 테스트파일명·개발진행 고백 — 독자가 의미 0 `HWP`

| 줄 | 현재 | 제안 |
|---|---|---|
| L219 | `verified concretely: h22 → BF id 2 with 1/1/1/1 thickness; ktx → BF id 4 …` | **삭제** (h22·ktx=내부 테스트파일). 앞 문장 "remaps every cell's border to a uniform visible border so the table shows up"만 유지 |
| L221 | `…requires a (section,paragraph,controlIndex,cellIndex,charOffset) addressing scheme **that we haven't fully wired up** in the synthesize path` | **대체**: "셀 내용은 표 생성 직후 `set_cell_text` op로 채운다 (아래)." — 미완성 개발 고백 제거 |
| L223 | `h22 has 12; ktx has many more` | **대체**: "실제 한컴 서식은 대부분 표시용 BorderFill을 여러 개 갖고 있다." |
| L228 | `verified 2026-05-28 with **h22-style** 14KB / 7-paragraph mini-stream form, real 100×100 PNG…` | **축약**: "작은 기존 `.hwp`에 이미지 추가 → 한컴독스 OK (작은 폼은 정상 round-trip)." |
| L229 | `…same limitation **Hop (golbin/hop)** hits — **exportHwp()** on big existing files…` | **대체**: "큰 기존 `.hwp`(50p+)에 새 개체 추가는 한컴독스가 거부할 수 있다(엔진 round-trip 한계)." — Hop/exportHwp 내부명 제거 |

### (b) 바이트/레코드 내부구현을 문서로 노출 (CLAUDE.md가 금지한 raw-patch/byte/rhwp + 그 이상) `HWP` (L257·290 일부 `SHARED`)

원칙: **에이전트가 op를 쓰는 데 필요한 동작/제약**만 SKILL에 남기고, 바이트 메커니즘(`CHAR_SHAPE`/`PARA_SHAPE`/`HWPTAG_*`/`PARA_TEXT`/`gso`/`BIN000N`/`nchars high bit`…)은 **삭제하거나 `references/`의 개발자 문서로 이동**.

| 줄 | 노출된 내부 | 제안 |
|---|---|---|
| L237 | `appends a new CHAR_SHAPE to DocInfo, bumps HWPTAG_ID_MAPPINGS … inserts PARA_RANGE_TAG (tag=(0x02<<24)\|BGR)` | **축약**: "큰 파일에서도 글자 꾸밈이 한컴독스 호환으로 적용된다." 메커니즘 삭제 |
| L243 | `clones the target PARA_SHAPE … bumps HWPTAG_ID_MAPPINGS PARA_SHAPE count … border_fill_id to its 1-based ID` | **축약**: "정렬/들여쓰기/여백/줄간격/배경색이 큰 파일에서도 적용된다." |
| **L244** | `Key rhwp prop names … color→textColor … **We map for you**. Highlight is the non-obvious one — NOT called highlight/background/charBgColor in rhwp internals` | **전삭제** — 에이전트는 친숙한 이름(`color`,`highlight`)만 쓴다. 내부 매핑표는 가치 0, 순수 누출 |
| L247 | `Internally the op calls rhwp.findOrCreateFontId(name) … writes fontIds:[id×7] on the CharShape` | **축약**: "어떤 폰트명이든 파일에 기록된다; 실제 렌더는 뷰어에 그 폰트가 있는지에 달림(아래)." |
| L257 | `NO PARA_TEXT, single LINE_SEG/CHAR_SHAPE … drops the gso record cluster … PARA_TEXT level 5, vs level 3` | **축약**: 동작만 — "빈칸은 한컴이 받는 빈 문단으로 비운다", "객체째 지우려면 `clear_objects:true`", 중첩셀은 "표-안-표 한 단계 내려감". 레벨/레코드명 삭제 |
| L291 | delete_object 전체 — `nchars high bit 0x80000000 … ~2-billion char count … BIN000N stream renamed … mini↔regular boundary …` | **대폭 축약** (현재 ~15줄 역공학 노트 → 3줄): "개체를 지우고 그 자리에 빈 줄을 남긴다(한컴과 동일). 이미지/차트면 저장된 그림 데이터와 1쪽 미리보기 썸네일까지 정리(redaction 안전). 여러 개 삭제도 안전하게 처리." 바이트 detail은 `references/` 개발자 문서로 |
| L338-347 | 배경색 누출 — `the leak comes from splitParagraph copying paraShape … rhwp's auto-generated default BorderFill borderTop/Bottom=type:1 width:0` | **워크어라운드(L349-366)는 유지**(유용). 원인 산문만 1줄로: "새 문단이 앞 문단 배경을 물려받을 수 있어서다." |

### (c) 내부 QA 용어(GT·byte-identical)를 권위처럼 — `SHARED`

L265·266·279·285 `Byte-identical to Hancom's own X output`, L287 `GT-matched against Hancom's own 2-chart output`, L290 `GT-verified … gso byte-equivalent`, L291 `GT (한컴독스 delete, real .hwp)`

→ 전부 **"한컴독스 렌더 검증됨"**(이미 대부분 병기돼 있음)으로 통일하고 **GT/byte-identical/gso 출처 표현 삭제**. (GT=ground-truth는 우리 내부 QA 용어)

---

## ② 중복

| # | 중복 내용 | 위치 | 제안 |
|---|---|---|---|
| 2-1 `HWP` | **폰트 A-set/B-set 91개 목록 + Webdings 경고 거의 통째로 2번** | L238-242 (apply_text_style) **와** L247-248 (font_family) | **한 곳만 정본 유지**(L247-248 권장), 다른 쪽은 "렌더되는 폰트 = 아래 `font_family` 노트 참조" 1줄 포인터로 |
| 2-2 `SHARED` | "preview ≠ verification / 검증은 한컴독스만" | L443·477·479·530·587·597·599 | 정본 2곳만(Preview 진입 L477 + Verifying L597), 나머지는 짧은 참조로 축소 |
| 2-3 `HWP` | "replace_text가 표 셀 못 봄(rhwp searchText)" | L256·371·441·461·472 (5회) | op표(L256) + .hwp form note(L472) 2곳만. rhwp 내부명은 "표 셀은 못 들어간다"로 |
| 2-4 `SHARED` | "PK 매직바이트=HWPX" | L109·385·628 | Format primer(L109) 1곳 정본, 나머지 축소 |
| 2-5 `SHARED` | "convert.js 표 유지·픽셀 비충실(셀음영/간격/페이지)" | L370·387·445·621·627 | 1곳 정본(L370) + 나머지 포인터 |

---

## ③ HWP ↔ HWPX 혼재/모순 (제일 시급)

| # | 문제 | 제안 |
|---|---|---|
| **3-1** `HWP` | **L383 ↔ L424 정면 모순**: Decision rule(L383)은 `.hwp`=6개op(`set_cell_text·replace_text·append_*·setup·apply_*`)인데, L424 RAW_PATCH_OPS는 `.hwp`가 **~40개**(place_seal·insert_chart·delete_object·insert_shape…) 지원. 같은 문서가 .hwp 능력을 6 vs 40으로 모순 | **L383을 L424 실제 능력에 맞춰 갱신** (또는 "양 포맷 모두 in-place 풀 op 지원 — 표는 각 op표 참조"로 일반화) |
| **3-2** `HWPX` | **L382 `.hwpx` 어휘 stale** — `place_seal`·`set_object_property`·`set_table_property`·`delete_object`·`distribute_table` 누락(전부 실제 HWPX op). **우리가 방금 작업한 place_seal이 .hwpx 목록에 없음** | **HWPX 세션이 L382 갱신** (references/hwpx-edit-ops.md 기준 동기화) |
| **3-3** `SHARED` | **L290 place_seal 설명이 .hwp 구현 기준**("Delegates to insert_image's … **gso** byte-equivalent")인데 **공유 행**. .hwpx place_seal은 self-contained라 메커니즘이 안 맞음 | **포맷 중립화**: "두 엔진이 쓰는 동일한 플로팅 이미지 부착 경로라 같은 한컴독스 호환성을 물려받는다" (gso/GT/insert_image 위임 표현 삭제) |
| 3-4 `HWP` | **L256·472 `.hwp` 맥락인데 `<hp:tbl>`**(HWPX XML 요소) 언급 → .hwp 독자 혼란 | `.hwp` 섹션에선 "표 셀"로 표기, `<hp:tbl>`는 .hwpx 맥락에서만 |
| 3-5 `SHARED` | **op표 L254-291 소속 모호** — "In-place editing"(L252) 바로 아래라 어느 포맷인지 불명확. 실제론 `.hwp` raw-patch op들이고 .hwpx는 references에 별도 | 표 머리에 **"이 표 = `.hwp`(create.js raw-patch) in-place op. `.hwpx` op는 `references/hwpx-edit-ops.md`"** 명시 |

---

## 권장 실행 순서

1. **HWPX 세션 즉시 가능(내 영역)**: 3-2 (L382 .hwpx 어휘 갱신). 합의 시 3-3·2-2·2-4·2-5의 SHARED 부분.
2. **HWP 세션 결정**: ①(a)(b) 전체, ②2-1·2-3, ③3-1·3-4·3-5 — `.hwp`/raw-patch 산문이라 당신이 톤·보존범위 결정.
3. **바이트 메커니즘 보존 원하면** `references/` 개발자 문서로 이동(SKILL에서만 빼기) — 지식 손실 0.

> 회신 주면 HWPX 영역(3-2 등)은 바로 반영하고, HWP 영역은 당신 수정 후 머지 때 합치면 됨.
