import type { LocalMessage } from "@/contexts/ConversationContext";
import { orderExecutionTimeline, type GeneralExecutionDto } from "@shared/frontmind-general-execution";

/** The server marker wins. Legacy replies also need the owning turn to have ended. */
export function finalReplyIds(messages: readonly LocalMessage[], execution?: GeneralExecutionDto, running = false) {
  const groups = new Map<string, { last?: LocalMessage; final?: LocalMessage; user: string; marked: boolean }>();
  let user = "initial";
  for (const message of messages) {
    if (message.role === "user") { user = message.id; continue; }
    const key = message.generalChat?.turnId ?? message.knowledgeBase?.turnId ?? user;
    const group = groups.get(key) ?? { user, marked: false };
    const marker = message.knowledgeBase ? (message.knowledgeBase.kind === "completion" || (message.knowledgeBase.kind === "presentation" && message.knowledgeBase.serverOwned === true && !!message.knowledgeBase.presentationKey && !!message.knowledgeBase.contentSha256)) : message.generalChat?.isFinalAnswer;
    if (marker !== undefined) group.marked = true;
    if (message.content?.trim() && !message.isStepsPlaceholder) {
      if (marker === true) group.final = message;
      if (marker !== false) group.last = message;
    }
    groups.set(key, group);
  }
  const lifecycle = new Map<string, string>();
  for (const entry of orderExecutionTimeline(execution?.timeline ?? [])) {
    if (entry.kind === "status" && !entry.phase) lifecycle.set(entry.turnId, entry.status);
  }
  return new Set([...groups].flatMap(([turnId, group]) => {
    if (group.marked) return group.final ? [group.final.id] : [];
    const state = lifecycle.get(turnId);
    const settled = state ? ["ended", "waiting"].includes(state) : !running || group.user !== user;
    return settled && group.last ? [group.last.id] : [];
  }));
}
