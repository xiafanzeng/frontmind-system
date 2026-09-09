import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ current: {} as any }));
const persistence = vi.hoisted(() => ({
  records: [] as any[],
  save: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ workspace: { responseLogic: { setData: vi.fn() } } }),
    workspace: {
      responseLogic: {
        useQuery: () => ({
          data: { records: persistence.records },
          isSuccess: true,
          refetch: persistence.refresh,
        }),
      },
      saveResponseLogic: {
        useMutation: () => ({ mutateAsync: persistence.save }),
      },
    },
  },
}));
vi.mock("@/components/AgentWorkbenchShell", () => ({
  AgentWorkbenchShell: ({ main }: any) => <main>{main}</main>,
}));
vi.mock("@/components/QuestionMaintenanceRequestDialog", () => ({
  default: () => null,
}));
vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => runtime.current,
}));
vi.mock("@/pages/Home", () => ({
  default: () => <div>专属应答输入区</div>,
}));

import ResponseLogicWorkspace, {
  RealResponseLogicDialogue,
  type IntentQuestionGroup,
} from "./ResponseLogicWorkspace";

const groups = [
  {
    id: "industry",
    title: "行业",
    subtitle: "",
    tone: "blue",
    questions: [
      {
        id: "question-1",
        question: "如何验证交付能力？",
        intent: "",
        summary: "",
      },
    ],
  },
] satisfies IntentQuestionGroup[];
const savedRecord = () => ({
  id: "record-1",
  questionId: "question-1",
  groupId: "industry",
  groupTitle: "行业",
  question: "如何验证交付能力？",
  intent: "",
  summary: "",
  conversationId: "saved-conversation",
  revision: 2,
  version: 0,
  createdAt: 1,
  updatedAt: 2,
  draft: {
    concern: "",
    conclusion: "",
    facts: "",
    pending: "",
    boundaries: "",
    references: "",
    images: [],
    attachments: [],
  },
});
function installConversation(id: string) {
  const conversation = { id, title: "应答任务", messages: [], status: "idle" };
  runtime.current = {
    state: { conversations: [conversation] },
    activeConversation: conversation,
    hydrated: true,
    createConversation: vi.fn(() => id),
    setActive: vi.fn(),
    updateAssistantMessages: vi.fn(),
    updateStatus: vi.fn(),
    updateTitle: vi.fn(),
    refreshConversations: vi.fn(async () => {}),
    restoreResponseLogicConversation: vi.fn(async () => id),
  };
}
beforeEach(() => {
  persistence.records = [];
  persistence.save.mockReset();
  persistence.refresh.mockReset().mockImplementation(async () => ({
    data: { records: persistence.records },
  }));
  window.history.replaceState({}, "", "/?view=response-logic");
});
afterEach(() => vi.clearAllMocks());

