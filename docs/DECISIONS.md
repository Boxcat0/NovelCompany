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

**상태:** 채택됨, Schema v1 로컬 구현됨

프로젝트, 에피소드, 캐릭터, Canon 등 구조화된 애플리케이션 데이터는 SQLite에 로컬로 저장한다. Schema v1은 `node:sqlite`와 migration으로 초기화하며, Work/Episode Repository, IPC Bridge와 읽기 전용 작품 UI를 현재 구현한다. 쓰기 UI·Canon Repository는 이후 단계에서 구현한다.

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

## Decision 012 — SQLite Schema v1은 `node:sqlite`와 순차 migration으로 관리한다

**상태:** 채택됨, 구현됨

Electron Main Process만 `C:\NovelCompanyData\novelcompany.db`를 열고, 외부 의존성 없이 Node 내장 `node:sqlite`를 사용한다. `schema_migrations`가 적용된 migration을 기록하며 migration과 기록은 하나의 transaction으로 처리한다.

Schema v1은 구조화된 Work/Episode metadata와 Canon 기반 관계를 보관한다. TXT는 계속 소설 원문의 Source of Truth이고, Canon 참조 관계의 기본 삭제 정책은 `ON DELETE RESTRICT`다.

## Decision 013 — Work와 Episode SQL은 Main Process Repository로 제한한다

**상태:** 채택됨, 구현됨

Work Repository와 Episode Repository는 기존 SQLite 연결을 재사용하고, SQL 결과를 `snake_case`에서 애플리케이션용 `camelCase`로 변환한다. Repository가 UUID와 UTC 시간을 생성하며, 대표적 입력·제약 오류는 사용자용 한국어 메시지로 제공한다.

Episode Repository는 TXT 본문을 읽거나 쓰지 않는다. Work/Episode 삭제, 쓰기 UI 및 Canon Repository는 아직 구현하지 않는다.

## Decision 014 — Renderer는 제한된 Preload IPC Bridge로만 Main 기능을 호출한다

**상태:** 채택됨, 구현됨

Preload는 `window.novelCompany`의 Work/Episode API만 공개하며 `ipcRenderer`, Node.js, SQLite, 파일 시스템, Repository 객체는 노출하지 않는다. IPC 응답은 성공 data 또는 `code`와 한국어 `message`를 가진 실패 Result로 통일한다.

Main Process는 원본 오류와 stack을 Renderer에 보내지 않고 사용자 데이터 폴더의 로그 파일에만 기록한다. Canon IPC와 쓰기 UI는 아직 구현하지 않는다.

## Decision 015 — Episode TXT Viewer는 Episode ID 기반 읽기 전용 경로를 사용한다

**상태:** 채택됨, 구현됨

WorksScreen은 실제 SQLite Work/Episode metadata를 조회하고 화면 내부 상태로 목록과 Viewer를 전환한다. Renderer는 `episodes.readContent(episodeId)`만 호출하며 절대경로나 논리 `storageKey`를 파일 읽기 입력으로 전달하지 않는다.

Main Process가 Episode Repository에서 `storageKey`를 얻어 `LocalEpisodeStorage`로 UTF-8 TXT를 읽는다. Viewer는 줄바꿈을 보존하는 읽기 전용 화면이며 생성·수정·삭제·저장 기능은 구현하지 않는다.

## Decision 016 — Runtime Preload는 sandbox 호환 self-contained script로 유지한다

**상태:** 채택됨, 구현됨

Electron sandboxed preload는 Electron이 제공하는 `electron` 모듈만 require하고, 프로젝트 내부 CommonJS 모듈에는 의존하지 않는다. 작은 규모에서는 IPC channel 문자열을 runtime preload에 명시해 별도 preload bundler를 도입하지 않는다.

`contextIsolation: true`와 `nodeIntegration: false`를 유지하며 sandbox를 비활성화하지 않는다. Renderer에는 `window.novelCompany`의 허용된 Work/Episode 메서드만 공개하고 `ipcRenderer`, Node.js API, SQLite 및 파일 경로 기반 접근은 공개하지 않는다.

## Decision 018 — Generic Canon definition과 실제 Canon record를 분리한다

**상태:** 채택됨 · Task016 구현

고정된 legacy Canon 테이블을 수정하거나 대체하지 않는다. Migration 003은 canon_sets, canon_fields, canon_field_options로 사용자 정의 입력 스키마를, canon_records 및 value/reference 테이블로 향후 값을 저장할 공간을 분리한다. 모든 Generic Canon FK는 CanonSpace 범위를 함께 확인한다.

초기 템플릿은 definition만 제공하고 CanonRecord를 만들지 않는다. 실제 캐릭터·세계 등 Canon record 작성은 작가 승인 흐름이 설계된 이후에 추가한다. 따라서 이번 단계의 컨셉정리는 읽기 전용 탐색 UI이며 CRUD나 AI가 Canon을 변경할 수 없다.

## Decision 019 — 초기 Canon setup은 명시적이고 idempotent한 관리 작업이다

**상태:** 채택됨 · Task016 구현

초기 작품과 MODERN_FANTASY_V1 definition은 앱 기동 경로에서 seed하지 않는다. npm run setup:initial-canon 명령만 실행하며, production DB는 변경 전 C:\NovelCompanyData\backups에 SQLite backup을 생성한다. 정의가 완전히 일치하면 재사용하고, 일부만 존재하거나 정의가 다르면 자동 merge/repair 없이 한국어 오류로 중단한다. 생성은 하나의 SQLite transaction으로 처리한다.

## Decision 017 — Canon은 Work별 독립 CanonSpace에 격리한다

**상태:** 채택됨, DB Foundation 구현됨

Canon의 기본 관계는 `Work 1 : 0..1 CanonSpace`이며, CanonSpace는 Work가 생성된 직후에는 없을 수 있다. 한 Work에는 현재 하나의 CanonSpace만 두고, World·Location·Organization·Character·Attribute·Skill·Authority·Servant·Passive·Contract·CharacterRelationship 등의 Canon Entity를 그 공간에 귀속한다.

서로 다른 Work의 CanonSpace는 Canon Entity를 직접 참조하거나 공유하지 않는다. Shared Universe, Canon 공유·상속·Fork·Template은 실제 요구가 생길 때 별도 결정한다. 초기 등록 정책은 작가 직접 CRUD이며, 미래의 Manager 또는 AI는 Canon을 직접 수정하지 않고 변경 제안과 작가 승인 흐름을 따른다.

Migration 002는 `canon_spaces` table과 `MODERN_FANTASY_V1` template 제약을 추가했다. 모든 Canon Entity와 Character 연결 테이블은 `canon_space_id`를 필수로 가지며, 복합 Foreign Key가 서로 다른 CanonSpace 간 참조를 DB 수준에서 차단한다. 기존 Canon 데이터가 있는 001 DB는 소유 Work를 자동 추론하지 않고 migration 전체를 rollback한다.

Canon Repository·IPC·CRUD, 컨셉정리 Sidebar와 Manager·AI Canon 기능은 구현하지 않는다. Schema 확장은 계속 기존 `001_initial_schema.sql`을 변경하지 않고 신규 migration으로 진행한다.
