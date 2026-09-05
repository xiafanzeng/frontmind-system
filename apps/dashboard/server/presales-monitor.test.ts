import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";

import type {
  InsertPresalesMonitorRun,
  PresalesMonitorRun,
} from "../drizzle/schema";
import {
  buildMonitorSubmitPayload,
  buildMonitorRequestUrl,
  createPresalesMonitorRouter,
  assertDedicatedMonitorCredentialConfigured,
  isDedicatedMonitorCredentialConfigured,
  MONITOR_POLL_INTERVAL_MS,
  MONITOR_REPEAT_PER_PLATFORM,
  monitorBaseUrl,
  monitorCredentialFromEnv,
  PresalesMonitorError,
  PresalesMonitorService,
  sanitizeMonitorAnswerText,
  sanitizeMonitorErrorText,
  sanitizeMonitorMedia,
  type MonitorCreateInput,
  type MonitorPlatform,
  type MonitorPollLease,
  type MonitorRepository,
  type MonitorReservation,
  type MonitorTransport,
} from "./presales-monitor";
import type { DecryptedPresalesCredential } from "./presales-service";

const QUESTION = "FrontMind 的 GEO 服务适合科研企业吗？";
const TASK_ID = "monitor_task_123456";
const credential: DecryptedPresalesCredential = {
  id: "credential-1",
  version: 1,
  apiKey: "sk-offline-monitor-test",
  fingerprint: "fingerprint",
  status: "active",
  verifiedAt: new Date("2026-01-01T00:00:00Z"),
};

function upstreamPlatform(platform: MonitorPlatform) {
  return platform;
}

function submittedChildren(
  platforms: readonly MonitorPlatform[],
  count = MONITOR_REPEAT_PER_PLATFORM,
) {
  return platforms.flatMap((platform) =>
    Array.from({ length: count }, (_, index) => ({
      taskId: TASK_ID,
      subTaskId: `${platform}_subtask_${index + 1}_123456`,
      prompt: QUESTION,
      platform: upstreamPlatform(platform),
      mode: "search",
      status: "pending",
    })),
  );
}

function submitResponse(platforms: readonly MonitorPlatform[]) {
  const children = submittedChildren(platforms);
  return {
    success: true,
    code: 200,
    data: {
      taskId: TASK_ID,
      totalTask: children.length,
      subTaskList: children,
    },
  };
}

function statusResponse(
  total: number,
  completed = total,
  failed = 0,
  status = "completed",
) {
  return {
    success: true,
    data: {
      taskId: TASK_ID,
      status,
      completedItems: completed,
      failedItems: failed,
      totalItems: total,
    },
  };
}

function resultResponse(
  platforms: readonly MonitorPlatform[],
  count = MONITOR_REPEAT_PER_PLATFORM,
) {
  const children = submittedChildren(platforms, count).map((child, index) => ({
    ...child,
    status: "completed",
    answerContent: `第 ${index + 1} 次纯文字答案`,
    citationList: [
      {
        index: 1,
        title: `实际引用 ${index + 1}`,
        url: `https://citation.invalid/${index + 1}`,
        image: "must-not-survive",
      },
    ],
    referenceList: [
      {
        title: `检索来源 ${index + 1}`,
        url: `https://reference.invalid/${index + 1}`,
      },
    ],
    reasoningProcess: "private chain of thought",
    mediaContent: [
      {
        type: "image",
        url: "https://image.invalid/card.webp",
        title: "相关图片",
      },
      { type: "video", url: "javascript:alert(1)" },
    ],
    pageScreenshot: "https://screenshot.invalid/image.png",
    time: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
  }));
  return {
    success: true,
    data: {
      taskId: TASK_ID,
      status: "completed",
      totalItems: platforms.length * MONITOR_REPEAT_PER_PLATFORM,
      subTaskList: children,
    },
  };
}

class MemoryMonitorRepository implements MonitorRepository {
  readonly runs = new Map<string, PresalesMonitorRun>();
  readonly keyToRun = new Map<string, string>();
  private sequence = 0;

