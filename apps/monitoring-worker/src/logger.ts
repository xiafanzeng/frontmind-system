import type { LoggerPort } from "./ports.js";

const SECRET_KEY = /token|secret|password|authorization|cookie|accesskey/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 100).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry, depth + 1),
      ]),
    );
  }
  if (typeof value === "string") return value.slice(0, 2_000);
  return value;
}

function write(
  level: string,
  message: string,
  fields?: Readonly<Record<string, unknown>>,
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(fields ? { fields: redact(fields) } : {}),
  });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createJsonLogger(): LoggerPort {
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
