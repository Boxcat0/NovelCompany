# NovelCompany 개발 계획

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
