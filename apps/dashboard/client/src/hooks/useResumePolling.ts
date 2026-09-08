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
import {
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
  GENERAL_CHAT_TERMINAL_MESSAGE_ID_PREFIX,
  generalChatTerminalMessagePublicId,
} from "@shared/frontmind-general-chat-terminal";
import { toast } from "sonner";

export { GENERAL_CHAT_PARTIAL_RESULT_MESSAGE };

function ordinaryTaskError(taskData: Awaited<ReturnType<typeof retrieveTask>>) {
  return taskData.error;
}

export function ordinaryTaskTerminalErrorCode(
  taskData: Awaited<ReturnType<typeof retrieveTask>>,
) {
  const error = ordinaryTaskError(taskData);
  if (error?.partialResult === true) {
    return GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE;
  }
  return error?.code?.trim() || "TASK_FAILED";
}

export function getResumePollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 4_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

// The upstream provider may briefly report `error` while its authoritative task detail is still
// converging to `stopped/completed`. Keep the one global poll owner alive for a
// bounded GET-only re-probe window; never reset this anchor on repeated errors.
export const ORDINARY_TERMINAL_REPROBE_WINDOW_MS = 2 * 60 * 1000;

function isOrdinaryPollCandidate(conversation: Conversation, now = Date.now()) {
  if (conversation.executionKind === "response_logic" || !conversation.taskId) {
    return false;
  }
  if (conversation.status === "running" || conversation.status === "pending") {
    return true;
  }
  return (
    conversation.status === "error" &&
    typeof conversation.completedAt === "number" &&
    now - conversation.completedAt < ORDINARY_TERMINAL_REPROBE_WINDOW_MS
  );
}

interface KnowledgeBaseRecoveryBoundary {
  isKnowledgeBaseConversation: (conversationId: string) => boolean;
  registerKnowledgeBaseConversation: (conversationId: string) => void;
  wakeKnowledgeBaseConversation: (conversationId: string) => void;
}

