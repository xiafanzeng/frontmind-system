import { describe, expect, it } from "vitest";
import {
  evaluateImageSize,
  formatFileSize,
  formatImageInspectionSummary,
} from "./image-inspection";

describe("image-inspection", () => {
  it("flags very long or high-pixel images as large", () => {
    const info = evaluateImageSize(26009, 8270, 7 * 1024 * 1024);

    expect(info.isLarge).toBe(true);
    expect(info.pixels).toBe(215_094_430);
    expect(info.reasons.length).toBeGreaterThan(0);
  });

  it("does not flag ordinary images", () => {
    const info = evaluateImageSize(1600, 900, 700 * 1024);

    expect(info.isLarge).toBe(false);
    expect(info.reasons).toHaveLength(0);
  });

  it("formats image diagnostics for UI display", () => {
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0MB");
    expect(
      formatImageInspectionSummary({
        width: 1600,
        height: 900,
        pixels: 1_440_000,
        size: 700 * 1024,
        isLarge: false,
        reasons: [],
      }),
    ).toBe("1600x900 · 1.4MP · 700.0KB");
  });
});
