const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { executeIpcAction } = require('./ipc-action.cjs');
const { IPC_CHANNELS: C } = require('./ipc-channels.cjs');
const { RepositoryError } = require('../database/repositories/repository-error.cjs');
const staging = require('../database/repositories/canon-staging-repository.cjs');
const promotion = require('../canon/canon-promotion.cjs');
const { parseImport, MAX_BYTES, fail } = require('../canon/canon-import.cjs');

/** 창에 묶인 짧은 수명의 승인 token만 노출하고 파일 경로·선택 권한은 Main에 유지한다. */
function registerCanonStagingHandlers(ipcMain, { dialog } = {}) {
  const prepared = new Map(), watched = new Set(), generations = new Map();
  /** 창당 미리보기를 하나만 보관하고 창 종료 시 비공개 원본과 token을 폐기한다. */
  function remember(event, value) {
    const id = event.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      event.sender.once?.('destroyed', () => { prepared.delete(id); generations.delete(id); watched.delete(id); });
    }
    const token = randomUUID(); prepared.set(id, { ...value, token, expires: Date.now() + 5 * 60 * 1000 });
    return token;
  }
  /** 승인·소속·창·종류·유효기간을 모두 확인하고 미리보기 token 재사용을 제한한다. */
  function take(event, scope, token, approved, kind) {
    staging.requireScope(scope);
    const value = prepared.get(event.sender.id);
    if (approved !== true || !value || value.token !== token || value.kind !== kind || value.expires < Date.now() || value.scope.workId !== scope.workId || value.scope.canonSpaceId !== scope.canonSpaceId) fail('CANON_STAGING_APPROVAL_REQUIRED', '같은 작품의 미리보기를 다시 확인하고 최종 실행을 승인해 주세요.');
    prepared.delete(event.sender.id); return value;
  }
  /** 예상하지 못한 파일·SQL 오류의 원문과 절대 경로를 일반 IPC 로그에 남기지 않는다. */
  function register(channel, action) {
    ipcMain.handle(channel, (event, ...args) => executeIpcAction(channel, async () => {
      try { return await action(event, ...args); }
      catch (error) {
        if (error instanceof RepositoryError) throw new RepositoryError(error.code, error.message);
        fail('CANON_STAGING_OPERATION_FAILED', '등록 대기 작업을 완료하지 못했습니다. 입력과 선택 상태를 확인해 주세요.');
      }
    }));
  }
  register(C.CANON_STAGING_LIST, (_event, scope) => promotion.overview(scope));
  register(C.CANON_STAGING_GET, (_event, scope, id) => staging.get(scope, id));
  register(C.CANON_STAGING_UPDATE, (_event, scope, id, input) => staging.update(scope, id, input));
  register(C.CANON_STAGING_PREVIEW_IMPORT, async (event, scope) => {
    staging.requireScope(scope);
    const generation = (generations.get(event.sender.id) ?? 0) + 1; generations.set(event.sender.id, generation); prepared.delete(event.sender.id);
    const selection = await (dialog ?? require('electron').dialog).showOpenDialog({ title: '등록 대기 Canon JSON 선택', properties: ['openFile'], filters: [{ name: 'Canon JSON', extensions: ['json'] }] });
    if (selection.canceled || !selection.filePaths?.[0]) return null;
    const file = selection.filePaths[0], stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('CANON_IMPORT_LIMIT', '일반 JSON 파일과 4 MiB 이하 크기를 확인해 주세요.');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); let bytes;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > MAX_BYTES) fail('CANON_IMPORT_INVALID', '선택한 파일이 변경되었습니다. 다시 선택해 주세요.');
      bytes = Buffer.alloc(MAX_BYTES + 1); const size = fs.readSync(descriptor, bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, size);
    } finally { fs.closeSync(descriptor); }
    const parsed = parseImport(bytes), preview = staging.previewImport(scope, parsed);
    if (generations.get(event.sender.id) !== generation || event.sender.isDestroyed?.()) fail('CANON_STAGING_STALE_PREVIEW', '파일 선택이 변경되었거나 창이 닫혔습니다. 다시 선택해 주세요.');
    const fileName = path.basename(file);
    const token = remember(event, { kind: 'IMPORT', scope, parsed, fileName, fingerprint: preview.fingerprint });
    return { ...preview, token, fileName };
  });
  register(C.CANON_STAGING_IMPORT, (event, scope, token, approved) => {
    const value = take(event, scope, token, approved, 'IMPORT');
    return staging.importCandidates(scope, value.parsed, value.fileName, value.fingerprint);
  });
  register(C.CANON_STAGING_PREVIEW_PROMOTION, (event, scope, selection) => {
    const preview = promotion.preview(scope, selection);
    return { ...preview, token: preview.canExecute ? remember(event, { kind: 'PROMOTION', scope, selection: structuredClone(selection), fingerprint: preview.fingerprint }) : null };
  });
  register(C.CANON_STAGING_PROMOTE, (event, scope, token, approved) => {
    const value = take(event, scope, token, approved, 'PROMOTION');
    return promotion.promote(scope, value.selection, value.fingerprint);
  });
  register(C.CANON_STAGING_CANCEL_PREVIEW, (event) => { prepared.delete(event.sender.id); generations.set(event.sender.id, (generations.get(event.sender.id) ?? 0) + 1); return null; });
}
module.exports = { registerCanonStagingHandlers };
