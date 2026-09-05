import { describe, expect, it, vi } from "vitest";

import {
  createDeliveryProjectContextMiddleware,
  createFrontMindProxyAccessMiddleware,
  enforceFrontMindProxyAccess,
  ordinaryUserMayUseFrontMindProxy,
  ordinaryUserProxyWriteRequiresActiveService,
  rejectDeliveryMemberKnowledgeBaseProjectScope,
} from "./_core/frontmind-proxy-policy";
import type { FrontMindRequest } from "./_core/express-auth";
import type { AuthenticatedUser } from "./auth-service";
import { ServiceEntitlementError } from "./service-entitlement";

function actor(
  role: "user" | "admin" | "delivery_member",
  adminAccessLevel: "system_admin" | "delivery_admin" | null = role === "admin"
    ? "delivery_admin"
    : null,
): AuthenticatedUser {
  const now = new Date();
  return {
    id: role === "admin" ? 1 : 8,
    openId: null,
    username: role === "admin" ? "admin" : "customer",
    displayName: null,
    name: null,
    email: null,
    loginMethod: "password",
    role,
    adminAccessLevel,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

function response() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json };
}

describe("ordinary-user FrontMind proxy policy", () => {
  it("allows a delivery member to use the assigned-key general agent", async () => {
    const assertProjectContext = vi.fn(async () => ({
      projectAssignmentId: "assignment-1",
      customerUserId: 42,
      roleType: "ai_operations_engineer" as const,
      customerName: "示例客户",
    }));
    const middleware = createFrontMindProxyAccessMiddleware({
      assertWriteAccess: vi.fn(),
      assertProjectContext,
    });
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/tasks",
      frontmindUser: actor("delivery_member"),
      headers: { "x-delivery-project-assignment-id": "assignment-1" },
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(assertProjectContext).toHaveBeenCalledWith({
      actor: expect.objectContaining({ role: "delivery_member" }),
      projectAssignmentId: "assignment-1",
    });
    expect(req.frontmindDeliveryProjectContext).toMatchObject({
      projectAssignmentId: "assignment-1",
      customerUserId: 42,
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/frontmind/v1/tasks/task-1"],
    ["HEAD", "/api/frontmind/v1/files/file-1"],
    ["POST", "/api/frontmind/v2/assets"],
    ["POST", "/api/frontmind/v1/files"],
    ["PUT", "/api/frontmind/proxy-upload?target=https%3A%2F%2Fexample.com"],
    ["POST", "/api/frontmind/download-token"],
    ["DELETE", "/api/frontmind/v1/files/file-1/discard"],
    ["POST", "/api/frontmind/v1/files/file-1/upload-recovery"],
    ["POST", "/api/frontmind/v1/managed-uploads"],
    ["POST", "/api/frontmind/v1/managed-uploads/recovery"],
    ["DELETE", "/api/frontmind/v1/managed-uploads"],
  ])("allows support transport %s %s", (method, originalUrl) => {
    expect(ordinaryUserMayUseFrontMindProxy({ method, originalUrl })).toBe(
      true,
    );
  });

  it.each([
    ["POST", "/api/frontmind/v2/assets"],
    ["POST", "/api/frontmind/v1/files"],
    ["PUT", "/api/frontmind/proxy-upload?target=https%3A%2F%2Fexample.com"],
    ["POST", "/api/frontmind/v1/files/file-1/upload-recovery"],
    ["POST", "/api/frontmind/v1/managed-uploads"],
    ["POST", "/api/frontmind/v1/managed-uploads/recovery"],
  ])(
    "marks upload transport %s %s as requiring an active service",
    (method, originalUrl) => {
      expect(
        ordinaryUserProxyWriteRequiresActiveService({ method, originalUrl }),
      ).toBe(true);
    },
  );

  it("rejects file creation for an expired customer before reaching upstream", async () => {
    const middleware = createFrontMindProxyAccessMiddleware({
      assertWriteAccess: vi.fn(async () => {
        throw new ServiceEntitlementError(
          "SERVICE_PLAN_EXPIRED",
          "当前服务已到期或取消，请续费后继续使用。",
          403,
        );
      }),
    });
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v2/assets",
      frontmindUser: actor("user"),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: "SERVICE_PLAN_EXPIRED" }),
    });
  });

  it("keeps historical file downloads available after expiry", async () => {
    const assertWriteAccess = vi.fn();
    const middleware = createFrontMindProxyAccessMiddleware({
      assertWriteAccess,
    });
    const req = {
      method: "GET",
      originalUrl: "/api/frontmind/v1/files/file-1/content",
      frontmindUser: actor("user"),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(assertWriteAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows an expired customer to discard an owned unbound upload", async () => {
    const assertWriteAccess = vi.fn();
    const middleware = createFrontMindProxyAccessMiddleware({
      assertWriteAccess,
    });
    const req = {
      method: "DELETE",
      originalUrl: "/api/frontmind/v1/files/file-1/discard",
      frontmindUser: actor("user"),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(assertWriteAccess).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/frontmind/v2/tasks"],
    ["POST", "/api/frontmind/v2/tasks/task-1/messages"],
    ["POST", "/api/frontmind/v2/tasks/task-1/actions/message-1/confirm"],
    ["POST", "/api/frontmind/v2/tasks/task-1/stop"],
    ["POST", "/api/frontmind/v1/tasks"],
    ["POST", "/api/frontmind/v1/responses"],
    ["POST", "/api/frontmind/v1/tasks/task-1"],
    ["PATCH", "/api/frontmind/v1/tasks/task-1"],
    ["DELETE", "/api/frontmind/v1/tasks/task-1"],
    ["POST", "/api/frontmind/v1/managed-uploads/secret-intent/recovery"],
    ["DELETE", "/api/frontmind/v1/managed-uploads/secret-intent"],
  ])("blocks model or resource mutation %s %s", (method, originalUrl) => {
    expect(ordinaryUserMayUseFrontMindProxy({ method, originalUrl })).toBe(
      false,
    );
  });

  it("returns a stable 403 code before a customer task mutation reaches upstream", () => {
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/tasks",
      frontmindUser: actor("user"),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    enforceFrontMindProxyAccess(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: "GENERAL_AGENT_MUTATION_FORBIDDEN",
      }),
    });
  });

  it("keeps all generic Agent operations available to administrators", () => {
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/tasks",
      frontmindUser: actor("admin"),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    enforceFrontMindProxyAccess(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects a legacy admin username when its access level is missing", () => {
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/tasks",
      frontmindUser: actor("admin", null),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    enforceFrontMindProxyAccess(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: "ADMIN_ACCESS_LEVEL_REQUIRED",
      }),
    });
  });
});

