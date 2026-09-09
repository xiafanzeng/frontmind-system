import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  details: vi.fn(),
  accept: vi.fn(),
  exportWorkspace: vi.fn(),
  save: vi.fn(),
  capability: vi.fn(),
  projection: vi.fn(),
  logo: vi.fn(),
  credential: vi.fn(),
  candidates: vi.fn(),
  claim: vi.fn(),
  manual: vi.fn(),
}));
vi.mock("./knowledge-workbench-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-workbench-service")>()), acceptKnowledgeBaseInitialDraft: mocks.accept,
}));
vi.mock("./knowledge-workbench-export", async (actual) => ({
  ...(await actual<typeof import("./knowledge-workbench-export")>()), exportKnowledgeBaseWorkspace: mocks.exportWorkspace,
}));
vi.mock("./knowledge-node-workspace-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-node-workspace-service")>()),
  getKnowledgeNodeDetails: mocks.details,
  saveKnowledgeNodeContent: mocks.save,
}));
vi.mock("./knowledge-base-progress-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-progress-service")>()),
  getKnowledgeBaseObservationProjection: mocks.projection,
}));
vi.mock("./service-entitlement", async (actual) => ({
  ...(await actual<typeof import("./service-entitlement")>()),
  assertServiceCapability: mocks.capability,
}));
vi.mock("./knowledge-base-logo-provenance-repair", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-logo-provenance-repair")>()),
  inspectKnowledgeBaseFinalLogoProvenance: mocks.logo,
}));
vi.mock("./auth-service", async (actual) => ({
  ...(await actual<typeof import("./auth-service")>()),
  getDecryptedCredentialForKnowledgeBaseReservation: mocks.credential,
}));
vi.mock("./knowledge-base-turn-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-turn-service")>()),
  findRecoverableKnowledgeBaseTurnIds: mocks.candidates,
  claimKnowledgeBaseTurnForRecovery: mocks.claim,
}));
vi.mock("./knowledge-node-manual-edit-service", () => ({
  dispatchManualKnowledgeNodeEdit: mocks.manual,
}));

import router, { recoverExpiredKnowledgeBaseTurns } from "./knowledge-base-api";
import { KnowledgeBaseMaterializedError } from "./knowledge-base-materialized-service";
import { knowledgeNodeSaveSchema } from "./knowledge-node-workspace-service";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";

const request = {
  conversationId: "conversation",
  leafId: "leaf",
  clientRequestId: "save",
  expectedGeneration: 1,
  expectedRevision: 4,
  expectedStateEpoch: 7,
  expectedContentVersion: 1,
  expectedResetRevision: 2,
  contentMarkdown: "# 节点\n\n手动修改",
};
async function invoke(
  path: string,
  method: "get" | "post",
  input: unknown,
  authenticated = true,
) {
  const layer = (router as any).stack.find(
    (item: any) => item.route?.path === path && item.route.methods[method],
  );
  if (!layer) throw new Error(`route missing ${method} ${path}`);
  const response = {
    statusCode: 200,
    body: null as any,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    status(value: number) {
      this.statusCode = value;
      return this;
    },
    json(value: unknown) {
      this.body = toKnowledgeBasePublicPayload(value);
      return this;
    },
  };
  await layer.route.stack[0].handle(
    {
      ...(authenticated ? { frontmindUser: { id: 7 } } : {}),
      query: method === "get" ? input : {},
      body: method === "post" ? input : undefined,
    },
    response,
  );
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KNOWLEDGE_BASE_WRITES_DISABLED;
  mocks.capability.mockResolvedValue(undefined);
  mocks.logo.mockResolvedValue("not_applicable");
  mocks.projection.mockResolvedValue({
    generation: 1,
    stateEpoch: 9,
    activeTurn: null,
    processingPhase: null,
    notice: null,
    localRestrictions: {},
    approvedPresentation: {
      generation: 1,
      revision: 5,
      leafId: "leaf",
      visibleMarkdown: request.contentMarkdown,
    },
    progress: {
      build: {
        id: "build",
        status: "confirming",
        currentLeafId: "leaf",
        revision: 5,
        executionMode: "materialized_bundle_v1",
        skillVersion: "5",
        awaitingResponseSince: null,
      },
      branches: [],
      summary: { handled: 1, total: 30 },
      packageAllowed: false,
      resultQuality: {
        completeness: "complete",
        downstreamEligible: true,
        publishable: true,
      },
    },
  });
  mocks.save.mockImplementation(async (_userId, input) => {
    knowledgeNodeSaveSchema.parse(input);
    return { accepted: true, unchanged: false };
  });
});

