const path = require("node:path");

const DEFAULT_DATA_ROOT = "C:\\NovelCompanyData";

function getDataRoot() {
  return path.resolve(process.env.NOVEL_COMPANY_DATA_DIR || DEFAULT_DATA_ROOT);
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

module.exports = {
  getDataRoot,
  getWorksDirectory,
  getWorkEpisodesDirectory,
  getEpisodeFileName,
  getEpisodeFilePath,
};
