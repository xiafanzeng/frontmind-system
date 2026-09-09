import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import {
  PublishingFlowBridge,
  publishingTaskResumePath,
} from "./PublishingFlowContext";
import { PublishingGatewayProvider } from "./PublishingContext";
import ImportPage from "./pages/ImportPage";
import type { PublisherGateway } from "./gateway";

const mocks = vi.hoisted(() => ({
  workspace: {
    isWorkbench: false,
    agentId: "publishing",
    setSummary: vi.fn(),
    task: null as any,
  },
}));
vi.mock("@/dashboard/BusinessWorkspaceContext", () => ({
  useBusinessWorkspace: () => mocks.workspace,
}));

function task(
  id: string,
  resources: Array<{ kind: string; id: string }>,
  step = "start",
) {
  return {
    hydrated: true,
    taskId: id,
    state: { resources, step, values: {} },
    ensureTask: vi.fn(),
    saveState: vi.fn(),
    handoff: vi.fn(),
  };
}
describe("publishing task restoration", () => {
  it("opens the selected task's draft after history changes, clears the previous resource for a new task, and keeps explicit navigation within a task", () => {
    const location = memoryLocation({
      path: "/publishing/drafts/old-task-draft/review",
      record: true,
    });
    mocks.workspace.isWorkbench = true;
    mocks.workspace.task = task(
      "history-b",
      [{ kind: "publication_draft", id: "draft-b" }],
      "titles",
    );
    const view = () => (
      <Router hook={location.hook} searchHook={location.searchHook}>
        <PublishingFlowBridge>
          <span>任务内容</span>
        </PublishingFlowBridge>
      </Router>
    );
    const { rerender } = render(view());
    expect(location.history.at(-1)).toBe(
      "/publishing/drafts/draft-b/review?workbenchTask=history-b",
    );
    mocks.workspace.task = task("new-c", []);
    rerender(view());
    expect(location.history.at(-1)).toBe("/publishing?workbenchTask=new-c");
    act(() => location.navigate("/publishing/drafts/chosen-draft/titles"));
    rerender(view());
    expect(location.history.at(-1)).toBe(
      "/publishing/drafts/chosen-draft/titles",
    );
  });

  it("resumes media filters and frozen version, the editable article, and real submitted batch by resource type", () => {
    const media = publishingTaskResumePath("media", {
      step: "media-bound",
      resources: [
        { kind: "article_version", id: "version-a" },
        { kind: "publication_draft", id: "draft-a" },
      ],
      values: {
        mediaFilters: {
          kind: "self_media",
          query: "科技",
          priceMax: "200",
          page: 3,
        },
      },
    });
    const url = new URL(media, "https://frontmind.invalid");
    expect(url.pathname).toBe("/publishing/media");
    expect(url.searchParams.get("articleVersion")).toBe("version-a");
    expect(url.searchParams.get("query")).toBe("科技");
    expect(url.searchParams.get("page")).toBe("3");
    expect(
      publishingTaskResumePath("articles", {
        resources: [{ kind: "article", id: "article-a" }],
        step: "article-frozen",
        values: {},
      }),
    ).toBe("/publishing/articles/article-a/edit");
    expect(
      publishingTaskResumePath("publishing", {
        resources: [{ kind: "publication_batch", id: "batch-a" }],
        step: "submitted",
        values: {},
      }),
    ).toBe("/publishing/publications/batch-a");
  });

  it("does not navigate away from a new task after an old DOCX import completes", async () => {
    let finish!: (value: { articleId: string }) => void;
    const gateway = {
      importDocx: vi.fn(
        () =>
          new Promise<{ articleId: string }>((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as PublisherGateway;
    const location = memoryLocation({
      path: "/publishing/articles/new/import",
      record: true,
    });
    const view = (open: boolean) => (
      <Router hook={location.hook} searchHook={location.searchHook}>
        <PublishingGatewayProvider gateway={gateway}>
          {open ? <ImportPage /> : <p>另一项任务</p>}
        </PublishingGatewayProvider>
      </Router>
    );
    const { rerender } = render(view(true));
    fireEvent.change(screen.getByLabelText("选择 DOCX 文件"), {
      target: { files: [new File(["docx"], "品牌稿件.docx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "安全导入并编辑" }));
    expect(gateway.importDocx).toHaveBeenCalledOnce();
    rerender(view(false));
    act(() => location.navigate("/publishing/articles?workbenchTask=new-task"));
    await act(async () => finish({ articleId: "old-import-result" }));
    expect(location.history.at(-1)).toBe(
      "/publishing/articles?workbenchTask=new-task",
    );
    expect(screen.getByText("另一项任务")).toBeVisible();
  });
});
