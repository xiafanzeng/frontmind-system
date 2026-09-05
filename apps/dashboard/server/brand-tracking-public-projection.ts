import {
  containsPrivateProviderBrand,
  sanitizeFrontMindPublicText,
} from "../shared/frontmind-public-brand";

const PRIVATE_PROVIDER_CODE_PREFIXES = [
  ["ma", "nus"].join(""),
  ["jeno", "va"].join(""),
] as const;

function isProviderUrlKey(key: string) {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return normalized === "url" || normalized.endsWith("url");
}

function isPrivateProviderCode(value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!/^[a-z0-9_-]+$/iu.test(normalized)) return false;
  return PRIVATE_PROVIDER_CODE_PREFIXES.some((prefix) =>
    new RegExp(prefix, "iu").test(normalized),
  );
}

export function toBrandTrackingPublicText(value: unknown) {
  return sanitizeFrontMindPublicText(value);
}

export function toBrandTrackingPublicCode(
  value: unknown,
  fallback: string | null,
) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  if (isPrivateProviderCode(value)) return fallback;
  return sanitizeFrontMindPublicText(value.trim());
}

/**
 * Customer-safe projection for upstream-derived brand-tracking state. URL
 * capabilities and provider-specific codes are discarded; textual status is
 * rebranded before it can be stored in customer-facing turn state or emitted.
 */
export function toBrandTrackingPublicValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 16) return null;
  if (typeof value === "string") return toBrandTrackingPublicText(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isPrivateProviderCode(item))
      .map((item) => toBrandTrackingPublicValue(item, depth + 1));
  }
  if (typeof value !== "object") return null;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      containsPrivateProviderBrand(key) ||
      isProviderUrlKey(key) ||
      isPrivateProviderCode(item)
    ) {
      continue;
    }
    result[key] = toBrandTrackingPublicValue(item, depth + 1);
  }
  return result;
}

export function toBrandTrackingPublicRecord(value: unknown) {
  const projected = toBrandTrackingPublicValue(value);
  return projected && typeof projected === "object" && !Array.isArray(projected)
    ? (projected as Record<string, unknown>)
    : {};
}

type BrandTrackingEventLike = {
  event: string;
  data: object;
};

export function toBrandTrackingPublicEvent<T extends BrandTrackingEventLike>(
  event: T,
): T {
  const source = event.data as Record<string, unknown>;
  const data = toBrandTrackingPublicRecord(source);
  if (event.event === "warning") {
    data.code = toBrandTrackingPublicCode(source.code, null);
  } else if (event.event === "error") {
    data.code = toBrandTrackingPublicCode(source.code, "UPSTREAM_UNAVAILABLE");
  }
  return { ...event, data } as T;
}
