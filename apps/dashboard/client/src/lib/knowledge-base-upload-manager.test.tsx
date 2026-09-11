import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWorkspaceRestScope, activateWorkspaceUploadScope } from "./workspace-rest-scope";
import { KnowledgeBaseUploadManager, KnowledgeBaseUploadProvider } from "./knowledge-base-upload-manager";
import { EmptyConversationHint, type KnowledgeBaseStarterLifecycle, type KnowledgeBaseStarterStartOutcome } from "@/components/ChatArea";

describe("project-owned knowledge uploads", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("continues a nine-file batch when its page unmounts and presents the same progress on return", async () => {
    let lifecycle!: KnowledgeBaseStarterLifecycle;
    let resolve!: (result: KnowledgeBaseStarterStartOutcome) => void;
    const start = vi.fn((_input, input: KnowledgeBaseStarterLifecycle) => { lifecycle = input; return new Promise<KnowledgeBaseStarterStartOutcome>(r => { resolve = r; }); });
    const page = (visible: boolean) => <StrictMode><KnowledgeBaseUploadProvider>{visible ? <EmptyConversationHint inline uploadScopeKey="project:conversation" companyName="测试企业" companyConfigured companyLoading={false} onStartKnowledgeBase={start}/> : <div>官网制作</div>}</KnowledgeBaseUploadProvider></StrictMode>;
    const view = render(page(true));
    fireEvent.click(screen.getByRole("button", {name: /构建企业知识库/}));
    const files = Array.from({length: 9}, (_, i) => new File([new Uint8Array(10)], `${i}.pdf`, {type: "application/pdf"}));
    fireEvent.change(document.querySelector('input[type="file"]')!, {target: {files}});
    fireEvent.click(screen.getByRole("button", {name: "开始构建"}));
    const ids = [...lifecycle.fileItemIds!];
    view.rerender(page(false));
    await act(async () => { await Promise.resolve(); });
    expect(lifecycle.signal.aborted).toBe(false);
    act(() => { lifecycle.onFileUpdate(ids[0], files[0], {stage: "uploaded", loadedBytes: 10, totalBytes: 10}); lifecycle.onFileUpdate(ids[1], files[1], {stage: "uploading", loadedBytes: 5, totalBytes: 10}); });
    view.rerender(page(true));
    expect(screen.getByText("17%")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "停止上传"})).toBeInTheDocument();
    expect(start).toHaveBeenCalledOnce();
    await act(async () => { resolve({status: "accepted"}); });
    expect(lifecycle.signal.aborted).toBe(false);
  });
  it("keeps the original project on a heartbeat after a delayed reservation", async () => {
    const uploadRelease = activateWorkspaceUploadScope("actor:original");
    const release = activateWorkspaceRestScope("project-original", "original");
    const manager = new KnowledgeBaseUploadManager();
    const batch = manager.batch("original:conversation:0");
    batch.read("fileStates", () => new Map());
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    activateWorkspaceRestScope("account-page");
    batch.startHeartbeat({ conversationId: "conversation", turnId: "turn", clientRequestId: "request", expectedResetRevision: 0 });
    await Promise.resolve();
    expect(fetch.mock.calls[0]?.[1].headers["x-enterprise-project-id"]).toBe("original");
    manager.dispose();
    release();
    uploadRelease();
  });
  it("shows uploaded and total decimal sizes during the upload", () => {
    const start = vi.fn(() => new Promise<KnowledgeBaseStarterStartOutcome>(() => {}));
    render(<KnowledgeBaseUploadProvider><EmptyConversationHint inline uploadScopeKey="sizes" companyName="测试企业" companyConfigured companyLoading={false} onStartKnowledgeBase={start}/></KnowledgeBaseUploadProvider>);
    fireEvent.click(screen.getByRole("button", {name: /构建企业知识库/}));
    fireEvent.change(document.querySelector('input[type="file"]')!, {target: {files: [new File([new Uint8Array(1_000_000)], "资料.pdf")]}});
    fireEvent.click(screen.getByRole("button", {name: "开始构建"}));
    expect(screen.getByText(/已上传.*0 B.*1.0 MB/)).toBeInTheDocument();
  });
  it("waits for durable stop confirmation and prevents dispatch after it", async () => {
    const manager = new KnowledgeBaseUploadManager();
    const batch = manager.batch("stop:0");
    const coordinate = { conversationId: "conversation", turnId: "turn", clientRequestId: "request", expectedResetRevision: 0, uploadAttemptId: "attempt-1" };
    batch.bindCoordinate(coordinate);
    const { controller } = batch.beginAttempt();
    let confirm!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { confirm = resolve; })));
    const stop = batch.stop();
    expect(controller.signal.aborted).toBe(true);
    expect(batch.read("stopState", "active")).toBe("stopping");
    confirm(new Response(JSON.stringify({ ...coordinate, buildId: "build", resetRevision: 0, generation: 1, stateEpoch: 1, uploadStatusVersion: 2, uploadAttemptId: "attempt-1", runPhase: "cancelled", controlState: "stopped", files: [], totalFiles: 0, totalBytes: 0, confirmedFiles: 0, confirmedBytes: 0, readyToDispatch: false, allowedActions: ["resume"] })));
    await stop;
    expect(batch.read("stopState", "active")).toBe("stopped");
    const dispatch = vi.fn();
    await expect(batch.dispatch(dispatch)).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
    manager.dispose();
  });
  it("performs one silent status check after ninety seconds without byte progress", async () => {
    vi.useFakeTimers();
    const manager = new KnowledgeBaseUploadManager();
    const batch = manager.batch("stall:0");
    const coordinate = { conversationId: "conversation", turnId: "turn", clientRequestId: "request", expectedResetRevision: 0 };
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("upload-status") ? { ...coordinate, buildId: "build", resetRevision: 0, generation: 1, stateEpoch: 1, uploadStatusVersion: 1, uploadAttemptId: "attempt-1", runPhase: "uploading", controlState: "active", files: [], totalFiles: 1, totalBytes: 10, confirmedFiles: 0, confirmedBytes: 0, readyToDispatch: false, allowedActions: ["stop", "upload"] } : {})));
    vi.stubGlobal("fetch", fetch);
    batch.beginAttempt();
    batch.startHeartbeat(coordinate);
    // Normal server-side staging takes well past thirty seconds; the batch
    // must stay quiet instead of flashing connection warnings at the user.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.mock.calls.filter(([url]) => url.includes("upload-status"))).toHaveLength(0);
    expect(batch.read("checkMessage", "")).toBe("");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch.mock.calls.filter(([url]) => url.includes("upload-status"))).toHaveLength(1);
    expect(batch.read("checking", false)).toBe(false);
    // Heartbeat-driven checks are silent: state refreshes without a message.
    expect(batch.read("checkMessage", "")).toBe("");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch.mock.calls.filter(([url]) => url.includes("upload-status"))).toHaveLength(1);
    batch.noteTransfer("file", 9, 1);
    batch.noteTransfer("file", 0, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    batch.noteTransfer("file", 1, 2);
    expect(batch.read("lastProgressAt", 0)).toBe(Date.now());
    manager.dispose();
  });
  it("retires the controller and file objects at reset and project disposal", () => {
    const manager = new KnowledgeBaseUploadManager();
    const old = manager.batch("conv:1"); old.controller = new AbortController();
    manager.retireOtherRevisions("conv:", "conv:2");
    expect(old.controller.signal.aborted).toBe(true); expect(old.disposed).toBe(true);
    const fresh = manager.batch("conv:2"); fresh.controller = new AbortController(); manager.dispose();
    expect(fresh.controller.signal.aborted).toBe(true);
  });
});
