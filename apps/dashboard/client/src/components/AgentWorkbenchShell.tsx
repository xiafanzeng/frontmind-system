import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  useWorkbenchModule,
  type WorkbenchAction,
} from "@/dashboard/agent-workbench";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import "./AgentWorkbenchShell.css";

export type { WorkbenchAction } from "@/dashboard/agent-workbench";
export type AgentWorkbenchShellProps = {
  projectId: string;
  moduleId: string;
  title: string;
  conversation: ReactNode;
  children?: ReactNode;
  result?: ReactNode;
  resultTitle: string;
  actions?: WorkbenchAction[];
  resultKey?: string;
  status?: string;
  embedded?: boolean;
  /** General agent conversations can use the full work area without a result panel. */
  showResult?: boolean;
  /** A new request reveals the conversation and focuses its composer. */
  conversationFocusRequest?: object | null;
};
const MIN_CONTEXT = 320;
const MIN_PRIMARY = 360;
const QUERY = "(max-width: 1099px)";
const widthKey = (projectId: string, moduleId: string) =>
  `frontmind.workbench.width:${projectId}:${moduleId}`;
function readWidth(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return value >= MIN_CONTEXT ? value : 400;
  } catch {
    return 400;
  }
}

/** Shared reading surface. Business components continue owning their state and requests. */
export function AgentWorkbenchShell({
  projectId,
  moduleId,
  title,
  conversation,
  children,
  result,
  resultTitle,
  actions,
  resultKey,
  status,
  embedded = false,
  showResult = true,
  conversationFocusRequest,
}: AgentWorkbenchShellProps) {
  const module = useWorkbenchModule();
  const panelActions = actions ?? module?.actions ?? [];
  const key = widthKey(projectId, moduleId);
  const [width, setWidth] = useState(() => readWidth(key));
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);
  const [available, setAvailable] = useState(1100);
  const root = useRef<HTMLElement>(null);
  const handledFocusRequest = useRef<object | null>(null);
  const pendingConversationFocus = useRef(false);
  const [conversationHost] = useState(() => {
    const element = document.createElement("div");
    element.className = "agent-workbench-shell__conversation-body";
    return element;
  });
  const focusConversation = useCallback(() => {
    conversationHost
      .querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
      ?.focus();
  }, [conversationHost]);
  // Portal hosts follow the responsive surface. Moving between the desktop
  // context panel and its drawer must not remount a draft conversation; the
  // primary business view receives the same protection when its shell changes.
  const [resultHost] = useState(() => {
    const element = document.createElement("div");
    element.className = "agent-workbench-shell__result-body";
    return element;
  });
  const attachResult = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot) slot.appendChild(resultHost);
      else resultHost.remove();
    },
    [resultHost],
  );
  const attachConversation = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot) slot.appendChild(conversationHost);
      else conversationHost.remove();
    },
    [conversationHost],
  );
  const stopDrag = useRef<() => void>(() => undefined);
  const previousKey = useRef(key);
  const maxWidth = Math.max(MIN_CONTEXT, available - MIN_PRIMARY);
  const renderedWidth = Math.min(width, maxWidth);
  useEffect(() => {
    setWidth(readWidth(key));
    setExpanded(false);
    setMobileOpen(false);
  }, [key]);
  useEffect(() => {
    if (
      !conversationFocusRequest ||
      handledFocusRequest.current === conversationFocusRequest
    )
      return;
    handledFocusRequest.current = conversationFocusRequest;
    pendingConversationFocus.current = true;
    if (narrow && !mobileOpen) {
      setMobileOpen(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pendingConversationFocus.current = false;
      focusConversation();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationFocusRequest, narrow, mobileOpen, focusConversation]);
  useEffect(() => {
    // Never write the previous project's width to the next project's preference.
    if (previousKey.current !== key) {
      previousKey.current = key;
      return;
    }
    try {
      localStorage.setItem(key, String(width));
    } catch {
      /* Optional preference. */
    }
  }, [key, width]);
  useEffect(() => {
    const query = window.matchMedia(QUERY);
    const update = () => {
      setNarrow(query.matches);
      if (!query.matches) setMobileOpen(false);
    };
    query.addEventListener("change", update);
    const measure = () =>
      setAvailable(root.current?.getBoundingClientRect().width || 1100);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", measure);
    return () => {
      query.removeEventListener("change", update);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      stopDrag.current();
    };
  }, []);
  useEffect(() => {
    const body = resultHost;
    if (body && !body.contains(document.activeElement))
      body.scrollTo?.({ top: 0, behavior: "smooth" });
  }, [resultKey, mobileOpen, resultHost]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setExpanded(false);
    stopDrag.current();
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (moveEvent: globalThis.PointerEvent) =>
      setWidth(
        Math.max(
          MIN_CONTEXT,
          Math.min(
            Math.max(MIN_CONTEXT, bounds.width - MIN_PRIMARY),
            bounds.right - moveEvent.clientX,
          ),
        ),
      );
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    stopDrag.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const actionsBar = panelActions.length > 0 && (
    <div className="agent-workbench-subagents">
      <div className="agent-workbench-subagents__heading">子智能体</div>
      <div
        className="agent-workbench-actions"
        role="group"
        aria-label="子智能体"
      >
        {panelActions.map((action) => (
          <button
            key={action.id}
            type="button"
            aria-label={action.label}
            aria-pressed={action.active}
            className={action.active ? "is-active" : undefined}
            style={
              { "--subagent-color": action.color ?? "#5e6174" } as CSSProperties
            }
            disabled={action.disabled}
            onClick={() => requestWorkspaceNavigation(action.run)}
          >
            <span className="agent-workbench-actions__label">
              {action.label}
            </span>
            {action.description && (
              <span className="agent-workbench-actions__description">
                {action.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
  const resultContent = result ?? children;
  return (
    <section
      ref={root}
      className={`agent-workbench-shell ${expanded ? "is-expanded" : ""}`}
      style={{ "--agent-result-width": `${renderedWidth}px` } as CSSProperties}
      aria-label={`${title}工作区`}
    >
      {!embedded && (
        <header className="agent-workbench-shell__heading">
          <h1>{title}</h1>
          {status && <span role="status">{status}</span>}
        </header>
      )}
      <div
        className={`agent-workbench-shell__layout ${showResult ? "" : "is-single-pane"}`}
      >
        <section
          className={
            showResult
              ? "agent-workbench-shell__result"
              : "agent-workbench-shell__conversation"
          }
          aria-label={showResult ? resultTitle : "智能体协作"}
        >
          <header
            className={
              showResult
                ? "agent-workbench-shell__result-head"
                : "agent-workbench-shell__conversation-head"
            }
          >
            <h2>{showResult ? resultTitle : "智能体协作"}</h2>
            {showResult && !narrow && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setExpanded((value) => !value)}
                aria-label={expanded ? "还原主工作区" : "展开主工作区"}
              >
                {expanded ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Button>
            )}
            {!showResult && status && <span role="status">{status}</span>}
          </header>
          {showResult ? (
            <div
              ref={attachResult}
              className="agent-workbench-shell__result-slot"
              data-result-key={resultKey}
            />
          ) : (
            <div
              ref={attachConversation}
              className="agent-workbench-shell__conversation-slot"
            />
          )}
          {showResult && narrow && (
            <Sheet
              open={mobileOpen}
              onOpenChange={(open) =>
                open
                  ? setMobileOpen(true)
                  : requestWorkspaceNavigation(() => setMobileOpen(false))
              }
            >
              <SheetTrigger asChild>
                <Button
                  className="agent-workbench-shell__mobile-trigger"
                  size="sm"
                  variant="ghost"
                >
                  <PanelRightOpen className="size-4" />
                  打开智能体协作
                </Button>
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="agent-workbench-drawer"
                aria-describedby={undefined}
                onCloseAutoFocus={(event) => {
                  if (!pendingConversationFocus.current) return;
                  event.preventDefault();
                  pendingConversationFocus.current = false;
                  focusConversation();
                }}
              >
                <SheetHeader>
                  <SheetTitle>智能体协作</SheetTitle>
                </SheetHeader>
                {actionsBar}
                <div
                  className="agent-workbench-shell__conversation-slot"
                  ref={attachConversation}
                />
              </SheetContent>
            </Sheet>
          )}
        </section>
        {showResult && !narrow && (
          <>
            <div
              className="agent-workbench-shell__resize"
              role="separator"
              aria-label="调整智能体协作面板宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_CONTEXT}
              aria-valuemax={maxWidth}
              aria-valuenow={renderedWidth}
              tabIndex={0}
              onPointerDown={resize}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                setExpanded(false);
                setWidth(
                  event.key === "Home"
                    ? MIN_CONTEXT
                    : event.key === "End"
                      ? maxWidth
                      : Math.max(
                          MIN_CONTEXT,
                          Math.min(
                            maxWidth,
                            renderedWidth +
                              (event.key === "ArrowLeft" ? 32 : -32),
                          ),
                        ),
                );
              }}
            />
            <section
              className="agent-workbench-shell__conversation"
              aria-label="智能体协作"
            >
              <header className="agent-workbench-shell__conversation-head">
                <h2>智能体协作</h2>
                {status && <span role="status">{status}</span>}
              </header>
              {actionsBar}
              <div
                ref={attachConversation}
                className="agent-workbench-shell__conversation-slot"
              />
            </section>
          </>
        )}
      </div>
      {showResult && createPortal(resultContent, resultHost)}
      {createPortal(conversation, conversationHost)}
    </section>
  );
}
