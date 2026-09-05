import { useEffect, useState } from "react";
import {
  Download,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import KnowledgeBaseProgressPanel from "@/components/KnowledgeBaseProgressPanel";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useConversation,
  type Conversation,
} from "@/contexts/ConversationContext";
import { syncKnowledgeBaseArchiveFromOutput } from "@/lib/knowledge-snapshot";
import { trpc } from "@/lib/trpc";
import Home from "@/pages/Home";
import type {
  KnowledgeBaseLeafStatus,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";

function isKnowledgeBaseConversationCandidate(
  conversation: Conversation | null,
) {
  return Boolean(
    conversation &&
      (conversation.knowledgeBase ||
        conversation.title === "企业知识库构建" ||
        conversation.messages.some((message) => message.knowledgeBase)),
  );
}

export function shouldDiscardConversationAfterKnowledgeReset(input: {
  observedRevision: number | null;
  revision: number;
  hasKnowledge: boolean;
  conversation: Conversation | null;
}) {
  const resetCompleted =
    input.observedRevision === null
      ? input.revision > 0 && !input.hasKnowledge
      : input.revision > input.observedRevision;
  if (!resetCompleted || !input.conversation) return false;
  const conversation = input.conversation;
  return Boolean(
    isKnowledgeBaseConversationCandidate(conversation) &&
      (conversation.knowledgeBase?.initialized ||
        conversation.taskId ||
        conversation.status !== "idle" ||
        conversation.messages.some((message) => message.knowledgeBase)),
  );
}

export default function EmbeddedKnowledgeBasePanel({
  preview = false,
  previewData,
  page,
  onPageChange,
  mode = "standard",
  knowledgeEngineerAssigned = true,
}: {
  preview?: boolean;
  previewData?: {
    progress: KnowledgeBaseProgressDto;
    snapshot: KnowledgeSnapshotView;
  };
  page: "build" | "display";
  onPageChange: (page: "build" | "display") => void;
  mode?: "standard" | "workspace";
  knowledgeEngineerAssigned?: boolean;
}) {
  const previewMode = import.meta.env.DEV && preview && Boolean(previewData);
  const { user } = useAuth();
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
      query.state.data?.locked || !query.state.data?.hasKnowledge
        ? 5_000
        : 30_000,
  });
  const { activeConversation, discardConversationLocally } = useConversation();
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
  useEffect(() => {
    const revision = resetQuery.data?.revision;
    if (revision === undefined) return;
    const resetNeedsAcknowledgement =
      observedResetRevision === null
        ? revision > 0 && resetQuery.data?.hasKnowledge === false
        : revision > observedResetRevision;
    if (
      resetNeedsAcknowledgement &&
      !isKnowledgeBaseConversationCandidate(activeConversation)
    ) {
      // RealBuildFlow may not have selected its scoped conversation yet. Keep
      // the reset pending so a stale KB conversation cannot become the baseline.
      return;
    }
    if (
      shouldDiscardConversationAfterKnowledgeReset({
        observedRevision: observedResetRevision,
        revision,
        hasKnowledge: resetQuery.data?.hasKnowledge === true,
        conversation: activeConversation,
      }) &&
      activeConversation
    ) {
      discardConversationLocally(activeConversation.id);
      void knowledgeQuery.refetch();
    }
    setObservedResetRevision(revision);
  }, [
    activeConversation,
    discardConversationLocally,
    knowledgeQuery,
    observedResetRevision,
    resetQuery.data?.revision,
  ]);

  const displayedSnapshot = previewMode
    ? previewData?.snapshot
    : knowledgeQuery.data?.snapshot;
  const archiveDownloadAvailable = Boolean(
    displayedSnapshot?.sourceFileName.toLowerCase().endsWith(".zip") &&
      displayedSnapshot.archiveAvailable === true &&
      /^[a-f0-9]{64}$/i.test(displayedSnapshot.archiveHash || ""),
  );

  return (
    <section
      className={
        mode === "workspace"
          ? "flex h-full min-h-0 flex-col overflow-hidden bg-white"
          : "page-shell pb-8"
      }
      data-layout-mode={mode}
    >
      <header
        className={
          mode === "workspace"
            ? "flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[#e8e1ee] bg-white px-5 py-3 pl-16 min-[769px]:pl-5"
            : "page-header flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
        }
      >
        <div>
          {mode === "standard" && (
            <span className="eyebrow">MindPromise智诺 / 知识库智能体</span>
          )}
          <h2
            className={
              mode === "workspace"
                ? "m-0 text-base font-semibold text-[#171321]"
                : undefined
            }
          >
            {page === "build" ? "知识库智能体" : "知识库展示"}
          </h2>
          {mode === "standard" && (
            <p>
              {page === "build"
                ? "完成对话更新后，点击“更新知识库”同步展示内容。"
                : "按知识章节展示关联文本与图片，内容来自最近一次手动更新的知识库。"}
            </p>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-3 overflow-x-auto">
          {page === "build" &&
            (previewMode ? (
              <Button
                className="w-fit shrink-0 bg-[#5b2a86] hover:bg-[#49216c]"
                onClick={() => {
                  if (!previewProgress?.packageAllowed) {
                    toast.warning("尚未达到知识库更新条件", {
                      description: previewProgress
                        ? `当前进度为 ${previewProgress.summary.handled}/${previewProgress.summary.total}，请继续完成当前节点。`
                        : "当前预览未配置知识库进度。",
                    });
                    return;
                  }
                  toast.success("知识库展示已更新");
                  onPageChange("display");
                }}
              >
                <RefreshCw className="h-4 w-4" />
                更新知识库
              </Button>
            ) : (
              <ManualKnowledgeUpdateButton
                onUpdated={async () => {
                  await knowledgeQuery.refetch();
                  onPageChange("display");
                }}
              />
            ))}
          {page === "build" && !previewMode && resetQuery.data && (
            <KnowledgeResetButton
              status={resetQuery.data}
              onSubmitted={() => resetQuery.refetch()}
            />
          )}
          {page === "display" && !previewMode && displayedSnapshot?.id && (
            <KnowledgeMaintenanceTicketButton
              snapshotId={displayedSnapshot.id}
              enabled={knowledgeEngineerAssigned}
              unavailableReason={resetQuery.data?.unavailableReason ?? null}
            />
          )}
          {page === "display" &&
            displayedSnapshot &&
            archiveDownloadAvailable && (
              <a
                href={`/api/dashboard/knowledge/snapshots/${encodeURIComponent(displayedSnapshot.id)}/archive`}
                download={displayedSnapshot.sourceFileName}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#5b2a86] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[#49216c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5b2a86] focus-visible:ring-offset-2"
              >
                <Download className="h-4 w-4" />
                下载成品 ZIP
              </a>
            )}
        </div>
      </header>

      {page === "display" ? (
        <div
          className={
            mode === "workspace" ? "min-h-0 flex-1 overflow-auto p-5" : ""
          }
        >
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
      ) : resetQuery.data?.locked ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-lg rounded-2xl border bg-muted/30 p-7 text-center">
            <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
            <p className="mt-4 font-medium">知识库重置申请正在审批</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              工单 {resetQuery.data.pending?.ticketId} 已由
              {resetQuery.data.pending?.engineerName}{" "}
              负责。审批期间不能继续回复、上传、发布或启动新构建。
            </p>
          </div>
        </div>
      ) : (
        <RealBuildFlow
          key={`knowledge-build-${resetQuery.data?.revision ?? 0}`}
          mode={mode}
        />
      )}
    </section>
  );
}

