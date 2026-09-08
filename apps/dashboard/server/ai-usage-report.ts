import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { decryptCredentialSecret } from "./auth-service";
import {
  aiUsageReportWindow,
  type AiUsageReportInput,
} from "../shared/ai-usage-report";
import {
  formatCostCny,
  ZHIPU_PRICING_SOURCE,
  ZHIPU_PRICING_VERSION,
} from "./zhipu-cost";

const PAGE_SIZE = 20;
const EXPORT_LIMIT = 50000;
const joins = sql`FROM ai_cost_events e
  JOIN agent_operations o ON o.id=e.operation_id
  JOIN agent_tasks t ON t.id=e.local_task_id
  LEFT JOIN api_credentials a ON o.scope='managed_user' AND a.id=o.api_credential_id
  LEFT JOIN presales_api_credentials p ON o.scope='website_frontend' AND p.id=o.api_credential_id
  LEFT JOIN website_project_attributions w ON w.project_id=o.presales_project_id
  LEFT JOIN users u ON u.id=o.account_user_id
  LEFT JOIN ai_usage_sync_targets sync ON sync.local_task_id=t.id`;
const fingerprint = sql`COALESCE(a.fingerprint,p.fingerprint)`;
function where(input: AiUsageReportInput, onlyWindow = false) {
  const window = aiUsageReportWindow(input);
  const conditions: SQL[] = [
    sql`e.occurred_at >= ${new Date(window.startAt)}`,
    sql`e.occurred_at < ${new Date(window.endAt)}`,
  ];
  if (!onlyWindow) {
    if (input.scope !== "all") conditions.push(sql`e.scope=${input.scope}`);
    if (input.fingerprint)
      conditions.push(sql`${fingerprint}=${input.fingerprint}`);
    if (input.model) conditions.push(sql`e.model=${input.model}`);
  }
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}
async function database() {
  const db = await getDb();
  if (!db) throw new Error("AI_BILLING_DATABASE_UNAVAILABLE");
  return db;
}
async function query(db: any, statement: SQL): Promise<any[]> {
  const [rows] = await db.execute(statement);
  return rows;
}
const count = (value: unknown) => String(value ?? "0");
const timestamp = (value: unknown): number | null => {
  if (!value) return null;
  const result =
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(result) ? result : null;
};
export function usageMoney(row: {
  knownEvents?: unknown;
  costNanos?: unknown;
  unknownEvents?: unknown;
  chargedUnits?: unknown;
}) {
  const known = Number(row.knownEvents ?? 0);
  return {
    costCny: known ? formatCostCny(BigInt(String(row.costNanos ?? 0))) : null,
    chargedCny: formatCostCny(BigInt(String(row.chargedUnits ?? 0)) * 100000n),
    costStatus: known ? ("partial" as const) : ("unknown" as const),
    unknownEvents: Number(row.unknownEvents ?? 0),
  };
}

/** Only a provider Key identifier's mask is returned, never the API secret. */
export function providerKeyIdMask(secret: string): string | null {
  const parts = secret.trim().split(".");
  return parts.length === 2 && /^[a-zA-Z0-9_-]{8,128}$/.test(parts[0]!)
    ? `${parts[0]!.slice(0, 4)}...${parts[0]!.slice(-4)}`
    : null;
}
async function keyOptions(db: any, input: AiUsageReportInput) {
  const used = await query(
    db,
    sql`SELECT DISTINCT o.scope,o.api_credential_id AS credentialId,o.credential_version AS version,${fingerprint} AS fingerprint,e.model
    ${joins} ${where(input, true)} LIMIT 500`,
  );
  const credentials = new Map<string, any>();
  const scopes = ["website_frontend", "managed_user"] as const;
  await Promise.all(
    scopes.map(async (scope) => {
      const ids = [
        ...new Set(
          used
            .filter((row) => row.scope === scope)
            .map((row) => String(row.credentialId)),
        ),
      ];
      if (!ids.length) return;
      const idList = sql.join(
        ids.map((id) => sql`${id}`),
        sql`,`,
      );
      const rows = await query(
        db,
        scope === "website_frontend"
          ? sql`SELECT id,NULL AS userId,status,encryptionVersion,encryptedKey,encryptionIv,encryptionAuthTag FROM presales_api_credentials WHERE id IN (${idList})`
          : sql`SELECT id,userId,status,encryptionVersion,encryptedKey,encryptionIv,encryptionAuthTag FROM api_credentials WHERE id IN (${idList})`,
      );
      for (const row of rows) credentials.set(`${scope}:${row.id}`, row);
    }),
  );
  const result = new Map<
    string,
    { fingerprint: string; providerKeyId: string | null; versions: string[] }
  >();
  for (const row of used) {
    if (!row.fingerprint) continue;
    const value = result.get(row.fingerprint) ?? {
      fingerprint: row.fingerprint,
      providerKeyId: null,
      versions: [] as string[],
    };
    value.versions.push(
      `${row.scope === "website_frontend" ? "官网" : "后台"} v${row.version}`,
    );
    const credential = credentials.get(`${row.scope}:${row.credentialId}`);
    if (!value.providerKeyId && credential && credential.status !== "deleted") {
      try {
        const aad =
          row.scope === "website_frontend"
            ? `frontmind-presales-api-credential:v1:website:${credential.id}`
            : `frontmind-api-credential:v1:${credential.userId}:${credential.id}`;
        value.providerKeyId = providerKeyIdMask(
          decryptCredentialSecret(aad, credential),
        );
      } catch {
        /* Unreadable retired credentials retain their frozen fingerprint. */
      }
    }
    result.set(row.fingerprint, value);
  }
  return {
    keys: [...result.values()].map((value) => ({
      ...value,
      versions: [...new Set(value.versions)],
    })),
    models: [...new Set(used.map((row) => String(row.model)))].sort(),
  };
}

