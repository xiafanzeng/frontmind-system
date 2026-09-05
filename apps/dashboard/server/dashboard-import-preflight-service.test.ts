import { describe, expect, it } from "vitest";

import {
  consumeDashboardImportPreflight,
  dashboardImportPreflightSecret,
  DashboardImportPreflightError,
  issueDashboardImportPreflight,
  type DashboardImportPreflightBinding,
  type DashboardImportPreflightRecord,
  type DashboardImportPreflightStore,
} from "./dashboard-import-preflight-service";

const SECRET = "test-dashboard-import-preflight-secret-at-least-32-chars";
const NOW = new Date("2026-07-28T00:00:00.000Z");

function binding(
  patch: Partial<DashboardImportPreflightBinding> = {},
): DashboardImportPreflightBinding {
  return {
    actorId: 7,
    workspaceUserId: 42,
    module: "section-table",
    revision: 9,
    fileHash: "a".repeat(64),
    sectionId: "overview",
    ...patch,
  };
}

function memoryStore() {
  const rows = new Map<string, DashboardImportPreflightRecord>();
  const store: DashboardImportPreflightStore = {
    async issue(record) {
      if (rows.has(record.nonce)) throw new Error("duplicate nonce");
      rows.set(record.nonce, { ...record });
    },
    async consume(expected, now) {
      const current = rows.get(expected.nonce);
      if (
        !current ||
        current.consumedAt ||
        current.expiresAt.getTime() <= now.getTime()
      ) {
        return null;
      }
      if (
        JSON.stringify({
          ...current,
          expiresAt: current.expiresAt.toISOString(),
          consumedAt: null,
        }) !==
        JSON.stringify({
          ...expected,
          expiresAt: expected.expiresAt.toISOString(),
          consumedAt: null,
        })
      ) {
        return null;
      }
      const consumed = { ...current, consumedAt: now };
      rows.set(expected.nonce, consumed);
      return consumed;
    },
  };
  return { rows, store };
}

async function issued(input?: {
  value?: DashboardImportPreflightBinding;
  store?: DashboardImportPreflightStore;
}) {
  return issueDashboardImportPreflight({
    binding: input?.value ?? binding(),
    now: NOW,
    ttlSeconds: 60,
    secret: SECRET,
    store: input?.store,
  });
}

describe("dashboard import preflight credentials", () => {
  it("binds a signed token and atomically consumes it only once", async () => {
    const memory = memoryStore();
    const credential = await issued({ store: memory.store });

    await expect(
      consumeDashboardImportPreflight({
        token: credential.preflightToken,
        binding: binding(),
        now: new Date(NOW.getTime() + 1_000),
        secret: SECRET,
        store: memory.store,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        actorId: 7,
        workspaceUserId: 42,
        module: "section-table",
        revision: 9,
        fileHash: "a".repeat(64),
        sectionId: "overview",
        consumedAt: new Date(NOW.getTime() + 1_000),
      }),
    );

    await expect(
      consumeDashboardImportPreflight({
        token: credential.preflightToken,
        binding: binding(),
        now: new Date(NOW.getTime() + 2_000),
        secret: SECRET,
        store: memory.store,
      }),
    ).rejects.toMatchObject({
      code: "DASHBOARD_IMPORT_PREFLIGHT_REPLAYED",
    });
  });

  it("supports the isolated website-content scope without accepting it as a dashboard module", async () => {
    const memory = memoryStore();
    const websiteBinding = binding({
      module: "website-content",
      revision: 0,
      sectionId: undefined,
    });
    const credential = await issued({
      value: websiteBinding,
      store: memory.store,
    });

    await expect(
      consumeDashboardImportPreflight({
        token: credential.preflightToken,
        binding: websiteBinding,
        now: new Date(NOW.getTime() + 1_000),
        secret: SECRET,
        store: memory.store,
      }),
    ).resolves.toMatchObject({
      module: "website-content",
      workspaceUserId: 42,
      revision: 0,
    });
  });

  it.each([
    ["actor", { actorId: 8 }],
    ["workspace", { workspaceUserId: 43 }],
    ["module", { module: "metrics" as const }],
    ["revision", { revision: 10 }],
    ["file", { fileHash: "b".repeat(64) }],
    ["section", { sectionId: "another-section" }],
    ["monitoring target", { targetBatchKey: "batch-another" }],
  ])(
    "rejects a token reused across a different %s binding",
    async (_label, patch) => {
      const memory = memoryStore();
      const original = binding({ targetBatchKey: "batch-1" });
      const credential = await issued({
        value: original,
        store: memory.store,
      });

      await expect(
        consumeDashboardImportPreflight({
          token: credential.preflightToken,
          binding: { ...original, ...patch },
          now: new Date(NOW.getTime() + 1_000),
          secret: SECRET,
          store: memory.store,
        }),
      ).rejects.toMatchObject({
        code: "DASHBOARD_IMPORT_PREFLIGHT_BINDING_MISMATCH",
      });
      expect([...memory.rows.values()][0]?.consumedAt).toBeNull();
    },
  );

  it("rejects a forged payload even when its attacker-supplied hash matches the request", async () => {
    const memory = memoryStore();
    const credential = await issued({ store: memory.store });
    const [encodedPayload, signature] = credential.preflightToken.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8"),
    );
    payload.fileHash = "b".repeat(64);
    const forged = `${Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    )}.${signature}`;

    await expect(
      consumeDashboardImportPreflight({
        token: forged,
        binding: binding({ fileHash: "b".repeat(64) }),
        now: new Date(NOW.getTime() + 1_000),
        secret: SECRET,
        store: memory.store,
      }),
    ).rejects.toMatchObject({
      code: "DASHBOARD_IMPORT_PREFLIGHT_INVALID",
    });
    expect([...memory.rows.values()][0]?.consumedAt).toBeNull();
  });

  it("rejects an expired token before consuming its nonce", async () => {
    const memory = memoryStore();
    const credential = await issued({ store: memory.store });

    await expect(
      consumeDashboardImportPreflight({
        token: credential.preflightToken,
        binding: binding(),
        now: new Date(NOW.getTime() + 61_000),
        secret: SECRET,
        store: memory.store,
      }),
    ).rejects.toMatchObject({
      code: "DASHBOARD_IMPORT_PREFLIGHT_EXPIRED",
    });
    expect([...memory.rows.values()][0]?.consumedAt).toBeNull();
  });

  it("fails fast without a production secret and uses an explicit test-only secret", () => {
    expect(() =>
      dashboardImportPreflightSecret({
        NODE_ENV: "production",
      }),
    ).toThrow("FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET");
    expect(
      dashboardImportPreflightSecret({
        NODE_ENV: "test",
      }),
    ).toHaveLength(64);
    expect(() =>
      dashboardImportPreflightSecret({
        NODE_ENV: "production",
        FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET: SECRET,
      }),
    ).not.toThrow();
  });

  it("classifies a missing token as a required-preflight conflict", async () => {
    const memory = memoryStore();
    await expect(
      consumeDashboardImportPreflight({
        token: undefined,
        binding: binding(),
        now: NOW,
        secret: SECRET,
        store: memory.store,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DashboardImportPreflightError>>({
        code: "DASHBOARD_IMPORT_PREFLIGHT_REQUIRED",
        statusCode: 409,
      }),
    );
  });
});
