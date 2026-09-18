class EpisodeStorage {
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

  async existsEpisode(_workId, _episodeNumber) {
    throw new Error("EpisodeStorage.existsEpisode must be implemented.");
  }
}

module.exports = { EpisodeStorage };
