import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";

import {
  agentOperations,
  agentTasks,
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeImportReceipts,
  knowledgeBaseSnapshots,
  serviceContracts,
  serviceProgressReports,
  upstreamResources,
  userAdminAssignments,
  userDashboardContents,
  userUsageOwners,
  users,
  workspaceContentRevisions,
  type KnowledgeAssetRecord,
  type KnowledgeDocumentRecord,
  type WorkspaceContentRevision,
} from "../drizzle/schema";
import {
  knowledgeBasePackageWriterTaskId,
  knowledgeBasePublicationBindingHash,
} from "./knowledge-base-publication-binding";
import { isMaterializedBuildPublishable } from "./knowledge-base-materialized-quality";
import {
  effectiveKnowledgeArchiveCharacterCount,
  knowledgeArchiveFormalText,
  markedKnowledgeArchiveFormalContent,
} from "./knowledge-archive-text-utils";
import {
  createDefaultDashboardPayload,
  dashboardPayloadSchema,
  type DashboardPayload,
} from "../shared/dashboard";
import {
  customerSafeKnowledgeFilename,
  toCustomerSafeKnowledgeAsset,
  toCustomerSafeKnowledgeDocument,
} from "../shared/knowledge-base-public-artifacts";
import { lockActiveWebsiteProjectLifecycle } from "./website-project-lifecycle";
import { isExplicitAdminAccessLevel } from "../shared/admin-access";
import type {
  ServicePortal,
  WorkspaceQuestionCategory,
} from "../shared/service-portal";
import {
  AuthServiceError,
  decryptApiKey,
  deleteActiveApiCredential,
  getEffectiveDecryptedCredentialForAccount,
  getEffectiveApiCredentialStatus,
  getOwnedUpstreamResourceIds,
  replaceApiCredential,
  type AuthenticatedUser,
} from "./auth-service";
import { getDb } from "./db";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  deriveEffectiveServiceStatus,
  getServicePortal,
  selectPortalContract,
  type ServicePortalContractRecord,
} from "./service-entitlement";
import { isKnowledgeSnapshotArchiveAvailable } from "./knowledge-snapshot-archive-store";
import {
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import {
  claimUsageCredentialCoverage,
  hasCompleteExpectedTaskSet,
  loadTerminalUsageTaskProofs,
  loadUsageCoverage,
  isUsageTaskTerminal,
  markUsageCredentialCoverage,
  readManagedUsageLedger,
  recordUsageLedgerEntries,
  selectPhysicalCredentialRows,
  usageCoverageSupportsRetiredCredential,
} from "./api-usage-ledger";
import { usagePageReachedCutoff } from "./upstream-task-usage";
import { getManusRollingCreditUsage } from "./manus-usage-service";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";

const CREDIT_PAGE_LIMIT = 100;
const CREDIT_MAX_PAGES = 100;

export class DashboardEnterpriseMismatchError extends AuthServiceError {
  constructor() {
    super(
      "CONFLICT",
      "该账号已有企业数据。为避免知识库、监控和应答逻辑串库，请新建用户账号后再导入另一企业。",
    );
    this.name = "DashboardEnterpriseMismatchError";
  }
}

export class DashboardRevisionConflictError extends AuthServiceError {
  constructor() {
    super("CONFLICT", "该用户看板已被其他管理员更新，请刷新后再保存本次修改。");
    this.name = "DashboardRevisionConflictError";
  }
}

export function resolveDashboardWorkspacePayload(input: {
  storedPayload: unknown;
  hasStoredContent: boolean;
  displayName: string;
}) {
  if (!input.hasStoredContent) {
    return createDefaultDashboardPayload(input.displayName);
  }

  const parsed = dashboardPayloadSchema.safeParse(input.storedPayload);
  if (!parsed.success) {
    throw new AuthServiceError(
      "CONFLICT",
      "看板内容校验失败，请联系管理员修复当前发布版本。",
    );
  }
  return parsed.data;
}

function dashboardReportAssetPrefix(userId: number) {
  return `/api/dashboard/report-assets/${userId}/`;
}

export function assertDashboardReportAssetScope(
  payload: DashboardPayload,
  userId: number,
) {
  const expectedPrefix = dashboardReportAssetPrefix(userId);
  const reports = [
    payload.optimizationReport,
    ...payload.progressReports.map((version) => version.report),
  ].filter(
    (report): report is NonNullable<DashboardPayload["optimizationReport"]> =>
      Boolean(report),
  );

  for (const report of reports) {
    for (const question of report.questionReports ?? []) {
      for (const sample of [question.before, question.after]) {
        for (const screenshot of sample.screenshots) {
          if (!screenshot.url.startsWith(expectedPrefix)) {
            throw new AuthServiceError(
              "CONFLICT",
              "答案截图必须来自当前客户的受保护报告资产。",
            );
          }
        }
      }
    }
  }
}

function normalizedEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function assertDashboardEnterpriseIdentity(
  existing: {
    enterpriseIdentityBoundAt: number | null;
    payload: Pick<DashboardPayload, "brandName">;
  },
  next: Pick<DashboardPayload, "brandName">,
) {
  if (!existing.enterpriseIdentityBoundAt) return;
  if (
    normalizedEnterpriseName(existing.payload.brandName) !==
    normalizedEnterpriseName(next.brandName)
  ) {
    throw new DashboardEnterpriseMismatchError();
  }
}

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

export function isSystemAdmin(
  user: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">,
) {
  return hasSystemAdminAccess(user);
}

async function getTargetUser(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const target = rows[0];
  if (!target || !target.isActive || target.role !== "user") {
    throw new AuthServiceError("NOT_FOUND", "User not found");
  }
  return target;
}

export async function canManageWorkspaceUser(
  actor: AuthenticatedUser,
  targetUserId: number,
) {
  if (actor.role !== "admin") return false;
  if (isSystemAdmin(actor)) return true;
  const db = await requireDb();
  const rows = await db
    .select({ id: userAdminAssignments.id })
    .from(userAdminAssignments)
    .where(
      and(
        eq(userAdminAssignments.userId, targetUserId),
        eq(userAdminAssignments.adminId, actor.id),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

export async function assertWorkspaceAccess(
  actor: AuthenticatedUser,
  targetUserId: number,
) {
  if (actor.id === targetUserId && actor.role === "user") {
    await getTargetUser(targetUserId);
    return;
  }
  if (await canManageWorkspaceUser(actor, targetUserId)) {
    await getTargetUser(targetUserId);
    return;
  }
  throw new AuthServiceError("NOT_FOUND", "User workspace not found");
}

export function assertManagedCredentialMutationAccess(
  actor: Pick<
    AuthenticatedUser,
    "id" | "role" | "username" | "adminAccessLevel"
  >,
  _deliveryAdminId: number | null | undefined,
) {
  if (isSystemAdmin(actor)) return;
  throw new AuthServiceError(
    "INVALID_CREDENTIAL",
    "客户 API Key 仅由系统管理员统一维护",
  );
}

function toPublicOptimizationReport(
  report: NonNullable<DashboardPayload["optimizationReport"]>,
): NonNullable<DashboardPayload["optimizationReport"]> {
  if (!report.questionReports) return report;
  return {
    ...report,
    questionReports: report.questionReports.map((question) => {
      if (question.afterEffect?.released) return question;
      const { afterEffect: _restrictedAfterEffect, ...publicQuestion } =
        question;
      return publicQuestion;
    }),
  };
}

export function toPublicDashboardPayload(
  payload: DashboardPayload,
): DashboardPayload {
  return {
    ...payload,
    optimizationReport: payload.optimizationReport
      ? toPublicOptimizationReport(payload.optimizationReport)
      : null,
    progressReports: payload.progressReports.map((version) => ({
      ...version,
      report: toPublicOptimizationReport(version.report),
    })),
  };
}

export async function getDashboardWorkspace(userId: number) {
  const db = await requireDb();
  const [contentRows, snapshotRows, userRows] = await Promise.all([
    db
      .select()
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, userId))
      .limit(1),
    db
      .select({
        version: knowledgeBaseSnapshots.version,
        documentCount: knowledgeBaseSnapshots.documentCount,
        imageCount: knowledgeBaseSnapshots.imageCount,
        characterCount: knowledgeBaseSnapshots.characterCount,
        createdAt: knowledgeBaseSnapshots.createdAt,
      })
      .from(knowledgeBaseSnapshots)
      .where(
        and(
          eq(knowledgeBaseSnapshots.userId, userId),
          eq(knowledgeBaseSnapshots.status, "active"),
        ),
      )
      .orderBy(desc(knowledgeBaseSnapshots.version))
      .limit(1),
    db
      .select({
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  const content = contentRows[0];
  const displayName =
    userRows[0]?.displayName || userRows[0]?.username || "企业知识中枢";
  const payload = resolveDashboardWorkspacePayload({
    storedPayload: content?.payload,
    hasStoredContent: Boolean(content),
    displayName,
  });
  return {
    // Keep the administrator-authored dashboard payload lossless. Knowledge
    // snapshot counts belong to the knowledge viewer; injecting them here
    // would be written back by the editor and overwrite real customer metrics.
    payload,
    sourceName: content?.sourceName ?? null,
    enterpriseIdentityBoundAt:
      content?.enterpriseIdentityBoundAt?.getTime() ?? null,
    revision: content?.revision ?? 0,
    updatedAt: content?.updatedAt?.getTime() ?? null,
    knowledgeUpdatedAt: snapshotRows[0]?.createdAt?.getTime() ?? null,
  };
}

export function selectEditableServiceQuestion(
  portal: ServicePortal,
  questionId: string,
) {
  const exactQuestion = portal.purchasedQuestions.find(
    (item) => item.id === questionId,
  );
  const historicalIdentityMatch = portal.historicalQuestions.some((item) =>
    [item.id, item.externalQuestionId, item.sourceQuestionId]
      .filter(Boolean)
      .includes(questionId),
  );
  // A historical server ID must never fall through to an active question via
  // a reused external/source identity. Editors and model routes use the
  // current workspace-question ID issued by the portal.
  const serviceQuestion =
    exactQuestion ??
    (!historicalIdentityMatch
      ? portal.purchasedQuestions.find(
          (item) => item.externalQuestionId === questionId,
        )
      : undefined);
  return serviceQuestion ?? null;
}

export function dashboardQuestionGroupForCategory(
  category: WorkspaceQuestionCategory,
) {
  return {
    industry: { id: "ranking", title: "行业排名词" },
    competitor_comparison: { id: "comparison", title: "竞品对比词" },
    reputation: { id: "reputation", title: "美誉舆情词" },
    product_scenario: { id: "basic", title: "产品场景词" },
  }[category];
}

export async function getDashboardQuestion(userId: number, questionId: string) {
  const portal = await getServicePortal(userId);
  const serviceQuestion = selectEditableServiceQuestion(portal, questionId);
  if (!serviceQuestion) return null;
  const group = dashboardQuestionGroupForCategory(serviceQuestion.category);
  return {
    questionId: serviceQuestion.id,
    groupId: group.id,
    groupTitle: group.title,
    question: serviceQuestion.question,
    intent: serviceQuestion.intent ?? "",
    summary: serviceQuestion.rationale ?? "",
    writeScope: {
      revision: serviceQuestion.revision,
      contractId: serviceQuestion.contractId,
      quotaPeriodId: serviceQuestion.quotaPeriodId,
    },
  };
}

function reportFingerprint(
  report: DashboardPayload["optimizationReport"],
): string {
  return report ? JSON.stringify(report) : "";
}

export function mergeProgressReportHistory(input: {
  previous: DashboardPayload | null;
  next: DashboardPayload;
  nextRevision: number;
  publishedAt: number;
  previousPublishedAt?: number | null;
}): DashboardPayload {
  const versions = new Map(
    [
      ...(input.previous?.progressReports ?? []),
      ...input.next.progressReports,
    ].map((version) => [
      `${version.revision}:${reportFingerprint(version.report)}`,
      version,
    ]),
  );
  const append = (
    report: NonNullable<DashboardPayload["optimizationReport"]>,
    revision: number,
    publishedAt: number,
  ) => {
    const fingerprint = reportFingerprint(report);
    if (
      [...versions.values()].some(
        (version) => reportFingerprint(version.report) === fingerprint,
      )
    ) {
      return;
    }
    versions.set(`${revision}:${fingerprint}`, {
      id: `progress-report-r${revision}`,
      revision,
      publishedAt,
      report,
    });
  };

  if (input.previous?.optimizationReport) {
    append(
      input.previous.optimizationReport,
      Math.max(1, input.nextRevision - 1),
      input.previousPublishedAt ?? input.publishedAt,
    );
  }
  if (input.next.optimizationReport) {
    append(
      input.next.optimizationReport,
      input.nextRevision,
      input.publishedAt,
    );
  }

  return {
    ...input.next,
    progressReports: [...versions.values()]
      .sort(
        (left, right) =>
          left.revision - right.revision ||
          left.publishedAt - right.publishedAt,
      )
      .slice(-100),
  };
}

export type DashboardContentRevisionSummary = {
  id: string;
  revision: number;
  sourceName: string | null;
  publicationKind: "publish" | "rollback" | "migration";
  rolledBackFromRevision: number | null;
  publishedByUserId: number | null;
  enterpriseIdentityBound: boolean;
  createdAt: number;
  isCurrent: boolean;
};

export function toDashboardContentRevisionSummary(
  row: Pick<
    WorkspaceContentRevision,
    | "id"
    | "revision"
    | "sourceName"
    | "publicationKind"
    | "rolledBackFromRevision"
    | "publishedByUserId"
    | "enterpriseIdentityBoundAt"
    | "createdAt"
  >,
  currentRevision: number,
): DashboardContentRevisionSummary {
  return {
    id: row.id,
    revision: row.revision,
    sourceName: row.sourceName,
    publicationKind: row.publicationKind,
    rolledBackFromRevision: row.rolledBackFromRevision,
    publishedByUserId: row.publishedByUserId,
    enterpriseIdentityBound: Boolean(row.enterpriseIdentityBoundAt),
    createdAt: row.createdAt.getTime(),
    isCurrent: row.revision === currentRevision,
  };
}

export type DashboardWorkspaceWriteContext = {
  currentRevision: number;
  nextRevision: number;
  payload: DashboardPayload;
  sourceName: string;
  enterpriseIdentityBoundAt: Date | null;
  publishedAt: Date;
};

export type DashboardWorkspaceWriteHook = (
  executor: any,
  context: DashboardWorkspaceWriteContext,
) => Promise<void>;

export async function updateDashboardWorkspace(input: {
  userId: number;
  actorUserId: number;
  payload: DashboardPayload;
  sourceName: string;
  reason?: string;
  bindEnterpriseIdentity?: boolean;
  expectedRevision?: number;
  progressReportPeriods?: Array<{
    contractId: string;
    quotaPeriodId: string;
  }>;
  beforeWrite?: DashboardWorkspaceWriteHook;
  afterWrite?: DashboardWorkspaceWriteHook;
}) {
  const db = await requireDb();
  const incomingPayload = dashboardPayloadSchema.parse(input.payload);
  assertDashboardReportAssetScope(incomingPayload, input.userId);
  await db.transaction(async (tx) => {
    const now = new Date();
    const targetRows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetRows[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    const existingRows = await tx
      .select({
        revision: userDashboardContents.revision,
        payload: userDashboardContents.payload,
        updatedAt: userDashboardContents.updatedAt,
        enterpriseIdentityBoundAt:
          userDashboardContents.enterpriseIdentityBoundAt,
      })
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, input.userId))
      .limit(1);
    const existing = existingRows[0];
    const currentRevision = existing?.revision ?? 0;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== currentRevision
    ) {
      throw new DashboardRevisionConflictError();
    }
    const previousPayload = existing
      ? dashboardPayloadSchema.safeParse(existing.payload)
      : null;
    const payload = mergeProgressReportHistory({
      previous: previousPayload?.success ? previousPayload.data : null,
      next: incomingPayload,
      nextRevision: currentRevision + 1,
      publishedAt: now.getTime(),
      previousPublishedAt: existing?.updatedAt?.getTime() ?? null,
    });
    const nextRevision = currentRevision + 1;
    const enterpriseIdentityBoundAt =
      existing?.enterpriseIdentityBoundAt ??
      (input.bindEnterpriseIdentity ? now : null);
    const writeContext: DashboardWorkspaceWriteContext = {
      currentRevision,
      nextRevision,
      payload,
      sourceName: input.sourceName,
      enterpriseIdentityBoundAt,
      publishedAt: now,
    };
    await input.beforeWrite?.(tx, writeContext);
    if (!existing) {
      await tx.insert(userDashboardContents).values({
        userId: input.userId,
        payload,
        sourceName: input.sourceName,
        enterpriseIdentityBoundAt,
        revision: nextRevision,
        updatedByUserId: input.actorUserId,
      });
    } else {
      await tx
        .update(userDashboardContents)
        .set({
          payload,
          sourceName: input.sourceName,
          ...(input.bindEnterpriseIdentity &&
          !existing.enterpriseIdentityBoundAt
            ? { enterpriseIdentityBoundAt: now }
            : {}),
          revision: nextRevision,
          updatedByUserId: input.actorUserId,
          updatedAt: now,
        })
        .where(eq(userDashboardContents.userId, input.userId));
    }
    await tx.insert(workspaceContentRevisions).values({
      id: randomUUID(),
      userId: input.userId,
      module: "dashboard",
      revision: nextRevision,
      payload,
      sourceName: input.sourceName,
      enterpriseIdentityBoundAt,
      publicationKind: "publish",
      rolledBackFromRevision: null,
      publishedByUserId: input.actorUserId,
      reason: input.reason?.trim() || null,
      createdAt: now,
    });
    if (
      incomingPayload.optimizationReport &&
      input.progressReportPeriods?.length
    ) {
      await tx.insert(serviceProgressReports).values(
        input.progressReportPeriods.map((period) => ({
          id: randomUUID(),
          userId: input.userId,
          contractId: period.contractId,
          quotaPeriodId: period.quotaPeriodId,
          payload: incomingPayload.optimizationReport!,
          sourceName: input.sourceName,
          revision: nextRevision,
          publishedByUserId: input.actorUserId,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await input.afterWrite?.(tx, writeContext);
  });
  return getDashboardWorkspace(input.userId);
}

async function assertAdministratorWorkspaceAccess(
  actor: AuthenticatedUser,
  userId: number,
) {
  if (actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  await assertWorkspaceAccess(actor, userId);
}

export async function listDashboardContentRevisions(input: {
  actor: AuthenticatedUser;
  userId: number;
  limit?: number;
  beforeRevision?: number;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const conditions = [
    eq(workspaceContentRevisions.userId, input.userId),
    eq(workspaceContentRevisions.module, "dashboard"),
  ];
  if (input.beforeRevision !== undefined) {
    conditions.push(
      lt(workspaceContentRevisions.revision, input.beforeRevision),
    );
  }
  const [currentRows, rows] = await Promise.all([
    db
      .select({ revision: userDashboardContents.revision })
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, input.userId))
      .limit(1),
    db
      .select({
        id: workspaceContentRevisions.id,
        revision: workspaceContentRevisions.revision,
        sourceName: workspaceContentRevisions.sourceName,
        publicationKind: workspaceContentRevisions.publicationKind,
        rolledBackFromRevision:
          workspaceContentRevisions.rolledBackFromRevision,
        publishedByUserId: workspaceContentRevisions.publishedByUserId,
        enterpriseIdentityBoundAt:
          workspaceContentRevisions.enterpriseIdentityBoundAt,
        createdAt: workspaceContentRevisions.createdAt,
      })
      .from(workspaceContentRevisions)
      .where(and(...conditions))
      .orderBy(desc(workspaceContentRevisions.revision))
      .limit(limit + 1),
  ]);
  const currentRevision = currentRows[0]?.revision ?? 0;
  const page = rows.slice(0, limit);
  return {
    currentRevision,
    versions: page.map((row) =>
      toDashboardContentRevisionSummary(row, currentRevision),
    ),
    nextCursor:
      rows.length > limit && page.length
        ? page[page.length - 1]!.revision
        : null,
  };
}

export async function getDashboardContentRevision(input: {
  actor: AuthenticatedUser;
  userId: number;
  revision: number;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  const [currentRows, rows] = await Promise.all([
    db
      .select({ revision: userDashboardContents.revision })
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, input.userId))
      .limit(1),
    db
      .select()
      .from(workspaceContentRevisions)
      .where(
        and(
          eq(workspaceContentRevisions.userId, input.userId),
          eq(workspaceContentRevisions.module, "dashboard"),
          eq(workspaceContentRevisions.revision, input.revision),
        ),
      )
      .limit(1),
  ]);
  const row = rows[0];
  if (!row) {
    throw new AuthServiceError("NOT_FOUND", "发布版本不存在");
  }
  const payload = dashboardPayloadSchema.safeParse(row.payload);
  if (!payload.success) {
    throw new AuthServiceError("CONFLICT", "发布版本内容无法通过结构校验");
  }
  const currentRevision = currentRows[0]?.revision ?? 0;
  return {
    currentRevision,
    version: {
      ...toDashboardContentRevisionSummary(row, currentRevision),
      payload: payload.data,
      reason: row.reason,
    },
  };
}

export function prepareDashboardContentRollback(input: {
  current: Pick<
    typeof userDashboardContents.$inferSelect,
    "revision" | "payload" | "sourceName" | "enterpriseIdentityBoundAt"
  >;
  target: Pick<
    WorkspaceContentRevision,
    "revision" | "payload" | "sourceName" | "enterpriseIdentityBoundAt"
  >;
  expectedRevision: number;
}) {
  if (input.current.revision !== input.expectedRevision) {
    throw new DashboardRevisionConflictError();
  }
  if (input.target.revision >= input.current.revision) {
    throw new AuthServiceError("CONFLICT", "目标版本必须早于当前发布版本");
  }
  const currentPayload = dashboardPayloadSchema.safeParse(
    input.current.payload,
  );
  const targetPayload = dashboardPayloadSchema.safeParse(input.target.payload);
  if (!currentPayload.success || !targetPayload.success) {
    throw new AuthServiceError("CONFLICT", "发布版本内容无法通过结构校验");
  }
  assertDashboardEnterpriseIdentity(
    {
      enterpriseIdentityBoundAt:
        input.current.enterpriseIdentityBoundAt?.getTime() ?? null,
      payload: currentPayload.data,
    },
    targetPayload.data,
  );
  return {
    payload: targetPayload.data,
    sourceName: input.target.sourceName,
    enterpriseIdentityBoundAt:
      input.current.enterpriseIdentityBoundAt ??
      input.target.enterpriseIdentityBoundAt ??
      null,
    nextRevision: input.current.revision + 1,
    rolledBackFromRevision: input.target.revision,
  };
}

export async function rollbackDashboardContentRevision(input: {
  actor: AuthenticatedUser;
  userId: number;
  targetRevision: number;
  expectedRevision: number;
  reason?: string;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.userId);
  const db = await requireDb();
  let nextRevision = 0;
  await db.transaction(async (tx) => {
    // Every dashboard writer locks the same customer row, so publish and
    // rollback share one optimistic revision boundary.
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    const currentRows = await tx
      .select()
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, input.userId))
      .limit(1)
      .for("update");
    const current = currentRows[0];
    if (!current) {
      throw new AuthServiceError("NOT_FOUND", "当前工作区尚未发布内容");
    }
    if (current.revision !== input.expectedRevision) {
      throw new DashboardRevisionConflictError();
    }
    if (input.targetRevision >= current.revision) {
      throw new AuthServiceError("CONFLICT", "目标版本必须早于当前发布版本");
    }
    const targetRows = await tx
      .select()
      .from(workspaceContentRevisions)
      .where(
        and(
          eq(workspaceContentRevisions.userId, input.userId),
          eq(workspaceContentRevisions.module, "dashboard"),
          eq(workspaceContentRevisions.revision, input.targetRevision),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      throw new AuthServiceError("NOT_FOUND", "目标发布版本不存在");
    }
    const rollback = prepareDashboardContentRollback({
      current,
      target,
      expectedRevision: input.expectedRevision,
    });
    assertDashboardReportAssetScope(rollback.payload, input.userId);

    const now = new Date();
    nextRevision = rollback.nextRevision;
    await tx
      .update(userDashboardContents)
      .set({
        payload: rollback.payload,
        sourceName: rollback.sourceName,
        enterpriseIdentityBoundAt: rollback.enterpriseIdentityBoundAt,
        revision: nextRevision,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(userDashboardContents.userId, input.userId));
    await tx.insert(workspaceContentRevisions).values({
      id: randomUUID(),
      userId: input.userId,
      module: "dashboard",
      revision: nextRevision,
      payload: rollback.payload,
      sourceName: rollback.sourceName,
      enterpriseIdentityBoundAt: rollback.enterpriseIdentityBoundAt,
      publicationKind: "rollback",
      rolledBackFromRevision: rollback.rolledBackFromRevision,
      publishedByUserId: input.actor.id,
      reason: input.reason?.trim() || null,
      createdAt: now,
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "workspace.dashboard.rolled_back",
        targetType: "dashboard",
        targetId: `${input.userId}:r${nextRevision}`,
        workspaceUserId: input.userId,
        reason: input.reason,
        metadata: {
          expectedRevision: input.expectedRevision,
          targetRevision: input.targetRevision,
          revision: nextRevision,
        },
      },
      tx,
    );
  });
  return {
    dashboard: await getDashboardWorkspace(input.userId),
    rolledBackFromRevision: input.targetRevision,
    revision: nextRevision,
  };
}

export function toKnowledgeSnapshotPublicJson<
  T extends {
    id: string;
    version: number;
    sourceFileName: string;
    archiveHash: string | null;
    documents: KnowledgeDocumentRecord[];
    documentCount: number;
    imageCount: number;
    characterCount: number;
    totalBytes: number;
    assets: KnowledgeAssetRecord[];
    status: "active" | "archived";
    createdAt: Date;
  },
>(snapshot: T, archiveAvailable: boolean) {
  const publicAssetIds = new Map<string, string>();
  snapshot.assets.forEach((asset, index) => {
    const internalId = String(asset.id || "").trim();
    if (internalId && !publicAssetIds.has(internalId)) {
      publicAssetIds.set(internalId, `public-asset-${index + 1}`);
    }
  });
  return {
    id: snapshot.id,
    version: snapshot.version,
    sourceFileName: customerSafeKnowledgeFilename(snapshot.sourceFileName),
    archiveHash: snapshot.archiveHash,
    documents: snapshot.documents.map((document) => {
      const projected = toCustomerSafeKnowledgeDocument(
        document as unknown as Record<string, unknown>,
      ) as unknown as KnowledgeDocumentRecord;
      return {
        ...projected,
        ...(Array.isArray(document.assetIds)
          ? {
              assetIds: document.assetIds
                .map((assetId) => publicAssetIds.get(String(assetId).trim()))
                .filter((assetId): assetId is string => Boolean(assetId)),
            }
          : {}),
      };
    }) as KnowledgeDocumentRecord[],
    documentCount: snapshot.documentCount,
    imageCount: snapshot.imageCount,
    characterCount: snapshot.characterCount,
    totalBytes: snapshot.totalBytes,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    archiveAvailable,
    assets: snapshot.assets.map((asset, index) => {
      const projected = toCustomerSafeKnowledgeAsset(
        asset as unknown as Record<string, unknown>,
        index,
      ) as unknown as KnowledgeAssetRecord;
      return {
        ...projected,
        // The public URL never embeds a raw provider-owned asset identifier.
        url: `/api/dashboard/knowledge/assets/${snapshot.id}/${index}`,
      };
    }),
  };
}

async function publicKnowledgeSnapshot<
  T extends {
    id: string;
    userId: number;
    version: number;
    sourceFileName: string;
    archiveHash: string | null;
    documents: KnowledgeDocumentRecord[];
    documentCount: number;
    imageCount: number;
    characterCount: number;
    totalBytes: number;
    assets: KnowledgeAssetRecord[];
    status: "active" | "archived";
    createdAt: Date;
  },
>(snapshot: T) {
  const archiveAvailable =
    snapshot.sourceFileName.toLowerCase().endsWith(".zip") &&
    /^[a-f0-9]{64}$/i.test(snapshot.archiveHash || "") &&
    (await isKnowledgeSnapshotArchiveAvailable({
      userId: snapshot.userId,
      snapshotId: snapshot.id,
      expectedBytes: snapshot.totalBytes,
    }));
  return toKnowledgeSnapshotPublicJson(snapshot, archiveAvailable);
}

export async function getLatestKnowledgeSnapshot(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.userId, userId),
        eq(knowledgeBaseSnapshots.status, "active"),
      ),
    )
    .orderBy(desc(knowledgeBaseSnapshots.version))
    .limit(1);
  return rows[0] ? publicKnowledgeSnapshot(rows[0]) : null;
}

export async function getKnowledgeSnapshotById(input: {
  userId: number;
  snapshotId: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(knowledgeBaseSnapshots)
    .where(
      and(
        eq(knowledgeBaseSnapshots.id, input.snapshotId),
        eq(knowledgeBaseSnapshots.userId, input.userId),
      ),
    )
    .limit(1);
  return rows[0] ? publicKnowledgeSnapshot(rows[0]) : null;
}

export async function getKnowledgeSnapshotForWorkspace(input: {
  actor: AuthenticatedUser;
  snapshotId: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(knowledgeBaseSnapshots)
    .where(eq(knowledgeBaseSnapshots.id, input.snapshotId))
    .limit(1);
  const snapshot = rows[0];
  if (!snapshot) return null;
  await assertWorkspaceAccess(input.actor, snapshot.userId);
  // This record is consumed only by the authenticated archive endpoint, which
  // needs immutable publication coordinates to validate the stored bytes. It
  // is never serialized as snapshot JSON.
  return snapshot;
}

export async function getKnowledgeAsset(input: {
  snapshotId: string;
  assetIndex: number;
}) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: knowledgeBaseSnapshots.id,
      userId: knowledgeBaseSnapshots.userId,
      assets: knowledgeBaseSnapshots.assets,
    })
    .from(knowledgeBaseSnapshots)
    .where(eq(knowledgeBaseSnapshots.id, input.snapshotId))
    .limit(1);
  const snapshot = rows[0];
  const asset = snapshot?.assets[input.assetIndex];
  return snapshot && asset ? { snapshot, asset } : null;
}

export async function getKnowledgeAssetById(input: {
  snapshotId: string;
  assetId: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: knowledgeBaseSnapshots.id,
      userId: knowledgeBaseSnapshots.userId,
      assets: knowledgeBaseSnapshots.assets,
    })
    .from(knowledgeBaseSnapshots)
    .where(eq(knowledgeBaseSnapshots.id, input.snapshotId))
    .limit(1);
  const snapshot = rows[0];
  const asset = snapshot?.assets.find(
    (candidate) => candidate.id === input.assetId,
  );
  return snapshot && asset ? { snapshot, asset } : null;
}

export function knowledgeSnapshotFormalCharacterCount(
  documents: readonly Pick<
    KnowledgeDocumentRecord,
    "content" | "customerVisible"
  >[],
) {
  return documents.reduce(
    (total, document) =>
      total +
      (document.customerVisible === false
        ? 0
        : effectiveKnowledgeArchiveCharacterCount(
            knowledgeArchiveFormalText(
              markedKnowledgeArchiveFormalContent(document.content) ??
                document.content,
            ),
          )),
    0,
  );
}

export async function createKnowledgeSnapshot(input: {
  snapshotId?: string;
  userId: number;
  actorUserId: number;
  sourceFileName: string;
  sourceConversationId?: string;
  sourceBuildId?: string;
  sourceBuildRevision?: number;
  sourceTaskId?: string;
  sourceArtifactHash?: string;
  archiveHash?: string;
  maintenanceTicketId?: string;
  documents: KnowledgeDocumentRecord[];
  assets: KnowledgeAssetRecord[];
  totalBytes: number;
  importReceiptClaim?: {
    receiptId: string;
    claimRevision: number;
  };
}) {
  const db = await requireDb();
  const id = input.snapshotId ?? randomUUID();
  const characterCount = knowledgeSnapshotFormalCharacterCount(input.documents);
  const importProjectBindings = input.importReceiptClaim
    ? await db
        .select({ projectId: knowledgeImportReceipts.projectId })
        .from(knowledgeImportReceipts)
        .where(
          eq(knowledgeImportReceipts.id, input.importReceiptClaim.receiptId),
        )
        .limit(1)
    : [];
  await db.transaction(async (tx) => {
    if (importProjectBindings[0]?.projectId) {
      await lockActiveWebsiteProjectLifecycle(
        tx,
        importProjectBindings[0].projectId,
      );
    }
    let publicationUsesArchiveHash = false;
    let publicationStateEpoch: number | null = null;
    const lockedUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!lockedUsers[0]) {
      throw new Error("用户不存在");
    }
    if (input.importReceiptClaim) {
      const receiptRows = await tx
        .select({
          id: knowledgeImportReceipts.id,
          userId: knowledgeImportReceipts.userId,
          status: knowledgeImportReceipts.status,
          revision: knowledgeImportReceipts.revision,
        })
        .from(knowledgeImportReceipts)
        .where(
          eq(knowledgeImportReceipts.id, input.importReceiptClaim.receiptId),
        )
        .limit(1)
        .for("update");
      const receipt = receiptRows[0];
      if (
        !receipt ||
        receipt.userId !== input.userId ||
        receipt.status !== "processing" ||
        receipt.revision !== input.importReceiptClaim.claimRevision
      ) {
        throw new Error("知识库导入回执已由其他请求接管");
      }
    }
    if (input.sourceBuildId) {
      const builds = await tx
        .select({
          id: knowledgeBaseBuilds.id,
          generation: knowledgeBaseBuilds.generation,
          executionMode: knowledgeBaseBuilds.executionMode,
          providerProtocol: knowledgeBaseBuilds.providerProtocol,
          skillVersion: knowledgeBaseBuilds.skillVersion,
          skillContentHash: knowledgeBaseBuilds.skillContentHash,
          activeWorkingSetId: knowledgeBaseBuilds.activeWorkingSetId,
          contentVersion: knowledgeBaseBuilds.contentVersion,
          treePolicyVersion: knowledgeBaseBuilds.treePolicyVersion,
          totalNodeCount: knowledgeBaseBuilds.totalNodeCount,
          initialResearchCoverage: knowledgeBaseBuilds.initialResearchCoverage,
          handoffProvenance: knowledgeBaseBuilds.handoffProvenance,
          status: knowledgeBaseBuilds.status,
          revision: knowledgeBaseBuilds.revision,
          upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
          canonicalTaskId: knowledgeBaseBuilds.canonicalTaskId,
          packageRevision: knowledgeBaseBuilds.packageRevision,
          packageTaskId: knowledgeBaseBuilds.packageTaskId,
          packageDescriptorHash: knowledgeBaseBuilds.packageDescriptorHash,
          packageArchiveSha256: knowledgeBaseBuilds.packageArchiveSha256,
          stateEpoch: knowledgeBaseBuilds.stateEpoch,
        })
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.sourceBuildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (builds[0]?.status !== "ready_to_publish") {
        throw new Error(
          builds[0]?.status === "published"
            ? "当前知识库已同步，请先在构建流程中补充内容"
            : "知识库尚未完成全部节点确认",
        );
      }
      if (
        builds[0].executionMode === "materialized_bundle_v1" &&
        !isMaterializedBuildPublishable(builds[0])
      ) {
        throw new Error(
          "知识库内容或研究覆盖不完整；当前内容可以查看，但不能发布，请批准重置后重跑",
        );
      }
      if (
        input.sourceBuildRevision === undefined ||
        input.sourceTaskId === undefined ||
        input.sourceArtifactHash === undefined ||
        input.archiveHash === undefined ||
        builds[0].revision !== input.sourceBuildRevision ||
        builds[0].packageRevision !== input.sourceBuildRevision ||
        knowledgeBasePackageWriterTaskId(builds[0]) !== input.sourceTaskId ||
        builds[0].packageTaskId !== input.sourceTaskId ||
        knowledgeBasePublicationBindingHash(builds[0]) !==
          input.sourceArtifactHash
      ) {
        throw new Error("知识库完成版本已变化，请刷新后重新更新");
      }
      publicationUsesArchiveHash = Boolean(builds[0].packageArchiveSha256);
      publicationStateEpoch = builds[0].stateEpoch;
    }
    const latest = await tx
      .select({ version: knowledgeBaseSnapshots.version })
      .from(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, input.userId))
      .orderBy(desc(knowledgeBaseSnapshots.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;
    await tx
      .update(knowledgeBaseSnapshots)
      .set({ status: "archived" })
      .where(
        and(
          eq(knowledgeBaseSnapshots.userId, input.userId),
          eq(knowledgeBaseSnapshots.status, "active"),
        ),
      );
    await tx.insert(knowledgeBaseSnapshots).values({
      id,
      userId: input.userId,
      version,
      sourceFileName: input.sourceFileName,
      sourceConversationId: input.sourceConversationId,
      sourceBuildId: input.sourceBuildId,
      sourceBuildRevision: input.sourceBuildRevision,
      sourceTaskId: input.sourceTaskId,
      siteOpsKnowledgeInputEpochId: null,
      sourceArtifactHash: input.sourceArtifactHash,
      archiveHash: input.archiveHash,
      maintenanceTicketId: input.maintenanceTicketId,
      documents: input.documents,
      assets: input.assets,
      documentCount: input.documents.length,
      imageCount: input.assets.length,
      characterCount,
      totalBytes: input.totalBytes,
      status: "active",
      createdByUserId: input.actorUserId,
    });
    if (input.importReceiptClaim) {
      const completedAt = new Date();
      const result = await tx
        .update(knowledgeImportReceipts)
        .set({
          status: "completed",
          snapshotId: id,
          sourceFileName: input.sourceFileName,
          completedAt,
          errorCode: null,
          errorMessage: null,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(knowledgeImportReceipts.id, input.importReceiptClaim.receiptId),
            eq(knowledgeImportReceipts.userId, input.userId),
            eq(knowledgeImportReceipts.status, "processing"),
            eq(
              knowledgeImportReceipts.revision,
              input.importReceiptClaim.claimRevision,
            ),
          ),
        );
      if (!result[0]?.affectedRows) {
        throw new Error("知识库导入回执已由其他请求接管");
      }
    }
    if (input.sourceBuildId) {
      const publicationHashColumn = publicationUsesArchiveHash
        ? eq(
            knowledgeBaseBuilds.packageArchiveSha256,
            input.sourceArtifactHash!,
          )
        : eq(
            knowledgeBaseBuilds.packageDescriptorHash,
            input.sourceArtifactHash!,
          );
      const result = await tx
        .update(knowledgeBaseBuilds)
        .set({
          status: "published",
          stateEpoch: publicationStateEpoch! + 1,
          publishedSnapshotId: id,
          publishedAt: new Date(),
          protocolError: null,
          protocolErrorCode: null,
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.sourceBuildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.status, "ready_to_publish"),
            eq(knowledgeBaseBuilds.revision, input.sourceBuildRevision!),
            eq(knowledgeBaseBuilds.stateEpoch, publicationStateEpoch!),
            eq(knowledgeBaseBuilds.packageTaskId, input.sourceTaskId!),
            publicationHashColumn,
          ),
        );
      if (!result[0]?.affectedRows) {
        throw new Error("知识库完成版本已变化，请刷新后重新更新");
      }
    }
  });
  const snapshot = await getKnowledgeSnapshotById({
    userId: input.userId,
    snapshotId: id,
  });
  if (!snapshot) {
    throw new Error("知识库快照已写入但无法按标识读取");
  }
  return snapshot;
}

export async function listManagedWorkspaceUsers(actor: AuthenticatedUser) {
  const db = await requireDb();
  const systemAdmin = isSystemAdmin(actor);
  const allAssignments = systemAdmin
    ? await db.select().from(userAdminAssignments)
    : await db
        .select()
        .from(userAdminAssignments)
        .where(eq(userAdminAssignments.adminId, actor.id));
  const manageableIds = systemAdmin
    ? null
    : allAssignments
        .filter((assignment) => assignment.adminId === actor.id)
        .map((assignment) => assignment.userId);
  const userRows =
    manageableIds && manageableIds.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            marketEdition: users.marketEdition,
            isActive: users.isActive,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(
            manageableIds
              ? and(eq(users.role, "user"), inArray(users.id, manageableIds))
              : eq(users.role, "user"),
          )
          .orderBy(desc(users.createdAt));
  const adminRows = systemAdmin
    ? await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          isActive: users.isActive,
          adminAccessLevel: users.adminAccessLevel,
        })
        .from(users)
        .where(eq(users.role, "admin"))
    : [
        {
          id: actor.id,
          username: actor.username,
          displayName: actor.displayName,
          isActive: actor.isActive,
          adminAccessLevel: actor.adminAccessLevel ?? null,
        },
      ];
  const adminById = new Map(adminRows.map((admin) => [admin.id, admin]));
  const credentialRows = await db
    .select({
      userId: apiCredentials.userId,
      fingerprint: apiCredentials.fingerprint,
      validationStatus: apiCredentials.validationStatus,
      verifiedAt: apiCredentials.verifiedAt,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.status, "active"));
  const visibleUserIds = userRows.map((user) => user.id);
  const usageOwnerRows =
    visibleUserIds.length === 0
      ? []
      : await db
          .select({
            userId: userUsageOwners.userId,
            deliveryAdminId: userUsageOwners.deliveryAdminId,
            revision: userUsageOwners.revision,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, visibleUserIds));
  const dashboardRows =
    visibleUserIds.length === 0
      ? []
      : await db
          .select({
            userId: userDashboardContents.userId,
            payload: userDashboardContents.payload,
            sourceName: userDashboardContents.sourceName,
            revision: userDashboardContents.revision,
          })
          .from(userDashboardContents)
          .where(inArray(userDashboardContents.userId, visibleUserIds));
  const contractRows =
    visibleUserIds.length === 0
      ? []
      : await db
          .select()
          .from(serviceContracts)
          .where(inArray(serviceContracts.userId, visibleUserIds));
  const credentialByUser = new Map(
    credentialRows.map((credential) => [credential.userId, credential]),
  );
  const usageOwnerByUser = new Map(
    usageOwnerRows.map((owner) => [owner.userId, owner]),
  );
  const dashboardByUser = new Map(
    dashboardRows.map((dashboard) => {
      const parsed = dashboardPayloadSchema.safeParse(dashboard.payload);
      return [
        dashboard.userId,
        {
          enterpriseName: parsed.success ? parsed.data.brandName : null,
          configured: Boolean(dashboard.sourceName && parsed.success),
          revision: dashboard.revision,
        },
      ] as const;
    }),
  );
  const serviceByUser = new Map(
    visibleUserIds.map((userId) => {
      const contracts = contractRows.filter(
        (contract) => contract.userId === userId,
      );
      const current = selectPortalContract(
        contracts as ServicePortalContractRecord[],
      );
      return [
        userId,
        current
          ? {
              planCode: current.planCode,
              status: deriveEffectiveServiceStatus(current),
              revision: Math.max(
                ...contracts.map((contract) => contract.revision),
              ),
            }
          : {
              planCode: null,
              status: "unconfigured" as const,
              revision: 0,
            },
      ] as const;
    }),
  );
  return {
    isSystemAdmin: systemAdmin,
    // System administrators receive the full assignment directory. A delivery
    // administrator receives only their own account so the read-only assignee
    // chip can be resolved without disclosing peer administrator accounts.
    admins: adminRows,
    users: userRows.map((user) => {
      const usageOwner = usageOwnerByUser.get(user.id);
      const directCredential = credentialByUser.get(user.id);
      const credential =
        directCredential ??
        credentialByUser.get(usageOwner?.deliveryAdminId ?? user.id);
      const dashboard = dashboardByUser.get(user.id);
      return {
        ...user,
        enterpriseName: dashboard?.enterpriseName ?? null,
        dashboardConfigured: dashboard?.configured ?? false,
        dashboardRevision: dashboard?.revision ?? 0,
        service: serviceByUser.get(user.id) ?? {
          planCode: null,
          status: "unconfigured" as const,
          revision: 0,
        },
        createdAt: user.createdAt.getTime(),
        assignedAdmins: allAssignments
          .filter((assignment) => assignment.userId === user.id)
          .map((assignment) => adminById.get(assignment.adminId))
          .filter(Boolean),
        usageOwner: usageOwner
          ? {
              adminId: usageOwner.deliveryAdminId,
              revision: usageOwner.revision,
            }
          : null,
        credential: {
          configured: Boolean(credential),
          fingerprint: systemAdmin ? (credential?.fingerprint ?? null) : null,
          status: systemAdmin ? (credential?.validationStatus ?? null) : null,
          verifiedAt: systemAdmin
            ? (credential?.verifiedAt?.getTime() ?? null)
            : null,
          inherited: systemAdmin
            ? Boolean(!directCredential && usageOwner)
            : false,
        },
      };
    }),
  };
}

