import { sha256Hex, stableJson } from "./hash.js";
import { sumMinor } from "./money.js";
import type { ContentIssue, PublicationMode } from "./types.js";

export interface PublisherQuoteItem {
  resourceId: number;
  title: string;
  priceMinor: bigint;
  catalogRevision: string;
  active: boolean;
  titleLimit?: number;
  supportsImages: boolean;
}

export interface PublisherPreflightInput {
  ownerId: string;
  articleVersionId: string;
  articleContentHash: string;
  containsImages: boolean;
  mode: PublicationMode;
  availableMinor: bigint;
  items: readonly PublisherQuoteItem[];
}

export interface PublisherPreflightResult {
  quoteFingerprint: string;
  totalMinor: bigint;
  availableAfterReservationMinor: bigint;
  warnings: readonly ContentIssue[];
  blockers: readonly ContentIssue[];
}

export function buildPublisherPreflight(
  input: PublisherPreflightInput,
): PublisherPreflightResult {
  if (!input.ownerId.trim() || !input.articleVersionId.trim()) {
    throw new TypeError("ownerId and articleVersionId are required");
  }
  if (!/^[a-f0-9]{64}$/iu.test(input.articleContentHash)) {
    throw new TypeError("articleContentHash must be SHA-256 hex");
  }
  if (input.items.length < 1 || input.items.length > 20) {
    throw new TypeError("A publication batch must contain 1 to 20 media items");
  }
  const blockers: ContentIssue[] = [];
  const seen = new Set<number>();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.resourceId) || item.resourceId < 1) {
      throw new TypeError("resourceId must be a positive integer");
    }
    if (seen.has(item.resourceId)) {
      blockers.push({
        code: "duplicate_resource",
        message: `Resource ${item.resourceId} is selected more than once`,
        blocking: true,
      });
    }
    seen.add(item.resourceId);
    const title = item.title.trim();
    if (!title) {
      blockers.push({
        code: "empty_title",
        message: `Resource ${item.resourceId} requires a title`,
        blocking: true,
      });
    }
    if (
      item.titleLimit !== undefined &&
      Array.from(title).length > item.titleLimit
    ) {
      blockers.push({
        code: "title_too_long",
        message: `Resource ${item.resourceId} title exceeds its limit`,
        blocking: true,
      });
    }
    if (!item.active) {
      blockers.push({
        code: "inactive_resource",
        message: `Resource ${item.resourceId} is no longer active`,
        blocking: true,
      });
    }
    if (input.containsImages && !item.supportsImages) {
      blockers.push({
        code: "images_not_verified",
        message: `Resource ${item.resourceId} is not verified for image publication`,
        blocking: true,
      });
    }
  }
  const totalMinor = sumMinor(input.items.map((item) => item.priceMinor));
  if (totalMinor > input.availableMinor) {
    blockers.push({
      code: "insufficient_balance",
      message: "Media-publishing wallet balance is insufficient",
      blocking: true,
    });
  }
  const fingerprintPayload = {
    ownerId: input.ownerId,
    articleVersionId: input.articleVersionId,
    articleContentHash: input.articleContentHash.toLowerCase(),
    mode: input.mode,
    items: [...input.items]
      .sort((left, right) => left.resourceId - right.resourceId)
      .map((item) => ({
        resourceId: item.resourceId,
        title: item.title.trim(),
        priceMinor: item.priceMinor.toString(),
        catalogRevision: item.catalogRevision,
      })),
  };
  return {
    quoteFingerprint: sha256Hex(stableJson(fingerprintPayload)),
    totalMinor,
    availableAfterReservationMinor:
      input.availableMinor >= totalMinor
        ? input.availableMinor - totalMinor
        : input.availableMinor,
    warnings: [],
    blockers,
  };
}
