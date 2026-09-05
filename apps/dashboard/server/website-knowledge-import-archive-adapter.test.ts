import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  buildWebsiteKnowledgeImportFixture,
  buildWebsiteKnowledgeImportV4Fixture,
} from "./__testutils__/website-knowledge-import-archive";
import {
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT,
  WebsiteKnowledgeImportArchiveError,
  canonicalizeWebsiteKnowledgeImportArchive,
  projectWebsiteKnowledgeImportArchiveV4,
} from "./website-knowledge-import-archive-adapter";

describe("Website knowledge-import archive adapter", () => {
  it("gives rootless and arbitrary single-root packages identical canonical bytes", async () => {
    const rootless = await buildWebsiteKnowledgeImportFixture();
    const rooted = await buildWebsiteKnowledgeImportFixture({
      root: "另一个企业知识库根目录",
      reverse: true,
      date: new Date("2024-02-03T04:05:06.000Z"),
      unixPermissions: 0o100664,
      compressionLevel: 9,
    });

    const first = await canonicalizeWebsiteKnowledgeImportArchive(
      rootless.buffer,
    );
    const second = await canonicalizeWebsiteKnowledgeImportArchive(
      rooted.buffer,
    );
    const idempotent = await canonicalizeWebsiteKnowledgeImportArchive(
      first.buffer,
    );

    expect(second.sha256).toBe(first.sha256);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(idempotent.sha256).toBe(first.sha256);
    expect(idempotent.buffer.equals(first.buffer)).toBe(true);

    const canonical = await JSZip.loadAsync(first.buffer, { checkCRC32: true });
    const entries = Object.values(canonical.files).filter(
      (entry) => !entry.dir,
    );
    expect(entries.length).toBeGreaterThan(40);
    expect(
      entries.every((entry) =>
        entry.name.startsWith(`${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/`),
      ),
    ).toBe(true);
    expect(
      entries.every(
        (entry) =>
          entry.date.toISOString() === "1980-01-01T00:00:00.000Z" &&
          entry.unixPermissions === 0o100644,
      ),
    ).toBe(true);

    const rootlessZip = await JSZip.loadAsync(rootless.buffer, {
      checkCRC32: true,
    });
    const originalManifest = await rootlessZip
      .file("00_package_manifest.json")!
      .async("nodebuffer");
    const canonicalManifest = await canonical
      .file(
        `${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/00_package_manifest.json`,
      )!
      .async("nodebuffer");
    expect(canonicalManifest.equals(originalManifest)).toBe(true);
  });

  it("feeds a rootless Website package through the real strict reader without relaxing it", async () => {
    const source = await buildWebsiteKnowledgeImportFixture();
    await expect(
      readKnowledgeArchive(
        source.buffer,
        "rootless-website.zip",
        "raw-rootless-reader",
        { validationProfile: "website-lead-v1" },
      ),
    ).rejects.toThrow("知识库 ZIP 必须只包含一个企业知识库根目录");

    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const parsed = await readKnowledgeArchive(
      canonical.buffer,
      "canonical-website.zip",
      "canonical-reader",
      { validationProfile: "website-lead-v1" },
    );
    try {
      expect(parsed.packageManifestSha256).toBe(source.packageManifestSha256);
      expect(
        parsed.documents.filter((document) => document.customerVisible),
      ).toHaveLength(40);
      expect(parsed.assets).toHaveLength(0);
    } finally {
      await removeStoredKnowledgeAssets(parsed.storedAssetKeys);
    }
  });

  it("projects usable Website v4 content without requiring legacy inventories", async () => {
    const source = await buildWebsiteKnowledgeImportV4Fixture({
      root: "website-v4-output",
      includeImage: true,
    });
    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    expect(canonical.schemaVersion).toBe(4);
    const archive = await JSZip.loadAsync(canonical.buffer);
    expect(
      archive.file(
        `${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/09_media_assets/asset_inventory.md`,
      ),
    ).toBeNull();

    const projected = await projectWebsiteKnowledgeImportArchiveV4({
      buffer: canonical.buffer,
      snapshotId: "website-v4-projection",
    });
    try {
      expect(projected.packageManifestSha256).toBe(
        source.packageManifestSha256,
      );
      expect(projected.documents).toHaveLength(2);
      expect(
        projected.documents.map((document) => ({
          id: document.id,
          kind: document.kind,
          branchId: document.branchId,
          customerVisible: document.customerVisible,
        })),
      ).toEqual([
        {
          id: "overview-1",
          kind: "overview",
          branchId: "company-identity",
          customerVisible: true,
        },
        {
          id: "leaf-1",
          kind: "leaf",
          branchId: "products-services",
          customerVisible: true,
        },
      ]);
      expect(
        projected.documents.some((document) =>
          ["readme", "evidence", "index"].includes(document.kind || ""),
        ),
      ).toBe(false);
      expect(projected.assets).toEqual([
        expect.objectContaining({
          id: "asset-1",
          branchId: "company-identity",
          documentIds: ["overview-1"],
          assetType: "brand_identity",
          displayRole: "badge",
        }),
      ]);
    } finally {
      await removeStoredKnowledgeAssets(projected.storedAssetKeys);
    }
  });

  it("ignores v4 bookkeeping drift, missing hidden files, and non-first-party images", async () => {
    const source = await buildWebsiteKnowledgeImportV4Fixture({
      includeImage: true,
      mutate: ({ entries, manifest }) => {
        entries.delete("README.md");
        entries.delete("evidence/source-1.md");
        manifest.candidateContractVersion = 99;
        manifest.allPaths = ["invented/path.md"];
        manifest.counts.totalFiles = 999;
        manifest.assets[0].ownership = "third_party";
      },
    });
    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const projected = await projectWebsiteKnowledgeImportArchiveV4({
      buffer: canonical.buffer,
      snapshotId: "website-v4-bookkeeping-drift",
    });
    try {
      expect(projected.documents.map((document) => document.id)).toEqual([
        "overview-1",
        "leaf-1",
      ]);
      expect(projected.assets).toEqual([]);
    } finally {
      await removeStoredKnowledgeAssets(projected.storedAssetKeys);
    }
  });

  it("keeps evidence paths hidden even when manifest metadata marks them as visible leaves", async () => {
    const source = await buildWebsiteKnowledgeImportV4Fixture({
      mutate: ({ manifest }) => {
        const evidence = manifest.documents.find(
          (document: Record<string, unknown>) =>
            document.path === "evidence/source-1.md",
        );
        evidence.kind = "leaf";
        evidence.customerVisible = true;
      },
    });
    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const projected = await projectWebsiteKnowledgeImportArchiveV4({
      buffer: canonical.buffer,
      snapshotId: "website-v4-evidence-path-hidden",
    });
    try {
      expect(projected.documents.map((document) => document.id)).toEqual([
        "overview-1",
        "leaf-1",
      ]);
      expect(
        projected.documents.some(
          (document) => document.path.toLowerCase() === "evidence/source-1.md",
        ),
      ).toBe(false);
    } finally {
      await removeStoredKnowledgeAssets(projected.storedAssetKeys);
    }
  });

  it("normalizes reserved paths before hiding visible documents and building the extractor", async () => {
    const source = await buildWebsiteKnowledgeImportV4Fixture({
      mutate: ({ entries, manifest }) => {
        const reservedPath = "ＲｅＡＤＭｅ.md";
        entries.set(reservedPath, entries.get("README.md")!);
        entries.delete("README.md");
        const readme = manifest.documents.find(
          (document: Record<string, unknown>) => document.path === "README.md",
        );
        readme.path = reservedPath;
        readme.kind = "leaf";
        readme.customerVisible = true;
      },
    });
    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const projected = await projectWebsiteKnowledgeImportArchiveV4({
      buffer: canonical.buffer,
      snapshotId: "website-v4-normalized-reserved-path-hidden",
    });
    try {
      expect(projected.documents.map((document) => document.id)).toEqual([
        "overview-1",
        "leaf-1",
      ]);
      expect(
        projected.documents.some((document) => document.id === "readme-1"),
      ).toBe(false);
    } finally {
      await removeStoredKnowledgeAssets(projected.storedAssetKeys);
    }
  });

  it("keeps usable v4 text when an individual image or document is invalid", async () => {
    const source = await buildWebsiteKnowledgeImportV4Fixture({
      includeImage: true,
      mutate: ({ entries }) => {
        entries.set(
          "09_media_assets/brand_identity/asset-1.png",
          Buffer.from("not-an-image", "utf8"),
        );
        entries.delete("03_products/product.md");
      },
    });
    const canonical = await canonicalizeWebsiteKnowledgeImportArchive(
      source.buffer,
    );
    const projected = await projectWebsiteKnowledgeImportArchiveV4({
      buffer: canonical.buffer,
      snapshotId: "website-v4-partial",
    });
    try {
      expect(projected.documents.map((document) => document.id)).toEqual([
        "overview-1",
      ]);
      expect(projected.assets).toEqual([]);
    } finally {
      await removeStoredKnowledgeAssets(projected.storedAssetKeys);
    }
  });

  it("rejects v4 only when its manifest is unrecognized or no displayable text remains", async () => {
    const empty = await buildWebsiteKnowledgeImportV4Fixture({
      mutate: ({ entries }) => {
        entries.delete("01_company_overview/00_overview.md");
        entries.delete("03_products/product.md");
      },
    });
    const emptyCanonical = await canonicalizeWebsiteKnowledgeImportArchive(
      empty.buffer,
    );
    await expect(
      projectWebsiteKnowledgeImportArchiveV4({
        buffer: emptyCanonical.buffer,
        snapshotId: "website-v4-empty",
      }),
    ).rejects.toThrow("没有可安全展示的正式正文");

    const wrongProfile = await buildWebsiteKnowledgeImportV4Fixture({
      mutate: ({ manifest }) => {
        manifest.profile = "dashboard-enterprise-v1";
      },
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(wrongProfile.buffer),
    ).rejects.toThrow("合同无法识别");
  });

  it.each([
    {
      label: "a root and child copy of a standard file",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set("nested/README.md", Buffer.from("duplicate", "utf8")),
    },
    {
      label: "multiple package manifests",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set(
          "nested/00_package_manifest.json",
          entries.get("00_package_manifest.json")!,
        ),
    },
    {
      label: "multiple completeness reports",
      mutate: (entries: Map<string, Buffer>) =>
        entries.set(
          "nested/00_completeness.json",
          entries.get("00_completeness.json")!,
        ),
    },
  ])("rejects $label", async ({ mutate }) => {
    const source = await buildWebsiteKnowledgeImportFixture({ mutate });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(source.buffer),
    ).rejects.toBeInstanceOf(WebsiteKnowledgeImportArchiveError);
  });

  it("rejects duplicate normalized paths before choosing a package root", async () => {
    const source = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) =>
        entries.set("ＲＥＡＤＭＥ.md", Buffer.from("duplicate", "utf8")),
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(source.buffer),
    ).rejects.toThrow("重复规范路径");
  });

  it("rejects exact duplicate central-directory names hidden by the ZIP reader", async () => {
    const source = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) => {
        entries.set("extra/dup1.txt", Buffer.from("one", "utf8"));
        entries.set("extra/dup2.txt", Buffer.from("two", "utf8"));
      },
    });
    const duplicate = Buffer.from(source.buffer);
    const originalName = Buffer.from("extra/dup2.txt", "utf8");
    const duplicateName = Buffer.from("extra/dup1.txt", "utf8");
    let replaced = 0;
    let offset = 0;
    while ((offset = duplicate.indexOf(originalName, offset)) >= 0) {
      duplicateName.copy(duplicate, offset);
      offset += duplicateName.length;
      replaced += 1;
    }
    expect(replaced).toBe(2);
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(duplicate),
    ).rejects.toThrow("重复或含糊的中央目录路径");
  });

  it("rejects traversal, symlink, nested-wrapper, and out-of-root entries", async () => {
    const traversal = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) =>
        entries.set("../escape.txt", Buffer.from("escape", "utf8")),
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(traversal.buffer),
    ).rejects.toThrow("不安全的文件路径");

    const symlink = await buildWebsiteKnowledgeImportFixture({
      unixPermissions: 0o120777,
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(symlink.buffer),
    ).rejects.toThrow("符号链接");

    const nested = await buildWebsiteKnowledgeImportFixture({
      root: "outer/inner",
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(nested.buffer),
    ).rejects.toThrow("不在同一包根目录");

    const rooted = await buildWebsiteKnowledgeImportFixture({ root: "root" });
    const outsideZip = await JSZip.loadAsync(rooted.buffer);
    outsideZip.file("outside.txt", "outside", {
      createFolders: false,
      unixPermissions: 0o100644,
    });
    const outside = await outsideZip.generateAsync({
      type: "nodebuffer",
      platform: "UNIX",
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(outside),
    ).rejects.toThrow("包根目录之外");
  });

  it("rejects invalid ZIP bytes and an archive over the entry limit", async () => {
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(Buffer.from("not-a-zip")),
    ).rejects.toBeInstanceOf(WebsiteKnowledgeImportArchiveError);

    const oversized = await buildWebsiteKnowledgeImportFixture({
      mutate: (entries) => {
        for (let index = 0; index < 2_000; index += 1) {
          entries.set(`extra/${index}.txt`, Buffer.from([index & 0xff]));
        }
      },
    });
    await expect(
      canonicalizeWebsiteKnowledgeImportArchive(oversized.buffer),
    ).rejects.toThrow("文件数量超出限制");
  });
});
