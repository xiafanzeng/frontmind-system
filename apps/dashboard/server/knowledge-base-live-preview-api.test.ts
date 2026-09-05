import { describe, expect, it } from "vitest";

import {
  analyzeKnowledgeBaseLiveTask,
  buildKnowledgeBaseProtocolProbePrompt,
  collectKnowledgeBasePreviewFileIds,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_LEAVES,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_OPERATION_ID,
  KNOWLEDGE_BASE_PROTOCOL_PROBE_TURN_ID,
  rehydratedConfirmationProgressState,
  selectKnowledgeBasePreviewDownloadUrl,
  selectInitialKnowledgeBaseLiveTask,
} from "./knowledge-base-live-preview-api";

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

  it("reports duplicate canonical manifests after terminal completion", () => {
    const rawManifest = JSON.stringify(manifest());
    const analysis = analyzeKnowledgeBaseLiveTask(
      taskWithText(`节点正文\n${rawManifest}\n${rawManifest}`),
    );

    expect(analysis.manifest).toBeNull();
    expect(analysis.issues.join("\n")).toContain(
      "Model output must contain exactly one FRONTMIND_KB_MANIFEST envelope",
    );
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
