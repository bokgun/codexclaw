# PRD — Codex App-Server 기반 Nanoclaw-like 에이전트 (코드명: **codexclaw**)

> **상태**: v1.0 (Final, M0 spike 진행 준비 완료)
> **작성일**: 2026-04-30 (최초) / 2026-05-01 (v1.0 확정)
> **소유자**: TBD
> **분류**: Public OSS Spec / MIT License (D6)

### 변경 이력
- **v1.1** — v1 stable 채널 우선순위 변경. Slack 개인 모드를 v1.0 stable 범위에서 제외하고 v1.x experimental로 이동. v1.0 원격 커뮤니티/팀형 채널은 Discord로 변경. 관련 범위: §3.2, §4 P2, §5 다이어그램, §7.1/§7.3, §8.3 채널 UX, §9 보안 모델, §12 M3, §14 D5, §16 실패 시나리오.
- **v1.0** — 최종화. PRD draft 단계 종료, M0 spike 진행 준비 완료. 추가: §1에 nanoclaw 영감 크레디트 + Codex 상표 디스클레이머 명시, D6에 README 필수 문구 박음, §16.5 실패 시 분기 명확화(WS-only → stdio 폴백 vs approval/thread/cancel 부적합 → 범위 재설계). M0 통과 시 v1.1, 통과 실패 시 v2.0(범위 재설계)로 승격.
- **v0.8** — D6 신설(OSS·MIT). 8건 정합성 회복: §16.1 G `threads` 스키마에 `status` 추가(C1), `prefs` 화이트리스트와 시스템 키 충돌 해소 — `threads.suppress_branch_until` 컬럼 신설(C2), §8.1 분업표의 thread_id/timestamp 행 정정(C3), "세션" 용어 잔재 제거(I4), §3.1 Goal 1 "원격" 한정 명확화(I5), §8.4 `/resume` 제거하고 `/switch`로 통합(I6), P3 페르소나 채널을 Telegram으로 정정(M7), §7.2 어댑터 인터페이스를 3-way approval에 맞춰 갱신(M9).
- **v0.7.1** — 정합성 회복: §12 M0 행의 부록 참조 오류(`§16(부록 A)` → `§16(부록 B)`) 수정. §8.1 `threads` 스키마에 R6에서 이미 약속했던 `status` 컬럼 명시 추가 + enum 정의(`active`/`archived`/`missing`/`quarantined`). §8.1 부팅 동기화와 §8.4 `/archive` 동작 설명을 status 전이로 구체화.
- **v0.7** — D5 신설: Q4(팀 Slack thread 스코프) 확정. v1.0은 `user_key` 기준 개인 모드만 stable, 팀 thread 공유는 v1.x experimental 플래그 뒤로 분리. §16 표의 Q4 참조를 D5로 갱신.
- **v0.6** — M0 spike 체크리스트를 §16 부록 B로 신설(검증 영역 7개·실패 시나리오 6개·산출물 6종·성공/실패 판정 5+4건). 본문 보강: §3.2(Slack 팀 모드 분리), §6.3(스키마 핀 게이트), §7.3(experimental 분리), §10(재연결 정책 명확화), §12(M0 행 확장 + Gate 추가), §14(R4/R5/R6 신규 + Q4 신규).
- **v0.5** — `/budget` 슬래시 명령 v1 스코프에서 제거. R2 완화책을 §8.2의 timeout + 자동 비활성 메커니즘 + Codex/ChatGPT 측 한도 의존으로 재정의. 자체 budget 기능은 v2 재검토.
- **v0.4** — D4 신설(Approval 3-way, Scheduler retry/timeout/dedupe 의무화, 휴면 4시간 후 새 thread 제안). §8.2/§8.3 전면 재작성, §8.4에 "새 thread 제안" 절 추가, §14 D1 단서 미세 조정.
- **v0.3** — D2, D3 추가. AGENTS.md 정책(§8.5) 신설, Codex Cloud v1 비목표 확정. §3.2/§9 보강.
- **v0.2** — D1 추가. Thread 스코프를 사용자 단위로 확정, §5 다이어그램·§5.2 흐름 재작성, §8.1 메모리 분업 원칙 전면 재작성, §8.4 thread lifecycle 명령 신설.
- **v0.1** — 초안.

---

## 1. 개요 (Overview)

**codexclaw**는 OpenAI Codex CLI에 내장된 `codex app-server`의 WebSocket 인터페이스에 외부에서 접속하는 **독립 클라이언트 에이전트**다. Codex 내부 코드를 수정하거나 패치하지 않으며, 공식적으로 제공되는 JSON-RPC 2.0 프로토콜만을 사용한다.

목표는 nanoclaw가 Claude Agent SDK 위에서 만들어낸 "개인이 소유·감사 가능한 미니멀 에이전트" 경험을 **Codex 진영에서 재현**하는 것이다. 즉:

- 메신저/CLI/웹훅 등 다양한 채널에서 들어오는 사용자 입력을 받아
- 격리된 컨테이너에서 실행 중인 `codex app-server`로 라우팅하고
- 결과를 실시간 스트림으로 다시 채널에 돌려준다.

codexclaw는 본질적으로 **Codex의 "프론트엔드 + 라우터 + 메모리/스케줄 레이어"** 다.

