import path from "node:path";
import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalEnvironmentString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const developmentSessionSecret =
  "frontmind-development-session-secret-change-me";

export const runtimeConfigSchema = z
  .object({
    EMBEDDED_DASHBOARD: z.boolean().default(false),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    DATABASE_URL: z.string().min(1),
    PUBLIC_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
    PUBLIC_ICP_NUMBER: optionalEnvironmentString.refine(
      (value) => value === undefined || value.length <= 128,
      "String must contain at most 128 character(s)",
    ),
    PUBLIC_ICP_LINK: z
      .string()
      .url()
      .refine(
        (value) => new URL(value).protocol === "https:",
        "ICP link must use HTTPS",
      )
      .default("https://beian.miit.gov.cn/"),
    SESSION_COOKIE_NAME: z.string().min(1).max(64).default("fm_session"),
    SESSION_SECRET: z.string().min(32).default(developmentSessionSecret),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    COOKIE_SECURE: booleanFromEnvironment,
    TRUST_PROXY: booleanFromEnvironment,
    WEB_DIST_DIR: z.string().optional(),
    BUILD_SHA: z.string().max(128).default("development"),
    BUILD_TIME: z.string().max(128).default("unknown"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    OSS_ENDPOINT: z
      .string()
      .url()
      .default("https://oss-cn-wuhan-lr.aliyuncs.com"),
    OSS_MEDIA_BUCKET: optionalEnvironmentString,
    OSS_READ_ACCESS_KEY_ID: optionalEnvironmentString,
    OSS_READ_ACCESS_KEY_SECRET: optionalEnvironmentString,
    OBJECT_STORE_DRIVER: z.enum(["oss", "local"]).default("oss"),
    ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION: booleanFromEnvironment,
    LOCAL_OBJECT_STORE_DIR: optionalEnvironmentString,
    PUBLISHER_FEATURE_ENABLED: booleanFromEnvironment,
    PUBLISHER_REAL_ENABLED: booleanFromEnvironment,
    PUBLISHER_PUBLISH_ENABLED: booleanFromEnvironment,
    PUBLISHER_IMAGE_ENABLED: booleanFromEnvironment,
    PUBLISHER_PUBLIC_ASSETS_ENABLED: booleanFromEnvironment,
    MONITORING_ACCEPTANCE_MAX_TEN_THOUSANDTHS: z.coerce
      .bigint()
      .nonnegative()
      .default(0n),
    PUBLISHER_OSS_WRITE_ACCESS_KEY_ID: optionalEnvironmentString,
    PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET: optionalEnvironmentString,
    KOL_WEBHOOK_ENABLED: booleanFromEnvironment,
    KOL_WEBHOOK_SECRET: optionalEnvironmentString,
    KOL_WEBHOOK_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536),
  })
  .superRefine((config, context) => {
    if (config.OBJECT_STORE_DRIVER === "local") {
      if (config.NODE_ENV === "production" && !config.ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION) {
        context.addIssue({
          code: "custom",
          path: ["OBJECT_STORE_DRIVER"],
          message: "Production local storage requires ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION=true",
        });
      }
      if (!config.LOCAL_OBJECT_STORE_DIR) {
        context.addIssue({
          code: "custom",
          path: ["LOCAL_OBJECT_STORE_DIR"],
          message:
            "LOCAL_OBJECT_STORE_DIR is required for local object storage",
        });
      } else {
        const resolvedDirectory = path.resolve(config.LOCAL_OBJECT_STORE_DIR);
        if (
          !path.isAbsolute(config.LOCAL_OBJECT_STORE_DIR) ||
          resolvedDirectory === path.parse(resolvedDirectory).root
        ) {
          context.addIssue({
            code: "custom",
            path: ["LOCAL_OBJECT_STORE_DIR"],
            message:
              "LOCAL_OBJECT_STORE_DIR must be an absolute non-root directory",
          });
        }
      }
    }
    // Dashboard already owns its production origin, cookie and ICP checks.
    // The embedded module validates only its own configured capabilities.
    if (config.EMBEDDED_DASHBOARD) return;
    if (config.NODE_ENV !== "production") return;
    const publicOrigin = new URL(config.PUBLIC_ORIGIN);
    if (
      publicOrigin.protocol !== "https:" ||
      publicOrigin.username ||
      publicOrigin.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ORIGIN"],
        message: "PUBLIC_ORIGIN must be credential-free HTTPS in production",
      });
    }
    const ossEndpoint = new URL(config.OSS_ENDPOINT);
    if (
      ossEndpoint.protocol !== "https:" ||
      ossEndpoint.username ||
      ossEndpoint.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["OSS_ENDPOINT"],
        message: "OSS_ENDPOINT must be credential-free HTTPS in production",
      });
    }
    if (!config.COOKIE_SECURE) {
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "COOKIE_SECURE must be true in production",
      });
    }
    if (!config.PUBLIC_ICP_NUMBER) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_ICP_NUMBER"],
        message: "PUBLIC_ICP_NUMBER is required in production",
      });
    }
    for (const key of [
      "OSS_MEDIA_BUCKET",
      "OSS_READ_ACCESS_KEY_ID",
      "OSS_READ_ACCESS_KEY_SECRET",
    ] as const) {
      if (!config[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }
    if (
      config.PUBLISHER_FEATURE_ENABLED &&
      config.OBJECT_STORE_DRIVER === "oss"
    ) {
      for (const key of [
        "PUBLISHER_OSS_WRITE_ACCESS_KEY_ID",
        "PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET",
      ] as const) {
        if (!config[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when publisher uploads are enabled`,
          });
        }
      }
    }
    if (config.KOL_WEBHOOK_ENABLED && !config.KOL_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["KOL_WEBHOOK_SECRET"],
        message: "KOL_WEBHOOK_SECRET is required when KOL webhook is enabled",
      });
    }
    const productionPlaceholders: Array<
      [keyof typeof config, string | undefined]
    > = [
      ["SESSION_SECRET", config.SESSION_SECRET],
      ["DATABASE_URL", config.DATABASE_URL],
      ["PUBLIC_ICP_NUMBER", config.PUBLIC_ICP_NUMBER],
      ["OSS_MEDIA_BUCKET", config.OSS_MEDIA_BUCKET],
      ["OSS_READ_ACCESS_KEY_ID", config.OSS_READ_ACCESS_KEY_ID],
      ["OSS_READ_ACCESS_KEY_SECRET", config.OSS_READ_ACCESS_KEY_SECRET],
      [
        "PUBLISHER_OSS_WRITE_ACCESS_KEY_ID",
        config.PUBLISHER_OSS_WRITE_ACCESS_KEY_ID,
      ],
      [
        "PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET",
        config.PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET,
      ],
      ["KOL_WEBHOOK_SECRET", config.KOL_WEBHOOK_SECRET],
    ];
    for (const [key, value] of productionPlaceholders) {
      if (
        value &&
        (value === developmentSessionSecret ||
          /(^|[:=])replace(?:[-_@]|$)/iu.test(value))
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${String(key)} must be replaced with a production value`,
        });
      }
    }
  });

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  return runtimeConfigSchema.parse({
    ...environment,
    PORT: environment.PORT ?? environment.API_PORT,
    PUBLIC_ORIGIN: environment.PUBLIC_ORIGIN ?? environment.APP_ORIGIN,
    COOKIE_SECURE:
      environment.COOKIE_SECURE ??
      (environment.NODE_ENV === "production" ? "true" : undefined),
  });
}

const secretKeyPattern =
  /(authorization|cookie|password|secret|token|access.?key|session)/iu;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.map((item) => redactSecrets(item, depth + 1));
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = secretKeyPattern.test(key)
      ? "[REDACTED]"
      : redactSecrets(item, depth + 1);
  }
  return output;
}

export function isAllowedOrigin(
  origin: string | undefined,
  expectedOrigin: string,
): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}
