import {
  AlertTriangle,
  BarChart3,
  BookOpenCheck,
  Check,
  CircleDot,
  ChevronRight,
  FileClock,
  FileText,
  ImagePlus,
  Layers3,
  Loader2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Paperclip,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type ComponentType,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Home from "@/pages/Home";
import FilePreview from "@/components/FilePreview";
import ImagePreview from "@/components/ImagePreview";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import QuestionMaintenanceRequestDialog from "@/components/QuestionMaintenanceRequestDialog";
import CustomerRequestHistoryDialog from "@/components/CustomerRequestHistoryDialog";
import { Button } from "@/components/ui/button";
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
import {
  useConversation,
  type Attachment,
  type Conversation,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import { trpc } from "@/lib/trpc";
import {
  RESPONSE_LOGIC_RESET_REQUIRED_MESSAGE_ID_PREFIX,
  type ResponseLogicTaskStartFailure,
} from "@/lib/frontmind-api";
import { toast } from "sonner";
import {
  keywordCategoryKey,
  keywordCategoryTone,
} from "@shared/keyword-categories";
import type {
  ConfirmedResponseLogic,
  ResponseLogicAttachment,
  ResponseLogicDraft,
  ResponseLogicImage,
  ResponseLogicRecordDto,
  SaveResponseLogicInput,
} from "@shared/response-logic";
import {
  normalizeResponseLogicPublicProvenance,
  normalizeResponseLogicPublicText,
  parseResponseLogicStructuredDraft,
  projectResponseLogicAssistantMarkdown,
  responseLogicTaskStatusEnvelopeSchema,
  serializeResponseLogicStructuredDraft,
  type ResponseLogicStructuredDraft,
  type ResponseLogicTaskStatusEnvelope,
} from "@shared/response-logic";
import "./response-logic-workspace.css";

export interface IntentQuestion {
  id: string;
  question: string;
  intent: string;
  summary: string;
}

export interface IntentQuestionGroup {
  id: string;
  title: string;
  subtitle: string;
  tone: "plum" | "teal" | "amber" | "blue";
  questions: IntentQuestion[];
}

/**
 * Formal workspaces never fall back to tenant/demo questions. Questions must
 * come from the service entitlement or an administrator-published dashboard.
 * Development previews inject their own data through the DEV-only preview
 * router.
 */
const EMPTY_QUESTION_GROUPS: IntentQuestionGroup[] = [];
const RESPONSE_LOGIC_FACTS_DISPLAY_HEADING =
  "企业材料/官方依据（引自知识库文档）";

type LogicImage = ResponseLogicImage;
type LogicDraft = ResponseLogicDraft;
type ConfirmedLogic = ConfirmedResponseLogic;
type LogicTextField = keyof Omit<LogicDraft, "images" | "attachments">;

export type ResponseLogicWorkspaceState = {
  selectedGroupId: string;
  setSelectedGroupId: Dispatch<SetStateAction<string>>;
  selectedQuestionId: string;
  setSelectedQuestionId: Dispatch<SetStateAction<string>>;
  drafts: Record<string, LogicDraft>;
  setDrafts: Dispatch<SetStateAction<Record<string, LogicDraft>>>;
  confirmations: Record<string, ConfirmedLogic>;
  setConfirmations: Dispatch<SetStateAction<Record<string, ConfirmedLogic>>>;
  conversationIds: Record<string, string>;
  setConversationIds: Dispatch<SetStateAction<Record<string, string>>>;
  updateNotice: string;
  setUpdateNotice: Dispatch<SetStateAction<string>>;
};

export type ResponseLogicWorkspaceProps = {
  preview: boolean;
  workspaceState?: ResponseLogicWorkspaceState;
  initialQuestionId?: string | null;
  onSelectedQuestionChange?: (questionId: string) => void;
  onPublished?: (questionId: string) => void;
  questionGroups?: IntentQuestionGroup[];
};

export type ResponseLogicPreviewDialogueProps = {
  question: IntentQuestion;
  onLoadLatestReply: (reply: string) => void | Promise<unknown>;
};

type ResponseLogicLoadResult = "saved" | "displayed_unsaved" | "ignored";
type ResponseLogicLoadReply = (
  reply: string,
  message?: LocalMessage,
  taskId?: string,
  operationRevision?: number,
  onTaskUnavailable?: () => void,
  suppliedStructuredDraft?: ResponseLogicStructuredDraft,
) => Promise<ResponseLogicLoadResult>;

export type ResponseLogicPreviewAdapter = {
  createDraft: (
    question: IntentQuestion,
    group: IntentQuestionGroup,
  ) => ResponseLogicDraft;
  createPublishedConfirmation: (
    question: IntentQuestion,
    group: IntentQuestionGroup,
  ) => ConfirmedResponseLogic;
  Dialogue: ComponentType<ResponseLogicPreviewDialogueProps>;
};

function useResponseLogicPreviewAdapter(enabled: boolean) {
  const [adapter, setAdapter] = useState<ResponseLogicPreviewAdapter | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    if (!enabled || !import.meta.env.DEV) return;
    void import("@/dev/ResponseLogicPreview")
      .then(({ responseLogicPreviewAdapter }) => {
        if (active) setAdapter(responseLogicPreviewAdapter);
      })
      .catch(() => {
        if (active) setAdapter(null);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  return adapter;
}

function createEmptyDraft(question: IntentQuestion): LogicDraft {
  return {
    concern: question.intent,
    conclusion: "",
    facts: "",
    pending: "",
    boundaries: "",
    references: "",
    images: [],
    attachments: [],
  };
}

/**
 * Converts only a server-compatible four-section Pro response into editable
 * fields. Invalid or partial model text is rejected instead of being copied
 * into an arbitrary draft field.
 */
export function parseResponseLogicReply(
  reply: string,
): Pick<LogicDraft, LogicTextField> {
  return {
    ...parseResponseLogicStructuredDraft(reply),
    pending: "",
    references: "",
  };
}

export class ResponseLogicTaskStatusError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      stage?: "transport" | "http" | "response";
    } = {},
  ) {
    super(message);
    this.name = "ResponseLogicTaskStatusError";
  }
}

const RESPONSE_LOGIC_BINDING_FORBIDDEN_CODES = new Set([
  "RESPONSE_LOGIC_WORKSPACE_FORBIDDEN",
  "RESPONSE_LOGIC_QUESTION_FORBIDDEN",
  "RESPONSE_LOGIC_CONVERSATION_FORBIDDEN",
  "RESPONSE_LOGIC_TASK_FORBIDDEN",
  "RESPONSE_LOGIC_OPERATION_FORBIDDEN",
]);

export function isResponseLogicBindingForbiddenCode(code: string) {
  return RESPONSE_LOGIC_BINDING_FORBIDDEN_CODES.has(code);
}

export function responseLogicTaskStatusIsRetryable(
  status: number,
  code: string,
) {
  if (status === 403 && isResponseLogicBindingForbiddenCode(code)) return false;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export function authoritativeResponseLogicTaskMatches(input: {
  records: ReadonlyArray<
    Pick<ResponseLogicRecordDto, "questionId" | "lastTaskId" | "revision">
  >;
  questionId: string;
  taskId: string;
  operationRevision: number;
}) {
  const record = input.records.find(
    (candidate) => candidate.questionId === input.questionId,
  );
  return Boolean(
    record &&
      record.lastTaskId === input.taskId &&
      record.revision === input.operationRevision,
  );
}

export function getResponseLogicPollDelay(
  elapsedMs: number,
  consecutiveFailures = 0,
) {
  const steady = elapsedMs < 5 * 60_000 ? 3_000 : 10_000;
  return Math.min(30_000, steady * 2 ** Math.min(consecutiveFailures, 3));
}

export function responseLogicResultMessageId(resultId: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < resultId.length; index += 1) {
    hash ^= resultId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const readable = resultId.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 72);
  return `response-logic-${readable || "result"}-${hash.toString(16)}`;
}

export function canReloadResponseLogicTask(input: {
  taskId?: string;
  readOnly: boolean;
  loading: boolean;
  resetRequired?: boolean;
}) {
  return Boolean(
    input.taskId && !input.readOnly && !input.loading && !input.resetRequired,
  );
}

export function scopedResponseLogicTaskStartFailure<
  T extends ResponseLogicTaskStartFailure & {
    questionId: string;
    conversationId: string;
  },
>(input: { failure: T | null; questionId: string; conversationId?: string }) {
  return input.failure?.questionId === input.questionId &&
    input.failure.conversationId === input.conversationId
    ? input.failure
    : null;
}

export function durableResponseLogicResetBarrier(input: {
  conversation?: Pick<Conversation, "id" | "status" | "messages">;
  questionId: string;
}):
  | (ResponseLogicTaskStartFailure & {
      questionId: string;
      conversationId: string;
    })
  | null {
  const conversation = input.conversation;
  if (
    !conversation ||
    conversation.status !== "error" ||
    !conversation.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.id.startsWith(RESPONSE_LOGIC_RESET_REQUIRED_MESSAGE_ID_PREFIX),
    )
  ) {
    return null;
  }
  return {
    code: "RESPONSE_LOGIC_RESET_REQUIRED",
    message: "此前应答逻辑任务的创建结果无法确认",
    retryable: false,
    resetRequired: true,
    stage: "response" as const,
    questionId: input.questionId,
    conversationId: conversation.id,
  };
}

export async function fetchResponseLogicTaskStatus(input: {
  questionId: string;
  conversationId: string;
  taskId: string;
  operationRevision: number;
  signal?: AbortSignal;
}): Promise<ResponseLogicTaskStatusEnvelope> {
  const query = new URLSearchParams({
    questionId: input.questionId,
    conversationId: input.conversationId,
    operationRevision: String(input.operationRevision),
  });
  let response: Response;
  try {
    response = await fetch(
      `/api/response-logic/tasks/${encodeURIComponent(input.taskId)}/status?${query.toString()}`,
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: input.signal,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ResponseLogicTaskStatusError(
      "RESPONSE_LOGIC_TASK_TRANSPORT_FAILED",
      "应答逻辑结果传输中断，系统将自动重试",
      { retryable: true, stage: "transport" },
    );
  }

  let responseText = "";
  try {
    responseText = await response.text();
  } catch {
    throw new ResponseLogicTaskStatusError(
      "RESPONSE_LOGIC_TASK_RESPONSE_READ_FAILED",
      "应答逻辑结果传输校验失败，系统将自动重试",
      { status: response.status, retryable: true, stage: "response" },
    );
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(responseText);
  } catch {
    if (response.ok) {
      throw new ResponseLogicTaskStatusError(
        "RESPONSE_LOGIC_TASK_RESPONSE_INVALID_JSON",
        "应答逻辑结果传输校验失败，系统将自动重试",
        { status: response.status, retryable: true, stage: "response" },
      );
    }
  }

  if (!response.ok) {
    const apiError =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
        ? payload.error
        : null;
    const message =
      apiError && "message" in apiError && typeof apiError.message === "string"
        ? apiError.message
        : `读取应答逻辑任务失败（${response.status}）`;
    const code =
      apiError && "code" in apiError && typeof apiError.code === "string"
        ? apiError.code
        : "RESPONSE_LOGIC_TASK_READ_FAILED";
    throw new ResponseLogicTaskStatusError(code, message, {
      status: response.status,
      // Generic session/project authorization can refresh while the provider
      // task remains valid. Exact binding-forbidden codes are permanent for
      // this tuple and must instead hand off to the authoritative record.
      retryable: responseLogicTaskStatusIsRetryable(response.status, code),
      stage: "http",
    });
  }

  const parsed = responseLogicTaskStatusEnvelopeSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.taskId !== input.taskId ||
    parsed.data.operationRevision !== input.operationRevision
  ) {
    throw new ResponseLogicTaskStatusError(
      "RESPONSE_LOGIC_TASK_RESPONSE_INVALID",
      "服务端返回的应答逻辑状态未通过传输协议校验",
      { status: response.status, retryable: true, stage: "response" },
    );
  }
  return parsed.data;
}

