import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isUsageTaskTerminal,
  hasCompleteExpectedTaskSet,
  loadTerminalUsageTaskProofs,
  recordUsageLedgerEntries,
  selectPhysicalCredentialRows,
  USAGE_LEDGER_BATCH_SIZE,
  usageCoverageSupportsReplacement,
  usageCoverageSupportsRetiredCredential,
} from "./api-usage-ledger";

function ledgerExecutor(existingRows: any[] = []) {
  const insertedBatches: any[][] = [];
  const updateSets: any[] = [];
  let selectCount = 0;
  return {
    insertedBatches,
    updateSets,
    get selectCount() {
      return selectCount;
    },
    executor: {
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            return existingRows;
          },
        }),
      }),
      insert: () => ({
        values: (values: any[]) => {
          insertedBatches.push(values);
          return {
            onDuplicateKeyUpdate: async ({ set }: any) => {
              updateSets.push(set);
            },
          };
        },
      }),
    },
  };
}

describe("task usage ledger", () => {
  it("does not seal coverage while a locally reserved task is absent from the upstream index", () => {
    expect(
      hasCompleteExpectedTaskSet(
        new Set(["task-visible", "task-delayed"]),
        new Set(["task-visible"]),
      ),
    ).toBe(false);
    expect(
      hasCompleteExpectedTaskSet(
        new Set(["task-visible", "task-delayed"]),
        new Set(["task-delayed", "task-visible"]),
      ),
    ).toBe(true);
  });
  it("accepts an absent task only when the immutable ledger has terminal proof", () => {
    expect(
      hasCompleteExpectedTaskSet(
        new Set(["task-visible", "task-retained"]),
        new Set(["task-visible"]),
        new Set(["task-retained"]),
      ),
    ).toBe(true);
    expect(
      hasCompleteExpectedTaskSet(
        new Set(["task-visible", "task-missing"]),
        new Set(["task-visible"]),
        new Set(["different-task"]),
      ),
    ).toBe(false);
  });

  it("loads only the terminal usage facts returned by the proof query", async () => {
    const executor = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              upstreamTaskId: "task-a",
              credentialFingerprint: "fingerprint-a",
            },
            {
              upstreamTaskId: "task-b",
              credentialFingerprint: "fingerprint-a",
            },
          ],
        }),
      }),
    };
    const proofs = await loadTerminalUsageTaskProofs({
      executor,
      scope: "website_frontend",
      fingerprints: ["fingerprint-a"],
      startAt: 100,
      endAt: 200,
    });
    expect(proofs.get("fingerprint-a")).toEqual(new Set(["task-a", "task-b"]));
  });
  it("treats a shared physical Key as active even when a retired owner has a higher local version", () => {
    expect(
      selectPhysicalCredentialRows([
        { fingerprint: "shared", status: "retired", version: 10 },
        { fingerprint: "shared", status: "active", version: 1 },
      ]),
    ).toEqual([{ fingerprint: "shared", status: "active", version: 1 }]);
  });

  it("does not physically retire a fingerprint while another owner still has an active binding", () => {
    const selected = selectPhysicalCredentialRows([
      {
        fingerprint: "shared",
        status: "retired",
        ownerId: 1,
        retiredAt: 100,
      },
      {
        fingerprint: "shared",
        status: "active",
        ownerId: 2,
        retiredAt: null,
      },
    ]);
    expect(selected[0]).toMatchObject({
      status: "active",
      ownerId: 2,
      retiredAt: null,
    });
  });

  it("uses the last retirement when every binding for one physical Key is retired", () => {
    const selected = selectPhysicalCredentialRows([
      {
        fingerprint: "shared-retired",
        status: "retired",
        ownerId: 1,
        version: 9,
        retiredAt: new Date("2026-08-02T08:00:00.000Z"),
      },
      {
        fingerprint: "shared-retired",
        status: "retired",
        ownerId: 2,
        version: 2,
        retiredAt: new Date("2026-08-02T09:00:00.000Z"),
      },
    ]);
    expect(selected[0]).toMatchObject({
      ownerId: 2,
      retiredAt: new Date("2026-08-02T09:00:00.000Z"),
    });
  });
  it("recognizes every supported settled state and leaves running tasks open", () => {
    for (const status of [
      "completed",
      "complete",
      "succeeded",
      "done",
      "finished",
      "failed",
      "error",
      "cancelled",
      "canceled",
    ]) {
      expect(isUsageTaskTerminal({ status })).toBe(true);
    }
    expect(isUsageTaskTerminal({ status: "running" })).toBe(false);
    expect(isUsageTaskTerminal({ status: "awaiting_input" })).toBe(false);
  });

  it("writes large pages in bounded batches rather than one query per task", async () => {
    const mock = ledgerExecutor();
    const count = USAGE_LEDGER_BATCH_SIZE * 2 + 1;
    const result = await recordUsageLedgerEntries({
      executor: mock.executor,
      scope: "managed_user",
      credentialFingerprint: "fingerprint-A",
      observedAt: new Date("2026-08-02T00:00:00Z"),
      entries: Array.from({ length: count }, (_, index) => ({
        upstreamTaskId: `task-${index}`,
        accountUserId: 9,
        isFirstParty: true,
        taskCreatedAtMs: 1_700_000_000_000 + index,
        creditUsage: index,
        isTerminal: index % 2 === 0,
      })),
    });
    expect(result.complete).toBe(true);
    expect(mock.selectCount).toBe(3);
    expect(mock.insertedBatches.map((batch) => batch.length)).toEqual([
      USAGE_LEDGER_BATCH_SIZE,
      USAGE_LEDGER_BATCH_SIZE,
      1,
    ]);
  });

  it("rejects a task id that reappears under another physical Key", async () => {
    const mock = ledgerExecutor([
      {
        upstreamTaskId: "task-conflict",
        credentialFingerprint: "fingerprint-A",
        taskCreatedAtMs: 1_700_000_000_000,
      },
    ]);
    const result = await recordUsageLedgerEntries({
      executor: mock.executor,
      scope: "managed_user",
      credentialFingerprint: "fingerprint-B",
      observedAt: new Date("2026-08-02T00:00:00Z"),
      entries: [
        {
          upstreamTaskId: "task-conflict",
          accountUserId: null,
          isFirstParty: false,
          taskCreatedAtMs: 1_700_000_000_000,
          creditUsage: 10,
          isTerminal: false,
        },
      ],
    });
    expect(result).toEqual({
      complete: false,
      conflicts: ["task-conflict"],
    });
    expect(mock.insertedBatches).toHaveLength(0);
  });

  it("keeps ownership, first-party, terminal and usage facts monotonic in SQL", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "server/api-usage-ledger.ts"),
      "utf8",
    );
    expect(source).toContain("COALESCE(${apiUsageTaskLedger.accountUserId}");
    expect(source).toContain("GREATEST(${apiUsageTaskLedger.isFirstParty}");
    expect(source).toContain("GREATEST(${apiUsageTaskLedger.isTerminal}");
    expect(source).toContain("GREATEST(${apiUsageTaskLedger.creditUsage}");
  });
});

