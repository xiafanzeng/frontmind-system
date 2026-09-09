import { useMemo, useState } from "react";
import {
  KEYWORD_CATEGORY_OPTIONS,
  keywordCategoryColumnIndex,
  keywordCategoryKey,
  keywordCategoryLabel,
  keywordTableDisplayText,
  type KeywordCategoryKey,
} from "@shared/keyword-categories";
import type { ManagedKeywordTable } from "../ManagedKeywordTables";
import { WorkflowPagination } from "./Workflow";

export type KeywordSelection = {
  dashboardRevision: number;
  tableId: string;
  rowIndex: number;
  question: string;
  category: KeywordCategoryKey;
};
export function keywordPickerRows(
  tables: ManagedKeywordTable[],
  revision: number,
): KeywordSelection[] {
  return tables.flatMap((table) => {
    const questionIndex = table.columns.findIndex(
      (column) => column.normalize("NFKC").replace(/\s/g, "") === "问题",
    );
    const categoryIndex = keywordCategoryColumnIndex(table.columns);
    if (questionIndex < 0 || categoryIndex < 0) return [];
    return table.rows.flatMap((row, rowIndex) => {
      const category = keywordCategoryKey(row[categoryIndex]);
      const question = keywordTableDisplayText(row[questionIndex]);
      return category && question
        ? [
            {
              dashboardRevision: revision,
              tableId: table.id,
              rowIndex,
              question,
              category,
            },
          ]
        : [];
    });
  });
}

/** A pure resource picker: its caller owns the task, confirmation and handoff. */
export function KeywordPicker({
  tables,
  revision,
  selected,
  onSelect,
  filters,
  onFiltersChange,
}: {
  tables: ManagedKeywordTable[];
  revision: number;
  selected?: KeywordSelection | null;
  onSelect: (selection: KeywordSelection) => void;
  filters?: { query: string; category: string; page: number };
  onFiltersChange?: (filters: {
    query: string;
    category: string;
    page: number;
  }) => void;
}) {
  const [local, setLocal] = useState({ query: "", category: "", page: 0 });
  const current = filters ?? local;
  const update = (next: typeof current) => {
    setLocal(next);
    onFiltersChange?.(next);
  };
  const rows = useMemo(
    () =>
      keywordPickerRows(tables, revision).filter(
        (row) =>
          (!current.category || row.category === current.category) &&
          row.question
            .toLocaleLowerCase()
            .includes(current.query.trim().toLocaleLowerCase()),
      ),
    [tables, revision, current.query, current.category],
  );
  const page = Math.min(
    current.page,
    Math.max(0, Math.ceil(rows.length / 10) - 1),
  );
  return (
    <div
      className="workflow-resource-picker"
      role="region"
      aria-label="品牌全域词库选择器"
    >
      <div className="workflow-fields">
        <label className="workflow-field">
          <span>搜索问题</span>
          <input
            type="search"
            value={current.query}
            onChange={(event) =>
              update({ ...current, query: event.target.value, page: 0 })
            }
            placeholder="输入关键词"
          />
        </label>
        <label className="workflow-field">
          <span>问题类别</span>
          <select
            value={current.category}
            onChange={(event) =>
              update({ ...current, category: event.target.value, page: 0 })
            }
          >
            <option value="">全部类别</option>
            {KEYWORD_CATEGORY_OPTIONS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="workflow-resource-list">
        {rows.slice(page * 10, (page + 1) * 10).map((row) => (
          <li key={`${row.tableId}:${row.rowIndex}`}>
            <button
              type="button"
              aria-pressed={
                selected?.dashboardRevision === revision &&
                selected.tableId === row.tableId &&
                selected.rowIndex === row.rowIndex
              }
              onClick={() => onSelect(row)}
            >
              {row.question}
              <small>
                {keywordCategoryLabel(row.category)} · 词库版本 {revision}
              </small>
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && (
        <p className="workflow-note">没有符合条件的问题，请调整筛选。</p>
      )}
      <WorkflowPagination
        page={page}
        total={rows.length}
        onChange={(page) => update({ ...current, page })}
      />
    </div>
  );
}
