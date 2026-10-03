# NovelCompany 아키텍처

## Task025 — Scene-aware ReviewContext

저장된 TXT → `buildEpisodeWorkContext(FULL_CANON)` → `buildReviewContext(RELEVANT_CANON_V1)` → `STUB_V1` → ReviewRun. Preview도 `buildEpisodeReviewContext`를 통해 동일 순수 builder를 사용한다. 분석은 메모리에서만 계산하고 Work/Episode/TXT 및 Canon은 쓰지 않는다. Repository에서 원고와 Canon을 중복 조합하지 않는다.

`parseNotation`은 인용 문맥을 보존하며 시스템 알림을 먼저 식별하고 독립된 줄의 대괄호를 장소 표제로 처리한다. `{권속 : 이름}` → SERVANT, 나머지 단일 콜론 → AUTHORITY, 콜론 없는 중괄호 → Skill/Passive Canon 대조 순서다. 큰따옴표는 DIALOGUE, 작은따옴표는 INNER_OR_CONTRACT_DIALOGUE다. 인용문 안 표기는 quoteContext를 보존하고 장소 전환/사용자 판정에는 쓰지 않는다. 빈/미종결/중첩 기호는 경고하며 원문은 그대로 둔다. 범위는 JavaScript UTF-16 code unit의 `[start,end)`다.

Scene은 장소 표제에서만 분리하며 알림·표제·서문·연속 표제를 포함해 원문을 누락 없이 보존한다. LF/CRLF와 한글/Unicode를 정규화하지 않는다. `그 시각`은 timeHintRaw로 보존하며 동시성을 추정하지 않는다. 미등록/동명 장소도 Scene을 분리하고 연결은 NOT_FOUND/AMBIGUOUS로 유지한다. 화자는 UNKNOWN이며 CHARACTER/EXTERNAL DTO 확장은 가능하지만 자동 추정이나 CRUD는 없다.

Canon은 11개 Generic Set의 displayName을 긴 이름 우선으로 검색하고 명시 표기 유형으로 후보 Set을 제한한다. 직접 언급은 물리적 등장을 뜻하지 않는다. 핵심 Character의 실제 7개 참조 필드(origin_world/origin_location/current_location/organization/attributes/skills/passives) 및 Authority/Servant의 owner_character 역참조를 읽는다. 관계(source_character/target_character)·계약(grantor_character/grantee_character)은 핵심 Character 한쪽만 일치해도 모두 수집한다. 핵심 집합은 확장 전에 고정하고 관계 상대는 기존 Reference identity만 제공한다. 상대 전체 Canon/관계를 재귀 수집하지 않으며 중복 Record를 제거하고 Scene별 여러 선택 이유를 보존한다.

소유 검증은 단일 Character 이름+조사+능력 표기+사용했다/발동했다/사용한다/발동한다의 제한적 서술 문장만 사용한다. 대사/내면 대화, 대명사, 단순 근접 이름은 사용자 근거로 쓰지 않는다. Skill/Passive Canon을 각각 조회해 정확히 한 후보일 때만 분류하고 실제 skills/passives recordId를 비교한다. 불일치 후보는 설정 오류 확정이 아니다. 권능 콜론의 좌우 값은 현재 Definition에 확정 매핑이 없어 유형만 판정하고 연결은 UNRESOLVED다.

`context:get-episode-review-context` → self-contained preload → WorksScreen → ReviewContextPreview. 저장되지 않은 draft는 차단하고 request sequence로 이전 회차 응답을 폐기한다. 상세는 읽기 전용 펼치기이며 편집/Canon 포함 제외 기능은 없다. 구조 분석과 빈 Stub Findings는 별개이며 실제 AI 검토 완료를 주장하지 않는다. 기존 FULL_CANON API와 Preview도 보존한다.

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

Episode의 제목, 회차 번호, 상태 같은 논리 메타데이터와 소설 본문은 분리한다. 본문 TXT 파일이 소설 본문의 Source of Truth이다. Episode의 불변 identity는 UUID이고, Main 내부 `storageKey`는 현재 번호 기반 파일 위치를 가리킨다. 번호 변경은 TXT 이동도 함께 수행한다.

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

