# NovelCompany 데이터 모델 설계

## Task025 — 파생 ReviewContext V1 및 migration 007

ReviewContext는 DB 엔터티/저장 snapshot이 아니다. scope=RELEVANT_CANON, selectorVersion=RELEVANT_CANON_V1, rangeUnit=UTF16_HALF_OPEN, work, episode, scenes, relevantCanon, abilityOwnershipChecks, unresolvedMentions, warnings로 구성한다. episode는 저장 원문을 한 번 포함한다.

scenes는 index, originalRange, locationHeading, timeHintRaw, locationCandidate, resolvedLocation(status/recordId/candidateIds), narration(type/characterId), notationOccurrences, directMentions, selectedCanonIds를 포함한다. relevantCanon은 selectedSets(key/label), selectedRecords(기존 public record + setKey/setLabel), selectionReasons(recordId/reason/sceneIndex/sourceRecordId/range)다. 관계 상대 identity는 선택된 관계/계약의 Reference value에 포함되고 상대 전체 Record를 중복 저장하지 않는다. selectionReasons의 RELATED_PARTICIPANT는 이 identity 제공 경로를 나타낸다.

abilityOwnershipChecks는 raw/range/sceneIndex/type/abilityRecordId/actorCharacterId/result/evidence/unresolvedReason이다. unresolvedMentions는 raw/range/sceneIndex/status/candidateIds, warnings는 range/message다. 원시 DB 행, storageKey, 파일 경로는 포함하지 않는다. Scene/분석 DTO는 향후 AI Reviewer 입력으로 사용할 수 있지만 현재 STUB_V1 Findings와 분리한다.

`007_add_review_context_mode.sql`은 review_runs에 `context_mode TEXT NOT NULL DEFAULT 'FULL_CANON_V1' CHECK(context_mode IN ('FULL_CANON_V1','RELEVANT_CANON_V1'))`만 추가한다. 001~006과 기존 해시는 수정하지 않는다. 신규 Review는 관련 Canon hash를 저장하며 Findings/lifecycle/FK 정책은 유지한다. freshness는 isCurrent/episodeChanged/canonChanged/contextChanged/canonComparison 파생 DTO다. 원고가 변경된 RELEVANT 모드의 canonComparison은 UNDETERMINED_EPISODE_CHANGED이며 독립 Canon 변경 여부를 확정하지 않는다.

## 1. 목적과 범위

이 문서는 SQLite와 migration 001~005의 논리 데이터 모델 및 TXT 저장소 경계를 정의한다. `node:sqlite`로 `C:\NovelCompanyData\novelcompany.db`를 생성하고 순차 migration을 적용한다. 현재 Work 관리, Canon Record CRUD 및 CanonSpace 시작/삭제, Episode CRUD와 TXT 편집을 구현했다. CanonSet/Field 구조 편집과 틀 복사는 후속 범위다.

## 2. TXT Source of Truth

Episode TXT는 작가가 작성한 **순수 소설 원문(Source of Truth)** 이다. 메모장으로 열었을 때 소설 본문만 존재해야 한다.

TXT에는 Work/Episode ID, Canon, Character, World, Location, Organization, AI 분석·제안·교정 결과, Meeting 기록, Workflow 상태, AI 사용량 또는 JSON/XML/YAML 메타데이터를 넣지 않는다.

```text
C:\NovelCompanyData
└─ works
   └─ {workId}
      └─ episodes
         ├─ 001.txt
         └─ 002.txt
```

## 3. SQLite와 File Storage의 역할

SQLite는 소설 원문이 아닌 구조화된 정보와 관리 정보를 저장한다. 여기에는 Work/Episode 메타데이터, Canon, Story Bible 데이터, Memory, Proposal, Workflow, Employee, AI Usage, Illustration metadata가 포함된다.

File Storage는 TXT와 이미지 같은 실제 파일을 보관한다. 현재 `LocalEpisodeStorage`가 로컬 TXT 파일을 담당하며, 미래에는 같은 Storage 계약을 구현하는 Cloud Storage로 교체할 수 있다.

SQLite는 Electron Main Process에서만 열며 `PRAGMA foreign_keys = ON` 후 `schema_migrations`를 사용해 번호순 SQL migration을 적용한다. Schema v1은 Work, Episode와 Canon 기반의 기본 관계만 포함하며, Renderer에는 DB 객체를 노출하지 않는다.

## 4. Canon과 주요 용어

