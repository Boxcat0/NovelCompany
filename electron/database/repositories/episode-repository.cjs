const crypto = require("node:crypto");
const { getDatabase } = require("../database.cjs");
const { RepositoryError } = require("./repository-error.cjs");

const episodeStatuses = new Set(["DRAFT", "IN_PROGRESS", "COMPLETED"]);

/**
 * DB의 snake_case 에피소드 행을 애플리케이션용 camelCase 객체로 변환한다.
 */
function toEpisode(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workId: row.work_id,
    episodeNumber: row.episode_number,
    title: row.title,
    status: row.status,
    storageKey: row.storage_key,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 필수 문자열 ID를 확인하고 DB 조회에 사용할 값을 반환한다.
 */
function requireId(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RepositoryError(
      label === "작품 ID" ? "WORK_ID_REQUIRED" : "EPISODE_ID_REQUIRED",
      `${label}을(를) 입력해 주세요.`,
    );
  }

  return value;
}

/**
 * 공백만으로 된 필수 문자열을 거부하고 정리된 값을 반환한다.
 */
function requireText(value, code, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RepositoryError(code, message);
  }

  return value.trim();
}

/**
 * 양의 정수 회차 번호만 저장할 수 있도록 검증한다.
 */
function requireEpisodeNumber(episodeNumber) {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    throw new RepositoryError(
      "EPISODE_NUMBER_INVALID",
      "회차 번호는 1 이상의 정수여야 합니다.",
    );
  }

  return episodeNumber;
}

/**
 * Schema v1에서 허용한 에피소드 상태만 통과시킨다.
 */
function requireEpisodeStatus(status) {
  if (!episodeStatuses.has(status)) {
    throw new RepositoryError(
      "EPISODE_STATUS_INVALID",
      "에피소드 상태가 올바르지 않습니다.",
    );
  }

  return status;
}

/**
 * 작품 존재 여부를 먼저 확인해 외래 키 오류를 한국어 메시지로 구분한다.
 */
function requireExistingWork(database, workId) {
  const work = database.prepare("SELECT id FROM works WHERE id = ?").get(workId);

  if (!work) {
    throw new RepositoryError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
  }
}

/**
 * 대표 SQLite 제약 오류를 구분하고 나머지는 일반 저장 오류로 감싼다.
 */
function toEpisodeWriteError(error) {
  if (error instanceof RepositoryError) {
    return error;
  }

  if (error.message.includes("episodes.work_id, episodes.episode_number")) {
    return new RepositoryError(
      "EPISODE_NUMBER_DUPLICATE",
      "이미 같은 회차 번호의 에피소드가 존재합니다.",
      error,
    );
  }

  if (error.message.includes("episodes.storage_key")) {
    return new RepositoryError(
      "EPISODE_STORAGE_KEY_DUPLICATE",
      "이미 같은 원고 저장 경로를 사용하는 에피소드가 존재합니다.",
      error,
    );
  }

  if (error.message.includes("FOREIGN KEY constraint failed")) {
    return new RepositoryError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.", error);
  }

  return new RepositoryError(
    "EPISODE_SAVE_FAILED",
    "에피소드 정보를 저장하지 못했습니다.",
    error,
  );
}

/**
 * UUID와 UTC 시각을 생성해 새 에피소드 metadata만 저장한다.
 */
function createEpisode({
  workId,
  episodeNumber,
  title,
  status = "DRAFT",
  storageKey,
  contentHash = null,
}) {
  const database = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const validWorkId = requireId(workId, "작품 ID");

  try {
    requireExistingWork(database, validWorkId);
    database
      .prepare(
        "INSERT INTO episodes (id, work_id, episode_number, title, status, storage_key, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        validWorkId,
        requireEpisodeNumber(episodeNumber),
        requireText(
          title,
          "EPISODE_TITLE_REQUIRED",
          "에피소드 제목을 입력해 주세요.",
        ),
        requireEpisodeStatus(status),
        requireText(
          storageKey,
          "EPISODE_STORAGE_KEY_REQUIRED",
          "원고 저장 경로를 입력해 주세요.",
        ),
        contentHash,
        now,
        now,
      );
  } catch (error) {
    throw toEpisodeWriteError(error);
  }

  return getEpisodeById(id);
}

/**
 * 에피소드 ID로 metadata를 조회하며 TXT 본문은 읽지 않는다.
 */
function getEpisodeById(id) {
  const database = getDatabase();
  const row = database
    .prepare(
      "SELECT id, work_id, episode_number, title, status, storage_key, content_hash, created_at, updated_at FROM episodes WHERE id = ?",
    )
    .get(requireId(id, "에피소드 ID"));

  return toEpisode(row);
}

/**
 * 한 작품의 에피소드 metadata를 회차 번호 오름차순으로 조회한다.
 */
function getEpisodesByWorkId(workId) {
  const database = getDatabase();
  const rows = database
    .prepare(
      "SELECT id, work_id, episode_number, title, status, storage_key, content_hash, created_at, updated_at FROM episodes WHERE work_id = ? ORDER BY episode_number ASC",
    )
    .all(requireId(workId, "작품 ID"));

  return rows.map(toEpisode);
}

/**
 * 제목, 상태, 저장 키, 내용 해시만 부분 수정하고 없는 에피소드는 null을 반환한다.
 */
function updateEpisode(id, changes) {
  const database = getDatabase();
  const episodeId = requireId(id, "에피소드 ID");
  const currentEpisode = getEpisodeById(episodeId);

  if (!currentEpisode) {
    return null;
  }

  if (!changes || typeof changes !== "object") {
    throw new RepositoryError(
      "EPISODE_UPDATE_REQUIRED",
      "수정할 에피소드 정보를 입력해 주세요.",
    );
  }

  const title = Object.hasOwn(changes, "title")
    ? requireText(
      changes.title,
      "EPISODE_TITLE_REQUIRED",
      "에피소드 제목을 입력해 주세요.",
    )
    : currentEpisode.title;
  const status = Object.hasOwn(changes, "status")
    ? requireEpisodeStatus(changes.status)
    : currentEpisode.status;
  const storageKey = Object.hasOwn(changes, "storageKey")
    ? requireText(
      changes.storageKey,
      "EPISODE_STORAGE_KEY_REQUIRED",
      "원고 저장 경로를 입력해 주세요.",
    )
    : currentEpisode.storageKey;
  const contentHash = Object.hasOwn(changes, "contentHash")
    ? changes.contentHash
    : currentEpisode.contentHash;
  const updatedAt = new Date().toISOString();

  try {
    database
      .prepare(
        "UPDATE episodes SET title = ?, status = ?, storage_key = ?, content_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(title, status, storageKey, contentHash, updatedAt, episodeId);
  } catch (error) {
    throw toEpisodeWriteError(error);
  }

  return getEpisodeById(episodeId);
}

module.exports = {
  createEpisode,
  getEpisodeById,
  getEpisodesByWorkId,
  updateEpisode,
};
