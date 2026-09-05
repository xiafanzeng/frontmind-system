import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectKnowledgeArchiveDescriptors } from "./knowledge-base-artifact";
import {
  appendManusV2KnowledgeBaseOperationContract,
  buildManusV2CreateTaskBody,
  buildManusV2KnowledgeBaseStructuredOutputSchema,
  buildManusV2MessageContent,
  classifyManusV2ProviderFileMime,
  classifyManusV2StructuredResultEnvelope,
  latestManusV2WaitingDetail,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  isManusV2ProviderFileMimeUsable,
  manusV2EventsContainOperationToken,
  manusV2EventMatchesGeneralChatRequest,
  normalizeManusV2Output,
} from "./manus-v2-client";

afterEach(() => vi.restoreAllMocks());

function transportFailure(
  code: string,
  options: { bytesWritten?: number; reusedSocket?: boolean } = {},
) {
  const error = Object.assign(new Error("transport failed"), {
    code,
    request: {
      ...(options.bytesWritten === undefined
        ? {}
        : { socket: { bytesWritten: options.bytesWritten } }),
      ...(options.reusedSocket === undefined
        ? {}
        : { reusedSocket: options.reusedSocket }),
    },
  });
  return error;
}

describe("ManusV2Client", () => {
  const operationContract = {
    operationToken: "op-1",
    turnId: "turn-1",
    generation: 2,
    baseRevision: 7,
    action: "confirm" as const,
    fromLeafId: "leaf-7",
    expectContentCompleted: false,
    requiresManifest: false,
  };

  it("pins production Gateway construction to the official root origin", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(
        () =>
          new ManusV2Client({
            baseUrl: "https://api.manus.ai",
            apiKey: "secret",
          }),
      ).not.toThrow();
      for (const baseUrl of [
        "https://api.manus.ai/custom",
        "https://api.example.test",
      ]) {
        expect(() => new ManusV2Client({ baseUrl, apiKey: "secret" })).toThrow(
          "Unsafe Manus v2 production base URL",
        );
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("creates once and sends every continuation to the same task", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post");
    post
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          request_id: "req-create",
          task_id: "task-canonical",
          task_title: "FrontMind KB build-1 g1",
          task_url: "https://manus.im/app/task-canonical",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          request_id: "req-send",
          task_id: "task-canonical",
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const structuredOutputSchema =
      buildManusV2KnowledgeBaseStructuredOutputSchema(operationContract);

    const created = await client.createTask({
      prompt: "start operation-token-1",
      title: "FrontMind KB build-1 g1",
      attachments: [{ file_id: "file-1", filename: "facts.pdf" }],
      structuredOutputSchema,
    });
    const sent = await client.sendMessage({
      taskId: created.taskId,
      prompt: "confirm operation-token-2",
      structuredOutputSchema,
    });

    expect(sent.taskId).toBe("task-canonical");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v2/task.create",
    );
    expect(post.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/v2/task.sendMessage",
    );
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      task_id: "task-canonical",
      structured_output_schema: structuredOutputSchema,
    });
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      structured_output_schema: structuredOutputSchema,
    });
    expect(post.mock.calls[0]?.[2]?.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("rejects a send acknowledgement that changes canonical task identity", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: { ok: true, task_id: "different-task" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.sendMessage({ taskId: "canonical-task", prompt: "continue" }),
    ).rejects.toMatchObject({ code: "TASK_ID_CONFLICT" });
  });

  it("confirms the exact pending event on the canonical task", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        request_id: "req-confirm",
        task_id: "canonical-task",
        confirmed: true,
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.confirmAction({
        taskId: "canonical-task",
        eventId: "evt-1",
        confirmationInput: { accept: true },
      }),
    ).resolves.toMatchObject({
      taskId: "canonical-task",
      eventId: "evt-1",
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v2/task.confirmAction",
      {
        task_id: "canonical-task",
        event_id: "evt-1",
        input: { accept: true },
      },
      { headers: { "Content-Type": "application/json" } },
    );
  });

  it("accepts the official task.stop success envelope without task identity", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: { ok: true, request_id: "req-stop" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(client.stopTask("canonical-task")).resolves.toEqual({
      taskId: "canonical-task",
      requestId: "req-stop",
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v2/task.stop",
      { task_id: "canonical-task" },
      { headers: { "Content-Type": "application/json" } },
    );
  });

  it("accepts only the official task.delete identity and deleted acknowledgement", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        request_id: "req-delete",
        id: "canonical-task",
        deleted: true,
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(client.deleteTask("canonical-task")).resolves.toEqual({
      taskId: "canonical-task",
      requestId: "req-delete",
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v2/task.delete",
      { task_id: "canonical-task" },
      { headers: { "Content-Type": "application/json" } },
    );
  });

  it.each([
    ["omits id", { ok: true, deleted: true }],
    [
      "uses a non-contract task_id alias",
      { ok: true, task_id: "canonical-task", deleted: true },
    ],
    ["omits deleted", { ok: true, id: "canonical-task" }],
    [
      "does not confirm deletion",
      { ok: true, id: "canonical-task", deleted: false },
    ],
    ["changes task identity", { ok: true, id: "other-task", deleted: true }],
  ])(
    "treats a task.delete 2xx response that %s as outcome unknown",
    async (_label, data) => {
      vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
        status: 200,
        data,
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });

      await expect(client.deleteTask("canonical-task")).rejects.toMatchObject({
        outcomeUnknown: true,
        retryable: false,
      });
    },
  );

  it.each([
    ["has no task identity", { ok: true, confirmed: true }],
    [
      "changes canonical task identity",
      { ok: true, task_id: "other-task", confirmed: true },
    ],
    [
      "does not acknowledge confirmation",
      { ok: true, task_id: "canonical-task", confirmed: false },
    ],
  ])(
    "treats a task.confirmAction 2xx response that %s as outcome unknown",
    async (_label, data) => {
      vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
        status: 200,
        data,
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      await expect(
        client.confirmAction({
          taskId: "canonical-task",
          eventId: "evt-1",
          confirmationInput: { accept: true },
        }),
      ).rejects.toMatchObject({
        outcomeUnknown: true,
        retryable: false,
      });
    },
  );

  it("extracts only the newest waiting event and its confirmation schema", () => {
    expect(
      latestManusV2WaitingDetail([
        {
          id: "old",
          type: "status_update",
          timestamp: 1,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "evt-old",
              waiting_for_event_type: "messageAskUser",
            },
          },
        },
        {
          id: "new",
          type: "status_update",
          timestamp: 2,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "evt-new",
              waiting_for_event_type: "mapreduceAction",
              confirm_input_schema: {
                type: "object",
                properties: { accept: { type: "boolean" } },
              },
            },
          },
        },
      ]),
    ).toMatchObject({
      eventId: "evt-new",
      eventType: "mapreduceAction",
      statusEventId: "new",
    });
  });

  it("settles equal-timestamp state from Provider rank instead of event id", () => {
    const events = [
      {
        id: "zzz-older-wait",
        type: "status_update",
        timestamp: 10,
        providerOriginalRank: 0,
        status_update: {
          agent_status: "waiting",
          status_detail: {
            waiting_for_event_id: "wait-old",
            waiting_for_event_type: "messageAskUser",
          },
        },
      },
      {
        id: "000-newer-stop",
        type: "status_update",
        timestamp: 10,
        providerOriginalRank: 1,
        status_update: { agent_status: "stopped" },
      },
    ];

    expect(latestManusV2TaskState(events)).toBe("stopped");
    expect(latestManusV2WaitingDetail(events)).toBeNull();
  });

  it("marks side-effect transport loss unknown and never labels it retryable", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(new Error("socket reset"));
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const error = await client
      .createTask({ prompt: "start", title: "unique title" })
      .catch((value) => value);
    expect(error).toBeInstanceOf(ManusV2ApiError);
    expect(error).toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
    });
    expect(post).toHaveBeenCalledOnce();
  });

  it("never retries a task message transport failure", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(transportFailure("EAI_AGAIN"));
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.sendMessage({ taskId: "task-1", prompt: "continue" }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
      transportCause: "dns_temporary",
    });
    expect(post).toHaveBeenCalledOnce();
  });

  it("keeps the shared file-create default single-attempt even for a DNS failure", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(transportFailure("EAI_AGAIN"));
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(client.createFile("facts.pdf")).rejects.toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
      transportCause: "dns_temporary",
      transportPhase: "dns",
      transportAttempt: 1,
      transportBytesWritten: null,
    });
    expect(post).toHaveBeenCalledOnce();
  });

  it("recognizes a Node DNS errno nested beneath a generic Axios code", async () => {
    const wrappedDnsError = Object.assign(new Error("wrapped transport"), {
      code: "ERR_NETWORK",
      cause: { code: "EAI_AGAIN" },
      request: {},
    });
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(wrappedDnsError);
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.createFile("facts.pdf", {
        retryPolicy: "response_logic_pre_dispatch_only",
        sleep,
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_PRE_DISPATCH_RETRY_EXHAUSTED",
      transportCause: "dns_temporary",
      transportAttempt: 3,
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("retries only an opted-in file intent after pre-dispatch DNS failures", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValueOnce(transportFailure("EAI_AGAIN"))
      .mockRejectedValueOnce(transportFailure("EAI_AGAIN"))
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: { id: "file-after-dns", filename: "facts.pdf" },
          upload_url: "https://uploads.example.test/after-dns",
          upload_expires_at: nowSeconds + 180,
        },
      });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-after-dns",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: nowSeconds + 48 * 3600,
        },
      },
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        fileCreateRetryPolicy: "response_logic_pre_dispatch_only",
        sleep,
      }),
    ).resolves.toMatchObject({ fileId: "file-after-dns" });
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(250);
    expect(sleep.mock.calls[0]?.[0]).toBeLessThan(500);
    expect(sleep.mock.calls[1]?.[0]).toBeGreaterThanOrEqual(1_000);
    expect(sleep.mock.calls[1]?.[0]).toBeLessThan(1_500);
    const serializedWarnings = JSON.stringify(warning.mock.calls);
    expect(serializedWarnings).toContain("dns_temporary");
    expect(serializedWarnings).toContain("transportAttempt");
    expect(serializedWarnings).not.toContain("transport failed");
    expect(serializedWarnings).not.toContain("facts.pdf");
    expect(serializedWarnings).not.toContain("secret");
    expect(serializedWarnings).not.toContain("uploads.example.test");
  });

  it("returns an outcome-known retryable error after three safe DNS attempts", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(transportFailure("ENOTFOUND"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        fileCreateRetryPolicy: "response_logic_pre_dispatch_only",
        sleep,
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_PRE_DISPATCH_RETRY_EXHAUSTED",
      outcomeUnknown: false,
      retryable: true,
      transportCause: "dns_not_found",
      transportPhase: "dns",
      transportAttempt: 3,
      transportBytesWritten: null,
    });
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("never retries an ambiguous reset even when file intent retry is opted in", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(transportFailure("ECONNRESET", { bytesWritten: 128 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        fileCreateRetryPolicy: "response_logic_pre_dispatch_only",
        sleep,
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
      transportCause: "connection_reset",
      transportPhase: "request",
      transportAttempt: 1,
      transportBytesWritten: 128,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries a DNS-labelled failure after any request bytes were written", async () => {
    const post = vi
      .spyOn(axios.Axios.prototype, "post")
      .mockRejectedValue(transportFailure("EAI_AGAIN", { bytesWritten: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        fileCreateRetryPolicy: "response_logic_pre_dispatch_only",
        sleep,
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
      transportCause: "dns_temporary",
      transportAttempt: 1,
      transportBytesWritten: 1,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty 2xx body", undefined],
    ["a malformed 2xx body", "not-an-object"],
    ["a 2xx body without task identity", { ok: true }],
  ])("treats task.create %s as outcome unknown", async (_label, data) => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data,
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("treats a task.sendMessage 2xx body without task identity as outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: { ok: true, request_id: "req-send" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.sendMessage({ taskId: "canonical-task", prompt: "continue" }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("treats a non-explicit side-effect error response as outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 503,
      data: { code: "TEMPORARY" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "TEMPORARY",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("keeps an explicit provider rejection distinct from outcome unknown", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 422,
      data: { ok: false, code: "INVALID_INPUT" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      outcomeUnknown: false,
      retryable: false,
    });
  });

  it("treats an HTTP 400 validation body without ok=false as a known rejection", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 400,
      data: { code: "invalid_argument" },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_argument",
      outcomeUnknown: false,
      retryable: false,
    });
  });

  it("captures only allowlisted request and validation coordinates from an explicit rejection", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 400,
      headers: { "x-request-id": "req-create-400:01" },
      data: {
        ok: false,
        error: {
          code: "invalid_argument",
          field: "agent_profile",
          path: "request.agent_profile[0]",
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      outcomeUnknown: false,
      providerRequestId: "req-create-400:01",
      providerField: "agent_profile",
      providerPath: "agent_profile",
    });
  });

  it("drops malformed provider diagnostics instead of retaining response text", async () => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 400,
      headers: { "x-request-id": "request id with unsafe text" },
      data: {
        ok: false,
        request_id: "../../unsafe request id",
        error: {
          code: "invalid_argument",
          field: "sk-proj-secret",
          path: "secret.token",
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      outcomeUnknown: false,
      providerRequestId: null,
      providerField: null,
      providerPath: null,
    });
  });

  it("uses Retry-After only when Manus explicitly rejected the request and supplied it", async () => {
    const post = vi.spyOn(axios.Axios.prototype, "post");
    post
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "7" },
        data: { ok: false, code: "RATE_LIMITED" },
      })
      .mockResolvedValueOnce({
        status: 503,
        headers: { "retry-after": "7" },
        data: { code: "AMBIGUOUS" },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      outcomeUnknown: false,
      retryable: true,
      retryAfterMs: 7_000,
    });

    await expect(
      client.createTask({ prompt: "start", title: "unique title" }),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      retryAfterMs: null,
    });
  });

  it("paginates and deduplicates event ids while preserving chronological output", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "e2",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "second" },
            },
            {
              id: "e1",
              type: "user_message",
              timestamp: 10,
              user_message: {
                content:
                  'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-1"}',
              },
            },
          ],
          has_more: true,
          next_cursor: "page-2",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "e2",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "second" },
            },
            {
              id: "e3",
              type: "status_update",
              timestamp: 30,
              status_update: { agent_status: "stopped" },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const events = await client.listAllMessages({
      taskId: "canonical-task",
      order: "asc",
    });

    expect(events.map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
    expect(
      manusV2EventsContainOperationToken(events, "operation-token-1"),
    ).toBe(true);
    expect(latestManusV2TaskState(events)).toBe("stopped");
    expect(normalizeManusV2Output(events)).toMatchObject([
      { id: "e2", role: "assistant", text: "second" },
    ]);
    expect(get.mock.calls[1]?.[1]?.params).toMatchObject({ cursor: "page-2" });
  });

  it("reads newest pages first and stops once the current operation marker is found", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "result",
              type: "assistant_message",
              timestamp: 30,
              assistant_message: { content: "current result" },
            },
          ],
          has_more: true,
          next_cursor: "marker-page",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "marker",
              type: "user_message",
              timestamp: 20,
              user_message: {
                content:
                  'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"current-operation"}',
              },
            },
          ],
          // Older shared-task history exists, but is outside this operation.
          has_more: true,
          next_cursor: "older-history",
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    const events = await client.listAllMessages({
      taskId: "canonical-task",
      order: "desc",
      stopAfterOperationToken: "current-operation",
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]?.[1]?.params).toMatchObject({ order: "desc" });
    expect(get.mock.calls[1]?.[1]?.params).toMatchObject({
      order: "desc",
      cursor: "marker-page",
    });
    expect(events.map((event) => event.id)).toEqual(["marker", "result"]);
  });

  it("uses Provider order rather than opaque ids for equal-timestamp messages", async () => {
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValueOnce({
      status: 200,
      data: {
        ok: true,
        task_id: "canonical-task",
        // Desc is the production default: the first event is newer even
        // though its opaque id sorts before the second one.
        messages: [
          {
            id: "000-newer-opaque-id",
            type: "assistant_message",
            timestamp: 20,
            assistant_message: { content: "newer" },
          },
          {
            id: "zzz-older-opaque-id",
            type: "assistant_message",
            timestamp: 20,
            assistant_message: { content: "older" },
          },
        ],
        has_more: false,
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    const events = await client.listAllMessages({ taskId: "canonical-task" });

    expect(events.map((event) => event.id)).toEqual([
      "zzz-older-opaque-id",
      "000-newer-opaque-id",
    ]);
    expect(events.map((event) => event.providerOriginalRank)).toEqual([0, 1]);
    expect(normalizeManusV2Output(events).map((item) => item.content)).toEqual([
      "older",
      "newer",
    ]);
  });

  it("defaults to newest-first pagination and keeps the newest repeated event payload", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "updated-event",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "newest payload" },
            },
          ],
          has_more: true,
          next_cursor: "older-page",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "canonical-task",
          messages: [
            {
              id: "updated-event",
              type: "assistant_message",
              timestamp: 20,
              assistant_message: { content: "stale payload" },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    const events = await client.listAllMessages({ taskId: "canonical-task" });

    expect(get.mock.calls[0]?.[1]?.params).toMatchObject({ order: "desc" });
    expect(events).toHaveLength(1);
    expect(events[0]?.assistant_message).toEqual({
      content: "newest payload",
    });
  });

  it("reconciles unknown create only when title and operation token identify one task", async () => {
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          data: [
            {
              id: "candidate-one",
              title: "unique title",
              created_at: 100,
              task_url: "https://manus.im/app/candidate-one",
            },
            {
              id: "candidate-two",
              title: "unique title",
              created_at: 101,
            },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "candidate-one",
          messages: [
            {
              id: "first-user",
              type: "user_message",
              timestamp: 1,
              user_message: {
                content:
                  'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-1"}',
              },
            },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "candidate-two",
          messages: [
            {
              id: "other-user",
              type: "user_message",
              timestamp: 1,
              user_message: { content: "other operation" },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.findCreatedTask({
      title: "unique title",
      operationToken: "operation-token-1",
      createdAfterSeconds: 90,
      createdBeforeSeconds: 110,
    });
    expect(result.unique?.id).toBe("candidate-one");
    expect(result.candidates).toHaveLength(2);
  });

  it("does not declare an unknown create unique when one candidate matches but another plausible candidate lacks attachment evidence", async () => {
    const bytes = Buffer.from("input image");
    const promptSha256 = createHash("sha256").update("analyze").digest("hex");
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          data: [
            { id: "proven", title: "chat title", created_at: 100 },
            { id: "plausible", title: "chat title", created_at: 101 },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "proven",
          messages: [
            {
              id: "proven-user",
              type: "user_message",
              timestamp: 1,
              user_message: {
                content: [
                  { type: "text", text: "analyze" },
                  { type: "file", file_id: "provider-file-1" },
                ],
              },
            },
          ],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "plausible",
          messages: [
            {
              id: "plausible-user",
              type: "user_message",
              timestamp: 1,
              user_message: {
                content: [
                  { type: "text", text: "analyze" },
                  { type: "file", filename: "input.png" },
                ],
              },
            },
          ],
          has_more: false,
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.findCreatedTask({
      title: "chat title",
      promptSha256,
      attachmentFileIds: ["provider-file-1"],
      attachmentManifest: [
        {
          fileId: "provider-file-1",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
          filename: "input.png",
          mimeType: "image/png",
        },
      ],
      createdAfterSeconds: 90,
      createdBeforeSeconds: 110,
    });
    expect(result.matches.map(({ id }) => id)).toEqual(["proven"]);
    expect(result.unresolved.map(({ id }) => id)).toEqual(["plausible"]);
    expect(result.unique).toBeNull();
  });

  it.each([
    ["match then unresolved", ["match", "unresolved"]],
    ["unresolved then match", ["unresolved", "match"]],
  ] as const)(
    "keeps one candidate ambiguous when its events contain %s",
    async (_label, eventOrder) => {
      const bytes = Buffer.from("input image");
      const userEvents = {
        match: {
          id: "matching-user",
          type: "user_message",
          timestamp: 1,
          user_message: {
            content: [
              { type: "text", text: "analyze" },
              { type: "file", file_id: "provider-file-1" },
            ],
          },
        },
        unresolved: {
          id: "unresolved-user",
          type: "user_message",
          timestamp: 2,
          user_message: {
            content: [
              { type: "text", text: "analyze" },
              { type: "file", filename: "input.png" },
            ],
          },
        },
      };
      const get = vi.spyOn(axios.Axios.prototype, "get");
      get
        .mockResolvedValueOnce({
          status: 200,
          data: {
            ok: true,
            data: [
              { id: "mixed-candidate", title: "chat title", created_at: 100 },
            ],
            has_more: false,
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            ok: true,
            task_id: "mixed-candidate",
            messages: eventOrder.map((kind) => userEvents[kind]),
            has_more: false,
          },
        });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      const result = await client.findCreatedTask({
        title: "chat title",
        promptSha256: createHash("sha256").update("analyze").digest("hex"),
        attachmentFileIds: ["provider-file-1"],
        attachmentManifest: [
          {
            fileId: "provider-file-1",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.byteLength,
            filename: "input.png",
            mimeType: "image/png",
          },
        ],
      });
      expect(result.matches.map(({ id }) => id)).toEqual(["mixed-candidate"]);
      expect(result.unresolved.map(({ id }) => id)).toEqual([
        "mixed-candidate",
      ]);
      expect(result.unique).toBeNull();
    },
  );

  it("reconciles a URL-only v2 user event by streamed content evidence", async () => {
    const bytes = Buffer.from("input image");
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          data: [{ id: "url-only", title: "chat title", created_at: 100 }],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          task_id: "url-only",
          messages: [
            {
              id: "url-user",
              type: "user_message",
              timestamp: 1,
              user_message: {
                content: [
                  { type: "text", text: "analyze" },
                  {
                    type: "image",
                    url: "https://files.manuscdn.com/input/image.png?Signature=signed",
                  },
                ],
              },
            },
          ],
          has_more: false,
        },
      });
    const reader = vi.fn(async () => ({
      body: (async function* () {
        yield bytes;
      })(),
      contentLength: bytes.byteLength,
      contentType: "image/png",
    }));
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.findCreatedTask({
      title: "chat title",
      promptSha256: createHash("sha256").update("analyze").digest("hex"),
      attachmentFileIds: ["provider-file-1"],
      attachmentManifest: [
        {
          fileId: "provider-file-1",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
          filename: "local-name.png",
          mimeType: "image/png",
        },
      ],
      attachmentEvidenceReader: reader,
    });
    expect(result.unique?.id).toBe("url-only");
    expect(result.unresolved).toEqual([]);
    expect(reader).toHaveBeenCalledOnce();
  });

  it("matches operation tokens as exact contract values, never substrings", () => {
    const event = {
      id: "u1",
      type: "user_message",
      timestamp: 1,
      user_message: {
        content:
          'prefix operation-token-1-suffix\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"operation-token-10"}',
      },
    };
    expect(
      manusV2EventsContainOperationToken([event], "operation-token-1"),
    ).toBe(false);
    expect(
      manusV2EventsContainOperationToken([event], "operation-token-10"),
    ).toBe(true);
  });

  it("matches ordinary-chat reconciliation by exact prompt hash and file set", () => {
    const event = {
      id: "u-general-chat",
      type: "user_message",
      timestamp: 1,
      user_message: {
        content: [
          { type: "text", text: "analyze this" },
          { type: "file", file_id: "file-b" },
          { type: "file", file_id: "file-a" },
        ],
      },
    };
    const promptSha256 = createHash("sha256")
      .update("analyze this")
      .digest("hex");
    expect(
      manusV2EventMatchesGeneralChatRequest(event, {
        promptSha256,
        attachmentFileIds: ["file-a", "file-b"],
      }),
    ).toBe(true);
    expect(
      manusV2EventMatchesGeneralChatRequest(event, {
        promptSha256,
        attachmentFileIds: ["file-a"],
      }),
    ).toBe(false);
  });

  it.each([
    [
      "missing file identity",
      {
        ok: true,
        file: { filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: 2_000_000_000,
      },
    ],
    [
      "missing upload URL",
      {
        ok: true,
        file: { id: "file-1", filename: "facts.pdf" },
        upload_expires_at: 2_000_000_000,
      },
    ],
  ])("treats file.upload 2xx %s as outcome unknown", async (_label, data) => {
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data,
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(client.createFile("facts.pdf")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      outcomeUnknown: true,
      retryable: false,
    });
  });

  it("accepts a file only after exact uploaded bytes and sufficient lifetime", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-1", filename: "facts.pdf", created_at: now },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    const get = vi.spyOn(axios.Axios.prototype, "get");
    get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-1",
            filename: "facts.pdf",
            status: "pending",
            bytes: null,
            expires_at: now + 48 * 3600,
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-1",
            filename: "facts.pdf",
            status: "uploaded",
            bytes: 3,
            content_type: "application/pdf; charset=binary",
            expires_at: now + 48 * 3600,
          },
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    const result = await client.uploadFile({
      filename: "facts.pdf",
      bytes: Buffer.from("abc"),
      contentType: "application/pdf",
      sleep: async () => undefined,
    });
    expect(result.detail).toMatchObject({
      fileId: "file-1",
      status: "uploaded",
      bytes: 3,
    });
    expect(post).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty(
      "x-manus-api-key",
    );
  });

  it("confirms an exact 45,119,307-byte file after a transient detail failure without another PUT", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const bytes = Buffer.alloc(45_119_307);
    const infoLog = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-large", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/large-signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    const get = vi
      .spyOn(axios.Axios.prototype, "get")
      .mockRejectedValueOnce(new Error("detail timed out"))
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-large",
            filename: "facts.pdf",
            status: "uploaded",
            bytes: 45_119_307,
            content_type: "Application/PDF; charset=binary",
            expires_at: now + 48 * 3600,
          },
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes,
        contentType: "application/pdf",
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      fileId: "file-large",
      detail: { status: "uploaded", bytes: 45_119_307 },
    });
    expect(post).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
    const serializedLogs = JSON.stringify(infoLog.mock.calls);
    expect(serializedLogs).not.toContain("facts.pdf");
    expect(serializedLogs).not.toContain("file-large");
    expect(serializedLogs).not.toContain("large-signed");
    expect(serializedLogs).not.toContain("secret");
  });

  it("journals confirmation unknown and never creates a second file when readiness expires", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-still-pending", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/pending-signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-still-pending",
          filename: "facts.pdf",
          status: "pending",
          bytes: null,
          content_type: null,
          expires_at: now + 48 * 3600,
        },
      },
    });
    const confirmationUnknown = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        readinessDeadlineMs: 1,
        detailAttemptTimeoutMs: 1,
        sleep: async () => undefined,
        observer: { onConfirmationUnknown: confirmationUnknown },
      }),
    ).rejects.toMatchObject({
      code: "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
      outcomeUnknown: true,
      retryable: false,
    });
    expect(confirmationUnknown).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it.each([408, 425, 429, 503])(
    "retries a transient file.detail HTTP %s on the same file id",
    async (status) => {
      const now = Math.floor(Date.now() / 1_000);
      const get = vi
        .spyOn(axios.Axios.prototype, "get")
        .mockResolvedValueOnce({ status, data: { ok: false } })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            ok: true,
            file: {
              id: "file-retry-detail",
              filename: "facts.pdf",
              status: "uploaded",
              bytes: 3,
              content_type: "application/pdf",
              expires_at: now + 48 * 3600,
            },
          },
        });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });

      await expect(
        client.waitForExactProviderFile({
          fileId: "file-retry-detail",
          filename: "facts.pdf",
          expectedBytes: 3,
          expectedContentType: "application/pdf",
          sleep: async () => undefined,
        }),
      ).resolves.toMatchObject({ status: "uploaded" });
      expect(get).toHaveBeenCalledTimes(2);
    },
  );

  it("retries an invalid file.detail envelope before accepting exact proof", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const get = vi
      .spyOn(axios.Axios.prototype, "get")
      .mockResolvedValueOnce({ status: 200, data: { ok: true } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-invalid-envelope",
            filename: "facts.pdf",
            status: "uploaded",
            bytes: 3,
            content_type: "application/pdf",
            expires_at: now + 48 * 3600,
          },
        },
      });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.waitForExactProviderFile({
        fileId: "file-invalid-envelope",
        filename: "facts.pdf",
        expectedBytes: 3,
        expectedContentType: "application/pdf",
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "uploaded" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["generated.zip", "application/zip"],
    ["instructions.txt", "text/plain"],
    [
      "presentation.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
    ],
    [
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
    ],
    [
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
    ],
  ])(
    "accepts provider generic binary MIME for a byte-exact %s",
    async (
      filename,
      expectedContentType,
      providerContentType = "application/octet-stream",
    ) => {
      const now = Math.floor(Date.now() / 1_000);
      const get = vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-generic-mime",
            filename,
            status: "uploaded",
            bytes: 3,
            content_type: providerContentType,
            expires_at: now + 48 * 3600,
          },
        },
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });

      await expect(
        client.waitForExactProviderFile({
          fileId: "file-generic-mime",
          filename,
          expectedBytes: 3,
          expectedContentType,
          sleep: async () => undefined,
        }),
      ).resolves.toMatchObject({ contentType: providerContentType });
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["application/octet-stream", "generic"],
    ["binary/octet-stream", "generic"],
    ["text/html", "different"],
    [null, "missing"],
  ] as const)(
    "treats KB frozen-source MIME %s as advisory (%s)",
    async (providerContentType, disposition) => {
      expect(
        classifyManusV2ProviderFileMime({
          filename: "facts.pdf",
          expectedContentType: "application/pdf",
          providerContentType,
        }),
      ).toBe(disposition);
      expect(
        isManusV2ProviderFileMimeUsable({
          filename: "facts.pdf",
          expectedContentType: "application/pdf",
          providerContentType,
          confirmationPolicy: "kb_frozen_source_advisory",
        }),
      ).toBe(true);

      const now = Math.floor(Date.now() / 1_000);
      vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
        status: 200,
        data: {
          ok: true,
          file: {
            id: "file-kb-advisory",
            filename: "facts.pdf",
            status: "uploaded",
            bytes: 3,
            content_type: providerContentType,
            expires_at: now + 48 * 3600,
          },
        },
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      await expect(
        client.waitForExactProviderFile({
          fileId: "file-kb-advisory",
          filename: "facts.pdf",
          expectedBytes: 3,
          expectedContentType: "application/pdf",
          confirmationPolicy: "kb_frozen_source_advisory",
          sleep: async () => undefined,
        }),
      ).resolves.toMatchObject({ status: "uploaded" });
    },
  );

  it("keeps malformed provider content_type diagnostic instead of rejecting file.detail", async () => {
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-malformed-mime",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: { unexpected: true },
          expires_at: 2_000_000_000,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.fileDetail("file-malformed-mime"),
    ).resolves.toMatchObject({
      contentType: null,
      contentTypeParseStatus: "invalid",
    });
    await expect(
      client.waitForExactProviderFile({
        fileId: "file-malformed-mime",
        filename: "facts.pdf",
        expectedBytes: 3,
        expectedContentType: "application/pdf",
        confirmationPolicy: "kb_frozen_source_advisory",
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "uploaded" });
  });

  it.each([
    [
      "identity",
      {
        id: "file-exact",
        filename: "other.pdf",
        status: "uploaded",
        bytes: 3,
        content_type: "application/pdf",
      },
      "FILE_IDENTITY_CONFLICT",
    ],
    [
      "bytes",
      {
        id: "file-exact",
        filename: "facts.pdf",
        status: "uploaded",
        bytes: 4,
        content_type: "application/pdf",
      },
      "FILE_BYTES_CONFLICT",
    ],
    [
      "MIME",
      {
        id: "file-exact",
        filename: "facts.pdf",
        status: "uploaded",
        bytes: 3,
        content_type: "text/plain",
      },
      "FILE_MIME_CONFLICT",
    ],
    [
      "generic binary MIME for a PDF",
      {
        id: "file-exact",
        filename: "facts.pdf",
        status: "uploaded",
        bytes: 3,
        content_type: "application/octet-stream",
      },
      "FILE_MIME_CONFLICT",
    ],
    [
      "deleted status",
      {
        id: "file-exact",
        filename: "facts.pdf",
        status: "deleted",
        bytes: null,
        content_type: null,
      },
      "FILE_UNUSABLE",
    ],
    [
      "error status",
      {
        id: "file-exact",
        filename: "facts.pdf",
        status: "error",
        bytes: null,
        content_type: null,
      },
      "FILE_UNUSABLE",
    ],
  ] as const)(
    "fails an exact confirmation %s immediately",
    async (_label, file, code) => {
      const now = Math.floor(Date.now() / 1_000);
      const get = vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
        status: 200,
        data: { ok: true, file: { ...file, expires_at: now + 48 * 3600 } },
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });

      await expect(
        client.waitForExactProviderFile({
          fileId: "file-exact",
          filename: "facts.pdf",
          expectedBytes: 3,
          expectedContentType: "application/pdf",
          sleep: async () => undefined,
        }),
      ).rejects.toMatchObject({ code, outcomeUnknown: false });
      expect(get).toHaveBeenCalledOnce();
    },
  );

  it("awaits durable candidate and PUT boundaries before advancing", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-journaled", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const order: string[] = [];
    vi.spyOn(axios, "put").mockImplementation(async () => {
      order.push("put");
      return { status: 200 } as any;
    });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-journaled",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await client.uploadFile({
      filename: "facts.pdf",
      bytes: Buffer.from("abc"),
      contentType: "application/pdf",
      observer: {
        onCandidateCreated: async () => {
          order.push("candidate");
        },
        onPutStarted: async () => {
          order.push("put_sending");
        },
        onPutAccepted: async () => {
          order.push("put_accepted");
        },
      },
    });
    expect(order).toEqual(["candidate", "put_sending", "put", "put_accepted"]);
  });

  it("records PUT response loss against the known candidate", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-ambiguous", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    vi.spyOn(axios, "put").mockRejectedValue(new Error("socket closed"));
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-ambiguous",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const unknown = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        observer: { onPutOutcomeUnknown: unknown },
      }),
    ).resolves.toMatchObject({
      fileId: "file-ambiguous",
      detail: { status: "uploaded", bytes: 3 },
    });
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-ambiguous" }),
    );
  });

  it("preserves PUT outcome-unknown when its durable observer fails", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-ambiguous-journal", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    vi.spyOn(axios, "put").mockRejectedValue(new Error("socket closed"));
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-ambiguous-journal",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const unknown = vi
      .fn()
      .mockRejectedValue(new Error("provider lease journal unavailable"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    try {
      await expect(
        client.uploadFile({
          filename: "facts.pdf",
          bytes: Buffer.from("abc"),
          contentType: "application/pdf",
          observer: { onPutOutcomeUnknown: unknown },
        }),
      ).resolves.toMatchObject({
        fileId: "file-ambiguous-journal",
        detail: { status: "uploaded", bytes: 3 },
      });
      expect(errorLog).toHaveBeenCalledWith(
        "[Manus v2] file outcome journal failed",
        expect.objectContaining({
          diagnosticCode: "MANUS_V2_FILE_OUTCOME_JOURNAL_FAILED",
        }),
      );
    } finally {
      errorLog.mockRestore();
    }
    expect(unknown).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-ambiguous-journal" }),
    );
  });

  it("retries explicit PUT throttles on the same signed URL and honors Retry-After", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-throttled", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi
      .spyOn(axios, "put")
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "0" },
      })
      .mockResolvedValueOnce({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-throttled",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const retryWait = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        sleep,
        observer: { onPutRetryWait: retryWait },
      }),
    ).resolves.toMatchObject({ fileId: "file-throttled" });
    expect(put).toHaveBeenCalledTimes(2);
    expect(retryWait).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "file-throttled" }),
      expect.objectContaining({
        status: 429,
        retryAfterMs: 0,
        rejectionCount: 1,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("streams large uploads with an exact length and opens a fresh stream for every PUT retry", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const byteLength = 64 * 1024 * 1024;
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-streamed", filename: "template.zip" },
        upload_url: "https://uploads.example.test/streamed-signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi
      .spyOn(axios, "put")
      .mockResolvedValueOnce({
        status: 503,
        headers: { "retry-after": "0" },
      })
      .mockResolvedValueOnce({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-streamed",
          filename: "template.zip",
          status: "uploaded",
          bytes: byteLength,
          content_type: "application/zip",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const openedStreams: Readable[] = [];
    const createReadStream = vi.fn(() => {
      const stream = Readable.from(["fresh-stream"]);
      openedStreams.push(stream);
      return stream;
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "template.zip",
        byteLength,
        createReadStream,
        contentType: "application/zip",
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      fileId: "file-streamed",
      detail: { status: "uploaded", bytes: byteLength },
    });

    expect(createReadStream).toHaveBeenCalledTimes(2);
    expect(openedStreams).toHaveLength(2);
    expect(openedStreams[0]).not.toBe(openedStreams[1]);
    expect(put.mock.calls[0]?.[1]).toBe(openedStreams[0]);
    expect(put.mock.calls[1]?.[1]).toBe(openedStreams[1]);
    expect(put.mock.calls[0]?.[2]?.headers).toMatchObject({
      "Content-Length": String(byteLength),
      "Content-Type": "application/zip",
    });
    expect(put.mock.calls[0]?.[2]?.maxBodyLength).toBe(byteLength);
  });

  it("does not retry a PUT response loss while reconciling by GET", async () => {
    const now = Math.floor(Date.now() / 1_000);
    vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: { id: "file-unknown-once", filename: "facts.pdf" },
        upload_url: "https://uploads.example.test/signed",
        upload_expires_at: now + 180,
      },
    });
    const put = vi
      .spyOn(axios, "put")
      .mockRejectedValue(new Error("response lost"));
    const get = vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-unknown-once",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ fileId: "file-unknown-once" });
    expect(put).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it("resumes a known candidate by detail without POST or PUT", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put");
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-existing",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });
    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        existingCandidate: {
          fileId: "file-existing",
          filename: "facts.pdf",
        },
      }),
    ).resolves.toMatchObject({
      fileId: "file-existing",
      detail: { status: "uploaded", bytes: 3 },
    });
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("resumes the first PUT for a durable candidate with rejection count zero", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const post = vi.spyOn(axios.Axios.prototype, "post");
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "file-before-first-put",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          content_type: "application/pdf",
          expires_at: now + 48 * 3600,
        },
      },
    });
    const putStarted = vi.fn().mockResolvedValue(undefined);
    const client = new ManusV2Client({
      baseUrl: "https://api.example.test",
      apiKey: "secret",
    });

    await expect(
      client.uploadFile({
        filename: "facts.pdf",
        bytes: Buffer.from("abc"),
        contentType: "application/pdf",
        existingCandidate: {
          fileId: "file-before-first-put",
          filename: "facts.pdf",
          uploadUrl: "https://uploads.example.test/signed-first-put",
          uploadExpiresAt: now + 180,
          resumePutRejectionCount: 0,
        },
        observer: { onPutStarted: putStarted },
      }),
    ).resolves.toMatchObject({ fileId: "file-before-first-put" });

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(putStarted).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing file", { ok: true }],
    [
      "wrong id",
      {
        ok: true,
        file: {
          id: "other-file",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: 3,
          expires_at: 2_000_000_000,
        },
      },
    ],
    [
      "invalid bytes",
      {
        ok: true,
        file: {
          id: "file-existing",
          filename: "facts.pdf",
          status: "uploaded",
          bytes: "not-a-number",
          expires_at: 2_000_000_000,
        },
      },
    ],
  ])(
    "treats file.detail %s as ambiguous, never as replacement proof",
    async (_label, data) => {
      vi.spyOn(axios.Axios.prototype, "get").mockResolvedValue({
        status: 200,
        data,
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      await expect(client.fileDetail("file-existing")).rejects.toMatchObject({
        outcomeUnknown: true,
        retryable: false,
      });
    },
  );

  it("builds v2 multipart content with text first and file ids", () => {
    expect(
      buildManusV2MessageContent("prompt", [
        { file_id: "f1", filename: "a.pdf" },
      ]),
    ).toEqual([
      { type: "text", text: "prompt" },
      { type: "file", file_id: "f1", filename: "a.pdf" },
    ]);
  });

  it("pins locale, privacy, and non-interactive execution on v2 task.create", () => {
    expect(
      buildManusV2CreateTaskBody({
        prompt: "materialize the complete bundle",
        locale: "zh-CN",
        interactiveMode: false,
        // A stale caller preference must not be able to override the global
        // task-list policy even at runtime.
        hideInTaskList: true,
      } as any),
    ).toMatchObject({
      locale: "zh-CN",
      interactive_mode: false,
      hide_in_task_list: false,
      share_visibility: "private",
    });
  });

  it("builds the documented inline file_data part and rejects malformed base64", () => {
    const encoded = Buffer.from("pinned system Skill bytes").toString("base64");
    expect(
      buildManusV2MessageContent("full business prompt", [
        {
          file_data: `data:application/zip;base64,${encoded}`,
          filename: "socratic-kb-builder.skill.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toEqual([
      { type: "text", text: "full business prompt" },
      {
        type: "file",
        file_data: `data:application/zip;base64,${encoded}`,
        filename: "socratic-kb-builder.skill.zip",
        mime_type: "application/zip",
      },
    ]);
    expect(() =>
      buildManusV2MessageContent("prompt", [
        {
          file_data: "data:application/zip;base64,***",
          filename: "broken.skill.zip",
          mime_type: "application/zip",
        },
      ]),
    ).toThrow(/inline attachment/u);
  });

  it.each([
    ["unbound task.create", "create"],
    ["bound task.sendMessage", "send"],
  ] as const)(
    "dispatches the rejected-system-file inline fallback once through %s with the full snapshot prompt",
    async (_label, method) => {
      const post = vi.spyOn(axios.Axios.prototype, "post").mockResolvedValue({
        status: 200,
        data: {
          ok: true,
          request_id: `request-${method}`,
          task_id: "canonical-task",
          ...(method === "create"
            ? { task_url: "https://manus.im/app/canonical-task" }
            : {}),
        },
      });
      const client = new ManusV2Client({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      });
      const snapshotPrompt = [
        "# FrontMind local canonical rehydrate",
        "snapshotSha256=" + "a".repeat(64),
        '{"revision":41,"leafId":"industry-cases"}',
        "Confirm the current node and continue.",
      ].join("\n");
      const attachment = {
        file_data: `data:application/zip;base64,${Buffer.from("pinned system Skill bytes").toString("base64")}`,
        filename: "socratic-kb-builder.skill.zip",
        mime_type: "application/zip",
      } as const;

      if (method === "create") {
        await client.createTask({
          prompt: snapshotPrompt,
          title: "FrontMind KB build g1",
          attachments: [attachment],
        });
      } else {
        await client.sendMessage({
          taskId: "canonical-task",
          prompt: snapshotPrompt,
          attachments: [attachment],
        });
      }

      expect(post).toHaveBeenCalledOnce();
      expect(post.mock.calls[0]?.[0]).toBe(
        method === "create"
          ? "https://api.example.test/v2/task.create"
          : "https://api.example.test/v2/task.sendMessage",
      );
      expect(post.mock.calls[0]?.[1]).toMatchObject({
        message: {
          content: [
            { type: "text", text: snapshotPrompt },
            {
              type: "file",
              file_data: attachment.file_data,
              filename: attachment.filename,
              mime_type: attachment.mime_type,
            },
          ],
        },
      });
    },
  );

  it("pins every structured-result coordinate in the schema and in-band prompt", () => {
    const schema = buildManusV2KnowledgeBaseStructuredOutputSchema(
      operationContract,
    ) as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).not.toContain("manifestJson");
    expect(schema.properties).toMatchObject({
      operationToken: { enum: ["op-1"] },
      turnId: { enum: ["turn-1"] },
      generation: { enum: [2] },
      baseRevision: { enum: [7] },
      action: { enum: ["confirm"] },
      fromLeafId: { enum: ["leaf-7"] },
      contentCompleted: { enum: [false] },
    });
    expect(
      appendManusV2KnowledgeBaseOperationContract(
        "business",
        operationContract,
      ),
    ).toContain('"operationToken":"op-1"');
  });

  it.each(["", "bundle ready"])(
    "projects a stable, deduplicated typed ZIP from assistant content %j",
    (content) => {
      const events = [
        {
          id: "event-materialized-zip",
          type: "assistant_message",
          timestamp: 1_723_600_000_000,
          assistant_message: {
            content,
            attachments: [
              {
                type: "file",
                filename: "frontmind-kb-bundle-operation.zip",
                content_type: "application/zip",
                url: "https://downloads.example.test/materialized.zip",
              },
            ],
          },
        },
      ];
      const output = normalizeManusV2Output(events);
      const replayed = normalizeManusV2Output(events);
      const typed = output.find((item) => "type" in item);

      expect(output[0]).toMatchObject({
        id: "event-materialized-zip",
        text: content,
        content,
        files: [
          expect.objectContaining({
            filename: "frontmind-kb-bundle-operation.zip",
          }),
        ],
      });
      expect(typed).toMatchObject({
        id: expect.stringMatching(/^v2-attachment-[a-f0-9]{64}$/u),
        role: "assistant",
        type: "file",
        filename: "frontmind-kb-bundle-operation.zip",
        content_type: "application/zip",
        url: "https://downloads.example.test/materialized.zip",
      });
      expect(replayed.find((item) => "type" in item)?.id).toBe(typed?.id);
      expect(collectKnowledgeArchiveDescriptors(output)).toEqual([
        expect.objectContaining({
          outputItemId: typed?.id,
          filename: "frontmind-kb-bundle-operation.zip",
          mimeType: "application/zip",
          url: "https://downloads.example.test/materialized.zip",
        }),
      ]);
    },
  );

  it("requires a manifest only for initial tree creation", () => {
    const schema = buildManusV2KnowledgeBaseStructuredOutputSchema({
      ...operationContract,
      action: "start",
      fromLeafId: null,
      baseRevision: 0,
      requiresManifest: true,
    }) as any;
    expect(schema.required).toContain("manifestJson");
    expect(schema.properties.manifestJson).toEqual({ type: "string" });
  });

  it("accepts core content without requiring a model-supplied protocol payload", () => {
    const output = normalizeManusV2Output(
      [
        {
          id: "user-old",
          type: "user_message",
          timestamp: 1,
          user_message: {
            content:
              'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"op-old"}',
          },
        },
        {
          id: "old-result",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: true,
            value: {
              schemaVersion: 1,
              operationToken: "op-old",
              turnId: "turn-old",
              generation: 2,
              baseRevision: 6,
              action: "confirm",
              fromLeafId: "leaf-6",
              nextLeafId: "leaf-7",
              visibleMarkdown: "old body",
              contentCompleted: false,
            },
          },
        },
        {
          id: "user-new",
          type: "user_message",
          timestamp: 3,
          user_message: {
            content:
              'FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"operationToken":"op-1"}',
          },
        },
        {
          id: "new-result",
          type: "structured_output_result",
          timestamp: 4,
          structured_output_result: {
            success: true,
            value: JSON.stringify({
              schemaVersion: 1,
              operationToken: "op-1",
              turnId: "turn-1",
              generation: 2,
              baseRevision: 7,
              action: "confirm",
              fromLeafId: "leaf-7",
              nextLeafId: "leaf-8",
              visibleMarkdown: "new body",
              contentCompleted: false,
            }),
          },
        },
      ],
      operationContract,
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      id: "new-result",
      text: "new body",
      structuredOutput: true,
    });
  });

  it("selects the newer equal-timestamp structured candidate by Provider rank", () => {
    const value = (visibleMarkdown: string) => ({
      schemaVersion: 1,
      operationToken: "op-1",
      turnId: "turn-1",
      generation: 2,
      baseRevision: 7,
      action: "confirm",
      fromLeafId: "leaf-7",
      nextLeafId: "leaf-8",
      visibleMarkdown,
      contentCompleted: false,
    });
    const output = normalizeManusV2Output(
      [
        {
          id: "zzz-older-result",
          type: "structured_output_result",
          timestamp: 20,
          providerOriginalRank: 0,
          structured_output_result: {
            success: true,
            value: value("older body"),
          },
        },
        {
          id: "000-newer-result",
          type: "structured_output_result",
          timestamp: 20,
          providerOriginalRank: 1,
          structured_output_result: {
            success: true,
            value: value("newer body"),
          },
        },
      ],
      operationContract,
    );

    expect(output).toMatchObject([
      {
        id: "000-newer-result",
        text: "newer body",
        structuredOutput: true,
      },
    ]);
  });

  it("never accepts a provider-declared extraction failure's schema-shaped zero value", () => {
    const zeroValue = {
      schemaVersion: 1,
      operationToken: "op-1",
      turnId: "turn-1",
      generation: 2,
      baseRevision: 7,
      action: "confirm",
      fromLeafId: "leaf-7",
      nextLeafId: "",
      visibleMarkdown: "",
      contentCompleted: false,
    };
    const envelope = {
      error: "Failed to extract structured output",
      value: zeroValue,
    };
    expect(classifyManusV2StructuredResultEnvelope(envelope)).toEqual({
      kind: "rejected",
      code: "STRUCTURED_OUTPUT_REJECTED",
    });
    expect(
      normalizeManusV2Output(
        [
          {
            id: "failed-extraction",
            type: "structured_output_result",
            timestamp: 10,
            structured_output_result: envelope,
          },
        ],
        operationContract,
      ),
    ).toEqual([]);
  });

  it("rejects a contradictory nonempty error even when success is true", () => {
    expect(
      classifyManusV2StructuredResultEnvelope({
        success: true,
        error: "provider reported an extraction error",
        value: { visibleMarkdown: "must not be accepted" },
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  it("classifies success false plus an error as rejected even without value", () => {
    expect(
      classifyManusV2StructuredResultEnvelope({
        success: false,
        error: "structured extraction failed",
      }),
    ).toEqual({
      kind: "rejected",
      code: "STRUCTURED_OUTPUT_REJECTED",
    });
  });

  it("accepts only an explicit successful envelope with no provider error", () => {
    expect(
      classifyManusV2StructuredResultEnvelope({
        success: true,
        error: "   ",
        value: { visibleMarkdown: "accepted" },
      }),
    ).toEqual({
      kind: "accepted",
      value: { visibleMarkdown: "accepted" },
    });
    expect(
      classifyManusV2StructuredResultEnvelope({
        error: null,
        value: { visibleMarkdown: "missing success" },
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  it("rejects a structured result that reuses the token with stale coordinates", () => {
    expect(() =>
      normalizeManusV2Output(
        [
          {
            id: "stale",
            type: "structured_output_result",
            timestamp: 5,
            structured_output_result: {
              success: true,
              value: {
                schemaVersion: 1,
                operationToken: "op-1",
                turnId: "turn-1",
                generation: 1,
                baseRevision: 7,
                action: "confirm",
                fromLeafId: "leaf-7",
                nextLeafId: "leaf-8",
                visibleMarkdown: "stale body",
                contentCompleted: false,
              },
            },
          },
        ],
        operationContract,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "OPERATION_COORDINATE_CONFLICT" }),
    );
  });
});
