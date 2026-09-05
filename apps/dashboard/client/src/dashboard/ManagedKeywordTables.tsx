import { Database, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  KEYWORD_CATEGORY_OPTIONS,
  isKeywordCategoryColumn,
  keywordCategoryColumnIndex,
  keywordCategoryKey,
  keywordCategoryLabel,
  keywordTableDisplayText as safeText,
  type KeywordCategoryKey,
} from "@shared/keyword-categories";
import { trpc } from "@/lib/trpc";

export type ManagedKeywordTable = {
  id: string;
  title: string;
  description?: string | null;
  columns: string[];
  rows: unknown[][];
};

export type ManagedKeywordQuotaAvailability = Partial<
  Record<
    KeywordCategoryKey,
    {
      available: boolean;
      unavailableLabel?: string;
    }
  >
>;

type ManagedKeywordTablesProps = {
  tables: ManagedKeywordTable[];
  loading?: boolean;
  error?: unknown;
  onUseQuestion?: (question: {
    question: string;
    category: KeywordCategoryKey;
    tableId: string;
    rowIndex: number;
  }) => void;
  quotaAvailability?: ManagedKeywordQuotaAvailability;
  generationEnabled?: boolean;
};

const KEYWORD_SOURCE_DESCRIPTION =
  "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。";

function normalizedColumnName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "");
}

function isHiddenCustomerColumn(value: unknown) {
  const column = normalizedColumnName(value);
  return (
    column === "序号" ||
    column === "核心词" ||
    column === "创建日期" ||
    column.includes("热度")
  );
}

function questionColumnIndex(columns: readonly unknown[]) {
  return columns.findIndex((column) => normalizedColumnName(column) === "问题");
}

function formatNumber(value: unknown) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed.toLocaleString("zh-CN") : "";
}

function questionSubdivisionColumnIndex(columns: readonly unknown[]) {
  return columns.findIndex(
    (column) => normalizedColumnName(column) === "问题细分",
  );
}

function keywordDisplayColumns(columns: readonly string[]) {
  return columns
    .map((column, columnIndex) => ({ column, columnIndex }))
    .filter(({ column }) => !isHiddenCustomerColumn(column));
}

function KeywordPageHeader({
  eyebrow,
  title,
  desc,
  actions,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="eyebrow">{safeText(eyebrow)}</span>
          <h2>{safeText(title)}</h2>
          <p>{safeText(desc)}</p>
        </div>
        {actions}
      </div>
    </header>
  );
}

function KeywordEmptyPanel({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{safeText(title)}</h3>
      </div>
      <div className="empty-state">
        <Database size={24} />
        <p>{safeText(description)}</p>
        {actions}
      </div>
    </section>
  );
}

function brandQuestionUniverseStatus(
  observation:
    | {
        reason: string;
        operation: {
          status: string;
          repairAttempts: number;
          publicationOutcome: string | null;
        } | null;
      }
    | undefined,
) {
  if (!observation) return "正在检查抓取条件…";
  const operation = observation.operation;
  if (operation?.status === "queued") return "任务已排队，正在上传安全知识包。";
  if (operation?.status === "running") {
    return operation.repairAttempts > 0
      ? `正在修复并校验结果（${operation.repairAttempts}/3）。`
      : "正在抓取并生成 160 条品牌问题。";
  }
  if (operation?.status === "result_pending")
    return "结果已返回，正在校验和发布。";
  if (operation?.status === "succeeded") {
    if (operation.publicationOutcome === "engineer_won") {
      return "工程师正式版本已生效，自动结果未覆盖。";
    }
    if (operation.publicationOutcome === "newer_auto_won") {
      return "更新的自动版本已生效，本次结果未覆盖。";
    }
    if (operation.publicationOutcome === "snapshot_superseded") {
      return "知识库已更新，本次结果未发布；可重新抓取。";
    }
    return "品牌全域词库已生成并发布。";
  }
  if (operation?.status === "failed") return "本次抓取未完成，请重试。";
  if (operation?.status === "attention_required") {
    return "任务需要人工检查，请联系 FrontMind 支持。";
  }
  if (observation.reason === "knowledge_required")
    return "请先完成并发布当前认证知识库。";
  if (observation.reason === "safe_knowledge_required")
    return "当前认证知识库没有可用于词库生成的公开内容。";
  if (observation.reason === "knowledge_scope_exceeded")
    return "当前知识库超过自动处理范围，请联系 FrontMind 协助。";
  if (observation.reason === "credential_required")
    return "自动生成服务尚未就绪，请联系 FrontMind。";
  if (observation.reason === "engineer_version")
    return "工程师正式版本已发布，自动抓取已停用。";
  if (observation.reason === "operation_active")
    return "品牌全域词库正在抓取。";
  return "已就绪，可基于当前知识库抓取品牌全域词库。";
}