export async function setWorkspaceAssignments(input: {
  actor: AuthenticatedUser;
  userId: number;
  adminIds: number[];
  usageOwnerAdminId?: number | null;
  reason?: string;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Only the system administrator can change assignments",
    );
  }
  await getTargetUser(input.userId);
  const db = await requireDb();
  const uniqueAdminIds = [...new Set(input.adminIds)];
  let validAdmins: Array<{
    id: number;
    adminAccessLevel: "system_admin" | "delivery_admin" | null;
  }> = [];
  if (uniqueAdminIds.length > 0) {
    validAdmins = await db
      .select({
        id: users.id,
        adminAccessLevel: users.adminAccessLevel,
      })
      .from(users)
      .where(
        and(
          eq(users.role, "admin"),
          eq(users.isActive, true),
          inArray(users.id, uniqueAdminIds),
        ),
      );
    if (validAdmins.length !== uniqueAdminIds.length) {
      throw new AuthServiceError("NOT_FOUND", "Administrator not found");
    }
  }
  const eligibleOwnerAdminIds = validAdmins
    .filter((admin) => isExplicitAdminAccessLevel(admin.adminAccessLevel))
    .map((admin) => admin.id);
  if (
    input.usageOwnerAdminId != null &&
    !eligibleOwnerAdminIds.includes(input.usageOwnerAdminId)
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "主负责人必须是已选中的有效管理员",
    );
  }
  await db.transaction(async (tx) => {
    const lockedTargetUsers = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (lockedTargetUsers[0]?.role !== "user") {
      throw new AuthServiceError(
        "CONFLICT",
        "客户账号状态已变化，请刷新后重新分配",
      );
    }
    const lockedAdmins =
      uniqueAdminIds.length > 0
        ? await tx
            .select({
              id: users.id,
              adminAccessLevel: users.adminAccessLevel,
            })
            .from(users)
            .where(
              and(
                eq(users.role, "admin"),
                eq(users.isActive, true),
                inArray(users.id, uniqueAdminIds),
              ),
            )
            .for("update")
        : [];
    if (lockedAdmins.length !== uniqueAdminIds.length) {
      throw new AuthServiceError(
        "CONFLICT",
        "管理员状态已变化，请刷新后重新分配",
      );
    }
    const lockedEligibleOwnerAdminIds = lockedAdmins
      .filter((admin) => isExplicitAdminAccessLevel(admin.adminAccessLevel))
      .map((admin) => admin.id);
    if (
      input.usageOwnerAdminId != null &&
      !lockedEligibleOwnerAdminIds.includes(input.usageOwnerAdminId)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "主负责人状态已变化，请刷新后重新分配",
      );
    }

    const previousAssignments = await tx
      .select({ adminId: userAdminAssignments.adminId })
      .from(userAdminAssignments)
      .where(eq(userAdminAssignments.userId, input.userId));
    const previousOwners = await tx
      .select()
      .from(userUsageOwners)
      .where(eq(userUsageOwners.userId, input.userId))
      .limit(1)
      .for("update");
    const previousOwner = previousOwners[0] ?? null;
    const nextUsageOwnerId =
      input.usageOwnerAdminId !== undefined
        ? input.usageOwnerAdminId
        : previousOwner &&
            lockedEligibleOwnerAdminIds.includes(previousOwner.deliveryAdminId)
          ? previousOwner.deliveryAdminId
          : lockedEligibleOwnerAdminIds.length === 1
            ? lockedEligibleOwnerAdminIds[0]!
            : null;
    await tx
      .delete(userAdminAssignments)
      .where(eq(userAdminAssignments.userId, input.userId));
    if (uniqueAdminIds.length > 0) {
      await tx.insert(userAdminAssignments).values(
        uniqueAdminIds.map((adminId) => ({
          userId: input.userId,
          adminId,
          assignedByUserId: input.actor.id,
        })),
      );
    }
    if (nextUsageOwnerId == null) {
      await tx
        .delete(userUsageOwners)
        .where(eq(userUsageOwners.userId, input.userId));
    } else if (previousOwner) {
      await tx
        .update(userUsageOwners)
        .set({
          deliveryAdminId: nextUsageOwnerId,
          revision: previousOwner.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(userUsageOwners.userId, input.userId));
    } else {
      await tx.insert(userUsageOwners).values({
        userId: input.userId,
        deliveryAdminId: nextUsageOwnerId,
        revision: 1,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "workspace.assignments.updated",
        targetType: "workspace",
        targetId: input.userId,
        workspaceUserId: input.userId,
        reason: input.reason,
        metadata: {
          previousAdminIds: previousAssignments.map((row) => row.adminId),
          adminIds: uniqueAdminIds,
          previousUsageOwnerAdminId: previousOwner?.deliveryAdminId ?? null,
          usageOwnerAdminId: nextUsageOwnerId,
        },
      },
      tx,
    );
  });
  return listManagedWorkspaceUsers(input.actor);
}

