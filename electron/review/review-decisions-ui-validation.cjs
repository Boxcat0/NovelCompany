const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-decision-ui-'));
process.env.NOVEL_COMPANY_DATA_DIR = root;
app.setPath('userData', path.join(root, 'profile'));
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');

/** 실제 sandbox UI에서 판단 저장·필터·이력·dirty·충돌·지연 조회를 검사한다. */
async function exercise(fixture) {
  /** 실제 DOM 상태만 제한된 시간 동안 기다린다. */
  async function waitFor(check, label) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('판단 UI: ' + label + '\n' + document.body.innerText); }
  /** 특정 문구의 실제 버튼을 찾는다. */
  function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
  /** 회차 선택 버튼을 번호로 찾는다. */
  function episode(number) { return [...document.querySelectorAll('.viewer-episode-button')].find(node => node.querySelector('.viewer-episode-number').textContent === number + '화'); }
  /** 조건 위반을 Main 검증 실패로 전달한다. */
  function check(value, label) { if (!value) throw new Error(label); }
  /** React controlled 입력에 실제 input/change event를 전달한다. */
  function input(id, value) { const node = document.getElementById(id); Object.getOwnPropertyDescriptor(node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
  await waitFor(() => button('작품/회차'), '메뉴'); button('작품/회차').click();
  await waitFor(() => [...document.querySelectorAll('.work-card-button')].some(node => node.textContent.includes('판단 UI 작품')), '작품');
  [...document.querySelectorAll('.work-card-button')].find(node => node.textContent.includes('판단 UI 작품')).click();
  await waitFor(() => episode(1), '회차'); episode(1).click();
  await waitFor(() => document.querySelector('[data-review-run-id]'), '첫 결과');
  episode(2).click(); await waitFor(() => document.querySelector('[data-review-run-id="' + fixture.second.id + '"]'), '다른 회차');
  await new Promise(resolve => setTimeout(resolve, 650));
  check(!document.querySelector('[data-review-run-id="' + fixture.first.id + '"]'), '늦은 판단 요약이 다른 회차를 덮음');
  episode(1).click(); await waitFor(() => document.querySelector('[data-finding-id="' + fixture.scope.findingId + '"]')?.textContent.includes('미검토'), '미검토');
  const finding = document.querySelector('[data-finding-id="' + fixture.scope.findingId + '"]');
  finding.closest('details').open = true; finding.querySelector('button').click();
  await waitFor(() => document.querySelector('.finding-decision-editor')?.textContent.includes('판단 순번 0') && !button('최신 판단 다시 불러오기').disabled, '판단 폼');
  button('수정 필요').click(); input('finding-decision-note', '작가 메모 <img src=x onerror=alert(1)>');
  await waitFor(() => !button('판단 저장').disabled, '저장 가능');
  window.confirm = () => false;
  episode(2).click(); check(document.getElementById('episode-number').value === '1', '미저장 판단 회차 이동');
  button('설정').click(); check(!!document.getElementById('finding-decision-note'), '미저장 판단 화면 이동');
  input('finding-decision-filter', 'RESOLVED'); check(document.getElementById('finding-decision-filter').value === 'ALL', '미저장 판단 필터 이동');
  button('Review 결과 확인').click();
  await waitFor(() => document.getElementById('finding-decision-note')?.value.includes('작가 메모'), '새로고침 draft 유지');
  button('판단 저장').click(); button('판단 저장').click();
  await waitFor(() => button('최신 판단 다시 불러오기').disabled, '저장 응답 대기');
  window.confirm = () => true;
  episode(2).click(); button('설정').click(); input('finding-decision-filter', 'RESOLVED');
  check(document.getElementById('episode-number')?.value === '1' && !!document.getElementById('finding-decision-note') && document.getElementById('finding-decision-filter').value === 'ALL', '저장 중 화면/회차/필터 이동');
  await waitFor(() => document.querySelector('.finding-decision-editor')?.textContent.includes('판단 순번 1') && !button('최신 판단 다시 불러오기').disabled, '판단 저장');
  check(!document.querySelector('.finding-decision-editor img'), '메모 HTML 실행');
  const stored = await window.novelCompany.reviews.decisions.history(fixture.scope);
  check(stored.ok && stored.data.length === 1 && stored.data[0].decisionStatus === 'NEEDS_FIX', '중복 저장 또는 IPC 실패');
  for (const [index, label] of ['기각', '보류', '처리 완료'].entries()) {
    button(label).click(); input('finding-decision-note', label + ' 메모');
    await waitFor(() => !button('판단 저장').disabled, '상태 변경'); button('판단 저장').click();
    await waitFor(() => document.querySelector('.finding-decision-editor')?.textContent.includes('판단 순번 ' + (index + 2)) && !button('최신 판단 다시 불러오기').disabled, '상태 저장');
  }
  check(document.querySelector('.finding-decision-editor').textContent.includes('과거 판단 이력 · 4건'), '판단 이력');
  check(document.querySelector('.finding-decision-editor').textContent.includes('프로그램이 해결을 검증했다는 뜻은 아닙니다'), '완료 의미');
  input('finding-decision-filter', 'UNREVIEWED');
  await waitFor(() => !document.querySelector('[data-finding-id="' + fixture.scope.findingId + '"]'), '미검토 필터');
  input('finding-decision-filter', 'RESOLVED');
  await waitFor(() => document.querySelector('[data-finding-id="' + fixture.scope.findingId + '"]'), '처리 완료 필터');
  document.querySelector('[data-finding-id="' + fixture.scope.findingId + '"] button').click();
  await waitFor(() => button('최신 판단 다시 불러오기')?.disabled === false, '재선택');
  const other = await window.novelCompany.reviews.decisions.append({ ...fixture.scope, decisionStatus: 'DEFERRED', note: '다른 창 판단', expectedRevision: 4 }); check(other.ok, '다른 창');
  button('수정 필요').click(); await waitFor(() => !button('판단 저장').disabled, '오래된 입력'); button('판단 저장').click();
  await waitFor(() => document.querySelector('.finding-decision-editor [role=alert]')?.textContent.includes('다른 창에서 판단이 변경'), '충돌 오류');
  window.confirm = () => true; button('최신 판단 다시 불러오기').click();
  await waitFor(() => document.getElementById('finding-decision-note')?.value === '다른 창 판단', '충돌 재조회');
  return { states: true, history: true, filters: true, dirty: true, busyNavigation: true, refreshDraft: true, duplicate: true, conflict: true, staleSummary: true, safeText: true };
}

/** 임시 DB와 실제 Preload/IPC를 사용하고 판단 이외 테이블의 불변을 확인한다. */
async function run() {
  let window, queue;
  try {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    const storage = new (require('../storage/local-episode-storage.cjs').LocalEpisodeStorage)(root);
    const fixture = require('./testing/rule-review-fixtures.cjs').createRuleFixture(storage, '판단 UI 작품');
    const service = require('./review-service.cjs');
    const first = await service.startEpisodeReview(storage, { workId: fixture.workId, episodeId: fixture.episodes[0].id }, require('./rule-review-processor.cjs').createRuleReviewProcessor());
    const second = await service.startEpisodeReview(storage, { workId: fixture.workId, episodeId: fixture.episodes[1].id });
    const scope = { workId: fixture.workId, episodeId: first.episodeId, reviewRunId: first.id, findingId: first.findings[0].id };
    const original = JSON.stringify(getDatabase().prepare('SELECT * FROM review_findings ORDER BY id').all());
    const register = name => require('../ipc/' + name + '-handlers.cjs');
    register('work').registerWorkHandlers(ipcMain); register('canon').registerCanonHandlers(ipcMain); register('episode').registerEpisodeHandlers(ipcMain, storage); register('context').registerContextHandlers(ipcMain, storage);
    const originalHandle = ipcMain.handle.bind(ipcMain);
    /** 실제 Repository 조회·저장 결과를 지연시켜 늦은 응답과 저장 중 이동을 검사한다. */
    ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => { const result = await handler(...args); if (['reviews:decisions:list', 'reviews:decisions:append'].includes(channel)) await new Promise(resolve => setTimeout(resolve, 500)); return result; });
    queue = require('./review-queue-service.cjs').createReviewQueue(storage); register('review').registerReviewHandlers(ipcMain, storage, queue);
    register('backup').registerBackupHandlers(ipcMain, { dataRoot: root, applicationVersion: '0.1.0', queue, dialog: {} });
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await window.loadFile(path.join(__dirname, '../../dist/index.html'));
    const result = await window.webContents.executeJavaScript('(' + exercise.toString() + ')(' + JSON.stringify({ first, second, scope }) + ').catch(error => { throw new Error(error.stack + "\\n" + document.body.innerText); })');
    assert.equal(JSON.stringify(getDatabase().prepare('SELECT * FROM review_findings ORDER BY id').all()), original);
    assert.equal(require('../database/repositories/review-decision-repository.cjs').getFindingDecision(scope).revision, 5);
    console.log('PASS Electron Author Decisions UI: ' + JSON.stringify(result));
    console.log(JSON.stringify({ temporaryRoot: root }));
    window.destroy(); queue.stop(); closeDatabase(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); queue?.stop(); closeDatabase(); app.exit(1); }
}
app.whenReady().then(run);
