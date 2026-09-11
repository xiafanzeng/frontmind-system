import {
  businessExecutionLabels,
  type BusinessExecutionPhase,
} from "../shared/frontmind-general-execution";
import { resolveEnterpriseProjectScope } from "./enterprise-project-service";
import { sql } from "drizzle-orm";
import type { CustomerAiTaskUsage } from "../shared/customer-ai-usage";
import { knowledgeBaseRunPhase } from "../shared/knowledge-base-upload-state";
import { getDb } from "./db";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import {
  getEnterpriseProjectScope,
  runWithEnterpriseProjectScope,
} from "./enterprise-project-context";

type UsageRow = {
  runId: string;
  businessName: string;
  generation?: number | null;
  taskId?: string;
  turnId?: string;
  authoritative?: unknown;
  invocationState?: "not_sent" | "called" | "unknown";
  currentTurnInvocationState?: "not_sent" | "called" | "unknown";
  unsettledEvents?: unknown;
  status: string;
  startedAt: Date | string | number;
  lastActivityAt: Date | string | number;
  called: unknown;
  phase?: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheTokens?: unknown;
  chargedTenThousandths?: unknown;
  eventCount?: unknown;
  unknownEvents?: unknown;
  knowledgeTurnMetadata?: unknown;
  knowledgeTurnOperationType?: string | null;
  knowledgeTurnStatus?: string | null;
  knowledgeTurnTaskId?: string | null;
  knowledgeBuildStatus?: string;
};
const time = (value: UsageRow["startedAt"]) =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : new Date(value).getTime();
const number = (value: unknown) =>
  /^\d+$/.test(String(value ?? "")) ? BigInt(String(value)) : 0n;
