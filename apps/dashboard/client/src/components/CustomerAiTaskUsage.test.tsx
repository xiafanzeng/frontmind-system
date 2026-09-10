import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CustomerAiTaskUsageList } from "./CustomerAiTaskUsage";
describe("customer task consumption", () => {
  it("shows upload tasks and explicit zero-call copy without internal cost fields", () => {
    render(<CustomerAiTaskUsageList tasks={[{ runId: "run", businessName: "知识库", status: "等待中", startedAt: 1000, lastActivityAt: 2000, phase: "上传或准备资料", inputTokens: "0", outputTokens: "0", cacheTokens: "0", chargedTenThousandths: "0", usageStatus: "none" }]} />);
    expect(screen.getByText(/知识库 · 等待中/)).toBeInTheDocument();
    expect(screen.getByText("当前仍在上传或准备资料，尚未产生模型调用和 Token 消耗。")).toBeInTheDocument();
    expect(screen.getByText("缓存 Token")).toBeInTheDocument();
    expect(screen.getByText("暂无消耗")).toBeInTheDocument();
  });
});
