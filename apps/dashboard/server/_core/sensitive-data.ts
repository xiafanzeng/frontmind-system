const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";
const UNSUPPORTED = "[UNSUPPORTED]";

export type SensitiveDataOptions = {
  secrets?: Iterable<unknown>;
  maxDepth?: number;
  maxEntries?: number;
};

function normalizedSecrets(values: Iterable<unknown> | undefined) {
  return Array.from(values ?? [])
    .flatMap((value) => (typeof value === "string" ? [value.trim()] : []))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Fail closed for auth-bearing keys, including mixed case and separator
 * variants such as API_KEY, apiKey, x-api-key and Set-Cookie.
 */
export function isSensitiveDataKey(value: string) {
  const key = normalizedKey(value);
  return (
    key.includes("apikey") ||
    key.includes("authorization") ||
    key.includes("cookie") ||
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password") ||
    key.includes("passphrase") ||
    key.includes("credential")
  );
}

export function redactSensitiveText(
  value: string,
  secrets?: Iterable<unknown>,
) {
  let result = value;
  for (const secret of normalizedSecrets(secrets)) {
    result = result.split(secret).join(REDACTED);
  }

  return result
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(api[\s_-]*key|authorization|cookie|token|secret|password|passphrase|credential)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED);
}

/**
 * Recursively removes auth-bearing fields and replaces exact current
 * credentials wherever a compatible upstream may have echoed them.
 */
export function redactSensitivePayload(
  value: unknown,
  options: SensitiveDataOptions = {},
) {
  const secrets = normalizedSecrets(options.secrets);
  const maxDepth = options.maxDepth ?? 40;
  const maxEntries = options.maxEntries ?? 10_000;
  const seen = new WeakSet<object>();
  let entries = 0;

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > maxDepth || entries >= maxEntries) return TRUNCATED;
    if (
      current === null ||
      current === undefined ||
      typeof current === "boolean" ||
      typeof current === "number"
    ) {
      return current;
    }
    if (typeof current === "string") {
      return redactSensitiveText(current, secrets);
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object") return UNSUPPORTED;
    if (current instanceof Date) return current.toISOString();
    if (Buffer.isBuffer(current)) return "[BINARY REDACTED]";
    if (seen.has(current)) return CIRCULAR;
    seen.add(current);

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      for (const item of current) {
        entries += 1;
        result.push(visit(item, depth + 1));
        if (entries >= maxEntries) {
          result.push(TRUNCATED);
          break;
        }
      }
      return result;
    }

    const output: Record<string, unknown> = {};
    let objectEntries: Array<[string, unknown]>;
    try {
      objectEntries = Object.entries(current as Record<string, unknown>);
    } catch {
      return REDACTED;
    }
    for (const [key, child] of objectEntries) {
      entries += 1;
      if (isSensitiveDataKey(key)) continue;
      try {
        output[key] = visit(child, depth + 1);
      } catch {
        output[key] = REDACTED;
      }
      if (entries >= maxEntries) {
        output.__truncated__ = TRUNCATED;
        break;
      }
    }
    return output;
  };

  return visit(value, 0);
}

function safeProperty(value: unknown, key: string) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeLogText(
  value: unknown,
  secrets: Iterable<unknown>,
  maxLength = 1_000,
) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSensitiveText(value, secrets).slice(0, maxLength);
}

function safeStatus(error: unknown) {
  const direct = safeProperty(error, "status");
  const response = safeProperty(error, "response");
  const nested = safeProperty(response, "status");
  const candidate = typeof direct === "number" ? direct : nested;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function safeRequestId(
  error: unknown,
  secrets: Iterable<unknown>,
): string | undefined {
  const response = safeProperty(error, "response");
  const headers = safeProperty(response, "headers");
  if (!headers || typeof headers !== "object") return undefined;

  for (const key of ["x-request-id", "request-id", "trace-id"]) {
    let candidate: unknown;
    const getter = safeProperty(headers, "get");
    if (typeof getter === "function") {
      try {
        candidate = getter.call(headers, key);
      } catch {
        candidate = undefined;
      }
    }
    if (candidate === undefined) {
      const matchingKey = Object.keys(headers).find(
        (header) => header.toLowerCase() === key,
      );
      if (matchingKey) candidate = safeProperty(headers, matchingKey);
    }
    const normalized = safeLogText(candidate, secrets, 200);
    if (normalized) return normalized;
  }
  return undefined;
}

/**
 * Returns an allowlisted log DTO. Raw Axios config/request/response objects are
 * never retained, so headers and bodies cannot be serialized by console.
 */
export function safeErrorForLog(
  error: unknown,
  options: Pick<SensitiveDataOptions, "secrets"> = {},
) {
  const secrets = normalizedSecrets(options.secrets);
  const result: {
    name: string;
    message: string;
    code?: string;
    status?: number;
    requestId?: string;
  } = {
    name: safeLogText(safeProperty(error, "name"), secrets, 120) ?? "Error",
    message:
      safeLogText(
        typeof error === "string" ? error : safeProperty(error, "message"),
        secrets,
      ) ?? "Request failed",
  };
  const code = safeLogText(safeProperty(error, "code"), secrets, 120);
  const status = safeStatus(error);
  const requestId = safeRequestId(error, secrets);
  if (code) result.code = code;
  if (status !== undefined) result.status = status;
  if (requestId) result.requestId = requestId;
  return result;
}
