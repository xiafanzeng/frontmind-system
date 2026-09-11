import { useRetireKnowledgeUploads } from "@/lib/knowledge-base-upload-manager";
import KnowledgeNodeConversation from "./KnowledgeNodeConversation";
import KnowledgePublicExecution from "./KnowledgePublicExecution";
import KnowledgeWorkbenchActions from "./KnowledgeWorkbenchActions";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Download, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { projectResourceUrl } from "@/lib/enterprise-project";
import KnowledgeNodeWorkspace from "@/components/KnowledgeNodeWorkspace";
import KnowledgeWorkspaceStatus from "@/components/KnowledgeWorkspaceStatus";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { getUnsavedWorkspaceDrafts } from "@/lib/workspace-navigation-guard";
import type { KnowledgeNodeDetailsDto } from "@shared/knowledge-node-workspace";
import "./KnowledgeWorkspace.css";
import KnowledgeBaseViewer, {
  type KnowledgeSnapshotView,
} from "@/components/KnowledgeBaseViewer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useConversation,
  type Conversation,
} from "@/contexts/ConversationContext";
import { syncKnowledgeBaseArchiveFromOutput } from "@/lib/knowledge-snapshot";
import {
  KNOWLEDGE_BASE_RESET_REQUEST_EVENT,
  isKnowledgeBaseProgressCoordinateOlder,
  readKnowledgeBaseProgressEventDetail,
} from "@/lib/knowledge-progress";
import { trpc } from "@/lib/trpc";
import Home from "@/pages/Home";
import { setWorkbenchTaskQuery } from "@/contexts/ConversationContext";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import type {
  KnowledgeBaseLeafStatus,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";

const KnowledgeActionsContext = createContext<{
  workflow: React.ReactNode;
  download: React.ReactNode;
  titleRef?: React.RefObject<HTMLHeadingElement | null>;
}>({ workflow: null, download: null });
const KNOWLEDGE_BASE_NEW_BUILD_EVENT = "frontmind:new-knowledge-base-build";
export const KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS = 15_000;

function isKnowledgeBaseConversationCandidate(
  conversation: Conversation | null,
) {
  return Boolean(
    conversation &&
      (conversation.knowledgeBase ||
        conversation.title === "企业知识库构建" ||
        conversation.messages?.some((message) => message.knowledgeBase)),
  );
}

function hasLastGoodKnowledgeBasePresentation(
  conversation: Conversation | null | undefined,
) {
  const knowledgeBase = conversation?.knowledgeBase;
  if (
    !knowledgeBase?.initialized ||
    !knowledgeBase.presentationKey ||
    !knowledgeBase.presentationTurnId
  ) {
    return false;
  }
  return Boolean(
    conversation?.messages?.some(
      (message) =>
        message.role === "assistant" &&
        message.content.trim() &&
        message.knowledgeBase?.kind === "presentation" &&
        message.knowledgeBase.serverOwned === true &&
        message.knowledgeBase.presentationKey ===
          knowledgeBase.presentationKey &&
        message.knowledgeBase.turnId === knowledgeBase.presentationTurnId,
    ),
  );
}

export function isKnowledgeBaseProgressProjectionOlder(
  candidate: KnowledgeBaseProgressDto,
  current: KnowledgeBaseProgressDto | null,
) {
  if (!current) return false;
  if (candidate.build.id !== current.build.id) {
    return candidate.build.updatedAt < current.build.updatedAt;
  }
  if (candidate.build.revision !== current.build.revision) {
    return candidate.build.revision < current.build.revision;
  }
  return candidate.build.updatedAt < current.build.updatedAt;
}

export function shouldDiscardConversationAfterKnowledgeReset(input: {
  observedRevision: number | null;
  revision: number;
  hasKnowledge: boolean;
  conversation: Conversation | null;
}) {
  const resetCompleted = shouldInstallFreshConversationAfterKnowledgeReset({
    observedRevision: input.observedRevision,
    revision: input.revision,
    hasKnowledge: input.hasKnowledge,
  });
  return Boolean(
    resetCompleted && isKnowledgeBaseConversationCandidate(input.conversation),
  );
}

export function shouldInstallFreshConversationAfterKnowledgeReset(input: {
  observedRevision: number | null;
  revision: number;
  hasKnowledge: boolean;
}) {
  return input.observedRevision === null
    ? input.revision > 0 && !input.hasKnowledge
    : input.revision > input.observedRevision;
}

export default function EmbeddedKnowledgeBasePanel({
  preview = false,
  previewData,
  page,
  onPageChange,
  mode = "standard",
  workbench = false,
  projectId = "knowledge",
}: {
  preview?: boolean;
  previewData?: {
    progress: KnowledgeBaseProgressDto;
    snapshot: KnowledgeSnapshotView;
  };
  page: "build" | "display";
  onPageChange: (page: "build" | "display") => void;
  mode?: "standard" | "workspace";
  /** Opt in to the conversation + knowledge result workbench shell. */
  workbench?: boolean;
  projectId?: string;
}) {
  const previewMode = import.meta.env.DEV && preview && Boolean(previewData);
  const unified = mode === "workspace";
  const [editingBlocked, setEditingBlocked] = useState(false);
  const [knowledgeUpdating, setKnowledgeUpdating] = useState(false);
  const workspaceTitleRef = useRef<HTMLHeadingElement>(null);
  const { user } = useAuth();
  const trpcUtils = trpc.useUtils();
  const [previewProgress, setPreviewProgress] = useState(
    previewData?.progress ?? null,
  );
  const knowledgeQuery = trpc.workspace.knowledge.useQuery(undefined, {
    enabled: !previewMode && user?.role === "user",
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const resetQuery = trpc.workspace.knowledgeReset.status.useQuery(undefined, {
    enabled: !previewMode && user?.role === "user",
    retry: false,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      !query.state.data?.hasKnowledge ? 5_000 : 30_000,
  });
  const {
    activeConversation,
    hydrated,
    discardKnowledgeBaseConversationsLocally,
    refreshConversationsAfterDiscard,
  } = useConversation();
  useEffect(() => {
    if (previewMode) return;
    const refreshResetStatus = () => {
      void resetQuery.refetch();
    };
    window.addEventListener(
      "frontmind:knowledge-progress-updated",
      refreshResetStatus,
    );
    return () =>
      window.removeEventListener(
        "frontmind:knowledge-progress-updated",
        refreshResetStatus,
      );
  }, [previewMode, resetQuery.refetch]);
  const [observedResetRevision, setObservedResetRevision] = useState<
    number | null
  >(null);
  const resetNeedsFreshConversation = resetQuery.data
    ? shouldInstallFreshConversationAfterKnowledgeReset({
        observedRevision: observedResetRevision,
        revision: resetQuery.data.revision,
        hasKnowledge: resetQuery.data.hasKnowledge,
      })
    : false;
  useEffect(() => {
    const revision = resetQuery.data?.revision;
    if (revision === undefined || !hydrated) return;
    if (resetNeedsFreshConversation) {
      const discardedConversationIds = discardKnowledgeBaseConversationsLocally(
        isKnowledgeBaseConversationCandidate(activeConversation)
          ? activeConversation?.id
          : undefined,
      );
      // The completed reset revision is a hard local boundary: cancel every KB sync
      // lane/coordinator through the context discard, then remove both query
      // aliases before a single fresh RealBuildFlow is allowed to mount.
      trpcUtils.workspace.knowledge.setData(undefined, (current) =>
        current ? { ...current, snapshot: null } : current,
      );
      trpcUtils.workspace.knowledgeProgress.setData(undefined, () => ({
        progress: null,
      }));
      for (const conversationId of discardedConversationIds) {
        trpcUtils.workspace.knowledgeProgress.setData(
          { conversationId },
          () => ({ progress: null }),
        );
      }
      void Promise.all([
        knowledgeQuery.refetch(),
        refreshConversationsAfterDiscard(),
        trpcUtils.workspace.knowledgeProgress.invalidate(),
      ]);
    }
    setObservedResetRevision(revision);
  }, [
    activeConversation,
    discardKnowledgeBaseConversationsLocally,
    hydrated,
    knowledgeQuery,
    observedResetRevision,
    resetNeedsFreshConversation,
    resetQuery.data?.revision,
    refreshConversationsAfterDiscard,
    trpcUtils,
  ]);

  const displayedSnapshot = previewMode
    ? previewData?.snapshot
    : knowledgeQuery.data?.snapshot;
  const archiveDownloadAvailable = Boolean(
    displayedSnapshot?.sourceFileName.toLowerCase().endsWith(".zip") &&
      displayedSnapshot.archiveAvailable === true &&
      /^[a-f0-9]{64}$/i.test(displayedSnapshot.archiveHash || ""),
  );

  const knowledgeDownload = displayedSnapshot && archiveDownloadAvailable && (
    <a
      href={projectResourceUrl(
        `/api/dashboard/knowledge/snapshots/${encodeURIComponent(displayedSnapshot.id)}/archive`,
      )}
      download={displayedSnapshot.sourceFileName}
      className="knowledge-workspace-download"
      title="下载最近一次更新的正式版本，不包含未更新的修改"
    >
      <Download className="h-4 w-4" />
      下载已更新版本
    </a>
  );
  const knowledgeActions = (
    <div className="knowledge-workspace-actions">
      {(unified || page === "build") && !previewMode && (
        <ManualKnowledgeUpdateButton
          disabled={editingBlocked}
          onPendingChange={setKnowledgeUpdating}
          onUpdated={async () => {
            await knowledgeQuery.refetch();
            if (!unified) onPageChange("display");
          }}
        />
      )}
      {!workbench && knowledgeDownload}
      {!previewMode && resetQuery.data && (
        <KnowledgeResetButton
          disabled={editingBlocked || knowledgeUpdating}
          status={resetQuery.data}
          fallbackFocusRef={workspaceTitleRef}
          onReset={async () => {
            await resetQuery.refetch();
            await knowledgeQuery.refetch();
            if (!unified) onPageChange("build");
          }}
        />
      )}
    </div>
  );
  return (
    <section
      className={
        unified
          ? `knowledge-workspace${workbench ? " knowledge-workspace--workbench" : ""}`
          : "page-shell pb-8"
      }
      data-layout-mode={mode}
    >
      {!workbench && (
        <header
          className={unified ? "knowledge-workspace-toolbar" : "page-header"}
        >
          <div>
            <h2 ref={workspaceTitleRef} tabIndex={-1}>
              {unified ? "智能知识库" : "知识库智能体"}
            </h2>
            <p>节点修改保存在工作稿中，确认后更新知识库。</p>
          </div>
          {knowledgeActions}
        </header>
      )}
      <KnowledgeActionsContext.Provider
        value={{
          workflow: knowledgeActions,
          download: knowledgeDownload,
          titleRef: workspaceTitleRef,
        }}
      >
        {!unified && page === "display" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <KnowledgeBaseViewer
              snapshot={displayedSnapshot}
              loading={!previewMode && knowledgeQuery.isLoading}
              showArchiveDownload={false}
            />
          </div>
        ) : previewMode && previewProgress ? (
          <PreviewBuildFlow
            progress={previewProgress}
            onProgressChange={setPreviewProgress}
            mode={mode}
            workbench={workbench}
            projectId={projectId}
          />
        ) : resetQuery.isError ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-lg rounded-2xl border bg-muted/30 p-7 text-center">
              <p className="font-medium">知识库状态读取失败</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                尚未创建新的构建会话，请先重新读取重置状态。
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => void resetQuery.refetch()}
              >
                重新读取
              </Button>
            </div>
          </div>
        ) : !resetQuery.data ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            正在确认知识库重置状态…
          </div>
        ) : resetNeedsFreshConversation ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            正在清理旧任务并准备全新知识库…
          </div>
        ) : (
          <RealBuildFlow
            key={`knowledge-build-${resetQuery.data?.revision ?? 0}`}
            mode={mode}
            resetRevision={resetQuery.data.revision}
            accountId={user?.id ?? 0}
            fallbackSnapshot={displayedSnapshot ?? null}
            onEditingBlockedChange={setEditingBlocked}
            updating={knowledgeUpdating}
            workbench={workbench}
            projectId={projectId}
          />
        )}
      </KnowledgeActionsContext.Provider>
    </section>
  );
}

