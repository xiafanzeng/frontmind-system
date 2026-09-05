import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  API_USAGE_SCAN_CONCURRENCY,
  API_USAGE_SNAPSHOT_SYNC_LOCK_NAME,
  apiUsageSnapshotCompletionState,
  apiUsageSeverity,
  assertBulkManagedApiKeyTargetSelection,
  assertBulkManagedApiKeyTargetVersions,
  assertManagedApiKeyTarget,
  bulkManagedApiKeyActionTargets,
  bulkPreviousCredentialGroups,
  claimUsageSnapshotRefresh,
  createManagedApiUsageRefreshQueue,
  isDuplicateApiUsageSnapshotError,
  isRollingUsageSnapshotCurrent,
  latestUsageSnapshotByPolicy,
  resolveEffectiveUsageCredentials,
  resolveBulkManagedApiKeyTargets,
  runApiUsageSnapshotSyncWithLock,
  syncableManagedWorkspaceUserIds,
  usageCredentialPoolKey,
  usageSnapshotUsageValues,
} from "./api-usage-snapshot-service";

describe("managed API usage refresh targeting", () => {
  it("keeps customers owned by a system administrator in the snapshot scan", () => {
    expect(
      syncableManagedWorkspaceUserIds({
        workspaceUserIds: [1, 2, 3, 4],
        ownershipRows: [
          { userId: 1, deliveryAdminId: 10 },
          { userId: 2, deliveryAdminId: 20 },
          { userId: 3, deliveryAdminId: 30 },
        ],
        eligibleOwnerIds: [10, 20],
      }),
    ).toEqual([1, 2, 4]);
  });

  it("deduplicates immediate pool refreshes and retries after the global lock is busy", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        synced: 0,
        failed: 0,
        finishedAt: 1,
        skipped: "already_running" as const,
      })
      .mockResolvedValueOnce({ synced: 2, failed: 0, finishedAt: 2 });
    const queue = createManagedApiUsageRefreshQueue({
      refresh,
      retryDelayMs: 250,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {};
      },
    });
    const actor = { id: 9, role: "admin" } as any;

    queue.enqueue({ actor, fingerprint: "fingerprint-A" });
    queue.enqueue({ actor, fingerprint: "fingerprint-A" });
    queue.enqueue({ actor, fingerprint: "fingerprint-B" });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(0);
    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect([...refresh.mock.calls[0]![1]]).toEqual([
      "fingerprint-A",
      "fingerprint-B",
    ]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(250);

    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect([...refresh.mock.calls[1]![1]]).toEqual([
      "fingerprint-A",
      "fingerprint-B",
    ]);
    expect(scheduled).toHaveLength(0);
  });

  it("retries a targeted refresh after the refresh itself throws", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const error = new Error("temporary upstream failure");
    const onError = vi.fn();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ synced: 1, failed: 0, finishedAt: 2 });
    const queue = createManagedApiUsageRefreshQueue({
      refresh,
      onError,
      retryDelayMs: 125,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {};
      },
    });

    queue.enqueue({
      actor: { id: 9, role: "admin" } as any,
      fingerprint: "fingerprint-throw",
    });
    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(125);

    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect([...refresh.mock.calls[1]![1]]).toEqual(["fingerprint-throw"]);
    expect(scheduled).toHaveLength(0);
  });

  it("retries when a snapshot scan reports a retryable failure", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        synced: 0,
        failed: 1,
        retryableFailed: 1,
        finishedAt: 1,
      })
      .mockResolvedValueOnce({ synced: 1, failed: 0, finishedAt: 2 });
    const queue = createManagedApiUsageRefreshQueue({
      refresh,
      retryDelayMs: 75,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return {};
      },
    });

    queue.enqueue({
      actor: { id: 9, role: "admin" } as any,
      fingerprint: "fingerprint-retryable",
    });
    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(75);

    scheduled.shift()!.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(0);
  });
});

describe("API usage snapshot completion state", () => {
  it("keeps an authoritative total available when only account attribution is partial", () => {
    expect(
      apiUsageSnapshotCompletionState({
        totalComplete: true,
        attributionComplete: false,
        attributionErrorCode: "PARTIAL_ACCOUNT_ATTRIBUTION",
      }),
    ).toEqual({
      status: "ok",
      errorCode: "PARTIAL_ACCOUNT_ATTRIBUTION",
    });
  });

  it("marks only an incomplete authoritative total as a failed scan", () => {
    expect(
      apiUsageSnapshotCompletionState({
        totalComplete: false,
        attributionComplete: true,
        attributionErrorCode: "PARTIAL_ACCOUNT_ATTRIBUTION",
      }),
    ).toEqual({
      status: "error",
      errorCode: "PARTIAL_USAGE_SCAN",
    });
  });
});