Canon은 작가가 작품의 공식적인 사실로 확정하여 인정한 정보의 집합이다. Character만이 아니라 World, World Rule, Location, Organization, Skill, Item, Relationship, Timeline Event 등도 Canon이 될 수 있다. AI의 분석이나 제안은 자동으로 Canon이 되지 않으며, 작가 승인 뒤에만 반영한다.

| 용어 | 정의 |
| --- | --- |
| Work | 하나의 소설 작품 |
| Episode | Work에 속한 개별 연재 회차. 원문은 직접 저장하지 않음 |
| Story Bible | Canon 및 연속성 정보를 구조적으로 참조하는 체계. 단일 테이블을 강제하지 않음 |
| World | 작품 세계의 가장 큰 공간 단위 |
| World Rule | 세계가 작동하는 방식, 마력·신·물리·마법 법칙 |
| Location | 특정 World 안의 지리적·공간적 위치 |
| Organization | 특정 Location을 대표 거점으로 하는 조직 |
| Character | 소설 속 등장인물 데이터 |
| Episode Memory | 특정 Episode의 사건·정보를 AI가 참고하도록 구조화한 기록 |
| Meeting Memory | 직원·부서·작가의 회의 및 논의 기록 |
| Proposal | 아직 Canon으로 확정되지 않은 AI 또는 작가의 제안 |
| Employee | NovelCompany에서 업무를 수행하는 직원. 소설 Character와 별개 |

## 5. 논리 데이터 모델

아래 필드는 관계를 설명하는 논리 모델이며 실제 `CREATE TABLE`은 아직 작성하지 않는다.

### Work와 Episode

`works`

```text
id
title
description
status
created_at
updated_at
```

`episodes`

```text
id
work_id
episode_number
title
status
storage_key
content_hash
created_at
updated_at
```

`work_id`는 Work를 REFERENCES ... ON DELETE RESTRICT로 참조한다. `id`는 TEXT PRIMARY KEY UUID이며 번호 변경에도 유지한다. `episode_number`는 INTEGER NOT NULL CHECK (> 0), `(work_id, episode_number)`는 UNIQUE다. title은 TEXT NOT NULL, status는 DRAFT/IN_PROGRESS/COMPLETED CHECK, storage_key는 TEXT NOT NULL UNIQUE, content_hash는 nullable TEXT, created_at/updated_at은 TEXT NOT NULL이다. Task021은 기존 제약으로 충분하므로 migration을 추가하거나 001~004를 수정하지 않았다.

Main은 safe positive integer 번호와 trim 후 비어 있지 않은 제목을 검사한다. 같은 작품의 중복 번호만 금지하고 다른 작품은 같은 번호를 허용한다. 목록은 번호 ASC, 삭제/변경 후 자동 재번호나 swap은 없다. 추천은 가장 작은 미사용 양의 정수이며 `[]→1`, `[1,2,4]→3`, `[2,3,4]→1`, `[1,3,5]→2`다. 예약이 아니므로 저장 transaction에서 중복을 다시 검사하고 DB UNIQUE도 유지한다.

### World, World Rule, Location, Organization

아래 Modern Fantasy Canon table은 migration 002 기준 실제 구현이다. World Rule은 현재 별도 table로 구현하지 않는다.

`worlds`

```text
id
canon_space_id
name
description
created_at
updated_at
```

`locations`

```text
id
canon_space_id
world_id
name
description
created_at
updated_at
```

`organizations`

```text
id
canon_space_id
location_id
name
description
created_at
updated_at
```

공간과 조직의 기본 관계는 다음과 같다.

```text
World
  └──< Location
          └──< Organization
```

`locations.(canon_space_id, world_id)`는 같은 CanonSpace의 World를, `organizations.(canon_space_id, location_id)`는 같은 CanonSpace의 Location을 참조한다. 여러 지역에 지부를 둔 조직은 미래에 다대다 관계로 확장할 수 있으며 현재 모델에는 넣지 않는다.

### Character: 출신지, 현재 위치, 소속

`characters`

```text
id
canon_space_id
name
origin_world_id
origin_location_id
current_location_id
organization_id
description
created_at
updated_at
```

```text
Character
├─ origin_world_id      출신 World
├─ origin_location_id   출신 Location
├─ current_location_id  현재 위치
└─ organization_id      현재 소속 조직
```

