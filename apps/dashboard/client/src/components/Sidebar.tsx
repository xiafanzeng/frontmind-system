/**
 * Sidebar Component - Conversation History
 *
 * CRITICAL FIX: Delete button visibility on both mobile and desktop.
 *
 * Root causes fixed:
 * 1. Global CSS `.flex { min-width: 0 }` allowed the title div to shrink
 *    to zero, pushing the delete button out of view when the title was long.
 * 2. On mobile (touch devices), CSS :hover is unreliable, so the delete
 *    button must ALWAYS be visible — not gated behind group-hover.
 * 3. The inner flex row now uses `overflow-hidden` and explicit `min-w-0`
 *    on the title container, with a fixed `w-7` allocation for the delete
 *    button so it can never be squeezed out.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useConversation } from "@/contexts/ConversationContext";
import { useIsMobile } from "@/hooks/useMobile";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Plus,
  MessageSquare,
  Trash2,
  Settings,
  ChevronLeft,
  ChevronRight,
  Menu,
  BriefcaseBusiness,
  LayoutDashboard,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/contexts/ConversationContext";
import AccountMenu from "@/components/AccountMenu";
import { isSystemAdminAccount } from "@/lib/admin-access";

const LOGO_ICON =
  "https://d2xsxph8kpxj0f.cloudfront.net/310519663465762565/ZiWzJwHCXtKB4GziVKqKt6/fm-logo_cde8eb94.png";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  embedded?: boolean;
  hidePortalNavigation?: boolean;
  showAccountMenu?: boolean;
  showSettings?: boolean;
}

export default function Sidebar({
  collapsed,
  onToggle,
  onOpenSettings,
  embedded = false,
  hidePortalNavigation = false,
  showAccountMenu = true,
  showSettings = true,
}: SidebarProps) {
  const isMobile = useIsMobile();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isSystemAdmin = isSystemAdminAccount(user);
  const {
    state,
    activeConversation,
    createConversation,
    setActive,
    deleteConversation,
  } = useConversation();

  const statusDot: Record<string, string> = {
    idle: "bg-slate-400/60",
    running: "bg-amber-400 animate-pulse",
    pending: "bg-blue-400 animate-pulse",
    completed: "bg-emerald-400",
    error: "bg-red-400",
    failed: "bg-red-400",
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };

  // Mobile: Use Sheet instead of collapsible sidebar
  const [open, setOpen] = useState(false);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`top-[max(0.75rem,env(safe-area-inset-top))] z-50 border border-border/70 bg-card/90 shadow-sm backdrop-blur-sm ${
              embedded && hidePortalNavigation && !showAccountMenu
                ? "left-[max(4.25rem,calc(env(safe-area-inset-left)+4.25rem))]"
                : "left-[max(0.75rem,env(safe-area-inset-left))]"
            } ${embedded ? "absolute" : "fixed"}`}
            aria-label="打开内容流程菜单"
          >
            <Menu className="w-5 h-5" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="h-dvh w-[min(86vw,292px)] max-w-[292px] gap-0 overflow-hidden border-sidebar-border bg-sidebar p-0 [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>内容流程列表</SheetTitle>
          </SheetHeader>
          <SidebarInner
            state={state}
            activeConversation={activeConversation}
            createConversation={() => {
              const id = createConversation();
              setOpen(false);
              return id;
            }}
            setActive={(id) => {
              setActive(id);
              setOpen(false);
            }}
            deleteConversation={deleteConversation}
            statusDot={statusDot}
            formatTime={formatTime}
            onOpenSettings={() => {
              onOpenSettings();
              setOpen(false);
            }}
            onNavigate={() => setOpen(false)}
            isAdmin={user?.role === "admin"}
            isSystemAdmin={isSystemAdmin}
            hidePortalNavigation={hidePortalNavigation}
            showAccountMenu={showAccountMenu}
            showSettings={showSettings}
            onOpenAdmin={() => {
              setLocation("/");
              setOpen(false);
            }}
            onOpenPresales={() => {
              setLocation("/admin/presales");
              setOpen(false);
            }}
            collapsed={false}
            onToggle={() => {}}
            isMobile={true}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 60 : 272 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="relative h-full flex flex-col overflow-hidden border-r border-border/70 bg-sidebar/85 backdrop-blur-xl min-h-0"
    >
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_30%_0%,rgba(120,113,108,0.12),transparent_40%)]" />

      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-4 border-b border-border/70 flex-shrink-0">
        <img
          src={LOGO_ICON}
          alt="Logo"
          className="w-8 h-8 rounded-xl flex-shrink-0 shadow-sm ring-1 ring-border/60"
        />
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              className="overflow-hidden whitespace-nowrap"
            >
              <h1 className="text-sm font-semibold text-sidebar-foreground tracking-wide">
                FrontMind Studio
              </h1>
              <p className="text-xs text-muted-foreground font-mono tracking-wider">
                CONTENT AGENTS
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* New Chat Button */}
      <div className="relative z-10 px-3 pt-3 pb-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => createConversation()}
              variant="outline"
              className={cn(
                "w-full border-border/70 bg-card/70 hover:bg-card text-sidebar-foreground hover:text-foreground transition-all duration-200 shadow-sm",
                collapsed ? "px-0 justify-center" : "justify-start gap-2",
              )}
              size="sm"
            >
              <Plus className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span className="text-sm">新内容流程</span>}
            </Button>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">新内容流程</TooltipContent>
          )}
        </Tooltip>
      </div>

      {/* Conversation List */}
      <ScrollArea className="flex-1 relative z-10 min-h-0 overflow-hidden">
        <div className="px-2 py-2 space-y-0.5">
          <AnimatePresence>
            {state.conversations.map((conv) => {
              const isActive = conv.id === activeConversation?.id;
              return (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  isActive={isActive}
                  collapsed={collapsed}
                  isMobile={false}
                  statusDot={statusDot}
                  formatTime={formatTime}
                  onSelect={() => setActive(conv.id)}
                  onDelete={() => deleteConversation(conv.id)}
                />
              );
            })}
          </AnimatePresence>

          {state.conversations.length === 0 && !collapsed && (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-muted-foreground/50">暂无内容流程</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="relative z-10 px-2 py-2 border-t border-border/70 space-y-0.5 flex-shrink-0">
        {!hidePortalNavigation && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setLocation("/")}
                variant="ghost"
                className={cn(
                  "w-full text-muted-foreground hover:text-foreground hover:bg-card/70",
                  collapsed ? "px-0 justify-center" : "justify-start gap-2",
                )}
                size="sm"
              >
                <LayoutDashboard className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="text-xs">返回管理中心</span>}
              </Button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">返回管理中心</TooltipContent>
            )}
          </Tooltip>
        )}

        {!hidePortalNavigation && isSystemAdmin && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setLocation("/admin/presales")}
                variant="ghost"
                className={cn(
                  "w-full text-muted-foreground hover:text-foreground hover:bg-card/70",
                  collapsed ? "px-0 justify-center" : "justify-start gap-2",
                )}
                size="sm"
              >
                <BriefcaseBusiness className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="text-xs">售前页面</span>}
              </Button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">售前页面</TooltipContent>
            )}
          </Tooltip>
        )}

        {showSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onOpenSettings}
                variant="ghost"
                className={cn(
                  "w-full text-muted-foreground hover:text-foreground hover:bg-card/70",
                  collapsed ? "px-0 justify-center" : "justify-start gap-2",
                )}
                size="sm"
              >
                <Settings className="w-4 h-4 flex-shrink-0" />
                {!collapsed && (
                  <span className="text-xs">
                    {showAccountMenu || !isSystemAdmin
                      ? "设置"
                      : "API Key 与积分"}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">
                {showAccountMenu || !isSystemAdmin ? "设置" : "API Key 与积分"}
              </TooltipContent>
            )}
          </Tooltip>
        )}

        {showAccountMenu && (
          <AccountMenu collapsed={collapsed} onOpenSettings={onOpenSettings} />
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onToggle}
              variant="ghost"
              className={cn(
                "w-full text-muted-foreground/75 hover:text-foreground hover:bg-card/70",
                collapsed ? "px-0 justify-center" : "justify-start gap-2",
              )}
              size="sm"
            >
              {collapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <>
                  <ChevronLeft className="w-4 h-4 flex-shrink-0" />
                  <span className="text-xs">收起</span>
                </>
              )}
            </Button>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">展开侧栏</TooltipContent>}
        </Tooltip>
      </div>
    </motion.aside>
  );
}

