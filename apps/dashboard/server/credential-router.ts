import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./_core/trpc";
import {
  AuthServiceError,
  getDecryptedCredentialForUser,
  getApiCredentialStatus,
  validateUpstreamApiKey,
} from "./auth-service";
import { toTrpcError } from "./auth-router";
import { hasSystemAdminAccess } from "./admin-control-plane-service";

const apiKeyInput = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, "API Key 至少需要 8 个字符")
    .max(4096, "API Key 不能超过 4096 个字符"),
});

const testApiKeyInput = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, "API Key 至少需要 8 个字符")
    .max(4096, "API Key 不能超过 4096 个字符")
    .optional(),
});

function requireSystemAdminCredentialAccess(
  user: Parameters<typeof hasSystemAdminAccess>[0],
) {
  if (!hasSystemAdminAccess(user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "所有账号 API Key 仅由系统管理员统一维护",
    });
  }
}

export const credentialRouter = router({
  status: adminProcedure.query(async ({ ctx }) => {
    requireSystemAdminCredentialAccess(ctx.user);
    try {
      return await getApiCredentialStatus(ctx.user.id);
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  set: adminProcedure.input(apiKeyInput).mutation(({ ctx }) => {
    requireSystemAdminCredentialAccess(ctx.user);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "请在“API 与人员管理”统一入口配置账号 API Key",
    });
  }),

  replace: adminProcedure.input(apiKeyInput).mutation(({ ctx }) => {
    requireSystemAdminCredentialAccess(ctx.user);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "请在“API 与人员管理”统一入口替换账号 API Key",
    });
  }),

  test: adminProcedure
    .input(testApiKeyInput)
    .mutation(async ({ ctx, input }) => {
      requireSystemAdminCredentialAccess(ctx.user);
      try {
        const savedCredential = input.apiKey
          ? null
          : await getDecryptedCredentialForUser(ctx.user.id);
        const apiKey = input.apiKey ?? savedCredential?.apiKey;
        if (!apiKey) {
          throw new AuthServiceError("NOT_FOUND", "请先填写或保存 API Key");
        }
        await validateUpstreamApiKey(apiKey);
        return { ok: true } as const;
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  delete: adminProcedure.mutation(({ ctx }) => {
    requireSystemAdminCredentialAccess(ctx.user);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "请在“API 与人员管理”统一入口撤销账号 API Key",
    });
  }),
});
