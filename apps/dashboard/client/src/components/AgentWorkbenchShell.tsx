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
import { PanelRightClose, PanelRightOpen } from "lucide-react";
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
  auxiliaryScroll?: boolean;
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
  auxiliaryFocusRequest?: object | null;
};
export const WORKBENCH_RATIO_KEY = "frontmind.workbench.v4.auxiliary-ratio";
export const WORKBENCH_MIN_WIDTH = 948;
export const WORKBENCH_MAX_WIDTH = 1584;

export function workbenchPaneGeometry(available: number, ratio = 1 / 3) {
  const content = Math.max(0, Math.min(available, WORKBENCH_MAX_WIDTH) - 48);
  const maxAux = Math.max(300, content - 600);
  return {
    minAux: 300,
    maxAux,
    width: Math.max(300, Math.min(maxAux, content * ratio)),
  };
}

function savedRatio() {
  try {
    const value = Number(localStorage.getItem(WORKBENCH_RATIO_KEY));
    return value > 0 && value < 1 ? value : 1 / 3;
  } catch {
    return 1 / 3;
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
  taskKey,
  scrollMain,
  auxiliaryScroll = true,
  conversation,
  children,
  result,
  resultTitle = "任务信息",
  actions,
  status,
  showResult = true,
  conversationFocusRequest,
  auxiliaryFocusRequest,
}: AgentWorkbenchShellProps) {
  const module = useWorkbenchModule();
  const layout = requestedLayout ?? (!showResult ? "single" : "workflow");
  const isKnowledge = layout === "knowledge";
  const hasAux = layout !== "single";
  const ownsScroll = scrollMain ?? main !== undefined;
  const [ratio, setRatio] = useState(savedRatio);
  const [available, setAvailable] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const mainViewport = useRef<HTMLDivElement>(null);
  const layoutRoot = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const stopDrag = useRef<() => void>(() => undefined);
  const focusMainAfterClose = useRef(false);
  const {
    minAux,
    maxAux,
    width: renderedWidth,
  } = workbenchPaneGeometry(available, ratio);
  const narrow =
    viewportWidth < 1024 || (available > 0 && available < WORKBENCH_MIN_WIDTH);
  const inlineAux = hasAux && !narrow && !collapsed;
  const [auxHost] = useState(() => {
    const node = document.createElement("div");
    node.className = "agent-workbench-shell__auxiliary-content";
    return node;
  });
  useEffect(() => {
    auxHost.classList.toggle("has-native-scroll", !auxiliaryScroll);
  }, [auxHost, auxiliaryScroll]);
  const attachAux = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot) slot.appendChild(auxHost);
    },
    [auxHost],
  );
  useEffect(() => {
    const measure = () => {
      setAvailable(root.current?.clientWidth ?? 0);
      setViewportWidth(window.innerWidth);
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
    setCollapsed(false);
    setDrawerOpen(false);
  }, [projectId, moduleId]);
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  const focusMain = useCallback(() => {
    const viewport = mainViewport.current;
    const target = viewport?.querySelector<HTMLElement>(
      'textarea:not([disabled]), [tabindex="-1"]',
    );
    (target ?? viewport)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!conversationFocusRequest) return;
    if (drawerOpen) {
      focusMainAfterClose.current = true;
      setDrawerOpen(false);
    } else focusMain();
  }, [conversationFocusRequest, focusMain]);
  useEffect(() => {
    if (!auxiliaryFocusRequest) return;
    if (narrow) setDrawerOpen(true);
    else setCollapsed(false);
  }, [auxiliaryFocusRequest, narrow]);
  const readingKey = `${projectId}:${moduleId}:${taskKey ?? "current"}`;
  const { showLatest, returnToLatest } = useChatReadingPosition(
    mainViewport,
    readingKey,
    readingKey,
    { initialPinned: false, enabled: ownsScroll },
  );
  const changeWidth = (value: number) => {
    const next = Math.max(minAux, Math.min(maxAux, value));
    const nextRatio =
      next / Math.max(1, Math.min(available, WORKBENCH_MAX_WIDTH) - 48);
    setRatio(nextRatio);
    try {
      localStorage.setItem(WORKBENCH_RATIO_KEY, String(nextRatio));
    } catch {}
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current();
    const right = layoutRoot.current?.getBoundingClientRect().right;
    if (right === undefined) return;
    const move = (e: globalThis.PointerEvent) =>
      changeWidth(right - 16 - e.clientX);
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
      <div
        ref={layoutRoot}
        className={`agent-workbench-shell__layout ${inlineAux ? "" : "is-single-pane"} ${hasAux && !inlineAux ? "has-floating-toggle" : ""}`}
      >
        {hasAux && (
          <Button
            ref={toggle}
            className={`agent-workbench-shell__panel-toggle ${inlineAux ? "is-in-panel" : ""}`}
            variant="ghost"
            size="icon"
            aria-label={inlineAux ? "收起任务信息" : "打开任务信息"}
            aria-expanded={inlineAux || drawerOpen}
            title={inlineAux ? "收起浮窗" : "打开浮窗"}
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
        <section className="agent-workbench-shell__main" aria-label="主工作区">
          <div
            ref={mainViewport}
            tabIndex={-1}
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
              title="拖动调整宽度；双击或按 Enter 恢复 2:1"
              onDoubleClick={() =>
                changeWidth((Math.min(available, WORKBENCH_MAX_WIDTH) - 48) / 3)
              }
              aria-valuemin={minAux}
              aria-valuemax={maxAux}
              aria-valuenow={Math.round(renderedWidth)}
              tabIndex={0}
              onPointerDown={resize}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  changeWidth(
                    (Math.min(available, WORKBENCH_MAX_WIDTH) - 48) / 3,
                  );
                  return;
                }
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
              className={`agent-workbench-shell__auxiliary ${agentSwitch ? "" : "has-panel-controls"}`}
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
                focusMain();
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
      {hasAux && !inlineAux && !drawerOpen && (
        <div hidden aria-hidden="true" ref={attachAux} />
      )}
      {hasAux &&
        createPortal(
          <>
            {toolbar}
            {status && (
              <span className="agent-workbench-task-status" role="status">
                {status}
              </span>
            )}
            {auxiliary ?? result ?? children}
          </>,
          auxHost,
        )}
    </section>
  );
}
