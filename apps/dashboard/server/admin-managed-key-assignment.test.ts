import { beforeEach, describe, expect, it, vi } from "vitest";

const mutations = vi.hoisted(() => ({
  replaceManagedApiKeyTarget: vi.fn(),
  bulkReplaceManagedApiKeyTargets: vi.fn(),
}));
vi.mock("./api-usage-snapshot-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api-usage-snapshot-service")>()),
  ...mutations,
}));
import { adminRouter } from "./admin-router";

const input = {
  kind: "customer" as const,
  userId: 77,
  apiKey: "fixture-zhipu-key",
  expectedVersion: 8,
  reason: "rotate the assigned Key",
  confirmation: "REPLACE_API_KEY" as const,
};
const bulkInput = {
  scope: { kind: "all" as const },
  targets: [{ userId: 77, expectedVersion: 8 }],
  apiKey: "fixture-zhipu-key",
  reason: "rotate assigned Keys",
  confirmation: "BULK_REPLACE_API_KEYS" as const,
};
function caller(access = "system_admin") {
  return adminRouter.createCaller({
    user: {
      id: 900,
      role: "admin",
      adminAccessLevel: access,
      username: "admin",
    },
    req: {},
    res: {},
  } as any).apiKeyUsageAlerts;
}

describe("administrator managed Key input", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assigns an individual Key without a client-selected runtime profile", async () => {
    await caller().replaceTargetCredential(input);
    expect(mutations.replaceManagedApiKeyTarget).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: 900 }),
      kind: "customer",
      userId: 77,
      apiKey: input.apiKey,
      expectedVersion: 8,
      reason: input.reason,
    });
  });

  it("assigns a batch without a client-selected runtime profile", async () => {
    await caller().bulkReplaceTargetCredentials(bulkInput);
    expect(mutations.bulkReplaceManagedApiKeyTargets).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: 900 }),
      scope: bulkInput.scope,
      targets: bulkInput.targets,
      applyMode: "unconfigured_only",
      apiKey: bulkInput.apiKey,
      reason: bulkInput.reason,
    });
  });

  it.each(["frontmind-base", "frontmind-pro"])(
    "rejects the retired %s selector on both APIs",
    async (agentProfile) => {
      await expect(
        caller().replaceTargetCredential({ ...input, agentProfile } as any),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        caller().bulkReplaceTargetCredentials({
          ...bulkInput,
          agentProfile,
        } as any),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mutations.replaceManagedApiKeyTarget).not.toHaveBeenCalled();
      expect(mutations.bulkReplaceManagedApiKeyTargets).not.toHaveBeenCalled();
    },
  );

  it("retains the system administrator boundary", async () => {
    await expect(
      caller("delivery_admin").replaceTargetCredential(input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller("delivery_admin").bulkReplaceTargetCredentials(bulkInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mutations.replaceManagedApiKeyTarget).not.toHaveBeenCalled();
    expect(mutations.bulkReplaceManagedApiKeyTargets).not.toHaveBeenCalled();
  });
});
