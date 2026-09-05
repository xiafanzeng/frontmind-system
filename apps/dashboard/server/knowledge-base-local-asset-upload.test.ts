import { describe, expect, it } from "vitest";

import { KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS } from "../shared/knowledge-base-local-upload";
import {
  KnowledgeBaseLocalAssetCoordinateError,
  knowledgeBaseLocalAssetContentReplayMatches,
  knowledgeBaseLocalAssetExistingRowDisposition,
  knowledgeBaseLocalAssetIdentity,
  parseKnowledgeBaseLocalUploadCoordinate,
} from "./knowledge-base-local-asset-upload";

function headers(overrides: Record<string, string> = {}) {
  return {
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.conversationId]: "conversation-1",
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.turnId]:
      "00000000-0000-4000-8000-000000000001",
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.clientRequestId]: "request-1",
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.itemId]: "item-2",
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.expectedResetRevision]: "4",
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256]: "a".repeat(64),
    [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.ordinal]: "2",
    ...overrides,
  };
}

describe("knowledge-base local asset operation identity", () => {
  it("keeps a reservation item stable while binding storage to its content", () => {
    const coordinate = parseKnowledgeBaseLocalUploadCoordinate(headers())!;
    const first = knowledgeBaseLocalAssetIdentity({
      userId: 7,
      projectAssignmentId: "project-1",
      coordinate,
      sizeBytes: 74_459_557,
    });
    const replay = knowledgeBaseLocalAssetIdentity({
      userId: 7,
      projectAssignmentId: "project-1",
      coordinate,
      sizeBytes: 74_459_557,
    });
    const changed = knowledgeBaseLocalAssetIdentity({
      userId: 7,
      projectAssignmentId: "project-1",
      coordinate: { ...coordinate, contentSha256: "b".repeat(64) },
      sizeBytes: 74_459_557,
    });

    expect(replay).toEqual(first);
    expect(changed.localAssetId).toBe(first.localAssetId);
    expect(changed.storageKey).not.toBe(first.storageKey);
  });

  it("accepts a digest-free coordinate and derives storage only from the server digest", () => {
    const {
      [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.contentSha256]: _legacyDigest,
      ...digestFreeHeaders
    } = headers();
    const coordinate =
      parseKnowledgeBaseLocalUploadCoordinate(digestFreeHeaders)!;
    expect(coordinate.contentSha256).toBeUndefined();

    const reservedIdentity = knowledgeBaseLocalAssetIdentity({
      userId: 7,
      projectAssignmentId: "project-1",
      coordinate,
      sizeBytes: 12,
    });
    const retainedIdentity = knowledgeBaseLocalAssetIdentity({
      userId: 7,
      projectAssignmentId: "project-1",
      coordinate,
      sizeBytes: 12,
      authoritativeContentSha256: "c".repeat(64),
    });

    expect(reservedIdentity.localAssetId).toBe(retainedIdentity.localAssetId);
    expect(reservedIdentity).not.toHaveProperty("storageKey");
    expect(retainedIdentity.storageKey).toMatch(
      /^frontmind-v2:knowledge-base:/u,
    );
  });

  it("rejects a partial coordinate instead of falling back to ordinary chat", () => {
    expect(() =>
      parseKnowledgeBaseLocalUploadCoordinate({
        [KNOWLEDGE_BASE_LOCAL_UPLOAD_HEADERS.itemId]: "item-1",
      }),
    ).toThrow(KnowledgeBaseLocalAssetCoordinateError);
    expect(parseKnowledgeBaseLocalUploadCoordinate({})).toBeNull();
  });

  it("uses content identity rather than display metadata for replay", () => {
    const expected = {
      filename: "资料.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 74_459_557,
      contentSha256: "a".repeat(64),
      storageKey: "frontmind-v2:knowledge-base:identity",
    };
    expect(
      knowledgeBaseLocalAssetContentReplayMatches(expected, expected),
    ).toBe(true);
    expect(
      knowledgeBaseLocalAssetContentReplayMatches(
        { ...expected, contentSha256: "b".repeat(64) },
        expected,
      ),
    ).toBe(false);
    expect(
      knowledgeBaseLocalAssetContentReplayMatches(
        {
          ...expected,
          filename: "adapter-renamed.bin",
          mimeType: "application/octet-stream",
        },
        expected,
      ),
    ).toBe(true);
  });

  it("rebuilds an exact deterministic row whose retained body is missing", () => {
    const existing = {
      id: "asset_deterministic",
      scope: "managed_user",
      accountUserId: 7,
      presalesProjectId: null,
      filename: "stale-display-name.pdf",
      mimeType: "application/x-stale-adapter-type",
      sizeBytes: 12,
      contentSha256: "a".repeat(64),
      storageKey: "frontmind-v2:knowledge-base:identity",
      storageKeyHash: "b".repeat(64),
      retainUntil: new Date("2026-09-01T00:00:00.000Z"),
    };
    expect(
      knowledgeBaseLocalAssetExistingRowDisposition({
        existing,
        expected: {
          localAssetId: existing.id,
          ownerUserId: 7,
          sizeBytes: 12,
          contentSha256: "a".repeat(64),
          storageKey: existing.storageKey,
          storageKeyHash: existing.storageKeyHash,
        },
        storedContent: "missing",
        now: Date.parse("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual({ action: "rebuild", status: 201 });
  });

  it("never rebuilds over present corrupt bytes or a changed content identity", () => {
    const existing = {
      id: "asset_deterministic",
      scope: "managed_user",
      accountUserId: 7,
      presalesProjectId: null,
      sizeBytes: 12,
      contentSha256: "a".repeat(64),
      storageKey: "frontmind-v2:knowledge-base:identity",
      storageKeyHash: "b".repeat(64),
      retainUntil: new Date("2026-09-01T00:00:00.000Z"),
    };
    const expected = {
      localAssetId: existing.id,
      ownerUserId: 7,
      sizeBytes: 12,
      contentSha256: "a".repeat(64),
      storageKey: existing.storageKey,
      storageKeyHash: existing.storageKeyHash,
    };
    expect(
      knowledgeBaseLocalAssetExistingRowDisposition({
        existing,
        expected,
        storedContent: "mismatched",
        now: Date.parse("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual({ action: "conflict", status: 409 });
    expect(
      knowledgeBaseLocalAssetExistingRowDisposition({
        existing,
        expected: { ...expected, contentSha256: "c".repeat(64) },
        storedContent: "missing",
        now: Date.parse("2026-08-20T00:00:00.000Z"),
      }),
    ).toEqual({ action: "conflict", status: 409 });
  });
});
