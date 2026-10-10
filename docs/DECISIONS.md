# NovelCompany 아키텍처 결정 기록

## Task030 — 규칙 검토는 등록 관계를 비교하고 판단 범위를 제한한다

- RULE_V1의 첫 규칙은 CHARACTER_SKILL_ATTRIBUTE_MISMATCH_V1, 규칙 버전 V1이다. 현재 Relevant Canon의 Character.skills와 전체 Character.attributes를 Skill.required_attribute ID와 비교한다. 같은 이름을 같은 Record로 취급하지 않으며 전체 Work나 재귀 관계로 범위를 확장하지 않는다.
- 전체 참조 목록 확인 정보가 없거나 실제 목록과 다르면 판단하지 않는다. 필요 속성 null·필드/Record 누락도 내부 UNVERIFIABLE이며 INFO를 포함한 Finding을 만들지 않는다. 필요한 ID가 완전한 보유 목록에 없다는 사실은 WARNING/DETERMINISTIC 근거이지 실제 사용 불가능·작품 오류의 확정이 아니다. 계약·권능·예외는 작가 확인 사항이다.
- 실제 능력 사용자 추론은 별도 단계다. Narrator·근접 이름·Organization으로 사용자를 결정하지 않고 기존 Ownership Checks 및 Alias AMBIGUOUS를 유지한다. 단일 이름 후보도 Finding에서 NAME_CANDIDATE로 보존한다. 추론을 Canon에 저장하지 않는다.
- 기본 STUB_V1을 유지하고 RULE_V1은 사용자가 명시적으로 선택한다. Main은 두 키만 허용하며 Job 선택은 영속·불변이다. RULE_V1 정적 정의와 evidence에 규칙 버전/범위를 고정하여 과거 Run을 현재 규칙으로 재해석하지 않는다. V1/V2/V3 입력 fingerprint와 Task029 저장 계약은 재사용한다.
- Findings/Run/Job 원자 완료, 실패 rollback, FIFO·잠금·재시작 정책을 유지한다. 규칙 추가를 이유로 DB/TXT/Canon을 Processor에서 직접 읽거나 수정하지 않는다. 실제 AI·Finding 승인/기각·자동 수정은 후속 작업이다.

## Task029 — Finding은 판단과 근거이며 자동 수정 명령이 아니다

- Category, Severity(INFO/WARNING/ERROR), Assessment(DETERMINISTIC/INFERENCE_CANDIDATE/UNDETERMINED)를 분리한다. ERROR는 오류 확정이 아니고 DETERMINISTIC도 작품 설정 오류 확정을 뜻하지 않는다. 근거 구조 검증과 문학적 판단의 타당성 검증은 별개다. 향후 AI 결과를 DETERMINISTIC으로 자동 승격하지 않는다.
- TEXT_RANGE는 실행 당시 UTF-16 반개구간, 원문과 정확히 일치하는 발췌, nullable Scene identity를 저장한다. Scene을 지정하면 그 범위 안에 있어야 한다. CANON_RECORD는 관련 Canon과 evidence를 요구하며 가짜 원문 범위를 허용하지 않는다. 원고 전체 snapshot을 추가 저장하지 않는다.
- Canon 유효성은 실행 Context의 선택 Record/명시 참조/작가 지정 서술자 또는 이름 후보로 제한한다. 현재 DB로 과거 Finding을 재해석하지 않는다. CONTEXT_RECORD는 Context 연결 사실이며 실제 발화자/능력 사용자를 확정하지 않는다. 이름만으로 선택된 인물은 NAME_CANDIDATE, 복수 후보는 AMBIGUOUS_CANDIDATE로 보존한다. 후보 그룹을 참조하면 전체 후보를 요구하고 소속도 최소 식별 snapshot으로 남긴다.
- Result 중 하나라도 유효하지 않으면 전체 실패다. 검증 오류는 안정적인 코드와 한국어 메시지만 노출하며 Processor 예외의 원문 포함 가능성을 고려해 raw cause를 로그에 쓰지 않는다. 같은 record/role/mention 중복은 거부하며 서로 다른 언급의 후보 연결은 구분한다.
- 기존 review_findings를 확장한다. 신규 컬럼 null은 Legacy이며 근거·Assessment를 발명하지 않는다. Findings 버전은 입력 hash 버전과 독립적이고 기존 hash 및 FULL/RELEVANT V1/V2/V3 비교 규칙은 유지한다.
- STUB_V1 빈 결과는 처리 흐름 완료일 뿐 실제 검토가 아니다. MOCK_V1은 패키지에서 제외된 가상 fixture 전용이다. 규칙 검토는 Task030에서 추가하며 실제 AI Processor Adapter, 작가 승인·기각과 수정 흐름은 후속 작업이다. TXT와 Canon은 이 파이프라인에서 자동 변경하지 않는다.

