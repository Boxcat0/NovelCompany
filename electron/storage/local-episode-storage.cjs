const fs = require("node:fs/promises");
const { EpisodeStorage } = require("./episode-storage.cjs");
const {
  getDataRoot,
  getWorksDirectory,
  getWorkEpisodesDirectory,
  getEpisodeFilePath,
  getEpisodeFilePathByStorageKey,
} = require("./storage-paths.cjs");

function assertWorkId(workId) {
  if (
    typeof workId !== "string" ||
    workId.trim().length === 0 ||
    /[\\/]/.test(workId) ||
    workId === "." ||
    workId === ".."
  ) {
    throw new Error("Work ID must be a single, non-empty path segment.");
  }
}

class LocalEpisodeStorage extends EpisodeStorage {
  constructor(dataRoot = getDataRoot()) {
    super();
    this.dataRoot = dataRoot;
  }

  async ensureBaseStorage() {
    await fs.mkdir(getWorksDirectory(this.dataRoot), { recursive: true });
  }

  async ensureWorkStorage(workId) {
    assertWorkId(workId);
    await fs.mkdir(getWorkEpisodesDirectory(this.dataRoot, workId), {
      recursive: true,
    });
  }

  async saveEpisode(workId, episodeNumber, content) {
    assertWorkId(workId);

    if (typeof content !== "string") {
      throw new Error("Episode content must be a string.");
    }

    await this.ensureWorkStorage(workId);
    await fs.writeFile(
      getEpisodeFilePath(this.dataRoot, workId, episodeNumber),
      content,
      "utf8",
    );
  }

  async readEpisode(workId, episodeNumber) {
    assertWorkId(workId);
    return fs.readFile(
      getEpisodeFilePath(this.dataRoot, workId, episodeNumber),
      "utf8",
    );
  }

  /**
   * 검증된 논리 storage key를 로컬 작품 폴더 안의 UTF-8 TXT 파일로 해석해 읽는다.
   */
  async readEpisodeByStorageKey(storageKey) {
    return fs.readFile(
      getEpisodeFilePathByStorageKey(this.dataRoot, storageKey),
      "utf8",
    );
  }

  async existsEpisode(workId, episodeNumber) {
    assertWorkId(workId);

    try {
      await fs.access(getEpisodeFilePath(this.dataRoot, workId, episodeNumber));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { LocalEpisodeStorage };
