const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { getDatabase } = require("./database.cjs");
const { CANON_SETS } = require("./setup/setup-initial-novel-canon.cjs");
const { createWork } = require("./repositories/work-repository.cjs");
const definitions = require("./repositories/canon-definition-repository.cjs");
const records = require("./repositories/canon-record-repository.cjs");

/** 호출자가 연 임시 DB에만 템플릿 정의를 만들고 테스트용 scope를 반환한다. */
function createCanonFixture() {
  const db = getDatabase();
  const work = createWork({ title: "임시 검증 작품" });
  const canonSpaceId = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)").run(canonSpaceId, work.id, "MODERN_FANTASY_V1", now, now);
  const setIds = Object.fromEntries(CANON_SETS.map((set) => [set.key, randomUUID()]));
  for (const [index, set] of CANON_SETS.entries()) db.prepare("INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(setIds[set.key], canonSpaceId, set.key, set.name, set.recordNameLabel, null, index, now, now);
  for (const set of CANON_SETS) {
    for (const [index, field] of set.fields.entries()) {
      const id = randomUUID();
      db.prepare("INSERT INTO canon_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, canonSpaceId, setIds[set.key], field[0], field[1], field[2], field[3], field[5] ? setIds[field[5]] : null, Number(field[4]), null, index, now, now);
      for (const [position, option] of (field[6] ?? []).entries()) db.prepare("INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), canonSpaceId, setIds[set.key], id, option[0], option[1], position);
    }
  }
  return Object.fromEntries(Object.entries(setIds).map(([key, setId]) => [key, { canonSpaceId, setId }]));
}

/** 테스트의 Field key를 실제 Field ID payload로 변환한다. */
function inputFor(scope, displayName, values = {}) {
  const definition = definitions.getCanonDefinitionBySetId(scope.setId);
  return { displayName, fieldValues: Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const field = definition.fields.find((item) => item.key === key);
    assert.ok(field, key);
    return [field.id, value];
  })) };
}

/** DB 정의에 저장된 실제 Option ID를 반환한다. */
function optionId(scope, key, value) {
  return definitions.getCanonDefinitionBySetId(scope.setId).fields.find((field) => field.key === key).options.find((option) => option.value === value).id;
}

/** 실패 code와 한국어 사용자 메시지를 함께 검증한다. */
function expectCode(action, code) {
  assert.throws(action, (error) => error.code === code && /[가-힣]/.test(error.message));
}

/** 저장소 전체 스냅샷으로 의미 검증 실패의 완전 rollback을 확인한다. */
function snapshot() {
  return ["canon_records", "canon_field_values", "canon_record_option_values", "canon_record_references"].map((table) => getDatabase().prepare("SELECT * FROM " + table + " ORDER BY rowid").all());
}

