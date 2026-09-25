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
 * UUID와 UTC 시각을 생성해 새 작품 metadata를 저장한다.
 */
function createWork({ title, description = null, status = "ACTIVE" }) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    database
      .prepare(
        "INSERT INTO works (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, requireTitle(title), description, requireWorkStatus(status), now, now);
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

  if (!changes || typeof changes !== "object") {
    throw new RepositoryError("WORK_UPDATE_REQUIRED", "수정할 작품 정보를 입력해 주세요.");
  }

  const title = Object.hasOwn(changes, "title")
    ? requireTitle(changes.title)
    : currentWork.title;
  const status = Object.hasOwn(changes, "status")
    ? requireWorkStatus(changes.status)
    : currentWork.status;
  const description = Object.hasOwn(changes, "description")
    ? changes.description
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

module.exports = { createWork, getAllWorks, getWorkById, updateWork };
