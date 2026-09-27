import { useEffect, useRef, useState } from "react";
import type { IpcResult, StoredWork, WorkDeletionStatus } from "../types/electron-api";
import type { WorkStatus } from "../types/work";

type WorkDraft = { title: string; description: string; status: WorkStatus };
type ScreenProps = { onNavigationState?: (dirty: boolean, busy: boolean) => void };

const statusLabels: Record<WorkStatus, string> = {
  ACTIVE: "진행 중",
  PAUSED: "일시 중지",
  COMPLETED: "완결",
};

class WorkRequestError extends Error {
  /** Main이 검증한 한국어 오류만 화면에 전달하고 통신 내부 오류와 구분한다. */
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** IPC Result의 성공 데이터를 반환하거나 사용자용 오류를 보존한다. */
function readResult<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new WorkRequestError(result.error.code, result.error.message);
  return result.data;
}

/** 서버에서 받은 의존성 상태를 삭제 버튼 주변의 한국어 안내로 변환한다. */
function deletionMessage(status: WorkDeletionStatus): string {
  if (status.episodeCount > 0 && status.hasCanonSpace) return "연결된 회차와 Canon 데이터가 있어 삭제할 수 없습니다.";
  if (status.episodeCount > 0) return "연결된 회차가 있어 삭제할 수 없습니다.";
  if (status.hasCanonSpace) return "Canon 데이터가 있어 삭제할 수 없습니다.";
  return "연결된 회차와 Canon 데이터가 없어 삭제할 수 있습니다.";
}