> **크레디트 & 상표 안내**
> codexclaw는 [nanoclaw](https://github.com/qwibitai/nanoclaw)에서 영감을 받아 시작된 독립 OSS 프로젝트다. 컨테이너 격리·채널 어댑터·미니멀 호스트 모델 등 nanoclaw가 정립한 패턴을 Codex 진영에 적용한다.
> "Codex"는 OpenAI의 제품명이며, codexclaw는 OpenAI와 무관한 독립 클라이언트다 — 어떤 형태로도 OpenAI의 후원·인증을 받지 않는다.

---

## 2. 배경 및 동기

### 2.1 시장 상황
- nanoclaw, OpenClaw 등 "개인용 에이전트 호스트"가 Claude 진영에서 빠르게 자리 잡았으나, **Codex 진영에는 동등한 OSS 프로젝트가 부재**하다.
- Codex CLI는 `codex app-server`를 통해 VS Code 확장 등 외부 클라이언트가 붙을 수 있도록 JSON-RPC 인터페이스를 공식 노출하고 있다(현재 stdio는 stable, WebSocket은 experimental).
- ChatGPT 구독에 Codex가 포함되면서, 별도 API 키 없이 Codex를 활용할 수 있는 사용자가 늘었다.

### 2.2 왜 Codex CLI를 "해킹"하지 않는가
- Codex는 활발히 변경되며, 내부에 패치를 박으면 **업그레이드마다 깨진다**.
- `app-server` 프로토콜은 OpenAI가 공식 지원하는 통합 진입점이며, 스키마(`codex app-server generate-ts`, `generate-json-schema`)도 버전별로 추출 가능하다.
- 따라서 **Codex는 "엔진"으로 두고, 우리는 그 위에 얇은 호스트 프로세스만 둔다.** 책임 경계가 명확해지고 보안·감사도 단순해진다.

### 2.3 nanoclaw에서 무엇을 가져오는가
- 단일 호스트 프로세스 + 세션별 격리 컨테이너 모델
- 채널(WhatsApp, Telegram, Discord 등) → 라우팅 → 에이전트 → 응답의 단방향 흐름
- 자격증명을 컨테이너 안으로 절대 흘려보내지 않는 정책 (프록시 주입)
- "스킬"로 채널/통합을 사후에 추가하는 확장 모델

### 2.4 nanoclaw와 무엇이 다른가
- **에이전트 엔진**: Claude Agent SDK가 아니라 `codex app-server` (JSON-RPC over WebSocket).
- **모델**: Claude가 아니라 GPT-5 계열(Codex가 선택). 멀티 프로바이더는 비목표.
- **세션/스레드 모델**: nanoclaw는 자체 스레드 모델을 보유, codexclaw는 **Codex의 thread/turn 모델을 그대로 재사용**.

---

## 3. 목표 / 비목표

### 3.1 Goals (v1)
1. 로컬 또는 사용자가 소유·운영하는 리모트 호스트(SSH 가능)에서 실행 중인 `codex app-server`에 WebSocket으로 안정적으로 접속·재연결한다. Codex Cloud 등 매니지드 환경은 D3에 따라 v1 비목표.
2. 최소 1개의 인바운드 채널(권장: Telegram 또는 CLI)에서 사용자 입력을 받아 Codex 스레드로 라우팅한다.
3. Codex가 보내는 스트리밍 이벤트(`agentMessage/delta`, `turn/diff/updated`, 승인 요청 등)를 채널에 자연스럽게 표현한다.
4. Codex의 승인 요청(`serverRequest/approval`)을 채널 UX(예: 메시지 버튼/명령어)로 노출하고 사용자의 응답을 다시 Codex에 전달한다.
5. 호스트 프로세스 자체는 nanoclaw 수준의 가독성을 유지한다 — 핵심 코드 **2,000 LoC 이하** 목표.
6. 사용자 단위로 thread를 운영한다 — 기본 thread 1개 + 명명된 thread N개. 채널은 입출력 창구일 뿐, thread를 분기시키지 않는다.
7. SQLite 한 벌로 **포인터·라벨·스케줄만** 영속화한다. 대화 본문은 Codex의 rollout이 단일 진실의 원천이다.

### 3.2 Non-Goals (v1)
- Codex 내부 동작/사고과정 수정, 모델 라우팅 자체 구현.
- 다중 LLM 프로바이더 추상화 레이어.
- 풀 GUI 대시보드. 운영은 채널 안에서 슬래시 명령으로 끝낸다.
- 멀티테넌트 SaaS. v1은 1인 호스트(또는 신뢰된 소그룹) 전제.
- Codex가 이미 잘하는 작업의 재구현(코드 편집, 패치 적용 등).
- **Codex Cloud(원격 매니지드 환경) 통합.** v1은 사용자가 소유·운영하는 로컬 또는 SSH 가능한 호스트의 `codex app-server`만 대상으로 한다.
- 채널을 통한 AGENTS.md 직접 편집(보안 경계 보호 — §8.5 참조).
- **Slack 통합 및 다중 사용자 공유 thread**(팀 채널에서 A가 시작한 thread를 B가 이어받는 모델). v1은 Telegram과 Discord에 집중하며, Slack 개인 모드와 팀 모드는 v1.x **experimental**로 분리(§7.3, D5 참조).

---

## 4. 페르소나 / 사용자 시나리오

**P1. 1인 개발자 "지훈"** — 항상 켜져 있는 미니PC에 codexclaw를 띄우고 Telegram으로 자기 코드베이스에 명령을 보낸다. 출퇴근 길 핸드폰에서 "test failing on CI 확인하고 PR draft 만들어줘"를 보내면, Codex가 컨테이너 안에서 작업하고 diff 미리보기를 메시지로 돌려준다.

**P2. 소규모 팀 "Qwibit-style"** — Discord 서버에 codexclaw 봇을 두고, 멤버가 멘션하면 자기 thread에서 Codex가 응답한다(D5에 따라 v1.0은 user_key 기준 개인 모드). 승인이 필요한 명령은 Discord 버튼/모달로 처리.

**P3. 자동화 운영자 "민지"** — Cron 스케줄로 매주 월요일 아침에 "지난주 git log 요약 + README drift 점검"을 Codex에게 시키고, 결과를 Telegram으로 받는다. 작업은 task 전용 명명 thread에 바인딩되어 default thread를 오염시키지 않는다(§8.2).

---

## 5. 시스템 아키텍처

### 5.1 컴포넌트 다이어그램 (논리)

```
┌─────────────────────────────────────────────────────────────┐
│                     Host (codexclaw)                        │
│                                                             │
│  ┌──────────────┐   ┌────────────┐   ┌──────────────────┐   │
│  │  Channels    │   │  Router /  │   │ Pointer Store    │   │
│  │ (Telegram,   │──▶│  Inbox     │──▶│ (SQLite)         │   │
│  │ Discord, CLI)│   │            │   │ user→thread_id   │   │
│  └──────────────┘   └─────┬──────┘   │ label→thread_id  │   │
│                           │          │ schedules        │   │
│                           │          └──────────────────┘   │
│                           ▼                                 │
│                  ┌──────────────────┐                       │
│                  │ Codex WS Client  │   ws://… or wss://…   │
│                  │ (JSON-RPC 2.0)   │ ────────────────────┐ │
│                  └──────────────────┘                     │ │
│                                                           │ │
│                  ┌──────────────────┐                     │ │
│                  │ Approval Bridge  │                     │ │
│                  │ Scheduler (cron) │                     │ │
│                  │ Thread Manager   │                     │ │
│                  └──────────────────┘                     │ │
└───────────────────────────────────────────────────────────┼─┘
                                                            │
                                                            ▼
                                                ┌────────────────────┐
                                                │ codex app-server   │
                                                │ rollouts + sqlite  │
                                                │ (SSoT for threads) │
                                                └────────────────────┘
```

### 5.2 핵심 흐름 (Inbound → Codex → Outbound)
1. 채널 어댑터가 인바운드 메시지를 정규화해 Router에 전달.
2. Router가 사용자를 정규화한 `user_key`로 식별하고, Pointer Store에서 활성 thread를 결정한다:
   - 슬래시 명령(`/new`, `/switch …`)이 있으면 해당 thread를 활성으로 전환.
   - 없으면 `(user_key, label="default")` → `thread_id`를 사용. 매핑이 없거나 archived면 `thread/start`로 새로 만든 뒤 매핑 저장.
3. 사용자 메시지를 활성 thread에 `turn.start`(또는 동등 메서드)로 보낸다.
4. Codex가 보내는 알림 스트림(`agentMessage/delta`, `tool/use`, `turn/diff/updated`, `serverRequest/approval`)을 어댑터가 채널 메시지로 번역해 송출.
5. 승인이 필요한 경우 Approval Bridge가 채널 UX로 사용자 응답을 받아 JSON-RPC `result`로 회신.
6. 턴 종료 시 Pointer Store는 `last_routed_at`만 갱신한다. 대화 본문·diff·tool 호출은 Codex rollout에 자동 영속화되므로 codexclaw가 별도로 저장하지 않는다.

### 5.3 격리 모델
- 권장 배포: `codex app-server`를 **Docker 컨테이너 안에서** 실행, codexclaw 호스트는 컨테이너 밖.
- 호스트 ↔ 컨테이너는 WebSocket(loopback 또는 forwarded port)으로만 연결.
- 코드/자격증명 마운트 정책은 nanoclaw와 동일 원칙: **명시적으로 마운트한 디렉토리만 보인다**, 자격증명은 환경변수가 아닌 프록시/시크릿 매니저를 통해 주입.

---

## 6. 프로토콜 / 통합 사양

### 6.1 Codex app-server WebSocket
- 엔드포인트: `ws://HOST:PORT` 또는 `wss://HOST:PORT` (운영은 wss 강제).
- 프레이밍: 텍스트 프레임당 JSON-RPC 메시지 1건. `"jsonrpc": "2.0"` 헤더는 와이어에서 생략.
- 핸드셰이크: HTTP `Authorization: Bearer <token>` 헤더로 인증, 이후 `initialize` → 응답 → `initialized` 알림.
- 헬스 체크: 같은 리스너의 `GET /readyz` 200 활용.
- 백프레셔: 서버 큐 포화 시 `-32001 "Server overloaded; retry later."` 응답 → 클라이언트는 지수 백오프 + 지터로 재시도.

### 6.2 클라이언트 식별
- `initialize.params.clientInfo`에 `name="codexclaw"`, `version`, `title`을 항상 채운다 (OpenAI Compliance Logs 정책 준수).

### 6.3 스키마 동기화
- 빌드 파이프라인에 `codex app-server generate-ts --out ./schemas`를 포함, **Codex 버전 핀과 함께** 타입을 갱신한다.
- Codex 업그레이드 시 스키마 diff를 PR로 자동 생성 → 수동 검토 후 머지.
- 정책: **버전 핀이 없는 빌드는 거부**한다. `package.json` 또는 `Dockerfile`에 `codex` 버전을 정확히 박고, CI에서 `generate-ts` 결과가 `./schemas/generated/`와 일치하는지 검증한다. 실험적 프로토콜 단계에서는 method/event 이름이 minor 버전 사이에서도 바뀔 수 있으므로 이 게이트를 우회하면 런타임 회귀가 보장된다.
- M0 spike에서 실측한 method/event 이름을 `docs/M0-findings.md`에 고정하고, 이후 변경은 명시적 PR로만 반영한다.

### 6.4 인증 / 토큰 관리
- 권장: `--ws-token-file`로 고엔트로피 토큰을 파일로 전달, codexclaw는 동일 파일을 읽어 헤더에 실어 보낸다.
- Public IP 노출 시 wss + reverse proxy(예: Caddy) 강제, 비-loopback 무인증 listener는 금지.

---

## 7. 채널 어댑터 (Channels)

### 7.1 v1 출시 채널
- **CLI/REPL** (개발·디버깅용, 기본 내장)
- **Telegram** (개인용 1순위)
- **Discord** (소규모 커뮤니티/팀 1순위)

### 7.2 어댑터 인터페이스 (개념)
어댑터는 다음 4가지만 구현하면 된다.
- `receive() -> InboundMessage` (스트리밍/롱폴링)
- `send(text, attachments)`
- `request_approval(prompt, options) -> ApprovalResponse`
  - `ApprovalResponse = { decision: "approve" | "reject" | "modify", modify_text?: string }`
  - Modify 선택 시 어댑터는 사용자에게 텍스트 입력을 받아 `modify_text`에 담아 반환한다(§8.3 채널별 UX 참조).
- `acknowledge(typing|seen)` (선택)

### 7.3 향후 확장 (Non-goal v1, 로드맵)
- WhatsApp(Baileys), Slack, Matrix, iMessage relay, Email(Resend) — 모두 "스킬"로 추가.
- **Slack 개인 모드 및 팀 모드 (experimental, v1.x)**: Slack은 워크스페이스 설치/권한/정책 경계가 더 무거우므로 v1.0 stable 범위에서 제외한다. Slack 개인 모드(`user_key` 기준)와 팀 thread(`channel_key` + 멘션 thread 단위)는 v1.x experimental 플래그 뒤에서만 활성화. 기본은 비활성. 사유와 결정 경로는 D5 참조.

---

## 8. 메모리 · 스케줄 · 승인

### 8.1 Memory 분업 원칙

**Codex app-server의 rollout(JSONL, `~/.codex/sessions/`)과 sqlite 메타데이터가 thread 콘텐츠의 단일 진실의 원천(SSoT)이다.** codexclaw DB는 Codex가 모르는 *codexclaw 도메인의 매핑*만 보관하며, 대화 본문은 결코 복제하지 않는다.

#### 무엇을 어디에 두는가

| 정보 | Codex (rollout + sqlite) | codexclaw (`codexclaw.db`) |
| --- | :---: | :---: |
| 대화 turn 본문, tool 호출, diff | ✅ | ❌ |
| 승인 결정 이력 | ✅ | ❌ |
| 압축(compaction) 요약, ghost snapshot | ✅ | ❌ |
| thread_id, createdAt, updatedAt (rollout 메타) | ✅ | ❌ (필요 시 `thread/read`로 조회) |
| `(user_key, label) → thread_id` 매핑 | ❌ | ✅ |
| 어느 thread가 사용자의 default인가 (`is_default`) | ❌ | ✅ |
| Thread 운영 상태(`status`: active/archived/missing/quarantined) | ❌ (Codex 측 archived는 동기화) | ✅ |
| 새 thread 제안 silence 만료(`suppress_branch_until`) | ❌ | ✅ |
| 채널 메시지 ID ↔ Codex turn ID (승인 회신용) | ❌ | ✅ |
| Cron 스케줄 정의 | ❌ | ✅ |
| 사용자 가벼운 선호(언어, 톤 등 — §8.5) | ❌ | ✅ |
| AGENTS.md 본문(에이전트 가드레일·권한) | ✅ (파일시스템) | ❌ |

#### codexclaw SQLite 스키마 (테이블 4개)

- `threads(user_key, label, thread_id, is_default, status, last_routed_at, suppress_branch_until)`
  - `(user_key, label)` 유니크. `label='default'`는 사용자당 1개. 명명 thread는 N개.
  - `status` enum:
    - `active` — 정상. 라우팅 가능.
    - `archived` — Codex 측에서 보관 중. 사용 시 `thread/unarchive` 후 활성화.
    - `missing` — Codex에 thread_id가 더 이상 존재하지 않음(사용자가 호스트에서 직접 삭제 등). 라우팅 거부, 사용자에게 새 thread 생성 제안.
    - `quarantined` — cancel 실패 등으로 thread가 깨졌을 가능성. 라우팅 거부, 사용자에게 `/new` 또는 `/branch` 권장(R6).
  - `suppress_branch_until` (timestamp, nullable) — 새 thread 제안의 silence 만료 시각(§8.4). 사용자가 제안에 "이어가기"를 선택하면 7일 뒤로 설정.
- `pending_approvals(channel_msg_id, thread_id, jsonrpc_id, expires_at)`
  - Codex가 보낸 `serverRequest/approval`을 채널 메시지와 묶어두기 위한 단기 매핑.
- `tasks(id, schedule, prompt, user_key, label, channel)` — Cron 스케줄.
- `prefs(user_key, key, value)` — **사용자가 직접 설정하는** 가벼운 선호(§8.5). 화이트리스트(`lang`, `tone`, `verbosity`)에 없는 키는 거부. 시스템 내부 상태(예: `suppress_branch_until`)는 이 테이블이 아니라 해당 도메인 테이블에 컬럼으로 둔다 — `prefs`는 사용자 영역, 스키마 컬럼은 시스템 영역이라는 경계를 지킨다.

#### 일관성 정책

- **부팅 동기화**: 시작 시 `thread/list`로 매핑이 가리키는 모든 `thread_id`의 status를 검증하고 `threads.status`를 갱신한다. Codex 측 archived는 `status='archived'`, 존재하지 않으면 `status='missing'`. 사용자에게는 `unarchive` 또는 새 thread 생성을 제안.
- **Drift 감지**: 라우팅 직전 `thread/read`(turns 미포함)로 status를 가볍게 확인. 변경이 감지되면 사용자에게 안내 후 진행.
- **Compaction 알림**: Codex가 thread를 압축하면 채널에 1회 안내(예: "이 thread는 이전 N턴이 요약되었습니다"). 알림은 `thread/status/changed` 구독으로 수신.
- **삭제**: 사용자가 thread를 지우면 codexclaw는 매핑을 제거하고 Codex에는 `thread/archive`만 호출한다. rollout 파일의 hard delete는 사용자가 Codex CLI에서 직접 수행하도록 가이드한다(우리가 대신 지우지 않는다).

### 8.2 Scheduler

작업 1건 = "스케줄 + 프롬프트 + 채널 + 사용자 키 + 실행 제어". 트리거 시 일반 사용자 메시지처럼 Router로 주입 → 동일 파이프라인 통과.

#### 실행 제어 (필수)

스케줄러는 단순 cron 실행기가 아니라 **제어 시스템**이다. 자동화 작업은 실패·중복·폭주 위험이 크므로 v1부터 다음 셋을 의무화한다.

| 제어 | 의미 | 기본값 | 비고 |
| --- | --- | --- | --- |
| `retry` | 실행 실패 시 재시도 횟수 | 2 | 지수 백오프(30s → 2m → 8m). retry 소진 시 채널에 1회 알림. |
| `timeout` | 1회 실행 최대 소요 시간 | 10분 | 초과 시 turn 취소(`turn/cancel`) + 실패 처리. |
| `dedupe` | 중복 실행 방지 | `concurrency=1` | 같은 task의 직전 실행이 아직 진행 중이면 새 트리거를 **스킵**(누적 X). `min_interval=<duration>` 옵션으로 시간 기반 dedupe 추가 가능. |

#### 스키마 갱신

`tasks(id, schedule, prompt, user_key, label, channel, retry, timeout_sec, dedupe_policy, last_run_at, last_run_status)` — §8.1의 4-테이블 한도는 유지(컬럼만 확장).

#### 안전 기본값

- 실패 시 무한 반복 방지: 같은 task가 **연속 5회** 실패하면 자동 비활성. 사용자에게 `/tasks reactivate <id>` 안내.
- 자동화 작업은 default thread를 오염시키지 않도록 **task 전용 명명 thread**를 권장(§8.4 `/new`로 사전 생성한 label을 task에 바인딩).

### 8.3 Approval Bridge

Codex의 `serverRequest/approval`을 채널 UX로 변환한다. v1은 **3-way 응답**(Approve / Reject / Modify)을 지원한다 — 실사용 패턴에서 "이 명령 좋은데 한 군데만 고쳐서 실행"이 매우 잦기 때문에 yes/no 이분법은 부적절하다.

#### 응답 옵션과 Codex 매핑

| 사용자 응답 | codexclaw 동작 | Codex 호출 |
| --- | --- | --- |
| **Approve** | 승인 그대로 회신 | `serverRequest/approval` → result: `{decision: "approved"}` |
| **Reject** | 거부 그대로 회신 | `serverRequest/approval` → result: `{decision: "rejected"}` |
| **Modify** | 원 승인은 **reject로 회신**한 뒤, 사용자에게 수정 입력을 받아 **새 turn**으로 보냄. 새 turn에는 원 시도의 컨텍스트("직전 [도구/명령]을 다음과 같이 수정해서 다시 시도해줘: …")를 prefix로 첨부. | `serverRequest/approval` → reject, 이어서 `turn.start` |

> Modify는 Codex 프로토콜 입장에서는 reject + 후속 turn이지만, 사용자 입장에서는 "수정 후 실행"의 자연스러운 한 흐름으로 보이도록 채널 어댑터가 묶어서 표현한다.

#### 채널별 UX

- **Telegram**: 인라인 키보드 `[Approve] [Reject] [Modify]`. Modify 선택 시 봇이 reply 모드로 입력 대기.
- **Discord**: 메시지 컴포넌트 버튼 3종. Modify는 modal 입력창.
- **CLI**: `[a]pprove / [r]eject / [m]odify` 프롬프트. m 선택 시 한 줄 입력.

#### 타임아웃·일관성

- 응답 대기 기본 5분(설정 가능). 타임아웃 시 자동 reject + 채널 알림.
- Modify 입력 대기는 별도 카운터(기본 10분). 입력 없으면 reject로 마감.
- 한 thread에 활성 approval은 항상 1개(중첩 금지). Codex가 동시에 둘을 보내면 두 번째는 큐잉.

### 8.4 Thread Lifecycle 명령 (사용자 단위 thread 모델)

채널을 통해 thread를 명시적으로 관리하기 위한 슬래시 명령. 어댑터 단에서 파싱 후 Thread Manager로 위임.

| 명령 | 동작 | Codex 호출 |
| --- | --- | --- |
| `/new [label]` | 새 thread 생성. label 미지정 시 자동 생성(예: `t-2026-04-30-1`). 활성 thread를 새 것으로 전환. | `thread/start` |
| `/threads` | 사용자의 thread 목록(default + 명명 thread, status 포함) 표시. | `thread/list` 보강 + Pointer Store 조인 |
| `/switch <label>` | 활성 thread를 해당 label로 전환. archived면 자동 unarchive 제안. Codex 측 thread는 `thread/resume`으로 재활성화. | `thread/resume` (필요 시 `thread/unarchive` 선행) |
| `/switch default` | 기본 thread로 복귀. | `thread/resume` |
| `/branch [label]` | 현재 thread에서 분기. 새 thread_id로 매핑 추가. | `thread/fork` |
| `/archive <label>` | thread 보관. `threads.status='archived'`로 표시. | `thread/archive` |

**제약**:
- 활성 thread는 사용자당 항상 정확히 1개. 명령으로 전환하지 않는 한 default를 사용.
- 동시성: 활성 thread에 turn이 진행 중일 때 새 메시지가 오면 큐잉(채널에 "이전 턴 처리 중…" 표시). v1은 인터럽트(끼어들기) 미지원.

#### 새 thread 제안 (자동 분기 ❌, 제안 ⭕)

Thread를 사용자 단위로 묶으면 시간이 흐르며 무관한 주제가 누적되어 **컨텍스트 오염**이 일어난다. codexclaw는 이를 자동 폐기로 해결하지 않는다 — 맥락의 자동 폐기는 회복 불가능하기 때문이다. 대신 **제안만** 한다.

- **트리거 (v1)**: 활성 thread에 마지막 turn 이후 **4시간 이상 경과**한 상태에서 새 메시지가 오면, codexclaw가 turn을 보내기 직전에 채널에 한 번 묻는다:
  > "마지막 작업 이후 4시간이 지났어요. 새 thread로 시작할까요? `[새로 시작] [이어가기]`"
- **주제 변화 기반 제안**은 매 turn LLM 판단이 필요해 비용·지연을 유발하므로 **v2로 미룬다.**
- **Throttle**: 같은 사용자에게 분기 제안은 **하루 최대 1회**. 사용자가 "이어가기"를 선택하면 해당 thread에 대해 7일간 다시 묻지 않는다 — `threads.suppress_branch_until`을 7일 뒤로 설정한다(§8.1 참조). 시스템 상태이므로 `prefs`가 아니라 `threads` 테이블 컬럼에 둔다.
- 사용자가 "새로 시작"을 선택하면 내부적으로 `/new`와 동일하게 동작.

### 8.5 사용자 선호 & AGENTS.md 정책

AGENTS.md는 에이전트의 권한·가드레일을 정의하는 **신뢰 경계 파일**이다. 채널 메시지로 직접 편집할 수 있게 만들면 prompt injection이 곧바로 가드레일 우회로 이어진다(§9 참조). 따라서 채널을 통한 변경은 **무게에 따라 두 갈래로** 분리한다.

#### 가벼운 선호 (codexclaw `prefs` 테이블)
사용자별 톤·언어 같은 **권한과 무관한** 설정만 채널에서 즉시 반영. turn 시작 시 codexclaw가 시스템 메시지로 첨부.

| 명령 | 동작 |
| --- | --- |
| `/prefs show` | 내 선호 목록 표시 |
| `/prefs set <key> <value>` | 선호 설정 (예: `/prefs set lang ko`) |
| `/prefs unset <key>` | 선호 제거 |

허용 키는 화이트리스트로 제한한다(v1: `lang`, `tone`, `verbosity`). 화이트리스트에 없는 키는 거부.

#### 무거운 변경 (AGENTS.md 자체)
권한·가드레일·빌드 명령 등 AGENTS.md에 들어가는 항목은 **읽기 전용 + PR 워크플로**로만 다룬다.

| 명령 | 동작 |
| --- | --- |
| `/agents show` | 현재 AGENTS.md 본문 표시 (읽기 전용) |
| `/agents propose <변경 요청>` | Codex에게 AGENTS.md 변경안 작성을 시킴. 결과는 **diff**로만 채널에 노출되고, 실제 적용은 사용자가 호스트에서 `git apply` 또는 PR 머지로 수행. codexclaw는 절대 직접 쓰지 않는다. |

#### 불변 원칙
- codexclaw는 어떤 경로로도 AGENTS.md를 직접 수정하지 않는다.
- `prefs` 테이블의 값은 시스템 메시지에 텍스트로 포함되며, 도구 호출 권한이나 sandbox 정책을 절대 변경할 수 없다.
- 시스템 메시지로 첨부되는 선호값에는 명령어 prefix(`/`, `!`, 시스템 토큰 등)를 검출해 escape한다 — 사용자가 `prefs.tone`에 prompt injection 페이로드를 넣어도 데이터로만 취급되도록.

---

## 9. 보안 모델

| 위협 | 완화 |
| --- | --- |
| Codex WS 평문 노출 | wss 강제, loopback 외에는 reverse proxy + TLS |
| 토큰 유출 | `--ws-token-file` + 600 권한, env 직접 사용 금지 |
| 컨테이너 탈출 | 비-root, 읽기 전용 마운트, 명시적 allowlist, symlink escape 검사 |
| 채널 측 사칭 | 채널별 서명 검증(Discord interaction signature, Telegram secret_token) |
| 승인 우회 | codexclaw는 Codex의 sandbox/approval 정책을 결코 약화시키지 않는다. `--yolo`, `dangerously-bypass-*`는 호스트 설정에서 차단 |
| Prompt injection from channel | 인바운드 메시지에 시스템-메타 명령 prefix를 절대 신뢰하지 않음. 슬래시 명령은 채널 어댑터 단에서만 해석. `prefs` 값은 시스템 메시지 첨부 시 명령어 prefix를 escape |
| AGENTS.md 가드레일 우회 | codexclaw는 AGENTS.md를 직접 수정하지 않는다. 채널에서는 읽기(`/agents show`)와 변경 제안(`/agents propose` → diff만 출력)만 허용. 실제 머지는 호스트에서 사용자 손으로 수행 (§8.5) |

**불변 원칙**: codexclaw는 절대로 Codex의 보안 결정을 *대신 내리지 않는다*. 우리는 결정을 **운반**할 뿐이다.

---

## 10. 비기능 요구사항

- **언어/런타임**: TypeScript on Bun 1.1+. nanoclaw와 동일한 친숙도.
- **재연결**: WS 끊김 시 지수 백오프(최대 30초). **실시간 스트림 복구는 nice-to-have**(끊긴 동안의 `agentMessage/delta`를 다시 받지 못할 수 있음), **thread 상태 복구는 must-have** — 재연결 후 `thread/read`로 현재 상태를 재동기화하고, 사용자에게는 "X턴이 진행 중이었습니다, 결과 요약을 확인하세요" 형태로 알린다. 중복 `turn.start` 방지는 클라이언트 측 idempotency key로 처리(M0에서 검증).
- **스루풋**: v1은 동시 활성 thread ≤ 16, 분당 메시지 ≤ 120 가정.
- **관측성**: stderr 구조화 로그(JSON line), `LOG_FORMAT=json`. 별도 대시보드 없음.
- **테스트**: Codex app-server를 mock하는 in-process WS 서버로 골든 테스트.
- **배포**: `bash codexclaw.sh` 한 줄 설치. Raspberry Pi 4 / 8GB에서 동작.

---

## 11. 구성 (Configuration)

codexclaw는 nanoclaw처럼 **설정 파일 최소주의**를 따른다. 단, Codex와 달리 외부 자격증명을 다뤄야 하므로 한 개의 `.env`는 허용한다.

```
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
CODEXCLAW_CODEX_TOKEN_FILE=/var/lib/codexclaw/codex.token
CODEXCLAW_DB=/var/lib/codexclaw/codexclaw.db
CODEXCLAW_TRIGGER=@codex
TELEGRAM_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
```

채널 추가/제거는 코드 변경(스킬 형태)으로만 한다 — config sprawl 회피.

---

## 12. 마일스톤 / 로드맵

| 단계 | 목적·산출물 | 기간(가정) |
| --- | --- | --- |
| **M0 — Spike** | **Codex app-server를 신뢰 가능한 remote agent runtime으로 볼 수 있는지 검증.** WS → thread → stream → approval → cancel → reconnect 순서로 가설 검증. 산출물: WS client(`src/codex/ws-client.ts`), CLI REPL(`src/spike/cli-repl.ts`), approval 데모, 생성된 스키마 핀(`schemas/generated/*`), `docs/M0-findings.md`. **상세 체크리스트·성공/실패 판정 기준은 §16(부록 B) 참조.** | 1주 |
| **M1 — Core** | Router, Pointer Store(SQLite), 재연결, Approval Bridge(3-way), Thread Manager(slash 명령). | 2주 |
| **M2 — Telegram** | Telegram 어댑터 + 인라인 승인 UX + 새 thread 제안 UX. | 1주 |
| **M3 — Discord + Scheduler** | Discord 어댑터(user_key 기준 개인 모드 stable), Scheduler(retry/timeout/dedupe), `prefs` KV. | 2주 |
| **M4 — Hardening** | wss 가이드, 컨테이너 레퍼런스, 관측성, 부팅 시 thread/list 동기화. | 1주 |
| **v1.0 GA** | 문서화, `codexclaw.sh` 설치 스크립트. | — |

**M0 Gate**: §16의 5건 성공 판정을 모두 통과해야 M1 진입. 4건 실패 판정 중 하나라도 발생 시 PRD 수정 또는 stdio 폴백(R1)으로 우회.

---

## 13. 성공 지표

- **기술적**: WS 재연결 후 turn 재개 성공률 ≥ 99%, 채널 → Codex 메시지 라우팅 P50 지연 ≤ 300ms (모델 추론 시간 제외).
- **사용성**: "clone → 첫 메시지 응답"까지 15분 이내(맥북 기준).
- **코드 품질**: 핵심 호스트 코드 ≤ 2,000 LoC, 의존성 ≤ 15개.
- **OSS**: GitHub public 저장소로 출시(D6). 라이선스 MIT. 첫 8주 내 외부 PR로 추가 채널 어댑터 ≥ 1개 머지.

---

## 14. 가정 / 리스크 / 미해결 질문

### 가정
- `codex app-server`의 WebSocket 모드가 v1 출시 시점에도 사용 가능하다(현재 experimental). Stable 승격 전에는 stdio 폴백 모드를 옵션으로 둔다.
- Codex의 승인 알림 메서드명/스키마는 안정적이지 않을 수 있으므로 **스키마 자동 생성 파이프라인이 필수**.

### 리스크
- **R1. WebSocket 폐기/변경**: stdio 트랜스포트로의 폴백 어댑터를 동일 인터페이스로 v1에 함께 출시(컨테이너 내부에서 spawn).
- **R2. 토큰 사용량 폭증**: v1은 codexclaw 자체 한도 기능을 도입하지 않는다. 폭주의 주요 경로인 자동화 task는 §8.2의 `timeout` + 5회 연속 실패 자동 비활성으로 차단되며, 사용자 사용량 자체는 Codex/ChatGPT 측 한도와 청구 화면을 단일 진실의 원천으로 본다. 자체 한도(일/thread budget) 도입은 실사용 데이터 확보 후 v2에서 재검토.
- **R3. OpenAI 정책 변화**: ChatGPT 구독 내 Codex 사용 약관 준수, 비상업/상업 구분 명시.
- **R4. 스트림 복구 한계**: WS 끊김 동안 발생한 `agentMessage/delta`를 재연결 후 다시 받지 못할 수 있다. §10의 "실시간 스트림 복구 = nice-to-have, thread 상태 복구 = must-have" 정책으로 대응 — 재연결 후에는 `thread/read`로 상태를 재동기화하고 사용자에게 결과 요약 형태로 알린다. M0에서 실측한 동작에 따라 보강.
- **R5. Approval 다층화**: command approval / patch approval / network approval이 별도 메서드/스키마일 수 있고, 회신 페이로드가 단순 boolean이 아닐 수 있다. M0에서 케이스 3종 이상 실측해 §8.3의 "Approve/Reject/Modify → JSON-RPC result" 매핑을 구체 스키마로 굳힌다. 매핑이 깔끔하지 않으면 §8.3을 재작성.
- **R6. Cancel 비결정성**: turn 취소 후에도 tool 프로세스가 남거나 thread가 busy 상태로 고착될 수 있다. 대응: cancel 실패 시 codexclaw가 해당 thread를 **quarantine 상태**로 표시하고 사용자에게 `/new` 또는 `/branch` 권장. 이 상태 표시는 Pointer Store의 `threads.status` 컬럼으로 표현.

### 결정된 사항 (Resolved)
- **D1 (← Q1)**: Thread 스코프는 **사용자 단위**다. 채널은 입출력 창구일 뿐 thread를 분기시키지 않는다. 사용자당 default thread 1개 + 명명 thread N개의 하이브리드 모델을 채택하며, 새 thread 생성·전환은 `/new`, `/switch`, `/branch` 등 명시적 슬래시 명령으로만 일어난다(§8.4 참조). 시간 경과 등 휴리스틱은 thread를 **자동 폐기하지 않는다** — 다만 채널에 **새 thread 제안**은 할 수 있다(§8.4 "새 thread 제안" 참조). 자동 폐기와 자동 제안은 다르다: 전자는 회복 불가능하지만 후자는 사용자가 거절하면 그만이다.
- **D2 (← Q3)**: AGENTS.md는 **신뢰 경계 파일**로 취급한다. 채널을 통한 직접 편집은 허용하지 않는다. 무게에 따라 두 갈래로 분리: (a) 가벼운 사용자 선호(언어·톤 등)는 `prefs` KV 테이블에 저장하고 turn 시작 시 시스템 메시지로 첨부, (b) AGENTS.md 자체에 들어가는 무거운 변경은 `/agents propose`로 diff만 받고 사용자가 호스트에서 명시적으로 머지(§8.5 참조). 이로써 prompt injection이 가드레일을 직접 바꾸는 경로를 차단한다.
- **D3 (← Q2)**: Codex Cloud(원격 매니지드 환경) 통합은 **v1 비목표**로 확정. v1은 사용자가 소유·운영하는 로컬 또는 SSH 가능한 호스트의 `codex app-server`만 대상으로 한다(§3.2). 클라우드 환경에서는 자격증명 경계, 네트워크 토폴로지, 책임 모델이 모두 달라지므로 별도 설계가 필요하며 v2 이후로 미룬다.
- **D4 (운영 견고성, 라운드 4)**: 다음 셋을 v1 의무 사항으로 확정:
  - **D4a — Approval은 3-way**: Approve / Reject / **Modify**. Modify는 reject + 후속 turn으로 Codex 프로토콜에 매핑(§8.3).
  - **D4b — Scheduler 제어 의무화**: `retry`, `timeout`, `dedupe(concurrency=1)`을 모든 task의 필수 필드로. 5회 연속 실패 시 자동 비활성(§8.2).
  - **D4c — 컨텍스트 오염 방지**: 휴면 4시간 후 채널에 새 thread 제안. 자동 분기는 하지 않으며, 제안은 하루 1회로 throttle(§8.4).
- **D5 (← Q4)**: v1.0의 소규모 커뮤니티/팀형 채널은 **Discord 개인 모드 stable**로 확정. Discord 서버에서도 멘션은 발화자 본인의 1:1 thread로 라우팅된다 — A가 시작한 thread에 B가 이어 말하면 B의 발화는 B의 thread로 간다. 공유 thread(`channel_key + mention_thread` 기준)는 v1.0 범위가 아니며, Discord/Slack 모두 v1.x experimental 플래그 뒤에서만 활성화한다. Slack은 개인 모드까지도 v1.0 stable에서 제외하고 v1.x experimental로 이동한다. 사유: Slack은 워크스페이스 설치/권한/정책 경계가 더 무겁고, OSS 개인/소규모 커뮤니티 호스트라는 제품 톤에는 Discord가 더 가볍게 맞는다. 다중 사용자 thread는 §8.5(prompt injection 방어), §8.3(approval 귀속 — "누가 승인 권한을 갖는가"), §8.1(rollout이 누구의 컨텍스트인지) 모두에서 별도 설계가 필요하다. M0(§16)는 CLI/Telegram 개인 모드만 검증하며, Discord 어댑터(§12 M3)도 user_key 기준 개인 모드부터 stable하게 출시.
- **D6 (OSS·라이선스)**: codexclaw는 **공개 OSS 프로젝트**로 출시한다(GitHub public). 라이선스는 **MIT** — 가장 단순·관대하며, nanoclaw를 비롯한 미니멀 OSS 호스트의 표준이다. 사유: §1·§2의 "개인이 소유·감사 가능한 미니멀 에이전트" 가치, §13의 "외부 PR로 추가 채널 어댑터" 지표, nanoclaw를 레퍼런스로 삼는 문맥 전체가 OSS를 전제로 일관됨. v0.7까지의 "Internal" 분류는 v0.1 초안의 자리표시자였으며 v0.8에서 정정. 정책: 외부 기여자가 보는 문서임을 전제로 PRD·README·기여 가이드를 작성한다(과한 사내 약어·맥락 회피).
  - **README 필수 문구** (출시 전 의무):
    - 상표 디스클레이머: *"codexclaw is an independent open-source client for Codex app-server. It is not affiliated with or endorsed by OpenAI."* (또는 동등한 한국어 표현)
    - nanoclaw 크레디트: *"Inspired by [nanoclaw](https://github.com/qwibitai/nanoclaw). The container-isolation and channel-adapter patterns originate there; codexclaw adapts them for the Codex ecosystem."*
  - 라이선스 파일(`LICENSE`)은 MIT 표준 텍스트를 그대로 사용한다.

### 미해결 질문
*(현재 없음 — 다음 라운드의 설계 검토 또는 M0 spike에서 새로 도출되면 여기 기록한다.)*

---

## 15. 부록 A — 참고 자료

- OpenAI Codex CLI — Features, App Server, Remote Connections (developers.openai.com/codex)
- `openai/codex` GitHub — `codex-rs/app-server/README.md`
- nanoclaw (qwibitai/nanoclaw) — 컨테이너 격리 + 채널 모델의 레퍼런스
- The New Stack, "NanoClaw's answer to OpenClaw is minimal code, maximum isolation"

---

## 16. 부록 B — M0 Spike 체크리스트

> **M0의 목적은 제품 구현이 아니라, Codex app-server를 신뢰 가능한 remote agent runtime으로 볼 수 있는지 검증하는 것이다.**
> 검증 순서: **WS → thread → stream → approval → cancel → reconnect.**

### 16.1 검증 영역

#### A. WebSocket 연결/프로토콜
- app-server 실행 가능 여부.
- `ws://127.0.0.1:<port>` 접속 가능 여부.
- `Authorization: Bearer <token>` 동작 여부.
- `initialize` → `initialized` 순서.
- JSON-RPC `id` / notification 구분.
- streaming event 수신 가능 여부.
- `GET /readyz` health check 동작 여부.
- **성공 기준**: CLI client 없이 직접 WS client로 한 turn 왕복 성공.

#### B. Thread / Turn 기본 흐름
- `thread/start`, `turn.start`.
- `agentMessage/delta` 수신.
- turn 완료 이벤트 식별.
- `thread/resume`, `thread/list`, `thread/read`.
- **성공 기준**: 새 thread 생성 → 메시지 전송 → 응답 스트림 수신 → 종료 감지 → 같은 thread에 후속 메시지 전송.

#### C. Diff / Tool 이벤트
- 파일 수정 diff 이벤트가 오는지.
- shell/tool 실행 이벤트 표현 방식.
- 큰 diff가 chunk로 오는지 전체로 오는지.
- 실패한 tool call 이벤트가 구분되는지.
- **성공 기준**: "README에 한 줄 추가해줘" 같은 요청으로 diff 이벤트를 수신하고, 채널에 요약 가능한 형태인지 확인.

#### D. Approval 이벤트 *(가장 중요)*
- 어떤 작업에서 approval이 발생하는지.
- approval 이벤트 이름/스키마.
- `jsonrpc_id`를 어떻게 돌려줘야 하는지.
- approve/reject 결과 포맷.
- timeout 시 Codex 쪽 상태.
- **성공 기준**: 위험/권한 필요 명령 유도 → approval 수신 → approve/reject 회신 → Codex가 정상 진행/중단.
- **Modify는 M0에서 완전 구현하지 않음** — "reject 후 새 turn으로 재시도 가능 여부"만 확인(§8.3의 매핑이 성립하는지).

#### E. Cancel / Timeout
- 실행 중 turn 취소 가능 여부.
- cancel method 이름/스키마.
- cancel 후 thread 상태 정상성.
- cancel 직후 새 turn 시작 가능 여부.
- **성공 기준**: 긴 작업 실행 → timeout 시 cancel → thread가 깨지지 않고 다음 turn 가능.

#### F. Reconnect / Resume *(실전에서 가장 잘 깨지는 영역)*
- WS 끊김 후 재접속 가능 여부.
- 진행 중 turn의 이벤트를 다시 받을 수 있는지.
- 못 받는다면 `thread/read`로 상태 복구 가능한지.
- 중복 `turn.start` 방지 방법(idempotency).
- **성공 기준**: turn 진행 중 WS 강제 종료 → 재연결 → 현재 thread 상태 확인 → 중복 실행 없이 복구.

#### G. SQLite Pointer Store 최소 검증
- `threads(user_key, label, thread_id, is_default, status, last_routed_at, suppress_branch_until)` 테이블만으로 검증.
- M0에서는 `status` 전이(`active` ↔ `archived`)와 `suppress_branch_until` 기본값(NULL) 동작만 확인. `missing`/`quarantined`는 M1에서 검증.
- **성공 기준**: `(user_key, label)`로 `thread_id` 저장/조회 → 같은 thread로 후속 메시지 라우팅.

### 16.2 실패 가능성 높은 포인트

| # | 시나리오 | 증상 | 대응 |
| --- | --- | --- | --- |
| 1 | WS 프로토콜이 문서와 다름 | method/event 이름 불일치, jsonrpc 필드 생략 규칙 모호, minor 버전 간 스키마 변경 | `generate-ts` 결과를 M0에서 고정, Codex 버전 pin, schema diff를 CI 게이트에 포함(§6.3) |
| 2 | Approval이 단일 이벤트가 아님 | command/patch/network approval이 별도, payload가 boolean이 아님, reject 후 thread 상태 모호 | 케이스 3종(shell, file write, network) 이상 실측 → R5 |
| 3 | Thread resume이 실시간 복구가 아님 | 끊긴 동안의 delta 재수신 불가, 진행 중 turn에 재구독 불가 | "스트림 복구 = nice-to-have, 상태 복구 = must-have"로 설계(§10) → R4 |
| 4 | Cancel이 깔끔하지 않음 | tool 프로세스 잔존, thread busy 고착, 다음 turn 거부 | cancel 실패 시 thread를 quarantine 상태로 표시, 사용자에게 `/new` 권장 → R6 |
| 5 | Diff 이벤트가 채널 UX에 안 맞음 | diff 너무 김, chunk 순서 조립 필요, 메시지 길이 제한 초과 | 채널 출력은 전체 diff가 아니라 (파일명, 변경 라인 수, 요약, artifact/file 링크)로 |
| 6 | "사용자당 활성 thread 1개"가 팀/커뮤니티 채널에서 꼬임 | user_key vs channel_key 모호, A가 시작한 thread에 B가 이어 말하기 가능 여부 | M0는 CLI/Telegram 개인 모드만 검증. Discord v1 stable은 user_key 개인 모드만 지원하고, 공유 팀 모드는 §7.3·D5 참조 |

### 16.3 산출물

```
scripts/start-codex-app-server.sh   # spike용 기동 스크립트
src/codex/ws-client.ts              # JSON-RPC over WS 클라이언트 (재사용 대상)
src/spike/cli-repl.ts               # 한 줄 입력 → 한 turn 왕복 REPL
src/spike/approval-demo.ts          # approval 케이스 3종 유도 데모
schemas/generated/*                 # codex app-server generate-ts 결과 (버전 핀과 함께 커밋)
docs/M0-findings.md                 # 실측 method/event 이름, 스키마 차이, 의사결정 메모
```

### 16.4 성공 판정 (모두 통과해야 M1 진입)

1. WS client로 `initialize` 성공.
2. thread 생성 + turn 왕복 성공.
3. streaming delta 수신 성공.
4. approval approve/reject 성공.
5. WS reconnect 후 같은 thread에 후속 turn 가능.

### 16.5 실패 판정 (하나라도 발생 시 PRD 수정 또는 R1 폴백)

1. WebSocket transport가 불안정하거나 스키마가 너무 자주 깨짐.
2. approval 회신이 외부 client에서 정상 처리 안 됨.
3. reconnect 후 thread 상태 복구가 불가능.
4. cancel/timeout 구현이 불가능.

#### 실패 시 분기

실패 항목의 성격에 따라 두 갈래로 갈린다 — 어느 쪽인지 명확히 판단해야 잘못된 방향으로 끌고 가지 않는다.

- **WS transport만 문제 (실패 #1)** → **stdio 폴백** (R1). app-server를 stdio로 spawn해 같은 JSON-RPC 메시지를 파이프로 주고받는다. 클라이언트 인터페이스(`ws-client.ts`)는 transport 레이어만 교체되며, thread/turn/approval 모델은 그대로 유효하다. PRD 본문 수정은 §6과 §10 일부에 그침.
- **approval/thread/cancel 자체가 외부 제어에 부적합 (실패 #2/#3/#4)** → **제품 범위 재설계.** Codex app-server가 외부 클라이언트의 1급 시민(first-class citizen)으로 동작하지 않는다는 신호다. codexclaw의 핵심 가치(승인 브릿지, thread 수명 관리, scheduler 안전망)가 성립하지 않으므로 PRD 본문(특히 §8.2/§8.3/§8.4)의 재설계가 필요하다. 단순 폴백으로 해결되지 않는다.

---

*본 문서는 v1.0 (Final)이다. M0 spike 결과(특히 R4/R5/R6 실측)에 따라 §6/§8.3 등은 v1.1로 갱신될 수 있으며, M0 실패 시 §16.5 분기에 따라 v2.0(범위 재설계)로 승격된다. 변경 이력은 문서 상단을 참조.*
