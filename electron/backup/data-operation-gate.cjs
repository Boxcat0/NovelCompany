const { RepositoryError } = require('../database/repositories/repository-error.cjs');
let active = 0;
let exclusive = false;
let phase = '';
const editors = new Map();
const listeners = new Set();

/** 모든 일반 IPC의 비동기 읽기·쓰기가 끝날 때까지 DB 교체를 막는다. */
async function withDataAccess(action) {
  if (exclusive) throw new RepositoryError('DATA_OPERATION_BUSY', '데이터 백업 또는 복원이 진행 중입니다. 완료 후 다시 시도해 주세요.');
  active++;
  try { return await action(); } finally { active--; }
}

/** 미저장 편집과 진행 중 요청을 확인하고 백업·복원의 배타 구간을 확보한다. */
function acquireDataOperation() {
  if (exclusive || active || [...editors.values()].some(state => state.dirty || state.busy)) throw new RepositoryError('DATA_OPERATION_BUSY', '미저장 변경사항이나 진행 중 작업이 있습니다. 저장하고 작업이 끝난 뒤 다시 시도해 주세요.');
  exclusive = true;
  return () => { exclusive = false; setPhase(''); };
}

/** Renderer별 편집 상태만 보관하며 파일 경로나 DB 접근 권한을 전달하지 않는다. */
function setEditorState(id, state) {
  if (state && typeof state.dirty === 'boolean' && typeof state.busy === 'boolean') editors.set(id, { dirty: state.dirty, busy: state.busy });
}
/** 종료한 창의 편집 상태를 제거한다. */
function removeEditor(id) { editors.delete(id); }
/** 실제 진행 단계가 바뀔 때 한국어 상태를 기록한다. */
function setPhase(value) { phase = value; for (const listener of listeners) listener(getOperationStatus()); }
/** 실제 단계 변경을 Main IPC에 알려 Renderer의 진행 안내를 갱신한다. */
function subscribeProgress(listener) { listeners.add(listener); return () => listeners.delete(listener); }
/** 배타 작업의 현재 실제 상태를 반환한다. */
function getOperationStatus() { return { busy: exclusive, phase }; }
module.exports = { withDataAccess, acquireDataOperation, setEditorState, removeEditor, setPhase, getOperationStatus, subscribeProgress };
