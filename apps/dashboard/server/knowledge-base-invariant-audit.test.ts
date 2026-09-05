import { describe, expect, it } from "vitest";

import type {
  ConversationTurn,
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { findKnowledgeBaseInvariantViolations } from "./knowledge-base-invariant-audit";
import {
  createKnowledgeBaseOperationKey,
  createKnowledgeBaseUpstreamIdempotencyKey,
  hashKnowledgeBaseTurnRequest,
  hashKnowledgeBaseUpstreamIdempotencyKey,
  inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority,
  inspectKnowledgeBaseRetryAuthority,
  inspectKnowledgeBaseTerminalTaskCreateRejectionAuthority,
  knowledgeBaseConversationStorageId,
} from "./knowledge-base-turn-service";

describe("knowledge-base build-local invariant audit", () => {
  it("detects the exact waiting-without-body production failure", () => {
    const build = {
      id: "build-1",
      generation: 1,
      status: "confirming",
      activeTurnId: null,
      currentLeafId: "1.2",
      packageRevision: null,
      revision: 1,
    } as KnowledgeBaseBuild;
    const node = {
      buildId: "build-1",
      leafId: "1.2",
      status: "current",
      contentMarkdown: null,
    } as KnowledgeBaseBuildNode;
    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns: [],
        nodes: [node],
      }).map((item) => item.code),
    ).toContain("AWAITING_INPUT_WITHOUT_PRESENTATION");
  });

  it("detects multiple live turns without treating package assets as content gates", () => {
    const build = {
      id: "build-1",
      generation: 1,
      status: "ready_to_publish",
      activeTurnId: null,
      currentLeafId: null,
      revision: 8,
      packageRevision: 8,
      packageStorageKey: null,
    } as KnowledgeBaseBuild;
    const turns = ["turn-1", "turn-2"].map(
      (id) =>
        ({
          id,
          buildId: "build-1",
          buildGeneration: 1,
          status: "running",
        }) as ConversationTurn,
    );
    const codes =
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns,
        nodes: [],
      }).map((item) => item.code);
    expect(codes).toContain("MULTIPLE_ACTIVE_TURNS");
    expect(codes).not.toContain("READY_ARTIFACT_BINDING_INVALID");
  });

  it("allows only a fully pinned failed turn as the retry authority", () => {
    const build = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      companyName: "FrontMind",
      companyWebsite: "https://www.frontmind.net",
      skillVersion: "4",
      skillContentHash: "skill-hash",
      generation: 2,
      status: "protocol_error",
      activeTurnId: "turn-failed",
      currentLeafId: "1.2",
      revision: 1,
      protocolErrorCode: "UPSTREAM_CREATE_3",
      packageRevision: null,
    } as KnowledgeBaseBuild;
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.2",
    });
    const recovery = {
      kind: "turn",
      conversationId: build.conversationId,
      parentTaskId: "parent-task",
      userMessage: "确认",
      attachments: [],
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
    };
    const requestBody = {
      prompt: "Pinned prompt",
      agentProfile: "FrontMind-Pro",
      taskMode: "agent" as const,
      attachments: [{ file_id: "skill-file", filename: "skill.zip" }],
      taskId: "parent-task",
    };
    const valid = {
      id: "turn-failed",
      userId: build.userId,
      conversationId: knowledgeBaseConversationStorageId(
        build.userId,
        build.conversationId,
      ),
      apiCredentialId: "credential-1",
      buildId: "build-1",
      buildGeneration: 2,
      status: "failed",
      operationKey,
      operationType: "confirm",
      expectedRevision: 1,
      expectedLeafId: "1.2",
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "confirm",
        generation: 2,
        revision: 1,
        leafId: "1.2",
        expectedAttachmentCount: 1,
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
      errorCode: "UPSTREAM_CREATE_3",
      completedAt: new Date(),
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
        failureClass: "terminal_requires_regeneration",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
        createAttemptState: "not_sent",
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.invalid",
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          requestBody,
          preparedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    } as ConversationTurn;
    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns: [valid],
        nodes: [],
      }).map((item) => item.code),
    ).not.toContain("INVALID_ACTIVE_TURN");

    const terminal = {
      ...valid,
      metadata: {
        ...(valid.metadata as Record<string, unknown>),
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
        createAttemptState: "rejected",
      },
    } as ConversationTurn;
    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns: [terminal],
        nodes: [],
      }).map((item) => item.code),
    ).toContain("INVALID_ACTIVE_TURN");

    const legacyTerminal = {
      ...terminal,
      metadata: {
        ...(terminal.metadata as Record<string, unknown>),
        createAttemptState: undefined,
        dispatchingAt: "2026-08-11T05:32:58.000Z",
        failureClass: "requires_user_fix",
      },
    } as ConversationTurn;
    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns: [legacyTerminal],
        nodes: [],
      }).map((item) => item.code),
    ).not.toContain("INVALID_ACTIVE_TURN");

    const corruptions: ConversationTurn[] = [
      { ...valid, attachmentFileIds: ["different-file"] },
      {
        ...valid,
        metadata: {
          ...(valid.metadata as Record<string, unknown>),
          preparedDispatch: {
            ...((valid.metadata as any).preparedDispatch as object),
            bodySha256: "a".repeat(64),
          },
        },
      } as ConversationTurn,
      { ...valid, requestHash: "b".repeat(64) },
      { ...valid, upstreamIdempotencyKeyHash: "c".repeat(64) },
      { ...valid, userId: build.userId + 1 },
      { ...valid, conversationId: "u7:other-conversation" },
      { ...valid, operationType: "revise" },
      {
        ...valid,
        metadata: {
          ...(valid.metadata as Record<string, unknown>),
          recovery: { ...recovery, conversationId: "other-conversation" },
        },
      } as ConversationTurn,
      {
        ...valid,
        metadata: {
          ...(valid.metadata as Record<string, unknown>),
          createAttemptState: "rejected",
        },
      } as ConversationTurn,
      {
        ...valid,
        metadata: {
          ...(valid.metadata as Record<string, unknown>),
          createAttemptState: "sending",
        },
      } as ConversationTurn,
      {
        ...valid,
        metadata: {
          ...(valid.metadata as Record<string, unknown>),
          createAttemptState: "unknown",
        },
      } as ConversationTurn,
      {
        ...terminal,
        metadata: {
          ...(terminal.metadata as Record<string, unknown>),
          createAttemptState: "unknown",
        },
      } as ConversationTurn,
      {
        ...terminal,
        metadata: {
          ...(terminal.metadata as Record<string, unknown>),
          recoveryAction: "regenerate_turn",
        },
      } as ConversationTurn,
      {
        ...terminal,
        metadata: {
          ...(terminal.metadata as Record<string, unknown>),
          canRegenerate: true,
        },
      } as ConversationTurn,
      { ...terminal, upstreamTaskId: "unexpected-task" },
    ];
    for (const corrupted of corruptions) {
      expect(
        findKnowledgeBaseInvariantViolations({
          builds: [build],
          turns: [corrupted],
          nodes: [],
        }).map((item) => item.code),
      ).toContain("INVALID_ACTIVE_TURN");
    }

    for (const errorCode of [
      "UPSTREAM_CREATE_HTTP_408",
      "UPSTREAM_CREATE_HTTP_425",
      "UPSTREAM_CREATE_HTTP_429",
      "UPSTREAM_CREATE_HTTP_500",
    ]) {
      expect(
        findKnowledgeBaseInvariantViolations({
          builds: [{ ...build, protocolErrorCode: errorCode }],
          turns: [{ ...terminal, errorCode }],
          nodes: [],
        }).map((item) => item.code),
      ).toContain("INVALID_ACTIVE_TURN");
    }
  });

  it("accepts the exact legacy start rejection as read-only seven-file history", () => {
    const ids = Array.from({ length: 7 }, (_, index) => `file-${index + 1}`);
    const userAttachments = ids.slice(0, 5).map((file_id, index) => ({
      file_id,
      filename: `user-${index + 1}.pdf`,
    }));
    const build = {
      id: "build-live",
      userId: 7,
      conversationId: "conversation-live",
      companyName: "Acme",
      companyWebsite: "",
      skillVersion: "4",
      skillContentHash: "skill-hash",
      generation: 1,
      status: "protocol_error",
      activeTurnId: "turn-live",
      currentLeafId: null,
      revision: 0,
      protocolErrorCode: "UPSTREAM_CREATE_3",
      packageRevision: null,
    } as KnowledgeBaseBuild;
    const recovery = {
      kind: "start",
      conversationId: build.conversationId,
      companyName: build.companyName,
      companyWebsite: "",
      operatorNotes: "",
      attachments: userAttachments,
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      includePrefill: false,
      prefillSnapshotId: null,
      instructionsAttachmentRequired: true,
    };
    const requestBody = {
      prompt: "Pinned prompt",
      agentProfile: "FrontMind-Pro",
      taskMode: "agent" as const,
      attachments: ids.map((file_id, index) => ({
        file_id,
        filename: `provider-${index + 1}`,
      })),
    };
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: 1,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
    });
    const requestPayload = {
      companyName: recovery.companyName,
      companyWebsite: recovery.companyWebsite,
      operatorNotes: recovery.operatorNotes,
      attachments: recovery.attachments,
      skillVersion: recovery.skillVersion,
      skillContentHash: recovery.skillContentHash,
      prefillSnapshotId: recovery.prefillSnapshotId,
    };
    const turn = {
      id: "turn-live",
      userId: 7,
      conversationId: knowledgeBaseConversationStorageId(
        7,
        build.conversationId,
      ),
      apiCredentialId: "credential-1",
      buildId: build.id,
      buildGeneration: 1,
      status: "failed",
      upstreamTaskId: null,
      operationKey,
      operationType: "start",
      expectedRevision: 0,
      expectedLeafId: null,
      requestHash: hashKnowledgeBaseTurnRequest({
        operationType: "start",
        generation: 1,
        revision: 0,
        leafId: null,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        payload: requestPayload,
      }),
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      errorCode: "UPSTREAM_CREATE_3",
      completedAt: new Date(),
      leaseExpiresAt: null,
      attachmentFileIds: ids,
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 7,
        userAttachmentCount: 5,
        dispatchingAt: "2026-08-11T05:32:58.000Z",
        dispatchState: "failed",
        failureClass: "requires_user_fix",
        recoveryAction: "contact_support",
        canRegenerate: false,
        recovery,
        preparedDispatch: {
          schemaVersion: 1,
          baseUrl: "https://api.example.invalid",
          bodySha256: hashKnowledgeBaseTurnRequest(requestBody),
          requestBody,
          preparedAt: "2026-08-11T05:32:57.000Z",
        },
      },
    } as ConversationTurn;

    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns: [turn],
        nodes: [],
      }).map((item) => item.code),
    ).not.toContain("INVALID_ACTIVE_TURN");
    expect(inspectKnowledgeBaseRetryAuthority(turn, build)).toBeNull();
    expect(
      inspectKnowledgeBaseTerminalTaskCreateRejectionAuthority(turn, build),
    ).not.toBeNull();
  });

  it("accepts only the exact legacy bound protocol failure as read-only history", () => {
    const build = {
      id: "build-legacy-protocol",
      userId: 7,
      conversationId: "conversation-legacy-protocol",
      companyName: "Acme",
      companyWebsite: "https://example.com",
      skillVersion: "4",
      skillContentHash: "c".repeat(64),
      generation: 1,
      status: "protocol_error",
      activeTurnId: "turn-legacy-protocol",
      upstreamTaskId: "task-legacy-protocol",
      currentLeafId: null,
      revision: 0,
      protocolErrorCode: "PROGRESS_PROTOCOL_INVALID",
      packageRevision: null,
    } as KnowledgeBaseBuild;
    const userAttachment = {
      file_id: "customer-file",
      filename: "company-profile.pdf",
    };
    const recovery = {
      kind: "start",
      conversationId: build.conversationId,
      companyName: build.companyName,
      companyWebsite: build.companyWebsite,
      operatorNotes: "",
      attachments: [userAttachment],
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      includePrefill: false,
      prefillSnapshotId: null,
      protocolFailureObservation: {
        observationKeyHash: "a".repeat(64),
        count: 3,
        firstObservedAt: "2026-08-01T00:00:00.000Z",
        lastObservedAt: "2026-08-01T00:00:10.000Z",
      },
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
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: build.generation,
      operationType: "start",
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
    });
    const turn = {
      id: build.activeTurnId,
      userId: build.userId,
      conversationId: knowledgeBaseConversationStorageId(
        build.userId,
        build.conversationId,
      ),
      apiCredentialId: "credential-legacy",
      buildId: build.id,
      buildGeneration: build.generation,
      status: "failed",
      upstreamTaskId: build.upstreamTaskId,
      operationKey,
      operationType: "start",
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
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
      errorCode: "PROGRESS_PROTOCOL_INVALID",
      completedAt: new Date("2026-08-01T00:00:10.000Z"),
      leaseExpiresAt: null,
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
    } as ConversationTurn;
    const codes = (candidate: ConversationTurn, candidateBuild = build) =>
      findKnowledgeBaseInvariantViolations({
        builds: [candidateBuild],
        turns: [candidate],
        nodes: [],
      }).map((item) => item.code);

    expect(codes(turn)).not.toContain("INVALID_ACTIVE_TURN");
    expect(inspectKnowledgeBaseRetryAuthority(turn, build)).toBeNull();
    expect(
      inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(turn, build),
    ).toBe(true);

    const corruptions: ConversationTurn[] = [
      { ...turn, upstreamTaskId: "other-task" },
      { ...turn, completedAt: new Date("2026-08-01T00:00:11.001Z") },
      { ...turn, leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z") },
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          dispatchingAt: undefined,
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          dispatchingAt: "2026-07-31 23:59:59",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          dispatchingAt: "2026-08-01T00:00:00.001Z",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          failureClass: "terminal_requires_regeneration",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          createAttemptState: "acknowledged",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          dispatchState: "failed",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              count: 2,
            },
          },
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              observationKeyHash: "not-a-hash",
            },
          },
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              firstObservedAt: "2026-08-01T00:00:01.000Z",
            },
          },
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          expectedAttachmentCount: "2",
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          userAttachmentCount: [1],
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          dispatchingAt: ["2026-07-31T23:59:59.000Z"],
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              count: "3",
            },
          },
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              observationKeyHash: [
                recovery.protocolFailureObservation.observationKeyHash,
              ],
            },
          },
        },
      } as ConversationTurn,
      {
        ...turn,
        metadata: {
          ...(turn.metadata as Record<string, unknown>),
          recovery: {
            ...recovery,
            protocolFailureObservation: {
              ...recovery.protocolFailureObservation,
              firstObservedAt: [
                recovery.protocolFailureObservation.firstObservedAt,
              ],
            },
          },
        },
      } as ConversationTurn,
      { ...turn, requestHash: "b".repeat(64) },
    ];
    for (const corrupted of corruptions) {
      expect(codes(corrupted)).toContain("INVALID_ACTIVE_TURN");
      expect(
        inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(
          corrupted,
          build,
        ),
      ).toBe(false);
      expect(inspectKnowledgeBaseRetryAuthority(corrupted, build)).toBeNull();
    }

    expect(
      codes(turn, {
        ...build,
        status: "failed",
      } as KnowledgeBaseBuild),
    ).toContain("INVALID_ACTIVE_TURN");
  });
});
