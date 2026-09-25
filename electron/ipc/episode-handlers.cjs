const {
  createEpisode,
  getEpisodeById,
  getEpisodesByWorkId,
  updateEpisode,
} = require("../database/repositories/episode-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();

/**
 * Episode metadata와 TXT 읽기 요청을 처리할 IPC Handler를 한 번만 등록한다.
 */
function registerEpisodeHandlers(ipcMain, episodeStorage) {
  if (registeredIpcMains.has(ipcMain)) {
    return;
  }

  ipcMain.handle(IPC_CHANNELS.EPISODE_GET_BY_ID, (_event, id) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_GET_BY_ID, () => getEpisodeById(id)),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_GET_BY_WORK_ID, (_event, workId) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_GET_BY_WORK_ID, () =>
      getEpisodesByWorkId(workId),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_CREATE, (_event, input) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_CREATE, () => createEpisode(input)),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_UPDATE, (_event, id, changes) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_UPDATE, () => {
      const episode = updateEpisode(id, changes);
      if (!episode) {
        throw new RepositoryError(
          "EPISODE_NOT_FOUND",
          "에피소드를 찾을 수 없습니다.",
        );
      }
      return episode;
    }),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_READ_CONTENT, (_event, episodeId) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_READ_CONTENT, async () => {
      const episode = getEpisodeById(episodeId);
      if (!episode) {
        throw new RepositoryError(
          "EPISODE_NOT_FOUND",
          "에피소드를 찾을 수 없습니다.",
        );
      }

      try {
        return await episodeStorage.readEpisodeByStorageKey(episode.storageKey);
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new RepositoryError(
            "EPISODE_CONTENT_NOT_FOUND",
            "에피소드 원고 파일을 찾을 수 없습니다.",
            error,
          );
        }

        throw new RepositoryError(
          "EPISODE_CONTENT_READ_FAILED",
          "에피소드 원고를 불러오는 중 오류가 발생했습니다.",
          error,
        );
      }
    }),
  );

  registeredIpcMains.add(ipcMain);
}

module.exports = { registerEpisodeHandlers };
