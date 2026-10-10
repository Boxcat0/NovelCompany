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
  aliasCount: number;
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
export type CanonAliasScope = { workId: string; recordId: string };
export type CanonAlias = { id: string; recordId: string; aliasText: string; createdAt: string; updatedAt: string };
export type CanonFormValue = string | number | boolean | null | string[];
export type CanonRecordInput = { displayName: string; fieldValues: Record<string, CanonFormValue> };
export type CanonRecordSummary = CanonScope & { id: string; displayName: string; createdAt: string; updatedAt: string; requiredAttributeMissing?: boolean };
export type CanonRecord = CanonRecordSummary & CanonRecordInput;
export type CreateReadiness = { canCreate: boolean; blockers: Array<{ targetSetId: string; targetSetName: string; requiredCount: number; currentCount: number }> };
export type ReferenceOption = { id: string; displayName: string; disabled: boolean; description: string | null };
export type WorkContextReference = {
  recordId: string;
  setKey: string;
  displayName: string;
};
export type WorkContextOption = { key: string; label: string };
export type WorkContextFieldValue =
  | string
  | number
  | boolean
  | null
  | WorkContextOption
  | WorkContextReference
  | WorkContextOption[]
  | WorkContextReference[];
export type WorkContext = {
  scope: "FULL_CANON";
  work: { id: string; title: string };
  episode: {
    id: string;
    episodeNumber: number;
    title: string;
    status: EpisodeStatus;
    content: string;
    contentHash: string | null;
  };
  canon: {
    summary: { setCount: number; recordCount: number };
    sets: Array<{
      key: string;
      label: string;
      recordCount: number;
      records: Array<{
        id: string;
        displayName: string;
        registeredAliases?: string[];
        fields: Array<{
          key: string;
          label: string;
          valueType: string;
          value: WorkContextFieldValue;
        }>;
      }>;
    }>;
  };
};

