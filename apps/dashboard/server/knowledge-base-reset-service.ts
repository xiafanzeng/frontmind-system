import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  attachments,
  conversations,
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  knowledgeBaseBuilds,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetCleanupJobs,
  knowledgeBaseResetRequests,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
  upstreamResources,
  users,
} from "../drizzle/schema";
import type { KnowledgeResetReason } from "../shared/delivery-roles";
import {
  AuthServiceError,
  discardManagedUploadProviderFileForRetirement,
  getCredentialForUpstreamResource,
  type AuthenticatedUser,
} from "./auth-service";
import { getDb } from "./db";
import { knowledgeBaseWritesAreEmergencyBlocked } from "./knowledge-base-runtime-guard";
import {
  optionalKnowledgeBaseUploadEvidenceStorageKey,
  parseKnowledgeBaseUploadEvidenceStorageKey,
  removeKnowledgeBaseUploadEvidenceIfOrphaned,
} from "./knowledge-base-upload-evidence-lifecycle";
import { markKnowledgeBaseBuildSourcesTerminal } from "./knowledge-base-local-source-lifecycle";
import { retireManagedUploadIntentsForKnowledgeBaseReset } from "./managed-upload-intent-fence";
import {
  assertDeliveryProjectContext,
  deliveryExecutionActorRole,
} from "./delivery-role-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  getServicePortal,
  resolveCurrentServiceQuotaScope,
} from "./service-entitlement";
import { getUpstreamBaseUrl } from "./upstream-config";
import { knowledgeSnapshotArchiveStorageKey } from "./knowledge-snapshot-archive-store";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";

const ACTIVE_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;
const dashboardAssetRoot = path.resolve(
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
    path.join(process.cwd(), ".frontmind-dashboard-assets"),
);

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function persistedConversationId(userId: number, publicId: string) {
  return `u${userId}:${publicId}`;
}

type KnowledgeCounts = {
  builds: Array<{
    id: string;
    generation: number;
    conversationId: string;
    upstreamTaskId: string | null;
    logoStorageKey: string | null;
    packageStorageKey: string | null;
  }>;
  snapshots: Array<{
    id: string;
    sourceConversationId: string | null;
    assets: Array<{ key: string }>;
  }>;
  receipts: Array<{
    id: string;
    taskId: string | null;
    fileId: string | null;
  }>;
  hasKnowledge: boolean;
};

export function knowledgeSnapshotCleanupStorageKeys(
  userId: number,
  snapshots: KnowledgeCounts["snapshots"],
  builds: KnowledgeCounts["builds"] = [],
) {
  return Array.from(
    new Set(
      [
        ...snapshots.flatMap((snapshot) => [
          ...snapshot.assets.map((asset) => asset.key).filter(Boolean),
          knowledgeSnapshotArchiveStorageKey(userId, snapshot.id),
        ]),
        ...builds.flatMap((build) => [
          build.logoStorageKey,
          build.packageStorageKey,
          optionalKnowledgeBaseUploadEvidenceStorageKey({
            userId,
            buildId: build.id,
            generation: build.generation,
          }),
        ]),
      ].filter((key): key is string => Boolean(key)),
    ),
  );
}

export function prepareKnowledgeResetCleanupResource(resource: {
  kind: "task" | "file" | "local_asset";
  upstreamId: string;
  apiCredentialId: string | null;
}) {
  if (resource.kind !== "local_asset") {
    return { ...resource, localAssetKey: null };
  }
  return {
    ...resource,
    upstreamId: createHash("sha256").update(resource.upstreamId).digest("hex"),
    localAssetKey: resource.upstreamId,
  };
}

