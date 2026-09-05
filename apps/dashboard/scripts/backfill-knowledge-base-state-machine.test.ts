import { describe, expect, it, vi } from "vitest";

import {
  assertKnowledgeBaseBackfillCoverage,
  assertKnowledgeBaseBackfillApplyRetired,
  assertKnowledgeBaseReadyPackageBackfillFinalized,
  assertKnowledgeBaseReservationsRecovered,
  assertRecoverableSkillPins,
  drainKnowledgeBaseRecovery,
  prepareAllKnowledgeBaseStateMachineBackfill,
} from "./backfill-knowledge-base-state-machine";

function disposition(index: number) {
  return {
    buildId: `build-${String(index).padStart(5, "0")}`,
    generation: 1,
    status: "confirming" as const,
    skillVersion: "3",
    turnId: null,
    actions: ["retain_protocol_error"],
  };
}

function inventoryBuild(overrides: Record<string, unknown> = {}) {
  return {
    buildId: "build-1",
    generation: 1,
    status: "confirming",
    protocolErrorCode: null,
    skillVersion: "3",
    skillContentHash: "a".repeat(64),
    skillPinStatus: "resolvable",
    revision: 0,
    packageRevision: null,
    hasActiveTurn: false,
    activeTurnValid: true,
    activeTurnNeedsSkill: false,
    hasUpstreamTask: true,
    hasLogo: false,
    hasPackage: false,
    ...overrides,
  };
}

function inventory(builds: Array<ReturnType<typeof inventoryBuild>>) {
  return { total: builds.length, buckets: [], builds } as any;
}

