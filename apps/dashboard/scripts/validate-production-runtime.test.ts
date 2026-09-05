import { describe, expect, it } from "vitest";

import { deriveDownloadTokenSecretFromCredentialMasterKey as deriveRuntimeDownloadTokenSecret } from "../server/signed-download-token";
import {
  deriveDownloadTokenSecretFromCredentialMasterKey,
  validateProductionRuntimeEnvironment,
} from "./validate-production-runtime.mjs";

function productionEnvironment() {
  return {
    NODE_ENV: "production",
    PORT: "3001",
    DATABASE_URL:
      "mysql://frontmind_dashboard:strong-password@mysql:3306/frontmind_dashboard",
    FRONTMIND_BUILD_SHA: "a".repeat(40),
    FRONTMIND_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
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
    FRONTMIND_KB_V4_ROLLOUT_PERCENT: "100",
    FRONTMIND_KB_V4_ALLOW_USER_IDS: "",
    FRONTMIND_CREDENTIAL_ENCRYPTION_KEY: `base64:${Buffer.alloc(32, 1).toString("base64")}`,
    FRONTMIND_PRESALES_SERVICE_TOKEN: "p".repeat(32),
    FRONTMIND_PROVISIONING_SERVICE_TOKEN: "q".repeat(32),
    FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET: "r".repeat(32),
    FRONTMIND_MONITOR_API_KEY: "s".repeat(32),
    FRONTMIND_DOWNLOAD_TOKEN_SECRET: "t".repeat(32),
  };
}

describe("production runtime preflight", () => {
  it("accepts source and immutable image identities", () => {
    const env = productionEnvironment();
    expect(validateProductionRuntimeEnvironment(env)).toEqual({
      buildSourceSha: "a".repeat(40),
      imageDigest: `sha256:${"b".repeat(64)}`,
    });
  });

  it("fails closed for a mutable or malformed image identity", () => {
    const env = productionEnvironment();
    env.FRONTMIND_IMAGE_DIGEST = "latest";
    expect(() => validateProductionRuntimeEnvironment(env)).toThrow(
      "FRONTMIND_IMAGE_DIGEST_VALUE_INVALID",
    );

    const { FRONTMIND_IMAGE_DIGEST: _missingDigest, ...missingDigest } =
      productionEnvironment();
    expect(() => validateProductionRuntimeEnvironment(missingDigest)).toThrow(
      "FRONTMIND_IMAGE_DIGEST_VALUE_INVALID",
    );

    const { FRONTMIND_BUILD_SHA: _missingSource, ...missingSource } =
      productionEnvironment();
    expect(() => validateProductionRuntimeEnvironment(missingSource)).toThrow(
      "FRONTMIND_BUILD_SHA_VALUE_INVALID",
    );
  });

  it("resolves strong download-token signing material before rollout", () => {
    const {
      FRONTMIND_DOWNLOAD_TOKEN_SECRET: _missingDownloadSecret,
      ...missingDownloadSecret
    } = productionEnvironment();
    expect(
      validateProductionRuntimeEnvironment(missingDownloadSecret),
    ).toMatchObject({ buildSourceSha: "a".repeat(40) });

    const encodedMasterKey =
      missingDownloadSecret.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    const decodedMasterKey = Buffer.from(
      encodedMasterKey.slice("base64:".length),
      "base64",
    );
    expect(
      deriveDownloadTokenSecretFromCredentialMasterKey(decodedMasterKey),
    ).toBe(deriveRuntimeDownloadTokenSecret(encodedMasterKey));
    expect(
      deriveDownloadTokenSecretFromCredentialMasterKey(decodedMasterKey),
    ).toBe("nLfOXdehQatNHP_VNGaWs5rj--pTmMZDMCcbXxNOPaQ");

    expect(
      validateProductionRuntimeEnvironment({
        ...missingDownloadSecret,
        JWT_SECRET: "j".repeat(32),
      }),
    ).toMatchObject({ buildSourceSha: "a".repeat(40) });

    expect(() =>
      validateProductionRuntimeEnvironment({
        ...productionEnvironment(),
        FRONTMIND_DOWNLOAD_TOKEN_SECRET: "short",
        JWT_SECRET: "j".repeat(32),
      }),
    ).toThrow("FRONTMIND_DOWNLOAD_TOKEN_SECRET_VALUE_INVALID");

    expect(() =>
      validateProductionRuntimeEnvironment({
        ...missingDownloadSecret,
        JWT_SECRET: "short",
      }),
    ).toThrow("FRONTMIND_DOWNLOAD_TOKEN_SECRET_VALUE_INVALID");
  });
});
