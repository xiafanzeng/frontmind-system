import type {
  MediaFilters,
  MediaSort,
  PublicationBatchStatus,
  PublisherMediaKind,
} from "./types";

export const DEFAULT_MEDIA_FILTERS: MediaFilters = {
  kind: "news",
  query: "",
  batchQuery: "",
  platform: "",
  taxonomy: "",
  mediaType: "",
  area: "",
  recommended: "",
  priceMin: "",
  priceMax: "",
  includeType: "",
  publishSpeed: "",
  entryType: "",
  linkType: "",
  pcWeight: "",
  includeRate: "",
  successRate: "",
  authenticated: "",
  festival: "",
  sort: "recommended",
  channel: "",
  region: "",
  price: "",
  capability: "",
  page: 1,
  pageSize: 50,
};

const mediaSorts = new Set<MediaSort>([
  "recommended",
  "price_asc",
  "price_desc",
  "success_desc",
  "include_desc",
  "weight_desc",
  "updated_desc",
]);

const publicationStatuses = new Set<PublicationBatchStatus>([
  "queued",
  "processing",
  "success",
  "failed",
  "partial_success",
  "action_required",
]);

function one(params: URLSearchParams, key: string) {
  return (params.get(key) ?? "").trim();
}

function positiveInteger(value: string, fallback: number, allowed?: number[]) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return allowed && !allowed.includes(parsed) ? fallback : parsed;
}

function decimalInput(value: string) {
  if (!/^\d+(?:\.\d{1,4})?$/u.test(value)) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000_000
    ? value
    : "";
}

function listedValue(value: string, allowed: readonly string[]) {
  return allowed.includes(value) ? value : "";
}

function isoDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : "";
}

export function readMediaRouteState(search: string): {
  filters: MediaFilters;
  articleVersionId?: string;
} {
  const params = new URLSearchParams(search.replace(/^\?/u, ""));
  const kind: PublisherMediaKind =
    one(params, "kind") === "self_media" ? "self_media" : "news";
  const sortValue = one(params, "sort") as MediaSort;
  const filters: MediaFilters = {
    ...DEFAULT_MEDIA_FILTERS,
    kind,
    query: one(params, "query"),
    batchQuery: one(params, "batchQuery"),
    platform: one(params, "platform"),
    taxonomy: one(params, "taxonomy"),
    mediaType: one(params, "mediaType"),
    area: one(params, "area"),
    recommended: one(params, "recommended") === "true" ? "true" : "",
    priceMin: decimalInput(one(params, "priceMin")),
    priceMax: decimalInput(one(params, "priceMax")),
    includeType: one(params, "includeType"),
    publishSpeed: one(params, "publishSpeed"),
    entryType: one(params, "entryType"),
    linkType: one(params, "linkType"),
    pcWeight: listedValue(one(params, "pcWeight"), ["1", "2", "3", "4", "5"]),
    includeRate: listedValue(one(params, "includeRate"), [
      "60",
      "70",
      "80",
      "90",
    ]),
    successRate: listedValue(one(params, "successRate"), [
      "80",
      "85",
      "90",
      "95",
    ]),
    authenticated: one(params, "authenticated") === "true" ? "true" : "",
    festival: one(params, "festival") === "true" ? "true" : "",
    capability: (["text", "image", "image_pending"] as string[]).includes(
      one(params, "capability"),
    )
      ? (one(params, "capability") as MediaFilters["capability"])
      : "",
    sort: mediaSorts.has(sortValue) ? sortValue : "recommended",
    page: positiveInteger(one(params, "page"), 1),
    pageSize: positiveInteger(one(params, "pageSize"), 50, [10, 20, 50, 100]),
  };
  const articleVersionId = one(params, "articleVersion");
  return { filters, ...(articleVersionId ? { articleVersionId } : {}) };
}

export function writeMediaRouteState(
  pathname: string,
  filters: MediaFilters,
  articleVersionId?: string,
) {
  const params = new URLSearchParams();
  const defaults = DEFAULT_MEDIA_FILTERS as Record<string, unknown>;
  for (const [key, raw] of Object.entries(filters)) {
    if (raw === undefined || raw === "" || raw === defaults[key]) continue;
    params.set(key, String(raw));
  }
  if (articleVersionId) params.set("articleVersion", articleVersionId);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export type PublicationListFilters = {
  query: string;
  kind: "" | PublisherMediaKind;
  status: "" | PublicationBatchStatus;
  from: string;
  to: string;
  page: number;
  pageSize: number;
};

export const DEFAULT_PUBLICATION_FILTERS: PublicationListFilters = {
  query: "",
  kind: "",
  status: "",
  from: "",
  to: "",
  page: 1,
  pageSize: 20,
};

export function readPublicationRouteState(
  search: string,
): PublicationListFilters {
  const params = new URLSearchParams(search.replace(/^\?/u, ""));
  const kind = one(params, "kind");
  const status = one(params, "status") as PublicationBatchStatus;
  return {
    query: one(params, "query"),
    kind: kind === "news" || kind === "self_media" ? kind : "",
    status: publicationStatuses.has(status) ? status : "",
    from: isoDateInput(one(params, "from")),
    to: isoDateInput(one(params, "to")),
    page: positiveInteger(one(params, "page"), 1),
    pageSize: positiveInteger(one(params, "pageSize"), 20, [10, 20, 50]),
  };
}

export function writePublicationRouteState(
  pathname: string,
  filters: PublicationListFilters,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (
      value === "" ||
      value === DEFAULT_PUBLICATION_FILTERS[key as keyof PublicationListFilters]
    )
      continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function unicodeLength(value: string) {
  return Array.from(value).length;
}

export function parseBatchQuery(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
}

export function publisherSubmitIdempotencyKey(
  draftId: string,
  quoteFingerprint: string,
) {
  return `publisher-submit:${draftId}:${quoteFingerprint}`;
}
