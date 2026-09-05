import { sql } from "drizzle-orm";

import { conversationTurns, knowledgeBaseBuilds } from "../drizzle/schema";

export type KnowledgeBaseMigrationInventory = {
  remainingMigratableLegacy: number;
  awaitingLegacySettlement: number;
  inFlightHandoffs: number;
  attentionRequiredLegacy: number;
  activeLegacyTotal: number;
  canonicalV2Active: number;
};

export type KnowledgeBaseMigrationDiagnostics = {
  lastSweepAt: string | null;
  lastSweepInfrastructureStatus: "pending" | "ok" | "failed" | "disabled";
  remainingMigratableLegacy: number | null;
  awaitingLegacySettlement: number | null;
  inFlightHandoffs: number | null;
  attentionRequiredLegacy: number | null;
  activeLegacyTotal: number | null;
  canonicalV2Active: number | null;
  /** `null` is deliberate: an unavailable inventory is never convergence. */
  migrationConverged: boolean | null;
};

type AggregateRow = Record<keyof KnowledgeBaseMigrationInventory, unknown>;

const EMPTY_COUNTS = {
  remainingMigratableLegacy: null,
  awaitingLegacySettlement: null,
  inFlightHandoffs: null,
  attentionRequiredLegacy: null,
  activeLegacyTotal: null,
  canonicalV2Active: null,
} as const;

