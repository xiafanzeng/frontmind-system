import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  InsertPresalesMonitorRun,
  PresalesMonitorRun,
} from "../drizzle/schema";
import {
  presalesMonitorRuns,
  websiteProjectDeletionTombstones,
} from "../drizzle/schema";
import {
  buildMonitorSubmitPayload,
  buildMonitorRequestUrl,
  buildMonitorRegionCatalogUrl,
  createPresalesMonitorRouter,
  assertDedicatedMonitorCredentialConfigured,
  assertWorkspaceMonitorQuotaAvailable,
  AxiosMonitorTransport,
  AxiosMonitorRegionCatalog,
  AxiosMonitorScreenshotTransport,
  getDedicatedMonitorCredentialReadiness,
  isMonitorDuplicateReservationError,
  isDedicatedMonitorCredentialConfigured,
  MONITOR_POLL_INTERVAL_MS,
  MONITOR_REPEAT_PER_PLATFORM,
  monitorResponseExplicitlyRejectsSubmission,
  monitorBaseUrl,
  monitorCredentialFromEnv,
  MonitorRemoteError,
  probeDedicatedMonitorCredential,
  PresalesMonitorError,
  PresalesMonitorService,
  purgePresalesProjectMonitorRuns,
  sanitizeMonitorAnswerText,
  sanitizeMonitorErrorText,
  sanitizeMonitorMedia,
  type MonitorCreateInput,
  type MonitorPlatform,
  type MonitorPollLease,
  type MonitorRegionCatalog,
  type MonitorRepository,
  type MonitorReservation,
  type MonitorScreenshotTransport,
  type MonitorTransport,
  workspaceMonitorProjectId,
} from "./presales-monitor";
import { WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED } from "./website-project-lifecycle";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

function recoveringResult(
  platform: MonitorPlatform,
  completed: number,
  failed: number,
  status:
    | "completed"
    | "partial_completed"
    | "processing" = "partial_completed",
) {
  const payload = resultResponse([platform]) as any;
  payload.data.status = status;
  payload.data.subTaskList.forEach((child: any, index: number) => {
    if (index < completed) return;
    child.answerContent = "";
    delete child.time;
    if (index < completed + failed) {
      child.status = "failed";
      child.errorMessage = "provider retrying";
      return;
    }
    child.status = "processing";
    delete child.errorMessage;
  });
  return payload;
}

class MemoryMonitorRepository implements MonitorRepository {
  readonly runs = new Map<string, PresalesMonitorRun>();
  readonly keyToRun = new Map<string, string>();
  readonly workspaceLimits = new Map<number, number | null>();
  private sequence = 0;

  async reserve(
    input: Parameters<MonitorRepository["reserve"]>[0],
  ): Promise<MonitorReservation> {
    const existingId = this.keyToRun.get(input.idempotencyKeyHash);
    if (existingId) {
      const existing = this.runs.get(existingId)!;
      if (
        input.workspaceQuota &&
        existing.projectId !==
          workspaceMonitorProjectId(input.workspaceQuota.userId)
      ) {
        throw new PresalesMonitorError("NOT_FOUND", 404, "not found");
      }
      if (existing.requestHash !== input.requestHash) {
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
      const credentialChanged =
        existing.apiCredentialId !== input.credential.id ||
        existing.credentialVersion !== input.credential.version;
      const existingRequest = (existing.checkpoint as any)?.request;
      const incomingRequest = input.checkpoint.request;
      const sameRequestEnvelope = Boolean(
        existingRequest &&
          incomingRequest &&
          existingRequest.consumerTaskId === incomingRequest.consumerTaskId &&
          existingRequest.screenshot === incomingRequest.screenshot &&
          (existingRequest.monitorKeyword ?? "") ===
            (incomingRequest.monitorKeyword ?? "") &&
          (existingRequest.region?.scope ?? "") ===
            (incomingRequest.region?.scope ?? "") &&
          (existingRequest.region?.code ?? "") ===
            (incomingRequest.region?.code ?? ""),
      );
      if (
        !credentialChanged &&
        existing.status === "submission_unknown" &&
        !existing.upstreamTaskId &&
        sameRequestEnvelope
      ) {
        return {
          state: "acquired",
          run: this.patch(existing.id, {
            status: "submission_in_progress",
            lastError: null,
            updatedAt: input.now,
          }),
        };
      }
      if (
        credentialChanged &&
        existing.status === "remote_failed" &&
        !existing.upstreamTaskId
      ) {
        if (input.workspaceQuota) {
          const limit = this.workspaceLimits.get(input.workspaceQuota.userId);
          if (!this.workspaceLimits.has(input.workspaceQuota.userId)) {
            throw new PresalesMonitorError("NOT_FOUND", 404, "not found");
          }
          assertWorkspaceMonitorQuotaAvailable({
            limit: limit ?? null,
            used: this.workspaceUsed(input.workspaceQuota),
            expectedItems: input.expectedItems,
          });
        }
        const retried = this.patch(existing.id, {
          apiCredentialId: input.credential.id,
          credentialVersion: input.credential.version,
          status: "submission_in_progress",
          checkpoint: input.checkpoint,
          lastError: null,
          completedAt: null,
          ...(input.workspaceQuota ? { createdAt: input.now } : {}),
          updatedAt: input.now,
        });
        return { state: "acquired", run: retried };
      }
      if (credentialChanged) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "conflicting monitor credential",
        );
      }
      return { state: "replay", run: existing };
    }
    if (input.workspaceQuota) {
      const limit = this.workspaceLimits.get(input.workspaceQuota.userId);
      if (!this.workspaceLimits.has(input.workspaceQuota.userId)) {
        throw new PresalesMonitorError("NOT_FOUND", 404, "not found");
      }
      assertWorkspaceMonitorQuotaAvailable({
        limit: limit ?? null,
        used: this.workspaceUsed(input.workspaceQuota),
        expectedItems: input.expectedItems,
      });
    }
    const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
    const run = {
      id,
      projectId: input.projectId ?? null,
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
      checkpoint: input.checkpoint,
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

  async getLatestByProject(projectId: string) {
    return (
      [...this.runs.values()]
        .filter((run) => run.projectId === projectId && !run.deletedAt)
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )[0] ?? null
    );
  }

  async getWorkspaceQuota(
    input: Parameters<MonitorRepository["getWorkspaceQuota"]>[0],
  ) {
    if (!this.workspaceLimits.has(input.userId)) return null;
    return {
      limit: this.workspaceLimits.get(input.userId) ?? null,
      used: this.workspaceUsed(input),
    };
  }

  async markSubmissionUnknown(runId: string, error: string, now: Date) {
    return this.patch(runId, {
      status: "submission_unknown",
      lastError: error,
      updatedAt: now,
    });
  }

  async markSubmissionCleanupPending(
    runId: string,
    upstreamTaskId: string,
    error: string,
    now: Date,
  ) {
    return this.patch(runId, {
      status: "submission_unknown",
      upstreamTaskId,
      lastError: error,
      updatedAt: now,
    });
  }

