import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ select: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        questionPortfolio: { invalidate: mocks.invalidate },
        portal: { invalidate: mocks.invalidate },
      },
    }),
    workspace: {
      requestQuestionSelection: {
        useMutation: () => ({ mutateAsync: mocks.select, isPending: false }),
      },
    },
  },
}));
import QuestionIntakePanel from "./QuestionIntakePanel";
import type { ServicePortalView } from "./service-portal";
const portal = {
  plan: { code: "advanced" },
  capabilities: { questionSelection: { allowed: true } },
  quotas: ["industry", "competitor", "reputation", "scenario"].map((key) => ({
    key,
    used: 0,
    limit: 10,
  })),
  purchasedQuestions: [],
} as unknown as ServicePortalView;
beforeEach(() => {
  mocks.select.mockReset().mockResolvedValue({});
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
});
describe("customer question selection", () => {
  it("requires an explicit category and immediately selects a directly entered question", async () => {
    render(
      <QuestionIntakePanel
        preview={false}
        portal={portal}
        onOpenBrandQuestions={() => {}}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText("请输入一个完整、明确的问题"),
      { target: { value: "哪种方案适合中小企业？" } },
    );
    expect(screen.getByRole("button", { name: "确认优化问题" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "问题类别" }), {
      target: { value: "product_scenario" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith({
        mode: "direct",
        question: "哪种方案适合中小企业？",
        category: "product_scenario",
      }),
    );
    expect(
      screen.queryByText(/工单|专业审核|待工程师/),
    ).not.toBeInTheDocument();
  });
  it("retains the exact published library coordinates when selecting a catalog question", async () => {
    render(
      <QuestionIntakePanel
        preview={false}
        portal={portal}
        onOpenBrandQuestions={() => {}}
        draft={{
          origin: "brand_keyword_library",
          question: "哪个品牌适合企业？",
          category: "industry",
          libraryRef: {
            dashboardRevision: 9,
            tableId: "industry-1",
            rowIndex: 2,
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith({
        mode: "brand_keyword_library",
        dashboardRevision: 9,
        tableId: "industry-1",
        rowIndex: 2,
      }),
    );
  });
});
