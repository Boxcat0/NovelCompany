const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, getDatabase, closeDatabase } = require('./database.cjs');
const canon = require('./repositories/canon-definition-repository.cjs');
const records = require('./repositories/canon-record-repository.cjs');
const works = require('./repositories/work-repository.cjs');
const { inputFor } = require('./canon-record-validation.cjs');
const { CANON_SETS, TASK016_CANON_SETS } = require('./setup/initial-canon-definition.cjs');
const { insertCanonDefinition, assertCompleteDefinition } = require('./setup/setup-initial-novel-canon.cjs');
const { installCurrentWorkCanonDefinition } = require('./setup/install-current-work-canon.cjs');
const { upgradeCityCanonDefinition, inspectCityDefinitionUpgrade } = require('./setup/upgrade-city-canon-definition.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createEpisodeWithContent } = require('../episode-service.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildCurrentSource, getReviewById } = require('../review/review-service.cjs');
const { createReviewQueue } = require('../review/review-queue-service.cjs');
const { createReviewProcessor } = require('../review/review-processor-selection.cjs');
const jobs = require('./repositories/review-job-repository.cjs');
const runs = require('./repositories/review-repository.cjs');
const { completeLegacyRun } = require('../review/testing/finding-fixtures.cjs');

/** 격리된 신규/과거 Definition과 실제 scope를 구성하며 Record는 자동 생성하지 않는다. */
function fixture(title, legacy = false) {
  const work = works.createWork({ title });
  const space = canon.createCanonSpaceForWork(work.id);
  insertCanonDefinition(getDatabase(), space.id, legacy ? CANON_SETS.filter(set => set.key !== 'city') : CANON_SETS);
  return { workId: work.id, canonSpaceId: space.id, scope: Object.fromEntries(canon.getCanonSetsByCanonSpaceId(space.id).map(set => [set.key, { canonSpaceId: space.id, setId: set.id }])) };
}

/** 실제 모든 영속 테이블을 복사하여 보호 대상과 rollback을 독립적으로 검증한다. */
function snapshot(db = getDatabase()) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
}

/** 안정적인 실패 코드와 한국어 메시지 및 DB 비변경을 함께 확인한다. */
function unchangedFailure(action, code) {
  const before = snapshot();
  assert.throws(action, error => error.code === code && /[가-힣]/.test(error.message));
  assert.deepEqual(snapshot(), before);
}

/** 실제 Worker가 목표 상태에 도달할 때까지 제한된 시간만 기다린다. */
async function waitFor(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('City 회귀 검토 상태 전환 시간이 초과되었습니다.');
}

