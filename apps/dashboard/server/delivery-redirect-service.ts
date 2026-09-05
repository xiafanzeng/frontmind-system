import { createHash, randomUUID } from "node:crypto";

import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";

import {
  deliveryRedirectPreviews,
  deliveryTicketAttachments,
  deliveryTicketEvents,
  deliveryTickets,
} from "../drizzle/schema";
import type { AuthenticatedUser } from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import {
  assertDeliveryTicketServiceEligibility,
  DeliveryTicketError,
} from "./delivery-ticket-service";
import { getDb } from "./db";
import { getServicePortal } from "./service-entitlement";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";

export type RedirectPreviewError = { row: number; message: string };
export type RedirectPreviewRow = {
  row: number;
  sourceUrl: string;
  targetUrl: string;
  statusCode: number;
};

const MAX_REDIRECT_ROWS = 10_000;
const MAX_REDIRECT_FILE_BYTES = 25 * 1024 * 1024;
const PREVIEW_TTL_MS = 60 * 60 * 1000;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) {
      return String(value.result).trim();
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return value.hyperlink.trim();
    }
  }
  return String(value).trim();
}

function normalizedHeader(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

const SOURCE_HEADERS = new Set([
  "源url",
  "原url",
  "来源url",
  "sourceurl",
  "fromurl",
]);
const TARGET_HEADERS = new Set(["目标url", "跳转url", "targeturl", "tourl"]);
const STATUS_HEADERS = new Set([
  "状态码",
  "跳转状态码",
  "status",
  "statuscode",
  "httpstatus",
]);

function normalizeRedirectUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 HTTP/HTTPS URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL 不能包含账号或密码");
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

export async function parseRedirectWorkbook(data: Buffer): Promise<{
  rows: RedirectPreviewRow[];
  errors: RedirectPreviewError[];
  total: number;
  validCount: number;
  errorCount: number;
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return {
      rows: [],
      errors: [{ row: 0, message: "工作簿中没有工作表。" }],
      total: 0,
      validCount: 0,
      errorCount: 1,
    };
  }
  let headerRow = 0;
  let sourceColumn = 0;
  let targetColumn = 0;
  let statusColumn = 0;
  for (
    let rowNumber = 1;
    rowNumber <= Math.min(sheet.actualRowCount, 20);
    rowNumber += 1
  ) {
    const row = sheet.getRow(rowNumber);
    row.eachCell((cell, column) => {
      const header = normalizedHeader(cellText(cell.value));
      if (SOURCE_HEADERS.has(header)) sourceColumn = column;
      if (TARGET_HEADERS.has(header)) targetColumn = column;
      if (STATUS_HEADERS.has(header)) statusColumn = column;
    });
    if (sourceColumn && targetColumn && statusColumn) {
      headerRow = rowNumber;
      break;
    }
    sourceColumn = 0;
    targetColumn = 0;
    statusColumn = 0;
  }
  if (!headerRow) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: "缺少“源URL、目标URL、状态码”表头。",
        },
      ],
      total: 0,
      validCount: 0,
      errorCount: 1,
    };
  }
  const errors: RedirectPreviewError[] = [];
  const rows: RedirectPreviewRow[] = [];
  const invalidRows = new Set<number>();
  const sourceRows = new Map<string, number>();
  const maximumRow = Math.min(
    sheet.actualRowCount,
    headerRow + MAX_REDIRECT_ROWS,
  );
  if (sheet.actualRowCount > headerRow + MAX_REDIRECT_ROWS) {
    errors.push({
      row: 0,
      message: `单次最多预检 ${MAX_REDIRECT_ROWS} 条跳转记录。`,
    });
  }
  for (let rowNumber = headerRow + 1; rowNumber <= maximumRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawSource = cellText(row.getCell(sourceColumn).value);
    const rawTarget = cellText(row.getCell(targetColumn).value);
    const rawStatus = cellText(row.getCell(statusColumn).value);
    if (!rawSource && !rawTarget && !rawStatus) continue;
    let sourceUrl = rawSource;
    let targetUrl = rawTarget;
    const statusCode = Number(rawStatus);
    try {
      sourceUrl = normalizeRedirectUrl(rawSource);
    } catch (error) {
      invalidRows.add(rowNumber);
      errors.push({
        row: rowNumber,
        message: `源URL无效：${error instanceof Error ? error.message : "格式错误"}`,
      });
    }
    try {
      targetUrl = normalizeRedirectUrl(rawTarget);
    } catch (error) {
      invalidRows.add(rowNumber);
      errors.push({
        row: rowNumber,
        message: `目标URL无效：${error instanceof Error ? error.message : "格式错误"}`,
      });
    }
    if (statusCode !== 301) {
      invalidRows.add(rowNumber);
      errors.push({ row: rowNumber, message: "状态码必须为 301。" });
    }
    if (sourceUrl && sourceUrl === targetUrl) {
      invalidRows.add(rowNumber);
      errors.push({ row: rowNumber, message: "源URL不能与目标URL相同。" });
    }
    const previous = sourceRows.get(sourceUrl);
    if (previous) {
      invalidRows.add(previous);
      invalidRows.add(rowNumber);
      errors.push({
        row: rowNumber,
        message: `源URL与第 ${previous} 行重复。`,
      });
    } else if (sourceUrl) {
      sourceRows.set(sourceUrl, rowNumber);
    }
    rows.push({ row: rowNumber, sourceUrl, targetUrl, statusCode });
  }
  if (rows.length === 0) {
    errors.push({ row: 0, message: "文件中至少需要一条 301 跳转记录。" });
  }

  const nextBySource = new Map(rows.map((row) => [row.sourceUrl, row]));
  const globallyVisited = new Set<string>();
  for (const row of rows) {
    if (invalidRows.has(row.row) || globallyVisited.has(row.sourceUrl))
      continue;
    const path = new Map<string, number>();
    let current: RedirectPreviewRow | undefined = row;
    while (current && !invalidRows.has(current.row)) {
      if (path.has(current.sourceUrl)) {
        const cycleStart = path.get(current.sourceUrl)!;
        const cycleRows = [...path.entries()]
          .filter(([, position]) => position >= cycleStart)
          .map(([source]) => nextBySource.get(source)!)
          .filter(Boolean);
        for (const cycleRow of cycleRows) invalidRows.add(cycleRow.row);
        errors.push({
          row: current.row,
          message: `检测到循环跳转：${cycleRows
            .map((cycleRow) => cycleRow.row)
            .join(" → ")}`,
        });
        break;
      }
      if (globallyVisited.has(current.sourceUrl)) break;
      path.set(current.sourceUrl, path.size);
      current = nextBySource.get(current.targetUrl);
    }
    for (const source of path.keys()) globallyVisited.add(source);
  }
  const validRows = rows.filter((row) => !invalidRows.has(row.row));
  return {
    rows: validRows,
    errors,
    total: rows.length,
    validCount: validRows.length,
    errorCount: errors.length,
  };
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new DeliveryTicketError(
      "DATABASE_UNAVAILABLE",
      "数据库暂时不可用。",
      503,
    );
  }
  return db;
}

