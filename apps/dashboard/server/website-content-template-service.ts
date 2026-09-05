import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import { deliveryTicketEvents, deliveryTickets } from "../drizzle/schema";
import {
  websiteContentTemplateSchema,
  type WebsiteContentCategory,
  type WebsiteContentTemplate,
  type WebsiteContentTemplateRecord,
} from "../shared/delivery-ticket";
import { WEBSITE_CONTENT_CATALOG } from "../shared/delivery-catalog";
import type { AuthenticatedUser } from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  consumeDashboardImportPreflight,
  dashboardImportPreflightStoreForExecutor,
  issueDashboardImportPreflight,
} from "./dashboard-import-preflight-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import {
  assertExistingDeliveryTicketSettlementScope,
  deriveTicketQuotaTransition,
} from "./delivery-ticket-service";
import { getDb } from "./db";

const WEBSITE_CONTENT_CATEGORIES = WEBSITE_CONTENT_CATALOG.map(
  (item) => item.value,
) as WebsiteContentCategory[];
const TERMINAL_STATUSES = new Set(["completed", "rejected", "cancelled"]);

type WebsiteContentTicketRow = Pick<
  typeof deliveryTickets.$inferSelect,
  | "id"
  | "userId"
  | "contractId"
  | "quotaPeriodId"
  | "type"
  | "quotaPool"
  | "workflowDomain"
  | "category"
  | "topic"
  | "title"
  | "status"
  | "quotaState"
  | "publicSummary"
  | "revision"
  | "scheduledAt"
>;

export type WebsiteContentTemplateDiffRow = {
  ticketId: string;
  revision: number;
  category: WebsiteContentCategory;
  categoryLabel: string;
  topic: string;
  currentComplete: boolean;
  incomingComplete: boolean;
  currentPublicSummary: string;
  incomingPublicSummary: string;
  change: "unchanged" | "complete" | "summary";
};

export type WebsiteContentTemplatePreview = {
  fileHash: string;
  workspaceUserId: number;
  totals: {
    records: number;
    changed: number;
    completing: number;
    summariesUpdated: number;
    unchanged: number;
  };
  changes: WebsiteContentTemplateDiffRow[];
  preflightToken?: string;
  preflightExpiresAt?: string;
};

function assertNoRoleOwnedTemplateCompletion(input: {
  rows: WebsiteContentTicketRow[];
  changes: WebsiteContentTemplateDiffRow[];
}) {
  const rowsById = new Map(input.rows.map((row) => [row.id, row]));
  const roleOwnedCompletion = input.changes.find(
    (change) =>
      change.change === "complete" &&
      Boolean(rowsById.get(change.ticketId)?.workflowDomain),
  );
  if (roleOwnedCompletion) {
    throw new WebsiteContentTemplateError(
      "WEBSITE_CONTENT_TEMPLATE_ROLE_WORKBENCH_REQUIRED",
      `需求 ${roleOwnedCompletion.ticketId} 已进入岗位工作流，请在系统管理员完整处理工作台中按岗位规则完成。`,
      409,
    );
  }
}

export class WebsiteContentTemplateError extends Error {
  constructor(
    readonly code:
      | "WEBSITE_CONTENT_TEMPLATE_ADMIN_REQUIRED"
      | "WEBSITE_CONTENT_TEMPLATE_WORKSPACE_MISMATCH"
      | "WEBSITE_CONTENT_TEMPLATE_TICKET_SCOPE_INVALID"
      | "WEBSITE_CONTENT_TEMPLATE_SNAPSHOT_MISMATCH"
      | "WEBSITE_CONTENT_TEMPLATE_REVISION_CONFLICT"
      | "WEBSITE_CONTENT_TEMPLATE_REOPEN_NOT_ALLOWED"
      | "WEBSITE_CONTENT_TEMPLATE_SUMMARY_REQUIRES_COMPLETION"
      | "WEBSITE_CONTENT_TEMPLATE_SUMMARY_REQUIRED"
      | "WEBSITE_CONTENT_TEMPLATE_ROLE_WORKBENCH_REQUIRED"
      | "WEBSITE_CONTENT_TEMPLATE_NO_CHANGES",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "WebsiteContentTemplateError";
  }
}

function normalizedText(value: string | null | undefined) {
  return value?.trim() || "";
}