  async reserve(
    input: Parameters<MonitorRepository["reserve"]>[0],
  ): Promise<MonitorReservation> {
    const existingId = this.keyToRun.get(input.idempotencyKeyHash);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      if (
        existing.requestHash !== input.requestHash ||
        existing.apiCredentialId !== input.credential.id ||
        existing.credentialVersion !== input.credential.version
      ) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "conflicting monitor request",
        );
      }
      if (existing.deletedAt) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_RETIRED",
          409,
          "retired monitor idempotency key",
        );
      }
      return { state: "replay", run: existing };
    }
    const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
    const run = {
      id,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      question: input.question,
      platforms: [...input.platforms],
      expectedItems: input.expectedItems,
      status: "submission_in_progress",
      upstreamTaskId: null,
      submitTotalItems: null,
      initialSubtaskIds: null,
      subtaskScopes: null,
      remoteStatus: null,
      completedItems: 0,
      failedItems: 0,
      totalItems: null,
      checkpoint: null,
      finalResult: null,
      shapeMismatch: false,
      terminalSnapshotHash: null,
      terminalStableCount: 0,
      lastError: null,
      nextPollAt: null,
      lastPollStartedAt: null,
      pollLeaseId: null,
      pollLeaseExpiresAt: null,
      submittedAt: null,
      completedAt: null,
      deletedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    } satisfies PresalesMonitorRun;
    this.runs.set(id, run);
    this.keyToRun.set(input.idempotencyKeyHash, id);
    return { state: "acquired", run };
  }

  async get(runId: string) {
    const run = this.runs.get(runId);
    return run && !run.deletedAt ? run : null;
  }

  async markSubmissionUnknown(runId: string, error: string, now: Date) {
    return this.patch(runId, {
      status: "submission_unknown",
      lastError: error,
      updatedAt: now,
    });
  }

  async markSubmitted(
    runId: string,
    input: Parameters<MonitorRepository["markSubmitted"]>[1],
  ) {
    return this.patch(runId, {
      status: "submitted",
      upstreamTaskId: input.upstreamTaskId,
      submitTotalItems: input.submitTotalItems,
      initialSubtaskIds: input.initialSubtaskIds,
      subtaskScopes: input.subtaskScopes,
      submittedAt: input.now,
      nextPollAt: new Date(input.now.getTime() + MONITOR_POLL_INTERVAL_MS),
      updatedAt: input.now,
    });
  }

  async acquirePoll(
    runId: string,
    now: Date,
  ): Promise<MonitorPollLease | null> {
    const run = this.runs.get(runId);
    if (
      !run ||
      !["submitted", "polling"].includes(run.status) ||
      !run.upstreamTaskId ||
      (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) ||
      (run.pollLeaseId &&
        run.pollLeaseExpiresAt &&
        run.pollLeaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }
    const leaseId = `lease-${runId}`;
    const next = this.patch(runId, {
      status: "polling",
      lastPollStartedAt: now,
      nextPollAt: new Date(now.getTime() + MONITOR_POLL_INTERVAL_MS),
      pollLeaseId: leaseId,
      pollLeaseExpiresAt: new Date(now.getTime() + 120_000),
      updatedAt: now,
    });
    return { run: next, leaseId };
  }

  async finishPoll(
    runId: string,
    leaseId: string,
    patch: Partial<InsertPresalesMonitorRun>,
  ) {
    const current = this.runs.get(runId)!;
    if (current.pollLeaseId !== leaseId) return current;
    return this.patch(runId, {
      ...patch,
      pollLeaseId: null,
      pollLeaseExpiresAt: null,
    });
  }

  async remove(runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.deletedAt) return false;
    this.patch(runId, { deletedAt: new Date() });
    return true;
  }

  private patch(
    runId: string,
    patch: Partial<InsertPresalesMonitorRun>,
  ): PresalesMonitorRun {
    const current = this.runs.get(runId)!;
    const next = { ...current, ...patch } as PresalesMonitorRun;
    this.runs.set(runId, next);
    return next;
  }
}

class FakeMonitorTransport implements MonitorTransport {
  submitCalls = 0;
  statusCalls = 0;
  resultCalls = 0;
  submitValue: unknown;
  statusValues: unknown[];
  resultValues: unknown[];
  submitError: Error | null = null;

  constructor(platforms: readonly MonitorPlatform[]) {
    this.submitValue = submitResponse(platforms);
    this.statusValues = [statusResponse(platforms.length * 5)];
    this.resultValues = [resultResponse(platforms)];
  }

  async submit() {
    this.submitCalls += 1;
    if (this.submitError) throw this.submitError;
    return this.submitValue;
  }

  async status() {
    this.statusCalls += 1;
    return this.statusValues[
      Math.min(this.statusCalls - 1, this.statusValues.length - 1)
    ];
  }

  async result() {
    this.resultCalls += 1;
    return this.resultValues[
      Math.min(this.resultCalls - 1, this.resultValues.length - 1)
    ];
  }
}

