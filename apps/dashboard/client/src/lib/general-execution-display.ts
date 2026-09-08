import type {
  GeneralExecutionDto,
  GeneralExecutionEntry,
} from "@shared/frontmind-general-execution";

type MessageAnchor = {
  id: string;
  role: string;
  serverSequence?: number;
  generalChat?: { turnId: string; providerEventId: string };
};
export type ExecutionDisplayEntry = Exclude<
  GeneralExecutionEntry,
  { kind: "message" }
>;

/** Keep actual conversation ordering; native rank places activity around public replies. */
export function generalExecutionSlots(
  messages: readonly MessageAnchor[],
  execution?: GeneralExecutionDto,
  running = false,
) {
  const before = new Map<string, ExecutionDisplayEntry[]>();
  const after = new Map<string, ExecutionDisplayEntry[]>();
  if (!execution) return { before, after };
  const messageByEvent = new Map(
    messages.flatMap((message) =>
      message.generalChat
        ? [[message.generalChat.providerEventId, message] as const]
        : [],
    ),
  );
  const byTurn = new Map<string, GeneralExecutionEntry[]>();
  for (const entry of execution.timeline) {
    const items = byTurn.get(entry.turnId) ?? [];
    items.push(entry);
    byTurn.set(entry.turnId, items);
  }
  const usersBySequence = new Map(
    messages
      .filter(
        (message) =>
          message.role === "user" && message.serverSequence !== undefined,
      )
      .map((message) => [message.serverSequence!, message]),
  );
  const usersById = new Map(
    messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );
  for (const turn of byTurn.values()) {
    const nextAnchors = new Map<string, MessageAnchor>();
    let next: MessageAnchor | undefined;
    for (let index = turn.length - 1; index >= 0; index--) {
      const entry = turn[index]!;
      if (entry.kind === "message")
        next = messageByEvent.get(entry.providerEventId) ?? next;
      else if (next) nextAnchors.set(entry.id, next);
    }
    let previous: MessageAnchor | undefined;
    const lastRank = turn.at(-1)?.rank ?? -1;
    for (const rawEntry of turn) {
      if (rawEntry.kind === "message") {
        previous = messageByEvent.get(rawEntry.providerEventId) ?? previous;
        continue;
      }
      const entry: ExecutionDisplayEntry =
        !running && rawEntry.kind === "tool" && rawEntry.status === "running"
          ? { ...rawEntry, status: "unconfirmed" }
          : rawEntry;
      if (
        entry.kind === "status" &&
        (entry.rank < lastRank ||
          ["ended", "cancelled"].includes(entry.status) ||
          (!running &&
            ["thinking", "running", "rescheduling", "retrying"].includes(entry.status)))
      )
        continue;
      const next = nextAnchors.get(entry.id);
      const anchor =
        next ??
        previous ??
        usersBySequence.get(entry.userSequence) ??
        (entry.userMessageId ? usersById.get(entry.userMessageId) : undefined);
      if (!anchor) continue;
      const slots = next ? before : after;
      const items = slots.get(anchor.id) ?? [];
      items.push(entry);
      slots.set(anchor.id, items);
    }
  }
  return { before, after };
}
