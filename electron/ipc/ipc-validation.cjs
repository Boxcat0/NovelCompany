const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { closeDatabase, getDatabase, initializeDatabase } = require("../database/database.cjs");
const { executeIpcAction } = require("./ipc-action.cjs");
const { IPC_CHANNELS } = require("./ipc-channels.cjs");
const { registerEpisodeHandlers } = require("./episode-handlers.cjs");
const { registerCanonHandlers } = require("./canon-handlers.cjs");
const { registerContextHandlers } = require("./context-handlers.cjs");
const { registerReviewHandlers } = require("./review-handlers.cjs");
const { createNovelCompanyApi } = require("./preload-api.cjs");
const { registerWorkHandlers } = require("./work-handlers.cjs");
const { LocalEpisodeStorage } = require("../storage/local-episode-storage.cjs");

/**
 * IPC handler 등록을 수집하고 중복 channel 등록을 차단하는 가짜 ipcMain을 만든다.
 */
function createIpcMainDouble() {
  const handlers = new Map();

  return {
    handlers,
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `Duplicate channel: ${channel}`);
      handlers.set(channel, handler);
    },
  };
}

/**
 * 지정된 오류 code와 한국어 message를 포함한 실패 Result인지 검증한다.
 */
function expectFailure(result, code, message) {
  assert.deepEqual(result, {
    ok: false,
    error: { code, message },
  });
}

/**
 * self-contained runtime preload를 Electron 대역으로 실행해 공개 API 계약을 검증한다.
 */
function loadRuntimePreloadApiForValidation() {
  const preloadPath = path.join(__dirname, "../preload.cjs");
  const preloadSource = fs.readFileSync(preloadPath, "utf8");
  let exposedApi;

  vm.runInNewContext(preloadSource, {
    require(moduleName) {
      assert.equal(moduleName, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            assert.equal(name, "novelCompany");
            exposedApi = api;
          },
        },
        ipcRenderer: {
          invoke(channel, ...args) {
            return Promise.resolve({ ok: true, data: { channel, args } });
          },
        },
      };
    },
  });

  assert.ok(exposedApi);
  return exposedApi;
}

/**
 * IPC Handler, Result 은닉, preload API를 production DB와 분리된 환경에서 검증한다.
 */
