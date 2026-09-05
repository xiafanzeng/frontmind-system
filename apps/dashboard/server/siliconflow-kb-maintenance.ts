import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  attachments,
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
  messages,
  upstreamResources,
  userDashboardContents,
  users,
} from "../drizzle/schema";
import { dashboardPayloadSchema } from "../shared/dashboard";
import { getCredentialForUpstreamResource } from "./auth-service";
import { getDb } from "./db";
import { knowledgeSnapshotArchiveStorageKey } from "./knowledge-snapshot-archive-store";
import { getUpstreamBaseUrl } from "./upstream-config";

export const SILICONFLOW_MAINTENANCE_BRAND = "硅基流动";

const dashboardAssetRoot = path.resolve(
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
    path.join(process.cwd(), ".frontmind-dashboard-assets"),
);

function normalizeEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function persistedConversationId(userId: number, publicId: string) {
  return `u${userId}:${publicId}`;
}

export function siliconFlowKnowledgeSnapshotCleanupStorageKeys(
  userId: number,
  snapshots: Array<{
    id: string;
    assets: Array<{ key?: string }>;
  }>,
) {
  return Array.from(
    new Set(
      snapshots.flatMap((snapshot) => [
        ...snapshot.assets.map((asset) => asset.key).filter(Boolean),
        knowledgeSnapshotArchiveStorageKey(userId, snapshot.id),
      ]),
    ),
  ) as string[];
}

export function shouldDeleteSiliconFlowUpstreamResource(
  kind: "task" | "file",
) {
  return kind === "file";
}

export function assertSiliconFlowMaintenanceIdentity(input: {
  userId: number;
  userMatches: number;
  dashboardBrandNames: string[];
  buildCompanyNames: string[];
}) {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("必须提供明确的正整数用户 ID");
  }
  if (input.userMatches !== 1) {
    throw new Error(
      input.userMatches === 0
        ? `用户 ID ${input.userId} 不存在`
        : `用户 ID ${input.userId} 匹配到多个账号，已终止`,
    );
  }
  if (input.dashboardBrandNames.length !== 1) {
    throw new Error(
      input.dashboardBrandNames.length === 0
        ? "目标账号没有唯一的正式企业资料，已终止"
        : "目标账号匹配到多份正式企业资料，已终止",
    );
  }
  if (input.buildCompanyNames.length === 0) {
    throw new Error("目标账号没有可校验公司名称的知识库构建，已终止");
  }

  const expected = normalizeEnterpriseName(SILICONFLOW_MAINTENANCE_BRAND);
  if (
    normalizeEnterpriseName(input.dashboardBrandNames[0] || "") !== expected
  ) {
    throw new Error(
      `正式品牌名必须为“${SILICONFLOW_MAINTENANCE_BRAND}”，已终止`,
    );
  }
  const mismatches = input.buildCompanyNames.filter(
    (name) => normalizeEnterpriseName(name) !== expected,
  );
  if (mismatches.length > 0) {
    throw new Error(
      `存在与“${SILICONFLOW_MAINTENANCE_BRAND}”不一致的构建公司名，已终止`,
    );
  }
}

type CleanupResource = {
  kind: "task" | "file";
  upstreamId: string;
  ownershipRows: number;
};

type MaintenanceInventory = {
  userId: number;
  formalBrandName: string;
  buildCompanyNames: string[];
  buildIds: string[];
  publicConversationIds: string[];
  storedConversationIds: string[];
  snapshotIds: string[];
  receiptIds: string[];
  localAssetKeys: string[];
  resources: CleanupResource[];
  counts: {
    builds: number;
    nodes: number;
    snapshots: number;
    importReceipts: number;
    conversations: number;
    messages: number;
    attachments: number;
    localAssets: number;
    upstreamTasks: number;
    upstreamFiles: number;
    resourceOwnershipRows: number;
  };
  resetRevision: number;
  fingerprint: string;
};

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("数据库未配置");
  return db;
}

