const { completeLegacyRun } = require('../review/testing/finding-fixtures.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, closeDatabase, getDatabase } = require('./database.cjs');
const { createCanonFixture, inputFor } = require('./canon-record-validation.cjs');
const { getCanonDefinitionBySetId } = require('./repositories/canon-definition-repository.cjs');
const records = require('./repositories/canon-record-repository.cjs');
const reviewRepository = require('./repositories/review-repository.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildReviewContext } = require('../context/review-context-builder.cjs');
const { buildEpisodeContentHash, buildRelevantCanonHash, getReviewsByEpisode, startEpisodeReview } = require('../review/review-service.cjs');
const { createEpisodeWithContent } = require('../episode-service.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');

/** Repository 오류 코드를 확인하면서 실패 후 데이터가 보존되는지 호출자가 검사한다. */
function expectCode(action, code) { assert.throws(action, error => error.code === code && /[가-힣]/.test(error.message)); }

/** 신규 Skill의 필수 참조, Work 경계와 V1/V2 Review 해시 차이를 임시 DB에서 검증한다. */
async function validateCurrent(root) {
  const file = path.join(root, 'current', 'novelcompany.db');
  initializeDatabase(file);
  const scope = createCanonFixture();
  const field = getCanonDefinitionBySetId(scope.skill.setId).fields.find(item => item.key === 'required_attribute');
  assert.deepEqual([field.label, field.valueType, field.inputControl, field.referenceSet.key, field.required], ['필요 속성', 'REFERENCE_ONE', 'COMBOBOX', 'attribute', true]);
  assert.equal(records.getCreateReadiness(scope.skill).canCreate, false);
  assert.equal(records.getCreateReadiness(scope.skill).blockers[0].targetSetName, '속성');
  const water = records.create(scope.attribute, inputFor(scope.attribute, '물'));
  const fire = records.create(scope.attribute, inputFor(scope.attribute, '불'));
  assert.equal(records.getCreateReadiness(scope.skill).canCreate, true);
  assert.deepEqual(records.getReferenceOptions(scope.skill, field.id).map(option => option.id).sort(), [water.id, fire.id].sort());
  expectCode(() => records.create(scope.skill, inputFor(scope.skill, '누락')), 'CANON_REQUIRED_FIELD_MISSING');
  expectCode(() => records.create(scope.skill, inputFor(scope.skill, '중복', { required_attribute: [water.id, fire.id] })), 'CANON_FIELD_VALUE_INVALID');
  const other = createCanonFixture();
  const foreign = records.create(other.attribute, inputFor(other.attribute, '다른 작품 물'));
  expectCode(() => records.create(scope.skill, inputFor(scope.skill, '교차', { required_attribute: foreign.id })), 'CANON_REFERENCE_SCOPE_MISMATCH');
  assert.ok(!records.getReferenceOptions(scope.skill, field.id).some(option => option.id === foreign.id));
  const wave = records.create(scope.skill, inputFor(scope.skill, '해일', { required_attribute: water.id }));
  const splash = records.create(scope.skill, inputFor(scope.skill, '물보라', { required_attribute: water.id }));
  assert.equal(records.getById(scope.skill, wave.id).fieldValues[field.id], water.id);
  assert.equal(records.getById(scope.skill, splash.id).fieldValues[field.id], water.id);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) count FROM canon_record_references WHERE record_id = ? AND field_id = ?').get(wave.id, field.id).count, 1);
  assert.throws(() => getDatabase().prepare('INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)').run(scope.skill.canonSpaceId, scope.skill.setId, wave.id, field.id, scope.attribute.setId, fire.id));
  const skillBeforeFailedUpdate = records.getById(scope.skill, wave.id);
  expectCode(() => records.update(scope.skill, wave.id, inputFor(scope.skill, '해일', { required_attribute: null })), 'CANON_REQUIRED_FIELD_MISSING');
  assert.deepEqual(records.getById(scope.skill, wave.id), skillBeforeFailedUpdate);
  const workId = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(scope.skill.canonSpaceId).work_id;
  const storage = new LocalEpisodeStorage(path.join(root, 'current'));
  await storage.ensureBaseStorage();
  const episode = createEpisodeWithContent(storage, { workId, episodeNumber: 1, title: '속성 검증', content: '{해일}' });
  const input = { workId, episodeId: episode.id };
  const contextBefore = buildReviewContext(await buildEpisodeWorkContext(storage, input));
  assert.equal(contextBefore.relevantCanon.selectedRecords.find(item => item.id === wave.id).fields.find(item => item.key === 'required_attribute').value.recordId, water.id);
  assert.ok(contextBefore.relevantCanon.selectedRecords.some(item => item.id === water.id));
  assert.ok(contextBefore.relevantCanon.selectionReasons.some(item => item.reason === 'SKILL_REQUIRED_ATTRIBUTE' && item.recordId === water.id));
  const oldV1Hash = buildRelevantCanonHash(buildReviewContext(await buildEpisodeWorkContext(storage, input), [], null), 'V1');
  const full = await buildEpisodeWorkContext(storage, input);
  const oldRun = reviewRepository.createRun({ workId, episodeId: episode.id, processorKey: 'STUB_V1', episodeContentHash: buildEpisodeContentHash(full), canonContextHash: oldV1Hash, contextMode: 'RELEVANT_CANON_V1' });
  completeLegacyRun(oldRun.id, []);
  const newRun = await startEpisodeReview(storage, input);
  assert.equal(newRun.source.fingerprintVersion, 'V2');
  assert.equal(newRun.freshness.isCurrent, true);
  records.update(scope.skill, wave.id, inputFor(scope.skill, '해일', { required_attribute: fire.id }));
  const contextAfter = buildReviewContext(await buildEpisodeWorkContext(storage, input));
  assert.equal(contextAfter.relevantCanon.selectedRecords.find(item => item.id === wave.id).fields.find(item => item.key === 'required_attribute').value.recordId, fire.id);
  assert.ok(contextAfter.relevantCanon.selectedRecords.some(item => item.id === fire.id));
  assert.notEqual(buildRelevantCanonHash(contextBefore), buildRelevantCanonHash(contextAfter));
  assert.equal(buildRelevantCanonHash(buildReviewContext(await buildEpisodeWorkContext(storage, input), [], null), 'V1'), oldV1Hash);
  const history = await getReviewsByEpisode(storage, input);
  assert.equal(history.find(item => item.id === oldRun.id).freshness.isCurrent, true);
  assert.equal(history.find(item => item.id === newRun.id).freshness.canonChanged, true);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) count FROM review_runs').get().count, 2);
  closeDatabase();
}

