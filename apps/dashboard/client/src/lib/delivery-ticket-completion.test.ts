import { describe, expect, it } from "vitest";

import {
  buildDeliveryCompletionPayload,
  createDeliveryCompletionDraft,
  deliveryCompletionCreatesNextStep,
  deliveryCompletionRequiresPublicUrl,
  validateDeliveryCompletionDraft,
} from "./delivery-ticket-completion";

describe("delivery ticket completion contract", () => {
  it("requires a customer-facing result and user-side verification for every completion", () => {
    const ticket = { operation: "build_exception" as const };
    const draft = createDeliveryCompletionDraft(ticket);

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "请填写客户能理解的交付结果摘要",
      "请先核对用户实际页面或可核验交付记录",
    ]);

    expect(
      validateDeliveryCompletionDraft(ticket, {
        ...draft,
        summary: "构建异常已经排除，正式知识库恢复可用。",
        previewVerified: true,
      }),
    ).toEqual([]);
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
      optimizationQuestionIds: "q-1，q-2\nq-1",
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([]);
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

  it("requires public evidence and a bound asset before website handoff", () => {
    const ticket = { operation: "content_asset_publish" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "内容资产已经发布。",
      previewVerified: true,
      publishMedia: false,
      publishWebsite: true,
    };

    expect(deliveryCompletionRequiresPublicUrl(ticket.operation)).toBe(true);
    expect(validateDeliveryCompletionDraft(ticket, draft)).toEqual([
      "本工单必须登记公开链接",
      "请填写已经进入客户正式看板的内容资产 ID",
    ]);

    const ready = {
      ...draft,
      publicUrl: "https://example.com/article",
      contentAssetIds: "asset-1, asset-2",
      websiteOperation: "faq_content" as const,
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "内容资产已经发布。",
      publicUrl: "https://example.com/article",
      handoff: {
        contentAssetIds: ["asset-1", "asset-2"],
        publishTargets: ["website"],
        websiteOperation: "faq_content",
      },
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

    expect(validateDeliveryCompletionDraft(ticket, draft)).toContain(
      "效果复测必须填写新的监控批次，不能继续使用复测前基线",
    );

    const ready = {
      ...draft,
      monitoringBatchKey: "retest-batch",
    };
    expect(validateDeliveryCompletionDraft(ticket, ready)).toEqual([]);
    expect(buildDeliveryCompletionPayload(ticket, ready)).toEqual({
      message: "效果复测已完成。",
      handoff: { monitoringBatchKey: "retest-batch" },
    });
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

  it("does not allow a failed site check to close the delivery loop", () => {
    const ticket = { operation: "site_check" as const };
    const draft = {
      ...createDeliveryCompletionDraft(ticket),
      summary: "页面检查发现公开访问失败。",
      previewVerified: true,
      siteCheckStatus: "failed" as const,
    };

    expect(validateDeliveryCompletionDraft(ticket, draft)).toContain(
      "站点检查未通过时不能完成工单，请先修正页面或等待补充",
    );
    expect(deliveryCompletionCreatesNextStep(ticket.operation)).toContain(
      "检查失败时不能完成交付",
    );
  });
});
