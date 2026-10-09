import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CanonAlias, IpcResult } from '../types/electron-api';

type Props = { workId: string; recordId: string; organization: string | null; disabled: boolean; onStateChange: (dirty: boolean, busy: boolean) => void };
/** Main의 공개 오류를 통신 오류와 구분한다. */
class AliasRequestError extends Error {}

/** Alias IPC의 공개 한국어 메시지만 화면 처리로 전달한다. */
function unwrap<T>(result: IpcResult<T>): T { if (!result.ok) throw new AliasRequestError(result.error.message); return result.data; }

/** 저장된 Character 별칭만 관리하며 Character 폼 값과 비동기 조회 응답을 독립적으로 보호한다. */
export function CharacterAliasManager({ workId, recordId, organization, disabled, onStateChange }: Props) {
  const [aliases, setAliases] = useState<CanonAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const pending = useRef(false);
  const dirty = Boolean(text || editingId);
  useLayoutEffect(() => { onStateChange(dirty, writing); }, [dirty, writing, onStateChange]);

  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setAliases([]); setText(''); setEditingId(null); setError(''); setNotice('');
    /** 요청한 Character가 현재 대상일 때만 조회 결과를 반영한다. */
    async function load() {
      try { const result = unwrap(await window.novelCompany.canon.aliases.list({ workId, recordId })); if (request === sequence.current) setAliases(result); }
      catch (cause) { if (request === sequence.current) setError(cause instanceof AliasRequestError ? cause.message : '별칭을 불러오지 못했습니다.'); }
      finally { if (request === sequence.current) setLoading(false); }
    }
    void load(); return () => { sequence.current++; };
  }, [workId, recordId]);

  /** 범위를 고정한 Alias 쓰기 후 실제 목록을 다시 읽으며 Character draft는 건드리지 않는다. */
  async function write(action: () => Promise<unknown>) {
    if (disabled || loading || pending.current) return;
    pending.current = true; setWriting(true); setError(''); setNotice(''); onStateChange(dirty, true);
    const request = sequence.current;
    try {
      await action();
      const result = unwrap(await window.novelCompany.canon.aliases.list({ workId, recordId }));
      if (request !== sequence.current) return;
      setAliases(result); setText(''); setEditingId(null); setNotice('별칭이 반영되었습니다.');
    } catch (cause) { if (request === sequence.current) setError(cause instanceof AliasRequestError ? cause.message : '별칭을 처리하지 못했습니다.'); }
    finally { pending.current = false; if (request === sequence.current) setWriting(false); }
  }

  /** 추가와 수정에 같은 Character scope를 전달하고 Main의 최종 검증을 따른다. */
  function save() {
    void write(async () => unwrap(editingId ? await window.novelCompany.canon.aliases.update({ workId, recordId }, editingId, text) : await window.novelCompany.canon.aliases.create({ workId, recordId }, text)));
  }

  return <section aria-label="별칭 관리" className="canon-alias-manager">
    <h3>별칭 관리</h3>
    <p>저장된 소속: {organization ?? '미설정'}</p>
    <p>여러 캐릭터가 같은 별칭을 사용할 수 있습니다. 등록 명칭은 실제 발화 대상을 확정하지 않습니다.</p>
    {loading && <p role="status">별칭을 불러오는 중입니다.</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <fieldset disabled={disabled || loading || writing}>
      <ul>{aliases.map(alias => <li key={alias.id}><span>{alias.aliasText}</span> <button type="button" onClick={() => { setEditingId(alias.id); setText(alias.aliasText); setError(''); }}>수정</button> <button type="button" onClick={() => { if (window.confirm(`'${alias.aliasText}' 별칭을 삭제하시겠습니까?`)) void write(async () => unwrap(await window.novelCompany.canon.aliases.delete({ workId, recordId }, alias.id))); }}>삭제</button></li>)}</ul>
      {!loading && aliases.length === 0 && <p>등록된 별칭이 없습니다.</p>}
      <label htmlFor="character-alias-text">{editingId ? '별칭 수정' : '새 별칭'}</label>
      <input id="character-alias-text" maxLength={200} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
      <button type="button" onClick={save}>{editingId ? '별칭 수정 저장' : '별칭 추가'}</button>
      {dirty && <button type="button" onClick={() => { setText(''); setEditingId(null); setError(''); }}>별칭 입력 취소</button>}
    </fieldset>
  </section>;
}
