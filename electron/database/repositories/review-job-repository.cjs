const { randomUUID } = require('node:crypto');
const { getDatabase } = require('../database.cjs');
const { RepositoryError } = require('./repository-error.cjs');

/** Job row를 파일 경로와 내부 SQL 객체가 없는 공개 상태로 바꾼다. */
function toJob(row) {
  if (!row) return null;
  return { id: row.id, workId: row.work_id, episodeId: row.episode_id,
    queueSequence: row.queue_sequence, status: row.status,
    episodeContentHash: row.episode_content_hash, canonContextHash: row.canon_context_hash,
    contextMode: row.context_mode, fingerprintVersion: row.fingerprint_version,
    reviewRunId: row.review_run_id, errorCode: row.error_code, errorMessage: row.error_message,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    workTitle: row.work_title, episodeNumber: row.episode_number, episodeTitle: row.episode_title };
}

const details = "SELECT j.*, w.title AS work_title, e.episode_number, e.title AS episode_title FROM review_jobs j JOIN works w ON w.id = j.work_id JOIN episodes e ON e.id = j.episode_id";

/** ReviewJob의 현재 DB 상태와 표시용 작품·회차 제목을 읽는다. */
function getById(id) { return toJob(getDatabase().prepare(details + ' WHERE j.id = ?').get(id)); }

/** Episode의 마지막 제출을 읽어 UI 잠금 및 실패 사유를 표시한다. */
function getLatestByEpisode(workId, episodeId) {
  if (typeof workId !== 'string' || typeof episodeId !== 'string') throw new RepositoryError('EPISODE_ID_REQUIRED', '작품과 회차 ID를 확인해 주세요.');
  return toJob(getDatabase().prepare(details + ' WHERE j.work_id = ? AND j.episode_id = ? ORDER BY j.queue_sequence DESC LIMIT 1').get(workId, episodeId));
}

/** 실행·대기 작업은 접수 순번, 최근 종료 이력은 종료 시각으로 조회한다. */
function getQueue() {
  const database = getDatabase();
  const running = database.prepare(details + " WHERE j.status = 'RUNNING' ORDER BY j.queue_sequence").all().map(toJob);
  const queued = database.prepare(details + " WHERE j.status = 'QUEUED' ORDER BY j.queue_sequence").all().map(toJob);
  const recent = database.prepare(details + " WHERE j.status NOT IN ('RUNNING', 'QUEUED') ORDER BY j.completed_at DESC, j.queue_sequence DESC LIMIT 10").all().map(toJob);
  return { running, queued, recent };
}

/** 활성 Job 존재를 SQLite 상태로 판단해 Episode 변경을 차단한다. */
function assertEpisodeUnlocked(episodeId) {
  if (getDatabase().prepare("SELECT 1 FROM review_jobs WHERE episode_id = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1").get(episodeId)) {
    throw new RepositoryError('EPISODE_REVIEW_LOCKED', '현재 검토 대기 또는 진행 중인 원고이므로 수정할 수 없습니다.');
  }
}

/** 같은 Episode의 활성 제출을 조기에 안내하되 최종 중복은 DB unique index로 막는다. */
function assertNoActiveJob(episodeId) {
  if (getDatabase().prepare("SELECT 1 FROM review_jobs WHERE episode_id = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1").get(episodeId)) {
    throw new RepositoryError('REVIEW_JOB_ALREADY_ACTIVE', '이 회차는 이미 검토 대기 중이거나 진행 중입니다.');
  }
}

/** 검증된 제출 fingerprint를 QUEUED Job으로 저장하고 DB unique 제약으로 중복을 막는다. */
function submit(input) {
  const database = getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    database.prepare("INSERT INTO review_jobs (id, work_id, episode_id, status, episode_content_hash, canon_context_hash, context_mode, fingerprint_version, created_at) VALUES (?, ?, ?, 'QUEUED', ?, ?, 'RELEVANT_CANON_V1', 'V2', ?)")
      .run(id, input.workId, input.episodeId, input.episodeContentHash, input.canonContextHash, now);
  } catch (cause) {
    if (String(cause?.message).includes('UNIQUE constraint failed')) throw new RepositoryError('REVIEW_JOB_ALREADY_ACTIVE', '이 회차는 이미 검토 대기 중이거나 진행 중입니다.', cause);
    throw new RepositoryError('REVIEW_SUBMIT_FAILED', '검토부 제출을 저장하지 못했습니다.', cause);
  }
  return getById(id);
}

/** QUEUED만 조건부로 철회해 Worker 선점과의 경합을 DB에서 결정한다. */
function cancelQueued(id) {
  if (typeof id !== 'string' || !id.trim()) throw new RepositoryError('REVIEW_JOB_ID_REQUIRED', '검토 작업 ID를 확인해 주세요.');
  const result = getDatabase().prepare("UPDATE review_jobs SET status = 'CANCELLED', completed_at = ? WHERE id = ? AND status = 'QUEUED'").run(new Date().toISOString(), id);
  if (result.changes !== 1) throw new RepositoryError('REVIEW_CANCEL_NOT_ALLOWED', '대기 중인 검토 작업만 제출 철회할 수 있습니다.');
  return getById(id);
}

