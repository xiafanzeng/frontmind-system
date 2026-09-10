import type { LocalMessage } from "@/contexts/ConversationContext";
import { orderExecutionTimeline, type GeneralExecutionDto } from "@shared/frontmind-general-execution";

/** Copy belongs to the returned answer of each turn, not each public commentary. */
export function finalReplyIds(messages: readonly LocalMessage[], execution?: GeneralExecutionDto, running = false) {
  const groups = new Map<string, { last?: LocalMessage; user: string }>();
  let user = "initial";
  for (const message of messages) {
    if (message.role === "user") { user = message.id; continue; }
    const key = message.generalChat?.turnId ?? message.knowledgeBase?.turnId ?? user;
    const group = groups.get(key) ?? { user };
    if (message.content?.trim() && !message.isStepsPlaceholder) group.last = message;
    groups.set(key, group);
  }
  const lifecycle = new Map<string, string>();
  for (const entry of orderExecutionTimeline(execution?.timeline ?? [])) {
    // Finishing a business step does not finish the assistant's reply.
    if (entry.kind === "status" && !entry.phase) lifecycle.set(entry.turnId, entry.status);
  }
  return new Set([...groups].flatMap(([turnId, group]) => {
    const settled = !running || group.user !== user || ["ended", "waiting", "error", "cancelled"].includes(lifecycle.get(turnId) ?? "");
    return settled && group.last ? [group.last.id] : [];
  }));
}
