import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  readSelectedOfficialLogoFromKnowledgeArchive,
  validateTrustedSiteBrandAsset,
} from "./knowledge-brand-asset";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const bytes = await sharp({
    create: {
      width: 160,
      height: 80,
      channels: 4,
      background: { r: 10, g: 60, b: 100, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const archive = new JSZip();
  archive.file("acme/09_media_assets/brand-logo.png", bytes);
  return {
    bytes,
    archiveBytes: await archive.generateAsync({ type: "nodebuffer" }),
    asset: {
      id: "official-logo",
      key: "00000000-0000-4000-8000-000000000001.png",
      path: "acme/09_media_assets/brand-logo.png",
      mimeType: "image/png",
      size: bytes.length,
      sha256: hash(bytes),
      width: 160,
      height: 80,
      sourceKind: "official_logo_upload" as const,
      ownership: "first_party" as const,
    },
  };
}

describe("SiteOps immutable official logo reader", () => {
  it("reads only the selected official logo and verifies its frozen coordinates", async () => {
    const value = await fixture();
    const resolved = await readSelectedOfficialLogoFromKnowledgeArchive({
      archiveBytes: value.archiveBytes,
      assets: [
        value.asset,
        {
          id: "evidence",
          key: "evidence.png",
          path: "acme/private/evidence.png",
          mimeType: "image/png",
          size: value.bytes.length,
          sha256: hash(value.bytes),
          sourceKind: "official_document",
          ownership: "unknown",
        },
      ],
      decisions: [
        {
          id: value.asset.id,
          sha256: value.asset.sha256,
          decision: "publish",
        },
        {
          id: "evidence",
          sha256: hash(value.bytes),
          decision: "quarantine",
        },
      ],
    });

    expect(resolved).toMatchObject({
      assetId: "official-logo",
      mimeType: "image/png",
      publicPath: "public/brand-logo.png",
      sha256: value.asset.sha256,
      sizeBytes: value.bytes.length,
      width: 160,
      height: 80,
    });
    expect(resolved?.bytes.equals(value.bytes)).toBe(true);
  });

  it("rejects path, byte-hash and dimension drift", async () => {
    const value = await fixture();
    const read = (asset: typeof value.asset) =>
      readSelectedOfficialLogoFromKnowledgeArchive({
        archiveBytes: value.archiveBytes,
        assets: [asset],
        decisions: [
          {
            id: asset.id,
            sha256: asset.sha256,
            decision: "publish",
          },
        ],
      });

    await expect(
      read({ ...value.asset, key: "../logo.png" }),
    ).rejects.toThrow("SITEOPS_BRAND_ASSET_STORAGE_KEY_INVALID");
    await expect(
      read({ ...value.asset, sha256: "0".repeat(64) }),
    ).rejects.toThrow("SITEOPS_BRAND_ASSET_HASH_MISMATCH");
    await expect(read({ ...value.asset, width: 159 })).rejects.toThrow(
      "SITEOPS_BRAND_ASSET_DIMENSIONS_INVALID",
    );
  });

  it("rejects executable or externally referenced SVG before decoding", async () => {
    for (const source of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/logo.png" /></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>unsafe</div></foreignObject></svg>',
    ]) {
      const bytes = Buffer.from(source, "utf8");
      await expect(
        validateTrustedSiteBrandAsset({
          assetId: "official-logo",
          sha256: hash(bytes),
          mimeType: "image/svg+xml",
          bytes,
        }),
      ).rejects.toThrow(/SITEOPS_BRAND_ASSET_SVG_/u);
    }
  });
});
