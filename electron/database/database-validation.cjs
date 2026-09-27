const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { closeDatabase, initializeDatabase } = require("./database.cjs");
const { runMigrations } = require("./migrate.cjs");
const { LocalEpisodeStorage } = require("../storage/local-episode-storage.cjs");

const migrationsDirectory = path.join(__dirname, "migrations");
const timestamp = "2026-01-01T00:00:00.000Z";

/**
 * SQLite 제약 위반이 발생하는지 검증한다.
 */
function expectFailure(action, description) {
  assert.throws(action, undefined, description);
}

/**
 * 준비된 SQL을 실행해 검증 데이터 행을 추가하거나 변경한다.
 */
function execute(database, sql, ...parameters) {
  return database.prepare(sql).run(...parameters);
}

/**
 * Work와 Episode의 기존 외래 키 및 회차 고유 규칙을 검증할 행을 만든다.
 */
function insertWorkAndEpisode(database, workId) {
  execute(database, "INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)", workId, workId, null, "ACTIVE", timestamp, timestamp);
  execute(database, "INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", workId + "-episode", workId, 1, "첫 회차", "DRAFT", workId + "/episodes/001.txt", null, timestamp, timestamp);
}

/**
 * 001만 적용된 DB를 만들어 기존 Canon 데이터가 있을 때의 migration 안전 실패를 검증한다.
 */
function createLegacyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(fs.readFileSync(path.join(migrationsDirectory, "001_initial_schema.sql"), "utf8"));
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  execute(database, "INSERT INTO schema_migrations VALUES (?, ?, ?)", 1, "001_initial_schema.sql", timestamp);
  return database;
}

/**
 * CanonSpace migration과 CanonSpace 경계 제약을 임시 DB에서 검증한다.
 */
