import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeFrontendSettings from "./KnowledgeFrontendSettings";
import {
  createPortalDraft,
  portalDraftErrors,
  portalDraftKey,
  readPortalDraft,
  SITE_TABS,
} from "./settings-state";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation(
    (key) => values.get(key) ?? null,
  );
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    values.set(key, value);
  });
  vi.mocked(localStorage.clear).mockImplementation(() => values.clear());
});
describe("project knowledge frontend drafts", () => {
  it("isolates saved and unsaved drafts across projects and operators", () => {
    const { rerender } = render(
      <KnowledgeFrontendSettings ownerId={1} projectId="alpha" />,
    );
    fireEvent.change(screen.getByLabelText("站点名称"), {
      target: { value: "甲项目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    fireEvent.change(screen.getByLabelText("站点名称"), {
      target: { value: "未保存" },
    });
    rerender(<KnowledgeFrontendSettings ownerId={1} projectId="beta" />);
    expect(screen.getByLabelText("站点名称")).toHaveValue("品牌知识中心");
    rerender(<KnowledgeFrontendSettings ownerId={1} projectId="alpha" />);
    expect(screen.getByLabelText("站点名称")).toHaveValue("甲项目");
    rerender(<KnowledgeFrontendSettings ownerId={2} projectId="alpha" />);
    expect(screen.getByLabelText("站点名称")).toHaveValue("品牌知识中心");
  });
  it("keeps invalid edits out of persisted drafts and renders errors", () => {
    render(<KnowledgeFrontendSettings ownerId={1} projectId="alpha" />);
    fireEvent.change(screen.getByLabelText("站点名称"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写站点名称");
    expect(localStorage.getItem(portalDraftKey(1, "alpha"))).toBeNull();
    expect(
      portalDraftErrors({
        ...createPortalDraft(),
        domain: "https://docs.example.com",
        logoLink: "javascript:alert(1)",
      }),
    ).toHaveLength(2);
  });
  it("operates every settings tab, switches and conditional fields without network calls", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<KnowledgeFrontendSettings demo />);
    for (const tab of SITE_TABS) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-label", tab);
    }
    fireEvent.click(screen.getByRole("tab", { name: "搜索" }));
    fireEvent.click(screen.getByRole("switch", { name: "自定义Prompt" }));
    expect(screen.getByLabelText("搜索Prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "页脚" }));
    expect(screen.getByLabelText("页脚标语")).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "启用页脚" }));
    expect(screen.getByLabelText("页脚标语")).toBeEnabled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it("reorders navigation, previews safely and keeps code as inert draft text", () => {
    render(<KnowledgeFrontendSettings demo />);
    fireEvent.click(screen.getByRole("button", { name: "导航栏" }));
    fireEvent.click(screen.getByRole("button", { name: "新增菜单" }));
    fireEvent.change(screen.getByLabelText("菜单3名称"), {
      target: { value: "联系我们" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上移菜单3" }));
    expect(screen.getByLabelText("菜单2名称")).toHaveValue("联系我们");
    fireEvent.click(screen.getByRole("button", { name: "站点设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "嵌入代码" }));
    fireEvent.change(screen.getByLabelText("Head头部代码"), {
      target: { value: "<script>window.hacked = true</script>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "预览站点" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("联系我们")).toBeInTheDocument();
    expect(dialog.querySelector("script")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByLabelText("Head头部代码")).toHaveValue(
      "<script>window.hacked = true</script>",
    );
  });
  it("treats stored images as local assets and rejects corrupt storage", () => {
    const key = portalDraftKey(1, "a");
    localStorage.setItem(
      key,
      JSON.stringify({
        ...createPortalDraft(),
        logo: "https://external.example/tracking.png",
        icon: 'data:image/svg+xml,<svg onload="evil()"/>',
      }),
    );
    expect(readPortalDraft(key).logo).toBe("");
    expect(readPortalDraft(key).icon).toBe("");
    localStorage.setItem(key, "{invalid");
    expect(readPortalDraft(key)).toEqual(createPortalDraft());
  });
  it("keeps WordPress publishing unavailable while exposing the previous workflow explicitly", () => {
    render(<KnowledgeFrontendSettings legacyWorkflow={<div>原有任务</div>} />);
    fireEvent.click(screen.getByRole("button", { name: "AI友好官网" }));
    fireEvent.click(screen.getByRole("button", { name: "域名与部署" }));
    expect(screen.getByRole("button", { name: "连接阿里云" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "现有工作流" }));
    expect(screen.getByText("原有任务")).toBeInTheDocument();
  });
});
