const { randomUUID } = require("node:crypto");
const { getDatabase } = require("../database.cjs");
const { RepositoryError } = require("./repository-error.cjs");

/** Review ID와 외부 식별자가 빈 문자열 없이 전달됐는지 확인한다. */
function requireId(value, code, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RepositoryError(code, message);
  }
  return value;
}

/** SQLite review_runs row를 내부 service가 사용할 camelCase DTO로 바꾼다. */
function toRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    workId: row.work_id,
    episodeId: row.episode_id,
    status: row.status,
    processorKey: row.processor_key,
    episodeContentHash: row.episode_content_hash,
    canonContextHash: row.canon_context_hash,
    contextMode: row.context_mode,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** SQLite review_findings row를 public finding 형태로 변환한다. */
function toFinding(row) {
  return {
    id: row.id,
    category: row.category,
    message: row.message,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

/** 지정 Run과 Finding을 한 번에 읽어 history 결과가 불완전하지 않게 한다. */
function getById(reviewRunId) {
  const database = getDatabase();
  const run = toRun(database.prepare("SELECT * FROM review_runs WHERE id = ?").get(requireId(reviewRunId, "REVIEW_RUN_ID_REQUIRED", "검토 실행 ID를 입력해 주세요.")));
  if (!run) return null;
  const findings = database.prepare("SELECT * FROM review_findings WHERE review_run_id = ? ORDER BY sort_order ASC, id ASC").all(run.id).map(toFinding);
  return { ...run, findings };
}

/** 같은 Work/Episode에 속한 immutable ReviewRun history를 최신 실행 순으로 읽는다. */
function getByEpisode(input) {
  const workId = requireId(input?.workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  const episodeId = requireId(input?.episodeId, "EPISODE_ID_REQUIRED", "에피소드 ID를 입력해 주세요.");
  const database = getDatabase();
  return database.prepare("SELECT * FROM review_runs WHERE work_id = ? AND episode_id = ? ORDER BY created_at DESC, id DESC").all(workId, episodeId).map((row) => {
    const run = toRun(row);
    const findings = database.prepare("SELECT * FROM review_findings WHERE review_run_id = ? ORDER BY sort_order ASC, id ASC").all(run.id).map(toFinding);
    return { ...run, findings };
  });
}

/** 입력 source fingerprint를 고정한 RUNNING ReviewRun을 만들고 동시 실행을 차단한다. */
function createRun(input) {
  const workId = requireId(input?.workId, "WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  const episodeId = requireId(input?.episodeId, "EPISODE_ID_REQUIRED", "에피소드 ID를 입력해 주세요.");
  const processorKey = requireId(input?.processorKey, "REVIEW_START_FAILED", "검토 처리기를 확인할 수 없습니다.");
  const episodeContentHash = requireId(input?.episodeContentHash, "REVIEW_START_FAILED", "원고 기준 정보를 확인할 수 없습니다.");
  const canonContextHash = requireId(input?.canonContextHash, "REVIEW_START_FAILED", "Canon 기준 정보를 확인할 수 없습니다.");
  const database = getDatabase();
  const episode = database.prepare("SELECT work_id FROM episodes WHERE id = ?").get(episodeId);
  const contextMode = input.contextMode ?? 'FULL_CANON_V1';
  if (!['FULL_CANON_V1', 'RELEVANT_CANON_V1'].includes(contextMode)) throw new RepositoryError('REVIEW_START_FAILED', '검토 컨텍스트 모드가 올바르지 않습니다.');
  if (!episode || episode.work_id !== workId) throw new RepositoryError("EPISODE_NOT_FOUND", "에피소드를 찾을 수 없습니다.");
  if (database.prepare("SELECT 1 FROM review_runs WHERE episode_id = ? AND status = 'RUNNING' LIMIT 1").get(episodeId)) {
    throw new RepositoryError("REVIEW_ALREADY_RUNNING", "이미 이 에피소드의 검토가 진행 중입니다.");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    database.prepare("INSERT INTO review_runs (id, work_id, episode_id, status, processor_key, episode_content_hash, canon_context_hash, context_mode, error_code, created_at, started_at, completed_at) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, NULL, ?, ?, NULL)").run(id, workId, episodeId, processorKey, episodeContentHash, canonContextHash, contextMode, now, now);
  } catch (cause) {
    if (String(cause?.message).includes("idx_review_runs_episode_running")) throw new RepositoryError("REVIEW_ALREADY_RUNNING", "이미 이 에피소드의 검토가 진행 중입니다.", cause);
    throw new RepositoryError("REVIEW_START_FAILED", "검토 작업을 시작하지 못했습니다.", cause);
  }
  return getById(id);
}

/** RUNNING Run만 Finding insertion과 COMPLETED 전환을 하나의 transaction으로 완료한다. */
function completeRun(reviewRunId, findings) {
  const id = requireId(reviewRunId, "REVIEW_RUN_ID_REQUIRED", "검토 실행 ID를 입력해 주세요.");
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const running = database.prepare("SELECT id FROM review_runs WHERE id = ? AND status = 'RUNNING'").get(id);
    if (!running) throw new RepositoryError("REVIEW_COMPLETE_FAILED", "진행 중인 검토 작업을 완료할 수 없습니다.");
    const now = new Date().toISOString();
    const insert = database.prepare("INSERT INTO review_findings (id, review_run_id, category, message, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    findings.forEach((finding, sortOrder) => insert.run(randomUUID(), id, finding.category, finding.message, sortOrder, now));
    database.prepare("UPDATE review_runs SET status = 'COMPLETED', completed_at = ?, error_code = NULL WHERE id = ? AND status = 'RUNNING'").run(now, id);
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("REVIEW_COMPLETE_FAILED", "검토 결과를 저장하지 못했습니다.", cause);
  }
  return getById(id);
}

/** Processor 실패 후 Finding 없이 RUNNING Run을 FAILED history로 보존한다. */
function failRun(reviewRunId, errorCode = "REVIEW_FAILED") {
  const id = requireId(reviewRunId, "REVIEW_RUN_ID_REQUIRED", "검토 실행 ID를 입력해 주세요.");
  const database = getDatabase();
  const now = new Date().toISOString();
  try {
    const result = database.prepare("UPDATE review_runs SET status = 'FAILED', error_code = ?, completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(errorCode, now, id);
    if (result.changes !== 1) throw new RepositoryError("REVIEW_FAILED", "검토 작업을 완료하지 못했습니다.");
  } catch (cause) {
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError("REVIEW_FAILED", "검토 작업을 완료하지 못했습니다.", cause);
  }
  return getById(id);
}

module.exports = { completeRun, createRun, failRun, getByEpisode, getById };
