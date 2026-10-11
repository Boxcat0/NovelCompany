const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { getDatabase, initializeDatabase, closeDatabase } = require("../database.cjs");
const { getDatabaseFilePath } = require("../../storage/storage-paths.cjs");
const { RepositoryError } = require("../repositories/repository-error.cjs");
const { TASK016_CANON_SETS, CANON_SETS, INITIAL_WORK_TITLE, INITIAL_TEMPLATE_KEY } = require("./initial-canon-definition.cjs");
const { insertCanonDefinition, assertCompleteDefinition } = require("./setup-initial-novel-canon.cjs");
const { addCityDefinition } = require('./upgrade-city-canon-definition.cjs');

/** 지정 공간의 정의와 Record 개수를 실제 DB에서 읽어 설치 전후 검증에 사용한다. */
function getDefinitionCounts(db, canonSpaceId) {
  return Object.fromEntries([["sets", "canon_sets"], ["fields", "canon_fields"], ["options", "canon_field_options"], ["records", "canon_records"]].map(([name, table]) => [name, db.prepare("SELECT COUNT(*) count FROM " + table + " WHERE canon_space_id = ?").get(canonSpaceId).count]));
}

/** 명시한 작품의 빈 공간만 허용하고 기존 호출의 현재 작품 제한 및 부분 정의 보호를 유지한다. */
function assertEmptyCurrentWorkCanon(db, canonSpaceId, expectedWorkId = null) {
  if (typeof canonSpaceId !== "string" || !canonSpaceId.trim()) throw new RepositoryError("CANON_SCOPE_INVALID", "CanonSpace ID를 입력해 주세요.");
  const space = db.prepare("SELECT c.id, c.work_id, c.template_key, w.title FROM canon_spaces c JOIN works w ON w.id = c.work_id WHERE c.id = ?").get(canonSpaceId);
  if (!space) throw new RepositoryError("CANON_SPACE_NOT_FOUND", "작품에 연결된 CanonSpace를 찾을 수 없습니다.");
  if ((expectedWorkId === null ? space.title !== INITIAL_WORK_TITLE : typeof expectedWorkId !== 'string' || !expectedWorkId.trim() || space.work_id !== expectedWorkId) || space.template_key !== INITIAL_TEMPLATE_KEY) throw new RepositoryError("CANON_BOOTSTRAP_WORK_MISMATCH", "지정한 작품과 CanonSpace를 확인해 주세요. 다른 작품의 정의를 설치하지 않습니다.");
  const counts = getDefinitionCounts(db, canonSpaceId);
  if (Object.values(counts).some((count) => count !== 0)) throw new RepositoryError("CANON_BOOTSTRAP_NOT_EMPTY", "Canon 정의 또는 항목이 이미 있습니다. 부분 정의를 자동 병합하거나 덮어쓰지 않습니다.");
  return { canonSpaceId: space.id, workId: space.work_id, counts };
}

/** 대상 공간의 필수 정책을 정제하고 스킬 필요 속성만 추가하며 다른 공간은 변경하지 않는다. */
function refineInstalledDefinition(db, canonSpaceId) {
  const statement = db.prepare("UPDATE canon_fields SET required = ? WHERE canon_space_id = ? AND canon_set_id IN (SELECT id FROM canon_sets WHERE canon_space_id = ? AND key = ?) AND key = ?");
  for (const set of CANON_SETS) for (const field of set.fields) statement.run(Number(field[4]), canonSpaceId, canonSpaceId, set.key, field[0]);
  const skill = db.prepare("SELECT id FROM canon_sets WHERE canon_space_id = ? AND key = 'skill'").get(canonSpaceId);
  const attribute = db.prepare("SELECT id FROM canon_sets WHERE canon_space_id = ? AND key = 'attribute'").get(canonSpaceId);
  const field = CANON_SETS.find(set => set.key === 'skill').fields.find(item => item[0] === 'required_attribute');
  const now = new Date().toISOString();
  if (!db.prepare('SELECT id FROM canon_fields WHERE canon_set_id = ? AND key = ?').get(skill.id, field[0])) {
    db.prepare('INSERT INTO canon_fields (id, canon_space_id, canon_set_id, key, label, value_type, input_control, reference_set_id, required, help_text, sort_order, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE(MAX(sort_order), 0) + 1, ?, ? FROM canon_fields WHERE canon_set_id = ?')
      .run(randomUUID(), canonSpaceId, skill.id, field[0], field[1], field[2], field[3], attribute.id, Number(field[4]), now, now, skill.id);
  }
}

