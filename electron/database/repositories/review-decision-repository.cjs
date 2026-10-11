const { randomUUID } = require('node:crypto');
const { getDatabase } = require('../database.cjs');
const { RepositoryError } = require('./repository-error.cjs');
const statuses = new Set(['NEEDS_FIX', 'REJECTED', 'DEFERRED', 'RESOLVED']);
const NOTE_LIMIT = 4000;

/** 외부 입력의 ID를 검증하며 임의 SQL 대신 고정 쿼리 인자로만 사용한다. */
function requireId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new RepositoryError('REVIEW_DECISION_INPUT_INVALID', '판단 대상의 작품·회차·검토 ID를 확인해 주세요.');
  return value;
}

/** 실제 Work/Episode/Run 소속을 검증하여 다른 범위의 판단 접근을 거부한다. */
function requireRun(scope) {
  const workId = requireId(scope?.workId), episodeId = requireId(scope?.episodeId), runId = requireId(scope?.reviewRunId);
  const row = getDatabase().prepare('SELECT r.id FROM review_runs r JOIN episodes e ON e.id = r.episode_id AND e.work_id = r.work_id WHERE r.id = ? AND r.work_id = ? AND r.episode_id = ?').get(runId, workId, episodeId);
  if (!row) throw new RepositoryError('REVIEW_DECISION_NOT_FOUND', '해당 작품·회차의 검토 결과를 찾을 수 없습니다.');
  return runId;
}

/** 지정 Run에 실제 속하는 Finding만 조회·기록 대상으로 허용한다. */
function requireFinding(scope) {
  const runId = requireRun(scope), findingId = requireId(scope?.findingId);
  if (!getDatabase().prepare('SELECT 1 FROM review_findings WHERE id = ? AND review_run_id = ?').get(findingId, runId)) throw new RepositoryError('REVIEW_DECISION_NOT_FOUND', '해당 검토의 발견 사항을 찾을 수 없습니다.');
  return findingId;
}

/** 판단 이벤트가 없는 Finding은 행을 생성하지 않고 미검토 revision 0으로 표현한다. */
function toDecision(findingId, row) {
  return { findingId, eventId: row?.id ?? null, decisionStatus: row?.decision_status ?? 'UNREVIEWED', note: row?.note ?? '', revision: row?.revision ?? 0, createdAt: row?.created_at ?? null };
}

/** 시각과 무관하게 가장 높은 순번의 판단 하나를 읽는다. */
function latest(findingId) {
  return toDecision(findingId, getDatabase().prepare('SELECT * FROM review_finding_decision_events WHERE finding_id = ? ORDER BY revision DESC LIMIT 1').get(findingId));
}

/** 소속을 확인한 Finding의 현재 작가 판단을 반환한다. */
function getFindingDecision(scope) { return latest(requireFinding(scope)); }

/** Finding별 판단을 높은 revision부터 읽으며 원본 이벤트는 변경하지 않는다. */
function listFindingDecisionHistory(scope) {
  const id = requireFinding(scope);
  return getDatabase().prepare('SELECT * FROM review_finding_decision_events WHERE finding_id = ? ORDER BY revision DESC').all(id).map(row => toDecision(id, row));
}

/** Run 전체의 최신 판단을 한 쿼리로 읽어 Finding별 IPC 조회를 피한다. */
function listFindingDecisionsForRun(scope) {
  const runId = requireRun(scope);
  return getDatabase().prepare(`SELECT f.id AS finding, d.* FROM review_findings f
    LEFT JOIN review_finding_decision_events d ON d.finding_id = f.id
      AND d.revision = (SELECT MAX(revision) FROM review_finding_decision_events WHERE finding_id = f.id)
    WHERE f.review_run_id = ? ORDER BY f.sort_order, f.id`).all(runId).map(row => toDecision(row.finding, row));
}

/** 최신 revision 재검증과 이벤트 추가를 원자적으로 수행하고 동일 내용은 추가하지 않는다. */
function appendFindingDecision(input) {
  if (!statuses.has(input?.decisionStatus) || typeof input?.note !== 'string' || input.note.length > NOTE_LIMIT || input.note.includes('\0') || !Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
    throw new RepositoryError('REVIEW_DECISION_INPUT_INVALID', '판단 상태·순번을 확인하고 메모를 4,000자 이내로 입력해 주세요.');
  }
  const db = getDatabase();
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE'); started = true;
    const id = requireFinding(input), current = latest(id), note = input.note.trim();
    if (current.revision !== input.expectedRevision) throw new RepositoryError('REVIEW_DECISION_CONFLICT', '다른 창에서 판단이 변경되었습니다. 최신 판단을 다시 불러온 뒤 저장해 주세요.');
    if (current.decisionStatus !== input.decisionStatus || current.note !== note) {
      db.prepare('INSERT INTO review_finding_decision_events (id, finding_id, decision_status, note, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, input.decisionStatus, note, current.revision + 1, new Date().toISOString());
    }
    const decision = latest(id);
    db.exec('COMMIT'); started = false;
    return decision;
  } catch (cause) {
    if (started) db.exec('ROLLBACK');
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError('REVIEW_DECISION_SAVE_FAILED', '작가 판단을 저장하지 못했습니다. 입력을 보존한 뒤 다시 시도해 주세요.', cause);
  }
}

module.exports = { getFindingDecision, listFindingDecisionHistory, listFindingDecisionsForRun, appendFindingDecision, NOTE_LIMIT };
