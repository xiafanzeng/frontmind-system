import { describe, expect, it } from "vitest";

import {
  siteOpsActionSchema,
  siteOpsAliyunDomainListSchema,
  siteOpsCardKindSchema,
  siteOpsOperationKindSchema,
} from "./siteops";

describe("SiteOps OAuth-only public contract", () => {
  it("keeps domain synchronization internal stages without domain commerce", () => {
    expect(siteOpsOperationKindSchema.parse("domain_sync")).toBe("domain_sync");
    expect(siteOpsOperationKindSchema.parse("dns_apply")).toBe("dns_apply");
    expect(siteOpsOperationKindSchema.parse("dns_rollback")).toBe(
      "dns_rollback",
    );

    for (const removed of [
      "domain_search",
      "domain_purchase",
      "domain_renewal",
      "domain_auto_renew",
    ]) {
      expect(siteOpsOperationKindSchema.safeParse(removed).success).toBe(false);
    }
  });

  it("exposes one customer domain-sync action and no manual DNS or recovery action", () => {
    for (const retained of [
      "request_rebuild",
      "request_revision",
      "domain_sync",
      "rollback",
    ]) {
      expect(siteOpsActionSchema.safeParse(retained).success).toBe(true);
    }
    for (const removed of [
      "reset_workflow",
      "resume_build",
      "change_snapshot",
      "domain_search",
      "domain_prepare_purchase",
      "domain_confirm_purchase",
      "domain_prepare_renewal",
      "domain_confirm_renewal",
      "domain_set_auto_renew",
      "dns_plan",
      "dns_apply",
      "dns_rollback",
    ]) {
      expect(siteOpsActionSchema.safeParse(removed).success).toBe(false);
    }
    expect(siteOpsCardKindSchema.safeParse("domain_quote").success).toBe(false);
    expect(siteOpsCardKindSchema.safeParse("operation_recovery").success).toBe(
      false,
    );
  });

  it("returns only normalized domain display coordinates", () => {
    expect(
      siteOpsAliyunDomainListSchema.parse({
        domains: [
          { domain: "example.cn", displayDomain: "example.cn" },
          { domain: "xn--fsqu00a.cn", displayDomain: "例子.cn" },
        ],
      }),
    ).toEqual({
      domains: [
        { domain: "example.cn", displayDomain: "example.cn" },
        { domain: "xn--fsqu00a.cn", displayDomain: "例子.cn" },
      ],
    });
    expect(
      siteOpsAliyunDomainListSchema.safeParse({
        domains: [
          {
            domain: "example.cn",
            displayDomain: "example.cn",
            accountUid: "123456789",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
