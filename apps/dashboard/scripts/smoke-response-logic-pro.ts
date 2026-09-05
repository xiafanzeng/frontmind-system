import {
  normalizeResponseLogicTaskStatus,
  parseCompletedResponseLogicTask,
} from "../server/response-logic-api";
import { RESPONSE_LOGIC_MODEL_SECTIONS } from "../shared/response-logic";
import { toUpstreamAgentProfile } from "../server/upstream-config";

const apiKey = process.env.FRONTMIND_PRO_SMOKE_KEY?.trim();
if (!apiKey) {
  throw new Error(
    "FRONTMIND_PRO_SMOKE_KEY is required; provide it only for the current process.",
  );
}

const baseUrl = (
  process.env.FRONTMIND_UPSTREAM_BASE_URL || "https://api.manus.im"
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

const prompt = [
  "这是 FrontMind Pro 应答逻辑生产契约的连通性测试。",
  "不要调用外部工具，不要检索真实企业，不要输出内部思考。",
  "请围绕“企业如何说明知识库服务能力”生成一份仅用于接口验收的结构化草稿。",
  "只返回以下七个 Markdown 二级标题，标题、顺序必须完全一致，每栏必须非空；不得添加前言、结语、代码围栏或其他标题。",
  ...RESPONSE_LOGIC_MODEL_SECTIONS.map(
    (section) =>
      `## ${section.heading}\n请填写一条简短、明确、仅用于接口验收且不声称真实商业事实的内容。`,
  ),
].join("\n\n");

const headers = {
  "Content-Type": "application/json",
  API_KEY: apiKey,
  Authorization: `Bearer ${apiKey}`,
};
const startedAt = Date.now();
let taskId = "";
let cleanupStatus = "not-created";
let visibilityRetryCount = 0;

function taskRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const nested = record.task;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : record;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const createResponse = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      agentProfile: toUpstreamAgentProfile("frontmind-pro"),
      taskMode: "agent",
      attachments: [],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const createBody = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) {
    throw new Error(`Pro task creation failed (${createResponse.status}).`);
  }
  const createdTask = taskRecord(createBody);
  taskId = String(createdTask.id || createdTask.task_id || "").trim();
  if (!taskId) {
    throw new Error("Pro task creation returned no task ID.");
  }
  cleanupStatus = "pending";

  let completedTask: Record<string, unknown> | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetch(
      `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers,
        signal: AbortSignal.timeout(120_000),
      },
    );
    const statusBody = await statusResponse.json().catch(() => ({}));
    if (
      statusResponse.status === 404 &&
      Date.now() - startedAt < Math.min(timeoutMs, 90_000)
    ) {
      visibilityRetryCount += 1;
      await sleep(pollIntervalMs);
      continue;
    }
    if (!statusResponse.ok) {
      throw new Error(`Pro task polling failed (${statusResponse.status}).`);
    }
    const task = taskRecord(statusBody);
    const returnedId = String(task.id || task.task_id || "").trim();
    if (returnedId !== taskId) {
      throw new Error("Pro task polling returned a mismatched task ID.");
    }
    const normalizedStatus = normalizeResponseLogicTaskStatus(task.status);
    if (normalizedStatus === "completed") {
      completedTask = task;
      break;
    }
    if (normalizedStatus === "failed") {
      throw new Error("Pro task finished with a failed status.");
    }
    if (normalizedStatus === "unknown") {
      throw new Error("Pro task returned an unknown status.");
    }
    await sleep(pollIntervalMs);
  }

  if (!completedTask) {
    throw new Error("Pro task did not complete before the smoke-test timeout.");
  }

  const structuredDraft = parseCompletedResponseLogicTask(completedTask);
  const sectionLengths = Object.fromEntries(
    Object.entries(structuredDraft).map(([key, value]) => [key, value.length]),
  );
  const allSectionsNonEmpty = Object.values(sectionLengths).every(
    (length) => length > 0,
  );
  if (!allSectionsNonEmpty) {
    throw new Error("The parsed Pro response contains an empty section.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: "frontmind-pro",
        upstreamProfile: toUpstreamAgentProfile("frontmind-pro"),
        status: "completed",
        elapsedMs: Date.now() - startedAt,
        visibilityRetryCount,
        sectionCount: Object.keys(sectionLengths).length,
        sectionLengths,
        allSectionsNonEmpty,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (taskId) {
    cleanupStatus = "retained-as-usage-proof";
  }
  process.stdout.write(
    `${JSON.stringify({ cleanupStatus, secretPersisted: false })}\n`,
  );
}
