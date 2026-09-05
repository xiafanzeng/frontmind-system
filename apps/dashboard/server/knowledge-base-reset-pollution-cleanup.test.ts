import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type {
  Conversation,
  ConversationTurn,
  KnowledgeBaseBuild,
} from "../drizzle/schema";
import {
  inspectResetPollutionCleanupFacts,
  planResetPollutionCleanupTransaction,
  type ResetPollutionCleanupFacts,
} from "./knowledge-base-reset-pollution-cleanup";

const now = new Date("2026-08-13T06:39:00.000Z");
const userId = 7;
const conversationId = "conversation-1439";
const buildId = "build-1439";
const turnId = "turn-1439";
const resetRequestId = "reset-approved";
const filenames = Array.from(
  { length: 8 },
  (_, index) => `source-${index + 1}.pdf`,
);
const manifests = filenames.map((filename, index) => ({
  itemId: `upload-operation-${index + 1}`,
  filename,
  mimeType: "application/pdf",
  sizeBytes: 11 + index,
  sha256: String(index + 1).repeat(64),
  ordinal: index + 1,
  total: 8,
}));
const staged = {
  index: 0,
  file_id: "local-staged-file-1",
  filename: filenames[0]!,
  managedIntentId: "managed-intent-1",
  itemId: manifests[0]!.itemId,
  mimeType: manifests[0]!.mimeType,
  sizeBytes: manifests[0]!.sizeBytes,
  contentSha256: manifests[0]!.sha256,
  localStorageKey: `knowledge-base/build-sources/${userId}/${buildId}/g1/${manifests[0]!.sha256}.bin`,
};

function facts(): ResetPollutionCleanupFacts {
  return {
    resetRevision: 3,
    resetRequest: {
      id: resetRequestId,
      userId,
      status: "approved",
      decidedAt: new Date("2026-08-13T06:30:00.000Z"),
    },
    build: {
      id: buildId,
      userId,
      conversationId,
      companyName: "Customer",
      companyWebsite: null,
      upstreamTaskId: null,
      providerProtocol: "manus_v2",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      treePolicyVersion: 2,
      initialResearchCoverage: null,
      status: "researching",
      generation: 1,
      stateEpoch: 1,
      activeTurnId: turnId,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      lastAppliedOperationKey: null,
      currentPresentationKey: null,
      revision: 0,
      currentLeafId: null,
      totalNodeCount: 0,
      confirmedCount: 0,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "",
      lastTurnAttachmentCount: 8,
      awaitingResponseSince: now,
      packageRevision: null,
      packageTaskId: null,
      packageOutputItemId: null,
      packageFileId: null,
      packageFilename: null,
      packageDescriptorHash: null,
      skillArchiveSha256: "b".repeat(64),
      skillArchiveBytes: 1,
      skillArchiveStorageKey: "skill.zip",
      contentCompletedAt: null,
      packageStatus: "not_started",
      packageAttemptCount: 0,
      packageNextRetryAt: null,
      packageLastErrorCode: null,
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      logoFilename: null,
      logoMimeType: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      protocolErrorCode: null,
      protocolError: null,
      publishedSnapshotId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      publishedAt: null,
    } satisfies KnowledgeBaseBuild,
    conversation: {
      id: `u${userId}:${conversationId}`,
      userId,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      title: "Knowledge base",
      status: "running",
      upstreamTaskId: null,
      previousResponseId: null,
      taskUrl: null,
      lastKnownOutputLength: 0,
      deletedMessageIds: [],
      version: 1,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    } satisfies Conversation,
    turn: {
      id: turnId,
      conversationId: `u${userId}:${conversationId}`,
      userId,
      apiCredentialId: "credential-1",
      clientRequestId: "request-1439",
      buildId,
      buildGeneration: 1,
      operationKey: "operation-1439",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: "c".repeat(64),
      upstreamIdempotencyKeyHash: "d".repeat(64),
      attachmentFileIds: [staged.file_id],
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: true,
        expectedAttachmentCount: 10,
        userAttachmentCount: 8,
        clientStagedAttachments: [staged],
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        operationToken: "operation-1439",
        dispatchState: "reserved",
        recoveryAction: "wait",
        canRegenerate: false,
        recovery: {
          kind: "start",
          deferredClientAttachments: true,
          attachmentManifest: manifests,
          attachments: [{ file_id: staged.file_id, filename: staged.filename }],
          attachmentSourceProofs: [
            {
              index: staged.index,
              fileId: staged.file_id,
              filename: staged.filename,
              managedIntentId: staged.managedIntentId,
              itemId: staged.itemId,
              mimeType: staged.mimeType,
              sizeBytes: staged.sizeBytes,
              contentSha256: staged.contentSha256,
              localStorageKey: staged.localStorageKey,
            },
          ],
        },
      },
      leaseExpiresAt: null,
      model: null,
      status: "queued",
      upstreamTaskId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies ConversationTurn,
    nodeCount: 0,
    acceptedReceiptCount: 0,
    pendingUserMessageCount: 1,
    messageCount: 1,
    attachmentCount: 0,
    upstreamResourceCount: 1,
    upstreamFileCleanup: {
      upstreamId: staged.file_id,
      apiCredentialId: "credential-1",
      upstreamIdSha256: createHash("sha256")
        .update(staged.file_id)
        .digest("hex"),
      apiCredentialIdSha256: createHash("sha256")
        .update("credential-1")
        .digest("hex"),
    },
    messageStateSha256: "f".repeat(64),
    attachmentStateSha256: "0".repeat(64),
    uploadProof: {
      intentCount: 2,
      stateSha256: "e".repeat(64),
      retired: false,
      items: [
        {
          intentIdSha256: createHash("sha256")
            .update(staged.managedIntentId)
            .digest("hex"),
          operationIdSha256: createHash("sha256")
            .update(staged.itemId)
            .digest("hex"),
          credentialIdSha256: createHash("sha256")
            .update("credential-1")
            .digest("hex"),
          ordinal: 1,
          total: 8,
          state: "uploaded",
          providerGeneration: 1,
          safeErrorCode: null,
          fileIdSha256: createHash("sha256")
            .update(staged.file_id)
            .digest("hex"),
          sizeBytes: staged.sizeBytes,
          sha256: staged.contentSha256,
        },
        {
          intentIdSha256: createHash("sha256")
            .update("managed-intent-2")
            .digest("hex"),
          operationIdSha256: createHash("sha256")
            .update(manifests[1]!.itemId)
            .digest("hex"),
          credentialIdSha256: createHash("sha256")
            .update("credential-1")
            .digest("hex"),
          ordinal: 2,
          total: 8,
          state: "expired",
          providerGeneration: 0,
          safeErrorCode: "UPLOAD_BROWSER_STAGE_EXPIRED",
          fileIdSha256: null,
          sizeBytes: null,
          sha256: null,
        },
      ],
    },
  };
}

