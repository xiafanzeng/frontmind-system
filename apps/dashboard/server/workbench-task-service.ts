import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  conversations,
  messages,
  monitoringAccountLinks,
  enterpriseProjectMonitoringLinks,
  knowledgeBaseSnapshots,
  siteProjects,
  knowledgeBaseBuilds,
  responseLogicEntries,
  conversationTurns,
  agentTasks,
  agentOperations,
} from "../drizzle/schema";
import {
  findWorkbenchMonitoringResource,
  findWorkbenchPublishingResource,
} from "../../../packages/monitoring-db/src/workbench-resource-access";
import { currentEnterpriseProjectId } from "./enterprise-project-context";
import {
  workspaceQuestionTable,
  workspaceQuestionOwnerPredicate,
} from "./enterprise-project-questions";
import {
  enterpriseOwnerPredicate,
  enterpriseProjectPredicate,
  enterpriseAccountOwnerPredicate,
} from "./enterprise-project-scope";
import { frozenGeneralAgentPurpose } from "./general-agent-purpose";
import { enterpriseConversationStoragePrefix } from "./enterprise-conversation-storage";
import {
  initialWorkbenchTaskState,
  mergeWorkbenchOutputRefs,
  workbenchTaskStateSchema,
  type WorkbenchAgentId,
  type WorkbenchResourceRef,
  type WorkbenchStatePatch,
  type WorkbenchTaskState,
} from "../shared/workbench-task";

