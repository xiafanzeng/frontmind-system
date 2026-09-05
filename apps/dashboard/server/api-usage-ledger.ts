import { randomUUID } from "node:crypto";

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import {
  apiUsageCredentialCoverage,
  apiUsageTaskLedger,
} from "../drizzle/schema";

export type UsageLedgerScope = "managed_user" | "website_frontend";

export const USAGE_LEDGER_BATCH_SIZE = 200;

const SETTLED_TASK_STATES = new Set([
  "completed",
  "complete",
  "succeeded",
  "done",
  "finished",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

export function isUsageTaskTerminal(task: any) {
  const state = String(task?.status ?? task?.state ?? task?.task_status ?? "")
    .trim()
    .toLowerCase();
  return SETTLED_TASK_STATES.has(state);
}

export function selectPhysicalCredentialRows<
  T extends {
    fingerprint: string;
    status: string;
    retiredAt?: Date | number | null;
    version?: number;
  },
>(rows: T[]) {
  const byFingerprint = new Map<string, T>();
  for (const row of rows) {
    const existing = byFingerprint.get(row.fingerprint);
    const existingRetiredAt =
      existing?.retiredAt instanceof Date
        ? existing.retiredAt.getTime()
        : Number(existing?.retiredAt ?? 0);
    const rowRetiredAt =
      row.retiredAt instanceof Date
        ? row.retiredAt.getTime()
        : Number(row.retiredAt ?? 0);
    if (
      !existing ||
      (existing.status !== "active" && row.status === "active") ||
      (existing.status !== "active" &&
        row.status !== "active" &&
        (rowRetiredAt > existingRetiredAt ||
          (rowRetiredAt === existingRetiredAt &&
            Number(row.version ?? 0) > Number(existing.version ?? 0))))
    ) {
      byFingerprint.set(row.fingerprint, row);
    }
  }
  return [...byFingerprint.values()];
}

export function hasCompleteExpectedTaskSet(
  expectedTaskIds: ReadonlySet<string>,
  seenTaskIds: ReadonlySet<string>,
  terminalProofTaskIds?: ReadonlySet<string>,
) {
  for (const taskId of expectedTaskIds) {
    if (!seenTaskIds.has(taskId) && !terminalProofTaskIds?.has(taskId)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns durable, settled usage facts that can prove an expected task even
 * when the upstream task index no longer returns it. Only terminal rows are
 * accepted: a partial observation of a running task must never seal coverage.
 */
export async function loadTerminalUsageTaskProofs(input: {
  executor: any;
  scope: UsageLedgerScope;
  fingerprints: string[];
  startAt: number;
  endAt: number;
}) {
  const fingerprints = [...new Set(input.fingerprints.filter(Boolean))];
  const proofsByFingerprint = new Map<string, Set<string>>();
  if (fingerprints.length === 0) return proofsByFingerprint;

  const rows = await input.executor
    .select({
      upstreamTaskId: apiUsageTaskLedger.upstreamTaskId,
      credentialFingerprint: apiUsageTaskLedger.credentialFingerprint,
    })
    .from(apiUsageTaskLedger)
    .where(
      and(
        eq(apiUsageTaskLedger.scope, input.scope),
        inArray(apiUsageTaskLedger.credentialFingerprint, fingerprints),
        eq(apiUsageTaskLedger.isTerminal, true),
        gte(apiUsageTaskLedger.taskCreatedAtMs, input.startAt),
        lt(apiUsageTaskLedger.taskCreatedAtMs, input.endAt),
      ),
    );
  for (const row of rows) {
    const taskId = row.upstreamTaskId?.trim();
    const fingerprint = row.credentialFingerprint?.trim();
    if (!taskId || !fingerprint) continue;
    const taskIds = proofsByFingerprint.get(fingerprint) ?? new Set<string>();
    taskIds.add(taskId);
    proofsByFingerprint.set(fingerprint, taskIds);
  }
  return proofsByFingerprint;
}

export async function recordUsageLedgerEntries(input: {
  executor: any;
  scope: UsageLedgerScope;
  credentialFingerprint: string;
  apiCredentialId?: string | null;
  observedAt: Date;
  entries: Array<{
    upstreamTaskId: string;
    accountUserId?: number | null;
    isFirstParty: boolean;
    taskCreatedAtMs: number;
    creditUsage: number;
    isTerminal: boolean;
  }>;
}) {
  const normalized = new Map<string, (typeof input.entries)[number]>();
  let complete = true;
  const conflicts: string[] = [];
  for (const entry of input.entries) {
    const prior = normalized.get(entry.upstreamTaskId);
    if (
      prior &&
      (prior.taskCreatedAtMs !== entry.taskCreatedAtMs ||
        prior.upstreamTaskId !== entry.upstreamTaskId)
    ) {
      complete = false;
      conflicts.push(entry.upstreamTaskId);
      continue;
    }
    normalized.set(entry.upstreamTaskId, {
      ...prior,
      ...entry,
      accountUserId: prior?.accountUserId ?? entry.accountUserId ?? null,
      isFirstParty: Boolean(prior?.isFirstParty || entry.isFirstParty),
      isTerminal: Boolean(prior?.isTerminal || entry.isTerminal),
      creditUsage: Math.max(prior?.creditUsage ?? 0, entry.creditUsage),
    });
  }
  const entries = [...normalized.values()];
  for (
    let offset = 0;
    offset < entries.length;
    offset += USAGE_LEDGER_BATCH_SIZE
  ) {
    const batch = entries.slice(offset, offset + USAGE_LEDGER_BATCH_SIZE);
    const existingRows = await input.executor
      .select({
        upstreamTaskId: apiUsageTaskLedger.upstreamTaskId,
        credentialFingerprint: apiUsageTaskLedger.credentialFingerprint,
        taskCreatedAtMs: apiUsageTaskLedger.taskCreatedAtMs,
      })
      .from(apiUsageTaskLedger)
      .where(
        and(
          eq(apiUsageTaskLedger.scope, input.scope),
          inArray(
            apiUsageTaskLedger.upstreamTaskId,
            batch.map((entry) => entry.upstreamTaskId),
          ),
        ),
      );
    const existingByTask = new Map<
      string,
      {
        upstreamTaskId: string;
        credentialFingerprint: string;
        taskCreatedAtMs: number;
      }
    >(existingRows.map((row: any) => [row.upstreamTaskId, row]));
    const safeBatch = batch.filter((entry) => {
      const existing = existingByTask.get(entry.upstreamTaskId);
      const compatible =
        !existing ||
        (existing.credentialFingerprint === input.credentialFingerprint &&
          Number(existing.taskCreatedAtMs) === entry.taskCreatedAtMs);
      if (!compatible) {
        complete = false;
        conflicts.push(entry.upstreamTaskId);
      }
      return compatible;
    });
    if (safeBatch.length === 0) continue;
    const values = safeBatch.map((entry) => ({
      id: randomUUID(),
      scope: input.scope,
      upstreamTaskId: entry.upstreamTaskId,
      credentialFingerprint: input.credentialFingerprint,
      apiCredentialId: input.apiCredentialId ?? null,
      accountUserId: entry.accountUserId ?? null,
      isFirstParty: entry.isFirstParty,
      taskCreatedAtMs: entry.taskCreatedAtMs,
      creditUsage: Math.max(0, Math.round(entry.creditUsage)),
      isTerminal: entry.isTerminal,
      observedAt: input.observedAt,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    }));
    await input.executor
      .insert(apiUsageTaskLedger)
      .values(values)
      .onDuplicateKeyUpdate({
        set: {
          apiCredentialId: sql`COALESCE(${apiUsageTaskLedger.apiCredentialId}, VALUES(\`apiCredentialId\`))`,
          accountUserId: sql`COALESCE(${apiUsageTaskLedger.accountUserId}, VALUES(\`accountUserId\`))`,
          isFirstParty: sql`GREATEST(${apiUsageTaskLedger.isFirstParty}, VALUES(\`isFirstParty\`))`,
          isTerminal: sql`GREATEST(${apiUsageTaskLedger.isTerminal}, VALUES(\`isTerminal\`))`,
          creditUsage: sql`GREATEST(${apiUsageTaskLedger.creditUsage}, VALUES(\`creditUsage\`))`,
          observedAt: sql`GREATEST(${apiUsageTaskLedger.observedAt}, VALUES(\`observedAt\`))`,
          updatedAt: sql`GREATEST(${apiUsageTaskLedger.updatedAt}, VALUES(\`updatedAt\`))`,
        },
      });
  }
  return { complete, conflicts: [...new Set(conflicts)] };
}

export async function markUsageCredentialCoverage(input: {
  executor: any;
  scope: UsageLedgerScope;
  credentialFingerprint: string;
  coveredFromMs: number;
  fullScanAtMs: number;
  credentialRetiredAtMs?: number | null;
  allTasksSettled: boolean;
  scanToken: string;
}) {
  const updatedAt = new Date(input.fullScanAtMs);
  const result = await input.executor
    .update(apiUsageCredentialCoverage)
    .set({
      coveredFromMs: sql`CASE WHEN ${apiUsageCredentialCoverage.fullScanAtMs} = 0 THEN ${input.coveredFromMs} ELSE LEAST(${apiUsageCredentialCoverage.coveredFromMs}, ${input.coveredFromMs}) END`,
      fullScanAtMs: input.fullScanAtMs,
      credentialRetiredAtMs:
        input.credentialRetiredAtMs ??
        apiUsageCredentialCoverage.credentialRetiredAtMs,
      allTasksSettled: input.allTasksSettled,
      scanToken: null,
      scanStartedAtMs: null,
      updatedAt,
    })
    .where(
      and(
        eq(apiUsageCredentialCoverage.scope, input.scope),
        eq(
          apiUsageCredentialCoverage.credentialFingerprint,
          input.credentialFingerprint,
        ),
        eq(apiUsageCredentialCoverage.scanToken, input.scanToken),
      ),
    );
  return Boolean(result?.[0]?.affectedRows ?? result?.affectedRows);
}

export async function claimUsageCredentialCoverage(input: {
  executor: any;
  scope: UsageLedgerScope;
  credentialFingerprint: string;
  coveredFromMs: number;
  scanStartedAtMs: number;
  credentialRetiredAtMs?: number | null;
}) {
  const scanToken = randomUUID();
  const now = new Date(input.scanStartedAtMs);
  await input.executor
    .insert(apiUsageCredentialCoverage)
    .values({
      id: randomUUID(),
      scope: input.scope,
      credentialFingerprint: input.credentialFingerprint,
      coveredFromMs: input.coveredFromMs,
      fullScanAtMs: 0,
      credentialRetiredAtMs: input.credentialRetiredAtMs ?? null,
      allTasksSettled: false,
      scanGeneration: 1,
      scanToken,
      scanStartedAtMs: input.scanStartedAtMs,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        scanGeneration: sql`${apiUsageCredentialCoverage.scanGeneration} + 1`,
        scanToken,
        scanStartedAtMs: input.scanStartedAtMs,
        updatedAt: now,
      },
    });
  return scanToken;
}

export function usageCoverageSupportsRetiredCredential(input: {
  coverage?: {
    coveredFromMs: number;
    fullScanAtMs: number;
    credentialRetiredAtMs: number | null;
    allTasksSettled: boolean;
    scanToken?: string | null;
    scanStartedAtMs?: number | null;
  } | null;
  periodStartMs: number;
  credentialRetiredAtMs?: number | null;
}) {
  const retiredAt =
    input.credentialRetiredAtMs ??
    input.coverage?.credentialRetiredAtMs ??
    null;
  return Boolean(
    input.coverage &&
      retiredAt != null &&
      input.coverage.coveredFromMs <= input.periodStartMs &&
      input.coverage.fullScanAtMs >= retiredAt &&
      input.coverage.allTasksSettled &&
      !input.coverage.scanToken,
  );
}

export function usageCoverageSupportsReplacement(input: {
  coverage?: {
    coveredFromMs: number;
    fullScanAtMs: number;
    allTasksSettled: boolean;
    scanToken?: string | null;
    scanStartedAtMs?: number | null;
  } | null;
  periodStartMs: number;
  nowMs: number;
  maxAgeMs?: number;
}) {
  const maxAgeMs = input.maxAgeMs ?? 30 * 60 * 1_000;
  return Boolean(
    input.coverage &&
      !input.coverage.scanToken &&
      input.coverage.coveredFromMs <= input.periodStartMs &&
      input.coverage.fullScanAtMs <= input.nowMs &&
      input.coverage.fullScanAtMs >= input.nowMs - maxAgeMs,
  );
}

export async function loadUsageCoverage(input: {
  executor: any;
  scope: UsageLedgerScope;
  fingerprints: string[];
}) {
  if (input.fingerprints.length === 0) return new Map<string, any>();
  const rows = await input.executor
    .select()
    .from(apiUsageCredentialCoverage)
    .where(
      and(
        eq(apiUsageCredentialCoverage.scope, input.scope),
        inArray(
          apiUsageCredentialCoverage.credentialFingerprint,
          input.fingerprints,
        ),
      ),
    );
  return new Map(rows.map((row: any) => [row.credentialFingerprint, row]));
}

export async function readManagedUsageLedger(input: {
  executor: any;
  poolFingerprint: string;
  accountIds: number[];
  startAt: number;
  endAt: number;
}) {
  const [poolRows, accountRows] = await Promise.all([
    input.executor
      .select({
        used: sql<number>`COALESCE(SUM(${apiUsageTaskLedger.creditUsage}), 0)`,
      })
      .from(apiUsageTaskLedger)
      .where(
        and(
          eq(apiUsageTaskLedger.scope, "managed_user"),
          eq(apiUsageTaskLedger.credentialFingerprint, input.poolFingerprint),
          gte(apiUsageTaskLedger.taskCreatedAtMs, input.startAt),
          lt(apiUsageTaskLedger.taskCreatedAtMs, input.endAt),
        ),
      ),
    input.accountIds.length
      ? input.executor
          .select({
            accountUserId: apiUsageTaskLedger.accountUserId,
            used: sql<number>`COALESCE(SUM(${apiUsageTaskLedger.creditUsage}), 0)`,
          })
          .from(apiUsageTaskLedger)
          .where(
            and(
              eq(apiUsageTaskLedger.scope, "managed_user"),
              inArray(apiUsageTaskLedger.accountUserId, input.accountIds),
              gte(apiUsageTaskLedger.taskCreatedAtMs, input.startAt),
              lt(apiUsageTaskLedger.taskCreatedAtMs, input.endAt),
            ),
          )
          .groupBy(apiUsageTaskLedger.accountUserId)
      : Promise.resolve([]),
  ]);
  return {
    totalUsed: Number(poolRows[0]?.used ?? 0),
    accountUsed: new Map<number, number>(
      accountRows.map((row: any) => [
        Number(row.accountUserId),
        Number(row.used),
      ]),
    ),
  };
}

export async function readWebsiteUsageLedger(input: {
  executor: any;
  currentFingerprint: string;
  startAt: number;
  endAt: number;
}) {
  const rows = await input.executor
    .select({
      keyTotalUsed: sql<number>`COALESCE(SUM(CASE WHEN ${apiUsageTaskLedger.credentialFingerprint} = ${input.currentFingerprint} THEN ${apiUsageTaskLedger.creditUsage} ELSE 0 END), 0)`,
      websiteUsed: sql<number>`COALESCE(SUM(CASE WHEN ${apiUsageTaskLedger.isFirstParty} = 1 THEN ${apiUsageTaskLedger.creditUsage} ELSE 0 END), 0)`,
    })
    .from(apiUsageTaskLedger)
    .where(
      and(
        eq(apiUsageTaskLedger.scope, "website_frontend"),
        gte(apiUsageTaskLedger.taskCreatedAtMs, input.startAt),
        lt(apiUsageTaskLedger.taskCreatedAtMs, input.endAt),
      ),
    );
  return {
    keyTotalUsed: Number(rows[0]?.keyTotalUsed ?? 0),
    websiteUsed: Number(rows[0]?.websiteUsed ?? 0),
  };
}
