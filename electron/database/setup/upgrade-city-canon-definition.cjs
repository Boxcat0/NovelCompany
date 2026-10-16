const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase, initializeDatabase, closeDatabase } = require('../database.cjs');
const { getDatabaseFilePath } = require('../../storage/storage-paths.cjs');
const { RepositoryError } = require('../repositories/repository-error.cjs');
const { CITY_CANON_SET } = require('./initial-canon-definition.cjs');

/** 명시한 작품·공간과 상위 지역 정의 및 기존 City 호환성을 읽기 전용으로 확인한다. */
function inspectCityDefinitionUpgrade(db, scope) {
  if (!scope || ['workId', 'canonSpaceId'].some(key => typeof scope[key] !== 'string' || !scope[key].trim())) {
    throw new RepositoryError('CANON_SCOPE_INVALID', '작품 ID와 CanonSpace ID를 모두 지정해 주세요.');
  }
  const space = db.prepare('SELECT id, work_id FROM canon_spaces WHERE id = ?').get(scope.canonSpaceId);
  if (!space) throw new RepositoryError('CANON_SPACE_NOT_FOUND', 'CanonSpace가 없습니다. 먼저 해당 작품의 Canon을 시작해 주세요.');
  if (space.work_id !== scope.workId) throw new RepositoryError('CANON_REFERENCE_SCOPE_MISMATCH', '지정한 작품과 CanonSpace가 일치하지 않습니다.');
  const sets = db.prepare('SELECT * FROM canon_sets WHERE canon_space_id = ? ORDER BY id').all(space.id);
  if (!sets.length) throw new RepositoryError('CANON_CITY_BOOTSTRAP_REQUIRED', '빈 CanonSpace에는 기존 명시적 Definition 설치 경로를 사용해 주세요.');
  const location = sets.find(set => set.key === 'location');
  const world = sets.find(set => set.key === 'world');
  const worldField = location && db.prepare("SELECT * FROM canon_fields WHERE canon_set_id = ? AND key = 'world'").get(location.id);
  if (!location || !world || !worldField || worldField.canon_space_id !== space.id || worldField.value_type !== 'REFERENCE_ONE' || worldField.input_control !== 'COMBOBOX' || worldField.required !== 1 || worldField.reference_set_id !== world.id) {
    throw new RepositoryError('CANON_CITY_PARENT_INVALID', '같은 CanonSpace의 지역과 필수 세계 참조 정의를 확인해 주세요. City 추가를 중단했습니다.');
  }
  const city = sets.find(set => set.key === CITY_CANON_SET.key);
  if (city) {
    const fields = db.prepare('SELECT * FROM canon_fields WHERE canon_set_id = ? ORDER BY sort_order, id').all(city.id);
    const compatible = city.name === CITY_CANON_SET.name && city.record_name_label === CITY_CANON_SET.recordNameLabel && fields.length === CITY_CANON_SET.fields.length && fields.every((field, index) => {
      const expected = CITY_CANON_SET.fields[index];
      return field.canon_space_id === space.id && field.key === expected[0] && field.label === expected[1] && field.value_type === expected[2] && field.input_control === expected[3] && field.required === Number(expected[4]) && field.reference_set_id === (expected[5] ? location.id : null) && field.sort_order === index + 1 && db.prepare('SELECT COUNT(*) n FROM canon_field_options WHERE field_id = ?').get(field.id).n === 0;
    });
    if (!compatible) throw new RepositoryError('CANON_CITY_DEFINITION_CONFLICT', '기존 City 정의가 요청한 구조와 다릅니다. 기존 설정을 덮어쓰지 않고 중단했습니다.');
  }
  return { workId: scope.workId, canonSpaceId: space.id, locationSetId: location.id, worldSetId: world.id, worldFieldId: worldField.id, citySetId: city?.id ?? null };
}

