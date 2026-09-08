// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublisherWorkerEngine } from "../../../apps/monitoring-worker/src/publishing/engine";
import { PublisherSubmissionPersistenceError } from "../../../apps/monitoring-worker/src/publishing/errors";
import type {
  PublisherJob,
  PublisherJobType,
} from "../../../apps/monitoring-worker/src/publishing/job-types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(concurrency = 4) {
  const controller = new AbortController();
  const queue: PublisherJob[] = [];
  const operations = new Map<string, ReturnType<typeof deferred>>();
  const signals = new Map<string, AbortSignal>();
  const active = new Map<PublisherJobType, number>();
  const peak = new Map<PublisherJobType, number>();
  let activeTotal = 0;
  let peakTotal = 0;
  const repository = {
    leasePublisherJobs: vi.fn(
      async (input: {
        allowedTypes?: readonly PublisherJobType[];
        limit: number;
      }) => {
        const candidates = queue
          .filter((job) => input.allowedTypes?.includes(job.type))
          .slice(0, input.limit);
        for (const candidate of candidates)
          queue.splice(queue.indexOf(candidate), 1);
        return candidates;
      },
    ),
    enqueuePublisherMaintenanceJobs: vi.fn(async () => undefined),
    recoverExpiredPublisherSubmissions: vi.fn(async () => 0),
    renewPublisherJobLease: vi.fn(async () => undefined),
    completePublisherJob: vi.fn(async () => undefined),
    deferPublisherJob: vi.fn(async () => undefined),
    retryPublisherJob: vi.fn(async (_input: unknown) => undefined),
    deadLetterPublisherJob: vi.fn(async (_input: unknown) => undefined),
  };
  const processor = {
    cleanupExpiredObjectLeases: vi.fn(async () => ({ claimed: 0, deleted: 0 })),
    handle: vi.fn(async (job: PublisherJob, signal: AbortSignal) => {
      signals.set(job.id, signal);
      active.set(job.type, (active.get(job.type) ?? 0) + 1);
      peak.set(
        job.type,
        Math.max(peak.get(job.type) ?? 0, active.get(job.type)!),
      );
      activeTotal += 1;
      peakTotal = Math.max(peakTotal, activeTotal);
      try {
        await operations.get(job.id)!.promise;
      } finally {
        activeTotal -= 1;
        active.set(job.type, active.get(job.type)! - 1);
      }
    }),
  };
  const engine = new PublisherWorkerEngine(
    repository as never,
    processor as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      workerId: "engine-test",
      concurrency,
      pollMs: 20,
      maintenanceMs: 1_000,
      leaseMs: 15_000,
      typeConcurrency: {
        sync_kol_catalog: 1,
        archive_publisher_media_logo: 2,
        submit_publication_item: 1,
        import_docx: 1,
        poll_publication_item: 1,
      },
    },
  );
  return {
    controller,
    repository,
    processor,
    signals,
    peak,
    get peakTotal() {
      return peakTotal;
    },
    start: () => engine.run(controller.signal),
    add(id: string, type: PublisherJobType) {
      operations.set(id, deferred());
      queue.push({
        id,
        type,
        payload: {},
        attemptCount: 0,
        maxAttempts: 3,
        leasedUntil: new Date(),
      });
    },
    finish(id: string) {
      operations.get(id)!.resolve();
    },
    fail(id: string, error: unknown) {
      operations.get(id)!.reject(error);
    },
    started: () => processor.handle.mock.calls.map(([job]) => job.id),
    async stop(run: Promise<void>) {
      controller.abort();
      for (const operation of operations.values()) operation.resolve();
      await run;
    },
  };
}

it("starts a later publication and import while a full catalog sync remains running", async () => {
  const f = fixture();
  f.add("sync", "sync_kol_catalog");
  f.add("logo-1", "archive_publisher_media_logo");
  f.add("logo-2", "archive_publisher_media_logo");
  const run = f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.started()).toEqual(["sync", "logo-1", "logo-2"]);
  f.add("order", "submit_publication_item");
  await vi.advanceTimersByTimeAsync(20);
  expect(f.started()).toContain("order");
  expect(f.repository.completePublisherJob).not.toHaveBeenCalled();
  f.finish("order");
  f.add("import", "import_docx");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.started()).toContain("import");
  expect(f.started().filter((id) => id === "order")).toHaveLength(1);
  await f.stop(run);
});

