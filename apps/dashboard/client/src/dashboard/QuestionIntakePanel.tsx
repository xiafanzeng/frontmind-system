import { useEffect, useState } from "react";
import { ArrowUpRight, FileClock } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import CustomerRequestHistoryDialog from "@/components/CustomerRequestHistoryDialog";
import QuestionMaintenanceRequestDialog from "@/components/QuestionMaintenanceRequestDialog";
import {
  QUESTION_CLASSIFICATION_V2_WRITES_ENABLED,
  type ServicePortalQuestion,
  type WorkspaceQuestionCategory,
} from "@shared/service-portal";
import type { ServicePortalView, ServiceQuota } from "./service-portal";

export const questionCategoryOptions = [
  { value: "industry", label: "行业排名词", quotaKey: "industry" },
  {
    value: "competitor_comparison",
    label: "竞品对比词",
    quotaKey: "competitor",
  },
  { value: "reputation", label: "美誉舆情词", quotaKey: "reputation" },
  {
    value: "product_scenario",
    label: "产品场景词",
    quotaKey: "scenario",
  },
] as const;

export const previewQuestionCategoryMeta = {
  industry: {
    quotaKey: "industry",
    groupId: "ranking",
    title: "行业排名词",
    subtitle: "行业入口与品牌优胜问题",
    tone: "amber",
  },
  competitor_comparison: {
    quotaKey: "competitor",
    groupId: "comparison",
    title: "竞品对比词",
    subtitle: "差异定位与选择依据",
    tone: "blue",
  },
  reputation: {
    quotaKey: "reputation",
    groupId: "reputation",
    title: "美誉舆情词",
    subtitle: "信任证据与品牌口碑",
    tone: "plum",
  },
  product_scenario: {
    quotaKey: "scenario",
    groupId: "scenario",
    title: "产品场景词",
    subtitle: "应用需求与决策问题",
    tone: "teal",
  },
} as const;

export type PreviewQuestionCategory = keyof typeof previewQuestionCategoryMeta;

export type PreviewConfirmedQuestion = {
  id: string;
  question: string;
  category: PreviewQuestionCategory;
};

export type BrandKeywordLibraryRef = {
  dashboardRevision: number;
  tableId: string;
  rowIndex: number;
};

export type QuestionIntakeOrigin = "brand_keyword_library" | "self_entered";

export type QuestionIntakeDraft = {
  origin: QuestionIntakeOrigin;
  question: string;
  category: WorkspaceQuestionCategory | null;
  libraryRef: BrandKeywordLibraryRef | null;
};

export type QuestionIntakeSubmitInput = QuestionIntakeDraft;

type PendingQuestion = Pick<
  ServicePortalQuestion,
  "id" | "question" | "category" | "source"
>;

