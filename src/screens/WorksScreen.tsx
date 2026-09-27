import { useEffect, useRef, useState } from "react";
import type { EpisodeStatus } from "../types/episode";
import type { IpcResult, StoredEpisode, StoredWork } from "../types/electron-api";

const episodeStatusLabels: Record<EpisodeStatus, string> = { DRAFT: "초안", IN_PROGRESS: "작성 중", COMPLETED: "완료" };
const workStatusLabels = { ACTIVE: "진행 중", PAUSED: "일시 중지", COMPLETED: "완결" };
type EpisodeDraft = { episodeNumber: string; title: string; status: EpisodeStatus; content: string };

/** Main이 검증한 한국어 오류만 통신 자체의 오류와 구별하여 표시한다. */
class EpisodeRequestError extends Error {}

/** IPC 실패를 화면 처리로 전달하고 성공 DTO만 반환한다. */
function readResult<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new EpisodeRequestError(result.error.message);
  return result.data;
}

/** 저장된 metadata와 TXT를 편집용 draft로 만들며 원고 공백/줄바꿈은 변경하지 않는다. */
function episodeDraft(episode: StoredEpisode, content: string): EpisodeDraft {
  return { episodeNumber: String(episode.episodeNumber), title: episode.title, status: episode.status, content };
}