function ticketTopic(row: WebsiteContentTicketRow) {
  return normalizedText(row.topic) || normalizedText(row.title);
}

function ticketComplete(row: WebsiteContentTicketRow) {
  return TERMINAL_STATUSES.has(row.status);
}

function categoryLabel(category: WebsiteContentCategory) {
  return (
    WEBSITE_CONTENT_CATALOG.find((item) => item.value === category)?.label ??
    category
  );
}

function requireDb() {
  return getDb().then((db) => {
    if (!db) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_TICKET_SCOPE_INVALID",
        "数据库暂时不可用。",
        503,
      );
    }
    return db;
  });
}

async function assertAdministratorWorkspaceAccess(
  actor: AuthenticatedUser,
  workspaceUserId: number,
) {
  if (actor.role !== "admin") {
    throw new WebsiteContentTemplateError(
      "WEBSITE_CONTENT_TEMPLATE_ADMIN_REQUIRED",
      "只有管理员可以下载或发布官网内容模板。",
      403,
    );
  }
  await assertWorkspaceAccess(actor, workspaceUserId);
}

async function loadWebsiteContentTicketRows(
  executor: any,
  workspaceUserId: number,
  lock = false,
) {
  let query = executor
    .select({
      id: deliveryTickets.id,
      userId: deliveryTickets.userId,
      contractId: deliveryTickets.contractId,
      quotaPeriodId: deliveryTickets.quotaPeriodId,
      type: deliveryTickets.type,
      quotaPool: deliveryTickets.quotaPool,
      workflowDomain: deliveryTickets.workflowDomain,
      category: deliveryTickets.category,
      topic: deliveryTickets.topic,
      title: deliveryTickets.title,
      status: deliveryTickets.status,
      quotaState: deliveryTickets.quotaState,
      publicSummary: deliveryTickets.publicSummary,
      revision: deliveryTickets.revision,
      scheduledAt: deliveryTickets.scheduledAt,
    })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, workspaceUserId),
        eq(deliveryTickets.type, "website_operation"),
        inArray(deliveryTickets.category, WEBSITE_CONTENT_CATEGORIES),
      ),
    )
    .orderBy(asc(deliveryTickets.createdAt), asc(deliveryTickets.id));
  if (lock) query = query.for("update");
  return (await query) as WebsiteContentTicketRow[];
}

export function createWebsiteContentTemplate(input: {
  workspaceUserId: number;
  rows: WebsiteContentTicketRow[];
  exportedAt?: Date;
}): WebsiteContentTemplate {
  return websiteContentTemplateSchema.parse({
    format: "frontmind.website-content-template.v1",
    workspaceUserId: input.workspaceUserId,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    records: input.rows.map((row) => ({
      ticketId: row.id,
      revision: row.revision,
      category: row.category,
      topic: ticketTopic(row),
      publicSummary: normalizedText(row.publicSummary),
      complete: ticketComplete(row),
    })),
  });
}

function invalidScope(record: WebsiteContentTemplateRecord): never {
  throw new WebsiteContentTemplateError(
    "WEBSITE_CONTENT_TEMPLATE_TICKET_SCOPE_INVALID",
    `需求 ${record.ticketId} 不属于当前企业的五类官网内容需求。`,
    403,
  );
}

