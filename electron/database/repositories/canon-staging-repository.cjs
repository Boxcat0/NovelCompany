const { randomUUID } = require('node:crypto');
const { getDatabase } = require('../database.cjs');
const { getCanonDefinitionBySetId } = require('./canon-definition-repository.cjs');
const { RepositoryError } = require('./repository-error.cjs');
const { fail, hash, inspectJson, validateCandidate } = require('../../canon/canon-import.cjs');

/** 작품과 공간의 실제 소속을 확인하고 교차 범위에는 동일한 공개 오류만 반환한다. */
function requireScope(scope) {
  if (!scope || typeof scope.workId !== 'string' || typeof scope.canonSpaceId !== 'string' || !getDatabase().prepare('SELECT 1 FROM canon_spaces WHERE id = ? AND work_id = ?').get(scope.canonSpaceId, scope.workId)) fail('CANON_STAGING_SCOPE_INVALID', '선택한 작품의 CanonSpace를 확인해 주세요.');
  return scope;
}
/** 현재 설치된 Definition만 읽으며 Template을 자동 생성하거나 보정하지 않는다. */
function definitions(scope) {
  requireScope(scope);
  return getDatabase().prepare('SELECT id FROM canon_sets WHERE canon_space_id = ? ORDER BY sort_order, id').all(scope.canonSpaceId).map(row => getCanonDefinitionBySetId(row.id));
}
/** 원본과 작가 수정본 및 승인 연결을 별도 속성으로 복원한다. */
function mapRow(row) {
  return { id: row.id, setKey: row.set_key, draftKey: row.draft_key, source: JSON.parse(row.source_json), candidate: JSON.parse(row.current_json), revision: row.revision, authorEdited: Boolean(row.author_edited), createdAt: row.created_at, updatedAt: row.updated_at,
    promotion: row.record_uuid ? { recordId: row.record_id, recordUuid: row.record_uuid, setId: row.canon_set_id, approvedRevision: row.approved_revision, approvedAt: row.approved_at, mode: row.mode } : null };
}
const query = 'SELECT s.*, p.record_id, p.record_uuid, p.canon_set_id, p.approved_revision, p.approved_at, p.mode FROM canon_staging_records s LEFT JOIN canon_staging_promotions p ON p.staging_record_id = s.id';
/** 선택 공간의 Staging만 전용 경로로 읽는다. */
function list(scope) { requireScope(scope); return getDatabase().prepare(query + ' WHERE s.canon_space_id = ? AND s.work_id = ? ORDER BY s.created_at, s.id').all(scope.canonSpaceId, scope.workId).map(mapRow); }
/** ID와 Work/CanonSpace를 함께 확인하여 다른 작품의 후보 정보를 노출하지 않는다. */
function get(scope, id) {
  requireScope(scope);
  if (typeof id !== 'string') fail('CANON_STAGING_NOT_FOUND', '해당 범위의 등록 대기 후보를 찾을 수 없습니다.');
  const row = getDatabase().prepare(query + ' WHERE s.id = ? AND s.canon_space_id = ? AND s.work_id = ?').get(id, scope.canonSpaceId, scope.workId);
  if (!row) fail('CANON_STAGING_NOT_FOUND', '해당 범위의 등록 대기 후보를 찾을 수 없습니다.');
  return mapRow(row);
}
/** scope에 속한 Canon 정의·Record·값·Staging 상태를 해시하여 승인 후 변경을 감지한다. */
function fingerprint(scope) {
  const db = getDatabase(); requireScope(scope);
  const tables = ['canon_sets', 'canon_fields', 'canon_field_options', 'canon_records', 'canon_field_values', 'canon_record_option_values', 'canon_record_references', 'canon_staging_records'];
  return hash(JSON.stringify(tables.map(table => db.prepare('SELECT * FROM ' + table + ' WHERE canon_space_id = ? ORDER BY rowid').all(scope.canonSpaceId))) + JSON.stringify(list(scope)));
}
/** Staging 쓰기 전체를 transaction으로 보호하고 내부 오류에 원문이나 SQL을 첨부하지 않는다. */
function transaction(action) {
  const db = getDatabase(); db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); if (error instanceof RepositoryError) throw error; fail('CANON_STAGING_SAVE_FAILED', '등록 대기 변경을 저장하지 못했습니다. 변경사항은 취소되었습니다.'); }
}
/** 원본이 달라진 동일 논리키는 자동 갱신하지 않고 변경 전후와 충돌 종류를 보고한다. */
function previewImport(scope, parsed) {
  const installed = definitions(scope), existing = list(scope), byKey = new Map(existing.map(row => [row.draftKey, row]));
  for (const key of Object.keys(parsed.counts)) if (!installed.some(set => set.key === key)) fail('CANON_STAGING_DEFINITION_MISSING', '파일에 필요한 CanonSet Definition이 없습니다. 기존 정의 설치 상태를 확인해 주세요.');
  const alreadyImported = Boolean(getDatabase().prepare('SELECT 1 FROM canon_staging_imports WHERE canon_space_id = ? AND source_hash = ?').get(scope.canonSpaceId, parsed.sourceHash));
  const knownKeys = new Set([...existing.map(row => row.draftKey), ...parsed.candidates.map(item => item.candidate.draft_key)]);
  const items = parsed.candidates.map(({ setKey, candidate }) => {
    const old = byKey.get(candidate.draft_key);
    const unchanged = old && JSON.stringify(old.source) === JSON.stringify(candidate);
    const action = !old ? 'NEW' : unchanged ? 'REUSE' : old.promotion ? 'CONFLICT_PROMOTED' : old.authorEdited ? 'CONFLICT_EDITED' : 'CONFLICT_SOURCE_CHANGED';
    const set = installed.find(item => item.key === setKey);
    const issues = [];
    for (const field of set.fields) {
      const value = (field.referenceSet ? candidate.references : candidate.fields)[field.key];
      if (field.required && (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0))) issues.push("'" + field.label + "' 필수값이 미확정입니다.");
      if (field.referenceSet && value !== undefined && value !== null) for (const key of Array.isArray(value) ? value : [value]) {
        if (typeof key !== 'string' || (!key.startsWith('record:') && !knownKeys.has(key))) issues.push("'" + field.label + "' 논리 참조를 찾을 수 없습니다.");
      }
      if (field.valueType.startsWith('OPTION') && value !== undefined && value !== null && !(Array.isArray(value) ? value : [value]).every(id => field.options.some(option => option.value === id || option.id === id))) issues.push("'" + field.label + "' 선택값을 확인해 주세요.");
    }
    const nameConflict = getDatabase().prepare('SELECT COUNT(*) n FROM canon_records WHERE canon_space_id = ? AND canon_set_id = ? AND trim(display_name) = ? COLLATE NOCASE').get(scope.canonSpaceId, set.id, candidate.display_name.trim()).n > 0;
    return { draftKey: candidate.draft_key, setKey, displayName: candidate.display_name, action, nameConflict, issues, authorPrivate: candidate.author_private === true || old?.source.author_private === true, before: old?.candidate ?? null, after: candidate };
  });
  return { alreadyImported, sourceHash: parsed.sourceHash, sourceVersion: parsed.document.version, workTitle: parsed.document.work_title, counts: parsed.counts, total: items.length, privateCount: items.filter(item => item.authorPrivate).length,
    newCount: items.filter(item => item.action === 'NEW').length, reusedCount: items.filter(item => item.action === 'REUSE').length, conflictCount: items.filter(item => item.action.startsWith('CONFLICT')).length, holdCount: items.filter(item => item.authorPrivate || item.issues.length > 0).length, nameConflictCount: items.filter(item => item.nameConflict).length, items, fingerprint: fingerprint(scope) };
}
/** 명시적 승인된 파일만 Staging에 원자적으로 넣고 같은 SHA 및 논리키를 재사용한다. */
function importCandidates(scope, parsed, fileName, expectedFingerprint) {
  return transaction(() => {
    const preview = previewImport(scope, parsed);
    if (preview.fingerprint !== expectedFingerprint) fail('CANON_STAGING_STALE_PREVIEW', '미리보기 이후 데이터가 변경되었습니다. 파일을 다시 선택해 주세요.');
    if (preview.alreadyImported) return { alreadyImported: true, createdCount: 0, reusedCount: parsed.candidates.length };
    if (preview.conflictCount) fail('CANON_IMPORT_CONFLICT', '변경된 동일 논리키가 있습니다. 기존 작가 수정과 승인 연결을 보존하기 위해 Import를 중단했습니다.');
    const db = getDatabase(), id = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO canon_staging_imports (id, work_id, canon_space_id, file_name, source_hash, format_version, candidate_count, result_json, source_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, scope.workId, scope.canonSpaceId, fileName, parsed.sourceHash, 'NOVELCOMPANY_CANON_JSON_V1', parsed.candidates.length, JSON.stringify({ status: 'IMPORTED', createdCount: preview.newCount, reusedCount: preview.reusedCount }), parsed.snapshot, now);
    for (const item of parsed.candidates) {
      if (preview.items.find(row => row.draftKey === item.candidate.draft_key).action !== 'NEW') continue;
      const json = JSON.stringify(item.candidate);
      db.prepare('INSERT INTO canon_staging_records (id, work_id, canon_space_id, import_id, set_key, draft_key, source_json, current_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), scope.workId, scope.canonSpaceId, id, item.setKey, item.candidate.draft_key, json, json, now, now);
    }
    return { importId: id, alreadyImported: false, createdCount: preview.newCount, reusedCount: preview.reusedCount };
  });
}
/** 미확정 값을 유지하는 작가 수정을 CAS 저장하고 원본 비공개 및 승격된 후보를 보호한다. */
function update(scope, id, input) {
  if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.authorPrivate !== 'boolean' || JSON.stringify(input).length > 300000) fail('CANON_STAGING_INPUT_INVALID', '후보의 입력 크기와 수정 순번·비공개 표시를 확인해 주세요.');
  inspectJson(input);
  return transaction(() => {
    const current = get(scope, id);
    if (current.revision !== input.expectedRevision) fail('CANON_STAGING_REVISION_CONFLICT', '다른 화면에서 후보가 변경되었습니다. 최신 후보를 다시 불러와 주세요.');
    if (current.promotion) fail('CANON_STAGING_ALREADY_PROMOTED', '이미 등록한 후보는 변경할 수 없습니다. 공식 Canon에서 직접 검토해 주세요.');
    const candidate = { ...current.candidate, display_name: input.displayName, fields: input.fields, references: input.references, author_private: current.source.author_private === true || input.authorPrivate === true };
    validateCandidate(candidate, current.setKey);
    const json = JSON.stringify(candidate);
    if (json !== JSON.stringify(current.candidate)) getDatabase().prepare('UPDATE canon_staging_records SET current_json = ?, author_edited = 1, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(json, new Date().toISOString(), id, input.expectedRevision);
    return get(scope, id);
  });
}
module.exports = { requireScope, definitions, list, get, fingerprint, transaction, previewImport, importCandidates, update };
