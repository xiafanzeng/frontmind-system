import KnowledgeBillingResume from "./KnowledgeBillingResume";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import { KNOWLEDGE_BASE_RESET_REQUEST_EVENT } from "@/lib/knowledge-progress";
import { Button } from "./ui/button";
import {
  KNOWLEDGE_DRAFT_READY_COPY,
  KNOWLEDGE_UPDATE_ATTENTION_COPY,
  KNOWLEDGE_UPDATE_COMPLETE_COPY,
  KNOWLEDGE_UPDATE_PREPARING_COPY,
} from "@shared/knowledge-base-copy";

export default function KnowledgeWorkspaceStatus({ progress }: { progress: KnowledgeBaseProgressDto | null }) {
  if (!progress) return null;
  const partial = progress.contentAvailability === "partial" || progress.resultQuality?.completeness === "partial";
  const reset = progress.operationState === "reset_required" || partial || progress.build.status === "protocol_error";
  const running = ["creating", "waiting_output", "normalizing"].includes(progress.operationState ?? "") || progress.build.awaitingResponseSince != null;
  const current = progress.branches.flatMap((branch) => branch.leaves).find((leaf) => leaf.id === progress.build.currentLeafId);
  const message = reset
    ? partial ? "内容不完整，已保留的节点可预览。请确认重置后重新上传资料。" : "当前构建无法继续，请确认重置后重新上传资料并创建全新任务。"
    : progress.billingPause ? null
    : progress.packageState === "attention_required" ? KNOWLEDGE_UPDATE_ATTENTION_COPY
    : progress.packageState === "preparing" ? KNOWLEDGE_UPDATE_PREPARING_COPY
    : progress.packageState === "retrying" ? `正在重试生成 ZIP 并更新知识库（第 ${Math.max(1, progress.packageAttemptCount ?? 0)} 次）。`
    : progress.build.status === "published" ? KNOWLEDGE_UPDATE_COMPLETE_COPY
    : (progress.updateAllowed ?? progress.packageAllowed) || progress.build.status === "ready_to_publish" ? KNOWLEDGE_DRAFT_READY_COPY
    : running ? progress.operationState === "normalizing" ? "正在处理已返回内容" : "正在处理当前任务"
    : progress.build.status === "failed" ? "本轮已停止。可以重新读取状态，或确认重置后开始全新任务。"
    : current ? `请处理当前节点：${current.title}` : "正在建立知识结构";
  return <div className="knowledge-workspace-status" aria-live="polite">
    {progress.billingPause && <KnowledgeBillingResume key={progress.billingPause.turnId} buildId={progress.build.id} turnId={progress.billingPause.turnId} reason={progress.billingPause.reason} />}
    {message && <p role={reset || progress.build.status === "failed" ? "status" : undefined}>{message}</p>}
    {reset && <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event(KNOWLEDGE_BASE_RESET_REQUEST_EVENT))}>重置后重新上传</Button>}
  </div>;
}
