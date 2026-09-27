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
  createdAt: string;
  updatedAt: string;
};

export type CanonSpace = { id: string; workId: string; templateKey: string; createdAt: string; updatedAt: string };
export type CanonDeletionStatus = {
  exists: boolean;
  canonSpaceId: string | null;
  setCount: number;
  fieldCount: number;
  optionCount: number;
  recordCount: number;
  fieldValueCount: number;
  recordOptionValueCount: number;
  referenceCount: number;
  legacyDataCount: number;
  totalDependentRowCount: number;
};
export type CanonDeletionResult = { workId: string; deletedCanonSpaceId: string };
export type CanonSet = { id: string; canonSpaceId: string; key: string; name: string; recordNameLabel: string; description: string | null; sortOrder: number };
export type CanonFieldDefinition = { id: string; key: string; label: string; valueType: string; inputControl: string; required: boolean; helpText: string | null; sortOrder: number; referenceSet: { id: string; key: string; name: string } | null; options: Array<{ id: string; value: string; label: string; sortOrder: number }> };
export type CanonSetDefinition = CanonSet & { fields: CanonFieldDefinition[] };
export type CanonScope = { canonSpaceId: string; setId: string };
export type CanonFormValue = string | number | boolean | null | string[];
export type CanonRecordInput = { displayName: string; fieldValues: Record<string, CanonFormValue> };
export type CanonRecordSummary = CanonScope & { id: string; displayName: string; createdAt: string; updatedAt: string };
export type CanonRecord = CanonRecordSummary & CanonRecordInput;
export type CreateReadiness = { canCreate: boolean; blockers: Array<{ targetSetId: string; targetSetName: string; requiredCount: number; currentCount: number }> };
export type ReferenceOption = { id: string; displayName: string; disabled: boolean; description: string | null };

export type CreateWorkInput = {
  title: string;
  description?: string | null;
  status?: WorkStatus;
};

export type UpdateWorkInput = Partial<CreateWorkInput>;

export type WorkDeletionStatus = {
  canDelete: boolean;
  episodeCount: number;
  hasCanonSpace: boolean;
};

export type CreateEpisodeInput = {
  workId: string;
  episodeNumber: number;
  title: string;
  status?: EpisodeStatus;
  content: string;
};

export type UpdateEpisodeInput = CreateEpisodeInput;

export interface NovelCompanyApi {
  works: {
    getAll(): Promise<IpcResult<StoredWork[]>>;
    getById(id: string): Promise<IpcResult<StoredWork | null>>;
    create(input: CreateWorkInput): Promise<IpcResult<StoredWork>>;
    update(
      id: string,
      changes: UpdateWorkInput,
    ): Promise<IpcResult<StoredWork>>;
    getDeletionStatus(id: string): Promise<IpcResult<WorkDeletionStatus>>;
    delete(id: string): Promise<IpcResult<{ id: string }>>;
  };
  episodes: {
    getById(id: string): Promise<IpcResult<StoredEpisode | null>>;
    getByWorkId(workId: string): Promise<IpcResult<StoredEpisode[]>>;
    create(input: CreateEpisodeInput): Promise<IpcResult<StoredEpisode>>;
    update(
      id: string,
      changes: UpdateEpisodeInput,
    ): Promise<IpcResult<StoredEpisode>>;
    readContent(episodeId: string): Promise<IpcResult<string>>;
    delete(episodeId: string, workId: string): Promise<IpcResult<{ id: string; workId: string }>>;
    getNextAvailableNumber(workId: string): Promise<IpcResult<number>>;
  };
  canon: {
    records: {
      getBySetId(scope: CanonScope): Promise<IpcResult<CanonRecordSummary[]>>;
      getById(scope: CanonScope, recordId: string): Promise<IpcResult<CanonRecord>>;
      getCreateReadiness(scope: CanonScope): Promise<IpcResult<CreateReadiness>>;
      getReferenceOptions(scope: CanonScope, fieldId: string, editingRecordId?: string | null): Promise<IpcResult<ReferenceOption[]>>;
      create(scope: CanonScope, input: CanonRecordInput): Promise<IpcResult<CanonRecord>>;
      update(scope: CanonScope, recordId: string, input: CanonRecordInput): Promise<IpcResult<CanonRecord>>;
      delete(scope: CanonScope, recordId: string): Promise<IpcResult<{ id: string }>>;
    };
    spaces: {
      getByWorkId(workId: string): Promise<IpcResult<CanonSpace | null>>;
      createForWork(workId: string): Promise<IpcResult<CanonSpace>>;
      getDeletionStatus(workId: string): Promise<IpcResult<CanonDeletionStatus>>;
      deleteForWork(workId: string): Promise<IpcResult<CanonDeletionResult>>;
    };
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
