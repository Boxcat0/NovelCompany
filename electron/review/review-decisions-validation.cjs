const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-decisions-'));
process.env.NOVEL_COMPANY_DATA_DIR = root;
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');
const decisions = require('../database/repositories/review-decision-repository.cjs');
const runs = require('../database/repositories/review-repository.cjs');
const jobs = require('../database/repositories/review-job-repository.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createRuleFixture } = require('./testing/rule-review-fixtures.cjs');
const { startEpisodeReview, getReviewById } = require('./review-service.cjs');
const { createRuleReviewProcessor } = require('./rule-review-processor.cjs');
const { completeLegacyRun } = require('./testing/finding-fixtures.cjs');
const backup = require('../backup/data-backup-service.cjs');
const updater = require('../backup/data-update-service.cjs');

/** 판단 테이블을 제외한 모든 영속 행을 비교해 원본 불변을 검사한다. */
function snapshot() {
  return JSON.stringify(getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'review_finding_decision_events' ORDER BY name").all().map(({ name }) => [name, getDatabase().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

/** 코드와 한국어 메시지가 의도한 입력 실패를 정확하게 표현하는지 확인한다. */
function rejects(action, code) { assert.throws(action, error => error.code === code && /[가-힣]/.test(error.message)); }

/** 새 Node 프로세스의 실제 Repository에서 상태·메모·전체 이력의 영속성을 확인한다. */
function assertRestartHistory(dataRoot, scope, expected) {
  const code = `const path = require('node:path');
    const { initializeDatabase, closeDatabase } = require(path.join(process.argv[3], 'database/database.cjs'));
    try {
      initializeDatabase(path.join(process.argv[1], 'novelcompany.db'));
      const repository = require(path.join(process.argv[3], 'database/repositories/review-decision-repository.cjs'));
      process.stdout.write(JSON.stringify(repository.listFindingDecisionHistory(JSON.parse(process.argv[2]))));
    } finally { closeDatabase(); }`;
  const restarted = spawnSync(process.execPath, ['-e', code, dataRoot, JSON.stringify(scope), path.join(__dirname, '..')], {
    env: { ...process.env, NOVEL_COMPANY_DATA_DIR: dataRoot }, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(restarted.status, 0, restarted.error?.message ?? restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), expected);
}

/** 실제 Rule Finding에서 상태·순번·원본 불변·IPC·Queue·현재성·재검토를 검사한다. */
async function repositoryCases(storage) {
  const fixture = createRuleFixture(storage, '판단 검증 작품');
  const run = await startEpisodeReview(storage, { workId: fixture.workId, episodeId: fixture.episodes[0].id }, createRuleReviewProcessor());
  assert.ok(run.findings.length);
  const scope = { workId: fixture.workId, episodeId: run.episodeId, reviewRunId: run.id, findingId: run.findings[0].id };
  const before = snapshot(), txt = fs.readFileSync(storage.resolveManagedPath(fixture.workId, getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(run.episodeId).storage_key));
  assert.equal(decisions.getFindingDecision(scope).decisionStatus, 'UNREVIEWED');
  assert.equal(decisions.listFindingDecisionHistory(scope).length, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_finding_decision_events').get().n, 0);
  for (const [index, decisionStatus] of ['NEEDS_FIX', 'REJECTED', 'DEFERRED', 'RESOLVED'].entries()) {
    const saved = decisions.appendFindingDecision({ ...scope, decisionStatus, note: `메모 ${index + 1} <script>표시만</script>`, expectedRevision: index });
    assert.equal(saved.revision, index + 1); assert.equal(saved.decisionStatus, decisionStatus);
  }
  const current = decisions.getFindingDecision(scope);
  assert.deepEqual(decisions.listFindingDecisionHistory(scope).map(item => item.revision), [4, 3, 2, 1]);
  assert.deepEqual(decisions.listFindingDecisionsForRun(scope)[0], current);
  assert.deepEqual(decisions.appendFindingDecision({ ...scope, decisionStatus: current.decisionStatus, note: current.note, expectedRevision: 4 }), current);
  rejects(() => decisions.appendFindingDecision({ ...scope, decisionStatus: 'NEEDS_FIX', note: '', expectedRevision: 3 }), 'REVIEW_DECISION_CONFLICT');
  for (const change of [{ decisionStatus: 'UNREVIEWED' }, { decisionStatus: 'UNKNOWN' }, { note: null }, { note: 'x'.repeat(4001) }, { expectedRevision: -1 }, { expectedRevision: 1.5 }]) rejects(() => decisions.appendFindingDecision({ ...scope, decisionStatus: 'NEEDS_FIX', note: '', expectedRevision: 4, ...change }), 'REVIEW_DECISION_INPUT_INVALID');
  for (const key of ['workId', 'episodeId', 'reviewRunId', 'findingId']) rejects(() => decisions.getFindingDecision({ ...scope, [key]: randomUUID() }), 'REVIEW_DECISION_NOT_FOUND');
  assert.throws(() => getDatabase().prepare('UPDATE review_finding_decision_events SET note = ? WHERE finding_id = ?').run('변조', scope.findingId));
  assert.throws(() => getDatabase().prepare('DELETE FROM review_finding_decision_events WHERE finding_id = ?').run(scope.findingId));
  assert.throws(() => getDatabase().prepare('INSERT INTO review_finding_decision_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), scope.findingId, 'DEFERRED', '', 4, '1999-01-01'));
  getDatabase().exec("CREATE TRIGGER fail_decision AFTER INSERT ON review_finding_decision_events BEGIN SELECT RAISE(ABORT, 'injected'); END");
  rejects(() => decisions.appendFindingDecision({ ...scope, decisionStatus: 'NEEDS_FIX', note: '실패', expectedRevision: 4 }), 'REVIEW_DECISION_SAVE_FAILED');
  getDatabase().exec('DROP TRIGGER fail_decision'); assert.equal(decisions.listFindingDecisionHistory(scope).length, 4);
  assert.equal(snapshot(), before); assert.equal((await getReviewById(storage, run.id)).freshness.isCurrent, run.freshness.isCurrent);
  assert.deepEqual(fs.readFileSync(storage.resolveManagedPath(fixture.workId, getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(run.episodeId).storage_key)), txt);

  const handlers = new Map();
  const ipcMain = { /** 등록된 Main handler를 실제 Result 경로로 호출한다. */ handle(name, handler) { handlers.set(name, handler); } };
  const queue = require('./review-queue-service.cjs').createReviewQueue(storage);
  require('../ipc/review-handlers.cjs').registerReviewHandlers(ipcMain, storage, queue); queue.stop();
  const input = { ...scope, decisionStatus: 'DEFERRED', note: '두 창 경합', expectedRevision: 4 };
  const responses = await Promise.all([handlers.get('reviews:decisions:append')({}, input), handlers.get('reviews:decisions:append')({}, input)]);
  assert.equal(responses.filter(item => item.ok).length, 1); assert.equal(responses.find(item => !item.ok).error.code, 'REVIEW_DECISION_CONFLICT');
  const waiting = await queue.submit({ workId: scope.workId, episodeId: scope.episodeId });
  decisions.appendFindingDecision({ ...scope, decisionStatus: 'NEEDS_FIX', note: '대기 중 판단', expectedRevision: 5 });
  assert.equal(jobs.getById(waiting.id).status, 'QUEUED');
  jobs.claimWithRun(waiting.id, 'STUB_V1');
  const runningBefore = JSON.stringify(jobs.getById(waiting.id));
  decisions.appendFindingDecision({ ...scope, decisionStatus: 'RESOLVED', note: '실행 중 판단', expectedRevision: 6 });
  assert.equal(JSON.stringify(jobs.getById(waiting.id)), runningBefore);
  jobs.failRunning(waiting.id, 'TEST', '격리 검증 종료');
  const rerun = await startEpisodeReview(storage, { workId: scope.workId, episodeId: scope.episodeId }, createRuleReviewProcessor());
  assert.ok(decisions.listFindingDecisionsForRun({ ...scope, reviewRunId: rerun.id }).every(item => item.revision === 0 && item.decisionStatus === 'UNREVIEWED'));
  const stub = await startEpisodeReview(storage, { workId: scope.workId, episodeId: scope.episodeId });
  assert.deepEqual(decisions.listFindingDecisionsForRun({ ...scope, reviewRunId: stub.id }), []);
  const legacy = runs.createRun({ ...runs.getById(run.id), processorKey: 'STUB_V1' });
  completeLegacyRun(legacy.id, [{ category: 'TEXT', message: '이전 결과' }]);
  const legacyScope = { ...scope, reviewRunId: legacy.id, findingId: runs.getById(legacy.id).findings[0].id };
  decisions.appendFindingDecision({ ...legacyScope, decisionStatus: 'REJECTED', note: '이전 기록', expectedRevision: 0 });
  getDatabase().prepare('INSERT INTO review_finding_decision_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), legacyScope.findingId, 'DEFERRED', '시각보다 순번 우선', 2, '1999-01-01');
  assert.equal(decisions.getFindingDecision(legacyScope).revision, 2); assert.equal(decisions.getFindingDecision(legacyScope).decisionStatus, 'DEFERRED');
  assert.throws(() => getDatabase().prepare('INSERT INTO review_finding_decision_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), legacyScope.findingId, 'DEFERRED', '', 4, '1999-01-01'));
  assert.equal((await getReviewById(storage, legacy.id)).findings[0].contractVersion, null);
  assert.throws(() => getDatabase().prepare('DELETE FROM episodes WHERE id = ?').run(scope.episodeId));
  rejects(() => require('../database/repositories/work-repository.cjs').deleteWork(scope.workId), 'WORK_DELETE_BLOCKED_BY_DEPENDENCIES');
  getDatabase().exec('BEGIN IMMEDIATE');
  getDatabase().prepare('DELETE FROM review_findings WHERE id = ?').run(legacyScope.findingId);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_finding_decision_events WHERE finding_id = ?').get(legacyScope.findingId).n, 0);
  getDatabase().exec('ROLLBACK'); assert.equal(decisions.getFindingDecision(legacyScope).revision, 2);
  const episode = fixture.episodes[0];
  require('../episode-service.cjs').updateEpisodeWithContent(storage, episode.id, { workId: scope.workId, episodeNumber: 1, title: episode.title, content: '변경된 가상 TXT' });
  assert.equal((await getReviewById(storage, run.id)).freshness.isCurrent, false); assert.equal(decisions.getFindingDecision(scope).decisionStatus, 'RESOLVED');
  require('../database/repositories/canon-definition-repository.cjs').deleteCanonForWork(scope.workId);
  assert.equal((await getReviewById(storage, run.id)).freshness.canonComparison, 'UNAVAILABLE');
  assert.equal(decisions.getFindingDecision(scope).revision, 7);
  console.log('PASS decisions: states/notes/revisions/no-op/conflict/scope/rollback/append-only/Legacy/Rule/Stub/queue/freshness/lifecycle/original immutability');
  return scope;
}

/** 백업의 실제 DB/TXT 교체와 업데이트의 로컬 판단 보존·원격 판단 제외를 검사한다. */
function backupCases(scope) {
  const source = root, target = path.join(root, 'target'), zip = path.join(root, 'decisions.zip');
  const expected = decisions.listFindingDecisionHistory(scope);
  backup.exportSnapshot(source, zip, '0.1.0'); closeDatabase(); fs.mkdirSync(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  backup.replaceData(target, zip, '0.1.0'); backup.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.deepEqual(decisions.listFindingDecisionHistory(scope), expected);
  closeDatabase(); assertRestartHistory(target, scope, expected); initializeDatabase(path.join(target, 'novelcompany.db'));
  decisions.appendFindingDecision({ ...scope, decisionStatus: 'DEFERRED', note: '로컬 판단 보존', expectedRevision: 7 });
  const local = decisions.listFindingDecisionHistory(scope);
  closeDatabase(); initializeDatabase(path.join(source, 'novelcompany.db'));
  decisions.appendFindingDecision({ ...scope, decisionStatus: 'REJECTED', note: '원격 판단은 병합하지 않음', expectedRevision: 7 });
  getDatabase().prepare('UPDATE works SET description = ? WHERE id = ?').run('원격 작품 정보 수정', scope.workId);
  const incomingZip = path.join(root, 'remote.zip'); backup.exportSnapshot(source, incomingZip, '0.1.0');
  closeDatabase(); initializeDatabase(path.join(target, 'novelcompany.db'));
  const unpacked = path.join(root, 'incoming'), validated = backup.validatePackage(incomingZip, unpacked);
  const plan = updater.previewUpdate(target, unpacked, validated, path.join(root, 'plan'), '0.1.0');
  assert.equal(plan.conflicts.length, 0); assert.ok(plan.mergedZip);
  decisions.appendFindingDecision({ ...scope, decisionStatus: 'NEEDS_FIX', note: '미리보기 이후 판단', expectedRevision: 8 });
  rejects(() => updater.assertUnchanged(target, plan.fingerprint), 'UPDATE_STALE_PREVIEW');
  const latest = decisions.listFindingDecisionHistory(scope);
  const refreshed = updater.previewUpdate(target, unpacked, validated, path.join(root, 'plan-refreshed'), '0.1.0');
  backup.replaceData(target, refreshed.mergedZip, '0.1.0'); backup.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.deepEqual(decisions.listFindingDecisionHistory(scope), latest); assert.equal(local.length, 8);
  assert.equal(getDatabase().prepare('SELECT description FROM works WHERE id = ?').get(scope.workId).description, '원격 작품 정보 수정');
  closeDatabase(); assertRestartHistory(target, scope, latest);
  console.log('PASS decisions backup/update: latest Schema ZIP, exact history restore/new-process restart, local decisions preserved, remote excluded, stale preview blocked');
}

/** 정식 014 데이터의 사전 백업·015 추가·실패 보존과 ZIP 격리 Migration을 검사한다. */
function migrationCases() {
  const directory = path.join(root, 'schema14'); fs.mkdirSync(directory);
  const file = path.join(directory, 'novelcompany.db'), db = new DatabaseSync(file);
  require('../database/migrate.cjs').runMigrations(db, path.join(__dirname, '../database/migrations'), 14);
  db.exec('PRAGMA foreign_keys = ON');
  const now = '2026-01-01T00:00:00.000Z', content = Buffer.from('이전 회차 원문\r\n판단 이전의 검토 결과'), storageKey = new LocalEpisodeStorage(directory).getStorageKey('legacy-work', 1);
  const originalTxt = path.join(directory, 'works', storageKey);
  fs.mkdirSync(path.dirname(originalTxt), { recursive: true }); fs.writeFileSync(originalTxt, content);
  db.prepare('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)').run('legacy-work', '이전 작품', null, 'ACTIVE', now, now);
  db.prepare('INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-episode', 'legacy-work', 1, '이전 회차', 'DRAFT', storageKey, backup.sha256(content), now, now);
  db.prepare("INSERT INTO review_runs (id, work_id, episode_id, status, processor_key, episode_content_hash, canon_context_hash, created_at, started_at, completed_at) VALUES (?, ?, ?, 'COMPLETED', 'STUB_V1', ?, ?, ?, ?, ?)").run('legacy-run', 'legacy-work', 'legacy-episode', backup.sha256(content), 'legacy-canon-hash', now, now, now);
  db.prepare('INSERT INTO review_findings (id, review_run_id, category, message, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('legacy-finding', 'legacy-run', 'TEXT', '이전 발견 사항 원본', 0, now);
  const tables = ['works', 'episodes', 'review_runs', 'review_findings'];
  const originalRows = tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all());
  db.close();
  const bytes = fs.readFileSync(file), output = path.join(root, 'schema14.zip');
  const manuscriptEntry = 'manuscripts/' + storageKey;
  const manifest = { formatVersion: backup.FORMAT, createdAt: new Date().toISOString(), applicationVersion: '0.1.0', databaseSchemaVersion: 14, files: [{ relativePath: backup.DB_ENTRY, size: bytes.length, sha256: backup.sha256(bytes) }, { relativePath: manuscriptEntry, size: content.length, sha256: backup.sha256(content) }] };
  require('../backup/backup-zip.cjs').writeZip(output, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: backup.DB_ENTRY, data: bytes }, { name: manuscriptEntry, data: content }]);
  const originalZip = fs.readFileSync(output);
  const validated = backup.validatePackage(output, path.join(root, 'schema14-import'));
  assert.equal(validated.sourceSchemaVersion, 14); assert.equal(validated.summary.databaseSchemaVersion, 16);
  assert.deepEqual(fs.readFileSync(output), originalZip); assert.deepEqual(fs.readFileSync(file), bytes);
  const restored = path.join(root, 'schema14-restored');
  initializeDatabase(path.join(restored, 'novelcompany.db'));
  backup.replaceData(restored, output, '0.1.0'); backup.recoverInterruptedRestore(restored);
  initializeDatabase(path.join(restored, 'novelcompany.db'));
  assert.deepEqual(tables.map(table => getDatabase().prepare('SELECT * FROM ' + table + ' ORDER BY id').all()), originalRows);
  assert.deepEqual(fs.readFileSync(path.join(restored, 'works', storageKey)), content);
  const scope = { workId: 'legacy-work', episodeId: 'legacy-episode', reviewRunId: 'legacy-run', findingId: 'legacy-finding' };
  assert.equal(decisions.getFindingDecision(scope).decisionStatus, 'UNREVIEWED');
  closeDatabase(); assertRestartHistory(restored, scope, []);
  const blocked = path.join(root, 'migration-blocked'); fs.mkdirSync(blocked); fs.copyFileSync(file, path.join(blocked, 'db')); fs.writeFileSync(path.join(blocked, 'backups'), 'blocked');
  assert.throws(() => initializeDatabase(path.join(blocked, 'db'))); assert.deepEqual(fs.readFileSync(path.join(blocked, 'db')), bytes);
  initializeDatabase(file); assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_finding_decision_events').get().n, 0);
  assert.deepEqual(tables.map(table => getDatabase().prepare('SELECT * FROM ' + table + ' ORDER BY id').all()), originalRows);
  assert.equal(getDatabase().prepare('SELECT title FROM works').get().title, '이전 작품');
  assert.deepEqual(fs.readFileSync(originalTxt), content);
  const backups = fs.readdirSync(path.join(directory, 'backups')).filter(name => name.startsWith('before-task031-'));
  assert.equal(backups.length, 1);
  const saved = new DatabaseSync(path.join(directory, 'backups', backups[0]), { readOnly: true });
  try {
    assert.equal(saved.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 14);
    assert.deepEqual(tables.map(table => saved.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()), originalRows);
  } finally { saved.close(); }
  closeDatabase(); initializeDatabase(file); assert.equal(fs.readdirSync(path.join(directory, 'backups')).length, 1); closeDatabase();
  console.log('PASS migration 014→latest: before-write backup/failure/idempotence/Review rows preserved/isolated ZIP conversion/full DB+TXT restore/new-process restart/original ZIP unchanged');
}

/** 임시 저장소만 사용하여 판단·복원·실제 Electron UI 검증을 실행한다. */
async function run() {
  try {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    const scope = await repositoryCases(new LocalEpisodeStorage(root)); backupCases(scope); migrationCases();
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const ui = spawnSync(require('electron'), [path.join(__dirname, 'review-decisions-ui-validation.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    process.stdout.write(ui.stdout ?? ''); process.stderr.write(ui.stderr ?? ''); assert.equal(ui.status, 0, 'Author Decision Electron UI');
    const uiRoot = JSON.parse(ui.stdout.trim().split(/\r?\n/).at(-1)).temporaryRoot;
    assert.ok(path.resolve(uiRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(uiRoot).startsWith('novelcompany-decision-ui-'));
    fs.rmSync(uiRoot, { recursive: true, force: true });
  } finally { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
