import { createHash } from "node:crypto";

import type {
  PublisherLogoSearchCandidate,
  PublisherLogoSearchPort,
  PublisherLogoSearchVerification,
} from "./ports.js";

const MAX_SEARCH_RESPONSE_BYTES = 256 * 1_024;
const MAX_SEARCH_CANDIDATES = 10;

/**
 * Adapter for an explicitly configured, licensed logo-search service. It does
 * not scrape a public search-engine HTML page and never runs in the browser.
 * Returned image bytes are still fetched later through the common SSRF-safe
 * media pipeline.
 */
export class HttpPublisherLogoSearchAdapter
  implements PublisherLogoSearchPort
{
  readonly providerName: string;
  readonly trustedEvidenceDomains: readonly string[];

  constructor(
    private readonly options: {
      endpoint: string;
      apiKey?: string;
      timeoutMs: number;
      evidenceDomains?: readonly string[];
      fetch?: typeof fetch;
    },
  ) {
    const endpoint = new URL(options.endpoint);
    this.providerName = `configured:${endpoint.hostname.toLowerCase()}`;
    this.trustedEvidenceDomains = (options.evidenceDomains ?? []).flatMap(
      (value) => {
        const normalized = domain(value);
        return normalized ? [normalized] : [];
      },
    );
  }

  async search(input: {
    name: string;
    externalResourceId: string;
    queryHash: string;
    platform: string | null;
    area: string | null;
    trustedDomains: readonly string[];
    signal?: AbortSignal;
  }): Promise<readonly PublisherLogoSearchCandidate[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const forwardAbort = () => controller.abort();
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.options.endpoint,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(this.options.apiKey
              ? { authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            query: {
              name: input.name,
              externalResourceId: input.externalResourceId,
              queryHash: input.queryHash,
              platform: input.platform,
              area: input.area,
              caseDomains: input.trustedDomains,
            },
            limit: MAX_SEARCH_CANDIDATES,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Configured logo search failed with HTTP ${response.status}`);
      }
      const bytes = await readBoundedResponse(response);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("Configured logo search returned invalid JSON");
      }
      if (
        !isRecord(payload) ||
        payload.queryHash !== input.queryHash ||
        payload.externalResourceId !== input.externalResourceId
      ) {
        throw new Error("Configured logo search response identity mismatch");
      }
      return parseSearchCandidates(payload);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

export function publisherLogoSearchQueryHash(input: {
  name: string;
  externalResourceId: string;
  platform: string | null;
  area: string | null;
  trustedDomains: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: input.name.trim(),
        externalResourceId: input.externalResourceId,
        platform: input.platform?.trim() || null,
        area: input.area?.trim() || null,
        trustedDomains: [...input.trustedDomains].sort(),
      }),
    )
    .digest("hex");
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SEARCH_RESPONSE_BYTES) {
    throw new Error("Configured logo search response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_SEARCH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Configured logo search response is too large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseSearchCandidates(
  payload: unknown,
): PublisherLogoSearchCandidate[] {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Configured logo search response has no candidates array");
  }
  return payload.candidates
    .slice(0, MAX_SEARCH_CANDIDATES)
    .flatMap((value) => {
      if (!isRecord(value)) return [];
      const imageUrl = httpUrl(value.imageUrl);
      const pageUrl = httpUrl(value.pageUrl);
      const matchedName = text(value.matchedName, 255);
      const evidenceUrl = httpUrl(value.evidenceUrl);
      const officialDomain = domain(value.officialDomain);
      const verification = verificationValue(value.verification);
      if (!imageUrl || !pageUrl || !matchedName || !verification) return [];
      if (
        verification === "official_registry" &&
        (!officialDomain || !evidenceUrl)
      ) {
        return [];
      }
      return [
        {
          matchedName,
          imageUrl,
          pageUrl,
          evidenceUrl,
          officialDomain,
          verification,
        },
      ];
    });
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function verificationValue(
  value: unknown,
): PublisherLogoSearchVerification | null {
  return value === "unverified" ||
    value === "case_domain" ||
    value === "official_registry"
    ? value
    : null;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function domain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
    normalized,
  )
    ? normalized
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
