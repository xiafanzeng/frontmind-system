import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from "react";
import {
  useChatReadingPosition,
} from "@/hooks/useChatReadingPosition";
import {
  useWorkbenchModule,
  type WorkbenchAction,
} from "@/dashboard/agent-workbench";
import { WORKBENCH_AUX_WIDTHS } from "@/dashboard/workbench-presentation";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import "./AgentWorkbenchShell.css";
import { OPERATOR_MODULES } from "@/dashboard/operator-navigation";
export type { WorkbenchAction } from "@/dashboard/agent-workbench";
export type AgentWorkbenchShellProps = {
  projectId: string;
  moduleId: string;
  title: string;
  main?: ReactNode;
  auxiliary?: ReactNode;
  composer?: ReactNode;
  layout?: "single" | "workflow" | "knowledge" | "workspace";
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
  /** Right-aligned controls in the thin top bar. */
  topbarActions?: ReactNode;
  /** Focus target for the screen-reader workbench heading in the top bar. */
  titleRef?: React.RefObject<HTMLHeadingElement | null>;
};
export const WORKBENCH_RATIO_KEY = "frontmind.workbench.v5.auxiliary-ratio";
export const WORKBENCH_MIN_WIDTH = 768;
const DEFAULT_AUXILIARY_RATIO = 2 / 7;

export function workbenchPaneGeometry(
  available: number,
  ratio = DEFAULT_AUXILIARY_RATIO,
) {
  // Two 16px outer gutters and one 16px resize track belong to neither pane.
  const content = Math.max(0, available - 48);
  const maxAux = Math.max(200, content - 480);
  return {
    minAux: 200,
    maxAux,
    width: Math.max(200, Math.min(maxAux, content * ratio)),
  };
}