/** 호출자의 transaction 안에서 City Set과 두 Field만 추가하고 기존 정의·Record는 보존한다. */
function addCityDefinition(db, scope) {
  const target = inspectCityDefinitionUpgrade(db, scope);
  if (target.citySetId) return target;
  const id = randomUUID();
  const now = new Date().toISOString();
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 n FROM canon_sets WHERE canon_space_id = ?').get(target.canonSpaceId).n;
  db.prepare('INSERT INTO canon_sets (id, canon_space_id, key, name, record_name_label, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)')
    .run(id, target.canonSpaceId, CITY_CANON_SET.key, CITY_CANON_SET.name, CITY_CANON_SET.recordNameLabel, order, now, now);
  for (const [index, field] of CITY_CANON_SET.fields.entries()) {
    db.prepare('INSERT INTO canon_fields (id, canon_space_id, canon_set_id, key, label, value_type, input_control, required, reference_set_id, help_text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(randomUUID(), target.canonSpaceId, id, field[0], field[1], field[2], field[3], Number(field[4]), field[5] ? target.locationSetId : null, index + 1, now, now);
  }
  return inspectCityDefinitionUpgrade(db, scope);
}

/** 대상 재확인·별도 백업 뒤 명시한 공간에만 City를 원자적으로 추가하며 재실행은 No-op이다. */
function upgradeCityCanonDefinition(scope) {
  const db = getDatabase();
  const before = inspectCityDefinitionUpgrade(db, scope);
  if (before.citySetId) return { ...before, created: false, backupPath: null };
  const databaseFile = db.prepare('PRAGMA database_list').all().find(entry => entry.name === 'main').file;
  if (!databaseFile) throw new RepositoryError('CANON_CITY_BACKUP_FAILED', '백업할 DB 파일을 확인할 수 없어 City 추가를 중단했습니다.');
  const backupDirectory = path.join(path.dirname(databaseFile), 'backups');
  const backupPath = path.join(backupDirectory, 'before-city-canon-upgrade-' + randomUUID() + '.db');
  if (JSON.stringify(inspectCityDefinitionUpgrade(db, scope)) !== JSON.stringify(before)) throw new RepositoryError('CANON_CITY_TARGET_CHANGED', 'City 추가 대상이 변경되었습니다. 작품과 CanonSpace를 다시 확인해 주세요.');
  try {
    fs.mkdirSync(backupDirectory, { recursive: true });
    db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  } catch (cause) {
    throw new RepositoryError('CANON_CITY_BACKUP_FAILED', 'DB 백업을 만들지 못해 City 추가를 중단했습니다.', cause);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (JSON.stringify(inspectCityDefinitionUpgrade(db, scope)) !== JSON.stringify(before)) throw new RepositoryError('CANON_CITY_TARGET_CHANGED', '백업 이후 City 추가 대상이 변경되었습니다. 다시 확인해 주세요.');
    const result = addCityDefinition(db, scope);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('City reference validation failed');
    db.exec('COMMIT');
    return { ...result, created: true, backupPath };
  } catch (cause) {
    db.exec('ROLLBACK');
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError('CANON_CITY_UPGRADE_FAILED', 'City 정의를 추가하지 못했습니다. 변경사항은 모두 취소되었습니다.', cause);
  }
}

/** 운영 CLI의 명시적 Work·CanonSpace를 읽기 전용으로 확인하고 최신 DB에서만 업그레이드한다. */
function runCityUpgrade(scope) {
  const file = getDatabaseFilePath();
  const readonly = new DatabaseSync(file, { readOnly: true });
  try {
    if (readonly.prepare('SELECT MAX(version) version FROM schema_migrations').get().version !== 16) throw new RepositoryError('CANON_CITY_SCHEMA_NOT_READY', '먼저 앱의 기존 DB migration을 완료한 뒤 City 추가를 실행해 주세요.');
    inspectCityDefinitionUpgrade(readonly, scope);
  } finally { readonly.close(); }
  try { initializeDatabase(file); return upgradeCityCanonDefinition(scope); }
  finally { closeDatabase(); }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--work' || process.argv[4] !== '--canon-space') throw new RepositoryError('CANON_SCOPE_INVALID', '--work <작품 ID> --canon-space <공간 ID>를 지정해 주세요.');
    console.log(JSON.stringify(runCityUpgrade({ workId: process.argv[3], canonSpaceId: process.argv[5] }), null, 2));
  } catch (cause) {
    console.error(cause instanceof RepositoryError ? cause.code + ': ' + cause.message : 'City 정의 추가를 준비하지 못했습니다. DB와 대상 ID를 확인해 주세요.');
    process.exitCode = 1;
  }
}

module.exports = { inspectCityDefinitionUpgrade, addCityDefinition, upgradeCityCanonDefinition, runCityUpgrade };
