import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import KnowledgeBaseProgressPanel, {
  type KnowledgeBaseProgressDto,
} from "./KnowledgeBaseProgressPanel";

const progress: KnowledgeBaseProgressDto = {
  build: {
    id: "build-1",
    conversationId: "conversation-1",
    companyName: "示例企业",
    status: "confirming",
    revision: 4,
    currentLeafId: "leaf-current",
    protocolError: null,
    updatedAt: 1_753_200_000_000,
  },
  summary: {
    total: 5,
    handled: 2,
    confirmed: 1,
    directPrefilled: 1,
    pending: 1,
    current: 1,
    needsVerification: 1,
    overallPercent: 40,
  },
  branches: [
    {
      id: "identity",
      title: "企业身份与定位",
      total: 5,
      handled: 2,
      confirmed: 1,
      directPrefilled: 1,
      pending: 1,
      current: 1,
      needsVerification: 1,
      leaves: [
        {
          id: "leaf-confirmed",
          title: "企业名称",
          branchId: "identity",
          branchTitle: "企业身份与定位",
          ordinal: 0,
          status: "confirmed",
        },
        {
          id: "leaf-prefilled",
          title: "品牌简称",
          branchId: "identity",
          branchTitle: "企业身份与定位",
          ordinal: 1,
          status: "direct_prefilled",
        },
        {
          id: "leaf-current",
          title: "核心定位",
          branchId: "identity",
          branchTitle: "企业身份与定位",
          ordinal: 2,
          status: "current",
        },
        {
          id: "leaf-verification",
          title: "注册地址",
          branchId: "identity",
          branchTitle: "企业身份与定位",
          ordinal: 3,
          status: "needs_verification",
        },
        {
          id: "leaf-pending",
          title: "品牌使命",
          branchId: "identity",
          branchTitle: "企业身份与定位",
          ordinal: 4,
          status: "pending",
        },
      ],
    },
  ],
  packageAllowed: false,
};

describe("KnowledgeBaseProgressPanel", () => {
  it("shows the supplied progress and reserves Check for confirmed leaves", () => {
    const { container } = render(
      <KnowledgeBaseProgressPanel progress={progress} />,
    );

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "40",
    );
    expect(screen.getByText("总体已处理 2 / 5")).toBeTruthy();
    expect(screen.queryByText(/当前版本/)).toBeNull();
    expect(screen.queryByText(/版本\s*4/)).toBeNull();

    const confirmed = container.querySelector('[data-leaf-status="confirmed"]');
    const directPrefilled = container.querySelector(
      '[data-leaf-status="direct_prefilled"]',
    );
    const current = container.querySelector('[data-leaf-status="current"]');
    const needsVerification = container.querySelector(
      '[data-leaf-status="needs_verification"]',
    );
    const pending = container.querySelector('[data-leaf-status="pending"]');

    expect(confirmed?.querySelector(".lucide-check")).toBeTruthy();
    expect(directPrefilled?.querySelector(".lucide-check")).toBeNull();
    expect(directPrefilled?.querySelector(".lucide-fast-forward")).toBeTruthy();
    expect(current?.textContent).toContain("等待确认");
    expect(needsVerification?.textContent).toContain("待再次确认");
    expect(pending?.textContent).toContain("待处理");
  });

  it("keeps the compact summary readable and branch details collapsed by default", () => {
    render(<KnowledgeBaseProgressPanel progress={progress} />);

    const overallSummary = screen.getByTestId("overall-progress-summary");
    const handledLabel = screen.getByText("总体已处理 2 / 5");
    const metrics = screen.getByTestId("progress-summary-metrics");
    const branch = screen.getByTestId("knowledge-branch") as HTMLDetailsElement;

    expect(overallSummary.className).toContain("space-y-3");
    expect(handledLabel.className).toContain("whitespace-nowrap");
    expect(metrics.className).toContain("grid-cols-3");
    expect(metrics.className).not.toContain("sm:grid-cols-6");
    expect(branch.open).toBe(false);
  });
});
