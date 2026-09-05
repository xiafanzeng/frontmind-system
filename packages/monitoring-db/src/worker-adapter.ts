import { syncDashboardMonitoringAccountStates } from "./dashboard-account-links.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  MoliBalance,
  MoliBillingRecordsPage,
  MoliBillingSummary,
  MoliModel,
  MoliReference,
  MoliRegion,
  MoliResultItem,
  MoliTaskStatusResponse,
} from "@frontmind/monitoring-provider-moli";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import { officialPricingClassForKnownProvider } from "./billing.js";
import { settleAttemptMoney } from "./money-settlement.js";
import { platformAcceptanceFingerprint } from "./platform-acceptance.js";
import {
  computeNextRunAt,
  MonitoringRepository,
  pollAttemptJobDedupeKey,
  RepositoryError,
} from "./repositories.js";
import {
  auditLogs,
  attempts,
  attemptMoneySettlements,
  attemptPriceSnapshots,
  attemptResults,
  dailyRunAggregates,
  jobs,
  monitors,
  monitorVersions,
  platformCatalog,
  projectBrandVersions,
  projects,
  providerCosts,
  providerDispatchDays,
  providerDispatchSlots,
  providerObservations,
  providerReconciliationState,
  providerRegions,
  providerSubmissionGate,
  providerTaskTombstones,
  moneyLedger,
  quotaLedger,
  quotaReservations,
  resultDiscoveredSources,
  resultMedia,
  resultRevisions,
  resultSources,
  runMetricDomains,
  runMetrics,
  runs,
  scheduleOccurrences,
  sessions,
  users,
  workerHeartbeats,
} from "./schema.js";
import type { RunCompetitorMetric, RunModelMetric } from "./schema.js";

type WorkerJobType = typeof jobs.$inferSelect.type;
type WorkerJob = {
  id: string;
  type: WorkerJobType;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  leasedUntil: Date;
};
type BillingCursor = {
  startDate: string;
  endDate: string;
  page: number;
  pageSize: number;
};

export function createWorkerRepository({ env }: { env: NodeJS.ProcessEnv }) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required by @frontmind/monitoring-db/worker-adapter");
  const { db } = createDatabase(databaseUrl, {
    connectionLimit: Number(env.WORKER_DB_POOL_SIZE ?? 8),
  });
  return new DrizzleWorkerRepository(db, env.MOLI_CALLBACK_URL?.trim());
}

export class DrizzleWorkerRepository {
  private readonly monitoring: MonitoringRepository;

  constructor(
    private readonly db: Database,
    private readonly callbackUrl?: string,
  ) {
    this.monitoring = new MonitoringRepository(db);
  }