Character는 Organization 하나만으로 공간 관계를 표현하지 않는다. `origin_location_id`가 가리키는 Location의 `world_id`는 `origin_world_id`와 일치해야 하며, 두 참조는 Character와 같은 CanonSpace에 있어야 한다. 이 규칙은 SQLite 복합 Foreign Key로 강제한다. 현재 위치는 출신지와 다를 수 있고 스토리 진행에 따라 바뀔 수 있다.

### Skill, Relationship, Timeline, Item

`skills`

```text
id
canon_space_id
name
description
created_at
updated_at
```

Character와 Skill은 `character_skills(canon_space_id, character_id, skill_id)` 다대다 관계를 지원한다. 복합 Foreign Key가 Character와 Skill의 CanonSpace 일치를 강제한다.

추가 Canon 관리 대상의 논리 모델은 `items`, `relationships`, `timeline_events`다. 각 모델은 Work 또는 관련 Canon 엔터티를 참조하도록 구체화한다.

### Episode Memory

`episode_memories`

```text
id
episode_id
type
content
importance
created_at
updated_at
```

Episode Memory는 특정 회차에서 확인된 정보를 보관하지만 Canon이 아니다. 자동 추출된 Memory가 공식 사실로 승격되려면 Proposal과 작가 승인이 필요하다.

### Meeting Memory

`meeting_memories`

```text
id
work_id
episode_id
topic
status
summary
created_at
updated_at
```

`meeting_messages`

```text
id
meeting_id
employee_id
message_type
content
sequence
created_at
```

회의 자체와 순서를 가진 개별 발언을 분리해 Manager·Editor 등의 논의 흐름을 보존한다.

### Proposal과 Workflow

`proposals`

```text
id
work_id
source_type
source_id
proposal_type
content
status
created_at
resolved_at
```

Proposal은 아직 확정되지 않은 변경안이다. 작가가 승인하면 필요한 Canon 데이터에 반영할 수 있지만 Proposal 자체가 Canon을 직접 변경하지는 않는다.

`workflows`

```text
id
episode_id
current_state
created_at
updated_at
```

예상 상태는 `DRAFT`, `MANAGER_REVIEW`, `AUTHOR_REVISION`, `PROOFREADING`, `PROOFREADING_REVIEW`, `EDITOR_REVIEW`, `AUTHOR_APPROVAL`, `ILLUSTRATION_PLANNING`, `COMPOSITION_APPROVAL`, `ROUGH`, `ROUGH_APPROVAL`, `FINAL_ILLUSTRATION`, `PACKAGE`, `PUBLISHED`, `WAITING_RESOURCE`, `SKIPPED`, `ERROR`다. Workflow 실행 로직은 구현하지 않는다.

### Employee와 AI Usage

`employees`

```text
id
name
department
role
character_id
status
created_at
updated_at
```

Employee는 NovelCompany의 업무 수행 주체이고 Character는 소설 속 인물이다. `character_id`는 선택적으로 Persona 연결을 고려할 수 있으나 두 개념은 독립적이다.

`ai_usages`

```text
id
provider
model
department
episode_id
task_type
input_tokens
output_tokens
estimated_cost
created_at
```

AI Usage는 Provider·Department·Episode·Task별 사용량과 비용을 위한 관리 데이터다. AI 호출과 비용 계산은 아직 구현하지 않는다.

### Illustration metadata

`illustrations`

```text
id
episode_id
storage_key
type
status
prompt_version
created_at
updated_at
```

이미지 파일 자체는 SQLite에 넣지 않는다. 실제 PNG 등의 파일은 File Storage에 두고 SQLite에는 파일을 찾고 관리하기 위한 metadata만 둔다.

## CanonSpace scope migration

Migration 002부터 Canon은 Work에 직접 연결하지 않고 CanonSpace를 통해 간접 귀속된다.

```text
Work 1 : 0..1 CanonSpace

Work
  └─ CanonSpace (template_key = MODERN_FANTASY_V1)
      └─ Canon Entities
```

`canon_spaces.work_id`는 `works.id`를 `ON DELETE RESTRICT`로 참조하며 `UNIQUE(work_id)`로 한 Work당 하나의 CanonSpace만 허용한다. 현재 `template_key`는 `MODERN_FANTASY_V1`만 허용한다.

