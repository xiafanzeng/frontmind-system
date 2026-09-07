import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { artifacts, localAssets } from "../drizzle/schema";
import * as fileStore from "./presales-file-store";
import * as database from "./db";
import * as auth from "./auth-service";
import * as dashboard from "./dashboard-service";
import * as entitlement from "./service-entitlement";
import * as knowledge from "./authenticated-knowledge-service";
import * as recovery from "./enterprise-project-recovery";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";

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
  brandQuestionUniverseCanRecheckFailedResult,
  brandQuestionUniverseTerminalResultAction,
  observeBrandQuestionUniverse,
  operationIdempotencyKeyHash,
  persistImmutableResultArtifact,
  runBrandQuestionUniverseWorkerSweep,
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
  it("accepts an original valid delivery before provider failure without repairing invalid or missing failed output", () => {
    expect(brandQuestionUniverseTerminalResultAction("error", "valid")).toBe(
      "publish",
    );
    expect(brandQuestionUniverseTerminalResultAction("error", "invalid")).toBe(
      "fail",
    );
    expect(brandQuestionUniverseTerminalResultAction("error", "missing")).toBe(
      "fail",
    );
    expect(brandQuestionUniverseTerminalResultAction("running", "valid")).toBe(
      "continue",
    );
    expect(
      brandQuestionUniverseTerminalResultAction("cancelled", "valid"),
    ).toBe("fail");
  });
  it("rechecks only an unpublished native-failed existing session and does not permanently fence late files", () => {
    const operation = { status: "failed", errorCode: "PROVIDER_TASK_FAILED" };
    const task = { providerTaskId: "original-session" };
    const context = { firstDispatchState: "sent", publicationOutcome: null };
    expect(
      brandQuestionUniverseCanRecheckFailedResult(operation, task, context),
    ).toBe(true);
    expect(
      brandQuestionUniverseCanRecheckFailedResult(operation, task, context),
    ).toBe(true);
    expect(
      brandQuestionUniverseCanRecheckFailedResult(
        operation,
        { providerTaskId: null },
        context,
      ),
    ).toBe(false);
    expect(
      brandQuestionUniverseCanRecheckFailedResult(
        { ...operation, errorCode: "TASK_CREATE_FAILED" },
        task,
        context,
      ),
    ).toBe(false);
    expect(
      brandQuestionUniverseCanRecheckFailedResult(operation, task, {
        ...context,
        firstDispatchState: "send_ready",
      }),
    ).toBe(false);
    expect(
      brandQuestionUniverseCanRecheckFailedResult(operation, task, {
        ...context,
        publicationOutcome: "published",
      }),
    ).toBe(false);
  });
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

