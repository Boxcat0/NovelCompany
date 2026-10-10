# NovelCompany 개발 계획

## Task030 — Rule-based Canon Review V1

RULE_V1과 CHARACTER_SKILL_ATTRIBUTE_MISMATCH_V1 규칙을 추가했다. 실제 Generic Canon의 Character.skills/attributes 및 Skill.required_attribute를 Record ID로 비교하며 완전한 목록과 선택된 Record를 확인할 수 있는 관계만 검사한다. 누락·부분 데이터·Legacy 미설정은 판단을 건너뛰고 중복 관계는 한 번만 보고한다. 결과는 기존 V1 계약의 CANON/WARNING/DETERMINISTIC 근거이며 실제 Skill 사용자나 작품 오류를 확정하지 않는다.

STUB_V1 기본값과 기존 Queue를 유지하고 명시적 RULE 선택을 Main에서 검증한다. Migration 014는 백업 후 Job의 Processor 선택을 영속·불변으로 저장한다. 기존 Run/Finding/hash, Alias/POV/ownership, FIFO·Episode Lock 및 실패 원자성을 보존한다. WorksScreen에서 방식 선택과 제한된 검사 범위·근거를 표시한다. `test:rule-review`는 격리 DB에서 규칙·누락·오탐·계약·순서·IPC·Queue·실패·재시작·migration·Legacy를, `test:work-ui`는 sandbox에서 선택·실제 Finding·0건 문구·dirty·지연 응답·이력 snapshot을 확인한다.

향후 AI Review는 문맥상 사용자 추론과 속성 관계 판단을 분리하고 예외 설정을 검토해야 한다. 실제 AI 호출, 자동 Speaker/사용자 추론, Finding 승인·기각 및 TXT/Canon 자동 수정은 구현하지 않는다.

## Task029 — Review Findings Contract V1 & Isolated Mock Processor

버전 결과 계약, 독립 Severity/Assessment, TEXT_RANGE/CANON_RECORD, 실행 Context 기준 전체 검증, 최소 Canon/명칭 후보/소속 snapshot과 불변 근거 저장을 구현했다. Migration 013은 백업 후 기존 review_findings를 확장하며 Legacy와 기존 입력 fingerprint를 보존한다. Findings·Run·Job의 원자 완료 및 실패·복구 정책을 유지한다.

운영 기본은 빈 결과의 STUB_V1이며 실제 원고 검토를 수행하지 않았다고 안내한다. MOCK_V1은 테스트 Main의 가상 fixture 전용으로 패키징에서 제외한다. WorksScreen의 결과 상세는 안전한 텍스트로 당시 근거와 후보를 표시하고 회차 전환의 지연 응답을 폐기한다. `test:review-findings`는 계약·범위·Canon 역할·저장 실패·FIFO·잠금·재시작·이력 불변성·migration 백업/Legacy를, `test:work-ui`는 sandbox에서 표시·HTML 안전성·Mock IPC 선택 거부·race·과거 근거를 검증한다.

Processor Adapter는 Context만 입력받아 V1 Draft를 반환하고 같은 검증과 transaction을 사용해야 한다. 규칙 Processor는 Task030에서 추가한다. 문맥상 실제 사용자/화자 추론과 속성 적합성은 별도 판단 단계이며 Canon 사실로 자동 저장하지 않는다. 실제 AI 호출, Finding 승인·기각, TXT/Canon 자동 수정은 구현하지 않는다.

## Task028 — Character Alias Management & Name Resolution

저장된 Character의 선택적 Alias CRUD, Character별 NFC 중복 방지, 다른 Character의 동일 별칭 허용을 구현했다. Work/CanonSpace/character 범위 검증과 cascade 삭제를 적용한다. 기존 Dynamic Form을 유지하고 별칭 작업으로 Character draft가 사라지지 않게 하며 Character/Work 전환의 지연 응답을 폐기한다.

정식 이름/등록 Alias의 결정적 후보 탐지, 긴 명칭 우선과 조사 경계, 원문 UTF-16 범위, AMBIGUOUS 후보 전체와 실제 Organization 참조를 ReviewContext/Preview에 제공한다. 등록 후보가 하나여도 실제 발화 대상 판정으로 표시하지 않는다. Scene Parser/Narration과 Skill ownership의 기존 의미는 유지한다.