function BrandQuestionUniverseGenerationControl() {
  const utils = trpc.useUtils();
  const observation = trpc.workspace.brandQuestionUniverse.observe.useQuery(
    undefined,
    { refetchInterval: 5_000, refetchOnWindowFocus: true },
  );
  const start = trpc.workspace.brandQuestionUniverse.start.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.workspace.brandQuestionUniverse.observe.invalidate(),
        utils.workspace.dashboard.invalidate(),
      ]);
    },
  });
  const data = observation.data;
  const disabled = !data?.canStart || start.isPending;
  const status =
    start.error?.message ||
    observation.error?.message ||
    brandQuestionUniverseStatus(data);
  return (
    <BrandQuestionUniverseGenerationAction
      disabled={disabled}
      status={status}
      onStart={() => {
        if (!data?.knowledgeSnapshotId) return;
        start.mutate({
          knowledgeSnapshotId: data.knowledgeSnapshotId,
          clientRequestId: crypto.randomUUID(),
          expectedDashboardRevision: data.dashboardRevision,
        });
      }}
    />
  );
}

export function BrandQuestionUniverseGenerationAction({
  disabled,
  status,
  onStart,
}: {
  disabled: boolean;
  status: string;
  onStart: () => void;
}) {
  return (
    <div className="flex max-w-md flex-col items-start gap-2">
      <button
        type="button"
        className="keyword-optimize-button disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={onStart}
      >
        抓取品牌全域词库
      </button>
      <span className="text-xs text-slate-500" role="status">
        {safeText(status)}
      </span>
    </div>
  );
}

