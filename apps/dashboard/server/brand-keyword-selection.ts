import type { DashboardPayload } from "../shared/dashboard";
import {
  keywordCategoryColumnIndex,
  keywordCategoryKey,
  keywordTableDisplayText,
  type KeywordCategoryKey,
} from "../shared/keyword-categories";

export type BrandKeywordSelectionReference = {
  dashboardRevision: number;
  tableId: string;
  rowIndex: number;
};

export type ResolvedBrandKeywordSelection = {
  question: string;
  category: KeywordCategoryKey;
};

export type BrandKeywordSelectionResolution =
  | { ok: true; selection: ResolvedBrandKeywordSelection }
  | { ok: false; message: string };

function normalizedColumnName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

function questionColumnIndex(columns: readonly unknown[]) {
  return columns.findIndex((column) => normalizedColumnName(column) === "问题");
}

/**
 * Resolves a row only from the server-published Dashboard payload. The client
 * supplies an immutable revision and coordinates, never the trusted question
 * text or quota category.
 */
export function resolveBrandKeywordSelection(input: {
  workspace: { revision: number; payload: DashboardPayload };
  reference: BrandKeywordSelectionReference;
}): BrandKeywordSelectionResolution {
  if (input.workspace.revision !== input.reference.dashboardRevision) {
    return {
      ok: false,
      message: "品牌全域词库已更新，请刷新后重新选择。",
    };
  }

  const matchingTables = input.workspace.payload.keywordTables.filter(
    (candidate) => candidate.id === input.reference.tableId,
  );
  if (matchingTables.length !== 1) {
    return {
      ok: false,
      message:
        matchingTables.length === 0
          ? "所选品牌全域词库不存在，请刷新后重新选择。"
          : "品牌全域词库标识重复，请联系服务团队处理。",
    };
  }
  const table = matchingTables[0];
  const row = table.rows[input.reference.rowIndex];
  if (!row) {
    return {
      ok: false,
      message: "所选品牌全域词库问题不存在，请刷新后重新选择。",
    };
  }

  const questionIndex = questionColumnIndex(table.columns);
  const categoryIndex = keywordCategoryColumnIndex(table.columns);
  if (questionIndex < 0 || categoryIndex < 0) {
    return {
      ok: false,
      message: "品牌全域词库缺少问题或分类列，请联系服务团队处理。",
    };
  }
  const question = keywordTableDisplayText(row[questionIndex]);
  if (question.length < 2 || question.length > 4_000) {
    return {
      ok: false,
      message: "品牌全域词库中的问题内容无效，请联系服务团队处理。",
    };
  }
  const category = keywordCategoryKey(row[categoryIndex]);
  if (!category) {
    return {
      ok: false,
      message: "品牌全域词库中的问题类型无法识别，请联系服务团队处理。",
    };
  }

  return { ok: true, selection: { question, category } };
}