/** 가장 오래된 QUEUED Job을 Worker의 다음 후보로 선택한다. */
function getNextQueued() { return toJob(getDatabase().prepare(details + " WHERE j.status = 'QUEUED' ORDER BY j.queue_sequence LIMIT 1").get()); }

/** 입력 변경 또는 Context 오류로 시작할 수 없는 QUEUED Job을 종료한다. */
function finishQueued(id, status, code, message) {
  if (!['FAILED', 'RESUBMIT_REQUIRED'].includes(status)) throw new Error('Invalid queued terminal state');
  const result = getDatabase().prepare("UPDATE review_jobs SET status = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'QUEUED'")
    .run(status, code, message, new Date().toISOString(), id);
  return result.changes === 1 ? getById(id) : null;
}

/** QUEUED 선점과 RUNNING ReviewRun 생성·연결을 하나의 transaction으로 확정한다. */
function claimWithRun(id, processorKey) {
  const database = getDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const job = database.prepare("SELECT * FROM review_jobs WHERE id = ? AND status = 'QUEUED'").get(id);
    if (!job) { database.exec('ROLLBACK'); return null; }
    if (database.prepare("SELECT 1 FROM review_jobs WHERE status = 'RUNNING' LIMIT 1").get()) { database.exec('ROLLBACK'); return null; }
    const runId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO review_runs (id, work_id, episode_id, status, processor_key, episode_content_hash, canon_context_hash, context_mode, fingerprint_version, created_at, started_at) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, job.work_id, job.episode_id, processorKey, job.episode_content_hash, job.canon_context_hash, job.context_mode, job.fingerprint_version, now, now);
    const updated = database.prepare("UPDATE review_jobs SET status = 'RUNNING', review_run_id = ?, started_at = ? WHERE id = ? AND status = 'QUEUED'").run(runId, now, id);
    if (updated.changes !== 1) throw new Error('ReviewJob claim lost');
    database.exec('COMMIT');
    return getById(id);
  } catch (cause) {
    database.exec('ROLLBACK');
    throw new RepositoryError('REVIEW_CLAIM_FAILED', '검토 작업을 시작하지 못했습니다.', cause);
  }
}

/** Finding·ReviewRun 완료·ReviewJob 완료를 원자적으로 저장해 잠금을 해제한다. */
function complete(id, findings) {
  const database = getDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const job = database.prepare("SELECT review_run_id FROM review_jobs WHERE id = ? AND status = 'RUNNING'").get(id);
    if (!job?.review_run_id) throw new Error('Running ReviewJob not found');
    const now = new Date().toISOString();
    const insert = database.prepare('INSERT INTO review_findings (id, review_run_id, category, message, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    findings.forEach((finding, index) => insert.run(randomUUID(), job.review_run_id, finding.category, finding.message, index, now));
    const run = database.prepare("UPDATE review_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(now, job.review_run_id);
    if (run.changes !== 1) throw new Error('Running ReviewRun not found');
    database.prepare("UPDATE review_jobs SET status = 'COMPLETED', completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(now, id);
    database.exec('COMMIT');
    return getById(id);
  } catch (cause) {
    database.exec('ROLLBACK');
    throw new RepositoryError('REVIEW_COMPLETE_FAILED', '검토 결과를 저장하지 못했습니다.', cause);
  }
}

/** Processor 오류 시 연결된 RUNNING Run과 Job을 함께 FAILED로 종료한다. */
function failRunning(id, code, message) {
  const database = getDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const job = database.prepare("SELECT review_run_id FROM review_jobs WHERE id = ? AND status = 'RUNNING'").get(id);
    if (!job) { database.exec('ROLLBACK'); return null; }
    const now = new Date().toISOString();
    if (job.review_run_id) database.prepare("UPDATE review_runs SET status = 'FAILED', error_code = ?, completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(code, now, job.review_run_id);
    database.prepare("UPDATE review_jobs SET status = 'FAILED', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(code, message, now, id);
    database.exec('COMMIT');
    return getById(id);
  } catch (cause) { database.exec('ROLLBACK'); throw cause; }
}

/** 이전 프로세스가 남긴 RUNNING Job과 Run만 실패 처리하고 QUEUED 순서는 보존한다. */
function recoverInterrupted() {
  const database = getDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const jobs = database.prepare("SELECT id, review_run_id FROM review_jobs WHERE status = 'RUNNING'").all();
    const now = new Date().toISOString();
    for (const job of jobs) {
      if (job.review_run_id) database.prepare("UPDATE review_runs SET status = 'FAILED', error_code = 'REVIEW_INTERRUPTED', completed_at = ? WHERE id = ? AND status = 'RUNNING'").run(now, job.review_run_id);
      database.prepare("UPDATE review_jobs SET status = 'FAILED', error_code = 'REVIEW_INTERRUPTED', error_message = '앱 종료로 검토가 중단되었습니다. 다시 제출해 주세요.', completed_at = ? WHERE id = ?").run(now, job.id);
    }
    database.exec('COMMIT');
    return jobs.length;
  } catch (cause) { database.exec('ROLLBACK'); throw cause; }
}

module.exports = { assertEpisodeUnlocked, assertNoActiveJob, cancelQueued, claimWithRun, complete, failRunning, finishQueued, getById, getLatestByEpisode, getNextQueued, getQueue, recoverInterrupted, submit };
