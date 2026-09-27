const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getDatabase } = require("./database.cjs");
const works = require("./repositories/work-repository.cjs");
const episodes = require("./repositories/episode-repository.cjs");
const service = require("../episode-service.cjs");
const { LocalEpisodeStorage } = require("../storage/local-episode-storage.cjs");

/** 원고의 공백과 CRLF까지 그대로 전달하는 검증 입력을 만든다. */
function inputFor(workId, episodeNumber = 1, content = " 원고\r\n\r\n둘째 줄 \n") {
  return { workId, episodeNumber, title: " 회차 제목 ", status: "DRAFT", content };
}

/** 작업용 파일까지 포함한 bytes snapshot으로 원고 손실과 잔류 파일을 검출한다. */
function fileSnapshot(root) {
  const result = {};
  /** 작품 폴더의 실제 파일 bytes를 재귀 수집한다. */
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString("hex");
    }
  }
  visit(path.join(root, "works")); return result;
}

/** 특정 IO 단계 한 번만 실패시키고 후속 복원은 실제 파일 작업으로 수행한다. */
function failingStorage(root, method, matches = () => true) {
  let failed = false;
  return new LocalEpisodeStorage(root, { ...fs,
    /** 원하는 실제 IO에 EACCES 오류를 주입한다. */
    [method](...args) {
      if (!failed && matches(...args)) { failed = true; throw Object.assign(new Error("private IO error"), { code: "EACCES" }); }
      return fs[method](...args);
    },
  });
}

/** 파일 게시 후 DB COMMIT을 실패시켜 최종 compensation을 검사한다. */
function withCommitFailure(action) {
  const db = getDatabase(); const original = db.exec;
  /** COMMIT만 실패시키고 ROLLBACK 등 실제 SQL은 실행한다. */
  db.exec = function (sql) { if (sql === "COMMIT") throw new Error("private commit failure"); return original.call(this, sql); };
  try { action(); } finally { db.exec = original; }
}