World, Location, Organization, Character, Attribute, Skill, Authority, Servant, Contract, Passive, CharacterRelationship 및 Character 연결 테이블은 모두 필수 `canon_space_id`를 가진다. Canon Entity는 `work_id`를 직접 저장하지 않는다. 복합 Foreign Key가 같은 CanonSpace 내부 참조만 허용해 교차 Canon 연결을 차단한다.

기존 Canon 데이터가 있는 001 DB는 소유 Work를 안전하게 추론할 수 없으므로 migration 002가 transaction 전체를 rollback한다. 기존 Canon을 자동 재귀속하거나 삭제하지 않는다.

현재 구현 Canon 모델은 `MODERN_FANTASY_V1`만 지원하며, 다른 장르·Shared Universe·Canon 상속·Fork·Template은 구현하지 않는다.

## 6. Episode와 TXT Storage 관계

```text
Episode metadata
  └─ storage_key
          ↓
EpisodeStorage
          ↓
LocalEpisodeStorage
          ↓
C:\NovelCompanyData\works\{workId}\episodes\005.txt
```

`storage_key`는 절대 경로가 아닌 논리 저장 키다. 예를 들어 `work-001/episodes/005.txt`를 SQLite에 저장할 수 있다. `C:\NovelCompanyData\works\work-001\episodes\005.txt` 같은 PC별 절대 경로는 SQLite에 저장하지 않는다.

현재 번호 기반 `works/<workId>/episodes/<3자리 이상 번호>.txt` 구조를 유지한다. 읽기는 저장된 key를 사용하고 번호 변경 없는 저장은 그 key를 보존한다. 번호를 바꾸면 새 번호 경로로 이동하고 DB key도 함께 변경한다. Renderer에는 key나 절대 경로를 노출하지 않는다. 빈 원고는 0-byte TXT이며 UTF-8 본문에 metadata를 삽입하지 않는다. 공백과 전달받은 줄바꿈을 정규화하지 않는다.

Task021 저장은 본문 UTF-8의 SHA-256을 content_hash에 기록한다. TXT가 원문 Source of Truth이며 hash를 통한 외부 편집 충돌 감지나 동기화는 구현하지 않았다. DB에 본문을 중복 저장하지 않는다. 실패 시 DB/TXT 복원과 잔류 backup 정책은 ARCHITECTURE의 Task021 orchestration을 따른다.

## 7. 전체 관계도

```text
WORK
├──< EPISODE
│     ├──< Episode Memory
│     ├── Workflow
│     └──< Illustration metadata
│
├──< World
│     ├──< World Rule
│     └──< Location
│           └──< Organization
│
├──< Character
│     ├── origin_world_id ──────> World
│     ├── origin_location_id ───> Location
│     ├── current_location_id ──> Location
│     ├── organization_id ──────> Organization
│     └──< Character Skill >───> Skill
│
├──< Proposal ──(author approval)──> Canon data
├──< Meeting Memory ───< Meeting Message
└──< AI Usage
```

Canon은 별도 단일 테이블이 아니라 작가가 승인한 World, Character, Skill, Location, Organization, Item, Relationship, Timeline Event 등의 공식 데이터 집합으로 관리한다.

## 8. TXT, SQLite, File Storage 경계

| 데이터 | TXT | SQLite | File Storage |
| --- | :---: | :---: | :---: |
| 소설 원문 | O | X | O |
| Work / Episode metadata | X | O | X |
| Canon / Character / Skill | X | O | X |
| World / World Rule / Location / Organization | X | O | X |
| Relationship / Timeline | X | O | X |
| Episode / Meeting Memory | X | O | X |
| Proposal / Workflow / Employee / AI Usage | X | O | X |
| Illustration metadata | X | O | X |
| Illustration image | X | X | O |

> TXT = 소설 원본

> SQLite = 작품을 이해하고 관리하기 위한 구조화된 정보

> File Storage = TXT와 이미지 등의 실제 파일

## 10. Generic Canon Definition (Task016)

Migration 003은 기존의 고정 Canon 테이블을 바꾸지 않고, Work별 CanonSpace 안에 사용자 정의가 가능한 범용 정의 계층을 추가한다.

Work → CanonSpace → CanonSet → CanonField → CanonFieldOption

CanonRecord는 CanonFieldValue, CanonRecordOptionValue, CanonRecordReference로 향후 실제 Canon 값을 저장한다. 모든 관계는 canon_space_id를 포함한 복합 Foreign Key로 같은 CanonSpace 안에만 참조되도록 제한한다. 정의와 레코드는 분리되어 있으며, 이번 단계의 초기 설정은 definition만 만들고 CanonRecord를 seed하지 않는다.

