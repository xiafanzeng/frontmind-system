import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  knowledgeBaseOfficialLogoUploadFromTurn,
  persistedKnowledgeBaseCustomerUploadBytesForBuild,
  verifiedKnowledgeBasePackageUploadEvidenceForBuild,
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
  it("seals final upload evidence so source expiry cannot break publish, download or display", async () => {
    const assetRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-kb-upload-evidence-"),
    );
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
    const bytes = Buffer.from("durable-customer-image-bytes");
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const packageArchiveSha256 = "b".repeat(64);
    const retriedPackageArchiveSha256 = "c".repeat(64);
    const buildId = "10000000-0000-4000-8000-000000000099";
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
            sizeBytes: bytes.length,
            sha256: sourceSha256,
          },
        ],
      },
    });
    dependencies.getDb.mockResolvedValue({
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [turn];
                  },
                };
              },
            };
          },
        };
      },
    });
    dependencies.readStoredPresalesFile.mockResolvedValue({
      filename: "customer-proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.length,
      sha256: sourceSha256,
      createReadStream: () => Readable.from(bytes),
    });

    try {
      const first = await verifiedKnowledgeBasePackageUploadEvidenceForBuild({
        userId: 7,
        buildId,
        generation: 1,
        packageArchiveSha256,
      });
      expect(first.expectedCustomerUploads).toEqual([
        expect.objectContaining({ sourceSha256, leafIds: ["1.2"] }),
      ]);

      // Simulate the 30-day presales object expiring after final binding.
      dependencies.readStoredPresalesFile.mockReset();
      dependencies.readStoredPresalesFile.mockResolvedValue(null);
      dependencies.getDb.mockClear();

      await expect(
        verifiedKnowledgeBasePackageUploadEvidenceForBuild({
          userId: 7,
          buildId,
          generation: 1,
          packageArchiveSha256,
        }),
      ).resolves.toEqual(first);
      const retried = await verifiedKnowledgeBasePackageUploadEvidenceForBuild({
        userId: 7,
        buildId,
        generation: 1,
        packageArchiveSha256: retriedPackageArchiveSha256,
      });
      expect(retried).toEqual(first);
      expect(dependencies.getDb).toHaveBeenCalled();
      dependencies.getDb.mockClear();
      await expect(
        persistedKnowledgeBaseCustomerUploadBytesForBuild({
          userId: 7,
          buildId,
          generation: 1,
          packageArchiveSha256,
          sourceSha256,
        }),
      ).resolves.toEqual(bytes);
      await expect(
        persistedKnowledgeBaseCustomerUploadBytesForBuild({
          userId: 7,
          buildId,
          generation: 1,
          packageArchiveSha256: retriedPackageArchiveSha256,
          sourceSha256,
        }),
      ).resolves.toEqual(bytes);
      await expect(
        knowledgeBaseCustomerUploadResources(buildId, turn, {
          persistedEvidence: {
            userId: 7,
            generation: 1,
            packageArchiveSha256,
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "customer_upload",
          caption: "知识库配图",
          mimeType: "image/jpeg",
          sameOriginUrl: expect.stringMatching(
            /^\/api\/knowledge-base\/artifacts\/resources\//u,
          ),
        }),
      ]);
      expect(dependencies.getDb).not.toHaveBeenCalled();
      expect(dependencies.readStoredPresalesFile).not.toHaveBeenCalled();

      await expect(
        persistedKnowledgeBaseCustomerUploadBytesForBuild({
          userId: 7,
          buildId: "10000000-0000-4000-8000-000000000098",
          generation: 1,
          packageArchiveSha256: retriedPackageArchiveSha256,
          sourceSha256,
        }),
      ).rejects.toThrow("尚未永久封存");

      await writeFile(
        path.join(
          assetRoot,
          "knowledge-builds",
          "7",
          buildId,
          "generation-1",
          "upload-evidence",
          "customer-uploads",
          `${sourceSha256}.bin`,
        ),
        Buffer.alloc(bytes.length, 0x78),
      );
      await expect(
        verifiedKnowledgeBasePackageUploadEvidenceForBuild({
          userId: 7,
          buildId,
          generation: 1,
          packageArchiveSha256: "d".repeat(64),
        }),
      ).rejects.toThrow("永久证据字节完整性不一致");
    } finally {
      if (previousAssetRoot === undefined) {
        delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
      } else {
        process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetRoot;
      }
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

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
    const resources = await knowledgeBaseCustomerUploadResources(
      "build-1",
      turn,
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      kind: "customer_upload",
      caption: "知识库配图",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(Object.keys(resources[0]!).sort()).toEqual([
      "caption",
      "id",
      "kind",
      "mimeType",
      "sameOriginUrl",
      "sizeBytes",
    ]);
    expect(resources[0]!.sameOriginUrl).toMatch(
      /^\/api\/knowledge-base\/artifacts\/resources\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u,
    );
    const serialized = JSON.stringify(resources);
    expect(serialized).not.toContain("build-1");
    expect(serialized).not.toContain("turn-customer-image");
    expect(serialized).not.toContain("customer-proof.jpg");
    expect(serialized).not.toContain("file-customer-image");
    expect(serialized).not.toContain("a".repeat(64));
  });

  it("resolves a captured source id through its finalized Manus v2 mapping", async () => {
    const sourceSha256 = "a".repeat(64);
    const turn = capturedImageTurn({
      providerProtocol: "manus_v2",
      manusV2SourceAttachmentFileIds: ["file-customer-image"],
      manusV2AttachmentMappings: {
        customer: {
          status: "ready",
          sourceFileId: "file-customer-image",
          upstreamFileId: "v2-file-customer-image",
          filename: "customer-proof.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1234,
          contentSha256: sourceSha256,
        },
      },
      manusV2AttachmentMappingsFinalizedAt: "2026-08-16T22:35:50.538Z",
    });
    turn.attachmentFileIds = ["v2-file-customer-image"];
    dependencies.readStoredPresalesFile.mockResolvedValueOnce({
      filename: "customer-proof.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      sha256: sourceSha256,
    });

    expect(knowledgeBaseCustomerUploadImagesFromTurn(turn)).toEqual([
      expect.objectContaining({
        fileId: "file-customer-image",
        filename: "customer-proof.jpg",
        sourceSha256,
      }),
    ]);
    await expect(
      knowledgeBaseCustomerUploadResources("build-1", turn),
    ).resolves.toHaveLength(1);
    expect(knowledgeBaseExpectedCustomerUploadsFromTurns([turn])).toEqual([
      expect.objectContaining({
        sourceSha256,
        fileIds: ["file-customer-image"],
      }),
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

  it("accepts only an immutable build-bound Logo provenance repair ledger", () => {
    const turn = {
      id: "turn-logo-repair",
      operationType: "logo_provenance_repair",
      buildId: "build-1",
      buildGeneration: 7,
      expectedRevision: 50,
      expectedLeafId: "7.5",
      attachmentFileIds: ["file-logo-repair"],
      status: "completed" as const,
      metadata: {
        logoProvenanceRepair: {
          kind: "frontmind.knowledge-base.logo-provenance-repair",
          schemaVersion: 1,
          immutable: true,
          buildId: "build-1",
          generation: 7,
          revision: 50,
          leafId: "7.5",
          officialLogoUpload: {
            verified: true,
            index: 0,
            fileId: "file-logo-repair",
            filename: "siliconflow.png",
            mimeType: "image/png",
            sizeBytes: 9556,
            sourceSha256: "b".repeat(64),
          },
        },
      },
    };
    expect(knowledgeBaseOfficialLogoUploadFromTurn(turn)).toMatchObject({
      turnId: "turn-logo-repair",
      leafId: "7.5",
      fileId: "file-logo-repair",
      sourceSha256: "b".repeat(64),
    });
    expect(
      knowledgeBaseOfficialLogoUploadFromTurn({
        ...turn,
        metadata: {
          logoProvenanceRepair: {
            ...turn.metadata.logoProvenanceRepair,
            revision: 49,
          },
        },
      }),
    ).toBeNull();
  });

  it("accepts a completed server-authored local materialized Logo ledger", () => {
    const turn = {
      id: "turn-local-logo",
      operationType: "local_logo",
      buildId: "build-1",
      buildGeneration: 7,
      expectedRevision: 50,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-local-logo"],
      status: "completed" as const,
      metadata: {
        execution: "local",
        providerRequestCount: 0,
        localLogo: {
          kind: "frontmind.knowledge-base.local-logo",
          schemaVersion: 1,
          immutable: true,
          buildId: "build-1",
          generation: 7,
          revision: 50,
          leafId: "1.1",
          officialLogoUpload: {
            verified: true,
            index: 0,
            fileId: "file-local-logo",
            filename: "brand.png",
            mimeType: "image/png",
            sizeBytes: 4096,
            sourceSha256: "c".repeat(64),
          },
        },
      },
    };
    expect(knowledgeBaseOfficialLogoUploadFromTurn(turn)).toMatchObject({
      turnId: "turn-local-logo",
      leafId: "1.1",
      fileId: "file-local-logo",
      sourceSha256: "c".repeat(64),
    });
    expect(
      knowledgeBaseOfficialLogoUploadFromTurn({
        ...turn,
        expectedRevision: 51,
      }),
    ).toBeNull();
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
              where() {
                return {
                  async orderBy() {
                    return [turn];
                  },
                };
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

  it("selects the latest completed replacement ledger matching the current Logo hash", async () => {
    const logoTurn = (id: string, fileId: string, sourceSha256: string) => ({
      ...capturedImageTurn({
        recovery: {
          capturedClientAttachments: true,
          attachments: [{ file_id: fileId, filename: `${id}.png` }],
          attachmentManifest: [
            {
              filename: `${id}.png`,
              mimeType: "image/png",
              sizeBytes: 1234,
              sha256: sourceSha256,
            },
          ],
          officialLogoUpload: {
            verified: true,
            index: 0,
            fileId,
            filename: `${id}.png`,
            mimeType: "image/png",
            sizeBytes: 1234,
            sourceSha256,
          },
        },
        preparedDispatch: {
          requestBody: {
            attachments: [{ file_id: fileId, filename: `${id}.png` }],
          },
        },
      }),
      id,
      attachmentFileIds: [fileId],
    });
    const superseded = logoTurn("logo-old", "file-logo-old", "a".repeat(64));
    const current = logoTurn("logo-new", "file-logo-new", "b".repeat(64));
    dependencies.getDb.mockResolvedValue({
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [superseded, current];
                  },
                };
              },
            };
          },
        };
      },
    });

    await expect(
      verifiedKnowledgeBasePackageUploadEvidenceForBuild({
        userId: 7,
        buildId: "build-1",
        generation: 1,
        officialLogoSha256: "b".repeat(64),
      }),
    ).resolves.toEqual({
      expectedCustomerUploads: [],
      expectedOfficialLogoUpload: expect.objectContaining({
        fileId: "file-logo-new",
        sourceSha256: "b".repeat(64),
      }),
      expectedOfficialLogoProvenance: undefined,
    });
  });

  it("loads one customer-upload Logo ledger for reconcile, publish and download without duplicating it as customer media", async () => {
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
    dependencies.getDb.mockResolvedValue({
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [turn];
                  },
                };
              },
            };
          },
        };
      },
    });

    await expect(
      verifiedKnowledgeBasePackageUploadEvidenceForBuild({
        userId: 7,
        buildId: "build-1",
        generation: 1,
        officialLogoSha256: "a".repeat(64),
      }),
    ).resolves.toEqual({
      expectedCustomerUploads: [],
      expectedOfficialLogoUpload: expect.objectContaining({
        fileId: "file-customer-image",
        sourceSha256: "a".repeat(64),
      }),
      expectedOfficialLogoProvenance: undefined,
    });
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
