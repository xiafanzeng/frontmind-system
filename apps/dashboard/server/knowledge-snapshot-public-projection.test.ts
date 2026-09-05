import { describe, expect, it } from "vitest";

import { toKnowledgeSnapshotPublicJson } from "./dashboard-service";

describe("knowledge snapshot public JSON", () => {
  it("projects customer text and URLs without exposing publication metadata", () => {
    const privateBrand = ["Ma", "nus"].join("");
    const snapshot = toKnowledgeSnapshotPublicJson(
      {
        id: "snapshot-1",
        userId: 42,
        version: 7,
        sourceFileName: `${privateBrand}_V2_export.zip`,
        sourceTaskId: `${privateBrand.toLowerCase()}-task-private`,
        archiveHash: "a".repeat(64),
        documents: [
          {
            id: "doc-1",
            path: `${privateBrand}/node.md`,
            title: `${privateBrand} 节点`,
            content: `${privateBrand.toUpperCase()}_V2_TASK https://open.${privateBrand.toLowerCase()}.ai/task/1`,
            historicalMetadata: {
              notice: `${privateBrand.toUpperCase()}_V2_INTERNAL_NOTICE`,
            },
            sourceIds: [
              `https://api.${privateBrand.toLowerCase()}.ai/source`,
              "https://frontmind.net/source",
            ],
            assetIds: ["raw-private-asset-id", "missing-private-asset-id"],
          },
        ],
        documentCount: 1,
        imageCount: 1,
        characterCount: 20,
        totalBytes: 100,
        assets: [
          {
            id: "raw-private-asset-id",
            key: "private/storage/clinic-reception.jpg",
            path: "working-set/assets/clinic-reception.jpg",
            mimeType: "image/png",
            size: 10,
            width: 800,
            height: 600,
            sha256: "c".repeat(64),
            caption: "医院接待区（clinic-reception.jpg）",
            alt: "images/clinic-reception.jpg",
            documentIds: ["doc-1"],
            sourceKind: "official_web",
            ownership: "first_party",
            assetType: "environment_photo",
            displayRole: "inline",
            sourcePageUrl: "https://frontmind.net/clinic",
            sourceAssetUrl: `https://cdn.${privateBrand.toLowerCase()}.ai/logo.png`,
            sourceDocumentPath: "uploads/企业画册.pdf",
            sourceUploadFilename: "clinic-reception.jpg",
            sourceUploadFileId: `${privateBrand.toLowerCase()}-file-private`,
            sourceUploadSha256: "b".repeat(64),
            sourceUploadMimeType: `image/${privateBrand.toLowerCase()}`,
            provenance: { archivePath: "private/clinic-reception.jpg" },
            storageKey: "private-storage-key",
          },
        ],
        status: "active" as const,
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
      },
      true,
    );

    expect(JSON.stringify(snapshot)).not.toMatch(/manus/iu);
    expect(snapshot).not.toHaveProperty("userId");
    expect(snapshot).not.toHaveProperty("sourceTaskId");
    expect(snapshot.documents[0]?.sourceIds).toEqual([
      "https://frontmind.net/source",
    ]);
    expect(snapshot.documents[0]?.assetIds).toEqual(["public-asset-1"]);
    expect(snapshot.assets[0]).toEqual({
      id: "public-asset-1",
      key: "public-asset-1",
      path: "assets/public-asset-1",
      mimeType: "image/png",
      size: 10,
      width: 800,
      height: 600,
      caption: "医院接待区",
      documentIds: ["doc-1"],
      sourceKind: "official_web",
      ownership: "first_party",
      assetType: "environment_photo",
      displayRole: "inline",
      sourcePageUrl: "https://frontmind.net/clinic",
      url: "/api/dashboard/knowledge/assets/snapshot-1/0",
    });
    expect(JSON.stringify(snapshot.assets[0])).not.toMatch(
      /clinic-reception|private-storage|sourceAssetUrl|sourceDocumentPath|sourceUpload|provenance|sha256/iu,
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /raw-private-asset-id|missing-private-asset-id/iu,
    );
  });
});
