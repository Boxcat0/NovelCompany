const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = process.argv.includes('--restart') ? process.argv.at(-1) : fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-backup-ui-'));
process.env.NOVEL_COMPANY_DATA_DIR = root;
app.setPath('userData', path.join(root, 'profile'));
const { initializeDatabase, getDatabase, closeDatabase } = require('../database/database.cjs');
const { LocalEpisodeStorage } = require('../storage/local-episode-storage.cjs');
const service = require('./data-backup-service.cjs');

/** 실제 sandbox Renderer에서 dirty·dialog·중복 클릭·preview·확인 취소·전체 교체를 검사한다. */
async function exerciseSettings(restart = false) {
  /** 원하는 텍스트의 버튼만 찾는다. */
  function button(text) { return [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.getAttribute('aria-label') === text); }
  /** 실제 렌더링과 IPC가 완료될 때까지만 기다린다. */
  async function waitFor(check, label = 'UI 상태') { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(label + '\n' + document.body.innerText); }
  /** UI 안전성 조건을 확인한다. */
  function check(value, message) { if (!value) throw new Error(message); }
  check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'sandbox renderer');
  await waitFor(() => button('설정'));
  if (restart) {
    button('설정').click();
    await waitFor(() => document.body.textContent.includes('작품 1개 · 회차 2개'));
    const works = await window.novelCompany.works.getAll();
    check(works.ok && works.data.length === 1 && works.data[0].title === 'UI 원본 작품', '새 프로세스 DB 조회');
    check(!works.data.some(work => work.title === '대상 PC에만 있는 작품'), '대상 PC 전용 작품 제거');
    return 'PASS Settings restart: recovered journal, fresh Main repositories and worker, sandbox bridge';
  }
  button('작품 관리').click();
  await waitFor(() => button('+ 새 작품') && !button('+ 새 작품').disabled, '작품 화면 준비');
  button('+ 새 작품').click();
  await waitFor(() => document.getElementById('work-title'), '새 작품 입력 폼');
  const title = document.getElementById('work-title');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, '미저장 입력');
  title.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.body.textContent.includes('저장하지 않은 변경사항'));
  await new Promise(resolve => setTimeout(resolve, 50));
  const dirty = await window.novelCompany.backup.export(); check(!dirty.ok && dirty.error.code === 'DATA_OPERATION_BUSY', 'Main dirty backup block');
  window.confirm = () => false; button('설정').click(); check(!!document.getElementById('work-title'), 'dirty navigation cancel');
  window.confirm = () => true; button('설정').click();
  await waitFor(() => button('데이터 내보내기'));
  button('데이터 내보내기').click(); button('데이터 내보내기').click();
  await waitFor(() => button('데이터 내보내기').disabled);
  button('컨셉정리').click(); check(!!button('데이터 내보내기'), 'busy navigation block');
  await waitFor(() => document.body.textContent.includes('내보내기가 완료'));
  button('데이터 내보내기').click();
  await waitFor(() => document.querySelector('[role=alert]')?.textContent.includes('이미 있습니다'));
  button('데이터 가져오기').click();
  await waitFor(() => document.querySelector('[role=alert]')?.textContent.includes('ZIP'));
  button('데이터 가져오기').click();
  await waitFor(() => document.querySelector('.backup-preview'));
  check(document.querySelector('.backup-preview').textContent.includes('가져올 작품 1개 · 가져올 회차 2개 · DB Schema 16'), 'verified summary');
  check(document.querySelector('.backup-preview').textContent.includes('자동 백업'), 'replacement and backup warning');
  document.querySelector('input[name="backup-mode"][value="update"]').click();
  await waitFor(() => !document.querySelector('fieldset').disabled && !document.querySelector('.backup-preview'));
  button('데이터 가져오기').click();
  await waitFor(() => document.querySelector('.backup-preview')?.textContent.includes('변경사항 업데이트 미리보기'));
  check(button('변경사항 업데이트 실행').disabled && document.querySelector('.backup-preview').textContent.includes('자동 병합 가능: 0건'), 'update mode no-op preview cannot apply');
  document.querySelector('input[name="backup-mode"][value="overwrite"]').click();
  await waitFor(() => !document.querySelector('fieldset').disabled && !document.querySelector('.backup-preview'));
  button('데이터 가져오기').click();
  await waitFor(() => document.querySelector('.backup-preview')?.textContent.includes('전체 덮어쓰기 실행'));
  await waitFor(() => document.querySelector('.backup-preview')?.textContent.includes('현재 PC의 작품 2개 · 회차 3개'), '대상과 ZIP 차이 표시');
  check(document.querySelector('.backup-preview').textContent.includes('아직 적용되지 않았습니다'), '미적용 단계 표시');
  check(!button('전체 덮어쓰기 실행').disabled, '서로 다른 DB도 전체 덮어쓰기 승인 가능');
  const invalid = await window.novelCompany.backup.import('C:\\arbitrary\\database.db'); check(!invalid.ok && invalid.error.code === 'BACKUP_INPUT_INVALID', 'opaque token guard');
  button('전체 덮어쓰기 실행').click();
  await waitFor(() => button('전체 덮어쓰기 실행').disabled);
  await waitFor(() => !button('전체 덮어쓰기 실행').disabled);
  check(!!document.querySelector('.backup-preview'), 'final confirmation cancel preserves preview');
  const preserved = await window.novelCompany.works.getAll();
  check(preserved.ok && preserved.data.length === 2 && preserved.data.some(work => work.title === '대상 PC에만 있는 작품'), '최종 확인 취소 시 대상 데이터 불변');
  button('전체 덮어쓰기 실행').click();
  await waitFor(() => document.body.textContent.includes('복원과 자동 백업이 완료'));
  const blocked = await window.novelCompany.works.create({ title: '재시작 전 쓰기 금지' }); check(!blocked.ok && blocked.error.code === 'DATA_OPERATION_BUSY', 'closed DB gate held until restart');
  return 'PASS Settings: export, overwrite/update mode preview, corrupt ZIP message, dirty/busy/double-click protection, native final cancel/confirm, restart gate';
}

