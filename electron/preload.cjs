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
 * 저장된 Episode TXT와 해당 Work의 Canon을 조합한 읽기 전용 Context를 Main Process에 요청한다.
 */
function getEpisodeWorkContext(input) {
  return ipcRenderer.invoke("context:get-episode-work-context", input);
}

/** 저장된 원고의 읽기 전용 Scene 및 Relevant Canon 분석을 요청한다. */
function getEpisodeReviewContext(input) {
  return ipcRenderer.invoke('context:get-episode-review-context', input);
}

/** 저장된 Episode와 선택 검토 방식을 기존 제출 IPC로 Main에 전달한다. */
function submitReview(input) { return ipcRenderer.invoke("reviews:submit", input); }

/** 전역 대기열과 선택 회차의 최근 제출 상태를 읽는다. */
function getReviewQueue() { return ipcRenderer.invoke('reviews:get-queue'); }
/** 선택한 작품·회차의 최신 제출 상태만 읽는다. */
function getReviewJobByEpisode(input) { return ipcRenderer.invoke('reviews:get-job-by-episode', input); }

/** QUEUED 제출만 조건부로 철회한다. */
function cancelQueuedReview(id) { return ipcRenderer.invoke('reviews:cancel-queued', id); }

/** 현재 source freshness가 계산된 Episode Review history를 Main에서 읽는다. */
function getReviewsByEpisode(input) { return ipcRenderer.invoke("reviews:get-by-episode", input); }

/** Run ID 하나의 현재 source freshness와 finding을 Main에서 읽는다. */
function getReviewById(reviewRunId) { return ipcRenderer.invoke("reviews:get-by-id", reviewRunId); }

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
    backup: {
      /** Main 파일 선택 창으로 전체 데이터 내보내기를 요청한다. */
      export: () => ipcRenderer.invoke('backup:export'),
      /** 선택한 방식에 따라 파일을 검증하고 적용 전 요약만 요청한다. */
      preview: (mode = 'overwrite') => ipcRenderer.invoke('backup:preview', mode),
      /** Main의 최종 확인을 거쳐 검증한 단회 token으로 교체 또는 업데이트를 요청한다. */
      import: (token) => ipcRenderer.invoke('backup:import', token),
      /** 사용하지 않는 프리뷰 파일을 정리한다. */
      cancelPreview: () => ipcRenderer.invoke('backup:cancel-preview'),
      /** 실제 단계와 현재 데이터 요약을 조회한다. */
      status: () => ipcRenderer.invoke('backup:status'),
      /** 파일 접근 없이 현재 편집 상태만 Main에 알린다. */
      editorState: (dirty, busy) => ipcRenderer.send('backup:editor-state', { dirty, busy }),
      /** Electron event를 노출하지 않고 실제 작업 단계만 구독·해제한다. */
      onProgress: (callback) => {
        const listener = (_event, state) => callback({ busy: state.busy, phase: state.phase });
        ipcRenderer.on('backup:progress', listener);
        return () => ipcRenderer.removeListener('backup:progress', listener);
      },
    },
    sceneNarration: {
      /** 저장된 장면 목록과 지정 시점을 요청한다. */
      getForEpisode: (input) => ipcRenderer.invoke('scene-narration:get-for-episode', input),
      /** 작가가 지정한 장면 시점을 조건부로 저장한다. */
      save: (input) => ipcRenderer.invoke('scene-narration:save', input),
    },
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
      staging: {
        /** 선택 작품의 등록 대기 목록과 실제 Definition을 조회한다. */
        list: (scope) => ipcRenderer.invoke('canon:staging:list', scope),
        /** 같은 작품의 후보 상세만 조회한다. */
        get: (scope, id) => ipcRenderer.invoke('canon:staging:get', scope, id),
        /** 작가 수정본을 기대 revision으로 임시 저장한다. */
        update: (scope, id, input) => ipcRenderer.invoke('canon:staging:update', scope, id, input),
        /** Main 파일 선택과 읽기 전용 JSON 검증만 요청한다. */
        previewImport: (scope) => ipcRenderer.invoke('canon:staging:preview-import', scope),
        /** 별도 승인 token으로 Staging Import만 실행한다. */
        import: (scope, token, approved) => ipcRenderer.invoke('canon:staging:import', scope, token, approved),
        /** 선택 후보의 정식 Canon 적용 내용을 검증한다. */
        previewPromotion: (scope, selection) => ipcRenderer.invoke('canon:staging:preview-promotion', scope, selection),
        /** 최종 승인한 배치만 공식 Canon에 원자적으로 등록한다. */
        promote: (scope, token, approved) => ipcRenderer.invoke('canon:staging:promote', scope, token, approved),
        /** Main에 보관된 파일 및 승인 미리보기를 취소한다. */
        cancelPreview: () => ipcRenderer.invoke('canon:staging:cancel-preview'),
      },
      aliases: {
        /** 현재 작품 Character의 별칭만 조회한다. */
        list: (scope) => ipcRenderer.invoke('canon:aliases:list', scope),
        /** 저장된 Character에 별칭을 등록한다. */
        create: (scope, text) => ipcRenderer.invoke('canon:aliases:create', scope, text),
        /** 해당 Character의 별칭만 수정한다. */
        update: (scope, id, text) => ipcRenderer.invoke('canon:aliases:update', scope, id, text),
        /** 해당 Character를 보존하며 별칭만 삭제한다. */
        delete: (scope, id) => ipcRenderer.invoke('canon:aliases:delete', scope, id),
      },
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
    context: {
      getEpisodeWorkContext,
      getEpisodeReviewContext,
    },
    reviews: {
      start: submitReview, submit: submitReview, getQueue: getReviewQueue, getJobByEpisode: getReviewJobByEpisode, cancelQueued: cancelQueuedReview, getByEpisode: getReviewsByEpisode, getById: getReviewById,
      decisions: {
        /** Run에 속하는 전체 Finding의 판단을 한 번에 조회한다. */
        listForRun: (scope) => ipcRenderer.invoke('reviews:decisions:list', scope),
        /** 선택 Finding의 변경 불가 판단 이력을 조회한다. */
        history: (scope) => ipcRenderer.invoke('reviews:decisions:history', scope),
        /** 작가가 선택한 상태·메모와 예상 revision을 Main에 전달한다. */
        append: (input) => ipcRenderer.invoke('reviews:decisions:append', input),
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
