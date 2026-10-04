const { randomUUID } = require("node:crypto");
const { getDatabase } = require("../database.cjs");
const { getCanonDefinitionBySetId } = require("./canon-definition-repository.cjs");
const { RepositoryError } = require("./repository-error.cjs");

/** 조건 위반을 내부 정보 없는 한국어 Repository 오류로 전달한다. */
function check(condition, code, message) {
  if (!condition) throw new RepositoryError(code, message);
}

/** 빈 값과 잘못된 타입의 식별자가 SQL에 전달되지 않도록 검사한다. */
function requireId(value) {
  check(typeof value === "string" && value.trim().length > 0, "CANON_SCOPE_INVALID", "설정의 식별자가 올바르지 않습니다.");
  return value;
}

/** 요청 공간과 Set의 실제 소속을 확인하고 Field 정의를 반환한다. */
function requireDefinition(scope) {
  check(scope && typeof scope === "object", "CANON_SCOPE_INVALID", "설정의 범위를 확인해 주세요.");
  requireId(scope.canonSpaceId);
  const definition = getCanonDefinitionBySetId(requireId(scope.setId));
  check(definition, "CANON_SET_NOT_FOUND", "설정 분류를 찾을 수 없습니다.");
  check(definition.canonSpaceId === scope.canonSpaceId, "CANON_REFERENCE_SCOPE_MISMATCH", "다른 작품의 설정에 접근할 수 없습니다.");
  return definition;
}

