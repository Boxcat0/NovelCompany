const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeDatabase, closeDatabase, getDatabase } = require('../database/database.cjs');
const { createCanonFixture, inputFor } = require('../database/canon-record-validation.cjs');
const definitions = require('../database/repositories/canon-definition-repository.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const metadata = require('../database/repositories/scene-narration-repository.cjs');
const runs = require('../database/repositories/review-repository.cjs');
const jobs = require('../database/repositories/review-job-repository.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createEpisodeWithContent, updateEpisodeWithContent, deleteEpisodeWithContent } = require('../episode-service.cjs');
const service = require('./scene-narration-service.cjs');
const { buildEpisodeReviewContext, parseSceneLayout } = require('./review-context-builder.cjs');
const { applySceneNarration, buildSceneMetadataHash } = require('./scene-narration.cjs');
const { startEpisodeReview, getReviewsByEpisode } = require('../review/review-service.cjs');
const { createReviewQueue } = require('../review/review-queue-service.cjs');

/** 실제 Generic Definition의 필수 참조를 채운 독립 작품·인물 fixture를 만든다. */
function fixture() {
  const scope = createCanonFixture();
  const workId = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(scope.world.canonSpaceId).work_id;
  const world = records.create(scope.world, inputFor(scope.world, '세계'));
  const location = records.create(scope.location, inputFor(scope.location, '호텔', { world: world.id }));
  const attribute = records.create(scope.attribute, inputFor(scope.attribute, '물'));
  const option = definitions.getCanonDefinitionBySetId(scope.passive.setId).fields.find(f => f.key === 'passive_type').options.find(o => o.value === 'COMMON').id;
  const passive = records.create(scope.passive, inputFor(scope.passive, '기본', { passive_type: option }));
  const values = { origin_location: location.id, attributes: [attribute.id], passives: [passive.id] };
  const character = records.create(scope.character, inputFor(scope.character, '서술자', values));
  const other = records.create(scope.character, inputFor(scope.character, '다른 서술자', values));
  return { scope, workId, world, character, other };
}

/** 현재 저장본 조건을 그대로 사용하는 작가 지정 payload를 만든다. */
function input(snapshot, mode = 'UNKNOWN', narratorCharacterId = null, index = 0) {
  return { workId: snapshot.workId, episodeId: snapshot.episodeId, expectedEpisodeContentHash: snapshot.episodeContentHash,
    expectedSceneLayoutVersion: snapshot.layoutVersion, expectedSceneIdentity: snapshot.scenes[index].identity, narration: { mode, narratorCharacterId } };
}

/** 실패 코드와 한국어 메시지를 함께 확인한다. */
async function rejects(action, code) { await assert.rejects(async () => action(), error => error.code === code && /[가-힣]/.test(error.message)); }

/** 실제 Worker 전환에만 제한된 대기를 적용한다. */
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('대기열 상태 전환 시간 초과'); }

/** 010 DB의 실제 Run/Job을 보존하며 백업 후 011을 한 번만 적용하는지 검증한다. */
function validateMigration(root, episodeId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = getDatabase();
  db.exec('DROP TABLE canon_record_aliases; ALTER TABLE review_runs DROP COLUMN name_resolution_version; ALTER TABLE review_jobs DROP COLUMN name_resolution_version; DROP TRIGGER invalidate_deleted_scene_narrator; DROP TRIGGER delete_episode_scene_narration; DROP TABLE scene_narration_metadata; ALTER TABLE review_runs DROP COLUMN scene_metadata_hash; ALTER TABLE review_runs DROP COLUMN scene_metadata_version; ALTER TABLE review_jobs DROP COLUMN scene_metadata_hash; ALTER TABLE review_jobs DROP COLUMN scene_metadata_version; DELETE FROM schema_migrations WHERE version >= 11');
  const oldRuns = db.prepare('SELECT * FROM review_runs ORDER BY id').all();
  const oldJobs = db.prepare('SELECT * FROM review_jobs ORDER BY id').all();
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  closeDatabase();
  const migrated = initializeDatabase(path.join(root, 'novelcompany.db'));
  assert.equal(migrated.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, 12);
  for (const [table, expected] of [['review_runs', oldRuns], ['review_jobs', oldJobs]]) {
    const actual = migrated.prepare('SELECT * FROM ' + table + ' ORDER BY id').all().map(({ name_resolution_version, scene_metadata_hash, scene_metadata_version, ...row }) => { assert.equal(scene_metadata_hash, null); assert.equal(scene_metadata_version, null); return { ...row }; });
    assert.deepEqual(actual, expected.map(row => ({ ...row })));
  }
  assert.deepEqual(migrated.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId), episode);
  const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task027-'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(root, 'backups', backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 10); assert.deepEqual(backup.prepare('SELECT * FROM review_runs ORDER BY id').all(), oldRuns); } finally { backup.close(); }
  closeDatabase(); initializeDatabase(path.join(root, 'novelcompany.db'));
  assert.equal(fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task027-')).length, 1);
}

/** 임시 DB/TXT에서 시점 저장·버전·삭제·Review·경합을 통합 검증한다. */
async function validate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-scene-'));
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  const dbFile = path.join(root, 'novelcompany.db');
  let queue;
  try {
    initializeDatabase(dbFile);
    const storage = new LocalEpisodeStorage(root); await storage.ensureBaseStorage();
    const f = fixture(); const foreign = fixture();
    const content = '나는 {해일}을 사용했다.\n[호텔]\n"나는 모른다."\n[그 시각 바다]\n마지막 장면';
    const episode = createEpisodeWithContent(storage, { workId: f.workId, episodeNumber: 1, title: '시점 검증', content });
    const storedEpisode = getDatabase().prepare('SELECT work_id, storage_key FROM episodes WHERE id = ?').get(episode.id);
    const textPath = storage.resolveManagedPath(storedEpisode.work_id, storedEpisode.storage_key);
    const originalBytes = fs.readFileSync(textPath);
    const scope = { workId: f.workId, episodeId: episode.id };
    let snapshot = await service.getForEpisode(storage, scope);
    assert.equal(snapshot.scenes.length, 3);
    assert.ok(snapshot.scenes.every(s => s.narration.source === 'UNSET'));
    assert.deepEqual(snapshot.characters.map(c => c.recordId).sort(), [f.character.id, f.other.id].sort());
    const before = await buildEpisodeReviewContext(storage, scope);
    const unsetHash = buildSceneMetadataHash(snapshot);
    await service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', f.character.id));
    await service.save(storage, input(snapshot, 'EXTERNAL_THIRD_PERSON', null, 1));
    await service.save(storage, input(snapshot, 'UNKNOWN', null, 2));
    snapshot = await service.getForEpisode(storage, scope);
    assert.equal(snapshot.scenes[0].narration.narratorCharacter.recordId, f.character.id);
    assert.equal(snapshot.scenes[2].narration.source, 'AUTHOR_SET');
    assert.notEqual(buildSceneMetadataHash(snapshot), unsetHash);
    const after = await buildEpisodeReviewContext(storage, scope);
    assert.deepEqual(after.abilityOwnershipChecks, before.abilityOwnershipChecks);
    assert.equal(after.abilityOwnershipChecks[0].actorCharacterId, null);
    assert.deepEqual(after.relevantCanon, before.relevantCanon);
    for (let i = 0; i < before.scenes.length; i++) for (const key of ['originalRange', 'locationHeading', 'notationOccurrences', 'resolvedLocation']) assert.deepEqual(after.scenes[i][key], before.scenes[i][key]);
    const hash = buildSceneMetadataHash(snapshot);
    getDatabase().exec("UPDATE scene_narration_metadata SET updated_at = '2099', created_at = '2000'");
    await service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', f.character.id));
    assert.equal(buildSceneMetadataHash(await service.getForEpisode(storage, scope)), hash);
    closeDatabase(); initializeDatabase(dbFile);
    assert.equal(buildSceneMetadataHash(await service.getForEpisode(storage, scope)), hash);
    for (const [mode, id] of [['FIRST_PERSON_CHARACTER', null], ['EXTERNAL_THIRD_PERSON', f.character.id], ['UNKNOWN', f.character.id], ['INVALID', null], ['FIRST_PERSON_CHARACTER', [f.character.id]]]) await rejects(() => service.save(storage, input(snapshot, mode, id)), 'SCENE_NARRATION_INVALID');
    for (const id of [foreign.character.id, f.world.id, 'deleted']) await rejects(() => service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', id)), 'SCENE_NARRATOR_INVALID');
    assert.throws(() => getDatabase().prepare("UPDATE scene_narration_metadata SET narrator_character_id = ? WHERE narration_mode = 'FIRST_PERSON_CHARACTER'").run(foreign.character.id));
    assert.throws(() => getDatabase().exec("UPDATE scene_narration_metadata SET narrator_character_id = NULL WHERE narration_mode = 'FIRST_PERSON_CHARACTER'"));
    for (const override of [{ expectedSceneIdentity: 'a'.repeat(64) }, { expectedEpisodeContentHash: 'b'.repeat(64) }, { expectedSceneLayoutVersion: 'FUTURE' }]) await rejects(() => service.save(storage, { ...input(snapshot), ...override }), 'SCENE_CONTEXT_STALE');
    const future = applySceneNarration(content, parseSceneLayout(content), metadata.getForEpisode(episode.id), snapshot.characters, 'FUTURE');
    assert.ok(future.scenes.every(s => s.narration.source === 'UNSET'));
    assert.equal(future.hasStaleMetadata, true);
    const wrongIdentity = metadata.getForEpisode(episode.id).map(row => ({ ...row, sceneIdentity: 'a'.repeat(64) }));
    assert.ok(applySceneNarration(content, parseSceneLayout(content), wrongIdentity, snapshot.characters).scenes.every(s => s.narration.source === 'UNSET'));
    const run = await startEpisodeReview(storage, scope);
    assert.equal(run.source.sceneMetadataHash, hash);
    const legacy = runs.createRun({ ...scope, processorKey: 'TEST', episodeContentHash: run.source.episodeContentHash, canonContextHash: require('../review/review-service.cjs').buildCurrentSource(await require('./episode-work-context-builder.cjs').buildEpisodeWorkContext(storage, scope), null).canonContextHash, contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2' }); runs.completeRun(legacy.id, []);
    await service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', f.other.id));
    let reviews = await getReviewsByEpisode(storage, scope);
    assert.equal(reviews.find(r => r.id === run.id).freshness.sceneMetadataComparison, 'CHANGED');
    assert.equal(reviews.find(r => r.id === run.id).freshness.isCurrent, false);
    assert.equal(reviews.find(r => r.id === legacy.id).freshness.isCurrent, true);
    assert.equal(reviews.find(r => r.id === legacy.id).freshness.sceneMetadataComparison, 'LEGACY_NOT_TRACKED');
    const renamedRun = await startEpisodeReview(storage, scope);
    records.update(f.scope.character, f.other.id, { displayName: '변경된 서술자 이름', fieldValues: f.other.fieldValues });
    assert.equal((await getReviewsByEpisode(storage, scope)).find(r => r.id === renamedRun.id).freshness.sceneMetadataComparison, 'CHANGED');

    // 제출 및 POV 저장은 같은 gate를 사용하며 비동기 TXT 읽기 중에도 상호 배제한다.
    let release; const pause = new Promise(resolve => { release = resolve; });
    const slow = Object.create(storage); slow.readEpisodeByStorageKey = async key => { await pause; return storage.readEpisodeByStorageKey(key); };
    const pendingSave = service.save(slow, input(snapshot));
    queue = createReviewQueue(storage);
    await rejects(() => queue.submit(scope), 'EPISODE_OPERATION_BUSY');
    await rejects(() => updateEpisodeWithContent(storage, episode.id, { workId: f.workId, episodeNumber: 1, title: '경합', content: '경합' }), 'EPISODE_OPERATION_BUSY');
    release(); await pendingSave;
    let releaseSubmit; const waitSubmit = new Promise(resolve => { releaseSubmit = resolve; });
    const slowSubmit = Object.create(storage); slowSubmit.readEpisodeByStorageKey = async key => { await waitSubmit; return storage.readEpisodeByStorageKey(key); };
    const slowQueue = createReviewQueue(slowSubmit); slowQueue.stop(); const pendingSubmit = slowQueue.submit(scope);
    await rejects(() => service.save(storage, input(snapshot)), 'EPISODE_OPERATION_BUSY');
    releaseSubmit(); const queued = await pendingSubmit;
    assert.ok(queued.sceneMetadataHash); assert.equal(queued.sceneMetadataVersion, 'SCENE_NARRATION_V1');
    await rejects(() => service.save(storage, input(snapshot)), 'EPISODE_REVIEW_LOCKED');
    await rejects(() => metadata.save({ ...scope, episodeContentHash: snapshot.episodeContentHash, sceneLayoutVersion: snapshot.layoutVersion, sceneIdentity: snapshot.scenes[0].identity, narration: input(snapshot).narration }), 'EPISODE_REVIEW_LOCKED');
    slowQueue.cancelQueued(queued.id); await service.save(storage, input(snapshot));
    let finish;
    queue = createReviewQueue(storage, () => ({ processorKey: 'TEST', review(context) { assert.ok(context.scenes[0].narration); return new Promise(resolve => { finish = resolve; }); } }));
    queue.start(); const running = await queue.submit(scope);
    await waitFor(() => Boolean(finish));
    await rejects(() => service.save(storage, input(snapshot)), 'EPISODE_REVIEW_LOCKED');
    finish({ findings: [] }); await waitFor(() => jobs.getById(running.id).status === 'COMPLETED');
    assert.equal(runs.getById(jobs.getById(running.id).reviewRunId).sceneMetadataHash, running.sceneMetadataHash);
    await service.save(storage, input(snapshot)); queue.stop();
    const failed = await queue.submit(scope); getDatabase().prepare("UPDATE review_jobs SET status = 'FAILED' WHERE id = ?").run(failed.id); await service.save(storage, input(snapshot));
    const changed = await queue.submit(scope);
    getDatabase().prepare("UPDATE scene_narration_metadata SET narration_mode = 'EXTERNAL_THIRD_PERSON' WHERE scene_identity = ?").run(snapshot.scenes[0].identity);
    queue = createReviewQueue(storage); queue.start(); await waitFor(() => jobs.getById(changed.id).status === 'RESUBMIT_REQUIRED');
    assert.equal(jobs.getById(changed.id).reviewRunId, null); await service.save(storage, input(snapshot)); queue.stop();
    const legacyJob = jobs.submit({ ...scope, episodeContentHash: run.source.episodeContentHash, canonContextHash: run.source.canonContextHash });
    queue = createReviewQueue(storage); queue.start(); await waitFor(() => jobs.getById(legacyJob.id).status === 'RESUBMIT_REQUIRED'); queue.stop();

    // Canon 삭제는 잠기지 않으며 참조를 UNKNOWN으로 무효화한다.
    await service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', f.character.id));
    getDatabase().exec("CREATE TEMP TRIGGER fail_narrator_delete AFTER DELETE ON canon_records BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
    assert.throws(() => records.delete(f.scope.character, f.character.id));
    getDatabase().exec('DROP TRIGGER fail_narrator_delete');
    assert.equal((await service.getForEpisode(storage, scope)).scenes[0].narration.narratorCharacter.recordId, f.character.id);
    const deleteJob = await queue.submit(scope);
    records.delete(f.scope.character, f.character.id);
    let current = await service.getForEpisode(storage, scope);
    assert.equal(current.scenes[0].narration.mode, 'UNKNOWN');
    assert.equal(current.scenes[0].narration.status, 'NARRATOR_DELETED');
    assert.equal(current.scenes[0].narration.narratorCharacter, null);
    assert.ok((await buildEpisodeReviewContext(storage, scope)).warnings.some(w => /서술자/.test(w.message)));
    queue = createReviewQueue(storage); queue.start(); await waitFor(() => jobs.getById(deleteJob.id).status === 'RESUBMIT_REQUIRED'); queue.stop();
    await service.save(storage, input(snapshot, 'FIRST_PERSON_CHARACTER', f.other.id));
    definitions.deleteCanonForWork(f.workId);
    current = await service.getForEpisode(storage, scope);
    assert.equal(current.characters.length, 0); assert.equal(current.scenes[0].narration.mode, 'UNKNOWN');
    definitions.createCanonSpaceForWork(f.workId);
    assert.equal((await service.getForEpisode(storage, scope)).scenes[0].narration.narratorCharacter, null);

    assert.deepEqual(fs.readFileSync(textPath), originalBytes);
    fs.writeFileSync(textPath, content + '외부 변경');
    await rejects(() => service.save(storage, input(snapshot)), 'SCENE_CONTEXT_STALE');
    fs.writeFileSync(textPath, originalBytes);

    updateEpisodeWithContent(storage, episode.id, { workId: f.workId, episodeNumber: 1, title: episode.title, content: '[새 장면]\n' + content });
    current = await service.getForEpisode(storage, scope);
    assert.equal(current.hasStaleMetadata, true); assert.ok(current.scenes.every(s => s.narration.source === 'UNSET'));
    await rejects(() => service.save(storage, input(snapshot)), 'SCENE_CONTEXT_STALE');
    reviews = await getReviewsByEpisode(storage, scope);
    assert.equal(reviews.find(r => r.id === run.id).freshness.sceneMetadataComparison, 'UNDETERMINED_EPISODE_CHANGED');
    assert.equal(reviews.find(r => r.id === run.id).freshness.sceneMetadataChanged, false);
    assert.equal(metadata.getForEpisode(episode.id).length, 3);
    const disposable = createEpisodeWithContent(storage, { workId: f.workId, episodeNumber: 2, title: '삭제', content: '원본' });
    await service.save(storage, input(await service.getForEpisode(storage, { workId: f.workId, episodeId: disposable.id })));
    deleteEpisodeWithContent(storage, disposable.id, f.workId);
    assert.equal(metadata.getForEpisode(disposable.id).length, 0);
    assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    validateMigration(root, episode.id);
    console.log('Task027 Scene Narration: modes/scope/version/persistence/ownership/hash/freshness/gate/queue/lifecycle PASS');
  } finally { queue?.stop(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.NOVEL_COMPANY_DATA_DIR; }
}
validate().catch(error => { console.error(error); process.exitCode = 1; });