## Task028 — 별칭은 등록 후보이며 실제 지시 대상은 미확정

- Character Record와 Alias는 1:N이며 먼저 저장된 Generic character에서만 CRUD한다. 동일 Record 내 normalized Alias는 UNIQUE, 다른 Record끼리 같은 Alias와 다른 Character의 정식 이름 충돌은 허용한다.
- 표시 값은 앞뒤 공백만 제거해 저장한다. 비교 값은 trim + Unicode NFC이며 내부 공백과 대소문자는 유지한다. 제어문자·줄바꿈·빈 값 및 200자를 넘는 입력은 거부한다. 동일 Character의 현재 정식 이름과 같은 Alias는 생성/수정하지 않는다. 이후 Character 이름 변경은 기존 정책대로 허용하고 같은 이름/Alias의 후보를 Record ID로 중복 제거한다.
- 긴 명칭 우선, 보수적인 단어/조사 경계와 원래 UTF-16 범위를 사용한다. NFC 검색 view를 만들지만 원고 TXT를 정규화하거나 수정하지 않는다. 형태소 분석기와 외부 API를 도입하지 않는다.
- 동일 명칭의 후보를 모두 보존한다. 각 후보는 DISPLAY_NAME/REGISTERED_ALIAS evidence와 기존 Character.organization 참조를 가진다. 소속 미설정은 null이며 Organization으로 후보를 자동 확정하지 않는다. 문맥 의존 대명사는 등록 여부와 관계없이 unresolved다.
- 단일 후보는 기존 Relevant Canon 1-hop 확장에 연결한다. AMBIGUOUS 후보의 Skill/Passive/관계/계약을 전부 확장하지 않는다. 명칭 후보 탐지와 실제 발화 대상·능력 사용자 판정은 분리한다. 기존 ownership 규칙은 Alias를 읽지 않는다.
- Alias-aware 해시 입력은 selector V3 + CHARACTER_NAMES_V1 + 기존 관련 Canon + 실제 nameMentions다. Alias 전체 목록·DB UUID·timestamp를 해시하지 않는다. 원고와 무관한 Alias 변경은 stale을 만들지 않는다. 모호한 후보의 Organization 변경도 실제 후보 입력에 반영한다.
- Migration 012는 기존 Canon V1/V2 컬럼을 유지하고 Job/Run에 nullable name_resolution_version을 추가한다. null은 과거 파서/hash 경로, CHARACTER_NAMES_V1은 신규 selector/hash 경로다. 과거 hash는 backfill/재작성하지 않으며 Scene Narration V1 hash도 변경하지 않는다.
- Alias는 Canon 데이터이므로 Episode 잠금을 적용하지 않는다. QUEUED 입력 불일치는 기존 Worker 비교로 재제출 필요, RUNNING 입력은 고정하고 완료 결과 freshness로 변경을 표시한다. FK CASCADE는 Character/Canon 삭제 transaction 안에서 Alias를 정리하고 실패하면 함께 rollback한다.
- 향후 AI Reviewer는 Speaker·Organization·관계·POV·Scene 문맥을 추가 근거로 사용해 실제 지시 대상을 추론할 수 있다. 추론을 Canon 사실로 자동 저장하지 않는다.

## Task027 — POV는 작가 지정 보조 Metadata

