import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CanonFieldRenderer } from './DynamicCanonForm';
import type { CanonFieldDefinition, CanonFormValue, CanonImportPreview, CanonPromotionPreview, CanonRecordSummary, CanonSetDefinition, CanonStagingInput, CanonStagingRecord, CanonStagingScope, CanonStagingStatus, IpcResult, ReferenceOption } from '../types/electron-api';

const labels: Record<CanonStagingStatus, string> = { DRAFT: '초안 / 비공개 보류', NEEDS_INPUT: '입력 필요', CONFLICT: '충돌', READY: '등록 가능', PROMOTED: '등록 완료' };
/** 실패 Result의 검증된 한국어 메시지만 UI에 전달한다. */
function unwrap<T>(result: IpcResult<T>): T { if (!result.ok) throw new Error(result.error.message); return result.data; }
/** 저장된 후보를 미확정 값을 유지하는 편집 입력으로 변환한다. */
function editInput(row: CanonStagingRecord): CanonStagingInput { return { displayName: row.candidate.display_name, fields: row.candidate.fields, references: row.candidate.references, authorPrivate: row.source.author_private === true || row.candidate.author_private === true, expectedRevision: row.revision }; }

/** 기존 Canon 화면 안에서 원본 Import·임시 수정·최종 승인된 승격을 구분하여 제공한다. */
export function CanonStagingPanel({ scope, onStateChange, onOpenCanon }: { scope: CanonStagingScope; onStateChange: (dirty: boolean, busy: boolean) => void; onOpenCanon: (setId: string) => void }) {
  const [rows, setRows] = useState<CanonStagingRecord[]>([]), [definitions, setDefinitions] = useState<CanonSetDefinition[]>([]), [official, setOfficial] = useState<CanonRecordSummary[]>([]);
  const [selected, setSelected] = useState<CanonStagingRecord | null>(null), [draft, setDraft] = useState<CanonStagingInput | null>(null), [baseline, setBaseline] = useState('');
  const [checked, setChecked] = useState<string[]>([]), [links, setLinks] = useState<Record<string, string>>({});
  const [setFilter, setSetFilter] = useState('ALL'), [statusFilter, setStatusFilter] = useState('ALL'), [search, setSearch] = useState('');
  const [importPreview, setImportPreview] = useState<CanonImportPreview | null>(null), [promotionPreview, setPromotionPreview] = useState<CanonPromotionPreview | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false), sequence = useRef(0), mounted = useRef(true);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const definition = selected ? definitions.find(set => set.key === selected.setKey) : null;

  /** 요청 세대와 화면 소속이 일치하는 응답만 적용한다. */
  function active(request: number) { return mounted.current && sequence.current === request; }
  /** 최신 목록·검증·Definition·공식 선택지를 같은 응답으로 갱신한다. */
  async function load(request: number) {
    const data = unwrap(await window.novelCompany.canon.staging.list(scope));
    if (active(request)) { setRows(data.records); setDefinitions(data.definitions); setOfficial(data.officialRecords); }
  }
  /** 동기 중복 잠금과 요청 세대로 쓰기·이동·StrictMode 재실행을 보호한다. */
  async function run(action: (request: number) => Promise<void>) {
    if (pending.current) return;
    const request = ++sequence.current; pending.current = true; setBusy(true); onStateChange(dirty, true); setError(''); setMessage('');
    try { await action(request); } catch (cause) { if (active(request)) setError(cause instanceof Error ? cause.message : '등록 대기 작업을 완료하지 못했습니다.'); }
    finally { if (active(request)) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => { mounted.current = true; void run(load); return () => { mounted.current = false; sequence.current++; pending.current = false; void window.novelCompany.canon.staging.cancelPreview(); }; }, []);
  useLayoutEffect(() => { onStateChange(dirty, busy); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange(false, false), [onStateChange]);

  /** 후보·필터 이동에서 미저장 값을 버리는지 먼저 확인한다. */
  function canLeave() { return !pending.current && (!dirty || window.confirm('저장하지 않은 등록 대기 수정이 있습니다. 버리고 계속하시겠습니까?')); }
  /** 승인 미리보기와 편집 초안을 선택 이동 시 명시적으로 닫는다. */
  function clearEditor() { setSelected(null); setDraft(null); setBaseline(''); setPromotionPreview(null); }
  /** 후보 상세를 최신 revision으로 읽으며 이전 선택 응답은 사용하지 않는다. */
  async function open(row: CanonStagingRecord) {
    if (!canLeave()) return;
    clearEditor();
    await run(async request => { const next = unwrap(await window.novelCompany.canon.staging.get(scope, row.id)); if (active(request)) { const input = editInput(next); setSelected(next); setDraft(input); setBaseline(JSON.stringify(input)); await load(request); } });
  }
  /** Main 파일 선택 후 읽기 전용 미리보기만 표시하며 Import 성공으로 표시하지 않는다. */
  async function chooseFile() {
    if (!canLeave()) return; clearEditor(); setImportPreview(null);
    await run(async request => { const preview = unwrap(await window.novelCompany.canon.staging.previewImport(scope)); if (active(request)) setImportPreview(preview); });
  }
  /** 미리본 파일을 별도 승인한 뒤 Staging에만 실제 저장한다. */
  async function executeImport() {
    if (!importPreview || !window.confirm('미리본 후보를 등록 대기 저장소에 보관하시겠습니까?\n공식 Canon은 변경되지 않습니다.')) return;
    await run(async request => {
      const result = unwrap(await window.novelCompany.canon.staging.import(scope, importPreview.token, true));
      if (!active(request)) return;
      setImportPreview(null); setMessage(result.alreadyImported ? '이미 가져온 파일입니다. 후보를 중복 생성하지 않았습니다.' : `등록 대기에 ${result.createdCount}개를 저장했습니다. 기존 ${result.reusedCount}개는 유지했습니다. 공식 Canon은 변경되지 않았습니다.`); await load(request);
    });
  }
  /** 후보의 현재 확정값만 임시 저장하고 필수값 검증 결과를 다시 계산한다. */
  async function save() {
    if (!selected || !draft) return;
    await run(async request => {
      const saved = unwrap(await window.novelCompany.canon.staging.update(scope, selected.id, draft));
      if (!active(request)) return;
      const input = editInput(saved); setSelected(saved); setDraft(input); setBaseline(JSON.stringify(input)); setPromotionPreview(null); setImportPreview(null); setMessage('등록 대기 수정을 저장했습니다. 공식 Canon은 변경되지 않았습니다.'); await load(request);
    });
  }
  /** 선택한 후보와 직접 고른 공식 연결 대상을 승인 전 배치 검증에 전달한다. */
  async function previewPromotion() {
    if (dirty) return;
    await run(async request => {
      const selection = checked.map(id => ({ id, expectedRevision: rows.find(row => row.id === id)!.revision, ...(links[id] ? { existingRecordId: links[id] } : {}) }));
      const preview = unwrap(await window.novelCompany.canon.staging.previewPromotion(scope, selection)); if (active(request)) { setPromotionPreview(preview); setImportPreview(null); }
    });
  }
  /** 경고와 실제 적용 목록을 확인한 작가의 최종 승인 후에만 공식 Canon을 등록한다. */
  async function executePromotion() {
    if (!promotionPreview?.token || !promotionPreview.canExecute || dirty || !window.confirm('선택 배치를 공식 Canon에 등록하시겠습니까?\n미래 설정과 공개 범위를 직접 확인했는지 검토해 주세요. 실패하면 배치 전체가 취소됩니다.')) return;
    await run(async request => {
      const result = unwrap(await window.novelCompany.canon.staging.promote(scope, promotionPreview.token!, true));
      if (!active(request)) return;
      setPromotionPreview(null); setChecked([]); clearEditor(); setMessage(`공식 Canon 연결 ${result.entries.length}개를 완료했습니다.`); await load(request);
    });
  }
  /** 필드 종류에 따라 원본 key 기반 일반 값과 논리 참조를 따로 편집한다. */
  function changeField(field: CanonFieldDefinition, value: CanonFormValue) {
    if (!draft) return;
    const container = field.referenceSet ? 'references' : 'fields';
    const resolved = field.valueType.startsWith('OPTION') && typeof value === 'string' ? field.options.find(option => option.id === value)?.value ?? value : value;
    setDraft({ ...draft, [container]: { ...draft[container], [field.key]: resolved } }); setPromotionPreview(null);
  }
  /** 실제 공식 UUID와 Staging 논리키를 구분한 참조 선택지를 만든다. */
  function choices(field: CanonFieldDefinition): ReferenceOption[] {
    return field.referenceSet ? [
      ...official.filter(row => row.setId === field.referenceSet!.id).map(row => ({ id: 'record:' + row.id, displayName: '[공식] ' + row.displayName, disabled: false, description: null })),
      ...rows.filter(row => row.setKey === field.referenceSet!.key).map(row => ({ id: row.draftKey, displayName: '[대기] ' + row.candidate.display_name, disabled: row.source.author_private === true || row.candidate.author_private === true, description: row.draftKey })),
    ] : [];
  }
  const visible = rows.filter(row => (setFilter === 'ALL' || row.setKey === setFilter) && (statusFilter === 'ALL' || row.validation?.status === statusFilter) && row.candidate.display_name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const currentValidation = rows.find(row => row.id === selected?.id)?.validation;
  return <section className="canon-staging-panel" aria-label="등록 대기 Canon">
    <h2>등록 대기 Canon</h2><p>등록 대기의 모든 정보는 일반 검토 컨텍스트에서 제외됩니다. 등록 가능은 작가의 등록 승인을 뜻하지 않습니다.</p>
    {error && <p role="alert" className="error-message">{error}</p>}{message && <p role="status">{message}</p>}{busy && <p role="status">등록 대기 작업을 처리하는 중입니다.</p>}
    <button type="button" disabled={busy} onClick={() => void chooseFile()}>JSON 파일 선택 / 미리보기</button>
    {importPreview && <section className="staging-import-preview" aria-label="Import 미리보기"><h3>Import 미리보기 — 아직 저장하지 않았습니다</h3>
      <p>{importPreview.fileName} · {importPreview.sourceVersion} · 원본 작품: {importPreview.workTitle}</p>
      <p>총 {importPreview.total}개 · 비공개 {importPreview.privateCount}개 · 신규 {importPreview.newCount}개 · 재사용 {importPreview.reusedCount}개 · 충돌 {importPreview.conflictCount}개 · 입력/비공개 보류 {importPreview.holdCount}개 · 공식 이름 중복 {importPreview.nameConflictCount}개</p>
      <p>모든 후보는 등록 대기에만 보관합니다. 미확정 필수값과 논리 참조는 정식 등록 전에 검증합니다.</p>
      {importPreview.alreadyImported && <p>이미 처리한 SHA-256 파일입니다. 중복 후보를 생성하지 않습니다.</p>}
      <ul>{Object.entries(importPreview.counts).map(([key, count]) => <li key={key}>{definitions.find(set => set.key === key)?.name ?? key}: {count}개</li>)}</ul>
      <details><summary>필수값·논리 참조 확인 사항</summary><ul>{importPreview.items.filter(item => item.issues.length).map(item => <li key={item.draftKey}>{item.draftKey}: {item.issues.join(' ')}</li>)}</ul></details>
      {importPreview.items.some(item => item.action.startsWith('CONFLICT')) && <details><summary>충돌 변경 전/후</summary>{importPreview.items.filter(item => item.action.startsWith('CONFLICT')).map(item => <div key={item.draftKey}><p>{item.draftKey} · {item.action}</p><pre>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre></div>)}</details>}
      <button type="button" disabled={busy} onClick={() => { setImportPreview(null); void window.novelCompany.canon.staging.cancelPreview(); }}>Import 취소</button>
      <button type="button" disabled={busy || importPreview.conflictCount > 0} onClick={() => void executeImport()}>등록 대기로 Import 실행</button>
    </section>}
    <p>전체 후보 {rows.length}개 · {Object.entries(labels).map(([key, label]) => `${label} ${rows.filter(row => row.validation?.status === key).length}개`).join(' · ')}</p>
    <div className="staging-filters">
      <label>분류<select aria-label="등록 대기 분류" disabled={busy} value={setFilter} onChange={event => { if (canLeave()) { clearEditor(); setSetFilter(event.target.value); } }}><option value="ALL">전체</option>{definitions.map(set => <option key={set.id} value={set.key}>{set.name}</option>)}</select></label>
      <label>상태<select aria-label="등록 대기 상태" disabled={busy} value={statusFilter} onChange={event => { if (canLeave()) { clearEditor(); setStatusFilter(event.target.value); } }}><option value="ALL">전체</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>이름 검색<input aria-label="등록 대기 이름 검색" disabled={busy} value={search} onChange={event => { if (canLeave()) { clearEditor(); setSearch(event.target.value); } }} /></label>
    </div>
    <ul className="staging-list">{visible.map(row => <li key={row.id} data-staging-key={row.draftKey}><label><input type="checkbox" aria-label={row.draftKey + ' 등록 선택'} disabled={busy || dirty} checked={checked.includes(row.id)} onChange={event => { setChecked(previous => event.target.checked ? [...previous, row.id] : previous.filter(id => id !== row.id)); setPromotionPreview(null); }} />등록 선택</label> <button type="button" disabled={busy} onClick={() => void open(row)}>{row.candidate.display_name}</button> · {row.setKey} · {row.validation ? labels[row.validation.status] : '검증 대기'}{(row.source.author_private || row.candidate.author_private) && ' · 작가 전용 비공개'}</li>)}</ul>
    {selected && draft && <section className="staging-editor" aria-label="등록 대기 후보 편집"><h3>{selected.draftKey} · 수정 순번 {selected.revision}</h3><p>원본 이름: {selected.source.display_name} · 출처 회차: {selected.source.source_episodes?.join(', ') || '미지정'}</p>
      {currentValidation && <p>{labels[currentValidation.status]} · {currentValidation.errors.join(' ')}</p>}
      <fieldset disabled={busy || Boolean(selected.promotion)}>
        <label htmlFor="staging-name">대표명</label><input id="staging-name" value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} />
        <label><input id="staging-private" type="checkbox" checked={draft.authorPrivate} disabled={selected.source.author_private === true} onChange={event => setDraft({ ...draft, authorPrivate: event.target.checked })} />작가 전용 비공개 — V1 정식 등록 차단</label>
        {definition?.fields.map(field => {
          let value = (field.referenceSet ? draft.references : draft.fields)[field.key] ?? null;
          if (field.valueType.startsWith('OPTION') && typeof value === 'string') value = field.options.find(option => option.value === value)?.id ?? value;
          return <div className="canon-form-field" key={field.id}><label htmlFor={'staging-field-' + field.id}>{field.label}{field.required ? ' * 정식 등록 시 필수' : ' (선택)'}</label><CanonFieldRenderer field={field} idPrefix="staging-field-" value={value} options={choices(field)} onChange={next => changeField(field, next)} /></div>;
        })}
        {(['fields', 'references'] as const).map(container => Object.keys(draft[container]).filter(key => !definition?.fields.some(field => field.key === key)).map(key => <p key={container + key}>정의에 없는 {container} 값: {key} <button type="button" onClick={() => { const next = { ...draft[container] }; delete next[key]; setDraft({ ...draft, [container]: next }); }}>미지원 값 제거</button></p>))}
        <button type="button" disabled={!dirty} onClick={() => void save()}>등록 대기 임시 저장</button>
      </fieldset>
      <button type="button" disabled={busy} onClick={() => void open(selected)}>최신 후보 다시 불러오기</button>
      {dirty && <p>저장하지 않은 후보 수정이 있습니다.</p>}
      {!selected.promotion && <label>기존 공식 항목에 연결 (자동 병합하지 않음)<select aria-label="기존 공식 Canon 연결" disabled={busy || dirty} value={links[selected.id] ?? ''} onChange={event => { setLinks(previous => ({ ...previous, [selected.id]: event.target.value })); setPromotionPreview(null); }}><option value="">신규 생성</option>{official.filter(row => row.setId === definition?.id).map(row => <option value={row.id} key={row.id}>{row.displayName} · {row.id}</option>)}</select></label>}
      {selected.promotion && <p>승인 UUID: {selected.promotion.recordUuid} · 승인 순번 {selected.promotion.approvedRevision} <button type="button" disabled={busy} onClick={() => onOpenCanon(selected.promotion!.setId)}>공식 Canon으로 이동</button></p>}
      <details><summary>원본 메타데이터 / 보류 근거</summary><pre>{JSON.stringify(selected.source, null, 2)}</pre></details>
    </section>}
    <p>등록 선택 {checked.length}개</p><button type="button" disabled={busy || dirty || checked.length === 0} onClick={() => void previewPromotion()}>선택 배치 정식 등록 미리보기</button>
    {promotionPreview && <section className="staging-promotion-preview" aria-label="정식 등록 미리보기"><h3>정식 등록 미리보기 — 아직 적용하지 않았습니다</h3><p>공개할 내용과 미래 설정을 직접 확인하세요. 비공개 후보는 등록할 수 없습니다.</p>
      {promotionPreview.entries.map(entry => <div key={entry.id}><p>{entry.setKey} · {entry.displayName} · {entry.mode === 'CREATE' ? '신규 생성' : entry.mode === 'LINK' ? '기존 항목 연결' : '기존 승인 유지'} · {labels[entry.status]}{entry.recordId && ` · ${entry.recordId}`}</p><p>{entry.errors.join(' ')}</p><ul>{entry.referenceTargets?.map((target, index) => <li key={index}>{target.fieldKey}: {target.displayName ?? target.target} · {target.source === 'BATCH' ? '이번 배치에서 생성 후 연결' : target.recordId ?? '참조 미해결'}</li>)}</ul><details><summary>적용할 필드와 참조</summary><pre>{JSON.stringify({ fields: entry.fields, references: entry.references }, null, 2)}</pre></details></div>)}
      <button type="button" disabled={busy} onClick={() => { setPromotionPreview(null); void window.novelCompany.canon.staging.cancelPreview(); }}>정식 등록 취소</button>
      <button type="button" disabled={busy || dirty || !promotionPreview.canExecute} onClick={() => void executePromotion()}>전체 내용 확인 후 정식 등록 실행</button>
    </section>}
  </section>;
}
