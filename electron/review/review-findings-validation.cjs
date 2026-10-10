const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');
const { createAliasFixture } = require('../database/canon-alias-validation.cjs');
const aliases = require('../database/repositories/canon-alias-repository.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const canon = require('../database/repositories/canon-definition-repository.cjs');
const runs = require('../database/repositories/review-repository.cjs');
const jobs = require('../database/repositories/review-job-repository.cjs');
const { inputFor } = require('../database/canon-record-validation.cjs');
const { createEpisodeWithContent, updateEpisodeWithContent } = require('../episode-service.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildCurrentSource, getReviewById, getReviewsByEpisode } = require('./review-service.cjs');
const { createReviewQueue } = require('./review-queue-service.cjs');
const { createStubReviewProcessor } = require('./stub-review-processor.cjs');
const { validateReviewProcessorResult, executeReviewProcessor } = require('./review-findings-contract.cjs');
const { completeLegacyRun } = require('./testing/finding-fixtures.cjs');
const { createMockReviewProcessor, MOCK_TITLE, MOCK_CONTENT } = require('./testing/mock-review-processor.cjs');

/** 임시 DB/Storage 안에만 고정 가상 작품과 서로 다른 소속의 동명 별칭 후보를 만든다. */
function createFindingFixture(storage) {
  const fixture = createAliasFixture(MOCK_TITLE);
  const skill = records.create(fixture.scope.skill, inputFor(fixture.scope.skill, '가상 연결 스킬', { required_attribute: fixture.attribute.id }));
  const character = records.getById(fixture.scope.character, fixture.characters[0].id);
  const skillField = canon.getCanonDefinitionBySetId(fixture.scope.character.setId).fields.find(field => field.key === 'skills');
  records.update(fixture.scope.character, character.id, { displayName: character.displayName, fieldValues: { ...character.fieldValues, [skillField.id]: [skill.id] } });
  for (const character of fixture.characters.slice(0, 2)) aliases.create({ workId: fixture.workId, recordId: character.id }, '은빛');
  const episodes = [1, 2].map(episodeNumber => createEpisodeWithContent(storage, { workId: fixture.workId, episodeNumber, title: `가상 회차 ${episodeNumber}`, content: MOCK_CONTENT }));
  return { ...fixture, skill, episodes };
}

/** Worker의 실제 영속 상태를 제한된 시간 동안 기다린다. */
async function waitFor(check) {
  for (let index = 0; index < 300; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('가상 검토 작업의 상태 전환 시간이 초과되었습니다.');
}

/** 실패 fixture의 안정적인 코드와 원문 없는 한국어 공개 오류를 확인한다. */
function rejectsResult(result, context, code = 'REVIEW_RESULT_INVALID') {
  assert.throws(() => validateReviewProcessorResult(result, context, 'MOCK_V1'), error => error.code === code && /[가-힣]/.test(error.message) && !error.message.includes(MOCK_CONTENT));
}

/** 계약·범위·후보·크기와 Context 복사본 변조 방어를 단위 검증한다. */
async function validateContract(context, foreignId) {
  const valid = await createMockReviewProcessor().review(context);
  const snapshot = validateReviewProcessorResult(valid, context, 'MOCK_V1');
  assert.equal(snapshot.findings.length, 3);
  assert.equal(snapshot.findings[0].anchor.sourceExcerpt, '😀');
  assert.equal(snapshot.findings[1].anchor.type, 'CANON_RECORD');
  assert.equal(snapshot.findings[1].assessment, 'INFERENCE_CANDIDATE');
  assert.equal(snapshot.findings[2].relatedCanonRecords.length, 2);
  assert.equal(new Set(snapshot.findings[2].relatedCanonRecords.map(record => record.organization.displayNameAtReview)).size, 2);
  assert.equal(Object.isFrozen(snapshot.findings[0].anchor), true);
  for (const [mode, code] of [['INVALID_RANGE', 'REVIEW_FINDING_RANGE_INVALID'], ['INVALID_EXCERPT', 'REVIEW_FINDING_RANGE_INVALID'], ['INVALID_CANON', 'REVIEW_FINDING_CANON_INVALID'], ['MISSING_FIELD', 'REVIEW_RESULT_INVALID']]) rejectsResult(await createMockReviewProcessor(mode).review(context), context, code);
  for (const value of [null, [], {}, { findings: [] }, { contractVersion: 'FUTURE', findings: [] }, { contractVersion: 'REVIEW_FINDINGS_V1', findings: null }, { ...valid, processorKey: 'STUB_V1' }]) rejectsResult(value, context);
  /** 정상 초안의 한 부분만 훼손해 전체 거부를 검증한다. */
  function rejectEdit(edit, code) { const result = structuredClone(valid); edit(result); rejectsResult(result, context, code); }
  for (const key of ['category', 'severity', 'assessment']) rejectEdit(result => { result.findings[0][key] = 'INVALID'; });
  rejectEdit(result => { delete result.findings[0].category; });
  for (const key of ['message', 'evidence', 'suggestion']) for (const value of ['', 123, [], 'x'.repeat(16001)]) rejectEdit(result => { result.findings[0][key] = value; });
  for (const key of ['id', 'reviewRunId', 'sortOrder', 'provenance', 'contractVersion']) rejectEdit(result => { result.findings[0][key] = 'forged'; });
  rejectEdit(result => { result.findings = Array(101).fill(result.findings[0]); });
  rejectEdit(result => { result.findings = new Array(1); });
  rejectEdit(result => { delete result.findings[1]; });
  rejectEdit(result => { result.findings[1].relatedCanonRecords = new Array(1); }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings = Array(100).fill({ ...result.findings[0], evidence: 'x'.repeat(8000) }); });
  for (const range of [{ start: -1, end: 2 }, { start: 1.5, end: 3 }, { start: 2, end: 2 }, { start: 5, end: 3 }, { start: '0', end: 2 }, { start: 0, end: Infinity }]) rejectEdit(result => { result.findings[0].anchor.range = range; }, 'REVIEW_FINDING_RANGE_INVALID');
  rejectEdit(result => { result.findings[0].anchor.sceneIdentity = 'wrong-scene'; }, 'REVIEW_FINDING_RANGE_INVALID');
  const wrongScene = structuredClone(context); wrongScene.scenes[0].originalRange.end = 1;
  rejectsResult(valid, wrongScene, 'REVIEW_FINDING_RANGE_INVALID');
  rejectEdit(result => { result.findings[1].anchor.range = { start: 0, end: 1 }; }, 'REVIEW_FINDING_RANGE_INVALID');
  rejectEdit(result => { result.findings[1].relatedCanonRecords = []; }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[1].relatedCanonRecords[0].recordId = foreignId; }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[1].relatedCanonRecords[0].setKey = 'skill'; }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[1].relatedCanonRecords.push(result.findings[1].relatedCanonRecords[0]); }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[2].relatedCanonRecords.pop(); }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[2].relatedCanonRecords[0].referenceRole = 'CONTEXT_RECORD'; delete result.findings[2].relatedCanonRecords[0].mentionIndex; }, 'REVIEW_FINDING_CANON_INVALID');
  rejectEdit(result => { result.findings[2].relatedCanonRecords[0].referenceRole = 'NAME_CANDIDATE'; }, 'REVIEW_FINDING_CANON_INVALID');
  const matched = context.nameMentions.findIndex(mention => mention.status === 'MATCHED');
  const named = structuredClone(valid); named.findings = [named.findings[0]];
  named.findings[0].relatedCanonRecords = [{ recordId: context.nameMentions[matched].recordId, setKey: 'character', referenceRole: 'NAME_CANDIDATE', mentionIndex: matched }];
  assert.equal(validateReviewProcessorResult(named, context, 'MOCK_V1').findings[0].relatedCanonRecords[0].referenceRole, 'NAME_CANDIDATE');
  const narratorContext = structuredClone(context);
  narratorContext.scenes[0].narration.narratorCharacter = { recordId: context.nameMentions[matched].recordId, setKey: 'character', displayName: context.nameMentions[matched].candidates[0].displayName };
  named.findings[0].relatedCanonRecords = [{ recordId: context.nameMentions[matched].recordId, setKey: 'character', referenceRole: 'CONTEXT_RECORD' }];
  assert.equal(validateReviewProcessorResult(named, narratorContext, 'MOCK_V1').findings[0].relatedCanonRecords[0].referenceRole, 'CONTEXT_RECORD');
  const attribute = context.relevantCanon.selectedRecords.find(record => record.setKey === 'attribute');
  named.findings[0].relatedCanonRecords = [{ recordId: attribute.id, setKey: 'attribute', referenceRole: 'CONTEXT_RECORD' }];
  validateReviewProcessorResult(named, context, 'MOCK_V1');
  const skill = context.relevantCanon.selectedRecords.find(record => record.setKey === 'skill');
  named.findings[0].relatedCanonRecords.push({ recordId: skill.id, setKey: 'skill', referenceRole: 'CONTEXT_RECORD' });
  validateReviewProcessorResult(named, context, 'MOCK_V1');
  const crlf = structuredClone(valid); crlf.findings = [crlf.findings[0]];
  crlf.findings[0].anchor = { type: 'TEXT_RANGE', range: { start: 0, end: 9 }, sceneIdentity: null, sourceExcerpt: MOCK_CONTENT.slice(0, 9) };
  validateReviewProcessorResult(crlf, context, 'MOCK_V1');
  crlf.findings[0].anchor.sourceExcerpt = crlf.findings[0].anchor.sourceExcerpt.replace('\r\n', '\n'); rejectsResult(crlf, context, 'REVIEW_FINDING_RANGE_INVALID');
  for (const excerpt of ['\r\n', '\n', ' ']) {
    const start = MOCK_CONTENT.indexOf(excerpt);
    crlf.findings[0].anchor = { type: 'TEXT_RANGE', range: { start, end: start + excerpt.length }, sceneIdentity: null, sourceExcerpt: excerpt };
    validateReviewProcessorResult(crlf, context, 'MOCK_V1');
  }
  const before = JSON.stringify(context);
  await assert.rejects(() => executeReviewProcessor({ processorKey: 'MOCK_V1', async review(copy) { copy.episode.content = '변조'; const result = structuredClone(valid); result.findings[0].anchor.sourceExcerpt = '변조'; return result; } }, context), error => error.code === 'REVIEW_FINDING_RANGE_INVALID');
  assert.equal(JSON.stringify(context), before);
  const stub = await executeReviewProcessor(createStubReviewProcessor(), context);
  assert.deepEqual(stub.findings, []); assert.ok(context.warnings.length > 0);
  console.log('PASS Contract: enums/bounds/UTF-16/CRLF/scene/excerpt/Canon scope/roles/ambiguity/provenance/context isolation/empty Stub');
}