SQLite 조회/변경 SQL은 Electron Main Process의 Repository 계층에 둔다. Task021 Main service는 DB와 파일을 조율하기 위한 BEGIN/COMMIT/ROLLBACK 경계만 소유한다. Work/Episode Repository는 기존 단일 DB 연결을 재사용하며 DB의 `snake_case` 행을 `camelCase` 객체로 변환한다. Episode Repository는 metadata만 다루고 TXT 본문은 `LocalEpisodeStorage`의 책임이다.

Repository는 UUID와 UTC ISO-8601 시간을 생성하고, 대표적인 입력·제약 오류를 사용자용 한국어 메시지로 변환한다. Work/Episode와 Canon Record의 쓰기·삭제 경계는 아래 구현 절을 따른다.

## Renderer Application Bridge

Renderer는 Node.js, SQLite, 파일 시스템 또는 Repository 객체에 직접 접근하지 않는다. Electron sandboxed preload는 로컬 프로젝트 모듈을 require하지 않는 self-contained script로 유지하며, `window.novelCompany` namespace의 Work/Episode 메서드만 공개한다. IPC Handler가 Main Process Repository로 요청을 전달한다.

IPC는 항상 `{ ok: true, data }` 또는 `{ ok: false, error: { code, message } }` Result를 반환한다. 원본 cause와 stack은 Renderer로 전달하지 않고 `C:\NovelCompanyData\logs\novelcompany.log`에 개발자용으로만 기록한다.

WorksScreen은 이 Bridge로 실제 Work/Episode metadata와 TXT를 읽고 명시적으로 편집한다. TXT 읽기는 Episode ID만 전달하고 Main이 Repository의 내부 `storageKey`를 해석한다. 공개 metadata에는 `storageKey`/`contentHash`/절대 경로가 없으며 Renderer는 파일 경로를 받거나 지정할 수 없다.

## Episode Viewer 탐색

작품 목록에서 작품을 선택하면 회차 목록과 편집 영역을 함께 표시한다. 기존 WorksScreen을 확장했으며 별도 중복 화면은 없다. 번호/제목/상태/원고를 한 폼에서 편집하고 저장 버튼 한 번으로 처리한다. 새 회차 폼은 추천 번호만 읽고 저장 전에는 DB/TXT를 생성하지 않는다.

다른 Episode 선택 시 metadata와 TXT를 함께 읽고 최신 선택 요청만 적용한다. 목록 요청도 별도 순서로 보호한다. dirty 입력은 회차/작품/새 회차/Sidebar/삭제/창 종료에서 보호하고 쓰기는 동기 ref로 중복 진입을 막는다. TXT ENOENT는 빈 폼과 복구 안내를 표시하며 dirty로 취급한다. 다른 읽기 오류에서는 저장을 막는다.

### Task021 회차 저장 orchestration

`episodes.create(input)` / `update(id, input)`의 input은 `{workId, episodeNumber, title, status?, content}`다. update도 전체 편집 값을 전달한다. `delete(id, workId)`와 `getNextAvailableNumber(workId)`를 추가했다. 읽기 API는 기존 이름을 유지한다. preload는 self-contained이고 sandbox/contextIsolation 설정은 유지한다.

`electron/episode-service.cjs`가 통합 경계를 소유한다. Repository는 metadata SQL만, LocalEpisodeStorage는 경로 검증과 파일 작업만 담당한다. 저장 흐름은 BEGIN IMMEDIATE → Work/번호 재검증 → `.tmp` UTF-8 쓰기/fsync → metadata 쓰기 → 원본 `.bak` 확보와 파일 게시 → COMMIT → 작업 파일 정리다. transaction 안에는 await가 없어 공유 DB 연결의 요청이 끼어들지 않는다. 번호 변경 없는 교체는 원본 복사 백업 후 rename, 생성/번호 이동은 hard link의 no-clobber 게시로 기존 목적 파일을 덮어쓰지 않는다. NTFS의 같은 디렉터리에서 실행하며 지원하지 않는 파일 시스템은 저장 실패로 처리한다.

삭제는 Work 소속 확인 → metadata DELETE(미commit) → TXT를 백업으로 rename → COMMIT → 백업 제거다. 없는 TXT도 metadata 삭제를 허용한다. commit 전 실패는 DB rollback 및 원본 파일 복원을 수행한다. commit 후 cleanup 실패는 완료 결과를 유지하고 Main 로그에 `EPISODE_FILE_CLEANUP_FAILED`를 남긴다. 복원 자체 실패는 `EPISODE_COMPENSATION_FAILED`를 남기고 가능한 백업을 보존한다. 이는 일반 실행 오류에 대한 보상 처리이며 SQLite와 파일 시스템을 묶는 진정한 ACID나 전원 차단/프로세스 강제 종료 복구 보장은 아니다. 자동 crash recovery는 구현하지 않았다.

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

