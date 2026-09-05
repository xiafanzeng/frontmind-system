import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  localAssets,
  messages,
  providerFileLeases,
  upstreamResources,
  userUsageOwners,
  type ConversationTurn,
} from "../drizzle/schema";
import {
  activateKnowledgeBaseManusV2Handoff,
  assertKnowledgeBaseLocalUploadCoordinate,
  KnowledgeBaseTurnReservationError,
  beginKnowledgeBaseManusV2Dispatch,
  beginKnowledgeBaseMaterializedCompletionStop,
  bindKnowledgeBaseManusV2Submission,
  cancelIncompleteKnowledgeBaseRevision,
  cancelIncompleteKnowledgeBaseStart,
  cancelUnpreparedKnowledgeBaseTurn,
  completeKnowledgeBaseGeneratedAttachment,
  createKnowledgeBaseGeneratedAttachmentIdempotencyKey,
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  evaluateKnowledgeBaseTurnReplay,
  failKnowledgeBaseMaterializedResultForApprovedReset,
  failKnowledgeBaseTurnDeterministically,
  deferKnowledgeBaseMaterializedResultRead,
  deferKnowledgeBaseMaterializedProviderStatus,
  finalizeKnowledgeBaseManusV2AttachmentMappings,
  findReusableKnowledgeBaseSkillFileId,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredAttachmentReservation,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseLegacyStartReplay,
  inspectKnowledgeBaseTurnReplay,
  inspectKnowledgeBaseRetryAuthority,
  inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority,
  knowledgeBaseRetryRequiresFreshFinalDelivery,
  markKnowledgeBaseTurnOutcomeUnknown,
  markKnowledgeBaseManusV2OutcomeUnknown,
  observeKnowledgeBaseMaterializedCompletionCandidate,
  observeKnowledgeBaseMaterializedResultDiagnostic,
  pauseKnowledgeBasePreCreateCredentialUnavailable,
  persistKnowledgeBaseManusV2AttachmentAttempt,
  persistKnowledgeBaseManusV2AttachmentOutcomeUnknown,
  persistKnowledgeBaseManusV2AttachmentMapping,
  prepareKnowledgeBaseTurnDispatch,
  promoteKnowledgeBaseGeneratedAttachmentReady,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseFailedNotSentLegacyHandoff,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseDeferredTurnAttachment,
  sanitizeKnowledgeBaseRecoveryMetadata,
  settleKnowledgeBaseManusV2ExplicitRejection,
  settleKnowledgeBasePreCreateFailureForApprovedReset,
  settleKnowledgeBaseMaterializedCompletionStopAttempt,
} from "./knowledge-base-turn-service";
import {
  KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";
import { knowledgeBaseLocalAssetIdentity } from "./knowledge-base-local-asset-upload";

const KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV = "FRONTMIND_KB_MANUS_V2_WRITER";

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const { metadata: metadataOverride, ...rowOverrides } = overrides;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "u1:conversation-1",
    userId: 1,
    apiCredentialId: "credential-1",
    clientRequestId: "request-1",
    buildId: "00000000-0000-4000-8000-000000000002",
    buildGeneration: 3,
    operationKey: "operation-1",
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
    requestHash: "a".repeat(64),
    upstreamIdempotencyKeyHash: "b".repeat(64),
    attachmentFileIds: [],
    metadata: {
      attachmentsFrozen: true,
      materializedRecoveryContractVersion: 1,
      ...(metadataOverride || {}),
    },
    leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
    model: null,
    status: "queued",
    upstreamTaskId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...rowOverrides,
  };
}

const identity = {
  buildId: "00000000-0000-4000-8000-000000000002",
  buildGeneration: 3,
  operationKey: "operation-1",
  operationType: "confirm" as const,
  expectedRevision: 7,
  expectedLeafId: "1.8",
  requestHash: "a".repeat(64),
  apiCredentialId: "credential-1",
};

const currentMaterializedRecoveryBuildAuthority = {
  executionMode: "materialized_bundle_v1",
  skillVersion: "5",
  skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
  contentVersion: 1,
  providerProtocol: "manus_v2",
  handoffProvenance: {
    materializedRecoveryContractVersion: 1,
    materializedCompletionContractVersion: 2,
    sourceResetRevision: 0,
    authorizedAt: "2026-08-01T00:00:00.000Z",
  },
} as const;

type TurnSelection =
  | ConversationTurn[]
  | ((store: TurnServiceStore) => ConversationTurn[]);

interface TurnServiceStore {
  build: any | null;
  conversation: any | null;
  turns: ConversationTurn[];
  messages: any[];
  credentials: any[];
  tombstones: any[];
  retainedTombstones: any[];
  resources: any[];
  localAssets: any[];
  providerFileLeases: any[];
  snapshots: any[];
  nodes: any[];
  usageOwnerId: number | null;
  resetRevision: number;
}

function createTurnServiceExecutor(input: {
  build?: any;
  conversation?: any;
  turns?: ConversationTurn[];
  messages?: any[];
  credentials?: any[];
  tombstones?: any[];
  retainedTombstones?: any[];
  resources?: any[];
  localAssets?: any[];
  providerFileLeases?: any[];
  snapshots?: any[];
  nodes?: any[];
  usageOwnerId?: number | null;
  resetRevision?: number;
  selectAllMessages?: boolean;
  turnSelections: TurnSelection[][];
  failConversationInsertAtTransaction?: number;
}) {
  const store: TurnServiceStore = {
    build: input.build || null,
    conversation: input.conversation || null,
    turns: [...(input.turns || [])],
    messages: structuredClone(input.messages || []),
    credentials: [
      ...(input.credentials || [
        {
          id: "credential-1",
          userId: 1,
          status: "active",
          version: 1,
        },
      ]),
    ],
    tombstones: [...(input.tombstones || [])],
    retainedTombstones: [...(input.retainedTombstones || [])],
    resources: [...(input.resources || [])],
    localAssets: [...(input.localAssets || [])],
    providerFileLeases: [...(input.providerFileLeases || [])],
    snapshots: [...(input.snapshots || [])],
    nodes: structuredClone(input.nodes || []),
    usageOwnerId: input.usageOwnerId ?? null,
    resetRevision: input.resetRevision ?? 0,
  };
  const events: string[] = [];
  let transactionIndex = 0;
  const executor = {
    transaction: async (run: (tx: any) => Promise<unknown>) => {
      const currentTransaction = transactionIndex++;
      const snapshot = structuredClone(store);
      let turnSelectionIndex = 0;
      let lastSelectedTurn: ConversationTurn | undefined;
      let messageSelectionIndex = 0;
      const turnSelections = input.turnSelections[currentTransaction] || [];
      const selected = (
        table: unknown,
        condition?: unknown,
        options: { peekTurn?: boolean } = {},
      ) => {
        if (table === knowledgeBaseBuilds) {
          return store.build ? [store.build] : [];
        }
        if (table === conversations) {
          return store.conversation ? [store.conversation] : [];
        }
        if (table === apiCredentials) {
          return store.credentials;
        }
        if (table === conversationTurns) {
          const selection =
            turnSelections[
              options.peekTurn ? turnSelectionIndex : turnSelectionIndex++
            ] || [];
          const rows =
            typeof selection === "function" ? selection(store) : selection;
          if (!options.peekTurn) lastSelectedTurn = rows[0];
          return rows;
        }
        if (table === knowledgeBaseConversationTombstones) {
          return store.tombstones;
        }
        if (table === knowledgeBaseConversationRetentionTombstones) {
          return store.retainedTombstones;
        }
        if (table === knowledgeBaseResetStates) {
          return [{ userId: 1, revision: store.resetRevision }];
        }
        if (table === knowledgeBaseSnapshots) {
          return store.snapshots;
        }
        if (table === messages) {
          if (input.selectAllMessages) return store.messages;
          const isIdentityLookup = messageSelectionIndex++ % 2 === 0;
          if (!isIdentityLookup) return store.messages;
          const latestTurn = store.turns.at(-1);
          const expectedId = latestTurn
            ? `u${latestTurn.userId}:msg-kb-user-${latestTurn.id}`
            : "";
          return store.messages.filter((message) => message.id === expectedId);
        }
        if (table === knowledgeBaseBuildNodes) {
          return store.nodes;
        }
        if (table === upstreamResources) {
          return store.resources;
        }
        if (table === localAssets) {
          return store.localAssets;
        }
        if (table === userUsageOwners) {
          return store.usageOwnerId == null
            ? []
            : [{ deliveryAdminId: store.usageOwnerId }];
        }
        return [];
      };
      const selectionBuilder = (
        table: unknown,
        condition?: unknown,
        options: { peekTurn?: boolean } = {},
      ) => ({
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(selected(table, condition, options)).then(
            resolve,
            reject,
          ),
        limit: () => ({
          for: async () => {
            if (table === upstreamResources) {
              events.push("start-attachments:lock");
            }
            return selected(table, condition, options);
          },
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(selected(table, condition, options)).then(
              resolve,
              reject,
            ),
        }),
        orderBy: () => {
          const ordered = () =>
            [...selected(table)].sort((left: any, right: any) => {
              if (typeof left.ordinal === "number") {
                return left.ordinal - right.ordinal;
              }
              return right.sequence - left.sequence;
            });
          return {
            limit: async () => ordered(),
            then: (
              resolve: (value: unknown) => unknown,
              reject: (reason: unknown) => unknown,
            ) => Promise.resolve(ordered()).then(resolve, reject),
          };
        },
      });
      const tx = {
        select: (projection?: unknown) => ({
          from: (table: unknown) => ({
            where: (condition: unknown) =>
              selectionBuilder(table, condition, {
                peekTurn:
                  table === conversationTurns && projection !== undefined,
              }),
          }),
        }),
        insert: (table: unknown) => ({
          values: (values: any) => {
            if (table === knowledgeBaseBuilds && !store.build) {
              store.build = {
                upstreamTaskId: null,
                activeTurnId: null,
                protocolErrorCode: null,
                protocolError: null,
                currentLeafId: null,
                ...values,
              };
            } else if (table === conversations && !store.conversation) {
              if (
                input.failConversationInsertAtTransaction === currentTransaction
              ) {
                throw new Error("simulated conversation insert failure");
              }
              store.conversation = {
                deletedAt: null,
                ...values,
              };
            } else if (table === conversationTurns) {
              store.turns.push(values as ConversationTurn);
              events.push("turn:insert");
            } else if (table === messages) {
              store.messages.push(values);
            } else if (table === upstreamResources) {
              store.resources.push(values);
            } else if (table === providerFileLeases) {
              store.providerFileLeases.push(values);
            } else if (table === knowledgeBaseConversationRetentionTombstones) {
              store.retainedTombstones.push(values);
            }
            return {
              onDuplicateKeyUpdate: async () => undefined,
            };
          },
        }),
        update: (table: unknown) => ({
          set: (values: any) => ({
            where: async () => {
              if (table === knowledgeBaseBuilds && store.build) {
                store.build = { ...store.build, ...values };
              } else if (table === conversations && store.conversation) {
                store.conversation = { ...store.conversation, ...values };
              } else if (table === conversationTurns && lastSelectedTurn) {
                const index = store.turns.findIndex(
                  (candidate) => candidate.id === lastSelectedTurn!.id,
                );
                if (index >= 0) {
                  store.turns[index] = {
                    ...store.turns[index],
                    ...values,
                  } as ConversationTurn;
                  lastSelectedTurn = store.turns[index];
                }
              } else if (table === upstreamResources) {
                store.resources = store.resources.map((resource) => ({
                  ...resource,
                  ...values,
                }));
                events.push("start-attachments:bind");
              } else if (table === knowledgeBaseResetStates) {
                store.resetRevision = Number(values.revision);
              }
              return [{ affectedRows: 1 }];
            },
          }),
        }),
        delete: (table: unknown) => ({
          where: async () => {
            if (table === knowledgeBaseBuilds) {
              store.build = null;
              store.nodes = [];
              store.turns = store.turns.map((candidate) => ({
                ...candidate,
                buildId: null,
              }));
            } else if (table === conversations) {
              store.conversation = null;
              store.messages = [];
              store.turns = [];
            }
            return [{ affectedRows: 1 }];
          },
        }),
      };
      try {
        const result = await run(tx);
        events.push("transaction:commit");
        return result;
      } catch (error) {
        store.build = snapshot.build;
        store.conversation = snapshot.conversation;
        store.turns = snapshot.turns;
        store.messages = snapshot.messages;
        store.credentials = snapshot.credentials;
        store.tombstones = snapshot.tombstones;
        store.retainedTombstones = snapshot.retainedTombstones;
        store.resources = snapshot.resources;
        store.localAssets = snapshot.localAssets;
        store.providerFileLeases = snapshot.providerFileLeases;
        store.snapshots = snapshot.snapshots;
        store.nodes = snapshot.nodes;
        store.usageOwnerId = snapshot.usageOwnerId;
        store.resetRevision = snapshot.resetRevision;
        throw error;
      }
    },
  };
  return { executor, store, events };
}

function retryableFailedTurn(overrides: Partial<ConversationTurn> = {}) {
  const operationKey = createKnowledgeBaseOperationKey({
    buildId: "00000000-0000-4000-8000-000000000002",
    buildGeneration: 3,
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
  });
  const recovery = {
    kind: "turn",
    conversationId: "conversation-1",
    parentTaskId: "successful-parent-task",
    userMessage: "确认",
    attachments: [{ file_id: "facts-file", filename: "facts.pdf" }],
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
  };
  const requestBody = {
    prompt: "failed prompt",
    agentProfile: "manus-1.6-max",
    taskMode: "agent" as const,
    taskId: "successful-parent-task",
    attachments: [
      { file_id: "skill-file", filename: "skill.zip" },
      { file_id: "facts-file", filename: "facts.pdf" },
    ],
  };
  const failed = turn({
    status: "failed",
    operationKey,
    requestHash: hashKnowledgeBaseTurnRequest({
      operationType: "confirm",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      expectedAttachmentCount: 2,
      userAttachmentCount: 1,
      payload: {
        userMessage: recovery.userMessage,
        attachments: recovery.attachments,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      },
    }),
    upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ),
    upstreamTaskId: "failed-task-must-not-be-reused",
    completedAt: new Date("2026-08-01T00:00:20.000Z"),
    leaseExpiresAt: null,
    attachmentFileIds: ["skill-file", "facts-file"],
    metadata: {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 1,
      failureClass: "terminal_requires_regeneration",
      recoveryAction: "regenerate_turn",
      canRegenerate: true,
      recovery,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
        preparedAt: "2026-08-01T00:00:10.000Z",
      },
    },
    ...overrides,
  });
  return failed;
}

function failedNotSentLegacyHandoffTurn(
  overrides: Partial<ConversationTurn> = {},
) {
  const operationKey = createKnowledgeBaseOperationKey({
    buildId: identity.buildId,
    buildGeneration: 3,
    operationType: "confirm",
    expectedRevision: 7,
    expectedLeafId: "1.8",
  });
  const recovery = {
    kind: "turn",
    conversationId: "conversation-1",
    parentTaskId: "legacy-main-task",
    userMessage: "确认",
    attachments: [] as Array<{ file_id: string; filename: string }>,
    attachmentManifest: [] as unknown[],
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
  };
  const requestBody = {
    prompt: "historical prompt that was never sent",
    agentProfile: "frontmind-pro",
    taskMode: "agent" as const,
    taskId: "legacy-main-task",
    attachments: [
      { file_id: "stale-skill-file", filename: "skill.zip" },
      {
        file_id: "stale-instructions-file",
        filename: "instructions.txt",
      },
    ],
  };
  return turn({
    operationKey,
    requestHash: hashKnowledgeBaseTurnRequest({
      operationType: "confirm",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      payload: {
        userMessage: recovery.userMessage,
        attachments: recovery.attachments,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      },
    }),
    upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ),
    status: "failed",
    upstreamTaskId: null,
    leaseExpiresAt: null,
    completedAt: new Date("2026-08-01T00:00:20.000Z"),
    attachmentFileIds: requestBody.attachments.map((item) => item.file_id),
    metadata: {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      createAttemptState: "not_sent",
      providerProtocol: "legacy_v1",
      providerAttemptState: "not_sent",
      dispatchState: "failed",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
      recovery,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
        preparedAt: "2026-08-01T00:00:10.000Z",
      },
    },
    ...overrides,
  });
}

describe("failed not-sent legacy business handoff", () => {
  function legacyBuild(source: ConversationTurn) {
    return {
      id: identity.buildId,
      userId: 1,
      conversationId: "conversation-1",
      companyName: "Example",
      companyWebsite: null,
      upstreamTaskId: "legacy-main-task",
      providerProtocol: "legacy_v1",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      handoffProvenance: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      skillArchiveSha256: null,
      skillArchiveBytes: null,
      skillArchiveStorageKey: null,
      treePolicyVersion: 2,
      status: "protocol_error",
      generation: 3,
      stateEpoch: 7,
      revision: 7,
      currentLeafId: "1.8",
      activeTurnId: source.id,
      protocolErrorCode: "SKILL_FILE_404",
      protocolError: "historical local failure",
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      totalNodeCount: 40,
      confirmedCount: 7,
      directPrefilledCount: 0,
      needsVerificationCount: 0,
      lastReconciledHash: null,
      lastOutputLength: 0,
      lastOutputItemIds: [],
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
      awaitingResponseSince: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:20.000Z"),
      completedAt: null,
      publishedAt: null,
    } as any;
  }

  const localProof = async () => [];

  it("proves only exact never-sent history and rejects sending/unknown state", () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    expect(
      inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(source, build),
    ).not.toBeNull();
    for (const metadataPatch of [
      { createAttemptState: "sending", providerAttemptState: "sending" },
      {
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        outcomeUnknownAt: "2026-08-01T00:00:10.000Z",
      },
      {
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
      },
    ]) {
      const candidate = {
        ...source,
        metadata: { ...(source.metadata as object), ...metadataPatch },
      } as ConversationTurn;
      expect(
        inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(
          candidate,
          build,
        ),
      ).toBeNull();
    }
  });

  it("creates one hidden replacement with no second customer message or charge", async () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    const conversation = {
      id: source.conversationId,
      userId: source.userId,
      apiCredentialId: source.apiCredentialId,
      projectAssignmentId: null,
      status: "failed",
      version: 9,
      deletedAt: null,
      deletedMessageIds: [],
    };
    const sourceSelection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === source.id);
    const harness = createTurnServiceExecutor({
      build,
      conversation,
      turns: [source],
      turnSelections: [[sourceSelection, sourceSelection]],
    });
    const serviceDb = {
      ...harness.executor,
      select: (...args: any[]) => {
        const projection = args[0];
        return {
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === knowledgeBaseBuilds
                  ? [harness.store.build]
                  : projection === undefined
                    ? [harness.store.turns[0]]
                    : [],
            }),
          }),
        };
      },
    };
    const result = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      serviceDb,
      { proveLocalSources: localProof as any },
    );

    expect(result.state).toBe("reserved");
    expect(harness.store.turns).toHaveLength(2);
    expect(harness.store.messages).toEqual([]);
    expect(harness.store.turns[0]).toMatchObject({
      status: "cancelled",
      metadata: { supersededReason: "legacy_failed_not_sent_handoff" },
    });
    expect(harness.store.turns[1]).toMatchObject({
      operationType: "confirm",
      status: "queued",
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        repairKind: "legacy_failed_not_sent_handoff",
        hiddenReplacement: true,
        chargeDisposition: "reuse_original_no_charge",
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      },
    });
    expect(harness.store.build).toMatchObject({
      activeTurnId: result.replacementTurnId,
      providerProtocol: "legacy_v1",
      status: "confirming",
    });

    const replay = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
      },
      serviceDb,
      {
        proveLocalSources: async () => {
          throw new Error("a duplicate worker must not repeat local proof");
        },
      },
    );
    expect(replay).toEqual({
      state: "already_reserved",
      sourceTurnId: source.id,
      replacementTurnId: result.replacementTurnId,
      buildId: build.id,
    });
    expect(harness.store.turns).toHaveLength(2);
    expect(harness.store.messages).toEqual([]);
  });

  it("uses one current credential and generation+1 when the never-sent pinned credential was deleted", async () => {
    const source = failedNotSentLegacyHandoffTurn();
    const build = legacyBuild(source);
    const sourceSelection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === source.id);
    const harness = createTurnServiceExecutor({
      build,
      conversation: {
        id: source.conversationId,
        userId: source.userId,
        apiCredentialId: source.apiCredentialId,
        projectAssignmentId: null,
        status: "failed",
        version: 9,
        deletedAt: null,
        deletedMessageIds: [],
      },
      turns: [source],
      credentials: [
        { id: "credential-1", userId: 1, status: "deleted" },
        { id: "credential-current", userId: 1, status: "active" },
      ],
      turnSelections: [[sourceSelection, sourceSelection]],
    });
    const serviceDb = {
      ...harness.executor,
      select: (...args: any[]) => {
        const projection = args[0];
        return {
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === knowledgeBaseBuilds
                  ? [harness.store.build]
                  : projection === undefined
                    ? [harness.store.turns[0]]
                    : [],
            }),
          }),
        };
      },
    };

    const result = await reserveKnowledgeBaseFailedNotSentLegacyHandoff(
      {
        userId: 1,
        buildId: build.id,
        sourceTurnId: source.id,
        expectedGeneration: 3,
        expectedStateEpoch: 7,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        replacementCredentialId: "credential-current",
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      serviceDb,
      { proveLocalSources: localProof as any },
    );

    expect(result.state).toBe("reserved");
    expect(harness.store.turns[0]).toMatchObject({
      status: "cancelled",
      buildGeneration: 3,
    });
    expect(harness.store.turns[1]).toMatchObject({
      apiCredentialId: "credential-current",
      buildGeneration: 4,
      upstreamTaskId: null,
      metadata: {
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        receiptSourceGeneration: 3,
        credentialRebound: true,
      },
    });
    expect(harness.store.build).toMatchObject({
      generation: 4,
      activeTurnId: result.replacementTurnId,
      providerProtocol: "legacy_v1",
      handoffProvenance: {
        sourceGeneration: 3,
        targetGeneration: 4,
        receiptSourceGeneration: 3,
      },
    });
    expect(harness.store.conversation).toMatchObject({
      apiCredentialId: "credential-current",
      status: "running",
    });
  });
});

