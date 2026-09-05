import { describe, expect, it, vi } from "vitest";

import {
  inspectKnowledgeBaseMigrationInventory,
  KnowledgeBaseMigrationDiagnosticsTracker,
  normalizeKnowledgeBaseMigrationInventory,
} from "./knowledge-base-migration-diagnostics";

const inventory = {
  remainingMigratableLegacy: 3,
  awaitingLegacySettlement: 2,
  inFlightHandoffs: 1,
  attentionRequiredLegacy: 4,
  activeLegacyTotal: 9,
  canonicalV2Active: 12,
};

describe("knowledge-base active migration diagnostics", () => {
  it("normalizes driver string counts and rejects an untrustworthy aggregate", () => {
    expect(
      normalizeKnowledgeBaseMigrationInventory({
        remainingMigratableLegacy: "3",
        awaitingLegacySettlement: "2",
        inFlightHandoffs: "1",
        attentionRequiredLegacy: "4",
        activeLegacyTotal: "9",
        canonicalV2Active: "12",
      }),
    ).toEqual(inventory);
    expect(() =>
      normalizeKnowledgeBaseMigrationInventory({
        ...inventory,
        activeLegacyTotal: "not-a-count",
      }),
    ).toThrow("Invalid aggregate migration count: activeLegacyTotal");
  });

  it("loads only a single aggregate row without exposing customer rows", async () => {
    const leftJoin = vi.fn().mockResolvedValue([
      {
        remainingMigratableLegacy: "3",
        awaitingLegacySettlement: "2",
        inFlightHandoffs: "1",
        attentionRequiredLegacy: "4",
        activeLegacyTotal: "9",
        canonicalV2Active: "12",
      },
    ]);
    const from = vi.fn(() => ({ leftJoin }));
    const select = vi.fn(() => ({ from }));

    await expect(
      inspectKnowledgeBaseMigrationInventory({ select }),
    ).resolves.toEqual(inventory);
    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(leftJoin).toHaveBeenCalledTimes(1);
  });

  it("reports convergence only after both legacy and handoff work reach zero", async () => {
    const tracker = new KnowledgeBaseMigrationDiagnosticsTracker(
      () => new Date("2026-08-13T01:02:03.000Z"),
    );
    await tracker.recordSweep({
      enabled: true,
      infrastructureSucceeded: true,
      loadInventory: async () => ({
        ...inventory,
        remainingMigratableLegacy: 0,
        awaitingLegacySettlement: 0,
        attentionRequiredLegacy: 0,
        activeLegacyTotal: 0,
        inFlightHandoffs: 1,
      }),
    });
    expect(tracker.snapshot({ enabled: true })).toMatchObject({
      lastSweepAt: "2026-08-13T01:02:03.000Z",
      lastSweepInfrastructureStatus: "ok",
      migrationConverged: false,
    });

    await tracker.recordSweep({
      enabled: true,
      infrastructureSucceeded: true,
      loadInventory: async () => ({
        ...inventory,
        remainingMigratableLegacy: 0,
        awaitingLegacySettlement: 0,
        attentionRequiredLegacy: 0,
        activeLegacyTotal: 0,
        inFlightHandoffs: 0,
      }),
    });
    expect(tracker.snapshot({ enabled: true }).migrationConverged).toBe(true);
  });

  it("turns an inventory failure into unknown diagnostics, never false convergence", async () => {
    const tracker = new KnowledgeBaseMigrationDiagnosticsTracker(
      () => new Date("2026-08-13T01:02:03.000Z"),
    );
    await expect(
      tracker.recordSweep({
        enabled: true,
        infrastructureSucceeded: true,
        loadInventory: async () => {
          throw new Error("database timeout");
        },
      }),
    ).resolves.toBeUndefined();
    expect(tracker.snapshot({ enabled: true })).toEqual({
      lastSweepAt: "2026-08-13T01:02:03.000Z",
      lastSweepInfrastructureStatus: "failed",
      remainingMigratableLegacy: null,
      awaitingLegacySettlement: null,
      inFlightHandoffs: null,
      attentionRequiredLegacy: null,
      activeLegacyTotal: null,
      canonicalV2Active: null,
      migrationConverged: null,
    });
  });

  it("does not claim convergence while active migration is disabled", async () => {
    const tracker = new KnowledgeBaseMigrationDiagnosticsTracker();
    await tracker.recordSweep({
      enabled: false,
      infrastructureSucceeded: true,
      loadInventory: async () => ({
        ...inventory,
        activeLegacyTotal: 0,
        inFlightHandoffs: 0,
      }),
    });
    expect(tracker.snapshot({ enabled: false })).toMatchObject({
      lastSweepAt: null,
      lastSweepInfrastructureStatus: "disabled",
      migrationConverged: null,
    });
  });
});
