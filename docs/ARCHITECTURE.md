# NovelCompany 아키텍처

## 문서 범위

이 문서는 현재 확정된 시스템 방향과 설계 원칙을 기록한다. 향후 확장 항목은 계획이며, 현재 구현되었다는 뜻이 아니다.

## 실행 환경

NovelCompany는 개발 환경과 실제 사용 환경을 분리한다.

### PC①: 개발 PC

- VS Code와 Codex를 사용한다.
- 소스 코드를 관리한다.
- 빌드와 테스트를 수행한다.

### PC②: 실제 사용 PC

- 완성된 Windows EXE를 실행한다.
- AI 호출, SQLite, 로컬 파일, Pixel Office, Workflow를 실행한다.

PC②는 PC①이 꺼져 있어도 독립적으로 동작해야 한다. PC①은 개발과 배포를 위한 환경이며, PC②의 실행을 위한 서버가 아니다.

## 기본 기술

- Windows Desktop
- Electron
- React
- TypeScript
- Phaser
- SQLite
- Local File Storage

현재 구현 단계에는 Electron, React, TypeScript 기반의 Desktop Shell과 `node:sqlite` 기반 Schema v1 초기화가 있다. Phaser와 AI·Workflow 기능은 아직 구현하지 않는다.

## 전체 구조 개념

```text
Electron
  → React UI
  → Workflow Engine
  → Department Agents
  → AI Provider Layer
  → OpenAI / Gemini

Workflow Engine
  → Canon / Episode / Meeting / Company Memory
  → SQLite
```

React UI는 사용자와 시스템의 접점이고, Workflow Engine은 작업의 상태와 순서를 조정한다. AI Provider Layer는 AI 공급자별 차이를 분리한다. Schema v1의 구조화된 로컬 데이터는 SQLite에 저장하며, Memory와 Workflow 등의 기능 데이터는 향후 확장한다.

## Episode 본문 저장소

Episode의 제목, 회차 번호, 상태 같은 논리 메타데이터와 소설 본문은 분리한다. 본문 TXT 파일이 소설 본문의 Source of Truth이며, `Episode.workId`와 `Episode.episodeNumber`로 파일을 식별한다.

프로그램 설치 폴더와 사용자 데이터 폴더도 분리한다. 초기 로컬 저장소의 기본 경로는 `C:\NovelCompanyData`이며, 실제 파일 구조는 다음과 같다.

```text
C:\NovelCompanyData
└─ works
   └─ {workId}
      └─ episodes
         └─ {episodeNumber를 세 자리로 채운 값}.txt
```

파일 접근은 Electron Main Process의 `EpisodeStorage` 계약을 통해서만 수행한다. 현재 `LocalEpisodeStorage`가 로컬 TXT 파일을 담당하며, Renderer는 Node.js 파일 시스템 API에 접근하지 않는다. 향후 `CloudEpisodeStorage`가 같은 계약을 구현하면 클라우드 저장소로 교체할 수 있다.

현재 각 PC는 자체 `C:\NovelCompanyData`를 사용하며 PC1과 PC2 사이의 자동 동기화, 충돌 해결, 버전 관리는 지원하지 않는다.

## SQLite 접근 계층

SQLite SQL은 Electron Main Process의 Repository 계층에만 둔다. 현재 Work Repository와 Episode Repository가 기존 단일 DB 연결을 재사용하며, DB의 `snake_case` 행을 애플리케이션의 `camelCase` 객체로 변환한다. Episode Repository는 metadata만 다루고 TXT 본문은 계속 `LocalEpisodeStorage`의 책임이다.

Repository는 UUID와 UTC ISO-8601 시간을 생성하고, 대표적인 입력·제약 오류를 사용자용 한국어 메시지로 변환한다. 삭제 정책, 쓰기 UI 및 Canon Repository는 이후 단계에서 결정한다.

## Renderer Application Bridge

Renderer는 Node.js, SQLite, 파일 시스템 또는 Repository 객체에 직접 접근하지 않는다. Electron sandboxed preload는 로컬 프로젝트 모듈을 require하지 않는 self-contained script로 유지하며, `window.novelCompany` namespace의 Work/Episode 메서드만 공개한다. IPC Handler가 Main Process Repository로 요청을 전달한다.

IPC는 항상 `{ ok: true, data }` 또는 `{ ok: false, error: { code, message } }` Result를 반환한다. 원본 cause와 stack은 Renderer로 전달하지 않고 `C:\NovelCompanyData\logs\novelcompany.log`에 개발자용으로만 기록한다.

WorksScreen은 이 Bridge를 통해 실제 Work와 Episode metadata를 읽는다. TXT 본문은 Episode ID만 Main Process에 전달한 뒤, Main이 Repository의 논리 `storageKey`를 `LocalEpisodeStorage`로 해석해 읽는다. Renderer에는 경로나 `storageKey` 기반 파일 읽기 권한을 제공하지 않으며 Viewer는 읽기 전용이다.

## Episode Viewer 탐색

