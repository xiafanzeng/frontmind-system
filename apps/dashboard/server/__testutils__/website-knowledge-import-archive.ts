import { createHash } from "node:crypto";

import JSZip from "jszip";

const branchDirectories = [
  "01_company_overview",
  "02_team",
  "03_products",
  "04_technology",
  "05_manufacturing",
  "06_industries",
  "07_service",
  "08_competitive_advantages",
] as const;

export function websiteKnowledgeImportFixtureEntries() {
  const entries = new Map<string, Buffer>();
  const supportingDocuments = [
    ["README.md", "# 示例企业知识库"],
    ["00_knowledge_tree.md", "# 知识树"],
    ["00_crawl_coverage_report.md", "# 官网采集报告"],
    ["00_web_intelligence_report.md", "# 公开信息报告"],
    ["00_source_index.md", "# 来源索引"],
    ["09_media_assets/asset_inventory.md", "# 第一方图片清单"],
    ["10_reference_assets/reference_asset_inventory.md", "# 第三方素材索引"],
  ] as const;
  const overviewDirectories = branchDirectories.filter(
    (directory) => directory !== "05_manufacturing",
  );
  const customerDocumentSpecs = [
    ...overviewDirectories.map((directory, index) => ({
      id: `overview-${index + 1}`,
      path: `${directory}/00_overview.md`,
      kind: "overview" as const,
      title: `${directory} 综述`,
      branchId: directory,
    })),
    ...Array.from({ length: 33 }, (_, index) => {
      const directory = branchDirectories[index % branchDirectories.length]!;
      return {
        id: `leaf-${index + 1}`,
        path: `${directory}/knowledge-${index + 1}.md`,
        kind: "leaf" as const,
        title: `知识叶子 ${index + 1}`,
        branchId: directory,
      };
    }),
  ];
  const customerCharacters = 8_004;
  const baseCharacters = 120;
  const firstDocumentCharacters =
    customerCharacters - (customerDocumentSpecs.length - 1) * baseCharacters;
  const customerDocuments = customerDocumentSpecs.map((document, index) => {
    const narrative = String.fromCodePoint(0x4e00 + index).repeat(
      index === 0 ? firstDocumentCharacters : baseCharacters,
    );
    entries.set(
      document.path,
      Buffer.from(
        `# ${document.title}\n\n> 最后更新: 2026-08-16 | 状态: verified_first_party | 来源: 企业官网\n\n${narrative}`,
        "utf8",
      ),
    );
    return {
      ...document,
      order: index + 1,
      evidenceStatus: "verified_first_party" as const,
      sourceIds: ["source-1"],
      assetIds: [],
      customerVisible: true,
    };
  });

  for (const [relativePath, content] of supportingDocuments) {
    entries.set(relativePath, Buffer.from(content, "utf8"));
  }
  const documents = [
    ...supportingDocuments.map(([relativePath]) => ({
      id: `doc-${relativePath}`,
      path: relativePath,
      kind: relativePath.includes("report") ? "report" : "index",
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    })),
    ...customerDocuments,
  ];
  const evidenceCharacters = supportingDocuments.reduce(
    (total, [, content]) =>
      total +
      Array.from(
        content
          .replace(/^#{1,6}\s+/gmu, "")
          .replace(/\s/gu, "")
          .replace(
            /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/gu,
            "",
          ),
      ).length,
    0,
  );
  const completeness = {
    counts: {
      totalLeaves: customerDocuments.length,
      verifiedFirstParty: customerDocuments.length,
      verifiedAuthoritative: 0,
      supportedThirdParty: 0,
      inferred: 0,
      needsVerification: 0,
      notApplicable: 0,
    },
    acquisition: {
      images: { completed: 0, total: 0 },
    },
    gaps: [],
    evaluatedAt: "2026-08-16T00:00:00.000Z",
  };
  const manifest = {
    schemaVersion: 1,
    profile: "website-lead-v1",
    documents,
    assets: [],
    counts: {
      totalFiles: documents.length + 2,
      customerVisibleCharacters: customerCharacters,
      evidenceCharacters,
      packagedImages: 0,
    },
    imageSelection: {
      eligibleFirstPartyImages: 0,
      shortfallReason: "官网没有可用于交付的第一方图片",
    },
  };
  entries.set(
    "00_completeness.json",
    Buffer.from(JSON.stringify(completeness), "utf8"),
  );
  entries.set(
    "00_package_manifest.json",
    Buffer.from(JSON.stringify(manifest), "utf8"),
  );
  return entries;
}

export async function buildWebsiteKnowledgeImportFixture(options?: {
  root?: string;
  reverse?: boolean;
  date?: Date;
  unixPermissions?: number;
  compressionLevel?: number;
  mutate?: (entries: Map<string, Buffer>) => void;
}) {
  const entries = websiteKnowledgeImportFixtureEntries();
  options?.mutate?.(entries);
  const ordered = [...entries.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (options?.reverse) ordered.reverse();
  const prefix = options?.root ? `${options.root}/` : "";
  const zip = new JSZip();
  for (const [relativePath, bytes] of ordered) {
    zip.file(`${prefix}${relativePath}`, bytes, {
      binary: true,
      createFolders: false,
      date: options?.date ?? new Date("2026-08-16T04:00:00.000Z"),
      unixPermissions: options?.unixPermissions ?? 0o100600,
    });
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: options?.compressionLevel ?? 3 },
  });
  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    packageManifestSha256: createHash("sha256")
      .update(entries.get("00_package_manifest.json")!)
      .digest("hex"),
  };
}

