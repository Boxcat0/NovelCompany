const { createCanonSpaceForWork, getCanonDefinitionBySetId, getCanonSetsByCanonSpaceId, getCanonSpaceByWorkId, getCanonDeletionStatus, deleteCanonForWork } = require("../database/repositories/canon-definition-repository.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");

const registeredIpcMains = new WeakSet();
const records = require("../database/repositories/canon-record-repository.cjs");
const aliases = require('../database/repositories/canon-alias-repository.cjs');

/**
 * Canon lifecycle, 정의 조회와 범위 검증을 수행하는 Record API를 Result 계약으로 한 번만 등록한다.
 */
function registerCanonHandlers(ipcMain) {
  if (registeredIpcMains.has(ipcMain)) return;
  const recordActions = [
    [IPC_CHANNELS.CANON_ALIAS_LIST, aliases.list],
    [IPC_CHANNELS.CANON_ALIAS_CREATE, aliases.create],
    [IPC_CHANNELS.CANON_ALIAS_UPDATE, aliases.update],
    [IPC_CHANNELS.CANON_ALIAS_DELETE, aliases.delete],
    [IPC_CHANNELS.CANON_RECORD_GET_BY_SET_ID, records.getBySetId],
    [IPC_CHANNELS.CANON_RECORD_GET_BY_ID, records.getById],
    [IPC_CHANNELS.CANON_RECORD_GET_CREATE_READINESS, records.getCreateReadiness],
    [IPC_CHANNELS.CANON_RECORD_GET_REFERENCE_OPTIONS, records.getReferenceOptions],
    [IPC_CHANNELS.CANON_RECORD_CREATE, records.create],
    [IPC_CHANNELS.CANON_RECORD_UPDATE, records.update],
    [IPC_CHANNELS.CANON_RECORD_DELETE, records.delete],
  ];
  for (const [channel, action] of recordActions) {
    ipcMain.handle(channel, (_event, ...args) => executeIpcAction(channel, () => action(...args)));
  }
  /** 명시적 Canon 시작 요청을 기존 Result 경로로 처리한다. */
  ipcMain.handle(IPC_CHANNELS.CANON_SPACE_CREATE_FOR_WORK, (_event, workId) => executeIpcAction(IPC_CHANNELS.CANON_SPACE_CREATE_FOR_WORK, () => createCanonSpaceForWork(workId)));
  /** 최신 Canon 삭제 영향을 읽고 내부 오류는 Main 로그로 제한한다. */
  ipcMain.handle(IPC_CHANNELS.CANON_SPACE_GET_DELETION_STATUS, (_event, workId) => executeIpcAction(IPC_CHANNELS.CANON_SPACE_GET_DELETION_STATUS, () => getCanonDeletionStatus(workId)));
  /** 명시적 Canon 전체 삭제를 transaction Repository와 Result 계약으로 연결한다. */
  ipcMain.handle(IPC_CHANNELS.CANON_SPACE_DELETE_FOR_WORK, (_event, workId) => executeIpcAction(IPC_CHANNELS.CANON_SPACE_DELETE_FOR_WORK, () => deleteCanonForWork(workId)));
  ipcMain.handle(IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID, (_event, workId) => executeIpcAction(IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID, () => getCanonSpaceByWorkId(workId)));
  ipcMain.handle(IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID, (_event, canonSpaceId) => executeIpcAction(IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID, () => getCanonSetsByCanonSpaceId(canonSpaceId)));
  ipcMain.handle(IPC_CHANNELS.CANON_SET_GET_DEFINITION, (_event, setId) => executeIpcAction(IPC_CHANNELS.CANON_SET_GET_DEFINITION, () => getCanonDefinitionBySetId(setId)));
  registeredIpcMains.add(ipcMain);
}

module.exports = { registerCanonHandlers };
