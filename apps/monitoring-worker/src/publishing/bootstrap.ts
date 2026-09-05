import type { PrivateObjectStore } from "@frontmind/monitoring-object-store";
import { KolClient, MockKolClient } from "@frontmind/monitoring-provider-kol";
import type { PublisherRuntimeConfig } from "../config.js";
import type { LoggerPort } from "../ports.js";
import { PublisherWorkerEngine } from "./engine.js";
import { HttpPublisherLogoSearchAdapter } from "./logo-search.js";
import type { PublisherWorkerRepositoryPort } from "./ports.js";
import { PublisherWorkerProcessor } from "./processor.js";

export function createPublisherWorkerEngine(input: {
  config: PublisherRuntimeConfig;
  repository: PublisherWorkerRepositoryPort;
  objectStore: PrivateObjectStore;
  logger: LoggerPort;
}): PublisherWorkerEngine {
  const provider =
    input.config.mode === "mock"
      ? new MockKolClient()
      : new KolClient({
          baseUrl: input.config.baseUrl,
          accessToken: input.config.accessToken,
          apiKey: input.config.apiKey,
          mobile: input.config.mobile,
          password: input.config.password,
          identity: input.config.identity,
          captcha: input.config.captcha,
          captchaToken: input.config.captchaToken,
          mode: input.config.mode,
          realEnabled: input.config.realEnabled,
          publishEnabled: input.config.publishEnabled,
          createOrderEncoding: input.config.createOrderEncoding,
          testResourceId: input.config.testResourceId,
          timeoutMs: input.config.timeoutMs,
          maxGetAttempts: input.config.maxGetAttempts,
          getRetryBaseMs: input.config.getRetryBaseMs,
        });
  const processor = new PublisherWorkerProcessor(
    {
      repository: input.repository,
      provider,
      objectStore: input.objectStore,
      logger: input.logger,
      ...(input.config.logoSearch
        ? {
            logoSearch: new HttpPublisherLogoSearchAdapter(
              input.config.logoSearch,
            ),
          }
        : {}),
    },
    input.config,
  );
  return new PublisherWorkerEngine(input.repository, processor, input.logger, {
    workerId: input.config.workerId,
    concurrency: input.config.concurrency,
    typeConcurrency: {
      submit_publication_item: 1,
      sync_kol_catalog: 1,
      archive_publisher_media_logo: Math.max(1, input.config.concurrency),
      import_docx: input.config.importConcurrency,
      poll_publication_item: input.config.pollConcurrency,
    },
  });
}
