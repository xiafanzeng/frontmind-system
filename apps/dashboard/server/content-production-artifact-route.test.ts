import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import chatRouter from "./frontmind-v2-chat-router";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  readStoredPresalesFile: vi.fn(),
}));
vi.mock("./db", async (original) => ({
  ...(await original<typeof import("./db")>()),
  getDb: mocks.getDb,
}));
vi.mock("./presales-file-store", async (original) => ({
  ...(await original<typeof import("./presales-file-store")>()),
  readStoredPresalesFile: mocks.readStoredPresalesFile,
}));

describe("authorized content presentation downloads", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    vi.clearAllMocks();
  });

  async function fixture({
    filename = "review_r2.md",
    content = true,
    owned = true,
  } = {}) {
    const bytes = Buffer.from(
      "# Reference Pack 路由\n\n使用已有 Reference Pack，继续 P0 品牌文章。\n",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const row = {
      artifact: {
        id: "artifact_test",
        taskId: "test-task",
        filename,
        mimeType: "text/markdown",
        sizeBytes: bytes.length,
        contentSha256: sha256,
      },
      task: {
        providerRuntime: content
          ? {
              generalPurpose: {
                revision: 1,
                accountUserId: 7,
                purpose: "content_production",
                knowledgeBase: null,
                knowledgeText: null,
              },
            }
          : null,
      },
    };
    const query: any = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => (owned ? [row] : []),
    };
    // No write methods: presentation downloads must not synchronize or alter tasks.
    mocks.getDb.mockResolvedValue({ select: () => query });
    mocks.readStoredPresalesFile.mockResolvedValue({
      createReadStream: () => Readable.from(bytes),
    });
    const app = express();
    app.use((req, _res, next) => {
      req.frontmindUser = { id: 7, role: "user" } as any;
      next();
    });
    app.use(chatRouter);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return {
      bytes,
      sha256,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/artifacts/artifact_test/content`,
    };
  }

  it("serves a Chinese review on opt-in and retains original bytes and names at the original URL", async () => {
    const { bytes, sha256, url } = await fixture();
    const copy = await fetch(`${url}?presentation=zh`);
    expect(copy.status).toBe(200);
    expect(await copy.text()).toContain("使用已有品牌资料包");
    expect(
      decodeURIComponent(copy.headers.get("content-disposition")!),
    ).toContain("阶段确认_版本2（中文展示）.md");
    expect(copy.headers.get("etag")).not.toContain(sha256);
    const original = await fetch(url);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
    expect(
      decodeURIComponent(original.headers.get("content-disposition")!),
    ).toContain("review_r2.md");
    expect(original.headers.get("etag")).toContain(sha256);
  });

  it("does not alter another conversation purpose", async () => {
    const { bytes, url } = await fixture({ content: false });
    const response = await fetch(`${url}?presentation=zh`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(
      decodeURIComponent(response.headers.get("content-disposition")!),
    ).toContain("review_r2.md");
  });

  it.each([
    { owned: false },
    { filename: "frontmind_workflow_job_state.json" },
    {
      filename:
        "frontmind_workflow_job_snapshot_1788700140846_52cf72553694a0b9_c271a52fb6616062.zip",
    },
  ])(
    "cannot use presentation to bypass ownership or private transport restrictions: %j",
    async (options) => {
      const { url } = await fixture(options);
      const response = await fetch(`${url}?presentation=zh`);
      expect(response.status).toBe(404);
      expect(mocks.readStoredPresalesFile).not.toHaveBeenCalled();
    },
  );
});
