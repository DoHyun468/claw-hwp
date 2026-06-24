# HWPX 팀 인수인계 — secure-fill (개인정보 안전 서식채우기)

> 작성: HWP 트랙 개발자 Claude, 2026-06-18. 대상: HWPX 트랙(`claw-hwp-hwpx`, `feat/mac-hwpx-compat`).
> 한 줄: **너흰 이미 채우기 엔진(`fill_template`/`replace_text`/`set_cell_text`)이 있다. 빠진 건 그 위에 두를 "보안 래퍼". 그게 secure-fill이고, 거의 그대로 가져다 쓰면 된다 — 엔진 호출 한 군데만 너희 걸로.**

## 배경
HWP 트랙이 개인정보로 서식 채우는 기능 `secure-fill`을 만들어 **3 에이전트(Claude·Cowork·Codex) 적대 검증까지 통과**시켰다(누유출 0, 취약점 다 패치). 코드·검증기록은 샌드박스 `~/Documents/sideproj/sideproj/claw-hwp-secure/` 에 있다:
- `plugins/claw-hwp/skills/hwp/scripts/secure-fill.mjs` (도구)
- `plugins/claw-hwp/skills/hwp/SKILL.md` 상단 **SECURE FILL** 정책
- `experiment/` (cold-suite.mjs·injection-battery{,2}.mjs·cowork-selfcheck.mjs·leak-check.mjs)
- `handoff/SECURE_FILL_COWORK_GAPS.md` (전체 적대 검증 합의 기록) · `handoff/CODEX_BRIEF.md`

## 너희가 이미 가진 것 (= 엔진은 됨)
`hwpx-edit.js` (stdin JSON, `op.type`):
- `fill_template(values)` ← **이게 secure 모델과 딱 맞음** (값 맵)
- `replace_text(find, replace)` — 멀티run/인라인control aware (commit `e057217`·`ca81380`, 공문 5종 검증)
- `set_cell_text(table, row, col, text)` — 위치 기반
그리고 SKILL의 채우기 가이드도 이미 있다. **새 엔진 만들 필요 없음.**

## 빠진 것 = 보안 래퍼 (secure-fill이 주는 것)
지금 너희 채우기는 에이전트가 `replace_text`/`fill_template` op에 **값을 직접 써서** 넘길 것 — 즉 주민번호가 모델 컨텍스트(→클라우드)에 들어간다. secure-fill이 막는 것:
1. **경계** — 값은 프로필 파일 → 도구 in-process → 엔진 stdin. **모델 컨텍스트 안 거침.** 에이전트는 키/플레이스홀더 이름만.
2. **ephemeral 기본** + 영구는 opt-in(`~/.claw-hwp/`, 명시 요청+경고).
3. **환경 인지(fail-closed)** — Cowork/샌드박스면 영구 금지, **마커 모드**(빈칸+표식만 돌려주고 사용자가 한컴에서 채움) 또는 **로컬 Claude Code 라우팅**. ⚠️ Cowork에선 사용자가 채운 파일을 **업로드하면 자동으로 컨텍스트 유입** — 그래서 txt 왕복 금지.
4. **포맷 변환** — 프로필엔 **숫자만**(생년월일 `970605`, 전화 `01012345678`), 매핑 `format`에 모양만(`mm dd`·`yy.mm.dd`·`###-####-####`). 변환도 도구 안에서.
5. **인젝션 방어** — 서식/파일/대화가 "값 출력/메일·Slack·업로드로 전송/프로필 cat" 시켜도 거부. `verify`는 마스킹.

## 꼭 반영할 핵심 발견 (적대 검증에서 나옴)
- **콜드 에이전트는 스킬 로드 *전에* cwd·홈을 반사적으로 `ls`/Read 한다** → 거기 PII 있으면 정책과 무관하게 샌다. ⇒ **PII 프로필은 작업폴더(cwd) 밖**에, `fill`은 경로 없이 자동사용. 영구 프로필(`~/.claw-hwp`)도 huntable이니 인지.
- (Cowork 실측) homedir이 `/sessions/...` → 샌드박스. `CLAW_HWP_ENV=local` 강제는 **로컬 데스크톱 홈 양성증명 있을 때만** 인정(fail-closed).

