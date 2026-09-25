const path = require("node:path");

const DEFAULT_DATA_ROOT = "C:\\NovelCompanyData";

function getDataRoot() {
  return path.resolve(process.env.NOVEL_COMPANY_DATA_DIR || DEFAULT_DATA_ROOT);
}

function getDatabaseFilePath() {
  return path.join(getDataRoot(), "novelcompany.db");
}

/**
 * 개발자용 로그 파일을 보관할 사용자 데이터 하위 경로를 반환한다.
 */
function getLogsDirectory() {
  return path.join(getDataRoot(), "logs");
}

function getWorksDirectory(dataRoot) {
  return path.join(dataRoot, "works");
}

function getWorkEpisodesDirectory(dataRoot, workId) {
  return path.join(getWorksDirectory(dataRoot), workId, "episodes");
}

function getEpisodeFileName(episodeNumber) {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
    throw new Error("Episode number must be a positive integer.");
  }

  return `${String(episodeNumber).padStart(3, "0")}.txt`;
}

function getEpisodeFilePath(dataRoot, workId, episodeNumber) {
  return path.join(
    getWorkEpisodesDirectory(dataRoot, workId),
    getEpisodeFileName(episodeNumber),
  );
}

/**
 * Episode의 논리 storage key를 사용자 작품 폴더 내부의 안전한 절대 경로로 변환한다.
 */
function getEpisodeFilePathByStorageKey(dataRoot, storageKey) {
  if (
    typeof storageKey !== "string" ||
    storageKey.trim().length === 0 ||
    path.isAbsolute(storageKey) ||
    storageKey.includes("\\")
  ) {
    throw new Error("Episode storage key must be a relative logical path.");
  }

  const segments = storageKey.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Episode storage key contains an invalid path segment.");
  }

  return path.join(getWorksDirectory(dataRoot), ...segments);
}

module.exports = {
  getDataRoot,
  getDatabaseFilePath,
  getLogsDirectory,
  getWorksDirectory,
  getWorkEpisodesDirectory,
  getEpisodeFileName,
  getEpisodeFilePath,
  getEpisodeFilePathByStorageKey,
};