describe("knowledge-base delivery project boundary", () => {
  it.each([
    ["/api/knowledge-base/start/reserve"],
    ["/api/knowledge-base/artifacts/build-1/package"],
  ])(
    "validates %s project context before returning the stable unsupported code",
    async (originalUrl) => {
      const assertProjectContext = vi.fn(async () => ({
        projectAssignmentId: "assignment-1",
        customerUserId: 42,
        roleType: "ai_operations_engineer" as const,
        customerName: "示例客户",
      }));
      const projectMiddleware = createDeliveryProjectContextMiddleware({
        assertProjectContext,
      });
      const req = {
        method: "POST",
        originalUrl,
        frontmindUser: actor("delivery_member"),
        headers: { "x-delivery-project-assignment-id": "assignment-1" },
      } as FrontMindRequest;
      const res = response();
      const downstream = vi.fn();

      await projectMiddleware(req, res as never, () =>
        rejectDeliveryMemberKnowledgeBaseProjectScope(
          req,
          res as never,
          downstream,
        ),
      );

      expect(assertProjectContext).toHaveBeenCalledOnce();
      expect(downstream).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({
          code: "KNOWLEDGE_BASE_PROJECT_SCOPE_UNSUPPORTED",
        }),
      });
    },
  );

  it("rejects a missing delivery project before the unsupported-scope fence", async () => {
    const assertProjectContext = vi.fn();
    const middleware = createDeliveryProjectContextMiddleware({
      assertProjectContext,
    });
    const req = {
      method: "POST",
      originalUrl: "/api/knowledge-base/start/reserve",
      frontmindUser: actor("delivery_member"),
      headers: {},
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(assertProjectContext).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: "DELIVERY_PROJECT_CONTEXT_REQUIRED",
      }),
    });
  });

  it("rejects a forged delivery project before the unsupported-scope fence", async () => {
    const middleware = createDeliveryProjectContextMiddleware({
      assertProjectContext: vi.fn(async () => {
        throw new Error("not assigned");
      }),
    });
    const req = {
      method: "GET",
      originalUrl: "/api/knowledge-base/artifacts/build-1/package",
      frontmindUser: actor("delivery_member"),
      headers: { "x-delivery-project-assignment-id": "assignment-forged" },
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await middleware(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: "DELIVERY_PROJECT_CONTEXT_FORBIDDEN",
      }),
    });
  });

  it.each(["user", "admin"] as const)(
    "keeps the %s knowledge-base route unchanged",
    (role) => {
      const req = {
        frontmindUser: actor(role),
      } as FrontMindRequest;
      const res = response();
      const next = vi.fn();

      rejectDeliveryMemberKnowledgeBaseProjectScope(req, res as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    },
  );
});
