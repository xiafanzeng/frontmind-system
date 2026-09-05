import { safeErrorForLog } from "./sensitive-data";

const RUNTIME_SECRET_ENV_KEYS = [
  "BUILT_IN_FORGE_API_KEY",
  "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
  "FRONTMIND_LIVE_TEST_API_KEY",
  "FRONTMIND_MONITOR_API_KEY",
  "FRONTMIND_PRESALES_SERVICE_TOKEN",
  "FRONTMIND_PROVISIONING_SERVICE_TOKEN",
  "JWT_SECRET",
] as const;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function isParameterizedQueryError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { query?: unknown; params?: unknown };
  return typeof candidate.query === "string" && Array.isArray(candidate.params);
}

export function runtimeLogSecrets(
  additional: Iterable<unknown> = [],
  env: RuntimeEnvironment = process.env,
) {
  const databaseUrl = env.DATABASE_URL?.trim() || "";
  let databasePassword = "";
  if (databaseUrl) {
    try {
      databasePassword = decodeURIComponent(new URL(databaseUrl).password);
    } catch {
      databasePassword = "";
    }
  }
  return [
    ...additional,
    ...RUNTIME_SECRET_ENV_KEYS.map((key) => env[key]),
    databaseUrl,
    databasePassword,
  ];
}

/** Allowlisted runtime error DTO; never returns config, request or response. */
export function runtimeErrorForLog(
  error: unknown,
  options: {
    additionalSecrets?: Iterable<unknown>;
    env?: RuntimeEnvironment;
  } = {},
) {
  const safe = safeErrorForLog(error, {
    secrets: runtimeLogSecrets(
      options.additionalSecrets,
      options.env ?? process.env,
    ),
  });
  // DrizzleQueryError embeds the complete parameter list in its outer message.
  // Dropping only the `params` property is insufficient, so parameterized
  // query failures receive a fixed operational message.
  return isParameterizedQueryError(error)
    ? { ...safe, message: "Database query failed" }
    : safe;
}
