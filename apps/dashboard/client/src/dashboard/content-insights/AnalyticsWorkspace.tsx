import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  EMPTY_QA_FILTERS,
  QA_MODELS,
  articleRows,
  filterQa,
  overviewSeries,
  overviewTotals,
  searchRows,
  trafficRows,
  type Article,
  type QaFilters,
  type QaRecord,
} from "./analytics-data";
import {
  ExportMenu,
  HlButton,
  HlDialog,
  HlField,
  HlSelect,
  INITIAL_PERIOD,
  Pagination,
  PeriodControl,
  downloadCsv,
  type AnalyticsModule,
  type Period,
} from "./shared";
import "./analytics.css";

type SortState<K extends string> = { key: K; direction: "asc" | "desc" } | null;
type ArticleMetric = "pv" | "uv" | "likes" | "dislikes" | "feedback";

const articleMetrics: Array<{ key: ArticleMetric; label: string }> = [
  { key: "pv", label: "浏览数（PV）" },
  { key: "uv", label: "访问用户数（UV）" },
  { key: "likes", label: "点赞数" },
  { key: "dislikes", label: "点踩数" },
  { key: "feedback", label: "文章反馈数" },
];
const articleColumns = [
  "标题",
  ...articleMetrics.map((metric) => metric.label),
  "作者",
  "最近访问",
];
const chartMetrics = [
  { key: "pv", label: "站点浏览数（PV）", color: "#5470c6" },
  { key: "uv", label: "站点访问用户数（UV）", color: "#73c0b0" },
  { key: "likes", label: "点赞数", color: "#546570" },
  { key: "dislikes", label: "点踩数", color: "#e6bd4a" },
  { key: "feedback", label: "文章反馈数", color: "#8b78df" },
] as const;

function contains(value: string, query: string) {
  return value
    .toLocaleLowerCase("zh-CN")
    .includes(query.trim().toLocaleLowerCase("zh-CN"));
}

function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
): SortState<K> {
  if (current?.key !== key) return { key, direction: "desc" };
  return current.direction === "desc" ? { key, direction: "asc" } : null;
}

function SortHeading({
  label,
  direction,
  onClick,
}: {
  label: string;
  direction?: "asc" | "desc";
  onClick: () => void;
}) {
  const Icon =
    direction === "asc"
      ? ArrowUp
      : direction === "desc"
        ? ArrowDown
        : ChevronsUpDown;
  return (
    <button
      type="button"
      className={`hl-analytics-sort${direction ? " is-sorted" : ""}`}
      onClick={onClick}
      aria-label={`${label}排序`}
    >
      {label}
      <Icon size={13} aria-hidden="true" />
    </button>
  );
}

function EmptyRow({ columns }: { columns: number }) {
  return (
    <tr>
      <td colSpan={columns} className="hl-empty">
        暂无数据
      </td>
    </tr>
  );
}

function SelectionCheckbox({
  label,
  checked,
  partial = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  partial?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      aria-checked={partial ? "mixed" : checked}
      checked={checked}
      onChange={onChange}
    />
  );
}

function useTableRows<T extends { id: string }>(rows: T[]) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  const visible = rows.slice((safePage - 1) * size, safePage * size);
  const rowKeys = rows.map((row) => row.id).join("|");

  useEffect(() => {
    const allowed = new Set(rowKeys.split("|"));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rowKeys]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const all =
    visible.length > 0 && visible.every((row) => selected.has(row.id));
  const partial = !all && visible.some((row) => selected.has(row.id));
  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible)
        if (all) next.delete(row.id);
        else next.add(row.id);
      return next;
    });
  }
  return {
    page: safePage,
    setPage,
    size,
    setSize,
    visible,
    selected,
    toggle,
    all,
    partial,
    toggleAll,
  };
}

function PageHeading({
  title,
  period,
  onPeriod,
  active,
}: {
  title: string;
  period: Period;
  onPeriod: (period: Period) => void;
  active: boolean;
}) {
  return (
    <header className="hl-page-heading">
      <h2>{title}</h2>
      {active && <PeriodControl value={period} onChange={onPeriod} />}
    </header>
  );
}

