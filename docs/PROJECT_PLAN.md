# NovelCompany 개발 계획

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

## Phase 14 — Packaging / Production

- Windows EXE
- 설치 및 업데이트
- PC② 독립 실행
- 백업 및 복구
