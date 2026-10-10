const { CONTRACT_VERSION } = require('./review-findings-contract.cjs');
const { completeReferenceList } = require('../context/canon-reference-coverage.cjs');
const RULE_ID = 'CHARACTER_SKILL_ATTRIBUTE_MISMATCH_V1';
const RULE_VERSION = 'V1';
const PROCESSOR_KEY = 'RULE_V1';

/** 선택된 실제 Canon identity와 참조 identity가 같은 Set·ID인지 확인한다. */
function resolvedRecord(index, ref, setKey) {
  const record = index.get(ref?.recordId);
  return ref?.setKey === setKey && record?.setKey === setKey && ref.displayName === record.displayName ? record : null;
}

/** 선택된 Character를 후보 역할 그대로 참조하며 AMBIGUOUS 후보는 검사 대상으로 승격하지 않는다. */
function characterReference(context, character) {
  const reasons = context.relevantCanon.selectionReasons.filter(reason => reason.recordId === character.id);
  if (!reasons.length || reasons.every(reason => reason.reason === 'RELATED_PARTICIPANT')) return null;
  if (reasons.some(reason => !['CHARACTER_DISPLAY_NAME', 'CHARACTER_REGISTERED_ALIAS', 'RELATED_PARTICIPANT'].includes(reason.reason))) return { recordId: character.id, setKey: 'character', referenceRole: 'CONTEXT_RECORD' };
  const mentionIndex = context.nameMentions?.findIndex(mention => mention.status === 'MATCHED' && mention.recordId === character.id && mention.candidates.length === 1 && mention.candidates[0].recordId === character.id);
  return mentionIndex >= 0 ? { recordId: character.id, setKey: 'character', referenceRole: 'NAME_CANDIDATE', mentionIndex } : null;
}

/** 현재 Episode의 관련 Canon에서 완전한 Character–Skill–Attribute 관계만 ID로 비교한다. */
function inspectCharacterSkillAttributes(context) {
  const findings = [];
  const diagnostics = [];
  const records = context.relevantCanon.selectedRecords;
  const index = new Map(records.map(record => [record.id, record]));
  const duplicates = new Set(records.filter((record, position) => records.findIndex(item => item.id === record.id) !== position).map(record => record.id));
  for (const id of duplicates) index.delete(id);
  const characters = [...index.values()].filter(record => record.setKey === 'character').sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const seen = new Set();
  for (const character of characters) {
    const reference = characterReference(context, character);
    const attributes = completeReferenceList(context, character, 'attributes', 'attribute');
    const skills = completeReferenceList(context, character, 'skills', 'skill');
    if (!reference || !attributes || !skills || attributes.some(ref => !resolvedRecord(index, ref, 'attribute'))) {
      diagnostics.push({ characterId: character.id, skillId: null, status: 'UNVERIFIABLE', reason: !reference ? 'CHARACTER_NOT_IDENTIFIED' : 'CHARACTER_REFERENCES_INCOMPLETE' });
      continue;
    }
    const ownedAttributeIds = new Set(attributes.map(ref => ref.recordId));
    for (const skillRef of skills) {
      const skill = resolvedRecord(index, skillRef, 'skill');
      const fields = Array.isArray(skill?.fields) ? skill.fields.filter(field => field.key === 'required_attribute') : null;
      const field = fields?.length === 1 ? fields[0] : null;
      const required = field?.valueType === 'REFERENCE_ONE' ? field.value : null;
      const attribute = resolvedRecord(index, required, 'attribute');
      if (!skill || !attribute) {
        diagnostics.push({ characterId: character.id, skillId: skillRef.recordId, status: 'UNVERIFIABLE', reason: !skill ? 'SKILL_RECORD_UNAVAILABLE' : required === null ? 'REQUIRED_ATTRIBUTE_UNSET_OR_INCOMPLETE' : 'REQUIRED_ATTRIBUTE_UNAVAILABLE' });
        continue;
      }
      const key = JSON.stringify([RULE_ID, character.id, skill.id, attribute.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const matches = ownedAttributeIds.has(attribute.id);
      diagnostics.push({ characterId: character.id, skillId: skill.id, status: matches ? 'MATCHED' : 'MISMATCH', reason: matches ? 'REQUIRED_ATTRIBUTE_OWNED' : 'REQUIRED_ATTRIBUTE_NOT_IN_COMPLETE_LIST' });
      if (matches) continue;
      const canonRefs = [reference, { recordId: skill.id, setKey: 'skill', referenceRole: 'CONTEXT_RECORD' }, { recordId: attribute.id, setKey: 'attribute', referenceRole: 'CONTEXT_RECORD' }, ...attributes.map(ref => ({ recordId: ref.recordId, setKey: 'attribute', referenceRole: 'CONTEXT_RECORD' }))];
      findings.push({ category: 'CANON', severity: 'WARNING', assessment: 'DETERMINISTIC', anchor: { type: 'CANON_RECORD' },
        evidence: [`규칙: ${RULE_ID} · 규칙 버전: ${RULE_VERSION} · Processor: ${PROCESSOR_KEY}`,
          '검사 범위: 현재 Episode Relevant Canon의 등록 Character–Skill–Attribute 관계. 완전한 참조 목록을 ID로 비교했습니다.',
          `캐릭터: ${character.displayName} [${character.id}]`,
          `보유 속성 전체 목록: ${attributes.length ? attributes.map(ref => `${ref.displayName} [${ref.recordId}]`).join(', ') : '등록된 속성 없음 (전체 목록 확인)'}`,
          `등록 스킬: ${skill.displayName} [${skill.id}]`, `필요 속성: ${attribute.displayName} [${attribute.id}]`,
          '필요 속성 ID가 캐릭터의 보유 속성 전체 목록에 없습니다. 원고의 실제 스킬 사용자나 작품 설정 오류를 확정하지 않습니다.'].join('\n'),
        message: `${character.displayName}에게 등록된 스킬 ${skill.displayName}의 필요 속성 ${attribute.displayName}이 해당 캐릭터의 보유 속성 목록에서 확인되지 않습니다. 특수 능력, 계약 또는 예외 설정이 존재하는지 확인해 주세요.`,
        suggestion: '등록된 속성 관계와 예외 설정을 작가가 확인해 주세요. 이 결과는 원고에서 스킬을 사용했다는 판정이 아닙니다.', relatedCanonRecords: canonRefs });
    }
  }
  return { findings, diagnostics };
}

/** DB·파일·API를 사용하지 않고 결정적인 Canon 비교 결과를 기존 V1 계약으로 반환한다. */
function createRuleReviewProcessor() {
  return { processorKey: PROCESSOR_KEY,
    /** 고정된 ReviewContext만 읽어 등록 관계 불일치의 초안을 생성한다. */
    async review(context) { return { contractVersion: CONTRACT_VERSION, findings: inspectCharacterSkillAttributes(context).findings }; } };
}

module.exports = { createRuleReviewProcessor, inspectCharacterSkillAttributes, RULE_ID, RULE_VERSION, PROCESSOR_KEY };
