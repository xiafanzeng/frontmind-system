import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { PublishingGatewayProvider } from "../PublishingContext";
import type { PublisherGateway } from "../gateway";
import type {
  MediaFilters,
  MediaList,
  MediaResource,
  PublicationDraft,
} from "../types";
import MediaLibraryPage from "./MediaLibraryPage";
import {
  PublishingFlowProvider,
  type PublishingFlow,
} from "../PublishingFlowContext";
import { webcrypto } from "node:crypto";

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 3 } }),
}));
const catalog = {
  activeRevision: "rev-1",
  mediaCount: 2,
  newsCount: 1,
  selfMediaCount: 1,
  kindComplete: true,
  lastSyncedAt: "2026-09-08T00:00:00Z",
  stale: false,
};
const media = (kind: "news" | "self_media"): MediaResource => ({
  id: kind,
  name: kind === "news" ? "新闻测试媒体" : "自媒体测试账号",
  shortName: "媒体",
  kind,
  platform: kind === "news" ? "新闻平台" : "视频平台",
  taxonomy: "科技",
  mediaType: "网络媒体",
  channel: "科技",
  region: "全国",
  priceTenThousandths: "10000",
  titleLimit: 200,
  turnaround: "一天",
  capability: "image_pending",
  active: true,
  catalogRevision: "rev-1",
  logoSource: "generated_fallback",
  logoResolutionStatus: "pending",
  followers: 12345,
  likes: 100,
  recommendationTags: ["GEO排名"],
});
const page = (kind: "news" | "self_media"): MediaList => ({
  items: [media(kind)],
  total: 1,
  page: 1,
  pageSize: 50,
  catalog,
});
function gateway() {
  return {
    listMedia: vi.fn(async (filters: MediaFilters) =>
      page(filters.kind ?? "news"),
    ),
    getMediaFacets: vi.fn(async () => ({
      catalog,
      kinds: { news: 1, self_media: 1 },
    })),
    listArticles: vi.fn(async () => [
      {
        id: "article",
        title: "品牌文章",
        currentVersionId: "version",
        currentVersion: 1,
        imageCount: 0,
      },
    ]),
    getDraft: vi.fn(),
    updateDraftMedia: vi.fn(),
    createDraft: vi.fn(
      async (_version: string, ids: string[]) =>
        ({
          id: "draft",
          articleVersionId: "version",
          articleTitle: "品牌文章",
          articleVersion: 1,
          revision: 1,
          items: ids.map((id) => ({
            media: media(id as "news" | "self_media"),
            title: "",
          })),
        }) as PublicationDraft,
    ),
  };
}
function open(g: ReturnType<typeof gateway>) {
  const location = memoryLocation({ path: "/publishing/media", record: true });
  const view = render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <PublishingGatewayProvider gateway={g as unknown as PublisherGateway}>
        <Switch>
          <Route path="/publishing/media">
            <MediaLibraryPage />
          </Route>
          <Route>
            <p>标题配置页面</p>
          </Route>
        </Switch>
      </PublishingGatewayProvider>
    </Router>,
  );
  return { ...view, location };
}

function openFlow(
  g: ReturnType<typeof gateway>,
  overrides: Partial<PublishingFlow> = {},
) {
  Object.defineProperty(globalThis.crypto, "subtle", {
    configurable: true,
    value: webcrypto.subtle,
  });
  const location = memoryLocation({ path: "/publishing/media", record: true });
  const flow: PublishingFlow = {
    agentId: "media",
    taskId: "media-task",
    ensureTask: vi.fn(async () => "media-task"),
    setSummary: vi.fn(),
    record: vi.fn(async () => undefined),
    saveSelections: vi.fn(async () => undefined),
    handoff: vi.fn(async () => undefined),
    ...overrides,
  };
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <PublishingGatewayProvider gateway={g as unknown as PublisherGateway}>
        <PublishingFlowProvider value={flow}>
          <MediaLibraryPage />
        </PublishingFlowProvider>
      </PublishingGatewayProvider>
    </Router>,
  );
  return { flow, location };
}

