import { describe, expect, it, vi } from "vitest";

import {
  JenovaBrandTrackingClient,
  normalizeJenovaDecimal,
  parseJenovaSseStream,
} from "./jenova-brand-tracking-client";

function chunkedStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("Jenova Brand Tracker client", () => {
  it("normalizes exact fixed-point usage without floating-point arithmetic", () => {
    expect(normalizeJenovaDecimal("0.01")).toBe("0.01000000");
    expect(normalizeJenovaDecimal("123456789012.12345678")).toBe(
      "123456789012.12345678",
    );
    expect(() => normalizeJenovaDecimal("0.123456789")).toThrow(
      "积分用量精度超出支持范围",
    );
    expect(normalizeJenovaDecimal(1e-8)).toBe("0.00000001");
    expect(normalizeJenovaDecimal("1.25e2")).toBe("125.00000000");
    expect(() => normalizeJenovaDecimal("1.000000001e-1")).toThrow(
      "积分用量精度超出支持范围",
    );
    expect(() => normalizeJenovaDecimal("invalid")).toThrow(
      "无效的积分用量数据",
    );
  });

  it("parses chunk boundaries and multi-line SSE data", async () => {
    const events = [];
    for await (const event of parseJenovaSseStream(
      chunkedStream([
        'event: stream_progress\r\ndata: {"label":"正在',
        '搜索",\r\ndata: "step":1}\r\n\r\n',
        'event: stream_delta\ndata: {"chunk_content":"完成"}\n\n',
      ]),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        event: "stream_progress",
        data: { label: "正在搜索", step: 1 },
      },
      { event: "stream_delta", data: { chunk_content: "完成" } },
    ]);
  });

  it("does not dispatch early when CRLF is split across network chunks", async () => {
    const events = [];
    for await (const event of parseJenovaSseStream(
      chunkedStream([
        "event: stream_progress\r",
        '\ndata: {"label":"仍是同一帧"}\r',
        "\n\r",
        "\n",
      ]),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        event: "stream_progress",
        data: { label: "仍是同一帧" },
      },
    ]);
  });

  it("validates brand-tracker availability and the current balance", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agents: [{ agent: "brand-tracker" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ balance: "9.5" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new JenovaBrandTrackingClient({
      fetchImpl,
      baseUrl: "https://jenova.invalid/v1",
    });

    await expect(client.validateKey("jnv_sk_test_only")).resolves.toEqual({
      agent: { agent: "brand-tracker" },
      balance: "9.50000000",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe(
        "Bearer jnv_sk_test_only",
      );
    }
  });

  it("streams normalized Jenova events with the caller's stable idempotency key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          chunkedStream([
            'event: stream_started\ndata: {"session_id":"session_1","run_id":"run_1"}\n\n',
            'event: stream_delta\ndata: {"chunk_content":"第一步"}\n\n',
            'event: stream_progress\ndata: {"label":"检索中"}\n\n',
            'event: stream_ended\ndata: {"success":true,"usage":{"cost":"0.125"}}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const client = new JenovaBrandTrackingClient({
      fetchImpl,
      baseUrl: "https://jenova.invalid/v1",
    });
    const events: unknown[] = [];

    await client.streamMessage({
      apiKey: "jnv_sk_test_only",
      userId: "frontmind-user-7",
      content: "开始品牌追踪",
      idempotencyKey: "brand-tracking:7:request-id",
      onEvent: (event) => events.push(event),
    });

    expect(events).toMatchObject([
      { type: "started", sessionId: "session_1", runId: "run_1" },
      { type: "delta", text: "第一步" },
      { type: "progress", message: "检索中" },
      { type: "ended", success: true, usageCost: "0.12500000" },
    ]);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      "brand-tracking:7:request-id",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      agent: "brand-tracker",
      content: "开始品牌追踪",
      stream: true,
    });
  });

  it("reads recovery messages from the official items collection", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { id: "message_1", from: { type: "agent" }, content: "结果" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new JenovaBrandTrackingClient({
      fetchImpl,
      baseUrl: "https://jenova.invalid/v1",
    });
    await expect(
      client.listSessionMessages(
        "jnv_sk_test_only",
        "session_1",
        "frontmind-user-7",
      ),
    ).resolves.toEqual([
      { id: "message_1", from: { type: "agent" }, content: "结果" },
    ]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(
      "user=frontmind-user-7&limit=100",
    );
  });

  it("binds run recovery to the opaque FrontMind user", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new JenovaBrandTrackingClient({
      fetchImpl,
      baseUrl: "https://jenova.invalid/v1",
    });
    await client.getSessionRun(
      "jnv_sk_test_only",
      "session_1",
      "run_1",
      "frontmind-user-7",
    );
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://jenova.invalid/v1/sessions/session_1/runs/run_1?user=frontmind-user-7",
    );
  });

  it("redacts an API key echoed by JSON errors and SSE payloads", async () => {
    const secret = "jnv_sk_do_not_echo_123";
    const rejectedClient = new JenovaBrandTrackingClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "bad_key", message: `invalid ${secret}` },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
      baseUrl: "https://jenova.invalid/v1",
    });
    await expect(rejectedClient.getBalance(secret)).rejects.toMatchObject({
      message: "invalid [REDACTED]",
      details: {
        error: { code: "bad_key", message: "invalid [REDACTED]" },
      },
    });

    const events: unknown[] = [];
    const streamingClient = new JenovaBrandTrackingClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            chunkedStream([
              `event: stream_warning\ndata: ${JSON.stringify({ message: `do not use ${secret}`, api_key: secret })}\n\n`,
              'event: stream_ended\ndata: {"success":true,"usage":{"cost":"0"}}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      baseUrl: "https://jenova.invalid/v1",
    });
    await streamingClient.streamMessage({
      apiKey: secret,
      userId: "frontmind-user-7",
      content: "hello",
      idempotencyKey: "stable-request",
      onEvent: (event) => events.push(event),
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain("[REDACTED]");
  });
});
