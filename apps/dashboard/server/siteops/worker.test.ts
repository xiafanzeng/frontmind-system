import { describe, expect, it } from "vitest";

import {
  appendBuildTimelineEvent,
  enqueueAutomaticDomainSuccessor,
  exclusiveSiteOpsLiveHeadProjection,
  knownSiteOpsBuildFailure,
  parseSiteOpsBuildArtifactBindings,
  siteOpsBuildArtifactProjection,
  siteOpsInitialVisualSupersededMayStaySilent,
  siteOpsExternalOperationPredatesResetEpoch,
  siteOpsDeterministicSuccessorId,
  siteOpsSupplementalVisualFailureMayRecover,
  siteOpsVisualOperationCoordinates,
  siteOpsWorkerMayClaimStatus,
  siteOpsWorkerExecutionPolicy,
  terminalSiteOpsOperationProjection,
  unexpectedSiteOpsProviderFailure,
} from "./worker";

describe("SiteOps mutually exclusive live heads", () => {
  it.each([
    [
      "global_excluding_cn",
      {
        globalLiveDeploymentId: "10000000-0000-4000-8000-000000000001",
        mainlandLiveDeploymentId: null,
      },
    ],
    [
      "mainland_cn",
      {
        globalLiveDeploymentId: null,
        mainlandLiveDeploymentId: "10000000-0000-4000-8000-000000000001",
      },
    ],
  ] as const)("activates only the %s mode", (target, expected) => {
    expect(
      exclusiveSiteOpsLiveHeadProjection(
        target,
        "10000000-0000-4000-8000-000000000001",
      ),
    ).toEqual(expected);
  });
});

