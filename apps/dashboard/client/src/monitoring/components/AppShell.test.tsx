import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import AppShell from "./AppShell";

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { role: "admin", adminAccessLevel: "system_admin" },
    logout: vi.fn(),
  }),
}));
vi.mock("@/pages/AdminDashboard", () => ({
  getAdminNav: () => [
    { href: "/", label: "API与人员管理", icon: () => null, group: "运营" },
    {
      href: "/admin/monitoring/accounts",
      label: "账号与余额",
      icon: () => null,
      group: "问题监控管理",
    },
  ],
}));

describe("monitoring module shell ownership", () => {
  it("renders customer business content without replacing the parent Dashboard sidebar", () => {
    const { hook } = memoryLocation({ path: "/publishing/articles" });
    const { container } = render(
      <Router hook={hook}>
        <AppShell user={{} as never} projects={[]} publishingEnabled>
          <div>真实稿件页面</div>
        </AppShell>
      </Router>,
    );
    expect(screen.getByText("真实稿件页面")).toBeInTheDocument();
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByRole("link", { name: /媒体发布余额/ })).toHaveAttribute(
      "href",
      "/monitoring-system/settings?wallet=media_publishing",
    );
  });
  it("uses the existing complete administrator navigation for module pages", () => {
    const { hook } = memoryLocation({ path: "/admin/monitoring/accounts" });
    const { container } = render(
      <Router hook={hook}>
        <AppShell user={{} as never} projects={[]}>
          <div>真实账户页面</div>
        </AppShell>
      </Router>,
    );
    expect(container.querySelectorAll("aside")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "API与人员管理" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账号与余额" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
