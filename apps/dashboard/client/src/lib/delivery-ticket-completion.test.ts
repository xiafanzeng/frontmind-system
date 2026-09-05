import { describe, expect, it } from "vitest";

import {
  buildDeliveryCompletionPayload,
  createDeliveryCompletionDraft,
  deliveryCompletionCreatesNextStep,
  deliveryCompletionHasField,
  deliveryCompletionMode,
  deliveryCompletionMonitoringBatchOptions,
  deliveryCompletionOptionBlockReasons,
  deliveryCompletionRequiresPublicUrl,
  deliveryCompletionRequiresPreviewVerification,
  deliveryTicketWaitsForAdminCredential,
  validateDeliveryCompletionDraft,
} from "./delivery-ticket-completion";

describe("delivery ticket completion contract", () => {
  it("requires a customer-facing result but ignores hidden URL and preview fields", () => {
    const ticket = { operation: "build_exception" as const };
    const draft = createDeliveryCompletionDraft(ticket);

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "请填写客户能理解的交付结果摘要",
    ]);

    const ready = {
      ...draft,
      summary: "构建异常已经排除，正式知识库恢复可用。",
      publicUrl: "https://stale.example.com/should-not-be-sent",
      previewVerified: true,
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "构建异常已经排除，正式知识库恢复可用。",
    });
    expect(deliveryCompletionRequiresPublicUrl(ticket.operation)).toBe(false);
    expect(
      deliveryCompletionRequiresPreviewVerification(ticket.operation),
    ).toBe(false);
  });

  it("distinguishes domestic and overseas domain handoff requirements", () => {
    const domestic = {
      operation: "domain_application" as const,
      marketEdition: "domestic" as const,
    };
    const domesticDraft = {
      ...createDeliveryCompletionDraft(domestic),
      summary: "域名已经核验。",
      previewVerified: true,
      domain: "example.com",
    };

    expect(validateDeliveryCompletionDraft(domestic, domesticDraft)).toContain(
      "国内版客户必须填写备案服务码",
    );

    const overseas = {
      ...domestic,
      marketEdition: "overseas" as const,
    };
    expect(validateDeliveryCompletionDraft(overseas, domesticDraft)).toEqual(
      [],
    );
    expect(buildDeliveryCompletionPayload(overseas, domesticDraft)).toEqual({
      message: "域名已经核验。",
      handoff: { domain: "example.com" },
    });
  });

  it("does not let a domestic ICP ticket bypass the备案 result", () => {
    const ticket = {
      operation: "icp_filing" as const,
      marketEdition: "domestic" as const,
    };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "备案阶段已核验。",
      previewVerified: true,
      icpResolution: "not_required" as const,
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toContain(
      "国内版官网必须填写已通过的 ICP 备案结果",
    );
  });

  it("builds monitoring-to-content handoff without duplicate question ids", () => {
    const ticket = {
      operation: "initial_monitoring" as const,
      monitoringBatchKey: "batch-old",
    };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "首轮监控已完成。",
      previewVerified: true,
      monitoringBatchKey: "batch-2026-07",
      optimizationQuestionIds: ["q-1", "q-2", "q-1"],
    };
    const options = {
      keywordCatalogPublished: true,
      monitoringBatches: [
        {
          batchKey: "batch-2026-07",
          sourceName: "正式监控.xlsx",
          collectedAt: Date.parse("2026-07-31T08:00:00.000Z"),
          sampleCount: 12,
        },
      ],
      approvedQuestions: [
        { id: "q-1", question: "问题一" },
        { id: "q-2", question: "问题二" },
      ],
    };

    expect(validateDeliveryCompletionDraft(ticket, draft, options)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, draft)).toEqual({
      message: "首轮监控已完成。",
      handoff: {
        monitoringBatchKey: "batch-2026-07",
        optimizationQuestionIds: ["q-1", "q-2"],
      },
    });
    expect(deliveryCompletionCreatesNextStep(ticket.operation)).toContain(
      "应答逻辑",
    );
  });

  it("completes content asset publishing with only asset ids and a summary", () => {
    const ticket = { operation: "content_asset_publish" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "内容资产已经发布。",
    };

    expect(deliveryCompletionRequiresPublicUrl(ticket.operation)).toBe(false);
    expect(
      deliveryCompletionHasField(ticket.operation, "content_asset_ids"),
    ).toBe(true);
    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "请填写已经进入客户正式看板的内容资产 ID",
    ]);

    const ready = {
      ...draft,
      publicUrl: "https://stale.example.com/article",
      previewVerified: true,
      contentAssetIds: "asset-1, asset-2",
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "内容资产已经发布。",
      handoff: {
        contentAssetIds: ["asset-1", "asset-2"],
      },
    });
  });

  it("requires both the actual target media and public URL for channel distribution", () => {
    const ticket = { operation: "channel_distribution" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "渠道发布已完成。",
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "本需求必须登记公开链接",
      "请填写本次实际发布的目标媒体或渠道",
    ]);

    const ready = {
      ...draft,
      publicUrl: "https://news.example.com/article",
      channelTargetMedia: "知乎",
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "渠道发布已完成。",
      publicUrl: "https://news.example.com/article",
      handoff: { targetMedia: "知乎" },
    });

    expect(
      buildDeliveryCompletionPayload(
        { ...ticket, preferredMedia: "客户指定媒体" },
        { ...ready, channelTargetMedia: "被篡改的媒体" },
      ),
    ).toMatchObject({ handoff: { targetMedia: "客户指定媒体" } });
  });

  it("keeps inherited website content assets immutable in the payload", () => {
    const ticket = {
      operation: "company_facts" as const,
      contentAssetIds: ["asset-inherited", "asset-inherited"],
    };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "企业事实页面已发布。",
      publicUrl: "https://example.com/about",
      contentAssetIds: "asset-tampered",
      previewVerified: true,
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, draft)).toEqual({
      message: "企业事实页面已发布。",
      publicUrl: "https://example.com/about",
      handoff: { contentAssetIds: ["asset-inherited"] },
    });
  });
  it("requires a public website URL before completing the website build", () => {
    const ticket = { operation: "website_build" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "AI 专用官网已经完成构建并发布。",
      previewVerified: true,
    };

    expect(deliveryCompletionRequiresPublicUrl(ticket.operation)).toBe(true);
    expect(
      deliveryCompletionRequiresPreviewVerification(ticket.operation),
    ).toBe(true);
    expect(validateDeliveryCompletionDraft(ticket, draft)).toContain(
      "本需求必须登记公开链接",
    );
    expect(deliveryCompletionCreatesNextStep(ticket.operation)).toContain(
      "开放后续官网内容提交",
    );
    const ready = { ...draft, publicUrl: "https://example.com" };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toMatchObject({
      publicUrl: "https://example.com",
      previewVerified: true,
    });
  });

  it("requires a new formal batch for monitoring retest", () => {
    const ticket = {
      operation: "monitoring_retest" as const,
      monitoringBatchKey: "baseline-batch",
    };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "效果复测已完成。",
      previewVerified: true,
      monitoringBatchKey: "baseline-batch",
    };
    const options = {
      keywordCatalogPublished: true,
      monitoringBatches: [
        {
          batchKey: "baseline-batch",
          sourceName: "基线.xlsx",
          collectedAt: Date.parse("2026-07-01T08:00:00.000Z"),
          sampleCount: 8,
        },
        {
          batchKey: "retest-batch",
          sourceName: "复测.xlsx",
          collectedAt: Date.parse("2026-08-01T08:00:00.000Z"),
          sampleCount: 8,
        },
      ],
      approvedQuestions: [],
    };

    expect(validateDeliveryCompletionDraft(ticket, draft, options)).toContain(
      "效果复测必须填写新的监控批次，不能继续使用复测前基线",
    );
    expect(
      deliveryCompletionMonitoringBatchOptions(ticket, options).map(
        (batch) => batch.batchKey,
      ),
    ).toEqual(["retest-batch"]);

    const ready = {
      ...draft,
      monitoringBatchKey: "retest-batch",
    };
    expect(validateDeliveryCompletionDraft(ticket, ready, options)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "效果复测已完成。",
      handoff: { monitoringBatchKey: "retest-batch" },
    });
  });

  it("blocks completion when formal monitoring or question-catalog evidence is missing", () => {
    expect(
      deliveryCompletionOptionBlockReasons(
        { operation: "initial_monitoring" },
        {
          monitoringBatches: [],
          approvedQuestions: [],
          keywordCatalogPublished: false,
        },
      ),
    ).toEqual([
      "当前没有已发布且包含正式答案的监控批次，请先完成监控数据发布",
      "当前没有已审核通过的客户问题，无法登记待优化问题",
    ]);

    expect(
      deliveryCompletionOptionBlockReasons(
        { operation: "question_catalog" },
        {
          monitoringBatches: [],
          approvedQuestions: [],
          keywordCatalogPublished: false,
        },
      ),
    ).toEqual(["正式品牌词库尚未发布，请先通过业务文件发布入口完成发布"]);
    expect(
      deliveryCompletionOptionBlockReasons(
        { operation: "question_catalog" },
        {
          monitoringBatches: [],
          approvedQuestions: [],
          keywordCatalogPublished: true,
        },
      ),
    ).toEqual([]);
    expect(
      createDeliveryCompletionDraft({ operation: "question_catalog" }).summary,
    ).toBe("品牌词库已发布");
  });

  it("keeps stage-report continuation explicit", () => {
    const ticket = { operation: "stage_report" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "阶段复测仍未达到目标。",
      previewVerified: true,
      needsFurtherOptimization: true,
    };

    expect(buildDeliveryCompletionPayload(ticket, draft)).toEqual({
      message: "阶段复测仍未达到目标。",
      handoff: { needsFurtherOptimization: true },
    });
  });

  it("requires the checked page URL and does not treat it as a public result URL", () => {
    const ticket = { operation: "site_check" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "页面检查发现公开访问失败。",
      siteCheckStatus: "failed" as const,
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "请填写本次检查的页面地址",
    ]);
    expect(deliveryCompletionCreatesNextStep(ticket.operation)).toContain(
      "生成 AI 运维修正子工单",
    );

    const ready = {
      ...draft,
      siteCheckSource: "https://example.com/about",
      siteCheckSummary: "页面暂时无法访问，已提交修正。",
      publicUrl: "https://stale.example.com/not-a-result-link",
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "页面检查发现公开访问失败。",
      handoff: {
        siteCheck: {
          key: "published-page-check",
          label: "已发布页面检查",
          status: "failed",
          summary: "页面暂时无法访问，已提交修正。",
          evidence: undefined,
          source: "https://example.com/about",
        },
      },
    });
  });

  it("closes unknown history with summary only while keeping system records read-only", () => {
    const unknown = { operation: "legacy_custom_operation" };
    const unknownDraft = createDeliveryCompletionDraft(unknown);

    expect(deliveryCompletionMode(unknown.operation)).toBe("legacy_summary");
    expect(validateDeliveryCompletionDraft(unknown, unknownDraft)).toEqual([
      "请填写客户能理解的交付结果摘要",
    ]);
    const ready = {
      ...unknownDraft,
      summary: "历史事项已经人工核对并处理。",
      publicUrl: "https://stale.example.com",
      previewVerified: true,
      contentAssetIds: "stale-asset",
    };
    expect(validateDeliveryCompletionDraft(unknown, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(unknown, ready)).toEqual({
      message: "历史事项已经人工核对并处理。",
    });
    expect(deliveryCompletionMode("knowledge_delivery")).toBe(
      "system_readonly",
    );
  });

  it("uses credentialTargetUserId and active status as the only API-key wait signal", () => {
    expect(
      deliveryTicketWaitsForAdminCredential({
        credentialTargetUserId: 42,
        status: "in_progress",
      }),
    ).toBe(true);
    expect(
      deliveryTicketWaitsForAdminCredential({
        credentialTargetUserId: 42,
        status: "completed",
      }),
    ).toBe(false);
    expect(
      deliveryTicketWaitsForAdminCredential({
        credentialTargetUserId: null,
        status: "in_progress",
      }),
    ).toBe(false);
    expect(
      deliveryTicketWaitsForAdminCredential({
        credentialTargetUserId: null,
        status: "in_progress",
        title: "配置 Jenova 平台 API 密钥",
      } as {
        credentialTargetUserId?: number | null;
        status?: string | null;
      }),
    ).toBe(false);
  });
});
