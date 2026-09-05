import { createHash } from "node:crypto";

import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeArchiveValidationError,
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";

const storedKeys: string[] = [];
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg1EwEAAC6AIxr7t1xAAAAAElFTkSuQmCC",
  "base64",
);

afterEach(async () => {
  await removeStoredKnowledgeAssets(storedKeys.splice(0));
});

type ArchiveOptions = {
  imageCount?: number;
  claimedImageCount?: number;
  customerCharacters?: number;
  duplicateImageBytes?: boolean;
  invalidImage?: boolean;
  malformedRaster?: "jpeg" | "webp" | "avif";
  rawSvg?: boolean;
};

function headerOnlyRaster(kind: "jpeg" | "webp" | "avif") {
  if (kind === "jpeg") return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const bytes = Buffer.alloc(16);
  if (kind === "webp") {
    bytes.write("RIFF", 0, "ascii");
    bytes.writeUInt32LE(8, 4);
    bytes.write("WEBP", 8, "ascii");
  } else {
    bytes.writeUInt32BE(16, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("avif", 8, "ascii");
  }
  return bytes;
}

async function websiteArchive(options: ArchiveOptions = {}) {
  const imageCount = options.imageCount ?? 36;
  const claimedImageCount = options.claimedImageCount ?? imageCount;
  const customerCharacters = options.customerCharacters ?? 8_004;
  const root = "示例企业_knowledge_base";
  const zip = new JSZip();
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
  const baseCharacters = 120;
  const firstDocumentCharacters = Math.max(
    0,
    customerCharacters - (customerDocumentSpecs.length - 1) * baseCharacters,
  );
  const customerDocuments = customerDocumentSpecs.map((document, index) => {
    const narrativeCharacters =
      index === 0 ? firstDocumentCharacters : baseCharacters;
    const narrative = String.fromCodePoint(0x4e00 + index).repeat(
      narrativeCharacters,
    );
    const content = `# ${document.title}

> 最后更新: 2026-07-29 | 状态: verified_first_party | 来源: 企业官网

${narrative}`;
    zip.file(`${root}/${document.path}`, content);
    return {
      ...document,
      order: index + 1,
      evidenceStatus: "verified_first_party" as const,
      sourceIds: ["source-1"],
      assetIds:
        index === 0
          ? Array.from(
              { length: imageCount },
              (_, assetIndex) => `asset-${assetIndex + 1}`,
            )
          : [],
      customerVisible: true,
    };
  });
  const supportingDocuments = [
    ["README.md", "# 示例企业知识库"],
    ["00_knowledge_tree.md", "# 知识树"],
    ["00_crawl_coverage_report.md", "# 官网采集报告"],
    ["00_web_intelligence_report.md", "# 公开信息报告"],
    ["00_source_index.md", "# 来源索引"],
    ["09_media_assets/asset_inventory.md", "# 第一方图片清单"],
    ["10_reference_assets/reference_asset_inventory.md", "# 第三方素材索引"],
  ] as const;
  for (const [relativePath, content] of supportingDocuments) {
    zip.file(`${root}/${relativePath}`, content);
  }

  const documents = [
    ...supportingDocuments.map(([relativePath]) => ({
      id: `doc-${relativePath}`,
      path: relativePath,
      kind: relativePath.includes("report")
        ? ("report" as const)
        : relativePath.includes("index") || relativePath.includes("inventory")
          ? ("index" as const)
          : ("index" as const),
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    })),
    ...customerDocuments,
  ];
  const assets = Array.from({ length: imageCount }, (_, index) => {
    const malformedKind = index === 0 ? options.malformedRaster : undefined;
    const extension = malformedKind === "jpeg" ? "jpg" : malformedKind || "png";
    const mimeType =
      malformedKind === "jpeg"
        ? ("image/jpeg" as const)
        : malformedKind === "webp"
          ? ("image/webp" as const)
          : malformedKind === "avif"
            ? ("image/avif" as const)
            : ("image/png" as const);
    const relativePath = `09_media_assets/product_images/image-${index + 1}.${extension}`;
    const uniqueImageBytes = options.duplicateImageBytes
      ? pngBytes
      : Buffer.concat([
          pngBytes,
          Buffer.from([index & 0xff, (index >> 8) & 0xff]),
        ]);
    const bytes = malformedKind
      ? headerOnlyRaster(malformedKind)
      : options.invalidImage && index === 0
        ? Buffer.from("not-an-image")
        : uniqueImageBytes;
    zip.file(`${root}/${relativePath}`, bytes);
    return {
      id: `asset-${index + 1}`,
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
      bytes: bytes.length,
      width: 1,
      height: 1,
      caption: `示例图片 ${index + 1}`,
      branchId: "01_company_overview",
      documentIds: ["overview-1"],
      sourcePageUrl: "https://example.com/",
      sourceAssetUrl: `https://example.com/image-${index + 1}.${extension}`,
      ownership: "first_party" as const,
    };
  });
  if (options.rawSvg) {
    zip.file(
      `${root}/09_media_assets/vector.svg`,
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
  }
  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
      counts: {
        totalLeaves: 40,
        verifiedFirstParty: 40,
        verifiedAuthoritative: 0,
        supportedThirdParty: 0,
        inferred: 0,
        needsVerification: 0,
        notApplicable: 0,
      },
      acquisition: {
        images: { completed: claimedImageCount, total: claimedImageCount },
      },
      gaps: [],
      evaluatedAt: "2026-07-29T00:00:00.000Z",
    }),
  );
  const totalFiles =
    9 + customerDocumentSpecs.length + imageCount + (options.rawSvg ? 1 : 0);
  const evidenceCharacters = supportingDocuments.reduce(
    (total, [, content]) =>
      total +
      Array.from(
        content
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\s/g, "")
          .replace(
            /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]/g,
            "",
          ),
      ).length,
    0,
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      profile: "website-lead-v1",
      documents,
      assets,
      counts: {
        totalFiles,
        customerVisibleCharacters: customerCharacters,
        evidenceCharacters,
        packagedImages: imageCount,
      },
      imageSelection: {
        eligibleFirstPartyImages: imageCount,
        ...(imageCount < 36
          ? { shortfallReason: "官网真实可用第一方图片不足 36 张" }
          : {}),
      },
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function websiteV2Archive(
  options: {
    leafCount?: number;
    overviewCount?: number;
    imageCount?: number;
    customerCharacters?: number;
    zeroEvidence?: boolean;
    imageStatus?: "target_met" | "source_limited" | "budget_limited";
    uninspectedCandidateCount?: number;
  } = {},
) {
  const leafCount = options.leafCount ?? 40;
  const overviewCount = options.overviewCount ?? 7;
  const imageCount = options.imageCount ?? 0;
  const zeroEvidence = options.zeroEvidence ?? false;
  const uninspectedCandidateCount = options.uninspectedCandidateCount ?? 0;
  const root = "示例企业V2_knowledge_base";
  const zip = new JSZip();
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
  const overviewDirectories = branchDirectories.filter(
    (directory) => directory !== "05_manufacturing",
  );
  const supportingDocuments = [
    ["README.md", "# 示例企业 V2 知识库"],
    ["00_knowledge_tree.md", "# 知识树"],
    ["00_crawl_coverage_report.md", "# 官网采集报告"],
    ["00_web_intelligence_report.md", "# 公开信息报告"],
    ["00_source_index.md", "# 来源索引"],
    ["09_media_assets/asset_inventory.md", "# 第一方图片清单"],
    ["10_reference_assets/reference_asset_inventory.md", "# 第三方素材索引"],
  ] as const;
  const documents: Array<Record<string, unknown>> = [];
  const validInlinePng = await sharp({
    create: {
      width: 800,
      height: 450,
      channels: 3,
      background: "#315ad8",
    },
  })
    .png()
    .toBuffer();
  let evidenceCharacters = 0;
  for (const [relativePath, content] of supportingDocuments) {
    zip.file(`${root}/${relativePath}`, content);
    evidenceCharacters += content
      .replace(/^#\s*/, "")
      .replace(/\s/g, "").length;
    documents.push({
      id: `doc-${relativePath}`,
      path: relativePath,
      kind: relativePath.includes("report")
        ? "report"
        : relativePath.includes("index") || relativePath.includes("inventory")
          ? "index"
          : "index",
      title: relativePath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    });
  }
  const customerSpecs = [
    ...overviewDirectories.slice(0, overviewCount).map((branchId, index) => ({
      id: `overview-${index + 1}`,
      path: `${branchId}/00_overview.md`,
      kind: "overview" as const,
      branchId,
    })),
    ...Array.from({ length: leafCount }, (_, index) => {
      const branchId = branchDirectories[index % branchDirectories.length]!;
      return {
        id: `leaf-${index + 1}`,
        path: `${branchId}/knowledge-${index + 1}.md`,
        kind: "leaf" as const,
        branchId,
      };
    }),
  ];
  const displayBranchByDirectory = new Map<string, string>([
    ["01_company_overview", "company-identity"],
    ["02_team", "team"],
    ["03_products", "products-services"],
    ["04_technology", "core-capabilities"],
    ["05_manufacturing", "core-capabilities"],
    ["06_industries", "customers-industries"],
    ["07_service", "cooperation"],
    ["08_competitive_advantages", "why-frontmind"],
  ]);
  const branchEvidenceCharacters = new Map<string, number>();
  for (const spec of customerSpecs) {
    const displayBranch = displayBranchByDirectory.get(spec.branchId)!;
    branchEvidenceCharacters.set(
      displayBranch,
      (branchEvidenceCharacters.get(displayBranch) || 0) +
        (zeroEvidence ? 0 : 100),
    );
  }
  const branchMinimum = (displayBranch: string) => {
    const characters = branchEvidenceCharacters.get(displayBranch) || 0;
    if (characters === 0) return 40;
    return Math.min(
      displayBranch === "products-services" ? 3_000 : 1_500,
      Math.max(120, Math.ceil(characters * 0.25)),
    );
  };
  const baseNarrativeCharacters = customerSpecs.reduce(
    (total, spec) =>
      total +
      (spec.kind === "overview"
        ? branchMinimum(displayBranchByDirectory.get(spec.branchId)!)
        : 120),
    0,
  );
  const requestedCustomerCharacters =
    options.customerCharacters ?? baseNarrativeCharacters;
  if (requestedCustomerCharacters < baseNarrativeCharacters) {
    throw new Error(
      "customerCharacters is below the fixture's dynamic minimum",
    );
  }
  let customerVisibleCharacters = 0;
  for (const [index, spec] of customerSpecs.entries()) {
    const sourceId = `source-${index + 1}`;
    const evidenceId = `evidence-${spec.id}`;
    const evidencePath = `evidence/${spec.id}.md`;
    if (!zeroEvidence) {
      const evidenceContent = String.fromCodePoint(0x3400 + index).repeat(100);
      zip.file(`${root}/${evidencePath}`, evidenceContent);
      evidenceCharacters += 100;
      documents.push({
        id: evidenceId,
        path: evidencePath,
        kind: "evidence",
        title: `${spec.id} 证据`,
        branchId: spec.branchId,
        sourceIds: [sourceId],
        assetIds: [],
        customerVisible: false,
      });
    }
    const displayBranch = displayBranchByDirectory.get(spec.branchId)!;
    const minimumCharacters =
      spec.kind === "overview"
        ? branchMinimum(displayBranch)
        : zeroEvidence
          ? 40
          : 60;
    const narrativeCharacters =
      (spec.kind === "overview" ? minimumCharacters : 120) +
      (index === 0 ? requestedCustomerCharacters - baseNarrativeCharacters : 0);
    customerVisibleCharacters += narrativeCharacters;
    const title = `${spec.id} 正式内容`;
    zip.file(
      `${root}/${spec.path}`,
      `# ${title}\n\n> 状态: ${
        zeroEvidence ? "needs_verification" : "verified_first_party"
      } | 来源: 企业官网\n\n${String.fromCodePoint(0x4e00 + index).repeat(
        narrativeCharacters,
      )}`,
    );
    documents.push({
      ...spec,
      title,
      order: index + 1,
      evidenceStatus: zeroEvidence
        ? "needs_verification"
        : "verified_first_party",
      sourceIds: zeroEvidence ? [] : [sourceId],
      evidenceDocumentIds: zeroEvidence ? [] : [evidenceId],
      assetIds:
        spec.id === "overview-3"
          ? Array.from(
              { length: imageCount },
              (_, assetIndex) => `asset-${assetIndex + 1}`,
            )
          : [],
      customerVisible: true,
      evidenceCharacters: zeroEvidence ? 0 : 100,
      dynamicMinimumCharacters: minimumCharacters,
      ...(spec.kind === "leaf" && spec.branchId === "03_products"
        ? { productFamilyIds: ["family-products"] }
        : {}),
    });
  }
  const assets = Array.from({ length: imageCount }, (_, index) => {
    const assetId = `asset-${index + 1}`;
    const assetPath = `09_media_assets/product_images/${assetId}.png`;
    const assetBytes = Buffer.concat([validInlinePng, Buffer.from([index])]);
    zip.file(`${root}/${assetPath}`, assetBytes);
    return {
      id: assetId,
      path: assetPath,
      sha256: createHash("sha256").update(assetBytes).digest("hex"),
      mimeType: "image/png",
      bytes: assetBytes.length,
      width: 800,
      height: 450,
      caption: "核心产品官方图片",
      branchId: "03_products",
      documentIds: ["overview-3"],
      sourcePageUrl: "https://example.com/products",
      sourceAssetUrl: `https://example.com/assets/${assetId}.png`,
      ownership: "first_party",
      assetType: index === 0 ? "brand_identity" : "product_ui",
      displayRole: "inline",
    };
  });
  const imageSelectionStatus =
    options.imageStatus ??
    (uninspectedCandidateCount > 0
      ? "budget_limited"
      : assets.length > 1
        ? "target_met"
        : "source_limited");
  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
      counts: {
        totalLeaves: leafCount,
        verifiedFirstParty: zeroEvidence ? 0 : leafCount,
        verifiedAuthoritative: 0,
        supportedThirdParty: 0,
        inferred: 0,
        needsVerification: zeroEvidence ? leafCount : 0,
        notApplicable: 0,
      },
      acquisition: {
        officialPages: { completed: 1, total: 1 },
        images: {
          completed: imageCount,
          total: imageCount + uninspectedCandidateCount,
        },
        documents: { completed: 0, total: 0 },
        webQueries: { completed: 0, total: 0 },
      },
      gaps: ["官网没有可用于交付的第一方图片"],
      evaluatedAt: "2026-07-29T00:00:00.000Z",
    }),
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 2,
      profile: "website-lead-v1",
      documents,
      assets,
      counts: {
        totalFiles: documents.length + assets.length + 2,
        customerVisibleCharacters,
        evidenceCharacters,
        packagedImages: assets.length,
      },
      branchEvidence: [
        ["company-identity", "overview-1"],
        ["team", "overview-2"],
        ["products-services", "overview-3"],
        ["core-capabilities", "overview-4"],
        ["customers-industries", "overview-5"],
        ["cooperation", "overview-6"],
        ["why-frontmind", "overview-7"],
      ].map(([branchId, overviewDocumentId], index) => ({
        branchId,
        overviewDocumentId,
        contentStatus: zeroEvidence ? "needs_verification" : "limited_evidence",
        deduplicatedEvidenceCharacters:
          branchEvidenceCharacters.get(branchId) || 0,
        dynamicOverviewMinimum: branchMinimum(branchId),
        checkedSourceCount: index + 1,
      })),
      imageSelection: {
        status: imageSelectionStatus,
        discoveredCandidateImages: assets.length + uninspectedCandidateCount,
        inspectedCandidateImages: assets.length,
        eligibleFirstPartyImages: assets.length,
        rejectedCandidateImages: 0,
        scannedSourcePages: 1,
        discoveryMethods: [
          "img",
          "srcset_or_lazy",
          "picture",
          "css_background",
          "open_graph",
          "gallery",
          "official_document",
        ],
        candidates: [
          ...assets.map((asset) => ({
            url: asset.sourceAssetUrl,
            sourcePageUrl: asset.sourcePageUrl,
            method: "img",
            status: "eligible",
            assetId: asset.id,
          })),
          ...Array.from({ length: uninspectedCandidateCount }, (_, index) => ({
            url: `https://example.com/uninspected-${index + 1}.png`,
            sourcePageUrl: "https://example.com/products",
            method: "gallery",
            status: "uninspected",
          })),
        ],
        productFamilies: [
          {
            id: "family-products",
            name: "核心产品族",
            officialVisualFound: assets.length > 1,
            checkedSources: 1,
            assetIds: assets.slice(1).map((asset) => asset.id),
            ...(assets.length <= 1
              ? { gapReason: "官方来源未提供可交付图片" }
              : {}),
          },
        ],
        ...(imageSelectionStatus === "target_met"
          ? {}
          : { shortfallReason: "官网没有可用于交付的第一方图片" }),
      },
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function dashboardEnterpriseArchive() {
  const root = "深度企业_knowledge_base";
  const zip = new JSZip();
  const supportingPaths = [
    "README.md",
    "00_knowledge_tree.md",
    "00_crawl_coverage_report.md",
    "00_web_intelligence_report.md",
    "00_source_index.md",
    "00_media_gaps.md",
    "09_media_assets/asset_inventory.md",
    "10_reference_assets/reference_asset_inventory.md",
  ];
  const documents: Array<Record<string, unknown>> = supportingPaths.map(
    (relativePath, index) => {
      zip.file(`${root}/${relativePath}`, "# ");
      return {
        id: `support-${index + 1}`,
        path: relativePath,
        kind: relativePath.includes("report")
          ? "report"
          : relativePath.includes("index") || relativePath.includes("inventory")
            ? "index"
            : "index",
        title: relativePath,
        sourceIds: [],
        assetIds: [],
        customerVisible: false,
      };
    },
  );
  const formalDocument = (title: string, narrative: string) => `# ${title}

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

证据区不应进入客户可见正文。
`;
  const evidencePath = "branches/products/evidence/official-products.md";
  zip.file(`${root}/${evidencePath}`, "证".repeat(100));
  documents.push({
    id: "evidence-official-products",
    path: evidencePath,
    kind: "evidence",
    title: "官方产品证据",
    branchId: "products",
    sourceIds: ["source-official"],
    assetIds: [],
    customerVisible: false,
  });
  const overviewPath = "branches/products/00_overview.md";
  zip.file(
    `${root}/${overviewPath}`,
    formalDocument("产品与服务综述", "综".repeat(120)),
  );
  documents.push({
    id: "overview-products",
    path: overviewPath,
    kind: "overview",
    title: "产品与服务综述",
    branchId: "products",
    order: 0,
    evidenceStatus: "verified_first_party",
    sourceIds: ["source-official"],
    evidenceDocumentIds: ["evidence-official-products"],
    assetIds: [],
    customerVisible: true,
    evidenceCharacters: 100,
    requiredFormalCharacters: 120,
    contentStatus: "limited_evidence",
  });
  for (let index = 0; index < 40; index += 1) {
    const relativePath = `branches/products/leaf-${index + 1}.md`;
    zip.file(
      `${root}/${relativePath}`,
      formalDocument(
        `知识叶子 ${index + 1}`,
        String.fromCodePoint(0x4e00 + index).repeat(80),
      ),
    );
    documents.push({
      id: `leaf-${index + 1}`,
      path: relativePath,
      kind: "leaf",
      title: `知识叶子 ${index + 1}`,
      branchId: "products",
      productFamilyId: "family-a",
      order: index + 1,
      evidenceStatus: "verified_first_party",
      sourceIds: ["source-official"],
      evidenceDocumentIds: ["evidence-official-products"],
      assetIds: [],
      customerVisible: true,
      evidenceCharacters: 100,
      requiredFormalCharacters: 80,
      contentStatus: "limited_evidence",
    });
  }
  zip.file(
    `${root}/00_completeness.json`,
    JSON.stringify({
      counts: {
        totalLeaves: 40,
        verifiedFirstParty: 40,
        verifiedAuthoritative: 0,
        supportedThirdParty: 0,
        inferred: 0,
        needsVerification: 0,
        notApplicable: 0,
      },
      acquisition: {
        officialPages: { completed: 0, total: 0 },
        images: { completed: 0, total: 0 },
        documents: { completed: 0, total: 0 },
        webQueries: { completed: 0, total: 0 },
      },
      gaps: ["官网没有可用于交付的第一方图片"],
      evaluatedAt: "2026-07-29T00:00:00.000Z",
    }),
  );
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 2,
      profile: "dashboard-enterprise-v1",
      documents,
      assets: [],
      counts: {
        totalFiles: documents.length + 2,
        customerVisibleCharacters: 3_320,
        evidenceCharacters: 100,
        packagedImages: 0,
      },
      imageSelection: {
        status: "source_limited",
        discoveredCandidateImages: 0,
        inspectedCandidateImages: 0,
        eligibleFirstPartyImages: 0,
        rejectedCandidateImages: 0,
        scannedSourcePages: 0,
        discoveryMethods: [
          "img",
          "srcset",
          "lazy_load",
          "picture",
          "css_background",
          "open_graph",
          "gallery",
          "official_document",
        ],
        candidates: [],
        rejectionReasons: [],
        stopReason: "已检查所有官方页面和资料",
        productFamilyCoverage: [
          {
            familyId: "family-a",
            familyName: "产品族 A",
            officialImageAvailable: false,
            assetIds: [],
            checkedSources: ["https://example.com/products"],
            gapReason: "官方来源未提供可交付图片",
          },
        ],
        shortfallReason: "官网没有可用于交付的第一方图片",
      },
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function dashboardV4OfficialLogoUploadArchive() {
  const root = "深度企业_knowledge_base";
  const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
  const manifestPath = `${root}/00_package_manifest.json`;
  const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
  const logoPath = "09_media_assets/company-logo.png";
  const logoBytes = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: "#173c36",
    },
  })
    .png()
    .toBuffer();
  const logoSha256 = createHash("sha256").update(logoBytes).digest("hex");
  zip.file(`${root}/${logoPath}`, logoBytes);
  manifest.schemaVersion = 4;
  manifest.buildRevision = 7;
  const leaves = manifest.documents.filter(
    (document: { kind?: string }) => document.kind === "leaf",
  );
  leaves.forEach(
    (document: { order?: number; branchTitle?: string }, index: number) => {
      document.order = index;
      document.branchTitle = "产品与服务";
    },
  );
  leaves[0].assetIds = ["asset-company-logo"];
  manifest.assets = [
    {
      id: "asset-company-logo",
      path: logoPath,
      sha256: logoSha256,
      mimeType: "image/png",
      bytes: logoBytes.length,
      width: 256,
      height: 256,
      caption: "客户上传的企业官方 Logo",
      alt: "企业 Logo",
      branchId: "products",
      documentIds: ["leaf-1"],
      sourceKind: "official_logo_upload",
      sourceUploadIndex: 0,
      sourceUploadFileId: "file-official-logo",
      sourceUploadFilename: "company-logo.png",
      sourceUploadMimeType: "image/png",
      sourceUploadSizeBytes: logoBytes.length,
      sourceUploadSha256: logoSha256,
      ownership: "first_party",
      assetType: "brand_identity",
      displayRole: "badge",
    },
  ];
  manifest.counts.totalFiles += 1;
  manifest.counts.packagedImages = 1;
  manifest.imageSelection = {
    status: "target_met",
    discoveredCandidateImages: 1,
    inspectedCandidateImages: 1,
    eligibleFirstPartyImages: 1,
    rejectedCandidateImages: 0,
    scannedSourcePages: 0,
    discoveryMethods: ["customer_upload"],
    candidates: [
      {
        sourceKind: "official_logo_upload",
        method: "customer_upload",
        status: "eligible",
        assetId: "asset-company-logo",
      },
    ],
    rejectionReasons: [],
    stopReason: "客户已上传并指定企业官方主 Logo",
  };
  zip.file(manifestPath, JSON.stringify(manifest));
  const completenessPath = `${root}/00_completeness.json`;
  const completeness = JSON.parse(
    await zip.file(completenessPath)!.async("string"),
  );
  completeness.acquisition.images = { completed: 1, total: 1 };
  completeness.gaps = [];
  zip.file(completenessPath, JSON.stringify(completeness));
  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    logoSha256,
    logoSizeBytes: logoBytes.length,
  };
}

