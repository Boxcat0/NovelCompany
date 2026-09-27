const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
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
  /** 데이터 루트와 동기 파일 작업을 보관하며 테스트에서 실제 IO 실패를 주입할 수 있게 한다. */
  constructor(dataRoot = getDataRoot(), fileSystem = fsSync) {
    super();
    this.dataRoot = dataRoot;
    this.fileSystem = fileSystem;
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

  /** Main이 생성한 작품 ID와 양의 번호로 기존 번호 기반 논리 저장 키를 만든다. */
  getStorageKey(workId, episodeNumber) {
    assertWorkId(workId);
    const key = `${workId}/episodes/${String(episodeNumber).padStart(3, "0")}.txt`;
    if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) throw new Error("Invalid episode number");
    getEpisodeFilePathByStorageKey(this.dataRoot, key);
    return key;
  }

  /** DB의 키도 작품 경계와 실제 디렉터리/파일 종류를 확인해 경로 이탈과 링크 접근을 막는다. */
  resolveManagedPath(workId, storageKey) {
    const io = this.fileSystem;
    const parts = storageKey.split("/");
    if (parts.length !== 3 || parts[0] !== workId || parts[1] !== "episodes" || !parts[2].endsWith(".txt")) throw new Error("Storage scope mismatch");
    const filePath = getEpisodeFilePathByStorageKey(this.dataRoot, storageKey);
    for (const directory of [getWorksDirectory(this.dataRoot), path.join(getWorksDirectory(this.dataRoot), workId), path.dirname(filePath)]) {
      try {
        const stat = io.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe storage directory");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    try {
      const stat = io.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unsafe manuscript file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return filePath;
  }

  /** UTF-8 새 원고를 별도 임시 파일에 먼저 기록하고 적용/복원 가능한 작업을 반환한다. */
  stageWrite(workId, storageKey, content, previousStorageKey = null) {
    return this.stageFileChange(workId, previousStorageKey, storageKey, content);
  }

  /** 삭제할 원고를 백업 이름으로 옮길 계획을 만들며 이미 없는 TXT는 허용한다. */
  stageDelete(workId, storageKey) {
    return this.stageFileChange(workId, storageKey, null, null);
  }

  /** 파일 적용 상태를 추적하여 DB commit 전 실패에는 원본을 복원하고 commit 후 백업만 정리한다. */
  stageFileChange(workId, previousKey, nextKey, content) {
    const io = this.fileSystem;
    const oldPath = previousKey ? this.resolveManagedPath(workId, previousKey) : null;
    const nextPath = nextKey ? this.resolveManagedPath(workId, nextKey) : null;
    if (nextPath && nextPath !== oldPath && io.existsSync(nextPath)) throw new RepositoryError("EPISODE_CONTENT_CONFLICT", "저장할 위치에 원고 파일이 이미 있습니다. 다른 회차 번호를 사용해 주세요.");
    const token = randomUUID();
    const tempPath = nextPath ? nextPath + "." + token + ".tmp" : null;
    const backupPath = oldPath ? oldPath + "." + token + ".bak" : null;
    let tempCreated = false;
    let backedUp = false;
    let copiedBackup = false;
    let published = false;
    /** 작업 소유의 임시 파일만 제거하며 원래 경로에는 접근하지 않는다. */
    function cleanTemp() {
      if (tempCreated) { io.unlinkSync(tempPath); tempCreated = false; }
    }
    /** 새 원고를 게시하거나 기존 원고를 삭제 백업으로 옮긴다. */
    function apply() {
      if (oldPath) {
        try {
          if (oldPath === nextPath) {
            io.copyFileSync(oldPath, backupPath, fsSync.constants.COPYFILE_EXCL);
            copiedBackup = true;
          } else io.renameSync(oldPath, backupPath);
          backedUp = true;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (nextPath) {
        if (oldPath === nextPath && backedUp) {
          // 기존 파일은 백업 후 rename으로 원자 교체한다.
          io.renameSync(tempPath, nextPath); tempCreated = false; published = true;
        } else {
          // 새 경로는 hard link로 원자 게시하여 기존/외부 원고를 덮어쓰지 않는다.
          io.linkSync(tempPath, nextPath); published = true; cleanTemp();
        }
      }
    }
    /** commit 전 실패 시 새 파일을 제거하고 원본을 복원하며 복원 실패는 호출자에게 알린다. */
    function rollback() {
      const failures = [];
      try {
        if (backedUp && (published || !copiedBackup)) {
          if (published && nextPath !== oldPath) { io.unlinkSync(nextPath); published = false; }
          io.renameSync(backupPath, oldPath); backedUp = false; published = false;
        } else if (published) { io.unlinkSync(nextPath); published = false; }
        if (backedUp) { io.unlinkSync(backupPath); backedUp = false; }
      } catch (error) { failures.push(error); }
      try { cleanTemp(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Episode file compensation failed: " + failures.map((failure) => failure.message).join("; "));
    }
    /** commit 후에는 활성 파일을 건드리지 않고 작업용 파일만 제거한다. */
    function cleanup() {
      cleanTemp();
      if (backedUp) { io.unlinkSync(backupPath); backedUp = false; }
    }
    if (nextPath) {
      io.mkdirSync(path.dirname(nextPath), { recursive: true });
      let descriptor;
      try {
        descriptor = io.openSync(tempPath, "wx"); tempCreated = true;
        io.writeFileSync(descriptor, content, "utf8"); io.fsyncSync(descriptor);
        io.closeSync(descriptor); descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch (closeError) { error.cleanupError = closeError; } }
        try { cleanTemp(); } catch (cleanupError) { error.cleanupError = cleanupError; }
        throw error;
      }
    }
    return { apply, rollback, cleanup };
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
