import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildFinalizationSupplementShadowArchive,
  buildProviderSupplementedShadowArchive,
  knowledgePackageShadowStorageKey,
  persistKnowledgePackageShadow,
  removeKnowledgePackageShadow,
  validateProviderSupplementedShadowArchive,
} from "./knowledge-base-package-shadow";
import { buildPackageProjectionV1 } from "./knowledge-package-projection";

const buildId = "22222222-2222-4222-8222-222222222222";
let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
});

async function fixture() {
  const root = "company_knowledge_base";
  const leafBody = "# Leaf\n\nAuthoritative database body";
  const supplementBody = "# Overview\n\nProvider supplemental body";
  const assetBytes = Buffer.from("dashboard-asset-bytes");
  const assetSha = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(assetBytes).digest("hex"),
  );
  const documents = [
    {
      id: "leaf-1",
      path: "branch/leaf.md",
      kind: "leaf" as const,
      title: "Leaf",
      branchId: "branch",
      order: 0,
      sourceIds: ["source-1"],
      assetIds: ["asset-1"],
      customerVisible: true,
    },
    {
      id: "overview-1",
      path: "branch/overview.md",
      kind: "overview" as const,
      title: "Overview",
      branchId: "branch",
      order: 1,
      sourceIds: ["source-1"],
      assetIds: [],
      customerVisible: true,
    },
    ...(["evidence", "report", "index"] as const).map((kind, index) => ({
      id: `${kind}-1`,
      path: `branch/${kind}.md`,
      kind,
      title: kind[0]!.toUpperCase() + kind.slice(1),
      branchId: "branch",
      order: index + 2,
      sourceIds: ["source-1"],
      assetIds: [],
      customerVisible: kind !== "evidence",
    })),
  ];
  const asset = {
    id: "asset-1",
    path: "assets/logo.png",
    sha256: assetSha,
    mimeType: "image/png",
    bytes: assetBytes.length,
    width: 32,
    height: 16,
    branchId: "branch",
    documentIds: ["leaf-1"],
    sourceKind: "official_logo_upload" as const,
    ownership: "first_party" as const,
    assetType: "brand_identity" as const,
    displayRole: "badge" as const,
  };
  const zip = new JSZip();
  documents.forEach((document) => {
    zip.file(
      `${root}/${document.path}`,
      document.kind === "leaf"
        ? leafBody
        : document.kind === "overview"
          ? supplementBody
          : `# ${document.title}\n\nProvider ${document.kind} body`,
    );
  });
  zip.file(`${root}/${asset.path}`, assetBytes);
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      documents,
      assets: [asset],
      counts: {
        totalFiles: 4,
        customerVisibleCharacters: 100,
        evidenceCharacters: 0,
        packagedImages: 1,
      },
    }),
  );
  const providerArchiveBytes = await zip.generateAsync({ type: "nodebuffer" });
  const projection = await buildPackageProjectionV1({
    buildId,
    generation: 1,
    archiveBytes: providerArchiveBytes,
    validatedArchive: {
      validationProfile: "dashboard-enterprise-v1",
      packageSchemaVersion: 4,
      documents: documents.map((document, index) => ({
        ...document,
        path: `${root}/${document.path}`,
        content:
          index === 0
            ? leafBody
            : document.kind === "overview"
              ? supplementBody
              : `# ${document.title}\n\nProvider ${document.kind} body`,
      })),
      assets: [
        {
          ...asset,
          key: "validator-only",
          path: `${root}/${asset.path}`,
          size: asset.bytes,
        },
      ],
    },
  });
  return {
    projection,
    providerArchiveBytes,
    leafBody,
    supplementBody,
    assetBytes,
    validatedArchive: {
      validationProfile: "dashboard-enterprise-v1" as const,
      packageSchemaVersion: 4 as const,
      documents: documents.map((document, index) => ({
        ...document,
        path: `${root}/${document.path}`,
        content:
          index === 0
            ? leafBody
            : document.kind === "overview"
              ? supplementBody
              : `# ${document.title}\n\nProvider ${document.kind} body`,
      })),
      assets: [
        {
          ...asset,
          key: "validator-only",
          path: `${root}/${asset.path}`,
          size: asset.bytes,
        },
      ],
    },
  };
}

