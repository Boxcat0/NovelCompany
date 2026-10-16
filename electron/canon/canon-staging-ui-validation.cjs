const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.argv[2];
assert.ok(typeof root === 'string' && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('canon-staging-ui-'));
fs.mkdirSync(root, { recursive: true }); process.env.NOVEL_COMPANY_DATA_DIR = root; app.setPath('userData', path.join(root, 'profile'));
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');

/** 실제 Canon 화면에서 파일 미리보기·Import·임시 편집·충돌·승인 등록을 검증한다. */
async function exercise(scope) {
  /** 비공개 원문을 출력하지 않고 특정 DOM 조건을 제한된 시간만 기다린다. */
  async function wait(check, label) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Staging UI: ' + label); }
  /** 실제 버튼을 정확한 한국어 이름으로 찾는다. */
  function button(text) { return [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text); }
  /** React controlled 입력을 실제 input/change 이벤트로 갱신한다. */
  function input(node, value) { Object.getOwnPropertyDescriptor(node.tagName === 'SELECT' ? HTMLSelectElement.prototype : node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
  /** 조건 실패에는 식별용 라벨만 표시하며 후보 내용은 출력하지 않는다. */
  function check(condition, label) { if (!condition) throw new Error('Staging UI: ' + label); }
  /** 화면의 특정 논리키 후보 행을 읽는다. */
  function row(key) { return document.querySelector('[data-staging-key="' + key + '"]'); }
  const api = window.novelCompany.canon.staging;
  await wait(() => button('컨셉정리'), 'navigation'); button('컨셉정리').click();
  await wait(() => button('가상 Staging UI 작품'), 'work list'); button('가상 Staging UI 작품').click();
  await wait(() => button('등록 대기 Canon') && !button('등록 대기 Canon').disabled, 'Canon ready'); button('등록 대기 Canon').click();
  await wait(() => button('JSON 파일 선택 / 미리보기')?.disabled === false, 'Staging loaded');
  button('JSON 파일 선택 / 미리보기').click(); await wait(() => document.querySelector('.staging-import-preview')?.textContent.includes('총 168개'), 'Import preview');
  check((await api.list(scope)).data.records.length === 0, 'preview wrote rows');
  button('Import 취소').click(); await wait(() => !document.querySelector('.staging-import-preview'), 'cancel preview settled');
  button('JSON 파일 선택 / 미리보기').click(); await wait(() => button('등록 대기로 Import 실행')?.disabled === false, 'second preview');
  window.confirm = () => false; button('등록 대기로 Import 실행').click(); check((await api.list(scope)).data.records.length === 0, 'cancel wrote rows');
  window.confirm = () => true; button('등록 대기로 Import 실행').click(); button('등록 대기로 Import 실행').click();
  await wait(() => row('world:1') && button('JSON 파일 선택 / 미리보기')?.disabled === false, 'Import committed');
  check((await api.list(scope)).data.records.length === 168, 'Import count');
  row('world:1').querySelector('button').click(); await wait(() => document.getElementById('staging-name') && !button('최신 후보 다시 불러오기').disabled, 'editor');
  input(document.getElementById('staging-name'), '가상 작가 수정 <img src=x>');
  await wait(() => !button('등록 대기 임시 저장').disabled, 'dirty');
  window.confirm = () => false; row('world:2').querySelector('button').click(); button('설정').click();
  check(document.getElementById('staging-name')?.value === '가상 작가 수정 <img src=x>', 'dirty navigation');
  input(document.querySelector('[aria-label="등록 대기 상태"]'), 'READY'); check(document.querySelector('[aria-label="등록 대기 상태"]').value === 'ALL', 'dirty filter');
  button('등록 대기 임시 저장').click(); button('등록 대기 임시 저장').click();
  await wait(() => button('최신 후보 다시 불러오기').disabled, 'save in flight'); check(button('공식 Canon 관리').disabled, 'busy navigation');
  await wait(() => document.querySelector('.staging-editor')?.textContent.includes('수정 순번 2') && !button('최신 후보 다시 불러오기').disabled, 'saved revision');
  check(!document.querySelector('.staging-editor img'), 'HTML executed');
  const saved = (await api.list(scope)).data.records.find(item => item.draftKey === 'world:1'); check(saved.revision === 2, 'double save revision');
  await api.update(scope, saved.id, { displayName: '가상 다른 화면 수정', fields: saved.candidate.fields, references: saved.candidate.references, authorPrivate: false, expectedRevision: 2 });
  input(document.getElementById('staging-name'), '가상 오래된 입력'); await wait(() => !button('등록 대기 임시 저장').disabled, 'stale dirty'); button('등록 대기 임시 저장').click();
  await wait(() => document.querySelector('.canon-staging-panel [role=alert]')?.textContent.includes('다른 화면'), 'revision conflict');
  window.confirm = () => true; button('최신 후보 다시 불러오기').click(); await wait(() => document.getElementById('staging-name')?.value === '가상 다른 화면 수정' && !button('최신 후보 다시 불러오기').disabled, 'reload latest');
  input(document.querySelector('[aria-label="등록 대기 분류"]'), 'character'); input(document.querySelector('[aria-label="등록 대기 상태"]'), 'DRAFT');
  await wait(() => row('character:62') && !row('world:0'), 'private filter'); row('character:62').querySelector('button').click();
  await wait(() => document.getElementById('staging-private')?.checked && !button('최신 후보 다시 불러오기').disabled, 'private detail'); check(document.getElementById('staging-private').disabled, 'source private editable');
  row('character:62').querySelector('input').click(); button('선택 배치 정식 등록 미리보기').click();
  await wait(() => document.querySelector('.staging-promotion-preview') && !button('선택 배치 정식 등록 미리보기').disabled, 'private preview'); check(button('전체 내용 확인 후 정식 등록 실행').disabled, 'private promotion enabled');
  button('정식 등록 취소').click(); row('character:62').querySelector('input').click();
  input(document.querySelector('[aria-label="등록 대기 분류"]'), 'ALL'); input(document.querySelector('[aria-label="등록 대기 상태"]'), 'ALL');
  const keys = ['world:0', 'attribute:0', 'location:0', 'city:0', 'organization:0', 'passive:0', 'skill:0', 'character:1', 'character:2', 'authority:0', 'servant:0', 'contract:0', 'relationship:0'];
  for (const key of keys) row(key).querySelector('input').click();
  button('선택 배치 정식 등록 미리보기').click(); await wait(() => button('전체 내용 확인 후 정식 등록 실행')?.disabled === false, 'ready batch');
  const before = await window.novelCompany.canon.records.getBySetId({ canonSpaceId: scope.canonSpaceId, setId: (await api.list(scope)).data.definitions.find(set => set.key === 'world').id }); check(before.data.length === 0, 'promotion preview wrote Canon');
  window.confirm = () => false; button('전체 내용 확인 후 정식 등록 실행').click(); check((await api.list(scope)).data.records.filter(item => item.promotion).length === 0, 'promotion cancel wrote');
  window.confirm = () => true; button('전체 내용 확인 후 정식 등록 실행').click(); button('전체 내용 확인 후 정식 등록 실행').click();
  await wait(() => document.querySelector('.canon-staging-panel')?.textContent.includes('공식 Canon 연결 13개를 완료') && !button('JSON 파일 선택 / 미리보기').disabled, 'promotion committed');
  const promoted = (await api.list(scope)).data.records; check(promoted.filter(item => item.promotion).length === 13, 'promotion count'); check(promoted.filter(item => item.source.author_private && item.promotion).length === 0, 'private leak');
  row('world:0').querySelector('button').click(); await wait(() => button('공식 Canon으로 이동')?.disabled === false, 'UUID link'); button('공식 Canon으로 이동').click();
  await wait(() => document.querySelector('.canon-record-list')?.textContent.includes('가상 world 0'), 'official navigation');
  return { importPreview: true, cancel: true, actualImport: true, duplicate: true, edit: true, dirty: true, busy: true, conflict: true, filters: true, private: true, promotionPreview: true, actualPromotion: true, officialNavigation: true };
}

/** 임시 Profile에서 실제 sandbox Preload·IPC·Repository·React UI를 구동한다. */
async function run() {
  let window;
  try {
    initializeDatabase(path.join(root, 'novelcompany.db'));
    const { createScope, documentFixture } = require('./testing/staging-fixtures.cjs'), scope = createScope();
    require('../database/repositories/work-repository.cjs').updateWork(scope.workId, { title: '가상 Staging UI 작품' });
    const file = path.join(root, 'virtual-canon.json'); fs.writeFileSync(file, JSON.stringify(documentFixture()));
    const originalHandle = ipcMain.handle.bind(ipcMain);
    /** 실제 저장·조회 결과에 지연을 넣어 중복·busy·StrictMode 응답 경쟁을 검사한다. */
    ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => { const result = await handler(...args); if (['canon:staging:list', 'canon:staging:update', 'canon:staging:promote'].includes(channel)) await new Promise(resolve => setTimeout(resolve, 250)); return result; });
    require('../ipc/work-handlers.cjs').registerWorkHandlers(ipcMain);
    require('../ipc/canon-handlers.cjs').registerCanonHandlers(ipcMain, { dialog: { /** 임시 가상 파일만 반환한다. */ async showOpenDialog() { return { canceled: false, filePaths: [file] }; } } });
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, '../preload.cjs'), offscreen: true, backgroundThrottling: false } });
    await window.loadFile(path.join(__dirname, '../../dist/index.html'));
    const result = await window.webContents.executeJavaScript('(' + exercise.toString() + ')(' + JSON.stringify(scope) + ').catch(error => { throw new Error(error.stack); })');
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_records').get().n, 13);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM canon_staging_records').get().n, 168);
    assert.equal(getDatabase().prepare('PRAGMA foreign_key_check').all().length, 0);
    console.log('PASS Electron Staging UI: ' + JSON.stringify(result)); window.destroy(); closeDatabase(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); closeDatabase(); app.exit(1); }
}
app.whenReady().then(run);
