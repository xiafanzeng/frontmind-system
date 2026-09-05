import { describe, expect, it } from "vitest";

import { createDefaultDashboardPayload } from "../shared/dashboard";
import { projectUserDashboardPayload } from "./workspace-router";

describe("user dashboard publication projection", () => {
  it("does not expose the administrator draft skeleton before first publication", () => {
    const payload = createDefaultDashboardPayload("尚未发布企业");

    expect(
      projectUserDashboardPayload({
        payload,
        configured: false,
        contentAssetsAllowed: true,
      }),
    ).toBeNull();
  });

  it("preserves published administrator metrics for plans with content assets", () => {
    const payload = createDefaultDashboardPayload("正式企业");
    payload.metrics = [
      { label: "管理员发布指标", value: 37, unit: "项", note: "真实数据" },
    ];

    expect(
      projectUserDashboardPayload({
        payload,
        configured: true,
        contentAssetsAllowed: true,
      })?.metrics,
    ).toEqual(payload.metrics);
  });

  it("limits a knowledge-only account to enterprise identity fields", () => {
    const payload = createDefaultDashboardPayload("知识库客户");
    payload.metrics = [{ label: "内部指标", value: 1, unit: "项" }];
    payload.sections = [
      {
        id: "private-section",
        title: "交付内容",
        subtitle: "",
        body: "",
        items: [],
      },
    ];

    const projected = projectUserDashboardPayload({
      payload,
      configured: true,
      contentAssetsAllowed: false,
    });

    expect(projected).toMatchObject({
      brandName: "知识库客户",
      metrics: [],
      sections: [],
      contentAssets: [],
      questions: [],
    });
  });
});
