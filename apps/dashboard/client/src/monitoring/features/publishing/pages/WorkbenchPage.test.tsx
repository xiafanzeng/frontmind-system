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
      wallet: { availableTenThousandths: "0", reservedTenThousandths: "0", frozenTenThousandths: "0" },
      catalog: { activeRevision: "", mediaCount: 0, lastSyncedAt: "", stale: true },
      articleCount: 0, actionableItemCount: 0, resumableDraftCount: 0, resumableDrafts: [],
      processingBatchCount: 0, processingBatches: [], recentBatches: [], resumableArticles: [],
    })),
    listBatches: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
  };
  render(<Router hook={location.hook} searchHook={location.searchHook}><PublishingRoutes gateway={gateway as unknown as PublisherGateway} /></Router>);
  return { location, gateway };
}

describe("publishing workbench", () => {
  it("opens saved publication links inside the workbench and preserves all record filters", async () => {
    const { location, gateway } = open("/publishing/publications?kind=self_media&status=success&query=品牌&page=2&from=2026-09-01");
    expect(await screen.findByRole("heading", { name: "发布工作台" })).toBeInTheDocument();
    await waitFor(() => expect(gateway.listBatches).toHaveBeenCalledWith(expect.objectContaining({ kind: "self_media", status: "success", query: "品牌", page: 2, from: "2026-09-01" }), expect.any(AbortSignal)));
    expect(location.history.at(-1)).toMatch(/^\/publishing\?tab=records/);
    expect(screen.getByRole("link", { name: "发布记录" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("textbox", { name: "搜索发布记录" })).toHaveValue("品牌");
    fireEvent.change(screen.getByRole("combobox", { name: "发布状态" }), { target: { value: "failed" } });
    await waitFor(() => expect(gateway.listBatches).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", page: 1 }), expect.any(AbortSignal)));
    expect(location.history.at(-1)).toContain("tab=records");
  });

  it("switches from work overview into the full publication records list", async () => {
    const { gateway } = open("/publishing");
    expect(await screen.findByRole("heading", { name: "发布工作台" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "可恢复投放草稿" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "媒体发布概览" })).not.toBeInTheDocument();
    expect(gateway.listBatches).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "发布记录" }));
    expect(await screen.findByRole("region", { name: "筛选发布记录" })).toBeInTheDocument();
    expect(await screen.findByText("没有匹配的发布记录")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "媒体发布概览" })).not.toBeInTheDocument();
  });
});
