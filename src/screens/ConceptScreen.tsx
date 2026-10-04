import { useEffect, useLayoutEffect, useRef, useState } from "react";
import DynamicCanonForm, { validateCanonForm } from "../components/DynamicCanonForm";
import type { CanonDeletionStatus, CanonRecord, CanonRecordInput, CanonRecordSummary, CanonScope, CanonSpace, CanonSet, CanonSetDefinition, CreateReadiness, IpcResult, ReferenceOption, StoredWork } from "../types/electron-api";

/** Main의 공개 한국어 오류와 통신 내부 예외를 구별한다. */
class CanonRequestError extends Error {}

/** 실패 Result의 한국어 메시지를 화면 요청 처리에 전달한다. */
function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new CanonRequestError(result.error.message);
  return result.data;
}

/** 기존 Set key를 입력 안내 그룹으로 배치하며 알려지지 않은 정의도 누락하지 않는다. */
function buildCanonAuthoringGroups(sets: CanonSet[]) {
  const groups = [
    { label: "기초 설정", keys: ["world", "attribute", "passive", "skill"] },
    { label: "공간 / 집단", keys: ["location", "organization"] },
    { label: "인물", keys: ["character"] },
    { label: "인물 확장", keys: ["authority", "servant", "contract", "relationship"] },
  ];
  const known = new Set(groups.flatMap((group) => group.keys));
  return [...groups.map((group) => ({ label: group.label, sets: group.keys.flatMap((key) => sets.filter((set) => set.key === key)) })), { label: "기타 설정", sets: sets.filter((set) => !known.has(set.key)) }].filter((group) => group.sets.length);
}

/** Backend가 반환한 부족 대상과 최소 개수만으로 등록 상태를 설명한다. */
function readinessLabel(ready?: CreateReadiness) {
  if (!ready) return "상태 확인 중";
  return ready.canCreate ? "등록 가능" : ready.blockers.map((blocker) => blocker.targetSetName + (blocker.requiredCount > 1 ? ` ${blocker.requiredCount}명` : "")).join(" · ") + " 필요";
}

/** Field 정의에 맞는 빈 폼을 만들고 boolean과 복수 선택의 기본값을 설정한다. */
function emptyInput(definition: CanonSetDefinition): CanonRecordInput {
  return { displayName: "", fieldValues: Object.fromEntries(definition.fields.map((field) => [field.id, field.valueType.endsWith("MANY") ? [] : field.valueType === "BOOLEAN" ? false : null])) };
}

/** 빈 공간과 데이터 보유 공간의 삭제 영향을 구분하여 복구 불가 및 보존 범위를 안내한다. */
function canonDeletionMessage(title: string, status: CanonDeletionStatus): string {
  const summary = status.totalDependentRowCount === 0
    ? "현재 등록된 Canon 설정 데이터는 없습니다.\nCanonSpace가 삭제되며 이후 다시 Canon을 시작할 수 있습니다."
    : `Canon Set: ${status.setCount}개\nCanon Field: ${status.fieldCount}개\nCanon Record: ${status.recordCount}개\n기타 연결·기존 Canon 데이터: ${status.totalDependentRowCount - status.setCount - status.fieldCount - status.recordCount}행\n\n연결된 Canon 데이터도 함께 삭제됩니다.`;
  return `'${title}'의 Canon 전체를 삭제하시겠습니까?\n\n${summary}\n\n작품과 회차, 원고 파일은 유지됩니다.\n이 작업은 되돌릴 수 없습니다.`;
}