function aggregateCount(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid aggregate migration count: ${field}`);
  }
  return parsed;
}

export function normalizeKnowledgeBaseMigrationInventory(
  row: AggregateRow,
): KnowledgeBaseMigrationInventory {
  return {
    remainingMigratableLegacy: aggregateCount(
      row.remainingMigratableLegacy,
      "remainingMigratableLegacy",
    ),
    awaitingLegacySettlement: aggregateCount(
      row.awaitingLegacySettlement,
      "awaitingLegacySettlement",
    ),
    inFlightHandoffs: aggregateCount(row.inFlightHandoffs, "inFlightHandoffs"),
    attentionRequiredLegacy: aggregateCount(
      row.attentionRequiredLegacy,
      "attentionRequiredLegacy",
    ),
    activeLegacyTotal: aggregateCount(
      row.activeLegacyTotal,
      "activeLegacyTotal",
    ),
    canonicalV2Active: aggregateCount(
      row.canonicalV2Active,
      "canonicalV2Active",
    ),
  };
}

/**
 * One aggregate query exposes migration convergence without returning build,
 * customer, task, credential or turn identifiers. The broad active legacy
 * total intentionally catches rows which fit no automatic disposition, so an
 * unknown/stuck row can never be reported as converged.
 */
export async function inspectKnowledgeBaseMigrationInventory(
  executor: any,
): Promise<KnowledgeBaseMigrationInventory> {
  const attemptState = sql`COALESCE(
    JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.createAttemptState')),
    CASE
      WHEN ${conversationTurns.upstreamTaskId} IS NOT NULL THEN 'acknowledged'
      WHEN JSON_EXTRACT(${conversationTurns.metadata}, '$.outcomeUnknownAt') IS NOT NULL
        OR JSON_EXTRACT(${conversationTurns.metadata}, '$.dispatchingAt') IS NOT NULL
      THEN 'unknown'
      ELSE 'not_sent'
    END
  )`;
  const activeLegacy = sql`${knowledgeBaseBuilds.providerProtocol} = 'legacy_v1'
    AND ${knowledgeBaseBuilds.status} IN ('researching', 'confirming', 'protocol_error')`;
  const rows = (await executor
    .select({
      remainingMigratableLegacy: sql<number>`COALESCE(SUM(CASE
        WHEN ${activeLegacy}
          AND ${knowledgeBaseBuilds.canonicalTaskId} IS NULL
          AND ${knowledgeBaseBuilds.canonicalTaskState} <> 'attention_required'
          AND (
            (${knowledgeBaseBuilds.status} = 'confirming' AND ${knowledgeBaseBuilds.activeTurnId} IS NULL)
            OR (
              ${knowledgeBaseBuilds.activeTurnId} IS NOT NULL
              AND ${conversationTurns.id} IS NOT NULL
              AND ${attemptState} = 'not_sent'
            )
          )
        THEN 1 ELSE 0 END), 0)`,
      awaitingLegacySettlement: sql<number>`COALESCE(SUM(CASE
        WHEN ${activeLegacy}
          AND ${knowledgeBaseBuilds.canonicalTaskState} <> 'attention_required'
          AND (
            (${knowledgeBaseBuilds.status} = 'researching' AND ${knowledgeBaseBuilds.activeTurnId} IS NULL)
            OR (
              ${knowledgeBaseBuilds.activeTurnId} IS NOT NULL
              AND ${conversationTurns.id} IS NOT NULL
              AND ${attemptState} IN ('sending', 'unknown', 'acknowledged')
            )
          )
        THEN 1 ELSE 0 END), 0)`,
      inFlightHandoffs: sql<number>`COALESCE(SUM(CASE
        WHEN ${knowledgeBaseBuilds.providerProtocol} = 'manus_v2'
          AND ${knowledgeBaseBuilds.status} IN ('researching', 'confirming', 'protocol_error')
          AND ${knowledgeBaseBuilds.activeTurnId} IS NOT NULL
          AND ${conversationTurns.id} IS NOT NULL
          AND ${conversationTurns.status} IN ('queued', 'running')
          AND JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.repairKind'))
            IN ('legacy_anchor_handoff', 'canonical_credential_rebind')
        THEN 1 ELSE 0 END), 0)`,
      attentionRequiredLegacy: sql<number>`COALESCE(SUM(CASE
        WHEN ${activeLegacy}
          AND ${knowledgeBaseBuilds.canonicalTaskState} = 'attention_required'
        THEN 1 ELSE 0 END), 0)`,
      activeLegacyTotal: sql<number>`COALESCE(SUM(CASE
        WHEN ${activeLegacy} THEN 1 ELSE 0 END), 0)`,
      canonicalV2Active: sql<number>`COALESCE(SUM(CASE
        WHEN ${knowledgeBaseBuilds.providerProtocol} = 'manus_v2'
          AND ${knowledgeBaseBuilds.status} IN ('researching', 'confirming', 'protocol_error')
          AND ${knowledgeBaseBuilds.canonicalTaskId} IS NOT NULL
          AND ${knowledgeBaseBuilds.canonicalTaskGeneration} = ${knowledgeBaseBuilds.generation}
          AND ${knowledgeBaseBuilds.canonicalTaskState} = 'active'
        THEN 1 ELSE 0 END), 0)`,
    })
    .from(knowledgeBaseBuilds)
    .leftJoin(
      conversationTurns,
      sql`${conversationTurns.id} = ${knowledgeBaseBuilds.activeTurnId}`,
    )) as AggregateRow[];
  if (!rows[0]) throw new Error("Missing aggregate migration inventory");
  return normalizeKnowledgeBaseMigrationInventory(rows[0]);
}

export class KnowledgeBaseMigrationDiagnosticsTracker {
  private value: KnowledgeBaseMigrationDiagnostics = {
    lastSweepAt: null,
    lastSweepInfrastructureStatus: "pending",
    ...EMPTY_COUNTS,
    migrationConverged: null,
  };

  constructor(private readonly now: () => Date = () => new Date()) {}

  async recordSweep(input: {
    enabled: boolean;
    infrastructureSucceeded: boolean;
    loadInventory: () => Promise<KnowledgeBaseMigrationInventory>;
  }) {
    const observedAt = this.now().toISOString();
    try {
      const inventory = await input.loadInventory();
      this.value = {
        lastSweepAt: input.enabled ? observedAt : null,
        lastSweepInfrastructureStatus: input.enabled
          ? input.infrastructureSucceeded
            ? "ok"
            : "failed"
          : "disabled",
        ...inventory,
        migrationConverged:
          inventory.activeLegacyTotal === 0 && inventory.inFlightHandoffs === 0,
      };
    } catch {
      this.value = {
        lastSweepAt: input.enabled ? observedAt : null,
        lastSweepInfrastructureStatus: input.enabled ? "failed" : "disabled",
        ...EMPTY_COUNTS,
        migrationConverged: null,
      };
    }
  }

  snapshot(input: { enabled: boolean }): KnowledgeBaseMigrationDiagnostics {
    if (!input.enabled) {
      return {
        ...this.value,
        lastSweepAt: null,
        lastSweepInfrastructureStatus: "disabled",
        migrationConverged: null,
      };
    }
    return { ...this.value };
  }
}

export const knowledgeBaseMigrationDiagnostics =
  new KnowledgeBaseMigrationDiagnosticsTracker();
