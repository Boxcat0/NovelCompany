const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeDatabase, getDatabase, initializeDatabase } = require("../database/database.cjs");
const { createWork } = require("../database/repositories/work-repository.cjs");
const { createEpisodeWithContent } = require("../episode-service.cjs");
const { LocalEpisodeStorage } = require("../storage/local-episode-storage.cjs");
const records = require("../database/repositories/canon-record-repository.cjs");
const definitions = require("../database/repositories/canon-definition-repository.cjs");
const { createCanonFixture, inputFor } = require("../database/canon-record-validation.cjs");
const {
  buildEpisodeWorkContext,
  resolveOption,
  resolveReference,
} = require("./episode-work-context-builder.cjs");

/**
 * 지정한 async Context build가 사용자용 Repository error code로 실패하는지 확인한다.
 */
async function expectContextFailure(action, code) {
  await assert.rejects(action, (error) => error.code === code && /[가-힣]/.test(error.message));
}

/**
 * Definition Option의 stable value에 해당하는 내부 Option ID를 조회한다.
 */
function findOptionId(scope, fieldKey, optionValue) {
  const field = definitions
    .getCanonDefinitionBySetId(scope.setId)
    .fields.find((item) => item.key === fieldKey);
  return field.options.find((option) => option.value === optionValue).id;
}

/**
 * scalar와 OPTION_MANY hydration 검증용 optional Field definition을 추가한다.
 */
function addScalarFixtureFields(scope) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const ids = {
    text: randomUUID(),
    number: randomUUID(),
    boolean: randomUUID(),
    options: randomUUID(),
    option: randomUUID(),
  };
  const fields = [
    [ids.text, "context_text", "텍스트", "TEXT", "TEXT_INPUT"],
    [ids.number, "context_number", "숫자", "NUMBER", "NUMBER_INPUT"],
    [ids.boolean, "context_boolean", "참/거짓", "BOOLEAN", "CHECKBOX"],
    [ids.options, "context_options", "복수 선택", "OPTION_MANY", "MULTI_SELECT"],
  ];
  for (const [id, key, label, valueType, inputControl] of fields) {
    database
      .prepare(
        "INSERT INTO canon_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        scope.canonSpaceId,
        scope.setId,
        key,
        label,
        valueType,
        inputControl,
        null,
        0,
        null,
        100,
        now,
        now,
      );
  }
  database
    .prepare(
      "INSERT INTO canon_field_options VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ids.option,
      scope.canonSpaceId,
      scope.setId,
      ids.options,
      "CONTEXT_OPTION",
      "컨텍스트 선택",
      1,
    );
  return ids;
}

/**
 * Context read-only 전후에 DB row 수와 TXT bytes가 바뀌지 않았는지 비교할 snapshot을 만든다.
 */
function createReadOnlySnapshot(filePath) {
  const database = getDatabase();
  return {
    tableCounts: [
      "works",
      "episodes",
      "canon_spaces",
      "canon_sets",
      "canon_fields",
      "canon_field_options",
      "canon_records",
      "canon_field_values",
      "canon_record_option_values",
      "canon_record_references",
    ].map((table) =>
      database.prepare("SELECT COUNT(*) AS count FROM " + table).get().count,
    ),
    content: fs.readFileSync(filePath),
  };
}

/**
 * Episode TXT, Generic Canon, option/reference resolution과 read-only 보장을 임시 DB에서 검증한다.
 */
