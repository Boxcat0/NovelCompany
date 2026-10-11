const { getReviewById, getReviewsByEpisode } = require("../review/review-service.cjs");
const { createReviewQueue } = require('../review/review-queue-service.cjs');
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");
const decisions = require('../database/repositories/review-decision-repository.cjs');

const registeredIpcMains = new WeakSet();

/** Review와 작가 판단 요청을 범위 검증 서비스·Repository 및 공통 Result gate에 연결한다. */
function registerReviewHandlers(ipcMain, episodeStorage, queue = createReviewQueue(episodeStorage)) {
  if (registeredIpcMains.has(ipcMain)) return;
  queue.start();
  ipcMain.handle(IPC_CHANNELS.REVIEW_DECISIONS_LIST, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_DECISIONS_LIST, () => decisions.listFindingDecisionsForRun(input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_DECISIONS_HISTORY, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_DECISIONS_HISTORY, () => decisions.listFindingDecisionHistory(input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_DECISIONS_APPEND, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_DECISIONS_APPEND, () => decisions.appendFindingDecision(input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_START, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_START, () => queue.submit(input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_SUBMIT, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_SUBMIT, () => queue.submit(input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_QUEUE, () => executeIpcAction(IPC_CHANNELS.REVIEW_GET_QUEUE, () => queue.getQueue()));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_JOB_BY_EPISODE, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_GET_JOB_BY_EPISODE, () => queue.getLatestByEpisode(input?.workId, input?.episodeId)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_CANCEL_QUEUED, (_event, id) => executeIpcAction(IPC_CHANNELS.REVIEW_CANCEL_QUEUED, () => queue.cancelQueued(id)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_BY_EPISODE, (_event, input) => executeIpcAction(IPC_CHANNELS.REVIEW_GET_BY_EPISODE, () => getReviewsByEpisode(episodeStorage, input)));
  ipcMain.handle(IPC_CHANNELS.REVIEW_GET_BY_ID, (_event, reviewRunId) => executeIpcAction(IPC_CHANNELS.REVIEW_GET_BY_ID, () => getReviewById(episodeStorage, reviewRunId)));
  registeredIpcMains.add(ipcMain);
}

module.exports = { registerReviewHandlers };
