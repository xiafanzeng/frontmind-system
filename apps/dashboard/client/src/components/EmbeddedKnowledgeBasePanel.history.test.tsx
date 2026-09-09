import { useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationContextProvider,
  useConversation,
  type Conversation,
} from "@/contexts/ConversationContext";

const api = vi.hoisted(() => ({
  progress: vi.fn(),
  refresh: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 7, role: "user" } }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        knowledge: { setData: api.setData },
        knowledgeProgress: { setData: api.setData, invalidate: api.invalidate },
      },
    }),
    workspace: {
      knowledge: {
        useQuery: () => ({ data: { snapshot: null }, refetch: api.refresh }),
      },
      knowledgeProgress: {
        useQuery: (input?: { conversationId: string }) => ({
          data: { progress: api.progress(input?.conversationId) },
          isLoading: false,
          isError: false,
          refetch: api.refresh,
        }),
      },
      knowledgeReset: {
        status: {
          useQuery: () => ({
            data: { revision: 0, hasKnowledge: true, canReset: false },
            refetch: api.refresh,
          }),
        },
        reset: {
          useMutation: () => ({ mutateAsync: api.refresh, isPending: false }),
        },
      },
    },
  },
}));
vi.mock("@/components/KnowledgeWorkspaceStatus", () => ({
  default: () => null,
}));
vi.mock("@/components/KnowledgeNodeWorkspace", () => ({
  default: ({ conversationId, progress }: any) => (
    <output aria-label="nodes">
      {conversationId}:{progress?.build.conversationId ?? "empty"}
    </output>
  ),
}));
vi.mock("@/components/AgentWorkbenchShell", () => ({
  AgentWorkbenchShell: ({
    conversation,
    result,
    taskKey,
  }: {
    conversation: ReactNode;
    result: ReactNode;
    taskKey: string;
  }) => (
    <section data-testid="shell" data-task={taskKey}>
      {conversation}
      {result}
    </section>
  ),
}));
vi.mock("@/pages/Home", () => ({
  default: ({ knowledgeBaseProgress }: any) => {
    const { activeConversation } = useConversation();
    return (
      <output aria-label="conversation">
        {activeConversation?.id}:
        {knowledgeBaseProgress?.build.conversationId ?? "empty"}
      </output>
    );
  },
}));
import EmbeddedKnowledgeBasePanel from "./EmbeddedKnowledgeBasePanel";

const conversation = (id: string): Conversation => ({
  id,
  title: id,
  workbenchAgentId: "knowledge",
  messages: [],
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});
const rows = [
  conversation("historical"),
  conversation("latest"),
  conversation("fresh"),
];
const progress = (id: string) => ({
  build: { id: `build-${id}`, conversationId: id, revision: 1, updatedAt: 1 },
  branches: [],
  packageAllowed: false,
});
function Workspace() {
  const [activeId, setActive] = useState("latest");
  const value = {
    state: { conversations: rows, activeConversationId: activeId },
    activeConversation: rows.find((item) => item.id === activeId),
    hydrated: true,
    loading: false,
    syncError: null,
    workbenchScopeKey: "owner-7:project-1",
    setActive,
    createConversation: () => "fresh",
    refreshConversations: api.refresh,
    refreshConversationsAfterDiscard: api.refresh,
    discardKnowledgeBaseConversationsLocally: () => [],
    clearSyncError: () => {},
    updateStatus: () => {},
  } as any;
  return (
    <ConversationContextProvider value={value}>
      <EmbeddedKnowledgeBasePanel
        page="build"
        mode="workspace"
        workbench
        projectId="project-1"
        onPageChange={() => {}}
      />
    </ConversationContextProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  api.refresh.mockResolvedValue(undefined);
  const historical = progress("historical");
  const latest = progress("latest");
  api.progress.mockImplementation((id?: string) =>
    id === "fresh" ? null : id === "historical" ? historical : latest,
  );
  window.history.replaceState({}, "", "/?workbenchTask=historical");
});
afterEach(() => window.history.replaceState({}, "", "/"));

describe("knowledge history restoration", () => {
  it("restores the historical conversation and its nodes together when a newer build exists", async () => {
    render(<Workspace />);
    await waitFor(() =>
      expect(screen.getByLabelText("conversation")).toHaveTextContent(
        /^historical:historical$/,
      ),
    );
    expect(screen.getByLabelText("nodes")).toHaveTextContent(
      /^historical:historical$/,
    );
    expect(screen.getByTestId("shell")).toHaveAttribute(
      "data-task",
      "historical",
    );
  });
  it("leaves historical selection behind when a failed build creates a fresh task", async () => {
    render(<Workspace />);
    await waitFor(() =>
      expect(screen.getByLabelText("conversation")).toHaveTextContent(
        /^historical:historical$/,
      ),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("frontmind:new-knowledge-base-build", {
          detail: { conversationId: "fresh" },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByLabelText("conversation")).toHaveTextContent(
        /^fresh:empty$/,
      ),
    );
    expect(screen.getByLabelText("nodes")).toHaveTextContent(/^fresh:empty$/);
    expect(screen.getByTestId("shell")).toHaveAttribute("data-task", "fresh");
    expect(
      new URLSearchParams(window.location.search).get("workbenchTask"),
    ).toBe("fresh");
  });
});
