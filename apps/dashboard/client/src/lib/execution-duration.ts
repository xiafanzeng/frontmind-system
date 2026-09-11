import type {
  Conversation,
  LocalMessage,
} from "@/contexts/ConversationContext";
import {
  orderExecutionTimeline,
  type GeneralExecutionEntry,
} from "@shared/frontmind-general-execution";

export type ExecutionTiming = {
  startedAt: number;
  completedAt?: number;
  active: boolean;
};
const validTime = (value: number | undefined): value is number =>
  value !== undefined &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8.64e15;

/** Uses persisted event times; mounting a view never starts a new clock. */
export function executionTimelineTiming(
  entries: readonly GeneralExecutionEntry[],
  active?: boolean,
): ExecutionTiming | undefined {
  const ordered = orderExecutionTimeline(entries).filter((entry) =>
    validTime(entry.timestamp),
  );
  if (!ordered.length) return undefined;
  const last = ordered.at(-1)!;
  const live =
    active ??
    (last.kind !== "message" &&
      last.isCurrent === true &&
      ![
        "ended",
        "cancelled",
        "error",
        "completed",
        "failed",
        "unconfirmed",
        "returned",
      ].includes(last.status) &&
      (last.status !== "waiting" || Boolean(last.phase)));
  return {
    startedAt: Math.min(...ordered.map((entry) => entry.timestamp)),
    completedAt: live
      ? undefined
      : Math.max(
          ...ordered.map((entry) =>
            validTime(entry.finishedAt)
              ? Math.max(entry.timestamp, entry.finishedAt)
              : entry.timestamp,
          ),
        ),
    active: live,
  };
}

/** Each user turn owns its own duration, including turns without provider events yet. */
export function conversationExecutionTimings(
  conversation: Conversation,
  messages: readonly LocalMessage[],
) {
  const result = new Map<string, ExecutionTiming>();
  // A new upload can be temporarily hidden from the transcript. It still owns
  // the active run; the last visible historical request must remain stopped.
  const latestUser = conversation.messages.findLast((message) => message.role === "user");
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    const current = message.id === latestUser?.id;
    const active =
      current && ["running", "pending"].includes(conversation.status);
    const turnId = message.knowledgeBase?.turnId ?? message.generalChat?.turnId;
    const entries = (conversation.execution?.timeline ?? []).filter(
      (entry) =>
        entry.userMessageId === message.id ||
        (message.serverSequence !== undefined &&
          entry.userSequence === message.serverSequence) ||
        (turnId !== undefined && entry.turnId === turnId),
    );
    const timing = executionTimelineTiming(entries, active);
    if (timing) {
      result.set(message.id, timing);
      continue;
    }
    const following = messages.slice(index + 1);
    const nextUser = following.findIndex((item) => item.role === "user");
    const replies = nextUser < 0 ? following : following.slice(0, nextUser);
    const reply = replies.findLast(
      (item) => item.role === "assistant" && !item.isStepsPlaceholder,
    );
    const startedAt =
      current &&
      validTime(conversation.startedAt) &&
      conversation.startedAt >= message.timestamp
        ? conversation.startedAt
        : message.timestamp;
    const completedAt =
      reply?.elapsedTime !== undefined
        ? (reply.responseStartedAt ?? startedAt) + reply.elapsedTime * 1000
        : current
          ? conversation.completedAt
          : undefined;
    if (validTime(startedAt) && (active || validTime(completedAt)))
      result.set(message.id, { startedAt, completedAt, active });
  }
  return result;
}