describe("API usage snapshot duplicate-key detection", () => {
  it("recognizes direct mysql2 and Drizzle-wrapped duplicate errors", () => {
    expect(
      isDuplicateApiUsageSnapshotError({ code: "ER_DUP_ENTRY", errno: 1062 }),
    ).toBe(true);
    expect(
      isDuplicateApiUsageSnapshotError({
        name: "DrizzleQueryError",
        cause: { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" },
      }),
    ).toBe(true);
  });

  it("does not misclassify unrelated or cyclic errors", () => {
    expect(
      isDuplicateApiUsageSnapshotError({
        cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 },
      }),
    ).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isDuplicateApiUsageSnapshotError(cyclic)).toBe(false);
  });

  it("claims an existing policy through one atomic insert-or-update statement", async () => {
    const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onDuplicateKeyUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const now = new Date("2026-08-03T01:00:00.000Z");

    const syncToken = await claimUsageSnapshotRefresh({
      executor: { insert },
      policy: { id: "policy-existing" },
      now,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: "policy-existing",
        syncGeneration: 1,
        syncToken,
        syncStartedAt: now,
      }),
    );
    expect(onDuplicateKeyUpdate).toHaveBeenCalledWith({
      set: expect.objectContaining({
        syncToken,
        syncStartedAt: now,
        updatedAt: now,
      }),
    });
  });
});

it("serializes overlapping historical credential scans", () => {
  expect(API_USAGE_SCAN_CONCURRENCY).toBe(1);
});

describe("API usage snapshot synchronization lock", () => {
  it("holds one MySQL named lock for the complete synchronization", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], undefined])
      .mockResolvedValueOnce([[{ released: 1 }], undefined]);
    const end = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue({
      synced: 3,
      failed: 0,
      finishedAt: 123,
    });

    await expect(
      runApiUsageSnapshotSyncWithLock({
        databaseUrl: "mysql://acceptance.invalid/frontmind",
        createConnection: async () => ({ query, end }),
        sync,
      }),
    ).resolves.toEqual({ synced: 3, failed: 0, finishedAt: 123 });
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT GET_LOCK(?, 0) AS acquired",
      [API_USAGE_SNAPSHOT_SYNC_LOCK_NAME],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [API_USAGE_SNAPSHOT_SYNC_LOCK_NAME],
    );
    expect(sync).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("skips a second server instance when the database lock is busy", async () => {
    const sync = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const result = await runApiUsageSnapshotSyncWithLock({
      databaseUrl: "mysql://acceptance.invalid/frontmind",
      createConnection: async () => ({
        query: vi.fn().mockResolvedValue([[{ acquired: 0 }], undefined]),
        end,
      }),
      sync,
    });

    expect(result.skipped).toBe("already_running");
    expect(sync).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping timer and manual runs in the same process", async () => {
    let finishFirst!: (value: {
      synced: number;
      failed: number;
      finishedAt: number;
    }) => void;
    const first = runApiUsageSnapshotSyncWithLock({
      databaseUrl: "",
      sync: () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    });
    await Promise.resolve();

    const overlapping = await runApiUsageSnapshotSyncWithLock({
      databaseUrl: "",
      sync: vi.fn(),
    });
    expect(overlapping.skipped).toBe("already_running");

    finishFirst({ synced: 1, failed: 0, finishedAt: 456 });
    await expect(first).resolves.toEqual({
      synced: 1,
      failed: 0,
      finishedAt: 456,
    });
  });
});

