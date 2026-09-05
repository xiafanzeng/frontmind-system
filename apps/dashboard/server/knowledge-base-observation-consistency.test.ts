import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
} from "../drizzle/schema";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  customerUploadResources: vi.fn().mockResolvedValue([]),
  logCustomerUploadEnrichmentSkipped: vi.fn(),
  readActiveWorkingSet: vi.fn().mockResolvedValue({ validated: {} }),
  projectWorkingSetResources: vi.fn().mockReturnValue([]),
  officialLogoUploadFromTurn: vi.fn(
    (turn: { expectedLeafId?: string; metadata?: Record<string, any> }) =>
      turn.metadata?.recovery?.officialLogoUpload?.verified === true
        ? { leafId: turn.expectedLeafId }
        : null,
  ),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./knowledge-base-customer-upload", () => ({
  knowledgeBaseCustomerUploadResources: dependencies.customerUploadResources,
  logKnowledgeBaseCustomerUploadEnrichmentSkipped:
    dependencies.logCustomerUploadEnrichmentSkipped,
  knowledgeBaseOfficialLogoUploadFromTurn:
    dependencies.officialLogoUploadFromTurn,
}));
vi.mock("./knowledge-base-materialized-assets", () => ({
  readValidatedActiveKnowledgeBaseWorkingSet: dependencies.readActiveWorkingSet,
  projectKnowledgeBaseWorkingSetLeafResources:
    dependencies.projectWorkingSetResources,
}));

import { getKnowledgeBaseObservationProjection } from "./knowledge-base-progress-service";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

