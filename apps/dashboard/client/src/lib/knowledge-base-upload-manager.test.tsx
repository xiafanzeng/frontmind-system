import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeBaseUploadManager, KnowledgeBaseUploadProvider } from "./knowledge-base-upload-manager";
import { EmptyConversationHint, type KnowledgeBaseStarterLifecycle, type KnowledgeBaseStarterStartOutcome } from "@/components/ChatArea";

describe("project-owned knowledge uploads", () => {
  afterEach(() => vi.unstubAllGlobals());
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
  it("retires the controller and file objects at reset and project disposal", () => {
    const manager = new KnowledgeBaseUploadManager();
    const old = manager.batch("conv:1"); old.controller = new AbortController();
    manager.retireOtherRevisions("conv:", "conv:2");
    expect(old.controller.signal.aborted).toBe(true); expect(old.disposed).toBe(true);
    const fresh = manager.batch("conv:2"); fresh.controller = new AbortController(); manager.dispose();
    expect(fresh.controller.signal.aborted).toBe(true);
  });
});