function KeywordPanel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <section className="panel global-keyword-panel">
      <div className="panel-head">
        <h3>{safeText(title)}</h3>
        <div className="panel-actions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export default function ManagedKeywordTables({
  tables,
  loading = false,
  error,
  onUseQuestion,
  quotaAvailability,
  generationEnabled = false,
}: ManagedKeywordTablesProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [tableFilter, setTableFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [subdivisionFilter, setSubdivisionFilter] = useState("all");
  const keyword = searchTerm.trim().toLowerCase();
  const hasKeywordCategories = useMemo(
    () =>
      tables.some((table) => {
        const categoryColumnIndex = keywordCategoryColumnIndex(table.columns);
        return (
          categoryColumnIndex >= 0 &&
          table.rows.some((row) =>
            Boolean(keywordCategoryKey(row[categoryColumnIndex])),
          )
        );
      }),
    [tables],
  );
  const subdivisionOptions = useMemo(
    () =>
      [
        ...new Set(
          tables.flatMap((table) => {
            const subdivisionIndex = questionSubdivisionColumnIndex(
              table.columns,
            );
            return subdivisionIndex < 0
              ? []
              : table.rows
                  .map((row) => safeText(row[subdivisionIndex]))
                  .filter(Boolean);
          }),
        ),
      ].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [tables],
  );
  const visibleTables = useMemo(() => {
    const selectedTables =
      tableFilter === "all"
        ? tables
        : tables.filter((table) => table.id === tableFilter);
    return selectedTables
      .map((table) => {
        const categoryColumnIndex = keywordCategoryColumnIndex(table.columns);
        const subdivisionColumnIndex = questionSubdivisionColumnIndex(
          table.columns,
        );
        const displayColumns = keywordDisplayColumns(table.columns);
        const rows = table.rows
          .map((row, rowIndex) => ({ row, rowIndex }))
          .filter(({ row }) => {
            if (
              categoryFilter !== "all" &&
              (categoryColumnIndex < 0 ||
                keywordCategoryKey(row[categoryColumnIndex]) !== categoryFilter)
            ) {
              return false;
            }
            if (
              subdivisionFilter !== "all" &&
              (subdivisionColumnIndex < 0 ||
                safeText(row[subdivisionColumnIndex]) !== subdivisionFilter)
            ) {
              return false;
            }
            if (!keyword) return true;
            return displayColumns.some(({ columnIndex }) => {
              const cell = row[columnIndex];
              const text = String(cell).toLowerCase();
              const mappedCategory =
                columnIndex === categoryColumnIndex
                  ? keywordCategoryLabel(cell)?.toLowerCase()
                  : null;
              return (
                text.includes(keyword) ||
                Boolean(mappedCategory?.includes(keyword))
              );
            });
          });
        return { ...table, rows, displayColumns };
      })
      .filter(
        (table) =>
          (!keyword &&
            categoryFilter === "all" &&
            subdivisionFilter === "all") ||
          table.rows.length > 0,
      );
  }, [categoryFilter, keyword, subdivisionFilter, tableFilter, tables]);
  const totalRows = useMemo(
    () => tables.reduce((total, table) => total + table.rows.length, 0),
    [tables],
  );
  const visibleRows = useMemo(
    () => visibleTables.reduce((total, table) => total + table.rows.length, 0),
    [visibleTables],
  );

  return (
    <section className="page-shell brand-deep-page">
      <KeywordPageHeader
        eyebrow="MindPromise智诺 / 品牌建设"
        title="品牌全域词库"
        desc={KEYWORD_SOURCE_DESCRIPTION}
      />
      {loading ? (
        <KeywordEmptyPanel
          title="正在载入品牌全域词库"
          description="正在载入当前企业的词库数据。"
        />
      ) : error ? (
        <KeywordEmptyPanel
          title="品牌全域词库暂时无法载入"
          description="请稍后刷新页面重试。"
        />
      ) : tables.length === 0 ? (
        <KeywordEmptyPanel
          title="品牌全域词库正在准备中"
          description="内容发布后会自动显示在这里。"
          actions={
            generationEnabled ? (
              <BrandQuestionUniverseGenerationControl />
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="saas-toolbar keyword-toolbar-saas">
            <div className="saas-search">
              <Search size={16} />
              <input
                type="search"
                placeholder="搜索问题、主分类或问题细分..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
              {searchTerm && (
                <button
                  type="button"
                  className="clear-btn"
                  aria-label="清空搜索"
                  onClick={() => setSearchTerm("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {(tables.length > 1 ||
              hasKeywordCategories ||
              subdivisionOptions.length > 0) && (
              <div className="filter-group">
                {hasKeywordCategories && (
                  <div className="filter-item">
                    <label htmlFor="managed-keyword-category">主分类</label>
                    <select
                      id="managed-keyword-category"
                      value={categoryFilter}
                      onChange={(event) =>
                        setCategoryFilter(event.target.value)
                      }
                    >
                      <option value="all">全部主分类</option>
                      {KEYWORD_CATEGORY_OPTIONS.map((category) => (
                        <option key={category.key} value={category.key}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {subdivisionOptions.length > 0 && (
                  <div className="filter-item">
                    <label htmlFor="managed-keyword-subdivision">
                      问题细分
                    </label>
                    <select
                      id="managed-keyword-subdivision"
                      value={subdivisionFilter}
                      onChange={(event) =>
                        setSubdivisionFilter(event.target.value)
                      }
                    >
                      <option value="all">全部问题细分</option>
                      {subdivisionOptions.map((subdivision) => (
                        <option key={subdivision} value={subdivision}>
                          {subdivision}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {tables.length > 1 && (
                  <div className="filter-item">
                    <label htmlFor="managed-keyword-table">词表</label>
                    <select
                      id="managed-keyword-table"
                      value={tableFilter}
                      onChange={(event) => setTableFilter(event.target.value)}
                    >
                      <option value="all">全部词表</option>
                      {tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {safeText(table.title)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="keyword-stats-bar">
            <span>
              共 <strong>{formatNumber(totalRows)}</strong> 条词库记录
            </span>
            <span>
              当前显示 <strong>{formatNumber(visibleRows)}</strong> 条
            </span>
          </div>
          <div className="saas-content-area">
            {visibleTables.map((table) => {
              const tableQuestionColumnIndex = questionColumnIndex(
                table.columns,
              );
              const tableCategoryColumnIndex = keywordCategoryColumnIndex(
                table.columns,
              );
              return (
                <KeywordPanel
                  title={tables.length === 1 ? "全域词库" : table.title}
                  key={table.id}
                  actions={
                    <span className="entity-count">
                      {formatNumber(table.rows.length)} 条
                    </span>
                  }
                >
                  <div className="keyword-table-wrap">
                    <table className="keyword-table">
                      <thead>
                        <tr>
                          {table.displayColumns.map(
                            ({ column, columnIndex }) => (
                              <th key={`${column}-${columnIndex}`}>
                                {isKeywordCategoryColumn(column)
                                  ? "主分类"
                                  : safeText(column)}
                              </th>
                            ),
                          )}
                          {onUseQuestion && <th>问题优化</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map(({ row, rowIndex }) => {
                          const question = safeText(
                            row[tableQuestionColumnIndex],
                          );
                          const category = keywordCategoryKey(
                            row[tableCategoryColumnIndex],
                          );
                          const quotaAccess = category
                            ? quotaAvailability?.[category]
                            : undefined;
                          return (
                            <tr key={`${table.id}-${rowIndex}`}>
                              {table.displayColumns.map(
                                ({ column, columnIndex }) => {
                                  const normalizedColumn =
                                    normalizedColumnName(column);
                                  const value = safeText(row[columnIndex]);
                                  const isCategory =
                                    isKeywordCategoryColumn(column);
                                  const displayValue = isKeywordCategoryColumn(
                                    column,
                                  )
                                    ? keywordCategoryLabel(value) || value
                                    : value;
                                  const isPriority =
                                    normalizedColumn.includes("优先级");
                                  const priorityTone = value.includes("高")
                                    ? "high"
                                    : value.includes("重点") ||
                                        value.includes("中")
                                      ? "mid"
                                      : "low";
                                  return (
                                    <td
                                      key={`${table.id}-${rowIndex}-${columnIndex}`}
                                      className={
                                        normalizedColumn === "问题"
                                          ? "keyword-question-cell"
                                          : undefined
                                      }
                                    >
                                      {isCategory ? (
                                        <span
                                          className="keyword-pill fm-question-category-pill"
                                          data-category={category || undefined}
                                        >
                                          {displayValue}
                                        </span>
                                      ) : isPriority ? (
                                        <span
                                          className={`priority-pill priority-${priorityTone}`}
                                        >
                                          {displayValue}
                                        </span>
                                      ) : (
                                        displayValue
                                      )}
                                    </td>
                                  );
                                },
                              )}
                              {onUseQuestion && (
                                <td>
                                  <button
                                    type="button"
                                    className="keyword-optimize-button disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={
                                      !question ||
                                      !category ||
                                      quotaAccess?.available === false
                                    }
                                    onClick={() =>
                                      category &&
                                      onUseQuestion({
                                        question,
                                        category,
                                        tableId: table.id,
                                        rowIndex,
                                      })
                                    }
                                  >
                                    {quotaAccess?.available === false
                                      ? quotaAccess.unavailableLabel ||
                                        "该类额度已满"
                                      : "选择并进入问题优化"}
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </KeywordPanel>
              );
            })}
            {visibleTables.length === 0 && (
              <KeywordEmptyPanel
                title="没有匹配的词库内容"
                description="请调整搜索词或筛选条件后重试。"
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
