import { Fragment, useEffect, useRef } from "react";
import {
  sanitizeKnowledgeBaseOutputMessages,
  useConversation,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import ChatInput from "./ChatInput";
import MarkdownRenderer from "./MarkdownRenderer";
import KnowledgePublicExecution from "./KnowledgePublicExecution";

export function knowledgeNodeConversationMessages(
  messages: LocalMessage[],
  leafId: string,
  generation: number,
  acceptedAt: string | null | undefined,
  initialIds: Set<string>,
) {
  const acceptedTime = acceptedAt ? Date.parse(acceptedAt) : NaN;
  return sanitizeKnowledgeBaseOutputMessages(
    messages.filter(
      (message) =>
        (message.knowledgeBase?.leafId === leafId &&
          message.knowledgeBase?.generation === generation &&
          (!initialIds.has(message.id) ||
            (Number.isFinite(acceptedTime) &&
              message.timestamp > acceptedTime))) ||
        // A just-submitted local request receives its node tuple from the server
        // shortly afterwards. Preserve that user's text during the receipt gap.
        (!initialIds.has(message.id) &&
          message.role === "user" &&
          message.knowledgeBase?.kind === "pending_user" &&
          typeof message.knowledgeBase.clientRequestId === "string" &&
          message.knowledgeBase.leafId === undefined &&
          message.knowledgeBase.generation === undefined),
    ),
  );
}

/** Reuses the original turn/attachment coordinator with only this node's edits. */
export default function KnowledgeNodeConversation({
  conversationId,
  leafId,
  title,
  progress,
  resetRevision,
  disabled,
  onDirtyChange,
}: {
  conversationId: string;
  leafId: string;
  title: string;
  progress: KnowledgeBaseProgressDto;
  resetRevision: number;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const {
    activeConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  } = useConversation();
  const initialIds = useRef(
    new Set(activeConversation?.messages.map((message) => message.id)),
  );
  const matches = activeConversation?.id === conversationId;
  useEffect(() => {
    if (!matches) return;
    registerKnowledgeBaseConversation(conversationId);
    wakeKnowledgeBaseConversation(conversationId);
  }, [
    conversationId,
    matches,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  ]);
  if (!matches) return null;
  const messages = knowledgeNodeConversationMessages(
    activeConversation.messages,
    leafId,
    progress.workbench?.generation ??
      activeConversation.knowledgeBase?.generation ??
      0,
    progress.workbench?.acceptedAt,
    initialIds.current,
  );
  const knowledge = activeConversation.knowledgeBase;
  const turnId = knowledge?.activeTurnId ?? knowledge?.presentationTurnId;
  const assistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        turnId &&
        message.knowledgeBase?.turnId === turnId,
    );
  const running =
    ["creating", "waiting_output", "normalizing"].includes(
      knowledge?.operationState ?? "",
    ) && knowledge?.leafId === leafId;
  const execution = (
    <KnowledgePublicExecution
      phase={knowledge?.processingPhase}
      operationState={knowledge?.operationState}
    />
  );
  const notice = knowledge?.leafId === leafId ? knowledge?.notice : null;
  return (
    <section
      className="knowledge-node-conversation"
      aria-label={`修改节点：${title}`}
    >
      <p className="knowledge-node-conversation__intro">
        描述这个节点需要怎样修改，生成结果会保留在当前工作稿中。
      </p>
      {messages.map((message) => (
        <Fragment key={message.id}>
          {message.id === assistant?.id && execution}
          <div className={`knowledge-node-conversation__${message.role}`}>
            <MarkdownRenderer content={message.content} />
          </div>
        </Fragment>
      ))}
      {!assistant && running && execution}
      {notice && (
        <p role={notice.severity === "error" ? "alert" : "status"}>
          {notice.message}
        </p>
      )}
      <ChatInput
        fixedAgentProfile="frontmind-pro"
        syncKnowledgeBaseSnapshot
        operatorWorkspace
        knowledgeBaseProgress={progress}
        knowledgeBaseResetRevision={resetRevision}
        knowledgeEditingBlocked={
          disabled || progress.build.currentLeafId !== leafId
        }
        onComposerDirtyChange={onDirtyChange}
      />
    </section>
  );
}
