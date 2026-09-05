import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKnowledgeBaseTurnTask,
  reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment,
  createResponseLogicTask,
  DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
  FILE_UPLOAD_STALL_TIMEOUT_MS,
  retrieveTask,
  sanitizeBrandText,
  uploadFile,
  uploadFileToUrl,
} from "./frontmind-api";

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sanitizeBrandText", () => {
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
});

describe("createResponseLogicTask", () => {
  it("sends MIME metadata only to the authenticated response-logic route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: "task-response-logic", status: "running", output: [] },
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
          code: "IDEMPOTENCY_PENDING",
          message: "相同附件仍在暂存",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveKnowledgeBaseTurnWithAttachments([], {
        conversationId: "conv-kb",
        clientRequestId: "request-files",
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        attachmentManifest: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_PENDING",
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
      userMessage: "确认",
    });
  });

  it("replays the exact legacy takeover manifest with the same request bytes", async () => {
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
    const attachmentManifest = [
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 123,
        sha256: "a".repeat(64),
      },
    ];

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
        legacyAttachmentTakeover: { attachmentManifest },
      },
    );

    await vi.advanceTimersByTimeAsync(500);
    await expect(created).resolves.toMatchObject({ id: "legacy-turn" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      resumeLegacyAttachments: true,
      attachmentManifest,
    });
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
        expectedGeneration: 2,
        expectedRevision: 5,
        expectedLeafId: "1.6",
        attachmentManifest: manifest,
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge-base/turn/reserve");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      conversationId: "conv-kb",
      clientRequestId: "request-files",
      expectedGeneration: 2,
      expectedRevision: 5,
      expectedLeafId: "1.6",
      userMessage: "修订",
      attachmentManifest: manifest,
      resumeExisting: false,
    });
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
      attachmentManifest: manifest,
      index: 0,
      attachment: { file_id: "file-facts", filename: "facts.pdf" },
    });
    await createKnowledgeBaseTurnTask([], {
      conversationId: "conv-kb",
      clientRequestId: "request-files",
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
      attachmentManifest: manifest,
    });
  });

  it("retries transient attachment staging failures with the exact same file id", async () => {
    vi.useFakeTimers();
    const transientFailures = [
      { status: 409, code: "IDEMPOTENCY_PENDING" },
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
      userMessage: "确认",
      expectedRevision: 45,
      expectedLeafId: "5.5",
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
      id: "kb-observation-2-8",
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
      "/api/frontmind/v1/tasks/task-project",
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

  it("preserves a structured authorization error without trying the legacy endpoint", async () => {
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
      "/api/frontmind/v1/tasks/task-private",
      expect.any(Object),
    );
  });

  it("falls back to the legacy endpoint only when the task endpoint is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: "route not found" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "task-legacy",
          status: "completed",
          output: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(retrieveTask("task-legacy")).resolves.toMatchObject({
      id: "task-legacy",
      status: "completed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/frontmind/v1/responses/task-legacy",
    );
  });
});

describe("uploadFile", () => {
  const uploadedAt = Date.parse("2026-08-04T00:00:00.000Z");
  const expiresAt = Date.parse("2026-09-03T00:00:00.000Z");

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

    await vi.advanceTimersByTimeAsync(FILE_UPLOAD_STALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(upload).rejects.toThrow("长时间没有进度");
  });

  it("encodes a Chinese and Emoji capture filename as an ASCII-safe header", async () => {
    const signedUrl =
      "https://uploads.example/signed-unicode?X-Amz-Signature=unicode";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "file-unicode",
        filename: "客户补充图😀.png",
        upload_url: signedUrl,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = new Map<string, string>();
    let requestUrl = "";
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
      send() {
        this.status = 200;
        this.responseText = JSON.stringify({ uploadedAt, expiresAt });
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["png"], "客户补充图😀.png", { type: "image/png" }),
        undefined,
        { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
        {
          captureLocalCopy: true,
          captureFilename: "客户补充图😀.png",
        },
      ),
    ).resolves.toMatchObject({ fileId: "file-unicode" });

    expect(requestUrl).toContain("capture_file_id=file-unicode");
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toBe(
      encodeURIComponent("客户补充图😀.png"),
    );
    expect(headers.get("X-FrontMind-Capture-Filename-UTF8")).toMatch(
      /^[\x20-\x7e]+$/u,
    );
  });

  it("creates one file record and reuses the durable proxy across transient PUT retries", async () => {
    const signedUrl =
      "https://uploads.example/signed-one?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "file-one",
        filename: "report.pdf",
        upload_url: signedUrl,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const requests: Array<{ method: string; url: string }> = [];
    const outcomes = ["error", "error", "load"] as const;
    let nextOutcome = 0;

    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private method = "";
      private url = "";
      private listeners = new Map<string, () => void>();

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      setRequestHeader() {}

      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }

      send() {
        requests.push({ method: this.method, url: this.url });
        const outcome = outcomes[nextOutcome++];
        if (outcome === "load") {
          this.status = 200;
          this.responseText = JSON.stringify({ uploadedAt, expiresAt });
        }
        queueMicrotask(() => this.listeners.get(outcome)?.());
      }
    }

    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(
        new File(["pdf"], "report.pdf", { type: "application/pdf" }),
        undefined,
        {
          maxRetries: 1,
          initialDelay: 0,
          maxDelay: 0,
        },
      ),
    ).resolves.toEqual({
      fileId: "file-one",
      filename: "report.pdf",
      uploadedAt,
      expiresAt,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v1/files",
      expect.objectContaining({ method: "POST" }),
    );
    const durableProxyUrl = `/api/frontmind/proxy-upload?target=${encodeURIComponent(signedUrl)}&capture_file_id=file-one`;
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => ({
        method: "PUT",
        url: durableProxyUrl,
      })),
    );
  });

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

  it("does not retry or expose raw storage XML after a permanent proxy rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "file-two",
        filename: "Logo.png",
        upload_url:
          "https://uploads.example/logo.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let requestCount = 0;
    class MockXMLHttpRequest {
      status = 0;
      statusText = "";
      responseText = "";
      upload = { addEventListener: vi.fn() };
      private listeners = new Map<string, () => void>();

      open() {}
      setRequestHeader() {}
      addEventListener(event: string, listener: () => void) {
        this.listeners.set(event, listener);
      }
      send() {
        requestCount += 1;
        if (requestCount === 1) {
          queueMicrotask(() => this.listeners.get("error")?.());
          return;
        }
        this.status = 400;
        this.responseText = JSON.stringify({
          error: {
            message: "上传地址无效或已失效，请重新选择文件后重试",
          },
        });
        queueMicrotask(() => this.listeners.get("load")?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);

    await expect(
      uploadFile(new File(["png"], "Logo.png", { type: "image/png" })),
    ).rejects.toThrow("上传地址无效或已失效");
    expect(requestCount).toBe(2);
  });
});
