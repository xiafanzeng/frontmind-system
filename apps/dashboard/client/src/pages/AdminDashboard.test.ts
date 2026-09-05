import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adminNav,
  annotateSharedKeyAccountCounts,
  apiUsageSyncStatusCopy,
  bulkApiKeyTargetsForScope,
  buildDeliveryEngineerStatusRows,
  channelDistributionUrl,
  filterApiKeyUsageForAdmin,
  filterPreviewApiKeyUsageForAdmin,
  filterPreviewTicketsForAdmin,
  formatApiUsageLastSuccess,
  formatAdminBrandTrackingCredits,
  getAdminNav,
  getPreviewAdminNav,
  getPreviewAdminWorkspaceHref,
  issueMonitorUrl,
  normalizeApiKeyUsageAlerts,
  normalizeBrandTrackingCredentialRows,
  normalizeUsageHierarchy,
  parseCredentialManagementDeepLink,
  resolveKeyPoolStale,
  usageHierarchyNeedsPolling,
  type KeyManagementRow,
} from "./AdminDashboard";
import { previewAdminNav } from "@/lib/preview-navigation";

describe("administrator channel navigation", () => {
  it("opens only validated API-management deep links", () => {
    expect(
      parseCredentialManagementDeepLink(
        "?credentialUserId=42&credentialKind=customer&relatedTicketId=00000000-0000-4000-8000-000000000001",
      ),
    ).toEqual({
      credentialType: "managed_api",
      kind: "customer",
      userId: 42,
      relatedTicketId: "00000000-0000-4000-8000-000000000001",
    });
    expect(
      parseCredentialManagementDeepLink(
        "?credentialUserId=42&credentialKind=customer",
      ),
    ).toEqual({
      credentialType: "managed_api",
      kind: "customer",
      userId: 42,
    });
    expect(
      parseCredentialManagementDeepLink(
        "?credentialType=jenova_brand_tracking&credentialUserId=42&relatedTicketId=00000000-0000-4000-8000-000000000001",
      ),
    ).toEqual({
      credentialType: "jenova_brand_tracking",
      kind: "customer",
      userId: 42,
      relatedTicketId: "00000000-0000-4000-8000-000000000001",
    });
    expect(
      parseCredentialManagementDeepLink(
        "?credentialType=jenova_brand_tracking&credentialUserId=42&credentialKind=engineer",
      ),
    ).toBeNull();
    expect(
      parseCredentialManagementDeepLink(
        "?credentialType=unknown&credentialUserId=42&credentialKind=customer",
      ),
    ).toBeNull();
    expect(
      parseCredentialManagementDeepLink(
        "?credentialUserId=42&credentialKind=customer&relatedTicketId=Jenova",
      ),
    ).toBeNull();
    expect(
      parseCredentialManagementDeepLink(
        "?credentialUserId=0&credentialKind=customer",
      ),
    ).toBeNull();
  });

  it.each([
    ["real", adminNav],
    ["preview", previewAdminNav],
  ])(
    "keeps the unified administrator navigation order in %s",
    (_name, navigation) => {
      expect(navigation.map((item) => item.label)).toEqual([
        "API与人员管理",
        "官网任务与AI建站",
        "客户交付工作台",
        "客户项目团队",
        "需求管理",
        "账号与权限",
        "问题监控",
        "渠道分发",
      ]);
    },
  );

  it.each([
    ["real", adminNav],
    ["preview", previewAdminNav],
  ])(
    "places the channel distribution link after issue monitoring in %s navigation",
    (_name, navigation) => {
      const issueIndex = navigation.findIndex(
        (item) => item.href === issueMonitorUrl,
      );
      const distributionIndex = navigation.findIndex(
        (item) => item.href === channelDistributionUrl,
      );
      const issueMonitor = navigation[issueIndex];
      const distribution = navigation[distributionIndex];

      expect(issueIndex).toBeGreaterThanOrEqual(0);
      expect(distributionIndex).toBe(issueIndex + 1);
      expect(issueMonitor).toMatchObject({
        label: "问题监控",
        external: true,
        newWindow: true,
      });
      expect(distribution).toMatchObject({
        label: "渠道分发",
        external: true,
        newWindow: true,
      });
    },
  );

  it.each([
    ["real", adminNav],
    ["preview", previewAdminNav],
  ])(
    "removes FrontMind Agent from %s system navigation",
    (_name, navigation) => {
      expect(navigation.some((item) => item.label === "FrontMind Agent")).toBe(
        false,
      );
      expect(
        navigation.some(
          (item) =>
            item.group === "Agent 与资源" || item.href.includes("workflow"),
        ),
      ).toBe(false);
      expect(
        navigation.find((item) => item.label === "官网任务与AI建站"),
      ).toMatchObject({ group: "运营" });
    },
  );

  it("keeps delivery administrators on the management modules and generic Agent", () => {
    const deliveryAdminNavigation = getAdminNav(false);

    expect(deliveryAdminNavigation.map((item) => item.label)).toEqual([
      "客户管理",
      "客户项目团队",
      "需求",
      "FrontMind Agent",
      "账号与权限",
    ]);
    expect(
      deliveryAdminNavigation.some((item) => item.href === "/admin/presales"),
    ).toBe(false);
    expect(deliveryAdminNavigation.some((item) => item.external)).toBe(false);
    expect(
      deliveryAdminNavigation.some((item) => item.href === "/admin/agent"),
    ).toBe(true);
    expect(
      deliveryAdminNavigation.find((item) => item.label === "账号与权限"),
    ).toMatchObject({ href: "/admin/users" });
    expect(
      deliveryAdminNavigation.some((item) =>
        item.href.includes("view=api-keys"),
      ),
    ).toBe(false);
  });

  it("keeps delivery and system acceptance pages permission-distinct", () => {
    const deliveryNavigation = getPreviewAdminNav(false);
    const systemNavigation = getPreviewAdminNav(true);

    expect(deliveryNavigation[0]?.href).toBe(
      "/preview/admin/delivery/workspace",
    );
    expect(
      deliveryNavigation.some(
        (item) => item.href === "/preview/admin/delivery/agent",
      ),
    ).toBe(true);
    expect(deliveryNavigation.map((item) => item.label)).toEqual([
      "客户管理",
      "客户项目团队",
      "需求",
      "FrontMind Agent",
      "账号与权限",
    ]);
    expect(
      deliveryNavigation.find((item) => item.label === "账号与权限"),
    ).toMatchObject({ href: "/preview/admin/delivery/accounts" });
    expect(
      deliveryNavigation.some(
        (item) =>
          item.href === "/preview/admin/accounts" ||
          item.href === "/preview/admin/presales",
      ),
    ).toBe(false);
    expect(systemNavigation[0]?.href).toBe("/preview/admin/system");
    expect(
      systemNavigation.some(
        (item) => item.href === "/preview/admin/system/accounts",
      ),
    ).toBe(true);
    expect(
      systemNavigation.some((item) => item.label === "FrontMind Agent"),
    ).toBe(false);
    expect(
      systemNavigation.some(
        (item) => item.href === "/preview/admin/system/workspace",
      ),
    ).toBe(true);
  });

  it("keeps workspace and ticket links in the current preview role", () => {
    expect(getPreviewAdminWorkspaceHref(false)).toBe(
      "/preview/admin/delivery/workspace",
    );
    expect(getPreviewAdminWorkspaceHref(false, "?tab=tickets")).toBe(
      "/preview/admin/delivery/workspace?tab=tickets",
    );
    expect(getPreviewAdminWorkspaceHref(true)).toBe(
      "/preview/admin/system/workspace",
    );
  });

  it("uses a concise delivery overview without duplicate toolbar actions", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDashboard.tsx"),
      "utf8",
    );
    expect(source).toContain('title="API与人员管理"');
    expect(source).not.toContain("打开客户交付工作台");
    expect(source).not.toContain(">创建客户<");
    expect(source).not.toContain("交付管理员积分");
    expect(source).not.toContain(
      "先选择交付管理员，再查看该管理员名下的 Key 池",
    );
    expect(source).not.toContain("管理员自用 Agent 积分");
    expect(source).toContain("统一 API Key 管理");
    expect(source).toContain("客户、交付管理员和工程师使用同一套管理入口");
    expect(source).not.toContain('["system_admin", "系统管理员"]');
    expect(source).toContain(
      "trpc.admin.apiKeyUsageAlerts.replaceTargetCredential.useMutation()",
    );
    expect(source).toContain(
      "trpc.admin.apiKeyUsageAlerts.revokeTargetCredential.useMutation()",
    );
    expect(source).toContain(
      "trpc.admin.apiKeyUsageAlerts.bulkReplaceTargetCredentials.useMutation()",
    );
    expect(source).toContain("批量配置 Key");
    expect(source).toContain("通用 Agent Key");
    expect(source).toContain("品牌追踪 Key");
    expect(source).toContain("批量分配品牌追踪 Key");
    expect(source).toContain("共享 Key 归因积分");
    expect(source).toContain("刷新唯一 Key 积分余额");
    expect(source).not.toContain("连接同步失败");
    expect(source).not.toContain("近 30 天费用");
    expect(source).not.toContain("个人费用");
    expect(source).not.toContain("美元");
    expect(source).toContain('confirmation: "BULK_REPLACE_API_KEYS"');
    expect(source).toContain("任一账号发生版本冲突都会全部回滚");
    expect(source).toContain("即使已失效也不会阻断轮换");
    expect(source).toContain("任务账本滚动累计");
    expect(source).not.toContain(
      "无法完整扫描时，整批会停止，需改用单账号应急替换",
    );
    expect(source).toContain('confirmation: "REPLACE_API_KEY"');
    expect(source).toContain('confirmation: "REVOKE_API_KEY"');
    expect(source).toContain("迟到请求不会覆盖较新的 Key");
    expect(source).toContain("近 30 天自用");
    expect(source).toContain("积分池总额");
    expect(source).not.toContain("Key 总额");
    expect(source).not.toContain("accountUsageComplete");
    expect(source).not.toContain("账号归因不完整");
    expect(source).toContain("row.rolling30DayUsed");
    expect(source).toContain("row.keyHealth");
    expect(source).toContain('value="frontmind-pro"');
    expect(source).toContain('value="frontmind-base"');
    expect(source).toContain("只读验收预览 · 近 30 天");
    expect(source).not.toContain("管理员通用 Agent");
    expect(source).not.toContain("从客户签约到交付验收的统一工作台");
    expect(source).not.toContain(
      "套餐权益、知识库流程、选题、应答逻辑、问题监控",
    );
    expect(source).toContain("工程师状态");
    expect(source).not.toContain("交付工单总览");
    expect(source).not.toContain("四角色交付状态");
    expect(source).not.toContain("stats?.pendingAssignment");
  });

  it("keeps brand-tracking accounting exact while presenting it as credits", () => {
    const rows = normalizeBrandTrackingCredentialRows({
      users: [
        {
          userId: 7,
          username: "overseas.customer",
          displayName: "海外客户",
          keyConfigured: true,
          credentialId: "00000000-0000-4000-8000-000000000001",
          fingerprint: "shared-fingerprint",
          rolling30DayCost: "1.00000001",
          lifetimeCost: "12.50000000",
          sharedKeyAttributedCost: "25.00000000",
          sharedAccountCount: 2,
          balance: "74.99999999",
          limit: "10.00000000",
          status: "active",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      rolling30DayCost: "1.00000001",
      sharedKeyAttributedCost: "25.00000000",
      balance: "74.99999999",
      sharedAccountCount: 2,
    });
    expect(formatAdminBrandTrackingCredits(rows[0]!.rolling30DayCost)).toBe(
      "1,000.00001积分",
    );
    expect(formatAdminBrandTrackingCredits(rows[0]!.lifetimeCost)).toBe(
      "12,500积分",
    );
    expect(formatAdminBrandTrackingCredits(rows[0]!.balance)).toBe(
      "74,999.99999积分",
    );
  });

  it("keeps system administrators and non-ok usage states in the unified hierarchy", () => {
    const normalized = normalizeUsageHierarchy({
      period: { label: "近 30 天" },
      systemAdmins: [
        {
          adminId: 1,
          displayName: "系统管理员",
          username: "system.admin",
          apiKeyConfigured: true,
          apiKeyVersion: 3,
          keyPoolTotalUsed: 20,
          rolling30DayUsed: 10,
          keyHealth: "sync_error",
          syncIssueCode: "RATE_LIMITED",
          fetchedAt: null,
        },
      ],
    });
    expect(normalized.systemAdmins).toEqual([
      expect.objectContaining({
        adminId: 1,
        apiKeyVersion: 3,
        keyHealth: "sync_error",
        syncIssueCode: "RATE_LIMITED",
        rolling30DayUsed: 10,
      }),
    ]);
  });

  it("shows actionable usage failure categories and a safe last-success time", () => {
    expect(
      apiUsageSyncStatusCopy({
        keyHealth: "sync_error",
        issueCode: "RATE_LIMITED",
      }),
    ).toBe("用量读取频率受限");
    expect(
      apiUsageSyncStatusCopy({
        keyHealth: "sync_error",
        issueCode: "PAGE_DRIFT",
      }),
    ).toBe("积分流水正在变化，等待重试");
    expect(formatApiUsageLastSuccess("2026-08-15T08:30:00.000Z")).toBe(
      "08/15 16:30",
    );
  });

  it("keeps rolling self-use independent from Key health", () => {
    const normalized = normalizeUsageHierarchy({
      engineers: [
        {
          engineerId: 9,
          displayName: "工程师",
          keyHealth: "invalid_or_revoked",
          rolling30DayUsed: 42,
        },
      ],
    });

    expect(normalized.engineers[0]?.rolling30DayUsed).toBe(42);
    expect(normalized.engineers[0]?.keyHealth).toBe("invalid_or_revoked");
  });

  it("preserves a connected engineer's server-side stale signal", () => {
    expect(
      resolveKeyPoolStale({ keyHealth: "connected", keyPoolStale: true }),
    ).toBe(true);
    expect(resolveKeyPoolStale({ keyHealth: "connected" })).toBe(false);
    expect(resolveKeyPoolStale({ keyHealth: "sync_error" })).toBe(true);
  });

  it("polls only while at least one hierarchy usage snapshot is pending", () => {
    expect(
      usageHierarchyNeedsPolling({
        systemAdmins: [{ keyHealth: "connected" }],
        engineers: [{ keyHealth: "pending" }],
      }),
    ).toBe(true);
    expect(
      usageHierarchyNeedsPolling({
        managers: [
          {
            keyPool: { keyHealth: "connected" },
            users: [{ keyHealth: "pending" }],
          },
        ],
      }),
    ).toBe(true);
    expect(
      usageHierarchyNeedsPolling({
        systemAdmins: [{ keyHealth: "connected" }],
        engineers: [{ keyHealth: "sync_error" }],
        customers: [{ keyHealth: "unconfigured" }],
        managers: [{ keyPool: { keyHealth: "connected" }, users: [] }],
      }),
    ).toBe(false);
  });

  it("labels every account that uses the same physical Key as shared", () => {
    const rows = annotateSharedKeyAccountCounts([
      { userId: 1, fingerprint: "fp_shared" },
      { userId: 2, fingerprint: "fp_shared" },
      { userId: 3, fingerprint: "fp_unique" },
      { userId: 4, fingerprint: null },
    ]);

    expect(rows.map((row) => row.sharedKeyAccountCount)).toEqual([2, 2, 1, 0]);
  });

  it("presents delivery workload as one status row per engineer", () => {
    const rows = buildDeliveryEngineerStatusRows({
      engineers: [
        {
          id: 11,
          username: "engineer.busy",
          displayName: "忙碌工程师",
          isActive: true,
          engineerRoleType: "ai_operations_engineer",
          apiKeyConfigured: true,
        },
        {
          id: 12,
          username: "engineer.waiting",
          displayName: "等待工程师",
          isActive: true,
          engineerRoleType: "monitoring_optimization_engineer",
          apiKeyConfigured: false,
        },
        {
          id: 13,
          username: "engineer.free",
          displayName: "空闲工程师",
          isActive: true,
          engineerRoleType: "content_distribution_engineer",
          apiKeyConfigured: true,
        },
      ],
      projects: [
        { id: 101, displayName: "甲公司" },
        { id: 102, displayName: "乙公司" },
      ],
      assignments: [
        { customerUserId: 101, engineerUserId: 11 },
        { customerUserId: 102, engineerUserId: 11 },
        { customerUserId: 102, engineerUserId: 12 },
      ],
      tickets: [
        { assignedMemberId: 11, status: "in_progress" },
        { assignedMemberId: 11, status: "needs_information" },
        { assignedMemberId: 12, status: "needs_information" },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual([11, 12, 13]);
    expect(rows[0]).toMatchObject({
      projectNames: ["甲公司", "乙公司"],
      projectCount: 2,
      activeTicketCount: 2,
      workStatus: "processing",
      workStatusLabel: "处理中 · 1 单",
      apiKeyConfigured: true,
    });
    expect(rows[1]).toMatchObject({
      projectNames: ["乙公司"],
      workStatus: "waiting_customer",
      workStatusLabel: "等待客户 · 1 单",
      apiKeyConfigured: false,
    });
    expect(rows[2]).toMatchObject({
      projectNames: [],
      workStatus: "unassigned",
      workStatusLabel: "未分配项目",
    });
  });

  it("puts disabled engineer accounts after active engineers", () => {
    const rows = buildDeliveryEngineerStatusRows({
      engineers: [
        {
          id: 21,
          username: "disabled",
          isActive: false,
          engineerRoleType: "ai_operations_engineer",
        },
        {
          id: 22,
          username: "available",
          isActive: true,
          engineerRoleType: "ai_operations_engineer",
        },
      ],
      projects: [{ id: 201, displayName: "示例客户" }],
      assignments: [{ customerUserId: 201, engineerUserId: 22 }],
      tickets: [],
    });

    expect(rows.map((row) => row.id)).toEqual([22, 21]);
    expect(rows[0]?.workStatus).toBe("available");
    expect(rows[1]).toMatchObject({
      workStatus: "disabled",
      workStatusLabel: "账号已停用",
      isActive: false,
    });
  });

  it("normalizes API Key snapshots with independent default policies", () => {
    expect(
      normalizeApiKeyUsageAlerts({
        items: [
          {
            id: "website",
            scope: "website_frontend",
            used: 184000,
            limit: 230000,
            warningRatio: 0.8,
            windowDays: 30,
            syncStatus: "ok",
          },
          {
            id: "customer",
            scope: "managed_user",
            userId: 8,
            enterpriseName: "示例企业",
            used: 12,
            syncStatus: "error",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "website",
        scope: "website_frontend",
        used: 184000,
        limit: 230000,
      }),
      expect.objectContaining({
        id: "customer",
        scope: "managed_user",
        userId: 8,
        limit: 230000,
      }),
    ]);
  });

  it("never exposes the global website key to a delivery administrator", () => {
    const alerts = normalizeApiKeyUsageAlerts({
      items: [
        {
          id: "website",
          scope: "website_frontend",
          used: 184000,
          syncStatus: "ok",
        },
        {
          id: "customer",
          scope: "managed_user",
          userId: 8,
          used: 12000,
          syncStatus: "ok",
        },
      ],
    });

    expect(filterApiKeyUsageForAdmin(alerts, false)).toEqual([
      expect.objectContaining({ id: "customer", scope: "managed_user" }),
    ]);
    expect(filterApiKeyUsageForAdmin(alerts, true)).toHaveLength(2);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, false, [9])).toEqual([]);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, false, [8])).toEqual([
      expect.objectContaining({ id: "customer", userId: 8 }),
    ]);
    expect(filterPreviewApiKeyUsageForAdmin(alerts, true, [])).toHaveLength(2);
  });

  it("keeps delivery administrators separate even when they share one upstream Key", () => {
    const hierarchy = normalizeUsageHierarchy({
      period: { label: "2026 年 7 月" },
      engineers: [
        {
          engineerId: 21,
          displayName: "工程师一组",
          apiKeyConfigured: true,
          apiKeyVersion: 3,
          keyPoolTotalUsed: 900,
          rolling30DayUsed: 240,
          keyHealth: "connected",
        },
      ],
      customers: [
        {
          userId: 101,
          enterpriseName: "甲公司",
          deliveryAdminId: 11,
          deliveryAdminName: "交付一组",
          apiKeyConfigured: false,
          apiKeyVersion: 2,
          usesInheritedKey: true,
          keyPoolTotalUsed: 1_000,
          rolling30DayUsed: 300,
          keyHealth: "connected",
        },
      ],
      managers: [
        {
          adminId: 11,
          displayName: "交付一组",
          keyPool: { fingerprint: "fp_shared", totalUsed: 1_000 },
          rolling30DayUsed: 120,
          users: [
            {
              userId: 101,
              enterpriseName: "甲公司",
              rolling30DayUsed: 300,
              fingerprint: "fp_customer",
              credentialSource: "customer",
            },
          ],
        },
        {
          adminId: 12,
          displayName: "交付二组",
          keyPool: { fingerprint: "fp_shared", totalUsed: 1_000 },
          rolling30DayUsed: 80,
          users: [
            { userId: 102, enterpriseName: "乙公司", rolling30DayUsed: 200 },
          ],
        },
      ],
    });

    expect(hierarchy.managers).toHaveLength(2);
    expect(hierarchy.managers.map((manager) => manager.adminId)).toEqual([
      11, 12,
    ]);
    expect(hierarchy.managers[0]?.users[0]?.rolling30DayUsed).toBe(300);
    expect(hierarchy.managers[0]?.users[0]?.credentialSource).toBe("customer");
    expect(hierarchy.managers[0]?.users[0]?.usesManagerKey).toBe(false);
    expect(hierarchy.managers[1]?.users[0]?.rolling30DayUsed).toBe(200);
    expect(
      hierarchy.managers.map((manager) => manager.keyPool.totalUsed),
    ).toEqual([1_000, 1_000]);
    expect(hierarchy.engineers[0]).toMatchObject({
      engineerId: 21,
      apiKeyConfigured: true,
      apiKeyVersion: 3,
      keyPoolTotalUsed: 900,
      rolling30DayUsed: 240,
    });
    expect(hierarchy.customers[0]).toMatchObject({
      userId: 101,
      deliveryAdminName: "交付一组",
      apiKeyConfigured: false,
      apiKeyVersion: 2,
      usesInheritedKey: true,
      keyPoolTotalUsed: 1_000,
      rolling30DayUsed: 300,
    });
  });

  it("does not expose another manager's preview tickets to a delivery administrator", () => {
    const tickets = [
      {
        id: "own",
        assignedAdminId: 101,
        assignedAdminName: "当前管理员",
      },
      {
        id: "shared",
        assignedAdmins: [
          { id: 101, name: "当前管理员" },
          { id: 102, name: "协作管理员" },
        ],
      },
      {
        id: "other",
        assignedAdminId: 103,
        assignedAdminName: "其他管理员",
      },
    ];

    expect(
      filterPreviewTicketsForAdmin(tickets, false, "101").map(
        (ticket) => ticket.id,
      ),
    ).toEqual(["own", "shared"]);
    expect(filterPreviewTicketsForAdmin(tickets, true, "101")).toEqual(tickets);
  });
});

