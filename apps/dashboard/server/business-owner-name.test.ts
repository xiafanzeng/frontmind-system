import { describe, expect, it } from "vitest";

import {
  businessOwnerNameSchema,
  normalizeBusinessOwnerName,
} from "./business-owner-name";

describe("Website business owner names", () => {
  it.each([
    [" 应  祥 ", "应 祥"],
    ["Alice O’Neil", "Alice O’Neil"],
    ["Jean-Luc Picard", "Jean-Luc Picard"],
    ["张三·李四", "张三·李四"],
    ["Ａｌｉｃｅ", "Alice"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBusinessOwnerName(input)).toBe(expected);
    expect(businessOwnerNameSchema.parse(input)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "Alice\nBob",
    "Alice\u2028Bob",
    "Alice\u202eBob",
    "Alice<admin>",
    "Alice/Bob",
    "（应祥）",
    "应".repeat(41),
  ])("rejects unsafe or out-of-range value %j", (input) => {
    expect(() => normalizeBusinessOwnerName(input)).toThrow(
      "BUSINESS_OWNER_NAME_INVALID",
    );
    expect(businessOwnerNameSchema.safeParse(input).success).toBe(false);
  });
});
