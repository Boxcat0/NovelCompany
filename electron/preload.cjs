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
 * 에피소드 생성 요청을 Main Process로 전달한다.
 */
function createEpisode(input) {
  return ipcRenderer.invoke("episodes:create", input);
}

/**
 * 에피소드 수정 요청을 Main Process로 전달한다.
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
    },
    episodes: {
      getById: getEpisodeById,
      getByWorkId: getEpisodesByWorkId,
      create: createEpisode,
      update: updateEpisode,
      readContent: readEpisodeContent,
    },
    canon: {
      spaces: { getByWorkId: getCanonSpaceByWorkId },
      sets: {
        getByCanonSpaceId: getCanonSetsByCanonSpaceId,
        getDefinition: getCanonSetDefinition,
      },
    },
  });
}

exposeNovelCompanyApi();