describe("apiUsageSeverity", () => {
  it("warns exactly at 184,000 of the default 230,000 limit", () => {
    expect(
      apiUsageSeverity({
        used: 183_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("normal");
    expect(
      apiUsageSeverity({
        used: 184_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
  });

  it("becomes critical exactly at the configured limit", () => {
    expect(
      apiUsageSeverity({
        used: 229_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("warning");
    expect(
      apiUsageSeverity({
        used: 230_000,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "ok",
      }),
    ).toBe("critical");
  });

  it("does not turn a failed or unconfigured sync into a usage alert", () => {
    expect(
      apiUsageSeverity({
        used: 999_999,
        limit: 230_000,
        warningRatio: 0.8,
        syncStatus: "error",
      }),
    ).toBe("unavailable");
  });
});

describe("resolveEffectiveUsageCredentials", () => {
  it("prefers a managed customer's direct Key over the assigned manager's Key", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [7, 42],
      credentialRows: [
        {
          id: "cred-manager",
          userId: 7,
          version: 3,
          fingerprint: "fp_manager",
        },
        {
          id: "cred-customer",
          userId: 42,
          version: 5,
          fingerprint: "fp_customer",
        },
      ],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_customer");
    expect(result.credentialOwnerByUser.get(42)).toBe(42);
    expect(result.credentialIdByUser.get(42)).toBe("cred-customer");
    expect(result.credentialVersionByUser.get(42)).toBe(5);
  });

  it("keeps the assigned manager's Key as a legacy fallback", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [7, 42],
      credentialRows: [
        {
          id: "cred-manager",
          userId: 7,
          version: 3,
          fingerprint: "fp_manager",
        },
      ],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.get(42)).toBe("fp_manager");
    expect(result.credentialOwnerByUser.get(42)).toBe(7);
    expect(result.credentialIdByUser.get(42)).toBe("cred-manager");
  });

  it("leaves an account unconfigured when neither direct nor fallback Key exists", () => {
    const result = resolveEffectiveUsageCredentials({
      userIds: [42],
      credentialRows: [],
      ownerRows: [{ userId: 42, deliveryAdminId: 7 }],
    });

    expect(result.byUser.has(42)).toBe(false);
    expect(result.credentialOwnerByUser.has(42)).toBe(false);
  });

  it("deduplicates inherited snapshots by credential id/version without merging separate credentials", () => {
    expect(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    ).toBe(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    );
    expect(
      usageCredentialPoolKey({
        credentialId: "customer-v1",
        credentialVersion: 1,
      }),
    ).not.toBe(
      usageCredentialPoolKey({
        credentialId: "manager-v3",
        credentialVersion: 3,
      }),
    );
  });

  it("uses the physical Key fingerprint to merge copied/shared active credentials", () => {
    const first = usageCredentialPoolKey({
      fingerprint: "shared-fingerprint",
      credentialId: "owner-a-v2",
      credentialVersion: 2,
      windowDays: 30,
    });
    const second = usageCredentialPoolKey({
      fingerprint: "shared-fingerprint",
      credentialId: "owner-b-v7",
      credentialVersion: 7,
      windowDays: 30,
    });
    expect(first).toBe(second);
  });
});

describe("rolling usage snapshot identity", () => {
  it("keeps last-good values when a retired credential makes a refresh partial", () => {
    expect(
      usageSnapshotUsageValues({
        status: "error",
        credentialFingerprint: "current-C",
        used: 20,
        accountUsed: 20,
        existing: {
          credentialFingerprint: "current-C",
          used: 20,
          accountUsed: 30,
        },
      }),
    ).toEqual({ used: 20, accountUsed: 30 });
  });

  it("accepts only the exact rolling window fetched after the current credential version existed", () => {
    const fetchedAt = new Date("2026-08-02T08:00:00.000Z");
    const startAt = new Date(fetchedAt.getTime() - 30 * 86_400_000);
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: startAt,
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        credentialCreatedAt: fetchedAt.getTime() - 1,
        windowDays: 30,
        now: fetchedAt.getTime(),
      }),
    ).toBe(true);
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: startAt,
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        credentialCreatedAt: fetchedAt.getTime() + 1,
        windowDays: 30,
        now: fetchedAt.getTime(),
      }),
    ).toBe(false);
  });

  it("keeps a failed refresh current by updatedAt without treating partial data as ok", () => {
    const updatedAt = new Date("2026-08-02T08:00:00.000Z");
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: new Date(updatedAt.getTime() - 30 * 86_400_000),
          fetchedAt: null,
          updatedAt,
        },
        fingerprint: "same-fingerprint",
        windowDays: 30,
        now: updatedAt.getTime(),
      }),
    ).toBe(true);
  });

  it("rejects an otherwise matching snapshot after the freshness TTL", () => {
    const fetchedAt = new Date("2026-08-02T08:00:00.000Z");
    expect(
      isRollingUsageSnapshotCurrent({
        snapshot: {
          credentialFingerprint: "same-fingerprint",
          windowStartedAt: new Date(fetchedAt.getTime() - 30 * 86_400_000),
          fetchedAt,
        },
        fingerprint: "same-fingerprint",
        windowDays: 30,
        now: fetchedAt.getTime() + 31 * 60_000,
      }),
    ).toBe(false);
  });

  it("selects only the newest duplicate snapshot row for a policy", () => {
    const older = {
      id: "older",
      policyId: "policy-1",
      fetchedAt: new Date("2026-08-02T07:00:00.000Z"),
    };
    const newer = {
      id: "newer",
      policyId: "policy-1",
      fetchedAt: new Date("2026-08-02T08:00:00.000Z"),
    };
    expect(latestUsageSnapshotByPolicy([newer, older]).get("policy-1")).toBe(
      newer,
    );
  });
});

