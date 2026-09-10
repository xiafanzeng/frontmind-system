import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { trpc } from "@/lib/trpc";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { WorkflowPagination } from "./workflow/Workflow";
import "./monitoring-data-workspace.css";

function safeHref(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export default function MonitoringDataWorkspace({
  enterpriseProjectId,
}: {
  enterpriseProjectId: string;
}) {
  const search = useSearch();
  const initial = new URLSearchParams(search);
  const [batchKey, setBatchKey] = useState(
    initial.get("monitoringBatchKey") || "",
  );
  const [questionId, setQuestionId] = useState("");
  const [model, setModel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [citationPage, setCitationPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const utils = trpc.useUtils();
  const filters = {
    batchKey: batchKey || undefined,
    questionId: questionId || undefined,
    model: model || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const queryOptions = {
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: true,
  };
  const options = trpc.workspace.monitoring.filters.useQuery(
    { batchKey: filters.batchKey },
    queryOptions,
  );
  const samples = trpc.workspace.monitoring.samples.useQuery(
    { ...filters, page: page + 1, pageSize: 25 },
    queryOptions,
  );
  const citations = trpc.workspace.monitoring.citations.useQuery(
    { ...filters, page: citationPage + 1, pageSize: 25 },
    queryOptions,
  );
  const [selectedSample, setSelectedSample] = useState<string | null>(null);
  const [sampleCitationPage, setSampleCitationPage] = useState(0);
  const selected = samples.data?.items.find(
    (sample) => sample.id === selectedSample,
  );
  const sampleCitations = trpc.workspace.monitoring.citations.useQuery(
    {
      batchKey: selected?.batchKey,
      questionId: selected?.questionId,
      sampleId: selected?.id,
      page: sampleCitationPage + 1,
      pageSize: 25,
    },
    { enabled: Boolean(selected) },
  );
  useEffect(() => { setBatchKey(new URLSearchParams(search).get("monitoringBatchKey") || ""); setPage(0); setCitationPage(0); setSelectedSample(null); }, [search]);
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(0);
    setCitationPage(0);
    setSelectedSample(null);
  };
  const batch = options.data?.batches.find(
    (item) => item.batchKey === batchKey,
  );
  const historicalRevision = Number(initial.get("monitoringBatchRevision"));
  const exportResults = async () => {
    const operation = captureWorkspaceRestOperation();
    setExporting(true);
    setExportError("");
    try {
      const fingerprint = (batches: Array<{ batchKey: string; revision: number }>) => JSON.stringify(batches.map(({ batchKey, revision }) => [batchKey, revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      const before = await utils.workspace.monitoring.filters.fetch({ batchKey: filters.batchKey });
      operation.assertActive();
      const allSamples: unknown[] = [],
        allCitations: unknown[] = [];
      for (let next = 1; ; next++) {
        const result = await utils.workspace.monitoring.samples.fetch({
          ...filters,
          page: next,
          pageSize: 100,
        });
        allSamples.push(...result.items);
        if (allSamples.length >= result.total || !result.items.length) break;
      }
      for (let next = 1; ; next++) {
        const result = await utils.workspace.monitoring.citations.fetch({
          ...filters,
          page: next,
          pageSize: 100,
        });
        allCitations.push(...result.items);
        if (allCitations.length >= result.total || !result.items.length) break;
      }
      const after = await utils.workspace.monitoring.filters.fetch({ batchKey: filters.batchKey });
      operation.assertActive();
      if (fingerprint(before.batches) !== fingerprint(after.batches)) throw new Error("导出期间监控批次已变化，请刷新后重试，避免混合不同版本的数据。");
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                enterpriseProjectId,
                filters,
                batchRevisions: before.batches.map(({ batchKey, revision }) => ({ batchKey, revision })),
                exportedAt: new Date().toISOString(),
                samples: allSamples,
                citations: allCitations,
              },
              null,
              2,
            ),
          ],
          { type: "application/json;charset=utf-8" },
        ),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `monitoring-results-${enterpriseProjectId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "导出失败，请重试",
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="monitoring-data-workspace" aria-label="监控数据">
      <header>
        <h2>监控数据</h2>
        <p>查看已保存的回答与引用。表格导入不增加自动采集运行或费用。</p>
      </header>
      <div className="monitoring-data-filters">
        <label>
          批次
          <select
            value={batchKey}
            onChange={(event) => change(setBatchKey, event.target.value)}
          >
            <option value="">全部批次</option>
            {options.data?.batches.map((item) => (
              <option key={item.batchKey} value={item.batchKey}>
                {item.sourceName} · R{item.revision}
              </option>
            ))}
          </select>
        </label>
        <label>
          问题
          <select
            value={questionId}
            onChange={(event) => change(setQuestionId, event.target.value)}
          >
            <option value="">全部问题</option>
            {options.data?.questions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            value={model}
            onChange={(event) => change(setModel, event.target.value)}
          >
            <option value="">全部模型</option>
            {options.data?.models.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          开始日期
          <input
            type="date"
            value={from}
            onChange={(event) => change(setFrom, event.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => change(setTo, event.target.value)}
          />
        </label>
      </div>
      {batch && (
        <p>
          当前批次版本 R{batch.revision}
          {historicalRevision > 0 && historicalRevision !== batch.revision
            ? `；工作记录对应 R${historicalRevision}，批次已更新，以下展示当前版本。`
            : ""}
        </p>
      )}
      <div className="monitoring-data-summary">
        <span>有效回答 {samples.data?.total ?? "—"}</span>
        <span>可打开引用明细 {citations.data?.total ?? "—"}</span>
        <span>有排名回答 {samples.data?.totals.rankedSampleCount ?? "—"}</span>
        <span>
          平均排名 {samples.data?.totals.averageRank?.toFixed(1) ?? "暂无数据"}
        </span>
        <span>前三名回答 {samples.data?.totals.top3SampleCount ?? "—"}</span>
        <button
          type="button"
          disabled={exporting || samples.isLoading}
          onClick={() => void exportResults()}
        >
          {exporting ? "正在导出…" : "导出当前范围全部结果"}
        </button>
      </div>
      <p className="monitoring-data-note">
        排名仅显示已提供的数据；未提供的排名、情感和品牌提及指标显示暂无数据。答案声明的引用数量可能与已导入引用明细不同。
      </p>
      {(samples.error || citations.error || options.error || exportError) && (
        <p role="alert">
          {samples.error?.message ||
            citations.error?.message ||
            options.error?.message ||
            exportError}
        </p>
      )}
      {samples.isLoading && <p role="status">正在读取监控数据…</p>}
      {samples.data?.items.map((sample) => (
        <article key={sample.id} className="monitoring-data-answer">
          <div className="monitoring-data-meta">
            {sample.platform} · {sample.collectedDate} · R{sample.batchRevision}
          </div>
          <h3>{sample.question}</h3>
          <MarkdownRenderer content={sample.content || "暂无回答正文"} />
          <p>
            排名：{sample.monitorRank ?? "暂无数据"} · 声明引用：
            {sample.citationCount}
          </p>
          <button
            type="button"
            onClick={() => {
              setSelectedSample(
                selectedSample === sample.id ? null : sample.id,
              );
              setSampleCitationPage(0);
            }}
          >
            查看本回答引用
          </button>
          {selectedSample === sample.id && (
            <div>
              {sampleCitations.isLoading ? (
                <p>正在读取引用…</p>
              ) : sampleCitations.error ? (
                <p role="alert">{sampleCitations.error.message}</p>
              ) : (
                <>
                  <ul>
                    {sampleCitations.data?.items.map((item) => (
                      <li key={item.id}>
                        <a
                          href={safeHref(item.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.title || item.url || item.domain}
                        </a>
                      </li>
                    ))}
                  </ul>
                  {!sampleCitations.data?.total && (
                    <p>暂无精确关联引用；问题级引用保留在下方。</p>
                  )}
                  <WorkflowPagination
                    page={sampleCitationPage}
                    total={sampleCitations.data?.total ?? 0}
                    pageSize={25}
                    onChange={setSampleCitationPage}
                  />
                </>
              )}
            </div>
          )}
        </article>
      ))}
      {!samples.isLoading && samples.data?.total === 0 && (
        <p>当前范围暂无回答。</p>
      )}
      <WorkflowPagination
        page={page}
        total={samples.data?.total ?? 0}
        pageSize={25}
        onChange={(value) => {
          setPage(value);
          setSelectedSample(null);
        }}
      />
      <h3>引用明细</h3>
      <ul className="monitoring-data-citations">
        {citations.data?.items.map((item) => (
          <li key={item.id}>
            <a href={safeHref(item.url)} target="_blank" rel="noreferrer">
              {item.title || item.url || item.domain || "未提供链接"}
            </a>
            <span>
              {item.model} · {item.sampleId ? "回答级引用" : "问题级引用"} ·{" "}
              {item.question}
            </span>
          </li>
        ))}
      </ul>
      <WorkflowPagination
        page={citationPage}
        total={citations.data?.total ?? 0}
        pageSize={25}
        onChange={setCitationPage}
      />
    </section>
  );
}