async function parseWebsiteArchive(buffer: Buffer) {
  const result = await readKnowledgeArchive(
    buffer,
    "示例企业知识库.zip",
    "snapshot-test",
    { validationProfile: "website-lead-v1" },
  );
  storedKeys.push(...result.storedAssetKeys);
  return result;
}

describe("versioned knowledge archive quality gates", () => {
  it("allows audit language in internal completeness metadata", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const completeness = JSON.parse(
      await zip.file(`${root}/00_completeness.json`)!.async("string"),
    );
    completeness.gaps = [
      "本轮没有形成可逐项核验的证书名称与有效期，待企业补充。",
    ];
    zip.file(`${root}/00_completeness.json`, JSON.stringify(completeness));

    const result = await readKnowledgeArchive(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "内部缺口允许核验措辞.zip",
      "deep-internal-gap-test",
      { validationProfile: "dashboard-enterprise-v1" },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(result.documents).toHaveLength(50);
  });

  it("does not reject customer formal content based on semantic style", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const semanticProse =
      "第一方页面摘录显示本轮没有形成可逐项核验的证书名称与有效期";
    const narrative = `${semanticProse}${"甲".repeat(
      80 - semanticProse.length,
    )}`;
    zip.file(
      `${root}/branches/products/leaf-1.md`,
      `# 知识叶子 1

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

证据区不应进入客户可见正文。
`,
    );

    const result = await readKnowledgeArchive(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "语义风格不阻断.zip",
      "deep-semantic-style-test",
      { validationProfile: "dashboard-enterprise-v1" },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(result.documents).toHaveLength(50);
  });

  it("accepts a deep v2 archive and stores only the marked formal prose", async () => {
    const result = await readKnowledgeArchive(
      await dashboardEnterpriseArchive(),
      "深度企业知识库.zip",
      "deep-snapshot-test",
      { validationProfile: "dashboard-enterprise-v1" },
    );
    storedKeys.push(...result.storedAssetKeys);

    const customerDocuments = result.documents.filter(
      (document) => document.customerVisible,
    );
    expect(customerDocuments).toHaveLength(41);
    expect(
      customerDocuments.every(
        (document) =>
          document.content.includes("正式正文") &&
          !document.content.includes("证据区不应进入客户可见正文"),
      ),
    ).toBe(true);
    expect(customerDocuments[0]).toMatchObject({
      contentStatus: "limited_evidence",
      evidenceCharacters: 100,
    });
  });

  it("accepts a v3 archive while retaining v2 compatibility", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestPath = "深度企业_knowledge_base/00_package_manifest.json";
    const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
    const logoPath = "09_media_assets/company-logo.png";
    const logoBytes = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 3,
        background: "#173c36",
      },
    })
      .png()
      .toBuffer();
    zip.file(`${root}/${logoPath}`, logoBytes);
    manifest.schemaVersion = 3;
    manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    ).assetIds = ["asset-company-logo"];
    manifest.assets = [
      {
        id: "asset-company-logo",
        path: logoPath,
        sha256: createHash("sha256").update(logoBytes).digest("hex"),
        mimeType: "image/png",
        bytes: logoBytes.length,
        width: 256,
        height: 256,
        caption: "企业官方 Logo",
        alt: "企业 Logo",
        branchId: "products",
        documentIds: ["leaf-1"],
        sourcePageUrl: "https://example.com/",
        sourceAssetUrl: "https://example.com/assets/logo.png",
        sourceKind: "official_web",
        ownership: "first_party",
        assetType: "brand_identity",
        displayRole: "badge",
      },
    ];
    manifest.counts.totalFiles += 1;
    manifest.counts.packagedImages = 1;
    manifest.imageSelection = {
      status: "target_met",
      discoveredCandidateImages: 1,
      inspectedCandidateImages: 1,
      eligibleFirstPartyImages: 1,
      rejectedCandidateImages: 0,
      scannedSourcePages: 0,
      discoveryMethods: ["img"],
      candidates: [
        {
          url: "https://example.com/assets/logo.png",
          sourcePageUrl: "https://example.com/",
          method: "img",
          status: "eligible",
          assetId: "asset-company-logo",
        },
      ],
      rejectionReasons: [],
      stopReason: "已取得企业官方 Logo，停止图片发现",
    };
    zip.file(manifestPath, JSON.stringify(manifest));
    const completenessPath = `${root}/00_completeness.json`;
    const completeness = JSON.parse(
      await zip.file(completenessPath)!.async("string"),
    );
    completeness.acquisition.images = { completed: 1, total: 1 };
    completeness.gaps = [];
    zip.file(completenessPath, JSON.stringify(completeness));

    const result = await readKnowledgeArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      "深度企业知识库-v3.zip",
      "deep-v3-snapshot-test",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersions: [2, 3],
      },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(
      result.documents.filter((document) => document.customerVisible),
    ).toHaveLength(41);
  });

  it("accepts Dashboard v4 dedicated official Logo upload provenance", async () => {
    const archive = await dashboardV4OfficialLogoUploadArchive();
    const result = await readKnowledgeArchive(
      archive.buffer,
      "深度企业知识库-v4-uploaded-logo.zip",
      "deep-v4-uploaded-logo-test",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersion: 4,
      },
    );
    storedKeys.push(...result.storedAssetKeys);

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      sourceKind: "official_logo_upload",
      sourceUploadIndex: 0,
      sourceUploadFileId: "file-official-logo",
      sourceUploadFilename: "company-logo.png",
      sourceUploadMimeType: "image/png",
      sourceUploadSizeBytes: archive.logoSizeBytes,
      sourceUploadSha256: archive.logoSha256,
      sha256: archive.logoSha256,
      ownership: "first_party",
      assetType: "brand_identity",
      displayRole: "badge",
    });
  });

  it("rejects an uploaded official Logo candidate without customer_upload method", async () => {
    const archive = await dashboardV4OfficialLogoUploadArchive();
    const zip = await JSZip.loadAsync(archive.buffer);
    const manifestPath = "深度企业_knowledge_base/00_package_manifest.json";
    const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
    manifest.imageSelection.discoveryMethods = ["img"];
    manifest.imageSelection.candidates[0].method = "img";
    zip.file(manifestPath, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库-v4-uploaded-logo-invalid.zip",
        "deep-v4-uploaded-logo-invalid-test",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 4,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects a v2 document that understates its packaged evidence", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const manifestEntry = zip.file(
      "深度企业_knowledge_base/00_package_manifest.json",
    )!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    const overview = manifest.documents.find(
      (document: { id?: string }) => document.id === "overview-products",
    );
    overview.evidenceCharacters = 0;
    overview.requiredFormalCharacters = 60;
    overview.contentStatus = "needs_verification";
    zip.file(
      "深度企业_knowledge_base/00_package_manifest.json",
      JSON.stringify(manifest),
    );

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-evidence-mismatch",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "content",
    });
  });

  it("rejects a v2 media audit that omits a product family", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const manifestEntry = zip.file(
      "深度企业_knowledge_base/00_package_manifest.json",
    )!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.imageSelection.productFamilyCoverage = [];
    zip.file(
      "深度企业_knowledge_base/00_package_manifest.json",
      JSON.stringify(manifest),
    );

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-product-coverage-mismatch",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects normalized duplicate evidence documents", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    const duplicatePath = "branches/products/evidence/copied-products.md";
    zip.file(`${root}/${duplicatePath}`, "证， ".repeat(100));
    manifest.documents.push({
      id: "evidence-copied-products",
      path: duplicatePath,
      kind: "evidence",
      title: "复制产品证据",
      branchId: "products",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: false,
    });
    manifest.counts.totalFiles += 1;
    manifest.counts.evidenceCharacters += 100;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-duplicate-evidence",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("证据文档规范化后内容重复");
  });

  it("rejects acquired evidence omitted from all formal documents", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    const omittedPath = "branches/products/evidence/omitted.md";
    zip.file(`${root}/${omittedPath}`, "未".repeat(100));
    manifest.documents.push({
      id: "evidence-omitted",
      path: omittedPath,
      kind: "evidence",
      title: "未整理证据",
      branchId: "products",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: false,
    });
    manifest.counts.totalFiles += 1;
    manifest.counts.evidenceCharacters += 100;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-omitted-evidence",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("都必须被至少一篇正式文档引用");
  });

  it("rejects evidence without the formal document branch scope", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    const evidence = manifest.documents.find(
      (document: { id?: string }) =>
        document.id === "evidence-official-products",
    );
    delete evidence.branchId;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-global-evidence",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("显式属于同一分支");
  });

  it("uses productFamilyId rather than title keywords to identify product branches", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    for (const document of manifest.documents) {
      if (document.branchId === "products") document.branchId = "catalog-a";
      if (document.id === "overview-products") document.title = "核心目录";
    }
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    const result = await readKnowledgeArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      "深度企业知识库.zip",
      "deep-family-id-branch",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersion: 2,
      },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(
      result.documents.filter((document) => document.customerVisible),
    ).toHaveLength(41);
  });

  it("does not accept Website productFamilyIds in an enterprise v2 manifest", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    const leaf = manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    );
    leaf.productFamilyIds = ["family-a"];
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-website-family-field",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("uses productFamilyId");
  });

  it("rejects a partially declared product-family branch", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    delete manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    ).productFamilyId;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-partial-family-branch",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("产品分支的每个叶子");
  });

  it("rejects v2 without any declared product or service family", async () => {
    const zip = await JSZip.loadAsync(await dashboardEnterpriseArchive());
    const root = "深度企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    for (const document of manifest.documents) {
      delete document.productFamilyId;
    }
    manifest.imageSelection.productFamilyCoverage = [];
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "深度企业知识库.zip",
        "deep-no-family",
        {
          validationProfile: "dashboard-enterprise-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("至少声明一个产品或服务族");
  });

  it.each([36, 48])(
    "accepts %s real first-party images and formal overview plus leaves",
    async (imageCount) => {
      const result = await parseWebsiteArchive(
        await websiteArchive({ imageCount }),
      );

      expect(result.assets).toHaveLength(imageCount);
      expect(
        result.documents.filter((document) => document.customerVisible),
      ).toHaveLength(40);
      expect(result.documents[0]?.kind).toBeDefined();
    },
  );

  it("keeps website v1 compatibility at 40 customer-visible documents", async () => {
    const result = await parseWebsiteArchive(await websiteArchive());
    const customerDocuments = result.documents.filter(
      (document) => document.customerVisible,
    );

    expect(customerDocuments).toHaveLength(40);
    expect(
      customerDocuments.filter((document) => document.kind === "overview"),
    ).toHaveLength(7);
    expect(
      customerDocuments.filter((document) => document.kind === "leaf"),
    ).toHaveLength(33);
  });

  it("keeps Website v1 compatibility when a target-sized package retains a shortfall note", async () => {
    const zip = await JSZip.loadAsync(await websiteArchive({ imageCount: 36 }));
    const root = "示例企业_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.imageSelection.shortfallReason = "历史归档保留的素材说明";
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    const result = await parseWebsiteArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(result.assets).toHaveLength(36);
  });

  it.each([40, 56])(
    "accepts website v2 with 7 overviews plus %s true leaves",
    async (leafCount) => {
      const result = await readKnowledgeArchive(
        await websiteV2Archive({ leafCount }),
        "示例企业V2知识库.zip",
        `website-v2-${leafCount}`,
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      );
      storedKeys.push(...result.storedAssetKeys);
      const customerDocuments = result.documents.filter(
        (document) => document.customerVisible,
      );
      expect(
        customerDocuments.filter((document) => document.kind === "overview"),
      ).toHaveLength(7);
      expect(
        customerDocuments.filter((document) => document.kind === "leaf"),
      ).toHaveLength(leafCount);
    },
  );

  it("accepts the authentic Website v2 candidate and product-family field shapes", async () => {
    const result = await readKnowledgeArchive(
      await websiteV2Archive({ leafCount: 40, imageCount: 1 }),
      "示例企业V2知识库.zip",
      "website-v2-authentic-contract",
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 2,
      },
    );
    storedKeys.push(...result.storedAssetKeys);

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      assetType: "brand_identity",
      displayRole: "inline",
      width: 800,
      height: 450,
    });
    expect(
      result.documents.filter((document) => document.kind === "leaf"),
    ).toHaveLength(40);
  });

  it("rejects Website v2 when image scanning omits a parsed official page", async () => {
    const zip = await JSZip.loadAsync(
      await websiteV2Archive({ imageCount: 1 }),
    );
    const root = "示例企业V2_knowledge_base";
    const manifestPath = `${root}/00_package_manifest.json`;
    const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
    manifest.imageSelection.scannedSourcePages = 0;
    zip.file(manifestPath, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-scan-coverage",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("图片扫描页数必须覆盖所有成功解析的官网页面");
  });

  it("enforces Website v2 image roles, dimensions and product visual types", async () => {
    const heroZip = await JSZip.loadAsync(
      await websiteV2Archive({ imageCount: 2 }),
    );
    const root = "示例企业V2_knowledge_base";
    const manifestPath = `${root}/00_package_manifest.json`;
    const heroManifest = JSON.parse(
      await heroZip.file(manifestPath)!.async("string"),
    );
    heroManifest.assets[0].displayRole = "hero";
    heroZip.file(manifestPath, JSON.stringify(heroManifest));
    await expect(
      readKnowledgeArchive(
        await heroZip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-small-hero",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("hero 质量门槛");

    const badgeZip = await JSZip.loadAsync(
      await websiteV2Archive({ imageCount: 2 }),
    );
    const badgeManifest = JSON.parse(
      await badgeZip.file(manifestPath)!.async("string"),
    );
    badgeManifest.assets[0].displayRole = "badge";
    badgeManifest.imageSelection.productFamilies[0].assetIds = ["asset-1"];
    badgeZip.file(manifestPath, JSON.stringify(badgeManifest));
    await expect(
      readKnowledgeArchive(
        await badgeZip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-brand-not-product",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("产品族图片覆盖记录不完整");
  });

  it.each([
    {
      label: "target_met with brand and product coverage at a low honest count",
      options: {
        imageCount: 2 as const,
        uninspectedCandidateCount: 0 as const,
      },
    },
    {
      label: "budget_limited with eligible assets and an uninspected candidate",
      options: {
        imageCount: 2 as const,
        uninspectedCandidateCount: 1 as const,
      },
    },
  ])("accepts Website v2 image status: $label", async ({ options }) => {
    const result = await readKnowledgeArchive(
      await websiteV2Archive(options),
      "示例企业V2知识库.zip",
      `website-v2-image-status-${options.uninspectedCandidateCount || 0}`,
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 2,
      },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(result.assets).toHaveLength(options.imageCount);
  });

  it("rejects target_met when an uninspected Website v2 candidate remains", async () => {
    await expect(
      readKnowledgeArchive(
        await websiteV2Archive({
          imageCount: 2,
          imageStatus: "target_met",
          uninspectedCandidateCount: 1,
        }),
        "示例企业V2知识库.zip",
        "website-v2-invalid-target-status",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "structure",
    });
  });

  it.each([18_001, 40_000])(
    "accepts Website v2 narrative totals up to the 40,000-character contract: %s",
    async (customerCharacters) => {
      const result = await readKnowledgeArchive(
        await websiteV2Archive({ customerCharacters }),
        "示例企业V2知识库.zip",
        `website-v2-characters-${customerCharacters}`,
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      );
      storedKeys.push(...result.storedAssetKeys);
      expect(
        result.documents.filter((document) => document.customerVisible),
      ).toHaveLength(47);
    },
  );

  it("rejects Website v2 narrative above 40,000 characters", async () => {
    await expect(
      readKnowledgeArchive(
        await websiteV2Archive({ customerCharacters: 40_001 }),
        "示例企业V2知识库.zip",
        "website-v2-characters-40001",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "structure",
    });
  });

  it("accepts a Website v2 white-label gap package with no evidence", async () => {
    const result = await readKnowledgeArchive(
      await websiteV2Archive({ zeroEvidence: true }),
      "示例企业V2知识库.zip",
      "website-v2-white-label",
      {
        validationProfile: "website-lead-v1",
        archiveContractVersion: 2,
      },
    );
    storedKeys.push(...result.storedAssetKeys);
    expect(
      result.documents
        .filter((document) => document.kind === "leaf")
        .every((document) => document.evidenceStatus === "needs_verification"),
    ).toBe(true);
  });

  it("rejects Website v2 same-branch evidence without sourceId overlap", async () => {
    const zip = await JSZip.loadAsync(await websiteV2Archive());
    const root = "示例企业V2_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.documents.find(
      (document: { id?: string }) => document.id === "evidence-overview-1",
    ).sourceIds = ["source-evidence-only"];
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-source-scope",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("没有共同来源");
  });

  it("rejects Website v2 leaf dynamicMinimumCharacters tampering", async () => {
    const zip = await JSZip.loadAsync(await websiteV2Archive());
    const root = "示例企业V2_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    ).dynamicMinimumCharacters += 1;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-leaf-minimum-tamper",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("叶子动态要求不正确");
  });

  it("rejects Website v2 branchEvidence tampering", async () => {
    const zip = await JSZip.loadAsync(await websiteV2Archive());
    const root = "示例企业V2_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.branchEvidence[0].deduplicatedEvidenceCharacters += 1;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-branch-evidence-tamper",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toThrow("branchEvidence 动态要求不正确");
  });

  it("rejects Website v2 candidate URLs that do not match the asset", async () => {
    const zip = await JSZip.loadAsync(
      await websiteV2Archive({ imageCount: 1 }),
    );
    const root = "示例企业V2_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    manifest.imageSelection.candidates[0].url =
      "https://example.com/assets/other.png";
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-candidate-mismatch",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "structure",
    });
  });

  it("does not fall back to the internal schema for malformed Website v2", async () => {
    const zip = await JSZip.loadAsync(await websiteV2Archive());
    const root = "示例企业V2_knowledge_base";
    const manifestEntry = zip.file(`${root}/00_package_manifest.json`)!;
    const manifest = JSON.parse(await manifestEntry.async("string"));
    delete manifest.branchEvidence;
    zip.file(`${root}/00_package_manifest.json`, JSON.stringify(manifest));

    await expect(
      readKnowledgeArchive(
        await zip.generateAsync({ type: "nodebuffer" }),
        "示例企业V2知识库.zip",
        "website-v2-no-fallback",
        {
          validationProfile: "website-lead-v1",
          archiveContractVersion: 2,
        },
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "structure",
    });
  });

  it.each([
    { leafCount: 7, overviewCount: 7 },
    { leafCount: 57, overviewCount: 7 },
    { leafCount: 8, overviewCount: 6 },
  ])(
    "rejects website v2 cardinality outside 7 overviews plus 8–56 leaves: %o",
    async ({ leafCount, overviewCount }) => {
      await expect(
        readKnowledgeArchive(
          await websiteV2Archive({ leafCount, overviewCount }),
          "示例企业V2知识库.zip",
          `website-v2-invalid-${leafCount}-${overviewCount}`,
          {
            validationProfile: "website-lead-v1",
            archiveContractVersion: 2,
          },
        ),
      ).rejects.toThrow("7 篇分支综述和 8–56 个知识叶子");
    },
  );

  it("rejects a report count that does not match packaged images", async () => {
    await expect(
      parseWebsiteArchive(
        await websiteArchive({ imageCount: 0, claimedImageCount: 36 }),
      ),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects 49 images for the website profile", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ imageCount: 49 })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects an image whose bytes do not match its extension", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ invalidImage: true })),
    ).rejects.toThrow("知识库图片格式与内容不匹配");
  });

  it.each(["jpeg", "webp", "avif"] as const)(
    "rejects a header-only %s that cannot be decoded",
    async (malformedRaster) => {
      await expect(
        parseWebsiteArchive(await websiteArchive({ malformedRaster })),
      ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
        category: "media",
      });
    },
  );

  it("rejects packaged images that were not deduplicated by SHA-256", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ duplicateImageBytes: true })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects an SVG that was not rasterized before packaging", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ rawSvg: true })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "media",
    });
  });

  it("rejects customer-visible content below 8,000 effective characters", async () => {
    await expect(
      parseWebsiteArchive(await websiteArchive({ customerCharacters: 7_999 })),
    ).rejects.toMatchObject<Partial<KnowledgeArchiveValidationError>>({
      category: "content",
    });
  });
});
