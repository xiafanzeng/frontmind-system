import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import PublishingRoutes from "../PublishingRoutes";
import type { PublisherGateway } from "../gateway";

function open(path: string) {
  const location = memoryLocation({ path, record: true });
  const gateway = {
    getDashboard: vi.fn(async () => ({
      wallet: {
        availableTenThousandths: "0",
        reservedTenThousandths: "0",
        frozenTenThousandths: "0",
      },
      catalog: {
        activeRevision: "",
        mediaCount: 0,
        lastSyncedAt: "",
        stale: true,
      },
      articleCount: 0,
      actionableItemCount: 0,
      resumableDraftCount: 0,
      resumableDrafts: [],
      processingBatchCount: 0,
      processingBatches: [],
      recentBatches: [],
      resumableArticles: [],
    })),
    listBatches: vi.fn(async () => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })),
  };
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <PublishingRoutes gateway={gateway as unknown as PublisherGateway} />
    </Router>,
  );
  return { location, gateway };
}

describe("publishing workbench", () => {
  it("opens saved publication links inside the workbench and preserves all record filters", async () => {
    const { location, gateway } = open(
      "/publishing/publications?kind=self_media&status=success&query=品牌&page=2&from=2026-09-01",
    );
    expect(
      await screen.findByRole("heading", { name: "发布工作台" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(gateway.listBatches).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "self_media",
          status: "success",
          query: "品牌",
          page: 2,
          from: "2026-09-01",
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(location.history.at(-1)).toMatch(/^\/publishing\?tab=records/);
    expect(screen.getByRole("link", { name: "发布记录" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("textbox", { name: "搜索发布记录" })).toHaveValue(
      "品牌",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "发布状态" }), {
      target: { value: "failed" },
    });
    await waitFor(() =>
      expect(gateway.listBatches).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed", page: 1 }),
        expect.any(AbortSignal),
      ),
    );
    expect(location.history.at(-1)).toContain("tab=records");
  });

  it("switches from work overview into the full publication records list", async () => {
    const { gateway } = open("/publishing");
    expect(
      await screen.findByRole("heading", { name: "发布工作台" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "可恢复投放草稿" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "媒体发布概览" }),
    ).not.toBeInTheDocument();
    expect(gateway.listBatches).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "发布记录" }));
    expect(
      await screen.findByRole("region", { name: "筛选发布记录" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("没有匹配的发布记录")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "媒体发布概览" }),
    ).not.toBeInTheDocument();
  });
});

import PublishingWorkbenchPage from "./WorkbenchPage";
import { PublishingGatewayProvider } from "../PublishingContext";
import {
  PublishingFlowProvider,
  type PublishingFlow,
} from "../PublishingFlowContext";

function openConversation(overrides: Record<string, unknown> = {}) {
  const location = memoryLocation({ path: "/publishing", record: true });
  const gateway = {
    getDashboard: vi.fn(async () => ({
      resumableDrafts: [
        { id: "draft-a", articleTitle: "已确认文章", articleVersion: 3 },
      ],
    })),
    listArticles: vi.fn(async () => [
      {
        id: "article-a",
        title: "已确认文章",
        currentVersionId: "version-a",
        currentVersion: 3,
        wordCount: 1800,
      },
    ]),
    getDraft: vi.fn(async () => ({
      id: "draft-a",
      articleTitle: "已确认文章",
      articleVersionId: "version-a",
      items: [],
    })),
    ...overrides,
  };
  const flow: PublishingFlow = {
    taskId: "publishing-task-a",
    agentId: "publishing",
    ensureTask: vi.fn(async () => "publishing-task-a"),
    setSummary: vi.fn(),
    record: vi.fn(async () => undefined),
    saveSelections: vi.fn(async () => undefined),
    saveValues: vi.fn(async () => undefined),
    handoff: vi.fn(async () => undefined),
  };
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <PublishingGatewayProvider
        gateway={gateway as unknown as PublisherGateway}
      >
        <PublishingFlowProvider value={flow}>
          <PublishingWorkbenchPage />
        </PublishingFlowProvider>
      </PublishingGatewayProvider>
    </Router>,
  );
  return { flow, gateway };
}

describe("publishing conversation entry", () => {
  it("waits for the business choice and explicitly hands a frozen article to media without publishing", async () => {
    const { flow } = openConversation();
    expect(
      screen.getByRole("heading", { name: "接下来要处理哪次投放？" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: "本次投放稿件" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /从已冻结稿件开始/ }));
    const article = await screen.findByRole("radio");
    const confirm = screen.getByRole("button", {
      name: "确认稿件，交给媒体助手",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(article);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(flow.handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          targetAgentId: "media",
          resources: [
            { kind: "article", id: "article-a" },
            { kind: "article_version", id: "version-a" },
          ],
          idempotencyKey: "publishing-media-version-a",
        }),
      ),
    );
    expect(flow.record).not.toHaveBeenCalled();
  });
  it("preserves the chosen draft after a failed read and retries the same actual draft", async () => {
    const getDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error("暂时无法读取草稿"))
      .mockResolvedValue({
        id: "draft-a",
        articleTitle: "已确认文章",
        articleVersionId: "version-a",
        items: [],
      });
    const { flow } = openConversation({ getDraft });
    fireEvent.click(screen.getByRole("button", { name: /继续投放草稿/ }));
    const draft = await screen.findByRole("button", { name: /已确认文章/ });
    fireEvent.click(draft);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法读取草稿",
    );
    expect(flow.handoff).not.toHaveBeenCalled();
    fireEvent.click(draft);
    await waitFor(() =>
      expect(flow.handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          targetAgentId: "media",
          idempotencyKey: "draft-media-draft-a",
        }),
      ),
    );
    expect(getDraft.mock.calls.map((call) => call[0])).toEqual([
      "draft-a",
      "draft-a",
    ]);
  });
});
