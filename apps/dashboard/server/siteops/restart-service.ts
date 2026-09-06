import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import {
  messages,
  siteBuilds,
  siteOperations,
  siteProjects,
  socialPackages,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
} from "../../drizzle/schema";

export class SiteOpsRestartError extends Error {
  constructor(
    public readonly code: "IN_FLIGHT_OPERATION",
    message: string,
  ) {
    super(message);
    this.name = "SiteOpsRestartError";
  }
}

export function siteOpsRestartState(input: {
  currentBuildId: string | null;
  hasWorkflowProgress?: boolean;
}) {
  return {
    allowed: Boolean(input.hasWorkflowProgress ?? input.currentBuildId),
    resetApplied: false,
    resetPending: false,
    resetSourceBuildId: null,
  };
}

export function siteOpsOperationBlocksRestart(operation: {
  kind: string;
  provider: string | null;
  status: string;
}) {
  return (
    ["queued", "running", "outcome_unknown"].includes(operation.status) &&
    ![
      "visual_search",
      "site_build",
      "build_revision",
      "social_package",
      "brief_message",
    ].includes(operation.kind)
  );
}

export async function restartSiteOpsProject(
  tx: any,
  input: {
    project: typeof siteProjects.$inferSelect;
    requestId: string;
    now: Date;
  },
) {
  const operations = await tx
    .select()
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, input.project.id),
        eq(siteOperations.userId, input.project.userId),
        inArray(siteOperations.status, [
          "queued",
          "running",
          "outcome_unknown",
        ]),
      ),
    )
    .for("update");
  if (operations.some(siteOpsOperationBlocksRestart)) {
    throw new SiteOpsRestartError(
      "IN_FLIGHT_OPERATION",
      "发布或域名操作正在执行，完成后即可重新开始制作。",
    );
  }
  const operationIds = operations.map(
    (operation: { id: string }) => operation.id,
  );
  if (operationIds.length) {
    await tx
      .update(siteOperations)
      .set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: "SITEOPS_RESTARTED",
        errorMessage: "已重新开始制作。",
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(inArray(siteOperations.id, operationIds));
    await tx
      .update(socialPackages)
      .set({ status: "cancelled", updatedAt: input.now })
      .where(
        and(
          inArray(socialPackages.operationId, operationIds),
          inArray(socialPackages.status, ["queued", "building"]),
        ),
      );
    await tx
      .update(socialPackages)
      .set({ quotaState: "released", updatedAt: input.now })
      .where(
        and(
          inArray(socialPackages.operationId, operationIds),
          eq(socialPackages.quotaState, "reserved"),
        ),
      );
  }
  const revision = await applyFreshLocalResetEpoch(tx, {
    ...input,
    expectedRevision: input.project.revision,
    knowledgeInputEpochId: randomUUID(),
    resetEpochStartedAt: new Date(
      Math.floor(input.now.getTime() / 1000) * 1000,
    ),
  });
  return { revision, sourceBuildId: input.project.currentBuildId };
}

async function applyFreshLocalResetEpoch(
  tx: any,
  input: {
    requestId: string;
    project: typeof siteProjects.$inferSelect;
    expectedRevision: number;
    knowledgeInputEpochId: string;
    resetEpochStartedAt: Date;
    now: Date;
  },
) {
  const nextRevision = input.expectedRevision + 1;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, input.project.conversationId));
  const projectUpdate = await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      currentBuildId: null,
      knowledgeInputEpochId: input.knowledgeInputEpochId,
      currentTaskStartedAt: input.resetEpochStartedAt,
      minimumKnowledgeSnapshotVersion: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteProjects.id, input.project.id),
        eq(siteProjects.userId, input.project.userId),
        eq(siteProjects.revision, input.expectedRevision),
        nullableCoordinate(
          siteProjects.currentBuildId,
          input.project.currentBuildId,
        ),
        nullableCoordinate(
          siteProjects.currentKnowledgeSnapshotId,
          input.project.currentKnowledgeSnapshotId,
        ),
        nullableCoordinate(
          siteProjects.globalLiveDeploymentId,
          input.project.globalLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.mainlandLiveDeploymentId,
          input.project.mainlandLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.canonicalHostname,
          input.project.canonicalHostname,
        ),
      ),
    );
  if (affectedRows(projectUpdate) !== 1) {
    throw new SiteOpsRestartError(
      "IN_FLIGHT_OPERATION",
      "建站项目已变化，请刷新后重试。",
    );
  }

  await tx
    .update(siteBuilds)
    .set({
      status: "cancelled",
      errorCode: "SITEOPS_RESTARTED",
      errorMessage: "已重新开始制作，旧生成任务已停止。",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        inArray(siteBuilds.status, [
          "preparing",
          "visual_searching",
          "awaiting_visual_selection",
          "design_compiling",
          "contract_ready",
          "building",
          "qa_running",
          "failed",
          "attention_required",
        ]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        inArray(siteBuilds.status, ["preview_ready", "approved"]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ quotaState: "released", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        eq(siteBuilds.quotaState, "reserved"),
      ),
    );

  const candidatePoolRows = await tx
    .select({ id: visualCandidatePools.id })
    .from(visualCandidatePools)
    .where(
      and(
        eq(visualCandidatePools.projectId, input.project.id),
        eq(visualCandidatePools.userId, input.project.userId),
        inArray(visualCandidatePools.status, ["active", "selected"]),
      ),
    )
    .for("update");
  const candidatePoolIds = candidatePoolRows.map(
    (pool: { id: string }) => pool.id,
  );
  if (candidatePoolIds.length > 0) {
    await tx
      .update(visualCandidatePoolPages)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePoolPages.poolId, candidatePoolIds),
          inArray(visualCandidatePoolPages.status, [
            "reserved",
            "published",
            "selected",
          ]),
        ),
      );
    await tx
      .update(visualCandidatePools)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePools.id, candidatePoolIds),
          inArray(visualCandidatePools.status, ["active", "selected"]),
        ),
      );
  }
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.project.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
      ),
    );

  await tx
    .update(messages)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(messages.conversationId, input.project.conversationId),
        eq(messages.userId, input.project.userId),
        isNull(messages.deletedAt),
      ),
    );
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: input.project.conversationId,
    userId: input.project.userId,
    role: "assistant",
    content: "已重新开始制作，可继续使用当前知识库。",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: input.requestId,
        revision: nextRevision,
        status: "active",
        payload: {
          resetRequestId: input.requestId,
          requested: "reuse_current_knowledge",
          reset: true,
          freshRootApplied: true,
          unpublishCompleted: false,
        },
      },
    },
  });
  return nextRevision;
}

function affectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
}

function nullableCoordinate(column: any, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}