export async function fetchResponseLogicStructuredDraft(input: {
  questionId: string;
  conversationId: string;
  taskId: string;
  operationRevision: number;
}): Promise<ResponseLogicStructuredDraft> {
  const observation = await fetchResponseLogicTaskStatus(input);
  if (observation.status !== "completed") {
    throw new Error("应答逻辑任务尚未完成，请稍后重试");
  }
  return observation.structuredDraft;
}

function responseLogicAttachmentUrl(fileId: string) {
  return `/api/frontmind/v1/files/${encodeURIComponent(fileId)}`;
}

function responseLogicChatAttachment(
  attachment: ResponseLogicAttachment,
): Attachment {
  return {
    id: `response-logic-source-${attachment.fileId}`,
    type: attachment.kind === "image" ? "image" : "file",
    name: attachment.filename,
    fileId: attachment.fileId,
    expiresAt: attachment.expiresAt,
    expired: attachment.expired,
  };
}

export function isResponseLogicAttachmentExpired(
  attachment: Pick<ResponseLogicAttachment, "expired" | "expiresAt">,
  now = Date.now(),
) {
  return (
    attachment.expired === true ||
    (typeof attachment.expiresAt === "number" &&
      Number.isFinite(attachment.expiresAt) &&
      attachment.expiresAt <= now)
  );
}

/**
 * Only provider-owned assistant outputs may feed the response-logic draft.
 * Local error/help bubbles have no provider id, files, or response start time.
 */
export function isAuthoritativeResponseLogicAssistantMessage(
  message: LocalMessage,
) {
  return (
    message.role === "assistant" &&
    !message.isStepsPlaceholder &&
    Boolean(
      message.upstreamOutputId ||
        message.outputFiles?.length ||
        message.responseStartedAt !== undefined,
    ) &&
    Boolean(message.content.trim() || message.outputFiles?.length)
  );
}

export function projectResponseLogicConversationMessage(
  message: LocalMessage,
): LocalMessage {
  if (message.role !== "assistant") return message;
  const publicOutputFileName = (fileName: string, mimeType: string) => {
    const extension = fileName.match(/\.([A-Za-z0-9]+)$/u)?.[1]?.toLowerCase();
    const image = mimeType.startsWith("image/");
    return `${image ? "模型输出图片" : "模型输出资料"}${extension ? `.${extension}` : ""}`;
  };
  const publicStepText = (value?: string) =>
    value ? normalizeResponseLogicPublicText(value) : undefined;

  return {
    ...message,
    content: message.content
      ? projectResponseLogicAssistantMarkdown(message.content).replace(
          /^##[ \t]+企业材料\/官方依据[ \t]*$/mu,
          `## ${RESPONSE_LOGIC_FACTS_DISPLAY_HEADING}`,
        )
      : message.content,
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      name: attachment.type === "image" ? "模型输出图片" : "模型输出资料",
    })),
    outputFiles: message.outputFiles?.map((file) => ({
      ...file,
      fileName: publicOutputFileName(file.fileName, file.mimeType),
    })),
    inlineImages: message.inlineImages?.map((image) => ({
      ...image,
      alt: "模型输出图片",
    })),
    intermediateSteps: message.intermediateSteps?.map((step) => ({
      ...step,
      label: publicStepText(step.label) || "正在整理应答逻辑",
      description: publicStepText(step.description),
      details: publicStepText(step.details),
    })),
    stepGroups: message.stepGroups?.map((group) => ({
      ...group,
      title: publicStepText(group.title) || "正在整理应答逻辑",
      description: publicStepText(group.description),
      steps: group.steps.map((step) => ({
        ...step,
        label: publicStepText(step.label) || "正在整理应答逻辑",
        description: publicStepText(step.description),
        details: publicStepText(step.details),
      })),
    })),
  };
}

export function mergeResponseLogicAttachmentsIntoDraft(
  draft: LogicDraft,
  attachments: ResponseLogicAttachment[],
): LogicDraft {
  const mergedAttachments = new Map<string, ResponseLogicAttachment>();
  for (const attachment of [...draft.attachments, ...attachments]) {
    mergedAttachments.set(attachment.fileId, attachment);
  }
  const authoritativeAttachments = [...mergedAttachments.values()];
  const expiredUploadImageIds = new Set(
    authoritativeAttachments
      .filter(
        (attachment) =>
          attachment.kind === "image" &&
          isResponseLogicAttachmentExpired(attachment),
      )
      .map((attachment) => `response-logic-upload-${attachment.fileId}`),
  );
  const uploadedImages: LogicImage[] = authoritativeAttachments
    .filter(
      (attachment) =>
        attachment.kind === "image" &&
        !isResponseLogicAttachmentExpired(attachment),
    )
    .map((attachment) => ({
      id: `response-logic-upload-${attachment.fileId}`,
      name: attachment.filename,
      url: responseLogicAttachmentUrl(attachment.fileId),
      caption: attachment.filename.replace(/\.[^.]+$/, ""),
      source: `企业交流上传：${attachment.filename}`,
      section: "图文依据",
      authorization: "本次应答可用",
    }));

  return {
    ...draft,
    attachments: authoritativeAttachments,
    images: [
      ...draft.images.filter((image) => !expiredUploadImageIds.has(image.id)),
      ...uploadedImages.filter(
        (candidate) =>
          !draft.images.some(
            (image) => image.id === candidate.id || image.url === candidate.url,
          ),
      ),
    ],
  };
}

export function useResponseLogicWorkspaceState(
  questionGroups: IntentQuestionGroup[] = EMPTY_QUESTION_GROUPS,
): ResponseLogicWorkspaceState {
  const firstGroup = questionGroups[0];
  const firstQuestion = firstGroup?.questions[0];
  const [selectedGroupId, setSelectedGroupId] = useState(firstGroup?.id ?? "");
  const [selectedQuestionId, setSelectedQuestionId] = useState(
    firstQuestion?.id ?? "",
  );
  const [drafts, setDrafts] = useState<Record<string, LogicDraft>>({});
  const [confirmations, setConfirmations] = useState<
    Record<string, ConfirmedLogic>
  >({});
  const [conversationIds, setConversationIds] = useState<
    Record<string, string>
  >({});
  const [updateNotice, setUpdateNotice] = useState("");

  return {
    selectedGroupId,
    setSelectedGroupId,
    selectedQuestionId,
    setSelectedQuestionId,
    drafts,
    setDrafts,
    confirmations,
    setConfirmations,
    conversationIds,
    setConversationIds,
    updateNotice,
    setUpdateNotice,
  };
}

function formatConfirmedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupIcon(tone: IntentQuestionGroup["tone"]) {
  if (tone === "teal") return Layers3;
  if (tone === "amber") return BarChart3;
  if (tone === "blue") return Search;
  return MessageSquareText;
}

function semanticGroupCategory(group: IntentQuestionGroup) {
  return keywordCategoryKey(group.id) || keywordCategoryKey(group.title);
}

function semanticGroupTone(group: IntentQuestionGroup) {
  return (
    keywordCategoryTone(group.id) ||
    keywordCategoryTone(group.title) ||
    group.tone
  );
}

type ResponseLogicPersistence = {
  records?: ResponseLogicRecordDto[];
  loading: boolean;
  ready: boolean;
  error?: string;
  retry: () => void;
  refresh: () => Promise<ResponseLogicRecordDto[]>;
  save: (
    input: SaveResponseLogicInput,
  ) => Promise<{ record: ResponseLogicRecordDto }>;
};

export function responseLogicPersistenceAvailability(input: {
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  hasData: boolean;
  errorMessage?: string;
}) {
  return {
    // Background fetching must not unmount the live conversation/editor.
    loading: input.isLoading,
    // Keep cached content interactive when a background refresh fails. The
    // next successful poll can reconcile it without flashing back to loading.
    ready: input.isSuccess || input.hasData,
    error:
      input.isError && !input.hasData
        ? input.errorMessage || "应答逻辑数据载入失败"
        : undefined,
  };
}

export function reconcileResponseLogicDrafts(
  current: Record<string, LogicDraft>,
  records: ResponseLogicRecordDto[],
  previousRecordIds: ReadonlySet<string> | null,
) {
  if (previousRecordIds === null) {
    return Object.fromEntries(
      records.map((record) => [record.questionId, record.draft]),
    );
  }
  const nextRecordIds = new Set(records.map((record) => record.questionId));
  const next = { ...current };
  previousRecordIds.forEach((questionId) => {
    if (!nextRecordIds.has(questionId)) delete next[questionId];
  });
  records.forEach((record) => {
    // A confirmation made in another tab is authoritative and immutable.
    // Draft records keep any possibly unsaved local edit during refresh.
    if (record.confirmed || !next[record.questionId]) {
      next[record.questionId] = record.draft;
    }
  });
  return next;
}

export function shouldUseResponseLogicInitialPrompt(
  conversation: {
    taskId?: string;
    previousResponseId?: string;
    messages: Array<Pick<LocalMessage, "role">>;
  },
  readOnly: boolean,
) {
  return (
    !readOnly &&
    !conversation.taskId &&
    !conversation.previousResponseId &&
    !conversation.messages.some((message) => message.role === "user")
  );
}

export function shouldHydrateResponseLogicTask(input: {
  authoritativeTaskId?: string;
  localTaskId?: string;
  localPreviousResponseId?: string;
  unavailableTaskIds: ReadonlySet<string>;
  resetRequired?: boolean;
}) {
  return Boolean(
    input.authoritativeTaskId &&
      !input.resetRequired &&
      !input.unavailableTaskIds.has(input.authoritativeTaskId) &&
      (input.localTaskId !== input.authoritativeTaskId ||
        input.localPreviousResponseId !== input.authoritativeTaskId),
  );
}

export function responseLogicContinuationRevision(input: {
  persistedRevision?: number;
  activeTaskRevision?: number;
}) {
  // A completed task save advances the record revision. Reusing the task's
  // older operation revision on /turn would incorrectly continue a stale
  // operation, so only the latest persisted record may authorize a turn.
  return Number.isSafeInteger(input.persistedRevision) &&
    Number(input.persistedRevision) > 0
    ? Number(input.persistedRevision)
    : undefined;
}

