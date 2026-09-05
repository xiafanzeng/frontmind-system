import type { PublisherWorkerRepository } from "@frontmind/monitoring-db";
import type { PublisherWorkerRepositoryPort } from "./ports.js";

type AssertPublisherWorkerRepository<T extends PublisherWorkerRepositoryPort> =
  T;

/**
 * Compile-time integration check only. Runtime publisher code continues to use
 * the local port, while this makes DB adapter drift fail the worker typecheck.
 */
export type PublisherWorkerRepositoryContract =
  AssertPublisherWorkerRepository<PublisherWorkerRepository>;