describe("SiteOps worker claim boundary", () => {
  it("fences an old Aliyun result from a fresh local reset epoch but keeps the cleanup operation eligible", () => {
    const currentTaskStartedAt = new Date("2026-08-28T01:00:00.000Z");
    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation: {
          kind: "deploy",
          provider: "aliyun_esa",
          input: { buildId: "old-build" },
          createdAt: new Date("2026-08-28T00:59:00.000Z"),
        } as never,
        currentTaskStartedAt,
      }),
    ).toBe(true);
    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation: {
          kind: "site_build",
          provider: "manus",
          input: {},
          createdAt: new Date("2026-08-28T00:59:00.000Z"),
        } as never,
        currentTaskStartedAt,
      }),
    ).toBe(false);
    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation: {
          kind: "rollback",
          provider: "aliyun_esa",
          input: {
            schemaVersion: 1,
            intent: "approved_reset_unpublish",
            rebuildTicketId: "10000000-0000-4000-8000-000000000001",
            expectedProjectRevision: 4,
            expectedCurrentBuildId: null,
            expectedKnowledgeSnapshotId: null,
            expectedGlobalLiveDeploymentId: null,
            expectedMainlandLiveDeploymentId: null,
            expectedCanonicalHostname: null,
          },
          createdAt: new Date("2026-08-28T00:59:00.000Z"),
        } as never,
        currentTaskStartedAt,
      }),
    ).toBe(false);
  });

  it("uses the frozen operation id and reset revision to fence an old Aliyun write created in the reset second", () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const operationId = "30000000-0000-4000-8000-000000000003";
    const otherOperationId = "40000000-0000-4000-8000-000000000004";
    const currentTaskStartedAt = new Date("2026-08-28T01:00:00.000Z");
    const pendingResetNote = JSON.stringify({
      schemaVersion: 5,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: null,
      knowledgeSnapshotId: null,
      resetIntent: "approved_reset_unpublish",
      resetApprovedAt: "2026-08-28T01:00:00.987Z",
      minimumKnowledgeSnapshotVersion: 1,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: [operationId],
      resetEpochDecoupled: true,
      resetAppliedAt: "2026-08-28T01:00:00.987Z",
      resetAppliedProjectRevision: 13,
      freshRootApplied: true,
      frozenReset: {
        schemaVersion: 1,
        intent: "approved_reset_unpublish",
        rebuildTicketId: "50000000-0000-4000-8000-000000000005",
        expectedProjectRevision: 12,
        expectedCurrentBuildId: null,
        expectedKnowledgeSnapshotId: null,
        expectedGlobalLiveDeploymentId: null,
        expectedMainlandLiveDeploymentId: null,
        expectedCanonicalHostname: null,
        resetAppliedProjectRevision: 13,
        resetEpochStartedAt: "2026-08-28T01:00:00.987Z",
      },
    });
    const operation = {
      id: operationId,
      projectId,
      kind: "deploy",
      provider: "aliyun_esa",
      input: { buildId: "old-build" },
      createdAt: currentTaskStartedAt,
    } as const;

    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation,
        currentTaskStartedAt,
        projectRevision: 13,
        pendingResetNotes: [pendingResetNote],
      }),
    ).toBe(true);
    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation: { ...operation, id: otherOperationId },
        currentTaskStartedAt,
        projectRevision: 13,
        pendingResetNotes: [pendingResetNote],
      }),
    ).toBe(false);
    expect(
      siteOpsExternalOperationPredatesResetEpoch({
        operation,
        currentTaskStartedAt,
        projectRevision: 12,
        pendingResetNotes: [pendingResetNote],
      }),
    ).toBe(false);
  });

  it("creates the automatic domain chain with deterministic replay-safe successors", async () => {
    const parent = (overrides: Record<string, unknown>) =>
      ({
        id: "10000000-0000-4000-8000-000000000001",
        projectId: "20000000-0000-4000-8000-000000000002",
        userId: 7,
        conversationTurnId: null,
        input: {},
        ...overrides,
      }) as never;
    const capture = async (
      operation: never,
      result: Record<string, unknown>,
      replay = false,
    ) => {
      const inserted: Array<Record<string, unknown>> = [];
      const tx = {
        select: () => {
          const query: any = {
            from: () => query,
            where: () => query,
            limit: () => Promise.resolve(inserted.slice(0, 1)),
          };
          return query;
        },
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            inserted.push(value);
          },
        }),
      };
      await enqueueAutomaticDomainSuccessor(
        tx,
        operation,
        { status: "succeeded", result } as never,
        new Date("2026-08-26T00:00:00.000Z"),
      );
      if (replay) {
        await enqueueAutomaticDomainSuccessor(
          tx,
          operation,
          { status: "succeeded", result } as never,
          new Date("2026-08-26T00:01:00.000Z"),
        );
      }
      return inserted;
    };
    const connectionId = "30000000-0000-4000-8000-000000000003";
    const domainSync = parent({
      kind: "domain_sync",
      provider: "aliyun_alidns",
      input: { connectionId, domainIntent: "sync", domain: "example.com" },
    });
    const first = await capture(
      domainSync,
      { domain: "example.com", domainRevision: 4 },
      true,
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "dns_apply",
      provider: "aliyun_esa",
      input: {
        prepareDomainBinding: true,
        domain: "example.com",
        domainRevision: 4,
        connectionId,
      },
    });
    expect(first[0].id).toBe(
      siteOpsDeterministicSuccessorId(
        "10000000-0000-4000-8000-000000000001",
        "domain-sync:esa-prepare",
      ),
    );

    const esa = parent({
      id: "11000000-0000-4000-8000-000000000001",
      kind: "dns_apply",
      provider: "aliyun_esa",
      input: { connectionId, domainRevision: 4 },
    });
    const plan = await capture(esa, {
      phase: "esa_site_verification_dns_ready",
      domain: "example.com",
      domainRevision: 4,
    });
    expect(plan[0]).toMatchObject({
      kind: "dns_apply",
      provider: "aliyun_alidns",
      input: { connectionId, domainRevision: 4, dnsIntent: "plan" },
    });

    const planOperation = parent({
      id: "12000000-0000-4000-8000-000000000001",
      kind: "dns_apply",
      provider: "aliyun_alidns",
      input: { connectionId, domainRevision: 4, dnsIntent: "plan" },
    });
    const apply = await capture(planOperation, {
      domain: "example.com",
      revision: 4,
      canApply: true,
      planHash: "a".repeat(64),
      providerSnapshotHash: "b".repeat(64),
    });
    expect(apply[0]).toMatchObject({
      kind: "dns_apply",
      provider: "aliyun_alidns",
      input: {
        connectionId,
        domainRevision: 4,
        dnsIntent: "apply",
        planOperationId: "12000000-0000-4000-8000-000000000001",
        planHash: "a".repeat(64),
        providerSnapshotHash: "b".repeat(64),
      },
    });
  });

  it("records each build timeline stage at most once", async () => {
    const inserted: Array<Record<string, any>> = [];
    const tx = {
      select(selection: Record<string, unknown>) {
        const keys = Object.keys(selection);
        const rows = keys.includes("conversationId")
          ? [{ conversationId: "siteops:7", revision: 4 }]
          : keys.includes("metadata")
            ? inserted.map((row) => ({ metadata: row.metadata }))
            : [{ sequence: inserted.length }];
        const query: any = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return query;
      },
      insert: () => ({
        values: async (value: Record<string, any>) => {
          inserted.push(value);
        },
      }),
    };
    const operation = {
      id: "operation-build",
      projectId: "project-1",
      userId: 7,
      buildId: "build-1",
    } as never;
    const now = new Date("2026-08-22T00:01:00.000Z");

    await appendBuildTimelineEvent(tx, {
      operation,
      buildStatus: "design_compiling",
      now,
    });
    await appendBuildTimelineEvent(tx, {
      operation,
      buildStatus: "design_compiling",
      now: new Date("2026-08-22T00:02:00.000Z"),
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      content: "设计合同生成",
      sequence: 1,
      metadata: {
        siteOps: {
          subjectId: "operation-build",
          payload: {
            visibility: "timeline",
            timelineOnly: true,
            stage: "design_compiling",
            buildId: "build-1",
            occurredAt: "2026-08-22T00:01:00.000Z",
          },
        },
      },
    });
  });

  it("verifies all five tenant-owned artifact coordinates before atomic build binding", () => {
    const ids = {
      contract: "10000000-0000-4000-8000-000000000001",
      source: "10000000-0000-4000-8000-000000000002",
      dist: "10000000-0000-4000-8000-000000000003",
      qa: "10000000-0000-4000-8000-000000000004",
      provenance: "10000000-0000-4000-8000-000000000005",
    } as const;
    const mimeTypes = {
      contract: "application/json",
      source: "application/zip",
      dist: "application/zip",
      qa: "application/zip",
      provenance: "application/json",
    } as const;
    const raw = Object.fromEntries(
      Object.entries(ids).map(([kind, id], index) => [
        kind,
        {
          id,
          sha256: String(index + 1).repeat(64),
          bytes: index + 10,
          mimeType: mimeTypes[kind as keyof typeof mimeTypes],
        },
      ]),
    );
    const bindings = parseSiteOpsBuildArtifactBindings(raw);
    const rows = Object.entries(bindings).map(([, binding]) => ({
      id: binding.id,
      scope: "managed_user",
      accountUserId: 7,
      presalesProjectId: null,
      mimeType: binding.mimeType,
      sizeBytes: binding.bytes,
      contentSha256: binding.sha256,
      storageKey: "",
    }));
    const projectId = "20000000-0000-4000-8000-000000000001";
    const storageKinds = {
      contract: "site-contract",
      source: "site-source",
      dist: "site-dist",
      qa: "site-qa",
      provenance: "site-provenance",
    } as const;
    for (const [kind, binding] of Object.entries(bindings)) {
      rows.find((row) => row.id === binding.id)!.storageKey =
        `siteops:${projectId}:${storageKinds[kind as keyof typeof storageKinds]}:${binding.id}`;
    }
    expect(
      siteOpsBuildArtifactProjection({
        bindings,
        rows,
        userId: 7,
        projectId,
      }),
    ).toEqual({
      contractLocalAssetId: ids.contract,
      contractHash: "1".repeat(64),
      sourceLocalAssetId: ids.source,
      sourceHash: "2".repeat(64),
      distLocalAssetId: ids.dist,
      distHash: "3".repeat(64),
      qaLocalAssetId: ids.qa,
      provenanceLocalAssetId: ids.provenance,
    });
    expect(() =>
      siteOpsBuildArtifactProjection({
        bindings,
        rows: rows.map((row, index) =>
          index === 2 ? { ...row, accountUserId: 8 } : row,
        ),
        userId: 7,
        projectId,
      }),
    ).toThrow("SITEOPS_BUILD_ARTIFACT_VERIFICATION_FAILED");
  });

  it("rejects missing, duplicate, extra, or wrong-MIME build artifact bindings", () => {
    const binding = (id: string, mimeType: string) => ({
      id,
      sha256: "a".repeat(64),
      bytes: 10,
      mimeType,
    });
    const valid = {
      contract: binding(
        "10000000-0000-4000-8000-000000000001",
        "application/json",
      ),
      source: binding(
        "10000000-0000-4000-8000-000000000002",
        "application/zip",
      ),
      dist: binding("10000000-0000-4000-8000-000000000003", "application/zip"),
      qa: binding("10000000-0000-4000-8000-000000000004", "application/zip"),
      provenance: binding(
        "10000000-0000-4000-8000-000000000005",
        "application/json",
      ),
    };
    expect(() =>
      parseSiteOpsBuildArtifactBindings({ ...valid, qa: undefined }),
    ).toThrow("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    expect(() =>
      parseSiteOpsBuildArtifactBindings({
        ...valid,
        qa: { ...valid.qa, id: valid.dist.id },
      }),
    ).toThrow("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    expect(() =>
      parseSiteOpsBuildArtifactBindings({ ...valid, extra: valid.contract }),
    ).toThrow("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    expect(() =>
      parseSiteOpsBuildArtifactBindings({
        ...valid,
        contract: { ...valid.contract, mimeType: "application/zip" },
      }),
    ).toThrow("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
  });

  it("gives Astro build and QA operations a lease longer than their handler timeout", () => {
    expect(siteOpsWorkerExecutionPolicy("site_build")).toEqual({
      timeoutMs: 10 * 60_000,
      leaseMs: 12 * 60_000,
    });
    expect(siteOpsWorkerExecutionPolicy("build_revision")).toEqual({
      timeoutMs: 10 * 60_000,
      leaseMs: 12 * 60_000,
    });
    expect(siteOpsWorkerExecutionPolicy("visual_search")).toEqual({
      timeoutMs: 12 * 60_000,
      leaseMs: 15 * 60_000,
    });
  });

  it("preserves an already-bound provider task and safe progress at terminal finalize", () => {
    expect(
      terminalSiteOpsOperationProjection(
        {
          providerOperationId: "provider-operation",
          providerTaskId: "provider-task",
          result: { stage: "repair_pending", repairAttempt: 3 },
        } as never,
        {
          status: "failed",
          code: "FRONTMIND_BUILD_OUTPUT_INVALID",
          message: "FrontMind AI 建站输出无效。",
        },
      ),
    ).toEqual({
      providerOperationId: "provider-operation",
      providerTaskId: "provider-task",
      result: { stage: "repair_pending", repairAttempt: 3 },
    });
  });

  it("never reclaims a visual operation atomically cancelled by reset", () => {
    expect(siteOpsWorkerMayClaimStatus("queued")).toBe(true);
    expect(siteOpsWorkerMayClaimStatus("running")).toBe(true);
    expect(siteOpsWorkerMayClaimStatus("cancelled")).toBe(false);
    expect(siteOpsWorkerMayClaimStatus("failed")).toBe(false);
  });

  it("reads V2 visual coordinates and infers historical supplemental operations", () => {
    expect(
      siteOpsVisualOperationCoordinates({
        operationInput: {
          schemaVersion: 2,
          knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
          credentialId: "20000000-0000-4000-8000-000000000002",
          credentialVersion: 3,
          workflowVersion: "1.2.0",
          mode: "supplemental",
          page: 2,
          admissionRevision: 9,
        },
        completePublishedPages: 1,
      }),
    ).toEqual({ mode: "supplemental", page: 2, admissionRevision: 9 });
    expect(
      siteOpsVisualOperationCoordinates({
        operationInput: {
          knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
          credentialId: "20000000-0000-4000-8000-000000000002",
          credentialVersion: 3,
          workflowVersion: "1.2.0",
        },
        completePublishedPages: 1,
      }),
    ).toEqual({ mode: "supplemental", page: 2, admissionRevision: null });
  });

  it("recovers only a current supplemental failure with a complete existing board", () => {
    const recoverable = {
      mode: "supplemental" as const,
      completePublishedPages: 1,
      projectStatus: "awaiting_visual_selection",
      projectRevision: 9,
      admissionRevision: 9,
      hasActiveVisualOperation: false,
      hasActiveBuild: false,
      errorCode: "INSUFFICIENT_DISTINCT_21ST_HERO_REFERENCES",
    };
    expect(siteOpsSupplementalVisualFailureMayRecover(recoverable)).toBe(true);
    expect(
      siteOpsSupplementalVisualFailureMayRecover({
        ...recoverable,
        errorCode: "VISUAL_MATCHING_BUDGET_EXHAUSTED",
      }),
    ).toBe(true);
    expect(
      siteOpsSupplementalVisualFailureMayRecover({
        ...recoverable,
        errorCode: "VISUAL_PREVIEW_REFERENCES_UNAVAILABLE",
      }),
    ).toBe(true);
    expect(
      siteOpsSupplementalVisualFailureMayRecover({
        ...recoverable,
        projectRevision: 10,
      }),
    ).toBe(false);
    expect(
      siteOpsSupplementalVisualFailureMayRecover({
        ...recoverable,
        errorCode: "VISUAL_SEARCH_SUPERSEDED",
      }),
    ).toBe(false);
    expect(
      siteOpsSupplementalVisualFailureMayRecover({
        ...recoverable,
        mode: "initial",
      }),
    ).toBe(false);
  });

  it("keeps an initial superseded failure silent only after the project advanced", () => {
    const admitted = {
      mode: "initial" as const,
      projectStatus: "visual_searching",
      projectRevision: 9,
      admissionRevision: 9,
    };
    expect(siteOpsInitialVisualSupersededMayStaySilent(admitted)).toBe(false);
    expect(
      siteOpsInitialVisualSupersededMayStaySilent({
        ...admitted,
        projectRevision: 10,
      }),
    ).toBe(true);
    expect(
      siteOpsInitialVisualSupersededMayStaySilent({
        ...admitted,
        projectStatus: "collecting_brief",
      }),
    ).toBe(true);
    expect(
      siteOpsInitialVisualSupersededMayStaySilent({
        ...admitted,
        mode: "supplemental",
      }),
    ).toBe(false);
  });

  it("never persists or reflects an unexpected provider exception", () => {
    const secret = "21st_sk_must-never-reach-a-customer";
    const result = unexpectedSiteOpsProviderFailure();

    expect(result).toMatchObject({
      status: "attention_required",
      code: "PROVIDER_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message).not.toContain("error.message");
  });

  it("retains a stable known build failure instead of relabeling it as unknown provider work", () => {
    const error = Object.assign(
      new Error("同一 FrontMind AI 建站任务修复后仍未通过结构校验。"),
      { code: "FRONTMIND_BUILD_OUTPUT_INVALID", status: "failed" },
    );
    expect(knownSiteOpsBuildFailure(error)).toEqual({
      status: "failed",
      code: "FRONTMIND_BUILD_OUTPUT_INVALID",
      message: "同一 FrontMind AI 建站任务修复后仍未通过结构校验。",
    });
    expect(
      knownSiteOpsBuildFailure(
        Object.assign(new Error("配置不可用"), {
          code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
        }),
      ),
    ).toMatchObject({ status: "attention_required" });
  });
});
