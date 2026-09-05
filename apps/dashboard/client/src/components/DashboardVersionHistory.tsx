import { Eye, History, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PortalCard } from "@/components/PortalShell";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ManagedDashboardSection } from "@/dashboard/UserBrandDashboard";
import { trpc } from "@/lib/trpc";

type DashboardVersionHistoryProps = {
  userId: number;
  onWorkspaceChanged?: () => void | Promise<void>;
};

const PUBLICATION_LABELS = {
  publish: "内容发布",
  rollback: "历史恢复",
  migration: "存量迁移",
} as const;

export default function DashboardVersionHistory({
  userId,
  onWorkspaceChanged,
}: DashboardVersionHistoryProps) {
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [rollbackRevision, setRollbackRevision] = useState<number | null>(null);
  const [rollbackReason, setRollbackReason] = useState("");
  const historyQuery = trpc.admin.workspace.content.history.useQuery(
    { userId, limit: 30 },
    { retry: false },
  );
  const versionQuery = trpc.admin.workspace.content.version.useQuery(
    { userId, revision: previewRevision || 1 },
    {
      enabled: previewRevision !== null,
      retry: false,
    },
  );
  const rollbackMutation = trpc.admin.workspace.content.rollback.useMutation();

  const confirmRollback = async () => {
    if (!rollbackRevision || !historyQuery.data) return;
    const reason = rollbackReason.trim();
    if (reason.length < 3) {
      toast.error("请填写恢复原因", {
        description: "恢复会创建新的正式发布版本，原因会写入操作审计。",
      });
      return;
    }
    try {
      const result = await rollbackMutation.mutateAsync({
        userId,
        targetRevision: rollbackRevision,
        expectedRevision: historyQuery.data.currentRevision,
        reason,
      });
      setRollbackRevision(null);
      setRollbackReason("");
      await Promise.all([historyQuery.refetch(), onWorkspaceChanged?.()]);
      toast.success(`已恢复 R${rollbackRevision} 的内容`, {
        description: `系统已创建新的正式版本 R${result.revision}，历史记录未被覆盖。`,
      });
    } catch (error) {
      toast.error("无法恢复历史版本", {
        description:
          error instanceof Error
            ? error.message
            : "内容可能已被其他管理员更新，请刷新后重试。",
      });
    }
  };

  return (
    <>
      <PortalCard className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[#e8e1ee] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <div className="flex items-center gap-2">
              <History className="h-5 w-5 text-[#5b2a86]" />
              <h3 className="font-semibold text-[#171321]">交付内容发布历史</h3>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#716a80]">
              记录企业资料、指标、进度报告与交付内容的发布快照；问题、应答逻辑和监控记录由各自流程管理。恢复历史内容会创建新版本，不会改写旧记录。
            </p>
          </div>
          {historyQuery.data && (
            <span className="shrink-0 rounded-xl bg-[#f3eef6] px-3 py-2 text-xs font-semibold text-[#5b2a86]">
              当前 R{historyQuery.data.currentRevision}
            </span>
          )}
        </div>

        {historyQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-[#716a80]">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取发布历史…
          </div>
        ) : historyQuery.error ? (
          <div className="flex items-start gap-3 p-6 text-sm text-[#a02652]">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">发布历史暂时无法读取</p>
              <p className="mt-1">{historyQuery.error.message}</p>
            </div>
          </div>
        ) : historyQuery.data?.versions.length ? (
          <div className="divide-y divide-[#eee8f2]">
            {historyQuery.data.versions.map((version) => (
              <article
                key={version.id}
                className="grid gap-3 px-5 py-4 sm:grid-cols-[95px_minmax(0,1fr)_auto] sm:items-center sm:px-6"
              >
                <div>
                  <p className="text-lg font-semibold text-[#332842]">
                    R{version.revision}
                  </p>
                  <span
                    className={`mt-1 inline-flex rounded-md px-2 py-1 text-xs font-semibold ${
                      version.isCurrent
                        ? "bg-[#16794f]/10 text-[#16794f]"
                        : "bg-[#f3eef6] text-[#716a80]"
                    }`}
                  >
                    {version.isCurrent ? "当前版本" : "历史版本"}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#484057]">
                    {PUBLICATION_LABELS[version.publicationKind]}
                    {version.rolledBackFromRevision
                      ? ` · 恢复自 R${version.rolledBackFromRevision}`
                      : ""}
                  </p>
                  <p className="mt-1 truncate text-xs text-[#857e91]">
                    {version.sourceName || "管理员结构化编辑"}
                    {" · "}
                    {new Date(version.createdAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPreviewRevision(version.revision)}
                  >
                    <Eye className="h-4 w-4" />
                    查看
                  </Button>
                  {!version.isCurrent && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[#5b2a86]"
                      onClick={() => {
                        setRollbackReason("");
                        setRollbackRevision(version.revision);
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      恢复
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-[#716a80]">
            当前账号尚无正式内容发布记录。
          </p>
        )}
      </PortalCard>

      <Dialog
        open={previewRevision !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewRevision(null);
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-[min(1180px,calc(100vw-2rem))] overflow-hidden p-0">
          <DialogHeader className="border-b border-[#e8e1ee] px-6 py-5 text-left">
            <DialogTitle>
              内容版本 R{previewRevision || versionQuery.data?.version.revision}
            </DialogTitle>
            <DialogDescription>
              只读预览该次正式发布的企业内容，不会触发模型或修改用户看板。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[calc(92vh-104px)] overflow-y-auto bg-[#f6f3f8] p-4 sm:p-6">
            {versionQuery.isLoading ? (
              <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-[#716a80]">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在载入历史版本…
              </div>
            ) : versionQuery.error ? (
              <div className="rounded-2xl border border-[#ebc8d4] bg-[#fff8fa] p-5 text-sm text-[#a02652]">
                {versionQuery.error.message}
              </div>
            ) : versionQuery.data?.version.payload ? (
              <div className="space-y-4">
                {versionQuery.data.version.reason && (
                  <div className="rounded-xl border border-[#ded3e6] bg-white px-4 py-3 text-sm text-[#5d5569]">
                    <span className="font-semibold text-[#332842]">
                      发布说明：
                    </span>
                    {versionQuery.data.version.reason}
                  </div>
                )}
                <ManagedDashboardSection
                  payload={versionQuery.data.version.payload}
                  loading={false}
                  error={null}
                  embedded
                />
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={rollbackRevision !== null}
        onOpenChange={(open) => {
          if (!open && !rollbackMutation.isPending) {
            setRollbackRevision(null);
            setRollbackReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              恢复内容版本 R{rollbackRevision}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              当前内容不会被删除。系统会复制该历史快照并发布为新的版本，用户随后看到恢复后的内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="block text-sm font-medium text-[#484057]">
            恢复原因
            <Textarea
              value={rollbackReason}
              disabled={rollbackMutation.isPending}
              onChange={(event) => setRollbackReason(event.target.value)}
              className="mt-2 min-h-24"
              placeholder="例如：客户确认恢复上一版产品口径"
              maxLength={2_000}
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollbackMutation.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                rollbackMutation.isPending || rollbackReason.trim().length < 3
              }
              onClick={(event) => {
                event.preventDefault();
                void confirmRollback();
              }}
            >
              {rollbackMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              确认并发布新版本
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
