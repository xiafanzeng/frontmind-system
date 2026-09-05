import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ClipboardList, Home, UserCog } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));

vi.mock("wouter", () => ({
  useLocation: () => ["/delivery/workbench", vi.fn()],
  Link: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: 31,
      role: "delivery_member",
      username: "engineer",
      displayName: "工程师",
    },
    logout,
  }),
}));

import PortalShell, { type PortalNavItem } from "./PortalShell";

const STORAGE_KEY = "frontmind:portal-sidebar-state";

function renderShell() {
  return render(
    <PortalShell
      eyebrow="客户交付"
      title="客户管理"
      navItems={[
        {
          label: "客户管理",
          href: "/workspace",
          icon: Home,
          group: "交付管理",
        },
        {
          label: "通用智能体",
          href: "/delivery/agent",
          icon: UserCog,
          group: "工具",
        },
      ]}
    >
      <div>工作区内容</div>
    </PortalShell>,
  );
}

const fullscreenNavigationCases: Array<{
  actor: string;
  navItems: PortalNavItem[];
  expectedLabel: string;
}> = [
  {
    actor: "工程师",
    navItems: [
      {
        label: "客户工作台",
        href: "/delivery/workbench",
        icon: ClipboardList,
      },
    ],
    expectedLabel: "客户工作台",
  },
  {
    actor: "管理员",
    navItems: [
      {
        label: "客户交付工作台",
        href: "/admin/workspace",
        icon: UserCog,
      },
    ],
    expectedLabel: "客户交付工作台",
  },
];

describe("PortalShell fullscreen layout", () => {
  it.each(fullscreenNavigationCases)(
    "keeps the $actor navigation beside a full-height workspace",
    ({ navItems, expectedLabel }) => {
      const { container } = render(
        <PortalShell
          mode="fullscreen"
          eyebrow="不应显示的标准页眉"
          title="不应显示的标准标题"
          navItems={navItems}
        >
          <section aria-label="全屏客户看板">客户看板内容</section>
        </PortalShell>,
      );

      const shell = container.firstElementChild;
      const aside = screen.getByRole("complementary");
      const main = screen.getByRole("main");

      expect(shell).toHaveClass(
        "lg:grid",
        "lg:grid-cols-[220px_minmax(0,1fr)]",
        "h-[100dvh]",
        "overflow-hidden",
      );
      expect(aside).toBeInTheDocument();
      expect(aside).toContainElement(
        screen.getByRole("link", { name: expectedLabel }),
      );
      expect(main).toHaveClass("h-[100dvh]", "min-w-0", "overflow-hidden");
      expect(main).toContainElement(
        screen.getByRole("region", { name: "全屏客户看板" }),
      );
      expect(container.querySelector("header")).not.toBeInTheDocument();
      expect(screen.queryByText("不应显示的标准页眉")).not.toBeInTheDocument();
      expect(screen.queryByText("不应显示的标准标题")).not.toBeInTheDocument();
    },
  );
});

describe("PortalShell sidebar collapse", () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses every shared portal sidebar and restores the choice after navigation", () => {
    const first = renderShell();
    const shell = screen.getByRole("complementary", {
      name: "工作台侧栏",
    }).parentElement;

    expect(
      screen.getByRole("button", { name: "收起侧栏" }),
    ).toBeInTheDocument();
    expect(shell).toHaveClass("lg:grid-cols-[220px_minmax(0,1fr)]");

    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));

    expect(
      screen.getByRole("button", { name: "展开侧栏" }),
    ).toBeInTheDocument();
    expect(shell).toHaveClass("lg:grid-cols-[76px_minmax(0,1fr)]");
    expect(
      within(
        screen.getByRole("navigation", { name: "管理中心导航" }),
      ).getByText("客户管理"),
    ).toHaveClass("lg:hidden");
    expect(localStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "collapsed");

    first.unmount();
    vi.mocked(localStorage.getItem).mockReturnValue("collapsed");
    renderShell();

    expect(
      screen.getByRole("button", { name: "展开侧栏" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(
      screen.getByRole("button", { name: "收起侧栏" }),
    ).toBeInTheDocument();
    expect(localStorage.setItem).toHaveBeenLastCalledWith(
      STORAGE_KEY,
      "expanded",
    );
  });

  it("keeps the collapse control usable when browser storage is unavailable", () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("storage blocked");
    });

    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));

    expect(
      screen.getByRole("button", { name: "展开侧栏" }),
    ).toBeInTheDocument();
  });

  it("keeps the closed mobile drawer out of the keyboard focus path", () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "切换导航" });
    const sidebar = screen.getByRole("complementary", {
      name: "工作台侧栏",
      hidden: true,
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", sidebar.id);
    expect(sidebar).toHaveClass("invisible", "lg:visible");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).toHaveClass("visible", "translate-x-0");
  });

  it("matches the compact customer sidebar while preserving mobile targets", () => {
    const { container } = renderShell();
    const shell = container.firstElementChild;
    const sidebar = screen.getByRole("complementary", {
      name: "工作台侧栏",
      hidden: true,
    });
    const logo = screen.getByRole("img", { name: "FrontMind", hidden: true });
    const navigation = screen.getByRole("navigation", {
      name: "管理中心导航",
      hidden: true,
    });
    const customerLink = screen.getByRole("link", {
      name: "客户管理",
      hidden: true,
    });

    expect(shell).toHaveClass("lg:grid-cols-[220px_minmax(0,1fr)]");
    expect(sidebar).toHaveClass(
      "w-[220px]",
      "max-w-[calc(100vw-48px)]",
      "px-4",
      "pb-[18px]",
      "pt-[22px]",
    );
    expect(logo).toHaveClass(
      "h-auto",
      "w-[152px]",
      "max-w-full",
      "md:w-[164px]",
    );
    expect(logo.parentElement).toHaveClass("px-2", "pb-4", "pt-1.5");
    expect(navigation).toHaveClass("space-y-1");
    expect(navigation.parentElement).toHaveClass("mt-4", "p-3");
    expect(screen.getByText("交付管理")).toHaveClass("pb-1", "pt-0");
    expect(screen.getByText("工具")).toHaveClass("pb-1", "pt-2.5");
    expect(customerLink).toHaveClass(
      "min-h-10",
      "px-2.5",
      "py-2",
      "lg:min-h-[34px]",
      "lg:py-1.5",
    );

    fireEvent.click(screen.getByRole("button", { name: "切换导航" }));
    expect(screen.getByRole("button", { name: "关闭侧栏" })).toHaveClass(
      "min-h-10",
    );
  });
});