describe("media business conversation", () => {
  it("shows the real directory first, chooses the article inline and explicitly hands its saved draft to publishing", async () => {
    const g = gateway();
    const { flow, location } = openFlow(g);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 新闻测试媒体" }),
    );
    await waitFor(() =>
      expect(flow.saveSelections).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaSelection: [expect.objectContaining({ id: "news" })],
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "选择稿件并继续" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "选择冻结稿件" }), {
      target: { value: "version" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认稿件与媒体" }));
    await screen.findByRole("button", { name: "交给发布助手" });
    expect(g.createDraft).toHaveBeenCalledWith(
      "version",
      ["news"],
      expect.stringMatching(/^publisher:draft:[a-f0-9]{64}$/),
    );
    expect(flow.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: "media-bound:draft" }),
    );
    expect(flow.handoff).not.toHaveBeenCalled();
    expect(location.history.at(-1)).toContain("/publishing/media");
    fireEvent.click(screen.getByRole("button", { name: "交给发布助手" }));
    await waitFor(() =>
      expect(flow.handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          targetAgentId: "publishing",
          route: "/publishing/drafts/draft/titles",
          resources: [
            { kind: "article_version", id: "version" },
            { kind: "publication_draft", id: "draft" },
          ],
        }),
      ),
    );
  });

  it("restores a saved media task from its actual draft reference without creating another draft", async () => {
    const g = gateway();
    const saved = await g.createDraft("version", ["news"]);
    g.createDraft.mockClear();
    g.getDraft.mockResolvedValue(saved);
    openFlow(g, {
      resources: [
        { kind: "publication_draft", id: "draft" },
        { kind: "article_version", id: "version" },
      ],
    });
    await screen.findByRole("button", { name: "交给发布助手" });
    expect(g.getDraft).toHaveBeenCalledWith("draft", expect.any(AbortSignal));
    expect(
      screen.getByRole("checkbox", { name: "选择 新闻测试媒体" }),
    ).toBeChecked();
    expect(
      screen.getByRole("region", { name: "投放选择已保存" }),
    ).toHaveTextContent("品牌文章");
    expect(g.createDraft).not.toHaveBeenCalled();
  });

  it("keeps the selected article and uses the same draft request key after an uncertain creation response", async () => {
    const g = gateway();
    g.createDraft.mockRejectedValueOnce(new Error("连接中断，请重试"));
    openFlow(g);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 新闻测试媒体" }),
    );
    await screen.findByText("已选 1 家媒体");
    fireEvent.click(screen.getByRole("button", { name: "选择稿件并继续" }));
    fireEvent.change(screen.getByRole("combobox", { name: "选择冻结稿件" }), {
      target: { value: "version" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认稿件与媒体" }));
    await waitFor(() => expect(g.createDraft).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认稿件与媒体" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getByRole("combobox", { name: "选择冻结稿件" })).toHaveValue(
      "version",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认稿件与媒体" }));
    await screen.findByRole("button", { name: "交给发布助手" });
    expect(g.createDraft.mock.calls[1]).toEqual(g.createDraft.mock.calls[0]);
  });
});

function draft(
  id: string,
  kinds: Array<"news" | "self_media">,
): PublicationDraft {
  return {
    id,
    articleId: `article-${id}`,
    articleVersionId: `version-${id}`,
    articleTitle: `草稿${id}文章`,
    articleVersion: 1,
    articleVersionHash: "a".repeat(64),
    articleContainsImages: false,
    revision: 1,
    titleMode: "single",
    items: kinds.map((kind) => ({
      media: media(kind),
      title: `草稿${id}标题`,
    })),
    updatedAt: "2026-09-08T00:00:00Z",
  };
}

function openDraft(g: ReturnType<typeof gateway>) {
  const location = memoryLocation({
    path: "/publishing/drafts/A/media",
    record: true,
  });
  const view = render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <PublishingGatewayProvider gateway={g as unknown as PublisherGateway}>
        <Route path="/publishing/drafts/:draftId/media">
          {(params) => <MediaLibraryPage draftId={params.draftId} />}
        </Route>
      </PublishingGatewayProvider>
    </Router>,
  );
  return { ...view, location };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.mocked(sessionStorage.getItem).mockImplementation(
    (key) => values.get(key) ?? null,
  );
  vi.mocked(sessionStorage.setItem).mockImplementation((key, value) => {
    values.set(key, value);
  });
  vi.mocked(sessionStorage.removeItem).mockImplementation((key) => {
    values.delete(key);
  });
  vi.mocked(sessionStorage.clear).mockImplementation(() => values.clear());
});

