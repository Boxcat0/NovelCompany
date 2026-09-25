const IPC_CHANNELS = Object.freeze({
  WORK_GET_ALL: "works:get-all",
  WORK_GET_BY_ID: "works:get-by-id",
  WORK_CREATE: "works:create",
  WORK_UPDATE: "works:update",
  EPISODE_GET_BY_ID: "episodes:get-by-id",
  EPISODE_GET_BY_WORK_ID: "episodes:get-by-work-id",
  EPISODE_CREATE: "episodes:create",
  EPISODE_UPDATE: "episodes:update",
  EPISODE_READ_CONTENT: "episodes:read-content",
  CANON_SPACE_GET_BY_WORK_ID: "canon:spaces:get-by-work-id",
  CANON_SETS_GET_BY_CANON_SPACE_ID: "canon:sets:get-by-canon-space-id",
  CANON_SET_GET_DEFINITION: "canon:sets:get-definition",
});

module.exports = { IPC_CHANNELS };
