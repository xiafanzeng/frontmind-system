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
  ContentProductionAction,
  ContentProductionDto,
  ContentProductionInput,
  ContentProductionMode,
} from "@shared/content-production";
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
    value: "foundation_article",
    title: "创建 P0 品牌文章",
    description: "以企业资料为依据，完成品牌基础文章的蓝图、正文和交付。",
  },
  {
    value: "import_foundation",
    title: "导入 P0 品牌文章",
    description: "接入已有品牌底稿，整理为后续内容制作可用的材料。",
  },
  {
    value: "single_article",
    title: "撰写单问题文章",
    description: "围绕一个问题，结合监控答案与引用信源开展研究和写作。",
  },
];

type LaneStep = { title: string; detail: string; position: number };
export function contentProductionLane(mode: ContentProductionMode): LaneStep[] {
  if (mode === "import_foundation")
    return [
      {
        title: "导入已有底稿",
        detail: "整理上传的 P0 文章，作为后续内容制作的参考",
        position: 1,
      },
    ];
  if (mode === "new_reference_pack" || mode === "refresh_reference_pack")
    return [
      { title: "企业资料", detail: "接入知识库或已有材料", position: 1 },
      {
        title: "研究与品牌定位",
        detail: "市场、事实、表达与视觉",
        position: 3,
      },
      { title: "确认资料摘要", detail: "确认品牌重点与写作方向", position: 8 },
      {
        title: "交付 Reference Pack",
        detail: "保存可复用的企业资料包",
        position: 9,
      },
    ];
  return [
    {
      title: "资料与正式问题",
      detail:
        mode === "foundation_article"
          ? "品牌基础文章 · P14"
          : "企业材料、监控答案与信源",
      position: 10,
    },
    ...(mode === "single_article"
      ? [
          {
            title: "研究与文章类型",
            detail: "根据研究选择推荐或备选",
            position: 11,
          },
        ]
      : []),
    { title: "确认文章蓝图", detail: "结构、品牌角度与视觉计划", position: 13 },
    { title: "正文与编辑", detail: "整篇写作、事实修订与视觉", position: 14 },
    { title: "候选优化", detail: "比较候选，保留稳定的正本", position: 18 },
    { title: "标题与最终交付", detail: "标题集、DOCX 和 HTML", position: 19 },
  ];
}

const ACTION_LABELS: Record<ContentProductionAction["kind"], string> = {
  confirm_pack: "确认摘要，生成资料包",
  provide_research_inputs: "提交监控答案与信源",
  confirm_pattern: "确认文章类型",
  confirm_blueprint: "确认蓝图，开始正文",
  set_title_count: "生成标题并完成交付",
};

function fileList(files: File[]) {
  return files.map((file) => file.name).join("、");
}