/** 실제 작품 목록과 입력 폼을 연결하고 의존 데이터가 없는 작품만 확인 후 삭제한다. */
function WorkManagementScreen({ onNavigationState }: ScreenProps) {
  const [works, setWorks] = useState<StoredWork[]>([]);
  const [selectedWork, setSelectedWork] = useState<StoredWork | null>(null);
  const [draft, setDraft] = useState<WorkDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [deletionStatus, setDeletionStatus] = useState<WorkDeletionStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestPending = useRef(true);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;

  useEffect(() => {
    let cancelled = false;
    /** 화면 진입 때 실제 DB 목록을 조회하고 종료된 화면에는 응답을 반영하지 않는다. */
    async function loadWorks() {
      try {
        const nextWorks = readResult(await window.novelCompany.works.getAll());
        if (!cancelled) setWorks(nextWorks);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof WorkRequestError ? cause.message : "작품 목록을 불러오지 못했습니다.");
      } finally {
        if (!cancelled) { requestPending.current = false; setBusy(false); }
      }
    }
    void loadWorks();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { onNavigationState?.(dirty, busy); }, [dirty, busy, onNavigationState]);
  useEffect(() => {
    /** 창 종료 시 미저장 입력 또는 진행 중인 요청의 손실을 확인한다. */
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (dirty || busy) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty, busy]);

  /** 중복 요청을 즉시 잠그고 알려진 한국어 오류만 표시한 뒤 잠금을 해제한다. */
  async function runAction(action: () => Promise<void>) {
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (cause) { setError(cause instanceof WorkRequestError ? cause.message : "작품 정보를 처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { requestPending.current = false; setBusy(false); }
  }

  /** 작품 선택/새 작품 전환 시 미저장 입력을 폐기할지 확인한다. */
  function canDiscardChanges() {
    return !requestPending.current && (!dirty || window.confirm("저장하지 않은 변경사항이 있습니다.\n변경 내용을 버리고 이동하시겠습니까?"));
  }

  /** 저장된 작품을 선택하고 서버 값을 폼과 clean 기준점에 반영한다. */
  function acceptWork(work: StoredWork) {
    const nextDraft = { title: work.title, description: work.description, status: work.status };
    setSelectedWork(work); setDraft(nextDraft); setBaseline(JSON.stringify(nextDraft));
  }

  /** 저장/삭제 후 실제 DB 목록을 다시 읽어 화면 간 동일한 데이터 원본을 유지한다. */
  async function refreshWorks() {
    setWorks(readResult(await window.novelCompany.works.getAll()));
  }

  /** 목록 조회 실패 시 사용자가 재시도할 수 있도록 최신 목록을 요청한다. */
  async function handleRefresh() {
    await runAction(refreshWorks);
  }

  /** 기존 입력의 폐기를 확인한 뒤 기본 ACTIVE 상태의 빈 신규 폼을 연다. */
  function handleNewWork() {
    if (!canDiscardChanges()) return;
    const nextDraft: WorkDraft = { title: "", description: "", status: "ACTIVE" };
    setSelectedWork(null); setDraft(nextDraft); setBaseline(JSON.stringify(nextDraft));
    setDeletionStatus(null); setError(""); setMessage("");
  }

  /** 선택 작품의 최신 상세값과 삭제 가능 상태를 함께 읽은 뒤 폼을 채운다. */
  async function handleSelectWork(id: string) {
    if (!canDiscardChanges()) return;
    await runAction(async () => {
      const [workResult, statusResult] = await Promise.all([
        window.novelCompany.works.getById(id),
        window.novelCompany.works.getDeletionStatus(id),
      ]);
      const work = readResult(workResult);
      if (!work) throw new WorkRequestError("WORK_NOT_FOUND", "작품을 찾을 수 없습니다.");
      const status = readResult(statusResult);
      acceptWork(work); setDeletionStatus(status);
    });
  }

  /** 필수 제목을 확인하고 생성/수정 결과를 선택한 뒤 목록과 삭제 상태를 갱신한다. */
  async function handleSave() {
    if (!draft || requestPending.current) return;
    if (!draft.title.trim()) { setError("작품 제목을 입력해 주세요."); setMessage(""); return; }
    await runAction(async () => {
      const saved = readResult(selectedWork
        ? await window.novelCompany.works.update(selectedWork.id, draft)
        : await window.novelCompany.works.create(draft));
      acceptWork(saved);
      setDeletionStatus(null);
      setMessage("저장되었습니다.");
      await refreshWorks();
      setDeletionStatus(readResult(await window.novelCompany.works.getDeletionStatus(saved.id)));
    });
  }

  /** 최신 삭제 상태와 사용자 확인을 거쳐 삭제하고 실패 시 바뀐 의존성도 다시 표시한다. */
  async function handleDelete() {
    if (!selectedWork || requestPending.current) return;
    await runAction(async () => {
      const status = readResult(await window.novelCompany.works.getDeletionStatus(selectedWork.id));
      setDeletionStatus(status);
      if (!status.canDelete) { setMessage(deletionMessage(status)); return; }
      if (!window.confirm("'" + selectedWork.title + "'을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.")) return;
      const result = await window.novelCompany.works.delete(selectedWork.id);
      if (!result.ok) {
        setDeletionStatus(null);
        // 삭제 상태 조회와 실제 삭제 사이에 의존 데이터가 추가된 경우도 갱신한다.
        try {
          const latest = await window.novelCompany.works.getDeletionStatus(selectedWork.id);
          if (latest.ok) setDeletionStatus(latest.data);
        } catch { /* 원래 삭제 오류를 사용자에게 우선 전달한다. */ }
        readResult(result);
        return;
      }
      setSelectedWork(null); setDraft(null); setBaseline(""); setDeletionStatus(null);
      setMessage("삭제되었습니다.");
      await refreshWorks();
    });
  }

  return (
    <section className="content-panel work-management">
      <h1>작품 관리</h1>
      <p className="placeholder-message">작품 정보를 등록하고 수정할 수 있습니다.</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      {message && <p className="work-success-message" role="status">{message}</p>}
      {busy && <p role="status">작품 정보를 처리하는 중입니다.</p>}
      <div className="work-management-layout">
        <aside aria-label="작품 목록">
          <div className="work-management-actions">
            <button type="button" disabled={busy} onClick={handleNewWork}>+ 새 작품</button>
            <button type="button" disabled={busy} onClick={() => void handleRefresh()}>목록 새로고침</button>
          </div>
          {!busy && works.length === 0 && <p>등록된 작품이 없습니다.</p>}
          <ul className="work-list">
            {works.map((work) => (
              <li className="work-card" key={work.id}>
                <button type="button" disabled={busy} aria-current={selectedWork?.id === work.id ? "true" : undefined}
                  className={"work-card-button" + (selectedWork?.id === work.id ? " is-selected" : "")}
                  onClick={() => void handleSelectWork(work.id)}>
                  <span className="work-title">{work.title}</span>
                  <span className="work-status">{statusLabels[work.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {draft ? (
          <form className="work-management-form" noValidate onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
            <h2>{selectedWork ? "작품 정보" : "새 작품"}</h2>
            <p>{dirty ? "저장하지 않은 변경사항이 있습니다." : selectedWork ? "저장된 작품 정보입니다." : "제목을 입력해 작품을 등록하세요."}</p>
            <fieldset disabled={busy}>
              <label htmlFor="work-title">제목 *</label>
              <input id="work-title" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <label htmlFor="work-description">설명</label>
              <textarea id="work-description" rows={6} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              <label htmlFor="work-status">상태</label>
              <select id="work-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as WorkStatus })}>
                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              <div className="work-management-actions">
                <button type="submit">저장</button>
                {selectedWork && <button type="button" disabled={!deletionStatus?.canDelete} onClick={() => void handleDelete()}>삭제</button>}
              </div>
            </fieldset>
            {selectedWork && <div className="work-deletion-status" aria-live="polite">
              {deletionStatus ? <><p>{deletionMessage(deletionStatus)}</p><p>연결된 회차: {deletionStatus.episodeCount}개 · Canon 데이터: {deletionStatus.hasCanonSpace ? "있음" : "없음"}</p></> : <p>삭제 가능 여부를 아직 확인하지 못했습니다. 작품을 다시 선택해 주세요.</p>}
            </div>}
          </form>
        ) : <p className="placeholder-message">작품을 선택하거나 새 작품을 등록하세요.</p>}
      </div>
    </section>
  );
}

export default WorkManagementScreen;