function isLocalNoModelTurn(row: UsageRow) {
  if (
    row.currentTurnInvocationState !== "unknown" ||
    row.knowledgeTurnStatus !== "completed" ||
    Boolean(row.knowledgeTurnTaskId) ||
    (row.knowledgeTurnOperationType !== "local_confirm" &&
      row.knowledgeTurnOperationType !== "local_select")
  )
    return false;
  const metadata =
    typeof row.knowledgeTurnMetadata === "string"
      ? (() => {
          try {
            return JSON.parse(row.knowledgeTurnMetadata as string);
          } catch {
            return null;
          }
        })()
      : row.knowledgeTurnMetadata;
  return (
    metadata &&
    typeof metadata === "object" &&
    (metadata as { providerRequestCount?: unknown }).providerRequestCount === 0
  );
}
const stateLabels: Record<string, string> = {
  queued: "等待中",
  reserved: "准备中",
  running: "执行中",
  researching: "调研中",
  uploading: "上传中",
  staging: "校验中",
  dispatching: "准备调研",
  normalizing: "整理中",
  confirming: "整理中",
  ready_to_publish: "准备交付",
  published: "已完成",
  completed: "已完成",
  succeeded: "已完成",
  failed: "失败",
  protocol_error: "需要处理",
  attention_required: "需要处理",
  cancelled: "已停止",
  result_pending: "等待结果",
  waiting: "等待中",
  stopped: "已停止",
  finished: "已完成",
  outcome_unknown: "等待确认",
  reset_required: "需要重置",
};
/** Read only the authoritative per-event ledger, never cumulative session snapshots. */
export function projectCustomerAiUsage(
  rows: readonly UsageRow[],
): CustomerAiTaskUsage[] {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key =
      row.generation == null
        ? row.runId
        : `${row.runId}:generation:${row.generation}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const invocation = (row: UsageRow) =>
    row.invocationState ??
    (Boolean(Number(row.called)) ? "called" : "not_sent");
  const usageStatus = (
    entries: readonly UsageRow[],
  ): CustomerAiTaskUsage["usageStatus"] => {
    const events = entries.reduce(
      (total, row) => total + Number(row.eventCount ?? 0),
      0,
    );
    if (!events)
      return entries.every((row) => invocation(row) === "not_sent")
        ? "none"
        : "syncing";
    return entries.some(
      (row) =>
        Number(row.unknownEvents ?? 0) > 0 ||
        Number(row.unsettledEvents ?? 0) > 0 ||
        row.invocationState === "unknown" ||
        (row.currentTurnInvocationState === "unknown" &&
          !isLocalNoModelTurn(row)) ||
        (row.taskId &&
          invocation(row) !== "not_sent" &&
          !Number(row.eventCount)),
    )
      ? "partial"
      : "synced";
  };
  return [...groups]
    .map(([runId, entries]): CustomerAiTaskUsage => {
      // A late ledger sync affects recent activity only. The generation's business
      // record owns state; the SQL catalog provides exactly one such record.
      const business =
        entries.find((row) => Boolean(Number(row.authoritative))) ??
        entries[0]!;
      const ledger = [
        ...new Map(
          entries.filter((row) => row.taskId).map((row) => [row.taskId!, row]),
        ).values(),
      ];
      const chargeRows = ledger.length ? ledger : entries;
      const turnMetadata =
        typeof business.knowledgeTurnMetadata === "string"
          ? JSON.parse(business.knowledgeTurnMetadata)
          : business.knowledgeTurnMetadata;
      const runPhase = business.knowledgeBuildStatus
        ? knowledgeBaseRunPhase({
            buildStatus: business.knowledgeBuildStatus,
            turnStatus: business.knowledgeTurnStatus ?? undefined,
            upstreamTaskId: business.knowledgeTurnTaskId,
            metadata:
              turnMetadata && typeof turnMetadata === "object"
                ? turnMetadata
                : {},
          })
        : null;
      // A completed local confirm/select can be settled without a provider
      // invocation. Keep this explicit whitelist separate from real unknown
      // dispatches.
      const localNoModelTurn = isLocalNoModelTurn(business);
      const currentTurnInvocationState = localNoModelTurn
        ? "not_sent"
        : business.currentTurnInvocationState;
      const uploadStopped =
        runPhase === "cancelled" &&
        currentTurnInvocationState === "not_sent";
      const dispatchUnconfirmed =
        runPhase === "dispatching" &&
        currentTurnInvocationState === "unknown";
      const status = uploadStopped
        ? "stopped"
        : dispatchUnconfirmed
          ? "outcome_unknown"
          : (runPhase ?? business.status);
      const phase = uploadStopped ? "stopped" : (runPhase ?? business.phase);
      const phaseLabel =
        phase && Object.hasOwn(businessExecutionLabels, phase)
          ? businessExecutionLabels[phase as BusinessExecutionPhase]
          : undefined;
      const sum = (key: keyof UsageRow) =>
        chargeRows
          .reduce((total, row) => total + number(row[key]), 0n)
          .toString();
      const invocationState = entries.some(
        (row) => invocation(row) === "called",
      )
        ? "called"
        : entries.some((row) => invocation(row) === "unknown")
          ? "unknown"
          : "not_sent";
      const terminal = [
        "failed",
        "protocol_error",
        "cancelled",
        "stopped",
        "reset_required",
      ].includes(status);
      return {
        runId,
        ...(business.generation == null
          ? {}
          : {
              buildId: business.runId,
              generation: Number(business.generation),
            }),
        businessName: business.businessName,
        status: stateLabels[status] ?? "等待确认",
        startedAt: Math.min(...entries.map((row) => time(row.startedAt))),
        lastActivityAt: Math.max(
          ...entries.map((row) => time(row.lastActivityAt)),
        ),
        phase: uploadStopped
          ? "上传已停止，未产生模型调用"
          : dispatchUnconfirmed
            ? "启动结果待确认"
            : (phaseLabel ??
              (terminal
                ? (stateLabels[status] ?? "需要处理")
                : invocationState === "not_sent"
                  ? "上传或准备资料"
                  : (stateLabels[status] ?? "等待确认"))),
        invocationState,
        ...(currentTurnInvocationState
          ? { currentTurnInvocationState }
          : {}),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        cacheTokens: sum("cacheTokens"),
        chargedTenThousandths: sum("chargedTenThousandths"),
        usageStatus: usageStatus(entries),
        calls: ledger.map((row) => ({
          taskId: row.taskId!,
          ...(row.turnId ? { turnId: row.turnId } : {}),
          startedAt: time(row.startedAt),
          inputTokens: number(row.inputTokens).toString(),
          outputTokens: number(row.outputTokens).toString(),
          cacheTokens: number(row.cacheTokens).toString(),
          chargedTenThousandths: number(row.chargedTenThousandths).toString(),
          usageStatus: usageStatus([row]),
        })),
      };
    })
    .sort(
      (a, b) =>
        b.lastActivityAt - a.lastActivityAt || a.runId.localeCompare(b.runId),
    );
}

export async function listCustomerAiUsage(
  actor: AuthenticatedUser,
  input: { page: number; enterpriseProjectId?: string },
): Promise<{
  tasks: CustomerAiTaskUsage[];
  total: number;
  page: number;
  pageSize: number;
}> {
  if (input.enterpriseProjectId) {
    const selected = await resolveEnterpriseProjectScope(
      actor,
      input.enterpriseProjectId,
    );
    return runWithEnterpriseProjectScope(selected, () =>
      listCustomerAiUsage(actor, { page: input.page }),
    );
  }
  const scope = getEnterpriseProjectScope();
  if (!scope || scope.actorUserId !== actor.id)
    throw new AuthServiceError("NOT_FOUND", "请先选择企业项目。");
  await assertWorkspaceAccess(actor, scope.ownerUserId);
  const db = await getDb();
  if (!db)
    throw new AuthServiceError("DATABASE_UNAVAILABLE", "用量数据暂不可用。");
  const projectFilter = (column: string) =>
    scope.isLegacyDefault
      ? sql`(${sql.raw(column)}=${scope.enterpriseProjectId} OR ${sql.raw(column)} IS NULL)`
      : sql`${sql.raw(column)}=${scope.enterpriseProjectId}`;
  // Filtering both the task catalog and ledger prevents cross-project attribution.
  // The ledger's unique (session_id, provider_event_id) key owns event deduplication.
  const tasks = await db.transaction(
    async (tx) => {
      const [taskRows] =
        await tx.execute(sql`SELECT COALESCE(ct.buildId,t.id) AS runId,ct.buildGeneration AS generation,t.id AS taskId,ct.id AS turnId,
    CASE WHEN ct.buildId IS NOT NULL THEN '知识库'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.generalPurpose.purpose'))='enterprise_qa' THEN '企业问答'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.generalPurpose.purpose'))='content_production' THEN '内容生产'
      WHEN o.operation_type LIKE '%siteops%' THEN '官网制作'
      WHEN o.operation_type LIKE '%question%' THEN '问题优化'
      ELSE '智能体任务' END AS businessName,
    o.status,t.created_at AS startedAt,t.updated_at AS lastActivityAt,
    (t.provider_task_id IS NOT NULL OR COALESCE(e.eventCount,0)>0) AS called,
    CASE WHEN t.provider_task_id IS NOT NULL OR COALESCE(e.eventCount,0)>0 THEN 'called'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(ct.metadata,'$.createAttemptState'))='not_sent' THEN 'not_sent'
      WHEN ct.id IS NULL AND t.provider_state IN ('queued','preparing','preparation_failed') THEN 'not_sent'
      ELSE 'unknown' END AS invocationState,
    COALESCE(e.inputTokens,0) AS inputTokens,COALESCE(e.outputTokens,0) AS outputTokens,
    COALESCE(e.cacheTokens,0) AS cacheTokens,COALESCE(e.chargedTenThousandths,0) AS chargedTenThousandths,
    COALESCE(e.eventCount,0) AS eventCount,COALESCE(e.unknownEvents,0) AS unknownEvents,COALESCE(e.unsettledEvents,0) AS unsettledEvents
    FROM agent_tasks t JOIN agent_operations o ON o.id=t.operation_id
    LEFT JOIN conversation_turns ct ON (ct.id=JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId'))
      OR CONCAT('knowledge-node-edit:',ct.id)=JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId')))
      AND ct.userId=${scope.ownerUserId} AND ${projectFilter("ct.enterpriseProjectId")}
    LEFT JOIN (SELECT local_task_id,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
      SUM(COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0)) AS cacheTokens,
      SUM(charged_ten_thousandths) AS chargedTenThousandths,COUNT(*) AS eventCount,
      SUM(input_tokens IS NULL OR output_tokens IS NULL) AS unknownEvents,
      SUM(cost_state IN ('pending','pending_identity') OR cost_state IS NULL) AS unsettledEvents
      FROM ai_cost_events WHERE account_user_id=${scope.ownerUserId} AND ${projectFilter("enterprise_project_id")}
      AND scope='managed_user' GROUP BY local_task_id) e ON e.local_task_id=t.id
    -- Provider transport is also used by real model turns (including initial
    -- and Low-edit turns), so keep those rows and their charges. Only the
    -- explicit managed-upload and turn-attachment intents are file transfer
    -- resources; their durable owner is the KB build/turn below.
    WHERE o.scope='managed_user' AND o.account_user_id=${scope.ownerUserId}
      AND NOT (
        o.operation_type='dashboard.provider.transport' AND
        (
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId')),'') LIKE 'managed-upload:%'
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId')),'') REGEXP '^[0-9A-Fa-f-]{36}:attachment:[0-9]+:generation:[0-9]+$'
        )
        AND ct.id IS NULL AND COALESCE(e.eventCount,0)=0
        AND COALESCE(JSON_LENGTH(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.commands')),0)=0
        AND COALESCE(JSON_CONTAINS_PATH(t.provider_runtime,'one',
          '$.dashboardManaged.sessionId','$.dashboardManaged.agentId','$.dashboardManaged.environmentId',
          '$.dashboardManaged.mutations.agent','$.dashboardManaged.mutations.environment','$.dashboardManaged.mutations.session'),0)=0
      )
      AND ${projectFilter("o.enterpriseProjectId")}`);
      // A durable upload/build must remain visible before any model transport exists.
      const [buildRows] =
        await tx.execute(sql`SELECT b.id AS runId,g.generation,'知识库' AS businessName,1 AS authoritative,
    ct.metadata AS knowledgeTurnMetadata,ct.operationType AS knowledgeTurnOperationType,ct.status AS knowledgeTurnStatus,ct.upstreamTaskId AS knowledgeTurnTaskId,
    CASE WHEN g.generation=b.generation THEN b.status ELSE COALESCE(ct.status,'cancelled') END AS knowledgeBuildStatus,
    CASE WHEN g.generation=b.generation THEN b.status ELSE COALESCE(ct.status,'cancelled') END AS status,
    COALESCE((SELECT MIN(h.createdAt) FROM conversation_turns h WHERE h.buildId=b.id AND h.buildGeneration=g.generation),b.createdAt) AS startedAt,
    CASE WHEN g.generation=b.generation THEN GREATEST(b.updatedAt,COALESCE(ct.updatedAt,b.updatedAt)) ELSE ct.updatedAt END AS lastActivityAt,
    CASE WHEN g.generation=b.generation AND (b.status='published' OR b.contentCompletedAt IS NOT NULL) THEN 'published'
      WHEN JSON_EXTRACT(ct.metadata,'$.awaitingClientAttachments')=true THEN 'uploading'
      ELSE (SELECT JSON_UNQUOTE(JSON_EXTRACT(a.normalized_payload,'$.businessPhase')) FROM agent_events a
        WHERE a.task_id=b.id AND JSON_EXTRACT(a.normalized_payload,'$.knowledgeGeneration')=g.generation
        AND JSON_UNQUOTE(JSON_EXTRACT(a.normalized_payload,'$.kind'))='business_event'
        ORDER BY a.provider_timestamp_ms DESC,a.id DESC LIMIT 1) END AS phase,
    CASE WHEN ct.upstreamTaskId IS NOT NULL THEN 'called'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(ct.metadata,'$.createAttemptState'))='not_sent' THEN 'not_sent'
      ELSE 'unknown' END AS currentTurnInvocationState,
    EXISTS(SELECT 1 FROM conversation_turns h WHERE h.buildId=b.id AND h.buildGeneration=g.generation AND h.upstreamTaskId IS NOT NULL) AS called,
    CASE WHEN EXISTS(SELECT 1 FROM conversation_turns h WHERE h.buildId=b.id AND h.buildGeneration=g.generation AND h.upstreamTaskId IS NOT NULL) THEN 'called'
      WHEN NOT EXISTS(SELECT 1 FROM conversation_turns h WHERE h.buildId=b.id AND h.buildGeneration=g.generation AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.createAttemptState')),'unknown')<>'not_sent') THEN 'not_sent'
      ELSE 'unknown' END AS invocationState
    FROM knowledge_base_builds b
    JOIN (SELECT id AS buildId,generation FROM knowledge_base_builds UNION SELECT buildId,buildGeneration AS generation FROM conversation_turns WHERE buildId IS NOT NULL) g ON g.buildId=b.id
    LEFT JOIN conversation_turns ct ON ct.id=COALESCE(CASE WHEN g.generation=b.generation THEN b.activeTurnId END,(SELECT h.id FROM conversation_turns h WHERE h.buildId=b.id AND h.buildGeneration=g.generation ORDER BY (SELECT MAX(m.sequence) FROM messages m WHERE m.turnId=h.id AND m.role='user') DESC,h.expectedRevision DESC,h.createdAt DESC,h.id DESC LIMIT 1))
      AND ct.buildId=b.id AND ct.buildGeneration=g.generation
      AND ct.userId=${scope.ownerUserId} AND ${projectFilter("ct.enterpriseProjectId")}
    WHERE b.userId=${scope.ownerUserId} AND ${projectFilter("b.enterpriseProjectId")}`);
      return projectCustomerAiUsage([
        ...(taskRows as unknown as UsageRow[]),
        ...(buildRows as unknown as UsageRow[]),
      ]);
    },
    { isolationLevel: "repeatable read" },
  );
  return {
    tasks: tasks.slice((input.page - 1) * 20, input.page * 20),
    total: tasks.length,
    page: input.page,
    pageSize: 20,
  };
}
