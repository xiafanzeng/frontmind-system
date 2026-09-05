import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertKnowledgeBaseOfficialLogoMimeMatches,
  bindKnowledgeBaseInitialLogo,
  bindKnowledgeBaseOfficialLogoUpload,
  collectKnowledgeBaseLogoDescriptors,
  KnowledgeBaseArtifactBindingError,
  knowledgeBaseRecoveredPackageMatchesStoredHash,
  knowledgeBaseArchiveRequiresV4UploadEvidence,
  knowledgeBaseArchiveReadContractVersions,
  knowledgeBaseArchiveWriteContractVersions,
  knowledgeBaseExistingLogoUploadBindingDecision,
  knowledgeBaseAllowsFirstLeafLogoReplacement,
  knowledgeBaseInitialLogoRejectionCode,
  knowledgeBaseStagedArtifactCleanupDecision,
  probeKnowledgeBaseInitialLogoCandidates,
  selectKnowledgeBaseInitialLogoPhysicalCandidate,
  selectKnowledgeBaseRecoveryLogoAsset,
  selectKnowledgeBaseReadyPackageDescriptor,
  type KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "./knowledge-base-artifact";

describe("knowledge-base Logo descriptor normalization", () => {
  it("rejects overlong task and upload file identities before any binding I/O", async () => {
    await expect(
      bindKnowledgeBaseInitialLogo({
        userId: 7,
        buildId: "10000000-0000-4000-8000-000000000001",
        generation: 1,
        taskId: "t".repeat(256),
        output: [],
        apiKey: "unused",
        baseUrl: "https://api.example",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_INVALID" });
    await expect(
      bindKnowledgeBaseOfficialLogoUpload({
        userId: 7,
        buildId: "10000000-0000-4000-8000-000000000001",
        generation: 1,
        turnId: "turn-1",
        operationKey: "operation-1",
        expectedRevision: 0,
        expectedLeafId: "1.1",
        upload: {
          index: 0,
          fileId: "f".repeat(256),
          filename: "logo.png",
          mimeType: "image/png",
          sizeBytes: 100,
          sourceSha256: "a".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_IDENTITY_INVALID" });
  });

  it("keeps new v4 writes strict while reading archives accepted by production", () => {
    expect(knowledgeBaseArchiveWriteContractVersions("4")).toEqual([4]);
    expect(knowledgeBaseArchiveReadContractVersions("4")).toEqual([3, 4]);
    expect(knowledgeBaseArchiveWriteContractVersions("3")).toEqual([2, 3]);
    expect(knowledgeBaseArchiveReadContractVersions("3")).toEqual([2, 3]);
    expect(knowledgeBaseArchiveWriteContractVersions("1")).toBeUndefined();
    expect(knowledgeBaseArchiveReadContractVersions("1")).toBeUndefined();
    expect(knowledgeBaseArchiveRequiresV4UploadEvidence("4", 4)).toBe(true);
    expect(knowledgeBaseArchiveRequiresV4UploadEvidence("4", 3)).toBe(false);
    expect(knowledgeBaseArchiveRequiresV4UploadEvidence("3", 4)).toBe(false);
  });
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

  it("accepts a rasterized PNG returned from an SVG source", () => {
    expect(
      assertKnowledgeBaseOfficialLogoMimeMatches({
        declaredMimeType: "image/png",
        detectedFormat: "png",
      }),
    ).toBe("image/png");
  });

  it("degrades only Logo-local failures and never infrastructure or stale-build failures", () => {
    expect(
      knowledgeBaseInitialLogoRejectionCode(
        new KnowledgeBaseArtifactBindingError(
          "LOGO_UPLOAD_INVALID",
          "invalid image",
        ),
      ),
    ).toBe("LOGO_UPLOAD_INVALID");
    expect(
      knowledgeBaseInitialLogoRejectionCode(
        new KnowledgeBaseArtifactBindingError("BUILD_CHANGED", "stale build"),
      ),
    ).toBeNull();
    expect(
      knowledgeBaseInitialLogoRejectionCode(new Error("database unavailable")),
    ).toBeNull();
  });

  it("repairs provenance instead of treating an existing same-hash Logo as complete", () => {
    const verifiedUpload = {
      verified: true as const,
      index: 0,
      fileId: "file-logo",
      filename: "logo.png",
      mimeType: "image/png",
      sizeBytes: 100,
      sourceSha256: "a".repeat(64),
    };
    expect(
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "a".repeat(64),
        stagedBytes: 100,
        stagedMimeType: "image/png",
        existingUpload: null,
        verifiedUpload,
      }),
    ).toBe("repair_provenance");
    expect(
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "a".repeat(64),
        stagedBytes: 100,
        stagedMimeType: "image/png",
        existingUpload: { ...verifiedUpload },
        verifiedUpload,
      }),
    ).toBe("already_complete");

    expect(
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "a".repeat(64),
        stagedBytes: 100,
        stagedMimeType: "image/png",
        existingUpload: { ...verifiedUpload, verified: false },
        verifiedUpload,
      }),
    ).toBe("repair_provenance");

    expect(() =>
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "a".repeat(64),
        stagedBytes: 100,
        stagedMimeType: "image/png",
        existingUpload: {
          ...verifiedUpload,
          verified: false,
          fileId: "different-file",
        },
        verifiedUpload,
      }),
    ).toThrowError(expect.objectContaining({ code: "BUILD_CHANGED" }));

    const replacementUpload = {
      ...verifiedUpload,
      fileId: "replacement-file",
      sourceSha256: "b".repeat(64),
    };
    expect(
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "b".repeat(64),
        stagedBytes: 100,
        stagedMimeType: "image/png",
        existingUpload: { ...replacementUpload, verified: false },
        verifiedUpload: replacementUpload,
        allowReplacement: true,
      }),
    ).toBe("replace_artifact");
  });

  it("allows a materialized v5 Logo replacement only before the first leaf is confirmed", () => {
    const allowReplacement = knowledgeBaseAllowsFirstLeafLogoReplacement({
      requested: true,
      skillVersion: "5",
      executionMode: "materialized_bundle_v1",
      confirmedCount: 0,
      directPrefilledCount: 0,
    });
    expect(allowReplacement).toBe(true);
    expect(
      knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: "a".repeat(64),
        buildLogoBytes: 100,
        buildLogoMimeType: "image/png",
        stagedSha256: "b".repeat(64),
        stagedBytes: 120,
        stagedMimeType: "image/png",
        existingUpload: null,
        verifiedUpload: {
          verified: true,
          index: 0,
          fileId: "replacement-logo",
          filename: "replacement-logo.png",
          mimeType: "image/png",
          sizeBytes: 120,
          sourceSha256: "b".repeat(64),
        },
        allowReplacement,
      }),
    ).toBe("replace_artifact");
    expect(
      knowledgeBaseAllowsFirstLeafLogoReplacement({
        requested: true,
        skillVersion: "5",
        executionMode: "materialized_bundle_v1",
        confirmedCount: 1,
        directPrefilledCount: 0,
      }),
    ).toBe(false);
    expect(
      knowledgeBaseAllowsFirstLeafLogoReplacement({
        requested: true,
        skillVersion: "5",
        executionMode: "legacy_conversational",
        confirmedCount: 0,
        directPrefilledCount: 0,
      }),
    ).toBe(false);
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

  it("retains typed files for byte-authoritative Logo decoding", () => {
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
    ).toEqual([
      expect.objectContaining({ fileId: "file-zip" }),
      expect.objectContaining({ fileId: "file-pdf" }),
    ]);
  });

  it("keeps a typed image as a Logo candidate even when its MIME and extension are wrong", () => {
    expect(
      collectKnowledgeBaseLogoDescriptors([
        {
          type: "output_image",
          file_id: "file-logo-wrong-declaration",
          file_name: "logo.bin",
          mime_type: "application/octet-stream",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        fileId: "file-logo-wrong-declaration",
        filename: "logo.bin",
        mimeType: "application/octet-stream",
      }),
    ]);
  });

  it("keeps a typed output_file with wrong MIME and extension until its PNG bytes are decoded", () => {
    expect(
      collectKnowledgeBaseLogoDescriptors([
        {
          type: "output_file",
          file_id: "file-logo-png-bytes",
          file_name: "artifact.bin",
          mime_type: "application/octet-stream",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        fileId: "file-logo-png-bytes",
        filename: "artifact.bin",
        mimeType: "application/octet-stream",
      }),
    ]);
  });

  it("skips a non-image typed file without hiding the one valid Logo candidate", async () => {
    const descriptors = collectKnowledgeBaseLogoDescriptors([
      {
        type: "output_file",
        file_id: "file-document",
        file_name: "facts.pdf",
        mime_type: "application/pdf",
      },
      {
        type: "output_file",
        file_id: "file-logo",
        file_name: "artifact.bin",
        mime_type: "application/octet-stream",
      },
    ]);
    const result = await probeKnowledgeBaseInitialLogoCandidates({
      descriptors,
      probe: async (descriptor) => {
        if (descriptor.fileId === "file-document") {
          throw new KnowledgeBaseArtifactBindingError(
            "LOGO_UPLOAD_INVALID",
            "not an image",
          );
        }
        return { fileId: descriptor.fileId, decodedFormat: "png" };
      },
    });

    expect(result.validCandidates).toEqual([
      { fileId: "file-logo", decodedFormat: "png" },
    ]);
    expect(result.lastRejectedError).toBeInstanceOf(
      KnowledgeBaseArtifactBindingError,
    );
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

  it("keeps one physical Logo and cleans every extra same-byte staging alias", () => {
    const candidate = (
      storageKey: string,
      sha256: string,
    ): KnowledgeBaseStagedArtifactCandidate => ({
      staged: true,
      kind: "logo",
      userId: 7,
      buildId: "10000000-0000-4000-8000-000000000001",
      generation: 1,
      turnId: "turn-current",
      operationKey: "operation-current",
      taskId: "task-current",
      expectedStateEpoch: 2,
      expectedRevision: 0,
      descriptorHash: createHash("sha256").update(storageKey).digest("hex"),
      sourceDescriptorHash: createHash("sha256")
        .update(`source:${storageKey}`)
        .digest("hex"),
      storageKey,
      sha256,
      bytes: 100,
      filename: "logo.png",
      mimeType: "image/png",
    });
    const kept = candidate("logo/primary.png", "a".repeat(64));
    const alias = candidate("logo/alias.png", "a".repeat(64));

    expect(
      selectKnowledgeBaseInitialLogoPhysicalCandidate([kept, alias]),
    ).toEqual({
      selected: kept,
      physicalCount: 1,
      cleanup: [alias],
    });
  });

  it("cleans every staged alias when multiple physical Logo bytes are ambiguous", () => {
    const base = {
      staged: true as const,
      kind: "logo" as const,
      userId: 7,
      buildId: "10000000-0000-4000-8000-000000000001",
      generation: 1,
      turnId: "turn-current",
      operationKey: "operation-current",
      taskId: "task-current",
      expectedStateEpoch: 2,
      expectedRevision: 0,
      bytes: 100,
      filename: "logo.png",
      mimeType: "image/png",
    };
    const candidates: KnowledgeBaseStagedArtifactCandidate[] = [
      {
        ...base,
        descriptorHash: "1".repeat(64),
        sourceDescriptorHash: "2".repeat(64),
        storageKey: "logo/a-primary.png",
        sha256: "a".repeat(64),
      },
      {
        ...base,
        descriptorHash: "3".repeat(64),
        sourceDescriptorHash: "4".repeat(64),
        storageKey: "logo/a-alias.png",
        sha256: "a".repeat(64),
      },
      {
        ...base,
        descriptorHash: "5".repeat(64),
        sourceDescriptorHash: "6".repeat(64),
        storageKey: "logo/b.png",
        sha256: "b".repeat(64),
      },
    ];

    expect(selectKnowledgeBaseInitialLogoPhysicalCandidate(candidates)).toEqual(
      {
        selected: null,
        physicalCount: 2,
        cleanup: candidates,
      },
    );
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
