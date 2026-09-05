import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { LucideIcon } from "lucide-react";
import { LogOut, Menu, X } from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";

export type PortalNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  group?: string;
  activePrefixes?: string[];
  external?: boolean;
  newWindow?: boolean;
};

type PortalShellProps = {
  eyebrow: string;
  title: string;
  navItems: PortalNavItem[];
  children: ReactNode;
  toolbar?: ReactNode;
  accountLabel?: string;
  roleLabel?: string;
  mode?: "standard" | "fullscreen";
};

export default function PortalShell({
  eyebrow,
  title,
  navItems,
  children,
  toolbar,
  accountLabel,
  roleLabel,
  mode = "standard",
}: PortalShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const activeHref = navItems
    .filter(
      (item) =>
        !item.external &&
        (location === item.href ||
          (item.href !== "/" && location.startsWith(`${item.href}/`)) ||
          item.activePrefixes?.some(
            (prefix) =>
              location === prefix || location.startsWith(`${prefix}/`),
          )),
    )
    .sort((left, right) => {
      const leftLength = Math.max(
        left.href.length,
        ...(left.activePrefixes ?? []).map((prefix) => prefix.length),
      );
      const rightLength = Math.max(
        right.href.length,
        ...(right.activePrefixes ?? []).map((prefix) => prefix.length),
      );
      return rightLength - leftLength;
    })[0]?.href;

  return (
    <div
      className={`bg-[radial-gradient(circle_at_34%_0%,rgba(91,42,134,.09),transparent_34%),radial-gradient(circle_at_92%_18%,rgba(200,144,19,.09),transparent_30%),#f6f3f8] text-[#443a50] lg:grid lg:grid-cols-[286px_minmax(0,1fr)] ${
        mode === "fullscreen" ? "h-[100dvh] overflow-hidden" : "min-h-[100dvh]"
      }`}
    >
      <button
        type="button"
        className="fixed left-4 top-4 z-[90] flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-[#11131b] text-white shadow-xl lg:hidden"
        onClick={() => setMobileOpen((open) => !open)}
        aria-label="切换导航"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-[70] bg-black/45 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-[80] flex w-[286px] flex-col overflow-y-auto bg-[radial-gradient(circle_at_20%_2%,rgba(120,74,176,.36),transparent_28%),linear-gradient(180deg,#11131b_0%,#090a10_48%,#06070b_100%)] px-4 py-5 text-white transition-transform lg:sticky lg:top-0 lg:h-[100dvh] lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-white/10 px-2 pb-5">
          <img
            src="/assets/frontmind-wordmark.svg"
            alt="FrontMind"
            className="h-9 w-auto max-w-[190px] brightness-0 invert"
          />
          <p className="fm-eyebrow mt-3 text-white/50">企业级 GEO 工作台</p>
        </div>

        <div className="mt-5 rounded-[22px] border border-white/10 bg-white/[0.045] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,.06)]">
          <nav className="space-y-1.5" aria-label="管理中心导航">
            {navItems.map((item, itemIndex) => {
              const Icon = item.icon;
              const active = !item.external && item.href === activeHref;
              const className = `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                active
                  ? "bg-white/12 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]"
                  : "text-white/62 hover:bg-white/[0.075] hover:text-white"
              }`;
              const content = (
                <>
                  <Icon
                    className={`h-4 w-4 ${active ? "text-[#d7aa44]" : ""}`}
                  />
                  <span>{item.label}</span>
                </>
              );
              const previousItem = navItems[itemIndex - 1];
              const showGroup =
                itemIndex === 0 || item.group !== previousItem?.group;
              return (
                <div key={`${item.group || "workspace"}-${item.href}`}>
                  {showGroup && (
                    <p className="px-3 pb-2 pt-4 text-xs font-medium text-white/38 first:pt-0">
                      {item.group || "工作空间"}
                    </p>
                  )}
                  {item.external ? (
                    <a
                      href={item.href}
                      target={item.newWindow ? "_blank" : undefined}
                      rel={item.newWindow ? "noopener noreferrer" : undefined}
                      className={className}
                      onClick={() => setMobileOpen(false)}
                    >
                      {content}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      className={className}
                      onClick={() => setMobileOpen(false)}
                    >
                      {content}
                    </Link>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        <div className="mt-auto rounded-[18px] border border-white/10 bg-white/[0.055] p-4">
          <p className="text-xs text-white/48">当前账号</p>
          <p className="mt-1 truncate text-sm font-semibold text-white">
            {accountLabel || user?.displayName || user?.username || "预览账号"}
          </p>
          <p className="mt-1 text-xs text-white/45">
            {roleLabel || (user?.role === "admin" ? "管理员" : "用户")}
          </p>
          <button
            type="button"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2 text-xs text-white/65 transition hover:bg-white/10 hover:text-white"
            onClick={() => {
              if (!accountLabel) void logout();
            }}
            disabled={Boolean(accountLabel)}
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </button>
        </div>
      </aside>

      <main
        className={
          mode === "fullscreen"
            ? "h-[100dvh] min-w-0 overflow-hidden"
            : "min-w-0"
        }
      >
        {mode === "standard" && (
          <header className="sticky top-0 z-40 flex min-h-[82px] flex-col items-stretch justify-center gap-2 border-b border-[#e8e1ee]/90 bg-white/82 px-4 py-3 pl-16 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-8 sm:py-0 sm:pl-20 lg:px-9 lg:pl-9">
            <div className="min-w-0 sm:py-3">
              <p className="fm-eyebrow text-[#5b2a86]">{eyebrow}</p>
              <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-[#251e2d] sm:text-2xl">
                {title}
              </h1>
            </div>
            {toolbar && (
              <div className="flex justify-end sm:shrink-0">{toolbar}</div>
            )}
          </header>
        )}
        <div
          className={
            mode === "fullscreen"
              ? "h-full min-h-0 w-full"
              : "mx-auto w-full max-w-[1520px] px-4 py-6 sm:px-7 lg:px-8 lg:py-8"
          }
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export function PortalCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[18px] border border-[#e8e1ee] bg-white/92 text-[#4f485c] shadow-[0_18px_48px_rgba(33,19,58,.07)] ${className}`}
    >
      {children}
    </section>
  );
}
