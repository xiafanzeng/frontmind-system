import { useCallback, useRef, useState } from "react";
import { FlaskConical, RotateCcw, RadioTower } from "lucide-react";
import MonitoringPage from "./pages/MonitoringPage";
import { MonitoringDemoContext } from "./MonitoringDemoContext";
import {
  demoConfigurations,
  demoModels,
  demoProject,
  makeDemoMonitor,
  makeDemoRun,
} from "./monitoringDemoData";
import type { MonitorInput, MonitorRun, MonitorSummary } from "./domain";
import type { RunCostQuoteInput } from "./runBilling";
import "./styles.css";
import "./integration.css";

const initialRuns = () =>
  Object.entries(demoConfigurations).flatMap(([id, config]) => [
    makeDemoRun(id, config, 1),
    makeDemoRun(id, config, 2, 2),
    makeDemoRun(id, config, 3, 5),
  ]);
const quote = async (input: RunCostQuoteInput) => ({
  totalAmountTenThousandths: String(
    input.items.reduce((sum, item) => sum + item.quantity * 1000, 0),
  ),
});

/** Standalone synthetic workspace. It has no monitoring or provider API client. */
export default function MonitoringDemo() {
  const [runs, setRuns] = useState(initialRuns);
  const [configs, setConfigs] = useState(demoConfigurations);
  const [monitors, setMonitors] = useState(() =>
    Object.entries(demoConfigurations).map(([id, config]) =>
      makeDemoMonitor(id, config, makeDemoRun(id, config)),
    ),
  );
  const [deleted, setDeleted] = useState<MonitorSummary[]>([]);
  const [trackedSources, setTrackedSources] = useState<Set<string>>(
    () => new Set(),
  );
  const [notice, setNotice] = useState(
    "全部品牌、问题与回答均为合成数据；保存和运行只更新本页，不产生费用。",
  );
  const sequence = useRef(4);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const run = useCallback((id: string, config: MonitorInput) => {
    const fresh = makeDemoRun(id, config, sequence.current++);
    setRuns((current) => [fresh, ...current]);
    setMonitors((current) =>
      current.map((m) =>
        m.id === id
          ? { ...makeDemoMonitor(id, config, fresh), status: m.status }
          : m,
      ),
    );
    setNotice("模拟运行完成：已生成新的演示回答，没有发起真实监控或扣费。");
    return fresh;
  }, []);
  const save = (
    value: MonitorInput,
    runNow: boolean,
    id = `demo-created-${sequence.current++}`,
  ) => {
    setConfigs((current) => ({ ...current, [id]: value }));
    const fresh = runNow
      ? makeDemoRun(id, value, sequence.current++)
      : undefined;
    setMonitors((current) => [
      makeDemoMonitor(id, value, fresh),
      ...current.filter((m) => m.id !== id),
    ]);
    if (fresh) setRuns((current) => [fresh, ...current]);
    setNotice(
      runNow
        ? "已保存并模拟执行；数据仅保存在当前演示页面。"
        : "演示监控已保存；刷新页面会恢复初始数据。",
    );
    return { monitorId: id, runId: fresh?.id };
  };
  return (
    <div className="monitoring-module monitoring-demo-shell">
      <header className="fm-demo-header">
        <div>
          <RadioTower size={22} />
          <span>
            <strong>问题监控</strong>
            <small>品牌在 AI 回答中的表现与引用来源</small>
          </span>
        </div>
        <div>
          <span className="fm-demo-badge">
            <FlaskConical size={14} /> 本地演示
          </span>
          <button
            className="fm-secondary-button"
            onClick={() => {
              setRuns(initialRuns());
              setMonitors(
                Object.entries(demoConfigurations).map(([id, config]) =>
                  makeDemoMonitor(id, config, makeDemoRun(id, config)),
                ),
              );
              setConfigs(demoConfigurations);
              setDeleted([]);
              setTrackedSources(new Set());
              setNotice("演示数据已重置。");
            }}
          >
            <RotateCcw size={14} /> 重置演示
          </button>
        </div>
      </header>
      <p className="fm-demo-notice" role="status">
        {notice}
      </p>
      <MonitoringDemoContext.Provider
        value={{
          trackedSources,
          toggleSource: (id) =>
            setTrackedSources((current) => {
              const next = new Set(current);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            }),
          correctAnswer: (id, correction) => {
            setRuns((current) =>
              current.map((r) => ({
                ...r,
                attempts: r.attempts.map((a) =>
                  a.id === id ? { ...a, ...correction } : a,
                ),
              })),
            );
            setNotice("纠正已应用到本页演示数据；原始回答正文保留。");
          },
        }}
      >
        <MonitoringPage
          demoMode
          project={demoProject}
          monitors={monitors}
          deletedMonitors={deleted.map((m) => ({
            id: m.id,
            name: m.name,
            deletedAt: new Date(),
            purgeAfter: null,
          }))}
          models={demoModels}
          availableBalanceTenThousandths="10000000"
          serverData={false}
          quoteRunCost={quote}
          quoteMonitorRunCost={async (id) => ({
            totalAmountTenThousandths: String(
              configs[id].questions.length *
                configs[id].platforms.length *
                configs[id].repetitions *
                1000,
            ),
          })}
          onCreateProject={() => {}}
          onSaveMonitor={(value, runNow) => save(value, runNow)}
          onLoadMonitor={(id) => configs[id]}
          onUpdateMonitor={(id, value, runNow) => save(value, runNow, id)}
          onRunMonitor={(id) => ({ runId: run(id, configs[id]).id })}
          onToggleMonitor={(id, paused) =>
            setMonitors((current) =>
              current.map((m) =>
                m.id === id
                  ? { ...m, status: paused ? "paused" : "active" }
                  : m,
              ),
            )
          }
          onDeleteMonitor={(id) => {
            setDeleted((current) => [
              ...current,
              ...monitors.filter((m) => m.id === id),
            ]);
            setMonitors((current) => current.filter((m) => m.id !== id));
          }}
          onRestoreMonitor={(id) => {
            setMonitors((current) => [
              ...current,
              ...deleted.filter((m) => m.id === id),
            ]);
            setDeleted((current) => current.filter((m) => m.id !== id));
          }}
          onRefresh={() => {
            setNotice("演示数据已刷新，没有请求外部服务。");
          }}
          recentRuns={runs}
          latestRun={runs[0]}
          selectedRunId={selectedRunId}
          onSelectedRunChange={setSelectedRunId}
        />
        <div id="monitoring-module-portals" />
      </MonitoringDemoContext.Provider>
    </div>
  );
}
