# HWPX 스타일·스페이싱 전략 — 템플릿 따르기 vs 디폴트

문서를 채우거나 만들 때 **줄간격·문단간격·글자 스타일을 어디서 가져오느냐**의 규칙. 두 경우로 갈린다.

## A. 템플릿이 주어진 경우 → **템플릿 스타일을 그대로 상속**(따로 지정 X)

사용자가 `.hwpx` 서식/템플릿을 주고 채우라고 하면, hwpx-edit op들이 **이미 템플릿 스타일을
물려받게** 설계돼 있다. 새로 스타일을 입히지 말고 **적재적소에 넣어 상속**시켜라:

| 넣는 방법 | 무엇을 상속 | 검증 |
|---|---|---|
| `replace_text` | 기존 run의 charPr(폰트·크기·굵기) 유지 → **값이 그 칸 글자모양 그대로** | ✓ |
| `set_cell_text` | 셀의 paraPr/charPr 유지(셀 전체 교체해도 스타일 보존) → **표 셀 스타일 그대로** | ✓ |
| `append_paragraph` | **직전 문단의 paraPrIDRef+charPr 복제** → 본문에 붙이면 본문 스타일(줄간격·정렬·들여쓰기·폰트) 그대로 | ✓ 검증: 모던 템플릿에 추가 문단 → paraPr 22(본문과 동일)·줄간격 130% 상속 |
| `insert_table` | 문서의 첫 `<hp:tbl>`를 템플릿 삼아 borderFill/cellSz/cellMargin 복제 → **표 스타일 일치** | ✓ |

**원칙**: "본문은 본문 스타일, 표는 표 스타일"은 **올바른 위치에 넣으면 자동**이다 —
- 본문 내용 → 본문 문단 **뒤에** `append_paragraph`(직전 본문 스타일 복제).
- 표 → `insert_table`(첫 표 스타일 복제) 또는 기존 표 셀에 `set_cell_text`.
- 제목/소제목처럼 **다른 스타일**이 필요하면, 템플릿의 그 스타일 문단을 `--inspect`/`--format markdown`
  으로 찾아 줄간격·정렬·크기를 읽고 `apply_paragraph_style`/`apply_text_style`로 맞춘다(추측 금지).
- ⚠️ 엉뚱한 위치에 붙이면 엉뚱한 스타일을 상속한다(예: 목차 문단 뒤에 본문을 붙이면 목차 스타일).
  넣기 전에 **어느 문단을 복제하게 될지** 인덱스를 확인하라.

## B. 템플릿이 없는 경우(새로 생성) → **우리 디폴트 스타일·스페이싱**

`create.js`(rhwp)로 새로 만들 때의 디폴트. 한국 공문 표준을 따른다:

| 항목 | 디폴트 | 비고 |
|---|---|---|
| **줄간격(lineSpacing)** | **160% (PERCENT)** — government 테마 | 한국 공문 표준 160~180%. 테마별로 다름: modern 130%, 등 |
| **문단 앞/뒤 간격(prev/next)** | **0** | 줄간격으로 띄우고 문단 사이 추가 간격은 안 줌(공문식) |
| 들여쓰기 | 레벨별 left(0/2000/3000/4000…) | 개요번호 수준 들여쓰기 |
| 폰트/제목색 | 테마(government/corporate/modern/clean/warm)가 결정 | government=기본 |

디폴트를 바꾸고 싶으면 생성 후 `apply_paragraph_style`(`lineSpacing` 퍼센트, `spacing_before`/
`spacing_after` HWP단위)로 조정 — 이 값들은 **Hancom web-safe**(hp:switch로 baked).

## 참고: HWPX vs DOCX 스페이싱 철학 (왜 다르게 보이나)

| | 줄간격(line) | 문단 앞/뒤(para) | 인상 |
|---|---|---|---|
| **HWPX**(우리/한국 공문) | **160%** | 0 | 줄 사이 넉넉, 문단은 붙음 |
| **DOCX**(서구/Word·docx-js) | 단일(1.0) | 앞 8pt·뒤 2~8pt(`w:spacing before/after`) | 줄 사이 좁고, 문단 사이 띄움 |

같은 내용도 HWPX는 세로로 더 퍼지고 DOCX는 문단 단위로 끊겨 보인다. **한국 문서(.hwpx)는 160%
줄간격이 맞다** — DOCX식 문단간격을 흉내 내지 말 것(공문에서 어색). 비교 렌더:
`~/Downloads/테마비교/compare_hwpx_vs_docx.png`.

관련: `hwpx-edit-ops.md`(apply_paragraph_style·append_paragraph), 메모리 [[hwpx-spacing-half-xmlversion]]
(rhwp xmlVersion 1.2→1.5 패치로 한컴 margin 반감 버그 해결), [[hwpx-theme-system]].
