import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../shared/auth-constraints";
import { getSessionCookieOptions } from "./_core/cookies";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  AuthServiceError,
  SESSION_DURATION_MS,
  changeOwnPassword,
  getSessionTokenFromRequest,
  loginWithPassword,
  revokeSessionToken,
  setupManagedUserPassword,
  validateManagedAccountSetupToken,
} from "./auth-service";
import {
  PurchaseProvisioningError,
  setupWebsiteAccountPassword,
  validateWebsiteAccountSetupToken,
} from "./provisioning-v2-service";

const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`)
  .max(MAX_PASSWORD_LENGTH, `密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`);

export function toTrpcError(error: unknown): TRPCError {
  if (!(error instanceof AuthServiceError)) {
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "请求暂时无法完成，请稍后重试",
      cause: error,
    });
  }

  switch (error.code) {
    case "INVALID_PASSWORD":
      return new TRPCError({ code: "UNAUTHORIZED", message: error.message });
    case "ACCOUNT_DISABLED":
      return new TRPCError({ code: "FORBIDDEN", message: error.message });
    case "RATE_LIMITED":
      return new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: error.message,
      });
    case "CONFLICT":
    case "IDEMPOTENCY_PENDING":
    case "LAST_ADMIN":
      return new TRPCError({ code: "CONFLICT", message: error.message });
    case "NOT_FOUND":
      return new TRPCError({ code: "NOT_FOUND", message: error.message });
    case "INVALID_CREDENTIAL":
      return new TRPCError({ code: "BAD_REQUEST", message: error.message });
    case "UPSTREAM_UNAVAILABLE":
      return new TRPCError({ code: "BAD_GATEWAY", message: error.message });
    case "DATABASE_UNAVAILABLE":
    case "INVALID_MASTER_KEY":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "服务配置异常，请联系管理员",
        cause: error,
      });
  }
}

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  login: publicProcedure
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const clientAddress =
          ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown";
        const result = await loginWithPassword(
          input.username,
          input.password,
          clientAddress,
        );
        ctx.res.cookie(COOKIE_NAME, result.token, {
          ...getSessionCookieOptions(ctx.req),
          sameSite: "lax",
          maxAge: SESSION_DURATION_MS,
        });
        return {
          user: result.user,
          expiresAt: result.session.expiresAt,
        };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  setupAccount: publicProcedure
    .input(
      z.object({
        token: z.string().trim().min(16).max(4096),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return input.token.includes(".")
          ? await setupWebsiteAccountPassword({
              token: input.token,
              password: input.newPassword,
            })
          : await setupManagedUserPassword({
              token: input.token,
              password: input.newPassword,
            });
      } catch (error) {
        if (error instanceof PurchaseProvisioningError) {
          throw new TRPCError({
            code:
              error.status === 404
                ? "NOT_FOUND"
                : error.status === 503
                  ? "INTERNAL_SERVER_ERROR"
                  : "BAD_REQUEST",
            message: error.message,
            cause: error,
          });
        }
        throw toTrpcError(error);
      }
    }),

  validateSetupAccount: publicProcedure
    .input(z.object({ token: z.string().trim().min(16).max(4096) }))
    .query(async ({ input }) => {
      try {
        return input.token.includes(".")
          ? await validateWebsiteAccountSetupToken({ token: input.token })
          : await validateManagedAccountSetupToken({ token: input.token });
      } catch (error) {
        if (error instanceof PurchaseProvisioningError) {
          throw new TRPCError({
            code:
              error.status === 404
                ? "NOT_FOUND"
                : error.status === 503
                  ? "INTERNAL_SERVER_ERROR"
                  : "BAD_REQUEST",
            message: error.message,
            cause: error,
          });
        }
        throw toTrpcError(error);
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await revokeSessionToken(getSessionTokenFromRequest(ctx.req));
    ctx.res.clearCookie(COOKIE_NAME, {
      ...getSessionCookieOptions(ctx.req),
      sameSite: "lax",
      maxAge: -1,
    });
    return { success: true } as const;
  }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await changeOwnPassword(
          ctx.user.id,
          input.currentPassword,
          input.newPassword,
        );
        ctx.res.clearCookie(COOKIE_NAME, {
          ...getSessionCookieOptions(ctx.req),
          sameSite: "lax",
          maxAge: -1,
        });
        return { success: true, reauthenticationRequired: true } as const;
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
});

export { passwordSchema };
