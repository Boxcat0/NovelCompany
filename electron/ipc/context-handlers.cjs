const {
  buildEpisodeWorkContext,
} = require("../context/episode-work-context-builder.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();
const sceneNarration = require('../context/scene-narration-service.cjs');
const { buildEpisodeReviewContext } = require('../context/review-context-builder.cjs');

/**
 * 읽기 전용 Context와 작가 지정 장면 시점 저장 IPC를 한 번만 등록한다.
 */
function registerContextHandlers(ipcMain, episodeStorage) {
  if (registeredIpcMains.has(ipcMain)) {
    return;
  }

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT,
    (_event, input) =>
      executeIpcAction(IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT, () =>
        buildEpisodeWorkContext(episodeStorage, input),
      ),
  );
  registeredIpcMains.add(ipcMain);
  ipcMain.handle(IPC_CHANNELS.SCENE_NARRATION_GET_FOR_EPISODE, (_event, input) => executeIpcAction(IPC_CHANNELS.SCENE_NARRATION_GET_FOR_EPISODE, () => sceneNarration.getForEpisode(episodeStorage, input)));
  ipcMain.handle(IPC_CHANNELS.SCENE_NARRATION_SAVE, (_event, input) => executeIpcAction(IPC_CHANNELS.SCENE_NARRATION_SAVE, () => sceneNarration.save(episodeStorage, input)));
  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT, (_event, input) => executeIpcAction(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT, () => buildEpisodeReviewContext(episodeStorage, input)));
}

module.exports = { registerContextHandlers };
