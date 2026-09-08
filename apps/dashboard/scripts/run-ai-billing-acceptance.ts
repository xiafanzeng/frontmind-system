/** Private, explicitly invoked paid acceptance. Uses the production adapter, durable intents and wallet ledger.
 * FRONTMIND_AI_BILLING_ACCEPTANCE=1 tsx scripts/run-ai-billing-acceptance.ts ACCOUNT_ID RUN_ID [PROJECT_ID]
 * Reuse RUN_ID after a crash: acknowledged/unknown commands are never submitted a second time.
 */
import { createHash } from "node:crypto";
import { getActivePresalesCredential } from "../server/presales-service";
import {
  acquirePresalesV2Task,
  updatePresalesV2Task,
  type PresalesV2TaskRecord,
} from "../server/presales-v2-store";
import {
  ensureWebsiteAgentOperation,
  persistWebsiteAgentTaskState,
  bindWebsiteProjectBusinessOwner,
} from "../server/agent-operation-service";
import {
  PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS,
  presalesV2CanonicalContractHash,
} from "../server/presales-v2-contracts";
import { ZhipuWebsiteAgentProvider } from "../server/providers/website-agent-provider";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { getEffectiveDecryptedCredentialForAccount } from "../server/auth-service";
import { createDashboardAgentClient } from "../server/providers/dashboard-agent-provider";
import { dashboardAgentRuntimeStore } from "../server/providers/dashboard-agent-runtime-store";
import { assertAiAccountFunds } from "../server/ai-billing-service";
import {
  formatCostCny,
  nativeTokens,
  zhipuCostNanos,
} from "../server/zhipu-cost";
import { providerKeyIdMask } from "../server/ai-usage-report";

const MAX_TOTAL_NANOS = 3000000000n;
const STOP_TASK_NANOS = 500000000n;
const MAX_TASK_MS = 120000;
const prompts = [
  [
    "low",
    "请只用一句不超过20个汉字的话介绍你是谁。不要使用工具，不要生成文件。",
  ],
  ["high", "请仅回答7加5的结果，不要解释，不要使用工具或生成文件。"],
  ["max", "请将英文hello翻译成中文，只输出译文，不要使用工具或生成文件。"],
] as const;

