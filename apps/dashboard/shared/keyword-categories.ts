export const KEYWORD_CATEGORY_OPTIONS = [
  { key: "industry", label: "行业排名词" },
  { key: "competitor_comparison", label: "竞品对比词" },
  { key: "reputation", label: "美誉舆情词" },
  { key: "product_scenario", label: "产品场景词" },
] as const;

export type KeywordCategoryKey =
  (typeof KEYWORD_CATEGORY_OPTIONS)[number]["key"];
export type KeywordCategoryLabel =
  (typeof KEYWORD_CATEGORY_OPTIONS)[number]["label"];
export type KeywordCategoryTone = "amber" | "blue" | "plum" | "teal";

export const KEYWORD_CATEGORY_PALETTE = Object.freeze({
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
} satisfies Record<
  KeywordCategoryKey,
  { accent: string; tint: string; tone: KeywordCategoryTone }
>);

/** Canonical customer-visible cell text used by rendering and selection. */
export function keywordTableDisplayText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\[\]\(@[^)]*\)/g, "")
    .replace(/\[citation:\d+\]/g, "")
    .replace(/@replace=\d+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFFFD]/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CATEGORY_LABEL_BY_KEY = Object.fromEntries(
  KEYWORD_CATEGORY_OPTIONS.map((category) => [category.key, category.label]),
) as Record<KeywordCategoryKey, KeywordCategoryLabel>;

function normalizedKeywordCategoryToken(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\s_\-/]+/g, "")
    .replace(/[（）()【】\[\]：:]+/g, "");
}

const KEYWORD_CATEGORY_ALIASES = new Map<string, KeywordCategoryKey>(
  [
    [
      "industry",
      [
        "industry",
        "ranking",
        "industry_ranking",
        "行业排名词",
        "行业排名",
        "行业",
        "行业问题",
        "行业词",
        "品类行业词",
        "行业品类词",
        "品类词",
      ],
    ],
    [
      "competitor_comparison",
      [
        "competitor",
        "competitor_comparison",
        "competitorcomparison",
        "comparison",
        "竞品对比词",
        "竞品对比",
        "竞品",
        "竞品问题",
        "竞品比较词",
        "竞品词",
        "对比词",
      ],
    ],
    [
      "reputation",
      [
        "reputation",
        "public_opinion",
        "美誉舆情词",
        "美誉舆情",
        "美誉词",
        "舆情词",
        "口碑",
        "品牌口碑",
        "口碑问题",
        "品牌核心词",
        "品牌核心",
        "品牌词",
      ],
    ],
    [
      "product_scenario",
      [
        "product_scenario",
        "productscenario",
        "product",
        "scenario",
        "basic",
        "产品场景词",
        "产品场景",
        "产品",
        "产品场景问题",
        "场景痛点词",
        "产品痛点词",
        "场景词",
        "痛点词",
      ],
    ],
  ].flatMap(([key, aliases]) =>
    (aliases as string[]).map(
      (alias) =>
        [
          normalizedKeywordCategoryToken(alias),
          key as KeywordCategoryKey,
        ] as const,
    ),
  ),
);

export function keywordCategoryKey(value: unknown): KeywordCategoryKey | null {
  return (
    KEYWORD_CATEGORY_ALIASES.get(normalizedKeywordCategoryToken(value)) ?? null
  );
}

export function keywordCategoryPalette(value: unknown) {
  const key = keywordCategoryKey(value);
  return key ? KEYWORD_CATEGORY_PALETTE[key] : null;
}

export function keywordCategoryTone(
  value: unknown,
): KeywordCategoryTone | null {
  return keywordCategoryPalette(value)?.tone ?? null;
}

export function keywordCategoryLabel(
  value: unknown,
): KeywordCategoryLabel | null {
  const key = keywordCategoryKey(value);
  return key ? CATEGORY_LABEL_BY_KEY[key] : null;
}

const KEYWORD_CATEGORY_HEADERS = new Set(
  [
    "核心词分类",
    "主分类",
    "关键词分类",
    "词分类",
    "分类",
    "核心词类型",
    "关键词类型",
    "词类型",
  ].map(normalizedKeywordCategoryToken),
);

export function isKeywordCategoryColumn(value: unknown) {
  return KEYWORD_CATEGORY_HEADERS.has(normalizedKeywordCategoryToken(value));
}

export function keywordCategoryColumnIndex(columns: readonly unknown[]) {
  const exactCoreCategoryIndex = columns.findIndex(
    (column) => normalizedKeywordCategoryToken(column) === "核心词分类",
  );
  return exactCoreCategoryIndex >= 0
    ? exactCoreCategoryIndex
    : columns.findIndex(isKeywordCategoryColumn);
}
