import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import "./citation-data-workbench.css";
import type {
  ContentCitationRow,
  MediaCitationRow,
  QuestionCitationRow,
} from "./citationDistributionData";

export type {
  ContentCitationRow,
  MediaCitationRow,
  QuestionCitationRow,
} from "./citationDistributionData";

type CitationDataWorkbenchProps = {
  questionRows: readonly QuestionCitationRow[];
  contentRows: readonly ContentCitationRow[];
  mediaRows: readonly MediaCitationRow[];
  modelLabels?: Readonly<Record<string, string>>;
};

type TabKey = "questions" | "content" | "media";
type CellValue = string | number;
type WorkbenchRow = {
  id: string;
  values: Record<string, CellValue>;
};
type Column = {
  key: string;
  label: string;
  className?: string;
  align?: "left" | "right";
  render?: (row: WorkbenchRow) => ReactNode;
};
type FilterDefinition = {
  key: string;
  label: string;
  optionLabel?: (value: string) => string;
};
type SortState = {
  key: string;
  direction: "asc" | "desc";
};

const DEFAULT_MODEL_LABELS: Readonly<Record<string, string>> = {
  baiduai: "百度 AI",
  yuanbao: "腾讯元宝",
  doubao: "豆包",
  qianwen: "通义千问",
  deepseek: "DeepSeek",
};

const PAGE_SIZES = [25, 50, 100] as const;

const TAB_META: ReadonlyArray<{
  key: TabKey;
  label: string;
  description: string;
}> = [
  {
    key: "questions",
    label: "问题引用",
    description: "按问题、模型与信源查看每一条引用记录",
  },
  {
    key: "content",
    label: "内容引用",
    description: "查看去重内容及其累计引用表现",
  },
  {
    key: "media",
    label: "媒体引用",
    description: "查看每个媒体域名的引用次数与占比",
  },
];

const DEFAULT_SORT: Record<TabKey, SortState> = {
  questions: { key: "date", direction: "desc" },
  content: { key: "citations", direction: "desc" },
  media: { key: "citations", direction: "desc" },
};

const FILTERS: Record<TabKey, FilterDefinition[]> = {
  questions: [
    { key: "model", label: "全部模型" },
    { key: "question", label: "全部问题" },
    { key: "media", label: "全部媒体" },
  ],
  content: [
    { key: "media", label: "全部媒体" },
    { key: "domain", label: "全部域名" },
  ],
  media: [
    { key: "media", label: "全部媒体" },
    { key: "domain", label: "全部域名" },
  ],
};

const numberFormatter = new Intl.NumberFormat("zh-CN");

