import { useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Coins,
  Download,
  Gauge,
  History,
  MessageSquareText,
  PackageCheck,
  PanelsTopLeft,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserCog,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import KnowledgeBaseViewer from "@/components/KnowledgeBaseViewer";
import AdminDeliveryTicketWorkspace from "@/components/AdminDeliveryTicketWorkspace";
import CustomerDashboardMirror, {
  type CustomerDashboardMirrorSection,
} from "@/components/CustomerDashboardMirror";
import ManagerAssignmentEditor from "@/components/ManagerAssignmentEditor";
import PortalShell, { PortalCard } from "@/components/PortalShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  previewKnowledgeProgress,
  previewKnowledgeSnapshot,
} from "@/lib/preview-data";
import { adminDeliveryTicketPreviewFixtures } from "@/lib/development-preview-fixtures";
import {
  getRoleScopedPreviewAdminNav,
  previewUserNav,
  type PreviewAdminAccessLevel,
} from "@/lib/preview-navigation";
import AdminAgent from "@/pages/AdminAgent";
import type { DashboardPayload } from "@shared/dashboard";

const knowledgeNodes = [
  "企业身份与定位",
  "产品与解决方案",
  "技术研发与创新能力",
  "制造体系与质量控制",
  "客户行业与应用案例",
  "合作流程与售后服务",
  "团队组织与企业文化",
  "发展成果与品牌里程碑",
  "全球渠道与市场网络",
  "合规、资质与行业标准",
  "全网信息与媒体索引",
  "GEO 标准问答与证据映射",
];

type KnowledgeTab = "build" | "display";

