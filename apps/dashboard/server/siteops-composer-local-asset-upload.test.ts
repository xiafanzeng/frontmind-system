import { describe, expect, it } from "vitest";

import {
  SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS,
  SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
} from "../shared/siteops-composer-local-upload";
import {
  parseSiteOpsComposerLocalUploadCoordinate,
  SiteOpsComposerLocalAssetCoordinateError,
  siteOpsComposerLocalAssetExistingRowDisposition,
  siteOpsComposerLocalAssetIdentity,
} from "./siteops-composer-local-asset-upload";
import { sealLocalAssetStorageIdentity } from "./local-asset-storage-key";

const taskStartedAt = new Date("2026-08-30T00:00:00.000Z");

function headers(overrides: Record<string, string> = {}) {
  return {
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.scope]:
      SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.clientRequestId]:
      "11111111-1111-4111-8111-111111111111",
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.contentSha256]: "a".repeat(64),
    [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.ordinal]: "2",
    ...overrides,
  };
}

function identity(
  overrides: Partial<
    Parameters<typeof siteOpsComposerLocalAssetIdentity>[0]
  > = {},
) {
  return siteOpsComposerLocalAssetIdentity({
    userId: 7,
    projectId: "22222222-2222-4222-8222-222222222222",
    currentTaskStartedAt: taskStartedAt,
    knowledgeInputEpochId: "33333333-3333-4333-8333-333333333333",
    coordinate: parseSiteOpsComposerLocalUploadCoordinate(headers())!,
    filename: "产品图.png",
    mimeType: "image/png",
    sizeBytes: 3,
    ...overrides,
  });
}

describe("SiteOps composer local asset identity", () => {
  it("requires the complete explicit composer coordinate", () => {
    expect(parseSiteOpsComposerLocalUploadCoordinate({})).toBeNull();
    expect(parseSiteOpsComposerLocalUploadCoordinate(headers())).toEqual({
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      contentSha256: "a".repeat(64),
      ordinal: 2,
    });
    expect(() =>
      parseSiteOpsComposerLocalUploadCoordinate({
        [SITEOPS_COMPOSER_LOCAL_UPLOAD_HEADERS.scope]:
          SITEOPS_COMPOSER_LOCAL_UPLOAD_SCOPE,
      }),
    ).toThrow(SiteOpsComposerLocalAssetCoordinateError);
  });

  it("replays one request item but binds content, metadata and task epoch", () => {
    const first = identity();
    expect(identity()).toEqual(first);

    const changedContent = identity({
      coordinate: {
        ...parseSiteOpsComposerLocalUploadCoordinate(headers())!,
        contentSha256: "b".repeat(64),
      },
    });
    const changedMetadata = identity({ filename: "另一张图.png" });
    const nextEpoch = identity({
      knowledgeInputEpochId: "44444444-4444-4444-8444-444444444444",
    });
    expect(changedContent.localAssetId).toBe(first.localAssetId);
    expect(changedContent.storageKey).not.toBe(first.storageKey);
    expect(changedMetadata.localAssetId).toBe(first.localAssetId);
    expect(changedMetadata.storageKey).not.toBe(first.storageKey);
    expect(nextEpoch.localAssetId).not.toBe(first.localAssetId);
  });

  it("replays exact retained bytes and fails closed across changed content", () => {
    const expectedIdentity = identity();
    const sealed = sealLocalAssetStorageIdentity({
      storageKey: expectedIdentity.storageKey,
    });
    const existing = {
      id: expectedIdentity.localAssetId,
      scope: "managed_user",
      accountUserId: 7,
      presalesProjectId: null,
      filename: "产品图.png",
      mimeType: "image/png",
      sizeBytes: 3,
      contentSha256: "a".repeat(64),
      storageKey: expectedIdentity.storageKey,
      storageKeyHash: sealed.storageKeyHash,
      retainUntil: new Date("2026-09-30T00:00:00.000Z"),
      createdAt: new Date("2026-08-30T00:00:01.000Z"),
      siteOpsKnowledgeInputEpochId: "33333333-3333-4333-8333-333333333333",
    };
    const expected = {
      localAssetId: expectedIdentity.localAssetId,
      ownerUserId: 7,
      filename: existing.filename,
      mimeType: existing.mimeType,
      sizeBytes: existing.sizeBytes,
      contentSha256: existing.contentSha256,
      storageKey: existing.storageKey,
      storageKeyHash: existing.storageKeyHash,
      currentTaskStartedAt: taskStartedAt,
      knowledgeInputEpochId: "33333333-3333-4333-8333-333333333333",
    };
    expect(
      siteOpsComposerLocalAssetExistingRowDisposition({
        existing,
        expected,
        storedContent: "matching",
        now: Date.parse("2026-08-31T00:00:00.000Z"),
      }),
    ).toEqual({ action: "replay", status: 200 });
    expect(
      siteOpsComposerLocalAssetExistingRowDisposition({
        existing,
        expected: { ...expected, contentSha256: "b".repeat(64) },
        storedContent: "matching",
        now: Date.parse("2026-08-31T00:00:00.000Z"),
      }),
    ).toEqual({ action: "conflict", status: 409 });
    expect(
      siteOpsComposerLocalAssetExistingRowDisposition({
        existing,
        expected: {
          ...expected,
          knowledgeInputEpochId: "44444444-4444-4444-8444-444444444444",
        },
        storedContent: "matching",
        now: Date.parse("2026-08-31T00:00:00.000Z"),
      }),
    ).toEqual({ action: "conflict", status: 409 });
    expect(
      siteOpsComposerLocalAssetExistingRowDisposition({
        existing: { ...existing, accountUserId: 8 },
        expected,
        storedContent: "matching",
        now: Date.parse("2026-08-31T00:00:00.000Z"),
      }),
    ).toEqual({ action: "conflict", status: 409 });
  });
});
