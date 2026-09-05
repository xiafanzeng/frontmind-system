import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ContentAssetTicketHistory from "./ContentAssetTicketHistory";

describe("ContentAssetTicketHistory", () => {
  it("uses one unified history and shows only the public two-state status", () => {
    render(
      <ContentAssetTicketHistory
        tickets={[
          {
            id: "pending",
            type: "content_asset",
            title: "行业白皮书",
            topic: "先进制造趋势",
            status: "needs_information",
            publicStatus: "pending",
            submittedAt: "2026-07-26T08:00:00.000Z",
            updatedAt: "2026-07-28T08:00:00.000Z",
            latestPublicMessage: "请补充内部资料，这句话不应出现在列表。",
          },
          {
            id: "completed",
            type: "content_asset",
            title: "知乎问答",
            topic: "如何核验企业品牌事实",
            status: "completed",
            submittedAt: "2026-07-20T08:00:00.000Z",
            updatedAt: "2026-07-27T08:00:00.000Z",
            publicSummary: "已完成企业事实核验与专业问答内容整理。",
            deliveryLinks: [
              {
                label: "知乎",
                url: "https://www.zhihu.com/question/example",
              },
            ],
          },
          {
            id: "canonical-category",
            type: "content_asset",
            category: "A1",
            categoryLabel: "A1",
            topic: "A1",
            publicStatus: "pending",
          },
          {
            id: "unknown-category",
            type: "content_asset",
            category: "future_content_category",
            categoryLabel: "future_content_category",
            topic: "future_content_category",
            publicStatus: "pending",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("region", { name: "内容历史与交付记录" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { name: "内容历史与交付记录" }),
    ).toHaveLength(1);
    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("待补资料")).not.toBeInTheDocument();
    expect(
      screen.queryByText("请补充内部资料，这句话不应出现在列表。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
    expect(screen.getByText("企业资料与品牌事实")).toBeInTheDocument();
    expect(screen.getByText("内容资产需求")).toBeInTheDocument();
    expect(
      screen.getAllByText("内容运营与发布需求").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.queryByText(/future_content_category|^A1$/),
    ).not.toBeInTheDocument();

    const completedRow = screen
      .getByText("如何核验企业品牌事实")
      .closest("article");
    expect(completedRow).toBeInstanceOf(HTMLElement);
    expect(
      within(completedRow as HTMLElement).getByText(
        "已完成企业事实核验与专业问答内容整理。",
      ),
    ).toBeInTheDocument();
    expect(
      within(completedRow as HTMLElement).getByRole("link", { name: "知乎" }),
    ).toHaveAttribute("href", "https://www.zhihu.com/question/example");
  });
});
