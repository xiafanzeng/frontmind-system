import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { PublishingGatewayProvider } from "../PublishingContext";
import {
  PublishingFlowProvider,
  type PublishingFlow,
} from "../PublishingFlowContext";
import type { PublisherGateway } from "../gateway";
import type {
  PublicationDraft,
  PublicationPreflight,
  PublicationBatch,
} from "../types";
import ArticlesPage from "./ArticlesPage";
import DraftConversationPage from "./DraftConversationPage";

afterEach(cleanup);
const media = {
  id: "media",
  name: "科技媒体",
  shortName: "科技",
  kind: "news",
  platform: "网站",
  taxonomy: "科技",
  mediaType: "新闻",
  channel: "科技",
  region: "全国",
  priceTenThousandths: "125000",
  titleLimit: 80,
  turnaround: "一天",
  capability: "text",
  active: true,
  catalogRevision: "catalog-a",
  logoSource: "generated_fallback",
  logoResolutionStatus: "pending",
} as const;
const draft: PublicationDraft = {
  id: "draft-a",
  articleId: "article-a",
  articleVersionId: "version-a",
  articleTitle: "已冻结文章",
  articleVersion: 3,
  articleVersionHash: "a".repeat(64),
  articleContainsImages: false,
  revision: 7,
  titleMode: "single",
  sharedTitle: "本次发布标题",
  items: [{ media, title: "本次发布标题" }],
  updatedAt: "2026-09-01T00:00:00Z",
};
const preflight: PublicationPreflight = {
  revision: "preflight-a",
  draftRevision: 9,
  quoteFingerprint: "quote-a",
  mode: "live",
  expiresAt: "2099-01-01T00:00:00Z",
  article: {
    id: "article-a",
    title: "已冻结文章",
    version: 3,
    versionId: "version-a",
    hash: "a".repeat(64),
    wordCount: 100,
    imageCount: 0,
    bodyHtml: "<p>这是冻结版本的完整正文。</p>",
    images: [],
  },
  catalogRevision: "catalog-a",
  titleMode: "single",
  items: [
    {
      media,
      title: "本次发布标题",
      priceTenThousandths: "125000",
      checks: [{ label: "标题检查", passed: true }],
      blockers: [],
      warnings: [],
    },
  ],
  totalTenThousandths: "125000",
  wallet: {
    availableTenThousandths: "1000000",
    frozenTenThousandths: "0",
    reservedTenThousandths: "0",
  },
  availableAfterTenThousandths: "875000",
  blockers: [],
  warnings: [],
  gates: [{ label: "可以发布", passed: true }],
};
const batch: PublicationBatch = {
  id: "batch-a",
  articleTitle: "已冻结文章",
  articleVersion: 3,
  articleVersionId: "version-a",
  articleVersionHash: "a".repeat(64),
  mode: "live",
  status: "success",
  itemCount: 1,
  successCount: 1,
  failedCount: 0,
  unknownCount: 0,
  totalTenThousandths: "125000",
  consumedTenThousandths: "125000",
  releasedTenThousandths: "0",
  frozenTenThousandths: "0",
  createdAt: "2026-09-01T00:00:00Z",
  items: [],
};
function flowValue(
  agentId: string,
  selections: Record<string, unknown> = {},
): PublishingFlow {
  return {
    agentId,
    taskId: `${agentId}-task`,
    selections,
    ensureTask: vi.fn(async () => `${agentId}-task`),
    setSummary: vi.fn(),
    record: vi.fn(async () => undefined),
    saveSelections: vi.fn(async () => undefined),
    saveValues: vi.fn(async (patch) => {
      Object.assign(selections, patch);
    }),
    handoff: vi.fn(async () => undefined),
  };
}
function mount(
  gateway: Partial<PublisherGateway>,
  flow: PublishingFlow,
  node: React.ReactNode,
) {
  const location = memoryLocation({ path: "/publishing", record: true });
  return {
    ...render(
      <Router hook={location.hook} searchHook={location.searchHook}>
        <PublishingGatewayProvider gateway={gateway as PublisherGateway}>
          <PublishingFlowProvider value={flow}>{node}</PublishingFlowProvider>
        </PublishingGatewayProvider>
      </Router>,
    ),
    location,
  };
}
it("opens import in the main step, returns to the real article list, and restores that task choice", async () => {
  const selections: Record<string, unknown> = {};
  const flow = flowValue("articles", selections);
  const gateway = {
    listArticles: vi.fn(async () => [
      {
        id: "article-a",
        title: "已有品牌稿件",
        status: "draft" as const,
        currentVersion: 0,
        wordCount: 100,
        imageCount: 0,
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ]),
  };
  const view = mount(gateway, flow, <ArticlesPage />);
  expect(screen.queryByText("已有品牌稿件")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /导入 DOCX/ }));
  expect(
    await screen.findByRole("heading", { name: "请上传需要整理的稿件" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回选项列表" }));
  fireEvent.click(screen.getByRole("button", { name: /继续编辑已有稿件/ }));
  expect(
    await screen.findByRole("button", { name: /已有品牌稿件/ }),
  ).toBeInTheDocument();
  expect(selections.articleEntry).toBe("existing");
  view.unmount();
  mount(gateway, flowValue("articles", selections), <ArticlesPage />);
  expect(
    await screen.findByRole("button", { name: /已有品牌稿件/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "请上传需要整理的稿件" }),
  ).not.toBeInTheDocument();
});
it("keeps real titles, preflight, fee acknowledgement and accepted batch in one task; returning edits does not submit", async () => {
  let current = draft;
  const gateway = {
    getDraft: vi.fn(async () => current),
    saveDraftTitles: vi.fn(async () => (current = { ...draft, revision: 9 })),
    preflightDraft: vi.fn(async () => preflight),
    submitDraft: vi.fn(async () => batch),
    getBatch: vi.fn(async () => batch),
    batchCsvUrl: () => "/batch.csv",
  };
  const flow = flowValue("publishing");
  const { location } = mount(
    gateway,
    flow,
    <DraftConversationPage draftId="draft-a" initialStage="titles" />,
  );
  const titlesNext = await screen.findByRole("button", {
    name: /进入发布预检/,
  });
  await waitFor(() => expect(titlesNext).toBeEnabled());
  fireEvent.click(titlesNext);
  expect(
    await screen.findByRole("heading", {
      name: "请核对稿件、媒体与费用，再确认发布",
    }),
  ).toBeInTheDocument();
  expect(flow.record).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "titles:draft-a:9",
      outputRefs: [expect.objectContaining({ version: "9" })],
    }),
  );
  expect(gateway.submitDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "返回选项列表" }));
  const titlesAgain = await screen.findByRole("button", {
    name: /进入发布预检/,
  });
  await waitFor(() => expect(titlesAgain).toBeEnabled());
  fireEvent.click(titlesAgain);
  const publish = await screen.findByRole("button", { name: /确认发布 1/ });
  expect(publish).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(publish);
  expect(
    screen.getByRole("heading", { name: "这是一次真实投稿" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /提交并预占/ }));
  await waitFor(() => expect(gateway.submitDraft).toHaveBeenCalledTimes(1));
  expect(gateway.submitDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      draftId: "draft-a",
      preflightRevision: "preflight-a",
      quoteFingerprint: "quote-a",
      acknowledged: true,
    }),
  );
  expect(
    await screen.findByRole("heading", { name: "查看本次发布结果" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByText(/FrontMind 发布编号 batch-a/),
  ).toBeInTheDocument();
  expect(location.history).toEqual(["/publishing"]);
});
