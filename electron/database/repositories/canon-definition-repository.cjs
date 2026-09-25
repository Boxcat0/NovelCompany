const { getDatabase } = require("../database.cjs");
const { RepositoryError } = require("./repository-error.cjs");

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

module.exports = { getCanonDefinitionBySetId, getCanonSetsByCanonSpaceId, getCanonSpaceByWorkId };
