import { describe, expect, it } from "vitest";

import { passwordSchema } from "./auth-router";

describe("password policy", () => {
  it("accepts six characters and rejects shorter passwords", () => {
    expect(passwordSchema.safeParse("123456").success).toBe(true);
    expect(passwordSchema.safeParse("12345").success).toBe(false);
  });

  it("keeps the 128-character maximum", () => {
    expect(passwordSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});
