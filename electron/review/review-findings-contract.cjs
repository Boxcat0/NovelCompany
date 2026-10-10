const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const CONTRACT_VERSION = 'REVIEW_FINDINGS_V1';
const categories = new Set(['TEXT', 'CANON', 'NARRATION', 'NAME_RESOLUTION', 'CONTINUITY', 'OTHER', 'TYPO', 'SPACING', 'GRAMMAR']);
const severities = new Set(['INFO', 'WARNING', 'ERROR']);
const assessments = new Set(['DETERMINISTIC', 'INFERENCE_CANDIDATE', 'UNDETERMINED']);
const validatedResults = new WeakMap();

/** 출력이나 원고를 오류에 포함하지 않고 안정적인 공개 오류를 생성한다. */
function invalid(code = 'REVIEW_RESULT_INVALID') {
  throw new RepositoryError(code, code === 'REVIEW_FINDING_RANGE_INVALID' ? '검토 결과의 원문 위치 또는 발췌가 올바르지 않습니다.' : code === 'REVIEW_FINDING_CANON_INVALID' ? '검토 결과의 Canon 참조 또는 후보 구분이 올바르지 않습니다.' : '검토 결과 형식 또는 근거가 올바르지 않습니다.');
}

/** JSON 객체의 허용 키만 받으며 Processor가 ID·정렬·출처를 주입하지 못하게 한다. */
function object(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) invalid(code);
}

/** 빈 근거와 과도한 문자열을 거부하되 원문 문자는 정규화하지 않는다. */
function text(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(code);
  return value;
}

/** 선택된 Canon과 명시된 1-hop 참조·작가 지정 서술자의 최소 식별 정보를 수집한다. */
function contextRecords(context) {
  const records = new Map();
  /** 신뢰된 Context의 식별 정보만 복사한다. */
  function add(record) { if (record?.recordId && record.setKey) records.set(record.recordId, record); }
  for (const record of context.relevantCanon.selectedRecords) {
    const reasons = context.relevantCanon.selectionReasons.filter(item => item.recordId === record.id);
    const nameOnly = record.setKey === 'character' && reasons.length && reasons.every(item => ['CHARACTER_DISPLAY_NAME', 'CHARACTER_REGISTERED_ALIAS'].includes(item.reason));
    if (!nameOnly) add({ recordId: record.id, setKey: record.setKey, displayName: record.displayName });
    for (const field of record.fields) {
      if (field.valueType === 'REFERENCE_ONE') add(field.value);
      if (field.valueType === 'REFERENCE_MANY') field.value.forEach(add);
    }
  }
  for (const scene of context.scenes) add(scene.narration?.narratorCharacter);
  return records;
}

/** TEXT_RANGE를 실행 당시 UTF-16 원문 및 지정 Scene의 포함 범위와 대조한다. */
function validateAnchor(anchor, context) {
  const code = 'REVIEW_FINDING_RANGE_INVALID';
  object(anchor, ['type', 'range', 'sceneIdentity', 'sourceExcerpt'], code);
  if (anchor.type === 'CANON_RECORD') {
    if (Object.keys(anchor).length !== 1) invalid(code);
    return { type: 'CANON_RECORD' };
  }
  if (anchor.type !== 'TEXT_RANGE') invalid(code);
  object(anchor.range, ['start', 'end'], code);
  const { start, end } = anchor.range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > context.episode.content.length) invalid(code);
  if (typeof anchor.sourceExcerpt !== 'string' || !anchor.sourceExcerpt.length || anchor.sourceExcerpt.length > 16000) invalid(code);
  if (anchor.sourceExcerpt !== context.episode.content.slice(start, end)) invalid(code);
  if (anchor.sceneIdentity !== null) {
    text(anchor.sceneIdentity, 256, code);
    const scene = context.scenes.find(item => item.identity === anchor.sceneIdentity);
    if (!scene || start < scene.originalRange.start || end > scene.originalRange.end) invalid(code);
  }
  return { type: 'TEXT_RANGE', range: { start, end }, sceneIdentity: anchor.sceneIdentity, sourceExcerpt: anchor.sourceExcerpt };
}