/** V7 상태를 재현하고 백업·대상 재검증·기존 미설정 Skill 보존 및 멱등성을 검증한다. */
function validateUpgrade(root) {
  const file = path.join(root, 'upgrade', 'novelcompany.db');
  initializeDatabase(file);
  const scope = createCanonFixture();
  const attr = records.create(scope.attribute, inputFor(scope.attribute, '물'));
  const oldSkill = records.create(scope.skill, inputFor(scope.skill, '옛 스킬', { required_attribute: attr.id, description: '원본 설명' }));
  const field = getCanonDefinitionBySetId(scope.skill.setId).fields.find(item => item.key === 'required_attribute');
  const recordBefore = getDatabase().prepare('SELECT * FROM canon_records WHERE id = ?').get(oldSkill.id);
  getDatabase().prepare('DELETE FROM canon_record_references WHERE record_id = ? AND field_id = ?').run(oldSkill.id, field.id);
  getDatabase().prepare('DELETE FROM canon_fields WHERE id = ?').run(field.id);
  getDatabase().exec('ALTER TABLE review_runs DROP COLUMN fingerprint_version; DELETE FROM schema_migrations WHERE version IN (8, 9)');
  closeDatabase();
  initializeDatabase(file);
  const upgraded = getDatabase();
  assert.equal(upgraded.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 14);
  const newField = getCanonDefinitionBySetId(scope.skill.setId).fields.find(item => item.key === 'required_attribute');
  assert.equal(newField.referenceSet.id, scope.attribute.setId);
  assert.deepEqual(upgraded.prepare('SELECT * FROM canon_records WHERE id = ?').get(oldSkill.id), recordBefore);
  assert.equal(records.getById(scope.skill, oldSkill.id).fieldValues[newField.id], null);
  assert.equal(records.getById(scope.skill, oldSkill.id).fieldValues[getCanonDefinitionBySetId(scope.skill.setId).fields.find(item => item.key === 'description').id], '원본 설명');
  assert.equal(records.getBySetId(scope.skill).find(item => item.id === oldSkill.id).requiredAttributeMissing, true);
  const oldValues = records.getById(scope.skill, oldSkill.id).fieldValues;
  assert.equal(upgraded.prepare('SELECT COUNT(*) count FROM canon_field_values WHERE record_id = ?').get(oldSkill.id).count, 1);
  records.update(scope.skill, oldSkill.id, { displayName: '옛 스킬 수정', fieldValues: oldValues });
  assert.equal(records.getById(scope.skill, oldSkill.id).fieldValues[newField.id], null);
  records.update(scope.skill, oldSkill.id, inputFor(scope.skill, '옛 스킬 수정', { description: '원본 설명', required_attribute: attr.id }));
  assert.equal(records.getBySetId(scope.skill).find(item => item.id === oldSkill.id).requiredAttributeMissing, false);
  expectCode(() => records.update(scope.skill, oldSkill.id, inputFor(scope.skill, '지우기', { required_attribute: null })), 'CANON_REQUIRED_FIELD_MISSING');
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '008_add_skill_required_attribute.sql'), 'utf8');
  upgraded.exec(sql);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM canon_fields WHERE canon_set_id = ? AND key = 'required_attribute'").get(scope.skill.setId).count, 1);
  const backups = fs.readdirSync(path.join(path.dirname(file), 'backups')).filter(name => name.startsWith('before-task025-hf01-'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(path.dirname(file), 'backups', backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare("SELECT COUNT(*) count FROM canon_fields WHERE canon_set_id = ? AND key = 'required_attribute'").get(scope.skill.setId).count, 0);
    assert.deepEqual(backup.prepare('SELECT * FROM canon_records WHERE id = ?').get(oldSkill.id), recordBefore);
  } finally { backup.close(); }
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  closeDatabase();
}

