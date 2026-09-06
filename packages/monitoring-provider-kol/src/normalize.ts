import type { KolRawOrder, KolRawResource } from "./schemas.js";
import type {
  KolMediaKind,
  KolOrder,
  KolPagination,
  KolResource,
} from "./types.js";

export function normalizePagination(input: {
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}): KolPagination {
  return {
    currentPage: input.current_page,
    lastPage: input.last_page,
    perPage: input.per_page,
    total: input.total,
  };
}

export function normalizeResource(
  input: KolRawResource,
  providerOrigin?: URL,
): KolResource {
  const kind = normalizeKolMediaKind(input.is_zimeiti);
  return {
    id: input.id,
    name: input.name?.trim() ?? "",
    platform: text(input.platform),
    taxonomy: text(input.taxonomy),
    mediaType: text(input.media),
    kind,
    area: text(input.area),
    caseUrl: httpUrl(input.case_url),
    titleLimit: positiveInteger(input.title_limit),
    price:
      typeof input.price === "string" || typeof input.price === "number"
        ? decimal(input.price)
        : undefined,
    pcWeight: decimal(input.pc_weight),
    mobileWeight: decimal(input.m_weight),
    successRate: percentage(input.success_radio),
    includeRate: percentage(input.include_radio),
    publishTime: text(input.publish_time),
    includeType: text(input.include_type),
    linkType: text(input.url_type ?? input.link_type),
    entryUrl: text(input.in_url),
    entryLevel: text(input.in_level ?? input.entry_type),
    logo: providerAssetUrl(input.logo, providerOrigin),
    icon: providerAssetUrl(input.icon, providerOrigin),
    remark: text(input.remark),
    description: text(input.description),
    recommended: booleanValue(input.is_recommend),
    isSelfMedia: kind === "self_media",
    authenticated: booleanValue(input.auth),
    festivalPublishable: booleanValue(input.festival),
    fanCount: bigintValue(input.fans_num),
    likeCount: bigintValue(input.like_num ?? input.likes_num),
    publishCount: bigintValue(input.publish_count),
    raw: sanitizedResourceRaw(input),
  };
}

/**
 * KOL has returned all of absolute, protocol-relative and root-relative image
 * locations over the lifetime of its catalog. Resolve only against the
 * configured provider origin and retain an HTTP(S), credential-free URL for
 * the worker. These URLs are server-only inputs to the logo archiver; they are
 * never customer API output.
 */
export function providerAssetUrl(
  value: unknown,
  providerOrigin?: URL,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = text(value);
  if (!normalized || normalized.length > 2_048) return undefined;
  try {
    const parsed = providerOrigin
      ? new URL(normalized, providerOrigin)
      : new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (parsed.username || parsed.password) return undefined;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizeKolMediaKind(value: unknown): KolMediaKind {
  if (value === 1 || value === "1") return "self_media";
  if (value === 2 || value === "2") return "news";
  throw new TypeError("KOL resource is_zimeiti must be exactly 1 or 2");
}

function sanitizedResourceRaw(
  input: KolRawResource,
): Readonly<Record<string, unknown>> {
  const result = sanitizeRawObject(input, 0);
  // FrontMind uses only `price` as the customer quote. Supplier-tier fields
  // have no product purpose and are removed before the catalog reaches a DB or
  // an API serialization boundary.
  return Object.freeze(result);
}

function sanitizeRawObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
): Record<string, unknown> {
  if (depth > 6) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 500)
      .filter(
        ([key]) =>
          !/(?:token|password|authorization|api[_-]?key)/iu.test(key) &&
          !(
            /(?:price|cost|commission|settlement)/iu.test(key) &&
            !(depth === 0 && key === "price")
          ),
      )
      .map(([key, entry]) => [key, sanitizeRawValue(entry, depth + 1)]),
  );
}

function sanitizeRawValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((entry) => sanitizeRawValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return sanitizeRawObject(value as Record<string, unknown>, depth);
  }
  return typeof value === "string" ? value.slice(0, 10_000) : value;
}

export function normalizeOrder(input: KolRawOrder): KolOrder {
  const status =
    input.status === 0
      ? "processing"
      : input.status === 1
        ? "success"
        : input.status === 2
          ? "failed"
          : "unknown";
  const responseMessage = text(input.response_message);
  return {
    id: input.id,
    resourceId: input.resource_id,
    orderId: input.order_id,
    title: input.title,
    status,
    providerStatus: input.status,
    responseMessage,
    reportedPrice: decimal(input.price),
    resourceName: text(input.resource_name),
    manuscriptId: text(input.manuscript_id),
    createdAt: integer(input.created_at),
    updatedAt: integer(input.updated_at),
    publishedUrl: status === "success" ? httpUrl(responseMessage) : undefined,
    failureReason: status === "failed" ? responseMessage : undefined,
    raw: Object.freeze({ ...input }),
  };
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 10_000) : undefined;
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function bigintValue(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  try {
    const parsed = BigInt(String(value));
    return parsed >= 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decimal(value: unknown): string | undefined {
  const normalized = text(value)?.replaceAll(",", "");
  const match = /^(?:\+?)(\d+)(?:\.(\d+))?$/u.exec(normalized ?? "");
  if (!match) return undefined;
  const integer = (match[1] ?? "0").replace(/^0+(?=\d)/u, "");
  const fraction = (match[2] ?? "").replace(/0+$/u, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function percentage(value: unknown): string | undefined {
  const normalized = text(value)?.replace(/%$/u, "");
  return decimal(normalized);
}

function booleanValue(value: unknown): boolean | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value === true || value === 1 || value === "1" || value === "true")
    return true;
  if (value === false || value === 0 || value === "0" || value === "false")
    return false;
  return undefined;
}

function httpUrl(value: unknown): string | undefined {
  const normalized = text(value);
  if (!normalized || normalized.length > 2_048) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}
