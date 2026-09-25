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
    registerWorkHandlers(ipcMain);
    registerCanonHandlers(ipcMain);
    registerEpisodeHandlers(ipcMain, episodeStorage);

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
      storageKey: "ipc/episodes/001.txt",
    });
    assert.equal(firstEpisodeResult.ok, true);
    const episode = firstEpisodeResult.data;
    const expectedContent = "첫 문장입니다.\n\n두 번째 문장입니다.";
    await episodeStorage.saveEpisode("ipc", 1, expectedContent);

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
    expectFailure(
      await readEpisodeContent(null, "missing-episode"),
      "EPISODE_NOT_FOUND",
      "에피소드를 찾을 수 없습니다.",
    );

    const updateEpisode = ipcMain.handlers.get(IPC_CHANNELS.EPISODE_UPDATE);
    assert.equal(
      (
        await updateEpisode(null, episode.id, {
          status: "COMPLETED",
          contentHash: "ipc-hash",
        })
      ).data.status,
      "COMPLETED",
    );

    expectFailure(
      await createEpisode(null, {
        workId: work.id,
        episodeNumber: 1,
        title: "중복 IPC 회차",
        storageKey: "ipc/episodes/002.txt",
      }),
      "EPISODE_NUMBER_DUPLICATE",
      "이미 같은 회차 번호의 에피소드가 존재합니다.",
    );
    expectFailure(
      await createEpisode(null, {
        workId: "missing-work",
        episodeNumber: 2,
        title: "없는 작품 회차",
        storageKey: "ipc/episodes/003.txt",
      }),
      "WORK_NOT_FOUND",
      "작품을 찾을 수 없습니다.",
    );

    const missingContentEpisodeResult = await createEpisode(null, {
      workId: work.id,
      episodeNumber: 2,
      title: "원고 없는 회차",
      storageKey: "ipc/episodes/002.txt",
    });
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
      ],
    );
    assert.equal("ipcRenderer" in api, false);

    const runtimePreloadApi = loadRuntimePreloadApiForValidation();
    assert.deepEqual(Object.keys(runtimePreloadApi.works), [
      "getAll",
      "getById",
      "create",
      "update",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.episodes), [
      "getById",
      "getByWorkId",
      "create",
      "update",
      "readContent",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.canon.spaces), [
      "getByWorkId",
    ]);
    assert.deepEqual(Object.keys(runtimePreloadApi.canon.sets), [
      "getByCanonSpaceId",
      "getDefinition",
    ]);
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
      ],
    );

    console.log("IPC validation passed.");
  } finally {
    closeDatabase();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    delete process.env.NOVEL_COMPANY_DATA_DIR;
  }
}

runValidation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
