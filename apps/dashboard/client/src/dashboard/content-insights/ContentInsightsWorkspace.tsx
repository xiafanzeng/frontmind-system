import {
  WorkflowQuestion,
  WorkflowSection,
  WorkflowCompleted,
} from "@/dashboard/workflow/Workflow";
import { useBusinessFlowState, readFlowString } from "../useBusinessFlowState";
import type { BusinessWorkspaceOutput } from "../BusinessWorkspaceContext";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "../BusinessWorkspaceContext";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Bot, ContactRound, Globe2, RotateCcw } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import AnalyticsWorkspace from "./AnalyticsWorkspace";
import WidgetSettingsWorkspace from "./WidgetSettingsWorkspace";
import {
  HlButton,
  INITIAL_PERIOD,
  PeriodControl,
  type AnalyticsModule,
  type PreviewModule,
  type SettingsTab,
} from "./shared";
import "./helplook.css";

const analyticsModules = [
  ["overview", "概览"],
  ["articles", "文章"],
  ["ai-qa", "AI 问答"],
  ["traffic-sources", "流量来源"],
] as const;
const widgetModules = [
  ["settings", "设置"],
  ["collection", "采集"],
  ["leads", "留资统计"],
] as const;
const settingTabs: SettingsTab[] = ["basic", "leads"];

export function readContentInsightsRoute(search: string) {
  const params = new URLSearchParams(search);
  const module =
    [...analyticsModules, ...widgetModules].find(
      (item) => item[0] === params.get("contentModule"),
    )?.[0] || "overview";
  return {
    section: analyticsModules.some((item) => item[0] === module)
      ? ("analytics" as const)
      : ("widget" as const),
    module,
    tab: settingTabs.find((tab) => tab === params.get("contentTab")) || "basic",
  };
}