export async function runAiBillingAcceptance(
  accountId: number,
  runId: string,
  projectId: string | null,
) {
  if (process.env.FRONTMIND_AI_BILLING_ACCEPTANCE !== "1")
    throw new Error("PAID_ACCEPTANCE_NOT_ENABLED");
  if (
    !Number.isSafeInteger(accountId) ||
    accountId < 1 ||
    !/^[a-zA-Z0-9_-]{8,64}$/.test(runId)
  )
    throw new Error("INVALID_ACCEPTANCE_ARGUMENTS");
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const credential = await getEffectiveDecryptedCredentialForAccount(accountId);
  if (!credential || credential.provider !== "zhipu")
    throw new Error("ZHIPU_CREDENTIAL_REQUIRED");
  const identity = {
    provider: "zhipu" as const,
    accountUserId: accountId,
    credentialOwnerUserId: credential.userId,
    credentialId: credential.id,
    credentialVersion: credential.version,
    enterpriseProjectId: projectId,
  };
  // A run keeps its original billing identity even if a Key or account changes after interruption.
  const [priorIdentities] =
    await db.execute(sql`SELECT o.account_user_id AS accountId,
    o.api_credential_id AS credentialId,o.credential_version AS credentialVersion,
    o.enterprise_project_id AS projectId FROM agent_tasks t
    JOIN agent_operations o ON o.id=t.operation_id
    WHERE o.scope='managed_user' AND JSON_UNQUOTE(JSON_EXTRACT(t.provider_runtime,'$.dashboardManaged.intentId')) IN (${sql.join(
      prompts.map(
        ([effort]) => sql`${`billing-acceptance:${runId}:${effort}`}`,
      ),
      sql`,`,
    )})`);
  if (
    (priorIdentities as unknown as Array<Record<string, unknown>>).some(
      (row) =>
        Number(row.accountId) !== accountId ||
        row.credentialId !== credential.id ||
        Number(row.credentialVersion) !== credential.version ||
        (row.projectId ?? null) !== projectId,
    )
  )
    throw new Error("ACCEPTANCE_BILLING_IDENTITY_CHANGED");
  const records: Record<string, unknown>[] = [];
  const websiteCredential = await getActivePresalesCredential();
  if (!websiteCredential) throw new Error("WEBSITE_CREDENTIAL_REQUIRED");
  const sampleHash = createHash("sha256").update("你好").digest("hex");
  const websitePrompt = `将中文“你好”译成英文。仅返回 JSON：schemaVersion 为 1，sourceQuestionSha256 为 ${sampleHash}，questionEnglish 为译文。不要解释，不要调用工具或生成文件。`;
  const acquired = await acquirePresalesV2Task({
    idempotencyKey: `billing-acceptance:${runId}:website`,
    requestHash: createHash("sha256").update(websitePrompt).digest("hex"),
    projectId: `billing-check-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`,
    contract: {
      name: "website.monitor-question-translation",
      revision: 2,
      schemaHash: presalesV2CanonicalContractHash(
        "website.monitor-question-translation",
      ),
    },
    profile: "frontmind-base",
    upstreamModel: "glm-5.3",
    provider: "zhipu",
    credentialId: websiteCredential.id,
    credentialVersion: websiteCredential.version,
  });
  if (acquired.state === "conflict")
    throw new Error("WEBSITE_ACCEPTANCE_CONFLICT");
  if (
    acquired.record.credentialId !== websiteCredential.id ||
    acquired.record.credentialVersion !== websiteCredential.version
  )
    throw new Error("WEBSITE_ACCEPTANCE_CREDENTIAL_CHANGED");
  await ensureWebsiteAgentOperation(acquired.record);
  await bindWebsiteProjectBusinessOwner({
    projectId: acquired.record.projectId!,
    businessOwnerName: "费用核对测试",
  });
  const taskIds: string[] = [acquired.record.localTaskId];
  const costRows = async () => {
    if (!taskIds.length) return [];
    const [rows] =
      await db.execute(sql`SELECT local_task_id AS taskId,session_id AS sessionId,provider_event_id AS eventId,
      input_tokens AS inputTokens,output_tokens AS outputTokens,cache_read_input_tokens AS cacheReadInputTokens,
      CAST(cost_nanos AS CHAR) AS costNanos,charged_ten_thousandths AS chargedUnits,pricing_version AS pricingVersion,occurred_at AS occurredAt,cost_state AS costState
      FROM ai_cost_events WHERE local_task_id IN (${sql.join(
        taskIds.map((id) => sql`${id}`),
        sql`,`,
      )}) ORDER BY occurred_at,id`);
    return rows as unknown as Array<Record<string, any>>;
  };
  const total = async () =>
    (await costRows()).reduce(
      (sum, row) => sum + BigInt(row.costNanos ?? 0),
      0n,
    );
  for (const [effort] of prompts) {
    const intentId = `billing-acceptance:${runId}:${effort}`;
    const prior = await dashboardAgentRuntimeStore.findByIntent(
      identity,
      intentId,
    );
    if (prior) taskIds.push(prior.localTaskId);
    // Prior trials from the same run are included even when resuming; this is not an allowance reset.
  }
  for (const [effort, prompt] of prompts) {
    if ((await total()) >= MAX_TOTAL_NANOS)
      throw new Error("ACCEPTANCE_TOTAL_BUDGET_REACHED");
    await assertAiAccountFunds(accountId);
    const intentId = `billing-acceptance:${runId}:${effort}`;
    const client = createDashboardAgentClient({
      ...identity,
      apiKey: credential.apiKey,
      model: "glm-5.3",
      effort,
      intentId,
      generalIdentity: true,
      tools: [],
      timeoutMs: 30000,
      systemContext:
        "This is a brief billing reconciliation sample. Answer in at most 20 Chinese characters. Do not perform tool, network, file or research work.",
    });
    const created = await client.createTask({
      title: `费用核对 ${runId} ${effort}`,
      prompt,
    });
    const record = await dashboardAgentRuntimeStore.findByIntent(
      identity,
      intentId,
    );
    if (!record?.runtime.sessionId)
      throw new Error("ACCEPTANCE_SESSION_NOT_ACKNOWLEDGED");
    if (!taskIds.includes(record.localTaskId)) taskIds.push(record.localTaskId);
    const sessionId = record.runtime.sessionId;
    const started = Date.now();
    let stopRequested = false;
    let settled = false;
    let session: Record<string, any> = {};
    do {
      // This read invokes the same event observer and wallet settlement used by normal conversations.
      await client.listAllMessages({ taskId: sessionId, order: "asc" });
      session = await client.api.request("GET", `/v1/sessions/${sessionId}`);
      const ownCost = (await costRows())
        .filter((row) => row.taskId === record.localTaskId)
        .reduce((sum, row) => sum + BigInt(row.costNanos ?? 0), 0n);
      const hasReply =
        ownCost > 0n ||
        (await costRows()).some((row) => row.taskId === record.localTaskId);
      settled =
        hasReply && ["idle", "terminated"].includes(String(session.status));
      if (
        !settled &&
        (ownCost >= STOP_TASK_NANOS ||
          (await total()) >= MAX_TOTAL_NANOS ||
          Date.now() - started > MAX_TASK_MS)
      ) {
        if (!stopRequested) {
          await client.stopTask(sessionId);
          stopRequested = true;
        }
        if (Date.now() - started > MAX_TASK_MS + 30000)
          throw new Error(`ACCEPTANCE_STOP_PENDING:${sessionId}`);
      }
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (!settled);
    await client.listAllMessages({ taskId: sessionId, order: "asc" });
    const ownRows = (await costRows()).filter(
      (row) => row.taskId === record.localTaskId,
    );
    const native = nativeTokens(session.usage);
    const nativeCost = zhipuCostNanos("glm-5.3", native);
    const recordedCost = ownRows.reduce(
      (sum, row) => sum + BigInt(row.costNanos ?? 0),
      0n,
    );
    const countersEqual =
      native !== null &&
      [
        ["inputTokens", "inputTokens"],
        ["outputTokens", "outputTokens"],
        ["cacheReadInputTokens", "cacheReadInputTokens"],
      ].every(
        ([field, nativeField]) =>
          ownRows.reduce((sum, row) => sum + BigInt(row[field!] ?? 0), 0n) ===
          native[nativeField! as keyof typeof native],
      );
    if (!countersEqual || nativeCost !== recordedCost)
      throw new Error(`ACCEPTANCE_NATIVE_EVENT_MISMATCH:${sessionId}`);
    records.push({
      scope: "managed_user",
      effort,
      localTaskId: record.localTaskId,
      operationId: record.operationId,
      sessionId,
      requestId: created.requestId,
      model: "glm-5.3",
      credentialVersion: credential.version,
      fingerprint: credential.fingerprint,
      providerKeyId: providerKeyIdMask(credential.apiKey),
      nativeUsage: session.usage,
      standardCostCny: formatCostCny(recordedCost),
      stoppedForBudget: stopRequested,
      events: ownRows,
      providerBillStatus: "awaiting_manual_settled_bill_comparison",
    });
    console.log(
      JSON.stringify({
        effort,
        sessionId,
        costCny: formatCostCny(recordedCost),
        events: ownRows.length,
      }),
    );
    if (stopRequested) break;
  }
  if (records.length === 3 && (await total()) < MAX_TOTAL_NANOS) {
    const update = async (
      id: string,
      mutate: (record: PresalesV2TaskRecord) => PresalesV2TaskRecord,
    ) => {
      const next = await updatePresalesV2Task(id, mutate);
      if (next) await persistWebsiteAgentTaskState(next);
      return next;
    };
    // This fixture runs the original Website translation contract in a separate test project.
    const client = new ZhipuWebsiteAgentProvider(
      acquired.record,
      update,
      websiteCredential.apiKey,
      undefined,
      { tools: [] },
    );
    const created = await client.createTask({
      title: `费用核对 ${runId} Website`,
      prompt: websitePrompt,
      structuredOutputSchema:
        PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
          "website.monitor-question-translation"
        ],
    });
    const sessionId = created.taskId;
    await update(acquired.record.localTaskId, (record) => ({
      ...record,
      providerTaskId: sessionId,
      providerRequestId: created.requestId,
      status: ["succeeded", "failed", "cancelled"].includes(record.status)
        ? record.status
        : "running",
    }));
    let session: Record<string, any> = {};
    const started = Date.now();
    let stopped = false;
    for (;;) {
      await client.listAllMessages({ taskId: sessionId, order: "asc" });
      session = await client.api.request("GET", `/v1/sessions/${sessionId}`);
      const ownRows = (await costRows()).filter(
        (row) => row.taskId === acquired.record.localTaskId,
      );
      const ownCost = ownRows.reduce(
        (sum, row) => sum + BigInt(row.costNanos ?? 0),
        0n,
      );
      if (
        ownRows.length &&
        ["idle", "terminated"].includes(String(session.status))
      )
        break;
      if (
        ownCost >= STOP_TASK_NANOS ||
        (await total()) >= MAX_TOTAL_NANOS ||
        Date.now() - started > MAX_TASK_MS
      ) {
        if (!stopped) {
          await client.api.request("POST", `/v1/sessions/${sessionId}/events`, {
            events: [{ type: "user.interrupt" }],
          });
          stopped = true;
        }
        if (Date.now() - started > MAX_TASK_MS + 30000)
          throw new Error(`WEBSITE_ACCEPTANCE_STOP_PENDING:${sessionId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await client.listAllMessages({ taskId: sessionId, order: "asc" });
    const ownRows = (await costRows()).filter(
      (row) => row.taskId === acquired.record.localTaskId,
    );
    const native = nativeTokens(session.usage);
    const nativeCost = zhipuCostNanos("glm-5.3", native);
    const countersEqual =
      native !== null &&
      (["inputTokens", "outputTokens", "cacheReadInputTokens"] as const).every(
        (field) =>
          ownRows.reduce((sum, row) => sum + BigInt(row[field] ?? 0), 0n) ===
          native[field],
      );
    const recordedCost = ownRows.reduce(
      (sum, row) => sum + BigInt(row.costNanos ?? 0),
      0n,
    );
    if (
      !countersEqual ||
      nativeCost !== recordedCost ||
      ownRows.some((row) => BigInt(row.chargedUnits ?? 0) !== 0n)
    )
      throw new Error("WEBSITE_PLATFORM_COST_MISMATCH");
    await update(acquired.record.localTaskId, (record) => ({
      ...record,
      status:
        stopped || record.status === "cancelled" ? "cancelled" : "succeeded",
      terminalAt: record.terminalAt ?? new Date().toISOString(),
    }));
    records.push({
      scope: "website_frontend",
      effort: acquired.record.providerRuntime?.effort ?? "max",
      localTaskId: acquired.record.localTaskId,
      operationId: acquired.record.operationId,
      sessionId,
      model: "glm-5.3",
      credentialVersion: websiteCredential.version,
      fingerprint: websiteCredential.fingerprint,
      providerKeyId: providerKeyIdMask(websiteCredential.apiKey),
      nativeUsage: session.usage,
      standardCostCny: formatCostCny(recordedCost),
      stoppedForBudget: stopped,
      events: ownRows,
      providerBillStatus: "awaiting_manual_settled_bill_comparison",
    });
    console.log(
      JSON.stringify({
        scope: "website_frontend",
        sessionId,
        costCny: formatCostCny(recordedCost),
        events: ownRows.length,
      }),
    );
  }
  const result = {
    runId,
    budgetCny: "3.000000",
    totalCostCny: formatCostCny(await total()),
    records,
  };
  const output = `/tmp/frontmind-billing-acceptance-${runId}.json`;
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  return { output, ...result };
}

if (process.env.FRONTMIND_AI_BILLING_ACCEPTANCE === "1") {
  runAiBillingAcceptance(
    Number(process.argv[2]),
    process.argv[3] ?? "",
    process.argv[4] ?? null,
  )
    .then((result) => {
      console.log(
        JSON.stringify({
          output: result.output,
          totalCostCny: result.totalCostCny,
          completed: result.records.length,
        }),
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? error.message : "ACCEPTANCE_FAILED",
      );
      process.exit(1);
    });
}