/** 임시 Profile과 실제 Main IPC를 사용하는 테스트 창을 준비하고 복원 결과를 확인한다. */
async function run() {
  let window, queue;
  const timer = setTimeout(() => app.exit(1), 50000);
  try {
    service.recoverInterruptedRestore(root); initializeDatabase(path.join(root, 'novelcompany.db'));
    const storage = new LocalEpisodeStorage(root);
    const restart = process.argv.includes('--restart');
    const output = path.join(root, 'ui.zip'), corrupt = path.join(root, 'corrupt.zip');
    let sourceScope, sourceCanonC, sourceEpisode3;
    if (!restart) {
      sourceScope = require('../database/canon-record-validation.cjs').createCanonFixture();
      const workId = getDatabase().prepare('SELECT work_id FROM canon_spaces WHERE id = ?').get(sourceScope.world.canonSpaceId).work_id;
      getDatabase().prepare('UPDATE works SET title = ? WHERE id = ?').run('UI 원본 작품', workId);
      const records = require('../database/repositories/canon-record-repository.cjs');
      records.create(sourceScope.world, { displayName: 'Canon A', fieldValues: {} });
      sourceCanonC = records.create(sourceScope.world, { displayName: 'Canon C', fieldValues: {} });
      require('../episode-service.cjs').createEpisodeWithContent(storage, { workId, episodeNumber: 1, title: '원고 1화', content: 'UI 원본 TXT\r\n' });
      sourceEpisode3 = require('../episode-service.cjs').createEpisodeWithContent(storage, { workId, episodeNumber: 3, title: '원고 3화', content: 'ZIP 전용 3화 TXT\r\n' });
      fs.writeFileSync(corrupt, 'damaged zip');
    }
    const register = name => require('../ipc/' + name + '-handlers.cjs');
    register('work').registerWorkHandlers(ipcMain); register('canon').registerCanonHandlers(ipcMain); register('episode').registerEpisodeHandlers(ipcMain, storage); register('context').registerContextHandlers(ipcMain, storage);
    queue = require('../review/review-queue-service.cjs').createReviewQueue(storage); register('review').registerReviewHandlers(ipcMain, storage, queue);
    let saves = 0, opens = 0, confirmations = 0, restored = false;
    /** ZIP 생성 이후의 대상 PC에만 있는 행과 TXT를 만들어 실제 교체를 검증한다. */
    function divergeTarget() {
      const original = getDatabase().prepare('SELECT id FROM works WHERE title = ?').get('UI 원본 작품');
      const episode = getDatabase().prepare('SELECT id FROM episodes WHERE work_id = ? AND episode_number = 1').get(original.id);
      getDatabase().prepare('UPDATE works SET title = ? WHERE id = ?').run('대상 PC에서 수정한 작품', original.id);
      require('../episode-service.cjs').updateEpisodeWithContent(storage, episode.id, { workId: original.id, episodeNumber: 1, title: '대상 PC 원고', content: '대상 PC의 다른 TXT\r\n' });
      require('../episode-service.cjs').deleteEpisodeWithContent(storage, sourceEpisode3.id, original.id);
      require('../episode-service.cjs').createEpisodeWithContent(storage, { workId: original.id, episodeNumber: 2, title: '대상 PC 2화', content: '대상 전용 2화 TXT\r\n' });
      const records = require('../database/repositories/canon-record-repository.cjs');
      records.delete(sourceScope.world, sourceCanonC.id);
      records.create(sourceScope.world, { displayName: 'Canon B', fieldValues: {} });
      const extra = require('../database/repositories/work-repository.cjs').createWork({ title: '대상 PC에만 있는 작품' });
      require('../episode-service.cjs').createEpisodeWithContent(storage, { workId: extra.id, episodeNumber: 1, title: '대상 전용 회차', content: 'ZIP에는 없는 TXT\r\n' });
    }
    register('backup').registerBackupHandlers(ipcMain, {
      dataRoot: root, applicationVersion: '0.1.0', queue,
      dialog: {
        /** 실제 native dialog 경계만 지연 주입하며 파일 작업은 실제 서비스에서 수행한다. */
        async showSaveDialog() { saves++; await new Promise(resolve => setTimeout(resolve, 250)); return { canceled: false, filePath: output }; },
        /** 첫 손상 입력 뒤 정상 백업을 선택해 Main 검증을 실행한다. */
        async showOpenDialog() { opens++; if (opens === 4) divergeTarget(); return { canceled: false, filePaths: [opens === 1 ? corrupt : output] }; },
        /** 선택만으로 교체되지 않고 취소 후 별도 최종 승인이 필요함을 검사한다. */
        async showMessageBox(input) { confirmations++; assert.equal(input.cancelId, 0); assert.ok(input.message.includes('모든')); assert.ok(input.detail.includes('백업 생성일:') && input.detail.includes('작품: 1개 / 회차: 2개') && input.detail.includes('DB Schema: 16') && input.detail.includes('자동 백업')); await new Promise(resolve => setTimeout(resolve, 100)); return { response: confirmations === 1 ? 0 : 1 }; },
      },
      /** 테스트의 앱 재시작은 부모가 새 Electron 프로세스를 실행하도록 표시한다. */
      onRestored() { restored = true; },
      /** 원본 복구 실패는 테스트를 즉시 실패시킨다. */
      onFatal() { throw new Error('unexpected fatal restore'); },
    });
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await window.loadFile(path.join(__dirname, '../../dist/index.html'));
    console.log(await window.webContents.executeJavaScript('(' + exerciseSettings.toString() + ')(' + restart + ')'));
    if (!restart) {
      assert.equal(saves, 2); assert.equal(opens, 4); assert.equal(confirmations, 2); assert.equal(restored, true); assert.throws(() => getDatabase());
      assert.ok(fs.existsSync(path.join(root, service.JOURNAL)));
    } else {
      assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM works').get().n, 1);
      assert.deepEqual(getDatabase().prepare('SELECT display_name FROM canon_records ORDER BY display_name').all().map(row => row.display_name), ['Canon A', 'Canon C']);
      assert.deepEqual(getDatabase().prepare('SELECT episode_number FROM episodes ORDER BY episode_number').all().map(row => row.episode_number), [1, 3]);
      const restoredEpisodes = getDatabase().prepare('SELECT episode_number, storage_key, content_hash FROM episodes ORDER BY episode_number').all();
      assert.equal(await storage.readEpisodeByStorageKey(restoredEpisodes[0].storage_key), 'UI 원본 TXT\r\n');
      assert.equal(await storage.readEpisodeByStorageKey(restoredEpisodes[1].storage_key), 'ZIP 전용 3화 TXT\r\n');
      for (const episode of restoredEpisodes) assert.equal(service.sha256(fs.readFileSync(path.join(root, 'works', ...episode.storage_key.split('/')))), episode.content_hash);
      assert.equal(fs.existsSync(path.join(root, service.JOURNAL)), false);
      const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('before-restore-') && name.endsWith('.zip'));
      assert.equal(backups.length, 1);
      const old = service.validatePackage(path.join(root, 'backups', backups[0]), path.join(root, 'automatic-backup-check'));
      assert.equal(old.summary.workCount, 2); assert.equal(old.summary.episodeCount, 3);
      const oldDb = new (require('node:sqlite').DatabaseSync)(path.join(root, 'automatic-backup-check', service.DB_ENTRY), { readOnly: true });
      try {
        assert.deepEqual(oldDb.prepare('SELECT display_name FROM canon_records ORDER BY display_name').all().map(row => row.display_name), ['Canon A', 'Canon B']);
        assert.deepEqual(oldDb.prepare('SELECT episode_number FROM episodes WHERE work_id = (SELECT id FROM works WHERE title = ?) ORDER BY episode_number').all('대상 PC에서 수정한 작품').map(row => row.episode_number), [1, 2]);
        const targetOnly = oldDb.prepare('SELECT storage_key FROM episodes WHERE title = ?').get('대상 전용 회차');
        assert.ok(targetOnly);
        assert.equal(fs.existsSync(path.join(root, 'works', ...targetOnly.storage_key.split('/'))), false);
        assert.equal(fs.readFileSync(path.join(root, 'automatic-backup-check', 'manuscripts', ...targetOnly.storage_key.split('/')), 'utf8'), 'ZIP에는 없는 TXT\r\n');
      }
      finally { oldDb.close(); }
    }
    console.log(JSON.stringify({ result: 'PASS', temporaryRoot: root }));
    clearTimeout(timer); window.destroy(); queue.stop(); closeDatabase(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timer); window?.destroy(); queue?.stop(); closeDatabase(); app.exit(1); }
}
app.whenReady().then(run);
