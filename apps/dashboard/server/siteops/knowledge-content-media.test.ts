import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type { KnowledgeAssetRecord } from "../../drizzle/schema";
import {
  freezeSelectedKnowledgeMediaFromArchive,
  overlaySiteOpsKnowledgeMedia,
  SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEMS,
  type TrustedSiteKnowledgeMedia,
} from "./knowledge-content-media";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function image(
  format: "jpeg" | "png" | "webp" = "png",
  color = { r: 22, g: 78, b: 130, alpha: 1 },
) {
  return sharp({
    create: { width: 12, height: 8, channels: 4, background: color },
  })
    [format]()
    .toBuffer();
}

function asset(input: {
  id: string;
  path: string;
  bytes: Buffer;
  mimeType?: string;
  ownership?: KnowledgeAssetRecord["ownership"];
  alt?: string;
  caption?: string;
}): KnowledgeAssetRecord {
  return {
    id: input.id,
    key: `${input.id}.bin`,
    path: input.path,
    mimeType: input.mimeType ?? "image/png",
    size: input.bytes.length,
    sha256: digest(input.bytes),
    width: 12,
    height: 8,
    ownership: input.ownership ?? "first_party",
    sourceKind: "official_document",
    alt: input.alt,
    caption: input.caption,
  };
}

async function knowledgeArchive(
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.bytes, { createFolders: false });
  }
  return zip.generateAsync({ type: "nodebuffer", compression });
}

async function resolvedFixture() {
  const bytes = await image();
  const record = asset({
    id: "product-shot",
    path: "company/assets/product.png",
    bytes,
    alt: "产品操作界面",
  });
  const archiveBytes = await knowledgeArchive([{ path: record.path, bytes }]);
  const [media] = await freezeSelectedKnowledgeMediaFromArchive({
    archiveBytes,
    assets: [record],
    selectedMediaIds: [record.id!],
  });
  return { archiveBytes, bytes, media: media!, record };
}

describe("SiteOps frozen knowledge content media", () => {
  it("freezes exact first-party raster bytes at a stable public path", async () => {
    const png = await image("png");
    const jpeg = await image("jpeg", { r: 120, g: 45, b: 20, alpha: 1 });
    const records = [
      asset({
        id: "diagram",
        path: "company/assets/diagram.png",
        bytes: png,
        caption: "服务流程图",
      }),
      asset({
        id: "photo",
        path: "company/assets/photo.jpeg",
        bytes: jpeg,
        mimeType: "image/jpeg",
        caption: "photo.jpeg",
      }),
    ];
    const archiveBytes = await knowledgeArchive([
      { path: records[0]!.path, bytes: png },
      { path: records[1]!.path, bytes: jpeg },
    ]);

    const media = await freezeSelectedKnowledgeMediaFromArchive({
      archiveBytes,
      assets: records,
      selectedMediaIds: ["diagram", "photo"],
    });

    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({
      assetId: "diagram",
      publicPath: `/frontmind-knowledge-media/${digest(png)}.png`,
      alt: "服务流程图",
      width: 12,
      height: 8,
    });
    expect(media[0]!.bytes.equals(png)).toBe(true);
    expect(media[1]).toMatchObject({
      assetId: "photo",
      publicPath: `/frontmind-knowledge-media/${digest(jpeg)}.jpg`,
      alt: "知识库图片",
    });
    expect(media[1]!.bytes.equals(jpeg)).toBe(true);
  });

  it("fails closed for missing, duplicate or excessive plan selections", async () => {
    const bytes = await image();
    const record = asset({ id: "one", path: "assets/one.png", bytes });
    const archiveBytes = await knowledgeArchive([{ path: record.path, bytes }]);
    const read = (selectedMediaIds: string[]) =>
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes,
        assets: [record],
        selectedMediaIds,
      });

    await expect(read(["missing"])).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID",
    });
    await expect(read(["one", "one"])).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_SELECTION_INVALID",
    });
    await expect(
      read(
        Array.from(
          { length: SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEMS + 1 },
          (_, index) => `asset-${index}`,
        ),
      ),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_SELECTION_INVALID",
    });

    const oversizedSet = Array.from({ length: 9 }, (_, index) => ({
      ...asset({
        id: `large-${index}`,
        path: `assets/large-${index}.png`,
        bytes,
      }),
      size: 8 * 1024 * 1024,
    }));
    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes,
        assets: oversizedSet,
        selectedMediaIds: oversizedSet.map((item) => item.id!),
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID",
    });
  });

  it("rejects non-first-party, MIME, hash, size and dimension drift", async () => {
    const bytes = await image();
    const archiveBytes = await knowledgeArchive([
      { path: "assets/item.png", bytes },
    ]);
    const read = (override: Partial<KnowledgeAssetRecord>) =>
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes,
        assets: [
          {
            ...asset({ id: "item", path: "assets/item.png", bytes }),
            ...override,
          },
        ],
        selectedMediaIds: ["item"],
      });

    await expect(read({ ownership: "third_party" })).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_OWNERSHIP_INVALID",
    });
    await expect(read({ mimeType: "image/gif" })).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_MIME_INVALID",
    });
    await expect(read({ sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH",
    });
    await expect(read({ size: bytes.length - 1 })).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID",
    });
    await expect(read({ width: 11 })).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_DIMENSIONS_INVALID",
    });
  });

  it("rejects corrupt CRCs, traversal paths and undecodable raster bytes", async () => {
    const bytes = await image();
    const record = asset({ id: "item", path: "assets/item.png", bytes });
    const stored = await knowledgeArchive(
      [{ path: record.path, bytes }],
      "STORE",
    );
    const corrupted = Buffer.from(stored);
    const payloadOffset = corrupted.indexOf(bytes);
    expect(payloadOffset).toBeGreaterThan(0);
    corrupted[payloadOffset + 10] ^= 0xff;

    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: corrupted,
        assets: [record],
        selectedMediaIds: ["item"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID",
    });

    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: stored,
        assets: [{ ...record, path: "../assets/item.png" }],
        selectedMediaIds: ["item"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_PATH_INVALID",
    });

    const traversal = new JSZip();
    traversal.file("../item.png", bytes, { createFolders: false });
    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: await traversal.generateAsync({ type: "nodebuffer" }),
        assets: [{ ...record, path: "item.png" }],
        selectedMediaIds: ["item"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID",
    });

    const broken = Buffer.from("not a real png");
    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: await knowledgeArchive([
          { path: "assets/broken.png", bytes: broken },
        ]),
        assets: [
          {
            ...asset({
              id: "broken",
              path: "assets/broken.png",
              bytes: broken,
            }),
            width: undefined,
            height: undefined,
          },
        ],
        selectedMediaIds: ["broken"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_DECODE_INVALID",
    });
  });

  it("rejects ambiguous record paths and duplicate stable targets", async () => {
    const bytes = await image();
    const other = await image("png", { r: 90, g: 90, b: 10, alpha: 1 });
    const duplicatePath = [
      asset({ id: "one", path: "assets/item.png", bytes }),
      asset({ id: "two", path: "assets/item.png", bytes: other }),
    ];
    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: await knowledgeArchive([
          { path: "assets/item.png", bytes },
        ]),
        assets: duplicatePath,
        selectedMediaIds: ["one"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID",
    });

    const duplicateBytes = [
      asset({ id: "one", path: "assets/one.png", bytes }),
      asset({ id: "two", path: "assets/two.png", bytes }),
    ];
    await expect(
      freezeSelectedKnowledgeMediaFromArchive({
        archiveBytes: await knowledgeArchive([
          { path: "assets/one.png", bytes },
          { path: "assets/two.png", bytes },
        ]),
        assets: duplicateBytes,
        selectedMediaIds: ["one", "two"],
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION",
    });
  });
});