/** DB 행을 Renderer용 레코드 메타데이터로 변환한다. */
function mapRecord(row) {
  return { id: row.id, canonSpaceId: row.canon_space_id, setId: row.canon_set_id, displayName: row.display_name, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** 검증한 공간과 Set 안의 레코드를 조회하고 기존 Skill의 속성 미설정 상태를 함께 제공한다. */
function getBySetId(scope) {
  const definition = requireDefinition(scope);
  const rows = getDatabase().prepare("SELECT * FROM canon_records WHERE canon_space_id = ? AND canon_set_id = ? ORDER BY display_name, id").all(scope.canonSpaceId, scope.setId);
  if (definition.key !== 'skill') return rows.map(mapRecord);
  const requiredField = definition.fields.find(field => field.key === 'required_attribute');
  const assigned = requiredField ? new Set(getDatabase().prepare("SELECT record_id FROM canon_record_references WHERE canon_space_id = ? AND field_id = ?").all(scope.canonSpaceId, requiredField.id).map(row => row.record_id)) : new Set();
  return rows.map(row => ({ ...mapRecord(row), requiredAttributeMissing: !assigned.has(row.id) }));
}

/** 레코드의 소속을 확인하고 scalar/option/reference 값을 Field ID별로 복원한다. */
function getById(scope, recordId) {
  const definition = requireDefinition(scope);
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM canon_records WHERE id = ? AND canon_space_id = ? AND canon_set_id = ?").get(requireId(recordId), scope.canonSpaceId, scope.setId);
  check(row, "CANON_RECORD_NOT_FOUND", "해당 설정 항목을 찾을 수 없습니다.");
  const fieldValues = {};
  for (const field of definition.fields) {
    if (field.valueType.startsWith("REFERENCE")) {
      const ids = db.prepare("SELECT target_record_id AS id FROM canon_record_references WHERE record_id = ? AND field_id = ? ORDER BY target_record_id").all(recordId, field.id).map((value) => value.id);
      fieldValues[field.id] = field.valueType.endsWith("MANY") ? ids : ids[0] ?? null;
    } else if (field.valueType.startsWith("OPTION")) {
      const ids = db.prepare("SELECT option_id AS id FROM canon_record_option_values WHERE record_id = ? AND field_id = ? ORDER BY option_id").all(recordId, field.id).map((value) => value.id);
      fieldValues[field.id] = field.valueType.endsWith("MANY") ? ids : ids[0] ?? null;
    } else {
      const value = db.prepare("SELECT * FROM canon_field_values WHERE record_id = ? AND field_id = ?").get(recordId, field.id);
      fieldValues[field.id] = !value ? null : field.valueType === "BOOLEAN" ? value.boolean_value === 1 : field.valueType === "NUMBER" ? value.number_value : value.text_value;
    }
  }
  return { ...mapRecord(row), fieldValues };
}

/** Character는 최소 세 참조만, 나머지는 필수 참조와 계약/관계의 2명 조건으로 준비 상태를 계산한다. */
function getCreateReadiness(scope) {
  const definition = requireDefinition(scope);
  const targets = new Map();
  for (const field of definition.fields) {
    const required = definition.key === "character" ? ["origin_location", "attributes", "passives"].includes(field.key) : field.required;
    if (!required || !field.referenceSet) continue;
    const requiredCount = ["contract", "relationship"].includes(definition.key) && field.referenceSet.key === "character" ? 2 : 1;
    targets.set(field.referenceSet.id, { targetSetId: field.referenceSet.id, targetSetName: field.referenceSet.name, requiredCount });
  }
  const blockers = [];
  for (const target of targets.values()) {
    const currentCount = getDatabase().prepare("SELECT COUNT(*) AS count FROM canon_records WHERE canon_space_id = ? AND canon_set_id = ?").get(scope.canonSpaceId, target.targetSetId).count;
    if (currentCount < target.requiredCount) blockers.push({ ...target, currentCount });
  }
  return { canCreate: blockers.length === 0, blockers };
}

/** 패시브 유형의 실제 Option 값과 표시명을 조회한다. */
function getPassiveType(recordId) {
  return getDatabase().prepare("SELECT o.value, o.label FROM canon_record_option_values v JOIN canon_fields f ON f.id = v.field_id JOIN canon_field_options o ON o.id = v.option_id WHERE v.record_id = ? AND f.key = 'passive_type'").get(recordId);
}

/** 캐릭터의 패시브 연결만 집계하여 소유 캐릭터 목록을 반환한다. */
function getPassiveOwners(recordId) {
  return getDatabase().prepare("SELECT DISTINCT r.id, r.display_name FROM canon_record_references ref JOIN canon_records r ON r.id = ref.record_id JOIN canon_sets s ON s.id = r.canon_set_id JOIN canon_fields f ON f.id = ref.field_id WHERE ref.target_record_id = ? AND s.key = 'character' AND f.key = 'passives'").all(recordId);
}

/** 실제 참조 대상과 고유 패시브 사용 상태를 조회하며 현재 편집자는 선택 가능하게 한다. */
function getReferenceOptions(scope, fieldId, editingRecordId = null) {
  const definition = requireDefinition(scope);
  const field = definition.fields.find((item) => item.id === requireId(fieldId));
  check(field?.referenceSet, "CANON_REFERENCE_INVALID", "참조 항목의 정의가 올바르지 않습니다.");
  if (editingRecordId !== null) getById(scope, editingRecordId);
  return getBySetId({ canonSpaceId: scope.canonSpaceId, setId: field.referenceSet.id }).map((record) => {
    const passiveType = field.referenceSet.key === "passive" ? getPassiveType(record.id) : null;
    const owners = passiveType?.value === "UNIQUE" ? getPassiveOwners(record.id) : [];
    const otherOwner = owners.find((owner) => owner.id !== editingRecordId);
    return { id: record.id, displayName: record.displayName, disabled: definition.key === "character" && field.key === "passives" && Boolean(otherOwner), description: passiveType ? passiveType.label + (otherOwner ? " · 사용 중: " + otherOwner.display_name : "") : null };
  });
}

/** Character 최소 선택과 Skill 기존 미설정 예외를 포함해 필수값·참조 소속을 검증한다. */
function validateInput(definition, input, allowLegacySkillMissing = false) {
  check(input && typeof input === "object" && typeof input.displayName === "string" && input.displayName.trim(), "CANON_REQUIRED_FIELD_MISSING", "이름을 입력해 주세요.");
  check(input.fieldValues && typeof input.fieldValues === "object" && !Array.isArray(input.fieldValues), "CANON_FIELD_VALUE_INVALID", "설정 항목의 입력값이 올바르지 않습니다.");
  const fields = new Map(definition.fields.map((field) => [field.id, field]));
  for (const id of Object.keys(input.fieldValues)) check(fields.has(id), "CANON_FIELD_VALUE_INVALID", "이 분류에 속하지 않는 입력 항목입니다.");
  validateCharacterRequirements(definition, input);
  for (const field of definition.fields) {
    const value = input.fieldValues[field.id];
    const missing = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    const legacySkillMissing = allowLegacySkillMissing && definition.key === 'skill' && field.key === 'required_attribute';
    check(!field.required || !missing || legacySkillMissing, "CANON_REQUIRED_FIELD_MISSING", "'" + field.label + "' 항목을 입력하거나 하나 이상 선택해 주세요.");
    if (missing && !Array.isArray(value) && value !== "") continue;
    const type = field.valueType;
    let valid = false;
    if (type === "TEXT" || type === "LONG_TEXT") valid = typeof value === "string" && (!field.required || value.trim().length > 0);
    else if (type === "NUMBER") valid = typeof value === "number" && Number.isFinite(value);
    else if (type === "BOOLEAN") valid = typeof value === "boolean";
    else valid = type.endsWith("MANY") ? Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0) && new Set(value).size === value.length : typeof value === "string" && value.length > 0;
    check(valid, "CANON_FIELD_VALUE_INVALID", "'" + field.label + "' 입력 형식을 확인해 주세요.");
    if (type.startsWith("OPTION")) {
      for (const id of Array.isArray(value) ? value : [value]) check(field.options.some((option) => option.id === id), "CANON_FIELD_VALUE_INVALID", "해당 항목에 없는 선택값입니다.");
    }
    if (type.startsWith("REFERENCE")) {
      for (const id of Array.isArray(value) ? value : [value]) {
        const target = getDatabase().prepare("SELECT canon_space_id, canon_set_id FROM canon_records WHERE id = ?").get(id);
        check(target, "CANON_REFERENCE_TARGET_NOT_FOUND", "참조할 설정 항목을 찾을 수 없습니다.");
        check(target.canon_space_id === definition.canonSpaceId, "CANON_REFERENCE_SCOPE_MISMATCH", "다른 작품의 설정을 참조할 수 없습니다.");
        check(target.canon_set_id === field.referenceSet.id, "CANON_REFERENCE_INVALID", "참조 대상의 분류가 올바르지 않습니다.");
      }
    }
  }
}

/** readiness와 별개로 Character의 출신 지역 및 속성/패시브 최소 선택을 저장마다 재검증한다. */
function validateCharacterRequirements(definition, input) {
  if (definition.key !== "character") return;
  for (const [key, targetKey, type] of [["origin_location", "location", "REFERENCE_ONE"], ["attributes", "attribute", "REFERENCE_MANY"], ["passives", "passive", "REFERENCE_MANY"]]) {
    const field = definition.fields.find((item) => item.key === key);
    check(field?.referenceSet?.key === targetKey && field.valueType === type, "CANON_REFERENCE_INVALID", "캐릭터 필수 참조 정의를 확인해 주세요.");
    const value = input.fieldValues[field.id];
    check(type === "REFERENCE_ONE" ? typeof value === "string" && value.length > 0 : Array.isArray(value) && value.length > 0, "CANON_REQUIRED_FIELD_MISSING", "'" + field.label + "' 항목을 입력하거나 하나 이상 선택해 주세요.");
  }
}

/** 저장된 레코드에서 의미 검증에 필요한 Field key별 값을 읽는다. */
function valuesByKey(definition, record) {
  return Object.fromEntries(definition.fields.map((field) => [field.key, record.fieldValues[field.id]]));
}

/** 고유 패시브 중복 및 공유 중인 공용 패시브의 유형 변경을 차단한다. */
function validatePassiveOwnership(definition, record, values) {
  if (definition.key === "character") {
    for (const id of values.passives ?? []) {
      check(getPassiveType(id)?.value !== "UNIQUE" || !getPassiveOwners(id).some((owner) => owner.id !== record.id), "CANON_UNIQUE_PASSIVE_IN_USE", "다른 캐릭터가 사용 중인 고유 패시브는 선택할 수 없습니다.");
    }
  }
  if (definition.key === "passive") check(getPassiveType(record.id)?.value !== "UNIQUE" || getPassiveOwners(record.id).length <= 1, "CANON_PASSIVE_TYPE_CHANGE_BLOCKED", "여러 캐릭터가 사용 중인 패시브는 고유 패시브로 변경할 수 없습니다.");
}

/** 출신 세계를 입력한 경우만 지역의 세계와 비교하고 소유 및 자기 계약/관계 금지를 검사한다. */
function validateSemantics(definition, record) {
  const values = valuesByKey(definition, record);
  validatePassiveOwnership(definition, record, values);
  if (definition.key === "character" && values.origin_location && values.origin_world) {
    const world = getDatabase().prepare("SELECT ref.target_record_id FROM canon_record_references ref JOIN canon_fields f ON f.id = ref.field_id WHERE ref.record_id = ? AND f.key = 'world'").get(values.origin_location);
    check(world?.target_record_id === values.origin_world, "CANON_ORIGIN_LOCATION_WORLD_MISMATCH", "출신 지역의 세계가 출신 세계와 일치하지 않습니다.");
  }
  if (definition.key === "location") {
    const dependents = getDatabase().prepare("SELECT r.id, r.canon_set_id FROM canon_record_references ref JOIN canon_fields f ON f.id = ref.field_id JOIN canon_records r ON r.id = ref.record_id JOIN canon_sets s ON s.id = r.canon_set_id WHERE ref.target_record_id = ? AND f.key = 'origin_location' AND s.key = 'character'").all(record.id);
    for (const dependent of dependents) {
      const scope = { canonSpaceId: definition.canonSpaceId, setId: dependent.canon_set_id };
      validateSemantics(requireDefinition(scope), getById(scope, dependent.id));
    }
  }
  const pair = definition.key === "contract" ? [values.grantor_character, values.grantee_character] : definition.key === "relationship" ? [values.source_character, values.target_character] : null;
  if (pair) check(!pair[0] || pair[0] !== pair[1], "CANON_SELF_REFERENCE_INVALID", "서로 다른 캐릭터를 선택해 주세요.");
}

/** 레코드의 모든 값과 외부로 향하는 참조를 지워 전체 교체/삭제를 준비한다. */
function clearValues(recordId) {
  const db = getDatabase();
  db.prepare("DELETE FROM canon_field_values WHERE record_id = ?").run(recordId);
  db.prepare("DELETE FROM canon_record_option_values WHERE record_id = ?").run(recordId);
  db.prepare("DELETE FROM canon_record_references WHERE record_id = ?").run(recordId);
}

/** 검증된 입력을 scalar, option, reference 저장소에 나누어 기록한다. */
function writeValues(definition, recordId, input) {
  const db = getDatabase();
  for (const field of definition.fields) {
    const value = input.fieldValues[field.id];
    if (value === null || value === undefined) continue;
    const prefix = [definition.canonSpaceId, definition.id, recordId, field.id];
    if (field.valueType.startsWith("REFERENCE")) {
      for (const id of Array.isArray(value) ? value : [value]) db.prepare("INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)").run(...prefix, field.referenceSet.id, id);
    } else if (field.valueType.startsWith("OPTION")) {
      for (const id of Array.isArray(value) ? value : [value]) db.prepare("INSERT INTO canon_record_option_values VALUES (?, ?, ?, ?, ?)").run(...prefix, id);
    } else db.prepare("INSERT INTO canon_field_values VALUES (?, ?, ?, ?, ?, ?, ?)").run(...prefix, typeof value === "string" ? value : null, typeof value === "number" ? value : null, typeof value === "boolean" ? Number(value) : null);
  }
}

/** 쓰기 전체를 즉시 잠금 transaction으로 보호하고 예외 시 모든 변경을 되돌린다. */
function withTransaction(action, code, message) {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError(code, message, error);
  }
}

