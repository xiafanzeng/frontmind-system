import { describe, expect, it } from "vitest";

import {
  deliveryTicketEvents,
  deliveryTickets,
  messages,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteOperations,
  siteProjects,
  socialPackages,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  workspaceSiteProfiles,
} from "../../drizzle/schema";
import {
  activateDeferredApprovedSiteOpsReset,
  approvedResetUnpublishFreshEpochMatches,
  approveSiteOpsRebuildTicket,
  finalizeApprovedSiteOpsReset,
  loadSiteOpsRebuildRequest,
  parseApprovedResetUnpublishInput,
  projectSiteOpsRebuildReset,
  siteOpsRebuildBuildId,
  siteOpsRebuildAcceptedForCurrentCycle,
  siteOpsRebuildDeliveryClientRequestId,
  siteOpsRebuildDedupeKey,
  siteOpsRebuildProjectDedupeKey,
  siteOpsRebuildProjectId,
  siteOpsRebuildProjectTargetPage,
  siteOpsRebuildRequestDisposition,
  siteOpsRebuildResubmissionProjection,
  siteOpsRebuildResetApplied,
  siteOpsRebuildResetOperationId,
  siteOpsRebuildResetPending,
  siteOpsRebuildTargetPage,
} from "./rebuild-ticket";

describe("SiteOps rebuild reset public projection", () => {
  const ticketId = "10000000-0000-4000-8000-000000000001";
  const operationId = "20000000-0000-4000-8000-000000000002";
  const projectId = "30000000-0000-4000-8000-000000000003";
  const resetInput = {
    schemaVersion: 1 as const,
    intent: "approved_reset_unpublish" as const,
    rebuildTicketId: ticketId,
    expectedProjectRevision: 7,
    expectedCurrentBuildId: null,
    expectedKnowledgeSnapshotId: null,
    expectedGlobalLiveDeploymentId: null,
    expectedMainlandLiveDeploymentId: null,
    expectedCanonicalHostname: null,
  };
  const pendingNote = JSON.stringify({
    schemaVersion: 4,
    kind: "frontmind.siteops-rebuild.v1",
    projectId,
    sourceBuildId: null,
    knowledgeSnapshotId: null,
    resetIntent: "approved_reset_unpublish",
    resetOperationId: operationId,
    resetApprovedAt: "2026-08-26T01:00:00.000Z",
    resetExpectedProjectRevision: 7,
    minimumKnowledgeSnapshotVersion: 1,
  });
  const operation = (
    status:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "outcome_unknown"
      | "attention_required"
      | "cancelled",
    errorCode: string | null = null,
  ) => ({
    id: operationId,
    projectId,
    userId: 42,
    kind: "rollback" as const,
    provider: "aliyun_esa",
    status,
    input: resetInput,
    result:
      status === "succeeded"
        ? {
            schemaVersion: 2,
            intent: "approved_reset_unpublish",
            stage: "exposure_removed",
            resetOperationId: operationId,
            projectId,
            freshRootApplied: true,
            minimumKnowledgeSnapshotVersion: 1,
            resetAppliedProjectRevision: 8,
          }
        : null,
    errorCode,
    attempt: 1,
    providerOperationId:
      status === "outcome_unknown" ? "esa-operation-1" : null,
    providerTaskId: null,
  });

  it("projects active and blocked operation states without exposing raw errors", () => {
    expect(siteOpsRebuildResetOperationId(pendingNote)).toBe(operationId);
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: operation("queued"),
      }),
    ).toEqual({
      siteRebuildResetState: "queued",
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
    });
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: operation("outcome_unknown", "provider-secret-code"),
      }),
    ).toEqual({
      siteRebuildResetState: "blocked",
      siteRebuildResetIssue: "external_outcome_unknown",
      siteRebuildCanRecheck: true,
    });
    expect(
      JSON.stringify(
        projectSiteOpsRebuildReset({
          ticketId,
          userId: 42,
          internalNote: pendingNote,
          operation: operation("failed", "provider-secret-code"),
        }),
      ),
    ).not.toContain("provider-secret-code");
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: operation("failed", "provider-secret-code"),
      }),
    ).toEqual({
      siteRebuildResetState: "blocked",
      siteRebuildResetIssue: "external_outcome_unknown",
      siteRebuildCanRecheck: false,
    });
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: operation("attention_required", "ESA_RUNTIME_DISABLED"),
      }),
    ).toEqual({
      siteRebuildResetState: "blocked",
      siteRebuildResetIssue: "esa_runtime_required",
      siteRebuildCanRecheck: true,
    });
  });

  it("recognizes the exact completed V4 operation and rejects invalidated coordinates", () => {
    const completedNote = JSON.stringify({
      ...JSON.parse(pendingNote),
      resetAppliedAt: "2026-08-26T01:05:00.000Z",
      resetAppliedProjectRevision: 8,
      freshRootApplied: true,
      unpublishOperationId: operationId,
    });
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: completedNote,
        operation: operation("succeeded"),
      }),
    ).toEqual({
      siteRebuildResetState: "completed",
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
    });
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: operation("failed", "SITEOPS_RESET_INVALIDATED"),
      }),
    ).toEqual({
      siteRebuildResetState: "invalidated",
      siteRebuildResetIssue: "project_coordinates_changed",
      siteRebuildCanRecheck: false,
    });
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: pendingNote,
        operation: {
          ...operation("queued"),
          projectId: "40000000-0000-4000-8000-000000000004",
        },
      }),
    ).toEqual({
      siteRebuildResetState: "invalidated",
      siteRebuildResetIssue: "project_coordinates_changed",
      siteRebuildCanRecheck: false,
    });
  });

  it("keeps historical notes outside V4 compatible", () => {
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: null,
        operation: null,
      }),
    ).toEqual({
      siteRebuildResetState: null,
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
    });
  });

  it("projects a deferred approved Aliyun boundary as queued without a reset operation", () => {
    const deferredNote = JSON.stringify({
      schemaVersion: 5,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: null,
      knowledgeSnapshotId: null,
      resetIntent: "approved_reset_unpublish",
      resetApprovedAt: "2026-08-26T01:00:00.000Z",
      minimumKnowledgeSnapshotVersion: 1,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: ["90000000-0000-4000-8000-000000000009"],
    });
    expect(siteOpsRebuildResetPending(deferredNote)).toBe(true);
    expect(siteOpsRebuildResetOperationId(deferredNote)).toBeNull();
    expect(
      projectSiteOpsRebuildReset({
        ticketId,
        userId: 42,
        internalNote: deferredNote,
        operation: null,
      }),
    ).toEqual({
      siteRebuildResetState: "queued",
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
    });
  });
});

