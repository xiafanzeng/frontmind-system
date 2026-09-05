import path from "node:path";
import { hkdfSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const DOWNLOAD_TOKEN_DERIVATION_SALT = Buffer.from(
  "frontmind-dashboard/download-token/salt/v1",
  "utf8",
);
const DOWNLOAD_TOKEN_DERIVATION_INFO = Buffer.from(
  "frontmind-dashboard/download-token-signing/v1",
  "utf8",
);

const fail = (code) => {
  throw new Error(code);
};

const exactValues = {
  NODE_ENV: "production",
  PORT: "3001",
  FRONTMIND_PUBLIC_URL: "https://dashboard.frontmind.net",
  FRONTMIND_WEBSITE_URL: "https://www.frontmind.net",
  FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_TTL_SECONDS: "300",
  FRONTMIND_PREPARED_FILE_DIR: "/var/lib/frontmind/prepared-files",
  FRONTMIND_PREPARED_FILE_TTL_MS: "2592000000",
  FRONTMIND_DASHBOARD_ASSET_DIR: "/var/lib/frontmind/dashboard-assets",
  FRONTMIND_PDF_WORKERS: "1",
  FRONTMIND_CONVERSATION_RETENTION_DAYS: "30",
  FRONTMIND_SERVICE_ENTITLEMENT_ENFORCEMENT: "auto",
  FRONTMIND_KB_SKILL_PATH:
    "/app/dist/private-workflows/socratic-kb-builder.skill",
  FRONTMIND_BRAND_QUESTION_SKILL_PATH:
    "/app/dist/private-workflows/brand-question-portfolio.skill",
  FRONTMIND_RESPONSE_LOGIC_SKILL_PATH:
    "/app/dist/private-workflows/response-logic-builder.skill",
};

const secretNames = [
  "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
  "FRONTMIND_PRESALES_SERVICE_TOKEN",
  "FRONTMIND_PROVISIONING_SERVICE_TOKEN",
  "FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET",
  "FRONTMIND_MONITOR_API_KEY",
];

const decodeBase64Key = (env, name) => {
  const value = env[name] || "";
  if (!value.startsWith("base64:")) fail(`${name}_FORMAT_INVALID`);
  const encoded = value.slice("base64:".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail(`${name}_FORMAT_INVALID`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length !== 32 ||
    decoded.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    fail(`${name}_FORMAT_INVALID`);
  }
  return decoded;
};

export const deriveDownloadTokenSecretFromCredentialMasterKey = (masterKey) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      DOWNLOAD_TOKEN_DERIVATION_SALT,
      DOWNLOAD_TOKEN_DERIVATION_INFO,
      32,
    ),
  ).toString("base64url");

export function validateProductionRuntimeEnvironment(env = process.env) {
  const configuredBuildSourceSha = env.FRONTMIND_BUILD_SHA || "";
  if (!/^[a-f0-9]{40}$/u.test(configuredBuildSourceSha)) {
    fail("FRONTMIND_BUILD_SHA_VALUE_INVALID");
  }
  const imageDigest = env.FRONTMIND_IMAGE_DIGEST || "";
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    fail("FRONTMIND_IMAGE_DIGEST_VALUE_INVALID");
  }

  for (const [name, expected] of Object.entries(exactValues)) {
    if (env[name] !== expected) fail(`${name}_VALUE_INVALID`);
  }

  const knowledgeBaseRollout = env.FRONTMIND_KB_V4_ROLLOUT_PERCENT || "";
  if (!/^(?:100|[0-9]{1,2})(?:\.\d{1,2})?$/u.test(knowledgeBaseRollout)) {
    fail("FRONTMIND_KB_V4_ROLLOUT_PERCENT_VALUE_INVALID");
  }
  const rolloutValue = Number(knowledgeBaseRollout);
  if (rolloutValue < 0 || rolloutValue > 100) {
    fail("FRONTMIND_KB_V4_ROLLOUT_PERCENT_VALUE_INVALID");
  }
  const knowledgeBaseAllowlist = env.FRONTMIND_KB_V4_ALLOW_USER_IDS || "";
  if (
    knowledgeBaseAllowlist &&
    !/^[1-9]\d*(?:,[1-9]\d*)*$/u.test(knowledgeBaseAllowlist)
  ) {
    fail("FRONTMIND_KB_V4_ALLOW_USER_IDS_VALUE_INVALID");
  }
  const knowledgeBaseWritesDisabled = env.KNOWLEDGE_BASE_WRITES_DISABLED || "";
  if (
    knowledgeBaseWritesDisabled &&
    !/^(?:0|1|false|true|no|yes|off|on)$/iu.test(knowledgeBaseWritesDisabled)
  ) {
    fail("KNOWLEDGE_BASE_WRITES_DISABLED_VALUE_INVALID");
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL_MISSING");
  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL_FORMAT_INVALID");
  }
  if (
    target.protocol !== "mysql:" ||
    target.hostname !== "mysql" ||
    (target.port && target.port !== "3306") ||
    decodeURIComponent(target.username) !== "frontmind_dashboard" ||
    target.pathname !== "/frontmind_dashboard" ||
    target.search ||
    target.hash ||
    !target.password
  ) {
    fail("DATABASE_URL_TARGET_INVALID");
  }

  const credentialMasterKey = decodeBase64Key(
    env,
    "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
  );
  for (const name of secretNames.slice(1)) {
    const value = env[name] || "";
    if (
      value.length < 32 ||
      /^(?:replace|placeholder|changeme|test|example)/iu.test(value)
    ) {
      fail(`${name}_VALUE_INVALID`);
    }
  }

  // Keep this precedence identical to resolveDownloadTokenSecret(). A short
  // dedicated value must not be silently rescued by JWT_SECRET because the
  // runtime resolver would select the dedicated value and fail after rollout.
  const configuredDownloadTokenSecret =
    (env.FRONTMIND_DOWNLOAD_TOKEN_SECRET || "").trim() ||
    (env.JWT_SECRET || "").trim();
  const downloadTokenSecret =
    configuredDownloadTokenSecret ||
    deriveDownloadTokenSecretFromCredentialMasterKey(credentialMasterKey);
  if (configuredDownloadTokenSecret) {
    if (
      downloadTokenSecret.length < 32 ||
      /^(?:replace|placeholder|changeme|test|example)/iu.test(
        downloadTokenSecret,
      )
    ) {
      fail("FRONTMIND_DOWNLOAD_TOKEN_SECRET_VALUE_INVALID");
    }
  }

  const secrets = [
    ...secretNames.map((name) => env[name]),
    ...(configuredDownloadTokenSecret ? [downloadTokenSecret] : []),
  ];
  if (new Set(secrets).size !== secrets.length) {
    fail("PRODUCTION_SECRETS_NOT_UNIQUE");
  }

  const viteValues = Object.entries(env)
    .filter(([name]) => name.startsWith("VITE_"))
    .map(([, value]) => value)
    .filter(Boolean);
  if (viteValues.some((value) => secrets.includes(value))) {
    fail("PRODUCTION_SECRET_EXPOSED_TO_VITE");
  }

  return {
    buildSourceSha: configuredBuildSourceSha,
    imageDigest,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    validateProductionRuntimeEnvironment();
    console.log("RUNTIME_ENV_OK");
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "RUNTIME_ENV_CHECK_FAILED",
    );
    process.exitCode = 1;
  }
}
