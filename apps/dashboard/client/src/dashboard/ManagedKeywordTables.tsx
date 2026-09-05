import { Database, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

export type ManagedKeywordTable = {
  id: string;
  title: string;
  description?: string | null;
  columns: string[];
  rows: unknown[][];
};

type ManagedKeywordTablesProps = {
  tables: ManagedKeywordTable[];
  loading?: boolean;
  error?: unknown;
  embedded?: boolean;
};

function safeText(value: unknown) {
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

function formatNumber(value: unknown) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function KeywordPageHeader({
  eyebrow,
  title,
  desc,
}: {
  eyebrow: string;
  title: string;
  desc: string;
}) {
  return (
    <header className="page-header">
      <span className="eyebrow">{safeText(eyebrow)}</span>
      <h2>{safeText(title)}</h2>
      <p>{safeText(desc)}</p>
    </header>
  );
}

function KeywordModuleEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="page-shell">
      <KeywordPageHeader
        eyebrow="MindPromise智诺"
        title={title}
        desc={description}
      />
      <section className="panel">
        <div className="panel-head">
          <h3>暂无已发布内容</h3>
        </div>
        <div className="empty-state">
          <Database size={24} />
          <p>{safeText(description)}</p>
        </div>
      </section>
    </section>
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
  embedded = false,
}: ManagedKeywordTablesProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [tableFilter, setTableFilter] = useState("all");
  const keyword = searchTerm.trim().toLowerCase();
  const visibleTables = useMemo(() => {
    const selectedTables =
      tableFilter === "all"
        ? tables
        : tables.filter((table) => table.id === tableFilter);
    if (!keyword) return selectedTables;
    return selectedTables
      .map((table) => ({
        ...table,
        rows: table.rows.filter((row) =>
          row.some((cell) => String(cell).toLowerCase().includes(keyword)),
        ),
      }))
      .filter(
        (table) =>
          table.title.toLowerCase().includes(keyword) ||
          table.columns.some((column) =>
            column.toLowerCase().includes(keyword),
          ) ||
          table.rows.length > 0,
      );
  }, [keyword, tableFilter, tables]);
  const totalRows = useMemo(
    () => tables.reduce((total, table) => total + table.rows.length, 0),
    [tables],
  );
  const visibleRows = useMemo(
    () => visibleTables.reduce((total, table) => total + table.rows.length, 0),
    [visibleTables],
  );

  if (loading) {
    return (
      <KeywordModuleEmpty
        title="品牌全域词库"
        description="正在载入当前企业已发布的词库数据。"
      />
    );
  }
  if (error) {
    return (
      <KeywordModuleEmpty
        title="品牌全域词库"
        description="当前企业词库暂时无法载入，请稍后刷新。"
      />
    );
  }

  return (
    <section className="page-shell brand-deep-page">
      {embedded ? (
        <div className="managed-keyword-heading">
          <span>品牌全域词库 / 正式词表</span>
          <h2>AI 监控与优化工程师发布的正式词表</h2>
          <p>品牌词、场景词、问题词与平台反馈数据会按交付工单持续同步。</p>
        </div>
      ) : (
        <KeywordPageHeader
          eyebrow="MindPromise智诺 / 品牌建设"
          title="品牌全域词库"
          desc="展示由管理员发布的品牌词、场景词、问题词与平台反馈数据。"
        />
      )}
      <div className="saas-toolbar keyword-toolbar-saas">
        <div className="saas-search">
          <Search size={16} />
          <input
            type="search"
            placeholder="搜索词库内容..."
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
        {tables.length > 1 && (
          <div className="filter-group">
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
        {visibleTables.map((table) => (
          <KeywordPanel
            title={table.title}
            key={table.id}
            actions={
              <span className="entity-count">
                {formatNumber(table.rows.length)} 条
              </span>
            }
          >
            {table.description && (
              <p className="panel-subtitle">{safeText(table.description)}</p>
            )}
            <div className="keyword-table-wrap">
              <table className="keyword-table">
                <thead>
                  <tr>
                    {table.columns.map((column) => (
                      <th key={column}>{safeText(column)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={`${table.id}-${rowIndex}`}>
                      {row.map((cell, cellIndex) => {
                        const column = String(table.columns[cellIndex] || "");
                        const normalizedColumn = column.replace(/\s+/g, "");
                        const value = safeText(cell);
                        const isCategory = normalizedColumn.includes("分类");
                        const isPriority = normalizedColumn.includes("优先级");
                        const isHeat = normalizedColumn.includes("热度");
                        const priorityTone = value.includes("高")
                          ? "high"
                          : value.includes("重点") || value.includes("中")
                            ? "mid"
                            : "low";
                        return (
                          <td
                            key={`${table.id}-${rowIndex}-${cellIndex}`}
                            className={
                              normalizedColumn.includes("问题")
                                ? "keyword-question-cell"
                                : undefined
                            }
                          >
                            {isCategory ? (
                              <span className="keyword-pill">{value}</span>
                            ) : isPriority ? (
                              <span
                                className={`priority-pill priority-${priorityTone}`}
                              >
                                {value}
                              </span>
                            ) : isHeat ? (
                              <strong>{value}</strong>
                            ) : (
                              value
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </KeywordPanel>
        ))}
        {visibleTables.length === 0 && (
          <KeywordModuleEmpty
            title="品牌全域词库"
            description={
              keyword
                ? "没有找到匹配的词库内容。"
                : "当前账号尚无已发布词库。管理员上传词库表格后会在这里展示。"
            }
          />
        )}
      </div>
    </section>
  );
}
