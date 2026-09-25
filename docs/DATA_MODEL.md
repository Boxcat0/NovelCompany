# NovelCompany 데이터 모델 설계

## 1. 목적과 범위

이 문서는 SQLite Schema v1과 CanonSpace scope migration의 논리 데이터 모델 및 TXT 파일 저장소 경계를 정의한다. `node:sqlite`로 `C:\NovelCompanyData\novelcompany.db`를 생성하고 순차 migration을 적용한다. Work/Episode Repository와 읽기 전용 IPC/UI는 구현되어 있으며, Canon Repository, Canon IPC와 Canon CRUD UI는 구현하지 않는다.

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

`work_id`는 Work를 참조한다. 현재 TypeScript의 `Episode.workId` 관계를 SQLite에서도 유지한다. `storage_key`와 `content_hash`는 향후 필드이며 아직 생성·저장하지 않는다.

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

현재 Task 007의 `LocalEpisodeStorage`는 `workId`와 `episodeNumber`로 동일한 로컬 파일 위치를 계산한다. 이후 SQLite 도입 시 Episode의 `storage_key`는 Storage 구현체가 파일을 찾는 논리 식별자가 된다.

`content_hash`는 향후 TXT 본문 변경 감지, AI 분석 대상 변경 감지, 클라우드 동기화와 충돌 감지에 사용할 수 있다. 이번 Task에서는 hash 생성이나 비교를 구현하지 않는다.

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
