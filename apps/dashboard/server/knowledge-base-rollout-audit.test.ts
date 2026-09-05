import { describe, expect, it, vi } from "vitest";

import type {
  ConversationTurn,
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
  KnowledgeBaseSnapshot,
} from "../drizzle/schema";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";
import {
  findKnowledgeBaseRolloutArtifactViolations,
  findKnowledgeBaseRolloutViolations,
  type KnowledgeBaseRolloutAuditDataset,
} from "./knowledge-base-rollout-audit";
import { knowledgeBuildArtifactStorageKey } from "./knowledge-build-artifact-store";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const LOGO_HASH = "a".repeat(64);
const PACKAGE_HASH = "b".repeat(64);

function uuid(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function buildFixture(
  overrides: Partial<KnowledgeBaseBuild> = {},
): KnowledgeBaseBuild {
  const base = {
    id: uuid(1),
    userId: 7,
    conversationId: "conversation-1",
    companyName: "Example",
    companyWebsite: null,
    upstreamTaskId: "task-current",
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
    status: "confirming",
    generation: 1,
    stateEpoch: 2,
    activeTurnId: null,
    lastAppliedOperationKey: "operation-applied",
    currentPresentationKey: "presentation-1",
    revision: 0,
    currentLeafId: "1.1",
    totalNodeCount: 8,
    confirmedCount: 0,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    lastReconciledHash: null,
    lastOutputLength: 0,
    lastOutputItemIds: [],
    lastTurnUserText: null,
    lastTurnAttachmentCount: 0,
    awaitingResponseSince: null,
    packageRevision: null,
    packageTaskId: null,
    packageOutputItemId: null,
    packageFileId: null,
    packageFilename: null,
    packageDescriptorHash: null,
    logoStorageKey: null,
    logoSha256: LOGO_HASH,
    logoBytes: 100,
    logoFilename: "official-logo.png",
    logoMimeType: "image/png",
    packageStorageKey: null,
    packageArchiveSha256: null,
    packageSizeBytes: null,
    protocolErrorCode: null,
    protocolError: null,
    publishedSnapshotId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T11:59:00.000Z"),
    completedAt: null,
    publishedAt: null,
  } as KnowledgeBaseBuild;
  const result = { ...base, ...overrides };
  if (!("logoStorageKey" in overrides)) {
    result.logoStorageKey = knowledgeBuildArtifactStorageKey({
      userId: result.userId,
      buildId: result.id,
      generation: result.generation,
      kind: "logo",
    });
  }
  return result;
}

function readyBuildFixture(
  overrides: Partial<KnowledgeBaseBuild> = {},
): KnowledgeBaseBuild {
  const result = buildFixture({
    status: "ready_to_publish",
    currentLeafId: null,
    currentPresentationKey: null,
    revision: 8,
    confirmedCount: 8,
    packageRevision: 8,
    packageTaskId: "task-current",
    packageFilename: "knowledge-base.zip",
    packageArchiveSha256: PACKAGE_HASH,
    packageSizeBytes: 1_024,
    completedAt: new Date("2026-08-01T11:00:00.000Z"),
    ...overrides,
  });
  if (!("packageStorageKey" in overrides)) {
    result.packageStorageKey = knowledgeBuildArtifactStorageKey({
      userId: result.userId,
      buildId: result.id,
      generation: result.generation,
      kind: "package",
    });
  }
  return result;
}

function nodeFixture(
  overrides: Partial<KnowledgeBaseBuildNode> = {},
): KnowledgeBaseBuildNode {
  const content = "## 1.1 一句话定位\n\nFrontMind 超前智能。";
  return {
    id: uuid(101),
    buildId: uuid(1),
    leafId: "1.1",
    branchId: "identity",
    branchTitle: "企业身份",
    title: "一句话定位",
    ordinal: 0,
    status: "current",
    transitionReason: null,
    contentMarkdown: content,
    lastUserInput: null,
    sourceUrls: [],
    imageUrls: [],
    lastTaskId: "task-current",
    sourceTurnId: uuid(201),
    presentationKey: "presentation-1",
    contentSha256: knowledgeBaseMarkdownSha256(content),
    lastResponseAt: NOW,
    confirmedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as KnowledgeBaseBuildNode;
}

function turnFixture(
  overrides: Partial<ConversationTurn> = {},
): ConversationTurn {
  return {
    id: uuid(201),
    conversationId: "u7:conversation-1",
    userId: 7,
    apiCredentialId: null,
    clientRequestId: "request-1",
    buildId: uuid(1),
    buildGeneration: 1,
    operationKey: "operation-1",
    operationType: "confirm",
    expectedRevision: 0,
    expectedLeafId: "1.1",
    requestHash: "d".repeat(64),
    upstreamIdempotencyKeyHash: "e".repeat(64),
    attachmentFileIds: [],
    metadata: {},
    leaseExpiresAt: new Date("2026-08-01T12:05:00.000Z"),
    model: "FrontMind-Pro",
    status: "running",
    upstreamTaskId: "task-1",
    errorCode: null,
    errorMessage: null,
    startedAt: new Date("2026-08-01T11:59:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-08-01T11:59:00.000Z"),
    updatedAt: new Date("2026-08-01T11:59:00.000Z"),
    ...overrides,
  } as ConversationTurn;
}

function dataset(
  values: Partial<KnowledgeBaseRolloutAuditDataset>,
): KnowledgeBaseRolloutAuditDataset {
  return {
    builds: values.builds || [],
    turns: values.turns || [],
    nodes: values.nodes || [],
    snapshots: values.snapshots || [],
  };
}

function codes(violations: readonly { code: string }[]) {
  return violations.map((violation) => violation.code);
}

describe("knowledge-base rollout state audit", () => {
  it("detects concurrent turns, one operation creating multiple tasks and expired leases", () => {
    const build = buildFixture({ activeTurnId: uuid(201) });
    const turns = [
      turnFixture({
        id: uuid(201),
        operationKey: "same-operation",
        upstreamTaskId: "task-a",
        leaseExpiresAt: new Date("2026-08-01T11:00:00.000Z"),
      }),
      turnFixture({
        id: uuid(202),
        clientRequestId: "request-2",
        operationKey: "same-operation",
        upstreamTaskId: "task-b",
      }),
    ];
    const result = findKnowledgeBaseRolloutViolations(
      dataset({ builds: [build], turns, nodes: [nodeFixture()] }),
      { now: NOW },
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "MULTIPLE_ACTIVE_TURNS",
        "OPERATION_MULTIPLE_UPSTREAM_TASKS",
        "EXPIRED_TURN_LEASE",
      ]),
    );
  });

  it("detects settled non-convergence, missing presentation, timeout and stale protocol errors", () => {
    const settledBuild = buildFixture({
      id: uuid(2),
      status: "researching",
      currentLeafId: null,
      currentPresentationKey: null,
      activeTurnId: uuid(211),
      awaitingResponseSince: new Date("2026-08-01T10:00:00.000Z"),
    });
    const settledTurn = turnFixture({
      id: uuid(211),
      buildId: settledBuild.id,
      status: "completed",
      completedAt: new Date("2026-08-01T10:01:00.000Z"),
    });
    const missingBuild = buildFixture({
      id: uuid(3),
      updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const missingNode = nodeFixture({
      id: uuid(103),
      buildId: missingBuild.id,
      contentMarkdown: null,
      contentSha256: null,
    });
    const staleBuild = buildFixture({
      id: uuid(4),
      status: "confirming",
    });
    const staleTurn = turnFixture({
      id: uuid(212),
      buildId: staleBuild.id,
      status: "failed",
      errorCode: "STALE_REVISION",
      errorMessage: "redacted customer-facing text",
      updatedAt: new Date("2026-08-01T11:00:00.000Z"),
    });
    const result = findKnowledgeBaseRolloutViolations(
      dataset({
        builds: [settledBuild, missingBuild, staleBuild],
        turns: [settledTurn, staleTurn],
        nodes: [missingNode, nodeFixture({ buildId: staleBuild.id })],
      }),
      { now: NOW, since: new Date("2026-08-01T00:00:00.000Z") },
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "SETTLED_TURN_NOT_CONVERGED",
        "AWAITING_INPUT_WITHOUT_APPROVED_PRESENTATION",
        "PRESENTATION_TIMEOUT",
        "STALE_OR_DUPLICATE_PROTOCOL_ERROR",
      ]),
    );
  });

  it("detects node, Logo, package and ready-publication integrity drift", () => {
    const build = readyBuildFixture({
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      completedAt: new Date("2026-07-30T10:00:00.000Z"),
      logoSha256: "not-a-sha",
      packageStorageKey: "wrong/package/path.zip",
    });
    const node = nodeFixture({
      status: "confirmed",
      contentSha256: "f".repeat(64),
    });
    const result = findKnowledgeBaseRolloutViolations(
      dataset({ builds: [build], nodes: [node] }),
      { now: NOW },
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "NODE_HASH_MISMATCH",
        "LOGO_BINDING_INVALID",
        "PACKAGE_BINDING_INVALID",
        "READY_PUBLICATION_TIMEOUT",
      ]),
    );
  });

  it("detects an invalid published binding before treating publication as successful", () => {
    const build = readyBuildFixture({
      status: "published",
      publishedSnapshotId: uuid(901),
      publishedAt: NOW,
    });
    const result = findKnowledgeBaseRolloutViolations(
      dataset({ builds: [build] }),
      { now: NOW },
    );
    expect(codes(result)).toContain("PUBLICATION_BINDING_INVALID");
  });

  it("compares an authenticated published snapshot with all eight node hashes", () => {
    const build = readyBuildFixture({
      status: "published",
      publishedSnapshotId: uuid(902),
      publishedAt: NOW,
    });
    const nodes = Array.from({ length: 8 }, (_, ordinal) => {
      const leafId = `1.${ordinal + 1}`;
      const content = `## ${leafId} Node ${ordinal + 1}\n\nApproved ${ordinal + 1}.`;
      return nodeFixture({
        id: uuid(300 + ordinal),
        leafId,
        ordinal,
        title: `Node ${ordinal + 1}`,
        status: "confirmed",
        contentMarkdown: content,
        contentSha256: knowledgeBaseMarkdownSha256(content),
        presentationKey: `presentation-${ordinal + 1}`,
      });
    });
    const documents = nodes.map((node) => ({
      id: node.leafId,
      path: `leaves/${node.leafId}.md`,
      kind: "leaf" as const,
      title: node.title,
      branchId: node.branchId,
      branchTitle: node.branchTitle,
      order: node.ordinal,
      customerVisible: true,
      content: node.contentMarkdown!,
    }));
    documents[3]!.content = "substituted content";
    const snapshot = {
      id: build.publishedSnapshotId,
      userId: build.userId,
      version: 1,
      sourceFileName: "knowledge-base.zip",
      sourceConversationId: build.conversationId,
      sourceBuildId: build.id,
      sourceBuildRevision: build.revision,
      sourceTaskId: build.upstreamTaskId,
      sourceArtifactHash: PACKAGE_HASH,
      archiveHash: PACKAGE_HASH,
      maintenanceTicketId: null,
      documents,
      assets: [
        {
          id: "logo",
          key: "logo.png",
          path: "visual_assets/logo.png",
          mimeType: "image/png",
          size: 100,
          sha256: LOGO_HASH,
        },
      ],
      documentCount: 8,
      imageCount: 1,
      characterCount: 100,
      totalBytes: build.packageSizeBytes,
      status: "active",
      createdByUserId: build.userId,
      createdAt: NOW,
    } as KnowledgeBaseSnapshot;
    const result = findKnowledgeBaseRolloutViolations(
      dataset({ builds: [build], nodes, snapshots: [snapshot] }),
      { now: NOW },
    );
    expect(codes(result)).toContain("PUBLISHED_PACKAGE_NODE_HASH_MISMATCH");
  });
});