- TXT를 Source of Truth로 유지하며 POV 태그를 삽입하지 않는다. 장면 경계는 Task025 파서만 사용하고 독립 버전 `SCENE_LAYOUT_V1`을 부여한다.
- Episode ID + 원문 SHA-256 + layout version + scene identity를 연결 키로 사용한다. identity는 version/index/UTF-16 range/raw heading/장면 원문 hash의 canonical SHA-256이다. 원고·파서가 바뀌면 예전 행은 보존하고 자동 재매칭하지 않는다. 정확히 같은 원고·파서로 되돌아온 경우에만 같은 키의 설정을 읽는다.
- `FIRST_PERSON_CHARACTER`는 동일 Work Generic character 하나를 요구한다. 외부 3인칭과 UNKNOWN은 참조가 없다. `AUTHOR_SET`과 `UNSET`을 구분하고 UNKNOWN도 제출 가능하다.
- Character 삭제는 trigger에서 참조를 null, 모드를 UNKNOWN, invalidated를 1로 바꾼다. 삭제 행의 이름이나 다른 인물로 대체하지 않는다. Canon 전체 삭제와 재시작을 막지 않으며 transaction 실패 시 무효화도 rollback된다.
- 시점 쓰기는 Task026 operation gate와 QUEUED/RUNNING 잠금을 재사용한다. Canon 삭제에 따른 참조 무효화는 Canon lifecycle 작업으로 허용한다. 실행 전 hash가 달라지면 RESUBMIT_REQUIRED다.
- Scene hash는 Canon hash와 분리한다. metadata/layout version과 순서가 고정된 장면 identity/mode/source/narrator identity/status만 canonical serialization한다. narrator identity의 displayName도 실제 Review 입력이므로 포함한다. 행 UUID·시각·구버전 경고 여부는 제외한다.
- 과거 Run의 null hash/version은 LEGACY_NOT_TRACKED이며 기존 FULL/RELEVANT V1/V2 판정을 유지한다. 과거 QUEUED Job은 제출 시점 POV를 재현할 수 없어 RESUBMIT_REQUIRED로 끝낸다. 기존 hash는 덮어쓰지 않는다. Episode가 바뀌면 POV의 독립 변경을 단정하지 않고 UNDETERMINED_EPISODE_CHANGED로 표시한다.
- Narrator로 대사 화자나 Skill 사용자를 자동 판정하지 않는다. AI 호출, Canon 자동 수정, Relevant Canon 확장, 실제 Review Processor는 이번 범위 밖이다.

## Task026 — 제출과 실행의 분리

작가의 제출은 영속 ReviewJob이고 실제 Processor 실행은 기존 ReviewRun이다. `review_jobs.queue_sequence`를 SQLite AUTOINCREMENT로 배정해 같은 밀리초 제출도 FIFO로 처리한다. Episode 활성 Job과 전역 RUNNING Job은 각각 partial unique index로 한 개만 허용한다. 별도 Episode lock boolean은 저장하지 않는다. 취소는 QUEUED에서만 조건부 UPDATE하고 이력을 삭제하지 않는다.

제출 fingerprint는 원고 hash와 RELEVANT_CANON_V1 모드의 V2 hash다. Worker가 선점 직전 다시 생성한 Context와 비교해 달라지면 RESUBMIT_REQUIRED로 끝내고, 읽기 실패는 FAILED로 기록한다. RUNNING 이후 Canon 변경은 고정된 실행 입력을 교체하지 않으며 기존 freshness가 결과를 오래된 것으로 표시한다. 앱 재시작은 RUNNING Job/Run을 REVIEW_INTERRUPTED로 실패 처리하고 QUEUED만 재개한다. 새 AI API·재시도·원고 교정은 도입하지 않는다.

## Task025-HF01 — 기존 Skill 보존과 Review 버전

Skill의 필요 속성은 Attribute 1개를 가리키며 같은 Attribute를 여러 Skill이 참조할 수 있다. 신규 Skill은 필수 입력이고 기존 미설정 Skill에는 속성을 자동 부여하지 않는다. Repository는 업그레이드 전 미설정이던 Skill만 null 상태 수정을 허용한다. 미설정 Skill을 보완한 뒤 null로 되돌리는 수정은 거부한다. Dynamic Form은 실제 Definition과 동일 작품의 Reference options를 사용한다.