/** 빈 번호 재사용, 격리, IO/DB 실패 복원과 cleanup 로그를 임시 DB/파일로 검사한다. */
function validateEpisodeEditing(root) {
  const oldRoot = process.env.NOVEL_COMPANY_DATA_DIR;
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  try {
    const storage = new LocalEpisodeStorage(root); const db = getDatabase();
    const work = works.createWork({ title: "회차 편집 검증" });
    const other = works.createWork({ title: "다른 작품 회차" });
    const otherEpisode = service.createEpisodeWithContent(storage, inputFor(other.id));
    for (const [numbers, expected] of [[[2, 3, 4], 1], [[1, 3, 5], 2]]) {
      const sample = works.createWork({ title: "빈 번호 예시" });
      for (const number of numbers) service.createEpisodeWithContent(storage, inputFor(sample.id, number));
      assert.equal(episodes.findNextAvailableEpisodeNumber(sample.id), expected);
    }
    assert.equal(episodes.findNextAvailableEpisodeNumber(work.id), 1);
    const items = [1, 2, 3, 4].map((n) => service.createEpisodeWithContent(storage, inputFor(work.id, n, n === 1 ? "" : undefined)));
    /** 검증 작품의 번호 기반 TXT 경로를 반환한다. */
    const file = (n) => path.join(root, "works", work.id, "episodes", String(n).padStart(3, "0") + ".txt");
    assert.equal(fs.statSync(file(1)).size, 0); assert.equal(items[0].title, "회차 제목");
    assert.equal("storageKey" in items[0], false);
    assert.equal(episodes.findNextAvailableEpisodeNumber(work.id), 5);
    service.deleteEpisodeWithContent(storage, items[2].id, work.id);
    assert.equal(episodes.findNextAvailableEpisodeNumber(work.id), 3);
    assert.deepEqual(episodes.getEpisodesByWorkId(work.id).map((r) => r.episodeNumber), [1, 2, 4]);
    const replacement = service.createEpisodeWithContent(storage, inputFor(work.id, 3));
    assert.notEqual(replacement.id, items[2].id);
    assert.deepEqual(episodes.getEpisodesByWorkId(work.id).map((r) => r.episodeNumber), [1, 2, 3, 4]);
    const moved = service.updateEpisodeWithContent(storage, replacement.id, { ...inputFor(work.id, 7), status: "COMPLETED" });
    assert.equal(moved.id, replacement.id); assert.equal(fs.existsSync(file(3)), false);
    assert.equal(fs.readFileSync(file(7), "utf8"), inputFor(work.id).content);
    assert.equal(episodes.findNextAvailableEpisodeNumber(work.id), 3);
    assert.equal(episodes.getEpisodeById(moved.id).storageKey, work.id + "/episodes/007.txt");
    for (const n of [0, -1, 1.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => service.createEpisodeWithContent(storage, inputFor(work.id, n)), { code: "EPISODE_NUMBER_INVALID" });
    for (const [changes, code] of [[{ title: " " }, "EPISODE_TITLE_REQUIRED"], [{ status: "bad" }, "EPISODE_STATUS_INVALID"], [{ content: null }, "EPISODE_CONTENT_INVALID"], [{ storageKey: "../outside.txt" }, "EPISODE_INPUT_INVALID"]]) assert.throws(() => service.createEpisodeWithContent(storage, { ...inputFor(work.id, 3), ...changes }), { code });
    assert.throws(() => service.createEpisodeWithContent(storage, inputFor("missing")), { code: "WORK_NOT_FOUND" });
    assert.throws(() => service.createEpisodeWithContent(storage, { ...inputFor(work.id, 3), status: null }), { code: "EPISODE_STATUS_INVALID" });
    assert.throws(() => service.updateEpisodeWithContent(storage, moved.id, inputFor(other.id, 8)), { code: "EPISODE_NOT_FOUND" });
    assert.throws(() => service.deleteEpisodeWithContent(storage, moved.id, other.id), { code: "EPISODE_NOT_FOUND" });
    assert.throws(() => service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 2)), { code: "EPISODE_NUMBER_DUPLICATE" });
    const before = fileSnapshot(root); const rows = db.prepare("SELECT * FROM episodes ORDER BY id").all();
    /** 실패 후 전체 metadata와 원고 bytes가 동일한지 검사한다. */
    function unchanged() { assert.deepEqual(fileSnapshot(root), before); assert.deepEqual(db.prepare("SELECT * FROM episodes ORDER BY id").all(), rows); }
    for (const method of ["openSync", "writeFileSync", "fsyncSync", "closeSync", "linkSync"]) {
      assert.throws(() => service.createEpisodeWithContent(failingStorage(root, method), inputFor(work.id, 3)), { code: "EPISODE_SAVE_FAILED" }); unchanged();
    }
    for (const [method, number] of [["writeFileSync", 7], ["copyFileSync", 7], ["renameSync", 7], ["linkSync", 8]]) {
      assert.throws(() => service.updateEpisodeWithContent(failingStorage(root, method), moved.id, inputFor(work.id, number, "새 원고")), { code: "EPISODE_SAVE_FAILED" }); unchanged();
    }
    assert.throws(() => service.deleteEpisodeWithContent(failingStorage(root, "renameSync"), moved.id, work.id), { code: "EPISODE_DELETE_FAILED" }); unchanged();
    for (const [kind, action] of [
      ["save", () => service.createEpisodeWithContent(storage, inputFor(work.id, 3))],
      ["save", () => service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 7, "교체"))],
      ["save", () => service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 8, "이동"))],
      ["delete", () => service.deleteEpisodeWithContent(storage, moved.id, work.id)],
    ]) { withCommitFailure(() => assert.throws(action, { code: kind === "delete" ? "EPISODE_DELETE_FAILED" : "EPISODE_SAVE_FAILED" })); unchanged(); }
    for (const [operation, action] of [
      ["INSERT", () => service.createEpisodeWithContent(storage, inputFor(work.id, 3))],
      ["UPDATE", () => service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 8))],
      ["DELETE", () => service.deleteEpisodeWithContent(storage, moved.id, work.id)],
    ]) {
      db.exec(`CREATE TEMP TRIGGER fail_episode_write AFTER ${operation} ON episodes BEGIN SELECT RAISE(FAIL, 'private DB failure'); END`);
      try { assert.throws(action); } finally { db.exec("DROP TRIGGER fail_episode_write"); }
      unchanged();
    }
    fs.writeFileSync(file(3), "기존 별도 원고", "utf8");
    assert.throws(() => service.createEpisodeWithContent(storage, inputFor(work.id, 3)), { code: "EPISODE_CONTENT_CONFLICT" });
    assert.throws(() => service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 3)), { code: "EPISODE_CONTENT_CONFLICT" });
    assert.equal(fs.readFileSync(file(3), "utf8"), "기존 별도 원고"); fs.unlinkSync(file(3)); unchanged();
    for (const key of ["../outside.txt", "C:/outside.txt", "x/episodes/file.txt:stream", other.id + "/episodes/001.txt"]) assert.throws(() => storage.resolveManagedPath(work.id, key));
    fs.unlinkSync(file(7)); service.updateEpisodeWithContent(storage, moved.id, inputFor(work.id, 7, ""));
    assert.equal(fs.statSync(file(7)).size, 0);
    fs.unlinkSync(file(7)); service.deleteEpisodeWithContent(storage, moved.id, work.id);
    assert.equal(episodes.getEpisodeById(moved.id), null);
    for (const row of episodes.getEpisodesByWorkId(work.id)) service.deleteEpisodeWithContent(storage, row.id, work.id);
    assert.equal(works.getWorkDeletionStatus(work.id).canDelete, true);
    require("./repositories/canon-definition-repository.cjs").createCanonSpaceForWork(work.id);
    assert.equal(works.getWorkDeletionStatus(work.id).canDelete, false);
    assert.deepEqual(service.toPublicEpisode(episodes.getEpisodeById(otherEpisode.id)), otherEpisode);
    const cleanupEpisode = service.createEpisodeWithContent(storage, inputFor(work.id));
    const cleanupStorage = failingStorage(root, "unlinkSync", (p) => p.endsWith(".bak"));
    assert.equal(service.deleteEpisodeWithContent(cleanupStorage, cleanupEpisode.id, work.id).id, cleanupEpisode.id);
    assert.equal(episodes.getEpisodeById(cleanupEpisode.id), null); assert.equal(fs.existsSync(file(1)), false);
    assert.match(fs.readFileSync(path.join(root, "logs", "novelcompany.log"), "utf8"), /EPISODE_FILE_CLEANUP_FAILED/);
    const leftovers = fs.readdirSync(path.dirname(file(1)));
    assert.equal(leftovers.length, 1); assert.ok(leftovers[0].endsWith(".bak")); fs.unlinkSync(path.join(path.dirname(file(1)), leftovers[0]));
    const restoreEpisode = service.createEpisodeWithContent(storage, inputFor(work.id, 1, "복원 원본"));
    const restoreStorage = failingStorage(root, "renameSync", (source) => source.endsWith(".bak"));
    withCommitFailure(() => assert.throws(() => service.updateEpisodeWithContent(restoreStorage, restoreEpisode.id, inputFor(work.id, 1, "복원 실패 중 새 원고")), { code: "EPISODE_SAVE_FAILED" }));
    assert.deepEqual(service.toPublicEpisode(episodes.getEpisodeById(restoreEpisode.id)), restoreEpisode);
    assert.match(fs.readFileSync(path.join(root, "logs", "novelcompany.log"), "utf8"), /EPISODE_COMPENSATION_FAILED/);
    const retainedBackup = fs.readdirSync(path.dirname(file(1))).find((name) => name.endsWith(".bak"));
    assert.ok(retainedBackup);
    assert.equal(fs.readFileSync(path.join(path.dirname(file(1)), retainedBackup), "utf8"), "복원 원본");
    // 복원 자체 실패 시 자동 복구를 과장하지 않는다. 검증 전용 원본 백업을 직접 복원한다.
    fs.renameSync(path.join(path.dirname(file(1)), retainedBackup), file(1));
    service.deleteEpisodeWithContent(storage, restoreEpisode.id, work.id);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    console.log("Task021 gap reuse, number move, DB/TXT rollback, missing recovery, isolation and cleanup logging passed.");
  } finally { if (oldRoot === undefined) delete process.env.NOVEL_COMPANY_DATA_DIR; else process.env.NOVEL_COMPANY_DATA_DIR = oldRoot; }
}

