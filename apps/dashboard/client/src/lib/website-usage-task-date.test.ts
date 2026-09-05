import { describe, expect, it } from "vitest";

import { formatWebsiteUsageTaskDate } from "./website-usage-task-date";

describe("Website usage task dates", () => {
  it("uses Asia/Shanghai and appends the immutable business owner", () => {
    const createdAt = Date.parse("2026-08-10T16:30:00.000Z");
    expect(formatWebsiteUsageTaskDate(createdAt, "应祥")).toBe(
      "2026/8/11（应祥）",
    );
    expect(formatWebsiteUsageTaskDate(createdAt, null)).toBe("2026/8/11");
  });
});
