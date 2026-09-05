import {
  AliOssPrivateObjectStore,
  LocalPrivateObjectStore,
} from "@frontmind/monitoring-object-store";
import { MoliClient } from "@frontmind/monitoring-provider-moli";
import type { WorkerConfig } from "./config.js";
import { WorkerEngine } from "./engine.js";
import { createJsonLogger } from "./logger.js";
import type { WorkerRepositoryPort } from "./ports.js";
import { WorkerProcessor } from "./processor.js";
import { createPublisherWorkerEngine } from "./publishing/bootstrap.js";
import type { PublisherWorkerRepositoryPort } from "./publishing/ports.js";

export function createWorkerEngine(
  config: WorkerConfig,
  repository: WorkerRepositoryPort,
): WorkerEngine {
  const logger = createJsonLogger();
  const provider = new MoliClient({
    token: config.moli.token,
    origin: config.moli.origin,
    timeoutMs: config.moli.timeoutMs,
  });
  const objectStore = createObjectStore(config);
  const processor = new WorkerProcessor(
    { repository, provider, objectStore, logger },
    {
      providerDailyDispatchLimit: config.runtime.dailyDispatchLimit,
      providerSubmitIntervalMs: config.runtime.submitIntervalMs,
      providerActiveAttemptLimit: config.runtime.activeAttemptLimit,
      providerSubmissionConcurrency: config.runtime.submitConcurrency,
      mediaMaxBytes: config.runtime.mediaMaxBytes,
    },
  );
  return new WorkerEngine(repository, processor, logger, {
    workerId: config.workerId,
    concurrency: config.runtime.concurrency,
    typeConcurrency: {
      submit_attempt: config.runtime.submitConcurrency,
      stop_attempt: config.runtime.submitConcurrency,
      poll_attempt: config.runtime.syncConcurrency,
      fetch_result: config.runtime.resultConcurrency,
      archive_media: config.runtime.mediaConcurrency,
    },
  });
}

export interface WorkerRuntime {
  run(signal: AbortSignal): Promise<void>;
}

/**
 * Assemble monitoring and media-publishing as independent durable engines in
 * one process. Publishing remains completely absent when its feature flag is
 * false, so missing KOL credentials cannot affect monitoring startup.
 */
export function createWorkerRuntime(
  config: WorkerConfig,
  monitoringRepository: WorkerRepositoryPort,
  publisherRepository?: PublisherWorkerRepositoryPort,
): WorkerRuntime {
  const monitoring = createWorkerEngine(config, monitoringRepository);
  if (!config.publisher.enabled) return monitoring;
  if (!publisherRepository) {
    throw new Error(
      "Publisher worker repository is required when media publishing is enabled",
    );
  }
  const logger = createJsonLogger();
  const publisher = createPublisherWorkerEngine({
    config: config.publisher,
    repository: publisherRepository,
    objectStore: createPublisherObjectStore(config),
    logger,
  });
  return {
    async run(signal: AbortSignal) {
      const shared = new AbortController();
      const forwardAbort = () => shared.abort(signal.reason);
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        await Promise.all([
          monitoring.run(shared.signal),
          publisher.run(shared.signal),
        ]);
      } finally {
        signal.removeEventListener("abort", forwardAbort);
        if (!shared.signal.aborted) {
          shared.abort(new Error("A worker engine stopped unexpectedly"));
        }
      }
    },
  };
}

function createObjectStore(config: WorkerConfig) {
  return config.objectStore.driver === "local"
    ? new LocalPrivateObjectStore({
        rootDirectory: config.objectStore.rootDirectory,
      })
    : new AliOssPrivateObjectStore({
        bucket: config.objectStore.bucket,
        endpoint: config.objectStore.endpoint,
        credentials: {
          accessKeyId: config.objectStore.accessKeyId,
          accessKeySecret: config.objectStore.accessKeySecret,
        },
      });
}

function createPublisherObjectStore(config: WorkerConfig) {
  if (config.objectStore.driver === "local") return createObjectStore(config);
  return new AliOssPrivateObjectStore({
    bucket: config.objectStore.bucket,
    endpoint: config.objectStore.endpoint,
    credentials: {
      accessKeyId:
        config.publisher.ossAccessKeyId ?? config.objectStore.accessKeyId,
      accessKeySecret:
        config.publisher.ossAccessKeySecret ??
        config.objectStore.accessKeySecret,
    },
  });
}
