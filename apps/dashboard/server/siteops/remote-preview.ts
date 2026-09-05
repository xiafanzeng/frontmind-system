import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import sharp from "sharp";

// Provider previews can be large, minimally-compressed source PNGs. Keep the
// network boundary bounded independently from the immutable normalized asset:
// accept enough source bytes to decode real 21st catalog previews, then require
// the metadata-free PNG that we persist to remain within the tighter limit.
const MAX_PREVIEW_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_PREVIEW_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 20_000_000;
const MAX_NORMALIZED_PREVIEW_WIDTH = 2400;
const MAX_NORMALIZED_PREVIEW_HEIGHT = 1800;
const MAX_REDIRECTS = 3;
const MAX_PINNED_ADDRESSES = 3;
const ALLOWED_MIME_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// Keep the address families in separate lists. Node intentionally maps IPv4
// through IPv4-mapped IPv6 entries when both families share one BlockList;
// that would make an IPv6 `::/96` deny rule reject every public IPv4 address.
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
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
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function expandedIpv6Words(address: string) {
  let value = address;
  const dotted = value.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (dotted) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    value = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word || "0", 16));
  if (
    words.length !== 8 ||
    words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
  ) {
    return null;
  }
  return words;
}

export function normalizePreviewAddress(address: string) {
  const normalized = address
    .trim()
    .replace(/^\[|\]$/gu, "")
    .toLowerCase()
    .split("%", 1)[0]!;
  const family = isIP(normalized);
  if (family === 4) return { address: normalized, family: 4 as const };
  if (family !== 6) return null;
  const words = expandedIpv6Words(normalized);
  if (
    words &&
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff
  ) {
    const ipv4 = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
    return { address: ipv4, family: 4 as const };
  }
  return { address: normalized, family: 6 as const };
}

export function isPublicPreviewAddress(address: string) {
  const normalized = normalizePreviewAddress(address);
  if (!normalized) return false;
  if (normalized.family === 4) {
    return !blockedIpv4Addresses.check(normalized.address, "ipv4");
  }
  if (normalized.family === 6) {
    return !blockedIpv6Addresses.check(normalized.address, "ipv6");
  }
  return false;
}

export type ResolvedPublicHttpsAddress = { address: string; family: 4 | 6 };
export type PinnedPublicHttpsTransport = (input: {
  url: URL;
  addresses: ResolvedPublicHttpsAddress[];
  signal: AbortSignal;
  headers: Record<string, string>;
}) => Promise<Response>;

