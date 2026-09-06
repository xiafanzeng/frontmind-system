import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
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
import QuestionActionDialog from "@/components/QuestionActionDialog";
import { trpc } from "@/lib/trpc";
import type { WorkspaceQuestionCategory } from "@shared/service-portal";
import type { ServicePortalView } from "./service-portal";

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
      : "该类问题的全年额度已用完，请选择仍有额度的分类。";
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

type Props = {
  preview: boolean;
  portal: ServicePortalView;
  draft?: QuestionIntakeDraft | null;
  onDraftChange?: (draft: QuestionIntakeDraft | null) => void;
  onOpenBrandQuestions: () => void;
  onPortalRefresh?: () => unknown | Promise<unknown>;
  onPreviewBrandConfirmed?: (input: QuestionIntakeSubmitInput) => void;
};

function QuestionIntakeView({
  portal,
  draft,
  onDraftChange,
  onOpenBrandQuestions,
  onPortalRefresh,
  preview,
  onSubmit,
  submitting,
}: Props & {
  onSubmit: (input: QuestionIntakeSubmitInput) => Promise<boolean>;
  submitting: boolean;
}) {
  const [question, setQuestion] = useState(draft?.question || "");
  const [category, setCategory] = useState<WorkspaceQuestionCategory | null>(
    draft?.category || null,
  );
  const [libraryRef, setLibraryRef] = useState<BrandKeywordLibraryRef | null>(
    draft?.libraryRef || null,
  );
  const [origin, setOrigin] = useState<QuestionIntakeOrigin>(
    draft?.origin || "self_entered",
  );
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  useEffect(() => {
    if (!draft) return;
    setQuestion(draft.question);
    setCategory(draft.category);
    setLibraryRef(draft.libraryRef);
    setOrigin(draft.origin);
  }, [draft]);
  const fromLibrary = origin === "brand_keyword_library";
  const access = portal.capabilities.questionSelection;
  const options = questionCategoryOptions.map((option) => ({
    ...option,
    quota: portal.quotas.find((quota) => quota.key === option.quotaKey),
  }));
  const hasCapacity = (value: WorkspaceQuestionCategory) => {
    const quota = options.find((option) => option.value === value)?.quota;
    return Boolean(
      quota &&
        quota.limit !== null &&
        quota.used !== null &&
        quota.used < quota.limit &&
        portal.quotaUnlock?.capacityState !== "awaiting_unlock" &&
        portal.quotaUnlock?.capacityState !== "exhausted",
    );
  };
  const hasAnyCapacity = options.some((option) => hasCapacity(option.value));
  const available = Boolean(
    category && hasCapacity(category) && (!fromLibrary || libraryRef),
  );
  const submit = async () => {
    if (
      await onSubmit({
        question: question.trim(),
        category,
        libraryRef,
        origin,
      })
    ) {
      setQuestion("");
      setCategory(null);
      setLibraryRef(null);
      setOrigin("self_entered");
      onDraftChange?.(null);
      setConfirmationOpen(false);
    }
  };
  return (
    <section className="question-intake-panel" aria-label="目标问题管理">
      <div className="question-intake-heading">
        <div>
          <span>目标问题</span>
          <h3>从品牌全域词库选择或自主填写需要优化的问题</h3>
          <p>选择类别并确认后立即进入服务。您可以直接修改或删除自己的问题。</p>
        </div>
        <button
          type="button"
          className="question-intake-library-link"
          onClick={onOpenBrandQuestions}
        >
          前往品牌全域词库
          <ArrowUpRight size={15} />
        </button>
      </div>
      {access.allowed ? (
        <div className="question-intake-form">
          <label>
            <span>问题来源</span>
            <input
              readOnly
              value={fromLibrary ? "品牌全域词库" : "自主填写"}
              aria-label="问题来源"
            />
          </label>
          <label className="question-intake-question">
            <span>目标问题</span>
            <input
              value={question}
              readOnly={fromLibrary}
              maxLength={4000}
              placeholder="请输入一个完整、明确的问题"
              onChange={(event) => {
                setQuestion(event.target.value);
                onDraftChange?.({
                  origin,
                  question: event.target.value,
                  category,
                  libraryRef,
                });
              }}
            />
          </label>
          {!fromLibrary && (
            <label>
              <span>问题类别</span>
              <select
                aria-label="问题类别"
                value={category || ""}
                onChange={(event) => {
                  const value = event.target.value as WorkspaceQuestionCategory;
                  setCategory(value);
                  onDraftChange?.({
                    origin,
                    question,
                    category: value,
                    libraryRef,
                  });
                }}
              >
                <option value="">请选择问题类别</option>
                {options.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={!hasCapacity(option.value)}
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
              disabled={submitting || question.trim().length < 2 || !available}
              onClick={() => setConfirmationOpen(true)}
            >
              {submitting
                ? "正在确认…"
                : !hasAnyCapacity || (!available && category)
                  ? questionQuotaUnavailableActionLabel(portal) ||
                    "该分类额度不足"
                  : "确认优化问题"}
            </button>
          </div>
        </div>
      ) : (
        <p role="status" className="question-intake-quota-note">
          {access.reason || "当前不能新增问题。"}
        </p>
      )}
      {access.allowed && (!hasAnyCapacity || (category && !available)) && (
        <p role="status" className="question-intake-quota-note">
          {questionQuotaUnavailableMessage(portal, fromLibrary)}
        </p>
      )}
      {portal.purchasedQuestions.length > 0 && (
        <section className="mt-5 grid gap-3" aria-label="服务问题管理">
          <strong className="text-sm">已进入服务的问题</strong>
          {portal.purchasedQuestions.map((item) => (
            <article
              key={item.id}
              className="flex flex-col gap-3 rounded-xl border bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <strong className="text-sm leading-6">{item.question}</strong>
              {!preview && (
                <div className="flex flex-wrap gap-2">
                  <QuestionActionDialog
                    mode="question"
                    questions={[item]}
                    selectedQuestionId={item.id}
                    fixedAction="modify"
                    onSubmitted={async () => {
                      await onPortalRefresh?.();
                    }}
                  />
                  <QuestionActionDialog
                    mode="question"
                    questions={[item]}
                    selectedQuestionId={item.id}
                    fixedAction="delete"
                    onSubmitted={async () => {
                      await onPortalRefresh?.();
                    }}
                  />
                </div>
              )}
            </article>
          ))}
        </section>
      )}
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
              确认后立即进入服务并占用对应问题额度；后续仍可修改或删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="rounded-xl border bg-muted/40 px-4 py-3 text-sm">
            {question}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>
              返回检查
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void submit();
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

function PersistentQuestionIntake(props: Props) {
  const utils = trpc.useUtils();
  const mutation = trpc.workspace.requestQuestionSelection.useMutation();
  return (
    <QuestionIntakeView
      {...props}
      submitting={mutation.isPending}
      onSubmit={async (input) => {
        try {
          if (input.origin === "brand_keyword_library") {
            if (!input.libraryRef)
              throw new Error("词库来源已更新，请重新选择。");
            await mutation.mutateAsync({
              mode: "brand_keyword_library",
              ...input.libraryRef,
            });
          } else {
            if (!input.category) throw new Error("请选择问题类别。");
            await mutation.mutateAsync({
              mode: "direct",
              question: input.question,
              category: input.category,
            });
          }
          await Promise.all([
            utils.workspace.questionPortfolio.invalidate(),
            utils.workspace.portal.invalidate(),
          ]);
          await props.onPortalRefresh?.();
          toast.success("优化问题已确认");
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "问题保存失败");
          return false;
        }
      }}
    />
  );
}

export default function QuestionIntakePanel(props: Props) {
  if (props.preview)
    return (
      <QuestionIntakeView
        {...props}
        submitting={false}
        onSubmit={async (input) => {
          props.onPreviewBrandConfirmed?.(input);
          toast.success("预览问题已确认");
          return true;
        }}
      />
    );
  return <PersistentQuestionIntake {...props} />;
}
