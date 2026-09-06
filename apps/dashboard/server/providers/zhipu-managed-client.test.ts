import { describe, expect, it, vi } from "vitest";
import { ZhipuManagedClient, ZhipuManagedError } from "./zhipu-managed-client";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
describe("Managed Agents transport", () => {
  it("uses the fixed server endpoint and version headers", async () => {
    const transport = vi.fn(async () => json({ data: [], next_page: null }));
    const client = new ZhipuManagedClient({
      apiKey: "unit-secret",
      fetchImpl: transport,
    });
    await client.request("GET", "/v1/agents?limit=1");
    const [url, init] = transport.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://agent-api.bigmodel.cn/api/agent/managed/v1/agents?limit=1",
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer unit-secret",
      "zai-version": "2026-05-26",
      "zai-beta": "managed-agents-2026-05-26",
    });
    await expect(
      client.request("GET", "https://attacker.test"),
    ).rejects.toThrow("INVALID_PROVIDER_PATH");
  });
  it.each([500, 502, 408])(
    "never repeats an uncertain mutation after HTTP %s",
    async (status) => {
      const transport = vi.fn(async () => json({}, status));
      const client = new ZhipuManagedClient({
        apiKey: "test",
        fetchImpl: transport,
      });
      await expect(
        client.create("/v1/sessions", { agent: "a" }),
      ).rejects.toMatchObject({ outcomeUnknown: true });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("separates definite authentication refusal from response loss", async () => {
    const refused = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => json({}, 401)),
    });
    await expect(refused.create("/v1/agents", {})).rejects.toMatchObject({
      outcomeUnknown: false,
      status: 401,
    });
    const lost = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => {
        throw new Error("connection reset with secret");
      }),
    });
    await expect(lost.create("/v1/agents", {})).rejects.toMatchObject({
      outcomeUnknown: true,
      code: "TRANSPORT_ERROR",
    });
  });
  it.each(["GET", "POST"])(
    "classifies a %s response-body timeout as transport loss without retrying the request",
    async (method) => {
      const transport = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"id":'));
                controller.error(
                  new DOMException("synthetic timeout", "TimeoutError"),
                );
              },
            }),
          ),
      );
      const client = new ZhipuManagedClient({
        apiKey: "test",
        fetchImpl: transport,
      });
      await expect(
        client.request(method, "/v1/sessions/sess_read"),
      ).rejects.toMatchObject({
        code: "TRANSPORT_ERROR",
        status: null,
        outcomeUnknown: method === "POST",
      });
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it("does not relabel a complete malformed response as a transport loss", async () => {
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => new Response('{"id":')),
    });
    await expect(
      client.request("GET", "/v1/sessions/sess_read"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
      outcomeUnknown: false,
    });
  });

  it("treats malformed success acknowledgement as unknown", async () => {
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => json({ message: "ok" })),
    });
    await expect(client.create("/v1/sessions", {})).rejects.toMatchObject({
      outcomeUnknown: true,
      code: "INVALID_RESPONSE",
    });
  });
  it("uploads exact original bytes and validates returned identity", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 10]);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const file = (init!.body as FormData).get("file") as File;
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
      expect(file.name).toBe("original.skill.zip");
      return json({
        id: "file_original",
        filename: file.name,
        size_bytes: bytes.length,
      });
    });
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: transport,
    });
    expect(
      await client.uploadFile({
        filename: "original.skill.zip",
        bytes,
        contentType: "application/zip",
      }),
    ).toMatchObject({ id: "file_original" });
  });
  it("lets an upload finish after 60 seconds while an ordinary request still times out", async () => {
    vi.useFakeTimers();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException("synthetic timeout", "TimeoutError"),
            ),
          ms,
        );
        return controller.signal;
      });
    try {
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                json({
                  id: "file_slow",
                  filename: "workflow.zip",
                  size_bytes: 3,
                }),
              ),
            90_000,
          );
          init!.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init!.signal!.reason);
            },
            { once: true },
          );
        });
      });
      const client = new ZhipuManagedClient({
        apiKey: "test",
        fetchImpl: transport,
      });
      let uploadCompleted = false;
      const upload = client
        .uploadFile({
          filename: "workflow.zip",
          bytes: Buffer.from("zip"),
          contentType: "application/zip",
        })
        .then((value) => {
          uploadCompleted = true;
          return value;
        });
      const ordinary = client
        .request("GET", "/v1/agents")
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await ordinary).toMatchObject({
        code: "TRANSPORT_ERROR",
        outcomeUnknown: false,
      });
      expect(uploadCompleted).toBe(false);
      await vi.advanceTimersByTimeAsync(29_999);
      await expect(upload).resolves.toMatchObject({ id: "file_slow" });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(
        transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it.each([
    [{}, 600_000, 60_000],
    [{ requestTimeoutMs: 12_000 }, 12_000, 12_000],
    [{ uploadTimeoutMs: 120_000 }, 120_000, 60_000],
    [{ requestTimeoutMs: 12_000, uploadTimeoutMs: 120_000 }, 120_000, 12_000],
  ])(
    "honors explicit upload and existing request timeout choices: %j",
    async (options, uploadMs, requestMs) => {
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(() => new AbortController().signal);
      try {
        const client = new ZhipuManagedClient({
          apiKey: "test",
          ...options,
          fetchImpl: vi.fn(async () =>
            json({
              id: "file_custom",
              filename: "workflow.zip",
              size_bytes: 3,
            }),
          ),
        });
        await client.uploadFile({
          filename: "workflow.zip",
          bytes: Buffer.from("zip"),
          contentType: "application/zip",
        });
        await client.request("GET", "/v1/agents");
        expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
          uploadMs,
          requestMs,
        ]);
      } finally {
        timeout.mockRestore();
      }
    },
  );
  it.each([
    [401, false],
    [413, false],
    [429, false],
    [500, true],
  ] as const)(
    "still reports upload HTTP %s immediately without resubmitting",
    async (status, outcomeUnknown) => {
      const transport = vi.fn(async () => json({}, status));
      const client = new ZhipuManagedClient({
        apiKey: "test",
        fetchImpl: transport,
      });
      await expect(
        client.uploadFile({
          filename: "workflow.zip",
          bytes: Buffer.from("zip"),
          contentType: "application/zip",
        }),
      ).rejects.toMatchObject({
        code: `HTTP_${status}`,
        status,
        outcomeUnknown,
      });
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it("exhausts cursor pages and deduplicates equal-time event identities", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        json({ data: [{ id: "e1" }], next_page: "cursor2" }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "e1" }, { id: "e2" }], next_page: null }),
      );
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: transport,
    });
    expect(
      await client.listAll("/v1/sessions/s/events", { order: "asc" }),
    ).toEqual([{ id: "e1" }, { id: "e2" }]);
    expect(transport.mock.calls[1]![0]).toContain("page=cursor2");
  });
  it("fails closed on repeated pagination cursors", async () => {
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => json({ data: [], next_page: "repeat" })),
    });
    await expect(
      client.listAll("/v1/sessions/s/events"),
    ).rejects.toBeInstanceOf(ZhipuManagedError);
  });
});

