import { randomUUID } from "node:crypto";

import {
  RESPONSE_LOGIC_STRUCTURED_OUTPUT_SCHEMA,
  responseLogicStructuredDraftFromV2Events,
} from "../server/response-logic-api";
import { ManusV2Client } from "../server/manus-v2-client";
import { toUpstreamAgentProfile } from "../server/upstream-config";
import { RESPONSE_LOGIC_MODEL_SECTIONS } from "../shared/response-logic";

const apiKey = process.env.FRONTMIND_PRO_SMOKE_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "FRONTMIND_PRO_SMOKE_KEY is required; provide it only for the current process.",
  );
}

const baseUrl = (
  process.env.FRONTMIND_UPSTREAM_BASE_URL || "https://api.manus.ai"
).replace(/\/$/, "");
const timeoutMs = Number(process.env.FRONTMIND_PRO_SMOKE_TIMEOUT_MS || 600_000);
const pollIntervalMs = Number(
  process.env.FRONTMIND_PRO_SMOKE_POLL_INTERVAL_MS || 4_000,
);

if (
  !Number.isFinite(timeoutMs) ||
  timeoutMs < 10_000 ||
  !Number.isFinite(pollIntervalMs) ||
  pollIntervalMs < 1_000
) {
  throw new Error("Smoke-test timeout settings are invalid.");
}

const operationMarker = `frontmind-response-logic-smoke:${randomUUID()}`;
const prompt = [
  `不可改写的验收标记：${operationMarker}`,
  "这是 FrontMind Pro 应答逻辑生产契约的连通性测试。",
  "不要调用外部工具，不要检索真实企业，不要输出内部思考。",
  "请围绕‘企业如何说明知识库服务能力’生成一份仅用于接口验收的结构化草稿。",
  "严格按 structured output schema 返回四个非空字段，不得添加其他字段。",
  ...RESPONSE_LOGIC_MODEL_SECTIONS.map(
    (section) =>
      `${section.heading}：填写一条简短、明确且不声称真实商业事实的内容。`,
  ),
].join("\n");

const client = new ManusV2Client({
  baseUrl,
  apiKey,
  rateLimitScope: "managed-response-logic-smoke",
});
const startedAt = Date.now();
let taskId = "";
let cleanupStatus = "not-created";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const created = await client.createTask({
    prompt,
    title: operationMarker,
    agentProfile: toUpstreamAgentProfile("frontmind-pro"),
    locale: "zh-CN",
    interactiveMode: false,
    structuredOutputSchema: RESPONSE_LOGIC_STRUCTURED_OUTPUT_SCHEMA,
  });
  taskId = created.taskId;
  cleanupStatus = "pending";

  let structuredDraft: ReturnType<
    typeof responseLogicStructuredDraftFromV2Events
  > = null;
  let terminalObservedAt: number | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const [detail, events] = await Promise.all([
      client.taskDetail(taskId),
      client.listAllMessages({ taskId, order: "desc" }),
    ]);
    structuredDraft = responseLogicStructuredDraftFromV2Events(events);
    if (structuredDraft) break;

    const status = String(detail.status ?? "").toLowerCase();
    if (["failed", "error", "cancelled"].includes(status)) {
      throw new Error(`Pro v2 task finished with status ${status}.`);
    }
    if (["stopped", "completed", "succeeded"].includes(status)) {
      terminalObservedAt ??= Date.now();
      // v2 attachments/results can trail the terminal state briefly.
      if (Date.now() - terminalObservedAt >= 120_000) break;
    }
    await sleep(pollIntervalMs);
  }

  if (!structuredDraft) {
    throw new Error(
      "Pro v2 task did not return an accepted structured result before timeout.",
    );
  }

  const sectionLengths = Object.fromEntries(
    Object.entries(structuredDraft).map(([key, value]) => [key, value.length]),
  );
  if (!Object.values(sectionLengths).every((length) => length > 0)) {
    throw new Error("The Pro v2 structured result contains an empty section.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        contract: "response-logic-v2",
        model: "frontmind-pro",
        upstreamProfile: toUpstreamAgentProfile("frontmind-pro"),
        elapsedMs: Date.now() - startedAt,
        sectionCount: Object.keys(sectionLengths).length,
        sectionLengths,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (taskId) cleanupStatus = "retained-as-usage-proof";
  process.stdout.write(
    `${JSON.stringify({ cleanupStatus, secretPersisted: false })}\n`,
  );
}