async function runValidation() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novel-company-ipc-"),
  );
  process.env.NOVEL_COMPANY_DATA_DIR = temporaryRoot;

  try {
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    const episodeStorage = new LocalEpisodeStorage(temporaryRoot);
    await assert.rejects(
      () => episodeStorage.readEpisodeByStorageKey("../outside.txt"),
      /invalid path segment/,
    );
    const ipcMain = createIpcMainDouble();
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain);
    registerEpisodeHandlers(ipcMain, episodeStorage);
    registerContextHandlers(ipcMain, episodeStorage);
    registerReviewHandlers(ipcMain, episodeStorage);
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain);
    registerEpisodeHandlers(ipcMain, episodeStorage);
    registerContextHandlers(ipcMain, episodeStorage);
    registerReviewHandlers(ipcMain, episodeStorage);

    const channels = Object.values(IPC_CHANNELS);
    assert.equal(new Set(channels).size, channels.length);
    assert.equal(ipcMain.handlers.size, channels.length);

    const createWork = ipcMain.handlers.get(IPC_CHANNELS.WORK_CREATE);
    const createdWorkResult = await createWork(null, {
      title: "IPC 검증 작품",
      status: "ACTIVE",
    });
    assert.equal(createdWorkResult.ok, true);
    const work = createdWorkResult.data;
    const database = getDatabase();
    const now = "2026-01-01T00:00:00.000Z";
    database.prepare("INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)").run("ipc-canon-space", work.id, "MODERN_FANTASY_V1", now, now);
    database.prepare("INSERT INTO canon_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ipc-canon-set", "ipc-canon-space", "character", "캐릭터", "캐릭터 이름", null, 1, now, now);
    database.prepare("INSERT INTO canon_fields (id, canon_space_id, canon_set_id, key, label, value_type, input_control, reference_set_id, required, help_text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ipc-canon-field", "ipc-canon-space", "ipc-canon-set", "description", "설명", "LONG_TEXT", "TEXTAREA", null, 0, null, 1, now, now);

    const getAllWorks = ipcMain.handlers.get(IPC_CHANNELS.WORK_GET_ALL);
    const allWorksResult = await getAllWorks(null);
    assert.equal(allWorksResult.ok, true);
    assert.equal(allWorksResult.data.length, 1);

    const getWorkById = ipcMain.handlers.get(IPC_CHANNELS.WORK_GET_BY_ID);
    assert.equal((await getWorkById(null, work.id)).data.id, work.id);
    assert.deepEqual(await getWorkById(null, "missing-work"), {
      ok: true,
      data: null,
    });

    const getCanonSpace = ipcMain.handlers.get(
      IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID,
    );
    assert.equal((await getCanonSpace(null, work.id)).data.id, "ipc-canon-space");
    assert.deepEqual(await getCanonSpace(null, "missing-work"), {
      ok: true,
      data: null,
    });
    const getCanonSets = ipcMain.handlers.get(
      IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID,
    );
    assert.equal((await getCanonSets(null, "ipc-canon-space")).data[0].key, "character");
    const getCanonDefinition = ipcMain.handlers.get(
      IPC_CHANNELS.CANON_SET_GET_DEFINITION,
    );
    assert.equal((await getCanonDefinition(null, "ipc-canon-set")).data.fields[0].key, "description");
    assert.deepEqual(await getCanonDefinition(null, "missing-set"), {
      ok: true,
      data: null,
    });

    const updateWork = ipcMain.handlers.get(IPC_CHANNELS.WORK_UPDATE);
    assert.equal(
      (await updateWork(null, work.id, { title: "수정된 IPC 작품" })).data.title,
      "수정된 IPC 작품",
    );
    expectFailure(
      await updateWork(null, "missing-work", { title: "없음" }),
      "WORK_NOT_FOUND",
      "작품을 찾을 수 없습니다.",
    );
    expectFailure(
      await createWork(null, { title: " " }),
      "WORK_TITLE_REQUIRED",
      "작품 제목을 입력해 주세요.",
    );

    const createEpisode = ipcMain.handlers.get(IPC_CHANNELS.EPISODE_CREATE);
    const firstEpisodeResult = await createEpisode(null, {
      workId: work.id,
      episodeNumber: 1,
      title: "첫 번째 IPC 회차",
      content: "첫 문장입니다.\n\n두 번째 문장입니다.",
    });
    assert.equal(firstEpisodeResult.ok, true);
    const episode = firstEpisodeResult.data;
    const expectedContent = "첫 문장입니다.\n\n두 번째 문장입니다.";
    assert.equal("storageKey" in episode, false);

    const getEpisodeById = ipcMain.handlers.get(IPC_CHANNELS.EPISODE_GET_BY_ID);
    assert.equal((await getEpisodeById(null, episode.id)).data.id, episode.id);

    const getEpisodesByWorkId = ipcMain.handlers.get(
      IPC_CHANNELS.EPISODE_GET_BY_WORK_ID,
    );
    assert.equal((await getEpisodesByWorkId(null, work.id)).data.length, 1);

    const readEpisodeContent = ipcMain.handlers.get(
      IPC_CHANNELS.EPISODE_READ_CONTENT,
    );
    assert.deepEqual(await readEpisodeContent(null, episode.id), {
      ok: true,
      data: expectedContent,
    });
    const getEpisodeWorkContext = ipcMain.handlers.get(
      IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT,
    );
    const contextResult = await getEpisodeWorkContext(null, {
      workId: work.id,
      episodeId: episode.id,
    });
    assert.equal(contextResult.ok, true);
    assert.equal(contextResult.data.scope, "FULL_CANON");
    assert.equal(contextResult.data.episode.content, expectedContent);
    assert.equal(contextResult.data.canon.summary.setCount, 1);
    assert.equal("storageKey" in contextResult.data.episode, false);
    const reviewContextResult = await ipcMain.handlers.get(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT)(null, { workId: work.id, episodeId: episode.id });
    assert.equal(reviewContextResult.ok, true);
    assert.equal(reviewContextResult.data.scope, 'RELEVANT_CANON');
    assert.equal(reviewContextResult.data.episode.content, expectedContent);
    assert.equal('storageKey' in reviewContextResult.data.episode, false);
    assert.equal((await ipcMain.handlers.get(IPC_CHANNELS.CONTEXT_GET_EPISODE_REVIEW_CONTEXT)(null, { workId: 'missing', episodeId: episode.id })).ok, false);
    const startReview = ipcMain.handlers.get(IPC_CHANNELS.REVIEW_START);
    const reviewResult = await startReview(null, { workId: work.id, episodeId: episode.id });
    assert.equal(reviewResult.ok, true);
    assert.ok(['QUEUED', 'RUNNING', 'COMPLETED'].includes(reviewResult.data.status));
    for (let attempt = 0; attempt < 100 && getDatabase().prepare("SELECT status FROM review_jobs WHERE id = ?").get(reviewResult.data.id).status !== 'COMPLETED'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getDatabase().prepare("SELECT status FROM review_jobs WHERE id = ?").get(reviewResult.data.id).status, 'COMPLETED');
    assert.equal(getDatabase().prepare("SELECT processor_key FROM review_runs WHERE id = ?").get(getDatabase().prepare("SELECT review_run_id FROM review_jobs WHERE id = ?").get(reviewResult.data.id).review_run_id).processor_key, 'STUB_V1');
    const getReviewsByEpisode = ipcMain.handlers.get(IPC_CHANNELS.REVIEW_GET_BY_EPISODE);
    assert.equal((await getReviewsByEpisode(null, { workId: work.id, episodeId: episode.id })).data.length, 1);
    expectFailure(
      await readEpisodeContent(null, "missing-episode"),
      "EPISODE_NOT_FOUND",
      "에피소드를 찾을 수 없습니다.",
    );

    const updateEpisode = ipcMain.handlers.get(IPC_CHANNELS.EPISODE_UPDATE);
    assert.equal(
      (
        await updateEpisode(null, episode.id, {
          workId: work.id,
          episodeNumber: 1,
          title: episode.title,
          status: "COMPLETED",
          content: expectedContent,
        })
      ).data.status,
      "COMPLETED",
    );

    expectFailure(
      await createEpisode(null, {
        workId: work.id,
        episodeNumber: 1,
        title: "중복 IPC 회차",
        content: "",
      }),
      "EPISODE_NUMBER_DUPLICATE",
      "이미 같은 회차 번호의 에피소드가 존재합니다.",
    );
    expectFailure(
      await createEpisode(null, {
        workId: "missing-work",
        episodeNumber: 2,
        title: "없는 작품 회차",
        content: "",
      }),
      "WORK_NOT_FOUND",
      "작품을 찾을 수 없습니다.",
    );

    const missingContentEpisodeResult = await createEpisode(null, {
      workId: work.id,
      episodeNumber: 2,
      title: "원고 없는 회차",
      content: "",
    });
    fs.unlinkSync(path.join(temporaryRoot, "works", work.id, "episodes", "002.txt"));
    expectFailure(
      await readEpisodeContent(null, missingContentEpisodeResult.data.id),
      "EPISODE_CONTENT_NOT_FOUND",
      "에피소드 원고 파일을 찾을 수 없습니다.",
    );

    const unexpectedResult = await executeIpcAction("validation:unexpected", () => {
      throw new Error("internal cause must not cross IPC");
    });
    expectFailure(
      unexpectedResult,
      "INTERNAL_ERROR",
      "요청을 처리하는 중 오류가 발생했습니다.",
    );
    assert.equal("cause" in unexpectedResult.error, false);
    assert.equal("stack" in unexpectedResult.error, false);
    assert.equal(
      fs.existsSync(path.join(temporaryRoot, "logs", "novelcompany.log")),
      true,
    );

    const invokedChannels = [];
    const api = createNovelCompanyApi({
      invoke(channel, ...args) {
        invokedChannels.push({ channel, args });
        return Promise.resolve({ ok: true, data: null });
      },
    });
    await api.works.getAll();
    await api.works.getById("work-id");
    await api.works.create({ title: "작품" });
    await api.works.update("work-id", { title: "수정" });
    await api.episodes.getById("episode-id");
    await api.episodes.getByWorkId("work-id");
    await api.episodes.create({ title: "회차" });
    await api.episodes.update("episode-id", { title: "수정" });
    await api.episodes.readContent("episode-id");
    await api.canon.spaces.getByWorkId("work-id");
    await api.canon.sets.getByCanonSpaceId("canon-space-id");
    await api.canon.sets.getDefinition("canon-set-id");
    await api.context.getEpisodeWorkContext({ workId: "work-id", episodeId: "episode-id" });
    await api.reviews.start({ workId: "work-id", episodeId: "episode-id" });
    await api.reviews.getByEpisode({ workId: "work-id", episodeId: "episode-id" });
    await api.reviews.getById("review-id");
    assert.deepEqual(
      invokedChannels.map((invocation) => invocation.channel),
      [
        IPC_CHANNELS.WORK_GET_ALL,
        IPC_CHANNELS.WORK_GET_BY_ID,
        IPC_CHANNELS.WORK_CREATE,
        IPC_CHANNELS.WORK_UPDATE,
        IPC_CHANNELS.EPISODE_GET_BY_ID,
        IPC_CHANNELS.EPISODE_GET_BY_WORK_ID,
        IPC_CHANNELS.EPISODE_CREATE,
        IPC_CHANNELS.EPISODE_UPDATE,
        IPC_CHANNELS.EPISODE_READ_CONTENT,
        IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID,
        IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID,
        IPC_CHANNELS.CANON_SET_GET_DEFINITION,
        IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT,
        IPC_CHANNELS.REVIEW_SUBMIT,
        IPC_CHANNELS.REVIEW_GET_BY_EPISODE,
        IPC_CHANNELS.REVIEW_GET_BY_ID,
      ],
    );
    assert.equal("ipcRenderer" in api, false);

    const runtimePreloadApi = loadRuntimePreloadApiForValidation();
    assert.deepEqual(Object.keys(runtimePreloadApi.works), [
      "getAll",
      "getById",
      "create",
      "update",
      "getDeletionStatus",
      "delete",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.episodes), [
      "getById",
      "getByWorkId",
      "create",
      "update",
      "readContent",
      "delete",
      "getNextAvailableNumber",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.canon.spaces), [
      "getByWorkId",
      "createForWork",
      "getDeletionStatus",
      "deleteForWork",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.canon.sets), [
      "getByCanonSpaceId",
      "getDefinition",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.context), [
      "getEpisodeWorkContext",
      "getEpisodeReviewContext",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.reviews), ["start", "submit", "getQueue", "getJobByEpisode", "cancelQueued", "getByEpisode", "getById"]);
    assert.equal("ipcRenderer" in runtimePreloadApi, false);
    assert.equal("require" in runtimePreloadApi, false);

    const runtimeInvocations = await Promise.all([
      runtimePreloadApi.works.getAll(),
      runtimePreloadApi.works.getById("work-id"),
      runtimePreloadApi.works.create({ title: "작품" }),
      runtimePreloadApi.works.update("work-id", { title: "수정" }),
      runtimePreloadApi.episodes.getById("episode-id"),
      runtimePreloadApi.episodes.getByWorkId("work-id"),
      runtimePreloadApi.episodes.create({ title: "회차" }),
      runtimePreloadApi.episodes.update("episode-id", { title: "수정" }),
      runtimePreloadApi.episodes.readContent("episode-id"),
      runtimePreloadApi.canon.spaces.getByWorkId("work-id"),
      runtimePreloadApi.canon.sets.getByCanonSpaceId("canon-space-id"),
      runtimePreloadApi.canon.sets.getDefinition("canon-set-id"),
      runtimePreloadApi.context.getEpisodeWorkContext({ workId: "work-id", episodeId: "episode-id" }),
      runtimePreloadApi.reviews.start({ workId: "work-id", episodeId: "episode-id" }),
      runtimePreloadApi.reviews.getByEpisode({ workId: "work-id", episodeId: "episode-id" }),
      runtimePreloadApi.reviews.getById("review-id"),
    ]);
    assert.deepEqual(
      runtimeInvocations.map((result) => result.data.channel),
      [
        IPC_CHANNELS.WORK_GET_ALL,
        IPC_CHANNELS.WORK_GET_BY_ID,
        IPC_CHANNELS.WORK_CREATE,
        IPC_CHANNELS.WORK_UPDATE,
        IPC_CHANNELS.EPISODE_GET_BY_ID,
        IPC_CHANNELS.EPISODE_GET_BY_WORK_ID,
        IPC_CHANNELS.EPISODE_CREATE,
        IPC_CHANNELS.EPISODE_UPDATE,
        IPC_CHANNELS.EPISODE_READ_CONTENT,
        IPC_CHANNELS.CANON_SPACE_GET_BY_WORK_ID,
        IPC_CHANNELS.CANON_SETS_GET_BY_CANON_SPACE_ID,
        IPC_CHANNELS.CANON_SET_GET_DEFINITION,
        IPC_CHANNELS.CONTEXT_GET_EPISODE_WORK_CONTEXT,
        IPC_CHANNELS.REVIEW_SUBMIT,
        IPC_CHANNELS.REVIEW_GET_BY_EPISODE,
        IPC_CHANNELS.REVIEW_GET_BY_ID,
      ],
    );

    await validateCanonRecordIpc(ipcMain, runtimePreloadApi);
    await validateWorkManagementIpc(ipcMain, runtimePreloadApi);
    await require("../database/canon-space-validation.cjs").validateCanonSpaceIpc(ipcMain, runtimePreloadApi);
    await require("../database/canon-deletion-validation.cjs").validateCanonDeletionIpc(ipcMain, runtimePreloadApi);
    await require("../database/episode-editing-validation.cjs").validateEpisodeEditingIpc(ipcMain, runtimePreloadApi, episodeStorage);
    await require("../database/canon-authoring-validation.cjs").validateCanonAuthoringIpc(ipcMain);
    console.log("IPC validation passed.");
  } finally {
    closeDatabase();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    delete process.env.NOVEL_COMPANY_DATA_DIR;
  }
}

