export type SiteOpsMaterializationPhase =
  | "input_validation"
  | "asset_projection"
  | "source_generation"
  | "astro_build"
  | "react_static_build"
  | "static_qa"
  | "browser_qa"
  | "lighthouse"
  | "qa_packaging"
  | "artifact_persistence";

export type SiteOpsMaterializationRetryClass =
  | "content_repair"
  | "host_transient"
  | "host_deterministic";

export type SiteOpsMaterializationSafeDetails = Record<
  string,
  string | number | boolean | null
>;

const INTERNAL_CODE = /^SITEOPS_[A-Z0-9_]+/u;

function safeInternalCode(error: unknown, fallback: string) {
  if (error instanceof SiteOpsMaterializationError) return error.code;
  if (error instanceof Error) {
    return error.message.match(INTERNAL_CODE)?.[0] ?? fallback;
  }
  return fallback;
}

/**
 * A deliberately small, log-safe boundary between the trusted host
 * materializer and its orchestrator. The original error remains available as
 * `cause` for in-process debugging, but message/details never include source
 * text, filesystem paths, provider responses or credentials.
 */
export class SiteOpsMaterializationError extends Error {
  readonly phase: SiteOpsMaterializationPhase;
  readonly code: string;
  readonly retryClass: SiteOpsMaterializationRetryClass;
  readonly safeDetails: Readonly<SiteOpsMaterializationSafeDetails>;

  constructor(input: {
    phase: SiteOpsMaterializationPhase;
    code: string;
    retryClass: SiteOpsMaterializationRetryClass;
    safeDetails?: SiteOpsMaterializationSafeDetails;
    cause?: unknown;
  }) {
    super(input.code, { cause: input.cause });
    this.name = "SiteOpsMaterializationError";
    this.phase = input.phase;
    this.code = input.code;
    this.retryClass = input.retryClass;
    this.safeDetails = Object.freeze({ ...(input.safeDetails ?? {}) });
  }
}

export function toSiteOpsMaterializationError(input: {
  error: unknown;
  phase: SiteOpsMaterializationPhase;
  fallbackCode: string;
  retryClass: SiteOpsMaterializationRetryClass;
  safeDetails?: SiteOpsMaterializationSafeDetails;
}) {
  if (input.error instanceof SiteOpsMaterializationError) return input.error;
  return new SiteOpsMaterializationError({
    phase: input.phase,
    code: safeInternalCode(input.error, input.fallbackCode),
    retryClass: input.retryClass,
    safeDetails: input.safeDetails,
    cause: input.error,
  });
}

export async function materializationStage<T>(input: {
  phase: SiteOpsMaterializationPhase;
  fallbackCode: string;
  retryClass: SiteOpsMaterializationRetryClass;
  safeDetails?: SiteOpsMaterializationSafeDetails;
  run: () => T | Promise<T>;
}): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    throw toSiteOpsMaterializationError({ ...input, error });
  }
}