export async function replaceManagedUserCredential(input: {
  actor: AuthenticatedUser;
  userId: number;
  apiKey: string;
  reason?: string;
}) {
  assertManagedCredentialMutationAccess(input.actor, null);
  await assertWorkspaceAccess(input.actor, input.userId);
  const credential = await replaceApiCredential(input.userId, input.apiKey);
  await writeWorkspaceAuditEvent({
    actor: input.actor,
    action: "workspace.credential.replaced",
    targetType: "api_credential",
    targetId: input.userId,
    workspaceUserId: input.userId,
    reason: input.reason,
    metadata: {
      fingerprint: credential.fingerprint,
      validationStatus: credential.status,
    },
  });
  return credential;
}

export async function deleteManagedUserCredential(input: {
  actor: AuthenticatedUser;
  userId: number;
  reason?: string;
}) {
  assertManagedCredentialMutationAccess(input.actor, null);
  await assertWorkspaceAccess(input.actor, input.userId);
  await deleteActiveApiCredential(input.userId);
  await writeWorkspaceAuditEvent({
    actor: input.actor,
    action: "workspace.credential.deleted",
    targetType: "api_credential",
    targetId: input.userId,
    workspaceUserId: input.userId,
    reason: input.reason,
  });
  return { success: true } as const;
}

function parseCreatedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function aggregateSharedKeyCreditUsagePage(input: {
  tasks: any[];
  ownedTaskIds: ReadonlySet<string>;
  cutoff: number;
  endExclusive?: number;
  seenTaskIds: Set<string>;
}) {
  const recentTasks: Array<{
    id: string;
    title: string;
    creditUsage: number;
    createdAt?: string;
  }> = [];
  let totalUsed = 0;
  let accountUsed = 0;
  let complete = true;
  let datedTaskCount = 0;
  let expiredTaskCount = 0;
  let reachedCutoff = false;

  for (const task of input.tasks) {
    const id = String(task?.id ?? task?.task_id ?? "");
    if (!id) {
      complete = false;
      continue;
    }
    if (input.seenTaskIds.has(id)) continue;
    input.seenTaskIds.add(id);
    const createdAtMs = parseCreatedAt(task?.created_at);
    if (createdAtMs === null) {
      complete = false;
      continue;
    }
    datedTaskCount += 1;
    if (createdAtMs < input.cutoff) {
      expiredTaskCount += 1;
      continue;
    }
    if (
      createdAtMs !== null &&
      input.endExclusive !== undefined &&
      createdAtMs >= input.endExclusive
    ) {
      continue;
    }
    const creditUsage = Number(
      task?.credit_usage ?? task?.metadata?.credit_usage ?? 0,
    );
    if (!Number.isFinite(creditUsage) || creditUsage < 0) {
      complete = false;
      continue;
    }
    if (creditUsage === 0) continue;
    // The total belongs to the shared API Key pool.
    totalUsed += creditUsage;
    // Task details remain tenant-private.
    if (!input.ownedTaskIds.has(id)) continue;
    accountUsed += creditUsage;
    recentTasks.push({
      id,
      title:
        String(task?.metadata?.task_title ?? "").trim() ||
        String(task?.instructions ?? "").slice(0, 30) ||
        id.slice(0, 12),
      creditUsage,
      createdAt:
        createdAtMs === null
          ? undefined
          : new Date(createdAtMs).toLocaleDateString("zh-CN", {
              timeZone: "Asia/Shanghai",
            }),
    });
  }

  // Do not trust one out-of-order item as an end-of-window sentinel. The
  // requested upstream order is descending, but a whole page outside the
  // window is the minimum safe signal for stopping pagination.
  reachedCutoff = usagePageReachedCutoff({
    complete,
    datedTaskCount,
    expiredTaskCount,
  });

  return { totalUsed, accountUsed, recentTasks, reachedCutoff, complete };
}

