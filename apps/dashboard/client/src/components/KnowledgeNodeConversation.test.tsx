import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LocalMessage } from "@/contexts/ConversationContext";
import KnowledgePublicExecution from "./KnowledgePublicExecution";
import KnowledgeNodeConversation, { knowledgeNodeConversationMessages } from "./KnowledgeNodeConversation";
const context = vi.hoisted(() => ({ activeConversation: null as any }));
vi.mock("@/contexts/ConversationContext", async (importOriginal) => ({ ...await importOriginal<typeof import("@/contexts/ConversationContext")>(), useConversation: () => ({ activeConversation: context.activeConversation, registerKnowledgeBaseConversation: vi.fn(), wakeKnowledgeBaseConversation: vi.fn() }) }));
vi.mock("./ChatInput", () => ({ default: () => null }));
const message = (
  id: string,
  timestamp: number,
  leafId: string | null,
  generation = 1,
): LocalMessage => ({
  id,
  role: "assistant",
  content: id,
  timestamp,
  knowledgeBase: { kind: "presentation", leafId, generation },
  stepGroups: [{ label: "provider secret" }] as any,
});
describe("node-local AI conversation", () => {
  it("includes only accepted-stage messages bound to the selected node and generation", () => {
    const messages = [
      message("initial research", 100, null),
      message("first draft", 200, "1.1"),
      message("edit for selected node", 400, "1.1"),
      message("other node", 500, "1.2"),
      message("old generation", 500, "1.1", 0),
    ];
    const visible = knowledgeNodeConversationMessages(
      messages,
      "1.1",
      1,
      new Date(300).toISOString(),
      new Set(messages.map((item) => item.id)),
    );
    expect(visible.map((item) => item.id)).toEqual(["edit for selected node"]);
    expect(visible[0]).not.toHaveProperty("stepGroups");
  });
  it("does not reintroduce legacy transcript and accepts only subsequent scoped messages", () => {
    const prior = message("legacy first transcript", 1, "1.1");
    const next = message("current local edit", 2, "1.1");
    expect(
      knowledgeNodeConversationMessages(
        [prior, next],
        "1.1",
        1,
        null,
        new Set([prior.id]),
      ).map((item) => item.id),
    ).toEqual([next.id]);
  });
  it("keeps a fresh local user request visible while its authoritative node receipt arrives", () => {
    const pending: LocalMessage = {
      id: "pending",
      role: "user",
      timestamp: 1000,
      content: "补充交付范围",
      knowledgeBase: { kind: "pending_user", clientRequestId: "request" },
    };
    expect(
      knowledgeNodeConversationMessages(
        [pending],
        "1.1",
        1,
        null,
        new Set(),
      ).map((item) => item.id),
    ).toEqual(["pending"]);
    expect(
      knowledgeNodeConversationMessages(
        [pending],
        "1.1",
        1,
        null,
        new Set(["pending"]),
      ),
    ).toEqual([]);
  });
  it("renders only allowlisted public execution states", () => {
    const { rerender } = render(
      <KnowledgePublicExecution
        phase="waiting_provider"
        operationState="waiting_output"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在研究资料并生成内容",
    );
    rerender(
      <KnowledgePublicExecution
        phase={"sensitive provider path" as any}
        operationState={"raw tool response" as any}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <KnowledgePublicExecution
        phase="waiting_provider"
        operationState="completed"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("本轮内容已处理完成");
  });
});

describe("node final content copy controls", () => {
  it("removes both whole-answer and code copy from intermediate summaries while retaining the accepted receipt", () => {
    context.activeConversation = { id: "conversation", messages: [
      { ...message("summary", 400, "1.1"), content: "```js\nconst progress = true;\n```", knowledgeBase: { kind: "presentation", turnId: "turn", leafId: "1.1", generation: 1 } },
      { ...message("answer", 500, "1.1"), content: "```js\nconst result = true;\n```", knowledgeBase: { kind: "presentation", turnId: "turn", leafId: "1.1", generation: 1, serverOwned: true, presentationKey: "verified", contentSha256: "verified" } },
    ], knowledgeBase: { generation: 1, operationState: "completed", leafId: "1.1", activeTurnId: "turn" } };
    const { container } = render(<KnowledgeNodeConversation conversationId="conversation" leafId="1.1" title="企业介绍" progress={{ workbench: { generation: 1, acceptedAt: new Date(300).toISOString() }, build: { currentLeafId: "1.1" } } as any} resetRevision={1} disabled={false} onDirtyChange={() => {}} />);
    const replies = container.querySelectorAll(".knowledge-node-conversation__assistant");
    expect(replies[0]?.querySelector("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: "复制完整回答" })).toHaveLength(1);
    expect(replies[1]?.querySelectorAll("button").length).toBeGreaterThan(1);
  });
});