export function pendingQuestionQuotaReservations(
  pendingQuestions: Array<Pick<PendingQuestion, "category">>,
  progressive: boolean,
) {
  const counts = new Map<WorkspaceQuestionCategory, number>();
  for (const pendingQuestion of pendingQuestions) {
    const categories = pendingQuestion.category
      ? [pendingQuestion.category]
      : progressive
        ? questionCategoryOptions.map((option) => option.value)
        : [];
    for (const category of categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  return counts;
}

export function directQuestionQuotaHasCapacity(
  categoryCapacity: boolean[],
  progressive: boolean,
) {
  return progressive
    ? categoryCapacity.every(Boolean)
    : categoryCapacity.some(Boolean);
}

type QuestionRequestHistoryItem = {
  id: string;
  category: string | null;
  categoryLabel: string | null;
  topic: string | null;
  sourceQuestionId?: string | null;
  publicStatus?: "pending" | "completed" | null;
  publicStatusLabel?: string | null;
  publicSummary: string | null;
};

const questionRequestCategoryLabels: Record<string, string> = {
  question_review: "问题审核 · 自主填写",
  question_modify: "问题修改 · 服务问题",
  question_delete: "问题删除 · 服务问题",
};

export function questionRequestCategoryLabel(
  category: string | null | undefined,
  fallback: string | null | undefined,
) {
  return (
    (category ? questionRequestCategoryLabels[category] : undefined) ??
    fallback ??
    null
  );
}

function normalizeQuestionHistoryText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function quotaUnlockDate(value: string | null | undefined) {
  if (!value) return "";
  const source = /^\d{10,13}$/.test(value) ? Number(value) : value;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function questionQuotaUnavailableMessage(
  portal: ServicePortalView,
  fromBrandKeywordLibrary: boolean,
) {
  const unlock =
    portal.plan.code === "luxury" &&
    portal.quotaUnlock?.total !== null &&
    portal.quotaUnlock?.total !== undefined &&
    portal.quotaUnlock.total > 1
      ? portal.quotaUnlock
      : undefined;
  const nextUnlockLabel = quotaUnlockDate(unlock?.nextUnlockAt);
  const hasFutureUnlock = Boolean(
    unlock &&
      unlock.capacityState === "available" &&
      unlock.current !== null &&
      unlock.total !== null &&
      unlock.current < unlock.total,
  );
  const finalUnlockStage = Boolean(
    unlock &&
      unlock.capacityState === "available" &&
      unlock.current !== null &&
      unlock.total !== null &&
      unlock.current >= unlock.total,
  );

  if (unlock?.capacityState === "exhausted") {
    return fromBrandKeywordLibrary
      ? "该类问题的全年额度已用完，不能继续新增。"
      : "豪华版全年问题额度已用完，不能继续新增。";
  }
  if (finalUnlockStage) {
    return fromBrandKeywordLibrary
      ? "该类问题的全年额度已用完，不能继续新增。"
      : "至少一个问题分类的全年额度已用完；自主填写暂不可提交，请从品牌全域词库选择仍有额度的分类。";
  }
  if (unlock?.capacityState === "awaiting_unlock" || hasFutureUnlock) {
    const subject = fromBrandKeywordLibrary
      ? "该类问题本季度已解锁额度已用完"
      : "本季度已解锁的问题额度已用完";
    return nextUnlockLabel
      ? `${subject}，下一季度额度将于 ${nextUnlockLabel} 开放。`
      : `${subject}，请等待下一服务季度开放。`;
  }
  return fromBrandKeywordLibrary
    ? "该词库问题对应的问题额度已用满，请选择其他问题或联系服务管理员。"
    : "当前服务的问题额度已用满，请联系服务管理员调整当前服务问题。";
}

function questionQuotaUnavailableActionLabel(portal: ServicePortalView) {
  const unlock =
    portal.plan.code === "luxury" &&
    portal.quotaUnlock?.total !== null &&
    portal.quotaUnlock?.total !== undefined &&
    portal.quotaUnlock.total > 1
      ? portal.quotaUnlock
      : undefined;
  const finalUnlockStage = Boolean(
    unlock &&
      unlock.capacityState === "available" &&
      unlock.current !== null &&
      unlock.total !== null &&
      unlock.current >= unlock.total,
  );
  if (unlock?.capacityState === "exhausted") {
    return "全年额度已用完";
  }
  if (finalUnlockStage) return "分类额度已用完";
  if (
    unlock?.capacityState === "awaiting_unlock" ||
    (unlock &&
      unlock.capacityState === "available" &&
      unlock.current !== null &&
      unlock.total !== null &&
      unlock.current < unlock.total)
  ) {
    return "下一季度开放";
  }
  return null;
}

export function questionHistoryItemMatchesTarget(
  item: Pick<QuestionRequestHistoryItem, "sourceQuestionId" | "topic">,
  target: { questionId: string; question: string },
) {
  if (item.sourceQuestionId) {
    return item.sourceQuestionId === target.questionId;
  }
  return (
    Boolean(item.topic) &&
    normalizeQuestionHistoryText(item.topic || "") ===
      normalizeQuestionHistoryText(target.question)
  );
}

type QuestionRequestHistory = {
  items: QuestionRequestHistoryItem[];
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onRefresh?: () => unknown | Promise<unknown>;
  onLoadMore?: () => unknown | Promise<unknown>;
};

type QuestionIntakePanelProps = {
  preview: boolean;
  portal: ServicePortalView;
  draft?: QuestionIntakeDraft | null;
  onDraftChange?: (draft: QuestionIntakeDraft | null) => void;
  onOpenBrandQuestions: () => void;
  onPortalRefresh?: () => unknown | Promise<unknown>;
  onOpenTicket?: (ticketId: string) => void;
  onPreviewBrandConfirmed?: (input: QuestionIntakeSubmitInput) => void;
};

type QuestionIntakePanelContentProps = Omit<
  QuestionIntakePanelProps,
  "preview"
>;

type QuestionIntakePanelViewProps = Omit<
  QuestionIntakePanelContentProps,
  "onPreviewBrandConfirmed"
> & {
  pendingQuestions: PendingQuestion[];
  requestHistory: QuestionRequestHistory;
  submitting: boolean;
  onSubmit: (input: QuestionIntakeSubmitInput) => Promise<boolean>;
};

function QuestionIntakePanelView({
  portal,
  draft,
  onDraftChange,
  onOpenBrandQuestions,
  onPortalRefresh,
  onOpenTicket,
  pendingQuestions,
  requestHistory,
  submitting,
  onSubmit,
}: QuestionIntakePanelViewProps) {
  const [question, setQuestion] = useState(draft?.question || "");
  const [origin, setOrigin] = useState<QuestionIntakeOrigin>(
    draft?.origin === "brand_keyword_library"
      ? "brand_keyword_library"
      : "self_entered",
  );
  const [category, setCategory] = useState<WorkspaceQuestionCategory | null>(
    draft?.category || null,
  );
  const [libraryRef, setLibraryRef] = useState<BrandKeywordLibraryRef | null>(
    draft?.libraryRef || null,
  );
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setQuestion(draft.question || "");
    setOrigin(
      draft.origin === "brand_keyword_library"
        ? "brand_keyword_library"
        : "self_entered",
    );
    setCategory(draft.category || null);
    setLibraryRef(draft.libraryRef || null);
  }, [draft?.category, draft?.libraryRef, draft?.origin, draft?.question]);

  const fromBrandKeywordLibrary = origin === "brand_keyword_library";
  const selectionAccess = portal.capabilities.questionSelection;
  const selectionEnabled = selectionAccess.allowed;
  const progressiveQuotaUnlock =
    portal.quotaUnlock?.total !== null &&
    portal.quotaUnlock?.total !== undefined &&
    portal.quotaUnlock.total > 1;
  const pendingCountByCategory = pendingQuestionQuotaReservations(
    pendingQuestions,
    progressiveQuotaUnlock,
  );
  const selectionQuotas = questionCategoryOptions.map((option) => ({
    ...option,
    quota: portal.quotas.find((item) => item.key === option.quotaKey),
  }));
  const totalQuotaSynchronized = selectionQuotas.every(({ quota }) =>
    Boolean(quota && quota.limit !== null && quota.used !== null),
  );
  const totalQuotaAvailable = Boolean(
    totalQuotaSynchronized &&
      portal.quotaUnlock?.capacityState !== "awaiting_unlock" &&
      portal.quotaUnlock?.capacityState !== "exhausted" &&
      selectionQuotas.reduce(
        (total, { quota }) => total + Number(quota?.used || 0),
        0,
      ) +
        pendingQuestions.length <
        selectionQuotas.reduce(
          (total, { quota }) => total + Number(quota?.limit || 0),
          0,
        ),
  );
  const quotaHasCapacity = (
    quota: ServiceQuota | undefined,
    quotaCategory: WorkspaceQuestionCategory,
  ) =>
    quota &&
    quota.limit !== null &&
    quota.used !== null &&
    quota.used + (pendingCountByCategory.get(quotaCategory) || 0) < quota.limit;
  const selectedOption = questionCategoryOptions.find(
    (option) => option.value === category,
  );
  const brandQuota = selectedOption
    ? portal.quotas.find((item) => item.key === selectedOption.quotaKey)
    : undefined;
  const quotaAvailable = fromBrandKeywordLibrary
    ? Boolean(
        totalQuotaAvailable &&
          category &&
          libraryRef &&
          quotaHasCapacity(brandQuota, category),
      )
    : QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
      ? Boolean(
          totalQuotaAvailable &&
            directQuestionQuotaHasCapacity(
              selectionQuotas.map(({ value, quota }) =>
                Boolean(quotaHasCapacity(quota, value)),
              ),
              progressiveQuotaUnlock,
            ),
        )
      : Boolean(
          totalQuotaAvailable &&
            category &&
            selectedOption &&
            quotaHasCapacity(brandQuota, category),
        );
  const quotaUnavailableActionLabel = !quotaAvailable
    ? questionQuotaUnavailableActionLabel(portal)
    : null;

  const updateAsDirectEntry = (nextQuestion: string) => {
    const nextCategory = QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
      ? null
      : category;
    setOrigin("self_entered");
    setCategory(nextCategory);
    setLibraryRef(null);
    onDraftChange?.({
      origin: "self_entered",
      question: nextQuestion,
      category: nextCategory,
      libraryRef: null,
    });
  };
  const resetForm = () => {
    setQuestion("");
    setOrigin("self_entered");
    setCategory(null);
    setLibraryRef(null);
    onDraftChange?.(null);
  };
  const submitCurrentQuestion = async () => {
    const submitted = await onSubmit({
      origin,
      question: question.trim(),
      category,
      libraryRef,
    });
    if (submitted) resetForm();
    return submitted;
  };
  const questionRequestItems = requestHistory.items
    .filter((item) =>
      ["question_review", "question_modify", "question_delete"].includes(
        item.category || "",
      ),
    )
    .map((item) => ({
      ...item,
      categoryLabel: questionRequestCategoryLabel(
        item.category,
        item.categoryLabel,
      ),
    }));
  return (
    <section
      className="question-intake-panel"
      aria-label={selectionEnabled ? "新增目标问题" : "问题需求记录"}
    >
      <div className="question-intake-heading">
        <div>
          <span>目标问题</span>
          <h3>
            {selectionEnabled
              ? "从品牌全域词库选择或自主填写需要优化的问题"
              : "查看已进入服务的问题与需求记录"}
          </h3>
          <p>
            {!selectionEnabled
              ? "新问题提交已关闭；既有服务问题、待审核记录和处理结果继续保留。"
              : QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
                ? "品牌词库问题确认后会立即锁定并进入服务；自主填写的问题将提交专业审核，由后台分配问题类型。"
                : "品牌词库问题确认后会立即锁定并进入服务；自主填写的问题沿用现有分类提交流程。"}
          </p>
        </div>
        <div className="question-intake-heading-actions">
          <button
            type="button"
            className="question-intake-library-link"
            onClick={onOpenBrandQuestions}
          >
            前往品牌全域词库
            <ArrowUpRight aria-hidden="true" size={15} />
          </button>
          <button
            type="button"
            className="question-intake-library-link"
            onClick={() => setHistoryOpen(true)}
          >
            <FileClock aria-hidden="true" size={15} />
            需求记录
          </button>
        </div>
      </div>

      {selectionEnabled ? (
        <div className="question-intake-form">
          <label>
            <span>问题来源</span>
            <input
              type="text"
              value={fromBrandKeywordLibrary ? "品牌全域词库" : "自主填写"}
              aria-label="问题来源"
              readOnly
            />
          </label>
          <label className="question-intake-question">
            <span>目标问题</span>
            <input
              type="text"
              value={question}
              maxLength={4000}
              readOnly={fromBrandKeywordLibrary}
              aria-readonly={fromBrandKeywordLibrary}
              placeholder="请输入一个完整、明确、可被用户真实提问的问题"
              onChange={(event) => {
                if (fromBrandKeywordLibrary) return;
                const nextQuestion = event.target.value;
                setQuestion(nextQuestion);
                updateAsDirectEntry(nextQuestion);
              }}
            />
          </label>
          {!fromBrandKeywordLibrary &&
            !QUESTION_CLASSIFICATION_V2_WRITES_ENABLED && (
              <label>
                <span>问题类别</span>
                <select
                  aria-label="问题类别"
                  value={category || ""}
                  onChange={(event) => {
                    const nextCategory = event.target
                      .value as WorkspaceQuestionCategory;
                    setCategory(nextCategory);
                    onDraftChange?.({
                      origin: "self_entered",
                      question,
                      category: nextCategory,
                      libraryRef: null,
                    });
                  }}
                >
                  <option value="">请选择问题类别</option>
                  {selectionQuotas.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={!quotaHasCapacity(option.quota, option.value)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          <div className="question-intake-form-actions">
            <button
              type="button"
              className="question-intake-submit"
              disabled={
                question.trim().length < 2 ||
                (!fromBrandKeywordLibrary &&
                  !QUESTION_CLASSIFICATION_V2_WRITES_ENABLED &&
                  !category) ||
                !quotaAvailable ||
                !selectionAccess.allowed ||
                submitting
              }
              onClick={() => {
                if (fromBrandKeywordLibrary) {
                  setConfirmationOpen(true);
                  return;
                }
                void submitCurrentQuestion();
              }}
            >
              {submitting
                ? "正在提交…"
                : quotaUnavailableActionLabel
                  ? quotaUnavailableActionLabel
                  : fromBrandKeywordLibrary
                    ? "确认优化问题"
                    : "提交专业审核"}
            </button>
          </div>
        </div>
      ) : (
        <p className="question-intake-quota-note" role="status">
          {selectionAccess.reason ||
            "当前不能提交新的问题；既有问题与需求记录仍可查看。"}
        </p>
      )}

      {selectionEnabled && question.trim().length === 1 && (
        <p className="question-intake-quota-note" role="status">
          目标问题至少需要 2 个字符。
        </p>
      )}
      {selectionEnabled && !quotaAvailable && (
        <p className="question-intake-quota-note" role="status">
          {questionQuotaUnavailableMessage(portal, fromBrandKeywordLibrary)}
        </p>
      )}
      {pendingQuestions.length > 0 && (
        <div className="question-intake-pending">
          <span>待监控工程师确认</span>
          {pendingQuestions.map((item) => (
            <article key={item.id}>
              <strong>{item.question}</strong>
              <small>
                {item.source === "user" ? "自主填写" : "候选问题"} ·{" "}
                {item.category
                  ? `${
                      questionCategoryOptions.find(
                        (option) => option.value === item.category,
                      )?.label || "待确认类型"
                    } · 审核通过后计入额度`
                  : "等待后台分配问题类型"}
              </small>
            </article>
          ))}
        </div>
      )}

      {portal.purchasedQuestions.length > 0 && (
        <section className="mt-5 grid gap-3" aria-label="服务问题变更">
          <div>
            <strong className="text-sm">已进入服务的问题</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              修改或删除会先生成需求，由 AI 监控与优化工程师或系统管理员审核。
            </p>
          </div>
          {portal.purchasedQuestions.map((serviceQuestion) => {
            const target = [
              { id: serviceQuestion.id, question: serviceQuestion.question },
            ];
            return (
              <article
                key={serviceQuestion.id}
                className="flex flex-col gap-3 rounded-xl border bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <strong className="text-sm leading-6">
                  {serviceQuestion.question}
                </strong>
                <div className="flex flex-wrap gap-2">
                  <QuestionMaintenanceRequestDialog
                    mode="question"
                    questions={target}
                    selectedQuestionId={serviceQuestion.id}
                    fixedAction="modify"
                    triggerLabel="申请修改"
                    onSubmitted={async () => {
                      await requestHistory.onRefresh?.();
                      await onPortalRefresh?.();
                    }}
                  />
                  <QuestionMaintenanceRequestDialog
                    mode="question"
                    questions={target}
                    selectedQuestionId={serviceQuestion.id}
                    fixedAction="delete"
                    triggerLabel="申请删除"
                    onSubmitted={async () => {
                      await requestHistory.onRefresh?.();
                      await onPortalRefresh?.();
                    }}
                  />
                </div>
              </article>
            );
          })}
        </section>
      )}

      <CustomerRequestHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="问题需求记录"
        description="自主填写问题审核、问题修改与问题删除记录统一显示在这里。"
        tickets={questionRequestItems}
        loading={requestHistory.loading}
        refreshing={requestHistory.refreshing}
        loadingMore={requestHistory.loadingMore}
        hasMore={requestHistory.hasMore}
        error={requestHistory.error}
        onRefresh={requestHistory.onRefresh}
        onLoadMore={requestHistory.onLoadMore}
        onOpenTicket={onOpenTicket}
        preview={!onOpenTicket}
        emptyText="暂无问题审核、修改或删除记录。"
      />

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={(open) => {
          if (!submitting) setConfirmationOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认优化问题？</AlertDialogTitle>
            <AlertDialogDescription>
              确认后开启进度将不可修改。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-xl border bg-muted/40 px-4 py-3 text-sm font-medium leading-6 text-foreground">
            {question}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>
              返回检查
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void submitCurrentQuestion().then((submitted) => {
                  if (submitted) setConfirmationOpen(false);
                });
              }}
            >
              {submitting ? "正在确认…" : "确认并开启进度"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function PreviewQuestionIntakePanel(props: QuestionIntakePanelContentProps) {
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>(
    [],
  );
  const [requestHistoryItems, setRequestHistoryItems] = useState<
    QuestionRequestHistoryItem[]
  >([]);
  return (
    <QuestionIntakePanelView
      {...props}
      pendingQuestions={pendingQuestions}
      requestHistory={{
        items: requestHistoryItems,
        loading: false,
        error: null,
        refreshing: false,
      }}
      submitting={false}
      onSubmit={async (input) => {
        if (input.origin === "brand_keyword_library") {
          props.onPreviewBrandConfirmed?.(input);
          props.onDraftChange?.(null);
          toast.success("优化问题已确认", {
            description: "问题已进入服务问题列表并占用对应问题额度。",
          });
          return true;
        }
        setPendingQuestions((current) => [
          {
            id: `preview-pending-${Date.now()}`,
            question: input.question,
            category: QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
              ? null
              : input.category,
            source: "user",
          },
          ...current.filter((item) => item.question !== input.question),
        ]);
        setRequestHistoryItems((current) => [
          {
            id: `preview-review-${Date.now()}`,
            category: "question_review",
            categoryLabel: "问题审核",
            topic: input.question,
            publicStatus: "pending",
            publicStatusLabel: "待处理",
            publicSummary: null,
          },
          ...current,
        ]);
        props.onDraftChange?.(null);
        toast.success("已提交专业审核", {
          description: "后台分配问题类型并审核通过后，将进入服务问题列表。",
        });
        return true;
      }}
    />
  );
}

function PersistentQuestionIntakePanel(props: QuestionIntakePanelContentProps) {
  const portfolioQuery = (trpc.workspace as any).questionPortfolio.useQuery(
    undefined,
    { retry: false, refetchOnWindowFocus: true },
  );
  const requestMutation = (
    trpc.workspace as any
  ).requestQuestionSelection.useMutation();
  const requestHistoryQuery = (
    trpc.workspace as any
  ).deliveryTickets.list.useInfiniteQuery(
    {
      type: "knowledge_base",
      surface: "question_management",
      limit: 50,
    },
    {
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      getNextPageParam: (lastPage: any) => lastPage?.nextCursor ?? undefined,
    },
  );
  const pendingQuestions = (portfolioQuery.data?.questions || []).filter(
    (question: ServicePortalQuestion) =>
      question.status === "candidate" &&
      question.selectionApprovalStatus === "pending",
  );

  return (
    <QuestionIntakePanelView
      {...props}
      pendingQuestions={pendingQuestions}
      requestHistory={{
        items: (requestHistoryQuery.data?.pages || []).flatMap(
          (page: any) => page?.tickets || [],
        ),
        loading: requestHistoryQuery.isLoading,
        error: requestHistoryQuery.isError
          ? requestHistoryQuery.error?.message || "问题需求记录暂时无法载入。"
          : null,
        refreshing: requestHistoryQuery.isFetching,
        hasMore: requestHistoryQuery.hasNextPage,
        loadingMore: requestHistoryQuery.isFetchingNextPage,
        onRefresh: requestHistoryQuery.refetch,
        onLoadMore: requestHistoryQuery.fetchNextPage,
      }}
      submitting={requestMutation.isPending}
      onSubmit={async (input) => {
        try {
          if (input.origin === "brand_keyword_library") {
            if (!input.libraryRef) {
              throw new Error("品牌全域词库来源已失效，请返回词库重新选择。");
            }
            await requestMutation.mutateAsync({
              mode: "brand_keyword_library",
              dashboardRevision: input.libraryRef.dashboardRevision,
              tableId: input.libraryRef.tableId,
              rowIndex: input.libraryRef.rowIndex,
            });
          } else {
            if (QUESTION_CLASSIFICATION_V2_WRITES_ENABLED) {
              await requestMutation.mutateAsync({
                mode: "direct",
                question: input.question,
                classificationVersion: 2,
              });
            } else {
              if (!input.category) {
                throw new Error("请选择问题类别。");
              }
              await requestMutation.mutateAsync({
                mode: "direct",
                question: input.question,
                category: input.category,
              });
            }
          }
          props.onDraftChange?.(null);
          await portfolioQuery.refetch();
          await requestHistoryQuery.refetch();
          await props.onPortalRefresh?.();
          if (input.origin === "brand_keyword_library") {
            toast.success("优化问题已确认", {
              description: "问题已进入服务问题列表并占用对应问题额度。",
            });
          } else {
            toast.success("已提交专业审核", {
              description: "后台分配问题类型并审核通过后，将进入服务问题列表。",
            });
          }
          return true;
        } catch (error) {
          toast.error("目标问题提交失败", {
            description:
              error instanceof Error ? error.message : "请刷新后重试",
          });
          return false;
        }
      }}
    />
  );
}

export default function QuestionIntakePanel({
  preview,
  ...props
}: QuestionIntakePanelProps) {
  return preview ? (
    <PreviewQuestionIntakePanel {...props} />
  ) : (
    <PersistentQuestionIntakePanel {...props} />
  );
}
