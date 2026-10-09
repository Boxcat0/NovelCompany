import { narrationLabels } from './SceneNarrationEditor';
import type { ReviewContext } from '../types/electron-api';

const labels: Record<string, string> = { MATCHED: '일치', NOT_FOUND: '미등록', AMBIGUOUS: '모호함', UNRESOLVED: '연결 미확정', UNKNOWN: '미확정', MISMATCH_CANDIDATE: '보유 참조 불일치 후보', UNVERIFIABLE_OWNER: '사용 주체 검증 불가', CANON_NOT_FOUND: '능력 Canon 미등록', SKILL: '스킬', PASSIVE: '패시브', SKILL_OR_PASSIVE: '스킬 또는 패시브 미확정', AUTHORITY: '권능', SERVANT: '권속', DIRECT_MENTION: '직접 언급', LOCATION_HEADER: '장소 표제', NOTATION: '능력 표기', CHARACTER_REFERENCE: '인물 직접 참조', CHARACTER_AUTHORITY: '인물 소유 권능', CHARACTER_SERVANT: '인물 소유 권속', CHARACTER_RELATIONSHIP: '인물 관계', CHARACTER_CONTRACT: '인물 계약', RELATED_PARTICIPANT: '관계 상대 식별 정보' };
labels.EXPLICIT_ABILITY_ACTOR = '명시적인 능력 사용 주체';
labels.DIALOGUE = '대사';
labels.INNER_OR_CONTRACT_DIALOGUE = '생각 또는 계약자 대화';
labels.SYSTEM_NOTIFICATION = '시스템 알림';
labels.LOCATION_HEADER = '장소 표제';
labels.INVALID = '해석 불가 표기';
labels.SKILL_REQUIRED_ATTRIBUTE = '스킬 필요 속성';
labels.CHARACTER_DISPLAY_NAME = '인물 정식 이름';
labels.CHARACTER_REGISTERED_ALIAS = '등록된 인물 별칭';

/** 읽기 전용 분석 DTO를 Scene·선택 이유·능력 보유 검증별로 요약하고 상세는 펼쳐서 보여준다. */
export function ReviewContextPreview({ context }: { context: ReviewContext }) {
  const records = context.relevantCanon.selectedRecords;
  /** 공개 Canon identity로 화면에 표시할 이름을 찾는다. */
  function name(id: string | null) { return records.find(record => record.id === id)?.displayName ?? '미확정'; }
  return <section aria-label="검토 컨텍스트 미리보기" className="review-context-preview">
    <h3>검토 컨텍스트 · 읽기 전용</h3>
    <p>저장된 원고 기준 · Scene {context.scenes.length}개 · 관련 Canon {records.length}개 (중복 제거) · 실제 AI 검토는 수행하지 않습니다.</p>
    <p>원문 위치는 UTF-16 기준이며 시작을 포함하고 끝을 제외합니다. 인물 언급은 물리적 등장을 확정하지 않습니다.</p>
    <details><summary>인물 명칭 후보 · {context.nameMentions.length}개</summary>
      <p>등록 명칭에 연결되는 후보입니다. 문맥상 실제 지시 대상과 대사 화자는 확정하지 않습니다.</p>
      <ul>{context.nameMentions.map((mention, index) => <li key={index}>{mention.text} · {labels[mention.status]} · Scene {mention.sceneIndex} · {mention.range.start}–{mention.range.end}{mention.quoteContext && ` · ${labels[mention.quoteContext]}`}<ul>{mention.candidates.map(candidate => <li key={candidate.recordId}>{candidate.displayName} — {candidate.organization?.displayName ?? '소속 미설정'} · {candidate.matchTypes.map(type => type === 'DISPLAY_NAME' ? '정식 이름' : '등록 별칭').join(', ')}</li>)}</ul>{mention.status === 'AMBIGUOUS' && <p>여러 캐릭터가 같은 명칭을 사용합니다. 문맥에 따른 실제 지시 대상은 아직 확정되지 않았습니다.</p>}</li>)}</ul>
    </details>
    <details><summary>Scene 및 원문 표기</summary>{context.scenes.map(scene => <section key={scene.index}>
      <h4>Scene {scene.index} · {scene.locationHeading ?? '무표제'}</h4>
      <p>장소: {labels[scene.resolvedLocation.status]} · 서술 시점: {narrationLabels[scene.narration.mode]} · {scene.narration.narratorCharacter?.displayName ?? '서술자 없음'} · {scene.narration.source === 'AUTHOR_SET' ? '작가 지정' : '미설정'} · 범위 {scene.originalRange.start}–{scene.originalRange.end}{scene.timeHintRaw && ` · 시간 표현: ${scene.timeHintRaw}`}</p>
      <ul>{scene.directMentions.map((mention, i) => <li key={i}>{mention.name} · {labels[mention.status]} · {mention.range.start}–{mention.range.end}</li>)}</ul>
      <ul>{scene.notationOccurrences.map((notation, i) => <li key={i}>{notation.raw} · {labels[notation.canonType ?? notation.type] ?? notation.type}{notation.resolution && ` · ${labels[notation.resolution.status]}`}{notation.quoteContext && ' · 인용문 안의 표기'}</li>)}</ul>
    </section>)}</details>
    <details><summary>직접 탐지 및 관련 Canon · {records.length}개</summary><ul>{records.map(record => <li key={record.id}><strong>{record.displayName}</strong> · {record.setLabel}<ul>{context.relevantCanon.selectionReasons.filter(reason => reason.recordId === record.id).map((reason, i) => <li key={i}>{labels[reason.reason] ?? reason.reason} · Scene {reason.sceneIndex}</li>)}</ul></li>)}</ul></details>
    <details><summary>스킬·패시브 보유 검증 · {context.abilityOwnershipChecks.length}개</summary><ul>{context.abilityOwnershipChecks.map((check, i) => <li key={i}>Scene {check.sceneIndex} · {check.raw} · {labels[check.type]} · 사용자: {name(check.actorCharacterId)} · {labels[check.result]}<p>{check.evidence} {check.unresolvedReason}</p></li>)}</ul></details>
    <details><summary>미확정 지시 표현 후보 및 이름 · {context.unresolvedMentions.length}개</summary><ul>{context.unresolvedMentions.map((mention, i) => <li key={i}>{mention.raw} · Scene {mention.sceneIndex} · {mention.range.start}–{mention.range.end} · {labels[mention.status]}</li>)}</ul></details>
    {context.warnings.length > 0 && <details><summary>분석 경고 · {context.warnings.length}개</summary><ul>{context.warnings.map((warning, i) => <li key={i}>{warning.message} ({warning.range.start}–{warning.range.end})</li>)}</ul></details>}
  </section>;
}