export function canRequestResponseLogicReset(input: {
  preview: boolean;
  record?: Pick<ResponseLogicRecordDto, "questionId">;
}) {
  return !input.preview && Boolean(input.record?.questionId);
}

export default function ResponseLogicWorkspace(
  props: ResponseLogicWorkspaceProps,
) {
  if (!props.questionGroups?.length) {
    return (
      <ResponseLogicConfirmationState
        title="当前周期尚无服务问题"
        description="服务问题同步后，可在这里逐题对话、核验并确认应答逻辑。"
      />
    );
  }
  if (props.preview) {
    return import.meta.env.DEV ? (
      <DevelopmentResponseLogicWorkspace {...props} />
    ) : (
      <ResponseLogicConfirmationState
        title="开发预览不可用"
        description="生产环境不会加载验收预览数据。"
      />
    );
  }
  return <PersistentResponseLogicWorkspace {...props} />;
}

function DevelopmentResponseLogicWorkspace(props: ResponseLogicWorkspaceProps) {
  const previewAdapter = useResponseLogicPreviewAdapter(true);
  if (!previewAdapter) {
    return (
      <ResponseLogicConfirmationState
        title="正在载入开发预览"
        description="正在读取本地匿名验收数据。"
        loading
      />
    );
  }
  return (
    <ResponseLogicWorkspaceContent
      {...props}
      persistence={null}
      previewAdapter={previewAdapter}
    />
  );
}

export type ResponseLogicConfirmationBoardProps = {
  preview: boolean;
  workspaceState?: ResponseLogicWorkspaceState;
  initialQuestionId?: string | null;
  questionGroups?: IntentQuestionGroup[];
  previewPublished?: boolean;
  onOpenAgent?: (questionId: string) => void;
};

export function ResponseLogicConfirmationBoard(
  props: ResponseLogicConfirmationBoardProps,
) {
  if (props.preview) {
    return import.meta.env.DEV ? (
      <DevelopmentResponseLogicConfirmationBoard {...props} />
    ) : (
      <ResponseLogicConfirmationState
        title="开发预览不可用"
        description="生产环境不会加载验收预览数据。"
      />
    );
  }
  return <PersistentResponseLogicConfirmationBoard {...props} />;
}

export function ResponseLogicReadOnlyConfirmationBoard({
  questionGroups,
  records,
}: {
  questionGroups: IntentQuestionGroup[];
  records: ResponseLogicRecordDto[];
}) {
  return (
    <ResponseLogicConfirmationBoardContent
      preview={false}
      questionGroups={questionGroups}
      records={records}
      loading={false}
      error=""
      onRetry={() => undefined}
    />
  );
}

function DevelopmentResponseLogicConfirmationBoard(
  props: ResponseLogicConfirmationBoardProps,
) {
  const previewAdapter = useResponseLogicPreviewAdapter(true);
  if (!previewAdapter) {
    return (
      <ResponseLogicConfirmationState
        title="正在载入开发预览"
        description="正在读取本地匿名验收数据。"
        loading
      />
    );
  }
  return (
    <ResponseLogicConfirmationBoardContent
      {...props}
      previewAdapter={previewAdapter}
      records={[]}
      loading={false}
      error=""
      onRetry={() => undefined}
    />
  );
}

