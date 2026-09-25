const { IPC_CHANNELS } = require("./ipc-channels.cjs");

/**
 * 승인된 IPC channel만 호출하는 Renderer 전용 API 객체를 만든다.
 */
function createNovelCompanyApi(ipcRenderer) {
  return {
    works: {
      getAll: () => ipcRenderer.invoke(IPC_CHANNELS.WORK_GET_ALL),
      getById: (id) => ipcRenderer.invoke(IPC_CHANNELS.WORK_GET_BY_ID, id),
      create: (input) => ipcRenderer.invoke(IPC_CHANNELS.WORK_CREATE, input),
      update: (id, changes) =>
        ipcRenderer.invoke(IPC_CHANNELS.WORK_UPDATE, id, changes),
    },
    episodes: {
      getById: (id) =>
        ipcRenderer.invoke(IPC_CHANNELS.EPISODE_GET_BY_ID, id),
      getByWorkId: (workId) =>
        ipcRenderer.invoke(IPC_CHANNELS.EPISODE_GET_BY_WORK_ID, workId),
      create: (input) =>
        ipcRenderer.invoke(IPC_CHANNELS.EPISODE_CREATE, input),
      update: (id, changes) =>
        ipcRenderer.invoke(IPC_CHANNELS.EPISODE_UPDATE, id, changes),
      readContent: (episodeId) =>
        ipcRenderer.invoke(IPC_CHANNELS.EPISODE_READ_CONTENT, episodeId),
    },
    canon: {
      spaces: {
        getByWorkId: (workId) =>
          ipcRenderer.invoke(IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID, workId),
      },
      sets: {
        getByCanonSpaceId: (canonSpaceId) =>
          ipcRenderer.invoke(
            IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID,
            canonSpaceId,
          ),
        getDefinition: (setId) =>
          ipcRenderer.invoke(IPC_CHANNELS.CANON_SET_GET_DEFINITION, setId),
      },
    },
  };
}

module.exports = { createNovelCompanyApi };