function savedRatio() {
  try {
    const value = Number(localStorage.getItem(WORKBENCH_RATIO_KEY));
    return value > 0 && value < 1 ? value : DEFAULT_AUXILIARY_RATIO;
  } catch {
    return DEFAULT_AUXILIARY_RATIO;
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
  topbarActions,
  titleRef,
}: AgentWorkbenchShellProps) {
  const module = useWorkbenchModule();
  const themeId = module?.id ?? (moduleId === "content-production" ? "content" : moduleId);
  const moduleColor = OPERATOR_MODULES.find(
    (item) => item.id === themeId || item.views.some((view) => view.id === themeId),
  )?.color;
  const layout = requestedLayout ?? (!showResult ? "single" : "workflow");
  const isKnowledge = layout === "knowledge";
  const isWorkspace = layout === "workspace";
  const hasAux = layout !== "single" && !isWorkspace;
  const fixedAuxWidth = WORKBENCH_AUX_WIDTHS[moduleId];
  const ownsScroll = scrollMain ?? main !== undefined;
  const [ratio, setRatio] = useState(savedRatio);
  const [available, setAvailable] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [visibleHeight, setVisibleHeight] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const mainViewport = useRef<HTMLDivElement>(null);
  const layoutRoot = useRef<HTMLDivElement>(null);
  const auxiliaryPanel = useRef<HTMLElement>(null);
  const stopDrag = useRef<() => void>(() => undefined);
  const paneGeometry = workbenchPaneGeometry(available, ratio);
  const minAux = paneGeometry.minAux;
  const maxAux = paneGeometry.maxAux;
  const renderedWidth = fixedAuxWidth ?? paneGeometry.width;
  const narrow = viewportWidth < WORKBENCH_MIN_WIDTH;
  useEffect(() => {
    const measure = () => {
      setAvailable(
        layoutRoot.current?.clientWidth ?? root.current?.clientWidth ?? 0,
      );
      setViewportWidth(window.innerWidth);
      const viewport = window.visualViewport;
      setVisibleHeight(
        viewport && viewport.scale === 1
          ? Math.max(
              0,
              viewport.height -
                Math.max(
                  0,
                  (root.current?.getBoundingClientRect().top ?? 0) -
                    viewport.offsetTop,
                ),
            )
          : null,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      stopDrag.current();
    };
  }, []);
  const focusMain = useCallback(() => {
    const viewport = mainViewport.current;
    const target = viewport?.querySelector<HTMLElement>(
      'textarea:not([disabled]), [tabindex="-1"]',
    );
    (target ?? viewport)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!conversationFocusRequest) return;
    focusMain();
  }, [conversationFocusRequest, focusMain]);
  useEffect(() => {
    if (!auxiliaryFocusRequest) return;
    auxiliaryPanel.current?.focus({ preventScroll: true });
  }, [auxiliaryFocusRequest]);
  const readingKey = `${projectId}:${moduleId}:${taskKey ?? "current"}`;
  const { showLatest, returnToLatest } = useChatReadingPosition(
    mainViewport,
    readingKey,
    readingKey,
    { initialPinned: false, enabled: ownsScroll },
  );
  const changeWidth = (value: number) => {
    if (fixedAuxWidth) return;
    const next = Math.max(minAux, Math.min(maxAux, value));
    const nextRatio = next / Math.max(1, available - 48);
    setRatio(nextRatio);
    try {
      localStorage.setItem(WORKBENCH_RATIO_KEY, String(nextRatio));
    } catch {}
  };
  const resetWidth = () => {
    setRatio(DEFAULT_AUXILIARY_RATIO);
    try {
      localStorage.removeItem(WORKBENCH_RATIO_KEY);
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
    <nav
      className="agent-workbench-subagents agent-workbench-subagents--bar"
      aria-label="切换业务子页面"
    >
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
            { "--subagent-color": action.color ?? moduleColor ?? "var(--module-accent, #667085)" } as CSSProperties
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
      className={`agent-workbench-shell layout-${layout} module-${moduleId} ${narrow ? "is-stacked" : ""}`}
      aria-label={`${title}工作区`}
      data-layout={layout}
      style={
        {
          "--agent-aux-width": `${renderedWidth}px`,
          ...(narrow && visibleHeight !== null
            ? { maxHeight: `${visibleHeight}px` }
            : {}),
          ...(moduleColor
            ? { "--module-color": moduleColor, "--module-accent": moduleColor }
            : {}),
        } as CSSProperties
      }
    >
      <header className="agent-workbench-topbar">
        <div className="agent-workbench-topbar__canvas">
          <div className="agent-workbench-topbar__inner">
            {module ? (
              <span className="agent-workbench-topbar__group" title={module.label}>
                {module.label}
              </span>
            ) : (
              <span className="agent-workbench-topbar__group">{title}</span>
            )}
            {agentSwitch}
          </div>
          <h2 ref={titleRef} tabIndex={-1} className="agent-workbench-topbar__heading">
            {title}
          </h2>
          {topbarActions ? (
            <div className="agent-workbench-topbar__actions">{topbarActions}</div>
          ) : null}
        </div>
      </header>
      <div
        ref={layoutRoot}
        className={`agent-workbench-shell__layout ${hasAux ? "has-outcomes" : "is-single-pane"}${isWorkspace ? " is-workspace" : ""}${fixedAuxWidth ? " is-fixed-auxiliary" : ""}`}
      >
        <section className="agent-workbench-shell__main" aria-label="主工作区">
          <div
            ref={mainViewport}
            tabIndex={-1}
            className={`agent-workbench-shell__main-content ${ownsScroll ? "is-scrollable" : "has-native-scroll"}`}
          >
            {isWorkspace ? (
              <div className="agent-workspace-frame">{main ?? conversation}</div>
            ) : (
              (main ?? conversation)
            )}
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
        {hasAux && (
          <>
            <div
              className="agent-workbench-shell__resize"
              role="separator"
              aria-label="调整任务信息面板宽度"
              aria-orientation="vertical"
              title="拖动调整宽度；双击或按 Enter 恢复默认宽度"
              onDoubleClick={resetWidth}
              aria-valuemin={minAux}
              aria-valuemax={maxAux}
              aria-valuenow={Math.round(renderedWidth)}
              tabIndex={narrow || fixedAuxWidth ? -1 : 0}
              hidden={narrow || Boolean(fixedAuxWidth)}
              onPointerDown={resize}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  resetWidth();
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
              ref={auxiliaryPanel}
              tabIndex={-1}
              className={`agent-workbench-shell__auxiliary ${auxiliaryScroll ? "" : "has-native-auxiliary"}`}
              aria-label={isKnowledge ? "知识节点与资料" : "任务辅助区"}
            >
              <div
                className={`agent-workbench-shell__auxiliary-content ${auxiliaryScroll ? "" : "has-native-scroll"}`}
              >
                {toolbar}
                {status && (
                  <span className="agent-workbench-task-status" role="status">
                    {status}
                  </span>
                )}
                {auxiliary ?? result ?? children ?? (
                  <p className="workbench-panel-empty">
                    {resultTitle}将在处理资料后显示。
                  </p>
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
