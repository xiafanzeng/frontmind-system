import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  overviewUseQuery,
  overviewRefetch,
  sessionsUseQuery,
  sessionsRefetch,
  sessionUseQuery,
  sessionRefetch,
  fetchMock,
} = vi.hoisted(() => ({
  overviewUseQuery: vi.fn(),
  overviewRefetch: vi.fn(),
  sessionsUseQuery: vi.fn(),
  sessionsRefetch: vi.fn(),
  sessionUseQuery: vi.fn(),
  sessionRefetch: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      brandTracking: {
        overview: { useQuery: overviewUseQuery },
        listSessions: { useQuery: sessionsUseQuery },
        getSession: { useQuery: sessionUseQuery },
      },
    },
  },
}));

import BrandTrackingAgentPanel, {
  brandTrackingOverviewRefetchInterval,
  brandTrackingSessionRefetchInterval,
  consumeBrandTrackingSse,
} from "./BrandTrackingAgentPanel";

const usage = {
  rolling30DayCost: "1.25000000",
  lifetimeCost: "4.87500000",
  limit: "10.00000000",
  remaining: "8.75000000",
  exceededBy: "0.00000000",
  windowStartedAt: "2026-07-10T00:00:00.000Z",
  windowEndsAt: "2026-08-09T00:00:00.000Z",
  pendingReconciliationCount: 0,
  hasUnknownUsage: false,
};

const defaultOverview = {
  eligible: true,
  keyConfigured: true,
  blocked: false,
  blockReason: null,
  activeSessionId: null,
  usage,
};

function queryState<T>(data?: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
    refetch: vi.fn(),
  };
}

function sseResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

const activeSummary = {
  sessionId: "session-1",
  title: "示例品牌持续追踪",
  status: "active" as const,
  createdAt: "2026-08-09T01:00:00.000Z",
  updatedAt: "2026-08-09T02:00:00.000Z",
  lastMessagePreview: "第一条引导",
};

const activeSessionData = {
  session: {
    sessionId: "session-1",
    title: "示例品牌持续追踪",
    status: "active" as const,
    createdAt: "2026-08-09T01:00:00.000Z",
    updatedAt: "2026-08-09T02:00:00.000Z",
  },
  messages: [
    {
      messageId: "assistant-1",
      role: "assistant" as const,
      content: "请告诉我这次希望重点追踪的平台和时间范围。",
      status: "completed" as const,
      createdAt: "2026-08-09T01:00:01.000Z",
      usageCost: "0.39200000",
    },
  ],
};

type TestOverview = Omit<
  typeof defaultOverview,
  "activeSessionId" | "blockReason"
> & {
  activeSessionId: string | null;
  blockReason: string | null;
};

type TestSessionMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "completed" | "failed" | "pending_reconciliation";
  createdAt: string;
  usageCost?: string;
};

type TestSessionData = Omit<typeof activeSessionData, "messages"> & {
  messages: TestSessionMessage[];
};

describe("consumeBrandTrackingSse", () => {
  it("parses CRLF, chunk boundaries, comments, and multi-line data", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await consumeBrandTrackingSse(
      sseResponse([
        ": keepalive\r",
        '\nevent: progress\r\ndata: {"message":\r\n',
        'data: "正在分析"}\r\n\r\nevent: delta\r\ndata: 第一段\r\n',
      ]),
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: "progress", payload: { message: "正在分析" } },
      { type: "delta", payload: { text: "第一段" } },
    ]);
  });
});

describe("brand tracking persisted-state polling", () => {
  it("polls unknown usage and unfinished messages, then stops at stable data", () => {
    expect(
      brandTrackingOverviewRefetchInterval({
        state: {
          data: {
            ...defaultOverview,
            usage: {
              ...usage,
              pendingReconciliationCount: 1,
              hasUnknownUsage: true,
            },
          },
        },
      }),
    ).toBe(2_000);
    expect(
      brandTrackingOverviewRefetchInterval({
        state: { data: defaultOverview },
      }),
    ).toBe(false);

    expect(
      brandTrackingSessionRefetchInterval({
        state: {
          data: {
            ...activeSessionData,
            messages: [
              {
                ...activeSessionData.messages[0],
                status: "pending_reconciliation",
              },
            ],
          },
        },
      }),
    ).toBe(2_000);
    expect(
      brandTrackingSessionRefetchInterval({
        state: { data: activeSessionData },
      }),
    ).toBe(false);
  });
});