export type ReviewFindingCategory = "TEXT" | "NARRATION" | "NAME_RESOLUTION" | "CONTINUITY" | "TYPO" | "SPACING" | "GRAMMAR" | "CANON" | "OTHER";
export type SourceRange = { start: number; end: number };
export type NarrationMode = 'FIRST_PERSON_CHARACTER' | 'EXTERNAL_THIRD_PERSON' | 'UNKNOWN';
export type SceneNarration = { mode: NarrationMode; source: 'AUTHOR_SET' | 'UNSET'; narratorCharacter: WorkContextReference | null; status: 'VALID' | 'NARRATOR_DELETED' };
export type SceneNarrationSnapshot = { workId: string; episodeId: string; episodeContentHash: string; layoutVersion: string; metadataVersion: string; hasStaleMetadata: boolean; characters: WorkContextReference[]; scenes: Array<{ identity: string; index: number; originalRange: SourceRange; locationHeading: string | null; preview: string; narration: SceneNarration }> };
export type SaveSceneNarrationInput = { workId: string; episodeId: string; expectedEpisodeContentHash: string; expectedSceneLayoutVersion: string; expectedSceneIdentity: string; narration: { mode: NarrationMode; narratorCharacterId: string | null } };
export type CanonResolution = { status: 'MATCHED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNRESOLVED'; recordId: string | null; candidateIds: string[] };
export type NotationOccurrence = { type: string; raw: string; range: SourceRange; quoteContext: string | null; canonType?: string; resolution?: CanonResolution };
export type ReviewContext = {
  canonReferenceCoverage?: { version: 'CANON_REFERENCE_LISTS_V1'; workId: string; characters: Array<{ recordId: string; fields: Partial<Record<'attributes' | 'skills', { complete: true; recordIds: string[] }>> }> };
  nameResolutionVersion: 'CHARACTER_NAMES_V1' | null;
  nameMentions: Array<{ text: string; normalizedName: string; sceneIndex: number; sceneIdentity: string; range: SourceRange; quoteContext: string | null; status: 'MATCHED' | 'AMBIGUOUS'; recordId: string | null; candidateIds: string[]; certainty: 'REGISTERED_NAME_CANDIDATES'; candidates: Array<{ recordId: string; displayName: string; matchTypes: Array<'DISPLAY_NAME' | 'REGISTERED_ALIAS'>; organization: WorkContextReference | null }> }>;
  sceneMetadata: Omit<SceneNarrationSnapshot, 'workId' | 'episodeId' | 'characters' | 'scenes'>;
  scope: 'RELEVANT_CANON'; selectorVersion: 'RELEVANT_CANON_V2' | 'RELEVANT_CANON_V3'; rangeUnit: 'UTF16_HALF_OPEN';
  work: WorkContext['work']; episode: WorkContext['episode'];
  scenes: Array<{ index: number; originalRange: SourceRange; locationHeading: string | null; timeHintRaw: string | null; locationCandidate: string | null; resolvedLocation: CanonResolution; identity: string; narration: SceneNarration; notationOccurrences: NotationOccurrence[]; directMentions: Array<CanonResolution & { name: string; range: SourceRange }>; selectedCanonIds: string[] }>;
  relevantCanon: { selectedSets: Array<{ key: string; label: string }>; selectedRecords: Array<WorkContext['canon']['sets'][number]['records'][number] & { setKey: string; setLabel: string }>; selectionReasons: Array<{ recordId: string; reason: string; sceneIndex: number; sourceRecordId: string | null; range: SourceRange | null }> };
  abilityOwnershipChecks: Array<{ raw: string; range: SourceRange; sceneIndex: number; type: string; abilityRecordId: string | null; actorCharacterId: string | null; result: 'MATCHED' | 'MISMATCH_CANDIDATE' | 'UNVERIFIABLE_OWNER' | 'CANON_NOT_FOUND' | 'AMBIGUOUS'; evidence: string; unresolvedReason: string | null }>;
  unresolvedMentions: Array<{ raw: string; range: SourceRange; sceneIndex: number; status: 'UNKNOWN' | 'AMBIGUOUS'; candidateIds: string[] }>;
  warnings: Array<{ range: SourceRange; message: string }>;
};
export type FindingCanonReference = {
  recordId: string; setKey: string; displayNameAtReview: string;
  referenceRole: 'CONTEXT_RECORD' | 'NAME_CANDIDATE' | 'AMBIGUOUS_CANDIDATE';
  mentionIndex?: number;
  mention?: { text: string; range: SourceRange; sceneIdentity: string; status: 'MATCHED' | 'AMBIGUOUS' };
  organization?: { recordId: string; setKey: string; displayNameAtReview: string } | null;
};
export type FindingAnchor = { type: 'TEXT_RANGE'; range: SourceRange; sceneIdentity: string | null; sourceExcerpt: string } | { type: 'CANON_RECORD' };
export type ReviewFinding = { id: string; reviewRunId: string; category: ReviewFindingCategory; message: string; sortOrder: number; createdAt: string } & (
  { contractVersion: null } |
  { contractVersion: 'REVIEW_FINDINGS_V1'; severity: 'INFO' | 'WARNING' | 'ERROR'; assessment: 'DETERMINISTIC' | 'INFERENCE_CANDIDATE' | 'UNDETERMINED'; anchor: FindingAnchor; evidence: string; suggestion: string | null; relatedCanonRecords: FindingCanonReference[]; provenance: { processorKey: string } }
);
export type ReviewRun = {
  id: string;
  workId: string;
  episodeId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  processorKey: string;
  contractVersion: 'REVIEW_FINDINGS_V1' | null;
  source: { nameResolutionVersion: 'CHARACTER_NAMES_V1' | null; sceneMetadataHash: string | null; sceneMetadataVersion: string | null; episodeContentHash: string; canonContextHash: string; contextMode: 'FULL_CANON_V1' | 'RELEVANT_CANON_V1'; fingerprintVersion: 'V1' | 'V2' };
  freshness: { sceneMetadataChanged: boolean | null; sceneMetadataComparison: 'CURRENT' | 'CHANGED' | 'LEGACY_NOT_TRACKED' | 'UNDETERMINED_EPISODE_CHANGED' | 'UNAVAILABLE'; isCurrent: boolean; episodeChanged: boolean | null; canonChanged: boolean | null; contextChanged: boolean | null; canonComparison: 'COMPARABLE' | 'UNDETERMINED_EPISODE_CHANGED' | 'UNAVAILABLE' };
  findings: ReviewFinding[];
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
};
export type ReviewJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RESUBMIT_REQUIRED';
export type ReviewProcessorKey = 'STUB_V1' | 'RULE_V1';
export type ReviewSubmissionInput = { workId: string; episodeId: string; processorKey?: ReviewProcessorKey };
export type ReviewJob = { processorKey: ReviewProcessorKey; nameResolutionVersion: 'CHARACTER_NAMES_V1' | null; sceneMetadataHash: string | null; sceneMetadataVersion: string | null; id: string; workId: string; episodeId: string; queueSequence: number; status: ReviewJobStatus; episodeContentHash: string; canonContextHash: string; contextMode: 'RELEVANT_CANON_V1'; fingerprintVersion: 'V2'; reviewRunId: string | null; errorCode: string | null; errorMessage: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; workTitle: string; episodeNumber: number; episodeTitle: string };
export type ReviewQueue = { running: ReviewJob[]; queued: ReviewJob[]; recent: ReviewJob[] };

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
  sceneNarration: {
    getForEpisode(input: { workId: string; episodeId: string }): Promise<IpcResult<SceneNarrationSnapshot>>;
    save(input: SaveSceneNarrationInput): Promise<IpcResult<{ sceneIdentity: string; narration: SceneNarration }>>;
  };
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
    aliases: {
      list(scope: CanonAliasScope): Promise<IpcResult<CanonAlias[]>>;
      create(scope: CanonAliasScope, text: string): Promise<IpcResult<CanonAlias>>;
      update(scope: CanonAliasScope, id: string, text: string): Promise<IpcResult<CanonAlias>>;
      delete(scope: CanonAliasScope, id: string): Promise<IpcResult<{ id: string; recordId: string }>>;
    };
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
  context: {
    getEpisodeReviewContext(input: { workId: string; episodeId: string }): Promise<IpcResult<ReviewContext>>;
    getEpisodeWorkContext(input: {
      workId: string;
      episodeId: string;
    }): Promise<IpcResult<WorkContext>>;
  };
  reviews: {
    start(input: ReviewSubmissionInput): Promise<IpcResult<ReviewJob>>;
    submit(input: ReviewSubmissionInput): Promise<IpcResult<ReviewJob>>;
    getQueue(): Promise<IpcResult<ReviewQueue>>;
    getJobByEpisode(input: { workId: string; episodeId: string }): Promise<IpcResult<ReviewJob | null>>;
    cancelQueued(reviewJobId: string): Promise<IpcResult<ReviewJob>>;
    getByEpisode(input: { workId: string; episodeId: string }): Promise<IpcResult<ReviewRun[]>>;
    getById(reviewRunId: string): Promise<IpcResult<ReviewRun>>;
  };
}

declare global {
  interface Window {
    novelCompany: NovelCompanyApi;
  }
}
