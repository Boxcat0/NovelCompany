const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, closeDatabase, getDatabase } = require('../database/database.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildReviewContext } = require('../context/review-context-builder.cjs');
const { buildCurrentSource, buildRelevantCanonHash, getReviewById } = require('./review-service.cjs');
const { inspectCharacterSkillAttributes, createRuleReviewProcessor, RULE_ID } = require('./rule-review-processor.cjs');
const { validateReviewProcessorResult } = require('./review-findings-contract.cjs');
const { createReviewProcessor } = require('./review-processor-selection.cjs');
const { createReviewQueue } = require('./review-queue-service.cjs');
const { createRuleFixture, setCharacterReferences } = require('./testing/rule-review-fixtures.cjs');
const { completeLegacyRun } = require('./testing/finding-fixtures.cjs');
const jobs = require('../database/repositories/review-job-repository.cjs');
const runs = require('../database/repositories/review-repository.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const canon = require('../database/repositories/canon-definition-repository.cjs');
const aliases = require('../database/repositories/canon-alias-repository.cjs');

/** 실 Worker의 영속 상태가 바뀔 때까지 제한된 시간만 기다린다. */
async function waitFor(check) { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('규칙 검토 상태 전환 시간이 초과되었습니다.'); }

/** 현재 격리 원고·Canon으로 운영과 같은 버전의 source를 만든다. */
async function sourceFor(storage, fixture, episodeIndex = 0) { return buildCurrentSource(await buildEpisodeWorkContext(storage, { workId: fixture.workId, episodeId: fixture.episodes[episodeIndex].id })); }

/** 원고·참조·별칭·시점의 조회 전후 값을 비교해 Processor의 비수정 정책을 검증한다. */
function sourceSnapshot(storage, fixture) {
  const tables = ['episodes', 'canon_records', 'canon_field_values', 'canon_record_references', 'canon_record_option_values', 'canon_record_aliases', 'scene_narration_metadata'];
  return { rows: tables.map(table => getDatabase().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()),
    texts: fixture.episodes.map(episode => fs.readFileSync(storage.resolveManagedPath(fixture.workId, getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(episode.id).storage_key))) };
}

/** 완전한 실제 목록의 정상·불일치와 ID 비교 및 결정성을 검증한다. */
async function validateRule(storage, fixture) {
  for (const [attributes, expected] of [[[fixture.water], 0], [[fixture.fire, fixture.water], 0], [[fixture.fire], 1], [[fixture.fire, fixture.wind], 1], [[fixture.sameNameWater], 1]]) {
    setCharacterReferences(fixture, 0, attributes, [fixture.skill]);
    const source = await sourceFor(storage, fixture);
    const before = JSON.stringify(source.reviewContext);
    const result = await createRuleReviewProcessor().review(source.reviewContext);
    assert.equal(result.findings.length, expected);
    assert.deepEqual(await createRuleReviewProcessor().review(source.reviewContext), result);
    assert.equal(JSON.stringify(source.reviewContext), before);
    const validated = validateReviewProcessorResult(result, source.reviewContext, 'RULE_V1');
    if (expected) {
      const finding = result.findings[0];
      assert.equal(finding.category, 'CANON'); assert.equal(finding.severity, 'WARNING'); assert.equal(finding.assessment, 'DETERMINISTIC');
      assert.deepEqual(finding.anchor, { type: 'CANON_RECORD' });
      for (const value of [RULE_ID, fixture.characters[0].id, fixture.skill.id, fixture.water.id, ...attributes.map(record => record.id)]) assert.ok(finding.evidence.includes(value));
      assert.equal(validated.findings[0].relatedCanonRecords.find(ref => ref.recordId === fixture.characters[0].id).referenceRole, 'NAME_CANDIDATE');
    }
  }
  setCharacterReferences(fixture, 0, [fixture.fire], []);
  assert.deepEqual((await createRuleReviewProcessor().review((await sourceFor(storage, fixture)).reviewContext)).findings, []);
  setCharacterReferences(fixture, 0, [fixture.fire], [fixture.skill]);
  setCharacterReferences(fixture, 1, [fixture.fire], [fixture.skill, fixture.sameNameSkill]);
  const context = (await sourceFor(storage, fixture)).reviewContext;
  const result = await createRuleReviewProcessor().review(context);
  assert.equal(result.findings.length, 2); // 같은 이름의 다른 Skill은 자기 필요 속성으로 비교한다.
  assert.ok(result.findings.every(finding => finding.relatedCanonRecords.some(ref => ref.recordId === fixture.skill.id)));
  assert.ok(!result.findings.some(finding => finding.relatedCanonRecords.some(ref => ref.recordId === fixture.characters[2].id)));
  const reordered = structuredClone(context);
  reordered.relevantCanon.selectedRecords.reverse(); reordered.relevantCanon.selectionReasons.reverse(); reordered.canonReferenceCoverage.characters.reverse();
  for (const record of reordered.relevantCanon.selectedRecords) { record.fields.reverse(); for (const field of record.fields) if (Array.isArray(field.value)) field.value.reverse(); }
  assert.deepEqual(await createRuleReviewProcessor().review(reordered), result);
  for (const version of ['V1', 'V2']) {
    const legacy = buildReviewContext(await buildEpisodeWorkContext(storage, { workId: fixture.workId, episodeId: fixture.episodes[0].id }), [], null);
    const hash = buildRelevantCanonHash(legacy, version); delete legacy.canonReferenceCoverage;
    assert.equal(buildRelevantCanonHash(legacy, version), hash);
  }
  const hash = buildRelevantCanonHash(context); const withoutCoverage = structuredClone(context); delete withoutCoverage.canonReferenceCoverage;
  assert.equal(buildRelevantCanonHash(withoutCoverage), hash);
  console.log('PASS Rule: normal/multiple attributes/mismatch/same names by ID/multiple Characters/dedupe/order/evidence/contract/fingerprint');
}

/** 부분·누락·잘못된 범위·미설정 데이터를 속성 부재로 오인하지 않는지 검증한다. */
async function validateInsufficient(storage, fixture, foreign) {
  setCharacterReferences(fixture, 0, [fixture.fire], [fixture.skill]); setCharacterReferences(fixture, 1, [fixture.water], [fixture.skill]);
  const context = (await sourceFor(storage, fixture)).reviewContext;
  /** 정상 입력의 한 부분만 변경하고 불확실성 진단과 Finding 생성을 확인한다. */
  function skipped(edit) {
    const altered = structuredClone(context); edit(altered);
    const inspected = inspectCharacterSkillAttributes(altered);
    assert.deepEqual(inspected.findings, []); assert.ok(inspected.diagnostics.some(item => item.status === 'UNVERIFIABLE'));
  }
  /** 목표 Character의 실제 Field를 찾는다. */
  function field(input, key) { return input.relevantCanon.selectedRecords.find(record => record.id === fixture.characters[0].id).fields.find(item => item.key === key); }
  skipped(input => { delete input.canonReferenceCoverage; });
  skipped(input => { input.canonReferenceCoverage.workId = foreign.workId; });
  skipped(input => { field(input, 'attributes').value = null; });
  skipped(input => { field(input, 'attributes').value = []; });
  skipped(input => { field(input, 'attributes').valueType = 'REFERENCE_ONE'; });
  skipped(input => { input.relevantCanon.selectedRecords.find(record => record.id === fixture.characters[0].id).fields = []; });
  skipped(input => { delete input.relevantCanon.selectedRecords.find(record => record.id === fixture.characters[0].id).fields; });
  skipped(input => { input.relevantCanon.selectedRecords = input.relevantCanon.selectedRecords.filter(record => record.id !== fixture.skill.id); });
  skipped(input => { input.relevantCanon.selectedRecords = input.relevantCanon.selectedRecords.filter(record => record.id !== fixture.fire.id); });
  skipped(input => { input.relevantCanon.selectedRecords.find(record => record.id === fixture.skill.id).fields.find(item => item.key === 'required_attribute').value = null; });
  skipped(input => { input.relevantCanon.selectedRecords.find(record => record.id === fixture.skill.id).fields = []; });
  skipped(input => { delete input.relevantCanon.selectedRecords.find(record => record.id === fixture.skill.id).fields; });
  skipped(input => { field(input, 'skills').value[0].recordId = foreign.skill.id; });
  skipped(input => { field(input, 'attributes').value[0] = { recordId: foreign.fire.id, setKey: 'attribute', displayName: foreign.fire.displayName }; });
  skipped(input => { input.relevantCanon.selectedRecords.find(record => record.id === fixture.skill.id).fields.find(item => item.key === 'required_attribute').value = { recordId: foreign.water.id, setKey: 'attribute', displayName: '물' }; });
  const partial = structuredClone(context);
  // 전체 목록 확인 정보는 2건인데 실제 목록은 1건이면 불일치를 확정하지 않는다.
  partial.canonReferenceCoverage.characters.find(item => item.recordId === fixture.characters[0].id).fields.attributes.recordIds.push(fixture.wind.id);
  assert.deepEqual(inspectCharacterSkillAttributes(partial).findings, []);
  // Legacy 미설정은 실제 임시 DB의 참조 행 부재로 재현한다.
  const requiredField = canon.getCanonDefinitionBySetId(fixture.scope.skill.setId).fields.find(item => item.key === 'required_attribute');
  getDatabase().prepare('DELETE FROM canon_record_references WHERE record_id = ? AND field_id = ?').run(fixture.skill.id, requiredField.id);
  assert.deepEqual((await createRuleReviewProcessor().review((await sourceFor(storage, fixture)).reviewContext)).findings, []);
  records.update(fixture.scope.skill, fixture.skill.id, { displayName: fixture.skill.displayName, fieldValues: { [requiredField.id]: fixture.water.id } });
  console.log('PASS insufficient input: no coverage/partial list/missing field/record/wrong Work/Legacy unset → no invented mismatch');
}

/** Alias·Organization·POV·근접 이름·능력 표기를 실제 Skill 사용자 판정으로 사용하지 않는다. */
async function validateOwnershipLimits(storage, fixture) {
  for (const character of fixture.characters.slice(0, 2)) aliases.create({ workId: fixture.workId, recordId: character.id }, '기사단장님');
  setCharacterReferences(fixture, 0, [fixture.fire], [fixture.skill]); setCharacterReferences(fixture, 1, [fixture.fire], [fixture.skill]);
  const ambiguous = (await sourceFor(storage, fixture, 2)).reviewContext;
  assert.equal(ambiguous.nameMentions[0].status, 'AMBIGUOUS'); assert.equal(ambiguous.nameMentions[0].candidates.length, 2);
  assert.deepEqual((await createRuleReviewProcessor().review(ambiguous)).findings, []);
  const source = await sourceFor(storage, fixture, 0); const context = source.reviewContext;
  const ownership = JSON.stringify(context.abilityOwnershipChecks); assert.ok(context.abilityOwnershipChecks.every(item => item.actorCharacterId === null));
  const result = await createRuleReviewProcessor().review(context);
  assert.equal(result.findings.length, 2); assert.ok(result.findings.every(finding => finding.anchor.type === 'CANON_RECORD'));
  const changedOwner = structuredClone(context); changedOwner.abilityOwnershipChecks = context.abilityOwnershipChecks.map(item => ({ ...item, actorCharacterId: fixture.characters[2].id, result: 'MATCHED' }));
  changedOwner.scenes[0].narration = { mode: 'FIRST_PERSON_CHARACTER', source: 'AUTHOR_SET', status: 'VALID', narratorCharacter: { recordId: fixture.characters[2].id, setKey: 'character', displayName: '류웨이' } };
  assert.deepEqual(await createRuleReviewProcessor().review(changedOwner), result); assert.equal(JSON.stringify(context.abilityOwnershipChecks), ownership);
  console.log('PASS false positives: ambiguous Alias/organization/narrator/nearest name/notation/ownership inference excluded');
}

/** 실제 IPC 제출·방식 고정·FIFO·잠금·실패·저장 rollback·다음 작업을 검증한다. */
async function validateQueue(storage, fixture) {
  setCharacterReferences(fixture, 0, [fixture.fire], [fixture.skill]); setCharacterReferences(fixture, 1, [fixture.water], [fixture.skill]);
  const snapshot = sourceSnapshot(storage, fixture);
  const holder = createReviewQueue(storage); holder.stop();
  const request = { workId: fixture.workId, episodeId: fixture.episodes[0].id, processorKey: 'RULE_V1' };
  const pending = holder.submit(request); request.processorKey = 'STUB_V1';
  const first = await pending;
  const second = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id });
  assert.equal(first.processorKey, 'RULE_V1'); assert.equal(second.processorKey, 'STUB_V1');
  assert.throws(() => getDatabase().prepare("UPDATE review_jobs SET processor_key = 'STUB_V1' WHERE id = ?").run(first.id), /immutable/);
  assert.throws(() => jobs.assertEpisodeUnlocked(first.episodeId), error => error.code === 'EPISODE_REVIEW_LOCKED');
  for (const key of ['MOCK_V1', 'RULE_V2', '', null, 123, {}]) await assert.rejects(() => holder.submit({ workId: fixture.workId, episodeId: first.episodeId, processorKey: key }), error => error.code === 'REVIEW_PROCESSOR_INVALID');
  const held = [];
  const controlled = createReviewQueue(storage, key => ({ processorKey: key,
    /** 격리 테스트에서 Promise로 실행 시간을 제어하되 실제 선택 Processor를 사용한다. */
    review(context) { return new Promise(resolve => held.push({ key, context, resolve })); } }));
  controlled.start();
  try {
    await waitFor(() => held.length === 1); assert.equal(held[0].key, 'RULE_V1');
    assert.equal(jobs.getById(second.id).status, 'QUEUED'); assert.equal(getDatabase().prepare("SELECT COUNT(*) n FROM review_jobs WHERE status = 'RUNNING'").get().n, 1);
    assert.throws(() => jobs.assertEpisodeUnlocked(first.episodeId), error => error.code === 'EPISODE_REVIEW_LOCKED');
    held[0].resolve(await createReviewProcessor(held[0].key).review(held[0].context));
    await waitFor(() => held.length === 2); assert.equal(jobs.getById(first.id).status, 'COMPLETED'); assert.equal(held[1].key, 'STUB_V1');
    held[1].resolve(await createReviewProcessor(held[1].key).review(held[1].context)); await waitFor(() => jobs.getById(second.id).status === 'COMPLETED');
  } finally { controlled.stop(); }
  const runId = jobs.getById(first.id).reviewRunId; const history = await getReviewById(storage, runId);
  assert.equal(history.processorKey, 'RULE_V1'); assert.equal(history.findings.length, 1); assert.ok(history.findings[0].evidence.includes(RULE_ID));
  jobs.assertEpisodeUnlocked(first.episodeId);
  assert.deepEqual(sourceSnapshot(storage, fixture), snapshot);
  // 실제 IPC도 같은 기존 Queue를 통과하며 Main에서 허용한 선택만 받는다.
  const queue = createReviewQueue(storage); const handlers = new Map();
  require('../ipc/review-handlers.cjs').registerReviewHandlers({
    /** 실제 handler를 보관해 IPC Result 계약까지 검증한다. */
    handle(channel, handler) { handlers.set(channel, handler); } }, storage, queue);
  try {
    for (const channel of ['reviews:submit', 'reviews:start']) {
      const submitted = await handlers.get(channel)(null, { workId: fixture.workId, episodeId: fixture.episodes[1].id, processorKey: 'RULE_V1' });
      assert.equal(submitted.ok, true); await waitFor(() => jobs.getById(submitted.data.id).status === 'COMPLETED');
      assert.equal(runs.getById(jobs.getById(submitted.data.id).reviewRunId).processorKey, 'RULE_V1');
      const denied = await handlers.get(channel)(null, { workId: fixture.workId, episodeId: fixture.episodes[1].id, processorKey: 'MOCK_V1' }); assert.equal(denied.error.code, 'REVIEW_PROCESSOR_INVALID');
    }
  } finally { queue.stop(); }
  for (const mode of ['INVALID', 'THROW', 'SAVE_FAILURE']) {
    const stopped = createReviewQueue(storage); stopped.stop();
    const failing = await stopped.submit({ workId: fixture.workId, episodeId: first.episodeId, processorKey: 'RULE_V1' });
    const next = await stopped.submit({ workId: fixture.workId, episodeId: second.episodeId });
    if (mode === 'SAVE_FAILURE') getDatabase().exec("CREATE TEMP TRIGGER rule_save_failure BEFORE UPDATE OF status ON review_jobs WHEN NEW.status = 'COMPLETED' AND NEW.processor_key = 'RULE_V1' BEGIN SELECT RAISE(FAIL, 'test rule save rollback'); END");
    const worker = createReviewQueue(storage, key => key === 'STUB_V1' ? createReviewProcessor(key) : { processorKey: key,
      /** 격리 실패 주입으로 전체 검증과 저장 실패 후 FIFO 진행을 확인한다. */
      async review(context) { if (mode === 'THROW') throw new Error('가상 규칙 실패'); const result = await createReviewProcessor(key).review(context); if (mode === 'INVALID') result.findings.push({ ...result.findings[0], evidence: '' }); return result; } });
    try { worker.start(); await waitFor(() => jobs.getById(next.id).status === 'COMPLETED'); assert.equal(jobs.getById(failing.id).status, 'FAILED'); assert.deepEqual(runs.getById(jobs.getById(failing.id).reviewRunId).findings, []); jobs.assertEpisodeUnlocked(first.episodeId); }
    finally { worker.stop(); if (mode === 'SAVE_FAILURE') getDatabase().exec('DROP TRIGGER rule_save_failure'); }
  }
  const stopped = createReviewQueue(storage); stopped.stop();
  const changed = await stopped.submit({ workId: fixture.workId, episodeId: first.episodeId, processorKey: 'RULE_V1' });
  setCharacterReferences(fixture, 0, [fixture.fire, fixture.water], [fixture.skill]);
  const resumed = createReviewQueue(storage);
  try { resumed.start(); await waitFor(() => jobs.getById(changed.id).status === 'RESUBMIT_REQUIRED'); assert.equal(jobs.getById(changed.id).reviewRunId, null); } finally { resumed.stop(); }
  assert.deepEqual((await getReviewById(storage, runId)).findings, history.findings); assert.equal((await getReviewById(storage, runId)).freshness.isCurrent, false);
  console.log('PASS Queue/IPC: selection/default/invalid/mock/immutable/FIFO/global-one/locks/start alias/atomic failure/next job/input changed/history');
  return { runId, history };
}

