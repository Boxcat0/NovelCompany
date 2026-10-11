const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations, readMigrationFiles } = require('../database/migrate.cjs');
const { getDatabase, closeDatabase, initializeDatabase } = require('../database/database.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { logIpcError } = require('../logging/logger.cjs');
const gate = require('./data-operation-gate.cjs');
const { LIMITS, safeEntry, openZip, writeZip } = require('./backup-zip.cjs');
const baselineStore = require('./transfer-baseline.cjs');
const FORMAT = 'NOVELCOMPANY_BACKUP_V1';
const DB_ENTRY = 'database/novelcompany.db';
const JOURNAL = '.restore-journal.json';
const migrations = path.join(__dirname, '../database/migrations');
const expectedSchemas = new Map();

/** 파일 내용의 SHA256을 계산한다. */
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
/** 복구 가능한 백업 오류를 한국어로 발생시킨다. */
function fail(code, message) { throw new RepositoryError(code, message); }
/** 링크·junction 및 예상 밖 파일 종류를 관리 경로의 모든 구성요소에서 거부한다. */
function assertPlainPath(target, directory = false) {
  let current = path.parse(path.resolve(target)).root;
  const parts = path.resolve(target).slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) fail('BACKUP_UNSAFE_PATH', '관리 데이터 경로에 링크 또는 예상 밖 파일이 있습니다. 데이터 위치를 확인해 주세요.');
  }
}
/** 공식 Migration으로 만든 버전별 SQL 객체를 비교 가능한 형태로 읽는다. */
function schemaDefinition(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(row => ({ ...row }));
}
/** 읽기 전용 DB가 기록한 버전의 공식 Schema·무결성·FK·이동 가능한 파일 참조를 확인한다. */
function inspectDatabase(file) {
  assertPlainPath(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const migrationFiles = readMigrationFiles(migrations);
    let versions;
    try { versions = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all(); }
    catch { fail('BACKUP_SCHEMA_INVALID', 'DB에 정식 Schema 버전 기록이 없습니다.'); }
    const latest = versions.at(-1)?.version ?? 0;
    if (latest > migrationFiles.length) fail('BACKUP_SCHEMA_FUTURE', '현재 프로그램보다 새로운 SQLite Schema입니다. 프로그램을 업데이트해 주세요.');
    if (!versions.length || versions.some((row, index) => row.version !== index + 1 || row.name !== migrationFiles[index]?.name)) fail('BACKUP_SCHEMA_UNSUPPORTED', '정식 Migration 기록이 일치하지 않아 이 DB를 복원할 수 없습니다.');
    if (!expectedSchemas.has(latest)) {
      const memory = new DatabaseSync(':memory:');
      try { memory.exec('PRAGMA foreign_keys = ON'); runMigrations(memory, migrations, latest); expectedSchemas.set(latest, schemaDefinition(memory)); } finally { memory.close(); }
    }
    const actual = schemaDefinition(db), expected = expectedSchemas.get(latest);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const actualByName = new Map(actual.map(row => [row.type + ':' + row.name, row]));
      const expectedByName = new Map(expected.map(row => [row.type + ':' + row.name, row]));
      const missing = expected.filter(row => !actualByName.has(row.type + ':' + row.name)).map(row => row.name);
      const changed = expected.filter(row => actualByName.has(row.type + ':' + row.name) && JSON.stringify(actualByName.get(row.type + ':' + row.name)) !== JSON.stringify(row)).map(row => row.name);
      const extra = actual.filter(row => !expectedByName.has(row.type + ':' + row.name)).map(row => row.name);
      fail('BACKUP_SCHEMA_INVALID', `DB 구조가 정식 Schema ${latest}과 다릅니다. 누락: ${missing.join(', ') || '없음'}; 변경: ${changed.join(', ') || '없음'}; 추가: ${extra.join(', ') || '없음'}.`);
    }
    if (db.prepare('PRAGMA integrity_check').all().some(row => row.integrity_check !== 'ok')) fail('BACKUP_DATABASE_INVALID', '백업 SQLite 무결성 검사에 실패했습니다.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('BACKUP_DATABASE_INVALID', '백업 DB에 잘못된 참조가 있습니다.');
    // 현재 앱에는 인증/기기 설정 저장 기능이 없다. 향후 민감 설정을 DB에 도입하면 별도 이전 정책이 필요하다.
    if (db.prepare('SELECT key FROM app_settings').all().some(row => /api.?key|token|secret|credential|auth|machine|data.?root/i.test(row.key))) fail('BACKUP_SENSITIVE_SETTINGS', 'DB에 인증 또는 기기 전용 설정이 있어 이 백업 형식으로 내보내거나 복원할 수 없습니다.');
    const episodes = db.prepare('SELECT id, work_id, episode_number, storage_key, content_hash FROM episodes ORDER BY storage_key').all();
    const storage = new LocalEpisodeStorage(path.dirname(file));
    const seen = new Set();
    const missing = [];
    for (const row of episodes) {
      try {
        const expected = storage.getStorageKey(row.work_id, row.episode_number);
        safeEntry('manuscripts/' + row.storage_key);
        if (row.storage_key !== expected || seen.has(row.storage_key.toLowerCase())) throw new Error('scope');
        seen.add(row.storage_key.toLowerCase());
      } catch { missing.push(row.id); }
    }
    if (missing.length) fail('BACKUP_FILES_MISSING', '허용된 관리 경로 밖의 원고 참조가 있습니다. 회차 ID: ' + missing.join(', '));
    return { databaseSchemaVersion: latest, workCount: db.prepare('SELECT COUNT(*) AS count FROM works').get().count, episodeCount: episodes.length, episodes };
  } finally { db.close(); }
}
/** Manifest의 정확한 목록·크기·SHA256과 DB/TXT 참조를 검증한 뒤에만 격리 파일을 만든다. */
function validatePackage(file, destination) {
  let zip;
  try {
    zip = openZip(file);
    const manifest = JSON.parse(zip.read('manifest.json').toString('utf8'));
    if (manifest.formatVersion !== FORMAT) fail('BACKUP_FORMAT_UNSUPPORTED', '현재 프로그램이 지원하지 않는 백업 형식입니다.');
    if (!Number.isFinite(Date.parse(manifest.createdAt)) || typeof manifest.applicationVersion !== 'string' || manifest.applicationVersion.length > 100 || !Array.isArray(manifest.files) || manifest.files.length !== zip.entries.size - 1) fail('BACKUP_INVALID', '손상된 백업 Manifest입니다.');
    if (manifest.syncBaseline !== undefined) baselineStore.validateBaseline(manifest.syncBaseline);
    const names = new Set();
    for (const item of manifest.files) {
      if (!item || typeof item.relativePath !== 'string') fail('BACKUP_INVALID', '백업 파일 목록이 올바르지 않습니다.');
      safeEntry(item.relativePath);
      if (item.relativePath === 'manifest.json' || names.has(item.relativePath.toLowerCase()) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256) || zip.entries.get(item.relativePath)?.size !== item.size) fail('BACKUP_INVALID', '백업 파일 목록·크기 또는 해시가 올바르지 않습니다.');
      names.add(item.relativePath.toLowerCase());
      if (sha256(zip.read(item.relativePath)) !== item.sha256) fail('BACKUP_HASH_MISMATCH', '백업 파일의 SHA256이 일치하지 않습니다.');
    }
    if (!names.has(DB_ENTRY)) fail('BACKUP_INVALID', '백업에 필수 DB 파일이 없습니다.');
    assertPlainPath(destination, true);
    fs.mkdirSync(destination, { recursive: true });
    for (const item of manifest.files) {
      const target = path.join(destination, ...item.relativePath.split('/'));
      assertPlainPath(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, 'wx');
      try { fs.writeFileSync(fd, zip.read(item.relativePath)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const databaseFile = path.join(destination, DB_ENTRY);
    const source = inspectDatabase(databaseFile);
    if (source.databaseSchemaVersion !== manifest.databaseSchemaVersion || manifest.files.length !== source.episodes.length + 1) fail('BACKUP_INVALID', 'DB와 Manifest 또는 원고 목록이 일치하지 않습니다.');
    for (const episode of source.episodes) {
      const item = manifest.files.find(item => item.relativePath === 'manuscripts/' + episode.storage_key);
      if (!item) fail('BACKUP_FILES_MISSING', '백업에 등록된 회차 원고가 없습니다. 회차 ID: ' + episode.id);
      if (episode.content_hash !== null && episode.content_hash !== item.sha256) fail('BACKUP_HASH_MISMATCH', 'DB의 원고 해시와 실제 TXT가 일치하지 않습니다. 회차 ID: ' + episode.id);
    }
    // 원본 ZIP은 건드리지 않고, 이미 해시를 검증한 격리 복사본에만 정식 Migration을 적용한다.
    if (source.databaseSchemaVersion < readMigrationFiles(migrations).length) {
      const writable = new DatabaseSync(databaseFile);
      try {
        writable.exec('PRAGMA foreign_keys = ON');
        runMigrations(writable, migrations);
      } catch {
        fail('BACKUP_MIGRATION_UNSUPPORTED', '구형 DB를 정식 Migration으로 변환하지 못했습니다. 원본 ZIP은 변경되지 않았습니다.');
      } finally { writable.close(); }
    }
    const summary = source.databaseSchemaVersion === readMigrationFiles(migrations).length ? source : inspectDatabase(databaseFile);
    const stat = fs.statSync(databaseFile);
    const installFiles = manifest.files.map(item => item.relativePath === DB_ENTRY
      ? { relativePath: DB_ENTRY, size: stat.size, sha256: sha256(fs.readFileSync(databaseFile)) }
      : item);
    return { manifest, summary, sourceSchemaVersion: source.databaseSchemaVersion, installFiles };
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    fail('BACKUP_INVALID', '백업 파일을 검증하지 못했습니다. ZIP과 Manifest를 확인해 주세요.');
  } finally { zip?.close(); }
}
/** 등록되지 않은 작품 파일을 임의 수집하거나 교체로 삭제하지 않도록 누락 목록을 보고한다. */
function assertManagedFiles(root, episodes) {
  assertPlainPath(root, true);
  const expected = new Set(episodes.map(row => row.storage_key.toLowerCase()));
  const unexpected = [], missing = [];
  const storage = new LocalEpisodeStorage(root);
  for (const episode of episodes) {
    try {
      const target = storage.resolveManagedPath(episode.work_id, episode.storage_key);
      if (!fs.existsSync(target)) missing.push(episode.id);
    } catch { missing.push(episode.id); }
  }
  /** 관리 작품 폴더만 확인하고 외부 폴더나 링크를 따라가지 않는다. */
  function walk(directory, prefix = '') {
    if (!fs.existsSync(directory)) return;
    assertPlainPath(directory, true);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) unexpected.push(relative);
      else if (entry.isDirectory()) walk(target, relative + '/');
      else if (!entry.isFile() || !expected.has(relative.toLowerCase())) unexpected.push(relative);
    }
  }
  walk(path.join(root, 'works'));
  if (missing.length || unexpected.length) fail('BACKUP_FILES_MISSING', '백업 범위를 확인해 주세요. 누락 회차 ID: ' + (missing.join(', ') || '없음') + '; 미등록 관리 파일: ' + (unexpected.join(', ') || '없음') + '. 외부 파일은 수집하지 않았습니다.');
}
/** 스냅샷과 모든 TXT를 고정한 뒤 검증된 ZIP을 no-clobber 방식으로 게시한다. */
function exportSnapshot(root, output, applicationVersion, hook = () => {}, options = {}) {
  assertPlainPath(root, true);
  assertPlainPath(output);
  const relativeOutput = path.relative(root, output);
  if (path.extname(output).toLowerCase() !== '.zip' || (!relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput) && /^(works|\.restore[^\\/]*|\.backup[^\\/]*)(?:[\\/]|$)/i.test(relativeOutput))) fail('BACKUP_OUTPUT_INVALID', '백업은 원고·복구 작업 폴더 밖의 ZIP 파일로 저장해 주세요.');
  if (fs.existsSync(output)) fail('BACKUP_ALREADY_EXISTS', '같은 이름의 파일이 이미 있습니다. 기존 백업을 보호하려면 다른 이름으로 저장해 주세요.');
  const temporary = fs.mkdtempSync(path.join(root, '.backup-'));
  const partial = output + '.' + randomUUID() + '.partial';
  let published = false;
  try {
    gate.setPhase('SQLite 스냅샷 생성 중');
    const snapshot = path.join(temporary, 'database/novelcompany.db');
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    getDatabase().prepare('PRAGMA journal_mode').get(); // WAL을 포함한 어떤 모드에서도 VACUUM INTO 결과는 독립 DB다.
    getDatabase().exec("VACUUM INTO '" + snapshot.replace(/'/g, "''") + "'");
    hook('snapshot');
    const summary = inspectDatabase(snapshot);
    assertManagedFiles(root, summary.episodes);
    gate.setPhase('원고 복사 및 SHA256 확인 중');
    if (fs.statSync(snapshot).size > LIMITS.file) fail('BACKUP_LIMIT_EXCEEDED', 'SQLite 파일이 백업 크기 제한을 초과했습니다.');
    const files = [{ relativePath: DB_ENTRY, size: fs.statSync(snapshot).size, sha256: sha256(fs.readFileSync(snapshot)) }];
    const storage = new LocalEpisodeStorage(root);
    for (const episode of summary.episodes) {
      const source = storage.resolveManagedPath(episode.work_id, episode.storage_key);
      if (fs.statSync(source).size > LIMITS.file) fail('BACKUP_LIMIT_EXCEEDED', '백업 파일 크기 제한을 초과했습니다.');
      const relativePath = 'manuscripts/' + episode.storage_key, target = path.join(temporary, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      files.push({ relativePath, size: fs.statSync(target).size, sha256: sha256(fs.readFileSync(target)) });
    }
    const existingBaseline = baselineStore.readBaseline(root);
    const syncBaseline = existingBaseline ?? baselineStore.makeBaseline(baselineStore.collect(snapshot, path.join(temporary, 'manuscripts')));
    const manifest = { formatVersion: FORMAT, createdAt: new Date().toISOString(), applicationVersion, databaseSchemaVersion: summary.databaseSchemaVersion, files, syncBaseline };
    gate.setPhase('ZIP 작성 및 최종 검증 중'); hook('zip');
    writeZip(partial, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...files.map(item => ({ name: item.relativePath, path: path.join(temporary, ...item.relativePath.split('/')) }))], hook);
    validatePackage(partial, path.join(temporary, 'verify'));
    fs.linkSync(partial, output); // 최종 게시 순간에도 기존 파일을 덮어쓰지 않는다.
    published = true;
    // 최초 내보내기에서 공유 조상 ID를 기록한다. DB/TXT는 변경하지 않는다.
    if (!existingBaseline && options.persistBaseline !== false) {
      try { baselineStore.publishBaseline(root, syncBaseline); }
      catch (cause) { logIpcError({ channel: 'backup:export', code: 'UPDATE_BASELINE_WRITE_FAILED', message: '백업은 저장했으나 변경사항 업데이트 기준본을 기록하지 못했습니다.', cause }); }
    }
    return { createdAt: manifest.createdAt, databaseSchemaVersion: summary.databaseSchemaVersion, workCount: summary.workCount, episodeCount: summary.episodeCount };
  } finally {
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial);
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      if (!published) throw cause;
      logIpcError({ channel: 'backup:export', code: 'BACKUP_CLEANUP_FAILED', message: '검증한 백업은 저장했으나 임시 파일 정리를 완료하지 못했습니다.', cause });
    }
  }
}
/** 복원 의도를 fsync 후 원자 게시하여 각 rename 전의 상태를 영속 기록한다. */
function writeJournal(root, journal) {
  const target = path.join(root, JOURNAL), temporary = target + '.tmp';
  assertPlainPath(target); assertPlainPath(temporary);
  const fd = fs.openSync(temporary, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
}
/** 영속 journal과 실제 rename 결과로 원본 DB/works를 복구하며 재실행에도 안전하다. */
function recoverInterruptedRestore(root) {
  assertPlainPath(root, true);
  const journalPath = path.join(root, JOURNAL);
  if (!fs.existsSync(journalPath)) return false;
  assertPlainPath(journalPath);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (journal.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id) || !['PREPARED', 'REPLACING', 'COMMITTED'].includes(journal.phase) || typeof journal.hadDatabase !== 'boolean' || typeof journal.hadWorks !== 'boolean') fail('RESTORE_RECOVERY_FAILED', '복원 상태 파일을 확인하지 못했습니다. 원본 복구 파일을 보존한 채 시작을 중단합니다.');
  const operation = path.join(root, '.restore-' + journal.id);
  assertPlainPath(operation, true);
  const db = path.join(root, 'novelcompany.db'), works = path.join(root, 'works');
  if (journal.phase === 'COMMITTED') {
    // 성공 표시 이후에도 새 DB/TXT를 검증하지 못하면 보존된 원본으로 되돌린다.
    try {
      const summary = inspectDatabase(db); assertManagedFiles(root, summary.episodes); verifyInstalled(root, journal.files);
      if (journal.hadBaseline !== undefined && JSON.stringify(baselineStore.readBaseline(root)) !== JSON.stringify(journal.syncBaseline ?? null)) throw new Error('baseline');
    }
    catch { journal.phase = 'REPLACING'; }
  }
  if (journal.phase !== 'COMMITTED') {
    for (const [name, target, existed] of [['database', db, journal.hadDatabase], ['works', works, journal.hadWorks]]) {
      const old = path.join(operation, 'old-' + name);
      assertPlainPath(target, name === 'works'); assertPlainPath(old, name === 'works');
      if (fs.existsSync(old) || !existed) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: name === 'works', force: true });
        if (fs.existsSync(old)) fs.renameSync(old, target);
      } else if (!fs.existsSync(target)) fail('RESTORE_RECOVERY_FAILED', '원본 또는 복구 파일을 찾을 수 없습니다. 복구 파일을 보존하고 시작을 중단합니다.');
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const old = path.join(operation, 'old-database' + suffix), target = db + suffix;
      assertPlainPath(old); assertPlainPath(target);
      // 교체 시작 전 이동하지 않은 원본 sidecar는 그대로 유지한다.
      if (fs.existsSync(old)) { if (fs.existsSync(target)) fs.unlinkSync(target); fs.renameSync(old, target); }
    }
    if (journal.hadBaseline !== undefined) {
      const target = path.join(root, baselineStore.NAME), old = path.join(operation, 'old-baseline');
      assertPlainPath(target); assertPlainPath(old);
      if (fs.existsSync(old) || !journal.hadBaseline) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(old)) fs.renameSync(old, target);
      } else if (!fs.existsSync(target)) fail('RESTORE_RECOVERY_FAILED', '기존 공통 기준본을 복구할 수 없습니다.');
    }
  }
  fs.unlinkSync(journalPath);
  fs.rmSync(operation, { recursive: true, force: true });
  return true;
}
/** 설치된 DB/TXT를 Manifest 해시와 비교하고 현재 원고 범위를 재검증한다. */
function verifyInstalled(root, files) {
  if (!Array.isArray(files)) fail('RESTORE_RECOVERY_FAILED', '복원 파일 목록을 확인하지 못했습니다.');
  for (const item of files) {
    safeEntry(item.relativePath);
    const target = item.relativePath === DB_ENTRY ? path.join(root, 'novelcompany.db') : path.join(root, 'works', ...item.relativePath.slice('manuscripts/'.length).split('/'));
    assertPlainPath(target);
    if (fs.statSync(target).size !== item.size || sha256(fs.readFileSync(target)) !== item.sha256) fail('RESTORE_VERIFY_FAILED', '교체한 데이터의 검증에 실패했습니다. 기존 데이터를 복구합니다.');
  }
}
/** 현재 데이터 자동 백업 후 닫힌 DB와 원고 폴더를 journal로 보호하며 전체 교체한다. */
function replaceData(root, packageFile, applicationVersion, options = {}) {
  const id = randomUUID(), operation = path.join(root, '.restore-' + id);
  fs.mkdirSync(operation);
  let journalStarted = false, closed = false;
  const hook = options.hook ?? (() => {});
  try {
    gate.setPhase('가져올 백업 다시 검증 중');
    const prepared = path.join(operation, 'package'), validated = validatePackage(packageFile, prepared);
    const backupDirectory = path.join(root, 'backups'); assertPlainPath(backupDirectory, true); fs.mkdirSync(backupDirectory, { recursive: true });
    gate.setPhase('현재 데이터 자동 백업 중'); hook('automatic-backup');
    const backupFile = path.join(backupDirectory, 'before-restore-' + id + '.zip');
    try { exportSnapshot(root, backupFile, applicationVersion, hook, { persistBaseline: false }); }
    catch (cause) { throw new RepositoryError('BACKUP_AUTOMATIC_FAILED', '현재 데이터 자동 백업에 실패하여 가져오기를 시작하지 않았습니다.', cause); }
    gate.setPhase('기존 연결 종료 및 전체 데이터 교체 중');
    options.stopWorker?.(); closeDatabase(); closed = true;
    const database = path.join(root, 'novelcompany.db'), works = path.join(root, 'works');
    const baselineFile = path.join(root, baselineStore.NAME);
    const journal = { version: 1, id, phase: 'PREPARED', hadDatabase: fs.existsSync(database), hadWorks: fs.existsSync(works), hadBaseline: fs.existsSync(baselineFile), syncBaseline: validated.manifest.syncBaseline ?? null, files: validated.installFiles };
    writeJournal(root, journal); journalStarted = true;
    journal.phase = 'REPLACING'; writeJournal(root, journal);
    // 닫힌 연결의 DB와 sidecar를 함께 보존하되 ZIP에는 유효 snapshot만 포함한다.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const source = database + suffix; assertPlainPath(source);
      if (fs.existsSync(source)) fs.renameSync(source, path.join(operation, 'old-database' + suffix));
      hook('old-database' + suffix);
    }
    if (fs.existsSync(works)) fs.renameSync(works, path.join(operation, 'old-works'));
    hook('old-works');
    if (journal.hadBaseline) fs.renameSync(baselineFile, path.join(operation, 'old-baseline'));
    fs.renameSync(path.join(prepared, DB_ENTRY), database); hook('new-database');
    const nextWorks = path.join(prepared, 'manuscripts'); fs.mkdirSync(nextWorks, { recursive: true }); fs.renameSync(nextWorks, works); hook('new-works');
    if (journal.syncBaseline) baselineStore.publishBaseline(root, journal.syncBaseline);
    gate.setPhase('교체한 DB와 원고 최종 검증 중');
    verifyInstalled(root, journal.files);
    const summary = inspectDatabase(database); assertManagedFiles(root, summary.episodes); hook('verified');
    journal.phase = 'COMMITTED'; writeJournal(root, journal); hook('committed');
    // COMMITTED journal은 다음 앱 시작에서 재검증·정리한다. 원본 사본과 자동 ZIP 모두 보존한다.
    return { ...publicSummary(validated), automaticBackup: path.basename(backupFile), restartRequired: true };
  } catch (error) {
    if (journalStarted) {
      try {
        // 일반 실행 중 오류는 COMMITTED 직후여도 원본으로 되돌린다.
        const journal = JSON.parse(fs.readFileSync(path.join(root, JOURNAL), 'utf8')); journal.phase = 'REPLACING'; writeJournal(root, journal);
        recoverInterruptedRestore(root);
      } catch { fail('RESTORE_RECOVERY_FAILED', '원본 복구를 완료하지 못했습니다. 복구 파일을 보존했고 앱을 다시 시작해야 합니다.'); }
    } else fs.rmSync(operation, { recursive: true, force: true });
    if (closed) {
      try { initializeDatabase(path.join(root, 'novelcompany.db')); options.restartWorker?.(); }
      catch { fail('RESTORE_RECOVERY_FAILED', '기존 파일은 복구했으나 연결을 다시 열지 못했습니다. 원본과 백업을 보존하고 앱을 종료합니다.'); }
    }
    if (error instanceof RepositoryError) throw error;
    fail('RESTORE_FAILED', '복원에 실패했습니다. 기존 데이터를 유지하거나 원본으로 복구했습니다.');
  }
}
/** PC 절대 경로나 내부 Episode 행을 제외한 가져오기 요약을 만든다. */
function publicSummary(validated) {
  return { createdAt: validated.manifest.createdAt, applicationVersion: validated.manifest.applicationVersion, sourceSchemaVersion: validated.sourceSchemaVersion, databaseSchemaVersion: validated.summary.databaseSchemaVersion, workCount: validated.summary.workCount, episodeCount: validated.summary.episodeCount };
}
/** 활성 ReviewJob과 실제 Worker drain을 확인하여 임의 취소 없이 안전한 상태만 허용한다. */
function assertQueueIdle(queue) {
  if (getDatabase().prepare("SELECT 1 FROM review_jobs WHERE status IN ('QUEUED', 'RUNNING') LIMIT 1").get() || (queue && !queue.isIdle())) fail('BACKUP_REVIEW_BUSY', '대기 또는 실행 중인 검토가 있습니다. 검토가 끝난 뒤 백업·복원해 주세요.');
}
module.exports = { FORMAT, DB_ENTRY, JOURNAL, sha256, inspectDatabase, validatePackage, publicSummary, exportSnapshot, replaceData, recoverInterruptedRestore, assertQueueIdle, verifyInstalled };