export async function downloadOwnedRedirectFile(
  ownerUserId: number,
  fileId: string,
) {
  let resolved;
  try {
    resolved = await ownedFileContentResolver.resolve({ ownerUserId, fileId });
  } catch (error) {
    if (error instanceof OwnedFileContentError) {
      throw new DeliveryTicketError(
        error.code === "SOURCE_FORBIDDEN"
          ? "ATTACHMENT_FORBIDDEN"
          : "ATTACHMENT_UNAVAILABLE",
        error.message,
        error.statusCode,
      );
    }
    throw error;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of resolved.stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REDIRECT_FILE_BYTES) {
      resolved.stream.destroy();
      throw new DeliveryTicketError(
        "ATTACHMENT_TOO_LARGE",
        "批量跳转文件不能超过 25MB。",
        400,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function previewRedirectWorkbook(input: {
  actor: AuthenticatedUser;
  userId: number;
  fileId: string;
  filename: string;
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  assertDeliveryTicketServiceEligibility(await getServicePortal(input.userId));
  const buffer = await downloadOwnedRedirectFile(input.actor.id, input.fileId);
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const now = new Date();
  const db = await requireDb();
  const existingRows = await db
    .select()
    .from(deliveryRedirectPreviews)
    .where(
      and(
        eq(deliveryRedirectPreviews.userId, input.userId),
        eq(deliveryRedirectPreviews.fileHash, fileHash),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (existing) {
    if (existing.status !== "applied") {
      await db
        .update(deliveryRedirectPreviews)
        .set({
          ownerUserId: input.actor.id,
          upstreamFileId: input.fileId,
          filename: input.filename,
          status: "previewed",
          expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
        })
        .where(eq(deliveryRedirectPreviews.id, existing.id));
    }
    return {
      previewId: existing.id,
      rows: existing.rows,
      errors: existing.errors,
      total: existing.total,
      validCount: existing.validCount,
      errorCount: existing.errorCount,
      status: existing.status,
      idempotent: true,
    };
  }
  let result: Awaited<ReturnType<typeof parseRedirectWorkbook>>;
  try {
    result = await parseRedirectWorkbook(buffer);
  } catch {
    throw new DeliveryTicketError(
      "REDIRECT_FILE_INVALID",
      "无法解析 XLSX 文件，请使用批量 301 模板后重试。",
      400,
    );
  }
  const previewId = randomUUID();
  await db
    .insert(deliveryRedirectPreviews)
    .values({
      id: previewId,
      userId: input.userId,
      ownerUserId: input.actor.id,
      upstreamFileId: input.fileId,
      filename: input.filename,
      fileHash,
      rows: result.rows,
      errors: result.errors,
      total: result.total,
      validCount: result.validCount,
      errorCount: result.errorCount,
      status: "previewed",
      createdByUserId: input.actor.id,
      expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
      createdAt: now,
    })
    .onDuplicateKeyUpdate({
      set: { fileHash },
    });
  const storedRows = await db
    .select()
    .from(deliveryRedirectPreviews)
    .where(
      and(
        eq(deliveryRedirectPreviews.userId, input.userId),
        eq(deliveryRedirectPreviews.fileHash, fileHash),
      ),
    )
    .limit(1);
  const stored = storedRows[0];
  return {
    previewId: stored?.id ?? previewId,
    rows: stored?.rows ?? result.rows,
    errors: stored?.errors ?? result.errors,
    total: stored?.total ?? result.total,
    validCount: stored?.validCount ?? result.validCount,
    errorCount: stored?.errorCount ?? result.errorCount,
    status: stored?.status ?? "previewed",
    idempotent: Boolean(stored && stored.id !== previewId),
  };
}

export async function confirmRedirectWorkbook(input: {
  actor: AuthenticatedUser;
  userId: number;
  ticketId: string;
  previewId: string;
  expectedRevision: number;
}) {
  await assertWorkspaceAccess(input.actor, input.userId);
  assertDeliveryTicketServiceEligibility(await getServicePortal(input.userId));
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const previews = await tx
      .select()
      .from(deliveryRedirectPreviews)
      .where(
        and(
          eq(deliveryRedirectPreviews.id, input.previewId),
          eq(deliveryRedirectPreviews.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const preview = previews[0];
    if (!preview) {
      throw new DeliveryTicketError(
        "REDIRECT_PREVIEW_NOT_FOUND",
        "预检记录不存在。",
        404,
      );
    }
    if (
      preview.status === "applied" &&
      preview.appliedTicketId === input.ticketId
    ) {
      return { success: true, idempotent: true };
    }
    if (
      preview.status !== "previewed" ||
      preview.expiresAt.getTime() <= Date.now()
    ) {
      throw new DeliveryTicketError(
        "REDIRECT_PREVIEW_EXPIRED",
        "预检已过期，请重新上传检查。",
      );
    }
    if (preview.errorCount > 0) {
      throw new DeliveryTicketError(
        "REDIRECT_PREVIEW_INVALID",
        "预检仍有错误，未修改当前工单。",
        400,
      );
    }
    const tickets = await tx
      .select()
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.id, input.ticketId),
          eq(deliveryTickets.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const ticket = tickets[0];
    if (!ticket) {
      throw new DeliveryTicketError("TICKET_NOT_FOUND", "工单不存在。", 404);
    }
    if (ticket.category !== "bulk_redirect" || ticket.quotaPool !== null) {
      throw new DeliveryTicketError(
        "REDIRECT_TICKET_REQUIRED",
        "批量跳转文件只能应用到 301 跳转工单。",
        400,
      );
    }
    if (ticket.revision !== input.expectedRevision) {
      throw new DeliveryTicketError(
        "TICKET_REVISION_CONFLICT",
        "工单已更新，请刷新后重试。",
      );
    }
    if (
      ticket.status !== "submitted" &&
      ticket.status !== "needs_information"
    ) {
      throw new DeliveryTicketError(
        "TICKET_ALREADY_SCHEDULED",
        "工单已进入执行，不能重复应用跳转文件。",
      );
    }
    const now = new Date();
    const eventId = randomUUID();
    await tx.insert(deliveryTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      userId: input.userId,
      actorUserId: input.actor.id,
      actorRole: "admin",
      kind: "attachment",
      visibility: "customer",
      message: `批量 301 文件预检通过，共 ${preview.validCount} 条记录，已进入执行。`,
      fromStatus: ticket.status,
      toStatus: "scheduled",
      createdAt: now,
    });
    await tx.insert(deliveryTicketAttachments).values({
      id: randomUUID(),
      ticketId: ticket.id,
      eventId,
      workspaceUserId: input.userId,
      ownerUserId: preview.ownerUserId,
      kind: "input",
      upstreamFileId: preview.upstreamFileId,
      filename: preview.filename,
      purpose: "批量 301 跳转清单",
      authorization: "owned",
      createdAt: now,
    });
    await tx
      .update(deliveryTickets)
      .set({
        status: "scheduled",
        scheduledAt: ticket.scheduledAt ?? now,
        revision: ticket.revision + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx
      .update(deliveryRedirectPreviews)
      .set({
        status: "applied",
        appliedTicketId: ticket.id,
        appliedAt: now,
      })
      .where(eq(deliveryRedirectPreviews.id, preview.id));
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "delivery_ticket.redirects_applied",
        targetType: "delivery_ticket",
        targetId: ticket.id,
        workspaceUserId: input.userId,
        metadata: {
          previewId: preview.id,
          fileHash: preview.fileHash,
          validCount: preview.validCount,
          revision: ticket.revision + 1,
        },
      },
      tx,
    );
    return {
      success: true,
      idempotent: false,
      revision: ticket.revision + 1,
      validCount: preview.validCount,
    };
  });
}
