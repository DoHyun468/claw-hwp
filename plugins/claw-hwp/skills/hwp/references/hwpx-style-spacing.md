# HWPX 스타일·스페이싱 매뉴얼 — 템플릿 따르기 vs 디폴트 스펙

문서를 채우거나 만들 때 **줄간격·문단간격·글자 스타일을 어디서 가져오느냐**의 규칙.
**먼저 판단**: 사용자가 채울 **템플릿/서식(.hwpx)을 줬나?**
- **줬다 → §A.** 템플릿 스타일을 **상속**한다. 아래 디폴트 스펙(§B)을 **적용하지 마라**.
- **안 줬다(새로 생성) → §B.** 우리 디폴트 스펙으로 만든다.

---

## §A. 템플릿이 주어진 경우 → 템플릿 스타일 **상속** (디폴트 스펙 적용 금지)

op들이 **이미 템플릿 스타일을 물려받게** 설계돼 있다. 새 스타일을 입히지 말고 **올바른 위치에
넣어 상속**시켜라. "본문은 본문 스타일, 표는 표 스타일"은 위치만 맞으면 자동이다.

| 넣는 방법 | 무엇을 상속 |
|---|---|
| `replace_text` | 기존 run의 charPr(폰트·크기·굵기) → 값이 그 칸 글자모양 그대로 |
| `set_cell_text` | 셀 paraPr/charPr 유지(셀 전체 교체해도) → 표 셀 스타일 그대로 |
| `append_paragraph` | **직전 문단의 paraPr+charPr 복제** → 본문 뒤에 붙이면 본문 스타일(줄간격·정렬·들여쓰기·폰트) |
| `insert_table` | 문서 첫 `<hp:tbl>` 복제(borderFill/cellSz/cellMargin) → 표 스타일 일치 |

**적재적소 원칙**
- 본문 → 본문 문단 **뒤에** `append_paragraph`. 표 → `insert_table`(또는 기존 표에 `set_cell_text`).
- 제목/소제목처럼 **다른 스타일**이 필요하면: 템플릿에서 그 스타일 문단을 `--inspect`/`--format markdown`
  으로 찾아 **줄간격·정렬·크기를 읽고**(추측 금지) `apply_paragraph_style`/`apply_text_style`로 맞춘다.
- ⚠️ 엉뚱한 위치에 붙이면 엉뚱한 스타일 상속(목차 뒤에 본문→목차 스타일). 넣기 전 **어느 문단을
  복제하게 될지 인덱스 확인**.
- ⚠️ `apply_paragraph_style`로 부분 속성(예: spacing만) 바꿀 때 **나머지(정렬·들여쓰기)는 현재 값
  자동 보존**됨(2026-06-19 수정). 정렬을 안 바꾸려면 그냥 안 넘기면 된다.

---

## §B. 템플릿이 없는 경우(새로 생성) → 우리 디폴트 스펙

`create.js`로 새로 만들 때 적용하는 **명시적 디폴트** (한국 공문 표준 기반, docx 스킬 벤치마크 반영).
**이 표는 §B(새 문서)에만 적용.** 템플릿 편집(§A)에는 쓰지 말 것.

| 요소 | 값 | 비고 |
|---|---|---|
**⚠️ 이 스페이싱·크기 값은 create.js가 요소별로 자동 적용한다(아래는 소스 상수 그대로). 직접
다시 넣지 마라 — 덮어쓰면 오히려 줄어든다. 소스 = `create.js`의 `HEADING_DEFAULTS` /
`BODY_LINE_SPACING` / `BODY_SPACING_AFTER` / `LIST_*` (이게 진실, 표가 어긋나면 소스를 봐라).**
단위: spacingBefore/After·gap은 HWPUNIT(1mm≈283.46), 줄간격은 %.