/** 실행 Context 밖 참조·Set 혼동·후보 승격·복수 후보 누락을 거부하고 표시 snapshot을 만든다. */
function validateReferences(drafts, context, records) {
  const code = 'REVIEW_FINDING_CANON_INVALID';
  if (!Array.isArray(drafts) || drafts.length > 100) invalid(code);
  const seen = new Set();
  const groups = new Map();
  const snapshots = Array.from(drafts, draft => {
    object(draft, ['recordId', 'setKey', 'referenceRole', 'mentionIndex'], code);
    text(draft.recordId, 256, code);
    text(draft.setKey, 128, code);
    const key = `${draft.recordId}:${draft.referenceRole}:${draft.mentionIndex ?? ''}`;
    if (seen.has(key)) invalid(code);
    seen.add(key);
    let record;
    let mention = null;
    if (draft.referenceRole === 'CONTEXT_RECORD') {
      if (draft.mentionIndex !== undefined) invalid(code);
      record = records.get(draft.recordId);
    } else if (['NAME_CANDIDATE', 'AMBIGUOUS_CANDIDATE'].includes(draft.referenceRole)) {
      if (!Number.isSafeInteger(draft.mentionIndex) || draft.mentionIndex < 0) invalid(code);
      mention = context.nameMentions?.[draft.mentionIndex];
      if (!mention || (mention.status === 'AMBIGUOUS' ? 'AMBIGUOUS_CANDIDATE' : 'NAME_CANDIDATE') !== draft.referenceRole) invalid(code);
      const candidate = mention.candidates.find(item => item.recordId === draft.recordId);
      if (candidate) record = { ...candidate, setKey: 'character' };
      if (!groups.has(draft.mentionIndex)) groups.set(draft.mentionIndex, new Set());
      groups.get(draft.mentionIndex).add(draft.recordId);
    } else invalid(code);
    if (!record || record.setKey !== draft.setKey) invalid(code);
    return { recordId: record.recordId, setKey: record.setKey, displayNameAtReview: record.displayName, referenceRole: draft.referenceRole,
      ...(mention ? { mentionIndex: draft.mentionIndex, mention: { text: mention.text, range: { ...mention.range }, sceneIdentity: mention.sceneIdentity, status: mention.status },
        organization: record.organization ? { recordId: record.organization.recordId, setKey: record.organization.setKey, displayNameAtReview: record.organization.displayName } : null } : {}) };
  });
  for (const [index, ids] of groups) if (context.nameMentions[index].candidates.some(candidate => !ids.has(candidate.recordId))) invalid(code);
  return snapshots;
}

/** 검증 결과를 재귀 동결하여 검증 후 저장 사이의 값 변경을 막는다. */
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** 전체 Result를 검증하고 DB 식별자 없이 신뢰된 출처를 갖는 immutable 저장 초안을 반환한다. */
function validateReviewProcessorResult(result, context, processorKey) {
  object(result, ['contractVersion', 'findings']);
  if (result.contractVersion !== CONTRACT_VERSION || !Array.isArray(result.findings) || result.findings.length > 100) invalid();
  text(processorKey, 128);
  const records = contextRecords(context);
  const findings = Array.from(result.findings, draft => {
    object(draft, ['category', 'severity', 'assessment', 'anchor', 'evidence', 'message', 'suggestion', 'relatedCanonRecords']);
    if (!categories.has(draft.category) || !severities.has(draft.severity) || !assessments.has(draft.assessment)) invalid();
    const anchor = validateAnchor(draft.anchor, context);
    const relatedCanonRecords = validateReferences(draft.relatedCanonRecords, context, records);
    if (anchor.type === 'CANON_RECORD' && !relatedCanonRecords.length) invalid('REVIEW_FINDING_CANON_INVALID');
    return { category: draft.category, severity: draft.severity, assessment: draft.assessment, anchor,
      evidence: text(draft.evidence, 8000), message: text(draft.message, 2000), suggestion: draft.suggestion === null ? null : text(draft.suggestion, 4000), relatedCanonRecords,
      contractVersion: CONTRACT_VERSION, provenance: { processorKey } };
  });
  const validated = freeze({ contractVersion: CONTRACT_VERSION, findings });
  if (JSON.stringify(validated).length > 500000) invalid();
  validatedResults.set(validated, { workId: context.work.id, episodeId: context.episode.id, processorKey });
  return validated;
}

/** Repository가 검증되지 않은 결과나 다른 실행의 결과를 저장하지 않게 한다. */
function assertValidatedResult(result, run) {
  const scope = validatedResults.get(result);
  if (!scope || scope.workId !== run.work_id || scope.episodeId !== run.episode_id || scope.processorKey !== run.processor_key) invalid();
}

/** Processor에는 분리 복사본만 전달하고 변조되지 않은 실행 Context 및 설정 출처로 검증한다. */
async function executeReviewProcessor(processor, context) {
  const processorKey = processor.processorKey;
  const result = await processor.review(structuredClone(context));
  return validateReviewProcessorResult(result, context, processorKey);
}

module.exports = { CONTRACT_VERSION, validateReviewProcessorResult, executeReviewProcessor, assertValidatedResult };
