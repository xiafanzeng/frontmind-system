import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeAsset, KnowledgeDocument } from "../shared/dashboard";
import {
  buildPackageProjectionV1,
  comparePackageProjections,
  packageProjectionCoverage,
  packageProjectionStorageKey,
  persistPackageProjectionSidecar,
  readPackageProjectionSidecar,
  recordPackageProjectionShadow,
  removePackageProjectionSidecar,
} from "./knowledge-package-projection";

const BUILD_ID = "11111111-1111-4111-8111-111111111111";
const root = "company_knowledge_base";
const kinds = ["leaf", "overview", "evidence", "report", "index"] as const;
let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
});

async function fixture(date = new Date("2026-08-06T00:00:00.000Z")) {
  const documentMetadata = kinds.map((kind, order) => ({
    id: `document-${kind}`,
    path: `documents/${kind}.md`,
    kind,
    title: `${kind} title`,
    branchId: "branch-a",
    branchTitle: "Branch A",
    order,
    sourceIds: [`source-${kind}`],
    assetIds: kind === "leaf" ? ["asset-logo"] : [],
    evidenceDocumentIds: kind === "leaf" ? ["document-evidence"] : [],
    customerVisible: kind !== "evidence",
  }));
  const assetBytes = Buffer.from("validated-image-byte-fixture");
  const assetSha = createHash("sha256").update(assetBytes).digest("hex");
  const assetMetadata = {
    id: "asset-logo",
    path: "assets/logo.png",
    sha256: assetSha,
    mimeType: "image/png",
    bytes: assetBytes.length,
    width: 64,
    height: 32,
    branchId: "branch-a",
    documentIds: ["document-leaf"],
    sourceKind: "official_logo_upload",
    sourceUploadIndex: 0,
    sourceUploadFileId: "file-logo",
    sourceUploadSha256: assetSha,
    sourceUploadFilename: "logo.png",
    sourceUploadMimeType: "image/png",
    sourceUploadSizeBytes: assetBytes.length,
    ownership: "first_party",
    assetType: "brand_identity",
    displayRole: "badge",
  } as const;
  const zip = new JSZip();
  for (const document of documentMetadata) {
    zip.file(
      `${root}/${document.path}`,
      `# ${document.title}\n\n${document.kind} body`,
      {
        date,
      },
    );
  }
  zip.file(`${root}/${assetMetadata.path}`, assetBytes, { date });
  zip.file(
    `${root}/00_package_manifest.json`,
    JSON.stringify({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      documents: documentMetadata,
      assets: [assetMetadata],
      counts: {
        totalFiles: documentMetadata.length + 2,
        customerVisibleCharacters: 56_418,
        evidenceCharacters: 615,
        packagedImages: 1,
      },
    }),
    { date },
  );
  const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
  const documents: KnowledgeDocument[] = documentMetadata.map((document) => ({
    ...document,
    path: `${root}/${document.path}`,
    content: `${document.kind} validated body`,
  }));
  const assets: KnowledgeAsset[] = [
    {
      id: assetMetadata.id,
      key: "temporary-validator-key",
      path: `${root}/${assetMetadata.path}`,
      mimeType: assetMetadata.mimeType,
      size: assetMetadata.bytes,
      sha256: assetMetadata.sha256,
      width: assetMetadata.width,
      height: assetMetadata.height,
      branchId: assetMetadata.branchId,
      documentIds: [...assetMetadata.documentIds],
      sourceKind: assetMetadata.sourceKind,
      sourceUploadIndex: assetMetadata.sourceUploadIndex,
      sourceUploadFileId: assetMetadata.sourceUploadFileId,
      sourceUploadSha256: assetMetadata.sourceUploadSha256,
      sourceUploadFilename: assetMetadata.sourceUploadFilename,
      sourceUploadMimeType: assetMetadata.sourceUploadMimeType,
      sourceUploadSizeBytes: assetMetadata.sourceUploadSizeBytes,
      ownership: assetMetadata.ownership,
      assetType: assetMetadata.assetType,
      displayRole: assetMetadata.displayRole,
    },
  ];
  return {
    archiveBytes,
    validatedArchive: {
      documents,
      assets,
      validationProfile: "dashboard-enterprise-v1",
      packageSchemaVersion: 4,
    },
  };
}

