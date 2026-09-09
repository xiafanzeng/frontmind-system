import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ExecutionTrace from "./ExecutionTrace";

describe("public execution process", () => {
  it("shows useful observed operations without exposing raw code, details or reasoning", () => {
    const { container } = render(
      <ExecutionTrace
        stepGroups={[
          {
            id: "g",
            title: "private task prompt",
            description: "internal instruction",
            steps: [
              {
                id: "r",
                type: "function_call",
                label: "读取文档",
                details: "/internal/secret.pdf",
              },
              {
                id: "t",
                type: "reasoning",
                label: "private reasoning",
                description: "hidden text",
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("读取文档 · 分析任务")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/private|internal|hidden|secret/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
  it("deduplicates commands by call identity across provider groups", () => {
    const step = {
      id: "call-one",
      type: "code_interpreter_call",
      label: "python",
      details: "print(secret)",
    };
    render(
      <ExecutionTrace
        stepGroups={[
          { id: "one", title: "a", steps: [step] },
          { id: "two", title: "b", steps: [step, { ...step, id: "call-two" }] },
        ]}
      />,
    );
    expect(screen.getByText("执行了 2 个命令")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
