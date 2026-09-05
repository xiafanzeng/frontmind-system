import { describe, expect, it } from "vitest";

import type { PackageProjectionV1 } from "./knowledge-package-projection";
import {
  assertKnowledgeBaseFinalizationPreviewCurrent,
  buildKnowledgeBaseFinalizationPreview,
} from "./knowledge-base-finalization-preview";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function projection(): PackageProjectionV1 {
  const kinds = ["leaf", "overview", "evidence", "report", "index"] as const;
  return {
    kind: "frontmind.knowledge-package-projection",
    schemaVersion: 1,
    buildId: "11111111-1111-4111-8111-111111111111",
    generation: 2,
    archiveSha256: SHA_A,
    packageSchemaVersion: 4,
    documents: kinds.map((kind, order) => ({
      id: `document-${kind}`,
      kind,
      path: `documents/${kind}.md`,
      title: `${kind} title`,
      branchId: "branch-a",
      branchTitle: "Branch A",
      order,
      bodyMarkdown: `# ${kind}\n\nComplete ${kind} body`,
      bodySha256: SHA_B,
      sourceIds: [`source-${kind}`],
      assetIds: kind === "leaf" ? ["asset-logo"] : [],
      evidenceDocumentIds: kind === "leaf" ? ["document-evidence"] : [],
      customerVisible: kind !== "evidence",
    })),
    assets: [
      {
        id: "asset-logo",
        path: "assets/logo.png",
        sha256: SHA_A,
        mimeType: "image/png",
        bytes: 128,
        width: 64,
        height: 32,
        branchId: "branch-a",
        documentIds: ["document-leaf"],
        sourceKind: "official_logo_upload",
        ownership: "first_party",
        assetType: "brand_identity",
        displayRole: "badge",
        sourcePageUrl: null,
        sourceAssetUrl: null,
        sourceDocumentPath: null,
        sourceUploadIndex: 0,
        sourceUploadFileId: "file-logo",
        sourceUploadSha256: SHA_A,
        sourceUploadFilename: "logo.png",
        sourceUploadMimeType: "image/png",
        sourceUploadSizeBytes: 128,
      },
    ],
    statistics: {
      formalCharacters: 56_418,
      evidenceCharacters: 615,
      imageCount: 1,
    },
    semanticFingerprint: SHA_B,
  };
}

describe("knowledge-base finalization preview", () => {
  it("includes the complete package without a storage key or model hotlink", () => {
    const preview = buildKnowledgeBaseFinalizationPreview({
      projection: projection(),
      revision: 7,
    });
    expect(preview.documents.map((document) => document.kind)).toEqual([
      "leaf",
      "overview",
      "evidence",
      "report",
      "index",
    ]);
    expect(preview.statistics.formalCharacters).toBe(56_418);
    expect(preview).not.toHaveProperty("storageKey");
    expect(preview.assets[0]).not.toHaveProperty("url");
  });

  it.each([
    ["revision", { revision: 8 }],
    ["generation", { generation: 3 }],
    ["archive", { archiveSha256: SHA_B }],
    ["projection", { packageSemanticFingerprint: SHA_A }],
  ])("invalidates after a %s change", (_label, change) => {
    const preview = buildKnowledgeBaseFinalizationPreview({
      projection: projection(),
      revision: 7,
    });
    expect(() =>
      assertKnowledgeBaseFinalizationPreviewCurrent({
        preview,
        current: {
          buildId: preview.buildId,
          generation: preview.generation,
          revision: preview.revision,
          archiveSha256: preview.archiveSha256,
          packageSemanticFingerprint: preview.packageSemanticFingerprint,
          ...change,
        },
      }),
    ).toThrow("FINALIZATION_PREVIEW_STALE");
  });

  it("accepts only the exact build generation, revision and archive projection", () => {
    const preview = buildKnowledgeBaseFinalizationPreview({
      projection: projection(),
      revision: 7,
    });
    expect(
      assertKnowledgeBaseFinalizationPreviewCurrent({
        preview,
        current: {
          buildId: preview.buildId,
          generation: preview.generation,
          revision: preview.revision,
          archiveSha256: preview.archiveSha256,
          packageSemanticFingerprint: preview.packageSemanticFingerprint,
        },
      }),
    ).toStrictEqual(preview);
  });

  it("refuses an incomplete preview instead of hiding omitted report content", () => {
    const incomplete = projection();
    incomplete.documents = incomplete.documents.filter(
      (document) => document.kind !== "report",
    );
    expect(() =>
      buildKnowledgeBaseFinalizationPreview({
        projection: incomplete,
        revision: 7,
      }),
    ).toThrow("FINALIZATION_PREVIEW_INCOMPLETE:report");
  });
});
