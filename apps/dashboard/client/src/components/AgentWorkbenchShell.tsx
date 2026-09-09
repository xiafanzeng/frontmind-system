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
  /** A new request reveals the conversation and focuses its composer. */
  conversationFocusRequest?: object | null;
};
const MIN_RESULT = 320;
const MIN_CONVERSATION = 360;
const QUERY = "(max-width: 1099px)";
const widthKey = (projectId: string, moduleId: string) =>
  `frontmind.workbench.width:${projectId}:${moduleId}`;
function readWidth(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return value >= MIN_RESULT ? value : 480;
  } catch {
    return 480;
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
  const focusConversation = useCallback(() => {
    root.current
      ?.querySelector<HTMLTextAreaElement>(
        ".agent-workbench-shell__conversation-body textarea:not([disabled])",
      )
      ?.focus();
  }, []);
  // One portal host follows the responsive surface. Moving between a desktop
  // panel and a drawer must not remount editors or discard their local drafts.
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
  const stopDrag = useRef<() => void>(() => undefined);
  const previousKey = useRef(key);
  const maxWidth = Math.max(MIN_RESULT, available - MIN_CONVERSATION);
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
    setExpanded(false);
    if (narrow && mobileOpen) {
      // Let the drawer release its focus trap before handing focus to the composer.
      setMobileOpen(false);
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
          MIN_RESULT,
          Math.min(
            Math.max(MIN_RESULT, bounds.width - MIN_CONVERSATION),
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
      <div className="agent-workbench-shell__layout">
        <section
          className="agent-workbench-shell__conversation"
          aria-label="任务对话"
        >
          {narrow && (
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
                  查看成果
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
                  <SheetTitle>{resultTitle}</SheetTitle>
                </SheetHeader>
                {actionsBar}
                <div
                  className="agent-workbench-shell__result-slot"
                  ref={attachResult}
                />
              </SheetContent>
            </Sheet>
          )}
          <div className="agent-workbench-shell__conversation-body">
            {conversation}
          </div>
        </section>
        {!narrow && (
          <>
            <div
              className="agent-workbench-shell__resize"
              role="separator"
              aria-label="调整成果面板宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_RESULT}
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
                    ? MIN_RESULT
                    : event.key === "End"
                      ? maxWidth
                      : Math.max(
                          MIN_RESULT,
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
              className="agent-workbench-shell__result"
              aria-label={resultTitle}
            >
              <header className="agent-workbench-shell__result-head">
                <h2>{resultTitle}</h2>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setExpanded((value) => !value)}
                  aria-label={expanded ? "还原成果面板" : "展开成果面板"}
                >
                  {expanded ? (
                    <Minimize2 className="size-4" />
                  ) : (
                    <Maximize2 className="size-4" />
                  )}
                </Button>
              </header>
              {actionsBar}
              <div
                ref={attachResult}
                className="agent-workbench-shell__result-slot"
                data-result-key={resultKey}
              />
            </section>
          </>
        )}
      </div>
      {createPortal(resultContent, resultHost)}
    </section>
  );
}
