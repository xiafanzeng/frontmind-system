import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  panel: vi.fn(
    ({ page, preview }: { page: string; preview?: boolean }) => (
      <div data-testid="production-kb-panel">
        {page}:{String(Boolean(preview))}
      </div>
    ),
  ),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/components/EmbeddedKnowledgeBasePanel", () => ({
  default: mocks.panel,
}));
vi.mock("@/contexts/ConversationContext", () => ({
  ConversationProvider: ({ children }: { children: ReactNode }) =>
    children,
}));

import KnowledgeBaseProductionAcceptance from "./KnowledgeBaseProductionAcceptance";

describe("KnowledgeBaseProductionAcceptance", () => {
  beforeEach(() => {
    mocks.useAuth.mockReturnValue({
      loading: false,
      user: { id: 7, role: "user" },
    });
  });

  it("mounts the real knowledge-base panel without preview fixtures", () => {
    render(<KnowledgeBaseProductionAcceptance />);

    expect(screen.getByTestId("production-kb-panel")).toHaveTextContent(
      "build:false",
    );
    expect(screen.getByText(/生产契约验收/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "成品展示" }));
    expect(screen.getByTestId("production-kb-panel")).toHaveTextContent(
      "display:false",
    );
  });
});
