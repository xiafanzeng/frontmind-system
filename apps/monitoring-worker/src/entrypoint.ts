import { loadWorkerConfig } from "./config.js";
import { createWorkerRuntime } from "./bootstrap.js";
import { assertWorkerRepositoryPort } from "./ports.js";
import {
  assertPublisherWorkerRepositoryPort,
  type PublisherWorkerRepositoryPort,
} from "./publishing/ports.js";

interface WorkerRepositoryModule {
  createWorkerRepository(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<unknown> | unknown;
}

interface PublisherWorkerRepositoryModule {
  createPublisherWorkerRepository(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<unknown> | unknown;
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  // The DB package is independently implemented. Loading it by configured module
  // keeps this package free of Drizzle schema assumptions while remaining an
  // executable production assembly point.
  const imported = (await import(
    config.repositoryModule
  )) as Partial<WorkerRepositoryModule>;
  if (typeof imported.createWorkerRepository !== "function") {
    throw new Error(
      `${config.repositoryModule} must export createWorkerRepository({ env })`,
    );
  }
  const repository = await imported.createWorkerRepository({
    env: process.env,
  });
  assertWorkerRepositoryPort(repository);
  let publisherRepository: PublisherWorkerRepositoryPort | undefined;
  if (config.publisher.enabled) {
    const publisherModule =
      (await import("@frontmind/monitoring-db")) as Partial<PublisherWorkerRepositoryModule>;
    if (typeof publisherModule.createPublisherWorkerRepository !== "function") {
      throw new Error(
        "@frontmind/monitoring-db must export createPublisherWorkerRepository({ env }) when media publishing is enabled",
      );
    }
    const candidate = await publisherModule.createPublisherWorkerRepository({
      env: process.env,
    });
    assertPublisherWorkerRepositoryPort(candidate);
    publisherRepository = candidate;
  }
  const engine = createWorkerRuntime(config, repository, publisherRepository);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Worker shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await engine.run(controller.signal);
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : "Unknown worker startup error";
  process.stderr.write(`${message.replace(/[\r\n]+/g, " ").slice(0, 1_000)}\n`);
  process.exitCode = 1;
});
