export type WorkStatus = "ACTIVE" | "PAUSED" | "COMPLETED";

export interface Work {
  id: string;
  title: string;
  description: string;
  status: WorkStatus;
}