function PendingWorkspace({ module }: { module: "collection" | "leads" }) {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState(INITIAL_PERIOD);
  const collection = module === "collection";
  const Icon = collection ? Globe2 : ContactRound;
  return (
    <section className="hl-page">
      <header className="hl-page-heading">
        <h2>{collection ? "采集" : "留资统计"}</h2>
        {collection ? (
          <HlButton variant="primary" disabled title="采集功能待接入">
            新建采集
          </HlButton>
        ) : (
          <PeriodControl value={period} onChange={setPeriod} />
        )}
      </header>
      <div className="hl-filter-row">
        <input
          className="hl-input hl-pending-search"
          aria-label={collection ? "搜索采集内容" : "搜索留资记录"}
          placeholder={collection ? "搜索名称或网址" : "搜索名称、手机号或邮箱"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <HlButton onClick={() => setQuery("")}>重置</HlButton>
        {!collection && (
          <HlButton disabled title="留资功能待接入">
            导出
          </HlButton>
        )}
      </div>
      <div className="hl-table-wrap">
        <table className="hl-table">
          <thead>
            <tr>
              {(collection
                ? ["名称", "网址", "状态", "更新时间", "操作"]
                : ["名称", "手机号", "邮箱", "来源页面", "提交时间"]
              ).map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5}>
                <div className="hl-pending-empty" role="status">
                  <Icon size={36} strokeWidth={1.4} />
                  <strong>
                    {collection ? "暂无采集内容" : "暂无留资记录"}
                  </strong>
                  <span>
                    {collection ? "采集功能待接入" : "留资功能待接入"}
                  </span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ContentInsightsWorkspace() {
  const { isWorkbench, task, taskId } = useBusinessWorkspace();
  const taskScope = `${task?.scopeKey ?? "standalone"}:${taskId ?? "new"}`;
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const parsedRoute = readContentInsightsRoute(search);
  const [entry, setEntry] = useBusinessFlowState(
    "insightsEntry",
    new URLSearchParams(search).has("contentModule") ? parsedRoute.section : "",
    readFlowString,
  );
  const [savedModule, setSavedModule] = useBusinessFlowState(
    "insightsModule",
    "",
    readFlowString,
  );
  const route =
    isWorkbench &&
    !new URLSearchParams(search).has("contentModule") &&
    savedModule
      ? readContentInsightsRoute(
          `contentModule=${encodeURIComponent(savedModule)}`,
        )
      : parsedRoute;
  const [widgetOutput, setWidgetOutput] =
    useBusinessFlowState<BusinessWorkspaceOutput | null>(
      "widgetConfirmedOutput",
      null,
      (value) =>
        value === null
          ? null
          : value &&
              typeof value === "object" &&
              typeof (value as BusinessWorkspaceOutput).id === "string" &&
              typeof (value as BusinessWorkspaceOutput).title === "string"
            ? (value as BusinessWorkspaceOutput)
            : undefined,
    );
  const widgetOutputSetter = useRef(setWidgetOutput);
  widgetOutputSetter.current = setWidgetOutput;
  const onWidgetOutput = useCallback(
    (output: BusinessWorkspaceOutput | null) =>
      widgetOutputSetter.current(output),
    [],
  );
  const [confirmedAnalysis, , acceptConfirmedAnalysis] = useBusinessFlowState(
    "insightsConfirmedAnalysis",
    "",
    readFlowString,
  );
  const [analysisSaving, setAnalysisSaving] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const currentScope = useRef(taskScope);
  currentScope.current = taskScope;
  const confirmAnalysis = async () => {
    if (analysisSaving || !task) return;
    const owner = taskScope;
    const module = route.module;
    setAnalysisSaving(true);
    setAnalysisError("");
    try {
      await task.saveState({ values: { insightsConfirmedAnalysis: module } });
      if (currentScope.current === owner) acceptConfirmedAnalysis(module);
    } catch {
      if (currentScope.current === owner)
        setAnalysisError("分析预览尚未确认保存，请重试；当前范围已保留。");
    } finally {
      if (currentScope.current === owner) setAnalysisSaving(false);
    }
  };
  useEffect(() => {
    setAnalysisSaving(false);
    setAnalysisError("");
  }, [taskScope]);
  useEffect(() => {
    const params = new URLSearchParams(search);
    const legacyTab = params.get("contentTab");
    if (
      route.module !== "settings" ||
      !["install", "share"].includes(legacyTab ?? "")
    )
      return;
    params.set("contentTab", "basic");
    setLocation(`${location}?${params.toString()}`);
  }, [location, route.module, search, setLocation]);
  const [session, setSession] = useState(0);
  const navigate = (module: PreviewModule, tab: SettingsTab = route.tab) => {
    setSavedModule(module);
    const params = new URLSearchParams(search);
    params.set("view", "content-insights");
    params.set("contentModule", module);
    params.delete("contentTab");
    if (module === "settings") params.set("contentTab", tab);
    setLocation(
      projectWorkspaceUrl(
        `${import.meta.env.DEV && (location.startsWith("/preview/user") || location.startsWith("/preview/operator-workspace")) ? location : "/"}?${params}`,
      ),
    );
  };
  useBusinessWorkspaceSummary({
    outputs: [
      ...(confirmedAnalysis
        ? [
            {
              id: "analysis-example",
              title: "已确认的分析预览",
              type: "示例分析",
              description: [...analyticsModules].find(
                ([id]) => id === confirmedAnalysis,
              )?.[1],
              status: "示例数据，未接入真实统计",
              pendingChanges:
                route.section === "analytics" &&
                confirmedAnalysis !== route.module,
              onOpen: () => {
                setEntry("analytics");
                navigate(confirmedAnalysis as PreviewModule);
              },
              onRevise: () => {
                setEntry("analytics");
                navigate(confirmedAnalysis as PreviewModule);
              },
            },
          ]
        : []),
      ...(widgetOutput
        ? [
            {
              ...widgetOutput,
              onOpen: () => {
                setEntry("widget");
                navigate("settings");
              },
              onRevise: () => {
                setEntry("widget");
                navigate("settings");
              },
            },
          ]
        : []),
    ],
    items: isWorkbench
      ? []
      : [
          {
            label: "当前范围",
            value:
              [...analyticsModules, ...widgetModules].find(
                ([id]) => id === route.module,
              )?.[1] || "概览",
          },
          { label: "数据来源", value: "示例数据" },
          { label: "配置状态", value: "仅本次预览，未正式发布" },
        ],
  });
  return (
    <section
      className={`helplook-preview content-insights-workspace ${isWorkbench ? "content-insights-flow" : ""}`}
      aria-label="内容分析与 AI 部件"
    >
      {!isWorkbench && (
        <header className="hl-insights-heading">
          <div>
            <h2>内容分析与 AI 部件</h2>
            <p>查看分析界面和部件样式；示例数据与设置仅用于本次预览。</p>
          </div>
          <span className="hl-preview-badge">界面预览</span>
        </header>
      )}
      {isWorkbench &&
        (entry ? (
          <WorkflowCompleted
            id="insights-entry"
            summary={`当前工作：${entry === "analytics" ? "分析示例" : entry === "widget" ? "AI 部件配置" : "待接入功能"}`}
            onRevise={() => setEntry("")}
          />
        ) : (
          <WorkflowQuestion
            question="这次想查看或调整什么？"
            description="分析使用示例数据，部件配置用于预览；正式统计和发布尚未接入。"
            selected={entry}
            choices={[
              {
                id: "analytics",
                label: "查看分析示例",
                description: "查看文章、问答与流量的示例图表",
              },
              {
                id: "widget",
                label: "配置 AI 部件",
                description: "调整问答部件并在主区预览",
              },
              {
                id: "pending",
                label: "查看待接入功能",
                description: "了解采集与留资的现有能力边界",
              },
            ]}
            onSelect={(value) => {
              setEntry(value);
              navigate(
                value === "analytics"
                  ? "overview"
                  : value === "widget"
                    ? "settings"
                    : "collection",
              );
            }}
          />
        ))}
      {(!isWorkbench || entry) && (
        <>
          {isWorkbench ? (
            <WorkflowQuestion
              question={
                entry === "analytics"
                  ? "想查看哪个分析范围？"
                  : entry === "widget"
                    ? "先调整哪部分设置？"
                    : "想了解哪项功能？"
              }
              selected={entry === "widget" ? route.tab : route.module}
              choices={
                entry === "widget"
                  ? [
                      { id: "basic", label: "基础配置" },
                      { id: "leads", label: "留资配置" },
                    ]
                  : (entry === "analytics"
                      ? analyticsModules
                      : widgetModules.filter(([id]) => id !== "settings")
                    ).map(([id, label]) => ({ id, label }))
              }
              onSelect={(value) =>
                entry === "widget"
                  ? navigate("settings", value as SettingsTab)
                  : navigate(value as PreviewModule)
              }
            />
          ) : (
            <div className="hl-workspace-nav">
              <div className="hl-group-toggle" aria-label="模块分组">
                <button
                  type="button"
                  aria-pressed={route.section === "analytics"}
                  onClick={() => navigate("overview")}
                >
                  <BarChart3 size={16} />
                  分析
                </button>
                <button
                  type="button"
                  aria-pressed={route.section === "widget"}
                  onClick={() => navigate("settings")}
                >
                  <Bot size={16} />
                  AI 部件
                </button>
              </div>
              <nav
                className="hl-module-nav"
                aria-label="内容分析与 AI 部件模块"
              >
                {(route.section === "analytics"
                  ? analyticsModules
                  : widgetModules
                ).map(([module, label]) => (
                  <button
                    type="button"
                    key={module}
                    aria-current={route.module === module ? "page" : undefined}
                    onClick={() => navigate(module)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="hl-demo-tools">
                <HlButton
                  variant="link"
                  onClick={() => setSession((value) => value + 1)}
                >
                  <RotateCcw size={13} />
                  恢复默认
                </HlButton>
              </div>
            </div>
          )}
          <WorkflowSection id="insights-current-preview">
            <div key={`${taskScope}:${session}`}>
              <div hidden={route.section !== "analytics"}>
                <AnalyticsWorkspace
                  active={route.section === "analytics"}
                  module={
                    route.section === "analytics"
                      ? (route.module as AnalyticsModule)
                      : "overview"
                  }
                  onNavigate={navigate}
                />
              </div>
              <div hidden={route.module !== "settings"}>
                <WidgetSettingsWorkspace
                  active={route.module === "settings"}
                  tab={route.tab}
                  onTabChange={(tab) => navigate("settings", tab)}
                  onOutputChange={onWidgetOutput}
                />
              </div>
              {(route.module === "collection" || route.module === "leads") && (
                <PendingWorkspace key={route.module} module={route.module} />
              )}
            </div>
            {isWorkbench && entry === "analytics" && (
              <>
                {analysisError && <p role="alert">{analysisError}</p>}
                <HlButton
                  variant="primary"
                  disabled={analysisSaving}
                  onClick={confirmAnalysis}
                >
                  {analysisSaving ? "正在确认保存…" : "确认本次分析预览"}
                </HlButton>
              </>
            )}
          </WorkflowSection>
        </>
      )}
    </section>
  );
}
