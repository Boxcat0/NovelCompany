const {
  getEpisodeById,
  getEpisodesByWorkId,
  findNextAvailableEpisodeNumber,
} = require("../database/repositories/episode-repository.cjs");
const { toPublicEpisode, createEpisodeWithContent, updateEpisodeWithContent, deleteEpisodeWithContent } = require("../episode-service.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();

/**
 * 경로 없는 Episode 조회와 metadata/TXT 통합 작업을 Result 계약으로 한 번만 등록한다.
 */
function registerEpisodeHandlers(ipcMain, episodeStorage) {
  if (registeredIpcMains.has(ipcMain)) {
    return;
  }

  ipcMain.handle(IPC_CHANNELS.EPISODE_GET_BY_ID, (_event, id) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_GET_BY_ID, () => toPublicEpisode(getEpisodeById(id))),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_GET_BY_WORK_ID, (_event, workId) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_GET_BY_WORK_ID, () =>
      getEpisodesByWorkId(workId).map(toPublicEpisode),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_CREATE, (_event, input) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_CREATE, () => createEpisodeWithContent(episodeStorage, input)),
  );
  ipcMain.handle(IPC_CHANNELS.EPISODE_UPDATE, (_event, id, changes) =>
    executeIpcAction(IPC_CHANNELS.EPISODE_UPDATE, () => updateEpisodeWithContent(episodeStorage, id, changes)),
  );
  /** 작품 범위를 포함한 회차/TXT 삭제를 통합 작업으로 전달한다. */
  ipcMain.handle(IPC_CHANNELS.EPISODE_DELETE, (_event, id, workId) => executeIpcAction(IPC_CHANNELS.EPISODE_DELETE, () => deleteEpisodeWithContent(episodeStorage, id, workId)));
  /** 현재 DB에서 가장 작은 빈 회차 번호를 읽으며 번호를 예약하거나 생성하지 않는다. */
  ipcMain.handle(IPC_CHANNELS.EPISODE_GET_NEXT_NUMBER, (_event, workId) => executeIpcAction(IPC_CHANNELS.EPISODE_GET_NEXT_NUMBER, () => findNextAvailableEpisodeNumber(workId)));
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
        episodeStorage.resolveManagedPath(episode.workId, episode.storageKey);
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
