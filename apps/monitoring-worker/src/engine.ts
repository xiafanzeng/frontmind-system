import { setTimeout as delay } from "node:timers/promises";
import { DeferJobError, TerminalJobError, safeErrorSummary } from "./errors.js";
import type { WorkerJobType } from "./job-types.js";
import type { LoggerPort, WorkerRepositoryPort } from "./ports.js";
import type { WorkerProcessor } from "./processor.js";

export interface WorkerEngineOptions {
  workerId: string;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  maintenanceMs?: number;
  typeConcurrency?: Partial<Record<WorkerJobType, number>>;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class WorkerEngine {
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maintenanceMs: number;
  private readonly gates = new Map<WorkerJobType, Semaphore>();

  constructor(
    private readonly repository: WorkerRepositoryPort,
    private readonly processor: WorkerProcessor,
    private readonly logger: LoggerPort,
    private readonly options: WorkerEngineOptions,
  ) {
    this.concurrency = options.concurrency ?? 20;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.maintenanceMs = options.maintenanceMs ?? 30_000;
    for (const [jobType, limit] of Object.entries(
      options.typeConcurrency ?? {},
    )) {
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1)
          throw new TypeError(`Invalid concurrency for ${jobType}`);
        this.gates.set(jobType as WorkerJobType, new Semaphore(limit));
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let lastHeartbeat = 0;
    let lastMaintenance = 0;
    this.logger.info("Worker started", {
      workerId: this.options.workerId,
      concurrency: this.concurrency,
    });
    while (!signal.aborted) {
      const now = new Date();
      if (now.valueOf() - lastHeartbeat >= this.heartbeatMs) {
        await this.repository.heartbeatWorker(this.options.workerId, now);
        lastHeartbeat = now.valueOf();
      }
      if (now.valueOf() - lastMaintenance >= this.maintenanceMs) {
        await this.repository.enqueueMaintenanceJobs(now);
        lastMaintenance = now.valueOf();
      }

      const jobs = await this.repository.leaseJobs({
        workerId: this.options.workerId,
        now,
        limit: this.concurrency,
        leaseMs: this.leaseMs,
      });
      if (!jobs.length) {
        await delay(this.pollMs, undefined, { signal }).catch(() => undefined);
        continue;
      }
      await Promise.all(jobs.map((job) => this.processJob(job, signal)));
    }
    this.logger.info("Worker stopped", { workerId: this.options.workerId });
  }

  private async processJob(
    job: Awaited<ReturnType<WorkerRepositoryPort["leaseJobs"]>>[number],
    signal: AbortSignal,
  ): Promise<void> {
    const renewal = setInterval(
      () => {
        void this.repository
          .renewJobLease(
            job.id,
            this.options.workerId,
            new Date(Date.now() + this.leaseMs),
          )
          .catch((error: unknown) => {
            this.logger.warn("Failed to renew job lease", {
              jobId: job.id,
              error: safeErrorSummary(error),
            });
          });
      },
      Math.max(5_000, Math.floor(this.leaseMs / 3)),
    );
    renewal.unref?.();
    try {
      const operation = () => this.processor.handle(job, signal);
      const gate = this.gates.get(job.type);
      if (gate) await gate.run(operation);
      else await operation();
      await this.repository.completeJob(
        job.id,
        this.options.workerId,
        new Date(),
      );
    } catch (error) {
      if (error instanceof DeferJobError) {
        await this.repository.deferJob(
          job.id,
          this.options.workerId,
          error.availableAt,
          safeErrorSummary(error),
        );
        return;
      }
      const summary = safeErrorSummary(error);
      if (
        error instanceof TerminalJobError ||
        job.attemptCount + 1 >= job.maxAttempts
      ) {
        await this.repository.deadLetterJob({
          jobId: job.id,
          workerId: this.options.workerId,
          failedAt: new Date(),
          error: summary,
        });
        this.logger.error("Worker job dead-lettered", {
          jobId: job.id,
          jobType: job.type,
          error: summary,
        });
        return;
      }
      const exponent = Math.min(job.attemptCount, 8);
      const backoffMs = Math.min(15 * 60_000, 1_000 * 2 ** exponent);
      await this.repository.retryJob({
        jobId: job.id,
        workerId: this.options.workerId,
        availableAt: new Date(Date.now() + backoffMs),
        error: summary,
      });
      this.logger.warn("Worker job will retry", {
        jobId: job.id,
        jobType: job.type,
        attemptCount: job.attemptCount,
        error: summary,
      });
    } finally {
      clearInterval(renewal);
    }
  }
}