컨셉정리 화면은 Work 선택 후 CanonSpace가 없으면 작가가 시작하고, 있으면 관리 화면으로 진입한다. Canon Record 등록·조회·수정·삭제의 주체는 작가이며, Manager 또는 AI는 변경 제안과 작가 승인 이후의 반영 흐름으로만 확장한다.

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

이 절의 읽기 전용 화면 설명은 Task016 시점의 이력이다. Task017의 현재 쓰기 경계는 아래 절을 따른다.

Task016의 canon-definition-repository.cjs는 CanonSpace, Set 목록 및 Set definition(Field, Option, reference Set)을 읽기 전용으로 조회한다. Electron Main Process의 Canon IPC handler와 sandboxed preload bridge를 통해서만 Renderer에 전달한다. Renderer의 ConceptScreen은 실제 Work 목록에서 시작해 CanonSpace → Set → Definition 순으로 조회하며 SQL, Repository, 파일 경로, 쓰기 API를 노출하지 않는다.

초기 definition 생성은 앱 시작 시 실행하지 않는다. `npm run setup:initial-canon`은 Work/CanonSpace까지 만드는 기존 관리 도구다. Task022는 이미 존재하는 현재 작품의 빈 CanonSpace 복구에 한정한 별도 명시적 Bootstrap을 추가했다. 두 경로 모두 백업 및 transaction을 사용하고 부분 정의를 자동 병합하지 않는다.

## 향후 확장

다음 항목은 확장 계획이며 현재 구현 범위에 포함하지 않는다.

- Discord Notification
- Naver Publishing Adapter
- Employee Recruitment
- AI Meetings
- Mobile

## Task017 — Generic Canon Record 관리

현재 데이터 흐름은 `CanonSet → CanonField → DynamicCanonForm → CanonRecord → Scalar / Option / Reference`다. Definition 조회 Repository와 실제 Record CRUD Repository는 분리한다. Set별 전용 폼이나 Reference fixture는 Renderer에 두지 않는다. `ConceptScreen`은 Set / Record 목록 / Dynamic Form의 3열 화면이며 좁은 창에서는 폼을 다음 행으로 배치한다. Task016 정의 탐색은 `구조 보기`로 보존한다.

Renderer는 `window.novelCompany.canon.records`의 일곱 메서드만 호출한다. Main의 `canon-record-repository.cjs`는 `{ canonSpaceId, setId }`와 Record/Field ID의 실제 소속을 다시 확인한다. 입력값은 Field ID를 키로 전달하고 DB 행 구조는 노출하지 않는다. `contextIsolation`, `sandbox`는 true, `nodeIntegration`은 false이며 runtime preload는 `electron` 외의 runtime require를 사용하지 않는다.

`getCreateReadiness`는 필수 Reference의 target Set별 실제 레코드 수를 계산한다. Optional Reference는 등록을 막지 않으며 계약/관계는 서로 다른 캐릭터를 선택할 수 있도록 최소 2개를 요구한다. `getReferenceOptions`는 실제 DB 레코드만 반환하고, 고유 패시브의 다른 소유자와 선택 금지 상태를 포함한다.

`saveRecord → withTransaction`은 BEGIN IMMEDIATE부터 입력 검증, 생성 또는 전체 값 교체, hydrate, 의미 검증, COMMIT까지 보호한다. 어느 단계든 실패하면 ROLLBACK한다. 삭제는 incoming reference를 먼저 검사하고 외부에서 사용 중인 항목을 보존한다. 오류 Result에는 code와 한국어 message만 포함하고 원본 cause는 기존 Main logger가 기록한다.

저장은 작가의 명시적 입력이다. AI 쓰기나 별도의 승인 Workflow는 구현하지 않는다. 자동 저장/샘플 seed도 없다. Work, Set, Record, 새 항목, 주 메뉴 전환 전에 미저장 변경사항의 폐기를 확인한다. 쓰기 중에는 선택과 저장을 잠그고, Task022의 Set 간 조회는 최신 요청만 반영한다.

