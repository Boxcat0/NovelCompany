const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { initializeDatabase, closeDatabase, getDatabase } = require("./database.cjs");
const { createCanonFixture, inputFor } = require("./canon-record-validation.cjs");
const definitions = require("./repositories/canon-definition-repository.cjs");
const repository = require("./repositories/canon-record-repository.cjs");

/** 같은 작성 시나리오를 실제 Repository 또는 IPC bridge에서 실행하여 공개 계약까지 검증한다. */
async function validateCanonAuthoring(api = repository) {
  const scopes = createCanonFixture();
  /** 실제 정의에서 option/field ID를 얻어 fixture 이름과 무관한 입력을 만든다. */
  function field(key, name) { return definitions.getCanonDefinitionBySetId(scopes[key].setId).fields.find((item) => item.key === name); }
  /** 안정적인 오류 code와 한국어 메시지 및 내부 정보 은닉을 확인한다. */
  async function fails(action, code) { await assert.rejects(async () => action(), (error) => error.code === code && /[가-힣]/.test(error.message)); }
  /** 현재 부족한 Set을 실제 target ID로 해석한다. */
  async function blocked(key, expected) {
    const ready = await api.getCreateReadiness(scopes[key]);
    assert.equal(ready.canCreate, expected.length === 0);
    assert.deepEqual(ready.blockers.map((b) => Object.keys(scopes).find((k) => scopes[k].setId === b.targetSetId)).sort(), [...expected].sort());
    return ready;
  }
  for (const key of ["world", "attribute", "passive", "skill"]) await blocked(key, []);
  await blocked("location", ["world"]); await blocked("organization", ["location"]);
  await blocked("character", ["location", "attribute", "passive"]);
  // 과거 optional flag가 required여도 Character 시작 조건에 포함되지 않는다.
  getDatabase().prepare("UPDATE canon_fields SET required = 1 WHERE canon_set_id = ? AND key IN ('origin_world', 'current_location', 'organization', 'skills')").run(scopes.character.setId);
  await blocked("character", ["location", "attribute", "passive"]);
  getDatabase().prepare("UPDATE canon_fields SET required = 0 WHERE canon_set_id = ? AND key IN ('origin_world', 'current_location', 'organization', 'skills')").run(scopes.character.setId);
  const world = await api.create(scopes.world, inputFor(scopes.world, "임시 세계"));
  await blocked("location", []);
  await fails(() => api.create(scopes.location, inputFor(scopes.location, "임시 지역")), "CANON_REQUIRED_FIELD_MISSING");
  const location = await api.create(scopes.location, inputFor(scopes.location, "임시 지역", { world: world.id }));
  await blocked("organization", []); await blocked("character", ["attribute", "passive"]);
  const attribute = await api.create(scopes.attribute, inputFor(scopes.attribute, "임시 속성"));
  await blocked("character", ["passive"]);
  const passive = await api.create(scopes.passive, inputFor(scopes.passive, "임시 공용", { passive_type: field("passive", "passive_type").options.find((o) => o.value === "COMMON").id }));
  await blocked("character", []);
  assert.equal((await api.getBySetId(scopes.skill)).length, 0); assert.equal((await api.getBySetId(scopes.organization)).length, 0);
  for (const key of ["authority", "servant", "contract", "relationship"]) await blocked(key, ["character"]);
  const values = { origin_location: location.id, attributes: [attribute.id], passives: [passive.id] };
  const first = await api.create(scopes.character, inputFor(scopes.character, "이카로스", values));
  for (const key of ["origin_world", "current_location", "organization"]) assert.equal(first.fieldValues[field("character", key).id], null);
  assert.deepEqual(first.fieldValues[field("character", "skills").id], []);
  await blocked("authority", []); await blocked("servant", []);
  for (const key of ["contract", "relationship"]) { const ready = await blocked(key, ["character"]); assert.equal(ready.blockers[0].requiredCount, 2); assert.equal(ready.blockers[0].currentCount, 1); }
  for (const key of ["origin_location", "attributes", "passives"]) {
    const input = inputFor(scopes.character, "이카로스", { ...values, [key]: key === "origin_location" ? null : [] });
    await fails(() => api.create(scopes.character, input), "CANON_REQUIRED_FIELD_MISSING");
    await fails(() => api.update(scopes.character, first.id, input), "CANON_REQUIRED_FIELD_MISSING");
    assert.deepEqual(await api.getById(scopes.character, first.id), first);
  }
  getDatabase().prepare("UPDATE canon_fields SET required=0 WHERE id=?").run(field("character", "attributes").id);
  await fails(() => api.update(scopes.character, first.id, inputFor(scopes.character, "이카로스", { ...values, attributes: [] })), "CANON_REQUIRED_FIELD_MISSING");
  getDatabase().prepare("UPDATE canon_fields SET required=1 WHERE id=?").run(field("character", "attributes").id);
  const second = await api.create(scopes.character, inputFor(scopes.character, "한지수", values));
  await blocked("contract", []); await blocked("relationship", []);
  const unique = await api.create(scopes.passive, inputFor(scopes.passive, "임시 고유", { passive_type: field("passive", "passive_type").options.find((o) => o.value === "UNIQUE").id }));
  await api.update(scopes.character, first.id, inputFor(scopes.character, "이카로스", { ...values, passives: [unique.id] }));
  assert.equal((await api.getReferenceOptions(scopes.character, field("character", "passives").id, second.id)).find((o) => o.id === unique.id).disabled, true);
  assert.equal((await api.getReferenceOptions(scopes.character, field("character", "passives").id, first.id)).find((o) => o.id === unique.id).disabled, false);
  await fails(() => api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, passives: [unique.id] })), "CANON_UNIQUE_PASSIVE_IN_USE");
  const world2 = await api.create(scopes.world, inputFor(scopes.world, "다른 임시 세계"));
  const location2 = await api.create(scopes.location, inputFor(scopes.location, "다른 임시 지역", { world: world2.id }));
  await api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, current_location: location2.id }));
  await fails(() => api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, origin_world: world2.id })), "CANON_ORIGIN_LOCATION_WORLD_MISMATCH");
  await api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, origin_world: world.id }));
  await api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", values));
  const other = createCanonFixture();
  const foreign = await api.create(other.world, inputFor(other.world, "별도 임시 세계"));
  const foreignLocation = await api.create(other.location, inputFor(other.location, "별도 임시 지역", { world: foreign.id }));
  await fails(() => api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, origin_location: foreignLocation.id })), "CANON_REFERENCE_SCOPE_MISMATCH");
  await fails(() => api.create(scopes.location, inputFor(scopes.location, "교차", { world: foreign.id })), "CANON_REFERENCE_SCOPE_MISMATCH");
  await fails(() => api.update(scopes.character, second.id, inputFor(scopes.character, "한지수", { ...values, origin_location: world.id })), "CANON_REFERENCE_INVALID");
  assert.deepEqual((await api.getReferenceOptions(scopes.character, field("character", "origin_location").id)).map((o) => o.id).sort(), [location.id, location2.id].sort());
  const contract = { grantor_character: first.id, grantee_character: second.id, status: field("contract", "status").options.find((o) => o.value === "ACTIVE").id };
  await fails(() => api.create(scopes.contract, inputFor(scopes.contract, "임시 계약", { ...contract, grantee_character: first.id })), "CANON_SELF_REFERENCE_INVALID");
  await fails(() => api.create(scopes.relationship, inputFor(scopes.relationship, "임시 관계", { source_character: first.id, target_character: first.id, relationship_type: "검증" })), "CANON_SELF_REFERENCE_INVALID");
  await fails(() => api.create(scopes.relationship, inputFor(scopes.relationship, "임시 관계", { source_character: first.id, target_character: second.id })), "CANON_REQUIRED_FIELD_MISSING");
  for (const [scope, id] of [[scopes.location, location.id], [scopes.attribute, attribute.id], [scopes.passive, unique.id]]) await fails(() => api.delete(scope, id), "CANON_RECORD_IN_USE");
  await api.delete(scopes.character, second.id); await api.delete(scopes.character, first.id);
  await api.delete(scopes.passive, unique.id);
  assert.deepEqual(getDatabase().prepare("PRAGMA foreign_key_check").all(), []);
  console.log("Task022 readiness/minimum/optional/UNIQUE/reference/CRUD validation passed.");
}

