const {
  buildEpisodeWorkContext,
} = require("../context/episode-work-context-builder.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();
const { buildEpisodeReviewContext } = require('../context/review-context-builder.cjs');

/**
 * 저장된 TXT와 Work Canon을 조합하는 read-only Context IPC handler를 한 번만 등록한다.
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
  ipcMain.handle(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT, (_event, input) => executeIpcAction(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT, () => buildEpisodeReviewContext(episodeStorage, input)));
}

module.exports = { registerContextHandlers };
