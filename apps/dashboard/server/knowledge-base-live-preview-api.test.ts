import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import livePreviewRouter, {
  analyzeKnowledgeBaseLiveTask,
  buildKnowledgeBaseProtocolProbePrompt,
  collectKnowledgeBasePreviewFileIds,
  createKnowledgeBaseLivePreviewAttachmentCleanup,
  knowledgeBaseLivePreviewNeedsAuthoritativeFinalization,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_OPERATION_ID,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_TURN_ID,
  rehydratedConfirmationProgressState,
  selectKnowledgeBasePreviewDownloadUrl,
  selectInitialKnowledgeBaseLiveTask,
} from "./knowledge-base-live-preview-api";
import {
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

async function withLivePreviewServer<T>(run: (baseUrl: string) => Promise<T>) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(livePreviewRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function taskWithText(text: string, status = "completed", imageCount = 1) {
  return {
    id: "task-live-preview",
    status,
    output: [
      {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text },
          ...Array.from({ length: imageCount }, (_, index) => ({
            type: "output_image",
            file_id: `image-${index + 1}`,
            file_name: `image-${index + 1}.webp`,
          })),
        ],
      },
    ],
  };
}

function manifest() {
  return {
    kind: "frontmind.knowledge-base.manifest",
    schemaVersion: 1,
    leaves: Array.from({ length: 8 }, (_, index) => ({
      id: `${index + 1}.1`,
      title: `节点 ${index + 1}`,
      branchId: `branch-${index + 1}`,
      branchTitle: `分支 ${index + 1}`,
    })),
  };
}

