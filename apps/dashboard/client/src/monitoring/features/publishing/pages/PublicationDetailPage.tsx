import {
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  Copy,
  Download,
  ExternalLink,
  FileStack,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Link, useLocation, useSearch } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  BatchStatusBadge,
  FundStatusBadge,
  ItemStatusBadge,
  MediaMark,
  PublishingBreadcrumbs,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import { formatPublishingMoney, publishingDateTime } from "../types";
import { usePublishingSummary } from "../PublishingFlowContext";

export default function PublishingPublicationDetailPage({
  batchId,
}: {
  batchId: string;
}) {
  const gateway = usePublisherGateway();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [copied, setCopied] = useState("");
  const [submitted] = useState(
    () =>
      new URLSearchParams(search.replace(/^\?/u, "")).get("submitted") === "1",
  );
  const load = useCallback(
    (signal: AbortSignal) => gateway.getBatch(batchId, signal),
    [batchId, gateway],
  );
  const query = usePublisherQuery(load);
  usePublishingSummary({
    title: "发布结果",
    items: [
      { label: "稿件", value: query.data?.articleTitle ?? "读取中" },
      { label: "批次", value: batchId },
      {
        label: "已发布",
        value: `${query.data?.successCount ?? 0} / ${query.data?.itemCount ?? 0} 家`,
      },
      {
        label: "已消费",
        value: query.data
          ? formatPublishingMoney(query.data.consumedTenThousandths)
          : "—",
      },
      { label: "待核实", value: `${query.data?.unknownCount ?? 0} 项` },
    ],
    note: "回链、费用与执行状态来自当前批次。",
  });

  useEffect(() => {
    const params = new URLSearchParams(search.replace(/^\?/u, ""));
    if (params.get("submitted") !== "1") return;
    params.delete("submitted");
    const remaining = params.toString();
    navigate(
      `/publishing/publications/${encodeURIComponent(batchId)}${remaining ? `?${remaining}` : ""}`,
      { replace: true },
    );
  }, [batchId, navigate, search]);

  return (
    <PublishingPage
      title="发布记录"
      description="跟踪发布结果、回链与逐项费用状态"
      busy={query.loading || query.refreshing}
      actions={
        query.data ? (
          <>
            <a
              className="publishing-button publishing-button-secondary"
              download={`${batchId}.csv`}
              href={gateway.batchCsvUrl(batchId)}
            >
              <Download size={16} />
              导出 CSV
            </a>
            <button
              className="publishing-button publishing-button-secondary"
              type="button"
              onClick={query.reload}
              disabled={query.refreshing}
            >
              <RefreshCw
                className={query.refreshing ? "publishing-spin" : undefined}
                size={16}
              />
              刷新
            </button>
          </>
        ) : undefined
      }
    >
      <PublishingBreadcrumbs
        items={[
          { label: "发布记录", href: "/publishing?tab=records" },
          { label: batchId },
        ]}
      />
      {submitted ? (
        <div className="publishing-notice is-success" role="status">
          <CheckCircle2 size={20} />
          <div>
            <strong>发布请求已提交</strong>
            <p>批次已创建，系统正在逐家媒体处理；你可以留在此页查看进度。</p>
          </div>
        </div>
      ) : null}
      {query.loading ? <PublishingLoading label="正在读取发布批次…" /> : null}
      {query.error ? (
        <PublishingError error={query.error} onRetry={query.reload} />
      ) : null}
      {query.data ? (
        <>
          <section className="publishing-batch-title">
            <div>
              <h2>{query.data.articleTitle}</h2>
              <BatchStatusBadge status={query.data.status} />
            </div>
            <p>
              FrontMind 发布编号 {query.data.id} ·{" "}
              {query.data.mode === "live"
                ? "真实发布"
                : query.data.mode.toUpperCase()}{" "}
              · 版本 v{query.data.articleVersion} ·{" "}
              {query.data.titleMode === "single" ? "单标题" : "多标题"}
            </p>
            <span>最近刷新 {publishingDateTime(new Date().toISOString())}</span>
          </section>

          <section
            className="publishing-panel publishing-result-metrics"
            aria-label="批次结果统计"
          >
            <article>
              <FileStack size={28} />
              <span>
                媒体<strong>{query.data.itemCount}</strong>
              </span>
            </article>
            <article className="is-success">
              <CheckCircle2 size={28} />
              <span>
                成功<strong>{query.data.successCount}</strong>
              </span>
            </article>
            <article className="is-danger">
              <XCircle size={28} />
              <span>
                已拒稿<strong>{query.data.failedCount}</strong>
              </span>
            </article>
            <article className="is-warning">
              <CircleHelp size={28} />
              <span>
                待对账<strong>{query.data.unknownCount}</strong>
              </span>
            </article>
          </section>

          <section
            className="publishing-panel publishing-results-table"
            aria-label="逐家媒体发布结果"
          >
            <div className="publishing-results-head publishing-results-row">
              <span>媒体</span>
              <span>独立标题</span>
              <span>发布状态</span>
              <span>结果 / 原因</span>
              <span>费用状态</span>
              <span>更新时间</span>
            </div>
            {query.data.items.map((item) => (
              <article key={item.id} className="publishing-results-row">
                <span className="publishing-media-name">
                  <MediaMark
                    name={item.media.shortName}
                    id={item.media.id}
                    logoUrl={item.media.logoUrl}
                    logoSource={item.media.logoSource}
                    logoResolutionStatus={item.media.logoResolutionStatus}
                  />
                  <span>
                    <strong>{item.media.name}</strong>
                    <small>FrontMind 明细号：{item.id}</small>
                    <span className="publishing-kind-chip">
                      {item.media.kind === "self_media"
                        ? "自媒体"
                        : item.media.kind === "news"
                          ? "软文媒体"
                          : "历史媒体"}
                    </span>
                  </span>
                </span>
                <span data-label="独立标题">{item.title}</span>
                <span data-label="发布状态">
                  <ItemStatusBadge status={item.status} />
                </span>
                <span
                  className="publishing-result-copy"
                  data-label="结果 / 原因"
                >
                  {item.resultUrl ? (
                    <>
                      <a href={item.resultUrl} target="_blank" rel="noreferrer">
                        打开发布链接 <ExternalLink size={14} />
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(item.resultUrl!);
                          setCopied(item.id);
                        }}
                      >
                        {copied === item.id ? (
                          <CheckCircle2 size={13} />
                        ) : (
                          <Copy size={13} />
                        )}
                        {copied === item.id ? "已复制" : "复制链接"}
                      </button>
                      <details className="publishing-result-qr">
                        <summary>查看二维码</summary>
                        <span
                          role="img"
                          aria-label={`${item.media.name} 发布链接二维码`}
                        >
                          <QRCodeSVG
                            value={item.resultUrl}
                            size={112}
                            level="M"
                            marginSize={1}
                          />
                        </span>
                      </details>
                    </>
                  ) : null}
                  <small className="publishing-result-id">
                    FrontMind 明细号：{item.id}
                  </small>
                  {item.resultMessage ? (
                    <span>{item.resultMessage}</span>
                  ) : null}
                  {!item.resultUrl && !item.resultMessage ? (
                    <span>等待服务端提交</span>
                  ) : null}
                </span>
                <span data-label="费用状态">
                  <FundStatusBadge status={item.fundStatus} />
                  <small>
                    {formatPublishingMoney(item.priceTenThousandths)}
                  </small>
                </span>
                <time dateTime={item.updatedAt}>
                  {publishingDateTime(item.updatedAt)}
                </time>
              </article>
            ))}
          </section>

          {query.data.unknownCount ? (
            <div className="publishing-notice is-info">
              <CircleHelp size={20} />
              <div>
                <strong>状态未知不会自动重投</strong>
                <p>
                  请求可能已经越过发送边界。管理员核对供应商后台后，结果会在这里更新；冻结金额在确认终态前不会扣除或退回。
                </p>
              </div>
            </div>
          ) : null}

          <div className="publishing-detail-bottom">
            <Link
              className="publishing-button publishing-button-secondary"
              href="/publishing?tab=records"
            >
              <ArrowLeft size={16} />
              返回发布记录
            </Link>
            <section className="publishing-panel publishing-batch-money">
              <h2>本批费用</h2>
              <dl>
                <div>
                  <dt>冻结总额</dt>
                  <dd>
                    {formatPublishingMoney(query.data.totalTenThousandths)}
                  </dd>
                </div>
                <div>
                  <dt>已扣</dt>
                  <dd className="is-success">
                    {formatPublishingMoney(query.data.consumedTenThousandths)}
                  </dd>
                </div>
                <div>
                  <dt>已退回</dt>
                  <dd className="is-success">
                    {formatPublishingMoney(query.data.releasedTenThousandths)}
                  </dd>
                </div>
                <div>
                  <dt>仍冻结</dt>
                  <dd className="is-warning">
                    {formatPublishingMoney(query.data.frozenTenThousandths)}
                  </dd>
                </div>
              </dl>
              <p>
                <RotateCcw size={15} />
                客户实际支出{" "}
                <strong>
                  {formatPublishingMoney(query.data.consumedTenThousandths)}
                </strong>
              </p>
            </section>
          </div>
        </>
      ) : null}
    </PublishingPage>
  );
}
