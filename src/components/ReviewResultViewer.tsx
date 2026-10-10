import type { ReviewRun } from '../types/electron-api';

const categories: Record<string, string> = { TEXT: '문장', TYPO: '오탈자', SPACING: '띄어쓰기', GRAMMAR: '문법', CANON: 'Canon', NARRATION: '서술 시점', NAME_RESOLUTION: '이름 해석', CONTINUITY: '연속성', OTHER: '기타' };
const severity = { INFO: '정보', WARNING: '주의', ERROR: '중요 확인' };
const assessment = { DETERMINISTIC: '명시 입력·규칙 근거', INFERENCE_CANDIDATE: '추론 후보', UNDETERMINED: '판정 미확정' };
const roles = { CONTEXT_RECORD: 'Context 연결', NAME_CANDIDATE: '등록 명칭 후보', AMBIGUOUS_CANDIDATE: '모호한 명칭 후보' };

/** 저장 당시 근거를 안전한 텍스트로 표시하고 Processor별 실제 검사 범위와 빈 결과를 설명한다. */
export function ReviewResultViewer({ reviews }: { reviews: ReviewRun[] }) {
  return <ul className="review-history">{reviews.map(review => <li key={review.id} data-review-run-id={review.id}>
    <strong>{review.status === 'RUNNING' ? '검토 중' : review.status === 'COMPLETED' ? '완료' : '실패'}</strong> · {review.processorKey} · {new Date(review.createdAt).toLocaleString('ko-KR')}
    <p>결과 계약: {review.contractVersion ?? (review.status === 'COMPLETED' ? 'Legacy · 근거 계약 도입 이전' : '결과 미저장')} · Finding {review.findings.length}건</p>
    {review.processorKey === 'MOCK_V1' && <p>테스트용 가상 검토 결과입니다. 실제 원고의 오류를 판정한 결과가 아닙니다.</p>}
    {review.status === 'COMPLETED' && review.processorKey === 'STUB_V1' && <p>검토 처리 흐름이 완료되었습니다. 실제 원고 검토는 아직 수행되지 않았습니다.</p>}
    {review.processorKey === 'RULE_V1' && <>
      <p>검사 범위: 현재 회차의 Relevant Canon에 포함된 Character–Skill–Attribute 등록 관계 · 규칙 CHARACTER_SKILL_ATTRIBUTE_MISMATCH_V1 (V1)</p>
      <p>완전한 참조 목록과 필요한 Record가 제공된 관계만 검사합니다. 정보가 부족한 관계는 판단을 보류합니다. 실제 스킬 사용자와 작품 설정 오류를 확정하지 않습니다.</p>
      {review.status === 'COMPLETED' && review.findings.length === 0 && <p>현재 RULE_V1이 검사한 Canon 관계에서 확인이 필요한 불일치가 발견되지 않았습니다. 작품 전체의 무오류를 보장하지 않습니다.</p>}
    </>}
    {review.status === 'FAILED' && <p>검토 작업을 완료하지 못했습니다.</p>}
    {review.status === 'RUNNING' && <p>검토가 진행 중입니다.</p>}
    <p>{review.freshness.isCurrent ? '현재 추적 중인 검토 입력과 일치합니다.' : review.freshness.canonComparison === 'UNAVAILABLE' ? '현재 입력을 읽을 수 없어 현재성을 비교할 수 없습니다. 저장된 검토 당시 근거를 표시합니다.' : [review.freshness.episodeChanged && '원고가 변경됨', review.freshness.canonChanged && 'Canon이 변경됨'].filter(Boolean).join(' · ')}</p>
    {review.freshness.sceneMetadataComparison === 'CHANGED' && <p>장면 시점 설정이 변경됨</p>}
    {review.freshness.sceneMetadataComparison === 'LEGACY_NOT_TRACKED' && <p>이전 검토 기록은 장면 시점을 추적하지 않습니다.</p>}
    {review.freshness.sceneMetadataComparison === 'UNDETERMINED_EPISODE_CHANGED' && <p>원고가 바뀌어 장면 시점의 독립적인 변경 여부는 판정할 수 없습니다.</p>}
    {review.freshness.canonComparison === 'UNDETERMINED_EPISODE_CHANGED' && <p>원고가 바뀌어 관련 Canon의 독립적인 변경 여부는 판정할 수 없습니다. 저장본 기준으로 다시 실행해 주세요.</p>}
    {review.findings.length > 0 && <details><summary>검토 결과 상세 · {review.findings.length}건</summary>
      <p>심각도와 판단 확실성은 별개입니다. 명시 근거가 있어도 작품 설정 오류의 확정을 뜻하지 않습니다.</p>
      <ol>{review.findings.map(finding => <li key={finding.id} data-finding-id={finding.id}>
        <strong>[{categories[finding.category] ?? finding.category}] {finding.message}</strong>
        {finding.contractVersion === null ? <p>Legacy 결과: 당시 근거·심각도·판단 확실성이 기록되지 않았습니다.</p> : <>
          <p>{severity[finding.severity]} ({finding.severity}) · {assessment[finding.assessment]} ({finding.assessment})</p>
          {finding.anchor.type === 'TEXT_RANGE' ? <>
            <p>검토 당시 원문 · UTF-16 [{finding.anchor.range.start}, {finding.anchor.range.end}) · 장면 {finding.anchor.sceneIdentity ?? '미지정'}</p>
            <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{finding.anchor.sourceExcerpt}</blockquote>
          </> : <p>Canon Record 근거 · 원문 범위 없음</p>}
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>판단 근거: {finding.evidence}</p>
          {finding.suggestion && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>제안 사항: {finding.suggestion}</p>}
          <ul>{finding.relatedCanonRecords.map((record, index) => <li key={index}>
            {record.displayNameAtReview} · {record.setKey} · {roles[record.referenceRole]} · ID {record.recordId}
            {record.mention && <p>명칭: {record.mention.text} · [{record.mention.range.start}, {record.mention.range.end}) · 당시 소속: {record.organization?.displayNameAtReview ?? '미설정'} · 실제 지시 대상 미확정</p>}
          </li>)}</ul>
          <p>출처: {finding.provenance.processorKey} · {finding.contractVersion}</p>
        </>}
      </li>)}</ol>
    </details>}
  </li>)}</ul>;
}