describe("Manus v2 canonical task writer fence", () => {
  const build = (overrides: Record<string, unknown> = {}) => ({
    id: identity.buildId,
    userId: 1,
    conversationId: "conversation-1",
    companyName: "Example",
    companyWebsite: null,
    upstreamTaskId: null,
    providerProtocol: "manus_v2",
    canonicalTaskId: null,
    canonicalTaskGeneration: null,
    canonicalCredentialId: null,
    canonicalTaskState: "unbound",
    canonicalTaskUrl: null,
    canonicalTaskCreatedAt: null,
    handoffProvenance: {
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
    },
    contentVersion: 1,
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "c".repeat(64),
    treePolicyVersion: 2,
    initialResearchCoverage: null,
    status: "confirming",
    generation: 3,
    stateEpoch: 7,
    activeTurnId: "00000000-0000-4000-8000-000000000001",
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    lastAppliedOperationKey: null,
    currentPresentationKey: "presentation-7",
    revision: 7,
    currentLeafId: "1.8",
    totalNodeCount: 30,
    confirmedCount: 7,
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
    skillArchiveSha256: null,
    skillArchiveBytes: null,
    skillArchiveStorageKey: null,
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
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    completedAt: null,
    publishedAt: null,
    ...overrides,
  });

  it("settles an unbound create outcome-unknown to reset on the next durable sweep", async () => {
    const leaseToken = "materialized-create-unknown-lease";
    const active = turn({
      status: "running",
      upstreamTaskId: null,
      leaseExpiresAt: new Date("2026-08-17T00:00:30.000Z"),
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256").update(leaseToken).digest("hex"),
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "sending",
        createAttemptState: "sending",
        frozenProviderRequestHash: "f".repeat(64),
        operationToken: "operation-materialized-create-unknown",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        ...currentMaterializedRecoveryBuildAuthority,
        canonicalTaskState: "creating",
      }),
      conversation: {
        id: active.conversationId,
        userId: active.userId,
        projectAssignmentId: null,
        version: 1,
        status: "running",
      },
      turns: [active],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });

    await markKnowledgeBaseManusV2OutcomeUnknown(
      {
        userId: 1,
        turnId: active.id,
        leaseToken,
        code: "MANUS_V2_CREATE_OUTCOME_UNKNOWN",
        now: new Date("2026-08-17T00:00:00.000Z"),
        recoveryDelayMs: 1_000,
      },
      harness.executor,
    );
    expect(harness.store.turns[0]).toMatchObject({
      status: "running",
      upstreamTaskId: null,
      metadata: {
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        outcomeUnknownCode: "MANUS_V2_CREATE_OUTCOME_UNKNOWN",
      },
    });
    await expect(
      markKnowledgeBaseManusV2OutcomeUnknown(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          code: "MANUS_V2_CREATE_OUTCOME_UNKNOWN",
          now: new Date("2026-08-17T00:00:00.500Z"),
        },
        harness.executor,
      ),
    ).resolves.toEqual({ deduplicated: true });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: active.id,
          now: new Date("2026-08-17T00:00:02.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "RESET_REQUIRED",
      leaseExpiresAt: null,
      metadata: {
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        dispatchState: "failed",
        recoveryAction: "approve_reset",
        manusV2Lifecycle: { attentionCode: "RESET_REQUIRED" },
      },
    });
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "RESET_REQUIRED",
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: active.id,
          now: new Date("2026-08-17T00:00:03.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.build.stateEpoch).toBe(8);
  });

  it("persists a bounded hash-only deterministic result replay fence", async () => {
    const leaseToken = "materialized-result-diagnostic-lease";
    const taskId = "exact-materialized-result-task";
    const descriptorHash = "d".repeat(64);
    const archiveSha = "a".repeat(64);
    const active = turn({
      status: "running",
      upstreamTaskId: taskId,
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256").update(leaseToken).digest("hex"),
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        operationToken: "operation-materialized-result-diagnostic",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        ...currentMaterializedRecoveryBuildAuthority,
        upstreamTaskId: taskId,
        canonicalTaskState: "running",
      }),
      turns: [active],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });
    const observe = (failure = false) =>
      observeKnowledgeBaseMaterializedResultDiagnostic(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          taskId,
          descriptorHash,
          archiveSha,
          resultProcessingStage: failure
            ? "canonical_validation"
            : "archive_safety",
          ...(failure
            ? {
                firstTypedFailureCode:
                  "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
                deterministicFailure: true,
              }
            : {}),
          now: new Date(
            failure ? "2026-08-17T00:00:01.000Z" : "2026-08-17T00:00:00.000Z",
          ),
        },
        harness.executor,
      );

    await expect(observe()).resolves.toMatchObject({
      skipNormalization: false,
    });
    await expect(observe(true)).resolves.toMatchObject({
      skipNormalization: false,
    });
    await expect(observe()).resolves.toMatchObject({
      skipNormalization: true,
      diagnostic: {
        descriptorHash,
        archiveSha,
        resultProcessingStage: "canonical_validation",
        firstTypedFailureCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
        deterministicFailure: true,
      },
    });
    const interruptedArchiveSha = "b".repeat(64);
    await expect(
      observeKnowledgeBaseMaterializedResultDiagnostic(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          taskId,
          descriptorHash,
          archiveSha: interruptedArchiveSha,
          resultProcessingStage: "archive_safety",
          now: new Date("2026-08-17T00:00:02.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ skipNormalization: false });
    const restartedLeaseToken = "materialized-result-restarted-lease";
    harness.store.turns[0]!.metadata = {
      ...(harness.store.turns[0]!.metadata as Record<string, unknown>),
      leaseOwnerHash: createHash("sha256")
        .update(restartedLeaseToken)
        .digest("hex"),
    };
    await expect(
      observeKnowledgeBaseMaterializedResultDiagnostic(
        {
          userId: 1,
          turnId: active.id,
          leaseToken: restartedLeaseToken,
          taskId,
          descriptorHash,
          archiveSha: interruptedArchiveSha,
          resultProcessingStage: "archive_safety",
          now: new Date("2026-08-17T00:00:03.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      skipNormalization: true,
      diagnostic: {
        archiveSha: interruptedArchiveSha,
        firstTypedFailureCode: "KNOWLEDGE_BASE_RESULT_PROCESSING_INTERRUPTED",
        deterministicFailure: true,
      },
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      materializedResultDiagnostics: {
        schemaVersion: 1,
        descriptorHash,
        archiveSha: interruptedArchiveSha,
        resultProcessingStage: "archive_safety",
        firstTypedFailureCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
      },
    });
    const candidates = (harness.store.turns[0]?.metadata as any)
      .materializedResultDiagnostics.candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorHash,
          archiveSha,
          deterministicFailure: true,
        }),
        expect.objectContaining({
          descriptorHash,
          archiveSha: interruptedArchiveSha,
          firstTypedFailureCode: "KNOWLEDGE_BASE_RESULT_PROCESSING_INTERRUPTED",
          deterministicFailure: true,
        }),
      ]),
    );
    expect(JSON.stringify(harness.store.turns[0]?.metadata)).not.toContain(
      "https://",
    );
  });

  it("keeps source ids frozen until every ready v2 mapping commits atomically", async () => {
    const leaseToken = "v2-attachment-ledger-lease";
    const customerAssetId = `asset_${"c".repeat(30)}`;
    const sourceAttachments = [
      { file_id: "source-skill", filename: "skill.zip" },
      { file_id: customerAssetId, filename: "facts.pdf" },
    ];
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: sourceAttachments,
    };
    const activeTurn = turn({
      attachmentFileIds: sourceAttachments.map((item) => item.file_id),
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 40 }, () => [
        (store) => store.turns,
      ]),
    });
    const expiresAt = Math.floor(Date.parse("2026-08-01T01:00:00Z") / 1_000);
    const mapping = (
      attachmentIndex: number,
      sourceFileId: string,
      filename: string,
      upstreamFileId: string,
    ) => ({
      schemaVersion: 1 as const,
      providerProtocol: "manus_v2" as const,
      mappingKey: `g3:${attachmentIndex}:${"d".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex,
      sourceFileId,
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"d".repeat(64)}.bin`,
      contentSha256: "d".repeat(64),
      sizeBytes: 123,
      filename,
      mimeType: "application/octet-stream",
      upstreamFileId,
      status: "ready" as const,
      expiresAt,
      providerGeneration: 1,
      verifiedAt: "2026-08-01T00:00:20.000Z",
    });
    const first = mapping(0, "source-skill", "skill.zip", "v2-skill");
    const second = mapping(1, customerAssetId, "facts.pdf", "v2-facts");
    const persistAcceptedAttempt = async (target: typeof first) => {
      const base = {
        schemaVersion: 1 as const,
        mappingKey: target.mappingKey,
        buildGeneration: target.buildGeneration,
        attachmentIndex: target.attachmentIndex,
        sourceFileId: target.sourceFileId,
        localStorageKey: target.localStorageKey,
        contentSha256: target.contentSha256,
        sizeBytes: target.sizeBytes,
        filename: target.filename,
        mimeType: target.mimeType,
        providerGeneration: target.providerGeneration,
        code: null,
        recordedAt: "2026-08-01T00:00:15.000Z",
      };
      const persist = (attempt: any) =>
        persistKnowledgeBaseManusV2AttachmentAttempt(
          { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
          harness.executor,
        );
      await persist({
        ...base,
        state: "creating",
        upstreamFileId: null,
        uploadExpiresAt: null,
      });
      await persist({
        ...base,
        state: "candidate_created",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
      await persist({
        ...base,
        state: "put_sending",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
      await persist({
        ...base,
        state: "put_accepted",
        upstreamFileId: target.upstreamFileId,
        uploadExpiresAt: expiresAt,
      });
    };

    await persistAcceptedAttempt(first);
    await persistKnowledgeBaseManusV2AttachmentMapping(
      { userId: 1, turnId: activeTurn.id, leaseToken, mapping: first },
      harness.executor,
    );
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "source-skill",
      customerAssetId,
    ]);
    await expect(
      finalizeKnowledgeBaseManusV2AttachmentMappings(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          mappings: [first],
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "source-skill",
      customerAssetId,
    ]);

    await persistAcceptedAttempt(second);
    await persistKnowledgeBaseManusV2AttachmentMapping(
      { userId: 1, turnId: activeTurn.id, leaseToken, mapping: second },
      harness.executor,
    );
    await finalizeKnowledgeBaseManusV2AttachmentMappings(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        mappings: [first, second],
        now: new Date("2026-08-01T00:00:30.000Z"),
      },
      harness.executor,
    );
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual([
      "v2-skill",
      "v2-facts",
    ]);
    expect(
      (harness.store.turns[0]!.metadata as any).manusV2AttachmentMappings,
    ).toMatchObject({
      [first.mappingKey]: first,
      [second.mappingKey]: second,
    });
    expect(harness.store.providerFileLeases).toEqual([
      expect.objectContaining({
        localAssetId: customerAssetId,
        apiCredentialId: "credential-1",
        credentialVersion: 1,
        providerFileId: "v2-facts",
        uploadState: "uploaded",
      }),
    ]);
  });

  it("freezes an ambiguous v2 file side effect without promoting or retrying its slot", async () => {
    const leaseToken = "v2-file-outcome-unknown-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns]],
    });
    const attempt = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"e".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"e".repeat(64)}.bin`,
      contentSha256: "e".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      providerGeneration: 1,
      state: "outcome_unknown" as const,
      code: "KNOWLEDGE_BASE_MANUS_V2_FILE_OUTCOME_UNKNOWN",
      recordedAt: "2026-08-01T00:00:20.000Z",
    };

    await expect(
      persistKnowledgeBaseManusV2AttachmentOutcomeUnknown(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      ),
    ).resolves.toEqual(attempt);
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual(["source-facts"]);
    expect(harness.store.turns[0]!.metadata).toMatchObject({
      manusV2AttachmentUnknownAttempts: {
        [attempt.mappingKey]: attempt,
      },
      dispatchState: "recovering",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MANUS_V2_FILE_OUTCOME_UNKNOWN",
    });
  });

  it("fences a v2 file before create, pins its id before PUT, and caps replacement at two generations", async () => {
    const leaseToken = "v2-file-candidate-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 16 }, () => [
        (store) => store.turns,
      ]),
    });
    const base = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"f".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"f".repeat(64)}.bin`,
      contentSha256: "f".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      code: null,
      recordedAt: "2026-08-01T00:00:20.000Z",
    };
    const persist = (attempt: any) =>
      persistKnowledgeBaseManusV2AttachmentAttempt(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      );
    await persist({
      ...base,
      providerGeneration: 1,
      state: "creating",
      upstreamFileId: null,
      uploadExpiresAt: null,
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId: "candidate-one",
        uploadExpiresAt: 2_000_000_000,
      }),
    ).resolves.toMatchObject({ upstreamFileId: "candidate-one" });
    expect(harness.store.turns[0]!.attachmentFileIds).toEqual(["source-facts"]);
    expect(harness.store.resources).toEqual([
      expect.objectContaining({
        kind: "file",
        upstreamId: "candidate-one",
        apiCredentialId: "credential-1",
      }),
    ]);
    await expect(
      persist({
        ...base,
        providerGeneration: 1,
        state: "candidate_created",
        upstreamFileId: "different-candidate",
        uploadExpiresAt: 2_000_000_000,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await persist({
      ...base,
      providerGeneration: 1,
      state: "unusable",
      upstreamFileId: "candidate-one",
      uploadExpiresAt: 2_000_000_000,
      code: "MANUS_V2_FILE_NOT_FOUND",
    });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "creating",
      upstreamFileId: null,
      uploadExpiresAt: null,
    });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "create_rejected",
      upstreamFileId: null,
      uploadExpiresAt: null,
      code: "MANUS_V2_FILE_CREATE_HTTP_429",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 3,
        state: "creating",
        upstreamFileId: null,
        uploadExpiresAt: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("allows exactly one replacement after file.create outcome loss", async () => {
    const leaseToken = "v2-file-create-loss-lease";
    const preparedBody = {
      prompt: "continue",
      agentProfile: "frontmind-pro",
      attachments: [{ file_id: "source-facts", filename: "facts.pdf" }],
    };
    const activeTurn = turn({
      attachmentFileIds: ["source-facts"],
      metadata: {
        providerProtocol: "manus_v2",
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: preparedBody,
          bodySha256: hashKnowledgeBaseTurnRequest(preparedBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build(),
      turns: [activeTurn],
      turnSelections: Array.from({ length: 12 }, () => [
        (store) => store.turns,
      ]),
    });
    const base = {
      schemaVersion: 1 as const,
      mappingKey: `g3:0:${"9".repeat(64)}:123`,
      buildGeneration: 3,
      attachmentIndex: 0,
      sourceFileId: "source-facts",
      localStorageKey: `knowledge-base/build-sources/1/${identity.buildId}/g3/${"9".repeat(64)}.bin`,
      contentSha256: "9".repeat(64),
      sizeBytes: 123,
      filename: "facts.pdf",
      mimeType: "application/pdf",
      upstreamFileId: null,
      uploadExpiresAt: null,
      recordedAt: "2026-08-01T00:00:20.000Z",
    };
    const persist = (attempt: any) =>
      persistKnowledgeBaseManusV2AttachmentAttempt(
        { userId: 1, turnId: activeTurn.id, leaseToken, attempt },
        harness.executor,
      );
    await persist({
      ...base,
      providerGeneration: 1,
      state: "creating",
      code: null,
    });
    await persist({
      ...base,
      providerGeneration: 1,
      state: "create_outcome_unknown",
      code: "MANUS_V2_FILE_CREATE_TRANSPORT_UNKNOWN",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 2,
        state: "creating",
        code: null,
      }),
    ).resolves.toMatchObject({ providerGeneration: 2, state: "creating" });
    await persist({
      ...base,
      providerGeneration: 2,
      state: "create_outcome_unknown",
      code: "MANUS_V2_FILE_CREATE_TRANSPORT_UNKNOWN",
    });
    await expect(
      persist({
        ...base,
        providerGeneration: 3,
        state: "creating",
        code: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects materialized Provider authorization without immutable birth authority", async () => {
    const leaseToken = "missing-materialized-birth-authority";
    const activeTurn = turn({
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: undefined,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "not_sent",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        ...currentMaterializedRecoveryBuildAuthority,
        activeTurnId: activeTurn.id,
        handoffProvenance: null,
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });

    await expect(
      beginKnowledgeBaseManusV2Dispatch(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          frozenProviderRequestHash: "d".repeat(64),
          expectedMethod: "task.create",
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "not_sent",
    });
  });

  it.skip("retires canonical-task post-2xx bind recovery", async () => {
    const leaseToken = "post-ack-bind-failure-lease";
    const activeTurn = turn({
      status: "running",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "sending",
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "sending",
        operationToken: "operation-1",
        frozenProviderRequestHash: "d".repeat(64),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskState: "creating",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
      }),
      turns: [activeTurn],
      turnSelections: [
        [(store) => store.turns],
        [(store) => store.turns],
        [(store) => store.turns],
      ],
    });
    const markedAt = new Date("2026-08-01T00:00:30.000Z");
    const providerPost = async () => "provider-accepted-task";
    let providerPostCount = 0;
    const postOnce = async () => {
      providerPostCount += 1;
      return providerPost();
    };
    await expect(postOnce()).resolves.toBe("provider-accepted-task");

    await markKnowledgeBaseManusV2OutcomeUnknown(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        code: "MANUS_V2_BIND_PERSISTENCE_UNKNOWN",
        recoveryDelayMs: 1_000,
        now: markedAt,
      },
      harness.executor,
    );
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "unknown",
      providerAttemptState: "outcome_unknown",
      operationToken: "operation-1",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "reconciling",
    });

    const recovered = await claimKnowledgeBaseTurnForRecovery(
      {
        turnId: activeTurn.id,
        now: new Date("2026-08-01T00:00:31.001Z"),
      },
      harness.executor,
    );
    expect(recovered?.turn).toMatchObject({
      createAttemptState: "acknowledged",
      providerProtocol: "manus_v2",
      providerMethod: "task.create",
      providerAttemptState: "output_pending",
      operationToken: "operation-1",
    });

    await expect(
      beginKnowledgeBaseManusV2Dispatch(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken: recovered!.leaseToken,
          frozenProviderRequestHash: "d".repeat(64),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_PENDING" });
    expect(providerPostCount).toBe(1);
  });

  it("never downgrades an acknowledged task to create outcome-unknown", async () => {
    const leaseToken = "acknowledged-create-is-monotonic";
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "bound-materialized-task",
      metadata: {
        attachmentsFrozen: true,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        createAttemptState: "acknowledged",
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        upstreamTaskId: "bound-materialized-task",
        canonicalTaskState: "active",
      }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns]],
    });

    await expect(
      markKnowledgeBaseManusV2OutcomeUnknown(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          code: "RESULT_PROCESSING_MUST_NOT_REOPEN_CREATE",
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns[0]).toMatchObject({
      upstreamTaskId: "bound-materialized-task",
      metadata: expect.objectContaining({
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
      }),
    });
  });

  it("commits one crash-safe legacy handoff digest and resumes it idempotently", async () => {
    const leaseToken = "handoff-lease";
    const snapshotSha256 = "f".repeat(64);
    const activeTurn = turn({
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "legacy_v1",
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({ providerProtocol: "legacy_v1" }),
      turns: [activeTurn],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });

    await expect(
      activateKnowledgeBaseManusV2Handoff(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          snapshotSha256,
          legacyTaskIdSha256: "e".repeat(64),
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ migrated: true, snapshotSha256 });
    expect(harness.store.build).toMatchObject({
      providerProtocol: "manus_v2",
      canonicalTaskState: "unbound",
      canonicalTaskId: null,
      handoffProvenance: {
        schemaVersion: 1,
        sourceProtocol: "legacy_v1",
        snapshotSha256,
        pendingTurnId: activeTurn.id,
      },
    });
    expect(harness.store.turns[0]!.metadata).toMatchObject({
      providerProtocol: "manus_v2",
      providerAttemptState: "not_sent",
      operationToken: activeTurn.operationKey,
      repairKind: "legacy_handoff",
    });

    await expect(
      activateKnowledgeBaseManusV2Handoff(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          snapshotSha256,
        },
        harness.executor,
      ),
    ).resolves.toEqual({ migrated: false, snapshotSha256 });
  });

  it("atomically rejects one invalid materialized result, releases recovery, and deduplicates the settlement", async () => {
    const leaseToken = "materialized-result-invalid-lease";
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "canonical-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        manusV2AttachmentMappings: {
          "0": { preservedProviderMapping: true },
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 1,
        upstreamTaskId: "canonical-task",
        canonicalTaskId: null,
        canonicalTaskGeneration: null,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
        status: "researching",
        stateEpoch: 21,
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 4,
      },
      turns: [activeTurn],
      turnSelections: [[current], [current], [current]],
    });
    const input = {
      userId: activeTurn.userId,
      turnId: activeTurn.id,
      leaseToken,
      code: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID" as const,
      now: new Date("2026-08-01T00:05:00.000Z"),
    };

    const first = await failKnowledgeBaseMaterializedResultForApprovedReset(
      input,
      harness.executor,
    );
    const replay = await failKnowledgeBaseMaterializedResultForApprovedReset(
      input,
      harness.executor,
    );

    expect(first).toMatchObject({
      deduplicated: false,
      turn: {
        status: "failed",
        providerAttemptState: "result_rejected",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        canRegenerate: false,
      },
    });
    expect(replay.deduplicated).toBe(true);
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      activeTurnId: null,
      upstreamTaskId: "canonical-task",
      canonicalTaskId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
      stateEpoch: 22,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      awaitingResponseSince: null,
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: "canonical-task",
      leaseExpiresAt: null,
      errorCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
      metadata: {
        providerAttemptState: "result_rejected",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        canRegenerate: false,
        manusV2AttachmentMappings: {
          "0": { preservedProviderMapping: true },
        },
      },
    });
    expect(harness.store.conversation).toMatchObject({
      status: "failed",
      upstreamTaskId: "canonical-task",
      version: 5,
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: activeTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.build?.stateEpoch).toBe(22);
    expect(harness.store.conversation?.version).toBe(5);
  });

  it("rejects an ad-hoc materialized result code before opening a transaction", async () => {
    await expect(
      failKnowledgeBaseMaterializedResultForApprovedReset(
        {
          userId: 1,
          turnId: "00000000-0000-4000-8000-000000000001",
          leaseToken: "unused",
          code: "HASH_MISMATCH_WITH_PRIVATE_DETAIL" as any,
        },
        {
          transaction: () => {
            throw new Error("transaction must not open");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("backs off transient materialized result reads and terminalizes at the ten-minute boundary", async () => {
    const leaseToken = "materialized-result-read-lease";
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "canonical-task",
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 1,
        upstreamTaskId: "canonical-task",
        canonicalTaskId: null,
        canonicalTaskGeneration: null,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "active",
        status: "researching",
        stateEpoch: 30,
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: activeTurn.userId,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 8,
      },
      turns: [activeTurn],
      turnSelections: [
        [current],
        [current],
        [current],
        [current],
        [current],
        [current],
      ],
    });
    const startedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const deferAt = (offsetMs: number) =>
      deferKnowledgeBaseMaterializedResultRead(
        {
          userId: activeTurn.userId,
          turnId: activeTurn.id,
          leaseToken,
          lastErrorKind: "HTTP_503",
          now: new Date(startedAt + offsetMs),
        },
        harness.executor,
      );

    await expect(deferAt(0)).resolves.toMatchObject({
      state: "deferred",
      attempt: 1,
      retryAfterMs: 15_000,
      deduplicated: false,
    });
    await expect(deferAt(1_000)).resolves.toMatchObject({
      state: "deferred",
      attempt: 1,
      retryAfterMs: 14_000,
      deduplicated: true,
    });
    await expect(deferAt(15_000)).resolves.toMatchObject({
      state: "deferred",
      attempt: 2,
      retryAfterMs: 30_000,
    });
    await expect(deferAt(45_000)).resolves.toMatchObject({
      state: "deferred",
      attempt: 3,
      retryAfterMs: 60_000,
    });
    await expect(deferAt(105_000)).resolves.toMatchObject({
      state: "deferred",
      attempt: 4,
      retryAfterMs: 120_000,
    });
    await expect(deferAt(600_000)).resolves.toMatchObject({
      state: "unavailable",
      deduplicated: false,
      turn: {
        status: "failed",
        providerAttemptState: "result_rejected",
        recoveryAction: "approve_reset",
      },
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      materializedResultRead: {
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        attempt: 4,
        lastErrorKind: "HTTP_503",
      },
    });
    expect(
      (harness.store.turns[0]?.metadata as any).materializedResultRead,
    ).not.toHaveProperty("nextRetryAt");
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
      stateEpoch: 31,
    });
    expect(harness.store.conversation).toMatchObject({
      status: "failed",
      version: 9,
    });
  });

  it("stages only a birth-marked materialized completion candidate and records its immutable proof", async () => {
    const leaseToken = "materialized-completion-candidate-lease";
    const now = new Date("2026-08-01T00:05:00.000Z");
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T00:10:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 1,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      turns: [activeTurn],
      turnSelections: [[current], [current]],
    });

    const observed = await observeKnowledgeBaseMaterializedCompletionCandidate(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        candidateEventIdHash: "d".repeat(64),
        storageKey:
          "knowledge-base/build-sources/1/00000000-0000-4000-8000-000000000002/g3/candidate.bin",
        candidateArchiveSha256: "e".repeat(64),
        sizeBytes: 1234,
        providerStatus: "running",
        now,
      },
      harness.executor,
    );

    expect(observed).toMatchObject({
      disposition: "stabilizing",
      deduplicated: false,
      ledger: {
        schemaVersion: 1,
        candidateEventIdHash: "d".repeat(64),
        candidateArchiveSha256: "e".repeat(64),
        sizeBytes: 1234,
        firstObservedAt: now.toISOString(),
        lastObservedAt: now.toISOString(),
      },
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      materializedCompletionContractVersion: 2,
      materializedCompletion: observed.ledger,
      dispatchState: "recovering",
      recoveryAction: "wait",
    });

    const rotatedDescriptor =
      await observeKnowledgeBaseMaterializedCompletionCandidate(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          candidateEventIdHash: "f".repeat(64),
          storageKey: observed.ledger.storageKey!,
          candidateArchiveSha256: observed.ledger.candidateArchiveSha256!,
          sizeBytes: observed.ledger.sizeBytes!,
          providerStatus: "running",
          now: new Date("2026-08-01T00:05:31.000Z"),
        },
        harness.executor,
      );

    expect(rotatedDescriptor).toMatchObject({
      disposition: "natural_stop_wait",
      deduplicated: true,
      ledger: {
        candidateEventIdHash: "f".repeat(64),
        firstObservedAt: now.toISOString(),
        stableAt: "2026-08-01T00:05:31.000Z",
      },
    });
  });

  it("journals task.stop at most once and converts a replayed sending state to read-only outcome_unknown", async () => {
    const leaseToken = "materialized-completion-stop-lease";
    const now = new Date("2026-08-01T00:05:00.000Z");
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T00:10:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        materializedCompletion: {
          schemaVersion: 1,
          candidateEventIdHash: "d".repeat(64),
          storageKey:
            "knowledge-base/build-sources/1/00000000-0000-4000-8000-000000000002/g3/candidate.bin",
          candidateArchiveSha256: "e".repeat(64),
          sizeBytes: 1234,
          firstObservedAt: "2026-08-01T00:00:00.000Z",
          lastObservedAt: "2026-08-01T00:02:30.000Z",
          stableAt: "2026-08-01T00:00:30.000Z",
          naturalStopDeadlineAt: "2026-08-01T00:02:30.000Z",
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 1,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      turns: [activeTurn],
      turnSelections: [[current], [current], [current], [current]],
    });
    const stopInput = {
      userId: 1,
      turnId: activeTurn.id,
      leaseToken,
      now,
    };
    const first = await beginKnowledgeBaseMaterializedCompletionStop(
      stopInput,
      harness.executor,
    );
    const replay = await beginKnowledgeBaseMaterializedCompletionStop(
      stopInput,
      harness.executor,
    );
    const unknown = await settleKnowledgeBaseMaterializedCompletionStopAttempt(
      { ...stopInput, state: "outcome_unknown" },
      harness.executor,
    );
    const unknownReplay =
      await settleKnowledgeBaseMaterializedCompletionStopAttempt(
        {
          ...stopInput,
          state: "outcome_unknown",
          now: new Date("2026-08-01T00:08:00.000Z"),
        },
        harness.executor,
      );

    expect(first.send).toBe(true);
    expect(first.ledger).toMatchObject({
      stopAttemptState: "sending",
      stopSettleDeadlineAt: "2026-08-01T00:07:00.000Z",
    });
    expect(replay.send).toBe(false);
    expect(unknown).toMatchObject({
      deduplicated: false,
      ledger: { stopAttemptState: "outcome_unknown" },
    });
    expect(unknownReplay.deduplicated).toBe(true);
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      materializedCompletion: {
        stopAttemptState: "outcome_unknown",
        stopAttemptedAt: now.toISOString(),
        stopSettleDeadlineAt: "2026-08-01T00:15:00.000Z",
      },
    });
  });

  it("never replaces or clears a candidate after task.stop authority is spent", async () => {
    const leaseToken = "materialized-completion-immutable-stop-candidate";
    const activeTurn = turn({
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T01:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        materializedCompletion: {
          schemaVersion: 1,
          lastStatus: "running",
          activeRunningMs: 30_000,
          runningObservedAt: "2026-08-01T00:00:30.000Z",
          candidateEventIdHash: "a".repeat(64),
          storageKey: "knowledge-base/build-sources/1/original.bin",
          candidateArchiveSha256: "b".repeat(64),
          sizeBytes: 1234,
          firstObservedAt: "2026-08-01T00:00:00.000Z",
          lastObservedAt: "2026-08-01T00:00:30.000Z",
          stableAt: "2026-08-01T00:00:30.000Z",
          naturalStopDeadlineAt: "2026-08-01T00:02:30.000Z",
          stopAttemptState: "acknowledged",
          stopAttemptedAt: "2026-08-01T00:02:30.000Z",
          stopSettleDeadlineAt: "2026-08-01T00:04:30.000Z",
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      turns: [activeTurn],
      turnSelections: [[current], [current]],
    });

    await expect(
      observeKnowledgeBaseMaterializedCompletionCandidate(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          candidateEventIdHash: "c".repeat(64),
          storageKey: "knowledge-base/build-sources/1/replacement.bin",
          candidateArchiveSha256: "d".repeat(64),
          sizeBytes: 4321,
          providerStatus: "running",
          now: new Date("2026-08-01T00:03:00.000Z"),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "running",
          resetCandidate: true,
          now: new Date("2026-08-01T00:03:00.000Z"),
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      materializedCompletion: {
        candidateEventIdHash: "a".repeat(64),
        candidateArchiveSha256: "b".repeat(64),
        stopAttemptState: "acknowledged",
      },
    });
  });

  it("keeps a contract-v2 initial task waiting inside the healthy no-progress window", async () => {
    const leaseToken = "materialized-completion-deadline-lease";
    const activeTurn = turn({
      operationType: "start",
      expectedLeafId: null,
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T04:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        materializedCompletion: {
          schemaVersion: 1,
          nextRetryAt: "2026-08-01T02:59:45.000Z",
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 2,
      },
      turns: [activeTurn],
      turnSelections: [[current]],
    });

    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "running",
          now: new Date("2026-08-01T00:14:59.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ state: "deferred" });
    expect(harness.store.build).toMatchObject({
      status: "researching",
      activeTurnId: activeTurn.id,
    });
    expect(
      (harness.store.turns[0]?.metadata as any).materializedCompletion,
    ).toHaveProperty("nextRetryAt");
    expect(
      (harness.store.turns[0]?.metadata as any).materializedCompletion,
    ).not.toHaveProperty("statusDeadlineAt");
  });

  it("makes a healthy materialized task resettable after fifteen minutes without machine-contract progress", async () => {
    const leaseToken = "materialized-completion-no-progress-lease";
    const activeTurn = turn({
      operationType: "start",
      expectedLeafId: null,
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T01:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        materializedCompletion: {
          schemaVersion: 1,
          lastStatus: "running",
          statusFirstObservedAt: "2026-08-01T00:00:00.000Z",
          activeRunningMs: 14 * 60_000,
          runningObservedAt: "2026-08-01T00:14:00.000Z",
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 2,
      },
      turns: [activeTurn],
      turnSelections: [[current]],
    });

    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "running",
          now: new Date("2026-08-01T00:15:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      state: "unavailable",
      turn: {
        status: "failed",
        providerAttemptState: "result_rejected",
        recoveryAction: "approve_reset",
      },
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      errorCode: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
      metadata: {
        canRegenerate: false,
        materializedCompletion: {
          activeRunningMs: 15 * 60_000,
          lastStatus: "running",
        },
      },
    });
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
    });
  });

  it("retains one 24-hour interruption window for waiting to exact quota and clears a lost candidate", async () => {
    const leaseToken = "materialized-completion-quota-lease";
    const activeTurn = turn({
      operationType: "start",
      expectedLeafId: null,
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-02T01:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
        materializedCompletion: {
          schemaVersion: 1,
          lastStatus: "running",
          activeRunningMs: 0,
          runningObservedAt: "2026-08-01T00:00:00.000Z",
          candidateEventIdHash: "a".repeat(64),
          storageKey: "knowledge-base/build-sources/1/lost-candidate.bin",
          candidateArchiveSha256: "b".repeat(64),
          sizeBytes: 25,
          firstObservedAt: "2026-08-01T00:00:00.000Z",
          lastObservedAt: "2026-08-01T00:00:30.000Z",
        },
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      turns: [activeTurn],
      turnSelections: [[current], [current], [current]],
    });

    const waiting = await deferKnowledgeBaseMaterializedProviderStatus(
      {
        userId: 1,
        turnId: activeTurn.id,
        leaseToken,
        status: "waiting",
        resetCandidate: true,
        now: new Date("2026-08-01T00:05:00.000Z"),
      },
      harness.executor,
    );
    expect(waiting).toMatchObject({
      state: "deferred",
      ledger: {
        lastStatus: "waiting",
        statusFirstObservedAt: "2026-08-01T00:05:00.000Z",
        statusDeadlineAt: "2026-08-02T00:05:00.000Z",
      },
    });
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      recoveryAction: "awaiting_input",
    });
    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "quota_error",
          now: new Date("2026-08-01T00:06:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      state: "deferred",
      ledger: {
        lastStatus: "quota_error",
        statusFirstObservedAt: "2026-08-01T00:05:00.000Z",
        statusDeadlineAt: "2026-08-02T00:05:00.000Z",
      },
    });
    const metadata = harness.store.turns[0]?.metadata as any;
    expect(metadata.recoveryAction).toBe("top_up");
    expect(metadata.materializedCompletion).not.toHaveProperty(
      "candidateEventIdHash",
    );
    expect(metadata.materializedCompletion).not.toHaveProperty("storageKey");
    expect(metadata.materializedCompletion).not.toHaveProperty(
      "candidateArchiveSha256",
    );

    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "running",
          now: new Date("2026-08-01T00:07:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      state: "deferred",
      ledger: {
        lastStatus: "running",
        statusFirstObservedAt: "2026-08-01T00:07:00.000Z",
        activeRunningMs: 5 * 60_000,
      },
    });
    expect(
      (harness.store.turns[0]?.metadata as any).materializedCompletion,
    ).not.toHaveProperty("statusDeadlineAt");
  });

  it("settles a non-quota provider error as contact-support attention rather than a bad-ZIP reset", async () => {
    const leaseToken = "materialized-provider-attention-lease";
    const activeTurn = turn({
      operationType: "start",
      expectedLeafId: null,
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T01:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 2,
      },
      turns: [activeTurn],
      turnSelections: [[current]],
    });

    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "error",
          now: new Date("2026-08-01T00:05:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({
      state: "unavailable",
      turn: {
        status: "failed",
        providerAttemptState: "output_pending",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
      },
    });
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      errorCode: "KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION",
      metadata: {
        providerAttemptState: "output_pending",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION",
    });
    expect(harness.store.build?.protocolError).toContain("请联系支持处理");
    expect(harness.store.build?.protocolError).not.toMatch(
      /(?:文件|完整性|重置)/u,
    );
    expect(harness.store.conversation).toMatchObject({ status: "failed" });
  });

  it.each(["unknown", "list_messages_404"] as const)(
    "bounds %s without candidate evidence to ten minutes",
    async (status) => {
      const leaseToken = `materialized-completion-${status}-lease`;
      const firstObserved = new Date("2026-08-01T00:05:00.000Z");
      const activeTurn = turn({
        operationType: "start",
        expectedLeafId: null,
        status: "running",
        upstreamTaskId: "completion-task",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        leaseExpiresAt: new Date("2026-08-01T01:00:00.000Z"),
        metadata: {
          attachmentsFrozen: true,
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
          leaseOwnerHash: createHash("sha256")
            .update(leaseToken, "utf8")
            .digest("hex"),
          providerProtocol: "manus_v2",
          providerMethod: "task.create",
          createAttemptState: "acknowledged",
          providerAttemptState: "output_pending",
          operationToken: "operation-1",
        },
      });
      const current = (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === activeTurn.id);
      const harness = createTurnServiceExecutor({
        build: build({
          executionMode: "materialized_bundle_v1",
          skillVersion: "5",
          contentVersion: 0,
          handoffProvenance: {
            materializedRecoveryContractVersion: 1,
            materializedCompletionContractVersion: 2,
          },
          upstreamTaskId: "completion-task",
          canonicalTaskId: null,
          status: "researching",
        }),
        turns: [activeTurn],
        turnSelections: [[current]],
      });

      await expect(
        deferKnowledgeBaseMaterializedProviderStatus(
          {
            userId: 1,
            turnId: activeTurn.id,
            leaseToken,
            status,
            now: firstObserved,
          },
          harness.executor,
        ),
      ).resolves.toMatchObject({
        state: "deferred",
        ledger: {
          lastStatus: status,
          statusFirstObservedAt: firstObserved.toISOString(),
          statusDeadlineAt: "2026-08-01T00:15:00.000Z",
        },
      });
    },
  );

  it("keeps a revision waiting inside the healthy no-progress window", async () => {
    const leaseToken = "materialized-completion-revision-deadline-lease";
    const activeTurn = turn({
      operationType: "revise",
      expectedLeafId: "01_company_overview/001-overview.md",
      status: "running",
      upstreamTaskId: "completion-task",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-08-01T02:00:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        operationToken: "operation-1",
      },
    });
    const current = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === activeTurn.id);
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 1,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
        },
        upstreamTaskId: "completion-task",
        canonicalTaskId: null,
        status: "researching",
      }),
      conversation: {
        id: activeTurn.conversationId,
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
        status: "running",
        deletedMessageIds: [],
        version: 2,
      },
      turns: [activeTurn],
      turnSelections: [[current]],
    });

    await expect(
      deferKnowledgeBaseMaterializedProviderStatus(
        {
          userId: 1,
          turnId: activeTurn.id,
          leaseToken,
          status: "running",
          now: new Date("2026-08-01T00:14:59.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toMatchObject({ state: "deferred" });
    expect(harness.store.build).toMatchObject({
      status: "researching",
      activeTurnId: activeTurn.id,
    });
  });

  it("projects a pre-cutover materialized turn as RESET_REQUIRED without acquiring a recovery lease", async () => {
    const legacyTurn = turn({
      status: "running",
      leaseExpiresAt: null,
      upstreamTaskId: "historical-bound-task",
      metadata: {
        attachmentsFrozen: true,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "outcome_unknown",
        createAttemptState: "unknown",
        materializedRecoveryContractVersion: 1,
        operationToken: "operation-1",
        recovery: { kind: "start" },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        contentVersion: 0,
        upstreamTaskId: "historical-bound-task",
        canonicalTaskState: "reconciling",
        handoffProvenance: { materializedRecoveryContractVersion: 1 },
      }),
      turns: [legacyTurn],
      turnSelections: [[(store) => store.turns], [(store) => store.turns]],
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: legacyTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();

    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      errorCode: "RESET_REQUIRED",
      leaseExpiresAt: null,
      metadata: {
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        manusV2Lifecycle: { attentionCode: "RESET_REQUIRED" },
      },
    });
    expect(harness.store.turns[0]?.metadata).not.toHaveProperty(
      "materializedCompletionContractVersion",
    );
    expect(harness.store.build).toMatchObject({
      status: "protocol_error",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "RESET_REQUIRED",
      stateEpoch: 8,
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: legacyTurn.id,
          now: new Date("2026-08-01T00:11:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.build?.stateEpoch).toBe(8);
  });

  it.skip("retires rejected canonical repair claims", async () => {
    const rejectedTurn = turn({
      status: "running",
      leaseExpiresAt: new Date("2026-08-01T01:00:00.000Z"),
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        providerReasonCategory: "invalid_argument",
        providerRejectionStatus: 400,
        providerRejectionCount: 1,
        attachmentsFrozen: true,
        dispatchState: "recovering",
        failureClass: "recoverable_same_turn",
        recoveryAction: "reconcile",
        repairKind: "canonical_credential_rebind",
        manusV2Lifecycle: {
          attentionCode: "LEGACY_RECOVERY_ATTENTION",
        },
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: null,
        canonicalTaskState: "attention_required",
        canonicalCredentialId: "credential-1",
        canonicalTaskGeneration: 3,
        protocolErrorCode: "MANUS_V2_CREATE_REJECTED",
      }),
      turns: [rejectedTurn],
      conversation: {
        id: rejectedTurn.conversationId,
        userId: rejectedTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns]],
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: rejectedTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.turns[0]?.metadata).toMatchObject({
      providerAttemptState: "rejected",
      createAttemptState: "rejected",
      dispatchState: "failed",
      recoveryAction: "contact_support",
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_CREATE_REJECTED",
      status: "protocol_error",
      activeTurnId: null,
      stateEpoch: 8,
      handoffProvenance: {
        recoverySourceTurnId: rejectedTurn.id,
        terminalRecovery: { action: "stopped" },
      },
    });
    expect(harness.store.conversation).toMatchObject({ status: "failed" });
  });

  it.skip("retires historical local-rehydrate canonical recovery", async () => {
    const rejectedTurn = turn({
      status: "running",
      upstreamTaskId: "canonical-task",
      leaseExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      errorCode: "MANUS_V2_SEND_REJECTED",
      metadata: {
        providerProtocol: "manus_v2",
        providerMethod: "task.sendMessage",
        providerAttemptState: "rejected",
        createAttemptState: "rejected",
        operationToken: "a".repeat(64),
        frozenProviderRequestHash: "f".repeat(64),
        providerReasonCategory: "permission_denied",
        providerRejectionStatus: 403,
        attachmentsFrozen: true,
        recoveryAction: "wait",
      },
    });
    const harness = createTurnServiceExecutor({
      build: build({
        canonicalTaskId: "canonical-task",
        upstreamTaskId: "canonical-task",
        canonicalTaskGeneration: 3,
        canonicalCredentialId: "credential-1",
        canonicalTaskState: "attention_required",
        handoffProvenance: {
          localRehydrateRequired: {
            schemaVersion: 1,
            sourceTurnId: "00000000-0000-4000-8000-000000000003",
            snapshotSha256: "c".repeat(64),
            taskIdSha256: createHash("sha256")
              .update("canonical-task")
              .digest("hex"),
            generation: 3,
            revision: 7,
            leafId: "1.8",
          },
        },
      }),
      turns: [rejectedTurn],
      conversation: {
        id: rejectedTurn.conversationId,
        userId: rejectedTurn.userId,
        projectAssignmentId: null,
        version: 1,
      },
      turnSelections: [[(store) => store.turns, (store) => store.turns]],
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: rejectedTurn.id,
          now: new Date("2026-08-01T00:10:00.000Z"),
        },
        harness.executor,
      ),
    ).resolves.toBeNull();
    expect(harness.store.turns[0]).toMatchObject({
      status: "failed",
      leaseExpiresAt: null,
      metadata: {
        failureClass: "requires_user_fix",
        recoveryAction: "create_new_canonical_from_snapshot",
      },
    });
    expect(harness.store.build).toMatchObject({
      canonicalTaskId: "canonical-task",
      canonicalTaskState: "attention_required",
      protocolErrorCode: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
    });
  });
});

