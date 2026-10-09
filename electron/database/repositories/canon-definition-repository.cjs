const { getDatabase } = require("../database.cjs");
const { randomUUID } = require("node:crypto");
const { RepositoryError } = require("./repository-error.cjs");

// Migration 003의 자식 → 부모 순서. Field의 reference_set_id도 Set보다 먼저 제거한다.
const genericDeletionTables = Object.freeze([
  ["canon_record_references", "referenceCount"],
  ["canon_record_option_values", "recordOptionValueCount"],
  ["canon_field_values", "fieldValueCount"],
  ["canon_records", "recordCount"],
  ["canon_field_options", "optionCount"],
  ["canon_fields", "fieldCount"],
  ["canon_sets", "setCount"],
]);
// Migration 002: junction/소유 관계 → Character → Organization → Location → World.
const legacyDeletionTables = Object.freeze([
  "character_attributes", "character_skills", "character_passives", "character_relationships",
  "contracts", "servants", "authorities", "characters", "organizations", "locations",
  "worlds", "attributes", "skills", "passives",
]);

/**
 * 필수 ID를 확인해 Definition 조회가 빈 식별자로 실행되지 않게 한다.
 */
function requireId(id, code, message) {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new RepositoryError(code, message);
  }
  return id;
}

/**
 * Work에 연결된 CanonSpace metadata를 반환하며 없으면 null을 반환한다.
 */
