import { describe, expect, it } from "vitest";

import {
  filterPreviewManagedUsers,
  previewAccountDraftIsValid,
  previewDeliveryModules,
} from "./PreviewPages";

describe("administrator acceptance preview integrity", () => {
  const users = [
    { id: 1, name: "客户一", username: "one", configured: true },
    { id: 2, name: "客户二", username: "two", configured: true },
    { id: 3, name: "其他客户", username: "other", configured: false },
  ];
  const assignments = {
    1: [101],
    2: [101, 102],
    3: [102],
  };

  it("limits a delivery administrator fixture to assigned customers", () => {
    expect(
      filterPreviewManagedUsers(users, assignments, "delivery_admin", 101).map(
        (user) => user.id,
      ),
    ).toEqual([1, 2]);
    expect(
      filterPreviewManagedUsers(users, assignments, "system_admin", 101).map(
        (user) => user.id,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("requires a plan for preview customer creation but never for an administrator", () => {
    const base = {
      name: "新客户",
      username: "new_customer",
      role: "用户" as const,
      password: "valid-pass",
      confirmPassword: "valid-pass",
    };

    expect(previewAccountDraftIsValid(base)).toBe(false);
    expect(
      previewAccountDraftIsValid({
        ...base,
        planCode: "basic",
        marketEdition: "domestic",
      }),
    ).toBe(true);
    expect(
      previewAccountDraftIsValid({
        ...base,
        planCode: "advanced",
        marketEdition: "overseas",
      }),
    ).toBe(true);
    expect(
      previewAccountDraftIsValid({
        ...base,
        planCode: "luxury",
        marketEdition: "domestic",
      }),
    ).toBe(true);

    expect(
      previewAccountDraftIsValid({
        ...base,
        role: "管理员",
        planCode: "luxury",
        password: undefined,
        confirmPassword: undefined,
      }),
    ).toBe(false);
    expect(
      previewAccountDraftIsValid({
        ...base,
        role: "管理员",
        password: "valid-pass",
        confirmPassword: "valid-pass",
      }),
    ).toBe(true);
  });

  it("offers a current-content download template for every delivery module", () => {
    expect(previewDeliveryModules.map((module) => module.title)).toEqual([
      "企业基础资料",
      "品牌全域词库",
      "问题目录",
      "应答逻辑确认稿",
      "问题监控与引用",
      "进度报告",
      "AI 友好内容资产",
    ]);
    expect(previewDeliveryModules).toHaveLength(7);
    previewDeliveryModules.forEach((module) => {
      expect(module.filename).toMatch(/-current\.(csv|json)$/);
      expect(module.content.length).toBeGreaterThan(10);
    });
  });
});
