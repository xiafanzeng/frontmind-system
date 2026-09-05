import { describe, expect, it } from "vitest";

import {
  brandTrackingAmountToCredits,
  brandTrackingCreditsToAmount,
  formatBrandTrackingCredits,
  isPositiveBrandTrackingAmount,
} from "./brand-tracking-credits";

describe("brand tracking credit conversion", () => {
  it("multiplies internal accounting amounts by 1000 without floating point rounding", () => {
    expect(brandTrackingAmountToCredits("10.00000000")).toBe("10000");
    expect(brandTrackingAmountToCredits("0.39200000")).toBe("392");
    expect(brandTrackingAmountToCredits("1.00000001")).toBe("1000.00001");
    expect(brandTrackingAmountToCredits("0.00000001")).toBe("0.00001");
    expect(brandTrackingAmountToCredits("-0.00500000")).toBe("-5");
  });

  it("converts editable credits back to the exact eight-decimal amount", () => {
    expect(brandTrackingCreditsToAmount("10000")).toBe("10.00000000");
    expect(brandTrackingCreditsToAmount("392")).toBe("0.39200000");
    expect(brandTrackingCreditsToAmount("1000.00001")).toBe("1.00000001");
    expect(brandTrackingCreditsToAmount("0.00001")).toBe("0.00000001");
    expect(brandTrackingCreditsToAmount("999999999999999.99999")).toBe(
      "999999999999.99999999",
    );
  });

  it("formats readable point values and never turns invalid data into zero", () => {
    expect(formatBrandTrackingCredits("10.00000000")).toBe("10,000积分");
    expect(formatBrandTrackingCredits("0.39200000")).toBe("392积分");
    expect(formatBrandTrackingCredits("1.00000001")).toBe("1,000.00001积分");
    expect(formatBrandTrackingCredits("-0.00500000")).toBe("-5积分");
    expect(
      formatBrandTrackingCredits("10.00000000", { includeUnit: false }),
    ).toBe("10,000");
    expect(
      formatBrandTrackingCredits("1.00000001", { includeUnit: false }),
    ).toBe("1,000.00001");
    expect(formatBrandTrackingCredits(null)).toBe("—");
    expect(formatBrandTrackingCredits(null, { includeUnit: false })).toBe("—");
    expect(formatBrandTrackingCredits("invalid")).toBe("—");
  });

  it("rejects values that cannot round-trip through the accounting precision", () => {
    expect(brandTrackingCreditsToAmount("01")).toBeNull();
    expect(brandTrackingCreditsToAmount("1.000001")).toBeNull();
    expect(brandTrackingCreditsToAmount("1000000000000000")).toBeNull();
    expect(brandTrackingCreditsToAmount("-1")).toBeNull();
    expect(brandTrackingAmountToCredits("1.000000001")).toBeNull();
  });

  it("detects positive internal amounts exactly", () => {
    expect(isPositiveBrandTrackingAmount("0.00000000")).toBe(false);
    expect(isPositiveBrandTrackingAmount("0.00000001")).toBe(true);
    expect(isPositiveBrandTrackingAmount("invalid")).toBe(false);
  });
});
