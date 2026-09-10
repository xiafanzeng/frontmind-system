import { and, eq, inArray } from "drizzle-orm";
import {
  enterpriseProjects,
  monitoringBatches,
  monitoringSamples,
  monitoringCitationRecords,
  users,
  workspaceAuditEvents,
} from "../drizzle/schema";
import {
  createDefaultDashboardPayload,
  type DashboardMonitoringCurrentTemplate,
} from "../shared/dashboard";
import type { ReplaceMonitoringBatchInput } from "../shared/monitoring";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import {
  workspaceQuestionTable,
  workspaceQuestionOwnerPredicate,
} from "./enterprise-project-questions";
import { getEnterpriseProjectScope } from "./enterprise-project-context";
import { enterpriseOwnerPredicate } from "./enterprise-project-scope";
import {
  enterpriseDashboardTable,
  enterpriseDashboardOwnerPredicate,
} from "./enterprise-project-service";
import { assertCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { assertEnterpriseProjectActive } from "./enterprise-project-lifecycle";
import { assertServiceCapability } from "./service-entitlement";
import {
  buildMonitoringBatchRows,
  assertQuestionOnlyCitationTargetCompatibility,
  monitoringCurrentTemplateBatchesFromExecutor,
} from "./monitoring-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  canonicalOperationValue,
  serverOperationId,
  workspaceRequestDigest,
  workspaceOperationAuditId,
} from "./workspace-operation-identity";
import {
  consumeProjectMonitoringPreflight,
  DashboardImportPreflightError,
  issueProjectMonitoringPreflight,
  projectMonitoringOperationIdentity,
  verifyProjectMonitoringPreflight,
  type ProjectMonitoringPreflightPayload,
} from "./dashboard-import-preflight-service";

type CurrentBatch = DashboardMonitoringCurrentTemplate["batches"][number];
export type ProjectMonitoringImportPlan = {
  operationKind: "import" | "replace" | "merge-citations";
  batches: ReplaceMonitoringBatchInput[];
  targetBatchKey?: string;
  expectedBatchRevisions?: Record<string, number>;
  completeTemplate?: boolean;
};
export type ProjectMonitoringImportRequest = {
  actor: AuthenticatedUser;
  userId: number;
  revision: number;
  fileHash: string;
  targetBatchKey?: string;
  token?: string;
};
const IMPORT_ACTION = "workspace.monitoring.template_imported";

