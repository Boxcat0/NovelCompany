const { createHash } = require("node:crypto");
const { buildEpisodeWorkContext } = require("../context/episode-work-context-builder.cjs");
const repository = require("../database/repositories/review-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { logIpcError } = require("../logging/logger.cjs");
const { createStubReviewProcessor } = require("./stub-review-processor.cjs");

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

/** 내부 Run row와 현재 source fingerprint를 비교해 DB status와 별개의 freshness를 만든다. */
function toPublicReview(run, currentSource) {
  const episodeChanged = run.episodeContentHash !== currentSource.episodeContentHash;
  const canonChanged = run.canonContextHash !== currentSource.canonContextHash;
  return {
    id: run.id,
    workId: run.workId,
    episodeId: run.episodeId,
    status: run.status,
    processorKey: run.processorKey,
    source: { episodeContentHash: run.episodeContentHash, canonContextHash: run.canonContextHash },
    freshness: { isCurrent: !episodeChanged && !canonChanged, episodeChanged, canonChanged },
    findings: run.findings.map(({ id, category, message, sortOrder, createdAt }) => ({ id, category, message, sortOrder, createdAt })),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/** WorkContext를 먼저 검증한 뒤 immutable RUNNING Run, processor, 결과 transaction을 순서대로 실행한다. */
async function startEpisodeReview(episodeStorage, input, processor = createStubReviewProcessor()) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = { episodeContentHash: buildEpisodeContentHash(workContext), canonContextHash: buildCanonContextHash(workContext.canon) };
  const run = repository.createRun({ workId: workContext.work.id, episodeId: workContext.episode.id, processorKey: processor.processorKey, ...source });
  try {
    const findings = validateReviewResult(await processor.review(workContext));
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

/** 현재 Episode/Canon context를 한 번만 만들고 해당 Episode의 모든 history freshness를 계산한다. */
async function getReviewsByEpisode(episodeStorage, input) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = { episodeContentHash: buildEpisodeContentHash(workContext), canonContextHash: buildCanonContextHash(workContext.canon) };
  return repository.getByEpisode({ workId: workContext.work.id, episodeId: workContext.episode.id }).map((run) => toPublicReview(run, source));
}

/** Run identity에서 현재 source를 다시 읽어 단일 history 항목에도 freshness를 제공한다. */
async function getReviewById(episodeStorage, reviewRunId) {
  const run = repository.getById(reviewRunId);
  if (!run) throw new RepositoryError("REVIEW_RUN_NOT_FOUND", "검토 실행 결과를 찾을 수 없습니다.");
  const workContext = await buildEpisodeWorkContext(episodeStorage, { workId: run.workId, episodeId: run.episodeId });
  return toPublicReview(run, { episodeContentHash: buildEpisodeContentHash(workContext), canonContextHash: buildCanonContextHash(workContext.canon) });
}

module.exports = { buildCanonContextHash, buildEpisodeContentHash, canonicalStringify, getReviewById, getReviewsByEpisode, startEpisodeReview, toPublicReview, validateReviewResult };
