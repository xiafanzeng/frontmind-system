import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";

import {
  responseLogicEntries,
  upstreamResources,
} from "../drizzle/schema";
import type {
  ConfirmedResponseLogic,
  ResponseLogicAttachment,
  ResponseLogicDraft,
  ResponseLogicRecordDto,
  SaveResponseLogicInput,
} from "../shared/response-logic";
import {
  AuthServiceError,
  credentialMayServeAccount,
} from "./auth-service";
import { getDb } from "./db";

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

function attachmentsFromDraft(
  draft: ResponseLogicDraft | ConfirmedResponseLogic | null | undefined,
) {
  return Array.isArray(draft?.attachments) ? draft.attachments : [];
}

export function mergeVerifiedResponseLogicAttachments(
  existing: ResponseLogicAttachment[],
  verified: ResponseLogicAttachment[],
) {
  const merged = new Map<string, ResponseLogicAttachment>();
  for (const attachment of [...existing, ...verified]) {
    merged.set(attachment.fileId, attachment);
  }
  return [...merged.values()];
}

export function withAuthoritativeAttachments(input: {
  draft: ResponseLogicDraft;
  existingDraft?: ResponseLogicDraft | null;
  verifiedAttachments?: ResponseLogicAttachment[];
}): ResponseLogicDraft {
  return {
    ...input.draft,
    // Public draft saves cannot introduce or delete upstream file IDs.
    attachments: mergeVerifiedResponseLogicAttachments(
      attachmentsFromDraft(input.existingDraft),
      input.verifiedAttachments ?? [],
    ),
  };
}

function normalizeStoredDraft(draft: ResponseLogicDraft): ResponseLogicDraft {
  return {
    ...draft,
    // Rows written before this field existed remain readable.
    attachments: attachmentsFromDraft(draft),
  };
}

function draftContent(
  draft: ResponseLogicDraft | ConfirmedResponseLogic,
): ResponseLogicDraft {
  return {
    concern: draft.concern,
    conclusion: draft.conclusion,
    facts: draft.facts,
    pending: draft.pending,
    boundaries: draft.boundaries,
    references: draft.references,
    images: draft.images,
    attachments: attachmentsFromDraft(draft),
  };
}

function sameDraftContent(
  left: ResponseLogicDraft | ConfirmedResponseLogic,
  right: ResponseLogicDraft | ConfirmedResponseLogic,
) {
  return (
    JSON.stringify(draftContent(left)) === JSON.stringify(draftContent(right))
  );
}

function sameResponseLogicQuestion(
  current: typeof responseLogicEntries.$inferSelect,
  incoming: SaveResponseLogicInput,
) {
  return (
    current.groupId === incoming.groupId &&
    current.groupTitle === incoming.groupTitle &&
    current.question === incoming.question &&
    current.intent === incoming.intent &&
    current.summary === incoming.summary
  );
}

export function assertResponseLogicDraftPublishable(draft: ResponseLogicDraft) {
  const required: Array<[string, string]> = [
    ["用户真正关心", draft.concern],
    ["核心结论 / 执行口径", draft.conclusion],
    ["企业材料 / 官方依据", draft.facts],
    ["表达边界", draft.boundaries],
    ["参考资料", draft.references],
  ];
  const missing = required
    .filter(([, value]) => !value.trim())
    .map(([label]) => label);
  if (missing.length > 0) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      `请先补齐以下应答逻辑内容：${missing.join("、")}`,
    );
  }
}

