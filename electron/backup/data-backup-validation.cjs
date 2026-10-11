const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createWork } = require('../database/repositories/work-repository.cjs');
const { createEpisodeWithContent } = require('../episode-service.cjs');
const { createReviewQueue } = require('../review/review-queue-service.cjs');
const service = require('./data-backup-service.cjs');
const gate = require('./data-operation-gate.cjs');
const { openZip, writeZip, LIMITS } = require('./backup-zip.cjs');

/** 모든 실제 영속 테이블을 비교용 객체로 읽는다. */
function snapshot(db = getDatabase()) {
  return JSON.parse(JSON.stringify(Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]))));
}
/** 등록된 TXT의 상대 경로와 SHA256만 비교 대상으로 읽는다. */
function manuscripts(root) {
  return Object.fromEntries(getDatabase().prepare('SELECT storage_key FROM episodes ORDER BY storage_key').all().map(row => [row.storage_key, service.sha256(fs.readFileSync(path.join(root, 'works', ...row.storage_key.split('/'))))]));
}
/** 기존 데이터가 있는 가상 두 번째 PC를 만들고 원본 비교값을 반환한다. */
function target(root) {
  closeDatabase(); fs.mkdirSync(root, { recursive: true }); initializeDatabase(path.join(root, 'novelcompany.db'));
  const work = createWork({ title: '교체 전 가상 작품' });
  const storage = new LocalEpisodeStorage(root);
  createEpisodeWithContent(storage, { workId: work.id, episodeNumber: 9, title: '이전 회차', content: '원본은 자동 백업과 rollback으로 보존됩니다.\r\n' });
  fs.writeFileSync(path.join(root, 'machine-settings.json'), '{"preserve":true}');
  return { database: snapshot(), txt: manuscripts(root) };
}
/** 실제 비동기 Worker 상태가 바뀔 때까지만 제한된 시간을 기다린다. */
async function waitFor(check) { for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('검토 대기열 시간 초과'); }
/** 손상된 패키지 입력마다 현재 DB와 원고가 그대로인지 확인한다. */
function rejectPackage(file, root, before, code) {
  const stage = fs.mkdtempSync(path.join(path.dirname(root), 'invalid-'));
  assert.throws(() => service.validatePackage(file, stage), error => (!code || error.code === code) && /[가-힣]/.test(error.message));
  assert.deepEqual(snapshot(), before.database); assert.deepEqual(manuscripts(root), before.txt);
}
/** 정상 ZIP의 내용만 독립 테스트 입력으로 읽는다. */
function entries(file) {
  const zip = openZip(file);
  try { return [...zip.entries.keys()].map(name => ({ name, data: zip.read(name) })); } finally { zip.close(); }
}
/** DB fixture 변경 뒤 Manifest 해시도 갱신하여 SQLite 검증 자체를 시험한다. */
function mutateDatabasePackage(original, output, temporary, mutate) {
  const list = entries(original), entry = list.find(entry => entry.name === service.DB_ENTRY);
  const file = path.join(temporary, 'mutation-' + require('node:crypto').randomUUID() + '.db'); fs.writeFileSync(file, entry.data);
  const db = new DatabaseSync(file); try { mutate(db); } finally { db.close(); }
  entry.data = fs.readFileSync(file);
  const manifestEntry = list.find(entry => entry.name === 'manifest.json'), manifest = JSON.parse(manifestEntry.data);
  const item = manifest.files.find(item => item.relativePath === service.DB_ENTRY); item.size = entry.data.length; item.sha256 = service.sha256(entry.data);
  manifestEntry.data = Buffer.from(JSON.stringify(manifest)); writeZip(output, list);
}
/** 헤더를 독립 변경하여 writer가 원래 금지하는 ZIP 공격을 검사한다. */
function attackPackage(original, output, change) {
  const buffer = fs.readFileSync(original); change(buffer); fs.writeFileSync(output, buffer);
}
/** 실제 프로세스 강제 종료 후 앱 시작 경로에서 journal 복구를 실행한다. */
function childMode() {
  const [mode, root, zip, stage] = process.argv.slice(2);
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  if (mode === '--recover') {
    service.recoverInterruptedRestore(root); initializeDatabase(path.join(root, 'novelcompany.db'));
    console.log(JSON.stringify({ database: snapshot(), txt: manuscripts(root) })); closeDatabase(); return true;
  }
  if (mode === '--crash') {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    service.replaceData(root, zip, '0.1.0', { hook: phase => { if (phase === stage) process.exit(86); } });
    assert.fail('크래시 지점이 실행되지 않았습니다.');
  }
  return false;
}
/** Temp DB·Storage·Profile에서 정상 이전, 공격, 경합, rollback와 강제 종료를 검증한다. */
async function validate() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-backup-test-'));
  const source = path.join(temporary, 'pc-a'), destination = path.join(temporary, 'pc-b');
  const zipFile = path.join(temporary, 'backup.zip');
  let queue;
  try {
    process.env.NOVEL_COMPANY_DATA_DIR = source; fs.mkdirSync(source); initializeDatabase(path.join(source, 'novelcompany.db'));
    getDatabase().exec('PRAGMA journal_mode = WAL');
    const storage = new LocalEpisodeStorage(source);
    const fixture = require('../review/testing/rule-review-fixtures.cjs').createRuleFixture(storage, '가상 백업 작품');
    const records = require('../database/repositories/canon-record-repository.cjs'), { inputFor } = require('../database/canon-record-validation.cjs');
    const location = records.getBySetId(fixture.scope.location)[0];
    records.create(fixture.scope.city, inputFor(fixture.scope.city, '가상 백업 도시', { location: location.id }));
    require('../database/repositories/canon-alias-repository.cjs').create({ workId: fixture.workId, recordId: fixture.characters[0].id }, '백업 별칭');
    const narration = require('../context/scene-narration-service.cjs');
    const scene = await narration.getForEpisode(storage, { workId: fixture.workId, episodeId: fixture.episodes[0].id });
    await narration.save(storage, { workId: fixture.workId, episodeId: fixture.episodes[0].id, expectedEpisodeContentHash: scene.episodeContentHash, expectedSceneLayoutVersion: scene.layoutVersion, expectedSceneIdentity: scene.scenes[0].identity, narration: { mode: 'FIRST_PERSON_CHARACTER', narratorCharacterId: fixture.characters[0].id } });
    queue = createReviewQueue(storage); queue.start();
    const job = await queue.submit({ workId: fixture.workId, episodeId: fixture.episodes[0].id, processorKey: 'RULE_V1' });
    const jobs = require('../database/repositories/review-job-repository.cjs');
    await waitFor(() => jobs.getById(job.id).status === 'COMPLETED' && queue.isIdle()); queue.stop();
    assert.ok(getDatabase().prepare('SELECT COUNT(*) n FROM review_findings').get().n > 0);
    const sourceBefore = snapshot(), txtBefore = manuscripts(source);
    const release = gate.acquireDataOperation();
    let blocked;
    try {
      const result = service.exportSnapshot(source, zipFile, '0.1.0', phase => { if (phase === 'snapshot') blocked = require('../ipc/ipc-action.cjs').executeIpcAction('works:create', () => createWork({ title: '차단되어야 함' })); });
      assert.equal(result.workCount, 1); assert.equal(result.episodeCount, 3);
    } finally { release(); }
    assert.equal((await blocked).error.code, 'DATA_OPERATION_BUSY'); assert.deepEqual(snapshot(), sourceBefore);
    const rawEntries = entries(zipFile);
    assert.ok(rawEntries.some(entry => entry.name === service.DB_ENTRY)); assert.equal(rawEntries.filter(entry => entry.name.startsWith('manuscripts/')).length, 3);
    assert.ok(rawEntries.every(entry => !/-wal|-shm|backups|logs|profile/.test(entry.name)));
    const validation = service.validatePackage(zipFile, path.join(temporary, 'good'));
    const exported = new DatabaseSync(path.join(temporary, 'good', service.DB_ENTRY), { readOnly: true });
    try { assert.deepEqual(snapshot(exported), sourceBefore); } finally { exported.close(); }
    const initialHash = service.sha256(fs.readFileSync(zipFile));
    assert.throws(() => service.exportSnapshot(source, zipFile, '0.1.0'), error => error.code === 'BACKUP_ALREADY_EXISTS');
    assert.equal(service.sha256(fs.readFileSync(zipFile)), initialHash);
    assert.throws(() => service.exportSnapshot(source, path.join(source, 'works', 'bad.zip'), '0.1.0'), error => error.code === 'BACKUP_OUTPUT_INVALID');
    assert.throws(() => service.exportSnapshot(source, path.join(source, 'novelcompany.db-wal'), '0.1.0'), error => error.code === 'BACKUP_OUTPUT_INVALID');
    assert.throws(() => service.exportSnapshot(source, path.join(temporary, 'failed.zip'), '0.1.0', phase => { if (phase === 'zip-entry') throw new Error('ZIP IO failure after first entry'); }));
    assert.equal(fs.existsSync(path.join(temporary, 'failed.zip')), false);
    gate.setEditorState(999, { dirty: true, busy: false }); assert.throws(() => gate.acquireDataOperation(), error => error.code === 'DATA_OPERATION_BUSY'); gate.removeEditor(999);
    let finishAccess; const access = gate.withDataAccess(() => new Promise(resolve => { finishAccess = resolve; }));
    assert.throws(() => gate.acquireDataOperation(), error => error.code === 'DATA_OPERATION_BUSY'); finishAccess(); await access;
    console.log('PASS export: SQLite WAL snapshot, City/Canon/Alias/POV/Review history, TXT/SHA256, write/draft gates, ZIP failure, no-clobber');

    const before = target(destination); process.env.NOVEL_COMPANY_DATA_DIR = destination;
    const damaged = path.join(temporary, 'damaged.zip'); fs.writeFileSync(damaged, Buffer.from('not a zip')); rejectPackage(damaged, destination, before);
    const noManifest = path.join(temporary, 'no-manifest.zip'); writeZip(noManifest, rawEntries.filter(entry => entry.name !== 'manifest.json')); rejectPackage(noManifest, destination, before);
    const wrongHash = path.join(temporary, 'hash.zip'); const changed = entries(zipFile); changed.find(entry => entry.name.startsWith('manuscripts/')).data = Buffer.from('changed'); writeZip(wrongHash, changed); rejectPackage(wrongHash, destination, before);
    const missingTxt = path.join(temporary, 'missing-txt.zip'); const incomplete = entries(zipFile); const omitted = incomplete.find(entry => entry.name.startsWith('manuscripts/')); const manifest = JSON.parse(incomplete[0].data); manifest.files = manifest.files.filter(item => item.relativePath !== omitted.name); incomplete[0].data = Buffer.from(JSON.stringify(manifest)); writeZip(missingTxt, incomplete.filter(entry => entry !== omitted)); rejectPackage(missingTxt, destination, before, 'BACKUP_INVALID');
    for (const [name, change] of [
      ['traversal', buffer => { const old = Buffer.from('manifest.json'), next = Buffer.from('../evil/x.txt'); for (let at = buffer.indexOf(old); at >= 0; at = buffer.indexOf(old, at + old.length)) next.copy(buffer, at); }],
      ['absolute', buffer => { const old = Buffer.from('manifest.json'), next = Buffer.from('C:/evil/x.txt'); for (let at = buffer.indexOf(old); at >= 0; at = buffer.indexOf(old, at + old.length)) next.copy(buffer, at); }],
      ['bomb-size', buffer => { const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); buffer.writeUInt32LE(LIMITS.file + 1, central + 24); }],
      ['bomb-count', buffer => { buffer.writeUInt16LE(LIMITS.files + 1, buffer.length - 12); buffer.writeUInt16LE(LIMITS.files + 1, buffer.length - 14); }],
      ['symlink', buffer => { const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); buffer.writeUInt32LE(0xa1ff0000, central + 38); }],
      ['directory-type', buffer => { const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); buffer.writeUInt32LE(0x10, central + 38); }],
      ['bomb-ratio', buffer => { const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); buffer.writeUInt16LE(8, central + 10); buffer.writeUInt32LE(1, central + 20); buffer.writeUInt32LE(1000, central + 24); }],
      ['duplicate-path', buffer => { const manuscripts = rawEntries.filter(entry => entry.name.startsWith('manuscripts/')); const old = Buffer.from(manuscripts[1].name), next = Buffer.from(manuscripts[0].name); assert.equal(old.length, next.length); for (let at = buffer.indexOf(old); at >= 0; at = buffer.indexOf(old, at + old.length)) next.copy(buffer, at); }],
      ['crc', buffer => { buffer[30 + Buffer.byteLength('manifest.json')] ^= 1; }],
    ]) { const file = path.join(temporary, name + '.zip'); attackPackage(zipFile, file, change); rejectPackage(file, destination, before); }
    const future = path.join(temporary, 'new-schema.zip'); mutateDatabasePackage(zipFile, future, temporary, db => db.prepare('INSERT INTO schema_migrations VALUES (15, ?, ?)').run('015_future.sql', new Date().toISOString())); rejectPackage(future, destination, before, 'BACKUP_SCHEMA_UNSUPPORTED');
    const invalidFk = path.join(temporary, 'fk.zip'); mutateDatabasePackage(zipFile, invalidFk, temporary, db => { db.exec('PRAGMA foreign_keys = OFF'); db.prepare('UPDATE episodes SET work_id = ?').run('missing-work'); }); rejectPackage(invalidFk, destination, before, 'BACKUP_DATABASE_INVALID');
    const older = path.join(temporary, 'older.zip'); mutateDatabasePackage(zipFile, older, temporary, db => db.exec('DELETE FROM schema_migrations WHERE version = 14')); rejectPackage(older, destination, before, 'BACKUP_SCHEMA_UNSUPPORTED');
    const wrongSchema = path.join(temporary, 'wrong-schema.zip'); mutateDatabasePackage(zipFile, wrongSchema, temporary, db => db.exec('DROP TRIGGER review_job_processor_immutable')); rejectPackage(wrongSchema, destination, before, 'BACKUP_SCHEMA_UNSUPPORTED');
    const unsafeRef = path.join(temporary, 'unsafe-ref.zip'); mutateDatabasePackage(zipFile, unsafeRef, temporary, db => db.prepare('UPDATE episodes SET storage_key = ? WHERE id = ?').run('../outside.txt', fixture.episodes[0].id)); rejectPackage(unsafeRef, destination, before, 'BACKUP_FILES_MISSING');
    const sensitive = path.join(temporary, 'sensitive.zip'); mutateDatabasePackage(zipFile, sensitive, temporary, db => db.prepare('INSERT INTO app_settings VALUES (?, ?, ?)').run('api_key', 'mock-key-only', new Date().toISOString())); rejectPackage(sensitive, destination, before, 'BACKUP_SENSITIVE_SETTINGS');
    const missingSource = path.join(destination, 'works', ...Object.keys(before.txt)[0].split('/')); fs.renameSync(missingSource, missingSource + '.hidden');
    assert.throws(() => service.exportSnapshot(destination, path.join(temporary, 'missing-source.zip'), '0.1.0'), error => error.code === 'BACKUP_FILES_MISSING'); fs.renameSync(missingSource + '.hidden', missingSource);
    fs.writeFileSync(path.join(destination, 'works', 'unregistered.txt'), '외부 원고 수집 금지'); assert.throws(() => service.exportSnapshot(destination, path.join(temporary, 'unregistered.zip'), '0.1.0'), error => error.code === 'BACKUP_FILES_MISSING'); fs.unlinkSync(path.join(destination, 'works', 'unregistered.txt'));
    console.log('PASS rejection: corrupt/missing manifest/hash/TXT, duplicate/traversal/absolute/symlink/type/CRC, size/count/ratio bombs, newer/older schema, FK, missing/unregistered managed files');

    fs.writeFileSync(path.join(destination, 'backups'), 'backup-directory-blocker');
    assert.throws(() => service.replaceData(destination, zipFile, '0.1.0')); assert.deepEqual(snapshot(), before.database); assert.deepEqual(manuscripts(destination), before.txt); fs.unlinkSync(path.join(destination, 'backups'));
    for (const stage of ['old-database', 'old-works', 'new-database', 'new-works', 'verified', 'committed']) {
      assert.throws(() => service.replaceData(destination, zipFile, '0.1.0', { hook: phase => { if (phase === stage) throw new Error('injected ' + stage); } }), error => error.code === 'RESTORE_FAILED');
      assert.deepEqual(snapshot(), before.database); assert.deepEqual(manuscripts(destination), before.txt); assert.equal(fs.existsSync(path.join(destination, service.JOURNAL)), false);
    }
    console.log('PASS rollback: automatic backup failure unchanged, all six replacement phases restore original DB/TXT');
    service.replaceData(destination, zipFile, '0.1.0'); assert.throws(() => getDatabase());
    service.recoverInterruptedRestore(destination); initializeDatabase(path.join(destination, 'novelcompany.db'));
    assert.deepEqual(snapshot(), sourceBefore); assert.deepEqual(manuscripts(destination), txtBefore); assert.equal(fs.existsSync(missingSource), false);
    assert.equal(fs.readFileSync(path.join(destination, 'machine-settings.json'), 'utf8'), '{"preserve":true}');
    const automatic = fs.readdirSync(path.join(destination, 'backups')).filter(name => name.endsWith('.zip'));
    const previous = service.validatePackage(path.join(destination, 'backups', automatic.at(-1)), path.join(temporary, 'automatic'));
    assert.equal(previous.summary.episodeCount, 1);
    console.log('PASS restore: full replacement, no leftover manuscript, different PC root, exact rows/TXT hashes, original automatic ZIP, reconnect');
    closeDatabase();

    for (const stage of ['old-database', 'old-works', 'new-database', 'new-works', 'verified', 'committed']) {
      const root = path.join(temporary, 'crash-' + stage), original = target(root); closeDatabase();
      const crash = spawnSync(process.execPath, [__filename, '--crash', root, zipFile, stage], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(crash.status, 86, crash.stderr);
      const recover = spawnSync(process.execPath, [__filename, '--recover', root], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(recover.status, 0, recover.stderr);
      const recovered = JSON.parse(recover.stdout.trim()); assert.deepEqual(recovered, stage === 'committed' ? { database: sourceBefore, txt: txtBefore } : original);
      assert.equal(fs.existsSync(path.join(root, service.JOURNAL)), false); assert.equal(service.recoverInterruptedRestore(root), false);
    }
    console.log('PASS crash recovery: six actual child-process exits, startup rollback/committed completion, idempotence');

    // 포함된 중단 Job은 앱 시작의 기존 복구 정책을 실행하고 이력/hash를 재작성하지 않는다.
    const jobsRoot = path.join(temporary, 'imported-jobs'); target(jobsRoot);
    service.replaceData(jobsRoot, zipFile, '0.1.0'); service.recoverInterruptedRestore(jobsRoot); initializeDatabase(path.join(jobsRoot, 'novelcompany.db'));
    const reopenedStorage = new LocalEpisodeStorage(jobsRoot); queue = createReviewQueue(reopenedStorage); queue.start();
    const running = await queue.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id });
    assert.throws(() => service.assertQueueIdle(queue), error => error.code === 'BACKUP_REVIEW_BUSY');
    await waitFor(() => jobs.getById(running.id).status === 'COMPLETED' && queue.isIdle()); queue.stop();
    // 실제 DB Job API로 중단 RUNNING·정상 QUEUED·과거 입력 QUEUED를 만든 후 패키지 이전을 검사한다.
    queue.stop();
    const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
    const { submissionSource } = require('../review/review-queue-service.cjs');
    const interrupted = jobs.submit({ workId: fixture.workId, episodeId: fixture.episodes[0].id, ...submissionSource(await buildEpisodeWorkContext(reopenedStorage, { workId: fixture.workId, episodeId: fixture.episodes[0].id })) });
    jobs.claimWithRun(interrupted.id, 'STUB_V1');
    const queued = jobs.submit({ workId: fixture.workId, episodeId: fixture.episodes[1].id, ...submissionSource(await buildEpisodeWorkContext(reopenedStorage, { workId: fixture.workId, episodeId: fixture.episodes[1].id })) });
    const legacyQueued = jobs.submit({ workId: fixture.workId, episodeId: fixture.episodes[2].id, episodeContentHash: 'past', canonContextHash: 'past' });
    const incomingJobsZip = path.join(temporary, 'interrupted-jobs.zip');
    service.exportSnapshot(jobsRoot, incomingJobsZip, '0.1.0'); // 운영 IPC를 우회하는 격리 fixture 제작만 허용한다.
    const historical = snapshot().review_runs.filter(run => run.status === 'COMPLETED');
    closeDatabase(); const newJobsRoot = path.join(temporary, 'recovered-jobs'); target(newJobsRoot);
    service.replaceData(newJobsRoot, incomingJobsZip, '0.1.0'); service.recoverInterruptedRestore(newJobsRoot); initializeDatabase(path.join(newJobsRoot, 'novelcompany.db'));
    const importedStorage = new LocalEpisodeStorage(newJobsRoot); queue = createReviewQueue(importedStorage); queue.start();
    await waitFor(() => jobs.getById(queued.id).status === 'COMPLETED' && jobs.getById(legacyQueued.id).status === 'RESUBMIT_REQUIRED' && queue.isIdle());
    assert.equal(jobs.getById(interrupted.id).status, 'FAILED'); assert.equal(jobs.getById(interrupted.id).errorCode, 'REVIEW_INTERRUPTED');
    assert.equal(jobs.getById(queued.id).queueSequence, queued.queueSequence);
    assert.deepEqual(snapshot().review_runs.filter(run => historical.some(old => old.id === run.id)), historical);
    queue.stop();
    console.log('PASS Review queue/episode safety: active jobs blocked; imported RUNNING interrupted, compatible QUEUED resumed, legacy QUEUED resubmit, immutable history/FIFO');
    closeDatabase();
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const ui = spawnSync(require('electron'), [path.join(__dirname, 'data-backup-ui-validation.cjs')], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    process.stdout.write(ui.stdout ?? ''); process.stderr.write(ui.stderr ?? ''); assert.equal(ui.status, 0, 'sandbox Settings UI validation');
    const uiReport = JSON.parse(ui.stdout.trim().split(/\r?\n/).at(-1));
    const restartedUi = spawnSync(require('electron'), [path.join(__dirname, 'data-backup-ui-validation.cjs'), '--restart', uiReport.temporaryRoot], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    process.stdout.write(restartedUi.stdout ?? ''); process.stderr.write(restartedUi.stderr ?? ''); assert.equal(restartedUi.status, 0, 'sandbox new-process reconnect');
    assert.ok(path.resolve(uiReport.temporaryRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(uiReport.temporaryRoot).startsWith('novelcompany-backup-ui-'));
    fs.rmSync(uiReport.temporaryRoot, { recursive: true, force: true });
    console.log('PASS Task030-HF02: isolated temporary DB/storage/profile only');
  } finally { queue?.stop(); closeDatabase(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (!childMode()) validate().catch(error => { console.error(error); process.exitCode = 1; });