008은 기존 정의에 Field만 멱등적으로 추가하고, 009는 ReviewRun의 `fingerprint_version`을 도입한다. 기존 FULL_CANON_V1/RELEVANT_CANON_V1 Run은 기본 V1로 조회한다. 신규 RELEVANT_CANON Run은 V2로 저장하며 Skill의 속성 참조와 선택된 Attribute Record를 해시에 포함한다. 과거 V1 해시는 이 Field/확장 경로를 제외해 재구성한다. Skill 사용자 판단과 속성 적합성은 별도 단계이며, 이번 작업은 기존 명시적 사용 문장 판정만 유지한다.

## Task025 — 관련 Canon 및 불확실성 보존

FULL_CANON 입력을 유지하고 새 ReviewContext는 WorkContext만 받아 순수 분석한다. Generic Canon 외 저장소를 보지 않는다. 이름 중첩은 긴 이름이 차지한 원문 범위만 우선하고 다른 위치의 짧은 이름은 유지한다. 동명 Record는 명시 Set으로 좁혀도 여러 후보이면 AMBIGUOUS다. 관계/계약은 핵심 Character 한 명만 연결되어도 모두 포함하며 1-hop 이후 상대 Character의 참조/관계는 확장하지 않는다.

그분/그 녀석/그녀석/그 사람은 미확정 지시 표현 후보로 위치만 기록한다. 복선 의미나 정체를 추정하지 않는다. Scene 화자는 UNKNOWN이다. 콜론 없는 중괄호는 skill/passive 모두 대조하고 정확히 한 후보일 때만 유형을 정한다. 소유 판정은 명시 단일 사용자 문장과 Reference ID 일치에 한해 확인한다. MATCHED, MISMATCH_CANDIDATE, UNVERIFIABLE_OWNER, CANON_NOT_FOUND, AMBIGUOUS를 구분한다. 미보유는 불일치 후보이며 실제 설정 오류로 단정하지 않는다. 권능 표기 좌우와 authority.base_skill/displayName 사이의 확정 규칙은 없으므로 자동 연결하지 않는다.

007의 context_mode 기본값 FULL_CANON_V1은 과거 해시와 이력을 그대로 보존한다. 신규 Run은 RELEVANT_CANON_V1이다. 기존 전체 해시는 기존 알고리즘으로 비교하고 신규 해시는 selectorVersion, 선택된 Set/Record/field의 실제 값과 참조, 동명 후보 identity를 결정적으로 정렬·직렬화한다. 전체 총수, 시각, 원문 범위/선택 이유는 해시에 넣지 않는다. 무관한 Canon 변경은 신규 해시에 영향이 없고 관련 관계/계약 추가 및 능력 소유 참조 변경은 반영한다.

신규 Run의 episodeChanged가 true이면 canonChanged=false를 독립 비교 결과로 해석하지 않는다. canonComparison=UNDETERMINED_EPISODE_CHANGED로 표시하며 contextChanged는 관련 입력 해시 변화만 나타낸다. 저장 정보만으로 원고 선택 집합 변화와 Canon DB 변경을 독립 분리할 수 없어 UI에 판정 불가 안내를 표시한다. 원고가 같을 때 canonChanged는 관련 Canon 입력 변화다. Preview는 저장본 기준 읽기 전용이며 실제 AI 호출과 원본 수정은 없다.

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

## Decision 020 — 작가 직접 입력은 Generic CanonRecord CRUD로 저장한다

**상태:** 채택됨 · Task017 구현

Task016 읽기 전용 범위를 확장한다. AI가 Canon을 변경하지 않는 원칙은 유지하며, 작가가 Dynamic Form에서 저장/삭제를 명시적으로 실행한다. CanonSet/Field 편집, Canon 간 복사, 자동 생성, 별도의 Canon 승인 Workflow는 이번 범위가 아니다.

폼은 CanonField의 value_type/input_control/required/option/reference 정의를 사용한다. 대표 이름은 CanonSet.record_name_label로 표시하고 CanonRecord.display_name에 저장한다. 사용자 입력은 Field ID별 값이며 실제 DB Record ID만 참조할 수 있다.

등록 선행조건은 필수 Reference와 실제 target Record 수로 계산한다. 숫자로 등록 순서를 고정하지 않는다. Character의 Attribute/Passive는 각 1개 이상, Skill은 0개 허용, Organization은 null 허용이다. 출신 세계와 출신 지역의 세계는 일치해야 하며 현재 위치는 다른 세계도 가능하다. Authority/Servant는 Character 이후 별도 Set에서 생성한다.

