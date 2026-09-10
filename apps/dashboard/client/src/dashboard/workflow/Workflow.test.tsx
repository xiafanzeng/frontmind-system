import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowCompleted, WorkflowSection } from "./Workflow";
describe("explicit workflow dividers", () => {
  it("lets the parent assign the boundary to the completed summary", () => {
    const { container } = render(<><WorkflowCompleted id="done" summary="已选择资料" /><WorkflowSection {...{ id: "materials", divider: "none" } as any}>表单</WorkflowSection></>);
    expect(container.querySelector(".workflow-section")).toHaveAttribute("data-divider", "none");
  });
});
