const { completeLegacyRun } = require('../review/testing/finding-fixtures.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase, closeDatabase, getDatabase } = require('./database.cjs');
const { createCanonFixture, inputFor } = require('./canon-record-validation.cjs');
const records = require('./repositories/canon-record-repository.cjs');
const canon = require('./repositories/canon-definition-repository.cjs');
const aliases = require('./repositories/canon-alias-repository.cjs');
const works = require('./repositories/work-repository.cjs');
const jobs = require('./repositories/review-job-repository.cjs');
const runs = require('./repositories/review-repository.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createEpisodeWithContent } = require('../episode-service.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildEpisodeReviewContext, buildReviewContext, parseNotation } = require('../context/review-context-builder.cjs');
const { buildCurrentSource, buildRelevantCanonHash, startEpisodeReview, getReviewsByEpisode } = require('../review/review-service.cjs');
const { createReviewQueue } = require('../review/review-queue-service.cjs');
const { NAME_RESOLUTION_VERSION } = require('../context/character-name-normalization.cjs');
const narration = require('../context/scene-narration-service.cjs');

/** 임시 Generic Character 세 명과 실제 Organization 참조를 생성한다. */
function createAliasFixture(title = '별칭 검증 작품') {
  const scope = createCanonFixture();
  const workId = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(scope.world.canonSpaceId).work_id;
  works.updateWork(workId, { title });
  const world = records.create(scope.world, inputFor(scope.world, '별칭 세계'));
  const location = records.create(scope.location, inputFor(scope.location, '별칭 지역', { world: world.id }));
  const attribute = records.create(scope.attribute, inputFor(scope.attribute, '별칭 속성'));
  const option = canon.getCanonDefinitionBySetId(scope.passive.setId).fields.find(f => f.key === 'passive_type').options.find(o => o.value === 'COMMON').id;
  const passive = records.create(scope.passive, inputFor(scope.passive, '공통 패시브', { passive_type: option }));
  const organizations = ['제1기사단', '제2기사단'].map(name => records.create(scope.organization, inputFor(scope.organization, name, { location: location.id })));
  const characters = ['한지수', '이카로스', '류웨이'].map((name, index) => records.create(scope.character, inputFor(scope.character, name, { origin_location: location.id, attributes: [attribute.id], passives: [passive.id], organization: organizations[index]?.id ?? null })));
  return { scope, workId, world, attribute, organizations, characters };
}

/** 오류 코드와 한국어 공개 메시지가 유지되는지 검사한다. */
function expectCode(action, code) { assert.throws(action, error => error.code === code && /[가-힣]/.test(error.message)); }

/** Worker의 실제 상태 전환에만 제한된 대기를 적용한다. */
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Alias Queue 상태 전환 시간 초과'); }

/** 같은 Character Alias의 추가/수정/삭제와 IPC 공개 범위를 검증한다. */
async function validateAliasIpc(ipcMain, runtimeApi) {
  const { IPC_CHANNELS } = require('../ipc/ipc-channels.cjs');
  const { createNovelCompanyApi } = require('../ipc/preload-api.cjs');
  const f = createAliasFixture(); const scope = { workId: f.workId, recordId: f.characters[0].id };
  const api = createNovelCompanyApi({ invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); } });
  assert.deepEqual(Object.keys(runtimeApi.canon.aliases), ['list', 'create', 'update', 'delete']);
  const created = await api.canon.aliases.create(scope, 'IPC 별칭'); assert.equal(created.ok, true);
  const updated = await api.canon.aliases.update(scope, created.data.id, 'IPC 수정'); assert.equal(updated.data.aliasText, 'IPC 수정');
  assert.equal((await api.canon.aliases.list(scope)).data.length, 1);
  for (const [method, channel, args] of [['list', IPC_CHANNELS.CANON_ALIAS_LIST, [scope]], ['create', IPC_CHANNELS.CANON_ALIAS_CREATE, [scope, '별칭']], ['update', IPC_CHANNELS.CANON_ALIAS_UPDATE, [scope, created.data.id, '수정']], ['delete', IPC_CHANNELS.CANON_ALIAS_DELETE, [scope, created.data.id]]]) {
    const result = await runtimeApi.canon.aliases[method](...args); assert.equal(result.data.channel, channel); assert.equal(JSON.stringify(result.data.args), JSON.stringify(args));
    const denied = await api.canon.aliases[method]({ workId: 'wrong-work', recordId: scope.recordId }, ...args.slice(1)); assert.equal(denied.ok, false); assert.ok(/[가-힣]/.test(denied.error.message)); assert.deepEqual(Object.keys(denied.error).sort(), ['code', 'message']);
  }
  const duplicate = await api.canon.aliases.create(scope, 'IPC 수정'); assert.equal(duplicate.error.code, 'CANON_ALIAS_DUPLICATE');
  assert.equal('normalized_alias' in created.data, false); assert.equal('storageKey' in created.data, false);
  assert.equal((await api.canon.aliases.delete(scope, created.data.id)).ok, true);
  assert.equal((await api.canon.aliases.list(scope)).data.length, 0);
}

