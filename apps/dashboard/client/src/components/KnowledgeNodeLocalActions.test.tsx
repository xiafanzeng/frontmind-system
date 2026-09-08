import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({
  commitKnowledgeBaseObservation: vi.fn(),
  refreshConversations: vi.fn(async () => {}),
  wakeKnowledgeBaseConversation: vi.fn(),
}));
const api = vi.hoisted(() => ({
  reserveKnowledgeBaseTurnWithAttachments: vi.fn(),
  uploadKnowledgeBaseLocalAsset: vi.fn(),
  stageKnowledgeBaseTurnAttachment: vi.fn(),
  createKnowledgeBaseTurnTask: vi.fn(),
  cancelKnowledgeBaseTurnAttachments: vi.fn(),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => context,
}));
vi.mock("@/lib/frontmind-api", () => api);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import KnowledgeNodeLocalActions from "./KnowledgeNodeLocalActions";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";
import { toast } from "sonner";
import { getUnsavedWorkspaceDrafts } from "@/lib/workspace-navigation-guard";
let disposeScope: (() => void) | undefined;
afterEach(() => {
  disposeScope?.();
  disposeScope = undefined;
  vi.unstubAllGlobals();
});
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
const oldImage = {
  assetId: "old-image",
  url: "/old.png",
  caption: "旧图片",
  attached: true,
  removable: true,
  selectable: true,
};
function installFetch(
  images: unknown[] = [oldImage],
  selectError?: { status: number; message: string },
) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const isLibrary = url.includes("node/images");
    const failure = !isLibrary && selectError;
    return new Response(
      JSON.stringify(
        isLibrary
          ? { coordinates, images }
          : failure
            ? { error: { message: failure.message } }
            : { observation },
      ),
      { status: failure ? failure.status : 200 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}
function renderActions() {
  return render(
    <KnowledgeNodeLocalActions
      conversationId="conversation"
      leafId="1.2"
      resetRevision={2}
    />,
  );
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "图片管理" }));
  await screen.findByRole("dialog", { name: "当前节点的图片" });
}
function choose() {
  fireEvent.change(screen.getByLabelText("上传当前节点图片"), {
    target: {
      files: [
        new File(["pixels"], "产品.png", {
          type: "image/png",
          lastModified: 4,
        }),
      ],
    },
  });
}
async function submit() {
  fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
  await waitFor(() =>
    expect(api.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalled(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview-image"),
      revokeObjectURL: vi.fn(),
    }),
  );
  api.reserveKnowledgeBaseTurnWithAttachments.mockResolvedValue({
    reservation: { turnId: "image-turn", sourceResetRevision: 2 },
    knowledgeObservation: observation,
  });
  api.uploadKnowledgeBaseLocalAsset.mockResolvedValue({
    fileId: "new-local-image",
    filename: "产品.png",
    sizeBytes: 6,
    contentSha256: "a".repeat(64),
  });
  api.stageKnowledgeBaseTurnAttachment.mockResolvedValue({ observation });
  api.createKnowledgeBaseTurnTask.mockResolvedValue({
    status: "running",
    knowledgeObservation: observation,
  });
  api.cancelKnowledgeBaseTurnAttachments.mockResolvedValue({
    cancelled: true,
    knowledgeObservation: observation,
  });
});
describe("node image management", () => {
  it("shows only this node's attached images and removes them through the existing local turn", async () => {
    const { calls } = installFetch([
      oldImage,
      {
        ...oldImage,
        assetId: "unrelated",
        attached: false,
        caption: "历史项目图",
      },
    ]);
    renderActions();
    await open();
    expect(screen.queryByAltText("历史项目图")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 旧图片" }));
    const draft = getUnsavedWorkspaceDrafts()[0]!;
    await act(async () => expect(await draft.save!()).toBe(true));
    expect(
      calls.find((call) => call.url === "/api/knowledge-base/turn")?.body,
    ).toMatchObject({
      userMessage: "",
      attachments: [],
      removeAssetIds: ["old-image"],
      selectedAssetIds: [],
      expectedLeafId: "1.2",
      expectedRevision: 9,
    });
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
  });
  it("previews selected files and binds upload plus removal to one frozen node reservation", async () => {
    installFetch();
    renderActions();
    await open();
    choose();
    expect(screen.getByAltText("产品.png")).toHaveAttribute(
      "src",
      "blob:preview-image",
    );
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除 旧图片" }));
    await submit();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const reserved =
      api.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1];
    expect(reserved).toMatchObject({
      conversationId: "conversation",
      expectedGeneration: 1,
      expectedRevision: 9,
      expectedResetRevision: 2,
      expectedLeafId: "1.2",
      removeAssetIds: ["old-image"],
      attachmentManifest: [
        {
          filename: "产品.png",
          sizeBytes: 6,
          mimeType: "image/png",
          ordinal: 1,
          total: 1,
        },
      ],
    });
    expect(api.uploadKnowledgeBaseLocalAsset.mock.calls[0]![3]).toMatchObject({
      itemId: reserved.attachmentManifest[0].itemId,
      resumeScope: {
        turnId: "image-turn",
        clientRequestId: reserved.clientRequestId,
        expectedResetRevision: 2,
      },
    });
    expect(api.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: { file_id: "new-local-image", filename: "产品.png" },
        turnId: "image-turn",
        attachmentManifest: reserved.attachmentManifest,
      }),
    );
    expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        clientRequestId: reserved.clientRequestId,
        attachmentReservation: {
          turnId: "image-turn",
          attachmentManifest: reserved.attachmentManifest,
        },
      }),
      expect.any(AbortSignal),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "图片修改已提交，保存完成后会自动更新",
    );
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
  });
  it("reuses the reservation and upload item after an upload response is lost", async () => {
    installFetch();
    api.uploadKnowledgeBaseLocalAsset.mockRejectedValueOnce(
      new Error("网络中断"),
    );
    renderActions();
    await open();
    choose();
    await submit();
    await screen.findByRole("alert");
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(1);
    const options = api.uploadKnowledgeBaseLocalAsset.mock.calls[0]![3];
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() =>
      expect(api.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1),
    );
    expect(api.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(api.uploadKnowledgeBaseLocalAsset.mock.calls[1]![3]).toMatchObject({
      itemId: options.itemId,
      resumeScope: options.resumeScope,
    });
  });
  it("replays only the same dispatch after a lost response, without uploading or selecting again", async () => {
    const { calls } = installFetch();
    api.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      new Error("response lost"),
    );
    renderActions();
    await open();
    choose();
    await submit();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(api.uploadKnowledgeBaseLocalAsset).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((call) => call.url.endsWith("node/select")),
    ).toHaveLength(1);
    expect(api.createKnowledgeBaseTurnTask.mock.calls[1]![1]).toEqual(
      api.createKnowledgeBaseTurnTask.mock.calls[0]![1],
    );
  });
  it("allows a definitively rejected dispatch to cancel its reservation and leave", async () => {
    installFetch();
    api.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      Object.assign(new Error("版本冲突"), { status: 409, code: "CONFLICT" }),
    );
    renderActions();
    await open();
    choose();
    await submit();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeEnabled();
    const draft = getUnsavedWorkspaceDrafts()[0]!;
    await act(async () => expect(await draft.discard!()).toBe(true));
    expect(api.cancelKnowledgeBaseTurnAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation",
        turnId: "image-turn",
        expectedResetRevision: 2,
      }),
      expect.any(AbortSignal),
    );
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
  });
  it("cancels an interrupted upload before the navigation guard discards its files", async () => {
    installFetch();
    api.uploadKnowledgeBaseLocalAsset.mockRejectedValueOnce(
      new Error("网络中断"),
    );
    renderActions();
    await open();
    choose();
    await submit();
    await screen.findByRole("alert");
    api.cancelKnowledgeBaseTurnAttachments.mockRejectedValueOnce(
      new Error("取消失败"),
    );
    const draft = getUnsavedWorkspaceDrafts()[0]!;
    await act(async () => expect(await draft.discard!()).toBe(false));
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(1);
    await act(async () => expect(await draft.discard!()).toBe(true));
    expect(api.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-image");
  });
  it("keeps drafts after a stale node selection and does not upload or reserve", async () => {
    installFetch([], { status: 409, message: "节点版本变化" });
    renderActions();
    await open();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "保存图片" }));
    await screen.findByRole("alert");
    expect(screen.getByAltText("产品.png")).toBeVisible();
    expect(api.reserveKnowledgeBaseTurnWithAttachments).not.toHaveBeenCalled();
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("aborts the old upload and never stages it into a newly selected project", async () => {
    disposeScope = activateWorkspaceRestScope("1:project-a", "project-a");
    installFetch();
    let finish!: (value: unknown) => void;
    api.uploadKnowledgeBaseLocalAsset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderActions();
    await open();
    choose();
    await submit();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const signal = api.uploadKnowledgeBaseLocalAsset.mock.calls[0]![3].signal;
    disposeScope = activateWorkspaceRestScope("1:project-b", "project-b");
    await act(async () =>
      finish({ fileId: "old-upload", filename: "产品.png" }),
    );
    expect(signal.aborted).toBe(true);
    expect(api.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(api.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });
  it("rejects unsupported files without any reservation or upload", async () => {
    installFetch([]);
    renderActions();
    await open();
    fireEvent.change(screen.getByLabelText("上传当前节点图片"), {
      target: {
        files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择 PNG");
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
    expect(api.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
  });
  it("does not activate a stale AI target after the selected leaf changes", async () => {
    const selected = vi.fn();
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: () =>
        new Promise((done) => {
          resolve = done;
        }),
    }));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(
      <KnowledgeNodeLocalActions
        conversationId="conversation"
        leafId="1.2"
        onEditTargetSelected={selected}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 修改" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    rerender(
      <KnowledgeNodeLocalActions
        conversationId="conversation"
        leafId="2.1"
        onEditTargetSelected={selected}
      />,
    );
    await act(async () => resolve({ coordinates, images: [] }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
  });
  it("retains ordinary AI targeting after StrictMode effect replay", async () => {
    const { calls } = installFetch([]);
    render(
      <StrictMode>
        <KnowledgeNodeLocalActions conversationId="conversation" leafId="1.2" />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 修改" }));
    await waitFor(() =>
      expect(context.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
        "conversation",
        observation,
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("/api/knowledge-base/node/select");
  });
});
