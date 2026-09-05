import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import KnowledgeBaseProgressPanel, {
  type KnowledgeBaseProgressDto,
} from "./KnowledgeBaseProgressPanel";
import { KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE } from "@shared/knowledge-base-progress";

const progress: KnowledgeBaseProgressDto = {
  build: {
    id: "build-1",
    conversationId: "conversation-1",
    companyName: "示例企业",
    depthPolicy: {
      version: 1,
      minLeaves: 8,
      maxLeaves: 115,
      targetMinLeaves: 8,
      targetMaxLeaves: 115,
    },
    researchSummary: null,
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

  it("shows completed content immediately while the package is still preparing", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "ready_to_publish",
            currentLeafId: null,
          },
          packageAllowed: false,
        }}
      />,
    );

    expect(
      screen.getByText(
        "知识库内容已完成，下载包正在后台准备；已完成正文不会回退。",
      ),
    ).toBeTruthy();
  });

  it("never presents a stopped build as an operation being restored", () => {
    const { container } = render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "protocol_error",
            currentLeafId: null,
            protocolError: "当前包操作正在对账",
          },
          packageAllowed: false,
        }}
      />,
    );

    expect(screen.getByText("本轮已停止")).toBeTruthy();
    expect(
      screen.getByText("系统不会自动重发。已完成内容不受影响。"),
    ).toBeTruthy();
    expect(screen.queryByText("当前包操作正在对账")).toBeNull();
    expect(screen.queryByText("系统正在恢复当前操作")).toBeNull();
    expect(container.querySelector(".border-slate-200")).toBeTruthy();
    expect(container.querySelector(".border-red-200")).toBeNull();
    expect(screen.queryByText(/Manus/i)).toBeNull();
  });

  it("shows the fixed approved-reset message for a rejected materialized result", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "protocol_error",
            currentLeafId: null,
            protocolError: KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE,
          },
          contentAvailability: "none",
          operationState: "reset_required",
          resetAllowed: true,
          packageAllowed: false,
        }}
      />,
    );

    expect(screen.getByText("本轮结果需要重置")).toBeTruthy();
    expect(screen.queryByText("本轮已停止")).toBeNull();
    expect(
      screen.getByText(KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE),
    ).toBeTruthy();
    expect(screen.queryByText(/排查编号|sha256|trace|task[_-]?id/i)).toBeNull();
  });

  it("shows a pre-create attachment failure as task-not-created with customer files only", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "protocol_error",
            currentLeafId: null,
            protocolError: "internal provider mime detail",
          },
          contentAvailability: "none",
          operationState: "reset_required",
          resetAllowed: true,
          taskCreationState: "not_attempted",
          failureStage: "provider_file_registration",
          retainedCustomerAttachmentCount: 9,
          generatedSystemAttachmentCount: 2,
          settledAt: 1_787_000_000_000,
          packageAllowed: false,
        }}
      />,
    );

    expect(screen.getByText("知识库任务未创建")).toBeTruthy();
    expect(
      screen.getByText(
        "9/9 个附件已保留，知识库任务未创建。请申请重置后重新上传资料。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("本轮已停止")).toBeNull();
    expect(screen.queryByText(/已完成内容不受影响/)).toBeNull();
    expect(screen.queryByText(/internal provider mime detail/)).toBeNull();
    expect(screen.queryByText(/11\/11/)).toBeNull();
  });

  it("projects an acknowledged result phase as normalization instead of stopped", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "protocol_error",
            protocolError: "Provider stopped",
          },
          contentAvailability: "partial",
          operationState: "normalizing",
          resetAllowed: false,
        }}
      />,
    );

    expect(screen.getByText("正在处理已返回内容")).toBeTruthy();
    expect(screen.queryByText("本轮已停止")).toBeNull();
    expect(screen.queryByText(/Provider/i)).toBeNull();
  });

  it("keeps a server-declared partial canonical result visible without legacy quality fields", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "protocol_error",
            protocolError: "Provider stopped",
          },
          contentAvailability: "partial",
          operationState: "completed",
          resetAllowed: false,
        }}
      />,
    );

    expect(screen.getByText("内容不完整，可安全查看")).toBeTruthy();
    expect(screen.queryByText("本轮已停止")).toBeNull();
    expect(screen.queryByText(/Provider/i)).toBeNull();
  });

  it("distinguishes package ready from content-only completion", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "published",
            currentLeafId: null,
          },
          packageAllowed: true,
        }}
      />,
    );

    expect(
      screen.getByText("知识库内容与下载包均已完成，可以直接更新。"),
    ).toBeTruthy();
    expect(screen.queryByText(/下载包正在后台准备/)).toBeNull();
  });

  it("shows package attention as a local warning instead of endless preparation", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          build: {
            ...progress.build,
            status: "ready_to_publish",
            currentLeafId: null,
          },
          packageAllowed: false,
          packageState: "attention_required",
        }}
      />,
    );

    expect(
      screen.getByText(
        "知识库内容已完成，下载包暂时无法生成；已完成正文不受影响。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/下载包正在后台准备/)).toBeNull();
  });

  it("shows partial safe nodes as view-only and never implies package eligibility", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          branches: progress.branches.map((branch) => ({
            ...branch,
            leaves: branch.leaves.map((leaf) => ({
              ...leaf,
              contentMarkdown: `## ${leaf.title}\n\n该安全节点的完整正文。`,
            })),
          })),
          resultQuality: {
            completeness: "partial",
            stats: {
              acceptedCount: 7,
              expectedCount: 30,
              droppedCount: 0,
            },
            warnings: [{ code: "RESULT_INCOMPLETE" }],
            downstreamEligible: false,
            publishable: false,
          },
          packageAllowed: false,
        }}
      />,
    );

    const warning = screen.getByTestId("knowledge-result-quality-partial");
    expect(warning.textContent).toContain("内容不完整，可安全查看");
    expect(warning.textContent).toContain("当前保留 7 个安全节点");
    expect(warning.textContent).toContain("确认、修订、打包和发布均已锁定");
    expect(screen.getAllByTestId("partial-knowledge-leaf")).toHaveLength(5);
    expect(screen.getAllByText("该安全节点的完整正文。")).toHaveLength(5);
    expect(
      screen.getByText("当前安全内容已保留并可查看，但不驱动后续操作或发布。"),
    ).toBeTruthy();
    expect(screen.queryByText(/可以直接更新/)).toBeNull();
  });

  it("explains coverage-only partial results without implying missing node bodies", () => {
    render(
      <KnowledgeBaseProgressPanel
        progress={{
          ...progress,
          resultQuality: {
            completeness: "partial",
            stats: {
              acceptedCount: 54,
              expectedCount: 30,
              droppedCount: 0,
            },
            warnings: [{ code: "COVERAGE_INCOMPLETE" }],
            downstreamEligible: false,
            publishable: false,
          },
        }}
      />,
    );

    const warning = screen.getByTestId("knowledge-result-quality-partial");
    expect(warning.textContent).toContain("研究覆盖信息不完整");
    expect(warning.textContent).toContain(
      "节点内容已保留，但研究覆盖信息不完整，暂不能确认、修订、打包或发布；请申请重置后重新生成。",
    );
    expect(warning.textContent).not.toContain("当前保留 54 个安全节点");
  });
});
