const HAS_CHINESE = /[\u3400-\u9fff]/;

function errorStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return undefined;
  }
  const status = Number((value as { status?: unknown }).status);
  return Number.isInteger(status) ? status : undefined;
}

export function userFacingErrorMessage(
  value: unknown,
  fallback = "操作失败，请稍后重试",
): string {
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  const message = raw.replace(/\s+/g, " ").trim();
  if (!message) return fallback;
  if (HAS_CHINESE.test(message)) return message;

  if (/invalid (?:username|user name) or password/i.test(message)) {
    return "用户名或密码不正确";
  }
  if (/account is disabled/i.test(message)) return "账号已停用";
  if (/username already exists/i.test(message)) return "用户名已存在";
  if (/password.*(?:at least|too short)/i.test(message)) {
    return "密码长度不足，请按页面要求重新输入";
  }
  if (/password.*too long/i.test(message)) return "密码长度超过限制";
  if (
    /unauthorized|invalid session|authentication|please log(?:in| in)/i.test(
      message,
    )
  ) {
    return "登录状态无效，请重新登录";
  }
  if (/forbidden|permission|access denied/i.test(message)) {
    return "当前账号无权执行此操作";
  }
  if (/not found/i.test(message)) return "请求的内容不存在";
  if (/rate limit|too many requests/i.test(message)) {
    return "操作过于频繁，请稍后重试";
  }
  if (/timeout|timed out/i.test(message)) return "请求超时，请稍后重试";
  if (/network|failed to fetch|load failed/i.test(message)) {
    return "网络连接异常，请检查网络后重试";
  }

  const status = errorStatus(value);
  if (status === 400 || status === 422) return "提交内容有误，请检查后重试";
  if (status === 401) return "登录状态无效，请重新登录";
  if (status === 403) return "当前账号无权执行此操作";
  if (status === 404) return "请求的内容不存在";
  if (status === 409) return "当前数据已变化，请刷新后重试";
  if (status === 413) return "提交内容过大，请缩减后重试";
  if (status === 429) return "操作过于频繁，请稍后重试";
  if (status === 408 || status === 504) return "请求超时，请稍后重试";
  if (status !== undefined && status >= 500) {
    return "服务暂时不可用，请稍后重试";
  }
  return fallback;
}