  async leaseJobs(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
  }): Promise<readonly WorkerJob[]> {
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(jobs)
        .where(
          and(
            or(
              and(
                inArray(jobs.status, ["ready", "retry_wait"]),
                lte(jobs.availableAt, input.now),
              ),
              and(
                eq(jobs.status, "leased"),
                lte(jobs.leaseExpiresAt, input.now),
              ),
            ),
            sql`${jobs.attempts} < ${jobs.maxAttempts}`,
          ),
        )
        .orderBy(asc(jobs.availableAt), asc(jobs.createdAt))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) return [];
      const leasedUntil = new Date(input.now.getTime() + input.leaseMs);
      await tx
        .update(jobs)
        .set({
          status: "leased",
          leaseOwner: input.workerId,
          leaseExpiresAt: leasedUntil,
        })
        .where(
          inArray(
            jobs.id,
            candidates.map((job) => job.id),
          ),
        );
      return candidates.map((job) => ({
        id: job.id,
        type: job.type,
        payload: job.payload,
        attemptCount: job.attempts,
        maxAttempts: job.maxAttempts,
        leasedUntil,
      }));
    });
  }

  async completeJob(jobId: string, workerId: string, completedAt: Date) {
    await this.db
      .update(jobs)
      .set({
        status: "succeeded",
        completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwner, workerId),
        ),
      );
  }

  async renewJobLease(jobId: string, workerId: string, leasedUntil: Date) {
    await this.db
      .update(jobs)
      .set({ leaseExpiresAt: leasedUntil })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwner, workerId),
        ),
      );
  }

  async deferJob(
    jobId: string,
    workerId: string,
    availableAt: Date,
    reason: string,
  ) {
    await this.db
      .update(jobs)
      .set({
        status: "retry_wait",
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "DEFERRED",
        lastErrorMessage: truncate(reason, 4_000),
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwner, workerId),
        ),
      );
  }

  async retryJob(input: {
    jobId: string;
    workerId: string;
    availableAt: Date;
    error: string;
  }) {
    await this.db
      .update(jobs)
      .set({
        status: "retry_wait",
        availableAt: input.availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: sql`${jobs.attempts} + 1`,
        lastErrorCode: "RETRYABLE",
        lastErrorMessage: truncate(input.error, 4_000),
      })
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwner, input.workerId),
        ),
      );
  }

  async deadLetterJob(input: {
    jobId: string;
    workerId: string;
    failedAt: Date;
    error: string;
  }) {
    const [candidate] = await this.db
      .select({ type: jobs.type, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwner, input.workerId),
        ),
      )
      .limit(1);
    if (!candidate) return;
    const attemptJob = [
      "submit_attempt",
      "stop_attempt",
      "poll_attempt",
      "fetch_result",
    ].includes(candidate.type);
    const candidateAttemptId = attemptJob
      ? payloadString(candidate.payload, "attemptId")
      : undefined;
    const candidateMediaId =
      candidate.type === "archive_media"
        ? payloadString(candidate.payload, "mediaId")
        : undefined;
    const [locatedAttempt] = candidateAttemptId
      ? await this.db
          .select({ runId: attempts.runId })
          .from(attempts)
          .where(eq(attempts.id, candidateAttemptId))
          .limit(1)
      : [];

    await this.db.transaction(async (tx) => {
      let lockedAttempt:
        | Pick<typeof attempts.$inferSelect, "id" | "runId" | "status">
        | undefined;
      if (candidateAttemptId && locatedAttempt) {
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.id, locatedAttempt.runId))
          .for("update")
          .limit(1);
        if (run) {
          [lockedAttempt] = await tx
            .select({
              id: attempts.id,
              runId: attempts.runId,
              status: attempts.status,
            })
            .from(attempts)
            .where(
              and(
                eq(attempts.id, candidateAttemptId),
                eq(attempts.runId, run.id),
              ),
            )
            .for("update")
            .limit(1);
        }
      }
      const [lockedMedia] = candidateMediaId
        ? await tx
            .select({ id: resultMedia.id })
            .from(resultMedia)
            .where(eq(resultMedia.id, candidateMediaId))
            .for("update")
            .limit(1)
        : [];
      const [job] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, "leased"),
            eq(jobs.leaseOwner, input.workerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!job) return;
      const error = truncate(input.error, 4_000);
      await tx
        .update(jobs)
        .set({
          status: "dead",
          completedAt: input.failedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          attempts: sql`${jobs.attempts} + 1`,
          lastErrorCode: "DEAD_LETTER",
          lastErrorMessage: error,
        })
        .where(eq(jobs.id, input.jobId));

      const attemptId = payloadString(job.payload, "attemptId");
      if (
        attemptId &&
        attemptId === candidateAttemptId &&
        lockedAttempt &&
        [
          "submit_attempt",
          "stop_attempt",
          "poll_attempt",
          "fetch_result",
        ].includes(job.type)
      ) {
        if (!terminalAttempt(lockedAttempt.status)) {
          await settleAttemptMoney(tx, {
            attemptId: lockedAttempt.id,
            settlement: "released",
            settledAt: input.failedAt,
            reason: "Execution job exhausted retries and requires review",
          });
          await tx
            .update(attempts)
            .set({
              status: "review_required",
              errorCode: "JOB_DEAD_LETTER",
              errorMessage: error,
            })
            .where(eq(attempts.id, attemptId));
          await tx
            .update(runs)
            .set({ status: "review_required" })
            .where(
              and(
                eq(runs.id, lockedAttempt.runId),
                inArray(runs.status, [
                  "queued",
                  "waiting_quota",
                  "running",
                  "review_required",
                ]),
              ),
            );
          await refreshRunSubmittedAttempts(tx, lockedAttempt.runId);
        }
      }

      const mediaId = payloadString(job.payload, "mediaId");
      if (
        mediaId &&
        mediaId === candidateMediaId &&
        lockedMedia &&
        job.type === "archive_media"
      ) {
        await tx
          .update(resultMedia)
          .set({ archiveStatus: "failed", archiveError: error })
          .where(
            and(
              eq(resultMedia.id, mediaId),
              eq(resultMedia.archiveStatus, "pending"),
            ),
          );
      }
    });
  }

  async heartbeatWorker(workerId: string, at: Date) {
    await syncDashboardMonitoringAccountStates(this.db);
    await this.db
      .insert(workerHeartbeats)
      .values({ workerId, heartbeatAt: at })
      .onDuplicateKeyUpdate({ set: { heartbeatAt: at } });
  }

  async enqueueMaintenanceJobs(at: Date) {
    const minute = at.toISOString().slice(0, 16);
    const hour = at.toISOString().slice(0, 13);
    const day = at.toISOString().slice(0, 10);
    const values: Array<typeof jobs.$inferInsert> = [
      maintenance("schedule_catch_up", minute, at),
      maintenance("dispatch_occurrences", minute, at),
      maintenance("purge_soft_deleted", hour, at),
      maintenance("reconcile_billing", hour, at),
      maintenance("sync_provider_catalog", day, at),
    ];
    await this.db
      .insert(jobs)
      .values(values)
      .onDuplicateKeyUpdate({ set: { dedupeKey: sql`${jobs.dedupeKey}` } });
  }

  async acquireProviderSubmissionPermit(input: {
    attemptId: string;
    consumerTaskId: string;
    now: Date;
    dayKey: string;
    dailyLimit: number;
    activeLimit: number;
    submissionConcurrencyLimit: number;
    minIntervalMs: number;
  }): Promise<
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
    | { status: "terminal" }
  > {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt) return { status: "terminal" as const };

    return this.db.transaction(async (tx) => {
      // Progress snapshots and terminal transitions serialize by run. Keep the
      // same run -> attempt order here so permit acquisition cannot deadlock
      // with cancellation, acceptance, polling, or terminal settlement.
      const [run] = await tx
        .select({ id: runs.id, startedAt: runs.startedAt })
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run) return { status: "terminal" as const };
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt || terminalAttempt(attempt.status))
        return { status: "terminal" as const };
      if (
        attempt.consumerTaskId &&
        attempt.consumerTaskId !== input.consumerTaskId
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Attempt consumer task id cannot change",
        );
      }

      await tx
        .insert(providerSubmissionGate)
        .values({
          id: "moli",
          nextAllowedAt: new Date(0),
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`${providerSubmissionGate.id}` },
        });
      const [gate] = await tx
        .select()
        .from(providerSubmissionGate)
        .where(eq(providerSubmissionGate.id, "moli"))
        .for("update")
        .limit(1);
      if (!gate)
        throw new RepositoryError(
          "INVALID_STATE",
          "Provider submission gate is unavailable",
        );
      if (gate.nextAllowedAt > input.now) {
        return {
          status: "deferred" as const,
          reason: "rate_limit" as const,
          retryAt: gate.nextAllowedAt,
        };
      }

      const activeStatuses = [
        "submitting",
        "submission_unknown",
        "accepted",
        "processing",
      ] as const;
      const [activeCount] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(attempts)
        .where(
          and(
            inArray(attempts.status, activeStatuses),
            sql`${attempts.id} <> ${input.attemptId}`,
          ),
        );
      if (Number(activeCount?.count ?? 0) >= input.activeLimit) {
        return {
          status: "deferred" as const,
          reason: "active_limit" as const,
          retryAt: new Date(input.now.getTime() + 5_000),
        };
      }
      const [submittingCount] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(attempts)
        .where(
          and(
            eq(attempts.status, "submitting"),
            sql`${attempts.id} <> ${input.attemptId}`,
          ),
        );
      if (
        Number(submittingCount?.count ?? 0) >= input.submissionConcurrencyLimit
      ) {
        return {
          status: "deferred" as const,
          reason: "submission_concurrency" as const,
          retryAt: new Date(input.now.getTime() + 1_000),
        };
      }

      const [existing] = await tx
        .select()
        .from(providerDispatchSlots)
        .where(eq(providerDispatchSlots.attemptId, input.attemptId))
        .limit(1);
      await tx
        .insert(providerDispatchDays)
        .values({ dayKey: input.dayKey, dispatched: 0 })
        .onDuplicateKeyUpdate({
          set: { dayKey: sql`${providerDispatchDays.dayKey}` },
        });
      const [day] = await tx
        .select()
        .from(providerDispatchDays)
        .where(eq(providerDispatchDays.dayKey, input.dayKey))
        .for("update")
        .limit(1);
      if (!day)
        throw new RepositoryError(
          "INVALID_STATE",
          "Provider daily dispatch counter is unavailable",
        );
      if (!existing && day.dispatched >= input.dailyLimit) {
        return {
          status: "deferred" as const,
          reason: "daily_limit" as const,
          retryAt: nextShanghaiDay(input.now),
        };
      }
      if (!existing) {
        await tx.insert(providerDispatchSlots).values({
          attemptId: input.attemptId,
          dayKey: input.dayKey,
          acquiredAt: input.now,
        });
        await tx
          .update(providerDispatchDays)
          .set({ dispatched: day.dispatched + 1 })
          .where(eq(providerDispatchDays.dayKey, input.dayKey));
      }
      const nextAllowedAt = new Date(
        input.now.getTime() + Math.max(0, input.minIntervalMs),
      );
      await tx
        .update(providerSubmissionGate)
        .set({ nextAllowedAt })
        .where(eq(providerSubmissionGate.id, "moli"));
      await tx
        .update(attempts)
        .set({
          status: "submitting",
          consumerTaskId: input.consumerTaskId,
          submittedAt: attempt.submittedAt ?? input.now,
        })
        .where(eq(attempts.id, input.attemptId));
      await tx
        .update(runs)
        .set({
          status: "running",
          // Keep Date values on the column-mapped path. Interpolating a Date
          // into raw SQL lets mysql2 format it in the process timezone, while
          // Drizzle's DATETIME mapper writes an absolute instant as UTC.
          startedAt: run.startedAt ?? input.now,
        })
        .where(and(eq(runs.id, run.id), eq(runs.status, "queued")));
      await refreshRunSubmittedAttempts(tx, run.id);
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "submission",
        status: "submitting",
        observedAt: input.now,
      });
      return { status: "acquired" as const };
    });
  }

  async getAttemptForSubmission(attemptId: string) {
    const [row] = await this.db
      .select({
        attempt: attempts,
        run: runs,
        brand: projectBrandVersions,
        version: monitorVersions,
      })
      .from(attempts)
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .innerJoin(
        projectBrandVersions,
        eq(runs.projectBrandVersionId, projectBrandVersions.id),
      )
      .innerJoin(monitorVersions, eq(runs.monitorVersionId, monitorVersions.id))
      .where(eq(attempts.id, attemptId))
      .limit(1);
    if (!row) return undefined;
    return {
      attemptId: row.attempt.id,
      tenantId: row.attempt.ownerId,
      projectId: row.run.projectId,
      runId: row.run.id,
      status: row.attempt.status,
      consumerTaskId: row.attempt.consumerTaskId,
      monitorKeyword: row.brand.mainBrand,
      monitorKeywordAliases: row.version.brandAliases,
      competitors: row.version.competitors,
      prompt: row.attempt.question,
      platform: row.attempt.providerCode,
      clientType: row.attempt.clientType,
      mode: row.attempt.mode,
      screenshot: assertScreenshot(row.attempt.screenshot),
      ...(row.attempt.regionCode ? { regionCode: row.attempt.regionCode } : {}),
      ...(this.callbackUrl ? { callbackUrl: this.callbackUrl } : {}),
    };
  }

  async markAttemptSubmissionAccepted(input: {
    attemptId: string;
    consumerTaskId: string;
    providerTaskId: string;
    providerSubTaskId?: string;
    acceptedAt: Date;
    nextPollAt: Date;
  }) {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt) return;

    await this.db.transaction(async (tx) => {
      // Serialize progress snapshots for attempts in the same run and retain
      // the run -> attempt lock order used by terminal transitions.
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run) return;
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt || terminalAttempt(attempt.status)) return;
      if (
        attempt.providerTaskId &&
        attempt.providerTaskId !== input.providerTaskId
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Attempt is already bound to a different provider task",
        );
      }
      if (
        attempt.providerSubTaskId &&
        input.providerSubTaskId &&
        attempt.providerSubTaskId !== input.providerSubTaskId
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Attempt is already bound to a different provider subtask",
        );
      }
      const providerSubTaskId =
        input.providerSubTaskId ?? attempt.providerSubTaskId;
      await tx
        .update(attempts)
        .set({
          status: "accepted",
          consumerTaskId: input.consumerTaskId,
          providerTaskId: input.providerTaskId,
          providerSubTaskId,
          submittedAt: attempt.submittedAt ?? input.acceptedAt,
          nextPollAt: input.nextPollAt,
        })
        .where(eq(attempts.id, input.attemptId));
      await refreshRunSubmittedAttempts(tx, run.id);
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "submission",
        status: "accepted",
        payload: {
          providerTaskId: input.providerTaskId,
          providerSubTaskId: providerSubTaskId ?? null,
        },
        observedAt: input.acceptedAt,
      });
      await enqueueJob(
        tx,
        "poll_attempt",
        pollAttemptJobDedupeKey(input.attemptId),
        { attemptId: input.attemptId },
        input.nextPollAt,
      );
    });
  }

  async markAttemptSubmissionUnknown(input: {
    attemptId: string;
    consumerTaskId: string;
    observedAt: Date;
    reason: string;
  }) {
    // submitting and submission_unknown both count as submitted. The permit
    // transaction already refreshed the run, so this path needs no run lock.
    await this.db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: "submission_unknown",
          consumerTaskId: input.consumerTaskId,
          errorCode: "SUBMISSION_UNKNOWN",
          errorMessage: truncate(input.reason, 4_000),
        })
        .where(
          and(
            eq(attempts.id, input.attemptId),
            inArray(attempts.status, ["submitting", "submission_unknown"]),
          ),
        );
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "submission",
        status: "submission_unknown",
        payload: { reason: truncate(input.reason, 1_000) },
        observedAt: input.observedAt,
      });
    });
  }

  async recordProviderStopRequest(input: {
    attemptId: string;
    providerTaskId?: string;
    accepted: boolean;
    providerRaw?: unknown;
    requestedAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          stopRequestedAt: input.requestedAt,
          stopAccepted: input.accepted,
        })
        .where(eq(attempts.id, input.attemptId));
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "stop",
        status: input.accepted ? "accepted" : "rejected",
        payload: asRecord(input.providerRaw),
        observedAt: input.requestedAt,
      });
    });
  }

  async getAttemptProviderState(attemptId: string) {
    const [row] = await this.db
      .select({ attempt: attempts, run: runs })
      .from(attempts)
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .where(eq(attempts.id, attemptId))
      .limit(1);
    if (!row) return undefined;
    return {
      attemptId: row.attempt.id,
      tenantId: row.attempt.ownerId,
      projectId: row.run.projectId,
      runId: row.run.id,
      ...(row.attempt.providerTaskId
        ? { providerTaskId: row.attempt.providerTaskId }
        : {}),
      ...(row.attempt.providerSubTaskId
        ? { providerSubTaskId: row.attempt.providerSubTaskId }
        : {}),
      status: row.attempt.status,
    };
  }

  async recordProviderStatus(input: {
    attemptId: string;
    providerTaskId: string;
    status: MoliTaskStatusResponse["status"];
    providerRaw: unknown;
    observedAt: Date;
    nextPollAt?: Date;
  }) {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt) return;

    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run) return;
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt || terminalAttempt(attempt.status)) return;
      if (
        attempt.providerTaskId &&
        attempt.providerTaskId !== input.providerTaskId
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Provider task id does not match the bound attempt",
        );
      }
      const nextStatus =
        input.status === "processing"
          ? "processing"
          : input.status === "pending"
            ? "accepted"
            : attempt.status;
      await tx
        .update(attempts)
        .set({
          status: nextStatus,
          providerTaskId: input.providerTaskId,
          nextPollAt: input.nextPollAt ?? null,
        })
        .where(eq(attempts.id, input.attemptId));
      await refreshRunSubmittedAttempts(tx, run.id);
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "status",
        status: input.status,
        payload: asRecord(input.providerRaw),
        observedAt: input.observedAt,
      });
    });
  }

  async enqueueResultFetch(attemptId: string, availableAt: Date) {
    await this.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        type: "fetch_result",
        dedupeKey: `fetch:${attemptId}`,
        payload: { attemptId },
        availableAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: "ready",
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
  }

  async applyAuthoritativeResult(input: {
    attemptId: string;
    providerTaskId: string;
    contentHash: string;
    item: MoliResultItem;
    providerRaw: unknown;
    rawObjectKey: string;
    observedAt: Date;
  }) {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt)
      throw new RepositoryError("NOT_FOUND", "Attempt not found");

    return this.db.transaction(async (tx) => {
      // All state transitions that can finish a run use run -> attempt lock
      // order. In addition to matching cancelRun, taking the run lock before
      // the first consistent read makes the later attempt-status snapshot see
      // every terminal transaction that committed while this one was waiting.
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run)
        throw new RepositoryError("INVALID_STATE", "Attempt run not found");
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt) throw new RepositoryError("NOT_FOUND", "Attempt not found");
      if (
        attempt.providerTaskId &&
        attempt.providerTaskId !== input.providerTaskId
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Provider task id does not match the bound attempt",
        );
      }
      if (!input.item.answerContent.trim()) {
        const reason =
          input.item.errorMessage?.trim() ||
          "Provider returned an empty authoritative answer";
        if (attempt.status !== "completed") {
          await settleAttemptMoney(tx, {
            attemptId: attempt.id,
            settlement: "released",
            settledAt: input.observedAt,
            reason,
          });
          await tx
            .update(attempts)
            .set({
              status: "failed",
              providerTaskId: input.providerTaskId,
              providerSubTaskId:
                input.item.subTaskId ?? attempt.providerSubTaskId,
              providerUpdatedAtRaw: normalizeRawTimestamp(
                input.item.rawUpdatedAt,
              ),
              terminalAt: input.observedAt,
              nextPollAt: null,
              errorCode: "EMPTY_ANSWER",
              errorMessage: truncate(reason, 4_000),
            })
            .where(eq(attempts.id, input.attemptId));
        }
        await tx.insert(providerObservations).values({
          id: randomUUID(),
          attemptId: input.attemptId,
          type: "failure",
          status: "failed",
          payload: {
            reason,
            provider: asRecord(input.providerRaw),
          },
          observedAt: input.observedAt,
        });
        await refreshRunState(tx, run, input.observedAt);
        return {
          revisionCreated: false,
          quotaConsumed: false,
          mediaJobsCreated: 0,
          // No result revision owns this proposed archive. The Worker compares
          // this sentinel with the uploaded key and removes the orphan.
          retainedRawObjectKey: "",
        };
      }
      const [previousResult] = await tx
        .select({
          currentRevisionId: attemptResults.currentRevisionId,
          sentiment: attemptResults.sentiment,
          brandMentioned: attemptResults.brandMentioned,
          mentionPosition: attemptResults.mentionPosition,
          competitorRankings: attemptResults.competitorRankings,
        })
        .from(attemptResults)
        .where(eq(attemptResults.attemptId, input.attemptId))
        .limit(1);
      const [duplicate] = await tx
        .select()
        .from(resultRevisions)
        .where(
          and(
            eq(resultRevisions.attemptId, input.attemptId),
            eq(resultRevisions.contentHash, input.contentHash),
          ),
        )
        .limit(1);
      if (duplicate) {
        const retainedRawObjectKey =
          duplicate.rawObjectKey ?? input.rawObjectKey;
        if (!duplicate.rawObjectKey) {
          await tx
            .update(resultRevisions)
            .set({ rawObjectKey: retainedRawObjectKey })
            .where(eq(resultRevisions.id, duplicate.id));
        }
        // Content revisions are immutable and hash-deduplicated. If the
        // provider oscillates A -> B -> A, make the existing A snapshot current
        // again; a duplicate of the already-current snapshot remains a no-op.
        if (previousResult?.currentRevisionId !== duplicate.id) {
          if (!previousResult) {
            throw new RepositoryError(
              "INVALID_STATE",
              "Historical result revision has no current result",
            );
          }
          const [brand] = await tx
            .select()
            .from(projectBrandVersions)
            .where(eq(projectBrandVersions.id, run.projectBrandVersionId))
            .limit(1);
          const previousDomains = await tx
            .select({ domain: resultSources.domain })
            .from(resultSources)
            .where(
              eq(resultSources.revisionId, previousResult.currentRevisionId),
            );
          const restoredDomains = await tx
            .select({ domain: resultSources.domain })
            .from(resultSources)
            .where(eq(resultSources.revisionId, duplicate.id));
          const resultValues = resultValuesFromNormalizedPayload({
            revision: duplicate,
            mainBrand: brand?.mainBrand ?? null,
          });
          await tx
            .update(attemptResults)
            .set(resultValues)
            .where(eq(attemptResults.attemptId, input.attemptId));
          await updateRunMetrics(tx, {
            attempt,
            previousResult,
            previousDomains: previousDomains.map((row) => row.domain),
            nextResult: {
              sentiment: resultValues.sentiment,
              brandMentioned: resultValues.brandMentioned,
              mentionPosition: resultValues.mentionPosition,
              competitorRankings: resultValues.competitorRankings,
            },
            nextDomains: restoredDomains.map((row) => row.domain),
          });
        }
        return {
          revisionCreated: false,
          quotaConsumed: false,
          mediaJobsCreated: 0,
          retainedRawObjectKey,
        };
      }

      const previousDomains = previousResult
        ? await tx
            .select({ domain: resultSources.domain })
            .from(resultSources)
            .where(
              eq(resultSources.revisionId, previousResult.currentRevisionId),
            )
        : [];

      const [latest] = await tx
        .select({ revision: resultRevisions.revision })
        .from(resultRevisions)
        .where(eq(resultRevisions.attemptId, input.attemptId))
        .orderBy(desc(resultRevisions.revision))
        .limit(1);
      const revision = (latest?.revision ?? 0) + 1;
      const revisionId = randomUUID();
      const normalizedPayload = normalizedResultPayload(input.item);
      await tx.insert(resultRevisions).values({
        id: revisionId,
        attemptId: input.attemptId,
        revision,
        contentHash: input.contentHash,
        normalizedPayload,
        rawObjectKey: input.rawObjectKey,
        providerUpdatedAtRaw: normalizeRawTimestamp(input.item.rawUpdatedAt),
      });

      const explicitReferences = explicitCitationReferences(input.item);
      const sourceRows = explicitReferences
        .slice(0, 200)
        .map((source, ordinal) => ({
          id: randomUUID(),
          revisionId,
          ordinal,
          providerPosition: positiveInteger(source.position),
          url: source.url,
          canonicalUrlHash: sha256(canonicalUrl(source.url)),
          title: source.title ?? "",
          domain: truncate(source.domain ?? domainFromUrl(source.url), 255),
          citedText: source.snippet ?? null,
        }));
      if (sourceRows.length > 0)
        await tx.insert(resultSources).values(sourceRows);

      const discoveredSourceRows = mergeDiscoveredSources(input.item).map(
        (source, ordinal) => ({
          id: randomUUID(),
          revisionId,
          ordinal,
          providerPosition: positiveInteger(source.position),
          url: source.url,
          canonicalUrlHash: sha256(source.canonicalUrl),
          title: source.title ?? "",
          domain: truncate(source.domain ?? domainFromUrl(source.url), 255),
          siteName: source.siteName ? truncate(source.siteName, 255) : null,
          summary: source.snippet ?? null,
          publishedAt: source.publishedAt ?? null,
          providerIconUrl: source.iconUrl ?? null,
          isCited: source.isCited,
        }),
      );
      if (discoveredSourceRows.length > 0) {
        await tx.insert(resultDiscoveredSources).values(discoveredSourceRows);
      }

      const mediaRows = input.item.media.slice(0, 24).map((media, ordinal) => {
        const type = normalizeMediaType(media.kind);
        return {
          id: randomUUID(),
          revisionId,
          type,
          ordinal,
          sourceUrl: media.url,
          archiveStatus:
            type === "screenshot" || type === "image"
              ? ("pending" as const)
              : ("not_applicable" as const),
        };
      });
      if (mediaRows.length > 0) await tx.insert(resultMedia).values(mediaRows);

      const [brand] = await tx
        .select()
        .from(projectBrandVersions)
        .where(eq(projectBrandVersions.id, run.projectBrandVersionId))
        .limit(1);
      const resultValues = resultValuesFromItem({
        revisionId,
        revision,
        contentHash: input.contentHash,
        item: input.item,
        mainBrand: brand?.mainBrand ?? null,
      });
      await tx
        .insert(attemptResults)
        .values({ attemptId: input.attemptId, ...resultValues })
        .onDuplicateKeyUpdate({ set: resultValues });
      await updateRunMetrics(tx, {
        attempt,
        previousResult: previousResult ?? null,
        previousDomains: previousDomains.map((row) => row.domain),
        nextResult: {
          sentiment: resultValues.sentiment,
          brandMentioned: resultValues.brandMentioned,
          mentionPosition: resultValues.mentionPosition,
          competitorRankings: resultValues.competitorRankings,
        },
        nextDomains: sourceRows.map((row) => row.domain),
      });

      const quotaConsumed = await settleAttemptMoney(tx, {
        attemptId: attempt.id,
        settlement: "consumed",
        settledAt: input.observedAt,
        reason:
          attempt.status === "failed" ||
          attempt.status === "stopped" ||
          attempt.status === "error" ||
          attempt.status === "review_required"
            ? "Late successful non-empty answer after terminal release"
            : "Successful non-empty answer",
      });
      await tx
        .update(attempts)
        .set({
          status: "completed",
          providerTaskId: input.providerTaskId,
          providerSubTaskId: input.item.subTaskId ?? attempt.providerSubTaskId,
          providerUpdatedAtRaw: normalizeRawTimestamp(input.item.rawUpdatedAt),
          terminalAt: input.observedAt,
          nextPollAt: null,
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(attempts.id, input.attemptId));

      const archivableMedia = mediaRows.filter(
        (media) => media.archiveStatus === "pending",
      );
      for (const media of archivableMedia) {
        await enqueueJob(
          tx,
          "archive_media",
          `archive:${media.id}`,
          { mediaId: media.id },
          input.observedAt,
        );
      }
      const provisionalAmount = decimalString(input.item.amount);
      if (provisionalAmount !== null) {
        const provisionalRecordId = `result:${input.attemptId}`;
        const [existingCost] = await tx
          .select({
            id: providerCosts.id,
            providerRecordId: providerCosts.providerRecordId,
            reconciledAt: providerCosts.reconciledAt,
          })
          .from(providerCosts)
          .where(eq(providerCosts.attemptId, input.attemptId))
          .orderBy(
            desc(providerCosts.reconciledAt),
            asc(providerCosts.createdAt),
          )
          .for("update")
          .limit(1);

        // The task result is only a provisional cost source. Once a billing
        // record has reconciled this attempt, later quality revisions must not
        // recreate a second provisional row or overwrite the billed amount.
        if (!existingCost) {
          await tx.insert(providerCosts).values({
            id: randomUUID(),
            attemptId: input.attemptId,
            providerTaskId: input.providerTaskId,
            amount: provisionalAmount,
            providerRecordId: provisionalRecordId,
            occurredAt: input.observedAt,
            rawMetadata: { source: "task_result", revision },
          });
        } else if (
          existingCost.reconciledAt === null &&
          existingCost.providerRecordId === provisionalRecordId
        ) {
          await tx
            .update(providerCosts)
            .set({
              providerTaskId: input.providerTaskId,
              amount: provisionalAmount,
              occurredAt: input.observedAt,
              rawMetadata: { source: "task_result", revision },
            })
            .where(eq(providerCosts.id, existingCost.id));
        }
      }
      await refreshRunState(tx, run, input.observedAt);
      return {
        revisionCreated: true,
        quotaConsumed,
        mediaJobsCreated: archivableMedia.length,
        retainedRawObjectKey: input.rawObjectKey,
      };
    });
  }

  async settleAttemptTerminalFailure(input: {
    attemptId: string;
    status: "failed" | "stopped" | "error";
    reason?: string;
    providerRaw?: unknown;
    settledAt: Date;
  }) {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt) return;

    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run) return;
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt) return;
      if (attempt.status !== "completed") {
        await settleAttemptMoney(tx, {
          attemptId: attempt.id,
          settlement: "released",
          settledAt: input.settledAt,
          reason: input.reason ?? `Attempt ${input.status}`,
        });
        await tx
          .update(attempts)
          .set({
            status: input.status,
            terminalAt: input.settledAt,
            nextPollAt: null,
            errorCode: input.status.toUpperCase(),
            errorMessage: truncate(
              input.reason ?? `Provider task ${input.status}`,
              4_000,
            ),
          })
          .where(eq(attempts.id, input.attemptId));
      }
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "failure",
        status: input.status,
        payload: {
          reason: input.reason ?? null,
          provider: asRecord(input.providerRaw),
        },
        observedAt: input.settledAt,
      });
      await refreshRunState(tx, run, input.settledAt);
    });
  }

  async markAttemptReviewRequired(input: {
    attemptId: string;
    reason: string;
    providerRaw?: unknown;
    observedAt: Date;
  }) {
    const [locatedAttempt] = await this.db
      .select({ runId: attempts.runId })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    if (!locatedAttempt) return;

    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, locatedAttempt.runId))
        .for("update")
        .limit(1);
      if (!run) return;
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(
          and(eq(attempts.id, input.attemptId), eq(attempts.runId, run.id)),
        )
        .for("update")
        .limit(1);
      if (!attempt || terminalAttempt(attempt.status)) return;

      // No answer has been selected or exposed. Release this attempt now so an
      // unresolved review cannot freeze funds indefinitely; a later explicit
      // valid binding consumes the immutable snapshot as a late success.
      await settleAttemptMoney(tx, {
        attemptId: attempt.id,
        settlement: "released",
        settledAt: input.observedAt,
        reason: "Ambiguous provider result awaiting manual review",
      });
      await tx
        .update(attempts)
        .set({
          status: "review_required",
          nextPollAt: null,
          errorCode: "PROVIDER_RESULT_AMBIGUOUS",
          errorMessage: truncate(input.reason, 4_000),
        })
        .where(eq(attempts.id, input.attemptId));
      await tx
        .update(runs)
        .set({ status: "review_required" })
        .where(
          and(
            eq(runs.id, run.id),
            inArray(runs.status, [
              "queued",
              "waiting_quota",
              "running",
              "review_required",
            ]),
          ),
        );
      await refreshRunSubmittedAttempts(tx, run.id);
      await tx.insert(providerObservations).values({
        id: randomUUID(),
        attemptId: input.attemptId,
        type: "failure",
        status: "review_required",
        payload: {
          reason: input.reason,
          provider: asRecord(input.providerRaw),
        },
        observedAt: input.observedAt,
      });
    });
  }

  async getMediaArchiveCandidate(mediaId: string) {
    const [row] = await this.db
      .select({ media: resultMedia, attempt: attempts, run: runs })
      .from(resultMedia)
      .innerJoin(
        resultRevisions,
        eq(resultMedia.revisionId, resultRevisions.id),
      )
      .innerJoin(attempts, eq(resultRevisions.attemptId, attempts.id))
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .where(
        and(
          eq(resultMedia.id, mediaId),
          eq(resultMedia.archiveStatus, "pending"),
        ),
      )
      .limit(1);
    if (!row?.media.sourceUrl) return undefined;
    return {
      mediaId: row.media.id,
      tenantId: row.attempt.ownerId,
      projectId: row.run.projectId,
      runId: row.run.id,
      attemptId: row.attempt.id,
      sourceUrl: row.media.sourceUrl,
      kind: row.media.type,
    };
  }

  async markMediaArchived(input: {
    mediaId: string;
    objectKey: string;
    thumbnailObjectKey: string;
    contentType: string;
    contentSha256: string;
    size: number;
    archivedAt: Date;
  }) {
    await this.db
      .update(resultMedia)
      .set({
        objectKey: input.objectKey,
        thumbnailObjectKey: input.thumbnailObjectKey,
        mimeType: input.contentType,
        contentHash: input.contentSha256,
        sizeBytes: input.size,
        archiveStatus: "archived",
        archiveError: null,
      })
      .where(eq(resultMedia.id, input.mediaId));
  }

  async markMediaArchiveFailed(input: {
    mediaId: string;
    error: string;
    terminal: boolean;
    observedAt: Date;
  }) {
    await this.db
      .update(resultMedia)
      .set({
        archiveStatus: input.terminal ? "failed" : "pending",
        archiveError: truncate(input.error, 4_000),
      })
      .where(eq(resultMedia.id, input.mediaId));
  }

  async listSchedulesForCatchUp(through: Date, limit: number) {
    const rows = await this.db
      .select({ monitor: monitors })
      .from(monitors)
      .innerJoin(users, eq(monitors.ownerId, users.id))
      .innerJoin(projects, eq(monitors.projectId, projects.id))
      .where(
        and(
          eq(monitors.status, "active"),
          eq(users.status, "active"),
          isNull(projects.deletedAt),
          inArray(monitors.scheduleType, ["daily", "weekly"]),
          isNull(monitors.deletedAt),
          or(
            isNull(monitors.lastScheduledFor),
            lte(monitors.lastScheduledFor, through),
          ),
        ),
      )
      .orderBy(asc(monitors.lastScheduledFor), asc(monitors.createdAt))
      .limit(limit);
    return rows.flatMap(({ monitor }) =>
      monitor.activeVersionId
        ? [
            {
              scheduleId: monitor.id,
              monitorId: monitor.id,
              type: monitor.scheduleType as "daily" | "weekly",
              timezone: monitor.scheduleTimezone,
              localTime: monitor.scheduleLocalTime,
              ...(monitor.scheduleWeekday
                ? { weekday: monitor.scheduleWeekday }
                : {}),
              materializedThrough:
                monitor.lastScheduledFor ?? monitor.createdAt,
            },
          ]
        : [],
    );
  }

  async materializeScheduleOccurrences(input: {
    scheduleId: string;
    occurrences: ReadonlyArray<{
      occurrenceId: string;
      scheduleId: string;
      monitorId: string;
      scheduledAt: Date;
      trigger: "scheduled" | "catch_up";
    }>;
    scannedThrough: Date;
  }) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ monitor: monitors })
        .from(monitors)
        .innerJoin(projects, eq(monitors.projectId, projects.id))
        .innerJoin(users, eq(monitors.ownerId, users.id))
        .where(
          and(
            eq(monitors.id, input.scheduleId),
            eq(monitors.status, "active"),
            isNull(monitors.deletedAt),
            isNull(projects.deletedAt),
            eq(users.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      const monitor = row?.monitor;
      if (!monitor?.activeVersionId) return;
      for (const occurrence of input.occurrences) {
        if (
          occurrence.monitorId !== monitor.id ||
          occurrence.scheduleId !== monitor.id
        ) {
          throw new RepositoryError(
            "INVALID_STATE",
            "Schedule occurrence does not belong to the monitor",
          );
        }
        await tx
          .insert(scheduleOccurrences)
          .values({
            id: occurrence.occurrenceId,
            monitorId: monitor.id,
            monitorVersionId: monitor.activeVersionId,
            scheduledFor: occurrence.scheduledAt,
            trigger: occurrence.trigger,
          })
          .onDuplicateKeyUpdate({
            set: { scheduledFor: sql`${scheduleOccurrences.scheduledFor}` },
          });
      }
      await tx
        .update(monitors)
        .set({
          lastScheduledFor: input.scannedThrough,
          nextRunAt: computeNextRunAt(
            {
              type: monitor.scheduleType,
              timezone: monitor.scheduleTimezone,
              localTime: monitor.scheduleLocalTime,
              weekday: monitor.scheduleWeekday,
            },
            input.scannedThrough,
          ),
        })
        .where(eq(monitors.id, monitor.id));
    });
  }

  async dispatchQueuedOccurrences(input: {
    through: Date;
    dailyLimit: number;
    limit: number;
  }) {
    const occurrences = await this.db
      .select({ occurrence: scheduleOccurrences, ownerId: monitors.ownerId })
      .from(scheduleOccurrences)
      .innerJoin(monitors, eq(scheduleOccurrences.monitorId, monitors.id))
      .innerJoin(users, eq(monitors.ownerId, users.id))
      .innerJoin(projects, eq(monitors.projectId, projects.id))
      .where(
        and(
          isNull(scheduleOccurrences.runId),
          lte(scheduleOccurrences.scheduledFor, input.through),
          eq(monitors.status, "active"),
          isNull(monitors.deletedAt),
          eq(users.status, "active"),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(asc(scheduleOccurrences.scheduledFor))
      .limit(input.limit);
    let dispatched = 0;
    let deferredForQuota = 0;
    const quotaBlockedMonitors = new Set<string>();
    for (const row of occurrences) {
      if (quotaBlockedMonitors.has(row.occurrence.monitorId)) continue;
      try {
        const result = await this.monitoring.createRun(
          row.ownerId,
          row.occurrence.monitorId,
          `occurrence:${row.occurrence.id}`,
          row.occurrence.trigger,
          row.occurrence.id,
          row.occurrence.monitorVersionId,
        );
        if (!result.duplicate) dispatched += 1;
      } catch (error) {
        if (
          error instanceof RepositoryError &&
          ["QUOTA_EXCEEDED", "BALANCE_INSUFFICIENT"].includes(error.code)
        ) {
          await this.db
            .update(scheduleOccurrences)
            .set({ waitingForQuotaAt: input.through })
            .where(
              and(
                eq(scheduleOccurrences.id, row.occurrence.id),
                isNull(scheduleOccurrences.runId),
              ),
            );
          deferredForQuota += 1;
          // Preserve occurrence order for this monitor: a later, smaller run
          // must not reserve quota ahead of its older waiting occurrence.
          quotaBlockedMonitors.add(row.occurrence.monitorId);
          continue;
        }
        if (
          error instanceof RepositoryError &&
          ["NOT_FOUND", "INVALID_STATE"].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    return {
      dispatched,
      deferredForQuota,
      // Only schedule an immediate continuation when this batch made forward
      // progress. Quota-waiting rows are retried by the next maintenance tick,
      // avoiding a tight 500 ms loop over an unchanged full batch.
      hasMore: occurrences.length === input.limit && dispatched > 0,
    };
  }

  async listPurgeCandidates(through: Date, limit: number) {
    const auditCutoff = new Date(through.getTime() - 365 * 86_400_000);
    const revokedSessionCutoff = new Date(through.getTime() - 30 * 86_400_000);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(sessions)
        .where(
          or(
            lte(sessions.expiresAt, through),
            and(
              sql`${sessions.revokedAt} IS NOT NULL`,
              lte(sessions.revokedAt, revokedSessionCutoff),
            ),
          ),
        );
      await tx.delete(auditLogs).where(lte(auditLogs.createdAt, auditCutoff));
    });
    const candidates: Array<{
      entityType: "project" | "monitor" | "run";
      entityId: string;
    }> = [];
    const runRows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(lte(runs.purgeAfter, through), sql`${runs.deletedAt} IS NOT NULL`),
      )
      .orderBy(asc(runs.purgeAfter))
      .limit(limit);
    candidates.push(
      ...runRows.map((row) => ({
        entityType: "run" as const,
        entityId: row.id,
      })),
    );
    if (candidates.length < limit) {
      const monitorRows = await this.db
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(
            lte(monitors.purgeAfter, through),
            sql`${monitors.deletedAt} IS NOT NULL`,
          ),
        )
        .orderBy(asc(monitors.purgeAfter))
        .limit(limit - candidates.length);
      candidates.push(
        ...monitorRows.map((row) => ({
          entityType: "monitor" as const,
          entityId: row.id,
        })),
      );
    }
    if (candidates.length < limit) {
      const projectRows = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            lte(projects.purgeAfter, through),
            sql`${projects.deletedAt} IS NOT NULL`,
          ),
        )
        .orderBy(asc(projects.purgeAfter))
        .limit(limit - candidates.length);
      candidates.push(
        ...projectRows.map((row) => ({
          entityType: "project" as const,
          entityId: row.id,
        })),
      );
    }
    const output = [];
    for (const candidate of candidates) {
      const runCondition =
        candidate.entityType === "run"
          ? eq(runs.id, candidate.entityId)
          : candidate.entityType === "monitor"
            ? eq(runs.monitorId, candidate.entityId)
            : eq(runs.projectId, candidate.entityId);
      const attemptRows = await this.db
        .select({ providerTaskId: attempts.providerTaskId })
        .from(attempts)
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .where(runCondition);
      const mediaRows = await this.db
        .select({
          objectKey: resultMedia.objectKey,
          thumbnailObjectKey: resultMedia.thumbnailObjectKey,
        })
        .from(resultMedia)
        .innerJoin(
          resultRevisions,
          eq(resultMedia.revisionId, resultRevisions.id),
        )
        .innerJoin(attempts, eq(resultRevisions.attemptId, attempts.id))
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .where(runCondition);
      const revisionRows = await this.db
        .select({ rawObjectKey: resultRevisions.rawObjectKey })
        .from(resultRevisions)
        .innerJoin(attempts, eq(resultRevisions.attemptId, attempts.id))
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .where(runCondition);
      const displayKeys = mediaRows.flatMap((row) =>
        row.objectKey ? [row.objectKey] : [],
      );
      output.push({
        ...candidate,
        providerTaskIds: unique(
          attemptRows.flatMap((row) =>
            row.providerTaskId ? [row.providerTaskId] : [],
          ),
        ),
        objectKeys: unique([
          ...displayKeys,
          ...displayKeys.flatMap((key) => {
            const originalKey = originalObjectKeyForDisplay(key);
            return originalKey ? [originalKey] : [];
          }),
          ...mediaRows.flatMap((row) =>
            row.thumbnailObjectKey ? [row.thumbnailObjectKey] : [],
          ),
          ...revisionRows.flatMap((row) =>
            row.rawObjectKey ? [row.rawObjectKey] : [],
          ),
        ]),
      });
    }
    return output;
  }

  async finalizePurge(input: {
    entityType: "project" | "monitor" | "run";
    entityId: string;
    providerTaskTombstoneHashes: readonly string[];
    purgedAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      const runCondition =
        input.entityType === "run"
          ? eq(runs.id, input.entityId)
          : input.entityType === "monitor"
            ? eq(runs.monitorId, input.entityId)
            : eq(runs.projectId, input.entityId);
      const runRows = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(runCondition)
        .for("update");
      const runIds = runRows.map((row) => row.id);
      if (runIds.length > 0) {
        const attemptRows = await tx
          .select({ id: attempts.id })
          .from(attempts)
          .where(inArray(attempts.runId, runIds));
        const attemptIds = attemptRows.map((row) => row.id);
        if (attemptIds.length > 0) {
          await tx
            .update(moneyLedger)
            .set({ attemptId: null })
            .where(inArray(moneyLedger.attemptId, attemptIds));
          await tx
            .update(quotaLedger)
            .set({ attemptId: null })
            .where(inArray(quotaLedger.attemptId, attemptIds));
          await tx
            .update(providerCosts)
            .set({ attemptId: null })
            .where(inArray(providerCosts.attemptId, attemptIds));
          await tx
            .delete(attemptMoneySettlements)
            .where(inArray(attemptMoneySettlements.attemptId, attemptIds));
          await tx
            .delete(attemptPriceSnapshots)
            .where(inArray(attemptPriceSnapshots.attemptId, attemptIds));
        }
        const reservationRows = await tx
          .select({ id: quotaReservations.id })
          .from(quotaReservations)
          .where(inArray(quotaReservations.runId, runIds));
        const reservationIds = reservationRows.map((row) => row.id);
        if (reservationIds.length > 0) {
          await tx
            .update(quotaLedger)
            .set({ reservationId: null })
            .where(inArray(quotaLedger.reservationId, reservationIds));
          await tx
            .delete(quotaReservations)
            .where(inArray(quotaReservations.id, reservationIds));
        }
        await tx
          .delete(scheduleOccurrences)
          .where(inArray(scheduleOccurrences.runId, runIds));
        await tx.delete(runs).where(inArray(runs.id, runIds));
      }
      if (input.entityType === "monitor") {
        await tx
          .delete(dailyRunAggregates)
          .where(eq(dailyRunAggregates.monitorId, input.entityId));
        await tx
          .delete(scheduleOccurrences)
          .where(eq(scheduleOccurrences.monitorId, input.entityId));
        await tx.delete(monitors).where(eq(monitors.id, input.entityId));
      } else if (input.entityType === "project") {
        const monitorRows = await tx
          .select({ id: monitors.id })
          .from(monitors)
          .where(eq(monitors.projectId, input.entityId));
        const monitorIds = monitorRows.map((row) => row.id);
        if (monitorIds.length > 0) {
          await tx
            .delete(dailyRunAggregates)
            .where(inArray(dailyRunAggregates.monitorId, monitorIds));
          await tx
            .delete(scheduleOccurrences)
            .where(inArray(scheduleOccurrences.monitorId, monitorIds));
          await tx.delete(monitors).where(inArray(monitors.id, monitorIds));
        }
        await tx.delete(projects).where(eq(projects.id, input.entityId));
      }
      if (input.providerTaskTombstoneHashes.length > 0) {
        // A late provider callback has no trustworthy upper bound. Keep only
        // the irreversible task hash, but retain it for the lifetime of the
        // product so a purged task can never be reintroduced as unknown work.
        // Keep safely inside MySQL DATETIME's upper bound even when mysql2
        // formats Date values in a positive local timezone.
        const expiry = new Date("9999-01-01T00:00:00.000Z");
        await tx
          .insert(providerTaskTombstones)
          .values(
            input.providerTaskTombstoneHashes.map((hash) => ({
              providerTaskHash: hash,
              deletedEntityType: input.entityType,
              deletedEntityIdHash: sha256(input.entityId),
              expiresAt: expiry,
            })),
          )
          .onDuplicateKeyUpdate({ set: { expiresAt: expiry } });
      }
    });
  }

  async getBillingReconciliationCursor(): Promise<BillingCursor> {
    const [state] = await this.db
      .select()
      .from(providerReconciliationState)
      .where(eq(providerReconciliationState.id, "moli"))
      .limit(1);
    if (state) {
      const cursor = state.cursor as BillingCursor;
      if (cursor.page === 1 && cursor.startDate === cursor.endDate) {
        return {
          ...cursor,
          endDate: cappedBillingEndDate(cursor.startDate, new Date()),
        };
      }
      return cursor;
    }
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60_000);
    return {
      startDate: dateString(start),
      endDate: dateString(end),
      page: 1,
      pageSize: 100,
    };
  }

  async applyBillingReconciliation(input: {
    cursor: BillingCursor;
    balance: MoliBalance;
    summary: MoliBillingSummary;
    records: MoliBillingRecordsPage;
    reconciledAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      for (const record of input.records.records) {
        const providerRecordId = billingProviderRecordId(record);
        let attemptId: string | null = null;
        if (record.taskId) {
          const [attempt] = await tx
            .select({ id: attempts.id })
            .from(attempts)
            .where(eq(attempts.providerTaskId, record.taskId))
            .for("update")
            .limit(1);
          attemptId = attempt?.id ?? null;
        }
        if (!attemptId && record.consumerTaskId) {
          const [attempt] = await tx
            .select({ id: attempts.id })
            .from(attempts)
            .where(eq(attempts.consumerTaskId, record.consumerTaskId))
            .for("update")
            .limit(1);
          attemptId = attempt?.id ?? null;
        }

        const providerTaskId =
          record.taskId ?? record.consumerTaskId ?? "unknown";
        const amount = decimalString(record.amount) ?? "0";
        const occurredAt = record.occurredAt ?? input.reconciledAt;
        const rawMetadata = {
          ...record.raw,
          rawOccurredAt: record.rawOccurredAt ?? null,
        };
        const [existingBillingCost] = await tx
          .select()
          .from(providerCosts)
          .where(eq(providerCosts.providerRecordId, providerRecordId))
          .for("update")
          .limit(1);
        if (existingBillingCost) {
          let staleProvisionalCostId: string | undefined;
          if (attemptId) {
            const [staleProvisionalCost] = await tx
              .select({ id: providerCosts.id })
              .from(providerCosts)
              .where(
                and(
                  eq(providerCosts.attemptId, attemptId),
                  eq(providerCosts.providerRecordId, `result:${attemptId}`),
                  isNull(providerCosts.reconciledAt),
                ),
              )
              .for("update")
              .limit(1);
            staleProvisionalCostId = staleProvisionalCost?.id;
          }
          await tx
            .update(providerCosts)
            .set({
              attemptId: attemptId ?? existingBillingCost.attemptId,
              providerTaskId:
                providerTaskId === "unknown"
                  ? existingBillingCost.providerTaskId
                  : providerTaskId,
              amount,
              occurredAt,
              rawMetadata,
              reconciledAt: input.reconciledAt,
            })
            .where(eq(providerCosts.id, existingBillingCost.id));
          // A billing record can arrive before the provider task has been bound
          // to its attempt. If a later reconciliation can finally match it,
          // remove the provisional row that may have been created meanwhile.
          if (staleProvisionalCostId) {
            await tx
              .delete(providerCosts)
              .where(eq(providerCosts.id, staleProvisionalCostId));
          }
          continue;
        }

        if (attemptId) {
          const [provisionalCost] = await tx
            .select({ id: providerCosts.id })
            .from(providerCosts)
            .where(
              and(
                eq(providerCosts.attemptId, attemptId),
                eq(providerCosts.providerRecordId, `result:${attemptId}`),
                isNull(providerCosts.reconciledAt),
              ),
            )
            .for("update")
            .limit(1);
          if (provisionalCost) {
            await tx
              .update(providerCosts)
              .set({
                providerTaskId,
                amount,
                providerRecordId,
                occurredAt,
                rawMetadata,
                reconciledAt: input.reconciledAt,
              })
              .where(eq(providerCosts.id, provisionalCost.id));
            continue;
          }
        }

        const duplicateUpdate = {
          ...(attemptId ? { attemptId } : {}),
          ...(providerTaskId === "unknown" ? {} : { providerTaskId }),
          amount,
          occurredAt,
          rawMetadata,
          reconciledAt: input.reconciledAt,
        };
        await tx
          .insert(providerCosts)
          .values({
            id: randomUUID(),
            attemptId,
            providerTaskId,
            amount,
            providerRecordId,
            occurredAt,
            rawMetadata,
            reconciledAt: input.reconciledAt,
          })
          .onDuplicateKeyUpdate({
            set: duplicateUpdate,
          });
      }
      const page = input.records.page ?? input.cursor.page;
      const pageSize = input.records.pageSize ?? input.cursor.pageSize;
      const hasMore =
        input.records.total !== undefined &&
        page * pageSize < input.records.total;
      const nextCursor: BillingCursor = hasMore
        ? { ...input.cursor, page: page + 1, pageSize }
        : {
            startDate: input.cursor.endDate,
            endDate: cappedBillingEndDate(
              input.cursor.endDate,
              input.reconciledAt,
            ),
            page: 1,
            pageSize,
          };
      await tx
        .insert(providerReconciliationState)
        .values({
          id: "moli",
          cursor: nextCursor,
          balance: asRecord(input.balance),
          summary: asRecord(input.summary),
          reconciledAt: input.reconciledAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            cursor: nextCursor,
            balance: asRecord(input.balance),
            summary: asRecord(input.summary),
            reconciledAt: input.reconciledAt,
          },
        });
    });
  }

  async upsertProviderCatalogDiscovery(input: {
    models: readonly MoliModel[];
    domesticRegions: readonly MoliRegion[];
    overseasRegions: readonly MoliRegion[];
    syncedAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      for (const model of input.models) {
        const providerMetadata = {
          ...model.raw,
          enabledByProvider: model.enabledByProvider ?? null,
        };
        const acceptanceFingerprint = platformAcceptanceFingerprint({
          providerCode: model.platform,
          clientType: model.clientType,
          providerMetadata,
        });
        const [existing] = await tx
          .select({
            acceptanceFingerprint: platformCatalog.acceptanceFingerprint,
          })
          .from(platformCatalog)
          .where(
            and(
              eq(platformCatalog.providerCode, model.platform),
              eq(platformCatalog.clientType, model.clientType),
            ),
          )
          .limit(1);
        const evidenceChanged =
          existing?.acceptanceFingerprint !== acceptanceFingerprint;
        await tx
          .insert(platformCatalog)
          .values({
            id: randomUUID(),
            providerCode: model.platform,
            displayName: model.displayName ?? model.name,
            clientType: model.clientType,
            pricingClass: officialPricingClassForKnownProvider(model.platform),
            enabled: false,
            verified: false,
            acceptanceRequired: true,
            providerMetadata,
            acceptanceFingerprint,
            discoveredAt: input.syncedAt,
          })
          .onDuplicateKeyUpdate({
            set: {
              displayName: model.displayName ?? model.name,
              providerMetadata,
              acceptanceRequired: true,
              acceptanceFingerprint,
              ...(evidenceChanged
                ? {
                    verified: false,
                    supportsReasoning: false,
                    supportsScreenshot: false,
                    supportsDomesticRegion: false,
                    supportsOverseasRegion: false,
                    verifiedAt: null,
                  }
                : {}),
            },
          });
      }
      await tx.delete(providerRegions);
      const regions = [...input.domesticRegions, ...input.overseasRegions];
      if (regions.length > 0)
        await tx.insert(providerRegions).values(
          regions.map((region) => ({
            code: region.code,
            scope: region.scope,
            name: region.name,
            providerMetadata: region.raw,
            syncedAt: input.syncedAt,
          })),
        );
    });
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function maintenance(
  type: WorkerJobType,
  bucket: string,
  at: Date,
): typeof jobs.$inferInsert {
  return {
    id: randomUUID(),
    type,
    dedupeKey: `maintenance:${type}:${bucket}`,
    payload: {},
    availableAt: at,
  };
}