function getCanonSpaceByWorkId(workId) {
  const row = getDatabase().prepare("SELECT id, work_id, template_key, created_at, updated_at FROM canon_spaces WHERE work_id = ?").get(requireId(workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요."));
  return row ? { id: row.id, workId: row.work_id, templateKey: row.template_key, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

/**
 * CanonSpace의 Set 목록을 정렬 순서대로 반환한다.
 */
function getCanonSetsByCanonSpaceId(canonSpaceId) {
  return getDatabase().prepare("SELECT id, canon_space_id, key, name, record_name_label, description, sort_order, created_at, updated_at FROM canon_sets WHERE canon_space_id = ? ORDER BY sort_order, id").all(requireId(canonSpaceId, "CANON_SPACE_ID_REQUIRED", "CanonSpace ID를 입력해 주세요.")).map((row) => ({ id: row.id, canonSpaceId: row.canon_space_id, key: row.key, name: row.name, recordNameLabel: row.record_name_label, description: row.description, sortOrder: row.sort_order }));
}

/**
 * Set과 Field, Option, 참조 대상 Set 정보를 하나의 읽기 모델로 반환한다.
 */
function getCanonDefinitionBySetId(setId) {
  const database = getDatabase();
  const set = database.prepare("SELECT id, canon_space_id, key, name, record_name_label, description, sort_order FROM canon_sets WHERE id = ?").get(requireId(setId, "CANON_SET_ID_REQUIRED", "Canon Set ID를 입력해 주세요."));
  if (!set) return null;
  const fields = database.prepare("SELECT f.id, f.key, f.label, f.value_type, f.input_control, f.required, f.help_text, f.sort_order, r.id AS reference_set_id, r.key AS reference_set_key, r.name AS reference_set_name FROM canon_fields f LEFT JOIN canon_sets r ON r.id = f.reference_set_id WHERE f.canon_set_id = ? ORDER BY f.sort_order, f.id").all(set.id).map((field) => ({ id: field.id, key: field.key, label: field.label, valueType: field.value_type, inputControl: field.input_control, required: field.required === 1, helpText: field.help_text, sortOrder: field.sort_order, referenceSet: field.reference_set_id ? { id: field.reference_set_id, key: field.reference_set_key, name: field.reference_set_name } : null, options: database.prepare("SELECT id, value, label, sort_order FROM canon_field_options WHERE field_id = ? ORDER BY sort_order, id").all(field.id).map((option) => ({ id: option.id, value: option.value, label: option.label, sortOrder: option.sort_order })) }));
  return { id: set.id, canonSpaceId: set.canon_space_id, key: set.key, name: set.name, recordNameLabel: set.record_name_label, description: set.description, sortOrder: set.sort_order, fields };
}

/** 작품과 중복 여부를 쓰기 트랜잭션 안에서 확인하고 빈 CanonSpace 한 행만 생성한다. */
function createCanonSpaceForWork(workId) {
  requireId(workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  const database = getDatabase();
  let started = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    started = true;
    if (!database.prepare("SELECT id FROM works WHERE id = ?").get(workId)) {
      throw new RepositoryError("WORK_NOT_FOUND", "선택한 작품을 찾을 수 없습니다.");
    }
    if (getCanonSpaceByWorkId(workId)) {
      throw new RepositoryError("CANON_SPACE_ALREADY_EXISTS", "이 작품의 Canon은 이미 시작되어 있습니다.");
    }
    const now = new Date().toISOString();
    // 기존 CHECK와 호환되는 metadata이며 Set/Field 생성이나 preset 선택을 의미하지 않는다.
    database.prepare("INSERT INTO canon_spaces (id, work_id, template_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), workId, "MODERN_FANTASY_V1", now, now);
    const space = getCanonSpaceByWorkId(workId);
    database.exec("COMMIT");
    return space;
  } catch (cause) {
    if (started) database.exec("ROLLBACK");
    if (cause instanceof RepositoryError) throw cause;
    if (cause.errcode === 2067 && cause.message.includes("canon_spaces.work_id")) {
      throw new RepositoryError("CANON_SPACE_ALREADY_EXISTS", "이 작품의 Canon은 이미 시작되어 있습니다.", cause);
    }
    throw new RepositoryError("CANON_SPACE_CREATE_FAILED", "Canon을 생성하는 중 오류가 발생했습니다.", cause);
  }
}

/** 한 SELECT의 일관된 snapshot으로 작품 존재와 Generic/Legacy 전체 삭제 영향을 집계한다. */
function getCanonDeletionStatus(workId) {
  requireId(workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  try {
    // 테이블/별칭은 위 고정 목록에서만 오며 Renderer 입력은 workId bind 값뿐이다.
    const genericCounts = genericDeletionTables.map(([table, key]) => `(SELECT COUNT(*) FROM ${table} WHERE canon_space_id = c.id) AS ${key}`);
    const legacyCount = legacyDeletionTables.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE canon_space_id = c.id)`).join(" + ");
    const row = getDatabase().prepare(`SELECT c.id AS canonSpaceId, ${genericCounts.join(", ")},
      (SELECT COUNT(*) FROM canon_record_aliases a JOIN canon_records r ON r.id = a.canon_record_id WHERE r.canon_space_id = c.id) AS aliasCount,
      (${legacyCount}) AS legacyDataCount
      FROM works w LEFT JOIN canon_spaces c ON c.work_id = w.id WHERE w.id = ?`).get(workId);
    if (!row) throw new RepositoryError("WORK_NOT_FOUND", "선택한 작품을 찾을 수 없습니다.");
    const counts = Object.fromEntries(genericDeletionTables.map(([, key]) => [key, row[key]]));
    return {
      exists: row.canonSpaceId !== null,
      canonSpaceId: row.canonSpaceId,
      ...counts,
      legacyDataCount: row.legacyDataCount,
      aliasCount: row.aliasCount,
      totalDependentRowCount: Object.values(counts).reduce((total, count) => total + count, row.legacyDataCount + row.aliasCount),
    };
  } catch (cause) {
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("CANON_DELETE_STATUS_FAILED", "Canon 삭제 영향을 확인하지 못했습니다.", cause);
  }
}

/** 같은 공간의 참조/값을 먼저 지우고 Record, Option, Field, Set 순서로 제거한다. */
function deleteGenericCanonData(database, canonSpaceId) {
  for (const [table] of genericDeletionTables) {
    database.prepare(`DELETE FROM ${table} WHERE canon_space_id = ?`).run(canonSpaceId);
  }
}

/** 같은 공간의 Legacy 연결과 소유 데이터를 먼저 지우고 참조 대상 엔티티를 제거한다. */
function deleteLegacyCanonData(database, canonSpaceId) {
  for (const table of legacyDeletionTables) {
    database.prepare(`DELETE FROM ${table} WHERE canon_space_id = ?`).run(canonSpaceId);
  }
}

/** 작품과 최신 Canon 범위를 재검증하고 전체 Canon만 한 transaction으로 삭제한다. */
function deleteCanonForWork(workId) {
  requireId(workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  const database = getDatabase();
  let started = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    started = true;
    const status = getCanonDeletionStatus(workId);
    if (!status.exists) throw new RepositoryError("CANON_SPACE_NOT_FOUND", "이 작품에는 삭제할 Canon이 없습니다.");
    deleteGenericCanonData(database, status.canonSpaceId);
    deleteLegacyCanonData(database, status.canonSpaceId);
    database.prepare("DELETE FROM canon_spaces WHERE id = ? AND work_id = ?").run(status.canonSpaceId, workId);
    database.exec("COMMIT");
    return { workId, deletedCanonSpaceId: status.canonSpaceId };
  } catch (cause) {
    if (started) database.exec("ROLLBACK");
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("CANON_DELETE_FAILED", "Canon을 삭제하는 중 오류가 발생했습니다.", cause);
  }
}

module.exports = { createCanonSpaceForWork, getCanonDefinitionBySetId, getCanonSetsByCanonSpaceId, getCanonSpaceByWorkId, getCanonDeletionStatus, deleteCanonForWork };