기존 003 DB를 열면 004 적용 전에 같은 데이터 디렉터리의 `backups/before-task017-<UUID>.db`에 VACUUM INTO 백업을 만든다. 백업 실패 시 migration도 진행하지 않는다. 최초 빈 DB에는 기존 데이터가 없으므로 이 백업을 만들지 않는다.

readiness는 실제 target Record 수를 기준으로 계산한다. 고유 패시브가 모두 점유되어도 폼 진입은 가능하며 선택/저장 단계에서 점유 제한을 적용한다. 출신 지역 선택지는 현재 세계별로 필터링하지 않지만 저장 정합성은 Backend에서 강제한다.

## Task018 — 작품 관리와 안전 삭제

`WorkManagementScreen`은 실제 Work 목록과 제목/설명/상태 입력을 제공한다. 기존 `WorksScreen`은 작품/회차 탐색과 TXT Viewer 역할을 유지한다. Sidebar에서 `작품 관리`와 `작품/회차`로 구분한다. 각 화면은 진입 시 기존 `works.getAll`을 다시 조회하므로 생성/수정 결과가 다음 방문에 반영된다. 전역 상태 라이브러리는 추가하지 않는다.

생성/수정은 기존 Work Repository/IPC를 재사용한다. Work 생성은 metadata 한 행만 저장하며 CanonSpace/Definition/Episode/TXT를 자동 생성하지 않는다. 흐름은 **Work 먼저 → Canon은 별도 설정**이다. Canon 시작은 아래 Task019 경로를 사용하고 구조 편집/복사는 후속 Task다.

`getWorkDeletionStatus`는 한 SELECT 안에서 Episode 개수와 CanonSpace 존재 여부를 조회한다. Episode가 0개이고 CanonSpace가 없을 때만 삭제 가능하다. CanonRecord가 0개인 CanonSpace도 삭제를 막고, TXT가 없는 Episode metadata도 삭제를 막는다. `deleteWork`는 BEGIN IMMEDIATE 안에서 이 상태를 다시 조회하고 Work 행만 삭제한다. 파일 삭제나 CASCADE는 없다.

Renderer는 삭제 상태를 선택 직후 표시하고, 삭제 시 최신 상태 조회와 사용자 확인을 거친다. Backend가 다시 확인하므로 오래된 UI 상태로 삭제 조건을 우회할 수 없다. 실패는 기존 executeIpcAction의 code/한국어 message Result로 반환하고 원본 오류는 Main 로그에만 기록한다. runtime preload에는 getDeletionStatus/delete 두 API만 명시적으로 추가한다.

작품/새 작품/Sidebar 전환 시 미저장 입력의 폐기를 확인한다. App의 기존 Canon 이동 확인을 작품 관리에도 재사용하며, 요청 처리 중에는 화면 이동과 중복 작업을 막는다.

## Task019 — 작가의 명시적 Canon 시작

사용자 흐름은 `작품 관리 → Work 생성 → 컨셉정리 → Canon 시작 확인 → 빈 CanonSpace(Set 0개)`까지 구현되어 있다. 향후 Schema Editor에서 CanonSet/CanonField를 구성하면 기존 Dynamic Record Form으로 이어진다. 구조 편집과 다른 작품의 Canon 틀 복사는 핵심 Flow 안정화 이후 범위다. Preset이나 기존 11개 Set 자동 주입은 없다.

`ConceptScreen.handleStartCanon → canon.spaces.createForWork → preload.createCanonSpaceForWork → canon:spaces:create-for-work → registerCanonHandlers → executeIpcAction → createCanonSpaceForWork` 경로로 빈 공간 한 행만 만든다. 기존 Definition Repository가 공간 조회/생성을 함께 담당하며 Record Repository는 변경하지 않는다.

Repository는 BEGIN IMMEDIATE 안에서 Work 존재, 공간 중복을 확인하고 INSERT/COMMIT한다. 실패 시 ROLLBACK하며 UNIQUE(work_id)가 최종 중복 방어선이다. 성공 후 `loadCanonForWork`가 공간/Set/readiness를 다시 조회한다. 공간이 없을 때만 시작 버튼을 표시하고 공간이 있지만 Set이 0개이면 정상 빈 상태를 표시한다. 조회 실패를 공간 없음으로 취급하지 않는다. `runAction`은 ref 잠금과 App에 동기 busy 알림으로 중복 클릭/이동을 차단한다.

