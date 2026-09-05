import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashLocalAssetStorageKey,
  sealLocalAssetStorageIdentity,
} from "./local-asset-storage-key";

describe("local asset storage identity", () => {
  it("derives the exact SHA-256 of the authoritative storage key", () => {
    const storageKey = "presales-v2:asset-123";
    expect(hashLocalAssetStorageKey(storageKey)).toBe(
      createHash("sha256").update(storageKey, "utf8").digest("hex"),
    );
  });

  it("overwrites a forged hash at the server persistence boundary", () => {
    const values = sealLocalAssetStorageIdentity({
      storageKey: "frontmind-v2:asset-456",
      storageKeyHash: "0".repeat(64),
    });
    expect(values.storageKeyHash).toBe(
      hashLocalAssetStorageKey(values.storageKey),
    );
    expect(values.storageKeyHash).not.toBe("0".repeat(64));
  });

  it("rejects empty and overlong storage keys before persistence", () => {
    expect(() => hashLocalAssetStorageKey("")).toThrow(
      "LOCAL_ASSET_STORAGE_KEY_INVALID",
    );
    expect(() => hashLocalAssetStorageKey("x".repeat(1_025))).toThrow(
      "LOCAL_ASSET_STORAGE_KEY_INVALID",
    );
  });
});
