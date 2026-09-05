import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  coverageForTarget,
  createEsaSiteOpsProviderHandler,
  loadFrozenProductionMediaRequirements,
  materializeSiteOpsProductionSource,
  packageEsaStaticAssets,
  productionContractMatchesFrozenBuild,
  type EsaDirectApi,
} from "./esa-provider";
import {
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_MATERIALIZER_V2_7,
  SITEOPS_MATERIALIZER_V2_9,
} from "../../shared/siteops";
import type { SiteContentPlanV2 } from "../../shared/siteops-content-plan";
import { canonicalJson } from "../../shared/siteops-workflow";

const operation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  kind: "deploy",
  input: {},
  result: null,
  providerOperationId: null,
  providerTaskId: null,
  leaseOwner: "lease-1",
  createdAt: new Date("2026-08-26T00:30:00.000Z"),
  updatedAt: new Date("2026-08-26T00:30:00.000Z"),
} as const;

const DYNAMIC_PRODUCTION_PLAN = {
  schemaVersion: 2,
  inventorySha256: "d".repeat(64),
  routes: [
    {
      id: "home",
      path: "/",
      title: "首页",
      navigation: "primary",
      parentPath: null,
      detailOfPath: null,
      purpose: "介绍动态规划的业务入口",
      userQuestions: ["可以解决什么问题？"],
      h1: "由知识库规划的业务入口",
      summary: "这里展示完整知识资料组织出的业务能力。",
      cta: { label: "查看产品能力", targetPath: "/platform/" },
      sections: [
        {
          id: "home-proof",
          blockKind: "prose",
          heading: "知识证据",
          purpose: "展示可核验能力",
          body: "这是由冻结知识资料支持的首页正文。",
          sourceBindings: [
            {
              sourceDocumentId: "doc-dynamic",
              evidenceExcerpt: "冻结知识资料支持动态信息架构。",
            },
          ],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
    },
    {
      id: "platform",
      path: "/platform/",
      title: "产品能力",
      navigation: "primary",
      parentPath: null,
      detailOfPath: null,
      purpose: "汇总知识库中的产品实体",
      userQuestions: ["有哪些产品能力？"],
      h1: "产品能力总览",
      summary: "产品资料丰富，因此由 Manus 规划列表与详情关系。",
      cta: { label: "查看详情", targetPath: "/platform/alpha/" },
      sections: [
        {
          id: "platform-list",
          blockKind: "entity_grid",
          heading: "产品列表",
          purpose: "呈现产品实体",
          body: "Alpha 是知识库中具有完整证据的产品实体。",
          sourceBindings: [
            {
              sourceDocumentId: "doc-dynamic",
              evidenceExcerpt: "冻结知识资料支持动态信息架构。",
            },
          ],
          mediaIds: [],
          entityIds: ["alpha"],
          faqIds: [],
        },
      ],
    },
    {
      id: "platform-alpha",
      path: "/platform/alpha/",
      title: "Alpha 产品",
      navigation: "hidden",
      parentPath: "/platform/",
      detailOfPath: "/platform/",
      purpose: "解释 Alpha 产品详情",
      userQuestions: ["Alpha 如何工作？"],
      h1: "Alpha 产品详情",
      summary: "详情页来自 Manus 对丰富产品资料的拆分。",
      cta: { label: "返回产品能力", targetPath: "/platform/" },
      sections: [
        {
          id: "alpha-detail",
          blockKind: "prose",
          heading: "Alpha 能力",
          purpose: "说明产品详情",
          body: "Alpha 详情正文完整保留冻结知识证据。",
          sourceBindings: [
            {
              sourceDocumentId: "doc-dynamic",
              evidenceExcerpt: "冻结知识资料支持动态信息架构。",
            },
          ],
          mediaIds: [],
          entityIds: ["alpha"],
          faqIds: [],
        },
      ],
    },
  ],
  navigation: [
    { label: "首页", targetPath: "/" },
    { label: "产品能力", targetPath: "/platform/" },
  ],
  coverage: [
    {
      sourceDocumentId: "doc-dynamic",
      status: "used",
      routeIds: ["home", "platform", "platform-alpha"],
      omissionReason: null,
    },
  ],
} satisfies SiteContentPlanV2;

const previousEnabled = process.env.FRONTMIND_ESA_ENABLED;
const previousInstanceId = process.env.FRONTMIND_ESA_INSTANCE_ID;
const previousAccessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const previousAccessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;

function enableEsaTestRuntime() {
  process.env.FRONTMIND_ESA_ENABLED = "1";
  process.env.FRONTMIND_ESA_INSTANCE_ID = "esa-test-instance";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "test-access-key-id";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "test-access-key-secret";
}

function disabledResetOperation(input: {
  revision?: number;
  globalLiveDeploymentId?: string | null;
  canonicalHostname?: string | null;
}) {
  return {
    ...operation,
    kind: "rollback",
    provider: "aliyun_esa",
    attempt: 1,
    input: {
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: "60000000-0000-4000-8000-000000000006",
      expectedProjectRevision: input.revision ?? 9,
      expectedCurrentBuildId: null,
      expectedKnowledgeSnapshotId: null,
      expectedGlobalLiveDeploymentId: input.globalLiveDeploymentId ?? null,
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: input.canonicalHostname ?? null,
    },
  } as const;
}

function disabledResetDb(input: {
  projectRevision?: number;
  projectUpdatedAt?: Date;
  globalLiveDeploymentId?: string | null;
  canonicalHostname?: string | null;
  deployments?: Array<Record<string, unknown>>;
  priorEsaOperations?: Array<Record<string, unknown>>;
  migration0065?: {
    recoveryRows?: Array<Record<string, unknown>>;
    laterOperations?: Array<Record<string, unknown>>;
    laterBuilds?: Array<Record<string, unknown>>;
    laterVisualBatches?: Array<Record<string, unknown>>;
    laterMessages?: Array<Record<string, unknown>>;
  };
}) {
  const project = {
    id: operation.projectId,
    userId: operation.userId,
    conversationId: "siteops:7",
    revision: input.projectRevision ?? 9,
    currentBuildId: null,
    currentKnowledgeSnapshotId: null,
    globalLiveDeploymentId: input.globalLiveDeploymentId ?? null,
    mainlandLiveDeploymentId: null,
    canonicalHostname: input.canonicalHostname ?? null,
    updatedAt: input.projectUpdatedAt ?? new Date("2026-08-26T00:00:00.000Z"),
  };
  const results = input.migration0065
    ? [
        [project],
        input.migration0065.recoveryRows ?? [],
        input.migration0065.laterOperations ?? [],
        input.migration0065.laterBuilds ?? [],
        input.migration0065.laterVisualBatches ?? [],
        input.migration0065.laterMessages ?? [],
        input.deployments ?? [],
        input.priorEsaOperations ?? [],
      ]
    : [[project], input.deployments ?? [], input.priorEsaOperations ?? []];
  let index = 0;
  const select = vi.fn(() => {
    const rows = results[index++] ?? [];
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue(rows),
    };
    return query;
  });
  return { select };
}

function emptyEsaApi() {
  return {
    getRoutine: vi.fn(),
    createRoutine: vi.fn(),
    listCodeVersions: vi.fn(),
    getCodeVersion: vi.fn(),
    createAssetsCodeVersion: vi.fn(),
    createProductionDeployment: vi.fn(),
    listSites: vi.fn(),
    createSite: vi.fn(),
    updateSiteCoverage: vi.fn(),
    verifySite: vi.fn(),
    getMatchSite: vi.fn(),
    listRelatedRecords: vi.fn(),
    createRelatedRecord: vi.fn(),
    deleteRelatedRecord: vi.fn(),
    deleteRoutine: vi.fn(),
    listEdgeRoutineRecords: vi.fn(),
  } satisfies EsaDirectApi;
}

function expectNoEsaApiCalls(api: EsaDirectApi) {
  for (const method of Object.values(api)) {
    expect(method).not.toHaveBeenCalled();
  }
}

afterEach(() => {
  if (previousEnabled === undefined) delete process.env.FRONTMIND_ESA_ENABLED;
  else process.env.FRONTMIND_ESA_ENABLED = previousEnabled;
  if (previousInstanceId === undefined)
    delete process.env.FRONTMIND_ESA_INSTANCE_ID;
  else process.env.FRONTMIND_ESA_INSTANCE_ID = previousInstanceId;
  if (previousAccessKeyId === undefined)
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  else process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousAccessKeyId;
  if (previousAccessKeySecret === undefined)
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  else process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousAccessKeySecret;
  vi.restoreAllMocks();
});

describe("direct ESA SiteOps provider", () => {
  it.each([
    ["global_excluding_cn", "overseas"],
    ["mainland_cn", "domestic"],
  ] as const)("maps %s to the exact ESA coverage %s", (target, coverage) => {
    expect(coverageForTarget(target)).toBe(coverage);
  });

  it("does not fabricate a deployment when the direct adapter is disabled", async () => {
    delete process.env.FRONTMIND_ESA_ENABLED;
    const getDb = vi.fn();
    const handler = createEsaSiteOpsProviderHandler({ getDb: getDb as never });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "attention_required",
      code: "ESA_RUNTIME_DISABLED",
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("allows a disabled-runtime reset only when the database proves there was never ESA exposure", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const db = disabledResetDb({});
    const api = emptyEsaApi();
    const getDb = vi.fn().mockResolvedValue(db);
    const publicHttpsFetch = vi.fn();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: getDb as never,
      api,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: disabledResetOperation({}) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        intent: "approved_reset_unpublish",
        stage: "exposure_removed",
      },
    });
    expect(getDb).toHaveBeenCalledOnce();
    expect(db.select).toHaveBeenCalledTimes(3);
    expectNoEsaApiCalls(api);
    expect(publicHttpsFetch).not.toHaveBeenCalled();
  });

  it("accepts only a proven 0065 revision-only drift before any ESA mutation", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const migrationAt = new Date("2026-08-26T01:00:00.000Z");
    const db = disabledResetDb({
      projectRevision: 10,
      projectUpdatedAt: migrationAt,
      migration0065: {
        recoveryRows: [
          {
            metadata: {
              siteOps: { kind: "operation_recovery", revision: 9 },
            },
            sentAt: new Date("2026-08-26T00:20:00.000Z"),
            updatedAt: migrationAt,
            deletedAt: migrationAt,
          },
        ],
      },
    });
    const api = emptyEsaApi();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
    });

    const result = await handler({
      operation: disabledResetOperation({ revision: 9 }) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        stage: "exposure_removed",
        safeNoExposureProof: {
          source: "migration_0065_revision_only",
          resetOperationId: operation.id,
          expectedProjectRevision: 9,
          observedProjectRevision: 10,
          observedProjectUpdatedAt: migrationAt.toISOString(),
        },
      },
    });
    expect(db.select).toHaveBeenCalledTimes(8);
    expectNoEsaApiCalls(api);
  });

  it.each([
    ["a later SiteOps operation", { laterOperations: [{ id: "later-op" }] }],
    ["a later build", { laterBuilds: [{ id: "later-build" }] }],
    ["a later visual batch", { laterVisualBatches: [{ id: "later-visual" }] }],
    ["a later non-migration message", { laterMessages: [{ id: 44 }] }],
  ] as const)(
    "rejects 0065 drift proof when there is %s",
    async (_label, laterFacts) => {
      process.env.FRONTMIND_ESA_ENABLED = "0";
      const migrationAt = new Date("2026-08-26T01:00:00.000Z");
      const db = disabledResetDb({
        projectRevision: 10,
        projectUpdatedAt: migrationAt,
        migration0065: {
          recoveryRows: [
            {
              metadata: {
                siteOps: { kind: "operation_recovery", revision: 9 },
              },
              sentAt: new Date("2026-08-26T00:20:00.000Z"),
              updatedAt: migrationAt,
              deletedAt: migrationAt,
            },
          ],
          ...laterFacts,
        },
      });
      const api = emptyEsaApi();
      const handler = createEsaSiteOpsProviderHandler({
        getDb: vi.fn().mockResolvedValue(db) as never,
        api,
      });

      const result = await handler({
        operation: disabledResetOperation({ revision: 9 }) as never,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "failed",
        code: "SITEOPS_RESET_INVALIDATED",
      });
      expectNoEsaApiCalls(api);
    },
  );

  it("keeps 0065 revision drift fail-closed when any deployment exists", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const migrationAt = new Date("2026-08-26T01:00:00.000Z");
    const db = disabledResetDb({
      projectRevision: 10,
      projectUpdatedAt: migrationAt,
      migration0065: {
        recoveryRows: [
          {
            metadata: {
              siteOps: { kind: "operation_recovery", revision: 9 },
            },
            sentAt: new Date("2026-08-26T00:20:00.000Z"),
            updatedAt: migrationAt,
            deletedAt: migrationAt,
          },
        ],
      },
      deployments: [{ id: "70000000-0000-4000-8000-000000000007" }],
    });
    const api = emptyEsaApi();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
    });

    const result = await handler({
      operation: disabledResetOperation({ revision: 9 }) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "ESA_RUNTIME_DISABLED",
    });
    expectNoEsaApiCalls(api);
  });

  it("allows a disabled-runtime reset after a strict prior exposure-removed reset", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const priorResetId = "80000000-0000-4000-8000-000000000008";
    const db = disabledResetDb({
      priorEsaOperations: [
        {
          id: priorResetId,
          projectId: operation.projectId,
          kind: "rollback",
          status: "succeeded",
          input: {
            schemaVersion: 1,
            intent: "approved_reset_unpublish",
            rebuildTicketId: "60000000-0000-4000-8000-000000000006",
            expectedProjectRevision: 8,
            expectedCurrentBuildId: null,
            expectedKnowledgeSnapshotId: null,
            expectedGlobalLiveDeploymentId: null,
            expectedMainlandLiveDeploymentId: null,
            expectedCanonicalHostname: null,
          },
          result: {
            schemaVersion: 2,
            intent: "approved_reset_unpublish",
            stage: "exposure_removed",
            resetOperationId: priorResetId,
            projectId: operation.projectId,
            freshRootApplied: true,
            minimumKnowledgeSnapshotVersion: 2,
            resetAppliedProjectRevision: 9,
          },
          providerOperationId: null,
          providerTaskId: null,
          errorCode: null,
        },
      ],
    });
    const api = emptyEsaApi();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
    });

    const result = await handler({
      operation: disabledResetOperation({}) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: { stage: "exposure_removed" },
    });
    expectNoEsaApiCalls(api);
  });

  it("ignores pre-mutation configuration failures and reset-invalidated deployments", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const priorOperationId = "80000000-0000-4000-8000-000000000008";
    const db = disabledResetDb({
      deployments: [
        {
          id: "70000000-0000-4000-8000-000000000007",
          operationId: priorOperationId,
          verification: { resetInvalidated: true },
        },
      ],
      priorEsaOperations: [
        {
          id: priorOperationId,
          projectId: operation.projectId,
          kind: "deploy",
          status: "succeeded",
          input: {},
          result: { stage: "deployed" },
          providerOperationId: "historical-provider-coordinate",
          providerTaskId: null,
          errorCode: null,
        },
        {
          id: "81000000-0000-4000-8000-000000000008",
          projectId: operation.projectId,
          kind: "rollback",
          status: "attention_required",
          input: {},
          result: null,
          providerOperationId: null,
          providerTaskId: null,
          errorCode: "ESA_RUNTIME_DISABLED",
        },
      ],
    });
    const api = emptyEsaApi();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
    });

    const result = await handler({
      operation: disabledResetOperation({}) as never,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expectNoEsaApiCalls(api);
  });

  it.each([
    {
      label: "a historical deployment",
      db: {
        deployments: [{ id: "70000000-0000-4000-8000-000000000007" }],
      },
      operation: {},
    },
    {
      label: "a historical ESA operation",
      db: {
        priorEsaOperations: [{ id: "80000000-0000-4000-8000-000000000008" }],
      },
      operation: {},
    },
    {
      label: "an unresolved active ESA operation",
      db: {
        priorEsaOperations: [
          {
            id: "80000000-0000-4000-8000-000000000008",
            projectId: operation.projectId,
            kind: "deploy",
            status: "running",
            input: {},
            result: { stage: "deployment_unknown" },
            providerOperationId: "provider-boundary",
            providerTaskId: null,
            errorCode: null,
          },
        ],
      },
      operation: {},
    },
    {
      label: "a live head",
      db: {
        globalLiveDeploymentId: "90000000-0000-4000-8000-000000000009",
      },
      operation: {
        globalLiveDeploymentId: "90000000-0000-4000-8000-000000000009",
      },
    },
  ])(
    "still requires configured ESA when reset evidence includes $label",
    async (testCase) => {
      process.env.FRONTMIND_ESA_ENABLED = "0";
      const db = disabledResetDb(testCase.db);
      const api = emptyEsaApi();
      const handler = createEsaSiteOpsProviderHandler({
        getDb: vi.fn().mockResolvedValue(db) as never,
        api,
      });

      const result = await handler({
        operation: disabledResetOperation(testCase.operation) as never,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "attention_required",
        code: "ESA_RUNTIME_DISABLED",
      });
      expectNoEsaApiCalls(api);
    },
  );

  it("uses marker-only verification for a residual hostname without control-plane exposure", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const db = disabledResetDb({ canonicalHostname: "example.com" });
    const api = emptyEsaApi();
    const publicHttpsFetch = vi.fn().mockResolvedValue({
      response: new Response(null, { status: 404 }),
      finalUrl: new URL("https://example.com/frontmind-deployment.json"),
    });
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: disabledResetOperation({
        canonicalHostname: "example.com",
      }) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: { stage: "exposure_removed" },
    });
    expect(publicHttpsFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/frontmind-deployment.json",
        allowedOrigin: "https://example.com",
      }),
    );
    expectNoEsaApiCalls(api);
  });

  it("does not clear a residual hostname when the public marker is still reachable", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const db = disabledResetDb({ canonicalHostname: "example.com" });
    const api = emptyEsaApi();
    const publicHttpsFetch = vi.fn().mockResolvedValue({
      response: new Response(
        JSON.stringify({
          deploymentId: "50000000-0000-4000-8000-000000000005",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      finalUrl: new URL("https://example.com/frontmind-deployment.json"),
    });
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: disabledResetOperation({
        canonicalHostname: "example.com",
      }) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: { stage: "public_marker_verification_retry" },
    });
    expectNoEsaApiCalls(api);
  });

  it("rejects mismatched reset coordinates while ESA is disabled", async () => {
    process.env.FRONTMIND_ESA_ENABLED = "0";
    const db = disabledResetDb({ projectRevision: 10 });
    const api = emptyEsaApi();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
    });

    const result = await handler({
      operation: disabledResetOperation({ revision: 9 }) as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "SITEOPS_RESET_INVALIDATED",
    });
    expect(db.select).toHaveBeenCalledOnce();
    expectNoEsaApiCalls(api);
  });

  it("keeps unexpected ESA failures out of the customer-visible message", async () => {
    enableEsaTestRuntime();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi
        .fn()
        .mockRejectedValue(
          new Error("internal path /app/private and provider payload"),
        ) as never,
    });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "ESA_PROVIDER_FAILED",
    });
    expect(result.message).not.toContain("/app/private");
    expect(result.message).not.toContain("provider payload");
  });

  it("deletes the exact related record and Routine for an approved reset, then verifies absence", async () => {
    enableEsaTestRuntime();
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      revision: 9,
      currentBuildId: "30000000-0000-4000-8000-000000000003",
      currentKnowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      globalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      mainlandLiveDeploymentId: null,
      canonicalHostname: "example.com",
    };
    const routine = {
      name: "frontmind-20000000000040008000000000000002",
      hasAssets: true,
      defaultRelatedRecord: "example.com",
      production: null,
    };
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue([project]),
    };
    const db = {
      select: vi.fn(() => query),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
        })),
      })),
    };
    const api = {
      getRoutine: vi
        .fn()
        .mockResolvedValueOnce(routine)
        .mockResolvedValueOnce(routine)
        .mockResolvedValueOnce(null),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi
        .fn()
        .mockResolvedValueOnce([
          { recordId: 199, recordName: "example.com", siteId: 99 },
        ])
        .mockResolvedValueOnce([]),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn().mockResolvedValue(undefined),
      deleteRoutine: vi.fn().mockResolvedValue(undefined),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const publicHttpsFetch = vi.fn().mockResolvedValue({
      response: new Response(null, { status: 404 }),
      finalUrl: new URL("https://example.com/frontmind-deployment.json"),
    });
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 1,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: project.currentBuildId,
          expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
          expectedGlobalLiveDeploymentId: project.globalLiveDeploymentId,
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        intent: "approved_reset_unpublish",
        stage: "exposure_removed",
      },
    });
    expect(api.deleteRelatedRecord).toHaveBeenCalledWith({
      name: routine.name,
      recordId: 199,
      recordName: "example.com",
      siteId: 99,
    });
    expect(api.deleteRoutine).toHaveBeenCalledWith(routine.name);
    expect(publicHttpsFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/frontmind-deployment.json",
        allowedOrigin: "https://example.com",
      }),
    );
  });

  it("does not finalize reset while the previous public deployment marker remains", async () => {
    enableEsaTestRuntime();
    const previousDeploymentId = "50000000-0000-4000-8000-000000000005";
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      revision: 9,
      currentBuildId: "30000000-0000-4000-8000-000000000003",
      currentKnowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      globalLiveDeploymentId: previousDeploymentId,
      mainlandLiveDeploymentId: null,
      canonicalHostname: "example.com",
    };
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue([project]),
    };
    const api = {
      getRoutine: vi.fn().mockResolvedValue(null),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const publicHttpsFetch = vi.fn().mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          schemaVersion: 2,
          deploymentId: previousDeploymentId,
          distSha256: "a".repeat(64),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      finalUrl: new URL("https://example.com/frontmind-deployment.json"),
    }));
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue({ select: vi.fn(() => query) }) as never,
      api,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 2,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: project.currentBuildId,
          expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
          expectedGlobalLiveDeploymentId: previousDeploymentId,
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        intent: "approved_reset_unpublish",
        stage: "public_marker_propagating",
        stageStartedAttempt: 2,
      },
    });
    expect(api.deleteRoutine).not.toHaveBeenCalled();

    const reconciledLater = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 12,
        result: result.result,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: project.currentBuildId,
          expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
          expectedGlobalLiveDeploymentId: previousDeploymentId,
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });
    expect(reconciledLater).toMatchObject({
      status: "outcome_unknown",
      code: "RESET_UNPUBLISH_OUTCOME_UNKNOWN",
      result: {
        stage: "public_marker_propagating",
        stageStartedAttempt: 2,
      },
    });
  });

  it("does not treat a transient public verification failure as marker absence", async () => {
    enableEsaTestRuntime();
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      revision: 9,
      currentBuildId: "30000000-0000-4000-8000-000000000003",
      currentKnowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      globalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      mainlandLiveDeploymentId: null,
      canonicalHostname: "example.com",
    };
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue([project]),
    };
    const api = {
      getRoutine: vi.fn().mockResolvedValue(null),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue({ select: vi.fn(() => query) }) as never,
      api,
      publicHttpsFetch: vi.fn().mockResolvedValue({
        response: new Response("temporary", { status: 503 }),
        finalUrl: new URL("https://example.com/frontmind-deployment.json"),
      }) as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 4,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: project.currentBuildId,
          expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
          expectedGlobalLiveDeploymentId: project.globalLiveDeploymentId,
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "public_marker_verification_retry",
        stageStartedAttempt: 4,
      },
    });
  });

  it.each([
    ["missing marker id", JSON.stringify({ schemaVersion: 2 })],
    ["malformed marker", "not-json"],
    [
      "unknown marker id",
      JSON.stringify({
        schemaVersion: 2,
        deploymentId: "50000000-0000-4000-8000-000000000099",
      }),
    ],
  ])("requires an explicit not-found response for %s", async (_label, body) => {
    enableEsaTestRuntime();
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      revision: 9,
      currentBuildId: "30000000-0000-4000-8000-000000000003",
      currentKnowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      globalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      mainlandLiveDeploymentId: null,
      canonicalHostname: "example.com",
    };
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue([project]),
    };
    const api = {
      getRoutine: vi.fn().mockResolvedValue(null),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue({ select: vi.fn(() => query) }) as never,
      api,
      publicHttpsFetch: vi.fn().mockResolvedValue({
        response: new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        finalUrl: new URL("https://example.com/frontmind-deployment.json"),
      }) as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 3,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: project.currentBuildId,
          expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
          expectedGlobalLiveDeploymentId: project.globalLiveDeploymentId,
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "public_marker_verification_retry",
        stageStartedAttempt: 3,
      },
    });
  });

  it("invalidates a stale approved reset before any ESA deletion", async () => {
    enableEsaTestRuntime();
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      revision: 10,
      currentBuildId: null,
      currentKnowledgeSnapshotId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      canonicalHostname: "example.com",
    };
    const query: any = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn().mockResolvedValue([project]),
    };
    const api = {
      getRoutine: vi.fn(),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue({ select: vi.fn(() => query) }) as never,
      api,
    });

    const result = await handler({
      operation: {
        ...operation,
        kind: "rollback",
        attempt: 1,
        input: {
          schemaVersion: 1,
          intent: "approved_reset_unpublish",
          rebuildTicketId: "60000000-0000-4000-8000-000000000006",
          expectedProjectRevision: 9,
          expectedCurrentBuildId: "30000000-0000-4000-8000-000000000003",
          expectedKnowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
          expectedGlobalLiveDeploymentId:
            "50000000-0000-4000-8000-000000000005",
          expectedMainlandLiveDeploymentId: null,
          expectedCanonicalHostname: "example.com",
        },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "SITEOPS_RESET_INVALIDATED",
    });
    expect(api.getRoutine).not.toHaveBeenCalled();
    expect(api.deleteRelatedRecord).not.toHaveBeenCalled();
    expect(api.deleteRoutine).not.toHaveBeenCalled();
  });

  it("repackages a frozen dist as ESA assets and adds an exact digest marker", async () => {
    const dist = new JSZip();
    dist.file("index.html", "<!doctype html><title>FrontMind</title>");
    dist.file("assets/app.css", "body{color:#111}");
    const distZip = await dist.generateAsync({ type: "nodebuffer" });
    const hash = "a".repeat(64);

    const packaged = await packageEsaStaticAssets({
      distZip,
      deploymentId: operation.id,
      distHash: hash,
    });
    const parsed = await JSZip.loadAsync(packaged);

    expect(Object.keys(parsed.files).sort()).toEqual([
      "assets/",
      "assets/assets/",
      "assets/assets/app.css",
      "assets/frontmind-deployment.json",
      "assets/index.html",
    ]);
    expect(await parsed.file("assets/index.html")!.async("string")).toContain(
      "FrontMind",
    );
    expect(
      JSON.parse(
        await parsed.file("assets/frontmind-deployment.json")!.async("string"),
      ),
    ).toEqual({
      schemaVersion: 2,
      deploymentId: operation.id,
      distSha256: hash,
    });
  });

  it("rejects a customer dist that collides with the deployment marker", async () => {
    const dist = new JSZip();
    dist.file("index.html", "ok");
    dist.file("frontmind-deployment.json", "forged");
    const distZip = await dist.generateAsync({ type: "nodebuffer" });

    await expect(
      packageEsaStaticAssets({
        distZip,
        deploymentId: operation.id,
        distHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "ESA_DIST_PATH_INVALID" });
  });

  it("freezes a QA-passed production dist before the first ESA mutation", async () => {
    enableEsaTestRuntime();
    const digest = (value: Buffer | string) =>
      createHash("sha256").update(value).digest("hex");
    const sourceZip = Buffer.from("frozen preview source", "utf8");
    const sourceHash = digest(sourceZip);
    const previewDistHash = "3".repeat(64);
    const productionDist = Buffer.from("production dist", "utf8");
    const productionSource = Buffer.from("production source", "utf8");
    const qaZip = Buffer.from("production qa", "utf8");
    const provenanceJson = Buffer.from("{}\n", "utf8");
    const contract = {
      schemaVersion: 2,
      source: {
        knowledgeSnapshotId: "11000000-0000-4000-8000-000000000011",
        archiveSha256: "4".repeat(64),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: "5".repeat(64),
        version: "1.2.0",
        manifestSha256: "6".repeat(64),
        starterVersion: "1.2.0",
        starterSha256: "b".repeat(64),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: "c".repeat(64),
      },
      identity: {
        companyName: "FrontMind Test",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: "7".repeat(64),
        selectedCandidateId: "sample-B",
        providerItemKey: "n:143",
        visualEvidenceSha256: "8".repeat(64),
        previewSha256: "9".repeat(64),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation",
          palette: [],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        designSpecHash: "d".repeat(64),
        componentLibraryVersion: "1.0.0",
      },
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["doc-1"],
        },
      ],
      assets: [],
      seo: {
        siteTitle: "FrontMind Test",
        description: "经过知识来源核验的企业官网。",
        organizationType: "Organization",
        environment: "production",
        canonicalPolicy: "exact_https_origin",
      },
      target: {
        environment: "global_excluding_cn",
        canonicalOrigin: "https://example.com",
      },
      qaPolicyVersion: "siteops-qa-v1",
      specHash: "a".repeat(64),
    };
    const contractJson = Buffer.from(`${JSON.stringify(contract)}\n`, "utf8");
    const output = {
      contractJson,
      contractSha256: digest(contractJson),
      sourceZip: productionSource,
      sourceSha256: digest(productionSource),
      distZip: productionDist,
      distSha256: digest(productionDist),
      qaZip,
      qaSha256: digest(qaZip),
      qaReport: {
        schemaVersion: 1 as const,
        policyVersion: "siteops-qa-v1",
        passed: true as const,
        mode: "production" as const,
        routes: ["/"],
        checks: [
          { id: "production-canonical", passed: true as const, detail: "ok" },
        ],
        browser: {
          lighthouse: {
            performance: 100,
            accessibility: 100,
            bestPractices: 100,
            seo: 100,
            cls: 0,
          },
          axeViolationCount: 0,
          screenshotFiles: ["390.png", "768.png", "1440.png"],
        },
        fileCount: 5,
        totalBytes: productionDist.length,
      },
      provenanceJson,
      provenanceSha256: digest(provenanceJson),
    };
    const deployment: any = {
      id: "12000000-0000-4000-8000-000000000012",
      userId: operation.userId,
      projectId: operation.projectId,
      operationId: operation.id,
      buildId: "13000000-0000-4000-8000-000000000013",
      target: "global_excluding_cn",
      intent: "deploy",
      status: "reserved",
      distLocalAssetId: "14000000-0000-4000-8000-000000000014",
      distHash: previewDistHash,
      verification: null,
    };
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      canonicalHostname: "example.com",
    };
    const build = {
      id: deployment.buildId,
      projectId: operation.projectId,
      userId: operation.userId,
      sourceLocalAssetId: "15000000-0000-4000-8000-000000000015",
      sourceHash,
    };
    const joinedQuery: any = {
      innerJoin: vi.fn(),
      where: vi.fn(() => ({
        limit: vi
          .fn()
          .mockImplementation(async () => [{ deployment, project, build }]),
      })),
    };
    joinedQuery.innerJoin.mockReturnValue(joinedQuery);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => joinedQuery) })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(deployment, values);
          return { where: updateWhere };
        }),
      })),
    };
    const api = {
      getRoutine: vi.fn(),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const artifactIds = [
      "16000000-0000-4000-8000-000000000016",
      "17000000-0000-4000-8000-000000000017",
      "18000000-0000-4000-8000-000000000018",
      "19000000-0000-4000-8000-000000000019",
      "20000000-0000-4000-8000-000000000020",
    ];
    const persistArtifact = vi.fn(async (input: { buffer: Buffer }) => ({
      id: artifactIds[persistArtifact.mock.calls.length - 1],
      contentSha256: digest(input.buffer),
    }));
    const materializeProduction = vi.fn().mockResolvedValue(output);
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      readArtifact: vi.fn().mockResolvedValue({
        row: { sizeBytes: sourceZip.length },
        stored: { createReadStream: () => Readable.from(sourceZip) },
      }) as never,
      persistArtifact: persistArtifact as never,
      materializeProduction,
    });

    const signal = new AbortController().signal;
    const result = await handler({
      operation: { ...operation, attempt: 1 } as never,
      signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "production_materialized",
        productionDistHash: output.distSha256,
      },
    });
    expect(materializeProduction).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceSha256: sourceHash,
        canonicalOrigin: "https://example.com",
        target: "global_excluding_cn",
        abortSignal: signal,
      }),
    );
    expect(persistArtifact).toHaveBeenCalledTimes(5);
    expect(deployment.distHash).toBe(output.distSha256);
    expect(deployment.distHash).not.toBe(previewDistHash);
    expect(deployment.verification.productionMaterialization).toMatchObject({
      canonicalOrigin: "https://example.com",
      distSha256: output.distSha256,
      qaSha256: output.qaSha256,
    });
    expect(api.getRoutine).not.toHaveBeenCalled();
    expect(api.createRoutine).not.toHaveBeenCalled();
    expect(api.createAssetsCodeVersion).not.toHaveBeenCalled();
  });

  it.each([
    SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
    SITEOPS_MATERIALIZER_V2_7.frontMindVersion,
    SITEOPS_MATERIALIZER_V2_9.frontMindVersion,
  ] as const)(
    "rebuilds Native workflow %s with the native production runtime",
    async (workflowVersion) => {
      const digest = (value: Buffer | string) =>
        createHash("sha256").update(value).digest("hex");
      const frozenContentPlan =
        workflowVersion === SITEOPS_MATERIALIZER_V2_9.frontMindVersion
          ? DYNAMIC_PRODUCTION_PLAN
          : undefined;
      const frozenContentPlanSha256 = frozenContentPlan
        ? digest(`${canonicalJson(frozenContentPlan)}\n`)
        : null;
      const archive = new JSZip();
      archive.file(
        "package.json",
        JSON.stringify({
          type: "module",
          dependencies: { react: "19.2.1", "react-dom": "19.2.1" },
        }),
      );
      archive.file(
        "index.html",
        '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
      );
      archive.file(
        "src/main.tsx",
        'import React from "react";import{createRoot}from"react-dom/client";createRoot(document.getElementById("root")!).render(<main>官网</main>);',
      );
      const sourceZip = await archive.generateAsync({ type: "nodebuffer" });
      const sourceSha256 = digest(sourceZip);
      const contractJson = Buffer.from(
        JSON.stringify({
          contractKind: "twenty_first_native_build_contract",
          renderer: "twenty_first_native_react_v1",
        }),
      );
      const qaJson = Buffer.from(
        JSON.stringify({ passed: true, mode: "production" }),
      );
      const nativeOutput = {
        contractJson,
        contractSha256: digest(contractJson),
        sourceZip,
        sourceSha256,
        distZip: Buffer.from("native-production-dist"),
        distSha256: digest("native-production-dist"),
        qaJson,
        qaSha256: digest(qaJson),
        visualQaZip: Buffer.from("native-production-qa"),
        visualQaSha256: digest("native-production-qa"),
        provenanceJson: Buffer.from("{}\n"),
        provenanceSha256: digest("{}\n"),
        buildDelivery: {
          renderMode: "twenty_first_native",
          qaStatus: "passed",
          warningCodes: [],
        },
      };
      const materializeNativeProduction = vi.fn(async (input: any) => {
        expect(input.validatedSource.sourceZip.equals(sourceZip)).toBe(true);
        expect(input.canonicalOrigin).toBe("https://example.com");
        expect(input.target).toBe("global_excluding_cn");
        expect(input.contentPlan).toEqual(frozenContentPlan);
        expect(input.contentPlanSha256).toBe(frozenContentPlanSha256);
        return nativeOutput as never;
      });
      const materializeProduction = vi.fn();

      const output = await materializeSiteOpsProductionSource({
        sourceZip,
        sourceSha256,
        contentPlan: frozenContentPlan,
        build: {
          id: "13000000-0000-4000-8000-000000000013",
          projectId: operation.projectId,
          knowledgeSnapshotId: "11000000-0000-4000-8000-000000000011",
          workflowVersion,
          selectionHash: "a".repeat(64),
          contentPlanSha256: frozenContentPlanSha256,
          brief: {
            companyName: "旧版固定信息架构企业",
            primaryLanguage: "zh-CN",
            contacts: [],
            offerings: [],
            audience: [],
            conversionGoal: "联系咨询",
            contentInventory: {
              schemaVersion: 1,
              source: "frozen_knowledge_snapshot",
              entries: [],
            },
            routes: [
              {
                id: "home",
                slug: "/",
                title: "旧首页",
                sourceDocumentIds: ["doc-dynamic"],
              },
              {
                id: "about",
                slug: "/about/",
                title: "旧关于我们",
                sourceDocumentIds: ["doc-dynamic"],
              },
            ],
            verifiedFacts: [],
            publicAssetIds: [],
            unknowns: [],
          },
        },
        target: "global_excluding_cn",
        canonicalOrigin: "https://example.com",
        materializeProduction: materializeProduction as never,
        materializeNativeProduction: materializeNativeProduction as never,
        signal: new AbortController().signal,
      });

      expect(materializeProduction).not.toHaveBeenCalled();
      expect(materializeNativeProduction).toHaveBeenCalledTimes(1);
      expect(output).toMatchObject({
        sourceSha256,
        distSha256: nativeOutput.distSha256,
        qaSha256: nativeOutput.visualQaSha256,
      });
    },
  );

  it("replays a first-child image into second-child text-only production and separates customer media from knowledge media", async () => {
    const taskStartedAt = new Date("2026-08-30T01:00:00.000Z");
    const rootBuildId = "21000000-0000-4000-8000-000000000001";
    const firstBuildId = "21000000-0000-4000-8000-000000000002";
    const secondBuildId = "21000000-0000-4000-8000-000000000003";
    const epochId = "22000000-0000-4000-8000-000000000001";
    const publicPath = `/frontmind-user-media/${"c".repeat(64)}.png`;
    const customerMediaId = `customer-media:${createHash("sha256")
      .update(publicPath, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const plan = structuredClone(DYNAMIC_PRODUCTION_PLAN);
    plan.routes[0]!.sections[0]!.mediaIds = [customerMediaId];
    const builds = [
      {
        id: rootBuildId,
        parentBuildId: null,
        projectId: operation.projectId,
        userId: operation.userId,
        knowledgeSnapshotId: "23000000-0000-4000-8000-000000000001",
        knowledgeArchiveHash: "d".repeat(64),
        workflowVersion: "2.9.0",
        sourceLocalAssetId: "24000000-0000-4000-8000-000000000001",
        sourceHash: "a".repeat(64),
        contentPlanLocalAssetId: "25000000-0000-4000-8000-000000000001",
        contentPlanSha256: "b".repeat(64),
        createdAt: taskStartedAt,
      },
      {
        id: firstBuildId,
        parentBuildId: rootBuildId,
        projectId: operation.projectId,
        userId: operation.userId,
        knowledgeSnapshotId: "23000000-0000-4000-8000-000000000001",
        knowledgeArchiveHash: "d".repeat(64),
        workflowVersion: "2.9.0",
        sourceLocalAssetId: "24000000-0000-4000-8000-000000000002",
        sourceHash: "e".repeat(64),
        contentPlanLocalAssetId: "25000000-0000-4000-8000-000000000002",
        contentPlanSha256: "f".repeat(64),
        createdAt: new Date("2026-08-30T01:01:00.000Z"),
      },
      {
        id: secondBuildId,
        parentBuildId: firstBuildId,
        projectId: operation.projectId,
        userId: operation.userId,
        knowledgeSnapshotId: "23000000-0000-4000-8000-000000000001",
        knowledgeArchiveHash: "d".repeat(64),
        workflowVersion: "2.9.0",
        sourceLocalAssetId: "24000000-0000-4000-8000-000000000003",
        sourceHash: "1".repeat(64),
        contentPlanLocalAssetId: "25000000-0000-4000-8000-000000000003",
        contentPlanSha256: "2".repeat(64),
        createdAt: new Date("2026-08-30T01:02:00.000Z"),
      },
    ];
    const mediaDescriptor = {
      schemaVersion: 1,
      localAssetId: "26000000-0000-4000-8000-000000000001",
      filename: "产品实拍图.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      contentSha256: "c".repeat(64),
      width: 800,
      height: 600,
      publicPath,
      siteOpsKnowledgeInputEpochId: epochId,
    } as const;
    const revisionOperations = [
      {
        id: "27000000-0000-4000-8000-000000000001",
        buildId: firstBuildId,
        projectId: operation.projectId,
        userId: operation.userId,
        kind: "build_revision",
        status: "succeeded",
        createdAt: new Date("2026-08-30T01:01:00.000Z"),
        input: {
          credentialScope: "customer",
          manusCredentialId: "28000000-0000-4000-8000-000000000001",
          manusCredentialVersion: 1,
          buildId: rootBuildId,
          childBuildId: firstBuildId,
          parentBuildId: rootBuildId,
          feedback: "第一轮加入产品实拍图。",
          revisionBaseline: {
            schemaVersion: 1,
            parentBuildId: rootBuildId,
            sourceLocalAssetId: builds[0]!.sourceLocalAssetId,
            sourceSha256: builds[0]!.sourceHash,
            contentPlanLocalAssetId: builds[0]!.contentPlanLocalAssetId,
            contentPlanSha256: builds[0]!.contentPlanSha256,
          },
          revisionInputAssets: [mediaDescriptor],
        },
      },
      {
        id: "27000000-0000-4000-8000-000000000002",
        buildId: secondBuildId,
        projectId: operation.projectId,
        userId: operation.userId,
        kind: "build_revision",
        status: "succeeded",
        createdAt: new Date("2026-08-30T01:02:00.000Z"),
        input: {
          credentialScope: "customer",
          manusCredentialId: "28000000-0000-4000-8000-000000000001",
          manusCredentialVersion: 1,
          buildId: firstBuildId,
          childBuildId: secondBuildId,
          parentBuildId: firstBuildId,
          feedback: "第二轮只修改文案并保留图片。",
          revisionBaseline: {
            schemaVersion: 1,
            parentBuildId: firstBuildId,
            sourceLocalAssetId: builds[1]!.sourceLocalAssetId,
            sourceSha256: builds[1]!.sourceHash,
            contentPlanLocalAssetId: builds[1]!.contentPlanLocalAssetId,
            contentPlanSha256: builds[1]!.contentPlanSha256,
          },
          revisionInputAssets: [],
        },
      },
    ];
    const mediaRows = [
      {
        id: "29000000-0000-4000-8000-000000000001",
        buildId: firstBuildId,
        projectId: operation.projectId,
        userId: operation.userId,
        sourceAssetId: "asset_source_first",
        ...mediaDescriptor,
        ordinal: 1,
        taskStartedAt,
        createdAt: new Date("2026-08-30T01:01:00.000Z"),
      },
    ];
    const queuedRows = [builds, revisionOperations, mediaRows];
    let queryIndex = 0;
    const db = {
      select: vi.fn(() => {
        const rows = queuedRows[queryIndex++] ?? [];
        const query: any = {
          from: vi.fn(() => query),
          where: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows),
        };
        return query;
      }),
    };

    const result = await loadFrozenProductionMediaRequirements({
      db: db as never,
      context: {
        build: builds[2],
        project: {
          currentTaskStartedAt: taskStartedAt,
          knowledgeInputEpochId: epochId,
        },
      } as never,
      operation: operation as never,
      contentPlan: plan,
    });

    expect(result).toEqual({
      requiredUserMedia: [{ publicPath, contentSha256: "c".repeat(64) }],
      requiredKnowledgeMedia: [],
    });
    expect(queryIndex).toBe(3);

    const removedMediaPlan = structuredClone(plan);
    removedMediaPlan.routes[0]!.sections[0]!.mediaIds = [];
    const removedQueue = [builds, revisionOperations, mediaRows];
    let removedIndex = 0;
    const removedDb = {
      select: vi.fn(() => {
        const rows = removedQueue[removedIndex++] ?? [];
        const query: any = {
          from: vi.fn(() => query),
          where: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows),
        };
        return query;
      }),
    };
    await expect(
      loadFrozenProductionMediaRequirements({
        db: removedDb as never,
        context: {
          build: builds[2],
          project: {
            currentTaskStartedAt: taskStartedAt,
            knowledgeInputEpochId: epochId,
          },
        } as never,
        operation: operation as never,
        contentPlan: removedMediaPlan,
      }),
    ).resolves.toEqual({
      requiredUserMedia: [],
      requiredKnowledgeMedia: [],
    });

    const repeatedDescriptor = {
      ...mediaDescriptor,
      localAssetId: "26000000-0000-4000-8000-000000000002",
    };
    const repeatedRows = [
      ...mediaRows,
      {
        ...mediaRows[0]!,
        id: "29000000-0000-4000-8000-000000000002",
        buildId: secondBuildId,
        sourceAssetId: "asset_source_second",
        localAssetId: repeatedDescriptor.localAssetId,
        createdAt: new Date("2026-08-30T01:02:00.000Z"),
      },
    ];
    const repeatedOperations = [
      revisionOperations[0]!,
      {
        ...revisionOperations[1]!,
        input: {
          ...revisionOperations[1]!.input,
          revisionInputAssets: [repeatedDescriptor],
        },
      },
    ];
    const repeatedQueue = [builds, repeatedOperations, repeatedRows];
    let repeatedIndex = 0;
    const repeatedDb = {
      select: vi.fn(() => {
        const rows = repeatedQueue[repeatedIndex++] ?? [];
        const query: any = {
          from: vi.fn(() => query),
          where: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows),
        };
        return query;
      }),
    };
    await expect(
      loadFrozenProductionMediaRequirements({
        db: repeatedDb as never,
        context: {
          build: builds[2],
          project: {
            currentTaskStartedAt: taskStartedAt,
            knowledgeInputEpochId: epochId,
          },
        } as never,
        operation: operation as never,
        contentPlan: plan,
      }),
    ).resolves.toEqual({
      requiredUserMedia: [{ publicPath, contentSha256: "c".repeat(64) }],
      requiredKnowledgeMedia: [],
    });

    const missingPlanMedia = structuredClone(plan);
    missingPlanMedia.routes[0]!.sections[0]!.mediaIds = [
      `customer-media:${"0".repeat(32)}`,
    ];
    const missingQueue = [builds, revisionOperations, mediaRows];
    let missingIndex = 0;
    const missingDb = {
      select: vi.fn(() => {
        const rows = missingQueue[missingIndex++] ?? [];
        const query: any = {
          from: vi.fn(() => query),
          where: vi.fn().mockResolvedValue(rows),
          limit: vi.fn().mockResolvedValue(rows),
        };
        return query;
      }),
    };
    await expect(
      loadFrozenProductionMediaRequirements({
        db: missingDb as never,
        context: {
          build: builds[2],
          project: {
            currentTaskStartedAt: taskStartedAt,
            knowledgeInputEpochId: epochId,
          },
        } as never,
        operation: operation as never,
        contentPlan: missingPlanMedia,
      }),
    ).rejects.toMatchObject({
      code: "ESA_PRODUCTION_REVISION_MEDIA_INVALID",
    });
  });

  it("binds every 2.9 production contract to the frozen content-plan SHA", () => {
    const contentPlanSha256 = "f".repeat(64);
    const build = {
      id: "13000000-0000-4000-8000-000000000013",
      projectId: operation.projectId,
      workflowVersion: SITEOPS_MATERIALIZER_V2_9.frontMindVersion,
      sourceHash: "e".repeat(64),
      contentPlanSha256,
    };
    const contract = {
      contractKind: "twenty_first_native_build_contract",
      renderer: "twenty_first_native_react_v1",
      buildId: build.id,
      projectId: build.projectId,
      mode: "production",
      canonicalOrigin: "https://example.com",
      target: "global_excluding_cn",
      sourceSha256: build.sourceHash,
      contentPlanSha256,
    };
    const verify = (
      contractValue: Record<string, unknown>,
      frozenBuild = build,
    ) =>
      productionContractMatchesFrozenBuild({
        contractValue,
        build: frozenBuild,
        canonicalOrigin: "https://example.com",
        target: "global_excluding_cn",
      });

    expect(verify(contract)).toBe(true);
    expect(verify({ ...contract, contentPlanSha256: "0".repeat(64) })).toBe(
      false,
    );
    const { contentPlanSha256: _missing, ...missingPlanContract } = contract;
    expect(verify(missingPlanContract)).toBe(false);
    expect(verify(contract, { ...build, contentPlanSha256: null })).toBe(false);
    expect(
      verify(missingPlanContract, {
        ...build,
        workflowVersion: SITEOPS_MATERIALIZER_V2_7.frontMindVersion,
        contentPlanSha256: null,
      }),
    ).toBe(true);
  });

  it("recreates a deleted Routine, deploys the frozen version, and restores the exact relation", async () => {
    enableEsaTestRuntime();
    const distHash = "c".repeat(64);
    const sourceHash = "d".repeat(64);
    const sourceLocalAssetId = "40000000-0000-4000-8000-000000000004";
    const distLocalAssetId = "50000000-0000-4000-8000-000000000005";
    const deployment = {
      id: "30000000-0000-4000-8000-000000000003",
      userId: 7,
      projectId: operation.projectId,
      operationId: operation.id,
      buildId: "60000000-0000-4000-8000-000000000006",
      distLocalAssetId,
      distHash,
      target: "global_excluding_cn",
      intent: "deploy",
      verification: {
        productionMaterialization: {
          schemaVersion: 1,
          canonicalOrigin: "https://example.com",
          target: "global_excluding_cn",
          sourceLocalAssetId,
          sourceSha256: sourceHash,
          contractLocalAssetId: "70000000-0000-4000-8000-000000000007",
          contractSha256: "e".repeat(64),
          productionSourceLocalAssetId: "80000000-0000-4000-8000-000000000008",
          productionSourceSha256: "f".repeat(64),
          distLocalAssetId,
          distSha256: distHash,
          qaLocalAssetId: "90000000-0000-4000-8000-000000000009",
          qaSha256: "1".repeat(64),
          provenanceLocalAssetId: "a0000000-0000-4000-8000-00000000000a",
          provenanceSha256: "2".repeat(64),
          qaPolicyVersion: "siteops-qa-v1",
          materializedAt: "2026-08-22T00:00:00.000Z",
        },
      },
    };
    const project = {
      id: operation.projectId,
      userId: 7,
      canonicalHostname: "example.com",
    };
    const build = {
      id: deployment.buildId,
      projectId: operation.projectId,
      userId: 7,
      sourceLocalAssetId,
      sourceHash,
    };
    const emptyRoutine = {
      name: "frontmind-20000000000040008000000000000002",
      hasAssets: true,
      defaultRelatedRecord: null,
      production: null,
    };
    const liveRoutine = {
      ...emptyRoutine,
      production: {
        deploymentId: "esa-deployment-9",
        codeVersions: [{ codeVersion: "version-9", percentage: 100 }],
      },
    };
    const getRoutine = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(emptyRoutine)
      .mockResolvedValueOnce(emptyRoutine)
      .mockResolvedValue(liveRoutine);
    const createProductionDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "esa-deployment-9" });
    const materializeProduction = vi.fn();
    const updateSiteCoverage = vi.fn();
    const matchedSite = {
      siteId: 99,
      siteName: "example.com",
      status: "active",
      accessType: "CNAME",
      coverage: "global",
      verifyCode: null,
      cnameZone: "example.com.cname-zone.test",
    };
    const api = {
      getRoutine,
      createRoutine: vi.fn().mockResolvedValue(undefined),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn().mockResolvedValue({
        codeVersion: "version-9",
        status: "Available",
        description: null,
        extraInfo: null,
        hasAssets: true,
      }),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment,
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage,
      verifySite: vi.fn(),
      getMatchSite: vi
        .fn()
        .mockResolvedValueOnce(matchedSite)
        .mockResolvedValue({ ...matchedSite, coverage: "overseas" }),
      listRelatedRecords: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { recordId: 199, recordName: "example.com", siteId: 99 },
        ]),
      createRelatedRecord: vi.fn().mockResolvedValue(undefined),
      deleteRelatedRecord: vi.fn(),
      deleteRoutine: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const joinedQuery: any = {
      innerJoin: vi.fn(),
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([{ deployment, project, build }]),
      })),
    };
    joinedQuery.innerJoin.mockReturnValue(joinedQuery);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => joinedQuery),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
    };
    const html = `${" ".repeat(120)}<link href="https://example.com/" rel="canonical">`;
    const publicHttpsFetch = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            schemaVersion: 2,
            deploymentId: deployment.id,
            distSha256: distHash,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        finalUrl: new URL(`https://example.com/frontmind-deployment.json`),
      })
      .mockResolvedValueOnce({
        response: new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        finalUrl: new URL("https://example.com/"),
      });
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      materializeProduction,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        attempt: 3,
        result: { stage: "version_processing", codeVersion: "version-9" },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      providerOperationId: "esa-deployment-9",
      result: { distHash, codeVersion: "version-9" },
    });
    expect(api.createRoutine).toHaveBeenCalledTimes(1);
    expect(createProductionDeployment).toHaveBeenCalledWith({
      name: "frontmind-20000000000040008000000000000002",
      codeVersion: "version-9",
    });
    expect(api.createRelatedRecord).toHaveBeenCalledWith({
      name: "frontmind-20000000000040008000000000000002",
      recordName: "example.com",
      siteId: 99,
    });
    expect(updateSiteCoverage).toHaveBeenCalledWith({
      siteId: 99,
      coverage: "overseas",
    });
    expect(materializeProduction).not.toHaveBeenCalled();
    expect(publicHttpsFetch).toHaveBeenCalledTimes(2);
    expect(publicHttpsFetch.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        url: "https://example.com/frontmind-deployment.json",
        allowedOrigin: "https://example.com",
        maxRedirects: 2,
      }),
      expect.objectContaining({
        url: "https://example.com/",
        allowedOrigin: "https://example.com",
        maxRedirects: 2,
      }),
    ]);
    expect(updateWhere).toHaveBeenCalled();
  });
});
