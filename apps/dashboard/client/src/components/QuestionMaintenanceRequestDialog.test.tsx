import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import QuestionMaintenanceRequestDialog from "./QuestionMaintenanceRequestDialog";

const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    workspace: {
      questionMaintenance: {
        submit: {
          useMutation: () => ({ mutateAsync: submit, isPending: false }),
        },
      },
    },
  },
}));

describe("QuestionMaintenanceRequestDialog", () => {
  beforeEach(() => {
    submit.mockReset().mockResolvedValue({ ticket: { id: "ticket-1" } });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("submits a selected question modification with the replacement text", async () => {
    render(
      <QuestionMaintenanceRequestDialog
        mode="question"
        questions={[
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", question: "旧问题？" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交问题修改需求" }));
    fireEvent.change(screen.getByPlaceholderText("请输入修改后的完整问题"), {
      target: { value: "修改后的问题是什么？" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("可补充修改或删除原因，方便工程师审核"),
      { target: { value: "原问题表达不准确" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "提交问题修改需求" }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        action: "modify",
        questionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        proposedQuestion: "修改后的问题是什么？",
        reason: "原问题表达不准确",
      }),
    );
  });

  it("submits a reset request only for the confirmed response-logic target", async () => {
    render(
      <QuestionMaintenanceRequestDialog
        mode="response_logic"
        selectedQuestionId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        questions={[
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            question: "当前已确认问题？",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "提交应答逻辑修改需求" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "提交应答逻辑修改需求" }),
    );

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        action: "response_logic_reset",
        questionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    );
  });

  it("keeps a per-question delete request locked to deletion", async () => {
    render(
      <QuestionMaintenanceRequestDialog
        mode="question"
        fixedAction="delete"
        triggerLabel="申请删除"
        selectedQuestionId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        questions={[
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", question: "旧问题？" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "申请删除" }));
    expect(
      screen.getByRole("heading", { name: "提交问题删除需求" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("修改后的问题")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修改问题" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "提交问题删除需求" }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        action: "delete",
        questionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
  });
});
