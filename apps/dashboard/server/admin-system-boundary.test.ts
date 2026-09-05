import { describe, expect, it } from "vitest";

import type { TrpcContext } from "./_core/context";
import {
  adminRouter,
  managedMonitoringCitationSummaryValue,
} from "./admin-router";
import type { AuthenticatedUser } from "./auth-service";

function ordinaryAdminContext(): TrpcContext {
  const now = new Date("2026-07-26T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: 42,
    openId: null,
    username: "assigned.manager",
    displayName: "所属管理员",
    name: "所属管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel: "delivery_admin",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function nonAdminContext(role: "user" | "delivery_member"): TrpcContext {
  const now = new Date("2026-07-26T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: role === "delivery_member" ? 84 : 85,
    openId: null,
    username: role === "delivery_member" ? "monitor.engineer" : "customer",
    displayName: role === "delivery_member" ? "监控工程师" : "客户",
    name: role === "delivery_member" ? "监控工程师" : "客户",
    email: null,
    loginMethod: "password",
    role,
    adminAccessLevel: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("system administrator boundary", () => {
  it.each(["delivery_member", "user"] as const)(
    "forbids %s accounts from permanently deleting customer demands",
    async (role) => {
      const caller = adminRouter.createCaller(nonAdminContext(role));
      await expect(
        caller.deliveryTickets.delete({
          userId: 7,
          ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          expectedRevision: 1,
          confirmation: "DELETE_TICKET",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("keeps the administrator citation summary in the selected platform and date scope", () => {
    expect(
      managedMonitoringCitationSummaryValue({
        batchKey: "batch-2026-07-24",
        questionId: "question-1",
        model: "deepseek",
        from: "2026-07-24",
        to: "2026-07-27",
      }),
    ).toEqual({
      batchKey: "batch-2026-07-24",
      questionId: "question-1",
      model: "deepseek",
      from: "2026-07-24",
      to: "2026-07-27",
    });
  });

  it.each([
    [
      "list all accounts",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.list(),
    ],
    [
      "create an administrator account",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.create({
          username: "new.admin",
          displayName: "新管理员",
          password: "replacement-password-2026",
          role: "admin",
          adminAccessLevel: "delivery_admin",
        }),
    ],
    [
      "activate customer commercial entitlements",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.workspace.updateService({
          userId: 7,
          expectedRevision: 1,
          planCode: "advanced",
          status: "active",
          prepaidMonths: 3,
          orderReference: "sales-order",
          contractReference: "signed-contract",
          signedAt: Date.parse("2026-07-26T08:00:00.000Z"),
          signatoryId: "enterprise-legal-entity",
          signingEvidence: { verifiedBy: "system-admin" },
        }),
    ],
    [
      "complete a customer delivery ticket",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.deliveryTickets.update({
          userId: 7,
          ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          expectedRevision: 1,
          status: "completed",
          publicSummary: "已完成并核对交付结果。",
        }),
    ],
    [
      "permanently delete a customer demand",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.deliveryTickets.delete({
          userId: 7,
          ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          expectedRevision: 1,
          confirmation: "DELETE_TICKET",
        }),
    ],
    [
      "record a customer delivery operation",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.deliveryTickets.recordDelivery({
          userId: 7,
          ticketId: "4a67e445-37bb-45ed-9268-4ca9437e4d71",
          expectedRevision: 1,
          clientRequestId: "cc2dfdc7-50e1-4bba-a593-fc38a6254d4d",
          result: {
            platform: "FrontMind",
            targetUrl: "https://example.com/delivery-result",
            executedAt: Date.parse("2026-07-26T08:00:00.000Z"),
            resultStatus: "success",
          },
          attachments: [],
        }),
    ],
    [
      "reset any password",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.resetPassword({
          userId: 1,
          newPassword: "replacement-password-2026",
        }),
    ],
    [
      "change any account status",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.setActive({ userId: 1, isActive: false }),
    ],
    [
      "change an administrator access level",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.setAdminAccessLevel({
          userId: 1,
          adminAccessLevel: "system_admin",
        }),
    ],
    [
      "delete any account",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.users.delete({ userId: 1 }),
    ],
    [
      "read the global presales key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.status(),
    ],
    [
      "replace the global presales key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.replace({ apiKey: "presales-secret-key" }),
    ],
    [
      "test a global presales key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.test({ apiKey: "presales-secret-key" }),
    ],
    [
      "delete the global presales key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.delete(),
    ],
    [
      "read global presales usage",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.usage(),
    ],
    [
      "read the system-wide 21st key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.twentyFirst.status(),
    ],
    [
      "test the system-wide 21st key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.twentyFirst.test({ apiKey: "21st_sk_boundary_test" }),
    ],
    [
      "replace the system-wide 21st key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.twentyFirst.replace({
          apiKey: "21st_sk_boundary_test",
        }),
    ],
    [
      "delete the system-wide 21st key",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.twentyFirst.delete(),
    ],
    [
      "read the system-wide Aliyun publishing credentials",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.aliyun.status(),
    ],
    [
      "test the system-wide Aliyun publishing credentials",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.aliyun.test(),
    ],
    [
      "replace the system-wide Aliyun OAuth credential",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.aliyun.replaceOAuth({
          clientId: "4724570903440410001",
          clientSecret: "aliyun-boundary-client-secret",
          callbackUrl:
            "https://dashboard.frontmind.net/api/site-ops/aliyun/oauth/callback",
        }),
    ],
    [
      "delete the system-wide Aliyun publishing credentials",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.presales.aliyun.delete(),
    ],
    [
      "replace a managed API Key from unified management",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.apiKeyUsageAlerts.replaceTargetCredential({
          kind: "customer",
          userId: 7,
          apiKey: "managed-api-secret-key",
          expectedVersion: 3,
          reason: "boundary test",
          confirmation: "REPLACE_API_KEY",
        }),
    ],
    [
      "bulk replace managed API Keys from unified management",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.apiKeyUsageAlerts.bulkReplaceTargetCredentials({
          scope: { kind: "engineers", engineerIds: [8] },
          targets: [{ userId: 8, expectedVersion: 2 }],
          applyMode: "unconfigured_only",
          apiKey: "managed-api-secret-key",
          reason: "boundary test",
          confirmation: "BULK_REPLACE_API_KEYS",
        }),
    ],
    [
      "revoke a managed API Key from unified management",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.apiKeyUsageAlerts.revokeTargetCredential({
          kind: "engineer",
          userId: 8,
          expectedVersion: 2,
          reason: "boundary test",
          confirmation: "REVOKE_API_KEY",
        }),
    ],
    [
      "list signing-first manual orders",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.manualOrders.list(),
    ],
    [
      "prepare a manual order for signing",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.manualOrders.prepare({
          reference: "manual-order-reference-001",
          contractId: "esign-contract-manual-001",
          signingUrl: "https://sign.example.com/flows/manual-001",
        }),
    ],
    [
      "confirm manual signing evidence",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.manualOrders.confirmSigned({
          reference: "manual-order-reference-001",
          signedPdf: {
            fileId: "signed-pdf-file-001",
            filename: "signed-contract.pdf",
            sha256: "a".repeat(64),
          },
          signedAt: Date.parse("2026-07-26T10:05:00.000Z"),
          signatoryId: "enterprise-signatory-001",
          note: "已核对电子签平台签署原件与签署报告",
        }),
    ],
    [
      "activate a manual service order",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.manualOrders.activate({
          reference: "manual-order-reference-001",
        }),
    ],
    [
      "reject a manual service order",
      (caller: ReturnType<typeof adminRouter.createCaller>) =>
        caller.manualOrders.reject({
          reference: "manual-order-reference-001",
          note: "签约主体资料无法通过人工复核",
        }),
    ],
  ])(
    "forbids an ordinary assigned administrator from %s",
    async (_label, invoke) => {
      const caller = adminRouter.createCaller(ordinaryAdminContext());
      await expect(invoke(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
});