export function getShanghaiCalendarMonthPeriod(now = Date.now()) {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1_000;
  const shanghaiNow = new Date(now + shanghaiOffsetMs);
  const year = shanghaiNow.getUTCFullYear();
  const monthIndex = shanghaiNow.getUTCMonth();
  const startAt = Date.UTC(year, monthIndex, 1, 0, 0, 0, 0) - shanghaiOffsetMs;
  const endAt =
    Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0) - shanghaiOffsetMs;
  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    label: `${year} 年 ${monthIndex + 1} 月`,
    timezone: "Asia/Shanghai" as const,
    startAt,
    endAt,
  };
}

export function getShanghaiRollingUsagePeriod(
  windowDays = 30,
  now = Date.now(),
) {
  const normalizedWindowDays =
    Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365
      ? windowDays
      : 30;
  const durationMs = normalizedWindowDays * 24 * 60 * 60 * 1_000;
  return {
    key: `rolling-${normalizedWindowDays}-${now}`,
    label: `近 ${normalizedWindowDays} 天`,
    timezone: "Asia/Shanghai" as const,
    windowDays: normalizedWindowDays,
    startAt: now - durationMs,
    endAt: now,
  };
}

export function usageContributionForCredential(input: {
  creditUsage: number;
  credentialFingerprint: string;
  poolFingerprint?: string | null;
  ownerId?: number;
  accountIds: ReadonlySet<number>;
}) {
  const creditUsage =
    Number.isFinite(input.creditUsage) && input.creditUsage > 0
      ? input.creditUsage
      : 0;
  return {
    poolUsed:
      !input.poolFingerprint ||
      input.credentialFingerprint === input.poolFingerprint
        ? creditUsage
        : 0,
    accountUsed:
      input.ownerId !== undefined && input.accountIds.has(input.ownerId)
        ? creditUsage
        : 0,
  };
}

