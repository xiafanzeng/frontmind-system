import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  useLocation: () => ["/delivery/tools", vi.fn()],
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 31,
      role: "delivery_member",
      username: "engineer",
      displayName: "工程师",
    },
  }),
}));

vi.mock("@/hooks/useMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    state: { conversations: [] },
    activeConversation: null,
    createConversation: vi.fn(),
    setActive: vi.fn(),
    deleteConversation: vi.fn(),
  }),
}));

import Sidebar from "./Sidebar";

describe("Sidebar engineer settings visibility", () => {
  it("keeps new conversations available while removing the credential settings entry", () => {
    render(
      <Sidebar
        collapsed={false}
        onToggle={vi.fn()}
        onOpenSettings={vi.fn()}
        embedded
        hidePortalNavigation
        showAccountMenu={false}
        showSettings={false}
      />,
    );

    expect(screen.getByText("新内容流程")).toBeInTheDocument();
    expect(screen.queryByText("API Key 与积分")).not.toBeInTheDocument();
    expect(screen.queryByText("设置")).not.toBeInTheDocument();
  });
});