// ─── Conversation Item ────────────────────────────────────────────
//
// CRITICAL LAYOUT FIX:
// The inner flex row uses `overflow-hidden` on the outer wrapper and
// explicit `min-w-0` on the title container to prevent the title text
// from pushing the delete button out of view. The delete button uses
// `flex-shrink-0` and a fixed width to guarantee it always renders.
//
// On mobile: delete button is ALWAYS visible (text-muted-foreground).
// On desktop active: delete button is ALWAYS visible (text-muted-foreground).
// On desktop inactive: delete button appears on hover (group-hover).

interface ConversationItemProps {
  conv: Conversation;
  isActive: boolean;
  collapsed: boolean;
  isMobile: boolean;
  statusDot: Record<string, string>;
  formatTime: (ts: number) => string;
  onSelect: () => void;
  onDelete: () => void;
}

function ConversationItem({
  conv,
  isActive,
  collapsed,
  isMobile,
  statusDot,
  formatTime,
  onSelect,
  onDelete,
}: ConversationItemProps) {
  return (
    <motion.div
      key={conv.id}
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect();
        }}
        className={cn(
          "w-full text-left rounded-lg transition-all duration-200 group relative overflow-hidden",
          collapsed ? "p-2.5 flex justify-center" : "px-3 py-2.5",
          isActive
            ? "bg-card text-foreground shadow-sm ring-1 ring-border/70"
            : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
        )}
      >
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="relative">
                <MessageSquare className="w-4 h-4" />
                <span
                  className={cn(
                    "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full",
                    statusDot[conv.status],
                  )}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <div className="flex items-center gap-2">
                <span>{conv.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onDelete();
                  }}
                  className="p-1 rounded text-foreground/70 hover:text-red-400 hover:bg-red-500/20 transition-colors"
                  title="删除此内容流程"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <div className="flex items-start gap-2">
            {/* Icon - fixed width, never shrinks */}
            <div
              className="relative mt-0.5 flex-shrink-0 flex-grow-0"
              style={{ width: "16px" }}
            >
              <MessageSquare className="w-4 h-4" />
              <span
                className={cn(
                  "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full",
                  statusDot[conv.status],
                )}
              />
            </div>

            {/* Title & meta - MUST have min-w-0 to allow truncation inside flex */}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium truncate leading-tight">
                {conv.title}
              </p>
              <p className="text-xs opacity-40 mt-0.5 truncate">
                {formatTime(conv.updatedAt)}
                {conv.messages.length > 0 && (
                  <span className="ml-1.5">· {conv.messages.length} 条</span>
                )}
              </p>
            </div>

            {/* Delete button - fixed width, NEVER shrinks, ALWAYS in DOM */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onDelete();
              }}
              className={cn(
                "flex-shrink-0 flex-grow-0 p-1 rounded-md transition-all duration-150",
                "w-7 h-7 flex items-center justify-center",
                isMobile || isActive
                  ? "text-muted-foreground hover:text-red-500 hover:bg-red-500/10 active:text-red-500 active:bg-red-500/10"
                  : "text-transparent group-hover:text-muted-foreground hover:!text-red-500 hover:!bg-red-500/10",
              )}
              title="删除此内容流程"
              aria-label="删除此内容流程"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Shared sidebar content for mobile Sheet ──────────────────────

