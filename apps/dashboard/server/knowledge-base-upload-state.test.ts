import { describe, expect, it } from "vitest";
import type { ConversationTurn, KnowledgeBaseBuild } from "../drizzle/schema";
import { projectKnowledgeBaseUploadStatus } from "./knowledge-base-upload-state";
import { knowledgeBaseMaterializedBusinessProjection } from "./knowledge-base-progress-service";
import { knowledgeBaseRunPhase } from "../shared/knowledge-base-upload-state";

const build = {
  id: "build",
  conversationId: "session",
  enterpriseProjectId: "project",
  generation: 2,
  stateEpoch: 8,
  status: "researching",
  activeTurnId: "turn",
} as KnowledgeBaseBuild;
const turn = (
  metadata: Record<string, unknown>,
  values: Partial<ConversationTurn> = {},
) =>
  ({
    id: "turn",
    clientRequestId: "request",
    operationKey: "operation",
    buildId: "build",
    buildGeneration: 2,
    expectedRevision: 4,
    expectedLeafId: null,
    status: "queued",
    upstreamTaskId: null,
    createdAt: new Date(0),
    metadata,
    ...values,
  }) as ConversationTurn;

describe("authoritative upload business state", () => {
  it.each([
    {
      materializedCompletion: {
        storageKey: "candidate.zip",
        candidateArchiveSha256: "a".repeat(64),
      },
    },
    {
      materializedResultDiagnostics: {
        resultProcessingStage: "canonical_validation",
      },
    },
  ])(
    "agrees with the observation while a real result is being normalized",
    (result) => {
      const current = turn(
        { ...result, createAttemptState: "acknowledged" },
        { status: "running", upstreamTaskId: "task" },
      );
      const progress = knowledgeBaseMaterializedBusinessProjection({
        progress: { operationState: "creating", warningCodes: [] } as any,
        activeTurn: current,
      });
      const status = projectKnowledgeBaseUploadStatus(current, build);
      expect(progress.operationState).toBe("normalizing");
      expect(status.runPhase).toBe("normalizing");
      expect(
        knowledgeBaseRunPhase({
          buildStatus: build.status,
          operationState: progress.operationState,
          turnStatus: current.status,
          upstreamTaskId: current.upstreamTaskId,
          metadata: current.metadata as any,
        }),
      ).toBe(status.runPhase);
    },
  );

  it.each(["sending", "unknown", "acknowledged"])(
    "never grants a second create after a durable %s attempt",
    (createAttemptState) => {
      const status = projectKnowledgeBaseUploadStatus(
        turn({
          awaitingClientAttachments: true,
          createAttemptState,
          userAttachmentCount: 0,
        }),
        build,
      );
      expect(status).toMatchObject({
        runPhase: "dispatching",
        readyToDispatch: false,
        createAttemptState,
        dispatchRecoveryAction: "confirm_dispatch",
      });
      expect(status.allowedActions).not.toContain("dispatch");
    },
  );

  it("keeps a legacy unknown send closed even without createAttemptState", () => {
    expect(
      projectKnowledgeBaseUploadStatus(
        turn({
          awaitingClientAttachments: true,
          dispatchingAt: "2026-09-11T00:00:00Z",
        }),
        build,
      ),
    ).toMatchObject({
      createAttemptState: "unknown",
      readyToDispatch: false,
      dispatchRecoveryAction: "confirm_dispatch",
    });
  });

  it("does not report last generation's published result as the new turn's completion", () => {
    expect(
      projectKnowledgeBaseUploadStatus(
        turn({
          awaitingClientAttachments: true,
          createAttemptState: "not_sent",
          userAttachmentCount: 1,
        }),
        { ...build, status: "published" },
      ),
    ).toMatchObject({ runPhase: "reserved" });
  });
});