COMMON Passive는 공유 가능하고 UNIQUE는 단일 Character만 소유한다. 자신의 UNIQUE를 수정 중 유지할 수 있으며 여러 소유자가 있는 COMMON의 UNIQUE 전환은 거부한다. UI 선택 금지와 별도로 transaction 안에서 재검증한다. Contract/Relationship의 자기 참조를 금지하고 선행조건에서 캐릭터 2개를 요구한다.

현재 의미 규칙은 초기 템플릿의 안정된 key를 사용하는 작은 Repository 검증 함수다. Generic Rule Engine을 만들지 않는다. 추가 Legacy 규칙(캐릭터당 권속 최대 1, 중복 활성 계약 금지 등)은 Future Rule로 남긴다. 해당 규칙을 일반화하려면 정의 모델/UX 요구가 먼저 확정되어야 하기 때문이다. Legacy 테이블 자체의 기존 제약은 변경하지 않는다.

004는 기존 Definition ID와 Record를 보존하고 알려진 필드의 required만 보정한다. 초기 setup도 같은 값을 사용한다. 앱에서 기존 003 DB에 적용하기 전 VACUUM INTO 백업이 성공해야 한다. 운영 DB에 샘플 Record를 자동 생성하지 않는다.

## Decision 021 — Work 삭제는 회차와 CanonSpace가 없는 경우에만 허용한다

**상태:** 채택됨 · Task018 구현

작가가 작품 관리 UI에서 제목/설명/상태를 생성·수정하고 빈 작품을 삭제할 수 있다. Work/Episode Viewer와 작품 정보 편집은 별도 화면으로 구분해 기존 회차 탐색을 유지한다. 기존 Work Schema와 CRUD Repository를 재사용하며 migration이나 title UNIQUE 제약을 추가하지 않는다. 동일 제목을 허용하고 제목 앞뒤 공백만 정리한다. 기존에 최대 길이 정책이 없으므로 새 제한을 정하지 않는다.

Work 생성은 Work row만 저장한다. CanonSpace, CanonSet/Field 및 Episode 자동 생성은 없다. 설명은 DB에서 string/null을 허용하고 기존 DTO는 null을 빈 문자열로 표현한다. UI의 빈 설명은 빈 문자열로 저장한다. 상태는 ACTIVE/PAUSED/COMPLETED만 허용하며 작품 관리 UI는 진행 중/일시 중지/완결로 표시한다.

삭제 조건은 Episode count = 0 AND CanonSpace 없음이다. 비어 있는 CanonSpace 자체도 작품 구조이므로 삭제를 막는다. Episode의 TXT 존재 여부를 조회하지 않고 metadata가 있으면 차단한다. 상태 조회 후 데이터가 추가될 수 있으므로 최종 삭제는 BEGIN IMMEDIATE 안에서 의존성을 재검증한다. 삭제 대상은 Work row 하나뿐이고 기존 RESTRICT와 파일을 보존한다.

getById는 기존처럼 없는 Work에 null을 반환한다. updateWork의 기존 Repository null 계약도 유지하며 Work IPC는 WORK_NOT_FOUND로 바꾼다. 새 삭제 상태/삭제 API는 없는 Work에 WORK_NOT_FOUND를 반환한다. 강제 삭제, 휴지통/복구, Archive 및 연관 파일 정리는 별도 정책이 필요하므로 Task018에 포함하지 않는다.

## Decision 022 — Canon 시작은 빈 공간만 명시적으로 생성한다

**상태:** 채택됨 · Task019 구현

Work 생성과 Canon 시작을 분리한다. 작가가 컨셉정리에서 시작을 확인해야 빈 CanonSpace를 생성한다. 기존 11개 Set 자동 복사, Preset 및 자동 Definition 생성은 하지 않는다. 공간 생성 후 Set 0개는 정상 상태이며 아직 동작하지 않는 Set 추가 버튼을 제공하지 않는다.

