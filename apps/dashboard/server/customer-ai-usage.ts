import {
  businessExecutionLabels,
  type BusinessExecutionPhase,
} from "../shared/frontmind-general-execution";
import { resolveEnterpriseProjectScope } from "./enterprise-project-service";
import { sql } from "drizzle-orm";
import type { CustomerAiTaskUsage } from "../shared/customer-ai-usage";
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
};
const time = (value: UsageRow["startedAt"]) =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : new Date(value).getTime();
const number = (value: unknown) =>
  /^\d+$/.test(String(value ?? "")) ? BigInt(String(value)) : 0n;
const stateLabels: Record<string, string> = {
  queued: "等待中",
  reserved: "准备中",
  running: "执行中",
  researching: "调研中",
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
};
/** Read only the authoritative per-event ledger, never cumulative session snapshots. */
export function projectCustomerAiUsage(
  rows: readonly UsageRow[],
): CustomerAiTaskUsage[] {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows)
    groups.set(row.runId, [...(groups.get(row.runId) ?? []), row]);
  return [...groups]
    .map(([runId, entries]): CustomerAiTaskUsage => {
      const latest = [...entries].sort(
        (a, b) => time(b.lastActivityAt) - time(a.lastActivityAt),
      )[0]!;
      const phase = entries
        .filter((row) => row.phase)
        .sort(
          (a, b) => time(b.lastActivityAt) - time(a.lastActivityAt),
        )[0]?.phase;
      const phaseLabel =
        phase && Object.hasOwn(businessExecutionLabels, phase)
          ? businessExecutionLabels[phase as BusinessExecutionPhase]
          : undefined;
      const sum = (key: keyof UsageRow) =>
        entries.reduce((total, row) => total + number(row[key]), 0n).toString();
      const called = entries.some((row) => Boolean(Number(row.called)));
      const events = entries.reduce(
        (total, row) => total + Number(row.eventCount ?? 0),
        0,
      );
      const unknown = entries.some((row) => Number(row.unknownEvents ?? 0) > 0);
      return {
        runId,
        businessName: latest.businessName,
        status: stateLabels[latest.status] ?? "等待确认",
        startedAt: Math.min(...entries.map((row) => time(row.startedAt))),
        lastActivityAt: time(latest.lastActivityAt),
        phase:
          phaseLabel ??
          (!called
            ? "上传或准备资料"
            : (stateLabels[latest.status] ?? "等待确认")),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        cacheTokens: sum("cacheTokens"),
        chargedTenThousandths: sum("chargedTenThousandths"),
        usageStatus:
          !called && !events
            ? "none"
            : !events
              ? "syncing"
              : unknown
                ? "partial"
                : "synced",
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
  // Filtering both the task catalog and ledger prevents cross-project attribution.
  // The ledger's unique (session_id, provider_event_id) key owns event deduplication.
  const [taskRows] =
    await db.execute(sql`SELECT COALESCE(ct.buildId,t.id) AS runId,
    CASE WHEN ct.buildId IS NOT NULL THEN '知识库'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.generalPurpose.purpose'))='enterprise_qa' THEN '企业问答'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.generalPurpose.purpose'))='content_production' THEN '内容生产'
      WHEN o.operation_type LIKE '%siteops%' THEN '官网制作'
      WHEN o.operation_type LIKE '%question%' THEN '问题优化'
      ELSE '智能体任务' END AS businessName,
    o.status,t.created_at AS startedAt,t.updated_at AS lastActivityAt,
    (t.provider_task_id IS NOT NULL) AS called,
    COALESCE(e.inputTokens,0) AS inputTokens,COALESCE(e.outputTokens,0) AS outputTokens,
    COALESCE(e.cacheTokens,0) AS cacheTokens,COALESCE(e.chargedTenThousandths,0) AS chargedTenThousandths,
    COALESCE(e.eventCount,0) AS eventCount,COALESCE(e.unknownEvents,0) AS unknownEvents
    FROM agent_tasks t JOIN agent_operations o ON o.id=t.operation_id
    LEFT JOIN conversation_turns ct ON ct.id=JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId'))
      AND ct.userId=${scope.ownerUserId} AND ct.enterpriseProjectId=${scope.enterpriseProjectId}
    LEFT JOIN (SELECT local_task_id,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
      SUM(COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0)) AS cacheTokens,
      SUM(charged_ten_thousandths) AS chargedTenThousandths,COUNT(*) AS eventCount,
      SUM(input_tokens IS NULL OR output_tokens IS NULL) AS unknownEvents
      FROM ai_cost_events WHERE account_user_id=${scope.ownerUserId} AND enterprise_project_id=${scope.enterpriseProjectId}
      AND scope='managed_user' GROUP BY local_task_id) e ON e.local_task_id=t.id
    WHERE o.scope='managed_user' AND o.account_user_id=${scope.ownerUserId} AND o.enterpriseProjectId=${scope.enterpriseProjectId}`);
  // A durable upload/build must remain visible before any model transport exists.
  const [buildRows] =
    await db.execute(sql`SELECT b.id AS runId,'知识库' AS businessName,b.status,
    b.createdAt AS startedAt,b.updatedAt AS lastActivityAt,
    CASE WHEN b.status='published' OR b.contentCompletedAt IS NOT NULL THEN 'published'
      WHEN JSON_EXTRACT(ct.metadata,'$.awaitingClientAttachments')=true THEN 'uploading'
      ELSE (SELECT JSON_UNQUOTE(JSON_EXTRACT(a.normalized_payload,'$.businessPhase')) FROM agent_events a
        WHERE a.task_id=b.id AND JSON_EXTRACT(a.normalized_payload,'$.knowledgeGeneration')=b.generation
        AND JSON_UNQUOTE(JSON_EXTRACT(a.normalized_payload,'$.kind'))='business_event'
        ORDER BY a.provider_timestamp_ms DESC,a.id DESC LIMIT 1) END AS phase,
    EXISTS(SELECT 1 FROM conversation_turns ct WHERE ct.buildId=b.id AND ct.buildGeneration=b.generation AND ct.upstreamTaskId IS NOT NULL) AS called
    FROM knowledge_base_builds b LEFT JOIN conversation_turns ct ON ct.id=b.activeTurnId AND ct.buildId=b.id AND ct.buildGeneration=b.generation WHERE b.userId=${scope.ownerUserId} AND b.enterpriseProjectId=${scope.enterpriseProjectId}`);
  const tasks = projectCustomerAiUsage([
    ...(taskRows as unknown as UsageRow[]),
    ...(buildRows as unknown as UsageRow[]),
  ]);
  return {
    tasks: tasks.slice((input.page - 1) * 20, input.page * 20),
    total: tasks.length,
    page: input.page,
    pageSize: 20,
  };
}
