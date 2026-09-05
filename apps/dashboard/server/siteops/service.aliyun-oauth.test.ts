import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindAliyunCustomerAccountFromOAuth: vi.fn(),
  getServicePortal: vi.fn(),
}));

vi.mock("../service-entitlement", () => ({
  getServicePortal: mocks.getServicePortal,
}));
vi.mock("./aliyun-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aliyun-provider")>();
  return {
    ...actual,
    bindAliyunCustomerAccountFromOAuth:
      mocks.bindAliyunCustomerAccountFromOAuth,
  };
});

import { AliyunProviderError } from "./aliyun-provider";
import { completeSiteOpsAliyunOAuth } from "./service";

const projectId = "11111111-1111-4111-8111-111111111111";
const credentialId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: 42,
  role: "user",
  username: "customer-42",
} as const;

describe("SiteOps Aliyun OAuth completion", () => {
  const originalEnabled = process.env.FRONTMIND_SITEOPS_ENABLED;

  beforeEach(() => {
    delete process.env.FRONTMIND_SITEOPS_ENABLED;
    mocks.bindAliyunCustomerAccountFromOAuth.mockReset().mockResolvedValue({
      connectionId: "33333333-3333-4333-8333-333333333333",
      accountUid: "1234567890123456",
      status: "active",
      capabilities: ["alidns_read", "alidns_write"],
    });
    mocks.getServicePortal.mockReset().mockResolvedValue({
      service: { status: "unconfigured" },
      entitlementRollout: { mode: "compatibility" },
    });
  });

  afterEach(() => {
    if (originalEnabled == null) {
      delete process.env.FRONTMIND_SITEOPS_ENABLED;
    } else {
      process.env.FRONTMIND_SITEOPS_ENABLED = originalEnabled;
    }
  });

  it("passes the probed refresh grant to one atomic provider bind", async () => {
    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId,
        projectId,
        accountUid: "1234567890123456",
        refreshToken: "refresh-token-to-seal",
      }),
    ).resolves.toEqual({ connected: true });

    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledWith({
      projectId,
      userId: 42,
      credentialId,
      accountUid: "1234567890123456",
      refreshToken: "refresh-token-to-seal",
    });
  });

  it("translates a provider bind conflict without returning provider details", async () => {
    mocks.bindAliyunCustomerAccountFromOAuth.mockRejectedValueOnce(
      new AliyunProviderError(
        "CONNECTION_IN_USE",
        "provider-message-must-not-escape",
      ),
    );
    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId,
        projectId,
        accountUid: "1234567890123456",
        refreshToken: "refresh-token-to-seal",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", statusCode: 409 });
  });

  it("rejects malformed callback coordinates before binding", async () => {
    await expect(
      completeSiteOpsAliyunOAuth({
        actor: actor as never,
        credentialId: "not-a-credential-id",
        projectId,
        accountUid: "1234567890123456",
        refreshToken: "refresh-token-to-seal",
      }),
    ).rejects.toBeDefined();
    expect(mocks.bindAliyunCustomerAccountFromOAuth).not.toHaveBeenCalled();
  });
});