const RESET_REASONS = [
  ["stuck", "构建长时间卡住"],
  ["upload_error", "文件上传错误"],
  ["build_error", "构建内容错误"],
  ["enterprise_materials", "企业资料需要重新整理"],
  ["other", "其他"],
] as const;

function KnowledgeResetButton({
  status,
  onSubmitted,
}: {
  status: {
    locked: boolean;
    canRequest: boolean;
    unavailableReason: string | null;
    pending: { ticketId: string } | null;
  };
  onSubmitted: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] =
    useState<(typeof RESET_REASONS)[number][0]>("stuck");
  const [reasonNote, setReasonNote] = useState("");
  const submitMutation = trpc.workspace.knowledgeReset.submit.useMutation();
  const submit = async () => {
    if (reasonCode === "other" && !reasonNote.trim()) {
      toast.warning("请填写补充说明");
      return;
    }
    try {
      await submitMutation.mutateAsync({
        reasonCode,
        reasonNote: reasonNote.trim() || undefined,
      });
      await onSubmitted();
      setOpen(false);
      toast.success("知识库重置申请已提交", {
        description: "知识库已进入只读锁定，等待负责工程师确认。",
      });
    } catch (error) {
      toast.error("重置申请提交失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };
  return (
    <>
      <Button
        variant="outline"
        className="w-fit shrink-0 text-destructive"
        disabled={!status.canRequest}
        title={status.unavailableReason || undefined}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
        {status.locked ? "重置申请审批中" : "申请重置知识库"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>申请重置知识库</DialogTitle>
            <DialogDescription>
              无需等到构建完成，处理中也可以提交。提交后知识库会立即只读锁定。负责该客户的
              AI
              运维工程师确认后，将清空全部知识库构建、版本、专属对话和附件；其他业务内容不会受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-2 text-sm">
              重置原因
              <select
                className="h-10 rounded-md border bg-background px-3"
                value={reasonCode}
                onChange={(event) =>
                  setReasonCode(
                    event.target.value as (typeof RESET_REASONS)[number][0],
                  )
                }
              >
                {RESET_REASONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm">
              补充说明{reasonCode === "other" ? "（必填）" : "（可选）"}
              <textarea
                className="min-h-28 rounded-md border bg-background p-3"
                maxLength={2_000}
                value={reasonNote}
                onChange={(event) => setReasonNote(event.target.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submit()}
              disabled={submitMutation.isPending}
            >
              {submitMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              提交并锁定知识库
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ManualKnowledgeUpdateButton({
  onUpdated,
}: {
  onUpdated: () => Promise<void>;
}) {
  const { activeConversation, updateStatus } = useConversation();
  const [updating, setUpdating] = useState(false);
  const progressQuery = trpc.workspace.knowledgeProgress.useQuery(
    activeConversation?.id
      ? { conversationId: activeConversation.id }
      : undefined,
    {
      enabled: Boolean(activeConversation?.id),
      retry: false,
    },
  );

  const updateKnowledgeBase = async () => {
    if (!activeConversation?.id) {
      toast.warning("当前任务还没有可更新的知识库内容", {
        description: "请先在构建工作台中完成知识库整理。",
      });
      return;
    }
    const progress = progressQuery.data?.progress;
    if (!progress?.packageAllowed) {
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
      activeConversation.status === "running" ||
      activeConversation.status === "pending"
    ) {
      toast.warning("知识库任务仍在处理中", {
        description: "请等待本轮构建完成后再更新。",
      });
      return;
    }
    if (
      !window.confirm(
        "这是唯一一次直接更新。更新成功后当前会话和更新入口将永久锁定；后续修改需要提交维护工单。确认现在更新吗？",
      )
    ) {
      return;
    }

    setUpdating(true);
    try {
      const synced = await syncKnowledgeBaseArchiveFromOutput({
        conversationId: activeConversation.id,
      });
      if (!synced) {
        toast.warning("知识库展示暂未更新", {
          description: "请确认全部节点已完成，并生成了最终知识库文件。",
        });
        return;
      }
      await onUpdated();
      await progressQuery.refetch();
      updateStatus(activeConversation.id, "completed", {
        completedAt: Date.now(),
      });
      toast.success("知识库展示已更新");
    } catch (error) {
      toast.error("知识库更新失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setUpdating(false);
    }
  };

  const progress = progressQuery.data?.progress;
  if (progress?.build.status === "published") {
    return null;
  }
  if (!progress?.packageAllowed) {
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="max-w-full whitespace-nowrap text-xs leading-5 text-amber-700">
        知识库已达到
        100%：这是唯一一次直接更新；更新成功后当前会话和入口将锁定，后续修改需提交维护工单。
      </p>
      <Button
        className="w-fit shrink-0 bg-[#5b2a86] hover:bg-[#49216c]"
        disabled={updating}
        onClick={() => void updateKnowledgeBase()}
      >
        {updating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {updating ? "正在更新" : "更新知识库"}
      </Button>
    </div>
  );
}

function KnowledgeMaintenanceTicketButton({
  snapshotId,
  enabled = true,
  unavailableReason = null,
}: {
  snapshotId: string;
  enabled?: boolean;
  unavailableReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const deliveryTicketApi = (trpc.workspace as any).deliveryTickets;
  const createMutation = deliveryTicketApi.create.useMutation();

  const submit = async () => {
    if (!enabled) return;
    const request = description.trim();
    if (!request) {
      toast.warning("请填写需要维护或更新的知识库内容");
      return;
    }
    try {
      await createMutation.mutateAsync({
        clientRequestId: crypto.randomUUID(),
        type: "website_operation",
        category: "knowledge_base_maintenance",
        topic: "已发布知识库维护",
        title: "知识库维护工单",
        description: request,
        knowledgeSnapshotId: snapshotId,
        materialUrls: [],
        attachments: [],
      });
      setDescription("");
      setOpen(false);
      toast.success("知识库维护工单已提交", {
        description: "服务团队会在工单中处理后续知识库更新。",
      });
    } catch (error) {
      toast.error("维护工单提交失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <>
      <div className="flex max-w-sm flex-col items-start gap-1.5">
        <Button
          className="w-fit shrink-0 bg-[#5b2a86] hover:bg-[#49216c]"
          disabled={!enabled}
          onClick={() => enabled && setOpen(true)}
        >
          <Wrench className="h-4 w-4" />
          提交维护工单
        </Button>
        {!enabled && (
          <p className="text-xs leading-5 text-amber-700">
            {unavailableReason || "尚未分配 AI 运维工程师，请联系交付管理员。"}
          </p>
        )}
      </div>
      <Dialog
        open={enabled && open}
        onOpenChange={(nextOpen) => enabled && setOpen(nextOpen)}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>提交知识库维护工单</DialogTitle>
            <DialogDescription>
              当前知识库已锁定。请说明需要补充、修订或替换的内容，服务团队将基于已发布版本处理。
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={8}
            maxLength={50_000}
            className="min-h-40 w-full resize-y rounded-xl border border-[#ddd3e5] bg-white px-3 py-2 text-sm outline-none focus:border-[#5b2a86]"
            placeholder="例如：更新产品参数、补充新案例、替换已过期资质……"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              className="bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={createMutation.isPending}
              onClick={() => void submit()}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              提交工单
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RealBuildFlow({ mode }: { mode: "standard" | "workspace" }) {
  const { state, activeConversation, hydrated, createConversation, setActive } =
    useConversation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const trpcUtils = trpc.useUtils();
  const latestProgressQuery = trpc.workspace.knowledgeProgress.useQuery(
    undefined,
    {
      enabled: hydrated,
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
  const scopedConversation = conversationId
    ? state.conversations.find(
        (conversation) => conversation.id === conversationId,
      )
    : undefined;

  useEffect(() => {
    if (
      !hydrated ||
      latestProgressQuery.isLoading ||
      latestProgressQuery.isError ||
      !latestProgressQuery.data
    ) {
      return;
    }
    const latestConversationId =
      latestProgressQuery.data?.progress?.build.conversationId;
    const latestConversation = latestConversationId
      ? state.conversations.find(
          (conversation) => conversation.id === latestConversationId,
        )
      : undefined;
    if (conversationId && !scopedConversation) {
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
    if (!conversationId) {
      const nextConversationId = createConversation({
        title: "企业知识库构建",
        reuseEmpty: true,
      });
      setConversationId(nextConversationId);
    }
  }, [
    activeConversation?.id,
    conversationId,
    createConversation,
    hydrated,
    latestProgressQuery.data?.progress?.build.conversationId,
    latestProgressQuery.isError,
    latestProgressQuery.isLoading,
    scopedConversation,
    setActive,
    state.conversations,
  ]);

  const progressQuery = trpc.workspace.knowledgeProgress.useQuery(
    conversationId ? { conversationId } : undefined,
    {
      enabled: Boolean(conversationId),
      retry: false,
    },
  );
  const [liveProgress, setLiveProgress] =
    useState<KnowledgeBaseProgressDto | null>(null);

  useEffect(() => {
    setLiveProgress(null);
  }, [conversationId]);

  useEffect(() => {
    if (progressQuery.data?.progress !== undefined) {
      setLiveProgress(progressQuery.data.progress);
    }
  }, [progressQuery.data?.progress]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<KnowledgeBaseProgressDto | null>)
        .detail;
      if (
        detail &&
        (!conversationId || detail.build.conversationId === conversationId)
      ) {
        setLiveProgress(detail);
        if (conversationId) {
          trpcUtils.workspace.knowledgeProgress.setData(
            { conversationId },
            (current) => (current ? { ...current, progress: detail } : current),
          );
        }
      }
      void progressQuery.refetch();
    };
    window.addEventListener("frontmind:knowledge-progress-updated", refresh);
    return () =>
      window.removeEventListener(
        "frontmind:knowledge-progress-updated",
        refresh,
      );
  }, [conversationId, progressQuery.refetch, trpcUtils]);

  const progressPanel = (
    <KnowledgeBaseProgressPanel
      progress={liveProgress ?? progressQuery.data?.progress}
      loading={progressQuery.isLoading}
    />
  );

  if (latestProgressQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border bg-muted/30 p-7 text-center">
          <p className="font-medium">构建会话读取失败</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            尚未创建新的构建会话，请先恢复已有会话状态。
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={() => void latestProgressQuery.refetch()}
          >
            重新读取
          </Button>
        </div>
      </div>
    );
  }

  if (latestProgressQuery.isLoading || !latestProgressQuery.data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        正在恢复构建会话…
      </div>
    );
  }

  return (
    <div
      className={
        mode === "workspace"
          ? "relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_390px]"
          : "grid min-h-[680px] gap-5 2xl:grid-cols-[minmax(0,1fr)_390px]"
      }
    >
      <div
        className={
          mode === "workspace"
            ? "min-h-0 overflow-hidden bg-white"
            : "h-[calc(100dvh-210px)] min-h-[680px] overflow-hidden rounded-[20px] border border-[#e1d8e8] bg-white shadow-[0_18px_48px_rgba(33,19,58,.08)]"
        }
      >
        {scopedConversation ? (
          <Home
            key={scopedConversation.id}
            embedded
            hideSidebar
            fixedAgentProfile="frontmind-pro"
            syncKnowledgeBaseSnapshot
            knowledgeBaseProgress={
              liveProgress ?? progressQuery.data?.progress ?? null
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-[#716a80]">
            <Loader2 className="h-5 w-5 animate-spin text-[#5b2a86]" />
            正在打开知识库工作台…
          </div>
        )}
      </div>
      <div
        className={
          mode === "workspace"
            ? "hidden min-h-0 overflow-y-auto border-l border-[#e8e1ee] bg-[#fbf9fd] p-4 custom-scrollbar xl:block"
            : "max-h-[calc(100dvh-210px)] min-h-[320px] overflow-y-auto custom-scrollbar"
        }
      >
        {progressPanel}
      </div>
      {mode === "workspace" && (
        <MobileProgressSheet progressPanel={progressPanel} />
      )}
    </div>
  );
}

function MobileProgressSheet({
  progressPanel,
}: {
  progressPanel: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="absolute right-4 top-4 z-30 gap-2 border-[#d8cde3] bg-white/95 text-[#5b2a86] shadow-sm xl:hidden"
        aria-label="查看知识库构建进度"
      >
        <PanelRightOpen className="h-4 w-4" />
        构建进度
      </Button>
      <SheetContent
        side="right"
        className="w-[min(92vw,390px)] gap-0 overflow-y-auto bg-[#fbf9fd] p-4 sm:max-w-[390px]"
      >
        <SheetHeader className="mb-4 pr-8 text-left">
          <SheetTitle>知识库构建进度</SheetTitle>
        </SheetHeader>
        {progressPanel}
      </SheetContent>
    </Sheet>
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

function PreviewBuildFlow({
  progress,
  onProgressChange,
  mode,
}: {
  progress: KnowledgeBaseProgressDto;
  onProgressChange: (progress: KnowledgeBaseProgressDto) => void;
  mode: "standard" | "workspace";
}) {
  const [draft, setDraft] = useState("");
  const currentLeaf = progress.branches
    .flatMap((branch) => branch.leaves)
    .find((leaf) => leaf.id === progress.build.currentLeafId);
  const [messages, setMessages] = useState<
    Array<{ role: "assistant" | "user"; content: string }>
  >([
    {
      role: "assistant",
      content: `当前节点“${currentLeaf?.title || "当前节点"}”仍有关键证据缺口，我已保留在待核验状态。请继续补充资料，或在内容准确后明确回复“确认”；回复“直接预填”则仅跳过这一个节点。`,
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

  const progressPanel = <KnowledgeBaseProgressPanel progress={progress} />;

  return (
    <div
      className={
        mode === "workspace"
          ? "relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_390px]"
          : "grid min-h-[680px] gap-5 2xl:grid-cols-[minmax(0,1fr)_390px]"
      }
    >
      <section
        className={
          mode === "workspace"
            ? "flex min-h-0 flex-col overflow-hidden bg-white"
            : "flex min-h-[680px] flex-col overflow-hidden rounded-[20px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)]"
        }
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#e8e1ee] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5b2a86] text-white">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-[#171321]">
                  FrontMind 知识库智能体
                </h3>
              </div>
              <p className="mt-1 text-xs text-[#716a80]">
                当前节点：{currentLeaf?.title || "全部节点已处理"}
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto bg-[#fbf9fd] px-4 py-6 sm:px-7">
          <div className="mx-auto max-w-3xl rounded-2xl border border-[#e4d9eb] bg-white p-5 text-sm leading-7 text-[#4f485c] shadow-sm">
            <div className="flex items-center gap-2 text-[#5b2a86]">
              <Sparkles className="h-5 w-5" />
              <strong>
                知识库构建进度 {progress.summary.handled}/
                {progress.summary.total}（{progress.summary.overallPercent}%）
              </strong>
            </div>
            <p className="mt-2 text-[#716a80]">
              每个节点都可以确认、补充或保留预填内容；只有企业明确确认的节点显示对号。
            </p>
          </div>
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`mx-auto flex max-w-3xl ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[88%] rounded-2xl px-5 py-3 text-sm leading-7 shadow-sm ${
                  message.role === "user"
                    ? "rounded-br-md bg-[#5b2a86] text-white"
                    : "rounded-bl-md border border-[#e8e1ee] bg-white text-[#4f485c]"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-[#e8e1ee] bg-white p-4 sm:p-5">
          <div className="flex items-end gap-3 rounded-2xl border border-[#dcd1e5] bg-[#fbf9fd] p-2 focus-within:border-[#5b2a86]/50">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendPreviewMessage();
                }
              }}
              placeholder="试试输入补充内容、“确认”或“直接预填”…"
              className="min-h-[62px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[#9a94a8]"
            />
            <Button
              size="icon"
              aria-label="发送样例消息"
              className="h-10 w-10 shrink-0 rounded-xl bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={!draft.trim() || !currentLeaf}
              onClick={sendPreviewMessage}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <div
        className={
          mode === "workspace"
            ? "hidden min-h-0 overflow-y-auto border-l border-[#e8e1ee] bg-[#fbf9fd] p-4 custom-scrollbar xl:block"
            : "max-h-[780px] overflow-y-auto custom-scrollbar"
        }
      >
        {progressPanel}
      </div>
      {mode === "workspace" && (
        <MobileProgressSheet progressPanel={progressPanel} />
      )}
    </div>
  );
}