it("decodes CRLF split across chunks and an EOF frame without losing durable events", async () => {
  for (const pieces of [
    [`data: {"id":"event_1","type":"agent.message"}\r`, "\n\r", "\n"],
    [`data: {"id":"event_1","type":"agent.message"}`],
  ]) {
    const body = new ReadableStream({
      start(controller) {
        for (const piece of pieces)
          controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    });
    const client = new ZhipuManagedClient({
      apiKey: "test",
      fetchImpl: vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });
    const stream = await client.subscribeEvents("sess_split");
    const seen = [];
    for await (const event of stream.events) seen.push(event.id);
    expect(seen).toEqual(["event_1"]);
  }
});

describe("Managed Agents acknowledged file deletion", () => {
  it("validates the file identity before dispatch and requires a matching deletion acknowledgement", async () => {
    const transport = vi.fn(async () => json({ id: "file_1", deleted: true }));
    const client = new ZhipuManagedClient({
      apiKey: "synthetic",
      fetchImpl: transport,
    });
    await expect(client.deleteFile("../other")).rejects.toThrow(
      "INVALID_RESOURCE_ID",
    );
    expect(transport).not.toHaveBeenCalled();
    await expect(client.deleteFile("file_1")).resolves.toEqual({
      id: "file_1",
      deleted: true,
    });
    const bad = new ZhipuManagedClient({
      apiKey: "synthetic",
      fetchImpl: vi.fn(async () => json({ id: "another", deleted: true })),
    });
    await expect(bad.deleteFile("file_1")).rejects.toMatchObject({
      outcomeUnknown: true,
      code: "INVALID_RESPONSE",
    });
  });
});