async function getKnowledgeCounts(
  executor: any,
  userId: number,
): Promise<KnowledgeCounts> {
  const [builds, snapshots, receipts] = await Promise.all([
    executor
      .select({
        id: knowledgeBaseBuilds.id,
        generation: knowledgeBaseBuilds.generation,
        conversationId: knowledgeBaseBuilds.conversationId,
        upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
        logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
        packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
      })
      .from(knowledgeBaseBuilds)
      .where(eq(knowledgeBaseBuilds.userId, userId)),
    executor
      .select({
        id: knowledgeBaseSnapshots.id,
        sourceConversationId: knowledgeBaseSnapshots.sourceConversationId,
        assets: knowledgeBaseSnapshots.assets,
      })
      .from(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, userId)),
    executor
      .select({
        id: knowledgeImportReceipts.id,
        taskId: knowledgeImportReceipts.taskId,
        fileId: knowledgeImportReceipts.fileId,
      })
      .from(knowledgeImportReceipts)
      .where(eq(knowledgeImportReceipts.userId, userId)),
  ]);
  return {
    builds,
    snapshots,
    receipts,
    hasKnowledge:
      builds.length > 0 || snapshots.length > 0 || receipts.length > 0,
  };
}

async function getKnowledgeOwner(
  executor: any,
  userId: number,
  options: { forUpdate?: boolean } = {},
) {
  const query = executor
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      memberId: deliveryProjectAssignments.engineerUserId,
      memberName: users.displayName,
      memberUsername: users.username,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, userId),
        eq(deliveryProjectAssignments.roleType, "ai_operations_engineer"),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, "ai_operations_engineer"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const rows = options.forUpdate ? await query.for("update") : await query;
  return rows[0] ?? null;
}

export async function getKnowledgeResetStatus(userId: number) {
  const db = await requireDb();
  const [counts, owner, resetRows, stateRows, portal] = await Promise.all([
    getKnowledgeCounts(db, userId),
    getKnowledgeOwner(db, userId),
    db
      .select({
        id: knowledgeBaseResetRequests.id,
        ticketId: knowledgeBaseResetRequests.ticketId,
        status: knowledgeBaseResetRequests.status,
        reasonCode: knowledgeBaseResetRequests.reasonCode,
        reasonNote: knowledgeBaseResetRequests.reasonNote,
        createdAt: knowledgeBaseResetRequests.createdAt,
        assignedMemberId: knowledgeBaseResetRequests.assignedMemberId,
      })
      .from(knowledgeBaseResetRequests)
      .where(
        and(
          eq(knowledgeBaseResetRequests.userId, userId),
          eq(knowledgeBaseResetRequests.status, "pending"),
        ),
      )
      .orderBy(desc(knowledgeBaseResetRequests.createdAt))
      .limit(1),
    db
      .select({ revision: knowledgeBaseResetStates.revision })
      .from(knowledgeBaseResetStates)
      .where(eq(knowledgeBaseResetStates.userId, userId))
      .limit(1),
    getServicePortal(userId),
  ]);
  const aiOperationsIncluded =
    portal.service.planCode === "advanced" ||
    portal.service.planCode === "luxury";
  const pending = resetRows[0] ?? null;
  let pendingEngineerName = owner?.memberName || owner?.memberUsername || null;
  if (
    pending?.assignedMemberId != null &&
    pending.assignedMemberId !== owner?.memberId
  ) {
    const assignedRows = await db
      .select({
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, pending.assignedMemberId))
      .limit(1);
    pendingEngineerName =
      assignedRows[0]?.displayName || assignedRows[0]?.username || null;
  }
  return {
    revision: stateRows[0]?.revision ?? 0,
    hasKnowledge: counts.hasKnowledge,
    locked: Boolean(pending),
    canRequest:
      aiOperationsIncluded && counts.hasKnowledge && Boolean(owner) && !pending,
    unavailableReason: !aiOperationsIncluded
      ? "当前套餐不含人工知识库运维"
      : !owner
        ? "尚未分配 AI 运维工程师，请联系交付管理员"
        : pending
          ? "已有一张知识库重置需求正在处理"
          : !counts.hasKnowledge
            ? "当前没有可重置的知识库记录"
            : null,
    engineer: owner
      ? {
          id: owner.memberId,
          name:
            owner.memberName ||
            owner.memberUsername ||
            `成员 ${owner.memberId}`,
        }
      : null,
    pending: pending
      ? {
          ...pending,
          createdAt: pending.createdAt.getTime(),
          engineerName:
            pendingEngineerName ||
            (pending.assignedMemberId
              ? `工程师 ${pending.assignedMemberId}`
              : "原工程师账号已删除"),
        }
      : null,
  };
}