초기 템플릿 MODERN_FANTASY_V1은 11개 Set(세계, 지역, 조직, 속성, 스킬, 캐릭터, 권능, 권속, 패시브, 계약, 관계)과 각 Field/Option을 정의한다. 이 템플릿의 실제 레코드 작성과 수정은 이후 author approval 기반 기능의 범위다.

## 9. 향후 구현으로 미루는 항목

- Repository, CRUD API, DB IPC와 DB UI
- `storage_key`와 `content_hash`의 실제 저장·생성·비교
- Canon 승인 처리, Proposal 반영, Workflow 실행
- AI Agent, AI Usage 수집과 비용 계산
- Cloud Storage, PC 간 동기화, 충돌 해결, 파일 버전 관리
- Organization 다중 지부를 위한 다대다 확장

## 11. Task017 현재 구현 — Generic CanonRecord CRUD

위의 Repository/CRUD 미구현 설명은 이전 단계의 설계 이력이다. 현재 Generic CanonRecord의 작가 직접 생성/조회/수정/삭제가 구현되어 있다. Work/Episode의 기존 기능과 Legacy Canon 테이블은 보존한다.

`CanonSet → CanonField → Dynamic Form → CanonRecord → Scalar / Option / Reference`

| 저장소 | Task017 저장 내용 |
| --- | --- |
| canon_records | UUID, canon_space_id, canon_set_id, display_name, 생성/수정 UTC 시각 |
| canon_field_values | TEXT/LONG_TEXT의 text_value, NUMBER의 number_value, BOOLEAN의 boolean_value(0/1) 중 하나 |
| canon_record_option_values | 실제 해당 Field Option ID, 단일 또는 복수 행 |
| canon_record_references | 실제 target Set/Record ID, 단일 또는 복수 행 |

`CanonRecordInput`은 `{ displayName, fieldValues: { [fieldId]: value } }`다. 값은 string/number/boolean/null/string[] 중 하나이며 Field 정의에 따라 해석한다. optional null은 행을 만들지 않고 복수 빈 배열은 연결 행을 만들지 않는다. 이름을 별도 CanonField로 중복 저장하지 않는다. Read DTO는 없는 단일 값을 null, 없는 복수 값을 []로 복원한다.

모든 Record 요청은 `{ canonSpaceId, setId }`를 함께 전달한다. Repository가 Set/Record/Field의 범위를 확인하고 복합 FK도 교차 Canon 참조를 차단한다. Update는 transaction 안에서 기존 값을 전체 교체하며 semantic validation 또는 DB 쓰기 실패 시 이름/시각/값/참조 모두 되돌린다. 다른 Record가 참조 중인 항목은 삭제할 수 없다.

Migration `004_refine_initial_canon_field_requirements.sql`은 Organization.location, Character.origin_world/origin_location/current_location/attributes/passives를 required로 보정한다. Character.organization/skills/description은 optional이다. 기존 001/002/003은 변경하지 않는다. Record, Field ID, 입력값, Reference/Option 연결은 보존한다. 기존 불완전 Record를 임의로 채우지 않으며 다음 저장 때 필수 입력을 검증한다.

등록 가능 여부는 required Reference target Set에 실제 Record가 1개 이상 있는지로 결정한다. REFERENCE_MANY의 required는 최소 한 개 선택을 뜻한다. 같은 target Set을 여러 Field가 참조하면 blocker를 합친다. Contract/Relationship은 별도 의미 규칙으로 서로 다른 Character 2개를 요구한다. optional Reference는 0개여도 등록 가능하다.

Character Attribute >= 1, Passive >= 1, Skill >= 0, Organization nullable. Task022부터 출신 Location은 필수이고 origin_world는 선택이다. origin_world를 입력한 경우만 Location의 World와 일치해야 하며 Location 자체를 수정할 때도 이 조건을 재검증한다. current_location도 선택이고 출신 세계와 같은 세계를 강제하지 않는다. COMMON 패시브는 공유하고 UNIQUE는 단일 Character만 소유한다. Authority/Servant는 Character 생성 후 별도 Set에서 입력한다.

Future Rule: Generic Rule Engine, 권속 최대 1개, 중복 활성 계약, 관계 방향/중복 정책. 이번 변경은 정의 편집이나 규칙 작성 기능까지 확장하지 않는다.

