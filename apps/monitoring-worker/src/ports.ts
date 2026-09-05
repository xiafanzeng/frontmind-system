import type {
  BillingQuery,
  MoliBalance,
  MoliBillingRecordsPage,
  MoliBillingSummary,
  MoliModel,
  MoliRegion,
  MoliResultItem,
  MoliTaskResult,
  MoliTaskStatusResponse,
  SubmitSingleAttemptInput,
  SubmitTaskResponse,
} from "@frontmind/monitoring-provider-moli";
import type {
  FetchedMedia,
  ImageDerivatives,
  PrivateObjectStore,
} from "@frontmind/monitoring-object-store";
import type { WorkerJob } from "./job-types.js";

export interface LoggerPort {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface MoliProviderPort {
  listModels(signal?: AbortSignal): Promise<readonly MoliModel[]>;
  listDomesticRegions(signal?: AbortSignal): Promise<readonly MoliRegion[]>;
  listOverseasRegions(signal?: AbortSignal): Promise<readonly MoliRegion[]>;
  submitSingleAttempt(
    input: SubmitSingleAttemptInput,
    signal?: AbortSignal,
  ): Promise<SubmitTaskResponse>;
  getTaskStatus(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskStatusResponse>;
  getTaskResult(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskResult>;
  getSubTaskResult(
    taskId: string,
    subTaskId: string,
    signal?: AbortSignal,
  ): Promise<MoliTaskResult>;
  stopTask(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; raw: unknown }>;
  getBalance(signal?: AbortSignal): Promise<MoliBalance>;
  getBillingSummary(
    query: BillingQuery,
    signal?: AbortSignal,
  ): Promise<MoliBillingSummary>;
  getBillingRecords(
    query: BillingQuery,
    signal?: AbortSignal,
  ): Promise<MoliBillingRecordsPage>;
}

export interface AttemptForSubmission {
  attemptId: string;
  tenantId: string;
  projectId: string;
  runId: string;
  status: string;
  consumerTaskId?: string;
  monitorKeyword: string;
  monitorKeywordAliases: readonly string[];
  competitors: readonly { name: string; aliases: readonly string[] }[];
  prompt: string;
  platform: string;
  clientType: "web" | "mobile";
  mode: "search" | "reasoning_search";
  screenshot: 0 | 1 | 2;
  regionCode?: string;
  callbackUrl?: string;
}

export interface AttemptProviderState {
  attemptId: string;
  tenantId: string;
  projectId: string;
  runId: string;
  providerTaskId?: string;
  providerSubTaskId?: string;
  status: string;
}

export interface AuthoritativeResultInput {
  attemptId: string;
  providerTaskId: string;
  contentHash: string;
  item: MoliResultItem;
  providerRaw: unknown;
  rawObjectKey: string;
  observedAt: Date;
}

export interface ApplyResultOutcome {
  revisionCreated: boolean;
  quotaConsumed: boolean;
  mediaJobsCreated: number;
  /** Raw archive referenced by the retained revision (new or pre-existing). */
  retainedRawObjectKey: string;
}

export type ProviderSubmissionPermit =
  | { status: "acquired" }
  | {
      status: "deferred";
      reason:
        | "rate_limit"
        | "active_limit"
        | "daily_limit"
        | "submission_concurrency";
      retryAt: Date;
    }
  | { status: "terminal" };

export interface MediaArchiveCandidate {
  mediaId: string;
  tenantId: string;
  projectId: string;
  runId: string;
  attemptId: string;
  sourceUrl: string;
  kind: string;
}

export interface ScheduleForCatchUp {
  scheduleId: string;
  monitorId: string;
  type: "daily" | "weekly";
  timezone: string;
  localTime: string;
  weekday?: number;
  materializedThrough: Date;
}

export interface ScheduleOccurrenceInput {
  occurrenceId: string;
  scheduleId: string;
  monitorId: string;
  scheduledAt: Date;
  trigger: "scheduled" | "catch_up";
}

export interface PurgeCandidate {
  entityType: "project" | "monitor" | "run";
  entityId: string;
  providerTaskIds: readonly string[];
  objectKeys: readonly string[];
}

export interface BillingReconciliationCursor {
  startDate: string;
  endDate: string;
  page: number;
  pageSize: number;
}

/**
 * This is the transaction boundary the DB package must implement. Methods whose
 * names start with `apply`, `settle`, `materialize` or `dispatch` are required to
 * be atomic and idempotent using database unique keys, never process memory.
 */
export interface WorkerRepositoryPort {
  leaseJobs(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
  }): Promise<readonly WorkerJob[]>;
  completeJob(
    jobId: string,
    workerId: string,
    completedAt: Date,
  ): Promise<void>;
  renewJobLease(
    jobId: string,
    workerId: string,
    leasedUntil: Date,
  ): Promise<void>;
  deferJob(
    jobId: string,
    workerId: string,
    availableAt: Date,
    reason: string,
  ): Promise<void>;
  retryJob(input: {
    jobId: string;
    workerId: string;
    availableAt: Date;
    error: string;
  }): Promise<void>;
  deadLetterJob(input: {
    jobId: string;
    workerId: string;
    failedAt: Date;
    error: string;
  }): Promise<void>;
  heartbeatWorker(workerId: string, at: Date): Promise<void>;
  enqueueMaintenanceJobs(at: Date): Promise<void>;

  /**
   * Atomically serializes all workers on one DB gate, enforces the global rate,
   * daily, active and in-flight limits, records the idempotent daily slot and
   * changes the attempt to `submitting`. Existing submission_unknown attempts
   * retain their quota reservation and consumerTaskId when they reacquire.
   */
  acquireProviderSubmissionPermit(input: {
    attemptId: string;
    consumerTaskId: string;
    now: Date;
    dayKey: string;
    dailyLimit: number;
    activeLimit: number;
    submissionConcurrencyLimit: number;
    minIntervalMs: number;
  }): Promise<ProviderSubmissionPermit>;
  getAttemptForSubmission(
    attemptId: string,
  ): Promise<AttemptForSubmission | undefined>;
  markAttemptSubmissionAccepted(input: {
    attemptId: string;
    consumerTaskId: string;
    providerTaskId: string;
    providerSubTaskId?: string;
    acceptedAt: Date;
    nextPollAt: Date;
  }): Promise<void>;
  markAttemptSubmissionUnknown(input: {
    attemptId: string;
    consumerTaskId: string;
    observedAt: Date;
    reason: string;
  }): Promise<void>;
  recordProviderStopRequest(input: {
    attemptId: string;
    providerTaskId?: string;
    accepted: boolean;
    providerRaw?: unknown;
    requestedAt: Date;
  }): Promise<void>;
  getAttemptProviderState(
    attemptId: string,
  ): Promise<AttemptProviderState | undefined>;
  recordProviderStatus(input: {
    attemptId: string;
    providerTaskId: string;
    status: MoliTaskStatusResponse["status"];
    providerRaw: unknown;
    observedAt: Date;
    nextPollAt?: Date;
  }): Promise<void>;
  enqueueResultFetch(attemptId: string, availableAt: Date): Promise<void>;
  applyAuthoritativeResult(
    input: AuthoritativeResultInput,
  ): Promise<ApplyResultOutcome>;
  settleAttemptTerminalFailure(input: {
    attemptId: string;
    status: "failed" | "stopped" | "error";
    reason?: string;
    providerRaw?: unknown;
    settledAt: Date;
  }): Promise<void>;
  markAttemptReviewRequired(input: {
    attemptId: string;
    reason: string;
    providerRaw?: unknown;
    observedAt: Date;
  }): Promise<void>;

  getMediaArchiveCandidate(
    mediaId: string,
  ): Promise<MediaArchiveCandidate | undefined>;
  markMediaArchived(input: {
    mediaId: string;
    objectKey: string;
    thumbnailObjectKey: string;
    contentType: string;
    contentSha256: string;
    size: number;
    archivedAt: Date;
  }): Promise<void>;
  markMediaArchiveFailed(input: {
    mediaId: string;
    error: string;
    terminal: boolean;
    observedAt: Date;
  }): Promise<void>;

  listSchedulesForCatchUp(
    through: Date,
    limit: number,
  ): Promise<readonly ScheduleForCatchUp[]>;
  materializeScheduleOccurrences(input: {
    scheduleId: string;
    occurrences: readonly ScheduleOccurrenceInput[];
    scannedThrough: Date;
  }): Promise<void>;
  dispatchQueuedOccurrences(input: {
    through: Date;
    dailyLimit: number;
    limit: number;
  }): Promise<{
    dispatched: number;
    deferredForQuota: number;
    hasMore: boolean;
  }>;

  listPurgeCandidates(
    through: Date,
    limit: number,
  ): Promise<readonly PurgeCandidate[]>;
  finalizePurge(input: {
    entityType: PurgeCandidate["entityType"];
    entityId: string;
    providerTaskTombstoneHashes: readonly string[];
    purgedAt: Date;
  }): Promise<void>;

  getBillingReconciliationCursor(): Promise<BillingReconciliationCursor>;
  applyBillingReconciliation(input: {
    cursor: BillingReconciliationCursor;
    balance: MoliBalance;
    summary: MoliBillingSummary;
    records: MoliBillingRecordsPage;
    reconciledAt: Date;
  }): Promise<void>;
  upsertProviderCatalogDiscovery(input: {
    models: readonly MoliModel[];
    domesticRegions: readonly MoliRegion[];
    overseasRegions: readonly MoliRegion[];
    syncedAt: Date;
  }): Promise<void>;
}

export interface WorkerDependencies {
  repository: WorkerRepositoryPort;
  provider: MoliProviderPort;
  objectStore: PrivateObjectStore;
  logger: LoggerPort;
  now?: () => Date;
  mediaFetcher?: (
    url: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ) => Promise<FetchedMedia>;
  imageTransformer?: (body: Uint8Array) => Promise<ImageDerivatives>;
}

const REQUIRED_REPOSITORY_METHODS = [
  "leaseJobs",
  "completeJob",
  "renewJobLease",
  "deferJob",
  "retryJob",
  "deadLetterJob",
  "heartbeatWorker",
  "enqueueMaintenanceJobs",
  "acquireProviderSubmissionPermit",
  "getAttemptForSubmission",
  "markAttemptSubmissionAccepted",
  "markAttemptSubmissionUnknown",
  "recordProviderStopRequest",
  "getAttemptProviderState",
  "recordProviderStatus",
  "enqueueResultFetch",
  "applyAuthoritativeResult",
  "settleAttemptTerminalFailure",
  "getMediaArchiveCandidate",
  "markMediaArchived",
  "markMediaArchiveFailed",
  "listSchedulesForCatchUp",
  "materializeScheduleOccurrences",
  "dispatchQueuedOccurrences",
  "listPurgeCandidates",
  "finalizePurge",
  "getBillingReconciliationCursor",
  "applyBillingReconciliation",
  "upsertProviderCatalogDiscovery",
] as const satisfies readonly (keyof WorkerRepositoryPort)[];

export function assertWorkerRepositoryPort(
  value: unknown,
): asserts value is WorkerRepositoryPort {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Worker repository adapter is not an object");
  for (const method of REQUIRED_REPOSITORY_METHODS) {
    if (typeof (value as Record<string, unknown>)[method] !== "function") {
      throw new TypeError(`Worker repository adapter is missing ${method}()`);
    }
  }
}
