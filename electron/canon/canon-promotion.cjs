const { DatabaseSync } = require('node:sqlite');
const { getDatabase, withDatabaseConnection } = require('../database/database.cjs');
const staging = require('../database/repositories/canon-staging-repository.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { fail } = require('./canon-import.cjs');

/** Canon 미리보기용 독립 메모리 DB를 만들고 운영 연결에는 한 줄도 쓰지 않는다. */
function cloneCanon() {
  const source = getDatabase(), memory = new DatabaseSync(':memory:');
  try {
    const objects = source.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tables = objects.filter(row => row.type === 'table' && (row.name === 'works' || row.name.startsWith('canon_')) && !row.name.startsWith('canon_staging_'));
    const names = new Set(tables.map(row => row.name));
    for (const table of tables) {
      memory.exec(table.sql);
      const rows = source.prepare('SELECT * FROM "' + table.name + '" ORDER BY rowid').all();
      if (rows.length) {
        const keys = Object.keys(rows[0]);
        const insert = memory.prepare('INSERT INTO "' + table.name + '" (' + keys.map(key => '"' + key + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')');
        for (const row of rows) insert.run(...keys.map(key => row[key]));
      }
    }
    for (const object of objects.filter(row => row.type !== 'table' && names.has(row.tbl_name))) memory.exec(object.sql);
    memory.exec('PRAGMA foreign_keys = ON');
    return memory;
  } catch { memory.close(); fail('CANON_PROMOTION_PREVIEW_FAILED', '정식 Canon 검증용 미리보기를 준비하지 못했습니다.'); }
}
/** 진행 중 검토가 사용하는 Canon 입력을 승격으로 바꾸지 않도록 실행 직전 재확인한다. */
function assertUnlocked(scope) {
  if (getDatabase().prepare("SELECT 1 FROM review_jobs WHERE work_id = ? AND status IN ('QUEUED', 'RUNNING') UNION ALL SELECT 1 FROM review_runs WHERE work_id = ? AND status = 'RUNNING' LIMIT 1").get(scope.workId, scope.workId)) fail('CANON_PROMOTION_REVIEW_LOCKED', '이 작품의 검토 대기 또는 실행이 끝난 뒤 정식 Canon을 등록해 주세요.');
}
/** 승인할 후보를 같은 공간에서 다시 읽고 순번·중복·배치 상한을 검사한다. */
function selectionRows(scope, selection) {
  staging.requireScope(scope);
  if (!Array.isArray(selection) || !selection.length || selection.length > 2000 || new Set(selection.map(item => item?.id)).size !== selection.length) fail('CANON_PROMOTION_SELECTION_INVALID', '중복되지 않은 등록 대기 후보를 선택해 주세요.');
  return selection.map(item => {
    const row = staging.get(scope, item?.id);
    if (!Number.isSafeInteger(item.expectedRevision) || row.revision !== item.expectedRevision) fail('CANON_STAGING_REVISION_CONFLICT', '선택한 후보가 변경되었습니다. 최신 목록에서 다시 선택해 주세요.');
    if (item.existingRecordId !== undefined && (typeof item.existingRecordId !== 'string' || !item.existingRecordId)) fail('CANON_PROMOTION_SELECTION_INVALID', '연결할 공식 Canon 항목을 확인해 주세요.');
    return { row, existingRecordId: item.existingRecordId };
  });
}
/** 논리키는 승인된 UUID만 사용하고 Option은 실제 Definition의 값 또는 ID로 해석한다. */
function toInput(row, definition, mapping) {
  const { candidate } = row, fieldValues = {};
  const byKey = new Map(definition.fields.map(field => [field.key, field]));
  for (const key of Object.keys(candidate.fields)) if (!byKey.has(key) || byKey.get(key).referenceSet) fail('CANON_STAGING_FIELD_CONFLICT', '현재 Definition에 없는 일반 필드 또는 references로 옮겨야 할 값이 있습니다.');
  for (const key of Object.keys(candidate.references)) if (!byKey.get(key)?.referenceSet) fail('CANON_STAGING_FIELD_CONFLICT', '현재 Definition에 없는 참조 필드가 있습니다.');
  for (const field of definition.fields) {
    let value = (field.referenceSet ? candidate.references : candidate.fields)[field.key] ?? null;
    if (field.referenceSet && value !== null && value !== '') {
      const keys = Array.isArray(value) ? value : [value];
      if (keys.some(key => typeof key !== 'string')) fail('CANON_STAGING_REFERENCE_INVALID', "'" + field.label + "' 참조는 논리키 또는 직접 선택한 공식 항목이어야 합니다.");
      const ids = keys.map(key => {
        const id = key.startsWith('record:') ? key.slice(7) : mapping.get(key);
        if (!id) fail('CANON_STAGING_REFERENCE_UNRESOLVED', "'" + field.label + "'의 논리 참조를 먼저 등록하거나 이번 배치에 함께 선택해 주세요.");
        return id;
      });
      value = field.valueType.endsWith('MANY') ? (Array.isArray(value) ? ids : value) : (Array.isArray(value) ? ids : ids[0]);
    } else if (field.valueType.startsWith('OPTION') && value !== null && value !== '') {
      const convert = selected => field.options.find(option => option.value === selected || option.id === selected)?.id ?? selected;
      value = Array.isArray(value) ? value.map(convert) : convert(value);
    }
    fieldValues[field.id] = value;
  }
  return { displayName: candidate.display_name, fieldValues };
}
/** 배치에 속한 논리 참조 의존성을 찾으며 잘못된 타입은 후속 Repository 검사로 보낸다. */
function dependencies(row) { return Object.values(row.candidate.references).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string' && !value.startsWith('record:')); }
/** 필드 값의 순서 없는 다중 선택을 정규화하여 기존 항목 연결의 정확한 일치를 확인한다. */
function equalValues(left, right) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every(key => JSON.stringify(Array.isArray(left[key]) ? [...left[key]].sort() : left[key] ?? null) === JSON.stringify(Array.isArray(right[key]) ? [...right[key]].sort() : right[key] ?? null));
}
/** 기존 UUID 연결과 승인 후 생성할 배치 참조를 구별하여 미리보기에서 실제 적용 대상을 설명한다. */
function referenceTargets(scope, row, all, selected) {
  return Object.entries(row.candidate.references).flatMap(([fieldKey, value]) => (Array.isArray(value) ? value : value === null ? [] : [value]).map(key => {
    const candidate = all.find(item => item.draftKey === key);
    const id = typeof key === 'string' && key.startsWith('record:') ? key.slice(7) : candidate?.promotion?.recordId;
    const official = id ? getDatabase().prepare('SELECT id, display_name FROM canon_records WHERE id = ? AND canon_space_id = ?').get(id, scope.canonSpaceId) : null;
    return { fieldKey, target: typeof key === 'string' ? key : '', recordId: official?.id ?? null, displayName: official?.display_name ?? candidate?.candidate.display_name ?? null, source: official ? 'OFFICIAL' : candidate && selected.some(item => item.row.id === candidate.id) ? 'BATCH' : 'UNRESOLVED' };
  }));
}
/** 기존 Repository 생성·의미 검증을 그대로 실행하여 후보별 등록 가능 결과와 UUID 매핑을 만든다. */
function executePlan(scope, selected, all, installed, commit) {
  const mapping = new Map(all.filter(row => row.promotion?.recordId).map(row => [row.draftKey, row.promotion.recordId]));
  const waiting = [...selected], entries = [], db = getDatabase();
  while (waiting.length) {
    let progressed = false;
    for (const item of [...waiting]) {
      const { row, existingRecordId } = item;
      if (!row.promotion && dependencies(row).some(key => waiting.some(other => other.row.draftKey === key) && !mapping.has(key))) continue;
      waiting.splice(waiting.indexOf(item), 1); progressed = true;
      let status = 'READY', errors = [], official = null, input = null;
      const definition = installed.find(set => set.key === row.setKey);
      try {
        if (row.promotion) {
          if (!row.promotion.recordId || !definition) fail('CANON_STAGING_PROMOTED_TARGET_MISSING', '연결했던 공식 Canon이 삭제되었습니다. 기존 승인 이력을 확인해 주세요.');
          official = records.getById({ canonSpaceId: scope.canonSpaceId, setId: definition.id }, row.promotion.recordId); status = 'PROMOTED';
        } else {
          if (row.source.author_private === true || row.candidate.author_private === true) fail('CANON_STAGING_PRIVATE_BLOCKED', '작가 전용 비공개 후보는 V1에서 정식 등록할 수 없습니다.');
          if (!definition) fail('CANON_STAGING_DEFINITION_MISSING', '이 분류의 현재 Definition을 확인해 주세요.');
          input = toInput(row, definition, mapping);
          const recordScope = { canonSpaceId: scope.canonSpaceId, setId: definition.id };
          if (existingRecordId) {
            official = records.getById(recordScope, existingRecordId);
            if (official.displayName !== input.displayName.trim() || !equalValues(official.fieldValues, input.fieldValues)) fail('CANON_STAGING_LINK_CONFLICT', '직접 선택한 공식 항목의 이름·필드·참조가 후보와 정확히 일치하지 않습니다. 병합하거나 덮어쓰지 않습니다.');
            records.validateExistingForPromotion(recordScope, existingRecordId, input);
          } else {
            if (records.getBySetId(recordScope).some(record => record.displayName.trim().toLocaleLowerCase() === input.displayName.trim().toLocaleLowerCase())) fail('CANON_STAGING_NAME_CONFLICT', '같은 분류에 동일 이름이 있습니다. 공식 항목을 직접 선택해 연결하거나 후보 이름을 검토해 주세요.');
            official = records.create(recordScope, input);
          }
          if (commit) db.prepare('INSERT INTO canon_staging_promotions VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, definition.id, official.id, official.id, row.revision, existingRecordId ? 'LINK' : 'CREATE', new Date().toISOString());
        }
        mapping.set(row.draftKey, official.id);
      } catch (error) {
        if (commit) throw error;
        status = error.code === 'CANON_STAGING_PRIVATE_BLOCKED' ? 'DRAFT' : /CONFLICT|SCOPE|SELF_REFERENCE|UNIQUE|INVALID|TYPE_CHANGE/.test(error.code ?? '') ? 'CONFLICT' : 'NEEDS_INPUT';
        errors = [error instanceof RepositoryError ? error.message : '현재 Canon 규칙에 맞게 후보를 확인해 주세요.'];
      }
      entries.push({ id: row.id, draftKey: row.draftKey, setKey: row.setKey, displayName: row.candidate.display_name, revision: row.revision, authorPrivate: row.source.author_private === true || row.candidate.author_private === true, status, errors, mode: row.promotion ? 'REUSE' : existingRecordId ? 'LINK' : 'CREATE', recordId: commit || row.promotion || existingRecordId ? official?.id ?? null : null, fields: row.candidate.fields, references: row.candidate.references });
    }
    if (!progressed) {
      if (commit) fail('CANON_STAGING_REFERENCE_CYCLE', '선택한 후보 사이에 순환 참조가 있습니다. 참조를 정리한 뒤 다시 실행해 주세요.');
      for (const { row } of waiting) entries.push({ id: row.id, draftKey: row.draftKey, setKey: row.setKey, displayName: row.candidate.display_name, revision: row.revision, status: 'CONFLICT', errors: ['선택한 후보의 순환 참조를 해결해 주세요.'], mode: 'CREATE', authorPrivate: row.source.author_private === true || row.candidate.author_private === true, fields: row.candidate.fields, references: row.candidate.references, recordId: null });
      break;
    }
  }
  return entries;
}
/** 운영 DB에는 쓰지 않고 독립 메모리 DB에서 동일 Repository로 배치를 검증한다. */
function preview(scope, selection) {
  const selected = selectionRows(scope, selection), all = staging.list(scope), installed = staging.definitions(scope), fingerprint = staging.fingerprint(scope);
  const memory = cloneCanon();
  try {
    const entries = withDatabaseConnection(memory, () => executePlan(scope, selected, all, installed, false));
    return { entries: entries.map(entry => ({ ...entry, referenceTargets: referenceTargets(scope, selected.find(item => item.row.id === entry.id).row, all, selected) })), canExecute: entries.every(row => ['READY', 'PROMOTED'].includes(row.status)), fingerprint };
  } finally { memory.close(); }
}
/** 전체 후보를 한 메모리 배치로 검사하며 임시 참조 후보도 공식 조회에는 포함하지 않는다. */
function overview(scope) {
  const rows = staging.list(scope), installed = staging.definitions(scope);
  const plan = rows.length ? preview(scope, rows.map(row => ({ id: row.id, expectedRevision: row.revision }))) : { entries: [] };
  return { definitions: installed, officialRecords: installed.flatMap(set => records.getBySetId({ canonSpaceId: scope.canonSpaceId, setId: set.id })), records: rows.map(row => ({ ...row, validation: plan.entries.find(entry => entry.id === row.id) })) };
}
/** 최종 승인 snapshot을 재검증하고 배치와 승인 연결 모두를 한 transaction으로 확정한다. */
function promote(scope, selection, expectedFingerprint) {
  return staging.transaction(() => {
    assertUnlocked(scope);
    if (staging.fingerprint(scope) !== expectedFingerprint) fail('CANON_STAGING_STALE_PREVIEW', '미리보기 이후 Canon 또는 후보가 변경되었습니다. 다시 검증해 주세요.');
    const selected = selectionRows(scope, selection), all = staging.list(scope), installed = staging.definitions(scope);
    return { entries: executePlan(scope, selected, all, installed, true) };
  });
}
module.exports = { preview, overview, promote, assertUnlocked };
