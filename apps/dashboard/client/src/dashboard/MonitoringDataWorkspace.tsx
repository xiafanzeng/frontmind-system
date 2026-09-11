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
      <header className="monitoring-data-header">
        <div>
          <p className="monitoring-data-eyebrow">MONITORING DATA</p>
          <h2>监控数据</h2>
          <p className="monitoring-data-lead">
            查看已保存的回答与引用。表格导入不增加自动采集运行或费用。
          </p>
        </div>
        <button
          type="button"
          className="monitoring-data-export"
          disabled={exporting || samples.isLoading}
          onClick={() => void exportResults()}
        >
          {exporting ? "正在导出…" : "导出当前范围全部结果"}
        </button>
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
        <p className="monitoring-data-note">
          当前批次版本 R{batch.revision}
          {historicalRevision > 0 && historicalRevision !== batch.revision
            ? `；工作记录对应 R${historicalRevision}，批次已更新，以下展示当前版本。`
            : ""}
        </p>
      )}
      <div className="monitoring-data-metrics">
        <div className="monitoring-data-metric is-blue">
          <span>有效回答</span>
          <strong>{samples.data?.total ?? "—"}</strong>
        </div>
        <div className="monitoring-data-metric is-purple">
          <span>可打开引用明细</span>
          <strong>{citations.data?.total ?? "—"}</strong>
        </div>
        <div className="monitoring-data-metric is-green">
          <span>有排名回答</span>
          <strong>{samples.data?.totals.rankedSampleCount ?? "—"}</strong>
        </div>
        <div className="monitoring-data-metric is-gold">
          <span>平均排名</span>
          <strong>{samples.data?.totals.averageRank?.toFixed(1) ?? "暂无"}</strong>
        </div>
        <div className="monitoring-data-metric is-blue">
          <span>前三名回答</span>
          <strong>{samples.data?.totals.top3SampleCount ?? "—"}</strong>
        </div>
      </div>
      <p className="monitoring-data-note">
        排名仅显示已提供的数据；未提供的排名、情感和品牌提及指标显示暂无数据。答案声明的引用数量可能与已导入引用明细不同。
      </p>
      {(samples.error || citations.error || options.error || exportError) && (
        <div role="alert" className="monitoring-data-alert">
          {samples.error?.message ||
            citations.error?.message ||
            options.error?.message ||
            exportError}
        </div>
      )}
      {samples.isLoading && <p role="status">正在读取监控数据…</p>}
      <div className="monitoring-data-answers">
        {samples.data?.items.map((sample) => (
          <article
            key={sample.id}
            className={`monitoring-data-answer${selectedSample === sample.id ? " is-open" : ""}`}
          >
            <header className="monitoring-data-answer__head">
              <span className="monitoring-data-platform">
                {sample.platform}
              </span>
              <span className="monitoring-data-chip">R{sample.batchRevision}</span>
              <span className="monitoring-data-chip">{sample.collectedDate}</span>
              {sample.monitorRank != null && (
                <span className="monitoring-data-rank">
                  排名 #{sample.monitorRank}
                </span>
              )}
              <button
                type="button"
                className="monitoring-data-answer__toggle"
                onClick={() => {
                  setSelectedSample(
                    selectedSample === sample.id ? null : sample.id,
                  );
                  setSampleCitationPage(0);
                }}
              >
                {selectedSample === sample.id ? "收起详情" : "查看详情"}
              </button>
            </header>
            <h3>{sample.question}</h3>
            <div
              className={`monitoring-data-answer__body${selectedSample === sample.id ? "" : " is-clamped"}`}
            >
              <MarkdownRenderer content={sample.content || "暂无回答正文"} />
              <p className="monitoring-data-answer__facts">
                排名：{sample.monitorRank ?? "暂无数据"} · 声明引用：
                {sample.citationCount}
              </p>
              {selectedSample === sample.id && (
                <details className="monitoring-data-evidence">
                  <summary>
                    本回答引用
                    <span className="monitoring-data-pill">
                      {sampleCitations.isLoading
                        ? "…"
                        : (sampleCitations.data?.total ?? 0)}
                    </span>
                  </summary>
                  {sampleCitations.isLoading ? (
                    <p>正在读取引用…</p>
                  ) : sampleCitations.error ? (
                    <p role="alert">{sampleCitations.error.message}</p>
                  ) : (
                    <>
                      <ul className="monitoring-data-citations">
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
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
      {!samples.isLoading && samples.data?.total === 0 && (
        <p className="monitoring-data-empty">当前范围暂无回答。</p>
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
      <details className="monitoring-data-evidence monitoring-data-evidence--all">
        <summary>
          引用明细
          <span className="monitoring-data-pill">
            {citations.data?.total ?? 0}
          </span>
        </summary>
        {citations.isLoading ? (
          <p role="status">正在读取引用明细…</p>
        ) : (
          <>
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
          </>
        )}
      </details>
    </section>
  );
}
