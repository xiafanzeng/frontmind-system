import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Modal from "./Modal";
import MonitorForm from "./MonitorForm";
import type { MonitorInput, ProjectSummary, ProviderModel } from "../domain";

const project: ProjectSummary = {
  id: "project",
  name: "内联验收",
  brandName: "本地品牌",
  brandAliases: [],
  competitors: [],
  timezone: "Asia/Shanghai",
};
const model: ProviderModel = {
  id: "deepseek",
  code: "deepseek",
  name: "DeepSeek",
  clientType: "web",
  enabled: true,
  verified: true,
  capabilities: {
    reasoning: true,
    screenshot: true,
    region: true,
    overseas: false,
  },
};
const initial: MonitorInput = {
  name: "来源任务监控",
  competitors: [],
  questions: ["本地品牌如何交付？"],
  platforms: [
    {
      platformId: model.id,
      providerCode: model.code,
      clientType: "web",
      mode: "search",
      screenshot: 0,
      regionCode: null,
    },
  ],
  repetitions: 1,
  schedule: { type: "none", timezone: "Asia/Shanghai" },
};

// Check the inline selectors against the real form nodes. Browser measurement
// covers pixel geometry; this contract prevents reintroducing dialog sizing or
// a selector that never matches the actual header, body and controls.
function inlineStyles(element: Element) {
  const css = readFileSync(
    resolve(process.cwd(), "client/src/dashboard/business-module-flows.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations: Record<string, string> = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    if (
      !selector.includes(".monitoring-inline-step") ||
      selector.startsWith("@")
    )
      continue;
    if (!element.matches(selector)) continue;
    for (const declaration of match[2]!.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon >= 0)
        declarations[declaration.slice(0, colon).trim()] = declaration
          .slice(colon + 1)
          .trim();
    }
  }
  return declarations;
}

it("keeps actual inline form surfaces in the reading column and preserves all schedule options", async () => {
  const submit = vi.fn<
    (input: MonitorInput, runNow: boolean) => Promise<unknown>
  >(async () => undefined);
  render(
    <div className="monitoring-module monitoring-conversation-shell">
      <Modal inline open size="wide" title="配置监控" onClose={vi.fn()}>
        <MonitorForm
          project={project}
          models={[model]}
          initial={initial}
          regions={[{ code: "cn", name: "中国", scope: "domestic" }]}
          availableBalanceTenThousandths="100000"
          quoteRunCost={async () => ({ totalAmountTenThousandths: "900" })}
          onCancel={vi.fn()}
          onSubmit={submit}
        />
      </Modal>
    </div>,
  );
  const step = screen.getByRole("region", { name: "配置监控" });
  expect(step).not.toHaveClass("modal-wide");
  expect(step).not.toHaveClass("modal-card");
  expect(inlineStyles(step)).toMatchObject({
    width: "100%",
    "max-width": "100%",
    height: "auto",
    margin: "0",
    border: "0",
    "box-shadow": "none",
  });
  for (const selector of [
    ".modal-header",
    ".monitor-form",
    ".monitor-form-body",
    ".monitor-form-footer",
  ]) {
    expect(inlineStyles(step.querySelector(selector)!)).toMatchObject({
      width: "100%",
      "min-width": "0",
      "max-width": "100%",
      height: "auto",
      padding: "0",
      overflow: "visible",
    });
  }
  expect(
    inlineStyles(step.querySelector(".monitor-form-body")!)[
      "grid-template-columns"
    ],
  ).toBe("minmax(0, 1fr)");
  for (const name of [
    "添加竞品",
    "导入问题",
    "批量粘贴",
    "编辑问题 1",
    "删除问题 1",
  ]) {
    expect(inlineStyles(screen.getByRole("button", { name }))).toMatchObject({
      display: "inline-flex",
      "min-height": "44px",
      "min-width": "44px",
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "添加竞品" }));
  fireEvent.change(screen.getByRole("textbox", { name: "竞品 1 名称" }), {
    target: { value: "对比品牌" },
  });
  fireEvent.click(screen.getByRole("button", { name: "开启" }));
  fireEvent.change(screen.getByRole("combobox", { name: "执行频率" }), {
    target: { value: "weekly" },
  });
  fireEvent.change(screen.getByLabelText("星期"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("执行时间"), {
    target: { value: "09:30" },
  });
  fireEvent.change(screen.getByLabelText("时区"), { target: { value: "UTC" } });
  fireEvent.change(screen.getByLabelText("重复次数"), {
    target: { value: "2" },
  });
  fireEvent.change(
    screen.getByRole("combobox", { name: "DeepSeek网页版截图策略" }),
    { target: { value: "1" } },
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "DeepSeek网页版提问位置" }),
    { target: { value: "cn" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "保存监控" }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0]).toMatchObject({
    name: "来源任务监控",
    questions: initial.questions,
    competitors: [{ name: "对比品牌", aliases: [] }],
    platforms: [
      { platformId: model.id, mode: "search", screenshot: 1, regionCode: "cn" },
    ],
    repetitions: 2,
    schedule: {
      type: "weekly",
      weekday: 3,
      localTime: "09:30",
      timezone: "UTC",
    },
  });
  expect(submit.mock.calls[0]![1]).toBe(false);
});
