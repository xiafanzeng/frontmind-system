import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { trpc } from "@/lib/trpc";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import { navigate } from "wouter/use-browser-location";
import { keywordCategoryLabel } from "@shared/keyword-categories";
import {
  BrandQuestionUniverseGenerationControl,
  type ManagedKeywordTablesProps,
} from "./ManagedKeywordTables";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import { useBusinessFlowState } from "./useBusinessFlowState";
import { KeywordPicker, keywordPickerRows } from "./workflow/KeywordPicker";
import {
  WorkflowQuestion,
  WorkflowSection,
  WorkflowFeedback,
  WorkflowCompleted,
} from "./workflow/Workflow";

const selectionSchema = z.object({
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
});
const schema = z.object({
  entry: z.enum(["start", "pick", "generate"]),
  pending: selectionSchema.nullable(),
  confirmed: selectionSchema.nullable(),
  filters: z.object({
    query: z.string(),
    category: z.string(),
    page: z.number(),
  }),
});
export function KeywordsWorkflow(props: ManagedKeywordTablesProps) {
  const { task } = useBusinessWorkspace();
  const utils = trpc.useUtils();
  const [flow, setFlow] = useBusinessFlowState<z.infer<typeof schema>>(
    "keywordsWorkflow",
    {
      entry: "start",
      pending: null,
      confirmed: null,
      filters: { query: "", category: "", page: 0 },
    },
    (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inflight = useRef(false);
  const ownerKey = `${task?.scopeKey}:${task?.taskId}`;
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  useEffect(() => {
    setBusy(false);
    setError("");
    inflight.current = false;
  }, [ownerKey]);
  const rows = keywordPickerRows(props.tables, props.dashboardRevision ?? 0);
  const confirmed = flow.confirmed;
  const valid =
    confirmed &&
    props.dashboardRevision === confirmed.dashboardRevision &&
    rows.some(
      (row) =>
        row.tableId === confirmed.tableId &&
        row.rowIndex === confirmed.rowIndex &&
        row.question === confirmed.question &&
        row.category === confirmed.category,
    );
  const savedStates =
    task?.tasks
      ?.map((item) => item.workbench)
      .filter((state) => state?.agentId === "keywords") ?? [];
  const savedSelections = [
    confirmed,
    ...savedStates.map((state) => {
      const parsed = schema.safeParse(state?.values.keywordsWorkflow);
      return parsed.success ? parsed.data.confirmed : null;
    }),
  ].filter((item): item is z.infer<typeof selectionSchema> => Boolean(item));
  const selectionId = (selection: z.infer<typeof selectionSchema>) =>
    `keyword:${selection.dashboardRevision}:${selection.tableId}:${selection.rowIndex}`;
  const projectSelections = savedSelections.filter(
    (selection, index) =>
      savedSelections.findIndex(
        (item) => selectionId(item) === selectionId(selection),
      ) === index,
  );
  const completedHandoffs = [
    ...new Map(
      [...savedStates]
        .reverse()
        .concat(task?.state?.agentId === "keywords" ? [task.state] : [])
        .flatMap((state) => state?.records ?? [])
        .filter(
          (record) =>
            record.status === "completed" &&
            record.targetTask?.agentId === "questions",
        )
        .map((record) => [record.targetTask!.conversationId, record]),
    ).values(),
  ];
  useBusinessWorkspaceSummary({
    title: "项目词库",
    scope: "project",
    items:
      props.tables.length && props.dashboardRevision != null
        ? [
            {
              label: "当前生效词库",
              value: `版本 ${props.dashboardRevision} · ${rows.length} 条问题`,
            },
          ]
        : [],
    outputs: [
      ...projectSelections.map((selection) => ({
        id: selectionId(selection),
        title: selection.question,
        type: "已确认选题引用",
        version: selection.dashboardRevision,
        description: keywordCategoryLabel(selection.category) ?? undefined,
        status:
          props.dashboardRevision === selection.dashboardRevision &&
          rows.some(
            (row) =>
              row.tableId === selection.tableId &&
              row.rowIndex === selection.rowIndex &&
              row.question === selection.question &&
              row.category === selection.category,
          )
            ? "已确认选题"
            : "来源版本已变化 · 需要重新选择",
        source: "来源：当前项目品牌全域词库",
        pendingChanges:
          confirmed && selectionId(selection) === selectionId(confirmed)
            ? JSON.stringify(flow.pending) !== JSON.stringify(confirmed)
            : false,
        onOpen: busy
          ? undefined
          : () => setFlow({ ...flow, entry: "pick", pending: selection }),
      })),
      ...completedHandoffs.map((record) => ({
        id: `keyword-handoff:${record.targetTask!.conversationId}`,
        title: record.detail || record.label,
        type: "问题优化交接",
        status: "已建立优化问题任务",
        onOpen: () =>
          requestWorkspaceNavigation(() =>
            navigate(
              projectWorkspaceUrl(
                `/?view=questions&workbenchTask=${encodeURIComponent(record.targetTask!.conversationId)}`,
              ),
            ),
          ),
      })),
    ],
  });
  const confirm = async () => {
    if (!flow.pending || !task || inflight.current) return;
    setError("");
    setBusy(true);
    inflight.current = true;
    let owner = ownerKey;
    try {
      const id = await task.ensureTask("从词库挑选问题");
      const boundOwner = `${task.scopeKey}:${id}`;
      if (currentOwner.current === boundOwner) owner = boundOwner;
      else if (currentOwner.current !== owner) return;
      // Re-read and resolve against the same version before retaining a selection.
      const current = await utils.workspace.dashboard.fetch();
      if (currentOwner.current !== owner && currentOwner.current !== boundOwner)
        return;
      owner = currentOwner.current;
      const selection = flow.pending;
      const exists =
        current.revision === selection.dashboardRevision &&
        keywordPickerRows(
          current.payload?.keywordTables ?? [],
          current.revision,
        ).some(
          (row) =>
            row.tableId === selection.tableId &&
            row.rowIndex === selection.rowIndex &&
            row.question === selection.question &&
            row.category === selection.category,
        );
      if (!exists) {
        await utils.workspace.dashboard.invalidate();
        throw new Error(
          "词库来源已更新，原选择已保留，请从最新词库重新选择并确认。",
        );
      }
      const next = { ...flow, confirmed: selection };
      // A confirmed selection exists only once task persistence succeeds. There
      // is no independent business mutation here that could be "already saved".
      await task.saveState(
        {
          step: "keyword-confirmed",
          values: { keywordsWorkflow: next },
          record: {
            id: `keyword-${selection.dashboardRevision}-${selection.tableId}-${selection.rowIndex}`.slice(
              0,
              128,
            ),
            label: "已确认词库选题",
            status: "completed",
            detail: selection.question.slice(0, 2000),
          },
        },
        { conversationId: id, scopeKey: task.scopeKey },
      );
      if (currentOwner.current === owner || currentOwner.current === boundOwner)
        setFlow(next);
    } catch (cause) {
      if (currentOwner.current !== owner) return;
      setError(
        cause instanceof Error ? cause.message : "选题确认失败，请重试。",
      );
    } finally {
      if (currentOwner.current === owner) {
        setBusy(false);
        inflight.current = false;
      }
    }
  };
  const handoff = async () => {
    if (!confirmed || !valid || !task || inflight.current) return;
    setError("");
    setBusy(true);
    inflight.current = true;
    const owner = ownerKey;
    try {
      const result = await task.handoff({
        targetAgentId: "questions",
        title: confirmed.question.slice(0, 255),
        resources: [],
        values: {
          questionDraft: confirmed.question,
          questionCategory: confirmed.category,
          questionLibraryRef: {
            dashboardRevision: confirmed.dashboardRevision,
            tableId: confirmed.tableId,
            rowIndex: confirmed.rowIndex,
          },
          questionOrigin: "brand_keyword_library",
        },
        idempotencyKey: `keyword:${confirmed.dashboardRevision}:${confirmed.tableId}:${confirmed.rowIndex}`,
      });
      if (currentOwner.current !== owner) return;
      props.onUseQuestion?.({
        ...confirmed,
        workbenchTaskId: result.conversationId,
      });
    } catch (cause) {
      if (currentOwner.current !== owner) return;
      setError(
        cause instanceof Error ? cause.message : "交接未完成，选择已保留。",
      );
    } finally {
      if (currentOwner.current === owner) {
        setBusy(false);
        inflight.current = false;
      }
    }
  };
  return (
    <div className="keywords-workflow">
      {flow.entry === "start" ? (
        <WorkflowQuestion
          variant="entry" module="brand"
          question={
            props.tables.length
              ? "你想从现有词库挑选问题，还是基于当前知识库生成新的词库？"
              : "要基于当前知识库生成品牌全域词库吗？"
          }
          choices={[
            ...(props.tables.length
              ? [{ id: "pick", label: "从现有词库挑选" }]
              : []),
            { id: "generate", label: "生成词库" },
          ]}
          onSelect={(entry) =>
            setFlow({ ...flow, entry: entry as "pick" | "generate" })
          }
        />
      ) : (
        <WorkflowCompleted
          id="keyword-entry"
          summary={
            flow.entry === "pick"
              ? "从现有词库挑选问题"
              : "基于当前知识库生成词库"
          }
          onRevise={
            busy ? undefined : () => setFlow({ ...flow, entry: "start" })
          }
        />
      )}
      {flow.entry === "generate" && (
        <WorkflowSection id="keyword-generation">
          <BrandQuestionUniverseGenerationControl
            knowledgePublished={props.knowledgePublished}
          />
          {props.tables.length > 0 && (
            <div className="workflow-actions">
              <button
                type="button"
                onClick={() => setFlow({ ...flow, entry: "pick" })}
              >
                从当前词库挑选问题
              </button>
            </div>
          )}
        </WorkflowSection>
      )}
      {flow.entry === "pick" && (
        <WorkflowSection id="keyword-picker" title="这次想围绕哪个问题展开？">
          {props.loading ? (
            <WorkflowFeedback>正在读取词库…</WorkflowFeedback>
          ) : props.error ? (
            <WorkflowFeedback
              error
              onRetry={() => {
                void utils.workspace.dashboard.invalidate();
              }}
            >
              词库读取失败，请重试。
            </WorkflowFeedback>
          ) : props.dashboardRevision ? (
            <fieldset
              disabled={busy || task?.pending}
              className="m-0 min-w-0 border-0 p-0"
            >
              <KeywordPicker
                tables={props.tables}
                revision={props.dashboardRevision}
                selected={flow.pending}
                onSelect={(pending) => setFlow({ ...flow, pending })}
                filters={flow.filters}
                onFiltersChange={(filters) => setFlow({ ...flow, filters })}
              />
            </fieldset>
          ) : (
            <p>当前项目还没有可用词库。</p>
          )}
          {flow.pending && (
            <WorkflowSection
              id="keyword-confirmation"
              title="将这个问题保留为项目选题？"
            >
              <p>{flow.pending.question}</p>
              <p className="workflow-note">
                {keywordCategoryLabel(flow.pending.category)} · 来源词库版本{" "}
                {flow.pending.dashboardRevision}
              </p>
              <div className="workflow-actions">
                {JSON.stringify(flow.pending) !== JSON.stringify(confirmed) ||
                !valid ? (
                  <button
                    className="workflow-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void confirm();
                    }}
                  >
                    {busy ? "正在核对…" : "确认选题"}
                  </button>
                ) : (
                  <button
                    className="workflow-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void handoff();
                    }}
                  >
                    {busy ? "正在交接…" : "交给问题优化"}
                  </button>
                )}
              </div>
            </WorkflowSection>
          )}
        </WorkflowSection>
      )}
      {completedHandoffs.length > 0 && (
        <p className="workflow-note">
          已交接的选题可从右侧项目词库中的交接结果继续处理。
        </p>
      )}
      {error && <WorkflowFeedback error>{error}</WorkflowFeedback>}
    </div>
  );
}