describe("analyzeKnowledgeBaseLiveTask", () => {
  it("never treats upload_url as a readable preview fallback", () => {
    expect(
      selectKnowledgeBasePreviewDownloadUrl({
        upload_url: "https://uploads.example.test/write-only",
      }),
    ).toBe("");
    expect(
      selectKnowledgeBasePreviewDownloadUrl({
        upload_url: "https://uploads.example.test/write-only",
        download_url: "https://downloads.example.test/image.webp",
        file_url: "https://files.example.test/image.webp",
      }),
    ).toBe("https://downloads.example.test/image.webp");
  });

  it("normalizes URL-only image descriptors to preview file IDs", () => {
    expect(
      collectKnowledgeBasePreviewFileIds([
        {
          type: "output_image",
          image_url:
            "https://api.example.test/v1/files/url-image/content?token=1",
        },
        { type: "output_image", file_id: "direct-image" },
        { type: "output_file", file_id: "not-an-image", file_name: "a.pdf" },
      ]),
    ).toEqual(new Set(["url-image", "direct-image"]));
  });

  it("rehydrates the exact current leaf after a development server restart", () => {
    const state = rehydratedConfirmationProgressState({
      initialText: `首轮正文\n<!-- FRONTMIND_KB_MANIFEST\n${JSON.stringify(manifest())}\n-->`,
      revision: 1,
      currentLeafId: "2.1",
      confirmationCount: 1,
    });

    expect(state).toMatchObject({
      revision: 1,
      currentLeafId: "2.1",
    });
    expect(state.leaves.slice(0, 3)).toMatchObject([
      { id: "1.1", status: "confirmed" },
      { id: "2.1", status: "current" },
      { id: "3.1", status: "pending" },
    ]);
  });

  it("renders bare protocol output without leaking machine JSON", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "## 企业定位",
          "",
          "FrontMind 超前智能提供 AI 原生品牌增长服务。",
          "",
          JSON.stringify(manifest()),
          JSON.stringify({
            kind: "frontmind.workflow-state",
            currentLeafId: "1.1",
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
            leafId: "1.1",
            message: "请确认节点 1.1",
            assetIds: ["asset-1"],
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.message",
            text: "internal",
          }),
        ].join("\n"),
      ),
    );

    expect(analysis.manifest).toMatchObject({
      leafCount: 8,
      branchCount: 8,
      firstLeaf: { id: "1.1", title: "节点 1" },
      lastLeaf: { id: "8.1", title: "节点 8" },
    });
    expect(analysis.visibleMarkdown).toBe(
      "## 企业定位\n\nFrontMind 超前智能提供 AI 原生品牌增长服务。",
    );
    expect(analysis.visibleMarkdown).not.toContain("frontmind.");
    expect(analysis.issues).toEqual([]);
    expect(
      analysis.diagnostics.find(
        (item) => item.kind === "frontmind.knowledge-base.presentation",
      ),
    ).toMatchObject({
      valid: false,
      authoritative: false,
    });
  });

  it("accepts the documented comment envelope", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "节点正文",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(manifest()),
          "-->",
        ].join("\n"),
      ),
    );

    expect(analysis.manifest?.leafCount).toBe(8);
    expect(analysis.visibleMarkdown).toBe("节点正文");
    expect(analysis.issues).toEqual([]);
  });

  it("does not report an incomplete manifest while a task is still running", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText("正在研究企业公开资料…", "running"),
    );

    expect(analysis.terminal).toBe(false);
    expect(analysis.manifest).toBeNull();
    expect(analysis.issues).toEqual([]);
  });

  it("never treats a failed terminal task as a successful turn", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        `节点正文\n<!-- FRONTMIND_KB_MANIFEST\n${JSON.stringify(manifest())}\n-->`,
        "failed",
      ),
    );

    expect(analysis.terminal).toBe(true);
    expect(analysis.successfulTerminal).toBe(false);
    expect(analysis.issues).toContain("任务以失败或取消状态结束：failed");
  });

  it("suppresses stale cumulative output while a confirmation is running", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        '旧节点正文\n<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":1,"action":"confirm","leafId":"1.1","status":"confirmed"}\n-->',
        "running",
        0,
      ),
      { mode: "continuation" },
    );

    expect(analysis.visibleMarkdown).toBe("");
    expect(analysis.rawOutput).toEqual([]);
    expect(analysis.protocolObjects).toEqual([]);
    expect(analysis.issues).toEqual([]);
  });

  it("fails closed when a completed confirmation returns the legacy progress shape", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "## 1.1 一句话定位",
          "重复的旧节点正文",
          '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":1,"action":"revise","leafId":"1.1","status":"needs_verification"}\n-->',
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.1","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}\n-->',
        ].join("\n\n"),
        "completed",
        0,
      ),
      { mode: "continuation" },
    );

    expect(analysis.protocolAccepted).toBe(false);
    expect(analysis.visibleMarkdown).toBe("");
    expect(analysis.rawOutput).toEqual([]);
    expect(analysis.issues).toEqual([
      "frontmind.knowledge-base.progress：Progress envelope contains unsupported fields: action, leafId, status",
    ]);
  });

  it("deduplicates identical canonical manifests after terminal completion", () => {
    const rawManifest = JSON.stringify(manifest());
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(`节点正文\n${rawManifest}\n${rawManifest}`),
    );

    expect(analysis.manifest).toMatchObject({ leafCount: 8, branchCount: 8 });
    expect(analysis.issues).toEqual([]);
  });

  it("reports a malformed documented manifest instead of treating it as absent", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        '节点正文\n<!-- FRONTMIND_KB_MANIFEST\n{"kind":"frontmind.knowledge-base.manifest"\n-->',
      ),
    );

    expect(analysis.issues.join("\n")).toContain(
      "Manifest envelope contains invalid JSON",
    );
  });

  it("hides legacy Socratic state but rejects it as a manifest substitute", () => {
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "## 知识树统计",
          "",
          "9 个分支，52 个叶子。",
          "",
          "<!--SOCRATIC_KB_STATE",
          '{"revision":0,"knowledgeTree":{"branches":9,"leaves":52}}',
          "SOCRATIC_KB_STATE-->",
        ].join("\n"),
        "completed",
        0,
      ),
    );

    expect(analysis.legacySocraticStateCount).toBe(1);
    expect(analysis.visibleMarkdown).toBe(
      "## 知识树统计\n\n9 个分支，52 个叶子。",
    );
    expect(analysis.issues).toContain("任务已结束，但没有找到知识树 manifest");
    expect(analysis.issues).toContain(
      "返回了已禁用的旧 SOCRATIC_KB_STATE 状态对象",
    );
  });

  it("builds a no-research prompt and accepts the exact protocol probe manifest", () => {
    const prompt = buildKnowledgeBaseProtocolProbePrompt();
    const probeManifest = {
      kind: "frontmind.knowledge-base.manifest",
      schemaVersion: 2,
      operationId: KNOWLEDGE_BASE_PROTOCOL_PROBE_OPERATION_ID,
      turnId: KNOWLEDGE_BASE_PROTOCOL_PROBE_TURN_ID,
      leaves: KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
    };
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "协议探针响应",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(probeManifest),
          "-->",
        ].join("\n"),
        "completed",
        0,
      ),
      { mode: "protocol_probe" },
    );

    expect(prompt).toContain("FRONTMIND_KB_PROTOCOL_PROBE_V2");
    expect(prompt).toContain("禁止联网、搜索、浏览、调用工具");
    expect(prompt).toContain("8.1|合作与支持|cooperation|合作与支持");
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(analysis.runMode).toBe("protocol_probe");
    expect(analysis.manifest?.leaves).toEqual(
      KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
    );
    expect(analysis.visibleMarkdown).toBe("协议探针响应");
    expect(analysis.issues).toEqual([]);
  });

  it("rejects a structurally valid probe manifest when its leaves differ", () => {
    const wrongManifest = manifest();
    wrongManifest.leaves[0]!.title = "错误标题";
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(
        [
          "协议探针响应",
          "<!-- FRONTMIND_KB_MANIFEST",
          JSON.stringify(wrongManifest),
          "-->",
        ].join("\n"),
        "completed",
        0,
      ),
      { mode: "protocol_probe" },
    );

    expect(analysis.issues).toContain(
      "协议探针 manifest 与预期的 8 个叶子不完全一致",
    );
  });

  it("recovers the initial manifest and its nested images from cumulative later turns", () => {
    const initial = taskWithText(
      [
        "## 1.1 企业定位",
        "<!-- FRONTMIND_KB_MANIFEST",
        JSON.stringify(manifest()),
        "-->",
      ].join("\n"),
    );
    const cumulative = {
      ...initial,
      output: [
        ...initial.output,
        {
          id: "later-turn",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "重复的 1.1\n<!-- FRONTMIND_KB_PROGRESS {} -->",
            },
          ],
        },
      ],
    };

    const recovered = analyzeKnowledgeBaseLiveTask(
      selectInitialKnowledgeBaseLiveTask(cumulative),
      { mode: "full" },
    );

    expect(recovered.manifest?.leafCount).toBe(8);
    expect(recovered.imageCount).toBe(1);
    expect(recovered.visibleMarkdown).toBe("## 1.1 企业定位");
    expect(recovered.issues).toEqual([]);
  });
});

