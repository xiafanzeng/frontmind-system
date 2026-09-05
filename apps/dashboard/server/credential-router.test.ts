import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "./auth-service";
import type { TrpcContext } from "./_core/context";

const authMocks = vi.hoisted(() => ({
  deleteActiveApiCredential: vi.fn(),
  getApiCredentialStatus: vi.fn(),
  getDecryptedCredentialForUser: vi.fn(),
  replaceApiCredential: vi.fn(),
  validateUpstreamApiKey: vi.fn(),
}));

vi.mock("./auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-service")>()),
  ...authMocks,
}));

import { credentialRouter } from "./credential-router";

function user(
  role: "user" | "admin",
  adminAccessLevel: "system_admin" | "delivery_admin" | null = null,
): AuthenticatedUser {
  const now = new Date();
  const deliveryAdmin =
    role === "admin" && adminAccessLevel === "delivery_admin";
  return {
    id: role === "admin" ? (deliveryAdmin ? 3 : 1) : 7,
    openId: null,
    username:
      role === "admin"
        ? deliveryAdmin
          ? "operations-admin"
          : "admin"
        : "customer",
    displayName:
      role === "admin"
        ? deliveryAdmin
          ? "Operations Admin"
          : "Admin"
        : "Customer",
    name:
      role === "admin"
        ? deliveryAdmin
          ? "Operations Admin"
          : "Admin"
        : "Customer",
    email: null,
    loginMethod: "password",
    role,
    adminAccessLevel: role === "admin" ? adminAccessLevel : null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

function context(
  role: "user" | "admin",
  adminAccessLevel: "system_admin" | "delivery_admin" | null = null,
): TrpcContext {
  return {
    user: user(role, adminAccessLevel),
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("credential ownership policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getApiCredentialStatus.mockResolvedValue({
      configured: true,
      fingerprint: "fp_test",
      status: "active",
      verifiedAt: Date.now(),
    });
    authMocks.getDecryptedCredentialForUser.mockResolvedValue({
      id: "credential-1",
      userId: 7,
      version: 1,
      apiKey: "sk-saved-user-key",
      fingerprint: "fp_test",
      status: "active",
      verifiedAt: new Date(),
    });
    authMocks.replaceApiCredential.mockResolvedValue({
      configured: true,
      fingerprint: "fp_new",
      status: "active",
      verifiedAt: Date.now(),
    });
    authMocks.deleteActiveApiCredential.mockResolvedValue(undefined);
    authMocks.validateUpstreamApiKey.mockResolvedValue(undefined);
  });

  it.each(["set", "replace", "delete"] as const)(
    "rejects ordinary-user %s mutations before credential storage is touched",
    async (procedure) => {
      const caller = credentialRouter.createCaller(context("user"));
      const invocation =
        procedure === "delete"
          ? caller.delete()
          : caller[procedure]({ apiKey: "sk-user-cannot-save" });

      await expect(invocation).rejects.toMatchObject<Partial<TRPCError>>({
        code: "FORBIDDEN",
      });
      expect(authMocks.replaceApiCredential).not.toHaveBeenCalled();
      expect(authMocks.deleteActiveApiCredential).not.toHaveBeenCalled();
    },
  );

  it("keeps API Key status and validation invisible to ordinary users", async () => {
    const caller = credentialRouter.createCaller(context("user"));

    await expect(caller.status()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
    await expect(caller.test({})).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
    expect(authMocks.getApiCredentialStatus).not.toHaveBeenCalled();
    expect(authMocks.validateUpstreamApiKey).not.toHaveBeenCalled();
  });

  it("routes system-administrator writes to the unified API and people console", async () => {
    const caller = credentialRouter.createCaller(
      context("admin", "system_admin"),
    );

    await expect(
      caller.set({ apiKey: "sk-admin-agent-key" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    await expect(
      caller.replace({ apiKey: "sk-admin-agent-key-2" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    await expect(caller.delete()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
    expect(authMocks.replaceApiCredential).not.toHaveBeenCalled();
    expect(authMocks.deleteActiveApiCredential).not.toHaveBeenCalled();
  });

  it("keeps delivery administrator Agent Keys under system-admin control", async () => {
    const caller = credentialRouter.createCaller(
      context("admin", "delivery_admin"),
    );

    await expect(
      caller.set({ apiKey: "sk-delivery-admin-key" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    await expect(
      caller.replace({ apiKey: "sk-delivery-admin-key-2" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    await expect(caller.delete()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
    await expect(caller.status()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
    expect(authMocks.replaceApiCredential).not.toHaveBeenCalled();
    expect(authMocks.deleteActiveApiCredential).not.toHaveBeenCalled();
  });

  it("does not grant credential controls to the admin username without an access level", async () => {
    const caller = credentialRouter.createCaller(context("admin", null));

    await expect(
      caller.replace({ apiKey: "sk-legacy-admin-key" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
    expect(authMocks.replaceApiCredential).not.toHaveBeenCalled();
  });
});