function ContentProductionInner() {
  const { state, activeConversation, createConversation, setActive, hydrated } =
    useConversation();
  const { sendMessage } = useSendMessage();
  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<ContentProductionMode>("new_reference_pack");
  const [enterpriseName, setEnterpriseName] = useState("");
  const [knowledgeSource, setKnowledgeSource] = useState<"published" | "files">(
    "published",
  );
  const [entry, setEntry] =
    useState<NonNullable<ContentProductionInput["entry"]>>("product_scenario");
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
  const [actionPending, setActionPending] = useState(false);
  const [selectedPattern, setSelectedPattern] = useState("");
  const [blueprintEdits, setBlueprintEdits] = useState("");
  const [titleCount, setTitleCount] = useState(5);
  const [answers, setAnswers] = useState<File[]>([]);
  const [sources, setSources] = useState<File[]>([]);
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
    (item) => item.value === activeMode,
  )?.title;
  const busy =
    actionPending ||
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
    setSelectedPattern("");
    setBlueprintEdits("");
    setAnswers([]);
    setSources([]);
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
    if (!name || (mode === "single_article" && !question.trim())) return;
    if (knowledgeSource === "files" && materials.length === 0) {
      setNotice("请选择本次使用的企业资料或 Reference Pack。");
      return;
    }
    if (
      ["refresh_reference_pack", "import_foundation"].includes(mode) &&
      materials.length === 0
    ) {
      setNotice(
        mode === "import_foundation"
          ? "请选择要导入的 P0 品牌文章。"
          : "请选择需要刷新的已有 Reference Pack。",
      );
      return;
    }
    const config: ContentProductionInput = {
      mode,
      enterpriseName: name,
      knowledgeSource,
      monitoringAnswerAssetIds: [],
      ...(mode === "single_article"
        ? { entry, question: question.trim() }
        : {}),
    };
    const action = CONTENT_MODES.find((item) => item.value === mode)!.title;
    const prompt = [
      `企业名称：${name}`,
      `本次任务：${action}`,
      knowledgeSource === "published"
        ? "使用我的已发布企业知识库。"
        : "使用本次上传的企业材料。",
      question.trim() && `正式问题：${question.trim()}`,
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

  async function confirm(kind: ContentProductionAction["kind"]) {
    let action: ContentProductionAction;
    let prompt: string;
    let files: File[] = [];
    if (kind === "confirm_pack") {
      action = { kind };
      prompt = "我确认当前资料摘要，请生成 Reference Pack。";
    } else if (kind === "provide_research_inputs") {
      if (!answers.length || !sources.length) {
        setNotice("请分别选择本题的监控答案和引用信源文件。");
        return;
      }
      action = { kind };
      files = [...answers, ...sources];
      prompt = `本题的监控答案文件：${fileList(answers)}\n引用信源文件：${fileList(sources)}\n请读取这些资料，继续本题研究。`;
    } else if (kind === "confirm_pattern") {
      const pattern = selectedPattern.trim().toUpperCase();
      if (pattern && !/^P\d{2}$/.test(pattern)) {
        setNotice(
          "请填写研究结果提供的文章类型编号，例如 P02；留空则接受推荐。",
        );
        return;
      }
      action = { kind, ...(pattern ? { selectedPattern: pattern } : {}) };
      prompt = pattern
        ? `我选择研究结果中的 ${pattern}，请继续形成文章蓝图。`
        : "我接受研究结果推荐的文章类型，请继续形成文章蓝图。";
    } else if (kind === "confirm_blueprint") {
      action = {
        kind,
        ...(blueprintEdits.trim()
          ? { blueprintEdits: blueprintEdits.trim() }
          : {}),
      };
      prompt = blueprintEdits.trim()
        ? `请按这些调整确认文章蓝图并继续正文：\n${blueprintEdits.trim()}`
        : "我确认当前文章蓝图，请继续正文制作。";
    } else {
      action = { kind, titleCount };
      prompt = `请基于最终正文生成 ${titleCount} 个不同角度的标题，并完成最终交付。`;
    }
    setActionPending(true);
    setNotice("");
    try {
      await sendMessage(prompt, files, { contentProductionAction: action });
      setAnswers([]);
      setSources([]);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "提交未完成，请查看任务回复。",
      );
    } finally {
      setActionPending(false);
    }
  }

  const steps = contentProductionLane(activeMode);
  const position = progress?.progressPosition ?? 0;
  const finished = position >= 20;
  const importMode = activeMode === "import_foundation";
  const turnFailed = ["error", "failed"].includes(task?.status ?? "");
  const importTurnComplete = importMode && task?.status === "completed";
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
                  ? "使用本次上传材料"
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
                              : importTurnComplete
                                ? "本轮整理已结束，请查看回复与附件"
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
            <span>
              {importMode
                ? "导入已有底稿作为后续参考"
                : finished
                  ? "本次任务已完成"
                  : "阶段依次向下推进"}
            </span>
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
          {progress?.availableActions.length ? (
            <div className="cp-confirmation">
              <strong>确认后继续下一步</strong>
              <p>先阅读下方回复；需要调整时，可以直接在对话中说明。</p>
              {progress.availableActions.includes(
                "provide_research_inputs",
              ) && (
                <div className="cp-file-grid">
                  <label className="cp-field">
                    本题监控答案
                    <input
                      type="file"
                      multiple
                      accept=".xlsx,.csv,.json"
                      onChange={(event) =>
                        setAnswers(Array.from(event.target.files ?? []))
                      }
                    />
                  </label>
                  <label className="cp-field">
                    引用信源文件
                    <input
                      type="file"
                      multiple
                      accept=".xlsx,.csv,.json"
                      onChange={(event) =>
                        setSources(Array.from(event.target.files ?? []))
                      }
                    />
                  </label>
                </div>
              )}
              {progress.availableActions.includes("confirm_pattern") && (
                <label className="cp-field">
                  采用回复中的备选（可选）
                  <input
                    value={selectedPattern}
                    onChange={(event) => setSelectedPattern(event.target.value)}
                    placeholder="留空采用推荐；或填写 P02 等合法备选"
                  />
                </label>
              )}
              {progress.availableActions.includes("confirm_blueprint") && (
                <label className="cp-field">
                  蓝图调整（可选）
                  <textarea
                    value={blueprintEdits}
                    onChange={(event) => setBlueprintEdits(event.target.value)}
                    placeholder="章节顺序、品牌角度或其他具体调整"
                    rows={2}
                  />
                </label>
              )}
              {progress.availableActions.includes("set_title_count") && (
                <label className="cp-field cp-title-count">
                  标题数量
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={titleCount}
                    onChange={(event) =>
                      setTitleCount(
                        Math.min(
                          20,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      )
                    }
                  />
                </label>
              )}
              <div className="cp-confirm-actions">
                {progress.availableActions.map((kind) => (
                  <button
                    key={kind}
                    className="cp-primary"
                    disabled={busy}
                    onClick={() => void confirm(kind)}
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {ACTION_LABELS[kind]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
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
                onClick={() => setShowCreate(true)}
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
                  <option value="files">使用本次上传的材料</option>
                </select>
              </label>
              <label className="cp-field">
                {mode === "import_foundation"
                  ? "上传已有 P0 品牌文章"
                  : mode === "refresh_reference_pack"
                    ? "上传已有 Reference Pack 与补充资料"
                    : "上传材料（可选）"}
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
                      required
                      rows={2}
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder="本篇文章只解决的一个问题"
                    />
                  </label>
                  <label className="cp-field">
                    内容入口
                    <select
                      value={entry}
                      onChange={(event) =>
                        setEntry(event.target.value as typeof entry)
                      }
                    >
                      <option value="product_scenario">产品场景</option>
                      <option value="industry_ranking">行业排名</option>
                      <option value="competitor_comparison">竞品对比</option>
                      <option value="reputation">美誉舆情</option>
                    </select>
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
                  disabled={Boolean(pendingStart)}
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