describe("unified managed API Key target CAS", () => {
  it("post-scans the previous fingerprint after rotation", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "server/api-usage-snapshot-service.ts"),
      "utf8",
    );
    expect(source).toContain(
      "poolFingerprint: replacement.previousFingerprint",
    );
    expect(source).toContain(
      "previousFingerprint: currentCredential?.fingerprint ?? null",
    );
  });
  it.each([
    ["customer", { id: 1, role: "user" }],
    ["engineer", { id: 2, role: "delivery_member" }],
    [
      "delivery_admin",
      { id: 3, role: "admin", adminAccessLevel: "delivery_admin" },
    ],
    [
      "system_admin",
      { id: 4, role: "admin", adminAccessLevel: "system_admin" },
    ],
  ] as const)("accepts a matching %s target", (kind, target) => {
    expect(() =>
      assertManagedApiKeyTarget({
        kind,
        target,
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).not.toThrow();
  });

  it("rejects a stale replacement and a mismatched target role", () => {
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "customer",
        target: { id: 1, role: "user" },
        actualVersion: 5,
        expectedVersion: 4,
      }),
    ).toThrow(/迟到请求不会覆盖/);
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "engineer",
        target: { id: 1, role: "user" },
        actualVersion: 0,
        expectedVersion: 0,
      }),
    ).toThrow(/类型不匹配/);
    expect(() =>
      assertManagedApiKeyTarget({
        kind: "system_admin",
        target: {
          id: 3,
          role: "admin",
          adminAccessLevel: "delivery_admin",
        },
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).toThrow(/类型不匹配/);
  });
});