describe("knowledge-base turn identity", () => {
  it("canonicalizes object keys but preserves attachment order", () => {
    expect(hashKnowledgeBaseTurnRequest({ b: 2, a: 1 })).toBe(
      hashKnowledgeBaseTurnRequest({ a: 1, b: 2 }),
    );
    expect(hashKnowledgeBaseTurnRequest({ ids: ["a", "b"] })).not.toBe(
      hashKnowledgeBaseTurnRequest({ ids: ["b", "a"] }),
    );
  });

  it("rejects circular and non-JSON request bodies", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => hashKnowledgeBaseTurnRequest(value)).toThrow(
      KnowledgeBaseTurnReservationError,
    );
    expect(() => hashKnowledgeBaseTurnRequest({ n: Number.NaN })).toThrow(
      KnowledgeBaseTurnReservationError,
    );
  });

  it("maps racing actions in one generation/revision/leaf to one slot", () => {
    const base = {
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    expect(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    ).toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "revise" }),
    );
    expect(
      createKnowledgeBaseOperationKey({ ...base, operationType: "start" }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    );
    expect(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000010",
      }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({ ...base, operationType: "confirm" }),
    );
    expect(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000010",
      }),
    ).not.toBe(
      createKnowledgeBaseOperationKey({
        ...base,
        operationType: "retry",
        retryOfTurnId: "00000000-0000-4000-8000-000000000011",
      }),
    );
  });

  it("derives one stable upstream key without embedding customer content", () => {
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "confirm",
      expectedRevision: 7,
      expectedLeafId: "1.8",
    });
    expect(createKnowledgeBaseUpstreamIdempotencyKey(operationKey)).toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    );
    expect(
      createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
    ).not.toContain("FrontMind 超前智能");
  });

  it("allocates a distinct provider operation for each manual Logo request", () => {
    const base = {
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "revise" as const,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    const first = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-a",
    });
    const replay = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-a",
    });
    const replacement = createKnowledgeBaseOperationKey({
      ...base,
      operationInstanceId: "manual-logo-request-b",
    });

    expect(replay).toBe(first);
    expect(replacement).not.toBe(first);
    expect(createKnowledgeBaseUpstreamIdempotencyKey(replacement)).not.toBe(
      createKnowledgeBaseUpstreamIdempotencyKey(first),
    );
  });
});

describe("knowledge-base turn replay decisions", () => {
  const now = new Date("2026-08-01T00:00:30.000Z");

  it("returns pending for an identical in-flight retry", () => {
    expect(evaluateKnowledgeBaseTurnReplay(turn(), identity, now)).toEqual({
      state: "pending",
      retryAfterMs: 5_000,
    });
  });

  it("makes a changed body or action lose the first-writer race", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn(),
        { ...identity, requestHash: "c".repeat(64) },
        now,
      ),
    ).toEqual({ state: "conflict" });
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn(),
        { ...identity, operationType: "revise" },
        now,
      ),
    ).toEqual({ state: "conflict" });
  });

  it("never reacquires a row that is already bound or completed", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({ status: "running", upstreamTaskId: "task-original" }),
        identity,
        now,
      ),
    ).toEqual({ state: "bound", upstreamTaskId: "task-original" });
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({
          status: "completed",
          upstreamTaskId: "task-original",
          leaseExpiresAt: new Date("2026-07-31T00:00:00.000Z"),
        }),
        identity,
        now,
      ),
    ).toEqual({ state: "completed" });
  });

  it("allows recovery only after an unbound lease expires", () => {
    expect(
      evaluateKnowledgeBaseTurnReplay(
        turn({ leaseExpiresAt: new Date("2026-07-31T00:00:00.000Z") }),
        identity,
        now,
      ),
    ).toEqual({ state: "expired" });
  });
});

