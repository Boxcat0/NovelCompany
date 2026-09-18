export type EpisodeStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED";

export interface Episode {
  id: string;
  workId: string;
  episodeNumber: number;
  title: string;
  status: EpisodeStatus;
}
