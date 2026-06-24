# HWP(.hwp) 객체 배치 매뉴얼 — wrap / position / margin 올바르게 고르기

차트·도형·글상자·이미지를 본문에 넣을 때 **무엇을 넣느냐에 따라 배치(wrap) 모드와 위치·여백을
맞춰야** 자연스럽다. 옵션이 나쁜 게 아니라 **상황에 안 맞는 설정**이 문서를 깨뜨린다(예: 전폭 도형을
`square`로 넣으면 글이 흐를 자리가 없어 레이아웃이 밀림). HWPX 트랙의 `hwpx-object-placement.md`와
**같은 wrap enum·결정표**를 쓴다(머지 시 어휘 일치). 아래는 .hwp raw-patch 경로 기준.

## wrap enum (5종) — set_object_property·set_table_property·insert_*가 전부 공유

`inline | topbottom | square | behind | front` — 바이트 인코딩은 `set_object_property.wrap`
(claw-hancomdocs `object-prop`로 5모드 전부 GT 검증)과 **동일**(gso CTRL_HEADER attribute,
mask `0x600001`). insert 시 넣는 attribute가 set_object_property가 쓰는 값과 바이트 일치하므로,
insert+wrap = insert 후 set_object_property(wrap)과 같다.

적용 op:
- **`insert_chart` / `insert_shape` / `insert_textbox`** — `wrap`·`pos_x_mm`·`pos_y_mm`·`margin_mm`을
  직접 받음. **기본 `wrap:"inline"`**(글자처럼).
- **`insert_image` / `insert_equation`** — 인라인 고정. 다른 배치가 필요하면 삽입 후
  **`set_object_property`**(`object_index`, `wrap?`, `pos_x_mm?`, `pos_y_mm?`, `margins?`)로 바꾼다.
- **`set_object_property`**(그림/도형)·**`set_table_property`**(표, `table_wrap`)도 동일 enum으로 기존 개체 수정.

## 한눈 결정표 — "무엇을 넣나" → 모드 + 설정

| 넣는 것 / 의도 | wrap | 위치·여백 |
|---|---|---|
| 보고서 도표·그래프(섹션 안 그림) | **inline**(기본) | 자기 줄 차지. 가장 안전·예측가능 |
| 전폭 그림 한 줄 띄워 배치 | **topbottom** | 글은 위/아래만. inline과 함께 깔끔 |
| 좁은 객체 옆에 글 흐르기(잡지식) | **square** | `margin_mm:3`, 객체가 좁아야 함(기본 ~53mm면 OK) |
| 워터마크·강조 배경(글 뒤) | **behind** | **연한 색**, `pos_x_mm`/`pos_y_mm`로 위치 지정 |
| 도장·콜아웃(내용 위 오버레이) | **front** | 작게, `pos_x_mm`/`pos_y_mm`로 빈 자리에 |
| 표 | (블록) | 표는 자체 블록. `set_table_property.table_wrap`로 조정 |

## 모드별 레시피 (바이트검증 + 한컴 docs 렌더 확인, 2026-06-19)

### inline (글자처럼) — **기본값**, 도표/그림 99%는 이걸로
- 객체가 **삽입한 그 자리·자기 줄**에 박히고 글은 위/아래로만 흐름. 뒤 페이지로 안 떠내려감.
- 셀 안 객체(`insert_*`의 `cell:{row,col}`)는 항상 inline(가운데). 함정 없음. 고민되면 inline.

### topbottom (자리차지) — 전폭 그림을 띄워 배치
- 플로팅이지만 좌우로 글이 안 흐름(위/아래만). inline과 결과 비슷하나 플로팅이라 위치가 약간 이동 가능.

### square (어울림) — **좁은 객체 + 긴 문단**일 때만
- 객체 옆으로 글이 흐른다. `margin_mm:3`(글-객체 간격) 권장.
- 옆에 흐를 **문단이 충분히 길어야** 자연스럽다(짧은 제목 옆 square는 그냥 떠 보임 — anchor를 본문 단락으로).
- ❌ 안티패턴: 전폭 객체 + square → 글 흐를 폭이 없어 레이아웃 밀림.

### behind (글 뒤) — 워터마크·강조 배경
- 객체가 **글 아래** 깔림. 글을 안 가리려면 연한 `fill`(예: `set_object_property fill:"#EEF2F9"`).
- `pos_x_mm`/`pos_y_mm`로 위치 지정(미지정 시 0,0에 겹침). 검증: rect wrap:behind, x30 y60 → 표 텍스트가 도형 위로 읽힘.

### front (글 앞) — 콜아웃·도장 오버레이
- 객체가 **글 위에** 뜸. 내용을 가리므로 **작게 + 빈 자리에** 위치 지정 필수(`pos_x_mm`/`pos_y_mm`).

## 위치·여백 레퍼런스
- **`pos_x_mm`,`pos_y_mm`**: 종이 기준 오프셋. floating(square/behind/front)에서만 의미. inline은 무시(글 흐름 따라감).
- **`margin_mm`**(또는 `margins:[l,r,t,b]`): 객체-글 바깥 간격. inline/topbottom 2~3mm로 충분, square는 3mm 권장.
- **크기 `width_mm`/`height_mm`**(2026-06-19): `insert_shape`(rect/line/ellipse)·`insert_textbox`·`insert_chart`·`insert_image`가
  받음. 미지정 시 기본(도형/글상자 ~53×24mm, 이미지 ~21×13mm). 메커니즘 2가지 —
  **도형/글상자**(벡터)는 CTRL+COMP **+ 레코드 기하좌표**까지(한컴이 record를 literal로 그림; rect=모서리, line=끝점, ellipse=center+axis).
  **차트/이미지**(OLE/래스터)는 CTRL+COMP만으로 프레임에 스케일. ⚠️ **arc만 크기 미지원**(호 각도까지 얽혀 GT 미매핑 → 깔끔한 에러로 거부).
- **종횡비 자동유지(기본)**: `width_mm`/`height_mm` **한 축만** 주면 나머지는 비율 유지로 자동 계산(이미지는 **네이티브 픽셀 비율**,
  도형/차트는 기본 비율). **두 축 다** 주면 그 값대로(=명시적 왜곡/구겨넣기). 즉 폼의 고정 칸에 억지로 맞춰야 할 때만 두 축을 다 주고,
  평소엔 한 축만 줘서 안 찌그러지게 한다. (예: 이미지 `width_mm:90` → 90×58.5 자동 / `width_mm:90,height_mm:90` → 90×90 왜곡)

## 머지 메모 (HWPX 트랙과)
- wrap enum·결정표·레시피는 `hwpx-object-placement.md`와 **의도적으로 동일**. 두 파일은 트랙별로 분리
  (이건 .hwp 바이트 경로, 저건 .hwpx XML 경로) — 파일명이 달라 머지 충돌 없음.
- 차이: HWPX는 `set_object_position`/`x_mm`·`y_mm`, 우리는 `set_object_property`/`pos_x_mm`·`pos_y_mm`.
  **op 이름·파라미터명이 트랙마다 다름** — 머지 후 SKILL.md에서 포맷별로 갈라 안내(혼동 주의).

관련: SKILL.md `insert_chart`/`insert_shape`/`insert_textbox`/`set_object_property` 행, 메모리 [[hwp-object-insertion]].