describe("bulk managed API Key scopes", () => {
  const accounts = [
    { id: 1, role: "user", isActive: true },
    {
      id: 2,
      role: "admin",
      adminAccessLevel: "delivery_admin",
      isActive: true,
    },
    {
      id: 3,
      role: "admin",
      adminAccessLevel: "system_admin",
      isActive: true,
    },
    { id: 4, role: "delivery_member", isActive: true },
    { id: 5, role: "user", isActive: false },
    { id: 6, role: "admin", adminAccessLevel: null, isActive: true },
    { id: 7, role: "delivery_member", isActive: true },
  ];
  const ownerships = [
    { userId: 1, deliveryAdminId: 2 },
    { userId: 5, deliveryAdminId: 2 },
  ];

  it("resolves every active supported account while excluding disabled and legacy admin rows", () => {
    expect(
      resolveBulkManagedApiKeyTargets({
        scope: { kind: "all" },
        accounts,
        ownerships,
      }),
    ).toEqual([
      { userId: 1, kind: "customer" },
      { userId: 2, kind: "delivery_admin" },
      { userId: 3, kind: "system_admin" },
      { userId: 4, kind: "engineer" },
      { userId: 7, kind: "engineer" },
    ]);
  });

  it("uses usage ownership for one delivery manager and never pulls in engineers", () => {
    expect(
      resolveBulkManagedApiKeyTargets({
        scope: { kind: "delivery_admin", deliveryAdminId: 2 },
        accounts,
        ownerships,
      }),
    ).toEqual([
      { userId: 1, kind: "customer" },
      { userId: 2, kind: "delivery_admin" },
    ]);
  });

  it("accepts only explicitly selected active engineers", () => {
    expect(
      resolveBulkManagedApiKeyTargets({
        scope: { kind: "engineers", engineerIds: [7, 4, 7] },
        accounts,
        ownerships,
      }),
    ).toEqual([
      { userId: 4, kind: "engineer" },
      { userId: 7, kind: "engineer" },
    ]);
    expect(() =>
      resolveBulkManagedApiKeyTargets({
        scope: { kind: "engineers", engineerIds: [1] },
        accounts,
        ownerships,
      }),
    ).toThrow(/工程师不存在/);
  });

  it("rejects duplicate or drifted browser target snapshots", () => {
    const resolvedTargets = [
      { userId: 1, kind: "customer" as const },
      { userId: 2, kind: "delivery_admin" as const },
    ];
    expect(
      assertBulkManagedApiKeyTargetSelection({
        resolvedTargets,
        requestedTargets: [
          { userId: 2, expectedVersion: 4 },
          { userId: 1, expectedVersion: 1 },
        ],
      }),
    ).toEqual([
      { userId: 1, kind: "customer", expectedVersion: 1 },
      { userId: 2, kind: "delivery_admin", expectedVersion: 4 },
    ]);
    expect(() =>
      assertBulkManagedApiKeyTargetSelection({
        resolvedTargets,
        requestedTargets: [
          { userId: 1, expectedVersion: 1 },
          { userId: 1, expectedVersion: 1 },
        ],
      }),
    ).toThrow(/重复账号/);
    expect(() =>
      assertBulkManagedApiKeyTargetSelection({
        resolvedTargets,
        requestedTargets: [{ userId: 1, expectedVersion: 1 }],
      }),
    ).toThrow(/范围已变化/);
  });

  it("selects only accounts that will actually change for each apply mode", () => {
    const resolvedTargets = [
      { userId: 1, kind: "customer" as const },
      { userId: 2, kind: "delivery_admin" as const },
      { userId: 4, kind: "engineer" as const },
    ];
    const latestCredentials = new Map([
      [1, { status: "active", fingerprint: "fp_next" }],
      [2, { status: "deleted", fingerprint: "fp_retired" }],
    ]);

    expect(
      bulkManagedApiKeyActionTargets({
        resolvedTargets,
        latestCredentials,
        applyMode: "unconfigured_only",
        nextFingerprint: "fp_next",
      }).map((target) => target.userId),
    ).toEqual([2, 4]);
    expect(
      bulkManagedApiKeyActionTargets({
        resolvedTargets,
        latestCredentials,
        applyMode: "replace_all",
        nextFingerprint: "fp_next",
      }).map((target) => target.userId),
    ).toEqual([2, 4]);
  });

  it("does not count same-Key accounts against the 200-change limit", () => {
    const resolvedTargets = Array.from({ length: 201 }, (_, index) => ({
      userId: index + 1,
      kind: "customer" as const,
    }));
    const latestCredentials = new Map(
      resolvedTargets.map((target) => [
        target.userId,
        {
          status: "active",
          fingerprint: target.userId === 201 ? "fp_old" : "fp_next",
        },
      ]),
    );

    expect(
      bulkManagedApiKeyActionTargets({
        resolvedTargets,
        latestCredentials,
        applyMode: "replace_all",
        nextFingerprint: "fp_next",
      }).map((target) => target.userId),
    ).toEqual([201]);
  });

  it("deduplicates shared old fingerprints and ignores same-Key or deleted credentials", () => {
    const groups = bulkPreviousCredentialGroups({
      targets: [{ userId: 1 }, { userId: 2 }, { userId: 3 }, { userId: 4 }],
      latestCredentials: new Map([
        [1, { userId: 1, status: "active", fingerprint: "fp_old_shared" }],
        [2, { userId: 2, status: "active", fingerprint: "fp_old_shared" }],
        [3, { userId: 3, status: "deleted", fingerprint: "fp_tombstone" }],
        [4, { userId: 4, status: "active", fingerprint: "fp_next" }],
      ]),
      nextFingerprint: "fp_next",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.fingerprint).toBe("fp_old_shared");
    expect([...groups[0]!.accountIds]).toEqual([1, 2]);
  });

  it("preflights every actionable version before a batch writes", () => {
    const targets = [
      {
        userId: 1,
        kind: "customer" as const,
        expectedVersion: 2,
      },
      {
        userId: 4,
        kind: "engineer" as const,
        expectedVersion: 3,
      },
    ];
    const targetAccounts = new Map([
      [1, { id: 1, role: "user" }],
      [4, { id: 4, role: "delivery_member" }],
    ]);
    const staleCredentials = new Map([
      [1, { version: 2, status: "active" }],
      [4, { version: 4, status: "active" }],
    ]);

    expect(() =>
      assertBulkManagedApiKeyTargetVersions({
        targets,
        accounts: targetAccounts,
        latestCredentials: staleCredentials,
        applyMode: "replace_all",
      }),
    ).toThrow(/迟到请求不会覆盖/);
    expect(() =>
      assertBulkManagedApiKeyTargetVersions({
        targets,
        accounts: targetAccounts,
        latestCredentials: staleCredentials,
        applyMode: "unconfigured_only",
      }),
    ).not.toThrow();
    expect(() =>
      assertBulkManagedApiKeyTargetVersions({
        targets,
        accounts: targetAccounts,
        latestCredentials: new Map([
          [1, { version: 2, status: "active" }],
          [4, { version: 4, status: "deleted" }],
        ]),
        applyMode: "unconfigured_only",
      }),
    ).toThrow(/迟到请求不会覆盖/);
  });
});
