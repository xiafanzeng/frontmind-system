import { useEffect, useState } from "react";
import { Menu, ArrowUp } from "lucide-react";
import {
  OperatorSidebar,
  type EnterpriseProjectView,
} from "@/dashboard/OperatorNavigation";
import { OperatorThemeProvider } from "@/components/ui/operator-theme";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import { MessageBubble } from "@/components/ChatArea";
import type { LocalMessage, StepGroup } from "@/contexts/ConversationContext";
import {
  createWorkbenchModules,
  workbenchModuleForView,
  WorkbenchModuleContext,
} from "@/dashboard/agent-workbench";
import type { OperatorView } from "@/dashboard/operator-navigation";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import "@/dashboard/dashboard-styles.css";
import "./operator-workspace-preview.css";

const previewTrace = (companyName: string): StepGroup[] => [
  {
    id: "research",
    title: "检索品牌资料",
    description: "已读取项目上传的企业介绍，核对品牌名称、主营业务和产品资料。",
    steps: [
      {
        id: "read",
        type: "file_read",
        label: "读取企业介绍.pdf",
        details: "读取：企业定位、产品能力、目标客户。",
      },
      {
        id: "verify",
        type: "web_search_call",
        label: "校验公开来源",
        description: "品牌官网与项目提供的信息一致。",
        details: `工具：web_search\n查询：${companyName} 品牌介绍`,
      },
    ],
  },
  {
    id: "write",
    title: "整理品牌优化建议",
    steps: [
      {
        id: "create",
        type: "file_write",
        label: "生成品牌优化建议",
        description: "将建议分为知识建设、问题优化和内容制作三个部分。",
        details: "文件：品牌优化建议.md",
      },
    ],
  },
];
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

