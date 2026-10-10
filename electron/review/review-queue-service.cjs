const { executeReviewProcessor } = require('./review-findings-contract.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { buildCurrentSource } = require('./review-service.cjs');
const jobs = require('../database/repositories/review-job-repository.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { createReviewProcessor, validateProcessorSelection } = require('./review-processor-selection.cjs');
const { withEpisodeSubmission } = require('./episode-operation-gate.cjs');
const { logIpcError } = require('../logging/logger.cjs');
let activeWorker = null;

/** 검증된 WorkContext의 원고·관련 Canon 해시를 제출 기준으로 고정한다. */
function submissionSource(workContext, nameResolutionVersion) {
  const source = buildCurrentSource(workContext, nameResolutionVersion);
  return { episodeContentHash: source.episodeContentHash, canonContextHash: source.canonContextHash,
    contextMode: 'RELEVANT_CANON_V1', fingerprintVersion: 'V2', nameResolutionVersion: source.nameResolutionVersion, sceneMetadataHash: source.sceneMetadataHash, sceneMetadataVersion: source.sceneMetadataVersion, reviewContext: source.reviewContext };
}

/** 한 Main 프로세스에서 제출 시 저장한 방식으로 FIFO를 실행하며 테스트 주입은 Main 내부에 한정한다. */
function createReviewQueue(episodeStorage, processorFactory = createReviewProcessor) {
  let draining = false;
  let stopped = false;
  let started = false;

  /** 프로세스 재시작 시 중단된 실행을 실패 처리한 후 남은 대기 작업을 재개한다. */
  function start() {
    if (started) return;
    if (activeWorker) throw new RepositoryError('REVIEW_WORKER_ALREADY_ACTIVE', '검토 대기열 실행기가 이미 시작되었습니다.');
    jobs.recoverInterrupted();
    started = true;
    activeWorker = api;
    stopped = false;
    kick();
  }

  /** Work/Episode와 허용 Processor를 검증하고 제출 시 선택을 QUEUED Job에 고정한다. */
  async function submit(input) {
    if (!input || typeof input.workId !== 'string' || typeof input.episodeId !== 'string' || Object.keys(input).some(key => !['workId', 'episodeId', 'processorKey'].includes(key))) {
      throw new RepositoryError('REVIEW_SUBMISSION_INVALID', '저장된 회차를 선택해 검토부에 제출해 주세요.');
    }
    const { workId, episodeId } = input;
    const processorKey = validateProcessorSelection(input.processorKey);
    return withEpisodeSubmission(episodeId, async () => {
      jobs.assertNoActiveJob(episodeId);
      const context = await buildEpisodeWorkContext(episodeStorage, { workId, episodeId });
      const source = submissionSource(context);
      const job = jobs.submit({ workId: context.work.id, episodeId: context.episode.id, processorKey, ...source });
      kick();
      return job;
    });
  }

  /** QUEUED 철회를 DB 조건부 전이로 수행해 동시 Worker claim과 일관되게 경합한다. */
  function cancelQueued(reviewJobId) { return jobs.cancelQueued(reviewJobId); }

  /** 긴 Processor 실행을 IPC 응답과 분리하고 단일 drain만 예약한다. */
  function kick() {
    if (stopped || draining) return;
    draining = true;
    queueMicrotask(() => { void drain(); });
  }

  /** 가장 오래된 QUEUED Job을 반복 처리하고 실패해도 다음 Job으로 진행한다. */
  async function drain() {
    try {
      while (!stopped) {
        const job = jobs.getNextQueued();
        if (!job) break;
        try { if (await processJob(job) === false) break; }
        catch (cause) {
          logIpcError({ channel: 'reviews:worker', code: 'REVIEW_WORKER_FAILED', message: '검토 대기열 처리에 실패했습니다.', cause });
          try {
            const current = jobs.getById(job.id);
            if (current?.status === 'RUNNING') jobs.failRunning(job.id, 'REVIEW_FAILED', '검토 작업을 완료하지 못했습니다.');
            else if (current?.status === 'QUEUED') jobs.finishQueued(job.id, 'FAILED', 'REVIEW_START_FAILED', '검토 작업을 시작하지 못했습니다.');
          } catch (failureCause) {
            logIpcError({ channel: 'reviews:worker', code: 'REVIEW_TERMINAL_SAVE_FAILED', message: '검토 작업 종료 상태를 저장하지 못했습니다.', cause: failureCause });
            break;
          }
        }
      }
    } finally { draining = false; }
  }

  /** 입력과 저장된 방식을 재대조하고 Context 복사본 결과를 검증한 뒤 Run·Job을 완료한다. */
  async function processJob(job) {
    let source;
    try {
      source = submissionSource(await buildEpisodeWorkContext(episodeStorage, { workId: job.workId, episodeId: job.episodeId }), job.nameResolutionVersion ?? null);
    } catch (cause) {
      const changed = cause instanceof RepositoryError && cause.code === 'EPISODE_CONTENT_HASH_MISMATCH';
      if (!changed) logIpcError({ channel: 'reviews:worker', code: 'CONTEXT_BUILD_FAILED', message: '검토 입력을 읽지 못했습니다.', cause });
      jobs.finishQueued(job.id, changed ? 'RESUBMIT_REQUIRED' : 'FAILED', changed ? 'REVIEW_INPUT_CHANGED' : cause instanceof RepositoryError ? cause.code : 'CONTEXT_BUILD_FAILED', changed ? '제출 후 원고가 변경되었습니다. 저장 상태를 확인한 뒤 다시 제출해 주세요.' : '검토 입력을 읽지 못했습니다. 원고와 Canon을 확인해 주세요.');
      return;
    }
    // 장면 입력을 기록하지 않은 과거 QUEUED Job도 새 입력으로 조용히 실행하지 않는다.
    if (source.episodeContentHash !== job.episodeContentHash || source.canonContextHash !== job.canonContextHash || source.contextMode !== job.contextMode || source.fingerprintVersion !== job.fingerprintVersion || source.nameResolutionVersion !== job.nameResolutionVersion || source.sceneMetadataHash !== job.sceneMetadataHash || source.sceneMetadataVersion !== job.sceneMetadataVersion) {
      jobs.finishQueued(job.id, 'RESUBMIT_REQUIRED', !job.sceneMetadataHash ? 'REVIEW_SCENE_METADATA_NOT_TRACKED' : 'REVIEW_INPUT_CHANGED', '제출 기준 원고·Canon·장면 시점이 현재 입력과 다릅니다. 다시 제출해 주세요.');
      return;
    }
    const processor = processorFactory(job.processorKey);
    const claimed = jobs.claimWithRun(job.id, processor.processorKey);
    if (!claimed) return jobs.getById(job.id)?.status !== 'QUEUED';
    try {
      const findings = await executeReviewProcessor(processor, source.reviewContext);
      jobs.complete(claimed.id, findings);
    } catch (cause) {
      const code = cause instanceof RepositoryError && ['REVIEW_RESULT_INVALID', 'REVIEW_FINDING_RANGE_INVALID', 'REVIEW_FINDING_CANON_INVALID'].includes(cause.code) ? cause.code : 'REVIEW_FAILED';
      jobs.failRunning(claimed.id, code, '검토 작업을 완료하지 못했습니다.');
      logIpcError({ channel: 'reviews:worker', code, message: '검토 작업을 완료하지 못했습니다.' });
    }
  }

  /** 테스트와 앱 종료에서 새 작업 선점을 멈추되 실행 중 입력은 교체하지 않는다. */
  function stop() { stopped = true; if (activeWorker === api) activeWorker = null; }

  const api = { start, stop, submit, cancelQueued, getQueue: jobs.getQueue, getLatestByEpisode: jobs.getLatestByEpisode, kick };
  return api;
}

module.exports = { createReviewQueue, submissionSource };
