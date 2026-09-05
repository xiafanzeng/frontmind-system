import { describe, expect, it } from "vitest";

import { websiteContentTemplateSchema } from "../shared/delivery-ticket";
import {
  buildWebsiteContentTemplateDiff,
  createWebsiteContentTemplate,
} from "./website-content-template-service";

const WORKSPACE_USER_ID = 42;
const FILE_HASH = "a".repeat(64);
const FIRST_TICKET_ID = "970b87d8-d4f4-45db-8f11-44c45f52ade9";
const SECOND_TICKET_ID = "5f05091b-0e0a-4482-8f11-654c4502b3e1";

function row(
  patch: Partial<{
    id: string;
    userId: number;
    type: "content_asset" | "website_operation";
    category: string | null;
    topic: string | null;
    title: string | null;
    status:
      | "submitted"
      | "needs_information"
      | "scheduled"
      | "in_progress"
      | "completed"
      | "rejected"
      | "cancelled";
    quotaState: "reserved" | "consumed" | "released";
    publicSummary: string | null;
    revision: number;
  }> = {},
) {
  return {
    id: FIRST_TICKET_ID,
    userId: WORKSPACE_USER_ID,
    type: "website_operation" as const,
    category: "company_facts",
    topic: "更新企业品牌事实",
    title: "企业资料与品牌事实",
    status: "submitted" as const,
    quotaState: "reserved" as const,
    publicSummary: null,
    revision: 3,
    scheduledAt: null,
    resolvedAt: null,
    technicalDedupeKey: null,
    quotaReleasedAt: null,
    ...patch,
  };
}

function templateFor(rows = [row()]) {
  return createWebsiteContentTemplate({
    workspaceUserId: WORKSPACE_USER_ID,
    rows: rows as any,
    exportedAt: new Date("2026-07-28T00:00:00.000Z"),
  });
}

describe("website content current-content template", () => {
  it("contains the workspace binding and per-ticket immutable snapshots", () => {
    expect(templateFor()).toEqual({
      format: "frontmind.website-content-template.v1",
      workspaceUserId: WORKSPACE_USER_ID,
      exportedAt: "2026-07-28T00:00:00.000Z",
      records: [
        {
          ticketId: FIRST_TICKET_ID,
          revision: 3,
          category: "company_facts",
          topic: "更新企业品牌事实",
          publicSummary: "",
          complete: false,
        },
      ],
    });
  });

  it("rejects domain/ICP rows and duplicate ticket ids at the schema boundary", () => {
    const base = templateFor();
    expect(() =>
      websiteContentTemplateSchema.parse({
        ...base,
        records: [{ ...base.records[0], category: "domain_application" }],
      }),
    ).toThrow();
    expect(() =>
      websiteContentTemplateSchema.parse({
        ...base,
        records: [base.records[0], base.records[0]],
      }),
    ).toThrow("同一工单");
  });

  it("builds a completion diff only when summary and complete are supplied together", () => {
    const currentRows = [row()];
    const template = templateFor(currentRows);
    template.records[0] = {
      ...template.records[0]!,
      publicSummary: "已完成企业资料与品牌事实页面更新。",
      complete: true,
    };
    const preview = buildWebsiteContentTemplateDiff({
      workspaceUserId: WORKSPACE_USER_ID,
      template,
      rows: currentRows as any,
      fileHash: FILE_HASH,
    });

    expect(preview.totals).toEqual({
      records: 1,
      changed: 1,
      completing: 1,
      summariesUpdated: 1,
      unchanged: 0,
    });
    expect(preview.changes[0]).toMatchObject({
      ticketId: FIRST_TICKET_ID,
      change: "complete",
      incomingComplete: true,
      incomingPublicSummary: "已完成企业资料与品牌事实页面更新。",
    });

    const summaryWithoutCompletion = templateFor(currentRows);
    summaryWithoutCompletion.records[0] = {
      ...summaryWithoutCompletion.records[0]!,
      publicSummary: "不应作为未完成草稿落库。",
    };
    expect(() =>
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template: summaryWithoutCompletion,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }),
    ).toThrow("同时把 complete 改为 true");

    const noSummary = templateFor(currentRows);
    noSummary.records[0] = {
      ...noSummary.records[0]!,
      complete: true,
    };
    expect(() =>
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template: noSummary,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }),
    ).toThrow("必须填写 publicSummary");
  });

  it("allows summary correction on a completed row but never reopens it", () => {
    const currentRows = [
      row({
        status: "completed",
        quotaState: "consumed",
        publicSummary: "旧内容总结",
        revision: 8,
      }),
    ];
    const template = templateFor(currentRows);
    template.records[0] = {
      ...template.records[0]!,
      publicSummary: "经管理员修正后的内容总结",
    };
    expect(
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }).changes[0],
    ).toMatchObject({ change: "summary", currentComplete: true });

    template.records[0] = {
      ...template.records[0]!,
      complete: false,
    };
    expect(() =>
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }),
    ).toThrow("不能通过模板重新打开");
  });

  it("rejects stale, cross-workspace, category/topic-tampered and partial batches", () => {
    const currentRows = [
      row(),
      row({
        id: SECOND_TICKET_ID,
        category: "faq_content",
        topic: "FAQ 页面",
        revision: 5,
      }),
    ];
    const template = templateFor(currentRows);
    template.records[0] = {
      ...template.records[0]!,
      publicSummary: "第一条已完成。",
      complete: true,
    };
    template.records[1] = {
      ...template.records[1]!,
      revision: 4,
      publicSummary: "第二条也看似可完成。",
      complete: true,
    };
    expect(() =>
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }),
    ).toThrow(`已更新到 R5`);

    const wrongWorkspace = {
      ...templateFor([currentRows[0]!]),
      workspaceUserId: 43,
    };
    expect(() =>
      buildWebsiteContentTemplateDiff({
        workspaceUserId: WORKSPACE_USER_ID,
        template: wrongWorkspace,
        rows: currentRows as any,
        fileHash: FILE_HASH,
      }),
    ).toThrow("当前工作台不一致");

    for (const patch of [
      { category: "faq_content" as const },
      { topic: "被替换的话题" },
    ]) {
      const tampered = templateFor([currentRows[0]!]);
      tampered.records[0] = { ...tampered.records[0]!, ...patch };
      expect(() =>
        buildWebsiteContentTemplateDiff({
          workspaceUserId: WORKSPACE_USER_ID,
          template: tampered,
          rows: currentRows as any,
          fileHash: FILE_HASH,
        }),
      ).toThrow("类别或话题快照被修改");
    }
  });
});
