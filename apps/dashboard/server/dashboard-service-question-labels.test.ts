import { describe, expect, it } from "vitest";

import { dashboardQuestionGroupForCategory } from "./dashboard-service";

describe("dashboard service question labels", () => {
  it("returns the canonical four customer and administrator labels", () => {
    const categories = [
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario",
    ] as const;

    expect(
      categories.map((category) => dashboardQuestionGroupForCategory(category)),
    ).toEqual([
      { id: "ranking", title: "行业排名词" },
      { id: "comparison", title: "竞品对比词" },
      { id: "reputation", title: "美誉舆情词" },
      { id: "basic", title: "产品场景词" },
    ]);
  });
});