/** 실패 또는 성공 작업 뒤 두 번째 FIFO 작업까지 실행해 원자성 및 잠금 해제를 확인한다. */
async function runQueuePair(storage, fixture, mode, trigger = null) {
  const holder = createReviewQueue(storage); holder.stop();
  const submitted = [];
  for (const episode of fixture.episodes) submitted.push(await holder.submit({ workId: fixture.workId, episodeId: episode.id }));
  let calls = 0;
  const queue = createReviewQueue(storage, () => calls++ === 0 ? createMockReviewProcessor(mode) : createStubReviewProcessor());
  if (trigger) getDatabase().exec(trigger);
  try {
    queue.start();
    await waitFor(() => jobs.getById(submitted[1].id).status === 'COMPLETED');
    const first = jobs.getById(submitted[0].id);
    const run = runs.getById(first.reviewRunId);
    const expected = ['INVALID_RANGE', 'INVALID_EXCERPT', 'INVALID_CANON', 'MISSING_FIELD', 'PARTIAL_INVALID', 'THROW', 'STORAGE_FAILURE'].includes(mode) ? 'FAILED' : 'COMPLETED';
    assert.equal(first.status, expected); assert.equal(run.status, expected);
    if (expected === 'FAILED') { assert.deepEqual(run.findings, []); assert.equal(run.contractVersion, null); }
    assert.equal(calls, 2);
    jobs.assertEpisodeUnlocked(fixture.episodes[0].id);
    jobs.assertEpisodeUnlocked(fixture.episodes[1].id);
    assert.equal(getDatabase().prepare("SELECT COUNT(*) n FROM review_jobs WHERE status = 'RUNNING'").get().n, 0);
    assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    return run;
  } finally { queue.stop(); if (trigger) getDatabase().exec('DROP TRIGGER finding_storage_failure'); }
}

