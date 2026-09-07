import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({
  commitKnowledgeBaseObservation: vi.fn(),
  refreshConversations: vi.fn(async () => {}),
  wakeKnowledgeBaseConversation: vi.fn(),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => context,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import KnowledgeNodeLocalActions from "./KnowledgeNodeLocalActions";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";
import { toast } from "sonner";
let disposeScope: (() => void) | undefined;
afterEach(() => { disposeScope?.(); disposeScope = undefined; vi.unstubAllGlobals(); });

const coordinates = {
  conversationId: "conversation",
  expectedGeneration: 1,
  expectedRevision: 8,
  expectedStateEpoch: 12,
  expectedContentVersion: 3,
  expectedLeafId: "1.2",
};
const observation = {
  generation: 1,
  stateEpoch: 13,
  interaction: { progress: { build: { revision: 9 } } },
  approvedPresentation: { presentationKey: "presentation-selected" },
};
beforeEach(() => vi.clearAllMocks());
describe("local knowledge node controls", () => {
  it("does not select the old node when the project changes while its library response is parsing", async () => {
    disposeScope = activateWorkspaceRestScope("1:project-a", "project-a");
    let resolveLibrary!: (value: unknown) => void;
    const json = vi.fn(() => new Promise(resolve => { resolveLibrary = resolve; }));
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json });
    vi.stubGlobal("fetch", fetcher);
    render(<KnowledgeNodeLocalActions conversationId="conversation" leafId="1.2" />);
    fireEvent.click(screen.getByRole("button", { name: "编辑文字 / 上传图片" }));
    await waitFor(() => expect(json).toHaveBeenCalled());
    disposeScope = activateWorkspaceRestScope("1:project-b", "project-b");
    await act(async () => resolveLibrary({ coordinates, images: [] }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("x-enterprise-project-id")).toBe("project-a");
    expect(context.commitKnowledgeBaseObservation).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
  it("selects a confirmed node locally after StrictMode effect replay without reset or model submission", async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("node/images")
              ? { coordinates, images: [] }
              : { observation },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(
      <StrictMode><KnowledgeNodeLocalActions conversationId="conversation" leafId="1.2" /></StrictMode>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "编辑文字 / 上传图片" }),
    );
    await waitFor(() =>
      expect(context.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
        "conversation",
        observation,
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe("/api/knowledge-base/node/select");
  });
  it("sends image replacement as an empty text turn with exact local selections", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const value = url.includes("node/images")
          ? {
              coordinates,
              images: [
                {
                  assetId: "old-image",
                  url: "/old.png",
                  caption: "旧图片",
                  attached: true,
                  removable: true,
                  selectable: true,
                },
                {
                  assetId: "new-image",
                  url: "/new.png",
                  caption: "新图片",
                  attached: false,
                  removable: false,
                  selectable: true,
                },
              ],
            }
          : { observation };
        return new Response(JSON.stringify(value), { status: 200 });
      }),
    );
    render(
      <KnowledgeNodeLocalActions conversationId="conversation" leafId="1.2" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "本地图片" }));
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    await waitFor(() =>
      expect(context.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
        "conversation",
      ),
    );
    expect(
      calls.find((call) => call.url === "/api/knowledge-base/turn")?.body,
    ).toMatchObject({
      userMessage: "",
      attachments: [],
      removeAssetIds: ["old-image"],
      selectedAssetIds: ["new-image"],
      expectedRevision: 9,
      expectedPresentationKey: "presentation-selected",
    });
    expect(
      calls.some((call) => /reset|frontmind\/v2|provider/.test(call.url)),
    ).toBe(false);
  });
});