function makeHarness(platforms: MonitorPlatform[] = ["deepseek"]) {
  const repository = new MemoryMonitorRepository();
  const transport = new FakeMonitorTransport(platforms);
  let clock = new Date("2026-01-01T00:00:00Z");
  const service = new PresalesMonitorService(
    repository,
    transport,
    async () => credential,
    async (id) => (id === credential.id ? credential : null),
    () => new Date(clock),
  );
  return {
    repository,
    transport,
    service,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function createInput(
  platforms: MonitorPlatform[] = ["deepseek"],
): MonitorCreateInput {
  return {
    question: QUESTION,
    platforms,
    idempotencyKey: "geo-project-monitor-payment-123456",
  };
}

describe("presales monitor transport configuration", () => {
  it("preserves a custom HTTPS base path when building transport URLs", () => {
    const env = {
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor.frontmind.test/custom/monitor/",
    };

    expect(monitorBaseUrl(env)).toBe(
      "https://monitor.frontmind.test/custom/monitor",
    );
    expect(buildMonitorRequestUrl("/task/batch/shared", env)).toBe(
      "https://monitor.frontmind.test/custom/monitor/task/batch/shared",
    );
  });

  it("allows HTTP only for explicit loopback development transports", () => {
    expect(
      buildMonitorRequestUrl("/task/status/task-1", {
        FRONTMIND_MONITOR_API_BASE_URL: "http://127.0.0.1:4010/api/",
      }),
    ).toBe("http://127.0.0.1:4010/api/task/status/task-1");
    expect(() =>
      monitorBaseUrl({
        FRONTMIND_MONITOR_API_BASE_URL: "http://monitor.frontmind.test/api",
      }),
    ).toThrow("监控 API 地址");
  });

  it.each([
    ["userinfo", "https://user:secret@monitor.frontmind.test/custom/monitor"],
    ["query", "https://monitor.frontmind.test/custom/monitor?target=other"],
    ["empty query", "https://monitor.frontmind.test/custom/monitor?"],
    ["fragment", "https://monitor.frontmind.test/custom/monitor#other"],
    ["empty fragment", "https://monitor.frontmind.test/custom/monitor#"],
  ])("rejects a %s base URL", (_label, value) => {
    expect(() =>
      monitorBaseUrl({ FRONTMIND_MONITOR_API_BASE_URL: value }),
    ).toThrow(PresalesMonitorError);
  });

  it("does not echo rejected credential-bearing configuration", () => {
    const configured =
      "https://sensitive-user:sensitive-password@monitor.frontmind.test/api";

    try {
      monitorBaseUrl({ FRONTMIND_MONITOR_API_BASE_URL: configured });
      throw new Error("expected invalid configuration to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(configured);
      expect(message).not.toContain("sensitive-user");
      expect(message).not.toContain("sensitive-password");
    }
  });
});

describe("presales monitor payload and reservation", () => {
  it("hard-codes one textual question, five repeats, search mode and no screenshots", () => {
    const payload = buildMonitorSubmitPayload({
      question: QUESTION,
      platforms: [
        "doubao",
        "yuanbao",
        "deepseek",
        "baiduai",
        "qianwen",
        "kimi",
      ],
    });
    expect(payload.prompts).toEqual(Array(5).fill(QUESTION));
    expect(payload.platforms).toHaveLength(6);
    expect(payload.platforms).toSatisfy((items) =>
      items.every((item) => item.mode === "search" && item.screenshot === 0),
    );
    expect(payload.platforms.map((item) => item.platform)).toEqual([
      "doubao",
      "yuanbao",
      "deepseek",
      "baiduai",
      "qianwen",
      "kimi",
    ]);
    expect(JSON.stringify(payload)).not.toContain("reasoning");
    expect(JSON.stringify(payload)).not.toContain("image");
  });

  it("rejects an unselected platform in a submitted task response", async () => {
    const harness = makeHarness(["baiduai"]);
    const response = submitResponse(["baiduai"]);
    for (const child of response.data.subTaskList) {
      (child as { platform: string }).platform = "chatgpt";
    }
    harness.transport.submitValue = response;

    await expect(
      harness.service.create(createInput(["baiduai"])),
    ).rejects.toMatchObject({ code: "MONITOR_SUBMISSION_UNKNOWN" });
  });

  it("separates safe media from display text without exposing raw HTML", () => {
    const sourceBrand = ["moli", "zhishu"].join("");
    const sourceNameCn = Buffer.from("6a2U5Yqb5pm65pWw", "base64").toString(
      "utf8",
    );
    const richAnswer =
      '<p>正文 &amp; 结论</p><img src="https://image.invalid/a.png" alt="产品图">' +
      "![架构图](https://image.invalid/b.webp)<script>secret()</script>" +
      '<video src="https://video.invalid/demo.mp4" poster="https://image.invalid/poster.jpg"></video>' +
      `<p>${sourceBrand} internal label · ${sourceNameCn}</p>`;
    const cleaned = sanitizeMonitorAnswerText(richAnswer);
    expect(cleaned).toContain("正文 & 结论");
    expect(cleaned).toContain("架构图");
    expect(cleaned).toContain("FrontMind internal label");
    expect(cleaned).not.toContain(sourceBrand);
    expect(cleaned).not.toContain(sourceNameCn);
    expect(cleaned).not.toMatch(/<|image\.invalid|video\.invalid|secret/i);
    expect(
      sanitizeMonitorMedia(
        [
          {
            type: "video",
            url: "https://media.invalid/interview.mp4",
            thumbnailUrl: "https://media.invalid/interview.webp",
            title: "采访视频",
          },
          { type: "image", url: "javascript:alert(1)" },
          {
            type: "image",
            url: `https://business-api.${sourceBrand}.com/private.png`,
          },
          {
            type: "image",
            url: `https://media.invalid/${sourceBrand}/private.png`,
          },
          {
            type: "image",
            url: `https://media.invalid/private.png?provider=${sourceBrand}`,
          },
        ],
        richAnswer,
      ),
    ).toEqual([
      {
        type: "video",
        url: "https://media.invalid/interview.mp4",
        thumbnailUrl: "https://media.invalid/interview.webp",
        title: "采访视频",
      },
      {
        type: "image",
        url: "https://image.invalid/a.png",
        title: "产品图",
      },
      {
        type: "video",
        url: "https://video.invalid/demo.mp4",
        thumbnailUrl: "https://image.invalid/poster.jpg",
      },
      {
        type: "image",
        url: "https://image.invalid/b.webp",
        title: "架构图",
      },
    ]);
  });

  it("preserves the Markdown structure used by real monitoring answers", () => {
    const markdown = `# 服务商靠谱性综合评估

## 一、优势（靠谱的地方）

### 1. 技术与性价比突出

1. **接口兼容性**：兼容 OpenAI 格式；
2. **部署形态**：支持公有云与私有化部署。

> ⚠️ 区分：共享 API ≠ 独享算力实例${"  "}
> ✅ 测试、低并发业务：按量实例可用

调用路径为 \`/v1/chat/completions\`。

### ❌ 不适合

- 要求严格 SLA 的核心业务。`;

    expect(sanitizeMonitorAnswerText(markdown)).toBe(markdown);
  });

  it("redacts a monitor secret before limiting error text length", () => {
    const secret = "sk-frontmind-secret-value";
    const cleaned = sanitizeMonitorErrorText(
      `${"x".repeat(495)}${secret}`,
      secret,
    );
    expect(cleaned).toHaveLength(500);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).not.toContain(secret.slice(0, 5));
  });

  it("replays the durable run and never repeats the paid POST", async () => {
    const harness = makeHarness(["deepseek"]);
    const first = await harness.service.create(createInput());
    const replay = await harness.service.create(createInput());
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.run.runId).toBe(first.run.runId);
    expect(harness.transport.submitCalls).toBe(1);
    expect(replay.run).toMatchObject({
      question: QUESTION,
      platforms: ["deepseek"],
      repeatPerPlatform: 5,
      expectedItems: 5,
    });
  });

  it("keeps an ambiguous submission sticky and does not POST on retry", async () => {
    const harness = makeHarness(["deepseek"]);
    harness.transport.submitError = new Error("socket closed after write");
    await expect(harness.service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_UNKNOWN",
    });
    harness.transport.submitError = null;
    const replay = await harness.service.create(createInput());
    expect(replay.replayed).toBe(true);
    expect(replay.run.status).toBe("submission_unknown");
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("rejects reusing one idempotency key for a different request", async () => {
    const harness = makeHarness(["deepseek"]);
    await harness.service.create(createInput());
    await expect(
      harness.service.create(createInput(["doubao"])),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("derives a stable opaque binding from FRONTMIND_MONITOR_API_KEY", () => {
    const env = { FRONTMIND_MONITOR_API_KEY: "frontmind-monitor-test-key" };
    const first = monitorCredentialFromEnv(env);
    const second = monitorCredentialFromEnv(env);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^env-[a-f0-9]{32}$/),
      version: expect.any(Number),
      fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
      status: "active",
    });
    expect(first?.version).toBeGreaterThan(0);
    expect(`${first?.id}${first?.version}${first?.fingerprint}`).not.toContain(
      env.FRONTMIND_MONITOR_API_KEY,
    );
    expect(monitorCredentialFromEnv({})).toBeNull();
  });

  it("rejects absent and placeholder dedicated monitor credentials", () => {
    expect(isDedicatedMonitorCredentialConfigured({})).toBe(false);
    expect(
      isDedicatedMonitorCredentialConfigured({
        FRONTMIND_MONITOR_API_KEY: "replace-with-monitor-key",
      }),
    ).toBe(false);
    expect(
      isDedicatedMonitorCredentialConfigured({
        FRONTMIND_MONITOR_API_KEY:
          "dedicated-monitor-credential-for-production",
      }),
    ).toBe(true);
    expect(() =>
      assertDedicatedMonitorCredentialConfigured({
        FRONTMIND_MONITOR_API_KEY: "",
      }),
    ).toThrow("FRONTMIND_MONITOR_API_KEY");
  });

  it("does not fall back to an ordinary presales credential in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalMonitorKey = process.env.FRONTMIND_MONITOR_API_KEY;
    process.env.NODE_ENV = "production";
    delete process.env.FRONTMIND_MONITOR_API_KEY;
    try {
      const service = new PresalesMonitorService(
        new MemoryMonitorRepository(),
        new FakeMonitorTransport(["deepseek"]),
      );
      await expect(service.create(createInput())).rejects.toMatchObject({
        code: "INVALID_CREDENTIAL",
        status: 428,
      });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalMonitorKey === undefined) {
        delete process.env.FRONTMIND_MONITOR_API_KEY;
      } else {
        process.env.FRONTMIND_MONITOR_API_KEY = originalMonitorKey;
      }
    }
  });

  it("fails closed when the dedicated environment key rotates", async () => {
    const repository = new MemoryMonitorRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    let env: NodeJS.ProcessEnv = {
      FRONTMIND_MONITOR_API_KEY: "frontmind-monitor-key-version-one",
    };
    let clock = new Date("2026-01-01T00:00:00Z");
    const activeCredential = async () => monitorCredentialFromEnv(env);
    const credentialById = async (id: string) => {
      const current = monitorCredentialFromEnv(env);
      return current?.id === id ? current : null;
    };
    const service = new PresalesMonitorService(
      repository,
      transport,
      activeCredential,
      credentialById,
      () => new Date(clock),
    );
    const created = await service.create(createInput());
    env = { FRONTMIND_MONITOR_API_KEY: "frontmind-monitor-key-version-two" };
    clock = new Date(clock.getTime() + MONITOR_POLL_INTERVAL_MS);
    const result = await service.result(created.run.runId);
    expect(result.status).toBe("remote_failed");
    expect(transport.statusCalls).toBe(0);
    expect(transport.resultCalls).toBe(0);
  });
});