describe("usage coverage proof", () => {
  const baseCoverage = {
    coveredFromMs: 100,
    fullScanAtMs: 1_000,
    credentialRetiredAtMs: 900,
    allTasksSettled: true,
    scanToken: null,
  };

  it("accepts retired 401/403 only after a complete settled scan covering retirement", () => {
    expect(
      usageCoverageSupportsRetiredCredential({
        coverage: baseCoverage,
        periodStartMs: 200,
      }),
    ).toBe(true);
    expect(
      usageCoverageSupportsRetiredCredential({
        coverage: { ...baseCoverage, allTasksSettled: false },
        periodStartMs: 200,
      }),
    ).toBe(false);
    expect(
      usageCoverageSupportsRetiredCredential({
        coverage: { ...baseCoverage, fullScanAtMs: 899 },
        periodStartMs: 200,
      }),
    ).toBe(false);
  });

  it("blocks replacement while a newer token-bound scan is in flight", () => {
    expect(
      usageCoverageSupportsReplacement({
        coverage: {
          ...baseCoverage,
          scanToken: "newer-scan",
        },
        periodStartMs: 200,
        nowMs: 1_100,
      }),
    ).toBe(false);
  });

  it("allows safe rotation after a complete scan while pinned tasks remain active", () => {
    expect(
      usageCoverageSupportsReplacement({
        coverage: { ...baseCoverage, allTasksSettled: false },
        periodStartMs: 200,
        nowMs: 1_100,
      }),
    ).toBe(true);
  });
});
