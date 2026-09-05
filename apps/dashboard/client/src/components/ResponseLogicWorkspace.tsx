import {
  AlertTriangle,
  BarChart3,
  BookOpenCheck,
  Check,
  CircleDot,
  ChevronRight,
  FileText,
  ImagePlus,
  Layers3,
  Loader2,
  MessageSquareText,
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
import {
  useConversation,
  type Attachment,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import type {
  ConfirmedResponseLogic,
  ResponseLogicAttachment,
  ResponseLogicDraft,
  ResponseLogicImage,
  ResponseLogicRecordDto,
  SaveResponseLogicInput,
} from "@shared/response-logic";
import {
  parseResponseLogicStructuredDraft,
  responseLogicStructuredDraftSchema,
  type ResponseLogicStructuredDraft,
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
  onLoadLatestReply: (reply: string) => void | Promise<void>;
};

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
 * Converts only a server-compatible seven-section Pro response into editable
 * fields. Invalid or partial model text is rejected instead of being copied
 * into an arbitrary draft field.
 */
export function parseResponseLogicReply(
  reply: string,
): Pick<LogicDraft, LogicTextField> {
  const { roundConfirmation: _roundConfirmation, ...draftFields } =
    parseResponseLogicStructuredDraft(reply);
  return draftFields;
}

export async function fetchResponseLogicStructuredDraft(input: {
  questionId: string;
  conversationId: string;
  taskId: string;
}): Promise<ResponseLogicStructuredDraft> {
  const query = new URLSearchParams({
    questionId: input.questionId,
    conversationId: input.conversationId,
  });
  const response = await fetch(
    `/api/response-logic/tasks/${encodeURIComponent(input.taskId)}/status?${query.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `读取应答逻辑任务失败（${response.status}）`;
    throw new Error(message);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("status" in payload) ||
    payload.status !== "completed" ||
    !("structuredDraft" in payload)
  ) {
    throw new Error("应答逻辑任务尚未完成，请稍后重试");
  }
  const parsed = responseLogicStructuredDraftSchema.safeParse(
    payload.structuredDraft,
  );
  if (!parsed.success) {
    throw new Error("服务端返回的应答逻辑草稿未通过七栏目校验");
  }
  return parsed.data;
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
      section: "事实依据",
      authorization: "待确认",
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

function textLines(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.replace(/^\s*(?:[-•]|\d+[.、])\s*/, "").trim())
    .filter(Boolean);
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
  onOpenAgent: (questionId: string) => void;
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
        recordsQuery.isError
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
          actionLabel="进入应答逻辑智能体更新"
          onAction={() => onOpenAgent(activeQuestionId)}
        />
      ) : (
        <ResponseLogicConfirmationState
          title="尚未形成已确认的应答逻辑"
          description={`“${selectedEntry.question.question}”还没有从应答逻辑智能体发布的正式内容；草稿和预填内容不会在这里展示。`}
          actionLabel="进入应答逻辑智能体"
          onAction={() => onOpenAgent(activeQuestionId)}
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
  return (
    <ResponseLogicWorkspaceContent
      {...props}
      persistence={{
        records: recordsQuery.data?.records,
        loading: recordsQuery.isLoading || recordsQuery.isFetching,
        ready: recordsQuery.isSuccess && !recordsQuery.isFetching,
        error: recordsQuery.isError
          ? recordsQuery.error.message || "应答逻辑数据载入失败"
          : undefined,
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
  const hydratedRecordsRef = useRef(false);
  const [isPublishing, setIsPublishing] = useState(false);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(() => {
    if (
      preview ||
      hydratedRecordsRef.current ||
      !persistence?.ready ||
      !persistence.records
    ) {
      return;
    }
    hydratedRecordsRef.current = true;
    const records = persistence.records;
    setDrafts(
      Object.fromEntries(
        records.map((record) => [record.questionId, record.draft]),
      ),
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
  }, [
    preview,
    persistence?.records,
    persistence?.ready,
    setConfirmations,
    setConversationIds,
    setDrafts,
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
      conversationId: options?.conversationId ?? conversationId,
      draft: nextDraft,
      publish: options?.publish ?? false,
    });
    return result.record;
  };

  const bindConversation = async (nextConversationId: string) => {
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
  ) => {
    let draftWithVerifiedAttachments = draft;
    if (!preview && persistence) {
      try {
        const records = await persistence.refresh();
        const authoritativeRecord = records.find(
          (record) => record.questionId === activeQuestionId,
        );
        if (
          taskId &&
          authoritativeRecord?.lastTaskId &&
          authoritativeRecord.lastTaskId !== taskId
        ) {
          throw new Error(
            "当前模型输出与服务端记录的最新任务不一致，请重新打开问题",
          );
        }
        draftWithVerifiedAttachments = mergeResponseLogicAttachmentsIntoDraft(
          draft,
          authoritativeRecord?.draft.attachments ?? [],
        );
      } catch (error) {
        toast.error("上传资料同步失败", {
          description:
            error instanceof Error
              ? error.message
              : "无法核对本轮上传资料，请稍后重试",
        });
        return;
      }
    }

    let parsed: Pick<LogicDraft, LogicTextField>;
    let roundConfirmation = "";
    try {
      if (preview) {
        parsed = parseResponseLogicReply(reply);
      } else {
        if (!taskId || !conversationId) {
          throw new Error("缺少当前问题的会话或任务标识，请重新打开该问题");
        }
        const structuredDraft = await fetchResponseLogicStructuredDraft({
          questionId: activeQuestionId,
          conversationId,
          taskId,
        });
        ({ roundConfirmation, ...parsed } = structuredDraft);
      }
    } catch (error) {
      toast.error("模型输出未载入", {
        description:
          error instanceof Error
            ? error.message
            : "模型输出未通过七栏目校验，请重新生成",
      });
      return;
    }
    const imageCandidates: LogicImage[] = [
      ...(message?.inlineImages || []).map((image, index) => ({
        id: `${message?.id || "model-output"}-inline-${index}`,
        name: image.alt || `应答配图 ${index + 1}`,
        url: image.src,
        caption: image.alt || `应答配图 ${index + 1}`,
        source: "智能体任务输出",
        section: "事实依据",
        authorization: "待确认" as const,
      })),
      ...(message?.outputFiles || [])
        .filter((file) => file.mimeType.startsWith("image/"))
        .map((file, index) => ({
          id: `${message?.id || "model-output"}-file-${index}`,
          name: file.fileName,
          url: file.fileUrl,
          caption: file.fileName,
          source: "智能体任务输出",
          section: "事实依据",
          authorization: "待确认" as const,
        })),
    ];
    const nextDraft: LogicDraft = {
      ...draftWithVerifiedAttachments,
      ...parsed,
      images:
        imageCandidates.length > 0
          ? [
              ...draftWithVerifiedAttachments.images,
              ...imageCandidates.filter(
                (candidate) =>
                  !draftWithVerifiedAttachments.images.some(
                    (image) => image.url === candidate.url,
                  ),
              ),
            ]
          : draftWithVerifiedAttachments.images,
    };
    setDrafts((current) => ({
      ...current,
      [activeQuestionId]: nextDraft,
    }));
    if (!preview) {
      try {
        await persistDraft(nextDraft);
        toast.success("模型输出已载入应答草稿", {
          description: roundConfirmation || undefined,
        });
      } catch (error) {
        toast.error("草稿保存失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
      }
    }
  };

  const addImages = (event: ChangeEvent<HTMLInputElement>) => {
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
        section: "事实依据",
        authorization: "待确认",
      };
    });
    patchDraft({ images: [...draft.images, ...images] });
    event.target.value = "";
  };

  const patchImage = (id: string, patch: Partial<LogicImage>) => {
    patchDraft({
      images: draft.images.map((image) =>
        image.id === id ? { ...image, ...patch } : image,
      ),
    });
  };

  const removeImage = (id: string) => {
    patchDraft({ images: draft.images.filter((image) => image.id !== id) });
  };

  const updateConfirmation = async () => {
    if (isPublishing) return;
    setIsPublishing(true);
    try {
      let nextConfirmed: ConfirmedLogic;
      if (preview) {
        nextConfirmed = {
          ...draft,
          images: draft.images.map((image) => ({ ...image })),
          version: Math.max(confirmed?.version ?? 0, 0) + 1,
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
        `“${selectedEntry.question.question}”的应答逻辑已更新，可在问题优化中查看。`,
      );
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
    <section className="response-logic-workspace page-shell">
      <header className="rl-page-header">
        <div>
          <span className="rl-eyebrow">MindPromise 智诺 · 应答逻辑智能体</span>
          <h2>应答逻辑智能体</h2>
          <p>
            围绕每个核心问题沉淀可核验的回答口径、证据来源、表达边界与配图材料；完成更新后返回问题优化查看正式版本。
          </p>
        </div>
      </header>

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
              lastTaskRecordedAt={persistedRecord?.updatedAt}
              onConversationIdChange={bindConversation}
              onLoadLatestReply={loadModelReply}
            />
            <LogicEditor
              draft={draft}
              allowLocalImageUpload={preview}
              isPublishing={isPublishing}
              onPatch={patchDraft}
              onAddImages={addImages}
              onPatchImage={patchImage}
              onRemoveImage={removeImage}
              onUpdate={() => void updateConfirmation()}
            />
          </div>
        </div>
      </div>
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

  return (
    <aside className="rl-question-nav" aria-label={navTitle}>
      <div className="rl-question-nav-head">
        <div>
          <strong>{navTitle}</strong>
        </div>
        <Sparkles size={18} />
      </div>

      <div className="rl-group-tabs">
        {groups.map((group) => {
          const Icon = groupIcon(group.tone);
          return (
            <button
              key={group.id}
              type="button"
              aria-label={group.title}
              data-tone={group.tone}
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
  const Icon = groupIcon(group.tone);
  return (
    <section className="rl-question-context" data-tone={group.tone}>
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
  lastTaskRecordedAt,
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
  lastTaskRecordedAt?: number;
  onConversationIdChange: (conversationId: string) => Promise<void>;
  onLoadLatestReply: (
    reply: string,
    message?: LocalMessage,
    taskId?: string,
  ) => Promise<void>;
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
      </div>
      {preview && PreviewDialogueComponent ? (
        <PreviewDialogueComponent
          question={question}
          onLoadLatestReply={onLoadLatestReply}
        />
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
          lastTaskRecordedAt={lastTaskRecordedAt}
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
  lastTaskRecordedAt,
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
  lastTaskRecordedAt?: number;
  onConversationIdChange: (conversationId: string) => Promise<void>;
  onLoadLatestReply: (
    reply: string,
    message?: LocalMessage,
    taskId?: string,
  ) => Promise<void>;
}) {
  const {
    state,
    activeConversation,
    hydrated,
    createConversation,
    setActive,
    updateStatus,
    updateTitle,
  } = useConversation();
  const initializationRef = useRef<string | null>(null);
  const callbackRef = useRef(onConversationIdChange);
  callbackRef.current = onConversationIdChange;
  const [loadingOutput, setLoadingOutput] = useState(false);

  const scopedConversation = conversationId
    ? state.conversations.find(
        (conversation) => conversation.id === conversationId,
      )
    : undefined;

  useEffect(() => {
    if (!hydrated || recordsLoading || !recordsReady || recordsError) return;
    if (scopedConversation) {
      initializationRef.current = null;
      if (
        lastTaskId &&
        (scopedConversation.taskId !== lastTaskId ||
          scopedConversation.previousResponseId !== lastTaskId)
      ) {
        updateStatus(scopedConversation.id, "pending", {
          taskId: lastTaskId,
          previousResponseId: lastTaskId,
          startedAt:
            scopedConversation.startedAt || lastTaskRecordedAt || Date.now(),
        });
        return;
      }
      if (activeConversation?.id !== scopedConversation.id) {
        setActive(scopedConversation.id);
      }
      return;
    }

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
    conversationId,
    createConversation,
    hydrated,
    lastTaskId,
    lastTaskRecordedAt,
    question.id,
    question.question,
    recordsError,
    recordsLoading,
    recordsReady,
    scopedConversation,
    setActive,
    updateStatus,
    updateTitle,
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
    !scopedConversation ||
    activeConversation?.id !== scopedConversation.id
  ) {
    return (
      <div className="rl-home-frame rl-home-loading">
        <Loader2 size={22} className="animate-spin" />
        <span>正在打开当前问题的专属会话…</span>
      </div>
    );
  }

  const latestAssistantMessage = [...scopedConversation.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.isStepsPlaceholder &&
        Boolean(message.content.trim()),
    );
  const taskActive =
    scopedConversation.status === "running" ||
    scopedConversation.status === "pending";

  return (
    <>
      <div className="rl-home-frame">
        <Home
          key={scopedConversation.id}
          embedded
          hideSidebar
          fixedAgentProfile="frontmind-pro"
          composerPrefill={`请基于最新企业知识库，为“${question.question}”生成可核验的应答逻辑。`}
          responseLogicContext={{
            questionId: question.id,
            groupId: group.id,
            groupTitle: group.title,
            question: question.question,
            intent: question.intent,
            summary: question.summary,
            draft,
          }}
        />
      </div>
      <button
        type="button"
        className="rl-load-reply"
        disabled={!latestAssistantMessage || taskActive || loadingOutput}
        onClick={async () => {
          if (!latestAssistantMessage) return;
          setLoadingOutput(true);
          try {
            await onLoadLatestReply(
              latestAssistantMessage.content,
              latestAssistantMessage,
              scopedConversation.taskId,
            );
          } finally {
            setLoadingOutput(false);
          }
        }}
      >
        {loadingOutput ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} />
        )}
        {loadingOutput ? "正在载入" : "载入模型最新输出到应答草稿"}
      </button>
    </>
  );
}

function LogicEditor({
  draft,
  allowLocalImageUpload,
  isPublishing,
  onPatch,
  onAddImages,
  onPatchImage,
  onRemoveImage,
  onUpdate,
}: {
  draft: LogicDraft;
  allowLocalImageUpload: boolean;
  isPublishing: boolean;
  onPatch: (patch: Partial<LogicDraft>) => void;
  onAddImages: (event: ChangeEvent<HTMLInputElement>) => void;
  onPatchImage: (id: string, patch: Partial<LogicImage>) => void;
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
            <p>预填内容可修改；未手动更新前不会进入确认页。</p>
          </div>
        </div>
      </div>
      <div className="rl-editor-scroll">
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
          label="企业材料/官方依据"
          hint="事实依据每行一项，后续应与可追溯来源一一对应"
          value={draft.facts}
          onChange={(facts) => onPatch({ facts })}
          rows={5}
        />
        <EditorField
          index="04"
          label="待补充/待确认"
          value={draft.pending}
          onChange={(pending) => onPatch({ pending })}
          rows={5}
        />
        <EditorField
          index="05"
          label="回答边界/禁止表达"
          value={draft.boundaries}
          onChange={(boundaries) => onPatch({ boundaries })}
          rows={5}
        />
        <EditorField
          index="06"
          label="引用与核验规则"
          value={draft.references}
          onChange={(references) => onPatch({ references })}
          rows={5}
        />
        <div className="rl-editor-field rl-image-field">
          <div className="rl-editor-label">
            <span>07</span>
            <div>
              <strong>图文依据</strong>
              <small>图片直接挂到当前问题，并记录图注、来源与授权状态。</small>
            </div>
          </div>
          {allowLocalImageUpload ? (
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
                <small>支持多张图片；请逐张补充使用信息</small>
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
                      <input
                        value={image.caption}
                        aria-label={`${image.name} 图注`}
                        placeholder="图注"
                        onChange={(event) =>
                          onPatchImage(image.id, {
                            caption: event.target.value,
                          })
                        }
                      />
                      <input
                        value={image.source}
                        aria-label={`${image.name} 来源`}
                        placeholder="来源材料"
                        onChange={(event) =>
                          onPatchImage(image.id, { source: event.target.value })
                        }
                      />
                      <div>
                        <input
                          value={image.section}
                          aria-label={`${image.name} 对应逻辑段落`}
                          placeholder="对应逻辑段落"
                          onChange={(event) =>
                            onPatchImage(image.id, {
                              section: event.target.value,
                            })
                          }
                        />
                        <select
                          value={image.authorization}
                          aria-label={`${image.name} 授权状态`}
                          onChange={(event) =>
                            onPatchImage(image.id, {
                              authorization: event.target
                                .value as LogicImage["authorization"],
                            })
                          }
                        >
                          <option>待确认</option>
                          <option>公开可用</option>
                          <option>已获授权</option>
                          <option>仅内部参考</option>
                        </select>
                      </div>
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
      </div>
      <div className="rl-editor-footer">
        <p>
          <ShieldCheck size={15} />
          更新只作用于当前问题，其他问题草稿保持不变。
        </p>
        <button
          type="button"
          className="rl-primary-button"
          disabled={isPublishing}
          onClick={onUpdate}
        >
          {isPublishing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
          {isPublishing ? "正在更新" : "更新应答逻辑"}
        </button>
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
  const Icon = groupIcon(group.tone);
  const conclusionLines = textLines(logic.conclusion);
  const facts = textLines(logic.facts);
  const pending = textLines(logic.pending);
  const boundaries = textLines(logic.boundaries);
  const references = textLines(logic.references);
  const sourceFiles = (logic.attachments ?? []).filter(
    (attachment) =>
      attachment.kind === "file" ||
      isResponseLogicAttachmentExpired(attachment),
  );
  const uploadedImageAttachments = new Map<string, ResponseLogicAttachment>(
    (logic.attachments ?? [])
      .filter((attachment) => attachment.kind === "image")
      .map(
        (attachment) =>
          [`response-logic-upload-${attachment.fileId}`, attachment] as const,
      ),
  );
  const versionLabel = logic.version > 0 ? `V${logic.version}.0` : "V0.1";

  return (
    <article className="rl-confirmation">
      <header className="rl-confirmation-head" data-tone={group.tone}>
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
                <span>发布时间：{formatConfirmedAt(logic.updatedAt)}</span>
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

      <section className="rl-answer-hero" data-tone={group.tone}>
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
          <p>{logic.concern}</p>
          <blockquote>
            {conclusionLines[0] || "请在上方草稿中补充核心结论。"}
          </blockquote>
        </div>
      </section>

      <div className="rl-confirmation-grid">
        <LogicSection
          number="01"
          title="核心结论与执行口径"
          items={conclusionLines.slice(1)}
          wide
        />
        <LogicSection number="02" title="事实依据" items={facts} />
        <LogicSection
          number="03"
          title="待补充/待确认"
          items={pending}
          variant="pending"
        />
        <LogicSection
          number="04"
          title="回答边界/禁止表达"
          items={boundaries}
          variant="boundary"
        />
        <section className="rl-logic-section rl-reference-section wide">
          <div className="rl-logic-section-title">
            <span>05</span>
            <div>
              <h4>引用与核验规则及图文依据</h4>
              <p>材料与图片都归属于当前问题，不拆分为独立图片库。</p>
            </div>
          </div>
          <div className="rl-reference-content">
            <ul>
              {references.map((item) => (
                <li key={item}>
                  <FileText size={15} />
                  <span>{item}</span>
                </li>
              ))}
              {sourceFiles.map((attachment) => (
                <li key={attachment.fileId}>
                  <Paperclip size={15} />
                  <FilePreview
                    file={responseLogicChatAttachment(attachment)}
                    className="w-full"
                  />
                </li>
              ))}
            </ul>
            <div className="rl-confirmed-images">
              {(logic.images ?? []).length > 0 ? (
                (logic.images ?? []).map((image) => {
                  const uploadedAttachment = uploadedImageAttachments.get(
                    image.id,
                  );
                  return (
                    <figure key={image.id}>
                      {uploadedAttachment ? (
                        <ImagePreview
                          fileId={uploadedAttachment.fileId}
                          alt={image.caption || image.name}
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
                        <strong>{image.caption || image.name}</strong>
                        <span>来源：{image.source || "待补充"}</span>
                        <span>对应段落：{image.section || "待补充"}</span>
                        <span>使用权限：{image.authorization}</span>
                      </figcaption>
                    </figure>
                  );
                })
              ) : (
                <div className="rl-empty-image">
                  <ImagePlus size={23} />
                  <div>
                    <strong>当前问题尚未添加参考图片</strong>
                    <p>
                      建议补充流程图、证据截图或授权场景图，并标注图注、来源、对应逻辑段落与公开权限。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </article>
  );
}

function LogicSection({
  number,
  title,
  items,
  wide = false,
  variant = "default",
}: {
  number: string;
  title: string;
  items: string[];
  wide?: boolean;
  variant?: "default" | "pending" | "boundary";
}) {
  return (
    <section className={`rl-logic-section ${wide ? "wide" : ""} ${variant}`}>
      <div className="rl-logic-section-title">
        <span>{number}</span>
        <h4>{title}</h4>
      </div>
      <ul>
        {items.length > 0 ? (
          items.map((item) => (
            <li key={item}>
              {variant === "boundary" ? (
                <ShieldCheck size={16} />
              ) : variant === "pending" ? (
                <RefreshCw size={16} />
              ) : (
                <Check size={16} />
              )}
              <span>{item}</span>
            </li>
          ))
        ) : (
          <li className="rl-empty-line">待企业交流补充</li>
        )}
      </ul>
    </section>
  );
}