describe("presales monitor polling and public result", () => {
  it("does not poll before 10 seconds and coalesces high-frequency GETs", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    await Promise.all(
      Array.from({ length: 10 }, () => harness.service.get(created.run.runId)),
    );
    expect(harness.transport.statusCalls).toBe(0);
    harness.advance(MONITOR_POLL_INTERVAL_MS - 1);
    await harness.service.get(created.run.runId);
    expect(harness.transport.statusCalls).toBe(0);
    harness.advance(1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => harness.service.get(created.run.runId)),
    );
    expect(harness.transport.statusCalls).toBe(1);
    expect(harness.transport.resultCalls).toBe(1);
    expect(results.some((run) => run.status === "completed")).toBe(true);
    expect((await harness.service.get(created.run.runId)).status).toBe(
      "completed",
    );
    expect(harness.transport.statusCalls).toBe(1);
  });

  it("returns safe structured media while stripping reasoning/screenshots/raw IDs", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.status).toBe("completed");
    expect(result.records).toHaveLength(5);
    expect(result.records?.[0]).toMatchObject({
      recordId: expect.stringMatching(/^mr_[a-f0-9]{24}$/),
      platform: "deepseek",
      runIndex: 1,
      status: "completed",
      answerText: "第 1 次纯文字答案",
      media: [
        {
          type: "image",
          url: "https://image.invalid/card.webp",
          title: "相关图片",
        },
      ],
      sources: [
        expect.objectContaining({ title: "实际引用 1" }),
        expect.objectContaining({ title: "检索来源 1" }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("subtask");
    expect(serialized).not.toContain("taskId");
    expect(serialized).not.toContain("reasoningProcess");
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("mediaContent");
    expect(serialized).not.toContain("pageScreenshot");
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("javascript:");
  });

  it("preserves a full answer and returns one deduplicated source collection", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    const longAnswer = "答".repeat(150_000);
    child.answerContent = `${longAnswer}<img src="https://media.invalid/answer.png" alt="回答配图">`;
    child.citationList = [
      ...Array.from({ length: 120 }, () => ({})),
      {
        index: 16,
        site: "实际引用站点",
        url: "https://citation.invalid/actual-only",
        summary: "实际引用摘要",
        icon: "icons/private.ico",
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        index: index + 20,
        title: `实际引用补充 ${index + 1}`,
        url: `https://citation.invalid/${index + 1}`,
      })),
    ];
    child.referenceList = [
      ...Array.from({ length: 250 }, () => ({})),
      {
        index: 1,
        title: "检索参考来源",
        site: "检索站点",
        url: "https://reference.invalid/retrieved-only",
        summary: "检索来源摘要",
      },
      ...Array.from({ length: 250 }, (_, index) => ({
        index: index + 2,
        title: `检索来源补充 ${index + 1}`,
        url: `https://reference.invalid/${index + 1}`,
      })),
    ];
    child.mediaContent = [
      {
        type: "video",
        url: "https://media.invalid/demo.mp4",
        desc: "产品演示",
      },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    const record = result.records?.[0];
    expect(record?.answerText).toBe(longAnswer);
    expect(record?.sources).toHaveLength(200);
    expect(record?.sources).toContainEqual({
      index: 16,
      source: "实际引用站点",
      url: "https://citation.invalid/actual-only",
      summary: "实际引用摘要",
    });
    expect(record?.sources).toContainEqual({
      index: 1,
      title: "检索参考来源",
      source: "检索站点",
      url: "https://reference.invalid/retrieved-only",
      summary: "检索来源摘要",
    });
    expect(record).not.toHaveProperty("citations");
    expect(record).not.toHaveProperty("references");
    expect(record?.media).toEqual([
      {
        type: "video",
        url: "https://media.invalid/demo.mp4",
        title: "产品演示",
      },
      {
        type: "image",
        url: "https://media.invalid/answer.png",
        title: "回答配图",
      },
    ]);
    expect(JSON.stringify(record)).not.toContain("icons/private.ico");
  });

  it("normalizes source URLs, removes tracking data, and blocks private URLs", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.citationList = [
      {
        title: "主要来源",
        url: "https://Example.invalid/report?utm_source=feed&b=2&a=1#part",
      },
      { title: "内网来源", url: "http://127.0.0.1/private" },
      {
        title: "映射内网来源",
        url: "http://[::ffff:127.0.0.1]/private",
      },
      {
        title: "映射内网十六进制来源",
        url: "http://[::ffff:a00:1]/private",
      },
    ];
    child.referenceList = [
      {
        title: "重复来源的完整标题",
        url: "https://example.invalid/report?a=1&b=2",
        summary: "补充摘要",
      },
      { title: "无链接来源", domain: "industry.example" },
      { title: "本地主机", url: "https://localhost/secret" },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toEqual([
      {
        title: "重复来源的完整标题",
        url: "https://example.invalid/report?a=1&b=2",
        summary: "补充摘要",
      },
      { title: "无链接来源", domain: "industry.example" },
    ]);
  });

  it("prefers the canonical upstream source collection over legacy arrays", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.sources = [
      {
        title: "规范来源",
        url: "https://canonical.example/report?utm_source=monitor#summary",
      },
    ];
    child.citationList = [
      { title: "不应合并的旧引用", url: "https://legacy.example/citation" },
    ];
    child.referenceList = [
      { title: "不应合并的旧参考", url: "https://legacy.example/reference" },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toEqual([
      {
        title: "规范来源",
        url: "https://canonical.example/report",
      },
    ]);
  });

  it.each([
    ["sources", [], []],
    [
      "sourceList",
      {
        title: "单对象规范来源",
        url: "https://canonical.example/object",
      },
      [
        {
          title: "单对象规范来源",
          url: "https://canonical.example/object",
        },
      ],
    ],
    [
      "source_list",
      "https://canonical.example/string?utm_source=monitor#part",
      ["https://canonical.example/string"],
    ],
  ] as const)(
    "treats an explicitly present %s field as authoritative",
    async (field, value, expected) => {
      const harness = makeHarness(["deepseek"]);
      const created = await harness.service.create(createInput());
      const payload = resultResponse(["deepseek"]);
      const child = payload.data.subTaskList[0] as Record<string, unknown>;
      child[field] = value;
      child.citationList = [
        { title: "不应回退的旧引用", url: "https://legacy.example/citation" },
      ];
      child.referenceList = [
        { title: "不应回退的旧参考", url: "https://legacy.example/reference" },
      ];
      harness.transport.resultValues = [payload];

      harness.advance(MONITOR_POLL_INTERVAL_MS);
      const result = await harness.service.result(created.run.runId);
      expect(result.records?.[0].sources).toEqual(expected);
    },
  );

  it("deduplicates a title-only string with the equivalent structured source", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.sources = [
      "同名行业来源",
      { title: "同名行业来源", summary: "保留更完整的结构化信息" },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toEqual([
      { title: "同名行业来源", summary: "保留更完整的结构化信息" },
    ]);
  });

  it("deduplicates all safe candidates before applying the 200-source limit", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.citationList = [];
    child.referenceList = [
      ...Array.from({ length: 200 }, (_, index) => ({
        index,
        title: `同一来源版本 ${index + 1}`,
        url: "https://sources.example/shared",
      })),
      {
        index: 201,
        title: "第 201 个唯一来源",
        url: "https://sources.example/unique-201",
      },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toHaveLength(2);
    expect(result.records?.[0].sources).toContainEqual({
      index: 201,
      title: "第 201 个唯一来源",
      url: "https://sources.example/unique-201",
    });
  });

  it("can enrich a retained source after 200 unique identities are seen", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const payload = resultResponse(["deepseek"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.sources = [
      ...Array.from({ length: 200 }, (_, index) => ({
        title: `来源 ${index + 1}`,
        url: `https://sources.example/${index + 1}`,
      })),
      {
        title: "来源 1 的完整标题",
        url: "https://sources.example/1",
        summary: "来自候选安全窗口末尾的补充信息",
      },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toHaveLength(200);
    expect(result.records?.[0].sources?.[0]).toEqual({
      title: "来源 1 的完整标题",
      url: "https://sources.example/1",
      summary: "来自候选安全窗口末尾的补充信息",
    });
  });

  it("derives Kimi citations only from exact zero-based inline source indexes", async () => {
    const harness = makeHarness(["kimi"]);
    const created = await harness.service.create(createInput(["kimi"]));
    const payload = resultResponse(["kimi"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.answerContent =
      "第一条结论citeweb_search:1#0，第二条结论citeweb_search:1#1，未知来源citeweb_search:1#9。";
    child.citationList = [];
    child.referenceList = [
      {
        index: 0,
        title: "Kimi 实际引用 0",
        url: "https://reference.invalid/kimi-0",
      },
      {
        index: 1,
        title: "Kimi 实际引用 1",
        url: "https://reference.invalid/kimi-1",
      },
      {
        index: 2,
        title: "仅检索未引用",
        url: "https://reference.invalid/retrieved-only",
      },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    const record = result.records?.[0];
    expect(record?.answerText).toContain("〔来源 0〕");
    expect(record?.answerText).toContain("〔来源 1〕");
    expect(record?.answerText).not.toContain("来源 9");
    expect(record?.answerText).not.toMatch(/[\uE3A0\uE3A3\uE3A8]/u);
    expect(record?.sources).toHaveLength(3);
    expect(record?.sources).toContainEqual({
      index: 0,
      title: "Kimi 实际引用 0",
      url: "https://reference.invalid/kimi-0",
    });
    expect(JSON.stringify(record?.sources)).toContain("retrieved-only");
  });

  it("keeps the most complete duplicate while safely merging explicit inline citations", async () => {
    const harness = makeHarness(["kimi"]);
    const created = await harness.service.create(createInput(["kimi"]));
    const payload = resultResponse(["kimi"]);
    const child = payload.data.subTaskList[0] as Record<string, unknown>;
    child.answerContent =
      "结构化来源citeweb_search:2#0，补充来源citeweb_search:2#1。";
    child.citationList = [
      {
        index: 0,
        title: "结构化引用优先",
        url: "https://reference.invalid/shared-0",
      },
    ];
    child.referenceList = [
      {
        index: 0,
        title: "同一来源的检索版本",
        url: "https://reference.invalid/shared-0",
        summary: "不应制造第二条重复引用",
      },
      {
        index: 1,
        title: "明确内联引用",
        url: "https://reference.invalid/inline-1",
      },
      {
        index: 3,
        title: "没有内联标记的检索来源",
        url: "https://reference.invalid/retrieved-3",
      },
    ];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].sources).toHaveLength(3);
    expect(result.records?.[0].sources).toContainEqual({
      index: 0,
      title: "同一来源的检索版本",
      url: "https://reference.invalid/shared-0",
      summary: "不应制造第二条重复引用",
    });
    expect(JSON.stringify(result.records?.[0].sources)).toContain(
      "retrieved-3",
    );
  });

  it("returns Baidu AI+ under the public baiduai contract", async () => {
    const harness = makeHarness(["baiduai"]);
    const created = await harness.service.create(createInput(["baiduai"]));
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.platforms).toEqual(["baiduai"]);
    expect(result.records).toHaveLength(5);
    expect(
      result.records?.every((record) => record.platform === "baiduai"),
    ).toBe(true);
    expect(JSON.stringify(result)).toContain('"platform":"baiduai"');
  });

  it("fails closed when a result reports a different platform", async () => {
    const harness = makeHarness(["baiduai"]);
    const created = await harness.service.create(createInput(["baiduai"]));
    const mismatchedResult = resultResponse(["baiduai"]);
    for (const child of mismatchedResult.data.subTaskList) {
      (child as { platform: string }).platform = "qianwen";
    }
    harness.transport.resultValues = [mismatchedResult];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.status).toBe("shape_mismatch");
    expect(result.records).toBeUndefined();
  });

  it("replaces remote child errors with a controlled public message", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const resultPayload = resultResponse(["deepseek"]);
    const sourceBrand = ["moli", "zhishu"].join("");
    resultPayload.data.subTaskList[0].errorMessage = `${sourceBrand} failed at https://private.invalid with sk-secret`;
    resultPayload.data.subTaskList[0].answerContent = `<p>${sourceBrand} diagnostic</p>`;
    resultPayload.data.subTaskList[0].citationList = [
      {
        title: `${sourceBrand} diagnostic`,
        url: `https://citation.invalid/${sourceBrand}/internal`,
      },
    ];
    resultPayload.data.subTaskList[0].mediaContent = [
      {
        type: "image",
        title: `${sourceBrand} diagnostic`,
        url: `https://media.invalid/internal.png?provider=${sourceBrand}`,
      },
    ];
    harness.transport.resultValues = [resultPayload];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.records?.[0].error).toBe("本次回答未成功");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sourceBrand);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("private.invalid");
    expect(result.records?.[0].answerText).toBe("FrontMind diagnostic");
    expect(result.records?.[0].media).toEqual([]);
  });

  it("fails closed on result identity or total mismatch", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const invalid = resultResponse(["deepseek"]);
    invalid.data.subTaskList[0].subTaskId = "unknown_subtask_123456";
    harness.transport.resultValues = [invalid];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.status).toBe("shape_mismatch");
    expect(result.records).toBeUndefined();
    expect(harness.transport.resultCalls).toBe(1);
  });

  it("does not finalize until both status and result report a terminal main state", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    harness.transport.statusValues = [
      statusResponse(5, 5, 0, "processing"),
      statusResponse(5),
    ];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "polling",
    );
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "completed",
    );
  });

  it("fails closed when a result omits its main status", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    const invalid = resultResponse(["deepseek"]);
    delete (invalid.data as any).status;
    harness.transport.resultValues = [invalid];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "shape_mismatch",
    );
  });

  it("requires two stable terminal snapshots before exposing partial results", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create(createInput());
    harness.transport.statusValues = [
      statusResponse(5, 4, 0),
      statusResponse(5, 4, 0),
    ];
    harness.transport.resultValues = [
      resultResponse(["deepseek"], 4),
      resultResponse(["deepseek"], 4),
    ];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const first = await harness.service.result(created.run.runId);
    expect(first.status).toBe("polling");
    expect(first.complete).toBe(false);
    expect(first.records).toHaveLength(4);
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const second = await harness.service.result(created.run.runId);
    expect(second.status).toBe("partial_review_required");
    expect(second.records).toHaveLength(4);
  });
});