/** 실제 Definition을 입력 그룹과 준비 상태로 안내하고 기존 lifecycle 및 동적 Record CRUD를 연결한다. */
function ConceptScreen({ onNavigationState }: { onNavigationState?: (dirty: boolean, busy: boolean) => void }) {
  const [works, setWorks] = useState<StoredWork[]>([]);
  const [work, setWork] = useState<StoredWork | null>(null);
  const [canonSpace, setCanonSpace] = useState<CanonSpace | null>(null);
  const [spaceLoaded, setSpaceLoaded] = useState(false);
  const [startingCanon, setStartingCanon] = useState(false);
  const [deletingCanon, setDeletingCanon] = useState(false);
  const requestPending = useRef(false);
  const [sets, setSets] = useState<CanonSet[]>([]);
  const [definition, setDefinition] = useState<CanonSetDefinition | null>(null);
  const [records, setRecords] = useState<CanonRecordSummary[]>([]);
  const [readiness, setReadiness] = useState<Record<string, CreateReadiness>>({});
  const [recordId, setRecordId] = useState<string | null>(null);
  const [input, setInput] = useState<CanonRecordInput | null>(null);
  const [baseline, setBaseline] = useState("");
  const [options, setOptions] = useState<Record<string, ReferenceOption[]>>({});
  const [actionBusy, setBusy] = useState(true);
  const [setLoading, setSetLoading] = useState(false);
  const setRequestId = useRef(0);
  const busy = actionBusy || setLoading;
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const dirty = input !== null && JSON.stringify(input) !== baseline;
  const scope = definition ? { canonSpaceId: definition.canonSpaceId, setId: definition.id } : null;

  useEffect(() => {
    mounted.current = true;
    /** 최초 작품 목록을 불러오고 화면 종료 후 상태 변경을 방지한다. */
    async function loadWorks() {
      try {
        const data = unwrap(await window.novelCompany.works.getAll());
        if (mounted.current) setWorks(data);
      } catch { if (mounted.current) setError("작품 정보를 불러오지 못했습니다."); }
      finally { if (mounted.current) setBusy(false); }
    }
    void loadWorks();
    return () => { mounted.current = false; setRequestId.current++; };
  }, []);

  // 화면의 활성 상태와 App 이동 보호 ref를 같은 commit에 맞춰 완료 직후 이동도 허용한다.
  useLayoutEffect(() => { onNavigationState?.(dirty, busy); }, [dirty, busy, onNavigationState]);
  useEffect(() => {
    /** 창 종료 시 저장 전 변경사항의 손실을 확인한다. */
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);

  /** 쓰기 중 이탈을 막고 입력 폐기를 확인하되 Set 간 읽기는 최신 요청으로 교체할 수 있게 한다. */
  function canLeave(confirmation = "저장하지 않은 변경사항이 있습니다.\n변경 내용을 버리고 이동하시겠습니까?", switchingSet = false) {
    return !requestPending.current && !actionBusy && (!setLoading || switchingSet) && (!dirty || window.confirm(confirmation));
  }

  /** 요청 중 중복 조작을 막고 IPC 실패 또는 통신 오류를 한국어로 표시한다. */
  async function runAction(action: () => Promise<void>) {
    if (requestPending.current) return;
    requestPending.current = true;
    onNavigationState?.(dirty, true);
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (cause) { setError(cause instanceof CanonRequestError ? cause.message : "설정을 처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { requestPending.current = false; if (mounted.current) setBusy(false); }
  }

  /** 모든 Set의 실제 선행조건을 읽어 상태 적용 전까지 요청별 결과로 보관한다. */
  async function readReadiness(currentSets: CanonSet[]) {
    const entries = await Promise.all(currentSets.map(async (set) => [set.id, unwrap(await window.novelCompany.canon.records.getCreateReadiness({ canonSpaceId: set.canonSpaceId, setId: set.id }))] as const));
    return Object.fromEntries(entries);
  }

  /** 쓰기 완료 후 모든 Set의 준비 상태를 갱신하여 다음 입력 단계가 즉시 열리게 한다. */
  async function refreshReadiness(currentSets: CanonSet[]) {
    const next = await readReadiness(currentSets);
    if (mounted.current) setReadiness(next);
  }

  /** 선택 작품의 CanonSpace와 정의 목록을 조회하고 이전 편집 상태를 비운다. */
  async function handleSelectWork(nextWork: StoredWork) {
    if (!canLeave()) return;
    await runAction(async () => {
      setWork(nextWork);
      await loadCanonForWork(nextWork.id);
    });
  }

  /** 이전 Canon의 선택/폼/참조 ID를 모두 비워 삭제 후 오래된 데이터로 요청하지 않게 한다. */
  function resetCanonEditor() {
    setRequestId.current++; setSetLoading(false);
    setCanonSpace(null); setSpaceLoaded(false); setSets([]); setDefinition(null);
    setRecords([]); setReadiness({}); setRecordId(null); setInput(null); setBaseline(""); setOptions({});
  }

  /** 편집 상태를 초기화하고 공간과 Set을 다시 읽으며 조회 실패를 Canon 없음으로 오인하지 않게 한다. */
  async function loadCanonForWork(workId: string) {
    resetCanonEditor();
    const space = unwrap(await window.novelCompany.canon.spaces.getByWorkId(workId));
    const nextSets = space ? unwrap(await window.novelCompany.canon.sets.getByCanonSpaceId(space.id)) : [];
    await refreshReadiness(nextSets);
    setCanonSpace(space); setSets(nextSets); setSpaceLoaded(true);
  }

  /** 작가 확인 후 빈 공간만 생성하고 동일 작품의 최신 공간과 Set을 다시 조회한다. */
  async function handleStartCanon() {
    if (!work || !spaceLoaded || canonSpace || busy || requestPending.current) return;
    if (!window.confirm("'" + work.title + "'의 Canon을 시작하시겠습니까?\n\n빈 CanonSpace가 생성됩니다. Canon Set은 이후 직접 구성할 수 있습니다.")) return;
    await runAction(async () => {
      setStartingCanon(true);
      try {
        const result = await window.novelCompany.canon.spaces.createForWork(work.id);
        if (!result.ok && result.error.code === "CANON_SPACE_ALREADY_EXISTS") await loadCanonForWork(work.id);
        unwrap(result);
        await loadCanonForWork(work.id);
        setMessage("Canon이 시작되었습니다.");
      } finally { setStartingCanon(false); }
    });
  }

  /** dirty 확인 뒤 최신 삭제 영향을 조회하고 명시적 확인을 거쳐 Canon만 삭제·재조회한다. */
  async function handleDeleteCanon() {
    if (!work || !canonSpace || !spaceLoaded || !canLeave("저장하지 않은 변경사항이 있습니다.\n변경 내용을 버리고 Canon 전체 삭제를 계속하시겠습니까?")) return;
    await runAction(async () => {
      setDeletingCanon(true);
      try {
        const status = unwrap(await window.novelCompany.canon.spaces.getDeletionStatus(work.id));
        if (!status.exists) {
          await loadCanonForWork(work.id);
          throw new CanonRequestError("이 작품에는 삭제할 Canon이 없습니다.");
        }
        if (!window.confirm(canonDeletionMessage(work.title, status))) return;
        if (status.totalDependentRowCount > 0 && !window.confirm("'" + work.title + "'의 Canon 전체를 정말 삭제하시겠습니까?\n\n삭제 후 복구할 수 없습니다.")) return;
        const result = await window.novelCompany.canon.spaces.deleteForWork(work.id);
        if (!result.ok && result.error.code === "CANON_SPACE_NOT_FOUND") await loadCanonForWork(work.id);
        unwrap(result);
        await loadCanonForWork(work.id);
        setMessage("Canon이 삭제되었습니다.");
      } finally { setDeletingCanon(false); }
    });
  }
  /** Set 선택 시 폼을 비우고 정의/레코드/준비 상태의 최신 요청만 적용한다. */
  async function handleSelectSet(set: CanonSet) {
    if (!canLeave(undefined, true)) return;
    const requestId = ++setRequestId.current;
    setSetLoading(true); onNavigationState?.(false, true);
    setInput(null); setDefinition(null); setRecords([]); setRecordId(null); setOptions({}); setBaseline(""); setError(""); setMessage("");
    try {
      const nextScope = { canonSpaceId: set.canonSpaceId, setId: set.id };
      const [nextDefinition, nextRecords, nextReadiness] = await Promise.all([window.novelCompany.canon.sets.getDefinition(set.id), window.novelCompany.canon.records.getBySetId(nextScope), readReadiness(sets)]);
      if (!mounted.current || requestId !== setRequestId.current) return;
      setDefinition(unwrap(nextDefinition)); setRecords(unwrap(nextRecords)); setReadiness(nextReadiness);
    } catch (cause) {
      if (mounted.current && requestId === setRequestId.current) setError(cause instanceof CanonRequestError ? cause.message : "설정 분류를 불러오지 못했습니다.");
    } finally { if (mounted.current && requestId === setRequestId.current) setSetLoading(false); }
  }

  /** 부족한 참조 분류로 같은 작품 안에서 이동하며 기존 dirty 확인을 재사용한다. */
  function handleNavigateDependency(setId: string) {
    const target = sets.find((set) => set.id === setId);
    if (target) void handleSelectSet(target);
  }

  /** 참조 Field마다 실제 대상 및 고유 패시브 점유 상태를 조회한다. */
  async function loadReferenceOptions(currentDefinition: CanonSetDefinition, currentScope: CanonScope, id: string | null) {
    const entries = await Promise.all(currentDefinition.fields.filter((field) => field.referenceSet).map(async (field) => [field.id, unwrap(await window.novelCompany.canon.records.getReferenceOptions(currentScope, field.id, id))] as const));
    setOptions(Object.fromEntries(entries));
  }

  /** 새 폼 또는 기존 레코드를 열고 읽은 값으로 dirty 기준점을 설정한다. */
  async function handleOpenRecord(id: string | null) {
    if (!canLeave() || !definition || !scope) return;
    await runAction(async () => {
      if (id === null) {
        const ready = unwrap(await window.novelCompany.canon.records.getCreateReadiness(scope));
        setReadiness((previous) => ({ ...previous, [scope.setId]: ready }));
        if (!ready.canCreate) { setMessage("등록에 필요한 선행 설정을 먼저 등록해 주세요."); return; }
      }
      const record = id ? unwrap(await window.novelCompany.canon.records.getById(scope, id)) : null;
      await loadReferenceOptions(definition, scope, id);
      const nextInput = record ? { displayName: record.displayName, fieldValues: record.fieldValues } : emptyInput(definition);
      setRecordId(id); setInput(nextInput); setBaseline(JSON.stringify(nextInput));
    });
  }

  /** 저장된 DTO를 폼과 clean 기준점에 반영한다. */
  function acceptRecord(record: CanonRecord) {
    const nextInput = { displayName: record.displayName, fieldValues: record.fieldValues };
    setRecordId(record.id); setInput(nextInput); setBaseline(JSON.stringify(nextInput));
  }

  /** 기존 Skill의 저장 전 미설정 여부를 기준으로 신규/기존 필수 정책을 구분한다. */
  function legacySkillMissing() {
    if (!recordId || definition?.key !== 'skill' || !baseline) return false;
    const field = definition.fields.find(item => item.key === 'required_attribute');
    return Boolean(field && JSON.parse(baseline).fieldValues[field.id] === null);
  }

  /** 저장 입력을 검증하고 생성/수정 후 목록, 선택, 참조 및 선행조건을 갱신한다. */
  async function handleSave() {
    if (busy || !input || !scope || !definition) return;
    const validation = validateCanonForm(definition, input, legacySkillMissing());
    if (validation) { setError(validation); return; }
    await runAction(async () => {
      const saved = unwrap(recordId ? await window.novelCompany.canon.records.update(scope, recordId, input) : await window.novelCompany.canon.records.create(scope, input));
      acceptRecord(saved); setMessage("저장되었습니다.");
      setRecords(unwrap(await window.novelCompany.canon.records.getBySetId(scope)));
      await refreshReadiness(sets);
      await loadReferenceOptions(definition, scope, saved.id);
    });
  }

  /** 삭제를 명시적으로 확인하고 참조 보호 결과를 표시한 뒤 화면을 갱신한다. */
  async function handleDelete() {
    if (busy || !scope || !recordId || !input || !window.confirm("'" + input.displayName + "' 항목을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.")) return;
    await runAction(async () => {
      unwrap(await window.novelCompany.canon.records.delete(scope, recordId));
      setInput(null); setRecordId(null); setMessage("삭제되었습니다.");
      setRecords(unwrap(await window.novelCompany.canon.records.getBySetId(scope)));
      await refreshReadiness(sets);
    });
  }

  return <section className="content-panel">
    <p className="section-label">{work?.title ?? "작품 선택"}</p><h1>컨셉정리</h1>
    {error && <p className="error-message" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">{deletingCanon ? "Canon 삭제 정보를 확인하거나 삭제하는 중입니다." : startingCanon ? "Canon을 생성하는 중입니다." : "불러오거나 처리하는 중입니다."}</p>}
    {!work ? <ul className="work-list">{works.map((item) => <li className="work-card" key={item.id}><button disabled={busy} className="work-card-button" onClick={() => void handleSelectWork(item)}>{item.title}</button></li>)}{!busy && works.length === 0 && <li>등록된 작품이 없습니다.</li>}</ul> : <>
      <button disabled={busy} className="back-button" onClick={() => { if (canLeave()) { setWork(null); setDefinition(null); setInput(null); setError(""); setMessage(""); } }}>← 작품 선택</button>
      {spaceLoaded && !canonSpace && <div className="work-card canon-empty-state">
        <h2>아직 이 작품의 Canon 설정이 없습니다.</h2>
        <p>Canon을 시작하면 이 작품만의 설정 구조를 만들 수 있습니다.</p>
        <button disabled={busy} onClick={() => void handleStartCanon()}>Canon 시작</button>
      </div>}
      {spaceLoaded && canonSpace && sets.length === 0 && <div className="work-card canon-empty-state">
        <h2>아직 등록된 Canon Set이 없습니다.</h2>
        <p>입력에 필요한 설정 구조가 없습니다. 현재는 기존 구조가 있는 작품에서 항목을 등록할 수 있습니다. 구조 편집과 복사는 후속 기능입니다.</p>
      </div>}
      {spaceLoaded && canonSpace && sets.length > 0 && <div className="canon-manager">
        <nav aria-label="설정 분류">{buildCanonAuthoringGroups(sets).map((group) => <section className="canon-authoring-group" key={group.label}><h3>{group.label}</h3>{group.sets.map((set) => <button key={set.id} disabled={actionBusy} className={"concept-set-button" + (definition?.id === set.id ? " is-selected" : "")} onClick={() => void handleSelectSet(set)}><span>{set.name}</span><small>{readinessLabel(readiness[set.id])}</small></button>)}</section>)}</nav>
        <div className="canon-record-list">
          {definition ? <><h2>{definition.name}</h2><button disabled={busy || !readiness[definition.id]?.canCreate} onClick={() => void handleOpenRecord(null)}>+ 새 항목</button>
            {readiness[definition.id]?.blockers.length > 0 && <div className="canon-readiness" role="status"><p>{definition.name} 등록에 필요한 선행 설정입니다.</p><ul>{readiness[definition.id].blockers.map((blocker) => <li key={blocker.targetSetId}>{blocker.targetSetName}: {blocker.currentCount} / 최소 {blocker.requiredCount}개 <button disabled={busy} onClick={() => handleNavigateDependency(blocker.targetSetId)}>{blocker.targetSetName} 입력으로 이동</button></li>)}</ul></div>}
            {records.length === 0 && <p>등록된 항목이 없습니다.</p>}
            {records.map((record) => <button className={"concept-set-button" + (record.id === recordId ? " is-selected" : "")} key={record.id} disabled={busy} onClick={() => void handleOpenRecord(record.id)}>{record.displayName}{record.requiredAttributeMissing && ' · 필요 속성 미설정'}</button>)}
          </> : <p>왼쪽에서 설정 분류를 선택하세요.</p>}
        </div>
        <div>
          {definition && <details className="canon-definition"><summary>구조 보기</summary><p>{definition.recordNameLabel}</p>{definition.fields.map((field) => <dl key={field.id}><dt>{field.label}{field.required ? " (필수)" : " (선택)"}</dt><dd>{field.valueType} · {field.inputControl}{field.referenceSet ? " · " + field.referenceSet.name + " 참조" : ""}{field.options.length ? " · " + field.options.map((option) => option.label).join(", ") : ""}</dd></dl>)}</details>}
          {definition && input ? <DynamicCanonForm definition={definition} input={input} options={options} busy={busy} editing={recordId !== null} dirty={dirty} allowLegacySkillMissing={legacySkillMissing()} onChange={setInput} onSave={() => void handleSave()} onDelete={() => void handleDelete()} onNavigateReference={handleNavigateDependency} /> : definition && <p>항목을 선택하거나 새 항목을 등록하세요.</p>}
        </div>
      </div>}
      {spaceLoaded && canonSpace && <section className="canon-danger-zone" aria-label="Canon 전체 삭제 관리">
        <h2>Canon 관리</h2>
        <p>이 작업은 이 작품의 Canon 설정 구조와 등록된 데이터 전체를 삭제합니다. 삭제 후 복구할 수 없습니다.</p>
        <p>작품과 회차, 원고 파일은 유지됩니다.</p>
        <button className="danger-button" disabled={busy} onClick={() => void handleDeleteCanon()}>Canon 전체 삭제</button>
      </section>}
    </>}
  </section>;
}

export default ConceptScreen;
