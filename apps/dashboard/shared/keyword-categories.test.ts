import { describe, expect, it } from "vitest";

import {
  KEYWORD_CATEGORY_PALETTE,
  KEYWORD_CATEGORY_OPTIONS,
  isKeywordCategoryColumn,
  keywordCategoryColumnIndex,
  keywordCategoryKey,
  keywordCategoryLabel,
  keywordCategoryPalette,
  keywordTableDisplayText,
} from "./keyword-categories";

describe("keyword category normalization", () => {
  it.each([
    ["品类行业词", "industry", "行业排名词"],
    ["行业词", "industry", "行业排名词"],
    ["行业", "industry", "行业排名词"],
    ["ranking", "industry", "行业排名词"],
    ["竞品对比词", "competitor_comparison", "竞品对比词"],
    ["竞品", "competitor_comparison", "竞品对比词"],
    ["competitor", "competitor_comparison", "竞品对比词"],
    ["品牌核心词", "reputation", "美誉舆情词"],
    ["品牌口碑", "reputation", "美誉舆情词"],
    ["口碑问题", "reputation", "美誉舆情词"],
    ["场景痛点词", "product_scenario", "产品场景词"],
    ["产品", "product_scenario", "产品场景词"],
    ["product", "product_scenario", "产品场景词"],
    ["scenario", "product_scenario", "产品场景词"],
    ["basic", "product_scenario", "产品场景词"],
    ["product_scenario", "product_scenario", "产品场景词"],
  ])("maps %s into the four customer labels", (source, key, label) => {
    expect(keywordCategoryKey(source)).toBe(key);
    expect(keywordCategoryLabel(source)).toBe(label);
  });

  it("keeps one exact palette for canonical and historical category values", () => {
    expect(KEYWORD_CATEGORY_PALETTE).toEqual({
      industry: { accent: "#9a7028", tint: "#fbf4e5", tone: "amber" },
      competitor_comparison: {
        accent: "#496f9d",
        tint: "#edf3fa",
        tone: "blue",
      },
      reputation: { accent: "#8b4d83", tint: "#f8eef6", tone: "plum" },
      product_scenario: {
        accent: "#2f7e7a",
        tint: "#eaf6f4",
        tone: "teal",
      },
    });
    expect(keywordCategoryPalette("行业问题")).toEqual(
      KEYWORD_CATEGORY_PALETTE.industry,
    );
    expect(keywordCategoryPalette("comparison")).toEqual(
      KEYWORD_CATEGORY_PALETTE.competitor_comparison,
    );
    expect(keywordCategoryPalette("口碑")).toEqual(
      KEYWORD_CATEGORY_PALETTE.reputation,
    );
    expect(keywordCategoryPalette("产品场景问题")).toEqual(
      KEYWORD_CATEGORY_PALETTE.product_scenario,
    );
  });

  it("keeps the category order and renamed industry label stable", () => {
    expect(KEYWORD_CATEGORY_OPTIONS.map((item) => item.label)).toEqual([
      "行业排名词",
      "竞品对比词",
      "美誉舆情词",
      "产品场景词",
    ]);
  });

  it("prefers the uploaded workbook's 核心词分类 column", () => {
    expect(isKeywordCategoryColumn(" 核心词分类 ")).toBe(true);
    expect(
      keywordCategoryColumnIndex(["问题", "分类", "核心词分类", "热度"]),
    ).toBe(2);
  });

  it("accepts 主分类 as the customer-facing workbook header", () => {
    expect(isKeywordCategoryColumn("主分类")).toBe(true);
    expect(keywordCategoryColumnIndex(["问题", "主分类", "问题细分"])).toBe(1);
  });

  it("does not guess unknown source categories", () => {
    expect(keywordCategoryKey("尚未定义的分类")).toBeNull();
    expect(keywordCategoryLabel("尚未定义的分类")).toBeNull();
  });

  it("normalizes trusted question text exactly as the customer table displays it", () => {
    expect(
      keywordTableDisplayText(
        "**测试品牌**适合吗？😀[citation:12]@replace=4`补充`\uFFFD",
      ),
    ).toBe("测试品牌适合吗？补充");
  });
});
