import type { DashboardPayload } from "../shared/dashboard";
import { dashboardTableSchema } from "../shared/dashboard";
import {
  KEYWORD_CATEGORY_OPTIONS,
  keywordCategoryColumnIndex,
  keywordCategoryLabel,
} from "../shared/keyword-categories";

export type KeywordImportCategoryCount = Record<
  (typeof KEYWORD_CATEGORY_OPTIONS)[number]["label"],
  number
>;

function normalizedKeywordHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "");
}

export function normalizeImportedKeywordTables(
  tables: DashboardPayload["keywordTables"],
) {
  if (tables.length === 0) {
    throw new Error("上传文件中没有可导入的品牌全域词库数据");
  }
  return tables.map((table) => {
    const normalizedColumns = table.columns.map(normalizedKeywordHeader);
    const missingColumns = ["问题", "核心词"].filter(
      (column) => !normalizedColumns.includes(column),
    );
    const categoryColumnIndex = keywordCategoryColumnIndex(table.columns);
    if (categoryColumnIndex < 0) missingColumns.push("核心词分类");
    if (missingColumns.length > 0) {
      throw new Error(
        `词表“${table.title}”缺少必需列：${missingColumns.join("、")}。请使用“问题、核心词、核心词分类”表头。`,
      );
    }

    const unknownCategories = new Set<string>();
    const rows = table.rows.map((row, rowIndex) => {
      const sourceCategory = String(row[categoryColumnIndex] ?? "").trim();
      const mappedCategory = keywordCategoryLabel(sourceCategory);
      if (!mappedCategory) {
        unknownCategories.add(
          `第 ${rowIndex + 2} 行${
            sourceCategory ? `“${sourceCategory}”` : "（分类为空）"
          }`,
        );
        return row;
      }
      return row.map((cell, cellIndex) =>
        cellIndex === categoryColumnIndex ? mappedCategory : cell,
      );
    });

    if (unknownCategories.size > 0) {
      throw new Error(
        `词表“${table.title}”包含无法映射的核心词分类：${[...unknownCategories]
          .slice(0, 8)
          .join("、")}。支持映射为：${KEYWORD_CATEGORY_OPTIONS.map(
          (category) => category.label,
        ).join("、")}。`,
      );
    }

    return dashboardTableSchema.parse({ ...table, rows });
  });
}

export function importedKeywordCategoryCounts(
  tables: DashboardPayload["keywordTables"],
): KeywordImportCategoryCount | null {
  const counts = Object.fromEntries(
    KEYWORD_CATEGORY_OPTIONS.map((category) => [category.label, 0]),
  ) as KeywordImportCategoryCount;
  let categorizedRows = 0;
  for (const table of tables) {
    const categoryColumnIndex = keywordCategoryColumnIndex(table.columns);
    if (categoryColumnIndex < 0) continue;
    for (const row of table.rows) {
      const label = keywordCategoryLabel(row[categoryColumnIndex]);
      if (!label) continue;
      counts[label] += 1;
      categorizedRows += 1;
    }
  }
  return categorizedRows > 0 ? counts : null;
}
