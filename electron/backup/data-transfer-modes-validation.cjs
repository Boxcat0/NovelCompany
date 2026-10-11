const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-transfer-modes-'));
process.env.NOVEL_COMPANY_DATA_DIR = temporary;
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');
const { runMigrations } = require('../database/migrate.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createEpisodeWithContent, updateEpisodeWithContent } = require('../episode-service.cjs');
const { createReviewQueue } = require('../review/review-queue-service.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const { createCanonFixture, inputFor } = require('../database/canon-record-validation.cjs');
const service = require('./data-backup-service.cjs');
const updater = require('./data-update-service.cjs');
const baselineStore = require('./transfer-baseline.cjs');
const { writeZip } = require('./backup-zip.cjs');

/** 실제 운영 경로와 무관한 공식 013 DB·원고 ZIP을 생성한다. */
function oldPackage(output) {
  const root = path.join(temporary, 'old-fixture'); fs.mkdirSync(root);
  const file = path.join(root, 'novelcompany.db'), db = new DatabaseSync(file);
  const now = new Date().toISOString(), workId = 'old-work', episodeId = 'old-episode', content = '구형 원고\r\n';
  const storageKey = new LocalEpisodeStorage(root).getStorageKey(workId, 1);
  try {
    db.exec('PRAGMA foreign_keys = ON'); runMigrations(db, path.join(__dirname, '../database/migrations'), 13);
    db.prepare('INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)').run(workId, '구형 작품', null, 'ACTIVE', now, now);
    db.prepare('INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(episodeId, workId, 1, '구형 회차', 'DRAFT', storageKey, service.sha256(Buffer.from(content)), now, now);
  } finally { db.close(); }
  const txt = path.join(root, 'manuscripts', ...storageKey.split('/')); fs.mkdirSync(path.dirname(txt), { recursive: true }); fs.writeFileSync(txt, content);
  const files = [{ relativePath: service.DB_ENTRY, size: fs.statSync(file).size, sha256: service.sha256(fs.readFileSync(file)) }, { relativePath: 'manuscripts/' + storageKey, size: fs.statSync(txt).size, sha256: service.sha256(fs.readFileSync(txt)) }];
  const manifest = { formatVersion: service.FORMAT, createdAt: now, applicationVersion: '0.1.0', databaseSchemaVersion: 13, files };
  writeZip(output, [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: service.DB_ENTRY, path: file }, { name: files[1].relativePath, path: txt }]);
}

/** ZIP을 별도 추출하고 서비스의 버전·해시·원고 검증을 수행한다. */
function validated(file, directory) { return service.validatePackage(file, directory); }

/** 두 PC가 같은 기준본에서 갈라진 뒤 서로 다른 Record와 Episode를 수정하는 실제 병합을 검사한다. */
async function mergeFixture() {
  const source = path.join(temporary, 'source'), target = path.join(temporary, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  initializeDatabase(path.join(source, 'novelcompany.db'));
  const scope = createCanonFixture(), workId = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(scope.world.canonSpaceId).work_id;
  const first = records.create(scope.world, { displayName: '세계 A', fieldValues: {} });
  const second = records.create(scope.world, { displayName: '세계 B', fieldValues: {} });
  const location = records.create(scope.location, inputFor(scope.location, '기준 지역', { world: first.id }));
  const deletableLocation = records.create(scope.location, inputFor(scope.location, '독립 지역', { world: second.id }));
  const attribute = records.create(scope.attribute, { displayName: '기준 속성', fieldValues: {} });
  const passiveOption = getDatabase().prepare("SELECT o.id FROM canon_field_options o JOIN canon_fields f ON f.id = o.field_id WHERE f.canon_set_id = ? AND f.key = 'passive_type' AND o.value = 'COMMON'").get(scope.passive.setId).id;
  const passive = records.create(scope.passive, inputFor(scope.passive, '기준 패시브', { passive_type: passiveOption }));
  const storage = new LocalEpisodeStorage(source);
  const episodeA = createEpisodeWithContent(storage, { workId, episodeNumber: 1, title: '1화', content: '기준 원고 A' });
  const episodeB = createEpisodeWithContent(storage, { workId, episodeNumber: 2, title: '2화', content: '기준 원고 B' });
  const episodeC = createEpisodeWithContent(storage, { workId, episodeNumber: 3, title: '3화', content: '기준 원고 C' });
  const firstZip = path.join(temporary, 'first.zip'); service.exportSnapshot(source, firstZip, '0.1.0');
  assert.ok(fs.existsSync(path.join(source, '.transfer-baseline.json')));
  closeDatabase(); initializeDatabase(path.join(target, 'novelcompany.db'));
  service.replaceData(target, firstZip, '0.1.0'); service.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.ok(fs.existsSync(path.join(target, '.transfer-baseline.json')));
  closeDatabase(); initializeDatabase(path.join(source, 'novelcompany.db'));
  records.update(scope.world, first.id, { displayName: '세계 A 수정', fieldValues: {} });
  const added = records.create(scope.world, { displayName: '세계 C 신규', fieldValues: {} });
  const character = records.create(scope.character, inputFor(scope.character, '새 인물', { origin_world: first.id, origin_location: location.id, attributes: [attribute.id], passives: [passive.id] }));
  require('../database/repositories/canon-alias-repository.cjs').create({ workId, recordId: character.id }, '새 인물 별칭');
  updateEpisodeWithContent(storage, episodeA.id, { workId, episodeNumber: 1, title: '1화', content: '다른 PC의 A 원고' });
  const addedEpisode = createEpisodeWithContent(storage, { workId, episodeNumber: 4, title: '4화 신규', content: '새 회차 원고' });
  const { parseSceneLayout } = require('../context/review-context-builder.cjs');
  const { SCENE_LAYOUT_VERSION, sceneIdentity } = require('../context/scene-narration.cjs');
  const sceneText = '기준 원고 C', now = new Date().toISOString();
  getDatabase().prepare('INSERT INTO scene_narration_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), episodeC.id, service.sha256(Buffer.from(sceneText)), SCENE_LAYOUT_VERSION, sceneIdentity(parseSceneLayout(sceneText)[0], sceneText), 'EXTERNAL_THIRD_PERSON', null, 0, now, now);
  const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
  const { submissionSource } = require('../review/review-queue-service.cjs');
  const remoteJob = require('../database/repositories/review-job-repository.cjs').submit({ workId, episodeId: episodeC.id, ...submissionSource(await buildEpisodeWorkContext(storage, { workId, episodeId: episodeC.id })) });
  assert.equal(remoteJob.status, 'QUEUED');
  const changedZip = path.join(temporary, 'changed.zip'); service.exportSnapshot(source, changedZip, '0.1.0');
  closeDatabase(); initializeDatabase(path.join(target, 'novelcompany.db'));
  records.update(scope.world, second.id, { displayName: '세계 B 로컬 수정', fieldValues: {} });
  const targetStorage = new LocalEpisodeStorage(target);
  updateEpisodeWithContent(targetStorage, episodeB.id, { workId, episodeNumber: 2, title: '2화', content: '현재 PC의 B 원고' });
  const queue = createReviewQueue(targetStorage); queue.start();
  const job = await queue.submit({ workId, episodeId: episodeB.id });
  const jobs = require('../database/repositories/review-job-repository.cjs');
  for (let attempt = 0; attempt < 500 && jobs.getById(job.id).status !== 'COMPLETED'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(jobs.getById(job.id).status, 'COMPLETED'); queue.stop();
  const localRuns = getDatabase().prepare('SELECT * FROM review_runs ORDER BY id').all().map(row => ({ ...row }));
  const localJobs = getDatabase().prepare('SELECT * FROM review_jobs ORDER BY id').all().map(row => ({ ...row }));
  const incomingPath = path.join(temporary, 'incoming'), incoming = validated(changedZip, incomingPath);
  const plan = updater.previewUpdate(target, incomingPath, incoming, path.join(temporary, 'merge-one'), '0.1.0');
  assert.equal(plan.commonBaseline, true); assert.equal(plan.conflicts.length, 0); assert.equal(plan.apply.length, 6);
  assert.ok(plan.mergedZip); updater.assertUnchanged(target, plan.fingerprint);
  getDatabase().prepare('UPDATE works SET description = ? WHERE id = ?').run('미리보기 이후 변경', workId);
  assert.throws(() => updater.assertUnchanged(target, plan.fingerprint), error => error.code === 'UPDATE_STALE_PREVIEW');
  const refreshed = updater.previewUpdate(target, incomingPath, incoming, path.join(temporary, 'merge-two'), '0.1.0');
  assert.equal(refreshed.conflicts.length, 0); assert.ok(refreshed.mergedZip);
  const beforeFailure = baselineStore.databaseFingerprint(path.join(target, 'novelcompany.db'), path.join(target, 'works'));
  const baselineBefore = fs.readFileSync(path.join(target, '.transfer-baseline.json'), 'utf8');
  assert.throws(() => service.replaceData(target, refreshed.mergedZip, '0.1.0', { hook: phase => { if (phase === 'new-database') throw new Error('injected update failure'); } }), error => error.code === 'RESTORE_FAILED');
  assert.equal(baselineStore.databaseFingerprint(path.join(target, 'novelcompany.db'), path.join(target, 'works')), beforeFailure);
  assert.equal(fs.readFileSync(path.join(target, '.transfer-baseline.json'), 'utf8'), baselineBefore);
  const handlers = new Map();
  const ipcMain = {
    /** 실제 등록된 IPC handler를 같은 인자로 실행할 수 있게 수집한다. */
    handle(name, handler) { handlers.set(name, handler); },
    /** 편집 상태 event는 이 서비스 검증에서 사용하지 않는다. */
    on() {},
  };
  let approved = false, restarted = false;
  const sender = { id: 41, isDestroyed: () => false, send: () => {} };
  require('../ipc/backup-handlers.cjs').registerBackupHandlers(ipcMain, {
    dataRoot: target, applicationVersion: '0.1.0', queue,
    dialog: {
      /** 실제 변경 ZIP을 Main의 파일 선택 경계에 제공한다. */
      async showOpenDialog() { return { canceled: false, filePaths: [changedZip] }; },
      /** 업데이트 내용 확인 뒤 실제 적용을 승인한다. */
      async showMessageBox() { approved = true; return { response: 1 }; },
    },
    /** 복원 성공에서만 재시작 요청을 기록한다. */
    onRestored() { restarted = true; },
    /** 복구 불능은 테스트 실패로 처리한다. */
    onFatal() { assert.fail('unexpected fatal restore'); },
  });
  const preview = await handlers.get('backup:preview')({ sender }, 'update');
  assert.equal(preview.ok, true); assert.equal(preview.data.mode, 'update'); assert.equal(preview.data.conflictCount, 0);
  const imported = await handlers.get('backup:import')({ sender }, preview.data.token);
  assert.equal(imported.ok, true); assert.equal(imported.data.restartRequired, true); assert.equal(approved, true); assert.equal(restarted, true);
  service.recoverInterruptedRestore(target); initializeDatabase(path.join(target, 'novelcompany.db'));
  assert.equal(fs.readFileSync(path.join(target, '.transfer-baseline.json'), 'utf8'), baselineBefore);
  assert.equal(records.getById(scope.world, first.id).displayName, '세계 A 수정');
  assert.equal(records.getById(scope.world, second.id).displayName, '세계 B 로컬 수정');
  assert.equal(records.getById(scope.world, added.id).displayName, '세계 C 신규');
  assert.equal(records.getById(scope.character, character.id).displayName, '새 인물');
  assert.equal(getDatabase().prepare('SELECT alias_text FROM canon_record_aliases WHERE canon_record_id = ?').get(character.id).alias_text, '새 인물 별칭');
  assert.equal(getDatabase().prepare('SELECT description FROM works WHERE id = ?').get(workId).description, '미리보기 이후 변경');
  assert.equal(fs.readFileSync(path.join(target, 'works', ...getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(episodeA.id).storage_key.split('/')), 'utf8'), '다른 PC의 A 원고');
  assert.equal(fs.readFileSync(path.join(target, 'works', ...getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(episodeB.id).storage_key.split('/')), 'utf8'), '현재 PC의 B 원고');
  assert.equal(fs.readFileSync(path.join(target, 'works', ...getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(addedEpisode.id).storage_key.split('/')), 'utf8'), '새 회차 원고');
  assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_runs ORDER BY id').all().map(row => ({ ...row })), localRuns);
  assert.deepEqual(getDatabase().prepare('SELECT * FROM review_jobs ORDER BY id').all().map(row => ({ ...row })), localJobs);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) count FROM review_jobs WHERE id = ?').get(remoteJob.id).count, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) count FROM scene_narration_metadata WHERE episode_id = ?').get(episodeC.id).count, 1);
  const { buildCurrentSource } = require('../review/review-service.cjs');
  const firstSource = buildCurrentSource(await buildEpisodeWorkContext(targetStorage, { workId, episodeId: episodeA.id }));
  const thirdSource = buildCurrentSource(await buildEpisodeWorkContext(targetStorage, { workId, episodeId: episodeC.id }));
  assert.equal(firstSource.episodeContentHash, service.sha256(Buffer.from('다른 PC의 A 원고')));
  assert.equal(typeof firstSource.canonContextHash, 'string');
  assert.equal(typeof thirdSource.sceneMetadataHash, 'string');
  console.log('PASS update: shared baseline, World/Character/Alias, Episode TXT/Scene, local Review history, fingerprint, stale preview, rollback and FK');
  closeDatabase(); initializeDatabase(path.join(source, 'novelcompany.db'));
  records.delete(scope.location, deletableLocation.id);
  records.update(scope.world, first.id, { displayName: '세계 A 원격 재수정', fieldValues: {} });
  updateEpisodeWithContent(storage, episodeA.id, { workId, episodeNumber: 1, title: '1화', content: '원격 충돌 원고' });
  const conflictZip = path.join(temporary, 'conflict.zip'); service.exportSnapshot(source, conflictZip, '0.1.0');
  closeDatabase(); initializeDatabase(path.join(target, 'novelcompany.db'));
  records.create(scope.city, inputFor(scope.city, '현재 PC 도시', { location: deletableLocation.id }));
  records.update(scope.world, first.id, { displayName: '세계 A 로컬 재수정', fieldValues: {} });
  updateEpisodeWithContent(targetStorage, episodeA.id, { workId, episodeNumber: 1, title: '1화', content: '현재 PC 충돌 원고' });
  const conflictingPath = path.join(temporary, 'conflicting-incoming'), conflicting = validated(conflictZip, conflictingPath);
  const blocked = updater.previewUpdate(target, conflictingPath, conflicting, path.join(temporary, 'blocked-merge'), '0.1.0');
  assert.ok(blocked.conflicts.some(item => item.key === 'canon:' + first.id));
  assert.ok(blocked.conflicts.some(item => item.key === 'episode:' + episodeA.id));
  assert.ok(blocked.conflicts.some(item => item.key === 'canon:' + deletableLocation.id && item.reason.includes('참조')));
  assert.equal(blocked.mergedZip, null);
  console.log('PASS update refusal: same Canon/TXT divergence and Location deletion versus City reference; no partial apply');
}

/** 해시 비교가 충돌·삭제·동명이인·수정 시각을 보수적으로 판정하는지 검사한다. */
function compareCases() {
  const unit = (key, hash, title = key, updatedAt = '2026-01-01') => [key, { id: key.split(':')[1], type: key.split(':')[0], title, hash, updatedAt }];
  const snapshot = pairs => ({ units: new Map(pairs) });
  const old = 'a'.repeat(64), local = 'b'.repeat(64), remote = 'c'.repeat(64);
  const baseline = { version: 1, id: '00000000-0000-4000-8000-000000000001', hashes: { 'canon:one': old } };
  assert.equal(updater.compare(snapshot([unit('canon:one', local)]), snapshot([unit('canon:one', remote, 'canon:one', '2030-01-01')]), baseline, baseline).conflicts.length, 1);
  assert.equal(updater.compare(snapshot([]), snapshot([unit('canon:one', remote)]), baseline, baseline).conflicts.length, 1);
  assert.equal(updater.compare(snapshot([unit('canon:one', old)]), snapshot([]), baseline, baseline).apply[0].action, 'delete');
  assert.equal(updater.compare(snapshot([]), snapshot([unit('canon:new', remote)]), baseline, baseline).apply.length, 1);
  assert.equal(updater.compare(snapshot([unit('canon:one', old, '동명')]), snapshot([unit('canon:one', old, '동명'), unit('canon:other', remote, '동명')]), baseline, baseline).conflicts.length, 1);
  assert.equal(updater.compare(snapshot([unit('episode:one', local)]), snapshot([unit('episode:one', remote)]), null, null).conflicts.length, 1);
  const movedLocal = { ...unit('episode:moved', old)[1], data: { row: { work_id: 'a' } } }, movedRemote = { ...unit('episode:moved', remote)[1], data: { row: { work_id: 'b' } } };
  assert.equal(updater.compare(snapshot([['episode:moved', movedLocal]]), snapshot([['episode:moved', movedRemote]]), baseline, baseline).conflicts[0].reason.includes('소속 Work'), true);
  const identity = { workIds: ['work:a'], spaces: [{ id: 'space:a', work_id: 'a' }], definition: { canon_sets: [], canon_fields: [], canon_field_options: [] } };
  assert.throws(() => updater.assertCompatible(identity, { ...identity, workIds: ['work:b'] }, 14, 14), error => error.code === 'UPDATE_IDENTITY_MISMATCH');
  assert.throws(() => updater.assertCompatible(identity, { ...identity, spaces: [{ id: 'space:b', work_id: 'a' }] }, 14, 14), error => error.code === 'UPDATE_IDENTITY_MISMATCH');
  assert.throws(() => updater.assertCompatible(identity, { ...identity, definition: { ...identity.definition, canon_fields: [{ id: 'other-field' }] } }, 14, 14), error => error.code === 'UPDATE_DEFINITION_MISMATCH');
  assert.throws(() => updater.assertCompatible(identity, identity, 13, 14), error => error.code === 'UPDATE_SCHEMA_MISMATCH');
  console.log('PASS update conflicts: same item, delete/modify, new item, same-name different ID, no common baseline, timestamp never decides');
}

/** 전체 덮어쓰기의 공식 구형 Migration과 최신 Schema 검증을 수행한다. */
function oldSchemaCase() {
  const oldZip = path.join(temporary, 'old.zip'); oldPackage(oldZip);
  const originalHash = service.sha256(fs.readFileSync(oldZip));
  const extracted = validated(oldZip, path.join(temporary, 'old-extracted'));
  assert.equal(extracted.sourceSchemaVersion, 13); assert.equal(extracted.summary.databaseSchemaVersion, 15);
  const root = path.join(temporary, 'old-target'); fs.mkdirSync(root); initializeDatabase(path.join(root, 'novelcompany.db'));
  service.replaceData(root, oldZip, '0.1.0'); service.recoverInterruptedRestore(root); initializeDatabase(path.join(root, 'novelcompany.db'));
  assert.equal(getDatabase().prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 15);
  assert.equal(getDatabase().prepare('SELECT title FROM works').get().title, '구형 작품');
  assert.equal(fs.readFileSync(path.join(root, 'works', ...getDatabase().prepare('SELECT storage_key FROM episodes').get().storage_key.split('/')), 'utf8'), '구형 원고\r\n');
  assert.equal(service.sha256(fs.readFileSync(oldZip)), originalHash);
  closeDatabase();
  console.log('PASS overwrite: official 013→015 isolated migration, original ZIP unchanged, installed DB/TXT and journal verification');
}

/** 모든 테스트를 독립 임시 루트에서 실행하고 연결과 파일을 정리한다. */
async function run() {
  try { oldSchemaCase(); compareCases(); await mergeFixture(); }
  finally { closeDatabase(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
