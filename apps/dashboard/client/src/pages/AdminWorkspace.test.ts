import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_WORKSPACE_TAB_IDS,
  ADMIN_WORKSPACE_TABS,
} from "./AdminWorkspace";

describe("admin customer workspace", () => {
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

  it("keeps knowledge-base work inside the unified user-flow tab", () => {
    expect(ADMIN_WORKSPACE_TAB_IDS).toEqual(["service", "tickets"]);
    expect(ADMIN_WORKSPACE_TABS.map((item) => item.label)).toEqual([
      "用户流程",
      "工单",
    ]);
  });

  it("removes per-customer Key and credit management for every administrator", () => {
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

  it("folds delivery content into service and removes the workspace audit tab", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminWorkspace.tsx"),
      "utf8",
    );

    expect(source).toContain('{tab === "service" &&');
    expect(source).toContain("<DashboardSkeletonEditor");
    expect(source).toContain("<CustomerDashboardMirror");
    expect(source).toContain("servicePortal={serviceQuery.data}");
    expect(source).toContain("servicePortalLoading={serviceQuery.isLoading}");
    expect(source).not.toContain('heading="客户实际页面"');
    expect(source).not.toContain("这里与客户账号看到的完整看板一致。");
    expect(source).not.toContain("正式版本 R");
    expect(source).toContain("websiteWorkspace={websiteWorkspacePreview}");
    expect(source).toContain("knowledgePreview={{");
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
});