async function enqueueJob(
  tx: Transaction,
  type: WorkerJobType,
  dedupeKey: string,
  payload: Record<string, unknown>,
  availableAt: Date,
) {
  await tx
    .insert(jobs)
    .values({ id: randomUUID(), type, dedupeKey, payload, availableAt })
    .onDuplicateKeyUpdate({
      set: {
        status: "ready",
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
}

type ResultMetricContribution = Pick<
  typeof attemptResults.$inferSelect,
  "sentiment" | "brandMentioned" | "mentionPosition" | "competitorRankings"
>;

async function updateRunMetrics(
  tx: Transaction,
  input: {
    attempt: typeof attempts.$inferSelect;
    previousResult: ResultMetricContribution | null;
    previousDomains: readonly string[];
    nextResult: ResultMetricContribution;
    nextDomains: readonly string[];
  },
) {
  // The upsert makes metrics lazy: queued/empty runs need no creation-path
  // changes and listRuns can LEFT JOIN a missing row as all zeroes.
  await tx
    .insert(runMetrics)
    .values({
      runId: input.attempt.runId,
      modelMetrics: [],
      competitorMetrics: [],
    })
    .onDuplicateKeyUpdate({
      set: { runId: sql`${runMetrics.runId}` },
    });
  // Every result writer for the run takes this lock. That serializes metrics
  // deltas across attempts while the attempt lock serializes revisions of one
  // answer, keeping both levels atomic without scanning result history.
  const [current] = await tx
    .select()
    .from(runMetrics)
    .where(eq(runMetrics.runId, input.attempt.runId))
    .for("update")
    .limit(1);
  if (!current)
    throw new RepositoryError(
      "INVALID_STATE",
      "Run metrics row could not be locked",
    );

  const previous = input.previousResult;
  const effectiveDelta = previous ? 0 : 1;
  const brandDelta =
    Number(input.nextResult.brandMentioned) -
    Number(previous?.brandMentioned ?? false);
  const mentionPositionSumDelta =
    (input.nextResult.mentionPosition ?? 0) - (previous?.mentionPosition ?? 0);
  const mentionPositionCountDelta =
    Number(input.nextResult.mentionPosition !== null) -
    Number(previous !== null && previous.mentionPosition !== null);
  const uniqueDomainDelta = await updateRunMetricDomains(tx, {
    runId: input.attempt.runId,
    previousDomains: input.previousDomains,
    nextDomains: input.nextDomains,
  });
  const sentimentDeltas = {
    positive:
      Number(input.nextResult.sentiment === "positive") -
      Number(previous?.sentiment === "positive"),
    neutral:
      Number(input.nextResult.sentiment === "neutral") -
      Number(previous?.sentiment === "neutral"),
    negative:
      Number(input.nextResult.sentiment === "negative") -
      Number(previous?.sentiment === "negative"),
    unknown:
      Number(input.nextResult.sentiment === "unknown") -
      Number(previous?.sentiment === "unknown"),
  };

  await tx
    .update(runMetrics)
    .set({
      effectiveAnswers: checkedMetric(
        current.effectiveAnswers + effectiveDelta,
        "effective_answers",
      ),
      brandMentionedAnswers: checkedMetric(
        current.brandMentionedAnswers + brandDelta,
        "brand_mentioned_answers",
      ),
      mentionPositionSum: checkedMetric(
        current.mentionPositionSum + mentionPositionSumDelta,
        "mention_position_sum",
      ),
      mentionPositionCount: checkedMetric(
        current.mentionPositionCount + mentionPositionCountDelta,
        "mention_position_count",
      ),
      citationCount: checkedMetric(
        current.citationCount +
          input.nextDomains.length -
          input.previousDomains.length,
        "citation_count",
      ),
      uniqueDomainCount: checkedMetric(
        current.uniqueDomainCount + uniqueDomainDelta,
        "unique_domain_count",
      ),
      positiveCount: checkedMetric(
        current.positiveCount + sentimentDeltas.positive,
        "positive_count",
      ),
      neutralCount: checkedMetric(
        current.neutralCount + sentimentDeltas.neutral,
        "neutral_count",
      ),
      negativeCount: checkedMetric(
        current.negativeCount + sentimentDeltas.negative,
        "negative_count",
      ),
      unknownCount: checkedMetric(
        current.unknownCount + sentimentDeltas.unknown,
        "unknown_count",
      ),
      modelMetrics: updateModelMetrics(
        current.modelMetrics,
        input.attempt,
        previous,
        input.previousDomains.length,
        input.nextResult,
        input.nextDomains.length,
      ),
      competitorMetrics: updateCompetitorMetrics(
        current.competitorMetrics,
        previous?.competitorRankings ?? [],
        input.nextResult.competitorRankings,
      ),
    })
    .where(eq(runMetrics.runId, input.attempt.runId));
}

async function updateRunMetricDomains(
  tx: Transaction,
  input: {
    runId: string;
    previousDomains: readonly string[];
    nextDomains: readonly string[];
  },
) {
  const previousCounts = frequencies(input.previousDomains);
  const nextCounts = frequencies(input.nextDomains);
  const domains = unique([
    ...previousCounts.keys(),
    ...nextCounts.keys(),
  ]).sort();
  if (domains.length === 0) return 0;
  const existing = await tx
    .select()
    .from(runMetricDomains)
    .where(
      and(
        eq(runMetricDomains.runId, input.runId),
        inArray(runMetricDomains.domain, domains),
      ),
    )
    .for("update");
  const existingByDomain = new Map(
    existing.map((row) => [row.domain, row.referenceCount]),
  );
  let uniqueDomainDelta = 0;
  for (const domain of domains) {
    const current = existingByDomain.get(domain) ?? 0;
    const next = checkedMetric(
      current -
        (previousCounts.get(domain) ?? 0) +
        (nextCounts.get(domain) ?? 0),
      `domain:${domain}`,
    );
    if (current === 0 && next > 0) {
      await tx.insert(runMetricDomains).values({
        runId: input.runId,
        domain,
        referenceCount: next,
      });
      uniqueDomainDelta += 1;
    } else if (current > 0 && next === 0) {
      await tx
        .delete(runMetricDomains)
        .where(
          and(
            eq(runMetricDomains.runId, input.runId),
            eq(runMetricDomains.domain, domain),
          ),
        );
      uniqueDomainDelta -= 1;
    } else if (current !== next) {
      await tx
        .update(runMetricDomains)
        .set({ referenceCount: next })
        .where(
          and(
            eq(runMetricDomains.runId, input.runId),
            eq(runMetricDomains.domain, domain),
          ),
        );
    }
  }
  return uniqueDomainDelta;
}

function updateModelMetrics(
  existing: readonly RunModelMetric[],
  attempt: typeof attempts.$inferSelect,
  previous: ResultMetricContribution | null,
  previousCitationCount: number,
  next: ResultMetricContribution,
  nextCitationCount: number,
): RunModelMetric[] {
  const key = modelMetricKey(attempt);
  const metrics = new Map(
    existing.map((metric) => [modelMetricKey(metric), { ...metric }]),
  );
  const metric = metrics.get(key) ?? {
    platformId: attempt.platformId,
    providerCode: attempt.providerCode,
    clientType: attempt.clientType,
    mode: attempt.mode,
    effectiveAnswers: 0,
    brandMentionedAnswers: 0,
    mentionPositionSum: 0,
    mentionPositionCount: 0,
    citationCount: 0,
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
    unknownCount: 0,
  };
  if (previous)
    applyModelContribution(metric, previous, previousCitationCount, -1);
  applyModelContribution(metric, next, nextCitationCount, 1);
  validateModelMetric(metric);
  metrics.set(key, metric);
  return [...metrics.values()].sort((left, right) =>
    modelMetricKey(left).localeCompare(modelMetricKey(right)),
  );
}

function modelMetricKey(
  value: Pick<
    RunModelMetric,
    "platformId" | "providerCode" | "clientType" | "mode"
  >,
) {
  return [
    value.platformId,
    value.providerCode,
    value.clientType,
    value.mode,
  ].join("\u0000");
}

function applyModelContribution(
  metric: RunModelMetric,
  result: ResultMetricContribution,
  citationCount: number,
  direction: 1 | -1,
) {
  metric.effectiveAnswers += direction;
  metric.brandMentionedAnswers += direction * Number(result.brandMentioned);
  metric.mentionPositionSum += direction * (result.mentionPosition ?? 0);
  metric.mentionPositionCount +=
    direction * Number(result.mentionPosition !== null);
  metric.citationCount += direction * citationCount;
  if (result.sentiment === "positive") metric.positiveCount += direction;
  else if (result.sentiment === "neutral") metric.neutralCount += direction;
  else if (result.sentiment === "negative") metric.negativeCount += direction;
  else metric.unknownCount += direction;
}

function validateModelMetric(metric: RunModelMetric) {
  for (const [name, value] of Object.entries(metric)) {
    if (typeof value === "number") checkedMetric(value, `model:${name}`);
  }
}

function updateCompetitorMetrics(
  existing: readonly RunCompetitorMetric[],
  previousRankings: readonly Record<string, unknown>[],
  nextRankings: readonly Record<string, unknown>[],
): RunCompetitorMetric[] {
  const metrics = new Map(
    existing.map((metric) => [metric.name, { ...metric }]),
  );
  for (const [name, contribution] of competitorContributions(
    previousRankings,
  )) {
    const metric = metrics.get(name);
    if (!metric)
      throw new RepositoryError(
        "INVALID_STATE",
        `Missing competitor metric for ${name}`,
      );
    metric.appearances -= contribution.appearances;
    metric.positionSum -= contribution.positionSum;
    metric.positionCount -= contribution.positionCount;
    if (metric.appearances === 0) metrics.delete(name);
    else validateCompetitorMetric(metric);
  }
  for (const [name, contribution] of competitorContributions(nextRankings)) {
    const metric = metrics.get(name) ?? {
      name,
      appearances: 0,
      positionSum: 0,
      positionCount: 0,
    };
    metric.appearances += contribution.appearances;
    metric.positionSum += contribution.positionSum;
    metric.positionCount += contribution.positionCount;
    validateCompetitorMetric(metric);
    metrics.set(name, metric);
  }
  return [...metrics.values()].sort(
    (left, right) =>
      right.appearances - left.appearances ||
      left.name.localeCompare(right.name),
  );
}

function competitorContributions(rankings: readonly Record<string, unknown>[]) {
  const contributions = new Map<
    string,
    { appearances: number; positionSum: number; positionCount: number }
  >();
  for (const ranking of rankings.slice(0, 100)) {
    const name = rankingText(ranking, [
      "name",
      "brand",
      "competitorName",
      "keyword",
    ]);
    if (!name) continue;
    const current = contributions.get(name) ?? {
      appearances: 0,
      positionSum: 0,
      positionCount: 0,
    };
    current.appearances += 1;
    const position = rankingNumber(ranking, ["position", "rank", "ranking"]);
    if (position !== null && position > 0) {
      current.positionSum += position;
      current.positionCount += 1;
    }
    contributions.set(name, current);
  }
  return contributions;
}

function rankingText(value: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim())
      return truncate(candidate.trim(), 255);
  }
  return null;
}

function rankingNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const candidate = value[key];
    const numeric =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim()
          ? Number(candidate)
          : Number.NaN;
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function validateCompetitorMetric(metric: RunCompetitorMetric) {
  checkedMetric(metric.appearances, `competitor:${metric.name}:appearances`);
  checkedMetric(metric.positionSum, `competitor:${metric.name}:position_sum`, {
    integer: false,
  });
  checkedMetric(
    metric.positionCount,
    `competitor:${metric.name}:position_count`,
  );
}

function frequencies(values: readonly string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    // MySQL's utf8mb4_0900_ai_ci key comparison is case-insensitive and ignores
    // VARCHAR padding, so normalize before using the same value as a PK.
    const normalized = value.trim().toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function checkedMetric(
  value: number,
  name: string,
  options: { integer?: boolean } = {},
) {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    (options.integer !== false && !Number.isSafeInteger(value))
  )
    throw new RepositoryError(
      "INVALID_STATE",
      `Invalid pre-aggregated metric ${name}`,
    );
  return value;
}

type AttemptStatus = typeof attempts.$inferSelect.status;

// submittedAttempts means an attempt has left the pre-submission queue. Keep
// this predicate shared by live progress refreshes and terminal recomputation.
export function countsTowardSubmittedAttempts(status: AttemptStatus) {
  return status !== "queued" && status !== "cancelled_before_submit";
}

async function refreshRunSubmittedAttempts(tx: Transaction, runId: string) {
  const rows = await tx
    .select({ status: attempts.status })
    .from(attempts)
    .where(eq(attempts.runId, runId));
  await tx
    .update(runs)
    .set({
      submittedAttempts: rows.filter((row) =>
        countsTowardSubmittedAttempts(row.status),
      ).length,
    })
    .where(eq(runs.id, runId));
}

async function refreshRunState(
  tx: Transaction,
  run: typeof runs.$inferSelect,
  at: Date,
) {
  const rows = await tx
    .select({ status: attempts.status })
    .from(attempts)
    .where(eq(attempts.runId, run.id));
  const completed = rows.filter((row) => row.status === "completed").length;
  const failed = rows.filter(
    (row) => row.status === "failed" || row.status === "error",
  ).length;
  const stopped = rows.filter(
    (row) =>
      row.status === "stopped" || row.status === "cancelled_before_submit",
  ).length;
  const terminal = completed + failed + stopped;
  let status = run.status;
  let completedAt: Date | null = null;
  if (terminal === rows.length && rows.length > 0) {
    completedAt = at;
    status =
      completed === rows.length
        ? "completed"
        : completed > 0
          ? "partial_completed"
          : run.cancelRequestedAt || stopped === rows.length
            ? "cancelled"
            : "failed";
  } else if (rows.some((row) => row.status !== "queued")) {
    status = "running";
  }
  await tx
    .update(runs)
    .set({
      status,
      completedAttempts: completed,
      failedAttempts: failed,
      stoppedAttempts: stopped,
      submittedAttempts: rows.filter((row) =>
        countsTowardSubmittedAttempts(row.status),
      ).length,
      startedAt: run.startedAt ?? (status === "running" ? at : null),
      completedAt,
    })
    .where(eq(runs.id, run.id));
  if (completedAt) {
    const [nextRun] = await tx
      .select({ id: runs.id })
      .from(runs)
      .leftJoin(
        scheduleOccurrences,
        eq(runs.scheduleOccurrenceId, scheduleOccurrences.id),
      )
      .where(
        and(
          eq(runs.monitorId, run.monitorId),
          eq(runs.status, "queued"),
          isNull(runs.deletedAt),
          sql`${runs.id} <> ${run.id}`,
        ),
      )
      .orderBy(
        asc(
          sql`COALESCE(${scheduleOccurrences.scheduledFor}, ${runs.createdAt})`,
        ),
        asc(runs.createdAt),
        asc(runs.id),
      )
      .limit(1);
    if (nextRun) {
      const queuedAttempts = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(
          and(eq(attempts.runId, nextRun.id), eq(attempts.status, "queued")),
        );
      for (const attempt of queuedAttempts) {
        await enqueueJob(
          tx,
          "submit_attempt",
          `submit:${attempt.id}`,
          { attemptId: attempt.id },
          at,
        );
      }
    }
  }
}

type MergedDiscoveredSource = Omit<MoliReference, "raw"> & {
  canonicalUrl: string;
  isCited: boolean;
};

export function explicitCitationReferences(
  item: Pick<MoliResultItem, "citationProvenance" | "references">,
): readonly MoliReference[] {
  return item.citationProvenance === "explicit" ? item.references : [];
}

function mergeDiscoveredSources(
  item: MoliResultItem,
): MergedDiscoveredSource[] {
  const merged = new Map<string, MergedDiscoveredSource>();

  const accept = (source: MoliReference, isCited: boolean) => {
    const canonical = canonicalUrl(source.url);
    const existing = merged.get(canonical);
    if (!existing) {
      const { raw: _raw, ...safeSource } = source;
      merged.set(canonical, {
        ...safeSource,
        canonicalUrl: canonical,
        isCited,
      });
      return;
    }
    const preferredPosition =
      isCited && source.position ? source.position : existing.position;
    merged.set(canonical, {
      ...existing,
      title: existing.title ?? source.title,
      domain: existing.domain ?? source.domain,
      siteName: existing.siteName ?? source.siteName,
      snippet: existing.snippet ?? source.snippet,
      publishedAt: existing.publishedAt ?? source.publishedAt,
      iconUrl: existing.iconUrl ?? source.iconUrl,
      position: preferredPosition ?? source.position,
      isCited: existing.isCited || isCited,
    });
  };

  for (const source of item.allReferences) accept(source, false);
  for (const source of item.references) {
    accept(source, item.citationProvenance === "explicit");
  }
  return [...merged.values()];
}

function resultValuesFromItem(input: {
  revisionId: string;
  revision: number;
  contentHash: string;
  item: MoliResultItem;
  mainBrand: string | null;
}) {
  return materializeResultValues({
    revisionId: input.revisionId,
    revision: input.revision,
    contentHash: input.contentHash,
    answerContent: input.item.answerContent,
    reasoningProcess: input.item.reasoningProcess,
    searchKeywords: input.item.searchKeywords,
    sentiment: input.item.sentiment,
    mentionPosition: input.item.mentionPosition,
    mentionPositionProvided: input.item.mentionPosition !== undefined,
    competitorRankings: input.item.competitorRankings ?? input.item.allRankings,
    keywordEvaluations: input.item.keywordEvaluations,
    categoryRanking: input.item.categoryRanking,
    amount: input.item.amount,
    mainBrand: input.mainBrand,
  });
}

function resultValuesFromNormalizedPayload(input: {
  revision: Pick<
    typeof resultRevisions.$inferSelect,
    "id" | "revision" | "contentHash" | "normalizedPayload"
  >;
  mainBrand: string | null;
}) {
  const payload = input.revision.normalizedPayload;
  return materializeResultValues({
    revisionId: input.revision.id,
    revision: input.revision.revision,
    contentHash: input.revision.contentHash,
    answerContent: payload.answerContent,
    reasoningProcess: payload.reasoningProcess,
    searchKeywords: payload.searchKeywords,
    sentiment: payload.sentiment,
    mentionPosition: payload.mentionPosition,
    mentionPositionProvided:
      payload.mentionPosition !== undefined && payload.mentionPosition !== null,
    competitorRankings: payload.competitorRankings ?? payload.allRankings,
    keywordEvaluations: payload.keywordEvaluations,
    categoryRanking: payload.categoryRanking,
    amount: payload.amount,
    mainBrand: input.mainBrand,
  });
}

function materializeResultValues(input: {
  revisionId: string;
  revision: number;
  contentHash: string;
  answerContent: unknown;
  reasoningProcess: unknown;
  searchKeywords: unknown;
  sentiment: unknown;
  mentionPosition: unknown;
  mentionPositionProvided: boolean;
  competitorRankings: unknown;
  keywordEvaluations: unknown;
  categoryRanking: unknown;
  amount: unknown;
  mainBrand: string | null;
}) {
  if (typeof input.answerContent !== "string") {
    throw new RepositoryError(
      "INVALID_STATE",
      "Historical result revision is missing answer content",
    );
  }
  const brandMentioned =
    input.mentionPositionProvided ||
    Boolean(
      input.mainBrand &&
      input.answerContent
        .toLocaleLowerCase()
        .includes(input.mainBrand.toLocaleLowerCase()),
    );
  return {
    currentRevisionId: input.revisionId,
    revision: input.revision,
    contentHash: input.contentHash,
    answerMarkdown: input.answerContent,
    reasoningMarkdown:
      typeof input.reasoningProcess === "string"
        ? input.reasoningProcess
        : null,
    searchKeywords: Array.isArray(input.searchKeywords)
      ? input.searchKeywords.filter(
          (keyword): keyword is string => typeof keyword === "string",
        )
      : [],
    sentiment: normalizeSentiment(input.sentiment),
    brandMentioned,
    mentionPosition: positiveInteger(input.mentionPosition),
    competitorRankings: recordArray(input.competitorRankings),
    keywordEvaluations: normalizeKeywordEvaluations(input.keywordEvaluations),
    categoryRanking: asRecord(input.categoryRanking),
    providerAmount: decimalString(input.amount),
  };
}

function normalizeKeywordEvaluations(value: unknown) {
  if (!Array.isArray(value)) return [];
  const evaluations: Array<{
    keyword: string;
    nature: "positive" | "neutral" | "negative";
    context: string | null;
  }> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.keyword !== "string") continue;
    if (
      record.nature !== "positive" &&
      record.nature !== "neutral" &&
      record.nature !== "negative"
    ) {
      continue;
    }
    evaluations.push({
      keyword: record.keyword,
      nature: record.nature,
      context: typeof record.context === "string" ? record.context : null,
    });
  }
  return evaluations;
}