function PersistentResponseLogicConfirmationBoard(
  props: ResponseLogicConfirmationBoardProps,
) {
  const recordsQuery = trpc.workspace.responseLogic.useQuery(undefined, {
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  return (
    <ResponseLogicConfirmationBoardContent
      {...props}
      records={recordsQuery.data?.records ?? []}
      loading={recordsQuery.isLoading}
      error={
        recordsQuery.isError && !recordsQuery.data
          ? recordsQuery.error.message || "应答逻辑成果载入失败"
          : ""
      }
      onRetry={() => {
        void recordsQuery.refetch();
      }}
    />
  );
}

function ResponseLogicConfirmationBoardContent({
  workspaceState,
  initialQuestionId,
  questionGroups,
  preview,
  previewPublished,
  onOpenAgent,
  records,
  loading,
  error,
  onRetry,
  previewAdapter,
}: ResponseLogicConfirmationBoardProps & {
  records: ResponseLogicRecordDto[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  previewAdapter?: ResponseLogicPreviewAdapter;
}) {
  const groups = questionGroups ?? EMPTY_QUESTION_GROUPS;
  const internalState = useResponseLogicWorkspaceState(groups);
  const state = workspaceState ?? internalState;
  const questionEntries = useMemo(
    () =>
      groups.flatMap((group) =>
        group.questions.map((question) => ({ group, question })),
      ),
    [groups],
  );
  const questionEntryById = useMemo(
    () => new Map(questionEntries.map((entry) => [entry.question.id, entry])),
    [questionEntries],
  );
  const recordConfirmations = useMemo(
    () =>
      Object.fromEntries(
        records
          .filter(
            (record) =>
              Boolean(record.confirmed) &&
              questionEntryById.has(record.questionId),
          )
          .map((record) => [record.questionId, record.confirmed!]),
      ),
    [questionEntryById, records],
  );
  const previewConfirmations = useMemo(() => {
    if (!preview || !previewPublished || !previewAdapter) return {};
    return Object.fromEntries(
      questionEntries.map(({ group, question }) => [
        question.id,
        previewAdapter.createPublishedConfirmation(question, group),
      ]),
    );
  }, [preview, previewPublished, previewAdapter, questionEntries]);
  const confirmations = preview
    ? {
        ...previewConfirmations,
        ...state.confirmations,
      }
    : recordConfirmations;

  const appliedInitialQuestionId = useRef<string | null>(null);
  useEffect(() => {
    if (
      !initialQuestionId ||
      appliedInitialQuestionId.current === initialQuestionId
    ) {
      return;
    }
    const entry = questionEntryById.get(initialQuestionId);
    if (!entry) return;
    appliedInitialQuestionId.current = initialQuestionId;
    state.setSelectedGroupId(entry.group.id);
    state.setSelectedQuestionId(initialQuestionId);
  }, [
    initialQuestionId,
    questionEntryById,
    state.setSelectedGroupId,
    state.setSelectedQuestionId,
  ]);

  const firstQuestionId = questionEntries[0]?.question.id ?? "";
  const requestedQuestionId =
    initialQuestionId &&
    appliedInitialQuestionId.current !== initialQuestionId &&
    questionEntryById.has(initialQuestionId)
      ? initialQuestionId
      : state.selectedQuestionId;
  const activeQuestionId = questionEntryById.has(requestedQuestionId)
    ? requestedQuestionId
    : firstQuestionId;
  const selectedEntry = questionEntryById.get(activeQuestionId);

  useEffect(() => {
    if (!selectedEntry) return;
    if (state.selectedGroupId !== selectedEntry.group.id) {
      state.setSelectedGroupId(selectedEntry.group.id);
    }
    if (state.selectedQuestionId !== selectedEntry.question.id) {
      state.setSelectedQuestionId(selectedEntry.question.id);
    }
  }, [selectedEntry, state]);

  if (questionEntries.length === 0 || !selectedEntry) {
    return (
      <ResponseLogicConfirmationState
        title="当前周期尚无服务问题"
        description="服务问题同步后，这里会按问题展示应答逻辑智能体确认的正式内容。"
      />
    );
  }

  const selectGroup = (group: IntentQuestionGroup) => {
    const questionId = group.questions[0]?.id;
    if (!questionId) return;
    state.setSelectedGroupId(group.id);
    state.setSelectedQuestionId(questionId);
  };
  const selectQuestion = (questionId: string) => {
    const entry = questionEntryById.get(questionId);
    if (!entry) return;
    state.setSelectedGroupId(entry.group.id);
    state.setSelectedQuestionId(questionId);
  };
  const confirmed = confirmations[activeQuestionId];

  return (
    <div className="rl-layout">
      <QuestionNavigator
        groups={groups}
        confirmedQuestionIds={new Set(Object.keys(confirmations))}
        selectedGroupId={selectedEntry.group.id}
        selectedQuestionId={activeQuestionId}
        onSelectGroup={selectGroup}
        onSelectQuestion={selectQuestion}
        navTitle="问题目录"
      />

      {loading ? (
        <ResponseLogicConfirmationState
          title="正在载入问题优化成果"
          description="正在同步应答逻辑智能体已确认的正式内容。"
          loading
        />
      ) : error ? (
        <ResponseLogicConfirmationState
          title="问题优化成果载入失败"
          description={error}
          actionLabel="重新载入"
          onAction={onRetry}
        />
      ) : confirmed ? (
        <ResponseLogicConfirmationPanel
          group={selectedEntry.group}
          question={selectedEntry.question}
          logic={confirmed}
          showPublicationMeta={false}
          actionLabel={onOpenAgent ? "查看已确认应答逻辑" : undefined}
          onAction={
            onOpenAgent ? () => onOpenAgent(activeQuestionId) : undefined
          }
        />
      ) : (
        <ResponseLogicConfirmationState
          title="尚未形成已确认的应答逻辑"
          description={`“${selectedEntry.question.question}”还没有从应答逻辑智能体发布的正式内容；草稿和预填内容不会在这里展示。`}
          actionLabel={onOpenAgent ? "进入应答逻辑智能体" : undefined}
          onAction={
            onOpenAgent ? () => onOpenAgent(activeQuestionId) : undefined
          }
        />
      )}
    </div>
  );
}

function ResponseLogicConfirmationState({
  title,
  description,
  actionLabel,
  onAction,
  loading = false,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
}) {
  return (
    <section className="rl-confirmation-state">
      <span className="rl-confirmation-state-icon">
        {loading ? (
          <Loader2 size={24} className="animate-spin" />
        ) : (
          <BookOpenCheck size={24} />
        )}
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {actionLabel && onAction && (
        <button type="button" className="rl-primary-button" onClick={onAction}>
          {actionLabel}
          <ChevronRight size={16} />
        </button>
      )}
    </section>
  );
}

function PersistentResponseLogicWorkspace(props: ResponseLogicWorkspaceProps) {
  const utils = trpc.useUtils();
  const recordsQuery = trpc.workspace.responseLogic.useQuery(undefined, {
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const saveMutation = trpc.workspace.saveResponseLogic.useMutation({
    onSuccess: ({ record }) => {
      utils.workspace.responseLogic.setData(undefined, (current) => {
        const records = current?.records || [];
        const nextRecords = records.some(
          (item) => item.questionId === record.questionId,
        )
          ? records.map((item) =>
              item.questionId === record.questionId ? record : item,
            )
          : [...records, record];
        return { records: nextRecords };
      });
    },
  });
  const availability = responseLogicPersistenceAvailability({
    isLoading: recordsQuery.isLoading,
    isFetching: recordsQuery.isFetching,
    isSuccess: recordsQuery.isSuccess,
    isError: recordsQuery.isError,
    hasData: Boolean(recordsQuery.data),
    errorMessage: recordsQuery.error?.message,
  });
  return (
    <ResponseLogicWorkspaceContent
      {...props}
      persistence={{
        records: recordsQuery.data?.records,
        ...availability,
        retry: () => {
          void recordsQuery.refetch();
        },
        refresh: async () => {
          const result = await recordsQuery.refetch();
          if (result.error) throw result.error;
          return result.data?.records ?? [];
        },
        save: (input) => saveMutation.mutateAsync(input),
      }}
    />
  );
}

function ResponseLogicWorkspaceContent({
  preview,
  workspaceState,
  initialQuestionId,
  onSelectedQuestionChange,
  onPublished,
  questionGroups,
  persistence,
  previewAdapter,
}: ResponseLogicWorkspaceProps & {
  persistence: ResponseLogicPersistence | null;
  previewAdapter?: ResponseLogicPreviewAdapter;
}) {
  const groups = questionGroups ?? EMPTY_QUESTION_GROUPS;
  const questionEntries = useMemo(
    () =>
      groups.flatMap((group) =>
        group.questions.map((question) => ({ group, question })),
      ),
    [groups],
  );
  const questionEntryById = useMemo(
    () => new Map(questionEntries.map((entry) => [entry.question.id, entry])),
    [questionEntries],
  );
  const internalState = useResponseLogicWorkspaceState(groups);
  const {
    selectedGroupId,
    setSelectedGroupId,
    selectedQuestionId,
    setSelectedQuestionId,
    drafts,
    setDrafts,
    confirmations,
    setConfirmations,
    conversationIds,
    setConversationIds,
    updateNotice,
    setUpdateNotice,
  } = workspaceState ?? internalState;
  const objectUrls = useRef(new Set<string>());
  const syncedRecordIdsRef = useRef<Set<string> | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [requestHistoryOpen, setRequestHistoryOpen] = useState(false);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);

  useEffect(() => {
    if (!workspaceExpanded) return;

    const bodyOverflow = document.body.style.overflow;
    const documentOverflow = document.documentElement.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceExpanded(false);
    };

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", exitOnEscape);

    return () => {
      document.removeEventListener("keydown", exitOnEscape);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = documentOverflow;
    };
  }, [workspaceExpanded]);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(() => {
    if (preview || !persistence?.ready || !persistence.records) {
      return;
    }
    const records = persistence.records;
    const previousRecordIds = syncedRecordIdsRef.current;
    const nextRecordIds = new Set(records.map((record) => record.questionId));

    if (previousRecordIds === null) {
      setDrafts((current) =>
        reconcileResponseLogicDrafts(current, records, previousRecordIds),
      );
      setConfirmations(
        Object.fromEntries(
          records
            .filter((record) => Boolean(record.confirmed))
            .map((record) => [record.questionId, record.confirmed!]),
        ),
      );
      setConversationIds(
        Object.fromEntries(
          records
            .filter((record) => Boolean(record.conversationId))
            .map((record) => [record.questionId, record.conversationId!]),
        ),
      );
      syncedRecordIdsRef.current = nextRecordIds;
      return;
    }

    const removedRecordIds = [...previousRecordIds].filter(
      (questionId) => !nextRecordIds.has(questionId),
    );
    if (removedRecordIds.length > 0) setUpdateNotice("");
    setDrafts((current) =>
      reconcileResponseLogicDrafts(current, records, previousRecordIds),
    );
    setConfirmations((current) => {
      const next = { ...current };
      removedRecordIds.forEach((questionId) => delete next[questionId]);
      records.forEach((record) => {
        if (record.confirmed) next[record.questionId] = record.confirmed;
        else delete next[record.questionId];
      });
      return next;
    });
    setConversationIds((current) => {
      const next = { ...current };
      removedRecordIds.forEach((questionId) => delete next[questionId]);
      records.forEach((record) => {
        if (record.conversationId && !next[record.questionId]) {
          next[record.questionId] = record.conversationId;
        }
      });
      return next;
    });
    syncedRecordIdsRef.current = nextRecordIds;
  }, [
    preview,
    persistence?.records,
    persistence?.ready,
    setConfirmations,
    setConversationIds,
    setDrafts,
    setUpdateNotice,
  ]);

  useEffect(() => {
    if (!initialQuestionId) return;
    const entry = questionEntryById.get(initialQuestionId);
    if (!entry) return;
    setSelectedGroupId(entry.group.id);
    setSelectedQuestionId(initialQuestionId);
    setUpdateNotice("");
  }, [
    initialQuestionId,
    setSelectedGroupId,
    setSelectedQuestionId,
    setUpdateNotice,
    questionEntryById,
  ]);

  const selectedEntry =
    questionEntryById.get(selectedQuestionId) ?? questionEntries[0];
  const activeQuestionId = selectedEntry?.question.id ?? "";
  useEffect(() => {
    if (!selectedEntry) return;
    if (questionEntryById.has(selectedQuestionId)) return;
    setSelectedGroupId(selectedEntry.group.id);
    setSelectedQuestionId(activeQuestionId);
    onSelectedQuestionChange?.(activeQuestionId);
  }, [
    activeQuestionId,
    onSelectedQuestionChange,
    questionEntryById,
    selectedEntry?.group.id,
    selectedQuestionId,
    setSelectedGroupId,
    setSelectedQuestionId,
  ]);

  if (!selectedEntry) {
    return (
      <ResponseLogicConfirmationState
        title="当前周期尚无服务问题"
        description="服务问题同步后，这里会按问题载入应答逻辑草稿与正式确认内容。"
      />
    );
  }

  const draft =
    drafts[activeQuestionId] ??
    (preview && previewAdapter
      ? previewAdapter.createDraft(selectedEntry.question, selectedEntry.group)
      : createEmptyDraft(selectedEntry.question));
  const confirmed = confirmations[activeQuestionId];
  const conversationId = conversationIds[activeQuestionId];
  const persistedRecord = persistence?.records?.find(
    (record) => record.questionId === activeQuestionId,
  );
  const resetAvailable = canRequestResponseLogicReset({
    preview,
    record: persistedRecord,
  });

  const selectGroup = (group: IntentQuestionGroup) => {
    const questionId = group.questions[0].id;
    setSelectedGroupId(group.id);
    setSelectedQuestionId(questionId);
    onSelectedQuestionChange?.(questionId);
    setUpdateNotice("");
  };

  const selectQuestion = (id: string) => {
    const entry = questionEntryById.get(id);
    if (!entry) return;
    setSelectedGroupId(entry.group.id);
    setSelectedQuestionId(id);
    onSelectedQuestionChange?.(id);
    setUpdateNotice("");
  };

  const patchDraft = (patch: Partial<LogicDraft>) => {
    if (confirmed) return;
    setDrafts((current) => ({
      ...current,
      [activeQuestionId]: {
        ...(current[activeQuestionId] ?? draft),
        ...patch,
      },
    }));
  };

  const persistDraft = async (
    nextDraft: LogicDraft,
    options?: {
      conversationId?: string;
      publish?: boolean;
      expectedRevision?: number;
      expectedTaskId?: string;
      expectedOperationRevision?: number;
    },
  ) => {
    if (preview) return null;
    if (!persistence) return null;
    const result = await persistence.save({
      questionId: selectedEntry.question.id,
      groupId: selectedEntry.group.id,
      groupTitle: selectedEntry.group.title,
      question: selectedEntry.question.question,
      intent: selectedEntry.question.intent,
      summary: selectedEntry.question.summary,
      expectedRevision:
        options?.expectedRevision ?? persistedRecord?.revision ?? 0,
      ...(options?.expectedTaskId
        ? { expectedTaskId: options.expectedTaskId }
        : {}),
      ...(options?.expectedOperationRevision
        ? { expectedOperationRevision: options.expectedOperationRevision }
        : {}),
      conversationId: options?.conversationId ?? conversationId,
      draft: nextDraft,
      publish: options?.publish ?? false,
    });
    return result.record;
  };

  const bindConversation = async (nextConversationId: string) => {
    if (confirmed) return;
    setConversationIds((current) => ({
      ...current,
      [activeQuestionId]: nextConversationId,
    }));
    if (preview) return;
    try {
      await persistDraft(draft, { conversationId: nextConversationId });
    } catch (error) {
      toast.error("应答会话保存失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const loadModelReply = async (
    reply: string,
    message?: LocalMessage,
    taskId?: string,
    operationRevision?: number,
    onTaskUnavailable?: () => void,
    suppliedStructuredDraft?: ResponseLogicStructuredDraft,
  ) => {
    if (confirmed) return "ignored" as const;
    let parsed: Pick<LogicDraft, LogicTextField>;
    try {
      if (preview) {
        parsed = parseResponseLogicReply(reply);
      } else {
        if (!taskId || !operationRevision || !conversationId) {
          throw new Error("缺少当前问题的会话或任务标识，请重新打开该问题");
        }
        const structuredDraft =
          suppliedStructuredDraft ??
          (await fetchResponseLogicStructuredDraft({
            questionId: activeQuestionId,
            conversationId,
            taskId,
            operationRevision,
          }));
        parsed = { ...structuredDraft, pending: "", references: "" };
      }
    } catch (error) {
      if (
        error instanceof ResponseLogicTaskStatusError &&
        [
          "RESPONSE_LOGIC_TASK_UNAVAILABLE",
          "RESPONSE_LOGIC_TASK_FAILED",
        ].includes(error.code)
      ) {
        onTaskUnavailable?.();
      }
      toast.error("模型输出未载入", {
        description:
          error instanceof Error
            ? error.message
            : "模型输出未通过四栏目校验，请重新生成",
      });
      return "ignored" as const;
    }
    const imageCandidates: LogicImage[] = [
      ...(message?.inlineImages || []).map((image, index) => ({
        id: `${message?.id || "model-output"}-inline-${index}`,
        name: image.alt || `应答配图 ${index + 1}`,
        url: image.src,
        caption: image.alt || `应答配图 ${index + 1}`,
        source: "智能体任务输出",
        section: "图文依据",
        authorization: "本次应答可用" as const,
      })),
      ...(message?.outputFiles || [])
        .filter((file) => file.mimeType.startsWith("image/"))
        .map((file, index) => ({
          id: `${message?.id || "model-output"}-file-${index}`,
          name: file.fileName,
          url: file.fileUrl,
          caption: file.fileName,
          source: "智能体任务输出",
          section: "图文依据",
          authorization: "本次应答可用" as const,
        })),
    ];
    const draftWithResult: LogicDraft = {
      ...draft,
      ...parsed,
      images:
        imageCandidates.length > 0
          ? [
              ...draft.images,
              ...imageCandidates.filter(
                (candidate) =>
                  !draft.images.some((image) => image.url === candidate.url),
              ),
            ]
          : draft.images,
    };
    if (preview) {
      setDrafts((current) => ({
        ...current,
        [activeQuestionId]: draftWithResult,
      }));
      return "saved" as const;
    }

    let nextDraft = draftWithResult;
    let authoritativeRevision = persistedRecord?.revision ?? 0;
    if (persistence) {
      try {
        const records = await persistence.refresh();
        const authoritativeRecord = records.find(
          (record) => record.questionId === activeQuestionId,
        );
        if (
          !taskId ||
          !operationRevision ||
          !authoritativeRecord ||
          authoritativeRecord.lastTaskId !== taskId ||
          authoritativeRecord.revision !== operationRevision
        ) {
          throw new Error(
            "当前模型输出与服务端记录的最新任务不一致，请重新打开问题",
          );
        }
        authoritativeRevision = operationRevision;
        nextDraft = mergeResponseLogicAttachmentsIntoDraft(
          draftWithResult,
          authoritativeRecord?.draft.attachments ?? [],
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("最新任务不一致")
        ) {
          toast.error("模型输出未载入", { description: error.message });
          return "ignored" as const;
        }
        // The dedicated status endpoint already authenticated this exact
        // question/conversation/task tuple. Keep its validated four fields
        // visible even if the follow-up CAS refresh is temporarily offline.
        setDrafts((current) => ({
          ...current,
          [activeQuestionId]: draftWithResult,
        }));
        toast.error("结果已显示但尚未保存", {
          description:
            error instanceof Error ? error.message : "连接恢复后请重试保存",
        });
        return "displayed_unsaved" as const;
      }
    }

    try {
      await persistDraft(nextDraft, {
        expectedRevision: authoritativeRevision,
        expectedTaskId: taskId,
        expectedOperationRevision: operationRevision,
      });
      setDrafts((current) => ({
        ...current,
        [activeQuestionId]: nextDraft,
      }));
      toast.success("模型输出已载入应答草稿");
      return "saved" as const;
    } catch (error) {
      if (persistence && taskId && operationRevision) {
        try {
          const records = await persistence.refresh();
          if (
            !authoritativeResponseLogicTaskMatches({
              records,
              questionId: activeQuestionId,
              taskId,
              operationRevision,
            })
          ) {
            toast.error("模型输出未载入", {
              description: "当前任务已被重置或替换，请载入最新任务。",
            });
            persistence.retry();
            return "ignored" as const;
          }
        } catch {
          // The validated result remains useful while persistence is offline.
          // The atomic expectedTaskId guard still prevents server resurrection.
        }
      }
      setDrafts((current) => ({
        ...current,
        [activeQuestionId]: nextDraft,
      }));
      toast.error("结果已显示但尚未保存", {
        description: error instanceof Error ? error.message : "请稍后重试保存",
      });
      return "displayed_unsaved" as const;
    }
  };

  const addImages = (event: ChangeEvent<HTMLInputElement>) => {
    if (confirmed) return;
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    const images: LogicImage[] = files.map((file, index) => {
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      return {
        id: `${Date.now()}-${index}-${file.name}`,
        name: file.name,
        url,
        caption: file.name.replace(/\.[^.]+$/, ""),
        source: "本次企业交流上传",
        section: "图文依据",
        authorization: "本次应答可用",
      };
    });
    patchDraft({ images: [...draft.images, ...images] });
    event.target.value = "";
  };

  const removeImage = (id: string) => {
    if (confirmed) return;
    patchDraft({ images: draft.images.filter((image) => image.id !== id) });
  };

  const updateConfirmation = async () => {
    if (isPublishing || confirmed) return;
    setIsPublishing(true);
    try {
      let nextConfirmed: ConfirmedLogic;
      if (preview) {
        nextConfirmed = {
          ...draft,
          images: draft.images.map((image) => ({ ...image })),
          version: 1,
          updatedAt: new Date().toISOString(),
        };
      } else {
        const record = await persistDraft(draft, { publish: true });
        if (!record?.confirmed) {
          throw new Error("服务端没有返回确认版本");
        }
        nextConfirmed = record.confirmed;
      }
      setConfirmations((current) => ({
        ...current,
        [activeQuestionId]: nextConfirmed,
      }));
      setUpdateNotice(
        `“${selectedEntry.question.question}”的应答逻辑已确认，可在问题优化中查看。`,
      );
      setConfirmDialogOpen(false);
      onPublished?.(activeQuestionId);
    } catch (error) {
      toast.error("应答逻辑更新失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <section
      className={`response-logic-workspace page-shell ${workspaceExpanded ? "rl-workspace-expanded" : ""}`}
    >
      <header className="rl-page-header rl-page-header-with-action">
        <div>
          <span className="rl-eyebrow">MindPromise 智诺 · 应答逻辑智能体</span>
          <h2>应答逻辑智能体</h2>
          <p>
            围绕每个核心问题沉淀可核验的回答口径、证据来源、表达边界与配图材料；完成更新后返回问题优化查看正式版本。
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rl-page-header-action"
            onClick={() => setRequestHistoryOpen(true)}
          >
            <FileClock className="h-4 w-4" aria-hidden="true" />
            需求记录
          </Button>
          <QuestionMaintenanceRequestDialog
            mode="response_logic"
            questions={
              resetAvailable
                ? [
                    {
                      id: selectedEntry.question.id,
                      question: selectedEntry.question.question,
                    },
                  ]
                : []
            }
            selectedQuestionId={resetAvailable ? activeQuestionId : null}
            triggerLabel="申请重置应答逻辑"
            disabled={!resetAvailable}
          />
        </div>
      </header>

      <CustomerRequestHistoryDialog
        open={requestHistoryOpen}
        onOpenChange={setRequestHistoryOpen}
        title="应答逻辑需求记录"
        description="显示草稿、启动失败、处理中或已确认应答逻辑的重置申请。"
        type="knowledge_base"
        surface="response_logic_management"
        preview={preview}
        {...(preview ? { tickets: [] } : {})}
        emptyText="暂无应答逻辑修改需求。"
      />

      {updateNotice && (
        <div className="rl-update-notice" role="status">
          <Check size={16} />
          {updateNotice}
        </div>
      )}

      <div className="rl-layout">
        <QuestionNavigator
          groups={groups}
          confirmedQuestionIds={new Set(Object.keys(confirmations))}
          selectedGroupId={selectedGroupId}
          selectedQuestionId={activeQuestionId}
          onSelectGroup={selectGroup}
          onSelectQuestion={selectQuestion}
        />

        <div className="rl-agent-area">
          <QuestionContext
            group={selectedEntry.group}
            question={selectedEntry.question}
          />
          <div className="rl-work-columns">
            <DialoguePanel
              preview={preview}
              PreviewDialogueComponent={previewAdapter?.Dialogue}
              group={selectedEntry.group}
              question={selectedEntry.question}
              draft={draft}
              conversationId={conversationId}
              recordsLoading={!preview && Boolean(persistence?.loading)}
              recordsReady={preview || Boolean(persistence?.ready)}
              recordsError={persistence?.error}
              onRetryRecords={() => persistence?.retry()}
              lastTaskId={persistedRecord?.lastTaskId}
              lastTaskRevision={persistedRecord?.revision}
              lastTaskRecordedAt={persistedRecord?.updatedAt}
              readOnly={Boolean(confirmed)}
              expanded={workspaceExpanded}
              onToggleExpanded={() =>
                setWorkspaceExpanded((expanded) => !expanded)
              }
              onConversationIdChange={bindConversation}
              onLoadLatestReply={loadModelReply}
            />
            <LogicEditor
              draft={draft}
              readOnly={Boolean(confirmed)}
              allowLocalImageUpload={preview}
              isPublishing={isPublishing}
              onPatch={patchDraft}
              onAddImages={addImages}
              onRemoveImage={removeImage}
              onUpdate={() => setConfirmDialogOpen(true)}
            />
          </div>
        </div>
      </div>
      <AlertDialog
        open={confirmDialogOpen}
        onOpenChange={(open) => {
          if (!isPublishing) setConfirmDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认当前应答逻辑？</AlertDialogTitle>
            <AlertDialogDescription>
              确认后将作为“{selectedEntry.question.question}
              ”的正式应答逻辑，不能直接修改；如需调整，请提交应答逻辑修改需求。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPublishing}>
              继续检查
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isPublishing}
              onClick={(event) => {
                event.preventDefault();
                void updateConfirmation();
              }}
            >
              {isPublishing && <Loader2 className="h-4 w-4 animate-spin" />}
              确认并锁定
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function QuestionNavigator({
  groups,
  confirmedQuestionIds,
  selectedGroupId,
  selectedQuestionId,
  onSelectGroup,
  onSelectQuestion,
  navTitle = "待优化问题",
}: {
  groups: IntentQuestionGroup[];
  confirmedQuestionIds: Set<string>;
  selectedGroupId: string;
  selectedQuestionId: string;
  onSelectGroup: (group: IntentQuestionGroup) => void;
  onSelectQuestion: (id: string) => void;
  navTitle?: string;
}) {
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const selectedTone = semanticGroupTone(selectedGroup);
  const selectedCategory = semanticGroupCategory(selectedGroup);

  return (
    <aside
      className="rl-question-nav"
      aria-label={navTitle}
      data-tone={selectedTone}
      data-category={selectedCategory || undefined}
    >
      <div className="rl-question-nav-head">
        <div>
          <strong>{navTitle}</strong>
        </div>
        <Sparkles size={18} />
      </div>

      <div className="rl-group-tabs">
        {groups.map((group) => {
          const tone = semanticGroupTone(group);
          const category = semanticGroupCategory(group);
          const Icon = groupIcon(tone);
          return (
            <button
              key={group.id}
              type="button"
              aria-label={group.title}
              data-tone={tone}
              data-category={category || undefined}
              className={group.id === selectedGroup.id ? "active" : ""}
              onClick={() => onSelectGroup(group)}
            >
              <span className="rl-group-tab-icon">
                <Icon size={15} />
              </span>
              <span>
                <strong>{group.title}</strong>
              </span>
            </button>
          );
        })}
      </div>

      <div className="rl-question-list">
        <div className="rl-question-list-title">
          <span>{selectedGroup.title}</span>
          <small>{selectedGroup.subtitle}</small>
        </div>
        {selectedGroup.questions.map((question, index) => (
          <button
            key={question.id}
            type="button"
            className={question.id === selectedQuestionId ? "active" : ""}
            onClick={() => onSelectQuestion(question.id)}
          >
            <span className="rl-question-index">
              {question.id === selectedQuestionId ? (
                <CircleDot size={14} />
              ) : confirmedQuestionIds.has(question.id) ? (
                <Check size={14} />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <span>{question.question}</span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </aside>
  );
}

function QuestionContext({
  group,
  question,
}: {
  group: IntentQuestionGroup;
  question: IntentQuestion;
}) {
  const tone = semanticGroupTone(group);
  const category = semanticGroupCategory(group);
  const Icon = groupIcon(tone);
  return (
    <section
      className="rl-question-context"
      data-tone={tone}
      data-category={category || undefined}
    >
      <span className="rl-context-icon">
        <Icon size={20} />
      </span>
      <div>
        <span>{group.title} · 当前问题</span>
        <h3>{question.question}</h3>
        <p>{question.summary}</p>
      </div>
    </section>
  );
}

function DialoguePanel({
  preview,
  PreviewDialogueComponent,
  group,
  question,
  draft,
  conversationId,
  recordsLoading,
  recordsReady,
  recordsError,
  onRetryRecords,
  lastTaskId,
  lastTaskRevision,
  lastTaskRecordedAt,
  readOnly,
  expanded,
  onToggleExpanded,
  onConversationIdChange,
  onLoadLatestReply,
}: {
  preview: boolean;
  PreviewDialogueComponent?: ComponentType<ResponseLogicPreviewDialogueProps>;
  group: IntentQuestionGroup;
  question: IntentQuestion;
  draft: LogicDraft;
  conversationId?: string;
  recordsLoading: boolean;
  recordsReady: boolean;
  recordsError?: string;
  onRetryRecords: () => void;
  lastTaskId?: string;
  lastTaskRevision?: number;
  lastTaskRecordedAt?: number;
  readOnly: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onConversationIdChange: (conversationId: string) => Promise<void>;
  onLoadLatestReply: ResponseLogicLoadReply;
}) {
  return (
    <section className="rl-dialogue-card">
      <div className="rl-card-title">
        <div>
          <span className="rl-title-icon">
            <MessageSquareText size={17} />
          </span>
          <div>
            <h3>企业交流与资料补充</h3>
            <p>结合企业知识库与补充资料，生成可核验的应答口径。</p>
          </div>
        </div>
        <button
          type="button"
          className="rl-dialogue-expand"
          aria-label={expanded ? "退出全屏" : "进入全屏"}
          aria-pressed={expanded}
          title={expanded ? "退出全屏" : "进入全屏"}
          onClick={onToggleExpanded}
        >
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          <span>{expanded ? "退出全屏" : "进入全屏"}</span>
        </button>
      </div>
      {preview && PreviewDialogueComponent ? (
        <fieldset
          className="rl-preview-fieldset"
          disabled={readOnly}
          aria-label={readOnly ? "已确认应答逻辑对话（只读）" : undefined}
        >
          <PreviewDialogueComponent
            question={question}
            onLoadLatestReply={onLoadLatestReply}
          />
        </fieldset>
      ) : (
        <RealResponseLogicDialogue
          group={group}
          question={question}
          draft={draft}
          conversationId={conversationId}
          recordsLoading={recordsLoading}
          recordsReady={recordsReady}
          recordsError={recordsError}
          onRetryRecords={onRetryRecords}
          lastTaskId={lastTaskId}
          lastTaskRevision={lastTaskRevision}
          lastTaskRecordedAt={lastTaskRecordedAt}
          readOnly={readOnly}
          onConversationIdChange={onConversationIdChange}
          onLoadLatestReply={onLoadLatestReply}
        />
      )}
    </section>
  );
}

function RealResponseLogicDialogue({
  group,
  question,
  draft,
  conversationId,
  recordsLoading,
  recordsReady,
  recordsError,
  onRetryRecords,
  lastTaskId,
  lastTaskRevision,
  lastTaskRecordedAt,
  readOnly,
  onConversationIdChange,
  onLoadLatestReply,
}: {
  group: IntentQuestionGroup;
  question: IntentQuestion;
  draft: LogicDraft;
  conversationId?: string;
  recordsLoading: boolean;
  recordsReady: boolean;
  recordsError?: string;
  onRetryRecords: () => void;
  lastTaskId?: string;
  lastTaskRevision?: number;
  lastTaskRecordedAt?: number;
  readOnly: boolean;
  onConversationIdChange: (conversationId: string) => Promise<void>;
  onLoadLatestReply: ResponseLogicLoadReply;
}) {
  const {
    state,
    activeConversation,
    hydrated,
    createConversation,
    setActive,
    updateAssistantMessages,
    updateStatus,
    updateTitle,
  } = useConversation();
  const initializationRef = useRef<string | null>(null);
  const callbackRef = useRef(onConversationIdChange);
  callbackRef.current = onConversationIdChange;
  const unavailableTaskIdsRef = useRef(new Set<string>());
  const scopedConversation = conversationId
    ? state.conversations.find(
        (conversation) => conversation.id === conversationId,
      )
    : undefined;
  const scopedConversationRef = useRef(scopedConversation);
  scopedConversationRef.current = scopedConversation;
  const loadLatestReplyRef = useRef(onLoadLatestReply);
  loadLatestReplyRef.current = onLoadLatestReply;
  const retryRecordsRef = useRef(onRetryRecords);
  retryRecordsRef.current = onRetryRecords;
  const [activeDedicatedTask, setActiveDedicatedTask] = useState<{
    questionId: string;
    conversationId?: string;
    taskId: string;
    operationRevision: number;
    startedAt: number;
  } | null>(null);
  const scopedActiveDedicatedTask =
    activeDedicatedTask?.questionId === question.id &&
    activeDedicatedTask.conversationId === conversationId
      ? activeDedicatedTask
      : null;
  const [lastCompletedObservation, setLastCompletedObservation] =
    useState<ResponseLogicTaskStatusEnvelope | null>(null);
  const [unsavedResultId, setUnsavedResultId] = useState<string | null>(null);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [startFailure, setStartFailure] = useState<
    | (ResponseLogicTaskStartFailure & {
        questionId: string;
        conversationId: string;
        continuationTaskId?: string;
      })
    | null
  >(null);
  const startFailureRef = useRef(startFailure);
  startFailureRef.current = startFailure;
  const scopedStartFailure =
    scopedResponseLogicTaskStartFailure({
      failure: startFailure,
      questionId: question.id,
      conversationId: scopedConversation?.id,
    }) ??
    durableResponseLogicResetBarrier({
      conversation: scopedConversation,
      questionId: question.id,
    });

  useEffect(() => {
    if (!lastTaskId || !lastTaskRevision || scopedStartFailure?.resetRequired)
      return;
    setActiveDedicatedTask((current) =>
      current?.taskId === lastTaskId &&
      current.operationRevision === lastTaskRevision
        ? current
        : {
            questionId: question.id,
            conversationId,
            taskId: lastTaskId,
            operationRevision: lastTaskRevision,
            startedAt: lastTaskRecordedAt || Date.now(),
          },
    );
  }, [
    conversationId,
    lastTaskId,
    lastTaskRecordedAt,
    lastTaskRevision,
    question.id,
    scopedStartFailure?.resetRequired,
  ]);

  useEffect(() => {
    setLastCompletedObservation(null);
    setUnsavedResultId(null);
    startFailureRef.current = null;
    setStartFailure(null);
  }, [conversationId, question.id]);

  useEffect(() => {
    if (
      !hydrated ||
      recordsLoading ||
      !recordsReady ||
      recordsError ||
      scopedStartFailure?.resetRequired
    )
      return;
    if (scopedConversation) {
      initializationRef.current = null;
      const authoritativeTaskId =
        scopedActiveDedicatedTask?.taskId || lastTaskId;
      const operationRevision =
        scopedActiveDedicatedTask?.operationRevision || lastTaskRevision;
      if (
        (Boolean(operationRevision) &&
          (scopedConversation.status === "running" ||
            scopedConversation.status === "pending") &&
          scopedActiveDedicatedTask?.operationRevision !== operationRevision) ||
        shouldHydrateResponseLogicTask({
          authoritativeTaskId,
          localTaskId: scopedConversation.taskId,
          localPreviousResponseId: scopedConversation.previousResponseId,
          unavailableTaskIds: unavailableTaskIdsRef.current,
          resetRequired: scopedStartFailure?.resetRequired,
        })
      ) {
        updateStatus(scopedConversation.id, "pending", {
          taskId: authoritativeTaskId,
          previousResponseId: authoritativeTaskId,
          executionKind: "response_logic",
          startedAt:
            scopedConversation.startedAt ||
            scopedActiveDedicatedTask?.startedAt ||
            lastTaskRecordedAt ||
            Date.now(),
        });
        return;
      }
      if (activeConversation?.id !== scopedConversation.id) {
        setActive(scopedConversation.id);
      }
      return;
    }

    if (readOnly) return;

    const key = `${question.id}:${conversationId || "new"}`;
    if (initializationRef.current === key) return;
    initializationRef.current = key;
    const nextConversationId = createConversation();
    updateTitle(nextConversationId, `应答-${question.question}`);
    void callbackRef.current(nextConversationId).finally(() => {
      initializationRef.current = null;
    });
  }, [
    activeConversation?.id,
    scopedActiveDedicatedTask?.startedAt,
    scopedActiveDedicatedTask?.taskId,
    conversationId,
    createConversation,
    hydrated,
    lastTaskId,
    lastTaskRecordedAt,
    lastTaskRevision,
    question.id,
    question.question,
    readOnly,
    recordsError,
    recordsLoading,
    recordsReady,
    scopedConversation,
    scopedStartFailure?.resetRequired,
    setActive,
    updateStatus,
    updateTitle,
  ]);

  const applyCompletedObservationRef = useRef<
    (
      observation: Extract<
        ResponseLogicTaskStatusEnvelope,
        { status: "completed" }
      >,
    ) => Promise<ResponseLogicLoadResult>
  >(async () => "ignored");
  applyCompletedObservationRef.current = async (observation) => {
    const conversation = scopedConversationRef.current;
    const blockingFailure =
      scopedResponseLogicTaskStartFailure({
        failure: startFailureRef.current,
        questionId: question.id,
        conversationId: conversation?.id,
      }) ??
      durableResponseLogicResetBarrier({
        conversation,
        questionId: question.id,
      });
    const currentTaskId =
      scopedActiveDedicatedTask?.taskId || lastTaskId || conversation?.taskId;
    const currentOperationRevision =
      scopedActiveDedicatedTask?.operationRevision || lastTaskRevision;
    if (
      !conversation ||
      blockingFailure?.resetRequired ||
      observation.taskId !== currentTaskId ||
      observation.operationRevision !== currentOperationRevision
    ) {
      return "ignored";
    }

    const messageId = responseLogicResultMessageId(observation.resultId);
    const existingMessage = conversation.messages.find(
      (message) =>
        message.id === messageId || message.upstreamOutputId === messageId,
    );
    const assistantMessage: LocalMessage = existingMessage ?? {
      id: messageId,
      upstreamOutputId: messageId,
      role: "assistant",
      content: serializeResponseLogicStructuredDraft(
        observation.structuredDraft,
      ),
      timestamp: Date.now(),
      responseStartedAt:
        scopedActiveDedicatedTask?.startedAt ||
        conversation.startedAt ||
        lastTaskRecordedAt ||
        Date.now(),
      modelName: observation.model,
    };
    const outcome = await loadLatestReplyRef.current(
      assistantMessage.content,
      assistantMessage,
      observation.taskId,
      observation.operationRevision,
      () => {
        unavailableTaskIdsRef.current.add(observation.taskId);
        updateStatus(conversation.id, "error", {
          clearTaskPointer: true,
          executionKind: "response_logic",
          completedAt: Date.now(),
        });
        setActiveDedicatedTask(null);
        retryRecordsRef.current();
      },
      observation.structuredDraft,
    );
    const latestFailure =
      scopedResponseLogicTaskStartFailure({
        failure: startFailureRef.current,
        questionId: question.id,
        conversationId: conversation.id,
      }) ??
      durableResponseLogicResetBarrier({
        conversation: scopedConversationRef.current,
        questionId: question.id,
      });
    if (outcome === "ignored" || latestFailure?.resetRequired) return "ignored";

    if (!existingMessage) {
      updateAssistantMessages(conversation.id, [assistantMessage]);
    }

    setLastCompletedObservation(observation);
    setUnsavedResultId(
      outcome === "displayed_unsaved" ? observation.resultId : null,
    );
    updateStatus(conversation.id, "completed", {
      taskId: observation.taskId,
      previousResponseId: observation.taskId,
      executionKind: "response_logic",
      completedAt: Date.now(),
    });
    return outcome;
  };

  useEffect(() => {
    const conversation = scopedConversation;
    const taskId =
      scopedActiveDedicatedTask?.taskId || lastTaskId || conversation?.taskId;
    const operationRevision =
      scopedActiveDedicatedTask?.operationRevision || lastTaskRevision;
    if (
      !hydrated ||
      recordsLoading ||
      !recordsReady ||
      recordsError ||
      readOnly ||
      scopedStartFailure?.resetRequired ||
      !conversationId ||
      !conversation ||
      !taskId ||
      !operationRevision ||
      (conversation.status !== "running" && conversation.status !== "pending")
    ) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;
    let consecutiveFailures = 0;
    const startedAt =
      scopedActiveDedicatedTask?.startedAt ||
      conversation.startedAt ||
      lastTaskRecordedAt ||
      Date.now();
    const schedule = (delay: number) => {
      if (disposed) return;
      timer = setTimeout(() => void pollOnce(), delay);
    };
    const pollOnce = async () => {
      if (disposed) return;
      activeController = new AbortController();
      try {
        const observation = await fetchResponseLogicTaskStatus({
          questionId: question.id,
          conversationId,
          taskId,
          operationRevision,
          signal: activeController.signal,
        });
        if (disposed) return;
        const blockingFailure = scopedResponseLogicTaskStartFailure({
          failure: startFailureRef.current,
          questionId: question.id,
          conversationId: conversation.id,
        });
        if (blockingFailure?.resetRequired) return;
        consecutiveFailures = 0;
        if (observation.status !== "completed") {
          updateStatus(conversation.id, "running", {
            taskId,
            previousResponseId: taskId,
            executionKind: "response_logic",
            startedAt,
          });
          schedule(getResponseLogicPollDelay(Date.now() - startedAt));
          return;
        }
        await applyCompletedObservationRef.current(observation);
      } catch (error) {
        if (
          disposed ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        if (
          error instanceof ResponseLogicTaskStatusError &&
          error.options.retryable
        ) {
          consecutiveFailures += 1;
          schedule(
            getResponseLogicPollDelay(
              Date.now() - startedAt,
              consecutiveFailures,
            ),
          );
          return;
        }

        const unavailable =
          error instanceof ResponseLogicTaskStatusError &&
          ([
            "RESPONSE_LOGIC_TASK_UNAVAILABLE",
            "RESPONSE_LOGIC_TASK_FAILED",
          ].includes(error.code) ||
            isResponseLogicBindingForbiddenCode(error.code));
        if (unavailable) unavailableTaskIdsRef.current.add(taskId);
        updateStatus(conversation.id, "error", {
          ...(unavailable ? { clearTaskPointer: true } : { taskId }),
          executionKind: "response_logic",
          completedAt: Date.now(),
        });
        if (unavailable) {
          setActiveDedicatedTask(null);
          retryRecordsRef.current();
        }
        toast.error("应答逻辑任务未完成", {
          description:
            error instanceof Error ? error.message : "请稍后重试或重新生成",
        });
      }
    };

    void pollOnce();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      activeController?.abort();
    };
  }, [
    scopedActiveDedicatedTask?.startedAt,
    scopedActiveDedicatedTask?.taskId,
    scopedActiveDedicatedTask?.operationRevision,
    conversationId,
    hydrated,
    lastTaskId,
    lastTaskRecordedAt,
    lastTaskRevision,
    question.id,
    readOnly,
    recordsError,
    recordsLoading,
    recordsReady,
    scopedConversation?.id,
    scopedConversation?.status,
    scopedStartFailure?.resetRequired,
    updateStatus,
  ]);

  if (recordsError) {
    return (
      <div className="rl-home-frame rl-home-loading" role="alert">
        <AlertTriangle size={22} />
        <span>{recordsError}</span>
        <button type="button" onClick={onRetryRecords}>
          重新载入
        </button>
      </div>
    );
  }

  if (
    recordsLoading ||
    !recordsReady ||
    !hydrated ||
    (!scopedConversation
      ? !readOnly
      : activeConversation?.id !== scopedConversation.id)
  ) {
    return (
      <div className="rl-home-frame rl-home-loading">
        <Loader2 size={22} className="animate-spin" />
        <span>正在打开当前问题的专属会话…</span>
      </div>
    );
  }

  if (!scopedConversation) {
    return (
      <div className="rl-home-frame rl-home-loading rl-home-read-only">
        <ShieldCheck size={22} />
        <span>应答逻辑已确认；本设备没有保留此前对话记录。</span>
      </div>
    );
  }

  const reloadTaskId =
    scopedActiveDedicatedTask?.taskId ||
    lastTaskId ||
    scopedConversation.taskId;
  const reloadOperationRevision =
    scopedActiveDedicatedTask?.operationRevision || lastTaskRevision;
  const continuationRevision = responseLogicContinuationRevision({
    persistedRevision: lastTaskRevision,
    activeTaskRevision: scopedActiveDedicatedTask?.operationRevision,
  });

  return (
    <>
      {scopedStartFailure && (
        <div
          className="mx-4 mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          role="alert"
        >
          <strong className="block">
            {scopedStartFailure.resetRequired
              ? "任务创建结果无法确认"
              : "任务尚未创建"}
          </strong>
          <span className="mt-1 block">
            {scopedStartFailure.message}
            {scopedStartFailure.resetRequired
              ? " 请先申请重置；批准后将以全新会话和全新任务重新开始。"
              : scopedStartFailure.retryable
                ? " 当前输入和附件仍保留，可稍后直接重新发送。"
                : " 请根据提示处理后重新发送。"}
          </span>
          {scopedStartFailure.incidentId && (
            <small className="mt-1 block opacity-75">
              故障编号：{scopedStartFailure.incidentId}
            </small>
          )}
        </div>
      )}
      <button
        type="button"
        className="rl-load-reply"
        disabled={
          !reloadOperationRevision ||
          !canReloadResponseLogicTask({
            taskId: reloadTaskId,
            readOnly,
            loading: loadingOutput,
            resetRequired: scopedStartFailure?.resetRequired,
          })
        }
        onClick={async () => {
          if (
            scopedStartFailure?.resetRequired ||
            !reloadTaskId ||
            !reloadOperationRevision ||
            !conversationId
          )
            return;
          setLoadingOutput(true);
          try {
            const cached =
              lastCompletedObservation?.status === "completed" &&
              lastCompletedObservation.taskId === reloadTaskId &&
              lastCompletedObservation.operationRevision ===
                reloadOperationRevision
                ? lastCompletedObservation
                : null;
            const observation =
              cached ??
              (await fetchResponseLogicTaskStatus({
                questionId: question.id,
                conversationId,
                taskId: reloadTaskId,
                operationRevision: reloadOperationRevision,
              }));
            if (observation.status !== "completed") {
              toast.info("应答逻辑仍在生成并校验，请稍后重试");
              return;
            }
            await applyCompletedObservationRef.current(observation);
          } catch (error) {
            if (
              error instanceof ResponseLogicTaskStatusError &&
              ([
                "RESPONSE_LOGIC_TASK_UNAVAILABLE",
                "RESPONSE_LOGIC_TASK_FAILED",
              ].includes(error.code) ||
                isResponseLogicBindingForbiddenCode(error.code))
            ) {
              unavailableTaskIdsRef.current.add(reloadTaskId);
              updateStatus(scopedConversation.id, "error", {
                clearTaskPointer: true,
                executionKind: "response_logic",
                completedAt: Date.now(),
              });
              setActiveDedicatedTask(null);
              onRetryRecords();
            }
            toast.error("模型输出未载入", {
              description:
                error instanceof Error ? error.message : "请稍后重试",
            });
          } finally {
            setLoadingOutput(false);
          }
        }}
      >
        {loadingOutput ? (
          <Loader2 size={14} className="animate-spin" />
        ) : readOnly ? (
          <Check size={14} />
        ) : (
          <RefreshCw size={14} />
        )}
        {loadingOutput
          ? "正在载入"
          : readOnly
            ? "应答逻辑已确认"
            : unsavedResultId
              ? "重试保存已显示的模型输出"
              : "载入模型最新输出到应答草稿"}
      </button>
      <fieldset
        className="rl-home-frame rl-home-fieldset"
        disabled={readOnly || scopedStartFailure?.resetRequired}
        aria-label={readOnly ? "已确认应答逻辑对话（只读）" : undefined}
      >
        <Home
          key={scopedConversation.id}
          embedded
          hideSidebar
          fixedAgentProfile="frontmind-pro"
          composerPrefill={
            shouldUseResponseLogicInitialPrompt(scopedConversation, readOnly)
              ? `请基于最新企业知识库，为“${question.question}”生成可核验的应答逻辑。`
              : undefined
          }
          responseLogicContext={{
            questionId: question.id,
            groupId: group.id,
            groupTitle: group.title,
            question: question.question,
            intent: question.intent,
            summary: question.summary,
            draft,
            operationRevision: continuationRevision,
            onTaskStarted: (task) => {
              if (
                task.questionId !== question.id ||
                task.conversationId !== scopedConversation.id
              ) {
                return;
              }
              setActiveDedicatedTask({
                questionId: task.questionId,
                conversationId: task.conversationId,
                taskId: task.taskId,
                operationRevision: task.operationRevision,
                startedAt: task.startedAt,
              });
              setLastCompletedObservation(null);
              setUnsavedResultId(null);
              startFailureRef.current = null;
              setStartFailure(null);
            },
            onTaskStartFailed: (failure) => {
              if (
                failure.questionId !== question.id ||
                failure.conversationId !== scopedConversation.id
              ) {
                return;
              }
              startFailureRef.current = failure;
              setStartFailure(failure);
              if (failure.resetRequired) {
                setActiveDedicatedTask(null);
                setLastCompletedObservation(null);
                setUnsavedResultId(null);
                retryRecordsRef.current();
              }
            },
          }}
          messageProjection={projectResponseLogicConversationMessage}
        />
      </fieldset>
    </>
  );
}

function LogicEditor({
  draft,
  readOnly,
  allowLocalImageUpload,
  isPublishing,
  onPatch,
  onAddImages,
  onRemoveImage,
  onUpdate,
}: {
  draft: LogicDraft;
  readOnly: boolean;
  allowLocalImageUpload: boolean;
  isPublishing: boolean;
  onPatch: (patch: Partial<LogicDraft>) => void;
  onAddImages: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (id: string) => void;
  onUpdate: () => void;
}) {
  const sourceFiles = draft.attachments.filter(
    (attachment) =>
      attachment.kind === "file" ||
      isResponseLogicAttachmentExpired(attachment),
  );
  const uploadedImageAttachments = new Map<string, ResponseLogicAttachment>(
    draft.attachments
      .filter((attachment) => attachment.kind === "image")
      .map(
        (attachment) =>
          [`response-logic-upload-${attachment.fileId}`, attachment] as const,
      ),
  );
  return (
    <section className="rl-editor-card">
      <div className="rl-card-title">
        <div>
          <span className="rl-title-icon">
            <FileText size={17} />
          </span>
          <div>
            <h3>应答参考草稿</h3>
            <p>
              {readOnly
                ? "当前版本已经正式确认，如需修改请提交需求。"
                : "预填内容可修改；确认前不会进入问题优化正式展示。"}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="rl-primary-button rl-card-action"
          disabled={isPublishing || readOnly}
          onClick={onUpdate}
        >
          {isPublishing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : readOnly ? (
            <Check size={16} />
          ) : (
            <RefreshCw size={16} />
          )}
          {isPublishing
            ? "正在确认"
            : readOnly
              ? "应答逻辑已确认"
              : "更新应答逻辑"}
        </button>
      </div>
      <fieldset className="rl-editor-scroll" disabled={readOnly}>
        <EditorField
          index="01"
          label="用户真实关心"
          value={draft.concern}
          onChange={(concern) => onPatch({ concern })}
          rows={3}
        />
        <EditorField
          index="02"
          label="核心结论/执行口径"
          value={draft.conclusion}
          onChange={(conclusion) => onPatch({ conclusion })}
          rows={8}
        />
        <EditorField
          index="03"
          label={RESPONSE_LOGIC_FACTS_DISPLAY_HEADING}
          hint="事实依据每行一项，后续应与可追溯来源一一对应"
          value={draft.facts}
          onChange={(facts) => onPatch({ facts })}
          rows={5}
        />
        <EditorField
          index="04"
          label="回答边界/禁止表达"
          value={draft.boundaries}
          onChange={(boundaries) => onPatch({ boundaries })}
          rows={5}
        />
        <div className="rl-editor-field rl-image-field">
          <div className="rl-editor-label">
            <span>05</span>
            <div>
              <strong>图文依据</strong>
              <small>
                图片上传后直接加入当前问题，无需另行确认位置或权限。
              </small>
            </div>
          </div>
          {allowLocalImageUpload && !readOnly ? (
            <label className="rl-image-upload">
              <input
                hidden
                multiple
                type="file"
                accept="image/*"
                onChange={onAddImages}
              />
              <ImagePlus size={20} />
              <span>
                <strong>上传参考图片</strong>
                <small>支持多张图片；上传后直接加入当前应答逻辑</small>
              </span>
              <Upload size={16} />
            </label>
          ) : (
            <div className="rl-image-upload rl-image-upload-guidance">
              <ImagePlus size={20} />
              <span>
                <strong>在左侧对话中上传图片</strong>
                <small>
                  图片会随真实任务上传；模型处理完成后载入输出即可进入当前草稿。
                </small>
              </span>
            </div>
          )}
          {sourceFiles.length > 0 && (
            <div className="rl-source-files" aria-label="已核验上传资料">
              <strong>服务端已核验资料</strong>
              {sourceFiles.map((attachment) => (
                <FilePreview
                  key={attachment.fileId}
                  file={responseLogicChatAttachment(attachment)}
                  className="w-full"
                />
              ))}
            </div>
          )}
          {draft.images.length > 0 && (
            <div className="rl-image-editor-list">
              {draft.images.map((image) => {
                const uploadedAttachment = uploadedImageAttachments.get(
                  image.id,
                );
                return (
                  <div className="rl-image-editor" key={image.id}>
                    {uploadedAttachment ? (
                      <ImagePreview
                        fileId={uploadedAttachment.fileId}
                        alt={image.caption || image.name}
                        expiresAt={uploadedAttachment.expiresAt}
                        expired={uploadedAttachment.expired}
                        className="rl-owned-image-preview-editor"
                      />
                    ) : (
                      <img src={image.url} alt={image.caption || image.name} />
                    )}
                    <div className="rl-image-meta-editor">
                      <strong>{image.caption || image.name}</strong>
                      <span>已加入当前应答逻辑</span>
                    </div>
                    <button
                      type="button"
                      className="rl-delete-image"
                      aria-label={`删除 ${image.name}`}
                      onClick={() => onRemoveImage(image.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </fieldset>
      <div className="rl-editor-footer">
        <p>
          <ShieldCheck size={15} />
          {readOnly
            ? "当前确认版本不可直接修改；需求通过后可重新生成并确认。"
            : "确认只作用于当前问题，其他问题草稿保持不变。"}
        </p>
      </div>
    </section>
  );
}

function EditorField({
  index,
  label,
  hint,
  value,
  rows,
  onChange,
}: {
  index: string;
  label: string;
  hint?: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="rl-editor-field">
      <span className="rl-editor-label">
        <span>{index}</span>
        <span>
          <strong>{label}</strong>
          {hint && <small>{hint}</small>}
        </span>
      </span>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ResponseLogicConfirmationPanel({
  group,
  question,
  logic,
  showPublicationMeta = true,
  actionLabel,
  onAction,
}: {
  group: IntentQuestionGroup;
  question: IntentQuestion;
  logic: ConfirmedLogic;
  showPublicationMeta?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const tone = semanticGroupTone(group);
  const category = semanticGroupCategory(group);
  const Icon = groupIcon(tone);
  const publicLogic = normalizeResponseLogicPublicProvenance(logic);
  const sourceFiles = (publicLogic.attachments ?? []).filter(
    (attachment) =>
      attachment.kind === "file" ||
      isResponseLogicAttachmentExpired(attachment),
  );
  const uploadedImageAttachments = new Map<string, ResponseLogicAttachment>(
    (publicLogic.attachments ?? [])
      .filter((attachment) => attachment.kind === "image")
      .map(
        (attachment) =>
          [`response-logic-upload-${attachment.fileId}`, attachment] as const,
      ),
  );
  const hasSupportingAssets =
    sourceFiles.length > 0 || (publicLogic.images ?? []).length > 0;
  const versionLabel =
    publicLogic.version > 0 ? `V${publicLogic.version}.0` : "V0.1";

  return (
    <article className="rl-confirmation">
      <header
        className="rl-confirmation-head"
        data-tone={tone}
        data-category={category || undefined}
      >
        <div className="rl-confirmation-heading">
          <span className="rl-context-icon">
            <Icon size={21} />
          </span>
          <div>
            <span>
              {group.title} · {group.subtitle}
            </span>
            <h3>{question.question}</h3>
          </div>
        </div>
        {(showPublicationMeta || (actionLabel && onAction)) && (
          <div className="rl-confirmation-meta">
            {showPublicationMeta && (
              <>
                <span>已发布应答逻辑 {versionLabel}</span>
                <span>
                  发布时间：{formatConfirmedAt(publicLogic.updatedAt)}
                </span>
              </>
            )}
            {actionLabel && onAction && (
              <button
                type="button"
                className="rl-confirmation-action"
                onClick={onAction}
              >
                {actionLabel}
                <ChevronRight size={14} />
              </button>
            )}
          </div>
        )}
      </header>

      <section
        className="rl-answer-hero"
        data-tone={tone}
        data-category={category || undefined}
      >
        <div className="rl-answer-visual">
          <span>
            <Sparkles size={22} />
          </span>
          <small>应答逻辑</small>
          <strong>{group.title}</strong>
          <p>问题 · 证据 · 口径 · 边界</p>
        </div>
        <div className="rl-answer-summary">
          <span>用户真实关心</span>
          <MarkdownRenderer
            content={publicLogic.concern}
            className="rl-confirmation-markdown rl-concern-markdown"
          />
        </div>
      </section>

      <div className="rl-confirmation-grid">
        <LogicSection
          number="01"
          title="核心结论与执行口径"
          content={publicLogic.conclusion}
          wide
        />
        <LogicSection
          number="02"
          title={RESPONSE_LOGIC_FACTS_DISPLAY_HEADING}
          content={publicLogic.facts}
        />
        <LogicSection
          number="03"
          title="回答边界/禁止表达"
          content={publicLogic.boundaries}
          variant="boundary"
        />
        {hasSupportingAssets && (
          <section className="rl-logic-section rl-reference-section wide">
            <div className="rl-logic-section-title">
              <span>04</span>
              <div>
                <h4>图文依据</h4>
                <p>材料与图片都归属于当前问题，不拆分为独立图片库。</p>
              </div>
            </div>
            <div className="rl-reference-content">
              <div className="rl-reference-list">
                {sourceFiles.map((attachment) => (
                  <div key={attachment.fileId} className="rl-reference-file">
                    <Paperclip size={15} />
                    <FilePreview
                      file={{
                        ...responseLogicChatAttachment(attachment),
                        name: "用户上传资料",
                      }}
                      className="w-full"
                    />
                  </div>
                ))}
              </div>
              {(publicLogic.images ?? []).length > 0 && (
                <div className="rl-confirmed-images">
                  {(publicLogic.images ?? []).map((image) => {
                    const uploadedAttachment = uploadedImageAttachments.get(
                      image.id,
                    );
                    return (
                      <figure key={image.id}>
                        {uploadedAttachment ? (
                          <ImagePreview
                            fileId={uploadedAttachment.fileId}
                            alt="用户上传图片"
                            expiresAt={uploadedAttachment.expiresAt}
                            expired={uploadedAttachment.expired}
                            className="rl-owned-image-preview-confirmed"
                          />
                        ) : (
                          <img
                            src={image.url}
                            alt={image.caption || image.name}
                          />
                        )}
                        <figcaption>
                          <strong>
                            {uploadedAttachment
                              ? "用户上传图片"
                              : normalizeResponseLogicPublicText(
                                  image.caption || image.name,
                                ) || "应答逻辑配图"}
                          </strong>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}

function LogicSection({
  number,
  title,
  content,
  wide = false,
  variant = "default",
}: {
  number: string;
  title: string;
  content: string;
  wide?: boolean;
  variant?: "default" | "boundary";
}) {
  return (
    <section className={`rl-logic-section ${wide ? "wide" : ""} ${variant}`}>
      <div className="rl-logic-section-title">
        <span>{number}</span>
        <h4>{title}</h4>
      </div>
      {content.trim() ? (
        <MarkdownRenderer
          content={content}
          className="rl-confirmation-markdown rl-logic-markdown"
        />
      ) : (
        <p className="rl-empty-line">暂无内容</p>
      )}
    </section>
  );
}
