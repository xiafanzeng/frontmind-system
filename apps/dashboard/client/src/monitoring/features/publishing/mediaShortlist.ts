import type { MediaFilters, MediaResource, PublisherMediaKind } from "./types";

export function mediaShortlistKey(userId: number | undefined, search: string) {
  if (!userId) return undefined;
  const params = new URLSearchParams(search);
  const owner = params.get("operatorOwnerId") || String(userId);
  const project = params.get("enterpriseProjectId") || "account";
  return `frontmind.publisher.shortlist.v1:${userId}:${owner}:${project}`;
}

/** Local prices are only an estimate. Draft creation always reloads server media. */
export function readMediaShortlist(key?: string): Map<string, MediaResource> {
  try {
    if (!key) return new Map();
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 100_000) return new Map();
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return new Map();
    const result = new Map<string, MediaResource>();
    for (const row of rows.slice(0, 20)) {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        row.name.length > 500 ||
        !["news", "self_media"].includes(row.kind) ||
        typeof row.priceTenThousandths !== "string" ||
        !/^\d{1,20}$/.test(row.priceTenThousandths)
      )
        continue;
      result.set(row.id, {
        id: row.id,
        name: row.name,
        shortName: row.name.slice(0, 3),
        kind: row.kind,
        platform: typeof row.platform === "string" ? row.platform : "—",
        priceTenThousandths: row.priceTenThousandths,
        taxonomy: "",
        mediaType: "",
        channel: "",
        region: "",
        titleLimit: 200,
        turnaround: "",
        active: true,
        capability: "image_pending",
        catalogRevision: "",
        logoSource: "generated_fallback",
        logoResolutionStatus: "pending",
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

export function saveMediaShortlist(
  key: string | undefined,
  items: Map<string, MediaResource>,
) {
  if (!key) return;
  try {
    if (!items.size) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(
      key,
      JSON.stringify(
        [...items.values()].slice(0, 20).map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          platform: item.platform,
          priceTenThousandths: item.priceTenThousandths,
        })),
      ),
    );
  } catch {
    /* Storage restrictions never prevent selecting or publishing. */
  }
}

export function mediaSelectionBlocker(
  media: MediaResource,
  articleHasImages: boolean,
) {
  if (!media.active) return "当前停止接单";
  try {
    if (BigInt(media.priceTenThousandths) <= 0n) return "暂无有效报价";
  } catch {
    return "暂无有效报价";
  }
  if (articleHasImages && media.capability !== "image")
    return "当前稿件含图片，此媒体的图文能力尚未确认";
  return "";
}

export function switchMediaKind(
  filters: MediaFilters,
  kind: PublisherMediaKind,
  defaults: MediaFilters,
): MediaFilters {
  return {
    ...defaults,
    kind,
    query: filters.query,
    batchQuery: filters.batchQuery,
    priceMin: filters.priceMin,
    priceMax: filters.priceMax,
    pageSize: filters.pageSize,
    sort: ["price_asc", "price_desc", "updated_desc"].includes(
      filters.sort ?? "",
    )
      ? filters.sort
      : "recommended",
    page: 1,
  };
}
