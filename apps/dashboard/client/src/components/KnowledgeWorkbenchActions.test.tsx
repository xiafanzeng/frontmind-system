import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ commitKnowledgeBaseObservation: vi.fn() }));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => context,
}));
import KnowledgeWorkbenchActions from "./KnowledgeWorkbenchActions";
const progress: any = {
  workbench: { phase: "initial", generation: 1, stateEpoch: 4 },
  build: {
    id: "build",
    contentVersion: 1,
    revision: 2,
    awaitingResponseSince: null,
  },
  contentAvailability: "complete",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("knowledge initial draft actions", () => {
  it("keeps acceptance in the main area and exposes version and download directly in the resource area", () => {
    render(
      <>
        <main>
          <KnowledgeWorkbenchActions
            presentation="accept"
            progress={progress}
            conversationId="conversation"
            resetRevision={3}
            onProgress={vi.fn()}
          />
        </main>
        <aside>
          <KnowledgeWorkbenchActions
            presentation="resource"
            progress={progress}
            conversationId="conversation"
            resetRevision={3}
            onProgress={vi.fn()}
          />
        </aside>
      </>,
    );
    expect(
      within(screen.getByRole("main")).getByRole("button", {
        name: "开始逐节点核验",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).queryByRole("link", { name: /ZIP/ }),
    ).toBeNull();
    expect(
      within(screen.getByRole("complementary")).queryByText("工作稿版本 1"),
    ).toBeNull();
    expect(
      within(screen.getByRole("complementary")).queryByText("正在逐节点核验"),
    ).toBeNull();
    expect(
      within(screen.getByRole("complementary")).getByRole("link", {
        name: "导出工作稿 ZIP",
      }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("expectedContentVersion=1"),
    );
    expect(
      within(screen.getByRole("complementary")).queryByRole("button", {
        name: "开始逐节点核验",
      }),
    ).toBeNull();
  });
  it("retries a failed initial acceptance with the same id and commits the authoritative editing phase", async () => {
    const updated = {
      ...progress,
      workbench: { ...progress.workbench, phase: "editing" },
    };
    const observation = { progress: updated };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "连接中断，请重试" } }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true, observation }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const onProgress = vi.fn();
    render(
      <KnowledgeWorkbenchActions
        progress={progress}
        conversationId="conversation"
        resetRevision={3}
        onProgress={onProgress}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "开始逐节点核验" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");
    fireEvent.click(screen.getByRole("button", { name: "开始逐节点核验" }));
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith(updated));
    const first = JSON.parse(fetcher.mock.calls[0][1].body),
      second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      conversationId: "conversation",
      expectedGeneration: 1,
      expectedContentVersion: 1,
      expectedStateEpoch: 4,
      expectedResetRevision: 3,
    });
    expect(context.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "conversation",
      observation,
    );
  });
  it("does not offer initial acceptance in editing phase and downloads the exact current workspace", () => {
    render(
      <KnowledgeWorkbenchActions
        progress={{
          ...progress,
          workbench: { ...progress.workbench, phase: "editing" },
        }}
        conversationId="conversation"
        resetRevision={3}
        onProgress={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "开始逐节点核验" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "导出工作稿 ZIP" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("expectedContentVersion=1"),
    );
  });
  it("lets an unsaved editor download the saved workspace while initial confirmation remains blocked", () => {
    render(
      <KnowledgeWorkbenchActions
        progress={progress}
        conversationId="conversation"
        resetRevision={3}
        disabled
        exportDisabled={false}
        hasUnsavedChanges
        onProgress={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "开始逐节点核验" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "下载已保存工作稿 ZIP" }),
    ).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByText(/下载包含已保存的节点和资料/)).toBeInTheDocument();
  });
});
