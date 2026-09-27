const crypto = require("node:crypto");
const { getDatabase } = require("../database.cjs");
const { RepositoryError } = require("./repository-error.cjs");

const workStatuses = new Set(["ACTIVE", "PAUSED", "COMPLETED"]);

/**
 * DB의 snake_case 작품 행을 애플리케이션용 camelCase 객체로 변환한다.
 */
function toWork(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 필수 작품 ID가 제공되었는지 확인하고 조회에 사용할 값을 반환한다.
 */
function requireWorkId(id) {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new RepositoryError("WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  }

  return id;
}

/**
 * 공백만으로 된 제목을 거부하고 저장할 제목을 반환한다.
 */
function requireTitle(title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new RepositoryError("WORK_TITLE_REQUIRED", "작품 제목을 입력해 주세요.");
  }

  return title.trim();
}

/**
 * Schema v1에서 허용한 작품 상태만 통과시킨다.
 */
function requireWorkStatus(status) {
  if (!workStatuses.has(status)) {
    throw new RepositoryError("WORK_STATUS_INVALID", "작품 상태가 올바르지 않습니다.");
  }

  return status;
}

/** 선택 설명은 문자열 또는 null만 허용하고 기존 공백/빈 문자열 정책을 유지한다. */
function requireDescription(description) {
  if (description !== null && typeof description !== "string") {
    throw new RepositoryError("WORK_DESCRIPTION_INVALID", "작품 설명은 글로 입력해 주세요.");
  }
  return description;
}

/**
 * 예상하지 못한 SQLite 쓰기 오류를 사용자용 한국어 메시지로 감싼다.
 */
function toWorkWriteError(error) {
  if (error instanceof RepositoryError) {
    return error;
  }

  return new RepositoryError("WORK_SAVE_FAILED", "작품 정보를 저장하지 못했습니다.", error);
}

/**
 * 입력을 검증하고 UUID와 UTC 시각으로 작품 metadata만 생성한다.
 */
function createWork(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RepositoryError("WORK_TITLE_REQUIRED", "작품 제목을 입력해 주세요.");
  }
  const { title, description = null, status = "ACTIVE" } = input;
  const database = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    database
      .prepare(
        "INSERT INTO works (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, requireTitle(title), requireDescription(description), requireWorkStatus(status), now, now);
  } catch (error) {
    throw toWorkWriteError(error);
  }

  return getWorkById(id);
}

/**
 * 작품 ID로 metadata를 조회하며, 없으면 null을 반환한다.
 */
function getWorkById(id) {
  const database = getDatabase();
  const row = database
    .prepare(
      "SELECT id, title, description, status, created_at, updated_at FROM works WHERE id = ?",
    )
    .get(requireWorkId(id));

  return toWork(row);
}

/**
 * 등록 시각, 제목, ID 순서로 모든 작품을 안정적으로 조회한다.
 */
function getAllWorks() {
  const database = getDatabase();
  const rows = database
    .prepare(
      "SELECT id, title, description, status, created_at, updated_at FROM works ORDER BY created_at ASC, title COLLATE NOCASE ASC, id ASC",
    )
    .all();

  return rows.map(toWork);
}

/**
 * 허용된 작품 metadata만 부분 수정하고, 없는 작품이면 null을 반환한다.
 */
function updateWork(id, changes) {
  const database = getDatabase();
  const workId = requireWorkId(id);
  const currentWork = getWorkById(workId);

  if (!currentWork) {
    return null;
  }

  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new RepositoryError("WORK_UPDATE_REQUIRED", "수정할 작품 정보를 입력해 주세요.");
  }

  const title = Object.hasOwn(changes, "title")
    ? requireTitle(changes.title)
    : currentWork.title;
  const status = Object.hasOwn(changes, "status")
    ? requireWorkStatus(changes.status)
    : currentWork.status;
  const description = Object.hasOwn(changes, "description")
    ? requireDescription(changes.description)
    : currentWork.description;
  const updatedAt = new Date().toISOString();

  try {
    database
      .prepare(
        "UPDATE works SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .run(title, description, status, updatedAt, workId);
  } catch (error) {
    throw toWorkWriteError(error);
  }

  return getWorkById(workId);
}

/** 작품 존재 여부와 회차 수/CanonSpace 유무를 한 조회로 확인해 삭제 가능 상태를 반환한다. */
function getWorkDeletionStatus(id) {
  const row = getDatabase().prepare(`
    SELECT
      (SELECT COUNT(*) FROM episodes WHERE work_id = works.id) AS episode_count,
      EXISTS (SELECT 1 FROM canon_spaces WHERE work_id = works.id) AS has_canon_space
    FROM works WHERE id = ?
  `).get(requireWorkId(id));
  if (!row) throw new RepositoryError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
  return {
    canDelete: row.episode_count === 0 && row.has_canon_space === 0,
    episodeCount: row.episode_count,
    hasCanonSpace: row.has_canon_space === 1,
  };
}

/** 실제 삭제 직전 의존성을 재검증하고 작품 행 하나만 transaction 안에서 삭제한다. */
function deleteWork(id) {
  const workId = requireWorkId(id);
  const database = getDatabase();
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const status = getWorkDeletionStatus(workId);
    if (status.episodeCount > 0 && status.hasCanonSpace) {
      throw new RepositoryError("WORK_DELETE_BLOCKED_BY_DEPENDENCIES", "이 작품에는 연결된 회차와 Canon 데이터가 있어 삭제할 수 없습니다.");
    }
    if (status.episodeCount > 0) {
      throw new RepositoryError("WORK_DELETE_BLOCKED_BY_EPISODES", "이 작품에는 연결된 회차가 있어 삭제할 수 없습니다.");
    }
    if (status.hasCanonSpace) {
      throw new RepositoryError("WORK_DELETE_BLOCKED_BY_CANON", "이 작품에는 Canon 데이터가 있어 삭제할 수 없습니다.");
    }
    database.prepare("DELETE FROM works WHERE id = ?").run(workId);
    database.exec("COMMIT");
    return { id: workId };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK");
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("WORK_DELETE_FAILED", "작품을 삭제하지 못했습니다.", error);
  }
}

module.exports = { createWork, getAllWorks, getWorkById, updateWork, getWorkDeletionStatus, deleteWork };
