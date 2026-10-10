const { textResult } = require('./finding-fixtures.cjs');
const MOCK_TITLE = 'Task029 가상 작품';
const MOCK_CONTENT = '별칭 세계\r\n😀 은빛은 문을 보았다.\r\n한지수는 기다렸다.\n{닫히지 않은 표기';

/** 고정 가상 작품만 받는 테스트 Processor이며 운영 Main·IPC에서는 가져오지 않는다. */
function createMockReviewProcessor(mode = 'MULTIPLE') {
  return { processorKey: 'MOCK_V1',
    /** 입력 내용으로 오류를 판정하지 않고 고정 성공·실패 fixture를 반환한다. */
    async review(context) {
      if (context.work.title !== MOCK_TITLE || context.episode.content !== MOCK_CONTENT) throw new Error('격리 가상 입력만 사용할 수 있습니다.');
      if (mode === 'THROW') throw new Error('가상 Processor 실패: ' + MOCK_CONTENT);
      const result = textResult(context, '<img src=x onerror="window.findingInjected=true"> 가상 원문 확인');
      const first = result.findings[0];
      first.anchor.range = { start: 7, end: 9 };
      first.anchor.sourceExcerpt = context.episode.content.slice(7, 9);
      first.anchor.sceneIdentity = context.scenes.find(scene => scene.originalRange.start <= 7 && scene.originalRange.end >= 9).identity;
      const world = context.relevantCanon.selectedRecords.find(record => record.setKey === 'world');
      const canon = { ...first, category: 'CANON', severity: 'ERROR', assessment: 'INFERENCE_CANDIDATE', message: '가상 Canon 확인 후보', anchor: { type: 'CANON_RECORD' }, relatedCanonRecords: [{ recordId: world.id, setKey: 'world', referenceRole: 'CONTEXT_RECORD' }] };
      const mentionIndex = context.nameMentions.findIndex(mention => mention.status === 'AMBIGUOUS');
      const mention = context.nameMentions[mentionIndex];
      const ambiguous = { ...first, category: 'NAME_RESOLUTION', severity: 'WARNING', message: '가상 별칭의 지시 대상 미확정', anchor: { type: 'TEXT_RANGE', range: mention.range, sceneIdentity: mention.sceneIdentity, sourceExcerpt: mention.text },
        relatedCanonRecords: mention.candidates.map(candidate => ({ recordId: candidate.recordId, setKey: 'character', referenceRole: 'AMBIGUOUS_CANDIDATE', mentionIndex })) };
      if (mode === 'EMPTY') result.findings = [];
      else if (mode === 'CANON') result.findings = [canon];
      else if (mode === 'AMBIGUOUS') result.findings = [ambiguous];
      else if (['MULTIPLE', 'STORAGE_FAILURE'].includes(mode)) result.findings = [first, canon, ambiguous];
      else if (mode === 'INVALID_RANGE') first.anchor.range.end = 999999;
      else if (mode === 'INVALID_EXCERPT') first.anchor.sourceExcerpt = '다른 발췌';
      else if (mode === 'INVALID_CANON') first.relatedCanonRecords = [{ recordId: '다른 작품 ID', setKey: 'character', referenceRole: 'CONTEXT_RECORD' }];
      else if (mode === 'MISSING_FIELD') delete first.evidence;
      else if (mode === 'PARTIAL_INVALID') result.findings = [first, canon, { ...ambiguous, evidence: '' }];
      else if (mode !== 'TEXT') throw new Error('지원하지 않는 가상 결과입니다.');
      return result;
    } };
}

module.exports = { createMockReviewProcessor, MOCK_TITLE, MOCK_CONTENT };
