import { lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { runWithStoredEnterpriseProjectScope } from "./enterprise-project-recovery";
import { enterpriseWorkspaceUserId, getEnterpriseProjectScope } from "./enterprise-project-context";
import { enterpriseConversationStoragePrefix } from "./enterprise-conversation-storage";
import { enterpriseResetStateTable, enterpriseResetStateOwnerPredicate } from "./enterprise-project-state-tables";
import { enterpriseOwnerPredicate } from "./enterprise-project-scope";
import { createCredentialAgentClient } from "./credential-agent-client";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  attachments,
  conversations,
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseResetCleanupJobs,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
  localAssets,
  upstreamResources,
  workspaceAuditEvents,
} from "../drizzle/schema";
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
import { knowledgeSnapshotArchiveStorageKey } from "./knowledge-snapshot-archive-store";
import { ManusV2ApiError } from "./manus-v2-client";

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
  return `${enterpriseConversationStoragePrefix(userId)}${publicId}`;
}

type KnowledgeCounts = {
  builds: Array<{
    id: string;
    generation: number;
    conversationId: string;
    upstreamTaskId: string | null;
    logoStorageKey: string | null;
    packageStorageKey: string | null;
    executionMode?: string | null;
  }>;
  snapshots: Array<{
    id: string;
    sourceConversationId: string | null;
    status?: "active" | "archived";
    assets: Array<{ key: string }>;
  }>;
  receipts: Array<{
    id: string;
    taskId: string | null;
    fileId: string | null;
    errorCode?: string | null;
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
  lockSnapshots = false,
): Promise<KnowledgeCounts> {
  const snapshotQuery = executor
    .select({
      id: knowledgeBaseSnapshots.id,
      sourceConversationId: knowledgeBaseSnapshots.sourceConversationId,
      status: knowledgeBaseSnapshots.status,
      assets: knowledgeBaseSnapshots.assets,
    })
    .from(knowledgeBaseSnapshots)
    .where(enterpriseOwnerPredicate(knowledgeBaseSnapshots, userId));
  const [builds, snapshots, receipts] = await Promise.all([
    executor
      .select({
        id: knowledgeBaseBuilds.id,
        generation: knowledgeBaseBuilds.generation,
        conversationId: knowledgeBaseBuilds.conversationId,
        upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
        logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
        packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
        executionMode: knowledgeBaseBuilds.executionMode,
      })
      .from(knowledgeBaseBuilds)
      .where(enterpriseOwnerPredicate(knowledgeBaseBuilds, userId)),
    lockSnapshots ? snapshotQuery.for("update") : snapshotQuery,
    executor
      .select({
        id: knowledgeImportReceipts.id,
        taskId: knowledgeImportReceipts.taskId,
        fileId: knowledgeImportReceipts.fileId,
        errorCode: knowledgeImportReceipts.errorCode,
      })
      .from(knowledgeImportReceipts)
      .where(enterpriseOwnerPredicate(knowledgeImportReceipts, userId)),
  ]);
  // Approved reset keeps the old evidence immutable but removes it from the
  // customer's active workspace. Archived history alone must not offer reset.
  const activeBuilds = builds.filter(
    (build: KnowledgeCounts["builds"][number]) => build.executionMode !== "reset_retired",
  );
  const activeSnapshots = snapshots.filter(
    (snapshot: KnowledgeCounts["snapshots"][number]) => snapshot.status !== "archived",
  );
  const activeReceipts = receipts.filter(
    (receipt: KnowledgeCounts["receipts"][number]) => receipt.errorCode !== "RESET_COMPLETED",
  );
  return {
    builds: activeBuilds,
    snapshots: activeSnapshots,
    receipts: activeReceipts,
    hasKnowledge: activeBuilds.length > 0 || activeSnapshots.length > 0 || activeReceipts.length > 0,
  };
}

/** Recheck references at cleanup time, including archived immutable snapshots. */
export async function removeKnowledgeResetLocalAssetIfOrphaned(input: {
  storageKey: string;
  db: any;
  assetRoot?: string;
}): Promise<"removed" | "referenced"> {
  const assetRoot = path.resolve(input.assetRoot || dashboardAssetRoot);
  const assetPath = path.resolve(assetRoot, input.storageKey);
  if (!assetPath.startsWith(`${assetRoot}${path.sep}`)) {
    throw new Error("知识库本地资源路径无效");
  }
  return input.db.transaction(async (tx: any) => {
    const references = await Promise.all([
      tx
        .select({ id: knowledgeBaseSnapshots.id })
        .from(knowledgeBaseSnapshots)
        .where(
          or(
            sql`JSON_CONTAINS(${knowledgeBaseSnapshots.assets}, ${JSON.stringify([{ key: input.storageKey }])})`,
            sql`CONCAT('knowledge-archives/', ${knowledgeBaseSnapshots.userId}, '/', ${knowledgeBaseSnapshots.id}, '.zip') = ${input.storageKey}`,
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select({ id: knowledgeBaseBuilds.id })
        .from(knowledgeBaseBuilds)
        .where(
          or(
            eq(knowledgeBaseBuilds.logoStorageKey, input.storageKey),
            eq(knowledgeBaseBuilds.packageStorageKey, input.storageKey),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select({ id: localAssets.id })
        .from(localAssets)
        .where(eq(localAssets.storageKey, input.storageKey))
        .limit(1)
        .for("update"),
    ]);
    if (references.some((rows) => rows.length > 0)) return "referenced";
    try {
      await unlink(assetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return "removed";
  });
}

export async function getKnowledgeResetStatus(userId: number) {
  const db = await requireDb();
  const [counts, states] = await Promise.all([
    getKnowledgeCounts(db, userId),
    db
      .select({ revision: enterpriseResetStateTable().revision })
      .from(enterpriseResetStateTable())
      .where(enterpriseResetStateOwnerPredicate(userId))
      .limit(1),
  ]);
  return {
    revision: states[0]?.revision ?? 0,
    hasKnowledge: counts.hasKnowledge,
    canReset: counts.hasKnowledge,
    unavailableReason: counts.hasKnowledge
      ? null
      : "当前没有可重置的知识库记录",
  };
}

export async function assertKnowledgeBaseWritable(_userId: number) {
  if (knowledgeBaseWritesAreEmergencyBlocked()) {
    throw new AuthServiceError("CONFLICT", "知识库写入已临时关闭，请稍后重试");
  }
}

export function knowledgeResetOperationId(
  userId: number,
  revision: number,
  scope = "reset",
) {
  const hash = createHash("sha256")
    .update(`knowledge-reset:${getEnterpriseProjectScope()?.isLegacyDefault === false ? getEnterpriseProjectScope()!.enterpriseProjectId + ":" : ""}${userId}:${revision}:${scope}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export async function resetKnowledgeBase(input: {
  actor: AuthenticatedUser;
  expectedRevision: number;
}) {
  if (input.actor.role !== "user" && !getEnterpriseProjectScope()) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有客户可以重置自己的知识库",
    );
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new AuthServiceError("CONFLICT", "知识库版本无效，请刷新后重试");
  }
  const userId = enterpriseWorkspaceUserId(input.actor.id);
  const resetActionId = knowledgeResetOperationId(
    userId,
    input.expectedRevision,
  );
  const db = await requireDb();
  let resetBuildSourceScopes: Array<{
    userId: number;
    buildId: string;
    terminalAt: Date;
  }> = [];
  let resetConversationIds: string[] = [];
  const result = await db.transaction(async (tx) => {
    await lockCustomerProjectBusinessWrite(tx, userId, input.actor);
    const now = new Date();
    // Serialize reset with every new start/upload path before reading or
    // retiring knowledge-base state. A delayed browser request holding the old
    // revision either commits before this lock (and is retired below) or waits
    // and observes the incremented revision; it cannot recreate the old build
    // after cleanup.
    await tx
      .insert(enterpriseResetStateTable())
      .values({
        userId: userId,
        revision: 0,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { userId: userId },
      });
    const lockedResetState = (
      await tx
        .select({ revision: enterpriseResetStateTable().revision })
        .from(enterpriseResetStateTable())
        .where(enterpriseResetStateOwnerPredicate(userId))
        .limit(1)
        .for("update")
    )[0];
    if (!lockedResetState) {
      throw new AuthServiceError("CONFLICT", "知识库重置状态不可用，请重试");
    }
    const previous = (
      await tx
        .select({ metadata: workspaceAuditEvents.metadata })
        .from(workspaceAuditEvents)
        .where(
          and(
            eq(workspaceAuditEvents.id, resetActionId),
            eq(workspaceAuditEvents.workspaceUserId, userId),
          ),
        )
        .limit(1)
    )[0];
    if (previous)
      return previous.metadata as {
        revision: number;
        cleanup: {
          builds: number;
          snapshots: number;
          conversations: number;
          attachments: number;
          importReceipts: number;
        };
      };
    if (lockedResetState.revision !== input.expectedRevision) {
      throw new AuthServiceError("CONFLICT", "知识库已更新，请刷新后重试");
    }
    const nextResetRevision = lockedResetState.revision + 1;

    // Snapshot locks fence concurrent downstream FK references until reset commits.
    const counts = await getKnowledgeCounts(tx, userId, true);
    resetBuildSourceScopes = counts.builds.map((build) => ({
      userId: userId,
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
      persistedConversationId(userId, id),
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
    const [conversationRows, attachmentRows, resourceRows] = await Promise.all([
      storedIds.length
        ? tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                enterpriseOwnerPredicate(conversations, userId),
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
                eq(attachments.userId, userId),
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
            enterpriseOwnerPredicate(upstreamResources, userId),
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
        .insert(knowledgeBaseConversationRetentionTombstones)
        .values(
          publicConversationIds.map((publicId) => ({
            id: knowledgeResetOperationId(
              userId,
              input.expectedRevision,
              publicId,
            ),
            userId,
            publicConversationId: publicId,
            resetAt: now,
            createdAt: now,
          })),
        )
        .onDuplicateKeyUpdate({ set: { resetAt: now } });
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
      // Stop paid work after approval; retain files and ownership for audit.
      if (resource.kind === "task") {
        cleanupResources.set(`${resource.kind}:${resource.upstreamId}`, resource);
      }
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
    if (cleanupResources.size) {
      await tx
        .insert(knowledgeBaseResetCleanupJobs)
        .values(
          [...cleanupResources.values()].map((resource) => ({
            ...prepareKnowledgeResetCleanupResource(resource),
            id: knowledgeResetOperationId(
              userId,
              input.expectedRevision,
              `${resource.kind}:${resource.upstreamId}`,
            ),
            resetRequestId: null,
            userId: userId,
            status: "pending" as const,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
    }
    // All old execution pointers are retired in the same reset-epoch
    // transaction. Late worker binds fail their generation/active-turn fence.
    if (counts.builds.length) {
      const buildIds = counts.builds.map((build) => build.id);
      await tx.update(knowledgeBaseBuilds).set({
        executionMode: "reset_retired",
        status: "failed",
        activeTurnId: null,
        activeWorkingSetId: null,
        currentLeafId: null,
        currentPresentationKey: null,
        awaitingResponseSince: null,
        recoveryLeaseOwnerHash: null,
        recoveryLeaseExpiresAt: null,
        canonicalTaskState: "reset_retired",
        generation: sql`${knowledgeBaseBuilds.generation} + 1`,
        stateEpoch: sql`${knowledgeBaseBuilds.stateEpoch} + 1`,
        protocolErrorCode: "RESET_COMPLETED",
        protocolError: "当前任务已失效，请重新上传完整资料创建全新任务。",
        updatedAt: now,
      }).where(and(
        enterpriseOwnerPredicate(knowledgeBaseBuilds, userId),
        inArray(knowledgeBaseBuilds.id, buildIds),
      ));
      await tx.update(conversationTurns).set({
        status: "cancelled",
        leaseExpiresAt: null,
        completedAt: now,
        errorCode: "RESET_COMPLETED",
        errorMessage: "已批准重置，本轮不再执行。",
        updatedAt: now,
      }).where(and(
        enterpriseOwnerPredicate(conversationTurns, userId),
        inArray(conversationTurns.buildId, buildIds),
        inArray(conversationTurns.status, ["queued", "running"]),
      ));
    }
    await tx.update(knowledgeImportReceipts).set({
      status: "failed",
      errorCode: "RESET_COMPLETED",
      errorMessage: "已批准重置，该导入记录仅供审计。",
      updatedAt: now,
    }).where(enterpriseOwnerPredicate(knowledgeImportReceipts, userId));
    await tx.update(knowledgeBaseSnapshots).set({ status: "archived" })
      .where(enterpriseOwnerPredicate(knowledgeBaseSnapshots, userId));
    if (storedIds.length) {
      await tx.update(conversations).set({
        status: "archived",
        deletedAt: now,
        completedAt: now,
        version: sql`${conversations.version} + 1`,
        updatedAt: now,
      }).where(and(
        enterpriseOwnerPredicate(conversations, userId),
        inArray(conversations.id, storedIds),
      ));
    }
    await tx
      .update(enterpriseResetStateTable())
      .set({ revision: nextResetRevision, updatedAt: now })
      .where(
        and(
          enterpriseResetStateOwnerPredicate(userId),
          eq(enterpriseResetStateTable().revision, lockedResetState.revision),
        ),
      );
    const completed = { revision: nextResetRevision, cleanup };
    await tx.insert(workspaceAuditEvents).values({
      id: resetActionId,
      actorUserId: input.actor.id,
      actorUsername: input.actor.username,
      action: "workspace.knowledge.reset",
      targetType: "knowledge_base",
      targetId: String(userId),
      workspaceUserId: userId,
      metadata: completed,
      createdAt: now,
    });
    return completed;
  });
  await Promise.allSettled(
    resetBuildSourceScopes.map((scope) =>
      markKnowledgeBaseBuildSourcesTerminal({ ...scope, reason: "reset" }),
    ),
  );
  await retireManagedUploadIntentsForKnowledgeBaseReset({
    userId,
    conversationIds: resetConversationIds,
    discardProviderFile: discardManagedUploadProviderFileForRetirement,
  }).catch(() => undefined);
  void processKnowledgeResetCleanupJobs();
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
    await runWithStoredEnterpriseProjectScope(job.userId, job.enterpriseProjectId, async () => {
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
          const removal = await removeKnowledgeResetLocalAssetIfOrphaned({
            storageKey: localAssetKey,
            db,
          });
          if (removal === "referenced") {
            throw new Error("知识库资源仍被快照或构建引用");
          }
        }
      } else {
        const credential = await getCredentialForUpstreamResource(
          job.userId,
          job.kind,
          job.upstreamId,
        );
        if (!credential) throw new Error("上游资源凭据已不可用");
        try {
          const client = createCredentialAgentClient(credential, {
            accountUserId: job.userId,
          });
          if (job.kind === "task") {
            await client.stopTask(job.upstreamId);
          } else if (shouldDeleteKnowledgeResetUpstreamResource(job.kind)) {
            await client.deleteFile(job.upstreamId);
          }
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
                enterpriseOwnerPredicate(upstreamResources, job.userId),
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
    });
  }
  return { processed: jobs.length };
}
