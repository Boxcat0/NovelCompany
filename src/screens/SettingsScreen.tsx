import { useEffect, useRef, useState } from 'react';
import type { BackupSummary } from '../types/electron-api';

/** Main 검증 요약과 최종 확인을 통해 수동 ZIP 백업·전체 교체를 제공한다. */
function SettingsScreen({ onNavigationState }: { onNavigationState?: (dirty: boolean, busy: boolean) => void }) {
  const [current, setCurrent] = useState<{ workCount?: number; episodeCount?: number; databaseSchemaVersion?: number }>({});
  const [preview, setPreview] = useState<(BackupSummary & { token: string }) | null>(null);
  const [mode, setMode] = useState<'overwrite' | 'update'>('overwrite');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    let mounted = true;
    /** 실제 Backend 단계와 현재 데이터 수만 화면에 반영한다. */
    async function refresh() {
      const result = await window.novelCompany.backup.status();
      if (mounted && result.ok) { if (!result.data.busy) setCurrent(result.data); setPhase(result.data.phase); }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 500);
    const unsubscribe = window.novelCompany.backup.onProgress(state => { if (mounted) setPhase(state.phase); });
    return () => { mounted = false; window.clearInterval(timer); unsubscribe(); void window.novelCompany.backup.cancelPreview(); };
  }, []);
  useEffect(() => { onNavigationState?.(false, busy); }, [busy, onNavigationState]);
  useEffect(() => {
    /** 진행 중 앱 종료가 복원 처리를 끊지 않도록 Renderer 종료를 보호한다. */
    function beforeUnload(event: BeforeUnloadEvent) { if (pending.current) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  /** 중복 요청을 즉시 막고 실제 IPC 완료·오류를 한국어로 표시한다. */
  async function run(action: 'export' | 'preview' | 'import') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    let restarting = false;
    try {
      if (action === 'export') {
        const result = await window.novelCompany.backup.export();
        if (!result.ok) setError(result.error.message);
        else if (result.data) setMessage('데이터 내보내기가 완료되었습니다.');
      } else if (action === 'preview') {
        setPreview(null);
        const result = await window.novelCompany.backup.preview(mode);
        if (!result.ok) setError(result.error.message + (mode === 'update' && result.error.code.startsWith('UPDATE_') ? ' 현재 데이터를 ZIP으로 전체 교체하려면 전체 덮어쓰기를 선택하고 ZIP을 다시 선택해 주세요.' : '')); else setPreview(result.data);
      } else if (preview) {
        const result = await window.novelCompany.backup.import(preview.token);
        if (!result.ok) {
          setError(result.error.message);
          if (result.error.code === 'UPDATE_STALE_PREVIEW') { setPreview(null); await window.novelCompany.backup.cancelPreview(); }
        }
        else if (result.data) { restarting = true; setMessage(preview.mode === 'update' ? '변경사항 업데이트와 자동 백업이 완료되었습니다. 프로그램을 다시 시작합니다.' : '복원과 자동 백업이 완료되었습니다. 프로그램을 다시 시작합니다.'); setPreview(null); }
      }
    } catch { setError('백업 요청을 처리하지 못했습니다. 프로그램 상태를 확인해 주세요.'); }
    finally { if (!restarting) { pending.current = false; setBusy(false); } }
  }

  /** 가져오기 방식을 바꾸면 이전 단회 token을 폐기한 뒤 새 ZIP 선택을 허용한다. */
  async function changeMode(next: 'overwrite' | 'update') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setPreview(null); setMode(next); setError('');
    try { await window.novelCompany.backup.cancelPreview(); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section className="content-panel">
    <h1>애플리케이션 설정</h1>
    <h2>데이터 백업 및 복원</h2>
    <p>현재 데이터: 작품 {current.workCount ?? '…'}개 · 회차 {current.episodeCount ?? '…'}개 · DB Schema {current.databaseSchemaVersion ?? '…'}</p>
    <p>현재 SQLite DB와 등록된 회차 원고를 하나의 ZIP 파일로 백업합니다. 미저장 변경사항을 저장하고 검토가 끝난 뒤 실행해 주세요.</p>
    <button type="button" disabled={busy} onClick={() => { void run('export'); }}>데이터 내보내기</button>
    <p>전체 덮어쓰기는 백업 내용으로 모두 교체합니다. 변경사항 업데이트는 같은 Work·Canon Definition과 공통 기준본을 비교하여 안전한 변경만 병합합니다. 기존 데이터는 자동 백업됩니다.</p>
    <fieldset disabled={busy}>
      <legend>가져오기 방식</legend>
      <label><input type="radio" name="backup-mode" value="overwrite" checked={mode === 'overwrite'} onChange={() => { void changeMode('overwrite'); }} /> 전체 덮어쓰기</label>
      <label><input type="radio" name="backup-mode" value="update" checked={mode === 'update'} onChange={() => { void changeMode('update'); }} /> 변경사항 업데이트</label>
    </fieldset>
    <button type="button" disabled={busy} onClick={() => { void run('preview'); }}>데이터 가져오기</button>
    {preview && <div className="backup-preview">
      <h3>{preview.mode === 'update' ? '변경사항 업데이트 미리보기' : '전체 덮어쓰기 미리보기'}</h3>
      <p>가져오기 방식: {preview.mode === 'update' ? '변경사항 업데이트' : '전체 덮어쓰기'} · 백업 파일 검증 완료 · 아직 적용되지 않았습니다.</p>
      <p>생성일: {preview.createdAt} · 앱 버전: {preview.applicationVersion}</p>
      <p>가져올 작품 {preview.workCount}개 · 가져올 회차 {preview.episodeCount}개 · DB Schema {preview.databaseSchemaVersion}{preview.sourceSchemaVersion !== preview.databaseSchemaVersion ? ` (ZIP 원본 ${preview.sourceSchemaVersion}, 격리 Migration 적용)` : ''}</p>
      {preview.mode === 'update' ? <>
        <p>자동 병합 가능: {preview.automaticCount}건 · 충돌: {preview.conflictCount}건 · 변경 없음: {preview.unchangedCount}건</p>
        {!preview.commonBaseline && <p role="alert">공통 기준본이 없어 변경 방향을 확정할 수 없습니다. 전체 덮어쓰기는 별도로 선택할 수 있습니다.</p>}
        {!!preview.conflicts?.length && <div><h4>적용을 막는 충돌 항목</h4><ul>{preview.conflicts.map(item => <li key={item.key}>
          {item.type} · {item.title}: {item.reason}<br />현재: {item.currentValue ?? '없음'} ({item.currentUpdatedAt ?? '시각 없음'}, 해시 {item.currentHash ?? '없음'})<br />ZIP: {item.incomingValue ?? '없음'} ({item.incomingUpdatedAt ?? '시각 없음'}, 해시 {item.incomingHash ?? '없음'})
        </li>)}</ul></div>}
        <p>충돌이 하나라도 있으면 부분 적용하지 않습니다. 로컬 Review 이력은 유지하며, 미리보기 이후 변경이 생기면 다시 비교해야 합니다.</p>
        <button type="button" disabled={busy || !!preview.conflictCount || !preview.automaticCount} onClick={() => { void run('import'); }}>변경사항 업데이트 실행</button>
      </> : <>
        <p>현재 PC의 작품 {current.workCount ?? '…'}개 · 회차 {current.episodeCount ?? '…'}개를 ZIP 내용으로 모두 교체합니다. 데이터 내용이 달라도 업데이트 충돌 검사는 적용하지 않습니다.</p>
        <p role="alert">주의: 현재 PC에만 있는 작품·Canon·회차·TXT는 교체 후 제거됩니다. 기존 데이터는 자동 백업하며, 최종 확인 후 적용하고 프로그램을 재시작합니다.</p>
        <button type="button" disabled={busy} onClick={() => { void run('import'); }}>전체 덮어쓰기 실행</button>
      </>}
      <button type="button" disabled={busy} onClick={() => { setPreview(null); void window.novelCompany.backup.cancelPreview(); }}>가져오기 취소</button>
    </div>}
    {busy && <p role="status">{phase || '백업 요청 처리 중'}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="placeholder-message">AI Provider 설정은 이후 단계에서 구현 예정</p>
  </section>;
}
export default SettingsScreen;
