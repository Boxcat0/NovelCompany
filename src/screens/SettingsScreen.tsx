import { useEffect, useRef, useState } from 'react';
import type { BackupSummary } from '../types/electron-api';

/** Main 검증 요약과 최종 확인을 통해 수동 ZIP 백업·전체 교체를 제공한다. */
function SettingsScreen({ onNavigationState }: { onNavigationState?: (dirty: boolean, busy: boolean) => void }) {
  const [current, setCurrent] = useState<{ workCount?: number; episodeCount?: number; databaseSchemaVersion?: number }>({});
  const [preview, setPreview] = useState<(BackupSummary & { token: string }) | null>(null);
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
        const result = await window.novelCompany.backup.preview();
        if (!result.ok) setError(result.error.message); else setPreview(result.data);
      } else if (preview) {
        const result = await window.novelCompany.backup.import(preview.token);
        if (!result.ok) setError(result.error.message);
        else if (result.data) { restarting = true; setMessage('복원과 자동 백업이 완료되었습니다. 프로그램을 다시 시작합니다.'); setPreview(null); }
      }
    } catch { setError('백업 요청을 처리하지 못했습니다. 프로그램 상태를 확인해 주세요.'); }
    finally { if (!restarting) { pending.current = false; setBusy(false); } }
  }

  return <section className="content-panel">
    <h1>애플리케이션 설정</h1>
    <h2>데이터 백업 및 복원</h2>
    <p>현재 데이터: 작품 {current.workCount ?? '…'}개 · 회차 {current.episodeCount ?? '…'}개 · DB Schema {current.databaseSchemaVersion ?? '…'}</p>
    <p>현재 SQLite DB와 등록된 회차 원고를 하나의 ZIP 파일로 백업합니다. 미저장 변경사항을 저장하고 검토가 끝난 뒤 실행해 주세요.</p>
    <button type="button" disabled={busy} onClick={() => { void run('export'); }}>데이터 내보내기</button>
    <p>NovelCompany 백업 ZIP을 선택하여 현재 PC의 모든 작품·Canon·원고·검토 이력을 전체 교체합니다. 기존 데이터는 복원용 ZIP으로 자동 백업됩니다.</p>
    <button type="button" disabled={busy} onClick={() => { void run('preview'); }}>데이터 가져오기</button>
    {preview && <div className="backup-preview">
      <h3>가져올 백업</h3>
      <p>생성일: {preview.createdAt} · 앱 버전: {preview.applicationVersion}</p>
      <p>작품 {preview.workCount}개 · 회차 {preview.episodeCount}개 · DB Schema {preview.databaseSchemaVersion}</p>
      <p>현재 데이터가 모두 교체됩니다. 병합하지 않습니다. 기존 데이터 자동 백업 후 교체하며 완료 시 프로그램을 재시작합니다.</p>
      <button type="button" disabled={busy} onClick={() => { void run('import'); }}>전체 교체 확인</button>
      <button type="button" disabled={busy} onClick={() => { setPreview(null); void window.novelCompany.backup.cancelPreview(); }}>가져오기 취소</button>
    </div>}
    {busy && <p role="status">{phase || '백업 요청 처리 중'}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="placeholder-message">AI Provider 설정은 이후 단계에서 구현 예정</p>
  </section>;
}
export default SettingsScreen;