export function PreviewUserKnowledge() {
  const [tab, setTab] = useState<KnowledgeTab>("build");
  const [selectedNode, setSelectedNode] = useState(11);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([
    {
      role: "assistant" as const,
      content:
        "已完成官网、全网公开信息与企业资料的交叉采集，共整理 32.8 万字、428 张图片。12 个知识节点均已逐项走完并核验。",
    },
    {
      role: "user" as const,
      content: "补充：海外服务网络以官网最新公开信息为准。",
    },
    {
      role: "assistant" as const,
      content:
        "已更新“全球渠道与市场网络”节点，并保留来源与核验日期。知识库已同步为 V6，可在“知识库展示”中查看完整内容。",
    },
  ]);

  const sendMessage = () => {
    const content = draft.trim();
    if (!content) return;
    setMessages((current) => [
      ...current,
      { role: "user", content },
      {
        role: "assistant",
        content: `已记录这项更新，并将继续在“${knowledgeNodes[selectedNode]}”节点中逐项核验后同步新版本。`,
      },
    ]);
    setDraft("");
    toast.success("样例对话已更新");
  };

  return (
    <PortalShell
      eyebrow="知识库智能体"
      title="企业知识库构建与展示"
      navItems={previewUserNav}
      accountLabel="验收企业用户"
      roleLabel="用户 · 验收预览"
      toolbar={<KnowledgeTabs tab={tab} onChange={setTab} />}
    >
      {tab === "display" ? (
        <KnowledgeBaseViewer snapshot={previewKnowledgeSnapshot} />
      ) : (
        <div className="grid min-h-[720px] gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
          <PortalCard className="flex min-h-[720px] min-w-0 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e1ee] px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5b2a86] text-white">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-[#171321]">
                      FrontMind 知识库智能体
                    </h2>
                  </div>
                  <p className="mt-1 text-xs text-[#716a80]">
                    当前节点：{knowledgeNodes[selectedNode]}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTab("display")}
              >
                <PanelsTopLeft className="h-4 w-4" />
                查看知识库
              </Button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto bg-[#fbf9fd] px-4 py-6 sm:px-7">
              <div className="mx-auto max-w-3xl rounded-2xl border border-[#e4d9eb] bg-white p-5 text-sm leading-7 text-[#4f485c] shadow-sm">
                <div className="flex items-center gap-2 text-[#16794f]">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-semibold">知识库构建进度 100%</span>
                </div>
                <p className="mt-2 text-[#716a80]">
                  所有节点均已完成逐项采集、确认与核验；最终知识库文件已准备完成，可由用户点击“更新知识库”同步展示版本。
                </p>
              </div>
              {messages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`mx-auto flex max-w-3xl ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-7 shadow-sm sm:px-5 ${
                      message.role === "user"
                        ? "rounded-br-md bg-[#5b2a86] text-white"
                        : "rounded-bl-md border border-[#e8e1ee] bg-white text-[#4f485c]"
                    }`}
                  >
                    {message.content}
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-[#e8e1ee] bg-white p-4 sm:p-5">
              <div className="flex items-end gap-3 rounded-2xl border border-[#dcd1e5] bg-[#fbf9fd] p-2 focus-within:border-[#5b2a86]/50">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="继续补充资料或修订口径…"
                  className="min-h-[62px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[#9a94a8]"
                />
                <Button
                  size="icon"
                  aria-label="发送消息"
                  className="h-10 w-10 shrink-0 rounded-xl bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={!draft.trim()}
                  onClick={sendMessage}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-2 text-center text-xs text-[#9a94a8]">
                每次更新都会重新走完受影响节点的核验流程，并同步新的知识库版本。
              </p>
            </div>
          </PortalCard>

          <PortalCard className="h-fit overflow-hidden">
            <div className="border-b border-[#e8e1ee] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-[#5b2a86]">知识树</p>
                  <h2 className="mt-1 font-semibold text-[#171321]">
                    12 个标准化节点
                  </h2>
                </div>
                <span className="text-2xl font-semibold text-[#16794f]">
                  100%
                </span>
              </div>
              <Progress
                value={100}
                className="mt-4 h-2 bg-[#16794f]/15 [&>div]:bg-[#16794f]"
              />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl bg-[#f3eef6] px-2 py-2 text-[#5b2a86]">
                  <b className="block text-base">32.8万</b>字
                </div>
                <div className="rounded-xl bg-[#f3eef6] px-2 py-2 text-[#5b2a86]">
                  <b className="block text-base">428</b>张图
                </div>
                <div className="rounded-xl bg-[#f3eef6] px-2 py-2 text-[#5b2a86]">
                  <b className="block text-base">186</b>篇文档
                </div>
              </div>
            </div>
            <div className="max-h-[650px] space-y-1 overflow-y-auto p-3 custom-scrollbar">
              {knowledgeNodes.map((node, index) => (
                <button
                  key={node}
                  type="button"
                  onClick={() => setSelectedNode(index)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    selectedNode === index
                      ? "bg-[#5b2a86] text-white"
                      : "text-[#4f485c] hover:bg-[#f3eef6]"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                      selectedNode === index
                        ? "bg-white/15 text-white"
                        : "bg-[#16794f]/10 text-[#16794f]"
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {index + 1}. {node}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 opacity-50" />
                </button>
              ))}
            </div>
          </PortalCard>
        </div>
      )}
    </PortalShell>
  );
}

function KnowledgeTabs({
  tab,
  onChange,
}: {
  tab: KnowledgeTab;
  onChange: (tab: KnowledgeTab) => void;
}) {
  return (
    <div className="flex rounded-xl border border-[#e1d8e8] bg-[#f3eef6] p-1">
      {(
        [
          ["build", "构建流程", MessageSquareText],
          ["display", "知识库展示", PanelsTopLeft],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm ${
            tab === value
              ? "bg-white text-[#5b2a86] shadow-sm"
              : "text-[#716a80]"
          }`}
        >
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function PreviewAdminAgent({
  previewAccessLevel = "delivery_admin",
}: {
  previewAccessLevel?: PreviewAdminAccessLevel;
}) {
  return <AdminAgent preview previewAccessLevel={previewAccessLevel} />;
}

export function PreviewAdminPresales() {
  const [keyDraft, setKeyDraft] = useState("");
  const [configured, setConfigured] = useState(true);
  const tasks = [
    ["官网知识库采集 · 验收企业 B", "2026/7/27 14:22", "6,820"],
    ["普通版单题构建 · 验收企业", "2026/7/26 10:08", "3,460"],
    ["官网知识库同步 · 验收企业 A", "2026/7/25 16:31", "8,120"],
  ];

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="官网任务与积分"
      navItems={getRoleScopedPreviewAdminNav("system_admin")}
      accountLabel="系统管理员验收账号"
      roleLabel="系统管理员 · 验收预览"
      toolbar={
        <Button
          variant="outline"
          onClick={() => toast.success("样例任务与积分已刷新")}
        >
          <RefreshCw className="h-4 w-4" />
          刷新状态
        </Button>
      }
    >
      <div className="grid items-start gap-5 lg:grid-cols-[1fr_1fr]">
        <PortalCard className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <BriefcaseBusiness className="h-5 w-5 text-[#5b2a86]" />
                <h2 className="font-semibold text-[#171321]">
                  官网售前 API Key
                </h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#716a80]">
                独立管理官网知识库采集与普通版前台流程所消耗的积分。
              </p>
            </div>
            <Badge
              className={
                configured
                  ? "bg-[#16794f]/10 text-[#16794f]"
                  : "bg-[#c89013]/10 text-[#8b6500]"
              }
            >
              {configured ? "连接正常" : "等待配置"}
            </Badge>
          </div>
          <div className="mt-5 rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
            <p className="text-xs text-[#857e91]">凭据指纹</p>
            <p className="mt-1 font-mono text-sm text-[#332842]">
              {configured ? "•••• •••• 7A9C" : "尚未配置"}
            </p>
          </div>
          <Input
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            className="mt-5"
            placeholder={configured ? "输入新的售前 API Key" : "输入 API Key"}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button
              variant="outline"
              onClick={() => toast.success("样例连接测试通过 · 286ms")}
            >
              测试连接
            </Button>
            <Button
              disabled={keyDraft.trim().length < 8}
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              onClick={() => {
                setConfigured(true);
                setKeyDraft("");
                toast.success("样例 API Key 已验证并加密保存");
              }}
            >
              验证并更换
            </Button>
          </div>
        </PortalCard>

        <PortalCard className="p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-[#5b2a86]" />
            <h2 className="font-semibold text-[#171321]">近 30 天真实用量</h2>
          </div>
          <p className="mt-5 text-4xl font-semibold text-[#5b2a86]">18,400</p>
          <p className="mt-1 text-xs text-[#857e91]">累计积分</p>
          <div className="mt-5 divide-y divide-[#eee8f2]">
            {tasks.map(([title, date, credit]) => (
              <article
                key={title}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#484057]">
                    {title}
                  </p>
                  <p className="mt-1 text-xs text-[#9a94a8]">{date}</p>
                </div>
                <span className="font-mono text-sm font-semibold text-[#5b2a86]">
                  {credit}
                </span>
              </article>
            ))}
          </div>
        </PortalCard>
      </div>
    </PortalShell>
  );
}

type PreviewWorkspaceTab = "service" | "tickets";

type PreviewManagedUser = {
  id: number;
  name: string;
  username: string;
};

const managedUsers: PreviewManagedUser[] = [
  { id: 1, name: "验收企业", username: "acceptance" },
  { id: 2, name: "验收企业 B", username: "acceptance_b" },
  { id: 3, name: "验收企业 C", username: "acceptance_c" },
];

const managerOptions = [
  { id: 101, label: "FrontMind Admin", secondary: "@admin" },
  { id: 102, label: "王晨", secondary: "@wangchen" },
  { id: 103, label: "陈悦", secondary: "@chenyue" },
  { id: 104, label: "林嘉", secondary: "@linjia" },
  { id: 105, label: "周宁", secondary: "@zhouning" },
  { id: 106, label: "赵恺", secondary: "@zhaokai" },
  { id: 107, label: "许薇", secondary: "@xuwei" },
  { id: 108, label: "沈航", secondary: "@shenhang" },
];

const initialPreviewAssignments: Record<number, number[]> = {
  1: [101, 102],
  2: [101, 103],
  3: [102],
};

export function filterPreviewManagedUsers(
  users: PreviewManagedUser[],
  assignments: Record<number, number[]>,
  accessLevel: PreviewAdminAccessLevel,
  managedAdminId = 101,
) {
  return accessLevel === "system_admin"
    ? users
    : users.filter((user) =>
        (assignments[user.id] ?? []).includes(managedAdminId),
      );
}

export function PreviewAdminUsers({
  previewAccessLevel = "system_admin",
}: {
  previewAccessLevel?: PreviewAdminAccessLevel;
}) {
  const systemAdmin = previewAccessLevel === "system_admin";
  const users = managedUsers;
  const [selectedId, setSelectedId] = useState(1);
  const [tab, setTab] = useState<PreviewWorkspaceTab>(() => {
    if (typeof window === "undefined") return "service";
    const requested = new URLSearchParams(window.location.search).get("tab");
    return ["service", "tickets"].includes(requested || "")
      ? (requested as PreviewWorkspaceTab)
      : "service";
  });
  const [servicePlans, setServicePlans] = useState<
    Record<number, "basic" | "advanced" | "luxury">
  >({
    1: "advanced",
    2: "luxury",
    3: "basic",
  });
  const [assignments, setAssignments] = useState<Record<number, number[]>>(
    initialPreviewAssignments,
  );
  const visibleUsers = useMemo(
    () => filterPreviewManagedUsers(users, assignments, previewAccessLevel),
    [assignments, previewAccessLevel, users],
  );
  const selectedUser =
    visibleUsers.find((user) => user.id === selectedId) ?? visibleUsers[0];

  const saveManagers = (managerIds: number[]) => {
    if (!systemAdmin || !selectedUser) return;
    setAssignments((current) => ({
      ...current,
      [selectedUser.id]: managerIds,
    }));
    toast.success("负责管理员已更新");
  };

  if (!selectedUser) return null;

  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title={systemAdmin ? "客户交付工作台" : "客户管理"}
      navItems={getRoleScopedPreviewAdminNav(previewAccessLevel)}
      accountLabel={`${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`}
      roleLabel={`${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`}
      toolbar={
        <Button
          variant="outline"
          size="sm"
          className="border-[#e1d8e8] bg-white"
          onClick={() => toast.success("样例数据已刷新")}
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
        <PortalCard className="h-fit overflow-hidden">
          <div className="border-b border-[#e8e1ee] p-5">
            <div className="flex items-center gap-2">
              <UserCog className="h-5 w-5 text-[#5b2a86]" />
              <h2 className="font-semibold text-[#171321]">客户列表</h2>
            </div>
            <div className="relative mt-4">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
              <Input placeholder="搜索用户" className="bg-[#fbf9fd] pl-9" />
            </div>
          </div>
          <div className="divide-y divide-[#eee8f2]">
            {visibleUsers.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => setSelectedId(account.id)}
                className={`w-full p-4 text-left transition ${
                  selectedId === account.id
                    ? "bg-[#5b2a86]/8"
                    : "hover:bg-[#fbf9fd]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#221a33]">
                      {account.name}
                    </p>
                    <p className="mt-1 text-xs text-[#9a94a8]">
                      @{account.username}
                    </p>
                  </div>
                  <span className="h-2.5 w-2.5 rounded-full bg-[#16794f]" />
                </div>
                <div className="mt-3 flex gap-1.5">
                  <Badge variant="secondary" className="text-xs">
                    管理员 {assignments[account.id]?.length || 0}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </PortalCard>

        <div className="min-w-0 space-y-5">
          <PortalCard className="p-5 sm:p-6">
            <div className="grid gap-5 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)] lg:items-start">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#5b2a86]">
                  客户工作空间
                </p>
                <h2
                  className="mt-1 truncate text-2xl font-semibold text-[#171321]"
                  title={selectedUser.name}
                >
                  {selectedUser.name}
                </h2>
                <p
                  className="mt-2 truncate text-sm text-[#716a80]"
                  title={`@${selectedUser.username}`}
                >
                  @{selectedUser.username}
                </p>
              </div>
              <ManagerAssignmentEditor
                key={selectedId}
                options={managerOptions}
                selectedIds={assignments[selectedId] ?? []}
                editable={systemAdmin}
                onSave={saveManagers}
              />
            </div>
            <div className="mt-6 flex flex-wrap gap-2 border-t border-[#eee8f2] pt-4">
              {(
                [
                  ["service", "用户流程", PackageCheck],
                  ["tickets", "工单", ClipboardList],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                    tab === value
                      ? "bg-[#5b2a86] text-white"
                      : "bg-[#f3eef6] text-[#716a80] hover:text-[#5b2a86]"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </PortalCard>

          {tab === "service" && (
            <div className="space-y-5">
              <PreviewServiceManager
                userName={selectedUser.name}
                plan={servicePlans[selectedId] || "basic"}
                editable={systemAdmin}
                onPlanChange={(plan) =>
                  setServicePlans((current) => ({
                    ...current,
                    [selectedId]: plan,
                  }))
                }
              />
              <PreviewDeliveryControl userName={selectedUser.name} />
            </div>
          )}
          {tab === "tickets" && (
            <AdminDeliveryTicketWorkspace
              userId={selectedUser.id}
              enterpriseName={selectedUser.name}
              customerUsername={selectedUser.username}
              canAdjustQuota={systemAdmin}
              canExecuteDelivery={systemAdmin}
              preview
              previewFixtures={adminDeliveryTicketPreviewFixtures}
            />
          )}
        </div>
      </div>
    </PortalShell>
  );
}

const previewProjectTeams = [
  {
    customer: "验收企业",
    username: "acceptance",
    roles: [
      ["AI 运维工程师", "林哲"],
      ["AI 监控与优化工程师", "周宁"],
      ["AI 内容分发工程师", "何川"],
    ],
  },
  {
    customer: "验收企业 B",
    username: "acceptance_b",
    roles: [
      ["AI 运维工程师", "赵恺"],
      ["AI 监控与优化工程师", "许薇"],
      ["AI 内容分发工程师", "沈航"],
    ],
  },
  {
    customer: "验收企业 C",
    username: "acceptance_c",
    roles: [
      ["AI 运维工程师", "待配置"],
      ["AI 监控与优化工程师", "待配置"],
      ["AI 内容分发工程师", "待配置"],
    ],
  },
] as const;

export function PreviewAdminDeliveryRoles({
  previewAccessLevel = "system_admin",
}: {
  previewAccessLevel?: PreviewAdminAccessLevel;
}) {
  const systemAdmin = previewAccessLevel === "system_admin";
  const teams = systemAdmin
    ? previewProjectTeams
    : previewProjectTeams.slice(0, 2);
  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="客户项目团队"
      navItems={getRoleScopedPreviewAdminNav(previewAccessLevel)}
      accountLabel={`${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`}
      roleLabel={`${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`}
    >
      <div className="mb-5 rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-sm leading-6 text-muted-foreground">
        项目岗位在这里绑定工程师；绑定后，新增和未结束工单会自动归属对应岗位人员。
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {teams.map((team) => (
          <PortalCard key={team.username} className="overflow-hidden">
            <div className="border-b border-[#eee8f2] px-5 py-4">
              <h2 className="font-semibold text-[#171321]">{team.customer}</h2>
              <p className="mt-1 text-xs text-[#857e91]">@{team.username}</p>
            </div>
            <div className="divide-y divide-[#eee8f2] px-5">
              {team.roles.map(([role, engineer]) => (
                <div
                  key={role}
                  className="flex items-center justify-between gap-4 py-4 text-sm"
                >
                  <span className="text-[#5f576c]">{role}</span>
                  <Badge
                    variant="outline"
                    className={
                      engineer === "待配置"
                        ? "border-amber-300 text-amber-700"
                        : "border-emerald-300 text-emerald-700"
                    }
                  >
                    {engineer}
                  </Badge>
                </div>
              ))}
            </div>
          </PortalCard>
        ))}
      </div>
    </PortalShell>
  );
}

const previewManagementTickets = [
  {
    id: "ticket-1",
    customer: "验收企业",
    title: "企业知识库构建异常处理",
    role: "AI 运维工程师",
    engineer: "林哲",
    status: "待处理",
  },
  {
    id: "ticket-2",
    customer: "验收企业 B",
    title: "品牌词库与问题目录",
    role: "AI 监控与优化工程师",
    engineer: "许薇",
    status: "待处理",
  },
  {
    id: "ticket-3",
    customer: "验收企业",
    title: "官网企业事实内容发布",
    role: "AI 内容分发工程师",
    engineer: "何川",
    status: "已完成",
  },
] as const;

export function PreviewAdminDispatch({
  previewAccessLevel = "system_admin",
}: {
  previewAccessLevel?: PreviewAdminAccessLevel;
}) {
  const systemAdmin = previewAccessLevel === "system_admin";
  const pending = previewManagementTickets.filter(
    (ticket) => ticket.status === "待处理",
  );
  const completed = previewManagementTickets.filter(
    (ticket) => ticket.status === "已完成",
  );
  return (
    <PortalShell
      eyebrow="管理中心 · 客户与服务"
      title="工单"
      navItems={getRoleScopedPreviewAdminNav(previewAccessLevel)}
      accountLabel={`${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`}
      roleLabel={`${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <PortalCard className="p-4">
          <p className="text-xs text-muted-foreground">待处理</p>
          <p className="mt-1 text-2xl font-semibold">{pending.length}</p>
        </PortalCard>
        <PortalCard className="p-4">
          <p className="text-xs text-muted-foreground">已完成</p>
          <p className="mt-1 text-2xl font-semibold">{completed.length}</p>
        </PortalCard>
      </div>
      {(
        [
          ["待处理", pending],
          ["已完成", completed],
        ] as const
      ).map(([label, tickets]) => (
        <PortalCard key={label} className="mb-5 overflow-hidden">
          <div className="border-b border-[#eee8f2] px-5 py-4">
            <h2 className="font-semibold text-[#171321]">{label}</h2>
          </div>
          <div className="divide-y divide-[#eee8f2] px-5">
            {tickets.map((ticket) => (
              <article key={ticket.id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-[#332842]">{ticket.title}</p>
                    <p className="mt-1 text-sm text-[#716a80]">
                      {ticket.customer} · {ticket.role} · {ticket.engineer}
                    </p>
                  </div>
                  <Badge variant="outline">{ticket.status}</Badge>
                </div>
              </article>
            ))}
          </div>
        </PortalCard>
      ))}
    </PortalShell>
  );
}

export const previewDeliveryModules = [
  {
    key: "enterprise-profile",
    title: "企业基础资料",
    format: "CSV",
    filename: "enterprise-profile-current.csv",
    content: "field,value,source\n",
  },
  {
    key: "keyword-bank",
    title: "品牌全域词库",
    format: "CSV",
    filename: "keyword-bank-current.csv",
    content: "group,keyword,description,revision\n",
  },
  {
    key: "questions",
    title: "问题目录",
    format: "CSV",
    filename: "questions-current.csv",
    content: "question_id,group,question,status,revision\n",
  },
  {
    key: "response-logic",
    title: "应答逻辑确认稿",
    format: "CSV",
    filename: "response-logic-current.csv",
    content:
      "question_id,user_concern,core_conclusion,execution_path,official_evidence,boundary,forbidden_expression,final_answer,revision\n",
  },
  {
    key: "monitoring",
    title: "问题监控与引用",
    format: "CSV",
    filename: "monitoring-current.csv",
    content:
      "question_id,platform,model,answer_id,answer_date,answer,citation_url,citation_scope,revision\n",
  },
  {
    key: "progress-report",
    title: "进度报告",
    format: "JSON",
    filename: "progress-report-current.json",
    content: JSON.stringify(
      {
        revision: 1,
        questions: [],
      },
      null,
      2,
    ),
  },
  {
    key: "content-assets",
    title: "AI 友好内容资产",
    format: "CSV",
    filename: "content-assets-current.csv",
    content:
      "asset_id,type,title,summary,published_media,published_url,status,revision\n",
  },
] as const;

const previewCustomerDashboardPayload: DashboardPayload = {
  brandName: "验收企业",
  headline: "企业级 GEO 用户流程",
  summary: "这里展示管理员发布后客户实际看到的品牌资料与阶段交付结果。",
  metrics: [
    { label: "正式问题", value: 8, unit: "项" },
    { label: "监控回答", value: 24, unit: "条" },
  ],
  sections: [
    {
      id: "brand-overview",
      title: "品牌建设",
      subtitle: "客户可见的企业事实与品牌内容",
      body: "企业资料、核心优势、产品服务和公开证据均在此持续更新。",
      items: [
        {
          title: "核心优势",
          description: "研发、产品与交付能力已经完成结构化整理。",
          meta: "客户正式版本",
        },
      ],
      tables: [],
    },
  ],
  keywordTables: [
    {
      id: "global-keywords",
      title: "品牌全域词库",
      columns: ["问题词", "场景", "优先级"],
      rows: [["如何选择企业级 GEO 服务？", "方案选型", "重点覆盖"]],
    },
  ],
  questions: [
    {
      id: "question-1",
      groupId: "scenario",
      groupTitle: "产品场景词",
      groupSubtitle: "决策问题",
      tone: "teal",
      question: "企业如何建立可被 AI 准确引用的品牌知识？",
      intent: "了解知识库、内容与监控之间的完整交付关系。",
      summary: "已由客户提交并完成审核。",
    },
  ],
  monitoringAnswers: [
    {
      id: "answer-1",
      questionId: "question-1",
      platform: "AI 搜索平台",
      collectedAt: "2026-07-30",
      answerNo: 1,
      content: "当前回答已经能够引用企业官网与公开媒体中的核心事实。",
      citationCount: 1,
      screenshotUrl: "",
      citations: [
        {
          id: "citation-1",
          title: "企业官网",
          url: "https://example.com",
          media: "官网",
        },
      ],
    },
  ],
  citations: [],
  contentAssets: [
    {
      id: "content-1",
      group: "FAQ",
      name: "AI 友好问答内容",
      description: "围绕客户已确认问题生成并发布的结构化内容。",
      wordRange: "800–1200 字",
      scene: "官网 FAQ",
      articles: [
        {
          id: "article-1",
          title: "企业如何建立品牌全域知识库？",
          intro: "从品牌事实、问题目录到持续监控形成统一闭环。",
          sections: [],
        },
      ],
    },
  ],
  optimizationReport: null,
  progressReports: [],
};

function downloadPreviewDeliveryTemplate(
  module: (typeof previewDeliveryModules)[number],
) {
  const type =
    module.format === "JSON"
      ? "application/json;charset=utf-8"
      : "text/csv;charset=utf-8";
  const blob = new Blob([`\uFEFF${module.content}`], { type });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = module.filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

export function PreviewDeliveryControl({ userName }: { userName: string }) {
  const [revision, setRevision] = useState(6);
  const [previewSection, setPreviewSection] =
    useState<CustomerDashboardMirrorSection>("keywords");
  const previewPayload = useMemo(
    () => ({
      ...previewCustomerDashboardPayload,
      brandName: userName,
      headline: `${userName} · GEO 用户流程`,
    }),
    [userName],
  );

  const publishSample = (title: string) => {
    setRevision((current) => current + 1);
    toast.success(`${title}样例已发布`, {
      description: "正式环境会先执行结构校验，并将发布快照写入版本历史。",
    });
  };

  return (
    <div className="space-y-5">
      <PortalCard className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-[#e8e1ee] bg-[linear-gradient(135deg,#fbf8fd,#f4edf8)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="text-xs font-semibold text-[#5b2a86]">
              用户流程内容管理
            </p>
            <h3 className="mt-1 font-semibold text-[#171321]">{userName}</h3>
            <p className="mt-2 text-sm leading-6 text-[#716a80]">
              按用户真实页面分区维护品牌内容、问题监控、进度报告与内容资产。
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setPreviewSection("keywords")}
            >
              预览
            </Button>
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              onClick={() => publishSample("结构化内容")}
            >
              发布修改
            </Button>
          </div>
        </div>
        <div className="border-b border-[#e8e1ee] bg-[#f6f3f8] p-4 sm:p-6">
          <CustomerDashboardMirror
            payload={previewPayload}
            initialSection={previewSection}
            knowledgePreview={{
              progress: previewKnowledgeProgress,
              snapshot: previewKnowledgeSnapshot,
            }}
            heading="用户当前所见"
            description="所有分区均读取与用户端相同的数据，发布前可在这里逐项核对。"
          />
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
          {previewDeliveryModules.map((module) => (
            <article
              key={module.key}
              className="rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4"
            >
              <p className="font-semibold text-[#332842]">{module.title}</p>
              <p className="mt-1 text-xs text-[#857e91]">{module.format}</p>
              <div className="mt-4 grid gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    setPreviewSection(previewSectionForModule(module.key))
                  }
                >
                  预览用户所见
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => downloadPreviewDeliveryTemplate(module)}
                >
                  <Download className="h-4 w-4" />
                  下载当前内容模板
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => publishSample(module.title)}
                >
                  上传并校验
                </Button>
              </div>
            </article>
          ))}
        </div>
      </PortalCard>

      <PortalCard className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#e8e1ee] p-5 sm:p-6">
          <div>
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 text-[#5b2a86]" />
              <h3 className="font-semibold text-[#171321]">交付内容发布历史</h3>
            </div>
            <p className="mt-2 text-sm text-[#716a80]">
              仅记录企业资料、指标与看板板块；其他业务内容由各自模块管理。恢复历史时会生成新版本，不会覆盖旧记录。
            </p>
          </div>
          <Badge className="bg-[#5b2a86]/10 text-[#5b2a86]">
            当前 R{revision}
          </Badge>
        </div>
        <div className="divide-y divide-[#eee8f2]">
          {[
            [revision, "当前版本", "管理员结构化编辑"],
            [revision - 1, "历史版本", "progress-report.json"],
            [revision - 2, "历史版本", "引用分析数据导出.xlsx"],
          ].map(([itemRevision, status, source]) => (
            <article
              key={String(itemRevision)}
              className="grid gap-3 px-5 py-4 sm:grid-cols-[90px_minmax(0,1fr)_auto] sm:items-center sm:px-6"
            >
              <strong className="text-[#332842]">R{itemRevision}</strong>
              <div>
                <p className="text-sm font-medium text-[#484057]">{status}</p>
                <p className="mt-1 text-xs text-[#857e91]">{source}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    toast.success(`已打开 R${itemRevision} 只读预览`)
                  }
                >
                  查看
                </Button>
                {status !== "当前版本" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => publishSample(`R${itemRevision} 恢复版本`)}
                  >
                    恢复
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </PortalCard>
    </div>
  );
}

function previewSectionForModule(
  module: (typeof previewDeliveryModules)[number]["key"],
): CustomerDashboardMirrorSection {
  if (module === "keyword-bank") return "keywords";
  if (module === "questions" || module === "response-logic") {
    return "questions";
  }
  if (module === "monitoring") return "monitoring";
  if (module === "progress-report") return "report";
  if (module === "content-assets") return "content";
  return "keywords";
}

function PreviewServiceManager({
  userName,
  plan,
  editable,
  onPlanChange,
}: {
  userName: string;
  plan: "basic" | "advanced" | "luxury";
  editable: boolean;
  onPlanChange: (plan: "basic" | "advanced" | "luxury") => void;
}) {
  const planMeta = {
    basic: {
      name: "普通版",
      quota: "每个订单 1 个非行业词问题，可在同一账号累加",
    },
    advanced: {
      name: "进阶版",
      quota: "1 行业词 · 1 竞品对比词 · 1 美誉舆情词 · 5 产品场景词",
    },
    luxury: {
      name: "豪华版",
      quota: "4 行业词 · 4 竞品对比词 · 4 美誉舆情词 · 20 产品场景词",
    },
  }[plan];
  return (
    <div className="space-y-5">
      <PortalCard className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <PackageCheck className="h-5 w-5 text-[#5b2a86]" />
              <h3 className="font-semibold text-[#171321]">套餐与服务周期</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#716a80]">
              {userName} 当前为
              <strong className="mx-1 text-[#332842]">{planMeta.name}</strong>
            </p>
            <p className="mt-1 text-xs text-[#9a94a8]">
              商业权益仅系统管理员可调整；所属管理员只能查看。
            </p>
          </div>
        </div>

        {editable && (
          <div className="mt-6 grid gap-4 border-t border-[#eee8f2] pt-5 md:grid-cols-2">
            <label className="text-xs font-semibold text-[#716a80]">
              套餐版本
              <select
                aria-label="套餐版本"
                value={plan}
                onChange={(event) =>
                  onPlanChange(
                    event.target.value as "basic" | "advanced" | "luxury",
                  )
                }
                className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
              >
                <option value="basic">普通版 · 30 天单题</option>
                <option value="advanced">进阶版</option>
                <option value="luxury">豪华版</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-[#716a80]">
              合同状态
              <select
                aria-label="合同状态"
                defaultValue="active"
                className="mt-2 h-10 w-full rounded-xl border border-[#ddd3e4] bg-white px-3 text-sm text-[#332842]"
              >
                <option value="active">生效</option>
                <option value="scheduled">待生效</option>
                <option value="pending">待确认</option>
              </select>
            </label>
            <Input aria-label="签署主体" placeholder="企业名 / 签署主体" />
          </div>
        )}
        <div className="mt-5 rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4">
          <p className="text-xs font-semibold text-[#716a80]">当前权益</p>
          <p className="mt-2 text-sm leading-6 text-[#332842]">
            {planMeta.quota}
          </p>
        </div>
        {editable && (
          <div className="mt-5 flex justify-end">
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              onClick={() =>
                toast.success("样例套餐已保存", {
                  description: `${userName} · ${planMeta.name}`,
                })
              }
            >
              保存套餐配置
            </Button>
          </div>
        )}
      </PortalCard>
    </div>
  );
}

type PreviewPlanCode = "basic" | "advanced" | "luxury";
type PreviewAccountRole = "管理员" | "用户";
type PreviewAccountDraft = {
  name: string;
  username: string;
  role: PreviewAccountRole;
  planCode?: PreviewPlanCode;
  marketEdition?: "domestic" | "overseas";
  adminAccessLevel?: "delivery_admin" | "system_admin";
};

export function previewAccountDraftIsValid(input: {
  name: string;
  username: string;
  role: PreviewAccountRole;
  planCode?: PreviewPlanCode | "";
  marketEdition?: "domestic" | "overseas" | "";
  password?: string;
  confirmPassword?: string;
}) {
  if (!input.name.trim() || !input.username.trim()) return false;
  if (
    (input.password?.length ?? 0) < 8 ||
    input.password !== input.confirmPassword
  ) {
    return false;
  }
  return (
    input.role === "管理员" ||
    (Boolean(input.planCode) && Boolean(input.marketEdition))
  );
}

export function PreviewCreateAccountDialog({
  open,
  onOpenChange,
  userOnly = false,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userOnly?: boolean;
  onCreated: (draft: PreviewAccountDraft) => void;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<PreviewAccountRole>("用户");
  const [planCode, setPlanCode] = useState<PreviewPlanCode | "">("");
  const [marketEdition, setMarketEdition] = useState<
    "domestic" | "overseas" | ""
  >("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [adminAccessLevel, setAdminAccessLevel] = useState<
    "delivery_admin" | "system_admin"
  >("delivery_admin");

  const reset = () => {
    setName("");
    setUsername("");
    setRole("用户");
    setPlanCode("");
    setMarketEdition("");
    setPassword("");
    setConfirmPassword("");
    setAdminAccessLevel("delivery_admin");
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };
  const valid = previewAccountDraftIsValid({
    name,
    username,
    role,
    planCode,
    marketEdition,
    password,
    confirmPassword,
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {userOnly ? "创建客户并开通套餐" : "创建新账号"}
          </DialogTitle>
          <DialogDescription>
            {userOnly
              ? "创建客户时必须选择套餐；正式环境会建立待确认合同，完成商业证据核验后开通权益。"
              : "用户账号必须选择套餐；管理员账号不设置套餐，并需配置初始密码与权限。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <label className="block text-sm font-medium text-[#484057]">
            显示名称
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
              placeholder="企业或管理员名称"
            />
          </label>
          <label className="block text-sm font-medium text-[#484057]">
            用户名
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-2"
              placeholder="用于登录"
            />
          </label>
          {!userOnly && (
            <label className="block text-sm font-medium text-[#484057]">
              角色
              <select
                aria-label="账号角色"
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as PreviewAccountRole);
                  setPlanCode("");
                }}
                className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="用户">用户</option>
                <option value="管理员">管理员</option>
              </select>
            </label>
          )}
          <label className="block text-sm font-medium text-[#484057]">
            初始密码
            <Input
              aria-label="初始密码"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2"
              placeholder="至少 8 个字符"
            />
          </label>
          <label className="block text-sm font-medium text-[#484057]">
            确认初始密码
            <Input
              aria-label="确认初始密码"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="mt-2"
              placeholder="再次输入初始密码"
            />
          </label>
          {role === "用户" ? (
            <>
              <label className="block text-sm font-medium text-[#484057]">
                客户套餐
                <select
                  aria-label="客户套餐"
                  value={planCode}
                  onChange={(event) =>
                    setPlanCode(event.target.value as PreviewPlanCode | "")
                  }
                  className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">请选择套餐</option>
                  <option value="basic">普通版</option>
                  <option value="advanced">进阶版</option>
                  <option value="luxury">豪华版</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-[#484057]">
                客户版本
                <select
                  aria-label="客户版本"
                  value={marketEdition}
                  onChange={(event) =>
                    setMarketEdition(
                      event.target.value as "domestic" | "overseas" | "",
                    )
                  }
                  className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">请选择海内版或海外版</option>
                  <option value="domestic">海内版</option>
                  <option value="overseas">海外版</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="block text-sm font-medium text-[#484057]">
                管理员权限
                <select
                  aria-label="管理员权限"
                  value={adminAccessLevel}
                  onChange={(event) =>
                    setAdminAccessLevel(
                      event.target.value as "delivery_admin" | "system_admin",
                    )
                  }
                  className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="delivery_admin">交付管理员</option>
                  <option value="system_admin">系统管理员</option>
                </select>
              </label>
            </>
          )}
          <Button
            className="w-full bg-[#5b2a86] hover:bg-[#49216c]"
            disabled={!valid}
            onClick={() => {
              const draft: PreviewAccountDraft = {
                name: name.trim(),
                username: username.trim(),
                role,
                ...(role === "用户"
                  ? {
                      planCode: planCode as PreviewPlanCode,
                      marketEdition: marketEdition as "domestic" | "overseas",
                    }
                  : { adminAccessLevel }),
              };
              onCreated(draft);
              handleOpenChange(false);
              toast.success(
                role === "用户"
                  ? "样例客户与待确认套餐已创建"
                  : "样例管理员已创建",
              );
            }}
          >
            {role === "用户" ? "创建客户并开通套餐" : "创建管理员"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PreviewAccount = {
  id: number;
  name: string;
  username: string;
  role: PreviewAccountRole;
  active: boolean;
  planCode?: PreviewPlanCode;
  marketEdition?: "domestic" | "overseas";
  adminAccessLevel?: "delivery_admin" | "system_admin";
};

const initialAccounts: PreviewAccount[] = [
  {
    id: 1,
    name: "系统管理员",
    username: "admin",
    role: "管理员",
    active: true,
  },
  {
    id: 2,
    name: "交付管理员",
    username: "delivery_admin",
    role: "管理员",
    active: true,
  },
  {
    id: 3,
    name: "验收企业",
    username: "acceptance",
    role: "用户",
    active: true,
    planCode: "advanced",
  },
  {
    id: 4,
    name: "验收企业 B",
    username: "acceptance_b",
    role: "用户",
    active: true,
    planCode: "luxury",
  },
  {
    id: 5,
    name: "验收企业 C",
    username: "acceptance_c",
    role: "用户",
    active: false,
    planCode: "basic",
  },
];

export function PreviewAdminAccounts({
  previewAccessLevel = "system_admin",
}: {
  previewAccessLevel?: PreviewAdminAccessLevel;
}) {
  const systemAdmin = previewAccessLevel === "system_admin";
  const [accounts, setAccounts] = useState(initialAccounts);
  const [createOpen, setCreateOpen] = useState(false);
  const visibleAccounts = systemAdmin
    ? accounts
    : accounts.filter((account) => account.role === "用户");
  const activeCount = useMemo(
    () => visibleAccounts.filter((account) => account.active).length,
    [visibleAccounts],
  );

  return (
    <PortalShell
      eyebrow="管理员工作台 · 账号管理"
      title="账号与权限"
      navItems={getRoleScopedPreviewAdminNav(previewAccessLevel)}
      accountLabel={`${systemAdmin ? "系统管理员" : "交付管理员"}验收账号`}
      roleLabel={`${systemAdmin ? "系统管理员" : "交付管理员"} · 验收预览`}
      toolbar={
        <Button
          className="bg-[#5b2a86] hover:bg-[#49216c]"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {systemAdmin ? "创建账号" : "创建客户账号"}
        </Button>
      }
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <MetricCard
          label="账号总数"
          value={String(visibleAccounts.length)}
          icon={Users}
        />
        <MetricCard
          label="已启用"
          value={String(activeCount)}
          icon={UserRoundCheck}
        />
        <MetricCard
          label="管理员"
          value={String(
            visibleAccounts.filter((account) => account.role === "管理员")
              .length,
          )}
          icon={ShieldCheck}
        />
      </div>
      <PortalCard className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[#e8e1ee] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-[#171321]">账号列表</h2>
            <p className="mt-1 text-sm text-[#716a80]">
              创建用户账号、设置角色并管理账号状态。
            </p>
          </div>
          <div className="relative sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
            <Input
              placeholder="搜索名称或用户名"
              className="bg-[#fbf9fd] pl-9"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#fbf9fd] text-xs text-[#716a80]">
              <tr>
                <th className="px-5 py-3 font-medium">账号</th>
                <th className="px-5 py-3 font-medium">角色</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eee8f2]">
              {visibleAccounts.map((account) => (
                <tr key={account.id}>
                  <td className="px-5 py-4">
                    <p className="font-medium text-[#221a33]">{account.name}</p>
                    <p className="mt-1 text-xs text-[#9a94a8]">
                      @{account.username}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <Badge variant="secondary">{account.role}</Badge>
                    {account.planCode && (
                      <p className="mt-1 text-xs text-[#857e91]">
                        {account.planCode === "basic"
                          ? "普通版"
                          : account.planCode === "advanced"
                            ? "进阶版"
                            : "豪华版"}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex items-center gap-2 ${account.active ? "text-[#16794f]" : "text-[#ba2454]"}`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${account.active ? "bg-[#16794f]" : "bg-[#ba2454]"}`}
                      />
                      {account.active ? "已启用" : "已停用"}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          toast.success(`已为 ${account.name} 打开密码重置样式`)
                        }
                      >
                        重置密码
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setAccounts((current) =>
                            current.map((item) =>
                              item.id === account.id
                                ? { ...item, active: !item.active }
                                : item,
                            ),
                          )
                        }
                      >
                        {account.active ? "停用" : "启用"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PortalCard>

      <PreviewCreateAccountDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        userOnly={!systemAdmin}
        onCreated={(draft) =>
          setAccounts((current) => [
            ...current,
            {
              id: Math.max(...current.map((account) => account.id)) + 1,
              ...draft,
              active: true,
            },
          ])
        }
      />
    </PortalShell>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Users;
}) {
  return (
    <PortalCard className="flex items-center justify-between p-5">
      <div>
        <p className="text-sm text-[#716a80]">{label}</p>
        <p className="mt-2 text-2xl font-semibold text-[#221a33]">{value}</p>
      </div>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5b2a86]/10 text-[#5b2a86]">
        <Icon className="h-5 w-5" />
      </div>
    </PortalCard>
  );
}