describe("knowledge-base HTTP replay receipts", () => {
  const intent = {
    schemaVersion: 1,
    flow: "direct",
    userMessage: "确认",
    expectedGeneration: 3,
    expectedRevision: 7,
    expectedLeafId: "1.8",
    expectedPresentationKey: "presentation-7",
  };

  function replayExecutor(selections: unknown[][]) {
    let selection = 0;
    const nextSelection = () => {
      const rows = selections[selection++] || [];
      return Object.assign(Promise.resolve(rows), {
        for: async () => rows,
      });
    };
    return {
      transaction: async (run: (tx: any) => Promise<unknown>) =>
        run({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: nextSelection,
                orderBy: () => ({
                  limit: nextSelection,
                }),
              }),
            }),
          }),
        }),
    };
  }

  function replayTurn(overrides: Partial<ConversationTurn> = {}) {
    return turn({
      metadata: {
        clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
        expectedPresentationKey: "presentation-7",
      },
      ...overrides,
    });
  }

  it("returns the original passive receipt before mutable build checks", async () => {
    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          now: new Date("2026-08-01T00:00:30.000Z"),
        },
        replayExecutor([[replayTurn()]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: turn().id } });
  });

  it.each([
    {
      label: "native values",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: 3,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 3,
    },
    {
      label: "array coercion",
      traceId: ["b150314c-3c10-4073-8ebc-241e16f53600"],
      userAttachmentCount: [3],
      expectedTraceId: null,
      expectedUserAttachmentCount: 0,
    },
    {
      label: "object trace coercion",
      traceId: {
        toString: () => "b150314c-3c10-4073-8ebc-241e16f53600",
      },
      userAttachmentCount: 3,
      expectedTraceId: null,
      expectedUserAttachmentCount: 3,
    },
    {
      label: "string count coercion",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: "3",
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
    {
      label: "NaN count",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: Number.NaN,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
    {
      label: "negative count",
      traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      userAttachmentCount: -1,
      expectedTraceId: "b150314c-3c10-4073-8ebc-241e16f53600",
      expectedUserAttachmentCount: 0,
    },
  ])(
    "projects strict replay receipt metadata for $label",
    async ({
      traceId,
      userAttachmentCount,
      expectedTraceId,
      expectedUserAttachmentCount,
    }) => {
      const receipt = await inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
        },
        replayExecutor([
          [
            replayTurn({
              metadata: {
                clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
                expectedPresentationKey: "presentation-7",
                traceId,
                userAttachmentCount,
              },
            }),
          ],
        ]),
      );

      expect(receipt?.turn).toMatchObject({
        traceId: expectedTraceId,
        expectedUserAttachmentCount,
      });
    },
  );

  it("replays an old protocol-terminal incident without exposing mutation authority", async () => {
    const incident = replayTurn({
      status: "failed",
      upstreamTaskId: "provider-task-legacy-protocol",
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
      metadata: {
        clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
        expectedPresentationKey: "presentation-7",
        attachmentsFrozen: true,
        expectedAttachmentCount: 0,
        userAttachmentCount: 0,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
      },
    });

    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: intent,
        },
        replayExecutor([[incident]]),
      ),
    ).resolves.toMatchObject({
      state: "terminal",
      turn: {
        id: incident.id,
        upstreamTaskId: "provider-task-legacy-protocol",
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });
  });

  it("replays only an exact fully verified legacy start browser intent", async () => {
    const completedAt = new Date("2026-08-01T00:00:10.000Z");
    const attachment = {
      file_id: "customer-file-legacy-start",
      filename: "company-profile.pdf",
    };
    const build = {
      id: turn().buildId,
      userId: 1,
      conversationId: "conversation-1",
      companyName: "FrontMind",
      companyWebsite: "https://www.frontmind.net/",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      status: "protocol_error",
      activeTurnId: turn().id,
      upstreamTaskId: "provider-task-legacy-start",
      currentLeafId: "1.8",
      revision: 7,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
    };
    const recovery = {
      kind: "start",
      conversationId: "conversation-1",
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      operatorNotes: "",
      attachments: [attachment],
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      includePrefill: false,
      prefillSnapshotId: null,
      protocolFailureObservation: {
        observationKeyHash: "d".repeat(64),
        count: 3,
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        lastObservedAt: completedAt.toISOString(),
      },
    };
    const requestBody = {
      prompt: "Pinned legacy start prompt",
      agentProfile: "frontmind-pro",
      taskMode: "agent" as const,
      attachments: [
        { file_id: "skill-file-legacy-start", filename: "skill.zip" },
        attachment,
      ],
    };
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "start",
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
    });
    const incident = turn({
      operationKey,
      operationType: "start",
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: build.generation,
        revision: build.revision,
        leafId: build.currentLeafId,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        payload: {
          companyName: recovery.companyName,
          companyWebsite: recovery.companyWebsite,
          operatorNotes: recovery.operatorNotes,
          attachments: recovery.attachments,
          skillVersion: recovery.skillVersion,
          skillContentHash: recovery.skillContentHash,
          prefillSnapshotId: recovery.prefillSnapshotId,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      status: "failed",
      upstreamTaskId: build.upstreamTaskId,
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      completedAt,
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file-legacy-start", attachment.file_id],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    const exactInput = {
      userId: 1,
      conversationId: "conversation-1",
      clientRequestId: incident.clientRequestId,
      companyName: build.companyName,
      companyWebsite: ` ${build.companyWebsite} `,
      operatorNotes: "  ",
      attachments: [attachment],
    };

    await expect(
      inspectKnowledgeBaseLegacyStartReplay(
        exactInput,
        replayExecutor([[incident], [build as any]]),
      ),
    ).resolves.toMatchObject({
      state: "terminal",
      turn: {
        id: incident.id,
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });

    for (const changed of [
      { companyName: "Other Brand" },
      { companyWebsite: "https://other.example/" },
      { operatorNotes: "changed" },
      { attachments: [{ ...attachment, filename: "other.pdf" }] },
      { attachments: [] },
    ]) {
      await expect(
        inspectKnowledgeBaseLegacyStartReplay(
          { ...exactInput, ...changed },
          replayExecutor([[incident], [build as any]]),
        ),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
      });
    }

    await expect(
      inspectKnowledgeBaseLegacyStartReplay(
        exactInput,
        replayExecutor([
          [
            {
              ...incident,
              metadata: {
                ...(incident.metadata as Record<string, unknown>),
                recovery: {
                  ...recovery,
                  protocolFailureObservation: {
                    ...recovery.protocolFailureObservation,
                    count: "3",
                  },
                },
              },
            },
          ],
          [build as any],
        ]),
      ),
    ).resolves.toBeNull();
  });

  it("rejects different content under the same request id with a stable code", async () => {
    await expect(
      inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "request-1",
          clientIntent: { ...intent, userMessage: "修改公司名称" },
        },
        replayExecutor([[replayTurn()]]),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
  });

  it("adopts the operation winner after a tab remounts with a new request id", async () => {
    const receipt = await inspectKnowledgeBaseTurnReplay(
      {
        userId: 1,
        conversationId: "conversation-1",
        clientRequestId: "request-from-remounted-tab",
        clientIntent: intent,
        expectedGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "1.8",
      },
      replayExecutor([[], [replayTurn()]]),
    );
    expect(receipt).toMatchObject({
      state: "pending",
      turn: { clientRequestId: "request-1" },
    });
  });

  it.each([
    "unpreparedCancellation",
    "acknowledgedManualLogoCancellation",
    "unacknowledgedManualLogoCancellation",
  ] as const)(
    "never lets coordinate fallback adopt a %s tombstone",
    async (tombstoneFlag) => {
      const receipt = await inspectKnowledgeBaseTurnReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: "replacement-request",
          clientIntent: intent,
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
        },
        replayExecutor([
          [],
          [
            replayTurn({
              status: "cancelled",
              metadata: {
                clientIntentHash: hashKnowledgeBaseTurnRequest(intent),
                [tombstoneFlag]: true,
              },
            }),
          ],
        ]),
      );
      expect(receipt).toBeNull();
    },
  );

  it("replays an already staged file without consulting current Logo state", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const staged = replayTurn({
      operationType: "revise",
      metadata: {
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        sourceResetRevision: 0,
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredAttachmentReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: staged.id,
          clientRequestId: staged.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
          index: 0,
          attachment: { file_id: "file-logo", filename: "logo.png" },
        },
        replayExecutor([[staged], [{ revision: 0 }]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: staged.id } });
  });

  it("rejects an attachment replay after the live reset revision advances", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const staged = replayTurn({
      operationType: "revise",
      metadata: {
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        sourceResetRevision: 0,
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredAttachmentReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: staged.id,
          clientRequestId: staged.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
          index: 0,
          attachment: { file_id: "file-logo", filename: "logo.png" },
        },
        replayExecutor([[staged], [{ revision: 1 }]]),
      ),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED" });
  });

  it("replays a claimed deferred dispatch before consulting the active build", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const claimed = replayTurn({
      operationType: "revise",
      metadata: {
        awaitingClientAttachments: false,
        sourceResetRevision: 0,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredDispatchReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: claimed.id,
          clientRequestId: claimed.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
        },
        replayExecutor([[claimed], [{ revision: 0 }]]),
      ),
    ).resolves.toMatchObject({ state: "pending", turn: { id: claimed.id } });
  });

  it("rejects a dispatch replay after the live reset revision advances", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const claimed = replayTurn({
      operationType: "revise",
      metadata: {
        awaitingClientAttachments: false,
        sourceResetRevision: 0,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredDispatchReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: claimed.id,
          clientRequestId: claimed.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
        },
        replayExecutor([[claimed], [{ revision: 1 }]]),
      ),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED" });
  });

  it("does not treat a still-awaiting deferred reservation as a dispatch replay", async () => {
    const manifest = [{ filename: "logo.png", sha256: "a".repeat(64) }];
    const awaiting = replayTurn({
      operationType: "revise",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        sourceResetRevision: 0,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        clientStagedAttachments: [
          { index: 0, file_id: "file-logo", filename: "logo.png" },
        ],
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseDeferredDispatchReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: awaiting.id,
          clientRequestId: awaiting.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
        },
        replayExecutor([[awaiting], [{ revision: 0 }]]),
      ),
    ).resolves.toBeNull();
  });

  it("replays a legacy deferred reservation from immutable coordinates and manifest", async () => {
    const manifest = [{ filename: "brief.txt", sha256: "b".repeat(64) }];
    const awaiting = replayTurn({
      operationType: "revise",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        userAttachmentCount: 1,
      },
    });
    await expect(
      inspectKnowledgeBaseLegacyDeferredReservationReplay(
        {
          userId: 1,
          conversationId: "conversation-1",
          clientRequestId: awaiting.clientRequestId,
          clientAttachmentManifest: manifest,
          operationType: "revise",
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
        },
        replayExecutor([[awaiting]]),
      ),
    ).resolves.toMatchObject({
      state: "awaiting_attachments",
      turn: { id: awaiting.id },
    });
  });

  it("only replays a legacy upload-first request after its exact takeover ledger is durable", async () => {
    const manifest = [{ filename: "logo.png", sha256: "c".repeat(64) }];
    const attachments = [{ file_id: "file-logo", filename: "logo.png" }];
    const beforeTakeover = replayTurn({
      operationType: "revise",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        recovery: { attachmentManifest: manifest, attachments: [] },
      },
    });
    const input = {
      userId: 1,
      conversationId: "conversation-1",
      clientRequestId: beforeTakeover.clientRequestId,
      clientAttachmentManifest: manifest,
      attachments,
      operationType: "revise" as const,
      expectedGeneration: 3,
      expectedRevision: 7,
      expectedLeafId: "1.8",
    };
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        input,
        replayExecutor([[beforeTakeover]]),
      ),
    ).resolves.toBeNull();

    const afterTakeover = replayTurn({
      operationType: "revise",
      metadata: {
        awaitingClientAttachments: false,
        legacyUploadFirstTakeover: true,
        clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
        userAttachmentCount: 1,
        recovery: {
          kind: "turn",
          conversationId: "conversation-1",
          attachmentManifest: manifest,
          attachments,
        },
      },
    });
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        input,
        replayExecutor([[afterTakeover]]),
      ),
    ).resolves.toMatchObject({
      state: "pending",
      turn: { id: afterTakeover.id },
    });
    await expect(
      inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
        { ...input, attachments: [{ ...attachments[0]!, file_id: "other" }] },
        replayExecutor([[afterTakeover]]),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
  });

  it("rejects a new reservation against a stale presentation key", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000099",
      userId: 1,
      conversationId: "conversation-stale-presentation",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      ...currentMaterializedRecoveryBuildAuthority,
      status: "confirming",
      generation: 3,
      stateEpoch: 8,
      revision: 7,
      currentLeafId: "1.8",
      currentPresentationKey: "presentation-current",
      activeTurnId: null,
      upstreamTaskId: "parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const { executor } = createTurnServiceExecutor({
      build,
      conversation: {
        id: "u1:conversation-stale-presentation",
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
      },
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: build.id,
          clientRequestId: "stale-presentation-request",
          operationType: "confirm",
          expectedGeneration: 3,
          expectedRevision: 7,
          expectedLeafId: "1.8",
          expectedPresentationKey: "presentation-stale",
          requestPayload: { userMessage: "确认" },
          clientIntent: intent,
          apiCredentialId: "credential-1",
          userText: "确认",
          expectedAttachmentCount: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "STALE_KNOWLEDGE_BASE_PRESENTATION" });
  });
});

describe("knowledge-base generated attachment reservations", () => {
  it("reuses one provider file identity after response loss and binds cleanup ownership atomically", async () => {
    const leaseToken = "generated-attachment-lease";
    const active = turn({
      operationKey: "kbv2_generated-attachment-operation",
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const build = {
      id: active.buildId,
      userId: active.userId,
      generation: active.buildGeneration,
      activeTurnId: active.id,
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      turns: [active],
      turnSelections: Array.from({ length: 5 }, () => [
        (current: TurnServiceStore) => current.turns,
      ]),
    });
    const request = {
      userId: 1,
      turnId: active.id,
      leaseToken,
      role: "skill" as const,
      attachmentIndex: 0,
      filename: "socratic-kb-builder-v4.skill",
      mimeType: "application/zip",
      sizeBytes: 123,
      contentSha256: "c".repeat(64),
      now: new Date("2026-08-01T00:00:10.000Z"),
    };

    const first = await reserveKnowledgeBaseGeneratedAttachment(
      request,
      executor,
    );
    const replayAfterLostResponse =
      await reserveKnowledgeBaseGeneratedAttachment(request, executor);

    expect(replayAfterLostResponse).toEqual(first);
    expect(first).toEqual({
      state: "reserved",
      idempotencyKey: createKnowledgeBaseGeneratedAttachmentIdempotencyKey({
        operationKey: active.operationKey!,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
      }),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      upstreamFileId: null,
    });

    const completed = await completeKnowledgeBaseGeneratedAttachment(
      {
        userId: 1,
        turnId: active.id,
        leaseToken,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
        upstreamFileId: "provider-file-1",
        now: new Date("2026-08-01T00:00:11.000Z"),
      },
      executor,
    );
    // A provider identity is only a candidate until readiness/content proof.
    expect(completed.attachmentFileIds).toEqual([]);
    expect(store.resources).toHaveLength(1);
    expect(store.resources[0]).toMatchObject({
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "provider-file-1",
      conversationId: active.conversationId,
    });

    const completedReplay = await reserveKnowledgeBaseGeneratedAttachment(
      request,
      executor,
    );
    expect(completedReplay).toMatchObject({
      state: "candidate_created",
      idempotencyKey: first.idempotencyKey,
      upstreamFileId: "provider-file-1",
    });

    const ready = await promoteKnowledgeBaseGeneratedAttachmentReady(
      {
        userId: 1,
        turnId: active.id,
        leaseToken,
        role: "skill",
        attachmentIndex: 0,
        requestHash: first.requestHash,
        upstreamFileId: "provider-file-1",
      },
      executor,
    );
    expect(ready.attachmentFileIds).toEqual(["provider-file-1"]);

    await expect(
      completeKnowledgeBaseGeneratedAttachment(
        {
          userId: 1,
          turnId: active.id,
          leaseToken,
          role: "skill",
          attachmentIndex: 0,
          requestHash: first.requestHash,
          upstreamFileId: "provider-file-replacement",
        },
        executor,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:CONFLICT|RESERVATION_NOT_FOUND)$/u),
    });
    expect(store.resources).toHaveLength(1);
    expect(store.turns[0]!.attachmentFileIds).toEqual(["provider-file-1"]);
  });

  const reusableSkillSha256 = "d".repeat(64);

  function completedSkillTurn(
    overrides: Partial<ConversationTurn> = {},
  ): ConversationTurn {
    const fileId = "provider-skill-file";
    const requestBody = {
      prompt: "continue knowledge-base build",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      attachments: [
        {
          file_id: fileId,
          filename: "socratic-kb-builder-v4.skill",
        },
      ],
      taskId: "parent-task",
    };
    return turn({
      status: "completed",
      upstreamTaskId: "completed-provider-task",
      attachmentFileIds: [fileId],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        generatedAttachmentReservations: {
          "skill:0": {
            schemaVersion: 1,
            role: "skill",
            attachmentIndex: 0,
            requestHash: "e".repeat(64),
            idempotencyKeyHash: "f".repeat(64),
            filename: "socratic-kb-builder-v4.skill",
            mimeType: "application/zip",
            sizeBytes: 123,
            contentSha256: reusableSkillSha256,
            status: "completed",
            upstreamFileId: fileId,
            reservedAt: "2026-08-01T00:00:01.000Z",
            completedAt: "2026-08-01T00:00:02.000Z",
          },
        },
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:03.000Z",
        },
      },
      ...overrides,
    });
  }

  function reusableSkillLookupExecutor(input?: {
    sourceTurn?: ConversationTurn;
    resourceOverrides?: Record<string, unknown>;
  }) {
    const sourceTurn = input?.sourceTurn || completedSkillTurn();
    return createTurnServiceExecutor({
      build: {
        id: identity.buildId,
        userId: 1,
        generation: 3,
        activeTurnId: null,
      },
      turns: [sourceTurn],
      resources: [
        {
          id: "resource-skill-file",
          userId: 1,
          apiCredentialId: "credential-1",
          projectAssignmentId: null,
          kind: "file",
          upstreamId: "provider-skill-file",
          conversationId: sourceTurn.conversationId,
          createdAt: new Date("2026-08-01T00:00:02.000Z"),
          ...input?.resourceOverrides,
        },
      ],
      turnSelections: [[() => [sourceTurn]]],
    });
  }

  it("returns a completed Skill file only within the current user, build generation, and credential", async () => {
    const { executor } = reusableSkillLookupExecutor();

    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        executor,
      ),
    ).resolves.toBe("provider-skill-file");
  });

  it.each([
    ["another user", { userId: 2 }],
    ["another build", { buildId: "00000000-0000-4000-8000-000000000099" }],
    ["an older build generation", { buildGeneration: 2 }],
    ["another credential", { apiCredentialId: "credential-2" }],
    ["an unbound source turn", { upstreamTaskId: null }],
    ["a non-terminal source turn", { status: "queued" }],
  ] as const)("does not reuse a Skill from %s", async (_label, overrides) => {
    const { executor } = reusableSkillLookupExecutor({
      sourceTurn: completedSkillTurn(overrides as Partial<ConversationTurn>),
    });

    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        executor,
      ),
    ).resolves.toBeNull();
  });

  it("rejects a merely file-bound reservation and mismatched resource ownership", async () => {
    const halfUploaded = completedSkillTurn({
      status: "queued",
      upstreamTaskId: null,
      metadata: {
        attachmentsFrozen: false,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        generatedAttachmentReservations: (completedSkillTurn().metadata as any)
          .generatedAttachmentReservations,
      },
    });
    const halfUploadedExecutor = reusableSkillLookupExecutor({
      sourceTurn: halfUploaded,
    }).executor;
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        halfUploadedExecutor,
      ),
    ).resolves.toBeNull();

    const foreignResourceExecutor = reusableSkillLookupExecutor({
      resourceOverrides: { userId: 2 },
    }).executor;
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: reusableSkillSha256,
        },
        foreignResourceExecutor,
      ),
    ).resolves.toBeNull();
  });

  it("does not reuse a completed Skill reservation with different bytes", async () => {
    const { executor } = reusableSkillLookupExecutor();
    await expect(
      findReusableKnowledgeBaseSkillFileId(
        {
          userId: 1,
          buildId: identity.buildId,
          apiCredentialId: "credential-1",
          contentSha256: "9".repeat(64),
        },
        executor,
      ),
    ).resolves.toBeNull();
  });
});

