import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  assertKnowledgeBasePackageMatchesBuild,
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
  selectLegacyKnowledgeBaseLogoAsset,
} from "./knowledge-base-package-validation";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const validatorPath = path.resolve(
  process.cwd(),
  "private-workflows/socratic-kb-builder/scripts/validate_archive.py",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function writeArchive(files: Record<string, string | Uint8Array>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-kb-validator-"),
  );
  temporaryDirectories.push(directory);
  const archivePath = path.join(directory, "fixture.zip");
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  await fs.writeFile(
    archivePath,
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  return archivePath;
}

async function runValidator(archivePath: string) {
  try {
    const result = await execFileAsync("python3", [validatorPath, archivePath]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return {
      code: error.code,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

async function validDeepArchiveFiles() {
  const root = "fixture_knowledge_base";
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
    (documentPath, index) => ({
      id: `support-${index + 1}`,
      path: documentPath,
      kind: documentPath.includes("report")
        ? "report"
        : documentPath.includes("index") || documentPath.includes("inventory")
          ? "index"
          : "index",
      title: documentPath,
      sourceIds: [],
      assetIds: [],
      customerVisible: false,
    }),
  );
  const files: Record<string, string | Uint8Array> = Object.fromEntries(
    supportingPaths.map((documentPath) => [`${root}/${documentPath}`, "# "]),
  );
  const formalDocument = (title: string, narrative: string) => `# ${title}

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;
  const overviewPath = "branches/products/00_overview.md";
  const overviewEvidencePath = "branches/products/evidence/overview.md";
  files[`${root}/${overviewEvidencePath}`] = "证".repeat(100);
  documents.push({
    id: "evidence-overview-products",
    path: overviewEvidencePath,
    kind: "evidence",
    title: "产品综述证据",
    branchId: "products",
    sourceIds: ["source-official"],
    assetIds: [],
    customerVisible: false,
  });
  files[`${root}/${overviewPath}`] = formalDocument(
    "产品与服务综述",
    "综".repeat(120),
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
    evidenceDocumentIds: ["evidence-overview-products"],
    assetIds: [],
    customerVisible: true,
    evidenceCharacters: 100,
    requiredFormalCharacters: 120,
    contentStatus: "limited_evidence",
  });
  for (let index = 0; index < 40; index += 1) {
    const leafPath = `branches/products/leaf-${index + 1}.md`;
    const evidencePath = `branches/products/evidence/leaf-${index + 1}.md`;
    const sourceId = `source-official-${index + 1}`;
    files[`${root}/${evidencePath}`] = String.fromCodePoint(
      0x3400 + index,
    ).repeat(100);
    documents.push({
      id: `evidence-leaf-${index + 1}`,
      path: evidencePath,
      kind: "evidence",
      title: `知识叶子 ${index + 1} 证据`,
      branchId: "products",
      sourceIds: [sourceId],
      assetIds: [],
      customerVisible: false,
    });
    files[`${root}/${leafPath}`] = formalDocument(
      `知识叶子 ${index + 1}`,
      String.fromCodePoint(0x4e00 + index).repeat(80),
    );
    documents.push({
      id: `leaf-${index + 1}`,
      path: leafPath,
      kind: "leaf",
      title: `知识叶子 ${index + 1}`,
      branchId: "products",
      branchTitle: "产品与服务",
      productFamilyId: "family-a",
      order: index,
      evidenceStatus: "verified_first_party",
      sourceIds: [sourceId],
      evidenceDocumentIds: [`evidence-leaf-${index + 1}`],
      assetIds: [],
      customerVisible: true,
      evidenceCharacters: 100,
      requiredFormalCharacters: 80,
      contentStatus: "limited_evidence",
    });
  }
  const companyLogo = {
    id: "asset-brand-logo",
    filename: "brand-logo.png",
    width: 512,
    height: 512,
    assetType: "brand_identity",
    displayRole: "badge",
    bytes: await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: "#173c36",
      },
    })
      .png()
      .toBuffer(),
  };
  const firstLeaf = documents.find((document) => document.id === "leaf-1")!;
  firstLeaf.assetIds = [companyLogo.id];
  const assetPath = `09_media_assets/${companyLogo.filename}`;
  files[`${root}/${assetPath}`] = companyLogo.bytes;
  const assets = [
    {
      id: companyLogo.id,
      path: assetPath,
      sha256: createHash("sha256").update(companyLogo.bytes).digest("hex"),
      mimeType: "image/png",
      bytes: companyLogo.bytes.length,
      width: companyLogo.width,
      height: companyLogo.height,
      caption: "企业官方 Logo",
      branchId: "products",
      documentIds: ["leaf-1"],
      sourcePageUrl: "https://example.com/",
      sourceAssetUrl: `https://example.com/assets/${companyLogo.filename}`,
      sourceKind: "official_web",
      ownership: "first_party",
      assetType: companyLogo.assetType,
      displayRole: companyLogo.displayRole,
    },
  ];
  files[`${root}/00_completeness.json`] = JSON.stringify({
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
      officialPages: { completed: 1, total: 1 },
      images: { completed: 1, total: 1 },
      documents: { completed: 0, total: 0 },
      webQueries: { completed: 0, total: 0 },
    },
    gaps: [],
    evaluatedAt: "2026-07-29T00:00:00.000Z",
  });
  files[`${root}/00_package_manifest.json`] = JSON.stringify({
    schemaVersion: 4,
    profile: "dashboard-enterprise-v1",
    buildRevision: 40,
    documents,
    assets,
    counts: {
      totalFiles: documents.length + 3,
      customerVisibleCharacters: 3_320,
      evidenceCharacters: 4_100,
      packagedImages: 1,
    },
    imageSelection: {
      status: "target_met",
      discoveredCandidateImages: 1,
      inspectedCandidateImages: 1,
      eligibleFirstPartyImages: 1,
      rejectedCandidateImages: 0,
      scannedSourcePages: 1,
      discoveryMethods: ["img"],
      candidates: assets.map((asset) => ({
        url: asset.sourceAssetUrl,
        sourcePageUrl: asset.sourcePageUrl,
        method: "img",
        status: "eligible",
        assetId: asset.id,
      })),
      rejectionReasons: [],
      stopReason: "已检查所有官方页面和资料",
    },
  });
  return files;
}

async function addCustomerUploadImage(
  files: Record<string, string | Uint8Array>,
  documentIds = ["leaf-2"],
) {
  const root = "fixture_knowledge_base";
  const manifest = JSON.parse(
    String(files[`${root}/00_package_manifest.json`]),
  );
  const sourceUpload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#73518d"/></svg>',
  );
  const packagedBytes = await sharp(sourceUpload).png().toBuffer();
  const asset: Record<string, any> = {
    id: "asset-user-office",
    path: "09_media_assets/user-upload-office.png",
    sha256: createHash("sha256").update(packagedBytes).digest("hex"),
    mimeType: "image/png",
    bytes: packagedBytes.length,
    width: 320,
    height: 180,
    caption: "客户补充的办公地点图片",
    alt: "办公地点",
    branchId: "products",
    documentIds,
    sourceKind: "user_upload",
    sourceUploadSha256: createHash("sha256").update(sourceUpload).digest("hex"),
    sourceUploadFilename: "office-photo.svg",
    sourceUploadMimeType: "image/svg+xml",
    ownership: "first_party",
    assetType: "customer_supplied",
    displayRole: "inline",
  };
  files[`${root}/${asset.path}`] = packagedBytes;
  manifest.assets.push(asset);
  for (const documentId of documentIds) {
    manifest.documents
      .find((document: { id?: string }) => document.id === documentId)
      .assetIds.push(asset.id);
  }
  manifest.counts.totalFiles += 1;
  manifest.counts.packagedImages += 1;
  files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);
  return { asset, manifest, packagedBytes, sourceUpload };
}

