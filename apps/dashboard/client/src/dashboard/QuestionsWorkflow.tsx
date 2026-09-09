import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { trpc } from "@/lib/trpc";
import {
  keywordCategoryLabel,
  type KeywordCategoryKey,
} from "@shared/keyword-categories";
import {
  publicServicePortalQuestionSchema,
  type PublicServicePortalQuestion,
} from "@shared/service-portal";
import type { ServicePortalView } from "./service-portal";
import type { QuestionIntakeDraft } from "./QuestionIntakePanel";
import { questionCategoryOptions } from "./QuestionIntakePanel";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import { useBusinessFlowState } from "./useBusinessFlowState";
import {
  WorkflowQuestion,
  WorkflowSection,
  WorkflowCompleted,
  WorkflowFeedback,
  WorkflowPagination,
} from "./workflow/Workflow";
import { KeywordPicker, type KeywordSelection } from "./workflow/KeywordPicker";
import { useOutcomeSync } from "./workflow/useOutcomeSync";

const flowSchema = z.object({
  entry: z.enum([
    "start",
    "direct",
    "library",
    "existing",
    "result",
    "edit",
    "delete",
  ]),
  instanceId: z.string(),
  question: z.string(),
  category: z
    .enum([
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario",
    ])
    .nullable(),
  library: z
    .object({
      dashboardRevision: z.number(),
      tableId: z.string(),
      rowIndex: z.number(),
      question: z.string(),
      category: z.enum([
        "industry",
        "competitor_comparison",
        "reputation",
        "product_scenario",
      ]),
    })
    .nullable(),
  confirming: z.boolean(),
  selectedId: z.string().nullable(),
  expectedRevision: z.number().nullable(),
  filters: z.object({
    query: z.string(),
    category: z.string(),
    page: z.number(),
  }),
});
type Flow = z.infer<typeof flowSchema>;
const questionSourceRefsSchema = z.record(
  z.string(),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("direct") }),
    z.object({
      kind: z.literal("library"),
      dashboardRevision: z.number().int(),
      tableId: z.string(),
      rowIndex: z.number().int(),
    }),
  ]),
);
type QuestionSourceRefs = z.infer<typeof questionSourceRefsSchema>;

const initialFlow = (): Flow => ({
  entry: "start",
  instanceId: crypto.randomUUID(),
  question: "",
  category: null,
  library: null,
  confirming: false,
  selectedId: null,
  expectedRevision: null,
  filters: { query: "", category: "", page: 0 },
});

