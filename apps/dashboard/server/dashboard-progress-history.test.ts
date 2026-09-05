import { describe, expect, it } from "vitest";

import {
  createDefaultDashboardPayload,
  dashboardPayloadSchema,
  type DashboardPayload,
} from "../shared/dashboard";
import { mergeProgressReportHistory } from "./dashboard-service";

function report(
  period: string,
): NonNullable<DashboardPayload["optimizationReport"]> {
  return {
    period,
    title: `${period} 进度报告`,
    subtitle: "",
    executiveSummary: [],
    kpis: [],
    platforms: [],
    journeys: [],
    competitorTiers: [],
    sourceMix: [],
    risks: [],
    roadmap: [],
    reportRecords: [],
  };
}

describe("dashboard progress report history", () => {
  it("backfills a legacy single-slot report and persists the newly published version", () => {
    const previous = {
      ...createDefaultDashboardPayload("测试企业"),
      optimizationReport: report("2026 Q1"),
    };
    const next = {
      ...previous,
      optimizationReport: report("2026 Q2"),
    };

    const merged = mergeProgressReportHistory({
      previous,
      next,
      nextRevision: 8,
      publishedAt: 200,
      previousPublishedAt: 100,
    });

    expect(
      merged.progressReports.map((version) => ({
        revision: version.revision,
        publishedAt: version.publishedAt,
        period: version.report.period,
      })),
    ).toEqual([
      { revision: 7, publishedAt: 100, period: "2026 Q1" },
      { revision: 8, publishedAt: 200, period: "2026 Q2" },
    ]);
    expect(() => dashboardPayloadSchema.parse(merged)).not.toThrow();
  });

  it("does not create another version for an unrelated dashboard update", () => {
    const current = report("2026 Q2");
    const previous = {
      ...createDefaultDashboardPayload("测试企业"),
      optimizationReport: current,
      progressReports: [
        {
          id: "progress-report-r8",
          revision: 8,
          publishedAt: 200,
          report: current,
        },
      ],
    };
    const next = {
      ...previous,
      headline: "仅更新企业摘要",
    };

    const merged = mergeProgressReportHistory({
      previous,
      next,
      nextRevision: 9,
      publishedAt: 300,
    });

    expect(merged.progressReports).toHaveLength(1);
    expect(merged.progressReports[0]?.revision).toBe(8);
  });

  it("keeps past versions when the current report slot is cleared", () => {
    const previousReport = report("2026 Q1");
    const previous = {
      ...createDefaultDashboardPayload("测试企业"),
      optimizationReport: previousReport,
    };
    const next = {
      ...previous,
      optimizationReport: null,
    };

    const merged = mergeProgressReportHistory({
      previous,
      next,
      nextRevision: 3,
      publishedAt: 300,
      previousPublishedAt: 200,
    });

    expect(merged.optimizationReport).toBeNull();
    expect(merged.progressReports).toHaveLength(1);
    expect(merged.progressReports[0]?.report.period).toBe("2026 Q1");
  });
});
