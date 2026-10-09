const { createHash } = require("node:crypto");
const { getWorkById } = require("../database/repositories/work-repository.cjs");
const {
  getEpisodeById,
} = require("../database/repositories/episode-repository.cjs");
const {
  getCanonSpaceByWorkId,
  getCanonSetsByCanonSpaceId,
  getCanonDefinitionBySetId,
} = require("../database/repositories/canon-definition-repository.cjs");
const {
  getById: getCanonRecordById,
  getBySetId: getCanonRecordsBySetId,
} = require("../database/repositories/canon-record-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");

/**
 * Context 요청에 필요한 문자열 ID를 확인하고 공개 오류로 변환한다.
 */
function requireContextId(value, code, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RepositoryError(code, message);
  }

  return value;
}

/**
 * 저장된 Episode TXT를 읽고, 누락 및 일반 읽기 실패를 구분해 전달한다.
 */
async function readSavedEpisodeContent(episodeStorage, episode) {
  try {
    episodeStorage.resolveManagedPath(episode.workId, episode.storageKey);
    return await episodeStorage.readEpisodeByStorageKey(episode.storageKey);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw new RepositoryError(
        "EPISODE_CONTENT_NOT_FOUND",
        "저장된 원고 파일을 찾을 수 없습니다. 회차 화면에서 원고를 확인해 주세요.",
        cause,
      );
    }

    throw new RepositoryError(
      "EPISODE_CONTENT_READ_FAILED",
      "원고를 읽는 중 오류가 발생했습니다.",
      cause,
    );
  }
}

/**
 * 저장된 TXT가 가진 hash와 Episode metadata의 hash가 일치하는지 확인한다.
 */
function verifyEpisodeContentHash(episode, content) {
  if (episode.contentHash === null) {
    return;
  }

  const actualHash = createHash("sha256").update(content, "utf8").digest("hex");
  if (actualHash !== episode.contentHash) {
    throw new RepositoryError(
      "EPISODE_CONTENT_HASH_MISMATCH",
      "원고 파일이 마지막 저장 상태와 다릅니다. 회차 화면에서 원고를 확인한 뒤 다시 저장해 주세요.",
    );
  }
}

/**
 * 요청 중 읽은 Canon record로 reference 대상의 공개 identity index를 만든다.
 */
function buildRecordIndex(setContexts) {
  const index = new Map();
  for (const setContext of setContexts) {
    for (const record of setContext.records) {
      index.set(record.id, {
        recordId: record.id,
        setKey: setContext.definition.key,
        displayName: record.displayName,
      });
    }
  }
  return index;
}

/**
 * Option ID를 사람이 읽을 수 있는 안정적인 key와 label로 해석한다.
 */
function resolveOption(field, optionId) {
  const option = field.options.find((item) => item.id === optionId);
  if (!option) {
    throw new RepositoryError(
      "CONTEXT_CANON_OPTION_INVALID",
      "Canon 선택 정보를 해석할 수 없습니다.",
    );
  }
  return { key: option.value, label: option.label };
}

/**
 * Reference ID를 같은 CanonSpace의 대상 Set과 displayName을 갖는 공개 값으로 해석한다.
 */
function resolveReference(field, recordIndex, recordId) {
  const target = recordIndex.get(recordId);
  if (!target || !field.referenceSet || target.setKey !== field.referenceSet.key) {
    throw new RepositoryError(
      "CONTEXT_CANON_REFERENCE_INVALID",
      "Canon 참조 정보를 해석할 수 없습니다.",
    );
  }
  return target;
}

/**
 * Canon field의 raw scalar, option, reference 값을 public read-only value로 변환한다.
 */
function resolveCanonFieldValue(field, fieldValues, recordIndex) {
  const rawValue = fieldValues[field.id];
  if (field.valueType === "OPTION_ONE") {
    return rawValue === null ? null : resolveOption(field, rawValue);
  }
  if (field.valueType === "OPTION_MANY") {
    return rawValue.map((optionId) => resolveOption(field, optionId));
  }
  if (field.valueType === "REFERENCE_ONE") {
    return rawValue === null
      ? null
      : resolveReference(field, recordIndex, rawValue);
  }
  if (field.valueType === "REFERENCE_MANY") {
    return rawValue.map((recordId) =>
      resolveReference(field, recordIndex, recordId),
    );
  }
  return rawValue;
}

