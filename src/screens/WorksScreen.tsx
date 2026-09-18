import { type Work, type WorkStatus } from "../types/work";
import { type Episode, type EpisodeStatus } from "../types/episode";

const works: Work[] = [
  {
    id: "work-001",
    title: "아무래도 전직을 잘못한 것 같습니다?",
    description: "웹소설 연재 작품",
    status: "ACTIVE",
  },
];

const statusLabels: Record<WorkStatus, string> = {
  ACTIVE: "연재 중",
  PAUSED: "일시 중지",
  COMPLETED: "완결",
};

const episodes: Episode[] = [
  {
    id: "episode-001",
    workId: "work-001",
    episodeNumber: 1,
    title: "첫 번째 회차",
    status: "COMPLETED",
  },
  {
    id: "episode-002",
    workId: "work-001",
    episodeNumber: 2,
    title: "두 번째 회차",
    status: "IN_PROGRESS",
  },
];

const episodeStatusLabels: Record<EpisodeStatus, string> = {
  DRAFT: "초안",
  IN_PROGRESS: "작성 중",
  COMPLETED: "완료",
};

function WorksScreen() {
  return (
    <section className="content-panel">
      <h1>작품 관리</h1>
      <ul className="work-list">
        {works.map((work) => {
          const workEpisodes = episodes.filter(
            (episode) => episode.workId === work.id,
          );

          return (
            <li className="work-card" key={work.id}>
              <div className="work-card-header">
                <h2>{work.title}</h2>
                <span className="work-status">{statusLabels[work.status]}</span>
              </div>
              <p>{work.description}</p>
              <ul className="episode-list">
                {workEpisodes.map((episode) => (
                  <li className="episode-item" key={episode.id}>
                    <span className="episode-number">
                      {episode.episodeNumber}화
                    </span>
                    <span className="episode-title">{episode.title}</span>
                    <span className="episode-status">
                      {episodeStatusLabels[episode.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default WorksScreen;