/** 생성/수정을 한 transaction으로 수행하며 업그레이드 전 Skill 미설정 상태만 수정 시 보존한다. */
function saveRecord(scope, input, recordId = null) {
  return withTransaction(() => {
    const definition = requireDefinition(scope);
    const existing = recordId !== null ? getById(scope, recordId) : null;
    if (definition.key === 'skill') {
      const attributeField = definition.fields.find(field => field.key === 'required_attribute');
      check(attributeField?.valueType === 'REFERENCE_ONE' && attributeField.referenceSet?.key === 'attribute' && attributeField.required, 'CANON_REFERENCE_INVALID', '스킬의 필요 속성 정의를 확인해 주세요.');
    }
    if (recordId === null) check(getCreateReadiness(scope).canCreate, "CANON_CREATE_PREREQUISITE_MISSING", "등록에 필요한 선행 설정을 먼저 등록해 주세요.");
    const attributeField = definition.key === 'skill' ? definition.fields.find(field => field.key === 'required_attribute') : null;
    const allowLegacySkillMissing = Boolean(existing && attributeField && existing.fieldValues[attributeField.id] === null);
    validateInput(definition, input, allowLegacySkillMissing);
    const id = recordId ?? randomUUID();
    const now = new Date().toISOString();
    if (recordId !== null) {
      getDatabase().prepare("UPDATE canon_records SET display_name = ?, updated_at = ? WHERE id = ?").run(input.displayName.trim(), now, id);
      clearValues(id);
    } else getDatabase().prepare("INSERT INTO canon_records VALUES (?, ?, ?, ?, ?, ?)").run(id, scope.canonSpaceId, scope.setId, input.displayName.trim(), now, now);
    writeValues(definition, id, input);
    const result = getById(scope, id);
    validateSemantics(definition, result);
    return result;
  }, recordId === null ? "CANON_RECORD_CREATE_FAILED" : "CANON_RECORD_UPDATE_FAILED", "설정 항목을 저장하지 못했습니다.");
}

/** 새 레코드와 입력값을 원자적으로 생성한다. */
function create(scope, input) { return saveRecord(scope, input); }

/** 지정 레코드의 전체 입력값을 원자적으로 교체한다. */
function update(scope, recordId, input) { return saveRecord(scope, input, requireId(recordId)); }

/** 다른 레코드가 참조하는 항목은 보존하고 나머지는 값과 함께 원자적으로 삭제한다. */
function deleteRecord(scope, recordId) {
  return withTransaction(() => {
    getById(scope, recordId);
    check(!getDatabase().prepare("SELECT 1 FROM canon_record_references WHERE target_record_id = ? AND record_id != ? LIMIT 1").get(recordId, recordId), "CANON_RECORD_IN_USE", "다른 Canon 설정에서 사용 중인 항목이므로 삭제할 수 없습니다.");
    clearValues(recordId);
    getDatabase().prepare("DELETE FROM canon_records WHERE id = ?").run(recordId);
    return { id: recordId };
  }, "CANON_RECORD_DELETE_FAILED", "설정 항목을 삭제하지 못했습니다.");
}

module.exports = { getBySetId, getById, getCreateReadiness, getReferenceOptions, create, update, delete: deleteRecord };