describe("knowledge-base atomic start reservation", () => {
  const startInput = {
    userId: 1,
    expectedResetRevision: 0,
    conversationId: "conversation-atomic",
    clientRequestId: "start-request-a",
    companyName: "FrontMind 超前智能",
    companyWebsite: "https://www.frontmind.net/",
    skillName: "socratic-kb-builder",
    skillVersion: "5",
    skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    apiCredentialId: "credential-1",
    userText: "开始构建企业知识库",
    expectedAttachmentCount: 1,
    requestPayload: { attachments: [], operatorNotes: "" },
    recoveryMetadata: {
      kind: "start",
      conversationId: "conversation-atomic",
      attachments: [],
    },
    now: new Date("2026-08-01T00:00:00.000Z"),
  };
  const attachmentStartInput = {
    ...startInput,
    userAttachmentCount: 2,
    expectedAttachmentCount: 3,
    requestPayload: {
      attachments: [
        { file_id: "file-second", filename: "second.pdf" },
        { file_id: "file-first", filename: "first.pdf" },
      ],
      operatorNotes: "",
    },
    recoveryMetadata: {
      ...startInput.recoveryMetadata,
      attachments: [
        { file_id: "file-second", filename: "second.pdf" },
        { file_id: "file-first", filename: "first.pdf" },
      ],
    },
  };
  const attachmentResources = () => [
    {
      id: "resource-first",
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "file-first",
      conversationId: null,
      contentDeletedAt: null,
    },
    {
      id: "resource-second",
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId: "file-second",
      conversationId: null,
      contentDeletedAt: null,
    },
  ];

  it("rejects a stale browser reset revision before creating a build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 2,
      turnSelections: [[]],
    });
    await expect(
      reserveKnowledgeBaseStartBuild(
        { ...startInput, expectedResetRevision: 1 },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      message: "知识库已完成重置，请清空旧资料后重新开始",
    });
    expect(store.build).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("leaves the compatibility SiteOps epoch nullable on a new build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });

    await reserveKnowledgeBaseStartBuild(startInput, executor);

    expect(store.build?.siteOpsKnowledgeInputEpochId).toBeNull();
  });

  it("starts without prefill when the account has no active snapshot", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });

    const result = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        userAttachmentCount: 0,
        expectedAttachmentCount: 2,
        prefillSnapshotId: null,
        deferDispatchUntilAttachments: true,
        clientAttachmentManifest: [],
        requestPayload: {
          ...startInput.requestPayload,
          prefillSnapshotId: null,
        },
        recoveryMetadata: {
          ...startInput.recoveryMetadata,
          includePrefill: false,
          prefillSnapshotId: null,
        },
      },
      executor,
    );

    expect(result.reservation.turn).toMatchObject({
      expectedUserAttachmentCount: 0,
      attachmentFileIds: [],
    });
    expect((store.turns[0]?.metadata as any)?.expectedAttachmentCount).toBe(2);
    expect((store.turns[0]?.metadata as any)?.recovery).toMatchObject({
      includePrefill: false,
      prefillSnapshotId: null,
    });
  });

  it("accepts an account-owned prefill regardless of its historical SiteOps epoch", async () => {
    const snapshotId = "62000000-0000-4000-8000-000000000002";
    const { executor, store } = createTurnServiceExecutor({
      snapshots: [
        {
          id: snapshotId,
          userId: 1,
          siteOpsKnowledgeInputEpochId: "61000000-0000-4000-8000-000000000002",
        },
      ],
      turnSelections: [[[], []]],
    });

    await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        userAttachmentCount: 0,
        expectedAttachmentCount: 3,
        prefillSnapshotId: snapshotId,
        deferDispatchUntilAttachments: true,
        clientAttachmentManifest: [],
        requestPayload: {
          ...startInput.requestPayload,
          prefillSnapshotId: snapshotId,
        },
        recoveryMetadata: {
          ...startInput.recoveryMetadata,
          includePrefill: true,
          prefillSnapshotId: snapshotId,
        },
      },
      executor,
    );

    expect(store.build?.siteOpsKnowledgeInputEpochId).toBeNull();
    expect((store.turns[0]?.metadata as any)?.expectedAttachmentCount).toBe(3);
    expect((store.turns[0]?.metadata as any)?.recovery).toMatchObject({
      includePrefill: true,
      prefillSnapshotId: snapshotId,
    });
  });

  it("rejects a null/id split across the start prefill ledgers", async () => {
    const snapshotId = "62000000-0000-4000-8000-000000000004";
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          prefillSnapshotId: null,
          requestPayload: {
            ...startInput.requestPayload,
            prefillSnapshotId: snapshotId,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            includePrefill: false,
            prefillSnapshotId: null,
          },
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(store.build).toBeNull();
  });

  it("rejects a prefill snapshot owned by another account", async () => {
    const snapshotId = "62000000-0000-4000-8000-000000000003";
    const { executor, store } = createTurnServiceExecutor({
      snapshots: [
        {
          id: snapshotId,
          userId: 2,
          siteOpsKnowledgeInputEpochId: null,
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 0,
          expectedAttachmentCount: 3,
          prefillSnapshotId: snapshotId,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: [],
          requestPayload: {
            ...startInput.requestPayload,
            prefillSnapshotId: snapshotId,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            includePrefill: true,
            prefillSnapshotId: snapshotId,
          },
        },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      message: "知识库已完成重置，请从本轮全新资料重新开始",
    });
    expect(store.build).toBeNull();
    expect(store.turns).toHaveLength(0);
  });

  it("rejects a tombstoned conversation before reserving a build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      tombstones: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          userId: 1,
          publicConversationId: "conversation-atomic",
          resetRequestId: "00000000-0000-4000-8000-000000000098",
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(startInput, executor),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("rejects a retained tombstone after the reset ticket has expired", async () => {
    const { executor, store } = createTurnServiceExecutor({
      retainedTombstones: [
        {
          id: "00000000-0000-4000-8000-000000000097",
          userId: 1,
          publicConversationId: "conversation-atomic",
          resetAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
      turnSelections: [[]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(startInput, executor),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("does not upgrade an existing exact-tuple build without birth provenance", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    const first = await reserveKnowledgeBaseStartBuild(startInput, executor);
    store.build!.handoffProvenance = null;

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          clientRequestId: "start-request-after-cutover-loss",
          now: new Date("2026-08-01T00:00:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(store.build?.handoffProvenance).toBeNull();
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]?.id).toBe(first.reservation.turn.id);
    expect(store.messages).toHaveLength(1);
  });

  it("commits one build and replays only the identical start request", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    const first = await reserveKnowledgeBaseStartBuild(startInput, executor);
    const second = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        now: new Date("2026-08-01T00:00:01.000Z"),
      },
      executor,
    );

    expect(first.createdBuild).toBe(true);
    expect(first.reservation.state).toBe("acquired");
    expect(second.createdBuild).toBe(false);
    expect(second.reservation.state).toBe("pending");
    expect(second.reservation.turn.id).toBe(first.reservation.turn.id);
    expect(store.build?.activeTurnId).toBe(first.reservation.turn.id);
    expect(store.build?.treePolicyVersion).toBe(2);
    expect(store.build?.handoffProvenance).toMatchObject({
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
      sourceResetRevision: 0,
      authorizedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(store.turns[0]?.metadata).toMatchObject({
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
    });
    expect(store.build?.skillArchiveStorageKey).toMatch(
      /^knowledge-base\/skill-archives\/[a-f0-9]{64}\.skill\.zip$/u,
    );
    expect(store.build?.skillArchiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.build?.skillArchiveBytes).toBeGreaterThan(0);
    expect((store.turns[0]!.metadata as any).recovery).toMatchObject({
      skillArchiveSha256: store.build?.skillArchiveSha256,
      skillArchiveBytes: store.build?.skillArchiveBytes,
      skillArchiveStorageKey: store.build?.skillArchiveStorageKey,
    });
    expect(store.turns[0]!.metadata).toMatchObject({
      materializedRecoveryContractVersion: 1,
    });
    expect(first.build.treePolicyVersion).toBe(2);
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: `u1:msg-kb-user-${first.reservation.turn.id}`,
      turnId: first.reservation.turn.id,
      role: "user",
      content: "开始构建企业知识库",
      metadata: {
        knowledgeBase: {
          serverOwned: true,
          kind: "pending_user",
          clientRequestId: "start-request-a",
          operationKey: first.reservation.turn.operationKey,
        },
      },
    });
    expect(store.conversation?.version).toBe(2);
  });

  it("freezes canonical company coordinates before hashing the start request", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });

    await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        conversationId: "conversation-canonical-company",
        clientRequestId: "start-request-canonical-company",
        companyName: "  FrontMind　超前智能  ",
        companyWebsite:
          " FRONTMIND.NET\nhttps://frontmind.net/\nhttp://www.frontmind.net:80/research?q=1 ",
        requestPayload: { attachments: [], operatorNotes: "" },
        recoveryMetadata: {
          kind: "start",
          conversationId: "conversation-canonical-company",
          attachments: [],
        },
      },
      executor,
    );

    expect(store.build).toMatchObject({
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://frontmind.net/",
    });
    expect((store.turns[0]!.metadata as any).recovery).toMatchObject({
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://frontmind.net/",
      researchWebsites: [
        "https://frontmind.net/",
        "http://www.frontmind.net/research?q=1",
      ],
    });
  });

  it("commits a start-before-upload build and turn without granting a provider lease", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-1",
        ordinal: 1,
        total: 1,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "a".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });
    try {
      const result = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );

      expect(result).toMatchObject({
        createdBuild: true,
        reservation: {
          state: "awaiting_attachments",
          turn: {
            attachmentFileIds: [],
            awaitingClientAttachments: true,
            providerProtocol: "manus_v2",
            providerAttemptState: "not_sent",
            expectedUserAttachmentCount: 1,
            stagedUserAttachmentCount: 0,
            upstreamTaskId: null,
            leaseExpiresAt: null,
          },
        },
      });
      expect(store.build).toMatchObject({
        providerProtocol: "manus_v2",
        canonicalTaskState: "unbound",
        upstreamTaskId: null,
        activeTurnId: result.reservation.turn.id,
      });
      expect(store.turns).toHaveLength(1);
      expect(store.messages).toHaveLength(1);
      expect(store.resources).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("cancels an incomplete start reservation only at its exact reset revision", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-1",
        ordinal: 1,
        total: 2,
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "a".repeat(64),
      },
      {
        itemId: "starter-item-2",
        ordinal: 2,
        total: 2,
        filename: "profile.docx",
        sizeBytes: 24,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        lastModified: 2,
        sha256: "b".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      resources: [
        {
          id: "resource-file-facts",
          userId: 1,
          apiCredentialId: "credential-1",
          projectAssignmentId: null,
          kind: "file",
          upstreamId: "file-facts",
          conversationId: null,
          contentDeletedAt: null,
        },
      ],
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    try {
      const started = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 2,
          expectedAttachmentCount: 4,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );
      const originalOperationKey = started.reservation.turn.operationKey;

      await stageKnowledgeBaseDeferredTurnAttachment(
        {
          userId: 1,
          buildId: started.build.id,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          clientAttachmentManifest: attachmentManifest,
          expectedResetRevision: 0,
          index: 0,
          attachment: { file_id: "file-facts", filename: "facts.pdf" },
        },
        executor,
      );
      expect(store.turns[0]).toMatchObject({
        status: "queued",
        upstreamTaskId: null,
        leaseExpiresAt: null,
        attachmentFileIds: ["file-facts"],
        metadata: {
          awaitingClientAttachments: true,
          createAttemptState: "not_sent",
          providerAttemptState: "not_sent",
        },
      });

      const cancelledAt = new Date("2026-08-01T00:00:30.000Z");
      const cancelled = await cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: startInput.conversationId,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          expectedResetRevision: 0,
          now: cancelledAt,
        },
        executor,
      );

      expect(cancelled).toMatchObject({
        id: started.reservation.turn.id,
        status: "cancelled",
        upstreamTaskId: null,
        completedAt: cancelledAt,
        leaseExpiresAt: null,
        awaitingClientAttachments: false,
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        cancelled: true,
        resetRevision: 1,
        idempotent: false,
      });
      expect(cancelled.operationKey).not.toBe(originalOperationKey);
      expect(store.resources[0]).toMatchObject({
        upstreamId: "file-facts",
        conversationId: null,
      });
      expect(store.retainedTombstones).toEqual([
        expect.objectContaining({
          userId: 1,
          publicConversationId: startInput.conversationId,
          resetAt: cancelledAt,
        }),
      ]);
      expect(store).toMatchObject({
        build: null,
        conversation: null,
        turns: [],
        messages: [],
        resetRevision: 1,
      });

      const replayedCancellation = await cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: startInput.conversationId,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          expectedResetRevision: 0,
          now: new Date("2026-08-01T00:00:40.000Z"),
        },
        executor,
      );
      expect(replayedCancellation).toEqual({
        cancelled: true,
        resetRevision: 1,
        idempotent: true,
      });
      expect(store.resetRevision).toBe(1);

      const freshConversationId = "conversation-after-cancel";
      const freshExecutor = createTurnServiceExecutor({
        resetRevision: 1,
        resources: store.resources,
        turnSelections: [[[], []]],
      });
      const restarted = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          conversationId: freshConversationId,
          clientRequestId: "start-request-after-cancel",
          expectedResetRevision: 1,
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            conversationId: freshConversationId,
          },
        },
        freshExecutor.executor,
      );
      expect(restarted).toMatchObject({
        createdBuild: true,
        reservation: {
          state: "acquired",
          turn: {
            operationType: "start",
            upstreamTaskId: null,
          },
        },
      });
      expect(freshExecutor.store.build?.conversationId).toBe(
        freshConversationId,
      );
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("rejects incomplete start cancellation after the reset revision advances", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "true";
    const attachmentManifest = [
      {
        itemId: "starter-item-stale",
        ordinal: 1,
        total: 1,
        filename: "stale.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1,
        sha256: "c".repeat(64),
      },
    ];
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    try {
      const started = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          deferDispatchUntilAttachments: true,
          clientAttachmentManifest: attachmentManifest,
          requestPayload: {
            ...startInput.requestPayload,
            attachments: [],
            attachmentManifest,
          },
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            attachments: [],
            attachmentManifest,
            deferredClientAttachments: true,
          },
        },
        executor,
      );
      store.resetRevision = 1;
      const beforeCancellation = structuredClone(store);

      await expect(
        cancelIncompleteKnowledgeBaseStart(
          {
            userId: 1,
            conversationId: startInput.conversationId,
            turnId: started.reservation.turn.id,
            clientRequestId: started.reservation.turn.clientRequestId,
            expectedResetRevision: 0,
          },
          executor,
        ),
      ).rejects.toMatchObject({
        code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      });
      expect(store).toEqual(beforeCancellation);
      expect(store.turns[0]).toMatchObject({
        status: "queued",
        upstreamTaskId: null,
        metadata: {
          awaitingClientAttachments: true,
          sourceResetRevision: 0,
        },
      });
      expect(store.build?.activeTurnId).toBe(started.reservation.turn.id);
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("rejects start cancellation when the staged and recovery ledgers diverge", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resetRevision: 0,
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const started = await reserveKnowledgeBaseStartBuild(startInput, executor);
    store.turns[0].attachmentFileIds = ["unknown-extra-file"];
    const before = structuredClone(store);

    await expect(
      cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: startInput.conversationId,
          turnId: started.reservation.turn.id,
          clientRequestId: started.reservation.turn.clientRequestId,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("rejects confirm attachment turns through the customer start-cancel authority", async () => {
    const build = {
      id: identity.buildId,
      userId: 1,
      conversationId: "conversation-1",
      generation: identity.buildGeneration,
      stateEpoch: 2,
      revision: identity.expectedRevision,
      currentLeafId: identity.expectedLeafId,
      status: "confirming",
      activeTurnId: turn().id,
      upstreamTaskId: "parent-task",
    };
    const confirmTurn = turn({
      status: "queued",
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
      },
    });
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation: {
        id: "u1:conversation-1",
        userId: 1,
        version: 1,
        status: "running",
      },
      turns: [confirmTurn],
      turnSelections: [[(current) => current.turns]],
    });
    const before = structuredClone(store);

    await expect(
      cancelIncompleteKnowledgeBaseStart(
        {
          userId: 1,
          conversationId: "conversation-1",
          turnId: confirmTurn.id,
          clientRequestId: confirmTurn.clientRequestId,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("ignores the removed writer flag and always pins new builds to Manus v2", async () => {
    const previous = process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
    process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = "false";
    try {
      const { executor, store } = createTurnServiceExecutor({
        turnSelections: [[[], []]],
      });
      const result = await reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          conversationId: "conversation-legacy-writer",
          clientRequestId: "start-request-legacy-writer",
          recoveryMetadata: {
            ...startInput.recoveryMetadata,
            conversationId: "conversation-legacy-writer",
          },
        },
        executor,
      );

      expect(result.build.providerProtocol).toBe("manus_v2");
      expect(result.reservation.turn.providerProtocol).toBe("manus_v2");
      expect(store.build?.providerProtocol).toBe("manus_v2");
    } finally {
      if (previous === undefined) {
        delete process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV];
      } else {
        process.env[KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV] = previous;
      }
    }
  });

  it("starts a new conversation without mutating a rejected historical build turn", async () => {
    const rejectedHistoricalTurn = turn({
      id: "00000000-0000-4000-8000-000000000091",
      conversationId: "u1:conversation-failed-historical",
      buildId: "00000000-0000-4000-8000-000000000092",
      buildGeneration: 1,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_3",
      errorMessage: "上游已明确拒绝创建本轮任务",
      completedAt: new Date("2026-07-31T23:00:00.000Z"),
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: true,
        createAttemptState: "rejected",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
    });
    const historicalSnapshot = structuredClone(rejectedHistoricalTurn);
    const { executor, store } = createTurnServiceExecutor({
      turns: [rejectedHistoricalTurn],
      turnSelections: [[[], []]],
    });

    const started = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        conversationId: "conversation-new-after-rejection",
        clientRequestId: "start-request-new-after-rejection",
        recoveryMetadata: {
          ...startInput.recoveryMetadata,
          conversationId: "conversation-new-after-rejection",
        },
      },
      executor,
    );

    expect(started.createdBuild).toBe(true);
    expect(started.reservation.state).toBe("acquired");
    expect(started.reservation.turn.id).not.toBe(rejectedHistoricalTurn.id);
    expect(
      store.turns.find(
        (candidate) => candidate.id === rejectedHistoricalTurn.id,
      ),
    ).toEqual(historicalSnapshot);
    expect(store.turns).toHaveLength(2);
  });

  it("locks exact upload ownership and binds it in the reservation transaction", async () => {
    const { executor, store, events } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });

    const first = await reserveKnowledgeBaseStartBuild(
      attachmentStartInput,
      executor,
    );
    const replay = await reserveKnowledgeBaseStartBuild(
      {
        ...attachmentStartInput,
        now: new Date("2026-08-01T00:00:01.000Z"),
      },
      executor,
    );

    expect(first.reservation.turn.attachmentFileIds).toEqual([]);
    expect(
      (store.turns[0]!.metadata as any).recovery.attachments.map(
        (attachment: any) => attachment.file_id,
      ),
    ).toEqual(["file-second", "file-first"]);
    expect(store.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          upstreamId: "file-first",
          conversationId: "u1:conversation-atomic",
        }),
        expect.objectContaining({
          upstreamId: "file-second",
          conversationId: "u1:conversation-atomic",
        }),
      ]),
    );
    expect(replay.reservation.turn.id).toBe(first.reservation.turn.id);
    expect(store.turns).toHaveLength(1);
    expect(events.indexOf("start-attachments:lock")).toBeLessThan(
      events.indexOf("turn:insert"),
    );
    expect(events.indexOf("start-attachments:bind")).toBeLessThan(
      events.indexOf("transaction:commit"),
    );
  });

  it("fails atomically when discard wins and removes ownership before the row lock", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: [attachmentResources()[0]],
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.resources[0]?.conversationId).toBeNull();
  });

  it.each([
    ["another user", { userId: 2 }],
    ["a delivery project", { projectAssignmentId: "project-1" }],
    ["another credential", { apiCredentialId: "credential-2" }],
    ["a task row", { kind: "task" }],
    ["deleted content", { contentDeletedAt: new Date("2026-08-01") }],
    ["another conversation", { conversationId: "u1:another-conversation" }],
  ])("rejects a start attachment owned by %s", async (_label, override) => {
    const resources = attachmentResources();
    resources[1] = { ...resources[1], ...override };
    const initialResources = structuredClone(resources);
    const { executor, store } = createTurnServiceExecutor({
      resources,
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.build).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.resources).toEqual(initialResources);
  });

  it("rejects an attachment reorder under the same start request identity", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    await reserveKnowledgeBaseStartBuild(attachmentStartInput, executor);
    const reversedAttachments = [
      { file_id: "file-first", filename: "first.pdf" },
      { file_id: "file-second", filename: "second.pdf" },
    ];

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...attachmentStartInput,
          requestPayload: {
            ...attachmentStartInput.requestPayload,
            attachments: reversedAttachments,
          },
          recoveryMetadata: {
            ...attachmentStartInput.recoveryMetadata,
            attachments: reversedAttachments,
          },
          now: new Date("2026-08-01T00:00:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
    });
    expect(store.turns).toHaveLength(1);
    expect(
      store.resources.every(
        (resource) => resource.conversationId === "u1:conversation-atomic",
      ),
    ).toBe(true);
  });

  it("rejects an attempted rollback of the v5-only new-build policy", async () => {
    const previous = process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
    process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = "false";
    try {
      const { executor, store } = createTurnServiceExecutor({
        turnSelections: [[[], []]],
      });
      await expect(
        reserveKnowledgeBaseStartBuild(
          {
            ...startInput,
            skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
            treePolicyVersion: 1,
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(store.build).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
      } else {
        process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = previous;
      }
    }
  });

  it("rejects a policy/Skill mismatch before inserting any start state", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          treePolicyVersion: 1,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
  });

  it("rejects another client request id even when it targets the same start slot", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [[], (current) => current.turns],
      ],
    });
    await reserveKnowledgeBaseStartBuild(startInput, executor);

    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          clientRequestId: "start-request-b",
          now: new Date("2026-08-01T00:00:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
  });

  it("replays the original start identity after its manifest advances the build", async () => {
    const { executor, store } = createTurnServiceExecutor({
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const first = await reserveKnowledgeBaseStartBuild(startInput, executor);
    const original = store.turns[0]!;
    original.status = "completed";
    original.upstreamTaskId = "task-start";
    original.completedAt = new Date("2026-08-01T00:00:30.000Z");
    store.build = {
      ...store.build,
      status: "confirming",
      revision: 1,
      currentLeafId: "1.2",
      activeTurnId: null,
      upstreamTaskId: "task-start",
    };

    const replay = await reserveKnowledgeBaseStartBuild(
      {
        ...startInput,
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );

    expect(first.createdBuild).toBe(true);
    expect(replay.createdBuild).toBe(false);
    expect(replay.reservation).toMatchObject({
      state: "completed",
      upstreamTaskId: "task-start",
    });
    expect(store.turns).toHaveLength(1);
  });

  it("rolls the build back when the first reservation cannot commit", async () => {
    const { executor, store } = createTurnServiceExecutor({
      resources: attachmentResources(),
      turnSelections: [[[], []]],
      failConversationInsertAtTransaction: 0,
    });
    await expect(
      reserveKnowledgeBaseStartBuild(attachmentStartInput, executor),
    ).rejects.toThrow("simulated conversation insert failure");
    expect(store.build).toBeNull();
    expect(store.conversation).toBeNull();
    expect(store.turns).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(store.resources.every((resource) => !resource.conversationId)).toBe(
      true,
    );
  });
});

describe("knowledge-base server-owned turn messages", () => {
  it("commits a normal customer turn, message and conversation version together", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000020",
      userId: 1,
      conversationId: "conversation-turn-message",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      ...currentMaterializedRecoveryBuildAuthority,
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-turn-message",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turnSelections: [[[], []]],
    });

    const reservation = await reserveKnowledgeBaseTurn(
      {
        userId: 1,
        buildId: build.id,
        clientRequestId: "confirm-request-1",
        operationType: "confirm",
        expectedGeneration: 2,
        expectedRevision: 3,
        expectedLeafId: "1.4",
        requestPayload: { userMessage: "确认", attachments: [] },
        apiCredentialId: "credential-1",
        userText: "确认",
        // The one frozen file is the generated Skill, not customer evidence.
        userAttachmentCount: 0,
        expectedAttachmentCount: 1,
        recoveryMetadata: {
          kind: "turn",
          conversationId: "conversation-turn-message",
          parentTaskId: "successful-parent-task",
          userMessage: "确认",
          attachments: [],
          skillVersion: "4",
        },
      },
      executor,
    );

    expect(reservation.state).toBe("acquired");
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: `u1:msg-kb-user-${reservation.turn.id}`,
      turnId: reservation.turn.id,
      role: "user",
      content: "确认",
      metadata: {
        knowledgeBase: {
          serverOwned: true,
          kind: "pending_user",
          clientRequestId: "confirm-request-1",
          generation: 2,
          revision: 3,
          leafId: "1.4",
        },
      },
    });
    expect(store.conversation).toMatchObject({
      version: 9,
      status: "running",
    });
    expect(store.build).toMatchObject({
      lastTurnUserText: "确认",
      lastTurnAttachmentCount: 0,
    });
  });

  it("recovers with its retired pinned credential but fails closed after deletion", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000021",
      userId: 1,
      conversationId: "conversation-credential-recovery",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      ...currentMaterializedRecoveryBuildAuthority,
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-credential-recovery",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      credentials: [{ id: "credential-1", userId: 1, status: "active" }],
      usageOwnerId: 7,
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      clientRequestId: "confirm-credential-recovery",
      operationType: "confirm" as const,
      expectedGeneration: 2,
      expectedRevision: 3,
      expectedLeafId: "1.4",
      requestPayload: { userMessage: "确认", attachments: [] },
      apiCredentialId: "credential-1",
      userText: "确认",
      userAttachmentCount: 0,
      expectedAttachmentCount: 1,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "successful-parent-task",
        userMessage: "确认",
        attachments: [],
        skillVersion: "4",
      },
      now: new Date("2026-08-01T00:00:00.000Z"),
    };
    const first = await reserveKnowledgeBaseTurn(input, executor);
    expect(first.state).toBe("acquired");

    // The durable turn, not the mutable delivery relationship, remains the
    // authority after the customer's own credential is retired.
    store.usageOwnerId = 8;
    store.turns[0]!.leaseExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    store.credentials[0]!.status = "retired";
    const recovered = await reserveKnowledgeBaseTurn(
      { ...input, now: new Date("2026-08-01T00:01:00.000Z") },
      executor,
    );
    expect(recovered.state).toBe("acquired");
    expect(recovered.turn.id).toBe(first.turn.id);
    const duplicateAfterRestart = await reserveKnowledgeBaseTurn(
      { ...input, now: new Date("2026-08-01T00:01:01.000Z") },
      executor,
    );
    expect(duplicateAfterRestart.state).toBe("pending");
    expect(duplicateAfterRestart.turn.id).toBe(first.turn.id);
    expect(store.turns).toHaveLength(1);

    store.turns[0]!.leaseExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    store.credentials[0]!.status = "deleted";
    await expect(
      reserveKnowledgeBaseTurn(
        { ...input, now: new Date("2026-08-01T00:02:00.000Z") },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects delivery-owner credentials and accepts the customer's own credential", async () => {
    const build = {
      id: "00000000-0000-4000-8000-000000000022",
      userId: 1,
      conversationId: "conversation-current-owner",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      ...currentMaterializedRecoveryBuildAuthority,
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      activeTurnId: null,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
    };
    const conversation = {
      id: "u1:conversation-current-owner",
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 8,
      status: "awaiting_input",
    };
    const reservationInput = (apiCredentialId: string) => ({
      userId: 1,
      buildId: build.id,
      clientRequestId: `request-${apiCredentialId}`,
      operationType: "confirm" as const,
      expectedGeneration: 2,
      expectedRevision: 3,
      expectedLeafId: "1.4",
      requestPayload: { userMessage: "确认", attachments: [] },
      apiCredentialId,
      userText: "确认",
      userAttachmentCount: 0,
      expectedAttachmentCount: 1,
      recoveryMetadata: { kind: "turn" },
    });
    const stale = createTurnServiceExecutor({
      build: structuredClone(build),
      conversation: structuredClone(conversation),
      credentials: [{ id: "credential-a", userId: 7, status: "active" }],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        reservationInput("credential-a"),
        stale.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stale.store.turns).toHaveLength(0);

    const currentDeliveryOwner = createTurnServiceExecutor({
      build: structuredClone(build),
      conversation: structuredClone(conversation),
      credentials: [{ id: "credential-b", userId: 8, status: "active" }],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        reservationInput("credential-b"),
        currentDeliveryOwner.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(currentDeliveryOwner.store.turns).toHaveLength(0);

    const customer = createTurnServiceExecutor({
      build: structuredClone(build),
      conversation: structuredClone(conversation),
      credentials: [{ id: "credential-c", userId: 1, status: "active" }],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        reservationInput("credential-c"),
        customer.executor,
      ),
    ).resolves.toMatchObject({
      state: "acquired",
      turn: { apiCredentialId: "credential-c" },
    });
  });

  it("rejects a deleted v2 canonical credential instead of silently using the replacement key", async () => {
    const canonicalBuild = {
      id: "00000000-0000-4000-8000-000000000024",
      userId: 1,
      conversationId: "conversation-deleted-v2-canonical",
      companyName: "FrontMind 超前智能",
      companyWebsite: null,
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      ...currentMaterializedRecoveryBuildAuthority,
      canonicalTaskId: "canonical-task-deleted",
      canonicalTaskGeneration: 2,
      canonicalCredentialId: "credential-deleted",
      canonicalTaskState: "active",
      status: "confirming",
      generation: 2,
      stateEpoch: 5,
      revision: 3,
      currentLeafId: "1.4",
      currentPresentationKey: null,
      activeTurnId: null,
      upstreamTaskId: "canonical-task-deleted",
      recoveryLeaseExpiresAt: null,
      protocolErrorCode: null,
      protocolError: null,
    };
    const harness = createTurnServiceExecutor({
      build: canonicalBuild,
      conversation: {
        id: "u1:conversation-deleted-v2-canonical",
        userId: 1,
        projectAssignmentId: null,
        deletedAt: null,
      },
      credentials: [
        { id: "credential-deleted", userId: 7, status: "deleted" },
        { id: "credential-current", userId: 8, status: "active" },
      ],
      usageOwnerId: 8,
      turnSelections: [[[], []]],
    });
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: canonicalBuild.id,
          clientRequestId: "deleted-canonical-confirm",
          operationType: "confirm",
          expectedGeneration: 2,
          expectedRevision: 3,
          expectedLeafId: "1.4",
          requestPayload: { userMessage: "确认" },
          apiCredentialId: "credential-deleted",
          userText: "确认",
          expectedAttachmentCount: 0,
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.turns).toHaveLength(0);
  });
});