function SectionHeading({
  children,
  onMore,
}: {
  children: ReactNode;
  onMore?: () => void;
}) {
  return (
    <div className="hl-analytics-section-heading">
      <h3>{children}</h3>
      {onMore && (
        <button type="button" onClick={onMore}>
          查看更多
        </button>
      )}
    </div>
  );
}

function ArticleValues({
  article,
  onOpen,
}: {
  article: Article;
  onOpen?: (article: Article) => void;
}) {
  return (
    <>
      <td>
        {onOpen ? (
          <button
            type="button"
            className="hl-article-title"
            onClick={() => onOpen(article)}
          >
            {article.title}
          </button>
        ) : (
          article.title
        )}
      </td>
      {articleMetrics.map((metric) => (
        <td key={metric.key}>{article[metric.key]}</td>
      ))}
      <td>{article.author}</td>
      <td>{article.lastVisited}</td>
    </>
  );
}

function OverviewPage({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate: (module: AnalyticsModule) => void;
}) {
  const [period, setPeriod] = useState<Period>(INITIAL_PERIOD);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const [searchNotice, setSearchNotice] = useState(false);
  const totals = useMemo(() => overviewTotals(period), [period]);
  const series = useMemo(() => overviewSeries(period), [period]);
  const popularArticles = useMemo(
    () =>
      articleRows(period)
        .sort((a, b) => b.pv - a.pv)
        .slice(0, 5),
    [period],
  );
  const popularSearches = useMemo(
    () =>
      searchRows(period)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    [period],
  );
  const sources = useMemo(
    () => trafficRows(period).sort((a, b) => b.clicks - a.clicks),
    [period],
  );
  const clicks = sources.reduce((sum, source) => sum + source.clicks, 0);
  const metrics = [
    { label: "站点浏览数（PV）", value: totals.pv },
    { label: "站点访问用户数（UV）", value: totals.uv },
    { label: "消耗流量数（MB）", value: totals.mb.toFixed(2) },
    { label: "点赞数", value: totals.likes },
    { label: "点踩数", value: totals.dislikes },
    { label: "文章反馈数", value: totals.feedback },
  ];

  return (
    <section
      className="hl-page hl-analytics hl-analytics-overview"
      aria-label="概览分析"
      hidden={!active}
    >
      <PageHeading
        title="汇总"
        period={period}
        onPeriod={setPeriod}
        active={active}
      />
      <div className="hl-summary-grid">
        {metrics.map((metric) => (
          <div className="hl-summary-card" key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
      <div
        className="hl-trend"
        aria-label={`按${period.unit === "day" ? "日" : "月"}统计的访问趋势`}
      >
        <div className="hl-trend-plot">
          {active && (
            <ResponsiveContainer width="100%" height="100%" minWidth={1}>
              <AreaChart
                data={series}
                margin={{ top: 12, right: 8, bottom: 8, left: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#e6e7eb" />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={26}
                  tick={{ fontSize: 11, fill: "#909399" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  tick={{ fontSize: 11, fill: "#909399" }}
                  allowDecimals={false}
                  domain={[0, "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    border: "1px solid #ebeef5",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#303133" }}
                />
                {chartMetrics.map((metric) => (
                  <Area
                    key={metric.key}
                    type="linear"
                    dataKey={metric.key}
                    name={metric.label}
                    stroke={metric.color}
                    strokeWidth={1.2}
                    fill={metric.color}
                    fillOpacity={0.045}
                    hide={hiddenSeries.has(metric.key)}
                    isAnimationActive={false}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="hl-trend-legend">
          {chartMetrics.map((metric) => (
            <button
              type="button"
              key={metric.key}
              aria-pressed={!hiddenSeries.has(metric.key)}
              onClick={() =>
                setHiddenSeries((current) => {
                  const next = new Set(current);
                  if (next.has(metric.key)) next.delete(metric.key);
                  else next.add(metric.key);
                  return next;
                })
              }
            >
              <i style={{ background: metric.color }} />
              {metric.label}
            </button>
          ))}
        </div>
      </div>

      <SectionHeading onMore={() => onNavigate("articles")}>
        热门文章
      </SectionHeading>
      <div className="hl-table-wrap">
        <table className="hl-table" aria-label="热门文章">
          <thead>
            <tr>
              {articleColumns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {popularArticles.length ? (
              popularArticles.map((article) => (
                <tr key={article.id}>
                  <ArticleValues article={article} />
                </tr>
              ))
            ) : (
              <EmptyRow columns={8} />
            )}
          </tbody>
        </table>
      </div>
      <SectionHeading onMore={() => setSearchNotice(true)}>
        热门搜索
      </SectionHeading>
      {searchNotice && (
        <p className="hl-search-scope-note" role="status">
          当前预览包含搜索汇总，暂不提供独立的搜索明细页面。
        </p>
      )}
      <div className="hl-table-wrap">
        <table className="hl-table" aria-label="热门搜索">
          <thead>
            <tr>
              {[
                "搜索词",
                "搜索次数",
                "搜索用户数",
                "搜索结果数",
                "最近搜索时间",
              ].map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {popularSearches.length ? (
              popularSearches.map((record) => (
                <tr key={record.id}>
                  <td>{record.term}</td>
                  <td>{record.count}</td>
                  <td>{record.users}</td>
                  <td>{record.results}</td>
                  <td>{record.lastSearched}</td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={5} />
            )}
          </tbody>
        </table>
      </div>
      <SectionHeading onMore={() => onNavigate("traffic-sources")}>
        热门流量来源
      </SectionHeading>
      <div className="hl-table-wrap">
        <table className="hl-table" aria-label="热门流量来源">
          <thead>
            <tr>
              <th>网站</th>
              <th>点击</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {sources.length ? (
              sources.slice(0, 5).map((source) => (
                <tr key={source.id}>
                  <td>{source.website}</td>
                  <td>{source.clicks}</td>
                  <td>
                    {(clicks ? (source.clicks / clicks) * 100 : 0).toFixed(2)}%
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={3} />
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ArticlesPage({ active }: { active: boolean }) {
  const [period, setPeriod] = useState<Period>(INITIAL_PERIOD);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<ArticleMetric>>(null);
  const [opened, setOpened] = useState<Article | null>(null);
  const articleTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) setOpened(null);
  }, [active]);
  const rows = useMemo(() => {
    const filtered = articleRows(period).filter((article) =>
      contains(article.title, query),
    );
    return sort
      ? filtered.sort(
          (a, b) =>
            (a[sort.key] - b[sort.key]) * (sort.direction === "asc" ? 1 : -1),
        )
      : filtered;
  }, [period, query, sort]);
  const table = useTableRows(rows);
  function changePeriod(next: Period) {
    setPeriod(next);
    table.setPage(1);
  }
  function exportRows(selectedOnly: boolean) {
    const exported = selectedOnly
      ? rows.filter((row) => table.selected.has(row.id))
      : rows;
    downloadCsv(
      "文章分析-本地演示.csv",
      articleColumns,
      exported.map((row) => [
        row.title,
        ...articleMetrics.map((metric) => row[metric.key]),
        row.author,
        row.lastVisited,
      ]),
    );
  }

  return (
    <section
      className="hl-page hl-analytics hl-analytics-articles"
      aria-label="文章分析"
      hidden={!active}
    >
      <PageHeading
        title="所有文章"
        period={period}
        onPeriod={changePeriod}
        active={active}
      />
      {active && (
        <form
          className="hl-analytics-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(keyword);
            table.setPage(1);
          }}
        >
          <HlField label="文章">
            <input
              className="hl-input"
              aria-label="文章关键词"
              placeholder="请输入"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </HlField>
          <HlButton type="submit" variant="plain">
            搜索
          </HlButton>
          <ExportMenu
            selectedCount={
              rows.filter((row) => table.selected.has(row.id)).length
            }
            onExport={exportRows}
          />
        </form>
      )}
      <div className="hl-table-wrap">
        <table className="hl-table hl-article-table" aria-label="文章统计">
          <colgroup>
            <col style={{ width: 55 }} />
            {articleColumns.map((column) => (
              <col key={column} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>
                <SelectionCheckbox
                  label="全选本页文章"
                  checked={table.all}
                  partial={table.partial}
                  onChange={table.toggleAll}
                />
              </th>
              <th>标题</th>
              {articleMetrics.map((metric) => (
                <th
                  key={metric.key}
                  aria-sort={
                    sort?.key === metric.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <SortHeading
                    label={metric.label}
                    direction={
                      sort?.key === metric.key ? sort.direction : undefined
                    }
                    onClick={() => {
                      setSort((current) => nextSort(current, metric.key));
                      table.setPage(1);
                    }}
                  />
                </th>
              ))}
              <th>作者</th>
              <th>最近访问</th>
            </tr>
          </thead>
          <tbody>
            {table.visible.length ? (
              table.visible.map((article) => (
                <tr key={article.id}>
                  <td>
                    <SelectionCheckbox
                      label={`选择文章 ${article.title}`}
                      checked={table.selected.has(article.id)}
                      onChange={() => table.toggle(article.id)}
                    />
                  </td>
                  <ArticleValues
                    article={article}
                    onOpen={(article) => {
                      articleTrigger.current =
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null;
                      setOpened(article);
                    }}
                  />
                </tr>
              ))
            ) : (
              <EmptyRow columns={9} />
            )}
          </tbody>
        </table>
      </div>
      {active && (
        <Pagination
          total={rows.length}
          page={table.page}
          size={table.size}
          onPage={table.setPage}
          onSize={table.setSize}
        />
      )}
      <HlDialog
        title="文章预览 · 本地演示"
        open={active && !!opened}
        onOpenChange={(open) => {
          if (!open) {
            setOpened(null);
            requestAnimationFrame(() => articleTrigger.current?.focus());
          }
        }}
      >
        {opened && (
          <article className="hl-article-preview">
            <h3>{opened.title}</h3>
            <p className="hl-article-byline">
              {opened.author} · {opened.lastVisited}
            </p>
            {opened.content
              .split("\n")
              .filter(Boolean)
              .map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
          </article>
        )}
      </HlDialog>
    </section>
  );
}

const qaColumns = [
  "问题",
  "回答",
  "来源",
  "模型",
  "渠道",
  "回答质量",
  "会话ID",
  "提问者",
  "时间",
  "操作",
];

function QaDetail({ record }: { record: QaRecord }) {
  return (
    <div className="hl-qa-detail">
      <div className="hl-qa-detail-answer">
        <h3>{record.question}</h3>
        {record.answer ? (
          record.answer
            .split("\n")
            .filter(Boolean)
            .map((paragraph, index) => <p key={index}>{paragraph}</p>)
        ) : (
          <p className="hl-text-muted">暂无回答</p>
        )}
      </div>
      <aside className="hl-qa-detail-sources" aria-label="当前回答来源">
        <div className="hl-qa-source-card">
          <h3>来源</h3>
          {record.sources.length ? (
            record.sources.map((source) => (
              <div className="hl-qa-source-item" key={source.url}>
                <strong>{source.title}</strong>
                <span>{source.url}</span>
                <span className="hl-source-demo">
                  <ExternalLink size={12} />
                  本地演示引用
                </span>
              </div>
            ))
          ) : (
            <p className="hl-text-muted">暂无引用来源</p>
          )}
        </div>
      </aside>
    </div>
  );
}

function QaPage({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<QaFilters>({ ...EMPTY_QA_FILTERS });
  const [filters, setFilters] = useState<QaFilters>({ ...EMPTY_QA_FILTERS });
  const [dateError, setDateError] = useState(false);
  const [opened, setOpened] = useState<QaRecord | null>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!active) setOpened(null);
  }, [active]);
  const rows = useMemo(() => filterQa(filters), [filters]);
  const table = useTableRows(rows);
  function update(key: keyof QaFilters, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setDateError(false);
  }
  const input = (key: keyof QaFilters, label: string) => (
    <HlField label={label}>
      <input
        className="hl-input"
        aria-label={label}
        placeholder="请输入"
        value={draft[key]}
        onChange={(event) => update(key, event.target.value)}
      />
    </HlField>
  );
  const select = (
    key: keyof QaFilters,
    label: string,
    options: readonly string[],
  ) => (
    <HlField label={label}>
      <HlSelect
        label={label}
        value={draft[key]}
        options={options}
        onChange={(value) => update(key, value)}
      />
    </HlField>
  );
  function exportRows(selectedOnly: boolean) {
    const exported = selectedOnly
      ? rows.filter((row) => table.selected.has(row.id))
      : rows;
    downloadCsv(
      "AI问答-本地演示.csv",
      qaColumns.slice(0, -1),
      exported.map((row) => [
        row.question,
        row.answer,
        row.sources.map((source) => source.title).join("；"),
        row.model,
        row.channel,
        row.quality,
        row.sessionId,
        row.asker,
        row.createdAt,
      ]),
    );
  }

  return (
    <section
      className="hl-page hl-analytics hl-analytics-qa"
      aria-label="AI问答分析"
      hidden={!active}
    >
      {active && (
        <form
          className="hl-analytics-filters hl-qa-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.from && draft.to && draft.from > draft.to) {
              setDateError(true);
              return;
            }
            setFilters({ ...draft });
            table.setPage(1);
            setDateError(false);
          }}
        >
          {input("asker", "提问者")}
          {select("channel", "渠道", ["全部", "AI搜索", "小部件", "API调用"])}
          {select("answerState", "回答筛选", ["全部", "有回答", "无回答"])}
          {input("question", "问题")}
          {input("answer", "回答")}
          {input("sessionId", "会话ID")}
          {select("model", "机器人模型", ["全部", ...QA_MODELS])}
          {select("internet", "是否开启联网搜索", ["全部", "是", "否"])}
          <div className="hl-qa-filter-actions">
            <HlField label="时间">
              <div
                className={`hl-qa-date-range${dateError ? " is-invalid" : ""}`}
              >
                <input
                  type="date"
                  aria-label="问答开始时间"
                  value={draft.from}
                  onChange={(event) => update("from", event.target.value)}
                />
                <span>至</span>
                <input
                  type="date"
                  aria-label="问答结束时间"
                  value={draft.to}
                  onChange={(event) => update("to", event.target.value)}
                />
              </div>
            </HlField>
            <HlButton type="submit" variant="plain">
              搜索
            </HlButton>
            <ExportMenu
              selectedCount={
                rows.filter((row) => table.selected.has(row.id)).length
              }
              onExport={exportRows}
            />
          </div>
          {dateError && (
            <p className="hl-error" role="alert">
              开始时间不能晚于结束时间。
            </p>
          )}
        </form>
      )}
      <div className="hl-table-wrap">
        <table className="hl-table hl-qa-table" aria-label="AI问答记录">
          <colgroup>
            <col style={{ width: 55 }} />
            {qaColumns.map((column) => (
              <col
                key={column}
                style={
                  column === "渠道"
                    ? { width: 120 }
                    : column === "时间"
                      ? { width: 180 }
                      : column === "操作"
                        ? { width: 100 }
                        : undefined
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>
                <SelectionCheckbox
                  label="全选本页问答"
                  checked={table.all}
                  partial={table.partial}
                  onChange={table.toggleAll}
                />
              </th>
              {qaColumns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.visible.length ? (
              table.visible.map((record) => (
                <tr key={record.id}>
                  <td>
                    <SelectionCheckbox
                      label={`选择问答 ${record.question}`}
                      checked={table.selected.has(record.id)}
                      onChange={() => table.toggle(record.id)}
                    />
                  </td>
                  <td>
                    <span className="hl-qa-clamp">{record.question}</span>
                  </td>
                  <td>
                    <span className="hl-qa-clamp">{record.answer || "—"}</span>
                  </td>
                  <td>
                    <span className="hl-qa-clamp">
                      {record.sources.map((source) => source.title).join("、")}
                    </span>
                  </td>
                  <td>{record.model}</td>
                  <td>{record.channel}</td>
                  <td>{record.quality}</td>
                  <td>
                    <span className="hl-qa-clamp">{record.sessionId}</span>
                  </td>
                  <td className="hl-qa-asker">{record.asker}</td>
                  <td>{record.createdAt}</td>
                  <td>
                    <HlButton
                      variant="link"
                      onClick={(event) => {
                        detailTrigger.current = event.currentTarget;
                        setOpened(record);
                      }}
                    >
                      查看
                    </HlButton>
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={11} />
            )}
          </tbody>
        </table>
      </div>
      {active && (
        <Pagination
          total={rows.length}
          page={table.page}
          size={table.size}
          onPage={table.setPage}
          onSize={table.setSize}
        />
      )}
      <HlDialog
        title="详情"
        wide
        open={active && !!opened}
        onOpenChange={(open) => {
          if (!open) {
            setOpened(null);
            requestAnimationFrame(() => detailTrigger.current?.focus());
          }
        }}
      >
        {opened && <QaDetail record={opened} />}
      </HlDialog>
    </section>
  );
}

function TrafficPage({ active }: { active: boolean }) {
  const [period, setPeriod] = useState<Period>(INITIAL_PERIOD);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<"clicks">>(null);
  const periodRows = useMemo(() => trafficRows(period), [period]);
  const totalClicks = periodRows.reduce(
    (sum, source) => sum + source.clicks,
    0,
  );
  const rows = useMemo(() => {
    const filtered = periodRows.filter((source) =>
      contains(source.website, query),
    );
    return sort
      ? filtered.sort(
          (a, b) => (a.clicks - b.clicks) * (sort.direction === "asc" ? 1 : -1),
        )
      : filtered;
  }, [periodRows, query, sort]);
  const table = useTableRows(rows);

  return (
    <section
      className="hl-page hl-analytics hl-analytics-traffic"
      aria-label="流量来源分析"
      hidden={!active}
    >
      <PageHeading
        title="流量来源"
        active={active}
        period={period}
        onPeriod={(next) => {
          setPeriod(next);
          table.setPage(1);
        }}
      />
      {active && (
        <form
          className="hl-analytics-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(keyword);
            table.setPage(1);
          }}
        >
          <HlField label="网站">
            <input
              className="hl-input"
              aria-label="网站关键词"
              placeholder="请输入"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </HlField>
          <HlButton type="submit" variant="plain">
            搜索
          </HlButton>
        </form>
      )}
      <div className="hl-table-wrap">
        <table className="hl-table" aria-label="流量来源统计">
          <thead>
            <tr>
              <th>网站</th>
              <th
                aria-sort={
                  sort
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                <SortHeading
                  label="点击"
                  direction={sort?.direction}
                  onClick={() => {
                    setSort((current) => nextSort(current, "clicks"));
                    table.setPage(1);
                  }}
                />
              </th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {table.visible.length ? (
              table.visible.map((source) => (
                <tr key={source.id}>
                  <td>{source.website}</td>
                  <td>{source.clicks}</td>
                  <td>
                    {(totalClicks
                      ? (source.clicks / totalClicks) * 100
                      : 0
                    ).toFixed(2)}
                    %
                  </td>
                </tr>
              ))
            ) : (
              <EmptyRow columns={3} />
            )}
          </tbody>
        </table>
      </div>
      {active && (
        <Pagination
          total={rows.length}
          page={table.page}
          size={table.size}
          onPage={table.setPage}
          onSize={table.setSize}
        />
      )}
    </section>
  );
}

export default function AnalyticsWorkspace({
  module,
  onNavigate,
  active = true,
}: {
  module: AnalyticsModule;
  onNavigate: (module: AnalyticsModule) => void;
  active?: boolean;
}) {
  return (
    <div className="hl-analytics-workspace">
      <OverviewPage
        active={active && module === "overview"}
        onNavigate={onNavigate}
      />
      <ArticlesPage active={active && module === "articles"} />
      <QaPage active={active && module === "ai-qa"} />
      <TrafficPage active={active && module === "traffic-sources"} />
    </div>
  );
}