function toDto(
  row: typeof responseLogicEntries.$inferSelect,
): ResponseLogicRecordDto {
  const draft = normalizeStoredDraft(row.draft);
  const confirmed = row.confirmed
    ? {
        ...row.confirmed,
        attachments: attachmentsFromDraft(row.confirmed),
      }
    : null;
  return {
    id: row.id,
    questionId: row.questionId,
    groupId: row.groupId,
    groupTitle: row.groupTitle,
    question: row.question,
    intent: row.intent,
    summary: row.summary,
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.lastTaskId ? { lastTaskId: row.lastTaskId } : {}),
    draft,
    ...(confirmed ? { confirmed } : {}),
    revision: row.revision,
    version: row.version,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class ResponseLogicRevisionConflictError extends Error {
  readonly code = "RESPONSE_LOGIC_REVISION_CONFLICT";
  readonly statusCode = 409;

  constructor(questionId: string, expected: number, actual: number) {
    super(
      `应答逻辑 ${questionId} 已更新到 R${actual}，当前模板为 R${expected}；请重新下载当前内容模板。`,
    );
    this.name = "ResponseLogicRevisionConflictError";
  }
}

export class ResponseLogicTaskActiveError extends Error {
  readonly code = "RESPONSE_LOGIC_TASK_ACTIVE";
  readonly statusCode = 409;

  constructor() {
    super("当前问题已有正在使用的应答逻辑任务，请刷新并继续该任务");
    this.name = "ResponseLogicTaskActiveError";
  }
}

export function assertResponseLogicTaskSlotAvailable(input: {
  currentTaskId?: string | null;
  incomingTaskId: string;
}) {
  if (
    input.currentTaskId &&
    input.currentTaskId !== input.incomingTaskId
  ) {
    throw new ResponseLogicTaskActiveError();
  }
}

export type VersionedResponseLogicSave = {
  expectedRevision: number;
  value: SaveResponseLogicInput;
};

type ResponseLogicBatchTransactionHook = (
  executor: any,
  records?: ResponseLogicRecordDto[],
) => Promise<void>;

export async function listResponseLogicEntries(
  userId: number,
): Promise<ResponseLogicRecordDto[]> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(responseLogicEntries)
    .where(eq(responseLogicEntries.userId, userId))
    .orderBy(
      asc(responseLogicEntries.groupId),
      asc(responseLogicEntries.questionId),
    );
  return rows.map(toDto);
}

export async function listResponseLogicEntriesByQuestionIds(
  userId: number,
  questionIds: string[],
): Promise<ResponseLogicRecordDto[]> {
  const uniqueQuestionIds = [...new Set(questionIds.filter(Boolean))];
  if (uniqueQuestionIds.length === 0) return [];
  const db = await requireDb();
  const rows = await db
    .select()
    .from(responseLogicEntries)
    .where(
      and(
        eq(responseLogicEntries.userId, userId),
        inArray(responseLogicEntries.questionId, uniqueQuestionIds),
      ),
    )
    .orderBy(
      asc(responseLogicEntries.groupId),
      asc(responseLogicEntries.questionId),
    );
  return rows.map(toDto);
}