function replaceOfficialLogoWithVerifiedUpload(
  files: Record<string, string | Uint8Array>,
) {
  const root = "fixture_knowledge_base";
  const manifest = JSON.parse(
    String(files[`${root}/00_package_manifest.json`]),
  );
  const asset = manifest.assets[0] as Record<string, unknown>;
  delete asset.sourcePageUrl;
  delete asset.sourceAssetUrl;
  delete asset.sourceDocumentPath;
  Object.assign(asset, {
    sourceKind: "official_logo_upload",
    sourceUploadIndex: 0,
    sourceUploadFileId: "file-official-logo-upload",
    sourceUploadSha256: asset.sha256,
    sourceUploadFilename: "brand-logo.png",
    sourceUploadMimeType: "image/png",
    sourceUploadSizeBytes: asset.bytes,
  });
  manifest.imageSelection.scannedSourcePages = 0;
  manifest.imageSelection.discoveryMethods = ["customer_upload"];
  manifest.imageSelection.candidates = [
    {
      sourceKind: "official_logo_upload",
      method: "customer_upload",
      status: "eligible",
      assetId: asset.id,
    },
  ];
  manifest.imageSelection.stopReason =
    "客户已上传并确认企业官方主 Logo 原图";
  files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);
  return { asset, manifest };
}

