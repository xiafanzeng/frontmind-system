import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  credentialProfileProjection,
  credentialsUseSameUpstreamApiKey,
  decryptApiKey,
  replaceApiCredentialInTransaction,
  validateManagedUpstreamApiKey,
} from "./auth-service";
import {
  generalAgentModelProfileEffort,
  generalAgentModelProfileModel,
  managedAgentProfileEffort,
  managedAgentProfileModel,
} from "../shared/manus-agent-profile";

vi.mock("./managed-upload-intent-fence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-upload-intent-fence")>()),
  assertManagedUploadScopesAvailable: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("versioned managed provider credentials", () => {
  it("preserves old model semantics while explicitly mapping all Zhipu tiers", () => {
    expect(managedAgentProfileModel("frontmind-base")).toBe("manus-1.6");
    expect(managedAgentProfileModel("frontmind-pro")).toBe("manus-1.6-max");
    expect(generalAgentModelProfileModel("frontmind-lite")).toBe(
      "manus-1.6-lite",
    );
    expect(
      ["frontmind-lite", "frontmind-base", "frontmind-pro"].map((profile) =>
        generalAgentModelProfileModel(profile as any, "zhipu"),
      ),
    ).toEqual(["glm-5.3", "glm-5.3", "glm-5.3"]);
    expect(
      ["frontmind-lite", "frontmind-base", "frontmind-pro"].map((profile) =>
        generalAgentModelProfileEffort(profile as any),
      ),
    ).toEqual(["low", "high", "max"]);
    expect(managedAgentProfileEffort("frontmind-base")).toBe("high");
  });

  it("uses frozen runtime values and never reinterprets historical Manus versions", () => {
    expect(
      credentialProfileProjection({
        agentProfile: "frontmind-base",
        upstreamModel: null,
        upstreamEffort: null,
      }),
    ).toEqual({
      agentProfile: "frontmind-base",
      provider: "manus",
      upstreamModel: "manus-1.6",
      upstreamEffort: null,
    });
    expect(
      credentialProfileProjection({
        provider: "zhipu",
        agentProfile: "frontmind-pro",
        upstreamModel: "glm-5.3",
        upstreamEffort: "high",
      }),
    ).toMatchObject({ upstreamModel: "glm-5.3", upstreamEffort: "high" });
    expect(() => credentialProfileProjection({ provider: "unknown" })).toThrow(
      /类型无效/,
    );
    expect(() =>
      credentialProfileProjection({
        provider: "zhipu",
        upstreamEffort: "medium",
      }),
    ).toThrow(/档位无效/);
    const key = {
      apiKey: "fixture-identical-key",
      fingerprint: "fp_identical",
    };
    expect(
      credentialsUseSameUpstreamApiKey(
        { ...key, provider: "manus" },
        { ...key, provider: "zhipu" },
      ),
    ).toBe(false);
  });

  it("rejects a retired provider before making any credential request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      validateManagedUpstreamApiKey("fixture-not-a-real-key", "manus"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes the Zhipu read endpoint without creating tasks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await validateManagedUpstreamApiKey("fixture-not-a-real-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://agent-api.bigmodel.cn/api/agent/managed/v1/agents?limit=1",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("rejects invalid authentication and malformed probes without exposing the key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ unexpected: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      validateManagedUpstreamApiKey("fixture-not-a-real-key"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    await expect(
      validateManagedUpstreamApiKey("fixture-not-a-real-key"),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { profile: undefined, effort: "max", selectedEffort: undefined },
    { profile: null, effort: "high", selectedEffort: "high" as const },
    { profile: null, effort: "max", selectedEffort: "max" as const },
    {
      profile: "frontmind-base" as const,
      effort: "high",
      selectedEffort: undefined,
    },
  ])(
    "freezes a distinct Zhipu version with profile $profile and effort $effort",
    async ({ profile, effort, selectedEffort }) => {
      vi.stubEnv(
        "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
        randomBytes(32).toString("base64"),
      );
      const prior = Object.freeze({
        id: "old-manus",
        userId: 77,
        version: 4,
        provider: "manus",
        agentProfile: "frontmind-pro",
        encryptedKey: "unchanged-history",
      });
      let selectIndex = 0;
      const retired = vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      const inserted = vi.fn().mockResolvedValue(undefined);
      const executor = {
        select: () => {
          const rows = selectIndex++ === 0 ? [{ id: 77 }] : [prior];
          const limit = Object.assign(Promise.resolve(rows), {
            for: () => Promise.resolve(rows),
          });
          const query: any = {
            from: () => query,
            where: () => query,
            orderBy: () => query,
            limit: () => limit,
          };
          return query;
        },
        update: () => ({ set: retired }),
        insert: () => ({ values: inserted }),
      };
      const result = await replaceApiCredentialInTransaction({
        executor,
        userId: 77,
        apiKey: "fixture-new-key",
        credentialId: "new-zhipu",
        ...(profile !== undefined ? { agentProfile: profile } : {}),
        upstreamEffort: selectedEffort,
      });
      expect(retired.mock.calls[0]![0]).toMatchObject({ status: "retired" });
      expect(Object.keys(retired.mock.calls[0]![0]).sort()).toEqual([
        "retiredAt",
        "status",
        "updatedAt",
      ]);
      const row = inserted.mock.calls[0]![0];
      expect(row).toMatchObject({
        id: "new-zhipu",
        version: 5,
        provider: "zhipu",
        upstreamModel: "glm-5.3",
        upstreamEffort: effort,
        validationStatus: "verified",
      });
      expect(row.encryptedKey).not.toContain("fixture-new-key");
      expect(decryptApiKey(row)).toBe("fixture-new-key");
      expect(result).toMatchObject({
        provider: "zhipu",
        version: 5,
        upstreamModel: "glm-5.3",
        upstreamEffort: effort,
      });
      expect(prior.encryptedKey).toBe("unchanged-history");
    },
  );
});
