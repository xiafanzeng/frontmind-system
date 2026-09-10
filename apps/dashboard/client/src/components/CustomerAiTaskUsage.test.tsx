import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomerAiTaskUsageList, selectUsageProject } from "./CustomerAiTaskUsage";
describe("customer task consumption", () => {
  it("shows upload tasks and explicit zero-call copy without internal cost fields", () => {
    render(<CustomerAiTaskUsageList tasks={[{ runId: "run", businessName: "知识库", status: "等待中", startedAt: 1000, lastActivityAt: 2000, phase: "上传或准备资料", inputTokens: "0", outputTokens: "0", cacheTokens: "0", chargedTenThousandths: "0", usageStatus: "none" }]} />);
    expect(screen.getByText(/知识库 · 等待中/)).toBeInTheDocument();
    expect(screen.getByText("当前仍在上传或准备资料，尚未产生模型调用和 Token 消耗。")).toBeInTheDocument();
    expect(screen.getByText("缓存 Token")).toBeInTheDocument();
    expect(screen.getByText("暂无消耗")).toBeInTheDocument();
  });
});

it("uses the remembered authorized project and preserves a manual choice", () => {
  vi.mocked(sessionStorage.getItem).mockReturnValue(JSON.stringify({ ownerUserId: 7, id: "recent" }));
  const projects = [{ id: "first", ownerUserId: 7 }, { id: "recent", ownerUserId: 7 }];
  expect(selectUsageProject(projects, "")).toBe("recent");
  expect(selectUsageProject(projects, "first")).toBe("first");
  vi.mocked(sessionStorage.getItem).mockReset();
});
it("does not describe a stopped zero-call task as an ongoing upload", () => {
  render(<CustomerAiTaskUsageList tasks={[{ runId: "stopped", businessName: "知识库", status: "已停止", startedAt: 1000, lastActivityAt: 2000, phase: "已停止", inputTokens: "0", outputTokens: "0", cacheTokens: "0", chargedTenThousandths: "0", usageStatus: "none" }]} />);
  expect(screen.getByText("任务已停止，未产生模型调用。")).toBeInTheDocument();
  expect(screen.queryByText(/当前仍在上传/)).toBeNull();
});
