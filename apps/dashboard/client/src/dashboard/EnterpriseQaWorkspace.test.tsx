import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EnterpriseQaWorkspace, {
  EnterpriseQaSourceNote,
} from "./EnterpriseQaWorkspace";

const state = vi.hoisted(() => ({ activeConversation: null as any }));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({ activeConversation: state.activeConversation }),
  ConversationPurposeProvider: ({ children, purpose }: any) => (
    <div data-purpose={purpose} data-testid="purpose">
      {children}
    </div>
  ),
}));
vi.mock("@/pages/Home", () => ({
  default: (props: any) => (
    <div
      data-testid="chat"
      data-purpose={props.purpose}
      data-starter={String(props.showKnowledgeBaseStarter)}
    />
  ),
}));

describe("Enterprise QA source binding", () => {
  beforeEach(() => {
    state.activeConversation = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens real scoped chat and shows the published source used by a new task", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            snapshotId: "snapshot-new",
            version: 8,
            sourceFileName: "企业知识库.md",
            documentCount: 12,
            contentHash: "server-only-hash",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<EnterpriseQaWorkspace />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "新会话使用已发布知识库 v8",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "企业知识库.md · 12 篇资料",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "server-only-hash",
    );
    expect(screen.getByTestId("chat")).toHaveAttribute(
      "data-purpose",
      "enterprise_qa",
    );
    expect(screen.getByTestId("chat")).toHaveAttribute("data-starter", "false");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/frontmind/v2/runtime-config?purpose=enterprise_qa",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("reads an existing task's frozen version and discards stale metadata after switching tasks", async () => {
    let resolveOld!: (response: unknown) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            version: 3,
            sourceFileName: "历史资料.md",
            documentCount: 5,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    state.activeConversation = { taskId: "task-old" };
    const { rerender } = render(<EnterpriseQaSourceNote />);
    state.activeConversation = { taskId: "task-current" };
    rerender(<EnterpriseQaSourceNote />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "本会话绑定已发布知识库 v3",
      ),
    );
    await act(async () => {
      resolveOld({
        ok: true,
        json: async () => ({
          knowledgeBase: {
            version: 1,
            sourceFileName: "过期资料.md",
            documentCount: 1,
          },
        }),
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("历史资料.md");
    expect(screen.getByRole("status")).not.toHaveTextContent("过期资料.md");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/frontmind/v2/runtime-config?localTaskId=task-current",
    );
  });

  it("directs an account without a published knowledge base to the real knowledge workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ knowledgeBase: null }),
        }),
    );
    render(<EnterpriseQaSourceNote />);
    expect(
      await screen.findByRole("link", { name: "构建并发布知识库" }),
    ).toHaveAttribute("href", "/knowledge-base");
    expect(screen.getByRole("status")).toHaveTextContent(
      "尚无可用的已发布企业知识库",
    );
  });
});
