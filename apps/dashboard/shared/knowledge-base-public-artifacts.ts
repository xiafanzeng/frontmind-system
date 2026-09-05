import {
  containsPrivateProviderBrand,
  sanitizeFrontMindPublicText,
} from "./frontmind-public-brand";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/giu;
const IMAGE_FILENAME_EXTENSION_PATTERN =
  "(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)";
const IMAGE_FILENAME_TOKEN_PATTERN = new RegExp(
  String.raw`(?:[a-z]:[\\/])?(?:[^\\/\s（）()【】\[\]，,。；;：:'"]+[\\/])*[^\\/\s（）()【】\[\]，,。；;：:'"]+\.${IMAGE_FILENAME_EXTENSION_PATTERN}(?:[?#][^\s（）()【】\[\]]*)?`,
  "giu",
);
const IMAGE_FILENAME_WHOLE_PATTERN = new RegExp(
  String.raw`^(?:[a-z]:[\\/])?(?:.*[\\/])?[^\\/]+\.${IMAGE_FILENAME_EXTENSION_PATTERN}(?:[?#].*)?$`,
  "iu",
);

/**
 * Produce customer-owned text without changing the immutable source record.
 * Provider-owned URLs are removed instead of being rewritten into a URL that
 * FrontMind does not own; all remaining historical brand text is normalized.
 */
export function customerSafeKnowledgeText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return sanitizeFrontMindPublicText(
    text.replace(HTTP_URL_PATTERN, (url) =>
      containsPrivateProviderBrand(url) ? "" : url,
    ),
  );
}

export function customerSafeKnowledgeFilename(
  value: unknown,
  fallback = "FrontMind-knowledge-base.zip",
): string {
  const filename = customerSafeKnowledgeText(value)
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim();
  return filename || fallback;
}

/**
 * Keep only a human-authored image label. Imported archive paths and upload
 * filenames are storage metadata, not customer copy. Historical snapshots can
 * contain those values in caption/alt, so this filter is also applied while
 * projecting and rendering old records.
 */
export function customerSafeKnowledgeAssetLabel(
  value: unknown,
): string | undefined {
  const source = customerSafeKnowledgeText(value).trim();
  if (!source || IMAGE_FILENAME_WHOLE_PATTERN.test(source)) return undefined;
  const label = source
    .replace(IMAGE_FILENAME_TOKEN_PATTERN, " ")
    .replace(/(?:（\s*）|\(\s*\)|【\s*】|\[\s*\])/gu, " ")
    .replace(/\s+([，,。；;：:])/gu, "$1")
    .replace(/[\s，,。；;：:]+$/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return label || undefined;
}

export function customerSafeKnowledgeUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((candidate) => String(candidate ?? "").trim())
        .filter((candidate) => {
          if (!candidate || containsPrivateProviderBrand(candidate)) {
            return false;
          }
          try {
            const url = new URL(candidate);
            return url.protocol === "http:" || url.protocol === "https:";
          } catch {
            return false;
          }
        }),
    ),
  ].sort();
}

export function customerSafeKnowledgeReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean)
    .filter(
      (candidate) =>
        !/^https?:\/\//iu.test(candidate) ||
        !containsPrivateProviderBrand(candidate),
    )
    .map(customerSafeKnowledgeText);
}

export function customerSafeKnowledgeUrl(value: unknown): string | undefined {
  const candidate = String(value ?? "").trim();
  if (!candidate || containsPrivateProviderBrand(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function customerSafeKnowledgeValue(value: unknown): unknown {
  if (typeof value === "string") return customerSafeKnowledgeText(value);
  if (Array.isArray(value)) return value.map(customerSafeKnowledgeValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        customerSafeKnowledgeText(key),
        customerSafeKnowledgeValue(nested),
      ]),
    );
  }
  return value;
}

function customerSafeKnowledgeRecord<T extends Record<string, unknown>>(
  value: T,
): T {
  return customerSafeKnowledgeValue(value) as T;
}

export function toCustomerSafeKnowledgeDocument<
  T extends Record<string, unknown>,
