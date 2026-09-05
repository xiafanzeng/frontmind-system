import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => ({ getDb: dependencies.getDb }));

import { AuthServiceError } from "../auth-service";
import {
  ALIYUN_OAUTH_AUTHORIZE_ENDPOINT,
  ALIYUN_OAUTH_CREDENTIAL_SLOT,
  ALIYUN_OAUTH_REQUIRED_SCOPES,
  ALIYUN_OAUTH_REVOKE_ENDPOINT,
  ALIYUN_OAUTH_TOKEN_ENDPOINT,
  ALIYUN_OAUTH_USERINFO_ENDPOINT,
  assertAliyunOAuthScopes,
  buildAliyunOAuthAuthorizationUrl,
  buildAliyunOAuthState,
  deleteAliyunPlatformCredentials,
  decryptAliyunPlatformCredential,
  encryptAliyunPlatformCredential,
  exchangeAliyunOAuthCode,
  refreshAliyunOAuthAccessToken,
  revokeAliyunOAuthToken,
} from "./aliyun-platform-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
const originalPublicUrl = process.env.FRONTMIND_PUBLIC_URL;

const oauthCredential = {
  clientId: "4724570903440411234",
  clientSecret: "frontmind-oauth-client-secret",
  callbackUrl:
    "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
};

function jsonResponse(value: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storedCredential(id = randomUUID()) {
  return {
    id,
    slot: ALIYUN_OAUTH_CREDENTIAL_SLOT,
    version: 3,
    status: "active",
    validationStatus: "verified",
    fingerprint: "sha256:test",
    ...encryptAliyunPlatformCredential(
      ALIYUN_OAUTH_CREDENTIAL_SLOT,
      id,
      oauthCredential,
    ),
  };
}

function credentialDb(
  row: ReturnType<typeof storedCredential>,
  activeRow = row,
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [row]),
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => [activeRow]),
          })),
        })),
      })),
    })),
  };
}

