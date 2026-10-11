const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { getDataRoot } = require('../storage/storage-paths.cjs');
const { getDatabase } = require('../database/database.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const { executeIpcAction } = require('./ipc-action.cjs');
const gate = require('../backup/data-operation-gate.cjs');
const service = require('../backup/data-backup-service.cjs');
const { logIpcError } = require('../logging/logger.cjs');
const registered = new WeakSet();

/** Main 파일 선택·단회 token·최종 확인으로 백업과 복원 IPC를 등록한다. */
function registerBackupHandlers(ipcMain, options) {
  if (registered.has(ipcMain)) return;
  registered.add(ipcMain);
  const { dialog, queue, applicationVersion, onRestored, onFatal } = options;
  const root = options.dataRoot ?? getDataRoot();
  const pending = new Map();
  let currentSender;
  /** 실제 단계 변경만 요청한 창에 전달하며 파일 경로나 백분율을 보내지 않는다. */
  gate.subscribeProgress(state => {
    // 표시용 event 실패가 검증한 데이터 작업의 성공/실패를 바꾸지 않도록 보호한다.
    try { if (currentSender && !currentSender.isDestroyed()) currentSender.send('backup:progress', state); } catch { /* 종료한 Renderer는 진행 알림을 받을 수 없다. */ }
  });
  /** 창이 닫히거나 새 파일을 선택하면 그 창의 이전 프리뷰 임시 파일을 정리한다. */
  function discard(id) {
    const old = pending.get(id);
    if (old) { fs.rmSync(old.directory, { recursive: true, force: true }); pending.delete(id); }
  }
  /** Renderer가 임의 경로·옵션을 넘기는 요청은 거부한다. */
  function noArguments(args) {
    if (args.length) throw new RepositoryError('BACKUP_INPUT_INVALID', '파일 선택은 프로그램의 파일 선택 창을 사용해 주세요.');
  }
  /** 배타 gate 확보 후 Review 상태를 확인하고 완료 시 gate를 반환한다. */
  async function exclusive(event, action) {
    const release = gate.acquireDataOperation();
    currentSender = event.sender;
    let hold = false;
    try { service.assertQueueIdle(queue); const result = await action(); hold = result?.restartRequired === true; return result; }
    catch (error) { hold = ['RESTORE_RECOVERY_FAILED', 'RESTORE_RESTART_REQUIRED'].includes(error.code); throw error; }
    finally { if (!hold) { release(); currentSender = undefined; } else gate.setPhase('앱 재시작 대기 중'); }
  }
  ipcMain.on('backup:editor-state', (event, state) => {
    gate.setEditorState(event.sender.id, state);
    if (!event.sender.__backupEditorObserved) {
      event.sender.__backupEditorObserved = true;
      event.sender.once('destroyed', () => { gate.removeEditor(event.sender.id); discard(event.sender.id); });
    }
  });
  ipcMain.handle('backup:status', (_event, ...args) => executeIpcAction('backup:status', () => {
    noArguments(args);
    const state = gate.getOperationStatus();
    if (state.busy) return state;
    const db = getDatabase();
    return { ...state, workCount: db.prepare('SELECT COUNT(*) AS count FROM works').get().count, episodeCount: db.prepare('SELECT COUNT(*) AS count FROM episodes').get().count, databaseSchemaVersion: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version };
  }));
  ipcMain.handle('backup:export', (event, ...args) => executeIpcAction('backup:export', () => exclusive(event, async () => {
    noArguments(args); gate.setPhase('백업 저장 위치 선택 중');
    const selected = await dialog.showSaveDialog({ title: '데이터 내보내기', defaultPath: 'NovelCompany-' + new Date().toISOString().slice(0, 10) + '.zip', filters: [{ name: 'NovelCompany 백업 ZIP', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePath) return null;
    // 기존 파일은 새 이름을 요구한다. OS overwrite 확인과 상관없이 데이터 보존을 우선한다.
    return service.exportSnapshot(root, selected.filePath, applicationVersion);
  })));
  ipcMain.handle('backup:preview', (event, ...args) => executeIpcAction('backup:preview', () => exclusive(event, async () => {
    noArguments(args); discard(event.sender.id); gate.setPhase('가져올 백업 선택 중');
    const selected = await dialog.showOpenDialog({ title: '데이터 가져오기', properties: ['openFile'], filters: [{ name: 'NovelCompany 백업 ZIP', extensions: ['zip'] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    gate.setPhase('백업 구조·해시·DB 검증 중');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelcompany-import-'));
    try {
      const source = selected.filePaths[0];
      if (fs.statSync(source).size > require('../backup/backup-zip.cjs').LIMITS.archive) throw new RepositoryError('BACKUP_INVALID', '백업 ZIP 크기 제한을 초과했습니다.');
      const file = path.join(directory, 'backup.zip'); fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
      const validated = service.validatePackage(file, path.join(directory, 'validated'));
      const token = randomUUID(); pending.set(event.sender.id, { directory, file, token, summary: service.publicSummary(validated) });
      return { ...service.publicSummary(validated), token };
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  })));
  ipcMain.handle('backup:cancel-preview', (event, ...args) => executeIpcAction('backup:cancel-preview', () => { noArguments(args); discard(event.sender.id); return null; }));
  ipcMain.handle('backup:import', (event, token, ...args) => executeIpcAction('backup:import', () => exclusive(event, async () => {
    noArguments(args);
    const prepared = pending.get(event.sender.id);
    if (!prepared || typeof token !== 'string' || token !== prepared.token) throw new RepositoryError('BACKUP_INPUT_INVALID', '검증한 백업을 다시 선택해 주세요.');
    gate.setPhase('전체 교체 최종 확인 대기 중');
    const summary = prepared.summary;
    const confirmation = await dialog.showMessageBox({ type: 'warning', title: '현재 데이터 전체 교체', message: '현재 PC의 모든 작품·Canon·원고·검토 이력을 백업의 내용으로 교체합니다.', detail: `백업 생성일: ${summary.createdAt}\n작품: ${summary.workCount}개 / 회차: ${summary.episodeCount}개\nDB Schema: ${summary.databaseSchemaVersion}\n기존 데이터 자동 백업에 성공한 후에만 교체합니다. 병합하지 않습니다. 완료 후 앱을 재시작합니다.`, buttons: ['취소', '전체 교체 및 재시작'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirmation.response !== 1) return null;
    try {
      const result = service.replaceData(root, prepared.file, applicationVersion, { stopWorker: () => queue.stop(), restartWorker: () => queue.restart() });
      // 완료한 데이터 교체는 선택 파일 정리 오류로 실패 처리하거나 잠금을 풀지 않는다.
      try { discard(event.sender.id); } catch (cause) { logIpcError({ channel: 'backup:import', code: 'BACKUP_CLEANUP_FAILED', message: '복원은 완료했으나 선택 파일 정리를 완료하지 못했습니다.', cause }); }
      try { onRestored(); } catch { throw new RepositoryError('RESTORE_RESTART_REQUIRED', '복원은 완료했습니다. 안전하게 연결하려면 프로그램을 종료하고 다시 시작해 주세요.'); }
      return result;
    } catch (error) { if (['RESTORE_RECOVERY_FAILED', 'RESTORE_RESTART_REQUIRED'].includes(error.code)) onFatal(); throw error; }
  })));
}
module.exports = { registerBackupHandlers };
