const {
  createWork,
  getAllWorks,
  getWorkById,
  updateWork,
} = require("../database/repositories/work-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();

/**
 * Work Repository 요청을 처리할 IPC Handler를 한 번만 등록한다.
 */
function registerWorkHandlers(ipcMain) {
  if (registeredIpcMains.has(ipcMain)) {
    return;
  }

  ipcMain.handle(IPC_CHANNELS.WORK_GET_ALL, () =>
    executeIpcAction(IPC_CHANNELS.WORK_GET_ALL, getAllWorks),
  );
  ipcMain.handle(IPC_CHANNELS.WORK_GET_BY_ID, (_event, id) =>
    executeIpcAction(IPC_CHANNELS.WORK_GET_BY_ID, () => getWorkById(id)),
  );
  ipcMain.handle(IPC_CHANNELS.WORK_CREATE, (_event, input) =>
    executeIpcAction(IPC_CHANNELS.WORK_CREATE, () => createWork(input)),
  );
  ipcMain.handle(IPC_CHANNELS.WORK_UPDATE, (_event, id, changes) =>
    executeIpcAction(IPC_CHANNELS.WORK_UPDATE, () => {
      const work = updateWork(id, changes);
      if (!work) {
        throw new RepositoryError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
      }
      return work;
    }),
  );

  registeredIpcMains.add(ipcMain);
}

module.exports = { registerWorkHandlers };