작품 관리 재진입 후 작품 선택 시 `handleSelectWork → getDeletionStatus`가 공간 존재를 다시 읽어 삭제를 비활성화한다. 두 화면의 IPC는 Main의 동일한 `getDatabase()` 연결을 사용한다. Main은 `initializeDatabase()`의 기본 경로인 `getDatabaseFilePath()`를 사용하며 환경 변수 `NOVEL_COMPANY_DATA_DIR`가 없으면 `C:\NovelCompanyData\novelcompany.db`를 연다.

## Task020 — Canon lifecycle과 명시적 전체 삭제

현재 lifecycle은 `Work → Canon 시작 → CanonSpace/Canon 데이터 → Canon 전체 삭제 → CanonSpace 없음 → 다시 Canon 시작`이다. CanonSpace 자체에 편집할 의미 있는 metadata가 없어 별도 Update UX를 만들지 않는다. 내용 편집은 기존 Record CRUD가 담당한다.

ConceptScreen의 별도 Canon 관리 영역에서 `handleDeleteCanon`이 `canLeave`로 dirty 입력 폐기를 확인한 뒤 `canon.spaces.getDeletionStatus(workId)`를 호출한다. 빈 공간도 한 번 확인하며, 의존 행이 하나라도 있으면 영향 요약과 복구 불가 최종 확인을 모두 거친다. 영향 집계는 화면 진입 시 자동 실행하지 않는다. `runAction/requestPending`이 이 과정의 중복 요청과 이동을 차단한다.

`getCanonDeletionStatus`는 기존 Definition Repository에서 한 SELECT로 Work 존재, CanonSpace ID, Generic 7개 테이블과 Legacy 14개 테이블 개수를 읽는다. 실제 삭제 API `canon.spaces.deleteForWork → preload.deleteCanonForWork → canon:spaces:delete-for-work → registerCanonHandlers → executeIpcAction → deleteCanonForWork`는 BEGIN IMMEDIATE 안에서 같은 조회를 다시 수행한다. 조회 이후 추가된 데이터도 최신 CanonSpace 범위에서 삭제한다.

`deleteGenericCanonData`는 reference/option value/scalar value → Record → Field Option → Field → Set 순서, `deleteLegacyCanonData`는 junction/관계/계약/권속/권능 → Character → Organization → Location → World 및 독립 Attribute/Skill/Passive 순서로 삭제한다. 마지막으로 공간을 제거하고 COMMIT한다. 모든 하위 DELETE는 canon_space_id로 제한한다. 실패 시 전체 ROLLBACK하며 FK는 계속 ON, RESTRICT는 유지한다.

성공 후 `loadCanonForWork → resetCanonEditor`가 이전 선택/폼/참조 상태를 비우고 현재 Work를 다시 조회한다. Canon 없음과 시작 버튼을 복원한다. Work 삭제와 Canon 삭제는 별도 동작이다. Work/Episode/TXT/다른 파일과 다른 작품의 Canon은 보존한다. 작품 관리 재진입 후 `handleSelectWork → getWorkDeletionStatus`에서 hasCanonSpace=false가 반영되며 Episode 0일 때만 Work 삭제가 다시 가능하다.

## Task024 — Review Pipeline Foundation

`Review Service → buildEpisodeWorkContext → source fingerprint → ReviewRun → Stub Review Processor → ReviewResult → Review Repository` 경로를 사용한다. Review는 TXT와 Canon의 derived read-only 작업 기록이며 원본 TXT, Episode metadata, Canon definition/record를 수정하지 않는다.

Renderer는 `reviews.start`, `reviews.getByEpisode`, `reviews.getById`만 preload bridge로 호출한다. source hash 및 freshness 계산은 Main service가 수행하며, Renderer에는 경로·storageKey·raw error·SQL row를 노출하지 않는다. Stub processor는 `STUB_V1` metadata와 빈 findings만 반환하며 실제 AI 또는 문장/Canon 판정을 수행하지 않는다.

## Task023 — Episode + Canon Read-only Work Context Builder

Task023은 Renderer가 TXT, Episode metadata, Canon API를 여러 번 조합하지 않도록 Main Process에 Context Builder를 둔다.