/** DEV-only fixtures. No project or task mutation leaves this preview. */
export default function OperatorWorkspacePreview() {
  const [collapsed, setCollapsed] = useState(false);
  const [compact, setCompact] = useState(
    () =>
      window.matchMedia("(min-width: 1024px) and (max-width: 1279px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia(
      "(min-width: 1024px) and (max-width: 1279px)",
    );
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [view, setView] = useState<OperatorView>("knowledge");
  const [projects, setProjects] = useState<EnterpriseProjectView[]>([
    { id: "design-project", name: "星辰科技", ownerUserId: 0, revision: 1 },
    { id: "design-project-2", name: "未来教育", ownerUserId: 0, revision: 1 },
    {
      id: "design-project-3",
      name: "长名称项目：企业品牌建设与知识资料管理",
      ownerUserId: 0,
      revision: 1,
    },
  ]);
  const [activeId, setActiveId] = useState(projects[0]!.id);
  const [runningByProject, setRunningByProject] = useState<
    Record<string, boolean>
  >({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, LocalMessage[]>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const active = projects.find((project) => project.id === activeId);
  const moduleId = workbenchModuleForView(view).id;
  const fixture = fixtures[view];
  const editKey = `${activeId}:${view}`;
  const running = runningByProject[activeId] ?? false;
  const modules = createWorkbenchModules(
    () => (
      <article className="workbench-preview-document">
        <div className="workbench-preview-document__meta">
          {fixture.subtitle}
        </div>
        <h2>{fixture.title}</h2>
        <p className="workbench-preview-document__project">
          {active?.name} · 示例成果
        </p>
        {edits[editKey] !== undefined ? (
          <p className="whitespace-pre-wrap">{edits[editKey]}</p>
        ) : (
          fixture.sections.map(([title, body]) => (
            <section key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </section>
          ))
        )}
        <button
          className="operator-secondary-button"
          onClick={() => setEditorOpen(true)}
        >
          编辑成果
        </button>
      </article>
    ),
    (next) => {
      setView(next);
      setMobileOpen(false);
    },
    view,
  );
  const module = modules.find((item) => item.id === moduleId)!;
  const previewMessages: LocalMessage[] = [
    {
      id: "user",
      role: "user",
      content: `帮我分析${active?.name ?? "这个项目"}的品牌资料，整理优化建议，并告诉我接下来应该做什么。`,
      timestamp: 0,
    },
    {
      id: "assistant",
      role: "assistant",
      content:
        "已整理这份品牌优化建议，可以在右侧查看。\n\n建议先完善品牌的核心事实与产品场景，再从客户最常问的问题开始优化回答。\n\n优先确认 **品牌定位与适用场景**（以企业已发布资料为准），后续内容和问答会共用这份基础。",
      stepGroups: previewTrace(active?.name ?? "当前项目"),
      timestamp: 1,
    },
    ...(messages[activeId] ?? []),
  ];
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
            aria-expanded={mobileOpen}
            aria-controls="operator-project-navigation"
            onClick={() => setMobileOpen((open) => !open)}
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
            projects={projects}
            activeProject={active}
            activeEntry="project"
            view={view}
            onSelectView={(next) => {
              setView(next);
              setMobileOpen(false);
            }}
            collapsed={compact ? !mobileOpen : collapsed}
            accountName="设计验收账号"
            onCollapse={
              compact
                ? () => setMobileOpen((value) => !value)
                : () => setCollapsed((value) => !value)
            }
            mobileOpen={mobileOpen}
            onCloseMobile={() => setMobileOpen(false)}
            onNavigate={() => undefined}
            onSelectProject={(id) => {
              setActiveId(id);
              setMobileOpen(false);
              setEditorOpen(false);
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
            <header className="operator-project-context">
              <strong>{active?.name ?? "未选择项目"}</strong>
              <span>{module.label}</span>
              <small className="ml-auto text-muted-foreground">设计预览</small>
            </header>
            <WorkbenchModuleContext.Provider value={module}>
              <AgentWorkbenchShell
                key={activeId}
                embedded
                projectId={activeId}
                moduleId={moduleId}
                title={module.label}
                resultTitle={module.resultTitle}
                result={module.renderResult()}
                resultKey={`${activeId}:${view}`}
                conversation={
                  <div className="workbench-preview-conversation">
                    <div className="workbench-conversation__toolbar">
                      <span>品牌资料分析与优化建议</span>
                      <button
                        className="ml-auto text-xs text-muted-foreground"
                        onClick={() =>
                          setRunningByProject((items) => ({
                            ...items,
                            [activeId]: !items[activeId],
                          }))
                        }
                      >
                        {running ? "完成演示任务" : "演示长任务"}
                      </button>
                    </div>
                    <div className="workbench-preview-messages">
                      {previewMessages.map((message) => (
                        <MessageBubble
                          key={message.id}
                          message={message}
                          isRunning={running && message.id === "assistant"}
                        />
                      ))}
                    </div>
                    <form
                      className="workbench-preview-composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const content = drafts[activeId]?.trim();
                        if (!content) return;
                        setMessages((items) => ({
                          ...items,
                          [activeId]: [
                            ...(items[activeId] ?? []),
                            {
                              id: crypto.randomUUID(),
                              role: "user",
                              content,
                              timestamp: Date.now(),
                            },
                          ],
                        }));
                        setDrafts((items) => ({ ...items, [activeId]: "" }));
                      }}
                    >
                      <textarea
                        aria-label="继续对话"
                        placeholder={`继续与 FrontMind 讨论${module.label}…`}
                        value={drafts[activeId] ?? ""}
                        onChange={(event) =>
                          setDrafts((items) => ({
                            ...items,
                            [activeId]: event.target.value,
                          }))
                        }
                      />
                      <div>
                        <span>FrontMind · 仅供布局预览</span>
                        <button
                          type="submit"
                          aria-label="发送预览消息"
                          disabled={!drafts[activeId]?.trim()}
                        >
                          <ArrowUp size={18} />
                        </button>
                      </div>
                    </form>
                  </div>
                }
              />
            </WorkbenchModuleContext.Provider>
          </main>
        </div>
        <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent>
            <DialogTitle>编辑{fixture.title}</DialogTitle>
            <DialogDescription>修改仅保存在当前设计预览。</DialogDescription>
            <textarea
              className="min-h-64 w-full rounded border p-3 text-sm"
              aria-label="成果正文"
              value={
                edits[editKey] ??
                fixture.sections
                  .map(([title, body]) => `${title}\n${body}`)
                  .join("\n\n")
              }
              onChange={(event) =>
                setEdits((items) => ({
                  ...items,
                  [editKey]: event.target.value,
                }))
              }
            />
            <button
              className="operator-primary-button"
              onClick={() => setEditorOpen(false)}
            >
              保存并返回
            </button>
          </DialogContent>
        </Dialog>
      </div>
    </OperatorThemeProvider>
  );
}
