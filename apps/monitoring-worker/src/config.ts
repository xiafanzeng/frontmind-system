import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value)
    throw new Error(`Missing required worker environment variable: ${key}`);
  if (/^replace(?:[-_]|$)/iu.test(value)) {
    throw new Error(`${key} must be replaced with a real value`);
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer`);
  return value;
}

function booleanFlag(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback = false,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be a boolean flag`);
}

function optionalSecret(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  if (/^replace(?:[-_]|$)/iu.test(value)) {
    throw new Error(`${key} must be replaced with a real value`);
  }
  return value;
}

function providerOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const configured =
    env.MOLI_API_ORIGIN?.trim() ?? env.MOLI_API_BASE_URL?.trim();
  // Older FrontMind environment templates used the monitor-specific base URL.
  // The typed client centralizes full paths, so normalize it back to the origin.
  return configured?.replace(/\/api\/business\/monitor\/?$/, "");
}

function validateProductionUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use HTTP(S)`);
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:")
    throw new Error(`${key} must use HTTPS in production`);
  if (parsed.username || parsed.password)
    throw new Error(`${key} must not contain URL credentials`);
}

export interface WorkerConfig {
  workerId: string;
  repositoryModule: string;
  moli: {
    token: string;
    origin?: string;
    timeoutMs: number;
  };
  objectStore:
    | {
        driver: "oss";
        bucket: string;
        endpoint: string;
        accessKeyId: string;
        accessKeySecret: string;
      }
    | {
        driver: "local";
        rootDirectory: string;
      };
  runtime: {
    concurrency: number;
    submitConcurrency: number;
    submitIntervalMs: number;
    activeAttemptLimit: number;
    syncConcurrency: number;
    resultConcurrency: number;
    mediaConcurrency: number;
    dailyDispatchLimit: number;
    mediaMaxBytes: number;
  };
  publisher: PublisherRuntimeConfig;
}

export interface PublisherRuntimeConfig {
  enabled: boolean;
  workerId: string;
  mode: "mock" | "test" | "live";
  realEnabled: boolean;
  publishEnabled: boolean;
  imageEnabled: boolean;
  webhookEnabled: boolean;
  publicOrigin: string;
  baseUrl: string;
  accessToken?: string;
  apiKey?: string;
  mobile?: string;
  password?: string;
  identity?: string;
  captcha?: string;
  captchaToken?: string;
  ossAccessKeyId?: string;
  ossAccessKeySecret?: string;
  createOrderEncoding: "json" | "form" | "unknown";
  testResourceId?: number;
  timeoutMs: number;
  maxGetAttempts: number;
  getRetryBaseMs: number;
  concurrency: number;
  importConcurrency: number;
  pollConcurrency: number;
  submissionIntervalMs: number;
  logoSearch?: {
    endpoint: string;
    apiKey?: string;
    timeoutMs: number;
    evidenceDomains: string[];
  };
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const workerId =
    env.WORKER_ID?.trim() ??
    `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const origin = providerOrigin(env);
  const ossEndpoint =
    env.OSS_ENDPOINT?.trim() ?? "https://oss-cn-wuhan-lr.aliyuncs.com";
  validateProductionUrl(env, "MOLI_API_ORIGIN", origin);
  validateProductionUrl(
    env,
    "MOLI_CALLBACK_URL",
    env.MOLI_CALLBACK_URL?.trim(),
  );
  validateProductionUrl(env, "OSS_ENDPOINT", ossEndpoint);
  const objectStore = (() => {
    const driver = env.OBJECT_STORE_DRIVER?.trim().toLowerCase() ?? "oss";
    if (driver === "local") {
      if (env.NODE_ENV === "production") {
        throw new Error("Local object storage is forbidden in production");
      }
      const configuredDirectory = required(env, "LOCAL_OBJECT_STORE_DIR");
      if (!path.isAbsolute(configuredDirectory)) {
        throw new Error("LOCAL_OBJECT_STORE_DIR must be an absolute path");
      }
      const rootDirectory = path.resolve(configuredDirectory);
      if (rootDirectory === path.parse(rootDirectory).root) {
        throw new Error("LOCAL_OBJECT_STORE_DIR must not be a filesystem root");
      }
      return { driver: "local" as const, rootDirectory };
    }
    if (driver !== "oss") {
      throw new Error("OBJECT_STORE_DRIVER must be either oss or local");
    }
    return {
      driver: "oss" as const,
      bucket: required(env, "OSS_MEDIA_BUCKET"),
      endpoint: ossEndpoint,
      accessKeyId: required(env, "OSS_ACCESS_KEY_ID"),
      accessKeySecret: required(env, "OSS_ACCESS_KEY_SECRET"),
    };
  })();
  const publisherEnabled = booleanFlag(env, "PUBLISHER_FEATURE_ENABLED");
  const publisherFlag = (key: string, fallback = false): boolean =>
    publisherEnabled ? booleanFlag(env, key, fallback) : fallback;
  const publisherPositiveInteger = (key: string, fallback: number): number =>
    publisherEnabled ? positiveInteger(env, key, fallback) : fallback;
  const publisherMode = (() => {
    if (!publisherEnabled) return "mock" as const;
    const value = env.PUBLISHER_MODE?.trim().toLowerCase() ?? "mock";
    if (value !== "mock" && value !== "test" && value !== "live") {
      throw new Error("PUBLISHER_MODE must be mock, test or live");
    }
    return value;
  })();
  const createOrderEncoding = (() => {
    if (!publisherEnabled) return "unknown" as const;
    const value =
      env.PUBLISHER_CREATE_ORDER_ENCODING?.trim().toLowerCase() ??
      env.KOL_CREATE_ORDER_ENCODING?.trim().toLowerCase() ??
      "unknown";
    if (value !== "json" && value !== "form" && value !== "unknown") {
      throw new Error(
        "PUBLISHER_CREATE_ORDER_ENCODING must be json, form or unknown",
      );
    }
    return value;
  })();
  const publisherPublicOrigin = publisherEnabled
    ? (env.PUBLISHER_PUBLIC_ORIGIN?.trim() ??
      env.PUBLIC_ORIGIN?.trim() ??
      "http://localhost:3000")
    : "http://localhost:3000";
  const publisherBaseUrl = publisherEnabled
    ? (env.PUBLISHER_KOL_BASE_URL?.trim() ??
      env.KOL_BASE_URL?.trim() ??
      "https://invalid.kol.local")
    : "https://invalid.kol.local";
  if (publisherEnabled) {
    validateProductionUrl(
      env,
      "PUBLISHER_PUBLIC_ORIGIN",
      publisherPublicOrigin,
    );
    validateProductionUrl(env, "PUBLISHER_KOL_BASE_URL", publisherBaseUrl);
    for (const [key, value] of [
      ["PUBLISHER_PUBLIC_ORIGIN", publisherPublicOrigin],
      ["PUBLISHER_KOL_BASE_URL", publisherBaseUrl],
    ] as const) {
      try {
        new URL(value);
      } catch {
        throw new Error(`${key} must be an absolute URL`);
      }
    }
  }
  const testResourceId = !publisherEnabled
    ? undefined
    : env.PUBLISHER_TEST_RESOURCE_ID
      ? positiveInteger(env, "PUBLISHER_TEST_RESOURCE_ID", 1)
      : env.KOL_TEST_RESOURCE_ID
        ? positiveInteger(env, "KOL_TEST_RESOURCE_ID", 1)
        : undefined;
  // Publisher credentials are intentionally outside the monitoring startup
  // boundary. Old templates may contain redacted/placeholder KOL values; while
  // the feature is disabled they must neither be parsed nor validated.
  const publisherStorageSecret = (key: string): string | undefined =>
    publisherEnabled ? optionalSecret(env, key) : undefined;
  const publisherProviderSecret = (key: string): string | undefined =>
    publisherEnabled && publisherMode !== "mock"
      ? optionalSecret(env, key)
      : undefined;
  const publisherKolAccessToken = publisherProviderSecret(
    "PUBLISHER_KOL_ACCESS_TOKEN",
  );
  const publisherLoginSecret = (
    primaryKey: string,
    legacyKey: string,
  ): string | undefined =>
    publisherKolAccessToken
      ? undefined
      : (publisherProviderSecret(primaryKey) ??
        publisherProviderSecret(legacyKey));
  const publisherKolApiKey = publisherLoginSecret(
    "PUBLISHER_KOL_API_KEY",
    "KOL_API_KEY",
  );
  const publisherKolMobile = publisherLoginSecret(
    "PUBLISHER_KOL_MOBILE",
    "KOL_MOBILE",
  );
  const publisherKolPassword = publisherLoginSecret(
    "PUBLISHER_KOL_PASSWORD",
    "KOL_PASSWORD",
  );
  const publisherKolIdentity = publisherLoginSecret(
    "PUBLISHER_KOL_IDENTITY",
    "KOL_IDENTITY",
  );
  const publisherKolCaptcha = publisherLoginSecret(
    "PUBLISHER_KOL_CAPTCHA",
    "KOL_CAPTCHA",
  );
  const publisherKolCaptchaToken = publisherLoginSecret(
    "PUBLISHER_KOL_CAPTCHA_TOKEN",
    "KOL_CAPTCHA_TOKEN",
  );
  const publisherLogoSearchEndpoint =
    publisherEnabled && publisherMode !== "mock"
      ? env.PUBLISHER_LOGO_SEARCH_ENDPOINT?.trim()
      : undefined;
  const publisherLogoSearchApiKey = publisherProviderSecret(
    "PUBLISHER_LOGO_SEARCH_API_KEY",
  );
  if (!publisherLogoSearchEndpoint && publisherLogoSearchApiKey) {
    throw new Error(
      "PUBLISHER_LOGO_SEARCH_API_KEY requires PUBLISHER_LOGO_SEARCH_ENDPOINT",
    );
  }
  if (publisherLogoSearchEndpoint) {
    validateProductionUrl(
      env,
      "PUBLISHER_LOGO_SEARCH_ENDPOINT",
      publisherLogoSearchEndpoint,
    );
  }
  if (
    publisherEnabled &&
    publisherMode !== "mock" &&
    !publisherKolAccessToken &&
    ![
      publisherKolApiKey,
      publisherKolMobile,
      publisherKolPassword,
      publisherKolIdentity,
      publisherKolCaptchaToken,
      publisherKolCaptcha,
    ].every(Boolean)
  ) {
    throw new Error(
      "KOL authentication requires PUBLISHER_KOL_ACCESS_TOKEN or all six Worker-only login fields",
    );
  }
  const publisherOssAccessKeyId = publisherStorageSecret(
    "PUBLISHER_OSS_WRITE_ACCESS_KEY_ID",
  );
  const publisherOssAccessKeySecret = publisherStorageSecret(
    "PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET",
  );
  if (
    Boolean(publisherOssAccessKeyId) !== Boolean(publisherOssAccessKeySecret)
  ) {
    throw new Error(
      "PUBLISHER_OSS_WRITE_ACCESS_KEY_ID and PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET must be configured together",
    );
  }
  return {
    workerId,
    repositoryModule:
      env.WORKER_REPOSITORY_MODULE?.trim() ?? "@frontmind/monitoring-db/worker-adapter",
    moli: {
      token: required(env, "MOLI_API_TOKEN"),
      origin,
      timeoutMs: positiveInteger(env, "MOLI_TIMEOUT_MS", 20_000),
    },
    objectStore,
    runtime: {
      concurrency: positiveInteger(env, "WORKER_CONCURRENCY", 20),
      submitConcurrency: positiveInteger(env, "WORKER_SUBMIT_CONCURRENCY", 2),
      submitIntervalMs: positiveInteger(
        env,
        "WORKER_SUBMIT_INTERVAL_MS",
        1_000,
      ),
      activeAttemptLimit: positiveInteger(
        env,
        "WORKER_ACTIVE_ATTEMPT_LIMIT",
        20,
      ),
      syncConcurrency: positiveInteger(env, "WORKER_SYNC_CONCURRENCY", 8),
      resultConcurrency: positiveInteger(env, "WORKER_RESULT_CONCURRENCY", 4),
      mediaConcurrency: positiveInteger(env, "WORKER_MEDIA_CONCURRENCY", 2),
      dailyDispatchLimit: env.PROVIDER_DAILY_DISPATCH_LIMIT
        ? positiveInteger(env, "PROVIDER_DAILY_DISPATCH_LIMIT", 1_000)
        : positiveInteger(env, "DAILY_DISPATCH_LIMIT", 1_000),
      mediaMaxBytes: positiveInteger(env, "MEDIA_MAX_BYTES", 15 * 1024 * 1024),
    },
    publisher: {
      enabled: publisherEnabled,
      workerId: `${workerId}:publisher`,
      mode: publisherMode,
      realEnabled: publisherFlag("PUBLISHER_REAL_ENABLED"),
      publishEnabled: publisherFlag("PUBLISHER_PUBLISH_ENABLED"),
      imageEnabled:
        publisherFlag("PUBLISHER_IMAGE_ENABLED") &&
        publisherFlag("PUBLISHER_PUBLIC_ASSETS_ENABLED"),
      webhookEnabled:
        publisherEnabled && env.PUBLISHER_WEBHOOK_ENABLED
          ? publisherFlag("PUBLISHER_WEBHOOK_ENABLED")
          : publisherFlag("KOL_WEBHOOK_ENABLED"),
      publicOrigin: publisherPublicOrigin,
      baseUrl: publisherBaseUrl,
      accessToken: publisherKolAccessToken,
      apiKey: publisherKolApiKey,
      mobile: publisherKolMobile,
      password: publisherKolPassword,
      identity: publisherKolIdentity,
      captcha: publisherKolCaptcha,
      captchaToken: publisherKolCaptchaToken,
      ossAccessKeyId: publisherOssAccessKeyId,
      ossAccessKeySecret: publisherOssAccessKeySecret,
      createOrderEncoding,
      testResourceId,
      timeoutMs: publisherPositiveInteger(
        "PUBLISHER_REQUEST_TIMEOUT_MS",
        20_000,
      ),
      maxGetAttempts: publisherPositiveInteger("PUBLISHER_GET_MAX_ATTEMPTS", 3),
      getRetryBaseMs: publisherPositiveInteger(
        "PUBLISHER_GET_RETRY_BASE_MS",
        300,
      ),
      concurrency: publisherPositiveInteger("PUBLISHER_WORKER_CONCURRENCY", 8),
      importConcurrency: publisherPositiveInteger(
        "PUBLISHER_IMPORT_CONCURRENCY",
        1,
      ),
      pollConcurrency: publisherPositiveInteger(
        "PUBLISHER_POLL_CONCURRENCY",
        4,
      ),
      submissionIntervalMs: publisherPositiveInteger(
        "PUBLISHER_SUBMISSION_INTERVAL_MS",
        500,
      ),
      ...(publisherLogoSearchEndpoint
        ? {
            logoSearch: {
              endpoint: publisherLogoSearchEndpoint,
              ...(publisherLogoSearchApiKey
                ? { apiKey: publisherLogoSearchApiKey }
                : {}),
              evidenceDomains: (env.PUBLISHER_LOGO_SEARCH_EVIDENCE_DOMAINS ?? "")
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean),
              timeoutMs: publisherPositiveInteger(
                "PUBLISHER_LOGO_SEARCH_TIMEOUT_MS",
                10_000,
              ),
            },
          }
        : {}),
    },
  };
}
