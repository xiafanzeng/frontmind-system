import { describe, expect, it } from "vitest";

import { usagePageReachedCutoff } from "./upstream-task-usage";

describe("rolling task usage pagination", () => {
  it("stops only after a complete page is entirely before the window", () => {
    expect(
      usagePageReachedCutoff({
        complete: true,
        datedTaskCount: 100,
        expiredTaskCount: 100,
      }),
    ).toBe(true);
    expect(
      usagePageReachedCutoff({
        complete: true,
        datedTaskCount: 100,
        expiredTaskCount: 99,
      }),
    ).toBe(false);
    expect(
      usagePageReachedCutoff({
        complete: false,
        datedTaskCount: 100,
        expiredTaskCount: 100,
      }),
    ).toBe(false);
  });
});
