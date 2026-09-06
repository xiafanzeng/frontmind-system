import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  invalidate: vi.fn(),
  questionRevision: 7,
  portalData: null as Record<string, unknown> | null,
  portfolioRead: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        questionPortfolio: { invalidate: mocks.invalidate },
        portal: { invalidate: mocks.invalidate },
        responseLogic: { invalidate: mocks.invalidate },
      },
    }),
    workspace: {
      questionPortfolio: { useQuery: mocks.portfolioRead },
      portal: {
        useQuery: () => ({
          data: mocks.portalData ?? {
            purchasedQuestions: [
              { id: "question-1", revision: mocks.questionRevision },
              { id: "question-2", revision: mocks.questionRevision },
            ],
          },
        }),
      },
      questionMaintenance: {
        execute: {
          useMutation: () => ({ mutateAsync: mocks.execute, isPending: false }),
        },
      },
    },
  },
}));
import QuestionActionDialog from "./QuestionActionDialog";
const target = { id: "question-1", question: "原问题" };
beforeEach(() => {
  mocks.questionRevision = 7;
  mocks.portalData = null;
  mocks.portfolioRead.mockReset();
  mocks.execute.mockReset().mockResolvedValue({ questionId: target.id });
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
});
describe("customer question actions", () => {
  it("modifies the own question with its authoritative revision and refreshes all dependent views", async () => {
    render(
      <QuestionActionDialog
        mode="question"
        questions={[target]}
        fixedAction="modify"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "修改问题" }));
    fireEvent.change(screen.getByLabelText("修改后的问题"), {
      target: { value: "更新后的问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(mocks.execute).toHaveBeenCalledWith({
        clientRequestId: expect.any(String),
        questionId: target.id,
        expectedRevision: 7,
        action: "modify",
        proposedQuestion: "更新后的问题",
      }),
    );
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(3));
  });
  it("retains both confirmed revisions when the question and response update while the dialog is open", async () => {
    const { rerender } = render(
      <QuestionActionDialog
        mode="response_logic"
        questions={[target]}
        expectedResponseLogicRevision={12}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重置应答逻辑" }));
    mocks.questionRevision = 8;
    rerender(
      <QuestionActionDialog
        mode="response_logic"
        questions={[target]}
        expectedResponseLogicRevision={13}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认重置应答逻辑" }));
    await waitFor(() =>
      expect(mocks.execute).toHaveBeenCalledWith({
        clientRequestId: expect.any(String),
        questionId: target.id,
        expectedRevision: 7,
        action: "response_logic_reset",
        expectedResponseLogicRevision: 12,
      }),
    );
  });
  it("keeps the same mutation identity when a delete response is uncertain", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("连接中断"));
    render(
      <QuestionActionDialog
        mode="question"
        questions={[target]}
        fixedAction="delete"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "删除问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除问题" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    const first = mocks.execute.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "确认删除问题" }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect(mocks.execute.mock.calls[1][0]).toEqual(first);
    expect(first).toMatchObject({
      action: "delete",
      questionId: target.id,
      expectedRevision: 7,
    });
  });
  it("keeps the confirmed target when the selected question changes in the background", async () => {
    const secondQuestion = { id: "question-2", question: "另一问题" };
    const { rerender } = render(
      <QuestionActionDialog
        mode="question"
        questions={[target, secondQuestion]}
        selectedQuestionId={target.id}
        fixedAction="delete"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "删除问题" }));
    rerender(
      <QuestionActionDialog
        mode="question"
        questions={[target, secondQuestion]}
        selectedQuestionId={secondQuestion.id}
        fixedAction="delete"
      />,
    );
    expect(screen.getByText("原问题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除问题" }));
    await waitFor(() =>
      expect(mocks.execute).toHaveBeenCalledWith(
        expect.objectContaining({ questionId: target.id, expectedRevision: 7 }),
      ),
    );
  });
  it.each(["modify", "delete", "response_logic_reset"] as const)(
    "allows %s for an earlier Basic purchase that is still in the current portal",
    async (action) => {
      const earlier = {
        id: "earlier-basic-question",
        question: "较早购买仍在服务的问题",
        revision: 4,
      };
      const later = {
        id: "latest-basic-question",
        question: "最近购买的问题",
        revision: 1,
      };
      // The public portal aggregates both active Basic purchases, while the legacy
      // portfolio would only expose the quota period selected as the current one.
      mocks.portalData = {
        service: { planCode: "basic" },
        quotas: { periodId: "latest-basic-period" },
        purchasedQuestions: [earlier, later],
        historicalQuestions: [],
      };
      mocks.portfolioRead.mockReturnValue({ data: { questions: [later] } });
      const reset = action === "response_logic_reset";
      render(
        <QuestionActionDialog
          mode={reset ? "response_logic" : "question"}
          questions={[earlier, later]}
          selectedQuestionId={earlier.id}
          fixedAction={reset ? undefined : action}
          expectedResponseLogicRevision={9}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: reset
            ? "重置应答逻辑"
            : action === "modify"
              ? "修改问题"
              : "删除问题",
        }),
      );
      if (action === "modify")
        fireEvent.change(screen.getByLabelText("修改后的问题"), {
          target: { value: "较早购买问题的新内容" },
        });
      fireEvent.click(
        screen.getByRole("button", {
          name: reset
            ? "确认重置应答逻辑"
            : action === "modify"
              ? "保存修改"
              : "确认删除问题",
        }),
      );
      await waitFor(() =>
        expect(mocks.execute).toHaveBeenCalledWith({
          clientRequestId: expect.any(String),
          questionId: earlier.id,
          expectedRevision: 4,
          action,
          ...(action === "modify"
            ? { proposedQuestion: "较早购买问题的新内容" }
            : {}),
          ...(reset ? { expectedResponseLogicRevision: 9 } : {}),
        }),
      );
      expect(mocks.portfolioRead).not.toHaveBeenCalled();
    },
  );
  it.each(["expired-question", "another-users-question"])(
    "does not authorize %s from caller props",
    (questionId) => {
      const unavailable = {
        id: questionId,
        question: "不属于当前服务的问题",
        revision: 2,
      };
      mocks.portalData = {
        purchasedQuestions: [target],
        historicalQuestions:
          questionId === "expired-question" ? [unavailable] : [],
      };
      render(
        <QuestionActionDialog
          mode="question"
          questions={[unavailable]}
          fixedAction="delete"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "删除问题" }));
      expect(screen.getByRole("alert")).toHaveTextContent("该问题已更新或移除");
      expect(
        screen.getByRole("button", { name: "确认删除问题" }),
      ).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "确认删除问题" }));
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
});