describe("SiteOps rebuild ticket coordinates", () => {
  const immutableBuildId = "10000000-0000-4000-8000-000000000001";

  it("binds the ticket to one exact immutable source build", () => {
    expect(siteOpsRebuildDedupeKey(immutableBuildId)).toBe(
      `site-rebuild:${immutableBuildId}`,
    );
    expect(
      siteOpsRebuildBuildId(siteOpsRebuildTargetPage(immutableBuildId)),
    ).toBe(immutableBuildId);
  });

  it("rejects arbitrary pages and malformed build ids", () => {
    expect(siteOpsRebuildBuildId("https://example.com/siteops/builds/x")).toBe(
      null,
    );
    expect(siteOpsRebuildBuildId("/siteops/builds/not-a-uuid")).toBe(null);
  });

  it("binds an any-stage reset request to the project before a build exists", () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    expect(siteOpsRebuildProjectDedupeKey(projectId)).toBe(
      `site-rebuild-project:${projectId}`,
    );
    expect(
      siteOpsRebuildProjectId(siteOpsRebuildProjectTargetPage(projectId)),
    ).toBe(projectId);
    expect(siteOpsRebuildProjectId("/siteops/projects/not-a-uuid")).toBeNull();
  });

  it.each([
    [true, null, false, "create"],
    [true, "submitted", false, "pending"],
    [true, "in_progress", true, "resubmit"],
    [false, null, false, "unavailable"],
  ] as const)(
    "projects requestability without interrupting the workflow (%s, %s, %s)",
    (hasWorkflowProgress, ticketStatus, resetApplied, expected) => {
      expect(
        siteOpsRebuildRequestDisposition({
          hasWorkflowProgress,
          ticketStatus,
          resetApplied,
        }),
      ).toBe(expected);
    },
  );

  it("keeps a prior reset authorization valid only until its replacement becomes current", () => {
    const sourceBuildId = "30000000-0000-4000-8000-000000000003";
    const internalNote = JSON.stringify({
      schemaVersion: 3,
      kind: "frontmind.siteops-rebuild.v1",
      projectId: "20000000-0000-4000-8000-000000000002",
      sourceBuildId,
      knowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
      resetAppliedAt: "2026-08-24T08:00:00.000Z",
      resetAppliedProjectRevision: 12,
    });

    expect(
      siteOpsRebuildAcceptedForCurrentCycle({
        internalNote,
        currentBuildId: sourceBuildId,
      }),
    ).toBe(true);
    expect(
      siteOpsRebuildAcceptedForCurrentCycle({
        internalNote,
        currentBuildId: "50000000-0000-4000-8000-000000000005",
      }),
    ).toBe(false);
  });

  it("does not revive a completed reset from a legacy project snapshot floor", async () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const rows = [[], [{ minimumKnowledgeSnapshotVersion: 11 }]];
    let selectCall = 0;
    const executor = {
      select: () => {
        const result = rows[selectCall++] ?? [];
        const query: any = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject),
        };
        return query;
      },
    };

    await expect(
      loadSiteOpsRebuildRequest(executor, {
        userId: 7,
        projectId,
        currentBuildId: null,
        hasWorkflowProgress: true,
      }),
    ).resolves.toEqual({
      allowed: true,
      ticketId: null,
      status: null,
      resetApplied: false,
      resetPending: false,
      minimumKnowledgeSnapshotVersion: null,
      resetSourceBuildId: null,
      acceptedForCurrentCycle: false,
    });
    expect(selectCall).toBe(1);
  });

  it("keeps active reset state without projecting a legacy snapshot floor", async () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const currentBuildId = "70000000-0000-4000-8000-000000000007";
    const activeNote = JSON.stringify({
      schemaVersion: 3,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: currentBuildId,
      knowledgeSnapshotId: "80000000-0000-4000-8000-000000000008",
      resetAppliedAt: "2026-08-24T08:00:00.000Z",
      resetAppliedProjectRevision: 12,
    });
    const rows = [
      [{ id: currentBuildId }],
      [
        {
          id: "90000000-0000-4000-8000-000000000009",
          status: "submitted",
          internalNote: activeNote,
        },
      ],
      [{ minimumKnowledgeSnapshotVersion: 9 }],
    ];
    let selectCall = 0;
    const executor = {
      select: () => {
        const result = rows[selectCall++] ?? [];
        const query: any = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject),
        };
        return query;
      },
    };

    await expect(
      loadSiteOpsRebuildRequest(executor, {
        userId: 7,
        projectId,
        currentBuildId,
        hasWorkflowProgress: true,
      }),
    ).resolves.toEqual({
      allowed: false,
      ticketId: "90000000-0000-4000-8000-000000000009",
      status: "submitted",
      resetApplied: true,
      resetPending: false,
      minimumKnowledgeSnapshotVersion: null,
      resetSourceBuildId: currentBuildId,
      acceptedForCurrentCycle: true,
    });
    expect(selectCall).toBe(2);
  });

  it("does not reconstruct a missing project floor from retained operations", async () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const rows = [
      [],
      [{ minimumKnowledgeSnapshotVersion: null }],
      [
        {
          id: "50000000-0000-4000-8000-000000000005",
          result: {
            minimumKnowledgeSnapshotVersion: 14,
          },
        },
      ],
    ];
    let selectCall = 0;
    const executor = {
      select: () => {
        const result = rows[selectCall++] ?? [];
        const query: any = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(result).then(resolve, reject),
        };
        return query;
      },
    };

    await expect(
      loadSiteOpsRebuildRequest(executor, {
        userId: 7,
        projectId,
        currentBuildId: null,
        hasWorkflowProgress: true,
      }),
    ).resolves.toEqual({
      allowed: true,
      ticketId: null,
      status: null,
      resetApplied: false,
      resetPending: false,
      minimumKnowledgeSnapshotVersion: null,
      resetSourceBuildId: null,
      acceptedForCurrentCycle: false,
    });
    expect(selectCall).toBe(1);
  });

  it("upgrades a production-shaped V2 build ticket to a stable project coordinate on resubmission", () => {
    const projectId = "20000000-0000-4000-8000-000000000002";
    const sourceBuildId = "30000000-0000-4000-8000-000000000003";
    const projection = siteOpsRebuildResubmissionProjection({
      projectId,
      internalNote: JSON.stringify({
        schemaVersion: 2,
        kind: "frontmind.siteops-rebuild.v1",
        projectId,
        sourceBuildId,
        knowledgeSnapshotId: "40000000-0000-4000-8000-000000000004",
        resetAppliedAt: "2026-08-24T08:00:00.000Z",
        resetAppliedProjectRevision: 12,
      }),
    });

    expect(projection).toMatchObject({
      targetPage: `/siteops/projects/${projectId}`,
      technicalDedupeKey: `site-rebuild-project:${projectId}`,
    });
    expect(JSON.parse(projection!.internalNote)).toMatchObject({
      schemaVersion: 3,
      projectId,
      sourceBuildId,
      resetAppliedProjectRevision: 12,
    });
  });

  it("maps every accepted SiteOps request id to one deterministic delivery UUID", () => {
    const shared = {
      userId: 27,
      projectId: "20000000-0000-4000-8000-000000000002",
    };
    const prefixedRequestId = "siteops-10000000-0000-4000-8000-000000000001";
    const longRequestId = "request-".padEnd(128, "x");
    const prefixed = siteOpsRebuildDeliveryClientRequestId({
      ...shared,
      clientRequestId: prefixedRequestId,
    });

    expect(prefixedRequestId).toHaveLength(44);
    expect(longRequestId).toHaveLength(128);
    expect(prefixed).toHaveLength(36);
    expect(prefixed).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: prefixedRequestId,
      }),
    ).toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        clientRequestId: longRequestId,
      }),
    ).not.toBe(prefixed);
    expect(
      siteOpsRebuildDeliveryClientRequestId({
        ...shared,
        projectId: "30000000-0000-4000-8000-000000000003",
        clientRequestId: prefixedRequestId,
      }),
    ).not.toBe(prefixed);
  });
});

