const COUNTS = { world: 4, location: 14, city: 16, organization: 11, attribute: 7, skill: 13, character: 70, authority: 2, servant: 2, passive: 6, contract: 8, relationship: 15 };
/** 실제 소설 설정을 사용하지 않는 12종·168개·비공개 8개 가상 Import를 만든다. */
function documentFixture() {
  const canon_sets = {};
  for (const [key, count] of Object.entries(COUNTS)) canon_sets[key] = { label: key, candidates: Array.from({ length: count }, (_, index) => {
    const fields = { description: '격리 테스트 후보 설명' }, references = {};
    if (key === 'location') references.world = 'world:0';
    if (['city', 'organization'].includes(key)) references.location = 'location:0';
    if (key === 'skill') references.required_attribute = index === 12 ? null : 'attribute:0';
    if (key === 'passive') fields.passive_type = index === 5 ? null : 'COMMON';
    if (key === 'character') Object.assign(references, { origin_location: index === 0 ? null : 'location:0', attributes: ['attribute:0'], passives: ['passive:0'], skills: ['skill:0'] });
    if (key === 'authority') Object.assign(references, { owner_character: 'character:1', base_skill: 'skill:0' });
    if (key === 'servant') references.owner_character = 'character:1';
    if (key === 'contract') { Object.assign(references, { grantor_character: 'character:1', grantee_character: 'character:2' }); fields.status = 'ACTIVE'; }
    if (key === 'relationship') { Object.assign(references, { source_character: 'character:1', target_character: 'character:2' }); fields.relationship_type = '가상 관계'; }
    return { draft_key: key + ':' + index, display_name: '가상 ' + key + ' ' + index, fields, references, source_episodes: [1, 2], basis: { testOnly: true }, editorial_status: 'REVIEW_REQUIRED', import_ready: false, author_private: key === 'character' && index >= 62 };
  }) };
  return { project: 'NovelCompany', work_title: '가상 테스트 작품', version: 'TEST_V1', author_notes: { preserved: '가상 부가 메타데이터' }, canon_sets };
}
/** 실제 현재 Canon Definition을 격리 작품에 설치하고 Staging scope를 반환한다. */
function createScope() {
  const sets = require('../../database/canon-record-validation.cjs').createCanonFixture();
  const canonSpaceId = sets.world.canonSpaceId;
  const { work_id: workId } = require('../../database/database.cjs').getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(canonSpaceId);
  return { workId, canonSpaceId };
}
/** 역순으로 선택해 실제 의존성 순서에 따라 등록되는 배치를 만든다. */
function readySelection(rows) {
  const keys = ['world:0', 'attribute:0', 'location:0', 'city:0', 'organization:0', 'passive:0', 'skill:0', 'character:1', 'character:2', 'authority:0', 'servant:0', 'contract:0', 'relationship:0'];
  return keys.reverse().map(key => { const row = rows.find(item => item.draftKey === key); return { id: row.id, expectedRevision: row.revision }; });
}
module.exports = { COUNTS, documentFixture, createScope, readySelection };
