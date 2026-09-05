import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDefaultDashboardPayload,
  dashboardPayloadSchema,
} from "../shared/dashboard";
import {
  assertDashboardReportAssetScope,
  DashboardEnterpriseMismatchError,
  DashboardRevisionConflictError,
  prepareDashboardContentRollback,
  resolveDashboardWorkspacePayload,
  toPublicDashboardPayload,
  toDashboardContentRevisionSummary,
} from "./dashboard-service";

describe("dashboard content publication history", () => {
  it("returns an empty structural payload only when the account has no stored content", () => {
    expect(
      resolveDashboardWorkspacePayload({
        storedPayload: undefined,
        hasStoredContent: false,
        displayName: "新企业",
      }),
    ).toEqual(createDefaultDashboardPayload("新企业"));
  });

  it("rejects corrupt stored content instead of silently replacing it", () => {
    expect(() =>
      resolveDashboardWorkspacePayload({
        storedPayload: { brandName: "损坏版本" },
        hasStoredContent: true,
        displayName: "正式企业",
      }),
    ).toThrow("看板内容校验失败，请联系管理员修复当前发布版本。");
  });

  it("exposes metadata-only history summaries and marks the current version", () => {
    const summary = toDashboardContentRevisionSummary(
      {
        id: "revision-3",
        revision: 3,
        sourceName: "管理员结构化编辑",
        publicationKind: "rollback",
        rolledBackFromRevision: 1,
        publishedByUserId: 7,
        enterpriseIdentityBoundAt: new Date("2026-07-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      3,
    );

    expect(summary).toEqual({
      id: "revision-3",
      revision: 3,
      sourceName: "管理员结构化编辑",
      publicationKind: "rollback",
      rolledBackFromRevision: 1,
      publishedByUserId: 7,
      enterpriseIdentityBound: true,
      createdAt: Date.parse("2026-07-27T00:00:00.000Z"),
      isCurrent: true,
    });
    expect(summary).not.toHaveProperty("payload");
  });

  it("prepares an immutable rollback as the next revision", () => {
    const boundAt = new Date("2026-07-01T00:00:00.000Z");
    const currentPayload = {
      ...createDefaultDashboardPayload("测试企业"),
      headline: "当前版本",
    };
    const targetPayload = {
      ...createDefaultDashboardPayload("测试企业"),
      headline: "历史版本",
    };
    const rollback = prepareDashboardContentRollback({
      current: {
        revision: 4,
        payload: currentPayload,
        sourceName: "current.json",
        enterpriseIdentityBoundAt: boundAt,
      },
      target: {
        revision: 2,
        payload: targetPayload,
        sourceName: "target.json",
        enterpriseIdentityBoundAt: null,
      },
      expectedRevision: 4,
    });

    expect(rollback).toMatchObject({
      payload: targetPayload,
      sourceName: "target.json",
      enterpriseIdentityBoundAt: boundAt,
      nextRevision: 5,
      rolledBackFromRevision: 2,
    });
  });

  it("rejects a stale expected revision and cross-enterprise history", () => {
    const current = {
      revision: 4,
      payload: createDefaultDashboardPayload("企业甲"),
      sourceName: "current.json",
      enterpriseIdentityBoundAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    expect(() =>
      prepareDashboardContentRollback({
        current,
        target: {
          revision: 2,
          payload: createDefaultDashboardPayload("企业甲"),
          sourceName: "target.json",
          enterpriseIdentityBoundAt: null,
        },
        expectedRevision: 3,
      }),
    ).toThrow(DashboardRevisionConflictError);

    expect(() =>
      prepareDashboardContentRollback({
        current,
        target: {
          revision: 2,
          payload: createDefaultDashboardPayload("企业乙"),
          sourceName: "target.json",
          enterpriseIdentityBoundAt: null,
        },
        expectedRevision: 4,
      }),
    ).toThrow(DashboardEnterpriseMismatchError);
  });

  it("rejects protected report screenshots that belong to another customer", () => {
    const payload = dashboardPayloadSchema.parse({
      ...createDefaultDashboardPayload("测试企业"),
      optimizationReport: {
        title: "优化报告",
        questionReports: [
          {
            id: "question-1",
            question: "测试问题",
            before: {
              content: "优化前回答",
              screenshots: [
                {
                  id: "asset-1",
                  url: "/api/dashboard/report-assets/12/00000000-0000-4000-8000-000000000001.png",
                },
              ],
            },
            after: {
              content: "优化后回答",
              screenshots: [],
            },
          },
        ],
      },
    });

    expect(() => assertDashboardReportAssetScope(payload, 12)).not.toThrow();
    expect(() => assertDashboardReportAssetScope(payload, 13)).toThrow(
      "答案截图必须来自当前客户",
    );
  });

  it("removes unreleased optimization effects from the user DTO", () => {
    const report = {
      title: "优化报告",
      questionReports: [
        {
          id: "hidden-question",
          question: "尚未开放的问题",
          afterEffect: {
            released: false,
            totalScore: 91,
            summary: "管理员草稿，不应泄露",
            platforms: [
              {
                platform: "DeepSeek",
                responseCount: 5,
                citationCount: 10,
                verdict: "内部复测结果",
              },
            ],
            gapFillSummary: "内部差距总结",
          },
        },
        {
          id: "released-question",
          question: "已开放的问题",
          afterEffect: {
            released: true,
            totalScore: 88,
            platforms: [
              {
                platform: "豆包",
                responseCount: 5,
                citationCount: 8,
                verdict: "已开放结果",
              },
            ],
            gapFillSummary: "已开放总结",
          },
        },
      ],
    };
    const parsed = dashboardPayloadSchema.parse({
      ...createDefaultDashboardPayload("测试企业"),
      optimizationReport: report,
      progressReports: [
        {
          id: "progress-report-r1",
          revision: 1,
          publishedAt: 1,
          report,
        },
      ],
    });

    const publicPayload = toPublicDashboardPayload(parsed);
    expect(
      publicPayload.optimizationReport?.questionReports?.[0],
    ).not.toHaveProperty("afterEffect");
    expect(
      publicPayload.optimizationReport?.questionReports?.[1]?.afterEffect,
    ).toMatchObject({ released: true, totalScore: 88 });
    expect(
      publicPayload.progressReports[0]?.report.questionReports?.[0],
    ).not.toHaveProperty("afterEffect");
  });

  it("creates the history table and backfills the current compatibility projection", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "drizzle/0026_workspace_content_revisions.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE `workspace_content_revisions`");
    expect(sql).toContain(
      "CONSTRAINT `workspace_content_revisions_user_module_revision_uq` UNIQUE",
    );
    expect(sql).toContain("INSERT INTO `workspace_content_revisions`");
    expect(sql).toContain("FROM `user_dashboard_contents`");
    expect(sql).toContain("'migration'");
  });
});