describe("PackageProjectionV1", () => {
  it("retains every document kind, relations, actual assets and formal statistics", async () => {
    const projection = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 3,
      ...(await fixture()),
    });
    expect(projection.documents.map((document) => document.kind)).toEqual(
      kinds,
    );
    expect(projection.documents[0]).toMatchObject({
      id: "document-leaf",
      assetIds: ["asset-logo"],
      evidenceDocumentIds: ["document-evidence"],
    });
    expect(projection.assets[0]).toMatchObject({
      id: "asset-logo",
      sourceKind: "official_logo_upload",
      width: 64,
      height: 32,
    });
    expect(projection.statistics).toEqual({
      formalCharacters: 56_418,
      evidenceCharacters: 615,
      imageCount: 1,
    });
    expect(packageProjectionCoverage(projection)).toEqual({
      complete: true,
      missingKinds: [],
    });
  });

  it("produces the same semantic fingerprint despite different ZIP metadata", async () => {
    const left = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 1,
      ...(await fixture(new Date("2026-08-06T00:00:00.000Z"))),
    });
    const right = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 1,
      ...(await fixture(new Date("2026-08-07T00:00:00.000Z"))),
    });
    expect(left.archiveSha256).not.toBe(right.archiveSha256);
    expect(left.semanticFingerprint).toBe(right.semanticFingerprint);
    expect(comparePackageProjections(left, right)).toMatchObject({
      equivalent: true,
    });
  });

  it("compares canonical document hashes instead of preview markdown bytes", async () => {
    const left = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 1,
      ...(await fixture()),
    });
    const right = structuredClone(left);
    right.documents[0]!.bodyMarkdown = `${right.documents[0]!.bodyMarkdown.replaceAll(
      "\n",
      "\r\n",
    )}   `;

    expect(right.documents[0]!.bodySha256).toBe(left.documents[0]!.bodySha256);
    expect(comparePackageProjections(left, right)).toMatchObject({
      equivalent: true,
      differences: [],
    });
  });

  it("stores only a rebuildable projection cache and never an official package key", async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "frontmind-projection-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = temporaryRoot;
    const projection = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 4,
      ...(await fixture()),
    });
    const key = await persistPackageProjectionSidecar(projection);
    expect(key).toBe(
      packageProjectionStorageKey({
        buildId: BUILD_ID,
        generation: 4,
        archiveSha256: projection.archiveSha256,
      }),
    );
    expect(key.startsWith("knowledge-projections/")).toBe(true);
    expect(key).not.toContain("knowledge-builds");
    expect(
      (await readPackageProjectionSidecar(projection)).semanticFingerprint,
    ).toBe(projection.semanticFingerprint);
    await removePackageProjectionSidecar(projection);
    expect(await readdir(temporaryRoot, { recursive: true })).not.toContain(
      "knowledge-base.zip",
    );
  });

  it("reports missing supplemental document kinds rather than silently accepting loss", async () => {
    const projection = await buildPackageProjectionV1({
      buildId: BUILD_ID,
      generation: 1,
      ...(await fixture()),
    });
    const incomplete = {
      ...projection,
      documents: projection.documents.filter(
        (document) => document.kind !== "report",
      ),
    };
    expect(packageProjectionCoverage(incomplete)).toEqual({
      complete: false,
      missingKinds: ["report"],
    });
  });

  it("keeps the live projection hook default-on, kill-switchable and failure-isolated", async () => {
    const value = await fixture();
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "frontmind-projection-"));
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = temporaryRoot;
    await expect(
      recordPackageProjectionShadow({
        buildId: BUILD_ID,
        generation: 1,
        ...value,
        environment: {},
      }),
    ).resolves.toMatchObject({ status: "recorded" });
    await expect(
      recordPackageProjectionShadow({
        buildId: BUILD_ID,
        generation: 1,
        ...value,
        environment: {
          FRONTMIND_KB_PACKAGE_PROJECTION_SHADOW: "disabled",
        },
      }),
    ).resolves.toEqual({ status: "disabled" });

    const observations: string[] = [];
    await expect(
      recordPackageProjectionShadow({
        buildId: BUILD_ID,
        generation: 1,
        archiveBytes: Buffer.from("invalid archive"),
        validatedArchive: value.validatedArchive,
        environment: {},
        report: (observation) => observations.push(observation.ruleCode),
      }),
    ).resolves.toEqual({ status: "failed" });
    expect(observations).toEqual(["package_projection_failed"]);
  });
});