### Task022 최종 필수 정책과 복구

| Character Field | required |
| --- | --- |
| origin_world | false |
| origin_location | true |
| current_location | false |
| organization | false |
| attributes | true, 최소 1개 |
| skills | false, 0개 허용 |
| passives | true, 최소 1개 |
| description | false |

display_name은 별도 필수값이다. `validateCharacterRequirements`는 create/update 모두에서 세 핵심 참조의 실제 선택을 재검증한다. `validateInput`은 타입, 실제 target Record, target Set와 CanonSpace를 확인한다. `validatePassiveOwnership`은 UNIQUE 소유를 최종 검증한다. Character 저장은 기존 Generic 4개 Record/value/reference 테이블만 사용하며 legacy characters 테이블에 중복 저장하지 않는다.

의존 관계는 World → Location → Character, Location → Organization, Attribute → Character, Passive → Character, Character → Authority/Servant/Contract/Relationship이다. Character readiness는 지역/속성/패시브 Record 각 1개다. 계약/관계는 서로 다른 캐릭터 2명 이상을 요구하고 자기 참조를 차단한다. relationship_type은 Task022에서 필수 TEXT로 정제했다.

005는 정확한 초기 정의 구조만 대상으로 Character.origin_world/current_location을 optional, Relationship.relationship_type을 required로 바꾼다. 기존 ID/Record/값/참조는 변경하지 않는다. 기존 불완전 Record를 자동 채우지 않고 다음 저장에서 검증한다. 이번 운영 read-only 점검 당시 정의와 Record가 모두 0개여서 필수 강화로 무효화되는 기존 Record는 없었다.

Task016 Single Source의 원본은 11 Set/30 Field/4 Option이다. 별도 명시적 Bootstrap은 원본 정의를 순서대로 복원한 뒤 같은 transaction에서 현재 required 정책으로 정제한다. CanonSpace ID는 유지하고 Record는 0개로 유지한다. Canon 시작에서 자동 설치하지 않으며 부분 정의는 merge하지 않는다. 운영 적용 전후 점검 결과는 0/0/0/0 → 11/30/4/0이었다.

## 16. Task024 — ReviewRun / ReviewFinding

`review_runs`는 `id`, `work_id`, `episode_id`, `status(RUNNING|COMPLETED|FAILED)`, `processor_key`, `episode_content_hash`, `canon_context_hash`, `error_code`, 생성/시작/완료 시각을 보존한다. Work와 Episode FK는 `ON DELETE RESTRICT`이며 cascade를 사용하지 않는다. Episode별 RUNNING Run은 partial unique index로 하나만 허용한다.

`review_findings`는 Run별 immutable 결과로 `id`, `review_run_id`, `category`, `message`, `sort_order`, `created_at`을 보관한다. 원고 본문, WorkContext JSON, Canon JSON은 어느 review table에도 저장하지 않는다. freshness는 저장된 두 hash와 현재 WorkContext에서 한 번 계산한 hash를 비교하는 derived DTO이며 DB status를 STALE로 바꾸지 않는다.

## 15. Task023 — Derived WorkContext

WorkContext는 DB table, migration, snapshot이 아닌 요청 시점의 derived read model이다. 저장된 Episode TXT와 Episode metadata, 동일 Work의 Generic Canon을 조합해 생성하며 다시 DB에 저장하지 않는다.

WorkContext = scope(FULL_CANON) + work(id,title) + episode(id,number,title,status,TXT content,contentHash) + canon(summary, sets, records, fields)

Scalar empty value는 null, OPTION_ONE은 null 또는 key/label 객체, OPTION_MANY는 배열, REFERENCE_ONE은 null 또는 recordId/setKey/displayName 객체, REFERENCE_MANY는 배열이다. Work/Episode/Canon record ID는 안정적인 identity로 남기되 Set/Field/Option의 내부 ID와 storageKey/파일 경로는 public DTO에서 제외한다.

## 12. Task018 — Work metadata CRUD

기존 works의 id/title/description/status/created_at/updated_at을 그대로 사용한다. Schema 변경과 신규 migration은 없다. title은 필수 문자열이며 trim 후 저장하고 중복을 허용한다. description은 optional string/null이며 Work DTO의 description은 기존처럼 string(null → 빈 문자열)이다. status는 ACTIVE/PAUSED/COMPLETED, 기본값은 ACTIVE다.

