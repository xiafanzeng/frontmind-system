import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExecutionTrace from "./ExecutionTrace";

const groups = [
  {
    id: "g1",
    title: "读取知识库",
    description: "核验资料内容",
    steps: [
      {
        id: "s1",
        type: "function_call",
        label: "读取文档",
        details: "manual.pdf",
      },
      { id: "s2", type: "reasoning", label: "分析文档" },
    ],
  },
];

describe("ExecutionTrace", () => {
  it("shows a plain summary and preserves raw details when expanded", () => {
    render(<ExecutionTrace stepGroups={groups} />);

    expect(screen.getByText("读取知识库 · 分析文档")).toBeInTheDocument();
    expect(screen.queryByText(/条记录|工具调用|完成/)).not.toBeInTheDocument();
    expect(screen.queryByText("manual.pdf")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "展开执行过程：读取知识库 · 分析文档",
      }),
    );
    expect(screen.getByText("核验资料内容")).toBeInTheDocument();
    expect(screen.getByText("manual.pdf")).toBeInTheDocument();
    expect(screen.getByText("分析文档")).toBeInTheDocument();
  });

  it("does not render decorative tool icons or connector markup", () => {
    const { container } = render(<ExecutionTrace stepGroups={groups} />);
    expect(container.querySelector("svg")).toBeTruthy(); // disclosure chevron remains usable
    expect(container.querySelector(".border-l-2")).toBeNull();
  });
});