export async function getResponseLogicEntry(
  userId: number,
  questionId: string,
): Promise<ResponseLogicRecordDto | null> {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(responseLogicEntries)
    .where(
      and(
        eq(responseLogicEntries.userId, userId),
        eq(responseLogicEntries.questionId, questionId),
      ),
    )
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function saveResponseLogicEntry(input: {
  userId: number;
  value: SaveResponseLogicInput;
  verifiedAttachments?: ResponseLogicAttachment[];
}): Promise<ResponseLogicRecordDto> {
  const db = await requireDb();
  const now = new Date();

  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(responseLogicEntries)
      .where(
        and(
          eq(responseLogicEntries.userId, input.userId),
          eq(responseLogicEntries.questionId, input.value.questionId),
        ),
      )
      .limit(1)
      .for("update");
    const existing = rows[0];
    const draft = withAuthoritativeAttachments({
      draft: input.value.draft,
      existingDraft: existing?.draft,
      verifiedAttachments: input.verifiedAttachments,
    });
    if (input.value.publish) {
      assertResponseLogicDraftPublishable(draft);
    }
    const version = input.value.publish
      ? Math.max(existing?.version ?? 0, 0) + 1
      : (existing?.version ?? 0);
    const confirmed: ConfirmedResponseLogic | null = input.value.publish
      ? {
          ...draft,
          images: draft.images.map((image) => ({ ...image })),
          attachments: draft.attachments.map((attachment) => ({
            ...attachment,
          })),
          version,
          updatedAt: now.toISOString(),
        }
      : (existing?.confirmed ?? null);
    const values = {
      groupId: input.value.groupId,
      groupTitle: input.value.groupTitle,
      question: input.value.question,
      intent: input.value.intent,
      summary: input.value.summary,
      conversationId:
        input.value.conversationId ?? existing?.conversationId ?? null,
      lastTaskId: existing?.lastTaskId ?? null,
      draft,
      confirmed,
      version,
      revision: (existing?.revision ?? 0) + 1,
      status: (confirmed ? "confirmed" : "draft") as "draft" | "confirmed",
      updatedAt: now,
    };

    if (existing) {
      await tx
        .update(responseLogicEntries)
        .set(values)
        .where(eq(responseLogicEntries.id, existing.id));
      return;
    }

    await tx.insert(responseLogicEntries).values({
      id: randomUUID(),
      userId: input.userId,
      questionId: input.value.questionId,
      ...values,
      createdAt: now,
    });
  });

  const rows = await db
    .select()
    .from(responseLogicEntries)
    .where(
      and(
        eq(responseLogicEntries.userId, input.userId),
        eq(responseLogicEntries.questionId, input.value.questionId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new AuthServiceError("NOT_FOUND", "Response logic was not saved");
  }
  return toDto(rows[0]);
}

/**
 * Publishes an administrator-imported response-logic template atomically.
 *
 * Every row is locked and checked against its record revision before any write.
 * Optional hooks let the dashboard import route consume its one-time preflight
 * credential and append its audit event inside this same database transaction.
 */
export async function saveResponseLogicEntriesBatch(input: {
  userId: number;
  entries: VersionedResponseLogicSave[];
  beforeWrite?: ResponseLogicBatchTransactionHook;
  afterWrite?: ResponseLogicBatchTransactionHook;
}): Promise<ResponseLogicRecordDto[]> {
  const questionIds = input.entries.map((entry) => entry.value.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new AuthServiceError(
      "CONFLICT",
      "Response logic batch contains duplicate questions",
    );
  }
  if (input.entries.length === 0) return [];

  const db = await requireDb();
  const now = new Date();
  return db.transaction(async (tx) => {
    await input.beforeWrite?.(tx);

    const currentRows = await tx
      .select()
      .from(responseLogicEntries)
      .where(
        and(
          eq(responseLogicEntries.userId, input.userId),
          inArray(responseLogicEntries.questionId, questionIds),
        ),
      )
      .for("update");
    const currentByQuestionId = new Map(
      currentRows.map((row) => [row.questionId, row]),
    );

    for (const entry of input.entries) {
      const current = currentByQuestionId.get(entry.value.questionId);
      const actualRevision = current?.revision ?? 0;
      if (entry.expectedRevision !== actualRevision) {
        throw new ResponseLogicRevisionConflictError(
          entry.value.questionId,
          entry.expectedRevision,
          actualRevision,
        );
      }
    }

    const changedEntries = input.entries.filter((entry) => {
      const existing = currentByQuestionId.get(entry.value.questionId);
      if (!existing) return true;
      if (!sameResponseLogicQuestion(existing, entry.value)) return true;
      if (entry.value.publish) {
        return (
          !existing.confirmed ||
          !sameDraftContent(entry.value.draft, existing.confirmed)
        );
      }
      return !sameDraftContent(entry.value.draft, existing.draft);
    });

    for (const entry of changedEntries) {
      const existing = currentByQuestionId.get(entry.value.questionId);
      const draft = withAuthoritativeAttachments({
        draft: entry.value.draft,
        existingDraft: existing?.draft,
      });
      if (entry.value.publish) {
        assertResponseLogicDraftPublishable(draft);
      }
      const version = entry.value.publish
        ? Math.max(existing?.version ?? 0, 0) + 1
        : (existing?.version ?? 0);
      const confirmed: ConfirmedResponseLogic | null = entry.value.publish
        ? {
            ...draft,
            images: draft.images.map((image) => ({ ...image })),
            attachments: draft.attachments.map((attachment) => ({
              ...attachment,
            })),
            version,
            updatedAt: now.toISOString(),
          }
        : (existing?.confirmed ?? null);
      const values = {
        groupId: entry.value.groupId,
        groupTitle: entry.value.groupTitle,
        question: entry.value.question,
        intent: entry.value.intent,
        summary: entry.value.summary,
        conversationId:
          entry.value.conversationId ?? existing?.conversationId ?? null,
        lastTaskId: existing?.lastTaskId ?? null,
        draft,
        confirmed,
        version,
        revision: (existing?.revision ?? 0) + 1,
        status: (confirmed ? "confirmed" : "draft") as "draft" | "confirmed",
        updatedAt: now,
      };

      if (existing) {
        await tx
          .update(responseLogicEntries)
          .set(values)
          .where(
            and(
              eq(responseLogicEntries.id, existing.id),
              eq(responseLogicEntries.revision, entry.expectedRevision),
            ),
          );
      } else {
        await tx.insert(responseLogicEntries).values({
          id: randomUUID(),
          userId: input.userId,
          questionId: entry.value.questionId,
          ...values,
          createdAt: now,
        });
      }
    }

    const changedQuestionIds = changedEntries.map(
      (entry) => entry.value.questionId,
    );
    const savedRows =
      changedQuestionIds.length > 0
        ? await tx
            .select()
            .from(responseLogicEntries)
            .where(
              and(
                eq(responseLogicEntries.userId, input.userId),
                inArray(responseLogicEntries.questionId, changedQuestionIds),
              ),
            )
            .orderBy(
              asc(responseLogicEntries.groupId),
              asc(responseLogicEntries.questionId),
            )
        : [];
    const records = savedRows.map(toDto);
    await input.afterWrite?.(tx, records);
    return records;
  });
}

export async function recordResponseLogicTaskStart(input: {
  userId: number;
  apiCredentialId: string;
  value: Omit<SaveResponseLogicInput, "publish">;
  taskId: string;
  skillName: string;
  skillVersion: string;
  skillContentHash: string;
  verifiedAttachments: ResponseLogicAttachment[];
}) {
  const db = await requireDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    if (
      !(await credentialMayServeAccount(
        tx,
        input.userId,
        input.apiCredentialId,
      ))
    ) {
      throw new AuthServiceError("NOT_FOUND", "API credential not found");
    }

    // Lock the question slot before claiming the upstream task. This makes a
    // second browser tab lose deterministically instead of replacing the
    // recoverable task binding and orphaning a paid model run.
    const rows = await tx
      .select()
      .from(responseLogicEntries)
      .where(
        and(
          eq(responseLogicEntries.userId, input.userId),
          eq(responseLogicEntries.questionId, input.value.questionId),
        ),
      )
      .limit(1)
      .for("update");
    const existing = rows[0];
    assertResponseLogicTaskSlotAvailable({
      currentTaskId: existing?.lastTaskId,
      incomingTaskId: input.taskId,
    });

    const resourceRows = await tx
      .select()
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "task"),
          eq(upstreamResources.upstreamId, input.taskId),
        ),
      )
      .limit(1)
      .for("update");
    if (resourceRows[0] && resourceRows[0].userId !== input.userId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream task is already owned by another account",
      );
    }
    if (!resourceRows[0]) {
      await tx.insert(upstreamResources).values({
        id: randomUUID(),
        userId: input.userId,
        apiCredentialId: input.apiCredentialId,
        kind: "task",
        upstreamId: input.taskId,
        conversationId: null,
        createdAt: now,
      });
    }

    const draft = withAuthoritativeAttachments({
      draft: input.value.draft,
      existingDraft: existing?.draft,
      verifiedAttachments: input.verifiedAttachments,
    });
    const values = {
      groupId: input.value.groupId,
      groupTitle: input.value.groupTitle,
      question: input.value.question,
      intent: input.value.intent,
      summary: input.value.summary,
      conversationId:
        input.value.conversationId ?? existing?.conversationId ?? null,
      lastTaskId: input.taskId,
      skillName: input.skillName,
      skillVersion: input.skillVersion,
      skillContentHash: input.skillContentHash,
      draft,
      confirmed: existing?.confirmed ?? null,
      version: existing?.version ?? 0,
      revision: (existing?.revision ?? 0) + 1,
      status: (existing?.confirmed ? "confirmed" : "draft") as
        | "draft"
        | "confirmed",
      updatedAt: now,
    };
    if (existing) {
      await tx
        .update(responseLogicEntries)
        .set(values)
        .where(eq(responseLogicEntries.id, existing.id));
    } else {
      await tx.insert(responseLogicEntries).values({
        id: randomUUID(),
        userId: input.userId,
        questionId: input.value.questionId,
        ...values,
        createdAt: now,
      });
    }
  });
  const saved = await getResponseLogicEntry(
    input.userId,
    input.value.questionId,
  );
  if (!saved) {
    throw new AuthServiceError("NOT_FOUND", "Response logic was not saved");
  }
  return saved;
}

/**
 * Releases only the task that is still bound to the question. The compare-
 * and-set guard prevents a late failure response from clearing a newer task.
 */
export async function releaseResponseLogicTaskBinding(input: {
  userId: number;
  questionId: string;
  taskId: string;
}) {
  const db = await requireDb();
  const result = await db
    .update(responseLogicEntries)
    .set({
      lastTaskId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(responseLogicEntries.userId, input.userId),
        eq(responseLogicEntries.questionId, input.questionId),
        eq(responseLogicEntries.lastTaskId, input.taskId),
      ),
    );
  return Boolean(result[0]?.affectedRows);
}
