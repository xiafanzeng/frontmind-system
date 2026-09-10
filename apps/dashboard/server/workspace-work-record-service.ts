import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { workspaceAuditEvents } from "../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { getEnterpriseProjectScope } from "./enterprise-project-context";
import { assertWorkspaceAccess } from "./dashboard-service";
import { dashboardImportPreflightSecret } from "./dashboard-import-preflight-service";
import {
  WORK_RECORD_EVENTS,
  WORK_RECORD_MODULES,
  workRecordResourceRef,
} from "./workspace-work-record-contract";
import { workspaceRequestDigest } from "./workspace-operation-identity";

export const workRecordsListSchema = z
  .object({
    enterpriseProjectId: z.string().uuid().optional(),
    module: z.enum(WORK_RECORD_MODULES).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().length(64),
    createdAt: z.number().int().nonnegative(),
    id: z.string().uuid(),
  })
  .strict();
function sign(payload: string) {
  return createHmac("sha256", dashboardImportPreflightSecret())
    .update(`workspace-work-records:v1:${payload}`)
    .digest("base64url");
}
export function encodeWorkRecordsCursor(
  scope: string,
  createdAt: number,
  id: string,
) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, scope, createdAt, id }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}
export function decodeWorkRecordsCursor(cursor: string, scope: string) {
  try {
    const [body, signature, ...rest] = cursor.split(".");
    if (!body || !signature || rest.length) throw new Error();
    const a = Buffer.from(sign(body)),
      b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error();
    const value = cursorSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    if (value.scope !== scope) throw new Error();
    return value;
  } catch {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "工作记录分页已失效，请重新读取。",
    );
  }
}
export function projectPublicWorkRecord(
  row: {
    id: string;
    action: string;
    metadata: Record<string, unknown>;
    createdAt: Date;
  },
  projectId: string,
) {
  const event =
    WORK_RECORD_EVENTS[row.action as keyof typeof WORK_RECORD_EVENTS];
  const module = String(row.metadata.module);
  return {
    id: `wr_${sign(row.id).slice(0, 24)}`,
    module,
    title: event.title,
    summary: event.summary,
    status: event.status,
    createdAt: row.createdAt.getTime(),
    resourceRef: workRecordResourceRef(
      module,
      projectId,
      row.metadata.resourceRef,
    ),
  };
}
export async function listWorkspaceWorkRecords(
  actor: AuthenticatedUser,
  input: z.infer<typeof workRecordsListSchema>,
) {
  const scope = getEnterpriseProjectScope();
  if (
    input.enterpriseProjectId &&
    input.enterpriseProjectId !== scope?.enterpriseProjectId
  )
    throw new AuthServiceError("NOT_FOUND", "工作记录项目与当前工作区不匹配。");
  if (!scope) return { records: [], nextCursor: null };
  if (scope.actorUserId !== actor.id)
    throw new AuthServiceError("NOT_FOUND", "无权访问该工作区。");
  await assertWorkspaceAccess(actor, scope.ownerUserId);
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  const scopeDigest = workspaceRequestDigest({
    actor: actor.id,
    owner: scope.ownerUserId,
    project: scope.enterpriseProjectId,
    module: input.module || null,
  });
  const cursor = input.cursor
    ? decodeWorkRecordsCursor(input.cursor, scopeDigest)
    : null;
  const meta = (key: string) =>
    sql`JSON_UNQUOTE(JSON_EXTRACT(${workspaceAuditEvents.metadata}, ${`$.${key}`}))`;
  const rows = await db
    .select({
      id: workspaceAuditEvents.id,
      action: workspaceAuditEvents.action,
      metadata: workspaceAuditEvents.metadata,
      createdAt: workspaceAuditEvents.createdAt,
    })
    .from(workspaceAuditEvents)
    .where(
      and(
        eq(workspaceAuditEvents.workspaceUserId, scope.ownerUserId),
        inArray(workspaceAuditEvents.action, Object.keys(WORK_RECORD_EVENTS)),
        sql`${meta("schemaVersion")} = '1'`,
        sql`${meta("enterpriseProjectId")} = ${scope.enterpriseProjectId}`,
        sql`${meta("operationId")} IS NOT NULL`,
        sql`JSON_EXTRACT(${workspaceAuditEvents.metadata}, '$.parentOperationId') IS NULL`,
        input.module
          ? sql`${meta("module")} = ${input.module}`
          : inArray(meta("module"), [...WORK_RECORD_MODULES]),
        cursor
          ? or(
              lt(workspaceAuditEvents.createdAt, new Date(cursor.createdAt)),
              and(
                eq(workspaceAuditEvents.createdAt, new Date(cursor.createdAt)),
                lt(workspaceAuditEvents.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(workspaceAuditEvents.createdAt),
      desc(workspaceAuditEvents.id),
    )
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit),
    last = page.at(-1);
  return {
    records: page.map((row) =>
      projectPublicWorkRecord(row, scope.enterpriseProjectId),
    ),
    nextCursor:
      rows.length > input.limit && last
        ? encodeWorkRecordsCursor(
            scopeDigest,
            last.createdAt.getTime(),
            last.id,
          )
        : null,
  };
}
