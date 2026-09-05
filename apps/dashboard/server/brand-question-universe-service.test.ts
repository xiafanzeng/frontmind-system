import { describe, expect, it } from "vitest";

import { brandQuestionUniverseStartInputSchema } from "../shared/brand-question-universe";
import {
  BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
  BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
  brandQuestionUniverseCreateFailureDisposition,
  brandQuestionUniverseFirstDispatchAction,
  brandQuestionUniverseFrozenRequestHash,
  brandQuestionUniverseKnowledgeReadiness,
  brandQuestionUniversePreparationServiceError,
  brandQuestionUniverseReplayMatches,
  brandQuestionUniverseStatusFencesStart,
  observeBrandQuestionUniverse,
  projectBrandQuestionUniversePublicOperation,
  startBrandQuestionUniverse,
} from "./brand-question-universe-service";

const replayValue = {
  knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
  clientRequestId: "20000000-0000-4000-8000-000000000001",
  expectedDashboardRevision: 7,
};

function replayContext() {
  return {
    schemaVersion: 1 as const,
    kind: "brand_question_universe_context" as const,
    clientRequestId: replayValue.clientRequestId,
    operationToken:
      "brand-question-universe:30000000-0000-4000-8000-000000000001",
    knowledgeSnapshotId: replayValue.knowledgeSnapshotId,
    knowledgeSnapshotVersion: 3,
    knowledgeArchiveHash: "a".repeat(64),
    expectedDashboardRevision: replayValue.expectedDashboardRevision,
    baselineKeywordTablesFingerprint: "b".repeat(64),
    brandName: "示例品牌",
    inputHashes: {
      upstream: "c".repeat(64),
      adapter: "d".repeat(64),
      knowledge: "e".repeat(64),
    },
    firstDispatchState: "send_ready" as const,
    firstDispatchReservedAtMs: null,
    repairAttempts: 0,
    repairState: "none" as const,
    repairToken: null,
    repairReservedAtMs: null,
    repairErrors: [],
    lastRejectedEventId: null,
    resultArtifacts: null,
    workbookSha256: null,
    tableId: null,
    publicationOutcome: null,
    publishedDashboardRevision: null,
  };
}