describe("knowledge-base rollout artifact/download audit", () => {
  it("reports unreadable Logo and ZIP bytes without exposing their content", async () => {
    const build = readyBuildFixture();
    const readBuildArtifact = vi.fn(async () => {
      throw new Error("secret payload and customer Markdown");
    });
    const result = await findKnowledgeBaseRolloutArtifactViolations(
      dataset({ builds: [build] }),
      {
        readBuildArtifact,
        readSnapshotArchive: vi.fn(async () => Buffer.alloc(1)),
      },
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "LOGO_INTEGRITY_MISMATCH",
        "PACKAGE_INTEGRITY_MISMATCH",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("secret payload");
    expect(JSON.stringify(result)).not.toContain("customer Markdown");
  });

  it("reports a published archive that cannot be downloaded", async () => {
    const build = readyBuildFixture({
      status: "published",
      publishedSnapshotId: uuid(903),
      publishedAt: NOW,
    });
    const snapshot = {
      id: build.publishedSnapshotId,
      userId: build.userId,
      archiveHash: PACKAGE_HASH,
      totalBytes: build.packageSizeBytes,
    } as KnowledgeBaseSnapshot;
    const result = await findKnowledgeBaseRolloutArtifactViolations(
      dataset({ builds: [build], snapshots: [snapshot] }),
      {
        readBuildArtifact: vi.fn(async () => Buffer.alloc(1)),
        readSnapshotArchive: vi.fn(async () => {
          throw new Error("download failed with signed URL");
        }),
      },
    );
    expect(codes(result)).toContain("PUBLISHED_DOWNLOAD_FAILED");
  });
});