async function assertSafeUrl(raw: string, resolveImpl: typeof lookup = lookup) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PREVIEW_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("PREVIEW_URL_UNSAFE");
  }
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const lookupHostname = hostname.replace(/^\[|\]$/gu, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("PREVIEW_URL_UNSAFE");
  }
  const rawAddresses = isIP(lookupHostname)
    ? [
        {
          address: lookupHostname,
          family: isIP(lookupHostname) as 4 | 6,
        },
      ]
    : await resolveImpl(lookupHostname, {
        all: true,
        verbatim: true,
      });
  if (
    !Array.isArray(rawAddresses) ||
    rawAddresses.length === 0 ||
    rawAddresses.some(
      ({ address }) =>
        !normalizePreviewAddress(address) || !isPublicPreviewAddress(address),
    )
  ) {
    throw new Error("PREVIEW_URL_PRIVATE_ADDRESS");
  }
  const seen = new Set<string>();
  const addresses = rawAddresses
    .map(({ address }) => normalizePreviewAddress(address)!)
    .sort((left, right) => left.family - right.family)
    .filter((candidate) => {
      const key = `${candidate.family}:${candidate.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PINNED_ADDRESSES);
  return { url, addresses };
}

function safeUrlCoordinate(url: URL) {
  const safe = new URL(url.toString());
  safe.search = "";
  safe.hash = "";
  return safe;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}

export function samePreviewAddress(expected: string, actual: string) {
  const left = normalizePreviewAddress(expected);
  const right = normalizePreviewAddress(actual);
  if (!left || !right || left.family !== right.family) return false;
  if (left.family === 4) return left.address === right.address;
  const exact = new BlockList();
  exact.addAddress(left.address, "ipv6");
  return exact.check(right.address, "ipv6");
}

export function pinnedPreviewRequestOptions(input: {
  url: URL;
  selected: ResolvedPublicHttpsAddress;
  signal: AbortSignal;
  headers: Record<string, string>;
}) {
  const hostname = input.url.hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[|\]$/gu, "");
  return {
    method: "GET",
    headers: input.headers,
    signal: input.signal,
    // A request-specific socket is required so a pooled connection can never
    // bypass this hop's DNS validation and pinned lookup.
    agent: false as const,
    family: input.selected.family,
    autoSelectFamily: false as const,
    servername: isIP(hostname) ? undefined : hostname,
    lookup: lookupForPinnedPreviewAddress(input.selected),
  } as Parameters<typeof https.request>[1] & {
    autoSelectFamily: false;
  };
}

export function lookupForPinnedPreviewAddress(
  selected: ResolvedPublicHttpsAddress,
): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all === true) {
      callback(null, [selected]);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

export function responseFromPinnedPreviewIncoming(incoming: IncomingMessage) {
  const status = incoming.statusCode ?? 500;
  if (status < 200 || status > 599) {
    throw new Error("PREVIEW_RESPONSE_INVALID");
  }
  const bodyForbidden = status === 204 || status === 205 || status === 304;
  try {
    const response = new Response(
      bodyForbidden ? null : (Readable.toWeb(incoming) as ReadableStream),
      {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders(incoming.headers),
      },
    );
    if (bodyForbidden) incoming.resume();
    return response;
  } catch {
    throw new Error("PREVIEW_RESPONSE_INVALID");
  }
}

function requestPinnedHttpsAddress(input: {
  url: URL;
  selected: ResolvedPublicHttpsAddress;
  signal: AbortSignal;
  headers: Record<string, string>;
}) {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const requestOptions = pinnedPreviewRequestOptions(input);
    const request = https.request(input.url, requestOptions, (incoming) => {
      const peer = incoming.socket.remoteAddress;
      if (
        !peer ||
        !isPublicPreviewAddress(peer) ||
        !samePreviewAddress(input.selected.address, peer)
      ) {
        const error = new Error("PREVIEW_CONNECTED_ADDRESS_UNSAFE");
        rejectOnce(error);
        // The promise already carries the stable failure. Destroying these
        // streams with an Error could emit an otherwise unhandled `error` on
        // IncomingMessage and terminate the worker.
        incoming.destroy();
        request.destroy();
        return;
      }
      let response: Response;
      try {
        response = responseFromPinnedPreviewIncoming(incoming);
      } catch {
        const error = new Error("PREVIEW_RESPONSE_INVALID");
        rejectOnce(error);
        incoming.destroy();
        request.destroy();
        return;
      }
      settled = true;
      resolve(response);
    });
    request.once("error", rejectOnce);
    request.end();
  });
}

function retryablePinnedConnectionFailure(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (message === "PREVIEW_CONNECTED_ADDRESS_UNSAFE") return false;
  return (
    /^(?:ECONN|ENET|EHOST|ETIMEDOUT|EPIPE)/u.test(code) ||
    /^(?:ERR_TLS|ERR_SSL)/u.test(code) ||
    /(?:TLS|socket hang up|handshake)/iu.test(message)
  );
}

export async function pinnedHttpsFetch(
  input: {
    url: URL;
    addresses: ResolvedPublicHttpsAddress[];
    signal: AbortSignal;
    headers: Record<string, string>;
  },
  requestImpl = requestPinnedHttpsAddress,
) {
  let lastError: unknown;
  for (const selected of input.addresses.slice(0, MAX_PINNED_ADDRESSES)) {
    try {
      return await requestImpl({ ...input, selected });
    } catch (error) {
      lastError = error;
      if (input.signal.aborted || !retryablePinnedConnectionFailure(error)) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("PREVIEW_CONNECTION_FAILED");
}

/**
 * Resolves and pins every HTTPS hop, then verifies the socket's actual peer
 * before exposing a response. `transport` exists only for deterministic
 * tests; production callers use the pinned Node HTTPS implementation.
 */
export async function fetchPinnedPublicHttps(input: {
  url: string | URL;
  signal: AbortSignal;
  headers?: Record<string, string>;
  maxRedirects?: number;
  allowedOrigin?: string;
  resolveImpl?: typeof lookup;
  transport?: PinnedPublicHttpsTransport;
}) {
  const maxRedirects = Math.max(
    0,
    Math.min(input.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS),
  );
  const initialUrl =
    typeof input.url === "string" ? input.url : input.url.toString();
  let resolved = await assertSafeUrl(initialUrl, input.resolveImpl);
  let allowedOrigin: string | null = null;
  if (input.allowedOrigin) {
    const parsed = await assertSafeUrl(input.allowedOrigin, input.resolveImpl);
    allowedOrigin = parsed.url.origin;
    if (resolved.url.origin !== allowedOrigin) {
      throw new Error("PREVIEW_REDIRECT_ORIGIN_INVALID");
    }
  }
  const transport = input.transport ?? pinnedHttpsFetch;
  for (let redirects = 0; ; redirects += 1) {
    const response = await transport({
      url: resolved.url,
      addresses: resolved.addresses,
      signal: input.signal,
      headers: input.headers ?? {},
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: safeUrlCoordinate(resolved.url) };
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects >= maxRedirects) {
      throw new Error("PREVIEW_REDIRECT_INVALID");
    }
    const next = await assertSafeUrl(
      new URL(location, resolved.url).toString(),
      input.resolveImpl,
    );
    if (allowedOrigin && next.url.origin !== allowedOrigin) {
      throw new Error("PREVIEW_REDIRECT_ORIGIN_INVALID");
    }
    resolved = next;
  }
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) throw new Error("PREVIEW_BODY_MISSING");
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
    throw new Error("PREVIEW_SIZE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("PREVIEW_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes < 1) throw new Error("PREVIEW_BODY_MISSING");
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
}

export async function fetchSafeVisualPreview(input: {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolveImpl?: typeof lookup;
}) {
  const timeout = AbortSignal.timeout(12_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const headers = {
    Accept: "image/avif,image/webp,image/png,image/jpeg",
    "User-Agent": "FrontMind-SiteOps-Preview/1.0",
  };
  const fetched = await fetchPinnedPublicHttps({
    url: input.url,
    signal,
    headers,
    maxRedirects: MAX_REDIRECTS,
    resolveImpl: input.resolveImpl,
    transport: input.fetchImpl
      ? ({ url }) =>
          input.fetchImpl!(url, {
            method: "GET",
            redirect: "manual",
            signal,
            headers,
          })
      : undefined,
  });
  const { response } = fetched;
  if (!response.ok) throw new Error("PREVIEW_FETCH_FAILED");
  const mimeType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error("PREVIEW_MIME_INVALID");
  }
  const buffer = await readBoundedBody(response, MAX_PREVIEW_INPUT_BYTES);
  const image = sharp(buffer, {
    failOn: "error",
    limitInputPixels: MAX_PREVIEW_PIXELS,
  });
  const metadata = await image.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_PREVIEW_PIXELS ||
    !["avif", "jpeg", "png", "webp"].includes(metadata.format || "")
  ) {
    throw new Error("PREVIEW_IMAGE_INVALID");
  }
  // Re-encoding removes EXIF/text/profile metadata and makes the immutable
  // artifact hash independent from provider-side metadata changes.
  const normalizedBuffer = await image
    .clone()
    .rotate()
    .resize({
      width: MAX_NORMALIZED_PREVIEW_WIDTH,
      height: MAX_NORMALIZED_PREVIEW_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  if (normalizedBuffer.byteLength > MAX_PREVIEW_OUTPUT_BYTES) {
    throw new Error("PREVIEW_TOO_LARGE");
  }
  const normalizedImage = sharp(normalizedBuffer, {
    failOn: "error",
    limitInputPixels: MAX_PREVIEW_PIXELS,
  });
  const [normalizedMetadata, stats] = await Promise.all([
    normalizedImage.metadata(),
    normalizedImage.stats(),
  ]);
  if (!normalizedMetadata.width || !normalizedMetadata.height) {
    throw new Error("PREVIEW_IMAGE_INVALID");
  }
  const visibleChannels = stats.channels.slice(0, 3);
  const brightness =
    visibleChannels.reduce((sum, channel) => sum + channel.mean, 0) /
    Math.max(1, visibleChannels.length);
  const contrast =
    visibleChannels.reduce((sum, channel) => sum + channel.stdev, 0) /
    Math.max(1, visibleChannels.length);
  const dominantHex = `#${[stats.dominant.r, stats.dominant.g, stats.dominant.b]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
  return {
    finalUrl: fetched.finalUrl.toString(),
    mimeType: "image/png" as const,
    buffer: normalizedBuffer,
    width: normalizedMetadata.width,
    height: normalizedMetadata.height,
    sha256: createHash("sha256").update(normalizedBuffer).digest("hex"),
    visualSignals: {
      dominantHex,
      brightness: Math.round(brightness * 100) / 100,
      contrast: Math.round(contrast * 100) / 100,
    },
  };
}
