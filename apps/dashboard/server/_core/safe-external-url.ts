import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class ExternalUrlRejectedError extends Error {}

function isBlockedIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  const [a, b, c] = parts;
  return (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isBlockedNetworkAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;

  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe") ||
    normalized.startsWith("ff")
  );
}

function assertSafeHostname(hostname: string) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "host.docker.internal" ||
    host === "metadata.google.internal" ||
    (net.isIP(host) > 0 && isBlockedNetworkAddress(host))
  ) {
    throw new ExternalUrlRejectedError("Blocked external URL host");
  }
}

export function assertSafeExternalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ExternalUrlRejectedError("Invalid external URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ExternalUrlRejectedError("Unsupported external URL protocol");
  }
  if (parsed.username || parsed.password) {
    throw new ExternalUrlRejectedError(
      "Credentials are not allowed in external URLs",
    );
  }
  assertSafeHostname(parsed.hostname);
  return parsed.toString();
}

const safeLookup = ((
  hostname: string,
  options: { family?: number; all?: boolean } | number,
  callback: (...args: any[]) => void,
) => {
  const requestedFamily =
    typeof options === "number" ? options : (options?.family ?? 0);
  const returnAll = typeof options === "object" && Boolean(options?.all);
  try {
    assertSafeHostname(hostname);
  } catch (error) {
    callback(error);
    return;
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (
      addresses.length === 0 ||
      addresses.some((result) => isBlockedNetworkAddress(result.address))
    ) {
      callback(
        new ExternalUrlRejectedError(
          "External hostname resolved to a blocked address",
        ),
      );
      return;
    }
    const matching = requestedFamily
      ? addresses.filter((result) => result.family === requestedFamily)
      : addresses;
    if (matching.length === 0) {
      callback(
        new ExternalUrlRejectedError("External hostname has no usable address"),
      );
      return;
    }
    if (returnAll) callback(null, matching);
    else callback(null, matching[0].address, matching[0].family);
  });
}) as NonNullable<http.AgentOptions["lookup"]>;

const httpAgent = new http.Agent({ keepAlive: true, lookup: safeLookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup: safeLookup });

/** Selects the same DNS-revalidating agent for native ClientRequest callers. */
export function safeExternalAgentForUrl(value: string) {
  const parsed = new URL(assertSafeExternalUrl(value));
  return parsed.protocol === "https:" ? httpsAgent : httpAgent;
}

function beforeRedirect(options: Record<string, unknown>) {
  const protocol = String(options.protocol ?? "");
  const hostname = String(options.hostname ?? "");
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ExternalUrlRejectedError("Blocked redirect protocol");
  }
  if (options.auth) {
    throw new ExternalUrlRejectedError("Blocked redirect credentials");
  }
  assertSafeHostname(hostname);
}

/** Axios options that re-check DNS and every redirect before connecting. */
export const safeExternalRequestOptions = {
  httpAgent,
  httpsAgent,
  // Axios otherwise honors HTTP(S)_PROXY. That would move DNS resolution to
  // the proxy and bypass the private-address checks in safeLookup.
  proxy: false,
  maxRedirects: 3,
  beforeRedirect,
} as const;