/** 최신 정의, 명시적 신규 작품 Bootstrap과 기존 대상 업그레이드의 최종 스키마를 검증한다. */
function validateDefinitionAndUpgrade(storage) {
  assert.equal(TASK016_CANON_SETS.length, 11);
  assert.equal(TASK016_CANON_SETS.reduce((n, set) => n + set.fields.length, 0), 30);
  assert.equal(CANON_SETS.length, 12);
  assert.equal(CANON_SETS.reduce((n, set) => n + set.fields.length, 0), 33);
  const target = fixture('City 이전 가상 작품', true);
  const other = fixture('보존할 가상 작품', true);
  const scope = { workId: target.workId, canonSpaceId: target.canonSpaceId };
  const world = records.create(target.scope.world, inputFor(target.scope.world, '가상 세계 A'));
  const location = records.create(target.scope.location, inputFor(target.scope.location, '가상 지역 A', { world: world.id }));
  createEpisodeWithContent(storage, { workId: target.workId, episodeNumber: 1, title: '가상 보존 회차', content: '[가상 도시 A]\r\n원고는 유지됩니다.' });
  const now = new Date().toISOString();
  getDatabase().prepare('INSERT INTO canon_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), target.canonSpaceId, target.scope.world.setId, 'custom_note', '사용자 메모', 'TEXT', 'TEXT_INPUT', null, 0, null, 99, now, now);
  const before = snapshot();
  const result = upgradeCityCanonDefinition(scope);
  assert.equal(result.created, true);
  assertCompleteDefinition(getDatabase(), other.canonSpaceId, CANON_SETS.filter(set => set.key !== 'city'));
  const city = canon.getCanonDefinitionBySetId(result.citySetId);
  assert.equal(city.name, '도시'); assert.equal(city.recordNameLabel, '도시 이름');
  assert.deepEqual(city.fields.map(field => [field.key, field.label, field.valueType, field.inputControl, field.required, field.referenceSet?.key ?? null]), [['location', '소속 지역', 'REFERENCE_ONE', 'COMBOBOX', true, 'location'], ['description', '설명', 'LONG_TEXT', 'TEXTAREA', false, null]]);
  const after = snapshot();
  for (const [table, rows] of Object.entries(before)) {
    assert.deepEqual(after[table].filter(row => !(table === 'canon_sets' && row.id === city.id) && !(table === 'canon_fields' && row.canon_set_id === city.id)), rows, table);
  }
  assert.deepEqual(records.getById(target.scope.location, location.id), location);
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  try { assert.deepEqual(snapshot(backup), before); } finally { backup.close(); }
  assert.equal(upgradeCityCanonDefinition(scope).created, false);
  assert.deepEqual(snapshot(), after);
  assert.equal(upgradeCityCanonDefinition(scope).backupPath, null);
  const fresh = works.createWork({ title: '명시적으로 설치할 새 가상 작품' });
  const empty = canon.createCanonSpaceForWork(fresh.id);
  unchangedFailure(() => installCurrentWorkCanonDefinition(empty.id, target.workId), 'CANON_BOOTSTRAP_WORK_MISMATCH');
  const installed = installCurrentWorkCanonDefinition(empty.id, fresh.id);
  assert.deepEqual(installed.after, { sets: 12, fields: 33, options: 4, records: 0 });
  assertCompleteDefinition(getDatabase(), empty.id);
  assertCompleteDefinition(getDatabase(), other.canonSpaceId, CANON_SETS.filter(set => set.key !== 'city'));
  // 실제 격리 DB에서 공개 CLI의 인자 해석과 대상 재확인도 검증한다.
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'setup/upgrade-city-canon-definition.cjs'), '--work', scope.workId, '--canon-space', scope.canonSpaceId], { encoding: 'utf8', env: process.env, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).created, false);
  const cliWork = works.createWork({ title: 'CLI 설치 가상 작품' });
  const cliSpace = canon.createCanonSpaceForWork(cliWork.id);
  const bootstrapCli = spawnSync(process.execPath, [path.join(__dirname, 'setup/install-current-work-canon.cjs'), '--work', cliWork.id, '--canon-space', cliSpace.id], { encoding: 'utf8', env: process.env, windowsHide: true });
  assert.equal(bootstrapCli.status, 0, bootstrapCli.stderr);
  assert.deepEqual(JSON.parse(bootstrapCli.stdout).after, { sets: 12, fields: 33, options: 4, records: 0 });
  assertCompleteDefinition(getDatabase(), cliSpace.id);
  console.log('PASS Definition/upgrade: historical 11 preserved, current 12/33/4/0, explicit Work, backup, custom fields/IDs/other Work/TXT preserved, no-op, CLI');
  return { target, other };
}

