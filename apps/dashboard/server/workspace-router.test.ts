import { describe, expect, it, vi } from "vitest";

import { SiteOpsServiceError } from "./siteops/service";
import { toSiteOpsServiceError } from "./workspace-router";

describe("workspace SiteOps error boundary", () => {
  it("writes one redacted runtime log for an unexpected parameterized error", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const error = Object.assign(new Error("query failed with secret-value"), {
      query: "insert into delivery_tickets values (?)",
      params: ["secret-value"],
    });

    expect(() => toSiteOpsServiceError(error)).toThrow(
      "请求暂时无法完成，请稍后重试",
    );
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[SiteOps] unexpected_error",
      expect.objectContaining({ message: "Database query failed" }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "secret-value",
    );
    consoleError.mockRestore();
  });

  it("preserves known SiteOps errors without writing an unexpected log", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() =>
      toSiteOpsServiceError(
        new SiteOpsServiceError("STATE_CONFLICT", "当前状态不能继续。", 409),
      ),
    ).toThrow("当前状态不能继续。");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("projects visual selection persistence as the public 503 response", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const serviceError = new SiteOpsServiceError(
      "VISUAL_SELECTION_PERSISTENCE_FAILED",
      "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择。",
      503,
    );

    let projected: unknown;
    try {
      toSiteOpsServiceError(serviceError);
    } catch (error) {
      projected = error;
    }

    expect(projected).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message:
        "建站任务未能创建，所选模板尚未生效。无需重新载入模板，请重试选择。",
      cause: {
        code: "VISUAL_SELECTION_PERSISTENCE_FAILED",
        statusCode: 503,
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
