const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { initializeDatabase, closeDatabase } = require("./database.cjs");
const { createWork } = require("./repositories/work-repository.cjs");
const { createCanonSpaceForWork } = require("./repositories/canon-definition-repository.cjs");
const { INITIAL_WORK_TITLE, TASK016_CANON_SETS } = require("./setup/initial-canon-definition.cjs");
const { getDefinitionCounts, installCurrentWorkCanonDefinition: install } = require("./setup/install-current-work-canon.cjs");

/** 분리된 DB에서 Bootstrap의 빈 상태 방어·실패 rollback·정확한 정의 복원과 백업을 검증한다. */
function validateCanonBootstrap(root) {
  const file = path.join(root, "bootstrap", "novelcompany.db");
  const db = initializeDatabase(file);
  try {
    const work = createWork({ title: INITIAL_WORK_TITLE });
    const space = createCanonSpaceForWork(work.id);
    const spaceBefore = db.prepare("SELECT * FROM canon_spaces WHERE id=?").get(space.id);
    const workBefore = db.prepare("SELECT * FROM works WHERE id=?").get(work.id);
    assert.throws(() => install("missing"), { code: "CANON_SPACE_NOT_FOUND" });
    const foreign = createCanonSpaceForWork(createWork({ title: "별도 임시 작품" }).id);
    assert.throws(() => install(foreign.id), { code: "CANON_BOOTSTRAP_WORK_MISMATCH" });
    db.exec("CREATE TEMP TRIGGER fail_bootstrap BEFORE INSERT ON canon_fields BEGIN SELECT RAISE(ABORT, 'forced bootstrap failure'); END");
    assert.throws(() => install(space.id), { code: "CANON_BOOTSTRAP_FAILED" });
    assert.deepEqual(getDefinitionCounts(db, space.id), { sets: 0, fields: 0, options: 0, records: 0 });
    db.exec("DROP TRIGGER fail_bootstrap");
    // 부분 정의에서는 자동 병합하지 않으며 기존 행을 보존한다.
    db.prepare("INSERT INTO canon_sets VALUES ('partial', ?, 'world', '세계', '세계 이름', NULL, 1, 'test', 'test')").run(space.id);
    assert.throws(() => install(space.id), { code: "CANON_BOOTSTRAP_NOT_EMPTY" });
    assert.equal(getDefinitionCounts(db, space.id).sets, 1);
    db.exec("DELETE FROM canon_sets WHERE id = 'partial'");
    const result = install(space.id);
    assert.deepEqual(result.after, { sets: 11, fields: 30, options: 4, records: 0 });
    assert.deepEqual(db.prepare("SELECT * FROM canon_spaces WHERE id=?").get(space.id), spaceBefore);
    assert.deepEqual(db.prepare("SELECT * FROM works WHERE id=?").get(work.id), workBefore);
    assert.deepEqual(db.prepare("SELECT key FROM canon_sets WHERE canon_space_id=? ORDER BY sort_order").all(space.id).map((row) => row.key), TASK016_CANON_SETS.map((set) => set.key));
    const backup = new DatabaseSync(result.backupPath, { readOnly: true });
    try { assert.deepEqual(getDefinitionCounts(backup, space.id), result.before); } finally { backup.close(); }
    const countBeforeRepeat = fs.readdirSync(path.dirname(result.backupPath)).length;
    assert.throws(() => install(space.id), { code: "CANON_BOOTSTRAP_NOT_EMPTY" });
    assert.equal(fs.readdirSync(path.dirname(result.backupPath)).length, countBeforeRepeat);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    console.log("Task022 explicit Bootstrap: initial 11/30/4, zero records, partial guard, rollback and backup passed.");
  } finally { closeDatabase(); }
}

module.exports = { validateCanonBootstrap };
