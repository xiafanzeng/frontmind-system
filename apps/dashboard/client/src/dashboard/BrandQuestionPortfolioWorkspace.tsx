import {
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

import type { ServicePortalView } from "./service-portal";

type PortfolioQuestion = {
  id: string;
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario";
  question: string;
  intent: string | null;
  rationale: string | null;
  evidence: Array<{
    documentPath: string;
    excerpt: string;
    relevance: string;
  }>;
  risks: string[];
  status: "candidate" | "selected" | "archived";
  selectionApprovalStatus: "not_requested" | "pending" | "approved";
  locked: boolean;
  revision: number;
};

export type BrandQuestionSelectionDraft = Pick<
  PortfolioQuestion,
  "id" | "question" | "category" | "revision" | "status"
>;

type QuestionCatalogTicket = {
  id: string;
  category?: string | null;
  publicStatus?: "pending" | "completed" | null;
  publicStatusLabel?: string | null;
};

const CATEGORY_META = {
  industry: {
    title: "行业排名词",
    description: "行业入口与品类决策问题",
  },
  competitor_comparison: {
    title: "竞品对比词",
    description: "差异定位与选择依据",
  },
  reputation: {
    title: "美誉舆情词",
    description: "信任证据与品牌口碑",
  },
  product_scenario: {
    title: "产品场景词",
    description: "应用需求与决策场景",
  },
} as const;

const CATEGORY_ORDER = [
  "industry",
  "competitor_comparison",
  "reputation",
  "product_scenario",
] as const;

export default function BrandQuestionPortfolioWorkspace({
  portal,
  onPortalRefresh,
  onUseQuestion,
  questionCatalogTicket,
  hasPublishedKeywordTables = false,
  ticketLoading = false,
  onTicketRefresh,
}: {
  portal: ServicePortalView;
  onPortalRefresh?: () => void;
  onUseQuestion: (question: BrandQuestionSelectionDraft) => void;
  questionCatalogTicket?: QuestionCatalogTicket | null;
  hasPublishedKeywordTables?: boolean;
  ticketLoading?: boolean;
  onTicketRefresh?: () => Promise<unknown> | unknown;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const portfolioQuery = (trpc.workspace as any).questionPortfolio.useQuery(
    undefined,
    {
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  ) as {
    data?: {
      questions?: PortfolioQuestion[];
    };
    isLoading: boolean;
    isFetching: boolean;
    refetch: () => Promise<unknown>;
  };
  const visibleQuestions = portfolioQuery.data?.questions ?? [];

  const filteredQuestions = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return visibleQuestions.filter((question) => {
      if (categoryFilter !== "all" && question.category !== categoryFilter) {
        return false;
      }
      const selectionState =
        question.status === "selected"
          ? "selected"
          : question.selectionApprovalStatus === "pending"
            ? "pending"
            : "candidate";
      if (statusFilter !== "all" && selectionState !== statusFilter) {
        return false;
      }
      if (!keyword) return true;
      return [question.question, question.intent, question.rationale].some(
        (value) => value?.toLowerCase().includes(keyword),
      );
    });
  }, [categoryFilter, searchTerm, statusFilter, visibleQuestions]);

  const selectedCount = visibleQuestions.filter(
    (question) => question.status === "selected",
  ).length;
  const catalogPublished =
    questionCatalogTicket?.publicStatus === "completed" ||
    visibleQuestions.length > 0 ||
    hasPublishedKeywordTables;

  const ticketStatus = (() => {
    if (ticketLoading) {
      return {
        title: "正在读取配置需求",
        description: "正在同步品牌全域词库的配置状态。",
        tone: "text-[#5b2a86]",
      };
    }
    if (!questionCatalogTicket && catalogPublished) {
      return {
        title: "品牌全域词库已发布",
        description:
          "AI 监控与优化工程师已完成本阶段配置，可在下方查看正式词表并选择问题。",
        tone: "text-emerald-700",
      };
    }
    if (!questionCatalogTicket) {
      return {
        title: "等待配置需求同步",
        description:
          "知识库发布后，系统会自动向 AI 监控与优化工程师提交品牌词库配置需求，无需客户重复操作。",
        tone: "text-amber-700",
      };
    }
    if (questionCatalogTicket.publicStatus === "completed") {
      return {
        title: "品牌全域词库已发布",
        description:
          "AI 监控与优化工程师已完成本阶段配置，可在下方查看正式词表并选择问题。",
        tone: "text-emerald-700",
      };
    }
    return {
      title: "配置需求待处理",
      description: "配置完成后会在本页发布正式词库。",
      tone: "text-red-700",
    };
  })();

  const refreshWorkspace = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        portfolioQuery.refetch(),
        Promise.resolve(onTicketRefresh?.()),
        Promise.resolve(onPortalRefresh?.()),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="page-shell brand-deep-page">
      <div className="flex flex-col gap-5 rounded-[24px] border border-[#e6ddea] bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="fm-eyebrow text-[#6b378f]">
              MindPromise 智诺 · 品牌建设
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-[#1f1830]">
              品牌全域词库
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#716a80]">
              品牌词库由 AI
              监控与优化工程师基于当前已发布的企业知识库配置。客户选题后进入专业审核，确认启动后才会锁定并占用额度。
            </p>
          </div>
          <Button
            variant="outline"
            disabled={refreshing || portfolioQuery.isFetching}
            onClick={() => void refreshWorkspace()}
          >
            <RefreshCw
              className={`h-4 w-4 ${
                refreshing || portfolioQuery.isFetching ? "animate-spin" : ""
              }`}
            />
            刷新需求与词库
          </Button>
        </div>

        <div
          className="flex flex-col gap-3 rounded-2xl border border-[#d9c8e5] bg-[#f8f3fb] p-4 sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <div className="flex items-start gap-3">
            {catalogPublished ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : ticketLoading ? (
              <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[#5b2a86]" />
            ) : (
              <Wrench className="mt-0.5 h-5 w-5 shrink-0 text-[#5b2a86]" />
            )}
            <div>
              <p className={`text-sm font-semibold ${ticketStatus.tone}`}>
                {ticketStatus.title}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#716a80]">
                {ticketStatus.description}
              </p>
            </div>
          </div>
          {questionCatalogTicket && (
            <span
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
                questionCatalogTicket.publicStatus === "completed"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {questionCatalogTicket.publicStatus === "completed"
                ? "已完成"
                : "待处理"}
            </span>
          )}
        </div>
      </div>

      <div className="saas-toolbar keyword-toolbar-saas mt-5">
        <div className="saas-search">
          <Search size={16} />
          <input
            type="search"
            placeholder="搜索问题、意图或说明..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          {searchTerm && (
            <button
              type="button"
              className="clear-btn"
              aria-label="清空搜索"
              onClick={() => setSearchTerm("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="filter-group">
          <div className="filter-item">
            <label htmlFor="brand-question-category">分类</label>
            <select
              id="brand-question-category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="all">全部分类</option>
              {CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_META[category].title}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-item">
            <label htmlFor="brand-question-status">状态</label>
            <select
              id="brand-question-status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="candidate">待选择</option>
              <option value="pending">待工程师确认</option>
              <option value="selected">已确认</option>
            </select>
          </div>
        </div>
      </div>

      <div className="keyword-stats-bar">
        <span>
          共 <strong>{visibleQuestions.length}</strong> 个候选问题
        </span>
        <span>
          当前显示 <strong>{filteredQuestions.length}</strong> 个
        </span>
        <span>
          已确认 <strong>{selectedCount}</strong> 个
        </span>
      </div>

      <section className="panel global-keyword-panel">
        <div className="panel-head">
          <div>
            <h3>词库问题</h3>
            <p className="panel-subtitle">
              按分类筛选问题，并提交给 AI 监控与优化工程师确认。
            </p>
          </div>
        </div>
        <div className="keyword-table-wrap">
          <table className="keyword-table">
            <thead>
              <tr>
                <th>问题</th>
                <th>用户意图</th>
                <th>分类</th>
                <th>选题状态</th>
                <th>问题优化</th>
              </tr>
            </thead>
            <tbody>
              {portfolioQuery.isLoading ? (
                <tr>
                  <td colSpan={5}>
                    <span className="flex items-center justify-center gap-2 py-5">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      读取候选问题中…
                    </span>
                  </td>
                </tr>
              ) : filteredQuestions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center text-[#857e91]">
                    {visibleQuestions.length
                      ? "没有符合当前筛选条件的候选问题。"
                      : "客户选择或提交的问题审核通过后将在这里展示。"}
                  </td>
                </tr>
              ) : (
                filteredQuestions.map((question) => {
                  const selected = question.status === "selected";
                  const pending =
                    question.selectionApprovalStatus === "pending";
                  return (
                    <tr key={question.id}>
                      <td className="keyword-question-cell">
                        <strong className="text-[#30263e]">
                          {question.question}
                        </strong>
                        {question.rationale && (
                          <small className="mt-1 block max-w-2xl text-[#857e91]">
                            {question.rationale}
                          </small>
                        )}
                      </td>
                      <td>{question.intent || "待工程师补充"}</td>
                      <td>
                        <span
                          className="keyword-pill fm-question-category-pill"
                          data-category={question.category}
                        >
                          {CATEGORY_META[question.category].title}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                            selected
                              ? "bg-emerald-50 text-emerald-700"
                              : pending
                                ? "bg-amber-50 text-amber-700"
                                : "bg-[#f3edf8] text-[#5b2a86]"
                          }`}
                        >
                          {selected ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <Clock3 className="h-3.5 w-3.5" />
                          )}
                          {selected
                            ? "已确认"
                            : pending
                              ? "待工程师确认"
                              : "待选择"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="keyword-optimize-button disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={
                            pending ||
                            !portal.capabilities.questionSelection.allowed
                          }
                          onClick={() => onUseQuestion(question)}
                        >
                          {selected
                            ? "进入问题优化"
                            : pending
                              ? "待监控工程师确认"
                              : "选择并进入问题优化"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
