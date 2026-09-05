import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import mysql from "mysql2/promise";

import {
  deliveryRedirectPreviews,
  deliveryTickets,
  deliveryWorkflowMilestones,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetCleanupJobs,
  knowledgeBaseResetRequests,
  knowledgeBaseSnapshots,
  serviceQuotaPeriods,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteStyleWorkflows,
} from "../drizzle/schema";
import { getDb } from "./db";

export const DEFAULT_DELIVERY_TICKET_RETENTION_DAYS = 30;
export const DEFAULT_DELIVERY_TICKET_RETENTION_BATCH_SIZE = 100;
export const DEFAULT_DELIVERY_TICKET_RETENTION_MAX_BATCHES = 20;
export const DELIVERY_TICKET_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DELIVERY_TICKET_RETENTION_LOCK_NAME =
  "frontmind-dashboard:delivery-ticket-retention";

const TERMINAL_TICKET_STATUSES = [
  "completed",
  "rejected",
  "cancelled",
] as const;

type RetentionTicketRow = {
  id: string;
  userId: number;
  quotaPeriodId: string;
  quotaPool: "content_asset_publish" | "website_content_publish" | null;
  quotaState: "reserved" | "consumed" | "released";
  status:
    | "submitted"
    | "needs_information"
    | "scheduled"
    | "in_progress"
    | "completed"
    | "rejected"
    | "cancelled";
  operation: string | null;
  contentAssetIds: string[];
  resolvedAt: Date | null;
  updatedAt: Date;
};

export type DeliveryTicketRetentionFacts = {
  quotaDeltas: Array<{
    quotaPeriodId: string;
    quotaPool: "content_asset_publish" | "website_content_publish";
    count: number;
  }>;
  milestones: Array<{
    userId: number;
    operation: string;
    contentAssetIds: string[];
    completedAt: Date;
  }>;
};

export type DeliveryTicketRetentionResult = {
  cutoff: Date;
  batches: number;
  tickets: number;
  milestones: number;
  quotaFacts: number;
  styleBatches: number;
  redirectPreviews: number;
  resetRequests: number;
};