export async function readAiUsageReport(
  input: AiUsageReportInput,
  executor?: any,
): Promise<Awaited<ReturnType<typeof readAiUsageReportSnapshot>>> {
  const db = executor ?? (await database());
  return executor
    ? readAiUsageReportSnapshot(input, db)
    : db.transaction((tx: any) => readAiUsageReportSnapshot(input, tx));
}
async function readAiUsageReportSnapshot(input: AiUsageReportInput, db: any) {
  const filter = where(input);
  const [totals, tasks, options] = await Promise.all([
    query(
      db,
      sql`SELECT COUNT(*) AS observedEvents,COUNT(DISTINCT e.local_task_id) AS observedTasks,
      SUM(e.cost_nanos IS NOT NULL) AS knownEvents,SUM(e.cost_nanos IS NULL) AS unknownEvents,
      CAST(SUM(e.input_tokens) AS CHAR) AS inputTokens,CAST(SUM(e.output_tokens) AS CHAR) AS outputTokens,
      CAST(SUM(e.cache_read_input_tokens) AS CHAR) AS cacheReadInputTokens,
      CAST(SUM(e.cost_nanos) AS CHAR) AS costNanos,CAST(SUM(e.charged_ten_thousandths) AS CHAR) AS chargedUnits,
      MAX(e.created_at) AS lastRecordedAt ${joins} ${filter}`,
    ),
    query(
      db,
      sql`SELECT e.local_task_id AS id,e.session_id AS sessionId,e.scope,t.title,t.provider_state AS state,
      COALESCE(w.business_owner_name,u.displayName,u.username) AS businessOwnerName,
      o.api_credential_id AS credentialId,o.credential_version AS credentialVersion,${fingerprint} AS fingerprint,
      e.model,JSON_UNQUOTE(COALESCE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.effort'),JSON_EXTRACT(t.provider_runtime,'$.effort'))) AS effort,
      GROUP_CONCAT(DISTINCT e.pricing_version) AS pricingVersions,
      CAST(SUM(e.input_tokens) AS CHAR) AS inputTokens,CAST(SUM(e.output_tokens) AS CHAR) AS outputTokens,
      CAST(SUM(e.cache_read_input_tokens) AS CHAR) AS cacheReadInputTokens,
      COUNT(*) AS observedEvents,SUM(e.cost_nanos IS NOT NULL) AS knownEvents,SUM(e.cost_nanos IS NULL) AS unknownEvents,
      CAST(SUM(e.cost_nanos) AS CHAR) AS costNanos,CAST(SUM(e.charged_ten_thousandths) AS CHAR) AS chargedUnits,
      MIN(e.occurred_at) AS firstEventAt,MAX(e.occurred_at) AS lastEventAt,MAX(e.created_at) AS lastRecordedAt,
      sync.last_error AS syncIssue
      ${joins} ${filter}
      GROUP BY e.local_task_id,e.session_id,e.scope,t.title,t.provider_state,w.business_owner_name,u.displayName,u.username,
        o.api_credential_id,o.credential_version,a.fingerprint,p.fingerprint,e.model,t.provider_runtime,sync.last_error
      ORDER BY lastEventAt DESC,e.local_task_id DESC LIMIT ${PAGE_SIZE} OFFSET ${(input.page - 1) * PAGE_SIZE}`,
    ),
    keyOptions(db, input),
  ]);
  const total = totals[0] ?? {};
  return {
    timeZone: "Asia/Shanghai" as const,
    ...aiUsageReportWindow(input),
    page: input.page,
    pageSize: PAGE_SIZE,
    summary: {
      ...usageMoney(total),
      inputTokens: count(total.inputTokens),
      outputTokens: count(total.outputTokens),
      cacheReadInputTokens: count(total.cacheReadInputTokens),
      observedEvents: Number(total.observedEvents ?? 0),
      observedTasks: Number(total.observedTasks ?? 0),
      lastRecordedAt: timestamp(total.lastRecordedAt),
    },
    tasks: tasks.map((row) => ({
      id: String(row.id),
      sessionId: String(row.sessionId),
      scope: String(row.scope),
      title: String(row.title || "未命名任务"),
      state: String(row.state),
      businessOwnerName: row.businessOwnerName
        ? String(row.businessOwnerName)
        : null,
      credentialVersion: Number(row.credentialVersion),
      fingerprint: row.fingerprint ? String(row.fingerprint) : null,
      model: String(row.model),
      effort: row.effort ? String(row.effort) : null,
      pricingVersions: String(row.pricingVersions ?? ""),
      ...usageMoney(row),
      inputTokens: count(row.inputTokens),
      outputTokens: count(row.outputTokens),
      cacheReadInputTokens: count(row.cacheReadInputTokens),
      observedEvents: Number(row.observedEvents),
      firstEventAt: timestamp(row.firstEventAt),
      lastEventAt: timestamp(row.lastEventAt),
      lastRecordedAt: timestamp(row.lastRecordedAt),
      syncIssue: row.syncIssue ? String(row.syncIssue) : null,
    })),
    keys: options.keys,
    models: options.models,
    pricing: {
      version: ZHIPU_PRICING_VERSION,
      sourceUrl: ZHIPU_PRICING_SOURCE,
      model: "glm-5.3",
      inputPerMillion: 8,
      outputPerMillion: 28,
      cacheReadPerMillion: 2,
    },
  };
}

