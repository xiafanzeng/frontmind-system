/**
 * ChatInput Component - Message input with file upload and model selector
 * Design: Floating glass card input area with drag-and-drop support.
 * Features: Text input, file picker, drag & drop, upload progress,
 *           per-message model selection (FrontMind-Lite/Base/Pro).
 */
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSendMessage } from "@/hooks/useSendMessage";
import {
  currentKnowledgeBaseReplySnapshot,
  useConversation,
} from "@/contexts/ConversationContext";
import {
  MODEL_OPTIONS,
  getConfig,
  saveConfig,
  type ResponseLogicTaskContext,
} from "@/lib/frontmind-api";
import { Progress } from "@/components/ui/progress";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Paperclip,
  X,
  FileText,
  Loader2,
  Upload,
  ChevronDown,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import { consumePendingFrontMindBuildDraft } from "@/lib/build-version";
import { useComposition } from "@/hooks/useComposition";
import { chatAttachmentSizeError } from "@/lib/attachment-files";
import { KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE } from "@/lib/knowledge-progress";
import KnowledgeBaseManagedUploadRecovery from "./KnowledgeBaseManagedUploadRecovery";

interface FilePreview {
  file: File;
  id: string;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LogoFileThumbnail({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return src ? (
    <img
      src={src}
      alt="待提交 Logo 预览"
      className="h-12 w-12 flex-shrink-0 rounded-lg bg-white object-contain"
    />
  ) : (
    <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
  );
}

const AMBIGUOUS_ADVANCE_PATTERN =
  /^(继续|下一步|下一个|继续吧|请继续|next)[。！!]*$/i;
const OFFICIAL_LOGO_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const OFFICIAL_LOGO_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/iu;

function isSupportedOfficialLogoFile(file: File) {
  const mimeType = file.type.trim().toLowerCase();
  return (
    OFFICIAL_LOGO_MIME_TYPES.has(mimeType) ||
    (!mimeType && OFFICIAL_LOGO_EXTENSION.test(file.name))
  );
}

const AGENT_COMPOSER_MAX_ROWS = 8;
const AGENT_COMPOSER_FALLBACK_LINE_HEIGHT_PX = 24;
const AGENT_COMPOSER_FALLBACK_PADDING_PX = 8;
const AGENT_COMPOSER_FALLBACK_MIN_HEIGHT_PX = 44;

function cssPixels(value: string, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resizeAgentComposer(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";

  const styles = window.getComputedStyle(textarea);
  const lineHeight = cssPixels(
    styles.lineHeight,
    AGENT_COMPOSER_FALLBACK_LINE_HEIGHT_PX,
  );
  const paddingHeight =
    cssPixels(styles.paddingTop, AGENT_COMPOSER_FALLBACK_PADDING_PX) +
    cssPixels(styles.paddingBottom, AGENT_COMPOSER_FALLBACK_PADDING_PX);
  const borderHeight =
    cssPixels(styles.borderTopWidth) + cssPixels(styles.borderBottomWidth);
  const minHeight = cssPixels(
    styles.minHeight,
    AGENT_COMPOSER_FALLBACK_MIN_HEIGHT_PX,
  );
  const maxHeight =
    AGENT_COMPOSER_MAX_ROWS * lineHeight + paddingHeight + borderHeight;
  const contentHeight = textarea.scrollHeight + borderHeight;
  const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));

  textarea.style.maxHeight = `${maxHeight}px`;
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

export default function ChatInput({
  fixedAgentProfile,
  syncKnowledgeBaseSnapshot = false,
  composerPrefill,
  responseLogicContext,
  knowledgeBaseProgress,
  knowledgeBaseResetRevision,
}: {
  fixedAgentProfile?: string;
  syncKnowledgeBaseSnapshot?: boolean;
  composerPrefill?: string;
  responseLogicContext?: ResponseLogicTaskContext;
  knowledgeBaseProgress?: KnowledgeBaseProgressDto | null;
  knowledgeBaseResetRevision?: number;
}) {
  const responseLogicInitialPromptLocked = Boolean(
    responseLogicContext && composerPrefill,
  );
  const [text, setText] = useState(
    () => composerPrefill || consumePendingFrontMindBuildDraft(),
  );
  const [files, setFiles] = useState<FilePreview[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [replacingOfficialLogo, setReplacingOfficialLogo] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  // Synchronous lock ref to prevent duplicate sends (React state updates are async)
  const sendLockRef = useRef(false);
  const appliedComposerPrefillRef = useRef<string | null>(
    composerPrefill || null,
  );

  // Per-message model selection - default from config
  const [selectedModel, setSelectedModel] = useState(() => {
    if (fixedAgentProfile) return fixedAgentProfile;
    const config = getConfig();
    return config.agentProfile || "frontmind-pro";
  });

  useEffect(() => {
    if (fixedAgentProfile) setSelectedModel(fixedAgentProfile);
  }, [fixedAgentProfile]);

  useEffect(() => {
    if (
      !composerPrefill ||
      appliedComposerPrefillRef.current === composerPrefill
    ) {
      return;
    }
    if (responseLogicContext || !text.trim()) {
      appliedComposerPrefillRef.current = composerPrefill;
      setText(composerPrefill);
      if (responseLogicContext) setFiles([]);
    }
  }, [composerPrefill, responseLogicContext, text]);

  const resizeComposer = useCallback(() => {
    if (textareaRef.current) resizeAgentComposer(textareaRef.current);
  }, []);

  useLayoutEffect(() => {
    resizeComposer();
  }, [resizeComposer, text]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    window.addEventListener("resize", resizeComposer);

    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", resizeComposer);
    }

    let observedWidth = textarea.getBoundingClientRect().width;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? observedWidth;
      if (nextWidth === observedWidth) return;
      observedWidth = nextWidth;
      resizeComposer();
    });
    resizeObserver.observe(textarea);

    return () => {
      window.removeEventListener("resize", resizeComposer);
      resizeObserver.disconnect();
    };
  }, [resizeComposer]);

  const {
    sendMessage,
    uploadProgress: rawUploadProgress,
    knowledgeBaseAttachmentAttempt,
    continueKnowledgeBaseAttachmentAttempt,
    discardKnowledgeBaseAttachmentAttempt,
  } = useSendMessage();
  const {
    activeConversation,
    commitKnowledgeBaseObservation,
    wakeKnowledgeBaseConversation,
    rollbackPendingKnowledgeBaseTurn,
  } = useConversation();
  const frozenConversationModel = [...(activeConversation?.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.modelName &&
        MODEL_OPTIONS.some((option) => option.value === message.modelName),
    )?.modelName;
  const modelSelectionLocked =
    !fixedAgentProfile && Boolean(activeConversation?.previousResponseId);

  useEffect(() => {
    if (fixedAgentProfile) return;
    if (frozenConversationModel) {
      setSelectedModel(frozenConversationModel);
      return;
    }
    if (!activeConversation?.previousResponseId) {
      setSelectedModel(getConfig().agentProfile || "frontmind-pro");
    }
  }, [
    activeConversation?.id,
    activeConversation?.previousResponseId,
    fixedAgentProfile,
    frozenConversationModel,
  ]);

  // Only show upload progress if it belongs to the current active conversation
  const uploadProgress =
    rawUploadProgress &&
    rawUploadProgress.conversationId === activeConversation?.id
      ? rawUploadProgress
      : null;

  const isRunning =
    activeConversation?.status === "running" ||
    activeConversation?.status === "pending";
  const candidateKnowledgeBaseAttachmentAttempt =
    knowledgeBaseAttachmentAttempt;
  const matchingKnowledgeBaseAttachmentAttempt = (() => {
    const candidate = candidateKnowledgeBaseAttachmentAttempt;
    if (!syncKnowledgeBaseSnapshot || !candidate) return null;
    if (candidate.conversationId !== activeConversation?.id) return null;
    if (
      candidate.generation !== activeConversation?.knowledgeBase?.generation
    ) {
      return null;
    }
    const activeClientRequestId =
      activeConversation?.knowledgeBase?.activeClientRequestId;
    if (
      activeClientRequestId &&
      candidate.clientRequestId !== activeClientRequestId
    ) {
      return null;
    }
    const activeTurnId = activeConversation?.knowledgeBase?.activeTurnId;
    if (activeTurnId && candidate.turnId && candidate.turnId !== activeTurnId) {
      return null;
    }
    const activeResetRevision =
      activeConversation?.knowledgeBase?.activeTurnResetRevision;
    if (
      activeResetRevision !== undefined &&
      candidate.resetRevision !== activeResetRevision
    ) {
      return null;
    }
    return candidate;
  })();
  const knowledgeBaseAttachmentResumeRequired =
    matchingKnowledgeBaseAttachmentAttempt?.phase === "failed_retryable";
  const knowledgeBaseAttachmentReconciliationPending =
    matchingKnowledgeBaseAttachmentAttempt?.phase === "reconciling_dispatch";
  const knowledgeBaseAttachmentAttemptActive = Boolean(
    matchingKnowledgeBaseAttachmentAttempt &&
      matchingKnowledgeBaseAttachmentAttempt.phase !== "accepted",
  );
  const knowledgeBaseDeferredUploadRecoveryRequired = Boolean(
    syncKnowledgeBaseSnapshot &&
      activeConversation?.knowledgeBase?.activeTurnOperationType === "revise" &&
      activeConversation?.knowledgeBase?.activeTurnAwaitingClientAttachments ===
        true &&
      activeConversation?.knowledgeBase?.activeTurnId &&
      activeConversation?.knowledgeBase?.activeClientRequestId &&
      Number.isSafeInteger(
        activeConversation?.knowledgeBase?.activeTurnResetRevision,
      ) &&
      !matchingKnowledgeBaseAttachmentAttempt,
  );
  const knowledgeBaseLogoProvenanceRepairRequired =
    syncKnowledgeBaseSnapshot &&
    activeConversation?.knowledgeBase?.notice?.code ===
      KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE;
  // A Provider task id is an upstream transport pointer, not the Dashboard
  // knowledge-base lifecycle. Local settlement deliberately clears that
  // pointer before the next explicit customer reply, while the approved
  // Dashboard presentation remains fully replyable.
  const knowledgeBaseInitialized =
    syncKnowledgeBaseSnapshot &&
    Boolean(
      activeConversation?.knowledgeBase?.initialized || knowledgeBaseProgress,
    );
  const knowledgeBaseNotStarted =
    syncKnowledgeBaseSnapshot && !knowledgeBaseInitialized;
  const knowledgeInteractionLocked =
    syncKnowledgeBaseSnapshot &&
    knowledgeBaseInitialized &&
    activeConversation?.knowledgeBase?.canReply !== true;
  const inputLocked =
    knowledgeBaseLogoProvenanceRepairRequired ||
    knowledgeBaseAttachmentAttemptActive ||
    knowledgeBaseDeferredUploadRecoveryRequired ||
    isRunning ||
    knowledgeInteractionLocked;
  const currentKnowledgeLeaf = knowledgeBaseProgress?.branches
    .flatMap((branch) => branch.leaves)
    .find((leaf) => leaf.id === knowledgeBaseProgress.build.currentLeafId);
  const knowledgeBaseReplySnapshot =
    currentKnowledgeBaseReplySnapshot(activeConversation);
  const currentNodePresentationReady = Boolean(knowledgeBaseReplySnapshot);
  const knowledgeBaseComplete =
    syncKnowledgeBaseSnapshot &&
    Boolean(knowledgeBaseProgress?.packageAllowed) &&
    !currentKnowledgeLeaf;
  const officialLogoRequiredByBuild =
    syncKnowledgeBaseSnapshot &&
    knowledgeBaseProgress?.build.logoRequired === true;
  const officialLogoAvailable =
    syncKnowledgeBaseSnapshot &&
    knowledgeBaseProgress?.build.logoAvailable === true;
  const optionalOfficialLogoChoice = Boolean(
    syncKnowledgeBaseSnapshot &&
      knowledgeBaseProgress?.build.executionMode === "materialized_bundle_v1" &&
      currentKnowledgeLeaf &&
      knowledgeBaseProgress.summary.handled === 0 &&
      !officialLogoAvailable &&
      !officialLogoRequiredByBuild,
  );
  const officialLogoRequired =
    officialLogoRequiredByBuild || replacingOfficialLogo;

  useEffect(() => {
    if (!officialLogoRequired) return;
    // The Logo gate accepts one dedicated image only. Do not carry a stale
    // composer draft or pre-gate attachments into this special turn.
    setText("");
    setFiles([]);
  }, [officialLogoRequired]);

  useEffect(() => {
    if (!matchingKnowledgeBaseAttachmentAttempt || files.length === 0) return;
    // Ownership of the browser File has moved to the page-memory attempt. The
    // composer selection can clear without losing retryable bytes.
    setFiles([]);
  }, [files.length, matchingKnowledgeBaseAttachmentAttempt]);

  const clearSelectedFiles = useCallback(() => {
    setFiles([]);
  }, []);

  // Close model menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    if (modelMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [modelMenuOpen]);

  const addFiles = useCallback(
    async (newFiles: File[]) => {
      if (responseLogicInitialPromptLocked) return;
      if (officialLogoRequired && newFiles.length !== 1) {
        toast.error("请只选择一张企业主 Logo");
        return;
      }
      if (
        officialLogoRequired &&
        newFiles[0] &&
        !isSupportedOfficialLogoFile(newFiles[0])
      ) {
        toast.error("Logo 图片格式不支持", {
          description: "请上传 PNG、JPEG、WebP、AVIF 或 GIF 原图。",
        });
        return;
      }
      const previews: FilePreview[] = [];
      for (const file of newFiles) {
        const sizeError = chatAttachmentSizeError(file);
        if (sizeError) {
          toast.error("文件过大", { description: sizeError });
          continue;
        }
        const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        previews.push({ file, id });
      }
      if (previews.length > 0) {
        setFiles((prev) =>
          officialLogoRequired ? previews.slice(0, 1) : [...prev, ...previews],
        );
      }
    },
    [officialLogoRequired, responseLogicInitialPromptLocked],
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const submitContent = useCallback(
    async (message: string, selectedFiles: FilePreview[]) => {
      if (
        (!message.trim() && selectedFiles.length === 0) ||
        isSending ||
        inputLocked ||
        knowledgeBaseNotStarted
      ) {
        return;
      }
      if (
        syncKnowledgeBaseSnapshot &&
        !knowledgeBaseAttachmentResumeRequired &&
        !knowledgeBaseReplySnapshot
      ) {
        toast.info("当前节点仍在同步", {
          description: "请等待已展示内容完成确认后再提交。",
        });
        return;
      }
      if (
        responseLogicInitialPromptLocked &&
        (selectedFiles.length > 0 || message !== composerPrefill)
      ) {
        return;
      }
      if (officialLogoRequired) {
        if (selectedFiles.length !== 1) {
          toast.error("请先上传一张企业官方主 Logo", {
            description: officialLogoRequiredByBuild
              ? "上传并校验成功后，才可以确认第一个知识节点。"
              : "Logo 为可选项；如暂不上传，可返回并直接确认当前内容。",
          });
          return;
        }
        if (!isSupportedOfficialLogoFile(selectedFiles[0]!.file)) {
          toast.error("Logo 图片格式不支持", {
            description: "请上传 PNG、JPEG、WebP、AVIF 或 GIF 原图。",
          });
          return;
        }
      }
      if (
        syncKnowledgeBaseSnapshot &&
        selectedFiles.length === 0 &&
        AMBIGUOUS_ADVANCE_PATTERN.test(message.trim())
      ) {
        toast.info("“继续/下一步”不会推进知识节点", {
          description:
            "请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
        });
        return;
      }

      // Synchronous lock: immediately block subsequent calls before async state updates.
      if (sendLockRef.current) return;
      sendLockRef.current = true;

      setIsSending(true);
      try {
        const sent = await sendMessage(
          message,
          selectedFiles.map((file) => file.file),
          {
            agentProfile: fixedAgentProfile || selectedModel,
            syncKnowledgeBaseSnapshot,
            knowledgeBaseExpectedGeneration: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.generation
              : undefined,
            knowledgeBaseExpectedResetRevision: syncKnowledgeBaseSnapshot
              ? knowledgeBaseResetRevision
              : undefined,
            knowledgeBaseExpectedStateEpoch: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.stateEpoch
              : undefined,
            knowledgeBaseExpectedContentVersion: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.contentVersion
              : undefined,
            knowledgeBaseExpectedRevision: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.revision
              : undefined,
            knowledgeBaseExpectedLeafId: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.leafId
              : undefined,
            knowledgeBaseExpectedPresentationKey: syncKnowledgeBaseSnapshot
              ? knowledgeBaseReplySnapshot?.presentationKey
              : undefined,
            submissionKind: officialLogoRequired ? "logo" : undefined,
            responseLogicContext,
          },
        );
        if (sent) {
          setText("");
          clearSelectedFiles();
          setReplacingOfficialLogo(false);
          textareaRef.current?.focus();
        }
      } finally {
        setIsSending(false);
        sendLockRef.current = false;
      }
    },
    [
      clearSelectedFiles,
      fixedAgentProfile,
      inputLocked,
      isSending,
      knowledgeBaseNotStarted,
      knowledgeBaseAttachmentResumeRequired,
      knowledgeBaseReplySnapshot,
      knowledgeBaseResetRevision,
      officialLogoRequired,
      officialLogoRequiredByBuild,
      knowledgeBaseProgress,
      currentKnowledgeLeaf,
      responseLogicContext,
      responseLogicInitialPromptLocked,
      composerPrefill,
      selectedModel,
      sendMessage,
      syncKnowledgeBaseSnapshot,
    ],
  );

  const handleSubmit = useCallback(
    async () => submitContent(text, files),
    [files, submitContent, text],
  );

  const confirmCurrentContent = useCallback(async () => {
    if (text.trim() || files.length > 0) return;
    await submitContent("确认", []);
  }, [files.length, submitContent, text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const composerComposition = useComposition<HTMLTextAreaElement>({
    onKeyDown: handleKeyDown,
  });

  const isUploading = uploadProgress !== null;

  // Drag and drop handlers
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (responseLogicInitialPromptLocked) return;
      setIsDragging(true);
    },
    [responseLogicInitialPromptLocked],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (
        responseLogicInitialPromptLocked ||
        inputLocked ||
        isSending ||
        isUploading ||
        knowledgeBaseNotStarted
      ) {
        return;
      }
      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        addFiles(droppedFiles);
      }
    },
    [
      addFiles,
      inputLocked,
      isSending,
      isUploading,
      knowledgeBaseNotStarted,
      responseLogicInitialPromptLocked,
    ],
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
    },
    [],
  );

  const quickActionsDisabled =
    Boolean(text.trim()) ||
    files.length > 0 ||
    isSending ||
    inputLocked ||
    isUploading ||
    knowledgeBaseNotStarted ||
    officialLogoRequired ||
    (syncKnowledgeBaseSnapshot &&
      Boolean(currentKnowledgeLeaf) &&
      !currentNodePresentationReady);

  // Get current model display info
  const currentModelInfo =
    MODEL_OPTIONS.find((m) => m.value === selectedModel) || MODEL_OPTIONS[2];

  return (
    <div
      className="relative px-3 pb-3 pt-3 bg-gradient-to-t from-background via-background/95 to-transparent sm:px-5 sm:pb-5"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/30 rounded-2xl mx-4 mb-4"
          >
            <div className="text-center">
              <Paperclip className="w-8 h-8 text-primary/50 mx-auto mb-2" />
              <p className="text-sm text-primary/70 font-medium">
                拖放文件到此处
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="max-w-4xl mx-auto">
        {syncKnowledgeBaseSnapshot &&
          !knowledgeBaseLogoProvenanceRepairRequired &&
          (currentKnowledgeLeaf || knowledgeBaseComplete) && (
            <div
              className={cn(
                "mb-3 rounded-2xl border px-4 py-3 shadow-sm",
                knowledgeBaseComplete
                  ? "border-emerald-200 bg-emerald-50/90"
                  : officialLogoRequired
                    ? "border-amber-300 bg-amber-50/95"
                    : "border-violet-200 bg-violet-50/90",
              )}
              data-testid="knowledge-node-action-card"
            >
              {knowledgeBaseComplete ? (
                <div>
                  <p className="text-sm font-semibold text-emerald-900">
                    全部节点已完成
                  </p>
                  <p className="mt-1 text-xs leading-5 text-emerald-800">
                    请点击右上角“更新知识库”，同步最终知识库内容。
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "text-xs font-semibold tracking-wide",
                          officialLogoRequired
                            ? "text-amber-700"
                            : "text-violet-700",
                        )}
                      >
                        {officialLogoRequired
                          ? replacingOfficialLogo && !officialLogoAvailable
                            ? "上传企业主 Logo（可选）"
                            : replacingOfficialLogo
                              ? "更换企业主 Logo"
                              : "需要上传企业主 Logo"
                          : "当前待确认"}
                      </p>
                      <p
                        className={cn(
                          "mt-1 truncate text-sm font-semibold",
                          officialLogoRequired
                            ? "text-amber-950"
                            : "text-violet-950",
                        )}
                      >
                        {currentKnowledgeLeaf!.branchTitle} /{" "}
                        {currentKnowledgeLeaf!.title}
                      </p>
                      <p
                        className={cn(
                          "mt-1 text-xs leading-5",
                          officialLogoRequired
                            ? "text-amber-900/80"
                            : "text-violet-800/80",
                        )}
                      >
                        {officialLogoRequired
                          ? replacingOfficialLogo
                            ? officialLogoAvailable
                              ? "请选择一张新图片；提交后将替换当前 Logo，当前知识节点不会推进。"
                              : "请选择一张图片作为企业主 Logo；也可暂不上传并直接确认当前内容。"
                            : "当前节点尚未绑定 Logo。请选择一张图片；用户选择后将直接作为当前 Logo，并可在首节点确认前再次更换。"
                          : currentNodePresentationReady
                            ? "可直接确认，也可以输入修改意见或上传补充资料。"
                            : "正在处理当前节点内容，显示完整后才可确认。"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!officialLogoRequired && optionalOfficialLogoChoice && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setReplacingOfficialLogo(true)}
                          disabled={quickActionsDisabled}
                          className="rounded-xl bg-white"
                        >
                          <Upload className="h-4 w-4" />
                          上传 Logo（可选）
                        </Button>
                      )}
                      {!officialLogoRequired && officialLogoAvailable && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setReplacingOfficialLogo(true)}
                          disabled={quickActionsDisabled}
                          className="rounded-xl bg-white"
                        >
                          <Upload className="h-4 w-4" />
                          更换 Logo
                        </Button>
                      )}
                      {replacingOfficialLogo &&
                        !officialLogoRequiredByBuild && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              clearSelectedFiles();
                              setReplacingOfficialLogo(false);
                            }}
                            disabled={isSending || isUploading}
                            className="rounded-xl bg-white"
                          >
                            暂不上传
                          </Button>
                        )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          if (officialLogoRequired) {
                            if (files.length === 1) void handleSubmit();
                            else fileInputRef.current?.click();
                            return;
                          }
                          void confirmCurrentContent();
                        }}
                        disabled={
                          officialLogoRequired
                            ? inputLocked || isSending || isUploading
                            : quickActionsDisabled
                        }
                        className="rounded-xl"
                      >
                        {officialLogoRequired && (isSending || isUploading) ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : officialLogoRequired ? (
                          <Upload className="h-4 w-4" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                        {officialLogoRequired
                          ? isSending || isUploading
                            ? "正在发送至 FrontMind"
                            : files.length === 1
                              ? "使用此图并继续"
                              : "选择 Logo 原图"
                          : optionalOfficialLogoChoice
                            ? "跳过 Logo，确认当前内容"
                            : "确认当前内容"}
                      </Button>
                    </div>
                  </div>
                  <p
                    className={cn(
                      "mt-2 text-xs",
                      officialLogoRequired
                        ? "text-amber-800/80"
                        : "text-violet-700/75",
                    )}
                  >
                    {officialLogoRequired
                      ? "Logo 提交轮不会推进节点；FrontMind 接收后会重新呈现当前节点。"
                      : "如需修改，请在下方输入意见或上传资料；建议尽量上传与当前部分相关的补充图片，以丰富知识库内容。系统返回修订稿后，再确认当前内容。"}
                  </p>
                </>
              )}
            </div>
          )}

        {knowledgeBaseAttachmentResumeRequired &&
          matchingKnowledgeBaseAttachmentAttempt && (
            <div className="mb-3 rounded-xl border border-amber-300/70 bg-amber-50/80 p-3 text-sm text-amber-950">
              <p className="font-medium">本轮资料仍保留在当前页面</p>
              <p className="mt-1 text-xs leading-5 text-amber-900/80">
                {matchingKnowledgeBaseAttachmentAttempt.lastError ||
                  "上传或暂存暂时中断。继续时会复用同一请求、同一附件清单和已完成的暂存结果。"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void continueKnowledgeBaseAttachmentAttempt()}
                  disabled={isSending || isUploading}
                >
                  {isSending || isUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  继续上传当前资料
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={discardKnowledgeBaseAttachmentAttempt}
                  disabled={isSending || isUploading}
                >
                  放弃本轮上传
                </Button>
              </div>
            </div>
          )}

        {knowledgeBaseAttachmentReconciliationPending &&
          matchingKnowledgeBaseAttachmentAttempt && (
            <div className="mb-3 rounded-xl border border-violet-200 bg-violet-50/80 p-3 text-sm text-violet-950">
              <div className="flex items-center gap-2 font-medium">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在核对本轮是否已受理
              </div>
              <p className="mt-1 text-xs leading-5 text-violet-900/75">
                当前页面仍保留全部资料；系统只核对同一请求，不会创建新的 turn
                或第二个任务。
              </p>
            </div>
          )}

        {knowledgeBaseDeferredUploadRecoveryRequired &&
          activeConversation?.knowledgeBase?.activeTurnId &&
          activeConversation.knowledgeBase.activeClientRequestId &&
          Number.isSafeInteger(
            activeConversation.knowledgeBase.activeTurnResetRevision,
          ) && (
            <KnowledgeBaseManagedUploadRecovery
              conversationId={activeConversation.id}
              turnId={activeConversation.knowledgeBase.activeTurnId}
              clientRequestId={
                activeConversation.knowledgeBase.activeClientRequestId
              }
              expectedResetRevision={
                activeConversation.knowledgeBase.activeTurnResetRevision!
              }
              onObservation={(observation) => {
                commitKnowledgeBaseObservation(
                  activeConversation.id,
                  observation,
                );
                wakeKnowledgeBaseConversation(activeConversation.id);
              }}
              onRecovered={() =>
                wakeKnowledgeBaseConversation(activeConversation.id)
              }
              onCancelled={() => {
                rollbackPendingKnowledgeBaseTurn(
                  activeConversation.id,
                  activeConversation.knowledgeBase!.activeClientRequestId!,
                );
                wakeKnowledgeBaseConversation(activeConversation.id);
              }}
            />
          )}

        {/* Upload progress indicator */}
        <AnimatePresence>
          {isUploading && uploadProgress && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 px-1"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Upload className="w-3.5 h-3.5 text-primary animate-pulse" />
                <span className="text-xs text-muted-foreground">
                  {officialLogoRequired
                    ? uploadProgress.phase === "verifying"
                      ? "文件已上传，正在发送至 FrontMind"
                      : "正在上传 Logo"
                    : uploadProgress.phase === "verifying"
                      ? "正在校验并提交"
                      : "上传文件"}{" "}
                  ({uploadProgress.currentFileIndex + 1}/
                  {uploadProgress.totalFiles})：
                  <span className="text-foreground font-medium ml-1">
                    {uploadProgress.currentFileName}
                  </span>
                </span>
                <span className="text-xs font-mono text-primary ml-auto">
                  {uploadProgress.overallPercent}%
                </span>
              </div>
              <Progress
                value={uploadProgress.overallPercent}
                className="h-1.5"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* File previews */}
        <AnimatePresence>
          {files.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-2 flex flex-wrap gap-2"
            >
              {files.map((fp) => (
                <motion.div
                  key={fp.id}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="relative group"
                >
                  <div className="flex max-w-[240px] items-center gap-2 rounded-xl border border-border/40 bg-muted/30 px-3 py-2 shadow-sm">
                    {officialLogoRequired ? (
                      <LogoFileThumbnail file={fp.file} />
                    ) : (
                      <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 text-xs text-muted-foreground">
                      <span className="block truncate">{fp.file.name}</span>
                      <span className="block text-[10px] opacity-70">
                        {formatFileSize(fp.file.size)}
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`移除 ${fp.file.name}`}
                    onClick={() => removeFile(fp.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* The Logo gate has one deliberate action above. Hiding the ordinary
            composer prevents the generic Send button from becoming a second,
            ambiguous submit path for the exact same file. */}
        {!officialLogoRequired && (
          <div
            className={cn(
              "bg-card/90 border border-border/70 rounded-[1.5rem] transition-all duration-300 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl",
              isDragging && "ring-2 ring-primary/30",
              "focus-within:shadow-[0_24px_70px_rgba(15,23,42,0.11)] focus-within:border-primary/35",
            )}
          >
            <div className="flex min-h-[68px] items-end gap-1.5 p-2.5 sm:gap-2 sm:p-3.5">
              {/* File buttons */}
              <div className="flex items-center gap-1 pb-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-9 h-9 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={
                        responseLogicInitialPromptLocked ||
                        inputLocked ||
                        isSending ||
                        isUploading ||
                        knowledgeBaseNotStarted
                      }
                    >
                      <Paperclip className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {officialLogoRequired ? "上传企业主 Logo" : "上传文件"}
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleTextChange}
                onCompositionStart={composerComposition.onCompositionStart}
                onCompositionEnd={composerComposition.onCompositionEnd}
                onKeyDown={composerComposition.onKeyDown}
                readOnly={responseLogicInitialPromptLocked}
                aria-readonly={responseLogicInitialPromptLocked}
                placeholder={
                  isUploading
                    ? uploadProgress!.phase === "verifying"
                      ? "附件已上传，正在校验并提交本轮…"
                      : `正在上传文件 ${uploadProgress!.overallPercent}%...`
                    : inputLocked
                      ? syncKnowledgeBaseSnapshot
                        ? "正在根据你的补充资料更新当前节点…"
                        : "FrontMind 正在编排内容制作流程..."
                      : knowledgeBaseNotStarted
                        ? "请先点击上方“构建企业知识库”完成资料采集设置"
                        : officialLogoRequired
                          ? "请使用左侧按钮上传企业主 Logo，上传后才可继续"
                          : syncKnowledgeBaseSnapshot
                            ? "输入修改意见，或上传资料；提交后仍停留当前节点"
                            : "输入你的内容需求，按 Enter 开始编排..."
                }
                disabled={
                  inputLocked ||
                  isSending ||
                  isUploading ||
                  knowledgeBaseNotStarted ||
                  officialLogoRequired
                }
                rows={1}
                data-max-rows={AGENT_COMPOSER_MAX_ROWS}
                className="min-h-11 flex-1 resize-none overflow-y-hidden bg-transparent py-2 text-[15px] leading-6 text-foreground placeholder:text-muted-foreground/55 focus:outline-none"
              />

              {/* Model selector + Send button */}
              <div className="flex items-center gap-1 pb-0.5">
                {/* Model selector dropdown */}
                <div className="relative" ref={modelMenuRef}>
                  {fixedAgentProfile ? null : (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={modelSelectionLocked}
                            onClick={() =>
                              !modelSelectionLocked &&
                              setModelMenuOpen(!modelMenuOpen)
                            }
                            className={cn(
                              "flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs font-medium transition-all",
                              "bg-secondary/80 text-muted-foreground hover:bg-primary/10 hover:text-primary",
                              modelSelectionLocked &&
                                "cursor-not-allowed opacity-70 hover:bg-secondary/80 hover:text-muted-foreground",
                              modelMenuOpen && "bg-primary/10 text-primary",
                            )}
                          >
                            <span className="truncate max-w-[76px] sm:max-w-[148px]">
                              {currentModelInfo.label}
                            </span>
                            <ChevronDown
                              className={cn(
                                "w-3 h-3 transition-transform",
                                modelMenuOpen && "rotate-180",
                              )}
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {modelSelectionLocked
                            ? "当前任务模型已锁定；新建任务后可重新选择"
                            : "选择模型"}
                        </TooltipContent>
                      </Tooltip>

                      {/* Dropdown menu */}
                      <AnimatePresence>
                        {modelMenuOpen && !modelSelectionLocked && (
                          <motion.div
                            initial={{ opacity: 0, y: 4, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 4, scale: 0.95 }}
                            transition={{ duration: 0.15 }}
                            className="absolute bottom-full mb-1 right-0 w-52 rounded-xl border border-border/40 bg-popover shadow-lg z-50 overflow-hidden"
                          >
                            {MODEL_OPTIONS.map((model) => (
                              <button
                                key={model.value}
                                onClick={() => {
                                  setSelectedModel(model.value);
                                  saveConfig({ agentProfile: model.value });
                                  setModelMenuOpen(false);
                                }}
                                className={cn(
                                  "w-full text-left px-3 py-2.5 flex items-center justify-between transition-colors",
                                  selectedModel === model.value
                                    ? "bg-primary/10 text-primary"
                                    : "hover:bg-muted/60 text-foreground",
                                )}
                              >
                                <div>
                                  <p className="text-sm font-medium">
                                    {model.label}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {model.description}
                                  </p>
                                </div>
                                {selectedModel === model.value && (
                                  <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                                )}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}
                </div>

                {/* Send button */}
                <Button
                  onClick={handleSubmit}
                  disabled={
                    (!text.trim() && files.length === 0) ||
                    isSending ||
                    inputLocked ||
                    isUploading ||
                    knowledgeBaseNotStarted
                  }
                  size="icon"
                  className={cn(
                    "w-10 h-10 rounded-2xl transition-all flex-shrink-0",
                    text.trim() || files.length > 0
                      ? "bg-primary text-primary-foreground shadow-md glow-indigo"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {isSending || isUploading || isRunning ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Hint text */}
            <div className="px-4 pb-2">
              <p className="text-xs text-muted-foreground/40">
                {responseLogicInitialPromptLocked
                  ? "首轮使用固定提问发送 · 发送后可自由输入文字并上传图片或文件"
                  : syncKnowledgeBaseSnapshot
                    ? "Enter 提交修订 · Shift+Enter 换行 · 支持多文件选择与拖拽上传"
                    : "Enter 发送 · Shift+Enter 换行 · 支持资料、图片与交付文件上传"}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple={!officialLogoRequired}
        accept={
          officialLogoRequired
            ? "image/png,image/jpeg,image/webp,image/avif,image/gif"
            : undefined
        }
        disabled={
          responseLogicInitialPromptLocked ||
          inputLocked ||
          isSending ||
          isUploading ||
          knowledgeBaseNotStarted
        }
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (selected.length > 0) addFiles(selected);
          e.target.value = "";
        }}
      />
    </div>
  );
}