describe("enterprise brand question universe scope", () => {
  afterEach(() => vi.restoreAllMocks());
  const scope = {
    enterpriseProjectId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: 7,
    actorUserId: 99,
    isLegacyDefault: false,
  };
  function chain(rows: unknown[]) {
    const query: any = {};
    for (const method of ["select", "from", "innerJoin", "where", "orderBy", "limit"])
      query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return query;
  }

  it("uses a published project snapshot without subscription dates and keeps administrator ownership separate", async () => {
    vi.spyOn(database, "getDb").mockResolvedValue({ select: () => chain([]) } as never);
    const capability = vi.spyOn(entitlement, "assertServiceCapability").mockResolvedValue({ mode: "operator", service: { validFrom: null } } as never);
    const snapshot = vi.spyOn(knowledge, "getLatestAuthenticatedKnowledgeSnapshot").mockResolvedValue({ id: replayValue.knowledgeSnapshotId, version: 3, documents: [] } as never);
    const workspace = vi.spyOn(dashboard, "getDashboardWorkspace").mockResolvedValue({ revision: 7, payload: { keywordTables: [] } } as never);
    vi.spyOn(auth, "getApiCredentialStatus").mockResolvedValue({ status: "missing" } as never);
    const credential = vi.spyOn(auth, "getDecryptedCredentialForUser").mockResolvedValue(null);
    const actor = { id: 99, role: "admin" } as auth.AuthenticatedUser;
    const result = await runWithEnterpriseProjectScope(scope, () => observeBrandQuestionUniverse(actor));
    expect(result.knowledgeSnapshotId).toBe(replayValue.knowledgeSnapshotId);
    expect(result.reason).toBe("credential_required");
    expect(capability).toHaveBeenCalledWith(7, "globalKeywords");
    expect(snapshot).toHaveBeenCalledWith({ userId: 7, notBefore: new Date(0) });
    expect(workspace).toHaveBeenCalledWith(7);
    expect(credential).toHaveBeenCalledWith(7);
    expect(actor.id).toBe(99);
  });

  it("isolates repeated client request ids by project while preserving migrated default replay keys", () => {
    const original = operationIdempotencyKeyHash(7, "request-1");
    const first = runWithEnterpriseProjectScope(scope, () => operationIdempotencyKeyHash(7, "request-1"));
    const second = runWithEnterpriseProjectScope({ ...scope, enterpriseProjectId: "22222222-2222-4222-8222-222222222222" }, () => operationIdempotencyKeyHash(7, "request-1"));
    expect(first).not.toBe(original);
    expect(first).not.toBe(second);
    expect(runWithEnterpriseProjectScope({ ...scope, isLegacyDefault: true }, () => operationIdempotencyKeyHash(7, "request-1"))).toBe(original);
  });

  it("restores the stored project before background reconciliation", async () => {
    const candidate = { operation: { accountUserId: 7, enterpriseProjectId: scope.enterpriseProjectId }, task: { id: "task-1" } };
    vi.spyOn(database, "getDb").mockResolvedValue({ select: () => chain([candidate]) } as never);
    const restore = vi.spyOn(recovery, "runWithStoredEnterpriseProjectScope").mockResolvedValue(undefined);
    expect(await runBrandQuestionUniverseWorkerSweep()).toEqual({ reconciled: 1, failed: 0 });
    expect(restore).toHaveBeenCalledWith(7, scope.enterpriseProjectId, expect.any(Function));
  });
});

describe("enterprise brand question result assets", () => {
  afterEach(() => vi.restoreAllMocks());
  it("pins local artifacts to the stored operation project and rejects a mismatched replay", async () => {
    const bytes = Buffer.from('{"result":"same content"}');
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const rows = new Map<any, any[]>();
    const db = {
      insert: (table: any) => ({ values: (value: any) => {
        if (!rows.has(table)) rows.set(table, [value]);
        return { onDuplicateKeyUpdate: async () => undefined };
      } }),
      select: () => {
        const query: any = {
          from: (table: any) => { query.table = table; return query; },
          where: () => query,
          limit: async () => rows.get(query.table) ?? [],
        };
        return query;
      },
    };
    vi.spyOn(database, "getDb").mockResolvedValue(db as never);
    vi.spyOn(fileStore, "readStoredPresalesFile").mockResolvedValue({ sizeBytes: bytes.length, sha256 } as never);
    const projectId = "11111111-1111-4111-8111-111111111111";
    const input = {
      owned: { operation: { id: "operation-1", accountUserId: 7, enterpriseProjectId: projectId }, task: { id: "task-1" } } as never,
      sourceEventId: "event-1", attachmentIndex: 0, kind: "json" as const,
      filename: "result.json", mimeType: "application/json", bytes, maxBytes: 1000,
    };
    const coordinate = await runWithEnterpriseProjectScope({ enterpriseProjectId: "22222222-2222-4222-8222-222222222222", actorUserId: 99, ownerUserId: 7, isLegacyDefault: false }, () => persistImmutableResultArtifact(input));
    expect(rows.get(artifacts)).toHaveLength(1);
    expect(rows.get(localAssets)?.[0]).toMatchObject({ id: coordinate.localAssetId, accountUserId: 7, enterpriseProjectId: projectId });
    await expect(persistImmutableResultArtifact(input)).resolves.toEqual(coordinate);
    rows.get(localAssets)![0].enterpriseProjectId = "22222222-2222-4222-8222-222222222222";
    await expect(persistImmutableResultArtifact(input)).rejects.toThrow("BRAND_QUESTION_UNIVERSE_LOCAL_ASSET_CONFLICT");
  });
});
