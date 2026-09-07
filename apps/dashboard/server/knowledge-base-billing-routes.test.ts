// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  scope: vi.fn(),
  credential: vi.fn(),
  funds: vi.fn(),
  dispatchFunds: vi.fn(),
  resume: vi.fn(),
  progress: vi.fn(),
  build: vi.fn(),
}));
vi.mock("./auth-service", async (original) => ({
  ...(await original<typeof import("./auth-service")>()),
  authenticateRequest: mocks.authenticate,
  getEffectiveDecryptedCredentialForAccount: mocks.credential,
  getDecryptedCredentialForKnowledgeBaseUploadReservation: mocks.credential,
}));
vi.mock("./enterprise-project-service", async (original) => ({
  ...(await original<typeof import("./enterprise-project-service")>()),
  resolveEnterpriseProjectScope: mocks.scope,
}));
vi.mock("./ai-billing-service", async (original) => ({
  ...(await original<typeof import("./ai-billing-service")>()),
  assertAiAccountFunds: mocks.funds,
}));
vi.mock("./knowledge-base-billing", async (original) => ({
  ...(await original<typeof import("./knowledge-base-billing")>()),
  assertKnowledgeBaseDispatchFunds: mocks.dispatchFunds,
  continueKnowledgeBaseAfterRecharge: mocks.resume,
}));
vi.mock("./service-entitlement", async (original) => ({
  ...(await original<typeof import("./service-entitlement")>()),
  assertServiceCapability: vi.fn(),
}));
vi.mock("./knowledge-base-reset-service", async (original) => ({
  ...(await original<typeof import("./knowledge-base-reset-service")>()),
  assertKnowledgeBaseWritable: vi.fn(),
}));
vi.mock("./dashboard-service", async (original) => ({
  ...(await original<typeof import("./dashboard-service")>()),
  getDashboardWorkspace: vi.fn(async () => ({
    sourceName: "示例企业",
    payload: { brandName: "示例企业" },
  })),
}));
vi.mock("./knowledge-base-progress-service", async (original) => ({
  ...(await original<typeof import("./knowledge-base-progress-service")>()),
  getKnowledgeBaseProgress: mocks.progress,
  getKnowledgeBaseObservationProjection: vi.fn(async () => null),
}));
vi.mock("./knowledge-base-final-turn-service", async (original) => ({
  ...(await original<typeof import("./knowledge-base-final-turn-service")>()),
  loadKnowledgeBaseBuildRecord: mocks.build,
}));
vi.mock("./knowledge-base-turn-service", async (original) => ({
  ...(await original<typeof import("./knowledge-base-turn-service")>()),
  inspectKnowledgeBaseDeferredDispatchReplay: vi.fn(async () => null),
  inspectKnowledgeBaseTurnReplay: vi.fn(async () => null),
}));
vi.mock("./knowledge-base-materialized-quality", async (original) => ({
  ...(await original<typeof import("./knowledge-base-materialized-quality")>()),
  isMaterializedBuildPublishable: vi.fn(() => true),
}));

import router from "./knowledge-base-api";
import {
  requireExpressAuth,
  attachActiveCredential,
} from "./_core/express-auth";
import { AiBillingError } from "./ai-billing-service";
import { getEnterpriseProjectScope } from "./enterprise-project-context";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

const owner = 7,
  admin = 99;
const projectId = "11111111-1111-4111-8111-111111111111";
const buildId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";

describe("knowledge billing route account ownership", () => {
  let server: ReturnType<typeof createServer>, baseUrl: string;
  beforeAll(async () => {
    // Exercise actual auth/project middleware and each route. Stub unrelated KB
    // reads and the financial service boundary; no provider or database writes.
    const app = express();
    app.use(express.json());
    app.use("/kb", requireExpressAuth, attachActiveCredential, router);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/kb`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: admin,
      role: "admin",
      isActive: true,
    });
    mocks.scope.mockImplementation(async (actor, id) =>
      id === projectId
        ? {
            enterpriseProjectId: projectId,
            ownerUserId: owner,
            actorUserId: actor.id,
            isLegacyDefault: false,
          }
        : null,
    );
    mocks.credential.mockResolvedValue({
      id: "local-credential",
      userId: owner,
      provider: "zhipu",
      version: 1,
    });
    mocks.funds.mockRejectedValue(
      new AiBillingError("AI_BALANCE_INSUFFICIENT"),
    );
    mocks.dispatchFunds.mockRejectedValue(
      new AiBillingError("AI_BALANCE_INSUFFICIENT"),
    );
    mocks.resume.mockImplementation(async (input) => {
      expect(getEnterpriseProjectScope()?.actorUserId ?? admin).toBe(admin);
      return { already: true, turnId: input.turnId };
    });
    mocks.progress.mockResolvedValue(null);
    mocks.build.mockResolvedValue({
      id: buildId,
      userId: owner,
      activeTurnId: turnId,
      revision: 0,
      generation: 1,
      currentLeafId: null,
      executionMode: "materialized_bundle_v1",
      providerProtocol: "manus_v2",
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      contentVersion: 1,
      handoffProvenance: {
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
      },
    });
  });
  async function post(
    path: string,
    body: unknown,
    project: string | null = projectId,
  ) {
    return fetch(
      `${baseUrl}${path}${project ? `?enterpriseProjectId=${project}` : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }
  it("resumes against the enterprise owner while preserving the authenticated administrator", async () => {
    const response = await post("/billing-resume", {
      buildId,
      turnId,
      requestId,
    });
    expect(response.status).toBe(202);
    expect(mocks.resume).toHaveBeenCalledWith({
      userId: owner,
      buildId,
      turnId,
      requestId,
    });
    expect(mocks.scope.mock.calls[0]?.[0].id).toBe(admin);
  });
  it("uses the authenticated account for an account-scoped resume", async () => {
    expect(
      (await post("/billing-resume", { buildId, turnId, requestId }, null))
        .status,
    ).toBe(202);
    expect(mocks.resume).toHaveBeenCalledWith({
      userId: admin,
      buildId,
      turnId,
      requestId,
    });
  });
  it("rejects an unauthorized project before the financial service", async () => {
    expect(
      (await post("/billing-resume", { buildId, turnId, requestId }, buildId))
        .status,
    ).toBe(404);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("checks the enterprise owner's funds for the initial build", async () => {
    const response = await post("/start/reserve", {
      conversationId: "conversation",
      clientRequestId: requestId,
      companyName: "示例企业",
      expectedResetRevision: 0,
      attachmentManifest: [],
    });
    expect(response.status).toBe(402);
    expect(mocks.funds).toHaveBeenCalledWith(owner);
  });
  it("checks the enterprise owner before acquiring a deferred dispatch lease", async () => {
    const response = await post("/turn/dispatch", {
      conversationId: "conversation",
      turnId,
      clientRequestId: requestId,
      expectedResetRevision: 0,
      attachmentManifest: [],
    });
    expect(response.status).toBe(402);
    expect(mocks.dispatchFunds).toHaveBeenCalledWith(owner, turnId);
  });
  it("checks the enterprise owner's funds for a paid node edit", async () => {
    const response = await post("/turn", {
      conversationId: "conversation",
      clientRequestId: requestId,
      userMessage: "修改本节点标题",
      expectedGeneration: 1,
    });
    expect(response.status).toBe(402);
    expect(mocks.funds).toHaveBeenCalledWith(owner);
  });
});
