import { ReviewContextPreview } from '../components/ReviewContextPreview';
import type { ReviewContext } from '../types/electron-api';
import { useEffect, useRef, useState } from "react";
import type { EpisodeStatus } from "../types/episode";
import type {
  IpcResult,
  StoredEpisode,
  StoredWork,
  ReviewRun,
  ReviewJob,
  ReviewJobStatus,
  ReviewQueue,
  WorkContext,
} from "../types/electron-api";

const episodeStatusLabels: Record<EpisodeStatus, string> = { DRAFT: "초안", IN_PROGRESS: "작성 중", COMPLETED: "완료" };
const reviewJobStatusLabels: Record<ReviewJobStatus, string> = { QUEUED: '대기 중', RUNNING: '검토 중', COMPLETED: '완료', FAILED: '실패', CANCELLED: '철회됨', RESUBMIT_REQUIRED: '재제출 필요' };
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
  const [reviewContextPreview, setReviewContextPreview] = useState<ReviewContext | null>(null);
  const [contextPreview, setContextPreview] = useState<WorkContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [reviews, setReviews] = useState<ReviewRun[]>([]);
  const [reviewJob, setReviewJob] = useState<ReviewJob | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueue | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewStarting, setReviewStarting] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestPending = useRef(false);
  const contentRequestIdRef = useRef(0);
  const listRequestIdRef = useRef(0);
  const contextRequestIdRef = useRef(0);
  const reviewRequestIdRef = useRef(0);
  const reviewStartRequestIdRef = useRef(0);
  const reviewJobRequestIdRef = useRef(0);
  const reviewQueueRequestIdRef = useRef(0);
  const mounted = useRef(true);
  const dirty = draft !== null && (contentMissing || JSON.stringify(draft) !== baseline);
  const busy = worksLoading || episodesLoading || contentLoading || saving || contextLoading || reviewStarting;
  const reviewLocked = reviewJob?.status === 'QUEUED' || reviewJob?.status === 'RUNNING';
  const queueActive = Boolean(reviewQueue?.running.length || reviewQueue?.queued.length);
  const queuePosition = reviewJob && reviewQueue ? reviewQueue.queued.findIndex(item => item.id === reviewJob.id) : -1;

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
    return () => { cancelled = true; mounted.current = false; contentRequestIdRef.current++; listRequestIdRef.current++; contextRequestIdRef.current++; reviewRequestIdRef.current++; reviewStartRequestIdRef.current++; reviewJobRequestIdRef.current++; reviewQueueRequestIdRef.current++; };
  }, []);
  useEffect(() => {
    if (!selectedWork) return;
    const timer = window.setInterval(() => { void loadQueue(); if (selectedEpisode) void loadReviewJob(selectedWork.id, selectedEpisode.id); }, queueActive ? 2000 : 5000);
    return () => window.clearInterval(timer);
  }, [selectedWork?.id, selectedEpisode?.id, queueActive]);
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
    contentRequestIdRef.current++; contextRequestIdRef.current++; reviewRequestIdRef.current++; reviewStartRequestIdRef.current++; setSelectedEpisode(null); setDraft(null); setBaseline("");
    setContentMissing(false); setReadBlocked(false); setContentLoading(false);
    setContextPreview(null); setReviewContextPreview(null); setContextError(""); setContextLoading(false);
    reviewJobRequestIdRef.current++; setReviewJob(null);
    setReviews([]); setReviewError(""); setReviewLoading(false); setReviewStarting(false);
  }

  /** 접수 순서가 고정된 전역 검토 대기열을 늦은 응답으로 덮어쓰지 않는다. */
  async function loadQueue() {
    const requestId = ++reviewQueueRequestIdRef.current;
    try { const queue = readResult(await window.novelCompany.reviews.getQueue()); if (mounted.current && requestId === reviewQueueRequestIdRef.current) setReviewQueue(queue); }
    catch { if (mounted.current && requestId === reviewQueueRequestIdRef.current) setReviewError('검토 대기열을 불러오지 못했습니다.'); }
  }

  /** 선택 Episode의 Job만 적용하고 종료 시 ReviewRun 결과를 다시 읽는다. */
  async function loadReviewJob(workId: string, episodeId: string) {
    const requestId = ++reviewJobRequestIdRef.current;
    try {
      const job = readResult(await window.novelCompany.reviews.getJobByEpisode({ workId, episodeId }));
      if (!mounted.current || requestId !== reviewJobRequestIdRef.current) return;
      setReviewJob(job);
      if (job && !['QUEUED', 'RUNNING'].includes(job.status)) void loadReviews(workId, episodeId);
    } catch { if (mounted.current && requestId === reviewJobRequestIdRef.current) setReviewError('검토 제출 상태를 불러오지 못했습니다.'); }
  }

  /** 현재 저장본 기준 Review history를 한 번 읽고 오래된 Episode 응답은 폐기한다. */
  async function loadReviews(workId: string, episodeId: string) {
    const requestId = ++reviewRequestIdRef.current;
    setReviewLoading(true); setReviewError("");
    try {
      const items = readResult(await window.novelCompany.reviews.getByEpisode({ workId, episodeId }));
      if (mounted.current && requestId === reviewRequestIdRef.current) setReviews(items);
    } catch (cause) {
      if (mounted.current && requestId === reviewRequestIdRef.current) setReviewError(cause instanceof EpisodeRequestError ? cause.message : "검토 기록을 불러오지 못했습니다.");
    } finally {
      if (mounted.current && requestId === reviewRequestIdRef.current) setReviewLoading(false);
    }
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
    void loadQueue();
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
      void loadReviews(selectedWork.id, current.id);
      void loadReviewJob(selectedWork.id, current.id);
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
    if (!draft || !selectedWork || busy || readBlocked || reviewLocked || requestPending.current) return;
    if (!/^\d+$/.test(draft.episodeNumber) || !Number.isSafeInteger(Number(draft.episodeNumber)) || Number(draft.episodeNumber) < 1) { setError("회차 번호는 1 이상의 정수여야 합니다."); return; }
    if (!draft.title.trim()) { setError("에피소드 제목을 입력해 주세요."); return; }
    await runWrite(async () => {
      const input = { ...draft, episodeNumber: Number(draft.episodeNumber), workId: selectedWork.id };
      const saved = readResult(selectedEpisode ? await window.novelCompany.episodes.update(selectedEpisode.id, input) : await window.novelCompany.episodes.create(input));
      const next = episodeDraft(saved, draft.content);
      setSelectedEpisode(saved); setDraft(next); setBaseline(JSON.stringify(next)); setContentMissing(false);
      await loadEpisodes(selectedWork.id); void loadReviews(selectedWork.id, saved.id); setMessage("저장되었습니다.");
    });
  }

  /** dirty draft를 차단하고 저장본의 Work/ReviewContext를 미리 보며 이전 회차 응답은 폐기한다. */
  async function handlePreviewWorkContext() {
    if (!selectedWork || !selectedEpisode || contextLoading) return;
    if (dirty) {
      setContextError("저장되지 않은 원고가 있습니다. 작업 컨텍스트를 확인하려면 먼저 저장해 주세요.");
      return;
    }
    const requestId = ++contextRequestIdRef.current;
    const episodeId = selectedEpisode.id;
    setContextLoading(true); setContextError(""); setContextPreview(null); setReviewContextPreview(null);
    try {
      const context = readResult(await window.novelCompany.context.getEpisodeWorkContext({
        workId: selectedWork.id,
        episodeId,
      }));
      if (!mounted.current || requestId !== contextRequestIdRef.current || selectedEpisode.id !== episodeId) return;
      const reviewContext = readResult(await window.novelCompany.context.getEpisodeReviewContext({ workId: selectedWork.id, episodeId }));
      if (!mounted.current || requestId !== contextRequestIdRef.current) return;
      setReviewContextPreview(reviewContext);
      setContextPreview(context);
    } catch (cause) {
      if (mounted.current && requestId === contextRequestIdRef.current) {
        setContextError(cause instanceof EpisodeRequestError ? cause.message : "작업 컨텍스트를 불러오지 못했습니다.");
      }
    } finally {
      if (mounted.current && requestId === contextRequestIdRef.current) setContextLoading(false);
    }
  }

  /** dirty draft를 차단하고 저장된 회차를 검토부 대기열에 접수한다. */
  async function handleStartReview() {
    if (!selectedWork || !selectedEpisode || reviewStarting || busy || reviewLocked) return;
    if (dirty) {
      setReviewError("저장되지 않은 원고가 있습니다. 검토부에 제출하려면 먼저 저장해 주세요.");
      return;
    }
    const requestId = ++reviewStartRequestIdRef.current;
    const episodeId = selectedEpisode.id;
    setReviewStarting(true); setReviewError("");
    try {
      readResult(await window.novelCompany.reviews.submit({ workId: selectedWork.id, episodeId }));
      if (!mounted.current || requestId !== reviewStartRequestIdRef.current || selectedEpisode.id !== episodeId) return;
      void loadReviewJob(selectedWork.id, episodeId); void loadQueue();
    } catch (cause) {
      if (mounted.current && requestId === reviewStartRequestIdRef.current) setReviewError(cause instanceof EpisodeRequestError ? cause.message : "검토 작업을 시작하지 못했습니다.");
    } finally {
      if (mounted.current && requestId === reviewStartRequestIdRef.current) setReviewStarting(false);
    }
  }

  /** 대기 중인 제출만 철회하고 잠금 및 대기 순서를 다시 조회한다. */
  async function handleCancelReview() {
    if (!reviewJob || reviewJob.status !== 'QUEUED' || reviewStarting) return;
    const requestId = ++reviewStartRequestIdRef.current;
    const workId = selectedWork?.id;
    const episodeId = selectedEpisode?.id;
    setReviewStarting(true); setReviewError('');
    try {
      readResult(await window.novelCompany.reviews.cancelQueued(reviewJob.id));
      if (!mounted.current || requestId !== reviewStartRequestIdRef.current) return;
      void loadQueue(); if (workId && episodeId) void loadReviewJob(workId, episodeId);
    } catch (cause) { if (mounted.current && requestId === reviewStartRequestIdRef.current) setReviewError(cause instanceof EpisodeRequestError ? cause.message : '제출을 철회하지 못했습니다.'); }
    finally { if (mounted.current && requestId === reviewStartRequestIdRef.current) setReviewStarting(false); }
  }

  /** dirty 폐기 후 저장된 회차 이름으로 확인하고 metadata/TXT 통합 삭제 뒤 선택을 비운다. */
  async function handleDeleteEpisode() {
    if (!selectedEpisode || !selectedWork || busy || reviewLocked || !canDiscardChanges()) return;
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
            {reviewLocked && <p role="status">검토 대기 또는 진행 중인 원고입니다. 작업이 끝나거나 대기 중 제출을 철회하면 편집할 수 있습니다.{dirty && ' 미저장 입력은 화면에 보존됩니다.'}</p>}
            <fieldset disabled={saving || readBlocked || reviewLocked}>
              <label htmlFor="episode-number">회차 번호 *</label><input id="episode-number" type="number" min="1" step="1" value={draft.episodeNumber} onChange={(event) => setDraft({ ...draft, episodeNumber: event.target.value })} />
              <label htmlFor="episode-title">제목 *</label><input id="episode-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <label htmlFor="episode-status">상태</label><select id="episode-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as EpisodeStatus })}>{Object.entries(episodeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <label htmlFor="episode-content">원고</label><textarea id="episode-content" rows={16} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
              <p className="episode-counts">{draft.content.length.toLocaleString("ko-KR")}자 / {(draft.content === "" ? 0 : draft.content.split(/\r\n|\r|\n/).length).toLocaleString("ko-KR")}줄</p>
              <div className="work-management-actions"><button type="submit" disabled={busy}>저장</button>{selectedEpisode && <button type="button" disabled={busy} onClick={() => void handleDeleteEpisode()}>삭제</button>}</div>
            </fieldset>
            {selectedEpisode && <button type="button" className="context-preview-button" disabled={busy} onClick={() => void handlePreviewWorkContext()}>작업 컨텍스트 확인</button>}
            {contextError && <p className="error-message" role="alert">{contextError}</p>}
            {contextLoading && <p role="status">작업 컨텍스트를 구성하는 중입니다.</p>}
            {contextPreview && <section className="context-preview" aria-label="작업 컨텍스트 미리보기">
              <h3>작업 컨텍스트</h3>
              <p>저장된 원고 기준 · {contextPreview.episode.episodeNumber}화 · {contextPreview.episode.content.length.toLocaleString("ko-KR")}자</p>
              <p>Canon Set {contextPreview.canon.summary.setCount}개 · Record {contextPreview.canon.summary.recordCount}개</p>
              {contextPreview.canon.sets.length === 0 ? <p>등록된 Canon Definition이 없습니다.</p> : <ul className="context-set-summary">
                {contextPreview.canon.sets.map((set) => <li key={set.key}>{set.label} <strong>{set.recordCount}</strong></li>)}
              </ul>}
              <details>
                <summary>Canon 상세 펼치기</summary>
                {contextPreview.canon.sets.map((set) => <section className="context-set-detail" key={set.key}>
                  <h4>{set.label}</h4>
                  {set.records.length === 0 ? <p>등록된 Record가 없습니다.</p> : <ul>
                    {set.records.map((record) => <li key={record.id}><strong>{record.displayName}</strong><ul>
                      {record.fields.map((field) => <li key={field.key}>{field.label}: {typeof field.value === "string" || typeof field.value === "number" || typeof field.value === "boolean" ? String(field.value) : field.value === null ? "없음" : Array.isArray(field.value) ? field.value.map((item) => "label" in item ? item.label : item.displayName).join(", ") : "label" in field.value ? field.value.label : field.value.displayName}</li>)}
                    </ul></li>)}
                  </ul>}
                </section>)}
              </details>
            </section>}
            {reviewContextPreview && <ReviewContextPreview context={reviewContextPreview} />}
            {selectedEpisode && <section className="review-panel" aria-label="검토">
              <h3>검토</h3>
              <p>Stub Processor는 실제 문장·Canon 검토를 수행하지 않으며, Review Pipeline 연결 상태만 확인합니다.</p>
              <button type="button" disabled={busy || reviewLoading || reviewLocked || dirty || contentMissing} onClick={() => void handleStartReview()}>{reviewStarting ? "제출 중…" : "검토부에 제출"}</button>
              {dirty && <p>미저장 변경사항을 저장한 뒤 제출할 수 있습니다.</p>}
              {reviewJob && <p role="status">제출 상태: {reviewJobStatusLabels[reviewJob.status]}{reviewJob.status === 'QUEUED' && queuePosition >= 0 ? ` · 대기 순서 ${queuePosition + 1}` : ''}{reviewJob.errorMessage ? ` · ${reviewJob.errorMessage}` : ''}</p>}
              {reviewJob?.status === 'QUEUED' && <button type="button" disabled={reviewStarting} onClick={() => void handleCancelReview()}>제출 철회</button>}
              {reviews.length > 0 && <button type="button" onClick={() => void loadReviews(selectedWork.id, selectedEpisode.id)}>Review 결과 확인</button>}
              {reviewQueue && <section aria-label="검토부 대기열"><h4>검토부 대기열</h4><p>현재 작업: {reviewQueue.running.map(item => `${item.workTitle} · ${item.episodeNumber}화`).join(', ') || '없음'}</p><ol>{reviewQueue.queued.map(item => <li key={item.id}>{item.workTitle} · {item.episodeNumber}화 — 대기</li>)}</ol><p>최근 종료: {reviewQueue.recent[0] ? `${reviewQueue.recent[0].workTitle} · ${reviewQueue.recent[0].episodeNumber}화 — ${reviewJobStatusLabels[reviewQueue.recent[0].status]}` : '없음'}</p></section>}
              {reviewError && <p className="error-message" role="alert">{reviewError}</p>}
              {reviewLoading && <p role="status">검토 기록을 불러오는 중입니다.</p>}
              {!reviewLoading && reviews.length === 0 && <p>최근 검토가 없습니다.</p>}
              {!reviewLoading && reviews.length > 0 && <ul className="review-history">
                {reviews.map((review) => <li key={review.id}>
                  <strong>{review.status === 'RUNNING' ? '검토 중' : review.status === 'COMPLETED' ? '완료' : '실패'}</strong> · {review.processorKey} · {new Date(review.createdAt).toLocaleString("ko-KR")}
                  <p>{review.status === "COMPLETED" ? "Stub 검토 완료: 실제 AI 검토 결과가 아닙니다." : review.status === "FAILED" ? "검토 작업을 완료하지 못했습니다." : "검토가 진행 중입니다."}</p>
                  <p>{review.freshness.isCurrent ? "현재 원고/Canon과 일치합니다." : `${review.freshness.episodeChanged ? "원고가 변경됨" : ""}${review.freshness.episodeChanged && review.freshness.canonChanged ? " · " : ""}${review.freshness.canonChanged ? "Canon이 변경됨" : ""}`}</p>
                  {review.freshness.canonComparison === "UNDETERMINED_EPISODE_CHANGED" && <p>원고가 바뀌어 관련 Canon의 독립적인 변경 여부는 판정할 수 없습니다. 저장본 기준으로 다시 실행해 주세요.</p>}
                  {review.findings.length > 0 && <ul>{review.findings.map((finding) => <li key={finding.id}>[{finding.category}] {finding.message}</li>)}</ul>}
                </li>)}
              </ul>}
            </section>}
          </form> : !contentLoading && !readBlocked && <p>회차를 선택하거나 새 회차를 작성하세요.</p>}
        </div>
      </div>
    </>}
  </section>;
}

export default WorksScreen;