const projectId = "10000000-0000-4000-8000-000000000001";
const buildId = "20000000-0000-4000-8000-000000000002";
const snapshotId = "30000000-0000-4000-8000-000000000003";
const ticketId = "40000000-0000-4000-8000-000000000004";

function rebuildNoteV1() {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "frontmind.siteops-rebuild.v1",
    projectId,
    sourceBuildId: buildId,
    knowledgeSnapshotId: snapshotId,
  });
}

function fixture(options?: {
  activeOperation?: boolean | Record<string, unknown>;
  activeOperations?: Array<Record<string, unknown>>;
  reconciledOperations?: Array<Record<string, unknown>>;
  activeDeployment?: Record<string, unknown>;
  activeDns?: boolean;
  internalNote?: string;
  projectOverrides?: Record<string, unknown>;
  targetPage?: string;
  ticketStatus?: string;
  resetOperation?: Record<string, unknown>;
  cancelCasFails?: boolean;
}) {
  const initialGlobalLiveDeploymentId = "50000000-0000-4000-8000-000000000005";
  const project = {
    id: projectId,
    userId: 9,
    conversationId: "siteops:9",
    currentKnowledgeSnapshotId: snapshotId,
    currentBuildId: buildId,
    globalLiveDeploymentId: initialGlobalLiveDeploymentId,
    mainlandLiveDeploymentId: null,
    canonicalHostname: null,
    brief: { companyName: "FrontMind" },
    status: "approved",
    revision: 12,
    knowledgeInputEpochId: null as string | null,
    minimumKnowledgeSnapshotVersion: null as number | null,
    currentTaskStartedAt: new Date("2026-08-24T07:00:00.000Z"),
    updatedAt: new Date("2026-08-24T07:00:00.000Z"),
    ...options?.projectOverrides,
  };
  const profile = {
    userId: 9,
    domain: "example.com",
    normalizedAsciiDomain: "example.com",
    unicodeDisplayDomain: "example.com",
    domainRevision: 4,
    providerAccountUid: "aliyun-account-1",
    domainOwnershipStatus: "verified",
    dnsStatus: "active",
    domainStatus: "completed",
    domainVerifiedAt: new Date("2026-08-20T08:00:00.000Z"),
    siteMode: "managed",
    icpDomainRevision: 4,
    icpProvince: "浙",
    icpNumber: "浙ICP备00000000号",
    icpStatus: "approved",
    icpVerifiedAt: new Date("2026-08-21T08:00:00.000Z"),
    revision: 2,
  };
  const build = {
    id: buildId,
    projectId,
    userId: 9,
    knowledgeSnapshotId: snapshotId,
    status: "approved",
    contractLocalAssetId: "contract",
    sourceLocalAssetId: "source",
    distLocalAssetId: "dist",
    qaLocalAssetId: "qa",
    provenanceLocalAssetId: "provenance",
  };
  const ticket = {
    id: ticketId,
    userId: 9,
    operation: "site_rebuild",
    targetPage: options?.targetPage ?? `/siteops/builds/${buildId}`,
    internalNote: options?.internalNote ?? rebuildNoteV1(),
    status: options?.ticketStatus ?? "submitted",
    revision: 5,
    assignedProjectAssignmentId: "60000000-0000-4000-8000-000000000006",
  } as any;
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const deletes: Array<{ table: unknown }> = [];
  const rowsFor = (table: unknown, fields?: Record<string, unknown>) => {
    if (table === siteProjects) return [project];
    if (table === siteBuilds) return [build];
    if (table === deliveryTickets) return [ticket];
    if (table === siteOperations) {
      if (fields && "completedAt" in fields) {
        return options?.reconciledOperations ?? [];
      }
      if (options?.resetOperation) return [options.resetOperation];
      if (options?.activeOperations) return options.activeOperations;
      return options?.activeOperation
        ? [
            {
              id: "running-operation",
              kind: "site_build",
              provider: "manus",
              status: "queued",
              attempt: 0,
              result: null,
              providerOperationId: null,
              providerTaskId: null,
              ...(typeof options.activeOperation === "object"
                ? options.activeOperation
                : {}),
            },
          ]
        : [];
    }
    if (table === siteDeployments) {
      return fields && "verification" in fields
        ? [
            {
              id: initialGlobalLiveDeploymentId,
              status: "active",
              verification: null,
            },
            {
              id: "50000000-0000-4000-8000-000000000099",
              status: "superseded",
              verification: { priorCheck: "passed" },
            },
          ]
        : options?.activeDeployment
          ? [options.activeDeployment]
          : [];
    }
    if (table === siteDnsRecords) {
      return options?.activeDns ? [{ id: "active-dns-record" }] : [];
    }
    if (table === visualCandidatePools) {
      return [{ id: "70000000-0000-4000-8000-000000000007" }];
    }
    if (table === workspaceSiteProfiles) return [profile];
    if (table === messages) return [{ sequence: 7 }];
    return [];
  };
  const select = (fields?: Record<string, unknown>) => {
    let table: unknown;
    const query: any = {
      from(value: unknown) {
        table = value;
        return query;
      },
      where() {
        return query;
      },
      limit() {
        return query;
      },
      orderBy() {
        return query;
      },
      for() {
        return Promise.resolve(rowsFor(table, fields));
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        return Promise.resolve(rowsFor(table, fields)).then(resolve, reject);
      },
    };
    return query;
  };
  const tx = {
    select,
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, values });
          if (table === siteProjects) Object.assign(project, values);
          if (table === deliveryTickets) Object.assign(ticket, values);
          if (table === workspaceSiteProfiles) Object.assign(profile, values);
          if (
            options?.cancelCasFails &&
            table === siteOperations &&
            values.status === "cancelled"
          ) {
            return [{ affectedRows: 0 }];
          }
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deletes.push({ table });
      },
    }),
  };
  return { tx, ticket, project, profile, updates, inserts, deletes };
}

async function pendingResetFixture(
  operationOverrides: Record<string, unknown>,
) {
  const first = fixture();
  const marker = await approveSiteOpsRebuildTicket(first.tx, {
    ticket: first.ticket,
    actorUserId: 1,
    now: new Date("2026-08-24T08:00:00.000Z"),
  });
  const operation = first.inserts.find(
    (entry) => entry.table === siteOperations,
  )!.values;
  return fixture({
    internalNote: marker!.internalNote,
    ticketStatus: "in_progress",
    resetOperation: {
      ...operation,
      result: null,
      errorCode: null,
      errorMessage: null,
      providerOperationId: null,
      providerTaskId: null,
      attempt: 1,
      ...operationOverrides,
    },
  });
}

