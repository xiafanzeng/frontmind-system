import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import Home from "@/pages/Home";
import {
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { useSendMessage } from "@/hooks/useSendMessage";
import {
  getModelDisplayName,
  retrieveTask,
  type TaskResponse,
} from "@/lib/frontmind-api";
import type {
  ContentProductionDto,
  ContentProductionInput,
  ContentProductionJobKind,
  ContentProductionMode,
} from "@shared/content-production";
import ContentProductionConfirmation from "./ContentProductionConfirmation";
import "./content-production.css";

export const CONTENT_MODES: {
  value: ContentProductionMode;
  title: string;
  description: string;
}[] = [
  {
    value: "new_reference_pack",
    title: "建立新的 Reference Pack",
    description: "整理企业资料，形成可复用的品牌事实、定位与写作资料包。",
  },
  {
    value: "refresh_reference_pack",
    title: "刷新市场研究与定位",
    description: "在已有资料包基础上，更新市场信息、品牌定位与表达。",
  },
  {
    value: "p0",
    title: "创建或导入 P0",
    description: "确认资料包后，选择新建品牌深度文章或接入已有 P0。",
  },
  {
    value: "single_article",
    title: "撰写单问题文章",
    description: "围绕一个问题，结合监控答案与引用信源开展研究和写作。",
  },
];

type LaneStep = { title: string; detail: string; position: number };
export function contentProductionLane(
  mode: ContentProductionMode,
  jobKind?: ContentProductionJobKind | null,
): LaneStep[] {
  const packSteps = [
    { title: "企业资料", detail: "接入企业材料，明确品牌与任务", position: 1 },
    { title: "市场研究", detail: "研究市场与可比较的选择", position: 3 },
    {
      title: "确认比较对象",
      detail: "区分比较对象、同类举例与不纳入的对象",
      position: 4,
    },
    {
      title: "确认核心定位",
      detail: "按确认的范围综合定位与选择理由",
      position: 5,
    },
    {
      title: "交付 Reference Pack",
      detail: "导出定位已确认的新版本资料包",
      position: 7,
    },
  ];
  if (mode === "new_reference_pack" || mode === "refresh_reference_pack")
    return packSteps;
  const routeSteps = [
    {
      title: "选择 Reference Pack",
      detail: "明确使用已有资料包或先创建新资料包",
      position: 1,
    },
    ...(["reference_pack", "reference_pack_refresh"].includes(jobKind ?? "")
      ? packSteps.slice(1)
      : []),
  ];
  if (
    mode === "p0" ||
    mode === "foundation_article" ||
    mode === "import_foundation"
  )
    return [
      ...routeSteps,
      {
        title: "创建或导入 P0",
        detail: "使用已确认的定位与比较范围",
        position: 8,
      },
      {
        title: "选择例文",
        detail: "选择例文文风或工作流写作规范",
        position: 9,
      },
      {
        title: "确认 P0 蓝图",
        detail: "确认结构、材料与已有文章的编辑方案",
        position: 10,
      },
      { title: "正文与编辑", detail: "完成品牌文章和 20 个标题", position: 11 },
      {
        title: "交付 P0 与资料包",
        detail: "Markdown、HTML、DOCX 和新版 Reference Pack",
        position: 12,
      },
    ];
  return [
    ...routeSteps,
    {
      title: "正式问题与应答要求",
      detail: "本题的两篇 AI 答案、企业要求与品牌认知",
      position: 13,
    },
    {
      title: "选择文章类型",
      detail: "阅读分析后，明确选择 P01–P06",
      position: 15,
    },
    { title: "选择例文", detail: "确认文章文风与内容参考", position: 16 },
    {
      title: "问题定位",
      detail: "P01 / P02 确认本题的差异化定位",
      position: 17,
    },
    { title: "确认文章蓝图", detail: "结构、品牌角度与材料使用", position: 18 },
    {
      title: "正文与最终交付",
      detail: "正文、编辑、20 个标题、DOCX 和 HTML",
      position: 19,
    },
  ];
}

function fileList(files: File[]) {
  return files.map((file) => file.name).join("、");
}

function ContentProductionInner() {
  const { state, activeConversation, createConversation, setActive, hydrated } =
    useConversation();
  const { sendMessage } = useSendMessage();
  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<ContentProductionMode | null>(null);
  const [enterpriseName, setEnterpriseName] = useState("");
  const [knowledgeSource, setKnowledgeSource] = useState<"published" | "files">(
    "published",
  );
  const [questionId, setQuestionId] = useState("");
  const [question, setQuestion] = useState("");
  const [materials, setMaterials] = useState<File[]>([]);
  const [pendingStart, setPendingStart] = useState<{
    id: string;
    input: ContentProductionInput;
    files: File[];
    prompt: string;
  } | null>(null);
  const startSent = useRef(new Set<string>());
  const [draftInputs, setDraftInputs] = useState<
    Record<string, ContentProductionInput>
  >({});
  const [task, setTask] = useState<TaskResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const currentId = useRef(activeConversation?.id);
  const refreshSequence = useRef(0);
  currentId.current = activeConversation?.id;
  const taskId = activeConversation?.taskId;
  const progress: ContentProductionDto | null = task?.contentProduction ?? null;
  const input = activeConversation
    ? draftInputs[activeConversation.id]
    : undefined;
  const activeMode = progress?.mode ?? input?.mode ?? "new_reference_pack";
  const modeLabel = CONTENT_MODES.find(
    (item) =>
      item.value === activeMode ||
      (item.value === "p0" &&
        ["foundation_article", "import_foundation"].includes(activeMode)),
  )?.title;
  const busy =
    Boolean(pendingStart) ||
    ["running", "pending"].includes(activeConversation?.status ?? "");

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    if (!taskId) {
      setTask(null);
      return;
    }
    const conversationId = currentId.current;
    setRefreshing(true);
    try {
      const result = await retrieveTask(taskId);
      if (
        currentId.current === conversationId &&
        sequence === refreshSequence.current
      ) {
        setTask(result);
        setNotice("");
      }
    } catch (error) {
      if (
        currentId.current === conversationId &&
        sequence === refreshSequence.current
      )
        setNotice(
          error instanceof Error
            ? error.message
            : "暂时无法读取任务阶段，请稍后刷新。",
        );
    } finally {
      if (
        currentId.current === conversationId &&
        sequence === refreshSequence.current
      )
        setRefreshing(false);
    }
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setNotice("");
  }, [activeConversation?.id]);
  useEffect(() => {
    void refresh();
  }, [
    refresh,
    activeConversation?.status,
    activeConversation?.messages.length,
  ]);
  useEffect(() => {
    if (
      !pendingStart ||
      activeConversation?.id !== pendingStart.id ||
      startSent.current.has(pendingStart.id)
    )
      return;
    startSent.current.add(pendingStart.id);
    setPendingStart(null);
    void sendMessage(pendingStart.prompt, pendingStart.files, {
      purpose: "content_production",
      contentProduction: pendingStart.input,
    });
  }, [pendingStart, activeConversation?.id, sendMessage]);

  function startTask(event: React.FormEvent) {
    event.preventDefault();
    const name = enterpriseName.trim();
    if (
      !mode ||
      !name ||
      (mode === "single_article" && !question.trim() && !questionId.trim())
    )
      return;
    if (mode === "refresh_reference_pack" && materials.length === 0) {
      setNotice("请选择需要刷新的已有 Reference Pack。");
      return;
    }
    const config: ContentProductionInput = {
      mode,
      enterpriseName: name,
      knowledgeSource,
      monitoringAnswerAssetIds: [],
      ...(mode === "single_article"
        ? {
            question: question.trim(),
            ...(questionId.trim() ? { questionId: questionId.trim() } : {}),
          }
        : {}),
    };
    const action = CONTENT_MODES.find((item) => item.value === mode)!.title;
    const prompt = [
      `企业名称：${name}`,
      `本次任务：${action}`,
      knowledgeSource === "published"
        ? "使用我的已发布企业知识库。"
        : materials.length
          ? "使用本次上传的企业材料。"
          : "企业材料或 Reference Pack 将在后续原流程要求时上传，请先展示本任务的原始路由或资料输入步骤。",
      mode === "single_article" &&
        question.trim() &&
        `正式问题：${question.trim()}`,
      mode === "single_article" &&
        questionId.trim() &&
        `问题编号：${questionId.trim()}`,
      materials.length > 0 && `附件：${fileList(materials)}`,
      "请按内容制作流程开始，在需要我确认的内容阶段展示结果。",
    ]
      .filter(Boolean)
      .join("\n");
    const id = createConversation({
      title: `${name} · ${action}`,
      reuseEmpty: false,
      purpose: "content_production",
    });
    setDraftInputs((previous) => ({ ...previous, [id]: config }));
    setPendingStart({ id, input: config, files: materials, prompt });
    setShowCreate(false);
    setNotice("");
    setMaterials([]);
  }

  const steps = contentProductionLane(activeMode, progress?.jobKind);
  const position = progress?.progressPosition ?? 0;
  const finished = position >= 20;
  const turnFailed = ["error", "failed"].includes(task?.status ?? "");
  const currentStep =
    position === 0
      ? 0
      : Math.max(
          0,
          steps.findLastIndex((step) => position >= step.position),
        );

  return (
    <section className="cp-workspace" aria-label="内容制作">
      <header className="cp-heading">
        <div>
          <span className="cp-kicker">FRONTMIND CONTENT</span>
          <h1>内容制作</h1>
          <p>从企业资料到可发布的文章，在同一个任务中逐步完成。</p>
        </div>
        <button
          className="cp-primary"
          onClick={() => {
            setNotice("");
            setMode(null);
            setShowCreate(true);
          }}
          disabled={!hydrated}
        >
          <Plus size={16} />
          新建任务
        </button>
      </header>
      <div className="cp-body">
        <aside className="cp-rail" aria-label="任务与制作阶段">
          <label className="cp-field cp-task-select">
            当前任务
            <div>
              <select
                aria-label="选择内容制作任务"
                value={activeConversation?.id ?? ""}
                onChange={(event) => setActive(event.target.value)}
              >
                <option value="" disabled>
                  选择任务
                </option>
                {state.conversations.map((conversation) => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </label>
          <div className="cp-task-intro">
            <span>{modeLabel}</span>
            <strong>
              {progress?.enterpriseName ??
                input?.enterpriseName ??
                "开始你的内容任务"}
            </strong>
            <p>
              {progress?.knowledgeBase
                ? `企业知识库 v${progress.knowledgeBase.version} · ${progress.knowledgeBase.documentCount} 份资料`
                : input?.knowledgeSource === "files"
                  ? "使用上传材料，可在对话中继续补充"
                  : "资料随任务保存，后续步骤继续使用。"}
            </p>
          </div>
          <ol className="cp-lane">
            {steps.map((step, index) => {
              const done = finished || index < currentStep;
              const current = !finished && index === currentStep;
              return (
                <li
                  key={step.title}
                  className={done ? "is-done" : current ? "is-current" : ""}
                  aria-current={current ? "step" : undefined}
                >
                  <span className="cp-step-icon">
                    {done ? <Check size={15} /> : index + 1}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                    {current && (
                      <span className="cp-step-status">
                        {progress?.confirmation
                          ? "等待内容确认"
                          : turnFailed
                            ? "本轮执行失败，请查看回复"
                            : busy
                              ? "正在执行"
                              : progress?.source === "runner_job_state"
                                ? "当前阶段"
                                : "准备开始"}
                      </span>
                    )}
                  </div>
                  {index < steps.length - 1 && (
                    <ArrowDown className="cp-step-arrow" size={13} />
                  )}
                </li>
              );
            })}
          </ol>
          <div className="cp-rail-footer">
            <span>{finished ? "本次任务已完成" : "阶段依次向下推进"}</span>
            <button
              aria-label="刷新制作阶段"
              onClick={() => void refresh()}
              disabled={!taskId || refreshing}
            >
              {refreshing ? (
                <Loader2 className="animate-spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
            </button>
          </div>
        </aside>
        <div className="cp-dialogue">
          <div className="cp-dialogue-heading">
            <div>
              <Sparkles size={17} />
              <strong>{activeConversation?.title ?? "制作对话"}</strong>
            </div>
            <span>
              {task?.model
                ? `GLM-5.3 · ${getModelDisplayName(task.model)}`
                : "Zhipu · GLM-5.3"}
            </span>
          </div>
          {notice && (
            <div className="cp-notice" role="status">
              {notice}
            </div>
          )}
          {progress && (
            <ContentProductionConfirmation
              key={`${activeConversation?.id}:${progress.runnerRevision}:${progress.confirmation}`}
              progress={progress}
              busy={busy}
              onAction={async (prompt, files, action) => {
                setNotice("");
                await sendMessage(prompt, files, {
                  contentProductionAction: action,
                });
              }}
              onNotice={setNotice}
            />
          )}
          {activeConversation ? (
            <div className="cp-chat">
              <Home
                embedded
                hideSidebar
                hidePortalNavigation
                showKnowledgeBaseStarter={false}
                showAccountMenu={false}
                showSettings={false}
                purpose="content_production"
                contentProduction={input}
                standardWelcomeVariant="simple"
              />
            </div>
          ) : (
            <div className="cp-empty">
              <FileText size={35} />
              <h2>从一份企业资料开始</h2>
              <p>
                新建资料包、刷新品牌定位，或直接进入已有资料支持的文章任务。回复、确认和交付文件都会保存在任务中。
              </p>
              <button
                className="cp-primary"
                onClick={() => {
                  setMode(null);
                  setShowCreate(true);
                }}
                disabled={!hydrated}
              >
                新建内容任务
              </button>
            </div>
          )}
        </div>
      </div>
      {showCreate && (
        <div className="cp-modal-backdrop">
          <section
            className="cp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cp-create-title"
          >
            <header>
              <div>
                <span className="cp-kicker">NEW CONTENT TASK</span>
                <h2 id="cp-create-title">新建内容任务</h2>
              </div>
              <button
                aria-label="关闭新建任务"
                onClick={() => setShowCreate(false)}
              >
                <X size={20} />
              </button>
            </header>
            <form onSubmit={startTask}>
              <fieldset className="cp-mode-list">
                <legend>本次要完成什么？</legend>
                {CONTENT_MODES.map((item) => (
                  <label
                    key={item.value}
                    className={mode === item.value ? "is-selected" : ""}
                  >
                    <input
                      type="radio"
                      name="content-mode"
                      value={item.value}
                      checked={mode === item.value}
                      onChange={() => setMode(item.value)}
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="cp-field">
                企业名称
                <input
                  autoFocus
                  required
                  maxLength={200}
                  value={enterpriseName}
                  onChange={(event) => setEnterpriseName(event.target.value)}
                  placeholder="输入本次任务的企业或品牌名称"
                />
              </label>
              <label className="cp-field">
                企业资料来源
                <select
                  value={knowledgeSource}
                  onChange={(event) =>
                    setKnowledgeSource(
                      event.target.value as "published" | "files",
                    )
                  }
                >
                  <option value="published">使用我的已发布企业知识库</option>
                  <option value="files">上传材料（也可在后续步骤补充）</option>
                </select>
              </label>
              <label className="cp-field">
                {mode === "refresh_reference_pack"
                  ? "上传已有 Reference Pack 与补充资料"
                  : "上传材料或 Reference Pack（可选）"}
                <input
                  type="file"
                  multiple
                  accept=".zip,.pdf,.docx,.doc,.txt,.md,.json,.csv,.xlsx,.png,.jpg,.jpeg,.webp"
                  onChange={(event) =>
                    setMaterials(Array.from(event.target.files ?? []))
                  }
                />
                <small>沿用原始文件内容，可在后续对话中补充资料。</small>
              </label>
              {mode === "single_article" && (
                <>
                  <label className="cp-field">
                    正式问题
                    <textarea
                      required={!questionId.trim()}
                      rows={2}
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder="本篇文章只解决的一个问题"
                    />
                  </label>
                  <label className="cp-field">
                    问题编号（可选）
                    <input
                      value={questionId}
                      onChange={(event) => setQuestionId(event.target.value)}
                      placeholder="已有资料包中的问题编号；没有可留空"
                    />
                  </label>
                </>
              )}
              {notice && (
                <p className="cp-notice" role="alert">
                  {notice}
                </p>
              )}
              <footer>
                <button
                  type="button"
                  className="cp-secondary"
                  onClick={() => setShowCreate(false)}
                >
                  取消
                </button>
                <button
                  className="cp-primary"
                  type="submit"
                  disabled={!mode || Boolean(pendingStart)}
                >
                  创建并开始
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}

export default function ContentProductionWorkspace() {
  return (
    <ConversationPurposeProvider purpose="content_production">
      <ContentProductionInner />
    </ConversationPurposeProvider>
  );
}
