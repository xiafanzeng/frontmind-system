import { setTimeout as delay } from "node:timers/promises";
import type { PublisherJobType } from "./job-types.js";
import {
  DeferPublisherJobError,
  TerminalPublisherJobError,
  safePublisherError,
} from "./errors.js";
import type { LoggerPort } from "../ports.js";
import type { PublisherWorkerRepositoryPort } from "./ports.js";
import type { PublisherWorkerProcessor } from "./processor.js";

export interface PublisherWorkerEngineOptions {
  workerId: string;
  concurrency: number;
  leaseMs?: number;
  pollMs?: number;
  maintenanceMs?: number;
  typeConcurrency?: Partial<Record<PublisherJobType, number>>;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class PublisherWorkerEngine {
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly maintenanceMs: number;
  private readonly gates = new Map<PublisherJobType, Semaphore>();

  constructor(
    private readonly repository: PublisherWorkerRepositoryPort,
    private readonly processor: PublisherWorkerProcessor,
    private readonly logger: LoggerPort,
    private readonly options: PublisherWorkerEngineOptions,
  ) {
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.maintenanceMs = options.maintenanceMs ?? 30_000;
    for (const [type, limit] of Object.entries(options.typeConcurrency ?? {})) {
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1)
          throw new TypeError(`Invalid concurrency for ${type}`);
        this.gates.set(type as PublisherJobType, new Semaphore(limit));
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let lastMaintenance = 0;
    this.logger.info("Publisher worker started", {
      workerId: this.options.workerId,
      concurrency: this.options.concurrency,
    });
    while (!signal.aborted) {
      const now = new Date();
      if (now.valueOf() - lastMaintenance >= this.maintenanceMs) {
        await this.repository.enqueuePublisherMaintenanceJobs(now);
        const recovered =
          await this.repository.recoverExpiredPublisherSubmissions(now, 500);
        if (recovered)
          this.logger.warn(
            "Recovered expired publisher submissions as unknown",
            { recovered },
          );
        const objectCleanup =
          await this.processor.cleanupExpiredObjectLeases(signal);
        if (objectCleanup.deleted) {
          this.logger.info("Cleaned expired publisher object leases", {
            claimed: objectCleanup.claimed,
            deleted: objectCleanup.deleted,
          });
        }
        lastMaintenance = now.valueOf();
      }
      const jobs = await this.repository.leasePublisherJobs({
        workerId: this.options.workerId,
        now,
        limit: this.options.concurrency,
        leaseMs: this.leaseMs,
      });
      if (!jobs.length) {
        await delay(this.pollMs, undefined, { signal }).catch(() => undefined);
        continue;
      }
      await Promise.all(jobs.map((job) => this.processJob(job, signal)));
    }
    this.logger.info("Publisher worker stopped", {
      workerId: this.options.workerId,
    });
  }

  private async processJob(
    job: Awaited<
      ReturnType<PublisherWorkerRepositoryPort["leasePublisherJobs"]>
    >[number],
    signal: AbortSignal,
  ): Promise<void> {
    const renewal = setInterval(
      () => {
        void this.repository
          .renewPublisherJobLease(
            job.id,
            this.options.workerId,
            new Date(Date.now() + this.leaseMs),
          )
          .catch((error: unknown) => {
            this.logger.warn("Failed to renew publisher job lease", {
              jobId: job.id,
              error: safePublisherError(error),
            });
          });
      },
      Math.max(5_000, Math.floor(this.leaseMs / 3)),
    );
    renewal.unref?.();
    try {
      const gate = this.gates.get(job.type);
      const operation = () => this.processor.handle(job, signal);
      if (gate) await gate.run(operation);
      else await operation();
      await this.repository.completePublisherJob(
        job.id,
        this.options.workerId,
        new Date(),
      );
    } catch (error) {
      if (error instanceof DeferPublisherJobError) {
        await this.repository.deferPublisherJob(
          job.id,
          this.options.workerId,
          error.availableAt,
          safePublisherError(error),
        );
        return;
      }
      const summary = safePublisherError(error);
      if (
        error instanceof TerminalPublisherJobError ||
        job.attemptCount + 1 >= job.maxAttempts
      ) {
        await this.repository.deadLetterPublisherJob({
          jobId: job.id,
          workerId: this.options.workerId,
          failedAt: new Date(),
          error: summary,
        });
        this.logger.error("Publisher job dead-lettered", {
          jobId: job.id,
          jobType: job.type,
          error: summary,
        });
        return;
      }
      const backoffMs = Math.min(
        15 * 60_000,
        1_000 * 2 ** Math.min(job.attemptCount, 8),
      );
      await this.repository.retryPublisherJob({
        jobId: job.id,
        workerId: this.options.workerId,
        availableAt: new Date(Date.now() + backoffMs),
        error: summary,
      });
    } finally {
      clearInterval(renewal);
    }
  }
}
