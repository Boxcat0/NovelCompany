const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeDatabase, getDatabase, initializeDatabase } = require("../database/database.cjs");
const { createEpisodeWithContent, updateEpisodeWithContent } = require("../episode-service.cjs");
const { LocalEpisodeStorage } = require("../storage/local-episode-storage.cjs");
const records = require("../database/repositories/canon-record-repository.cjs");
const repository = require("../database/repositories/review-repository.cjs");
const { createCanonFixture, inputFor } = require("../database/canon-record-validation.cjs");
const { getCanonDefinitionBySetId } = require('../database/repositories/canon-definition-repository.cjs');

/** 격리 fixture의 실제 Option Definition에서 저장 가능한 ID를 찾는다. */
function optionId(scope, key, value) {
  return getCanonDefinitionBySetId(scope.setId).fields.find(field => field.key === key).options.find(option => option.value === value).id;
}
const { getReviewsByEpisode, startEpisodeReview } = require("./review-service.cjs");
const { buildCanonContextHash } = require('./review-service.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');

/** 지정 오류 code와 한국어 사용자 메시지로 Review 요청이 실패하는지 확인한다. */
async function expectFailure(action, code) {
  await assert.rejects(action, (error) => error.code === code && /[가-힣]/.test(error.message));
}

/** 원본 table과 TXT byte가 Review 처리 전후로 달라지지 않는지 읽기 전용 snapshot을 만든다. */
function sourceSnapshot(storage, episode) {
  const database = getDatabase();
  const stored = database.prepare("SELECT work_id, storage_key FROM episodes WHERE id = ?").get(episode.id);
  return {
    sourceCounts: ["works", "episodes", "canon_spaces", "canon_sets", "canon_fields", "canon_records", "canon_field_values", "canon_record_option_values", "canon_record_references"].map((table) => database.prepare("SELECT COUNT(*) AS count FROM " + table).get().count),
    text: fs.readFileSync(storage.resolveManagedPath(stored.work_id, stored.storage_key)),
  };
}

