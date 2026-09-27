class EpisodeStorage {
  /** Main 내부의 작품/번호에서 논리 저장 키를 생성한다. */
  getStorageKey(_workId, _episodeNumber) {
    throw new Error("EpisodeStorage.getStorageKey must be implemented.");
  }

  /** DB의 저장 키가 해당 작품 저장 영역 안에 있는지 확인한다. */
  resolveManagedPath(_workId, _storageKey) {
    throw new Error("EpisodeStorage.resolveManagedPath must be implemented.");
  }

  /** 동기 apply/rollback/cleanup 계약을 가진 원고 쓰기 작업을 준비한다. */
  stageWrite(_workId, _storageKey, _content, _previousStorageKey = null) {
    throw new Error("EpisodeStorage.stageWrite must be implemented.");
  }

  /** 동기 apply/rollback/cleanup 계약을 가진 원고 삭제 작업을 준비한다. */
  stageDelete(_workId, _storageKey) {
    throw new Error("EpisodeStorage.stageDelete must be implemented.");
  }

  async ensureBaseStorage() {
    throw new Error("EpisodeStorage.ensureBaseStorage must be implemented.");
  }

  async ensureWorkStorage(_workId) {
    throw new Error("EpisodeStorage.ensureWorkStorage must be implemented.");
  }

  async saveEpisode(_workId, _episodeNumber, _content) {
    throw new Error("EpisodeStorage.saveEpisode must be implemented.");
  }

  async readEpisode(_workId, _episodeNumber) {
    throw new Error("EpisodeStorage.readEpisode must be implemented.");
  }

  /**
   * Repository가 제공한 논리 storage key로 Episode TXT 본문을 읽는다.
   */
  async readEpisodeByStorageKey(_storageKey) {
    throw new Error(
      "EpisodeStorage.readEpisodeByStorageKey must be implemented.",
    );
  }

  async existsEpisode(_workId, _episodeNumber) {
    throw new Error("EpisodeStorage.existsEpisode must be implemented.");
  }
}

module.exports = { EpisodeStorage };
