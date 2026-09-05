import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
const auth = vi.hoisted(() => ({
  user: { id: 42, role: "user", adminAccessLevel: null as string | null },
  loading: false,
  error: null,
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => auth }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/contexts/ConversationContext", () => ({
  ConversationProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("@/hooks/useResumePolling", () => ({
  useResumePolling: () => undefined,
}));
vi.mock("@/monitoring/Workspace", () => ({
  default: () => <div>CONNECTED_MODULE</div>,
}));
vi.mock("@/pages/UserDashboard", () => ({
  default: () => <div>CUSTOMER_HOME</div>,
}));
vi.mock("@/pages/AdminDashboard", () => ({
  default: () => <div>ADMIN_HOME</div>,
}));
vi.mock("@/pages/DeliveryMemberDashboard", () => ({
  default: () => <div>DELIVERY_HOME</div>,
}));
import App from "@/App";
function open(path: string) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <App />
    </Router>,
  );
}
beforeEach(() => {
  auth.user = { id: 42, role: "user", adminAccessLevel: null };
});
describe("Dashboard module routes", () => {
  it.each([
    "/monitoring-system",
    "/monitoring-system/settings",
    "/monitoring-system/m1/runs/r1",
    "/publishing",
    "/publishing/articles/a1",
  ])("opens the authenticated business module at %s", async (path) => {
    open(path);
    expect(await screen.findByText("CONNECTED_MODULE")).toBeInTheDocument();
  });
  it("denies customers access to monitoring administration", async () => {
    open("/admin/monitoring/accounts");
    expect(await screen.findByText("CUSTOMER_HOME")).toBeInTheDocument();
    expect(screen.queryByText("CONNECTED_MODULE")).not.toBeInTheDocument();
  });
  it.each([
    "/admin/monitoring",
    "/admin/monitoring/operations/runs/r1",
    "/admin/monitoring/media-publishing/reconciliation",
  ])("allows system administrators at %s", async (path) => {
    auth.user = { id: 1, role: "admin", adminAccessLevel: "system_admin" };
    open(path);
    expect(await screen.findByText("CONNECTED_MODULE")).toBeInTheDocument();
  });
  it("denies delivery members access to the customer publishing wallet", async () => {
    auth.user.role = "delivery_member";
    open("/publishing/media");
    expect(await screen.findByText("DELIVERY_HOME")).toBeInTheDocument();
    expect(screen.queryByText("CONNECTED_MODULE")).not.toBeInTheDocument();
  });
});