function query(values: Record<string, unknown>[]) {
  let selected = [...values];
  const chain = {
    where() {
      return chain;
    },
    orderBy() {
      selected.sort((left, right) =>
        left.ordinal !== undefined || right.ordinal !== undefined
          ? Number(left.ordinal || 0) - Number(right.ordinal || 0)
          : Number(right.sequence || 0) - Number(left.sequence || 0),
      );
      return chain;
    },
    limit(size: number) {
      selected = selected.slice(0, size);
      return chain;
    },
    async for() {
      return selected;
    },
    then<TResult1 = Record<string, unknown>[], TResult2 = never>(
      resolve?:
        | ((
            value: Record<string, unknown>[],
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(selected).then(resolve, reject);
    },
  };
  return chain;
}

function snapshotExecutor(snapshot: {
  build: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  conversation: Record<string, unknown>;
  turns?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === knowledgeBaseBuilds) return query([snapshot.build]);
          if (table === knowledgeBaseBuildNodes) return query(snapshot.nodes);
          if (table === conversations) return query([snapshot.conversation]);
          if (table === conversationTurns) return query(snapshot.turns || []);
          if (table === messages) return query(snapshot.messages || []);
          return query([]);
        },
      };
    },
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "build-snapshot",
    userId: 7,
    conversationId: "conversation-snapshot",
    companyName: "FrontMind超前智能",
    companyWebsite: null,
    skillName: "socratic-kb-builder",
    skillVersion: "4",
    skillContentHash: "a".repeat(64),
    treePolicyVersion: 1,
    initialResearchCoverage: null,
    status: "confirming",
    generation: 1,
    stateEpoch: 1,
    activeTurnId: null,
    upstreamTaskId: "task-old",
    lastAppliedOperationKey: "operation-old",
    currentPresentationKey: "presentation-old",
    revision: 1,
    currentLeafId: "1.1",
    totalNodeCount: 1,
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
    completedAt: null,
    publishedAt: null,
    recoveryLeaseOwnerHash: null,
    recoveryLeaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function node(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "node-old",
    buildId: "build-snapshot",
    leafId: "1.1",
    title: "一句话定位",
    branchId: "identity",
    branchTitle: "企业身份",
    ordinal: 0,
    status: "current",
    transitionReason: null,
    contentMarkdown: "## 1.1 一句话定位\n\n旧快照正文",
    contentSha256: "b".repeat(64),
    lastUserInput: null,
    sourceUrls: [],
    imageUrls: [],
    lastTaskId: "task-old",
    sourceTurnId: null,
    presentationKey: "presentation-old",
    lastResponseAt: now,
    confirmedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const RESET_REQUIRED_NOTICE = {
  code: "RESET_REQUIRED",
  severity: "warning",
  retryable: false,
  failureClass: "requires_user_fix",
  recoveryAction: "approve_reset",
  canRegenerate: false,
  turnId: null,
} as const;

describe("knowledge-base observation consistency", () => {
  it("keeps completed pre-v5 content visible but requires an approved reset", async () => {
    const completedAt = new Date("2026-08-01T00:00:10.000Z");
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "ready_to_publish",
              currentLeafId: null,
              contentCompletedAt: completedAt,
              completedAt,
              packageStatus: "attention_required",
              packageAttemptCount: 8,
              packageLastErrorCode: "LOCAL_PACKAGE_CORE_NODES_INCOMPLETE",
            }),
            nodes: [node({ status: "confirmed" })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation).toMatchObject({
      syncState: "attention_required",
      processingPhase: null,
      contentState: "completed",
      packageState: "attention_required",
      contentCompletedAt: completedAt.getTime(),
      localRestrictions: ["package_attention_required"],
      notice: RESET_REQUIRED_NOTICE,
    });
    expect(observation?.progress.build).toMatchObject({
      status: "protocol_error",
      executionMode: "legacy_conversational",
      protocolError: expect.stringContaining("RESET_REQUIRED"),
    });
  });

  it("requires reset instead of recovering attachment readiness for pre-v5 builds", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-attachments-processing",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-attachments-processing",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-attachments-processing",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "not_sent",
        traceId: "4b8be659-2b38-43f5-b89d-1697e3e77655",
      },
      status: "queued",
      errorCode: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
      errorMessage: "generated attachment is still pending",
      upstreamTaskId: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "running",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject(RESET_REQUIRED_NOTICE);
  });

  it("requires reset instead of reconciling an unknown pre-v5 create outcome", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-create-outcome-unknown",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-create-outcome-unknown",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-create-outcome-unknown",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "unknown",
        traceId: "e948069c-b6e1-4c8f-b829-a3ee6a3495b4",
      },
      status: "running",
      errorCode: "KNOWLEDGE_BASE_CREATE_OUTCOME_UNKNOWN",
      errorMessage: "provider task create outcome unknown",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "running",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject(RESET_REQUIRED_NOTICE);
  });

  it("requires reset for a pre-v5 UPSTREAM_CREATE_3 failure", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-upstream-create-3",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-upstream-create-3",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-upstream-create-3",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        createAttemptState: "rejected",
        traceId: "b150314c-3c10-4073-8ebc-241e16f53600",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
      status: "failed",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "protocol_error",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
              protocolErrorCode: "UPSTREAM_CREATE_3",
              protocolError: "上游已明确拒绝创建本轮任务",
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation.notice).toMatchObject(RESET_REQUIRED_NOTICE);
  });

  it("does not expose legacy UPSTREAM_CREATE_3 recovery coordinates", async () => {
    const now = new Date("2026-08-11T05:32:59.000Z");
    const activeTurn = {
      id: "turn-legacy-upstream-create-3",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-legacy-upstream-create-3",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-legacy-upstream-create-3",
      operationType: "start",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: Array.from(
        { length: 7 },
        (_, index) => `opaque-file-${index + 1}`,
      ),
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
      status: "failed",
      upstreamTaskId: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "protocol_error",
              activeTurnId: activeTurn.id,
              upstreamTaskId: null,
              protocolErrorCode: "UPSTREAM_CREATE_3",
              protocolError: "上游已明确拒绝创建本轮任务",
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.notice).toMatchObject(RESET_REQUIRED_NOTICE);
    expect(observation?.notice).not.toHaveProperty("traceId");
  });

  it("keeps legacy protocol-terminal history read-only behind RESET_REQUIRED", async () => {
    const now = new Date("2026-08-01T00:00:10.000Z");
    const userAttachment = {
      file_id: "customer-file",
      filename: "company-profile.pdf",
    };
    const requestBody = {
      prompt: "Pinned prompt",
      agentProfile: "FrontMind-Pro",
      taskMode: "agent" as const,
      attachments: [
        { file_id: "skill-file", filename: "skill.zip" },
        userAttachment,
      ],
    };
    const {
      createKnowledgeBaseOperationKey,
      createKnowledgeBaseUpstreamIdempotencyKey,
      hashKnowledgeBaseTurnRequest,
      hashKnowledgeBaseUpstreamIdempotencyKey,
    } = await import("./knowledge-base-turn-service");
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
    });
    const recovery = {
      kind: "start",
      conversationId: "conversation-snapshot",
      companyName: "FrontMind超前智能",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [userAttachment],
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      includePrefill: false,
      prefillSnapshotId: null,
      protocolFailureObservation: {
        observationKeyHash: "c".repeat(64),
        count: 3,
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        lastObservedAt: now.toISOString(),
      },
    };
    const activeTurn = {
      id: "turn-legacy-protocol-terminal",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      apiCredentialId: "credential-legacy",
      clientRequestId: "request-legacy-protocol-terminal",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: 1,
        revision: 0,
        leafId: null,
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
      attachmentFileIds: ["skill-file", "customer-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 2,
        userAttachmentCount: 1,
        dispatchingAt: "2026-07-31T23:59:59.000Z",
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.invalid",
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          requestBody,
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      status: "failed",
      upstreamTaskId: "task-legacy-protocol-terminal",
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      errorMessage: "历史知识库协议输出无效",
      leaseExpiresAt: null,
      startedAt: new Date("2026-07-31T23:59:59.000Z"),
      completedAt: now,
      createdAt: new Date("2026-07-31T23:59:58.000Z"),
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "protocol_error",
              stateEpoch: 2,
              revision: 0,
              currentLeafId: null,
              totalNodeCount: 0,
              activeTurnId: activeTurn.id,
              upstreamTaskId: activeTurn.upstreamTaskId,
              lastAppliedOperationKey: null,
              currentPresentationKey: null,
              awaitingResponseSince: null,
              protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
              protocolError: "历史知识库协议输出无效",
            }),
            nodes: [],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation).toMatchObject({
      activeTurn: {
        id: activeTurn.id,
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      },
      notice: RESET_REQUIRED_NOTICE,
    });
  });

  it("shows the official logo only on the initial revision-zero first node", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const initialTurn = {
      id: "turn-initial",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-initial",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-initial",
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      attachmentFileIds: [],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-initial",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockClear();
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              revision: 0,
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [node({ sourceTurnId: initialTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [initialTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(dependencies.customerUploadResources).not.toHaveBeenCalled();
    expect(observation?.approvedPresentation).toMatchObject({
      revision: 0,
      leafId: "1.1",
      imageState: "attached",
      resources: [
        {
          kind: "logo",
          caption: "企业官方主 Logo",
        },
      ],
    });
    expect(
      JSON.stringify(observation?.approvedPresentation?.resources),
    ).not.toContain("official-logo.png");
    expect(
      observation?.approvedPresentation?.resources[0]?.sameOriginUrl,
    ).toMatch(/^\/api\/knowledge-base\/artifacts\/resources\//u);
    expect(
      Object.keys(observation!.approvedPresentation!.resources[0]!).sort(),
    ).toEqual([
      "caption",
      "id",
      "kind",
      "mimeType",
      "sameOriginUrl",
      "sizeBytes",
    ]);
    expect(
      observation?.approvedPresentation?.resources[0]?.sameOriginUrl,
    ).not.toContain("build-snapshot");
  });

  it("shows the exact official Logo on the revised first node that bound its upload", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const logoTurn = {
      id: "turn-official-logo",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-official-logo",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-official-logo",
      operationType: "revise",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-official-logo"],
      metadata: {
        recovery: {
          officialLogoUpload: { verified: true },
        },
      },
      status: "completed",
      upstreamTaskId: "task-official-logo",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              revision: 1,
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [node({ sourceTurnId: logoTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [logoTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      revision: 1,
      leafId: "1.1",
      imageState: "attached",
      resources: [
        {
          kind: "logo",
          caption: "企业官方主 Logo",
        },
      ],
    });
  });

  it("shows a revised first node's verified customer upload without repeating the logo", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-customer-image",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-customer-image",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-customer-image",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-customer-image",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([
      {
        id: "opaque-customer-content",
        kind: "customer_upload",
        caption: "知识库配图",
        sameOriginUrl: `/api/knowledge-base/artifacts/resources/${"c".repeat(43)}.${"d".repeat(43)}`,
        mimeType: "image/jpeg",
        sizeBytes: 1234,
      },
    ]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [
              node({
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      imageState: "attached",
      resources: [
        {
          kind: "customer_upload",
          caption: "知识库配图",
        },
      ],
    });
    expect(
      JSON.stringify(observation?.approvedPresentation?.resources),
    ).not.toContain("customer.jpg");
    expect(
      observation?.approvedPresentation?.resources.some((resource) =>
        resource.sameOriginUrl.startsWith("https://"),
      ),
    ).toBe(false);
  });

  it("keeps progress readable when optional customer-upload enrichment fails", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-customer-image-unavailable",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-customer-image-unavailable",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-customer-image-unavailable",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-customer-image-unavailable",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockRejectedValueOnce(
      new Error("historical upload ledger unavailable"),
    );
    dependencies.logCustomerUploadEnrichmentSkipped.mockClear();
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build(),
            nodes: [node({ sourceTurnId: presentationTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.1",
      imageState: "no_eligible_asset",
      resources: [],
    });
    expect(
      dependencies.logCustomerUploadEnrichmentSkipped,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "progress",
        buildId: "build-snapshot",
        turnId: presentationTurn.id,
      }),
    );
  });

  it("keeps canonical materialized text readable when optional asset enrichment fails", async () => {
    dependencies.readActiveWorkingSet.mockRejectedValueOnce(
      new Error("asset storage temporarily unavailable"),
    );
    dependencies.logCustomerUploadEnrichmentSkipped.mockClear();
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              executionMode: "materialized_bundle_v1",
              providerProtocol: "manus_v2",
              skillVersion: "5",
              skillContentHash:
                KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
              contentVersion: 1,
              activeWorkingSetId: "working-set-1",
              canonicalTaskState: "active",
              handoffProvenance: {
                materializedRecoveryContractVersion: 1,
                materializedCompletionContractVersion: 2,
                materializedQuality: {
                  completeness: "complete",
                  stats: {
                    acceptedCount: 1,
                    expectedCount: 1,
                    droppedCount: 0,
                  },
                  warnings: [],
                  downstreamEligible: true,
                  publishable: true,
                },
              },
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.1",
      visibleMarkdown: expect.stringContaining("旧快照正文"),
      imageState: "no_eligible_asset",
      resources: [],
    });
    expect(observation?.contentAvailability).toBe("complete");
    expect(
      dependencies.logCustomerUploadEnrichmentSkipped,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "progress",
        buildId: "build-snapshot",
      }),
    );
  });

  it("never carries a customer upload onto a different leaf", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-prior-leaf",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-prior-leaf",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-prior-leaf",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      attachmentFileIds: ["file-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-prior-leaf",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({ currentLeafId: "1.2" }),
            nodes: [
              node({
                leafId: "1.2",
                ordinal: 1,
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });
    dependencies.customerUploadResources.mockClear();

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(dependencies.customerUploadResources).not.toHaveBeenCalled();
    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.2",
      imageState: "no_eligible_asset",
      resources: [],
    });
  });

  it("shows a later leaf's customer upload without repeating the official logo", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-later-customer-image",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-later-customer-image",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-later-customer-image",
      operationType: "revise",
      expectedRevision: 1,
      expectedLeafId: "1.2",
      attachmentFileIds: ["file-later-customer-image"],
      metadata: {},
      status: "completed",
      upstreamTaskId: "task-later-customer-image",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.customerUploadResources.mockResolvedValueOnce([
      {
        id: "opaque-later-content",
        kind: "customer_upload",
        caption: "知识库配图",
        sameOriginUrl: `/api/knowledge-base/artifacts/resources/${"e".repeat(43)}.${"f".repeat(43)}`,
        mimeType: "image/png",
        sizeBytes: 222,
      },
    ]);
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              currentLeafId: "1.2",
              logoStorageKey: "knowledge-base/build-snapshot/logo.png",
              logoSha256: "a".repeat(64),
              logoBytes: 345,
              logoFilename: "official-logo.png",
              logoMimeType: "image/png",
            }),
            nodes: [
              node({
                leafId: "1.2",
                ordinal: 1,
                sourceTurnId: presentationTurn.id,
                imageUrls: ["https://crawler.invalid/never-display.jpg"],
              }),
            ],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      leafId: "1.2",
      imageState: "attached",
      resources: [
        {
          kind: "customer_upload",
          caption: "知识库配图",
        },
      ],
    });
    expect(
      observation?.approvedPresentation?.resources.some(
        (resource) => resource.kind === "logo",
      ),
    ).toBe(false);
  });

  it("does not expose the completed parent task while an accepted turn is unbound", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const acceptedTurn = {
      id: "turn-accepted",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-accepted",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-accepted",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "queued",
      upstreamTaskId: null,
      metadata: {},
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({ activeTurnId: acceptedTurn.id }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [acceptedTurn],
            messages: [{ turnId: acceptedTurn.id, role: "user", sequence: 4 }],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation).toMatchObject({
      authoritativeTaskId: null,
      activeTurn: {
        id: "turn-accepted",
        status: "queued",
        messageSequence: 4,
      },
    });
  });

  it("projects canonical request and presentation message sequences", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const presentationTurn = {
      id: "turn-presentation",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-presentation",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-presentation",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: "task-old",
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build(),
            nodes: [node({ sourceTurnId: presentationTurn.id })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [presentationTurn],
            messages: [
              { turnId: presentationTurn.id, role: "user", sequence: 2 },
              {
                turnId: presentationTurn.id,
                role: "assistant",
                sequence: 3,
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toMatchObject({
      turnId: presentationTurn.id,
      generation: 1,
      acceptedAt: Date.parse("2026-08-01T00:00:00.000Z"),
      requestMessageSequence: 2,
      messageSequence: 3,
    });
    expect(observation?.completedTurn).toEqual({
      turnId: presentationTurn.id,
      clientRequestId: presentationTurn.clientRequestId,
      messageSequence: 2,
    });
  });

  it("keeps the accepted presentation visible when activeTurnId is invalid but its historical turn is valid", async () => {
    const presentationTurn = {
      id: "turn-persisted-presentation",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-persisted-presentation",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-persisted-presentation",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: "task-old",
      metadata: {},
      startedAt: new Date("2026-08-01T00:00:05.000Z"),
      completedAt: new Date("2026-08-01T00:00:06.000Z"),
      createdAt: new Date("2026-08-01T00:00:05.000Z"),
      updatedAt: new Date("2026-08-01T00:00:06.000Z"),
    };
    const persistedNode = node({ sourceTurnId: presentationTurn.id });
    const persistedContentSha256 = createHash("sha256")
      .update(persistedNode.contentMarkdown as string)
      .digest("hex");
    const persistedPresentationKey = createHash("sha256")
      .update(["build-snapshot", 1, 1, "1.1", persistedContentSha256].join(":"))
      .digest("hex");
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              activeTurnId: "turn-missing",
              currentPresentationKey: persistedPresentationKey,
              canonicalTaskState: "attention_required",
              protocolErrorCode: "MANUS_V2_TASK_ERROR",
              protocolError: null,
            }),
            nodes: [persistedNode],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            // The current active-turn projection is deliberately unavailable.
            // Authority comes from the immutable receipt plus its independently
            // loaded historical source turn, never from activeTurnId.
            turns: [presentationTurn],
            messages: [
              {
                turnId: presentationTurn.id,
                role: "user",
                sequence: 6,
              },
              {
                id: `u7:msg-kb-presentation-${persistedPresentationKey}`,
                conversationId: "u7:conversation-snapshot",
                userId: 7,
                turnId: presentationTurn.id,
                role: "assistant",
                content: persistedNode.contentMarkdown,
                sequence: 7,
                sentAt: new Date("2026-08-01T00:00:07.000Z"),
                metadata: {
                  knowledgeBase: {
                    schemaVersion: 1,
                    serverOwned: true,
                    kind: "presentation",
                    buildId: "build-snapshot",
                    generation: 1,
                    turnId: presentationTurn.id,
                    operationKey: presentationTurn.operationKey,
                    presentationKey: persistedPresentationKey,
                    // Legacy accepted receipts did not carry an explicit
                    // content hash. The deterministic presentation key still
                    // authenticates the exact content and coordinate.
                    revision: 1,
                    leafId: "1.1",
                  },
                },
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    // The simplified executor cannot evaluate SQL WHERE clauses and therefore
    // returns the historical row for the active-turn lookup too. The assertion
    // below is the important contract: receipt display does not depend on the
    // build's invalid activeTurnId coordinate.
    expect(observation?.approvedPresentation).toMatchObject({
      turnId: presentationTurn.id,
      generation: 1,
      acceptedAt: Date.parse("2026-08-01T00:00:07.000Z"),
      revision: 1,
      leafId: "1.1",
      visibleMarkdown: persistedNode.contentMarkdown,
      messageSequence: 7,
    });
    expect(observation?.displaySequence).toBe(7);
    expect(observation).toMatchObject({
      syncState: "attention_required",
      notice: RESET_REQUIRED_NOTICE,
    });
  });

  it("requires reset instead of attempting pre-v5 format repair", async () => {
    const activeTurn = {
      id: "turn-format-attention",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-format-attention",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-format-attention",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "running",
      upstreamTaskId: "task-old",
      metadata: {
        recoveryAction: "contact_support",
        manusV2Lifecycle: {
          attentionCode: "MANUS_V2_FORMAT_REPAIR_EXPIRED",
        },
      },
      startedAt: new Date("2026-08-01T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-01T00:00:01.000Z"),
      updatedAt: new Date("2026-08-01T00:02:01.000Z"),
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              activeTurnId: activeTurn.id,
              canonicalTaskState: "attention_required",
              protocolErrorCode: "MANUS_V2_FORMAT_REPAIR_EXPIRED",
              protocolError: null,
            }),
            nodes: [node()],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 12,
            },
            turns: [activeTurn],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });
    expect(observation?.notice).toMatchObject(RESET_REQUIRED_NOTICE);
  });

  it("uses a newer completion receipt as displaySequence while retaining the last presentation", async () => {
    const persistedNode = node();
    const contentSha256 = createHash("sha256")
      .update(persistedNode.contentMarkdown as string)
      .digest("hex");
    const acceptedKey = createHash("sha256")
      .update(["build-snapshot", 1, 1, "1.1", contentSha256].join(":"))
      .digest("hex");
    const presentationTurn = {
      id: "turn-presentation",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-presentation",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-presentation",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      metadata: {},
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:10.000Z"),
    };
    const completionTurn = {
      id: "turn-completion",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-completion",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-completion",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "completed",
      metadata: {},
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build(),
            nodes: [persistedNode],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 13,
            },
            turns: [presentationTurn, completionTurn],
            messages: [
              {
                id: `u7:msg-kb-presentation-${acceptedKey}`,
                conversationId: "u7:conversation-snapshot",
                userId: 7,
                turnId: presentationTurn.id,
                role: "assistant",
                content: persistedNode.contentMarkdown,
                sequence: 7,
                sentAt: new Date("2026-08-01T00:00:10.000Z"),
                metadata: {
                  knowledgeBase: {
                    schemaVersion: 1,
                    serverOwned: true,
                    kind: "presentation",
                    buildId: "build-snapshot",
                    generation: 1,
                    turnId: "turn-presentation",
                    operationKey: "operation-presentation",
                    presentationKey: acceptedKey,
                    contentSha256,
                    revision: 1,
                    leafId: "1.1",
                  },
                },
              },
              {
                id: "u7:msg-kb-completion-build-snapshot-1-2",
                conversationId: "u7:conversation-snapshot",
                userId: 7,
                turnId: completionTurn.id,
                role: "assistant",
                content: "知识库内容已完成。下载包正在准备中。",
                sequence: 9,
                metadata: {
                  knowledgeBase: {
                    schemaVersion: 1,
                    serverOwned: true,
                    kind: "completion",
                    buildId: "build-snapshot",
                    generation: 1,
                    turnId: "turn-completion",
                    operationKey: "operation-completion",
                    revision: 2,
                    leafId: null,
                  },
                },
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.displaySequence).toBe(9);
    expect(observation?.approvedPresentation).toMatchObject({
      presentationKey: acceptedKey,
      messageSequence: 7,
      visibleMarkdown: persistedNode.contentMarkdown,
    });
  });

  it("rejects a serverOwned marker that has no historical source turn", async () => {
    const persistedNode = node({
      contentMarkdown: null,
      contentSha256: null,
      sourceTurnId: null,
      presentationKey: null,
    });
    const forgedContent = "## 1.1 一句话定位\n\n伪造正文";
    const contentSha256 = createHash("sha256")
      .update(forgedContent)
      .digest("hex");
    const presentationKey = createHash("sha256")
      .update(["build-snapshot", 1, 1, "1.1", contentSha256].join(":"))
      .digest("hex");
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build(),
            nodes: [persistedNode],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 14,
            },
            turns: [],
            messages: [
              {
                id: `u7:msg-kb-presentation-${presentationKey}`,
                conversationId: "u7:conversation-snapshot",
                userId: 7,
                turnId: "turn-deleted",
                role: "assistant",
                content: forgedContent,
                sequence: 99,
                metadata: {
                  knowledgeBase: {
                    schemaVersion: 1,
                    serverOwned: true,
                    kind: "presentation",
                    buildId: "build-snapshot",
                    generation: 1,
                    turnId: "turn-deleted",
                    operationKey: "operation-forged",
                    presentationKey,
                    contentSha256,
                    revision: 1,
                    leafId: "1.1",
                  },
                },
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation).toBeNull();
    expect(observation?.displaySequence).toBe(0);
  });

  it("does not let a late receipt from an older generation replace the current generation display", async () => {
    const currentContent = "## 1.1 一句话定位\n\n新代正文";
    const staleContent = "## 1.1 一句话定位\n\n旧代迟到正文";
    const receipt = (input: {
      generation: number;
      sequence: number;
      content: string;
      turnId: string;
      operationKey: string;
    }) => {
      const contentSha256 = createHash("sha256")
        .update(input.content)
        .digest("hex");
      const presentationKey = createHash("sha256")
        .update(
          ["build-snapshot", input.generation, 1, "1.1", contentSha256].join(
            ":",
          ),
        )
        .digest("hex");
      return {
        id: `u7:msg-kb-presentation-${presentationKey}`,
        conversationId: "u7:conversation-snapshot",
        userId: 7,
        turnId: input.turnId,
        role: "assistant",
        content: input.content,
        sequence: input.sequence,
        sentAt: new Date(
          `2026-08-01T00:00:${String(input.sequence).padStart(2, "0")}.000Z`,
        ),
        metadata: {
          knowledgeBase: {
            schemaVersion: 1,
            serverOwned: true,
            kind: "presentation",
            buildId: "build-snapshot",
            generation: input.generation,
            turnId: input.turnId,
            operationKey: input.operationKey,
            presentationKey,
            contentSha256,
            revision: 1,
            leafId: "1.1",
          },
        },
      };
    };
    const turn = (input: {
      generation: number;
      id: string;
      operationKey: string;
    }) => ({
      id: input.id,
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: `request-${input.generation}`,
      buildId: "build-snapshot",
      buildGeneration: input.generation,
      operationKey: input.operationKey,
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      metadata: {},
    });
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({ generation: 2 }),
            nodes: [node({ contentMarkdown: currentContent })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 15,
            },
            turns: [
              turn({
                generation: 1,
                id: "turn-generation-1",
                operationKey: "operation-generation-1",
              }),
              turn({
                generation: 2,
                id: "turn-generation-2",
                operationKey: "operation-generation-2",
              }),
            ],
            messages: [
              receipt({
                generation: 1,
                sequence: 20,
                content: staleContent,
                turnId: "turn-generation-1",
                operationKey: "operation-generation-1",
              }),
              receipt({
                generation: 2,
                sequence: 10,
                content: currentContent,
                turnId: "turn-generation-2",
                operationKey: "operation-generation-2",
              }),
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.approvedPresentation?.visibleMarkdown).toBe(
      currentContent,
    );
    expect(observation?.approvedPresentation?.messageSequence).toBe(10);
    expect(observation?.displaySequence).toBe(10);
  });

  it("keeps the old accepted receipt visible while a credential-rebind generation has no new receipt", async () => {
    const oldContent = "## 1.1 一句话定位\n\n旧代已接受正文";
    const contentSha256 = createHash("sha256").update(oldContent).digest("hex");
    const presentationKey = createHash("sha256")
      .update(["build-snapshot", 1, 1, "1.1", contentSha256].join(":"))
      .digest("hex");
    const oldTurn = {
      id: "turn-before-credential-rebind",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-before-credential-rebind",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-before-credential-rebind",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      metadata: {},
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:10.000Z"),
    };
    const rebindTurn = {
      id: "turn-credential-rebind",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "migration-anchor-build-snapshot-g2",
      buildId: "build-snapshot",
      buildGeneration: 2,
      operationKey: "operation-credential-rebind",
      operationType: "legacy_reconcile",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "running",
      upstreamTaskId: null,
      leaseExpiresAt: new Date("2026-08-01T00:05:00.000Z"),
      metadata: {
        repairKind: "canonical_credential_rebind",
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
      },
      createdAt: new Date("2026-08-01T00:01:00.000Z"),
      updatedAt: new Date("2026-08-01T00:01:00.000Z"),
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              providerProtocol: "manus_v2",
              generation: 2,
              stateEpoch: 2,
              activeTurnId: rebindTurn.id,
              canonicalTaskId: null,
              canonicalTaskGeneration: null,
              canonicalCredentialId: null,
              canonicalTaskState: "unbound",
              handoffProvenance: {
                sourceProtocol: "manus_v2",
                sourceGeneration: 1,
                targetGeneration: 2,
                receiptSourceGeneration: 1,
              },
            }),
            nodes: [node({ contentMarkdown: oldContent })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 16,
            },
            turns: [oldTurn, rebindTurn],
            messages: [
              {
                id: `u7:msg-kb-presentation-${presentationKey}`,
                conversationId: "u7:conversation-snapshot",
                userId: 7,
                turnId: oldTurn.id,
                role: "assistant",
                content: oldContent,
                sequence: 12,
                sentAt: new Date("2026-08-01T00:00:10.000Z"),
                metadata: {
                  knowledgeBase: {
                    schemaVersion: 1,
                    serverOwned: true,
                    kind: "presentation",
                    buildId: "build-snapshot",
                    generation: 1,
                    turnId: oldTurn.id,
                    operationKey: oldTurn.operationKey,
                    presentationKey,
                    contentSha256,
                    revision: 1,
                    leafId: "1.1",
                  },
                },
              },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.generation).toBe(2);
    expect(observation?.approvedPresentation).toMatchObject({
      turnId: oldTurn.id,
      visibleMarkdown: oldContent,
      messageSequence: 12,
    });
    expect(observation?.displaySequence).toBe(12);
  });

  it("projects the terminal completed turn after a fast finalizer releases the active turn", async () => {
    const now = new Date("2026-08-01T00:00:05.000Z");
    const staleSameSecondTurn = {
      id: "turn-stale-same-second",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-stale",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-stale",
      operationType: "confirm",
      expectedRevision: 0,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: "task-old",
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const terminalTurn = {
      id: "turn-final",
      conversationId: "u7:conversation-snapshot",
      userId: 7,
      clientRequestId: "request-final",
      buildId: "build-snapshot",
      buildGeneration: 1,
      operationKey: "operation-final",
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.1",
      status: "completed",
      upstreamTaskId: null,
      metadata: {},
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    dependencies.getDb.mockResolvedValue({
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        return operation(
          snapshotExecutor({
            build: build({
              status: "ready_to_publish",
              currentLeafId: null,
              activeTurnId: null,
              lastAppliedOperationKey: terminalTurn.operationKey,
            }),
            nodes: [node({ status: "confirmed" })],
            conversation: {
              id: "u7:conversation-snapshot",
              userId: 7,
              version: 13,
            },
            // Deliberately put the stale row first with identical timestamps;
            // query adapters and database ordering must not choose it.
            turns: [staleSameSecondTurn, terminalTurn],
            messages: [
              {
                turnId: staleSameSecondTurn.id,
                role: "user",
                sequence: 6,
              },
              { turnId: terminalTurn.id, role: "user", sequence: 8 },
            ],
          }),
        );
      },
    });

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(observation?.activeTurn).toBeNull();
    expect(observation?.approvedPresentation).toBeNull();
    expect(observation?.completedTurn).toEqual({
      turnId: terminalTurn.id,
      clientRequestId: terminalTurn.clientRequestId,
      messageSequence: 8,
    });
  });

  it("returns one transactional snapshot while a newer build commits concurrently", async () => {
    const live = {
      build: build(),
      nodes: [node()],
      conversation: { id: "u7:conversation-snapshot", userId: 7, version: 11 },
    };
    let transactionCount = 0;
    let transactionConfig: Record<string, unknown> | undefined;
    const db = {
      select: vi.fn(() => {
        throw new Error("observation attempted an autocommit read");
      }),
      async transaction<T>(
        operation: (tx: any) => Promise<T>,
        config?: Record<string, unknown>,
      ) {
        transactionCount += 1;
        transactionConfig = config;
        const snapshot = {
          build: { ...live.build },
          nodes: live.nodes.map((row) => ({ ...row })),
          conversation: { ...live.conversation },
        };
        const result = operation(snapshotExecutor(snapshot));
        live.build = build({
          stateEpoch: 2,
          revision: 2,
          currentLeafId: "1.2",
          upstreamTaskId: "task-new",
          currentPresentationKey: "presentation-new",
        });
        live.nodes = [
          node({
            id: "node-new",
            leafId: "1.2",
            title: "企业主体",
            contentMarkdown: "## 1.2 企业主体\n\n新快照正文",
            contentSha256: "c".repeat(64),
            presentationKey: "presentation-new",
            lastTaskId: "task-new",
          }),
        ];
        live.conversation = { ...live.conversation, version: 12 };
        return result;
      },
    };
    dependencies.getDb.mockResolvedValue(db);

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(transactionCount).toBe(1);
    expect(transactionConfig).toEqual({ isolationLevel: "repeatable read" });
    expect(db.select).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      stateEpoch: 1,
      generation: 1,
      authoritativeTaskId: "task-old",
      conversationVersion: 11,
      progress: {
        build: { revision: 1, currentLeafId: "1.1" },
      },
      approvedPresentation: {
        revision: 1,
        leafId: "1.1",
        visibleMarkdown: "## 1.1 一句话定位\n\n旧快照正文",
      },
    });
  });

  it("rejects a mixed stateEpoch read and retries from the new authority", async () => {
    const oldSnapshot = {
      build: build(),
      nodes: [node()],
      conversation: {
        id: "u7:conversation-snapshot",
        userId: 7,
        version: 11,
      },
    };
    const newSnapshot = {
      build: build({
        stateEpoch: 2,
        revision: 2,
        currentLeafId: "1.2",
        upstreamTaskId: "task-new",
        currentPresentationKey: "presentation-new",
      }),
      nodes: [
        node({
          id: "node-new",
          leafId: "1.2",
          title: "企业主体",
          contentMarkdown: "## 1.2 企业主体\n\n新快照正文",
          contentSha256: "c".repeat(64),
          presentationKey: "presentation-new",
          lastTaskId: "task-new",
        }),
      ],
      conversation: {
        id: "u7:conversation-snapshot",
        userId: 7,
        version: 12,
      },
    };
    let transactionCount = 0;
    const db = {
      async transaction<T>(operation: (tx: any) => Promise<T>) {
        transactionCount += 1;
        if (transactionCount > 1) {
          return operation(snapshotExecutor(newSnapshot));
        }
        let buildReads = 0;
        const mixedExecutor = {
          select() {
            return {
              from(table: unknown) {
                if (table === knowledgeBaseBuilds) {
                  buildReads += 1;
                  return query([
                    buildReads === 1 ? oldSnapshot.build : newSnapshot.build,
                  ]);
                }
                if (table === knowledgeBaseBuildNodes) {
                  return query(oldSnapshot.nodes);
                }
                if (table === conversations) {
                  return query([newSnapshot.conversation]);
                }
                if (table === conversationTurns) return query([]);
                return query([]);
              },
            };
          },
        };
        return operation(mixedExecutor);
      },
    };
    dependencies.getDb.mockResolvedValue(db);

    const observation = await getKnowledgeBaseObservationProjection({
      userId: 7,
      conversationId: "conversation-snapshot",
    });

    expect(transactionCount).toBe(2);
    expect(observation).toMatchObject({
      stateEpoch: 2,
      authoritativeTaskId: "task-new",
      conversationVersion: 12,
      progress: {
        build: { revision: 2, currentLeafId: "1.2" },
      },
      approvedPresentation: {
        revision: 2,
        leafId: "1.2",
        visibleMarkdown: "## 1.2 企业主体\n\n新快照正文",
      },
    });
  });
});
