const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getDatabase } = require("./database.cjs");
const { createEpisode } = require("./repositories/episode-repository.cjs");
const { createWork, getAllWorks, getWorkById, updateWork, getWorkDeletionStatus, deleteWork } = require("./repositories/work-repository.cjs");

/** 예상 오류 code와 한국어 메시지를 함께 검증한다. */
function expectWorkError(action, code) {
  assert.throws(action, (error) => error.code === code && /[가-힣]/.test(error.message));
}

/** 임시 작품에 내용이 없는 CanonSpace만 연결해 Record 수와 무관한 보호를 검증한다. */
function addEmptyCanonSpace(workId) {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)").run(id, workId, "MODERN_FANTASY_V1", now, now);
  return id;
}

/** 임시 작품 CRUD, 의존성별 삭제 차단, stale 상태 재검증과 파일 보존을 검사한다. */
function validateWorkManagement(temporaryRoot) {
  const db = getDatabase();
  for (const status of ["ACTIVE", "PAUSED", "COMPLETED"]) {
    const work = createWork({ title: "  테스트 작품 " + status + "  ", status });
    assert.equal(work.title, "테스트 작품 " + status);
    assert.equal(work.status, status);
    assert.equal(work.description, "");
    assert.equal(db.prepare("SELECT description FROM works WHERE id = ?").get(work.id).description, null);
    assert.ok(getAllWorks().some((item) => item.id === work.id));
    assert.deepEqual(getWorkById(work.id), work);
    assert.deepEqual(getWorkDeletionStatus(work.id), { canDelete: true, episodeCount: 0, hasCanonSpace: false });
    assert.deepEqual(deleteWork(work.id), { id: work.id });
    assert.equal(getWorkById(work.id), null);
  }
  const work = createWork({ title: "테스트 작품 A", description: "" });
  assert.equal(work.status, "ACTIVE");
  assert.equal(db.prepare("SELECT description FROM works WHERE id = ?").get(work.id).description, "");
  const duplicate = createWork({ title: "테스트 작품 A" });
  assert.notEqual(duplicate.id, work.id);
  for (const input of [{ title: "" }, { title: " \t\n" }, {}, null, []]) expectWorkError(() => createWork(input), "WORK_TITLE_REQUIRED");
  expectWorkError(() => createWork({ title: "테스트", status: "UNKNOWN" }), "WORK_STATUS_INVALID");
  expectWorkError(() => createWork({ title: "테스트", description: 123 }), "WORK_DESCRIPTION_INVALID");
  const updated = updateWork(work.id, { title: " 수정된 테스트 작품 ", description: "설명 수정\n두 번째 줄", status: "PAUSED" });
  assert.equal(updated.title, "수정된 테스트 작품");
  assert.equal(updated.description, "설명 수정\n두 번째 줄");
  assert.equal(updated.status, "PAUSED");
  assert.equal(updated.id, work.id);
  assert.equal(updated.createdAt, work.createdAt);
  for (const changes of [{ status: "INVALID" }, { title: " " }, { description: {} }]) {
    expectWorkError(() => updateWork(work.id, changes), changes.status ? "WORK_STATUS_INVALID" : changes.title ? "WORK_TITLE_REQUIRED" : "WORK_DESCRIPTION_INVALID");
    assert.deepEqual(getWorkById(work.id), updated);
  }
  assert.equal(updateWork(work.id, { description: null }).description, "");
  assert.equal(db.prepare("SELECT description FROM works WHERE id = ?").get(work.id).description, null);
  assert.equal(updateWork(work.id, { status: "COMPLETED" }).status, "COMPLETED");
  assert.equal(getWorkById("missing-work"), null);
  // Repository는 기존 null 계약을 유지하고 IPC가 WORK_NOT_FOUND로 변환한다.
  assert.equal(updateWork("missing-work", { title: "없음" }), null);
  expectWorkError(() => getWorkDeletionStatus("missing-work"), "WORK_NOT_FOUND");
  expectWorkError(() => deleteWork("missing-work"), "WORK_NOT_FOUND");
  for (const id of [null, "", "  ", 12]) {
    expectWorkError(() => getWorkDeletionStatus(id), "WORK_ID_REQUIRED");
    expectWorkError(() => deleteWork(id), "WORK_ID_REQUIRED");
  }

  for (const [hasEpisode, hasCanon, code] of [
    [true, false, "WORK_DELETE_BLOCKED_BY_EPISODES"],
    [false, true, "WORK_DELETE_BLOCKED_BY_CANON"],
    [true, true, "WORK_DELETE_BLOCKED_BY_DEPENDENCIES"],
  ]) {
    const protectedWork = createWork({ title: "테스트 의존성 작품" });
    // 삭제 가능 상태를 먼저 읽은 뒤 의존 데이터를 추가해 서버 재검증을 확인한다.
    assert.equal(getWorkDeletionStatus(protectedWork.id).canDelete, true);
    let episode;
    if (hasEpisode) episode = createEpisode({ workId: protectedWork.id, episodeNumber: 1, title: "테스트 회차", storageKey: protectedWork.id + "/episodes/001.txt" });
    const canonId = hasCanon ? addEmptyCanonSpace(protectedWork.id) : null;
    assert.deepEqual(getWorkDeletionStatus(protectedWork.id), { canDelete: false, episodeCount: Number(hasEpisode), hasCanonSpace: hasCanon });
    expectWorkError(() => deleteWork(protectedWork.id), code);
    assert.deepEqual(getWorkById(protectedWork.id), protectedWork);
    if (episode) assert.equal(db.prepare("SELECT id FROM episodes WHERE id = ?").get(episode.id).id, episode.id);
    if (canonId) {
      assert.equal(db.prepare("SELECT id FROM canon_spaces WHERE id = ?").get(canonId).id, canonId);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM canon_records WHERE canon_space_id = ?").get(canonId).count, 0);
    }
  }

  const failedDelete = createWork({ title: "테스트 삭제 오류" });
  db.exec("CREATE TEMP TRIGGER task018_delete_failure AFTER DELETE ON works BEGIN SELECT RAISE(FAIL, 'internal delete failure'); END");
  try {
    expectWorkError(() => deleteWork(failedDelete.id), "WORK_DELETE_FAILED");
    assert.deepEqual(getWorkById(failedDelete.id), failedDelete);
  } finally { db.exec("DROP TRIGGER task018_delete_failure"); }
  deleteWork(failedDelete.id);

  const fileWork = createWork({ title: "테스트 파일 보존" });
  const episodeDirectory = path.join(temporaryRoot, "works", fileWork.id, "episodes");
  fs.mkdirSync(episodeDirectory, { recursive: true });
  const txtPath = path.join(episodeDirectory, "001.txt");
  fs.writeFileSync(txtPath, "테스트 원고 보존", "utf8");
  deleteWork(fileWork.id);
  assert.equal(fs.readFileSync(txtPath, "utf8"), "테스트 원고 보존");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Task018 Work CRUD, dependency protection, revalidation, rollback and TXT preservation passed.");
}

module.exports = { validateWorkManagement, addEmptyCanonSpace };