/** 완료와 실패 저장이 모두 불가능하면 다음 작업을 멈추고 재시작 복구 정책으로 회복한다. */
async function validateUnwritableTerminal(storage, fixture) {
  const holder = createReviewQueue(storage); holder.stop();
  const first = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[0].id });
  const next = await holder.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id });
  let calls = 0;
  const queue = createReviewQueue(storage, () => { calls++; return createMockReviewProcessor(); });
  getDatabase().exec("CREATE TEMP TRIGGER block_terminal BEFORE UPDATE OF status ON review_jobs WHEN NEW.status IN ('COMPLETED', 'FAILED') BEGIN SELECT RAISE(FAIL, 'test terminal storage failure'); END");
  try {
    queue.start();
    await waitFor(() => jobs.getById(first.id).status === 'RUNNING');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(jobs.getById(first.id).status, 'RUNNING');
    assert.equal(jobs.getById(next.id).status, 'QUEUED');
    assert.equal(calls, 1);
    assert.deepEqual(runs.getById(jobs.getById(first.id).reviewRunId).findings, []);
    assert.throws(() => jobs.assertEpisodeUnlocked(fixture.episodes[0].id), error => error.code === 'EPISODE_REVIEW_LOCKED');
  } finally { queue.stop(); getDatabase().exec('DROP TRIGGER block_terminal'); }
  const recovered = createReviewQueue(storage);
  try { recovered.start(); await waitFor(() => jobs.getById(next.id).status === 'COMPLETED'); assert.equal(jobs.getById(first.id).errorCode, 'REVIEW_INTERRUPTED'); }
  finally { recovered.stop(); }
  console.log('PASS terminal storage failure: rollback, no duplicate execution, restart recovery');
}

