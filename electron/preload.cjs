const { contextBridge, ipcRenderer } = require("electron");
/**
 * 모든 작품을 조회하는 IPC 요청을 Main Process로 전달한다.
 */
function getAllWorks() {
  return ipcRenderer.invoke("works:get-all");
}

/**
 * 식별자로 작품 하나를 조회하는 IPC 요청을 Main Process로 전달한다.
 */
function getWorkById(id) {
  return ipcRenderer.invoke("works:get-by-id", id);
}

/**
 * 작품 생성 요청을 Main Process로 전달한다.
 */
function createWork(input) {
  return ipcRenderer.invoke("works:create", input);
}

/**
 * 작품 수정 요청을 Main Process로 전달한다.
 */
function updateWork(id, changes) {
  return ipcRenderer.invoke("works:update", id, changes);
}

/** 작품에 연결된 회차와 Canon 데이터에 따른 삭제 가능 여부를 요청한다. */
function getWorkDeletionStatus(id) {
  return ipcRenderer.invoke("works:get-deletion-status", id);
}

/** 사용자가 확인한 작품 삭제 요청을 Main의 최종 의존성 검사로 전달한다. */
function deleteWork(id) {
  return ipcRenderer.invoke("works:delete", id);
}

/**
 * 식별자로 에피소드 하나를 조회하는 IPC 요청을 Main Process로 전달한다.
 */
function getEpisodeById(id) {
  return ipcRenderer.invoke("episodes:get-by-id", id);
}

/**
 * 작품 식별자에 속한 에피소드를 조회하는 IPC 요청을 Main Process로 전달한다.
 */
function getEpisodesByWorkId(workId) {
  return ipcRenderer.invoke("episodes:get-by-work-id", workId);
}

/**
 * 회차 metadata와 원고를 한 생성 요청으로 Main에 전달한다.
 */
function createEpisode(input) {
  return ipcRenderer.invoke("episodes:create", input);
}

/**
 * 작품 범위와 회차 metadata/원고 전체를 한 수정 요청으로 전달한다.
 */
function updateEpisode(id, changes) {
  return ipcRenderer.invoke("episodes:update", id, changes);
}

/**
 * 에피소드 식별자로 읽기 전용 TXT 본문 조회 요청을 Main Process로 전달한다.
 */
function readEpisodeContent(episodeId) {
  return ipcRenderer.invoke("episodes:read-content", episodeId);
}

/** 확인된 회차의 metadata와 TXT를 함께 삭제하도록 Main에 요청한다. */
function deleteEpisode(id, workId) {
  return ipcRenderer.invoke("episodes:delete", id, workId);
}

/** 현재 작품에서 비어 있는 가장 작은 양의 회차 번호를 요청한다. */
function getNextAvailableEpisodeNumber(workId) {
  return ipcRenderer.invoke("episodes:get-next-number", workId);
}

/**
 * Work에 연결된 CanonSpace 조회 요청을 Main Process로 전달한다.
 */
function getCanonSpaceByWorkId(workId) {
  return ipcRenderer.invoke("canon:spaces:get-by-work-id", workId);
}

/**
 * CanonSpace의 CanonSet 목록 조회 요청을 Main Process로 전달한다.
 */
function getCanonSetsByCanonSpaceId(canonSpaceId) {
  return ipcRenderer.invoke("canon:sets:get-by-canon-space-id", canonSpaceId);
}

/**
 * CanonSet의 Field Definition 조회 요청을 Main Process로 전달한다.
 */
function getCanonSetDefinition(setId) {
  return ipcRenderer.invoke("canon:sets:get-definition", setId);
}

/**
 * Renderer에는 허용된 NovelCompany API만 안전하게 공개한다.
 */
function exposeNovelCompanyApi() {
  contextBridge.exposeInMainWorld("novelCompany", {
    works: {
      getAll: getAllWorks,
      getById: getWorkById,
      create: createWork,
      update: updateWork,
      getDeletionStatus: getWorkDeletionStatus,
      delete: deleteWork,
    },
    episodes: {
      getById: getEpisodeById,
      getByWorkId: getEpisodesByWorkId,
      create: createEpisode,
      update: updateEpisode,
      readContent: readEpisodeContent,
      delete: deleteEpisode,
      getNextAvailableNumber: getNextAvailableEpisodeNumber,
    },
    canon: {
      records: {
        getBySetId: getCanonRecordsBySetId,
        getById: getCanonRecordById,
        getCreateReadiness: getCanonCreateReadiness,
        getReferenceOptions: getCanonReferenceOptions,
        create: createCanonRecord,
        update: updateCanonRecord,
        delete: deleteCanonRecord,
      },
      spaces: { getByWorkId: getCanonSpaceByWorkId, createForWork: createCanonSpaceForWork, getDeletionStatus: getCanonDeletionStatus, deleteForWork: deleteCanonForWork },
      sets: {
        getByCanonSpaceId: getCanonSetsByCanonSpaceId,
        getDefinition: getCanonSetDefinition,
      },
    },
  });
}

exposeNovelCompanyApi();

/** Set 범위의 실제 레코드 목록 요청을 전달한다. */
function getCanonRecordsBySetId(scope) { return ipcRenderer.invoke("canon:records:get-by-set-id", scope); }
/** 범위와 ID로 레코드 상세 요청을 전달한다. */
function getCanonRecordById(scope, id) { return ipcRenderer.invoke("canon:records:get-by-id", scope, id); }
/** 필수 참조 선행조건의 현재 상태 요청을 전달한다. */
function getCanonCreateReadiness(scope) { return ipcRenderer.invoke("canon:records:get-create-readiness", scope); }
/** 현재 편집자를 포함해 실제 참조 선택지를 요청한다. */
function getCanonReferenceOptions(scope, fieldId, editingRecordId) { return ipcRenderer.invoke("canon:records:get-reference-options", scope, fieldId, editingRecordId); }
/** 작가가 입력한 신규 설정 저장 요청을 전달한다. */
function createCanonRecord(scope, input) { return ipcRenderer.invoke("canon:records:create", scope, input); }
/** 작가가 수정한 전체 설정 저장 요청을 전달한다. */
function updateCanonRecord(scope, id, input) { return ipcRenderer.invoke("canon:records:update", scope, id, input); }
/** 작가가 확인한 항목 삭제 요청을 전달한다. */
function deleteCanonRecord(scope, id) { return ipcRenderer.invoke("canon:records:delete", scope, id); }

/** 사용자 요청으로 선택 작품의 빈 CanonSpace를 생성하도록 Main에 전달한다. */
function createCanonSpaceForWork(workId) {
  return ipcRenderer.invoke("canon:spaces:create-for-work", workId);
}

/** 선택 작품의 최신 Canon 삭제 영향 요약을 Main에서 읽는다. */
function getCanonDeletionStatus(workId) {
  return ipcRenderer.invoke("canon:spaces:get-deletion-status", workId);
}

/** 사용자 확인 후 선택 작품의 Canon 전체 삭제를 Main에 전달한다. */
function deleteCanonForWork(workId) {
  return ipcRenderer.invoke("canon:spaces:delete-for-work", workId);
}
