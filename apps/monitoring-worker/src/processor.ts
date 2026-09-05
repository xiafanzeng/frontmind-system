import { createHash } from "node:crypto";
import {
  MoliApiError,
  MoliHttpError,
  MoliSubmissionUnknownError,
  MoliTransportError,
  createConsumerTaskId,
  type MoliSubTaskStatus,
  type MoliTaskStatus,
} from "@frontmind/monitoring-provider-moli";
import {
  ObjectStoreError,
  RemoteMediaFetchError,
  RemoteMediaRejectedError,
  compressJsonPayload,
  createArchivedMediaKeys,
  createImageDerivatives,
  createRawResultObjectKey,
  fetchRemoteMedia,
} from "@frontmind/monitoring-object-store";
import { DeferJobError, TerminalJobError, safeErrorSummary } from "./errors.js";
import { requiredStringPayload, type WorkerJob } from "./job-types.js";
import type { WorkerDependencies } from "./ports.js";
import { RateGate } from "./rate-gate.js";
import { hashAuthoritativeResult } from "./result-hash.js";
import { enumerateScheduleOccurrences } from "./schedule.js";

export interface WorkerProcessorOptions {
  providerSubmitIntervalMs?: number;
  providerDailyDispatchLimit?: number;
  providerActiveAttemptLimit?: number;
  providerSubmissionConcurrency?: number;
  scheduleOccurrenceBatch?: number;
  scheduleScanBatch?: number;
  occurrenceDispatchBatch?: number;
  purgeBatch?: number;
  quotaDayTimezone?: string;
  pollIntervalMs?: number;
  incompleteResultDelayMs?: number;
  mediaMaxBytes?: number;
}

const TERMINAL_PROVIDER_STATUSES: ReadonlySet<MoliTaskStatus> = new Set([
  "failed",
  "stopped",
]);
const TERMINAL_RESULT_STATUSES: ReadonlySet<MoliTaskStatus> = new Set([
  "completed",
  "partial_completed",
  "failed",
  "stopped",
]);
const TERMINAL_RESULT_ITEM_STATUSES: ReadonlySet<MoliSubTaskStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "error",
]);
const PROVIDER_RECOVERY_DELAY_MS = 30_000;

function emptyAnswerTerminalStatus(
  itemStatus: MoliSubTaskStatus,
  resultStatus: MoliTaskStatus,
): "failed" | "stopped" | "error" | undefined {
  if (
    !TERMINAL_RESULT_ITEM_STATUSES.has(itemStatus) &&
    !TERMINAL_RESULT_STATUSES.has(resultStatus)
  ) {
    return undefined;
  }
  if (itemStatus === "stopped") return "stopped";
  if (itemStatus === "error") return "error";
  if (
    !TERMINAL_RESULT_ITEM_STATUSES.has(itemStatus) &&
    resultStatus === "stopped"
  ) {
    return "stopped";
  }
  return "failed";
}

function isRetryableProviderError(error: unknown): boolean {
  return (
    error instanceof MoliTransportError ||
    (error instanceof MoliHttpError && error.retryable) ||
    (error instanceof MoliApiError && error.retryable)
  );
}

function quotaDayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export class WorkerProcessor {
  private readonly now: () => Date;
  private readonly submitGate: RateGate;
  private readonly dailyLimit: number;
  private readonly activeAttemptLimit: number;
  private readonly submissionConcurrency: number;
  private readonly submitIntervalMs: number;
  private readonly occurrenceBatch: number;
  private readonly scheduleScanBatch: number;
  private readonly occurrenceDispatchBatch: number;
  private readonly purgeBatch: number;
  private readonly quotaTimezone: string;
  private readonly pollIntervalMs: number;
  private readonly incompleteResultDelayMs: number;
  private readonly mediaMaxBytes: number;

  constructor(
    private readonly dependencies: WorkerDependencies,
    options: WorkerProcessorOptions = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.submitIntervalMs = options.providerSubmitIntervalMs ?? 1_000;
    this.submitGate = new RateGate(this.submitIntervalMs);
    this.dailyLimit = options.providerDailyDispatchLimit ?? 1_000;
    this.activeAttemptLimit = options.providerActiveAttemptLimit ?? 20;
    this.submissionConcurrency = options.providerSubmissionConcurrency ?? 2;
    this.occurrenceBatch = options.scheduleOccurrenceBatch ?? 500;
    this.scheduleScanBatch = options.scheduleScanBatch ?? 100;
    this.occurrenceDispatchBatch = options.occurrenceDispatchBatch ?? 100;
    this.purgeBatch = options.purgeBatch ?? 50;
    this.quotaTimezone = options.quotaDayTimezone ?? "Asia/Shanghai";
    this.pollIntervalMs = options.pollIntervalMs ?? 7_000;
    this.incompleteResultDelayMs = options.incompleteResultDelayMs ?? 10_000;
    this.mediaMaxBytes = options.mediaMaxBytes ?? 15 * 1024 * 1024;
  }

  async handle(job: WorkerJob, signal?: AbortSignal): Promise<void> {
    switch (job.type) {
      case "submit_attempt":
        return this.submitAttempt(
          requiredStringPayload(job.payload, "attemptId"),
          signal,
        );
      case "stop_attempt":
        return this.stopAttempt(
          requiredStringPayload(job.payload, "attemptId"),
          signal,
        );
      case "poll_attempt":
        return this.pollAttempt(
          requiredStringPayload(job.payload, "attemptId"),
          signal,
        );
      case "fetch_result":
        return this.fetchResult(
          requiredStringPayload(job.payload, "attemptId"),
          signal,
        );
      case "archive_media":
        return this.archiveMedia(
          requiredStringPayload(job.payload, "mediaId"),
          signal,
        );
      case "schedule_catch_up":
        return this.catchUpSchedules();
      case "dispatch_occurrences":
        return this.dispatchOccurrences();
      case "purge_soft_deleted":
        return this.purgeSoftDeleted(signal);
      case "reconcile_billing":
        return this.reconcileBilling(signal);
      case "sync_provider_catalog":
        return this.syncProviderCatalog(signal);
      default: {
        const exhaustive: never = job.type;
        throw new TerminalJobError(
          `Unsupported job type: ${String(exhaustive)}`,
        );
      }
    }
  }

  private async submitAttempt(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const attempt =
      await this.dependencies.repository.getAttemptForSubmission(attemptId);
    if (!attempt) return;
    if (
      [
        "completed",
        "failed",
        "stopped",
        "error",
        "cancelled_before_submit",
        "review_required",
      ].includes(attempt.status)
    )
      return;

    const consumerTaskId =
      attempt.consumerTaskId ?? createConsumerTaskId(attempt.attemptId);
    // The local gate reduces contention; the following DB permit is the durable
    // cross-worker authority for 1 req/s, active=20 and submission concurrency=2.
    await this.submitGate.wait(signal);
    const at = this.now();
    const permit =
      await this.dependencies.repository.acquireProviderSubmissionPermit({
        attemptId,
        consumerTaskId,
        now: at,
        dayKey: quotaDayKey(at, this.quotaTimezone),
        dailyLimit: this.dailyLimit,
        activeLimit: this.activeAttemptLimit,
        submissionConcurrencyLimit: this.submissionConcurrency,
        minIntervalMs: this.submitIntervalMs,
      });
    if (permit.status === "terminal") return;
    if (permit.status === "deferred") {
      throw new DeferJobError(
        `Provider submission deferred: ${permit.reason}`,
        permit.retryAt,
      );
    }

    try {
      const submitted = await this.dependencies.provider.submitSingleAttempt(
        {
          attemptId,
          consumerTaskId,
          monitorKeyword: attempt.monitorKeyword,
          monitorKeywordAliases: attempt.monitorKeywordAliases,
          competitors: attempt.competitors,
          prompt: attempt.prompt,
          platform: attempt.platform,
          clientType: attempt.clientType,
          mode: attempt.mode,
          screenshot: attempt.screenshot,
          regionCode: attempt.regionCode,
          callbackUrl: attempt.callbackUrl,
        },
        signal,
      );
      const acceptedAt = this.now();
      await this.dependencies.repository.markAttemptSubmissionAccepted({
        attemptId,
        consumerTaskId,
        providerTaskId: submitted.taskId,
        providerSubTaskId: submitted.subTaskId,
        acceptedAt,
        nextPollAt: new Date(acceptedAt.valueOf() + this.pollIntervalMs),
      });
    } catch (error) {
      if (error instanceof MoliSubmissionUnknownError) {
        await this.dependencies.repository.markAttemptSubmissionUnknown({
          attemptId,
          consumerTaskId,
          observedAt: this.now(),
          reason: safeErrorSummary(error),
        });
        // Ambiguous submissions must not exhaust the durable job retry budget.
        // The attempt keeps its quota reservation and the next pass reuses the
        // exact same consumerTaskId until the provider resolves the request.
        throw new DeferJobError(
          "Provider submission outcome remains unknown",
          new Date(this.now().valueOf() + PROVIDER_RECOVERY_DELAY_MS),
        );
      }
      if (isRetryableProviderError(error)) {
        throw new DeferJobError(
          "Provider temporarily rejected task submission",
          new Date(this.now().valueOf() + PROVIDER_RECOVERY_DELAY_MS),
        );
      }
      await this.dependencies.repository.settleAttemptTerminalFailure({
        attemptId,
        status: "error",
        reason: safeErrorSummary(error),
        settledAt: this.now(),
      });
    }
  }

  private async stopAttempt(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state =
      await this.dependencies.repository.getAttemptProviderState(attemptId);
    if (!state) return;
    if (
      !state.providerTaskId &&
      ["submitting", "submission_unknown", "accepted", "processing"].includes(
        state.status,
      )
    ) {
      // The provider may already have accepted an ambiguous POST. Releasing the
      // reservation here would allow a later successful answer to escape quota
      // settlement. Keep both submit recovery and this stop request retrying
      // until the stable consumerTaskId resolves to an authoritative task ID.
      throw new DeferJobError(
        "Cannot stop an ambiguous provider submission before it is disambiguated",
        new Date(this.now().valueOf() + PROVIDER_RECOVERY_DELAY_MS),
      );
    }
    if (!state.providerTaskId) {
      await this.dependencies.repository.recordProviderStopRequest({
        attemptId,
        accepted: true,
        requestedAt: this.now(),
      });
      await this.dependencies.repository.settleAttemptTerminalFailure({
        attemptId,
        status: "stopped",
        reason: "Cancelled before provider submission",
        settledAt: this.now(),
      });
      return;
    }
    const stopped = await this.dependencies.provider.stopTask(
      state.providerTaskId,
      signal,
    );
    await this.dependencies.repository.recordProviderStopRequest({
      attemptId,
      providerTaskId: state.providerTaskId,
      accepted: stopped.accepted,
      providerRaw: stopped.raw,
      requestedAt: this.now(),
    });
    // Stop is best-effort. The existing poll job continues because an assigned
    // provider task may still complete and must then consume quota exactly once.
  }

  private async pollAttempt(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state =
      await this.dependencies.repository.getAttemptProviderState(attemptId);
    if (!state?.providerTaskId || state.status === "review_required") return;
    const status = await this.dependencies.provider.getTaskStatus(
      state.providerTaskId,
      signal,
    );
    const observedAt = this.now();
    if (
      status.status === "completed" ||
      status.status === "partial_completed"
    ) {
      await this.dependencies.repository.recordProviderStatus({
        attemptId,
        providerTaskId: state.providerTaskId,
        status: status.status,
        providerRaw: status.raw,
        observedAt,
      });
      await this.dependencies.repository.enqueueResultFetch(
        attemptId,
        observedAt,
      );
      return;
    }
    if (TERMINAL_PROVIDER_STATUSES.has(status.status)) {
      await this.dependencies.repository.recordProviderStatus({
        attemptId,
        providerTaskId: state.providerTaskId,
        status: status.status,
        providerRaw: status.raw,
        observedAt,
      });
      await this.dependencies.repository.settleAttemptTerminalFailure({
        attemptId,
        status: status.status === "stopped" ? "stopped" : "failed",
        providerRaw: status.raw,
        settledAt: observedAt,
      });
      return;
    }
    const nextPollAt = new Date(observedAt.valueOf() + this.pollIntervalMs);
    await this.dependencies.repository.recordProviderStatus({
      attemptId,
      providerTaskId: state.providerTaskId,
      status: status.status,
      providerRaw: status.raw,
      observedAt,
      nextPollAt,
    });
    throw new DeferJobError("Provider task is not terminal", nextPollAt);
  }

  private async fetchResult(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const state =
      await this.dependencies.repository.getAttemptProviderState(attemptId);
    if (!state?.providerTaskId || state.status === "review_required") return;
    const result = state.providerSubTaskId
      ? await this.dependencies.provider.getSubTaskResult(
          state.providerTaskId,
          state.providerSubTaskId,
          signal,
        )
      : await this.dependencies.provider.getTaskResult(
          state.providerTaskId,
          signal,
        );
    if (!state.providerSubTaskId && result.items.length > 1) {
      await this.dependencies.repository.markAttemptReviewRequired({
        attemptId,
        reason: `Provider returned ${result.items.length} result items for an attempt without a bound subtask id`,
        providerRaw: result.raw,
        observedAt: this.now(),
      });
      return;
    }
    const item = state.providerSubTaskId
      ? result.items.find(
          (candidate) => candidate.subTaskId === state.providerSubTaskId,
        )
      : result.items.length === 1
        ? result.items[0]
        : undefined;
    if (!item) {
      if (TERMINAL_RESULT_STATUSES.has(result.status)) {
        await this.dependencies.repository.settleAttemptTerminalFailure({
          attemptId,
          status: result.status === "stopped" ? "stopped" : "failed",
          providerRaw: result.raw,
          reason:
            result.status === "completed" ||
            result.status === "partial_completed"
              ? "Provider completed without an answer"
              : "Provider returned no answer",
          settledAt: this.now(),
        });
        return;
      }
      throw new DeferJobError(
        "Authoritative result is not available yet",
        new Date(this.now().valueOf() + this.incompleteResultDelayMs),
      );
    }

    if (!item.answerContent.trim()) {
      const terminalStatus = emptyAnswerTerminalStatus(
        item.status,
        result.status,
      );
      if (terminalStatus) {
        await this.dependencies.repository.settleAttemptTerminalFailure({
          attemptId,
          status: terminalStatus,
          reason: item.errorMessage ?? "Provider returned an empty answer",
          providerRaw: result.raw,
          settledAt: this.now(),
        });
        return;
      }
      throw new DeferJobError(
        "Provider result does not contain an answer yet",
        new Date(this.now().valueOf() + this.incompleteResultDelayMs),
      );
    }

    const contentHash = hashAuthoritativeResult(item);
    const compressedRaw = compressJsonPayload(result.raw);
    const rawObjectKey = createRawResultObjectKey({
      tenantId: state.tenantId,
      projectId: state.projectId,
      runId: state.runId,
      attemptId,
      sha256: compressedRaw.sha256,
    });
    await this.dependencies.objectStore.put(
      {
        key: rawObjectKey,
        body: compressedRaw.body,
        contentType: "application/gzip",
        contentSha256: compressedRaw.sha256,
        metadata: {
          format: "provider-json-gzip",
          "uncompressed-bytes": String(compressedRaw.uncompressedBytes),
        },
      },
      signal,
    );

    const outcome = await this.dependencies.repository.applyAuthoritativeResult(
      {
        attemptId,
        providerTaskId: state.providerTaskId,
        contentHash,
        item,
        providerRaw: result.raw,
        rawObjectKey,
        observedAt: this.now(),
      },
    );
    if (outcome.retainedRawObjectKey !== rawObjectKey) {
      // A provider envelope may change while normalized answer content remains
      // identical. The DB keeps the first immutable revision; remove this
      // unreferenced upload so timestamp-only refreshes cannot leak OSS objects.
      await this.dependencies.objectStore.delete(rawObjectKey, signal);
    }
    this.dependencies.logger.info("Applied authoritative provider result", {
      attemptId,
      revisionCreated: outcome.revisionCreated,
      quotaConsumed: outcome.quotaConsumed,
      mediaJobsCreated: outcome.mediaJobsCreated,
    });
  }

  private async archiveMedia(
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate =
      await this.dependencies.repository.getMediaArchiveCandidate(mediaId);
    if (!candidate) return;
    try {
      const fetched = await (
        this.dependencies.mediaFetcher ?? fetchRemoteMedia
      )(candidate.sourceUrl, {
        maxBytes: this.mediaMaxBytes,
        signal,
      });
      const keys = createArchivedMediaKeys({
        tenantId: candidate.tenantId,
        projectId: candidate.projectId,
        runId: candidate.runId,
        attemptId: candidate.attemptId,
        sha256: fetched.sha256,
      });
      const derivatives = await (
        this.dependencies.imageTransformer ?? createImageDerivatives
      )(fetched.body);
      await Promise.all([
        this.dependencies.objectStore.put(
          {
            key: keys.original,
            body: fetched.body,
            contentType: fetched.contentType,
            contentSha256: fetched.sha256,
            metadata: {
              kind: candidate.kind.slice(0, 64),
              variant: "original",
            },
          },
          signal,
        ),
        this.dependencies.objectStore.put(
          {
            key: keys.display,
            body: derivatives.display.body,
            contentType: derivatives.display.contentType,
            contentSha256: derivatives.display.sha256,
            metadata: { kind: candidate.kind.slice(0, 64), variant: "display" },
          },
          signal,
        ),
        this.dependencies.objectStore.put(
          {
            key: keys.thumbnail,
            body: derivatives.thumbnail.body,
            contentType: derivatives.thumbnail.contentType,
            contentSha256: derivatives.thumbnail.sha256,
            metadata: {
              kind: candidate.kind.slice(0, 64),
              variant: "thumbnail",
            },
          },
          signal,
        ),
      ]);
      await this.dependencies.repository.markMediaArchived({
        mediaId,
        objectKey: keys.display,
        thumbnailObjectKey: keys.thumbnail,
        contentType: derivatives.display.contentType,
        contentSha256: derivatives.display.sha256,
        size: derivatives.display.size,
        archivedAt: this.now(),
      });
    } catch (error) {
      const terminal = error instanceof RemoteMediaRejectedError;
      await this.dependencies.repository.markMediaArchiveFailed({
        mediaId,
        error: safeErrorSummary(error),
        terminal,
        observedAt: this.now(),
      });
      if (terminal) return;
      if (
        error instanceof RemoteMediaFetchError ||
        error instanceof ObjectStoreError
      )
        throw error;
      throw error;
    }
  }

  private async catchUpSchedules(): Promise<void> {
    const through = this.now();
    const schedules =
      await this.dependencies.repository.listSchedulesForCatchUp(
        through,
        this.scheduleScanBatch,
      );
    let hasMore = schedules.length === this.scheduleScanBatch;
    for (const schedule of schedules) {
      const enumerated = enumerateScheduleOccurrences(
        schedule,
        through,
        this.occurrenceBatch,
      );
      await this.dependencies.repository.materializeScheduleOccurrences({
        scheduleId: schedule.scheduleId,
        occurrences: enumerated.occurrences,
        scannedThrough: enumerated.scannedThrough,
      });
      hasMore ||= enumerated.hasMore;
    }
    if (hasMore)
      throw new DeferJobError(
        "More schedules require catch-up",
        new Date(through.valueOf() + 100),
      );
  }

  private async dispatchOccurrences(): Promise<void> {
    const through = this.now();
    const outcome =
      await this.dependencies.repository.dispatchQueuedOccurrences({
        through,
        dailyLimit: this.dailyLimit,
        limit: this.occurrenceDispatchBatch,
      });
    if (outcome.hasMore) {
      throw new DeferJobError(
        "More schedule occurrences are ready",
        new Date(through.valueOf() + 500),
      );
    }
  }

  private async purgeSoftDeleted(signal?: AbortSignal): Promise<void> {
    const through = this.now();
    const candidates = await this.dependencies.repository.listPurgeCandidates(
      through,
      this.purgeBatch,
    );
    for (const candidate of candidates) {
      for (const objectKey of candidate.objectKeys) {
        await this.dependencies.objectStore.delete(objectKey, signal);
      }
      const providerTaskTombstoneHashes = candidate.providerTaskIds.map(
        (taskId) => createHash("sha256").update(taskId).digest("hex"),
      );
      await this.dependencies.repository.finalizePurge({
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        providerTaskTombstoneHashes,
        purgedAt: this.now(),
      });
    }
    if (candidates.length === this.purgeBatch) {
      throw new DeferJobError(
        "More soft-deleted entities require purge",
        new Date(through.valueOf() + 500),
      );
    }
  }

  private async reconcileBilling(signal?: AbortSignal): Promise<void> {
    const cursor =
      await this.dependencies.repository.getBillingReconciliationCursor();
    const query = {
      startDate: cursor.startDate,
      endDate: cursor.endDate,
      pageNum: cursor.page,
      pageSize: cursor.pageSize,
    };
    const [balance, summary, records] = await Promise.all([
      this.dependencies.provider.getBalance(signal),
      this.dependencies.provider.getBillingSummary(query, signal),
      this.dependencies.provider.getBillingRecords(query, signal),
    ]);
    await this.dependencies.repository.applyBillingReconciliation({
      cursor,
      balance,
      summary,
      records,
      reconciledAt: this.now(),
    });
    const page = records.page ?? cursor.page;
    const pageSize = records.pageSize ?? cursor.pageSize;
    if (records.total !== undefined && page * pageSize < records.total) {
      throw new DeferJobError(
        "More billing pages require reconciliation",
        new Date(this.now().valueOf() + 100),
      );
    }
  }

  private async syncProviderCatalog(signal?: AbortSignal): Promise<void> {
    const [models, domesticRegions, overseasRegions] = await Promise.all([
      this.dependencies.provider.listModels(signal),
      this.dependencies.provider.listDomesticRegions(signal),
      this.dependencies.provider.listOverseasRegions(signal),
    ]);
    await this.dependencies.repository.upsertProviderCatalogDiscovery({
      models,
      domesticRegions,
      overseasRegions,
      syncedAt: this.now(),
    });
  }
}