/** 기존 작품/회차 탐색을 유지하면서 명시적 metadata/TXT 저장과 삭제를 제공한다. */
function WorksScreen({ onNavigationState }: { onNavigationState?: (dirty: boolean, busy: boolean) => void }) {
  const [works, setWorks] = useState<StoredWork[]>([]);
  const [selectedWork, setSelectedWork] = useState<StoredWork | null>(null);
  const [episodes, setEpisodes] = useState<StoredEpisode[]>([]);
  const [selectedEpisode, setSelectedEpisode] = useState<StoredEpisode | null>(null);
  const [draft, setDraft] = useState<EpisodeDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [contentMissing, setContentMissing] = useState(false);
  const [readBlocked, setReadBlocked] = useState(false);
  const [worksLoading, setWorksLoading] = useState(true);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestPending = useRef(false);
  const contentRequestIdRef = useRef(0);
  const listRequestIdRef = useRef(0);
  const mounted = useRef(true);
  const dirty = draft !== null && (contentMissing || JSON.stringify(draft) !== baseline);
  const busy = worksLoading || episodesLoading || contentLoading || saving;

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    /** 화면 진입 시 실제 Work 목록을 읽으며 종료된 화면에는 응답을 적용하지 않는다. */
    async function loadWorks() {
      try { const items = readResult(await window.novelCompany.works.getAll()); if (!cancelled) setWorks(items); }
      catch { if (!cancelled) setError("작품 정보를 불러오지 못했습니다."); }
      finally { if (!cancelled) setWorksLoading(false); }
    }
    void loadWorks();
    return () => { cancelled = true; mounted.current = false; contentRequestIdRef.current++; listRequestIdRef.current++; };
  }, []);
  useEffect(() => { onNavigationState?.(dirty, busy); }, [dirty, busy, onNavigationState]);
  useEffect(() => {
    /** 창 종료 시 미저장 입력과 진행 중 저장을 보호한다. */
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || busy || requestPending.current) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);

  /** 쓰기 중 이동을 막고 새 회차/작품/회차 전환 및 삭제 전에 입력 폐기를 확인한다. */
  function canDiscardChanges() {
    return !requestPending.current && (!dirty || window.confirm("저장하지 않은 변경사항이 있습니다.\n변경 내용을 버리고 계속하시겠습니까?"));
  }

  /** 이전 TXT 요청을 무효화하고 선택/폼/복구 상태를 모두 초기화한다. */
  function resetEditor() {
    contentRequestIdRef.current++; setSelectedEpisode(null); setDraft(null); setBaseline("");
    setContentMissing(false); setReadBlocked(false); setContentLoading(false);
  }

  /** 현재 요청 순서와 일치하는 작품의 목록만 적용하여 늦은 응답 덮어쓰기를 막는다. */
  async function loadEpisodes(workId: string) {
    const requestId = ++listRequestIdRef.current;
    setEpisodesLoading(true);
    try {
      const items = readResult(await window.novelCompany.episodes.getByWorkId(workId));
      if (mounted.current && requestId === listRequestIdRef.current) setEpisodes(items);
    } catch (cause) { if (mounted.current && requestId === listRequestIdRef.current) setError(cause instanceof EpisodeRequestError ? cause.message : "회차 목록을 불러오지 못했습니다."); }
    finally { if (mounted.current && requestId === listRequestIdRef.current) setEpisodesLoading(false); }
  }

  /** 작품을 선택하고 기존 회차 ID/본문을 비운 뒤 DB 목록을 읽는다. */
  async function handleSelectWork(work: StoredWork) {
    if (!canDiscardChanges()) return;
    resetEditor(); setSelectedWork(work); setEpisodes([]); setError(""); setMessage("");
    await loadEpisodes(work.id);
  }

  /** 현재 선택된 회차의 metadata/TXT만 hydrate하고 missing과 일반 읽기 오류를 구분한다. */
  async function handleSelectEpisode(episode: StoredEpisode) {
    if (!canDiscardChanges() || !selectedWork) return;
    resetEditor(); setError(""); setMessage(""); setSelectedEpisode(episode); setContentLoading(true);
    const requestId = ++contentRequestIdRef.current;
    try {
      const [metadata, content] = await Promise.all([window.novelCompany.episodes.getById(episode.id), window.novelCompany.episodes.readContent(episode.id)]);
      if (!mounted.current || requestId !== contentRequestIdRef.current) return;
      const current = readResult(metadata);
      if (!current || current.workId !== selectedWork.id) throw new EpisodeRequestError("에피소드를 찾을 수 없습니다.");
      const missing = !content.ok && content.error.code === "EPISODE_CONTENT_NOT_FOUND";
      if (!content.ok && !missing) { setReadBlocked(true); throw new EpisodeRequestError(content.error.message); }
      const next = episodeDraft(current, content.ok ? content.data : "");
      setSelectedEpisode(current); setDraft(next); setBaseline(JSON.stringify(next)); setContentMissing(missing);
    } catch (cause) { if (mounted.current && requestId === contentRequestIdRef.current) { setReadBlocked(true); setError(cause instanceof EpisodeRequestError ? cause.message : "원고를 불러오지 못했습니다."); } }
    finally { if (mounted.current && requestId === contentRequestIdRef.current) setContentLoading(false); }
  }

  /** INSERT 없이 현재 DB의 가장 작은 빈 번호를 읽어 미저장 새 회차 폼만 연다. */
  async function handleNewEpisode() {
    if (!selectedWork || !canDiscardChanges()) return;
    resetEditor(); setError(""); setMessage(""); setContentLoading(true);
    const requestId = ++contentRequestIdRef.current;
    try {
      const number = readResult(await window.novelCompany.episodes.getNextAvailableNumber(selectedWork.id));
      if (!mounted.current || requestId !== contentRequestIdRef.current) return;
      const next: EpisodeDraft = { episodeNumber: String(number), title: "", status: "DRAFT", content: "" };
      setDraft(next); setBaseline(JSON.stringify(next));
    } catch (cause) { if (mounted.current && requestId === contentRequestIdRef.current) setError(cause instanceof EpisodeRequestError ? cause.message : "새 회차를 준비하지 못했습니다."); }
    finally { if (mounted.current && requestId === contentRequestIdRef.current) setContentLoading(false); }
  }

  /** 저장/삭제를 ref로 즉시 잠그고 Main 오류와 통신 오류를 구분하여 한국어로 표시한다. */
  async function runWrite(action: () => Promise<void>) {
    if (requestPending.current) return;
    requestPending.current = true; setSaving(true); setError(""); setMessage(""); onNavigationState?.(dirty, true);
    try { await action(); }
    catch (cause) { setError(cause instanceof EpisodeRequestError ? cause.message : "회차 작업을 처리하지 못했습니다. 다시 시도해 주세요."); }
    finally { requestPending.current = false; if (mounted.current) setSaving(false); }
  }

  /** metadata와 원고를 한 IPC로 저장한 뒤 선택/목록/baseline을 저장 결과로 갱신한다. */
  async function handleSave() {
    if (!draft || !selectedWork || busy || readBlocked || requestPending.current) return;
    if (!/^\d+$/.test(draft.episodeNumber) || !Number.isSafeInteger(Number(draft.episodeNumber)) || Number(draft.episodeNumber) < 1) { setError("회차 번호는 1 이상의 정수여야 합니다."); return; }
    if (!draft.title.trim()) { setError("에피소드 제목을 입력해 주세요."); return; }
    await runWrite(async () => {
      const input = { ...draft, episodeNumber: Number(draft.episodeNumber), workId: selectedWork.id };
      const saved = readResult(selectedEpisode ? await window.novelCompany.episodes.update(selectedEpisode.id, input) : await window.novelCompany.episodes.create(input));
      const next = episodeDraft(saved, draft.content);
      setSelectedEpisode(saved); setDraft(next); setBaseline(JSON.stringify(next)); setContentMissing(false);
      await loadEpisodes(selectedWork.id); setMessage("저장되었습니다.");
    });
  }

  /** dirty 폐기 후 저장된 회차 이름으로 확인하고 metadata/TXT 통합 삭제 뒤 선택을 비운다. */
  async function handleDeleteEpisode() {
    if (!selectedEpisode || !selectedWork || busy || !canDiscardChanges()) return;
    if (!window.confirm(`'${selectedEpisode.episodeNumber}화 - ${selectedEpisode.title}' 회차를 삭제하시겠습니까?\n\n회차 정보와 원고 TXT가 함께 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`)) return;
    await runWrite(async () => {
      readResult(await window.novelCompany.episodes.delete(selectedEpisode.id, selectedWork.id));
      resetEditor(); await loadEpisodes(selectedWork.id); setMessage("삭제되었습니다.");
    });
  }

  /** dirty 폐기를 확인하고 목록/원고 요청을 무효화하여 작품 목록으로 돌아간다. */
  function handleBackToWorks() {
    if (!canDiscardChanges()) return;
    listRequestIdRef.current++; resetEditor(); setSelectedWork(null); setEpisodes([]); setEpisodesLoading(false); setError(""); setMessage("");
  }

  return <section className="content-panel episode-management">
    <h1>작품/회차</h1>
    {error && <p className="error-message" role="alert">{error}</p>}
    {message && <p className="work-success-message" role="status">{message}</p>}
    {busy && <p role="status">{saving ? "회차와 원고를 처리하는 중입니다." : "불러오는 중입니다."}</p>}
    {!selectedWork ? <ul className="work-list">{works.map((work) => <li className="work-card" key={work.id}><button className="work-card-button" disabled={saving} onClick={() => void handleSelectWork(work)}><span className="work-card-header"><span className="work-title">{work.title}</span><span className="work-status">{workStatusLabels[work.status]}</span></span>{work.description && <span className="work-description">{work.description}</span>}</button></li>)}{!worksLoading && !works.length && <li>등록된 작품이 없습니다.</li>}</ul> : <>
      <button className="back-button" disabled={saving} onClick={handleBackToWorks}>← 작품 목록</button>
      <p className="section-label">{selectedWork.title}</p>
      <div className="viewer-layout">
        <aside className="viewer-episode-navigation" aria-label="에피소드 탐색">
          <button disabled={saving || episodesLoading} onClick={() => void handleNewEpisode()}>+ 새 회차</button>
          {!episodesLoading && !episodes.length && <p>등록된 에피소드가 없습니다.</p>}
          <ul className="viewer-episode-list">{episodes.map((episode) => <li key={episode.id}><button disabled={saving} className={"viewer-episode-button" + (selectedEpisode?.id === episode.id ? " is-selected" : "")} onClick={() => void handleSelectEpisode(episode)}><span className="viewer-episode-number">{episode.episodeNumber}화</span><span className="viewer-episode-title">{episode.title}</span><span className="viewer-episode-status">{episodeStatusLabels[episode.status]}</span></button></li>)}</ul>
        </aside>
        <div className="viewer-content-panel">
          {contentMissing && <p role="status">원고 파일을 찾을 수 없습니다. 저장하면 새 원고 파일을 생성할 수 있습니다.</p>}
          {readBlocked && <p>원고를 읽지 못해 저장할 수 없습니다. 회차를 다시 선택해 주세요.</p>}
          {draft && !contentLoading ? <form className="episode-editor" onSubmit={(event) => { event.preventDefault(); void handleSave(); }} noValidate>
            <h2>{selectedEpisode ? "회차 편집" : "새 회차"}</h2>
            <p>{dirty ? "저장하지 않은 변경사항이 있습니다." : "변경사항이 없습니다."}</p>
            <fieldset disabled={saving || readBlocked}>
              <label htmlFor="episode-number">회차 번호 *</label><input id="episode-number" type="number" min="1" step="1" value={draft.episodeNumber} onChange={(event) => setDraft({ ...draft, episodeNumber: event.target.value })} />
              <label htmlFor="episode-title">제목 *</label><input id="episode-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <label htmlFor="episode-status">상태</label><select id="episode-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as EpisodeStatus })}>{Object.entries(episodeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <label htmlFor="episode-content">원고</label><textarea id="episode-content" rows={16} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
              <p className="episode-counts">{draft.content.length.toLocaleString("ko-KR")}자 / {(draft.content === "" ? 0 : draft.content.split(/\r\n|\r|\n/).length).toLocaleString("ko-KR")}줄</p>
              <div className="work-management-actions"><button type="submit" disabled={busy}>저장</button>{selectedEpisode && <button type="button" disabled={busy} onClick={() => void handleDeleteEpisode()}>삭제</button>}</div>
            </fieldset>
          </form> : !contentLoading && !readBlocked && <p>회차를 선택하거나 새 회차를 작성하세요.</p>}
        </div>
      </div>
    </>}
  </section>;
}

export default WorksScreen;
