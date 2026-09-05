import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";

const dependencies = vi.hoisted(() => ({
  readStoredPresalesFile: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("./presales-file-store", () => ({
  readStoredPresalesFile: dependencies.readStoredPresalesFile,
}));
vi.mock("./db", () => ({ getDb: dependencies.getDb }));

import {
  assertCapturedKnowledgeBaseCustomerImage,
  assertKnowledgeBaseCustomerUploadVisualBindings,
  knowledgeBaseExpectedCustomerUploadsFromTurns,
  knowledgeBaseCustomerUploadImagesFromTurn,
  knowledgeBaseCustomerUploadResources,
  verifiedKnowledgeBaseOfficialLogoUploadForBuild,
} from "./knowledge-base-customer-upload";

function capturedImageTurn(overrides: Record<string, unknown> = {}) {
  const sha256 = "a".repeat(64);
  return {
    id: "turn-customer-image",
    expectedLeafId: "1.2",
    attachmentFileIds: ["file-customer-image"],
    status: "completed" as const,
    metadata: {
      attachmentsFrozen: true,
      userAttachmentCount: 1,
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          {
            file_id: "file-customer-image",
            filename: "customer-proof.jpg",
          },
        ],
        attachmentManifest: [
          {
            filename: "customer-proof.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1234,
            sha256,
          },
        ],
      },
      preparedDispatch: {
        requestBody: {
          attachments: [
            {
              file_id: "file-customer-image",
              filename: "customer-proof.jpg",
            },
          ],
        },
      },
      // Provider and crawler fields are intentionally ignored.
      imageUrls: ["https://crawler.invalid/not-customer.jpg"],
      ...overrides,
    },
  };
}

describe("knowledge-base customer upload provenance", () => {
  it("projects only a byte-verified captured browser image", async () => {
    const turn = capturedImageTurn();
    dependencies.readStoredPresalesFile.mockResolvedValueOnce({
      filename: "customer-proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      sha256: "a".repeat(64),
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([
      expect.objectContaining({
        turnId: "turn-customer-image",
        leafId: "1.2",
        fileId: "file-customer-image",
        filename: "customer-proof.jpg",
        sourceSha256: "a".repeat(64),
      }),
    ]);
    await expect(
      knowledgeBaseCustomerUploadResources("build-1", turn),
    ).resolves.toEqual([
      {
        kind: "customer_upload",
        outputItemId: null,
        fileId: null,
        sameOriginUrl:
          "/api/knowledge-base/artifacts/build-1/customer-uploads/turn-customer-image/0/" +
          "a".repeat(64),
        filename: "customer-proof.jpg",
        mimeType: "image/jpeg",
        sha256: "a".repeat(64),
        sizeBytes: 1234,
      },
    ]);
  });

  it("excludes a verified recovery officialLogoUpload from the ordinary customer-upload manifest", () => {
    const turn = capturedImageTurn({
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          {
            file_id: "file-customer-image",
            filename: "customer-proof.jpg",
          },
        ],
        attachmentManifest: [
          {
            filename: "customer-proof.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
        officialLogoUpload: {
          verified: true,
          index: 0,
          fileId: "file-customer-image",
          filename: "customer-proof.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1234,
          sourceSha256: "a".repeat(64),
        },
      },
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([]);
    expect(knowledgeBaseExpectedCustomerUploadsFromTurns([turn])).toEqual([]);
  });

  it("does not exclude an unverified recovery officialLogoUpload declaration", () => {
    const turn = capturedImageTurn({
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          {
            file_id: "file-customer-image",
            filename: "customer-proof.jpg",
          },
        ],
        attachmentManifest: [
          {
            filename: "customer-proof.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
        officialLogoUpload: {
          verified: false,
          index: 0,
          fileId: "file-customer-image",
          filename: "customer-proof.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1234,
          sourceSha256: "a".repeat(64),
        },
      },
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([
      expect.objectContaining({
        fileId: "file-customer-image",
        sourceSha256: "a".repeat(64),
      }),
    ]);
  });

  it("excludes the bound official Logo hash from every later ordinary upload", () => {
    const turn = capturedImageTurn();
    expect(
      knowledgeBaseExpectedCustomerUploadsFromTurns([turn], {
        excludedSourceSha256: "a".repeat(64),
      }),
    ).toEqual([]);
  });

  it("keeps the verified Logo ledger usable after its temporary upload copy expires", async () => {
    const turn = capturedImageTurn({
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          {
            file_id: "file-customer-image",
            filename: "customer-proof.jpg",
          },
        ],
        attachmentManifest: [
          {
            filename: "customer-proof.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
        officialLogoUpload: {
          verified: true,
          index: 0,
          fileId: "file-customer-image",
          filename: "customer-proof.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1234,
          sourceSha256: "a".repeat(64),
        },
      },
    });
    dependencies.readStoredPresalesFile.mockClear();
    dependencies.getDb.mockResolvedValueOnce({
      select() {
        return {
          from() {
            return {
              async where() {
                return [turn];
              },
            };
          },
        };
      },
    });

    await expect(
      verifiedKnowledgeBaseOfficialLogoUploadForBuild({
        userId: 7,
        buildId: "build-1",
        generation: 1,
      }),
    ).resolves.toMatchObject({
      fileId: "file-customer-image",
      sourceSha256: "a".repeat(64),
    });
    expect(dependencies.readStoredPresalesFile).not.toHaveBeenCalled();
  });

  it("fails closed when a declared customer image no longer matches local bytes", async () => {
    const turn = capturedImageTurn();
    dependencies.readStoredPresalesFile.mockResolvedValueOnce({
      filename: "customer-proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      sha256: "b".repeat(64),
    });

    await expect(
      knowledgeBaseCustomerUploadResources("build-1", turn),
    ).rejects.toThrow("受管原始字节缺失或完整性不一致");
  });

  it("fails closed when a completed captured-image ledger loses its dispatch binding", async () => {
    dependencies.readStoredPresalesFile.mockClear();
    const turn = capturedImageTurn({
      preparedDispatch: { requestBody: { attachments: [] } },
    });

    expect(() => knowledgeBaseExpectedCustomerUploadsFromTurns([turn])).toThrow(
      "客户上传附件账本绑定不完整",
    );
    await expect(
      knowledgeBaseCustomerUploadResources("build-1", turn),
    ).rejects.toThrow("客户上传附件账本绑定不完整");
    expect(dependencies.readStoredPresalesFile).not.toHaveBeenCalled();
  });

  it("ignores a valid PDF while strictly retaining the image in a mixed turn", () => {
    const turn = capturedImageTurn({
      userAttachmentCount: 2,
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-evidence", filename: "evidence.pdf" },
          { file_id: "file-customer-image", filename: "customer-proof.jpg" },
        ],
        attachmentManifest: [
          {
            filename: "evidence.pdf",
            mimeType: "application/pdf",
            sizeBytes: 321,
            sha256: "c".repeat(64),
          },
          {
            filename: "customer-proof.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
      },
      preparedDispatch: {
        requestBody: {
          attachments: [
            { file_id: "file-evidence", filename: "evidence.pdf" },
            {
              file_id: "file-customer-image",
              filename: "customer-proof.jpg",
            },
          ],
        },
      },
    });
    turn.attachmentFileIds = ["file-evidence", "file-customer-image"];

    expect(knowledgeBaseExpectedCustomerUploadsFromTurns([turn])).toEqual([
      expect.objectContaining({
        sourceSha256: "a".repeat(64),
        filenames: ["customer-proof.jpg"],
      }),
    ]);
  });

  it("ignores non-image attachments even if a crawler field contains an image URL", () => {
    const turn = capturedImageTurn({
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-customer-image", filename: "evidence.pdf" },
        ],
        attachmentManifest: [
          {
            filename: "evidence.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
      },
      preparedDispatch: {
        requestBody: {
          attachments: [
            { file_id: "file-customer-image", filename: "evidence.pdf" },
          ],
        },
      },
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([]);
  });

  it("recovers a canonical image MIME from a trusted image filename", () => {
    const turn = capturedImageTurn({
      recovery: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-customer-image", filename: "customer-proof.svg" },
        ],
        attachmentManifest: [
          {
            filename: "customer-proof.svg",
            mimeType: "application/octet-stream",
            sizeBytes: 1234,
            sha256: "a".repeat(64),
          },
        ],
      },
      preparedDispatch: {
        requestBody: {
          attachments: [
            { file_id: "file-customer-image", filename: "customer-proof.svg" },
          ],
        },
      },
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([
      expect.objectContaining({
        filename: "customer-proof.svg",
        mimeType: "image/svg+xml",
      }),
    ]);
  });

  it("rejects active SVG bytes even when the filename and MIME claim PNG", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://169.254.169.254/latest/meta-data"/></svg>',
    );
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    dependencies.readStoredPresalesFile.mockResolvedValueOnce({
      filename: "customer-proof.png",
      mimeType: "image/png",
      sizeBytes: source.length,
      sha256: sourceSha256,
      createReadStream: () => Readable.from(source),
    });

    await expect(
      assertCapturedKnowledgeBaseCustomerImage({
        fileId: "file-customer-image",
        filename: "customer-proof.png",
        mimeType: "image/png",
        sizeBytes: source.length,
        sourceSha256,
      }),
    ).rejects.toThrow("客户 SVG 含主动内容");
  });

  it("rejects an SVG above the same 10 MB limit used by history preview", async () => {
    const prefix = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!--',
    );
    const suffix = Buffer.from('--><rect width="10" height="10"/></svg>');
    const source = Buffer.concat([
      prefix,
      Buffer.alloc(10 * 1024 * 1024 + 1 - prefix.length - suffix.length, 32),
      suffix,
    ]);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    dependencies.readStoredPresalesFile.mockResolvedValueOnce({
      filename: "large.svg",
      mimeType: "image/svg+xml",
      sizeBytes: source.length,
      sha256: sourceSha256,
      createReadStream: () => Readable.from(source),
    });

    await expect(
      assertCapturedKnowledgeBaseCustomerImage({
        fileId: "file-large-svg",
        filename: "large.svg",
        mimeType: "image/svg+xml",
        sizeBytes: source.length,
        sourceSha256,
      }),
    ).rejects.toThrow("超过 10 MB 安全预览上限");
  });

  it("proves a packaged SVG raster still renders the captured upload", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#73518d"/></svg>',
    );
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const packaged = await sharp(source, { density: 144 }).png().toBuffer();
    dependencies.readStoredPresalesFile.mockResolvedValue({
      filename: "customer-proof.svg",
      mimeType: "image/svg+xml",
      sizeBytes: source.length,
      sha256: sourceSha256,
      createReadStream: () => Readable.from(source),
    });
    const expectedUploads = [
      {
        sourceSha256,
        leafIds: ["1.2"],
        filenames: ["customer-proof.svg"],
        mimeTypes: ["image/svg+xml"],
        fileIds: ["file-customer-image"],
      },
    ];
    const assets = [
      {
        key: "customer-proof.png",
        path: "09_media_assets/customer-proof.png",
        mimeType: "image/png",
        size: packaged.length,
        sourceKind: "user_upload" as const,
        sourceUploadSha256: sourceSha256,
        sourceUploadFilename: "customer-proof.svg",
        sourceUploadMimeType: "image/svg+xml",
      },
    ];

    await expect(
      assertKnowledgeBaseCustomerUploadVisualBindings({
        assets,
        expectedUploads,
        readPackagedAssetBytes: async () => packaged,
      }),
    ).resolves.toBeUndefined();

    const substituted = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: "#19544a",
      },
    })
      .png()
      .toBuffer();
    await expect(
      assertKnowledgeBaseCustomerUploadVisualBindings({
        assets,
        expectedUploads,
        readPackagedAssetBytes: async () => substituted,
      }),
    ).rejects.toThrow("渲染内容不一致");
  });

  it("accepts a visually equivalent compressed raster for a large safe source", async () => {
    const source = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: "#73518d",
      },
    })
      .jpeg({ quality: 96 })
      .toBuffer();
    const packaged = await sharp(source).webp({ quality: 82 }).toBuffer();
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    dependencies.readStoredPresalesFile.mockResolvedValue({
      filename: "customer-proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: source.length,
      sha256: sourceSha256,
      createReadStream: () => Readable.from(source),
    });

    await expect(
      assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: [
          {
            key: "customer-proof.webp",
            path: "09_media_assets/customer-proof.webp",
            mimeType: "image/webp",
            size: packaged.length,
            sha256: createHash("sha256").update(packaged).digest("hex"),
            sourceKind: "user_upload",
            sourceUploadSha256: sourceSha256,
            sourceUploadFilename: "customer-proof.jpg",
            sourceUploadMimeType: "image/jpeg",
          },
        ],
        expectedUploads: [
          {
            sourceSha256,
            leafIds: ["1.2"],
            filenames: ["customer-proof.jpg"],
            mimeTypes: ["image/jpeg"],
            fileIds: ["file-customer-image"],
          },
        ],
        readPackagedAssetBytes: async () => packaged,
      }),
    ).resolves.toBeUndefined();
  });

  it("recomputes local bytes even when the package claims an exact raster copy", async () => {
    const expectedBytes = Buffer.from("expected-image-bytes");
    const corruptedBytes = Buffer.from("corrupt!-image-bytes");
    expect(corruptedBytes).toHaveLength(expectedBytes.length);
    const sourceSha256 = createHash("sha256")
      .update(expectedBytes)
      .digest("hex");
    dependencies.readStoredPresalesFile.mockResolvedValue({
      filename: "customer-proof.png",
      mimeType: "image/png",
      sizeBytes: corruptedBytes.length,
      // Simulate a stale manifest whose size/hash still claim the old file.
      sha256: sourceSha256,
      createReadStream: () => Readable.from(corruptedBytes),
    });

    await expect(
      assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: [
          {
            key: "customer-proof.png",
            path: "09_media_assets/customer-proof.png",
            mimeType: "image/png",
            size: expectedBytes.length,
            sha256: sourceSha256,
            sourceKind: "user_upload",
            sourceUploadSha256: sourceSha256,
            sourceUploadFilename: "customer-proof.png",
            sourceUploadMimeType: "image/png",
          },
        ],
        expectedUploads: [
          {
            sourceSha256,
            leafIds: ["1.2"],
            filenames: ["customer-proof.png"],
            mimeTypes: ["image/png"],
            fileIds: ["file-customer-image"],
          },
        ],
        readPackagedAssetBytes: async () => expectedBytes,
      }),
    ).rejects.toThrow("原始哈希不一致");
  });
});
