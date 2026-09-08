import { calculateAttempts } from "../domain";
import type { ScreenshotPolicySummary } from "../runBilling";
import {
  absoluteMoneyTenThousandths,
  formatCnyTenThousandths,
  hasEnoughMoneyTenThousandths,
  subtractMoneyTenThousandths,
} from "../billingView";
import Modal from "./Modal";
import { useMonitoringDemo } from "../MonitoringDemoContext";

export type RunConfirmationDialogProps = {
  open: boolean;
  monitorName: string;
  questionCount: number;
  platformCount: number;
  repetitions: number;
  availableBalanceTenThousandths: string;
  estimatedCostTenThousandths?: string;
  quoteLoading?: boolean;
  quoteError?: string;
  scheduleSummary: string;
  screenshotPolicy?: ScreenshotPolicySummary;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

const MAX_ATTEMPTS_PER_RUN = 500;

function formatRunMoney(value: string) {
  return formatCnyTenThousandths(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function screenshotPolicyLabel(policy?: ScreenshotPolicySummary) {
  if (policy === 0) return "不保存截图";
  if (policy === 1) return "保存全部回答截图";
  if (policy === 2) return "仅品牌被提及时保存截图";
  if (policy === "mixed") return "按模型分别保存截图";
  return "沿用当前监控配置";
}

export default function RunConfirmationDialog({
  open,
  monitorName,
  questionCount,
  platformCount,
  repetitions,
  availableBalanceTenThousandths,
  estimatedCostTenThousandths,
  quoteLoading = false,
  quoteError,
  scheduleSummary,
  screenshotPolicy,
  loading = false,
  onCancel,
  onConfirm,
}: RunConfirmationDialogProps) {
  const demo = useMonitoringDemo();
  const attemptCount = calculateAttempts(
    questionCount,
    platformCount,
    repetitions,
  );
  const exceedsRunLimit = attemptCount > MAX_ATTEMPTS_PER_RUN;
  const hasQuote = estimatedCostTenThousandths !== undefined;
  const balanceSufficient =
    hasQuote &&
    hasEnoughMoneyTenThousandths(
      availableBalanceTenThousandths,
      estimatedCostTenThousandths,
    );
  const estimatedRemaining = hasQuote
    ? subtractMoneyTenThousandths(
        availableBalanceTenThousandths,
        estimatedCostTenThousandths,
      )
    : undefined;
  const shortfall =
    estimatedRemaining && estimatedRemaining.startsWith("-")
      ? absoluteMoneyTenThousandths(estimatedRemaining)
      : undefined;
  const canConfirm =
    attemptCount > 0 &&
    !exceedsRunLimit &&
    !quoteLoading &&
    hasQuote &&
    balanceSufficient;

  return (
    <Modal
      open={open}
      title="确认立即执行"
      description={
        demo
          ? "本次只模拟运行并生成合成回答，不调用监控服务、不产生费用。"
          : "本次执行将沿用当前监控配置并进入任务队列。"
      }
      onClose={() => {
        if (!loading) onCancel();
      }}
    >
      <div
        className="run-confirmation-body"
        aria-busy={loading || quoteLoading}
      >
        <section className="run-confirmation-monitor" aria-label="执行对象">
          <span>监控名称</span>
          <strong>{monitorName}</strong>
        </section>

        <section className="run-confirmation-estimate" aria-label="任务规模">
          <div className="run-confirmation-estimate-heading">
            <span>预计任务数</span>
            <strong>{attemptCount.toLocaleString("zh-CN")}</strong>
            <span>个</span>
          </div>
          <p>
            {questionCount.toLocaleString("zh-CN")} 个问题 ×{" "}
            {platformCount.toLocaleString("zh-CN")} 个平台 ×{" "}
            {repetitions.toLocaleString("zh-CN")} 次重复
          </p>
        </section>

        <dl className="run-confirmation-details">
          <div>
            <dt>最大预计费用</dt>
            <dd>
              {quoteLoading
                ? "计算中…"
                : hasQuote
                  ? formatRunMoney(estimatedCostTenThousandths)
                  : "暂无法估算"}
            </dd>
          </div>
          <div>
            <dt>自动调度</dt>
            <dd>{scheduleSummary}</dd>
          </div>
          <div>
            <dt>截图策略</dt>
            <dd>{screenshotPolicyLabel(screenshotPolicy)}</dd>
          </div>
        </dl>

        <div
          className={`run-confirmation-notice${
            !canConfirm ? " run-confirmation-notice-error" : ""
          }`}
          role={!canConfirm ? "alert" : "note"}
        >
          {exceedsRunLimit
            ? `单次运行最多 ${MAX_ATTEMPTS_PER_RUN.toLocaleString("zh-CN")} 个任务，请减少问题、平台或重复次数。`
            : attemptCount === 0
              ? "当前配置没有可执行任务，请先完善问题和平台。"
              : quoteLoading
                ? "正在按官方资费计算本次最大预计费用。"
                : quoteError || !hasQuote
                  ? "暂无法获取官方费用估算，请稍后重试。"
                  : shortfall
                    ? `当前余额不足，还差 ${formatRunMoney(shortfall)}；监控配置仍可保存，但暂时无法执行。`
                    : "费用按全部任务成功的最大金额估算；实际只结算成功且回答非空的任务。"}
        </div>
      </div>

      <footer className="run-confirmation-footer">
        <button
          type="button"
          className="ghost-button"
          data-modal-initial-focus
          disabled={loading}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={loading || quoteLoading || !canConfirm}
          onClick={() => void onConfirm()}
        >
          {loading ? "正在提交…" : "确认执行"}
        </button>
      </footer>
    </Modal>
  );
}
