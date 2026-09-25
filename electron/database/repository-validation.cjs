const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeDatabase, initializeDatabase } = require("./database.cjs");
const {
  createWork,
  getAllWorks,
  getWorkById,
  updateWork,
} = require("./repositories/work-repository.cjs");
const {
  createEpisode,
  getEpisodeById,
  getEpisodesByWorkId,
  updateEpisode,
} = require("./repositories/episode-repository.cjs");

/**
 * 지정한 한국어 오류 메시지로 실패하는지 검증한다.
 */
function expectRepositoryError(action, message) {
  assert.throws(action, (error) => error.message === message);
}

/**
 * Work와 Episode Repository를 production DB와 분리된 임시 DB에서 검증한다.
 */
function runValidation() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novel-company-repository-"),
  );

  try {
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));

    const firstWork = createWork({
      title: "첫 번째 작품",
      description: "설명",
      status: "ACTIVE",
    });
    assert.match(firstWork.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(firstWork.description, "설명");
    assert.equal(getWorkById(firstWork.id).id, firstWork.id);

    const secondWork = createWork({ title: "두 번째 작품" });
    assert.deepEqual(
      getAllWorks().map((work) => work.id),
      [firstWork.id, secondWork.id],
    );

    const timestampBeforeWorkUpdate = firstWork.updatedAt;
    while (Date.now() === Date.parse(timestampBeforeWorkUpdate)) {
      // updated_at이 새 UTC 시각으로 바뀌도록 다음 밀리초까지 대기한다.
    }
    const updatedWork = updateWork(firstWork.id, {
      title: "수정된 작품",
      status: "PAUSED",
    });
    assert.equal(updatedWork.title, "수정된 작품");
    assert.equal(updatedWork.status, "PAUSED");
    assert.notEqual(updatedWork.updatedAt, timestampBeforeWorkUpdate);
    assert.equal(updateWork("missing-work", { title: "없음" }), null);
    expectRepositoryError(
      () => createWork({ title: "   " }),
      "작품 제목을 입력해 주세요.",
    );
    expectRepositoryError(
      () => createWork({ title: "잘못된 상태", status: "INVALID" }),
      "작품 상태가 올바르지 않습니다.",
    );

    const secondEpisode = createEpisode({
      workId: firstWork.id,
      episodeNumber: 2,
      title: "두 번째 회차",
      status: "IN_PROGRESS",
      storageKey: "work/episodes/002.txt",
    });
    const firstEpisode = createEpisode({
      workId: firstWork.id,
      episodeNumber: 1,
      title: "첫 번째 회차",
      storageKey: "work/episodes/001.txt",
    });
    assert.match(firstEpisode.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(getEpisodeById(firstEpisode.id).contentHash, null);
    assert.deepEqual(
      getEpisodesByWorkId(firstWork.id).map((episode) => episode.id),
      [firstEpisode.id, secondEpisode.id],
    );

    const timestampBeforeEpisodeUpdate = firstEpisode.updatedAt;
    while (Date.now() === Date.parse(timestampBeforeEpisodeUpdate)) {
      // updated_at이 새 UTC 시각으로 바뀌도록 다음 밀리초까지 대기한다.
    }
    const updatedEpisode = updateEpisode(firstEpisode.id, {
      title: "수정된 첫 번째 회차",
      status: "COMPLETED",
      storageKey: "work/episodes/001-revised.txt",
      contentHash: "hash-001",
    });
    assert.equal(updatedEpisode.title, "수정된 첫 번째 회차");
    assert.equal(updatedEpisode.status, "COMPLETED");
    assert.equal(updatedEpisode.storageKey, "work/episodes/001-revised.txt");
    assert.equal(updatedEpisode.contentHash, "hash-001");
    assert.notEqual(updatedEpisode.updatedAt, timestampBeforeEpisodeUpdate);
    assert.equal(updateEpisode("missing-episode", { title: "없음" }), null);

    expectRepositoryError(
      () =>
        createEpisode({
          workId: firstWork.id,
          episodeNumber: 1,
          title: "중복 회차",
          storageKey: "work/episodes/003.txt",
        }),
      "이미 같은 회차 번호의 에피소드가 존재합니다.",
    );
    expectRepositoryError(
      () =>
        createEpisode({
          workId: firstWork.id,
          episodeNumber: 3,
          title: "중복 경로",
          storageKey: "work/episodes/002.txt",
        }),
      "이미 같은 원고 저장 경로를 사용하는 에피소드가 존재합니다.",
    );
    expectRepositoryError(
      () =>
        createEpisode({
          workId: "missing-work",
          episodeNumber: 1,
          title: "없는 작품 회차",
          storageKey: "missing/episodes/001.txt",
        }),
      "작품을 찾을 수 없습니다.",
    );
    expectRepositoryError(
      () =>
        createEpisode({
          workId: firstWork.id,
          episodeNumber: 0,
          title: "잘못된 회차",
          storageKey: "work/episodes/000.txt",
        }),
      "회차 번호는 1 이상의 정수여야 합니다.",
    );
    expectRepositoryError(
      () =>
        createEpisode({
          workId: firstWork.id,
          episodeNumber: 3,
          title: " ",
          storageKey: "work/episodes/003.txt",
        }),
      "에피소드 제목을 입력해 주세요.",
    );
    expectRepositoryError(
      () =>
        createEpisode({
          workId: firstWork.id,
          episodeNumber: 3,
          title: "경로 누락",
          storageKey: " ",
        }),
      "원고 저장 경로를 입력해 주세요.",
    );

    console.log("Repository validation passed.");
  } finally {
    closeDatabase();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

runValidation();