/** 실제 012 형식의 Legacy Run/Finding을 백업 후 확장하고 값·해시·현재성을 보존한다. */
async function validateMigration(root) {
  const file = path.join(root, 'migration.db'); initializeDatabase(file);
  const storage = new LocalEpisodeStorage(root); await storage.ensureBaseStorage();
  const fixture = createFindingFixture(storage); const input = { workId: fixture.workId, episodeId: fixture.episodes[0].id };
  const source = buildCurrentSource(await buildEpisodeWorkContext(storage, input));
  const legacy = runs.createRun({ ...input, ...source, processorKey: 'STUB_V1', contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2' });
  completeLegacyRun(legacy.id, [{ category: 'TYPO', message: '과거 메시지' }]);
  const db = getDatabase();
  db.exec('DROP TRIGGER review_job_processor_immutable; ALTER TABLE review_jobs DROP COLUMN processor_key; ALTER TABLE review_runs DROP COLUMN findings_contract_version; ALTER TABLE review_findings DROP COLUMN contract_version; ALTER TABLE review_findings DROP COLUMN details_json; DELETE FROM schema_migrations WHERE version >= 13');
  const before = db.prepare('SELECT * FROM review_runs').all(); const oldFindings = db.prepare('SELECT * FROM review_findings').all();
  closeDatabase();
  const blocked = path.join(root, 'blocked'); fs.mkdirSync(blocked); fs.copyFileSync(file, path.join(blocked, 'db')); fs.writeFileSync(path.join(blocked, 'backups'), '백업 실패 fixture');
  assert.throws(() => initializeDatabase(path.join(blocked, 'db')));
  const unchanged = new DatabaseSync(path.join(blocked, 'db'), { readOnly: true });
  try { assert.equal(unchanged.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 12); assert.deepEqual(unchanged.prepare('SELECT * FROM review_runs').all(), before); } finally { unchanged.close(); }
  initializeDatabase(file);
  const migrated = runs.getById(legacy.id);
  assert.equal(migrated.contractVersion, null); assert.equal(migrated.findings[0].contractVersion, null);
  assert.equal('assessment' in migrated.findings[0], false);
  assert.equal((await getReviewById(storage, legacy.id)).freshness.isCurrent, true);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_runs').all().map(({ findings_contract_version, ...row }) => row), before.map(row => ({ ...row })));
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_findings').all().map(({ contract_version, details_json, ...row }) => row), oldFindings.map(row => ({ ...row })));
  const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task029-')); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(root, 'backups', backups[0]), { readOnly: true });
  try { assert.deepEqual(backup.prepare('SELECT * FROM review_findings').all(), oldFindings); assert.equal(backup.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 12); } finally { backup.close(); }
  closeDatabase(); initializeDatabase(file); assert.equal(fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task029-')).length, 1);
  console.log('PASS migration 012→013: backup/failure/idempotency/legacy rows/hash/freshness');
}

/** Repository가 비검증 결과 및 다른 Work/Processor 결과를 원자적으로 거부하는지 검증한다. */
async function validatePersistenceGuards(source, foreignContext) {
  const context = source.reviewContext;
  const run = runs.createRun({ workId: context.work.id, episodeId: context.episode.id, ...source, processorKey: 'MOCK_V1', contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2' });
  const draft = await createMockReviewProcessor().review(context);
  const foreignResult = validateReviewProcessorResult({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] }, foreignContext, 'MOCK_V1');
  const wrongProcessor = validateReviewProcessorResult(draft, context, 'STUB_V1');
  for (const result of [draft, foreignResult, wrongProcessor]) {
    assert.throws(() => runs.completeRun(run.id, result), error => error.code === 'REVIEW_RESULT_INVALID');
    assert.equal(runs.getById(run.id).status, 'RUNNING'); assert.deepEqual(runs.getById(run.id).findings, []);
  }
  runs.failRun(run.id);
  console.log('PASS Repository: unvalidated result, Work/Episode scope and Processor provenance guards');
}

/** 검토가 원본 Generic Canon 값·참조·별칭과 Episode metadata를 변경하지 않는지 비교한다. */
function sourceRows() {
  return ['episodes', 'canon_records', 'canon_field_values', 'canon_record_references', 'canon_record_option_values', 'canon_record_aliases', 'scene_narration_metadata'].map(table => getDatabase().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
}

/** 임시 DB와 가상 TXT에서 계약·Queue·이력·migration을 통합 검증한다. */
async function validate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-findings-'));
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  try {
    const file = path.join(root, 'novelcompany.db'); initializeDatabase(file);
    const storage = new LocalEpisodeStorage(root); await storage.ensureBaseStorage();
    const fixture = createFindingFixture(storage); const input = { workId: fixture.workId, episodeId: fixture.episodes[0].id };
    const source = buildCurrentSource(await buildEpisodeWorkContext(storage, input));
    const foreign = createAliasFixture('외부 가상 작품');
    await validateContract(source.reviewContext, foreign.characters[0].id);
    const foreignEpisode = createEpisodeWithContent(storage, { workId: foreign.workId, episodeNumber: 1, title: '외부 회차', content: '가상 외부 원고' });
    await validatePersistenceGuards(source, buildCurrentSource(await buildEpisodeWorkContext(storage, { workId: foreign.workId, episodeId: foreignEpisode.id })).reviewContext);
    const beforeCanon = sourceRows();
    const beforeText = fs.readFileSync(storage.resolveManagedPath(fixture.workId, getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(input.episodeId).storage_key));
    const successful = await runQueuePair(storage, fixture, 'MULTIPLE');
    assert.equal(successful.contractVersion, 'REVIEW_FINDINGS_V1');
    assert.equal(new Set(successful.findings.map(finding => finding.id)).size, 3);
    assert.deepEqual(successful.findings.map(finding => finding.sortOrder), [0, 1, 2]);
    assert.ok(successful.findings.every(finding => finding.reviewRunId === successful.id));
    assert.ok(successful.findings.every(finding => finding.provenance.processorKey === 'MOCK_V1'));
    for (const mode of ['TEXT', 'CANON', 'AMBIGUOUS', 'EMPTY', 'INVALID_RANGE', 'INVALID_EXCERPT', 'INVALID_CANON', 'MISSING_FIELD', 'PARTIAL_INVALID', 'THROW']) await runQueuePair(storage, fixture, mode);
    const logFile = path.join(root, 'logs', 'novelcompany.log');
    assert.equal(fs.readFileSync(logFile, 'utf8').includes(MOCK_CONTENT), false);
    for (const trigger of [
      "CREATE TEMP TRIGGER finding_storage_failure BEFORE INSERT ON review_findings WHEN NEW.sort_order = 1 BEGIN SELECT RAISE(FAIL, 'test partial insertion failure'); END",
      "CREATE TEMP TRIGGER finding_storage_failure BEFORE UPDATE OF status ON review_runs WHEN NEW.status = 'COMPLETED' AND NEW.processor_key = 'MOCK_V1' BEGIN SELECT RAISE(FAIL, 'test Run completion failure'); END",
      "CREATE TEMP TRIGGER finding_storage_failure BEFORE UPDATE OF status ON review_jobs WHEN NEW.status = 'COMPLETED' AND (SELECT processor_key FROM review_runs WHERE id = NEW.review_run_id) = 'MOCK_V1' BEGIN SELECT RAISE(FAIL, 'test Job completion failure'); END",
    ]) await runQueuePair(storage, fixture, 'STORAGE_FAILURE', trigger);
    console.log('PASS Queue: success/empty/validation/throw/partial insert/Run update/Job update rollback/FIFO/unlock');
    await validateUnwritableTerminal(storage, fixture);
    assert.deepEqual(sourceRows(), beforeCanon);
    assert.deepEqual(fs.readFileSync(storage.resolveManagedPath(fixture.workId, getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(input.episodeId).storage_key)), beforeText);
    const immutable = structuredClone(successful.findings);
    closeDatabase(); initializeDatabase(file);
    assert.deepEqual((await getReviewById(storage, successful.id)).findings, immutable);
    const char = records.getById(fixture.scope.character, fixture.characters[0].id);
    records.update(fixture.scope.character, char.id, { displayName: '변경된 가상 이름', fieldValues: char.fieldValues });
    records.update(fixture.scope.world, fixture.world.id, inputFor(fixture.scope.world, '변경된 가상 세계'));
    assert.deepEqual((await getReviewById(storage, successful.id)).findings, immutable);
    assert.equal((await getReviewById(storage, successful.id)).freshness.isCurrent, false);
    updateEpisodeWithContent(storage, input.episodeId, { workId: fixture.workId, episodeNumber: 1, title: '변경된 가상 원고', status: fixture.episodes[0].status, content: '수정된 원고' });
    assert.deepEqual((await getReviewById(storage, successful.id)).findings, immutable);
    canon.deleteCanonForWork(fixture.workId);
    const deletedCanon = await getReviewById(storage, successful.id);
    assert.deepEqual(deletedCanon.findings, immutable); assert.equal(deletedCanon.freshness.canonComparison, 'UNAVAILABLE');
    assert.ok((await getReviewsByEpisode(storage, input)).length > 1);
    console.log('PASS immutable history: restart/rename/manuscript edit/Canon deletion; original data unchanged during review');
    closeDatabase(); await validateMigration(root);
    console.log('Task029 Review Findings validation passed.');
  } finally { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.NOVEL_COMPANY_DATA_DIR; }
}

module.exports = { createFindingFixture, waitFor };
if (require.main === module) validate().catch(error => { console.error(error); process.exitCode = 1; });