async function handOffKnowledgeBaseIfNeeded(
  conversation: Conversation,
  boundary: KnowledgeBaseRecoveryBoundary,
  probedConversationIds: Set<string>,
) {
  // The execution domain is authoritative for v2 ordinary chat. Never issue
  // a knowledge-base compatibility request for a known general-chat task.
  if (conversation.executionKind === "general_chat_v2") return false;
  if (boundary.isKnowledgeBaseConversation?.(conversation.id)) {
    boundary.wakeKnowledgeBaseConversation?.(conversation.id);
    return true;
  }
  // Only identity-unknown legacy snapshots need the compatibility probe, and
  // one negative probe per hydrated browser session is sufficient.
  if (probedConversationIds.has(conversation.id)) return false;
  probedConversationIds.add(conversation.id);
  try {
    const progress = await fetchKnowledgeBaseProgress(conversation.id);
    if (!progress) return false;
    boundary.registerKnowledgeBaseConversation?.(conversation.id);
    boundary.wakeKnowledgeBaseConversation?.(conversation.id);
    return true;
  } catch (error) {
    // A failed KB identity probe must not allow raw output to bypass the
    // authoritative projection. Retry the probe on the next pass.
    probedConversationIds.delete(conversation.id);
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
  deleteMessage: ReturnType<typeof useConversation>["deleteMessage"],
  boundary: KnowledgeBaseRecoveryBoundary,
  observedTerminalMessageIds: Set<string>,
  terminalObservedAt: Map<string, number>,
  knowledgeBaseProbeIds: Set<string>,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!conversation.taskId || conversation.executionKind === "response_logic") {
    return false;
  }
  if (
    await handOffKnowledgeBaseIfNeeded(
      conversation,
      boundary,
      knowledgeBaseProbeIds,
    )
  )
    return false;

  try {
    const taskData = await retrieveTask(conversation.taskId);
    if (!isCurrent()) return true;
    const normalizedStatus =
      taskData.status === "failed" ? "error" : taskData.status;
    if (taskData.execution)
      updateStatus(conversation.id, conversation.status, {
        execution: taskData.execution,
      });

    const lastUserIndex = conversation.messages.reduce(
      (latest, message, index) => (message.role === "user" ? index : latest),
      -1,
    );
    const historicalMessages =
      lastUserIndex >= 0
        ? conversation.messages.slice(0, lastUserIndex)
        : conversation.messages;
    const messages = projectTaskOutputMessages({
      output: taskData.output ?? [],
      baselineOutputLength: conversation.lastKnownOutputLength || 0,
      historicalOutputIds: collectAssistantOutputIds(historicalMessages),
      responseStartedAt: conversation.startedAt || conversation.createdAt,
      modelName: taskData.model,
      knowledgeBase: false,
    });
    if (messages.length && normalizedStatus === "completed") {
      messages[messages.length - 1].elapsedTime =
        (Date.now() - (conversation.startedAt || conversation.createdAt)) /
        1000;
    }
    // An empty authoritative projection is meaningful: the server may have
    // temporarily hidden this turn while its Provider binding is ambiguous.
    // Replacing with [] removes only this turn's projected assistants; the
    // reducer keeps the deterministic terminal notice separately.
    updateAssistantMessages(conversation.id, messages);

    if (normalizedStatus === "completed") {
      const completedAt = Date.now();
      const taskKey = `${conversation.id}\0${taskData.id}`;
      updateStatus(conversation.id, "completed", {
        completedAt,
        lastKnownOutputLength: taskData.output?.length || 0,
      });
      for (const message of conversation.messages) {
        if (message.id.startsWith(GENERAL_CHAT_TERMINAL_MESSAGE_ID_PREFIX)) {
          deleteMessage(conversation.id, message.id);
          observedTerminalMessageIds.delete(message.id);
        }
      }
      terminalObservedAt.delete(taskKey);
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
      const taskKey = `${conversation.id}\0${taskData.id}`;
      const terminalAt =
        terminalObservedAt.get(taskKey) ??
        (conversation.status === "error" &&
        typeof conversation.completedAt === "number"
          ? conversation.completedAt
          : Date.now());
      terminalObservedAt.set(taskKey, terminalAt);
      updateStatus(conversation.id, "error", {
        completedAt: terminalAt,
        lastKnownOutputLength: taskData.output?.length || 0,
      });
      const error = ordinaryTaskError(taskData);
      const partialResult = error?.partialResult === true;
      const errorMessage = error?.message || "任务执行出错";
      const errorCode = ordinaryTaskTerminalErrorCode(taskData);
      const messageId = generalChatTerminalMessagePublicId({
        conversationId: conversation.id,
        taskId: taskData.id,
        errorCode,
      });
      let terminalNoticeAdded = false;
      const alreadyObserved = observedTerminalMessageIds.has(messageId);
      observedTerminalMessageIds.add(messageId);
      if (
        !alreadyObserved &&
        !conversation.messages.some((message) => message.id === messageId)
      ) {
        terminalNoticeAdded = true;
        addMessage(conversation.id, {
          id: messageId,
          role: "assistant",
          content: partialResult
            ? GENERAL_CHAT_PARTIAL_RESULT_MESSAGE
            : `❌ 错误: ${errorMessage}`,
          timestamp: Date.now(),
        });
      }
      if (terminalNoticeAdded && partialResult) {
        toast.warning("任务未完整结束", {
          description: "部分结果已保留。",
        });
      } else if (terminalNoticeAdded) {
        toast.error(errorMessage);
      }
      if (terminalNoticeAdded) creditEventBus.emit();
      return Date.now() - terminalAt < ORDINARY_TERMINAL_REPROBE_WINDOW_MS;
    }

    updateStatus(
      conversation.id,
      normalizedStatus === "pending" ? "pending" : "running",
      {
        taskId: taskData.id,
      },
    );
    terminalObservedAt.delete(`${conversation.id}\0${taskData.id}`);
    return true;
  } catch (error) {
    if (!isCurrent()) return true;
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
    deleteMessage,
    isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  } = context;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const pollOnceRef = useRef<(() => Promise<void>) | null>(null);
  const pollGenerationRef = useRef(0);
  const historyAttemptedRef = useRef(new Set<string>());
  const nextDueRef = useRef(new Map<string, number>());
  const terminalProbeKeysRef = useRef(new Set<string>());
  const terminalMessageIdsRef = useRef(new Set<string>());
  const terminalObservedAtRef = useRef(new Map<string, number>());
  const knowledgeBaseProbeIdsRef = useRef(new Set<string>());
  const hydratedRef = useRef(hydrated);
  const stateRef = useRef(state);
  const functionsRef = useRef({
    updateStatus,
    updateAssistantMessages,
    addMessage,
    deleteMessage,
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
    deleteMessage,
    isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
  };

  const needsHistory = (conversation: Conversation) =>
    conversation.id === stateRef.current.activeConversationId &&
    conversation.executionKind === "general_chat_v2" &&
    !conversation.purpose &&
    !conversation.knowledgeBase &&
    Boolean(conversation.taskId) &&
    ["completed", "error", "failed"].includes(conversation.status) &&
    !isOrdinaryPollCandidate(conversation) &&
    conversation.execution?.coverage !== "complete" &&
    !historyAttemptedRef.current.has(
      `${conversation.id}:${conversation.taskId}`,
    );
  const resumableTaskKey = state.conversations
    .filter(
      (conversation) =>
        isOrdinaryPollCandidate(conversation) || needsHistory(conversation),
    )
    .map(
      (conversation) =>
        `${conversation.id}:${conversation.taskId}:${conversation.status}:${conversation.completedAt ?? ""}`,
    )
    .sort()
    .join("|");

  const stopResumePolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    runningRef.current = false;
    pollGenerationRef.current += 1;
  }, []);

  const startResumePolling = useCallback(() => {
    if (!hydratedRef.current || runningRef.current) return;
    const candidates = stateRef.current.conversations.filter(
      (conversation) =>
        isOrdinaryPollCandidate(conversation) || needsHistory(conversation),
    );
    if (!candidates.length) return;
    runningRef.current = true;
    const generation = ++pollGenerationRef.current;
    const stillRunning = new Set(candidates.map(({ id }) => id));

    const pollOnce = async () => {
      if (generation !== pollGenerationRef.current) return;
      timerRef.current = null;
      const functions = functionsRef.current;
      for (const conversation of stateRef.current.conversations) {
        if (
          isOrdinaryPollCandidate(conversation) ||
          needsHistory(conversation)
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
        if (
          !isOrdinaryPollCandidate(conversation) &&
          !needsHistory(conversation)
        ) {
          stillRunning.delete(conversationId);
          continue;
        }
        if (needsHistory(conversation)) {
          const historyStillCurrent = () => {
            const current = stateRef.current.conversations.find(
              (item) => item.id === conversationId,
            );
            if (!current) return false;
            return (
              current?.taskId === conversation.taskId &&
              current.status === conversation.status &&
              current.startedAt === conversation.startedAt &&
              current.messages.findLast((message) => message.role === "user")
                ?.id ===
                conversation.messages.findLast(
                  (message) => message.role === "user",
                )?.id
            );
          };
          historyAttemptedRef.current.add(
            `${conversation.id}:${conversation.taskId}`,
          );
          try {
            const task = await retrieveTask(conversation.taskId);
            if (generation !== pollGenerationRef.current) return;
            if (!historyStillCurrent()) {
              nextDueRef.current.set(conversationId, 0);
              continue;
            }
            functions.updateStatus(conversation.id, conversation.status, {
              execution:
                task.execution?.coverage === "complete"
                  ? task.execution
                  : {
                      schemaVersion: 1,
                      taskId: conversation.taskId,
                      coverage: "unavailable",
                      timeline: task.execution?.timeline ?? [],
                    },
            });
          } catch {
            if (generation !== pollGenerationRef.current) return;
            if (!historyStillCurrent()) {
              nextDueRef.current.set(conversationId, 0);
              continue;
            }
            functions.updateStatus(conversation.id, conversation.status, {
              execution: {
                schemaVersion: 1,
                taskId: conversation.taskId,
                coverage: "unavailable",
                timeline: conversation.execution?.timeline ?? [],
              },
            });
          }
          stillRunning.delete(conversationId);
          continue;
        }
        if ((nextDueRef.current.get(conversationId) ?? 0) > Date.now())
          continue;
        const keepPolling = await checkAndUpdateOrdinaryTask(
          conversation,
          functions.updateStatus,
          functions.updateAssistantMessages,
          functions.addMessage,
          functions.deleteMessage,
          functions,
          terminalMessageIdsRef.current,
          terminalObservedAtRef.current,
          knowledgeBaseProbeIdsRef.current,
          () => {
            const current = stateRef.current.conversations.find(
              (item) => item.id === conversationId,
            );
            if (!current) return false;
            return (
              generation === pollGenerationRef.current &&
              current?.taskId === conversation.taskId &&
              current.startedAt === conversation.startedAt &&
              current.messages.findLast((message) => message.role === "user")
                ?.id ===
                conversation.messages.findLast(
                  (message) => message.role === "user",
                )?.id
            );
          },
        );
        if (!keepPolling) {
          stillRunning.delete(conversationId);
          nextDueRef.current.delete(conversationId);
        } else {
          const foreground =
            document.visibilityState === "visible" &&
            stateRef.current.activeConversationId === conversationId;
          const age =
            Date.now() -
            (conversation.status === "error" && conversation.completedAt
              ? conversation.completedAt
              : conversation.startedAt || conversation.createdAt);
          nextDueRef.current.set(
            conversationId,
            Date.now() + (foreground ? 4_000 : getResumePollDelay(age)),
          );
        }
      }

      if (generation !== pollGenerationRef.current) return;
      if (!stillRunning.size) {
        stopResumePolling();
        return;
      }
      const nextAt = Math.min(
        ...[...stillRunning].map(
          (id) => nextDueRef.current.get(id) ?? Date.now(),
        ),
      );
      timerRef.current = setTimeout(
        pollOnce,
        Math.max(250, nextAt - Date.now()),
      );
    };
    pollOnceRef.current = pollOnce;
    void pollOnce();
  }, [stopResumePolling]);

  useEffect(() => {
    if (!hydrated) {
      stopResumePolling();
      return;
    }
    for (const conversation of stateRef.current.conversations) {
      if (
        conversation.executionKind !== "response_logic" &&
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

  useEffect(() => {
    const activeId = state.activeConversationId;
    if (!activeId) return;
    nextDueRef.current.set(activeId, 0);
    if (runningRef.current && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void pollOnceRef.current?.(), 0);
    }
  }, [state.activeConversationId]);

  useEffect(() => stopResumePolling, [stopResumePolling]);

  useEffect(() => {
    if (!hydrated) {
      terminalProbeKeysRef.current.clear();
      terminalMessageIdsRef.current.clear();
      terminalObservedAtRef.current.clear();
      knowledgeBaseProbeIdsRef.current.clear();
      return;
    }
    for (const conversation of state.conversations) {
      if (
        conversation.executionKind === "response_logic" ||
        (conversation.status !== "completed" &&
          conversation.status !== "error") ||
        !conversation.taskId
      ) {
        continue;
      }
      const key = `${conversation.id}:${conversation.taskId}:${conversation.knowledgeBase?.generation ?? "ordinary"}:${conversation.knowledgeBase?.stateEpoch ?? 0}`;
      if (terminalProbeKeysRef.current.has(key)) continue;
      terminalProbeKeysRef.current.add(key);
      void handOffKnowledgeBaseIfNeeded(
        conversation,
        functionsRef.current,
        knowledgeBaseProbeIdsRef.current,
      );
    }
  }, [hydrated, state.conversations]);

  useEffect(() => {
    const resume = () => {
      if (hydratedRef.current && !runningRef.current) startResumePolling();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") {
        const activeId = stateRef.current.activeConversationId;
        if (activeId) nextDueRef.current.set(activeId, 0);
        if (runningRef.current && timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => void pollOnceRef.current?.(), 0);
        }
        resume();
      }
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