export async function assertKnowledgeBaseWritable(userId: number) {
  const emergencyBlock = knowledgeBaseWritesAreEmergencyBlocked();
  if (emergencyBlock) {
    throw new AuthServiceError(
      "CONFLICT",
      "知识库写入已因状态不变量告警临时关闭，请稍后重试",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select({ id: knowledgeBaseResetRequests.id })
    .from(knowledgeBaseResetRequests)
    .where(
      and(
        eq(knowledgeBaseResetRequests.userId, userId),
        eq(knowledgeBaseResetRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (rows[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "知识库重置需求正在审批，当前知识库已只读锁定",
    );
  }
}

export async function submitKnowledgeReset(input: {
  actor: AuthenticatedUser;
  reasonCode: KnowledgeResetReason;
  reasonNote?: string;
}) {
  if (input.actor.role !== "user") {
    throw new AuthServiceError("INVALID_CREDENTIAL", "只有客户可以申请重置");
  }
  if (input.reasonCode === "other" && !input.reasonNote?.trim()) {
    throw new AuthServiceError("CONFLICT", "选择“其他”时必须填写补充说明");
  }
  const portal = await getServicePortal(input.actor.id);
  if (
    portal.service.planCode !== "advanced" &&
    portal.service.planCode !== "luxury"
  ) {
    throw new AuthServiceError("CONFLICT", "当前套餐不含人工知识库运维");
  }
  const db = await requireDb();
  try {
    return await db.transaction(async (tx) => {
      const [counts, owner, existing, currentScope] = await Promise.all([
        getKnowledgeCounts(tx, input.actor.id),
        getKnowledgeOwner(tx, input.actor.id, { forUpdate: true }),
        tx
          .select({ id: knowledgeBaseResetRequests.id })
          .from(knowledgeBaseResetRequests)
          .where(
            and(
              eq(knowledgeBaseResetRequests.userId, input.actor.id),
              eq(knowledgeBaseResetRequests.status, "pending"),
            ),
          )
          .limit(1)
          .for("update"),
        resolveCurrentServiceQuotaScope({
          executor: tx,
          userId: input.actor.id,
        }),
      ]);
      if (!counts.hasKnowledge) {
        throw new AuthServiceError("CONFLICT", "当前没有可重置的知识库记录");
      }
      if (!owner) {
        throw new AuthServiceError(
          "CONFLICT",
          "尚未分配 AI 运维工程师，请联系交付管理员",
        );
      }
      if (existing[0]) {
        throw new AuthServiceError("CONFLICT", "已有一张重置需求正在处理");
      }
      if (!currentScope) {
        throw new AuthServiceError(
          "CONFLICT",
          "客户服务周期尚未配置，请联系交付管理员",
        );
      }
      const { contract, period } = currentScope;
      const requestId = randomUUID();
      const ticketId = randomUUID();
      const now = new Date();
      await tx.insert(deliveryTickets).values({
        id: ticketId,
        userId: input.actor.id,
        contractId: contract.id,
        quotaPeriodId: period.id,
        type: "knowledge_base",
        quotaPool: null,
        ordinal: 0,
        clientRequestId: requestId,
        category: "knowledge_reset",
        title: "知识库重置申请",
        description: input.reasonNote?.trim() || null,
        workflowDomain: "ai_operations_engineer",
        operation: "knowledge_reset",
        assignedProjectAssignmentId: owner.projectAssignmentId,
        assignedMemberId: owner.memberId,
        quotaState: "consumed",
        status: "submitted",
        createdByUserId: input.actor.id,
        updatedByUserId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(knowledgeBaseResetRequests).values({
        id: requestId,
        ticketId,
        userId: input.actor.id,
        assignedProjectAssignmentId: owner.projectAssignmentId,
        assignedMemberId: owner.memberId,
        activeKey: `user:${input.actor.id}`,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote?.trim() || null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId,
        userId: input.actor.id,
        actorUserId: input.actor.id,
        actorRole: "user",
        kind: "created",
        visibility: "customer",
        message: "客户提交知识库重置申请，知识库已进入只读锁定。",
        toStatus: "submitted",
        createdAt: now,
      });
      return { id: requestId, ticketId };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "已有一张重置需求正在处理");
    }
    throw error;
  }
}

async function requirePendingRequestForMember(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  requestId: string;
  executor: any;
}) {
  const actorRole = deliveryExecutionActorRole(input.actor);
  if (!actorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要工程师或系统管理员权限",
    );
  }
  const systemAdmin = actorRole === "admin";
  const rows = await input.executor
    .select({
      request: knowledgeBaseResetRequests,
      ticket: deliveryTickets,
    })
    .from(knowledgeBaseResetRequests)
    .innerJoin(
      deliveryTickets,
      eq(knowledgeBaseResetRequests.ticketId, deliveryTickets.id),
    )
    .where(eq(knowledgeBaseResetRequests.id, input.requestId))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (
    !row ||
    row.request.status !== "pending" ||
    row.ticket.status !== "submitted" ||
    row.ticket.operation !== "knowledge_reset" ||
    row.ticket.workflowDomain !== "ai_operations_engineer" ||
    row.ticket.userId !== row.request.userId ||
    row.ticket.assignedProjectAssignmentId !==
      row.request.assignedProjectAssignmentId ||
    row.ticket.assignedProjectAssignmentId !== input.projectAssignmentId ||
    (!systemAdmin &&
      (row.request.assignedMemberId !== input.actor.id ||
        row.ticket.assignedMemberId !== input.actor.id))
  ) {
    throw new AuthServiceError("NOT_FOUND", "待审批重置需求不存在");
  }
  const role = await assertDeliveryProjectContext({
    actor: input.actor,
    projectAssignmentId: input.projectAssignmentId,
    customerUserId: row.request.userId,
    expectedRoleType: "ai_operations_engineer",
    executor: input.executor,
  });
  if (role.projectAssignmentId !== row.request.assignedProjectAssignmentId) {
    throw new AuthServiceError("NOT_FOUND", "需求不属于当前客户项目岗位");
  }
  return {
    ...row,
    ticketRevision: row.ticket.revision,
    role,
    eventActorRole: actorRole,
    systemAdmin,
  };
}

export async function previewKnowledgeReset(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  requestId: string;
}) {
  const db = await requireDb();
  const row = await requirePendingRequestForMember({
    ...input,
    executor: db,
  });
  const counts = await getKnowledgeCounts(db, row.request.userId);
  const publicConversationIds = Array.from(
    new Set(
      [
        ...counts.builds.map((build) => build.conversationId),
        ...counts.snapshots.map((snapshot) => snapshot.sourceConversationId),
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const storedIds = publicConversationIds.map((id) =>
    persistedConversationId(row.request.userId, id),
  );
  const [conversationRows, attachmentRows] = await Promise.all([
    storedIds.length
      ? db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, row.request.userId),
              inArray(conversations.id, storedIds),
            ),
          )
      : [],
    storedIds.length
      ? db
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.userId, row.request.userId),
              inArray(attachments.conversationId, storedIds),
            ),
          )
      : [],
  ]);
  return {
    request: {
      id: row.request.id,
      ticketId: row.request.ticketId,
      userId: row.request.userId,
      reasonCode: row.request.reasonCode,
      reasonNote: row.request.reasonNote,
      createdAt: row.request.createdAt.getTime(),
    },
    expectedRevision: row.ticketRevision,
    cleanup: {
      builds: counts.builds.length,
      snapshots: counts.snapshots.length,
      conversations: conversationRows.length,
      attachments: attachmentRows.length,
      importReceipts: counts.receipts.length,
    },
  };
}

export async function decideKnowledgeReset(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  requestId: string;
  expectedRevision: number;
  decision: "approve" | "reject";
  decisionNote?: string;
}) {
  if (input.decision === "reject" && !input.decisionNote?.trim()) {
    throw new AuthServiceError("CONFLICT", "驳回时必须填写原因");
  }
  const db = await requireDb();
  // Populated only by the transaction that actually deletes these builds.
  // Marker failures are fail-closed (retained bytes leak rather than delete).
  let resetBuildSourceScopes: Array<{
    userId: number;
    buildId: string;
    terminalAt: Date;
  }> = [];
  let resetConversationIds: string[] = [];
  let resetUserId: number | null = null;
  const result = await db.transaction(async (tx) => {
    const row = await requirePendingRequestForMember({
      ...input,
      executor: tx,
    });
    if (row.ticketRevision !== input.expectedRevision) {
      throw new AuthServiceError(
        "CONFLICT",
        "需求已被更新，请刷新清理预览后重试",
      );
    }
    const now = new Date();
    if (input.decision === "reject") {
      const publicSummary = `知识库重置申请未通过：${input.decisionNote!.trim()}`;
      await tx
        .update(knowledgeBaseResetRequests)
        .set({
          status: "rejected",
          activeKey: null,
          decisionNote: input.decisionNote!.trim(),
          decidedByUserId: input.actor.id,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(knowledgeBaseResetRequests.id, row.request.id));
      await tx
        .update(deliveryTickets)
        .set({
          status: "rejected",
          publicSummary,
          resolvedAt: now,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(deliveryTickets.id, row.request.ticketId));
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: row.request.ticketId,
        userId: row.request.userId,
        actorUserId: input.actor.id,
        actorRole: row.eventActorRole,
        kind: "status_change",
        visibility: "customer",
        message: publicSummary,
        fromStatus: "submitted",
        toStatus: "rejected",
        actorContext: {
          projectAssignmentId: input.projectAssignmentId,
          customerUserId: row.role.customerUserId,
          roleType: row.role.roleType,
        },
        createdAt: now,
      });
      if (row.systemAdmin) {
        await writeWorkspaceAuditEvent(
          {
            actor: input.actor,
            action: "delivery_ticket.system_admin_override",
            targetType: "delivery_ticket",
            targetId: row.request.ticketId,
            workspaceUserId: row.request.userId,
            metadata: {
              command: "decide_knowledge_reset",
              decision: "reject",
              requestId: row.request.id,
              projectAssignmentId: row.request.assignedProjectAssignmentId,
              workflowDomain: row.ticket.workflowDomain,
              assignedMemberId: row.ticket.assignedMemberId,
              fromStatus: row.ticket.status,
              toStatus: "rejected",
              fromRevision: row.ticket.revision,
              toRevision: row.ticket.revision + 1,
            },
            now,
          },
          tx,
        );
      }
      return { decision: "rejected" as const, cleanup: null };
    }

    // Serialize approval with every new start/upload path before reading or
    // deleting knowledge-base state. A delayed browser request holding the old
    // revision either commits before this lock (and is deleted below) or waits
    // and observes the incremented revision; it cannot recreate the old build
    // after cleanup.
    await tx
      .insert(knowledgeBaseResetStates)
      .values({
        userId: row.request.userId,
        revision: 0,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { userId: row.request.userId },
      });
    const lockedResetState = (
      await tx
        .select({ revision: knowledgeBaseResetStates.revision })
        .from(knowledgeBaseResetStates)
        .where(eq(knowledgeBaseResetStates.userId, row.request.userId))
        .limit(1)
        .for("update")
    )[0];
    if (!lockedResetState) {
      throw new AuthServiceError("CONFLICT", "知识库重置状态不可用，请重试");
    }
    const nextResetRevision = lockedResetState.revision + 1;
    resetUserId = row.request.userId;

    const counts = await getKnowledgeCounts(tx, row.request.userId);
    resetBuildSourceScopes = counts.builds.map((build) => ({
      userId: row.request.userId,
      buildId: build.id,
      terminalAt: now,
    }));
    const publicConversationIds = Array.from(
      new Set(
        [
          ...counts.builds.map((build) => build.conversationId),
          ...counts.snapshots.map((snapshot) => snapshot.sourceConversationId),
        ].filter((id): id is string => Boolean(id)),
      ),
    );
    resetConversationIds = publicConversationIds;
    const storedIds = publicConversationIds.map((id) =>
      persistedConversationId(row.request.userId, id),
    );
    const buildTaskIds = counts.builds
      .map((build) => build.upstreamTaskId)
      .filter((id): id is string => Boolean(id));
    const receiptTaskIds = counts.receipts
      .map((receipt) => receipt.taskId)
      .filter((id): id is string => Boolean(id));
    const receiptFileIds = counts.receipts
      .map((receipt) => receipt.fileId)
      .filter((id): id is string => Boolean(id));
    const receiptResourceIds = [...receiptTaskIds, ...receiptFileIds];
    const localAssetKeys = knowledgeSnapshotCleanupStorageKeys(
      row.request.userId,
      counts.snapshots,
      counts.builds,
    );
    const [conversationRows, attachmentRows, resourceRows] = await Promise.all([
      storedIds.length
        ? tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.userId, row.request.userId),
                inArray(conversations.id, storedIds),
              ),
            )
        : [],
      storedIds.length
        ? tx
            .select({ id: attachments.id })
            .from(attachments)
            .where(
              and(
                eq(attachments.userId, row.request.userId),
                inArray(attachments.conversationId, storedIds),
              ),
            )
        : [],
      tx
        .select({
          kind: upstreamResources.kind,
          upstreamId: upstreamResources.upstreamId,
          apiCredentialId: upstreamResources.apiCredentialId,
        })
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.userId, row.request.userId),
            or(
              storedIds.length
                ? inArray(upstreamResources.conversationId, storedIds)
                : sql`false`,
              buildTaskIds.length
                ? inArray(upstreamResources.upstreamId, buildTaskIds)
                : sql`false`,
              receiptResourceIds.length
                ? inArray(upstreamResources.upstreamId, receiptResourceIds)
                : sql`false`,
            ),
          ),
        ),
    ]);
    const cleanup = {
      builds: counts.builds.length,
      snapshots: counts.snapshots.length,
      conversations: conversationRows.length,
      attachments: attachmentRows.length,
      importReceipts: counts.receipts.length,
    };

    if (publicConversationIds.length) {
      await tx
        .insert(knowledgeBaseConversationTombstones)
        .values(
          publicConversationIds.map((publicId) => ({
            id: randomUUID(),
            userId: row.request.userId,
            publicConversationId: publicId,
            resetRequestId: row.request.id,
            createdAt: now,
          })),
        )
        .onDuplicateKeyUpdate({ set: { resetRequestId: row.request.id } });
    }
    const cleanupResources = new Map<
      string,
      {
        kind: "task" | "file" | "local_asset";
        upstreamId: string;
        apiCredentialId: string | null;
      }
    >();
    for (const resource of resourceRows) {
      cleanupResources.set(`${resource.kind}:${resource.upstreamId}`, resource);
    }
    for (const upstreamId of receiptTaskIds) {
      const key = `task:${upstreamId}`;
      if (!cleanupResources.has(key)) {
        cleanupResources.set(key, {
          kind: "task",
          upstreamId,
          apiCredentialId: null,
        });
      }
    }
    for (const upstreamId of receiptFileIds) {
      const key = `file:${upstreamId}`;
      if (!cleanupResources.has(key)) {
        cleanupResources.set(key, {
          kind: "file",
          upstreamId,
          apiCredentialId: null,
        });
      }
    }
    for (const assetKey of localAssetKeys) {
      cleanupResources.set(`local_asset:${assetKey}`, {
        kind: "local_asset",
        upstreamId: assetKey,
        apiCredentialId: null,
      });
    }
    if (cleanupResources.size) {
      await tx
        .insert(knowledgeBaseResetCleanupJobs)
        .values(
          [...cleanupResources.values()].map((resource) => ({
            ...prepareKnowledgeResetCleanupResource(resource),
            id: randomUUID(),
            resetRequestId: row.request.id,
            userId: row.request.userId,
            status: "pending" as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
    }
    await tx
      .update(knowledgeBaseBuilds)
      .set({ publishedSnapshotId: null })
      .where(eq(knowledgeBaseBuilds.userId, row.request.userId));
    await tx
      .delete(knowledgeImportReceipts)
      .where(eq(knowledgeImportReceipts.userId, row.request.userId));
    await tx
      .delete(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, row.request.userId));
    await tx
      .delete(knowledgeBaseBuilds)
      .where(eq(knowledgeBaseBuilds.userId, row.request.userId));
    if (storedIds.length) {
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.userId, row.request.userId),
            inArray(conversations.id, storedIds),
          ),
        );
    }
    await tx
      .update(knowledgeBaseResetStates)
      .set({ revision: nextResetRevision, updatedAt: now })
      .where(
        and(
          eq(knowledgeBaseResetStates.userId, row.request.userId),
          eq(knowledgeBaseResetStates.revision, lockedResetState.revision),
        ),
      );
    await tx
      .update(knowledgeBaseResetRequests)
      .set({
        status: "approved",
        activeKey: null,
        decisionNote: input.decisionNote?.trim() || null,
        decidedByUserId: input.actor.id,
        cleanupSummary: cleanup,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(knowledgeBaseResetRequests.id, row.request.id));
    await tx
      .update(deliveryTickets)
      .set({
        status: "completed",
        publicSummary:
          "知识库重置申请已通过，知识库已清空，可以重新开始首次构建。",
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, row.request.ticketId));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: row.request.ticketId,
      userId: row.request.userId,
      actorUserId: input.actor.id,
      actorRole: row.eventActorRole,
      kind: "status_change",
      visibility: "customer",
      message: "知识库重置已批准并完成清理，可以重新开始首次构建。",
      fromStatus: "submitted",
      toStatus: "completed",
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: row.role.customerUserId,
        roleType: row.role.roleType,
      },
      createdAt: now,
    });
    if (row.systemAdmin) {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery_ticket.system_admin_override",
          targetType: "delivery_ticket",
          targetId: row.request.ticketId,
          workspaceUserId: row.request.userId,
          metadata: {
            command: "decide_knowledge_reset",
            decision: "approve",
            requestId: row.request.id,
            projectAssignmentId: row.request.assignedProjectAssignmentId,
            workflowDomain: row.ticket.workflowDomain,
            assignedMemberId: row.ticket.assignedMemberId,
            fromStatus: row.ticket.status,
            toStatus: "completed",
            fromRevision: row.ticket.revision,
            toRevision: row.ticket.revision + 1,
          },
          now,
        },
        tx,
      );
    }
    return { decision: "approved" as const, cleanup };
  });
  if (result.decision === "approved") {
    await Promise.allSettled(
      resetBuildSourceScopes.map((scope) =>
        markKnowledgeBaseBuildSourcesTerminal({
          ...scope,
          reason: "reset",
        }),
      ),
    );
    if (resetUserId !== null) {
      await retireManagedUploadIntentsForKnowledgeBaseReset({
        userId: resetUserId,
        conversationIds: resetConversationIds,
        discardProviderFile: discardManagedUploadProviderFileForRetirement,
      }).catch(() => undefined);
    }
    void processKnowledgeResetCleanupJobs();
  }
  return result;
}