/** 일곱 Record API의 handler 결과, bridge 인자, 한국어 오류와 타입 선언을 검증한다. */
async function validateCanonRecordIpc(ipcMain, runtimeApi) {
  const { createCanonFixture, inputFor } = require("../database/canon-record-validation.cjs");
  const scope = createCanonFixture();
  const api = createNovelCompanyApi({
    /** 테스트 bridge를 실제 등록 handler에 연결한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  const worldInput = inputFor(scope.world, "IPC 검증 세계");
  const created = await api.canon.records.create(scope.world, worldInput);
  assert.equal(created.ok, true);
  const id = created.data.id;
  assert.equal((await api.canon.records.getBySetId(scope.world)).data.length, 1);
  assert.equal((await api.canon.records.getById(scope.world, id)).data.id, id);
  assert.equal((await api.canon.records.getCreateReadiness(scope.location)).data.canCreate, true);
  const fieldId = getDatabase().prepare("SELECT id FROM canon_fields WHERE canon_set_id = ? AND key = 'world'").get(scope.location.setId).id;
  assert.equal((await api.canon.records.getReferenceOptions(scope.location, fieldId)).data[0].id, id);
  assert.equal((await api.canon.records.update(scope.world, id, { ...worldInput, displayName: "수정" })).data.displayName, "수정");
  const cases = [
    ["getBySetId", IPC_CHANNELS.CANON_RECORD_GET_BY_SET_ID, [scope.world]],
    ["getById", IPC_CHANNELS.CANON_RECORD_GET_BY_ID, [scope.world, id]],
    ["getCreateReadiness", IPC_CHANNELS.CANON_RECORD_GET_CREATE_READINESS, [scope.world]],
    ["getReferenceOptions", IPC_CHANNELS.CANON_RECORD_GET_REFERENCE_OPTIONS, [scope.location, fieldId, null]],
    ["create", IPC_CHANNELS.CANON_RECORD_CREATE, [scope.world, worldInput]],
    ["update", IPC_CHANNELS.CANON_RECORD_UPDATE, [scope.world, id, worldInput]],
    ["delete", IPC_CHANNELS.CANON_RECORD_DELETE, [scope.world, id]],
  ];
  const types = fs.readFileSync(path.join(__dirname, "../../src/types/electron-api.d.ts"), "utf8");
  for (const [method, channel, args] of cases) {
    const runtimeResult = await runtimeApi.canon.records[method](...args);
    assert.equal(runtimeResult.data.channel, channel);
    assert.equal(JSON.stringify(runtimeResult.data.args), JSON.stringify(args));
    const fakeApi = createNovelCompanyApi({
      /** 보조 bridge의 channel과 전체 scope 인자가 보존되는지 확인한다. */
      invoke(actualChannel, ...actualArgs) { assert.equal(actualChannel, channel); assert.deepEqual(actualArgs, args); return Promise.resolve(); },
    });
    await fakeApi.canon.records[method](...args);
    const invalid = await api.canon.records[method](null, ...args.slice(1));
    assert.equal(invalid.ok, false);
    assert.match(invalid.error.message, /[가-힣]/);
    assert.deepEqual(Object.keys(invalid.error), ["code", "message"]);
    assert.ok(types.includes(method + "(scope: CanonScope"), method);
  }
  assert.equal((await api.canon.records.delete(scope.world, id)).data.id, id);
  expectFailure(await api.canon.records.getById(scope.world, id), "CANON_RECORD_NOT_FOUND", "해당 설정 항목을 찾을 수 없습니다.");
  expectFailure(await api.canon.records.create(scope.world, { displayName: "", fieldValues: {} }), "CANON_REQUIRED_FIELD_MISSING", "이름을 입력해 주세요.");
}