/** 기존 004 DB를 재개방하여 정확한 정의만 보정하고 백업·ID·Record 보존 및 재실행을 검증한다. */
function validateAuthoringMigration(root) {
  const file = path.join(root, "task022-migration", "novelcompany.db");
  const db = initializeDatabase(file);
  const scope = createCanonFixture(); const custom = createCanonFixture();
  const saved = repository.create(scope.world, inputFor(scope.world, "임시 보존 세계"));
  const location = repository.create(scope.location, inputFor(scope.location, "임시 보존 지역", { world: saved.id }));
  const attribute = repository.create(scope.attribute, inputFor(scope.attribute, "임시 보존 속성"));
  const passiveType = definitions.getCanonDefinitionBySetId(scope.passive.setId).fields.find((field) => field.key === "passive_type");
  const passive = repository.create(scope.passive, inputFor(scope.passive, "임시 보존 패시브", { passive_type: passiveType.options.find((option) => option.value === "COMMON").id }));
  const character = repository.create(scope.character, inputFor(scope.character, "이카로스", { origin_world: saved.id, origin_location: location.id, current_location: location.id, attributes: [attribute.id], passives: [passive.id], description: "임시 migration 보존 검증" }));
  const valueTables = ["canon_records", "canon_field_values", "canon_record_option_values", "canon_record_references"];
  const recordsBefore = valueTables.map((table) => db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all());
  db.exec("UPDATE canon_fields SET required = 1 WHERE key IN ('origin_world', 'current_location'); UPDATE canon_fields SET required = 0 WHERE key = 'relationship_type'; DELETE FROM schema_migrations WHERE version = 5");
  db.prepare("UPDATE canon_fields SET label = '사용자 정의 출신지' WHERE canon_set_id = ? AND key = 'origin_location'").run(custom.character.setId);
  const before = db.prepare("SELECT * FROM canon_fields ORDER BY id").all();
  closeDatabase();
  const migrated = initializeDatabase(file);
  const after = migrated.prepare("SELECT * FROM canon_fields ORDER BY id").all();
  assert.deepEqual(after.map(({ required, ...rest }) => rest), before.map(({ required, ...rest }) => rest));
  assert.equal(after.filter((row, i) => row.required !== before[i].required).length, 3);
  assert.deepEqual(after.filter((row) => row.canon_space_id === custom.world.canonSpaceId), before.filter((row) => row.canon_space_id === custom.world.canonSpaceId));
  assert.deepEqual(repository.getById(scope.world, saved.id), saved);
  assert.deepEqual(repository.getById(scope.character, character.id), character);
  assert.deepEqual(valueTables.map((table) => migrated.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()), recordsBefore);
  assert.equal(migrated.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 6);
  const backups = fs.readdirSync(path.join(path.dirname(file), "backups")); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(path.dirname(file), "backups", backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 5); assert.equal(backup.prepare("SELECT required FROM canon_fields WHERE canon_set_id = ? AND key = 'origin_world'").get(scope.character.setId).required, 1); } finally { backup.close(); }
  closeDatabase(); initializeDatabase(file); closeDatabase();
  assert.equal(fs.readdirSync(path.join(path.dirname(file), "backups")).length, 1);
  const failFile = path.join(root, "task022-backup-failure", "novelcompany.db");
  initializeDatabase(failFile).exec("DELETE FROM schema_migrations WHERE version = 5"); closeDatabase();
  fs.writeFileSync(path.join(path.dirname(failFile), "backups"), "block backup directory");
  assert.throws(() => initializeDatabase(failFile));
  const untouched = new DatabaseSync(failFile, { readOnly: true });
  try { assert.equal(untouched.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=5").get().n, 0); } finally { untouched.close(); }
  console.log("Task022 migration scope, backup-before-write, preservation and restart passed.");
}

/** 실제 Main handler를 거친 Result에서 공개 오류만 복원하여 동일 작성 시나리오를 실행한다. */
async function validateCanonAuthoringIpc(ipcMain) {
  const bridge = require("../ipc/preload-api.cjs").createNovelCompanyApi({
    /** 검증용 invoke를 실제 등록된 Main IPC handler로 전달한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  const api = Object.fromEntries(Object.keys(repository).map((key) => [key, async (...args) => {
    const result = await bridge.canon.records[key](...args);
    if (!result.ok) {
      assert.deepEqual(Object.keys(result.error).sort(), ["code", "message"]);
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    }
    return result.data;
  }]));
  await validateCanonAuthoring(api);
}

module.exports = { validateCanonAuthoring, validateAuthoringMigration, validateCanonAuthoringIpc };