// The live-preview HTTP surface was intentionally removed from the product
// router in materialized-bundle v5. Keep the parser fixtures above as offline
// regression coverage, but do not exercise the retired provider-continuation
// transport as though it were a supported runtime route.
describe.skip("retired knowledge-base live preview prompt delivery", () => {
  it("cleans every generated attachment exactly once", async () => {
    const cleanup = createKnowledgeBaseLivePreviewAttachmentCleanup();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockRejectedValue(new Error("already gone"));
    cleanup.add(first);
    cleanup.add(second);

    await cleanup.removeAll();
    await cleanup.removeAll();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.pendingCount).toBe(0);
  });

  it("uploads full start and continuation instructions while every task prompt stays within 3000 characters", async () => {
    process.env.NODE_ENV = "development";
    const taskBodies: Array<Record<string, any>> = [];
    const uploadedBytes = new Map<string, Buffer>();
    const filenameByFileId = new Map<string, string>();
    let fileSequence = 0;

    vi.spyOn(axios, "post").mockImplementation(
      async (url: string, body: Record<string, any>) => {
        if (url.endsWith("/v1/files")) {
          fileSequence += 1;
          const fileId = `live-file-${fileSequence}`;
          filenameByFileId.set(fileId, String(body.filename || ""));
          return {
            status: 201,
            data: {
              id: fileId,
              upload_url: `https://uploads.example.test/${fileId}`,
            },
          } as any;
        }
        if (!url.endsWith("/v1/tasks")) {
          throw new Error(`Unexpected POST ${url}`);
        }
        taskBodies.push(body);
        if (taskBodies.length === 1) {
          const operationId = String(body.prompt).match(
            /operationId=([^；\n]+)/u,
          )?.[1];
          const turnId = String(body.prompt).match(/turnId=([^。\n]+)/u)?.[1];
          const initialManifest = {
            kind: "frontmind.knowledge-base.manifest",
            schemaVersion: 2,
            operationId,
            turnId,
            leaves: KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
          };
          return {
            status: 201,
            data: taskWithText(
              [
                "## 企业定位",
                "企业定位正文。",
                "<!-- FRONTMIND_KB_MANIFEST",
                JSON.stringify(initialManifest),
                "-->",
              ].join("\n"),
              "completed",
              1,
            ),
          } as any;
        }
        return {
          status: 201,
          data: { id: "task-live-preview", status: "running", output: [] },
        } as any;
      },
    );
    vi.spyOn(axios, "put").mockImplementation(
      async (url: string, bytes: Buffer) => {
        const fileId = new URL(url).pathname.split("/").pop()!;
        uploadedBytes.set(fileId, Buffer.from(bytes));
        return { status: 200, data: "" } as any;
      },
    );
    const get = vi.spyOn(axios, "get").mockImplementation(async (url) => {
      const fileId = new URL(String(url)).pathname.split("/").pop()!;
      return {
        status: 200,
        data: {
          id: fileId,
          filename: filenameByFileId.get(fileId),
          status: "uploaded",
        },
      } as any;
    });
    vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: "",
    });

    await withLivePreviewServer(async (baseUrl) => {
      const start = await fetch(`${baseUrl}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyName: "超长规则仍只进入系统附件的测试企业",
          companyWebsite: "https://example.test",
          apiKey: "live-preview-test-key",
        }),
      });
      expect(start.status).toBe(201);
      const startPayload = (await start.json()) as any;
      const confirm = await fetch(`${baseUrl}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: startPayload.sessionId,
          apiKey: "live-preview-test-key",
        }),
      });
      expect(confirm.status).toBe(201);
    });

    expect(taskBodies).toHaveLength(2);
    for (const body of taskBodies) {
      expect(
        upstreamPromptCharacterCount(String(body.prompt)),
      ).toBeLessThanOrEqual(FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS);
      expect(body.attachments).toHaveLength(2);
      expect(body.attachments[1]?.filename).toBe(
        "frontmind-kb-server-instructions.txt",
      );
      expect(String(body.prompt)).toContain(
        "frontmind-kb-server-instructions.txt",
      );
    }
    const instructionTexts = [...filenameByFileId.entries()]
      .filter(
        ([, filename]) => filename === "frontmind-kb-server-instructions.txt",
      )
      .map(([fileId]) => uploadedBytes.get(fileId)?.toString("utf8") || "");
    expect(instructionTexts).toHaveLength(2);
    expect(instructionTexts[0]).toContain("超长规则仍只进入系统附件的测试企业");
    expect(instructionTexts[1]).toContain("当前 revision=0");
    expect(instructionTexts[1]).toContain("FRONTMIND_KB_PROGRESS");
    expect(get).toHaveBeenCalled();
    for (const [, config] of get.mock.calls) {
      expect(config?.headers).toMatchObject({
        API_KEY: "live-preview-test-key",
      });
      expect(config?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("deletes both generated files when start task creation is rejected", async () => {
    process.env.NODE_ENV = "development";
    let fileSequence = 0;
    const filenameByFileId = new Map<string, string>();
    const taskBodies: Array<Record<string, any>> = [];
    const remove = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: "",
    });
    vi.spyOn(axios, "post").mockImplementation(
      async (url: string, body: Record<string, any>) => {
        if (url.endsWith("/v1/files")) {
          fileSequence += 1;
          filenameByFileId.set(
            `rejected-file-${fileSequence}`,
            String(body.filename || ""),
          );
          return {
            status: 201,
            data: {
              id: `rejected-file-${fileSequence}`,
              upload_url: `https://uploads.example.test/rejected-file-${fileSequence}`,
            },
          } as any;
        }
        taskBodies.push(body);
        return {
          status: 400,
          data: { error: { message: "rejected fixture" } },
        } as any;
      },
    );
    vi.spyOn(axios, "put").mockResolvedValue({ status: 200, data: "" });
    vi.spyOn(axios, "get").mockImplementation(async (url) => {
      const fileId = new URL(String(url)).pathname.split("/").pop()!;
      return {
        status: 200,
        data: {
          id: fileId,
          filename: filenameByFileId.get(fileId),
          status: "uploaded",
        },
      } as any;
    });

    await withLivePreviewServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyName: "清理测试企业",
          apiKey: "live-preview-test-key",
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UPSTREAM_TASK_CREATE_FAILED" },
      });
    });

    expect(taskBodies).toHaveLength(1);
    expect(taskBodies[0]?.attachments).toHaveLength(2);
    expect(
      upstreamPromptCharacterCount(String(taskBodies[0]?.prompt)),
    ).toBeLessThanOrEqual(FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      expect.stringContaining("/v1/files/rejected-file-1"),
      expect.stringContaining("/v1/files/rejected-file-2"),
    ]);
  });

  it("rejects the final live-preview confirmation before any upstream call", async () => {
    process.env.NODE_ENV = "development";
    const sourceManifest = {
      kind: "frontmind.knowledge-base.manifest",
      schemaVersion: 2,
      operationId: "live-preview:source:start",
      turnId: "00000000-0000-4000-8000-000000000004",
      leaves: KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
    };
    const sourceRawAssistantText = [
      "首轮正文",
      "<!-- FRONTMIND_KB_MANIFEST",
      JSON.stringify(sourceManifest),
      "-->",
    ].join("\n");
    const post = vi.spyOn(axios, "post");

    const state = rehydratedConfirmationProgressState({
      initialText: sourceRawAssistantText,
      revision: 7,
      currentLeafId: "8.1",
      confirmationCount: 7,
    });
    expect(knowledgeBaseLivePreviewNeedsAuthoritativeFinalization(state)).toBe(
      true,
    );

    await withLivePreviewServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceTaskId: "source-task",
          sourceRawAssistantText,
          sourceRevision: 7,
          sourceCurrentLeafId: "8.1",
          confirmationCount: 7,
          apiKey: "live-preview-test-key",
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "LIVE_PREVIEW_FINALIZATION_REQUIRES_AUTHORITATIVE_STATE",
        },
      });
    });

    expect(post).not.toHaveBeenCalled();
  });
});