describe("bulk API Key target previews", () => {
  function keyRow(
    input: Pick<KeyManagementRow, "kind" | "userId" | "deliveryAdminId"> &
      Partial<KeyManagementRow>,
  ): KeyManagementRow {
    return {
      displayName: `账号 ${input.userId}`,
      username: `user-${input.userId}`,
      configured: false,
      version: 0,
      typeLabel: "账号",
      scopeLabel: "测试范围",
      isActive: true,
      inherited: false,
      ownAgentMonthUsed: 0,
      accountUsageComplete: true,
      keyTotalUsed: 0,
      otherOrUnattributedUsed: 0,
      syncStatus: "unconfigured",
      fetchedAt: null,
      ...input,
    };
  }

  const rows: KeyManagementRow[] = [
    keyRow({
      kind: "delivery_admin",
      userId: 10,
      deliveryAdminId: 10,
    }),
    keyRow({ kind: "customer", userId: 11, deliveryAdminId: 10 }),
    keyRow({ kind: "customer", userId: 12, deliveryAdminId: 20 }),
    keyRow({ kind: "engineer", userId: 30, deliveryAdminId: null }),
    keyRow({
      kind: "customer",
      userId: 13,
      deliveryAdminId: 10,
      isActive: false,
    }),
  ];

  it("includes every active account in the all scope and excludes disabled accounts", () => {
    expect(
      bulkApiKeyTargetsForScope(rows, { kind: "all" }).map(
        (target) => target.userId,
      ),
    ).toEqual([10, 11, 12, 30]);
  });

  it("previews one delivery manager plus owned customers without engineers", () => {
    expect(
      bulkApiKeyTargetsForScope(rows, {
        kind: "delivery_admin",
        deliveryAdminId: 10,
      }).map((target) => target.userId),
    ).toEqual([10, 11]);
  });

  it("previews only explicitly selected engineers", () => {
    expect(
      bulkApiKeyTargetsForScope(rows, {
        kind: "engineers",
        engineerIds: [30],
      }).map((target) => target.userId),
    ).toEqual([30]);
  });
});