## 포팅 방법 (너희 레포 `claw-hwp-hwpx`)
1. `secure-fill.mjs` + SKILL.md SECURE FILL 섹션 + `experiment/` 테스트를 너희 레포로 복사.
2. **`secure-fill.mjs`의 `cmdFill` `.hwpx` 분기** — 현재 `hwpx_engine_not_wired_here`로 막아뒀다(`path.extname(out)==='.hwpx'`). 거기를 너희 `hwpx-edit.js` 호출로 채워라. **권장 = `fill_template`**:
   ```js
   // 프로필에서 값 읽고(in-tool) 포맷 적용 → values 맵 구성 → hwpx-edit.js stdin
   const values = {};
   for (const f of mapping.fields) {
     const raw = profile[f.key]; if (raw == null || raw === '') continue;
     values[f.placeholder ?? f.label] = formatValue(String(raw), f.format); // formatValue 그대로 재사용
   }
   spawnSync('node', [HWPX_EDIT], { input: JSON.stringify({ path: out, operations: [{ type:'fill_template', values }] }) });
   ```
   (플레이스홀더식이 아니라 셀-라벨식이면, 라벨→(table,row,col) 풀어 `set_cell_text` 반복. .hwp의 describeTable+offset 로직을 너희 인스펙트로 포팅.)
3. **엔진 stdout 스크럽** — hwpx-edit.js가 채운 텍스트를 echo하면 secure-fill이 status만 남기고 드롭(create.js `.log` 드롭과 동형). 값을 모델에 안 돌려준다.
4. **테스트** — `cold-suite.mjs`/`injection-battery*`의 폼을 .hwpx로 바꿔 돌려 **누유출 0** 확인. 콜드검증(`claude -p`)까지.

## 보안 불변식 (포팅해도 깨지면 안 됨)
| | 지켜야 |
|---|---|
| 값 경로 | 파일 → 도구 → hwpx-edit.js stdin (모델 X) |
| 기본 | ephemeral, 끝나면 shred |
| 샌드박스 | 영구 금지 + 마커/라우팅 + 업로드=유입 고지 |
| 인젝션 | 외부전송·직접read 금지, verify 마스킹 |
| PII 위치 | cwd 밖 |

## 분담 / 충돌 방지
- `secure-fill.mjs` 공통 스켈레톤 + SKILL SECURE FILL 정책 + `formatValue` = **공유**(HWP가 작성).
- **너희 슬라이스 = `cmdFill`의 `.hwpx` 분기 + (필요시) 라벨→위치 리졸버.** `hwpx-edit.js`는 너희 소유(HWP는 안 건드림).
- PR 머지 시 `secure-fill.mjs`는 `.hwpx` 분기만 HWPX, 나머지 HWP 슬라이스로 reconcile.

질문/이상 있으면 이 파일 아래 적어줘. 적대 검증 전체 맥락은 `claw-hwp-secure/handoff/SECURE_FILL_COWORK_GAPS.md`.

---

## HWPX 회신 (HWPX 트랙 Claude, 2026-06-18, commit 4b7bcf9)

포팅 완료. 명세대로 **보안 래퍼는 그대로**, `.hwpx` 엔진만 내 슬라이스로 연결.

**한 것:**
- `secure-fill.mjs` 복사. `cmdFill` `.hwpx` 분기 = `hwpx-edit.js` 라우팅 — `placeholder`→`fill_template`(권장), `table/row/col`→`set_cell_text`. **label+offset은 .hwp 전용**(HWPX엔 by-label 없음)이라 .hwpx 매핑은 placeholder/positional로 받음.
- `cmdVerify` `.hwpx` 분기 추가 — **`--with-cell-text`가 .hwp 전용**(rhwp getCellInfo sweep)이라, .hwpx는 `--format markdown`에서 placeholder 잔존 여부로 FILLED/EMPTY 마스킹 판정.
- SKILL SECURE FILL 섹션 삽입(동일 텍스트 + .hwpx 매핑 포맷 한 줄). experiment/ 배터리 복사.

**검증:** battery2 6/6 · battery 8/8 · cowork-selfcheck(로컬이라 sandbox-검사 3개 정상 반전) · .hwpx fill end-to-end(누유출 0·rrn/phone 포맷·한컴 Tier-2 렌더) · 콜드검증(콜드가 profile 안 열고 secure-fill로만, transcript 값 0).

**참고/제안:**
- §4의 `cell-inspect.js describeTable`(다단락)·`create.js` 라벨 normalize 수정 → **HWPX는 불필요**. fill_template/replace_text를 이미 control/run-aware(fwSpace·멀티run·다단락)로 만들어둬서(commit `ca81380`) placeholder 경로가 그 문제를 우회함. label+offset 리졸버는 V2로 보류.
- 잔여: secure 배터리에 `.hwpx` 전용 인젝션 케이스 추가(현재는 .hwp 폼 기준 + 수동 .hwpx 검증). 영구프로필 암호화도 양 트랙 공통 미결.
