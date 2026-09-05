import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { hasExplicitAdminRole } from "../../shared/admin-access";
import type { TrpcContext } from "./context";

const validationFieldLabels: Record<string, string> = {
  question: "目标问题",
  username: "用户名",
  password: "密码",
  apiKey: "API Key",
  userId: "用户",
  category: "类型",
  topic: "话题",
};

export function localizedUserFacingError(
  message: string,
  code: string = "INTERNAL_SERVER_ERROR",
) {
  const normalized = message.trim();
  if (/[\u3400-\u9fff]/u.test(normalized)) return normalized;

  if (/invalid (?:username|user name) or password/i.test(normalized)) {
    return "用户名或密码不正确";
  }
  if (/account is disabled/i.test(normalized)) return "账号已停用";
  if (/username already exists/i.test(normalized)) return "用户名已存在";
  if (/password.*(?:at least|too short)/i.test(normalized)) {
    return "密码长度不足，请按页面要求重新输入";
  }
  if (/password.*too long/i.test(normalized)) return "密码长度超过限制";
  if (/api credential.*not found/i.test(normalized)) {
    return "API 凭据不存在或已失效";
  }
  if (/conversation.*not found/i.test(normalized)) return "对话记录不存在";
  if (/workspace.*not found/i.test(normalized)) return "工作区不存在";
  if (/user.*not found/i.test(normalized)) return "用户不存在";
  if (/not found/i.test(normalized)) return "请求的内容不存在";
  if (
    /unauthorized|invalid session|please log(?:in| in)|authentication/i.test(
      normalized,
    )
  ) {
    return "登录状态无效，请重新登录";
  }
  if (/forbidden|permission|access denied/i.test(normalized)) {
    return "当前账号无权执行此操作";
  }
  if (/rate limit|too many requests/i.test(normalized)) {
    return "操作过于频繁，请稍后重试";
  }
  if (/timeout|timed out/i.test(normalized)) return "请求超时，请稍后重试";
  if (/network|failed to fetch/i.test(normalized)) {
    return "网络连接异常，请检查网络后重试";
  }

  switch (code) {
    case "BAD_REQUEST":
    case "PARSE_ERROR":
    case "UNPROCESSABLE_CONTENT":
      return "提交内容有误，请检查后重试";
    case "UNAUTHORIZED":
      return "请先登录后再操作";
    case "FORBIDDEN":
      return "当前账号无权执行此操作";
    case "NOT_FOUND":
      return "请求的内容不存在";
    case "CONFLICT":
    case "PRECONDITION_FAILED":
      return "当前数据已变化，请刷新后重试";
    case "PAYLOAD_TOO_LARGE":
      return "提交内容过大，请缩减后重试";
    case "UNSUPPORTED_MEDIA_TYPE":
      return "文件格式不受支持";
    case "TOO_MANY_REQUESTS":
      return "操作过于频繁，请稍后重试";
    case "TIMEOUT":
    case "GATEWAY_TIMEOUT":
      return "请求超时，请稍后重试";
    case "BAD_GATEWAY":
    case "SERVICE_UNAVAILABLE":
      return "服务暂时不可用，请稍后重试";
    default:
      return "请求暂时无法完成，请稍后重试";
  }
}

function localizedZodIssue(issue: ZodError["issues"][number]) {
  if (/[\u3400-\u9fff]/u.test(issue.message)) return issue.message;
  const rawField = String(issue.path.at(-1) ?? "输入内容");
  const field = validationFieldLabels[rawField] ?? rawField;
  const detail = issue as unknown as {
    code: string;
    minimum?: number;
    maximum?: number;
    format?: string;
  };
  if (detail.code === "too_small" && detail.minimum !== undefined) {
    return `${field}至少需要 ${detail.minimum} 个字符`;
  }
  if (detail.code === "too_big" && detail.maximum !== undefined) {
    return `${field}不能超过 ${detail.maximum} 个字符`;
  }
  if (detail.code === "invalid_type") return `${field}格式不正确`;
  if (detail.code === "invalid_format") return `${field}格式不正确`;
  return `${field}校验失败，请检查后重试`;
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (!(error.cause instanceof ZodError)) {
      return {
        ...shape,
        message: localizedUserFacingError(shape.message, error.code),
      };
    }
    const issue = error.cause.issues[0];
    return {
      ...shape,
      message: issue ? localizedZodIssue(issue) : "提交内容校验失败",
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!hasExplicitAdminRole(ctx.user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "需要明确的管理员权限",
    });
  }
  return next({ ctx });
});
