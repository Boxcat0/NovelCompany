const { getReviewById, getReviewsByEpisode, startEpisodeReview } = require("../review/review-service.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();

/** Renderer Review 요청을 service로만 전달하고 Result bridge를 한 번만 등록한다. */
function registerReviewHandlers(ipcMain, episodeStorage) {
  if (registeredIpcMains.has(ipcMain)) return;
  ipcMain.handle(IPC_CHANNELS.REVIEW_START, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_START, () => startEpisodeReview(episodeStorage, input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_BY_EPISODE, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_GET_BY_EPISODE, () => getReviewsByEpisode(episodeStorage, input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_BY_ID, (_event, reviewRunId) => executeIpcAction(IPC_CHANNELS.REVIEW_GET_BY_ID, () => getReviewById(episodeStorage, reviewRunId)));
  registeredIpcMains.add(ipcMain);
}

module.exports = { registerReviewHandlers };
