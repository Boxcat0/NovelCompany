const { createHash } = require("node:crypto");
const { buildEpisodeWorkContext } = require("../context/episode-work-context-builder.cjs");
const repository = require("../database/repositories/review-repository.cjs");
const { RepositoryError } = require("../database/repositories/repository-error.cjs");
const { logIpcError } = require("../logging/logger.cjs");
const { createStubReviewProcessor } = require("./stub-review-processor.cjs");
const { buildReviewContext } = require('../context/review-context-builder.cjs');
const { canonicalStringify } = require('../context/context-fingerprint.cjs');
const { buildSceneMetadataHash } = require('../context/scene-narration.cjs');
const narrationRepository = require('../database/repositories/scene-narration-repository.cjs');
const { NAME_RESOLUTION_VERSION } = require('../context/character-name-normalization.cjs');

const findingCategories = new Set(["TYPO", "SPACING", "GRAMMAR", "CANON", "OTHER"]);

/** 기존 Canon hash에서 Alias 확장을 제외하고 버전별 구조화 입력을 SHA-256으로 지문화한다. */
function buildCanonContextHash(canonContext) {
  const input = canonContext.sets ? { ...canonContext, sets: canonContext.sets.map(set => ({ ...set, records: set.records.map(({ registeredAliases: _aliases, ...record }) => record) })) } : canonContext;
  return createHash("sha256").update(canonicalStringify(input), "utf8").digest("hex");
}

/** V1/V2의 기존 입력 또는 V3의 실제 명칭 후보까지 결정적으로 해시한다. */
function buildRelevantCanonHash(context, fingerprintVersion = context.nameResolutionVersion ? 'V3' : 'V2') {
  if (!['V1', 'V2', 'V3'].includes(fingerprintVersion) || (fingerprintVersion === 'V3') !== Boolean(context.nameResolutionVersion)) throw new Error('Fingerprint and name-resolution versions must match.');
  const oldOnly = fingerprintVersion === 'V1';
  const oldReasons = context.relevantCanon.selectionReasons.filter(reason => reason.reason !== 'SKILL_REQUIRED_ATTRIBUTE');
  const oldSelectedIds = new Set(oldReasons.map(reason => reason.recordId));
  const selected = context.relevantCanon.selectedRecords.filter(record => !oldOnly || oldSelectedIds.has(record.id));
  const records = selected.map(record => ({ ...record, fields: record.fields.filter(field => !oldOnly || record.setKey !== 'skill' || field.key !== 'required_attribute').sort((a, b) => a.key.localeCompare(b.key, 'en')).map(field => ({ ...field, value: Array.isArray(field.value) ? [...field.value].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b), 'en')) : field.value })) }));
  const selectedSets = oldOnly ? context.relevantCanon.selectedSets.filter(set => selected.some(record => record.setKey === set.key)) : context.relevantCanon.selectedSets;
  const ambiguities = context.unresolvedMentions.filter(item => item.status === 'AMBIGUOUS').map(item => ({ raw: item.raw, candidateIds: item.candidateIds }));
  return buildCanonContextHash({ selectorVersion: oldOnly ? 'RELEVANT_CANON_V1' : context.selectorVersion, selectedSets, records, ambiguities: [...new Map(ambiguities.map(item => [canonicalStringify(item), item])).values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b), 'en')),
    ...(fingerprintVersion === 'V3' ? { nameResolutionVersion: context.nameResolutionVersion, nameMentions: context.nameMentions } : {}) });
}