/**
 * Generic Canon record 하나를 Field display 순서가 보존된 public DTO로 변환한다.
 */
function hydrateCanonRecord(record, definition, recordIndex) {
  return {
    id: record.id,
    displayName: record.displayName,
    fields: definition.fields.map((field) => ({
      key: field.key,
      label: field.label,
      valueType: field.valueType,
      value: resolveCanonFieldValue(field, record.fieldValues, recordIndex),
    })),
  };
}

/**
 * Work의 Generic Canon definition과 모든 record를 FULL_CANON public DTO로 읽는다.
 */
function loadCanonContext(workId) {
  const canonSpace = getCanonSpaceByWorkId(workId);
  if (!canonSpace) {
    throw new RepositoryError(
      "CANON_SPACE_NOT_FOUND",
      "이 작품에는 시작된 Canon이 없습니다.",
    );
  }

  const setContexts = getCanonSetsByCanonSpaceId(canonSpace.id).map((set) => {
    const definition = getCanonDefinitionBySetId(set.id);
    if (!definition || definition.canonSpaceId !== canonSpace.id) {
      throw new RepositoryError(
        "CONTEXT_BUILD_FAILED",
        "작업 컨텍스트를 구성하지 못했습니다.",
      );
    }
    const scope = { canonSpaceId: canonSpace.id, setId: set.id };
    const summaries = getCanonRecordsBySetId(scope);
    return {
      definition,
      scope,
      records: summaries.map((summary) => getCanonRecordById(scope, summary.id)),
    };
  });

  const recordIndex = buildRecordIndex(setContexts);
  const aliases = require('../database/repositories/canon-alias-repository.cjs').loadForWork(workId);
  const sets = setContexts.map((setContext) => ({
    key: setContext.definition.key,
    label: setContext.definition.name,
    recordCount: setContext.records.length,
    records: setContext.records.map((record) => ({
      ...hydrateCanonRecord(record, setContext.definition, recordIndex),
      ...(setContext.definition.key === 'character' ? { registeredAliases: aliases.get(record.id) ?? [] } : {}),
    })),
  }));

  return {
    summary: {
      setCount: sets.length,
      recordCount: sets.reduce((count, set) => count + set.recordCount, 0),
    },
    sets,
  };
}

/**
 * 저장된 Episode TXT와 같은 Work의 Generic Canon을 조합해 read-only WorkContext를 만든다.
 */
async function buildEpisodeWorkContext(episodeStorage, input) {
  try {
    const workId = requireContextId(
      input?.workId,
      "WORK_ID_REQUIRED",
      "작품 ID를 입력해 주세요.",
    );
    const episodeId = requireContextId(
      input?.episodeId,
      "EPISODE_ID_REQUIRED",
      "에피소드 ID를 입력해 주세요.",
    );
    const work = getWorkById(workId);
    if (!work) {
      throw new RepositoryError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
    }
    const episode = getEpisodeById(episodeId);
    if (!episode || episode.workId !== workId) {
      throw new RepositoryError(
        "EPISODE_NOT_FOUND",
        "에피소드를 찾을 수 없습니다.",
      );
    }

    const content = await readSavedEpisodeContent(episodeStorage, episode);
    verifyEpisodeContentHash(episode, content);
    const canon = loadCanonContext(workId);

    return {
      scope: "FULL_CANON",
      work: { id: work.id, title: work.title },
      episode: {
        id: episode.id,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        status: episode.status,
        content,
        contentHash: episode.contentHash,
      },
      canon,
    };
  } catch (cause) {
    if (cause instanceof RepositoryError) {
      throw cause;
    }
    throw new RepositoryError(
      "CONTEXT_BUILD_FAILED",
      "작업 컨텍스트를 구성하지 못했습니다.",
      cause,
    );
  }
}

module.exports = {
  readSavedEpisodeContent,
  verifyEpisodeContentHash,
  buildEpisodeWorkContext,
  buildRecordIndex,
  hydrateCanonRecord,
  loadCanonContext,
  resolveCanonFieldValue,
  resolveOption,
  resolveReference,
};
