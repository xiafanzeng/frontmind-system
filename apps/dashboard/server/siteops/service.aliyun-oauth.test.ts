import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindAliyunCustomerAccountFromOAuth: vi.fn(),
  getServicePortal: vi.fn(),
  getDb: vi.fn(),
  resolveEnterpriseProjectScope: vi.fn(),
  assertEnterpriseAccountAccess: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("../enterprise-project-service", () => ({
  resolveEnterpriseProjectScope: mocks.resolveEnterpriseProjectScope,
  assertEnterpriseAccountAccess: mocks.assertEnterpriseAccountAccess,
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
import { getEnterpriseProjectScope, runWithEnterpriseProjectScope } from "../enterprise-project-context";

const projectId = "11111111-1111-4111-8111-111111111111";
const enterpriseProjectId = "44444444-4444-4444-8444-444444444444";
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
    mocks.getDb.mockReset().mockResolvedValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ userId: 42, enterpriseProjectId }] }) }) }) });
    mocks.resolveEnterpriseProjectScope.mockReset().mockImplementation(async (currentActor, id) => ({ enterpriseProjectId: id, ownerUserId: 42, actorUserId: currentActor.id, isLegacyDefault: false }));
    mocks.assertEnterpriseAccountAccess.mockReset().mockResolvedValue(undefined);
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
        userId: 42,
        accountUid: "1234567890123456",
        refreshToken: "refresh-token-to-seal",
      }),
    ).resolves.toEqual({ connected: true });

    expect(mocks.getServicePortal).not.toHaveBeenCalled();
    expect(mocks.resolveEnterpriseProjectScope).toHaveBeenCalledWith(actor, enterpriseProjectId);
    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.bindAliyunCustomerAccountFromOAuth).toHaveBeenCalledWith({
      projectId,
      userId: 42,
      credentialId,
      accountUid: "1234567890123456",
      refreshToken: "refresh-token-to-seal",
    });
  });

  it("binds for the signed administrator and owner without a current browser project or a package check", async () => {
    const administrator = { ...actor, id: 99, role: "admin" as const, adminAccessLevel: "system_admin" as const };
    mocks.getServicePortal.mockRejectedValue(new Error("historical package must never gate OAuth completion"));
    mocks.bindAliyunCustomerAccountFromOAuth.mockImplementation(async input => {
      expect(input.userId).toBe(42);
      expect(getEnterpriseProjectScope()).toEqual({ enterpriseProjectId, ownerUserId: 42, actorUserId: 99, isLegacyDefault: false });
    });
    expect(getEnterpriseProjectScope()).toBeUndefined();
    await expect(completeSiteOpsAliyunOAuth({ actor: administrator as never, credentialId, projectId, userId: 42, actorUserId: 99, enterpriseProjectId, accountUid: "1234567890123456", refreshToken: "refresh-token-to-seal" })).resolves.toEqual({ connected: true });
    expect(mocks.getServicePortal).not.toHaveBeenCalled();
    expect(mocks.resolveEnterpriseProjectScope).toHaveBeenCalledWith(administrator, enterpriseProjectId);
    expect(getEnterpriseProjectScope()).toBeUndefined();
  });

  it("restores the frozen project even if the browser has switched to another project", async () => {
    const other = { enterpriseProjectId: "55555555-5555-4555-8555-555555555555", ownerUserId: 42, actorUserId: 42, isLegacyDefault: false };
    mocks.bindAliyunCustomerAccountFromOAuth.mockImplementation(async () => { expect(getEnterpriseProjectScope()?.enterpriseProjectId).toBe(enterpriseProjectId); });
    await runWithEnterpriseProjectScope(other, async () => {
      await completeSiteOpsAliyunOAuth({ actor: actor as never, credentialId, projectId, userId: 42, actorUserId: 42, enterpriseProjectId, accountUid: "1234567890123456", refreshToken: "refresh-token-to-seal" });
      expect(getEnterpriseProjectScope()).toEqual(other);
    });
  });

  it("rejects a state whose frozen enterprise project no longer matches the site project", async () => {
    await expect(completeSiteOpsAliyunOAuth({ actor: actor as never, credentialId, projectId, userId: 42, actorUserId: 42, enterpriseProjectId: "55555555-5555-4555-8555-555555555555", accountUid: "1234567890123456", refreshToken: "refresh-token-to-seal" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.bindAliyunCustomerAccountFromOAuth).not.toHaveBeenCalled();
  });

  it("revalidates current project access before binding and rejects a different operator", async () => {
    mocks.resolveEnterpriseProjectScope.mockRejectedValue(new Error("project access revoked"));
    await expect(completeSiteOpsAliyunOAuth({ actor: actor as never, credentialId, projectId, userId: 42, actorUserId: 42, enterpriseProjectId, accountUid: "1234567890123456", refreshToken: "refresh-token-to-seal" })).rejects.toThrow("project access revoked");
    await expect(completeSiteOpsAliyunOAuth({ actor: actor as never, credentialId, projectId, userId: 42, actorUserId: 99, enterpriseProjectId, accountUid: "1234567890123456", refreshToken: "refresh-token-to-seal" })).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(mocks.bindAliyunCustomerAccountFromOAuth).not.toHaveBeenCalled();
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
        userId: 42,
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
        userId: 42,
        accountUid: "1234567890123456",
        refreshToken: "refresh-token-to-seal",
      }),
    ).rejects.toBeDefined();
    expect(mocks.bindAliyunCustomerAccountFromOAuth).not.toHaveBeenCalled();
  });
});
