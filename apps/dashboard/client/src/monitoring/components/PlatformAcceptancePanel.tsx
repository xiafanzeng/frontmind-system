import { useRef, useState } from "react";
import type {
  PlatformAcceptancePlanInput,
  PlatformAcceptancePlanOutput,
} from "@frontmind/monitoring-contracts";
import { Link } from "wouter";
import { formatCnyTenThousandths } from "../billingView";
import { trpc } from "../trpc";
import {
  acceptanceIntentKey,
  restoreAcceptanceIntent,
  saveAcceptanceIntent,
} from "./platformAcceptanceIntent";

const dimensions: Record<string, string> = {
  search_default: "默认搜索",
  reasoning_search: "深度思考",
  screenshot_mention: "提及时截图",
  screenshot_all: "全量截图",
  region_default: "默认地域",
  region_domestic: "国内地域",
  region_overseas: "海外地域",
  mobile_no_region: "移动端无地域",
};
const statuses: Record<string, string> = {
  pending: "等待中",
  running: "运行中",
  passed: "已通过",
  failed: "失败",
  unsupported: "不支持",
  stale: "已失效",
};
const money = (value: string) =>
  formatCnyTenThousandths(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
const active = (status?: string) =>
  status === "pending" || status === "running";
type FrozenPlan = {
  input: PlatformAcceptancePlanInput;
  quote: PlatformAcceptancePlanOutput;
  idempotencyKey: string;
};

export default function PlatformAcceptancePanel() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const projects = trpc.projects.list.useQuery();
  const platforms = trpc.admin.platforms.list.useQuery();
  const regions = trpc.regions.list.useQuery();
  const history = trpc.admin.platforms.acceptance.list.useQuery(
    { limit: 10 },
    {
      refetchInterval: (query) =>
        query.state.data?.some((batch) => active(batch.status)) ? 5000 : false,
    },
  );
  const [projectId, setProjectId] = useState("");
  const [platformIds, setPlatformIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [domesticRegionCode, setDomesticRegionCode] = useState("");
  const [overseasRegionCode, setOverseasRegionCode] = useState("");
  const [frozen, setFrozen] = useState<FrozenPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [batchId, setBatchId] = useState("");
  const inFlight = useRef(false);
  const start = trpc.admin.platforms.acceptance.start.useMutation();
  const detail = trpc.admin.platforms.acceptance.get.useQuery(
    { batchId },
    {
      enabled: Boolean(batchId),
      refetchInterval: (query) =>
        active(query.state.data?.status) ? 5000 : false,
    },
  );
  const busy = quoting || start.isPending;
  const edit = () => {
    setFrozen(undefined);
    setConfirmed(false);
    setError("");
  };

  async function quotePlan() {
    if (!me.data || inFlight.current) return;
    inFlight.current = true;
    setQuoting(true);
    edit();
    const input: PlatformAcceptancePlanInput = {
      ownerId: me.data.user.id,
      projectId,
      platformIds: [...platformIds].sort(),
      question: question.trim(),
      domesticRegionCode: domesticRegionCode || null,
      overseasRegionCode: overseasRegionCode || null,
    };
    try {
      const quote =
        await utils.client.admin.platforms.acceptance.plan.query(input);
      setFrozen({
        input,
        quote,
        idempotencyKey: restoreAcceptanceIntent(
          input.ownerId,
          quote.planFingerprint,
        ),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "验收报价失败");
    } finally {
      inFlight.current = false;
      setQuoting(false);
    }
  }

  async function startPlan() {
    if (!frozen || !confirmed || inFlight.current) return;
    inFlight.current = true;
    setError("");
    try {
      saveAcceptanceIntent(
        frozen.input.ownerId,
        frozen.quote.planFingerprint,
        frozen.idempotencyKey,
      );
      const batch = await start.mutateAsync({
        ...frozen.input,
        planFingerprint: frozen.quote.planFingerprint,
        confirmedTotalAmountTenThousandths:
          frozen.quote.totalAmountTenThousandths,
        // Retries and reloads retain the same explicit execution intent.
        idempotencyKey: frozen.idempotencyKey,
      });
      setBatchId(batch.id);
      setFrozen(undefined);
      setConfirmed(false);
      await Promise.all([
        utils.admin.platforms.acceptance.list.invalidate(),
        utils.admin.platforms.list.invalidate(),
        utils.projects.list.invalidate(),
        utils.billing.summary.invalidate(),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "验收启动失败");
    } finally {
      inFlight.current = false;
    }
  }
  const previousBatch = frozen
    ? [detail.data, ...(history.data || [])].find(
        (batch) =>
          batch &&
          batch.ownerId === frozen.input.ownerId &&
          batch.requestedBy === frozen.input.ownerId &&
          batch.planFingerprint === frozen.quote.planFingerprint &&
          batch.completedAt &&
          ["passed", "failed", "unsupported", "stale"].includes(batch.status),
      )
    : undefined;
  const hasActiveBatch =
    frozen &&
    [detail.data, ...(history.data || [])].some(
      (batch) =>
        batch?.planFingerprint === frozen.quote.planFingerprint &&
        active(batch.status),
    );
  async function prepareRepeat() {
    if (!frozen || !previousBatch || hasActiveBatch || inFlight.current) return;
    inFlight.current = true;
    setQuoting(true);
    setConfirmed(false);
    setError("");
    try {
      // Refresh the selected batch before creating another paid execution intent.
      const previous = await utils.client.admin.platforms.acceptance.get.query({
        batchId: previousBatch.id,
      });
      if (
        previous.ownerId !== frozen.input.ownerId ||
        previous.requestedBy !== frozen.input.ownerId ||
        previous.planFingerprint !== frozen.quote.planFingerprint ||
        !previous.completedAt ||
        !["passed", "failed", "unsupported", "stale"].includes(previous.status)
      ) {
        throw new Error("上轮验收尚未确认结束，请先恢复并查看原批次。");
      }
      const idempotencyKey = acceptanceIntentKey(
        frozen.quote.planFingerprint,
        previous.id,
      );
      saveAcceptanceIntent(
        frozen.input.ownerId,
        frozen.quote.planFingerprint,
        idempotencyKey,
      );
      setFrozen({ ...frozen, idempotencyKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建新一轮验收");
    } finally {
      inFlight.current = false;
      setQuoting(false);
    }
  }
  const loadError =
    me.error ||
    projects.error ||
    platforms.error ||
    regions.error ||
    history.error ||
    detail.error;
  return (
    <section className="content-card platform-acceptance-panel">
      <div className="card-heading">
        <div>
          <h2>平台能力验收</h2>
          <p>
            使用当前账号的项目执行完整能力检查。先核对次数与金额，再启动一次性运行。
          </p>
        </div>
      </div>
      {(error || loadError) && (
        <p role="alert">{error || loadError?.message}</p>
      )}
      {projects.data?.length === 0 && (
        <p>
          请先在 <Link href="/monitoring-system">问题监控</Link> 创建验收项目。
        </p>
      )}
      <fieldset className="acceptance-fields" disabled={busy}>
        <label>
          验收项目
          <select
            value={projectId}
            onChange={(event) => {
              edit();
              setProjectId(event.target.value);
            }}
          >
            <option value="">选择当前账号的项目</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          验收问题
          <textarea
            value={question}
            maxLength={4000}
            rows={3}
            onChange={(event) => {
              edit();
              setQuestion(event.target.value);
            }}
            placeholder="填写用于所有能力检查的公开问题"
          />
        </label>
        <fieldset className="acceptance-models">
          <legend>验收模型</legend>
          {platforms.data?.map((platform) => (
            <label key={platform.id}>
              <input
                type="checkbox"
                checked={platformIds.includes(platform.id)}
                onChange={(event) => {
                  edit();
                  setPlatformIds((current) =>
                    event.target.checked
                      ? [...current, platform.id]
                      : current.filter((id) => id !== platform.id),
                  );
                }}
              />
              {platform.displayName} ·{" "}
              {platform.clientType === "web" ? "网页" : "移动端"}
            </label>
          ))}
        </fieldset>
        <div className="acceptance-regions">
          <label>
            国内地域
            <select
              value={domesticRegionCode}
              onChange={(event) => {
                edit();
                setDomesticRegionCode(event.target.value);
              }}
            >
              <option value="">使用同步目录默认地域</option>
              {regions.data
                ?.filter((region) => region.scope === "domestic")
                .map((region) => (
                  <option key={region.code} value={region.code}>
                    {region.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            海外地域
            <select
              value={overseasRegionCode}
              onChange={(event) => {
                edit();
                setOverseasRegionCode(event.target.value);
              }}
            >
              <option value="">使用同步目录默认地域</option>
              {regions.data
                ?.filter((region) => region.scope === "overseas")
                .map((region) => (
                  <option key={region.code} value={region.code}>
                    {region.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={
            !me.data ||
            !projectId ||
            !question.trim() ||
            platformIds.length === 0 ||
            platformIds.length > 100
          }
          onClick={() => void quotePlan()}
        >
          {quoting ? "正在计算…" : "生成验收报价"}
        </button>
      </fieldset>
      {frozen && (
        <div className="acceptance-quote">
          <h3>
            本次完整计划：{frozen.quote.attemptCount} 次，共{" "}
            {money(frozen.quote.totalAmountTenThousandths)}
          </h3>
          <div className="acceptance-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>检查维度</th>
                  <th>地域</th>
                  <th>金额</th>
                </tr>
              </thead>
              <tbody>
                {frozen.quote.checks.map((check, index) => (
                  <tr key={`${check.platformId}:${check.dimension}:${index}`}>
                    <td>
                      {check.displayName} ·{" "}
                      {check.clientType === "web" ? "网页" : "移动端"}
                    </td>
                    <td>{dimensions[check.dimension]}</td>
                    <td>
                      {regions.data?.find(
                        (region) => region.code === check.regionCode,
                      )?.name ||
                        check.regionCode ||
                        "默认"}
                    </td>
                    <td>{money(check.unitAmountTenThousandths)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            启动时会重新核对目录和价格，并从验收账号余额预留金额；仅成功且有内容的回答结算。服务端预算默认关闭，需已配置预算上限。
          </p>
          {previousBatch &&
            !hasActiveBatch &&
            frozen.idempotencyKey !==
              acceptanceIntentKey(
                frozen.quote.planFingerprint,
                previousBatch.id,
              ) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void prepareRepeat()}
              >
                发起新一轮验收
              </button>
            )}
          <p>
            {frozen.idempotencyKey.includes(":after:")
              ? "已选择新一轮验收；超时或刷新后继续恢复本轮。"
              : "重复提交会恢复已有批次。相同计划需要重验时，请先明确选择新一轮验收。"}
          </p>
          <label className="acceptance-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我确认执行 {frozen.quote.attemptCount} 次，最高{" "}
            {money(frozen.quote.totalAmountTenThousandths)}
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={!confirmed || busy}
            onClick={() => void startPlan()}
          >
            {start.isPending ? "正在启动…" : "确认并启动验收"}
          </button>
        </div>
      )}
      <div className="acceptance-history">
        <h3>最近验收</h3>
        {history.isLoading ? (
          <p>正在加载…</p>
        ) : history.data?.length === 0 ? (
          <p>暂无验收记录</p>
        ) : (
          <ul>
            {history.data?.map((batch) => (
              <li key={batch.id}>
                <button type="button" onClick={() => setBatchId(batch.id)}>
                  {new Date(batch.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {batch.attemptCount} 次 ·{" "}
                  {money(batch.totalAmountTenThousandths)} ·{" "}
                  {statuses[batch.status]}
                </button>
              </li>
            ))}
          </ul>
        )}
        {detail.data && (
          <div aria-label="验收详情">
            <h3>验收详情 · {statuses[detail.data.status]}</h3>
            <p>批次：{detail.data.id}</p>
            <div className="acceptance-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>检查维度</th>
                    <th>结果</th>
                    <th>运行</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.checks.map((check) => (
                    <tr key={check.id}>
                      <td>{check.displayName}</td>
                      <td>{dimensions[check.dimension]}</td>
                      <td>
                        {statuses[check.status]}
                        {check.errorSummary && (
                          <small>{check.errorSummary}</small>
                        )}
                      </td>
                      <td>
                        {check.runId ? (
                          <Link
                            href={`/admin/monitoring/operations/runs/${encodeURIComponent(check.runId)}`}
                          >
                            查看运行
                          </Link>
                        ) : (
                          "等待创建"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!active(detail.data.status) && (
              <button
                type="button"
                onClick={() => void utils.admin.platforms.list.invalidate()}
              >
                刷新能力矩阵
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
