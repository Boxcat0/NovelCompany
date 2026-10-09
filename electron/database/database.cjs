const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getDatabaseFilePath } = require("../storage/storage-paths.cjs");
const { runMigrations } = require("./migrate.cjs");

const migrationsDirectory = path.join(__dirname, "migrations");
let database;

/** 업그레이드 대상 Skill/Attribute Set과 기존 동명 Field의 실제 정의를 읽어 충돌을 차단한다. */
function inspectSkillAttributeUpgrade(connection) {
  const targets = connection.prepare("SELECT skill.canon_space_id AS canonSpaceId, skill.id AS skillSetId, attribute.id AS attributeSetId, field.id AS fieldId, field.label, field.value_type AS valueType, field.input_control AS inputControl, field.reference_set_id AS referenceSetId, field.required FROM canon_sets skill JOIN canon_sets attribute ON attribute.canon_space_id = skill.canon_space_id AND attribute.key = 'attribute' LEFT JOIN canon_fields field ON field.canon_set_id = skill.id AND field.key = 'required_attribute' WHERE skill.key = 'skill'").all();
  for (const target of targets) {
    if (target.fieldId && (target.label !== '필요 속성' || target.valueType !== 'REFERENCE_ONE' || target.inputControl !== 'COMBOBOX' || target.referenceSetId !== target.attributeSetId || target.required !== 1)) {
      throw new Error('기존 스킬 필요 속성 정의가 달라 자동 갱신을 중단했습니다. CanonSpace와 백업을 확인해 주세요.');
    }
  }
  return targets;
}

/** 연결을 열고 기존 DB의 Definition 변경 전 백업과 대상 재확인을 수행한다. */
function initializeDatabase(databasePath = getDatabaseFilePath()) {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const connection = new DatabaseSync(databasePath);

  try {
    connection.exec("PRAGMA foreign_keys = ON");
    const hasMigrations = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const needsTask017 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    const needsTask022 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get();
    const needsTask024 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
    const needsSkillAttribute = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
    const needsFingerprintVersion = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get();
    const needsReviewJobs = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get();
    const needsSceneNarration = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get();
    const skillTargets = needsSkillAttribute ? inspectSkillAttributeUpgrade(connection) : [];
    const needsAliases = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 12").get();
    if (needsTask017 || needsTask022 || needsTask024 || needsSkillAttribute || needsFingerprintVersion || needsReviewJobs || needsSceneNarration || needsAliases) {
      const backupDirectory = path.join(path.dirname(databasePath), "backups");
      fs.mkdirSync(backupDirectory, { recursive: true });
      const backupPrefix = needsTask017 ? "before-task017-" : needsTask022 ? "before-task022-" : needsTask024 ? "before-task024-" : needsSkillAttribute || needsFingerprintVersion ? "before-task025-hf01-" : needsReviewJobs ? "before-task026-" : needsSceneNarration ? "before-task027-" : "before-task028-";
      const backupPath = path.join(backupDirectory, backupPrefix + require("node:crypto").randomUUID() + ".db");
      connection.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
    }
    runMigrations(connection, migrationsDirectory);
    if (needsSkillAttribute) {
      const actual = inspectSkillAttributeUpgrade(connection);
      if (actual.length !== skillTargets.length || actual.some((target, index) => target.canonSpaceId !== skillTargets[index].canonSpaceId || target.skillSetId !== skillTargets[index].skillSetId || !target.fieldId)) {
        throw new Error('스킬 필요 속성 정의 적용 대상을 다시 확인하지 못했습니다. CanonSpace와 백업을 확인해 주세요.');
      }
    }
    database = connection;
    return database;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function getDatabase() {
  if (!database) {
    throw new Error("Database has not been initialized.");
  }

  return database;
}

function closeDatabase() {
  if (database) {
    database.close();
    database = undefined;
  }
}

module.exports = { closeDatabase, getDatabase, initializeDatabase };