| 요소 | 크기 | 줄간격 | 앞 간격(before) | 뒤 간격(after) |
|---|---|---|---|---|
| 본문 paragraph | 테마 폰트 ~10pt | **150%** (`BODY_LINE_SPACING`) | 0 | **1000 ≈3.5mm** (`BODY_SPACING_AFTER`) |
| 제목 L1(문서제목) | 18pt 굵게 | **120%** (`HEADING_LINE_SPACING`) | **2200 ≈7.8mm** | 1100 ≈3.9mm |
| 제목 L2(절 `1. …`) | 14pt 굵게 | 120% | **1700 ≈6.0mm** | 900 ≈3.2mm |
| 제목 L3 | 12pt 굵게 | 120% | 1400 ≈4.9mm | 750 ≈2.6mm |
| 제목 L4 | 11pt | 120% | 1100 ≈3.9mm | 600 ≈2.1mm |
| 제목 L5/L6 | 10.5/10pt | 120% | 900 / 800 | 520 / 450 |
| 리스트 item | 본문크기 | **140%** (`LIST_LINE_SPACING`) | 0 | **700 ≈2.5mm** (`LIST_SPACING_AFTER`) |
| 표 | 셀 22pt 등 | — | **위 outMargin 500≈1.8mm**(`TABLE_TOP_MARGIN`) | **아래 1700≈6mm**(`TABLE_OUTMARGIN`) |
| 표 (배치) | 래퍼 문단 prev=0 → 표 위 간격 = 앞 요소.after + 1.8mm = **제목→표 ≈ 제목→글**(이중간격 방지). 이중 너비·연한 테두리·머리행 옅은 음영 | | | |
| 용지/여백 | A4, 상하좌우 ~20mm (`setup_document`) | | | |

→ 정리: **본문 150% 줄간격 + 문단 뒤 3.5mm**, **제목은 120% 줄간격 + 레벨별 앞 큰 간격(L1 7.8 / L2 6mm)
+ 뒤 간격**, **리스트 140% + 뒤 2.5mm**. 색/폰트는 theme이 결정(크기·간격은 theme 무관, 위 고정).
제목 색: L1 #1A1A1A … 점점 옅게(테마 override 가능).

조정이 필요할 때만 `apply_paragraph_style`(`lineSpacing` %, `spacing_before`/`spacing_after` HWP단위,
`align`, `indent` — 모두 Hancom web-safe, 부분 적용 시 나머지 자동 보존 §A) 로 **명시적으로** 바꾼다.
리스트는 유니코드 "•" 텍스트 금지, `set_bullet_list`/`set_number_list` 사용(한컴 web BULLET strip 주의
[[hwpx-hancom-web-list-strip]]).

---

## 참고: HWPX vs DOCX 스페이싱 철학 (왜 다르게 보이나)

| | 줄간격 | 문단/제목 간격 | 인상 |
|---|---|---|---|
| **HWPX**(우리 create.js) | **본문 150% / 제목 120%** | 본문 뒤 3.5mm, 제목 앞 6~7.8mm·뒤 3mm | 줄 적당, 섹션은 제목의 큰 앞 간격으로 또렷 |
| **DOCX**(서구/docx-js) | 단일(1.0) | 본문 0, 문단 뒤 8pt·제목 앞뒤 12/9pt | 줄 좁고 문단/제목 간격으로 구분 |

같은 본문도 HWPX는 세로로 퍼지고 DOCX는 문단 단위로 끊겨 보인다. 비교 렌더(같은 본문 풀페이지):
HWPX(160%) ↔ DOCX(soffice). **한국 문서(.hwpx)는 160% 줄간격 유지** — docx 문단간격 흉내 금지.

> docx 스킬엔 "템플릿 스타일 감지→재사용" 분기가 없다(새 문서 vs XML 직접편집뿐). 우리 §A 상속
> 전략이 더 구체적이다. docx에서 벤치마크한 건 **"디폴트 스펙을 표로 못박는다"는 방식**뿐 —
> 값 자체는 우리 create.js가 이미 docx보다 섹션 간격이 크다(제목 앞 6~7.8mm vs docx 4.2mm). 추가 불필요.

관련: `hwpx-edit-ops.md`(apply_paragraph_style·append_paragraph·insert_table), `hwpx-object-placement.md`(객체 배치),
메모리 [[hwpx-spacing-half-xmlversion]]·[[hwpx-theme-system]].