/** 공개 API 경로 은닉, 동시 중복 요청, 원고 읽기 오류와 bridge 인자를 검사한다. */
async function validateEpisodeEditingIpc(ipcMain, runtimeApi, storage) {
  const { createNovelCompanyApi } = require("../ipc/preload-api.cjs");
  const api = createNovelCompanyApi({
    /** 검증용 bridge를 실제 Main handler에 연결한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  const work = works.createWork({ title: "원고 IPC 검증" }); const input = inputFor(work.id);
  const pair = await Promise.all([api.episodes.create(input), api.episodes.create(input)]);
  assert.equal(pair[0].ok, true); assert.equal(pair[1].error.code, "EPISODE_NUMBER_DUPLICATE");
  const saved = pair[0].data;
  assert.equal("storageKey" in saved, false); assert.equal("contentHash" in saved, false);
  assert.deepEqual((await api.episodes.getById(saved.id)).data, saved);
  assert.equal((await api.episodes.readContent(saved.id)).data, input.content);
  assert.equal((await api.episodes.getNextAvailableNumber(work.id)).data, 2);
  assert.equal((await api.episodes.update(saved.id, inputFor(work.id, 4))).data.id, saved.id);
  assert.equal((await api.episodes.getNextAvailableNumber(work.id)).data, 1);
  assert.equal((await api.episodes.create({ ...input, storageKey: "../secret" })).error.code, "EPISODE_INPUT_INVALID");
  const originalRead = storage.readEpisodeByStorageKey;
  /** IO 오류를 missing으로 취급하지 않는지 검사한다. */
  storage.readEpisodeByStorageKey = async () => { throw Object.assign(new Error("private read path"), { code: "EACCES" }); };
  try { assert.deepEqual((await api.episodes.readContent(saved.id)).error, { code: "EPISODE_CONTENT_READ_FAILED", message: "에피소드 원고를 불러오는 중 오류가 발생했습니다." }); }
  finally { storage.readEpisodeByStorageKey = originalRead; }
  assert.equal((await api.episodes.delete(saved.id, work.id)).ok, true);
  assert.equal((await api.episodes.delete(saved.id, work.id)).error.code, "EPISODE_NOT_FOUND");
  for (const [method, channel, args] of [["create", "episodes:create", [input]], ["update", "episodes:update", [saved.id, input]], ["delete", "episodes:delete", [saved.id, work.id]], ["getNextAvailableNumber", "episodes:get-next-number", [work.id]]]) assert.deepEqual((await runtimeApi.episodes[method](...args)).data, { channel, args });
  console.log("Task021 Episode IPC validation passed.");
}

module.exports = { validateEpisodeEditing, validateEpisodeEditingIpc };
