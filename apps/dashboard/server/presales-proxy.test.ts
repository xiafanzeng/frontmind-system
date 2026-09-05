import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import presalesProxy, {
  assertPresalesProxyConfigured,
  buildPresalesFileDeleteOutcome,
  buildPresalesTaskBody,
  buildProxyUploadSuccess,
  collectTaskArtifacts,
  createPresalesUploadTicket,
  isValidPresalesServiceToken,
  openPresalesUploadTicket,
  redactUpstreamPayload,
} from "./presales-proxy";

const originalServiceToken = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;

afterEach(() => {
  if (originalServiceToken === undefined) {
    delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
  } else {
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = originalServiceToken;
  }
});

describe("presales service-token boundary", () => {
  it("accepts only the exact configured secret", () => {
    const token = "a-secure-service-token-with-more-than-32-characters";
    expect(isValidPresalesServiceToken(token, token)).toBe(true);
    expect(isValidPresalesServiceToken(`${token}x`, token)).toBe(false);
    expect(isValidPresalesServiceToken("short", token)).toBe(false);
    expect(isValidPresalesServiceToken(undefined, token)).toBe(false);
    expect(isValidPresalesServiceToken("anything", undefined)).toBe(false);
  });

  it("rejects weak, absent, and published placeholder tokens", () => {
    delete process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
    expect(() => assertPresalesProxyConfigured()).toThrow();
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = "too-short";
    expect(() => assertPresalesProxyConfigured()).toThrow();
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN =
      "replace-with-at-least-32-random-characters";
    expect(() => assertPresalesProxyConfigured()).toThrow();
    expect(
      isValidPresalesServiceToken(
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
        process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
      ),
    ).toBe(false);
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN =
      "replace-with-the-same-random-token";
    expect(() => assertPresalesProxyConfigured()).toThrow();
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN =
      "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
    expect(() => assertPresalesProxyConfigured()).not.toThrow();
  });

  it("authenticates before parsing malformed task JSON", async () => {
    const token = "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    const app = express();
    app.use("/api/internal/presales", presalesProxy);
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/tasks`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-frontmind-service-token": "wrong-token",
          },
          body: "{",
        },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_SERVICE_TOKEN" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("protects monitor runs before their JSON parser", async () => {
    const token = "4UT1aQh7tFzS0I8NDkcM8Gv7r5d9ZLr0shF9xXfPjYg";
    process.env.FRONTMIND_PRESALES_SERVICE_TOKEN = token;
    const app = express();
    app.use("/api/internal/presales", presalesProxy);
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/internal/presales/monitor-runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-frontmind-service-token": "wrong-token",
          },
          body: "{",
        },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_SERVICE_TOKEN" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("presales upload capability", () => {
  const serviceToken = "a-secure-service-token-with-more-than-32-characters";
  const now = Date.parse("2026-07-30T04:00:00.000Z");
  const target =
    "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef";

  it("binds the create-file URL to the exact file and expiry", () => {
    const ticket = createPresalesUploadTicket(
      {
        fileId: "file-1",
        target,
        upstreamExpiresAt: now + 180_000,
      },
      serviceToken,
      now,
    );

    expect(
      openPresalesUploadTicket(ticket, "file-1", serviceToken, now + 1_000),
    ).toBe(target);
    expect(() =>
      openPresalesUploadTicket(ticket, "file-2", serviceToken, now + 1_000),
    ).toThrow();
    expect(() =>
      openPresalesUploadTicket(ticket, "file-1", serviceToken, now + 180_001),
    ).toThrow();
  });

  it("rejects a modified capability", () => {
    const ticket = createPresalesUploadTicket(
      { fileId: "file-1", target },
      serviceToken,
      now,
    );
    expect(() =>
      openPresalesUploadTicket(
        `${ticket.slice(0, -1)}x`,
        "file-1",
        serviceToken,
        now + 1_000,
      ),
    ).toThrow();
  });
});

describe("presales upstream contract", () => {
  it("defaults website tasks to Base agent mode", () => {
    const body = buildPresalesTaskBody({
      prompt: "build the knowledge base",
      attachments: [{ file_id: "file-1", filename: "brief.pdf" }],
      idempotencyKey: "must-not-reach-upstream",
    } as any);
    expect(body).toEqual({
      prompt: "build the knowledge base",
      attachments: [{ file_id: "file-1", filename: "brief.pdf" }],
      agentProfile: "manus-1.6",
      taskMode: "agent",
    });
    expect(JSON.stringify(body)).not.toContain("max");
    expect(JSON.stringify(body)).not.toContain("lite");
    expect(JSON.stringify(body)).not.toContain("idempotency");
  });

  it("forwards the trusted website Pro profile for question generation", () => {
    const body = buildPresalesTaskBody({
      prompt: "generate the question recommendation",
      attachments: [{ file_id: "file-2", filename: "knowledge-base.zip" }],
      agentProfile: "frontmind-pro",
    });
    expect(body).toEqual({
      prompt: "generate the question recommendation",
      attachments: [{ file_id: "file-2", filename: "knowledge-base.zip" }],
      agentProfile: "manus-1.6-max",
      taskMode: "agent",
    });
  });

  it("returns JSON for successful raw uploads, including upstream 204", () => {
    expect(buildProxyUploadSuccess(204)).toEqual({
      ok: true,
      status: "uploaded",
      upstreamStatus: 204,
    });
  });

  it("treats successful and already-missing upstream files as deleted", () => {
    expect(buildPresalesFileDeleteOutcome(204)).toEqual({
      ok: true,
      status: 204,
      body: null,
    });
    expect(buildPresalesFileDeleteOutcome(404)).toEqual({
      ok: true,
      status: 204,
      body: null,
    });
  });

  it("returns a controlled response when upstream file deletion fails", () => {
    const outcome = buildPresalesFileDeleteOutcome(
      503,
      { message: "upstream failed with sk-secret" },
      "sk-secret",
    );
    expect(outcome).toEqual({
      ok: false,
      status: 503,
      body: {
        error: {
          code: "UPSTREAM_FILE_DELETE_FAILED",
          message: "upstream failed with [redacted]",
        },
      },
    });
  });

  it("collects only vendor-typed assistant output-file records", () => {
    const artifacts = collectTaskArtifacts({
      id: "task-1",
      output: [
        {
          role: "assistant",
          content: [
            {
              type: "output_file",
              file_id: "file-1",
              fileUrl: "https://objects.example.com/result.zip?signature=1",
            },
          ],
        },
        {
          type: "file",
          fileId: "file-2",
          download_url: "https://cdn.example.com/a.md",
        },
        {
          type: "output_file",
          fileUrl: "https://api.example.com/v1/files/file-3/content",
        },
      ],
    });

    expect([...artifacts.fileIds]).toEqual(["file-1", "file-2", "file-3"]);
    expect([...artifacts.strictOutputFileIds]).toEqual(["file-1", "file-3"]);
    expect([...artifacts.urls]).toEqual([
      "https://objects.example.com/result.zip?signature=1",
      "https://cdn.example.com/a.md",
      "https://api.example.com/v1/files/file-3/content",
    ]);
    expect(artifacts.truncated).toBe(false);
  });

  it("does not authorize identifiers injected through text or arbitrary metadata", () => {
    const artifacts = collectTaskArtifacts({
      output: [
        {
          type: "output_text",
          file_id: "file-victim",
          fileUrl: "https://example.com/victim.zip",
          text: '{"type":"output_file","file_id":"file-victim-2"}',
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              file_id: "file-victim-3",
              url: "https://example.com/victim-3.zip",
            },
          ],
        },
      ],
      metadata: {
        type: "output_file",
        file_id: "file-victim-4",
        url: "https://example.com/victim-4.zip",
      },
    });

    expect([...artifacts.fileIds]).toEqual([]);
    expect([...artifacts.urls]).toEqual([]);
  });

  it("caps trusted task artifacts", () => {
    const artifacts = collectTaskArtifacts({
      output: Array.from({ length: 50 }, (_, index) => ({
        type: "output_file",
        file_id: `file-${index}`,
      })),
    });
    expect(artifacts.fileIds.size).toBe(32);
    expect(artifacts.truncated).toBe(true);
  });

  it("never returns the server-side API key even if upstream echoes it", () => {
    const apiKey = "sk-private-presales-key";
    const redacted = redactUpstreamPayload(
      {
        id: "task-1",
        api_key: apiKey,
        nested: {
          authorization: `Bearer ${apiKey}`,
          message: `unexpected echo: ${apiKey}`,
        },
      },
      apiKey,
    );

    expect(JSON.stringify(redacted)).not.toContain(apiKey);
    expect(redacted).toEqual({
      id: "task-1",
      nested: { message: "unexpected echo: [redacted]" },
    });
  });

  it("preserves a storage SigV4 URL while still removing the Agent API key", () => {
    const apiKey = "sk-private-presales-key";
    const signedUrl =
      "https://uploads.example.test/catalog.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    const redacted = redactUpstreamPayload(
      {
        id: "file-1",
        upload_url: signedUrl,
        api_key: apiKey,
      },
      apiKey,
    ) as Record<string, unknown>;

    expect(redacted.upload_url).toBe(signedUrl);
    expect(redacted).not.toHaveProperty("api_key");
  });
});