Selector V3와 CHARACTER_NAMES_V1을 신규 Canon 해시에 반영하고 과거 V1/V2 이름 탐지 경로를 재현한다. Episode에 영향 없는 Alias 변경은 stale을 만들지 않는다. Canon Alias 편집은 Episode 잠금과 독립적이며 Worker는 제출 입력을 재검증한다. `test:canon-alias`는 임시 DB/Storage에서 CRUD·scope·해석·소속·hash·Legacy·Queue·삭제·migration 백업/실패/보존을 검사한다. `test:work-ui`는 실제 sandbox Renderer에서 Alias CRUD·중복 정책·draft 보존·Character/Work race·모호성 Preview와 STUB_V1을 검증한다.

Speaker/실제 지시 대상/Skill 사용자의 문맥 추론과 Organization·관계·Scene 정보를 활용한 판정은 향후 AI 통합 단계다. 이번 Task는 외부 AI 호출과 추측의 Canon 자동 저장을 구현하지 않는다.

## Task027 — Scene Narration Metadata & POV Management

작가가 저장된 장면별로 특정 인물 1인칭, 외부 3인칭, 미확정을 지정한다. 동일 Work Character ID만 연결하며 UNKNOWN 상태도 검토 제출을 허용한다. 미저장 원고 및 QUEUED/RUNNING 회차에서는 시점 편집을 막는다. 원고/파서 버전 변경 시 기존 Metadata를 보존하되 자동 재연결하지 않고 재확인 안내를 표시한다.

Migration 011, Scene API/UI, ReviewContext DTO, 독립 scene fingerprint와 Job/Run freshness를 연결했다. Character/Canon 삭제 시 참조를 UNKNOWN으로 무효화한다. 기존 Ownership Validation과 Relevant Canon 선택은 유지한다. AI 호출과 자동 화자 추론은 구현하지 않는다.

검증 명령 `npm run test:scene-narration`은 격리 임시 DB/Storage에서 모드·참조 범위·재시작·버전 안전성·ownership 회귀·fingerprint·freshness·잠금 경합·Queue 입력 비교·Canon lifecycle·migration 백업 및 기존 Run/Job 보존을 확인한다. 기존 DB/Repository/IPC/Context/Review/Queue/UI 검증도 유지한다. Electron UI 검증에 dirty POV 차단, 시점 저장, QUEUED 편집 차단과 지연 응답 폐기를 포함한다.

후속 후보는 실제 AI Reviewer가 작가 지정 POV를 보조 근거로 사용하는 과정, 대사 화자/능력 사용자 추론과 확실성 관리, 추론 후 Character.attributes와 Skill.required_attribute 비교다. 추론을 Canon 사실로 저장하거나 Narrator만으로 사용자를 확정하지 않는다.

## Task026 — Review Submission & Persistent FIFO Queue

- ReviewJob 영속 접수, 순번 기반 FIFO, 전역 단일 RUNNING, ReviewRun 원자적 연결·종료.
- QUEUED/RUNNING Episode의 TXT·metadata 수정 잠금, QUEUED 철회·재제출, 저장·제출 경합 방지.
- 제출 V2 fingerprint 재확인, 변경 시 RESUBMIT_REQUIRED, 재시작 중단 작업 실패 복구와 대기열 재개.
- WorksScreen의 제출·상태·대기열, 격리 DB/IPC/Electron UI 회귀 검증.
- 실제 AI Reviewer, 비용 처리, 재시도 정책과 외부 편집기의 OS 파일 잠금은 후속 범위.

## Task025-HF01 — Skill Canon Required Attribute

- Generic Skill의 단일 필수 Attribute 참조, 기존 미설정 Skill 보호 및 보완 UI.
- 008 Definition 확장과 009 Review fingerprint 버전, 기존 DB 대상 확인·백업·재검증.
- ReviewContext V2에 선택 Skill의 필요 속성 포함. 관련 변경만 신규 Review freshness에 반영.
- 격리 DB와 Electron UI에서 생성/수정/교차 작품 차단·기존 이력 호환 검증.
- Scene 전체 문맥으로 Skill 사용자를 추론하고 Character.attributes 적합성을 판정하는 작업은 후속 AI Reviewer 범위다.

## Task025 — Scene-aware Relevant Canon Selector + ReviewContext V1

- 원고 기호 및 Scene parser, UTF-16 원문 범위와 경고 보존.
- Generic Canon 직접 탐지, Character 참조 및 Authority/Servant 역참조, 관계/계약 1-hop 선택.
- Skill/Passive Canon 분류 및 명시 단일 주체의 보유 참조 검증; UNKNOWN/AMBIGUOUS/불일치 후보 보존.
- 읽기 전용 ReviewContext Preview, dirty 차단, 이전 회차 응답 폐기.
- STUB_V1 입력 연결, migration 007의 FULL/RELEVANT 모드 분리와 과거 이력 보존.
- test:review-context 및 기존 격리 DB/IPC/Electron UI 검증.
- 실제 AI, 화자 지정 CRUD, 별명/대명사 추론, 권능 좌우 매핑 규칙은 후속 작업.

