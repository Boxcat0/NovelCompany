const { createHash } = require("node:crypto");
const { getDatabase } = require("./database/database.cjs");
const episodes = require("./database/repositories/episode-repository.cjs");
const { RepositoryError } = require("./database/repositories/repository-error.cjs");
const { logIpcError } = require("./logging/logger.cjs");
const { assertEpisodeOperationAvailable } = require('./review/episode-operation-gate.cjs');
const { assertEpisodeUnlocked } = require('./database/repositories/review-job-repository.cjs');

/** Renderer에는 저장 키/해시/실제 경로를 제외한 metadata만 반환한다. */
function toPublicEpisode(episode) {
  if (!episode) return null;
  const { id, workId, episodeNumber, title, status, createdAt, updatedAt } = episode;
  return { id, workId, episodeNumber, title, status, createdAt, updatedAt };
}

/** 사용자 입력의 metadata/본문을 검증하고 내부 storage identity 주입을 거부한다. */
function validateEpisodeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["workId", "episodeNumber", "title", "status", "content"].includes(key))) throw new RepositoryError("EPISODE_INPUT_INVALID", "회차 저장 정보가 올바르지 않습니다.");
  if (typeof input.workId !== "string" || !input.workId.trim()) throw new RepositoryError("WORK_ID_REQUIRED", "작품 ID를 입력해 주세요.");
  if (!Number.isSafeInteger(input.episodeNumber) || input.episodeNumber < 1) throw new RepositoryError("EPISODE_NUMBER_INVALID", "회차 번호는 1 이상의 정수여야 합니다.");
  if (typeof input.title !== "string" || !input.title.trim()) throw new RepositoryError("EPISODE_TITLE_REQUIRED", "에피소드 제목을 입력해 주세요.");
  const status = input.status === undefined ? "DRAFT" : input.status;
  if (!["DRAFT", "IN_PROGRESS", "COMPLETED"].includes(status)) throw new RepositoryError("EPISODE_STATUS_INVALID", "에피소드 상태가 올바르지 않습니다.");
  if (typeof input.content !== "string") throw new RepositoryError("EPISODE_CONTENT_INVALID", "원고는 문자열이어야 합니다.");
  return { ...input, title: input.title.trim(), status };
}

/** 동기 transaction 안에서 metadata와 파일 적용을 묶고 실패 시 DB/원본 파일을 복원한다. */
function runEpisodeOperation(kind, prepare) {
  const database = getDatabase();
  let started = false;
  let change;
  try {
    database.exec("BEGIN IMMEDIATE"); started = true;
    const operation = prepare(); change = operation.change;
    const result = operation.writeMetadata();
    change.apply();
    database.exec("COMMIT"); started = false;
    try { change.cleanup(); }
    catch (cause) { logIpcError({ channel: "episodes:" + kind, code: "EPISODE_FILE_CLEANUP_FAILED", message: "저장은 완료되었지만 작업용 파일을 정리하지 못했습니다.", cause }); }
    return result;
  } catch (cause) {
    try { if (started) database.exec("ROLLBACK"); }
    catch (rollbackError) { logIpcError({ channel: "episodes:" + kind, code: "EPISODE_COMPENSATION_FAILED", message: "회차 DB 복원에 실패했습니다.", cause: rollbackError }); }
    try { change?.rollback(); }
    catch (restoreError) { logIpcError({ channel: "episodes:" + kind, code: "EPISODE_COMPENSATION_FAILED", message: "원고 파일 복원에 실패했습니다.", cause: restoreError }); }
    if (cause.cleanupError) logIpcError({ channel: "episodes:" + kind, code: "EPISODE_FILE_CLEANUP_FAILED", message: "작업용 파일을 정리하지 못했습니다.", cause: cause.cleanupError });
    if (cause instanceof RepositoryError) throw cause;
    throw new RepositoryError(kind === "delete" ? "EPISODE_DELETE_FAILED" : "EPISODE_SAVE_FAILED", kind === "delete" ? "회차와 원고를 삭제하지 못했습니다." : "회차와 원고를 저장하지 못했습니다.", cause);
  }
}

/** Work/번호를 다시 확인하고 metadata와 빈 문자열도 허용하는 TXT를 함께 생성한다. */
function createEpisodeWithContent(storage, input) {
  const data = validateEpisodeInput(input);
  return runEpisodeOperation("create", () => {
    episodes.findNextAvailableEpisodeNumber(data.workId); // Work 존재 확인, 추천 번호를 강제하지 않는다.
    episodes.requireAvailableEpisodeNumber(data.workId, data.episodeNumber);
    const storageKey = storage.getStorageKey(data.workId, data.episodeNumber);
    const change = storage.stageWrite(data.workId, storageKey, data.content);
    return { change,
      /** staging 성공 후 생성한 metadata를 경로 없는 DTO로 반환한다. */
      writeMetadata: () => toPublicEpisode(episodes.createEpisode({ ...data, storageKey, contentHash: createHash("sha256").update(data.content, "utf8").digest("hex") })),
    };
  });
}

/** Episode ID는 유지하고 번호 변경 시 TXT 위치도 함께 바꾸며 원본 복원 계획을 만든다. */
function updateEpisodeWithContent(storage, id, input) {
  const data = validateEpisodeInput(input);
  assertEpisodeOperationAvailable(id);
  return runEpisodeOperation("update", () => {
    const previous = episodes.getEpisodeForWork(data.workId, id);
    assertEpisodeUnlocked(id);
    episodes.requireAvailableEpisodeNumber(data.workId, data.episodeNumber, id);
    const storageKey = previous.episodeNumber === data.episodeNumber ? previous.storageKey : storage.getStorageKey(data.workId, data.episodeNumber);
    const change = storage.stageWrite(data.workId, storageKey, data.content, previous.storageKey);
    return { change,
      /** 번호와 metadata를 갱신하며 Work/ID는 바꾸지 않는다. */
      writeMetadata: () => toPublicEpisode(episodes.updateEpisode(id, { ...data, storageKey, contentHash: createHash("sha256").update(data.content, "utf8").digest("hex") })),
    };
  });
}

/** 소속을 확인하고 TXT를 복원 가능한 백업으로 격리한 뒤 metadata와 함께 삭제한다. */
function deleteEpisodeWithContent(storage, id, workId) {
  assertEpisodeOperationAvailable(id);
  return runEpisodeOperation("delete", () => {
    const previous = episodes.getEpisodeForWork(workId, id);
    assertEpisodeUnlocked(id);
    const change = storage.stageDelete(workId, previous.storageKey);
    return { change,
      /** Episode metadata만 삭제하고 Work 및 다른 회차는 보존한다. */
      writeMetadata: () => episodes.deleteEpisode(workId, id),
    };
  });
}

module.exports = { toPublicEpisode, createEpisodeWithContent, updateEpisodeWithContent, deleteEpisodeWithContent };
