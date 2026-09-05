import { describe, expect, it } from "vitest";

import {
  knowledgeBaseNoticeSeverities,
  knowledgeBaseOperationTypes,
  knowledgeBaseTurnStatuses,
  type KnowledgeBaseObservationDto,
} from "./knowledge-base-progress";

describe("knowledge-base observation contract", () => {
  it("publishes the durable operation, turn and notice vocabularies", () => {
    expect(knowledgeBaseOperationTypes).toEqual([
      "start",
      "confirm",
      "direct_prefill",
      "revise",
      "retry",
      "legacy_reconcile",
    ]);
    expect(knowledgeBaseTurnStatuses).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(knowledgeBaseNoticeSeverities).toEqual(["info", "warning", "error"]);
  });

  it("keeps approved content and immutable resources in one observation", () => {
    const observation = {
      stateEpoch: 3,
      generation: 1,
      authoritativeTaskId: "task-1",
      activeTurn: {
        id: "turn-1",
        clientRequestId: "request-1",
        operationKey: "operation-1",
        operationType: "start",
        status: "completed",
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: "1.1",
        startedAt: 1,
        completedAt: 2,
        updatedAt: 2,
      },
      interaction: {
        progress: null,
        interactionState: "awaiting_input",
        canReply: true,
        canPublish: false,
        lockReason: null,
      },
      approvedPresentation: {
        turnId: "turn-1",
        clientRequestId: "request-1",
        presentationKey: "presentation-1",
        revision: 0,
        leafId: "1.1",
        visibleMarkdown: "## 1.1 一句话定位\n\n正文",
        contentSha256: "a".repeat(64),
        imageState: "attached",
        resources: [
          {
            kind: "logo",
            outputItemId: "output-1",
            fileId: "file-1",
            sameOriginUrl: "/api/knowledge-base/resources/logo",
            filename: "logo.png",
            mimeType: "image/png",
            sha256: "b".repeat(64),
            sizeBytes: 1_024,
          },
        ],
      },
      package: null,
      notice: null,
      conversationVersion: 7,
    } satisfies KnowledgeBaseObservationDto;

    expect(observation.approvedPresentation.resources).toHaveLength(1);
    expect(observation.interaction.canReply).toBe(true);
  });
});