  async markSubmissionRejected(runId: string, error: string, now: Date) {
    return this.patch(runId, {
      status: "remote_failed",
      lastError: error,
      completedAt: now,
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
      !(
        ["submitted", "polling"].includes(run.status) ||
        (["completed", "partial_review_required", "remote_failed"].includes(
          run.status,
        ) &&
          Boolean(run.upstreamTaskId) &&
          Boolean(run.submittedAt) &&
          Boolean(run.completedAt) &&
          ["completed", "partial_completed"].includes(
            String(run.remoteStatus || "").toLowerCase(),
          ) &&
          run.completedAt!.getTime() <
            run.submittedAt!.getTime() + 6 * 60 * 60_000 &&
          run.completedAt!.getTime() <= now.getTime() &&
          ((run.checkpoint as any)?.items ?? []).length > 0 &&
          ((run.checkpoint as any)?.items ?? []).filter(
            (item: any) =>
              item.status === "completed" &&
              String(item.answerText || "").trim() &&
              !item.error,
          ).length < run.expectedItems)
      ) ||
      !run.upstreamTaskId ||
      (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) ||
      (run.pollLeaseId &&
        run.pollLeaseExpiresAt &&
        run.pollLeaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }
    const reopening = !["submitted", "polling"].includes(run.status);
    const leaseId = `lease-${runId}`;
    const next = this.patch(runId, {
      status: "polling",
      ...(reopening
        ? {
            finalResult: null,
            completedAt: null,
            lastError: null,
            terminalSnapshotHash: null,
            terminalStableCount: 0,
          }
        : {}),
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

  private workspaceUsed(
    input: Parameters<MonitorRepository["getWorkspaceQuota"]>[0],
  ) {
    const projectId = workspaceMonitorProjectId(input.userId);
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.projectId === projectId &&
          run.createdAt >= input.windowStartedAt &&
          run.createdAt < input.windowEndsAt &&
          (run.status !== "remote_failed" || Boolean(run.upstreamTaskId)),
      )
      .reduce((used, run) => used + run.expectedItems, 0);
  }
}

class FakeMonitorTransport implements MonitorTransport {
  submitCalls = 0;
  statusCalls = 0;
  resultCalls = 0;
  stopCalls = 0;
  submitValue: unknown;
  statusValues: unknown[];
  resultValues: unknown[];
  submitError: Error | null = null;
  stopError: Error | null = null;
  submittedPayloads: Array<ReturnType<typeof buildMonitorSubmitPayload>> = [];

  constructor(platforms: readonly MonitorPlatform[]) {
    this.submitValue = submitResponse(platforms);
    this.statusValues = [statusResponse(platforms.length * 5)];
    this.resultValues = [resultResponse(platforms)];
  }

  async submit(payload: ReturnType<typeof buildMonitorSubmitPayload>) {
    this.submitCalls += 1;
    this.submittedPayloads.push(payload);
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

  async stop() {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
    return { success: true };
  }
}

function makeHarness(
  platforms: MonitorPlatform[] = ["deepseek"],
  options: {
    regionCatalog?: MonitorRegionCatalog;
    screenshotTransport?: MonitorScreenshotTransport;
  } = {},
) {
  const repository = new MemoryMonitorRepository();
  const transport = new FakeMonitorTransport(platforms);
  let clock = new Date("2026-01-01T00:00:00Z");
  const service = new PresalesMonitorService(
    repository,
    transport,
    async () => credential,
    async (id) => (id === credential.id ? credential : null),
    () => new Date(clock),
    options.regionCatalog,
    options.screenshotTransport,
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

function monitorPurgeExecutor(rows: PresalesMonitorRun[]) {
  const tx = {
    select() {
      return {
        from(table: unknown) {
          if (table === websiteProjectDeletionTombstones) {
            return {
              where() {
                return {
                  limit() {
                    return {
                      for: async () => [{ status: "deleting" }],
                    };
                  },
                };
              },
            };
          }
          if (table !== presalesMonitorRuns) {
            throw new Error("unexpected monitor purge table");
          }
          return {
            where() {
              return { for: async () => [...rows] };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      if (table !== presalesMonitorRuns) {
        throw new Error("unexpected monitor purge delete table");
      }
      return {
        where: async () => {
          rows.splice(0, rows.length);
          return [{ affectedRows: 1 }];
        },
      };
    },
  };
  return {
    rows,
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
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
    expect(buildMonitorRegionCatalogUrl("domestic", env)).toBe(
      "https://monitor.frontmind.test/custom/eip-edge/ports/city-info",
    );
    expect(buildMonitorRegionCatalogUrl("overseas", env)).toBe(
      "https://monitor.frontmind.test/custom/eip-edge/regions/overseas",
    );
  });

  it("loads a public region catalog without monitor authorization and skips bad entries", async () => {
    const request = vi.spyOn(axios, "request").mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: [
          { province: "北京市", regionCode: ["110000"] },
          { province: "多节点", regionCode: ["node-a", "node-b"] },
          { province: "坏条目", regionCode: [""] },
          { province: "缺少代码" },
        ],
      },
    });
    const catalog = new AxiosMonitorRegionCatalog(undefined, {
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor.frontmind.test/api/business/monitor",
    });

    await expect(catalog.list("domestic")).resolves.toEqual([
      { scope: "domestic", code: "110000", label: "北京市" },
      { scope: "domestic", code: "node-a", label: "多节点" },
      { scope: "domestic", code: "node-b", label: "多节点" },
    ]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "https://monitor.frontmind.test/api/business/eip-edge/ports/city-info",
        headers: { Accept: "application/json" },
        maxRedirects: 0,
      }),
    );
    expect(request.mock.calls[0][0].headers).not.toHaveProperty(
      "Authorization",
    );
  });

  it("rejects an empty or malformed region catalog", async () => {
    const catalog = new AxiosMonitorRegionCatalog(async () => ({
      status: 200,
      data: {
        success: true,
        data: [{ name: "", regionCode: [""] }, { unexpected: true }],
      },
    }));

    await expect(catalog.list("overseas")).rejects.toMatchObject({
      code: "REGION_CATALOG_UNAVAILABLE",
      status: 503,
    });
  });

  it("downloads only exact domestic or overseas HTTPS screenshot hosts", async () => {
    const request = vi.fn(async (input: { url: string }) => ({
      status: 200,
      data: Buffer.from("image-bytes"),
      headers: { "content-type": "image/png; charset=binary" },
      requestedUrl: input.url,
    }));
    const transport = new AxiosMonitorScreenshotTransport(request);
    const url =
      "https://img.molizhishu.com/signed/render?id=answer-1&token=preserved";

    await expect(transport.fetch(url)).resolves.toEqual({
      contentType: "image/png",
      data: Buffer.from("image-bytes"),
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url, maxContentLength: 8 * 1024 * 1024 }),
    );

    request.mockResolvedValueOnce({
      status: 206,
      data: Buffer.from("overseas-image-bytes"),
      headers: { "content-type": "image/png" },
      requestedUrl:
        "https://aigeo-jp.oss-ap-northeast-1.aliyuncs.com/signed/answer.png?token=preserved",
    });
    const overseasUrl =
      "https://aigeo-jp.oss-ap-northeast-1.aliyuncs.com/signed/answer.png?token=preserved";
    await expect(transport.fetch(overseasUrl)).resolves.toEqual({
      contentType: "image/png",
      data: Buffer.from("overseas-image-bytes"),
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: overseasUrl }),
    );
  });

  it("rejects unsafe, redirected, oversized or non-image screenshots", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      data: Buffer.from("redirect"),
      headers: { "content-type": "image/png" },
    }));
    const transport = new AxiosMonitorScreenshotTransport(request);

    await expect(
      transport.fetch("https://other.invalid/signed/render?id=1"),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
    await expect(
      transport.fetch(
        "https://aigeo-jp.oss-ap-northeast-1.aliyuncs.com.evil.invalid/render?id=1",
      ),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
    await expect(
      transport.fetch(
        "https://another-bucket.oss-ap-northeast-1.aliyuncs.com/render?id=1",
      ),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
    await expect(
      transport.fetch(
        "https://user:password@aigeo-jp.oss-ap-northeast-1.aliyuncs.com/render?id=1",
      ),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
    await expect(
      transport.fetch(
        "http://aigeo-jp.oss-ap-northeast-1.aliyuncs.com/render?id=1",
      ),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
    expect(request).not.toHaveBeenCalled();

    await expect(
      transport.fetch("https://img.molizhishu.com/signed/render?id=1"),
    ).rejects.toMatchObject({ code: "SCREENSHOT_UPSTREAM_UNAVAILABLE" });

    request.mockResolvedValueOnce({
      status: 200,
      data: Buffer.from("not-an-image"),
      headers: { "content-type": "text/html" },
    });
    await expect(
      transport.fetch("https://img.molizhishu.com/signed/render?id=2"),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });

    request.mockResolvedValueOnce({
      status: 200,
      data: Buffer.alloc(8 * 1024 * 1024 + 1),
      headers: { "content-type": "image/webp" },
    });
    await expect(
      transport.fetch("https://img.molizhishu.com/signed/render?id=3"),
    ).rejects.toMatchObject({ code: "SCREENSHOT_NOT_AVAILABLE" });
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
  it("recognizes a Drizzle-wrapped duplicate reservation without unbounded cause traversal", () => {
    expect(
      isMonitorDuplicateReservationError({
        name: "DrizzleQueryError",
        cause: { cause: { code: "ER_DUP_ENTRY", errno: 1062 } },
      }),
    ).toBe(true);
    expect(
      isMonitorDuplicateReservationError({
        name: "DrizzleQueryError",
        cause: { errno: 1062 },
      }),
    ).toBe(true);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isMonitorDuplicateReservationError(cyclic)).toBe(false);
    expect(
      isMonitorDuplicateReservationError({
        cause: {
          cause: {
            cause: {
              cause: {
                cause: {
                  cause: {
                    cause: {
                      cause: { code: "ER_DUP_ENTRY" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

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
        "chatgpt",
      ],
    });
    expect(payload.prompts).toEqual(Array(5).fill(QUESTION));
    expect(payload.platforms).toHaveLength(7);
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
      "chatgpt",
    ]);
    expect(JSON.stringify(payload)).not.toContain("reasoning");
    expect(JSON.stringify(payload)).not.toContain("image");
  });

  it("adds one server-owned brand keyword, screenshot mode, consumer ID and region code", () => {
    const payload = buildMonitorSubmitPayload({
      question: QUESTION,
      platforms: ["deepseek"],
      consumerTaskId: "fm12345678",
      monitorKeyword: "华润医药",
      screenshot: 1,
      region: { code: "node/custom value" },
    });

    expect(payload).toMatchObject({
      prompts: Array(5).fill(QUESTION),
      consumerTaskId: "fm12345678",
      monitorKeywords: "华润医药",
      regionCode: ["node/custom value"],
      platforms: [{ platform: "deepseek", mode: "search", screenshot: 1 }],
    });
    expect(
      buildMonitorSubmitPayload({
        question: QUESTION,
        platforms: ["deepseek"],
      }),
    ).not.toHaveProperty("regionCode");
  });

  it("validates a selected region once in Dashboard and submits its opaque code", async () => {
    const calls: string[] = [];
    const regionCatalog: MonitorRegionCatalog = {
      async list(scope) {
        calls.push(scope);
        return [
          { scope, code: "node/custom value", label: "北京市 · 自定义节点" },
        ];
      },
    };
    const harness = makeHarness(["deepseek"], { regionCatalog });
    const input = {
      ...createInput(),
      monitorKeyword: "华润医药",
      screenshot: 1 as const,
      region: { scope: "domestic" as const, code: "node/custom value" },
    };

    const created = await harness.service.create(input);

    expect(calls).toEqual(["domestic"]);
    expect(created.run).toMatchObject({
      monitorKeyword: "华润医药",
      screenshot: 1,
      region: {
        scope: "domestic",
        code: "node/custom value",
        label: "北京市 · 自定义节点",
      },
    });
    expect(harness.transport.submittedPayloads[0]).toMatchObject({
      monitorKeywords: "华润医药",
      regionCode: ["node/custom value"],
      platforms: [{ screenshot: 1 }],
    });
    expect(harness.transport.submittedPayloads[0].consumerTaskId).toMatch(
      /^[A-Za-z0-9]{8,64}$/,
    );
    expect(JSON.stringify(created.run)).not.toContain("consumerTaskId");
  });

  it("rejects a stale selected region before the paid POST", async () => {
    const harness = makeHarness(["deepseek"], {
      regionCatalog: {
        async list(scope) {
          return [{ scope, code: "110000", label: "北京市" }];
        },
      },
    });

    await expect(
      harness.service.create({
        ...createInput(),
        region: { scope: "domestic", code: "expired-code" },
      }),
    ).rejects.toMatchObject({ code: "REGION_UNAVAILABLE", status: 422 });
    expect(harness.transport.submitCalls).toBe(0);
  });

  it("treats region scope and code, but not its current label, as request identity", async () => {
    let label = "北京市";
    const harness = makeHarness(["deepseek"], {
      regionCatalog: {
        async list(scope) {
          return [{ scope, code: "110000", label }];
        },
      },
    });
    const input = {
      ...createInput(),
      region: { scope: "domestic" as const, code: "110000" },
    };
    const first = await harness.service.create(input);
    label = "北京采集节点";
    const replay = await harness.service.create(input);

    expect(replay.replayed).toBe(true);
    expect(replay.run.runId).toBe(first.run.runId);
    expect(replay.run.region?.label).toBe("北京市");
    expect(harness.transport.submitCalls).toBe(1);

    await expect(
      harness.service.create({
        ...input,
        region: { scope: "overseas", code: "110000" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
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

  it("canonicalizes only exact provider citation markers and preserves unknown indexes", () => {
    expect(
      sanitizeMonitorAnswerText(
        "甲citeweb_search:1#0乙[citation:12]丙[1]丁[citation:x]",
      ),
    ).toBe("甲〔来源 0〕乙〔来源 12〕丙[1]丁[citation:x]");
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

  it("reuses one consumerTaskId when an ambiguous submission is safely retried", async () => {
    const harness = makeHarness(["deepseek"]);
    harness.transport.submitError = new Error("socket closed after write");
    await expect(harness.service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_UNKNOWN",
    });
    const firstConsumerTaskId =
      harness.transport.submittedPayloads[0].consumerTaskId;
    expect(firstConsumerTaskId).toMatch(/^[A-Za-z0-9]{8,64}$/);
    harness.transport.submitError = null;
    const retried = await harness.service.create(createInput());
    expect(retried.replayed).toBe(false);
    expect(retried.run.status).toBe("submitted");
    expect(harness.transport.submitCalls).toBe(2);
    expect(harness.transport.submittedPayloads[1].consumerTaskId).toBe(
      firstConsumerTaskId,
    );
  });

  it("does not retry a legacy ambiguous reservation without a stored consumerTaskId", async () => {
    const harness = makeHarness(["deepseek"]);
    harness.transport.submitError = new Error("socket closed after write");
    await expect(harness.service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_UNKNOWN",
    });
    const [run] = [...harness.repository.runs.values()];
    run.checkpoint = { items: [] };
    harness.transport.submitError = null;

    const replay = await harness.service.create(createInput());

    expect(replay).toMatchObject({
      replayed: true,
      run: { status: "submission_unknown" },
    });
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("does not retry an ambiguous reservation after credential rotation", async () => {
    const repository = new MemoryMonitorRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    let activeCredential = credential;
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => activeCredential,
      async () => activeCredential,
    );
    transport.submitError = new Error("socket closed after write");
    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_UNKNOWN",
    });
    activeCredential = {
      ...credential,
      id: "credential-2",
      version: 2,
      apiKey: "sk-rotated-monitor-test",
    };
    transport.submitError = null;

    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(transport.submitCalls).toBe(1);
  });

  it("records an explicit provider rejection as failed, never as submission_unknown", async () => {
    const harness = makeHarness(["deepseek"]);
    harness.transport.submitError = new MonitorRemoteError("Token失效", false);
    await expect(harness.service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_REJECTED",
      status: 502,
    });
    const [run] = [...harness.repository.runs.values()];
    expect(run).toMatchObject({
      status: "remote_failed",
      upstreamTaskId: null,
      lastError: "Token失效",
      completedAt: expect.any(Date),
    });
    await expect(harness.service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_REJECTED",
    });
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("treats only a credential rejection without a task identity as definite", () => {
    expect(
      monitorResponseExplicitlyRejectsSubmission({
        success: false,
        message: "Token失效",
      }),
    ).toBe(true);
    expect(
      monitorResponseExplicitlyRejectsSubmission({
        success: false,
        message: "系统繁忙",
      }),
    ).toBe(false);
    expect(
      monitorResponseExplicitlyRejectsSubmission({
        success: false,
        message: "Token失效",
        data: { taskId: TASK_ID },
      }),
    ).toBe(false);
    expect(monitorResponseExplicitlyRejectsSubmission(undefined)).toBe(false);
    expect(monitorResponseExplicitlyRejectsSubmission("")).toBe(false);
    expect(monitorResponseExplicitlyRejectsSubmission({})).toBe(false);
    expect(
      monitorResponseExplicitlyRejectsSubmission({ success: "false" }),
    ).toBe(false);
  });

  it.each([
    {
      name: "credential rejection",
      data: { success: false, message: "Token失效" },
      expectedCode: "MONITOR_SUBMISSION_REJECTED",
      expectedStatus: "remote_failed",
    },
    {
      name: "generic success false",
      data: { success: false, message: "系统繁忙" },
      expectedCode: "MONITOR_SUBMISSION_UNKNOWN",
      expectedStatus: "submission_unknown",
    },
    {
      name: "malformed success response",
      data: {},
      expectedCode: "MONITOR_SUBMISSION_UNKNOWN",
      expectedStatus: "submission_unknown",
    },
  ])(
    "classifies the real Axios transport response: $name",
    async ({ data, expectedCode, expectedStatus }) => {
      vi.spyOn(axios, "request").mockResolvedValue({ status: 200, data });
      const repository = new MemoryMonitorRepository();
      const service = new PresalesMonitorService(
        repository,
        new AxiosMonitorTransport(),
        async () => credential,
        async () => credential,
      );

      await expect(service.create(createInput())).rejects.toMatchObject({
        code: expectedCode,
      });
      expect([...repository.runs.values()][0]).toMatchObject({
        status: expectedStatus,
        upstreamTaskId: null,
      });
      expect(axios.request).toHaveBeenCalledTimes(1);
    },
  );

  it("stops provider tasks through the official PUT endpoint", async () => {
    vi.spyOn(axios, "request").mockResolvedValue({
      status: 200,
      data: { success: true },
    });

    await new AxiosMonitorTransport().stop(TASK_ID, credential);

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        url: expect.stringContaining(`/task/${TASK_ID}/stop`),
        headers: expect.objectContaining({
          Authorization: `Bearer ${credential.apiKey}`,
        }),
      }),
    );
  });

  it("treats an already terminal provider task as an idempotent stop", async () => {
    vi.spyOn(axios, "request").mockResolvedValue({
      status: 409,
      data: { success: false, message: "任务已结束" },
    });

    await expect(
      new AxiosMonitorTransport().stop(TASK_ID, credential),
    ).resolves.toMatchObject({ success: true, alreadyTerminal: true });
  });

  it("treats a bodyless provider 404 as an idempotent stop", async () => {
    vi.spyOn(axios, "request").mockResolvedValue({
      status: 404,
      data: null,
    });

    await expect(
      new AxiosMonitorTransport().stop(TASK_ID, credential),
    ).resolves.toMatchObject({ success: true, alreadyTerminal: true });
  });

  it("stops a known provider task when its local submission write loses a project-delete race", async () => {
    class DeletedDuringSubmitRepository extends MemoryMonitorRepository {
      override async markSubmitted() {
        throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
      }
    }
    const repository = new DeletedDuringSubmitRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => credential,
      async () => credential,
    );

    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "PROJECT_DELETED",
      status: 410,
    });
    expect(transport.stopCalls).toBe(1);
  });

  it("keeps the known provider task ID retryable when compensation stop fails", async () => {
    class FailedLocalWriteRepository extends MemoryMonitorRepository {
      override async markSubmitted() {
        throw new Error("local write failed");
      }
    }
    const repository = new FailedLocalWriteRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    transport.stopError = new Error("provider unavailable");
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => credential,
      async () => credential,
    );

    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_STOP_FAILED",
      status: 502,
    });
    expect([...repository.runs.values()][0]).toMatchObject({
      status: "submission_unknown",
      upstreamTaskId: TASK_ID,
    });
  });

  it("safely reacquires an explicitly rejected reservation only after credential rotation", async () => {
    const repository = new MemoryMonitorRepository();
    const transport = new FakeMonitorTransport(["deepseek"]);
    let activeCredential = credential;
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => activeCredential,
      async (id) => (id === activeCredential.id ? activeCredential : null),
    );
    transport.submitError = new MonitorRemoteError("Token失效", false);
    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "MONITOR_SUBMISSION_REJECTED",
    });
    activeCredential = {
      ...credential,
      id: "credential-2",
      version: 2,
      apiKey: "sk-valid-rotated-monitor-test",
    };
    transport.submitError = null;
    const retried = await service.create(createInput());
    expect(retried).toMatchObject({
      replayed: false,
      run: { status: "submitted" },
    });
    expect(transport.submitCalls).toBe(2);
    expect(repository.runs.size).toBe(1);
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

  it("uses a read-only provider probe so a random-looking invalid key cannot pass readiness", async () => {
    const invalid = await probeDedicatedMonitorCredential({
      env: {
        FRONTMIND_MONITOR_API_KEY: "a".repeat(64),
        FRONTMIND_MONITOR_API_BASE_URL: "https://monitor.frontmind.test/api",
      },
      request: async (input) => {
        expect(input.url).toContain("/task/status/");
        expect(input.url).not.toContain("batch");
        expect(input.apiKey).toBe("a".repeat(64));
        return { status: 200, data: { success: false, message: "Token失效" } };
      },
    });
    expect(invalid).toEqual({
      configured: true,
      authenticated: false,
      ready: false,
      status: "rejected",
    });

    const authenticated = await probeDedicatedMonitorCredential({
      env: {
        FRONTMIND_MONITOR_API_KEY: "provider-issued-dev-monitor-key",
        FRONTMIND_MONITOR_API_BASE_URL: "https://monitor.frontmind.test/api",
      },
      request: async () => ({
        status: 200,
        data: { success: false, message: "任务不存在" },
      }),
    });
    expect(authenticated).toEqual({
      configured: true,
      authenticated: true,
      ready: true,
      status: "authenticated",
    });
  });

  it("fails monitor readiness closed when the read-only probe is unavailable", async () => {
    await expect(
      probeDedicatedMonitorCredential({
        env: {
          FRONTMIND_MONITOR_API_KEY: "provider-issued-dev-monitor-key",
          FRONTMIND_MONITOR_API_BASE_URL: "https://monitor.frontmind.test/api",
        },
        request: async () => {
          throw new Error("network unavailable");
        },
      }),
    ).resolves.toEqual({
      configured: true,
      authenticated: false,
      ready: false,
      status: "unavailable",
    });
  });

  it("caches authenticated read-only probes instead of hitting readiness upstream repeatedly", async () => {
    const env = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-dev-monitor-cache-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-cache.frontmind.test/api",
    };
    let calls = 0;
    const request = async () => {
      calls += 1;
      return {
        status: 200,
        data: { success: false, message: "任务不存在" },
      };
    };
    const first = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 1_000,
    });
    const second = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 2_000,
    });
    expect(first.ready).toBe(true);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("bypasses the readiness cache when a payment preflight requires a fresh probe", async () => {
    const env = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-dev-monitor-fresh-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-fresh.frontmind.test/api",
    };
    let calls = 0;
    const request = async () => {
      calls += 1;
      return calls === 1
        ? {
            status: 200,
            data: { success: false, message: "任务不存在" },
          }
        : {
            status: 200,
            data: { success: false, message: "Token失效" },
          };
    };
    const cached = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 1_000,
    });
    const fresh = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 2_000,
      forceRefresh: true,
    });
    expect(cached).toMatchObject({ authenticated: true, ready: true });
    expect(fresh).toMatchObject({ authenticated: false, ready: false });
    expect(calls).toBe(2);
  });

  it("uses a recent same-binding authentication only when a fresh probe is unavailable", async () => {
    const apiKey = "provider-issued-monitor-recent-attestation-key";
    const env = {
      FRONTMIND_MONITOR_API_KEY: apiKey,
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-recent.frontmind.test/api",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          data: { success: false, message: "任务不存在" },
        };
      }
      throw new Error("temporary provider timeout");
    };

    const authenticated = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 10_000,
    });
    const fallback = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 11_000,
      forceRefresh: true,
    });

    expect(authenticated).toMatchObject({
      authenticated: true,
      ready: true,
      status: "authenticated",
    });
    expect(fallback).toEqual(authenticated);
    expect(calls).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      "[Presales Monitor] credential readiness used recent authentication",
      {
        diagnosticCode: "MONITOR_CREDENTIAL_RECENT_ATTESTATION_FALLBACK",
        probeStatus: "unavailable",
        recentAttestationFallback: true,
      },
    );
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("00000000-0000-4000-8000-000000000000");
    expect(logged).not.toContain(env.FRONTMIND_MONITOR_API_BASE_URL);
  });

  it("caches a recent-attestation fallback for at most fifteen seconds", async () => {
    const env = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-monitor-fallback-cache-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-fallback-cache.frontmind.test/api",
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          data: { success: false, message: "任务不存在" },
        };
      }
      throw new Error("temporary provider timeout");
    };

    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 100_000,
    });
    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 101_000,
      forceRefresh: true,
    });
    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 115_999,
    });
    expect(calls).toBe(2);

    const refreshedFallback = await getDedicatedMonitorCredentialReadiness(
      env,
      {
        request,
        now: () => 116_001,
      },
    );
    expect(refreshedFallback).toMatchObject({ ready: true });
    expect(calls).toBe(3);
  });

  it("does not let fallback caching outlive the thirty-minute attestation", async () => {
    const env = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-monitor-expiring-proof-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-expiring-proof.frontmind.test/api",
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          data: { success: false, message: "任务不存在" },
        };
      }
      throw new Error("temporary provider timeout");
    };
    const authenticatedAt = 1_000_000;

    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => authenticatedAt,
    });
    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => authenticatedAt + 30 * 60_000 - 10_000,
      forceRefresh: true,
    });
    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => authenticatedAt + 30 * 60_000 - 1,
    });
    expect(calls).toBe(2);

    const expired = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => authenticatedAt + 30 * 60_000 + 1,
    });
    expect(expired).toMatchObject({
      authenticated: false,
      ready: false,
      status: "unavailable",
    });
    expect(calls).toBe(3);
  });

  it("clears recent authentication after an explicit credential rejection", async () => {
    const env = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-monitor-rejected-proof-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-rejected-proof.frontmind.test/api",
    };
    let calls = 0;
    const request = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          data: { success: false, message: "任务不存在" },
        };
      }
      if (calls === 2) {
        return {
          status: 401,
          data: { success: false, message: "Token失效" },
        };
      }
      throw new Error("temporary provider timeout");
    };

    await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 200_000,
    });
    const rejected = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 201_000,
      forceRefresh: true,
    });
    const unavailable = await getDedicatedMonitorCredentialReadiness(env, {
      request,
      now: () => 202_000,
      forceRefresh: true,
    });

    expect(rejected.status).toBe("rejected");
    expect(unavailable).toMatchObject({
      authenticated: false,
      ready: false,
      status: "unavailable",
    });
    expect(calls).toBe(3);
  });

  it("does not reuse recent authentication across missing or changed credential bindings", async () => {
    const firstEnv = {
      FRONTMIND_MONITOR_API_KEY: "provider-issued-monitor-first-binding-key",
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-binding.frontmind.test/api",
    };
    const changedKeyEnv = {
      ...firstEnv,
      FRONTMIND_MONITOR_API_KEY: "provider-issued-monitor-second-binding-key",
    };
    const changedBaseEnv = {
      ...firstEnv,
      FRONTMIND_MONITOR_API_BASE_URL:
        "https://monitor-changed-binding.frontmind.test/api",
    };
    const authenticatedRequest = async () => ({
      status: 200,
      data: { success: false, message: "任务不存在" },
    });
    const unavailableRequest = async () => {
      throw new Error("temporary provider timeout");
    };

    await getDedicatedMonitorCredentialReadiness(firstEnv, {
      request: authenticatedRequest,
      now: () => 300_000,
    });
    const changedKey = await getDedicatedMonitorCredentialReadiness(
      changedKeyEnv,
      {
        request: unavailableRequest,
        now: () => 301_000,
        forceRefresh: true,
      },
    );
    expect(changedKey).toMatchObject({ ready: false, status: "unavailable" });

    await getDedicatedMonitorCredentialReadiness(firstEnv, {
      request: authenticatedRequest,
      now: () => 302_000,
      forceRefresh: true,
    });
    const changedBase = await getDedicatedMonitorCredentialReadiness(
      changedBaseEnv,
      {
        request: unavailableRequest,
        now: () => 303_000,
        forceRefresh: true,
      },
    );
    expect(changedBase).toMatchObject({ ready: false, status: "unavailable" });

    await getDedicatedMonitorCredentialReadiness(firstEnv, {
      request: authenticatedRequest,
      now: () => 304_000,
      forceRefresh: true,
    });
    const missing = await getDedicatedMonitorCredentialReadiness(
      {},
      {
        request: unavailableRequest,
        now: () => 305_000,
        forceRefresh: true,
      },
    );
    expect(missing).toMatchObject({ ready: false, status: "missing" });
    const afterMissing = await getDedicatedMonitorCredentialReadiness(
      firstEnv,
      {
        request: unavailableRequest,
        now: () => 306_000,
        forceRefresh: true,
      },
    );
    expect(afterMissing).toMatchObject({
      authenticated: false,
      ready: false,
      status: "unavailable",
    });
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

describe("workspace-owned brand tracking monitor", () => {
  const windowStartedAt = new Date("2025-12-31T16:00:00.000Z");
  const windowEndsAt = new Date("2026-01-31T16:00:00.000Z");

  function workspaceInput(
    userId: number,
    idempotencyKey: string,
    reservationAt = new Date("2026-01-01T00:00:00.000Z"),
  ) {
    return {
      userId,
      question: QUESTION,
      idempotencyKey,
      reservationAt,
      windowStartedAt,
      windowEndsAt,
    };
  }

  it("keeps an authoritative pre-boundary reservation in its original month and replays it after the boundary", async () => {
    const repository = new MemoryMonitorRepository();
    repository.workspaceLimits.set(7, null);
    const transport = new FakeMonitorTransport(["chatgpt"]);
    const reservationAt = new Date("2026-01-31T15:59:59.900Z");
    let clock = new Date(reservationAt);
    const afterBoundary = new Date("2026-01-31T16:00:00.100Z");
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => {
        clock = new Date(afterBoundary);
        return credential;
      },
      async (id) => (id === credential.id ? credential : null),
      () => new Date(clock),
    );
    const idempotencyKey = "brand-tracking-boundary-request-0001";

    const first = await service.createForWorkspace({
      userId: 7,
      question: QUESTION,
      idempotencyKey,
      reservationAt,
      windowStartedAt,
      windowEndsAt,
    });
    expect(first.run.createdAt).toBe(reservationAt.toISOString());
    await expect(
      service.getWorkspaceQuota({ userId: 7, windowStartedAt, windowEndsAt }),
    ).resolves.toEqual({ limit: null, used: 5 });

    const nextWindowEndsAt = new Date("2026-02-28T16:00:00.000Z");
    const replay = await service.createForWorkspace({
      userId: 7,
      question: QUESTION,
      idempotencyKey,
      reservationAt: afterBoundary,
      windowStartedAt: windowEndsAt,
      windowEndsAt: nextWindowEndsAt,
    });
    expect(replay).toMatchObject({
      replayed: true,
      run: {
        runId: first.run.runId,
        createdAt: reservationAt.toISOString(),
      },
    });
    await expect(
      service.getWorkspaceQuota({
        userId: 7,
        windowStartedAt: windowEndsAt,
        windowEndsAt: nextWindowEndsAt,
      }),
    ).resolves.toEqual({ limit: null, used: 0 });
    expect(transport.submitCalls).toBe(1);
  });

  it("moves a rotated-credential rejected retry into the current quota window", async () => {
    const repository = new MemoryMonitorRepository();
    repository.workspaceLimits.set(7, null);
    const transport = new FakeMonitorTransport(["chatgpt"]);
    const rotatedCredential: DecryptedPresalesCredential = {
      ...credential,
      id: "credential-2",
      version: 2,
      fingerprint: "fingerprint-2",
    };
    let activeCredential = credential;
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const service = new PresalesMonitorService(
      repository,
      transport,
      async () => activeCredential,
      async (id) =>
        [credential, rotatedCredential].find((item) => item.id === id) ?? null,
      () => new Date(clock),
    );
    const idempotencyKey = "brand-tracking-rotated-retry-0001";
    transport.submitError = new MonitorRemoteError(
      "credential rejected",
      false,
    );

    await expect(
      service.createForWorkspace({
        userId: 7,
        question: QUESTION,
        idempotencyKey,
        reservationAt: new Date(clock),
        windowStartedAt,
        windowEndsAt,
      }),
    ).rejects.toMatchObject({ code: "MONITOR_SUBMISSION_REJECTED" });
    const rejectedRun = [...repository.runs.values()][0];
    expect(rejectedRun).toMatchObject({
      status: "remote_failed",
      upstreamTaskId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const currentWindowStartedAt = windowEndsAt;
    const currentWindowEndsAt = new Date("2026-02-28T16:00:00.000Z");
    const currentReservationAt = new Date("2026-02-01T00:00:00.000Z");
    activeCredential = rotatedCredential;
    clock = new Date(currentReservationAt);
    transport.submitError = null;
    const submitCallsBeforeRetry = transport.submitCalls;

    const retried = await service.createForWorkspace({
      userId: 7,
      question: QUESTION,
      idempotencyKey,
      reservationAt: currentReservationAt,
      windowStartedAt: currentWindowStartedAt,
      windowEndsAt: currentWindowEndsAt,
    });
    expect(retried).toMatchObject({
      replayed: false,
      run: {
        runId: rejectedRun.id,
        createdAt: currentReservationAt.toISOString(),
        status: "submitted",
      },
    });
    expect(transport.submitCalls).toBe(submitCallsBeforeRetry + 1);
    await expect(
      service.getWorkspaceQuota({
        userId: 7,
        windowStartedAt,
        windowEndsAt,
      }),
    ).resolves.toEqual({ limit: null, used: 0 });
    await expect(
      service.getWorkspaceQuota({
        userId: 7,
        windowStartedAt: currentWindowStartedAt,
        windowEndsAt: currentWindowEndsAt,
      }),
    ).resolves.toEqual({ limit: null, used: 5 });
  });

  it("rejects a workspace reservation timestamp outside its quota window", async () => {
    const harness = makeHarness(["chatgpt"]);
    harness.repository.workspaceLimits.set(7, null);

    await expect(
      harness.service.createForWorkspace({
        ...workspaceInput(7, "brand-tracking-invalid-window-0001"),
        reservationAt: windowEndsAt,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(harness.transport.submitCalls).toBe(0);
  });

  it("treats a null monthly limit as unlimited and counts expected items", async () => {
    const harness = makeHarness(["chatgpt"]);
    harness.repository.workspaceLimits.set(7, null);

    await harness.service.createForWorkspace(
      workspaceInput(7, "brand-tracking-request-0001"),
    );
    harness.advance(1);
    const second = await harness.service.createForWorkspace(
      workspaceInput(
        7,
        "brand-tracking-request-0002",
        new Date("2026-01-01T00:00:00.001Z"),
      ),
    );

    await expect(
      harness.service.getWorkspaceQuota({
        userId: 7,
        windowStartedAt,
        windowEndsAt,
      }),
    ).resolves.toEqual({ limit: null, used: 10 });
    await expect(harness.service.latestForWorkspace(7)).resolves.toMatchObject({
      runId: second.run.runId,
      platforms: ["chatgpt"],
      expectedItems: 5,
    });
    expect(harness.transport.submitCalls).toBe(2);
  });

  it("rejects before the provider POST when fewer than five items remain", async () => {
    const harness = makeHarness(["chatgpt"]);
    harness.repository.workspaceLimits.set(7, 4);

    await expect(
      harness.service.createForWorkspace(
        workspaceInput(7, "brand-tracking-request-0003"),
      ),
    ).rejects.toMatchObject({
      code: "MONITOR_QUOTA_EXCEEDED",
      status: 429,
    });
    expect(harness.transport.submitCalls).toBe(0);
  });

  it("replays the same reservation after a quota decrease without charging or submitting twice", async () => {
    const harness = makeHarness(["chatgpt"]);
    harness.repository.workspaceLimits.set(7, 5);
    const input = workspaceInput(7, "brand-tracking-request-0004");

    const first = await harness.service.createForWorkspace(input);
    harness.repository.workspaceLimits.set(7, 0);
    const replay = await harness.service.createForWorkspace(input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      run: { runId: first.run.runId },
    });
    await expect(
      harness.service.getWorkspaceQuota({
        userId: 7,
        windowStartedAt,
        windowEndsAt,
      }),
    ).resolves.toEqual({ limit: 0, used: 5 });
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("returns NOT_FOUND for a run owned by another workspace", async () => {
    const harness = makeHarness(["chatgpt"]);
    harness.repository.workspaceLimits.set(7, null);
    const created = await harness.service.createForWorkspace(
      workspaceInput(7, "brand-tracking-request-0005"),
    );

    await expect(
      harness.service.getForWorkspace(8, created.run.runId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      harness.service.resultForWorkspace(8, created.run.runId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
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

  it("preserves v1.19 field presence and exposes only the selected public fields", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create({
      ...createInput(),
      monitorKeyword: "华润医药",
      screenshot: 1,
    });
    const payload = resultResponse(["deepseek"]);
    const first = payload.data.subTaskList[0] as Record<string, unknown>;
    first.answerContent = "回答结论[citation:0]，冲突引用[citation:7]。";
    first.citationList = [
      {
        index: 0,
        title: "实际引用",
        url: "https://citation.invalid/actual",
        source: "行业媒体",
        publishTime: "2026-08-20",
      },
      { index: 7, title: "冲突 A", url: "https://citation.invalid/a" },
      { index: 7, title: "冲突 B", url: "https://citation.invalid/b" },
    ];
    first.referenceList = [
      {
        index: 0,
        name: "完整参考来源",
        url: "https://reference.invalid/report",
        site: "参考站点",
        summary: "来源摘要",
        publishTime: "2026-08-19T12:00:00Z",
        icon: "https://private.invalid/icon.ico",
      },
    ];
    first.searchKeywords = Array.from(
      { length: 60 },
      (_, index) => `检索词 ${index + 1}`,
    );
    first.recommendedQuestions = Array.from(
      { length: 25 },
      (_, index) => `推荐追问 ${index + 1}`,
    );
    first.mentionPosition = 2;
    first.mentionContext = "华润医药拥有全国性医药流通网络。";
    first.sentiment = "positive";
    first.categoryRanking = {
      categoryName: "医药流通企业",
      rank: 2,
      allRankings: [{ name: "不应公开的竞品", rank: 1 }],
    };
    first.keywordEvaluations = Array.from({ length: 110 }, (_, index) => ({
      keyword: `评价词 ${index + 1}`,
      nature: index % 2 === 0 ? "positive" : "neutral",
      context: "评价上下文",
    }));
    first.pageScreenshot =
      "https://img.molizhishu.com/signed/render?id=answer-1&token=secret";
    first.goods = [{ name: "不应公开的商品" }];
    first.videoList = [{ url: "https://private.invalid/video.mp4" }];
    first.competitorRankings = [{ name: "不应公开的竞品" }];
    first.amount = 99;
    first.proxyIp = "10.0.0.1";

    const second = payload.data.subTaskList[1] as Record<string, unknown>;
    delete second.citationList;
    delete second.referenceList;
    second.mentionPosition = null;
    second.sentiment = null;
    second.categoryRanking = null;

    const third = payload.data.subTaskList[2] as Record<string, unknown>;
    third.citationList = [];
    third.referenceList = [];
    harness.transport.resultValues = [payload];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    const record = result.records?.[0];

    expect(result).toMatchObject({
      monitorKeyword: "华润医药",
      screenshot: 1,
    });
    expect(record).toMatchObject({
      answerText: "回答结论〔来源 0〕，冲突引用〔来源 7〕。",
      mentionPosition: 2,
      mentionContext: "华润医药拥有全国性医药流通网络。",
      sentiment: "positive",
      categoryRanking: { categoryName: "医药流通企业", rank: 2 },
      screenshot: { available: true },
    });
    expect(record?.citationList).toEqual([
      {
        index: 0,
        title: "实际引用",
        url: "https://citation.invalid/actual",
        site: "行业媒体",
        publishTime: "2026-08-20",
      },
      { index: 7, title: "冲突 A", url: "https://citation.invalid/a" },
      { index: 7, title: "冲突 B", url: "https://citation.invalid/b" },
    ]);
    expect(record?.referenceList).toEqual([
      {
        index: 0,
        title: "完整参考来源",
        url: "https://reference.invalid/report",
        site: "参考站点",
        summary: "来源摘要",
        publishTime: "2026-08-19T12:00:00Z",
      },
    ]);
    expect(record?.searchKeywords).toHaveLength(50);
    expect(record?.recommendedQuestions).toHaveLength(20);
    expect(record?.keywordEvaluations).toHaveLength(100);
    expect(result.records?.[1]).not.toHaveProperty("citationList");
    expect(result.records?.[1]).not.toHaveProperty("referenceList");
    expect(result.records?.[1]).toMatchObject({
      mentionPosition: null,
      sentiment: null,
      categoryRanking: null,
    });
    expect(result.records?.[2]).toMatchObject({
      citationList: [],
      referenceList: [],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("consumerTaskId");
    expect(serialized).not.toContain("img.molizhishu.com");
    expect(serialized).not.toContain("allRankings");
    expect(serialized).not.toContain("不应公开的商品");
    expect(serialized).not.toContain("不应公开的竞品");
    expect(serialized).not.toContain("proxyIp");
    expect(serialized).not.toContain("private.invalid");
  });

  it("lets later explicit empty arrays and null metrics replace checkpoint values", async () => {
    const harness = makeHarness(["deepseek"]);
    const created = await harness.service.create({
      ...createInput(),
      screenshot: 1,
    });
    const first = resultResponse(["deepseek"]);
    first.data.status = "processing";
    const firstChild = first.data.subTaskList[0] as Record<string, unknown>;
    firstChild.citationList = [
      { index: 0, title: "旧引用", url: "https://citation.invalid/old" },
    ];
    firstChild.referenceList = [
      { index: 0, title: "旧参考", url: "https://reference.invalid/old" },
    ];
    firstChild.searchKeywords = ["旧检索词"];
    firstChild.recommendedQuestions = ["旧追问"];
    firstChild.mentionPosition = 3;
    firstChild.sentiment = "positive";
    firstChild.categoryRanking = { categoryName: "旧类目", rank: 3 };
    firstChild.keywordEvaluations = [
      { keyword: "旧评价", nature: "positive", context: "旧上下文" },
    ];
    firstChild.pageScreenshot =
      "https://img.molizhishu.com/signed/render?id=stable";
    for (const child of first.data.subTaskList.slice(1)) {
      child.status = "pending";
      child.answerContent = "";
      delete (child as Partial<typeof child>).time;
    }

    const second = resultResponse(["deepseek"]);
    const secondChild = second.data.subTaskList[0] as Record<string, unknown>;
    secondChild.citationList = [];
    secondChild.referenceList = [];
    secondChild.searchKeywords = [];
    secondChild.recommendedQuestions = [];
    secondChild.mentionPosition = null;
    secondChild.sentiment = null;
    secondChild.categoryRanking = null;
    secondChild.keywordEvaluations = [];
    delete secondChild.pageScreenshot;
    harness.transport.statusValues = [
      statusResponse(5, 1, 0, "processing"),
      statusResponse(5),
    ];
    harness.transport.resultValues = [first, second];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const partial = await harness.service.result(created.run.runId);
    expect(partial.records?.[0]).toMatchObject({
      citationList: [expect.objectContaining({ title: "旧引用" })],
      sentiment: "positive",
      screenshot: { available: true },
    });

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const completed = await harness.service.result(created.run.runId);
    expect(completed.records?.[0]).toMatchObject({
      citationList: [],
      referenceList: [],
      searchKeywords: [],
      recommendedQuestions: [],
      mentionPosition: null,
      sentiment: null,
      categoryRanking: null,
      keywordEvaluations: [],
      screenshot: { available: true },
    });
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
      site: "实际引用站点",
      url: "https://citation.invalid/actual-only",
      summary: "实际引用摘要",
    });
    expect(record?.sources).toContainEqual({
      index: 1,
      title: "检索参考来源",
      site: "检索站点",
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
    expect(record?.answerText).toContain("〔来源 9〕");
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

  it("returns ChatGPT under the public chatgpt contract", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const result = await harness.service.result(created.run.runId);
    expect(result.platforms).toEqual(["chatgpt"]);
    expect(result.records).toHaveLength(5);
    expect(
      result.records?.every((record) => record.platform === "chatgpt"),
    ).toBe(true);
    expect(JSON.stringify(result)).toContain('"platform":"chatgpt"');
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

  it("recovers failed child slots on the same task until all answers succeed", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.transport.statusValues = [
      statusResponse(5, 3, 2, "partial_completed"),
      statusResponse(5, 4, 0, "processing"),
      statusResponse(5, 5, 0, "completed"),
    ];
    harness.transport.resultValues = [
      recoveringResult("chatgpt", 3, 2),
      recoveringResult("chatgpt", 4, 0, "processing"),
      recoveringResult("chatgpt", 5, 0, "completed"),
    ];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await expect(
      harness.service.result(created.run.runId),
    ).resolves.toMatchObject({
      status: "polling",
      completedItems: 3,
      failedItems: 2,
    });
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await expect(
      harness.service.result(created.run.runId),
    ).resolves.toMatchObject({
      status: "polling",
      completedItems: 4,
      failedItems: 0,
    });
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const completed = await harness.service.result(created.run.runId);
    expect(completed).toMatchObject({
      status: "completed",
      completedItems: 5,
      failedItems: 0,
      complete: true,
    });
    expect(completed.records).toHaveLength(5);
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("recovers a one-success four-failure snapshot without a second POST", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.transport.statusValues = [
      statusResponse(5, 1, 4, "partial_completed"),
      statusResponse(5, 5, 0, "completed"),
    ];
    harness.transport.resultValues = [
      recoveringResult("chatgpt", 1, 4),
      recoveringResult("chatgpt", 5, 0, "completed"),
    ];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "polling",
    );
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "completed",
    );
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("keeps completed answers monotonic while other failed slots recover", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create({
      ...createInput(["chatgpt"]),
      screenshot: 1,
    });
    const first = recoveringResult("chatgpt", 1, 4);
    const second = recoveringResult("chatgpt", 2, 3);
    second.data.subTaskList[0].status = "failed";
    second.data.subTaskList[0].answerContent = "";
    second.data.subTaskList[0].errorMessage = "late stale failure";
    second.data.subTaskList[0].pageScreenshot =
      "https://aigeo-jp.oss-ap-northeast-1.aliyuncs.com/signed/answer.png?token=late";
    harness.transport.statusValues = [
      statusResponse(5, 1, 4, "partial_completed"),
      statusResponse(5, 1, 4, "partial_completed"),
    ];
    harness.transport.resultValues = [first, second];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await harness.service.result(created.run.runId);
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    const recovering = await harness.service.result(created.run.runId);

    expect(recovering).toMatchObject({
      status: "polling",
      completedItems: 2,
      failedItems: 3,
    });
    expect(recovering.records?.[0]).toMatchObject({
      status: "completed",
      answerText: "第 1 次纯文字答案",
      screenshot: { available: true },
    });
    expect(recovering.records?.[0]).not.toHaveProperty("error");
  });

  it("reconciles one prematurely terminal historical run without resubmitting", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.transport.statusValues = [
      statusResponse(5, 3, 2, "partial_completed"),
      statusResponse(5, 5, 0, "completed"),
    ];
    harness.transport.resultValues = [
      recoveringResult("chatgpt", 3, 2),
      recoveringResult("chatgpt", 5, 0, "completed"),
    ];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await harness.service.result(created.run.runId);
    const frozen = harness.repository.runs.get(created.run.runId)!;
    Object.assign(frozen, {
      status: "completed",
      remoteStatus: "partial_completed",
      completedAt: new Date(frozen.submittedAt!.getTime() + 30_000),
      finalResult: { complete: false, partial: true, records: [] },
      terminalSnapshotHash: "a".repeat(64),
      terminalStableCount: 2,
      lastError: "stale terminal error",
    });
    harness.advance(6 * 60 * 60_000);

    const recovered = await harness.service.result(created.run.runId);
    expect(recovered).toMatchObject({
      status: "completed",
      completedItems: 5,
      failedItems: 0,
    });
    expect(harness.transport.submitCalls).toBe(1);
    expect(harness.transport.statusCalls).toBe(2);

    await harness.service.result(created.run.runId);
    expect(harness.transport.statusCalls).toBe(2);
  });

  it("does not reopen a historical terminal after its credential version changes", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.transport.statusValues = [
      statusResponse(5, 3, 2, "partial_completed"),
    ];
    harness.transport.resultValues = [recoveringResult("chatgpt", 3, 2)];
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await harness.service.result(created.run.runId);
    const frozen = harness.repository.runs.get(created.run.runId)!;
    const frozenResult = { complete: false, partial: true, records: [] };
    Object.assign(frozen, {
      status: "completed",
      remoteStatus: "partial_completed",
      completedAt: new Date(frozen.submittedAt!.getTime() + 30_000),
      finalResult: frozenResult,
    });
    const rotatedCredential = { ...credential, version: 2 };
    const recoveryService = new PresalesMonitorService(
      harness.repository,
      harness.transport,
      async () => rotatedCredential,
      async () => rotatedCredential,
      () => new Date("2026-01-01T07:00:00Z"),
    );

    const unchanged = await recoveryService.result(created.run.runId);

    expect(unchanged.status).toBe("completed");
    expect(harness.repository.runs.get(created.run.runId)?.finalResult).toBe(
      frozenResult,
    );
    expect(harness.transport.statusCalls).toBe(1);
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("does not reopen an explicitly stopped provider task", async () => {
    const harness = makeHarness(["chatgpt"]);
    const created = await harness.service.create(createInput(["chatgpt"]));
    harness.transport.statusValues = [
      statusResponse(5, 3, 2, "stopped"),
      statusResponse(5, 3, 2, "stopped"),
    ];
    const stopped = recoveringResult("chatgpt", 3, 2);
    stopped.data.status = "stopped";
    harness.transport.resultValues = [stopped, stopped];

    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "polling",
    );
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    expect((await harness.service.result(created.run.runId)).status).toBe(
      "partial_review_required",
    );
    harness.advance(MONITOR_POLL_INTERVAL_MS);
    await harness.service.result(created.run.runId);

    expect(harness.transport.statusCalls).toBe(2);
    expect(harness.transport.submitCalls).toBe(1);
  });

  it("keeps a soft terminal polling until the recovery window expires", async () => {
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
    harness.advance(6 * 60 * 60_000);
    const second = await harness.service.result(created.run.runId);
    expect(second.status).toBe("partial_review_required");
    expect(second).toMatchObject({ completedItems: 4, failedItems: 1 });
    expect(second.records).toHaveLength(5);
    expect(second.records?.[4]).toMatchObject({
      status: "failed",
      error: "自动补采窗口内未返回有效回答",
    });
    expect(second.records?.[4]).not.toHaveProperty("answerText");
  });
});

describe.runIf(WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
  "physical project monitor purge",
  () => {
    async function submittedProjectRun() {
      const repository = new MemoryMonitorRepository();
      const reserved = await repository.reserve({
        projectId: "project-20260728-0001",
        idempotencyKeyHash: "a".repeat(64),
        requestHash: "b".repeat(64),
        credential,
        question: QUESTION,
        platforms: ["deepseek"],
        expectedItems: 5,
        now: new Date("2026-01-01T00:00:00Z"),
      });
      return repository.markSubmitted(reserved.run.id, {
        upstreamTaskId: TASK_ID,
        submitTotalItems: 5,
        initialSubtaskIds: submittedChildren(["deepseek"]).map(
          (item) => item.subTaskId,
        ),
        subtaskScopes: {},
        now: new Date("2026-01-01T00:00:01Z"),
      });
    }

    it("stops every known provider task before physically deleting its local row", async () => {
      const rows = [await submittedProjectRun()];
      const executor = monitorPurgeExecutor(rows);
      const transport = new FakeMonitorTransport(["deepseek"]);

      await expect(
        purgePresalesProjectMonitorRuns(
          { projectId: "project-20260728-0001" },
          {
            executor,
            transport,
            credentialById: async () => credential,
            now: () => new Date("2026-01-01T00:03:00Z"),
          },
        ),
      ).resolves.toEqual({ deletedRuns: 1, pendingRuns: 0 });
      expect(transport.stopCalls).toBe(1);
      expect(rows).toHaveLength(0);
    });

    it("keeps the local retry target when provider stop fails", async () => {
      const rows = [await submittedProjectRun()];
      const executor = monitorPurgeExecutor(rows);
      const transport = new FakeMonitorTransport(["deepseek"]);
      transport.stopError = new Error("provider unavailable");

      await expect(
        purgePresalesProjectMonitorRuns(
          { projectId: "project-20260728-0001" },
          {
            executor,
            transport,
            credentialById: async () => credential,
            now: () => new Date("2026-01-01T00:03:00Z"),
          },
        ),
      ).rejects.toMatchObject({ code: "MONITOR_STOP_FAILED", status: 502 });
      expect(rows).toHaveLength(1);
    });

    it("keeps a fresh no-ID submission pending until its request window closes", async () => {
      const repository = new MemoryMonitorRepository();
      const reserved = await repository.reserve({
        projectId: "project-20260728-0001",
        idempotencyKeyHash: "c".repeat(64),
        requestHash: "d".repeat(64),
        credential,
        question: QUESTION,
        platforms: ["deepseek"],
        expectedItems: 5,
        now: new Date("2026-01-01T00:00:00Z"),
      });
      const rows = [reserved.run];
      const executor = monitorPurgeExecutor(rows);

      await expect(
        purgePresalesProjectMonitorRuns(
          { projectId: "project-20260728-0001" },
          {
            executor,
            transport: new FakeMonitorTransport(["deepseek"]),
            credentialById: async () => credential,
            now: () => new Date("2026-01-01T00:01:00Z"),
          },
        ),
      ).resolves.toEqual({ deletedRuns: 0, pendingRuns: 1 });
      expect(rows).toHaveLength(1);
    });
  },
);

describe.runIf(!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED)(
  "Wave D0 project monitor deletion gate",
  () => {
    it("rejects before resolving a database or provider transport", async () => {
      await expect(
        purgePresalesProjectMonitorRuns({
          projectId: "project-20260728-0001",
        }),
      ).rejects.toThrow("physical deletion is disabled");
    });
  },
);

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

  it("serves region choices and proxies an available screenshot without exposing its URL", async () => {
    const screenshotFetch = vi.fn(async () => ({
      contentType: "image/png" as const,
      data: Buffer.from("proxied-screenshot"),
    }));
    const harness = makeHarness(["deepseek"], {
      regionCatalog: {
        async list(scope) {
          return [
            { scope, code: "110000", label: "北京市" },
            { scope, code: "310000", label: "上海市" },
          ];
        },
      },
      screenshotTransport: { fetch: screenshotFetch },
    });
    const payload = resultResponse(["deepseek"]);
    payload.data.subTaskList[0].pageScreenshot =
      "https://img.molizhishu.com/signed/render?id=answer-1&token=private";
    harness.transport.resultValues = [payload];
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(harness.service),
    );
    try {
      const regionsResponse = await fetch(`${baseUrl}/regions?scope=domestic`);
      expect(regionsResponse.status).toBe(200);
      expect(regionsResponse.headers.get("cache-control")).toBe("no-store");
      await expect(regionsResponse.json()).resolves.toEqual({
        scope: "domestic",
        regions: [
          { code: "110000", label: "北京市" },
          { code: "310000", label: "上海市" },
        ],
      });

      const createResponse = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createInput(), screenshot: 1 }),
      });
      const created = (await createResponse.json()) as any;
      harness.advance(MONITOR_POLL_INTERVAL_MS);
      const resultResponse = await fetch(
        `${baseUrl}/${created.run.runId}/result`,
      );
      const resultBody = (await resultResponse.json()) as any;
      const record = resultBody.run.records[0];
      expect(record.screenshot).toEqual({ available: true });
      expect(JSON.stringify(resultBody)).not.toContain("img.molizhishu.com");
      expect(JSON.stringify(resultBody)).not.toContain("consumerTaskId");

      const screenshotResponse = await fetch(
        `${baseUrl}/${created.run.runId}/records/${record.recordId}/screenshot`,
      );
      expect(screenshotResponse.status).toBe(200);
      expect(screenshotResponse.headers.get("content-type")).toContain(
        "image/png",
      );
      expect(screenshotResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(screenshotResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      await expect(screenshotResponse.text()).resolves.toBe(
        "proxied-screenshot",
      );
      expect(screenshotFetch).toHaveBeenCalledWith(
        "https://img.molizhishu.com/signed/render?id=answer-1&token=private",
      );

      const unavailable = await fetch(
        `${baseUrl}/${created.run.runId}/records/mr_${"0".repeat(24)}/screenshot`,
      );
      expect(unavailable.status).toBe(404);
      expect(screenshotFetch).toHaveBeenCalledTimes(1);
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

  it("accepts ChatGPT while rejecting browser-controlled execution fields and unknown platforms", async () => {
    const harness = makeHarness(["chatgpt"]);
    const { server, baseUrl } = await listen(
      createPresalesMonitorRouter(harness.service),
    );
    try {
      const accepted = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createInput(["chatgpt"])),
      });
      expect(accepted.status).toBe(201);
      await expect(accepted.json()).resolves.toMatchObject({
        run: {
          platforms: ["chatgpt"],
          repeatPerPlatform: 5,
          expectedItems: 5,
        },
      });

      for (const body of [
        { ...createInput(), mode: "standard" },
        { ...createInput(), screenshot: 2 },
        { ...createInput(), repeat: 1 },
        { ...createInput(), platforms: ["unknown"] },
      ]) {
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(harness.transport.submitCalls).toBe(1);
    } finally {
      await close(server);
    }
  });
});