describe("site rebuild reset approval", () => {
  it("canonicalizes reset epoch coordinates to MySQL second precision", () => {
    const parsed = parseApprovedResetUnpublishInput({
      schemaVersion: 1,
      intent: "approved_reset_unpublish",
      rebuildTicketId: ticketId,
      expectedProjectRevision: 12,
      expectedCurrentBuildId: buildId,
      expectedKnowledgeSnapshotId: snapshotId,
      expectedGlobalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      expectedMainlandLiveDeploymentId: null,
      expectedCanonicalHostname: null,
      resetAppliedProjectRevision: 13,
      resetEpochStartedAt: "2026-08-24T08:00:00.987Z",
    });

    expect(parsed?.resetEpochStartedAt).toBe("2026-08-24T08:00:00.000Z");
    expect(
      approvedResetUnpublishFreshEpochMatches(parsed!, {
        revision: 13,
        currentTaskStartedAt: new Date("2026-08-24T08:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("persists subsecond approvals with a stable database reset epoch", async () => {
    const state = fixture();
    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.987Z"),
    });
    const note = JSON.parse(result!.internalNote);

    expect(note.resetAppliedAt).toBe("2026-08-24T08:00:00.000Z");
    expect(note.frozenReset.resetEpochStartedAt).toBe(
      "2026-08-24T08:00:00.000Z",
    );
    expect(state.project.currentTaskStartedAt).toEqual(
      new Date("2026-08-24T08:00:00.000Z"),
    );
    expect(state.project.knowledgeInputEpochId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
  });

  it("rotates distinct opaque epochs for approvals in the same database second", async () => {
    const approvedAt = new Date("2026-08-24T08:00:00.987Z");
    const first = fixture();
    const second = fixture();

    await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: approvedAt,
    });
    await approveSiteOpsRebuildTicket(second.tx, {
      ticket: second.ticket,
      actorUserId: 1,
      now: approvedAt,
    });

    expect(first.project.currentTaskStartedAt).toEqual(
      second.project.currentTaskStartedAt,
    );
    expect(first.project.knowledgeInputEpochId).not.toBe(
      second.project.knowledgeInputEpochId,
    );
  });

  it("creates the local reset epoch immediately and queues old external cleanup", async () => {
    const state = fixture();
    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      projectId,
      sourceBuildId: buildId,
      resetApplied: true,
      resetPending: true,
      resetAppliedProjectRevision: 13,
    });
    expect(siteOpsRebuildResetApplied(result!.internalNote)).toBe(true);
    expect(siteOpsRebuildResetPending(result!.internalNote)).toBe(true);
    expect(JSON.parse(result!.internalNote)).toMatchObject({
      schemaVersion: 4,
      resetIntent: "approved_reset_unpublish",
      resetExpectedProjectRevision: 12,
      resetEpochDecoupled: true,
      resetAppliedProjectRevision: 13,
      minimumKnowledgeSnapshotVersion: 1,
      frozenReset: expect.objectContaining({
        expectedCurrentBuildId: buildId,
        expectedGlobalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
      }),
    });
    expect(state.project).toMatchObject({
      currentKnowledgeSnapshotId: snapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      brief: null,
      status: "draft",
      revision: 13,
      minimumKnowledgeSnapshotVersion: null,
      currentTaskStartedAt: new Date("2026-08-24T08:00:00.000Z"),
      knowledgeInputEpochId: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      ),
    });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: siteProjects }),
        expect.objectContaining({
          table: visualCandidatePools,
          values: expect.objectContaining({ status: "superseded" }),
        }),
      ]),
    );
    expect(state.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            kind: "rollback",
            status: "queued",
            provider: "aliyun_esa",
            input: expect.objectContaining({
              intent: "approved_reset_unpublish",
              expectedProjectRevision: 12,
              resetAppliedProjectRevision: 13,
            }),
          }),
        }),
        expect.objectContaining({ table: messages }),
      ]),
    );
  });

  it("preserves the current snapshot and clears a legacy freshness floor", async () => {
    const state = fixture({
      projectOverrides: { minimumKnowledgeSnapshotVersion: 17 },
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(JSON.parse(result!.internalNote)).toMatchObject({
      minimumKnowledgeSnapshotVersion: 1,
    });
    expect(state.project).toMatchObject({
      currentKnowledgeSnapshotId: snapshotId,
      minimumKnowledgeSnapshotVersion: null,
    });
  });

  it("replays an existing reset marker without changing project state again", async () => {
    const first = fixture();
    const marker = await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const replay = fixture({
      internalNote: marker!.internalNote,
      resetOperation: first.inserts.find(
        (entry) => entry.table === siteOperations,
      )!.values,
    });

    await expect(
      approveSiteOpsRebuildTicket(replay.tx, {
        ticket: replay.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetPending: true,
      resetAppliedProjectRevision: 13,
    });
    expect(replay.updates).toHaveLength(0);
    expect(replay.inserts).toHaveLength(0);
  });

  it.each(["queued", "running"] as const)(
    "idempotently replays the exact active reset operation in %s",
    async (status) => {
      const state = await pendingResetFixture({ status });

      await expect(
        approveSiteOpsRebuildTicket(state.tx, {
          ticket: state.ticket,
          actorUserId: 1,
          now: new Date("2026-08-24T09:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        resetPending: true,
        pendingReplay: true,
      });
      expect(state.updates).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
    },
  );

  it("CAS-requeues the same outcome-unknown operation for read-only reconciliation", async () => {
    const resultBoundary = {
      schemaVersion: 1,
      stage: "routine_delete_unknown",
      providerOperationId: "esa-operation-1",
    };
    const state = await pendingResetFixture({
      status: "outcome_unknown",
      errorCode: "RESET_UNPUBLISH_OUTCOME_UNKNOWN",
      result: resultBoundary,
      providerOperationId: "esa-operation-1",
    });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        allowPendingRetry: true,
      }),
    ).resolves.toMatchObject({
      resetPending: true,
      resetRequeued: true,
    });
    expect(state.updates).toEqual([
      expect.objectContaining({
        table: siteOperations,
        values: {
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: null,
          updatedAt: new Date("2026-08-24T09:00:00.000Z"),
        },
      }),
    ]);
    expect(state.updates[0]?.values).not.toHaveProperty("result");
    expect(state.updates[0]?.values).not.toHaveProperty("providerOperationId");
    expect(state.inserts).toHaveLength(0);
  });

  it("does not requeue outcome-unknown work without a persisted mutation boundary", async () => {
    const state = await pendingResetFixture({ status: "outcome_unknown" });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        allowPendingRetry: true,
      }),
    ).rejects.toThrow("缺少可核对的外部变更边界");
    expect(state.updates).toHaveLength(0);
  });

  it.each([
    "ESA_RUNTIME_DISABLED",
    "ESA_INSTANCE_NOT_CONFIGURED",
    "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
    "DATABASE_UNAVAILABLE",
  ])(
    "CAS-requeues the same pre-mutation reset operation for %s",
    async (errorCode) => {
      const state = await pendingResetFixture({
        status: "attention_required",
        errorCode,
      });

      await expect(
        approveSiteOpsRebuildTicket(state.tx, {
          ticket: state.ticket,
          actorUserId: 1,
          now: new Date("2026-08-24T09:00:00.000Z"),
          allowPendingRetry: true,
        }),
      ).resolves.toMatchObject({
        resetPending: true,
        resetRequeued: true,
      });
      expect(state.updates).toEqual([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            status: "queued",
            errorCode: null,
            errorMessage: null,
            completedAt: null,
          }),
        }),
      ]);
      expect(state.inserts).toHaveLength(0);
    },
  );

  it.each([
    {
      name: "non-whitelisted provider failure",
      operation: {
        status: "attention_required",
        errorCode: "ESA_PROVIDER_FAILED",
      },
    },
    {
      name: "persisted mutation boundary",
      operation: {
        status: "failed",
        errorCode: "DATABASE_UNAVAILABLE",
        result: { stage: "related_record_delete_unknown" },
      },
    },
    {
      name: "provider operation coordinate",
      operation: {
        status: "failed",
        errorCode: "DATABASE_UNAVAILABLE",
        providerOperationId: "esa-operation-1",
      },
    },
    {
      name: "exhausted bounded attempts",
      operation: {
        status: "attention_required",
        errorCode: "ESA_RUNTIME_DISABLED",
        attempt: 3,
      },
    },
  ])("rejects $name without requeueing", async ({ operation }) => {
    const state = await pendingResetFixture(operation);

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        allowPendingRetry: true,
      }),
    ).rejects.toThrow("不能盲目重新执行");
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("requires a current ticket revision before requeueing a terminal reset", async () => {
    const state = await pendingResetFixture({
      status: "attention_required",
      errorCode: "ESA_RUNTIME_DISABLED",
    });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        allowPendingRetry: false,
      }),
    ).rejects.toThrow("请刷新后重试");
    expect(state.updates).toHaveLength(0);
  });

  it("approves a project-scoped request before any build exists", async () => {
    const projectNote = JSON.stringify({
      schemaVersion: 3,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: null,
      knowledgeSnapshotId: snapshotId,
    });
    const state = fixture({
      internalNote: projectNote,
      targetPage: `/siteops/projects/${projectId}`,
      projectOverrides: {
        currentBuildId: null,
        status: "awaiting_visual_selection",
      },
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:30:00.000Z"),
    });

    expect(result).toMatchObject({
      projectId,
      sourceBuildId: null,
      resetApplied: true,
      resetPending: true,
      resetAppliedProjectRevision: 13,
    });
    expect(siteOpsRebuildResetApplied(result!.internalNote)).toBe(true);
    expect(state.project).toMatchObject({
      currentBuildId: null,
      currentKnowledgeSnapshotId: snapshotId,
      status: "draft",
      revision: 13,
      minimumKnowledgeSnapshotVersion: null,
    });
  });

  it("reapplies an approved project reset after the customer requests again", async () => {
    const first = fixture({
      internalNote: JSON.stringify({
        schemaVersion: 3,
        kind: "frontmind.siteops-rebuild.v1",
        projectId,
        sourceBuildId: buildId,
        knowledgeSnapshotId: snapshotId,
      }),
      targetPage: `/siteops/projects/${projectId}`,
    });
    const marker = await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const repeated = fixture({
      internalNote: marker!.internalNote,
      targetPage: `/siteops/projects/${projectId}`,
      ticketStatus: "submitted",
    });

    await expect(
      approveSiteOpsRebuildTicket(repeated.tx, {
        ticket: repeated.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T09:00:00.000Z"),
        reapply: true,
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetPending: true,
      resetAppliedProjectRevision: 13,
    });
    expect(repeated.updates).not.toHaveLength(0);
    expect(repeated.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: siteOperations }),
        expect.objectContaining({ table: messages }),
      ]),
    );
  });

  it("CAS-cancels a local Manus task and queues the approved reset", async () => {
    const state = fixture({ activeOperation: true });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T08:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetPending: true,
    });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            status: "cancelled",
            errorCode: "SITEOPS_RESET_APPROVED",
          }),
        }),
        expect.objectContaining({
          table: siteBuilds,
          values: expect.objectContaining({
            status: "cancelled",
          }),
        }),
        expect.objectContaining({
          table: siteBuilds,
          values: expect.objectContaining({ quotaState: "released" }),
        }),
        expect.objectContaining({
          table: socialPackages,
          values: expect.objectContaining({
            status: "cancelled",
          }),
        }),
        expect.objectContaining({
          table: socialPackages,
          values: expect.objectContaining({ quotaState: "released" }),
        }),
      ]),
    );
    expect(state.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            kind: "rollback",
            provider: "aliyun_esa",
            status: "queued",
          }),
        }),
        expect.objectContaining({ table: messages }),
      ]),
    );
    expect(state.project).toMatchObject({
      currentKnowledgeSnapshotId: snapshotId,
      minimumKnowledgeSnapshotVersion: null,
    });
  });

  it.each([
    { kind: "site_build", provider: "manus", status: "running" },
    { kind: "build_revision", provider: "manus", status: "outcome_unknown" },
    {
      kind: "site_build",
      provider: "manus",
      status: "attention_required",
      providerTaskId: "manus-task-needs-attention",
      result: { preserved: true },
    },
    {
      kind: "build_revision",
      provider: "manus",
      status: "failed",
      providerTaskId: "manus-task-failed",
    },
    {
      kind: "site_build",
      provider: "manus",
      status: "queued",
      providerTaskId: "manus-task-already-created",
      result: { preserved: true },
    },
    {
      kind: "social_package",
      provider: "manus",
      status: "queued",
      attempt: 1,
    },
    {
      kind: "visual_search",
      provider: "21st",
      status: "outcome_unknown",
      providerOperationId: "twenty-first-coordinate",
    },
  ])(
    "retires local lineage without discarding provider audit coordinates: $kind/$status",
    async (activeOperation) => {
      const state = fixture({ activeOperation });

      await expect(
        approveSiteOpsRebuildTicket(state.tx, {
          ticket: state.ticket,
          actorUserId: 1,
          now: new Date("2026-08-24T08:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ resetApplied: true, resetPending: true });
      const cancellation = state.updates.find(
        (entry) =>
          entry.table === siteOperations && entry.values.status === "cancelled",
      );
      expect(cancellation?.values).toMatchObject({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: "SITEOPS_RESET_APPROVED",
        completedAt: expect.any(Date),
      });
      expect(cancellation?.values).not.toHaveProperty("result");
      expect(cancellation?.values).not.toHaveProperty("providerTaskId");
      expect(cancellation?.values).not.toHaveProperty("providerOperationId");
    },
  );

  it.each([
    { status: "queued", provider: null },
    { status: "queued", provider: "unexpected-provider" },
    { status: "queued", provider: "21st", kind: "site_build" },
    { status: "queued", provider: "manus", kind: "visual_search" },
  ])(
    "fails safe for an unknown local lineage: $provider/$kind",
    async (activeOperation) => {
      const state = fixture({ activeOperation });

      await expect(
        approveSiteOpsRebuildTicket(state.tx, {
          ticket: state.ticket,
          actorUserId: 1,
          now: new Date("2026-08-24T08:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "IN_FLIGHT_OPERATION" });
      expect(state.updates).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
    },
  );

  it("aborts reset approval when a leased worker wins the cancellation CAS", async () => {
    const state = fixture({ activeOperation: true, cancelCasFails: true });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T08:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "IN_FLIGHT_OPERATION" });
    expect(state.inserts).toHaveLength(0);
    expect(
      state.updates.some(
        (entry) => entry.table === siteBuilds || entry.table === socialPackages,
      ),
    ).toBe(false);
  });

  it("approves immediately while preserving an active AliDNS operation for read-only reconciliation", async () => {
    const externalOperationId = "80000000-0000-4000-8000-000000000008";
    const state = fixture({
      activeOperation: {
        id: externalOperationId,
        provider: "aliyun_alidns",
        kind: "dns_apply",
        status: "outcome_unknown",
        attempt: 1,
      },
      activeDns: true,
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      resetPending: true,
      resetOperationId: null,
    });
    expect(JSON.parse(result!.internalNote)).toMatchObject({
      schemaVersion: 5,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: [externalOperationId],
      resetEpochDecoupled: true,
      resetAppliedProjectRevision: 13,
    });
    expect(state.project).toMatchObject({
      revision: 13,
      currentBuildId: null,
      currentKnowledgeSnapshotId: snapshotId,
      minimumKnowledgeSnapshotVersion: null,
      status: "draft",
    });
    expect(state.inserts).toEqual([
      expect.objectContaining({ table: messages }),
    ]);
  });

  it("idempotently replays the durable deferred approval without a second approval or reset task", async () => {
    const externalOperationId = "80500000-0000-4000-8000-000000000008";
    const first = fixture({
      activeOperation: {
        id: externalOperationId,
        provider: "aliyun_alidns",
        kind: "dns_apply",
        status: "running",
        attempt: 1,
      },
    });
    const approval = await approveSiteOpsRebuildTicket(first.tx, {
      ticket: first.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const replay = fixture({
      internalNote: approval!.internalNote,
      ticketStatus: "in_progress",
    });

    await expect(
      approveSiteOpsRebuildTicket(replay.tx, {
        ticket: replay.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T08:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      resetPending: true,
      resetOperationId: null,
      pendingReplay: true,
    });
    expect(replay.updates).toHaveLength(0);
    expect(replay.inserts).toHaveLength(0);
  });

  it("approves during an exact active ESA deployment without cancelling it", async () => {
    const externalOperationId = "81000000-0000-4000-8000-000000000008";
    const state = fixture({
      activeOperation: {
        id: externalOperationId,
        provider: "aliyun_esa",
        kind: "deploy",
        status: "running",
        attempt: 1,
      },
      activeDeployment: {
        id: "82000000-0000-4000-8000-000000000008",
        operationId: externalOperationId,
      },
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      resetPending: true,
      resetOperationId: null,
    });
    expect(JSON.parse(result!.internalNote)).toMatchObject({
      schemaVersion: 5,
      awaitingExternalOperationIds: [externalOperationId],
      resetEpochDecoupled: true,
      resetAppliedProjectRevision: 13,
    });
    expect(state.project).toMatchObject({
      revision: 13,
      currentBuildId: null,
      status: "draft",
    });
    expect(state.inserts).toEqual([
      expect.objectContaining({ table: messages }),
    ]);
  });

  it("approves and queues a fresh rollback for an unbound stale deployment", async () => {
    const state = fixture({
      activeDeployment: {
        id: "82500000-0000-4000-8000-000000000008",
        operationId: "82600000-0000-4000-8000-000000000008",
      },
    });

    await expect(
      approveSiteOpsRebuildTicket(state.tx, {
        ticket: state.ticket,
        actorUserId: 1,
        now: new Date("2026-08-24T08:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      resetApplied: true,
      resetPending: true,
    });
    expect(state.project).toMatchObject({ revision: 13, currentBuildId: null });
    expect(state.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            kind: "rollback",
            provider: "aliyun_esa",
            status: "queued",
          }),
        }),
        expect.objectContaining({ table: messages }),
      ]),
    );
  });

  it("durably approves reset when managed DNS access is unavailable", async () => {
    const state = fixture({ activeDns: true });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      resetApplied: true,
      resetPending: true,
      resetOperationId: null,
    });
    expect(JSON.parse(result!.internalNote)).toMatchObject({
      schemaVersion: 5,
      resetActivationState: "awaiting_external_access",
      awaitingExternalOperationIds: [],
      resetEpochDecoupled: true,
      resetAppliedProjectRevision: 13,
    });
    expect(state.inserts).toEqual([
      expect.objectContaining({ table: messages }),
    ]);
  });

  it("still retires local generation lineage while an Aliyun write drains", async () => {
    const localOperationId = "83000000-0000-4000-8000-000000000008";
    const externalOperationId = "84000000-0000-4000-8000-000000000008";
    const state = fixture({
      activeOperations: [
        {
          id: localOperationId,
          provider: "manus",
          kind: "site_build",
          status: "running",
          attempt: 2,
          result: { providerTaskId: "preserved" },
          providerOperationId: null,
          providerTaskId: "manus-task-preserved",
        },
        {
          id: externalOperationId,
          provider: "aliyun_esa",
          kind: "deploy",
          status: "running",
          attempt: 1,
          result: null,
          providerOperationId: "esa-operation-preserved",
          providerTaskId: null,
        },
      ],
      activeDeployment: {
        id: "85000000-0000-4000-8000-000000000008",
        operationId: externalOperationId,
      },
    });

    const result = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });

    expect(JSON.parse(result!.internalNote)).toMatchObject({
      schemaVersion: 5,
      awaitingExternalOperationIds: [externalOperationId],
    });
    const cancellation = state.updates.find(
      (entry) => entry.table === siteOperations,
    );
    expect(cancellation?.values).toMatchObject({
      status: "cancelled",
      errorCode: "SITEOPS_RESET_APPROVED",
    });
    expect(cancellation?.values).not.toHaveProperty("result");
    expect(cancellation?.values).not.toHaveProperty("providerOperationId");
    expect(state.inserts).toEqual([
      expect.objectContaining({ table: messages }),
    ]);
  });

  it("activates cleanup from the frozen old coordinates without blocking a new local build", async () => {
    const externalOperationId = "86000000-0000-4000-8000-000000000008";
    const approvalState = fixture({
      activeOperation: {
        id: externalOperationId,
        provider: "aliyun_esa",
        kind: "deploy",
        status: "running",
        attempt: 1,
      },
      activeDeployment: {
        id: "87000000-0000-4000-8000-000000000008",
        operationId: externalOperationId,
      },
    });
    const approval = await approveSiteOpsRebuildTicket(approvalState.tx, {
      ticket: approvalState.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const latestBuildId = "88000000-0000-4000-8000-000000000008";
    const latestSnapshotId = "89000000-0000-4000-8000-000000000008";
    const state = fixture({
      internalNote: approval!.internalNote,
      ticketStatus: "in_progress",
      projectOverrides: {
        revision: 19,
        currentBuildId: latestBuildId,
        currentKnowledgeSnapshotId: latestSnapshotId,
        globalLiveDeploymentId: null,
        canonicalHostname: null,
        currentTaskStartedAt: new Date("2026-08-24T08:00:00.000Z"),
      },
      reconciledOperations: [
        {
          id: externalOperationId,
          projectId,
          userId: 9,
          provider: "aliyun_esa",
          kind: "deploy",
          status: "succeeded",
          completedAt: new Date("2026-08-24T08:04:00.000Z"),
        },
      ],
    });

    const activated = await activateDeferredApprovedSiteOpsReset(state.tx, {
      ticketId,
      now: new Date("2026-08-24T08:05:00.000Z"),
    });

    expect(activated).toMatchObject({
      status: "activated",
      resetExpectedProjectRevision: 12,
    });
    const queuedReset = state.inserts.find(
      (entry) => entry.table === siteOperations,
    )?.values;
    expect(queuedReset).toMatchObject({
      buildId,
      kind: "rollback",
      provider: "aliyun_esa",
      status: "queued",
      input: {
        schemaVersion: 1,
        intent: "approved_reset_unpublish",
        rebuildTicketId: ticketId,
        expectedProjectRevision: 12,
        expectedCurrentBuildId: buildId,
        expectedKnowledgeSnapshotId: snapshotId,
        expectedGlobalLiveDeploymentId: "50000000-0000-4000-8000-000000000005",
        expectedMainlandLiveDeploymentId: null,
        expectedCanonicalHostname: null,
        resetAppliedProjectRevision: 13,
        resetEpochStartedAt: "2026-08-24T08:00:00.000Z",
      },
    });
    expect(JSON.parse(state.ticket.internalNote)).toMatchObject({
      schemaVersion: 4,
      resetApprovedAt: "2026-08-24T08:00:00.000Z",
      resetExpectedProjectRevision: 12,
      resetAppliedProjectRevision: 13,
      resetEpochDecoupled: true,
      sourceBuildId: buildId,
      knowledgeSnapshotId: snapshotId,
    });
    expect(
      state.updates.some(
        (entry) =>
          entry.table === siteOperations && entry.values.status === "cancelled",
      ),
    ).toBe(false);

    await expect(
      activateDeferredApprovedSiteOpsReset(state.tx, {
        ticketId,
        now: new Date("2026-08-24T08:06:00.000Z"),
      }),
    ).resolves.toEqual({ status: "not_applicable" });
    expect(
      state.inserts.filter((entry) => entry.table === siteOperations),
    ).toHaveLength(1);
  });

  it("keeps the approved reset queued while the original operation is still outcome-unknown", async () => {
    const externalOperationId = "8b000000-0000-4000-8000-000000000008";
    const deferredNote = JSON.stringify({
      schemaVersion: 5,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: buildId,
      knowledgeSnapshotId: snapshotId,
      resetIntent: "approved_reset_unpublish",
      resetApprovedAt: "2026-08-24T08:00:00.000Z",
      minimumKnowledgeSnapshotVersion: 1,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: [externalOperationId],
    });
    const state = fixture({
      internalNote: deferredNote,
      ticketStatus: "in_progress",
      reconciledOperations: [
        {
          id: externalOperationId,
          projectId,
          userId: 9,
          provider: "aliyun_alidns",
          kind: "dns_apply",
          status: "outcome_unknown",
          completedAt: null,
        },
      ],
    });

    await expect(
      activateDeferredApprovedSiteOpsReset(state.tx, {
        ticketId,
        now: new Date("2026-08-24T08:05:00.000Z"),
      }),
    ).resolves.toEqual({ status: "awaiting_external_reconciliation" });
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(JSON.parse(state.ticket.internalNote)).toMatchObject({
      schemaVersion: 5,
    });
  });

  it("moves a reconciled DNS reset to durable access wait instead of blocking", async () => {
    const externalOperationId = "8b100000-0000-4000-8000-000000000008";
    const deferredNote = JSON.stringify({
      schemaVersion: 5,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: buildId,
      knowledgeSnapshotId: snapshotId,
      resetIntent: "approved_reset_unpublish",
      resetApprovedAt: "2026-08-24T08:00:00.000Z",
      minimumKnowledgeSnapshotVersion: 1,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: [externalOperationId],
    });
    const state = fixture({
      internalNote: deferredNote,
      ticketStatus: "in_progress",
      activeDns: true,
      reconciledOperations: [
        {
          id: externalOperationId,
          projectId,
          userId: 9,
          provider: "aliyun_alidns",
          kind: "dns_apply",
          status: "succeeded",
          completedAt: new Date("2026-08-24T08:04:00.000Z"),
        },
      ],
    });

    await expect(
      activateDeferredApprovedSiteOpsReset(state.tx, {
        ticketId,
        now: new Date("2026-08-24T08:05:00.000Z"),
      }),
    ).resolves.toEqual({ status: "awaiting_external_access" });
    expect(JSON.parse(state.ticket.internalNote)).toMatchObject({
      schemaVersion: 5,
      resetActivationState: "awaiting_external_access",
      awaitingExternalOperationIds: [],
    });
    expect(state.inserts).toHaveLength(0);
  });

  it("fails safe if an unrecognized active provider appears before deferred activation", async () => {
    const externalOperationId = "8c000000-0000-4000-8000-000000000008";
    const deferredNote = JSON.stringify({
      schemaVersion: 5,
      kind: "frontmind.siteops-rebuild.v1",
      projectId,
      sourceBuildId: buildId,
      knowledgeSnapshotId: snapshotId,
      resetIntent: "approved_reset_unpublish",
      resetApprovedAt: "2026-08-24T08:00:00.000Z",
      minimumKnowledgeSnapshotVersion: 1,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: [externalOperationId],
    });
    const state = fixture({
      internalNote: deferredNote,
      ticketStatus: "in_progress",
      reconciledOperations: [
        {
          id: externalOperationId,
          projectId,
          userId: 9,
          provider: "aliyun_esa",
          kind: "deploy",
          status: "succeeded",
          completedAt: new Date("2026-08-24T08:04:00.000Z"),
        },
      ],
      activeOperations: [
        {
          id: "8d000000-0000-4000-8000-000000000008",
          provider: "unknown-provider",
          kind: "deploy",
          status: "running",
        },
      ],
    });

    await expect(
      activateDeferredApprovedSiteOpsReset(state.tx, {
        ticketId,
        now: new Date("2026-08-24T08:05:00.000Z"),
      }),
    ).resolves.toEqual({ status: "blocked" });
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("completes old external cleanup without restarting or replacing the fresh local epoch", async () => {
    const state = fixture();
    const approval = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const operation = state.inserts.find(
      (entry) => entry.table === siteOperations,
    )!.values;
    Object.assign(state.ticket, {
      status: "in_progress",
      internalNote: approval!.internalNote,
      revision: 6,
    });

    const finalized = await finalizeApprovedSiteOpsReset(state.tx, {
      operation: operation as never,
      now: new Date("2026-08-24T08:05:00.000Z"),
    });

    expect(finalized).toMatchObject({
      status: "applied",
      projectRevision: 13,
    });
    expect(state.project).toMatchObject({
      currentKnowledgeSnapshotId: snapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      canonicalHostname: null,
      currentTaskStartedAt: new Date("2026-08-24T08:00:00.000Z"),
      minimumKnowledgeSnapshotVersion: null,
      brief: null,
      status: "draft",
      revision: 13,
    });
    expect(state.profile).toMatchObject({
      domain: null,
      normalizedAsciiDomain: null,
      unicodeDisplayDomain: null,
      providerAccountUid: null,
      domainOwnershipStatus: null,
      dnsStatus: null,
      domainStatus: "not_started",
      domainVerifiedAt: null,
      siteMode: "unknown",
      icpDomainRevision: null,
      icpProvince: null,
      icpNumber: null,
      icpStatus: "not_submitted",
      icpVerifiedAt: null,
      revision: 3,
    });
    expect(state.deletes).toEqual([{ table: siteDnsRecords }]);
    expect(siteOpsRebuildResetApplied(state.ticket.internalNote)).toBe(true);
    expect(siteOpsRebuildResetPending(state.ticket.internalNote)).toBe(false);
    expect(state.ticket).toMatchObject({
      status: "completed",
      quotaState: "consumed",
      technicalDedupeKey: null,
      resolvedAt: new Date("2026-08-24T08:05:00.000Z"),
    });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: messages,
          values: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
        expect.objectContaining({
          table: websiteStyleSampleBatches,
          values: expect.objectContaining({ status: "superseded" }),
        }),
        expect.objectContaining({
          table: visualCandidatePoolPages,
          values: expect.objectContaining({ status: "superseded" }),
        }),
        expect.objectContaining({
          table: visualCandidatePools,
          values: expect.objectContaining({ status: "superseded" }),
        }),
        expect.objectContaining({
          table: siteDeployments,
          values: expect.objectContaining({
            status: "superseded",
            verification: expect.objectContaining({
              resetInvalidated: true,
            }),
          }),
        }),
      ]),
    );
    expect(
      state.updates.filter((entry) => entry.table === siteDeployments),
    ).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({
          status: "superseded",
          verification: expect.objectContaining({
            resetInvalidated: true,
          }),
        }),
      }),
    ]);
    expect(state.inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: messages,
          values: expect.objectContaining({
            content: "旧官网的外部发布与 DNS 下线确认已完成。",
            metadata: expect.objectContaining({
              siteOps: expect.objectContaining({
                payload: expect.objectContaining({
                  reset: true,
                  freshRootApplied: true,
                  unpublishCompleted: true,
                }),
              }),
            }),
          }),
        }),
        expect.objectContaining({ table: deliveryTicketEvents }),
      ]),
    );
    expect(
      state.inserts.filter((entry) => entry.table === messages),
    ).toHaveLength(2);
    expect(
      state.inserts.find((entry) => entry.table === deliveryTicketEvents)
        ?.values,
    ).toMatchObject({
      fromStatus: "in_progress",
      toStatus: "completed",
    });
  });

  it("finalizes a pre-fix subsecond reset note after MySQL truncates the project epoch", async () => {
    const state = fixture();
    const approval = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.987Z"),
    });
    const operation = state.inserts.find(
      (entry) => entry.table === siteOperations,
    )!.values;
    const legacyNote = JSON.parse(approval!.internalNote);
    legacyNote.resetAppliedAt = "2026-08-24T08:00:00.987Z";
    legacyNote.frozenReset.resetEpochStartedAt = "2026-08-24T08:00:00.987Z";
    operation.input = {
      ...(operation.input as Record<string, unknown>),
      resetEpochStartedAt: "2026-08-24T08:00:00.987Z",
    };
    Object.assign(state.ticket, {
      status: "in_progress",
      internalNote: JSON.stringify(legacyNote),
      revision: 6,
    });

    await expect(
      finalizeApprovedSiteOpsReset(state.tx, {
        operation: operation as never,
        now: new Date("2026-08-24T08:05:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "applied", projectRevision: 13 });
  });

  it("allows external cleanup after the new local epoch advances its own revision", async () => {
    const state = fixture();
    const approval = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const operation = state.inserts.find(
      (entry) => entry.table === siteOperations,
    )!.values;
    const migrationAt = new Date("2026-08-24T08:02:00.000Z");
    const newBuildId = "91000000-0000-4000-8000-000000000009";
    const newSnapshotId = "92000000-0000-4000-8000-000000000009";
    Object.assign(operation, {
      result: null,
      providerOperationId: null,
      providerTaskId: null,
    });
    Object.assign(state.project, {
      revision: 19,
      currentBuildId: newBuildId,
      currentKnowledgeSnapshotId: newSnapshotId,
      status: "approved",
      updatedAt: migrationAt,
    });
    Object.assign(state.ticket, {
      status: "in_progress",
      internalNote: approval!.internalNote,
      revision: 6,
    });

    const finalized = await finalizeApprovedSiteOpsReset(state.tx, {
      operation: operation as never,
      now: new Date("2026-08-24T08:05:00.000Z"),
    });

    expect(finalized).toMatchObject({
      status: "applied",
      projectRevision: 13,
    });
    expect(state.project).toMatchObject({
      revision: 19,
      currentBuildId: newBuildId,
      currentKnowledgeSnapshotId: newSnapshotId,
      status: "approved",
    });
  });

  it("rejects external cleanup after a newer reset epoch replaces the frozen fence", async () => {
    const state = fixture();
    const approval = await approveSiteOpsRebuildTicket(state.tx, {
      ticket: state.ticket,
      actorUserId: 1,
      now: new Date("2026-08-24T08:00:00.000Z"),
    });
    const operation = state.inserts.find(
      (entry) => entry.table === siteOperations,
    )!.values;
    Object.assign(state.project, {
      revision: 20,
      currentBuildId: null,
      currentTaskStartedAt: new Date("2026-08-24T08:02:00.000Z"),
      updatedAt: new Date("2026-08-24T08:02:00.000Z"),
    });
    Object.assign(state.ticket, {
      status: "in_progress",
      internalNote: approval!.internalNote,
      revision: 6,
    });

    const finalized = await finalizeApprovedSiteOpsReset(state.tx, {
      operation: operation as never,
      now: new Date("2026-08-24T08:05:00.000Z"),
    });

    expect(finalized).toEqual({ status: "invalidated" });
    expect(state.project).toMatchObject({
      revision: 20,
      currentBuildId: null,
      status: "draft",
    });
  });
});
