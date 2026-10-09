const { randomUUID } = require('node:crypto');
const { getDatabase } = require('../database.cjs');
const { RepositoryError } = require('./repository-error.cjs');
const { normalizeName } = require('../../context/character-name-normalization.cjs');

/** Work와 현재 CanonSpace 및 character Record 범위를 조회/변경마다 검증한다. */
function requireCharacter(scope) {
  if (!scope || typeof scope.workId !== 'string' || !scope.workId.trim() || typeof scope.recordId !== 'string' || !scope.recordId.trim()) throw new RepositoryError('CANON_ALIAS_SCOPE_INVALID', '작품과 캐릭터를 선택해 주세요.');
  const db = getDatabase();
  if (!db.prepare('SELECT 1 FROM works WHERE id = ?').get(scope.workId)) throw new RepositoryError('WORK_NOT_FOUND', '작품을 찾을 수 없습니다.');
  const space = db.prepare('SELECT id FROM canon_spaces WHERE work_id = ?').get(scope.workId);
  if (!space) throw new RepositoryError('CANON_SPACE_NOT_FOUND', '이 작품에는 시작된 Canon이 없습니다.');
  const record = db.prepare('SELECT r.id, r.display_name, s.key FROM canon_records r JOIN canon_sets s ON s.id = r.canon_set_id AND s.canon_space_id = r.canon_space_id WHERE r.id = ? AND r.canon_space_id = ?').get(scope.recordId, space.id);
  if (!record) throw new RepositoryError('CANON_RECORD_NOT_FOUND', '이 작품의 캐릭터를 찾을 수 없습니다.');
  if (record.key !== 'character') throw new RepositoryError('CANON_ALIAS_CHARACTER_REQUIRED', '캐릭터 항목에서만 별칭을 관리할 수 있습니다.');
  return record;
}

/** 내부 정규화 값 대신 공개 Alias DTO만 반환한다. */
function toAlias(row) { return { id: row.id, recordId: row.canon_record_id, aliasText: row.alias_text, createdAt: row.created_at, updatedAt: row.updated_at }; }

/** 현재 Character 별칭을 정규화 이름과 ID 기준으로 결정적으로 정렬한다. */
function list(scope) {
  requireCharacter(scope);
  return getDatabase().prepare('SELECT * FROM canon_record_aliases WHERE canon_record_id = ? ORDER BY normalized_alias COLLATE BINARY, id').all(scope.recordId).map(toAlias);
}

/** 문자열·제어문자·정식 이름·동일 Character 중복을 검증하여 표시/비교 값을 분리한다. */
function validateAlias(scope, record, aliasText, aliasId) {
  if (typeof aliasText !== 'string' || !aliasText.trim() || aliasText.trim().length > 200 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(aliasText)) throw new RepositoryError('CANON_ALIAS_INVALID', '별칭은 제어문자나 줄바꿈 없이 1~200자로 입력해 주세요.');
  const normalized = normalizeName(aliasText);
  if (normalized === normalizeName(record.display_name)) throw new RepositoryError('CANON_ALIAS_SAME_AS_NAME', '이 캐릭터의 정식 이름과 같은 별칭은 등록할 수 없습니다.');
  if (getDatabase().prepare('SELECT 1 FROM canon_record_aliases WHERE canon_record_id = ? AND normalized_alias = ? AND id != ?').get(scope.recordId, normalized, aliasId ?? '')) throw new RepositoryError('CANON_ALIAS_DUPLICATE', '이 캐릭터에 이미 등록된 별칭입니다.');
  return { text: aliasText.trim(), normalized };
}

/** 같은 Character에 속한 Alias ID만 조회하여 다른 Record의 변경/삭제를 막는다. */
function requireAlias(scope, aliasId) {
  if (typeof aliasId !== 'string' || !aliasId.trim()) throw new RepositoryError('CANON_ALIAS_NOT_FOUND', '별칭을 찾을 수 없습니다.');
  const row = getDatabase().prepare('SELECT * FROM canon_record_aliases WHERE id = ? AND canon_record_id = ?').get(aliasId, scope.recordId);
  if (!row) throw new RepositoryError('CANON_ALIAS_NOT_FOUND', '이 캐릭터의 별칭을 찾을 수 없습니다.');
  return row;
}

/** Canon Alias 쓰기를 한 transaction에 처리하며 실패 시 Record/별칭을 모두 보존한다. */
function mutate(action) {
  const db = getDatabase(); db.exec('BEGIN IMMEDIATE');
  try { const result = action(db); db.exec('COMMIT'); return result; }
  catch (cause) { db.exec('ROLLBACK'); if (cause instanceof RepositoryError) throw cause; throw new RepositoryError('CANON_ALIAS_SAVE_FAILED', '별칭을 처리하지 못했습니다.', cause); }
}

/** 먼저 저장된 Character에 별칭 한 개를 등록하며 Episode 잠금은 적용하지 않는다. */
function create(scope, aliasText) {
  return mutate(db => {
    const record = requireCharacter(scope); const value = validateAlias(scope, record, aliasText, null);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare('INSERT INTO canon_record_aliases VALUES (?, ?, ?, ?, ?, ?)').run(id, record.id, value.text, value.normalized, now, now);
    return toAlias(requireAlias(scope, id));
  });
}

/** 작품·Character·Alias 범위를 재검증한 후 해당 별칭만 수정한다. */
function update(scope, aliasId, aliasText) {
  return mutate(db => {
    const record = requireCharacter(scope); requireAlias(scope, aliasId);
    const value = validateAlias(scope, record, aliasText, aliasId);
    db.prepare('UPDATE canon_record_aliases SET alias_text = ?, normalized_alias = ?, updated_at = ? WHERE id = ? AND canon_record_id = ?').run(value.text, value.normalized, new Date().toISOString(), aliasId, record.id);
    return toAlias(requireAlias(scope, aliasId));
  });
}

/** 별칭만 삭제하며 대상 Character와 Canon Field 값은 변경하지 않는다. */
function deleteAlias(scope, aliasId) {
  return mutate(db => { requireCharacter(scope); requireAlias(scope, aliasId); db.prepare('DELETE FROM canon_record_aliases WHERE id = ? AND canon_record_id = ?').run(aliasId, scope.recordId); return { id: aliasId, recordId: scope.recordId }; });
}

/** Main의 WorkContext 로더에 같은 작품의 Character별 표시 별칭만 묶어 제공한다. */
function loadForWork(workId) {
  const rows = getDatabase().prepare("SELECT a.canon_record_id, a.alias_text FROM canon_record_aliases a JOIN canon_records r ON r.id = a.canon_record_id JOIN canon_spaces cs ON cs.id = r.canon_space_id JOIN canon_sets s ON s.id = r.canon_set_id WHERE cs.work_id = ? AND s.key = 'character' ORDER BY a.normalized_alias COLLATE BINARY, a.canon_record_id").all(workId);
  const grouped = new Map();
  for (const row of rows) { if (!grouped.has(row.canon_record_id)) grouped.set(row.canon_record_id, []); grouped.get(row.canon_record_id).push(row.alias_text); }
  return grouped;
}

module.exports = { list, create, update, delete: deleteAlias, loadForWork };
