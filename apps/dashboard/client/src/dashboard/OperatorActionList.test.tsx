import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorActionList } from "./OperatorActionList";
import { WorkflowQuestion } from "./workflow/Workflow";

describe("numbered business entries", () => {
  it("does not preselect and sends the stable action id from the full row", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <OperatorActionList
        module="content"
        items={[
          { id: "brand", title: "品牌资料包", description: "整理企业资料" },
          { id: "article", title: "品牌文章" },
        ]}
        onSelect={onSelect}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(
      buttons.every(
        (button) => button.getAttribute("aria-pressed") === "false",
      ),
    ).toBe(true);
    fireEvent.click(screen.getByText("整理企业资料"));
    expect(onSelect).toHaveBeenCalledWith("brand");
    expect(container.querySelectorAll("button button")).toHaveLength(0);
    expect(container.querySelector(".operator-action-list")).toHaveStyle({
      "--module-color": "#8a6100",
    });
  });
  it("preserves disabled reasons and blocks repeated submissions while pending", () => {
    const onSelect = vi.fn();
    render(
      <OperatorActionList
        module="brand"
        pendingId="create"
        items={[
          { id: "create", title: "新建" },
          {
            id: "update",
            title: "更新",
            disabled: true,
            disabledReason: "请先保存资料包",
          },
        ]}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("请先保存资料包")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("处理中");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("keeps followup choices lightweight and entry choices numbered", () => {
    const { container, rerender } = render(
      <WorkflowQuestion
        question="下一步"
        choices={[{ id: "yes", label: "确认" }]}
      />,
    );
    expect(container.querySelector(".operator-action-list")).toBeNull();
    rerender(
      <WorkflowQuestion
        variant="entry"
        module="progress"
        question="监控"
        choices={[{ id: "data", label: "监控数据" }]}
      />,
    );
    expect(
      container.querySelector(".operator-action-number"),
    ).toHaveTextContent("1");
  });
});
