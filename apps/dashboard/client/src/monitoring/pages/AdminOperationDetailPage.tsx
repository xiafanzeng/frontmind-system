import { ArrowLeft, ClipboardList } from "lucide-react";
import { Link } from "wouter";

import {
  attemptStatusLabel,
  formatDateTime,
  runStatusLabel,
  type AttemptStatus,
} from "../domain";
import type { AdminRun } from "./AdminPage";

export type AdminOperationAttempt = {
  id: string;
  question: string;
  platformName: string;
  providerCode: string;
  clientType: "web" | "mobile";
  repetition: number;
  status: AttemptStatus;
  providerTaskId?: string;
  providerSubTaskId?: string;
  createdAt?: string;
  submittedAt?: string;
  terminalAt?: string;
  error?: string;
};

type AdminOperationDetailPageProps = {
  run: AdminRun;
  attempts: AdminOperationAttempt[];
};

function identifier(value?: string) {
  return value || "尚未生成";
}

export default function AdminOperationDetailPage({
  run,
  attempts,
}: AdminOperationDetailPageProps) {
  const completed = attempts.filter(
    (attempt) => attempt.status === "completed",
  );
  const failed = attempts.filter((attempt) =>
    ["failed", "error", "review_required"].includes(attempt.status),
  );

  return (
    <div className="page-content admin-operation-detail-page">
      <div className="detail-back-row">
        <Link href="/admin/monitoring/operations" className="back-link">
          <ArrowLeft size={15} />
          返回任务运行
        </Link>
      </div>
      <section className="page-heading operation-detail-heading">
        <div>
          <h1>{run.monitorName}</h1>
          <p>
            @{run.username} · 创建于 {formatDateTime(run.createdAt)} · 运行编号{" "}
            {run.id}
          </p>
        </div>
        <span className={`status-chip ${run.status}`}>
          {runStatusLabel(run.status)}
        </span>
      </section>
      <section className="admin-health-grid operation-detail-metrics">
        <article>
          <span>供应商提交</span>
          <strong>{attempts.length}</strong>
          <small>一个问题 × 一个模型 × 一次重复</small>
        </article>
        <article>
          <span>成功</span>
          <strong className="healthy">{completed.length}</strong>
          <small>已取得终态结果</small>
        </article>
        <article>
          <span>需关注</span>
          <strong className={failed.length ? "unhealthy" : "healthy"}>
            {failed.length}
          </strong>
          <small>失败、异常或需要复核</small>
        </article>
      </section>
      <section className="content-card admin-operation-attempts">
        <div className="card-heading">
          <div>
            <h2>供应商提交明细</h2>
            <p>这里只展示执行元数据，不读取或展示客户回答正文。</p>
          </div>
          <div className="module-icon compact" aria-hidden="true">
            <ClipboardList size={18} />
          </div>
        </div>
        <div
          className="admin-attempt-table"
          role="region"
          aria-label="供应商提交明细，可横向滚动"
          tabIndex={0}
        >
          <div className="admin-attempt-head" role="row">
            <span role="columnheader">问题与模型</span>
            <span role="columnheader">重复</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">供应商任务编号</span>
            <span role="columnheader">子任务编号</span>
            <span role="columnheader">时间</span>
            <span role="columnheader">错误</span>
          </div>
          {attempts.length ? (
            attempts.map((attempt) => (
              <div className="admin-attempt-row" key={attempt.id} role="row">
                <span data-label="问题与模型" role="cell">
                  <strong>{attempt.question}</strong>
                  <small>
                    {attempt.platformName} · {attempt.providerCode} ·{" "}
                    {attempt.clientType === "web" ? "网页版" : "手机版"}
                  </small>
                </span>
                <span data-label="重复" role="cell">
                  第 {attempt.repetition} 次
                </span>
                <span data-label="状态" role="cell">
                  <i className={`status-chip ${attempt.status}`}>
                    {attemptStatusLabel(attempt.status)}
                  </i>
                </span>
                <code data-label="供应商任务编号" role="cell">
                  {identifier(attempt.providerTaskId)}
                </code>
                <code data-label="子任务编号" role="cell">
                  {identifier(attempt.providerSubTaskId)}
                </code>
                <span data-label="时间" role="cell">
                  <strong>
                    {formatDateTime(
                      attempt.terminalAt ||
                        attempt.submittedAt ||
                        attempt.createdAt,
                    )}
                  </strong>
                  <small>
                    {attempt.terminalAt
                      ? "终态时间"
                      : attempt.submittedAt
                        ? "提交时间"
                        : "创建时间"}
                  </small>
                </span>
                <span className="attempt-error" data-label="错误" role="cell">
                  {attempt.error || "—"}
                </span>
              </div>
            ))
          ) : (
            <div className="panel-state">
              <strong>本次运行尚无供应商提交</strong>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