/** 011 DB에 012를 백업 후 적용하며 기존 Job/Run source와 queue 순번을 보존한다. */
function validateMigration(root) {
  const file = path.join(root, 'novelcompany.db'); const db = getDatabase();
  db.exec('DROP TRIGGER review_job_processor_immutable; ALTER TABLE review_jobs DROP COLUMN processor_key; DROP TABLE canon_record_aliases; ALTER TABLE review_runs DROP COLUMN findings_contract_version; ALTER TABLE review_findings DROP COLUMN contract_version; ALTER TABLE review_findings DROP COLUMN details_json; ALTER TABLE review_jobs DROP COLUMN name_resolution_version; ALTER TABLE review_runs DROP COLUMN name_resolution_version; DELETE FROM schema_migrations WHERE version >= 12');
  const before = ['works', 'episodes', 'canon_records', 'review_runs', 'review_jobs'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'review_jobs'").get()?.seq;
  closeDatabase();
  const failRoot = path.join(root, 'blocked-backup'); fs.mkdirSync(failRoot);
  const failFile = path.join(failRoot, 'novelcompany.db'); fs.copyFileSync(file, failFile); fs.writeFileSync(path.join(failRoot, 'backups'), '백업 실패 조건');
  assert.throws(() => initializeDatabase(failFile));
  const untouched = new DatabaseSync(failFile, { readOnly: true });
  try { assert.equal(untouched.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 11); assert.deepEqual(untouched.prepare('SELECT * FROM review_jobs ORDER BY rowid').all(), before[4]); } finally { untouched.close(); }
  initializeDatabase(file);
  const after = ['works', 'episodes', 'canon_records', 'review_runs', 'review_jobs'].map(table => getDatabase().prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map(({ name_resolution_version, findings_contract_version, ...row }) => { if (table.startsWith('review_')) assert.equal(name_resolution_version, null); if (table === 'review_jobs') delete row.processor_key; return { ...row }; }));
  assert.deepEqual(after, before.map(rows => rows.map(row => ({ ...row }))));
  assert.equal(getDatabase().prepare("SELECT seq FROM sqlite_sequence WHERE name = 'review_jobs'").get()?.seq, sequence);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases').get().n, 0);
  const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task028-')); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(root, 'backups', backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 11); assert.deepEqual(backup.prepare('SELECT * FROM review_jobs ORDER BY rowid').all(), before[4]); } finally { backup.close(); }
  closeDatabase(); initializeDatabase(file); assert.equal(fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-task028-')).length, 1);
}

/** 격리 DB/TXT에서 CRUD·해석·해시·Legacy·Queue·Canon lifecycle을 검증한다. */
async function validate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-alias-')); process.env.NOVEL_COMPANY_DATA_DIR = root;
  let queue;
  try {
    const dbFile = path.join(root, 'novelcompany.db'); initializeDatabase(dbFile);
    const storage = new LocalEpisodeStorage(root); await storage.ensureBaseStorage();
    const f = createAliasFixture(); const other = createAliasFixture('다른 별칭 작품');
    const scopes = f.characters.map(character => ({ workId: f.workId, recordId: character.id }));
    assert.deepEqual(aliases.list(scopes[0]), []);
    const beforeRecord = records.getById(f.scope.character, f.characters[0].id);
    const first = aliases.create(scopes[0], '  지수  '); assert.equal(first.aliasText, '지수');
    aliases.create(scopes[0], '한 씨'); const title = aliases.create(scopes[0], '기사단장님');
    expectCode(() => aliases.create(scopes[0], '지수'), 'CANON_ALIAS_DUPLICATE');
    expectCode(() => aliases.create(scopes[0], '지수'.normalize('NFD')), 'CANON_ALIAS_DUPLICATE');
    expectCode(() => aliases.create(scopes[0], '한지수'.normalize('NFD')), 'CANON_ALIAS_SAME_AS_NAME');
    for (const invalid of ['', '  ', '\n', '\t', '지\n수', '\u0000', '지\u200b수', 123, null, 'a'.repeat(201)]) expectCode(() => aliases.create(scopes[0], invalid), 'CANON_ALIAS_INVALID');
    const edited = aliases.update(scopes[0], first.id, '지수 양'); assert.equal(edited.aliasText, '지수 양'); aliases.update(scopes[0], first.id, '지수');
    expectCode(() => aliases.update(scopes[0], first.id, '한 씨'), 'CANON_ALIAS_DUPLICATE');
    const colliding = aliases.create(scopes[0], f.characters[1].displayName); aliases.delete(scopes[0], colliding.id);
    assert.deepEqual(records.getById(f.scope.character, f.characters[0].id), beforeRecord);
    for (const action of [() => aliases.list({ workId: other.workId, recordId: f.characters[0].id }), () => aliases.update({ workId: other.workId, recordId: f.characters[0].id }, first.id, '탈취'), () => aliases.delete(scopes[1], first.id)]) assert.throws(action);
    expectCode(() => aliases.list({ workId: f.workId, recordId: 'missing' }), 'CANON_RECORD_NOT_FOUND');
    expectCode(() => aliases.create({ workId: f.workId, recordId: f.world.id }, '세계 별칭'), 'CANON_ALIAS_CHARACTER_REQUIRED');
    const emptyWork = works.createWork({ title: 'Canon 없음' }); expectCode(() => aliases.list({ workId: emptyWork.id, recordId: f.characters[0].id }), 'CANON_SPACE_NOT_FOUND');
    assert.throws(() => getDatabase().prepare('INSERT INTO canon_record_aliases VALUES (?, ?, ?, ?, ?, ?)').run('bad', f.world.id, '세계 별칭', '세계 별칭', 'now', 'now'));
    assert.throws(() => getDatabase().prepare('INSERT INTO canon_record_aliases VALUES (?, ?, ?, ?, ?, ?)').run('dup', f.characters[0].id, '지수', '지수', 'now', 'now'));
    assert.throws(() => getDatabase().prepare('UPDATE canon_record_aliases SET canon_record_id = ? WHERE id = ?').run(f.world.id, first.id));

    const content = '😀 한지수가 돌아왔다. 지수가 지수는 지수를. "기사단장님!" 기사단장님께서 말했다. 지수함수 그분 그 녀석 그녀석 그 사람';
    const episode = createEpisodeWithContent(storage, { workId: f.workId, episodeNumber: 1, title: '별칭 원고', content });
    const episodeScope = { workId: f.workId, episodeId: episode.id };
    const stored = getDatabase().prepare('SELECT storage_key FROM episodes WHERE id = ?').get(episode.id); const txt = storage.resolveManagedPath(f.workId, stored.storage_key); const bytes = fs.readFileSync(txt);
    const workContext = await buildEpisodeWorkContext(storage, episodeScope);
    const source = buildCurrentSource(workContext); assert.equal(source.nameResolutionVersion, NAME_RESOLUTION_VERSION);
    let context = source.reviewContext;
    assert.equal(context.nameMentions.filter(m => m.normalizedName === '지수').length, 3);
    assert.equal(context.nameMentions[0].normalizedName, '한지수');
    assert.ok(context.nameMentions.find(m => m.normalizedName === '기사단장님').quoteContext === 'DIALOGUE');
    assert.equal(context.nameMentions.find(m => m.normalizedName === '기사단장님').candidates[0].organization.recordId, f.organizations[0].id);
    assert.ok(!context.nameMentions.some(m => ['그분', '그 녀석', '그녀석', '그 사람'].includes(m.normalizedName)));
    assert.equal(context.unresolvedMentions.filter(m => m.status === 'UNKNOWN').length, 4);
    aliases.create(scopes[0], '그분'); assert.equal((await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.some(m => m.text === '그분'), false);
    for (const lineEnd of ['\n', '\r\n']) {
      const raw = `😀[별칭 지역]${lineEnd}[별칭 지역]${lineEnd}"지수, 지수는!"${lineEnd}{지수}${lineEnd}[알림 : 지수]${lineEnd}'지수'${lineEnd}[지수]${lineEnd}지수함수`;
      const pure = buildReviewContext({ ...workContext, episode: { ...workContext.episode, content: raw } });
      assert.equal(pure.nameMentions.length, 3);
      for (const mention of pure.nameMentions) assert.equal(raw.slice(mention.range.start, mention.range.end), mention.text);
      assert.deepEqual(parseNotation(raw), parseNotation(pure.episode.content));
    }
    const decomposed = '지수'.normalize('NFD'); const nfcContext = buildReviewContext({ ...workContext, episode: { ...workContext.episode, content: '😀 ' + decomposed + '가 말했다.' } });
    assert.equal(nfcContext.nameMentions[0].range.start, 3); assert.equal(nfcContext.nameMentions[0].range.end, 3 + decomposed.length);
    const boundaries = buildReviewContext({ ...workContext, episode: { ...workContext.episode, content: '지수함수 지수의미 한 씨는 한 씨의 책 기사단장님께서는' } });
    assert.deepEqual(boundaries.nameMentions.map(m => m.text), ['한 씨', '한 씨', '기사단장님']);
    assert.throws(() => buildReviewContext(workContext, [], 'FUTURE'));
    assert.throws(() => buildRelevantCanonHash(buildReviewContext(workContext), 'V2'));
    const legacyV1 = runs.createRun({ ...episodeScope, processorKey: 'LEGACY', contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V1', episodeContentHash: source.episodeContentHash, canonContextHash: source.relevantV1ContextHash }); completeLegacyRun(legacyV1.id, []);
    const legacyV2 = runs.createRun({ ...episodeScope, processorKey: 'LEGACY', contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2', episodeContentHash: source.episodeContentHash, canonContextHash: source.relevantV2ContextHash, sceneMetadataHash: source.sceneMetadataHash, sceneMetadataVersion: source.sceneMetadataVersion }); completeLegacyRun(legacyV2.id, []);
    const run = await startEpisodeReview(storage, episodeScope);
    const originalHash = run.source.canonContextHash;
    aliases.update(scopes[0], first.id, '지수'.normalize('NFD'));
    assert.equal(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).canonContextHash, originalHash);
    aliases.update(scopes[0], first.id, '사용하지 않은 변경 이름');
    assert.notEqual(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).canonContextHash, originalHash);
    aliases.update(scopes[0], first.id, '지수');
    assert.equal(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).canonContextHash, originalHash);
    aliases.create(scopes[0], '원고에 없는 호칭');
    assert.equal(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).canonContextHash, originalHash);
    getDatabase().exec("UPDATE canon_record_aliases SET created_at = '2000', updated_at = '2099'");
    assert.equal(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).canonContextHash, originalHash);
    const secondTitle = aliases.create(scopes[1], '기사단장님');
    context = await buildEpisodeReviewContext(storage, episodeScope);
    let mention = context.nameMentions.find(m => m.normalizedName === '기사단장님');
    assert.equal(mention.status, 'AMBIGUOUS'); assert.equal(mention.recordId, null); assert.equal(mention.candidates.length, 2);
    assert.deepEqual(mention.candidates.map(c => c.organization.displayName).sort(), ['제1기사단', '제2기사단']);
    assert.ok(!context.relevantCanon.selectedRecords.some(r => r.id === f.characters[1].id));
    aliases.create(scopes[2], '기사단장님');
    context = await buildEpisodeReviewContext(storage, episodeScope); assert.equal(context.nameMentions.find(m => m.normalizedName === '기사단장님').candidates.length, 3);
    assert.ok(context.nameMentions.find(m => m.normalizedName === '기사단장님').candidates.some(c => c.organization === null));
    let history = await getReviewsByEpisode(storage, episodeScope);
    assert.equal(history.find(r => r.id === run.id).freshness.isCurrent, false);
    assert.equal(history.find(r => r.id === legacyV1.id).freshness.isCurrent, true); assert.equal(history.find(r => r.id === legacyV2.id).freshness.isCurrent, true);
    assert.equal(buildCurrentSource(await buildEpisodeWorkContext(storage, episodeScope)).sceneMetadataHash, source.sceneMetadataHash);
    const pureCharacterSet = workContext.canon.sets.find(s => s.key === 'character');
    pureCharacterSet.records.find(r => r.id === f.characters[1].id).registeredAliases = ['한지수'];
    const collision = buildReviewContext(workContext).nameMentions.find(m => m.text === '한지수'); assert.equal(collision.status, 'AMBIGUOUS'); assert.ok(collision.candidates.some(c => c.matchTypes.includes('DISPLAY_NAME')));
    pureCharacterSet.records.find(r => r.id === f.characters[0].id).registeredAliases.push('한지수');
    assert.equal(buildReviewContext(workContext).nameMentions.find(m => m.text === '한지수').candidates.length, 2);
    assert.ok(buildReviewContext(workContext).nameMentions.find(m => m.text === '한지수').candidates.find(c => c.recordId === f.characters[0].id).matchTypes.length === 2);
    const ability = records.create(f.scope.skill, inputFor(f.scope.skill, '해일', { required_attribute: f.attribute.id }));
    const abilityWork = await buildEpisodeWorkContext(storage, episodeScope);
    for (const text of ['한지수는 {해일}을 사용했다.', '지수는 {해일}을 사용했다.', '"지수는 {해일}을 사용했다."', '나는 {해일}을 사용했다.']) {
      const input = { ...abilityWork, episode: { ...abilityWork.episode, content: text } };
      assert.deepEqual(buildReviewContext(input).abilityOwnershipChecks, buildReviewContext(input, [], null).abilityOwnershipChecks);
    }
    const reference = id => ({ recordId: id, setKey: 'character', displayName: id });
    const relationField = (key, id) => ({ key, label: key, valueType: 'REFERENCE_ONE', value: reference(id) });
    const chain = { ...abilityWork, episode: { ...abilityWork.episode, content: '지수' }, canon: { ...abilityWork.canon, sets: [...abilityWork.canon.sets, { key: 'relationship', label: '관계', records: [{ id: 'r1', displayName: '첫 관계', fields: [relationField('source_character', f.characters[0].id), relationField('target_character', f.characters[1].id)] }, { id: 'r2', displayName: '둘째 관계', fields: [relationField('source_character', f.characters[1].id), relationField('target_character', f.characters[2].id)] }] }] } };
    assert.ok(buildReviewContext(chain).relevantCanon.selectedRecords.some(r => r.id === 'r1')); assert.ok(!buildReviewContext(chain).relevantCanon.selectedRecords.some(r => r.id === 'r2' || r.id === f.characters[1].id));
    const shuffled = structuredClone(abilityWork); shuffled.canon.sets.reverse(); for (const set of shuffled.canon.sets) { set.records.reverse(); for (const r of set.records) { r.fields.reverse(); r.registeredAliases?.reverse(); } }
    assert.equal(buildRelevantCanonHash(buildReviewContext(shuffled)), buildRelevantCanonHash(buildReviewContext(abilityWork)));
    const orgRun = await startEpisodeReview(storage, episodeScope);
    const organizationField = canon.getCanonDefinitionBySetId(f.scope.character.setId).fields.find(field => field.key === 'organization').id;
    records.update(f.scope.character, f.characters[0].id, { displayName: '한지수', fieldValues: { ...f.characters[0].fieldValues, [organizationField]: f.organizations[1].id } });
    assert.equal((await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.find(m => m.text === '한지수').candidates[0].organization.recordId, f.organizations[1].id);
    assert.equal((await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.find(m => m.text === '기사단장님').status, 'AMBIGUOUS');
    assert.equal((await getReviewsByEpisode(storage, episodeScope)).find(r => r.id === orgRun.id).freshness.isCurrent, false);

    const queuedEpisode = createEpisodeWithContent(storage, { workId: f.workId, episodeNumber: 2, title: '대기 별칭', content: '새 별명은 돌아왔다.' });
    const queuedScope = { workId: f.workId, episodeId: queuedEpisode.id };
    queue = createReviewQueue(storage); queue.stop();
    const queued = await queue.submit(queuedScope);
    aliases.create(scopes[2], '새 별명'); // QUEUED Canon 변경은 허용한다.
    queue = createReviewQueue(storage, () => ({ processorKey: 'MUST_NOT_RUN', review() { assert.fail('변경된 입력 Processor 호출'); } })); queue.start();
    await waitFor(() => jobs.getById(queued.id).status === 'RESUBMIT_REQUIRED'); assert.equal(jobs.getById(queued.id).reviewRunId, null); queue.stop();
    let finish, captured;
    queue = createReviewQueue(storage, () => ({ processorKey: 'HOLD_ALIAS', review(context) { captured = context; return new Promise(resolve => { finish = resolve; }); } })); queue.start();
    const running = await queue.submit(queuedScope); await waitFor(() => Boolean(finish));
    const capturedInput = structuredClone(captured);
    aliases.delete(scopes[2], aliases.list(scopes[2]).find(a => a.aliasText === '새 별명').id); // RUNNING도 Canon 별칭 편집 허용.
    assert.deepEqual(captured, capturedInput); finish({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] }); await waitFor(() => jobs.getById(running.id).status === 'COMPLETED');
    assert.equal((await getReviewsByEpisode(storage, queuedScope))[0].freshness.isCurrent, false); queue.stop();
    const beforeUnused = buildCurrentSource(await buildEpisodeWorkContext(storage, queuedScope));
    queue = createReviewQueue(storage); queue.stop(); const unchanged = await queue.submit(queuedScope);
    aliases.create(scopes[2], '무관한 새 별칭');
    queue = createReviewQueue(storage); queue.start(); await waitFor(() => jobs.getById(unchanged.id).status === 'COMPLETED'); queue.stop();
    assert.equal(beforeUnused.canonContextHash, jobs.getById(unchanged.id).canonContextHash);
    const oldSource = buildCurrentSource(await buildEpisodeWorkContext(storage, queuedScope), null);
    const oldJob = jobs.submit({ ...queuedScope, ...oldSource });
    aliases.create(scopes[0], '새 별명');
    queue = createReviewQueue(storage); queue.start(); await waitFor(() => jobs.getById(oldJob.id).status === 'COMPLETED'); queue.stop();
    assert.equal(runs.getById(jobs.getById(oldJob.id).reviewRunId).nameResolutionVersion, null);
    aliases.delete(scopes[1], secondTitle.id);
    assert.ok((await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.find(m => m.text === '기사단장님').candidates.length === 2);

    // 실제 Character 이름 변경은 기존 정책을 유지하고 같은 Record의 후보를 중복 계산하지 않는다.
    const renamed = records.update(f.scope.character, f.characters[2].id, { displayName: '기사단장님', fieldValues: f.characters[2].fieldValues });
    const renamedCandidate = (await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.find(m => m.text === '기사단장님').candidates.find(c => c.recordId === renamed.id);
    assert.deepEqual(renamedCandidate.matchTypes, ['DISPLAY_NAME', 'REGISTERED_ALIAS']);
    closeDatabase(); initializeDatabase(dbFile);
    assert.equal(aliases.list(scopes[0]).find(a => a.id === first.id).aliasText, '지수');
    const pov = await narration.getForEpisode(storage, episodeScope);
    await narration.save(storage, { ...episodeScope, expectedEpisodeContentHash: pov.episodeContentHash, expectedSceneLayoutVersion: pov.layoutVersion, expectedSceneIdentity: pov.scenes[0].identity, narration: { mode: 'FIRST_PERSON_CHARACTER', narratorCharacterId: f.characters[1].id } });
    aliases.create(scopes[1], '삭제될 별명');
    getDatabase().exec("CREATE TEMP TRIGGER fail_alias_character_delete AFTER DELETE ON canon_records BEGIN SELECT RAISE(ABORT, 'forced'); END");
    assert.throws(() => records.delete(f.scope.character, f.characters[1].id)); getDatabase().exec('DROP TRIGGER fail_alias_character_delete');
    assert.ok(aliases.list(scopes[1]).some(a => a.aliasText === '삭제될 별명'));
    assert.equal((await narration.getForEpisode(storage, episodeScope)).scenes[0].narration.mode, 'FIRST_PERSON_CHARACTER');
    records.delete(f.scope.character, f.characters[1].id);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases WHERE canon_record_id = ?').get(f.characters[1].id).n, 0);
    assert.ok(!(await buildEpisodeReviewContext(storage, episodeScope)).nameMentions.some(m => m.candidateIds.includes(f.characters[1].id)));
    assert.equal((await narration.getForEpisode(storage, episodeScope)).scenes[0].narration.status, 'NARRATOR_DELETED');
    const countBefore = getDatabase().prepare('SELECT COUNT(*) n FROM review_runs').get().n;
    const aliasCount = getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases').get().n;
    assert.equal(canon.getCanonDeletionStatus(f.workId).aliasCount, aliases.list(scopes[0]).length + aliases.list(scopes[2]).length);
    getDatabase().exec("CREATE TEMP TRIGGER fail_alias_canon_delete AFTER DELETE ON canon_spaces BEGIN SELECT RAISE(ABORT, 'forced'); END");
    assert.throws(() => canon.deleteCanonForWork(f.workId)); getDatabase().exec('DROP TRIGGER fail_alias_canon_delete');
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases').get().n, aliasCount);
    aliases.create({ workId: other.workId, recordId: other.characters[0].id }, '다른 작품 보존');
    canon.deleteCanonForWork(f.workId);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_record_aliases').get().n, 1);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_runs').get().n, countBefore);
    assert.deepEqual(fs.readFileSync(txt), bytes);
    canon.createCanonSpaceForWork(f.workId); expectCode(() => aliases.list(scopes[0]), 'CANON_RECORD_NOT_FOUND');
    assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    validateMigration(root);
    console.log('Task028 Alias CRUD/scope/NFC/name-resolution/organization/ownership/legacy/fingerprint/queue/lifecycle/migration PASS');
  } finally { queue?.stop(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.NOVEL_COMPANY_DATA_DIR; }
}

module.exports = { createAliasFixture, validateAliasIpc };
if (require.main === module) validate().catch(error => { console.error(error); process.exitCode = 1; });
