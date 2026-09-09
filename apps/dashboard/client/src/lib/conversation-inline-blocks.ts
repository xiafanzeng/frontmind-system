import type { ReactNode } from "react";
import type { LocalMessage } from "@/contexts/ConversationContext";

export type ConversationInlineBlock = {
  id: string;
  anchor:
    | { kind: "initial" }
    | { kind: "message"; messageId: string }
    | { kind: "turn"; turnId: string };
  content: ReactNode;
  placement?: "before" | "after";
};

/** Anchor only to an authoritative message/turn identity, never the latest reply. */
export function conversationInlineSlots(
  messages: LocalMessage[],
  blocks: ConversationInlineBlock[] = [],
) {
  const initial: ConversationInlineBlock[] = [];
  const after = new Map<string, ConversationInlineBlock[]>();
  const before = new Map<string, ConversationInlineBlock[]>();
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    const anchor = block.anchor;
    if (anchor.kind === "initial") {
      initial.push(block);
      continue;
    }
    const message =
      anchor.kind === "message"
        ? messages.find((item) => item.id === anchor.messageId)
        : [...messages]
            .reverse()
            .find(
              (item) =>
                item.role === "assistant" &&
                (item.generalChat?.turnId === anchor.turnId ||
                  item.knowledgeBase?.turnId === anchor.turnId),
            );
    if (!message) continue;
    const slots = block.placement === "before" ? before : after;
    slots.set(message.id, [...(slots.get(message.id) ?? []), block]);
  }
  return { initial, before, after };
}
