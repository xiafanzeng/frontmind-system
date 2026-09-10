import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { workspace: { workRecords: { list: { useQuery: api.query } } } },
}));
import { WorkspaceWorkRecords } from "./WorkspaceWorkRecords";
beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    "/?operatorOwnerId=42&enterpriseProjectId=project-a",
  );
  api.query.mockReturnValue({
    data: {
      records: [
        {
          id: "wr_test",
          module: "monitoring",
          title: "问题监控数据已更新",
          summary: "监控结果已同步到当前工作区",
          status: "updated",
          createdAt: 1,
          resourceRef:
            "/monitoring-system?enterpriseProjectId=project-a&monitoringData=1",
        },
      ],
      nextCursor: "signed-cursor",
    },
  });
});
describe("customer business work records", () => {
  it("uses target project and preserves administrator navigation without revealing audit identity", () => {
    render(<WorkspaceWorkRecords projectId="project-a" module="monitoring" />);
    expect(api.query).toHaveBeenCalledWith(
      expect.objectContaining({
        enterpriseProjectId: "project-a",
        module: "monitoring",
        limit: 20,
      }),
      expect.anything(),
    );
    expect(screen.getByRole("link", { name: "打开结果" })).toHaveAttribute(
      "href",
      "/monitoring-system?enterpriseProjectId=project-a&monitoringData=1&operatorOwnerId=42",
    );
    expect(
      screen.queryByRole("button", { name: /删除/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更早记录" }));
    expect(api.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "signed-cursor" }),
      expect.anything(),
    );
  });
});