describe("knowledge-base local upload coordinate authority", () => {
  const manifest = [
    {
      itemId: "fresh-item-1",
      ordinal: 1,
      total: 1,
      filename: "facts.pdf",
      sizeBytes: 12,
      mimeType: "application/pdf",
      lastModified: 1,
      sha256: "a".repeat(64),
    },
  ];
  const reservedTurn = turn({
    id: "00000000-0000-4000-8000-000000000071",
    conversationId: "u1:conversation-local-upload",
    clientRequestId: "fresh-request-1",
    buildId: "00000000-0000-4000-8000-000000000072",
    buildGeneration: 1,
    operationType: "start",
    expectedRevision: 0,
    expectedLeafId: null,
    upstreamTaskId: null,
    status: "queued",
    metadata: {
      attachmentsFrozen: false,
      awaitingClientAttachments: true,
      userAttachmentCount: 1,
      sourceResetRevision: 4,
      clientAttachmentManifestHash: hashKnowledgeBaseTurnRequest(manifest),
      clientStagedAttachments: [],
      createAttemptState: "not_sent",
      recovery: { attachmentManifest: manifest },
    },
  });
  const assertion = {
    userId: 1,
    projectAssignmentId: null,
    conversationId: "conversation-local-upload",
    turnId: reservedTurn.id,
    clientRequestId: reservedTurn.clientRequestId,
    itemId: "fresh-item-1",
    expectedResetRevision: 4,
    ordinal: 1,
    filename: "facts.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    contentSha256: "a".repeat(64),
  };

  function executorFor(input?: {
    resetRevision?: number;
    turnOverrides?: Partial<ConversationTurn>;
  }) {
    const candidate = turn({
      ...reservedTurn,
      ...(input?.turnOverrides || {}),
    });
    return createTurnServiceExecutor({
      build: {
        id: candidate.buildId,
        userId: candidate.userId,
        conversationId: "conversation-local-upload",
        generation: candidate.buildGeneration,
        activeTurnId: candidate.id,
      },
      turns: [candidate],
      conversation: {
        id: candidate.conversationId,
        userId: candidate.userId,
        projectAssignmentId: null,
        deletedAt: null,
      },
      resetRevision: input?.resetRevision ?? 4,
      turnSelections: [[(store) => store.turns]],
    }).executor;
  }

  it("accepts the authenticated active start reservation and exact manifest slot", async () => {
    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(assertion, executorFor()),
    ).resolves.toEqual({
      buildId: reservedTurn.buildId,
      turnId: reservedTurn.id,
    });
  });

  it("accepts a digest-free reservation before upload and binds the streamed server digest", async () => {
    const [{ sha256: _legacyDigest, ...digestFreeItem }] = manifest;
    const digestFreeManifest = [digestFreeItem];
    const digestFreeMetadata = {
      ...(reservedTurn.metadata as Record<string, unknown>),
      clientAttachmentManifestHash:
        hashKnowledgeBaseTurnRequest(digestFreeManifest),
      recovery: { attachmentManifest: digestFreeManifest },
    };
    const { contentSha256: _browserDigest, ...digestFreeAssertion } = assertion;

    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(
        digestFreeAssertion,
        executorFor({ turnOverrides: { metadata: digestFreeMetadata } }),
      ),
    ).resolves.toEqual({
      buildId: reservedTurn.buildId,
      turnId: reservedTurn.id,
    });
    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(
        {
          ...digestFreeAssertion,
          authoritativeContentSha256: "a".repeat(64),
        },
        executorFor({ turnOverrides: { metadata: digestFreeMetadata } }),
      ),
    ).resolves.toEqual({
      buildId: reservedTurn.buildId,
      turnId: reservedTurn.id,
    });
  });

  it("accepts the authenticated active revise reservation at the same reset epoch", async () => {
    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(
        assertion,
        executorFor({ turnOverrides: { operationType: "revise" } }),
      ),
    ).resolves.toEqual({
      buildId: reservedTurn.buildId,
      turnId: reservedTurn.id,
    });
  });

  it.each([
    ["conversation", { conversationId: "another-conversation" }],
    ["request", { clientRequestId: "another-request" }],
    ["item", { itemId: "another-item" }],
    ["ordinal", { ordinal: 2 }],
    ["filename", { filename: "other.pdf" }],
    ["size", { sizeBytes: 13 }],
    ["sha", { contentSha256: "b".repeat(64) }],
  ])(
    "rejects a mismatched %s coordinate before bytes commit",
    async (_label, override) => {
      await expect(
        assertKnowledgeBaseLocalUploadCoordinate(
          { ...assertion, ...override },
          executorFor(),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
  );

  it("rejects a reset epoch change with the dedicated terminal code", async () => {
    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(
        assertion,
        executorFor({ resetRevision: 5 }),
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
    });
  });

  it("rejects an already staged or dispatch-attempted reservation", async () => {
    await expect(
      assertKnowledgeBaseLocalUploadCoordinate(
        assertion,
        executorFor({
          turnOverrides: {
            metadata: {
              ...(reservedTurn.metadata as Record<string, unknown>),
              createAttemptState: "sending",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("knowledge-base attachment-first turn reservation", () => {
  const manifest = [
    {
      filename: "facts.pdf",
      sizeBytes: 12,
      mimeType: "application/pdf",
      lastModified: 1,
      sha256: "a".repeat(64),
    },
    {
      filename: "logo-notes.txt",
      sizeBytes: 8,
      mimeType: "text/plain",
      lastModified: 2,
      sha256: "b".repeat(64),
    },
  ];
  const build = {
    id: "00000000-0000-4000-8000-000000000030",
    userId: 1,
    conversationId: "conversation-deferred-files",
    companyName: "FrontMind 超前智能",
    companyWebsite: "https://www.frontmind.net/",
    skillName: "socratic-kb-builder",
    skillVersion: "5",
    skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    executionMode: "materialized_bundle_v1",
    contentVersion: 1,
    providerProtocol: "manus_v2",
    handoffProvenance: {
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
    },
    status: "confirming",
    generation: 4,
    stateEpoch: 2,
    revision: 6,
    currentLeafId: "2.1",
    activeTurnId: null,
    upstreamTaskId: "parent-task",
    protocolErrorCode: null,
    protocolError: null,
  };
  const conversation = {
    id: "u1:conversation-deferred-files",
    userId: 1,
    projectAssignmentId: null,
    deletedAt: null,
    deletedMessageIds: [],
    version: 3,
    status: "awaiting_input",
  };
  const deferredUploadResources = () =>
    [
      "file-facts",
      "file-logo-notes",
      "old-staged-facts",
      "replacement-facts",
      "replacement-logo-notes",
    ].map((upstreamId) => ({
      id: `resource-${upstreamId}`,
      userId: 1,
      apiCredentialId: "credential-1",
      projectAssignmentId: null,
      kind: "file",
      upstreamId,
      conversationId: null,
      contentDeletedAt: null,
    }));

  function reserveInput() {
    return {
      userId: 1,
      buildId: build.id,
      clientRequestId: "deferred-request-1",
      operationType: "revise" as const,
      expectedGeneration: 4,
      expectedRevision: 6,
      expectedLeafId: "2.1",
      requestPayload: {
        userMessage: "请结合附件修订",
        attachmentManifest: manifest,
        skillVersion: "5",
      },
      apiCredentialId: "credential-1",
      userText: "请结合附件修订",
      userAttachmentCount: 2,
      expectedAttachmentCount: 3,
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: manifest,
      sourceResetRevision: 0,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "parent-task",
        userMessage: "请结合附件修订",
        attachments: [],
        attachmentManifest: manifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        sourceResetRevision: 0,
        skillVersion: "5",
      },
      now: new Date("2026-08-01T00:00:00.000Z"),
    };
  }

  function uploadFirstTakeoverInput(overrides: Record<string, unknown> = {}) {
    const attachments = [
      { file_id: "replacement-facts", filename: "facts.pdf" },
      {
        file_id: "replacement-logo-notes",
        filename: "logo-notes.txt",
      },
    ];
    return {
      userId: 1,
      buildId: build.id,
      clientRequestId: "deferred-request-1",
      operationType: "revise" as const,
      expectedGeneration: 4,
      expectedRevision: 6,
      expectedLeafId: "2.1",
      requestPayload: {
        userMessage: "请结合附件修订",
        attachments,
        skillVersion: "5",
      },
      apiCredentialId: "credential-1",
      userText: "请结合附件修订",
      userAttachmentCount: 2,
      expectedAttachmentCount: 3,
      clientAttachmentManifest: manifest,
      resumeLegacyAttachmentTakeover: true,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: "parent-task",
        userMessage: "请结合附件修订",
        attachments,
        attachmentManifest: manifest,
        skillVersion: "5",
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
      ...overrides,
    };
  }

  it("rejects a new turn on an exact-tuple build without birth provenance", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build, handoffProvenance: null },
      conversation: { ...conversation },
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseTurn(reserveInput(), executor),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(store.build?.handoffProvenance).toBeNull();
    expect(store.turns).toHaveLength(0);
  });

  it("stages resumed v5 content when the deterministic row display metadata drifted", async () => {
    const { sha256: _legacyBrowserSha256, ...digestFreeManifestItem } =
      manifest[0]!;
    const localManifest = [
      {
        ...digestFreeManifestItem,
        itemId: "materialized-local-item-1",
        ordinal: 1,
        total: 1,
      },
    ];
    const materializedBuild = {
      ...build,
      executionMode: "materialized_bundle_v1",
      providerProtocol: "manus_v2",
      skillVersion: "5",
      upstreamTaskId: null,
      canonicalTaskId: null,
      canonicalCredentialId: null,
      activeWorkingSetId: "working-set-1",
      contentVersion: 1,
    };
    const { executor, store } = createTurnServiceExecutor({
      build: materializedBuild,
      conversation: { ...conversation },
      localAssets: [],
      resources: [],
      turnSelections: [
        [[], []],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(
      {
        ...reserveInput(),
        userAttachmentCount: 1,
        expectedAttachmentCount: 4,
        clientAttachmentManifest: localManifest,
        requestPayload: {
          userMessage: "请结合附件修订",
          attachmentManifest: localManifest,
          skillVersion: "5",
        },
        recoveryMetadata: {
          kind: "turn",
          conversationId: build.conversationId,
          parentTaskId: null,
          userMessage: "请结合附件修订",
          attachments: [],
          attachmentManifest: localManifest,
          deferredClientAttachments: true,
          skillVersion: "5",
        },
      },
      executor,
    );
    const localAssetId = knowledgeBaseLocalAssetIdentity({
      userId: 1,
      projectAssignmentId: null,
      coordinate: {
        conversationId: materializedBuild.conversationId,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        itemId: "materialized-local-item-1",
        expectedResetRevision: 0,
        ordinal: 1,
      },
      sizeBytes: 12,
    }).localAssetId;
    store.localAssets.push({
      id: localAssetId,
      scope: "managed_user",
      accountUserId: 1,
      presalesProjectId: null,
      filename: "adapter-renamed-facts.bin",
      mimeType: "application/x-stale-provider-adapter",
      sizeBytes: 12,
      contentSha256: "a".repeat(64),
      retainUntil: new Date("2099-01-01T00:00:00.000Z"),
    });
    const staged = await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: materializedBuild.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: localManifest,
        expectedResetRevision: 0,
        index: 0,
        attachment: { file_id: localAssetId, filename: "facts.pdf" },
        managedUploadProof: {
          intentId: `local-asset:${localAssetId}`,
          itemId: "materialized-local-item-1",
          mimeType: "application/pdf",
          sizeBytes: 12,
          contentSha256: "a".repeat(64),
          localStorageKey:
            "knowledge-base/build-sources/1/materialized/facts.bin",
        },
      },
      executor,
    );

    expect(staged.attachmentFileIds).toEqual([localAssetId]);
    expect(store.resources).toEqual([]);
    expect((store.turns[0]!.metadata as any).recovery).toMatchObject({
      clientAttachmentManifest: [
        expect.not.objectContaining({ sha256: expect.anything() }),
      ],
      attachmentManifest: [expect.objectContaining({ sha256: "a".repeat(64) })],
      attachmentSourceProofs: [
        {
          fileId: localAssetId,
          contentSha256: "a".repeat(64),
          localStorageKey:
            "knowledge-base/build-sources/1/materialized/facts.bin",
        },
      ],
    });
  });

  it("reads only the frozen customer manifest for an active deferred reservation", async () => {
    const { executor } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);

    const inspected = await inspectKnowledgeBaseDeferredAttachmentReservation(
      {
        userId: 1,
        conversationId: build.conversationId,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        expectedResetRevision: 0,
      },
      executor,
    );

    expect(inspected).toMatchObject({
      buildId: build.id,
      turn: {
        id: reserved.turn.id,
        stagedUserAttachmentCount: 0,
        expectedUserAttachmentCount: 2,
        createAttemptState: "not_sent",
        upstreamTaskId: null,
      },
      clientAttachmentManifest: manifest,
    });
    expect(inspected.clientAttachmentManifest).toHaveLength(2);
  });

  it("does not create a competing turn while open-build recovery owns the lease", async () => {
    const { executor } = createTurnServiceExecutor({
      build: {
        ...build,
        recoveryLeaseOwnerHash: "a".repeat(64),
        recoveryLeaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      },
      conversation: { ...conversation },
      turnSelections: [[[], []]],
    });

    await expect(
      reserveKnowledgeBaseTurn(reserveInput(), executor),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_PENDING",
      retryAfterMs: 5_000,
    });
  });

  it("persists each uploaded id monotonically and freezes dispatch only after N/N", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      resources: deferredUploadResources(),
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    expect(reserved).toMatchObject({ state: "awaiting_attachments" });
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: [],
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientStagedAttachments: [],
      },
    });

    const first = await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
      },
      executor,
    );
    expect(first).toMatchObject({
      attachmentFileIds: ["file-facts"],
      stagedUserAttachmentCount: 1,
      awaitingClientAttachments: true,
    });
    expect((store.turns[0]!.metadata as any).recovery.attachments).toEqual([
      { file_id: "file-facts", filename: "facts.pdf" },
    ]);

    const resumed = await reserveKnowledgeBaseTurn(
      {
        ...reserveInput(),
        userText: "",
        requestPayload: {
          userMessage: "",
          attachmentManifest: manifest,
          skillVersion: "5",
        },
        resumeDeferredReservation: true,
        now: new Date("2026-08-01T00:01:00.000Z"),
      },
      executor,
    );
    expect(resumed).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        id: reserved.turn.id,
        clientRequestId: "deferred-request-1",
        stagedUserAttachmentCount: 1,
      },
    });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    await expect(
      reserveKnowledgeBaseTurn(
        {
          ...reserveInput(),
          userText: "换成另一套修改意见",
          requestPayload: {
            userMessage: "换成另一套修改意见",
            attachmentManifest: manifest,
            skillVersion: "5",
          },
          resumeDeferredReservation: true,
          now: new Date("2026-08-01T00:01:01.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const replacementManifest = manifest.map((item, index) =>
      index === 0 ? { ...item, sha256: "c".repeat(64) } : item,
    );
    await expect(
      reserveKnowledgeBaseTurn(
        {
          ...reserveInput(),
          userText: "",
          requestPayload: {
            userMessage: "",
            attachmentManifest: replacementManifest,
            skillVersion: "5",
          },
          clientAttachmentManifest: replacementManifest,
          resumeDeferredReservation: true,
          now: new Date("2026-08-01T00:01:02.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      claimKnowledgeBaseDeferredTurnDispatch(
        {
          userId: 1,
          buildId: build.id,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.turns[0]!.upstreamTaskId).toBeNull();

    // A lost staging response can safely replay the exact same index/file id.
    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
      },
      executor,
    );
    expect(store.turns[0]!.attachmentFileIds).toEqual(["file-facts"]);

    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 1,
        attachment: {
          file_id: "file-logo-notes",
          filename: "logo-notes.txt",
        },
      },
      executor,
    );
    expect(store.turns[0]!.attachmentFileIds).toEqual([
      "file-facts",
      "file-logo-notes",
    ]);

    const claimed = await claimKnowledgeBaseDeferredTurnDispatch(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
      },
      executor,
    );
    expect(claimed).toMatchObject({
      state: "acquired",
      turn: {
        attachmentFileIds: ["file-facts", "file-logo-notes"],
        awaitingClientAttachments: false,
      },
      recoveryMetadata: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-facts", filename: "facts.pdf" },
          { file_id: "file-logo-notes", filename: "logo-notes.txt" },
        ],
      },
    });
  });

  it("keeps a start turn lease-free after N/N stage until explicit dispatch", async () => {
    const startBuild = {
      ...build,
      status: "researching",
      generation: 1,
      revision: 0,
      currentLeafId: null,
      upstreamTaskId: null,
    };
    const startConversation = {
      ...conversation,
      status: "running",
    };
    const { executor, store } = createTurnServiceExecutor({
      build: startBuild,
      conversation: startConversation,
      resources: deferredUploadResources(),
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(
      {
        ...reserveInput(),
        buildId: startBuild.id,
        operationType: "start",
        sourceResetRevision: 0,
        expectedGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        requestPayload: {
          companyName: startBuild.companyName,
          attachments: [],
          attachmentManifest: manifest,
          skillVersion: "5",
        },
        userText: "开始构建企业知识库",
        recoveryMetadata: {
          ...reserveInput().recoveryMetadata,
          kind: "start",
          attachments: [],
        },
      },
      executor,
    );
    store.build!.activeTurnId = reserved.turn.id;

    for (const [index, attachment] of [
      { file_id: "file-facts", filename: "facts.pdf" },
      { file_id: "file-logo-notes", filename: "logo-notes.txt" },
    ].entries()) {
      await stageKnowledgeBaseDeferredTurnAttachment(
        {
          userId: 1,
          buildId: startBuild.id,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          clientAttachmentManifest: manifest,
          expectedResetRevision: 0,
          index,
          attachment,
        },
        executor,
      );
    }
    expect(store.turns[0]).toMatchObject({
      status: "queued",
      leaseExpiresAt: null,
      upstreamTaskId: null,
      metadata: { awaitingClientAttachments: true },
    });

    const dispatched = await claimKnowledgeBaseDeferredTurnDispatch(
      {
        userId: 1,
        buildId: startBuild.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
      },
      executor,
    );
    expect(dispatched).toMatchObject({
      state: "acquired",
      turn: { awaitingClientAttachments: false, upstreamTaskId: null },
    });
    expect(store.messages).toHaveLength(1);
  });

  it("atomically claims the deferred turn when the final customer attachment is staged", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      resources: deferredUploadResources(),
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const firstStagedAt = new Date("2026-08-01T00:00:10.000Z");
    const first = await stageAndClaimKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 0,
        attachment: { file_id: "file-facts", filename: "facts.pdf" },
        now: firstStagedAt,
        leaseMs: 60_000,
      },
      executor,
    );

    expect(first).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        attachmentFileIds: ["file-facts"],
        stagedUserAttachmentCount: 1,
        expectedUserAttachmentCount: 2,
        awaitingClientAttachments: true,
        leaseExpiresAt: null,
      },
    });
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: ["file-facts"],
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: true,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
        ],
      },
    });

    const finalStagedAt = new Date("2026-08-01T00:00:20.000Z");
    const claimed = await stageAndClaimKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 1,
        attachment: {
          file_id: "file-logo-notes",
          filename: "logo-notes.txt",
        },
        now: finalStagedAt,
        leaseMs: 60_000,
      },
      executor,
    );

    expect(claimed).toMatchObject({
      state: "acquired",
      turn: {
        attachmentFileIds: ["file-facts", "file-logo-notes"],
        stagedUserAttachmentCount: 2,
        expectedUserAttachmentCount: 2,
        awaitingClientAttachments: false,
        leaseExpiresAt: new Date("2026-08-01T00:01:20.000Z"),
      },
      recoveryMetadata: {
        capturedClientAttachments: true,
        attachments: [
          { file_id: "file-facts", filename: "facts.pdf" },
          { file_id: "file-logo-notes", filename: "logo-notes.txt" },
        ],
      },
    });
    expect(claimed.state === "acquired" && claimed.leaseToken).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(store.turns[0]).toMatchObject({
      attachmentFileIds: ["file-facts", "file-logo-notes"],
      leaseExpiresAt: new Date("2026-08-01T00:01:20.000Z"),
      metadata: {
        awaitingClientAttachments: false,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
          {
            index: 1,
            file_id: "file-logo-notes",
            filename: "logo-notes.txt",
          },
        ],
      },
    });
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("cancels a queued Logo upload before dispatch without moving the authoritative leaf", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const buildBeforeCancellation = { ...store.build };
    const cancelledAt = new Date("2026-08-01T00:00:30.000Z");

    expect(reserved).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        status: "queued",
        awaitingClientAttachments: true,
      },
    });
    expect(buildBeforeCancellation).toMatchObject({
      status: "confirming",
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      activeTurnId: reserved.turn.id,
    });

    const cancelled = await cancelUnpreparedKnowledgeBaseTurn(
      {
        userId: 1,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        code: "INVALID_OFFICIAL_LOGO_UPLOAD",
        message: "请上传有效的 Logo 图片后重试",
        now: cancelledAt,
      },
      executor,
    );

    expect(cancelled).toMatchObject({
      id: reserved.turn.id,
      status: "cancelled",
      completedAt: cancelledAt,
      leaseExpiresAt: null,
      awaitingClientAttachments: false,
    });
    expect(store.turns[0]).toMatchObject({
      id: reserved.turn.id,
      status: "cancelled",
      upstreamTaskId: null,
      errorCode: "INVALID_OFFICIAL_LOGO_UPLOAD",
      completedAt: cancelledAt,
      leaseExpiresAt: null,
      metadata: {
        awaitingClientAttachments: false,
        recovery: { capturedClientAttachments: true },
      },
    });
    expect(store.build).toMatchObject({
      status: "confirming",
      stateEpoch: buildBeforeCancellation.stateEpoch + 1,
      revision: buildBeforeCancellation.revision,
      currentLeafId: buildBeforeCancellation.currentLeafId,
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
    });
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: build.upstreamTaskId,
      previousResponseId: build.upstreamTaskId,
      version: conversation.version + 2,
    });
  });

  it("releases a revise-only browser batch while preserving its leaf and Working Set", async () => {
    const preservedBuild = {
      ...build,
      activeWorkingSetId: "working-set-2.1",
      currentPresentationKey: "presentation-2.1",
      contentVersion: 17,
    };
    const { executor, store } = createTurnServiceExecutor({
      build: preservedBuild,
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);

    const cancelled = await cancelIncompleteKnowledgeBaseRevision(
      {
        userId: 1,
        conversationId: build.conversationId,
        turnId: reserved.turn.id,
        clientRequestId: reserved.turn.clientRequestId,
        expectedResetRevision: 0,
        now: new Date("2026-08-01T00:00:30.000Z"),
      },
      executor,
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      awaitingClientAttachments: false,
    });
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      errorCode: "KNOWLEDGE_BASE_REVISION_UPLOAD_CANCELLED",
    });
    expect(store.build).toMatchObject({
      activeTurnId: null,
      status: "confirming",
      revision: 6,
      currentLeafId: "2.1",
      activeWorkingSetId: "working-set-2.1",
      currentPresentationKey: "presentation-2.1",
      contentVersion: 17,
    });
    expect(store.conversation).toMatchObject({ status: "awaiting_input" });
  });

  it("does not expose the revise cancellation authority to a start turn", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    store.turns[0] = {
      ...store.turns[0]!,
      operationType: "start",
    };

    await expect(
      cancelIncompleteKnowledgeBaseRevision(
        {
          userId: 1,
          conversationId: build.conversationId,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          expectedResetRevision: 0,
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.build).toMatchObject({ activeTurnId: reserved.turn.id });
    expect(store.turns[0]).toMatchObject({ status: "queued" });
  });

  it("leaves the revise turn untouched when its reset revision fence changed", async () => {
    const preservedBuild = {
      ...build,
      activeWorkingSetId: "working-set-2.1",
      currentPresentationKey: "presentation-2.1",
      contentVersion: 17,
    };
    const { executor, store } = createTurnServiceExecutor({
      build: preservedBuild,
      conversation: { ...conversation },
      turnSelections: [[[], []], [(current) => current.turns]],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const beforeBuild = structuredClone(store.build);
    const beforeTurn = structuredClone(store.turns[0]);
    const beforeConversation = structuredClone(store.conversation);

    await expect(
      cancelIncompleteKnowledgeBaseRevision(
        {
          userId: 1,
          conversationId: build.conversationId,
          turnId: reserved.turn.id,
          clientRequestId: reserved.turn.clientRequestId,
          expectedResetRevision: 1,
        },
        executor,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
    });

    expect(store.build).toEqual(beforeBuild);
    expect(store.turns[0]).toEqual(beforeTurn);
    expect(store.conversation).toEqual(beforeConversation);
  });

  it("deduplicates the exact unprepared cancellation replay and rejects conflicting replay identities", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
        [(current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    const cancellation = {
      userId: 1,
      turnId: reserved.turn.id,
      clientRequestId: reserved.turn.clientRequestId,
      code: "INVALID_OFFICIAL_LOGO_UPLOAD",
      message: "请上传有效的 Logo 图片后重试",
      now: new Date("2026-08-01T00:00:30.000Z"),
    };
    const first = await cancelUnpreparedKnowledgeBaseTurn(
      cancellation,
      executor,
    );
    const stateAfterFirstCancellation = structuredClone(store);

    const replay = await cancelUnpreparedKnowledgeBaseTurn(
      {
        ...cancellation,
        now: new Date("2026-08-01T00:00:31.000Z"),
      },
      executor,
    );
    expect(replay).toMatchObject({
      id: first.id,
      status: "cancelled",
      completedAt: cancellation.now,
      leaseExpiresAt: null,
    });
    expect(store).toEqual(stateAfterFirstCancellation);

    await expect(
      cancelUnpreparedKnowledgeBaseTurn(
        {
          ...cancellation,
          clientRequestId: "different-client-request",
          now: new Date("2026-08-01T00:00:32.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(stateAfterFirstCancellation);

    await expect(
      cancelUnpreparedKnowledgeBaseTurn(
        {
          ...cancellation,
          code: "DIFFERENT_CANCELLATION_CODE",
          now: new Date("2026-08-01T00:00:33.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(stateAfterFirstCancellation);
  });

  it("releases the canonical slot for a replacement upload while old-request replay stays terminal", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [[], []],
        [(current) => [current.turns[0]!], (current) => [current.turns[1]!]],
      ],
    });
    const originalInput = reserveInput();
    const original = await reserveKnowledgeBaseTurn(originalInput, executor);
    const canonicalOperationKey = original.turn.operationKey;

    await cancelUnpreparedKnowledgeBaseTurn(
      {
        userId: 1,
        turnId: original.turn.id,
        clientRequestId: original.turn.clientRequestId,
        code: "INVALID_OFFICIAL_LOGO_UPLOAD",
        message: "请上传有效的 Logo 图片后重试",
      },
      executor,
    );
    expect(store.turns[0]).toMatchObject({
      id: original.turn.id,
      status: "cancelled",
      metadata: {
        unpreparedCancellation: true,
        cancelledOperationKey: canonicalOperationKey,
      },
    });
    expect(store.turns[0]!.operationKey).not.toBe(canonicalOperationKey);

    const replacementManifest = manifest.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            filename: "official-logo.png",
            mimeType: "image/png",
            sizeBytes: 24,
            lastModified: 3,
            sha256: "c".repeat(64),
          }
        : entry,
    );
    const replacementInput = {
      ...reserveInput(),
      clientRequestId: "deferred-request-2",
      requestPayload: {
        ...reserveInput().requestPayload,
        userMessage: "已补充官方 Logo，请继续",
        attachmentManifest: replacementManifest,
      },
      userText: "已补充官方 Logo，请继续",
      clientAttachmentManifest: replacementManifest,
      recoveryMetadata: {
        ...reserveInput().recoveryMetadata,
        userMessage: "已补充官方 Logo，请继续",
        attachmentManifest: replacementManifest,
      },
      now: new Date("2026-08-01T00:01:00.000Z"),
    };
    const replacement = await reserveKnowledgeBaseTurn(
      replacementInput,
      executor,
    );
    expect(replacement).toMatchObject({
      state: "awaiting_attachments",
      turn: {
        clientRequestId: "deferred-request-2",
        operationKey: canonicalOperationKey,
        awaitingClientAttachments: true,
      },
    });
    expect(replacement.turn.id).not.toBe(original.turn.id);
    expect(store.build).toMatchObject({ activeTurnId: replacement.turn.id });
    expect(store.turns).toHaveLength(2);

    const activeBuildBeforeOldReplay = { ...store.build };
    const oldReplay = await reserveKnowledgeBaseTurn(
      {
        ...originalInput,
        now: new Date("2026-08-01T00:01:01.000Z"),
      },
      executor,
    );
    expect(oldReplay).toMatchObject({
      state: "terminal",
      turn: {
        id: original.turn.id,
        status: "cancelled",
      },
    });
    expect(store.build).toEqual(activeBuildBeforeOldReplay);
    expect(store.build).toMatchObject({ activeTurnId: replacement.turn.id });
    expect(store.turns).toHaveLength(2);
  });

  it.each(["preparedDispatch", "upstreamTaskId"] as const)(
    "refuses cancellation once %s proves dispatch has started",
    async (dispatchEvidence) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [[[], []], [(current) => current.turns]],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      if (dispatchEvidence === "preparedDispatch") {
        store.turns[0] = {
          ...store.turns[0]!,
          metadata: {
            ...(store.turns[0]!.metadata as Record<string, unknown>),
            preparedDispatch: { schemaVersion: 1 },
          },
        };
      } else {
        store.turns[0] = {
          ...store.turns[0]!,
          upstreamTaskId: "already-created-task",
        };
      }
      const buildBeforeCancellation = { ...store.build };

      await expect(
        cancelUnpreparedKnowledgeBaseTurn(
          {
            userId: 1,
            turnId: reserved.turn.id,
            clientRequestId: reserved.turn.clientRequestId,
            code: "INVALID_OFFICIAL_LOGO_UPLOAD",
            message: "请上传有效的 Logo 图片后重试",
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        status: "queued",
      });
      expect(store.build).toEqual(buildBeforeCancellation);
    },
  );

  it.each(["clientRequestId", "leaseToken"] as const)(
    "refuses cancellation with the wrong %s",
    async (mismatchedIdentity) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [[[], []], [(current) => current.turns]],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      const buildBeforeCancellation = { ...store.build };

      await expect(
        cancelUnpreparedKnowledgeBaseTurn(
          {
            userId: 1,
            turnId: reserved.turn.id,
            clientRequestId:
              mismatchedIdentity === "clientRequestId"
                ? "wrong-client-request"
                : reserved.turn.clientRequestId,
            ...(mismatchedIdentity === "leaseToken"
              ? { leaseToken: "wrong-lease-token" }
              : {}),
            code: "INVALID_OFFICIAL_LOGO_UPLOAD",
            message: "请上传有效的 Logo 图片后重试",
          },
          executor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        status: "queued",
        metadata: { awaitingClientAttachments: true },
      });
      expect(store.build).toEqual(buildBeforeCancellation);
    },
  );

  it("atomically takes over without local text and coalesces a lost-202 replay", async () => {
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build },
      conversation: { ...conversation },
      resources: deferredUploadResources(),
      turnSelections: [
        [[], []],
        [(current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
        [(current) => current.turns, (current) => current.turns],
      ],
    });
    const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
    expect(reserved.state).toBe("awaiting_attachments");
    const originalTurnId = reserved.turn.id;
    const originalOperationKey = reserved.turn.operationKey;
    const originalUpstreamIdempotencyKey =
      createKnowledgeBaseUpstreamIdempotencyKey(originalOperationKey);

    await stageKnowledgeBaseDeferredTurnAttachment(
      {
        userId: 1,
        buildId: build.id,
        turnId: originalTurnId,
        clientRequestId: reserved.turn.clientRequestId,
        clientAttachmentManifest: manifest,
        expectedResetRevision: 0,
        index: 0,
        attachment: { file_id: "old-staged-facts", filename: "facts.pdf" },
      },
      executor,
    );

    const missingLocalMessageInput = uploadFirstTakeoverInput();
    const takeoverWithoutLocalMessage = {
      ...missingLocalMessageInput,
      userText: "",
      requestPayload: {
        ...(missingLocalMessageInput.requestPayload as Record<string, unknown>),
        userMessage: "",
      },
      recoveryMetadata: {
        ...(missingLocalMessageInput.recoveryMetadata as Record<
          string,
          unknown
        >),
        userMessage: "",
      },
    };
    const takenOver = await reserveKnowledgeBaseTurn(
      takeoverWithoutLocalMessage,
      executor,
    );
    expect(takenOver).toMatchObject({
      state: "acquired",
      turn: {
        id: originalTurnId,
        clientRequestId: "deferred-request-1",
        operationKey: originalOperationKey,
        attachmentFileIds: [],
        awaitingClientAttachments: false,
      },
      upstreamIdempotencyKey: originalUpstreamIdempotencyKey,
    });
    expect(store.turns).toHaveLength(1);
    expect(store.messages).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({
      id: originalTurnId,
      upstreamTaskId: null,
      attachmentFileIds: [],
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: false,
        expectedAttachmentCount: 3,
        userAttachmentCount: 2,
        recovery: {
          userMessage: "请结合附件修订",
          attachments: [
            { file_id: "replacement-facts", filename: "facts.pdf" },
            {
              file_id: "replacement-logo-notes",
              filename: "logo-notes.txt",
            },
          ],
        },
      },
    });
    expect((store.turns[0]!.metadata as any).clientAttachmentManifestHash).toBe(
      hashKnowledgeBaseTurnRequest(manifest),
    );
    expect((store.turns[0]!.metadata as any).clientStagedAttachments).toBe(
      undefined,
    );
    expect(store.build).toMatchObject({
      activeTurnId: originalTurnId,
      stateEpoch: 4,
      lastTurnUserText: "请结合附件修订",
      lastTurnAttachmentCount: 2,
    });

    const replay = await reserveKnowledgeBaseTurn(
      {
        ...takeoverWithoutLocalMessage,
        now: new Date("2026-08-01T00:01:01.000Z"),
      },
      executor,
    );
    expect(replay).toMatchObject({
      state: "pending",
      turn: { id: originalTurnId, operationKey: originalOperationKey },
    });
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]!.upstreamTaskId).toBeNull();
  });

  it.each([
    [
      "client request identity",
      () => uploadFirstTakeoverInput({ clientRequestId: "another-request" }),
    ],
    [
      "knowledge coordinate",
      () => uploadFirstTakeoverInput({ expectedRevision: 7 }),
    ],
    [
      "pinned credential",
      () => uploadFirstTakeoverInput({ apiCredentialId: "credential-2" }),
    ],
    [
      "skill version",
      () => {
        const input = uploadFirstTakeoverInput();
        return {
          ...input,
          requestPayload: {
            ...(input.requestPayload as Record<string, unknown>),
            skillVersion: "4",
          },
          recoveryMetadata: {
            ...(input.recoveryMetadata as Record<string, unknown>),
            skillVersion: "4",
          },
        };
      },
    ],
    [
      "reserved filename",
      () => {
        const input = uploadFirstTakeoverInput();
        const attachments = [
          { file_id: "replacement-facts", filename: "other.pdf" },
          {
            file_id: "replacement-logo-notes",
            filename: "logo-notes.txt",
          },
        ];
        return {
          ...input,
          requestPayload: {
            ...(input.requestPayload as Record<string, unknown>),
            attachments,
          },
          recoveryMetadata: {
            ...(input.recoveryMetadata as Record<string, unknown>),
            attachments,
          },
        };
      },
    ],
  ])(
    "rejects upload-first takeover outside the original %s",
    async (_label, nextInput) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turns: [],
        credentials: [
          { id: "credential-1", userId: 1, status: "active" },
          { id: "credential-2", userId: 1, status: "active" },
        ],
        turnSelections: [
          [[], []],
          [(current) => current.turns, (current) => current.turns],
        ],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);

      await expect(
        reserveKnowledgeBaseTurn(nextInput() as any, executor),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns).toHaveLength(1);
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        upstreamTaskId: null,
        leaseExpiresAt: null,
        metadata: { awaitingClientAttachments: true },
      });
    },
  );

  it.each([
    ["sha256", { sha256: "f".repeat(64) }],
    ["sizeBytes", { sizeBytes: manifest[0]!.sizeBytes + 1 }],
    ["mimeType", { mimeType: "application/octet-stream" }],
    ["lastModified", { lastModified: manifest[0]!.lastModified + 1 }],
  ])(
    "rejects a same-name replacement whose %s differs from the durable manifest",
    async (_field, mutation) => {
      const { executor, store } = createTurnServiceExecutor({
        build: { ...build },
        conversation: { ...conversation },
        turnSelections: [
          [[], []],
          [(current) => current.turns, (current) => current.turns],
        ],
      });
      const reserved = await reserveKnowledgeBaseTurn(reserveInput(), executor);
      const replacementManifest = manifest.map((entry, index) =>
        index === 0 ? { ...entry, ...mutation } : entry,
      );
      const input = uploadFirstTakeoverInput({
        clientAttachmentManifest: replacementManifest,
      });

      await expect(
        reserveKnowledgeBaseTurn(input as any, executor),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.turns).toHaveLength(1);
      expect(store.turns[0]).toMatchObject({
        id: reserved.turn.id,
        upstreamTaskId: null,
        metadata: { awaitingClientAttachments: true },
      });
    },
  );

  it("never lets the recovery worker claim a browser turn awaiting files", async () => {
    const waiting = turn({
      id: "00000000-0000-4000-8000-000000000031",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      attachmentFileIds: ["file-facts"],
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: true,
        userAttachmentCount: 2,
        clientStagedAttachments: [
          { index: 0, file_id: "file-facts", filename: "facts.pdf" },
        ],
        recovery: {
          attachments: [{ file_id: "file-facts", filename: "facts.pdf" }],
        },
      },
    });
    const { executor } = createTurnServiceExecutor({
      build: { ...build, activeTurnId: waiting.id },
      conversation: { ...conversation },
      turns: [waiting],
      turnSelections: [[[waiting]]],
    });
    await expect(
      claimKnowledgeBaseTurnForRecovery({ turnId: waiting.id }, executor),
    ).resolves.toBeNull();
  });

  it.skip("retires the legacy 15:52 migration replacement", async () => {
    const replacement = turn({
      id: "00000000-0000-4000-8000-000000000035",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      status: "queued",
      leaseExpiresAt: null,
      metadata: {
        attachmentsFrozen: false,
        awaitingClientAttachments: false,
        createAttemptState: "not_sent",
        providerProtocol: "legacy_v1",
        providerAttemptState: "not_sent",
        repairKind: "legacy_skill_404_confirm",
        recovery: { kind: "turn" },
      },
    });
    const selection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === replacement.id);
    const { executor, store } = createTurnServiceExecutor({
      build: { ...build, activeTurnId: replacement.id },
      conversation: { ...conversation },
      turns: [replacement],
      turnSelections: [[selection], [selection]],
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery({ turnId: replacement.id }, executor),
    ).resolves.toBeNull();
    expect(store.turns[0]?.leaseExpiresAt).toBeNull();

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: replacement.id,
          allowLegacySkill404IncidentRepair: true,
        },
        executor,
      ),
    ).resolves.toMatchObject({
      turn: { id: replacement.id, createAttemptState: "not_sent" },
    });
  });

  it("claims stale sending once for unknown projection but never reclaims unknown", async () => {
    for (const createAttemptState of ["sending", "unknown"] as const) {
      const unresolved = turn({
        id:
          createAttemptState === "sending"
            ? "00000000-0000-4000-8000-000000000032"
            : "00000000-0000-4000-8000-000000000033",
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        status: "running",
        leaseExpiresAt: new Date("2026-07-31T23:59:00.000Z"),
        metadata: {
          attachmentsFrozen: true,
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
          providerProtocol: "manus_v2",
          createAttemptState,
          recovery: { kind: "turn" },
        },
      });
      const { executor, store } = createTurnServiceExecutor({
        build: {
          ...build,
          executionMode: "materialized_bundle_v1",
          skillVersion: "5",
          providerProtocol: "manus_v2",
          upstreamTaskId: null,
          canonicalTaskId: null,
          activeTurnId: unresolved.id,
        },
        conversation: { ...conversation },
        turns: [unresolved],
        turnSelections: [[[unresolved]]],
      });
      const claimed = await claimKnowledgeBaseTurnForRecovery(
        {
          turnId: unresolved.id,
          now: new Date("2026-08-01T00:00:00.000Z"),
        },
        executor,
      );
      if (createAttemptState === "sending") {
        expect(claimed).toMatchObject({
          turn: { createAttemptState: "sending" },
        });
      } else {
        expect(claimed).toBeNull();
      }
      expect(store.turns[0]?.metadata).toMatchObject({ createAttemptState });
    }
  });

  it("keeps a generic pre-create failure not_sent and recoverable", async () => {
    const leaseToken = "pre-create-generic-lease";
    const unresolved = turn({
      id: "00000000-0000-4000-8000-000000000034",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      status: "running",
      leaseExpiresAt: new Date("2026-08-01T00:00:30.000Z"),
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        createAttemptState: "not_sent",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        recovery: { kind: "turn" },
      },
    });
    const dynamicActive = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === unresolved.id);
    const { executor, store } = createTurnServiceExecutor({
      build: {
        ...build,
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        providerProtocol: "manus_v2",
        upstreamTaskId: null,
        canonicalTaskId: null,
        activeTurnId: unresolved.id,
      },
      conversation: { ...conversation },
      turns: [unresolved],
      turnSelections: [[dynamicActive], [dynamicActive]],
    });

    const persisted = await markKnowledgeBaseTurnOutcomeUnknown(
      {
        userId: unresolved.userId,
        turnId: unresolved.id,
        leaseToken,
        code: "PRECREATE_GENERIC_FAILURE",
        now: new Date("2026-08-01T00:00:00.000Z"),
        recoveryDelayMs: 1_000,
      },
      executor,
    );
    expect(persisted).toMatchObject({
      createAttemptState: "not_sent",
      status: "running",
    });
    expect(store.turns[0]?.metadata).toMatchObject({
      createAttemptState: "not_sent",
      outcomeUnknownCode: "PRECREATE_GENERIC_FAILURE",
    });

    await expect(
      claimKnowledgeBaseTurnForRecovery(
        {
          turnId: unresolved.id,
          now: new Date("2026-08-01T00:00:02.000Z"),
        },
        executor,
      ),
    ).resolves.toMatchObject({
      turn: { createAttemptState: "not_sent" },
    });
  });

  it("retires an old failed system-file create rejection without another Provider attempt", async () => {
    const rejected = turn({
      id: "00000000-0000-4000-8000-000000000036",
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      operationKey: "kbv2_exact_inline_recovery",
      status: "failed",
      errorCode: "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
      errorMessage: "system Skill file.create rejected",
      completedAt: new Date("2026-08-01T00:00:01.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: ["kb-local-skill", "kb-local-instructions"],
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        createAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
        chargeDisposition: "reuse_original_no_charge",
        recovery: { kind: "turn", conversationId: build.conversationId },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: {
            prompt: "full frozen business prompt",
            agentProfile: "manus-1.6-max",
            attachments: [
              {
                file_id: "kb-local-skill",
                filename: "socratic-kb-builder.skill.zip",
              },
              {
                file_id: "kb-local-instructions",
                filename: "frontmind-kb-server-instructions.txt",
              },
            ],
          },
          bodySha256: "f".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
        manusV2AttachmentAttempts: {
          rejectedSkill: {
            schemaVersion: 1,
            mappingKey: "rejectedSkill",
            buildGeneration: build.generation,
            attachmentIndex: 0,
            sourceFileId: "kb-local-skill",
            localStorageKey: "knowledge-base/build-sources/skill.bin",
            contentSha256: "a".repeat(64),
            sizeBytes: 48_000,
            filename: "socratic-kb-builder.skill.zip",
            mimeType: "application/zip",
            providerGeneration: 1,
            state: "create_rejected",
            upstreamFileId: null,
            uploadExpiresAt: null,
            code: "MANUS_V2_FILE_CREATE_any_provider_code",
            recordedAt: "2026-08-01T00:00:01.000Z",
          },
        },
        generatedAttachmentReservations: {
          "skill:0": {
            schemaVersion: 1,
            role: "skill",
            attachmentIndex: 0,
            requestHash: "c".repeat(64),
            idempotencyKeyHash: "d".repeat(64),
            filename: "socratic-kb-builder.skill.zip",
            mimeType: "application/zip",
            sizeBytes: 48_000,
            contentSha256: "a".repeat(64),
            localStorageKey: "knowledge-base/build-sources/skill.bin",
            status: "reserved",
            reservedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      },
    });
    const selection = (store: TurnServiceStore) =>
      store.turns.filter((candidate) => candidate.id === rejected.id);
    const { executor, store } = createTurnServiceExecutor({
      build: {
        ...build,
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        providerProtocol: "manus_v2",
        upstreamTaskId: null,
        canonicalTaskId: null,
        activeTurnId: rejected.id,
        status: "protocol_error",
        protocolErrorCode: rejected.errorCode,
        protocolError: rejected.errorMessage,
      },
      conversation: { ...conversation, status: "failed" },
      turns: [rejected],
      turnSelections: [[selection]],
    });

    const claimed = await claimKnowledgeBaseTurnForRecovery(
      {
        turnId: rejected.id,
        now: new Date("2026-08-01T00:00:02.000Z"),
      },
      executor,
    );

    expect(claimed).toBeNull();
    expect(store.turns).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({
      status: "failed",
      errorCode: "RESET_REQUIRED",
      metadata: {
        chargeDisposition: "reuse_original_no_charge",
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        canRegenerate: false,
        manusV2AttachmentAttempts: {
          rejectedSkill: { state: "create_rejected", upstreamFileId: null },
        },
      },
    });
    expect(store.build).toMatchObject({
      status: "protocol_error",
      protocolErrorCode: "RESET_REQUIRED",
      activeTurnId: rejected.id,
    });
  });

  it.each([
    ["customer attachment", null],
    ["prefill", "prefill"],
    ["finalization", "finalization"],
    ["hash mismatch", "skill-mismatched"],
  ])(
    "does not reclaim rejected %s as an inline system file",
    async (_label, role) => {
      const rejected = turn({
        id: "00000000-0000-4000-8000-000000000037",
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        status: "failed",
        errorCode: "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
        completedAt: new Date("2026-08-01T00:00:01.000Z"),
        leaseExpiresAt: null,
        attachmentFileIds: ["source-file"],
        metadata: {
          attachmentsFrozen: true,
          expectedAttachmentCount: 1,
          createAttemptState: "not_sent",
          providerProtocol: "manus_v2",
          providerAttemptState: "not_sent",
          recovery: { kind: "turn" },
          preparedDispatch: {
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "frozen prompt",
              agentProfile: "manus-1.6-max",
              attachments: [{ file_id: "source-file", filename: "source.bin" }],
            },
            bodySha256: "f".repeat(64),
            preparedAt: "2026-08-01T00:00:00.000Z",
          },
          ...(role
            ? {
                generatedAttachmentReservations: {
                  [`${role}:0`]: {
                    schemaVersion: 1,
                    role: role === "skill-mismatched" ? "skill" : role,
                    attachmentIndex: 0,
                    requestHash: "a".repeat(64),
                    idempotencyKeyHash: "b".repeat(64),
                    filename: "source.bin",
                    mimeType: "application/octet-stream",
                    sizeBytes: 10,
                    contentSha256:
                      role === "skill-mismatched"
                        ? "e".repeat(64)
                        : "c".repeat(64),
                    status: "reserved",
                    reservedAt: "2026-08-01T00:00:00.000Z",
                  },
                },
              }
            : {}),
          manusV2AttachmentAttempts: {
            rejected: {
              schemaVersion: 1,
              mappingKey: "rejected",
              buildGeneration: build.generation,
              attachmentIndex: 0,
              sourceFileId: "source-file",
              localStorageKey: "knowledge-base/build-sources/source.bin",
              contentSha256: "c".repeat(64),
              sizeBytes: 10,
              filename: "source.bin",
              mimeType: "application/octet-stream",
              providerGeneration: 1,
              state: "create_rejected",
              upstreamFileId: null,
              uploadExpiresAt: null,
              code: "permission_denied",
              recordedAt: "2026-08-01T00:00:01.000Z",
            },
          },
        },
      });
      const selection = (store: TurnServiceStore) =>
        store.turns.filter((candidate) => candidate.id === rejected.id);
      const { executor } = createTurnServiceExecutor({
        build: {
          ...build,
          activeTurnId: rejected.id,
          status: "protocol_error",
        },
        conversation: { ...conversation },
        turns: [rejected],
        turnSelections: [[selection]],
      });
      await expect(
        claimKnowledgeBaseTurnForRecovery({ turnId: rejected.id }, executor),
      ).resolves.toBeNull();
    },
  );
});

