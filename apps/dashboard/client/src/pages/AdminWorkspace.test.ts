import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_WORKSPACE_TAB_IDS,
  defaultAdminServiceCarryQuestionIds,
  isAdminProgressiveLuxuryRenewal,
  isFutureDatedServiceCancellation,
  resolveAdminServiceStartsAtEpoch,
  resolveAdminTargetLuxuryPlanVersion,
} from "./AdminWorkspace";

describe("admin customer workspace", () => {
  it("allows only immediate service cancellation", () => {
    const now = Date.parse("2026-08-10T04:00:00.000Z");
    expect(
      isFutureDatedServiceCancellation({
        status: "cancelled",
        startsAt: now + 1,
        now,
      }),
    ).toBe(true);
    expect(
      isFutureDatedServiceCancellation({
        status: "cancelled",
        startsAt: now,
        now,
      }),
    ).toBe(false);
    expect(
      isFutureDatedServiceCancellation({
        status: "scheduled",
        startsAt: now + 1,
        now,
      }),
    ).toBe(false);
  });

  it("keeps customer account creation exclusively in accounts and permissions", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).not.toContain("CreateUserDialog");
    expect(source).not.toContain("创建客户");
    expect(source).not.toContain('get("action") === "create"');
    expect(source).toContain(
      'title={isSystemAdmin ? "客户交付工作台" : "客户管理"}',
    );
  });

  it("keeps the canonical workspace route without a redundant visible tab", () => {
    expect(ADMIN_WORKSPACE_TAB_IDS).toEqual(["workspace"]);
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain("ADMIN_WORKSPACE_TABS");
    expect(source).not.toContain("adminWorkspaceTabsForAccess");
    expect(source).toContain("进入客户看板");
    expect(source).toContain('variant="operatorOutline"');
  });

  it("removes the obsolete global customer Key and credit panel", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).not.toContain("客户 Key 与积分");
    expect(source).not.toContain("客户 API Key");
    expect(source).not.toContain("本月积分使用");
    expect(source).not.toContain("creditUsage.useQuery");
    expect(source).not.toContain("replaceCredential.useMutation");
  });

  it("combines service and demand work without embedding the customer dashboard", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).not.toContain('{tab === "workspace" &&');
    expect(source).not.toContain("setTab(");
    expect(source).not.toContain('{tab === "service" &&');
    expect(source).not.toContain('{tab === "tickets" &&');
    expect(source).toContain("<AdminDeliveryTicketWorkspace");
    expect(source).toContain("<DashboardVersionHistory");
    expect(source).not.toContain("onOpenCustomerDashboard=");
    expect(source).toContain('mode="fullscreen"');
    expect(source).toContain("<DashboardSkeletonEditor");
    expect(source).toContain('dashboardLayout="workspace"');
    expect(source).toContain("onExitDashboard={() => setDashboardOpen(false)}");
    expect(source).toContain("<CustomerDashboardMirror");
    expect(source).toContain('layout="workspace"');
    expect(source).toContain("servicePortal={serviceQuery.data}");
    expect(source).toContain("servicePortalLoading={serviceQuery.isLoading}");
    expect(source).not.toContain('heading="客户实际页面"');
    expect(source).not.toContain("这里与客户账号看到的完整看板一致。");
    expect(source).not.toContain("正式版本 R");
    expect(source).toContain("websiteWorkspace={websiteWorkspacePreview}");
    expect(source).toContain("knowledgePreview={customerKnowledgePreview}");
    expect(source).toContain("activity: knowledgeActivityQuery.data");
    expect(source).not.toContain('{tab === "knowledge"');
    expect(source).not.toContain('label: "知识库流程"');
    expect(source).not.toContain('{tab === "delivery"');
    expect(source).not.toContain('{tab === "activity"');
    expect(source).not.toContain("客户工作区操作记录");
    expect(source).not.toContain("只读验收");
    expect(source).not.toContain("/preview");
  });

  it("does not request or render the removed manual-order queue", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain(".manualOrders");
    expect(source).not.toContain("人工签约与开通待办");
    expect(source).not.toContain("ManualOrderCard");
  });

  it("removes the duplicate workflow, quota, and question-library panels", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).not.toContain("智能交付路径");
    expect(source).not.toContain("当前服务周期配额");
    expect(source).not.toContain("企业问题库");
    expect(source).not.toContain("AdminQuestionRow");
  });

  it("does not render or submit order and contract identifiers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain("订单 / 付款编号");
    expect(source).not.toContain("合同编号");
    expect(source).not.toContain("serviceOrderReference");
    expect(source).not.toContain("serviceContractReference");
    expect(source).not.toContain("新增签署或收款核验依据");
    expect(source).not.toContain("serviceEvidenceNote");
  });

  it("does not offer the removed knowledge-only service plan", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );
    expect(source).not.toContain('<option value="knowledge">');
  });

  it("describes Luxury as an annual progressively unlocked entitlement", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("豪华版 v2 为 12 个月权益");
    expect(source).toContain("按季度自动解锁问题额度");
    expect(source).toContain("预付月份仍按 3");
    expect(source).toContain("豪华版年度续费默认不结转");
    expect(source).toContain("取消合同会立即终止当前问题工作流");
    expect(source).toMatch(
      /progressiveLuxuryRenewal\s*\|\|\s*serviceTermination/,
    );
    expect(source).not.toContain("进阶版与豪华版合同均按 3 个月服务周期建立");
  });

  it("defaults only Luxury-to-Luxury renewal to no question carryover", () => {
    const currentContractId = "contract-current";
    const validUntil = Date.parse("2027-07-01T00:00:00.000Z");
    const purchases = [
      {
        id: currentContractId,
        planCode: "luxury" as const,
        status: "active",
        validUntil,
      },
    ];
    const questions = [
      {
        id: "question-current",
        contractId: currentContractId,
        status: "selected",
      },
      {
        id: "question-candidate",
        contractId: currentContractId,
        status: "candidate",
      },
    ];

    expect(
      defaultAdminServiceCarryQuestionIds({
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        targetStartsAt: validUntil,
        purchases,
        questions,
      }),
    ).toEqual([]);
    expect(
      defaultAdminServiceCarryQuestionIds({
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        targetStartsAt: validUntil - 1,
        purchases,
        questions,
      }),
    ).toEqual(["question-current"]);
    expect(
      isAdminProgressiveLuxuryRenewal({
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        targetStartsAt: validUntil,
        purchases,
      }),
    ).toBe(true);
    for (const [sourcePlanCode, targetPlanCode] of [
      ["advanced", "advanced"],
      ["advanced", "luxury"],
      ["luxury", "advanced"],
    ] as const) {
      expect(
        defaultAdminServiceCarryQuestionIds({
          sourcePlanCode,
          targetPlanCode,
          currentContractId,
          questions,
        }),
      ).toEqual(["question-current"]);
    }

    expect(
      defaultAdminServiceCarryQuestionIds({
        sourcePlanCode: "basic",
        targetPlanCode: "basic",
        currentContractId,
        purchases: [
          { id: "basic-active", planCode: "basic", status: "active" },
          { id: "basic-scheduled", planCode: "basic", status: "scheduled" },
          { id: "basic-expired", planCode: "basic", status: "expired" },
        ],
        questions: [
          {
            id: "question-basic-active",
            contractId: "basic-active",
            status: "selected",
          },
          {
            id: "question-basic-scheduled",
            contractId: "basic-scheduled",
            status: "selected",
          },
          {
            id: "question-basic-expired",
            contractId: "basic-expired",
            status: "selected",
          },
        ],
      }),
    ).toEqual(["question-basic-active", "question-basic-scheduled"]);
  });

  it("snaps a Luxury renewal date to the source contract's exact Shanghai expiry instant", () => {
    const currentContractId = "contract-current";
    const validFrom = Date.parse("2026-08-10T04:00:00.000Z");
    const validUntil = Date.parse("2027-08-10T04:00:00.000Z");
    const purchases = [
      {
        id: currentContractId,
        planCode: "luxury" as const,
        status: "active",
        validFrom,
        validUntil,
      },
    ];
    expect(
      resolveAdminServiceStartsAtEpoch({
        dateInput: "2027-08-10",
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        purchases,
      }),
    ).toBe(validUntil);
    expect(
      resolveAdminServiceStartsAtEpoch({
        dateInput: "2027-08-09",
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        purchases,
      }),
    ).toBe(Date.parse("2027-08-08T16:00:00.000Z"));
    expect(
      resolveAdminServiceStartsAtEpoch({
        dateInput: "2026-08-10",
        sourcePlanCode: "luxury",
        targetPlanCode: "luxury",
        currentContractId,
        purchases,
      }),
    ).toBe(validFrom);
  });

  it("labels an overlapping Luxury v1 correction separately from its v2 renewal", () => {
    const validUntil = Date.parse("2026-10-01T00:00:00.000Z");
    expect(
      resolveAdminTargetLuxuryPlanVersion({
        sourcePlanCode: "luxury",
        sourcePlanVersion: 1,
        sourceValidUntil: validUntil,
        targetStartsAt: validUntil - 1,
      }),
    ).toBe(1);
    expect(
      resolveAdminTargetLuxuryPlanVersion({
        sourcePlanCode: "luxury",
        sourcePlanVersion: 1,
        sourceValidUntil: validUntil,
        targetStartsAt: validUntil,
      }),
    ).toBe(2);
  });

  it("keeps customer identity readable beside the assignment editor", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]");
    expect(source).toContain(
      'className="mt-1 truncate text-2xl font-semibold text-[#171321]"',
    );
    expect(source).toContain(
      'className="mt-2 truncate text-sm text-[#716a80]"',
    );
  });

  it("uses the canonical brand-tracking manager scoped to the selected customer", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain("<AdminBrandTrackingKeyManager");
    expect(source).toContain("restrictedUserId={selectedUser.id}");
    expect(source).not.toContain("JenovaSentimentManagementPanel");
    expect(source).not.toContain("jenovaSentiment");
  });
});
