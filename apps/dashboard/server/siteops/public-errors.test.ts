import { describe, expect, it } from "vitest";
import {
  publicSiteOpsErrorProjection,
  publicSiteOpsMessageText,
  publicSiteOpsProviderResult,
  sanitizeFrontMindPublicText,
} from "./public-errors";

describe("SiteOps public error projection", () => {
  it("hides the provider name and raw invalid argument from customers", () => {
    const projected = publicSiteOpsErrorProjection({
      code: "invalid_argument",
      message: "Manus task.create failed (invalid_argument)",
      status: "failed",
    });
    expect(projected).toEqual({
      code: "FRONTMIND_BUILD_REQUEST_INVALID",
      message:
        "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus|invalid_argument/iu);
  });

  it("keeps non-build provider errors unchanged", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "ALIYUN_REAUTHORIZE_REQUIRED",
        message: "阿里云连接需要重新授权。",
      }),
    ).toEqual({
      code: "ALIYUN_REAUTHORIZE_REQUIRED",
      message: "阿里云连接需要重新授权。",
    });
  });

  it("projects provider results before persistence", () => {
    const projected = publicSiteOpsProviderResult("manus", {
      status: "outcome_unknown",
      code: "PROVIDER_TIMEOUT",
      message: "Manus 外部操作结果未知。",
    });
    expect(projected).toMatchObject({
      status: "outcome_unknown",
      code: "FRONTMIND_BUILD_RESULT_PENDING",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus/iu);
  });

  it("sanitizes historical server-owned message text", () => {
    expect(sanitizeFrontMindPublicText("Manus 暂时无法完成该任务")).toBe(
      "FrontMind AI 建站任务未能完成，请提交工单获取协助。",
    );
  });

  it("sanitizes technical history at the server observation boundary", () => {
    for (const content of [
      "SiteOps 使用 React 静态生成官网。",
      "21st 视觉候选已完成。",
      "个人 API Key 与 Pro 已随官网版本锁定。",
    ]) {
      const projected = publicSiteOpsMessageText({ content });
      expect(projected).not.toMatch(/SiteOps|React|21st|API\s*Key|\bPro\b/iu);
    }
    expect(
      publicSiteOpsMessageText({ content: "SiteOps 项目已打开。" }),
    ).toContain("AI友好官网管理");
    expect(
      publicSiteOpsMessageText({
        content: "Manus invalid_argument",
        errorCode: "invalid_argument",
      }),
    ).toBe(
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    );
  });

  it("keeps an already-public attention error stable during observation", () => {
    expect(
      publicSiteOpsMessageText({
        content: "本次没有生成可安全展示的版本。",
        errorCode: "FRONTMIND_BUILD_REQUIRES_ATTENTION",
        operationStatus: "attention_required",
      }),
    ).toBe(
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    );
  });

  it("uses operation status when projecting a legacy raw build error", () => {
    expect(
      publicSiteOpsMessageText({
        content: "legacy provider failure",
        errorCode: "FRONTMIND_BUILD_UNKNOWN",
        operationStatus: "attention_required",
      }),
    ).toBe(
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    );
  });

  it("does not hide an explicit service outage behind a reset message", () => {
    expect(
      publicSiteOpsMessageText({
        content: "FrontMind AI 建站服务暂时不可用，请稍后重试。",
        errorCode: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
        operationStatus: "attention_required",
      }),
    ).toBe("FrontMind AI 建站服务暂时不可用，请稍后重试。");
  });

  it("does not project publishing runtime diagnostics into customer readiness", () => {
    const projected = sanitizeFrontMindPublicText(
      "ESA 无法使用当前 AliDNS access token 验证 CNAME",
    );
    expect(projected).toBe(
      "FrontMind 暂未完成网站配置，请稍后重试或提交工单获取协助。",
    );
    expect(projected).not.toMatch(/ESA|AliDNS|access\s*token|CNAME/iu);
  });

  it("keeps the stable output-invalid code after three FrontMind repairs", () => {
    const projected = publicSiteOpsErrorProjection({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: "同一 Manus 建站任务已自动修复 3 次。",
      status: "failed",
    });
    expect(projected).toEqual({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message:
        "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    });
    expect(JSON.stringify(projected)).not.toMatch(/manus/iu);
  });

  it.each([
    "NATIVE_SOURCE_ARCHIVE_INVALID",
    "SITEOPS_NATIVE_SOURCE_PACKAGE_JSON_INVALID",
    "SITEOPS_NATIVE_SOURCE_RECEIPT_INVALID",
  ])("projects %s as a safe source-output failure", (code) => {
    expect(
      publicSiteOpsErrorProjection({
        code,
        message: "internal native source diagnostic",
        status: "failed",
        forceBuildProvider: true,
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message:
        "返回源码未通过安全、格式或任务绑定校验；如已有成功预览将继续保留，否则可申请重置后重新开始。",
    });
  });

  it.each([
    "VISUAL_SELECTION_BUNDLE_MISSING",
    "VISUAL_SELECTION_BUNDLE_INVALID",
    "VISUAL_SELECTION_COORDINATES_MISMATCH",
    "VISUAL_EVIDENCE_COORDINATES_MISMATCH",
  ])("projects frozen visual contract failure %s as output-invalid", (code) => {
    const projected = publicSiteOpsErrorProjection({
      code,
      message: "internal frozen visual bundle/hash mismatch",
      status: "failed",
      forceBuildProvider: true,
    });
    expect(projected).toEqual({
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message:
        "冻结的视觉参考未通过完整性或任务绑定校验；如已有成功预览将继续保留，否则可申请重置后重新开始。",
    });
    expect(projected.code).not.toBe("FRONTMIND_BUILD_SERVICE_UNAVAILABLE");
  });

  it("normalizes a frozen customer credential failure to the public configuration code", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "FRONTMIND_CUSTOMER_CREDENTIAL_VERSION_UNAVAILABLE",
        message: "当前账号绑定的 AI 建站 API Key 版本不可用。",
        status: "attention_required",
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      message: "FrontMind AI 建站服务配置暂不可用，系统已停止继续创建任务。",
    });
  });

  it("keeps provider sync attention recoverable without exposing provider internals", () => {
    const kinds = ["contract", "source", "dist", "qa", "provenance"] as const;
    const artifactBindings = Object.fromEntries(
      kinds.map((kind, index) => [
        kind,
        {
          id: `70000000-0000-4000-8000-00000000000${index + 1}`,
          sha256: String(index + 1).repeat(64),
          bytes: index + 1,
          mimeType:
            kind === "contract" || kind === "provenance"
              ? "application/json"
              : "application/zip",
        },
      ]),
    );
    expect(
      publicSiteOpsProviderResult("manus", {
        status: "attention_required",
        code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
        message: "provider reconciliation expired",
        result: {
          fallbackPreview: {
            status: "bound",
            trigger: "provider_read_delayed",
            createdAt: "2026-08-27T00:15:00.000Z",
            reconcileUntilAt: "2026-08-28T00:00:00.000Z",
            buildId: "30000000-0000-4000-8000-000000000003",
            taskId: "customer-private-task-1",
            operationToken:
              "siteops-native-fallback:10000000-0000-4000-8000-000000000001",
            selectedPreviewSha256: "a".repeat(64),
            selectedSourceTreeSha256: "b".repeat(64),
            artifactBindings,
            buildDelivery: {
              renderMode: "trusted_fallback",
              qaStatus: "partial",
              warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
            },
          },
        },
      }),
    ).toMatchObject({
      status: "attention_required",
      code: "FRONTMIND_BUILD_RECONCILIATION_REQUIRED",
      message: expect.stringContaining("原任务编号"),
    });
    expect(
      publicSiteOpsProviderResult("manus", {
        status: "attention_required",
        code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
        message: "provider reconciliation expired",
      }),
    ).toMatchObject({
      code: "FRONTMIND_BUILD_REQUIRES_ATTENTION",
      message: expect.not.stringContaining("基础预览已保留"),
    });
  });

  it("keeps host QA failures distinct from platform configuration failures", () => {
    expect(
      publicSiteOpsErrorProjection({
        code: "SITEOPS_HOST_MATERIALIZATION_FAILED",
        message: "受信 Astro 构建或 QA 未完成。",
        status: "attention_required",
        forceBuildProvider: true,
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_QA_FAILED",
      message:
        "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    });
    expect(
      publicSiteOpsErrorProjection({
        code: "MANUS_CREDENTIAL_VERSION_UNAVAILABLE",
        message: "provider credential unavailable",
        status: "attention_required",
        forceBuildProvider: true,
      }),
    ).toEqual({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      message: "FrontMind AI 建站服务配置暂不可用，系统已停止继续创建任务。",
    });
  });

  it.each([
    [
      "FRONTMIND_BUILD_ASSET_CONFLICT",
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    ],
    [
      "FRONTMIND_BUILD_COMPILE_FAILED",
      "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
    ],
    [
      "FRONTMIND_BUILD_RUNTIME_UNAVAILABLE",
      "FrontMind AI 建站运行环境暂时不可用；若任务已经结束，可申请重置，批准后全新开始。",
    ],
  ] as const)("keeps %s as a distinct FrontMind error", (code, message) => {
    expect(
      publicSiteOpsErrorProjection({
        code,
        message: "provider internals",
        status: "failed",
        forceBuildProvider: true,
      }),
    ).toEqual({ code, message });
  });
});