describe("provider-supplemented Shadow A packager", () => {
  it("repackages DB leaves and Dashboard assets while retaining supplemental documents", async () => {
    const value = await fixture();
    const shadow = await buildProviderSupplementedShadowArchive({
      projection: value.projection,
      providerArchiveBytes: value.providerArchiveBytes,
      serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
      dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
    });
    const zip = await JSZip.loadAsync(shadow.bytes, { checkCRC32: true });
    expect(
      await zip.file("company_knowledge_base/branch/leaf.md")?.async("string"),
    ).toBe(value.leafBody);
    expect(
      await zip
        .file("company_knowledge_base/branch/overview.md")
        ?.async("string"),
    ).toBe(value.supplementBody);
    expect(shadow.retainedSupplementDocumentIds).toEqual([
      "overview-1",
      "evidence-1",
      "report-1",
      "index-1",
    ]);
    await expect(
      validateProviderSupplementedShadowArchive({
        authoritativeProjection: value.projection,
        shadowArchiveBytes: shadow.bytes,
        validateArchive: async () => value.validatedArchive,
      }),
    ).resolves.toMatchObject({
      comparison: { equivalent: true, differences: [] },
    });
  });

  it("rebuilds Shadow B only from a complete narrow supplement contract", async () => {
    const value = await fixture();
    const records = value.projection.documents
      .filter(
        (document) =>
          document.kind === "overview" ||
          document.kind === "evidence" ||
          document.kind === "report" ||
          document.kind === "index",
      )
      .map((document) => ({
        kind: document.kind as "overview" | "evidence" | "report" | "index",
        id: document.id,
        title: document.title,
        branchId: document.branchId!,
        order: document.order ?? undefined,
        sourceIds: document.sourceIds,
        assetIds: document.assetIds,
        bodyMarkdown: document.bodyMarkdown,
      }));
    const shadow = await buildFinalizationSupplementShadowArchive({
      projection: value.projection,
      providerArchiveBytes: value.providerArchiveBytes,
      serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
      dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
      supplementRecords: records,
    });
    await expect(
      validateProviderSupplementedShadowArchive({
        authoritativeProjection: value.projection,
        shadowArchiveBytes: shadow.bytes,
        validateArchive: async () => value.validatedArchive,
      }),
    ).resolves.toMatchObject({ comparison: { equivalent: true } });

    await expect(
      buildFinalizationSupplementShadowArchive({
        projection: value.projection,
        providerArchiveBytes: value.providerArchiveBytes,
        serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
        dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
        supplementRecords: records.filter((record) => record.kind !== "index"),
      }),
    ).rejects.toThrow(/PACKAGE_SHADOW_SUPPLEMENT_INCOMPLETE/u);
  });

  it("does not count a rebuilt ZIP as evidence when full projection comparison diverges", async () => {
    const value = await fixture();
    const shadow = await buildProviderSupplementedShadowArchive({
      projection: value.projection,
      providerArchiveBytes: value.providerArchiveBytes,
      serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
      dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
    });
    const divergent = structuredClone(value.projection);
    divergent.statistics.formalCharacters += 1;
    await expect(
      validateProviderSupplementedShadowArchive({
        authoritativeProjection: divergent,
        shadowArchiveBytes: shadow.bytes,
        validateArchive: async () => value.validatedArchive,
      }),
    ).rejects.toThrow("PACKAGE_SHADOW_PROJECTION_DIVERGED");
  });

  it("fails closed on missing/divergent authority inputs", async () => {
    const value = await fixture();
    await expect(
      buildProviderSupplementedShadowArchive({
        projection: value.projection,
        providerArchiveBytes: value.providerArchiveBytes,
        serverLeafMarkdownById: new Map(),
        dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
      }),
    ).rejects.toThrow(/PACKAGE_SHADOW_LEAF_INPUT_INCOMPLETE/u);
    await expect(
      buildProviderSupplementedShadowArchive({
        projection: value.projection,
        providerArchiveBytes: value.providerArchiveBytes,
        serverLeafMarkdownById: new Map([["leaf-1", "changed"]]),
        dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
      }),
    ).rejects.toThrow(/PACKAGE_SHADOW_LEAF_DIVERGED/u);
  });

  it("persists only an operation-specific shadow key that is safe to delete", async () => {
    temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-package-shadow-"),
    );
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = temporaryRoot;
    const value = await fixture();
    const shadow = await buildProviderSupplementedShadowArchive({
      projection: value.projection,
      providerArchiveBytes: value.providerArchiveBytes,
      serverLeafMarkdownById: new Map([["leaf-1", value.leafBody]]),
      dashboardAssetBytesById: new Map([["asset-1", value.assetBytes]]),
    });
    const operationId = randomUUID();
    const persisted = await persistKnowledgePackageShadow({
      buildId,
      generation: 1,
      operationId,
      bytes: shadow.bytes,
    });
    expect(persisted.storageKey).toBe(
      knowledgePackageShadowStorageKey({
        buildId,
        generation: 1,
        operationId,
        archiveSha256: persisted.archiveSha256,
      }),
    );
    expect(persisted.storageKey.startsWith("knowledge-shadows/")).toBe(true);
    expect(persisted.storageKey).not.toContain("knowledge-builds");
    await removeKnowledgePackageShadow({
      buildId,
      generation: 1,
      operationId,
      archiveSha256: persisted.archiveSha256,
    });
  });
});