>(document: T): T {
  return {
    ...customerSafeKnowledgeRecord(document),
    ...(typeof document.id === "string"
      ? { id: customerSafeKnowledgeText(document.id) }
      : {}),
    path: customerSafeKnowledgeText(document.path),
    title: customerSafeKnowledgeText(document.title),
    content: customerSafeKnowledgeText(document.content),
    ...(typeof document.branchId === "string"
      ? { branchId: customerSafeKnowledgeText(document.branchId) }
      : {}),
    ...(typeof document.branchTitle === "string"
      ? { branchTitle: customerSafeKnowledgeText(document.branchTitle) }
      : {}),
    ...(Array.isArray(document.sourceIds)
      ? { sourceIds: customerSafeKnowledgeReferenceIds(document.sourceIds) }
      : {}),
    ...(Array.isArray(document.evidenceDocumentIds)
      ? {
          evidenceDocumentIds: customerSafeKnowledgeReferenceIds(
            document.evidenceDocumentIds,
          ),
        }
      : {}),
    ...(Array.isArray(document.assetIds)
      ? { assetIds: customerSafeKnowledgeReferenceIds(document.assetIds) }
      : {}),
  } as unknown as T;
}

export function toCustomerSafeKnowledgeAsset<T extends Record<string, unknown>>(
  asset: T,
  index: number,
): T {
  const opaqueId = `public-asset-${index + 1}`;
  const caption = customerSafeKnowledgeAssetLabel(asset.caption);
  const alt = customerSafeKnowledgeAssetLabel(asset.alt);
  const sourceKind = [
    "official_web",
    "official_document",
    "official_logo_upload",
    "user_upload",
  ].includes(String(asset.sourceKind || ""))
    ? String(asset.sourceKind)
    : undefined;
  const ownership = ["first_party", "third_party", "unknown"].includes(
    String(asset.ownership || ""),
  )
    ? String(asset.ownership)
    : undefined;
  const assetType = [
    "brand_identity",
    "product_ui",
    "product_diagram",
    "case_photo",
    "team_photo",
    "environment_photo",
    "certificate_badge",
    "document_figure",
    "customer_supplied",
    "other",
  ].includes(String(asset.assetType || ""))
    ? String(asset.assetType)
    : undefined;
  const displayRole = ["hero", "inline", "badge"].includes(
    String(asset.displayRole || ""),
  )
    ? String(asset.displayRole)
    : undefined;
  const sourcePageUrl =
    sourceKind === "official_web"
      ? customerSafeKnowledgeUrl(asset.sourcePageUrl)
      : undefined;
  const authenticatedUrl = String(asset.url || "").trim();
  return {
    // This is an explicit public allowlist. Raw ids, storage keys, archive
    // paths, hashes, upload provenance and upstream asset URLs stay server-side.
    id: opaqueId,
    key: opaqueId,
    path: `assets/${opaqueId}`,
    ...(typeof asset.mimeType === "string"
      ? { mimeType: customerSafeKnowledgeText(asset.mimeType) }
      : {}),
    ...(typeof asset.size === "number" ? { size: asset.size } : {}),
    ...(typeof asset.width === "number" ? { width: asset.width } : {}),
    ...(typeof asset.height === "number" ? { height: asset.height } : {}),
    ...(caption ? { caption } : {}),
    ...(alt ? { alt } : {}),
    ...(typeof asset.branchId === "string"
      ? { branchId: customerSafeKnowledgeText(asset.branchId) }
      : {}),
    ...(Array.isArray(asset.documentIds)
      ? {
          documentIds: customerSafeKnowledgeReferenceIds(asset.documentIds),
        }
      : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(ownership ? { ownership } : {}),
    ...(assetType ? { assetType } : {}),
    ...(displayRole ? { displayRole } : {}),
    ...(sourcePageUrl ? { sourcePageUrl } : {}),
    ...(authenticatedUrl.startsWith("/api/dashboard/knowledge/assets/")
      ? { url: authenticatedUrl }
      : {}),
  } as unknown as T;
}