/** 정의 충돌·공간 불일치·백업 실패·부분 삽입 실패를 안전하게 거부하는지 검증한다. */
function validateUpgradeFailures() {
  const valid = fixture('충돌 검증 가상 작품');
  unchangedFailure(() => upgradeCityCanonDefinition({ workId: 'other-work', canonSpaceId: valid.canonSpaceId }), 'CANON_REFERENCE_SCOPE_MISMATCH');
  unchangedFailure(() => upgradeCityCanonDefinition({ workId: valid.workId, canonSpaceId: 'missing' }), 'CANON_SPACE_NOT_FOUND');
  const empty = canon.createCanonSpaceForWork(works.createWork({ title: '빈 가상 공간' }).id);
  unchangedFailure(() => upgradeCityCanonDefinition({ workId: empty.workId, canonSpaceId: empty.id }), 'CANON_CITY_BOOTSTRAP_REQUIRED');
  const field = canon.getCanonDefinitionBySetId(valid.scope.city.setId).fields.find(item => item.key === 'location');
  for (const [column, value] of [['reference_set_id', valid.scope.organization.setId], ['value_type', 'REFERENCE_MANY'], ['required', 0]]) {
    const original = getDatabase().prepare('SELECT * FROM canon_fields WHERE id = ?').get(field.id);
    if (column === 'value_type') getDatabase().prepare("UPDATE canon_fields SET value_type='REFERENCE_MANY', input_control='CHECKBOX_GROUP' WHERE id=?").run(field.id);
    else getDatabase().prepare('UPDATE canon_fields SET ' + column + ' = ? WHERE id = ?').run(value, field.id);
    unchangedFailure(() => upgradeCityCanonDefinition(valid), 'CANON_CITY_DEFINITION_CONFLICT');
    getDatabase().prepare('UPDATE canon_fields SET reference_set_id=?, value_type=?, input_control=?, required=? WHERE id=?').run(original.reference_set_id, original.value_type, original.input_control, original.required, field.id);
  }
  const parent = canon.getCanonDefinitionBySetId(valid.scope.location.setId).fields.find(item => item.key === 'world');
  getDatabase().prepare('UPDATE canon_fields SET required=0 WHERE id=?').run(parent.id);
  unchangedFailure(() => upgradeCityCanonDefinition(valid), 'CANON_CITY_PARENT_INVALID');
  getDatabase().prepare('UPDATE canon_fields SET required=1 WHERE id=?').run(parent.id);
  const legacy = fixture('추가 실패 가상 작품', true);
  const originalMkdir = fs.mkdirSync;
  try {
    // 백업 실패 시 DB 행을 하나도 변경하지 않는다.
    fs.mkdirSync = () => { throw new Error('isolated backup failure'); };
    unchangedFailure(() => upgradeCityCanonDefinition(legacy), 'CANON_CITY_BACKUP_FAILED');
  } finally { fs.mkdirSync = originalMkdir; }
  getDatabase().exec("CREATE TEMP TRIGGER fail_city_field BEFORE INSERT ON canon_fields WHEN NEW.key='description' AND (SELECT key FROM canon_sets WHERE id=NEW.canon_set_id)='city' BEGIN SELECT RAISE(ABORT, 'isolated city partial insert'); END");
  try { unchangedFailure(() => upgradeCityCanonDefinition(legacy), 'CANON_CITY_UPGRADE_FAILED'); }
  finally { getDatabase().exec('DROP TRIGGER fail_city_field'); }
  assert.equal(upgradeCityCanonDefinition(legacy).created, true);
  const changed = fixture('백업 중 대상 변경 가상 작품', true);
  const beforeChange = snapshot();
  const oldField = canon.getCanonDefinitionBySetId(changed.scope.location.setId).fields.find(item => item.key === 'world').id;
  const newField = randomUUID();
  try {
    // 백업 전 다른 편집이 정상 부모 Field의 identity를 바꾼 상황을 재현한다.
    fs.mkdirSync = (...args) => {
      const result = originalMkdir(...args);
      getDatabase().prepare('UPDATE canon_fields SET id=? WHERE id=?').run(newField, oldField);
      return result;
    };
    assert.throws(() => upgradeCityCanonDefinition(changed), { code: 'CANON_CITY_TARGET_CHANGED' });
  } finally { fs.mkdirSync = originalMkdir; }
  const expected = beforeChange;
  expected.canon_fields.find(field => field.id === oldField).id = newField;
  assert.deepEqual(snapshot(), expected, '다른 편집을 보존하고 City 추가만 중단해야 합니다.');
  assert.equal(inspectCityDefinitionUpgrade(getDatabase(), changed).citySetId, null);
  console.log('PASS upgrade failures: wrong scope/missing/empty/invalid parent/conflicting City/backup failure/partial insertion rollback/target recheck');
}