async function listen(router: express.Router) {
  const app = express();
  app.use("/monitor-runs", router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/monitor-runs`,
  };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("presales monitor HTTP contract", () => {
  it("returns a FrontMind-only service message when no monitor credential exists", async () => {
    const repository = new MemoryMonitorRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => null,
      async () => null,
    );
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(service),
    );
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      expect(response.status).toBe(428);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_CREDENTIAL",
          message: "FrontMind 监控服务暂未启用，请联系技术人员",
        },
      });
      expect(transport.submitCalls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("returns {run}, exposes completed checkpoint records while polling, and retires deleted idempotency keys", async () => {
    const harness = makeHarness(["deepseek"]);
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(harness.service),
    );
    try {
      const createResponse = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as any;
      expect(created.run).toMatchObject({
        runId: expect.any(String),
        status: "submitted",
        repeatPerPlatform: 5,
        expectedItems: 5,
      });

      const pending = await fetch(`${baseUrl}/${created.run.runId}/result`);
      expect(pending.status).toBe(202);
      const pendingBody = (await pending.json()) as any;
      expect(pendingBody.run.complete).toBe(false);
      expect(pendingBody.run.records).toBeUndefined();

      harness.advance(MONITOR_POLL_INTERVAL_MS);
      const complete = await fetch(`${baseUrl}/${created.run.runId}/result`);
      expect(complete.status).toBe(200);
      const completeBody = (await complete.json()) as any;
      expect(completeBody.run.complete).toBe(true);
      expect(completeBody.run.records).toHaveLength(5);

      const deleted = await fetch(`${baseUrl}/${created.run.runId}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(204);

      expect((await fetch(`${baseUrl}/${created.run.runId}`)).status).toBe(404);
      const retiredReplay = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      expect(retiredReplay.status).toBe(409);
      await expect(retiredReplay.json()).resolves.toMatchObject({
        error: { code: "IDEMPOTENCY_RETIRED" },
      });
      expect(harness.transport.submitCalls).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("returns the first completed answer and isolated evidence in a 202 polling result", async () => {
    const harness = makeHarness(["deepseek"]);
    harness.transport.statusValues = [statusResponse(5, 1, 0, "processing")];
    const partialResult = resultResponse(["deepseek"]);
    partialResult.data.status = "processing";
    for (const child of partialResult.data.subTaskList.slice(1)) {
      child.status = "pending";
      child.answerContent = "";
      child.citationList = [];
      child.referenceList = [];
      child.mediaContent = [];
      delete (child as Partial<typeof child>).time;
    }
    harness.transport.resultValues = [partialResult];
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(harness.service),
    );
    try {
      const createResponse = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createInput()),
      });
      const created = (await createResponse.json()) as any;

      harness.advance(MONITOR_POLL_INTERVAL_MS);
      const response = await fetch(`${baseUrl}/${created.run.runId}/result`);
      expect(response.status).toBe(202);
      const body = (await response.json()) as any;
      expect(body.run).toMatchObject({
        status: "polling",
        completedItems: 1,
        failedItems: 0,
        complete: false,
      });
      expect(body.run.records).toHaveLength(1);
      expect(body.run.records[0]).toMatchObject({
        recordId: expect.stringMatching(/^mr_[a-f0-9]{24}$/),
        platform: "deepseek",
        runIndex: 1,
        status: "completed",
        answerText: "第 1 次纯文字答案",
        sources: [
          expect.objectContaining({
            title: "实际引用 1",
            url: "https://citation.invalid/1",
          }),
          expect.objectContaining({
            title: "检索来源 1",
            url: "https://reference.invalid/1",
          }),
        ],
      });
      expect(body.run.records[0]).not.toHaveProperty("citations");
      expect(body.run.records[0]).not.toHaveProperty("references");
      expect(JSON.stringify(body)).not.toContain("subTaskId");
      expect(JSON.stringify(body)).not.toContain(TASK_ID);
    } finally {
      await close(server);
    }
  });

  it("rejects browser-controlled mode, screenshot, repeat and unknown platforms", async () => {
    const harness = makeHarness(["deepseek"]);
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(harness.service),
    );
    try {
      for (const body of [
        { ...createInput(), mode: "standard" },
        { ...createInput(), screenshot: 1 },
        { ...createInput(), repeat: 1 },
        { ...createInput(), platforms: ["unknown"] },
        { ...createInput(), platforms: ["chatgpt"] },
      ]) {
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(harness.transport.submitCalls).toBe(0);
    } finally {
      await close(server);
    }
  });
});