function normalizedResultPayload(
  item: MoliResultItem,
): Record<string, unknown> {
  return sanitizeJson({
    subTaskId: item.subTaskId,
    platform: item.platform,
    status: item.status,
    answerContent: item.answerContent,
    reasoningProcess: item.reasoningProcess,
    searchKeywords: item.searchKeywords,
    references: item.references,
    citationProvenance: item.citationProvenance,
    allReferences: item.allReferences,
    media: item.media,
    sentiment: item.sentiment,
    mentionPosition: item.mentionPosition,
    mentionContext: item.mentionContext,
    competitorRankings: item.competitorRankings,
    allRankings: item.allRankings,
    categoryRanking: item.categoryRanking,
    keywordEvaluations: item.keywordEvaluations,
    amount: item.amount,
    errorMessage: item.errorMessage,
    rawUpdatedAt: item.rawUpdatedAt,
    raw: item.raw,
  });
}

function sanitizeJson(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value, (_key, item) =>
    item === undefined ? null : item,
  );
  const parsed: unknown = JSON.parse(serialized ?? "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return sanitizeJson(value);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.flatMap((item) => (asRecord(item) ? [asRecord(item)!] : []))
    : asRecord(value)
      ? [asRecord(value)!]
      : [];
}

function normalizeSentiment(
  value: unknown,
): "positive" | "neutral" | "negative" | "unknown" {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : typeof value === "object" && value !== null && "sentiment" in value
        ? String((value as { sentiment?: unknown }).sentiment)
            .trim()
            .toLowerCase()
        : "";
  if (["positive", "正面", "正向"].includes(normalized)) return "positive";
  if (["neutral", "中性"].includes(normalized)) return "neutral";
  if (["negative", "负面", "负向"].includes(normalized)) return "negative";
  return "unknown";
}

