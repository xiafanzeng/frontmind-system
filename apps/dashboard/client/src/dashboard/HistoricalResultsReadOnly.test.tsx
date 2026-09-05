import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoricalQuestionResults } from "@shared/historical-results";

const { historicalUseQuery } = vi.hoisted(() => ({
  historicalUseQuery: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      historicalQuestionResults: {
        useQuery: historicalUseQuery,
      },
    },
  },
}));

import HistoricalResultsReadOnly from "./HistoricalResultsReadOnly";
import { normalizeServicePortal } from "./service-portal";

const portal = normalizeServicePortal({
  schemaVersion: 1,
  known: true,
  account: {
    displayName: "历史企业",
    username: "history-user",
  },
  service: {
    planCode: "advanced",
    planName: "进阶版",
    status: "active",
  },
  historicalQuestions: [
    {
      id: "history-server-id",
      question: "历史问题如何保持成果可追溯？",
      category: "reputation",
      status: "selected",
    },
  ],
});

const result: HistoricalQuestionResults = {
  readOnly: true,
  question: {
    id: "history-server-id",
    externalQuestionId: null,
    sourceQuestionId: null,
    category: "reputation",
    question: "历史问题如何保持成果可追溯？",
    intent: null,
    intentRevision: 1,
    intentConfirmedRevision: null,
    intentConfirmedAt: null,
    intentConfirmed: false,
    rationale: null,
    evidence: [],
    risks: [],
    source: "admin",
    status: "selected",
    selectionApprovalStatus: "approved",
    selectionRequestedAt: Date.parse("2026-06-30T08:00:00.000Z"),
    selectionApprovedAt: Date.parse("2026-06-30T08:00:00.000Z"),
    locked: true,
    revision: 1,
  },
  lineageQuestionIds: ["history-server-id", "carried-server-id"],
  responseLogic: [
    {
      recordId: "logic-1",
      questionId: "history-server-id",
      status: "confirmed",
      version: 2,
      updatedAt: Date.parse("2026-06-30T08:00:00.000Z"),
      content: {
        concern: "需要核验结果是否来自真实服务记录。",
        conclusion: "服务端按问题谱系加载已确认结果。",
        facts: "存在历史确认版本。",
        pending: "",
        boundaries: "历史页面不允许更新。",
        references: "服务端记录",
        images: [],
        attachments: [],
      },
    },
  ],
  monitoring: {
    samples: [],
    sampleTotal: 0,
    citations: [],
    citationTotal: 0,
  },
};

describe("HistoricalResultsReadOnly", () => {
  beforeEach(() => {
    historicalUseQuery.mockReset();
    historicalUseQuery.mockReturnValue({
      data: result,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("loads the formal result by the server question ID and exposes no editor or model composer", () => {
    render(
      <HistoricalResultsReadOnly
        questionId="history-server-id"
        portal={portal}
        onBack={vi.fn()}
      />,
    );

    expect(historicalUseQuery).toHaveBeenCalledWith(
      { questionId: "history-server-id" },
      expect.objectContaining({ retry: false }),
    );
    expect(
      screen.getByText("服务端按问题谱系加载已确认结果。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("不占用当前额度 · 不会发起模型任务"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/载入模型|发送消息|保存草稿/),
    ).not.toBeInTheDocument();
  });

  it("renders an injected development fixture without calling the formal API", () => {
    render(
      <HistoricalResultsReadOnly
        questionId="history-server-id"
        portal={portal}
        onBack={vi.fn()}
        resultOverride={result}
      />,
    );

    expect(historicalUseQuery).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "历史问题如何保持成果可追溯？",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("已有应答逻辑")).toBeInTheDocument();
    expect(screen.getByText("历史监控成果")).toBeInTheDocument();
  });
});