describe("knowledge-base state-machine backfill command", () => {
  it("drains every keyset page instead of stopping after the first 2,000 rows", async () => {
    const total = 2_001;
    const prepare = vi.fn(async (input: any) => {
      const start = input.after
        ? Number(String(input.after.buildId).slice("build-".length)) + 1
        : 0;
      const count = Math.min(input.limit, total - start);
      const rows = Array.from({ length: count }, (_, offset) =>
        disposition(start + offset),
      );
      const last = rows.at(-1);
      return {
        scanned: rows.length,
        reservationsCreated: 0,
        staleErrorsCleared: 0,
        rebindRequired: 0,
        alreadyMigrated: 0,
        skipped: rows.length,
        dispositions: rows,
        nextCursor: last
          ? { createdAt: new Date(0), buildId: last.buildId }
          : null,
        hasMore: start + count < total,
      };
    });

    const result = await prepareAllKnowledgeBaseStateMachineBackfill({
      apply: false,
      pageSize: 500,
      prepare: prepare as any,
    });

    expect(result.scanned).toBe(total);
    expect(result.dispositions).toHaveLength(total);
    expect(result.pages).toBe(5);
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(prepare.mock.calls[1]![0].after.buildId).toBe("build-00499");
  });

  it("drains only reservation pages and preserves exact claimed turn IDs", async () => {
    const turnRecovery = vi
      .fn()
      .mockResolvedValueOnce({
        scanned: 200,
        claimed: 200,
        claimedTurnIds: Array.from(
          { length: 200 },
          (_, index) => `turn-${index}`,
        ),
        rebound: 0,
        reconciled: 200,
        credentialPaused: 0,
        skipped: 0,
        failed: 0,
      })
      .mockResolvedValueOnce({
        scanned: 1,
        claimed: 1,
        claimedTurnIds: ["turn-200"],
        rebound: 0,
        reconciled: 1,
        credentialPaused: 0,
        skipped: 0,
        failed: 0,
      });

    const result = await drainKnowledgeBaseRecovery({
      recoverExpiredKnowledgeBaseTurns: turnRecovery as any,
    });

    expect(result.turnPasses).toBe(2);
    expect(result.turns.claimed).toBe(201);
    expect(result.claimedTurnIds).toHaveLength(201);
  });

  it("fails closed when reservation recovery skips work", async () => {
    await expect(
      drainKnowledgeBaseRecovery({
        recoverExpiredKnowledgeBaseTurns: vi.fn().mockResolvedValue({
          scanned: 1,
          claimed: 0,
          claimedTurnIds: [],
          rebound: 0,
          reconciled: 0,
          credentialPaused: 0,
          skipped: 1,
          failed: 0,
        }) as any,
      }),
    ).rejects.toThrow("KB_TURN_RECOVERY_SKIPPED");
  });

  it("retires every mutating backfill invocation before recovery setup", () => {
    expect(() => assertKnowledgeBaseBackfillApplyRetired(false)).not.toThrow();
    expect(() => assertKnowledgeBaseBackfillApplyRetired(true)).toThrow(
      "KB_V2_BACKFILL_RETIRED_RESET_REQUIRED",
    );
  });

  it("requires exact preparation coverage and exact reservation claims", () => {
    const prepared = {
      pages: 1,
      scanned: 1,
      reservationsCreated: 1,
      staleErrorsCleared: 0,
      rebindRequired: 0,
      alreadyMigrated: 0,
      skipped: 0,
      dispositions: [
        {
          ...disposition(0),
          turnId: "turn-1",
          actions: [
            "prepare_legacy_reconcile_reservation",
            "create_reservation",
          ],
        },
      ],
    };
    const sourceInventory = inventory([inventoryBuild()]);

    expect(() =>
      assertKnowledgeBaseBackfillCoverage({
        inventory: sourceInventory,
        prepared: prepared as any,
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseReservationsRecovered({
        prepared: prepared as any,
        claimedTurnIds: ["turn-1"],
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseReservationsRecovered({
        prepared: prepared as any,
        claimedTurnIds: [],
      }),
    ).toThrow("KB_BACKFILL_RESERVATION_NOT_RECOVERED");
    expect(() =>
      assertKnowledgeBaseBackfillCoverage({
        inventory: inventory([
          inventoryBuild({ hasActiveTurn: true, activeTurnValid: false }),
        ]),
        prepared: { ...prepared, scanned: 0, dispositions: [] } as any,
      }),
    ).toThrow("KB_ACTIVE_TURN_INVALID");
  });

  it("allows package-only rebind without a historical Skill pin but blocks active work", () => {
    expect(() =>
      assertRecoverableSkillPins(
        inventory([
          inventoryBuild({
            status: "protocol_error",
            protocolErrorCode: "PACKAGE_REBIND_REQUIRED",
            skillContentHash: null,
            skillPinStatus: "missing_hash",
          }),
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoverableSkillPins(
        inventory([
          inventoryBuild({
            status: "confirming",
            hasUpstreamTask: false,
            hasActiveTurn: false,
            activeTurnNeedsSkill: false,
            skillContentHash: null,
            skillPinStatus: "missing_hash",
          }),
        ]),
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoverableSkillPins(
        inventory([
          inventoryBuild({
            status: "researching",
            hasActiveTurn: true,
            activeTurnNeedsSkill: true,
            skillContentHash: null,
            skillPinStatus: "missing_hash",
          }),
        ]),
      ),
    ).toThrow("KB_SKILL_PIN_UNRESOLVABLE");
  });

  it("refuses to finalize while any publishable build lacks immutable ZIP bytes", () => {
    expect(() =>
      assertKnowledgeBaseReadyPackageBackfillFinalized(
        inventory([
          inventoryBuild({ status: "ready_to_publish", hasPackage: false }),
        ]),
      ),
    ).toThrow("KB_READY_PACKAGE_BACKFILL_INCOMPLETE");
    expect(() =>
      assertKnowledgeBaseReadyPackageBackfillFinalized(
        inventory([
          inventoryBuild({ status: "protocol_error", hasPackage: false }),
        ]),
      ),
    ).not.toThrow();
  });
});
