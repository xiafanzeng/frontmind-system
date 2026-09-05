import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "./auth-service";
import type { TrpcContext } from "./_core/context";
import {
  adminProcedure,
  localizedUserFacingError,
  protectedProcedure,
  publicProcedure,
  router,
} from "./_core/trpc";

const testRouter = router({
  public: publicProcedure.query(() => "public"),
  protected: protectedProcedure.query(({ ctx }) => ctx.user.id),
  admin: adminProcedure.query(({ ctx }) => ctx.user.id),
});

function createUser(
  role: "user" | "admin",
  adminAccessLevel: "system_admin" | "delivery_admin" | null = role === "admin"
    ? "delivery_admin"
    : null,
): AuthenticatedUser {
  const now = new Date();
  return {
    id: 7,
    openId: null,
    username: "internal.user",
    displayName: "Internal User",
    name: "Internal User",
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

function createContext(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("tRPC authorization middleware", () => {
  it("allows public calls and rejects anonymous protected calls", async () => {
    const caller = testRouter.createCaller(createContext(null));
    await expect(caller.public()).resolves.toBe("public");
    await expect(caller.protected()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "UNAUTHORIZED",
    });
  });

  it("allows an active user through protected procedures", async () => {
    const caller = testRouter.createCaller(createContext(createUser("user")));
    await expect(caller.protected()).resolves.toBe(7);
  });

  it("requires the admin role for admin procedures", async () => {
    const userCaller = testRouter.createCaller(
      createContext(createUser("user")),
    );
    await expect(userCaller.admin()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });

    const adminCaller = testRouter.createCaller(
      createContext(createUser("admin")),
    );
    await expect(adminCaller.admin()).resolves.toBe(7);
  });

  it("fails closed for an admin username without an explicit access level", async () => {
    const legacyAdmin = {
      ...createUser("admin", null),
      username: "admin",
    };
    const caller = testRouter.createCaller(createContext(legacyAdmin));

    await expect(caller.admin()).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
    });
  });
});

describe("tRPC user-facing error localization", () => {
  it("keeps Chinese errors and translates common English authentication errors", () => {
    expect(localizedUserFacingError("账号已停用", "FORBIDDEN")).toBe(
      "账号已停用",
    );
    expect(
      localizedUserFacingError("Invalid username or password", "UNAUTHORIZED"),
    ).toBe("用户名或密码不正确");
    expect(localizedUserFacingError("Network Error", "BAD_GATEWAY")).toBe(
      "网络连接异常，请检查网络后重试",
    );
  });

  it("does not expose an unknown English backend failure", () => {
    expect(
      localizedUserFacingError(
        "driver failed while reading internal table",
        "INTERNAL_SERVER_ERROR",
      ),
    ).toBe("请求暂时无法完成，请稍后重试");
  });
});