describe("Aliyun OAuth-only platform service", () => {
  beforeEach(() => {
    dependencies.getDb.mockReset();
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
    process.env.FRONTMIND_PUBLIC_URL = "https://dashboard.frontmind.net";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
    if (originalPublicUrl === undefined) {
      delete process.env.FRONTMIND_PUBLIC_URL;
    } else {
      process.env.FRONTMIND_PUBLIC_URL = originalPublicUrl;
    }
  });

  it("requests only identity + AliDNS scopes with offline consent", () => {
    const url = buildAliyunOAuthAuthorizationUrl(
      oauthCredential,
      "signed-state",
    );
    expect(url.origin + url.pathname).toBe(ALIYUN_OAUTH_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("scope")).toBe(
      ALIYUN_OAUTH_REQUIRED_SCOPES.join(" "),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("admin_consent");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.toString()).not.toContain(oauthCredential.clientSecret);
  });

  it("requires the complete granted scope set", () => {
    expect(assertAliyunOAuthScopes("openid aliuid /acs/alidns")).toEqual([
      "openid",
      "aliuid",
      "/acs/alidns",
    ]);
    expect(() => assertAliyunOAuthScopes("openid aliuid")).toThrowError(
      AuthServiceError,
    );
  });

  it("round-trips the OAuth application credential under its AAD", () => {
    const id = randomUUID();
    const encrypted = encryptAliyunPlatformCredential(
      ALIYUN_OAUTH_CREDENTIAL_SLOT,
      id,
      oauthCredential,
    );
    expect(JSON.stringify(encrypted)).not.toContain(
      oauthCredential.clientSecret,
    );
    expect(
      decryptAliyunPlatformCredential(ALIYUN_OAUTH_CREDENTIAL_SLOT, {
        id,
        ...encrypted,
      }),
    ).toEqual(oauthCredential);
  });

  it("exchanges, validates, probes AliDNS, and returns only the refresh grant", async () => {
    const row = storedCredential();
    dependencies.getDb.mockResolvedValue(credentialDb(row));
    const projectId = randomUUID();
    const state = buildAliyunOAuthState({
      credentialId: row.id,
      projectId,
      userId: 42,
      clientSecret: oauthCredential.clientSecret,
      expiresAt: Date.now() + 60_000,
      nonce: "abcdefghijklmnop",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token-memory-only",
          refresh_token: "refresh-token-to-seal",
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "openid aliuid /acs/alidns",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ aid: "1234567890123456" }));
    const probeAccessToken = vi.fn(async () => ({ ok: true }));

    const result = await exchangeAliyunOAuthCode({
      code: "authorization-code",
      state,
      userId: 42,
      fetchImpl,
      probeAccessToken,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(ALIYUN_OAUTH_TOKEN_ENDPOINT);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(ALIYUN_OAUTH_USERINFO_ENDPOINT);
    expect(probeAccessToken).toHaveBeenCalledWith("access-token-memory-only");
    expect(result).toEqual({
      credentialId: row.id,
      projectId,
      userId: 42,
      accountUid: "1234567890123456",
      refreshToken: "refresh-token-to-seal",
      scopes: ["openid", "aliuid", "/acs/alidns"],
    });
    expect(JSON.stringify(result)).not.toContain("access-token-memory-only");
  });

  it("rejects token responses missing refresh_token or AliDNS scope", async () => {
    const row = storedCredential();
    dependencies.getDb.mockResolvedValue(credentialDb(row));
    const state = buildAliyunOAuthState({
      credentialId: row.id,
      projectId: randomUUID(),
      userId: 42,
      clientSecret: oauthCredential.clientSecret,
      expiresAt: Date.now() + 60_000,
    });
    for (const token of [
      {
        access_token: "access-token-memory-only",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "openid aliuid /acs/alidns",
      },
      {
        access_token: "access-token-memory-only",
        refresh_token: "refresh-token-to-seal",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "openid aliuid",
      },
    ]) {
      await expect(
        exchangeAliyunOAuthCode({
          code: "authorization-code",
          state,
          userId: 42,
          fetchImpl: vi.fn(async () => jsonResponse(token)),
          probeAccessToken: vi.fn(),
        }),
      ).rejects.toBeDefined();
    }
  });

  it("rejects a signed state after the OAuth application rotates before exchange", async () => {
    const retired = storedCredential();
    const active = storedCredential();
    dependencies.getDb.mockResolvedValue(credentialDb(retired, active));
    const state = buildAliyunOAuthState({
      credentialId: retired.id,
      projectId: randomUUID(),
      userId: 42,
      clientSecret: oauthCredential.clientSecret,
      expiresAt: Date.now() + 60_000,
    });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      exchangeAliyunOAuthCode({
        code: "authorization-code",
        state,
        userId: 42,
        fetchImpl,
        probeAccessToken: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL",
      message: expect.stringContaining("已轮换"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes with the pinned app and classifies invalid_grant", async () => {
    const row = storedCredential();
    dependencies.getDb.mockResolvedValue(credentialDb(row));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "new-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "openid aliuid /acs/alidns",
      }),
    );
    await expect(
      refreshAliyunOAuthAccessToken({
        credentialId: row.id,
        refreshToken: "existing-refresh-token",
        fetchImpl,
      }),
    ).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3_600,
      scopes: ["openid", "aliuid", "/acs/alidns"],
    });
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain(
      "grant_type=refresh_token",
    );

    await expect(
      refreshAliyunOAuthAccessToken({
        credentialId: row.id,
        refreshToken: "existing-refresh-token",
        fetchImpl: vi.fn(async () =>
          jsonResponse({ error: "invalid_grant" }, 400),
        ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("revokes the refresh token at Alibaba Cloud's endpoint", async () => {
    const row = storedCredential();
    dependencies.getDb.mockResolvedValue(credentialDb(row));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      revokeAliyunOAuthToken({
        credentialId: row.id,
        refreshToken: "refresh-token-to-revoke",
        fetchImpl,
      }),
    ).resolves.toEqual({ revoked: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(ALIYUN_OAUTH_REVOKE_ENDPOINT);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain(
      "token_type_hint=refresh_token",
    );
  });

  it("does not destroy an OAuth application credential pinned by a connection", async () => {
    const update = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => [{ id: randomUUID(), status: "active" }]),
            })),
          })),
        })),
      })),
      update,
    };
    dependencies.getDb.mockResolvedValue({
      transaction: vi.fn(async (callback) => callback(tx)),
    });

    await expect(deleteAliyunPlatformCredentials()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("解除阿里云连接"),
    });
    expect(update).not.toHaveBeenCalled();
  });
});