/** 백업 뒤 Task016 원본 정의를 설치하고 필요 속성·City를 같은 transaction에서 추가한다. */
function installCurrentWorkCanonDefinition(canonSpaceId, expectedWorkId = null) {
  const db = getDatabase();
  const before = assertEmptyCurrentWorkCanon(db, canonSpaceId, expectedWorkId);
  const dbFile = db.prepare("PRAGMA database_list").all().find((entry) => entry.name === "main").file;
  const backupDirectory = path.join(path.dirname(dbFile), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, "before-current-work-canon-bootstrap-" + randomUUID() + ".db");
  db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertEmptyCurrentWorkCanon(db, canonSpaceId, expectedWorkId);
    insertCanonDefinition(db, canonSpaceId, TASK016_CANON_SETS);
    assertCompleteDefinition(db, canonSpaceId, TASK016_CANON_SETS);
    const installed = getDefinitionCounts(db, canonSpaceId);
    if (installed.records !== 0 || installed.sets !== TASK016_CANON_SETS.length || installed.fields !== TASK016_CANON_SETS.reduce((sum, set) => sum + set.fields.length, 0) || installed.options !== TASK016_CANON_SETS.reduce((sum, set) => sum + set.fields.reduce((n, field) => n + (field[6]?.length ?? 0), 0), 0)) throw new Error("Installed definition count mismatch");
    refineInstalledDefinition(db, canonSpaceId);
    addCityDefinition(db, before);
    assertCompleteDefinition(db, canonSpaceId);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Foreign key validation failed");
    db.exec("COMMIT");
    return { ...before, before: before.counts, after: getDefinitionCounts(db, canonSpaceId), backupPath };
  } catch (cause) {
    db.exec("ROLLBACK");
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("CANON_BOOTSTRAP_FAILED", "Canon 정의를 설치하지 못했습니다. 변경사항은 취소되었습니다.", cause);
  }
}

/** 명시적 공간·작품 ID를 읽기 전용으로 사전 확인하고 기존 백업 정책으로 Definition만 설치한다. */
function runInstaller(canonSpaceId, expectedWorkId = null) {
  const databasePath = getDatabaseFilePath();
  const readonly = new DatabaseSync(databasePath, { readOnly: true });
  try { assertEmptyCurrentWorkCanon(readonly, canonSpaceId, expectedWorkId); } finally { readonly.close(); }
  try { initializeDatabase(databasePath); return installCurrentWorkCanonDefinition(canonSpaceId, expectedWorkId); }
  finally { closeDatabase(); }
}

if (require.main === module) {
  try {
    const explicitWork = process.argv.length === 6 && process.argv[2] === '--work' && process.argv[4] === '--canon-space';
    const currentWork = process.argv.length === 4 && process.argv[2] === '--canon-space';
    if (!explicitWork && !currentWork) throw new RepositoryError("CANON_SCOPE_INVALID", "--work <작품 ID> --canon-space <공간 ID> 또는 기존 --canon-space <공간 ID>를 지정해 주세요.");
    console.log(JSON.stringify(runInstaller(process.argv[explicitWork ? 5 : 3], explicitWork ? process.argv[3] : null), null, 2));
  } catch (error) { console.error(error instanceof RepositoryError ? error.code + ": " + error.message : "Canon 정의 설치를 준비하지 못했습니다. DB와 백업 위치를 확인해 주세요."); process.exitCode = 1; }
}

module.exports = { getDefinitionCounts, assertEmptyCurrentWorkCanon, refineInstalledDefinition, installCurrentWorkCanonDefinition, runInstaller };