async function collectInventory(
  executor: any,
  userId: number,
): Promise<MaintenanceInventory> {
  const [userRows, dashboardRows, buildRows, snapshotRows, receiptRows] =
    await Promise.all([
      executor.select({ id: users.id }).from(users).where(eq(users.id, userId)),
      executor
        .select({ payload: userDashboardContents.payload })
        .from(userDashboardContents)
        .where(eq(userDashboardContents.userId, userId)),
      executor
        .select({
          id: knowledgeBaseBuilds.id,
          conversationId: knowledgeBaseBuilds.conversationId,
          companyName: knowledgeBaseBuilds.companyName,
          upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
          packageTaskId: knowledgeBaseBuilds.packageTaskId,
          packageFileId: knowledgeBaseBuilds.packageFileId,
        })
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.userId, userId)),
      executor
        .select({
          id: knowledgeBaseSnapshots.id,
          sourceConversationId: knowledgeBaseSnapshots.sourceConversationId,
          sourceTaskId: knowledgeBaseSnapshots.sourceTaskId,
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

  const dashboardBrandNames = dashboardRows.map((row: any) => {
    const parsed = dashboardPayloadSchema.safeParse(row.payload);
    return parsed.success ? parsed.data.brandName : "";
  });
  const buildCompanyNames = buildRows.map((row: any) => row.companyName);
  assertSiliconFlowMaintenanceIdentity({
    userId,
    userMatches: userRows.length,
    dashboardBrandNames,
    buildCompanyNames,
  });

  const buildIds = buildRows.map((row: any) => row.id);
  const nodeRows = buildIds.length
    ? await executor
        .select({
          id: knowledgeBaseBuildNodes.id,
          lastTaskId: knowledgeBaseBuildNodes.lastTaskId,
        })
        .from(knowledgeBaseBuildNodes)
        .where(inArray(knowledgeBaseBuildNodes.buildId, buildIds))
    : [];
  const publicConversationIds = Array.from(
    new Set(
      [
        ...buildRows.map((row: any) => row.conversationId),
        ...snapshotRows.map((row: any) => row.sourceConversationId),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  const storedConversationIds = publicConversationIds.map((id) =>
    persistedConversationId(userId, id),
  );
  const conversationRows = storedConversationIds.length
    ? await executor
        .select({
          id: conversations.id,
          upstreamTaskId: conversations.upstreamTaskId,
          previousResponseId: conversations.previousResponseId,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            inArray(conversations.id, storedConversationIds),
          ),
        )
    : [];
  const existingConversationIds = conversationRows.map((row: any) => row.id);
  const [turnRows, messageRows, attachmentRows] =
    existingConversationIds.length > 0
      ? await Promise.all([
          executor
            .select({ upstreamTaskId: conversationTurns.upstreamTaskId })
            .from(conversationTurns)
            .where(
              and(
                eq(conversationTurns.userId, userId),
                inArray(
                  conversationTurns.conversationId,
                  existingConversationIds,
                ),
              ),
            ),
          executor
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.userId, userId),
                inArray(messages.conversationId, existingConversationIds),
              ),
            ),
          executor
            .select({
              id: attachments.id,
              upstreamFileId: attachments.upstreamFileId,
            })
            .from(attachments)
            .where(
              and(
                eq(attachments.userId, userId),
                inArray(attachments.conversationId, existingConversationIds),
              ),
            ),
        ])
      : [[], [], []];

  const taskIds = Array.from(
    new Set(
      [
        ...buildRows.flatMap((row: any) => [
          row.upstreamTaskId,
          row.packageTaskId,
        ]),
        ...nodeRows.map((row: any) => row.lastTaskId),
        ...snapshotRows.map((row: any) => row.sourceTaskId),
        ...receiptRows.map((row: any) => row.taskId),
        ...conversationRows.flatMap((row: any) => [
          row.upstreamTaskId,
          row.previousResponseId,
        ]),
        ...turnRows.map((row: any) => row.upstreamTaskId),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  const fileIds = Array.from(
    new Set(
      [
        ...buildRows.map((row: any) => row.packageFileId),
        ...receiptRows.map((row: any) => row.fileId),
        ...attachmentRows.map((row: any) => row.upstreamFileId),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  const resourceRows = await executor
    .select({
      kind: upstreamResources.kind,
      upstreamId: upstreamResources.upstreamId,
    })
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.userId, userId),
        or(
          existingConversationIds.length
            ? inArray(
                upstreamResources.conversationId,
                existingConversationIds,
              )
            : sql`false`,
          taskIds.length
            ? and(
                eq(upstreamResources.kind, "task"),
                inArray(upstreamResources.upstreamId, taskIds),
              )
            : sql`false`,
          fileIds.length
            ? and(
                eq(upstreamResources.kind, "file"),
                inArray(upstreamResources.upstreamId, fileIds),
              )
            : sql`false`,
        ),
      ),
    );
  for (const row of resourceRows) {
    (row.kind === "task" ? taskIds : fileIds).push(row.upstreamId);
  }
  const uniqueTaskIds = Array.from(new Set(taskIds));
  const uniqueFileIds = Array.from(new Set(fileIds));
  const ownershipCounts = new Map<string, number>();
  for (const row of resourceRows) {
    const key = `${row.kind}:${row.upstreamId}`;
    ownershipCounts.set(key, (ownershipCounts.get(key) || 0) + 1);
  }
  const resources: CleanupResource[] = [
    ...uniqueTaskIds.map((upstreamId) => ({
      kind: "task" as const,
      upstreamId,
      ownershipRows: ownershipCounts.get(`task:${upstreamId}`) || 0,
    })),
    ...uniqueFileIds.map((upstreamId) => ({
      kind: "file" as const,
      upstreamId,
      ownershipRows: ownershipCounts.get(`file:${upstreamId}`) || 0,
    })),
  ];
  const localAssetKeys = siliconFlowKnowledgeSnapshotCleanupStorageKeys(
    userId,
    snapshotRows.map((row: any) => ({
      id: row.id,
      assets: row.assets || [],
    })),
  );
  const resetRows = await executor
    .select({ revision: knowledgeBaseResetStates.revision })
    .from(knowledgeBaseResetStates)
    .where(eq(knowledgeBaseResetStates.userId, userId))
    .limit(1);
  const identity = {
    userId,
    formalBrandName: dashboardBrandNames[0],
    buildIds: [...buildIds].sort(),
    snapshotIds: snapshotRows.map((row: any) => row.id).sort(),
    receiptIds: receiptRows.map((row: any) => row.id).sort(),
    storedConversationIds: [...existingConversationIds].sort(),
    taskIds: [...uniqueTaskIds].sort(),
    fileIds: [...uniqueFileIds].sort(),
  };

  return {
    userId,
    formalBrandName: dashboardBrandNames[0],
    buildCompanyNames,
    buildIds,
    publicConversationIds,
    storedConversationIds: existingConversationIds,
    snapshotIds: snapshotRows.map((row: any) => row.id),
    receiptIds: receiptRows.map((row: any) => row.id),
    localAssetKeys,
    resources,
    counts: {
      builds: buildRows.length,
      nodes: nodeRows.length,
      snapshots: snapshotRows.length,
      importReceipts: receiptRows.length,
      conversations: conversationRows.length,
      messages: messageRows.length,
      attachments: attachmentRows.length,
      localAssets: localAssetKeys.length,
      upstreamTasks: uniqueTaskIds.length,
      upstreamFiles: uniqueFileIds.length,
      resourceOwnershipRows: resourceRows.length,
    },
    resetRevision: resetRows[0]?.revision || 0,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex"),
  };
}

export async function previewSiliconFlowKnowledgeBaseReset(userId: number) {
  return collectInventory(await requireDb(), userId);
}

async function removeLocalAsset(assetKey: string) {
  const assetPath = path.resolve(dashboardAssetRoot, assetKey);
  if (!assetPath.startsWith(`${dashboardAssetRoot}${path.sep}`)) {
    throw new Error("本地资源路径越界");
  }
  try {
    await unlink(assetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function executeSiliconFlowKnowledgeBaseReset(input: {
  userId: number;
  expectedFingerprint: string;
  maintenanceConfirmation: string;
}) {
  const expectedConfirmation = `${SILICONFLOW_MAINTENANCE_BRAND}:${input.userId}`;
  if (input.maintenanceConfirmation !== expectedConfirmation) {
    throw new Error(
      `必须确认该企业已进入知识库写入维护窗口：--maintenance-confirmed=${expectedConfirmation}`,
    );
  }
  const db = await requireDb();
  const inventory = await collectInventory(db, input.userId);
  if (inventory.fingerprint !== input.expectedFingerprint) {
    throw new Error("清理预览后目标数据已变化，已终止；请重新生成预览");
  }

  const credentials = new Map<
    string,
    Awaited<ReturnType<typeof getCredentialForUpstreamResource>>
  >();
  for (const resource of inventory.resources) {
    if (!shouldDeleteSiliconFlowUpstreamResource(resource.kind)) continue;
    credentials.set(
      `${resource.kind}:${resource.upstreamId}`,
      await getCredentialForUpstreamResource(
        input.userId,
        resource.kind,
        resource.upstreamId,
      ),
    );
  }

  const nextRevision = await db.transaction(async (tx) => {
    const locked = await collectInventory(tx, input.userId);
    if (locked.fingerprint !== input.expectedFingerprint) {
      throw new Error("事务开始前目标数据已变化，已终止；请重新生成预览");
    }
    await tx
      .update(knowledgeBaseBuilds)
      .set({ publishedSnapshotId: null })
      .where(eq(knowledgeBaseBuilds.userId, input.userId));
    await tx
      .delete(knowledgeImportReceipts)
      .where(eq(knowledgeImportReceipts.userId, input.userId));
    await tx
      .delete(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, input.userId));
    await tx
      .delete(knowledgeBaseBuilds)
      .where(eq(knowledgeBaseBuilds.userId, input.userId));
    if (inventory.storedConversationIds.length > 0) {
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.userId, input.userId),
            inArray(conversations.id, inventory.storedConversationIds),
          ),
        );
    }
    await tx
      .insert(knowledgeBaseResetStates)
      .values({
        userId: input.userId,
        revision: 1,
        updatedAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          revision: sql`${knowledgeBaseResetStates.revision} + 1`,
          updatedAt: new Date(),
        },
      });
    const revisionRows = await tx
      .select({ revision: knowledgeBaseResetStates.revision })
      .from(knowledgeBaseResetStates)
      .where(eq(knowledgeBaseResetStates.userId, input.userId))
      .limit(1);
    return revisionRows[0]?.revision || inventory.resetRevision + 1;
  });

  const failures: Array<{
    kind: "task" | "file" | "local_asset";
    id: string;
    error: string;
  }> = [];
  const completedResources: CleanupResource[] = [];
  const retainedTaskIds: string[] = [];
  for (const resource of inventory.resources) {
    if (!shouldDeleteSiliconFlowUpstreamResource(resource.kind)) {
      retainedTaskIds.push(resource.upstreamId);
      continue;
    }
    const credential = credentials.get(
      `${resource.kind}:${resource.upstreamId}`,
    );
    if (!credential) {
      failures.push({
        kind: resource.kind,
        id: resource.upstreamId,
        error: "上游资源凭据不可用；归属记录已保留以便重试",
      });
      continue;
    }
    try {
      const response = await fetch(
        `${getUpstreamBaseUrl()}/v1/files/${encodeURIComponent(resource.upstreamId)}`,
        {
          method: "DELETE",
          redirect: "error",
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
      completedResources.push(resource);
    } catch (error) {
      failures.push({
        kind: resource.kind,
        id: resource.upstreamId,
        error: error instanceof Error ? error.message : "上游删除失败",
      });
    }
  }
  for (const assetKey of inventory.localAssetKeys) {
    try {
      await removeLocalAsset(assetKey);
    } catch (error) {
      failures.push({
        kind: "local_asset",
        id: assetKey,
        error: error instanceof Error ? error.message : "本地资源删除失败",
      });
    }
  }
  if (completedResources.length > 0) {
    await db.transaction(async (tx) => {
      for (const resource of completedResources) {
        await tx
          .delete(upstreamResources)
          .where(
            and(
              eq(upstreamResources.userId, input.userId),
              eq(upstreamResources.kind, resource.kind),
              eq(upstreamResources.upstreamId, resource.upstreamId),
            ),
          );
      }
    });
  }

  return {
    userId: input.userId,
    brandName: SILICONFLOW_MAINTENANCE_BRAND,
    deleted: inventory.counts,
    resetRevision: nextRevision,
    externalCleanup: {
      completed: completedResources.length,
      failed: failures.length,
      retry: failures,
      retainedTaskIds,
    },
  };
}