context:get-episode-work-context는 저장된 TXT와 같은 Work의 CanonSpace만 읽어 FULL_CANON DTO를 만든다. Builder는 Repository와 EpisodeStorage만 사용하며 직접 SQL, DB write, storage write, context persistence를 수행하지 않는다. Reference는 recordId/setKey/displayName으로, Option은 key/label로 해석한다. Renderer에는 storageKey, 파일 경로, SQL row, DB 객체를 노출하지 않는다.

WorksScreen의 Context Preview는 저장되지 않은 draft가 있으면 요청을 차단하고, 최신 request sequence와 busy guard만 반영한다. Preview는 DB/TXT Source of Truth를 수정하지 않으며 Review, Canon 충돌 판정, Prompt, AI Provider 호출은 포함하지 않는다.

## Task022 — 현재 작품 Canon 작성과 명시적 Definition 복구

작성 흐름은 `기초 설정 → 공간/집단 → 캐릭터 → 인물 확장`이다. ConceptScreen은 DB Set key를 안내 그룹에만 배치한다. Field/Reference/Option 정의와 실제 선택지를 Renderer에 복제하지 않는다. `Definition → getCreateReadiness → DynamicCanonForm → CanonRecord CRUD`를 재사용하며 구조 보기도 유지한다.

세계/속성/패시브/스킬은 기초 설정, 지역/조직은 공간·집단, 캐릭터는 인물, 권능/권속/계약/관계는 인물 확장이다. 다른 Set은 기타 설정에 표시한다. 준비 상태와 부족 개수는 Main readiness API가 반환한다. Character 시작에는 지역·속성·패시브 각 1개만 필요하고 스킬/조직은 0개여도 된다. 권능/권속은 캐릭터 1명, 계약/관계는 2명이 필요하다. 준비 상태와 실제 선택값 저장 검증은 별개다.

부족한 Set과 빈 Reference의 이동 버튼은 같은 Work에서 Set만 바꾸며 dirty 확인을 재사용한다. 새 Set 선택 시 기존 Record/폼/options를 비우고 `setRequestId`에 맞는 최신 응답만 반영한다. 쓰기는 기존 ref 잠금으로 중복을 막는다. App 이동 상태는 layout effect로 화면과 같은 commit에서 갱신한다. 사용자 메시지는 검증된 IPC 오류만 표시한다.

Task016 원본 정의는 `setup/initial-canon-definition.cjs`의 `TASK016_CANON_SETS`다. 기존 setup에서 추출한 11 Set/30 Field/4 Option의 key, label, type, control, reference, option, 순서를 보존한다. `CANON_SETS`는 원본에서 Task017/022 required 정책만 파생하며 setup과 validation이 공유한다.

`npm run setup:current-work-canon -- --canon-space <id>`는 현재 작품의 기존 빈 공간에 대한 명시적 복구 작업이다. `runInstaller`의 read-only 사전 점검 → 기존 migration/백업 정책 → `installCurrentWorkCanonDefinition`의 빈 상태 확인 → VACUUM INTO 별도 백업 → BEGIN IMMEDIATE → 빈 상태 재확인 → Task016 정의 삽입/검증 → `refineInstalledDefinition`으로 required 정제 → 최종 검증 → COMMIT 순서다. 실패는 rollback한다. Work/CanonSpace를 생성하지 않는다. 다른 제목의 작품과 Set/Field/Option/Record 중 하나라도 있는 공간은 거부한다. Record는 생성/수정/삭제하지 않는다.

기존 004 DB는 005 전에 `backups/before-task022-<UUID>.db`로 백업한다. 백업 실패 시 migration을 진행하지 않는다. 005는 초기 Set/Field/Option 전체 구조와 일치하는 공간의 세 required flag만 변경한다. 부분/사용자 수정 정의를 무작정 보정하지 않는다. Bootstrap은 migration이 이미 적용된 빈 공간에도 대응하도록 삽입 직후 최종 required 정책을 적용한다.

Task019/020의 `Canon 시작 = 빈 CanonSpace`, `Canon 전체 삭제 = 해당 공간 데이터 삭제` 정책은 유지한다. 명시적 Definition 복구는 별도 작업이다. 앱 시작/Canon 시작에서 자동 호출하지 않으며 범용 Preset, Template Registry, 다른 Work 자동 Bootstrap, Schema Editor, Copy, AI로 확장하지 않는다.
