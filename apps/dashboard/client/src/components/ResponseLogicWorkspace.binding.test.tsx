import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ current: {} as any }));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => runtime.current,
}));
vi.mock("@/pages/Home", () => ({
  default: () => <div>专属应答输入区</div>,
}));

import { RealResponseLogicDialogue } from "./ResponseLogicWorkspace";

describe("response conversation binding recovery", () => {
  it("preserves the created conversation after a binding failure and retries that same binding", async () => {
    const saveBinding = vi
      .fn()
      .mockRejectedValueOnce(new Error("保存服务暂不可用"))
      .mockResolvedValueOnce(undefined);
    const create = vi.fn();
    const updateStatus = vi.fn();
    const updateTitle = vi.fn();
    function Harness() {
      const [conversation, setConversation] = useState<any>();
      const [boundId, setBoundId] = useState<string>();
      runtime.current = {
        state: { conversations: conversation ? [conversation] : [] },
        activeConversation: conversation,
        hydrated: true,
        createConversation: (options: unknown) => {
          create(options);
          setConversation({
            id: "binding-conversation",
            messages: [],
            status: "idle",
          });
          return "binding-conversation";
        },
        setActive: vi.fn(),
        updateAssistantMessages: vi.fn(),
        updateStatus,
        updateTitle,
      };
      return (
        <RealResponseLogicDialogue
          workbench
          group={{
            id: "industry",
            title: "行业",
            subtitle: "",
            tone: "blue",
            questions: [],
          }}
          question={{
            id: "question-1",
            question: "如何验证交付能力？",
            intent: "",
            summary: "",
          }}
          draft={{} as any}
          conversationId={boundId}
          recordsLoading={false}
          recordsReady
          onRetryRecords={vi.fn()}
          readOnly={false}
          onConversationIdChange={async (id) => {
            // The editor remembers the local draft before the server confirms it.
            setBoundId(id);
            await saveBinding(id);
          }}
          onLoadLatestReply={async () => "ignored"}
        />
      );
    }
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存服务暂不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("当前问题和草稿已保留");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        reuseEmpty: false,
        workbenchAgentId: "response-logic",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "重新保存会话" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("专属应答输入区")).toBeInTheDocument();
    expect(saveBinding.mock.calls).toEqual([
      ["binding-conversation"],
      ["binding-conversation"],
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
