import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  invalidate: vi.fn(),
  questionRevision: 7,
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
      questionPortfolio: {
        useQuery: () => ({
          data: {
            questions: [
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
});
