const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getDatabase } = require("./database.cjs");
const canon = require("./repositories/canon-definition-repository.cjs");
const records = require("./repositories/canon-record-repository.cjs");
const works = require("./repositories/work-repository.cjs");
const { createEpisode } = require("./repositories/episode-repository.cjs");
const { createCanonFixture, inputFor } = require("./canon-record-validation.cjs");

/** 실제 schema에서 모든 Canon 소유 테이블을 찾아 삭제 목록 누락을 독립적으로 검사한다. */
function scopedTables() {
  const db = getDatabase();
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => name).filter((name) => db.prepare(`PRAGMA table_info("${name}")`).all().some((column) => column.name === "canon_space_id"));
}

/** DB 전체 행을 보관하여 rollback 및 Canon 외의 데이터 보존을 검사한다. */
function databaseSnapshot() {
  const db = getDatabase();
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

/** 002의 14개 Legacy 테이블 모두에 실제 FK로 연결된 15행을 채운다. */
function populateLegacyCanon(canonSpaceId) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const ids = Object.fromEntries(["world", "location", "organization", "first", "second", "attribute", "skill", "passive"].map((key) => [key, randomUUID()]));
  db.prepare("INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)").run(ids.world, canonSpaceId, "기존 세계", null, now, now);
  db.prepare("INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?)").run(ids.location, canonSpaceId, ids.world, "기존 지역", null, now, now);
  db.prepare("INSERT INTO organizations VALUES (?, ?, ?, ?, ?, ?, ?)").run(ids.organization, canonSpaceId, ids.location, "기존 조직", null, now, now);
  for (const key of ["first", "second"]) db.prepare("INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(ids[key], canonSpaceId, key, null, ids.world, ids.location, ids.location, ids.organization, now, now);
  db.prepare("INSERT INTO attributes VALUES (?, ?, ?, ?, ?, ?)").run(ids.attribute, canonSpaceId, "기존 속성", null, now, now);
  db.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)").run(ids.skill, canonSpaceId, "기존 스킬", null, now, now);
  db.prepare("INSERT INTO passives VALUES (?, ?, ?, ?, ?, ?, ?)").run(ids.passive, canonSpaceId, "기존 고유 패시브", "UNIQUE", null, now, now);
  db.prepare("INSERT INTO character_attributes VALUES (?, ?, ?)").run(canonSpaceId, ids.first, ids.attribute);
  db.prepare("INSERT INTO character_skills VALUES (?, ?, ?)").run(canonSpaceId, ids.first, ids.skill);
  db.prepare("INSERT INTO character_passives VALUES (?, ?, ?)").run(canonSpaceId, ids.first, ids.passive);
  db.prepare("INSERT INTO character_relationships VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), canonSpaceId, ids.first, ids.second, "ALLY", null, now, now);
  db.prepare("INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), canonSpaceId, ids.first, ids.second, "ACTIVE", now, null, now, now);
  db.prepare("INSERT INTO servants VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), canonSpaceId, ids.first, "기존 권속", "SPIRIT", null, now, now);
  db.prepare("INSERT INTO authorities VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), canonSpaceId, ids.first, ids.skill, "기존 권능", null, now, now);
}

/** 임시 DB에 Generic/Legacy 단독 또는 혼합 Canon을 만들어 모든 삭제 계층을 채운다. */
function createDeletionFixture({ generic = true, legacy = true, title = "Canon 삭제 검증 작품" } = {}) {
  const scope = generic ? createCanonFixture() : null;
  const workId = scope ? getDatabase().prepare("SELECT work_id FROM canon_spaces WHERE id = ?").get(scope.world.canonSpaceId).work_id : works.createWork({ title }).id;
  works.updateWork(workId, { title });
  const space = scope ? canon.getCanonSpaceByWorkId(workId) : canon.createCanonSpaceForWork(workId);
  if (scope) {
    const world = records.create(scope.world, inputFor(scope.world, "삭제 검증 세계", { description: "원본 설명" }));
    records.create(scope.location, inputFor(scope.location, "삭제 검증 지역", { world: world.id }));
    const option = canon.getCanonDefinitionBySetId(scope.passive.setId).fields.find((field) => field.key === "passive_type").options[0].id;
    records.create(scope.passive, inputFor(scope.passive, "삭제 검증 패시브", { passive_type: option }));
  }
  if (legacy) populateLegacyCanon(space.id);
  return { workId, space, scope };
}

/** 예상 오류 code와 한국어 메시지가 유지되는지 확인한다. */
function expectError(action, code) {
  assert.throws(action, (error) => error.code === code && /[가-힣]/.test(error.message));
}

/** 빈 공간부터 모든 FK 계층, 격리, 늦은 변경, rollback과 원고 보존까지 검증한다. */
function validateCanonDeletion(temporaryRoot) {
  const db = getDatabase();
  const tables = scopedTables();
  assert.equal(tables.length, 21, "Re-audit new Canon tables before extending deletion");
  // 실제 FK graph도 읽으며 테스트 fixture가 존재하는 부모와 연결되는지 검사한다.
  for (const table of tables) assert.ok(db.prepare(`PRAGMA foreign_key_list("${table}")`).all().every((fk) => fk.on_delete === "RESTRICT"));
  for (const action of [canon.getCanonDeletionStatus, canon.deleteCanonForWork]) {
    for (const id of [null, 42, "", " "]) expectError(() => action(id), "WORK_ID_REQUIRED");
    expectError(() => action("missing-work"), "WORK_NOT_FOUND");
  }
  const emptyWork = works.createWork({ title: "빈 Canon 삭제 검증" });
  assert.equal(canon.getCanonDeletionStatus(emptyWork.id).exists, false);
  assert.equal(canon.getCanonDeletionStatus(emptyWork.id).totalDependentRowCount, 0);
  expectError(() => canon.deleteCanonForWork(emptyWork.id), "CANON_SPACE_NOT_FOUND");
  const empty = canon.createCanonSpaceForWork(emptyWork.id);
  assert.equal(canon.getCanonDeletionStatus(emptyWork.id).totalDependentRowCount, 0);
  assert.deepEqual(canon.deleteCanonForWork(emptyWork.id), { workId: emptyWork.id, deletedCanonSpaceId: empty.id });
  assert.deepEqual(works.getWorkById(emptyWork.id), emptyWork);
  assert.equal(works.getWorkDeletionStatus(emptyWork.id).canDelete, true);
  expectError(() => canon.deleteCanonForWork(emptyWork.id), "CANON_SPACE_NOT_FOUND");
  const restarted = canon.createCanonSpaceForWork(emptyWork.id);
  assert.notEqual(restarted.id, empty.id);
  assert.equal(canon.getCanonDeletionStatus(emptyWork.id).setCount, 0);

  const other = createDeletionFixture({ title: "보존할 다른 작품" });
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run("task020-preserve", "변경하지 않을 설정", new Date().toISOString());
  const otherBefore = tables.map((table) => db.prepare(`SELECT * FROM "${table}" WHERE canon_space_id = ? ORDER BY rowid`).all(other.space.id));
  const settingsAndMigrations = [db.prepare("SELECT * FROM app_settings").all(), db.prepare("SELECT * FROM schema_migrations").all()];
  for (const [generic, legacy] of [[true, false], [false, true], [true, true]]) {
    const fixture = createDeletionFixture({ generic, legacy });
    const status = canon.getCanonDeletionStatus(fixture.workId);
    assert.deepEqual(status, {
      exists: true, canonSpaceId: fixture.space.id, referenceCount: generic ? 1 : 0,
      recordOptionValueCount: generic ? 1 : 0, fieldValueCount: generic ? 1 : 0,
      recordCount: generic ? 3 : 0, optionCount: generic ? 4 : 0, fieldCount: generic ? 30 : 0,
      setCount: generic ? 11 : 0, legacyDataCount: legacy ? 15 : 0,
      totalDependentRowCount: (generic ? 51 : 0) + (legacy ? 15 : 0),
    });
    const readSnapshot = databaseSnapshot();
    canon.getCanonDeletionStatus(fixture.workId);
    assert.deepEqual(databaseSnapshot(), readSnapshot, "Impact read must not write");
    // 영향 조회 후 추가된 Record/Legacy도 최종 transaction 범위에 포함되어야 한다.
    if (generic) records.create(fixture.scope.world, inputFor(fixture.scope.world, "조회 후 추가"));
    else db.prepare("INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), fixture.space.id, "조회 후 추가", null, "now", "now");
    const workBefore = works.getWorkById(fixture.workId);
    const episode = createEpisode({ workId: fixture.workId, episodeNumber: 1, title: "보존할 회차", storageKey: fixture.workId + "/episodes/001.txt" });
    const directory = path.join(temporaryRoot, "works", fixture.workId, "episodes");
    fs.mkdirSync(directory, { recursive: true });
    const txtPath = path.join(directory, "001.txt");
    const otherFilePath = path.join(directory, "notes.txt");
    fs.writeFileSync(txtPath, "원고 내용 유지", "utf8");
    fs.writeFileSync(otherFilePath, "다른 파일 유지", "utf8");
    const beforeFailure = databaseSnapshot();
    const failTable = legacy ? "worlds" : "canon_fields";
    db.exec(`CREATE TEMP TRIGGER fail_canon_delete AFTER DELETE ON ${failTable} BEGIN SELECT RAISE(FAIL, 'private middle delete failure'); END`);
    try { expectError(() => canon.deleteCanonForWork(fixture.workId), "CANON_DELETE_FAILED"); }
    finally { db.exec("DROP TRIGGER fail_canon_delete"); }
    assert.deepEqual(databaseSnapshot(), beforeFailure, "Partial deletes must rollback every table");
    canon.deleteCanonForWork(fixture.workId);
    for (const table of tables) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE canon_space_id = ?`).get(fixture.space.id).count, 0, table);
    assert.equal(canon.getCanonSpaceByWorkId(fixture.workId), null);
    assert.deepEqual(works.getWorkById(fixture.workId), workBefore);
    assert.equal(db.prepare("SELECT id FROM episodes WHERE id = ?").get(episode.id).id, episode.id);
    assert.equal(fs.readFileSync(txtPath, "utf8"), "원고 내용 유지");
    assert.equal(fs.readFileSync(otherFilePath, "utf8"), "다른 파일 유지");
    assert.deepEqual(works.getWorkDeletionStatus(fixture.workId), { canDelete: false, episodeCount: 1, hasCanonSpace: false });
    expectError(() => works.deleteWork(fixture.workId), "WORK_DELETE_BLOCKED_BY_EPISODES");
    expectError(() => canon.deleteCanonForWork(fixture.workId), "CANON_SPACE_NOT_FOUND");
  }
  assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM "${table}" WHERE canon_space_id = ? ORDER BY rowid`).all(other.space.id)), otherBefore);
  assert.deepEqual(canon.getCanonSpaceByWorkId(other.workId), other.space);
  assert.deepEqual([db.prepare("SELECT * FROM app_settings").all(), db.prepare("SELECT * FROM schema_migrations").all()], settingsAndMigrations);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Task020 Canon deletion: all 21 dependent tables, isolation, rollback, stale counts, Episode/TXT preservation passed.");
}

/** 양쪽 bridge, 동시 삭제, Work 삭제 충돌 및 한국어 오류/원본 은닉을 실제 handler로 검증한다. */
async function validateCanonDeletionIpc(ipcMain, runtimeApi) {
  const { createNovelCompanyApi } = require("../ipc/preload-api.cjs");
  const { IPC_CHANNELS } = require("../ipc/ipc-channels.cjs");
  const api = createNovelCompanyApi({
    /** Renderer API 계약을 실제 등록된 Main handler로 전달한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  for (const [method, channel] of [["getDeletionStatus", IPC_CHANNELS.CANON_SPACE_GET_DELETION_STATUS], ["deleteForWork", IPC_CHANNELS.CANON_SPACE_DELETE_FOR_WORK]]) {
    assert.deepEqual((await runtimeApi.canon.spaces[method]("work-id")).data, { channel, args: ["work-id"] });
    assert.deepEqual((await api.canon.spaces[method]("missing-work")).error, { code: "WORK_NOT_FOUND", message: "선택한 작품을 찾을 수 없습니다." });
  }
  const fixture = createDeletionFixture();
  assert.deepEqual((await api.canon.spaces.getDeletionStatus(fixture.workId)).data, canon.getCanonDeletionStatus(fixture.workId));
  // 테스트 DB의 읽기 오류도 원본 schema/SQL 정보를 Renderer에 노출하면 안 된다.
  getDatabase().exec("BEGIN IMMEDIATE; ALTER TABLE canon_field_values RENAME TO hidden_values_for_test");
  try { assert.deepEqual((await api.canon.spaces.getDeletionStatus(fixture.workId)).error, { code: "CANON_DELETE_STATUS_FAILED", message: "Canon 삭제 영향을 확인하지 못했습니다." }); }
  finally { getDatabase().exec("ROLLBACK"); }
  const before = databaseSnapshot();
  getDatabase().exec("CREATE TEMP TRIGGER fail_delete_ipc AFTER DELETE ON worlds BEGIN SELECT RAISE(FAIL, 'private SQL path'); END");
  try { assert.deepEqual((await api.canon.spaces.deleteForWork(fixture.workId)).error, { code: "CANON_DELETE_FAILED", message: "Canon을 삭제하는 중 오류가 발생했습니다." }); }
  finally { getDatabase().exec("DROP TRIGGER fail_delete_ipc"); }
  assert.deepEqual(databaseSnapshot(), before);
  const results = await Promise.all([api.canon.spaces.deleteForWork(fixture.workId), api.canon.spaces.deleteForWork(fixture.workId)]);
  assert.deepEqual(results[0], { ok: true, data: { workId: fixture.workId, deletedCanonSpaceId: fixture.space.id } });
  assert.deepEqual(results[1].error, { code: "CANON_SPACE_NOT_FOUND", message: "이 작품에는 삭제할 Canon이 없습니다." });
  assert.equal((await api.canon.spaces.getDeletionStatus(fixture.workId)).data.exists, false);
  // 같은 Main 연결에서 서로 다른 도착 순서 모두 안전한 최종 상태가 되어야 한다.
  for (const canonFirst of [true, false]) {
    const work = works.createWork({ title: "Work/Canon 삭제 순서 검증" });
    canon.createCanonSpaceForWork(work.id);
    const pair = canonFirst
      ? await Promise.all([api.canon.spaces.deleteForWork(work.id), api.works.delete(work.id)])
      : await Promise.all([api.works.delete(work.id), api.canon.spaces.deleteForWork(work.id)]);
    if (canonFirst) assert.ok(pair.every((result) => result.ok));
    else { assert.equal(pair[0].error.code, "WORK_DELETE_BLOCKED_BY_CANON"); assert.equal(pair[1].ok, true); }
  }
  const types = fs.readFileSync(path.join(__dirname, "../../src/types/electron-api.d.ts"), "utf8");
  assert.match(types, /getDeletionStatus\(workId: string\): Promise<IpcResult<CanonDeletionStatus>>/);
  assert.match(types, /deleteForWork\(workId: string\): Promise<IpcResult<CanonDeletionResult>>/);
  assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Task020 Canon deletion IPC validation passed.");
}

module.exports = { validateCanonDeletion, validateCanonDeletionIpc, createDeletionFixture };
