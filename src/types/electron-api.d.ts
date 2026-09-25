import type { Episode, EpisodeStatus } from "./episode";
import type { Work, WorkStatus } from "./work";

export type IpcSuccess<T> = {
  ok: true;
  data: T;
};

export type IpcFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export type StoredWork = Work & {
  createdAt: string;
  updatedAt: string;
};

export type StoredEpisode = Episode & {
  storageKey: string;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CanonSpace = { id: string; workId: string; templateKey: string; createdAt: string; updatedAt: string };
export type CanonSet = { id: string; canonSpaceId: string; key: string; name: string; recordNameLabel: string; description: string | null; sortOrder: number };
export type CanonFieldDefinition = { id: string; key: string; label: string; valueType: string; inputControl: string; required: boolean; helpText: string | null; sortOrder: number; referenceSet: { id: string; key: string; name: string } | null; options: Array<{ id: string; value: string; label: string; sortOrder: number }> };
export type CanonSetDefinition = CanonSet & { fields: CanonFieldDefinition[] };

export type CreateWorkInput = {
  title: string;
  description?: string | null;
  status?: WorkStatus;
};

export type UpdateWorkInput = Partial<CreateWorkInput>;

export type CreateEpisodeInput = {
  workId: string;
  episodeNumber: number;
  title: string;
  status?: EpisodeStatus;
  storageKey: string;
  contentHash?: string | null;
};

export type UpdateEpisodeInput = Partial<
  Pick<CreateEpisodeInput, "title" | "status" | "storageKey" | "contentHash">
>;

export interface NovelCompanyApi {
  works: {
    getAll(): Promise<IpcResult<StoredWork[]>>;
    getById(id: string): Promise<IpcResult<StoredWork | null>>;
    create(input: CreateWorkInput): Promise<IpcResult<StoredWork>>;
    update(
      id: string,
      changes: UpdateWorkInput,
    ): Promise<IpcResult<StoredWork | null>>;
  };
  episodes: {
    getById(id: string): Promise<IpcResult<StoredEpisode | null>>;
    getByWorkId(workId: string): Promise<IpcResult<StoredEpisode[]>>;
    create(input: CreateEpisodeInput): Promise<IpcResult<StoredEpisode>>;
    update(
      id: string,
      changes: UpdateEpisodeInput,
    ): Promise<IpcResult<StoredEpisode | null>>;
    readContent(episodeId: string): Promise<IpcResult<string>>;
  };
  canon: {
    spaces: { getByWorkId(workId: string): Promise<IpcResult<CanonSpace | null>> };
    sets: {
      getByCanonSpaceId(canonSpaceId: string): Promise<IpcResult<CanonSet[]>>;
      getDefinition(setId: string): Promise<IpcResult<CanonSetDefinition | null>>;
    };
  };
}

declare global {
  interface Window {
    novelCompany: NovelCompanyApi;
  }
}