/** 이름 해석 버전별 Canon 해시와 동일한 Scene Narration 해시를 만들며 Legacy 파서를 재현한다. */
function buildCurrentSource(workContext, nameResolutionVersion = NAME_RESOLUTION_VERSION) {
  const rows = narrationRepository.getForEpisode(workContext.episode.id);
  const legacyContext = buildReviewContext(workContext, rows, null);
  const reviewContext = nameResolutionVersion ? buildReviewContext(workContext, rows, nameResolutionVersion) : legacyContext;
  return { episodeContentHash: buildEpisodeContentHash(workContext), canonContextHash: buildRelevantCanonHash(reviewContext), nameResolutionVersion,
    relevantV2ContextHash: buildRelevantCanonHash(legacyContext, 'V2'), relevantV1ContextHash: buildRelevantCanonHash(legacyContext, 'V1'), fullCanonContextHash: buildCanonContextHash(workContext.canon),
    sceneMetadataHash: buildSceneMetadataHash({ ...reviewContext.sceneMetadata, scenes: reviewContext.scenes }), sceneMetadataVersion: reviewContext.sceneMetadata.metadataVersion, reviewContext };
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

/** 저장 모드·fingerprint 버전으로 비교하고 원고 변경 시 독립 Canon 변경 여부는 미확정으로 남긴다. */
function toPublicReview(run, currentSource) {
  const episodeChanged = run.episodeContentHash !== currentSource.episodeContentHash;
  const contextMode = run.contextMode ?? 'FULL_CANON_V1';
  const relevant = contextMode === 'RELEVANT_CANON_V1';
  const fingerprintVersion = run.fingerprintVersion ?? 'V1';
  const comparedHash = relevant ? run.nameResolutionVersion ? currentSource.canonContextHash : fingerprintVersion === 'V2' ? currentSource.relevantV2ContextHash ?? currentSource.canonContextHash : currentSource.relevantV1ContextHash ?? currentSource.canonContextHash : currentSource.fullCanonContextHash ?? currentSource.canonContextHash;
  const contextChanged = run.canonContextHash !== comparedHash || Boolean(run.nameResolutionVersion && run.nameResolutionVersion !== currentSource.nameResolutionVersion);
  const canonComparison = relevant && episodeChanged ? 'UNDETERMINED_EPISODE_CHANGED' : 'COMPARABLE';
  const canonChanged = canonComparison === 'COMPARABLE' && contextChanged;
  const sceneMetadataComparison = !run.sceneMetadataHash && !run.sceneMetadataVersion ? 'LEGACY_NOT_TRACKED' : episodeChanged ? 'UNDETERMINED_EPISODE_CHANGED' : run.sceneMetadataVersion === currentSource.sceneMetadataVersion && run.sceneMetadataHash === currentSource.sceneMetadataHash ? 'CURRENT' : 'CHANGED';
  const sceneMetadataChanged = sceneMetadataComparison === 'CHANGED';
  return {
    id: run.id,
    workId: run.workId,
    episodeId: run.episodeId,
    status: run.status,
    processorKey: run.processorKey,
    source: { episodeContentHash: run.episodeContentHash, canonContextHash: run.canonContextHash, contextMode, fingerprintVersion, nameResolutionVersion: run.nameResolutionVersion ?? null, sceneMetadataHash: run.sceneMetadataHash ?? null, sceneMetadataVersion: run.sceneMetadataVersion ?? null },
    freshness: { isCurrent: !episodeChanged && !contextChanged && !sceneMetadataChanged, episodeChanged, canonChanged, contextChanged, canonComparison, sceneMetadataChanged, sceneMetadataComparison },
    findings: run.findings.map(({ id, category, message, sortOrder, createdAt }) => ({ id, category, message, sortOrder, createdAt })),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/** V2 ReviewContext를 먼저 구성한 뒤 버전을 고정한 RUNNING Run과 Stub 결과를 실행한다. */
async function startEpisodeReview(episodeStorage, input, processor = createStubReviewProcessor()) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = buildCurrentSource(workContext);
  const run = repository.createRun({ workId: workContext.work.id, episodeId: workContext.episode.id, processorKey: processor.processorKey, episodeContentHash: source.episodeContentHash, canonContextHash: source.canonContextHash, contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2', nameResolutionVersion: source.nameResolutionVersion, sceneMetadataHash: source.sceneMetadataHash, sceneMetadataVersion: source.sceneMetadataVersion });
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