describe("dashboard enterprise Skill archive validator", () => {
  it("accepts a complete deep archive with exactly one official Logo", async () => {
    const archivePath = await writeArchive(await validDeepArchiveFiles());

    const result = await runValidator(archivePath);

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
  });

  it("accepts a schema v4 official_logo_upload with the exact upload ledger and strict candidate shape", async () => {
    const files = await validDeepArchiveFiles();
    const { asset, manifest } = replaceOfficialLogoWithVerifiedUpload(files);

    const result = await runValidator(await writeArchive(files));

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
    expect(manifest.schemaVersion).toBe(4);
    expect(asset).toMatchObject({
      sourceKind: "official_logo_upload",
      sourceUploadIndex: 0,
      sourceUploadFileId: "file-official-logo-upload",
      sourceUploadSha256: asset.sha256,
      sourceUploadFilename: "brand-logo.png",
      sourceUploadMimeType: "image/png",
      sourceUploadSizeBytes: asset.bytes,
    });
    expect(Object.keys(manifest.imageSelection.candidates[0]).sort()).toEqual(
      ["assetId", "method", "sourceKind", "status"].sort(),
    );
  });

  it("rejects an official_logo_upload asset missing one required ledger field", async () => {
    const files = await validDeepArchiveFiles();
    const { asset, manifest } = replaceOfficialLogoWithVerifiedUpload(files);
    delete asset.sourceUploadFileId;
    files["fixture_knowledge_base/00_package_manifest.json"] =
      JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "official_logo_upload requires sourceUploadIndex, sourceUploadFileId and sourceUploadSizeBytes",
    );
  });

  it("allows customer-role business terms that are not advice", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const allowedTerms = [
      "客户可根据业务需求",
      "客户应用",
      "客户响应",
      "采购方需求",
      "客户可按需调整",
      "支持合规审查与正式尽调材料管理",
    ].join("。");
    const effectiveLength = allowedTerms.replaceAll("。", "").length;
    const narrative = `${allowedTerms}${"甲".repeat(
      Math.max(0, 80 - effectiveLength),
    )}`;
    files[`${root}/branches/products/leaf-1.md`] = `# 知识叶子 1

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${narrative}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;

    const result = await runValidator(await writeArchive(files));

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
  });

  it("does not reject explicit advice based on semantic style", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const semanticProse = "采购方应先核验供应商资质并向企业索取证明";
    files[`${root}/branches/products/leaf-1.md`] = `# 知识叶子 1

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${semanticProse}${"甲".repeat(80 - semanticProse.length)}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;

    const result = await runValidator(await writeArchive(files));

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
  });

  it("deduplicates one rasterized customer upload across bound leaves without counting it as a Logo candidate", async () => {
    const files = await validDeepArchiveFiles();
    const { manifest } = await addCustomerUploadImage(files, [
      "leaf-2",
      "leaf-3",
    ]);

    const result = await runValidator(await writeArchive(files));

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.counts.packagedImages).toBe(2);
    expect(manifest.assets[1].documentIds).toEqual(["leaf-2", "leaf-3"]);
    expect(manifest.imageSelection).toMatchObject({
      discoveredCandidateImages: 1,
      inspectedCandidateImages: 1,
      eligibleFirstPartyImages: 1,
    });
  });

  it("rejects a customer-uploaded image without original-upload provenance", async () => {
    const files = await validDeepArchiveFiles();
    const { manifest, asset } = await addCustomerUploadImage(files);
    delete asset.sourceUploadSha256;
    files["fixture_knowledge_base/00_package_manifest.json"] =
      JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "user_upload requires sourceUploadSha256, sourceUploadFilename and sourceUploadMimeType",
    );
  });

  it("rejects duplicate assets for the same original customer upload hash", async () => {
    const files = await validDeepArchiveFiles();
    const { manifest, asset } = await addCustomerUploadImage(files);
    const duplicateBytes = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: "#315d54",
      },
    })
      .png()
      .toBuffer();
    const duplicateAsset = {
      ...asset,
      id: "asset-user-office-duplicate",
      path: "09_media_assets/user-upload-office-duplicate.png",
      sha256: createHash("sha256").update(duplicateBytes).digest("hex"),
      bytes: duplicateBytes.length,
      documentIds: ["leaf-3"],
    };
    files[`fixture_knowledge_base/${duplicateAsset.path}`] = duplicateBytes;
    manifest.assets.push(duplicateAsset);
    manifest.documents
      .find((document: { id?: string }) => document.id === "leaf-3")
      .assetIds.push(duplicateAsset.id);
    manifest.counts.totalFiles += 1;
    manifest.counts.packagedImages += 1;
    files["fixture_knowledge_base/00_package_manifest.json"] =
      JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("duplicate original customer upload hash");
  });

  it("rejects an additional crawled visual even when its bytes are valid", async () => {
    const files = await validDeepArchiveFiles();
    const { manifest, asset } = await addCustomerUploadImage(files);
    asset.sourceKind = "official_web";
    asset.sourcePageUrl = "https://example.com/offices";
    asset.sourceAssetUrl = "https://example.com/assets/office.png";
    delete asset.sourceUploadSha256;
    delete asset.sourceUploadFilename;
    delete asset.sourceUploadMimeType;
    files["fixture_knowledge_base/00_package_manifest.json"] =
      JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "official Logo must use brand_identity/badge",
    );
    expect(result.stderr).toContain(
      "exactly one non-user_upload official company Logo",
    );
  });

  it("parses a real ZIP and binds its exact leaf/order/branch/body/Logo set", async () => {
    const files = await validDeepArchiveFiles();
    const archivePath = await writeArchive(files);
    const parsed = await readKnowledgeArchive(
      await fs.readFile(archivePath),
      "fixture.zip",
      "22222222-2222-4222-8222-222222222222",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersions: [4],
      },
    );
    try {
      const leaves = parsed.documents
        .filter((document) => document.kind === "leaf")
        .sort((left, right) => left.order! - right.order!);
      const nodes = leaves.map((document) => {
        const contentMarkdown = canonicalPackagedKnowledgeBaseLeafMarkdown(
          document.content,
        );
        return {
          leafId: document.id!,
          title: document.title,
          branchId: document.branchId!,
          branchTitle: document.branchTitle!,
          ordinal: document.order!,
          status: "confirmed",
          contentMarkdown,
          contentSha256: knowledgeBaseMarkdownSha256(contentMarkdown),
        };
      });
      expect(
        assertKnowledgeBasePackageMatchesBuild({
          nodes,
          documents: parsed.documents,
          assets: parsed.assets,
          expectedLogoSha256: parsed.assets[0]!.sha256!,
          packageSchemaVersion: parsed.packageSchemaVersion,
          expectedCustomerUploads: [],
        }),
      ).toMatchObject({ leafCount: 40 });
    } finally {
      await removeStoredKnowledgeAssets(parsed.storedAssetKeys);
    }
  });

  it("rebinds a representative pinned v3 ZIP with 10/20 order and three visuals", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    manifest.schemaVersion = 2;
    delete manifest.buildRevision;
    const leaves = manifest.documents.filter(
      (document: { kind?: string }) => document.kind === "leaf",
    );
    leaves.forEach((document: { order?: number }, index: number) => {
      document.order = (index + 1) * 10;
    });

    const additionalAssets = await Promise.all(
      [
        {
          id: "asset-brand-hero",
          filename: "brand-hero.webp",
          assetType: "environment_photo",
          displayRole: "hero",
          background: "#d9ece7",
        },
        {
          id: "asset-product-ui",
          filename: "product-ui.webp",
          assetType: "product_ui",
          displayRole: "inline",
          background: "#8fb8ae",
        },
      ].map(async (asset) => {
        const bytes = await sharp({
          create: {
            width: 1600,
            height: 900,
            channels: 3,
            background: asset.background,
          },
        })
          .webp()
          .toBuffer();
        const assetPath = `09_media_assets/${asset.filename}`;
        files[`${root}/${assetPath}`] = bytes;
        return {
          id: asset.id,
          path: assetPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mimeType: "image/webp",
          bytes: bytes.length,
          width: 1600,
          height: 900,
          caption: asset.id,
          branchId: "products",
          documentIds: ["leaf-1"],
          sourcePageUrl: "https://example.com/",
          sourceAssetUrl: `https://example.com/assets/${asset.filename}`,
          sourceKind: "official_web",
          ownership: "first_party",
          assetType: asset.assetType,
          displayRole: asset.displayRole,
        };
      }),
    );
    manifest.assets.push(...additionalAssets);
    leaves[0].assetIds = manifest.assets.map(
      (asset: { id: string }) => asset.id,
    );
    manifest.counts.totalFiles += additionalAssets.length;
    manifest.counts.packagedImages = 3;
    manifest.imageSelection.discoveredCandidateImages = 3;
    manifest.imageSelection.inspectedCandidateImages = 3;
    manifest.imageSelection.eligibleFirstPartyImages = 3;
    manifest.imageSelection.discoveryMethods = [
      "img",
      "srcset",
      "lazy_load",
      "picture",
      "css_background",
      "open_graph",
      "gallery",
      "official_document",
    ];
    manifest.imageSelection.candidates = manifest.assets.map(
      (asset: {
        id: string;
        sourceAssetUrl: string;
        sourcePageUrl: string;
      }) => ({
        url: asset.sourceAssetUrl,
        sourcePageUrl: asset.sourcePageUrl,
        method: "img",
        status: "eligible",
        assetId: asset.id,
      }),
    );
    manifest.imageSelection.productFamilyCoverage = [
      {
        familyId: "family-a",
        familyName: "产品族 A",
        officialImageAvailable: true,
        assetIds: ["asset-product-ui"],
        checkedSources: ["https://example.com/"],
      },
    ];
    const completeness = JSON.parse(
      String(files[`${root}/00_completeness.json`]),
    );
    completeness.acquisition.images = { completed: 3, total: 3 };
    files[`${root}/00_completeness.json`] = JSON.stringify(completeness);
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const archivePath = await writeArchive(files);
    const parsed = await readKnowledgeArchive(
      await fs.readFile(archivePath),
      "legacy-v3.zip",
      "33333333-3333-4333-8333-333333333333",
      {
        validationProfile: "dashboard-enterprise-v1",
        archiveContractVersions: [2],
      },
    );
    try {
      const packageLeaves = parsed.documents
        .filter((document) => document.kind === "leaf")
        .sort((left, right) => left.order! - right.order!);
      const nodes = packageLeaves.map((document, ordinal) => {
        const contentMarkdown = canonicalPackagedKnowledgeBaseLeafMarkdown(
          document.content,
        );
        return {
          leafId: document.id!,
          title: document.title,
          branchId: document.branchId!,
          branchTitle: document.branchTitle!,
          ordinal,
          status: "confirmed",
          contentMarkdown,
          contentSha256: knowledgeBaseMarkdownSha256(contentMarkdown),
        };
      });
      const logo = selectLegacyKnowledgeBaseLogoAsset({
        assets: parsed.assets,
      });
      expect(logo).toMatchObject({
        id: "asset-brand-logo",
        assetType: "brand_identity",
        displayRole: "badge",
      });
      expect(
        assertKnowledgeBasePackageMatchesBuild({
          nodes,
          documents: parsed.documents,
          assets: parsed.assets,
          expectedLogoSha256: logo.sha256!,
          legacyV3Compatibility: true,
        }),
      ).toMatchObject({ leafCount: 40, logoSha256: logo.sha256 });
    } finally {
      await removeStoredKnowledgeAssets(parsed.storedAssetKeys);
    }
  });

  it("accepts evidence-limited prose below the writing target without padding", async () => {
    const archivePath = await writeArchive(await validDeepArchiveFiles());

    const result = await runValidator(archivePath);

    expect(result.code).toBe(0);
  });

  it("does not reject customer-facing audit language based on semantics", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const semanticProse =
      "第一方页面摘录显示这些内容属于企业自我定义不宜直接转换为已量化达成的影响对客户而言可将其落实为可观察行动";
    files[`${root}/branches/products/leaf-1.md`] = `# 知识叶子 1

<!-- FRONTMIND_FORMAL_CONTENT_START -->

## 正式正文

${semanticProse}${"甲".repeat(80 - semanticProse.length)}

<!-- FRONTMIND_FORMAL_CONTENT_END -->

## 证据与核验

- source-official
`;
    const completeness = JSON.parse(
      String(files[`${root}/00_completeness.json`]),
    );
    completeness.gaps = [
      "本轮没有形成可逐项核验的证书名称与有效期，待企业补充。",
    ];
    files[`${root}/00_completeness.json`] = JSON.stringify(completeness);

    const result = await runValidator(await writeArchive(files));

    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("VALID dashboard-enterprise-v1"),
    });
  });

  it("rejects a rich evidence relationship reported as zero characters", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const overview = manifest.documents.find(
      (document: { id?: string }) => document.id === "overview-products",
    );
    overview.evidenceCharacters = 0;
    overview.requiredFormalCharacters = 60;
    overview.contentStatus = "needs_verification";
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "evidenceCharacters must equal validator-recomputed evidence characters 100",
    );
  });

  it("rejects a business visual in place of the official Logo", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    manifest.assets[0].assetType = "environment_photo";
    manifest.assets[0].displayRole = "hero";
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "official Logo must use brand_identity/badge",
    );
  });

  it("rejects evidence duplicated after normalization", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const duplicatePath = "branches/products/evidence/copied-overview.md";
    files[`${root}/${duplicatePath}`] = "证， ".repeat(100);
    manifest.documents.push({
      id: "evidence-copied-overview",
      path: duplicatePath,
      kind: "evidence",
      title: "复制产品综述证据",
      branchId: "products",
      sourceIds: ["source-official"],
      assetIds: [],
      customerVisible: false,
    });
    manifest.counts.totalFiles += 1;
    manifest.counts.evidenceCharacters += 100;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("duplicate normalized evidence content");
  });

  it("rejects acquired evidence omitted from every formal document", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const omittedPath = "branches/products/evidence/omitted.md";
    files[`${root}/${omittedPath}`] = "未".repeat(100);
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
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "v4 evidence document must be referenced by at least one overview/leaf",
    );
  });

  it("rejects referenced evidence without an explicit matching branchId", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    delete manifest.documents.find(
      (document: { id?: string }) =>
        document.id === "evidence-overview-products",
    ).branchId;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "must explicitly belong to the same branchId",
    );
  });

  it("uses productFamilyId instead of title keywords for product branches", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    for (const document of manifest.documents) {
      if (document.branchId === "products") document.branchId = "catalog-a";
      if (document.id === "overview-products") document.title = "核心目录";
    }
    for (const asset of manifest.assets) {
      if (asset.branchId === "products") asset.branchId = "catalog-a";
    }
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).toBe(0);
  });

  it("rejects a product branch with a partially declared family", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    delete manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    ).productFamilyId;
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "product/service branch leaf requires productFamilyId",
    );
  });

  it("rejects v2 without any product or service family", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    for (const document of manifest.documents) {
      delete document.productFamilyId;
    }
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "schema v4 must declare at least one product/service family",
    );
  });

  it("rejects a legacy snapshot-shaped archive without the v2 contracts", async () => {
    const archivePath = await writeArchive({
      "CompletenessReport.json": "{}",
      "leaves/identity.md": "# 企业身份\n\n第一方原始快照：这是一个页面摘录。",
    });

    const result = await runValidator(archivePath);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "missing required file: 00_package_manifest.json",
    );
    expect(result.stderr).toContain(
      "missing required file: 00_completeness.json",
    );
  });

  it("rejects a manifest that reports images but packages no image bytes", async () => {
    const manifest = {
      schemaVersion: 2,
      profile: "dashboard-enterprise-v1",
      documents: [],
      assets: [],
      counts: {
        totalFiles: 7,
        customerVisibleCharacters: 120000,
        evidenceCharacters: 0,
        packagedImages: 420,
      },
      imageSelection: {
        status: "target_met",
        discoveredCandidateImages: 420,
        inspectedCandidateImages: 420,
        eligibleFirstPartyImages: 420,
        rejectedCandidateImages: 0,
        scannedSourcePages: 1,
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
        rejectionReasons: [],
        stopReason: "已检查所有官方页面和资料",
      },
    };
    const archivePath = await writeArchive({
      "00_completeness.json": "{}",
      "00_package_manifest.json": JSON.stringify(manifest),
      "00_knowledge_tree.md": "# Tree",
      "00_crawl_coverage_report.md": "# Crawl",
      "00_web_intelligence_report.md": "# Web",
      "00_source_index.md": "# Sources",
      "00_media_gaps.md": "# Media",
    });

    const result = await runValidator(archivePath);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("manifest.counts.packagedImages must be 0");
  });

  it("rejects a header-only image that cannot be decoded", async () => {
    const files = await validDeepArchiveFiles();
    const root = "fixture_knowledge_base";
    const imagePath = "09_media_assets/header-only-logo.jpg";
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    delete files[`${root}/09_media_assets/brand-logo.png`];
    files[`${root}/${imagePath}`] = bytes;
    const manifest = JSON.parse(
      String(files[`${root}/00_package_manifest.json`]),
    );
    const firstLeaf = manifest.documents.find(
      (document: { id?: string }) => document.id === "leaf-1",
    );
    firstLeaf.assetIds = ["asset-header-only"];
    manifest.assets = [
      {
        id: "asset-header-only",
        path: imagePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/jpeg",
        bytes: bytes.length,
        width: 1,
        height: 1,
        caption: "伪图片",
        branchId: "products",
        documentIds: ["leaf-1"],
        sourcePageUrl: "https://example.com/",
        sourceAssetUrl: "https://example.com/assets/header-only.jpg",
        ownership: "first_party",
        assetType: "brand_identity",
        displayRole: "badge",
      },
    ];
    manifest.counts.packagedImages = 1;
    manifest.imageSelection = {
      status: "target_met",
      discoveredCandidateImages: 1,
      inspectedCandidateImages: 1,
      eligibleFirstPartyImages: 1,
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
      candidates: [
        {
          url: "https://example.com/assets/header-only.jpg",
          sourcePageUrl: "https://example.com/products",
          method: "img",
          status: "eligible",
          assetId: "asset-header-only",
        },
      ],
      rejectionReasons: [],
      stopReason: "已检查所有官方页面和资料",
    };
    files[`${root}/00_package_manifest.json`] = JSON.stringify(manifest);
    const completeness = JSON.parse(
      String(files[`${root}/00_completeness.json`]),
    );
    completeness.acquisition.images = { completed: 1, total: 1 };
    files[`${root}/00_completeness.json`] = JSON.stringify(completeness);

    const result = await runValidator(await writeArchive(files));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `could not decode a valid image for ${imagePath}`,
    );
  });
});
