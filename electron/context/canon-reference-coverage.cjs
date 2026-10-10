const COVERAGE_VERSION = 'CANON_REFERENCE_LISTS_V1';

/** FULL_CANON에서 축약 없이 복사한 선택 Character의 참조 목록 완전성을 표시한다. */
function buildCanonReferenceCoverage(workId, records) {
  return { version: COVERAGE_VERSION, workId, characters: records.filter(record => record.setKey === 'character').map(record => {
    const fields = {};
    for (const [key, setKey] of [['attributes', 'attribute'], ['skills', 'skill']]) {
      const matches = record.fields.filter(field => field.key === key);
      const field = matches[0];
      if (matches.length !== 1 || field.valueType !== 'REFERENCE_MANY' || !Array.isArray(field.value) || Array.from(field.value).some(ref => !ref || ref.setKey !== setKey || typeof ref.recordId !== 'string' || !ref.recordId)) continue;
      const recordIds = field.value.map(ref => ref.recordId).sort();
      if (new Set(recordIds).size !== recordIds.length) continue;
      fields[key] = { complete: true, recordIds };
    }
    return { recordId: record.id, fields };
  }).sort((a, b) => a.recordId.localeCompare(b.recordId, 'en')) };
}

/** Processor에서 표시와 실제 목록 ID가 일치할 때만 전체 참조 목록으로 인정한다. */
function completeReferenceList(context, record, key, setKey) {
  if (!Array.isArray(record.fields)) return null;
  const coverage = context.canonReferenceCoverage;
  if (!coverage || coverage.version !== COVERAGE_VERSION || coverage.workId !== context.work.id || !Array.isArray(coverage.characters)) return null;
  const covered = coverage.characters.filter(item => item.recordId === record.id);
  const proof = covered.length === 1 ? covered[0].fields?.[key] : null;
  const matches = record.fields.filter(field => field.key === key);
  const field = matches[0];
  if (!proof || proof.complete !== true || !Array.isArray(proof.recordIds) || matches.length !== 1 || field.valueType !== 'REFERENCE_MANY' || !Array.isArray(field.value)) return null;
  const refs = Array.from(field.value);
  if (refs.some(ref => !ref || ref.setKey !== setKey || typeof ref.recordId !== 'string' || !ref.recordId)) return null;
  const ids = refs.map(ref => ref.recordId).sort();
  if (new Set(ids).size !== ids.length || ids.length !== proof.recordIds.length || ids.some((id, index) => id !== proof.recordIds[index])) return null;
  return refs.sort((a, b) => a.recordId.localeCompare(b.recordId, 'en'));
}

module.exports = { COVERAGE_VERSION, buildCanonReferenceCoverage, completeReferenceList };