describe("knowledge node workspace HTTP", () => {
  it("requires login for initial acceptance and workspace export", async () => {
    expect((await invoke("/initial-draft/accept", "post", {}, false)).statusCode).toBe(401);
    expect((await invoke("/workspace-export", "get", {}, false)).statusCode).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled(); expect(mocks.exportWorkspace).not.toHaveBeenCalled();
  });
  it("returns an observation after initial acceptance without model credentials", async () => {
    mocks.accept.mockResolvedValue({ accepted: true, unchanged: false });
    const result = await invoke("/initial-draft/accept", "post", request);
    expect(result.statusCode).toBe(200); expect(result.body.observation.stateEpoch).toBe(9);
    expect(mocks.accept).toHaveBeenCalledWith(7, request); expect(mocks.credential).not.toHaveBeenCalled();
  });
  it("keeps native download project context outside strict coordinates and reports missing sources before streaming", async () => {
    mocks.exportWorkspace.mockRejectedValue(new KnowledgeBaseMaterializedError("INVALID_BUILD_STATE", "原件暂不可读取"));
    const result = await invoke("/workspace-export", "get", { conversationId: "conversation", enterpriseProjectId: "project-a", expectedGeneration: "1" });
    expect(mocks.exportWorkspace).toHaveBeenCalledWith(7, { conversationId: "conversation", expectedGeneration: "1" });
    expect(result.statusCode).toBe(409); expect(result.body.observation.stateEpoch).toBe(9);
  });
  it("requires login before either read or write", async () => {
    expect((await invoke("/node/content", "get", {}, false)).statusCode).toBe(
      401,
    );
    expect(
      (await invoke("/node/save", "post", request, false)).statusCode,
    ).toBe(401);
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns a safe node read without fetching a whole observation", async () => {
    mocks.details.mockResolvedValue({
      node: { title: "节点", contentMarkdown: "可见正文" },
      resources: [],
    });
    const input = {
      conversationId: "conversation",
      leafId: "leaf",
      expectedGeneration: "1",
      expectedContentVersion: "1",
    };
    const result = await invoke("/node/content", "get", input);
    expect(result.statusCode).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.body.node.contentMarkdown).toBe("可见正文");
    expect(mocks.details).toHaveBeenCalledWith(7, input);
    expect(mocks.projection).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it("returns the authoritative observation after an accepted manual save", async () => {
    const result = await invoke("/node/save", "post", request);
    expect(result.statusCode).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.body).toMatchObject({
      accepted: true,
      unchanged: false,
      observation: {
        generation: 1,
        stateEpoch: 9,
        interaction: { canReply: true },
      },
    });
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it("does not report a committed save as rolled back when its observation read fails", async () => {
    mocks.projection.mockRejectedValueOnce(
      new Error("observation unavailable"),
    );
    const first = await invoke("/node/save", "post", request);
    expect(first.statusCode).toBe(503);
    expect(first.body.error.message).toContain("暂不可确认");
    expect(first.body.error.message).not.toContain("原文已保留");
    const retried = await invoke("/node/save", "post", request);
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toMatchObject({
      accepted: true,
      observation: { stateEpoch: 9 },
    });
    expect(mocks.save).toHaveBeenNthCalledWith(1, 7, request);
    expect(mocks.save).toHaveBeenNthCalledWith(2, 7, request);
  });
  it("returns 409 plus the latest observation for stale reads and saves", async () => {
    mocks.details.mockRejectedValue(
      new KnowledgeBaseMaterializedError("STALE_COORDINATES", "内容已更新"),
    );
    mocks.save.mockRejectedValue(
      new KnowledgeBaseMaterializedError("STALE_COORDINATES", "内容已更新"),
    );
    for (const [path, method] of [
      ["/node/content", "get"],
      ["/node/save", "post"],
    ] as const) {
      const result = await invoke(path, method, request);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({
        error: { code: "STALE_COORDINATES" },
        observation: { stateEpoch: 9 },
      });
    }
  });
  it("returns actionable validation without echoing customer body or unknown fields", async () => {
    const result = await invoke("/node/save", "post", {
      ...request,
      contentMarkdown: "private body",
      apiKey: "test-only",
    });
    expect(result.statusCode).toBe(400);
    expect(result.body.error.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(result.body)).not.toMatch(/private body|test-only/);
  });
  it("leaves the retired snapshot recovery path disabled", async () => {
    expect(
      (await invoke("/canonical/recover-from-snapshot", "post", {})).statusCode,
    ).toBe(410);
  });
  it("recovers the same manual operation before any credential lookup", async () => {
    mocks.candidates.mockResolvedValue([
      { userId: 7, turnId: "manual", enterpriseProjectId: null },
    ]);
    mocks.claim.mockResolvedValue({
      turn: { id: "manual", userId: 7, apiCredentialId: null },
      leaseToken: "lease",
      recoveryMetadata: { nodeEditMode: "manual_v1" },
    });
    mocks.manual.mockResolvedValue({
      taskId: null,
      rebound: false,
      reconciled: true,
    });
    const result = await recoverExpiredKnowledgeBaseTurns({ concurrency: 1 });
    expect(result).toMatchObject({
      scanned: 1,
      claimed: 1,
      reconciled: 1,
      failed: 0,
      credentialPaused: 0,
    });
    expect(mocks.manual).toHaveBeenCalledTimes(1);
    expect(mocks.credential).not.toHaveBeenCalled();
  });
});