function scopeFor(input: ProjectMonitoringImportRequest) {
  if (input.actor.role !== "admin")
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "监控数据维护需要已授权管理员权限。",
    );
  const scope = getEnterpriseProjectScope();
  if (
    !scope ||
    scope.ownerUserId !== input.userId ||
    scope.actorUserId !== input.actor.id
  )
    throw new AuthServiceError("NOT_FOUND", "请先选择正确的客户和企业项目");
  return scope;
}
function bindingFor(input: ProjectMonitoringImportRequest) {
  return {
    actorId: input.actor.id,
    workspaceUserId: input.userId,
    enterpriseProjectId: scopeFor(input).enterpriseProjectId,
    module: "monitoring" as const,
    revision: input.revision,
    fileHash: input.fileHash,
    targetBatchKey: input.targetBatchKey,
  };
}
function targetScope(plan: ProjectMonitoringImportPlan) {
  return workspaceRequestDigest({
    operationKind: plan.operationKind,
    targetBatchKey: plan.targetBatchKey,
    completeTemplate: Boolean(plan.completeTemplate),
    batches: plan.batches
      .map((batch) => ({
        batchKey: batch.batchKey,
        samples: batch.samples.map((row) => ({
          id: row.sourceRecordId,
          questionId: row.questionId,
          platform: row.platform,
        })),
        citations: batch.citations.map((row) => ({
          id: row.sourceRecordId,
          questionId: row.questionId,
          model: row.model,
          sampleSourceRecordId: row.sampleSourceRecordId,
        })),
      }))
      .sort((a, b) => a.batchKey.localeCompare(b.batchKey)),
  });
}
function revisionDigest(
  plan: ProjectMonitoringImportPlan,
  current: CurrentBatch[],
) {
  const keys = new Set(plan.batches.map((batch) => batch.batchKey));
  if (plan.targetBatchKey) keys.add(plan.targetBatchKey);
  const revisions = [...keys].sort().map((key) => ({
    batchKey: key,
    revision: current.find((batch) => batch.batchKey === key)?.revision ?? 0,
  }));
  return workspaceRequestDigest(revisions);
}
function normalizedBatch(
  value: Pick<
    CurrentBatch,
    "sourceName" | "collectedAt" | "samples" | "citations"
  >,
) {
  return canonicalOperationValue({
    sourceName: value.sourceName,
    collectedAt: new Date(value.collectedAt).toISOString(),
    samples: value.samples
      .map((row) => ({
        ...row,
        citationCount: Math.max(
          row.citationCount ?? 0,
          value.citations.filter(
            (c) => c.sampleSourceRecordId === row.sourceRecordId,
          ).length,
        ),
        monitorRank: row.monitorRank ?? null,
        screenshotUrl: row.screenshotUrl || "",
        collectedAt: new Date(
          row.collectedAt || value.collectedAt,
        ).toISOString(),
      }))
      .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId)),
    citations: value.citations
      .map((row) => ({
        ...row,
        sampleSourceRecordId: row.sampleSourceRecordId || null,
        domain:
          row.domain ||
          (() => {
            try {
              return new URL(row.url).hostname.toLowerCase();
            } catch {
              return "";
            }
          })(),
        publishedAt: row.publishedAt
          ? new Date(row.publishedAt).toISOString()
          : null,
        collectedAt: new Date(
          row.collectedAt || value.collectedAt,
        ).toISOString(),
      }))
      .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId)),
  });
}
export function monitoringImportResultRef(
  projectId: string,
  batchKey?: string,
  revision?: number,
) {
  const query = new URLSearchParams({
    enterpriseProjectId: projectId,
    monitoringData: "1",
  });
  if (batchKey) query.set("monitoringBatchKey", batchKey);
  if (revision) query.set("monitoringBatchRevision", String(revision));
  return `/monitoring-system?${query}`;
}

export function resolveProjectMonitoringImportBatches(
  plan: ProjectMonitoringImportPlan,
  current: CurrentBatch[],
) {
  const currentByKey = new Map(current.map((batch) => [batch.batchKey, batch]));
  if (
    plan.completeTemplate &&
    (current.length !== plan.batches.length ||
      plan.batches.some((batch) => !currentByKey.has(batch.batchKey)))
  )
    throw new AuthServiceError(
      "CONFLICT",
      "监控批次目录已变化，请重新下载当前内容模板。",
    );
  for (const [key, revision] of Object.entries(
    plan.expectedBatchRevisions ?? {},
  )) {
    if (currentByKey.get(key)?.revision !== revision)
      throw new AuthServiceError(
        "CONFLICT",
        `监控批次 ${key} 版本已变化，请重新预检。`,
      );
  }
  if (plan.operationKind !== "merge-citations") return plan.batches;
  const target = currentByKey.get(plan.targetBatchKey || "");
  if (!target?.samples.length)
    throw new AuthServiceError("NOT_FOUND", "目标监控批次不存在或没有回答。");
  const incoming = plan.batches.flatMap((batch) => batch.citations);
  if (
    plan.batches.some((batch) => batch.samples.length) ||
    incoming.some((row) => row.sampleSourceRecordId)
  )
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "仅问题级引用可以合并至目标批次。",
    );
  assertQuestionOnlyCitationTargetCompatibility({
    samples: target.samples.map((row) => ({
      ...row,
      collectedAt: row.collectedAt || target.collectedAt,
    })),
    citations: incoming,
  });
  const linked = target.citations.filter((row) => row.sampleSourceRecordId);
  const linkedIds = new Set(linked.map((row) => row.sourceRecordId));
  if (incoming.some((row) => linkedIds.has(row.sourceRecordId)))
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "引用 ID 与已精确关联的引用冲突。",
    );
  return [
    {
      userId: plan.batches[0]!.userId,
      batchKey: target.batchKey,
      sourceName: target.sourceName,
      collectedAt: target.collectedAt,
      samples: target.samples,
      citations: [...linked, ...incoming],
    },
  ];
}