type ManagedAgentUsageRow = {
  providerTaskId: string | null;
  apiCredentialId: string;
  accountUserId: number | null;
  status: string;
};

/** Includes ordinary v2 chat tasks, which do not create upstream_resources. */
export function projectManagedAgentUsageRows(
  rows: readonly ManagedAgentUsageRow[],
) {
  const expectedTaskIdsByCredential = new Map<string, Set<string>>();
  const ownerByTask = new Map<string, number>();
  const unsettledCredentialIds = new Set<string>();
  const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
  for (const row of rows) {
    const taskId = row.providerTaskId?.trim();
    if (taskId) {
      const expected =
        expectedTaskIdsByCredential.get(row.apiCredentialId) ?? new Set();
      expected.add(taskId);
      expectedTaskIdsByCredential.set(row.apiCredentialId, expected);
      if (row.accountUserId !== null) {
        ownerByTask.set(taskId, row.accountUserId);
      }
    }
    if (!terminalStates.has(row.status)) {
      unsettledCredentialIds.add(row.apiCredentialId);
    }
  }
  return { expectedTaskIdsByCredential, ownerByTask, unsettledCredentialIds };
}

export async function getSharedKeyMonthlyCreditUsageForAccounts(input: {
  credentialOwnerId?: number;
  credentialOwnerIds?: number[];
  accountIds: number[];
  poolFingerprint?: string | null;
  now?: number;
  windowDays?: number;
}) {
  const period = getShanghaiRollingUsagePeriod(
    input.windowDays,
    input.now ?? Date.now(),
  );
  const uniqueAccountIds = [...new Set(input.accountIds)];
  const accountIdSet = new Set(uniqueAccountIds);
  const accounts = new Map<
    number,
    {
      accountUsed: number;
      recentTasks: Array<{
        id: string;
        title: string;
        creditUsage: number;
        createdAt?: string;
      }>;
    }
  >(
    uniqueAccountIds.map((accountId) => [
      accountId,
      { accountUsed: 0, recentTasks: [] },
    ]),
  );
  const db = await requireDb();
  const credentialOwnerIds = [
    ...new Set(
      [input.credentialOwnerId, ...(input.credentialOwnerIds ?? [])].filter(
        (ownerId): ownerId is number =>
          Number.isInteger(ownerId) && Number(ownerId) > 0,
      ),
    ),
  ];
  if (credentialOwnerIds.length === 0) {
    return {
      totalUsed: 0,
      accounts,
      fetchedAt: input.now ?? Date.now(),
      fingerprint: null,
      period,
      complete: true,
      attributionComplete: true,
    };
  }
  const credentialRows = await db
    .select()
    .from(apiCredentials)
    .where(
      and(
        inArray(apiCredentials.status, ["active", "retired"]),
        or(
          inArray(apiCredentials.userId, credentialOwnerIds),
          ...(input.poolFingerprint
            ? [eq(apiCredentials.fingerprint, input.poolFingerprint)]
            : []),
          ...(uniqueAccountIds.length > 0
            ? [
                inArray(
                  apiCredentials.id,
                  db
                    .select({
                      apiCredentialId: upstreamResources.apiCredentialId,
                    })
                    .from(upstreamResources)
                    .where(
                      and(
                        eq(upstreamResources.kind, "task"),
                        inArray(upstreamResources.userId, uniqueAccountIds),
                      ),
                    ),
                ),
              ]
            : []),
        ),
      ),
    )
    .orderBy(desc(apiCredentials.version));
  if (credentialRows.length === 0) {
    return {
      totalUsed: 0,
      accounts,
      fetchedAt: Date.now(),
      fingerprint: null,
      period,
      complete: true,
      attributionComplete: true,
    };
  }
  // The same physical Key may be inherited, copied to another account, or
  // replaced with the same value. Query it once across all credential rows;
  // task ids are additionally deduplicated across genuinely different Key
  // versions below.
  const credentialByFingerprint = new Map<
    string,
    {
      apiKey: string;
      id: string;
      fingerprint: string;
      status: "active" | "retired";
      retiredAt: Date | null;
    }
  >();
  for (const credential of selectPhysicalCredentialRows(credentialRows)) {
    if (!credentialByFingerprint.has(credential.fingerprint)) {
      credentialByFingerprint.set(credential.fingerprint, {
        apiKey: decryptApiKey(credential),
        id: credential.id,
        fingerprint: credential.fingerprint,
        status: credential.status as "active" | "retired",
        retiredAt: credential.retiredAt,
      });
    }
  }
  const credentials = [...credentialByFingerprint.values()];
  const totalCredential = input.poolFingerprint
    ? credentials.find(
        (credential) => credential.fingerprint === input.poolFingerprint,
      )
    : credentials[0];
  const authoritativePoolUsage = totalCredential
    ? await getManusRollingCreditUsage({
        apiKey: totalCredential.apiKey,
        startAt: period.startAt,
        endAt: period.endAt,
      })
    : { totalUsed: 0, complete: false };
  const coverageByFingerprint = await loadUsageCoverage({
    executor: db,
    scope: "managed_user",
    fingerprints: credentials.map((credential) => credential.fingerprint),
  });
  const fingerprintByCredentialId = new Map(
    credentialRows.map((credential) => [credential.id, credential.fingerprint]),
  );
  const localTaskRows = await db
    .select({
      apiCredentialId: upstreamResources.apiCredentialId,
      upstreamId: upstreamResources.upstreamId,
    })
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, "task"),
        inArray(
          upstreamResources.apiCredentialId,
          credentialRows.map((credential) => credential.id),
        ),
        gte(upstreamResources.createdAt, new Date(period.startAt)),
      ),
    );
  const managedAgentTaskRows = await db
    .select({
      providerTaskId: agentTasks.providerTaskId,
      apiCredentialId: agentOperations.apiCredentialId,
      accountUserId: agentOperations.accountUserId,
      status: agentOperations.status,
    })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentOperations.scope, "managed_user"),
        inArray(
          agentOperations.apiCredentialId,
          credentialRows.map((credential) => credential.id),
        ),
        gte(agentOperations.createdAt, new Date(period.startAt)),
      ),
    );
  const managedAgentUsage = projectManagedAgentUsageRows(managedAgentTaskRows);
  const expectedTaskIdsByFingerprint = new Map<string, Set<string>>();
  for (const row of localTaskRows) {
    if (!row.apiCredentialId || !row.upstreamId) continue;
    const fingerprint = fingerprintByCredentialId.get(row.apiCredentialId);
    if (!fingerprint) continue;
    const expected = expectedTaskIdsByFingerprint.get(fingerprint) ?? new Set();
    expected.add(row.upstreamId);
    expectedTaskIdsByFingerprint.set(fingerprint, expected);
  }
  for (const [
    credentialId,
    taskIds,
  ] of managedAgentUsage.expectedTaskIdsByCredential) {
    const fingerprint = fingerprintByCredentialId.get(credentialId);
    if (!fingerprint) continue;
    const expected = expectedTaskIdsByFingerprint.get(fingerprint) ?? new Set();
    for (const taskId of taskIds) expected.add(taskId);
    expectedTaskIdsByFingerprint.set(fingerprint, expected);
  }
  const terminalProofsByFingerprint = await loadTerminalUsageTaskProofs({
    executor: db,
    scope: "managed_user",
    fingerprints: credentials.map((credential) => credential.fingerprint),
    startAt: period.startAt,
    endAt: period.endAt,
  });
  const [activeTurnRows, activeConversationRows] = await Promise.all([
    db
      .select({ apiCredentialId: conversationTurns.apiCredentialId })
      .from(conversationTurns)
      .where(
        and(
          inArray(
            conversationTurns.apiCredentialId,
            credentialRows.map((credential) => credential.id),
          ),
          inArray(conversationTurns.status, ["queued", "running"]),
        ),
      ),
    db
      .select({ apiCredentialId: conversations.apiCredentialId })
      .from(conversations)
      .where(
        and(
          inArray(
            conversations.apiCredentialId,
            credentialRows.map((credential) => credential.id),
          ),
          inArray(conversations.status, [
            "running",
            "pending",
            "awaiting_input",
          ]),
        ),
      ),
  ]);
  const unsettledFingerprints = new Set(
    [...activeTurnRows, ...activeConversationRows]
      .map((row) =>
        row.apiCredentialId
          ? fingerprintByCredentialId.get(row.apiCredentialId)
          : null,
      )
      .filter((value): value is string => Boolean(value)),
  );
  for (const credentialId of managedAgentUsage.unsettledCredentialIds) {
    const fingerprint = fingerprintByCredentialId.get(credentialId);
    if (fingerprint) unsettledFingerprints.add(fingerprint);
  }
  const seen = new Set<string>();
  let attributionComplete = true;
  for (const credential of credentials) {
    if (
      credential.status === "retired" &&
      credential.retiredAt &&
      credential.retiredAt.getTime() <= period.startAt &&
      !unsettledFingerprints.has(credential.fingerprint) &&
      !expectedTaskIdsByFingerprint.get(credential.fingerprint)?.size
    ) {
      continue;
    }
    const existingCoverage = coverageByFingerprint.get(credential.fingerprint);
    if (
      credential.status === "retired" &&
      !unsettledFingerprints.has(credential.fingerprint) &&
      usageCoverageSupportsRetiredCredential({
        coverage: existingCoverage,
        periodStartMs: period.startAt,
        credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
      })
    ) {
      continue;
    }
    const scanStartedAtMs = input.now ?? Date.now();
    const scanToken = await claimUsageCredentialCoverage({
      executor: db,
      scope: "managed_user",
      credentialFingerprint: credential.fingerprint,
      coveredFromMs: period.startAt,
      scanStartedAtMs,
      credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
    });
    let after: string | undefined;
    let credentialComplete = true;
    let allFirstPartyTasksSettled = !unsettledFingerprints.has(
      credential.fingerprint,
    );
    const seenForCredential = new Set<string>();
    const seenCursors = new Set<string>();
    const usageClient = new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey: credential.apiKey,
    });
    for (let pageIndex = 0; pageIndex < CREDIT_MAX_PAGES; pageIndex += 1) {
      let payload: Awaited<ReturnType<ManusV2Client["listTasksPage"]>>;
      try {
        payload = await usageClient.listTasksPage({
          limit: CREDIT_PAGE_LIMIT,
          order: "desc",
          cursor: after,
        });
      } catch {
        if (credential.status === "retired") {
          credentialComplete = usageCoverageSupportsRetiredCredential({
            coverage: coverageByFingerprint.get(credential.fingerprint),
            periodStartMs: period.startAt,
            credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
          });
          break;
        }
        credentialComplete = false;
        break;
      }
      const tasks = payload.data;
      if (tasks.length === 0) {
        if (payload.has_more) credentialComplete = false;
        break;
      }
      const taskIds = tasks
        .map((task: any) => String(task?.id ?? task?.task_id ?? ""))
        .filter(Boolean);
      const ownershipRows = taskIds.length
        ? await db
            .select({
              upstreamId: upstreamResources.upstreamId,
              userId: upstreamResources.userId,
            })
            .from(upstreamResources)
            .where(
              and(
                eq(upstreamResources.kind, "task"),
                inArray(upstreamResources.upstreamId, taskIds),
              ),
            )
        : [];
      const ownerByTask = new Map<string, number>(
        ownershipRows.map((row) => [row.upstreamId, row.userId]),
      );
      for (const taskId of taskIds) {
        const ownerId = managedAgentUsage.ownerByTask.get(taskId);
        if (ownerId !== undefined) ownerByTask.set(taskId, ownerId);
      }
      let datedTaskCount = 0;
      let expiredTaskCount = 0;
      let pageComplete = true;
      for (const task of tasks) {
        const id = String(task?.id ?? task?.task_id ?? "");
        if (!id) {
          attributionComplete = false;
          pageComplete = false;
          continue;
        }
        seenForCredential.add(id);
        if (seen.has(id)) continue;
        seen.add(id);
        const createdAtMs = parseCreatedAt(task?.created_at);
        if (createdAtMs === null) {
          attributionComplete = false;
          pageComplete = false;
          continue;
        }
        datedTaskCount += 1;
        if (createdAtMs < period.startAt) {
          expiredTaskCount += 1;
          continue;
        }
        if (createdAtMs >= period.endAt) continue;
        const creditUsage = Number(
          task?.credit_usage ?? task?.metadata?.credit_usage ?? 0,
        );
        if (!Number.isFinite(creditUsage) || creditUsage < 0) {
          attributionComplete = false;
          pageComplete = false;
          continue;
        }
        if (ownerByTask.has(id) && !isUsageTaskTerminal(task)) {
          allFirstPartyTasksSettled = false;
        }
        if (creditUsage === 0) continue;
        const ownerId = ownerByTask.get(id);
        const contribution = usageContributionForCredential({
          creditUsage,
          credentialFingerprint: credential.fingerprint,
          poolFingerprint: input.poolFingerprint,
          ownerId,
          accountIds: accountIdSet,
        });
        if (contribution.accountUsed <= 0 || ownerId === undefined) continue;
        const account = accounts.get(ownerId)!;
        account.accountUsed += contribution.accountUsed;
        account.recentTasks.push({
          id,
          title:
            String(task?.metadata?.task_title ?? "").trim() ||
            String(task?.instructions ?? "").slice(0, 30) ||
            id.slice(0, 12),
          creditUsage,
          createdAt: new Date(createdAtMs).toLocaleDateString("zh-CN", {
            timeZone: "Asia/Shanghai",
          }),
        });
      }
      const pageReachedCutoff = usagePageReachedCutoff({
        complete: pageComplete,
        datedTaskCount,
        expiredTaskCount,
      });
      const ledgerWrite = await recordUsageLedgerEntries({
        executor: db,
        scope: "managed_user",
        credentialFingerprint: credential.fingerprint,
        apiCredentialId: credential.id,
        observedAt: new Date(input.now ?? Date.now()),
        entries: tasks.flatMap((task: any) => {
          const taskId = String(task?.id ?? task?.task_id ?? "");
          const createdAtMs = parseCreatedAt(task?.created_at);
          const creditUsage = Number(
            task?.credit_usage ?? task?.metadata?.credit_usage ?? 0,
          );
          if (
            !taskId ||
            createdAtMs === null ||
            !Number.isFinite(creditUsage) ||
            creditUsage < 0
          ) {
            return [];
          }
          const ownerId = ownerByTask.get(taskId);
          return [
            {
              upstreamTaskId: taskId,
              accountUserId: ownerId ?? null,
              isFirstParty: ownerId !== undefined,
              taskCreatedAtMs: createdAtMs,
              creditUsage,
              isTerminal: isUsageTaskTerminal(task),
            },
          ];
        }),
      });
      if (!ledgerWrite.complete) pageComplete = false;
      if (!pageComplete) credentialComplete = false;
      if (pageReachedCutoff) break;
      after =
        payload.next_cursor ??
        (String(tasks[tasks.length - 1]?.id ?? "") || undefined);
      if (payload.has_more && !after) {
        credentialComplete = false;
        break;
      }
      if (!payload.has_more) break;
      if (seenCursors.has(String(after))) {
        credentialComplete = false;
        break;
      }
      seenCursors.add(String(after));
      if (pageIndex === CREDIT_MAX_PAGES - 1) credentialComplete = false;
    }
    const expectedTaskIds =
      expectedTaskIdsByFingerprint.get(credential.fingerprint) ?? new Set();
    if (
      !hasCompleteExpectedTaskSet(
        expectedTaskIds,
        seenForCredential,
        terminalProofsByFingerprint.get(credential.fingerprint),
      )
    ) {
      credentialComplete = false;
    }
    if (credentialComplete) {
      const finalized = await markUsageCredentialCoverage({
        executor: db,
        scope: "managed_user",
        credentialFingerprint: credential.fingerprint,
        coveredFromMs: period.startAt,
        fullScanAtMs: input.now ?? Date.now(),
        credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
        allTasksSettled: allFirstPartyTasksSettled,
        scanToken,
      });
      if (!finalized) credentialComplete = false;
    }
    if (!credentialComplete) {
      attributionComplete = false;
    }
  }
  const ledgerUsage = await readManagedUsageLedger({
    executor: db,
    poolFingerprint: input.poolFingerprint ?? credentials[0]?.fingerprint ?? "",
    accountIds: uniqueAccountIds,
    startAt: period.startAt,
    endAt: period.endAt,
  });
  for (const accountId of uniqueAccountIds) {
    const account = accounts.get(accountId)!;
    account.accountUsed = ledgerUsage.accountUsed.get(accountId) ?? 0;
  }
  return {
    // v2 usage.list is the authoritative balance-change history. Unlike the
    // deprecated task list it retains consumption for deleted sessions and
    // lets refunds reduce the displayed net usage. The local task ledger is
    // still the source of tenant-private per-account attribution.
    totalUsed: authoritativePoolUsage.totalUsed,
    accounts,
    fetchedAt: input.now ?? Date.now(),
    fingerprint: input.poolFingerprint ?? credentials[0]?.fingerprint ?? null,
    period,
    complete: authoritativePoolUsage.complete,
    issueCode: authoritativePoolUsage.issueCode,
    attributionComplete,
  };
}