describe("response conversation binding recovery", () => {
  it("reopens the same persisted task repeatedly without saving or advancing its revision", async () => {
    const record = savedRecord();
    persistence.records = [record];
    installConversation(record.conversationId);
    runtime.current.createConversation.mockReturnValue(
      "unwanted-new-conversation",
    );
    const workspace = () => (
      <ResponseLogicWorkspace
        preview={false}
        workbench
        initialQuestionId="question-1"
        questionGroups={groups}
      />
    );
    const first = render(workspace());
    expect(await screen.findByText("专属应答输入区")).toBeInTheDocument();
    first.unmount();
    render(workspace());
    expect(await screen.findByText("专属应答输入区")).toBeInTheDocument();
    expect(persistence.save).not.toHaveBeenCalled();
    expect(runtime.current.createConversation).not.toHaveBeenCalled();
    expect(record.revision).toBe(2);
  });

  it("still persists a genuinely new binding with the existing question identity", async () => {
    installConversation("new-conversation");
    persistence.save.mockResolvedValue({
      record: {
        ...savedRecord(),
        conversationId: "new-conversation",
        revision: 1,
      },
    });
    render(
      <ResponseLogicWorkspace
        preview={false}
        workbench
        initialQuestionId="question-1"
        questionGroups={groups}
      />,
    );
    await waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(1));
    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "question-1",
        groupId: "industry",
        conversationId: "new-conversation",
        expectedRevision: 0,
        publish: false,
      }),
    );
  });

  it("restores an unstarted persisted task with its exact saved ID without rebinding or advancing revision", async () => {
    const record = savedRecord();
    persistence.records = [record];
    installConversation("another-conversation");
    runtime.current.restoreResponseLogicConversation.mockImplementation(
      async (id: string, _title: string, verify: () => Promise<boolean>) => {
        expect(await verify()).toBe(true);
        const restored = {
          id,
          title: "原应答任务",
          messages: [],
          status: "idle",
        };
        runtime.current.state.conversations.push(restored);
        runtime.current.activeConversation = restored;
        return id;
      },
    );
    render(
      <ResponseLogicWorkspace
        preview={false}
        workbench
        initialQuestionId="question-1"
        questionGroups={groups}
      />,
    );
    expect(await screen.findByText("专属应答输入区")).toBeInTheDocument();
    expect(
      runtime.current.restoreResponseLogicConversation,
    ).toHaveBeenCalledTimes(1);
    expect(
      runtime.current.restoreResponseLogicConversation,
    ).toHaveBeenCalledWith(
      "saved-conversation",
      "应答-如何验证交付能力？",
      expect.any(Function),
    );
    expect(
      runtime.current.state.conversations.map((item: any) => item.id),
    ).toEqual(["another-conversation", "saved-conversation"]);
    expect(persistence.save).not.toHaveBeenCalled();
    expect(runtime.current.createConversation).not.toHaveBeenCalled();
    expect(record.revision).toBe(2);
    expect(record.conversationId).toBe("saved-conversation");
  });

  it("keeps a failed exact-ID restoration retryable without creating a new task", async () => {
    const record = savedRecord();
    persistence.records = [record];
    installConversation("another-conversation");
    runtime.current.restoreResponseLogicConversation
      .mockRejectedValueOnce(new Error("读取服务暂不可用"))
      .mockImplementationOnce(async (id: string) => {
        const restored = {
          id,
          title: "原应答任务",
          messages: [],
          status: "idle",
        };
        runtime.current.state.conversations.push(restored);
        runtime.current.activeConversation = restored;
        return id;
      });
    render(
      <ResponseLogicWorkspace
        preview={false}
        workbench
        initialQuestionId="question-1"
        questionGroups={groups}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "读取服务暂不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("已有草稿保持不变");
    expect(
      runtime.current.restoreResponseLogicConversation,
    ).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新载入会话" }));
    expect(await screen.findByText("专属应答输入区")).toBeInTheDocument();
    expect(runtime.current.restoreResponseLogicConversation.mock.calls).toEqual(
      [
        ["saved-conversation", "应答-如何验证交付能力？", expect.any(Function)],
        ["saved-conversation", "应答-如何验证交付能力？", expect.any(Function)],
      ],
    );
    expect(persistence.save).not.toHaveBeenCalled();
    expect(runtime.current.createConversation).not.toHaveBeenCalled();
    expect(record.revision).toBe(2);
  });

  it("reloads missing historical conversation snapshots without synthesizing an empty task", async () => {
    persistence.records = [
      { ...savedRecord(), lastTaskId: "prior-dedicated-task" },
    ];
    installConversation("another-conversation");
    render(
      <ResponseLogicWorkspace
        preview={false}
        workbench
        initialQuestionId="question-1"
        questionGroups={groups}
      />,
    );
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("已绑定的应答会话尚未载入");
    expect(failure).toHaveClass("rl-workbench-gate");
    expect(failure.querySelector(".workbench-reading-column")).not.toBeNull();
    expect(persistence.records[0].conversationId).toBe("saved-conversation");
    expect(persistence.records[0].revision).toBe(2);
    expect(persistence.save).not.toHaveBeenCalled();
    expect(runtime.current.createConversation).not.toHaveBeenCalled();
    expect(
      runtime.current.restoreResponseLogicConversation,
    ).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新载入会话" }));
    expect(runtime.current.refreshConversations).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lastTaskId: "task-started-elsewhere" },
    { confirmed: { version: 1 } },
    { conversationId: "replacement-from-server" },
  ])(
    "revalidates the binding before materializing a missing empty task: %j",
    async (change) => {
      const record = savedRecord();
      persistence.records = [record];
      persistence.refresh.mockResolvedValue({
        data: { records: [{ ...record, ...change }] },
      });
      installConversation("another-conversation");
      runtime.current.restoreResponseLogicConversation.mockImplementation(
        async (_id: string, _title: string, verify: () => Promise<boolean>) => {
          expect(await verify()).toBe(false);
          throw new Error("当前问题绑定已更新，请重新载入");
        },
      );
      render(
        <ResponseLogicWorkspace
          preview={false}
          workbench
          initialQuestionId="question-1"
          questionGroups={groups}
        />,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "当前问题绑定已更新",
      );
      expect(
        runtime.current.state.conversations.map((item: any) => item.id),
      ).toEqual(["another-conversation"]);
      expect(persistence.save).not.toHaveBeenCalled();
      expect(runtime.current.createConversation).not.toHaveBeenCalled();
      expect(record.revision).toBe(2);
    },
  );

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
