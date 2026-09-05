import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import KnowledgeBaseLivePreview, {
  readPersistedLiveResponse,
} from "./KnowledgeBaseLivePreview";

function jsonResponse(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("KnowledgeBaseLivePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(window.sessionStorage.getItem).mockReset();
    vi.mocked(window.sessionStorage.setItem).mockReset();
    vi.mocked(window.sessionStorage.removeItem).mockReset();
    window.history.replaceState(null, "", "/");
  });

  it("submits the company and renders only sanitized customer markdown", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.endsWith("/configuration")) {
          return jsonResponse({ serverCredentialConfigured: true });
        }
        if (url.endsWith("/start") && init?.method === "POST") {
          return jsonResponse(
            {
              sessionId: "session-1",
              analysis: {
                runMode: "full",
                taskId: "task-1",
                status: "completed",
                terminal: true,
                outputCount: 1,
                assistantCharacterCount: 400,
                visibleCharacterCount: 52,
                visibleMarkdown:
                  '## 企业定位\n\nFrontMind 超前智能提供 AI 原生品牌增长服务。\n\n<!--SOCRATIC_KB_STATE\n{"revision":0}\nSOCRATIC_KB_STATE-->',
                rawAssistantText:
                  '## 企业定位\n{"kind":"frontmind.knowledge-base.manifest"}',
                protocolKinds: ["frontmind.knowledge-base.manifest"],
                legacySocraticStateCount: 1,
                protocolObjects: [
                  { kind: "frontmind.knowledge-base.manifest" },
                ],
                diagnostics: [
                  {
                    kind: "frontmind.knowledge-base.manifest",
                    count: 1,
                    valid: true,
                    authoritative: true,
                  },
                ],
                manifest: {
                  leafCount: 85,
                  branchCount: 8,
                  branchCounts: [{ title: "企业身份", leafCount: 9 }],
                  firstLeaf: { id: "1.1", title: "企业定位" },
                  lastLeaf: { id: "8.9", title: "人才发展与社会责任" },
                  leaves: [],
                },
                issues: [],
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(await screen.findByRole("button", { name: "构建知识库" }));

    const customerSection = (
      await screen.findByRole("heading", { name: "客户可见渲染" })
    ).closest("section");
    expect(customerSection).not.toBeNull();
    expect(
      within(customerSection as HTMLElement).getByText(
        "FrontMind 超前智能提供 AI 原生品牌增长服务。",
      ),
    ).toBeInTheDocument();
    expect(customerSection).not.toHaveTextContent(
      "frontmind.knowledge-base.manifest",
    );
    expect(customerSection).not.toHaveTextContent("SOCRATIC_KB_STATE");
    expect(
      screen.getByText(/检测到 1 个旧 SOCRATIC 状态对象/),
    ).toBeInTheDocument();
    expect(screen.getByText("85")).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const startCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(startCall[1]?.body))).toMatchObject({
      mode: "full",
      companyName: "FrontMind超前智能",
      companyWebsite: "https://www.frontmind.net/",
    });
  });

  it("starts the isolated real API protocol probe", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.endsWith("/configuration")) {
          return jsonResponse({ serverCredentialConfigured: true });
        }
        if (url.endsWith("/start") && init?.method === "POST") {
          return jsonResponse(
            {
              sessionId: "probe-session",
              analysis: {
                runMode: "protocol_probe",
                taskId: "probe-task",
                status: "completed",
                terminal: true,
                outputCount: 1,
                assistantCharacterCount: 600,
                visibleCharacterCount: 6,
                visibleMarkdown: "协议探针响应",
                rawAssistantText: "协议探针响应",
                protocolKinds: ["frontmind.knowledge-base.manifest"],
                legacySocraticStateCount: 0,
                protocolObjects: [],
                diagnostics: [],
                manifest: {
                  leafCount: 8,
                  branchCount: 8,
                  branchCounts: [{ title: "企业身份", leafCount: 1 }],
                  firstLeaf: { id: "1.1", title: "企业定位" },
                  lastLeaf: { id: "8.1", title: "合作与支持" },
                  leaves: [],
                },
                issues: [],
              },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(
      await screen.findByRole("button", { name: "快速协议探针" }),
    );

    expect(
      await screen.findByText("真实协议探针：completed"),
    ).toBeInTheDocument();
    const startCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(startCall[1]?.body))).toMatchObject({
      mode: "protocol_probe",
      companyName: "FrontMind超前智能",
    });
  });

  it("replays a captured real response through the customer renderer", async () => {
    const realOutput = [
      "1.1 已确认。",
      "",
      "## 1.2 使命、愿景与企业主张",
      "",
      "硅基流动以加速 AGI 普惠人类为使命。",
      "",
      '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed","reason":"用户明确确认"}} -->',
      '<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0} -->',
    ].join("\n");
    window.history.replaceState(
      null,
      "",
      `/preview/knowledge-base-live?taskId=real-task&outputCount=3&replay=${encodeURIComponent(realOutput)}`,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).endsWith("/configuration")) {
        return jsonResponse({ serverCredentialConfigured: true });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<KnowledgeBaseLivePreview />);

    expect(
      await screen.findByRole("heading", {
        name: "1.2 使命、愿景与企业主张",
      }),
    ).toBeInTheDocument();
    const customerSection = screen
      .getByRole("heading", { name: "客户可见渲染" })
      .closest("section");
    expect(customerSection).toHaveTextContent("1.1 已确认");
    expect(customerSection).not.toHaveTextContent("FRONTMIND_KB_");
    expect(screen.getByText("real-task")).toBeInTheDocument();
    expect(
      screen.getByText("当前返回未发现结构或可见内容泄漏问题。"),
    ).toBeInTheDocument();
  });

  it("retains the initial manifest text when a restarted session confirms again", async () => {
    const continuationAnalysis = {
      runMode: "continuation",
      taskId: "task-continuation",
      status: "completed",
      terminal: true,
      protocolAccepted: true,
      outputCount: 1,
      imageCount: 0,
      assistantCharacterCount: 100,
      visibleCharacterCount: 20,
      visibleMarkdown: "## 1.2 企业名称",
      rawAssistantText: "latest continuation text",
      rawOutput: [],
      confirmationCount: 1,
      knowledgeProgress: {
        revision: 1,
        currentLeafId: "1.2",
        total: 8,
        pending: 6,
        confirmed: 1,
        overallPercent: 13,
      },
      protocolKinds: [],
      legacySocraticStateCount: 0,
      protocolObjects: [],
      diagnostics: [],
      manifest: null,
      issues: [],
    };
    vi.mocked(window.sessionStorage.getItem).mockReturnValue(
      JSON.stringify({
        sessionId: "expired-session",
        initialRawAssistantText: "initial manifest text",
        analysis: continuationAnalysis,
      }),
    );
    expect(readPersistedLiveResponse()).toMatchObject({
      sessionId: "expired-session",
      initialRawAssistantText: "initial manifest text",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = String(input);
        if (url.endsWith("/configuration")) {
          return jsonResponse({ serverCredentialConfigured: true });
        }
        if (url.endsWith("/confirm") && init?.method === "POST") {
          return jsonResponse(
            {
              sessionId: "rehydrated-session",
              analysis: { ...continuationAnalysis, status: "running" },
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "确认当前节点（第 2/3 次）",
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const confirmCall = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(confirmCall[1]?.body))).toMatchObject({
      sessionId: "expired-session",
      sourceTaskId: "task-continuation",
      sourceRawAssistantText: "initial manifest text",
      confirmationCount: 1,
      sourceRevision: 1,
      sourceCurrentLeafId: "1.2",
    });
  });

  it("routes nested API image files through the session-scoped preview proxy", async () => {
    const liveResponse = {
      sessionId: "live-session",
      analysis: {
        runMode: "full",
        taskId: "live-task",
        status: "completed",
        terminal: true,
        outputCount: 1,
        imageCount: 1,
        assistantCharacterCount: 100,
        visibleCharacterCount: 12,
        visibleMarkdown: "## 1.1 企业定位",
        rawAssistantText:
          '## 1.1 企业定位\n<!-- FRONTMIND_KB_MANIFEST {"kind":"frontmind.knowledge-base.manifest"} -->',
        rawOutput: [
          {
            id: "message-with-image",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: '## 1.1 企业定位\n<!-- FRONTMIND_KB_MANIFEST {"kind":"frontmind.knowledge-base.manifest","schemaVersion":1,"leaves":[{"id":"1.1","title":"企业定位","branchId":"identity","branchTitle":"企业身份"}]} -->',
              },
              {
                type: "output_image",
                file_id: "logo-file",
                file_name: "logo.png",
              },
              {
                type: "output_image",
                image_url: "https://cdn.example.test/hero.webp?sig=secret",
                file_name: "hero.webp",
              },
            ],
          },
        ],
        confirmationCount: 0,
        knowledgeProgress: {
          revision: 0,
          currentLeafId: "1.1",
          total: 8,
          pending: 7,
          confirmed: 0,
          overallPercent: 0,
        },
        protocolKinds: ["frontmind.knowledge-base.manifest"],
        legacySocraticStateCount: 0,
        protocolObjects: [
          {
            kind: "frontmind.knowledge-base.manifest",
            schemaVersion: 1,
            leaves: [
              {
                id: "1.1",
                title: "企业定位",
                branchId: "identity",
                branchTitle: "企业身份",
              },
            ],
          },
        ],
        diagnostics: [],
        manifest: {
          leafCount: 8,
          branchCount: 1,
          branchCounts: [{ title: "企业身份", leafCount: 8 }],
          firstLeaf: { id: "1.1", title: "企业定位" },
          lastLeaf: { id: "8.1", title: "合作与支持" },
          leaves: [],
        },
        issues: [],
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/configuration")) {
        return jsonResponse({ serverCredentialConfigured: true });
      }
      if (url.endsWith("/start") && init?.method === "POST") {
        return jsonResponse(liveResponse, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<KnowledgeBaseLivePreview />);
    fireEvent.click(await screen.findByRole("button", { name: "构建知识库" }));

    expect(await screen.findByAltText("logo.png")).toHaveAttribute(
      "src",
      "/api/dev/knowledge-base-live/live-session/files/logo-file",
    );
    expect(await screen.findByAltText("hero.webp")).toHaveAttribute(
      "src",
      "/api/dev/knowledge-base-live/live-session/external-image?url=https%3A%2F%2Fcdn.example.test%2Fhero.webp%3Fsig%3Dsecret",
    );
  });

  it("does not render or reconfirm a rejected continuation as if it advanced", async () => {
    vi.mocked(window.sessionStorage.getItem).mockReturnValue(
      JSON.stringify({
        sessionId: "rejected-session",
        initialRawAssistantText: "initial manifest text",
        analysis: {
          runMode: "continuation",
          taskId: "legacy-task",
          status: "completed",
          terminal: true,
          successfulTerminal: true,
          protocolAccepted: false,
          outputCount: 2,
          imageCount: 0,
          assistantCharacterCount: 500,
          visibleCharacterCount: 0,
          visibleMarkdown: "",
          rawAssistantText: "## 1.1 一句话定位\n旧协议正文",
          rawOutput: [],
          confirmationCount: 0,
          knowledgeProgress: {
            revision: 0,
            currentLeafId: "1.1",
            total: 8,
            pending: 7,
            confirmed: 0,
            overallPercent: 0,
          },
          protocolKinds: ["frontmind.knowledge-base.progress"],
          legacySocraticStateCount: 0,
          protocolObjects: [],
          diagnostics: [],
          manifest: null,
          issues: [
            "frontmind.knowledge-base.progress：Progress envelope contains unsupported fields: action, leafId, status",
          ],
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).endsWith("/configuration")) {
        return jsonResponse({ serverCredentialConfigured: true });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<KnowledgeBaseLivePreview />);

    expect(
      await screen.findByText(/已拒绝替换当前节点正文/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "1.1 一句话定位" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /确认当前节点/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重试本次确认（节点未推进）" }),
    ).toBeInTheDocument();
  });
});