/** Generic CRUD, 필수 입력, 참조 경계, 소유 규칙 및 원자성을 임시 SQLite로 검증한다. */
function validateCanonRecords() {
  const db = getDatabase();
  const scope = createCanonFixture();
  for (const key of ["world", "attribute", "passive"]) assert.equal(records.getCreateReadiness(scope[key]).canCreate, true);
  assert.equal(records.getCreateReadiness(scope.skill).canCreate, false);
  for (const key of ["location", "organization", "character", "authority", "servant", "contract", "relationship"]) assert.equal(records.getCreateReadiness(scope[key]).canCreate, false);
  assert.equal(records.getBySetId(scope.world).length, 0);
  expectCode(() => records.create(scope.character, inputFor(scope.character, "한지수")), "CANON_CREATE_PREREQUISITE_MISSING");
  const world = records.create(scope.world, inputFor(scope.world, "검증 세계"));
  const world2 = records.create(scope.world, inputFor(scope.world, "검증 세계 2"));
  const location = records.create(scope.location, inputFor(scope.location, "검증 지역", { world: world.id }));
  const location2 = records.create(scope.location, inputFor(scope.location, "검증 지역 2", { world: world2.id }));
  const common = records.create(scope.passive, inputFor(scope.passive, "검증 공용", { passive_type: optionId(scope.passive, "passive_type", "COMMON") }));
  expectCode(() => records.create(scope.character, inputFor(scope.character, "한지수")), "CANON_CREATE_PREREQUISITE_MISSING");
  const attribute = records.create(scope.attribute, inputFor(scope.attribute, "검증 속성"));
  assert.equal(records.getCreateReadiness(scope.skill).canCreate, true);
  records.delete(scope.passive, common.id);
  expectCode(() => records.create(scope.character, inputFor(scope.character, "한지수")), "CANON_CREATE_PREREQUISITE_MISSING");
  const common2 = records.create(scope.passive, inputFor(scope.passive, "검증 공용", { passive_type: optionId(scope.passive, "passive_type", "COMMON") }));
  const unique = records.create(scope.passive, inputFor(scope.passive, "검증 고유", { passive_type: optionId(scope.passive, "passive_type", "UNIQUE") }));
  const values = { origin_world: world.id, origin_location: location.id, current_location: location2.id, attributes: [attribute.id], passives: [common2.id], skills: [], organization: null };
  assert.equal(records.getCreateReadiness(scope.character).canCreate, true);
  const first = records.create(scope.character, inputFor(scope.character, "한지수", { ...values, passives: [common2.id, unique.id] }));
  const second = records.create(scope.character, inputFor(scope.character, "이카로스", values));
  assert.equal(records.getBySetId(scope.character).length, 2);
  assert.deepEqual(records.getById(scope.character, first.id), first);
  assert.equal(records.getCreateReadiness(scope.contract).canCreate, true);
  assert.equal(records.getCreateReadiness(scope.relationship).canCreate, true);
  for (const key of ["origin_location", "attributes", "passives"]) expectCode(() => records.create(scope.character, inputFor(scope.character, "누락", { ...values, [key]: key === "attributes" || key === "passives" ? [] : null })), "CANON_REQUIRED_FIELD_MISSING");
  expectCode(() => records.create(scope.passive, inputFor(scope.passive, "유형 누락")), "CANON_REQUIRED_FIELD_MISSING");
  expectCode(() => records.create(scope.world, inputFor(scope.world, "  ")), "CANON_REQUIRED_FIELD_MISSING");
  const before = snapshot();
  expectCode(() => records.create(scope.character, inputFor(scope.character, "중복", { ...values, passives: [unique.id] })), "CANON_UNIQUE_PASSIVE_IN_USE");
  assert.deepEqual(snapshot(), before);
  expectCode(() => records.update(scope.character, second.id, inputFor(scope.character, "변경 시도", { ...values, passives: [unique.id] })), "CANON_UNIQUE_PASSIVE_IN_USE");
  assert.deepEqual(snapshot(), before);
  records.update(scope.character, first.id, { displayName: first.displayName, fieldValues: first.fieldValues });
  expectCode(() => records.update(scope.passive, common2.id, inputFor(scope.passive, "변경", { passive_type: optionId(scope.passive, "passive_type", "UNIQUE") })), "CANON_PASSIVE_TYPE_CHANGE_BLOCKED");
  const passiveField = definitions.getCanonDefinitionBySetId(scope.character.setId).fields.find((field) => field.key === "passives");
  assert.equal(records.getReferenceOptions(scope.character, passiveField.id).find((item) => item.id === unique.id).disabled, true);
  assert.equal(records.getReferenceOptions(scope.character, passiveField.id, first.id).find((item) => item.id === unique.id).disabled, false);
  assert.match(records.getReferenceOptions(scope.character, passiveField.id, second.id).find((item) => item.id === unique.id).description, /한지수/);
  expectCode(() => records.create(scope.character, inputFor(scope.character, "출신 불일치", { ...values, origin_location: location2.id })), "CANON_ORIGIN_LOCATION_WORLD_MISMATCH");
  expectCode(() => records.update(scope.location, location.id, inputFor(scope.location, "세계 변경", { world: world2.id })), "CANON_ORIGIN_LOCATION_WORLD_MISMATCH");
  expectCode(() => records.create(scope.character, inputFor(scope.character, "분류 오류", { ...values, attributes: [world.id] })), "CANON_REFERENCE_INVALID");
  expectCode(() => records.create(scope.character, inputFor(scope.character, "대상 없음", { ...values, attributes: ["missing"] })), "CANON_REFERENCE_TARGET_NOT_FOUND");
  const other = createCanonFixture();
  const otherWorld = records.create(other.world, inputFor(other.world, "다른 공간 세계"));
  expectCode(() => records.create(scope.location, inputFor(scope.location, "교차", { world: otherWorld.id })), "CANON_REFERENCE_SCOPE_MISMATCH");
  expectCode(() => records.getBySetId({ ...scope.world, canonSpaceId: other.world.canonSpaceId }), "CANON_REFERENCE_SCOPE_MISMATCH");
  expectCode(() => records.getById(other.world, world.id), "CANON_RECORD_NOT_FOUND");
  expectCode(() => records.update(other.world, world.id, inputFor(other.world, "교차")), "CANON_RECORD_NOT_FOUND");
  expectCode(() => records.delete(other.world, world.id), "CANON_RECORD_NOT_FOUND");
  expectCode(() => records.getBySetId({ ...scope.world, setId: "missing" }), "CANON_SET_NOT_FOUND");
  expectCode(() => records.getReferenceOptions(scope.world, passiveField.id), "CANON_REFERENCE_INVALID");
  expectCode(() => records.getReferenceOptions(scope.character, passiveField.id, otherWorld.id), "CANON_RECORD_NOT_FOUND");
  expectCode(() => records.create(scope.contract, inputFor(scope.contract, "자기 계약", { grantor_character: first.id, grantee_character: first.id, status: optionId(scope.contract, "status", "ACTIVE") })), "CANON_SELF_REFERENCE_INVALID");
  expectCode(() => records.create(scope.relationship, inputFor(scope.relationship, "자기 관계", { source_character: first.id, target_character: first.id, relationship_type: "TEST" })), "CANON_SELF_REFERENCE_INVALID");
  expectCode(() => records.delete(scope.world, world.id), "CANON_RECORD_IN_USE");
  expectCode(() => records.delete(scope.passive, unique.id), "CANON_RECORD_IN_USE");
  expectCode(() => records.create(scope.world, { displayName: "외부 필드", fieldValues: { [passiveField.id]: [] } }), "CANON_FIELD_VALUE_INVALID");
  expectCode(() => records.create(scope.passive, inputFor(scope.passive, "외부 옵션", { passive_type: optionId(scope.contract, "status", "ACTIVE") })), "CANON_FIELD_VALUE_INVALID");
  expectCode(() => records.create(scope.character, inputFor(scope.character, "중복 배열", { ...values, attributes: [attribute.id, attribute.id] })), "CANON_FIELD_VALUE_INVALID");
  records.update(scope.passive, unique.id, inputFor(scope.passive, "공용으로 변경", { passive_type: optionId(scope.passive, "passive_type", "COMMON") }));
  records.delete(scope.character, second.id);
  assert.equal(records.getCreateReadiness(scope.contract).canCreate, false);
  records.delete(scope.character, first.id);
  assert.equal(records.getBySetId(scope.character).length, 0);
  records.delete(scope.passive, unique.id);
  expectCode(() => records.getById(scope.passive, unique.id), "CANON_RECORD_NOT_FOUND");
  validateGenericTypes(scope.attribute);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Task017 Canon CRUD, readiness, scope, ownership and rollback validation passed.");
}

