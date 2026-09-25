import { useEffect, useRef, useState } from "react";
import { type EpisodeStatus } from "../types/episode";
import {
  type StoredEpisode,
  type StoredWork,
} from "../types/electron-api";
import { type WorkStatus } from "../types/work";

const workStatusLabels: Record<WorkStatus, string> = {
  ACTIVE: "연재 중",
  PAUSED: "일시 중지",
  COMPLETED: "완결",
};

const episodeStatusLabels: Record<EpisodeStatus, string> = {
  DRAFT: "초안",
  IN_PROGRESS: "작성 중",
  COMPLETED: "완료",
};

/**
 * SQLite 작품과 에피소드를 탐색하고 TXT 원고를 읽기 전용으로 표시한다.
 */
function WorksScreen() {
  const [works, setWorks] = useState<StoredWork[]>([]);
  const [selectedWork, setSelectedWork] = useState<StoredWork | null>(null);
  const [episodes, setEpisodes] = useState<StoredEpisode[]>([]);
  const [selectedEpisode, setSelectedEpisode] =
    useState<StoredEpisode | null>(null);
  const [episodeContent, setEpisodeContent] = useState("");
  const [worksLoading, setWorksLoading] = useState(true);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [worksError, setWorksError] = useState<string | null>(null);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const contentRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    /**
     * 화면 진입 시 SQLite에 등록된 작품 목록을 한 번 불러온다.
     */
    async function loadWorks() {
      setWorksLoading(true);
      setWorksError(null);

      try {
        const result = await window.novelCompany.works.getAll();
        if (cancelled) {
          return;
        }

        if (result.ok) {
          setWorks(result.data);
        } else {
          setWorksError(result.error.message);
        }
      } catch {
        if (!cancelled) {
          setWorksError("작품 정보를 불러오는 중 오류가 발생했습니다.");
        }
      } finally {
        if (!cancelled) {
          setWorksLoading(false);
        }
      }
    }

    void loadWorks();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 선택한 작품을 유지하면서 해당 작품의 에피소드 목록을 불러온다.
   */
  async function handleSelectWork(work: StoredWork) {
    setSelectedWork(work);
    setEpisodes([]);
    setSelectedEpisode(null);
    setEpisodesError(null);
    resetViewerContent();
    setEpisodesLoading(true);

    try {
      const result = await window.novelCompany.episodes.getByWorkId(work.id);
      if (result.ok) {
        setEpisodes(result.data);
      } else {
        setEpisodesError(result.error.message);
      }
    } catch {
      setEpisodesError("에피소드 정보를 불러오는 중 오류가 발생했습니다.");
    } finally {
      setEpisodesLoading(false);
    }
  }

  /**
   * 선택한 Episode를 즉시 강조하고 가장 최근 요청의 TXT 응답만 Viewer에 반영한다.
   */
  async function handleSelectEpisode(episode: StoredEpisode) {
    const requestId = contentRequestIdRef.current + 1;
    contentRequestIdRef.current = requestId;
    setSelectedEpisode(episode);
    setEpisodeContent("");
    setContentError(null);
    setContentLoading(true);

    try {
      const result = await window.novelCompany.episodes.readContent(episode.id);
      if (requestId !== contentRequestIdRef.current) {
        return;
      }

      if (result.ok) {
        setEpisodeContent(result.data);
      } else {
        setContentError(result.error.message);
      }
    } catch {
      if (requestId === contentRequestIdRef.current) {
        setContentError("에피소드 원고를 불러오는 중 오류가 발생했습니다.");
      }
    } finally {
      if (requestId === contentRequestIdRef.current) {
        setContentLoading(false);
      }
    }
  }

  /**
   * 진행 중인 원고 요청을 무효화하고 Viewer 본문 상태를 비운다.
   */
  function resetViewerContent() {
    contentRequestIdRef.current += 1;
    setEpisodeContent("");
    setContentError(null);
    setContentLoading(false);
  }

  /**
   * Viewer 상태만 초기화하고 현재 작품의 에피소드 목록으로 돌아간다.
   */
  function handleBackToEpisodes() {
    setSelectedEpisode(null);
    resetViewerContent();
  }

  /**
   * 작품 목록은 유지하고 선택 작품 이하의 탐색 상태를 초기화한다.
   */
  function handleBackToWorks() {
    setSelectedWork(null);
    setEpisodes([]);
    setEpisodesError(null);
    setEpisodesLoading(false);
    handleBackToEpisodes();
  }

  if (selectedWork && selectedEpisode) {
    return (
      <section className="content-panel">
        <button
          className="back-button"
          type="button"
          onClick={handleBackToEpisodes}
        >
          ← 에피소드 목록
        </button>
        <div className="viewer-layout">
          <aside className="viewer-episode-navigation" aria-label="에피소드 탐색">
            <p className="section-label">에피소드</p>
            <ul className="viewer-episode-list">
              {episodes.map((episode) => (
                <li key={episode.id}>
                  <button
                    aria-current={
                      episode.id === selectedEpisode.id ? "page" : undefined
                    }
                    className={
                      episode.id === selectedEpisode.id
                        ? "viewer-episode-button is-selected"
                        : "viewer-episode-button"
                    }
                    type="button"
                    onClick={() => void handleSelectEpisode(episode)}
                  >
                    <span className="viewer-episode-number">
                      {episode.episodeNumber}화
                    </span>
                    <span className="viewer-episode-title">{episode.title}</span>
                    <span className="viewer-episode-status">
                      {episodeStatusLabels[episode.status]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <div className="viewer-content-panel">
            <div className="viewer-header">
              <p className="section-label">{selectedWork.title}</p>
              <p className="viewer-header-episode-number">
                {selectedEpisode.episodeNumber}화
              </p>
              <div className="viewer-title-row">
                <h1>{selectedEpisode.title}</h1>
              </div>
              <p className="viewer-metadata">
                {episodeStatusLabels[selectedEpisode.status]} · {contentLoading
                  ? "글자 수를 계산하는 중입니다."
                  : contentError
                    ? "글자 수를 확인할 수 없습니다."
                    : `${episodeContent.length.toLocaleString("ko-KR")}자`}
              </p>
            </div>
            {contentLoading && (
              <p className="placeholder-message">원고를 불러오는 중입니다.</p>
            )}
            {!contentLoading && contentError && (
              <p className="error-message" role="alert">
                {contentError}
              </p>
            )}
            {!contentLoading && !contentError && (
              <pre className="episode-content">{episodeContent}</pre>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (selectedWork) {
    return (
      <section className="content-panel">
        <button className="back-button" type="button" onClick={handleBackToWorks}>
          ← 작품 목록
        </button>
        <p className="section-label">{selectedWork.title}</p>
        <h1>에피소드 목록</h1>
        {episodesLoading && (
          <p className="placeholder-message">
            에피소드 정보를 불러오는 중입니다.
          </p>
        )}
        {!episodesLoading && episodesError && (
          <p className="error-message" role="alert">
            {episodesError}
          </p>
        )}
        {!episodesLoading && !episodesError && episodes.length === 0 && (
          <p className="placeholder-message">등록된 에피소드가 없습니다.</p>
        )}
        {!episodesLoading && !episodesError && episodes.length > 0 && (
          <ul className="episode-list">
            {episodes.map((episode) => (
              <li className="episode-item" key={episode.id}>
                <button
                  className="episode-button"
                  type="button"
                  onClick={() => void handleSelectEpisode(episode)}
                >
                  <span className="episode-number">
                    {episode.episodeNumber}화
                  </span>
                  <span className="episode-title">{episode.title}</span>
                  <span className="episode-status">
                    {episodeStatusLabels[episode.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="content-panel">
      <h1>작품 관리</h1>
      {worksLoading && (
        <p className="placeholder-message">작품 정보를 불러오는 중입니다.</p>
      )}
      {!worksLoading && worksError && (
        <p className="error-message" role="alert">
          {worksError}
        </p>
      )}
      {!worksLoading && !worksError && works.length === 0 && (
        <p className="placeholder-message">등록된 작품이 없습니다.</p>
      )}
      {!worksLoading && !worksError && works.length > 0 && (
        <ul className="work-list">
          {works.map((work) => (
            <li className="work-card" key={work.id}>
              <button
                className="work-card-button"
                type="button"
                onClick={() => void handleSelectWork(work)}
              >
                <span className="work-card-header">
                  <span className="work-title">{work.title}</span>
                  <span className="work-status">
                    {workStatusLabels[work.status]}
                  </span>
                </span>
                {work.description && (
                  <span className="work-description">{work.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default WorksScreen;
