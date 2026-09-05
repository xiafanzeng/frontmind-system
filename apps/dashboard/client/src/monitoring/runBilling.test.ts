import { describe, expect, it } from "vitest";

import type { MonitorInput } from "./domain";
import {
  buildRunCostQuoteInput,
  summarizeScreenshotPolicies,
} from "./runBilling";

describe("run billing quote input", () => {
  it("quotes each platform with its independent screenshot policy", () => {
    const configuration: MonitorInput = {
      name: "报价监控",
      competitors: [],
      questions: ["问题一", "问题二"],
      platforms: [
        {
          platformId: "model-domestic",
          providerCode: "doubao",
          clientType: "web",
          mode: "search",
          screenshot: 0,
          regionCode: "420100",
        },
        {
          platformId: "model-overseas",
          providerCode: "chatgpt",
          clientType: "web",
          mode: "reasoning_search",
          screenshot: 2,
          regionCode: "138",
        },
      ],
      repetitions: 3,
      schedule: { type: "none", timezone: "Asia/Shanghai" },
    };

    expect(buildRunCostQuoteInput(configuration)).toEqual({
      items: [
        {
          platformId: "model-domestic",
          mode: "search",
          screenshot: 0,
          regionCode: "420100",
          quantity: 6,
        },
        {
          platformId: "model-overseas",
          mode: "reasoning_search",
          screenshot: 2,
          regionCode: "138",
          quantity: 6,
        },
      ],
    });
    expect(summarizeScreenshotPolicies(configuration.platforms)).toBe("mixed");
  });
});
