export class UpstreamTaskContractError extends Error {
  constructor(
    public readonly code:
      | "IDENTITY_MISSING"
      | "IDENTITY_CONFLICT"
      | "IDENTITY_TOO_LONG"
      | "IDENTITY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamTaskContractError";
  }
}

export function upstreamTaskRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Providers have returned both a task directly and a `{ task: ... }` wrapper.
 * Once a real nested task exists it is the one canonical identity boundary;
 * wrapper metadata must not be mixed with the nested task's fields.
 */
export function canonicalUpstreamTask(value: unknown) {
  const direct = upstreamTaskRecord(value) || {};
  return upstreamTaskRecord(direct.task) || direct;
}

export function upstreamAliasedIdentity(input: {
  record: Record<string, unknown>;
  aliases: readonly string[];
  label: string;
  maxLength?: number;
  required?: boolean;
}) {
  const maxLength = input.maxLength ?? 255;
  const claims = input.aliases.flatMap((alias) => {
    if (!Object.prototype.hasOwnProperty.call(input.record, alias)) return [];
    const raw = input.record[alias];
    if (raw === undefined || raw === null || raw === "") return [];
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new UpstreamTaskContractError(
        "IDENTITY_INVALID",
        `${input.label} 格式无效`,
      );
    }
    if (
      typeof raw === "number" &&
      (!Number.isFinite(raw) || !Number.isSafeInteger(raw))
    ) {
      throw new UpstreamTaskContractError(
        "IDENTITY_INVALID",
        `${input.label} 数字格式无法无损表示`,
      );
    }
    const serialized = String(raw);
    const value = serialized.trim();
    if (serialized !== value) {
      throw new UpstreamTaskContractError(
        "IDENTITY_INVALID",
        `${input.label} 含首尾空白，拒绝改写后继续绑定`,
      );
    }
    if (!value) return [];
    if (value.length > maxLength) {
      throw new UpstreamTaskContractError(
        "IDENTITY_TOO_LONG",
        `${input.label} 超过 ${maxLength} 个字符`,
      );
    }
    return [{ alias, value }];
  });
  const values = [...new Set(claims.map((claim) => claim.value))];
  if (values.length > 1) {
    throw new UpstreamTaskContractError(
      "IDENTITY_CONFLICT",
      `${input.label} 的别名字段相互冲突`,
    );
  }
  if (values.length === 0 && input.required) {
    throw new UpstreamTaskContractError(
      "IDENTITY_MISSING",
      `${input.label} 缺失`,
    );
  }
  return values[0];
}

export function upstreamTaskId(value: unknown, required = true) {
  return upstreamAliasedIdentity({
    record: canonicalUpstreamTask(value),
    aliases: ["id", "task_id"],
    label: "上游任务标识",
    maxLength: 255,
    required,
  });
}

export function assertExpectedUpstreamTaskId(
  value: unknown,
  expectedTaskId: string,
) {
  const actualTaskId = upstreamTaskId(value, true)!;
  if (actualTaskId !== expectedTaskId) {
    throw new UpstreamTaskContractError(
      "IDENTITY_CONFLICT",
      "读取到的上游任务标识与请求不一致",
    );
  }
  return canonicalUpstreamTask(value);
}
