const { createHash } = require("node:crypto");
const { buildEpisodeWorkContext } = require("../context/episode-work-context-builder.cjs");
const repository = require("../database/repositories/review-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { logIpcError } = require("../logging/logger.cjs");
const { createStubReviewProcessor } = require("./stub-review-processor.cjs");
const { buildReviewContext } = require('../context/review-context-builder.cjs');

const findingCategories = new Set(["TYPO", "SPACING", "GRAMMAR", "CANON", "OTHER"]);

/** 임의 객체를 key 순서가 고정된 JSON 문자열로 바꿔 source fingerprint 입력을 안정화한다. */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalStringify(value[key])).join(",") + "}";
}

/** 검증된 WorkContext의 현재 Canon public DTO만 SHA-256 fingerprint로 만든다. */
function buildCanonContextHash(canonContext) {
  return createHash("sha256").update(canonicalStringify(canonContext), "utf8").digest("hex");
}

/** 전체 건수·시각·원고 위치를 제외하고 선택된 실제 Canon 및 모호한 후보 identity를 결정적으로 해시한다. */
function buildRelevantCanonHash(context) {
  const records = context.relevantCanon.selectedRecords.map(record => ({ ...record, fields: [...record.fields].sort((a, b) => a.key.localeCompare(b.key, 'en')).map(field => ({ ...field, value: Array.isArray(field.value) ? [...field.value].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b), 'en')) : field.value })) }));
  const ambiguities = context.unresolvedMentions.filter(item => item.status === 'AMBIGUOUS').map(item => ({ raw: item.raw, candidateIds: item.candidateIds }));
  return buildCanonContextHash({ selectorVersion: context.selectorVersion, selectedSets: context.relevantCanon.selectedSets, records, ambiguities: [...new Map(ambiguities.map(item => [canonicalStringify(item), item])).values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b), 'en')) });
}

/** 한 번 읽은 FULL_CANON에서 legacy와 relevant 비교 입력을 함께 구성한다. */
function buildCurrentSource(workContext) {
  const reviewContext = buildReviewContext(workContext);
  return { episodeContentHash: buildEpisodeContentHash(workContext), canonContextHash: buildRelevantCanonHash(reviewContext), fullCanonContextHash: buildCanonContextHash(workContext.canon), reviewContext };
}

/** metadata hash가 없는 legacy Episode도 저장된 TXT 기반 source hash를 항상 남긴다. */
function buildEpisodeContentHash(workContext) {
  return workContext.episode.contentHash ?? createHash("sha256").update(workContext.episode.content, "utf8").digest("hex");
}

/** Processor 결과가 finding contract만 포함하며 저장 가능한 public 값인지 확인한다. */
function validateReviewResult(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.findings)) {
    throw new RepositoryError("REVIEW_RESULT_INVALID", "검토 결과 형식이 올바르지 않습니다.");
  }
  return result.findings.map((finding) => {
    if (!finding || typeof finding !== "object" || !findingCategories.has(finding.category) || typeof finding.message !== "string" || finding.message.trim().length === 0) {
      throw new RepositoryError("REVIEW_RESULT_INVALID", "검토 결과 형식이 올바르지 않습니다.");
    }
    return { category: finding.category, message: finding.message.trim() };
  });
}

/** 저장 모드에 맞는 hash를 비교하고 원고 변경 시 relevant Canon의 독립 변경 여부는 미확정으로 남긴다. */
function toPublicReview(run, currentSource) {
  const episodeChanged = run.episodeContentHash !== currentSource.episodeContentHash;
  const contextMode = run.contextMode ?? 'FULL_CANON_V1';
  const relevant = contextMode === 'RELEVANT_CANON_V1';
  const contextChanged = run.canonContextHash !== (relevant ? currentSource.canonContextHash : currentSource.fullCanonContextHash ?? currentSource.canonContextHash);
  const canonComparison = relevant && episodeChanged ? 'UNDETERMINED_EPISODE_CHANGED' : 'COMPARABLE';
  const canonChanged = canonComparison === 'COMPARABLE' && contextChanged;
  return {
    id: run.id,
    workId: run.workId,
    episodeId: run.episodeId,
    status: run.status,
    processorKey: run.processorKey,
    source: { episodeContentHash: run.episodeContentHash, canonContextHash: run.canonContextHash, contextMode },
    freshness: { isCurrent: !episodeChanged && !contextChanged, episodeChanged, canonChanged, contextChanged, canonComparison },
    findings: run.findings.map(({ id, category, message, sortOrder, createdAt }) => ({ id, category, message, sortOrder, createdAt })),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/** ReviewContext를 먼저 구성한 뒤 relevant 모드의 RUNNING Run과 Stub 결과 transaction을 실행한다. */
async function startEpisodeReview(episodeStorage, input, processor = createStubReviewProcessor()) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = buildCurrentSource(workContext);
  const run = repository.createRun({ workId: workContext.work.id, episodeId: workContext.episode.id, processorKey: processor.processorKey, episodeContentHash: source.episodeContentHash, canonContextHash: source.canonContextHash, contextMode: 'RELEVANT_CANON_V1' });
  try {
    const findings = validateReviewResult(await processor.review(source.reviewContext));
    return toPublicReview(repository.completeRun(run.id, findings), source);
  } catch (cause) {
    const code = cause instanceof RepositoryError && cause.code === "REVIEW_RESULT_INVALID" ? cause.code : "REVIEW_FAILED";
    try { repository.failRun(run.id, code); }
    catch (failureCause) { logIpcError({ channel: "reviews:start", code: "REVIEW_FAILED", message: "검토 작업을 완료하지 못했습니다.", cause: failureCause }); }
    if (cause instanceof RepositoryError && cause.code === "REVIEW_RESULT_INVALID") throw cause;
    logIpcError({ channel: "reviews:start", code, message: "검토 작업을 완료하지 못했습니다.", cause });
    throw new RepositoryError("REVIEW_FAILED", "검토 작업을 완료하지 못했습니다.", cause);
  }
}

/** 현재 Context를 한 번 읽고 각 history의 저장된 FULL/RELEVANT 모드로 freshness를 계산한다. */
async function getReviewsByEpisode(episodeStorage, input) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = buildCurrentSource(workContext);
  return repository.getByEpisode({ workId: workContext.work.id, episodeId: workContext.episode.id }).map((run) => toPublicReview(run, source));
}

/** Run identity에서 현재 Context를 읽고 저장된 모드에 맞는 단일 history freshness를 제공한다. */
async function getReviewById(episodeStorage, reviewRunId) {
  const run = repository.getById(reviewRunId);
  if (!run) throw new RepositoryError("REVIEW_RUN_NOT_FOUND", "검토 실행 결과를 찾을 수 없습니다.");
  const workContext = await buildEpisodeWorkContext(episodeStorage, { workId: run.workId, episodeId: run.episodeId });
  return toPublicReview(run, buildCurrentSource(workContext));
}

module.exports = { buildRelevantCanonHash, buildCurrentSource, buildCanonContextHash, buildEpisodeContentHash, canonicalStringify, getReviewById, getReviewsByEpisode, startEpisodeReview, toPublicReview, validateReviewResult };