export async function previewProjectMonitoringImport(
  input: ProjectMonitoringImportRequest & { plan: ProjectMonitoringImportPlan },
) {
  scopeFor(input);
  await assertCustomerProjectBusinessWrite(input.actor, input.userId);
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  const portal = await assertServiceCapability(input.userId, "monitoring");
  const current = await monitoringCurrentTemplateBatchesFromExecutor({
    executor: db,
    userId: input.userId,
  });
  const batches = resolveProjectMonitoringImportBatches(input.plan, current);
  const questions = portal.purchasedQuestions.flatMap((question) =>
    [question.id, question.externalQuestionId, question.sourceQuestionId]
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, question: question.question })),
  );
  for (const batch of batches)
    buildMonitoringBatchRows({
      userId: input.userId,
      batchId: "preview",
      value: batch,
      questions,
    });
  const stats = importStats(batches, current);
  const credential =
    stats.newBatchCount + stats.updatedBatchCount === 0
      ? {}
      : issueProjectMonitoringPreflight({
          binding: {
            ...bindingFor(input),
            operationKind: input.plan.operationKind,
            targetScope: targetScope(input.plan),
            targetBatchRevisionDigest: revisionDigest(input.plan, current),
          },
        });
  return {
    ...credential,
    ...stats,
    unchanged: stats.newBatchCount + stats.updatedBatchCount === 0,
  };
}
function importStats(
  batches: ReplaceMonitoringBatchInput[],
  current: CurrentBatch[],
) {
  let newBatchCount = 0,
    updatedBatchCount = 0,
    unchangedBatchCount = 0;
  for (const batch of batches) {
    const existing = current.find((row) => row.batchKey === batch.batchKey);
    if (!existing) newBatchCount++;
    else if (normalizedBatch(existing) === normalizedBatch(batch))
      unchangedBatchCount++;
    else updatedBatchCount++;
  }
  return {
    newBatchCount,
    updatedBatchCount,
    unchangedBatchCount,
    sampleCount: batches.reduce((sum, batch) => sum + batch.samples.length, 0),
    citationCount: batches.reduce(
      (sum, batch) => sum + batch.citations.length,
      0,
    ),
  };
}
async function lockAuthorizedProject(
  tx: any,
  input: ProjectMonitoringImportRequest,
) {
  const scope = scopeFor(input);
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for("update");
  const [project] = await tx
    .select({ id: enterpriseProjects.id })
    .from(enterpriseProjects)
    .where(
      and(
        eq(enterpriseProjects.id, scope.enterpriseProjectId),
        eq(enterpriseProjects.ownerUserId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  if (!project) throw new AuthServiceError("NOT_FOUND", "企业项目不存在。");
  const [actor] = await tx
    .select({
      id: users.id,
      role: users.role,
      adminAccessLevel: users.adminAccessLevel,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, input.actor.id))
    .limit(1)
    .for("share");
  if (!actor?.isActive)
    throw new AuthServiceError("NOT_FOUND", "操作者已停用。");
  await assertCustomerProjectBusinessWrite(actor, input.userId, {
    executor: tx,
    requireProject: true,
    currentRead: true,
  });
}
async function recoveredResult(
  tx: any,
  token: ProjectMonitoringPreflightPayload,
) {
  const identity = projectMonitoringOperationIdentity(token);
  const [event] = await tx
    .select({ metadata: workspaceAuditEvents.metadata })
    .from(workspaceAuditEvents)
    .where(
      eq(
        workspaceAuditEvents.id,
        workspaceOperationAuditId(IMPORT_ACTION, identity.operationId),
      ),
    )
    .limit(1);
  if (!event) return null;
  const metadata = event.metadata as Record<string, any>;
  if (
    metadata.requestDigest !== token.requestDigest ||
    metadata.enterpriseProjectId !== token.enterpriseProjectId ||
    metadata.operationId !== token.operationId
  )
    throw new AuthServiceError("CONFLICT", "操作身份与已提交结果不一致。");
  return {
    kind: "monitoring" as const,
    module: "monitoring" as const,
    resultSummary: metadata.resultSummary,
    resourceRef: metadata.resourceRef as string,
    replayed: true,
  };
}
export async function recoverProjectMonitoringImport(
  input: ProjectMonitoringImportRequest,
) {
  const token = verifyProjectMonitoringPreflight({
    token: input.token,
    binding: bindingFor(input),
  });
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  return db.transaction(async (tx) => {
    await lockAuthorizedProject(tx, input);
    return recoveredResult(tx, token);
  });
}
export async function commitProjectMonitoringImport(
  input: ProjectMonitoringImportRequest & { plan: ProjectMonitoringImportPlan },
) {
  const token = verifyProjectMonitoringPreflight({
    token: input.token,
    binding: bindingFor(input),
  });
  if (
    token.targetScope !== targetScope(input.plan) ||
    token.operationKind !== input.plan.operationKind
  )
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_BINDING_MISMATCH",
      "导入映射或目标批次已改变，请重新预检。",
    );
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  return db.transaction(async (tx) => {
    await lockAuthorizedProject(tx, input);
    const previous = await recoveredResult(tx, token);
    if (previous) return previous;
    await assertEnterpriseProjectActive(
      tx,
      token.enterpriseProjectId,
      input.userId,
    );
    const now = new Date();
    if (token.expiresAt * 1000 <= now.getTime())
      throw new DashboardImportPreflightError(
        "DASHBOARD_IMPORT_PREFLIGHT_EXPIRED",
        "预检凭证已过期，请重新预检文件。",
      );
    const [dashboard] = await tx
      .select()
      .from(enterpriseDashboardTable())
      .where(enterpriseDashboardOwnerPredicate(input.userId))
      .limit(1)
      .for("update");
    if ((dashboard?.revision ?? 0) !== input.revision)
      throw new AuthServiceError(
        "CONFLICT",
        "工作区版本已改变，请重新预检文件。",
      );
    const current = await monitoringCurrentTemplateBatchesFromExecutor({
      executor: tx,
      userId: input.userId,
      lockBatches: true,
    });
    if (revisionDigest(input.plan, current) !== token.targetBatchRevisionDigest)
      throw new AuthServiceError(
        "CONFLICT",
        "监控批次已改变，请重新预检文件。",
      );
    const batches = resolveProjectMonitoringImportBatches(input.plan, current);
    // Project questions are protected by the project lock held above. Read the
    // exact current project table in this transaction, never a client catalog.
    const questionTable = workspaceQuestionTable();
    const questionRows = await tx
      .select()
      .from(questionTable)
      .where(
        and(
          workspaceQuestionOwnerPredicate(input.userId),
          inArray(questionTable.status, ["selected"]),
        ),
      );
    const questions = questionRows.flatMap((question) =>
      [question.id, question.externalQuestionId, question.sourceQuestionId]
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id, question: question.question })),
    );
    const changed = batches.filter((batch) => {
      const old = current.find((row) => row.batchKey === batch.batchKey);
      return !old || normalizedBatch(old) !== normalizedBatch(batch);
    });
    const stats = importStats(batches, current);
    if (!changed.length)
      return {
        kind: "monitoring" as const,
        module: "monitoring" as const,
        resultSummary: {
          ...stats,
          originalDashboardRevision: input.revision,
          dashboardRevision: input.revision,
        },
        unchanged: true,
        replayed: false,
        resourceRef: monitoringImportResultRef(token.enterpriseProjectId),
      };
    const writes = changed.map((batch) => {
      const old = current.find((row) => row.batchKey === batch.batchKey);
      if (old && input.plan.operationKind === "import")
        throw new AuthServiceError(
          "CONFLICT",
          "已有批次正文已改变；请明确选择该批次或下载当前内容模板后修订。",
        );
      const batchId = serverOperationId({
        namespace: "monitoring-project-batch:v1",
        userId: input.userId,
        projectId: token.enterpriseProjectId,
        batchKey: batch.batchKey,
      });
      return {
        batch,
        batchId,
        old,
        rows: buildMonitoringBatchRows({
          userId: input.userId,
          batchId,
          value: batch,
          questions,
        }),
      };
    });
    await consumeProjectMonitoringPreflight(tx, token, now);
    let firstRevision: number | undefined;
    for (const write of writes) {
      const [existing] = await tx
        .select({ id: monitoringBatches.id })
        .from(monitoringBatches)
        .where(
          and(
            enterpriseOwnerPredicate(monitoringBatches, input.userId),
            eq(monitoringBatches.batchKey, write.batch.batchKey),
          ),
        )
        .limit(1)
        .for("update");
      const batchId = existing?.id ?? write.batchId;
      const rows = existing
        ? buildMonitoringBatchRows({
            userId: input.userId,
            batchId,
            value: write.batch,
            questions,
          })
        : write.rows;
      const revision = (write.old?.revision ?? 0) + 1;
      firstRevision ??= revision;
      const values = {
        sourceName: write.batch.sourceName,
        collectedAt: rows.collectedAt,
        sampleCount: rows.samples.length,
        citationCount: rows.citations.length,
        revision,
        importedByUserId: input.actor.id,
        updatedAt: now,
      };
      if (existing) {
        await tx
          .delete(monitoringCitationRecords)
          .where(
            and(
              enterpriseOwnerPredicate(monitoringCitationRecords, input.userId),
              eq(monitoringCitationRecords.batchId, batchId),
            ),
          );
        await tx
          .delete(monitoringSamples)
          .where(
            and(
              enterpriseOwnerPredicate(monitoringSamples, input.userId),
              eq(monitoringSamples.batchId, batchId),
            ),
          );
        await tx
          .update(monitoringBatches)
          .set(values)
          .where(eq(monitoringBatches.id, batchId));
      } else
        await tx.insert(monitoringBatches).values({
          ...values,
          id: batchId,
          userId: input.userId,
          enterpriseProjectId: token.enterpriseProjectId,
          contractId: null,
          quotaPeriodId: null,
          batchKey: write.batch.batchKey,
        });
      for (let offset = 0; offset < rows.samples.length; offset += 500)
        await tx
          .insert(monitoringSamples)
          .values(rows.samples.slice(offset, offset + 500));
      for (let offset = 0; offset < rows.citations.length; offset += 500)
        await tx
          .insert(monitoringCitationRecords)
          .values(rows.citations.slice(offset, offset + 500));
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "workspace.monitoring_batch.replaced",
          targetType: "monitoring_batch",
          targetId: batchId,
          workspaceUserId: input.userId,
          serverOperationId: serverOperationId({
            operation: token.operationId,
            batchKey: write.batch.batchKey,
          }),
          metadata: {
            schemaVersion: 1,
            enterpriseProjectId: token.enterpriseProjectId,
            module: "monitoring",
            operationId: token.operationId,
            parentOperationId: token.operationId,
            revision,
            sampleCount: rows.samples.length,
            citationCount: rows.citations.length,
          },
        },
        tx,
      );
    }
    const dashboardRevision = input.revision + 1;
    if (dashboard)
      await tx
        .update(enterpriseDashboardTable())
        .set({
          revision: dashboardRevision,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(enterpriseDashboardOwnerPredicate(input.userId));
    else
      await tx.insert(enterpriseDashboardTable() as any).values({
        userId: input.userId,
        enterpriseProjectId: token.enterpriseProjectId,
        payload: createDefaultDashboardPayload(),
        sourceName: "monitoring-import",
        revision: dashboardRevision,
        updatedByUserId: input.actor.id,
      });
    const resourceRef = monitoringImportResultRef(
      token.enterpriseProjectId,
      writes[0]?.batch.batchKey,
      firstRevision,
    );
    const resultSummary = {
      ...stats,
      originalDashboardRevision: input.revision,
      dashboardRevision,
      operationId: token.operationId,
    };
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: IMPORT_ACTION,
        targetType: "monitoring_batch",
        targetId: token.enterpriseProjectId,
        workspaceUserId: input.userId,
        serverOperationId:
          projectMonitoringOperationIdentity(token).operationId,
        metadata: {
          schemaVersion: 1,
          enterpriseProjectId: token.enterpriseProjectId,
          module: "monitoring",
          operationId: token.operationId,
          requestDigest: token.requestDigest,
          resourceRef,
          resultSummary,
        },
      },
      tx,
    );
    return {
      kind: "monitoring" as const,
      module: "monitoring" as const,
      resultSummary,
      resourceRef,
      replayed: false,
    };
  });
}
