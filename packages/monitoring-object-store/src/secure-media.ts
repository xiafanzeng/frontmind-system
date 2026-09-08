import { createHash } from "node:crypto";
import { lookup as defaultLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { RemoteMediaFetchError, RemoteMediaRejectedError } from "./errors.js";
import type { FetchedMedia, SecureMediaFetchOptions } from "./types.js";

const DEFAULT_ALLOWED_TYPES = new Set([
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/vnd.microsoft.icon",
  "image/x-icon",
]);
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REDIRECTS = 3;

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return undefined;
  }
  return (
    (((parts[0]! << 24) >>> 0) +
      (parts[1]! << 16) +
      (parts[2]! << 8) +
      parts[3]!) >>>
    0
  );
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPublicIpv4Number(value: number): boolean {
  return !BLOCKED_IPV4_RANGES.some(([base, prefix]) =>
    inV4Range(value, ipv4Number(base)!, prefix),
  );
}

/**
 * Parses an already validated IPv6 literal into network-order bytes.  Using
 * bytes instead of textual prefix matching is important here: URL parsing and
 * DNS can return the same address in compressed, expanded or IPv4-suffixed
 * forms.
 */
function ipv6Bytes(input: string): Uint8Array | undefined {
  let address = input.replace(/^\[|\]$/g, "").toLowerCase();
  // A scoped address is meaningful only on the local host.  Even a syntactically
  // global address must not be accepted with a caller-controlled interface id.
  if (address.includes("%") || isIP(address) !== 6) return undefined;

  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const embedded = ipv4Number(address.slice(separator + 1));
    if (separator < 0 || embedded === undefined) return undefined;
    address = `${address.slice(0, separator)}:${(
      (embedded >>> 16) &
      0xffff
    ).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  const compressedAt = address.indexOf("::");
  const left = (compressedAt < 0 ? address : address.slice(0, compressedAt))
    .split(":")
    .filter(Boolean);
  const right = (compressedAt < 0 ? "" : address.slice(compressedAt + 2))
    .split(":")
    .filter(Boolean);
  const zeroCount = compressedAt < 0 ? 0 : 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array.from({ length: zeroCount }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff)
      return undefined;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function matchesIpv6Cidr(
  address: Uint8Array,
  baseLiteral: string,
  prefix: number,
): boolean {
  const base = ipv6Bytes(baseLiteral)!;
  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== base[index]) return false;
  }
  const remaining = prefix % 8;
  if (!remaining) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (address[fullBytes]! & mask) === (base[fullBytes]! & mask);
}

function embeddedIpv4IsPublic(
  address: Uint8Array,
  offset: number,
  invert = false,
): boolean {
  let value = 0;
  for (let index = offset; index < offset + 4; index += 1) {
    value = ((value << 8) | (address[index]! ^ (invert ? 0xff : 0))) >>> 0;
  }
  return isPublicIpv4Number(value);
}

const BLOCKED_IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible space
  ["64:ff9b:1::", 48], // local-use IPv4/IPv6 translation prefix
  ["100::", 64], // discard-only prefix
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // deprecated ORCHID
  ["2001:20::", 28], // ORCHIDv2 (not globally routable)
  ["2001:db8::", 32], // documentation
  ["3ffe::", 16], // returned 6bone space
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment-routing SIDs, not globally routable
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

function isPublicIpv6Address(address: Uint8Array): boolean {
  // IPv4-mapped IPv6.  Public embedded IPv4 remains usable, but mapping a
  // loopback, private, metadata or documentation address cannot bypass policy.
  if (matchesIpv6Cidr(address, "::ffff:0:0", 96))
    return embeddedIpv4IsPublic(address, 12);

  // RFC 6052 well-known NAT64 prefix.  The local-use NAT64 prefix is denied by
  // the table below because its variable embedding layout cannot be validated.
  if (matchesIpv6Cidr(address, "64:ff9b::", 96))
    return embeddedIpv4IsPublic(address, 12);

  // 6to4 encodes the destination IPv4 address immediately after 2002::/16.
  if (matchesIpv6Cidr(address, "2002::", 16))
    return embeddedIpv4IsPublic(address, 2);

  // Teredo encodes both a server IPv4 address and an obfuscated client IPv4
  // address.  Checking both prevents a tunnel from smuggling a private target.
  if (matchesIpv6Cidr(address, "2001::", 32)) {
    return (
      embeddedIpv4IsPublic(address, 4) &&
      embeddedIpv4IsPublic(address, 12, true)
    );
  }

  // ISATAP interface identifiers can appear below an otherwise global IPv6
  // prefix and carry an IPv4 destination in their final 32 bits.
  const isIsatap =
    (address[8] === 0x00 || address[8] === 0x02) &&
    address[9] === 0x00 &&
    address[10] === 0x5e &&
    address[11] === 0xfe;
  if (isIsatap && !embeddedIpv4IsPublic(address, 12)) return false;

  if (
    BLOCKED_IPV6_RANGES.some(([base, prefix]) =>
      matchesIpv6Cidr(address, base, prefix),
    )
  ) {
    return false;
  }

  // Currently allocated native global-unicast space.  Rejecting every other
  // unrecognised range avoids treating future/reserved scopes as Internet
  // destinations while retaining ordinary public IPv6 connectivity.
  return matchesIpv6Cidr(address, "2000::", 3);
}

/** Rejects private, scoped, transition-smuggled and other non-public addresses. */
export function isPublicIpAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "");
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return value !== undefined && isPublicIpv4Number(value);
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes !== undefined && isPublicIpv6Address(bytes);
  }
  return false;
}

export function validateRemoteMediaUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch (cause) {
    throw new RemoteMediaRejectedError("Media URL is invalid", {}, { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RemoteMediaRejectedError("Only HTTP(S) media URLs are allowed", {
      protocol: url.protocol,
    });
  }
  if (url.username || url.password)
    throw new RemoteMediaRejectedError("Media URL credentials are forbidden");
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new RemoteMediaRejectedError("Local hostnames are forbidden", {
      hostname,
    });
  }
  if (
    url.port &&
    !(
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
  ) {
    throw new RemoteMediaRejectedError(
      "Non-standard media URL ports are forbidden",
      { port: url.port },
    );
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new RemoteMediaRejectedError(
      "Private or reserved media IP is forbidden",
      { hostname },
    );
  }
  return url;
}

export function sniffMediaContentType(body: Uint8Array): string | undefined {
  // Detection alone does not allow SVG. Callers must explicitly opt in and
  // sanitize/rasterize it; the default remote-media allowlist remains raster.
  const xmlHead = Buffer.from(body.subarray(0, 4096)).toString("utf8").replace(/^\uFEFF/u, "");
  if (/^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(xmlHead)) return "image/svg+xml";
  if (
    body.length >= 8 &&
    Buffer.from(body.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  ) {
    return "image/png";
  }
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return "image/jpeg";
  const head = Buffer.from(body.subarray(0, 16)).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a"))
    return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")
    return "image/webp";
  if (head.slice(4, 12) === "ftypavif" || head.slice(4, 12) === "ftypavis")
    return "image/avif";
  if (
    body.length >= 6 &&
    body[0] === 0x00 &&
    body[1] === 0x00 &&
    body[2] === 0x01 &&
    body[3] === 0x00 &&
    body[4]! + (body[5]! << 8) > 0
  ) {
    return "image/x-icon";
  }
  return undefined;
}

function compatibleMediaContentTypes(
  declared: string,
  detected: string,
): boolean {
  if (declared === detected) return true;
  if (declared === "application/octet-stream") return true;
  if (
    (declared === "image/jpeg" || declared === "image/jpg") &&
    detected === "image/jpeg"
  ) {
    return true;
  }
  return (
    (declared === "image/x-icon" || declared === "image/vnd.microsoft.icon") &&
    detected === "image/x-icon"
  );
}

async function resolvePublicAddress(
  hostname: string,
  lookup: NonNullable<SecureMediaFetchOptions["lookup"]>,
): Promise<{ address: string; family: 4 | 6 }> {
  hostname = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(hostname)) {
      throw new RemoteMediaRejectedError(
        "Private or reserved media IP is forbidden",
        { hostname },
      );
    }
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = (await lookup(hostname, {
      all: true,
      verbatim: true,
    })) as Array<{
      address: string;
      family: number;
    }>;
  } catch (cause) {
    throw new RemoteMediaFetchError(
      "Media hostname could not be resolved",
      { hostname },
      { cause },
    );
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new RemoteMediaFetchError("Media hostname has no addresses", {
      hostname,
    });
  }
  const normalized = addresses.map((entry) => {
    const family = isIP(entry.address);
    if (
      (family !== 4 && family !== 6) ||
      entry.family !== family ||
      !isPublicIpAddress(entry.address)
    ) {
      throw new RemoteMediaRejectedError(
        "Media hostname resolves to an invalid, private or reserved address",
        { hostname },
      );
    }
    return { address: entry.address, family: family as 4 | 6 };
  });
  if (!normalized.length) {
    throw new RemoteMediaRejectedError(
      "Media hostname resolves to a private or reserved address",
      { hostname },
    );
  }
  // Pin this exact validated address into the socket options.  Neither the HTTP
  // client nor TLS performs another hostname lookup, closing the DNS rebinding
  // window between validation and connection establishment.
  return normalized[0]!;
}

function requestPinned(
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  signal: AbortSignal,
  userAgent: string,
): Promise<IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  const tlsHostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: resolved.address,
        family: resolved.family,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: isIP(tlsHostname) ? undefined : tlsHostname,
        headers: {
          host: url.host,
          accept:
            "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9,*/*;q=0.1",
          "user-agent": userAgent,
        },
        signal,
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

async function readLimited(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const advertised = Number(response.headers["content-length"]);
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    response.destroy();
    throw new RemoteMediaRejectedError("Remote media exceeds maximum size", {
      advertised,
      maxBytes,
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      response.destroy();
      throw new RemoteMediaRejectedError("Remote media exceeds maximum size", {
        size,
        maxBytes,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export async function fetchRemoteMedia(
  input: string | URL,
  options: SecureMediaFetchOptions = {},
): Promise<FetchedMedia> {
  const sourceUrl = validateRemoteMediaUrl(input).toString();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_REDIRECTS;
  const allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_TYPES;
  const lookup = options.lookup ?? defaultLookup;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("remote media fetch timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    let current = new URL(sourceUrl);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      current = validateRemoteMediaUrl(current);
      const resolved = await resolvePublicAddress(current.hostname, lookup);
      let response: IncomingMessage;
      try {
        response = await requestPinned(
          current,
          resolved,
          signal,
          options.userAgent ?? "frontmind-monitoring-worker/0.1",
        );
      } catch (cause) {
        throw new RemoteMediaFetchError(
          "Remote media request failed",
          { hostname: current.hostname },
          { cause },
        );
      }

      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location)
          throw new RemoteMediaFetchError(
            "Remote media redirect is missing Location",
            { status },
          );
        if (redirect === maxRedirects) {
          throw new RemoteMediaRejectedError(
            "Remote media exceeded redirect limit",
            { maxRedirects },
          );
        }
        current = new URL(location, current);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new RemoteMediaFetchError(
          "Remote media returned an unsuccessful response",
          { status },
        );
      }

      const declared = String(response.headers["content-type"] ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (!allowed.has(declared)) {
        response.destroy();
        throw new RemoteMediaRejectedError(
          "Remote media content type is not allowed",
          { contentType: declared },
        );
      }
      const body = await readLimited(response, maxBytes);
      const detected = sniffMediaContentType(body);
      if (
        !detected ||
        !allowed.has(detected) ||
        !compatibleMediaContentTypes(declared, detected)
      ) {
        throw new RemoteMediaRejectedError(
          "Remote media bytes do not match the declared content type",
          {
            declared,
            detected,
          },
        );
      }
      return {
        sourceUrl,
        finalUrl: current.toString(),
        contentType: detected,
        body,
        size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    }
    throw new RemoteMediaRejectedError("Remote media exceeded redirect limit");
  } finally {
    clearTimeout(timeout);
  }
}
