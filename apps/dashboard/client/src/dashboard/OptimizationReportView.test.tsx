import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OptimizationReportView, {
  type OptimizationReportData,
} from "./OptimizationReportView";

const report: OptimizationReportData = {
  period: "2026 第二季度 GEO 优化周报｜第 16 周",
  title: "验收企业生成式引擎优化周报",
  subtitle: "用于核验平台表现、决策旅程、信源结构与下一阶段行动。",
  executiveSummary: [
    "企业主体与官方入口识别稳定，服务边界口径仍需补强。",
    "优化目标从被提到升级为被准确、靠前并带证据地提到。",
  ],
  kpis: [
    ["品牌出现率", "40.0%", "72.0%", 72, "进入 AI 答案的稳定性"],
    ["平均位次", "10.6", "6.2", 61, "方案推荐列表中的平均位置"],
  ],
  platforms: [
    [
      "DeepSeek",
      "6.1",
      "38%",
      "92%",
      "56%",
      "标签边界仍需澄清。",
      "补充标准答案与官方证据。",
    ],
    [
      "豆包",
      "6.8",
      "32%",
      "89%",
      "48%",
      "社媒经验贴权重偏高。",
      "增加交付与服务证据卡。",
    ],
  ],
  journeys: [
    [
      "认知期",
      "品牌信息",
      "验收企业的主体与服务边界是什么？",
      "企业定位容易被简单化。",
      "建立主体与服务边界说明页。",
    ],
    [
      "决策期",
      "品类可见",
      "企业如何选择适合的服务方案？",
      "品类入口覆盖不足。",
      "制作方案选择清单页。",
    ],
  ],
  competitorTiers: [
    [
      "第一梯队",
      "同类方案 A、同类方案 B",
      "更容易被优先列入推荐。",
      "突出差异能力与适用业务场景。",
    ],
  ],
  sourceMix: [
    [
      "企业官网 / 服务说明页",
      "32%",
      "主体、方案、服务与交付",
      "增强页面标题的机器可读性。",
    ],
    ["社媒问答 / 论坛经验贴", "12%", "学费、体验与个案", "仅用于监测风险。"],
  ],
  risks: [
    [
      "服务边界与交付承诺",
      "中",
      "多类概念容易被压缩表述。",
      "拆分三段式 FAQ。",
    ],
  ],
  roadmap: [
    ["短期 1-4 周", "修口径、补入口", "上线机器可读 FAQ 并完成第一轮复测。"],
    ["长期 3-6 个月", "建机制、稳复测", "建立季度复测和信源刷新机制。"],
  ],
  reportRecords: [
    [
      "第 16 周周报",
      "480 个问题 × 7 平台",
      "官方源引用率是本阶段核心抓手。",
      "本次模拟填充",
    ],
    [
      "复测记录 03",
      "信源引用与风险议题",
      "需要提高官网与交付报告的引用比例。",
      "待执行",
    ],
  ],
};

describe("OptimizationReportView", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders a vertical outline and all eight report chapters at once", () => {
    render(<OptimizationReportView report={report} />);

    const outline = screen.getByRole("navigation", {
      name: "进度报告章节",
    });
    expect(within(outline).getAllByRole("button")).toHaveLength(8);

    for (const heading of [
      "执行摘要",
      "平台表现",
      "决策旅程",
      "竞品梯队",
      "信源结构",
      "风险议题",
      "行动路线图",
      "复测记录",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }

    expect(screen.getByText("企业官网 / 服务说明页")).toBeTruthy();
    expect(screen.getByText("复测记录 03")).toBeTruthy();

    const platformSection = screen.getByRole("region", {
      name: "平台表现",
    });
    expect(within(platformSection).getAllByRole("row")).toHaveLength(3);
    expect(
      within(platformSection).getByRole("columnheader", {
        name: "官方源",
      }),
    ).toBeTruthy();
    expect(screen.getByText("报告结束")).toBeTruthy();
    expect(screen.queryByText("REPORT INDEX")).toBeNull();
    expect(
      screen.queryByText("GENERATIVE ENGINE OPTIMIZATION REPORT"),
    ).toBeNull();
    expect(screen.queryByText("Executive summary")).toBeNull();
  });

  it("scrolls to the selected chapter and updates aria-current immediately", () => {
    render(<OptimizationReportView report={report} />);

    const sourceButton = screen.getByRole("button", {
      name: "信源结构",
    });
    fireEvent.click(sourceButton);

    expect(sourceButton).toHaveAttribute("aria-current", "location");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });
});
