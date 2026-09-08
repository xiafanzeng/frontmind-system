import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "wouter";
import { navigate } from "wouter/use-browser-location";
import WorkspaceNavigationBoundary from "./WorkspaceNavigationBoundary";
import { getUnsavedWorkspaceDrafts, registerWorkspaceDraft, requestWorkspaceNavigation, useWorkspaceDraftGuard } from "@/lib/workspace-navigation-guard";

const disposeDrafts: (() => void)[] = [];
beforeEach(() => window.history.replaceState({ original: "kept" }, "", "/?enterpriseProjectId=project-a"));
afterEach(() => { cleanup(); disposeDrafts.splice(0).forEach(dispose => dispose()); });
const register = (save?: () => Promise<boolean>) => { const dispose = registerWorkspaceDraft({ isDirty: () => true, label: "知识节点", save }); disposeDrafts.push(dispose); return dispose; };
const request = (action: () => void) => act(() => requestWorkspaceNavigation(action));

describe("workspace unsaved changes dialog", () => {
  it("keeps the current work when cancelled and discards only on explicit leave", async () => {
    render(<WorkspaceNavigationBoundary />); act(() => { register(); });
    const action = vi.fn(); request(action);
    expect(screen.getByRole("dialog")).toHaveTextContent("知识节点尚未保存");
    expect(screen.queryByRole("button", { name: "保存后离开" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(action).not.toHaveBeenCalled();
    request(action);
    fireEvent.click(screen.getByRole("button", { name: "放弃并离开" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("keeps a failed save editable without navigating", async () => {
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    render(<WorkspaceNavigationBoundary />); act(() => { register(save); });
    const action = vi.fn(); request(action);
    fireEvent.click(screen.getByRole("button", { name: "保存后离开" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续编辑" })).toBeEnabled();
  });
  it("locks duplicate submissions, Escape, close and replacement navigation while saving", async () => {
    let resolve!: (value: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    render(<WorkspaceNavigationBoundary />); act(() => { register(save); });
    const action = vi.fn(), other = vi.fn(); request(action);
    fireEvent.click(screen.getByRole("button", { name: "保存后离开" }));
    fireEvent.click(screen.getByRole("button", { name: "正在保存…" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("button", { name: "放弃并离开" })).toBeDisabled();
    request(other);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    expect(action).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
  it("does not call a draft that disappears while its prompt is open", async () => {
    const save = vi.fn().mockResolvedValue(true);
    render(<WorkspaceNavigationBoundary />);
    let dispose!: () => void; act(() => { dispose = register(save); });
    const action = vi.fn(); request(action);
    act(dispose);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
  it("supports StrictMode effect replay and removes drafts and guards on unmount", () => {
    function Editor() { const [dirty] = useState(true); useWorkspaceDraftGuard({ dirty, label: "编辑内容" }); return <p>编辑器</p>; }
    const view = render(<StrictMode><WorkspaceNavigationBoundary /><Editor /></StrictMode>);
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(1);
    const action = vi.fn(); request(action);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(action).not.toHaveBeenCalled();
    view.unmount();
    expect(getUnsavedWorkspaceDrafts()).toHaveLength(0);
    request(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(window.history.state).toMatchObject({ original: "kept" });
  });
  it("keeps the actual router projection on the original page until a programmatic request is approved", async () => {
    function LocationLabel() { const [path] = useLocation(); return <output data-testid="location">{path}</output>; }
    render(<><WorkspaceNavigationBoundary /><LocationLabel /></>);
    act(() => { register(); });
    act(() => navigate("/publishing?enterpriseProjectId=project-a"));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    fireEvent.click(screen.getByRole("button", { name: "放弃并离开" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/publishing"));
  });

  it("keeps a rejected local save on the current page", async () => {
    render(<WorkspaceNavigationBoundary />);
    const save = vi.fn().mockResolvedValue(false); act(() => { register(save); });
    const action = vi.fn(); request(action);
    fireEvent.click(screen.getByRole("button", { name: "保存后离开" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("修改尚未保存");
    expect(action).not.toHaveBeenCalled();
  });

});
