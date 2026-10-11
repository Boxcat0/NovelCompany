import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AuthorDecisionStatus, FindingDecision, FindingDecisionScope } from '../types/electron-api';

export const decisionLabels: Record<AuthorDecisionStatus, string> = { UNREVIEWED: '미검토', NEEDS_FIX: '수정 필요', REJECTED: '기각', DEFERRED: '보류', RESOLVED: '처리 완료' };

/** 선택 Finding의 판단 이력을 읽고 원본 검토와 독립적인 새 이벤트만 저장한다. */
export function FindingDecisionEditor({ scope, isCurrent, onStateChange, onSaved }: {
  scope: FindingDecisionScope; isCurrent: boolean;
  onStateChange: (dirty: boolean, busy: boolean) => void;
  onSaved: (decision: FindingDecision) => void;
}) {
  const [current, setCurrent] = useState<FindingDecision | null>(null);
  const [history, setHistory] = useState<FindingDecision[]>([]);
  const [status, setStatus] = useState<AuthorDecisionStatus>('UNREVIEWED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef(false), sequence = useRef(0), mounted = useRef(true);
  const dirty = current !== null && (status !== current.decisionStatus || note !== current.note);

  /** 최신 이력을 명시적으로 다시 읽으며 이전 선택에서 온 응답은 폐기한다. */
  async function reload() {
    if (pending.current || (dirty && !window.confirm('저장하지 않은 판단을 버리고 최신 판단을 불러오시겠습니까?'))) return;
    const request = ++sequence.current;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.novelCompany.reviews.decisions.history(scope);
      if (!mounted.current || request !== sequence.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      const latest: FindingDecision = result.data[0] ?? { findingId: scope.findingId, eventId: null, decisionStatus: 'UNREVIEWED', note: '', revision: 0, createdAt: null };
      setHistory(result.data); setCurrent(latest); setStatus(latest.decisionStatus); setNote(latest.note); onSaved(latest);
    } catch { if (mounted.current && request === sequence.current) setError('판단 이력을 불러오지 못했습니다. 다시 시도해 주세요.'); }
    finally { if (mounted.current && request === sequence.current) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; sequence.current++; }; }, []);
  useLayoutEffect(() => { onStateChange(dirty, busy); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange(false, false), [onStateChange]);

  /** 중복 제출을 즉시 막고 기대 revision이 맞을 때만 새 판단을 추가한다. */
  async function save() {
    if (pending.current || !current || !dirty || status === 'UNREVIEWED') return;
    const request = ++sequence.current;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.novelCompany.reviews.decisions.append({ ...scope, decisionStatus: status, note, expectedRevision: current.revision });
      if (!mounted.current || request !== sequence.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setCurrent(result.data); setStatus(result.data.decisionStatus); setNote(result.data.note);
      setHistory(previous => result.data.revision > (previous[0]?.revision ?? 0) ? [result.data, ...previous] : previous);
      onSaved(result.data); setMessage('작가 판단을 저장했습니다.');
    } catch { if (mounted.current && request === sequence.current) setError('판단 저장 응답을 확인하지 못했습니다. 최신 판단을 다시 불러와 주세요.'); }
    finally { if (mounted.current && request === sequence.current) { pending.current = false; setBusy(false); } }
  }

  return <section className="finding-decision-editor" aria-label="작가 판단 편집" data-decision-finding-id={scope.findingId}>
    <h4>작가 판단</h4>
    <p>현재 상태: {current ? decisionLabels[current.decisionStatus] : '불러오는 중'} · 판단 순번 {current?.revision ?? '…'}</p>
    {!isCurrent && <p>현재 입력과 일치하지 않거나 현재성을 비교할 수 없는 과거 Finding입니다. 판단은 이 검토 당시 결과에 기록됩니다.</p>}
    <p>처리 완료는 작가의 기록이며 프로그램이 해결을 검증했다는 뜻은 아닙니다. TXT와 Canon은 변경되지 않습니다.</p>
    <fieldset disabled={busy || !current}>
      <legend>판단 상태 선택</legend>
      {(Object.keys(decisionLabels) as AuthorDecisionStatus[]).filter(value => value !== 'UNREVIEWED').map(value => <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{decisionLabels[value]}</button>)}
      <label htmlFor="finding-decision-note">판단 메모 (최대 4,000자)</label>
      <textarea id="finding-decision-note" rows={4} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} />
      <button type="button" disabled={!dirty || status === 'UNREVIEWED'} onClick={() => void save()}>판단 저장</button>
    </fieldset>
    <button type="button" disabled={busy} onClick={() => void reload()}>최신 판단 다시 불러오기</button>
    {dirty && <p>저장하지 않은 작가 판단이 있습니다.</p>}
    {busy && <p role="status">작가 판단을 처리하는 중입니다.</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <details><summary>과거 판단 이력 · {history.length}건</summary><ol>{history.map(item => <li key={item.eventId}>
      순번 {item.revision} · {decisionLabels[item.decisionStatus]} · {item.createdAt && new Date(item.createdAt).toLocaleString('ko-KR')}
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.note || '메모 없음'}</p>
    </li>)}</ol></details>
  </section>;
}
