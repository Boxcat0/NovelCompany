const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { closeDatabase, getDatabase, initializeDatabase } = require("../database.cjs");
const { getDataRoot, getDatabaseFilePath } = require("../../storage/storage-paths.cjs");

const INITIAL_WORK_TITLE = "아무래도 전직을 잘못한 것 같습니다?";
const INITIAL_TEMPLATE_KEY = "MODERN_FANTASY_V1";

const CANON_SETS = [
  { key: "world", name: "세계", recordNameLabel: "세계 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "location", name: "지역", recordNameLabel: "지역 이름", fields: [["world", "세계", "REFERENCE_ONE", "COMBOBOX", true, "world"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "organization", name: "조직", recordNameLabel: "조직 이름", fields: [["location", "지역", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "attribute", name: "속성", recordNameLabel: "속성 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "skill", name: "스킬", recordNameLabel: "스킬 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "character", name: "캐릭터", recordNameLabel: "캐릭터 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false], ["origin_world", "출신 세계", "REFERENCE_ONE", "COMBOBOX", false, "world"], ["origin_location", "출신 지역", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["current_location", "현재 위치", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["organization", "소속 조직", "REFERENCE_ONE", "COMBOBOX", false, "organization"], ["attributes", "속성", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "attribute"], ["skills", "스킬", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "skill"], ["passives", "패시브", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "passive"]] },
  { key: "authority", name: "권능", recordNameLabel: "권능 이름", fields: [["owner_character", "소유 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["base_skill", "기반 스킬", "REFERENCE_ONE", "COMBOBOX", false, "skill"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "servant", name: "권속", recordNameLabel: "권속 이름", fields: [["owner_character", "소유 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "passive", name: "패시브", recordNameLabel: "패시브 이름", fields: [["passive_type", "패시브 유형", "OPTION_ONE", "COMBOBOX", true, null, [["COMMON", "공통"], ["UNIQUE", "고유"]]], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "contract", name: "계약", recordNameLabel: "계약 이름", fields: [["grantor_character", "부여자", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["grantee_character", "수여자", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["status", "상태", "OPTION_ONE", "COMBOBOX", true, null, [["ACTIVE", "활성"], ["ENDED", "종료"]]], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "relationship", name: "관계", recordNameLabel: "관계 이름", fields: [["source_character", "기준 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["target_character", "대상 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["relationship_type", "관계 유형", "TEXT", "TEXT_INPUT", false], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
];

/**
 * 프로덕션 DB의 변경 전 상태를 충돌 없는 별도 SQLite 파일로 보관한다.
 */
function createDatabaseBackup(database) {
  const backupDirectory = path.join(getDataRoot(), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const fileName = "novelcompany-before-initial-canon-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID() + ".db";
  const backupPath = path.join(backupDirectory, fileName);
  const escapedPath = backupPath.replace(/'/g, "''");
  database.exec("VACUUM INTO '" + escapedPath + "'");
  return backupPath;
}

/**
 * 초기 Work 제목으로 이미 생성된 Work를 조회하며, 중복 제목은 안전하게 중단한다.
 */
function findOrCreateInitialWork(database) {
  const works = database.prepare("SELECT id FROM works WHERE title = ? ORDER BY created_at, id").all(INITIAL_WORK_TITLE);
  if (works.length > 1) {
    throw new Error("동일한 제목의 초기 작품이 둘 이상이라 설정을 안전하게 진행할 수 없습니다.");
  }
  if (works.length === 1) {
    return { id: works[0].id, created: false };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare("INSERT INTO works (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, INITIAL_WORK_TITLE, null, "ACTIVE", now, now);
  return { id, created: true };
}

/**
 * 이미 존재하는 Canon definition이 정확히 초기 템플릿과 같은지 확인한다.
 */
function assertCompleteDefinition(database, canonSpaceId) {
  const sets = database.prepare("SELECT id, key, name, record_name_label FROM canon_sets WHERE canon_space_id = ? ORDER BY sort_order, id").all(canonSpaceId);
  if (sets.length !== CANON_SETS.length) {
    throw new Error("기존 Canon 정의가 일부만 존재합니다. 자동 병합하거나 보정하지 않습니다.");
  }

  for (const expectedSet of CANON_SETS) {
    const actualSet = sets.find((set) => set.key === expectedSet.key);
    if (!actualSet || actualSet.name !== expectedSet.name || actualSet.record_name_label !== expectedSet.recordNameLabel) {
      throw new Error("기존 Canon Set 정의가 초기 템플릿과 다릅니다. 자동 병합하거나 보정하지 않습니다.");
    }
    const actualFields = database.prepare("SELECT id, key, label, value_type, input_control, required, reference_set_id FROM canon_fields WHERE canon_set_id = ? ORDER BY sort_order, id").all(actualSet.id);
    if (actualFields.length !== expectedSet.fields.length) {
      throw new Error("기존 Canon Field 정의가 일부만 존재합니다. 자동 병합하거나 보정하지 않습니다.");
    }
    for (const expectedField of expectedSet.fields) {
      const actualField = actualFields.find((field) => field.key === expectedField[0]);
      const referenceKey = expectedField[5] || null;
      const actualReference = actualField && actualField.reference_set_id ? sets.find((set) => set.id === actualField.reference_set_id)?.key : null;
      if (!actualField || actualField.label !== expectedField[1] || actualField.value_type !== expectedField[2] || actualField.input_control !== expectedField[3] || actualField.required !== Number(expectedField[4]) || actualReference !== referenceKey) {
        throw new Error("기존 Canon Field 정의가 초기 템플릿과 다릅니다. 자동 병합하거나 보정하지 않습니다.");
      }
      const expectedOptions = expectedField[6] || [];
      const actualOptions = database.prepare("SELECT value, label FROM canon_field_options WHERE field_id = ? ORDER BY sort_order, id").all(actualField.id);
      if (actualOptions.length !== expectedOptions.length || actualOptions.some((option, index) => option.value !== expectedOptions[index][0] || option.label !== expectedOptions[index][1])) {
        throw new Error("기존 Canon option 정의가 초기 템플릿과 다릅니다. 자동 병합하거나 보정하지 않습니다.");
      }
    }
  }
}

/**
 * Work별 CanonSpace와 Set/Field/Option 정의를 하나의 transaction으로 생성한다.
 */
function createInitialDefinition(database, workId) {
  const existingSpace = database.prepare("SELECT id, template_key FROM canon_spaces WHERE work_id = ?").get(workId);
  if (existingSpace) {
    if (existingSpace.template_key !== INITIAL_TEMPLATE_KEY) {
      throw new Error("기존 CanonSpace 템플릿이 초기 템플릿과 다릅니다. 자동 병합하거나 보정하지 않습니다.");
    }
    assertCompleteDefinition(database, existingSpace.id);
    return { canonSpaceId: existingSpace.id, created: false };
  }

  const now = new Date().toISOString();
  const canonSpaceId = crypto.randomUUID();
  database.prepare("INSERT INTO canon_spaces (id, work_id, template_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(canonSpaceId, workId, INITIAL_TEMPLATE_KEY, now, now);
  const setIds = new Map();
  for (const [index, set] of CANON_SETS.entries()) {
    const id = crypto.randomUUID();
    setIds.set(set.key, id);
    database.prepare("INSERT INTO canon_sets (id, canon_space_id, key, name, record_name_label, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, canonSpaceId, set.key, set.name, set.recordNameLabel, null, index + 1, now, now);
  }
  for (const set of CANON_SETS) {
    for (const [index, field] of set.fields.entries()) {
      const fieldId = crypto.randomUUID();
      const referenceSetId = field[5] ? setIds.get(field[5]) : null;
      database.prepare("INSERT INTO canon_fields (id, canon_space_id, canon_set_id, key, label, value_type, input_control, reference_set_id, required, help_text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(fieldId, canonSpaceId, setIds.get(set.key), field[0], field[1], field[2], field[3], referenceSetId, Number(field[4]), null, index + 1, now, now);
      for (const [optionIndex, option] of (field[6] || []).entries()) {
        database.prepare("INSERT INTO canon_field_options (id, canon_space_id, canon_set_id, field_id, value, label, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)").run(crypto.randomUUID(), canonSpaceId, setIds.get(set.key), fieldId, option[0], option[1], optionIndex + 1);
      }
    }
  }
  return { canonSpaceId, created: true };
}

/**
 * 초기 Work와 Canon definition을 생성하거나, 완전히 일치하는 기존 정의를 재사용한다.
 */
function setupInitialNovelCanon() {
  const database = initializeDatabase();
  const backupPath = createDatabaseBackup(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const work = findOrCreateInitialWork(database);
    const canonSpace = createInitialDefinition(database, work.id);
    const recordCount = database.prepare("SELECT COUNT(*) AS count FROM canon_records WHERE canon_space_id = ?").get(canonSpace.canonSpaceId).count;
    if (recordCount !== 0) {
      throw new Error("초기 Canon 레코드가 이미 존재합니다. 이 설정 도구는 레코드를 생성하거나 수정하지 않습니다.");
    }
    database.exec("COMMIT");
    return { backupPath, work, canonSpace, setCount: CANON_SETS.length, fieldCount: CANON_SETS.reduce((count, set) => count + set.fields.length, 0), optionCount: 4, recordCount };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  try {
    const result = setupInitialNovelCanon();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("초기 Canon 설정 실패: " + error.message);
    process.exitCode = 1;
  }
}

module.exports = { CANON_SETS, INITIAL_TEMPLATE_KEY, INITIAL_WORK_TITLE, setupInitialNovelCanon };