Work 생성은 works 한 행만 INSERT한다. Episode, CanonSpace, CanonSet, CanonField 및 파일은 자동 생성하지 않는다. Work가 먼저 존재하고 Canon 구조는 이후 별도 설정에서 연결한다. 새 Work의 컨셉정리는 `아직 이 작품의 Canon 설정이 없습니다.`가 정상 상태다.

`WorkDeletionStatus = { canDelete: boolean, episodeCount: number, hasCanonSpace: boolean }`.

getWorkDeletionStatus의 SQL은 대상 works 행에 대해 episodes.work_id의 COUNT와 canon_spaces.work_id의 EXISTS를 함께 계산한다. canDelete는 episodeCount === 0 && !hasCanonSpace다. CanonSpace 내부의 CanonRecord 개수와 Episode TXT 내용은 삭제 조건에 사용하지 않는다.

deleteWork는 transaction 안에서 같은 상태 계산을 다시 실행하고 조건을 만족할 때만 `DELETE FROM works WHERE id = ?`를 실행한다. 의존 데이터가 있거나 SQL이 실패하면 rollback한다. Episode/CanonSpace를 지우거나 파일을 정리하지 않고 기존 FK RESTRICT를 유지한다. 삭제 성공 DTO는 `{ id }`다.

Canon 구조 편집/복사, Episode 생성 UI 및 강제 삭제/Archive 정책은 별도 Task에서 정의한다.

## 13. Task019 — 빈 CanonSpace

`Work → 1 : 0..1 CanonSpace → 1 : 0..N CanonSet`. CanonSpace가 있어도 Set이 0개일 수 있으며 정상적인 빈 Canon 상태다.

Work와 CanonSpace의 관계는 1 : 0..1이다. `createCanonSpaceForWork(workId)`는 존재하는 Work에 UUID, work_id, template_key, 생성/수정 UTC ISO 시각을 가진 canon_spaces 한 행만 만든다. CanonSet/Field/Option/Record, Episode 및 TXT는 생성하지 않는다. 기존 ID/FK/Definition은 보존하며 신규 migration은 없다.

`template_key = MODERN_FANTASY_V1`은 기존 CHECK와 호환되는 legacy metadata다. Preset 선택이 아니며 실제 Canon 구조는 canon_sets/canon_fields 데이터가 결정한다. UI에는 template 이름을 표시하지 않는다. 공간만 생성된 상태도 `hasCanonSpace = true`이므로 일반 작품 삭제를 막는다.

## 14. Task020 — Canon 전체 삭제의 소유 범위

CanonSpace 아래의 두 계층은 같은 작품 Canon lifecycle에 종속된다. Generic의 `canon_sets`, `canon_fields`, `canon_field_options`, `canon_records`, `canon_field_values`, `canon_record_option_values`, `canon_record_references` 7개 테이블과 Legacy의 `worlds`, `locations`, `organizations`, `characters`, `attributes`, `skills`, `passives`, `character_attributes`, `character_skills`, `character_passives`, `character_relationships`, `contracts`, `servants`, `authorities` 14개 테이블을 포함한다.

Generic 값/참조는 Record와 Field를 함께 참조하고 option value는 Field Option도 참조한다. Field.reference_set_id가 다른 Set을 가리킬 수 있어 모든 Field를 지운 뒤 Set을 지운다. Legacy 연결/소유 테이블은 Character와 독립 속성/스킬/패시브를 참조하며 Character → Organization → Location → World 의존 순서가 있다. 모든 FK는 기존 RESTRICT를 유지한다.

`CanonDeletionStatus`는 exists, canonSpaceId, setCount, fieldCount, optionCount, recordCount, fieldValueCount, recordOptionValueCount, referenceCount, legacyDataCount, totalDependentRowCount를 반환한다. 전체 의존 행 수에는 CanonSpace 자체를 포함하지 않는다. Work만 있으면 exists=false, canonSpaceId=null, 모든 count=0이다. 없는 Work는 WORK_NOT_FOUND이며 공간 없는 실제 삭제는 CANON_SPACE_NOT_FOUND다.

`deleteCanonForWork(workId)` 성공 DTO는 `{ workId, deletedCanonSpaceId }`다. 공간 소속 행과 공간만 제거하며 Work와 Episode metadata 및 파일은 소유 삭제 범위 밖이다. 삭제 이후 `hasCanonSpace=false`; Work 삭제 가능 여부는 여전히 Episode 개수와 함께 판단한다.
