/** The storage sequence is not a turn boundary: an old event can arrive late. */
export type GeneralChatMessageAnchor = {
  id: string;
  role: string;
  serverSequence?: number;
  generalChat?: {
    agentTaskId: string;
    turnId: string;
    providerEventId: string;
    userMessageId?: string;
    userSequence?: number;
    rank?: number;
  };
  generalChatDispatch?: { kind: string };
};

export function generalChatMessageIdentity(message: GeneralChatMessageAnchor) {
  const identity = message.generalChat;
  return identity
    ? JSON.stringify([
        identity.agentTaskId,
        identity.turnId,
        identity.providerEventId,
      ])
    : undefined;
}

const sequence = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! >= 0;

/**
 * Order known rows by their user anchor, then by provider rank within the turn.
 * Unbound legacy rows keep their original slots. A pending browser request
 * follows durable history, even when that history was hydrated later.
 * This only reorders references; visibility and deduplication belong to callers.
 */
export function orderGeneralChatMessages<T extends GeneralChatMessageAnchor>(
  messages: readonly T[],
): T[] {
  const usersById = new Map(
    messages.filter((message) => message.role === "user").map((m) => [m.id, m]),
  );
  const maxSequence = messages.reduce(
    (max, message) =>
      sequence(message.serverSequence)
        ? Math.max(max, message.serverSequence)
        : max,
    -1,
  );
  const userOrder = new Map<T, number>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    if (sequence(message.serverSequence)) {
      userOrder.set(message, message.serverSequence);
    } else if (
      message.generalChatDispatch?.kind === "pending_user" ||
      messages.some(
        (candidate) => candidate.generalChat?.userMessageId === message.id,
      )
    ) {
      userOrder.set(message, maxSequence + index + 1);
    }
  }
  const positioned = messages.flatMap((message, index) => {
    const owned = message.generalChat;
    if (owned && message.role === "assistant") {
      const user = owned.userMessageId
        ? usersById.get(owned.userMessageId)
        : undefined;
      const anchor = user ? userOrder.get(user) : owned.userSequence;
      if (!sequence(anchor)) return [];
      return [{ message, index, anchor, phase: 1, rank: owned.rank }];
    }
    const anchor = userOrder.get(message) ?? message.serverSequence;
    if (!sequence(anchor)) return [];
    return [{ message, index, anchor, phase: 0, rank: undefined }];
  });
  const slots = positioned.map(({ index }) => index);
  positioned.sort((a, b) => {
    const byTurn = a.anchor - b.anchor || a.phase - b.phase;
    if (byTurn) return byTurn;
    return (
      (a.rank ?? Number.MAX_SAFE_INTEGER) -
        (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      (a.message.serverSequence ?? Number.MAX_SAFE_INTEGER) -
        (b.message.serverSequence ?? Number.MAX_SAFE_INTEGER) ||
      a.index - b.index
    );
  });
  const result = [...messages];
  for (const [index, slot] of slots.entries())
    result[slot] = positioned[index]!.message;
  // A pending request is explicitly newer than established legacy history,
  // even if that old history predates the serverSequence field. Once it has
  // an anchored reply, the shared turn ordering above keeps both together.
  const unboundPending = new Set(
    messages.filter(
      (message) =>
        message.role === "user" &&
        message.generalChatDispatch?.kind === "pending_user" &&
        !sequence(message.serverSequence) &&
        !messages.some(
          (candidate) => candidate.generalChat?.userMessageId === message.id,
        ),
    ),
  );
  return unboundPending.size
    ? [
        ...result.filter((message) => !unboundPending.has(message)),
        ...result.filter((message) => unboundPending.has(message)),
      ]
    : result;
}
