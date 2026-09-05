import { describe, expect, it } from "vitest";

import {
  deliveryActorRoleLabel,
  deliveryAttachmentAuthorizationLabel,
  deliveryCategoryLabel,
  deliveryCleanupKeyLabel,
  deliveryCleanupSummaryText,
  deliveryEventDisplayMessage,
  deliveryEventKindLabel,
  deliveryOperationLabel,
  deliveryPriorityLabel,
  deliveryQuotaStateLabel,
  deliveryResultStatusLabel,
  deliveryStatusTransitionLabel,
  deliveryTicketPresentationTitle,
  deliveryTicketPresentationTopic,
  deliveryTicketStatusLabel,
  deliveryVisibilityLabel,
  knowledgeResetReasonLabel,
  knowledgeResetStatusLabel,
} from "./delivery-ticket-presentation";

describe("delivery ticket presentation", () => {
  it("localizes all seven internal statuses and collapses customer states", () => {
    const statuses = {
      submitted: "已提交",
      needs_information: "待补充资料",
      scheduled: "已排期",
      in_progress: "处理中",
      completed: "已完成",
      rejected: "未受理",
      cancelled: "已取消",
    } as const;

    for (const [status, label] of Object.entries(statuses)) {
      expect(deliveryTicketStatusLabel(status, "internal")).toBe(label);
      expect(deliveryTicketStatusLabel(status, "customer")).toBe(
        ["completed", "rejected", "cancelled"].includes(status)
          ? "已完成"
          : "待处理",
      );
    }
    expect(deliveryTicketStatusLabel("future_status", "internal")).toBe(
      "未知状态",
    );
    expect(deliveryTicketStatusLabel("future_status", "customer")).toBe(
      "状态待确认",
    );
  });

  it("localizes all four actor roles without exposing internal roles to customers", () => {
    expect(deliveryActorRoleLabel("user", "internal")).toBe("客户");
    expect(deliveryActorRoleLabel("admin", "internal")).toBe("管理员");
    expect(deliveryActorRoleLabel("delivery_member", "internal")).toBe(
      "工程师",
    );
    expect(deliveryActorRoleLabel("system", "internal")).toBe("系统");

    expect(deliveryActorRoleLabel("user", "customer")).toBe("用户");
    for (const role of ["admin", "delivery_member", "system", "future_role"]) {
      expect(deliveryActorRoleLabel(role, "customer")).toBe("服务团队");
    }
    expect(deliveryActorRoleLabel("future_role", "internal")).toBe("相关人员");
  });

  it("uses the canonical operation registry and safe unknown fallback", () => {
    expect(deliveryOperationLabel("website_build")).toBe("官网构建");
    expect(deliveryOperationLabel("knowledge_delivery")).toBe("品牌全域知识库");
    expect(deliveryOperationLabel("legacy_operation")).toBe("历史交付任务");
    expect(
      deliveryTicketPresentationTitle({
        type: "website_operation",
        operation: "site_check",
      }),
    ).toBe("站点检查");
    expect(
      deliveryCategoryLabel({
        type: "website_operation",
        category: "site_rebuild",
      }),
    ).toBe("官网重制");
    expect(
      deliveryTicketPresentationTitle({
        type: "website_operation",
        operation: "legacy_operation",
      }),
    ).toBe("官网运营需求");
    expect(
      deliveryTicketPresentationTitle({
        title: "配置品牌词库与问题目录",
        type: "knowledge_base",
        operation: "question_catalog",
      }),
    ).toBe("配置品牌词库");
    expect(
      deliveryTicketPresentationTopic({
        topic: "品牌词库与问题目录",
        title: "配置品牌词库与问题目录",
        type: "knowledge_base",
        operation: "question_catalog",
      }),
    ).toBe("配置品牌词库");
    expect(
      deliveryTicketPresentationTitle({
        title: "配置品牌词库与问题目录",
        type: "knowledge_base",
        category: "question_catalog",
      }),
    ).toBe("配置品牌词库");
    expect(
      deliveryTicketPresentationTopic({
        topic: "品牌词库与问题目录",
        type: "knowledge_base",
        category: "question_catalog",
      }),
    ).toBe("配置品牌词库");
  });

  it("localizes canonical, historical, and unknown categories", () => {
    expect(
      deliveryCategoryLabel({
        type: "knowledge_base",
        category: "question_catalog",
        providedLabel: "品牌词库与问题目录",
      }),
    ).toBe("配置品牌词库");
    expect(
      deliveryCategoryLabel({ type: "content_asset", category: "D1" }),
    ).toBe("知乎问答");
    expect(
      deliveryCategoryLabel({
        type: "website_operation",
        category: "website_style_samples",
        providedLabel: "website_style_samples",
      }),
    ).toBe("官网图片风格");
    expect(
      deliveryCategoryLabel({
        type: "website_operation",
        category: "site_check",
      }),
    ).toBe("站点检查");
    expect(
      deliveryCategoryLabel({
        type: "website_operation",
        category: "future_category",
        providedLabel: "future_category",
      }),
    ).toBe("官网运营需求");
    expect(
      deliveryTicketPresentationTopic({
        type: "content_asset",
        category: "future_category",
        topic: "future_category",
        fallbackLabel: "内容运营与发布需求",
      }),
    ).toBe("内容运营与发布需求");
  });

  it("keeps exact transitions internal and customer transitions public-safe", () => {
    expect(
      deliveryStatusTransitionLabel("submitted", "in_progress", "internal"),
    ).toBe("已提交 → 处理中");
    expect(
      deliveryEventDisplayMessage(
        { message: "submitted → in_progress" },
        "internal",
      ),
    ).toBe("已提交 → 处理中");
    expect(
      deliveryEventDisplayMessage(
        { message: "submitted -> completed" },
        "customer",
      ),
    ).toBe("需求状态更新为已完成。");
    expect(
      deliveryEventDisplayMessage(
        { message: "已按客户要求从测试环境发布到正式环境。" },
        "internal",
      ),
    ).toBe("已按客户要求从测试环境发布到正式环境。");
    expect(
      deliveryEventDisplayMessage(
        {
          message: null,
          fromStatus: "submitted",
          toStatus: "in_progress",
        },
        "customer",
      ),
    ).toBe("需求状态更新为待处理。");
    expect(
      deliveryEventDisplayMessage(
        {
          message: null,
          fromStatus: "submitted",
          toStatus: "completed",
        },
        "customer",
      ),
    ).toBe("需求状态更新为已完成。");
    expect(deliveryEventDisplayMessage({ message: null }, "customer")).toBe(
      "需求记录已更新。",
    );
  });

  it("localizes supporting enums and cleanup summary keys", () => {
    expect(deliveryEventKindLabel("status_change")).toBe("状态更新");
    expect(deliveryVisibilityLabel("internal")).toBe("内部记录");
    expect(deliveryPriorityLabel("urgent")).toBe("紧急");
    expect(deliveryQuotaStateLabel("consumed")).toBe("已使用");
    expect(deliveryResultStatusLabel("pending_confirmation")).toBe("待确认");
    expect(deliveryAttachmentAuthorizationLabel("licensed")).toBe("已获授权");
    expect(knowledgeResetReasonLabel("upload_error")).toBe("上传资料有误");
    expect(knowledgeResetStatusLabel("approved")).toBe("已批准");
    expect(deliveryCleanupKeyLabel("snapshots")).toBe("知识库快照");
    expect(deliveryCleanupSummaryText({ snapshots: 3, attachments: 5 })).toBe(
      "知识库快照 3、知识库附件 5",
    );

    const unknownLabels = [
      deliveryEventKindLabel("future_kind"),
      deliveryVisibilityLabel("future_visibility"),
      deliveryPriorityLabel("future_priority"),
      deliveryQuotaStateLabel("future_quota"),
      deliveryResultStatusLabel("future_result"),
      deliveryAttachmentAuthorizationLabel("future_authorization"),
      deliveryCleanupKeyLabel("future_cleanup"),
    ];
    expect(unknownLabels.every((label) => /[\u3400-\u9fff]/u.test(label))).toBe(
      true,
    );
  });
});