const input = {
  userId,
  conversationId,
  buildId,
  resetRequestId,
  expectedResetRevision: 3,
};

describe("reset-pollution strict cleanup facts", () => {
  it("accepts only the exact mixed uploaded/browser-incomplete reset pollution", () => {
    expect(inspectResetPollutionCleanupFacts(input, facts())).toMatchObject({
      status: "eligible",
      stateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      counts: {
        builds: 1,
        conversations: 1,
        turns: 1,
        nodes: 0,
        acceptedReceipts: 0,
        uploadIntents: 2,
        upstreamResources: 1,
        upstreamFilesToDelete: 1,
        localAssetsToDelete: 1,
      },
    });
    expect(planResetPollutionCleanupTransaction(input, facts())).toEqual({
      tombstone: true,
      deleteAttachments: 0,
      deleteMessages: 1,
      deleteTurns: 1,
      deleteConversation: 1,
      deleteBuild: 1,
      nextResetRevision: 4,
    });
  });

  it.each([
    [
      "reset revision drift",
      (value: ResetPollutionCleanupFacts) => (value.resetRevision = 4),
    ],
    [
      "provider create edge",
      (value: ResetPollutionCleanupFacts) =>
        ((value.turn.metadata as any).createAttemptState = "sending"),
    ],
    [
      "task identity",
      (value: ResetPollutionCleanupFacts) =>
        (value.turn.upstreamTaskId = "task"),
    ],
    [
      "upstream file identity mismatch",
      (value: ResetPollutionCleanupFacts) =>
        (value.upstreamFileCleanup!.upstreamId = "different-file"),
    ],
    [
      "uploaded intent receipt mismatch",
      (value: ResetPollutionCleanupFacts) =>
        (value.uploadProof.items[0]!.fileIdSha256 = "a".repeat(64)),
    ],
    [
      "unexpected attachment row",
      (value: ResetPollutionCleanupFacts) => (value.attachmentCount = 1),
    ],
    ["node", (value: ResetPollutionCleanupFacts) => (value.nodeCount = 1)],
    [
      "accepted receipt",
      (value: ResetPollutionCleanupFacts) => (value.acceptedReceiptCount = 1),
    ],
    [
      "wrong reset request",
      (value: ResetPollutionCleanupFacts) => (value.resetRequest.id = "other"),
    ],
  ])("rejects %s without broadening cleanup", (_label, mutate) => {
    const value = facts();
    mutate(value);
    expect(() => inspectResetPollutionCleanupFacts(input, value)).toThrow(
      "KB_RESET_POLLUTION_PREDICATE_NOT_MET",
    );
  });
});
