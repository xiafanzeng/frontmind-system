import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationAgentProvider,
  ConversationContextProvider,
  ConversationPurposeProvider,
  conversationBelongsToAgent,
  mergeDirtyConversationHydration,
  useConversation,
  type Conversation,
} from "./ConversationContext";
import { initialWorkbenchTaskState } from "@shared/workbench-task";

const task = (id: string, agentId?: string, updatedAt = 1): Conversation => ({
  id,
  title: id,
  workbenchAgentId: agentId,
  messages: [],
  status: "idle",
  createdAt: 1,
  updatedAt,
});
afterEach(() => window.history.replaceState({}, "", "/"));

describe("subagent history", () => {
  it.each([
    ["enterprise-qa", "enterprise_qa"],
    ["content", "content_production"],
  ] as const)(
    "opens an empty %s handoff in its native composer without giving it a provider purpose",
    (agentId, purpose) => {
      const incoming = {
        ...task("incoming", agentId),
        workbench: initialWorkbenchTaskState(agentId),
      };
      const conversations = [incoming, task("general", "general")];
      const owner = {
        state: { conversations, activeConversationId: incoming.id },
        activeConversation: incoming,
        setActive: () => {},
        isKnowledgeBaseConversation: () => false,
        workbenchScopeKey: `native-handoff:${agentId}`,
      } as any;
      function Probe() {
        const { state } = useConversation();
        return (
          <output aria-label="history">
            {state.conversations.map((item) => item.id).join(",")}
          </output>
        );
      }
      const { rerender } = render(
        <ConversationContextProvider value={owner}>
          <ConversationPurposeProvider purpose={purpose}>
            <ConversationAgentProvider agentId={agentId}>
              <Probe />
            </ConversationAgentProvider>
          </ConversationPurposeProvider>
        </ConversationContextProvider>,
      );
      expect(screen.getByLabelText("history")).toHaveTextContent(/^incoming$/);
      expect(incoming.purpose).toBeUndefined();
      rerender(
        <ConversationContextProvider value={owner}>
          <ConversationPurposeProvider purpose="general">
            <Probe />
          </ConversationPurposeProvider>
        </ConversationContextProvider>,
      );
      expect(screen.getByLabelText("history")).toHaveTextContent(/^general$/);
    },
  );
  it("leaves unclassified legacy tasks in general history instead of guessing business ownership", () => {
    expect(
      conversationBelongsToAgent(task("媒体发布相关旧讨论"), "media"),
    ).toBe(false);
    expect(
      conversationBelongsToAgent(task("媒体发布相关旧讨论"), "general"),
    ).toBe(true);
    expect(
      conversationBelongsToAgent(
        { ...task("native"), purpose: "enterprise_qa" },
        "enterprise-qa",
      ),
    ).toBe(true);
    expect(
      conversationBelongsToAgent(
        { ...task("native"), executionKind: "response_logic" },
        "response-logic",
      ),
    ).toBe(true);
  });
  it("restores a scoped deep link, switches tasks, and remembers each agent independently", () => {
    const conversations = [
      task("media-a", "media", 1),
      task("media-b", "media", 2),
      task("articles-a", "articles", 3),
      task("legacy"),
    ];
    window.history.replaceState({}, "", "/?workbenchTask=media-a");
    function Probe() {
      const { activeConversation, state, setActive } = useConversation();
      return (
        <>
          <output aria-label="current">{activeConversation?.id}</output>
          <output aria-label="history">
            {state.conversations.map((item) => item.id).join(",")}
          </output>
          <button onClick={() => setActive("media-b")}>选择另一任务</button>
        </>
      );
    }
    function Workspace() {
      const [agent, setAgent] = useState<"media" | "articles">("media");
      const [id, setId] = useState("articles-a");
      return (
        <ConversationContextProvider
          value={
            {
              state: { conversations, activeConversationId: id },
              activeConversation: conversations.find((item) => item.id === id),
              setActive: setId,
              workbenchScopeKey: "owner-7:project-a",
              hydrated: true,
            } as any
          }
        >
          <button
            onClick={() =>
              setAgent((value) => (value === "media" ? "articles" : "media"))
            }
          >
            切换智能体
          </button>
          <ConversationAgentProvider agentId={agent}>
            <Probe />
          </ConversationAgentProvider>
        </ConversationContextProvider>
      );
    }
    render(<Workspace />);
    expect(screen.getByLabelText("current")).toHaveTextContent("media-a");
    expect(screen.getByLabelText("history")).toHaveTextContent(
      /^media-b,media-a$/,
    );
    fireEvent.click(screen.getByText("选择另一任务"));
    expect(screen.getByLabelText("current")).toHaveTextContent("media-b");
    fireEvent.click(screen.getByText("切换智能体"));
    expect(screen.getByLabelText("current")).toHaveTextContent("articles-a");
    fireEvent.click(screen.getByText("切换智能体"));
    expect(screen.getByLabelText("current")).toHaveTextContent("media-b");
  });
  it("uses the server's immutable identity when a dirty local snapshot has an old module tag", () => {
    const remote = {
      ...task("same", "media"),
      workbench: initialWorkbenchTaskState("media"),
    };
    const merged = mergeDirtyConversationHydration(
      { ...task("same", "publishing"), updatedAt: 99 },
      remote,
    );
    expect(merged.workbenchAgentId).toBe("media");
    expect(merged.workbench).toEqual(remote.workbench);
  });
});
