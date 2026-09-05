import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createTask,
  createKnowledgeBaseTurnTask,
  cancelKnowledgeBaseTurnAttachments,
  discardManagedUploadIntent,
  discardUnboundUpload,
  reserveKnowledgeBaseStart,
  reserveKnowledgeBaseTurnWithAttachments,
  resumeKnowledgeBaseTurnAttachments,
  stageKnowledgeBaseTurnAttachment,
  createResponseLogicTask,
  ResponseLogicTaskStartError,
  DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
  FILE_UPLOAD_IDLE_TIMEOUT_MS,
  FILE_UPLOAD_SERVER_RESPONSE_TIMEOUT_MS,
  getModelDisplayName,
  listManagedUploadsForKnowledgeBase,
  MANAGED_UPLOAD_BUSY_RECOVERY_TIMEOUT_MS,
  MANAGED_UPLOAD_PROCESSING_TIMEOUT_MS,
  MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS,
  recoverDiscoveredManagedUpload,
  recoverManagedUpload,
  retrieveTask,
  sanitizeBrandText,
  type FileUploadStageEvent,
  type ManagedUploadHandle,
  uploadChatLocalAsset,
  uploadFile,
  uploadKnowledgeBaseLocalAsset,
  uploadFileToUrl,
  withoutProviderTaskNavigationUrls,
} from "./frontmind-api";
import { KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS } from "@shared/knowledge-base-local-upload";
import {
  SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS,
  SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
} from "@shared/siteops-composer-local-upload";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sanitizeBrandText", () => {
  it("covers underscored codes, hyphenated identifiers, paths and domains", () => {
    const visible = sanitizeBrandText(
      "MANUS_V2_TASK_ERROR manus-v2 /__manus__/ https://open.manus.ai/task/1",
    );

    expect(visible).not.toMatch(/manus/iu);
    expect(visible).toContain("FrontMind");
    expect(visible).toContain("https://frontmind.net");
  });

  it("rebrands alternate provider copy before it reaches the interface", () => {
    const sourceBrand = ["Jeno", "va"].join("");
    const visible = sanitizeBrandText(
      `独立 ${sourceBrand} 凭证 · ${sourceBrand.toLowerCase()} Brand Tracker · https://api.${sourceBrand.toLowerCase()}.ai`,
    );

    expect(visible).toBe(
      "独立 FrontMind 凭证 · FrontMind Brand Tracker · https://api.frontmind.ai",
    );
    expect(visible.toLowerCase()).not.toContain(sourceBrand.toLowerCase());
    expect(getModelDisplayName(`${sourceBrand} Pro`)).toBe("FrontMind Pro");
  });

  it("removes knowledge-base protocol envelopes from visible assistant text", () => {
    const visible = sanitizeBrandText(
      [
        "请确认当前节点。",
        '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","revision":3} -->',
        "确认后继续。",
      ].join("\n"),
    );

    expect(visible).toContain("请确认当前节点。");
    expect(visible).toContain("确认后继续。");
    expect(visible).not.toContain("FRONTMIND_KB_PROGRESS");
    expect(visible).not.toContain('"revision":3');
  });

  it("hides bare protocol JSON from real knowledge-base output", () => {
    const visible = sanitizeBrandText(
      [
        "## 1.1 企业定位",
        "企业定位正文。",
        JSON.stringify({
          kind: "frontmind.knowledge-base.manifest",
          schemaVersion: 1,
          leaves: [{ id: "1.1", title: "企业定位" }],
        }),
        JSON.stringify({
          kind: "frontmind.workflow-state",
          schemaVersion: 1,
          currentLeafId: "1.1",
        }),
        JSON.stringify({
          kind: "frontmind.knowledge-base.presentation",
          schemaVersion: 1,
          leafId: "1.1",
        }),
      ].join("\n"),
    );

    expect(visible).toContain("企业定位正文。");
    expect(visible).not.toContain("frontmind.knowledge-base.manifest");
    expect(visible).not.toContain("frontmind.workflow-state");
    expect(visible).not.toContain("frontmind.knowledge-base.presentation");
  });

  it("keeps the source provider name out of production client source", () => {
    const sourceBrand = ["ma", "nus"].join("");
    const sourceRoot = resolve(process.cwd(), "client/src");
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const pathname = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(pathname);
          continue;
        }
        if (
          !/\.(?:ts|tsx)$/.test(entry.name) ||
          /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
        ) {
          continue;
        }
        if (
          readFileSync(pathname, "utf8")
            .toLowerCase()
            .includes(sourceBrand.toLowerCase())
        ) {
          offenders.push(pathname.slice(sourceRoot.length + 1));
        }
      }
    };

    visit(sourceRoot);
    expect(offenders).toEqual([]);
  });
});

describe("provider task navigation boundary", () => {
  it("removes top-level and metadata task/share URLs from client task data", () => {
    const sanitized = withoutProviderTaskNavigationUrls({
      id: "task-safe",
      task_url: "https://provider.example/task/1",
      shareUrl: "https://provider.example/share/1",
      metadata: {
        credit_usage: "3",
        taskUrl: "https://provider.example/task/1",
        share_url: "https://provider.example/share/1",
      },
    });

    expect(sanitized).toEqual({
      id: "task-safe",
      metadata: { credit_usage: "3" },
    });
  });
});

describe("createResponseLogicTask", () => {
  it("sends MIME metadata only to the authenticated response-logic route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: {
          id: "task-response-logic",
          operationRevision: 4,
          status: "running",
          output: [],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createResponseLogicTask(
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "请核验本轮资料。" },
            {
              type: "input_file",
              file_id: "file-image",
              filename: "evidence.png",
              mime_type: "image/png",
            },
          ],
        },
      ],
      {
        conversationId: "conv-response-logic",
        operationRevision: 1,
        questionId: "question-1",
        groupId: "group-1",
        groupTitle: "产品场景",
        question: "如何回答？",
        intent: "核验事实",
        summary: "形成应答逻辑",
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
        onTaskStarted: vi.fn(),
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/response-logic/start",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toEqual([
      {
        file_id: "file-image",
        filename: "evidence.png",
        mime_type: "image/png",
      },
    ]);
    expect(body).not.toHaveProperty("onTaskStarted");
    expect(body).not.toHaveProperty("onTaskStartFailed");
  });

  it("does not dispatch until the latest persisted record revision is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await createResponseLogicTask([], {
      conversationId: "conv-response-logic",
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验事实",
      summary: "形成应答逻辑",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "RESPONSE_LOGIC_RECORD_NOT_READY",
      retryable: true,
      resetRequired: false,
      stage: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the structured start-failure envelope for the dedicated UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error: {
            code: "RESPONSE_LOGIC_UPSTREAM_UNAVAILABLE",
            message: "上游服务暂时不可用，任务尚未创建，请稍后重试",
            retryable: true,
            resetRequired: false,
            stage: "file_upload_intent",
            incidentId: "incident-safe-retry",
            retryAfterMs: 1_500,
          },
        }),
      }),
    );

    const error = await createResponseLogicTask([], {
      conversationId: "conv-response-logic",
      operationRevision: 1,
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验事实",
      summary: "形成应答逻辑",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ResponseLogicTaskStartError);
    expect(error).toMatchObject({
      status: 503,
      code: "RESPONSE_LOGIC_UPSTREAM_UNAVAILABLE",
      retryable: true,
      resetRequired: false,
      stage: "file_upload_intent",
      incidentId: "incident-safe-retry",
      retryAfterMs: 1_500,
    });
  });

  it("accepts a legacy message-only failure without inventing retryability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "当前问题尚未通过审核" }),
      }),
    );

    const error = await createResponseLogicTask([], {
      conversationId: "conv-response-logic",
      operationRevision: 1,
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验事实",
      summary: "形成应答逻辑",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      status: 422,
      code: "RESPONSE_LOGIC_START_FAILED",
      message: "当前问题尚未通过审核",
      retryable: false,
      resetRequired: false,
      stage: "response",
    });
  });

  it("normalizes an unknown server stage instead of trusting an arbitrary value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({
          error: {
            code: "RESPONSE_LOGIC_START_OUTCOME_UNKNOWN",
            message: "任务创建结果无法确认",
            retryable: false,
            resetRequired: true,
            stage: "unexpected_internal_stage",
            incidentId: "incident-unknown",
          },
        }),
      }),
    );

    const error = await createResponseLogicTask([], {
      conversationId: "conv-response-logic",
      operationRevision: 1,
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验事实",
      summary: "形成应答逻辑",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "RESPONSE_LOGIC_START_OUTCOME_UNKNOWN",
      stage: "response",
      resetRequired: true,
    });
  });

  it("preserves a reset-required post-dispatch task binding failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => ({
          error: {
            code: "RESPONSE_LOGIC_TASK_BINDING_PENDING",
            message: "上游任务已创建，但本地绑定未完成；请申请重置后重新开始",
            retryable: false,
            resetRequired: true,
            stage: "task_binding",
            incidentId: "incident-binding",
          },
        }),
      }),
    );

    const error = await createResponseLogicTask([], {
      conversationId: "conv-response-logic",
      operationRevision: 2,
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验事实",
      summary: "形成应答逻辑",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      code: "RESPONSE_LOGIC_TASK_BINDING_PENDING",
      retryable: false,
      resetRequired: true,
      stage: "task_binding",
      incidentId: "incident-binding",
    });
  });
});