describe("BrandTrackingAgentPanel", () => {
  beforeEach(() => {
    overviewUseQuery.mockReset();
    overviewRefetch.mockReset();
    sessionsUseQuery.mockReset();
    sessionsRefetch.mockReset();
    sessionUseQuery.mockReset();
    sessionRefetch.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);

    overviewRefetch.mockResolvedValue({ data: defaultOverview });
    sessionsRefetch.mockResolvedValue({ data: { sessions: [] } });
    sessionRefetch.mockResolvedValue(undefined);
    overviewUseQuery.mockReturnValue({
      ...queryState(defaultOverview),
      refetch: overviewRefetch,
    });
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockReturnValue({
      ...queryState(undefined),
      refetch: sessionRefetch,
    });
  });

  it("uses the knowledge-base style starter without an initial prompt or textarea", () => {
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getAllByText("品牌追踪智能体")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "启动品牌追踪" })).toBeEnabled();
    expect(screen.getByText("持续对话")).toBeInTheDocument();
    expect(screen.getByText("趋势分析")).toBeInTheDocument();
    expect(screen.getByText("信源核验")).toBeInTheDocument();
    expect(screen.getByText("10,000")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("持久化多轮品牌追踪与用量归因");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("近期的品牌评价");
  });

  it("omits the unit only from the three rolling usage statistics", () => {
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getByText("积分上限").nextElementSibling).toHaveTextContent(
      /^10,000$/u,
    );
    expect(screen.getByText("已使用").nextElementSibling).toHaveTextContent(
      /^1,250$/u,
    );
    expect(screen.getByText("剩余").nextElementSibling).toHaveTextContent(
      /^8,750$/u,
    );
    expect(screen.getByLabelText("滚动30天品牌追踪剩余额度")).toHaveTextContent(
      "剩余 8,750积分",
    );
    expect(screen.getByText("账号累计积分").parentElement).toHaveTextContent(
      "账号累计积分4,875积分",
    );
  });

  it("opens a fieldless confirmation and streams the hidden-start response once", async () => {
    const sourceBrand = ["Jeno", "va"].join("");
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: session\ndata: {"sessionId":"session-new"}\n\n',
        `event: progress\ndata: {"message":"${sourceBrand} 正在准备"}\n\n`,
        `event: delta\ndata: {"text":"${sourceBrand} 已启动。请确认追踪范围。"}\n\n`,
        'event: usage\ndata: {"cost":"0.01000000"}\n\n',
        'event: end\ndata: {"sessionId":"session-new","status":"completed"}\n\n',
      ]),
    );
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    fireEvent.click(screen.getByRole("button", { name: "启动品牌追踪" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("确认启动新的品牌追踪？"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).getByText("示例品牌")).toBeInTheDocument();
    expect(within(dialog).getByText("不确定，由 API 建议")).toBeInTheDocument();
    expect(within(dialog).getByText("全部")).toBeInTheDocument();
    expect(within(dialog).getByText("过去 7 天")).toBeInTheDocument();

    const confirm = within(dialog).getByRole("button", { name: "确认启动" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/brand-tracking/sessions");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      clientRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(Object.keys(body)).toEqual(["clientRequestId"]);
    expect(String(init.body)).not.toContain("开始品牌追踪");
    expect(String(init.body)).not.toContain("示例品牌");
    expect(String(init.body)).not.toContain("过去 7 天");

    await waitFor(() =>
      expect(
        screen.getByText("FrontMind 已启动。请确认追踪范围。"),
      ).toBeInTheDocument(),
    );
    expect(document.body.textContent?.toLowerCase()).not.toContain(
      sourceBrand.toLowerCase(),
    );
    expect(screen.getByLabelText("品牌追踪消息")).toBeEnabled();
    expect(screen.getByText("本轮 10积分")).toBeInTheDocument();
  });

  it("blocks a new session locally when the dashboard brand is missing", () => {
    render(<BrandTrackingAgentPanel brandName="  " />);

    expect(screen.getByRole("button", { name: "启动品牌追踪" })).toBeDisabled();
    expect(
      screen.getByText("请先在看板绑定有效的品牌名称。"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the SSE lifecycle mounted across the StrictMode effect replay", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: session\ndata: {"sessionId":"session-strict"}\n\n',
        'event: delta\ndata: {"text":"严格模式下已启动。"}\n\n',
        'event: end\ndata: {"sessionId":"session-strict","status":"completed"}\n\n',
      ]),
    );
    render(
      <StrictMode>
        <BrandTrackingAgentPanel brandName="示例品牌" />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "启动品牌追踪" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "确认启动",
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("严格模式下已启动。")).toBeInTheDocument();
    expect(screen.getByLabelText("品牌追踪消息")).toBeEnabled();
  });

  it("restores a session and sends Enter exactly once while Shift+Enter stays local", async () => {
    const overview = { ...defaultOverview, activeSessionId: "session-1" };
    overviewUseQuery.mockReturnValue({
      ...queryState(overview),
      refetch: overviewRefetch,
    });
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [activeSummary] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(input.sessionId ? activeSessionData : undefined),
      refetch: sessionRefetch,
    }));
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: delta\ndata: {"text":"已补充分析。"}\n\n',
        'event: end\ndata: {"sessionId":"session-1","status":"completed","cost":"0.02000000"}\n\n',
      ]),
    );
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    const composer = await screen.findByLabelText("品牌追踪消息");
    await waitFor(() => expect(composer).toBeEnabled());
    expect(screen.getByText("本轮 392积分")).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: "请聚焦海外社交媒体" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/brand-tracking/sessions/session-1/messages");
    expect(JSON.parse(String(init.body))).toMatchObject({
      content: "请聚焦海外社交媒体",
      clientRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    await waitFor(() =>
      expect(screen.getByText("已补充分析。")).toBeInTheDocument(),
    );
  });

  it("recovers an active session discovered after the initial empty snapshot", async () => {
    let overview: TestOverview = defaultOverview;
    let sessions: Array<typeof activeSummary> = [];
    overviewUseQuery.mockImplementation(() => ({
      ...queryState(overview),
      refetch: overviewRefetch,
    }));
    sessionsUseQuery.mockImplementation(() => ({
      ...queryState({ sessions }),
      refetch: sessionsRefetch,
    }));
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(input.sessionId ? activeSessionData : undefined),
      refetch: sessionRefetch,
    }));
    const view = render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(
      screen.getByRole("button", { name: "启动品牌追踪" }),
    ).toBeInTheDocument();

    overview = { ...defaultOverview, activeSessionId: "session-1" };
    sessions = [activeSummary];
    view.rerender(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(await screen.findByLabelText("品牌追踪消息")).toBeEnabled();
    expect(
      screen.getByText("请告诉我这次希望重点追踪的平台和时间范围。"),
    ).toBeInTheDocument();
  });

  it("scopes high-contrast blockquote styling to brand-tracking markdown", async () => {
    const overview = { ...defaultOverview, activeSessionId: "session-1" };
    overviewUseQuery.mockReturnValue({
      ...queryState(overview),
      refetch: overviewRefetch,
    });
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [activeSummary] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(
        input.sessionId
          ? {
              ...activeSessionData,
              messages: [
                {
                  ...activeSessionData.messages[0],
                  content:
                    "> **品牌追踪目标：**\n> - 追踪 `SiliconFlow` 的近期声量",
                },
              ],
            }
          : undefined,
      ),
      refetch: sessionRefetch,
    }));

    const { container } = render(
      <BrandTrackingAgentPanel brandName="示例品牌" />,
    );

    await screen.findByText("品牌追踪目标：");
    const markdown = container.querySelector(".brand-tracking-markdown");
    expect(markdown).not.toBeNull();
    expect(markdown?.querySelector("blockquote")).toHaveTextContent(
      "追踪 SiliconFlow 的近期声量",
    );
    const css = readFileSync(
      resolve(process.cwd(), "client/src/styles/markdown.css"),
      "utf8",
    );
    expect(css).toContain(
      ".dark .markdown-content.brand-tracking-markdown blockquote",
    );
    expect(css).toContain("background: #fff");
    expect(css).toContain("color: #30273a");
    expect(css).toContain("font-style: normal");
  });

  it("keeps a persisted running turn locked and unlocks after polling reaches completion", async () => {
    const runningMessage: TestSessionMessage = {
      messageId: "assistant-running",
      role: "assistant",
      content: "正在补充分析",
      status: "streaming",
      createdAt: "2026-08-09T02:01:00.000Z",
    };
    let overview: TestOverview = {
      ...defaultOverview,
      activeSessionId: "session-1",
      blocked: true,
      blockReason: "上一轮积分仍在核对，暂时不能发送新消息",
      usage: {
        ...usage,
        pendingReconciliationCount: 1,
        hasUnknownUsage: true,
      },
    };
    let sessionData: TestSessionData = {
      ...activeSessionData,
      messages: [...activeSessionData.messages, runningMessage],
    };
    overviewUseQuery.mockImplementation(() => ({
      ...queryState(overview),
      refetch: overviewRefetch,
    }));
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [activeSummary] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(input.sessionId ? sessionData : undefined),
      refetch: sessionRefetch,
    }));
    const view = render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    const composer = await screen.findByLabelText("品牌追踪消息");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute(
      "placeholder",
      "上一轮积分仍在核对，暂时不能发送新消息",
    );

    overview = {
      ...defaultOverview,
      activeSessionId: "session-1",
    };
    sessionData = {
      ...activeSessionData,
      messages: [
        ...activeSessionData.messages,
        { ...runningMessage, status: "completed" },
      ],
    };
    view.rerender(<BrandTrackingAgentPanel brandName="示例品牌" />);

    await waitFor(() => expect(composer).toBeEnabled());
  });

  it("renders normalized stream warnings and terminal errors", async () => {
    const overview = { ...defaultOverview, activeSessionId: "session-1" };
    overviewUseQuery.mockReturnValue({
      ...queryState(overview),
      refetch: overviewRefetch,
    });
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [activeSummary] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(input.sessionId ? activeSessionData : undefined),
      refetch: sessionRefetch,
    }));
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: warning\ndata: {"message":"部分信源暂不可访问"}\n\n',
        'event: error\ndata: {"message":"本轮上游执行失败","code":"upstream_failed"}\n\n',
        'event: end\ndata: {"sessionId":"session-1","status":"failed"}\n\n',
      ]),
    );
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    const composer = await screen.findByLabelText("品牌追踪消息");
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送品牌追踪消息" }));

    expect(await screen.findByText("部分信源暂不可访问")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本轮上游执行失败",
    );
    expect(screen.getByText("本轮失败")).toBeInTheDocument();
  });

  it("marks a stream without an end event as pending reconciliation", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: session\ndata: {"sessionId":"session-new"}\n\n',
        'event: delta\ndata: {"text":"已生成但尚未结算。"}\n\n',
      ]),
    );
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    fireEvent.click(screen.getByRole("button", { name: "启动品牌追踪" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "确认启动",
      }),
    );

    expect(await screen.findByText("积分与结果待确认")).toBeInTheDocument();
    expect(screen.getByLabelText("品牌追踪消息")).toBeDisabled();
    expect(screen.getByText(/服务端仍会继续核对/)).toBeInTheDocument();
  });

  it("switches to archived history read-only and offers a confirmed new session", async () => {
    const archivedSummary = {
      sessionId: "session-old",
      title: "上一次品牌追踪",
      status: "archived" as const,
      createdAt: "2026-08-01T01:00:00.000Z",
      updatedAt: "2026-08-01T02:00:00.000Z",
    };
    const overview = { ...defaultOverview, activeSessionId: "session-1" };
    overviewUseQuery.mockReturnValue({
      ...queryState(overview),
      refetch: overviewRefetch,
    });
    sessionsUseQuery.mockReturnValue({
      ...queryState({ sessions: [activeSummary, archivedSummary] }),
      refetch: sessionsRefetch,
    });
    sessionUseQuery.mockImplementation((input: { sessionId: string }) => ({
      ...queryState(
        input.sessionId === "session-old"
          ? {
              session: { ...archivedSummary },
              messages: [
                {
                  ...activeSessionData.messages[0],
                  messageId: "assistant-old",
                  content: "历史追踪结果",
                },
              ],
            }
          : input.sessionId
            ? activeSessionData
            : undefined,
      ),
      refetch: sessionRefetch,
    }));
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    const selector = await screen.findByLabelText("历史追踪会话");
    expect(selector.className.split(/\s+/)).not.toContain("hidden");
    fireEvent.change(selector, { target: { value: "session-old" } });
    await waitFor(() =>
      expect(screen.getByLabelText("品牌追踪消息")).toHaveAttribute(
        "placeholder",
        "历史会话为只读，请新建追踪",
      ),
    );
    expect(screen.getByLabelText("品牌追踪消息")).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "新建追踪" })[0]);
    expect(screen.getByText("确认启动新的品牌追踪？")).toBeInTheDocument();
  });

  it("shows exact rolling usage and blocks starts when the user reached the limit", () => {
    overviewUseQuery.mockReturnValue({
      ...queryState({
        ...defaultOverview,
        blocked: true,
        blockReason:
          "已达到滚动 30 天积分上限，请联系负责工程师或系统管理员调整。",
        usage: {
          ...usage,
          rolling30DayCost: "10.12500000",
          remaining: "0.00000000",
          exceededBy: "0.12500000",
        },
      }),
      refetch: overviewRefetch,
    });
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getByRole("button", { name: "启动品牌追踪" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "已达到滚动 30 天积分上限",
    );
    expect(screen.getByText("10,125")).toBeInTheDocument();
    expect(screen.getByText("已超出上限 125积分")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$|美元|费用/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows reconciliation as the blocking reason without reporting a zero overage", () => {
    overviewUseQuery.mockReturnValue({
      ...queryState({
        ...defaultOverview,
        blocked: true,
        blockReason: "上一轮积分仍在核对，暂时不能发送新消息",
        usage: {
          ...usage,
          pendingReconciliationCount: 1,
          hasUnknownUsage: true,
          exceededBy: "0.00000000",
        },
      }),
      refetch: overviewRefetch,
    });
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getByRole("alert")).toHaveTextContent("上一轮积分仍在核对");
    expect(screen.queryByText(/已超出上限/)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("已达到滚动 30 天积分上限");
  });

  it("treats a zero-credit limit as paused without claiming a zero overage", () => {
    overviewUseQuery.mockReturnValue({
      ...queryState({
        ...defaultOverview,
        blocked: true,
        blockReason: "最近 30 天品牌追踪积分已达到上限",
        usage: {
          ...usage,
          rolling30DayCost: "0.00000000",
          limit: "0.00000000",
          remaining: "0.00000000",
          exceededBy: "0.00000000",
        },
      }),
      refetch: overviewRefetch,
    });
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getByRole("button", { name: "启动品牌追踪" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("积分已达到上限");
    expect(screen.queryByText(/已超出上限/)).not.toBeInTheDocument();
  });

  it("requires a system configured key", () => {
    overviewUseQuery.mockReturnValue({
      ...queryState({
        ...defaultOverview,
        keyConfigured: false,
      }),
      refetch: overviewRefetch,
    });
    render(<BrandTrackingAgentPanel brandName="示例品牌" />);

    expect(screen.getByRole("button", { name: "启动品牌追踪" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "系统管理员尚未为当前账号配置品牌追踪 Key",
    );
  });
});