export function shouldDeleteKnowledgeResetUpstreamResource(
  kind: "task" | "file",
) {
  return kind === "file";
}

export async function processKnowledgeResetCleanupJobs() {
  const db = await requireDb();
  const retryCappedFailureBefore = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1_000,
  );
  const jobs = await db
    .select()
    .from(knowledgeBaseResetCleanupJobs)
    .where(
      or(
        eq(knowledgeBaseResetCleanupJobs.status, "pending"),
        and(
          eq(knowledgeBaseResetCleanupJobs.status, "failed"),
          or(
            lt(knowledgeBaseResetCleanupJobs.attemptCount, 5),
            lt(
              knowledgeBaseResetCleanupJobs.updatedAt,
              retryCappedFailureBefore,
            ),
          ),
        ),
      ),
    )
    .orderBy(knowledgeBaseResetCleanupJobs.createdAt)
    .limit(50);
  for (const job of jobs) {
    try {
      if (job.kind === "local_asset") {
        const localAssetKey = job.localAssetKey || job.upstreamId;
        if (parseKnowledgeBaseUploadEvidenceStorageKey(localAssetKey)) {
          const removal = await removeKnowledgeBaseUploadEvidenceIfOrphaned({
            storageKey: localAssetKey,
            expectedUserId: job.userId,
            db,
            assetRoot: dashboardAssetRoot,
          });
          if (removal === "active") {
            throw new Error("活跃知识库构建仍引用上传证据目录");
          }
        } else {
          const assetPath = path.resolve(dashboardAssetRoot, localAssetKey);
          if (!assetPath.startsWith(`${dashboardAssetRoot}${path.sep}`)) {
            throw new Error("知识库本地资源路径无效");
          }
          try {
            await unlink(assetPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } else if (shouldDeleteKnowledgeResetUpstreamResource(job.kind)) {
        const credential = await getCredentialForUpstreamResource(
          job.userId,
          job.kind,
          job.upstreamId,
        );
        if (!credential) throw new Error("上游资源凭据已不可用");
        try {
          await new ManusV2Client({
            baseUrl: getUpstreamBaseUrl(),
            apiKey: credential.apiKey,
          }).deleteFile(job.upstreamId);
        } catch (error) {
          if (!(error instanceof ManusV2ApiError && error.status === 404)) {
            throw error;
          }
        }
      }
      await db.transaction(async (tx) => {
        // Task ownership is part of the permanent usage proof chain. Resetting
        // the knowledge-base hides business data but never removes this fact.
        if (job.kind === "file") {
          await tx
            .delete(upstreamResources)
            .where(
              and(
                eq(upstreamResources.userId, job.userId),
                eq(upstreamResources.kind, job.kind),
                eq(upstreamResources.upstreamId, job.upstreamId),
              ),
            );
        }
        await tx
          .delete(knowledgeBaseResetCleanupJobs)
          .where(eq(knowledgeBaseResetCleanupJobs.id, job.id));
      });
    } catch (error) {
      await db
        .update(knowledgeBaseResetCleanupJobs)
        .set({
          status: "failed",
          attemptCount: sql`${knowledgeBaseResetCleanupJobs.attemptCount} + 1`,
          lastError:
            error instanceof Error ? error.message.slice(0, 2_000) : "删除失败",
          updatedAt: new Date(),
        })
        .where(eq(knowledgeBaseResetCleanupJobs.id, job.id));
    }
  }
  return { processed: jobs.length };
}
