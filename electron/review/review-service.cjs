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

const { executeReviewProcessor } = require('./review-findings-contract.cjs');

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

/** 기존 입력 버전으로 현재성을 비교하며 비교 불가 상태와 저장 당시 Finding을 함께 제공한다. */
function toPublicReview(run, currentSource) {
  const unavailable = currentSource === null;
  currentSource ??= {};
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
    contractVersion: run.contractVersion ?? null,
    source: { episodeContentHash: run.episodeContentHash, canonContextHash: run.canonContextHash, contextMode, fingerprintVersion, nameResolutionVersion: run.nameResolutionVersion ?? null, sceneMetadataHash: run.sceneMetadataHash ?? null, sceneMetadataVersion: run.sceneMetadataVersion ?? null },
    freshness: unavailable ? { isCurrent: false, episodeChanged: null, canonChanged: null, contextChanged: null, canonComparison: 'UNAVAILABLE', sceneMetadataChanged: null, sceneMetadataComparison: 'UNAVAILABLE' } : { isCurrent: !episodeChanged && !contextChanged && !sceneMetadataChanged, episodeChanged, canonChanged, contextChanged, canonComparison, sceneMetadataChanged, sceneMetadataComparison },
    findings: run.findings,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/** 내부 격리 실행에서 Context 복사본을 전달하고 검증된 결과만 Run에 저장한다. */
async function startEpisodeReview(episodeStorage, input, processor = createStubReviewProcessor()) {
  const workContext = await buildEpisodeWorkContext(episodeStorage, input);
  const source = buildCurrentSource(workContext);
  const run = repository.createRun({ workId: workContext.work.id, episodeId: workContext.episode.id, processorKey: processor.processorKey, episodeContentHash: source.episodeContentHash, canonContextHash: source.canonContextHash, contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2', nameResolutionVersion: source.nameResolutionVersion, sceneMetadataHash: source.sceneMetadataHash, sceneMetadataVersion: source.sceneMetadataVersion });
  try {
    const findings = await executeReviewProcessor(processor, source.reviewContext);
    return toPublicReview(repository.completeRun(run.id, findings), source);
  } catch (cause) {
    const code = cause instanceof RepositoryError && ["REVIEW_RESULT_INVALID", "REVIEW_FINDING_RANGE_INVALID", "REVIEW_FINDING_CANON_INVALID"].includes(cause.code) ? cause.code : "REVIEW_FAILED";
    try { repository.failRun(run.id, code); }
    catch (failureCause) { logIpcError({ channel: "reviews:start", code: "REVIEW_FAILED", message: "검토 작업을 완료하지 못했습니다.", cause: failureCause }); }
    if (cause instanceof RepositoryError && ["REVIEW_RESULT_INVALID", "REVIEW_FINDING_RANGE_INVALID", "REVIEW_FINDING_CANON_INVALID"].includes(cause.code)) throw cause;
    logIpcError({ channel: "reviews:start", code, message: "검토 작업을 완료하지 못했습니다." });
    throw new RepositoryError("REVIEW_FAILED", "검토 작업을 완료하지 못했습니다.");
  }
}

/** 현재 원고·Canon 비교가 불가능해도 과거 근거의 조회는 허용한다. */
async function currentSourceForHistory(episodeStorage, input) {
  try { return buildCurrentSource(await buildEpisodeWorkContext(episodeStorage, input)); }
  catch (error) {
    if (['CANON_SPACE_NOT_FOUND', 'EPISODE_CONTENT_NOT_FOUND', 'EPISODE_CONTENT_HASH_MISMATCH', 'EPISODE_CONTENT_READ_FAILED', 'CONTEXT_CANON_REFERENCE_INVALID', 'CONTEXT_CANON_OPTION_INVALID'].includes(error.code)) return null;
    throw error;
  }
}

/** 동일 Episode의 이력을 읽고 현재 입력이 있으면 기존 버전으로 현재성을 비교한다. */
async function getReviewsByEpisode(episodeStorage, input) {
  const source = await currentSourceForHistory(episodeStorage, input);
  return repository.getByEpisode(input).map(run => toPublicReview(run, source));
}

/** Run별 저장된 근거를 조회하며 Canon 삭제로 과거 조회가 차단되지 않게 한다. */
async function getReviewById(episodeStorage, reviewRunId) {
  const run = repository.getById(reviewRunId);
  if (!run) throw new RepositoryError('REVIEW_RUN_NOT_FOUND', '검토 실행 결과를 찾을 수 없습니다.');
  return toPublicReview(run, await currentSourceForHistory(episodeStorage, { workId: run.workId, episodeId: run.episodeId }));
}

module.exports = { buildRelevantCanonHash, buildCurrentSource, buildCanonContextHash, buildEpisodeContentHash, canonicalStringify, getReviewById, getReviewsByEpisode, startEpisodeReview, toPublicReview };
