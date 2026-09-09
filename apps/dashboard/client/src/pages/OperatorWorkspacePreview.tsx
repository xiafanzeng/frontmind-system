import { useState } from "react";
import {
  GeneralAgentWelcome,
  GENERAL_TASK_SUGGESTIONS,
} from "@/components/GeneralAgentWelcome";
import { Menu, ArrowUp, Plus, Paperclip, Search } from "lucide-react";
import { PreviewBuildFlow } from "@/components/EmbeddedKnowledgeBasePanel";
import { previewKnowledgeProgress } from "@/lib/preview-data";
import ManagedKeywordTables from "@/dashboard/ManagedKeywordTables";
import ContentInsightsWorkspace from "@/dashboard/content-insights/ContentInsightsWorkspace";
import KnowledgeFrontendSettings from "@/dashboard/knowledge-frontend/KnowledgeFrontendSettings";
import {
  BusinessWorkspaceProvider,
  BusinessWorkspaceInspector,
  type BusinessWorkspaceSummary,
} from "@/dashboard/BusinessWorkspaceContext";
import { CONTENT_MODES } from "@/dashboard/content-production/ContentProductionWorkspace";
import {
  OperatorSidebar,
  type EnterpriseProjectView,
} from "@/dashboard/OperatorNavigation";
import { OperatorThemeProvider } from "@/components/ui/operator-theme";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import { WorkbenchTaskToolbar } from "@/dashboard/WorkbenchTaskToolbar";
import { MessageBubble } from "@/components/ChatArea";
import {
  ConversationProvider,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import {
  createWorkbenchModules,
  workbenchModuleForView,
  WorkbenchModuleContext,
} from "@/dashboard/agent-workbench";
import type { OperatorView } from "@/dashboard/operator-navigation";
import "@/dashboard/dashboard-styles.css";
import "./operator-workspace-preview.css";

type PreviewResult = {
  title: string;
  subtitle: string;
  sections: [string, string][];
};
const fixtures: Record<OperatorView, PreviewResult> = {
  knowledge: {
    title: "品牌知识底稿",
    subtitle: "智能知识库 · 企业事实",
    sections: [
      [
        "品牌定位",
        "以可验证的产品能力建立统一品牌叙事，为 AI 搜索和企业问答提供可靠的知识基础。",
      ],
      [
        "已整理的资料",
        "企业介绍、核心产品与服务边界已归入知识底稿，待项目负责人核对。",
      ],
      [
        "下一步",
        "补充产品适用场景与行业案例，确认后供内容制作和企业问答使用。",
      ],
    ],
  },
  "knowledge-display": {
    title: "已确认的品牌知识",
    subtitle: "知识库展示 · 已发布内容",
    sections: [
      ["品牌事实", "查看已确认的企业简介、产品信息与资料来源。"],
      ["使用范围", "这份知识供企业问答、品牌文章与网站内容使用。"],
    ],
  },
  keywords: {
    title: "品牌全域词库",
    subtitle: "品牌全域词库 · 搜索意图",
    sections: [
      ["品牌与产品词", "企业智能客服、知识库问答、客户服务自动化。"],
      ["场景与需求词", "如何缩短客服响应时间、如何统一企业产品回答。"],
      ["词库整理建议", "将产品词与客户决策问题对应，保留明确的使用场景。"],
    ],
  },
  questions: {
    title: "待优化的客户问题",
    subtitle: "优化问题 · 客户决策",
    sections: [
      ["目标问题", "企业如何选择适合自己的智能客服平台？"],
      ["客户关注点", "业务规模、知识准确度、系统接入要求与服务成本。"],
      ["优化建议", "将宽泛问题拆分为选型、部署与使用效果三个具体方向。"],
    ],
  },
  "response-logic": {
    title: "产品选型应答逻辑",
    subtitle: "应答逻辑 · 回答依据",
    sections: [
      [
        "应答方向",
        "先确认客户的业务规模、资料范围与接入要求，再说明产品的适用条件。",
      ],
      [
        "证据与边界",
        "以已确认的产品说明和公开案例为依据，不承诺资料之外的功能。",
      ],
      ["等待确认", "请核对服务边界与推荐依据，再将这份应答逻辑用于客户回答。"],
    ],
  },
  monitoring: {
    title: "目标问题监控记录",
    subtitle: "问题监控 · 回答与引用",
    sections: [
      ["监控问题", "企业如何选择适合自己的智能客服平台？"],
      [
        "本次观察",
        "设计示例：回答提到了产品适用场景，可继续核对引用来源与品牌描述。",
      ],
      ["查看依据", "正式工作台将呈现当前企业项目的原始回答、采集时间与来源。"],
    ],
  },
  reports: {
    title: "品牌优化进度报告",
    subtitle: "进度报告 · 阶段复盘",
    sections: [
      ["本期工作", "梳理品牌事实，完善重点问题的回答方向，准备内容选题。"],
      [
        "待解决的问题",
        "产品适用场景的公开材料仍需补充，后续回答应继续核查证据。",
      ],
      ["下期安排", "先补齐资料，再复查目标问题中的引用和品牌描述变化。"],
    ],
  },
  content: {
    title: "品牌文章草稿",
    subtitle: "内容工作台 · 草稿",
    sections: [
      [
        "从业务问题出发选择解决方案",
        "一个清晰的品牌回答，应当从客户的真实场景出发，再说明产品提供的具体帮助。",
      ],
      [
        "提供可验证的依据",
        "将产品说明与公开案例连接，标明资料来源与适用条件（以已确认资料为准）。",
      ],
      ["编辑与交付", "确认方向后完善正文，生成稿件并交给媒体发布模块。"],
    ],
  },
  publishing: {
    title: "发布准备清单",
    subtitle: "发布工作台 · 发布计划",
    sections: [
      ["待发布内容", "企业智能客服选型指南。"],
      ["发布准备", "检查标题、正文与素材，在媒体库选择合适渠道后确认发布。"],
      ["当前状态", "设计示例 · 等待确认发布方案。"],
    ],
  },
  articles: {
    title: "稿件管理",
    subtitle: "稿件 · 内容交付",
    sections: [
      [
        "企业智能客服选型指南",
        "文章草稿已整理，待编辑核对标题、段落与引用资料。",
      ],
      ["企业知识库建设实践", "选题已确认，等待补充客户场景与产品截图。"],
      [
        "稿件操作",
        "正式工作台可打开稿件、修改内容，并将确认的版本加入发布计划。",
      ],
    ],
  },
  media: {
    title: "媒体渠道库",
    subtitle: "媒体库 · 渠道筛选",
    sections: [
      ["科技与企业服务媒体", "适合产品选型、行业实践与企业数字化主题。"],
      ["行业垂直媒体", "适合围绕特定行业场景发布案例与专业解读。"],
      [
        "选择依据",
        "结合目标受众、内容方向和发布要求选择渠道；此处为设计示例。",
      ],
    ],
  },
  "enterprise-qa": {
    title: "企业问答示例",
    subtitle: "企业问答 · 已确认的知识",
    sections: [
      ["客户提问", "你们的产品适合什么类型的企业？"],
      [
        "参考回答",
        "适合需要统一产品知识和客户回答的团队。具体接入与服务范围以已确认的企业资料为准。",
      ],
      ["资料依据", "企业简介、产品能力说明与服务范围。"],
    ],
  },
  website: {
    title: "企业网站内容配置",
    subtitle: "网站管理 · 品牌入口",
    sections: [
      ["首页介绍", "用清晰的品牌定位与产品场景介绍企业。"],
      ["产品与资料入口", "呈现已确认的产品说明、案例与联系方式。"],
      ["发布前检查", "核对页面文字、链接和访问入口，再预览正式网站。"],
    ],
  },
  "content-insights": {
    title: "内容表现与 AI 部件",
    subtitle: "内容分析 · 客户互动",
    sections: [
      ["关注的内容", "观察产品介绍、选型指南与行业案例的访问和客户提问。"],
      ["AI 部件配置", "选择问答入口的欢迎语、推荐问题和展示位置。"],
      ["后续调整", "根据客户的真实提问完善内容，并核对企业问答所引用的资料。"],
    ],
  },
};

/** DEV-only fixtures. Mutations remain local and are explicitly labelled. */
export default function OperatorWorkspacePreview() {
  return (
    <ConversationProvider>
      <OperatorWorkspacePreviewContent />
    </ConversationProvider>
  );
}

function OperatorWorkspacePreviewContent() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [view, setView] = useState<OperatorView>("knowledge");
  const [general, setGeneral] = useState(false);
  const [projects, setProjects] = useState<EnterpriseProjectView[]>([
    { id: "design-project", name: "星辰科技", ownerUserId: 0, revision: 1 },
    { id: "design-project-2", name: "未来教育", ownerUserId: 0, revision: 1 },
  ]);
  const [activeId, setActiveId] = useState("design-project");
  const [knowledge, setKnowledge] = useState(() =>
    structuredClone(previewKnowledgeProgress),
  );
  const [summary, setSummary] = useState<BusinessWorkspaceSummary | null>(null);
  const [taskNumbers, setTaskNumbers] = useState<Record<string, number>>({});
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, LocalMessage[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Record<string, number>>({});
  const [selectedMedia, setSelectedMedia] = useState<Record<string, string[]>>(
    {},
  );
  const [mediaQuery, setMediaQuery] = useState("");
  const [attachments, setAttachments] = useState<Record<string, string[]>>({});
  const scope = `${activeId}:${general ? "general" : view}`;
  const taskNumber = taskNumbers[scope] ?? 1;
  const taskKey = `${scope}:${taskNumber}`;
  const active = projects.find((project) => project.id === activeId);
  const currentStage = stage[taskKey] ?? 0;
  const openView = (next: OperatorView) => {
    setGeneral(false);
    setView(next);
    setMobileOpen(false);
    setSummary(null);
    setHistoryOpen(false);
  };
  const modules = createWorkbenchModules(() => null, openView, view);
  const module = modules.find(
    (item) => item.id === workbenchModuleForView(view).id,
  )!;
  const label = general
    ? "通用智能体"
    : (module.actions.find((action) => action.id === view)?.label ??
      "智能知识库");
  const nativeChat =
    general ||
    ["response-logic", "content", "enterprise-qa", "website"].includes(view);
  const fixture = fixtures[view];
  const advance = () =>
    setStage((items) => ({ ...items, [taskKey]: currentStage + 1 }));
  const taskMessages = messages[taskKey] ?? [];
  const composer = (
    <form
      className="workbench-preview-composer"
      onSubmit={(event) => {
        event.preventDefault();
        const content = drafts[taskKey]?.trim();
        if (!content) return;
        setMessages((items) => ({
          ...items,
          [taskKey]: [
            ...(items[taskKey] ?? []),
            {
              id: crypto.randomUUID(),
              role: "user",
              content,
              timestamp: Date.now(),
            },
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content:
                "已保留本次预览输入。正式工作区会由对应智能体处理，并在当前任务中展开结果。",
              timestamp: Date.now() + 1,
            },
          ],
        }));
        setDrafts((items) => ({ ...items, [taskKey]: "" }));
      }}
    >
      <textarea
        aria-label="继续对话"
        placeholder={
          general ? "描述你的任务，或添加文件…" : `继续与${label}协作…`
        }
        value={drafts[taskKey] ?? ""}
        onChange={(event) =>
          setDrafts((items) => ({ ...items, [taskKey]: event.target.value }))
        }
      />
      {(attachments[taskKey] ?? []).length > 0 && (
        <p className="workbench-preview-files">
          {attachments[taskKey].join(" · ")}
        </p>
      )}
      <div>
        <label className="workbench-preview-attachment" title="添加附件">
          <Paperclip size={17} />
          <span>附件</span>
          <input
            type="file"
            multiple
            aria-label="添加预览附件"
            onChange={(event) =>
              setAttachments((items) => ({
                ...items,
                [taskKey]: Array.from(event.target.files ?? []).map(
                  (file) => file.name,
                ),
              }))
            }
          />
        </label>
        <span>本地布局预览</span>
        <button
          type="submit"
          aria-label="发送预览消息"
          disabled={!drafts[taskKey]?.trim()}
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </form>
  );
  const dialogue = (
    <>
      {taskMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isRunning={Boolean(running[taskKey]) && message.role === "assistant"}
        />
      ))}
    </>
  );
  const business = (() => {
    if (general)
      return taskMessages.length ? (
        dialogue
      ) : (
        <div className="workbench-preview-welcome">
          <GeneralAgentWelcome />
          {composer}
          <div className="general-task-suggestions" aria-label="快捷任务建议">
            {GENERAL_TASK_SUGGESTIONS.map((item) => (
              <button
                key={item.label}
                onClick={() =>
                  setDrafts((items) => ({ ...items, [taskKey]: item.prompt }))
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      );
    if (view === "keywords")
      return (
        <ManagedKeywordTables
          tables={[
            {
              id: "preview-words",
              title: "品牌问题",
              columns: ["问题", "主分类", "问题细分"],
              rows: Array.from({ length: 24 }, (_, index) => [
                `企业如何改善客户服务体验 ${index + 1}？`,
                "产品场景词",
                "产品选型",
              ]),
            },
          ]}
          onUseQuestion={(question) => {
            setEdits((items) => ({
              ...items,
              [`${activeId}:questions:1`]: question.question,
            }));
            openView("questions");
          }}
        />
      );
    if (view === "media")
      return (
        <div className="workbench-preview-business">
          <p>选择适合本次内容的媒体，然后选择稿件继续。</p>
          <label className="workbench-preview-search">
            <Search size={16} />
            <input
              aria-label="搜索预览媒体"
              placeholder="搜索媒体名称"
              value={mediaQuery}
              onChange={(event) => setMediaQuery(event.target.value)}
            />
          </label>
          <div className="workbench-preview-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>媒体名称</th>
                  <th>类型</th>
                  <th>预览报价</th>
                </tr>
              </thead>
              <tbody>
                {["科技观察", "产业资讯", "企业服务周刊", "创新视野"]
                  .filter((name) => name.includes(mediaQuery))
                  .map((name, index) => (
                    <tr key={name}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择${name}`}
                          checked={(selectedMedia[taskKey] ?? []).includes(
                            name,
                          )}
                          onChange={(event) =>
                            setSelectedMedia((items) => ({
                              ...items,
                              [taskKey]: event.target.checked
                                ? [...(items[taskKey] ?? []), name]
                                : (items[taskKey] ?? []).filter(
                                    (item) => item !== name,
                                  ),
                            }))
                          }
                        />
                      </td>
                      <td>{name}</td>
                      <td>科技 / 企业服务</td>
                      <td>¥{(index + 1) * 100} · 示例</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <button
            className="operator-primary-button"
            disabled={!selectedMedia[taskKey]?.length}
            onClick={advance}
          >
            选择稿件并继续
          </button>
          {currentStage > 0 && (
            <section className="workbench-preview-flow-step">
              <h3>选择冻结稿件</h3>
              <label>
                <input type="radio" checked readOnly /> 企业智能客服选型指南 ·
                v1（示例）
              </label>
              <button
                className="operator-primary-button"
                onClick={() => {
                  setStage((items) => ({
                    ...items,
                    [`${activeId}:publishing:1`]: 1,
                  }));
                  openView("publishing");
                }}
              >
                交给发布助手
              </button>
            </section>
          )}
        </div>
      );
    if (view === "content-insights") return <ContentInsightsWorkspace />;
    if (view === "website")
      return (
        <KnowledgeFrontendSettings
          demo
          ownerId="preview"
          projectId={activeId}
          legacyWorkflow={
            <div className="workbench-preview-business">
              <p>
                从已发布的品牌知识开始，逐步完成需求、模板选择、官网预览与部署确认。
              </p>
              <button className="operator-primary-button" onClick={advance}>
                预览建站步骤
              </button>
              {currentStage > 0 && (
                <section className="workbench-preview-flow-step">
                  <h3>选择页面方向</h3>
                  <div className="workbench-preview-quick-tasks">
                    <button>产品与解决方案</button>
                    <button>品牌与案例</button>
                  </div>
                  <p>布局预览不创建真实站点或执行部署。</p>
                </section>
              )}
              {dialogue}
            </div>
          }
          publishedContent={<p>当前预览不连接项目发布数据。</p>}
        />
      );
    if (view === "enterprise-qa" && currentStage === 0)
      return (
        <div className="workbench-preview-unlock">
          <h2>先启用企业知识库</h2>
          <p>
            企业问答会以已发布的知识版本为依据。完成资料构建后，回到这里开始提问。
          </p>
          <div>
            <button
              className="operator-primary-button"
              onClick={() => openView("knowledge")}
            >
              前往智能知识库
            </button>
            <button className="operator-secondary-button" onClick={advance}>
              预览已解锁问答
            </button>
          </div>
        </div>
      );
    if (view === "content" && currentStage === 0)
      return (
        <div className="workbench-preview-business">
          <h2>本次要完成什么？</h2>
          <div className="workbench-preview-task-grid">
            {CONTENT_MODES.map((item) => (
              <button key={item.value} onClick={advance}>
                <strong>{item.title}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </div>
        </div>
      );
    if (
      ["questions", "monitoring", "reports", "articles"].includes(view) &&
      currentStage === 0
    )
      return (
        <div className="workbench-preview-business">
          <p>
            {view === "reports"
              ? "选择运行，展开指标、回答与引用分析。这里为布局示例。"
              : "已有内容已准备好，选择一项开始本次工作。"}
          </p>
          <table>
            <thead>
              <tr>
                <th>
                  {view === "questions"
                    ? "优化问题"
                    : view === "articles"
                      ? "稿件"
                      : "任务 / 运行"}
                </th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {fixture.sections.slice(0, 2).map(([title, body]) => (
                <tr key={title}>
                  <td>
                    <strong>{title}</strong>
                    <p>
                      {view === "questions" ? edits[taskKey] || body : body}
                    </p>
                  </td>
                  <td>设计示例</td>
                  <td>
                    <button
                      className="operator-secondary-button"
                      onClick={advance}
                    >
                      {view === "articles"
                        ? "编辑稿件"
                        : view === "reports"
                          ? "展开分析"
                          : "选择并继续"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    return (
      <article className="workbench-preview-document">
        <p className="workbench-preview-flow-description">
          {nativeChat
            ? "围绕当前任务继续协作；可操作内容在下面逐步展开。"
            : "本步骤保留选择，确认后继续下一步。"}
        </p>
        {dialogue}
        {fixture.sections.map(([title, body]) => (
          <section key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </section>
        ))}
        {["response-logic", "articles", "publishing", "content"].includes(
          view,
        ) && (
          <section className="workbench-preview-flow-step">
            <h3>
              {view === "publishing" ? "标题与发布预检" : "检查并修改本次内容"}
            </h3>
            <textarea
              aria-label="业务内容草稿"
              value={
                edits[taskKey] ??
                fixture.sections
                  .map(([title, body]) => `${title}\n${body}`)
                  .join("\n\n")
              }
              onChange={(event) =>
                setEdits((items) => ({
                  ...items,
                  [taskKey]: event.target.value,
                }))
              }
            />
            <button className="operator-primary-button" onClick={advance}>
              {view === "publishing" ? "预览发布确认" : "保存当前步骤"}
            </button>
            {currentStage > 1 && (
              <p role="status">
                当前步骤已保存在本地预览；不会触发真实发布或费用。
              </p>
            )}
          </section>
        )}
      </article>
    );
  })();
  const newPreviewTask = () => {
    const next = (taskCounts[scope] ?? 1) + 1;
    setTaskCounts((items) => ({ ...items, [scope]: next }));
    setTaskNumbers((items) => ({ ...items, [scope]: next }));
    setHistoryOpen(false);
  };
  const toolbar = (
    <>
      <small className="workbench-preview-label">设计预览</small>
      {!general && (
        <>
          <button
            className="operator-secondary-button"
            onClick={newPreviewTask}
          >
            <Plus size={14} />
            新任务
          </button>
          <button
            className="operator-secondary-button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            历史
          </button>
        </>
      )}
      {nativeChat && (
        <button
          className="operator-secondary-button"
          onClick={() =>
            setRunning((items) => ({ ...items, [taskKey]: !items[taskKey] }))
          }
        >
          {running[taskKey] ? "结束长任务演示" : "演示长任务"}
        </button>
      )}
    </>
  );
  const fallbackSummary: BusinessWorkspaceSummary = {
    items: [
      { label: "当前任务", value: `${label} · 任务 ${taskNumber}` },
      {
        label: "工作状态",
        value: currentStage ? "步骤已展开" : "等待本次操作",
      },
      {
        label: "资料与版本",
        value:
          view === "enterprise-qa"
            ? currentStage
              ? "知识库 v1 · 示例"
              : "等待发布知识库"
            : "本地设计示例",
      },
      ...(view === "media"
        ? [
            {
              label: "已选媒体",
              value: (selectedMedia[taskKey] ?? []).join("、") || "尚未选择",
            },
          ]
        : []),
    ],
  };
  return (
    <OperatorThemeProvider enabled>
      <div
        className={`user-brand-dashboard operator-mode ${collapsed ? "operator-collapsed" : ""}`}
      >
        <div
          className={`app-shell knowledge-build-app-shell ${mobileOpen ? "nav-open" : ""}`}
        >
          <button
            className="mobile-menu-btn"
            aria-label="打开项目导航"
            onClick={() => setMobileOpen((value) => !value)}
          >
            <Menu size={20} />
          </button>
          {mobileOpen && (
            <div
              className="mobile-nav-overlay"
              onClick={() => setMobileOpen(false)}
            />
          )}
          <OperatorSidebar
            taskNavigation={
              general ? (
                <WorkbenchTaskToolbar
                  presentation="sidebar"
                  tasks={Array.from(
                    { length: taskCounts[scope] ?? 1 },
                    (_, index) => ({
                      id: String(index + 1),
                      title: `任务 ${index + 1}`,
                      updatedAt: 1788912000000 + index * 60000,
                    }),
                  ).reverse()}
                  currentId={String(taskNumber)}
                  onNew={newPreviewTask}
                  onSelect={(id) =>
                    setTaskNumbers((items) => ({
                      ...items,
                      [scope]: Number(id),
                    }))
                  }
                  onNavigate={() => setMobileOpen(false)}
                />
              ) : undefined
            }
            projects={projects}
            activeProject={active}
            activeEntry={general ? "agent" : "project"}
            view={view}
            onSelectView={openView}
            collapsed={collapsed && !mobileOpen}
            accountName="设计验收账号"
            onCollapse={() => setCollapsed((value) => !value)}
            mobileOpen={mobileOpen}
            onCloseMobile={() => setMobileOpen(false)}
            onNavigate={(path) => {
              setGeneral(path === "/agent");
              setMobileOpen(false);
            }}
            onSelectProject={(id) => {
              setActiveId(id);
              setGeneral(false);
              setKnowledge(structuredClone(previewKnowledgeProgress));
              setSummary(null);
            }}
            onCreateProject={async (name) => {
              const id = crypto.randomUUID();
              setProjects((items) => [
                ...items,
                { id, name, ownerUserId: 0, revision: 1 },
              ]);
              setActiveId(id);
            }}
            onRenameProject={async (name, target) =>
              setProjects((items) =>
                items.map((item) =>
                  item.id === target.id
                    ? { ...item, name, revision: item.revision + 1 }
                    : item,
                ),
              )
            }
            onDeleteProject={async (target) => {
              setProjects((items) =>
                items.filter((item) => item.id !== target.id),
              );
              if (activeId === target.id)
                setActiveId(
                  projects.find((item) => item.id !== target.id)?.id ?? "",
                );
            }}
          />
          <main className="dashboard-main workbench-main">
            <WorkbenchModuleContext.Provider value={general ? null : module}>
              {!general &&
              (view === "knowledge" || view === "knowledge-display") ? (
                <PreviewBuildFlow
                  key={activeId}
                  progress={knowledge}
                  onProgressChange={setKnowledge}
                  mode="workspace"
                  workbench
                  projectId={activeId}
                />
              ) : (
                <AgentWorkbenchShell
                  projectId={activeId}
                  moduleId={general ? "general" : view}
                  title={label}
                  taskTitle={`任务 ${taskNumber}`}
                  taskKey={taskKey}
                  layout={general ? "single" : "workflow"}
                  toolbar={toolbar}
                  main={
                    <BusinessWorkspaceProvider
                      value={{
                        isWorkbench: true,
                        agentId: general ? "general" : view,
                        taskId: taskKey,
                        setSummary,
                      }}
                    >
                      <div className="workbench-preview-main" key={taskKey}>
                        {historyOpen && (
                          <section
                            className="workbench-preview-history"
                            aria-label="预览任务历史"
                          >
                            <input
                              aria-label="搜索预览任务"
                              placeholder="搜索任务"
                              value={historyQuery}
                              onChange={(event) =>
                                setHistoryQuery(event.target.value)
                              }
                            />
                            {Array.from(
                              { length: taskCounts[scope] ?? 1 },
                              (_, index) => index + 1,
                            )
                              .filter((number) =>
                                `任务 ${number}`.includes(historyQuery),
                              )
                              .map((number) => (
                                <button
                                  key={number}
                                  onClick={() => {
                                    setTaskNumbers((items) => ({
                                      ...items,
                                      [scope]: number,
                                    }));
                                    setHistoryOpen(false);
                                  }}
                                >
                                  任务 {number}
                                </button>
                              ))}
                          </section>
                        )}
                        {business}
                      </div>
                    </BusinessWorkspaceProvider>
                  }
                  auxiliary={
                    <BusinessWorkspaceInspector
                      summary={summary ?? fallbackSummary}
                    />
                  }
                  composer={
                    nativeChat &&
                    !(general && !taskMessages.length) &&
                    !(view === "enterprise-qa" && currentStage === 0)
                      ? composer
                      : undefined
                  }
                />
              )}
            </WorkbenchModuleContext.Provider>
          </main>
        </div>
      </div>
    </OperatorThemeProvider>
  );
}
