const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, closeDatabase, getDatabase, withDatabaseConnection } = require('../database/database.cjs');
const staging = require('../database/repositories/canon-staging-repository.cjs');
const promotion = require('./canon-promotion.cjs');
const { parseImport } = require('./canon-import.cjs');
const { createScope, documentFixture, readySelection } = require('./testing/staging-fixtures.cjs');
const backup = require('../backup/data-backup-service.cjs');
/** 공개 오류 코드를 확인하며 내부 데이터나 경로에 의존하지 않는다. */
function rejects(action, code) { assert.throws(action, error => error.code === code, code); }
/** 실제 Import를 통해 가상 후보를 Staging에만 저장한다. */
function store(scope) { const parsed = parseImport(Buffer.from(JSON.stringify(documentFixture()))), preview = staging.previewImport(scope, parsed); staging.importCandidates(scope, parsed, 'virtual.json', preview.fingerprint); }
/** 실제 Main·Preload 계약에서 파일 선택, 취소, 승인 token, stale 및 비공개 로그 보호를 확인한다. */
async function ipcCases(root) {
  const scope = createScope(), handlers = new Map(), file = path.join(root, 'import.json');
  fs.writeFileSync(file, JSON.stringify(documentFixture()));
  let cancelled = false;
  const dialog = { /** 격리 Fixture만 네이티브 파일 선택 결과로 제공한다. */ async showOpenDialog() { return { canceled: cancelled, filePaths: cancelled ? [] : [file] }; } };
  require('../ipc/canon-handlers.cjs').registerCanonHandlers({ /** 실제 Main handler를 수집한다. */ handle(channel, action) { handlers.set(channel, action); } }, { dialog });
  const event = { sender: { id: 501, once() {}, isDestroyed() { return false; } } };
  const api = require('../ipc/preload-api.cjs').createNovelCompanyApi({ /** 실제 Result handler를 호출한다. */ invoke(channel, ...args) { return handlers.get(channel)(event, ...args); } }).canon.staging;
  const before = getDatabase().prepare('SELECT COUNT(*) n FROM canon_staging_records').get().n;
  const preview = await api.previewImport(scope); assert.equal(preview.ok, true); assert.equal(preview.data.total, 168);
  assert.equal(JSON.stringify(preview).includes(root), false); assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_staging_records').get().n, before);
  assert.equal((await api.import(scope, preview.data.token, false)).error.code, 'CANON_STAGING_APPROVAL_REQUIRED');
  assert.equal((await handlers.get('canon:staging:import')({ sender: { id: 502 } }, scope, preview.data.token, true)).error.code, 'CANON_STAGING_APPROVAL_REQUIRED');
  await api.cancelPreview(); assert.equal((await api.import(scope, preview.data.token, true)).error.code, 'CANON_STAGING_APPROVAL_REQUIRED');
  cancelled = true; assert.deepEqual(await api.previewImport(scope), { ok: true, data: null }); cancelled = false;
  const accepted = await api.previewImport(scope); assert.equal((await api.import(scope, accepted.data.token, true)).data.createdCount, 168);
  const overview = await api.list(scope); assert.equal(overview.data.records.length, 168);
  const row = overview.data.records.find(row => row.draftKey === 'world:0'), detail = await api.get(scope, row.id); assert.equal(detail.data.revision, 1);
  const prepared = await api.previewPromotion(scope, [{ id: row.id, expectedRevision: 1 }]); assert.equal(prepared.data.canExecute, true);
  assert.equal((await api.update(scope, row.id, { displayName: '명시적 수정', fields: {}, references: {}, authorPrivate: false, expectedRevision: 1 })).ok, true);
  assert.equal((await api.promote(scope, prepared.data.token, true)).error.code, 'CANON_STAGING_STALE_PREVIEW');
  const privateRow = overview.data.records.find(row => row.draftKey === 'character:62');
  const privatePreview = await api.previewPromotion(scope, [{ id: privateRow.id, expectedRevision: 1 }]); assert.equal(privatePreview.data.token, null);
  const release = require('../backup/data-operation-gate.cjs').acquireDataOperation();
  try { assert.equal((await api.list(scope)).error.code, 'DATA_OPERATION_BUSY'); } finally { release(); }
  console.log('PASS Staging IPC: real Main/preload, file selection, preview-only, cancel/approval/window token, stale commit, private refusal, exclusive data gate');
}
/** Staging Import・수정이 실제 Context・Rule・현재성・TXT・실행 중 Job을 바꾸지 않음을 검사한다. */
async function isolationCases(root) {
  const scope = createScope(), storage = new (require('../storage/local-episode-storage.cjs').LocalEpisodeStorage)(root);
  const episode = require('../episode-service.cjs').createEpisodeWithContent(storage, { workId: scope.workId, episodeNumber: 1, title: '가상 원고', content: '가상 character 1은 문을 열었다.' });
  const input = { workId: scope.workId, episodeId: episode.id }, builder = require('../context/episode-work-context-builder.cjs').buildEpisodeWorkContext, reviewBuilder = require('../context/review-context-builder.cjs').buildEpisodeReviewContext;
  const fullBefore = await builder(storage, input), reviewBefore = await reviewBuilder(storage, input);
  const service = require('../review/review-service.cjs'), run = await service.startEpisodeReview(storage, input, require('../review/rule-review-processor.cjs').createRuleReviewProcessor());
  const originalRun = getDatabase().prepare('SELECT * FROM review_runs WHERE id = ?').get(run.id);
  store(scope); const rows = staging.list(scope), world = rows.find(row => row.draftKey === 'world:0');
  staging.update(scope, world.id, { displayName: world.candidate.display_name, fields: world.candidate.fields, references: {}, authorPrivate: false, expectedRevision: 1 });
  assert.deepEqual(await builder(storage, input), fullBefore); assert.deepEqual(await reviewBuilder(storage, input), reviewBefore);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_runs WHERE id = ?').get(run.id), originalRun);
  assert.equal((await service.getReviewById(storage, run.id)).freshness.isCurrent, true);
  assert.equal((await service.startEpisodeReview(storage, input, require('../review/rule-review-processor.cjs').createRuleReviewProcessor())).findings.length, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases').get().n, 0);
  const fullRun = require('../database/repositories/review-repository.cjs').createRun({ workId: scope.workId, episodeId: episode.id, processorKey: 'STUB_V1', contextMode: 'FULL_CANON_V1', episodeContentHash: service.buildEpisodeContentHash(fullBefore), canonContextHash: service.buildCanonContextHash(fullBefore.canon) });
  require('../review/testing/finding-fixtures.cjs').completeLegacyRun(fullRun.id);
  const queue = require('../review/review-queue-service.cjs').createReviewQueue(storage); queue.stop();
  const job = await queue.submit(input), jobs = require('../database/repositories/review-job-repository.cjs');
  const selection = [{ id: world.id, expectedRevision: staging.get(scope, world.id).revision }];
  const preview = promotion.preview(scope, selection);
  rejects(() => promotion.promote(scope, selection, preview.fingerprint), 'CANON_PROMOTION_REVIEW_LOCKED');
  jobs.claimWithRun(job.id, 'STUB_V1'); const running = jobs.getById(job.id);
  rejects(() => promotion.promote(scope, selection, preview.fingerprint), 'CANON_PROMOTION_REVIEW_LOCKED');
  assert.deepEqual(jobs.getById(job.id), running); jobs.failRunning(job.id, 'TEST', '격리 검증 완료');
  const prepared = promotion.preview(scope, selection); promotion.promote(scope, selection, prepared.fingerprint);
  assert.equal((await builder(storage, input)).canon.summary.recordCount, 1);
  assert.equal((await service.getReviewById(storage, fullRun.id)).freshness.canonChanged, true);
  assert.equal((await service.getReviewById(storage, run.id)).freshness.isCurrent, true);
  assert.equal(await storage.readEpisodeByStorageKey(episode.storageKey ?? getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(episode.id).storage_key), '가상 character 1은 문을 열었다.');
  console.log('PASS isolation: real FULL/Relevant/Rule/alias/freshness unchanged by Staging; promotion changes normal Canon hash; QUEUED/RUNNING blocked; TXT preserved');
}
/** 공식 015 파일과 Canon 행을 보존하면서 016 사전 백업·실패·원자 rollback·격리 ZIP Migration을 검사한다. */
function migrationCases(root) {
  closeDatabase();
  const folder = path.join(root, 'schema15'); fs.mkdirSync(folder);
  const file = path.join(folder, 'novelcompany.db'), db = new DatabaseSync(file), migrate = require('../database/migrate.cjs');
  migrate.runMigrations(db, path.join(__dirname, '../database/migrations'), 15); db.exec('PRAGMA foreign_keys = ON');
  const scope = withDatabaseConnection(db, () => { const scope = createScope(), set = stagingFallbackSet(scope); require('../database/repositories/canon-record-repository.cjs').create({ canonSpaceId: scope.canonSpaceId, setId: set }, { displayName: '보존할 기존 세계', fieldValues: {} }); return scope; });
  const records = db.prepare('SELECT * FROM canon_records').all(); db.close(); const bytes = fs.readFileSync(file);
  const rollbackFile = path.join(root, 'migration-rollback.db'); fs.copyFileSync(file, rollbackFile);
  const failing = new DatabaseSync(rollbackFile);
  failing.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 16 BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(() => migrate.runMigrations(failing, path.join(__dirname, '../database/migrations')));
  assert.equal(failing.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='canon_staging_records'").get().n, 0); assert.equal(failing.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 15); failing.close();
  const blocked = path.join(root, 'migration-backup-blocked'); fs.mkdirSync(blocked); fs.copyFileSync(file, path.join(blocked, 'db')); fs.writeFileSync(path.join(blocked, 'backups'), 'blocked');
  assert.throws(() => initializeDatabase(path.join(blocked, 'db'))); assert.deepEqual(fs.readFileSync(path.join(blocked, 'db')), bytes);
  const zip = path.join(root, 'schema15.zip'), manifest = { formatVersion: backup.FORMAT, applicationVersion: '0.1.0', createdAt: new Date().toISOString(), databaseSchemaVersion: 15, files: [{ relativePath: backup.DB_ENTRY, size: bytes.length, sha256: backup.sha256(bytes) }] };
  require('../backup/backup-zip.cjs').writeZip(zip, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: backup.DB_ENTRY, data: bytes }]);
  const originalZip = fs.readFileSync(zip), validated = backup.validatePackage(zip, path.join(root, 'schema15-extracted'));
  assert.equal(validated.sourceSchemaVersion, 15); assert.equal(validated.summary.databaseSchemaVersion, 16); assert.deepEqual(fs.readFileSync(zip), originalZip); assert.deepEqual(fs.readFileSync(file), bytes);
  initializeDatabase(file); assert.deepEqual(getDatabase().prepare('SELECT * FROM canon_records').all(), records); assert.equal(staging.list(scope).length, 0);
  assert.equal(fs.readdirSync(path.join(folder, 'backups')).filter(name => name.startsWith('before-canon-staging-')).length, 1);
  closeDatabase(); initializeDatabase(file); assert.equal(fs.readdirSync(path.join(folder, 'backups')).length, 1); closeDatabase();
  const target = path.join(root, 'schema15-installed'); initializeDatabase(path.join(target, 'novelcompany.db'));
  backup.replaceData(target, zip, '0.1.0'); backup.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.deepEqual(getDatabase().prepare('SELECT * FROM canon_records').all(), records); assert.equal(staging.list(scope).length, 0); closeDatabase();
  console.log('PASS Schema 015→016: Canon preserved, automatic before-write backup/failure/transaction rollback/idempotence, isolated ZIP migration/full restore/original unchanged');
}
/** 015 Fixture의 실제 World Set ID만 읽으며 신규 Staging API를 호출하지 않는다. */
function stagingFallbackSet(scope) { return getDatabase().prepare("SELECT id FROM canon_sets WHERE canon_space_id = ? AND key = 'world'").get(scope.canonSpaceId).id; }
/** 새 Node 프로세스에서 복원된 후보와 Promotion 연결을 실제 Repository로 다시 읽는다. */
function restartRows(target, scope) {
  const code = `const path=require('node:path'); const {initializeDatabase,closeDatabase}=require(path.join(process.argv[3],'database/database.cjs')); try { initializeDatabase(path.join(process.argv[1],'novelcompany.db')); console.log(JSON.stringify(require(path.join(process.argv[3],'database/repositories/canon-staging-repository.cjs')).list(JSON.parse(process.argv[2])))); } finally { closeDatabase(); }`;
  const child = spawnSync(process.execPath, ['-e', code, target, JSON.stringify(scope), path.join(__dirname, '..')], { env: { ...process.env, NOVEL_COMPANY_DATA_DIR: target }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr); return JSON.parse(child.stdout);
}
/** 016 전체 ZIP의 원본·revision·비공개·UUID 복원과 양측 Staging 업데이트 차단 및 삭제 lifecycle을 검사한다. */
async function backupCases(root) {
  initializeDatabase(path.join(root, 'novelcompany.db')); const scope = createScope(); store(scope);
  const rows = staging.list(scope), selection = readySelection(rows), preview = promotion.preview(scope, selection); promotion.promote(scope, selection, preview.fingerprint);
  const edit = rows.find(row => row.draftKey === 'world:1'); staging.update(scope, edit.id, { displayName: '복원할 수정 이름', fields: edit.candidate.fields, references: {}, authorPrivate: false, expectedRevision: 1 });
  const expected = staging.list(scope), expectedImports = getDatabase().prepare('SELECT * FROM canon_staging_imports WHERE canon_space_id = ? ORDER BY id').all(scope.canonSpaceId), zip = path.join(root, 'staging.zip'); backup.exportSnapshot(root, zip, '0.1.0'); closeDatabase();
  const target = path.join(root, 'staging-target'); initializeDatabase(path.join(target, 'novelcompany.db'));
  backup.replaceData(target, zip, '0.1.0'); backup.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.deepEqual(staging.list(scope), expected); assert.deepEqual(getDatabase().prepare('SELECT * FROM canon_staging_imports WHERE canon_space_id = ? ORDER BY id').all(scope.canonSpaceId), expectedImports);
  closeDatabase(); assert.deepEqual(restartRows(target, scope), expected); initializeDatabase(path.join(target, 'novelcompany.db'));
  const extracted = path.join(root, 'staging-update'), verified = backup.validatePackage(zip, extracted), updater = require('../backup/data-update-service.cjs');
  const before = JSON.stringify(staging.list(scope));
  rejects(() => updater.previewUpdate(target, extracted, verified, path.join(root, 'staging-merged'), '0.1.0'), 'UPDATE_STAGING_UNSUPPORTED'); assert.equal(JSON.stringify(staging.list(scope)), before);
  const empty = path.join(root, 'staging-empty'); closeDatabase(); initializeDatabase(path.join(empty, 'novelcompany.db'));
  rejects(() => updater.previewUpdate(empty, extracted, verified, path.join(root, 'remote-staging-merged'), '0.1.0'), 'UPDATE_STAGING_UNSUPPORTED'); closeDatabase(); initializeDatabase(path.join(target, 'novelcompany.db'));
  const canon = require('../database/repositories/canon-definition-repository.cjs'), works = require('../database/repositories/work-repository.cjs');
  assert.equal(canon.getCanonDeletionStatus(scope.workId).stagingRowCount, 182);
  rejects(() => works.deleteWork(scope.workId), 'WORK_DELETE_BLOCKED_BY_CANON');
  const others = getDatabase().prepare('SELECT * FROM canon_staging_records WHERE work_id <> ? ORDER BY id').all(scope.workId);
  canon.deleteCanonForWork(scope.workId); assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_staging_records WHERE work_id=?').get(scope.workId).n, 0);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM canon_staging_records WHERE work_id <> ? ORDER BY id').all(scope.workId), others);
  works.deleteWork(scope.workId); assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0); closeDatabase();
  console.log('PASS Staging ZIP 016: raw snapshot/revision/private/Promotion UUID/new-process restore; local+incoming update explicit refusal; Canon/Work deletion cascade with no orphans');
}
/** 운영 데이터에 접근하지 않고 호환성 단계들을 독립 임시 파일에서 실행한다. */
async function runCompatibility(root) { await ipcCases(root); await isolationCases(root); migrationCases(root); await backupCases(root); }
module.exports = { runCompatibility };