/** 숫자/boolean/복수 option도 범용 저장 계약대로 동작하는지 검증한다. */
function validateGenericTypes(scope) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const fields = {};
  for (const [key, type, control] of [["text", "TEXT", "TEXT_INPUT"], ["number", "NUMBER", "NUMBER_INPUT"], ["boolean", "BOOLEAN", "CHECKBOX"], ["options", "OPTION_MANY", "MULTI_SELECT"]]) {
    fields[key] = randomUUID();
    db.prepare("INSERT INTO canon_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(fields[key], scope.canonSpaceId, scope.setId, key, "검증 " + key, type, control, null, 1, null, 30, now, now);
  }
  const option = randomUUID();
  db.prepare("INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)").run(option, scope.canonSpaceId, scope.setId, fields.options, "TEST", "검증 선택", 1);
  const input = { displayName: "타입 검증", fieldValues: { [fields.text]: "문자", [fields.number]: 0, [fields.boolean]: false, [fields.options]: [option] } };
  const record = records.create(scope, input);
  for (const [id, value] of Object.entries(input.fieldValues)) assert.deepEqual(record.fieldValues[id], value);
  const beforeFailure = snapshot();
  db.exec("CREATE TEMP TRIGGER task017_write_failure BEFORE INSERT ON canon_field_values WHEN NEW.text_value = 'forced-failure' BEGIN SELECT RAISE(ABORT, 'internal SQL failure'); END");
  const failingInput = { ...input, fieldValues: { ...input.fieldValues, [fields.text]: "forced-failure" } };
  expectCode(() => records.create(scope, failingInput), "CANON_RECORD_CREATE_FAILED");
  assert.deepEqual(snapshot(), beforeFailure);
  expectCode(() => records.update(scope, record.id, failingInput), "CANON_RECORD_UPDATE_FAILED");
  assert.deepEqual(snapshot(), beforeFailure);
  db.exec("DROP TRIGGER task017_write_failure");
  for (const [id, value] of [[fields.text, 1], [fields.number, "1"], [fields.number, Infinity], [fields.boolean, 1], [fields.options, option], [fields.text, "  "]]) expectCode(() => records.update(scope, record.id, { ...input, fieldValues: { ...input.fieldValues, [id]: value } }), "CANON_FIELD_VALUE_INVALID");
  records.delete(scope, record.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM canon_field_values WHERE record_id = ?").get(record.id).count, 0);
}

module.exports = { createCanonFixture, inputFor, validateCanonRecords };
