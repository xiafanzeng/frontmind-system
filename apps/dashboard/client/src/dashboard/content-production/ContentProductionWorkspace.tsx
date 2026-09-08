import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import FilePreview from "@/components/FilePreview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { useSendMessage } from "@/hooks/useSendMessage";
import { retrieveTask, type TaskResponse } from "@/lib/frontmind-api";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import {
  requestWorkspaceNavigation,
  useWorkspaceDraftGuard,
} from "@/lib/workspace-navigation-guard";
import type {
  ContentProductionDto,
  ContentProductionInput,
  ContentProductionJobKind,
  ContentProductionMode,
} from "@shared/content-production";
import ContentProductionConfirmation from "./ContentProductionConfirmation";
import {
  contentProductionArtifactName,
  contentProductionArtifactUrl,
  contentProductionTaskTitle,
} from "@shared/content-production-public";
import "./content-production.css";

export const CONTENT_MODES: {
  value: ContentProductionMode;
  title: string;
  description: string;
}[] = [
  {
    value: "new_reference_pack",
    title: "新建品牌资料包",
    description: "整理企业资料，形成可复用的品牌事实、定位与写作资料包。",
  },
  {
    value: "refresh_reference_pack",
    title: "更新品牌资料包",
    description: "在已有资料包基础上，更新市场信息、品牌定位与表达。",
  },
  {
    value: "p0",
    title: "制作品牌深度文章",
    description: "确认资料包后，新建品牌深度文章，或导入已有文章继续编辑。",
  },
  {
    value: "single_article",
    title: "围绕问题写文章",
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
      title: "交付品牌资料包",
      detail: "导出定位已确认的新版本资料包",
      position: 7,
    },
  ];
  if (
    mode === "new_reference_pack" ||
    mode === "refresh_reference_pack" ||
    jobKind === "reference_pack" ||
    jobKind === "reference_pack_refresh"
  )
    return packSteps;
  const routeSteps = [
    {
      title: "选择品牌资料包",
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
        title: "制作品牌深度文章",
        detail: "使用已确认的定位与比较范围",
        position: 8,
      },
      {
        title: "选择例文",
        detail: "选择例文文风或默认写作规范",
        position: 9,
      },
      {
        title: "确认品牌文章写作方案",
        detail: "确认结构、材料与已有文章的编辑方案",
        position: 10,
      },
      { title: "正文与编辑", detail: "完成品牌文章和 20 个标题", position: 11 },
      {
        title: "交付品牌文章与资料包",
        detail: "正文文档、网页和新版品牌资料包",
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
      detail: "阅读分析后，选择适合本题的文章类型",
      position: 15,
    },
    { title: "选择例文", detail: "确认文章文风与内容参考", position: 16 },
    {
      title: "问题定位",
      detail: "推荐类文章需确认本题的差异化定位",
      position: 17,
    },
    {
      title: "确认文章写作方案",
      detail: "结构、品牌角度与材料使用",
      position: 18,
    },
    {
      title: "正文与最终交付",
      detail: "正文、编辑、20 个标题、文档和网页",
      position: 19,
    },
  ];
}

function fileList(files: File[]) {
  return files.map((file) => file.name).join("、");
}