/** Temp DB에서 FULL/RELEVANT 호환, migration 007, persistence, failure, freshness와 원본 보존을 검증한다. */
async function runValidation() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-company-review-"));
  process.env.NOVEL_COMPANY_DATA_DIR = temporaryRoot;
  try {
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    const storage = new LocalEpisodeStorage(temporaryRoot);
    await storage.ensureBaseStorage();
    const scope = createCanonFixture();
    const workId = getDatabase().prepare("SELECT work_id FROM canon_spaces WHERE id = ?").get(scope.world.canonSpaceId).work_id;
    const episode = createEpisodeWithContent(storage, { workId, episodeNumber: 1, title: "Review 검증 회차", content: "저장된 원고입니다." });
    const before = sourceSnapshot(storage, episode);
    const first = await startEpisodeReview(storage, { workId, episodeId: episode.id });
    assert.equal(first.status, "COMPLETED");
    assert.equal(first.processorKey, "STUB_V1");
    assert.deepEqual(first.findings, []);
    assert.equal(first.freshness.isCurrent, true);
    assert.equal(first.source.contextMode, 'RELEVANT_CANON_V1');
    assert.deepEqual(sourceSnapshot(storage, episode), before);
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM review_runs").get().count, 1);
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM review_findings").get().count, 0);

    const second = await startEpisodeReview(storage, { workId, episodeId: episode.id });
    assert.notEqual(first.id, second.id);
    assert.equal((await getReviewsByEpisode(storage, { workId, episodeId: episode.id })).length, 2);

    const fullHash = buildCanonContextHash((await buildEpisodeWorkContext(storage, { workId, episodeId: episode.id })).canon);
    const synthetic = repository.createRun({ workId, episodeId: episode.id, processorKey: "TEST", episodeContentHash: first.source.episodeContentHash, canonContextHash: fullHash });
    const withFinding = repository.completeRun(synthetic.id, [{ category: "OTHER", message: "Synthetic finding" }]);
    assert.equal(withFinding.findings[0].message, "Synthetic finding");
    assert.equal((await getReviewsByEpisode(storage, { workId, episodeId: episode.id })).find(item => item.id === synthetic.id).freshness.isCurrent, true);
    records.create(scope.world, inputFor(scope.world, '무관한 세계'));
    const unrelated = await getReviewsByEpisode(storage, { workId, episodeId: episode.id });
    assert.equal(unrelated.find(item => item.id === first.id).freshness.isCurrent, true);
    assert.equal(unrelated.find(item => item.id === synthetic.id).freshness.canonChanged, true);

    const running = repository.createRun({ workId, episodeId: episode.id, processorKey: "TEST", episodeContentHash: first.source.episodeContentHash, canonContextHash: first.source.canonContextHash });
    await expectFailure(() => startEpisodeReview(storage, { workId, episodeId: episode.id }), "REVIEW_ALREADY_RUNNING");
    repository.failRun(running.id);
    await expectFailure(() => startEpisodeReview(storage, { workId, episodeId: episode.id }, { processorKey: "FAIL", async review() { throw new Error("processor cause"); } }), "REVIEW_FAILED");
    const failed = repository.getByEpisode({ workId, episodeId: episode.id }).find((item) => item.processorKey === "FAIL");
    assert.equal(failed.status, "FAILED");
    assert.deepEqual(failed.findings, []);
    await expectFailure(() => startEpisodeReview(storage, { workId, episodeId: episode.id }, { processorKey: "INVALID", async review() { return { findings: [{ category: "INVALID", message: "invalid" }] }; } }), "REVIEW_RESULT_INVALID");
    assert.equal(repository.getByEpisode({ workId, episodeId: episode.id }).find((item) => item.processorKey === "INVALID").status, "FAILED");

    getDatabase().exec("CREATE TEMP TRIGGER review_complete_failure BEFORE INSERT ON review_findings BEGIN SELECT RAISE(FAIL, 'forced completion failure'); END");
    try {
      await expectFailure(() => startEpisodeReview(storage, { workId, episodeId: episode.id }, { processorKey: "FINDING", async review() { return { findings: [{ category: "OTHER", message: "must rollback" }] }; } }), "REVIEW_FAILED");
      const incomplete = repository.getByEpisode({ workId, episodeId: episode.id }).find((item) => item.processorKey === "FINDING");
      assert.equal(incomplete.status, "FAILED");
      assert.deepEqual(incomplete.findings, []);
    } finally { getDatabase().exec("DROP TRIGGER review_complete_failure"); }

    const updated = updateEpisodeWithContent(storage, episode.id, { workId, episodeNumber: 1, title: episode.title, status: episode.status, content: "변경된 원고입니다. Review Canon 변경" });
    const afterEpisodeChange = await getReviewsByEpisode(storage, { workId, episodeId: episode.id });
    const episodeOnlyStale = afterEpisodeChange.find((item) => item.id === first.id);
    assert.equal(episodeOnlyStale.freshness.episodeChanged, true);
    assert.equal(episodeOnlyStale.freshness.canonChanged, false);
    assert.equal(episodeOnlyStale.freshness.canonComparison, 'UNDETERMINED_EPISODE_CHANGED');
    const episodeCurrentRun = await startEpisodeReview(storage, { workId, episodeId: episode.id });
    records.create(scope.world, inputFor(scope.world, "Review Canon 변경"));
    const afterCanonChange = await getReviewsByEpisode(storage, { workId, episodeId: episode.id });
    const bothStale = afterCanonChange.find((item) => item.id === first.id);
    assert.equal(bothStale.freshness.episodeChanged, true);
    assert.equal(bothStale.freshness.canonChanged, false);
    const canonOnlyStale = afterCanonChange.find((item) => item.id === episodeCurrentRun.id);
    assert.equal(canonOnlyStale.freshness.episodeChanged, false);
    assert.equal(canonOnlyStale.freshness.canonChanged, true);

    const relevantWorld = records.getBySetId(scope.world).find(item => item.displayName === 'Review Canon 변경');
    const selectedRun = await startEpisodeReview(storage, { workId, episodeId: episode.id });
    records.update(scope.world, relevantWorld.id, inputFor(scope.world, relevantWorld.displayName, { description: '관련 값 변경' }));
    assert.equal((await getReviewsByEpisode(storage, { workId, episodeId: episode.id })).find(item => item.id === selectedRun.id).freshness.canonChanged, true);

    const location = records.create(scope.location, inputFor(scope.location, '헤븐즈', { world: relevantWorld.id }));
    const attribute = records.create(scope.attribute, inputFor(scope.attribute, '검증 속성'));
    const passive = records.create(scope.passive, inputFor(scope.passive, '공통 패시브', { passive_type: optionId(scope.passive, 'passive_type', 'COMMON') }));
    const skill = records.create(scope.skill, inputFor(scope.skill, '버티컬 슬래쉬', { required_attribute: attribute.id }));
    const characterValues = { origin_location: location.id, attributes: [attribute.id], passives: [passive.id], skills: [skill.id] };
    const actor = records.create(scope.character, inputFor(scope.character, '한지수', characterValues));
    const partner = records.create(scope.character, inputFor(scope.character, '이카로스', characterValues));
    const abilityEpisode = createEpisodeWithContent(storage, { workId, episodeNumber: 3, title: '참조 검증', content: '한지수는 {버티컬 슬래쉬}를 사용했다.' });
    const abilityInput = { workId, episodeId: abilityEpisode.id };
    const abilityRun = await startEpisodeReview(storage, abilityInput);
    records.create(scope.relationship, inputFor(scope.relationship, '새 관계', { source_character: actor.id, target_character: partner.id, relationship_type: '동료' }));
    assert.equal((await getReviewsByEpisode(storage, abilityInput)).find(item => item.id === abilityRun.id).freshness.canonChanged, true);
    const relationshipRun = await startEpisodeReview(storage, abilityInput);
    records.update(scope.character, actor.id, inputFor(scope.character, actor.displayName, { ...characterValues, skills: [] }));
    assert.equal((await getReviewsByEpisode(storage, abilityInput)).find(item => item.id === relationshipRun.id).freshness.canonChanged, true);
    const noSkillRun = await startEpisodeReview(storage, abilityInput);
    const anotherPassive = records.create(scope.passive, inputFor(scope.passive, '다른 패시브', { passive_type: optionId(scope.passive, 'passive_type', 'COMMON') }));
    records.update(scope.character, actor.id, inputFor(scope.character, actor.displayName, { ...characterValues, skills: [], passives: [anotherPassive.id] }));
    assert.equal((await getReviewsByEpisode(storage, abilityInput)).find(item => item.id === noSkillRun.id).freshness.canonChanged, true);

    const missing = createEpisodeWithContent(storage, { workId, episodeNumber: 2, title: "누락 원고", content: "" });
    const missingRow = getDatabase().prepare("SELECT work_id, storage_key FROM episodes WHERE id = ?").get(missing.id);
    fs.unlinkSync(storage.resolveManagedPath(missingRow.work_id, missingRow.storage_key));
    const countBeforeMissing = getDatabase().prepare("SELECT COUNT(*) AS count FROM review_runs").get().count;
    await expectFailure(() => startEpisodeReview(storage, { workId, episodeId: missing.id }), "EPISODE_CONTENT_NOT_FOUND");
    assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM review_runs").get().count, countBeforeMissing);

    closeDatabase();
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    assert.ok((await getReviewsByEpisode(storage, { workId, episodeId: updated.id })).length >= 5);
    assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
    // 006 당시 schema와 legacy Run만 남긴 격리 DB를 다시 열어 007의 기본 모드 및 hash 보존을 검증한다.
    getDatabase().prepare('DELETE FROM review_findings WHERE review_run_id <> ?').run(synthetic.id);
    getDatabase().prepare('DELETE FROM review_runs WHERE id <> ?').run(synthetic.id);
    getDatabase().exec('ALTER TABLE review_runs DROP COLUMN context_mode; DELETE FROM schema_migrations WHERE version = 7');
    closeDatabase();
    initializeDatabase(path.join(temporaryRoot, 'novelcompany.db'));
    const migratedLegacy = repository.getById(synthetic.id);
    assert.equal(migratedLegacy.contextMode, 'FULL_CANON_V1');
    assert.equal(migratedLegacy.canonContextHash, fullHash);
    assert.equal(migratedLegacy.findings[0].message, 'Synthetic finding');
    console.log("Task024 Review pipeline validation passed.");
  } finally {
    closeDatabase();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    delete process.env.NOVEL_COMPANY_DATA_DIR;
  }
}

runValidation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
