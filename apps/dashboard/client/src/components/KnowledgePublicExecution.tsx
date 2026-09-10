import type { KnowledgeBaseRunPhase } from "@shared/knowledge-base-upload-state";
import { Loader2, Check } from "lucide-react";
import type {
  KnowledgeBaseOperationState,
  KnowledgeBaseProcessingPhase,
} from "@shared/knowledge-base-progress";
const phases: Record<KnowledgeBaseProcessingPhase, string> = {
  uploading: "正在上传本轮资料",
  restoring_files: "正在恢复已上传资料",
  migrating_task: "正在准备当前知识任务",
  waiting_provider: "正在研究资料并生成内容",
  accepting: "正在校验并整理返回内容",
  package_preparing: "正在整理知识库版本",
};
const operations: Record<KnowledgeBaseOperationState, string> = {
  creating: "正在建立知识任务",
  waiting_output: "正在研究资料并生成内容",
  normalizing: "正在校验并整理返回内容",
  completed: "本轮内容已处理完成",
  reset_required: "本轮需要处理后继续",
};
/** Only approved business states cross this public execution projection. */
export default function KnowledgePublicExecution({
  phase,
  runPhase,
  operationState,
}: {
  phase?: KnowledgeBaseProcessingPhase | null;
  runPhase?: KnowledgeBaseRunPhase;
  operationState?: KnowledgeBaseOperationState;
}) {
  const runLabels: Record<KnowledgeBaseRunPhase, string> = {
    reserved: "正在准备上传资料", uploading: "正在上传资料", staging: "资料已传输，正在确认与校验",
    dispatching: "资料已确认，正在确认启动结果", researching: "正在研究资料并生成内容", normalizing: "正在整理、校验并生成知识库",
    published: "本轮内容已处理完成", failed: "本轮未能完成，请查看原因", cancelled: "上传已停止，已保存的资料会保留", reset_required: "本轮需要重置后重新上传",
  };
  const label = runPhase ? runLabels[runPhase] :
    operationState === "reset_required" || operationState === "completed"
      ? operations[operationState]
      : phase && Object.hasOwn(phases, phase)
        ? phases[phase]
        : operationState && Object.hasOwn(operations, operationState)
          ? operations[operationState]
          : null;
  if (!label) return null;
  const complete = runPhase ? runPhase === "published" : operationState === "completed";
  return (
    <div
      className="knowledge-public-execution"
      role="status"
      aria-label="知识任务执行状态"
    >
      {complete ? (
        <Check size={14} />
      ) : runPhase ? ["researching", "normalizing"].includes(runPhase) ? (
        <Loader2 size={14} className="animate-spin" />
      ) : null : operationState !== "reset_required" ? (
        <Loader2 size={14} className="animate-spin" />
      ) : null}
      <span>{label}</span>
    </div>
  );
}