describe("media selection flow", () => {
  it("selects unknown-capability text media across categories before a manuscript and binds once", async () => {
    const g = gateway();
    open(g);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 新闻测试媒体" }),
    );
    expect(g.createDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^自媒体/ }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 自媒体测试账号" }),
    );
    expect(screen.getByText("已选 2 家媒体")).toBeInTheDocument();
    expect(screen.getByText("粉丝 1.2万")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择稿件并继续" }));
    fireEvent.change(screen.getByRole("combobox", { name: "选择冻结稿件" }), {
      target: { value: "version" },
    });
    fireEvent.click(screen.getByRole("button", { name: "绑定稿件并配置标题" }));
    expect(await screen.findByText("标题配置页面")).toBeInTheDocument();
    expect(g.createDraft).toHaveBeenCalledTimes(1);
    expect(g.createDraft).toHaveBeenCalledWith("version", [
      "news",
      "self_media",
    ]);
  });
  it("masks the old type immediately while the next type is loading", async () => {
    const g = gateway();
    let resolve!: (value: MediaList) => void;
    g.listMedia.mockImplementation(async (filters) =>
      filters.kind === "self_media"
        ? new Promise((yes) => {
            resolve = yes;
          })
        : page("news"),
    );
    open(g);
    await screen.findByText("新闻测试媒体");
    fireEvent.click(screen.getByRole("button", { name: /^自媒体/ }));
    expect(screen.queryByText("新闻测试媒体")).not.toBeInTheDocument();
    expect(await screen.findByText("正在加载自媒体…")).toBeInTheDocument();
    await act(async () => resolve(page("self_media")));
    expect(await screen.findByText("自媒体测试账号")).toBeInTheDocument();
  });
  it("restores a shortlist after refresh and preserves it when binding fails", async () => {
    const g = gateway();
    const first = open(g);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 新闻测试媒体" }),
    );
    first.unmount();
    open(g);
    expect(
      await screen.findByRole("checkbox", { name: "选择 新闻测试媒体" }),
    ).toBeChecked();
    g.createDraft.mockRejectedValueOnce(new Error("报价已变更，请重新确认"));
    fireEvent.click(screen.getByRole("button", { name: "选择稿件并继续" }));
    fireEvent.change(screen.getByRole("combobox", { name: "选择冻结稿件" }), {
      target: { value: "version" },
    });
    fireEvent.click(screen.getByRole("button", { name: "绑定稿件并配置标题" }));
    await waitFor(() =>
      expect(
        screen.getAllByText("报价已变更，请重新确认").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByText("已选 1 家媒体")).toBeInTheDocument();
  });

  it("masks A and prevents updating it while draft B is loading in the same page instance", async () => {
    const g = gateway();
    let resolveB!: (value: PublicationDraft) => void;
    g.getDraft.mockImplementation(async (id) =>
      id === "A"
        ? draft("A", ["news"])
        : new Promise<PublicationDraft>((resolve) => {
            resolveB = resolve;
          }),
    );
    g.updateDraftMedia.mockImplementation(async (id, ids) => draft(id, ids));
    const { location } = openDraft(g);
    await screen.findByText("草稿A文章");
    expect(
      screen.getByRole("checkbox", { name: "选择 新闻测试媒体" }),
    ).toBeChecked();

    act(() => location.navigate("/publishing/drafts/B/media"));
    expect(screen.queryByText("草稿A文章")).not.toBeInTheDocument();
    expect(screen.queryByText("已选 1 家媒体")).not.toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", {
      name: "选择 新闻测试媒体",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(g.updateDraftMedia).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(g.getDraft).toHaveBeenCalledWith("B", expect.any(AbortSignal)),
    );
    await act(async () => resolveB(draft("B", ["self_media"])));
    expect(await screen.findByText("草稿B文章")).toBeInTheDocument();
    const readyCheckbox = screen.getByRole("checkbox", {
      name: "选择 新闻测试媒体",
    });
    expect(readyCheckbox).not.toBeDisabled();
    fireEvent.click(readyCheckbox);
    await waitFor(() =>
      expect(g.updateDraftMedia).toHaveBeenCalledWith(
        "B",
        ["self_media", "news"],
        1,
      ),
    );
    expect(g.updateDraftMedia).toHaveBeenCalledOnce();
  });

  it("ignores a late A mutation response after B has loaded and keeps B editable", async () => {
    const g = gateway();
    let resolveAUpdate!: (value: PublicationDraft) => void;
    g.getDraft.mockImplementation(async (id) =>
      draft(id, [id === "A" ? "news" : "self_media"]),
    );
    g.updateDraftMedia.mockImplementation(async (id, ids) =>
      id === "A"
        ? new Promise<PublicationDraft>((resolve) => {
            resolveAUpdate = resolve;
          })
        : draft(id, ids),
    );
    const { location } = openDraft(g);
    await screen.findByText("草稿A文章");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "选择 新闻测试媒体" }),
    );
    await waitFor(() =>
      expect(g.updateDraftMedia).toHaveBeenCalledWith("A", [], 1),
    );

    act(() => location.navigate("/publishing/drafts/B/media"));
    expect(await screen.findByText("草稿B文章")).toBeInTheDocument();
    await act(async () => resolveAUpdate({ ...draft("A", []), revision: 2 }));
    expect(screen.queryByText("草稿A文章")).not.toBeInTheDocument();
    expect(screen.getByText("草稿B文章")).toBeInTheDocument();
    expect(screen.getByText("已选 1 家媒体")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", {
      name: "选择 新闻测试媒体",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBeDisabled();
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(g.updateDraftMedia).toHaveBeenLastCalledWith(
        "B",
        ["self_media", "news"],
        1,
      ),
    );
  });
});