기존 template_key CHECK의 호환값 MODERN_FANTASY_V1을 유지한다. 이 값은 legacy metadata이며 실제 구조는 Definition 행이 결정한다. 새로운 값 하나를 허용하기 위한 CanonSpace/FK 재구축은 하지 않는다.

공간 생성은 Work 실재/중복 확인과 쓰기를 BEGIN IMMEDIATE로 묶는다. 잘못된 ID는 WORK_ID_REQUIRED, 없는 작품은 WORK_NOT_FOUND, 중복은 CANON_SPACE_ALREADY_EXISTS, 예상치 못한 DB 오류는 CANON_SPACE_CREATE_FAILED로 반환한다. 사용자 메시지는 한국어이며 원본 SQL 오류는 Main 로그로만 전달한다.

후속 로드맵은 Decision 023과 PROJECT_PLAN의 현재 순서를 따른다. Task별 보고서를 누적하지 않고 지속적인 결정만 Core 문서에 유지한다.

## Decision 023 — Canon 전체 삭제는 독립적인 명시적 파괴 작업이다

**상태:** 채택됨 · Task020 구현

작가가 삭제 영향을 읽고 복구 불가 경고를 확인해야 Canon 전체를 삭제한다. 빈 공간은 최소 한 번, Definition/Record/Legacy 등 의존 행이 있는 공간은 영향 요약과 최종 확인의 두 단계를 사용한다. 미저장 Record 입력의 폐기 확인은 그보다 먼저 수행하며 취소 시 데이터를 변경하지 않는다.

Work 삭제에 Canon 삭제를 자동 포함하지 않는다. 별도 `deleteCanonForWork`가 BEGIN IMMEDIATE 안에서 Work와 최신 공간/삭제 영향을 재검증하고 Generic 및 Legacy 전체를 FK의 자식부터 제거한다. 중간 오류는 전체 rollback한다. 외래 키 비활성화나 CASCADE 변경으로 우회하지 않는다. 기존 001~004와 스키마는 유지한다.

Canon 삭제는 Work/Episode metadata, TXT와 기타 파일, 다른 Work의 Canon, migration history 및 app settings를 보존한다. 삭제 후 같은 Work에 새 UUID의 빈 CanonSpace를 다시 만들 수 있다. 회차가 남아 있으면 Work 삭제는 여전히 차단된다.

Task021은 Episode CRUD + TXT Editing이다. CanonSet/CanonField CRUD는 시스템 핵심 Flow 안정화 이후, Canon 틀 복사는 그 이후로 미룬다. CanonSpace Update는 현재 의미 있는 사용자 metadata가 없어 추가하지 않는다.

## Decision 024 — 회차 번호와 불변 ID를 분리하고 metadata/TXT를 한 저장 작업으로 처리한다

**상태:** 채택됨 · Task021 구현

작가가 기존 WorksScreen에서 회차 번호/제목/상태/순수 TXT를 명시적으로 저장한다. UUID는 유지하며 번호는 작품 안에서 유일한 양의 safe integer다. 삭제한 번호를 재사용하고 새 폼에는 가장 작은 빈 번호를 추천한다. 추천은 예약이 아니므로 BEGIN IMMEDIATE 안의 중복 검사와 기존 UNIQUE가 최종 기준이다. 번호 swap/일괄 재정렬은 하지 않는다.

기존 번호 기반 TXT 구조를 유지한다. Renderer는 ID와 편집 값만 전달하고 경로를 알지 못한다. Main service가 Repository와 Storage를 조율하며 create/update는 metadata와 content를 한 요청으로 받는다. 임시 파일/원본 백업/DB rollback/파일 복원으로 정상 실행 중 실패를 보상한다. 삭제도 같은 경계를 사용한다. commit 후 backup 정리 실패는 성공한 삭제/저장을 실패로 되돌리지 않고 기록한다. 보상 실패 역시 기록하며 백업을 보존한다. 다중 자원 ACID나 crash recovery를 보장한다고 표현하지 않는다.

누락 TXT는 복구 가능한 상태로 안내하고 빈 원고 저장도 허용한다. 일반 읽기 실패에서는 저장을 차단한다. 입력 폐기 확인, 중복 쓰기 방지, 최신 읽기 응답만 적용하는 보호를 유지한다. 자동 저장/AI/리치 에디터/Canon 구조 편집과 복사는 이번 범위에 없다. 테스트는 임시 DB/데이터 루트와 실제 sandbox Electron에서 수행한다.