describe("SiteOps knowledge content media source overlay", () => {
  it("preserves a source wrapper and installs exact bytes deterministically", async () => {
    const { bytes, media } = await resolvedFixture();
    const source = new JSZip();
    source.file("native-site/package.json", "{}", { createFolders: false });
    source.file("native-site/src/App.tsx", "export default function App(){}", {
      createFolders: false,
    });
    const sourceBytes = await source.generateAsync({ type: "nodebuffer" });

    const first = await overlaySiteOpsKnowledgeMedia(sourceBytes, [media]);
    const second = await overlaySiteOpsKnowledgeMedia(sourceBytes, [media]);
    expect(first.equals(second)).toBe(true);
    const output = await JSZip.loadAsync(first, { checkCRC32: true });
    await expect(
      output
        .file(
          `native-site/public/frontmind-knowledge-media/${media.sha256}.png`,
        )!
        .async("nodebuffer"),
    ).resolves.toEqual(bytes);
    expect(output.file("native-site/src/App.tsx")).not.toBeNull();
  });

  it("rejects existing targets and frozen coordinate tampering", async () => {
    const { media } = await resolvedFixture();
    const source = new JSZip();
    source.file("package.json", "{}", { createFolders: false });
    source.file(`public${media.publicPath}`, media.bytes, {
      createFolders: false,
    });
    await expect(
      overlaySiteOpsKnowledgeMedia(
        await source.generateAsync({ type: "nodebuffer" }),
        [media],
      ),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION",
    });

    const clean = new JSZip();
    clean.file("package.json", "{}", { createFolders: false });
    const changed: TrustedSiteKnowledgeMedia = {
      ...media,
      bytes: Buffer.from("changed"),
    };
    await expect(
      overlaySiteOpsKnowledgeMedia(
        await clean.generateAsync({ type: "nodebuffer" }),
        [changed],
      ),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH",
    });
  });

  it("rejects unsafe source ZIP paths instead of normalizing them", async () => {
    const { media } = await resolvedFixture();
    const source = new JSZip();
    source.file("../package.json", "{}", { createFolders: false });
    await expect(
      overlaySiteOpsKnowledgeMedia(
        await source.generateAsync({ type: "nodebuffer" }),
        [media],
      ),
    ).rejects.toMatchObject({
      code: "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_ARCHIVE_INVALID",
    });
  });
});