작품 탐색은 `작품 목록 → Episode 목록 → Viewer`의 단계형 흐름을 유지한다. Viewer에 진입한 뒤에는 이미 조회한 현재 작품의 Episode 목록을 보조 탐색 영역으로 함께 표시하고, 선택한 Episode의 TXT 원고를 넓은 읽기 전용 영역에 표시한다.

Viewer에서 다른 Episode를 선택하면 Episode 목록을 다시 조회하지 않고 `episodes.readContent(episodeId)`만 호출한다. 원고를 읽는 동안과 읽기 오류가 난 경우에도 Episode 목록은 유지한다. 최신 선택 요청의 응답만 표시해 빠른 선택으로 이전 원고가 덮어쓰지 않도록 한다.

## 향후 CanonSpace 경계

Canon은 전역 공유 데이터가 아니라 작품별 독립 공간으로 설계한다.

```text
Work 1 : 0..1 CanonSpace
Work
  └─ CanonSpace
      └─ Canon Entities
```

CanonSpace는 World, Location, Organization, Character, Attribute, Skill, Authority, Servant, Passive, Contract, CharacterRelationship 등의 Canon Entity를 담는다. 서로 다른 Work의 CanonSpace는 Entity를 직접 참조하거나 공유하지 않는다. Shared Universe, Canon 상속·Fork·Template은 현재 범위 밖이다.

`canon_spaces` table과 CanonSpace-aware Schema migration은 구현되었다. 모든 Modern Fantasy Canon Entity는 `canon_space_id`로 Work에 간접 귀속되고, 복합 Foreign Key로 서로 다른 CanonSpace 간 참조를 차단한다. 현재 지원 template은 `MODERN_FANTASY_V1` 하나다.

Canon Repository, IPC, CRUD UI는 아직 구현하지 않는다. 향후 컨셉정리 화면은 Work 선택 후 CanonSpace가 없으면 작가가 시작하고, 있으면 관리 화면으로 진입하는 흐름을 따른다. 초기 Canon 등록·조회·수정·삭제의 주체는 작가이며, Manager 또는 AI는 변경 제안과 작가 승인 이후의 반영 흐름으로만 확장한다.

## 핵심 설계 원칙

### Agent와 Character의 분리

Agent는 실제 AI 작업을 수행한다.

- 분석
- 검토
- 제안
- 결과 생성

Character는 부서의 직원 또는 캐릭터로서 Agent의 결과를 표현하고 전달한다. 대화, 보고, 행동의 주체는 Character가 될 수 있지만, Character마다 별도의 AI API 연결을 만들지 않는다.

### 부서

향후 다음 부서를 둔다.

- Manager
- Proofreading
- Editing
- Illustration
- Publishing

AI Resource Manager는 AI 리소스와 사용량을 조정하기 위한 별도 모듈로 추후 둔다.

## Canon과 Memory

### Canon

Canon은 확정된 작품 설정이다. AI는 Canon을 직접 변경하지 않으며, Canon 변경은 반드시 사용자 승인 후에만 반영한다.

### Memory 구분

다음 메모리는 목적을 섞지 않고 분리해 관리한다.

- Canon Memory
- Episode Memory
- Meeting Memory
- Company Memory

## Illustration Workflow

삽화 작업은 다음 순서를 따른다.

1. 본문 분석
2. 삽화 후보 선정
3. 텍스트 구성안 작성
4. 사용자 승인
5. 러프 생성
6. 사용자 승인
7. 최종 이미지 생성

에피소드당 삽화는 최대 1~2장으로 제한한다. 이미지 AI 리소스가 부족할 때 다른 공급자로 임의 전환하지 않는다. 이 경우 작업 상태는 `WAITING_RESOURCE` 또는 `SKIPPED`를 사용한다.

## 사용자 승인

다음 결정은 사용자 승인이 필요하다.

- Canon 변경
- Character 등록
- 삽화 구성안
- 삽화 러프
- 최종 발행

## Generic Canon Definition과 읽기 전용 경계

Task016의 canon-definition-repository.cjs는 CanonSpace, Set 목록 및 Set definition(Field, Option, reference Set)을 읽기 전용으로 조회한다. Electron Main Process의 Canon IPC handler와 sandboxed preload bridge를 통해서만 Renderer에 전달한다. Renderer의 ConceptScreen은 실제 Work 목록에서 시작해 CanonSpace → Set → Definition 순으로 조회하며 SQL, Repository, 파일 경로, 쓰기 API를 노출하지 않는다.

초기 definition 생성은 앱 시작 시 실행하지 않는다. npm run setup:initial-canon만이 명시적으로 실행하는 관리 도구이며, 실행 전 SQLite VACUUM INTO 백업을 만들고 하나의 transaction으로 Work/CanonSpace/Set/Field/Option을 생성한다. 부분 정의는 자동 병합이나 보정 없이 오류로 중단한다.

## 향후 확장

다음 항목은 확장 계획이며 현재 구현 범위에 포함하지 않는다.

- Discord Notification
- Naver Publishing Adapter
- Employee Recruitment
- AI Meetings
- Mobile
