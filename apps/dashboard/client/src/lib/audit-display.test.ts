import { describe, expect, it } from "vitest";

import { auditActionLabel, auditEventDetail } from "./audit-display";

describe("audit display localization", () => {
  it("localizes machine action and target codes without exposing raw ids", () => {
    expect(auditActionLabel("account.created")).toBe("创建账号");
    expect(auditEventDetail({ targetType: "user" }, "示例企业")).toBe(
      "用户账号 · 示例企业",
    );
  });

  it("uses safe Chinese fallbacks for unknown machine codes", () => {
    expect(auditActionLabel("future.unknown_action")).toBe("其他系统操作");
    expect(auditEventDetail({ targetType: "future_unknown", reason: "" })).toBe(
      "其他对象",
    );
  });

  it("keeps an operator supplied reason as the readable detail", () => {
    expect(
      auditEventDetail({
        targetType: "service_contract",
        reason: "客户确认升级套餐",
      }),
    ).toBe("客户确认升级套餐");
  });
});
