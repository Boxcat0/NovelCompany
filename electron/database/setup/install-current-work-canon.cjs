const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { getDatabase, initializeDatabase, closeDatabase } = require("../database.cjs");
const { getDatabaseFilePath } = require("../../storage/storage-paths.cjs");
const { RepositoryError } = require("../repositories/repository-error.cjs");
const { TASK016_CANON_SETS, CANON_SETS, INITIAL_WORK_TITLE, INITIAL_TEMPLATE_KEY } = require("./initial-canon-definition.cjs");
const { insertCanonDefinition, assertCompleteDefinition } = require("./setup-initial-novel-canon.cjs");

/** 지정 공간의 정의와 Record 개수를 실제 DB에서 읽어 설치 전후 검증에 사용한다. */
function getDefinitionCounts(db, canonSpaceId) {
  return Object.fromEntries([["sets", "canon_sets"], ["fields", "canon_fields"], ["options", "canon_field_options"], ["records", "canon_records"]].map(([name, table]) => [name, db.prepare("SELECT COUNT(*) count FROM " + table + " WHERE canon_space_id = ?").get(canonSpaceId).count]));
}

/** 현재 작품의 기존 빈 공간만 허용하고 부분 정의나 이미 설치된 공간의 자동 병합을 거부한다. */
function assertEmptyCurrentWorkCanon(db, canonSpaceId) {
  if (typeof canonSpaceId !== "string" || !canonSpaceId.trim()) throw new RepositoryError("CANON_SCOPE_INVALID", "CanonSpace ID를 입력해 주세요.");
  const space = db.prepare("SELECT c.id, c.work_id, c.template_key, w.title FROM canon_spaces c JOIN works w ON w.id = c.work_id WHERE c.id = ?").get(canonSpaceId);
  if (!space) throw new RepositoryError("CANON_SPACE_NOT_FOUND", "작품에 연결된 CanonSpace를 찾을 수 없습니다.");
  if (space.title !== INITIAL_WORK_TITLE || space.template_key !== INITIAL_TEMPLATE_KEY) throw new RepositoryError("CANON_BOOTSTRAP_WORK_MISMATCH", "이 복구 도구는 현재 작품의 기존 CanonSpace에만 사용할 수 있습니다.");
  const counts = getDefinitionCounts(db, canonSpaceId);
  if (Object.values(counts).some((count) => count !== 0)) throw new RepositoryError("CANON_BOOTSTRAP_NOT_EMPTY", "Canon 정의 또는 항목이 이미 있습니다. 부분 정의를 자동 병합하거나 덮어쓰지 않습니다.");
  return { canonSpaceId: space.id, workId: space.work_id, counts };
}

/** 설치된 초기 정의의 required만 현재 합의로 정제하고 Set/Field ID와 참조를 유지한다. */
function refineInstalledDefinition(db, canonSpaceId) {
  const statement = db.prepare("UPDATE canon_fields SET required = ? WHERE canon_space_id = ? AND canon_set_id IN (SELECT id FROM canon_sets WHERE canon_space_id = ? AND key = ?) AND key = ?");
  for (const set of CANON_SETS) for (const field of set.fields) statement.run(Number(field[4]), canonSpaceId, canonSpaceId, set.key, field[0]);
}

/** 백업 뒤 빈 상태를 transaction 안에서 다시 확인하고 Task016 정의 설치와 required 정제를 원자적으로 수행한다. */
function installCurrentWorkCanonDefinition(canonSpaceId) {
  const db = getDatabase();
  const before = assertEmptyCurrentWorkCanon(db, canonSpaceId);
  const dbFile = db.prepare("PRAGMA database_list").all().find((entry) => entry.name === "main").file;
  const backupDirectory = path.join(path.dirname(dbFile), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, "before-current-work-canon-bootstrap-" + randomUUID() + ".db");
  db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertEmptyCurrentWorkCanon(db, canonSpaceId);
    insertCanonDefinition(db, canonSpaceId, TASK016_CANON_SETS);
    assertCompleteDefinition(db, canonSpaceId, TASK016_CANON_SETS);
    const installed = getDefinitionCounts(db, canonSpaceId);
    if (installed.records !== 0 || installed.sets !== TASK016_CANON_SETS.length || installed.fields !== TASK016_CANON_SETS.reduce((sum, set) => sum + set.fields.length, 0) || installed.options !== TASK016_CANON_SETS.reduce((sum, set) => sum + set.fields.reduce((n, field) => n + (field[6]?.length ?? 0), 0), 0)) throw new Error("Installed definition count mismatch");
    refineInstalledDefinition(db, canonSpaceId);
    assertCompleteDefinition(db, canonSpaceId);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Foreign key validation failed");
    db.exec("COMMIT");
    return { ...before, before: before.counts, after: installed, backupPath };
  } catch (cause) {
    db.exec("ROLLBACK");
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("CANON_BOOTSTRAP_FAILED", "Canon 정의를 설치하지 못했습니다. 변경사항은 취소되었습니다.", cause);
  }
}

/** 명시적 공간 ID를 받아 읽기 전용 사전 점검 후 기존 migration과 백업 정책으로 설치한다. */
function runInstaller(canonSpaceId) {
  const databasePath = getDatabaseFilePath();
  const readonly = new DatabaseSync(databasePath, { readOnly: true });
  try { assertEmptyCurrentWorkCanon(readonly, canonSpaceId); } finally { readonly.close(); }
  try { initializeDatabase(databasePath); return installCurrentWorkCanonDefinition(canonSpaceId); }
  finally { closeDatabase(); }
}

if (require.main === module) {
  try {
    if (process.argv[2] !== "--canon-space" || !process.argv[3] || process.argv.length !== 4) throw new RepositoryError("CANON_SCOPE_INVALID", "--canon-space 뒤에 설치할 CanonSpace ID를 지정해 주세요.");
    console.log(JSON.stringify(runInstaller(process.argv[3]), null, 2));
  } catch (error) { console.error(error instanceof RepositoryError ? error.code + ": " + error.message : "Canon 정의 설치를 준비하지 못했습니다. DB와 백업 위치를 확인해 주세요."); process.exitCode = 1; }
}

module.exports = { getDefinitionCounts, assertEmptyCurrentWorkCanon, refineInstalledDefinition, installCurrentWorkCanonDefinition, runInstaller };