const websiteV4FixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNIMTrxH4QZYAwAUFgJdZeJuy8AAAAASUVORK5CYII=",
  "base64",
);

export async function buildWebsiteKnowledgeImportV4Fixture(options?: {
  root?: string;
  includeImage?: boolean;
  includeInventories?: boolean;
  mutate?: (input: {
    entries: Map<string, Buffer>;
    manifest: Record<string, any>;
  }) => void;
}) {
  const entries = new Map<string, Buffer>();
  const visibleDocuments = [
    {
      id: "overview-1",
      path: "01_company_overview/00_overview.md",
      kind: "overview",
      title: "示例企业综述",
      branchId: "01_company_overview",
      order: 1,
      evidenceStatus: "verified_first_party",
      sourceIds: ["source-1"],
      assetIds: options?.includeImage ? ["asset-1"] : [],
      customerVisible: true,
    },
    {
      id: "leaf-1",
      path: "03_products/product.md",
      kind: "leaf",
      title: "示例产品",
      branchId: "03_products",
      order: 2,
      evidenceStatus: "verified_first_party",
      sourceIds: ["source-1"],
      assetIds: [],
      customerVisible: true,
    },
  ];
  const hiddenDocuments = [
    {
      id: "readme-1",
      path: "README.md",
      kind: "readme",
      title: "说明",
      customerVisible: false,
    },
    {
      id: "evidence-1",
      path: "evidence/source-1.md",
      kind: "evidence",
      title: "来源证据",
      sourceIds: ["source-1"],
      customerVisible: false,
    },
  ];
  for (const document of visibleDocuments) {
    entries.set(
      document.path,
      Buffer.from(
        `# ${document.title}\n\n示例企业提供的可展示知识正文。`,
        "utf8",
      ),
    );
  }
  entries.set("README.md", Buffer.from("# 示例企业 Website 知识库", "utf8"));
  entries.set(
    "evidence/source-1.md",
    Buffer.from("# 来源证据\n\nhttps://example.com", "utf8"),
  );
  entries.set(
    "00_completeness.json",
    Buffer.from(JSON.stringify({ counts: {}, acquisition: {} }), "utf8"),
  );
  if (options?.includeInventories) {
    entries.set(
      "09_media_assets/asset_inventory.md",
      Buffer.from("# 第一方图片清单", "utf8"),
    );
    entries.set(
      "10_reference_assets/reference_asset_inventory.md",
      Buffer.from("# 第三方素材索引", "utf8"),
    );
  }
  const assets = options?.includeImage
    ? [
        {
          id: "asset-1",
          path: "09_media_assets/brand_identity/asset-1.png",
          sha256: createHash("sha256")
            .update(websiteV4FixturePng)
            .digest("hex"),
          mimeType: "image/png",
          bytes: websiteV4FixturePng.length,
          width: 2,
          height: 2,
          caption: "示例企业标识",
          alt: "示例企业标识",
          branchId: "01_company_overview",
          documentIds: ["overview-1"],
          sourceKind: "official_web",
          ownership: "first_party",
          assetType: "brand_identity",
          displayRole: "badge",
        },
      ]
    : [];
  if (options?.includeImage) {
    entries.set(
      "09_media_assets/brand_identity/asset-1.png",
      websiteV4FixturePng,
    );
  }
  const manifest: Record<string, any> = {
    schemaVersion: 4,
    candidateContractVersion: 2,
    profile: "website-lead-v1",
    documents: [...hiddenDocuments, ...visibleDocuments],
    assets,
    counts: {
      totalFiles: 0,
      customerVisibleCharacters: 1,
      evidenceCharacters: 1,
      packagedImages: assets.length,
    },
    branchEvidence: [],
    imageSelection: {
      status: "source_limited",
      discoveredCandidateImages: assets.length,
      inspectedCandidateImages: assets.length,
      eligibleFirstPartyImages: assets.length,
      rejectedCandidateImages: 0,
      scannedSourcePages: 1,
      discoveryMethods: ["img"],
      candidates: [],
      productFamilies: [],
      shortfallReason: "fixture intentionally keeps the content contract small",
    },
    allPaths: [],
    evidencePaths: ["evidence/source-1.md"],
  };
  manifest.allPaths = [...entries.keys(), "00_package_manifest.json"].sort();
  manifest.counts.totalFiles = manifest.allPaths.length;
  options?.mutate?.({ entries, manifest });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  entries.set("00_package_manifest.json", manifestBytes);

  const prefix = options?.root ? `${options.root}/` : "";
  const zip = new JSZip();
  for (const [relativePath, bytes] of [...entries.entries()].sort()) {
    zip.file(`${prefix}${relativePath}`, bytes, {
      binary: true,
      createFolders: false,
      date: new Date("2026-08-18T00:00:00.000Z"),
      unixPermissions: 0o100644,
    });
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });
  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    packageManifestSha256: createHash("sha256")
      .update(manifestBytes)
      .digest("hex"),
  };
}
