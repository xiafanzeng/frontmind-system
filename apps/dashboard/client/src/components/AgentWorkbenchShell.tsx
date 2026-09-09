import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from "react";
import { useChatReadingPosition } from "@/hooks/useChatReadingPosition";
import { createPortal } from "react-dom";
import { PanelRightClose, PanelRightOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
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
  main?: ReactNode;
  auxiliary?: ReactNode;
  composer?: ReactNode;
  layout?: "single" | "workflow" | "knowledge";
  toolbar?: ReactNode;
  taskTitle?: string;
  taskKey?: string;
  scrollMain?: boolean;
  conversation?: ReactNode;
  children?: ReactNode;
  result?: ReactNode;
  resultTitle?: string;
  actions?: WorkbenchAction[];
  resultKey?: string;
  status?: string;
  embedded?: boolean;
  showResult?: boolean;
  conversationFocusRequest?: object | null;
};
function savedWidth(key: string) {
  try {
    return Number(localStorage.getItem(key)) || null;
  } catch {
    return null;
  }
}
export function AgentWorkbenchShell({
  projectId,
  moduleId,
  title,
  main,
  auxiliary,
  composer,
  layout: requestedLayout,
  toolbar,
  taskTitle,
  taskKey,
  scrollMain,
  conversation,
  children,
  result,
  resultTitle = "任务信息",
  actions,
  status,
  showResult = true,
  conversationFocusRequest,
}: AgentWorkbenchShellProps) {
  const module = useWorkbenchModule();
  const layout = requestedLayout ?? (!showResult ? "single" : "workflow");
  const isKnowledge = layout === "knowledge";
  const hasAux = layout !== "single";
  const ownsScroll = scrollMain ?? main !== undefined;
  const preferenceKey = `frontmind.workbench.v2.width:${projectId}:${moduleId}:${layout}`;
  const [width, setWidth] = useState<number | null>(() =>
    savedWidth(preferenceKey),
  );
  const [available, setAvailable] = useState(0);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const mainViewport = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const stopDrag = useRef<() => void>(() => undefined);
  const focusMainAfterClose = useRef(false);
  const minAux = isKnowledge ? 420 : 280;
  const maxAux = Math.max(
    minAux,
    Math.min(isKnowledge ? 720 : 480, available - 601),
  );
  const renderedWidth = Math.max(
    minAux,
    Math.min(maxAux, width ?? (isKnowledge ? available * 0.45 : 320)),
  );
  const narrow = viewport < 1280 || (available > 0 && available < 601 + minAux);
  const inlineAux = hasAux && !narrow && !collapsed;
  const [auxHost] = useState(() => {
    const node = document.createElement("div");
    node.className = "agent-workbench-shell__auxiliary-content";
    return node;
  });
  const attachAux = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot) slot.appendChild(auxHost);
    },
    [auxHost],
  );
  useEffect(() => {
    const measure = () => {
      setAvailable(root.current?.clientWidth ?? 0);
      setViewport(window.innerWidth);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      stopDrag.current();
    };
  }, []);
  useEffect(() => {
    setWidth(savedWidth(preferenceKey));
    setCollapsed(false);
    setDrawerOpen(false);
  }, [preferenceKey]);
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (!conversationFocusRequest) return;
    if (drawerOpen) {
      focusMainAfterClose.current = true;
      setDrawerOpen(false);
    } else
      mainViewport.current
        ?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
        ?.focus();
  }, [conversationFocusRequest]);
  const readingKey = `${projectId}:${moduleId}:${taskKey ?? "current"}`;
  const { showLatest, returnToLatest } = useChatReadingPosition(
    mainViewport,
    readingKey,
    readingKey,
    { initialPinned: false, enabled: ownsScroll },
  );
  const changeWidth = (value: number) => {
    const next = Math.max(minAux, Math.min(maxAux, value));
    setWidth(next);
    try {
      localStorage.setItem(preferenceKey, String(next));
    } catch {}
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current();
    const right = root.current?.getBoundingClientRect().right;
    if (right === undefined) return;
    const move = (e: globalThis.PointerEvent) => changeWidth(right - e.clientX);
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
  const subagents = actions ?? module?.actions ?? [];
  const agentSwitch = subagents.length > 0 && (
    <nav className="agent-workbench-subagents" aria-label="切换子 Agent">
      {subagents.map((action) => (
        <button
          type="button"
          key={action.id}
          aria-current={action.active ? "page" : undefined}
          aria-pressed={action.active}
          disabled={action.disabled}
          title={action.description}
          className={action.active ? "is-active" : undefined}
          style={
            { "--subagent-color": action.color ?? "#491060" } as CSSProperties
          }
          onClick={() => requestWorkspaceNavigation(action.run)}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span>{action.label}</span>
        </button>
      ))}
    </nav>
  );
  return (
    <section
      ref={root}
      className={`agent-workbench-shell layout-${layout}`}
      aria-label={`${title}工作区`}
      data-layout={layout}
      style={{ "--agent-aux-width": `${renderedWidth}px` } as CSSProperties}
    >
      <header className="agent-workbench-shell__taskbar">
        <div className="agent-workbench-task-name">
          <strong>{title}</strong>
          {taskTitle && (
            <>
              <span aria-hidden="true">·</span>
              <span title={taskTitle}>{taskTitle}</span>
            </>
          )}
        </div>
        {status && (
          <span className="agent-workbench-task-status" role="status">
            {status}
          </span>
        )}
        <div className="agent-workbench-task-actions">
          {toolbar}
          {hasAux && (
            <Button
              ref={toggle}
              variant="ghost"
              size="icon"
              aria-label={inlineAux ? "收起任务信息" : "打开任务信息"}
              aria-expanded={inlineAux || drawerOpen}
              onClick={() =>
                narrow ? setDrawerOpen(true) : setCollapsed((value) => !value)
              }
            >
              {inlineAux ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </Button>
          )}
        </div>
      </header>
      <div
        className={`agent-workbench-shell__layout ${inlineAux ? "" : "is-single-pane"}`}
      >
        <section className="agent-workbench-shell__main" aria-label="主工作区">
          <div
            ref={mainViewport}
            className={`agent-workbench-shell__main-content ${ownsScroll ? "is-scrollable" : "has-native-scroll"}`}
          >
            {main ?? conversation}
          </div>
          {ownsScroll && showLatest && (
            <button
              type="button"
              className="workbench-back-to-latest"
              onClick={returnToLatest}
            >
              ↓ 回到最新
            </button>
          )}
          {composer && (
            <div className="agent-workbench-shell__composer">{composer}</div>
          )}
        </section>
        {inlineAux && (
          <>
            <div
              className="agent-workbench-shell__resize"
              role="separator"
              aria-label="调整任务信息面板宽度"
              aria-orientation="vertical"
              aria-valuemin={minAux}
              aria-valuemax={maxAux}
              aria-valuenow={Math.round(renderedWidth)}
              tabIndex={0}
              onPointerDown={resize}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                changeWidth(
                  e.key === "Home"
                    ? minAux
                    : e.key === "End"
                      ? maxAux
                      : renderedWidth + (e.key === "ArrowLeft" ? 24 : -24),
                );
              }}
            />
            <aside
              className="agent-workbench-shell__auxiliary"
              aria-label={isKnowledge ? "知识节点与资料" : "任务辅助区"}
            >
              {agentSwitch}
              <div
                className="agent-workbench-shell__auxiliary-slot"
                ref={attachAux}
              />
            </aside>
          </>
        )}
      </div>
      {hasAux && (
        <Sheet open={drawerOpen && narrow} onOpenChange={setDrawerOpen}>
          <SheetContent
            side="right"
            className="agent-workbench-drawer"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (focusMainAfterClose.current) {
                focusMainAfterClose.current = false;
                mainViewport.current
                  ?.querySelector<HTMLTextAreaElement>(
                    "textarea:not([disabled])",
                  )
                  ?.focus();
              } else toggle.current?.focus();
            }}
          >
            <SheetHeader>
              <SheetTitle>
                {isKnowledge ? "知识节点与资料" : resultTitle}
              </SheetTitle>
            </SheetHeader>
            {agentSwitch}
            <div
              className="agent-workbench-shell__auxiliary-slot"
              ref={attachAux}
            />
          </SheetContent>
        </Sheet>
      )}
      {hasAux && createPortal(auxiliary ?? result ?? children, auxHost)}
    </section>
  );
}