export function buildWebsiteContentTemplateDiff(input: {
  workspaceUserId: number;
  template: WebsiteContentTemplate;
  rows: WebsiteContentTicketRow[];
  fileHash: string;
}): WebsiteContentTemplatePreview {
  const template = websiteContentTemplateSchema.parse(input.template);
  if (template.workspaceUserId !== input.workspaceUserId) {
    throw new WebsiteContentTemplateError(
      "WEBSITE_CONTENT_TEMPLATE_WORKSPACE_MISMATCH",
      "模板绑定的企业与当前工作台不一致，请下载当前企业的模板。",
      403,
    );
  }
  const rowsById = new Map(input.rows.map((row) => [row.id, row]));
  const changes = template.records.map((record) => {
    const row = rowsById.get(record.ticketId);
    if (
      !row ||
      row.userId !== input.workspaceUserId ||
      row.type !== "website_operation" ||
      !WEBSITE_CONTENT_CATEGORIES.includes(
        row.category as WebsiteContentCategory,
      )
    ) {
      return invalidScope(record);
    }
    if (row.revision !== record.revision) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_REVISION_CONFLICT",
        `需求 ${record.ticketId} 已更新到 R${row.revision}，请重新下载当前内容模板。`,
      );
    }
    if (row.category !== record.category || ticketTopic(row) !== record.topic) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_SNAPSHOT_MISMATCH",
        `需求 ${record.ticketId} 的类别或话题快照被修改，请重新下载当前内容模板。`,
        400,
      );
    }
    const currentComplete = ticketComplete(row);
    const currentPublicSummary = normalizedText(row.publicSummary);
    const incomingPublicSummary = normalizedText(record.publicSummary);
    if (currentComplete && !record.complete) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_REOPEN_NOT_ALLOWED",
        `已结束需求 ${record.ticketId} 不能通过模板重新打开。`,
        400,
      );
    }
    if (
      !currentComplete &&
      !record.complete &&
      currentPublicSummary !== incomingPublicSummary
    ) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_SUMMARY_REQUIRES_COMPLETION",
        `需求 ${record.ticketId} 尚未完成；填写内容总结时请同时把 complete 改为 true。`,
        400,
      );
    }
    if (
      record.complete &&
      !incomingPublicSummary &&
      (!currentComplete || currentPublicSummary !== incomingPublicSummary)
    ) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_SUMMARY_REQUIRED",
        `完成需求 ${record.ticketId} 前必须填写 publicSummary。`,
        400,
      );
    }
    const change =
      !currentComplete && record.complete
        ? ("complete" as const)
        : currentPublicSummary !== incomingPublicSummary
          ? ("summary" as const)
          : ("unchanged" as const);
    return {
      ticketId: record.ticketId,
      revision: row.revision,
      category: record.category,
      categoryLabel: categoryLabel(record.category),
      topic: record.topic,
      currentComplete,
      incomingComplete: record.complete,
      currentPublicSummary,
      incomingPublicSummary,
      change,
    };
  });
  const changed = changes.filter((row) => row.change !== "unchanged");
  const completing = changed.filter((row) => row.change === "complete").length;
  const summariesUpdated = changed.filter(
    (row) => row.currentPublicSummary !== row.incomingPublicSummary,
  ).length;
  return {
    fileHash: input.fileHash,
    workspaceUserId: input.workspaceUserId,
    totals: {
      records: changes.length,
      changed: changed.length,
      completing,
      summariesUpdated,
      unchanged: changes.length - changed.length,
    },
    changes,
  };
}

export async function downloadWebsiteContentTemplate(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
  exportedAt?: Date;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.workspaceUserId);
  const db = await requireDb();
  const rows = await loadWebsiteContentTicketRows(db, input.workspaceUserId);
  return createWebsiteContentTemplate({
    workspaceUserId: input.workspaceUserId,
    rows,
    exportedAt: input.exportedAt,
  });
}

export async function previewWebsiteContentTemplate(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
  template: WebsiteContentTemplate;
  fileHash: string;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.workspaceUserId);
  const db = await requireDb();
  const rows = await loadWebsiteContentTicketRows(db, input.workspaceUserId);
  const preview = buildWebsiteContentTemplateDiff({
    workspaceUserId: input.workspaceUserId,
    template: input.template,
    rows,
    fileHash: input.fileHash,
  });
  assertNoRoleOwnedTemplateCompletion({
    rows,
    changes: preview.changes,
  });
  if (preview.totals.changed === 0) return preview;
  const credential = await issueDashboardImportPreflight({
    binding: {
      actorId: input.actor.id,
      workspaceUserId: input.workspaceUserId,
      module: "website-content",
      revision: 0,
      fileHash: input.fileHash,
    },
  });
  return { ...preview, ...credential };
}

