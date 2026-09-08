import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeBaseObservationDto,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";
import type { KnowledgeNodeDetailsDto } from "@shared/knowledge-node-workspace";

const context = vi.hoisted(() => ({
  state: {
    conversations: [{ id: "conversation", knowledgeBase: { generation: 1 } }],
  },
  commitKnowledgeBaseObservation: vi.fn(),
  refreshConversations: vi.fn(async () => {}),
  wakeKnowledgeBaseConversation: vi.fn(),
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => context,
}));

import KnowledgeNodeWorkspace from "./KnowledgeNodeWorkspace";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";
import { getUnsavedWorkspaceDrafts } from "@/lib/workspace-navigation-guard";

const progress: KnowledgeBaseProgressDto = {
  build: {
    id: "build",
    conversationId: "conversation",
    companyName: "测试企业",
    depthPolicy: {
      version: 1,
      minLeaves: 2,
      maxLeaves: 20,
      targetMinLeaves: 2,
      targetMaxLeaves: 20,
    },
    researchSummary: null,
    status: "confirming",
    revision: 8,
    contentVersion: 3,
    currentLeafId: "1.1",
    protocolError: null,
    updatedAt: 1753200000000,
  },
  summary: {
    total: 2,
    handled: 1,
    confirmed: 1,
    directPrefilled: 0,
    pending: 0,
    current: 1,
    needsVerification: 0,
    overallPercent: 50,
  },
  branches: [
    {
      id: "identity",
      title: "企业身份",
      total: 2,
      handled: 1,
      confirmed: 1,
      directPrefilled: 0,
      pending: 0,
      current: 1,
      needsVerification: 0,
      leaves: [
        {
          id: "1.1",
          title: "企业简介",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 0,
          status: "current",
        },
        {
          id: "1.2",
          title: "产品服务",
          branchId: "identity",
          branchTitle: "企业身份",
          ordinal: 1,
          status: "confirmed",
        },
      ],
    },
  ],
  packageAllowed: true,
};
const details = (
  leafId = "1.1",
  contentVersion = 3,
): KnowledgeNodeDetailsDto => ({
  coordinates: {
    buildId: "build",
    conversationId: "conversation",
    leafId,
    generation: 1,
    revision: contentVersion === 3 ? 8 : 9,
    stateEpoch: contentVersion === 3 ? 12 : 13,
    contentVersion,
    resetRevision: 2,
  },
  node: {
    leafId,
    title: leafId === "1.1" ? "企业简介" : "产品服务",
    status: leafId === "1.1" ? "current" : "confirmed",
    contentMarkdown:
      leafId === "1.1"
        ? "# 企业简介\n\n原有企业介绍。"
        : "# 产品服务\n\n产品服务正文。",
  },
  resources: [],
  capabilities: {
    directEdit: { allowed: true, reason: null },
    aiEdit: { allowed: true, reason: null },
    manageImages: { allowed: true, reason: null },
  },
});
const observation = (contentVersion = 4): KnowledgeBaseObservationDto => ({
  generation: 1,
  stateEpoch: 13,
  authoritativeTaskId: null,
  activeTurn: null,
  approvedPresentation: null,
  package: null,
  notice: null,
  conversationVersion: 9,
  interaction: {
    canReply: true,
    canPublish: true,
    lockReason: null,
    interactionState: "awaiting_input",
    progress: {
      ...progress,
      build: { ...progress.build, revision: 9, contentVersion },
    },
  },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let disposeScope: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  disposeScope?.();
  disposeScope = undefined;
  vi.unstubAllGlobals();
});