/** 지역별 여러 도시·단일 참조·ID 범위·수정·삭제 및 전체 Canon lifecycle을 검증한다. */
function validateCrudAndLifecycle(storage) {
  const target = fixture('도시 CRUD 가상 작품'); const foreign = fixture('다른 도시 가상 작품');
  const world = records.create(target.scope.world, inputFor(target.scope.world, 'World A'));
  assert.equal(records.getCreateReadiness(target.scope.city).canCreate, false);
  unchangedFailure(() => records.create(target.scope.city, inputFor(target.scope.city, 'City A')), 'CANON_CREATE_PREREQUISITE_MISSING');
  const a = records.create(target.scope.location, inputFor(target.scope.location, 'Location A', { world: world.id }));
  const b = records.create(target.scope.location, inputFor(target.scope.location, 'Location B', { world: world.id }));
  const foreignWorld = records.create(foreign.scope.world, inputFor(foreign.scope.world, 'World A'));
  const foreignLocation = records.create(foreign.scope.location, inputFor(foreign.scope.location, 'Location A', { world: foreignWorld.id }));
  const organization = records.create(target.scope.organization, inputFor(target.scope.organization, '가상 조직', { location: b.id }));
  const cityField = canon.getCanonDefinitionBySetId(target.scope.city.setId).fields.find(field => field.key === 'location');
  assert.deepEqual(records.getReferenceOptions(target.scope.city, cityField.id).map(option => option.id).sort(), [a.id, b.id].sort());
  for (const [value, code] of [[null, 'CANON_REQUIRED_FIELD_MISSING'], [[a.id, b.id], 'CANON_FIELD_VALUE_INVALID'], ['missing', 'CANON_REFERENCE_TARGET_NOT_FOUND'], [foreignLocation.id, 'CANON_REFERENCE_SCOPE_MISMATCH'], [organization.id, 'CANON_REFERENCE_INVALID'], [world.id, 'CANON_REFERENCE_INVALID']]) {
    unchangedFailure(() => records.create(target.scope.city, inputFor(target.scope.city, '가상 도시', { location: value })), code);
  }
  unchangedFailure(() => records.create(target.scope.city, inputFor(target.scope.city, ' ', { location: a.id })), 'CANON_REQUIRED_FIELD_MISSING');
  const cities = [a, a, a, b, b].map((location, i) => records.create(target.scope.city, inputFor(target.scope.city, i === 0 || i === 3 ? '같은 도시 이름' : 'City ' + i, { location: location.id, description: '가상 설명' })));
  assert.equal(records.getBySetId(target.scope.city).length, 5);
  assert.equal(records.getBySetId(foreign.scope.city).length, 0);
  unchangedFailure(() => records.getById(foreign.scope.city, cities[0].id), 'CANON_RECORD_NOT_FOUND');
  unchangedFailure(() => records.getBySetId({ canonSpaceId: foreign.canonSpaceId, setId: target.scope.city.setId }), 'CANON_REFERENCE_SCOPE_MISMATCH');
  // 단일 참조 제약을 Repository와 DB에서 각각 검증한다.
  assert.throws(() => getDatabase().prepare('INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)').run(target.canonSpaceId, target.scope.city.setId, cities[0].id, cityField.id, target.scope.location.setId, b.id), /REFERENCE_ONE/);
  const moved = records.update(target.scope.city, cities[0].id, inputFor(target.scope.city, '이동한 도시', { location: b.id, description: '수정 설명' }));
  assert.equal(moved.fieldValues[cityField.id], b.id);
  assert.deepEqual(getDatabase().prepare('SELECT target_record_id FROM canon_record_references WHERE record_id=?').all(moved.id).map(row => row.target_record_id), [b.id]);
  const locationWorldField = canon.getCanonDefinitionBySetId(target.scope.location.setId).fields.find(field => field.key === 'world');
  assert.equal(records.getById(target.scope.location, moved.fieldValues[cityField.id]).fieldValues[locationWorldField.id], world.id);
  unchangedFailure(() => records.update(target.scope.city, moved.id, inputFor(target.scope.city, '이동한 도시', { location: foreignLocation.id })), 'CANON_REFERENCE_SCOPE_MISMATCH');
  unchangedFailure(() => records.delete(target.scope.location, a.id), 'CANON_RECORD_IN_USE');
  records.delete(target.scope.city, cities[1].id); records.delete(target.scope.city, cities[2].id); records.delete(target.scope.location, a.id);
  // City를 참조하는 사용자 정의 Field에도 기존 Incoming Reference 보호를 적용한다.
  const incoming = randomUUID(); const now = new Date().toISOString();
  getDatabase().prepare('INSERT INTO canon_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(incoming, target.canonSpaceId, target.scope.world.setId, 'capital', '가상 수도', 'REFERENCE_ONE', 'COMBOBOX', target.scope.city.setId, 0, null, 99, now, now);
  records.update(target.scope.world, world.id, { displayName: world.displayName, fieldValues: { [incoming]: moved.id } });
  unchangedFailure(() => records.delete(target.scope.city, moved.id), 'CANON_RECORD_IN_USE');
  const episode = createEpisodeWithContent(storage, { workId: target.workId, episodeNumber: 1, title: '삭제 보호 가상 원고', content: 'World A\r\nCity를 삭제해도 TXT는 유지됩니다.' });
  const text = (getDatabase().prepare('SELECT storage_key FROM episodes WHERE id=?').get(episode.id));
  const file = storage.resolveManagedPath(target.workId, text.storage_key); const bytes = fs.readFileSync(file);
  getDatabase().exec("CREATE TEMP TRIGGER fail_city_delete BEFORE DELETE ON canon_sets WHEN OLD.key='city' BEGIN SELECT RAISE(FAIL, 'isolated city deletion'); END");
  try { unchangedFailure(() => canon.deleteCanonForWork(target.workId), 'CANON_DELETE_FAILED'); }
  finally { getDatabase().exec('DROP TRIGGER fail_city_delete'); }
  canon.deleteCanonForWork(target.workId);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_references WHERE canon_space_id=?').get(target.canonSpaceId).n, 0);
  const restart = canon.createCanonSpaceForWork(target.workId);
  assert.equal(canon.getCanonSetsByCanonSpaceId(restart.id).length, 0);
  installCurrentWorkCanonDefinition(restart.id, target.workId);
  assertCompleteDefinition(getDatabase(), restart.id);
  assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
  console.log('PASS CRUD/lifecycle: World 1:N Location 1:N City, required single ref, IDs/scope/types/duplicates/update/incoming protection/full deletion rollback/restart/TXT');
}

/** City를 FULL에 포함하되 Relevant·규칙·Legacy·실행 입력·FIFO의 기존 의미를 보존한다. */
async function validateReviewCompatibility(storage) {
  const fixture = require('../review/testing/rule-review-fixtures.cjs').createRuleFixture(storage, 'City 검토 가상 작품');
  const scope = { workId: fixture.workId, canonSpaceId: fixture.scope.world.canonSpaceId };
  // 014 시점의 11개 Set을 재현해 업그레이드 전 이력을 만든다.
  getDatabase().prepare('DELETE FROM canon_fields WHERE canon_set_id=?').run(fixture.scope.city.setId);
  getDatabase().prepare('DELETE FROM canon_sets WHERE id=?').run(fixture.scope.city.setId);
  const request = { workId: fixture.workId, episodeId: fixture.episodes[0].id };
  const context = await buildEpisodeWorkContext(storage, request); const before = buildCurrentSource(context);
  const baselineResult = await createReviewProcessor('RULE_V1').review(before.reviewContext);
  const fullRun = runs.createRun({ ...request, processorKey: 'STUB_V1', episodeContentHash: before.episodeContentHash, canonContextHash: before.fullCanonContextHash, contextMode: 'FULL_CANON_V1', fingerprintVersion: 'V1' });
  completeLegacyRun(fullRun.id, [{ category: 'TYPO', message: '보존할 Legacy 결과' }]);
  const held = [];
  const worker = createReviewQueue(storage, key => ({ processorKey: key,
    /** 격리 테스트에서 실행 입력을 고정하여 City 추가 중 RUNNING을 관찰한다. */
    review(input) { return new Promise(resolve => held.push({ key, input, resolve })); } }));
  worker.start();
  try {
    const running = await worker.submit({ ...request, processorKey: 'RULE_V1' }); await waitFor(() => held.length === 1);
    const queued = await worker.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id });
    const frozenInput = JSON.stringify(held[0].input); const savedRuns = getDatabase().prepare('SELECT * FROM review_runs ORDER BY id').all();
    const savedJobs = getDatabase().prepare('SELECT * FROM review_jobs ORDER BY queue_sequence').all();
    upgradeCityCanonDefinition(scope);
    const citySet = canon.getCanonSetsByCanonSpaceId(scope.canonSpaceId).find(set => set.key === 'city');
    const location = records.getBySetId(fixture.scope.location)[0];
    const cityScope = { canonSpaceId: scope.canonSpaceId, setId: citySet.id };
    const city = records.create(cityScope, inputFor(cityScope, '가상 도시 Z', { location: location.id }));
    const after = buildCurrentSource(await buildEpisodeWorkContext(storage, request));
    for (const key of ['canonContextHash', 'relevantV1ContextHash', 'relevantV2ContextHash', 'sceneMetadataHash', 'nameResolutionVersion']) assert.equal(after[key], before[key]);
    assert.notEqual(after.fullCanonContextHash, before.fullCanonContextHash);
    assert.deepEqual(await createReviewProcessor('RULE_V1').review(after.reviewContext), baselineResult);
    assert.ok(!after.reviewContext.relevantCanon.selectedSets.some(set => set.key === 'city'));
    assert.equal(JSON.stringify(held[0].input), frozenInput);
    assert.deepEqual(getDatabase().prepare('SELECT * FROM review_runs ORDER BY id').all(), savedRuns);
    assert.deepEqual(getDatabase().prepare('SELECT * FROM review_jobs ORDER BY queue_sequence').all(), savedJobs);
    const legacy = await getReviewById(storage, fullRun.id);
    assert.equal(legacy.findings[0].message, '보존할 Legacy 결과'); assert.equal(legacy.freshness.isCurrent, false);
    held[0].resolve(await createReviewProcessor('RULE_V1').review(held[0].input)); await waitFor(() => held.length === 2);
    assert.equal(jobs.getById(queued.id).status, 'RUNNING');
    held[1].resolve(await createReviewProcessor('STUB_V1').review(held[1].input)); await waitFor(() => jobs.getById(queued.id).status === 'COMPLETED');
    const runId = jobs.getById(running.id).reviewRunId;
    const history = await getReviewById(storage, runId); assert.equal(history.freshness.isCurrent, true); assert.deepEqual(history.findings.length, baselineResult.findings.length);
    records.update(cityScope, city.id, inputFor(cityScope, '가상 도시 변경', { location: location.id }));
    assert.equal((await getReviewById(storage, runId)).freshness.isCurrent, true);
    const source = await buildEpisodeWorkContext(storage, request); const cityRecord = source.canon.sets.find(set => set.key === 'city').records[0];
    assert.equal(cityRecord.fields.find(field => field.key === 'location').value.recordId, location.id);
    // 도시 표제를 City에 자동 연결하지 않고 기존 지역 파서의 의미를 보존한다.
    const artificial = structuredClone(source); artificial.episode.content = '[가상 도시 변경]\n한지수는 기다렸다.';
    const parsed = require('../context/review-context-builder.cjs').buildReviewContext(artificial);
    assert.equal(parsed.scenes[0].resolvedLocation.status, 'NOT_FOUND'); assert.ok(!parsed.relevantCanon.selectedRecords.some(record => record.id === city.id));
    // 관련 Skill 변경에는 기존 RESUBMIT_REQUIRED 정책을 적용한다.
    const holder = createReviewQueue(storage); holder.stop();
    const changed = await holder.submit({ ...request, processorKey: 'RULE_V1' });
    records.update(fixture.scope.skill, fixture.skill.id, inputFor(fixture.scope.skill, fixture.skill.displayName, { required_attribute: fixture.fire.id }));
    worker.kick(); await waitFor(() => jobs.getById(changed.id).status === 'RESUBMIT_REQUIRED');
    assert.deepEqual((await getReviewById(storage, runId)).findings, history.findings);
  } finally { worker.stop(); }
  console.log('PASS Review: FULL includes City, relevant V1/V2/V3 unchanged, no City resolver, legacy hash/history preserved, RUNNING fixed input, QUEUED/FIFO/STUB/RULE/currentness');
}

/** 프로덕션에 접근하지 않고 격리 DB·Storage에서 City와 기존 Review를 검증한다. */
async function validate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-city-canon-'));
  const original = process.env.NOVEL_COMPANY_DATA_DIR;
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  try {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    const storage = new LocalEpisodeStorage(root);
    validateDefinitionAndUpgrade(storage); validateUpgradeFailures(); validateCrudAndLifecycle(storage); await validateReviewCompatibility(storage);
    assert.equal(getDatabase().prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 14);
    console.log('Task030-HF01 City Canon validation passed. Isolated DB/Storage only; no migration 015.');
  } finally { closeDatabase(); if (original === undefined) delete process.env.NOVEL_COMPANY_DATA_DIR; else process.env.NOVEL_COMPANY_DATA_DIR = original; }
}

if (require.main === module) validate().catch(cause => { console.error(cause); process.exitCode = 1; });
module.exports = { validate };
