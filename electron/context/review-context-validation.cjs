const assert = require('node:assert/strict');
const { buildReviewContext, parseNotation } = require('./review-context-builder.cjs');
const { buildRelevantCanonHash } = require('../review/review-service.cjs');

/** 공개 WorkContext 참조 DTO를 테스트에서 구성한다. */
function ref(id, setKey = 'character') { return { recordId: id, setKey, displayName: id }; }
/** 공개 field DTO로 정의에 일치하는 단일/복수 참조를 만든다. */
function field(key, value) { return { key, label: key, valueType: Array.isArray(value) ? 'REFERENCE_MANY' : 'REFERENCE_ONE', value }; }
/** 실제 WorkContext 형태로 Scene, 이름 중첩, 참조와 1-hop 경계를 검증할 fixture를 만든다. */
function fixture(content) {
  const entries = {
    world: [{ id: 'w', displayName: '세계', fields: [] }],
    location: [{ id: 'l', displayName: '헤븐즈', fields: [field('world', ref('w', 'world'))] }, { id: 'l2', displayName: '지하격투장', fields: [] }],
    skill: [{ id: 's', displayName: '버티컬 슬래쉬', fields: [] }, { id: 's2', displayName: '다른 스킬', fields: [] }],
    passive: [{ id: 'p', displayName: '태초의 하얀색', fields: [] }],
    character: [{ id: 'a', displayName: '한지수', fields: [field('skills', [ref('s', 'skill')]), field('passives', [ref('p', 'passive')]), field('origin_location', ref('l', 'location'))] }, { id: 'b', displayName: '이카로스', fields: [field('skills', [])] }, { id: 'c', displayName: '류웨이', fields: [] }],
    authority: [{ id: 'au', displayName: '태초의 붉은색', fields: [field('owner_character', ref('a'))] }],
    servant: [{ id: 'se', displayName: '운디네', fields: [field('owner_character', ref('a'))] }],
    relationship: [{ id: 'r', displayName: '관계1', fields: [field('source_character', ref('a')), field('target_character', ref('b'))] }, { id: 'r2', displayName: '관계2', fields: [field('source_character', ref('b')), field('target_character', ref('c'))] }],
    contract: [{ id: 'co', displayName: '계약1', fields: [field('grantor_character', ref('c')), field('grantee_character', ref('a'))] }],
  };
  return { scope: 'FULL_CANON', work: { id: 'work', title: '작품' }, episode: { id: 'episode', content, contentHash: null }, canon: { summary: { setCount: Object.keys(entries).length, recordCount: 14 }, sets: Object.entries(entries).map(([key, records]) => ({ key, label: key, recordCount: records.length, records })) } };
}