type Deliverable = { fileUrl: string; fileName: string; mimeType: string };
export function contentArtifactUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin &&
      /^\/api\/frontmind\/v2\/artifacts\/[^/]+\/content$/.test(url.pathname)
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
export function contentProductionFinished(
  progress: ContentProductionDto | null,
) {
  if (
    !progress ||
    progress.source !== "runner_job_state" ||
    progress.confirmation
  )
    return false;
  if (
    progress.jobKind === "reference_pack" ||
    progress.jobKind === "reference_pack_refresh"
  )
    return progress.workflowStatus === "positioning_ready";
  if (progress.jobKind === "p0") return progress.workflowStatus === "p0_ready";
  return (
    progress.jobKind === "article" && progress.workflowStatus === "completed"
  );
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
  const [handoffName, setHandoffName] = useState("");
  const [handoffFile, setHandoffFile] = useState<File | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [selectedPack, setSelectedPack] = useState("");
  const [pendingStart, setPendingStart] = useState<{
    id: string;
    input: ContentProductionInput;
    files: File[];
    prompt: string;
  } | null>(null);
  const [failedStart, setFailedStart] = useState<{
    id: string;
    input: ContentProductionInput;
    prompt: string;
    files: File[];
  } | null>(null);
  const startSent = useRef(new Set<string>());
  const startLocked = useRef(false);
  const handoffLocked = useRef(false);
  const [draftInputs, setDraftInputs] = useState<
    Record<string, ContentProductionInput>
  >({});
  const [taskRead, setTaskRead] = useState<{
    conversationId: string;
    task: TaskResponse;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const currentId = useRef(activeConversation?.id);
  const refreshSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const handoffController = useRef<AbortController | null>(null);
  currentId.current = activeConversation?.id;
  const taskId = activeConversation?.taskId;
  const task =
    taskRead &&
    taskRead.conversationId === activeConversation?.id &&
    taskRead?.task.id === taskId
      ? taskRead.task
      : null;
  const progress = task?.contentProduction ?? null;
  const input = activeConversation
    ? draftInputs[activeConversation.id]
    : undefined;
  const activeMode = progress?.mode ?? input?.mode ?? "new_reference_pack";
  const modeKnown = Boolean(progress || input);
  const modeLabel = !modeKnown
    ? "正在读取任务信息"
    : CONTENT_MODES.find(
        (item) =>
          item.value === activeMode ||
          (item.value === "p0" &&
            ["foundation_article", "import_foundation"].includes(activeMode)),
      )?.title;
  const busy =
    Boolean(pendingStart) ||
    ["running", "pending"].includes(activeConversation?.status ?? "");
  const createDirty =
    showCreate &&
    Boolean(
      mode ||
        enterpriseName.trim() ||
        question.trim() ||
        questionId.trim() ||
        materials.length,
    );
  useWorkspaceDraftGuard({ dirty: createDirty, label: "新建内容任务" });
  useWorkspaceDraftGuard({
    dirty: Boolean(pendingStart) || handoffPending,
    label: "内容任务正在提交",
  });

  useWorkspaceDraftGuard({
    dirty:
      failedStart?.id === activeConversation?.id &&
      Boolean(failedStart) &&
      !pendingStart,
    label: "待重试的内容任务开场信息和文件",
  });

  const refresh = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const rest = captureWorkspaceRestOperation(controller.signal);
    const sequence = ++refreshSequence.current;
    const conversationId = currentId.current;
    if (!taskId || !conversationId) {
      setTaskRead(null);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const result = await retrieveTask(taskId, { signal: rest.signal });
      rest.assertActive();
      if (
        currentId.current === conversationId &&
        sequence === refreshSequence.current
      ) {
        if (
          result.id !== taskId ||
          (result.purpose && result.purpose !== "content_production")
        )
          throw new Error("任务状态与当前内容任务不匹配，请重新读取。");
        setTaskRead({ conversationId, task: result });
        setNotice("");
      }
    } catch (error) {
      if (
        !rest.signal.aborted &&
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
    setTaskRead(null);
    setNotice("");
    setSelectedPack("");
    setConfirmationPending(false);
    return () => {
      readController.current?.abort();
      handoffController.current?.abort();
    };
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
    const start = pendingStart;
    startSent.current.add(start.id);
    const rest = captureWorkspaceRestOperation();
    void (async () => {
      try {
        const accepted = await sendMessage(start.prompt, start.files, {
          purpose: "content_production",
          contentProduction: start.input,
        });
        rest.assertActive();
        if (accepted === false)
          throw new Error(
            "开场请求尚未确认成功。已保留本次说明与文件，可在当前任务重试同一开场请求。",
          );
        setFailedStart(null);
      } catch (error) {
        if (!rest.signal.aborted) {
          setFailedStart({
            id: start.id,
            input: start.input,
            prompt: start.prompt,
            files: start.files,
          });
          if (currentId.current === start.id)
            setNotice(
              error instanceof Error
                ? error.message
                : "任务开始未完成，请查看回复。",
            );
        }
      } finally {
        startLocked.current = false;
        if (!rest.signal.aborted)
          setPendingStart((previous) =>
            previous?.id === start.id ? null : previous,
          );
      }
    })();
  }, [pendingStart, activeConversation?.id, sendMessage]);

  function retryStart() {
    const failed = failedStart;
    if (
      !failed ||
      failed.id !== currentId.current ||
      startLocked.current ||
      busy
    )
      return;
    startLocked.current = true;
    startSent.current.delete(failed.id);
    setNotice("");
    // Same mounted sender, text and original File objects preserve its frozen
    // dispatch envelope after an uncertain response; never create a new task.
    setPendingStart({ ...failed });
  }
  function resetCreate() {
    setMode(null);
    setEnterpriseName("");
    setKnowledgeSource("published");
    setQuestionId("");
    setQuestion("");
    setMaterials([]);
    setHandoffName("");
    setHandoffFile(null);
  }
  function openCreate() {
    requestWorkspaceNavigation(() => {
      setFailedStart(null);
      resetCreate();
      setNotice("");
      setShowCreate(true);
    });
  }
  function closeCreate() {
    requestWorkspaceNavigation(() => {
      setShowCreate(false);
      resetCreate();
    });
  }
  function startTask(event: React.FormEvent) {
    event.preventDefault();
    const name = enterpriseName.trim();
    if (
      startLocked.current ||
      !mode ||
      !name ||
      (mode === "single_article" && !question.trim() && !questionId.trim())
    )
      return;
    if (mode === "refresh_reference_pack" && materials.length === 0) {
      setNotice("请选择需要更新的已有品牌资料包。");
      return;
    }
    startLocked.current = true;
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
          : "企业材料或品牌资料包将在后续需要时上传，请先展示本任务的资料选择步骤。",
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
    try {
      const id = createConversation({
        title: `${name} · ${action}`,
        reuseEmpty: false,
        purpose: "content_production",
      });
      setDraftInputs((previous) => ({ ...previous, [id]: config }));
      setPendingStart({ id, input: config, files: [...materials], prompt });
      setShowCreate(false);
      setNotice("");
      resetCreate();
    } catch (error) {
      startLocked.current = false;
      setNotice(
        error instanceof Error ? error.message : "创建任务失败，请重试。",
      );
    }
  }
  const steps = contentProductionLane(activeMode, progress?.jobKind);
  const position = progress?.progressPosition ?? 0;
  const finished = contentProductionFinished(progress);
  const packFinished =
    finished &&
    (progress?.jobKind === "reference_pack" ||
      progress?.jobKind === "reference_pack_refresh");
  const handoffAvailable =
    finished && (packFinished || progress?.jobKind === "p0");
  const convertedToPack =
    packFinished &&
    !["new_reference_pack", "refresh_reference_pack"].includes(activeMode);
  const turnFailed = ["error", "failed"].includes(
    task?.status ?? activeConversation?.status ?? "",
  );
  const currentStep =
    position === 0
      ? 0
      : Math.max(
          0,
          steps.findLastIndex((step) => position >= step.position),
        );
  const statusLabel = !modeKnown
    ? taskId
      ? "任务信息待读取"
      : "尚未开始"
    : turnFailed
      ? "本轮执行失败"
      : progress?.confirmation
        ? "等待内容确认"
        : finished
          ? packFinished
            ? "资料包已交付"
            : "本次任务已完成"
          : busy
            ? "正在执行"
            : progress?.source === "runner_job_state"
              ? "当前阶段"
              : "准备开始";
  const deliverables = [
    ...new Map(
      (activeConversation?.messages ?? [])
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.outputFiles ?? [])
        .filter(
          (file) =>
            contentArtifactUrl(file.fileUrl) &&
            !/frontmind_workflow_job_(?:snapshot|state)/i.test(file.fileName),
        )
        .map((file) => [file.fileUrl, file]),
    ).values(),
  ];
  const packFiles = deliverables.filter((file) =>
    /\.zip$/i.test(file.fileName),
  );

  async function prepareNextTask(
    nextMode: "p0" | "single_article",
    file: Deliverable,
  ) {
    if (
      handoffLocked.current ||
      !handoffAvailable ||
      !progress ||
      !currentId.current
    )
      return;
    const conversationId = currentId.current;
    const source = { ...file };
    const name = progress.enterpriseName;
    const url = contentArtifactUrl(source.fileUrl);
    if (!url || !/\.zip$/i.test(source.fileName)) return;
    handoffLocked.current = true;
    setHandoffPending(true);
    setNotice("");
    const controller = new AbortController();
    handoffController.current = controller;
    const rest = captureWorkspaceRestOperation(controller.signal);
    try {
      const response = await rest.fetch(url, { credentials: "include" });
      if (!response.ok)
        throw new Error("资料包读取失败，请刷新任务或重新下载后上传。");
      const blob = await response.blob();
      rest.assertActive();
      if (currentId.current !== conversationId) return;
      if (!blob.size || blob.size > 64 * 1024 * 1024)
        throw new Error("资料包为空或超过可复用的文件大小，请检查交付文件。");
      const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      rest.assertActive();
      if (
        signature[0] !== 0x50 ||
        signature[1] !== 0x4b ||
        ![
          [3, 4],
          [5, 6],
          [7, 8],
        ].some(
          ([third, fourth]) =>
            signature[2] === third && signature[3] === fourth,
        )
      )
        throw new Error("该附件不是有效 ZIP 资料包，请选择正确文件。");
      if (currentId.current !== conversationId) return;
      resetCreate();
      setMode(nextMode);
      setEnterpriseName(name);
      setKnowledgeSource("files");
      const carriedFile = new File([blob], source.fileName, {
        type: "application/zip",
      });
      setHandoffFile(carriedFile);
      setMaterials([carriedFile]);
      setHandoffName(source.fileName);
      setShowCreate(true);
    } catch (error) {
      if (!rest.signal.aborted && currentId.current === conversationId)
        setNotice(
          error instanceof Error
            ? error.message
            : "资料包复用失败，请重新选择。",
        );
    } finally {
      handoffLocked.current = false;
      setHandoffPending(false);
    }
  }
  return (
    <section className="cp-workspace" aria-label="内容制作">
      <header className="cp-heading">
        <div>
          <span className="cp-kicker">内容工作台</span>
          <h1>内容制作</h1>
        </div>
        <button
          className="cp-primary"
          onClick={openCreate}
          disabled={!hydrated || Boolean(pendingStart) || handoffPending}
        >
          <Plus size={18} />
          新建任务
        </button>
      </header>
      <div className="cp-taskbar">
        <label className="cp-field cp-task-select">
          当前任务
          <div>
            <select
              aria-label="选择内容制作任务"
              value={activeConversation?.id ?? ""}
              disabled={Boolean(pendingStart) || handoffPending}
              onChange={(event) => {
                const id = event.target.value;
                requestWorkspaceNavigation(() => {
                  setFailedStart(null);
                  setActive(id);
                });
              }}
            >
              <option value="" disabled>
                选择任务
              </option>
              {state.conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {contentProductionTaskTitle(conversation.title)}
                  {["running", "pending"].includes(conversation.status)
                    ? " · 执行中"
                    : ["error", "failed"].includes(conversation.status)
                      ? " · 本轮失败"
                      : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </label>
        <div className="cp-task-context">
          <strong>
            {activeConversation ? modeLabel : "选择一种任务，开始内容制作"}
          </strong>
          <span>
            {progress?.knowledgeBase
              ? `企业知识库 v${progress.knowledgeBase.version} · ${progress.knowledgeBase.documentCount} 份资料`
              : input?.knowledgeSource === "files"
                ? "使用上传材料，可在对话中继续补充"
                : "资料与确认记录随任务保存"}
          </span>
        </div>
        {activeConversation && (
          <span className={`cp-status ${turnFailed ? "is-error" : ""}`}>
            {statusLabel}
          </span>
        )}
      </div>
      {notice && (
        <div className="cp-notice" role="status">
          {notice}
        </div>
      )}
      <div className={`cp-body ${!activeConversation ? "is-empty" : ""}`}>
        <div className="cp-dialogue">
          <div className="cp-dialogue-heading">
            <div>
              <Sparkles size={18} />
              <strong>内容协作</strong>
            </div>
            <span>FrontMind 内容智能体</span>
          </div>
          {activeConversation ? (
            <>
              {failedStart?.id === activeConversation.id && (
                <details className="cp-start-recovery">
                  <summary>查看已保留的开场信息</summary>
                  <p>{failedStart.prompt}</p>
                  {failedStart.files.length > 0 && (
                    <small>文件：{fileList(failedStart.files)}</small>
                  )}
                  <div className="cp-confirm-actions">
                    <button
                      className="cp-secondary"
                      onClick={retryStart}
                      disabled={busy}
                    >
                      重试本次开场请求
                    </button>
                  </div>
                </details>
              )}
              <div className="cp-chat">
                <Home
                  key={activeConversation.id}
                  embedded
                  operatorWorkspace
                  knowledgeEditingBlocked={
                    Boolean(pendingStart) ||
                    confirmationPending ||
                    handoffPending
                  }
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
            </>
          ) : (
            <div className="cp-empty">
              <FileText size={36} />
              <h2>本次要完成什么？</h2>
              <p className="cp-entry-description">
                <span className="cp-entry-description-full">
                  新建或更新品牌资料包，制作品牌文章，或围绕具体问题开展研究与写作。
                </span>
                <span className="cp-entry-description-short">
                  整理资料，制作文章。
                </span>
              </p>
              <div className="cp-entry-grid">
                {CONTENT_MODES.map((item) => (
                  <button
                    key={item.value}
                    disabled={!hydrated}
                    onClick={() => {
                      resetCreate();
                      setMode(item.value);
                      setShowCreate(true);
                    }}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {activeConversation && (
          <aside className="cp-results" aria-label="任务进度与交付成果">
            <header className="cp-results-heading">
              <div>
                <strong>任务成果</strong>
                <span>阶段确认与交付文件</span>
              </div>
              <button
                aria-label="刷新制作阶段"
                className="cp-icon-button"
                onClick={() => void refresh()}
                disabled={!taskId || refreshing}
              >
                {refreshing ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <RefreshCw size={18} />
                )}
              </button>
            </header>
            <div className="cp-results-scroll">
              <details
                className="cp-progress"
                open={!progress?.confirmation && !finished}
              >
                <summary>
                  制作进度 <span>{statusLabel}</span>
                </summary>
                {!modeKnown ? (
                  <p className="cp-progress-empty">
                    制作阶段将在本任务的信息读取后显示。
                  </p>
                ) : (
                  <ol className="cp-lane">
                    {steps.map((step, index) => {
                      const done = finished || index < currentStep;
                      const current = !finished && index === currentStep;
                      return (
                        <li
                          key={step.title}
                          className={
                            done ? "is-done" : current ? "is-current" : ""
                          }
                          aria-current={current ? "step" : undefined}
                        >
                          <span className="cp-step-icon">
                            {done ? <Check size={16} /> : index + 1}
                          </span>
                          <div>
                            <strong>{step.title}</strong>
                            <p>{step.detail}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </details>
              {progress && (
                <ContentProductionConfirmation
                  key={`${activeConversation.id}:${progress.runnerRevision}:${progress.confirmation}`}
                  progress={progress}
                  busy={busy}
                  onPendingChange={setConfirmationPending}
                  onAction={async (prompt, files, action) => {
                    const id = activeConversation.id;
                    if (currentId.current !== id)
                      throw new Error("任务已切换，请在当前任务重新确认。");
                    setNotice("");
                    const accepted = await sendMessage(prompt, files, {
                      contentProductionAction: action,
                    });
                    if (accepted === false)
                      throw new Error(
                        "本轮提交尚未确认成功，请查看任务回复中的提示。",
                      );
                  }}
                  onNotice={setNotice}
                />
              )}
              {handoffAvailable && (
                <section className="cp-handoff">
                  <strong>
                    {packFinished
                      ? "品牌资料包已完成"
                      : "品牌文章与新版资料包已完成"}
                  </strong>
                  <p>
                    {convertedToPack
                      ? "本次选择先创建资料包，文章尚未制作。"
                      : "资料包可用于后续品牌文章与问题文章。"}
                    请选择交付的资料包，创建独立的新任务。
                  </p>
                  {packFiles.length > 0 ? (
                    <>
                      <label className="cp-field">
                        用于下一任务的资料包
                        <select
                          value={selectedPack}
                          onChange={(event) =>
                            setSelectedPack(event.target.value)
                          }
                          disabled={handoffPending}
                        >
                          <option value="">请选择已交付的品牌资料包</option>
                          {packFiles.map((file) => (
                            <option key={file.fileUrl} value={file.fileUrl}>
                              {contentProductionArtifactName(file.fileName)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="cp-confirm-actions">
                        {(["p0", "single_article"] as const).map((next) => (
                          <button
                            key={next}
                            className={
                              next === "p0" ? "cp-primary" : "cp-secondary"
                            }
                            disabled={!selectedPack || handoffPending}
                            onClick={() => {
                              const file = packFiles.find(
                                (item) => item.fileUrl === selectedPack,
                              );
                              if (file)
                                requestWorkspaceNavigation(() => {
                                  void prepareNextTask(next, file);
                                });
                            }}
                          >
                            {handoffPending && (
                              <Loader2 size={16} className="animate-spin" />
                            )}
                            {next === "p0"
                              ? "使用此资料包制作品牌文章"
                              : "使用此资料包围绕问题写文章"}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="cp-muted">
                      交付 ZIP
                      尚未出现在任务附件中。可刷新任务，或下载后在新任务中上传。
                    </p>
                  )}
                </section>
              )}
              <section className="cp-deliverables">
                <header>
                  <strong>交付文件</strong>
                  <span>{deliverables.length} 份</span>
                </header>
                {deliverables.length ? (
                  deliverables.map((file) => (
                    <FilePreview
                      key={file.fileUrl}
                      file={{
                        id: file.fileUrl,
                        type: "file",
                        name: contentProductionArtifactName(file.fileName),
                        blobUrl: contentProductionArtifactUrl(
                          contentArtifactUrl(file.fileUrl)!,
                        ),
                      }}
                      className="cp-deliverable-file"
                    />
                  ))
                ) : (
                  <p>
                    任务生成的可用附件会汇总在这里。完整说明与表格保存在左侧对话。
                  </p>
                )}
              </section>
            </div>
          </aside>
        )}
      </div>
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent
          className="cp-modal"
          overlayClassName="cp-modal-overlay"
          showCloseButton={false}
        >
          <header>
            <div>
              <DialogTitle>新建内容任务</DialogTitle>
              <DialogDescription>
                确定本次交付目标，再选择资料来源。
              </DialogDescription>
            </div>
            <button
              type="button"
              className="cp-icon-button"
              aria-label="关闭新建任务"
              onClick={closeCreate}
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
            {handoffName && (
              <p className="cp-form-context">
                已带入资料包：{contentProductionArtifactName(handoffName)}
                。这是独立的新任务，开始后仍需确认使用已有资料包。
              </p>
            )}
            <label className="cp-field">
              企业名称
              <input
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
                aria-label="企业资料来源"
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
              <small>
                企业知识库提供企业事实材料。品牌资料包进一步汇总市场研究、已确认定位和写作资料。文章任务开始后，需要确认使用已有资料包，或先创建资料包。
              </small>
            </label>
            <label className="cp-field">
              {handoffFile
                ? "补充企业材料（可选，已保留带入的资料包）"
                : mode === "refresh_reference_pack"
                  ? "上传已有品牌资料包与补充资料"
                  : "上传材料或品牌资料包（可选）"}
              <input
                type="file"
                multiple
                accept=".zip,.pdf,.docx,.doc,.txt,.md,.json,.csv,.xlsx,.png,.jpg,.jpeg,.webp"
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  if (handoffFile) {
                    setMaterials([
                      handoffFile,
                      ...selected.filter(
                        (file) => file.name !== handoffFile.name,
                      ),
                    ]);
                    if (selected.some((file) => file.name === handoffFile.name))
                      setNotice("已保留带入的资料包，同名附件未重复添加。");
                  } else setMaterials(selected);
                }}
              />
              <small>
                {materials.length
                  ? `已选择：${fileList(materials)}`
                  : "沿用原始文件内容，可在后续对话中补充资料。"}
              </small>
            </label>
            {mode === "single_article" && (
              <>
                <p className="cp-form-context">
                  问题文章需要含已完成品牌文章的品牌资料包，以及来自两个不同 AI
                  平台的两篇完整答案。可在任务要求资料时补充。
                </p>
                <label className="cp-field">
                  正式问题
                  <textarea
                    required={!questionId.trim()}
                    rows={2}
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    maxLength={20000}
                    placeholder="本篇文章只解决的一个问题"
                  />
                </label>
                <label className="cp-field">
                  问题编号（可选）
                  <input
                    maxLength={200}
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
                onClick={closeCreate}
              >
                取消
              </button>
              <button
                className="cp-primary"
                type="submit"
                disabled={!mode || Boolean(pendingStart) || handoffPending}
              >
                创建并开始
              </button>
            </footer>
          </form>
        </DialogContent>
      </Dialog>
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