describe("createKnowledgeBaseTurnTask", () => {
  it("preserves the server error code and Retry-After metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "2" : null,
      },
      json: async () => ({
        error: {
          code: "UPLOAD_OPERATION_CONFLICT",
          message: "附件坐标冲突",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveKnowledgeBaseTurnWithAttachments([], {
        conversationId: "conv-kb",
        clientRequestId: "request-files",
        expectedResetRevision: 4,
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
        attachmentManifest: [
          {
            itemId: "request-files:1",
            ordinal: 1,
            total: 1,
            filename: "facts.pdf",
            sizeBytes: 12,
            mimeType: "application/pdf",
            lastModified: 10,
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "UPLOAD_OPERATION_CONFLICT",
      retryAfter: "2",
      retryAfterMs: 2_000,
    });
  });

  it("retries a disconnected turn request with the exact same logical body", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "accepted-turn", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask(
      [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "stable-request-id",
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(created).resolves.toMatchObject({ id: "accepted-turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      conversationId: "conv-kb",
      clientRequestId: "stable-request-id",
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      expectedPresentationKey: "presentation-5",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "userMessage",
    );
  });

  it("replays an ordinary attachment turn without legacy takeover flags", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "legacy-turn", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const created = createKnowledgeBaseTurnTask(
      [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: "replacement-file",
              filename: "facts.pdf",
            },
          ],
        },
      ],
      {
        conversationId: "conv-kb",
        clientRequestId: "legacy-request",
        expectedRevision: 5,
        expectedLeafId: "1.6",
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(created).resolves.toMatchObject({ id: "legacy-turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toEqual([
      { file_id: "replacement-file", filename: "facts.pdf" },
    ]);
    expect(body).not.toHaveProperty("resumeLegacyAttachments");
  });

  it.each([408, 425, 429, 503])(
    "retries transient HTTP %s turn responses",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status,
          headers: { get: () => "0" },
          json: async () => ({
            error: { code: "TRANSIENT", message: "请稍后重试" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            task: { id: `accepted-${status}`, status: "running" },
          }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const created = createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: `request-${status}`,
        expectedRevision: 5,
        expectedLeafId: "1.6",
      });
      await vi.advanceTimersByTimeAsync(500);

      await expect(created).resolves.toMatchObject({
        id: `accepted-${status}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].body).toBe(
        fetchMock.mock.calls[1][1].body,
      );
    },
  );

  it("replays repeated pending Logo responses with one stable request body", async () => {
    vi.useFakeTimers();
    const pendingResponse = () => ({
      ok: false,
      status: 425,
      headers: { get: () => "0" },
      json: async () => ({
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "Logo 任务仍在绑定",
        },
        observation: {
          stateEpoch: 2,
          generation: 1,
          activeTurn: { clientRequestId: "request-logo-replay" },
          interaction: {
            progress: null,
            interactionState: "executing",
            canReply: false,
            canPublish: false,
            lockReason: "Logo 正在处理中",
          },
        },
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "frontmind-logo-task", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-logo-replay",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      submissionKind: "logo",
    });
    await vi.advanceTimersByTimeAsync(500 + 1_000);

    await expect(created).resolves.toMatchObject({
      id: "frontmind-logo-task",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(fetchMock.mock.calls.map((call) => call[1].body))).toEqual(
      new Set([fetchMock.mock.calls[0][1].body]),
    );
  });

  it("sanitizes a knowledge-base rejection before exposing its message", async () => {
    const sourceBrand = ["Ma", "nus"].join("");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: { get: () => null },
      json: async () => ({
        error: {
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message: `${sourceBrand} 拒绝了无效 Logo`,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-invalid-logo",
        submissionKind: "logo",
      }),
    ).rejects.toMatchObject({
      message: "FrontMind 拒绝了无效 Logo",
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for Retry-After before replaying the same turn request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "2" },
        json: async () => ({
          error: { code: "RATE_LIMITED", message: "请求过快" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: { id: "accepted-after-delay", status: "running" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-with-retry-after",
      expectedRevision: 5,
      expectedLeafId: "1.6",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(created).resolves.toMatchObject({
      id: "accepted-after-delay",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops replaying a turn request after four transient responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({
        error: { code: "TEMPORARILY_UNAVAILABLE", message: "服务繁忙" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "bounded-request",
      expectedRevision: 5,
      expectedLeafId: "1.6",
    });
    const rejection = expect(created).rejects.toMatchObject({
      status: 503,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Set(fetchMock.mock.calls.map((call) => call[1].body))).toEqual(
      new Set([fetchMock.mock.calls[0][1].body]),
    );
  });

  it("reserves the logical turn before any file id exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reservation: {
          state: "awaiting_attachments",
          turnId: "turn-reserved",
          clientRequestId: "request-files",
          sourceResetRevision: 4,
          generation: 2,
          revision: 5,
          leafId: "1.6",
          stagedAttachmentCount: 0,
          expectedAttachmentCount: 1,
          requiresUpload: true,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = [
      {
        itemId: "request-files:1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];

    await reserveKnowledgeBaseTurnWithAttachments(
      [{ role: "user", content: [{ type: "input_text", text: "修订" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "request-files",
        expectedResetRevision: 4,
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        expectedPresentationKey: "presentation-5",
        attachmentManifest: manifest,
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge-base/turn/reserve");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      expectedPresentationKey: "presentation-5",
      userMessage: "修订",
      attachmentManifest: manifest,
      resumeExisting: false,
    });
  });

  it("rejects an incomplete deferred-upload coordinate before any HTTP request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manifest = [
      {
        itemId: "request-files:1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];
    const context = {
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      attachmentManifest: manifest,
    };

    await expect(
      reserveKnowledgeBaseTurnWithAttachments([], {
        ...context,
        expectedResetRevision: undefined as never,
      }),
    ).rejects.toThrow("知识库附件坐标不完整");
    await expect(
      reserveKnowledgeBaseTurnWithAttachments([], {
        ...context,
        attachmentManifest: [{ ...manifest[0]!, sha256: "" }],
      }),
    ).rejects.toThrow("知识库附件坐标不完整");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["client request", { clientRequestId: "other-request" }],
    ["reset revision", { sourceResetRevision: 5 }],
    ["generation", { generation: 3 }],
    ["revision", { revision: 6 }],
    ["leaf", { leafId: null }],
  ])(
    "fails closed without retry when the reservation receipt changes the %s coordinate",
    async (_coordinate, changedReceipt) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          reservation: {
            state: "awaiting_attachments",
            turnId: "turn-reserved",
            clientRequestId: "request-files",
            sourceResetRevision: 4,
            generation: 2,
            revision: 5,
            leafId: "1.6",
            ...changedReceipt,
          },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        reserveKnowledgeBaseTurnWithAttachments([], {
          conversationId: "conv-kb",
          clientRequestId: "request-files",
          expectedResetRevision: 4,
          expectedGeneration: 2,
          expectedRevision: 5,
          expectedLeafId: "1.6",
          attachmentManifest: [
            {
              itemId: "request-files:1",
              ordinal: 1,
              total: 1,
              filename: "facts.pdf",
              sizeBytes: 12,
              mimeType: "application/pdf",
              lastModified: 10,
              sha256: "a".repeat(64),
            },
          ],
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "KNOWLEDGE_BASE_RESERVATION_COORDINATE_MISMATCH",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("carries one selected delivery project through the entire KB write sequence", async () => {
    sessionStorage.setItem(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "project-assignment-kb",
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reservation: {
            state: "awaiting_attachments",
            turnId: "turn-project",
            clientRequestId: "request-project",
            sourceResetRevision: 4,
            generation: 2,
            revision: 5,
            leafId: "1.6",
            stagedAttachmentCount: 0,
            expectedAttachmentCount: 1,
            requiresUpload: true,
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task: { id: "task-project", status: "running" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const attachmentManifest = [
      {
        itemId: "request-project:1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];

    const { reservation } = await reserveKnowledgeBaseTurnWithAttachments(
      [{ role: "user", content: [{ type: "input_text", text: "修订" }] }],
      {
        conversationId: "conv-project",
        clientRequestId: "request-project",
        expectedResetRevision: 4,
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        attachmentManifest,
      },
    );
    await stageKnowledgeBaseTurnAttachment({
      conversationId: "conv-project",
      turnId: reservation.turnId,
      clientRequestId: "request-project",
      expectedResetRevision: 4,
      attachmentManifest,
      index: 0,
      attachment: { file_id: "file-project", filename: "facts.pdf" },
    });
    await createKnowledgeBaseTurnTask([], {
      conversationId: "conv-project",
      clientRequestId: "request-project",
      expectedResetRevision: 4,
      attachmentReservation: { turnId: reservation.turnId, attachmentManifest },
    });

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({
        "x-delivery-project-assignment-id": "project-assignment-kb",
      });
    }
  });

  it("reserves a starter build before upload with only the byte manifest", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reservation: {
          state: "awaiting_attachments",
          turnId: "turn-start",
          clientRequestId: "request-start",
          generation: 1,
          revision: 0,
          leafId: null,
          stagedAttachmentCount: 0,
          expectedAttachmentCount: 1,
          requiresUpload: true,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const attachmentManifest = [
      {
        itemId: "starter-item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];

    await reserveKnowledgeBaseStart({
      conversationId: "conv-kb",
      clientRequestId: "request-start",
      expectedResetRevision: 4,
      companyName: "FrontMind",
      companyWebsite: "https://example.com",
      operatorNotes: "notes",
      attachmentManifest,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/knowledge-base/start/reserve",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-start",
      expectedResetRevision: 4,
      companyName: "FrontMind",
      companyWebsite: "https://example.com",
      operatorNotes: "notes",
      attachmentManifest,
    });
  });

  it("replays an unknown starter reservation with the exact same coordinates", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reservation: {
            state: "awaiting_attachments",
            turnId: "turn-start-replay",
            clientRequestId: "request-start-replay",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conv-kb-replay",
      clientRequestId: "request-start-replay",
      expectedResetRevision: 4,
      companyName: "FrontMind",
      attachmentManifest: [
        {
          itemId: "starter-item-replay",
          ordinal: 1,
          total: 1,
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
          sha256: "a".repeat(64),
        },
      ],
    };

    const reservation = reserveKnowledgeBaseStart(input);
    await vi.advanceTimersByTimeAsync(500);
    await expect(reservation).resolves.toMatchObject({
      reservation: { turnId: "turn-start-replay" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
  });

  it("stages one stable file id and dispatches without resending file ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task: { id: "task-next", status: "running" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const manifest = [
      {
        itemId: "request-files:1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ];
    await stageKnowledgeBaseTurnAttachment({
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      attachmentManifest: manifest,
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    });
    await createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      attachmentReservation: {
        turnId: "turn-reserved",
        attachmentManifest: manifest,
      },
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/knowledge-base/turn/attachments/stage",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/knowledge-base/turn/dispatch",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      turnId: "turn-reserved",
      expectedResetRevision: 4,
      attachmentManifest: manifest,
    });
  });

  it("retries transient attachment staging failures with the exact same file id", async () => {
    vi.useFakeTimers();
    const transientFailures = [
      { status: 409, code: "IDEMPOTENCY_PENDING" },
      { status: 408, code: "REQUEST_TIMEOUT" },
      { status: 425, code: "TOO_EARLY" },
      { status: 429, code: "RATE_LIMITED" },
      { status: 503, code: "TEMPORARILY_UNAVAILABLE" },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      attachmentManifest: [
        {
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
          sha256: "a".repeat(64),
        },
      ],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    };

    for (const failure of transientFailures) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: failure.status,
          headers: { get: () => "0.25" },
          json: async () => ({
            error: { code: failure.code, message: "请稍后重试" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ reservation: { stagedAttachmentCount: 1 } }),
        });

      const staged = stageKnowledgeBaseTurnAttachment(input);
      await vi.advanceTimersByTimeAsync(500);
      await expect(staged).resolves.toMatchObject({
        reservation: { stagedAttachmentCount: 1 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map((call) => call[1].body);
      expect(new Set(requestBodies)).toEqual(new Set([JSON.stringify(input)]));
      expect(JSON.parse(requestBodies[0]).attachment.file_id).toBe(
        "file-facts",
      );
    }
  });

  it("retries a network staging failure without creating an unbounded loop", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reservation: { stagedAttachmentCount: 1 } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      attachmentManifest: [],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    };

    const staged = stageKnowledgeBaseTurnAttachment(input);
    await vi.advanceTimersByTimeAsync(500);
    await expect(staged).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
  });

  it("stops attachment staging after four transient attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({
        error: { code: "TEMPORARILY_UNAVAILABLE", message: "服务繁忙" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const staged = stageKnowledgeBaseTurnAttachment({
      conversationId: "conv-kb",
      turnId: "turn-reserved",
      clientRequestId: "request-files",
      expectedResetRevision: 4,
      attachmentManifest: [],
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    });
    const rejection = expect(staged).rejects.toMatchObject({
      status: 503,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fences a confirmation to the visible revision and leaf", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "task-next", status: "running", output: [] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createKnowledgeBaseTurnTask(
      [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
      {
        conversationId: "conv-kb",
        clientRequestId: "request-confirm-1",
        expectedRevision: 45,
        expectedLeafId: "5.5",
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      conversationId: "conv-kb",
      clientRequestId: "request-confirm-1",
      expectedRevision: 45,
      expectedLeafId: "5.5",
    });
    expect(body).not.toHaveProperty("userMessage");
  });

  it("marks a dedicated Logo submission and accepts only the returned upstream task id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "manus-logo-task", status: "running" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask(
        [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_id: "file-logo",
                filename: "logo.png",
              },
            ],
          },
        ],
        {
          conversationId: "conv-kb",
          clientRequestId: "request-logo-1",
          expectedRevision: 1,
          expectedLeafId: "1.1",
          submissionKind: "logo",
        },
      ),
    ).resolves.toMatchObject({ id: "manus-logo-task" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      submissionKind: "logo",
      clientRequestId: "request-logo-1",
      attachments: [{ file_id: "file-logo", filename: "logo.png" }],
    });
  });

  it("rejects a successful response only when it has neither a task nor an authoritative observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ accepted: true }),
      }),
    );

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-logo-missing-task",
        submissionKind: "logo",
      }),
    ).rejects.toThrow("任务创建失败：未返回权威任务状态");
  });

  it("accepts a committed local Logo receipt when observation projection is deferred", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          accepted: true,
          execution: "local",
          disposition: "logo_bound",
          buildId: "build-local-logo",
          revision: 3,
          contentVersion: 1,
          observation: null,
        }),
      }),
    );

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-logo-local",
        submissionKind: "logo",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      execution: "local",
      disposition: "logo_bound",
      status: "completed",
      id: "",
    });
  });

  it("accepts a recovering Logo observation without inventing a task id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          accepted: true,
          observation: {
            stateEpoch: 4,
            generation: 1,
            authoritativeTaskId: null,
            activeTurn: {
              id: "logo-turn-pending-task-id",
              clientRequestId: "request-logo-pending-task-id",
            },
            interaction: {
              progress: null,
              interactionState: "executing",
              canReply: false,
              canPublish: false,
              lockReason: "Logo 正在处理中",
            },
            approvedPresentation: null,
            completedTurn: null,
            package: null,
            notice: null,
            conversationVersion: 4,
          },
        }),
      }),
    );

    await expect(
      createKnowledgeBaseTurnTask([], {
        conversationId: "conv-kb",
        clientRequestId: "request-logo-pending-task-id",
        submissionKind: "logo",
      }),
    ).resolves.toMatchObject({
      id: "",
      status: "running",
      knowledgeObservation: {
        stateEpoch: 4,
        generation: 1,
        activeTurn: {
          id: "logo-turn-pending-task-id",
          clientRequestId: "request-logo-pending-task-id",
        },
      },
    });
  });

  it("accepts a complete terminal observation without a task pointer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        observation: {
          stateEpoch: 8,
          generation: 2,
          authoritativeTaskId: null,
          activeTurn: null,
          interaction: {
            progress: null,
            interactionState: "published",
            canReply: false,
            canPublish: false,
            lockReason: null,
          },
          approvedPresentation: null,
          package: null,
          notice: null,
          conversationVersion: 9,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createKnowledgeBaseTurnTask(
        [{ role: "user", content: [{ type: "input_text", text: "确认" }] }],
        {
          conversationId: "conv-terminal",
          clientRequestId: "request-terminal",
        },
      ),
    ).resolves.toMatchObject({
      id: "",
      knowledgeObservation: { stateEpoch: 8, generation: 2 },
    });
  });
});

describe("retrieveTask", () => {
  it("sends the selected customer project assignment in the delivery header", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key: string) =>
        key === DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY
          ? "project-assignment-1"
          : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "task-project",
        status: "completed",
        output: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await retrieveTask("task-project");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/tasks/task-project",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-delivery-project-assignment-id": "project-assignment-1",
        }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "x-delivery-role-assignment-id",
    );
  });

  it("preserves a structured authorization error without any Provider fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "当前账号无权访问该任务" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retrieveTask("task-private")).rejects.toMatchObject({
      message: "当前账号无权访问该任务",
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/tasks/task-private",
      expect.any(Object),
    );
  });

  it("does not fall back to v1 when the local v2 task is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "任务不存在" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retrieveTask("task-local")).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/tasks/task-local",
      expect.any(Object),
    );
  });
});

describe("ordinary chat local v2 contract", () => {
  it("preserves structured dispatch settlement evidence on HTTP errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: {
          message: "请求已被明确拒绝",
          code: "SEND_REJECTED",
          retryable: false,
          dispatchSettled: true,
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTask([{ role: "user", content: "拒绝此请求" }], {
        conversationId: "conversation-rejected",
        clientRequestId: "request-rejected",
        modelProfile: "frontmind-base",
      }),
    ).rejects.toMatchObject({
      message: "请求已被明确拒绝",
      status: 422,
      code: "SEND_REJECTED",
      retryable: false,
      dispatchSettled: true,
    });
  });

  it("creates a local task with a public model profile and no Provider model fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "local-task-1", status: "running", output: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createTask(
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "分析附件" },
            {
              type: "input_file",
              file_id: "asset_123456789012345678901234567890",
              filename: "facts.pdf",
            },
          ],
        },
      ],
      {
        conversationId: "conversation-local-1",
        clientRequestId: "request-local-1",
        modelProfile: "frontmind-base",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/tasks",
      expect.any(Object),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      conversationId: "conversation-local-1",
      clientRequestId: "request-local-1",
      prompt: "分析附件",
      localAssetIds: ["asset_123456789012345678901234567890"],
      modelProfile: "frontmind-base",
    });
    expect(body).not.toHaveProperty("agentProfile");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("taskMode");
  });

  it("continues by local task id without sending a Provider task id field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "local-task-1", status: "running", output: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createTask([{ role: "user", content: "继续分析" }], {
      conversationId: "conversation-local-1",
      clientRequestId: "request-local-2",
      previousResponseId: "local-task-1",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/frontmind/v2/tasks/local-task-1/messages",
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("taskId");
    expect(body).not.toHaveProperty("previousResponseId");
    expect(body).not.toHaveProperty("modelProfile");
  });
});

describe("materialized knowledge-base local asset ingress", () => {
  it("sends the complete SiteOps composer idempotency coordinate", async () => {
    const headers = new Map<string, string>();
    class MockXMLHttpRequest {
      status = 201;
      responseText = JSON.stringify({
        localAssetId: `asset_${"s".repeat(30)}`,
        filename: "product.png",
        bytes: 3,
        sha256: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        replayed: false,
      });
      upload = { addEventListener: vi.fn() };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader(name: string, value: string) {
        headers.set(name, value);
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadChatLocalAsset(
        new File([new Uint8Array([1, 2, 3])], "product.png", {
          type: "image/png",
        }),
        undefined,
        {
          siteOpsComposerCoordinate: {
            clientRequestId: "11111111-1111-4111-8111-111111111111",
            contentSha256: "a".repeat(64),
            ordinal: 2,
          },
        },
      ),
    ).resolves.toMatchObject({
      fileId: `asset_${"s".repeat(30)}`,
      replayed: false,
    });

    expect(headers.get(SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.scope)).toBe(
      SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
    );
    expect(
      headers.get(SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.clientRequestId),
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(
      headers.get(SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.contentSha256),
    ).toBe("a".repeat(64));
    expect(headers.get(SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.ordinal)).toBe(
      "2",
    );
  });

  it("rejects a partial operation coordinate before constructing XHR", async () => {
    const xhrConstructed = vi.fn();
    class MockXMLHttpRequest {
      constructor() {
        xhrConstructed();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadKnowledgeBaseLocalAsset(
        new File(["image"], "supplement.jpg", { type: "image/jpeg" }),
        undefined,
        undefined,
        {
          batchOrdinal: 1,
          resumeScope: {
            kind: "knowledge_base",
            conversationId: "conv-image",
            turnId: "turn-image",
            clientRequestId: "request-image",
            expectedResetRevision: 4,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_OPTIONS" });
    expect(xhrConstructed).not.toHaveBeenCalled();
  });

  it("uploads browser bytes only to the v2 local asset endpoint", async () => {
    const opened: Array<{ method: string; url: string }> = [];
    const headers = new Map<string, string>();
    const stages: FileUploadStageEvent[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    class MockXMLHttpRequest {
      status = 201;
      responseText = JSON.stringify({
        localAssetId: `asset_${"a".repeat(30)}`,
        filename: "brand-logo.png",
        bytes: 4,
        sha256: "a".repeat(64),
        expiresAt: 1_800_000_000_000,
      });
      uploadListeners = new Map<string, Array<(event?: any) => void>>();
      upload = {
        addEventListener: (name: string, listener: (event?: any) => void) => {
          const listeners = this.uploadListeners.get(name) ?? [];
          listeners.push(listener);
          this.uploadListeners.set(name, listeners);
        },
      };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open(method: string, url: string) {
        opened.push({ method, url });
      }
      setRequestHeader(name: string, value: string) {
        headers.set(name, value);
      }
      send(body: File) {
        for (const listener of this.uploadListeners.get("progress") ?? []) {
          listener({
            lengthComputable: true,
            loaded: 2,
            total: body.size,
          });
        }
        for (const listener of this.uploadListeners.get("progress") ?? []) {
          listener({
            lengthComputable: true,
            loaded: body.size,
            total: body.size,
          });
        }
        for (const listener of this.uploadListeners.get("load") ?? []) {
          listener();
        }
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadKnowledgeBaseLocalAsset(
        new File(["logo"], "brand-logo.png", { type: "image/png" }),
        undefined,
        undefined,
        { onStage: (event) => stages.push(event) },
      ),
    ).resolves.toMatchObject({
      fileId: `asset_${"a".repeat(30)}`,
      filename: "brand-logo.png",
      sizeBytes: 4,
      contentSha256: "a".repeat(64),
      dashboardReadyAt: expect.any(Number),
    });

    expect(stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "uploading_to_dashboard",
          loadedBytes: 2,
          totalBytes: 4,
        }),
        expect.objectContaining({
          stage: "uploaded",
          dashboardReceivedBytes: 4,
        }),
      ]),
    );
    expect(stages.at(-1)?.receipt).not.toHaveProperty("providerReadyAt");

    expect(opened).toEqual([
      { method: "POST", url: "/api/frontmind/v2/assets" },
    ]);
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("X-FrontMind-Mime")).toBe("image/png");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(opened.some(({ url }) => url.includes("/v1/files"))).toBe(false);
  });

  it("rejects a local receipt whose expiry is missing or not in the future", async () => {
    class MockXMLHttpRequest {
      status = 201;
      responseText = JSON.stringify({
        localAssetId: `asset_${"b".repeat(30)}`,
        filename: "expired.pdf",
        expiresAt: Date.now(),
      });
      private uploadListeners = new Map<string, (event?: any) => void>();
      upload = {
        addEventListener: (event: string, listener: (event?: any) => void) =>
          this.uploadListeners.set(event, listener),
      };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        this.uploadListeners.get("load")?.();
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadKnowledgeBaseLocalAsset(
        new File(["pdf"], "expired.pdf", { type: "application/pdf" }),
        undefined,
        { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_RECEIPT_INVALID" });
  });

  it("retries a digest-free reservation and accepts the server digest receipt", async () => {
    const requests: Array<{
      headers: Map<string, string>;
      body: File;
    }> = [];
    const onFileRecord = vi.fn();
    let requestIndex = 0;

    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      private headers = new Map<string, string>();
      private uploadListeners = new Map<string, Array<(event?: any) => void>>();
      upload = {
        addEventListener: (name: string, listener: (event?: any) => void) => {
          const listeners = this.uploadListeners.get(name) ?? [];
          listeners.push(listener);
          this.uploadListeners.set(name, listeners);
        },
      };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send(body: File) {
        const index = requestIndex++;
        requests.push({ headers: new Map(this.headers), body });
        if (index === 0) {
          queueMicrotask(() => this.onerror?.());
          return;
        }
        this.status = 200;
        this.responseText = JSON.stringify({
          localAssetId: `asset_${"c".repeat(30)}`,
          filename: "资料.pptx",
          bytes: body.size,
          sha256: "d".repeat(64),
          expiresAt: Date.now() + 60_000,
          replayed: true,
        });
        for (const listener of this.uploadListeners.get("progress") ?? []) {
          listener({
            lengthComputable: true,
            loaded: body.size,
            total: body.size,
          });
        }
        for (const listener of this.uploadListeners.get("load") ?? []) {
          listener();
        }
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const file = new File(["pptx-body"], "资料.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    await expect(
      uploadKnowledgeBaseLocalAsset(
        file,
        undefined,
        { maxRetries: 2, initialDelay: 0, maxDelay: 0 },
        {
          itemId: "item-2",
          batchOrdinal: 2,
          resumeScope: {
            kind: "knowledge_base",
            conversationId: "conversation-1",
            turnId: "turn-1",
            clientRequestId: "request-1",
            expectedResetRevision: 4,
          },
          onFileRecord,
        },
      ),
    ).resolves.toMatchObject({
      fileId: `asset_${"c".repeat(30)}`,
      replayed: true,
      contentSha256: "d".repeat(64),
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(file);
    expect(requests[1]?.body).toBe(file);
    for (const request of requests) {
      expect(
        request.headers.get(KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.conversationId),
      ).toBe("conversation-1");
      expect(
        request.headers.get(KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.turnId),
      ).toBe("turn-1");
      expect(
        request.headers.get(KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.itemId),
      ).toBe("item-2");
      expect(
        request.headers.get(
          KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.expectedResetRevision,
        ),
      ).toBe("4");
      expect(
        request.headers.get(KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256),
      ).toBeUndefined();
    }
    expect(
      requests.map((request) =>
        request.headers.get(KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.attempt),
      ),
    ).toEqual(["1", "2"]);
    expect(onFileRecord).toHaveBeenCalledOnce();
  });

  it("resumes a revise turn after a lost final upload response and does not send the browser body twice when that ordinal is staged", async () => {
    let bodySendCount = 0;
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        bodySendCount += 1;
        queueMicrotask(() => this.onerror?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const attachmentManifest = [
      {
        itemId: "item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.jpg",
        sizeBytes: 5,
        mimeType: "image/jpeg",
        lastModified: 1_755_000_000_001,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        stagedCustomerAttachmentCount: 1,
        retainedCustomerAttachmentCount: 1,
        missingCustomerAttachments: [],
        readyToDispatch: true,
        attachmentManifest,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["facts"], "facts.jpg", {
      type: "image/jpeg",
      lastModified: attachmentManifest[0]!.lastModified,
    });

    await expect(
      uploadKnowledgeBaseLocalAsset(
        file,
        undefined,
        { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
        {
          itemId: "item-1",
          batchOrdinal: 1,
          resumeScope: {
            kind: "knowledge_base",
            operationType: "revise",
            conversationId: "conversation-1",
            turnId: "turn-1",
            clientRequestId: "request-1",
            expectedResetRevision: 4,
          },
        },
      ),
    ).resolves.toMatchObject({
      alreadyStaged: true,
      recovered: true,
      replayed: true,
    });
    expect(bodySendCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/knowledge-base/turn/attachments/resume",
    );
  });

  it("reconciles an already-staged revise ordinal after both prior recovery responses were lost", async () => {
    let bodySendCount = 0;
    class MockXMLHttpRequest {
      status = 409;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_OPERATION_CONFLICT",
          message: "The upload ordinal is already staged",
        },
      });
      upload = { addEventListener: vi.fn() };
      onerror?: () => void;
      onabort?: () => void;
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        bodySendCount += 1;
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const attachmentManifest = [
      {
        itemId: "item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.jpg",
        sizeBytes: 5,
        mimeType: "image/jpeg",
        lastModified: 1_755_000_000_001,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        stagedCustomerAttachmentCount: 1,
        retainedCustomerAttachmentCount: 1,
        missingCustomerAttachments: [],
        readyToDispatch: true,
        attachmentManifest,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadKnowledgeBaseLocalAsset(
        new File(["facts"], "facts.jpg", {
          type: "image/jpeg",
          lastModified: attachmentManifest[0]!.lastModified,
        }),
        undefined,
        { maxRetries: 2, initialDelay: 0, maxDelay: 0 },
        {
          itemId: "item-1",
          batchOrdinal: 1,
          resumeScope: {
            kind: "knowledge_base",
            operationType: "revise",
            conversationId: "conversation-1",
            turnId: "turn-1",
            clientRequestId: "request-1",
            expectedResetRevision: 4,
          },
        },
      ),
    ).resolves.toMatchObject({
      alreadyStaged: true,
      recovered: true,
      replayed: true,
    });
    expect(bodySendCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/knowledge-base/turn/attachments/resume",
    );
  });
});

describe("knowledge-base local attachment recovery contract", () => {
  it("parses the additive knowledgeObservation field for resume and cancel", async () => {
    const knowledgeObservation = {
      generation: 2,
      stateEpoch: 10,
      interaction: {
        interactionState: "awaiting_input",
        canReply: true,
        progress: null,
      },
    };
    const attachmentManifest = [
      {
        itemId: "item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 5,
        mimeType: "application/pdf",
        lastModified: 1,
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          stagedCustomerAttachmentCount: 1,
          retainedCustomerAttachmentCount: 1,
          missingCustomerAttachments: [],
          readyToDispatch: true,
          attachmentManifest,
          knowledgeObservation,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          cancelled: true,
          knowledgeObservation,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const coordinate = {
      conversationId: "conversation-1",
      turnId: "turn-1",
      clientRequestId: "request-1",
      expectedResetRevision: 4,
    };

    await expect(
      resumeKnowledgeBaseTurnAttachments(coordinate),
    ).resolves.toMatchObject({
      stagedCustomerAttachmentCount: 1,
      knowledgeObservation: { generation: 2, stateEpoch: 10 },
    });
    await expect(
      cancelKnowledgeBaseTurnAttachments(coordinate),
    ).resolves.toMatchObject({
      cancelled: true,
      knowledgeObservation: { generation: 2, stateEpoch: 10 },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/knowledge-base/turn/attachments/resume",
      "/api/knowledge-base/turn/attachments/cancel",
    ]);
  });
});

describe("managed knowledge-base upload discovery", () => {
  const conversationId = "conversation-managed-discovery";
  const turnId = "00000000-0000-4000-8000-000000000042";
  const clientRequestId = "client-managed-discovery";
  const attachmentManifest = [
    {
      itemId: "managed-item-1",
      ordinal: 1,
      total: 2,
      filename: "managed-one.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
      lastModified: 1_700_000_000_001,
      sha256: "a".repeat(64),
    },
    {
      itemId: "managed-item-2",
      ordinal: 2,
      total: 2,
      filename: "managed-two.pdf",
      mimeType: "application/pdf",
      sizeBytes: 22,
      lastModified: 1_700_000_000_002,
      sha256: "b".repeat(64),
    },
  ];

  function discoveryPayload() {
    return {
      uploads: attachmentManifest.map((item) => ({
        intentId: `intent-${item.ordinal}`,
        intentTicket: `mi1.ticket-${item.ordinal}`,
        ticketExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
        batchId: "managed-batch",
        ordinal: item.ordinal,
        total: item.total,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        state: "awaiting_browser",
        phase: null,
        receipt: null,
        clientRequestId,
      })),
      reservation: {
        clientRequestId,
        sourceResetRevision: 9,
        attachmentManifest,
        stagedAttachmentCount: 1,
      },
      traceId: "trace-managed-discovery",
    };
  }

  it("strictly parses the complete frozen reservation and reissued upload capabilities", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn((key: string) =>
        key === DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY
          ? "project-managed-discovery"
          : null,
      ),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    const payload = discoveryPayload();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listManagedUploadsForKnowledgeBase({ conversationId, turnId }),
    ).resolves.toEqual({
      uploads: payload.uploads,
      reservation: payload.reservation,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/frontmind/v1/managed-uploads?conversationId=${conversationId}&turnId=${turnId}`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "include",
    });
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get(
        "x-delivery-project-assignment-id",
      ),
    ).toBe("project-managed-discovery");
  });

  it.each([
    {
      label: "uploads is not an array",
      mutate: (payload: ReturnType<typeof discoveryPayload>) => {
        (payload as unknown as { uploads: unknown }).uploads = {};
      },
    },
    {
      label: "an upload capability is missing a required field",
      mutate: (payload: ReturnType<typeof discoveryPayload>) => {
        delete (payload.uploads[0] as Partial<(typeof payload.uploads)[0]>)
          .intentTicket;
      },
    },
    {
      label: "two uploads claim the same ordinal",
      mutate: (payload: ReturnType<typeof discoveryPayload>) => {
        payload.uploads[1].ordinal = 1;
      },
    },
    {
      label: "an upload drifts from its frozen manifest coordinate",
      mutate: (payload: ReturnType<typeof discoveryPayload>) => {
        payload.uploads[1].filename = "different-file.pdf";
      },
    },
  ])("rejects discovery when $label", async ({ mutate }) => {
    const payload = discoveryPayload();
    mutate(payload);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    );

    await expect(
      listManagedUploadsForKnowledgeBase({ conversationId, turnId }),
    ).rejects.toThrow(/Dashboard.*恢复.*无效/u);
  });

  it("recovers a discovered upload with no File construction, XHR, or browser body", async () => {
    const upload = discoveryPayload().uploads[0];
    const uploadedAt = Date.parse("2026-08-12T00:00:00.000Z");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        state: "uploaded",
        intentId: upload.intentId,
        fileId: "provider-managed-one",
        sizeBytes: upload.sizeBytes,
        uploadedAt,
        providerReadyAt: uploadedAt + 1_000,
        expiresAt: Date.parse("2026-08-14T00:00:00.000Z"),
        replayed: true,
        recreated: false,
        traceId: "trace-bodyless-recovery",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "File",
      class ForbiddenFileConstruction {
        constructor() {
          throw new Error("discovery recovery must not construct File");
        }
      },
    );
    let xhrCount = 0;
    vi.stubGlobal(
      "XMLHttpRequest",
      class ForbiddenXMLHttpRequest {
        constructor() {
          xhrCount += 1;
          throw new Error("discovery recovery must not send XHR bytes");
        }
      },
    );

    await expect(recoverDiscoveredManagedUpload(upload)).resolves.toMatchObject(
      {
        state: "uploaded",
        fileId: "provider-managed-one",
        sizeBytes: upload.sizeBytes,
        replayed: true,
        recovered: false,
        traceId: "trace-bodyless-recovery",
      },
    );
    expect(xhrCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/frontmind/v1/managed-uploads/recovery",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: "{}",
    });
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get(
        "X-FrontMind-Upload-Intent-Id",
      ),
    ).toBe(upload.intentId);
  });

  it("durably schedules cleanup and treats the worker's 202 as cancellation success", async () => {
    const upload = discoveryPayload().uploads[0];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ scheduled: true, state: "cleanup_pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discardManagedUploadIntent(
        {
          intentId: upload.intentId,
          ticket: upload.intentTicket,
          filename: upload.filename,
          expiresAt: upload.ticketExpiresAt,
        },
        { deferProviderCleanup: true },
      ),
    ).resolves.toBeUndefined();
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.method).toBe("DELETE");
    expect(
      new Headers(request.headers).get("X-FrontMind-Upload-Cleanup-Mode"),
    ).toBe("deferred");
  });
});

