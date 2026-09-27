const assert = require("node:assert/strict");
const { getDatabase } = require("./database.cjs");
const works = require("./repositories/work-repository.cjs");
const spaces = require("./repositories/canon-definition-repository.cjs");

/** 공간 외 모든 Canon 및 Episode 행을 비교하여 빈 공간 생성의 부수 효과를 검사한다. */
function contentSnapshot() {
  const db = getDatabase();
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'canon_%' OR name = 'episodes') AND name <> 'canon_spaces' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]);
}

/** 빈 공간 생성, 작품별 격리, 중복, rollback과 기존 Definition 보존을 임시 DB에서 확인한다. */
function validateCanonSpaces() {
  const db = getDatabase();
  const before = contentSnapshot();
  const existing = db.prepare("SELECT * FROM canon_spaces ORDER BY id").all();
  for (const id of [null, "", 42]) assert.throws(() => spaces.createCanonSpaceForWork(id), { code: "WORK_ID_REQUIRED" });
  assert.throws(() => spaces.createCanonSpaceForWork("missing-work"), { code: "WORK_NOT_FOUND" });
  const first = works.createWork({ title: "빈 Canon 검증 A" });
  const second = works.createWork({ title: "빈 Canon 검증 B" });
  assert.equal(works.getWorkDeletionStatus(first.id).canDelete, true);
  assert.equal(spaces.getCanonSpaceByWorkId(first.id), null);
  const space = spaces.createCanonSpaceForWork(first.id);
  assert.equal(space.workId, first.id);
  assert.match(space.id, /^[0-9a-f-]{36}$/);
  assert.equal(space.createdAt, space.updatedAt);
  assert.equal(new Date(space.createdAt).toISOString(), space.createdAt);
  assert.deepEqual(spaces.getCanonSpaceByWorkId(first.id), space);
  assert.deepEqual(spaces.getCanonSetsByCanonSpaceId(space.id), []);
  assert.equal(works.getWorkDeletionStatus(first.id).canDelete, false);
  assert.throws(() => spaces.createCanonSpaceForWork(first.id), { code: "CANON_SPACE_ALREADY_EXISTS" });
  const other = spaces.createCanonSpaceForWork(second.id);
  assert.notEqual(other.id, space.id);
  const failed = works.createWork({ title: "생성 rollback 검증" });
  db.exec("CREATE TEMP TRIGGER fail_space AFTER INSERT ON canon_spaces BEGIN SELECT RAISE(FAIL, 'forced private error'); END");
  try { assert.throws(() => spaces.createCanonSpaceForWork(failed.id), { code: "CANON_SPACE_CREATE_FAILED", message: "Canon을 생성하는 중 오류가 발생했습니다." }); }
  finally { db.exec("DROP TRIGGER fail_space"); }
  assert.equal(spaces.getCanonSpaceByWorkId(failed.id), null);
  assert.equal(works.getWorkDeletionStatus(failed.id).canDelete, true);
  assert.deepEqual(contentSnapshot(), before);
  for (const row of existing) assert.deepEqual(db.prepare("SELECT * FROM canon_spaces WHERE id = ?").get(row.id), row);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log("CanonSpace repository validation passed.");
}

/** 실제 handler에 동시 요청을 보내고 양쪽 preload의 인자 전달 및 안정 오류를 검사한다. */
async function validateCanonSpaceIpc(ipcMain, runtimeApi) {
  const { createNovelCompanyApi } = require("../ipc/preload-api.cjs");
  const { IPC_CHANNELS } = require("../ipc/ipc-channels.cjs");
  const api = createNovelCompanyApi({
    /** 검증용 bridge 호출을 실제 Main handler에 전달한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  const work = works.createWork({ title: "동시 Canon 요청 검증" });
  const results = await Promise.all([api.canon.spaces.createForWork(work.id), api.canon.spaces.createForWork(work.id)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(results.find((result) => !result.ok).error, { code: "CANON_SPACE_ALREADY_EXISTS", message: "이 작품의 Canon은 이미 시작되어 있습니다." });
  assert.equal(getDatabase().prepare("SELECT COUNT(*) AS count FROM canon_spaces WHERE work_id = ?").get(work.id).count, 1);
  assert.deepEqual((await api.canon.spaces.createForWork("missing-work")).error, { code: "WORK_NOT_FOUND", message: "선택한 작품을 찾을 수 없습니다." });
  const failed = works.createWork({ title: "IPC 오류 검증" });
  getDatabase().exec("CREATE TEMP TRIGGER fail_space_ipc AFTER INSERT ON canon_spaces BEGIN SELECT RAISE(FAIL, 'private SQL error'); END");
  try { assert.deepEqual((await api.canon.spaces.createForWork(failed.id)).error, { code: "CANON_SPACE_CREATE_FAILED", message: "Canon을 생성하는 중 오류가 발생했습니다." }); }
  finally { getDatabase().exec("DROP TRIGGER fail_space_ipc"); }
  assert.equal(spaces.getCanonSpaceByWorkId(failed.id), null);
  assert.deepEqual((await runtimeApi.canon.spaces.createForWork(work.id)).data, { channel: IPC_CHANNELS.CANON_SPACE_CREATE_FOR_WORK, args: [work.id] });
  console.log("CanonSpace IPC validation passed.");
}

module.exports = { validateCanonSpaces, validateCanonSpaceIpc };
