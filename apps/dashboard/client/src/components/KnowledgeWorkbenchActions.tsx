import { useRef, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import { useConversation } from "@/contexts/ConversationContext";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { projectResourceUrl } from "@/lib/enterprise-project";
import { Button } from "./ui/button";

export default function KnowledgeWorkbenchActions({
  progress,
  conversationId,
  resetRevision,
  disabled,
  exportDisabled = disabled,
  hasUnsavedChanges = false,
  onProgress,
}: {
  progress: KnowledgeBaseProgressDto | null;
  conversationId: string;
  resetRevision: number;
  disabled?: boolean;
  exportDisabled?: boolean;
  hasUnsavedChanges?: boolean;
  onProgress: (progress: KnowledgeBaseProgressDto) => void;
}) {
  const { commitKnowledgeBaseObservation } = useConversation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const lock = useRef(false);
  if (!progress?.workbench || !progress.build.contentVersion) return null;
  const coordinates = {
    conversationId,
    expectedGeneration: progress.workbench.generation,
    expectedRevision: progress.build.revision,
    expectedStateEpoch: progress.workbench.stateEpoch,
    expectedContentVersion: progress.build.contentVersion,
    expectedResetRevision: resetRevision,
  };
  const initial = progress.workbench.phase === "initial";
  const available =
    progress.contentAvailability === "complete" &&
    !progress.build.awaitingResponseSince;
  const accept = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    const key = JSON.stringify(coordinates);
    if (attempt.current?.key !== key)
      attempt.current = { key, id: crypto.randomUUID() };
    const rest = captureWorkspaceRestOperation();
    try {
      const response = await rest.fetch(
        "/api/knowledge-base/initial-draft/accept",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...coordinates,
            clientRequestId: attempt.current.id,
          }),
        },
      );
      const result = await response.json();
      rest.assertActive();
      if (result.observation) {
        commitKnowledgeBaseObservation(conversationId, result.observation);
        if (result.observation.progress)
          onProgress(result.observation.progress);
      }
      if (!response.ok)
        throw new Error(result.error?.message ?? "整体确认暂未完成，请重试");
    } catch (error) {
      if (!rest.signal.aborted)
        setError(
          error instanceof Error ? error.message : "整体确认暂未完成，请重试",
        );
    } finally {
      lock.current = false;
      if (!rest.signal.aborted) setPending(false);
    }
  };
  const params = new URLSearchParams(
    Object.entries(coordinates).map(([key, value]) => [key, String(value)]),
  );
  return (
    <section
      className="knowledge-workbench-stage"
      aria-label={initial ? "知识库初稿确认" : "知识库编辑阶段"}
    >
      <div>
        <span className="knowledge-workbench-stage__eyebrow">
          {initial ? "初稿审阅" : "工作稿"}
        </span>
        <p>
          {initial
            ? "初稿已按知识节点组织。浏览后整体确认，即可继续修改正文和图片。"
            : "从右侧选择节点，在这里查看与编辑。完成修改后，更新知识库以启用新版本。"}
        </p>
      </div>
      <div className="knowledge-workbench-stage__actions">
        {initial && (
          <Button onClick={accept} disabled={!available || disabled || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />}
            {pending ? "正在确认…" : "确认初稿，进入编辑"}
          </Button>
        )}
        <Button
          variant="outline"
          asChild
          disabled={!available || exportDisabled || pending}
        >
          <a
            href={projectResourceUrl(
              `/api/knowledge-base/workspace-export?${params}`,
            )}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!available || exportDisabled || pending}
            onClick={(event) => {
              if (!available || exportDisabled || pending)
                event.preventDefault();
            }}
          >
            <Download />
            {hasUnsavedChanges ? "下载已保存工作稿 ZIP" : "导出工作稿 ZIP"}
          </a>
        </Button>
      </div>
      {hasUnsavedChanges && (
        <p className="knowledge-workbench-stage__saved-note">
          下载包含已保存的节点和资料；要包含当前修改，请先在节点中保存。
        </p>
      )}
      {error && (
        <p role="alert" className="knowledge-workbench-stage__error">
          {error}
        </p>
      )}
    </section>
  );
}