/** 원문 보존, 안전한 모호성, 소유 판정, 관련 fingerprint와 1-hop 비재귀 규칙을 검증한다. */
function runValidation() {
  for (const newline of ['\n', '\r\n']) {
    const content = ['서문😀', '[헤븐즈]', '한지수는 {버티컬 슬래쉬}를 사용했다.', '한지수는 {태초의 하얀색}을 발동했다.', '나는 {버티컬 슬래쉬}를 사용했다.', '"그분이 {버티컬 슬래쉬}를 사용했어."', "'나도 그렇게 생각한다.'", '[알림: 스킬을 획득하셨습니다.]', '[알림 : 스킬이 발동되었습니다.]', '{권속 : 운디네}', '{염화 : 태초의 붉은색}', '[호텔 안]', '[그 시각 지하격투장]', '이카로스가 {버티컬 슬래쉬}를 발동했다.', '순간 {버티컬 슬래쉬}가 발동했다.', '{미등록}', '{} {a:b:c} [닫히지 않음', '그 녀석 그녀석 그 사람'].join(newline);
    const input = fixture(content), before = JSON.stringify(input), context = buildReviewContext(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(context.scenes.length, 4);
    assert.equal(context.scenes.map(scene => content.slice(scene.originalRange.start, scene.originalRange.end)).join(''), content);
    assert.equal(context.scenes[3].timeHintRaw, '그 시각');
    assert.equal(context.scenes[3].locationCandidate, '지하격투장');
    assert.equal(context.scenes[2].resolvedLocation.status, 'NOT_FOUND');
    assert.deepEqual(context.abilityOwnershipChecks.map(check => check.result), ['MATCHED', 'MATCHED', 'UNVERIFIABLE_OWNER', 'UNVERIFIABLE_OWNER', 'MISMATCH_CANDIDATE', 'UNVERIFIABLE_OWNER', 'CANON_NOT_FOUND']);
    for (const scene of context.scenes) for (const item of scene.notationOccurrences) assert.equal(content.slice(item.range.start, item.range.end), item.raw);
    const selected = context.relevantCanon.selectedRecords.map(record => record.id);
    assert.ok(selected.includes('r') && selected.includes('co') && selected.includes('au') && selected.includes('se'));
    assert.ok(!context.scenes[1].selectedCanonIds.includes('r2'));
    assert.ok(!context.scenes[1].selectedCanonIds.includes('b'));
    assert.equal(selected.length, new Set(selected).size);
    assert.ok(context.warnings.length >= 4);
    assert.equal(context.unresolvedMentions.filter(item => item.status === 'UNKNOWN').length, 4);
    assert.ok(context.scenes[1].notationOccurrences.some(item => item.type === 'AUTHORITY' && item.resolution.status === 'UNRESOLVED'));
    assert.ok(context.scenes[1].notationOccurrences.some(item => item.type === 'INNER_OR_CONTRACT_DIALOGUE'));
  }
  const input = fixture('[헤븐즈]\n한지수는 {버티컬 슬래쉬}를 사용했다.');
  const hash = buildRelevantCanonHash(buildReviewContext(input));
  input.canon.sets.find(set => set.key === 'world').records[0].displayName = '무관한 세계 수정';
  assert.equal(buildRelevantCanonHash(buildReviewContext(input)), hash);
  input.canon.sets.reverse();
  for (const set of input.canon.sets) { set.records.reverse(); for (const record of set.records) record.fields.reverse(); }
  assert.equal(buildRelevantCanonHash(buildReviewContext(input)), hash);
  input.canon.sets.find(set => set.key === 'character').records.find(record => record.id === 'a').fields.find(item => item.key === 'skills').value = [];
  assert.notEqual(buildRelevantCanonHash(buildReviewContext(input)), hash);
  assert.equal(buildReviewContext(input).abilityOwnershipChecks[0].result, 'MISMATCH_CANDIDATE');
  const ambiguity = fixture('한지수는 {버티컬 슬래쉬}를 사용했다.');
  ambiguity.canon.sets.find(set => set.key === 'passive').records.push({ id: 'duplicate', displayName: '버티컬 슬래쉬', fields: [] });
  assert.equal(buildReviewContext(ambiguity).abilityOwnershipChecks[0].result, 'AMBIGUOUS');
  const duplicateActor = fixture('한지수는 {버티컬 슬래쉬}를 사용했다.');
  duplicateActor.canon.sets.find(set => set.key === 'character').records.push({ id: 'duplicate-actor', displayName: '한지수', fields: [] });
  assert.equal(buildReviewContext(duplicateActor).abilityOwnershipChecks[0].result, 'AMBIGUOUS');
  assert.ok(!buildReviewContext(duplicateActor).relevantCanon.selectedRecords.some(record => record.id === 'a'));
  const explicitActor = fixture('한지수는 {버티컬 슬래쉬}를 사용했다.');
  explicitActor.canon.sets.find(set => set.key === 'skill').records.push({ id: 'same-other-set', displayName: '한지수', fields: [] });
  const explicitContext = buildReviewContext(explicitActor);
  assert.equal(explicitContext.abilityOwnershipChecks[0].actorCharacterId, 'a');
  assert.ok(explicitContext.relevantCanon.selectedRecords.some(record => record.id === 'r'));
  const duplicateLocation = fixture('[헤븐즈]');
  duplicateLocation.canon.sets.find(set => set.key === 'location').records.push({ id: 'same-location', displayName: '헤븐즈', fields: [] });
  assert.equal(buildReviewContext(duplicateLocation).scenes[0].resolvedLocation.status, 'AMBIGUOUS');
  assert.equal(buildReviewContext(duplicateLocation).relevantCanon.selectedRecords.length, 0);
  const chain = fixture('한지수');
  const chainResult = buildReviewContext(chain);
  assert.ok(!chainResult.relevantCanon.selectedRecords.some(record => record.id === 'b' || record.id === 'r2'));
  chain.canon.sets.find(set => set.key === 'relationship').records.push({ id: 'r3', displayName: '추가 관계', fields: [field('source_character', ref('a')), field('target_character', ref('c'))] });
  assert.notEqual(buildRelevantCanonHash(buildReviewContext(chain)), buildRelevantCanonHash(chainResult));
  const beforeAmbiguity = buildRelevantCanonHash(buildReviewContext(ambiguity));
  ambiguity.canon.sets.find(set => set.key === 'passive').records.pop();
  assert.notEqual(buildRelevantCanonHash(buildReviewContext(ambiguity)), beforeAmbiguity);
  const overlap = fixture('한지수 한지');
  overlap.canon.sets.find(set => set.key === 'character').records.push({ id: 'short', displayName: '한지', fields: [] });
  assert.deepEqual(buildReviewContext(overlap).scenes[0].directMentions.map(item => item.name), ['한지수', '한지']);
  const quotes = buildReviewContext(fixture('"\n[헤븐즈]\n한지수는 {버티컬 슬래쉬}를 사용했다.\n"'));
  assert.equal(quotes.scenes.length, 1);
  assert.equal(quotes.abilityOwnershipChecks[0].result, 'UNVERIFIABLE_OWNER');
  assert.equal(parseNotation('[알림 : 내용]').occurrences[0].type, 'SYSTEM_NOTIFICATION');
  assert.equal(buildReviewContext(fixture('[헤븐즈]\n[호텔 안]\n')).scenes.length, 2);
  console.log('Task025 ReviewContext validation passed.');
}
runValidation();
