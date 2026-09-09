import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

type ReadingPosition = {
  top: number;
  pinned: boolean;
  anchorId?: string;
  offset?: number;
};
// A task keeps its position when its Agent route temporarily unmounts.
const readingPositions = new Map<string, ReadingPosition>();

export function scrollChatViewportToBottom(
  viewport: Pick<HTMLElement, "scrollHeight" | "scrollTo">,
) {
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
}
export function isChatViewportNearBottom(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  threshold = 96,
) {
  return (
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
    threshold
  );
}

export function useChatReadingPosition(
  viewportRef: RefObject<HTMLDivElement | null>,
  taskKey: string,
  contentKey: string,
  options: { initialPinned?: boolean; enabled?: boolean } = {},
) {
  const [showLatest, setShowLatest] = useState(false);
  const follow = useRef<(() => void) | null>(null);
  const update = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || options.enabled === false) return;
    const saved = readingPositions.get(taskKey);
    let pinned = saved?.pinned ?? options.initialPinned ?? true;
    let pendingRestore: ReadingPosition | null =
      saved && !saved.pinned
        ? saved
        : !pinned
          ? { top: 0, pinned: false }
          : null;
    let anchor: { node: Element; offset: number } | null = null;
    let expectedScrollTop: number | null = null;
    const anchors = () =>
      Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-reading-anchor]"),
      );
    const capture = () => {
      const edge = viewport.getBoundingClientRect().top;
      const node = anchors().find(
        (item) => item.getBoundingClientRect().bottom > edge,
      );
      anchor = node
        ? { node, offset: node.getBoundingClientRect().top - edge }
        : null;
      readingPositions.set(taskKey, {
        top: viewport.scrollTop,
        pinned,
        ...(node
          ? { anchorId: node.dataset.readingAnchor, offset: anchor!.offset }
          : {}),
      });
    };
    const move = (top: number) => {
      viewport.scrollTop = top;
      expectedScrollTop = viewport.scrollTop;
    };
    const reconcile = () => {
      if (pinned) {
        move(viewport.scrollHeight);
      } else if (pendingRestore) {
        move(pendingRestore.top);
        const restoredAnchor = pendingRestore.anchorId
          ? anchors().find(
              (node) => node.dataset.readingAnchor === pendingRestore!.anchorId,
            )
          : null;
        if (restoredAnchor && pendingRestore.offset !== undefined) {
          move(
            viewport.scrollTop +
              restoredAnchor.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              pendingRestore.offset,
          );
          pendingRestore = null;
        } else if (
          viewport.scrollHeight - viewport.clientHeight >=
          pendingRestore.top
        ) {
          pendingRestore = null;
        }
      } else if (anchor?.node.isConnected && viewport.contains(anchor.node)) {
        move(
          viewport.scrollTop +
            anchor.node.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            anchor.offset,
        );
      }
      if (!pendingRestore) capture();
      setShowLatest(
        !pinned && viewport.scrollHeight > viewport.clientHeight + 96,
      );
    };
    const onScroll = () => {
      if (
        expectedScrollTop !== null &&
        Math.abs(viewport.scrollTop - expectedScrollTop) < 1
      ) {
        expectedScrollTop = null;
        return;
      }
      pendingRestore = null;
      expectedScrollTop = null;
      pinned = isChatViewportNearBottom(viewport);
      capture();
      setShowLatest(
        !pinned && viewport.scrollHeight > viewport.clientHeight + 96,
      );
    };
    const interruptRestore = () => {
      pendingRestore = null;
      expectedScrollTop = null;
    };
    const backToLatest = () => {
      pinned = true;
      pendingRestore = null;
      reconcile();
    };
    follow.current = backToLatest;
    update.current = reconcile;
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", interruptRestore, { passive: true });
    viewport.addEventListener("touchstart", interruptRestore, {
      passive: true,
    });
    viewport.addEventListener("pointerdown", interruptRestore, {
      passive: true,
    });
    viewport.addEventListener("keydown", interruptRestore);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reconcile);
    observer?.observe(viewport);
    if (viewport.firstElementChild)
      observer?.observe(viewport.firstElementChild);
    reconcile();
    return () => {
      // Layout cleanup runs before the selected task's DOM is replaced. The
      // last captured anchor remains valid even if that DOM has disappeared.
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", interruptRestore);
      viewport.removeEventListener("touchstart", interruptRestore);
      viewport.removeEventListener("pointerdown", interruptRestore);
      viewport.removeEventListener("keydown", interruptRestore);
      observer?.disconnect();
      follow.current = null;
      update.current = null;
    };
  }, [taskKey, viewportRef, options.enabled, options.initialPinned]);
  useLayoutEffect(() => {
    update.current?.();
  }, [contentKey]);
  const returnToLatest = useCallback(() => follow.current?.(), []);
  return { showLatest, returnToLatest };
}