describe("uploadFile", () => {
  const uploadedAt = Date.parse("2026-08-04T00:00:00.000Z");
  const expiresAt = Date.parse("2026-09-03T00:00:00.000Z");

  const receipt = (
    fileId: string,
    sizeBytes: number,
    overrides: Partial<{
      fileId: string;
      sizeBytes: number;
      uploadedAt: number;
      providerReadyAt: number;
      expiresAt: number;
      replayed: boolean;
      recovered: boolean;
    }> = {},
  ) => ({
    fileId,
    sizeBytes,
    uploadedAt,
    providerReadyAt: uploadedAt + 1_000,
    expiresAt,
    replayed: false,
    recovered: false,
    ...overrides,
  });

  const unsupportedIntentResponse = () => ({
    ok: false,
    status: 404,
    headers: { get: () => "unsupported" },
    clone: () => ({
      json: async () => ({
        error: { code: "MANAGED_UPLOAD_INTENT_UNSUPPORTED" },
      }),
    }),
    json: async () => ({
      error: { code: "MANAGED_UPLOAD_INTENT_UNSUPPORTED" },
    }),
  });

  const stubFileRecord = (
    fileId: string,
    filename: string,
    uploadUrl = "https://uploads.example/signed?X-Amz-Signature=secret",
  ) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/frontmind/v1/managed-uploads") {
        return unsupportedIntentResponse();
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: fileId,
          filename,
          upload_url: uploadUrl,
          proxy_upload_ticket: `ticket:${fileId}`,
          proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("persists a stage-first intent handle and retries with recovery only", async () => {
    const file = new File(["sealed-local-copy"], "stage-first.pdf", {
      type: "application/pdf",
    });
    const intentId = "mui-stage-first";
    const providerFileId = "provider-stage-first";
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestUrls.push(url);
      if (url === "/api/frontmind/v1/managed-uploads") {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            state: "awaiting_browser",
            intentId,
            intentTicket: "mi1.stage-first.signature",
            expiresAt: Date.now() + 60_000,
            sizeBytes: file.size,
          }),
        };
      }
      if (url === "/api/frontmind/v1/managed-uploads/recovery") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: "uploaded",
            intentId,
            fileId: providerFileId,
            sizeBytes: file.size,
            uploadedAt,
            providerReadyAt: uploadedAt + 1_000,
            expiresAt,
            replayed: false,
            recreated: false,
            traceId: "trace-stage-first-ready",
          }),
        };
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const browserBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 503;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_PROVIDER_TEMPORARY",
          message: "cloud temporarily unavailable",
          retryable: true,
          recoveryAction: "check_status",
          traceId: "trace-stage-first-pending",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        browserBodies.push(body);
        queueMicrotask(() => this.listeners.get("load")?.());
      }
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    let handle: ManagedUploadHandle | undefined;
    const stages: FileUploadStageEvent[] = [];

    const firstError = await uploadFile(file, undefined, undefined, {
      itemId: "stable-item-4",
      onFileRecord: (event) => {
        handle = event.uploadHandle;
      },
      onStage: (event) => stages.push(event),
    }).catch((error: unknown) => error);
    expect(firstError).toMatchObject({
      code: "UPLOAD_PROVIDER_TEMPORARY",
      intentId,
      fileId: undefined,
    });
    expect(handle).toMatchObject({
      itemId: "stable-item-4",
      intentId,
      ticket: "mi1.stage-first.signature",
    });
    expect(handle?.fileId).toBeUndefined();

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle!,
        onStage: (event) => stages.push(event),
      }),
    ).resolves.toMatchObject({
      fileId: providerFileId,
      traceId: "trace-stage-first-ready",
    });
    expect(browserBodies).toEqual([file]);
    expect(
      stages.find(
        (event) => event.stage === "recovering" && event.intentId === intentId,
      ),
    ).not.toHaveProperty("loadedBytes");
    expect(
      stages.some(
        (event) =>
          event.dashboardReceivedBytes === file.size &&
          event.stage !== "uploaded",
      ),
    ).toBe(false);
    expect(requestUrls).toEqual([
      "/api/frontmind/v1/managed-uploads",
      "/api/frontmind/v1/managed-uploads/recovery",
    ]);
    const recoveryRequest = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/frontmind/v1/managed-uploads/recovery",
    );
    expect(
      new Headers(recoveryRequest?.[1]?.headers).get(
        "X-FrontMind-Upload-Intent-Id",
      ),
    ).toBe(intentId);
  });

  it("renders only allowlisted managed-intent copy when a response contains Chinese secrets", async () => {
    const filename = "董事会机密.pdf";
    const providerFileId = "provider-secret-file-id";
    const apiKey = "sk-secret-managed-upload-key";
    const signedUrl =
      "https://uploads.example/private.pdf?X-Amz-Signature=signed-secret";
    const hostileMessage = `云端失败：${apiKey} ${filename} ${providerFileId} ${signedUrl}`;
    const file = new File(["sealed-local-copy"], filename, {
      type: "application/pdf",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          state: "awaiting_browser",
          intentId: "mui-secret-redaction",
          intentTicket: "mi1.secret.signature",
          expiresAt: Date.now() + 60_000,
          sizeBytes: file.size,
        }),
      }),
    );
    class MockXMLHttpRequest {
      status = 503;
      responseText = JSON.stringify({
        error: {
          code: "UNTRUSTED_PROVIDER_RAW_MESSAGE",
          message: hostileMessage,
          retryable: true,
          recoveryAction: "check_status",
          traceId: "11111111-1111-4111-8111-111111111111",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        queueMicrotask(() => this.listeners.get("load")?.());
      }
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const error = await uploadFile(file, undefined, undefined, {
      itemId: "stable-secret-item",
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "UPLOAD_REJECTED",
      message: "文件上传失败，请稍后重试",
      intentId: "mui-secret-redaction",
      recoveryAction: "check_status",
    });
    const serialized = JSON.stringify(error);
    for (const secret of [apiKey, filename, providerFileId, signedUrl]) {
      expect(String((error as Error).message)).not.toContain(secret);
      expect(serialized).not.toContain(secret);
    }
  });

  it("aborts a half-open upload only after a long no-progress watchdog", async () => {
    vi.useFakeTimers();
    class MockXMLHttpRequest {
      status = 0;
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {}
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const upload = uploadFileToUrl(
      "https://uploads.example/stalled",
      new File(["png"], "proof.png", { type: "image/png" }),
    );
    let settled = false;
    void upload.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    expect(FILE_UPLOAD_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_IDLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).rejects.toThrow("长时间没有进度");
  });

  it("refreshes the idle deadline for every continuing progress event", async () => {
    vi.useFakeTimers();
    let xhr: MockXMLHttpRequest | undefined;
    let aborted = false;
    class MockXMLHttpRequest {
      status = 0;
      private uploadListeners = new Map<string, (event: any) => void>();
      upload = {
        addEventListener: (event: string, listener: (event: any) => void) =>
          this.uploadListeners.set(event, listener),
      };
      private listeners = new Map<string, () => void>();
      constructor() {
        xhr = this;
      }
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {}
      progress(loaded: number, total: number) {
        this.uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded,
          total,
        });
      }
      abort() {
        aborted = true;
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const upload = uploadFileToUrl(
      "https://uploads.example/stalled-duplicate",
      new File(["abcd"], "proof.png", { type: "image/png" }),
    );
    const rejected = expect(upload).rejects.toMatchObject({
      code: "UPLOAD_BROWSER_STALLED",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    xhr!.progress(1, 4);
    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_IDLE_TIMEOUT_MS - 1);
    xhr!.progress(1, 4);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_IDLE_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(aborted).toBe(true);
  });

  it("uses the separate Dashboard response timeout after all bytes leave the browser", async () => {
    vi.useFakeTimers();
    let xhr: MockXMLHttpRequest | undefined;
    class MockXMLHttpRequest {
      status = 0;
      private uploadListeners = new Map<string, (event?: any) => void>();
      upload = {
        addEventListener: (event: string, listener: (event?: any) => void) =>
          this.uploadListeners.set(event, listener),
      };
      private listeners = new Map<string, () => void>();
      constructor() {
        xhr = this;
      }
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        this.uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded: 4,
          total: 4,
        });
        this.uploadListeners.get("load")?.();
      }
      progress(loaded: number, total: number) {
        this.uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded,
          total,
        });
      }
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const upload = uploadFileToUrl(
      "https://uploads.example/server-timeout",
      new File(["abcd"], "proof.png", { type: "image/png" }),
    );
    const rejected = expect(upload).rejects.toMatchObject({
      code: "UPLOAD_SERVER_RESPONSE_TIMEOUT",
    });
    expect(FILE_UPLOAD_SERVER_RESPONSE_TIMEOUT_MS).toBe(6 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(
      FILE_UPLOAD_SERVER_RESPONSE_TIMEOUT_MS - 1,
    );
    // Late upload events must not replace or extend the independent response
    // timer once the request body has completed.
    xhr!.progress(3, 4);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it("keeps the signed URL out of a captured request and preserves both filenames", async () => {
    const signedUrl =
      "https://uploads.example/signed-unicode?X-Amz-Signature=unicode";
    const providerFilename = "供应商原名😀.pdf";
    const captureFilename = "知识库规范名.pdf";
    const fetchMock = stubFileRecord(
      "file-unicode",
      providerFilename,
      signedUrl,
    );
    const file = new File(["pdf"], providerFilename, {
      type: "application/pdf",
    });

    const headers = new Map<string, string>();
    let requestUrl = "";
    let requestBody: unknown;
    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();

      open(_method: string, url: string) {
        requestUrl = url;
      }
      setRequestHeader(name: string, value: string) {
        headers.set(name, value);
      }
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        requestBody = body;
        this.status = 200;
        this.responseText = JSON.stringify(receipt("file-unicode", file.size));
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        file,
        undefined,
        { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
        {
          captureLocalCopy: true,
          captureFilename,
          batchId: "kb-batch-123",
          batchOrdinal: 2,
          batchTotal: 5,
        },
      ),
    ).resolves.toMatchObject({
      fileId: "file-unicode",
      sizeBytes: file.size,
      uploadedAt,
      expiresAt,
    });

    expect(requestUrl).toBe(
      "/api/frontmind/proxy-upload?capture_file_id=file-unicode",
    );
    expect(requestUrl).not.toContain("target=");
    expect(requestUrl).not.toContain(signedUrl);
    expect(requestBody).toBe(file);
    expect(headers.get("X-FrontMind-Provider-Filename-UTF8")).toBe(
      encodeURIComponent(providerFilename),
    );
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toBe(
      encodeURIComponent(captureFilename),
    );
    expect(headers.get("X-FrontMind-Upload-Batch-Id")).toBe("kb-batch-123");
    expect(headers.get("X-FrontMind-Upload-Ordinal")).toBe("2");
    expect(headers.get("X-FrontMind-Upload-Total")).toBe("5");
    expect(headers.get("X-FrontMind-Upload-Ticket")).toBe(
      "ticket:file-unicode",
    );
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toMatch(
      /^[\x20-\x7e]+$/u,
    );
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ filename: providerFilename }),
    );
  });

  it("polls a 202 processing receipt without sending a second browser body", async () => {
    vi.useFakeTimers();
    const fileId = "file-processing";
    const file = new File(["cloud"], "processing.pdf", {
      type: "application/pdf",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unsupportedIntentResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: fileId,
          filename: file.name,
          proxy_upload_ticket: "ticket-processing",
          proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          state: "uploaded",
          ...receipt(fileId, file.size, { recovered: true }),
          traceId: "trace-cloud-ready",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let browserBodies = 0;
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        expect(body).toBe(file);
        browserBodies += 1;
        this.status = 202;
        this.responseText = JSON.stringify({
          state: "processing",
          fileId,
          sizeBytes: file.size,
          uploadedAt,
          expiresAt,
          retryAfterMs: 500,
          traceId: "trace-processing",
        });
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const stages: string[] = [];

    const upload = uploadFile(file, undefined, undefined, {
      onStage: (event) => stages.push(event.stage),
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    await expect(upload).resolves.toMatchObject({
      fileId,
      providerReadyAt: uploadedAt + 1_000,
      recovered: true,
      traceId: "trace-cloud-ready",
    });
    expect(browserBodies).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stages).toContain("server_processing");
    expect(stages.at(-1)).toBe("uploaded");
  });

  it("turns a busy managed XHR into bodyless recovery until uploaded", async () => {
    vi.useFakeTimers();
    const fileId = "file-busy-managed-xhr";
    const file = new File(["busy"], "busy-managed.pdf", {
      type: "application/pdf",
    });
    const requestUrls: string[] = [];
    let recoveryChecks = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Partial<Response>> => {
        const url = String(input);
        requestUrls.push(url);
        if (url === "/api/frontmind/v1/managed-uploads") {
          return unsupportedIntentResponse();
        }
        if (url === "/api/frontmind/v1/files") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: fileId,
              filename: file.name,
              proxy_upload_ticket: "ticket-busy-managed-xhr",
              proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
            }),
          };
        }
        if (url.endsWith(`/${fileId}/upload-recovery`)) {
          recoveryChecks += 1;
          if (recoveryChecks === 1) {
            return {
              ok: false,
              status: 409,
              json: async () => ({
                error: {
                  code: "UPLOAD_IN_PROGRESS",
                  message: "文件仍在处理中",
                  retryable: true,
                  recoveryAction: "retry_same_file",
                  fileId,
                  traceId: "trace-busy-recovery",
                },
              }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              state: "uploaded",
              ...receipt(fileId, file.size, { recovered: true }),
              traceId: "trace-busy-uploaded",
            }),
          };
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const browserBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        browserBodies.push(body);
        this.status = 409;
        this.responseText = JSON.stringify({
          error: {
            code: "UPLOAD_IN_PROGRESS",
            message: "文件仍在处理中",
            retryable: true,
            fileId,
            traceId: "trace-busy-xhr",
          },
        });
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const progress: number[] = [];
    const upload = uploadFile(file, (percent) => progress.push(percent));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(upload).resolves.toMatchObject({
      fileId,
      recovered: true,
      traceId: "trace-busy-uploaded",
    });
    expect(browserBodies).toEqual([file]);
    expect(progress).toEqual([0, 100]);
    expect(requestUrls).toEqual([
      "/api/frontmind/v1/managed-uploads",
      "/api/frontmind/v1/files",
      `/api/frontmind/v1/files/${fileId}/upload-recovery`,
      `/api/frontmind/v1/files/${fileId}/upload-recovery`,
    ]);
  });

  it("keeps the original requested filename in recovery when the public record display name is sanitized", async () => {
    const providerFilename = `${["M", "a", "n", "u", "s"].join("")}-资料.pdf`;
    const displayFilename = "FrontMind-资料.pdf";
    const fileId = "file-brand-filename";
    const file = new File(["brand"], providerFilename, {
      type: "application/pdf",
    });
    const recoveryBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/frontmind/v1/managed-uploads") {
          return unsupportedIntentResponse();
        }
        if (url === "/api/frontmind/v1/files") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              id: fileId,
              filename: displayFilename,
              upload_url: "https://uploads.example/legacy",
              proxy_upload_ticket: "ticket-brand-filename",
              proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
            }),
          };
        }
        if (url.endsWith(`/${fileId}/upload-recovery`)) {
          recoveryBodies.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              fileId,
              state: "uploaded",
              recreateRequired: false,
              receipt: receipt(fileId, file.size, { recovered: true }),
            }),
          };
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    let sentBodies = 0;
    class MockXMLHttpRequest {
      status = 503;
      responseText = JSON.stringify({
        error: {
          code: "UPSTREAM_UPLOAD_UNAVAILABLE",
          message: "上游暂时不可用",
          retryable: true,
          recoveryAction: "retry_same_file",
          fileId,
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        sentBodies += 1;
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    let uploadHandle: ManagedUploadHandle | undefined;

    await expect(
      uploadFile(file, undefined, undefined, {
        onFileRecord: (event) => {
          uploadHandle = event.uploadHandle;
        },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UPLOAD_UNAVAILABLE" });
    expect(uploadHandle).toMatchObject({
      fileId,
      filename: providerFilename,
      ticket: "ticket-brand-filename",
    });

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: uploadHandle!,
      }),
    ).resolves.toMatchObject({ fileId, recovered: true });
    expect(recoveryBodies).toEqual([
      {
        filename: providerFilename,
        sizeBytes: file.size,
        mimeType: "application/pdf",
      },
    ]);
    expect(sentBodies).toBe(1);
  });

  it("sends only one captured browser body on 403 and preserves the server code", async () => {
    stubFileRecord("file-forbidden", "private.pdf");
    const sentBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 403;
      statusText = "";
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_CAPTURE_FORBIDDEN",
          message: "上传文件不属于当前账号",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        sentBodies.push(body);
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const error = await uploadFile(
      new File(["private"], "private.pdf", { type: "application/pdf" }),
      undefined,
      { maxRetries: 9, initialDelay: 0, maxDelay: 0 },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "上传文件不属于当前账号",
      code: "UPLOAD_CAPTURE_FORBIDDEN",
      status: 403,
      fileId: "file-forbidden",
      retryable: false,
    });
    expect((error as Error).message).not.toContain("失效");
    expect(sentBodies).toHaveLength(1);
  });

  it("honors a non-busy server retryable directive for a captured response", async () => {
    const fileId = "file-server-retryable-503";
    stubFileRecord(fileId, "server-retryable.pdf");
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        this.status = 503;
        this.responseText = JSON.stringify({
          error: {
            code: "UPSTREAM_UPLOAD_UNAVAILABLE",
            message: "服务端上传状态需要由显式合同判断",
            retryable: false,
          },
        });
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["retry"], "server-retryable.pdf", {
          type: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UPLOAD_UNAVAILABLE",
      status: 503,
      fileId,
      retryable: false,
    });
  });

  it("cancels the active captured XHR through AbortSignal", async () => {
    stubFileRecord("file-cancel", "cancel.pdf");
    const controller = new AbortController();
    const sentBodies: unknown[] = [];
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        sentBodies.push(body);
        controller.abort();
      }
      abort() {
        this.listeners.get("abort")?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const error = await uploadFile(
      new File(["cancel"], "cancel.pdf", { type: "application/pdf" }),
      undefined,
      undefined,
      { signal: controller.signal },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "UPLOAD_CANCELLED",
      fileId: "file-cancel",
      retryable: false,
      cancelled: true,
    });
    expect(sentBodies).toHaveLength(1);
  });

  it("checks a processing existing file until uploaded without sending another browser body", async () => {
    vi.useFakeTimers();
    const existingFileId = "opaque/file+existing";
    const existingHandle = {
      fileId: existingFileId,
      filename: " manual-retry.pdf ",
      ticket: "opaque-retry-ticket",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          state: "processing",
          fileId: existingFileId,
          sizeBytes: 5,
          uploadedAt,
          expiresAt,
          retryAfterMs: 500,
          traceId: "trace-processing",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          state: "uploaded",
          ...receipt(existingFileId, 5, { recovered: true }),
          traceId: "trace-uploaded",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["retry"], existingHandle.filename, {
      type: "application/pdf",
    });
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecord = vi.fn();

    const upload = uploadFile(file, undefined, undefined, {
      existingUploadHandle: existingHandle,
      onFileRecord,
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await expect(upload).resolves.toMatchObject({
      fileId: existingFileId,
      sizeBytes: file.size,
      recovered: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/frontmind/v1/files/${encodeURIComponent(existingFileId)}/upload-recovery`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-FrontMind-Upload-Ticket": existingHandle.ticket,
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      filename: existingHandle.filename,
      sizeBytes: file.size,
      mimeType: "application/pdf",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      filename: existingHandle.filename,
      sizeBytes: file.size,
      mimeType: "application/pdf",
    });
    expect(xhrCount).toBe(0);
    expect(onFileRecord).toHaveBeenCalledWith({
      fileId: existingFileId,
      filename: existingHandle.filename,
      uploadHandle: existingHandle,
      reusedExistingFileId: true,
    });
  });

  it("keeps a manual retry bodyless while the original request owns the file", async () => {
    vi.useFakeTimers();
    const file = new File(["retained"], "manual-busy.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-manual-busy",
      filename: file.name,
      ticket: "ticket-manual-busy",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const startedAt = Date.now();
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestUrls.push(url);
      if (!url.endsWith(`/${handle.fileId}/upload-recovery`)) {
        throw new Error(`unexpected request ${url}`);
      }
      if (Date.now() - startedAt < 330_000) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "UPLOAD_IN_PROGRESS",
              message: "文件仍在处理中",
              retryable: true,
              recoveryAction: "retry_same_file",
              fileId: handle.fileId,
              traceId: "trace-manual-busy",
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: "uploaded",
          ...receipt(handle.fileId, file.size, { recovered: true }),
          traceId: "trace-manual-ready",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const progress = vi.fn();
    const transferredUpdates: number[] = [];

    const upload = uploadFile(file, progress, undefined, {
      existingUploadHandle: handle,
      onStage: (event) => {
        if (typeof event.loadedBytes === "number") {
          transferredUpdates.push(event.loadedBytes);
        }
      },
    });
    await vi.advanceTimersByTimeAsync(330_000);

    await expect(upload).resolves.toMatchObject({
      fileId: handle.fileId,
      recovered: true,
      traceId: "trace-manual-ready",
    });
    expect(xhrCount).toBe(0);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(transferredUpdates).toEqual([file.size]);
    expect(requestUrls.length).toBeGreaterThan(1);
    expect(
      requestUrls.every(
        (url) =>
          url === `/api/frontmind/v1/files/${handle.fileId}/upload-recovery`,
      ),
    ).toBe(true);
  });

  it("recovers a confirmed receipt without sending another browser body", async () => {
    const file = new File(["already uploaded"], "recovered.pdf", {
      type: "application/pdf",
    });
    const handle = {
      fileId: "file-recovered",
      filename: file.name,
      ticket: "ticket-recovered",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fileId: handle.fileId,
        state: "uploaded",
        recreateRequired: false,
        traceId: "trace-recovered",
        receipt: receipt(handle.fileId, file.size, {
          recovered: true,
        }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const stages: string[] = [];

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle,
        onStage: (event) => stages.push(event.stage),
      }),
    ).resolves.toMatchObject({
      fileId: handle.fileId,
      recovered: true,
      traceId: "trace-recovered",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(xhrCount).toBe(0);
    expect(stages).toEqual(["creating_record", "recovering", "uploaded"]);
  });

  it("bounds managed recovery and keeps the action at check_status", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const recovery = recoverManagedUpload(
      { fileId: "file-timeout", ticket: "ticket-timeout" },
      new File(["timeout"], "timeout.pdf"),
    );
    const settled = recovery.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(MANAGED_UPLOAD_RECOVERY_TIMEOUT_MS);

    await expect(settled).resolves.toMatchObject({
      code: "UPLOAD_RECOVERY_UNAVAILABLE",
      recoveryAction: "check_status",
      retryable: true,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a provider-processing timeout recoverable without sending a browser body", async () => {
    vi.useFakeTimers();
    const file = new File(["pending"], "pending.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-pending-timeout",
      filename: file.name,
      ticket: "ticket-pending-timeout",
      expiresAt,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        state: "processing",
        fileId: handle.fileId,
        sizeBytes: file.size,
        uploadedAt,
        expiresAt,
        retryAfterMs: 5_000,
        traceId: "trace-still-processing",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    const upload = uploadFile(file, undefined, undefined, {
      existingUploadHandle: handle,
    });
    const settled = upload.catch((error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(MANAGED_UPLOAD_PROCESSING_TIMEOUT_MS);

    await expect(settled).resolves.toMatchObject({
      code: "UPLOAD_PROVIDER_PROCESSING_TIMEOUT",
      fileId: handle.fileId,
      retryable: true,
      recoveryAction: "check_status",
      traceId: "trace-still-processing",
    });
    expect(xhrCount).toBe(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("bounds a busy manual recovery and preserves check-status semantics", async () => {
    vi.useFakeTimers();
    const file = new File(["busy-timeout"], "busy-timeout.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-busy-timeout",
      filename: file.name,
      ticket: "ticket-busy-timeout",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "UPLOAD_IN_PROGRESS",
          message: "文件仍在处理中",
          retryable: true,
          recoveryAction: "retry_same_file",
          fileId: handle.fileId,
          traceId: "trace-busy-timeout-latest",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const progress = vi.fn();
    const transferredUpdates: number[] = [];

    const upload = uploadFile(file, progress, undefined, {
      existingUploadHandle: handle,
      onStage: (event) => {
        if (typeof event.loadedBytes === "number") {
          transferredUpdates.push(event.loadedBytes);
        }
      },
    });
    const settled = upload.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(MANAGED_UPLOAD_BUSY_RECOVERY_TIMEOUT_MS);

    await expect(settled).resolves.toMatchObject({
      code: "UPLOAD_PROVIDER_PROCESSING_TIMEOUT",
      fileId: handle.fileId,
      retryable: true,
      recoveryAction: "check_status",
      traceId: "trace-busy-timeout-latest",
    });
    expect(xhrCount).toBe(0);
    expect(progress).not.toHaveBeenCalled();
    expect(transferredUpdates).toEqual([]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("never discards when recreateRequired lacks the explicit discard action", async () => {
    const file = new File(["mismatch"], "mismatch.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-mismatched-directive",
      filename: file.name,
      ticket: "ticket-mismatched-directive",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestUrls.push(url);
      if (!url.endsWith("/upload-recovery")) {
        throw new Error(`unsafe follow-up request ${url}`);
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "UPLOAD_RECOVERY_UNVERIFIED",
            message: "恢复元数据互相矛盾",
            retryable: false,
            recoveryAction: "retry_same_file",
            recreateRequired: true,
            fileId: handle.fileId,
            traceId: "trace-mismatched-directive",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_UNVERIFIED",
      recoveryAction: "check_status",
      recreateRequired: false,
      fileId: handle.fileId,
      traceId: "trace-mismatched-directive",
    });
    expect(requestUrls).toEqual([
      `/api/frontmind/v1/files/${handle.fileId}/upload-recovery`,
    ]);
    expect(xhrCount).toBe(0);
  });

  it("preserves the record when recovery reports a true provider identity mismatch", async () => {
    const file = new File(["identity"], "identity.pdf", {
      type: "application/pdf",
    });
    const handle: ManagedUploadHandle = {
      fileId: "file-provider-identity-mismatch",
      filename: file.name,
      ticket: "ticket-provider-identity-mismatch",
      expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
    };
    const requestUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestUrls.push(url);
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
            message: "云端文件身份不一致",
            retryable: false,
            recoveryAction: "contact_admin",
            recreateRequired: false,
            fileId: handle.fileId,
            traceId: "trace-provider-identity-mismatch",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: handle,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
      recoveryAction: "contact_admin",
      recreateRequired: false,
      fileId: handle.fileId,
      traceId: "trace-provider-identity-mismatch",
    });
    expect(requestUrls).toEqual([
      `/api/frontmind/v1/files/${handle.fileId}/upload-recovery`,
    ]);
    expect(xhrCount).toBe(0);
  });

  it("keeps the expected id when a recovery error names another record", async () => {
    const expectedFileId = "file-expected-recovery";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED",
            message: "需要重建上传记录",
            retryable: false,
            recoveryAction: "discard_and_recreate",
            recreateRequired: true,
            fileId: "file-unrelated-recovery",
            traceId: "trace-wrong-recovery-id",
          },
        }),
      }),
    );

    await expect(
      recoverManagedUpload(
        { fileId: expectedFileId, ticket: "ticket-expected-recovery" },
        new File(["recovery"], "recovery-id.pdf"),
      ),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_INVALID",
      fileId: expectedFileId,
      retryable: true,
      recoveryAction: "check_status",
      recreateRequired: false,
      traceId: "trace-wrong-recovery-id",
    });
  });

  it.each([
    {
      label: "restage_required even with a valid ticket",
      state: "restage_required" as const,
      existingUploadHandle: {
        fileId: "file-restage-unverified",
        filename: "recovery-guard.pdf",
        ticket: "ticket-restage-unverified",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_RECOVERY_INVALID",
    },
    {
      label: "ready without a ticket",
      state: "ready" as const,
      existingUploadHandle: undefined,
      existingFileId: "file-ready-ticketless",
      expectedCode: "UPLOAD_RECOVERY_INVALID",
    },
    {
      label: "ready with an expired ticket",
      state: "ready" as const,
      existingUploadHandle: {
        fileId: "file-ready-expired",
        filename: "recovery-guard.pdf",
        ticket: "ticket-ready-expired",
        expiresAt: Date.parse("2020-01-01T00:00:00.000Z"),
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_RECOVERY_INVALID",
    },
    {
      label: "ready with less than fifteen seconds left on its ticket",
      state: "ready" as const,
      existingUploadHandle: {
        fileId: "file-ready-near-expiry",
        filename: "recovery-guard.pdf",
        ticket: "ticket-ready-near-expiry",
        expiresAt: Date.now() + 5_000,
      },
      existingFileId: undefined,
      expectedCode: "UPLOAD_RECOVERY_INVALID",
    },
  ])(
    "fails closed for $label without sending a browser body",
    async (input) => {
      const file = new File(["guard"], "recovery-guard.pdf", {
        type: "application/pdf",
      });
      const fileId =
        input.existingUploadHandle?.fileId || input.existingFileId || "";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            fileId,
            state: input.state,
            recreateRequired: false,
            traceId: "trace-recovery-guard",
          }),
        }),
      );
      let xhrCount = 0;
      class MockXMLHttpRequest {
        constructor() {
          xhrCount += 1;
        }
      }
      vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

      await expect(
        uploadFile(file, undefined, undefined, {
          ...(input.existingUploadHandle
            ? { existingUploadHandle: input.existingUploadHandle }
            : { existingFileId: input.existingFileId }),
        }),
      ).rejects.toMatchObject({
        code: input.expectedCode,
        recoveryAction: "check_status",
        recreateRequired: false,
        fileId,
        traceId: "trace-recovery-guard",
      });
      expect(xhrCount).toBe(0);
    },
  );

  it("reconciles, discards, and only then creates a replacement managed record", async () => {
    const file = new File(["replacement"], "replacement.pdf", {
      type: "application/pdf",
    });
    const oldHandle = {
      fileId: "file-old",
      filename: file.name,
      ticket: "ticket-old",
      expiresAt: Date.parse("2026-01-01T00:00:00.000Z"),
    };
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/file-old/upload-recovery")) {
        order.push("recover");
        return {
          ok: false,
          status: 410,
          json: async () => ({
            error: {
              code: "UPLOAD_CAPABILITY_EXPIRED",
              message: "上传凭证已过期",
              retryable: false,
              recoveryAction: "discard_and_recreate",
              recreateRequired: true,
              fileId: oldHandle.fileId,
              traceId: "trace-expired",
            },
          }),
        };
      }
      if (url.endsWith("/file-old/discard")) {
        order.push("discard");
        return { status: 204 };
      }
      if (url === "/api/frontmind/v1/files") {
        order.push("create");
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "file-new",
            filename: file.name,
            upload_url: "https://uploads.example/new",
            proxy_upload_ticket: "ticket-new",
            proxy_upload_expires_at: "2099-01-01T00:00:00.000Z",
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        order.push("xhr");
        this.status = 200;
        this.responseText = JSON.stringify(receipt("file-new", file.size));
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecordDiscarded = vi.fn();
    const onFileRecord = vi.fn();

    await expect(
      uploadFile(file, undefined, undefined, {
        existingUploadHandle: oldHandle,
        onFileRecordDiscarded,
        onFileRecord,
      }),
    ).resolves.toMatchObject({ fileId: "file-new" });

    expect(order).toEqual(["recover", "discard", "create", "xhr"]);
    expect(onFileRecordDiscarded).toHaveBeenCalledWith("file-old");
    expect(onFileRecord).toHaveBeenLastCalledWith({
      fileId: "file-new",
      filename: file.name,
      uploadHandle: expect.objectContaining({
        fileId: "file-new",
        ticket: "ticket-new",
      }),
      reusedExistingFileId: false,
    });
  });

  it("parses managed recovery action and trace id without retrying the body", async () => {
    stubFileRecord("file-traced", "traced.pdf");
    let sentBodies = 0;
    class MockXMLHttpRequest {
      status = 409;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
          message: "文件身份不匹配",
          retryable: false,
          recoveryAction: "discard_and_recreate",
          recreateRequired: true,
          fileId: "file-traced",
          traceId: "trace-identity",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        sentBodies += 1;
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const stages: string[] = [];
    const progress: number[] = [];

    await expect(
      uploadFile(
        new File(["trace"], "traced.pdf"),
        (percent) => progress.push(percent),
        undefined,
        { onStage: (event) => stages.push(event.stage) },
      ),
    ).rejects.toMatchObject({
      code: "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
      recoveryAction: "discard_and_recreate",
      recreateRequired: true,
      traceId: "trace-identity",
    });
    expect(sentBodies).toBe(1);
    expect(progress).toEqual([0]);
    expect(stages).toEqual(["creating_record", "uploading"]);
  });

  it("keeps the expected file id and fails closed when an upload error names another record", async () => {
    const expectedFileId = "file-expected-error";
    stubFileRecord(expectedFileId, "identity-error.pdf");
    class MockXMLHttpRequest {
      status = 409;
      responseText = JSON.stringify({
        error: {
          code: "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED",
          message: "需要重建上传记录",
          retryable: false,
          recoveryAction: "discard_and_recreate",
          recreateRequired: true,
          fileId: "file-unrelated-error",
          traceId: "trace-wrong-error-id",
        },
      });
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(new File(["identity"], "identity-error.pdf")),
    ).rejects.toMatchObject({
      code: "UPLOAD_RECOVERY_INVALID",
      fileId: expectedFileId,
      retryable: true,
      recoveryAction: "check_status",
      recreateRequired: false,
      traceId: "trace-wrong-error-id",
    });
  });

  it("returns the file id and sends no bytes when the record callback fails", async () => {
    stubFileRecord("file-callback", "callback.pdf");
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["callback"], "callback.pdf", { type: "application/pdf" }),
        undefined,
        undefined,
        {
          onFileRecord: async () => {
            throw new Error("local persistence unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "FILE_RECORD_CALLBACK_FAILED",
      fileId: "file-callback",
      retryable: true,
    });
    expect(xhrCount).toBe(0);
  });

  it("returns the created id and sends no bytes when a managed ticket is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unsupportedIntentResponse())
      .mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: "file-ticket-missing",
          filename: "missing-ticket.pdf",
          upload_url: "https://uploads.example/legacy-only",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    let xhrCount = 0;
    class MockXMLHttpRequest {
      constructor() {
        xhrCount += 1;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const onFileRecord = vi.fn();

    await expect(
      uploadFile(
        new File(["missing"], "missing-ticket.pdf", {
          type: "application/pdf",
        }),
        undefined,
        undefined,
        { onFileRecord },
      ),
    ).rejects.toMatchObject({
      code: "FILE_RECORD_INVALID",
      fileId: "file-ticket-missing",
      recoveryAction: "retry_same_file",
    });
    expect(onFileRecord).not.toHaveBeenCalled();
    expect(xhrCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports ordered stages, numeric progress, and the validated receipt", async () => {
    stubFileRecord("file-progress", "progress.pdf");
    const file = new File(["abcdef"], "progress.pdf", {
      type: "application/pdf",
    });
    const lifecycleOrder: string[] = [];
    type Listener = (event?: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
    class MockXMLHttpRequest {
      status = 0;
      responseText = "";
      private listeners = new Map<string, Listener>();
      private uploadListeners = new Map<string, Listener>();
      upload = {
        addEventListener: (event: string, listener: Listener) => {
          this.uploadListeners.set(event, listener);
        },
      };
      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: Listener) {
        this.listeners.set(event, listener);
      }
      send() {
        lifecycleOrder.push("body");
        this.uploadListeners.get("progress")?.({
          lengthComputable: true,
          loaded: file.size / 2,
          total: file.size,
        });
        this.uploadListeners.get("load")?.();
        this.status = 200;
        this.responseText = JSON.stringify(
          receipt("file-progress", file.size, {
            replayed: true,
            recovered: true,
          }),
        );
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const progress: number[] = [];
    const stages: Array<{
      stage: string;
      fileId?: string;
      loadedBytes?: number;
      totalBytes?: number;
      receipt?: unknown;
    }> = [];
    const onFileRecord = vi.fn(() => lifecycleOrder.push("record"));

    const result = await uploadFile(
      file,
      (percent) => progress.push(percent),
      undefined,
      {
        onStage: (event) => stages.push(event),
        onFileRecord,
      },
    );

    expect(progress).toEqual([0, 50, 100]);
    expect(
      stages
        .map((event) => event.stage)
        .filter((stage, index, all) => index === 0 || stage !== all[index - 1]),
    ).toEqual([
      "creating_record",
      "uploading",
      "server_processing",
      "uploaded",
    ]);
    expect(stages[stages.length - 1]).toMatchObject({
      stage: "uploaded",
      fileId: "file-progress",
      loadedBytes: file.size,
      totalBytes: file.size,
      receipt: {
        fileId: "file-progress",
        sizeBytes: file.size,
        uploadedAt,
        providerReadyAt: uploadedAt + 1_000,
        expiresAt,
        replayed: true,
        recovered: true,
      },
    });
    expect(lifecycleOrder).toEqual(["record", "body"]);
    expect(result).toEqual({
      fileId: "file-progress",
      filename: "progress.pdf",
      sizeBytes: file.size,
      uploadedAt,
      providerReadyAt: uploadedAt + 1_000,
      expiresAt,
      replayed: true,
      recovered: true,
    });
  });

  it.each([
    {
      label: "file id",
      makeReceipt: (sizeBytes: number) => receipt("file-other", sizeBytes),
      code: "UPLOAD_RECEIPT_FILE_MISMATCH",
    },
    {
      label: "file size",
      makeReceipt: (sizeBytes: number) =>
        receipt("file-validation", sizeBytes, { sizeBytes: sizeBytes + 1 }),
      code: "UPLOAD_RECEIPT_INVALID",
    },
  ])(
    "rejects a receipt with the wrong $label",
    async ({ makeReceipt, code }) => {
      stubFileRecord("file-validation", "validation.pdf");
      const file = new File(["validate"], "validation.pdf", {
        type: "application/pdf",
      });
      class MockXMLHttpRequest {
        status = 0;
        responseText = "";
        upload = { addEventListener: vi.fn() };
        private listeners = new Map<string, () => void>();
        open() {}
        setRequestHeader() {}
        addEventListener(event: string, listener: () => void) {
          this.listeners.set(event, listener);
        }
        send() {
          this.status = 200;
          this.responseText = JSON.stringify(makeReceipt(file.size));
          queueMicrotask(() => this.listeners.get("load")?.());
        }
      }
      vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

      await expect(uploadFile(file)).rejects.toMatchObject({
        code,
        fileId: "file-validation",
        retryable: true,
      });
    },
  );

  it("rejects a file over 100 MB before creating an upstream record", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversized = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    });

    await expect(uploadFile(oversized)).rejects.toThrow(
      "文件“oversized.pdf”不能超过 100 MB",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy direct-to-generic-proxy retry path for non-captured uploads", async () => {
    const signedUrl =
      "https://uploads.example/legacy?X-Amz-Signature=legacy-secret";
    const fetchMock = stubFileRecord("file-legacy", "legacy.pdf", signedUrl);
    const requests: Array<{ url: string; body: unknown }> = [];
    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private url = "";
      private listeners = new Map<string, () => void>();

      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send(body: unknown) {
        requests.push({ url: this.url, body });
        if (requests.length === 1) {
          queueMicrotask(() => this.listeners.get("error")?.());
          return;
        }
        this.status = requests.length === 2 ? 503 : 204;
        if (this.status === 503) {
          this.responseText = JSON.stringify({
            error: {
              code: "UPLOAD_PROXY_UNAVAILABLE",
              message: "上传服务暂时不可用",
            },
          });
        }
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const file = new File(["legacy"], "legacy.pdf", {
      type: "application/pdf",
    });

    await expect(
      uploadFile(
        file,
        undefined,
        { maxRetries: 1, initialDelay: 0, maxDelay: 0 },
        { captureLocalCopy: false },
      ),
    ).resolves.toEqual({ fileId: "file-legacy", filename: "legacy.pdf" });

    const genericProxyUrl = `/api/frontmind/proxy-upload?target=${encodeURIComponent(signedUrl)}`;
    expect(requests.map((request) => request.url)).toEqual([
      signedUrl,
      genericProxyUrl,
      genericProxyUrl,
    ]);
    expect(requests.every((request) => request.body === file)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards an explicitly removed unbound upload through the authorized route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discardUnboundUpload(" file/unused "),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files/%20file%2Funused%20/discard",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
      }),
    );
  });

  it("preserves a structured conflict when a discard target is already bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({
        error: {
          code: "UPLOAD_ALREADY_BOUND",
          message: "文件已经绑定到任务",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const opaqueFileId = " file-bound ";
    await expect(discardUnboundUpload(opaqueFileId)).rejects.toMatchObject({
      message: "文件已经绑定到任务",
      code: "UPLOAD_ALREADY_BOUND",
      status: 409,
      fileId: opaqueFileId,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files/%20file-bound%20/discard",
      expect.any(Object),
    );
  });
});
