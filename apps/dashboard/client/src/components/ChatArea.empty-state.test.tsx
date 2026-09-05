import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  EmptyConversationHint,
  KNOWLEDGE_BASE_FOUNDATION_COPY,
} from "./ChatArea";

describe("EmptyConversationHint", () => {
  it("centers the enterprise knowledge-base action without the generic content-workflow copy", () => {
    render(
      <EmptyConversationHint
        onStartKnowledgeBase={vi.fn()}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );

    expect(
      screen.queryByText("内容制作智能体编排工作流"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("以研究、分析与交付为核心的专业内容生产引擎"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(KNOWLEDGE_BASE_FOUNDATION_COPY),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "构建企业知识库" }),
    ).toBeInTheDocument();
    expect(screen.getByText("资料输入")).toBeInTheDocument();
    expect(screen.getByText("智能分析")).toBeInTheDocument();
    expect(screen.getByText("报告交付")).toBeInTheDocument();
  });

  it("uses the shared 100 MB limit in the knowledge-base starter", () => {
    render(
      <EmptyConversationHint
        onStartKnowledgeBase={vi.fn()}
        companyName="验收企业"
        companyConfigured
        companyLoading={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "构建企业知识库" }));
    const oversized = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: 100 * 1024 * 1024 + 1,
    });

    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [oversized] },
    });

    expect(screen.queryByText("oversized.pdf")).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("文件过大", {
      description: "文件“oversized.pdf”不能超过 100 MB",
    });
  });
});