describe("brand question universe public API boundary", () => {
  it("requires the frozen snapshot, client request and Dashboard CAS revision", () => {
    expect(
      brandQuestionUniverseStartInputSchema.parse({
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        clientRequestId: "20000000-0000-4000-8000-000000000001",
        expectedDashboardRevision: 7,
      }),
    ).toEqual({
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      clientRequestId: "20000000-0000-4000-8000-000000000001",
      expectedDashboardRevision: 7,
    });
  });

  it("does not project durable operation ids, errors or artifact coordinates", () => {
    const projected = projectBrandQuestionUniversePublicOperation({
      status: "succeeded",
      repairAttempts: 1,
      publicationOutcome: "engineer_won",
      startedAt: 100,
      updatedAt: 200,
    });
    expect(projected).toEqual({
      status: "succeeded",
      repairAttempts: 1,
      publicationOutcome: "engineer_won",
      startedAt: 100,
      updatedAt: 200,
    });
    expect(projected).not.toHaveProperty("id");
    expect(projected).not.toHaveProperty("errorCode");
    expect(projected).not.toHaveProperty("resultArtifacts");
  });

  it("recognizes an exact frozen replay before current mutable prerequisites", () => {
    const context = replayContext();
    const operation = {
      operationType: BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
      contractName: BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
      contractRevision: BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
      requestHash: brandQuestionUniverseFrozenRequestHash(context),
    };
    expect(
      brandQuestionUniverseReplayMatches({
        operation,
        context,
        value: replayValue,
      }),
    ).toBe(true);
    expect(
      brandQuestionUniverseReplayMatches({
        operation,
        context,
        value: { ...replayValue, expectedDashboardRevision: 8 },
      }),
    ).toBe(false);
    expect(
      brandQuestionUniverseReplayMatches({
        operation: { ...operation, requestHash: "f".repeat(64) },
        context,
        value: replayValue,
      }),
    ).toBe(false);

    const startSource = startBrandQuestionUniverse.toString();
    expect(startSource.indexOf("findOperationByClientRequest")).toBeGreaterThan(
      -1,
    );
    expect(startSource.indexOf("findOperationByClientRequest")).toBeLessThan(
      startSource.indexOf("authenticatedSnapshot"),
    );
  });

  it("keeps attention-required operations fenced until reconciliation", () => {
    expect(brandQuestionUniverseStatusFencesStart("attention_required")).toBe(
      true,
    );
    expect(brandQuestionUniverseStatusFencesStart("result_pending")).toBe(true);
    expect(brandQuestionUniverseStatusFencesStart("failed")).toBe(false);
  });

  it("uses one lightweight safe-knowledge readiness contract for observe and start", () => {
    expect(
      brandQuestionUniverseKnowledgeReadiness({
        accepted: Array.from({ length: 56 }, () => ({}) as never),
        acceptedBytes: 1024,
      }),
    ).toEqual({
      ready: true,
      acceptedDocuments: 56,
      acceptedBytes: 1024,
    });
    expect(
      brandQuestionUniverseKnowledgeReadiness({
        accepted: [],
        acceptedBytes: 0,
      }),
    ).toEqual({
      ready: false,
      reason: "safe_knowledge_required",
      acceptedDocuments: 0,
      acceptedBytes: 0,
    });
    expect(
      brandQuestionUniverseKnowledgeReadiness({
        accepted: Array.from({ length: 501 }, () => ({}) as never),
        acceptedBytes: 1024,
      }),
    ).toMatchObject({
      ready: false,
      reason: "knowledge_scope_exceeded",
    });
    expect(
      brandQuestionUniverseKnowledgeReadiness({
        accepted: [{} as never],
        acceptedBytes: 16 * 1024 * 1024 + 1,
      }),
    ).toMatchObject({
      ready: false,
      reason: "knowledge_scope_exceeded",
    });

    const observeSource = observeBrandQuestionUniverse.toString();
    const startSource = startBrandQuestionUniverse.toString();
    expect(observeSource).toContain(
      "classifyBrandQuestionUniverseKnowledgeDocuments",
    );
    expect(startSource).toContain(
      "classifyBrandQuestionUniverseKnowledgeDocuments",
    );
    expect(
      startSource.indexOf("brandQuestionUniverseKnowledgeReadiness"),
    ).toBeLessThan(startSource.indexOf("reserveOperation"));
  });

  it("maps preparation failures to stable customer-safe service errors", () => {
    const empty = brandQuestionUniversePreparationServiceError(
      "safe_knowledge_archive",
      new Error("BRAND_QUESTION_UNIVERSE_SAFE_KNOWLEDGE_EMPTY"),
    );
    expect(empty).toMatchObject({
      code: "SAFE_KNOWLEDGE_REQUIRED",
      statusCode: 412,
      message: "当前认证知识库没有可用于词库生成的公开内容。",
    });
    const oversized = brandQuestionUniversePreparationServiceError(
      "safe_knowledge_archive",
      new Error("BRAND_QUESTION_UNIVERSE_KNOWLEDGE_TOO_LARGE"),
    );
    expect(oversized).toMatchObject({
      code: "KNOWLEDGE_SCOPE_EXCEEDED",
      statusCode: 412,
    });
    const workflow = brandQuestionUniversePreparationServiceError(
      "upstream_workflow",
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    expect(workflow).toMatchObject({
      code: "WORKFLOW_UNAVAILABLE",
      statusCode: 503,
      message: "品牌全域词库服务暂时不可用。",
    });
    expect(
      brandQuestionUniversePreparationServiceError(
        "upstream_workflow",
        new TypeError("unexpected"),
      ),
    ).toBeNull();
    expect(
      brandQuestionUniversePreparationServiceError(
        "safe_knowledge_archive",
        new TypeError("unexpected"),
      ),
    ).toBeNull();
  });

  it("dispatches only send-ready rows and reconciles unknown outcomes by reads", () => {
    expect(
      brandQuestionUniverseFirstDispatchAction({
        providerTaskId: null,
        state: "send_ready",
      }),
    ).toBe("dispatch");
    expect(
      brandQuestionUniverseFirstDispatchAction({
        providerTaskId: null,
        state: "send_unknown",
      }),
    ).toBe("reconcile");
    expect(
      brandQuestionUniverseFirstDispatchAction({
        providerTaskId: "task-1",
        state: "send_unknown",
      }),
    ).toBe("continue");
    expect(
      brandQuestionUniverseFirstDispatchAction({
        providerTaskId: null,
        state: "sent",
      }),
    ).toBe("inconsistent");
  });

  it("never marks an acknowledged create or post-claim persistence failure retryable", () => {
    expect(
      brandQuestionUniverseCreateFailureDisposition({
        createClaimed: true,
        createAcknowledged: true,
        providerError: false,
        outcomeUnknown: false,
      }),
    ).toBe("reconcile");
    expect(
      brandQuestionUniverseCreateFailureDisposition({
        createClaimed: true,
        createAcknowledged: false,
        providerError: false,
        outcomeUnknown: false,
      }),
    ).toBe("reconcile");
    expect(
      brandQuestionUniverseCreateFailureDisposition({
        createClaimed: true,
        createAcknowledged: false,
        providerError: true,
        outcomeUnknown: true,
      }),
    ).toBe("reconcile");
    expect(
      brandQuestionUniverseCreateFailureDisposition({
        createClaimed: true,
        createAcknowledged: false,
        providerError: true,
        outcomeUnknown: false,
      }),
    ).toBe("failed");
    expect(
      brandQuestionUniverseCreateFailureDisposition({
        createClaimed: false,
        createAcknowledged: false,
        providerError: false,
        outcomeUnknown: true,
      }),
    ).toBe("failed");
  });
});
