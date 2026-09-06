import { useState } from "react";
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
const settingTabs: SettingsTab[] = ["basic", "leads", "install", "share"];

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
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const route = readContentInsightsRoute(search);
  const [session, setSession] = useState(0);
  const navigate = (module: PreviewModule, tab: SettingsTab = route.tab) => {
    const params = new URLSearchParams({
      view: "content-insights",
      contentModule: module,
    });
    if (module === "settings") params.set("contentTab", tab);
    setLocation(
      `${location.startsWith("/preview/user") ? location : "/"}?${params}`,
    );
  };
  return (
    <section
      className="helplook-preview content-insights-workspace"
      aria-label="内容分析与 AI 部件"
    >
      <header className="hl-insights-heading">
        <div>
          <h2>内容分析与 AI 部件</h2>
          <p>查看分析界面和部件样式；示例数据与设置仅用于本次预览。</p>
        </div>
        <span className="hl-preview-badge">界面预览</span>
      </header>
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
        <nav className="hl-module-nav" aria-label="内容分析与 AI 部件模块">
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
      <div key={session}>
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
          />
        </div>
        {(route.module === "collection" || route.module === "leads") && (
          <PendingWorkspace key={route.module} module={route.module} />
        )}
      </div>
    </section>
  );
}
