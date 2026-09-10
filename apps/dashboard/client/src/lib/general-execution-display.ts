import { orderExecutionTimeline } from "@shared/frontmind-general-execution";
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
> & {
  /** Presentation only: historical evidence remains visible without a live spinner. */
  animate?: boolean;
  /** Latest active phase/tool, including a non-animated confirmation wait. */
  isCurrent?: boolean;
};

const eventKey = (turnId: string, providerEventId: string) =>
  JSON.stringify([turnId, providerEventId]);

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
        ? [
            [
              eventKey(
                message.generalChat.turnId,
                message.generalChat.providerEventId,
              ),
              message,
            ] as const,
          ]
        : [],
    ),
  );
  const byTurn = new Map<string, GeneralExecutionEntry[]>();
  for (const entry of orderExecutionTimeline(execution.timeline)) {
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
  const activeUser = messages.findLast((message) => message.role === "user");
  for (const turn of byTurn.values()) {
    const lastLifecycle = turn.findLast((entry) => entry.kind === "status");
    const activeTurn = Boolean(
      running &&
        activeUser &&
        turn.some(
          (entry) =>
            entry.userMessageId === activeUser.id ||
            (activeUser.serverSequence !== undefined &&
              entry.userSequence === activeUser.serverSequence),
        ) &&
        !(
          lastLifecycle?.kind === "status" &&
          ["ended", "cancelled", "error"].includes(lastLifecycle.status)
        ),
    );
    const nextAnchors = new Map<string, MessageAnchor>();
    let next: MessageAnchor | undefined;
    for (let index = turn.length - 1; index >= 0; index--) {
      const entry = turn[index]!;
      if (entry.kind === "message")
        next =
          messageByEvent.get(eventKey(entry.turnId, entry.providerEventId)) ??
          next;
      else if (next) nextAnchors.set(entry.id, next);
    }
    let previous: MessageAnchor | undefined;
    const lastEntryId = turn.at(-1)?.id;
    for (const rawEntry of turn) {
      if (rawEntry.kind === "message") {
        previous =
          messageByEvent.get(
            eventKey(rawEntry.turnId, rawEntry.providerEventId),
          ) ?? previous;
        continue;
      }
      const entry: ExecutionDisplayEntry =
        rawEntry.kind === "tool"
          ? {
              ...rawEntry,
              ...(!activeTurn && rawEntry.status === "running"
                ? { status: "unconfirmed" as const }
                : {}),
              animate: activeTurn && rawEntry.status === "running",
              isCurrent:
                activeTurn && ["running", "waiting"].includes(rawEntry.status),
            }
          : {
              ...rawEntry,
              isCurrent: activeTurn && rawEntry.id === lastEntryId,
              animate:
                activeTurn &&
                rawEntry.id === lastEntryId &&
                ["thinking", "running", "rescheduling", "retrying"].includes(
                  rawEntry.status,
                ),
            };
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