async function runValidation() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "novel-company-context-"),
  );
  process.env.NOVEL_COMPANY_DATA_DIR = temporaryRoot;

  try {
    initializeDatabase(path.join(temporaryRoot, "novelcompany.db"));
    const storage = new LocalEpisodeStorage(temporaryRoot);
    await storage.ensureBaseStorage();
    const scope = createCanonFixture();
    const workId = getDatabase()
      .prepare("SELECT work_id FROM canon_spaces WHERE id = ?")
      .get(scope.world.canonSpaceId).work_id;
    const saved = createEpisodeWithContent(storage, {
      workId,
      episodeNumber: 1,
      title: "Context 검증 회차",
      status: "DRAFT",
      content: "저장된 원고\n둘째 줄",
    });
    const empty = createEpisodeWithContent(storage, {
      workId,
      episodeNumber: 2,
      title: "빈 원고",
      status: "DRAFT",
      content: "",
    });

    const emptyContext = await buildEpisodeWorkContext(storage, {
      workId,
      episodeId: empty.id,
    });
    assert.equal(emptyContext.episode.content, "");
    assert.equal(emptyContext.canon.summary.setCount, 11);
    assert.equal(emptyContext.canon.summary.recordCount, 0);
    assert.ok(emptyContext.canon.sets.every((set) => set.records.length === 0));

    const extra = addScalarFixtureFields(scope.skill);
    const world = records.create(
      scope.world,
      inputFor(scope.world, "검증 세계", { description: "세계 설명\n둘째 줄" }),
    );
    const location = records.create(
      scope.location,
      inputFor(scope.location, "검증 지역", { world: world.id }),
    );
    const attribute = records.create(
      scope.attribute,
      inputFor(scope.attribute, "검증 속성"),
    );
    const skill = records.create(
      scope.skill,
      inputFor(scope.skill, "검증 스킬", {
        context_text: "문자열",
        context_number: 7,
        context_boolean: false,
        context_options: [extra.option],
      }),
    );
    const passive = records.create(
      scope.passive,
      inputFor(scope.passive, "검증 패시브", {
        passive_type: findOptionId(scope.passive, "passive_type", "UNIQUE"),
      }),
    );
    records.create(
      scope.character,
      inputFor(scope.character, "이카로스", {
        origin_world: world.id,
        origin_location: location.id,
        current_location: location.id,
        attributes: [attribute.id],
        skills: [skill.id],
        passives: [passive.id],
      }),
    );

    const manuscriptPath = path.join(
      temporaryRoot,
      "works",
      workId,
      "episodes",
      "001.txt",
    );
    const before = createReadOnlySnapshot(manuscriptPath);
    const context = await buildEpisodeWorkContext(storage, {
      workId,
      episodeId: saved.id,
    });
    const secondContext = await buildEpisodeWorkContext(storage, {
      workId,
      episodeId: saved.id,
    });
    assert.deepEqual(context, secondContext);
    assert.equal(context.scope, "FULL_CANON");
    assert.equal(context.episode.content, "저장된 원고\n둘째 줄");
    assert.equal(context.canon.summary.recordCount, 6);
    assert.equal(context.work.id, workId);
    assert.equal(JSON.stringify(context).includes("storageKey"), false);
    assert.equal(JSON.stringify(context).includes(temporaryRoot), false);
    assert.doesNotThrow(() => JSON.stringify(context));
    const locationRecord = context.canon.sets
      .find((set) => set.key === "location")
      .records[0];
    assert.deepEqual(
      locationRecord.fields.find((field) => field.key === "world").value,
      { recordId: world.id, setKey: "world", displayName: "검증 세계" },
    );
    const characterRecord = context.canon.sets
      .find((set) => set.key === "character")
      .records[0];
    assert.deepEqual(
      characterRecord.fields.find((field) => field.key === "attributes").value,
      [{ recordId: attribute.id, setKey: "attribute", displayName: "검증 속성" }],
    );
    assert.deepEqual(
      context.canon.sets
        .find((set) => set.key === "passive")
        .records[0]
        .fields.find((field) => field.key === "passive_type").value,
      { key: "UNIQUE", label: "고유" },
    );
    assert.equal(
      context.canon.sets
        .find((set) => set.key === "skill")
        .records[0]
        .fields.find((field) => field.key === "context_number").value,
      7,
    );
    assert.equal(
      context.canon.sets
        .find((set) => set.key === "skill")
        .records[0]
        .fields.find((field) => field.key === "context_boolean").value,
      false,
    );
    assert.deepEqual(createReadOnlySnapshot(manuscriptPath), before);

    fs.writeFileSync(manuscriptPath, "외부 변경", "utf8");
    await expectContextFailure(
      () => buildEpisodeWorkContext(storage, { workId, episodeId: saved.id }),
      "EPISODE_CONTENT_HASH_MISMATCH",
    );

    const missing = createEpisodeWithContent(storage, {
      workId,
      episodeNumber: 3,
      title: "누락 원고",
      status: "DRAFT",
      content: "",
    });
    fs.unlinkSync(
      path.join(temporaryRoot, "works", workId, "episodes", "003.txt"),
    );
    await expectContextFailure(
      () => buildEpisodeWorkContext(storage, { workId, episodeId: missing.id }),
      "EPISODE_CONTENT_NOT_FOUND",
    );
    await expectContextFailure(
      () =>
        buildEpisodeWorkContext(
          {
            resolveManagedPath() {},
            async readEpisodeByStorageKey() {
              const error = new Error("forced read failure");
              error.code = "EACCES";
              throw error;
            },
          },
          { workId, episodeId: empty.id },
        ),
      "EPISODE_CONTENT_READ_FAILED",
    );

    const noCanonWork = createWork({ title: "Canon 없는 작품" });
    const noCanonEpisode = createEpisodeWithContent(storage, {
      workId: noCanonWork.id,
      episodeNumber: 1,
      title: "Canon 없음",
      status: "DRAFT",
      content: "",
    });
    await expectContextFailure(
      () =>
        buildEpisodeWorkContext(storage, {
          workId: noCanonWork.id,
          episodeId: noCanonEpisode.id,
        }),
      "CANON_SPACE_NOT_FOUND",
    );

    const emptyCanonWork = createWork({ title: "빈 Canon 작품" });
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        "INSERT INTO canon_spaces VALUES (?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), emptyCanonWork.id, "MODERN_FANTASY_V1", now, now);
    const emptyCanonEpisode = createEpisodeWithContent(storage, {
      workId: emptyCanonWork.id,
      episodeNumber: 1,
      title: "빈 정의",
      status: "DRAFT",
      content: "",
    });
    const emptyDefinitionContext = await buildEpisodeWorkContext(storage, {
      workId: emptyCanonWork.id,
      episodeId: emptyCanonEpisode.id,
    });
    assert.deepEqual(emptyDefinitionContext.canon, {
      summary: { setCount: 0, recordCount: 0 },
      sets: [],
    });

    const otherScope = createCanonFixture();
    const otherWorkId = getDatabase()
      .prepare("SELECT work_id FROM canon_spaces WHERE id = ?")
      .get(otherScope.world.canonSpaceId).work_id;
    await expectContextFailure(
      () => buildEpisodeWorkContext(storage, { workId: otherWorkId, episodeId: empty.id }),
      "EPISODE_NOT_FOUND",
    );
    assert.throws(
      () => resolveOption({ options: [] }, "unknown"),
      (error) => error.code === "CONTEXT_CANON_OPTION_INVALID",
    );
    assert.throws(
      () =>
        resolveReference(
          { referenceSet: { key: "world" } },
          new Map(),
          "missing-record",
        ),
      (error) => error.code === "CONTEXT_CANON_REFERENCE_INVALID",
    );
    console.log("Task023 WorkContext validation passed.");
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