describe("acknowledged manual Logo rejection", () => {
  const leaseToken = "manual-logo-lease";
  const rejectedAt = new Date("2026-08-01T00:00:30.000Z");

  function fixture(overrides: { presentationKey?: string } = {}) {
    const buildId = "00000000-0000-4000-8000-000000000040";
    const clientRequestId = "manual-logo-request-invalid";
    const operationKey = createKnowledgeBaseOperationKey({
      buildId,
      buildGeneration: 2,
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      operationInstanceId: clientRequestId,
    });
    const presentationKey = overrides.presentationKey ?? "presentation-first";
    const requestBody = {
      prompt: "replace official logo",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: "parent-task",
      attachments: [
        { file_id: "skill-file", filename: "skill.zip" },
        { file_id: "instructions-file", filename: "instructions.md" },
        { file_id: "invalid-logo-file", filename: "invalid-logo.png" },
      ],
    };
    const acknowledgedTurn = turn({
      id: "00000000-0000-4000-8000-000000000041",
      conversationId: "u1:conversation-manual-logo",
      clientRequestId,
      buildId,
      buildGeneration: 2,
      operationKey,
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      attachmentFileIds: [
        "skill-file",
        "instructions-file",
        "invalid-logo-file",
      ],
      status: "running",
      upstreamTaskId: "child-logo-task",
      startedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        attachmentsFrozen: true,
        expectedAttachmentCount: 3,
        userAttachmentCount: 1,
        expectedPresentationKey: "presentation-first",
        recovery: {
          kind: "turn",
          conversationId: "conversation-manual-logo",
          parentTaskId: "parent-task",
          manualLogoSubmission: true,
          userMessage: "请使用新 Logo 重新呈现",
          attachments: [
            { file_id: "invalid-logo-file", filename: "invalid-logo.png" },
          ],
          officialLogoUpload: {
            index: 0,
            fileId: "invalid-logo-file",
            filename: "invalid-logo.png",
            mimeType: "image/png",
            sizeBytes: 32,
            sourceSha256: "a".repeat(64),
            verified: false,
          },
          skillVersion: "4",
          skillContentHash: "c".repeat(64),
        },
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const build = {
      id: buildId,
      userId: 1,
      conversationId: "conversation-manual-logo",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      status: "confirming",
      generation: 2,
      stateEpoch: 9,
      activeTurnId: acknowledgedTurn.id,
      upstreamTaskId: acknowledgedTurn.upstreamTaskId,
      lastAppliedOperationKey: "last-applied-operation",
      currentPresentationKey: presentationKey,
      revision: 0,
      currentLeafId: "1.1",
      totalNodeCount: 10,
      confirmedCount: 0,
      directPrefilledCount: 0,
      awaitingResponseSince: new Date("2026-08-01T00:00:20.000Z"),
      protocolErrorCode: null,
      protocolError: null,
      logoStorageKey: "logos/existing.png",
      logoSha256: "e".repeat(64),
      logoBytes: 256,
      logoFilename: "existing.png",
      logoMimeType: "image/png",
    };
    const conversation = {
      id: acknowledgedTurn.conversationId,
      userId: 1,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
      upstreamTaskId: acknowledgedTurn.upstreamTaskId,
      previousResponseId: "parent-task",
      completedAt: null,
    };
    return { acknowledgedTurn, build, conversation };
  }

  it("restores the exact parent state, is idempotent, and lets new Logo bytes reserve a distinct provider operation", async () => {
    const { acknowledgedTurn, build, conversation } = fixture();
    const oldTurn = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === acknowledgedTurn.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [acknowledgedTurn],
      turnSelections: [[oldTurn], [oldTurn], [oldTurn], [[], []]],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      buildGeneration: build.generation,
      turnId: acknowledgedTurn.id,
      clientRequestId: acknowledgedTurn.clientRequestId,
      leaseToken,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID" as const,
      message: "Logo 原始文件无法安全解码，请重新上传",
      now: rejectedAt,
    };

    const rejected = await rejectAcknowledgedKnowledgeBaseManualLogoTurn(
      input,
      executor,
    );
    expect(rejected).toMatchObject({
      id: acknowledgedTurn.id,
      status: "cancelled",
      upstreamTaskId: "child-logo-task",
      completedAt: rejectedAt,
      leaseExpiresAt: null,
    });
    expect(store.build).toMatchObject({
      upstreamTaskId: "parent-task",
      status: "confirming",
      stateEpoch: build.stateEpoch + 1,
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      currentPresentationKey: build.currentPresentationKey,
      lastAppliedOperationKey: build.lastAppliedOperationKey,
      logoStorageKey: build.logoStorageKey,
      logoSha256: build.logoSha256,
      logoBytes: build.logoBytes,
      logoFilename: build.logoFilename,
      logoMimeType: build.logoMimeType,
    });
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      upstreamTaskId: "child-logo-task",
      startedAt: acknowledgedTurn.startedAt,
      attachmentFileIds: acknowledgedTurn.attachmentFileIds,
      errorCode: input.code,
      completedAt: rejectedAt,
      leaseExpiresAt: null,
      metadata: {
        acknowledgedManualLogoCancellation: true,
        cancelledOperationKey: acknowledgedTurn.operationKey,
        attachmentsFrozen: true,
        recovery: {
          officialLogoUpload: {
            fileId: "invalid-logo-file",
            verified: false,
          },
        },
        preparedDispatch: { requestBody: { taskId: "parent-task" } },
      },
    });
    expect(store.turns[0]!.operationKey).not.toBe(
      acknowledgedTurn.operationKey,
    );
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toBeUndefined();
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
      version: conversation.version + 1,
      completedAt: null,
    });

    const settledState = structuredClone(store);
    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        { ...input, now: new Date("2026-08-01T00:00:31.000Z") },
        executor,
      ),
    ).resolves.toMatchObject({ status: "cancelled", completedAt: rejectedAt });
    expect(store).toEqual(settledState);

    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        { ...input, leaseToken: "wrong-manual-logo-lease" },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(settledState);

    const replacementRequestId = "manual-logo-request-replacement";
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: build.id,
          clientRequestId: replacementRequestId,
          operationInstanceId: replacementRequestId,
          operationType: "revise",
          expectedGeneration: build.generation,
          expectedRevision: build.revision,
          expectedLeafId: build.currentLeafId,
          expectedPresentationKey: build.currentPresentationKey,
          requestPayload: {
            submissionKind: "logo",
            attachments: [
              { file_id: "valid-logo-file", filename: "valid-logo.png" },
            ],
          },
          apiCredentialId: "credential-1",
          userText: "请使用新 Logo 重新呈现",
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          recoveryMetadata: {
            kind: "turn",
            conversationId: build.conversationId,
            parentTaskId: "parent-task",
            manualLogoSubmission: true,
            attachments: [
              { file_id: "valid-logo-file", filename: "valid-logo.png" },
            ],
            officialLogoUpload: {
              index: 0,
              fileId: "valid-logo-file",
              filename: "valid-logo.png",
              mimeType: "image/png",
              sizeBytes: 64,
              sourceSha256: "f".repeat(64),
              verified: false,
            },
            skillVersion: "4",
            skillContentHash: "c".repeat(64),
          },
          now: new Date("2026-08-01T00:01:00.000Z"),
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(store.turns).toHaveLength(1);
  });

  it("fails closed when the authoritative presentation changed", async () => {
    const { acknowledgedTurn, build, conversation } = fixture({
      presentationKey: "newer-presentation",
    });
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [acknowledgedTurn],
      turnSelections: [[(current) => current.turns]],
    });
    const before = structuredClone(store);

    await expect(
      rejectAcknowledgedKnowledgeBaseManualLogoTurn(
        {
          userId: 1,
          buildId: build.id,
          buildGeneration: build.generation,
          turnId: acknowledgedTurn.id,
          clientRequestId: acknowledgedTurn.clientRequestId,
          leaseToken,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          message: "当前知识节点已变化",
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store).toEqual(before);
  });

  it("releases a prepared Logo turn after a deterministic pre-ack rejection and accepts new bytes", async () => {
    const source = fixture();
    const unacknowledgedTurn = {
      ...source.acknowledgedTurn,
      upstreamTaskId: null,
    };
    const build = {
      ...source.build,
      upstreamTaskId: "parent-task",
    };
    const conversation = {
      ...source.conversation,
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
    };
    const oldTurn = (current: TurnServiceStore) =>
      current.turns.filter(
        (candidate) => candidate.id === unacknowledgedTurn.id,
      );
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [unacknowledgedTurn],
      turnSelections: [[oldTurn], [[], []]],
    });
    const input = {
      userId: 1,
      buildId: build.id,
      buildGeneration: build.generation,
      turnId: unacknowledgedTurn.id,
      clientRequestId: unacknowledgedTurn.clientRequestId,
      leaseToken,
      code: "UPSTREAM_CREATE_HTTP_422",
      message: "上游已明确拒绝创建本轮任务，请重新选择 Logo",
      now: rejectedAt,
    };

    await expect(
      rejectUnacknowledgedKnowledgeBaseManualLogoTurn(input, executor),
    ).resolves.toMatchObject({
      id: unacknowledgedTurn.id,
      status: "cancelled",
      upstreamTaskId: null,
      completedAt: rejectedAt,
    });
    expect(store.build).toMatchObject({
      upstreamTaskId: "parent-task",
      status: "confirming",
      activeTurnId: null,
      awaitingResponseSince: null,
      protocolErrorCode: null,
      protocolError: null,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      currentPresentationKey: build.currentPresentationKey,
    });
    expect(store.turns[0]).toMatchObject({
      status: "cancelled",
      upstreamTaskId: null,
      errorCode: input.code,
      leaseExpiresAt: null,
      metadata: {
        unacknowledgedManualLogoCancellation: true,
        cancelledOperationKey: unacknowledgedTurn.operationKey,
        attachmentsFrozen: true,
        preparedDispatch: { requestBody: { taskId: "parent-task" } },
      },
    });
    expect((store.turns[0]!.metadata as any).leaseOwnerHash).toBeUndefined();
    expect(store.conversation).toMatchObject({
      status: "awaiting_input",
      upstreamTaskId: "parent-task",
      previousResponseId: "parent-task",
      completedAt: null,
    });

    const replacementRequestId = "manual-logo-after-create-rejection";
    await expect(
      reserveKnowledgeBaseTurn(
        {
          userId: 1,
          buildId: build.id,
          clientRequestId: replacementRequestId,
          operationInstanceId: replacementRequestId,
          operationType: "revise",
          expectedGeneration: build.generation,
          expectedRevision: build.revision,
          expectedLeafId: build.currentLeafId,
          expectedPresentationKey: build.currentPresentationKey,
          requestPayload: {
            submissionKind: "logo",
            attachments: [
              { file_id: "replacement-logo", filename: "replacement.png" },
            ],
          },
          apiCredentialId: "credential-1",
          userText: "请使用新 Logo 重新呈现",
          userAttachmentCount: 1,
          expectedAttachmentCount: 3,
          recoveryMetadata: {
            kind: "turn",
            conversationId: build.conversationId,
            parentTaskId: "parent-task",
            manualLogoSubmission: true,
            attachments: [
              { file_id: "replacement-logo", filename: "replacement.png" },
            ],
            officialLogoUpload: {
              index: 0,
              fileId: "replacement-logo",
              filename: "replacement.png",
              mimeType: "image/png",
              sizeBytes: 64,
              sourceSha256: "f".repeat(64),
              verified: false,
            },
            skillVersion: "4",
            skillContentHash: "c".repeat(64),
          },
        },
        executor,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(store.turns).toHaveLength(1);
  });
});