interface SidebarInnerProps {
  state: { conversations: Conversation[] };
  activeConversation: Conversation | null;
  createConversation: () => string;
  setActive: (id: string) => void;
  deleteConversation: (id: string) => void;
  statusDot: Record<string, string>;
  formatTime: (ts: number) => string;
  onOpenSettings: () => void;
  onNavigate: () => void;
  collapsed: boolean;
  onToggle: () => void;
  isMobile: boolean;
  isAdmin: boolean;
  isSystemAdmin: boolean;
  hidePortalNavigation: boolean;
  showAccountMenu: boolean;
  showSettings: boolean;
  onOpenAdmin: () => void;
  onOpenPresales: () => void;
}

function SidebarInner({
  state,
  activeConversation,
  createConversation,
  setActive,
  deleteConversation,
  statusDot,
  formatTime,
  onOpenSettings,
  onNavigate,
  isMobile,
  isAdmin,
  isSystemAdmin,
  hidePortalNavigation,
  showAccountMenu,
  showSettings,
  onOpenAdmin,
  onOpenPresales,
}: SidebarInnerProps) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-sidebar/95 text-sidebar-foreground backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_0%,rgba(120,113,108,0.12),transparent_40%)]" />

      {/* Header */}
      <div className="relative z-10 flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-4">
        <img
          src={LOGO_ICON}
          alt="Logo"
          className="w-8 h-8 rounded-xl flex-shrink-0 shadow-sm ring-1 ring-border/60"
        />
        <div className="overflow-hidden whitespace-nowrap">
          <h1 className="text-sm font-semibold text-sidebar-foreground tracking-wide">
            FrontMind Studio
          </h1>
          <p className="text-xs text-muted-foreground font-mono tracking-wider">
            CONTENT AGENTS
          </p>
        </div>
      </div>

      {/* New Chat Button */}
      <div className="relative z-10 shrink-0 px-3 pb-1 pt-3">
        <Button
          onClick={() => createConversation()}
          variant="outline"
          className="w-full justify-start gap-2 border-border/70 bg-card/70 text-sidebar-foreground shadow-sm transition-all duration-200 hover:bg-card hover:text-foreground"
          size="sm"
        >
          <Plus className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">新内容流程</span>
        </Button>
      </div>

      {/* Conversation List */}
      <ScrollArea className="relative z-10 min-h-0 flex-1 overflow-hidden">
        <div className="px-2 py-2 space-y-0.5">
          <AnimatePresence>
            {state.conversations.map((conv) => {
              const isActive = conv.id === activeConversation?.id;
              return (
                <ConversationItem
                  key={conv.id}
                  conv={conv}
                  isActive={isActive}
                  collapsed={false}
                  isMobile={isMobile}
                  statusDot={statusDot}
                  formatTime={formatTime}
                  onSelect={() => setActive(conv.id)}
                  onDelete={() => deleteConversation(conv.id)}
                />
              );
            })}
          </AnimatePresence>

          {state.conversations.length === 0 && (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-muted-foreground/50">暂无内容流程</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="relative z-10 shrink-0 space-y-0.5 border-t border-border/70 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {!hidePortalNavigation && isAdmin && (
          <Button
            onClick={onOpenAdmin}
            variant="ghost"
            className="w-full justify-start gap-2 text-muted-foreground hover:bg-card/70 hover:text-foreground"
            size="sm"
          >
            <LayoutDashboard className="h-4 w-4 flex-shrink-0" />
            <span className="text-xs">返回管理中心</span>
          </Button>
        )}
        {!hidePortalNavigation && isSystemAdmin && (
          <Button
            onClick={onOpenPresales}
            variant="ghost"
            className="w-full justify-start gap-2 text-muted-foreground hover:bg-card/70 hover:text-foreground"
            size="sm"
          >
            <BriefcaseBusiness className="h-4 w-4 flex-shrink-0" />
            <span className="text-xs">售前页面</span>
          </Button>
        )}
        {showSettings && (
          <Button
            onClick={onOpenSettings}
            variant="ghost"
            className="w-full text-muted-foreground hover:text-foreground hover:bg-card/70 justify-start gap-2"
            size="sm"
          >
            <Settings className="w-4 h-4 flex-shrink-0" />
            <span className="text-xs">
              {showAccountMenu || !isSystemAdmin ? "设置" : "API Key 与积分"}
            </span>
          </Button>
        )}
        {showAccountMenu && (
          <AccountMenu
            onOpenSettings={onOpenSettings}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </div>
  );
}