export function aiUsageCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export async function exportAiUsageReport(
  input: AiUsageReportInput,
  executor?: any,
) {
  const db = executor ?? (await database());
  const rows = await query(
    db,
    sql`SELECT e.occurred_at AS occurredAt,e.scope,
    COALESCE(w.business_owner_name,u.displayName,u.username) AS owner,t.title,e.local_task_id AS taskId,
    e.session_id AS sessionId,e.provider_event_id AS eventId,${fingerprint} AS fingerprint,o.credential_version AS credentialVersion,
    e.model,e.pricing_version AS pricingVersion,CAST(e.input_tokens AS CHAR) AS inputTokens,CAST(e.output_tokens AS CHAR) AS outputTokens,
    CAST(e.cache_read_input_tokens AS CHAR) AS cacheTokens,CAST(e.cost_nanos AS CHAR) AS costNanos,CAST(e.charged_ten_thousandths AS CHAR) AS chargedUnits,e.cost_state AS costState,e.is_error AS isError,
    JSON_UNQUOTE(COALESCE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.effort'),JSON_EXTRACT(t.provider_runtime,'$.effort'))) AS effort
    ${joins} ${where(input)} ORDER BY e.occurred_at,e.id LIMIT ${EXPORT_LIMIT + 1}`,
  );
  if (rows.length > EXPORT_LIMIT)
    throw new Error("明细超过 50,000 条，请缩小日期范围后导出");
  const options = await keyOptions(db, input);
  const providerIds = new Map(
    options.keys.map((key) => [key.fingerprint, key.providerKeyId]),
  );
  const headers = [
    "北京时间",
    "来源",
    "负责人",
    "任务",
    "任务ID",
    "Session ID",
    "Event ID",
    "Key指纹",
    "BigModel Key ID遮罩",
    "Key版本",
    "模型",
    "档位",
    "价格版本",
    "输入Token",
    "输出Token",
    "缓存Token",
    "标准成本CNY",
    "已扣钱包CNY",
    "成本状态",
    "失败请求",
  ];
  const lines = rows.map((row) =>
    [
      timestamp(row.occurredAt) === null
        ? ""
        : new Date(timestamp(row.occurredAt)! + 8 * 3600000)
            .toISOString()
            .replace("T", " ")
            .replace("Z", " +08:00"),
      row.scope,
      row.owner,
      row.title,
      row.taskId,
      row.sessionId,
      row.eventId,
      row.fingerprint,
      providerIds.get(row.fingerprint) ?? "",
      row.credentialVersion,
      row.model,
      row.effort,
      row.pricingVersion,
      count(row.inputTokens),
      count(row.outputTokens),
      count(row.cacheTokens),
      row.costNanos == null ? "待核算" : formatCostCny(BigInt(row.costNanos)),
      formatCostCny(BigInt(row.chargedUnits ?? 0) * 100000n),
      row.costState,
      row.isError ? "是" : "否",
    ]
      .map(aiUsageCsvCell)
      .join(","),
  );
  return {
    filename: `frontmind-ai-usage-${input.from}-${input.to}.csv`,
    csv:
      "\uFEFF" + [headers.map(aiUsageCsvCell).join(","), ...lines].join("\r\n"),
  };
}