type Scope = { userId: number; projectAssignmentId: string | null };
type Receipt = { fingerprint: string; conversationId: string };
type StoredWorkbench = {
  state: WorkbenchTaskState;
  handoffs: Record<string, Receipt>;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const workbenchStorageMessageId = (conversationId: string) =>
  `workbench:${hash(conversationId)}`;
export function parsedWorkbenchStorage(row: {
  id?: string;
  conversationId?: string;
  role?: string;
  metadata?: unknown;
}): StoredWorkbench | null {
  if (
    row.role !== "system" ||
    row.id !== workbenchStorageMessageId(row.conversationId ?? "")
  )
    return null;
  const metadata = row.metadata as { workbench?: StoredWorkbench } | null;
  const parsed = workbenchTaskStateSchema.safeParse(metadata?.workbench?.state);
  return parsed.success
    ? { state: parsed.data, handoffs: metadata?.workbench?.handoffs ?? {} }
    : null;
}
export function isWorkbenchStorageMessage(row: {
  id?: string;
  conversationId?: string;
  role?: string;
}) {
  return (
    row.role === "system" &&
    row.id === workbenchStorageMessageId(row.conversationId ?? "")
  );
}
function publicId(scope: Scope, id: string) {
  const prefix = enterpriseConversationStoragePrefix(
    scope.userId,
    scope.projectAssignmentId,
  );
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
async function ownedConversation(
  tx: any,
  scope: Scope,
  id: string,
  createTitle?: string,
) {
  const storedId = `${enterpriseConversationStoragePrefix(scope.userId, scope.projectAssignmentId)}${id}`;
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        or(eq(conversations.id, storedId), eq(conversations.id, id)),
        scope.projectAssignmentId
          ? and(
              eq(conversations.projectAssignmentId, scope.projectAssignmentId),
              enterpriseProjectPredicate(conversations.enterpriseProjectId),
            )
          : and(
              enterpriseOwnerPredicate(conversations, scope.userId),
              isNull(conversations.projectAssignmentId),
            ),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!row && createTitle !== undefined) {
    const created = {
      id: storedId,
      userId: scope.userId,
      enterpriseProjectId: currentEnterpriseProjectId(),
      projectAssignmentId: scope.projectAssignmentId,
      title: createTitle,
      status: "idle" as const,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await tx.insert(conversations).values(created);
    return created as typeof conversations.$inferSelect;
  }
  if (!row)
    throw new TRPCError({ code: "NOT_FOUND", message: "当前项目中没有此任务" });
  return row as typeof conversations.$inferSelect;
}
export async function readWorkbenchStorage(
  tx: any,
  conversationId: string,
): Promise<StoredWorkbench | null> {
  const [row] = await tx
    .select()
    .from(messages)
    .where(eq(messages.id, workbenchStorageMessageId(conversationId)))
    .limit(1);
  return row ? parsedWorkbenchStorage(row) : null;
}
async function writeStorage(
  tx: any,
  scope: Scope,
  conversationId: string,
  value: StoredWorkbench,
  exists: boolean,
) {
  const id = workbenchStorageMessageId(conversationId);
  const values = {
    metadata: { workbench: value },
    updatedAt: new Date(value.state.updatedAt),
  };
  if (exists) await tx.update(messages).set(values).where(eq(messages.id, id));
  else
    await tx.insert(messages).values({
      id,
      conversationId,
      userId: scope.userId,
      role: "system",
      content: "",
      sequence: -1,
      ...values,
      sentAt: new Date(value.state.updatedAt),
    });
  await tx
    .update(conversations)
    .set({ updatedAt: new Date(value.state.updatedAt) })
    .where(eq(conversations.id, conversationId));
}
export function assertWorkbenchAgent(
  current: WorkbenchTaskState,
  agentId: WorkbenchAgentId,
) {
  if (current.agentId !== agentId)
    throw new TRPCError({
      code: "CONFLICT",
      message: "此任务已绑定其他子智能体，请打开对应任务",
    });
}
export async function bindWorkbenchTask(
  tx: any,
  scope: Scope,
  input: { conversationId: string; agentId: WorkbenchAgentId; title?: string },
) {
  const row = await ownedConversation(
    tx,
    scope,
    input.conversationId,
    input.title ?? "新任务",
  );
  const existing = await readWorkbenchStorage(tx, row.id);
  if (existing) {
    assertWorkbenchAgent(existing.state, input.agentId);
    return existing.state;
  }
  await assertNativeConversationAgent(tx, scope, row, input.agentId);
  const state = initialWorkbenchTaskState(input.agentId);
  await writeStorage(tx, scope, row.id, { state, handoffs: {} }, false);
  return state;
}

/** Native execution ownership predates workbench labels. Never relabel it
 * based on a route, a title, or a client snapshot's requested agent. */
async function assertNativeConversationAgent(
  tx: any,
  scope: Scope,
  row: typeof conversations.$inferSelect,
  agentId: WorkbenchAgentId,
) {
  const ids = [row.id, publicId(scope, row.id)];
  const nativeLinks = [
    { table: knowledgeBaseBuilds, agentId: "knowledge" },
    { table: responseLogicEntries, agentId: "response-logic" },
    { table: siteProjects, agentId: "website" },
  ] as const;
  for (const native of nativeLinks) {
    const [linked] = await tx
      .select({ id: native.table.id })
      .from(native.table)
      .where(
        and(
          enterpriseOwnerPredicate(native.table, scope.userId),
          inArray(native.table.conversationId, ids),
        ),
      )
      .limit(1);
    if (linked && native.agentId !== agentId)
      throw new TRPCError({
        code: "CONFLICT",
        message: "此会话属于原有专用智能体，不能改为其他任务",
      });
  }
  const turns = await tx
    .select({ taskId: conversationTurns.upstreamTaskId })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, row.id),
        enterpriseOwnerPredicate(conversationTurns, scope.userId),
      ),
    );
  const taskIds = [
    ...new Set(
      [
        row.upstreamTaskId,
        row.previousResponseId,
        ...turns.map((turn: { taskId?: string }) => turn.taskId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  if (taskIds.length) {
    const tasks = await tx
      .select()
      .from(agentTasks)
      .where(inArray(agentTasks.id, taskIds));
    for (const task of tasks) {
      const [operation] = await tx
        .select()
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.id, task.operationId),
            enterpriseAccountOwnerPredicate(agentOperations, scope.userId),
            eq(agentOperations.scope, "managed_user"),
          ),
        )
        .limit(1);
      if (!operation) continue;
      const purpose = frozenGeneralAgentPurpose(task, scope.userId)?.purpose;
      const nativeAgent =
        purpose === "enterprise_qa"
          ? "enterprise-qa"
          : purpose === "content_production"
            ? "content"
            : null;
      if (nativeAgent && nativeAgent !== agentId)
        throw new TRPCError({
          code: "CONFLICT",
          message: "此会话已绑定专用问答或内容流程，不能改为其他任务",
        });
    }
  }
  const pending = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, row.id), eq(messages.role, "user")));
  for (const message of pending) {
    const purpose = message.metadata?.generalChatDispatch?.purpose;
    const nativeAgent =
      purpose === "enterprise_qa"
        ? "enterprise-qa"
        : purpose === "content_production"
          ? "content"
          : null;
    if (nativeAgent && nativeAgent !== agentId)
      throw new TRPCError({
        code: "CONFLICT",
        message: "此会话已有专用任务草稿，不能更改智能体",
      });
  }
}
export async function validateWorkbenchResources(
  tx: any,
  scope: Scope,
  resources: WorkbenchResourceRef[],
) {
  for (const resource of resources) {
    let found: unknown;
    if (
      [
        "article",
        "article_version",
        "publication_draft",
        "publication_batch",
        "monitoring_run",
        "monitoring_project",
        "monitor",
      ].includes(resource.kind)
    ) {
      const [link] = await tx
        .select()
        .from(monitoringAccountLinks)
        .where(eq(monitoringAccountLinks.dashboardUserId, scope.userId))
        .limit(1);
      if (link) {
        if (
          resource.kind === "monitoring_run" ||
          resource.kind === "monitoring_project" ||
          resource.kind === "monitor"
        ) {
          const run = await findWorkbenchMonitoringResource(
            tx,
            link.monitoringUserId,
            resource.kind,
            resource.id,
          );
          if (run)
            [found] = await tx
              .select()
              .from(enterpriseProjectMonitoringLinks)
              .where(
                and(
                  eq(
                    enterpriseProjectMonitoringLinks.monitoringProjectId,
                    run.projectId,
                  ),
                  eq(
                    enterpriseProjectMonitoringLinks.ownerUserId,
                    scope.userId,
                  ),
                  enterpriseProjectPredicate(
                    enterpriseProjectMonitoringLinks.enterpriseProjectId,
                  ),
                ),
              )
              .limit(1);
        } else {
          found = await findWorkbenchPublishingResource(tx, {
            ownerId: link.monitoringUserId,
            enterpriseProjectId: currentEnterpriseProjectId(),
            kind: resource.kind as
              | "article"
              | "article_version"
              | "publication_draft"
              | "publication_batch",
            id: resource.id,
          });
        }
      }
    } else if (resource.kind === "question") {
      const table = workspaceQuestionTable();
      [found] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.id, resource.id),
            workspaceQuestionOwnerPredicate(scope.userId),
          ),
        )
        .limit(1);
    } else {
      const table = {
        knowledge_snapshot: knowledgeBaseSnapshots,
        site: siteProjects,
      }[resource.kind as "knowledge_snapshot" | "site"];
      [found] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.id, resource.id),
            enterpriseOwnerPredicate(table, scope.userId),
          ),
        )
        .limit(1);
    }
    if (!found)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "引用内容不属于当前企业项目，或已不可用",
      });
  }
}
export function applyWorkbenchPatch(
  state: WorkbenchTaskState,
  expectedRevision: number,
  patch: WorkbenchStatePatch,
  now = Date.now(),
): WorkbenchTaskState {
  const incomingRecords = [
    ...(patch.records ?? []),
    ...(patch.record ? [patch.record] : []),
  ];
  if (incomingRecords.some((record) => /^(handoff-|received-)/.test(record.id)))
    throw new TRPCError({ code: "CONFLICT", message: "交接记录由服务端维护" });
  if (state.revision !== expectedRevision)
    throw new TRPCError({
      code: "CONFLICT",
      message: "任务已在其他窗口更新，请恢复最新状态后重试",
    });
  const records = incomingRecords.length
    ? [
        ...state.records.filter(
          (item) => !incomingRecords.some((record) => record.id === item.id),
        ),
        ...[
          ...new Map(
            incomingRecords.map((record) => [record.id, record]),
          ).values(),
        ].map((record) => ({ ...record, timestamp: now })),
      ].slice(-500)
    : state.records;
  return workbenchTaskStateSchema.parse({
    ...state,
    step: patch.step ?? state.step,
    values: patch.values ? { ...state.values, ...patch.values } : state.values,
    resources: patch.resources ?? state.resources,
    ...(state.outputRefs || patch.outputRefs
      ? {
          outputRefs: mergeWorkbenchOutputRefs(
            state.outputRefs,
            patch.outputRefs,
          ),
        }
      : {}),
    records,
    revision: state.revision + 1,
    updatedAt: now,
  });
}
export async function saveWorkbenchTask(
  tx: any,
  scope: Scope,
  input: {
    conversationId: string;
    agentId: WorkbenchAgentId;
    expectedRevision: number;
    patch: WorkbenchStatePatch;
  },
) {
  const row = await ownedConversation(tx, scope, input.conversationId);
  const existing = await readWorkbenchStorage(tx, row.id);
  if (!existing)
    throw new TRPCError({ code: "CONFLICT", message: "请先建立当前任务" });
  assertWorkbenchAgent(existing.state, input.agentId);
  if (input.patch.resources)
    await validateWorkbenchResources(tx, scope, input.patch.resources);
  if (input.patch.outputRefs)
    await validateWorkbenchResources(
      tx,
      scope,
      input.patch.outputRefs.map((ref) => ref.resource),
    );
  const state = applyWorkbenchPatch(
    existing.state,
    input.expectedRevision,
    input.patch,
  );
  await writeStorage(tx, scope, row.id, { ...existing, state }, true);
  return state;
}
export async function handoffWorkbenchTask(
  tx: any,
  scope: Scope,
  input: {
    conversationId: string;
    agentId: WorkbenchAgentId;
    targetAgentId: WorkbenchAgentId;
    title?: string;
    resources: WorkbenchResourceRef[];
    values?: Record<string, unknown>;
    idempotencyKey: string;
  },
) {
  const row = await ownedConversation(tx, scope, input.conversationId);
  const existing = await readWorkbenchStorage(tx, row.id);
  if (!existing)
    throw new TRPCError({ code: "CONFLICT", message: "请先建立当前任务" });
  assertWorkbenchAgent(existing.state, input.agentId);
  const key = hash(input.idempotencyKey);
  const fingerprint = hash(
    JSON.stringify([
      input.targetAgentId,
      input.title ?? "",
      input.resources,
      input.values ?? {},
    ]),
  );
  const receipt = existing.handoffs[key];
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new TRPCError({
        code: "CONFLICT",
        message: "此交接请求已使用其他内容，请开始一次新的交接",
      });
    const target = await ownedConversation(tx, scope, receipt.conversationId);
    const stored = await readWorkbenchStorage(tx, target.id);
    if (!stored)
      throw new TRPCError({ code: "CONFLICT", message: "交接任务已不可用" });
    return { conversationId: receipt.conversationId, state: stored.state };
  }
  await validateWorkbenchResources(tx, scope, input.resources);
  const conversationId = `handoff-${hash(`${row.id}:${key}`).slice(0, 48)}`;
  const storedId = `${enterpriseConversationStoragePrefix(scope.userId, scope.projectAssignmentId)}${conversationId}`;
  const state: WorkbenchTaskState = {
    ...initialWorkbenchTaskState(input.targetAgentId),
    resources: input.resources,
    values: input.values ?? {},
    source: { conversationId: publicId(scope, row.id), agentId: input.agentId },
    records: [
      {
        id: `received-${key}`,
        label: "已接收交接内容",
        status: "completed",
        timestamp: Date.now(),
      },
    ],
  };
  await tx.insert(conversations).values({
    id: storedId,
    userId: scope.userId,
    enterpriseProjectId: currentEnterpriseProjectId(),
    projectAssignmentId: scope.projectAssignmentId,
    title: input.title ?? "交接任务",
    status: "idle",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await writeStorage(tx, scope, storedId, { state, handoffs: {} }, false);
  const sourceState: WorkbenchTaskState = {
    ...existing.state,
    revision: existing.state.revision + 1,
    updatedAt: Date.now(),
    records: [
      ...existing.state.records,
      {
        id: `handoff-${key}`,
        label: input.title ? `已交接：${input.title}` : "已交给目标智能体",
        status: "completed" as const,
        timestamp: Date.now(),
        targetTask: { conversationId, agentId: input.targetAgentId },
      },
    ].slice(-500),
  };
  await writeStorage(
    tx,
    scope,
    row.id,
    {
      state: sourceState,
      handoffs: {
        ...existing.handoffs,
        [key]: { fingerprint, conversationId },
      },
    },
    true,
  );
  return { conversationId, state };
}