export function deliveryTicketRetentionAffectedRows(value: unknown) {
  const metadata = (Array.isArray(value) ? value[0] : value) as {
    rowsAffected?: number;
    affectedRows?: number;
  };
  return Number(metadata?.rowsAffected ?? metadata?.affectedRows ?? 0);
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是大于 0 的整数`);
  }
  return value;
}

export function getDeliveryTicketRetentionCutoff(
  retentionDays = DEFAULT_DELIVERY_TICKET_RETENTION_DAYS,
  now = new Date(),
) {
  positiveInteger(retentionDays, "工单保留天数");
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
}

export function isDeliveryTicketRetentionEligible(
  ticket: Pick<RetentionTicketRow, "status" | "resolvedAt"> &
    Partial<Pick<RetentionTicketRow, "updatedAt">>,
  cutoff: Date,
) {
  const resolvedAt = ticket.resolvedAt ?? ticket.updatedAt ?? null;
  return (
    TERMINAL_TICKET_STATUSES.includes(
      ticket.status as (typeof TERMINAL_TICKET_STATUSES)[number],
    ) &&
    resolvedAt instanceof Date &&
    resolvedAt.getTime() < cutoff.getTime()
  );
}

function normalizedAssetIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

/**
 * Reduces verbose terminal tickets into the two facts that must survive their
 * deletion: quota usage and workflow completion gates.
 */
export function buildDeliveryTicketRetentionFacts(
  tickets: RetentionTicketRow[],
): DeliveryTicketRetentionFacts {
  const quotaByKey = new Map<
    string,
    DeliveryTicketRetentionFacts["quotaDeltas"][number]
  >();
  const milestoneByKey = new Map<
    string,
    DeliveryTicketRetentionFacts["milestones"][number]
  >();

  for (const ticket of tickets) {
    if (
      (ticket.quotaState === "reserved" || ticket.quotaState === "consumed") &&
      ticket.quotaPool
    ) {
      const key = `${ticket.quotaPeriodId}:${ticket.quotaPool}`;
      const current = quotaByKey.get(key) ?? {
        quotaPeriodId: ticket.quotaPeriodId,
        quotaPool: ticket.quotaPool,
        count: 0,
      };
      current.count += 1;
      quotaByKey.set(key, current);
    }
    if (
      ticket.status !== "completed" ||
      !ticket.operation ||
      !ticket.resolvedAt
    ) {
      continue;
    }
    const key = `${ticket.userId}:${ticket.operation}`;
    const current = milestoneByKey.get(key);
    const contentAssetIds = normalizedAssetIds(ticket.contentAssetIds);
    if (!current) {
      milestoneByKey.set(key, {
        userId: ticket.userId,
        operation: ticket.operation,
        contentAssetIds,
        completedAt: ticket.resolvedAt,
      });
      continue;
    }
    current.contentAssetIds = [
      ...new Set([...current.contentAssetIds, ...contentAssetIds]),
    ];
    if (ticket.resolvedAt.getTime() > current.completedAt.getTime()) {
      current.completedAt = ticket.resolvedAt;
    }
  }

  return {
    quotaDeltas: [...quotaByKey.values()].sort((left, right) =>
      `${left.quotaPeriodId}:${left.quotaPool}`.localeCompare(
        `${right.quotaPeriodId}:${right.quotaPool}`,
      ),
    ),
    milestones: [...milestoneByKey.values()].sort((left, right) =>
      `${left.userId}:${left.operation}`.localeCompare(
        `${right.userId}:${right.operation}`,
      ),
    ),
  };
}

const ticketSelection = {
  id: deliveryTickets.id,
  userId: deliveryTickets.userId,
  quotaPeriodId: deliveryTickets.quotaPeriodId,
  quotaPool: deliveryTickets.quotaPool,
  quotaState: deliveryTickets.quotaState,
  status: deliveryTickets.status,
  operation: deliveryTickets.operation,
  contentAssetIds: deliveryTickets.contentAssetIds,
  resolvedAt: deliveryTickets.resolvedAt,
  updatedAt: deliveryTickets.updatedAt,
};

function expiredTerminalTicketCondition(cutoff: Date) {
  return and(
    inArray(deliveryTickets.status, [...TERMINAL_TICKET_STATUSES]),
    or(
      and(
        isNotNull(deliveryTickets.resolvedAt),
        lt(deliveryTickets.resolvedAt, cutoff),
      ),
      and(
        isNull(deliveryTickets.resolvedAt),
        lt(deliveryTickets.updatedAt, cutoff),
      ),
    ),
  );
}

async function purgeDeliveryTicketBatch(input: {
  database: any;
  candidates: RetentionTicketRow[];
  cutoff: Date;
  now: Date;
}) {
  return input.database.transaction(async (tx: any) => {
    const lockedTicketRows = (await tx
      .select(ticketSelection)
      .from(deliveryTickets)
      .where(
        and(
          inArray(
            deliveryTickets.id,
            input.candidates.map((ticket) => ticket.id),
          ),
          expiredTerminalTicketCondition(input.cutoff),
        ),
      )
      .orderBy(asc(deliveryTickets.id))
      .for("update")) as RetentionTicketRow[];
    const lockedTickets = lockedTicketRows.map((ticket) => ({
      ...ticket,
      resolvedAt: ticket.resolvedAt ?? ticket.updatedAt,
    }));
    if (!lockedTickets.length) {
      return {
        tickets: 0,
        milestones: 0,
        quotaFacts: 0,
        styleBatches: 0,
        redirectPreviews: 0,
        resetRequests: 0,
      };
    }

    const lockedTicketIds = lockedTickets.map((ticket) => ticket.id);
    const periodIds = [
      ...new Set(lockedTickets.map((ticket) => ticket.quotaPeriodId)),
    ].sort();
    await tx
      .select({ id: serviceQuotaPeriods.id })
      .from(serviceQuotaPeriods)
      .where(inArray(serviceQuotaPeriods.id, periodIds))
      .orderBy(asc(serviceQuotaPeriods.id))
      .for("update");
    const resetRequests = await tx
      .select({
        id: knowledgeBaseResetRequests.id,
        ticketId: knowledgeBaseResetRequests.ticketId,
      })
      .from(knowledgeBaseResetRequests)
      .where(inArray(knowledgeBaseResetRequests.ticketId, lockedTicketIds))
      .orderBy(asc(knowledgeBaseResetRequests.id))
      .for("update");
    const eligibleTickets = lockedTickets.filter((ticket) =>
      isDeliveryTicketRetentionEligible(ticket, input.cutoff),
    );
    if (!eligibleTickets.length) {
      return {
        tickets: 0,
        milestones: 0,
        quotaFacts: 0,
        styleBatches: 0,
        redirectPreviews: 0,
        resetRequests: 0,
      };
    }

    const eligibleTicketIds = eligibleTickets.map((ticket) => ticket.id);
    const eligibleResetRequestIds = resetRequests
      .filter((request: any) => eligibleTicketIds.includes(request.ticketId))
      .map((request: any) => String(request.id));
    const facts = buildDeliveryTicketRetentionFacts(eligibleTickets);
    for (const delta of facts.quotaDeltas) {
      const column =
        delta.quotaPool === "content_asset_publish"
          ? serviceQuotaPeriods.archivedContentAssetPublishUsed
          : serviceQuotaPeriods.archivedWebsiteContentPublishUsed;
      await tx
        .update(serviceQuotaPeriods)
        .set({
          [delta.quotaPool === "content_asset_publish"
            ? "archivedContentAssetPublishUsed"
            : "archivedWebsiteContentPublishUsed"]:
            sql`${column} + ${delta.count}`,
          updatedAt: input.now,
        })
        .where(eq(serviceQuotaPeriods.id, delta.quotaPeriodId));
    }

    const milestoneUserIds = [
      ...new Set(facts.milestones.map((milestone) => milestone.userId)),
    ];
    const milestoneOperations = [
      ...new Set(facts.milestones.map((milestone) => milestone.operation)),
    ];
    const existingMilestones = facts.milestones.length
      ? await tx
          .select()
          .from(deliveryWorkflowMilestones)
          .where(
            and(
              inArray(deliveryWorkflowMilestones.userId, milestoneUserIds),
              inArray(
                deliveryWorkflowMilestones.operation,
                milestoneOperations,
              ),
            ),
          )
          .orderBy(
            asc(deliveryWorkflowMilestones.userId),
            asc(deliveryWorkflowMilestones.operation),
          )
          .for("update")
      : [];
    const existingMilestoneByKey = new Map<
      string,
      typeof deliveryWorkflowMilestones.$inferSelect
    >(
      existingMilestones.map((milestone: any) => [
        `${milestone.userId}:${milestone.operation}`,
        milestone,
      ]),
    );
    for (const milestone of facts.milestones) {
      const key = `${milestone.userId}:${milestone.operation}`;
      const existing = existingMilestoneByKey.get(key);
      const contentAssetIds = [
        ...new Set([
          ...normalizedAssetIds(existing?.contentAssetIds),
          ...milestone.contentAssetIds,
        ]),
      ];
      const completedAt =
        existing?.completedAt &&
        existing.completedAt.getTime() > milestone.completedAt.getTime()
          ? existing.completedAt
          : milestone.completedAt;
      if (existing) {
        await tx
          .update(deliveryWorkflowMilestones)
          .set({ contentAssetIds, completedAt, updatedAt: input.now })
          .where(eq(deliveryWorkflowMilestones.id, existing.id));
      } else {
        await tx.insert(deliveryWorkflowMilestones).values({
          id: randomUUID(),
          userId: milestone.userId,
          operation: milestone.operation,
          contentAssetIds,
          completedAt,
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
    }

    const styleBatches = await tx
      .select({ id: websiteStyleSampleBatches.id })
      .from(websiteStyleSampleBatches)
      .where(inArray(websiteStyleSampleBatches.ticketId, eligibleTicketIds))
      .orderBy(asc(websiteStyleSampleBatches.id))
      .for("update");
    const styleBatchIds = styleBatches.map((batch: any) => String(batch.id));
    if (styleBatchIds.length) {
      await tx
        .update(websiteStyleWorkflows)
        .set({
          status: sql`CASE WHEN ${websiteStyleWorkflows.status} IN ('confirmed', 'legacy_confirmed') THEN 'legacy_confirmed' ELSE 'waiting_samples' END`,
          currentBatchId: null,
          selectedSampleId: null,
          selectedByUserId: null,
          selectedAt: null,
          revision: sql`${websiteStyleWorkflows.revision} + 1`,
          updatedAt: input.now,
        })
        .where(inArray(websiteStyleWorkflows.currentBatchId, styleBatchIds));
      await tx
        .delete(websiteStyleSamples)
        .where(inArray(websiteStyleSamples.batchId, styleBatchIds));
      await tx
        .delete(websiteStyleSampleBatches)
        .where(inArray(websiteStyleSampleBatches.id, styleBatchIds));
    }

    await tx
      .update(knowledgeBaseSnapshots)
      .set({ maintenanceTicketId: null })
      .where(
        inArray(knowledgeBaseSnapshots.maintenanceTicketId, eligibleTicketIds),
      );
    const redirectResult = await tx
      .delete(deliveryRedirectPreviews)
      .where(
        inArray(deliveryRedirectPreviews.appliedTicketId, eligibleTicketIds),
      );
    const resetTombstones = eligibleResetRequestIds.length
      ? await tx
          .select({
            userId: knowledgeBaseConversationTombstones.userId,
            publicConversationId:
              knowledgeBaseConversationTombstones.publicConversationId,
            resetAt: knowledgeBaseConversationTombstones.createdAt,
          })
          .from(knowledgeBaseConversationTombstones)
          .where(
            inArray(
              knowledgeBaseConversationTombstones.resetRequestId,
              eligibleResetRequestIds,
            ),
          )
          .orderBy(asc(knowledgeBaseConversationTombstones.id))
          .for("update")
      : [];
    if (resetTombstones.length) {
      await tx
        .insert(knowledgeBaseConversationRetentionTombstones)
        .values(
          resetTombstones.map((tombstone: any) => ({
            id: randomUUID(),
            userId: tombstone.userId,
            publicConversationId: tombstone.publicConversationId,
            resetAt: tombstone.resetAt,
            createdAt: input.now,
          })),
        )
        .onDuplicateKeyUpdate({
          set: { id: sql`${knowledgeBaseConversationRetentionTombstones.id}` },
        });
    }
    if (eligibleResetRequestIds.length) {
      await tx
        .delete(knowledgeBaseResetCleanupJobs)
        .where(
          and(
            inArray(
              knowledgeBaseResetCleanupJobs.resetRequestId,
              eligibleResetRequestIds,
            ),
            eq(knowledgeBaseResetCleanupJobs.status, "completed"),
          ),
        );
    }
    const resetResult = eligibleResetRequestIds.length
      ? await tx
          .delete(knowledgeBaseResetRequests)
          .where(
            inArray(knowledgeBaseResetRequests.id, eligibleResetRequestIds),
          )
      : null;
    const ticketResult = await tx
      .delete(deliveryTickets)
      .where(inArray(deliveryTickets.id, eligibleTicketIds));

    return {
      tickets: deliveryTicketRetentionAffectedRows(ticketResult),
      milestones: facts.milestones.length,
      quotaFacts: facts.quotaDeltas.reduce(
        (sum, delta) => sum + delta.count,
        0,
      ),
      styleBatches: styleBatchIds.length,
      redirectPreviews: deliveryTicketRetentionAffectedRows(redirectResult),
      resetRequests: resetResult
        ? deliveryTicketRetentionAffectedRows(resetResult)
        : 0,
    };
  });
}

export async function cleanupExpiredDeliveryTickets(input?: {
  database?: any;
  retentionDays?: number;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}): Promise<DeliveryTicketRetentionResult> {
  const now = input?.now ?? new Date();
  const cutoff = getDeliveryTicketRetentionCutoff(
    input?.retentionDays ?? DEFAULT_DELIVERY_TICKET_RETENTION_DAYS,
    now,
  );
  const batchSize = positiveInteger(
    input?.batchSize ?? DEFAULT_DELIVERY_TICKET_RETENTION_BATCH_SIZE,
    "工单清理批大小",
  );
  const maxBatches = positiveInteger(
    input?.maxBatches ?? DEFAULT_DELIVERY_TICKET_RETENTION_MAX_BATCHES,
    "工单清理批次数",
  );
  const database = input?.database ?? (await getDb());
  const result: DeliveryTicketRetentionResult = {
    cutoff,
    batches: 0,
    tickets: 0,
    milestones: 0,
    quotaFacts: 0,
    styleBatches: 0,
    redirectPreviews: 0,
    resetRequests: 0,
  };
  if (!database) return result;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = (await database
      .select(ticketSelection)
      .from(deliveryTickets)
      .where(expiredTerminalTicketCondition(cutoff))
      .orderBy(
        asc(deliveryTickets.resolvedAt),
        asc(deliveryTickets.updatedAt),
        asc(deliveryTickets.id),
      )
      .limit(batchSize)) as RetentionTicketRow[];
    if (!candidates.length) break;
    const batchResult = await purgeDeliveryTicketBatch({
      database,
      candidates,
      cutoff,
      now,
    });
    result.batches += 1;
    result.tickets += batchResult.tickets;
    result.milestones += batchResult.milestones;
    result.quotaFacts += batchResult.quotaFacts;
    result.styleBatches += batchResult.styleBatches;
    result.redirectPreviews += batchResult.redirectPreviews;
    result.resetRequests += batchResult.resetRequests;
    if (candidates.length < batchSize) break;
  }
  return result;
}

type RetentionLockConnection = {
  query: (sql: string, values?: unknown[]) => Promise<[any, unknown]>;
  end: () => Promise<void>;
};

export async function runDeliveryTicketRetentionCleanup(input?: {
  databaseUrl?: string;
  createConnection?: (url: string) => Promise<RetentionLockConnection>;
  cleanup?: () => Promise<DeliveryTicketRetentionResult>;
}) {
  const databaseUrl =
    input?.databaseUrl ?? process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    return { acquired: false as const, result: null };
  }
  const createConnection =
    input?.createConnection ??
    ((url: string) =>
      mysql.createConnection(url) as Promise<RetentionLockConnection>);
  const connection = await createConnection(databaseUrl);
  let acquired = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [
      DELIVERY_TICKET_RETENTION_LOCK_NAME,
    ]);
    acquired = Number(rows?.[0]?.acquired ?? 0) === 1;
    if (!acquired) return { acquired: false as const, result: null };
    const result = await (input?.cleanup ?? cleanupExpiredDeliveryTickets)();
    return { acquired: true as const, result };
  } finally {
    if (acquired) {
      await connection
        .query("SELECT RELEASE_LOCK(?) AS released", [
          DELIVERY_TICKET_RETENTION_LOCK_NAME,
        ])
        .catch(() => undefined);
    }
    await connection.end();
  }
}

export function startDeliveryTicketRetentionScheduler(input?: {
  initialDelayMs?: number;
  intervalMs?: number;
  run?: typeof runDeliveryTicketRetentionCleanup;
}) {
  let running = false;
  const runCleanup = input?.run ?? runDeliveryTicketRetentionCleanup;
  const run = () => {
    if (running) return;
    running = true;
    runCleanup()
      .then((execution) => {
        if (!execution.acquired || !execution.result) return;
        console.info(
          "[Delivery ticket retention] Cleanup complete",
          JSON.stringify(execution.result),
        );
      })
      .catch((error) => {
        console.error(
          "[Delivery ticket retention] Cleanup failed",
          error instanceof Error ? error.message : "unknown error",
        );
      })
      .finally(() => {
        running = false;
      });
  };
  const initial = setTimeout(run, input?.initialDelayMs ?? 60_000);
  initial.unref?.();
  const interval = setInterval(
    run,
    input?.intervalMs ?? DELIVERY_TICKET_RETENTION_INTERVAL_MS,
  );
  interval.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
