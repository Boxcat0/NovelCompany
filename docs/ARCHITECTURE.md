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

현재 구현 단계에는 Electron, React, TypeScript 기반의 최소 Desktop Shell만 있다. Phaser와 SQLite는 확정된 기술 선택이지만 아직 추가하거나 구현하지 않는다.

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

React UI는 사용자와 시스템의 접점이고, Workflow Engine은 작업의 상태와 순서를 조정한다. AI Provider Layer는 AI 공급자별 차이를 분리한다. 데이터와 메모리는 향후 SQLite에 로컬로 저장한다.

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

## 향후 확장

다음 항목은 확장 계획이며 현재 구현 범위에 포함하지 않는다.

- Discord Notification
- Naver Publishing Adapter
- Employee Recruitment
- AI Meetings
- Mobile