function normalizeMediaType(
  kind: string,
): "screenshot" | "image" | "video" | "goods" {
  if (kind === "screenshot" || kind === "video" || kind === "goods")
    return kind;
  return "image";
}

function normalizeRawTimestamp(
  value: string | number | undefined,
): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function decimalString(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    !/^-?\d+(?:\.\d{1,4})?$/u.test(value.trim())
  ) {
    return null;
  }
  return value.trim();
}

function assertScreenshot(value: number): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new RepositoryError(
    "INVALID_STATE",
    "Invalid screenshot policy in attempt snapshot",
  );
}

function terminalAttempt(status: string): boolean {
  return [
    "completed",
    "failed",
    "stopped",
    "error",
    "cancelled_before_submit",
    "review_required",
  ].includes(status);
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function domainFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function billingProviderRecordId(
  record: MoliBillingRecordsPage["records"][number],
): string {
  const identity = record.id
    ? `id:${record.id}`
    : `raw:${stableJson(record.raw)}`;
  return `billing:${sha256(identity)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, length);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * The media worker persists the display derivative while the upstream bytes use
 * the same content hash and an `.original` suffix. Purge derives this companion
 * key so the unexposed original cannot be orphaned in object storage.
 */
function originalObjectKeyForDisplay(displayKey: string): string | null {
  return displayKey.endsWith(".webp")
    ? `${displayKey.slice(0, -".webp".length)}.original`
    : null;
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The provider accepts at most 31 inclusive calendar days per reconciliation request. */
function cappedBillingEndDate(startDate: string, through: Date): string {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()))
    throw new RepositoryError("INVALID_STATE", "Invalid billing cursor date");
  const throughDate = new Date(`${dateString(through)}T00:00:00.000Z`);
  if (throughDate <= start) return startDate;
  const maximumInclusiveEnd = new Date(start.getTime() + 30 * 86_400_000);
  return dateString(
    maximumInclusiveEnd < throughDate ? maximumInclusiveEnd : throughDate,
  );
}

function nextShanghaiDay(value: Date): Date {
  const shanghaiLocal = new Date(value.getTime() + 8 * 60 * 60_000);
  return new Date(
    Date.UTC(
      shanghaiLocal.getUTCFullYear(),
      shanghaiLocal.getUTCMonth(),
      shanghaiLocal.getUTCDate() + 1,
    ) -
      8 * 60 * 60_000,
  );
}
