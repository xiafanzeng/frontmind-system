import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { navigate } from "wouter/use-browser-location";
import { getUnsavedWorkspaceDrafts, installWorkspaceNavigationGuard, performApprovedWorkspaceNavigation, registerWorkspaceDraft, requestWorkspaceNavigation } from "./workspace-navigation-guard";

const cleanup: (() => void)[] = [];
let pending: (() => void) | undefined;
let prompt: ReturnType<typeof vi.fn>;
const dirty = () => { const dispose = registerWorkspaceDraft({ isDirty: () => true, label: "节点草稿" }); cleanup.push(dispose); return dispose; };
const approve = () => { expect(pending).toBeTypeOf("function"); performApprovedWorkspaceNavigation(pending!); pending = undefined; };
beforeEach(() => {
  window.history.replaceState({ retained: "original" }, "", "/?enterpriseProjectId=project-a");
  pending = undefined;
  prompt = vi.fn(action => { pending = action; });
  cleanup.push(installWorkspaceNavigationGuard(prompt));
});
afterEach(() => { cleanup.reverse().forEach(dispose => dispose()); cleanup.length = 0; document.body.innerHTML = ""; });

describe("workspace navigation guard", () => {
  it("protects project button callbacks and resumes only after approval", () => {
    dirty();
    const action = vi.fn();
    requestWorkspaceNavigation(action);
    expect(action).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
    approve();
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("protects router push and replace while retaining native router state", () => {
    dirty();
    navigate("/publishing?enterpriseProjectId=project-a", { state: { retained: "destination", nested: { id: 4 } } });
    expect(window.location.pathname).toBe("/");
    approve();
    expect(window.location.pathname).toBe("/publishing");
    expect(window.history.state).toMatchObject({ retained: "destination", nested: { id: 4 } });
    navigate("/account", { replace: true, state: { retained: "account" } });
    expect(window.location.pathname).toBe("/publishing");
    approve();
    expect(window.history.state).toMatchObject({ retained: "account" });
  });
  it("replays a native link once and still protects subsequent reloads for SPA links", () => {
    dirty();
    const link = document.createElement("a");
    link.href = "/publishing?enterpriseProjectId=project-a";
    const handler = vi.fn((event: MouseEvent) => { event.preventDefault(); navigate(link.href); });
    link.addEventListener("click", handler);
    document.body.append(link);
    link.click();
    expect(handler).not.toHaveBeenCalled();
    approve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/publishing");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });
  it("does not intercept downloads, modified clicks, or hash-only navigation", () => {
    dirty();
    for (const [href, download, control] of [["/file.zip", true, false], ["/publishing", false, true], ["/?enterpriseProjectId=project-a#node", false, false]] as const) {
      const link = document.createElement("a"); link.href = href;
      if (download) link.download = "file.zip";
      link.addEventListener("click", event => event.preventDefault()); document.body.append(link);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: control }));
    }
    window.history.replaceState({ retained: "updated" }, "", window.location.href);
    expect(prompt).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({ retained: "updated" });
  });
  it("restores a cancelled Back before showing the prompt, then permits Back and Forward", async () => {
    navigate("/publishing?enterpriseProjectId=project-a");
    navigate("/publishing/media?enterpriseProjectId=project-a");
    dirty();
    window.history.back();
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/publishing/media");
    // No approval means both the location and current mounted work remain in place.
    approve();
    await waitFor(() => expect(window.location.pathname).toBe("/publishing"));
    window.history.forward();
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(window.location.pathname).toBe("/publishing");
    approve();
    await waitFor(() => expect(window.location.pathname).toBe("/publishing/media"));
  });
  it("removes listeners and wrappers without permitting a stale captured action", () => {
    dirty();
    navigate("/publishing");
    const old = pending!;
    const uninstall = cleanup.shift()!;
    uninstall();
    performApprovedWorkspaceNavigation(old);
    expect(window.location.pathname).toBe("/");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    navigate("/account");
    expect(window.location.pathname).toBe("/account");
  });
  it("does not leak a bypass through nested approved actions", () => {
    dirty();
    performApprovedWorkspaceNavigation(() => {
      performApprovedWorkspaceNavigation(() => navigate("/publishing"));
      navigate("/publishing/media");
    });
    expect(prompt).not.toHaveBeenCalled();
    navigate("/account");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  it("unregisters abandoned drafts", () => {
    const dispose = dirty();
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(1);
    dispose();
    navigate("/account");
    expect(prompt).not.toHaveBeenCalled();
  });
});