function fixtureFetch() {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://frontmind.invalid");
      if (url.pathname.endsWith("/node/save"))
        return json({
          accepted: true,
          unchanged: false,
          observation: observation(),
        });
      return json(
        details(
          url.searchParams.get("leafId") ?? "1.1",
          Number(url.searchParams.get("expectedContentVersion") ?? 3),
        ),
      );
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function renderWorkspace(
  props: Partial<React.ComponentProps<typeof KnowledgeNodeWorkspace>> = {},
  open = true,
) {
  const view = render(
    <KnowledgeNodeWorkspace
      progress={progress}
      conversationId="conversation"
      resetRevision={2}
      {...props}
    />,
  );
  if (open)
    fireEvent.click(screen.getByRole("button", { name: "企业简介 当前节点" }));
  return view;
}
async function closeDetails() {
  fireEvent.click(screen.getByRole("button", { name: "关闭节点详情" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
function switchNode(leafId: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "切换知识节点" }), {
    target: { value: leafId },
  });
}
async function openEditor() {
  const button = await screen.findByRole("button", { name: "直接编辑" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole("textbox", { name: "编辑企业简介正文" });
}

describe("unified knowledge node workspace", () => {
  it("shows grouped progress without fetching content until a node is opened, and restores the tree on close", async () => {
    const fetcher = fixtureFetch();
    renderWorkspace({}, false);
    const tree = screen.getByRole("navigation", { name: "知识节点目录" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(within(tree).getByText("01")).toBeVisible();
    expect(within(tree).getByText("1 / 2 · 50%")).toBeVisible();
    expect(within(tree).getByText("已整理 1")).toBeVisible();
    tree.scrollTop = 145;
    fireEvent.scroll(tree);
    const node = screen.getByRole("button", { name: "产品服务 已确认" });
    fireEvent.click(node);
    const drawer = await screen.findByRole("dialog", { name: "产品服务" });
    expect(within(drawer).getByText("产品服务正文。")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await closeDetails();
    expect(screen.getByRole("navigation", { name: "知识节点目录" })).toBe(tree);
    expect(tree.scrollTop).toBe(145);
    await waitFor(() => expect(node).toHaveFocus());
    expect(
      screen.getByRole("button", { name: /企业身份/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps prefilled content in handled counts and the current node in pending without changing stored statuses", () => {
    const withDraft = structuredClone(progress);
    const branch = withDraft.branches[0]!;
    branch.confirmed = 0;
    branch.directPrefilled = 1;
    branch.leaves[1]!.status = "direct_prefilled";
    withDraft.summary.confirmed = 0;
    withDraft.summary.directPrefilled = 1;
    renderWorkspace({ progress: withDraft }, false);
    const tree = screen.getByRole("navigation", { name: "知识节点目录" });
    expect(within(tree).getByText("已整理 1")).toBeVisible();
    expect(within(tree).getByText("待再次确认 0")).toBeVisible();
    expect(within(tree).getByText("待处理 1")).toBeVisible();
    expect(within(tree).queryByText(/预填/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "产品服务 已有资料" })).toHaveAttribute("data-status", "direct_prefilled");
    expect(branch.leaves[1]!.status).toBe("direct_prefilled");
  });

  it("does not mark a fully prefilled branch as pending after it reaches 100 percent", () => {
    const prefilled = structuredClone(progress);
    const branch = prefilled.branches[0]!;
    branch.handled = 2;
    branch.confirmed = 0;
    branch.directPrefilled = 2;
    branch.current = 0;
    branch.leaves.forEach((leaf) => { leaf.status = "direct_prefilled"; });
    prefilled.build.currentLeafId = null;
    prefilled.summary = { ...prefilled.summary, handled: 2, confirmed: 0, directPrefilled: 2, current: 0, overallPercent: 100 };
    renderWorkspace({ progress: prefilled }, false);
    const tree = screen.getByRole("navigation", { name: "知识节点目录" });
    expect(within(tree).getByText("2 / 2 · 100%")).toBeVisible();
    expect(within(tree).getByText("已整理 2")).toBeVisible();
    expect(within(tree).getByText("待处理 0")).toBeVisible();
    expect(within(tree).getAllByText("已有资料")).toHaveLength(2);
  });

  it("guards Escape and close with an unsaved draft, and saves exactly once before closing", async () => {
    const fetcher = fixtureFetch();
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "保存后关闭详情" },
    });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "企业简介" }), {
      key: "Escape",
    });
    let prompt = await screen.findByRole("dialog", {
      name: "当前节点有未保存修改",
    });
    fireEvent.click(within(prompt).getByRole("button", { name: "继续编辑" }));
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("保存后关闭详情");
    fireEvent.click(screen.getByRole("button", { name: "关闭节点详情" }));
    prompt = await screen.findByRole("dialog", {
      name: "当前节点有未保存修改",
    });
    fireEvent.click(within(prompt).getByRole("button", { name: "保存后继续" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "企业简介 当前节点" }),
      ).toHaveFocus(),
    );
  });

  it("keeps the drawer and edit draft mounted while a save is in flight", async () => {
    let resolveSave!: (response: Response) => void;
    const fetcher = fixtureFetch();
    fetcher.mockImplementation(async (input, init) => {
      if (init?.method === "POST")
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      const url = new URL(String(input), "https://frontmind.invalid");
      return json(
        details(
          url.searchParams.get("leafId") ?? "1.1",
          Number(url.searchParams.get("expectedContentVersion") ?? 3),
        ),
      );
    });
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "正在保存的内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "关闭节点详情" })).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "切换知识节点" }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "企业简介" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("正在保存的内容");
    expect(
      screen.queryByRole("dialog", { name: "当前节点有未保存修改" }),
    ).toBeNull();
    await act(async () =>
      resolveSave(
        json({ accepted: true, unchanged: false, observation: observation() }),
      ),
    );
    expect(
      await screen.findByText("修改已保存，请确认后更新知识库。"),
    ).toBeVisible();
    await closeDetails();
  });

  it("retains a failed save when closing, and allows explicit discard without a second POST", async () => {
    const fetcher = fixtureFetch();
    fetcher.mockImplementation(async (_input, init) => {
      if (init?.method === "POST") throw new Error("保存暂时失败");
      return json(details());
    });
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "失败后仍需保留的内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭节点详情" }));
    fireEvent.click(screen.getByRole("button", { name: "保存后继续" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续编辑" })).toBeEnabled(),
    );
    expect(
      screen.getByRole("dialog", { name: "当前节点有未保存修改" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("失败后仍需保留的内容");
    expect(screen.getByRole("alert")).toHaveTextContent("保存暂时失败");
    fireEvent.click(screen.getByRole("button", { name: "关闭节点详情" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
  });

  it("keeps dirty image selection in its own dialog and does not close the node drawer with Escape", async () => {
    const fetcher = fixtureFetch();
    fetcher.mockImplementation(async (input) => {
      if (String(input).includes("/node/images"))
        return json({
          coordinates: {},
          images: [
            {
              assetId: "image-1",
              url: "/private-image",
              caption: "企业原图",
              attached: true,
              removable: true,
              selectable: true,
            },
          ],
        });
      return json(details());
    });
    renderWorkspace();
    await screen.findByText("原有企业介绍。");
    fireEvent.click(screen.getByRole("button", { name: "本地图片" }));
    const images = await screen.findByRole("dialog", {
      name: "当前节点的本地图片",
    });
    fireEvent.click(within(images).getByRole("checkbox"));
    fireEvent.keyDown(images, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "当前节点的本地图片" }),
    ).toBeVisible();
    expect(getUnsavedWorkspaceDrafts().map((draft) => draft.label)).toContain(
      "知识节点图片",
    );
    fireEvent.click(within(images).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("dialog", { name: "企业简介" })).toBeVisible();
    await closeDetails();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("browses, searches and locates nodes without any select or turn mutation", async () => {
    const fetcher = fixtureFetch();
    renderWorkspace();
    expect(await screen.findByText("原有企业介绍。")).toBeVisible();
    expect(screen.getByText("当前节点")).toBeVisible();
    expect(screen.queryByText("待确认")).not.toBeInTheDocument();
    switchNode("1.2");
    expect(await screen.findByText("产品服务正文。")).toBeVisible();
    await closeDetails();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索节点标题" }), {
      target: { value: "不存在" },
    });
    expect(screen.getByText("没有匹配的知识节点。")).toBeVisible();
    expect(
      within(
        screen.getByRole("navigation", { name: "知识节点目录" }),
      ).queryByText("产品服务"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "定位当前节点" }));
    expect(await screen.findByText("原有企业介绍。")).toBeVisible();
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
    expect(context.commitKnowledgeBaseObservation).not.toHaveBeenCalled();
  });

  it("opening, previewing, cancelling, and restoring the original body never POST", async () => {
    const fetcher = fixtureFetch();
    const target = vi.fn();
    renderWorkspace({ onEditTargetChange: target });
    const editor = await openEditor();
    expect(editor).toHaveValue("原有企业介绍。");
    expect(
      screen.queryByRole("navigation", { name: "知识节点目录" }),
    ).not.toBeInTheDocument();
    expect(target).toHaveBeenLastCalledWith({
      leafId: "1.1",
      title: "企业简介",
      mode: "direct",
    });
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    fireEvent.change(editor, { target: { value: "临时修改" } });
    fireEvent.change(editor, { target: { value: "原有企业介绍。" } });
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "预览修改" }));
    expect(screen.getByText("原有企业介绍。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeVisible();
    await closeDetails();
    expect(
      screen.getByRole("navigation", { name: "知识节点目录" }),
    ).toBeVisible();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("formats only the selected Markdown range without saving or changing the node title", async () => {
    const fetcher = fixtureFetch();
    renderWorkspace();
    const editor = (await openEditor()) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "品牌内容和其余正文" } });
    editor.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "加粗所选文字" }));
    expect(editor).toHaveValue("**品牌内容**和其余正文");
    await waitFor(() => expect(editor.selectionStart).toBe(2));
    expect(editor.selectionEnd).toBe(6);
    expect(editor).toHaveFocus();
    expect(screen.getByRole("heading", { name: "企业简介" })).toBeVisible();
    expect(screen.getByText(/确认并更新知识库后供后续任务使用/)).toBeVisible();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("saves one frozen version with the fixed node title and distinguishes saved from updated", async () => {
    const fetcher = fixtureFetch();
    const dirty = vi.fn();
    const pending = vi.fn();
    renderWorkspace({ onDirtyChange: dirty, onMutationPendingChange: pending });
    fireEvent.change(await openEditor(), {
      target: { value: "新的企业介绍。" },
    });
    const save = screen.getByRole("button", { name: "保存修改" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(
      await screen.findByText("修改已保存，请确认后更新知识库。"),
    ).toBeVisible();
    const posts = fetcher.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toMatchObject({
      conversationId: "conversation",
      leafId: "1.1",
      expectedGeneration: 1,
      expectedRevision: 8,
      expectedStateEpoch: 12,
      expectedContentVersion: 3,
      expectedResetRevision: 2,
      contentMarkdown: "# 企业简介\n\n新的企业介绍。",
      clientRequestId: expect.any(String),
    });
    expect(context.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "conversation",
      observation(),
    );
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(pending).toHaveBeenCalledWith(true);
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(
      fetcher.mock.calls.some(([url]) =>
        /publish|archive|node\/select|\/turn/.test(String(url)),
      ),
    ).toBe(false);
  });

  it("keeps draft and old edit coordinates on conflict while reading the newer authoritative body", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return json(
            {
              error: { message: "节点版本已变化" },
              observation: observation(),
            },
            409,
          );
        const url = new URL(String(input), "https://frontmind.invalid");
        const version = Number(url.searchParams.get("expectedContentVersion"));
        const next = details("1.1", version);
        if (version === 4)
          next.node.contentMarkdown = "# 企业简介\n\n其他操作员保存的新内容。";
        return json(next);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "我的未保存内容。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("节点版本已变化")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("我的未保存内容。");
    expect(await screen.findByText("其他操作员保存的新内容。")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(context.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "conversation",
      observation(),
    );
  });

  it("retries uncertain saves with the same idempotency identity", async () => {
    const fetcher = fixtureFetch();
    let attempts = 0;
    fetcher.mockImplementation(async (input, init) => {
      if (init?.method === "POST") {
        attempts += 1;
        if (attempts === 1) throw new Error("网络暂时不可用");
        return json({
          accepted: true,
          unchanged: false,
          observation: observation(),
        });
      }
      const url = new URL(String(input), "https://frontmind.invalid");
      return json(
        details("1.1", Number(url.searchParams.get("expectedContentVersion"))),
      );
    });
    renderWorkspace();
    fireEvent.change(await openEditor(), { target: { value: "同一份修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("网络暂时不可用");
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("同一份修改");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("修改已保存，请确认后更新知识库。");
    const posts = fetcher.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toHaveLength(2);
    expect(posts[0].clientRequestId).toBe(posts[1].clientRequestId);
  });

  it("requires authoritative bytes after a replayed save instead of pairing the submitted body with newer coordinates", async () => {
    let attempts = 0;
    let resolveRead!: (body: KnowledgeNodeDetailsDto) => void;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          attempts += 1;
          if (attempts === 1) throw new Error("保存响应丢失");
          return json({
            accepted: true,
            unchanged: false,
            observation: observation(5),
          });
        }
        const url = new URL(String(input), "https://frontmind.invalid");
        if (url.searchParams.get("expectedContentVersion") === "5") {
          return {
            ok: true,
            json: () =>
              new Promise((resolve) => {
                resolveRead = resolve;
              }),
          } as Response;
        }
        return json(details());
      },
    );
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "原提交正文，不能冒充较新的当前版本。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("保存响应丢失");
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("原提交正文，不能冒充较新的当前版本。");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("修改已保存，请确认后更新知识库。");
    await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    expect(
      screen.queryByText("原提交正文，不能冒充较新的当前版本。"),
    ).toBeNull();
    expect(screen.queryByText("原有企业介绍。")).toBeNull();
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "AI 修改" })).toBeNull();
    const latest = details("1.1", 5);
    latest.node.contentMarkdown =
      "# 企业简介\n\n服务端规范化且包含后续更新的正文。";
    await act(async () => resolveRead(latest));
    expect(
      await screen.findByText("服务端规范化且包含后续更新的正文。"),
    ).toBeVisible();
    expect(await openEditor()).toHaveValue(
      "服务端规范化且包含后续更新的正文。",
    );
    const posts = fetcher.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toHaveLength(2);
    expect(posts[0].clientRequestId).toBe(posts[1].clientRequestId);
  });

  it("keeps accepted-save preview empty when the authoritative reread fails and enables editing only after reread succeeds", async () => {
    let readsAfterSave = 0;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return json({
            accepted: true,
            unchanged: false,
            observation: observation(),
          });
        const url = new URL(String(input), "https://frontmind.invalid");
        if (url.searchParams.get("expectedContentVersion") === "4") {
          readsAfterSave += 1;
          if (readsAfterSave === 1) throw new Error("最新正文暂时无法读取");
          const current = details("1.1", 4);
          current.node.contentMarkdown = "# 企业简介\n\n重新读取的权威正文。";
          return json(current);
        }
        return json(details());
      },
    );
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace();
    fireEvent.change(await openEditor(), {
      target: { value: "未经权威读取的提交正文。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("最新正文暂时无法读取")).toBeVisible();
    expect(screen.getByText("修改已保存，请确认后更新知识库。")).toBeVisible();
    expect(screen.queryByText("未经权威读取的提交正文。")).toBeNull();
    expect(screen.queryByText("原有企业介绍。")).toBeNull();
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "AI 修改" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("重新读取的权威正文。")).toBeVisible();
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeEnabled();
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("guards dirty node switches and can explicitly discard without saving", async () => {
    const fetcher = fixtureFetch();
    renderWorkspace();
    fireEvent.change(await openEditor(), { target: { value: "未保存修改" } });
    expect(getUnsavedWorkspaceDrafts().map((item) => item.label)).toContain(
      "知识节点：企业简介",
    );
    switchNode("1.2");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("当前节点有未保存修改")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    expect(
      screen.getByRole("textbox", { name: "编辑企业简介正文" }),
    ).toHaveValue("未保存修改");
    switchNode("1.2");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "放弃修改",
      }),
    );
    expect(await screen.findByText("产品服务正文。")).toBeVisible();
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });

  it("provides the navigation guard a real save callback", async () => {
    fixtureFetch();
    renderWorkspace();
    fireEvent.change(await openEditor(), { target: { value: "保存后离开" } });
    const registered = getUnsavedWorkspaceDrafts().find(
      (item) => item.label === "知识节点：企业简介",
    );
    let saved: boolean | undefined;
    await act(async () => {
      saved = await registered?.save?.();
    });
    expect(saved).toBe(true);
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
  });

  it("does not commit a late save or show success after leaving its project scope", async () => {
    disposeScope = activateWorkspaceRestScope(
      "operator:project-a",
      "project-a",
    );
    let resolveSave!: (body: unknown) => void;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST")
          return {
            ok: true,
            json: () =>
              new Promise((resolve) => {
                resolveSave = resolve;
              }),
          } as Response;
        return json(details());
      },
    );
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace();
    fireEvent.change(await openEditor(), { target: { value: "A项目正文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    disposeScope = activateWorkspaceRestScope(
      "operator:project-b",
      "project-b",
    );
    await act(async () =>
      resolveSave({
        accepted: true,
        unchanged: false,
        observation: observation(),
      }),
    );
    expect(context.commitKnowledgeBaseObservation).not.toHaveBeenCalled();
    expect(
      screen.queryByText("修改已保存，请确认后更新知识库。"),
    ).not.toBeInTheDocument();
    const post = fetcher.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )!;
    expect(new Headers(post[1]?.headers).get("x-enterprise-project-id")).toBe(
      "project-a",
    );
  });

  it("discards late read responses when another node is selected", async () => {
    let resolveFirst!: (body: unknown) => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("leafId=1.1"))
        return {
          ok: true,
          json: () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        } as Response;
      return json(details("1.2"));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace();
    await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    switchNode("1.2");
    await screen.findByText("产品服务正文。");
    await act(async () => resolveFirst(details()));
    expect(screen.queryByText("原有企业介绍。")).not.toBeInTheDocument();
    expect(screen.getByText("产品服务正文。")).toBeVisible();
  });

  it("honors server capabilities and does not render unsafe Markdown as active HTML", async () => {
    const limited = details();
    limited.node.contentMarkdown =
      "允许读取的部分内容。\n<script>alert('bad')</script>\n[坏链接](javascript:alert(1))";
    limited.capabilities = {
      directEdit: { allowed: false, reason: "当前仅有部分内容，暂不可编辑。" },
      aiEdit: { allowed: false, reason: "当前仅有部分内容，暂不可编辑。" },
      manageImages: {
        allowed: false,
        reason: "当前仅有部分内容，暂不可编辑。",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(limited)),
    );
    renderWorkspace();
    await screen.findByText("当前仅有部分内容，暂不可编辑。");
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI 修改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "本地图片" })).toBeDisabled();
    expect(document.body.querySelector("script")).toBeNull();
    expect(document.body.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("keeps the development preview read-only without making network calls", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace({ previewDetails: [details(), details("1.2")] });
    await screen.findByText("原有企业介绍。");
    expect(screen.getByText(/设计预览：/)).toBeVisible();
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "AI 修改" })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads correctly after StrictMode effect replay without creating a conversation", async () => {
    const fetcher = fixtureFetch();
    render(
      <StrictMode>
        <KnowledgeNodeWorkspace
          progress={progress}
          conversationId="conversation"
          resetRevision={2}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "企业简介 当前节点" }));
    await screen.findByText("原有企业介绍。");
    expect(screen.getByRole("button", { name: "直接编辑" })).toBeEnabled();
    expect(
      fetcher.mock.calls.every(([, init]) => init?.method !== "POST"),
    ).toBe(true);
  });

  it("sets the AI target only after the existing local selection succeeds and keeps it while browsing", async () => {
    const target = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://frontmind.invalid");
      if (url.pathname.endsWith("/node/images"))
        return json({
          coordinates: {
            conversationId: "conversation",
            expectedGeneration: 1,
            expectedRevision: 8,
            expectedStateEpoch: 12,
            expectedContentVersion: 3,
            expectedLeafId: "1.1",
          },
          images: [],
        });
      if (url.pathname.endsWith("/node/select"))
        return json({ observation: observation(3) });
      return json(details(url.searchParams.get("leafId") ?? "1.1"));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWorkspace({ onEditTargetChange: target });
    await screen.findByText("原有企业介绍。");
    expect(target).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "AI 修改" }));
    await waitFor(() =>
      expect(target).toHaveBeenLastCalledWith({
        leafId: "1.1",
        title: "企业简介",
        mode: "ai",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "产品服务 已确认" }));
    await screen.findByText("产品服务正文。");
    expect(target).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/turn")),
    ).toBe(false);
  });

  it("clears the old draft at a reset boundary and never shows the previous generation", async () => {
    const fetcher = fixtureFetch();
    const { rerender } = renderWorkspace();
    fireEvent.change(await openEditor(), { target: { value: "旧构建草稿" } });
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(1);
    fetcher.mockImplementation(async () => {
      const next = details();
      next.coordinates.generation = 2;
      next.coordinates.resetRevision = 3;
      next.node.contentMarkdown = "# 企业简介\n\n新构建正文。";
      return json(next);
    });
    rerender(
      <KnowledgeNodeWorkspace
        progress={progress}
        conversationId="conversation"
        generation={2}
        resetRevision={3}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "企业简介 当前节点" }));
    expect(await screen.findByText("新构建正文。")).toBeVisible();
    expect(screen.queryByDisplayValue("旧构建草稿")).not.toBeInTheDocument();
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    );
  });
});
