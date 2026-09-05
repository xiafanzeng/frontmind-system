import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertKnowledgeBaseOfficialLogoMimeMatches,
  collectKnowledgeBaseLogoDescriptors,
  knowledgeBaseRecoveredPackageMatchesStoredHash,
  knowledgeBaseStagedArtifactCleanupDecision,
  selectKnowledgeBaseRecoveryLogoAsset,
  selectKnowledgeBaseReadyPackageDescriptor,
  type KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "./knowledge-base-artifact";

describe("knowledge-base Logo descriptor normalization", () => {
  it("rejects a declared Logo MIME that disagrees with the decoded bytes", () => {
    expect(
      assertKnowledgeBaseOfficialLogoMimeMatches({
        declaredMimeType: "image/jpeg",
        detectedFormat: "jpeg",
      }),
    ).toBe("image/jpeg");
    expect(() =>
      assertKnowledgeBaseOfficialLogoMimeMatches({
        declaredMimeType: "image/jpeg",
        detectedFormat: "png",
      }),
    ).toThrowError(expect.objectContaining({ code: "LOGO_UPLOAD_INVALID" }));
  });

  it("recovers the v4 official Logo without treating ordinary upload assets as candidates", () => {
    const official = {
      sha256: "a".repeat(64),
      sourceKind: "official_logo_upload",
    } as any;
    const customer = {
      sha256: "b".repeat(64),
      sourceKind: "user_upload",
    } as any;

    expect(
      selectKnowledgeBaseRecoveryLogoAsset({
        skillVersion: "4",
        assets: [customer, official],
        expectedLogoSha256: "a".repeat(64),
      }),
    ).toBe(official);
  });

  it("deduplicates nested and top-level projections of one physical Logo", () => {
    const descriptors = collectKnowledgeBaseLogoDescriptors([
      {
        id: "message-1",
        content: [
          {
            type: "output_image",
            file_id: "file-logo",
            file_name: "logo.png",
            mime_type: "image/png",
          },
        ],
      },
      {
        type: "output_file",
        file_id: "file-logo",
        file_name: "logo.png",
        mime_type: "image/png",
      },
    ]);
    expect(descriptors).toEqual([
      expect.objectContaining({
        fileId: "file-logo",
        filename: "logo.png",
        mimeType: "image/png",
      }),
    ]);
  });

  it("does not classify ZIP or ordinary files as images", () => {
    expect(
      collectKnowledgeBaseLogoDescriptors([
        {
          type: "output_file",
          file_id: "file-zip",
          file_name: "knowledge.zip",
          mime_type: "application/zip",
        },
        {
          type: "output_file",
          file_id: "file-pdf",
          file_name: "source.pdf",
          mime_type: "application/pdf",
        },
      ]),
    ).toEqual([]);
  });

  it("recognizes provider image URL aliases without rendering the hotlink", () => {
    expect(
      collectKnowledgeBaseLogoDescriptors({
        type: "image",
        image_url: "https://api.example.com/v1/files/logo-1/content?sig=x",
        name: "brand.webp",
      }),
    ).toEqual([
      expect.objectContaining({ fileId: "logo-1", filename: "brand.webp" }),
    ]);
  });

  it("merges a signed URL projection with a file-id projection", () => {
    expect(
      collectKnowledgeBaseLogoDescriptors([
        {
          type: "output_image",
          image_url: "https://cdn.example/signed-logo",
          file_id: "logo-2",
          name: "logo.png",
        },
        {
          type: "image",
          image_url: "https://cdn.example/signed-logo",
          name: "logo.png",
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("knowledge-base operation candidate cleanup", () => {
  const candidate: KnowledgeBaseStagedArtifactCandidate = {
    staged: true,
    kind: "package",
    userId: 7,
    buildId: "10000000-0000-4000-8000-000000000001",
    generation: 1,
    turnId: "turn-old",
    operationKey: "operation-old",
    taskId: "task-old",
    expectedStateEpoch: 3,
    expectedRevision: 7,
    descriptorHash: "a".repeat(64),
    sourceDescriptorHash: "b".repeat(64),
    storageKey: "candidate/package.zip",
    sha256: "c".repeat(64),
    bytes: 123,
    filename: "knowledge.zip",
    mimeType: "application/zip",
    packageRevision: 8,
  };
  const currentBuild = {
    logoStorageKey: null,
    packageStorageKey: null,
    activeTurnId: candidate.turnId,
    stateEpoch: candidate.expectedStateEpoch,
    revision: candidate.expectedRevision,
    upstreamTaskId: candidate.taskId,
  };
  const currentTurn = {
    operationKey: candidate.operationKey,
    upstreamTaskId: candidate.taskId,
    status: "running" as const,
  };

  it("retains a shared candidate while another poller can still promote it", () => {
    expect(
      knowledgeBaseStagedArtifactCleanupDecision({
        candidate,
        build: currentBuild,
        turn: currentTurn,
      }),
    ).toBe("retained_current");
    expect(
      knowledgeBaseStagedArtifactCleanupDecision({
        candidate,
        build: {
          ...currentBuild,
          activeTurnId: null,
          packageStorageKey: candidate.storageKey,
        },
      }),
    ).toBe("promoted");
  });

  it("deletes only after retry replaced the active turn authority", () => {
    expect(
      knowledgeBaseStagedArtifactCleanupDecision({
        candidate,
        build: {
          ...currentBuild,
          activeTurnId: "turn-new",
          stateEpoch: currentBuild.stateEpoch + 1,
          upstreamTaskId: "task-new",
        },
        turn: currentTurn,
      }),
    ).toBe("delete");
  });
});

describe("historical ready-package backfill selection", () => {
  const identity = {
    skillVersion: "3",
    packageOutputItemId: "authoritative-file-item",
    packageFileId: "file-authoritative",
    packageDescriptorHash: null,
    packageArchiveSha256: null,
  };

  it("selects the persisted file from cumulative ZIP history regardless of projection order", () => {
    const descriptors = collectKnowledgeArchiveDescriptors([
      {
        id: "stale-file-item",
        type: "output_file",
        file_id: "file-stale",
        filename: "old.zip",
        mime_type: "application/zip",
      },
      {
        id: "assistant-final",
        role: "assistant",
        type: "output_message",
        content: [
          {
            type: "output_file",
            file_url:
              "https://api.example/v1/files/file-authoritative/content?sig=rotated",
            filename: "knowledge.zip",
            mime_type: "application/zip",
          },
        ],
      },
      {
        id: "authoritative-file-item",
        type: "output_file",
        file_id: "file-authoritative",
        file_url: "https://cdn.example/knowledge.zip?sig=new",
        filename: "knowledge.zip",
        mime_type: "application/zip",
      },
    ]);

    expect(
      selectKnowledgeBaseReadyPackageDescriptor({
        descriptors: [...descriptors].reverse(),
        identity: {
          ...identity,
          packageOutputItemId: "assistant-final:content:99",
        },
      }),
    ).toMatchObject({
      fileId: "file-authoritative",
      filename: "knowledge.zip",
      outputItemIds: expect.arrayContaining([
        "authoritative-file-item",
        "assistant-final:content:0",
      ]),
    });
  });

  it("allows a legacy signed URL to rotate when a stable output item identifies the ZIP", () => {
    const original = {
      outputItemId: "authoritative-file-item",
      url: "https://cdn.example/knowledge.zip?sig=old",
      filename: "knowledge.zip",
      mimeType: "application/zip",
    };
    const rotated = {
      ...original,
      outputItemIds: [original.outputItemId],
      url: "https://cdn.example/knowledge.zip?sig=new",
    };
    expect(
      selectKnowledgeBaseReadyPackageDescriptor({
        descriptors: [rotated],
        identity: {
          ...identity,
          packageFileId: null,
          packageDescriptorHash: knowledgeArchiveDescriptorHash(original),
        },
      }),
    ).toBe(rotated);
  });

  it("fails closed when persisted identity matches zero or multiple cumulative ZIPs", () => {
    expect(() =>
      selectKnowledgeBaseReadyPackageDescriptor({
        descriptors: [
          {
            outputItemId: "different",
            fileId: "different",
            filename: "knowledge.zip",
            mimeType: "application/zip",
          },
        ],
        identity,
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_NOT_READY" }));

    expect(() =>
      selectKnowledgeBaseReadyPackageDescriptor({
        descriptors: [
          {
            outputItemId: "one",
            outputItemIds: ["authoritative-file-item"],
            fileId: "file-authoritative",
            filename: "knowledge-a.zip",
            mimeType: "application/zip",
          },
          {
            outputItemId: "two",
            outputItemIds: ["authoritative-file-item"],
            fileId: "file-authoritative",
            filename: "knowledge-b.zip",
            mimeType: "application/zip",
          },
        ],
        identity,
      }),
    ).toThrowError(expect.objectContaining({ code: "PACKAGE_AMBIGUOUS" }));
  });
});

describe("historical v4 package hash recovery", () => {
  const providerBuffer = Buffer.from("provider-v4-archive\r\n", "utf8");
  const authoritativeBuffer = Buffer.from("provider-v4-archive\n", "utf8");
  const sha256 = (buffer: Buffer) =>
    createHash("sha256").update(buffer).digest("hex");

  it("accepts either the legacy provider hash or the newly sealed hash", () => {
    expect(
      knowledgeBaseRecoveredPackageMatchesStoredHash({
        expectedSha256: sha256(providerBuffer),
        providerBuffer,
        authoritativeBuffer,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseRecoveredPackageMatchesStoredHash({
        expectedSha256: sha256(authoritativeBuffer),
        providerBuffer,
        authoritativeBuffer,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseRecoveredPackageMatchesStoredHash({
        expectedSha256: "0".repeat(64),
        providerBuffer,
        authoritativeBuffer,
      }),
    ).toBe(false);
  });
});
