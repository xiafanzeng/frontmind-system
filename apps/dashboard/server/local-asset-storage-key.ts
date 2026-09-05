import { createHash } from "node:crypto";

const MAX_STORAGE_KEY_CHARACTERS = 1_024;

/**
 * Derive the indexed identity for a local asset from the authoritative storage
 * key. This value is intentionally computed inside the server persistence
 * boundary; API callers never provide it.
 */
export function hashLocalAssetStorageKey(storageKey: string) {
  if (
    typeof storageKey !== "string" ||
    storageKey.length === 0 ||
    storageKey.length > MAX_STORAGE_KEY_CHARACTERS
  ) {
    throw new Error("LOCAL_ASSET_STORAGE_KEY_INVALID");
  }
  return createHash("sha256").update(storageKey, "utf8").digest("hex");
}

export function sealLocalAssetStorageIdentity<T extends { storageKey: string }>(
  values: T,
): T & { storageKeyHash: string } {
  return {
    ...values,
    // This assignment follows the spread deliberately so even an untyped
    // internal caller cannot override the server-derived value.
    storageKeyHash: hashLocalAssetStorageKey(values.storageKey),
  };
}