function text(value: CellValue | undefined) {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function normalizeSearch(value: CellValue | undefined) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

function ArticleLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  if (!href) return <span className="citation-workbench-empty">—</span>;

  return (
    <a
      className="citation-workbench-title-link"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

function getPageNumbers(currentPage: number, totalPages: number) {
  const count = Math.min(5, totalPages);
  const start = Math.max(1, Math.min(currentPage - 2, totalPages - count + 1));
  return Array.from({ length: count }, (_, index) => start + index);
}

export default function CitationDataWorkbench({
  questionRows,
  contentRows,
  mediaRows,
  modelLabels = DEFAULT_MODEL_LABELS,
}: CitationDataWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("questions");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortByTab, setSortByTab] =
    useState<Record<TabKey, SortState>>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);

  const rowCounts: Record<TabKey, number> = {
    questions: questionRows.length,
    content: contentRows.length,
    media: mediaRows.length,
  };

  const rows = useMemo<WorkbenchRow[]>(() => {
    if (activeTab === "questions") {
      return questionRows.map((row, index) => ({
        id: `question-${index}-${row[3]}`,
        values: {
          model: row[0],
          question: row[1],
          title: row[2],
          url: row[3],
          media: row[4],
          date: row[5],
        },
      }));
    }
    if (activeTab === "content") {
      return contentRows.map((row, index) => ({
        id: `content-${index}-${row[3]}`,
        values: {
          title: row[0],
          media: row[1],
          domain: row[2],
          url: row[3],
          citations: row[4],
          share: row[5],
        },
      }));
    }
    return mediaRows.map((row, index) => ({
      id: `media-${index}-${row[0]}`,
      values: {
        domain: row[0],
        media: row[1],
        citations: row[2],
        share: row[3],
      },
    }));
  }, [activeTab, contentRows, mediaRows, questionRows]);

  const columns = useMemo<Column[]>(() => {
    if (activeTab === "questions") {
      return [
        {
          key: "model",
          label: "AI 模型",
          className: "citation-workbench-model-column",
          render: (row) => (
            <span className="citation-workbench-model-pill">
              {text(modelLabels[text(row.values.model)] ?? row.values.model)}
            </span>
          ),
        },
        {
          key: "question",
          label: "监控问题",
          className: "citation-workbench-question-column",
        },
        {
          key: "title",
          label: "引用内容",
          className: "citation-workbench-title-column",
          render: (row) => (
            <ArticleLink
              href={text(row.values.url) === "—" ? "" : text(row.values.url)}
            >
              {text(row.values.title)}
            </ArticleLink>
          ),
        },
        { key: "media", label: "媒体信源" },
        { key: "date", label: "引用日期" },
      ];
    }
    if (activeTab === "content") {
      return [
        {
          key: "title",
          label: "引用内容",
          className: "citation-workbench-title-column",
          render: (row) => (
            <ArticleLink
              href={text(row.values.url) === "—" ? "" : text(row.values.url)}
            >
              {text(row.values.title)}
            </ArticleLink>
          ),
        },
        { key: "media", label: "媒体信源" },
        { key: "domain", label: "域名" },
        {
          key: "citations",
          label: "引用次数",
          align: "right",
          render: (row) => (
            <strong className="citation-workbench-number">
              {numberFormatter.format(Number(row.values.citations) || 0)}
            </strong>
          ),
        },
        { key: "share", label: "引用占比", align: "right" },
      ];
    }
    return [
      {
        key: "domain",
        label: "域名",
        className: "citation-workbench-domain-column",
      },
      { key: "media", label: "媒体信源" },
      {
        key: "citations",
        label: "引用次数",
        align: "right",
        render: (row) => (
          <strong className="citation-workbench-number">
            {numberFormatter.format(Number(row.values.citations) || 0)}
          </strong>
        ),
      },
      { key: "share", label: "引用占比", align: "right" },
    ];
  }, [activeTab, modelLabels]);

  const filterDefinitions = FILTERS[activeTab].map((filter) =>
    filter.key === "model"
      ? {
          ...filter,
          optionLabel: (value: string) => modelLabels[value] || value,
        }
      : filter,
  );

  const filterOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const filter of FILTERS[activeTab]) {
      options[filter.key] = Array.from(
        new Set(
          rows
            .map((row) => text(row.values[filter.key]))
            .filter((value) => value !== "—"),
        ),
      ).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
    }
    return options;
  }, [activeTab, rows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    return rows.filter((row) => {
      if (
        normalizedQuery &&
        !Object.values(row.values).some((value) =>
          normalizeSearch(value).includes(normalizedQuery),
        )
      ) {
        return false;
      }
      return FILTERS[activeTab].every((filter) => {
        const selected = filters[filter.key];
        return !selected || text(row.values[filter.key]) === selected;
      });
    });
  }, [activeTab, filters, query, rows]);

  const sortState = sortByTab[activeTab];
  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((left, right) => {
      const leftValue = left.values[sortState.key];
      const rightValue = right.values[sortState.key];
      const comparison =
        typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : text(leftValue).localeCompare(text(rightValue), "zh-CN", {
              numeric: true,
              sensitivity: "base",
            });
      return sortState.direction === "asc" ? comparison : -comparison;
    });
  }, [filteredRows, sortState]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = sortedRows.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const rangeStart = sortedRows.length ? (safePage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(safePage * pageSize, sortedRows.length);

  useEffect(() => {
    setPage(1);
  }, [activeTab, filters, pageSize, query]);

  function selectTab(tab: TabKey) {
    setActiveTab(tab);
    setQuery("");
    setFilters({});
  }

  function toggleSort(key: string) {
    setSortByTab((current) => {
      const activeSort = current[activeTab];
      return {
        ...current,
        [activeTab]: {
          key,
          direction:
            activeSort.key === key && activeSort.direction === "desc"
              ? "asc"
              : "desc",
        },
      };
    });
  }

  const activeMeta =
    TAB_META.find((tab) => tab.key === activeTab) || TAB_META[0];

  return (
    <section className="citation-data-workbench" aria-label="渠道分发全量数据">
      <header className="citation-workbench-header">
        <div>
          <span className="citation-workbench-eyebrow">全量数据视图</span>
          <h2>信源引用记录</h2>
          <p>{activeMeta.description}</p>
        </div>
        <div className="citation-workbench-total">
          <span>当前数据集</span>
          <strong>{numberFormatter.format(rowCounts[activeTab])}</strong>
          <small>条原始记录</small>
        </div>
      </header>

      <div
        className="citation-workbench-tabs"
        role="tablist"
        aria-label="引用数据类型"
      >
        {TAB_META.map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab.key}
            aria-label={`${tab.label} ${numberFormatter.format(rowCounts[tab.key])} 条`}
            aria-selected={activeTab === tab.key}
            className={activeTab === tab.key ? "active" : ""}
            onClick={() => selectTab(tab.key)}
          >
            <span>{tab.label}</span>
            <b>{numberFormatter.format(rowCounts[tab.key])}</b>
          </button>
        ))}
      </div>

      <div className="citation-workbench-toolbar">
        <label className="citation-workbench-search">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">搜索当前引用记录</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              activeTab === "questions"
                ? "搜索问题、文章标题、媒体或链接"
                : activeTab === "content"
                  ? "搜索内容标题、媒体、域名或链接"
                  : "搜索媒体或域名"
            }
          />
          {query && (
            <button type="button" onClick={() => setQuery("")}>
              清除
            </button>
          )}
        </label>

        <div className="citation-workbench-filters">
          <SlidersHorizontal aria-hidden="true" size={16} />
          {filterDefinitions.map((filter) => (
            <label key={filter.key}>
              <span className="sr-only">{filter.label}</span>
              <select
                aria-label={filter.label}
                value={filters[filter.key] || ""}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [filter.key]: event.target.value,
                  }))
                }
              >
                <option value="">{filter.label}</option>
                {(filterOptions[filter.key] || []).map((option) => (
                  <option value={option} key={option}>
                    {filter.optionLabel?.(option) || option}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="citation-workbench-result-bar" aria-live="polite">
        <span>
          {Object.values(filters).some(Boolean) || query
            ? `筛选出 ${numberFormatter.format(sortedRows.length)} 条`
            : `共 ${numberFormatter.format(sortedRows.length)} 条`}
        </span>
        <small>
          当前显示第 {numberFormatter.format(rangeStart)}–
          {numberFormatter.format(rangeEnd)} 条
        </small>
      </div>

      <div className="citation-workbench-table-frame">
        <table>
          <thead>
            <tr>
              <th className="citation-workbench-index-column">序号</th>
              {columns.map((column) => {
                const isActiveSort = sortState.key === column.key;
                return (
                  <th
                    key={column.key}
                    className={column.className}
                    aria-sort={
                      isActiveSort
                        ? sortState.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className={column.align === "right" ? "align-right" : ""}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.label}
                      {isActiveSort ? (
                        sortState.direction === "asc" ? (
                          <ArrowUp aria-hidden="true" size={13} />
                        ) : (
                          <ArrowDown aria-hidden="true" size={13} />
                        )
                      ) : (
                        <ArrowUpDown aria-hidden="true" size={13} />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={row.id}>
                <td className="citation-workbench-index-column">
                  {numberFormatter.format(
                    (safePage - 1) * pageSize + rowIndex + 1,
                  )}
                </td>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={[
                      column.className,
                      column.align === "right" ? "align-right" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {column.render
                      ? column.render(row)
                      : text(row.values[column.key])}
                  </td>
                ))}
              </tr>
            ))}
            {!visibleRows.length && (
              <tr>
                <td
                  className="citation-workbench-empty-state"
                  colSpan={columns.length + 1}
                >
                  没有找到符合当前条件的记录，请调整搜索词或筛选条件。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="citation-workbench-pagination">
        <label>
          <span>每页</span>
          <select
            aria-label="每页记录数"
            value={pageSize}
            onChange={(event) =>
              setPageSize(
                Number(event.target.value) as (typeof PAGE_SIZES)[number],
              )
            }
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </select>
        </label>

        <span className="citation-workbench-page-summary">
          第 {numberFormatter.format(safePage)} /{" "}
          {numberFormatter.format(totalPages)} 页
        </span>

        <nav aria-label="引用记录分页">
          <button
            type="button"
            aria-label="第一页"
            disabled={safePage === 1}
            onClick={() => setPage(1)}
          >
            <ChevronsLeft aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label="上一页"
            disabled={safePage === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </button>
          {getPageNumbers(safePage, totalPages).map((pageNumber) => (
            <button
              type="button"
              key={pageNumber}
              aria-label={`第 ${pageNumber} 页`}
              aria-current={safePage === pageNumber ? "page" : undefined}
              className={safePage === pageNumber ? "active" : ""}
              onClick={() => setPage(pageNumber)}
            >
              {pageNumber}
            </button>
          ))}
          <button
            type="button"
            aria-label="下一页"
            disabled={safePage === totalPages}
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
          >
            <ChevronRight aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label="最后一页"
            disabled={safePage === totalPages}
            onClick={() => setPage(totalPages)}
          >
            <ChevronsRight aria-hidden="true" size={16} />
          </button>
        </nav>
      </footer>
    </section>
  );
}