export function QuestionsWorkflow({
  portal,
  intakeDraft,
  onIntakeDraftChange,
  onPortalRefresh,
  onOpenResponseLogic,
}: {
  portal: ServicePortalView;
  intakeDraft?: QuestionIntakeDraft | null;
  onIntakeDraftChange?: (draft: QuestionIntakeDraft | null) => void;
  onPortalRefresh?: () => unknown | Promise<unknown>;
  onOpenResponseLogic: (questionId: string) => void;
}) {
  const { task } = useBusinessWorkspace();
  const utils = trpc.useUtils();
  const portfolio = trpc.workspace.questionPortfolio.useQuery(undefined, {
    retry: false,
  });
  const dashboard = trpc.workspace.dashboard.useQuery(undefined, {
    retry: false,
  });
  const create = trpc.workspace.requestQuestionSelection.useMutation();
  const maintain = trpc.workspace.questionMaintenance.execute.useMutation();
  const outcome = useOutcomeSync();
  const initial = useRef(initialFlow());
  const [flow, setFlow] = useBusinessFlowState(
    "questionsWorkflow",
    initial.current,
    (value) => {
      const parsed = flowSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  );
  const [questionSourceRefs, setQuestionSourceRefs] =
    useBusinessFlowState<QuestionSourceRefs>(
      "questionSourceRefs",
      {},
      (value) => {
        const result = questionSourceRefsSchema.safeParse(value);
        return result.success ? result.data : undefined;
      },
    );
  const pendingSourceRefs = questionSourceRefsSchema.safeParse(
    outcome.pending?.values?.questionSourceRefs,
  );
  const confirmedSourceRefs = {
    ...questionSourceRefs,
    ...(pendingSourceRefs.success ? pendingSourceRefs.data : {}),
  };
  const sourceDescription = (id: string) => {
    const source = confirmedSourceRefs[id];
    return source?.kind === "direct"
      ? "自主输入"
      : source?.kind === "library"
        ? `品牌全域词库 · 版本 ${source.dashboardRevision}`
        : "已有选题";
  };
  const [scope, setScope] = useState<"task" | "project">("task");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const ownerKey = `${task?.scopeKey}:${task?.taskId}`;
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const [returnedState, setReturnedState] = useState<{
    owner: string;
    items: PublicServicePortalQuestion[];
  }>({ owner: ownerKey, items: [] });
  const returned = returnedState.owner === ownerKey ? returnedState.items : [];
  const [removed, setRemoved] = useState<{ owner: string; ids: string[] }>({
    owner: ownerKey,
    ids: [],
  });
  useEffect(() => {
    setError("");
    setBusy(false);
    inFlight.current = false;
  }, [ownerKey]);
  const adopted = useRef<string | null>(null);
  const savedRefs = [
    ...(task?.state?.outputRefs ?? []),
    ...(outcome.pending?.outputRefs ?? []),
  ];
  const taskQuestionIds = new Set(
    [...savedRefs.map((ref) => ref.resource), ...(task?.state?.resources ?? [])]
      .filter((ref) => ref.kind === "question")
      .map((ref) => ref.id),
  );
  const questions = useMemo(() => {
    const items = new Map(returned.map((question) => [question.id, question]));
    for (const question of portfolio.data?.questions ?? []) {
      const confirmed = items.get(question.id);
      // A cached query can lag behind the mutation receipt. Keep that receipt
      // until the portfolio supplies a strictly newer domain revision.
      if (!confirmed || question.revision > confirmed.revision)
        items.set(question.id, question);
    }
    return [...items.values()].filter(
      (question) =>
        removed.owner !== ownerKey || !removed.ids.includes(question.id),
    );
  }, [returned, portfolio.data, removed, ownerKey]);
  const active = questions.find((question) => question.id === flow.selectedId);
  const selectedQuestions = questions.filter(
    (question) => question.status === "selected",
  );
  const visibleOutputs = selectedQuestions.filter(
    (question) => scope === "project" || taskQuestionIds.has(question.id),
  );
  const update = (patch: Partial<Flow>) =>
    setFlow((current) => ({ ...current, ...patch }));
  const openQuestion = (
    question: PublicServicePortalQuestion,
    mode: "result" | "edit" | "delete" = "result",
  ) => {
    if (busy) return;
    setError("");
    update({
      entry: mode,
      selectedId: question.id,
      question: question.question,
      category: question.category,
      expectedRevision: question.revision,
      confirming: false,
      instanceId: crypto.randomUUID(),
    });
  };
  useEffect(() => {
    const values = task?.state?.values;
    const legacyRef = values?.questionLibraryRef as
      | QuestionIntakeDraft["libraryRef"]
      | undefined;
    const draft =
      intakeDraft ??
      (legacyRef && typeof values?.questionDraft === "string"
        ? {
            origin: "brand_keyword_library" as const,
            question: values.questionDraft,
            category: values.questionCategory as KeywordCategoryKey,
            libraryRef: legacyRef,
          }
        : null);
    const signature = draft ? `${ownerKey}:${JSON.stringify(draft)}` : null;
    if (
      draft?.libraryRef &&
      draft.category &&
      signature !== adopted.current &&
      !task?.state?.values.questionsWorkflow
    ) {
      adopted.current = signature;
      update({
        entry: "library",
        question: draft.question,
        category: draft.category,
        library: {
          ...draft.libraryRef,
          question: draft.question,
          category: draft.category,
        },
        confirming: true,
      });
      onIntakeDraftChange?.(null);
    }
  }, [intakeDraft, task?.state?.values]);
  useBusinessWorkspaceSummary({
    title: "优化问题",
    items: [],
    scope,
    canViewProject: true,
    onScopeChange: setScope,
    status: portfolio.isError ? "读取失败，当前结果尚未刷新。" : undefined,
    outputs: visibleOutputs.map((question) => ({
      id: question.id,
      title: question.question,
      type: "优化问题",
      version: question.revision,
      description: `${keywordCategoryLabel(question.category)} · ${sourceDescription(question.id)}`,
      status: question.responseLogicConfirmed
        ? "已加入优化问题 · 正式应答已确认"
        : "已加入优化问题 · 待制作应答",
      source: scope === "task" ? "来源：本任务确认" : "来源：当前项目",
      pendingChanges:
        flow.entry === "edit" &&
        flow.selectedId === question.id &&
        flow.question !== question.question,
      onOpen: () => openQuestion(question),
      onRevise: () => openQuestion(question, "edit"),
    })),
    action: portfolio.isError
      ? {
          label: "重新读取",
          onClick: () => {
            void portfolio.refetch();
          },
        }
      : undefined,
  });
  const refresh = async () => {
    await Promise.allSettled([
      utils.workspace.questionPortfolio.invalidate(),
      utils.workspace.portal.invalidate(),
      utils.workspace.responseLogic.invalidate(),
      Promise.resolve(onPortalRefresh?.()),
    ]);
  };
  const submit = async () => {
    if (
      inFlight.current ||
      !task ||
      !flow.category ||
      !flow.question.trim() ||
      outcome.pending
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let result: PublicServicePortalQuestion | null = null;
    let owner = ownerKey;
    try {
      const id = await task.ensureTask(flow.question);
      const boundOwner = `${task.scopeKey}:${id}`;
      if (currentOwner.current === boundOwner) owner = boundOwner;
      else if (currentOwner.current !== owner) return;
      const response =
        flow.entry === "library" && flow.library
          ? await create.mutateAsync({
              mode: "brand_keyword_library",
              dashboardRevision: flow.library.dashboardRevision,
              tableId: flow.library.tableId,
              rowIndex: flow.library.rowIndex,
            })
          : await create.mutateAsync({
              mode: "direct",
              question: flow.question.trim(),
              category: flow.category,
            });
      result = response.question;
      if (currentOwner.current === owner)
        setReturnedState((current) => ({
          owner,
          items: [
            ...(current.owner === owner ? current.items : []).filter(
              (item) => item.id !== result!.id,
            ),
            result!,
          ],
        }));
      const nextSourceRefs: QuestionSourceRefs = {
        ...confirmedSourceRefs,
        [result.id]:
          flow.entry === "library" && flow.library
            ? {
                kind: "library",
                dashboardRevision: flow.library.dashboardRevision,
                tableId: flow.library.tableId,
                rowIndex: flow.library.rowIndex,
              }
            : { kind: "direct" },
      };
      const next: Flow = {
        ...flow,
        entry: "result",
        selectedId: result.id,
        expectedRevision: result.revision,
        confirming: false,
        question: result.question,
      };
      await outcome.sync(
        {
          step: "question-saved",
          values: {
            questionsWorkflow: next,
            questionSourceRefs: nextSourceRefs,
          },
          outputRefs: [
            {
              resource: {
                kind: "question",
                id: result.id,
                label: result.question.slice(0, 255),
              },
              version: String(result.revision),
              sourceStepId: flow.instanceId,
            },
          ],
          record: {
            id: flow.instanceId,
            label: "已加入优化问题",
            status: "completed",
            detail: result.question.slice(0, 2000),
          },
        },
        id,
      );
      // A task-record failure must never re-enable the create action.
      if (currentOwner.current !== owner) return;
      setQuestionSourceRefs(nextSourceRefs);
      setFlow(next);
      await refresh();
    } catch (cause) {
      if (currentOwner.current !== owner) return;
      setError(
        result
          ? "问题已保存，请从项目已有问题继续；无需重复提交。"
          : cause instanceof Error
            ? cause.message
            : "保存失败，输入已保留。",
      );
      if (!result && flow.entry === "library") void dashboard.refetch();
    } finally {
      if (currentOwner.current === owner) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const maintainIntent = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const saveEdit = async () => {
    if (
      inFlight.current ||
      !task ||
      !active ||
      flow.expectedRevision === null ||
      outcome.pending
    )
      return;
    const action = flow.entry === "delete" ? "delete" : "modify";
    const fingerprint = JSON.stringify([
      active.id,
      flow.expectedRevision,
      action,
      flow.question.trim(),
    ]);
    if (maintainIntent.current?.fingerprint !== fingerprint)
      maintainIntent.current = { fingerprint, id: crypto.randomUUID() };
    inFlight.current = true;
    setBusy(true);
    setError("");
    let owner = ownerKey;
    try {
      const boundId = await task.ensureTask();
      const boundOwner = `${task.scopeKey}:${boundId}`;
      if (currentOwner.current === boundOwner) owner = boundOwner;
      else if (currentOwner.current !== owner) return;
      const common = {
        questionId: active.id,
        expectedRevision: flow.expectedRevision,
        clientRequestId: maintainIntent.current.id,
      };
      const result = await maintain.mutateAsync(
        action === "delete"
          ? { ...common, action }
          : { ...common, action, proposedQuestion: flow.question.trim() },
      );
      const nextId = result.replacementQuestionId ?? result.questionId;
      const next: Flow = {
        ...flow,
        entry: action === "delete" ? "start" : "result",
        selectedId: action === "delete" ? null : nextId,
        confirming: false,
      };
      await outcome.sync(
        {
          step: action === "delete" ? "question-removed" : "question-updated",
          values: { questionsWorkflow: next },
          ...(action === "modify"
            ? {
                outputRefs: [
                  {
                    resource: {
                      kind: "question" as const,
                      id: nextId,
                      label: flow.question.slice(0, 255),
                    },
                    sourceStepId: flow.instanceId,
                  },
                ],
              }
            : {}),
          record: {
            id: flow.instanceId,
            label: action === "delete" ? "已移除优化问题" : "已保存问题修改",
            status: "completed",
          },
        },
        boundId,
      );
      if (currentOwner.current !== owner) return;
      setReturnedState((current) => ({
        owner,
        items: (current.owner === owner ? current.items : []).filter(
          (item) => item.id !== active.id,
        ),
      }));
      setRemoved((current) => ({
        owner,
        ids: [...(current.owner === owner ? current.ids : []), active.id],
      }));
      setFlow(next);
      await refresh();
    } catch (cause) {
      if (currentOwner.current === owner)
        setError(
          cause instanceof Error ? cause.message : "操作失败，输入已保留。",
        );
    } finally {
      if (currentOwner.current === owner) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const chooseKeyword = (selection: KeywordSelection) =>
    update({
      library: selection,
      question: selection.question,
      category: selection.category,
      confirming: true,
    });
  const quota = portal.quotas.find(
    (item) =>
      item.key ===
      questionCategoryOptions.find((item) => item.value === flow.category)
        ?.quotaKey,
  );
  const quotaText =
    portal.mode === "operator"
      ? "按当前项目权限校验"
      : quota?.limit != null && quota.used != null
        ? `${Math.max(0, quota.limit - quota.used)} 个`
        : "确认时由服务端核验";
  const begin = (entry: string) => {
    if (busy) return;
    setError("");
    update({ entry: entry as Flow["entry"], confirming: false });
  };
  const existing = selectedQuestions.filter((question) =>
    question.question.includes(flow.filters.query),
  );
  return (
    <div className="questions-workflow">
      {flow.entry === "existing" && (
        <WorkflowCompleted
          id="questions-existing-entry"
          summary="继续处理已有问题"
          onRevise={() => begin("start")}
        />
      )}
      {flow.entry === "start" && (
        <WorkflowQuestion
          question="这次想优化什么问题？"
          description="你可以自己输入，也可以从品牌全域词库中选择。"
          choices={[
            { id: "direct", label: "自己输入" },
            { id: "library", label: "从品牌全域词库获取" },
          ]}
          onSelect={begin}
        >
          <button
            type="button"
            className="workflow-text-action"
            onClick={() => begin("existing")}
          >
            继续处理已有问题
          </button>
        </WorkflowQuestion>
      )}
      {(flow.entry === "direct" || flow.entry === "library") && (
        <>
          <WorkflowCompleted
            id={`${flow.instanceId}-source`}
            summary={
              flow.entry === "direct" ? "自己输入问题" : "从品牌全域词库获取"
            }
            onRevise={() => begin("start")}
          />
          {flow.entry === "direct" && !flow.confirming && (
            <WorkflowSection
              id={`${flow.instanceId}-input`}
              title="你想优化的具体问题是什么？"
            >
              <div className="workflow-fields">
                <label className="workflow-field">
                  <span>目标问题</span>
                  <textarea
                    value={flow.question}
                    maxLength={4000}
                    placeholder="例如：企业如何选择适合的 AI 服务？"
                    onChange={(event) =>
                      update({ question: event.target.value })
                    }
                  />
                </label>
                <label className="workflow-field">
                  <span>问题类别</span>
                  <select
                    value={flow.category ?? ""}
                    onChange={(event) =>
                      update({
                        category: event.target.value as KeywordCategoryKey,
                      })
                    }
                  >
                    <option value="" disabled>
                      选择问题类别
                    </option>
                    {questionCategoryOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="workflow-actions">
                <button
                  type="button"
                  className="workflow-primary"
                  disabled={flow.question.trim().length < 2 || !flow.category}
                  onClick={() => update({ confirming: true })}
                >
                  检查这个问题
                </button>
              </div>
            </WorkflowSection>
          )}
          {flow.entry === "library" && !flow.confirming && (
            <WorkflowSection
              id={`${flow.instanceId}-library`}
              title="从词库中选择一个问题"
            >
              {dashboard.isLoading ? (
                <WorkflowFeedback>正在读取品牌全域词库…</WorkflowFeedback>
              ) : dashboard.isError ? (
                <WorkflowFeedback
                  error
                  onRetry={() => {
                    void dashboard.refetch();
                  }}
                >
                  词库读取失败，请重试。
                </WorkflowFeedback>
              ) : dashboard.data?.revision ? (
                <KeywordPicker
                  tables={dashboard.data.payload?.keywordTables ?? []}
                  revision={dashboard.data.revision}
                  selected={flow.library}
                  onSelect={chooseKeyword}
                  filters={flow.filters}
                  onFiltersChange={(filters) => update({ filters })}
                />
              ) : (
                <p>当前项目还没有可用词库，可以先自己输入问题。</p>
              )}
            </WorkflowSection>
          )}
          {flow.confirming && (
            <WorkflowSection
              id={`${flow.instanceId}-confirm`}
              title="确认将这个问题加入优化清单？"
            >
              <dl className="workflow-confirmation">
                <dt>目标问题</dt>
                <dd>{flow.question}</dd>
                <dt>问题类别</dt>
                <dd>{keywordCategoryLabel(flow.category)}</dd>
                <dt>问题来源</dt>
                <dd>
                  {flow.entry === "library"
                    ? `品牌全域词库 · 版本 ${flow.library?.dashboardRevision}`
                    : "自主输入"}
                </dd>
                <dt>可用额度</dt>
                <dd>{quotaText}</dd>
              </dl>
              <div className="workflow-actions">
                <button
                  type="button"
                  className="workflow-primary"
                  disabled={
                    busy ||
                    !!outcome.pending ||
                    !portal.capabilities.questionSelection.allowed
                  }
                  onClick={() => {
                    void submit();
                  }}
                >
                  {busy ? "正在保存…" : "确认并保存"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => update({ confirming: false })}
                >
                  返回修改
                </button>
              </div>
              {!portal.capabilities.questionSelection.allowed && (
                <p className="workflow-note">
                  {portal.capabilities.questionSelection.reason ||
                    "当前项目暂不能新增问题。"}
                </p>
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {flow.entry === "existing" && (
        <WorkflowSection
          id={`${flow.instanceId}-existing`}
          title="继续处理哪个问题？"
        >
          <input
            className="workflow-search"
            type="search"
            aria-label="搜索已有问题"
            placeholder="搜索已有问题"
            value={flow.filters.query}
            onChange={(event) =>
              update({
                filters: {
                  ...flow.filters,
                  query: event.target.value,
                  page: 0,
                },
              })
            }
          />
          {portfolio.isError && (
            <WorkflowFeedback
              error
              onRetry={() => {
                void portfolio.refetch();
              }}
            >
              问题读取失败
            </WorkflowFeedback>
          )}
          <ul className="workflow-resource-list">
            {existing
              .slice(flow.filters.page * 10, (flow.filters.page + 1) * 10)
              .map((question) => (
                <li key={question.id}>
                  <button type="button" onClick={() => openQuestion(question)}>
                    {question.question}
                    <small>
                      {keywordCategoryLabel(question.category)} ·{" "}
                      {question.responseLogicConfirmed
                        ? "已有正式应答"
                        : "待制作应答"}
                    </small>
                  </button>
                </li>
              ))}
          </ul>
          <WorkflowPagination
            total={existing.length}
            page={flow.filters.page}
            onChange={(page) => update({ filters: { ...flow.filters, page } })}
          />
        </WorkflowSection>
      )}
      {flow.entry === "result" && (
        <WorkflowSection
          id={`${flow.instanceId}-result`}
          title={
            active?.status === "selected"
              ? "这个问题已加入优化清单。"
              : "正在读取问题的最新状态…"
          }
        >
          {active && (
            <>
              <p>{active.question}</p>
              <p className="workflow-note">
                {keywordCategoryLabel(active.category)} · 版本 {active.revision}
              </p>
              <WorkflowQuestion
                question="接下来要继续添加，还是开始制作应答？"
                choices={[
                  { id: "again", label: "再添加一个" },
                  { id: "response", label: "进入应答逻辑" },
                ]}
                onSelect={(id) => {
                  if (id === "again") setFlow(initialFlow());
                  else onOpenResponseLogic(active.id);
                }}
              />
              <div className="workflow-actions">
                <button
                  type="button"
                  onClick={() => openQuestion(active, "edit")}
                >
                  修改问题
                </button>
                <button
                  type="button"
                  onClick={() => openQuestion(active, "delete")}
                >
                  删除问题
                </button>
              </div>
            </>
          )}
        </WorkflowSection>
      )}
      {(flow.entry === "edit" || flow.entry === "delete") && active && (
        <WorkflowSection
          id={`${flow.instanceId}-edit`}
          title={
            flow.entry === "delete"
              ? "确认删除这个优化问题？"
              : "怎样调整这个问题？"
          }
        >
          {flow.entry === "delete" ? (
            <p>{active.question}</p>
          ) : (
            <label className="workflow-field">
              <span>目标问题</span>
              <textarea
                value={flow.question}
                maxLength={4000}
                onChange={(event) => update({ question: event.target.value })}
              />
            </label>
          )}
          <p className="workflow-note">
            已提交的历史监控继续保留原问题快照。
            {flow.entry === "edit"
              ? "修改后重新检查受影响的应答。"
              : "删除后不再出现在当前优化清单中。"}
          </p>
          <div className="workflow-actions">
            <button
              type="button"
              className="workflow-primary"
              disabled={
                busy ||
                !!outcome.pending ||
                (flow.entry === "edit" &&
                  (flow.question.trim().length < 2 ||
                    flow.question.trim() === active.question))
              }
              onClick={() => {
                void saveEdit();
              }}
            >
              {busy
                ? "正在保存…"
                : flow.entry === "delete"
                  ? "确认删除"
                  : "确认并保存修改"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => openQuestion(active)}
            >
              返回
            </button>
          </div>
        </WorkflowSection>
      )}
      {error && <WorkflowFeedback error>{error}</WorkflowFeedback>}
      {outcome.error && (
        <WorkflowFeedback
          onRetry={() => {
            void outcome.retry();
          }}
        >
          {outcome.error}
        </WorkflowFeedback>
      )}
    </div>
  );
}
