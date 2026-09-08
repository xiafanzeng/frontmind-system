import { useEffect, useRef } from "react";

export type WorkspaceDraft = { isDirty: () => boolean; label: string; save?: () => Promise<boolean> };
const drafts = new Set<WorkspaceDraft>();
const listeners = new Set<() => void>();
let navigatePrompt: ((action: () => void, drafts: WorkspaceDraft[]) => void) | null = null;
let bypass = false;
const changed = () => { for (const listener of listeners) listener(); };

export function subscribeWorkspaceDrafts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerWorkspaceDraft(draft: WorkspaceDraft) {
  drafts.add(draft);
  changed();
  return () => { drafts.delete(draft); changed(); };
}
export function getUnsavedWorkspaceDrafts() { return [...drafts].filter(draft => draft.isDirty()); }
export function requestWorkspaceNavigation(action: () => void) {
  const unsaved = getUnsavedWorkspaceDrafts();
  if (!bypass && unsaved.length && navigatePrompt) { navigatePrompt(action, unsaved); return; }
  action();
}
export function performApprovedWorkspaceNavigation(action: () => void) {
  const previous = bypass;
  bypass = true;
  try { action(); } finally { bypass = previous; }
}
export function useWorkspaceDraftGuard(input: { dirty: boolean; label: string; save?: () => Promise<boolean> }) {
  const current = useRef(input);
  current.current = input;
  useEffect(() => registerWorkspaceDraft({
    isDirty: () => current.current.dirty,
    label: input.label,
    ...(input.save ? { save: () => current.current.save?.() ?? Promise.resolve(false) } : {}),
  }), [input.label, Boolean(input.save)]);
  useEffect(changed, [input.dirty]);
}

const ENTRY = "__frontmindWorkspaceEntry";
const ORIGINAL_STATE = "__frontmindWorkspaceOriginalState";
const isSamePage = (next: URL) => next.pathname === window.location.pathname && next.search === window.location.search;

/** Installed once by the mounted boundary, with matching cleanup. Existing router
 * state is retained; a private index lets cancelled traversals return to their entry. */
export function installWorkspaceNavigationGuard(prompt: NonNullable<typeof navigatePrompt>) {
  navigatePrompt = prompt;
  const history = window.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let live = true;
  let position = typeof history.state?.[ENTRY] === "number" ? history.state[ENTRY] as number : 0;
  let restoring = false;
  let approvedTraversal: number | null = null;
  let afterRestore: (() => void) | null = null;
  let leavingApproved = false;
  const stamp = (state: unknown, value: number) => ({
    ...(state && typeof state === "object" && !Array.isArray(state) && Object.getPrototypeOf(state) === Object.prototype
      ? state : state == null ? {} : { [ORIGINAL_STATE]: state }),
    [ENTRY]: value,
  });
  replace.call(history, stamp(history.state, position), "", window.location.href);
  const scopedRequest = (action: () => void) => requestWorkspaceNavigation(() => { if (live) action(); });

  const guardedPush: History["pushState"] = function (state, unused, url) {
    const run = () => {
      const nextPosition = position + 1;
      push.call(history, stamp(state, nextPosition), unused, url);
      position = nextPosition;
      leavingApproved = false;
    };
    const next = new URL(url == null ? window.location.href : String(url), window.location.href);
    if (isSamePage(next)) run(); else scopedRequest(run);
  };
  const guardedReplace: History["replaceState"] = function (state, unused, url) {
    const run = () => replace.call(history, stamp(state, position), unused, url);
    const next = new URL(url == null ? window.location.href : String(url), window.location.href);
    if (isSamePage(next)) run(); else scopedRequest(run);
  };
  history.pushState = guardedPush;
  history.replaceState = guardedReplace;

  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || bypass || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!target || target.hasAttribute("download") || (target.target && target.target !== "_self")) return;
    const next = new URL(target.href, window.location.href);
    if (next.origin !== window.location.origin || isSamePage(next) || !getUnsavedWorkspaceDrafts().length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    scopedRequest(() => {
      leavingApproved = true;
      const replay = new MouseEvent("click", { bubbles: true, cancelable: true });
      performApprovedWorkspaceNavigation(() => target.dispatchEvent(replay));
      // SPA links prevent the browser default. They must still protect later reloads.
      if (replay.defaultPrevented) leavingApproved = false;
    });
  };
  const pop = (event: PopStateEvent) => {
    const next = event.state?.[ENTRY];
    if (restoring) {
      event.stopImmediatePropagation();
      if (typeof next === "number" && next !== position) { history.go(position - next); return; }
      restoring = false;
      const action = afterRestore;
      afterRestore = null;
      if (action) scopedRequest(action);
      return;
    }
    if (typeof next !== "number") return; // Cross-document traversal is protected by beforeunload.
    if (approvedTraversal === next || !getUnsavedWorkspaceDrafts().length) {
      position = next; approvedTraversal = null; return;
    }
    if (next === position) return;
    event.stopImmediatePropagation();
    const delta = next - position;
    restoring = true;
    afterRestore = () => { approvedTraversal = next; history.go(delta); };
    history.go(-delta);
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (leavingApproved || bypass || !getUnsavedWorkspaceDrafts().length) return;
    event.preventDefault(); event.returnValue = "";
  };
  window.addEventListener("click", click, true);
  window.addEventListener("popstate", pop, true);
  window.addEventListener("beforeunload", unload);
  return () => {
    live = false;
    if (navigatePrompt === prompt) navigatePrompt = null;
    if (history.pushState === guardedPush) history.pushState = push;
    if (history.replaceState === guardedReplace) history.replaceState = replace;
    window.removeEventListener("click", click, true);
    window.removeEventListener("popstate", pop, true);
    window.removeEventListener("beforeunload", unload);
  };
}
