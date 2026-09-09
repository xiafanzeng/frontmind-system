import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
  it("rejects a late setter from another project even when task IDs match", () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    let scopeKey = "account:project-a:website";
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <BusinessWorkspaceProvider
          value={{
            isWorkbench: true,
            taskId: "same-id",
            agentId: "website",
            setSummary: () => undefined,
            task: {
              scopeKey,
              saveState,
              pending: false,
              state: { values: { draft: scopeKey } },
            } as any,
          }}
        >
          {children}
        </BusinessWorkspaceProvider>
      );
    }
    const view = renderHook(
      () => useBusinessFlowState("draft", "", readFlowString),
      { wrapper: Wrapper },
    );
    act(() => {
      view.result.current[1]("甲项目的草稿");
    });
    const lateSetter = view.result.current[1];
    scopeKey = "account:project-b:website";
    view.rerender();
    act(() => {
      lateSetter("迟到的甲项目上传结果");
    });
    expect(view.result.current[0]).toBe(scopeKey);
    expect(saveState).toHaveBeenCalledTimes(1);
    act(() => {
      view.result.current[1]("乙项目的草稿");
    });
    scopeKey = "account:project-a:website";
    view.rerender();
    expect(view.result.current[0]).toBe("甲项目的草稿");
  });
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
