import { createHash, createHmac, randomBytes } from "node:crypto";

export const SESSION_TOKEN_BYTES = 32;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashNetworkIdentifier(
  value: string | undefined,
  secret: string,
): string | null {
  return value
    ? createHmac("sha256", secret).update(value).digest("hex")
    : null;
}

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  if (!header) return {};
  const output: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      output[key] = decodeURIComponent(raw);
    } catch {
      /* ignore malformed cookies */
    }
  }
  return output;
}

export function sessionCookie(
  name: string,
  token: string,
  expires: Date,
  secure: boolean,
): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
