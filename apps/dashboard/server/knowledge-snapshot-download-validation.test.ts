import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  KnowledgeBaseBuild,
  KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import { knowledgeBuildArtifactLocalPackageStorageKey } from "./knowledge-build-artifact-store";
import {
  KnowledgeSnapshotDownloadBindingError,
  resolveDashboardOwnedSnapshotDownloadBinding,
} from "./knowledge-snapshot-download-validation";

const buildId = "123e4567-e89b-42d3-a456-426614174000";
const snapshotId = "00000000-0000-4000-8000-000000000123";
const archiveSha256 = "a".repeat(64);
const descriptorHash = createHash("sha256")
  .update(`dashboard-local:${buildId}:2:7:${archiveSha256}`, "utf8")
  .digest("hex");

const build = {
  id: buildId,
  userId: 42,
  conversationId: "conversation-1",
  companyName: "FrontMind",
  status: "published",
  generation: 2,
  revision: 7,
  upstreamTaskId: "task-1",
  canonicalTaskId: "task-1",
  packageStatus: "ready",
  packageRevision: 7,
  packageTaskId: "task-1",
  packageOutputItemId: `dashboard-local:${buildId}:7`,
  packageFilename: "FrontMind-knowledge-base.zip",
  packageDescriptorHash: descriptorHash,
  packageStorageKey: knowledgeBuildArtifactLocalPackageStorageKey({
    userId: 42,
    buildId,
    generation: 2,
    revision: 7,
  }),
  packageArchiveSha256: archiveSha256,
  packageSizeBytes: 1234,
  publishedSnapshotId: snapshotId,
} as KnowledgeBaseBuild;

const snapshot = {
  id: snapshotId,
  userId: 42,
  sourceFileName: "FrontMind-knowledge-base.zip",
  sourceConversationId: "conversation-1",
  sourceBuildId: buildId,
  sourceBuildRevision: 7,
  sourceTaskId: "task-1",
  sourceArtifactHash: archiveSha256,
  archiveHash: archiveSha256,
  totalBytes: 1234,
} as KnowledgeBaseSnapshot;

describe("Dashboard-owned snapshot download binding", () => {
  it("accepts only the exact immutable publication tuple", () => {
    expect(
      resolveDashboardOwnedSnapshotDownloadBinding({ snapshot, build }),
    ).toEqual({
      buildId,
      archiveSha256,
      archiveBytes: 1234,
      expected: {
        buildId,
        generation: 2,
        revision: 7,
        companyName: "FrontMind",
      },
    });
  });

  it.each([
    ["snapshot owner", { userId: 43 }],
    ["published snapshot", { publishedSnapshotId: randomUUID() }],
    ["source revision", { revision: 8 }],
    ["archive bytes", { packageSizeBytes: 1235 }],
    ["package status", { packageStatus: "retrying" }],
    ["storage key", { packageStorageKey: "knowledge-builds/other.zip" }],
    ["archive hash", { packageArchiveSha256: "b".repeat(64) }],
    [
      "output identity",
      { packageOutputItemId: `dashboard-local:${buildId}:8` },
    ],
  ])("rejects a mismatched %s binding", (_label, patch) => {
    expect(() =>
      resolveDashboardOwnedSnapshotDownloadBinding({
        snapshot,
        build: { ...build, ...patch },
      }),
    ).toThrow(KnowledgeSnapshotDownloadBindingError);
  });

  it("keeps a historical/provider build on the legacy validation path", () => {
    expect(
      resolveDashboardOwnedSnapshotDownloadBinding({
        snapshot,
        build: { ...build, packageOutputItemId: "provider-output-1" },
      }),
    ).toBeNull();
  });
});
