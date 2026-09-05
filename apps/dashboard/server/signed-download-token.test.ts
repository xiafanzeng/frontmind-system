import { afterEach, describe, expect, it } from "vitest";

import {
  bindDownloadUrlToProject,
  createSignedDownloadToken,
  deriveDownloadTokenSecretFromCredentialMasterKey,
  resolveDownloadProjectContext,
  resolveDownloadTokenSecret,
  verifySignedDownloadToken,
} from "./signed-download-token";

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  dedicatedSecret: process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET,
  jwtSecret: process.env.JWT_SECRET,
  credentialMasterKey: process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY,
};

afterEach(() => {
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
  if (originalEnvironment.dedicatedSecret === undefined) {
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
  } else {
    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET =
      originalEnvironment.dedicatedSecret;
  }
  if (originalEnvironment.jwtSecret === undefined)
    delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalEnvironment.jwtSecret;
  if (originalEnvironment.credentialMasterKey === undefined) {
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      originalEnvironment.credentialMasterKey;
  }
});

describe("signed cross-instance download tokens", () => {
  it("verifies on another instance and preserves the exact project binding", () => {
    const secret = "shared-download-secret-that-is-long-enough-123456";
    const token = createSignedDownloadToken(
      {
        kind: "owned_file",
        userId: 42,
        fileId: "folder/中文 # file.pdf",
        credentialId: "credential-v3",
        projectAssignmentId: "project-assignment-a",
        exp: 20_000,
      },
      { secret },
    );

    expect(
      verifySignedDownloadToken(token, "owned_file", {
        // A separate process uses only the shared secret and token bytes.
        secret,
        now: 10_000,
      }),
    ).toMatchObject({
      userId: 42,
      fileId: "folder/中文 # file.pdf",
      credentialId: "credential-v3",
      projectAssignmentId: "project-assignment-a",
    });
  });

  it("requires all current-project signals to match and binds native URLs", () => {
    const bound = bindDownloadUrlToProject(
      "/api/frontmind/download/signed-token",
      "project 中文/#a",
    );
    expect(bound).toBe(
      "/api/frontmind/download/signed-token?projectAssignmentId=project%20%E4%B8%AD%E6%96%87%2F%23a",
    );
    expect(
      resolveDownloadProjectContext({
        query: "project-a",
        header: "project-a",
      }),
    ).toBe("project-a");
    expect(() =>
      resolveDownloadProjectContext({
        middleware: "project-a",
        query: "project-b",
      }),
    ).toThrowError(expect.objectContaining({ code: "DOWNLOAD_TOKEN_INVALID" }));
    expect(() =>
      resolveDownloadProjectContext({ query: ["project-a", "project-b"] }),
    ).toThrowError(expect.objectContaining({ code: "DOWNLOAD_TOKEN_INVALID" }));
  });

  it("fails closed at production startup without a strong shared secret", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = "base64:not-valid";
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      7,
    ).toString("base64")}`;
    process.env.JWT_SECRET = "too-short";
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );
    delete process.env.JWT_SECRET;

    expect(() => resolveDownloadTokenSecret("too-short")).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );

    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET = "too-short";
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );
  });

  it("derives one stable cross-instance sub-key from the credential master", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    const firstMaster = `base64:${Buffer.alloc(32, 11).toString("base64")}`;
    const secondMaster = `base64:${Buffer.alloc(32, 12).toString("base64")}`;
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = firstMaster;

    const derived = resolveDownloadTokenSecret();
    expect(derived).toBe(
      deriveDownloadTokenSecretFromCredentialMasterKey(firstMaster),
    );
    expect(derived).toHaveLength(43);
    expect(
      deriveDownloadTokenSecretFromCredentialMasterKey(secondMaster),
    ).not.toBe(derived);

    const token = createSignedDownloadToken({
      kind: "owned_file",
      userId: 42,
      fileId: "derived-secret.pdf",
      credentialId: "credential-v3",
      projectAssignmentId: null,
      exp: 20_000,
    });
    expect(
      verifySignedDownloadToken(token, "owned_file", { now: 10_000 }),
    ).toMatchObject({ fileId: "derived-secret.pdf" });

    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = secondMaster;
    expect(() =>
      verifySignedDownloadToken(token, "owned_file", { now: 10_000 }),
    ).toThrowError(expect.objectContaining({ code: "DOWNLOAD_TOKEN_INVALID" }));
  });

  it("keeps explicit and JWT signing secrets ahead of the derived fallback", () => {
    process.env.NODE_ENV = "production";
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(
      32,
      21,
    ).toString("base64")}`;
    process.env.JWT_SECRET = "jwt-download-token-secret-that-is-long-enough";
    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET =
      "dedicated-download-token-secret-that-is-long-enough";

    expect(resolveDownloadTokenSecret()).toBe(
      process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET,
    );
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
    expect(resolveDownloadTokenSecret()).toBe(process.env.JWT_SECRET);
    delete process.env.JWT_SECRET;
    expect(resolveDownloadTokenSecret()).toBe(
      deriveDownloadTokenSecretFromCredentialMasterKey(
        process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY,
      ),
    );
  });
});