/** 백업 디렉터리를 만들 수 없으면 기존 Definition과 migration 기록이 그대로인지 확인한다. */
function validateBackupFailure(root) {
  const file = path.join(root, 'backup-failure', 'novelcompany.db');
  initializeDatabase(file);
  const scope = createCanonFixture();
  getDatabase().prepare("DELETE FROM canon_fields WHERE canon_set_id = ? AND key = 'required_attribute'").run(scope.skill.setId);
  getDatabase().exec('ALTER TABLE review_runs DROP COLUMN fingerprint_version; DELETE FROM schema_migrations WHERE version IN (8, 9)');
  closeDatabase();
  fs.writeFileSync(path.join(path.dirname(file), 'backups'), '백업 디렉터리 차단');
  assert.throws(() => initializeDatabase(file));
  const readonly = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(readonly.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 12);
    assert.equal(readonly.prepare("SELECT COUNT(*) count FROM canon_fields WHERE canon_set_id = ? AND key = 'required_attribute'").get(scope.skill.setId).count, 0);
  } finally { readonly.close(); }
}

/** 모든 검증을 격리된 임시 DB·TXT root에서 실행하고 종료 시 정리한다. */
async function runValidation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-skill-attribute-'));
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  try {
    await validateCurrent(root);
    validateUpgrade(root);
    validateBackupFailure(root);
    console.log('Task025-HF01 Skill Attribute validation passed.');
  } finally {
    closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.NOVEL_COMPANY_DATA_DIR;
  }
}
runValidation().catch(error => { console.error(error); process.exitCode = 1; });
