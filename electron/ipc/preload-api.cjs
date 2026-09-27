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
      /** 작품 삭제 가능 상태 조회 인자를 Main으로 전달한다. */
      getDeletionStatus: (id) => ipcRenderer.invoke(IPC_CHANNELS.WORK_GET_DELETION_STATUS, id),
      /** 최종 의존성 검사를 포함하는 작품 삭제를 요청한다. */
      delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.WORK_DELETE, id),
    },
    episodes: {
      /** 회차와 TXT를 함께 삭제할 작품 범위를 전달한다. */
      delete: (id, workId) => ipcRenderer.invoke(IPC_CHANNELS.EPISODE_DELETE, id, workId),
      /** DB의 현재 빈 번호를 추천받는다. */
      getNextAvailableNumber: (workId) => ipcRenderer.invoke(IPC_CHANNELS.EPISODE_GET_NEXT_NUMBER, workId),
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
      records: {
        /** 검증용 bridge에서 목록 조회 인자를 전달한다. */
        getBySetId: (scope) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_GET_BY_SET_ID, scope),
        /** 검증용 bridge에서 상세 조회 인자를 전달한다. */
        getById: (scope, id) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_GET_BY_ID, scope, id),
        /** 검증용 bridge에서 선행조건 조회 인자를 전달한다. */
        getCreateReadiness: (scope) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_GET_CREATE_READINESS, scope),
        /** 검증용 bridge에서 참조 선택지 조회 인자를 전달한다. */
        getReferenceOptions: (scope, fieldId, id) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_GET_REFERENCE_OPTIONS, scope, fieldId, id),
        /** 검증용 bridge에서 생성 입력을 전달한다. */
        create: (scope, input) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_CREATE, scope, input),
        /** 검증용 bridge에서 수정 입력을 전달한다. */
        update: (scope, id, input) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_UPDATE, scope, id, input),
        /** 검증용 bridge에서 삭제 범위를 전달한다. */
        delete: (scope, id) => ipcRenderer.invoke(IPC_CHANNELS.CANON_RECORD_DELETE, scope, id),
      },
      spaces: {
        /** 선택 작품의 최신 Canon 삭제 영향을 조회한다. */
        getDeletionStatus: (workId) => ipcRenderer.invoke(IPC_CHANNELS.CANON_SPACE_GET_DELETION_STATUS, workId),
        /** 명시적으로 확인한 작품의 Canon 전체 삭제를 Main에 요청한다. */
        deleteForWork: (workId) => ipcRenderer.invoke(IPC_CHANNELS.CANON_SPACE_DELETE_FOR_WORK, workId),
        /** 선택 작품의 빈 CanonSpace 생성을 Main에 요청한다. */
        createForWork: (workId) => ipcRenderer.invoke(IPC_CHANNELS.CANON_SPACE_CREATE_FOR_WORK, workId),
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
    context: {
      /** 저장된 원고와 Canon을 Main-side builder에서 조합하도록 요청한다. */
      getEpisodeWorkContext: (input) =>
        ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT, input),
    },
    reviews: {
      /** 검토 lifecycle 시작 요청을 고정 channel로 전달한다. */
      start: (input) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_START, input),
      /** 현재 source freshness를 포함한 Episode history 요청을 전달한다. */
      getByEpisode: (input) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GET_BY_EPISODE, input),
      /** 지정 ReviewRun 단건 요청을 전달한다. */
      getById: (reviewRunId) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GET_BY_ID, reviewRunId),
    },
  };
}

module.exports = { createNovelCompanyApi };