describe("knowledge-base deterministic dispatch failure", () => {
  it("pauses only a frozen unbound v2 create when its credential disappears", async () => {
    const leaseToken = "missing-credential-lease";
    const active = turn({
      status: "running",
      upstreamTaskId: null,
      completedAt: null,
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        attachmentsFrozen: true,
        createAttemptState: "not_sent",
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "not_sent",
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: { prompt: "exact prompt", attachments: [] },
          bodySha256: "d".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
        recovery: { kind: "turn", conversationId: "conversation-1" },
        dispatchState: "recovering",
        failureClass: "recoverable_same_turn",
        recoveryAction: "reconcile",
      },
    });
    const build = {
      id: active.buildId,
      userId: active.userId,
      conversationId: "conversation-1",
      providerProtocol: "manus_v2",
      generation: active.buildGeneration,
      stateEpoch: 12,
      revision: active.expectedRevision,
      currentLeafId: active.expectedLeafId,
      status: "confirming",
      activeTurnId: active.id,
      upstreamTaskId: null,
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
      protocolErrorCode: null,
      protocolError: null,
      awaitingResponseSince: new Date("2026-08-01T00:00:00.000Z"),
    };
    const conversation = {
      id: active.conversationId,
      userId: active.userId,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
    };
    const current = (state: TurnServiceStore) =>
      state.turns.filter((candidate) => candidate.id === active.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [active],
      turnSelections: [[current]],
    });

    await expect(
      pauseKnowledgeBasePreCreateCredentialUnavailable(
        {
          userId: active.userId,
          turnId: active.id,
          leaseToken,
          now: new Date("2026-08-01T00:00:20.000Z"),
        },
        executor,
      ),
    ).resolves.toMatchObject({
      id: active.id,
      status: "failed",
      upstreamTaskId: null,
      operationKey: active.operationKey,
      createAttemptState: "not_sent",
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
      leaseExpiresAt: null,
    });
    expect(store.build).toMatchObject({
      status: "protocol_error",
      stateEpoch: 13,
      activeTurnId: active.id,
      canonicalTaskId: null,
      protocolErrorCode: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
    });
    expect(store.conversation).toMatchObject({ status: "failed", version: 5 });

    const ambiguous = {
      ...active,
      metadata: {
        ...(active.metadata as Record<string, unknown>),
        createAttemptState: "unknown",
        providerAttemptState: "outcome_unknown",
        outcomeUnknownAt: "2026-08-01T00:00:10.000Z",
      },
    } as ConversationTurn;
    const rejectedHarness = createTurnServiceExecutor({
      build: { ...build, activeTurnId: ambiguous.id },
      conversation,
      turns: [ambiguous],
      turnSelections: [[(state) => state.turns]],
    });
    await expect(
      pauseKnowledgeBasePreCreateCredentialUnavailable(
        { userId: 1, turnId: ambiguous.id, leaseToken },
        rejectedHarness.executor,
      ),
    ).resolves.toBeNull();
  });

  it("settles the active turn once so it is retryable and cannot be recovered forever", async () => {
    const leaseToken = "deterministic-failure-lease";
    const active = retryableFailedTurn({
      status: "running",
      upstreamTaskId: null,
      completedAt: null,
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(retryableFailedTurn().metadata as Record<string, unknown>),
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
        dispatchingAt: "2026-08-01T00:00:05.000Z",
        createAttemptState: "sending",
      },
    });
    const build = {
      id: active.buildId,
      userId: active.userId,
      conversationId: "conversation-1",
      status: "confirming",
      generation: active.buildGeneration,
      stateEpoch: 12,
      revision: active.expectedRevision,
      currentLeafId: active.expectedLeafId,
      activeTurnId: active.id,
      upstreamTaskId: "successful-parent-task",
      protocolErrorCode: null,
      protocolError: null,
      awaitingResponseSince: new Date("2026-08-01T00:00:00.000Z"),
    };
    const conversation = {
      id: active.conversationId,
      userId: active.userId,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
    };
    const dynamicActive = (current: TurnServiceStore) =>
      current.turns.filter((candidate) => candidate.id === active.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [active],
      turnSelections: [[dynamicActive], [dynamicActive]],
    });
    const input = {
      userId: active.userId,
      turnId: active.id,
      leaseToken,
      code: "UPSTREAM_CREATE_HTTP_422",
      message: "上游已明确拒绝创建本轮任务，当前内容和附件均已保留；请重试本轮",
      createAttemptRejected: true,
      reasonCategory: "ATTACHMENT_INVALID",
      providerRequestRef: "sha256:1234567890abcdef12345678",
      now: new Date("2026-08-01T00:00:20.000Z"),
    };

    const first = await failKnowledgeBaseTurnDeterministically(input, executor);
    const duplicate = await failKnowledgeBaseTurnDeterministically(
      input,
      executor,
    );

    expect(first.deduplicated).toBe(false);
    expect(duplicate.deduplicated).toBe(true);
    expect(store.build).toMatchObject({
      status: "protocol_error",
      stateEpoch: 13,
      protocolErrorCode: "UPSTREAM_CREATE_HTTP_422",
      awaitingResponseSince: null,
      activeTurnId: active.id,
    });
    expect(store.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "UPSTREAM_CREATE_HTTP_422",
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file", "facts-file"],
    });
    expect(store.turns[0]!.metadata).not.toHaveProperty("outcomeUnknownAt");
    expect(store.turns[0]!.metadata).not.toHaveProperty("outcomeUnknownCode");
    expect(store.turns[0]!.metadata).toMatchObject({
      createAttemptState: "rejected",
      providerReasonCategory: "ATTACHMENT_INVALID",
      providerRequestRef: "sha256:1234567890abcdef12345678",
    });
    expect(store.conversation).toMatchObject({ status: "failed", version: 5 });
  });

  it("atomically retires a fresh not-sent materialized pre-create failure", async () => {
    const leaseToken = "fresh-pre-create-reset-lease";
    const active = turn({
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      status: "running",
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 11,
        userAttachmentCount: 9,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        dispatchState: "recovering",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const build = {
      ...currentMaterializedRecoveryBuildAuthority,
      id: active.buildId,
      userId: active.userId,
      conversationId: "conversation-1",
      generation: active.buildGeneration,
      revision: 0,
      currentLeafId: null,
      status: "researching",
      stateEpoch: 7,
      activeTurnId: active.id,
      upstreamTaskId: null,
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
      protocolErrorCode: null,
      protocolError: null,
      awaitingResponseSince: new Date("2026-08-01T00:00:00.000Z"),
    };
    const conversation = {
      id: active.conversationId,
      userId: active.userId,
      projectAssignmentId: null,
      deletedAt: null,
      deletedMessageIds: [],
      version: 4,
      status: "running",
    };
    const current = (state: TurnServiceStore) =>
      state.turns.filter((candidate) => candidate.id === active.id);
    const { executor, store } = createTurnServiceExecutor({
      build,
      conversation,
      turns: [active],
      turnSelections: [[current], [current]],
    });
    const input = {
      userId: active.userId,
      turnId: active.id,
      leaseToken,
      code: "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_INTEGRITY_CONFLICT",
      message: "provider bytes changed",
      failureStage: "provider_file_registration" as const,
      now: new Date("2026-08-01T00:00:20.000Z"),
    };

    const first = await settleKnowledgeBasePreCreateFailureForApprovedReset(
      input,
      executor,
    );
    const duplicate = await settleKnowledgeBasePreCreateFailureForApprovedReset(
      input,
      executor,
    );

    expect(first).toMatchObject({ deduplicated: false });
    expect(duplicate).toMatchObject({ deduplicated: true });
    expect(store.build).toMatchObject({
      status: "protocol_error",
      stateEpoch: 8,
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "RESET_REQUIRED",
      awaitingResponseSince: null,
    });
    expect(store.turns[0]).toMatchObject({
      status: "failed",
      upstreamTaskId: null,
      errorCode: "RESET_REQUIRED",
      leaseExpiresAt: null,
      metadata: {
        createAttemptState: "not_sent",
        providerAttemptState: "not_sent",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        canRegenerate: false,
        failureStage: "provider_file_registration",
        preCreateFailureCauseCode:
          "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_INTEGRITY_CONFLICT",
      },
    });
    expect(store.conversation).toMatchObject({ status: "failed", version: 5 });
  });

  it("refuses to downgrade a create attempt that has already started", async () => {
    const leaseToken = "started-create-reset-lease";
    const active = turn({
      status: "running",
      metadata: {
        attachmentsFrozen: true,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        createAttemptState: "sending",
        providerAttemptState: "sending",
        dispatchingAt: "2026-08-01T00:00:10.000Z",
        leaseOwnerHash: createHash("sha256")
          .update(leaseToken, "utf8")
          .digest("hex"),
      },
    });
    const build = {
      ...currentMaterializedRecoveryBuildAuthority,
      id: active.buildId,
      userId: active.userId,
      conversationId: "conversation-1",
      generation: active.buildGeneration,
      revision: active.expectedRevision,
      currentLeafId: active.expectedLeafId,
      status: "researching",
      stateEpoch: 7,
      activeTurnId: active.id,
      upstreamTaskId: null,
      canonicalTaskId: null,
      canonicalTaskState: "unbound",
    };
    const harness = createTurnServiceExecutor({
      build,
      turns: [active],
      turnSelections: [[[active]]],
    });

    await expect(
      settleKnowledgeBasePreCreateFailureForApprovedReset(
        {
          userId: active.userId,
          turnId: active.id,
          leaseToken,
          code: "LOCAL_FAILURE_AFTER_CREATE_STARTED",
          message: "must not downgrade",
        },
        harness.executor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.store.build).toMatchObject({
      activeTurnId: active.id,
      stateEpoch: 7,
    });
    expect(harness.store.turns[0]).toMatchObject({ status: "running" });
  });
});

describe("knowledge-base safe retry reservation", () => {
  it("keeps hashless staged revise authority bound to the original client manifest", () => {
    const clientAttachmentManifest = [
      {
        filename: "补充资料.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 1_700_000_000_000,
        itemId: "request-hashless:1",
        ordinal: 1,
        total: 1,
      },
    ];
    const authoritativeAttachmentManifest = [
      { ...clientAttachmentManifest[0]!, sha256: "a".repeat(64) },
    ];
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "revise",
      expectedRevision: 7,
      expectedLeafId: "1.8",
    });
    const recovery = {
      kind: "turn",
      conversationId: "conversation-1",
      parentTaskId: "successful-parent-task",
      userMessage: "补充资料",
      attachments: [
        { file_id: "customer-source-file", filename: "补充资料.pdf" },
      ],
      deferredClientAttachments: true,
      clientAttachmentManifest,
      attachmentManifest: authoritativeAttachmentManifest,
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
    };
    const requestBody = {
      prompt: "hashless staged revise prompt",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: recovery.parentTaskId,
      attachments: [
        { file_id: "customer-source-file", filename: "补充资料.pdf" },
        { file_id: "skill-file", filename: "skill.zip" },
        { file_id: "instructions-file", filename: "instructions.txt" },
      ],
    };
    const source = retryableFailedTurn({
      operationType: "revise",
      operationKey,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "revise",
        generation: 3,
        revision: 7,
        leafId: "1.8",
        expectedAttachmentCount: 3,
        userAttachmentCount: 1,
        payload: {
          userMessage: recovery.userMessage,
          attachmentManifest: clientAttachmentManifest,
          skillVersion: recovery.skillVersion,
          skillContentHash: recovery.skillContentHash,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      attachmentFileIds: requestBody.attachments.map(
        (attachment) => attachment.file_id,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 3,
        userAttachmentCount: 1,
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
    } as any;

    expect(inspectKnowledgeBaseRetryAuthority(source, build)).not.toBeNull();
    delete (source.metadata as any).recovery.clientAttachmentManifest;
    expect(inspectKnowledgeBaseRetryAuthority(source, build)).toBeNull();
  });

  it("retains failed-turn authority after mixed v5 inline dispatch while the prepared source ledger stays file-id-only", () => {
    const skillBytes = Buffer.from("pinned materialized v5 Skill bytes");
    const instructionsBytes = Buffer.from(
      "pinned materialized v5 Instructions bytes",
    );
    const workingSetBytes = Buffer.from(
      "pinned materialized Working Set bytes",
    );
    const sha256 = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const sourceAttachments = [
      { file_id: "customer-source-file", filename: "客户资料.pdf" },
      {
        file_id: "skill-source-file",
        filename: "socratic-kb-builder.skill.zip",
      },
      {
        file_id: "working-set-source-file",
        filename: "frontmind-kb-active-working-set.zip",
      },
      {
        file_id: "instructions-source-file",
        filename: "frontmind-kb-instructions.md",
      },
    ];
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: "00000000-0000-4000-8000-000000000002",
      buildGeneration: 3,
      operationType: "revise",
      expectedRevision: 7,
      expectedLeafId: "1.8",
    });
    const recovery = {
      kind: "turn",
      conversationId: "conversation-1",
      parentTaskId: "materialized-parent-task",
      userMessage: "请按补充资料修订当前节点",
      attachments: [sourceAttachments[0]],
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    };
    const requestBody = {
      prompt: "frozen materialized v5 revision prompt",
      agentProfile: "manus-1.6-max",
      attachments: sourceAttachments,
    };
    const source = turn({
      status: "failed",
      operationType: "revise",
      operationKey,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "revise",
        generation: 3,
        revision: 7,
        leafId: "1.8",
        expectedAttachmentCount: sourceAttachments.length,
        userAttachmentCount: 1,
        payload: {
          userMessage: recovery.userMessage,
          attachments: recovery.attachments,
          skillVersion: recovery.skillVersion,
          skillContentHash: recovery.skillContentHash,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      upstreamTaskId: "failed-materialized-v5-task",
      completedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: null,
      attachmentFileIds: sourceAttachments.map(
        (attachment) => attachment.file_id,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: sourceAttachments.length,
        userAttachmentCount: 1,
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        frozenProviderRequestHash: "f".repeat(64),
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
        recovery,
        generatedAttachmentReservations: {
          "skill:1": {
            schemaVersion: 1,
            role: "skill",
            attachmentIndex: 1,
            requestHash: "1".repeat(64),
            idempotencyKeyHash: "2".repeat(64),
            filename: sourceAttachments[1]!.filename,
            mimeType: "application/zip",
            sizeBytes: skillBytes.length,
            contentSha256: sha256(skillBytes),
            localStorageKey: "knowledge-base/build-sources/v5-skill.bin",
            status: "reserved",
            reservedAt: "2026-08-01T00:00:00.000Z",
          },
          "working_set:2": {
            schemaVersion: 1,
            role: "working_set",
            attachmentIndex: 2,
            requestHash: "3".repeat(64),
            idempotencyKeyHash: "4".repeat(64),
            filename: sourceAttachments[2]!.filename,
            mimeType: "application/zip",
            sizeBytes: workingSetBytes.length,
            contentSha256: sha256(workingSetBytes),
            localStorageKey: "knowledge-base/build-sources/v5-working-set.bin",
            status: "reserved",
            reservedAt: "2026-08-01T00:00:00.000Z",
          },
          "instructions:3": {
            schemaVersion: 1,
            role: "instructions",
            attachmentIndex: 3,
            requestHash: "5".repeat(64),
            idempotencyKeyHash: "6".repeat(64),
            filename: sourceAttachments[3]!.filename,
            mimeType: "text/markdown",
            sizeBytes: instructionsBytes.length,
            contentSha256: sha256(instructionsBytes),
            localStorageKey: "knowledge-base/build-sources/v5-instructions.bin",
            status: "reserved",
            reservedAt: "2026-08-01T00:00:00.000Z",
          },
        },
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody,
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
    });
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      status: "protocol_error",
      activeTurnId: source.id,
      ...currentMaterializedRecoveryBuildAuthority,
    } as any;

    expect(inspectKnowledgeBaseRetryAuthority(source, build)).not.toBeNull();
    (
      source.metadata as any
    ).preparedDispatch.requestBody.attachments[0].file_id =
      "forged-customer-source-file";
    expect(inspectKnowledgeBaseRetryAuthority(source, build)).toBeNull();
  });

  it("requires explicit regeneration metadata and rejects a forged rejected start", () => {
    const source = retryableFailedTurn();
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      companyName: "FrontMind 超前智能",
      companyWebsite: "https://www.frontmind.net/",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
    } as any;

    expect(inspectKnowledgeBaseRetryAuthority(source, build)).not.toBeNull();
    for (const metadataPatch of [
      { failureClass: "requires_user_fix" },
      { recoveryAction: "contact_support" },
      { canRegenerate: false },
    ]) {
      const candidate = {
        ...source,
        metadata: { ...(source.metadata as object), ...metadataPatch },
      } as ConversationTurn;
      expect(inspectKnowledgeBaseRetryAuthority(candidate, build)).toBeNull();
    }

    const startRecovery = {
      kind: "start",
      conversationId: "conversation-1",
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      operatorNotes: "",
      attachments: [] as Array<{ file_id: string; filename: string }>,
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      prefillSnapshotId: null,
    };
    const startBody = {
      prompt: "documented rejected start prompt",
      agentProfile: "manus-1.6-max",
      attachments: [
        { file_id: "start-skill", filename: "skill.zip" },
        { file_id: "start-instructions", filename: "instructions.txt" },
      ],
    };
    const startOperationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
    });
    const rejectedStart = turn({
      status: "failed",
      operationType: "start",
      operationKey: startOperationKey,
      buildId: build.id,
      buildGeneration: build.generation,
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: build.generation,
        revision: 0,
        leafId: null,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        payload: {
          companyName: startRecovery.companyName,
          companyWebsite: startRecovery.companyWebsite,
          operatorNotes: startRecovery.operatorNotes,
          attachments: startRecovery.attachments,
          skillVersion: startRecovery.skillVersion,
          skillContentHash: startRecovery.skillContentHash,
          prefillSnapshotId: startRecovery.prefillSnapshotId,
        },
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(startOperationKey),
      ),
      upstreamTaskId: null,
      attachmentFileIds: startBody.attachments.map(
        (attachment) => attachment.file_id,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 0,
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
        createAttemptState: "rejected",
        recovery: startRecovery,
        preparedDispatch: {
          schemaVersion: 2,
          baseUrl: "https://api.example.test",
          requestBody: startBody,
          bodySha256: hashKnowledgeBaseTurnRequest(startBody),
          preparedAt: "2026-08-01T00:00:10.000Z",
        },
      },
      completedAt: new Date("2026-08-01T00:00:20.000Z"),
      leaseExpiresAt: null,
    });
    const startBuild = {
      ...build,
      revision: 0,
      currentLeafId: null,
    };
    expect(
      inspectKnowledgeBaseRetryAuthority(rejectedStart, startBuild),
    ).toBeNull();
  });

  it("refreshes the Skill and finalization bundle only at the failed v4 last leaf", () => {
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.5",
        totalNodeCount: 50,
        confirmedCount: 49,
        directPrefilledCount: 0,
        operationType: "confirm",
      }),
    ).toBe(true);
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.4",
        totalNodeCount: 50,
        confirmedCount: 48,
        directPrefilledCount: 0,
        operationType: "confirm",
      }),
    ).toBe(false);
    expect(
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        skillVersion: "4",
        currentLeafId: "7.5",
        totalNodeCount: 50,
        confirmedCount: 49,
        directPrefilledCount: 0,
        operationType: "revise",
      }),
    ).toBe(false);
  });

  it("accepts a pinned final-delivery Skill upgrade across repeated retries", () => {
    const upgradedHash = "d".repeat(64);
    const source = retryableFailedTurn();
    const recovery = {
      kind: "turn",
      conversationId: "conversation-1",
      parentTaskId: "successful-parent-task",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      skillContentHash: upgradedHash,
      finalPackageRequired: true,
    };
    const requestBody = {
      prompt: "compact final retry prompt",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      taskId: "successful-parent-task",
      attachments: [
        { file_id: "skill-new", filename: "skill.zip" },
        { file_id: "finalization-input", filename: "finalization.zip" },
      ],
    };
    source.attachmentFileIds = ["skill-new", "finalization-input"];
    source.metadata = {
      attachmentsFrozen: true,
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      failureClass: "terminal_requires_regeneration",
      recoveryAction: "regenerate_turn",
      canRegenerate: true,
      recovery,
      preparedDispatch: {
        schemaVersion: 1,
        baseUrl: "https://api.example.test",
        requestBody,
        bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
        preparedAt: "2026-08-01T00:00:10.000Z",
      },
    };
    source.requestHash = hashKnowledgeBaseTurnRequest({
      operationType: "confirm",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      expectedAttachmentCount: 2,
      userAttachmentCount: 0,
      payload: {
        userMessage: recovery.userMessage,
        attachments: recovery.attachments,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      },
    });
    const build = {
      id: source.buildId,
      userId: source.userId,
      conversationId: "conversation-1",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 3,
      revision: 7,
      currentLeafId: "1.8",
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
    } as any;

    expect(inspectKnowledgeBaseRetryAuthority(source, build)).not.toBeNull();
    (source.metadata as any).recovery.finalPackageRequired = false;
    expect(inspectKnowledgeBaseRetryAuthority(source, build)).toBeNull();
  });
});