it("reserves type capacity before leasing and refills a free slot without exceeding limits", async () => {
  const f = fixture();
  for (let i = 1; i <= 8; i++)
    f.add(`logo-${i}`, "archive_publisher_media_logo");
  f.add("order-1", "submit_publication_item");
  f.add("order-2", "submit_publication_item");
  f.add("import", "import_docx");
  const run = f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.started()).toEqual(["logo-1", "logo-2", "order-1", "import"]);
  expect(
    f.repository.leasePublisherJobs.mock.calls[2]![0].allowedTypes,
  ).not.toContain("archive_publisher_media_logo");
  f.finish("logo-1");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.started()).toContain("logo-3");
  expect(f.started()).not.toContain("order-2");
  f.finish("order-1");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.started()).toContain("order-2");
  expect(f.peak.get("archive_publisher_media_logo")).toBe(2);
  expect(f.peak.get("submit_publication_item")).toBe(1);
  expect(f.peakTotal).toBe(4);
  await f.stop(run);
});

it("polls an empty queue without spinning", async () => {
  const f = fixture();
  const run = f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.repository.leasePublisherJobs).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(19);
  expect(f.repository.leasePublisherJobs).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.repository.leasePublisherJobs).toHaveBeenCalledTimes(2);
  await f.stop(run);
});

it("stops claiming on abort and waits for the acquired operation to finish before returning", async () => {
  const f = fixture();
  f.add("sync", "sync_kol_catalog");
  const run = f.start();
  let stopped = false;
  void run.then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  const claimsBeforeAbort = f.repository.leasePublisherJobs.mock.calls.length;
  f.controller.abort();
  f.add("order", "submit_publication_item");
  await vi.advanceTimersByTimeAsync(100);
  expect(f.signals.get("sync")?.aborted).toBe(true);
  expect(f.repository.leasePublisherJobs).toHaveBeenCalledTimes(
    claimsBeforeAbort,
  );
  expect(f.started()).toEqual(["sync"]);
  expect(stopped).toBe(false);
  f.finish("sync");
  await run;
  expect(stopped).toBe(true);
  expect(f.repository.completePublisherJob).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("continues maintenance and lease renewal while a long catalog sync is in flight", async () => {
  const f = fixture();
  f.add("sync", "sync_kol_catalog");
  const run = f.start();
  await vi.advanceTimersByTimeAsync(5_001);
  expect(
    f.repository.enqueuePublisherMaintenanceJobs.mock.calls.length,
  ).toBeGreaterThan(1);
  expect(f.repository.renewPublisherJobLease).toHaveBeenCalledWith(
    "sync",
    "engine-test",
    expect.any(Date),
  );
  expect(f.repository.completePublisherJob).not.toHaveBeenCalled();
  await f.stop(run);
  expect(vi.getTimerCount()).toBe(0);
});

it("defers a lease returned after abort without starting a submission or spending an attempt", async () => {
  const f = fixture();
  f.add("order", "submit_publication_item");
  const returnLease = deferred();
  const acquire = f.repository.leasePublisherJobs.getMockImplementation()!;
  f.repository.leasePublisherJobs.mockImplementationOnce(async (input) => {
    const leased = await acquire(input);
    await returnLease.promise;
    return leased;
  });
  const run = f.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.repository.leasePublisherJobs).toHaveBeenCalledOnce();
  f.controller.abort();
  returnLease.resolve();
  await run;
  expect(f.processor.handle).not.toHaveBeenCalled();
  expect(f.repository.deferPublisherJob).toHaveBeenCalledWith(
    "order",
    "engine-test",
    expect.any(Date),
    "Worker stopped before the leased job started",
  );
  expect(f.repository.retryPublisherJob).not.toHaveBeenCalled();
  expect(f.repository.deadLetterPublisherJob).not.toHaveBeenCalled();
  expect(f.repository.completePublisherJob).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains the dead-letter path for an uncertain submission persistence result without re-running it", async () => {
  const f = fixture();
  f.add("order", "submit_publication_item");
  const run = f.start();
  await vi.advanceTimersByTimeAsync(0);
  f.fail(
    "order",
    new PublisherSubmissionPersistenceError(
      "Known provider result could not be persisted",
    ),
  );
  await vi.advanceTimersByTimeAsync(40);
  expect(f.repository.deadLetterPublisherJob).toHaveBeenCalledOnce();
  expect(f.repository.retryPublisherJob).not.toHaveBeenCalled();
  expect(f.started()).toEqual(["order"]);
  await f.stop(run);
});

it("aborts other in-flight work and propagates a repository failure", async () => {
  const f = fixture();
  f.add("sync", "sync_kol_catalog");
  f.add("order", "submit_publication_item");
  f.repository.deadLetterPublisherJob.mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  const run = f.start();
  const rejected = expect(run).rejects.toThrow("database unavailable");
  await vi.advanceTimersByTimeAsync(0);
  f.fail(
    "order",
    new PublisherSubmissionPersistenceError("Ambiguous submission persistence"),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(f.signals.get("sync")?.aborted).toBe(true);
  f.finish("sync");
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
