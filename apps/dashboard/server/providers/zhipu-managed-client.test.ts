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