/** Work 6개 API의 handler, 두 preload 계약, 한국어 실패 및 내부 오류 은닉을 검사한다. */
async function validateWorkManagementIpc(ipcMain, runtimeApi) {
  const api = createNovelCompanyApi({
    /** 검증용 API를 실제 등록 handler로 연결한다. */
    invoke(channel, ...args) { return ipcMain.handlers.get(channel)(null, ...args); },
  });
  const input = { title: "테스트 IPC 작품", description: "설명", status: "ACTIVE" };
  const created = await api.works.create(input);
  assert.equal(created.ok, true);
  const id = created.data.id;
  assert.ok((await api.works.getAll()).data.some((work) => work.id === id));
  assert.deepEqual((await api.works.getById(id)).data, created.data);
  assert.equal((await api.works.update(id, { title: "수정", status: "PAUSED" })).data.status, "PAUSED");
  assert.deepEqual(await api.works.getDeletionStatus(id), { ok: true, data: { canDelete: true, episodeCount: 0, hasCanonSpace: false } });
  assert.deepEqual(await api.works.delete(id), { ok: true, data: { id } });
  assert.deepEqual(await api.works.getById(id), { ok: true, data: null });
  for (const result of [await api.works.getDeletionStatus(id), await api.works.delete(id), await api.works.update(id, input)]) expectFailure(result, "WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
  expectFailure(await api.works.create({ title: " " }), "WORK_TITLE_REQUIRED", "작품 제목을 입력해 주세요.");
  expectFailure(await api.works.create({ ...input, status: "INVALID" }), "WORK_STATUS_INVALID", "작품 상태가 올바르지 않습니다.");
  const types = fs.readFileSync(path.join(__dirname, "../../src/types/electron-api.d.ts"), "utf8");
  for (const [method, channel, args] of [
    ["getAll", IPC_CHANNELS.WORK_GET_ALL, []],
    ["getById", IPC_CHANNELS.WORK_GET_BY_ID, [id]],
    ["create", IPC_CHANNELS.WORK_CREATE, [input]],
    ["update", IPC_CHANNELS.WORK_UPDATE, [id, input]],
    ["getDeletionStatus", IPC_CHANNELS.WORK_GET_DELETION_STATUS, [id]],
    ["delete", IPC_CHANNELS.WORK_DELETE, [id]],
  ]) {
    const result = await runtimeApi.works[method](...args);
    assert.equal(result.data.channel, channel);
    assert.equal(JSON.stringify(result.data.args), JSON.stringify(args));
    const bridge = createNovelCompanyApi({
      /** 보조 preload도 동일한 channel과 인자를 전달하는지 검사한다. */
      invoke(actualChannel, ...actualArgs) { assert.equal(actualChannel, channel); assert.deepEqual(actualArgs, args); return Promise.resolve(); },
    });
    await bridge.works[method](...args);
    assert.ok(types.includes(method + "("));
  }
  const { addEmptyCanonSpace } = require("../database/work-management-validation.cjs");
  for (const [episode, canon, code, message] of [
    [true, false, "WORK_DELETE_BLOCKED_BY_EPISODES", "이 작품에는 연결된 회차가 있어 삭제할 수 없습니다."],
    [false, true, "WORK_DELETE_BLOCKED_BY_CANON", "이 작품에는 Canon 데이터가 있어 삭제할 수 없습니다."],
    [true, true, "WORK_DELETE_BLOCKED_BY_DEPENDENCIES", "이 작품에는 연결된 회차와 Canon 데이터가 있어 삭제할 수 없습니다."],
  ]) {
    const work = (await api.works.create(input)).data;
    if (episode) await api.episodes.create({ workId: work.id, episodeNumber: 1, title: "테스트 회차", content: "" });
    if (canon) addEmptyCanonSpace(work.id);
    assert.equal((await api.works.getDeletionStatus(work.id)).data.canDelete, false);
    expectFailure(await api.works.delete(work.id), code, message);
    assert.equal((await api.works.getById(work.id)).data.id, work.id);
  }
  const failureWork = (await api.works.create(input)).data;
  getDatabase().exec("CREATE TEMP TRIGGER task018_ipc_delete_failure AFTER DELETE ON works BEGIN SELECT RAISE(FAIL, 'raw SQL must stay in Main'); END");
  try {
    const result = await api.works.delete(failureWork.id);
    expectFailure(result, "WORK_DELETE_FAILED", "작품을 삭제하지 못했습니다.");
    assert.deepEqual(Object.keys(result.error), ["code", "message"]);
    assert.equal((await api.works.getById(failureWork.id)).data.id, failureWork.id);
  } finally { getDatabase().exec("DROP TRIGGER task018_ipc_delete_failure"); }
}

runValidation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