/** RULE 선택을 재시작까지 보존하고 중단 실행은 재실행 없이 실패·다음 FIFO로 복구한다. */
async function validateRestart(root, storage, fixture) {
  const holder = createReviewQueue(storage); holder.stop();
  const interrupted = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[0].id, processorKey: 'RULE_V1' });
  const waiting = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id, processorKey: 'RULE_V1' });
  const claimed = jobs.claimWithRun(interrupted.id, 'RULE_V1');
  assert.equal(runs.getById(claimed.reviewRunId).processorKey, 'RULE_V1');
  closeDatabase(); initializeDatabase(path.join(root, 'novelcompany.db'));
  assert.equal(jobs.getById(waiting.id).processorKey, 'RULE_V1');
  assert.equal(jobs.getById(interrupted.id).status, 'RUNNING');
  const queue = createReviewQueue(storage);
  try {
    queue.start(); await waitFor(() => jobs.getById(waiting.id).status === 'COMPLETED');
    assert.equal(jobs.getById(interrupted.id).errorCode, 'REVIEW_INTERRUPTED');
    assert.equal(runs.getById(claimed.reviewRunId).status, 'FAILED');
    assert.equal(runs.getById(jobs.getById(waiting.id).reviewRunId).processorKey, 'RULE_V1');
    jobs.assertEpisodeUnlocked(interrupted.episodeId);
  } finally { queue.stop(); }
  console.log('PASS restart: queued RULE selection preserved, interrupted RULE failed, FIFO resumed');
}