## Decision 027 — ReviewRun은 immutable history이며 Stub은 판정 결과가 아니다

**상태:** 채택됨 — Task024 구현

검토 재실행은 기존 Run을 갱신하지 않고 새 Run을 생성한다. Review source identity는 검증된 Episode TXT hash와 canonical JSON으로 직렬화한 FULL_CANON hash로만 보존한다. 원본 TXT·Canon·WorkContext 전체는 persistence하지 않으며 Review 결과의 자동 적용도 하지 않는다.

`STUB_V1`은 Review processor contract와 lifecycle 연결을 검증하기 위한 빈 findings processor다. UI는 실제 AI 검토나 “문제 없음”으로 표현하지 않으며, Stub임을 명확히 표시한다. processor 또는 결과 저장 실패는 RUNNING Run을 FAILED로 남기고 raw cause는 Main log에만 기록한다.

## Decision 026 — WorkContext는 저장하지 않는 읽기 전용 공통 입력이다

**상태:** 채택됨 · Task023 구현

저장된 Episode TXT와 Generic Canon은 각각의 Source of Truth를 유지한다. Main-side buildEpisodeWorkContext가 둘을 FULL_CANON WorkContext로 조합하지만, 이를 DB/파일에 persistence하거나 원본을 보정하지 않는다. content_hash가 존재할 때 TXT hash가 다르면 build를 중단한다.

Reference와 Option은 내부 UUID만 전달하지 않고 사람이 이해할 수 있는 recordId/setKey/displayName 및 key/label로 해석한다. 손상된 reference/option은 silent fallback 없이 오류로 처리한다. Renderer는 단일 context IPC만 호출하며 path/storageKey/Node/SQLite를 받지 않는다.

Task023은 Review, Canon 충돌 판정, 문장 수정, Prompt, AI Provider 호출을 구현하지 않는다. 저장되지 않은 editor draft는 Context에 포함하지 않는다.

## Decision 025 — 기존 정의로 Canon 작성 단계를 안내하고 현재 작품 복구는 별도로 실행한다

**상태:** 채택됨 · Task022 구현

기존 11개 Set과 DynamicCanonForm/CanonRecord CRUD를 사용한다. 입력 그룹은 기초 설정, 공간/집단, 인물, 인물 확장이며 실제 등록 준비 상태는 Main이 계산한다. Character는 지역/속성/패시브 입력 후 확정하는 집약 Record다. 최소 조건은 이름, origin_location, attributes >= 1, passives >= 1이다. origin_world/current_location/organization/skills는 선택이다. 출신 세계를 입력한 경우만 지역의 세계와 일치시킨다. UNIQUE/COMMON 소유 정책과 교차 Canon·잘못된 Set 참조 금지를 유지한다.

Contract/Relationship은 Character 2명 이후, Authority/Servant는 1명 이후 입력한다. Character의 필수값으로 역참조를 추가하지 않는다. Relationship.relationship_type은 필수다. 새 Rule Engine이나 Set별 전용 폼을 만들지 않는다. 기존 Generic 저장 transaction이 최종 검증 책임을 갖는다.

현재 PC에서 실제 CanonSpace가 비어 있음을 확인했고, 사용자가 기존 Task016 정의의 명시적 복구를 요청했다. 이에 원본 `setup-initial-novel-canon.cjs`의 CANON_SETS를 공통 `initial-canon-definition.cjs`로 추출했다. 원본 Field를 추측하거나 추가하지 않고 기존 정의 설치 후 합의된 required만 정제한다. 복구 도구는 현재 작품의 명시적 CanonSpace ID, 완전 빈 상태, 백업, transaction, 설치 검증을 요구한다. 부분 정의는 오류이며 Record를 생성하지 않는다.

Canon 시작은 계속 공간만 생성한다. Definition Bootstrap은 별도 관리 명령이고 앱 자동 동작이 아니다. 다른 작품 자동 설치, Preset/Template Registry, Schema CRUD, Canon Copy 및 AI Manager/Review/Editing은 후속 범위다.
