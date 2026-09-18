# NovelCompany 아키텍처 결정 기록

이 문서는 현재까지 확정된 기술 및 설계 결정을 ADR(Architecture Decision Record) 형식으로 기록한다. 구현 상태와 결정 자체는 구분한다.

## Decision 001 — Electron을 Windows Desktop 기반으로 사용한다

**상태:** 채택됨

NovelCompany의 데스크톱 실행 환경으로 Electron을 사용한다.

**이유:**

- TypeScript와 React를 쉽게 통합할 수 있다.
- Codex 기반 개발 흐름에 적합하다.
- 초기 개발 복잡도를 낮춘다.

## Decision 002 — React를 UI 기반으로 사용한다

**상태:** 채택됨

사용자 화면, 화면 전환, 일반적인 애플리케이션 UI는 React로 구성한다.

## Decision 003 — Phaser는 Pixel Office 전용 UI 및 게임 화면에 사용한다

**상태:** 채택됨, 미구현

React는 일반 애플리케이션 UI를 담당하고, Phaser는 향후 Pixel Office의 직원 캐릭터, 공간, 이동 및 작업 표현을 담당한다. 두 도구의 역할을 분리한다.

## Decision 004 — SQLite를 로컬 데이터 저장소로 사용한다

**상태:** 채택됨, 미구현

프로젝트, 에피소드, 캐릭터, Canon 등 애플리케이션 데이터는 향후 SQLite에 로컬로 저장한다. 현재 단계에는 SQLite를 구현하지 않는다.

## Decision 005 — AI Provider Abstraction을 사용한다

**상태:** 채택됨, 미구현

OpenAI와 Gemini에 애플리케이션 코드가 직접 강결합하지 않도록 AI Provider Abstraction을 둔다. 공급자 전환, 상태, 사용량과 비용 추적은 이 계층을 중심으로 설계한다.

## Decision 006 — Agent와 Character를 분리한다

**상태:** 채택됨, 미구현

Agent는 실제 AI 작업을 수행하고, Character는 그 결과를 사용자에게 표현하고 전달한다. 캐릭터마다 AI API 연결을 별도로 만들지 않는다.

## Decision 007 — Canon은 사용자 승인 없이 변경하지 않는다

**상태:** 채택됨, 미구현

Canon은 확정된 작품 설정이다. AI 제안은 가능하지만 Canon 반영에는 반드시 사용자 승인이 필요하다.

## Decision 008 — 외부 AI 캐릭터의 복제를 핵심 기능으로 만들지 않는다

**상태:** 채택됨

원작 캐릭터의 이름, 대사, 이미지 등을 그대로 재현하는 구조를 피한다. 사용자 소유 캐릭터 또는 독창적인 캐릭터를 사용한다.

## Decision 009 — Naver Publishing은 향후 Adapter 방식으로 구현한다

**상태:** 채택됨, 미구현

Naver Publishing 연동은 향후 Publishing Adapter로 분리한다. 현재 단계에는 구현하지 않는다.

## Decision 010 — Discord는 Notification Layer로 분리한다

**상태:** 채택됨, 미구현

Discord 연동은 핵심 Workflow와 분리된 Notification Layer로 구현한다. 현재 단계에는 구현하지 않는다.

## Decision 011 — Episode 본문은 교체 가능한 Storage를 통해 로컬 TXT 파일로 관리한다

**상태:** 채택됨, 로컬 구현됨

Episode 메타데이터와 소설 본문을 분리한다. 본문 TXT 파일은 Source of Truth이며 기본 사용자 데이터 경로는 `C:\NovelCompanyData`이다. `EpisodeStorage`는 저장, 읽기, 존재 확인과 필요한 디렉터리 준비를 담당하고, 현재 `LocalEpisodeStorage`가 이를 구현한다.

Renderer는 파일 시스템 API를 직접 사용하지 않는다. 향후 클라우드 저장소가 필요해지면 같은 Storage 계약을 구현하는 `CloudEpisodeStorage`로 교체한다. 현재 PC 간 동기화와 충돌 해결은 구현하지 않는다.