/** migration 014 전후의 Legacy Job·Run·Finding과 기본 선택·백업을 검증한다. */
async function validateMigration(root, storage, fixture) {
  const db = getDatabase(); const source = await sourceFor(storage, fixture);
  const legacy = runs.createRun({ workId: fixture.workId, episodeId: fixture.episodes[0].id, ...source, processorKey: 'STUB_V1', contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2' }); completeLegacyRun(legacy.id);
  const holder = createReviewQueue(storage); holder.stop(); const waiting = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[0].id });
  db.exec('DROP TRIGGER review_job_processor_immutable; ALTER TABLE review_jobs DROP COLUMN processor_key; DELETE FROM schema_migrations WHERE version = 14');
  const oldJobs = db.prepare('SELECT * FROM review_jobs ORDER BY queue_sequence').all(); const oldRuns = db.prepare('SELECT * FROM review_runs ORDER BY id').all(); const oldFindings = db.prepare('SELECT * FROM review_findings ORDER BY id').all();
  const file = path.join(root, 'novelcompany.db'); closeDatabase();
  const blocked = path.join(root, 'blocked'); fs.mkdirSync(blocked); const blockedFile = path.join(blocked, 'db'); fs.copyFileSync(file, blockedFile); fs.writeFileSync(path.join(blocked, 'backups'), '백업 실패 fixture');
  assert.throws(() => initializeDatabase(blockedFile));
  const untouched = new DatabaseSync(blockedFile, { readOnly: true });
  try { assert.equal(untouched.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 13); assert.deepEqual(untouched.prepare('SELECT * FROM review_jobs ORDER BY queue_sequence').all(), oldJobs); } finally { untouched.close(); }
  initializeDatabase(file);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_jobs ORDER BY queue_sequence').all().map(({ processor_key, ...row }) => { assert.equal(processor_key, 'STUB_V1'); return row; }), oldJobs.map(row => ({ ...row })));
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_runs ORDER BY id').all(), oldRuns); assert.deepEqual(getDatabase().prepare('SELECT * FROM review_findings ORDER BY id').all(), oldFindings);
  assert.equal((await getReviewById(storage, legacy.id)).freshness.isCurrent, true);
  const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task030-')); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(root, 'backups', backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 13); assert.deepEqual(backup.prepare('SELECT * FROM review_runs ORDER BY id').all(), oldRuns); } finally { backup.close(); }
  closeDatabase(); initializeDatabase(file); assert.equal(fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task030-')).length, 1);
  const queue = createReviewQueue(storage);
  try { queue.start(); await waitFor(() => jobs.getById(waiting.id).status === 'COMPLETED'); assert.equal(runs.getById(jobs.getById(waiting.id).reviewRunId).processorKey, 'STUB_V1'); } finally { queue.stop(); }
  console.log('PASS migration 013→014: backup-before-write/failure/legacy/default-STUB/persistence/idempotence/hash/currentness');
}

/** 격리 DB/Storage에서 규칙·실제 Queue·Legacy·원본 비수정 정책을 통합 검증한다. */
async function validate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-rule-')); process.env.NOVEL_COMPANY_DATA_DIR = root;
  try {
    initializeDatabase(path.join(root, 'novelcompany.db')); const storage = new LocalEpisodeStorage(root); await storage.ensureBaseStorage();
    const fixture = createRuleFixture(storage); const foreign = createRuleFixture(storage, '다른 규칙 가상 작품');
    await validateRule(storage, fixture); await validateInsufficient(storage, fixture, foreign); await validateOwnershipLimits(storage, fixture);
    await validateQueue(storage, fixture); await validateRestart(root, storage, fixture); await validateMigration(root, storage, fixture);
    assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    console.log('Task030 Rule Review validation passed.');
  } finally { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.NOVEL_COMPANY_DATA_DIR; }
}

module.exports = { waitFor };
if (require.main === module) validate().catch(error => { console.error(error); process.exitCode = 1; });