async function runValidation() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "novel-company-database-"));
  let legacyDatabase;

  try {
    const database = initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    const tableNames = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const tableName of ["schema_migrations", "works", "episodes", "review_runs", "review_findings", "canon_spaces", "canon_sets", "canon_fields", "canon_field_options", "canon_records", "canon_field_values", "canon_record_option_values", "canon_record_references", "worlds", "locations", "organizations", "characters", "attributes", "character_attributes", "skills", "character_skills", "authorities", "servants", "contracts", "passives", "character_passives", "character_relationships"]) {
      assert.equal(tableNames.has(tableName), true, "Missing table: " + tableName);
    }
    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 6);

    insertWorkAndEpisode(database, "work-a");
    insertWorkAndEpisode(database, "work-b");
    insertWorkAndEpisode(database, "work-invalid-template");
    expectFailure(() => execute(database, "INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "duplicate", "work-a", 1, "중복", "DRAFT", "other.txt", null, timestamp, timestamp), "Duplicate episodes must fail.");
    execute(database, "INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)", "canon-a", "work-a", "MODERN_FANTASY_V1", timestamp, timestamp);
    execute(database, "INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)", "canon-b", "work-b", "MODERN_FANTASY_V1", timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)", "canon-a-2", "work-a", "MODERN_FANTASY_V1", timestamp, timestamp), "One Work has one CanonSpace.");
    expectFailure(() => execute(database, "INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)", "invalid", "work-invalid-template", "OTHER", timestamp, timestamp), "Unsupported templates must fail.");

    execute(database, "INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "set-a-character", "canon-a", "character", "캐릭터", "캐릭터 이름", null, 1, timestamp, timestamp);
    execute(database, "INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "set-a-world", "canon-a", "world", "세계", "세계 이름", null, 2, timestamp, timestamp);
    execute(database, "INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "set-b-character", "canon-b", "character", "캐릭터", "캐릭터 이름", null, 1, timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "set-a-character-copy", "canon-a", "character", "중복", "이름", null, 3, timestamp, timestamp), "Set keys are unique within a CanonSpace.");

    const fieldSql = "INSERT INTO canon_fields (id, canon_space_id, canon_set_id, key, label, value_type, input_control, reference_set_id, required, help_text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    execute(database, fieldSql, "field-a-name", "canon-a", "set-a-character", "name", "이름", "TEXT", "TEXT_INPUT", null, 1, null, 1, timestamp, timestamp);
    execute(database, fieldSql, "field-a-type", "canon-a", "set-a-character", "type", "유형", "OPTION_ONE", "COMBOBOX", null, 0, null, 2, timestamp, timestamp);
    execute(database, fieldSql, "field-a-world", "canon-a", "set-a-character", "world", "세계", "REFERENCE_ONE", "COMBOBOX", "set-a-world", 0, null, 3, timestamp, timestamp);
    execute(database, fieldSql, "field-a-skills", "canon-a", "set-a-character", "skills", "스킬", "REFERENCE_MANY", "CHECKBOX_GROUP", "set-a-character", 0, null, 4, timestamp, timestamp);
    execute(database, fieldSql, "field-a-world-name", "canon-a", "set-a-world", "name", "이름", "TEXT", "TEXT_INPUT", null, 1, null, 1, timestamp, timestamp);
    execute(database, fieldSql, "field-b-name", "canon-b", "set-b-character", "name", "이름", "TEXT", "TEXT_INPUT", null, 1, null, 1, timestamp, timestamp);
    expectFailure(() => execute(database, fieldSql, "field-invalid-control", "canon-a", "set-a-character", "bad", "잘못", "TEXT", "TEXTAREA", null, 0, null, 5, timestamp, timestamp), "Value type and input control must be compatible.");
    expectFailure(() => execute(database, fieldSql, "field-invalid-reference", "canon-a", "set-a-character", "bad-ref", "잘못", "REFERENCE_ONE", "COMBOBOX", null, 0, null, 5, timestamp, timestamp), "Reference fields require a target Set.");
    expectFailure(() => execute(database, fieldSql, "field-cross-reference", "canon-a", "set-a-character", "cross-ref", "잘못", "REFERENCE_ONE", "COMBOBOX", "set-b-character", 0, null, 5, timestamp, timestamp), "Reference fields cannot cross CanonSpaces.");

    execute(database, "INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)", "option-a-common", "canon-a", "set-a-character", "field-a-type", "COMMON", "공통", 1);
    execute(database, "INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)", "option-a-unique", "canon-a", "set-a-character", "field-a-type", "UNIQUE", "고유", 2);
    expectFailure(() => execute(database, "INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)", "option-cross", "canon-a", "set-a-world", "field-a-type", "CROSS", "교차", 3), "Options must belong to their field Set.");

    execute(database, "INSERT INTO canon_records VALUES (?, ?, ?, ?, ?, ?)", "record-a-character", "canon-a", "set-a-character", "이카로스", timestamp, timestamp);
    execute(database, "INSERT INTO canon_records VALUES (?, ?, ?, ?, ?, ?)", "record-a-character-2", "canon-a", "set-a-character", "한지수", timestamp, timestamp);
    execute(database, "INSERT INTO canon_records VALUES (?, ?, ?, ?, ?, ?)", "record-a-world", "canon-a", "set-a-world", "현대 지구", timestamp, timestamp);
    execute(database, "INSERT INTO canon_records VALUES (?, ?, ?, ?, ?, ?)", "record-b-character", "canon-b", "set-b-character", "류웨이", timestamp, timestamp);
    execute(database, "INSERT INTO canon_field_values VALUES (?, ?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-name", "이카로스", null, null);
    expectFailure(() => execute(database, "INSERT INTO canon_field_values VALUES (?, ?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-name", "이카로스", 1, null), "A scalar field value has exactly one stored value.");
    expectFailure(() => execute(database, "INSERT INTO canon_field_values VALUES (?, ?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-b-name", "교차", null, null), "Field values cannot cross CanonSpaces.");

    execute(database, "INSERT INTO canon_record_option_values VALUES (?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-type", "option-a-common");
    expectFailure(() => execute(database, "INSERT INTO canon_record_option_values VALUES (?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-type", "option-a-unique"), "OPTION_ONE fields accept one option.");
    expectFailure(() => execute(database, "INSERT INTO canon_record_option_values VALUES (?, ?, ?, ?, ?)", "canon-a", "set-a-world", "record-a-world", "field-a-world-name", "option-a-common"), "Options must match their field.");

    execute(database, "INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-world", "set-a-world", "record-a-world");
    expectFailure(() => execute(database, "INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-world", "set-a-world", "record-a-character-2"), "References must target the field target Set.");
    expectFailure(() => execute(database, "INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-world", "set-a-world", "record-a-world"), "REFERENCE_ONE fields accept one target.");
    execute(database, "INSERT INTO canon_record_references VALUES (?, ?, ?, ?, ?, ?)", "canon-a", "set-a-character", "record-a-character", "field-a-skills", "set-a-character", "record-a-character-2");

    execute(database, "INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)", "world-a", "canon-a", "현대 지구", null, timestamp, timestamp);
    execute(database, "INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)", "world-a-2", "canon-a", "마계", null, timestamp, timestamp);
    execute(database, "INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)", "world-b", "canon-b", "현대 지구", null, timestamp, timestamp);
    execute(database, "INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?)", "location-a", "canon-a", "world-a", "서울", null, timestamp, timestamp);
    execute(database, "INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?)", "location-a-2", "canon-a", "world-a-2", "마계성", null, timestamp, timestamp);
    execute(database, "INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?)", "location-b", "canon-b", "world-b", "서울", null, timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO locations VALUES (?, ?, ?, ?, ?, ?, ?)", "location-cross", "canon-b", "world-a", "교차", null, timestamp, timestamp), "Locations cannot cross CanonSpaces.");
    execute(database, "INSERT INTO organizations VALUES (?, ?, ?, ?, ?, ?, ?)", "org-a", "canon-a", "location-a", "관리국", null, timestamp, timestamp);
    execute(database, "INSERT INTO organizations VALUES (?, ?, ?, ?, ?, ?, ?)", "org-b", "canon-b", "location-b", "관리국", null, timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO organizations VALUES (?, ?, ?, ?, ?, ?, ?)", "org-cross", "canon-b", "location-a", "교차", null, timestamp, timestamp), "Organizations cannot cross CanonSpaces.");

    const characterSql = "INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    execute(database, characterSql, "char-a-1", "canon-a", "미카엘", null, "world-a", "location-a", "location-a", "org-a", timestamp, timestamp);
    execute(database, characterSql, "char-a-2", "canon-a", "로제", null, "world-a", "location-a", "location-a", "org-a", timestamp, timestamp);
    execute(database, characterSql, "char-b-1", "canon-b", "미카엘", null, "world-b", "location-b", "location-b", "org-b", timestamp, timestamp);
    expectFailure(() => execute(database, characterSql, "char-cross-world", "canon-a", "교차", null, "world-b", "location-a", "location-a", "org-a", timestamp, timestamp), "Characters cannot cross worlds.");
    expectFailure(() => execute(database, characterSql, "char-cross-location", "canon-a", "교차", null, "world-a", "location-b", "location-a", "org-a", timestamp, timestamp), "Characters cannot cross locations.");
    expectFailure(() => execute(database, characterSql, "char-origin-mismatch", "canon-a", "불일치", null, "world-a", "location-a-2", "location-a", "org-a", timestamp, timestamp), "Origin world and location must match.");

    execute(database, "INSERT INTO attributes VALUES (?, ?, ?, ?, ?, ?)", "attr-a", "canon-a", "물", null, timestamp, timestamp);
    execute(database, "INSERT INTO attributes VALUES (?, ?, ?, ?, ?, ?)", "attr-b", "canon-b", "물", null, timestamp, timestamp);
    execute(database, "INSERT INTO character_attributes VALUES (?, ?, ?)", "canon-a", "char-a-1", "attr-a");
    expectFailure(() => execute(database, "INSERT INTO character_attributes VALUES (?, ?, ?)", "canon-a", "char-a-1", "attr-b"), "Attributes cannot cross CanonSpaces.");
    execute(database, "INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)", "skill-a", "canon-a", "해일", null, timestamp, timestamp);
    execute(database, "INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)", "skill-b", "canon-b", "해일", null, timestamp, timestamp);
    execute(database, "INSERT INTO character_skills VALUES (?, ?, ?)", "canon-a", "char-a-1", "skill-a");
    expectFailure(() => execute(database, "INSERT INTO character_skills VALUES (?, ?, ?)", "canon-a", "char-a-1", "skill-b"), "Skills cannot cross CanonSpaces.");

    execute(database, "INSERT INTO authorities VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "authority-a", "canon-a", "char-a-1", "skill-a", "권능", null, timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO authorities VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "authority-cross", "canon-a", "char-a-1", "skill-b", "교차", null, timestamp, timestamp), "Authorities cannot cross CanonSpaces.");
    execute(database, "INSERT INTO servants VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "servant-a", "canon-a", "char-a-1", "마몬", "CREATURE", null, timestamp, timestamp);
    expectFailure(() => execute(database, "INSERT INTO servants VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "servant-cross", "canon-a", "char-b-1", "교차", "CREATURE", null, timestamp, timestamp), "Servants cannot cross CanonSpaces.");
    expectFailure(() => execute(database, "INSERT INTO servants VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "servant-duplicate", "canon-a", "char-a-1", "둘", "CREATURE", null, timestamp, timestamp), "Characters have at most one servant.");

    const contractSql = "INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    execute(database, contractSql, "contract-a", "canon-a", "char-a-1", "char-a-2", "ACTIVE", timestamp, null, timestamp, timestamp);
    expectFailure(() => execute(database, contractSql, "contract-cross", "canon-a", "char-a-1", "char-b-1", "ACTIVE", timestamp, null, timestamp, timestamp), "Contracts cannot cross CanonSpaces.");
    expectFailure(() => execute(database, contractSql, "contract-self", "canon-a", "char-a-1", "char-a-1", "ACTIVE", timestamp, null, timestamp, timestamp), "Self contracts fail.");
    expectFailure(() => execute(database, contractSql, "contract-duplicate", "canon-a", "char-a-1", "char-a-2", "ACTIVE", timestamp, null, timestamp, timestamp), "Duplicate active contracts fail.");

    execute(database, "INSERT INTO passives VALUES (?, ?, ?, ?, ?, ?, ?)", "passive-common-a", "canon-a", "공통", "COMMON", null, timestamp, timestamp);
    execute(database, "INSERT INTO passives VALUES (?, ?, ?, ?, ?, ?, ?)", "passive-unique-a", "canon-a", "고유", "UNIQUE", null, timestamp, timestamp);
    execute(database, "INSERT INTO passives VALUES (?, ?, ?, ?, ?, ?, ?)", "passive-unique-a-2", "canon-a", "둘", "UNIQUE", null, timestamp, timestamp);
    execute(database, "INSERT INTO passives VALUES (?, ?, ?, ?, ?, ?, ?)", "passive-common-b", "canon-b", "공통", "COMMON", null, timestamp, timestamp);
    execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-1", "passive-common-a");
    execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-2", "passive-common-a");
    execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-1", "passive-unique-a");
    expectFailure(() => execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-2", "passive-unique-a"), "UNIQUE passives have one owner.");
    execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-2", "passive-unique-a-2");
    expectFailure(() => execute(database, "UPDATE character_passives SET passive_id = ? WHERE canon_space_id = ? AND character_id = ? AND passive_id = ?", "passive-unique-a", "canon-a", "char-a-2", "passive-unique-a-2"), "UNIQUE passive updates cannot bypass.");
    expectFailure(() => execute(database, "UPDATE passives SET type = ? WHERE id = ?", "UNIQUE", "passive-common-a"), "COMMON passives with two owners cannot become UNIQUE.");
    expectFailure(() => execute(database, "INSERT INTO character_passives VALUES (?, ?, ?)", "canon-a", "char-a-1", "passive-common-b"), "Passives cannot cross CanonSpaces.");

    const relationshipSql = "INSERT INTO character_relationships VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    execute(database, relationshipSql, "relationship-a", "canon-a", "char-a-1", "char-a-2", "ALLY", null, timestamp, timestamp);
    expectFailure(() => execute(database, relationshipSql, "relationship-cross", "canon-a", "char-a-1", "char-b-1", "ALLY", null, timestamp, timestamp), "Relationships cannot cross CanonSpaces.");
    expectFailure(() => execute(database, relationshipSql, "relationship-self", "canon-a", "char-a-1", "char-a-1", "ALLY", null, timestamp, timestamp), "Self relationships fail.");
    expectFailure(() => execute(database, "DELETE FROM canon_spaces WHERE id = ?", "canon-a"), "CanonSpace deletion is restricted.");
    expectFailure(() => execute(database, "DELETE FROM works WHERE id = ?", "work-a"), "Work deletion is restricted.");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

    require("./canon-record-validation.cjs").validateCanonRecords();
    await require("./canon-authoring-validation.cjs").validateCanonAuthoring();
    require("./work-management-validation.cjs").validateWorkManagement(temporaryRoot);
    require("./canon-space-validation.cjs").validateCanonSpaces();
    require("./canon-deletion-validation.cjs").validateCanonDeletion(temporaryRoot);
    require("./episode-editing-validation.cjs").validateEpisodeEditing(temporaryRoot);
    const storage = new LocalEpisodeStorage(temporaryRoot);
    await storage.saveEpisode("work-a", 1, "TXT source of truth");
    assert.equal(await storage.readEpisode("work-a", 1), "TXT source of truth");
    closeDatabase();

    legacyDatabase = createLegacyDatabase(path.join(temporaryRoot, "legacy.db"));
    execute(legacyDatabase, "INSERT INTO works VALUES (?, ?, ?, ?, ?, ?)", "legacy-work", "기존 작품", null, "ACTIVE", timestamp, timestamp);
    execute(legacyDatabase, "INSERT INTO worlds VALUES (?, ?, ?, ?, ?, ?)", "legacy-world", "legacy-work", "기존 세계", null, timestamp, timestamp);
    expectFailure(() => runMigrations(legacyDatabase, migrationsDirectory), "Legacy Canon data must stop migration.");
    assert.equal(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM worlds").get().count, 1);
    assert.equal(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get().count, 0);
    assert.equal(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'canon_spaces'").get().count, 0);
    assert.deepEqual(legacyDatabase.prepare("PRAGMA foreign_key_check").all(), []);
    validateTask017Migration(temporaryRoot);
    require("./canon-authoring-validation.cjs").validateAuthoringMigration(temporaryRoot);
    require("./canon-bootstrap-validation.cjs").validateCanonBootstrap(temporaryRoot);
    validateTask024Migration(temporaryRoot);
    console.log("Database validation passed.");
  } finally {
    closeDatabase();
    legacyDatabase?.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** 실제 003 파일에 004를 적용해 백업 선행, ID/데이터 보존 및 재시작 안전성을 확인한다. */
function validateTask017Migration(temporaryRoot) {
  const { createCanonFixture, inputFor } = require("./canon-record-validation.cjs");
  const records = require("./repositories/canon-record-repository.cjs");
  const databasePath = path.join(temporaryRoot, "migration-task017.db");
  const connection = initializeDatabase(databasePath);
  const scopes = createCanonFixture();
  const saved = records.create(scopes.world, inputFor(scopes.world, "보존 검증", { description: "기존 입력 보존" }));
  connection.exec("UPDATE canon_fields SET required = 0 WHERE key IN ('origin_world', 'origin_location', 'current_location', 'attributes', 'passives', 'location')");
  connection.exec("DROP TABLE review_findings; DROP TABLE review_runs; DELETE FROM schema_migrations WHERE version >= 4");
  const beforeFields = connection.prepare("SELECT id, canon_set_id, key, value_type FROM canon_fields ORDER BY id").all();
  closeDatabase();
  const migrated = initializeDatabase(databasePath);
  assert.deepEqual(migrated.prepare("SELECT id, canon_set_id, key, value_type FROM canon_fields ORDER BY id").all(), beforeFields);
  assert.deepEqual(records.getById(scopes.world, saved.id), saved);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 6);
  const { CANON_SETS } = require("./setup/setup-initial-novel-canon.cjs");
  for (const set of CANON_SETS) {
    for (const field of set.fields) assert.equal(migrated.prepare("SELECT required FROM canon_fields WHERE canon_set_id = ? AND key = ?").get(scopes[set.key].setId, field[0]).required, Number(field[4]));
  }
  const backupDirectory = path.join(temporaryRoot, "backups");
  const backups = fs.readdirSync(backupDirectory).filter((file) => file.startsWith("before-task017-"));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(backupDirectory, backups[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 3);
    assert.equal(backup.prepare("SELECT required FROM canon_fields WHERE canon_set_id = ? AND key = 'attributes'").get(scopes.character.setId).required, 0);
    assert.equal(backup.prepare("SELECT display_name FROM canon_records WHERE id = ?").get(saved.id).display_name, saved.displayName);
  } finally { backup.close(); }
  closeDatabase();
  initializeDatabase(databasePath);
  assert.equal(fs.readdirSync(backupDirectory).length, 1);
  closeDatabase();
  console.log("Task017 migration backup, preservation and restart validation passed.");
}

/** 005 상태의 기존 Work/Episode/Canon DB가 006 Review schema로 백업 후 안전하게 확장되는지 검증한다. */
function validateTask024Migration(temporaryRoot) {
  const databasePath = path.join(temporaryRoot, "migration-task024.db");
  const connection = initializeDatabase(databasePath);
  insertWorkAndEpisode(connection, "review-migration-work");
  connection.exec("DROP TABLE review_findings; DROP TABLE review_runs; DELETE FROM schema_migrations WHERE version >= 6");
  closeDatabase();
  const migrated = initializeDatabase(databasePath);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 6);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_runs'").get().count, 1);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_findings'").get().count, 1);
  assert.equal(migrated.prepare("SELECT id FROM episodes WHERE id = ?").get("review-migration-work-episode").id, "review-migration-work-episode");
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  const backups = fs.readdirSync(path.join(temporaryRoot, "backups")).filter((file) => file.startsWith("before-task024-"));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(temporaryRoot, "backups", backups[0]), { readOnly: true });
  try { assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 5); } finally { backup.close(); }
  closeDatabase();
  console.log("Task024 migration backup, 005-to-006 schema and preservation passed.");
}

runValidation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
