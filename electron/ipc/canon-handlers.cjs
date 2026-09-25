const { getCanonDefinitionBySetId, getCanonSetsByCanonSpaceId, getCanonSpaceByWorkId } = require("../database/repositories/canon-definition-repository.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();

/**
 * Renderer의 읽기 전용 Canon Definition 요청을 한 번만 등록한다.
 */
function registerCanonHandlers(ipcMain) {
  if (registeredIpcMains.has(ipcMain)) return;
  ipcMain.handle(IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID, (_event, workId) => executeIpcAction(IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID, () => getCanonSpaceByWorkId(workId)));
  ipcMain.handle(IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID, (_event, canonSpaceId) => executeIpcAction(IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID, () => getCanonSetsByCanonSpaceId(canonSpaceId)));
  ipcMain.handle(IPC_CHANNELS.CANON_SET_GET_DEFINITION, (_event, setId) => executeIpcAction(IPC_CHANNELS.CANON_SET_GET_DEFINITION, () => getCanonDefinitionBySetId(setId)));
  registeredIpcMains.add(ipcMain);
}

module.exports = { registerCanonHandlers };
