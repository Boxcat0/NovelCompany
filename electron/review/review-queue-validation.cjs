const { textResult } = require('./testing/finding-fixtures.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closeDatabase, getDatabase, initializeDatabase } = require('../database/database.cjs');
const { createCanonFixture, inputFor } = require('../database/canon-record-validation.cjs');
const records = require('../database/repositories/canon-record-repository.cjs');
const episodes = require('../database/repositories/episode-repository.cjs');
const jobRepository = require('../database/repositories/review-job-repository.cjs');
const { createEpisodeWithContent, updateEpisodeWithContent, deleteEpisodeWithContent } = require('../episode-service.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const { createReviewQueue } = require('./review-queue-service.cjs');
const { buildEpisodeWorkContext } = require('../context/episode-work-context-builder.cjs');
const { getReviewsByEpisode } = require('./review-service.cjs');

/** 외부 timer나 인위적인 프로덕션 지연 없이 테스트 Processor 진행을 제어한다. */
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

/** 비동기 Worker가 기대 상태가 될 때까지 제한된 시간만 기다린다. */
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('검토 대기열 상태 전환이 완료되지 않았습니다.');
}

/** RepositoryError code와 사용자용 한국어 메시지가 일치하는지 확인한다. */
async function expectCode(action, code) {
  await assert.rejects(async () => action(), error => error.code === code && /[가-힣]/.test(error.message));
}

/** 격리 DB에서 제출, FIFO, 잠금, 철회, fingerprint 및 재시작 복구를 검증한다. */
async function runValidation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-company-review-queue-'));
  process.env.NOVEL_COMPANY_DATA_DIR = root;
  const databaseFile = path.join(root, 'novelcompany.db');
  try {
    initializeDatabase(databaseFile);
    const storage = new LocalEpisodeStorage(root);
    await storage.ensureBaseStorage();
    const firstScope = createCanonFixture();
    const secondScope = createCanonFixture();
    const firstWork = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(firstScope.world.canonSpaceId).work_id;
    const secondWork = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(secondScope.world.canonSpaceId).work_id;
    const world = records.create(firstScope.world, inputFor(firstScope.world, '기억의 바다'));
    const a = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 1, title: '첫 회차', content: '기억의 바다' });
    const b = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 2, title: '둘째 회차', content: '두 번째 원고' });
    const c = createEpisodeWithContent(storage, { workId: secondWork, episodeNumber: 1, title: '다른 작품', content: '다른 작품 원고' });
    const d = createEpisodeWithContent(storage, { workId: secondWork, episodeNumber: 2, title: '편집 가능 회차', content: '별도 원고' });
    const held = [];
    const queue = createReviewQueue(storage, () => ({ processorKey: 'TEST_HOLD', review(context) { const step = deferred(); held.push({ step, context }); return step.promise; } }));
    queue.start();

    await expectCode(() => queue.submit({ workId: firstWork, episodeId: 'missing' }), 'EPISODE_NOT_FOUND');
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_jobs').get().n, 0);
    const jobA = await queue.submit({ workId: firstWork, episodeId: a.id });
    await waitFor(() => getDatabase().prepare("SELECT status FROM review_jobs WHERE id = ?").get(jobA.id).status === 'RUNNING');
    const [jobB, jobC] = await Promise.all([queue.submit({ workId: firstWork, episodeId: b.id }), queue.submit({ workId: secondWork, episodeId: c.id })]);
    assert.equal(jobB.status, 'QUEUED');
    assert.equal(jobC.status, 'QUEUED');
    assert.ok(jobA.queueSequence < jobB.queueSequence && jobA.queueSequence < jobC.queueSequence);
    assert.deepEqual(queue.getQueue().queued.map(job => job.queueSequence), [jobB.queueSequence, jobC.queueSequence].sort((left, right) => left - right));
    assert.equal(getDatabase().prepare("SELECT COUNT(*) n FROM review_jobs WHERE status = 'RUNNING'").get().n, 1);
    assert.throws(() => getDatabase().prepare("UPDATE review_jobs SET status = 'RUNNING' WHERE id = ?").run(jobB.id), /UNIQUE constraint failed/);
    await expectCode(() => jobRepository.submit({ workId: firstWork, episodeId: a.id, episodeContentHash: jobA.episodeContentHash, canonContextHash: jobA.canonContextHash }), 'REVIEW_JOB_ALREADY_ACTIVE');
    await expectCode(() => queue.submit({ workId: firstWork, episodeId: b.id }), 'REVIEW_JOB_ALREADY_ACTIVE');
    await expectCode(() => updateEpisodeWithContent(storage, a.id, { workId: firstWork, episodeNumber: 1, title: '수정', content: '수정' }), 'EPISODE_REVIEW_LOCKED');
    await expectCode(() => updateEpisodeWithContent(storage, b.id, { workId: firstWork, episodeNumber: 3, title: '수정', status: 'COMPLETED', content: '수정' }), 'EPISODE_REVIEW_LOCKED');
    await expectCode(() => episodes.updateEpisode(b.id, { title: '직접 수정' }), 'EPISODE_REVIEW_LOCKED');
    await expectCode(() => deleteEpisodeWithContent(storage, b.id, firstWork), 'EPISODE_REVIEW_LOCKED');
    assert.equal((await buildEpisodeWorkContext(storage, { workId: firstWork, episodeId: b.id })).episode.content, '두 번째 원고');
    assert.equal(updateEpisodeWithContent(storage, d.id, { workId: secondWork, episodeNumber: 2, title: '다른 작품 수정', content: '별도 원고' }).title, '다른 작품 수정');
    await expectCode(() => queue.cancelQueued(jobA.id), 'REVIEW_CANCEL_NOT_ALLOWED');
    assert.equal(queue.cancelQueued(jobB.id).status, 'CANCELLED');
    assert.equal(episodes.updateEpisode(b.id, { title: '철회 후 수정' }).title, '철회 후 수정');
    const resubmittedB = await queue.submit({ workId: firstWork, episodeId: b.id });
    assert.ok(resubmittedB.queueSequence > jobC.queueSequence);
    assert.deepEqual(queue.getQueue().queued.map(job => job.id), [jobC.id, resubmittedB.id]);
    await expectCode(() => queue.cancelQueued(jobB.id), 'REVIEW_CANCEL_NOT_ALLOWED');

    held[0].step.reject(new Error('controlled processor failure'));
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(jobA.id).status === 'FAILED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(jobC.id).status === 'RUNNING');
    assert.equal(getDatabase().prepare('SELECT status FROM review_runs WHERE id = (SELECT review_run_id FROM review_jobs WHERE id = ?)').get(jobA.id).status, 'FAILED');
    held[1].step.resolve({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(jobC.id).status === 'COMPLETED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(resubmittedB.id).status === 'RUNNING');
    assert.equal(getDatabase().prepare('SELECT status FROM review_runs WHERE id = (SELECT review_run_id FROM review_jobs WHERE id = ?)').get(jobC.id).status, 'COMPLETED');
    held[2].step.resolve(textResult(held[2].context, '검증 결과'));
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(resubmittedB.id).status === 'COMPLETED');
    assert.equal((await getReviewsByEpisode(storage, { workId: firstWork, episodeId: b.id }))[0].findings[0].message, '검증 결과');
    assert.throws(() => getDatabase().prepare('DELETE FROM review_runs WHERE id = ?').run(getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(resubmittedB.id).review_run_id), /FOREIGN KEY constraint failed/);
    await expectCode(() => queue.cancelQueued(resubmittedB.id), 'REVIEW_CANCEL_NOT_ALLOWED');

    // 관련 Canon 변경은 대기 중인 Job만 재제출 필요로 종료한다.
    const blocker = await queue.submit({ workId: secondWork, episodeId: c.id });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(blocker.id).status === 'RUNNING');
    const changed = await queue.submit({ workId: firstWork, episodeId: a.id });
    records.update(firstScope.world, world.id, inputFor(firstScope.world, '기억의 바다', { description: '변경된 설정' }));
    held[3].step.resolve({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(changed.id).status === 'RESUBMIT_REQUIRED');
    assert.equal(getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(changed.id).review_run_id, null);
    assert.equal(episodes.updateEpisode(a.id, { title: '재제출 필요 후 수정' }).title, '재제출 필요 후 수정');

    // 실행 중 입력은 고정하고, 재시작 시 남은 RUNNING만 실패로 정리한다.
    const interrupted = await queue.submit({ workId: firstWork, episodeId: a.id });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(interrupted.id).status === 'RUNNING');
    const waiting = await queue.submit({ workId: firstWork, episodeId: b.id });
    const runId = getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(interrupted.id).review_run_id;
    queue.stop(); closeDatabase(); initializeDatabase(databaseFile);
    assert.equal(getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(waiting.id).status, 'QUEUED');
    await expectCode(() => updateEpisodeWithContent(storage, b.id, { workId: firstWork, episodeNumber: 2, title: '잠금', content: '잠금' }), 'EPISODE_REVIEW_LOCKED');
    const resumed = createReviewQueue(storage);
    resumed.start();
    assert.equal(getDatabase().prepare('SELECT status, error_code FROM review_jobs WHERE id = ?').get(interrupted.id).status, 'FAILED');
    assert.equal(getDatabase().prepare('SELECT error_code FROM review_runs WHERE id = ?').get(runId).error_code, 'REVIEW_INTERRUPTED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(waiting.id).status === 'COMPLETED');
    assert.deepEqual(getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
    resumed.stop();

    // 제출이 TXT 읽기를 기다리는 동안 동일 회차 저장은 파일 작업 전에 거부한다.
    const pause = deferred();
    const slowStorage = Object.create(storage);
    slowStorage.readEpisodeByStorageKey = async key => { await pause.promise; return storage.readEpisodeByStorageKey(key); };
    const pendingQueue = createReviewQueue(slowStorage);
    const pending = pendingQueue.submit({ workId: firstWork, episodeId: a.id });
    await expectCode(() => updateEpisodeWithContent(storage, a.id, { workId: firstWork, episodeNumber: 1, title: '경합 수정', content: '경합 수정' }), 'EPISODE_OPERATION_BUSY');
    await expectCode(() => episodes.updateEpisode(a.id, { title: '직접 경합 수정' }), 'EPISODE_OPERATION_BUSY');
    pause.resolve();
    const pendingJob = await pending;
    assert.equal(pendingQueue.cancelQueued(pendingJob.id).status, 'CANCELLED');
    assert.equal((await buildEpisodeWorkContext(storage, { workId: firstWork, episodeId: a.id })).episode.content, '기억의 바다');

    // V2 Skill 필요 속성, 무관한 Canon 변경, 외부 TXT 변경을 대기 중에 구분한다.
    const water = records.create(firstScope.attribute, inputFor(firstScope.attribute, '물'));
    const fire = records.create(firstScope.attribute, inputFor(firstScope.attribute, '불'));
    const skill = records.create(firstScope.skill, inputFor(firstScope.skill, '해일', { required_attribute: water.id }));
    const leader = createEpisodeWithContent(storage, { workId: secondWork, episodeNumber: 3, title: '입력 비교 차단용', content: '대기열 차단' });
    const skillEpisode = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 3, title: '스킬 필요 속성', content: '{해일}' });
    const externalEpisode = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 4, title: '외부 편집', content: '원고 원본' });
    const unrelatedEpisode = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 5, title: '무관한 설정', content: '관련 이름 없음' });
    const missingEpisode = createEpisodeWithContent(storage, { workId: firstWork, episodeNumber: 6, title: '파일 유실', content: '파일 원본' });
    const controlled = [];
    const checkQueue = createReviewQueue(storage, () => ({ processorKey: 'TEST_INPUT', review(context) { const step = deferred(); controlled.push({ step, context }); return step.promise; } }));
    checkQueue.start(); checkQueue.start();
    await expectCode(() => createReviewQueue(storage).start(), 'REVIEW_WORKER_ALREADY_ACTIVE');
    const leadingJob = await checkQueue.submit({ workId: secondWork, episodeId: leader.id });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(leadingJob.id).status === 'RUNNING');
    const skillJob = await checkQueue.submit({ workId: firstWork, episodeId: skillEpisode.id });
    const externalJob = await checkQueue.submit({ workId: firstWork, episodeId: externalEpisode.id });
    const missingJob = await checkQueue.submit({ workId: firstWork, episodeId: missingEpisode.id });
    const unrelatedJob = await checkQueue.submit({ workId: firstWork, episodeId: unrelatedEpisode.id });
    records.update(firstScope.skill, skill.id, inputFor(firstScope.skill, '해일', { required_attribute: fire.id }));
    const externalRow = episodes.getEpisodeById(externalEpisode.id);
    fs.writeFileSync(storage.resolveManagedPath(firstWork, externalRow.storageKey), '외부 변경', 'utf8');
    const missingRow = episodes.getEpisodeById(missingEpisode.id);
    fs.unlinkSync(storage.resolveManagedPath(firstWork, missingRow.storageKey));
    controlled[0].step.resolve({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(skillJob.id).status === 'RESUBMIT_REQUIRED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(externalJob.id).status === 'RESUBMIT_REQUIRED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(missingJob.id).status === 'FAILED');
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(unrelatedJob.id).status === 'RUNNING');
    assert.equal(controlled.length, 2);
    controlled[1].step.resolve({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(unrelatedJob.id).status === 'COMPLETED');
    assert.equal(getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(skillJob.id).review_run_id, null);
    assert.equal(getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(externalJob.id).review_run_id, null);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM review_jobs WHERE status = ?').get('RUNNING').n, 0);
    const fixedJob = await checkQueue.submit({ workId: firstWork, episodeId: skillEpisode.id });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(fixedJob.id).status === 'RUNNING');
    const fixedContext = JSON.stringify(controlled[2].context);
    records.update(firstScope.skill, skill.id, inputFor(firstScope.skill, '해일', { required_attribute: water.id }));
    assert.equal(JSON.stringify(controlled[2].context), fixedContext);
    controlled[2].step.resolve({ contractVersion: 'REVIEW_FINDINGS_V1', findings: [] });
    await waitFor(() => getDatabase().prepare('SELECT status FROM review_jobs WHERE id = ?').get(fixedJob.id).status === 'COMPLETED');
    assert.equal((await getReviewsByEpisode(storage, { workId: firstWork, episodeId: skillEpisode.id })).find(run => run.id === getDatabase().prepare('SELECT review_run_id FROM review_jobs WHERE id = ?').get(fixedJob.id).review_run_id).freshness.canonChanged, true);
    checkQueue.stop();
    console.log('Task026 Review Queue validation passed.');
  } finally {
    closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.NOVEL_COMPANY_DATA_DIR;
  }
}

runValidation().catch(error => { console.error(error); process.exitCode = 1; });