async function getAccountCreditUsageBetween(
  userId: number,
  input: {
    cutoff: number;
    endExclusive?: number;
    period?: ReturnType<typeof getShanghaiCalendarMonthPeriod>;
  },
) {
  const credential = await getEffectiveDecryptedCredentialForAccount(userId);
  if (!credential)
    return {
      totalUsed: 0,
      accountUsed: 0,
      recentTasks: [],
      fetchedAt: Date.now(),
      fingerprint: null,
      complete: true,
      ...(input.period ? { period: input.period } : {}),
    };
  const recentTasks: Array<{
    id: string;
    title: string;
    creditUsage: number;
    createdAt?: string;
  }> = [];
  const seen = new Set<string>();
  let totalUsed = 0;
  let accountUsed = 0;
  let after: string | undefined;
  let reachedCutoff = false;
  let complete = true;
  const usageClient = new ManusV2Client({
    baseUrl: getUpstreamBaseUrl(),
    apiKey: credential.apiKey,
    rateLimitScope: `managed-user:${userId}`,
  });

  for (
    let pageIndex = 0;
    pageIndex < CREDIT_MAX_PAGES && !reachedCutoff;
    pageIndex += 1
  ) {
    let payload: Awaited<ReturnType<ManusV2Client["listTasksPage"]>>;
    try {
      payload = await usageClient.listTasksPage({
        limit: CREDIT_PAGE_LIMIT,
        order: "desc",
        cursor: after,
      });
    } catch (error) {
      throw new AuthServiceError(
        error instanceof ManusV2ApiError &&
        (error.status === 401 || error.status === 403)
          ? "INVALID_CREDENTIAL"
          : "UPSTREAM_UNAVAILABLE",
        "暂时无法读取该用户的积分使用情况",
      );
    }
    const tasks = payload.data;
    if (tasks.length === 0) break;
    const taskIds = tasks
      .map((task: any) => String(task?.id ?? task?.task_id ?? ""))
      .filter(Boolean);
    const ownedTaskIds = await getOwnedUpstreamResourceIds(
      userId,
      "task",
      taskIds,
    );
    const pageResult = aggregateSharedKeyCreditUsagePage({
      tasks,
      ownedTaskIds,
      cutoff: input.cutoff,
      endExclusive: input.endExclusive,
      seenTaskIds: seen,
    });
    totalUsed += pageResult.totalUsed;
    accountUsed += pageResult.accountUsed;
    recentTasks.push(...pageResult.recentTasks);
    reachedCutoff = pageResult.reachedCutoff;
    if (!pageResult.complete) complete = false;
    after = payload.next_cursor ?? tasks[tasks.length - 1]?.id ?? undefined;
    if (
      pageIndex === CREDIT_MAX_PAGES - 1 &&
      payload.has_more &&
      after &&
      !reachedCutoff
    ) {
      complete = false;
    }
    if (!payload.has_more || !after) break;
  }
  return {
    totalUsed,
    accountUsed,
    recentTasks,
    fetchedAt: Date.now(),
    fingerprint: credential.fingerprint,
    complete,
    ...(input.period ? { period: input.period } : {}),
  };
}

export async function getAccountCreditUsage(userId: number, windowDays = 30) {
  const normalizedWindowDays =
    Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365
      ? windowDays
      : 30;
  return getAccountCreditUsageBetween(userId, {
    cutoff: Date.now() - normalizedWindowDays * 24 * 60 * 60 * 1_000,
  });
}

export async function getAccountMonthlyCreditUsage(
  userId: number,
  now = Date.now(),
) {
  const period = getShanghaiCalendarMonthPeriod(now);
  return getAccountCreditUsageBetween(userId, {
    cutoff: period.startAt,
    endExclusive: period.endAt,
    period,
  });
}

export async function getManagedUserCreditUsage(
  actor: AuthenticatedUser,
  userId: number,
  windowDays = 30,
) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "客户 Key 与积分仅由系统管理员查看",
    );
  }
  await assertWorkspaceAccess(actor, userId);
  return getAccountCreditUsage(userId, windowDays);
}

export async function getManagedCredentialStatus(
  actor: AuthenticatedUser,
  userId: number,
) {
  if (actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有管理员可以查看受管用户 API Key",
    );
  }
  await assertWorkspaceAccess(actor, userId);
  return getEffectiveApiCredentialStatus(userId);
}