## 현재 Canon 개발 순서

- Task018: Work Management CRUD 및 안전한 작품 삭제 — COMPLETE.
- Task019: Canon 시작 및 빈 CanonSpace 생성 — COMPLETE.
- Task020: Canon Lifecycle Completion — 삭제 영향 조회, Canon 전체 transaction 삭제, Work 삭제 상태 복원 — COMPLETE.
- Task021: Episode CRUD + TXT Editing, 빈 번호 재사용 및 DB/TXT 실패 보상 — COMPLETE.
- Task022: Current Work Canon Authoring UX + Dependency / Readiness Refinement, Character 최소 확정조건, 기존 정의의 명시적 복구 — COMPLETE.
- CanonSet / CanonField CRUD: 시스템 핵심 Flow 안정화 이후.
- 다른 Work의 Canon 틀 복사: CanonSet / CanonField CRUD 이후.
- AI Manager / AI Review·Editing: 핵심 Canon/작품 Flow 안정화 이후.

각 Phase는 작은 작업으로 나누어 순차적으로 구현한다. `완료`로 표시된 항목 외의 기능은 계획이며, 아직 구현된 기능이 아니다.

## Phase 0 — 개발환경 구성

- VS Code
- Codex
- Node.js
- Git

**상태: 완료**

## Phase 1 — 최소 Desktop Shell

- Electron
- React
- TypeScript

**상태: 완료**

## Phase 2 — 기본 애플리케이션 구조

- React 화면 구조
- Navigation
- 기본 Layout
- 설정 화면의 기본 구조
- 상태 관리 기반

## Phase 3 — Local Data

- SQLite
- Project
- Episode
- Character
- Canon
- Company
- Task

## Phase 4 — Workflow Engine

- Episode workflow
- Task state
- Approval
- Error
- `WAITING_RESOURCE`

## Phase 5 — AI Provider Layer

- OpenAI
- Gemini
- API key 설정
- usage tracking
- 비용 추적
- provider 상태

## Phase 6 — Department Agents

- Manager
- Proofreading
- Editing
- Illustration
- Publishing

## Phase 7 — Canon / Memory

- Character
- Skill
- World
- Organization
- Item
- Location
- Timeline
- Episode Memory
- Meeting Memory

## Phase 8 — Pixel Office

- Phaser
- 직원 캐릭터
- 책상
- 이동
- 작업 애니메이션
- 회의실
- `!` 알림
- `✓` 완료
- `WAITING_RESOURCE` 표현

## Phase 9 — AI Communication

- 부서 간 메시지
- AI Meeting
- 회의록
- 최대 5 round
- 사용자 승인

## Phase 10 — Illustration Workflow

- 구성안
- 사용자 승인
- 러프
- 사용자 승인
- 최종 이미지

## Phase 11 — Publishing

- Naver Publishing Adapter
- 수동 로그인
- CAPTCHA 또는 추가 인증 시 사용자 개입
- 최종 발행 사용자 승인

## Phase 12 — Notification

- NotificationService
- Discord
- 중요한 이벤트만 전송

## Phase 13 — Employee Expansion

- 부서장 채용 요청
- 후보 생성
- 사용자 승인
- Character DB 등록
- Pixel Office 배치

## Task024 — Review Pipeline Foundation + Stub Processor

- migration 006: `review_runs`, `review_findings`, source hash 및 immutable history
- WorkContext를 유일한 Review 입력으로 사용하는 Main-side Review Service
- RUNNING / COMPLETED / FAILED lifecycle, duplicate RUNNING 차단, transaction completion
- `STUB_V1` processor와 Review history/freshness 최소 UI
- 실제 AI 검토, diff/승인, 원고 또는 Canon 자동 변경은 후속 범위

## Task023 — Episode + Canon Read-only Work Context Builder

- 저장된 Episode TXT와 Generic Canon을 Main Process에서 WorkContext로 조합
- FULL_CANON read-only DTO, Option/Reference resolution, Context Preview
- Review Pipeline Foundation으로 연결 예정
- Review 결과/승인 UX, AI Provider와 실제 AI 호출은 후속 범위

## Phase 14 — Packaging / Production

- Windows EXE
- 설치 및 업데이트
- PC② 독립 실행
- 백업 및 복구
