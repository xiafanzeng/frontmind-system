/**
 * Recovery polling for ordinary FrontMind tasks.
 *
 * Knowledge-base conversations are detected before retrieving raw task output
 * and handed to the single coordinator owned by ConversationProvider. This is
 * the boundary that prevents the old local/global double reconcile.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  useConversation,
  type Conversation,
} from "@/contexts/ConversationContext";
import { creditEventBus, retrieveTask } from "@/lib/frontmind-api";
import { fetchKnowledgeBaseProgress } from "@/lib/knowledge-progress";
import {
  collectAssistantOutputIds,
  projectTaskOutputMessages,
} from "@/lib/task-output-projection";
import { toast } from "sonner";

export function getResumePollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 4_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

interface KnowledgeBaseRecoveryBoundary {
  isKnowledgeBaseConversation: (conversationId: string) => boolean;
  registerKnowledgeBaseConversation: (conversationId: string) => void;
  wakeKnowledgeBaseConversation: (conversationId: string) => void;
}

async function handOffKnowledgeBaseIfNeeded(
  conversation: Conversation,
  boundary: KnowledgeBaseRecoveryBoundary,
) {
  if (boundary.isKnowledgeBaseConversation?.(conversation.id)) {
    boundary.wakeKnowledgeBaseConversation?.(conversation.id);
    return true;
  }
  try {
    const progress = await fetchKnowledgeBaseProgress(conversation.id);
    if (!progress) return false;
    boundary.registerKnowledgeBaseConversation?.(conversation.id);
    boundary.wakeKnowledgeBaseConversation?.(conversation.id);
    return true;
  } catch (error) {
    // A failed KB identity probe must not allow raw output to bypass the
    // authoritative projection. Retry the probe on the next pass.
    console.warn("[ResumePolling] knowledge-base probe deferred", error);
    return true;
  }
}

async function checkAndUpdateOrdinaryTask(
  conversation: Conversation,
  updateStatus: ReturnType<typeof useConversation>["updateStatus"],
  updateAssistantMessages: ReturnType<
    typeof useConversation
  >["updateAssistantMessages"],
  addMessage: ReturnType<typeof useConversation>["addMessage"],
  boundary: KnowledgeBaseRecoveryBoundary,
): Promise<boolean> {
  if (!conversation.taskId) return false;
  if (await handOffKnowledgeBaseIfNeeded(conversation, boundary)) return false;

  try {
    const taskData = await retrieveTask(conversation.taskId);
    const normalizedStatus =
      taskData.status === "failed" ? "error" : taskData.status;

    if (taskData.output?.length) {
      const lastUserIndex = conversation.messages.reduce(
        (latest, message, index) => (message.role === "user" ? index : latest),
        -1,
      );
      const historicalMessages =
        lastUserIndex >= 0
          ? conversation.messages.slice(0, lastUserIndex)
          : conversation.messages;
      const messages = projectTaskOutputMessages({
        output: taskData.output,
        baselineOutputLength: conversation.lastKnownOutputLength || 0,
        historicalOutputIds: collectAssistantOutputIds(historicalMessages),
        responseStartedAt: conversation.startedAt || conversation.createdAt,
        modelName: [...conversation.messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.modelName)
          ?.modelName,
        knowledgeBase: false,
      });
      if (messages.length) {
        if (normalizedStatus === "completed") {
          messages[messages.length - 1].elapsedTime =
            (Date.now() - (conversation.startedAt || conversation.createdAt)) /
            1000;
        }
        updateAssistantMessages(conversation.id, messages);
      }
    }

    if (normalizedStatus === "completed") {
      const completedAt = Date.now();
      updateStatus(conversation.id, "completed", {
        completedAt,
        lastKnownOutputLength: taskData.output?.length || 0,
      });
      toast.success(
        `任务已完成 (耗时 ${(
          (completedAt - (conversation.startedAt || conversation.createdAt)) /
          1000
        ).toFixed(1)}s)`,
      );
      creditEventBus.emit();
      return false;
    }

    if (normalizedStatus === "error") {
      updateStatus(conversation.id, "error", {
        completedAt: Date.now(),
        lastKnownOutputLength: taskData.output?.length || 0,
      });
      const errorMessage = taskData.error?.message || "任务执行出错";
      addMessage(conversation.id, {
        id: `msg-err-${taskData.id}-${Date.now()}`,
        role: "assistant",
        content: `❌ 错误: ${errorMessage}`,
        timestamp: Date.now(),
      });
      toast.error(errorMessage);
      creditEventBus.emit();
      return false;
    }

    updateStatus(
      conversation.id,
      normalizedStatus === "pending" ? "pending" : "running",
      {
        taskId: taskData.id,
        taskUrl: taskData.metadata?.task_url,
      },
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ResumePolling] ordinary task check failed", message);
    if (message.includes("404")) {
      updateStatus(conversation.id, "error", { completedAt: Date.now() });
      toast.error("任务不存在或已被删除");
      return false;
    }
    return true;
  }
}

export function useResumePolling() {
  const context = useConversation();
  const {
    state,
    hydrated,
    updateStatus,
    updateAssistantMessages,
    addMessage,
    isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  } = context;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const terminalProbeKeysRef = useRef(new Set<string>());
  const hydratedRef = useRef(hydrated);
  const stateRef = useRef(state);
  const functionsRef = useRef({
    updateStatus,
    updateAssistantMessages,
    addMessage,
    isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  });
  hydratedRef.current = hydrated;
  stateRef.current = state;
  functionsRef.current = {
    updateStatus,
    updateAssistantMessages,
    addMessage,
    isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  };

  const resumableTaskKey = state.conversations
    .filter(
      (conversation) =>
        (conversation.status === "running" ||
          conversation.status === "pending") &&
        conversation.taskId,
    )
    .map((conversation) => `${conversation.id}:${conversation.taskId}`)
    .sort()
    .join("|");

  const stopResumePolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    runningRef.current = false;
  }, []);

  const startResumePolling = useCallback(() => {
    if (!hydratedRef.current || runningRef.current) return;
    const candidates = stateRef.current.conversations.filter(
      (conversation) =>
        (conversation.status === "running" ||
          conversation.status === "pending") &&
        conversation.taskId,
    );
    if (!candidates.length) return;
    runningRef.current = true;
    const stillRunning = new Set(candidates.map(({ id }) => id));

    const pollOnce = async () => {
      const functions = functionsRef.current;
      for (const conversation of stateRef.current.conversations) {
        if (
          (conversation.status === "running" ||
            conversation.status === "pending") &&
          conversation.taskId
        ) {
          stillRunning.add(conversation.id);
        }
      }

      for (const conversationId of [...stillRunning]) {
        const conversation = stateRef.current.conversations.find(
          ({ id }) => id === conversationId,
        );
        if (!conversation?.taskId) {
          stillRunning.delete(conversationId);
          continue;
        }
        const keepPolling = await checkAndUpdateOrdinaryTask(
          conversation,
          functions.updateStatus,
          functions.updateAssistantMessages,
          functions.addMessage,
          functions,
        );
        if (!keepPolling) stillRunning.delete(conversationId);
      }

      if (!stillRunning.size) {
        stopResumePolling();
        return;
      }
      const oldestStartedAt = Math.min(
        ...[...stillRunning].map((conversationId) => {
          const conversation = stateRef.current.conversations.find(
            ({ id }) => id === conversationId,
          );
          return (
            conversation?.startedAt || conversation?.createdAt || Date.now()
          );
        }),
      );
      timerRef.current = setTimeout(
        pollOnce,
        getResumePollDelay(Date.now() - oldestStartedAt),
      );
    };
    void pollOnce();
  }, [stopResumePolling]);

  useEffect(() => {
    if (!hydrated) {
      stopResumePolling();
      return;
    }
    for (const conversation of stateRef.current.conversations) {
      if (
        (conversation.status === "running" ||
          conversation.status === "pending") &&
        !conversation.taskId &&
        !functionsRef.current.isKnowledgeBaseConversation?.(conversation.id)
      ) {
        functionsRef.current.updateStatus(conversation.id, "error", {
          completedAt: Date.now(),
        });
      }
    }
    const timer = setTimeout(startResumePolling, 1_000);
    return () => clearTimeout(timer);
  }, [hydrated, resumableTaskKey, startResumePolling, stopResumePolling]);

  useEffect(() => stopResumePolling, [stopResumePolling]);

  useEffect(() => {
    if (!hydrated) {
      terminalProbeKeysRef.current.clear();
      return;
    }
    for (const conversation of state.conversations) {
      if (
        (conversation.status !== "completed" &&
          conversation.status !== "error") ||
        !conversation.taskId
      ) {
        continue;
      }
      const key = `${conversation.id}:${conversation.taskId}:${conversation.knowledgeBase?.generation ?? "ordinary"}:${conversation.knowledgeBase?.stateEpoch ?? 0}`;
      if (terminalProbeKeysRef.current.has(key)) continue;
      terminalProbeKeysRef.current.add(key);
      void handOffKnowledgeBaseIfNeeded(conversation, functionsRef.current);
    }
  }, [hydrated, state.conversations]);

  useEffect(() => {
    const resume = () => {
      if (hydratedRef.current && !runningRef.current) startResumePolling();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [startResumePolling]);

  return { startResumePolling, stopResumePolling };
}
