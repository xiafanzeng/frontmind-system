import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ManagerAssignmentEditor from "./ManagerAssignmentEditor";

const options = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  label: index === 7 ? "王晨" : `交付管理员 ${index + 1}`,
  secondary: index === 7 ? "@wangchen" : `@delivery_${index + 1}`,
  accessLevel: "delivery_admin" as const,
}));

describe("ManagerAssignmentEditor", () => {
  it("shows a compact selected summary before entering batch edit mode", () => {
    render(
      <ManagerAssignmentEditor
        options={options}
        selectedIds={[1, 2, 3, 4, 5]}
        editable
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("已选 5 位")).toBeInTheDocument();
    expect(screen.getByText("另有 1 位")).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索负责管理员")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "编辑分配" }),
    ).toBeInTheDocument();
  });

  it("searches a scrollable list and submits all selected administrators once", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ManagerAssignmentEditor
        options={options}
        selectedIds={[1, 2]}
        usageOwnerId={1}
        editable
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑分配" }));

    const list = screen.getByRole("group", { name: "管理员候选列表" });
    expect(list).toHaveClass("max-h-56", "overflow-y-auto");

    fireEvent.change(screen.getByLabelText("搜索负责管理员"), {
      target: { value: "wangchen" },
    });
    expect(within(list).getByRole("checkbox", { name: "王晨" })).toBeVisible();
    expect(
      within(list).queryByRole("checkbox", { name: "交付管理员 1" }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("checkbox", { name: "王晨" }));
    fireEvent.click(screen.getByRole("button", { name: "保存分配" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith([1, 2, 8], 1);
    expect(screen.queryByLabelText("搜索负责管理员")).not.toBeInTheDocument();
  });

  it("discards draft changes on cancel and stays read-only for non-system administrators", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ManagerAssignmentEditor
        options={options}
        selectedIds={[1]}
        usageOwnerId={1}
        editable
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑分配" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "交付管理员 2" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("已选 1 位")).toBeInTheDocument();

    rerender(
      <ManagerAssignmentEditor
        options={options}
        selectedIds={[1]}
        editable={false}
        onSave={onSave}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "编辑分配" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("当前仅可查看负责关系；只有系统管理员可以调整。"),
    ).toBeInTheDocument();
  });

  it("resolves the delivery administrator's own read-only assignment", () => {
    render(
      <ManagerAssignmentEditor
        options={[
          {
            id: 42,
            label: "当前交付管理员",
            secondary: "@delivery_self",
          },
        ]}
        selectedIds={[42]}
        editable={false}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("已选 1 位")).toBeInTheDocument();
    expect(screen.getByText("当前交付管理员")).toBeInTheDocument();
    expect(screen.queryByText("暂未分配负责管理员")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑分配" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the draft open when the batch save fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network"));
    render(
      <ManagerAssignmentEditor
        options={options}
        selectedIds={[1]}
        usageOwnerId={1}
        editable
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑分配" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "交付管理员 2" }));
    fireEvent.click(screen.getByRole("button", { name: "保存分配" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith([1, 2], 1));
    expect(screen.getByLabelText("搜索负责管理员")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "交付管理员 2" }),
    ).toBeChecked();
  });

  it("allows a system administrator to be the customer owner", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ManagerAssignmentEditor
        options={[
          options[0],
          options[1],
          {
            id: 99,
            label: "系统管理员",
            secondary: "@system_admin",
            accessLevel: "system_admin",
          },
        ]}
        selectedIds={[1, 99]}
        usageOwnerId={1}
        editable
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑分配" }));
    const ownerSelect = screen.getByLabelText("主负责人");
    expect(
      within(ownerSelect).getByRole("option", { name: "系统管理员" }),
    ).toBeInTheDocument();
    expect(
      within(ownerSelect).getByRole("option", { name: "交付管理员 1" }),
    ).toBeInTheDocument();
    fireEvent.change(ownerSelect, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "保存分配" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith([1, 99], 99));
  });
});
