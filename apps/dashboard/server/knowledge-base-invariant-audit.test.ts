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
  knowledgeBaseConversationStorageId,
} from "./knowledge-base-turn-service";

describe("knowledge-base P0 invariant audit", () => {
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

  it("detects multiple live turns and invalid ready artifacts", () => {
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
    expect(
      findKnowledgeBaseInvariantViolations({
        builds: [build],
        turns,
        nodes: [],
      }).map((item) => item.code),
    ).toEqual(
      expect.arrayContaining([
        "MULTIPLE_ACTIVE_TURNS",
        "READY_ARTIFACT_BINDING_INVALID",
      ]),
    );
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
      protocolErrorCode: "UPSTREAM_REJECTED",
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
      errorCode: "UPSTREAM_REJECTED",
      completedAt: new Date(),
      leaseExpiresAt: null,
      attachmentFileIds: ["skill-file"],
      metadata: {
        attachmentsFrozen: true,
        expectedAttachmentCount: 1,
        userAttachmentCount: 0,
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
  });
});