function KnowledgeResetButton({
  status,
  onReset,
  fallbackFocusRef,
  disabled = false,
}: {
  status: {
    revision: number;
    canReset: boolean;
    unavailableReason: string | null;
  };
  onReset: () => Promise<unknown>;
  fallbackFocusRef: React.RefObject<HTMLHeadingElement | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const retireUploads = useRetireKnowledgeUploads();
  const resetMutation = trpc.workspace.knowledgeReset.reset.useMutation();
  const submittingRef = useRef(false);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const openReset = () => {
      if (disabled || getUnsavedWorkspaceDrafts().length) {
        toast.info("请先保存或清空未提交内容，再重置知识库");
      } else if (status.canReset) {
        setExpectedRevision(status.revision);
        setOpen(true);
      } else toast.info(status.unavailableReason || "当前暂时无法重置知识库");
    };
    window.addEventListener(KNOWLEDGE_BASE_RESET_REQUEST_EVENT, openReset);
    return () =>
      window.removeEventListener(KNOWLEDGE_BASE_RESET_REQUEST_EVENT, openReset);
  }, [disabled, status.canReset, status.revision, status.unavailableReason]);
  const reset = async () => {
    if (submittingRef.current || expectedRevision === null || disabled) return;
    const operation = captureWorkspaceRestOperation();
    submittingRef.current = true;
    try {
      await resetMutation.mutateAsync({ expectedRevision });
      operation.assertActive();
      retireUploads();
      await onReset();
      operation.assertActive();
      setOpen(false);
      toast.success("知识库已重置，可以重新上传资料");
    } catch (error) {
      if (operation.signal.aborted) return;
      toast.error(error instanceof Error ? error.message : "知识库重置失败");
    } finally {
      submittingRef.current = false;
    }
  };
  return (
    <>
      <Button
        ref={resetButtonRef}
        type="button"
        variant="outline"
        className="knowledge-workspace-reset"
        disabled={disabled || !status.canReset || resetMutation.isPending}
        title={
          !status.canReset ? status.unavailableReason || undefined : undefined
        }
        onClick={() => {
          if (getUnsavedWorkspaceDrafts().length) {
            toast.info("请先保存或清空未提交内容，再重置知识库");
            return;
          }
          setExpectedRevision(status.revision);
          setOpen(true);
        }}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        重置知识库
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!resetMutation.isPending) setOpen(next);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            const resetButton = resetButtonRef.current;
            const target =
              resetButton && !resetButton.disabled
                ? resetButton
                : fallbackFocusRef.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            if (resetMutation.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (resetMutation.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>重置知识库</DialogTitle>
            <DialogDescription>
              重置当前企业项目的知识库后，需要重新上传完整资料并创建全新任务。其他企业项目不受影响，已有任务和历史引用按原规则保留。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={resetMutation.isPending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={resetMutation.isPending}
              onClick={() => void reset()}
            >
              {resetMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {resetMutation.isPending ? "正在重置…" : "确认重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function withKnowledgeReadDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("暂时无法核实更新结果，请稍后重新读取")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function ManualKnowledgeUpdateButton({
  onUpdated,
  disabled = false,
  onPendingChange,
}: {
  onPendingChange: (pending: boolean) => void;
  onUpdated: () => Promise<void>;
  disabled?: boolean;
}) {
  const { activeConversation, updateStatus } = useConversation();
  const [updating, setUpdating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uncertainConversation, setUncertainConversation] = useState<
    string | null
  >(null);
  const confirmedConversation = useRef<string | null>(null);
  const confirmedDraft = useRef<{
    expectedBuildId?: string;
    expectedRevision?: number;
    expectedContentVersion?: number;
  }>({});
  const updateLock = useRef(false);
  useEffect(() => {
    onPendingChange(updating);
    return () => onPendingChange(false);
  }, [updating, onPendingChange]);
  const progressQuery = trpc.workspace.knowledgeProgress.useQuery(
    activeConversation?.id
      ? { conversationId: activeConversation.id }
      : undefined,
    {
      enabled: Boolean(activeConversation?.id),
      retry: false,
    },
  );

  const reconcileUpdate = async () => {
    if (
      updateLock.current ||
      !uncertainConversation ||
      uncertainConversation !== activeConversation?.id
    )
      return;
    const operation = captureWorkspaceRestOperation();
    updateLock.current = true;
    setUpdating(true);
    try {
      const result = await withKnowledgeReadDeadline(progressQuery.refetch());
      operation.assertActive();
      if (result.error || !result.data?.progress)
        throw new Error("暂时无法核实更新结果，请稍后重新读取");
      await withKnowledgeReadDeadline(onUpdated());
      operation.assertActive();
      setUncertainConversation(null);
      setConfirmOpen(false);
      if (result.data.progress.build.status === "published") {
        toast.success("知识库已更新", {
          description: "正在执行和历史任务继续使用各自绑定的版本。",
        });
      } else {
        toast.info("已重新读取当前状态；尚未确认更新成功，请核对后再操作");
      }
    } catch (error) {
      if (!operation.signal.aborted)
        toast.error(
          error instanceof Error
            ? error.message
            : "暂时无法核实更新结果，请稍后重新读取",
        );
    } finally {
      updateLock.current = false;
      setUpdating(false);
    }
  };

  const updateKnowledgeBase = async () => {
    if (updateLock.current || disabled || getUnsavedWorkspaceDrafts().length)
      return;
    if (
      confirmedConversation.current !== activeConversation?.id ||
      uncertainConversation
    ) {
      setConfirmOpen(false);
      toast.info("当前任务已变化，请重新核对知识库更新对象");
      return;
    }
    if (!activeConversation?.id) {
      toast.warning("当前任务还没有可更新的知识库内容", {
        description: "请先在构建工作台中完成知识库整理。",
      });
      return;
    }
    const progress = progressQuery.data?.progress;
    if (!(progress?.updateAllowed ?? progress?.packageAllowed)) {
      toast.warning("知识库尚未逐项走完", {
        description: progress
          ? `当前进度为 ${progress.summary.handled}/${progress.summary.total}；请继续处理“${
              progress.branches
                .flatMap((branch) => branch.leaves)
                .find((leaf) => leaf.id === progress.build.currentLeafId)
                ?.title || "当前节点"
            }”。`
          : "请先完成资料研究并建立通过校验的知识树。",
      });
      return;
    }
    if (
      confirmedDraft.current.expectedBuildId !== progress?.build.id ||
      confirmedDraft.current.expectedRevision !== progress?.build.revision ||
      confirmedDraft.current.expectedContentVersion !==
        progress?.build.contentVersion
    ) {
      setConfirmOpen(false);
      toast.info("工作稿已变化，请重新确认需要更新的知识库内容");
      return;
    }
    if (
      activeConversation.status === "running" ||
      activeConversation.status === "pending"
    ) {
      toast.warning("知识库任务仍在处理中", {
        description: "请等待本轮构建完成后再更新。",
      });
      return;
    }
    const operation = captureWorkspaceRestOperation();
    const updatedConversationId = activeConversation.id;
    updateLock.current = true;
    setUpdating(true);
    try {
      const synced = await syncKnowledgeBaseArchiveFromOutput({
        conversationId: updatedConversationId,
        operation,
        expectedBuildId: progress.build.id,
        expectedRevision: progress.build.revision,
        expectedContentVersion: progress.build.contentVersion,
      });
      operation.assertActive();
      if (!synced) {
        toast.warning("知识库暂未更新", {
          description: "请确认全部节点已完成，并生成了最终知识库文件。",
        });
        return;
      }
      await withKnowledgeReadDeadline(onUpdated());
      operation.assertActive();
      await withKnowledgeReadDeadline(progressQuery.refetch());
      operation.assertActive();
      updateStatus(updatedConversationId, "completed", {
        completedAt: Date.now(),
      });
      setConfirmOpen(false);
      toast.success("知识库已更新", {
        description: "正在执行和历史任务继续使用各自绑定的版本。",
      });
    } catch (error) {
      if (operation.signal.aborted) return;
      setUncertainConversation(updatedConversationId);
      setConfirmOpen(false);
      toast.error("知识库更新结果待核实", {
        description: "请先重新读取实际结果，避免重复提交更新。",
      });
    } finally {
      updateLock.current = false;
      setUpdating(false);
    }
  };

  const progress = progressQuery.data?.progress;
  if (uncertainConversation === activeConversation?.id) {
    return (
      <Button
        variant="outline"
        disabled={updating}
        onClick={() => void reconcileUpdate()}
      >
        {updating ? "正在核实…" : "重新读取更新结果"}
      </Button>
    );
  }
  if (progress?.build.status === "published") {
    return null;
  }
  const generating =
    progress?.packageState === "preparing" ||
    progress?.packageState === "retrying";
  if (generating && !updating) {
    return <Button disabled>生成并更新中…</Button>;
  }
  if (!(progress?.updateAllowed ?? progress?.packageAllowed)) {
    return null;
  }

  return (
    <>
      <Button
        disabled={disabled || updating}
        onClick={() => {
          if (getUnsavedWorkspaceDrafts().length) {
            toast.info("请先保存或清空未提交内容，再更新知识库");
            return;
          }
          confirmedConversation.current = activeConversation?.id ?? null;
          confirmedDraft.current = {
            expectedBuildId: progress?.build.id,
            expectedRevision: progress?.build.revision,
            expectedContentVersion: progress?.build.contentVersion,
          };
          setConfirmOpen(true);
        }}
      >
        <RefreshCw className="h-4 w-4" />
        更新知识库
      </Button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!updating) setConfirmOpen(open);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (updating) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (updating) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>更新知识库</DialogTitle>
            <DialogDescription>
              点击“确认更新”后，系统将根据当前已确认的工作稿生成知识库
              ZIP，并启用新的正式版本供后续任务使用。生成成功前不会启用新版本。正在执行和历史任务仍使用原来绑定的版本；此操作不会发布网站或投放媒体。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={updating}
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={disabled || updating}
              onClick={() => void updateKnowledgeBase()}
            >
              {updating ? "生成并更新中…" : "确认更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RealBuildFlow({
  mode,
  resetRevision,
  accountId,
  fallbackSnapshot,
  onEditingBlockedChange,
  updating,
  workbench,
  projectId,
}: {
  updating: boolean;
  fallbackSnapshot: KnowledgeSnapshotView | null;
  onEditingBlockedChange: (blocked: boolean) => void;
  mode: "standard" | "workspace";
  resetRevision: number;
  accountId: number;
  workbench?: boolean;
  projectId: string;
}) {
  const {
    state,
    activeConversation,
    loading: conversationLoading,
    hydrated,
    syncError,
    createConversation,
    setActive,
    discardKnowledgeBaseConversationsLocally,
    refreshConversationsAfterDiscard,
    refreshConversations,
    clearSyncError,
  } = useConversation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historicalId, setHistoricalId] = useState<string | null>(null);
  const knowledgeActions = useContext(KnowledgeActionsContext);
  const historyTasks = state.conversations.filter(
    (item) =>
      item.knowledgeBase?.initialized || item.workbenchAgentId === "knowledge",
  );
  const historyQueryId = new URLSearchParams(window.location.search).get(
    "workbenchTask",
  );
  const requestedFreshConversationRef = useRef<string | null>(null);
  const [nodeDirty, setNodeDirty] = useState(false);
  const [nodePending, setNodePending] = useState(false);
  const [composerDirty, setComposerDirty] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    leafId: string;
    title: string;
    mode: "direct" | "ai";
  } | null>(null);
  useEffect(() => {
    onEditingBlockedChange(nodeDirty || nodePending || composerDirty);
    return () => onEditingBlockedChange(false);
  }, [nodeDirty, nodePending, composerDirty, onEditingBlockedChange]);
  const trpcUtils = trpc.useUtils();
  const latestProgressQuery = trpc.workspace.knowledgeProgress.useQuery(
    undefined,
    {
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
  const scopedConversation = conversationId
    ? state.conversations.find(
        (conversation) => conversation.id === conversationId,
      )
    : undefined;
  const authoritativeConversationId =
    latestProgressQuery.data?.progress?.build.conversationId;
  const expectedConversationId =
    historicalId ??
    requestedFreshConversationRef.current ??
    authoritativeConversationId ??
    conversationId;
  const activeMatchesExpected = expectedConversationId
    ? activeConversation?.id === expectedConversationId
    : latestProgressQuery.data === undefined || latestProgressQuery.isError;
  // Home renders ConversationContext.activeConversation. Only use that same
  // object as the last-good fallback; a stale scoped id must never make the KB
  // shell mount while Home is actually pointing at an unrelated conversation.
  const lastGoodConversation =
    activeMatchesExpected &&
    hasLastGoodKnowledgeBasePresentation(activeConversation)
      ? activeConversation
      : undefined;
  const displayedConversation =
    lastGoodConversation ??
    (activeMatchesExpected && scopedConversation?.id === activeConversation?.id
      ? scopedConversation
      : undefined);
  const [recoveryTimedOut, setRecoveryTimedOut] = useState(false);
  const recoveryPending = Boolean(
    !lastGoodConversation &&
      !syncError &&
      !latestProgressQuery.isError &&
      (conversationLoading ||
        !hydrated ||
        latestProgressQuery.data === undefined),
  );

  useEffect(() => {
    if (!recoveryPending) {
      setRecoveryTimedOut(false);
      return;
    }
    if (recoveryTimedOut) return;
    const timeout = window.setTimeout(
      () => setRecoveryTimedOut(true),
      KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [recoveryPending, recoveryTimedOut]);

  useEffect(() => {
    const selectFreshBuild = (event: Event) => {
      const nextConversationId = String(
        (event as CustomEvent<{ conversationId?: unknown }>).detail
          ?.conversationId || "",
      ).trim();
      if (!nextConversationId) return;
      setHistoricalId(null);
      requestedFreshConversationRef.current = nextConversationId;
      setWorkbenchTaskQuery(nextConversationId);
      setConversationId(nextConversationId);
      setActive(nextConversationId);
    };
    window.addEventListener(KNOWLEDGE_BASE_NEW_BUILD_EVENT, selectFreshBuild);
    return () =>
      window.removeEventListener(
        KNOWLEDGE_BASE_NEW_BUILD_EVENT,
        selectFreshBuild,
      );
  }, [setActive]);

  useEffect(() => {
    if (
      !hydrated ||
      Boolean(syncError) ||
      latestProgressQuery.isLoading ||
      latestProgressQuery.isError ||
      !latestProgressQuery.data
    ) {
      return;
    }
    // Resolve the URL and the active conversation in this same effect. A
    // separate URL effect races the latest-build fallback on first hydration.
    // The workbench represents the project's current knowledge resource.
    // Legacy conversation links remain stored, but cannot replace that build.
    const selectedHistoryId =
      !workbench &&
      [historyQueryId, historicalId].find(
        (id) => id && historyTasks.some((item) => item.id === id),
      );
    if (selectedHistoryId) {
      if (historicalId !== selectedHistoryId)
        setHistoricalId(selectedHistoryId);
      if (conversationId !== selectedHistoryId)
        setConversationId(selectedHistoryId);
      if (activeConversation?.id !== selectedHistoryId)
        setActive(selectedHistoryId);
      return;
    }
    if (historicalId) setHistoricalId(null);
    const latestConversationId =
      latestProgressQuery.data?.progress?.build.conversationId;
    const latestConversation = latestConversationId
      ? state.conversations.find(
          (conversation) => conversation.id === latestConversationId,
        )
      : undefined;
    if (latestConversationId === requestedFreshConversationRef.current)
      requestedFreshConversationRef.current = null;
    // A server-owned current build outranks an unrelated cached active KB.
    // A missing conversation is a recovery condition, never permission to
    // manufacture a replacement conversation for that build.
    if (
      latestConversationId &&
      !requestedFreshConversationRef.current &&
      conversationId !== latestConversationId
    ) {
      if (latestConversation) {
        setConversationId(latestConversation.id);
        if (activeConversation?.id !== latestConversation.id)
          setActive(latestConversation.id);
      } else if (conversationId) setConversationId(null);
      return;
    }
    if (conversationId && !scopedConversation) {
      requestedFreshConversationRef.current = null;
      setConversationId(null);
      return;
    }
    if (!conversationId && latestConversation) {
      setConversationId(latestConversation.id);
      setActive(latestConversation.id);
      return;
    }
    if (scopedConversation) {
      if (activeConversation?.id !== scopedConversation.id) {
        setActive(scopedConversation.id);
      }
      return;
    }
    if (!conversationId && !latestConversationId && !fallbackSnapshot) {
      const initialConversation = historyTasks
        .filter(
          (item) =>
            item.workbenchAgentId === "knowledge" &&
            item.status === "idle" &&
            !item.messages.length &&
            !item.taskId &&
            !item.previousResponseId &&
            !item.knowledgeBase?.initialized,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (initialConversation) {
        requestedFreshConversationRef.current = initialConversation.id;
        setConversationId(initialConversation.id);
        if (activeConversation?.id !== initialConversation.id)
          setActive(initialConversation.id);
        return;
      }
      const nextConversationId = createConversation({
        title: "企业知识库构建",
        workbenchAgentId: "knowledge",
        reuseEmpty: false,
      });
      requestedFreshConversationRef.current = nextConversationId;
      setConversationId(nextConversationId);
    }
  }, [
    activeConversation?.id,
    workbench,
    historicalId,
    historyQueryId,
    conversationId,
    createConversation,
    fallbackSnapshot,
    hydrated,
    latestProgressQuery.data?.progress?.build.conversationId,
    latestProgressQuery.isError,
    latestProgressQuery.isLoading,
    scopedConversation,
    setActive,
    state.conversations,
    syncError,
  ]);

  const progressQuery = trpc.workspace.knowledgeProgress.useQuery(
    conversationId ? { conversationId } : undefined,
    {
      enabled: Boolean(conversationId),
      retry: false,
    },
  );
  const [nodeDetailContainer, setNodeDetailContainer] =
    useState<HTMLDivElement | null>(null);
  const [nodeDetailsOpen, setNodeDetailsOpen] = useState(false);
  const [nodeFocusRequest, setNodeFocusRequest] = useState<object | null>(null);
  const focusNode = useCallback(() => setNodeFocusRequest({}), []);
  const [liveProgress, setLiveProgress] =
    useState<KnowledgeBaseProgressDto | null>(null);
  const [progressTimedOut, setProgressTimedOut] = useState(false);
  const liveProgressCoordinateRef = useRef({
    generation: -1,
    stateEpoch: -1,
  });

  const installCancelledBatchRevision = useCallback(
    async (cancelledConversationId: string, nextRevision: number) => {
      trpcUtils.workspace.knowledgeReset.status.setData(undefined, (current) =>
        current
          ? {
              ...current,
              revision: Math.max(current.revision, nextRevision),
              hasKnowledge: false,
              locked: false,
              canRequest: false,
              pending: null,
              unavailableReason: "当前没有可重置的知识库记录",
            }
          : current,
      );
      trpcUtils.workspace.knowledgeProgress.setData(undefined, () => ({
        progress: null,
      }));
      const discardedConversationIds = discardKnowledgeBaseConversationsLocally(
        cancelledConversationId,
      );
      for (const conversationId of discardedConversationIds) {
        trpcUtils.workspace.knowledgeProgress.setData(
          { conversationId },
          () => ({ progress: null }),
        );
      }
      setLiveProgress(null);
      void Promise.all([
        refreshConversationsAfterDiscard(),
        trpcUtils.workspace.knowledgeReset.status.invalidate(),
        trpcUtils.workspace.knowledgeProgress.invalidate(),
      ]);
    },
    [
      discardKnowledgeBaseConversationsLocally,
      refreshConversationsAfterDiscard,
      trpcUtils,
    ],
  );

  useEffect(() => {
    setLiveProgress(null);
    setProgressTimedOut(false);
    liveProgressCoordinateRef.current = { generation: -1, stateEpoch: -1 };
    setEditTarget(null);
    setNodeDirty(false);
    setNodePending(false);
    setComposerDirty(false);
  }, [conversationId]);

  useEffect(() => {
    const candidate = progressQuery.data?.progress;
    if (candidate && candidate.build.conversationId !== expectedConversationId)
      return;
    if (candidate !== undefined) {
      setLiveProgress((current) => {
        if (candidate === null) return null;
        if (isKnowledgeBaseProgressProjectionOlder(candidate, current)) {
          return current;
        }
        return candidate;
      });
    }
  }, [progressQuery.data?.progress, expectedConversationId]);

  const latestScopedProgress =
    latestProgressQuery.data?.progress?.build.conversationId ===
    expectedConversationId
      ? latestProgressQuery.data.progress
      : null;
  const displayedProgress =
    [liveProgress, progressQuery.data?.progress, latestScopedProgress].find(
      (candidate) => candidate?.build.conversationId === expectedConversationId,
    ) ?? null;
  useEffect(() => {
    if (
      editTarget?.mode === "ai" &&
      displayedProgress &&
      displayedProgress.build.currentLeafId !== editTarget.leafId
    )
      setEditTarget(null);
  }, [displayedProgress, editTarget]);
  const progressRequestPending = Boolean(
    conversationId && !displayedProgress && progressQuery.isLoading,
  );

  useEffect(() => {
    if (!progressRequestPending) {
      setProgressTimedOut(false);
      return;
    }
    if (progressTimedOut) return;
    const timeout = window.setTimeout(
      () => setProgressTimedOut(true),
      KNOWLEDGE_BASE_RECOVERY_UI_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [progressRequestPending, progressTimedOut]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = readKnowledgeBaseProgressEventDetail(
        (event as CustomEvent<unknown>).detail,
      );
      if (detail) {
        if (
          !expectedConversationId ||
          detail.progress.build.conversationId !== expectedConversationId
        ) {
          return;
        }
        const currentCoordinate = liveProgressCoordinateRef.current;
        const hasCoordinate = detail.generation >= 0 && detail.stateEpoch >= 0;
        const coordinateIsOlder =
          hasCoordinate &&
          isKnowledgeBaseProgressCoordinateOlder(detail, currentCoordinate);
        if (!coordinateIsOlder) {
          if (hasCoordinate) {
            liveProgressCoordinateRef.current = {
              generation: detail.generation,
              stateEpoch: detail.stateEpoch,
            };
          }
          setLiveProgress((current) =>
            isKnowledgeBaseProgressProjectionOlder(detail.progress, current)
              ? current
              : detail.progress,
          );
          if (conversationId) {
            trpcUtils.workspace.knowledgeProgress.setData(
              { conversationId },
              (current) =>
                current &&
                !isKnowledgeBaseProgressProjectionOlder(
                  detail.progress,
                  current.progress ?? null,
                )
                  ? { ...current, progress: detail.progress }
                  : current,
            );
          }
        }
        // The event carries the complete authoritative progress projection.
        // Updating local state and the query cache is sufficient; refetching it
        // here feeds the same progress back into ChatArea and used to trigger a
        // reconcile storm.
        return;
      }
      void progressQuery.refetch();
    };
    window.addEventListener("frontmind:knowledge-progress-updated", refresh);
    return () =>
      window.removeEventListener(
        "frontmind:knowledge-progress-updated",
        refresh,
      );
  }, [
    conversationId,
    expectedConversationId,
    progressQuery.refetch,
    trpcUtils,
  ]);

  const recoveryFailed = Boolean(
    !lastGoodConversation &&
      (syncError || latestProgressQuery.isError || recoveryTimedOut),
  );
  const retryRecovery = () => {
    setRecoveryTimedOut(false);
    clearSyncError();
    void Promise.allSettled([
      refreshConversations(),
      latestProgressQuery.refetch(),
    ]);
  };

  if (recoveryFailed) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border bg-muted/30 p-7 text-center">
          <p className="font-medium">构建会话读取失败</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {syncError || "未能在 15 秒内读取当前构建会话，请检查网络后重试。"}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={retryRecovery}
          >
            重新读取
          </Button>
        </div>
      </div>
    );
  }

  if (
    !lastGoodConversation &&
    (conversationLoading || !hydrated || latestProgressQuery.data === undefined)
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        正在读取当前构建会话…
      </div>
    );
  }

  const missingCurrentConversation = Boolean(
    !historicalId &&
      !requestedFreshConversationRef.current &&
      authoritativeConversationId &&
      !state.conversations.some(
        (conversation) => conversation.id === authoritativeConversationId,
      ),
  );
  const snapshotOnly =
    !requestedFreshConversationRef.current &&
    !displayedProgress &&
    !lastGoodConversation &&
    !latestProgressQuery.data?.progress &&
    Boolean(fallbackSnapshot);
  const executionState = displayedConversation?.knowledgeBase;
  const executionTurnId =
    executionState?.activeTurnId ?? executionState?.presentationTurnId;
  const executionAssistant = [...(displayedConversation?.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        executionTurnId &&
        message.knowledgeBase?.turnId === executionTurnId,
    );
  const publicExecution = (
    <KnowledgePublicExecution
      phase={executionState?.processingPhase}
      runPhase={executionState?.runPhase}
      operationState={displayedProgress?.operationState}
    />
  );
  const publicExecutionRunning = ["dispatching", "researching", "normalizing"].includes(executionState?.runPhase ?? "");
  const hasExecutionTimeline = Boolean((displayedConversation?.execution ?? displayedProgress?.execution)?.timeline.length);
  const collaboration = (
    <>
      {!workbench && (
        <header className="knowledge-collaboration-header">
          <h3>任务协作</h3>
        </header>
      )}
      <KnowledgeWorkspaceStatus progress={displayedProgress} />
      {workbench && (
        <KnowledgeWorkbenchActions
          presentation="accept"
          progress={displayedProgress}
          conversationId={conversationId ?? ""}
          resetRevision={resetRevision}
          disabled={updating || nodeDirty || nodePending || composerDirty}
          exportDisabled={updating || nodePending}
          hasUnsavedChanges={nodeDirty || composerDirty}
          onProgress={setLiveProgress}
        />
      )}
      {workbench && (
        <div
          ref={setNodeDetailContainer}
          className="knowledge-workbench-main-node"
          data-open={nodeDetailsOpen}
        />
      )}
      {editTarget && (
        <div className="knowledge-workspace-edit-target">
          {editTarget.mode === "ai" ? "正在修改" : "正在直接编辑"}：
          {editTarget.title}
        </div>
      )}
      {nodeDirty && (
        <div className="knowledge-workspace-edit-target">
          请先保存或取消节点修改，再提交任务消息。
        </div>
      )}
      {!(workbench && nodeDetailsOpen) && (
        <div className="knowledge-workspace-task">
          {missingCurrentConversation || snapshotOnly ? (
            <div className="knowledge-workspace-empty">
              <p>
                {snapshotOnly
                  ? "现有正式资料可预览。重新构建后可使用节点编辑。"
                  : "当前构建记录无法继续。请确认重置后重新上传资料。"}
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  window.dispatchEvent(
                    new Event(KNOWLEDGE_BASE_RESET_REQUEST_EVENT),
                  )
                }
              >
                重置后重新上传
              </Button>
            </div>
          ) : displayedConversation ? (
            <Home
              key={displayedConversation.id}
              embedded
              hideSidebar
              operatorWorkspace={mode === "workspace"}
              fixedAgentProfile="frontmind-pro"
              syncKnowledgeBaseSnapshot
              inlineBlocks={
                workbench && executionAssistant && !hasExecutionTimeline
                  ? [
                      {
                        id: `knowledge-process:${executionTurnId}`,
                        anchor: {
                          kind: "message",
                          messageId: executionAssistant.id,
                        },
                        placement: "before",
                        content: publicExecution,
                      },
                    ]
                  : undefined
              }
              conversationFooter={
                workbench && !executionAssistant && publicExecutionRunning && !hasExecutionTimeline
                  ? publicExecution
                  : undefined
              }
              knowledgeBaseProgress={displayedProgress}
              knowledgeBaseResetRevision={resetRevision}
              knowledgeBaseAccountId={accountId}
              knowledgeEditingBlocked={
                displayedProgress?.workbench?.phase === "initial" ||
                updating ||
                nodeDirty ||
                nodePending ||
                editTarget?.mode === "direct"
              }
              onComposerDirtyChange={setComposerDirty}
              onKnowledgeBaseBatchCancelled={installCancelledBatchRevision}
            />
          ) : (
            <div className="knowledge-workspace-empty">
              正在打开知识库工作台…
            </div>
          )}
        </div>
      )}
    </>
  );
  const knowledge = snapshotOnly ? (
    <div className="knowledge-workspace-history">
      <KnowledgeBaseViewer
        snapshot={fallbackSnapshot}
        showArchiveDownload={false}
      />
    </div>
  ) : (
    <KnowledgeNodeWorkspace
      detailPresentation={workbench ? "inline" : "drawer"}
      className={workbench ? "knowledge-node-workspace--workbench" : ""}
      nodeConversation={
        workbench && editTarget?.mode === "ai" && displayedProgress
          ? {
              leafId: editTarget.leafId,
              content: (
                <KnowledgeNodeConversation
                  key={`${conversationId}:${editTarget.leafId}`}
                  conversationId={conversationId ?? ""}
                  leafId={editTarget.leafId}
                  title={editTarget.title}
                  progress={displayedProgress}
                  resetRevision={resetRevision}
                  disabled={updating || nodeDirty || nodePending}
                  onDirtyChange={setComposerDirty}
                />
              ),
            }
          : undefined
      }
      detailContainer={workbench ? nodeDetailContainer : null}
      onDetailsOpenChange={setNodeDetailsOpen}
      onNodeOpen={focusNode}
      autoOpenDetails={
        workbench && displayedProgress?.workbench?.phase === "editing"
      }
      key={`${conversationId ?? "empty"}:${displayedProgress?.build.id ?? "empty"}:${displayedConversation?.knowledgeBase?.generation ?? 0}:${resetRevision}`}
      progress={displayedProgress}
      conversationId={conversationId ?? displayedConversation?.id ?? ""}
      generation={displayedConversation?.knowledgeBase?.generation}
      resetRevision={resetRevision}
      loading={progressRequestPending && !progressTimedOut}
      disabled={updating || composerDirty || missingCurrentConversation}
      onDirtyChange={setNodeDirty}
      onMutationPendingChange={setNodePending}
      onEditTargetChange={setEditTarget}
    />
  );
  const resultKey = displayedProgress
    ? `${projectId}:${displayedProgress.build.id}:${displayedProgress.build.revision}:${displayedProgress.build.currentLeafId ?? ""}:${displayedProgress.build.contentVersion ?? ""}:${displayedProgress.build.updatedAt}`
    : `${projectId}:empty`;
  const surfacesKnowledgeActions = useContext(KnowledgeActionsContext);
  return (
    <KnowledgeWorkspaceSurfaces
      taskTitle={displayedConversation?.title}
      taskKey={conversationId ?? undefined}
      collaboration={collaboration}
      knowledge={knowledge}
      topbarActions={surfacesKnowledgeActions?.workflow}
      focusTitleRef={surfacesKnowledgeActions?.titleRef}
      resourceActions={
        workbench ? (
          <>
            <KnowledgeWorkbenchActions
              presentation="resource"
              progress={displayedProgress}
              conversationId={conversationId ?? ""}
              resetRevision={resetRevision}
              disabled={updating || nodeDirty || nodePending || composerDirty}
              exportDisabled={updating || nodePending}
              hasUnsavedChanges={nodeDirty || composerDirty}
              onProgress={setLiveProgress}
            />
            {knowledgeActions.download}
          </>
        ) : undefined
      }
      nodeFocusRequest={nodeFocusRequest}
      collaborationRequest={editTarget?.mode === "ai" ? editTarget : null}
      workbench={workbench}
      projectId={projectId}
      resultKey={resultKey}
    />
  );
}

function KnowledgeWorkspaceSurfaces({
  taskTitle,
  taskKey,
  collaboration,
  knowledge,
  resourceActions,
  topbarActions,
  focusTitleRef,
  collaborationRequest,
  nodeFocusRequest,
  workbench = false,
  projectId = "knowledge",
  resultKey,
}: {
  taskTitle?: string;
  taskKey?: string;
  collaboration: React.ReactNode;
  knowledge: React.ReactNode;
  resourceActions?: React.ReactNode;
  topbarActions?: React.ReactNode;
  focusTitleRef?: React.RefObject<HTMLHeadingElement | null>;
  collaborationRequest?: object | null;
  nodeFocusRequest?: object | null;
  workbench?: boolean;
  projectId?: string;
  resultKey?: string;
}) {
  const [view, setView] = useState<"collaboration" | "knowledge">(
    "collaboration",
  );
  const [mainFocusRequest, setMainFocusRequest] = useState<object | null>(null);
  useEffect(() => {
    if (collaborationRequest) setMainFocusRequest(collaborationRequest);
  }, [collaborationRequest]);
  useEffect(() => {
    if (nodeFocusRequest) setMainFocusRequest(nodeFocusRequest);
  }, [nodeFocusRequest]);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!collaborationRequest) return;
    setView("collaboration");
    const frame = window.requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLTextAreaElement>(
          ".knowledge-workspace-task textarea",
        )
        ?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [collaborationRequest]);
  if (workbench) {
    return (
      <AgentWorkbenchShell
        layout="knowledge"
        taskTitle={taskTitle}
        taskKey={taskKey}
        embedded
        projectId={projectId}
        moduleId="knowledge"
        title="智能知识库"
        topbarActions={topbarActions}
        titleRef={focusTitleRef}
        main={
          <div className="knowledge-conversation-column">{collaboration}</div>
        }
        scrollMain={false}
        auxiliaryScroll={false}
        conversationFocusRequest={mainFocusRequest}
        auxiliary={
          <div className="knowledge-workbench-auxiliary">
            {resourceActions}
            <div className="knowledge-workbench-tree">{knowledge}</div>
          </div>
        }
        resultTitle="知识内容"
        resultKey={resultKey ?? projectId}
      />
    );
  }
  return (
    <div className="knowledge-workspace-surfaces" ref={root}>
      <div
        className="knowledge-workspace-view-switch"
        role="tablist"
        aria-label="知识库工作区域"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "collaboration"
              : event.key === "End"
                ? "knowledge"
                : view === "collaboration"
                  ? "knowledge"
                  : "collaboration";
          setView(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-view-tab="${next}"]`)
            ?.focus();
        }}
      >
        <button
          id={`${id}-collaboration-tab`}
          data-view-tab="collaboration"
          role="tab"
          tabIndex={view === "collaboration" ? 0 : -1}
          aria-controls={`${id}-collaboration`}
          aria-selected={view === "collaboration"}
          onClick={() => setView("collaboration")}
        >
          任务协作
        </button>
        <button
          id={`${id}-knowledge-tab`}
          data-view-tab="knowledge"
          role="tab"
          tabIndex={view === "knowledge" ? 0 : -1}
          aria-controls={`${id}-knowledge`}
          aria-selected={view === "knowledge"}
          onClick={() => setView("knowledge")}
        >
          知识内容
        </button>
      </div>
      <div className="knowledge-workspace-grid" data-view={view}>
        <section
          id={`${id}-collaboration`}
          className="knowledge-workspace-collaboration"
          role="tabpanel"
          aria-labelledby={`${id}-collaboration-tab`}
        >
          {collaboration}
        </section>
        <section
          id={`${id}-knowledge`}
          className="knowledge-workspace-knowledge"
          role="tabpanel"
          aria-labelledby={`${id}-knowledge-tab`}
        >
          {knowledge}
        </section>
      </div>
    </div>
  );
}

function rebuildPreviewProgress(
  progress: KnowledgeBaseProgressDto,
  target: Extract<
    KnowledgeBaseLeafStatus,
    "confirmed" | "direct_prefilled" | "needs_verification"
  >,
) {
  if (!progress.build.currentLeafId) return progress;
  const leaves = progress.branches
    .flatMap((branch) => branch.leaves)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((leaf) => ({ ...leaf }));
  const currentIndex = leaves.findIndex(
    (leaf) => leaf.id === progress.build.currentLeafId,
  );
  if (currentIndex < 0) return progress;
  leaves[currentIndex]!.status = target;
  const handled = target === "confirmed" || target === "direct_prefilled";
  const nextIndex =
    handled && currentIndex + 1 < leaves.length ? currentIndex + 1 : -1;
  if (nextIndex >= 0) leaves[nextIndex]!.status = "current";
  const currentLeafId = handled
    ? nextIndex >= 0
      ? leaves[nextIndex]!.id
      : null
    : leaves[currentIndex]!.id;
  const branches = progress.branches.map((branch) => {
    const branchLeaves = leaves.filter((leaf) => leaf.branchId === branch.id);
    const confirmed = branchLeaves.filter(
      (leaf) => leaf.status === "confirmed",
    ).length;
    const directPrefilled = branchLeaves.filter(
      (leaf) => leaf.status === "direct_prefilled",
    ).length;
    return {
      ...branch,
      leaves: branchLeaves,
      total: branchLeaves.length,
      handled: confirmed + directPrefilled,
      confirmed,
      directPrefilled,
      pending: branchLeaves.filter((leaf) => leaf.status === "pending").length,
      current: branchLeaves.filter((leaf) => leaf.status === "current").length,
      needsVerification: branchLeaves.filter(
        (leaf) => leaf.status === "needs_verification",
      ).length,
    };
  });
  const confirmed = leaves.filter((leaf) => leaf.status === "confirmed").length;
  const directPrefilled = leaves.filter(
    (leaf) => leaf.status === "direct_prefilled",
  ).length;
  const total = leaves.length;
  const totalHandled = confirmed + directPrefilled;
  const packageAllowed = totalHandled === total && currentLeafId === null;
  return {
    ...progress,
    build: {
      ...progress.build,
      status: packageAllowed ? "ready_to_publish" : "confirming",
      revision: progress.build.revision + 1,
      currentLeafId,
      protocolError: null,
      updatedAt: Date.now(),
    },
    summary: {
      total,
      handled: totalHandled,
      confirmed,
      directPrefilled,
      pending: leaves.filter((leaf) => leaf.status === "pending").length,
      current: leaves.filter((leaf) => leaf.status === "current").length,
      needsVerification: leaves.filter(
        (leaf) => leaf.status === "needs_verification",
      ).length,
      overallPercent:
        total === 0 ? 0 : Math.round((totalHandled / total) * 100),
    },
    branches,
    packageAllowed,
  } satisfies KnowledgeBaseProgressDto;
}

export function PreviewBuildFlow({
  progress,
  onProgressChange,
  mode,
  workbench = false,
  projectId = "knowledge",
}: {
  progress: KnowledgeBaseProgressDto;
  onProgressChange: (progress: KnowledgeBaseProgressDto) => void;
  mode: "standard" | "workspace";
  workbench?: boolean;
  projectId?: string;
}) {
  const [detailContainer, setDetailContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [nodeFocusRequest, setNodeFocusRequest] = useState<object | null>(null);
  const focusNode = useCallback(() => setNodeFocusRequest({}), []);
  const [initialAccepted, setInitialAccepted] = useState(false);
  const [draft, setDraft] = useState("");
  const currentLeaf = progress.branches
    .flatMap((branch) => branch.leaves)
    .find((leaf) => leaf.id === progress.build.currentLeafId);
  const [messages, setMessages] = useState<
    Array<{ role: "assistant" | "user"; content: string }>
  >([
    {
      role: "assistant",
      content:
        "已将企业资料整理为知识库初稿。先浏览知识节点，整体确认后即可在主区编辑正文与图片。",
    },
  ]);

  const sendPreviewMessage = () => {
    const content = draft.trim();
    if (!content || !currentLeaf) return;
    const normalized = content
      .normalize("NFKC")
      .replace(/[。！!]+$/g, "")
      .trim()
      .toLowerCase();
    const target = /^(确认|确认无误|无误|没问题|可以|通过|采用|ok|okay)$/.test(
      normalized,
    )
      ? "confirmed"
      : /^(跳过|直接预填|采用预填|保留预填|按预填继续|使用预填)$/.test(
            normalized,
          )
        ? "direct_prefilled"
        : "needs_verification";
    const next = rebuildPreviewProgress(progress, target);
    onProgressChange(next);
    const nextLeaf = next.branches
      .flatMap((branch) => branch.leaves)
      .find((leaf) => leaf.id === next.build.currentLeafId);
    setMessages((current) => [
      ...current,
      { role: "user", content },
      {
        role: "assistant",
        content:
          target === "needs_verification"
            ? `已更新“${currentLeaf.title}”，但本轮属于补充或修订，因此仍停留在当前节点等待明确确认。`
            : nextLeaf
              ? `已将“${currentLeaf.title}”记录为${
                  target === "confirmed" ? "企业已确认" : "直接预填"
                }，现在只进入下一个节点“${nextLeaf.title}”。`
              : "所有叶子节点均已逐项处理，现在可以点击“更新知识库”同步最终展示内容。",
      },
    ]);
    setDraft("");
  };

  const previewDetails: KnowledgeNodeDetailsDto[] = progress.branches
    .flatMap((branch) => branch.leaves)
    .map((leaf) => ({
      coordinates: {
        conversationId: progress.build.conversationId,
        buildId: progress.build.id,
        leafId: leaf.id,
        generation: 1,
        revision: progress.build.revision,
        stateEpoch: 1,
        contentVersion: progress.build.contentVersion ?? 1,
        resetRevision: 0,
      },
      node: {
        leafId: leaf.id,
        title: leaf.title,
        status: leaf.status,
        contentMarkdown:
          leaf.contentMarkdown ||
          `# ${leaf.title}\n\n这是本地设计预览资料。正式页面只展示当前企业项目经过校验的节点正文。\n\n## 已整理内容\n\n- 企业资料与已提供的事实。\n- 产品、服务及适用场景。\n- 需要进一步确认的内容。`,
      },
      resources: [],
      capabilities: {
        directEdit: { allowed: false, reason: "设计预览不提交修改" },
        aiEdit: { allowed: false, reason: "设计预览不创建任务" },
        manageImages: { allowed: false, reason: "设计预览不上传资料" },
      },
    }));
  return (
    <KnowledgeWorkspaceSurfaces
      taskTitle="项目知识库"
      taskKey={`preview-knowledge-${projectId}`}
      workbench={workbench}
      projectId={projectId}
      resultKey={`${projectId}:${progress.build.id}:${progress.build.revision}:${progress.build.currentLeafId ?? ""}:${progress.build.contentVersion ?? ""}`}
      resourceActions={
        workbench ? (
          <section
            className="knowledge-workbench-stage"
            aria-label="知识库版本与下载"
          >
            <div>
              <span className="knowledge-workbench-stage__eyebrow">
                工作稿版本 {progress.build.contentVersion ?? 1}
              </span>
              <p>
                {initialAccepted ? "已进入节点编辑" : "初稿待确认"} ·
                本地设计预览
              </p>
            </div>
          </section>
        ) : undefined
      }
      nodeFocusRequest={nodeFocusRequest}
      collaboration={
        <div className="flex h-full min-h-0 flex-1 flex-col">
          {!workbench && (
            <header className="knowledge-collaboration-header">
              <h3>任务协作</h3>
              <p>本地设计预览 · 不会执行真实任务</p>
            </header>
          )}
          <div className="shrink-0">
            <KnowledgeWorkspaceStatus progress={progress} />
          </div>
          {workbench && (
            <section className="knowledge-workbench-stage">
              <div>
                <span className="knowledge-workbench-stage__eyebrow">
                  {initialAccepted
                    ? "工作稿 · 本地设计预览"
                    : "初稿审阅 · 本地设计预览"}
                </span>
                <p>
                  {initialAccepted
                    ? "选择右侧节点，在主区查看正文。"
                    : "整体确认后进入编辑阶段；预览不会操作真实知识库。"}
                </p>
              </div>
              <Button
                onClick={() => setInitialAccepted(true)}
                disabled={initialAccepted}
              >
                {initialAccepted ? "初稿已确认" : "确认初稿，进入编辑"}
              </Button>
            </section>
          )}
          {workbench && (
            <div
              ref={setDetailContainer}
              className="knowledge-workbench-main-node"
              data-open={detailsOpen}
            />
          )}
          <div
            className="min-h-0 flex-1 overflow-auto p-5"
            hidden={workbench && detailsOpen}
          >
            {messages.map((message, index) => (
              <div
                className="knowledge-preview-message"
                data-role={message.role}
                key={index}
              >
                {message.content}
              </div>
            ))}
          </div>
          <div
            className="shrink-0 border-t p-4"
            hidden={workbench && detailsOpen}
          >
            <label className="sr-only" htmlFor="knowledge-preview-input">
              样例任务输入
            </label>
            <div className="flex items-end gap-3">
              <textarea
                id="knowledge-preview-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-20 min-w-0 flex-1 resize-none rounded-lg border p-3 text-base"
                placeholder="输入补充内容或确认意见…"
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    sendPreviewMessage();
                  }
                }}
              />
              <Button
                size="icon"
                aria-label="发送样例消息"
                disabled={!draft.trim() || !currentLeaf}
                onClick={sendPreviewMessage}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      }
      knowledge={
        <KnowledgeNodeWorkspace
          detailPresentation={workbench ? "inline" : "drawer"}
          className={workbench ? "knowledge-node-workspace--workbench" : ""}
          detailContainer={workbench ? detailContainer : null}
          onDetailsOpenChange={setDetailsOpen}
          onNodeOpen={focusNode}
          autoOpenDetails={workbench && initialAccepted}
          progress={progress}
          conversationId={progress.build.conversationId}
          generation={1}
          resetRevision={0}
          previewDetails={previewDetails}
        />
      }
    />
  );
}
