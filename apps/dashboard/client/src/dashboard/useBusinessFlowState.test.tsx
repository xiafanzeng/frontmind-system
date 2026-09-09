import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BusinessWorkspaceProvider } from "./BusinessWorkspaceContext";
import { readFlowString, useBusinessFlowState } from "./useBusinessFlowState";
function Field() {
  const [value, setValue] = useBusinessFlowState("draft", "", readFlowString);
  return (
    <input
      aria-label="任务草稿"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
describe("business task drafts", () => {
  it("keeps unsaved text through first binding, task switches and a failed save", () => {
    const saveState = vi.fn(async () => {
      throw new Error("offline");
    });
    const workspace = (taskId: string | null, pending = false, value = "") => (
      <BusinessWorkspaceProvider
        value={{
          isWorkbench: true,
          agentId: "website",
          taskId,
          setSummary: () => undefined,
          task: {
            saveState,
            pending,
            state: { values: { draft: value } },
          } as any,
        }}
      >
        <Field />
      </BusinessWorkspaceProvider>
    );
    const { rerender } = render(workspace(null));
    expect(saveState).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "首个输入不能消失" },
    });
    rerender(workspace("first-id", true));
    expect(screen.getByRole("textbox")).toHaveValue("首个输入不能消失");
    rerender(workspace("first-id", false));
    expect(screen.getByRole("textbox")).toHaveValue("首个输入不能消失");
    rerender(workspace("other-id", false, "另一任务"));
    expect(screen.getByRole("textbox")).toHaveValue("另一任务");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "另一任务修改" },
    });
    rerender(workspace("first-id"));
    expect(screen.getByRole("textbox")).toHaveValue("首个输入不能消失");
  });
});