export async function publishWebsiteContentTemplate(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
  template: WebsiteContentTemplate;
  fileHash: string;
  preflightToken: string | undefined;
}) {
  await assertAdministratorWorkspaceAccess(input.actor, input.workspaceUserId);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const rows = await loadWebsiteContentTicketRows(
      tx,
      input.workspaceUserId,
      true,
    );
    const preview = buildWebsiteContentTemplateDiff({
      workspaceUserId: input.workspaceUserId,
      template: input.template,
      rows,
      fileHash: input.fileHash,
    });
    const changed = preview.changes.filter((row) => row.change !== "unchanged");
    if (changed.length === 0) {
      throw new WebsiteContentTemplateError(
        "WEBSITE_CONTENT_TEMPLATE_NO_CHANGES",
        "模板内容与当前需求一致，无需发布。",
        400,
      );
    }
    assertNoRoleOwnedTemplateCompletion({
      rows,
      changes: preview.changes,
    });
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    await consumeDashboardImportPreflight({
      token: input.preflightToken,
      binding: {
        actorId: input.actor.id,
        workspaceUserId: input.workspaceUserId,
        module: "website-content",
        revision: 0,
        fileHash: input.fileHash,
      },
      store: dashboardImportPreflightStoreForExecutor(tx),
    });
    const now = new Date();
    const revisions: Array<{ ticketId: string; revision: number }> = [];
    for (const change of changed) {
      const ticket = rowsById.get(change.ticketId)!;
      if (change.change === "complete") {
        await assertExistingDeliveryTicketSettlementScope({
          executor: tx,
          userId: input.workspaceUserId,
          ticket,
        });
        const nextQuotaState = deriveTicketQuotaTransition({
          currentState: ticket.quotaState,
          scheduledAt: ticket.scheduledAt,
          nextStatus: "completed",
        });
        await tx
          .update(deliveryTickets)
          .set({
            status: "completed",
            quotaState: nextQuotaState,
            publicSummary: change.incomingPublicSummary,
            scheduledAt: ticket.scheduledAt ?? now,
            resolvedAt: now,
            revision: ticket.revision + 1,
            updatedByUserId: input.actor.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(deliveryTickets.id, ticket.id),
              eq(deliveryTickets.revision, ticket.revision),
            ),
          );
        await tx.insert(deliveryTicketEvents).values({
          id: randomUUID(),
          ticketId: ticket.id,
          userId: input.workspaceUserId,
          actorUserId: input.actor.id,
          actorRole: "admin",
          kind: "status_change",
          visibility: "customer",
          message: null,
          fromStatus: ticket.status,
          toStatus: "completed",
          createdAt: now,
        });
        await writeWorkspaceAuditEvent(
          {
            actor: input.actor,
            action: "delivery_ticket.status_updated",
            targetType: "delivery_ticket",
            targetId: ticket.id,
            workspaceUserId: input.workspaceUserId,
            metadata: {
              source: "website_content_template",
              fromStatus: ticket.status,
              toStatus: "completed",
              fromQuotaState: ticket.quotaState,
              toQuotaState: nextQuotaState,
              revision: ticket.revision + 1,
              publicSummaryUpdated:
                change.currentPublicSummary !== change.incomingPublicSummary,
            },
            now,
          },
          tx,
        );
      } else {
        await tx
          .update(deliveryTickets)
          .set({
            publicSummary: change.incomingPublicSummary,
            revision: ticket.revision + 1,
            updatedByUserId: input.actor.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(deliveryTickets.id, ticket.id),
              eq(deliveryTickets.revision, ticket.revision),
            ),
          );
        await writeWorkspaceAuditEvent(
          {
            actor: input.actor,
            action: "delivery_ticket.public_summary_updated",
            targetType: "delivery_ticket",
            targetId: ticket.id,
            workspaceUserId: input.workspaceUserId,
            metadata: {
              source: "website_content_template",
              status: ticket.status,
              revision: ticket.revision + 1,
            },
            now,
          },
          tx,
        );
      }
      revisions.push({
        ticketId: ticket.id,
        revision: ticket.revision + 1,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "workspace.website_content.template_published",
        targetType: "website_content_template",
        targetId: input.fileHash,
        workspaceUserId: input.workspaceUserId,
        metadata: {
          fileHash: input.fileHash,
          changed: preview.totals.changed,
          completing: preview.totals.completing,
          summariesUpdated: preview.totals.summariesUpdated,
          ticketIds: changed.map((row) => row.ticketId),
        },
        now,
      },
      tx,
    );
    return {
      success: true,
      changed: preview.totals.changed,
      completing: preview.totals.completing,
      summariesUpdated: preview.totals.summariesUpdated,
      revisions,
    };
  });
}
