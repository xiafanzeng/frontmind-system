import { describe, expect, it, vi } from "vitest";

import { ManusV2ApiError } from "../manus-v2-client";
import {
  MANUS_PROVIDER_READ_BACKOFF_MS,
  MANUS_PROVIDER_READ_RECONCILIATION_MS,
  NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
  NATIVE_SOURCE_VALIDATOR_VERSION,
  createNativeRejectedCandidateV1,
  manusProviderReadRetryDelayMs,
  nativeRejectedCandidateMatches,
  nativeFallbackReconciliationDelayMs,
  nativeInitialBaselineShouldYield,
  nativeSourceAttachmentIdentityConflicts,
  nativeSourceAttachmentRetryWindow,
  nativeSourceOutputAttachment,
  nativeFallbackPreviewBlueprint,
  nativeTrustedFallbackReason,
  nativeTrustedFallbackReconcileUntil,
  pollManusTaskEvents,
  providerResultSyncWindow,
  startNativeRepairAttemptState,
  startProviderResultSyncWindow,
  structuredResultGrace,
  shouldMaterializeNativeInitialBaseline,
} from "./manus-provider";

const taskId = "manus-task-incident";
const operationToken = "siteops-native-repair:operation-1:1";

function providerState(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    stage: "native_repair_pending" as const,
    taskId,
    nativeRepairAttempt: 1,
    ...overrides,
  };
}

function detail(status = "running") {
  return {
    taskId,
    status,
    title: null,
    taskUrl: null,
    createdAt: null,
    updatedAt: null,
    requestId: null,
    raw: { id: taskId, status },
  };
}

function transientReadError(
  operation: "task.detail" | "task.listMessages",
  input: {
    status?: number | null;
    code?: string;
    retryAfterMs?: number | null;
    transport?: boolean;
  } = {},
) {
  return new ManusV2ApiError(
    operation,
    input.status === undefined ? 502 : input.status,
    input.code ?? "HTTP_502",
    true,
    false,
    null,
    input.retryAfterMs ?? null,
    null,
    null,
    input.transport ? "connection_reset" : null,
    input.transport ? "request" : null,
    1,
    25,
    0,
  );
}

function stoppedEvents() {
  return [
    {
      id: "operation-marker",
      type: "user_message",
      timestamp: 1,
      user_message: {
        content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
      },
    },
    {
      id: "repair-result",
      type: "structured_output_result",
      timestamp: 2,
      structured_output_result: {
        success: true,
        value: { operationToken, archiveSha256: "a".repeat(64) },
      },
    },
    {
      id: "repair-stopped",
      type: "status_update",
      timestamp: 3,
      status_update: { agent_status: "stopped" },
    },
  ];
}

function client(input: {
  taskDetail: ReturnType<typeof vi.fn>;
  listAllMessages: ReturnType<typeof vi.fn>;
}) {
  return {
    ...input,
    createTask: vi.fn(),
    sendMessage: vi.fn(),
  };
}

describe("Manus bound-task read reconciliation", () => {
  it("backs a bound baseline reconciliation off from one minute to five minutes", () => {
    const createdAt = "2026-08-28T00:00:00.000Z";
    const start = Date.parse(createdAt);
    expect(nativeFallbackReconciliationDelayMs(createdAt, start)).toBe(60_000);
    expect(nativeFallbackReconciliationDelayMs(createdAt, start + 59_999)).toBe(
      60_000,
    );
    expect(nativeFallbackReconciliationDelayMs(createdAt, start + 60_000)).toBe(
      NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS,
    );
  });

  it("does not let a failed initial baseline starve the Provider read", () => {
    expect(
      nativeInitialBaselineShouldYield({
        schemaVersion: 2,
        stage: "native_source_pending",
        attempts: {
          extraction: 0,
          design: 0,
          content: 0,
          materialization: 0,
        },
        fallbackPreviewFailureCount: 1,
        fallbackPreviewNextPollAt: "2026-08-28T00:01:00.000Z",
      }),
    ).toBe(false);
  });

  it("stages the V6 first-build baseline once and lets the next sweep continue", () => {
    const base = {
      bundleSchemaVersion: 6,
      parentBuildId: null,
      hasPreview: false,
      hasFallback: false,
      nativeRepairAttempt: 0,
    } as const;
    expect(shouldMaterializeNativeInitialBaseline(base)).toBe(true);
    expect(
      shouldMaterializeNativeInitialBaseline({ ...base, hasFallback: true }),
    ).toBe(false);
    expect(
      shouldMaterializeNativeInitialBaseline({ ...base, hasPreview: true }),
    ).toBe(false);
    expect(
      shouldMaterializeNativeInitialBaseline({
        ...base,
        parentBuildId: "revision-build",
      }),
    ).toBe(false);
    expect(
      shouldMaterializeNativeInitialBaseline({
        ...base,
        nativeRepairAttempt: 1,
      }),
    ).toBe(false);
    expect(
      shouldMaterializeNativeInitialBaseline({
        ...base,
        bundleSchemaVersion: 5,
      }),
    ).toBe(false);
  });

  it("replays 23:09-23:17 without letting the prior phase stop expire the repair", async () => {
    const oldToken = "siteops-native-source:operation-1:0";
    const repairStartedAt = Date.parse("2026-08-27T23:09:34.000Z");
    const resultArrivedAt = Date.parse("2026-08-27T23:17:05.000Z");
    const staleState = {
      schemaVersion: 2 as const,
      stage: "native_repair_pending" as const,
      taskId,
      nativeRepairAttempt: 1,
      attempts: {
        extraction: 0,
        design: 0,
        content: 0,
        materialization: 0,
      },
      phaseOperationToken: oldToken,
      phaseStartedAt: new Date(repairStartedAt - 60_000).toISOString(),
      providerStoppedAt: new Date(repairStartedAt - 30_000).toISOString(),
      providerStoppedOperationToken: oldToken,
      resultPendingSince: new Date(repairStartedAt - 30_000).toISOString(),
      resultPendingOperationToken: oldToken,
    };
    const runningEvents = stoppedEvents().slice(0, 2);
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockResolvedValue(runningEvents),
    });

    const poll = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: staleState,
      now: resultArrivedAt,
    });

    expect(poll.state).toEqual({ completed: false, failed: false });
    expect(poll.providerState).toMatchObject({
      phaseOperationToken: operationToken,
      phaseStartedAt: new Date(resultArrivedAt).toISOString(),
    });
    expect(poll.providerState.providerStoppedAt).toBeUndefined();
    expect(poll.providerState.resultPendingSince).toBeUndefined();
    expect(
      structuredResultGrace(
        poll.providerState,
        false,
        Date.parse("2026-08-27T23:17:29.000Z"),
        operationToken,
      ).expired,
    ).toBe(false);
  });

  it("ignores a waiting event from an older operation-token phase", async () => {
    const olderToken = "siteops-native-source:operation-1:0";
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockResolvedValue([
        {
          id: "old-marker",
          type: "user_message",
          timestamp: 1,
          user_message: {
            content: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: olderToken })}`,
          },
        },
        {
          id: "old-waiting",
          type: "status_update",
          timestamp: 2,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "old-confirmation",
              waiting_for_event_type: "messageAskUser",
            },
          },
        },
        {
          ...stoppedEvents()[0],
          timestamp: 3,
        },
      ]),
    });

    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result.waiting).toBeNull();
    expect(result.state).toEqual({ completed: false, failed: false });
  });

  it("keeps a waiting event that belongs to the current operation-token phase", async () => {
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockResolvedValue([
        stoppedEvents()[0],
        {
          id: "current-waiting",
          type: "status_update",
          timestamp: 2,
          status_update: {
            agent_status: "waiting",
            status_detail: {
              waiting_for_event_id: "current-confirmation",
              waiting_for_event_type: "messageAskUser",
            },
          },
        },
      ]),
    });

    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result.waiting).toMatchObject({
      eventId: "current-confirmation",
      eventType: "messageAskUser",
    });
  });

  it("reuses an authenticated deterministic rejection for the exact frozen candidate only", () => {
    const coordinates = {
      taskId,
      repairAttempt: 3,
      operationToken,
      attachmentIdentity: "attachment-1:attachment:0",
      archiveSha256: "a".repeat(64),
      validatorVersion: NATIVE_SOURCE_VALIDATOR_VERSION,
    } as const;
    const verdict = createNativeRejectedCandidateV1({
      ...coordinates,
      errorCode: "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
      rejectedAt: new Date("2026-08-27T14:00:00.000Z"),
    });

    for (let sweep = 0; sweep < 20; sweep += 1) {
      expect(nativeRejectedCandidateMatches(verdict, coordinates)).toBe(true);
    }
    expect(NATIVE_REJECTED_CANDIDATE_RECONCILIATION_MS).toBe(5 * 60_000);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        attachmentIdentity: "attachment-2:attachment:0",
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        archiveSha256: "b".repeat(64),
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        repairAttempt: 2,
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(verdict, {
        ...coordinates,
        validatorVersion: "native-react-source-v2",
      }),
    ).toBe(false);
    expect(
      nativeRejectedCandidateMatches(
        { ...verdict, verdictSignature: "0".repeat(64) },
        coordinates,
      ),
    ).toBe(false);

    const compileVerdict = createNativeRejectedCandidateV1({
      ...coordinates,
      errorCode: "NATIVE_BUILD_COMPILE_FAILED",
      rejectedAt: new Date("2026-08-27T14:01:00.000Z"),
    });
    expect(nativeRejectedCandidateMatches(compileVerdict, coordinates)).toBe(
      true,
    );
  });

  it("opens trusted fallback only at the bounded root-build thresholds", () => {
    const providerReadFailureSince = new Date(1_000).toISOString();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        initialBaseline: true,
      }),
    ).toBe("initial_baseline");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        providerReadFailureSince,
        now: 1_000 + 15 * 60_000 - 1,
      }),
    ).toBeNull();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        providerReadFailureSince,
        now: 1_000 + 15 * 60_000,
      }),
    ).toBe("provider_read_delayed");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        nativeSourceReadFailureSince: providerReadFailureSince,
        now: 1_000 + 15 * 60_000,
      }),
    ).toBe("provider_read_delayed");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        stoppedGraceExpired: true,
      }),
    ).toBe("provider_stopped_without_result");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: false,
        repairBudgetExhausted: true,
      }),
    ).toBe("repair_budget_exhausted");
    expect(
      nativeTrustedFallbackReason({
        firstBuild: false,
        hasPreview: false,
        repairBudgetExhausted: true,
      }),
    ).toBeNull();
    expect(
      nativeTrustedFallbackReason({
        firstBuild: true,
        hasPreview: true,
        repairBudgetExhausted: true,
      }),
    ).toBeNull();
  });

  it("projects frozen V6 tokens into a neutral host family without using the page label", () => {
    const legacy = nativeFallbackPreviewBlueprint();
    const styled = nativeFallbackPreviewBlueprint({
      schemaVersion: 1,
      derivation: "normalized-preview-bounded-source-v1",
      previewSha256: "a".repeat(64),
      sourceTreeSha256: "b".repeat(64),
      dominantHex: "#18324a",
      canvasTone: "dark",
      contrast: "high",
      typeSystem: "editorial_serif",
      density: "spacious",
    });
    expect(legacy.heroFamily).toBe("centered_dual_cta");
    expect(styled).toMatchObject({
      heroFamily: "centered_dual_cta",
      typeSystem: "editorial_serif",
      density: "spacious",
      typographyStyle: "editorial",
      backgroundStyle: "dark",
    });
    expect(styled.palette).not.toEqual(legacy.palette);
    expect(Object.values(styled.palette)).not.toContain("#18324a");
  });

  it("anchors the 24-hour fallback reconciliation window to the original read window", () => {
    const operationCreatedAt = new Date("2026-08-27T00:00:00.000Z");
    const originalReadAt = new Date("2026-08-27T00:10:00.000Z");
    const laterFallbackAt = new Date("2026-08-27T00:25:00.000Z");
    const deadline = nativeTrustedFallbackReconcileUntil({
      providerReadFailureSince: originalReadAt.toISOString(),
      providerSyncStartedAt: laterFallbackAt.toISOString(),
      operationStartedAt: new Date("2026-08-27T00:05:00.000Z"),
      operationCreatedAt,
    });
    expect(deadline.toISOString()).toBe("2026-08-28T00:10:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        providerReadFailureSince: originalReadAt.toISOString(),
        providerSyncStartedAt: laterFallbackAt.toISOString(),
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe(deadline.toISOString());
    expect(
      nativeTrustedFallbackReconcileUntil({
        providerReadFailureSince: "2026-08-27T23:50:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:50:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        nativeSourceReadFailureSince: "2026-08-27T23:45:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:45:00.000Z");
    expect(
      nativeTrustedFallbackReconcileUntil({
        fallbackTriggeredAt: "2026-08-27T23:55:00.000Z",
        operationStartedAt: operationCreatedAt,
        operationCreatedAt,
      }).toISOString(),
    ).toBe("2026-08-28T23:55:00.000Z");
  });

  it("uses the fixed bounded schedule and honors Retry-After", () => {
    expect(MANUS_PROVIDER_READ_BACKOFF_MS).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
    ]);
    expect(
      MANUS_PROVIDER_READ_BACKOFF_MS.map((_, index) =>
        manusProviderReadRetryDelayMs({ failureCount: index + 1 }),
      ),
    ).toEqual(MANUS_PROVIDER_READ_BACKOFF_MS);
    expect(
      manusProviderReadRetryDelayMs({
        failureCount: 2,
        retryAfterMs: 75_000,
      }),
    ).toBe(75_000);
    expect(
      manusProviderReadRetryDelayMs({
        failureCount: 2,
        retryAfterMs: 900_000,
      }),
    ).toBe(300_000);
  });

  it("keeps listMessages output when detail has one transient failure", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(transientReadError("task.detail")),
      listAllMessages: vi.fn().mockResolvedValue(stoppedEvents()),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
      operationId: "operation-1",
      buildId: "build-1",
    });

    expect(result).toMatchObject({
      detailAvailable: false,
      messagesAvailable: true,
      deferred: false,
      nextPollMs: 10_000,
      providerState: {
        buildPhase: "provider_sync_delayed",
      },
    });
    expect(result.providerState.providerReadFailureCount).toBeUndefined();
    expect(result.events).toHaveLength(3);
    expect(bound.listAllMessages).toHaveBeenCalledWith({
      taskId,
      order: "desc",
      stopAfterOperationToken: operationToken,
    });
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a valid result stream when detail is explicitly rejected", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(
        transientReadError("task.detail", {
          status: 403,
          code: "HTTP_403",
        }),
      ),
      listAllMessages: vi.fn().mockResolvedValue(stoppedEvents()),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result).toMatchObject({
      detailAvailable: false,
      messagesAvailable: true,
      deferred: false,
    });
    expect(result.events.some((event) => event.id === "repair-result")).toBe(
      true,
    );
  });

  it("requires attention when detail is rejected and messages contain no result candidate", async () => {
    const bound = client({
      taskDetail: vi.fn().mockRejectedValue(
        transientReadError("task.detail", {
          status: 403,
          code: "HTTP_403",
        }),
      ),
      listAllMessages: vi.fn().mockResolvedValue([stoppedEvents()[0]]),
    });

    await expect(
      pollManusTaskEvents({
        client: bound as never,
        taskId,
        operationToken,
        providerState: providerState(),
        now: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_CONFIGURATION_ERROR",
      status: "attention_required",
      result: { taskId },
    });
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps detail output and defers when listMessages is temporarily unavailable", async () => {
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("stopped")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: 429,
          code: "HTTP_429",
          retryAfterMs: 75_000,
        }),
      ),
    });
    const result = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });

    expect(result).toMatchObject({
      detailAvailable: true,
      messagesAvailable: false,
      deferred: true,
      nextPollMs: 75_000,
      detail: { taskId, status: "stopped" },
    });
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts the delayed result eleven seconds later and clears read failures", async () => {
    const bound = client({
      taskDetail: vi.fn().mockResolvedValue(detail("stopped")),
      listAllMessages: vi
        .fn()
        .mockRejectedValueOnce(
          transientReadError("task.listMessages", {
            status: null,
            code: "TRANSPORT_UNKNOWN",
            transport: true,
          }),
        )
        .mockResolvedValueOnce(stoppedEvents()),
    });
    const first = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    const recovered = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: first.providerState,
      now: 12_000,
    });

    expect(recovered).toMatchObject({
      detailAvailable: true,
      messagesAvailable: true,
      deferred: false,
      state: { completed: true, failed: false },
      providerState: {
        buildPhase: "source_repairing",
        providerStoppedAt: new Date(12_000).toISOString(),
        providerStoppedOperationToken: operationToken,
      },
    });
    expect(recovered.providerState.providerReadFailureCount).toBeUndefined();
    expect(recovered.providerState.providerNextPollAt).toBeUndefined();
    expect(recovered.events.some((event) => event.id === "repair-result")).toBe(
      true,
    );
    expect(bound.createTask).not.toHaveBeenCalled();
    expect(bound.sendMessage).not.toHaveBeenCalled();
  });

  it("does not start stopped grace until the current phase stream also proves terminal", async () => {
    const bound = client({
      taskDetail: vi
        .fn()
        .mockResolvedValueOnce(detail("stopped"))
        .mockRejectedValueOnce(transientReadError("task.detail")),
      listAllMessages: vi
        .fn()
        .mockRejectedValueOnce(transientReadError("task.listMessages"))
        .mockResolvedValueOnce([stoppedEvents()[0]]),
    });
    const first = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    expect(first.providerState.providerStoppedAt).toBeUndefined();
    expect(first.providerState.resultPendingSince).toBeUndefined();
    const second = await pollManusTaskEvents({
      client: bound as never,
      taskId,
      operationToken,
      providerState: first.providerState,
      now: 1_000 + 5 * 60_000,
    });
    expect(second.state.completed).toBe(false);
    expect(second.providerState.providerStoppedAt).toBeUndefined();
    expect(second.providerState.resultPendingSince).toBeUndefined();
  });

  it("moves three not-found reads and a 24-hour transport outage to recoverable attention", async () => {
    const notFound = transientReadError("task.detail", {
      status: 404,
      code: "TASK_NOT_FOUND",
    });
    const notFoundClient = client({
      taskDetail: vi.fn().mockRejectedValue(notFound),
      listAllMessages: vi.fn().mockRejectedValue(notFound),
    });
    const first = await pollManusTaskEvents({
      client: notFoundClient as never,
      taskId,
      operationToken,
      providerState: providerState(),
      now: 1_000,
    });
    const second = await pollManusTaskEvents({
      client: notFoundClient as never,
      taskId,
      operationToken,
      providerState: first.providerState,
      now: 21_000,
    });
    await expect(
      pollManusTaskEvents({
        client: notFoundClient as never,
        taskId,
        operationToken,
        providerState: second.providerState,
        now: 61_000,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_PROVIDER_TASK_NOT_FOUND",
      status: "attention_required",
      result: { taskId },
    });

    const transportClient = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: null,
          code: "TRANSPORT_UNKNOWN",
          transport: true,
        }),
      ),
    });
    await expect(
      pollManusTaskEvents({
        client: transportClient as never,
        taskId,
        operationToken,
        providerState: {
          ...providerState(),
          schemaVersion: 2,
          attempts: {
            extraction: 0,
            design: 0,
            content: 0,
            materialization: 0,
          },
          providerReadFailureCount: 5,
          providerReadFailureSince: new Date(1_000).toISOString(),
        } as never,
        now: 1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      }),
    ).rejects.toMatchObject({
      code: "FRONTMIND_BUILD_PROVIDER_SYNC_ATTENTION",
      status: "attention_required",
      result: { taskId },
    });
    expect(transportClient.createTask).not.toHaveBeenCalled();
    expect(transportClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not count a partial listMessages 404 as task-not-found when detail proves the task", async () => {
    const partial404 = client({
      taskDetail: vi.fn().mockResolvedValue(detail("running")),
      listAllMessages: vi.fn().mockRejectedValue(
        transientReadError("task.listMessages", {
          status: 404,
          code: "TASK_NOT_FOUND",
        }),
      ),
    });
    let state = providerState() as never;
    for (const now of [1_000, 11_000, 31_000]) {
      const result = await pollManusTaskEvents({
        client: partial404 as never,
        taskId,
        operationToken,
        providerState: state,
        now,
      });
      state = result.providerState as never;
      expect(result.providerState.providerTaskNotFoundCount).toBeUndefined();
    }
  });

  it("bounds send-unknown reconciliation at 24 hours", () => {
    const started = startProviderResultSyncWindow(providerState(), 1_000);
    expect(started.providerSyncStartedAt).toBe(new Date(1_000).toISOString());
    const first = providerResultSyncWindow(started, 1_000);
    expect(first.expired).toBe(false);
    expect(
      providerResultSyncWindow(
        first.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS - 1,
      ).expired,
    ).toBe(false);
    expect(
      providerResultSyncWindow(
        first.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      ).expired,
    ).toBe(true);
    expect(
      providerResultSyncWindow(
        providerState(),
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
        1_000,
      ).expired,
    ).toBe(true);
  });

  it("persists bounded retries for transient existing-task attachment downloads", () => {
    const first = nativeSourceAttachmentRetryWindow(providerState(), 1_000);
    expect(first).toMatchObject({
      expired: false,
      nextPollMs: 10_000,
      state: {
        nativeSourceReadFailureCount: 1,
        nativeSourceReadFailureSince: new Date(1_000).toISOString(),
        nativeSourceNextPollAt: new Date(11_000).toISOString(),
      },
    });
    const second = nativeSourceAttachmentRetryWindow(first.state, 11_000);
    expect(second.nextPollMs).toBe(20_000);
    expect(
      nativeSourceAttachmentRetryWindow(
        second.state,
        1_000 + MANUS_PROVIDER_READ_RECONCILIATION_MS,
      ).expired,
    ).toBe(true);
  });

  it("keeps stable output file identity while accepting a refreshed signed URL", () => {
    const events = [
      stoppedEvents()[0],
      ...["old", "fresh"].map((suffix, index) => ({
        id: `attachment-${index}`,
        type: "assistant_message",
        timestamp: index + 2,
        assistant_message: {
          content: "",
          attachments: [
            {
              filename: "frontmind-site-source-v1.zip",
              content_type: "application/zip",
              file_id: "stable-output-file",
              url: `https://download.example/source.zip?signature=${suffix}`,
            },
          ],
        },
      })),
    ];
    expect(
      nativeSourceOutputAttachment(events as never, operationToken),
    ).toEqual({
      filename: "frontmind-site-source-v1.zip",
      contentType: "application/zip",
      fileId: "stable-output-file",
      eventId: "attachment-1",
      attachmentIdentity: "attachment-1:attachment:0",
      url: "https://download.example/source.zip?signature=fresh",
    });

    const conflict = events.map((event, index) =>
      index === 2
        ? {
            ...event,
            assistant_message: {
              ...(event as Record<string, any>).assistant_message,
              attachments: [
                {
                  filename: "frontmind-site-source-v1.zip",
                  content_type: "application/zip",
                  file_id: "different-output-file",
                  url: "https://download.example/source.zip?signature=other",
                },
              ],
            },
          }
        : event,
    );
    expect(() =>
      nativeSourceOutputAttachment(conflict as never, operationToken),
    ).toThrow("AI 建站返回了多个不同的完整源码包");
  });

  it("accepts bounded ZIP MIME aliases and parameters from the current phase", () => {
    for (const contentType of [
      "Application/ZIP; charset=binary",
      "application/x-zip-compressed",
      "application/octet-stream",
    ]) {
      const attachment = nativeSourceOutputAttachment(
        [
          stoppedEvents()[0],
          {
            id: `attachment-${contentType}`,
            type: "assistant_message",
            timestamp: 2,
            assistant_message: {
              attachments: [
                {
                  filename: "frontmind-site-source-v1.zip",
                  content_type: contentType,
                  file_id: `file-${contentType}`,
                  url: "https://download.example/source.zip",
                },
              ],
            },
          },
        ] as never,
        operationToken,
      );
      expect(attachment).toMatchObject({ contentType });
    }
  });

  it("falls back to event and attachment index when a later GET omits file_id", () => {
    const scope = { taskId, repairAttempt: 1, operationToken };
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorFileId: "stable-output-file",
        priorAttachmentIdentity: "attachment-1:attachment:0",
        priorEventId: "attachment-1",
        priorScope: scope,
        currentScope: scope,
        attachment: {
          fileId: null,
          eventId: "attachment-1",
          attachmentIdentity: "attachment-1:attachment:0",
        },
      }),
    ).toBe(false);
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorFileId: "stable-output-file",
        priorAttachmentIdentity: "attachment-1:attachment:0",
        priorEventId: "attachment-1",
        priorScope: scope,
        currentScope: scope,
        attachment: {
          fileId: null,
          eventId: "attachment-1",
          attachmentIdentity: "attachment-1:attachment:1",
        },
      }),
    ).toBe(true);

    const duplicateZip = [
      stoppedEvents()[0],
      {
        id: "attachment-1",
        type: "assistant_message",
        timestamp: 2,
        assistant_message: {
          attachments: ["first", "second"].map((suffix) => ({
            filename: "frontmind-site-source-v1.zip",
            content_type: "application/zip",
            url: `https://download.example/source-${suffix}.zip`,
          })),
        },
      },
    ];
    expect(() =>
      nativeSourceOutputAttachment(duplicateZip as never, operationToken),
    ).toThrow("AI 建站返回了多个不同的完整源码包");
  });

  it("scopes a frozen output identity to task, repair attempt, and token", () => {
    const priorScope = {
      taskId,
      repairAttempt: 0,
      operationToken: "siteops-native-source:operation-1:0",
    };
    const repairScope = {
      taskId,
      repairAttempt: 1,
      operationToken: "siteops-native-source:operation-1:1",
    };
    const attachment = {
      fileId: null,
      eventId: "repair-output-event",
      attachmentIdentity: "repair-output-event:attachment:0",
    };

    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorFileId: "baseline-file",
        priorAttachmentIdentity: "baseline-event:attachment:0",
        priorEventId: "baseline-event",
        priorScope,
        currentScope: repairScope,
        attachment,
      }),
    ).toBe(false);
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorAttachmentIdentity: "repair-output-event:attachment:1",
        priorEventId: "repair-output-event",
        priorScope: repairScope,
        currentScope: repairScope,
        attachment,
      }),
    ).toBe(true);
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorAttachmentIdentity: "unscoped-event:attachment:0",
        currentScope: repairScope,
        attachment,
      }),
    ).toBe(true);
    expect(
      nativeSourceAttachmentIdentityConflicts({
        priorAttachmentIdentity: "other-task-event:attachment:0",
        priorScope: { ...priorScope, taskId: "other-task" },
        currentScope: repairScope,
        attachment,
      }),
    ).toBe(true);
  });

  it("atomically resets mutable intake state for a new repair attempt", () => {
    const rejected = createNativeRejectedCandidateV1({
      taskId,
      repairAttempt: 0,
      operationToken: "siteops-native-source:operation-1:0",
      attachmentIdentity: "baseline-event:attachment:0",
      archiveSha256: "a".repeat(64),
      errorCode: "NATIVE_SOURCE_PACKAGE_JSON_INVALID",
      rejectedAt: new Date("2026-08-29T00:00:00.000Z"),
    });
    const now = Date.parse("2026-08-29T00:05:00.000Z");
    const nextToken = "siteops-native-source:operation-1:1";
    const next = startNativeRepairAttemptState({
      state: {
        schemaVersion: 2,
        stage: "native_source_pending",
        taskId,
        attempts: {
          extraction: 0,
          design: 0,
          content: 0,
          materialization: 0,
        },
        nativeSourceContractVersion: 2,
        nativeRepairAttempt: 0,
        nativeLastErrorSignature: "b".repeat(64),
        nativeRejectedCandidateV1: rejected,
        nativeSourceFileId: "baseline-file",
        nativeSourceAttachmentEventId: "baseline-event",
        nativeSourceAttachmentIdentity: "baseline-event:attachment:0",
        nativeSourceAttachmentScope: {
          taskId,
          repairAttempt: 0,
          operationToken: "siteops-native-source:operation-1:0",
        },
        nativeSourceStaging: {
          assetId: "50000000-0000-4000-8000-000000000005",
          sha256: "a".repeat(64),
          bytes: 128,
          expiresAt: "2026-08-30T00:00:00.000Z",
        },
        buildCheckpoint: "archive_validated",
        nativeSourceReadFailureCount: 3,
        nativeSourceReadFailureSince: "2026-08-29T00:01:00.000Z",
        nativeSourceNextPollAt: "2026-08-29T00:02:00.000Z",
        providerReadFailureCount: 4,
        providerReadFailureSince: "2026-08-29T00:01:00.000Z",
        providerNextPollAt: "2026-08-29T00:02:00.000Z",
        providerTaskNotFoundCount: 1,
        providerLastReadFailure: {
          operation: "task.listMessages",
          status: 503,
          code: "HTTP_503",
          retryable: true,
          retryAfterMs: null,
          transportCause: null,
          transportPhase: null,
        },
        providerSyncStartedAt: "2026-08-29T00:01:00.000Z",
        providerStoppedAt: "2026-08-29T00:02:00.000Z",
        providerStoppedOperationToken: "siteops-native-source:operation-1:0",
        resultPendingSince: "2026-08-29T00:02:00.000Z",
        resultPendingOperationToken: "siteops-native-source:operation-1:0",
      },
      taskId,
      repairAttempt: 1,
      operationToken: nextToken,
      errorSignature: "c".repeat(64),
      now,
    });

    expect(next).toMatchObject({
      stage: "native_repair_send_unknown",
      taskId,
      nativeSourceContractVersion: 2,
      nativeRepairAttempt: 1,
      nativeLastErrorSignature: "c".repeat(64),
      nativeRejectedCandidateV1: rejected,
      phaseOperationToken: nextToken,
      phaseStartedAt: new Date(now).toISOString(),
      providerSyncStartedAt: new Date(now).toISOString(),
      buildPhase: "source_repairing",
    });
    const persisted = JSON.parse(JSON.stringify(next)) as Record<
      string,
      unknown
    >;
    for (const key of [
      "nativeSourceFileId",
      "nativeSourceAttachmentEventId",
      "nativeSourceAttachmentIdentity",
      "nativeSourceAttachmentScope",
      "nativeSourceStaging",
      "buildCheckpoint",
      "nativeSourceReadFailureCount",
      "nativeSourceReadFailureSince",
      "nativeSourceNextPollAt",
      "providerReadFailureCount",
      "providerReadFailureSince",
      "providerNextPollAt",
      "providerTaskNotFoundCount",
      "providerLastReadFailure",
      "providerStoppedAt",
      "providerStoppedOperationToken",
      "resultPendingSince",
      "resultPendingOperationToken",
    ]) {
      expect(persisted).not.toHaveProperty(key);
    }
  });

  it("serializes the third native repair attempt and rejects a fourth", () => {
    const state = {
      schemaVersion: 2 as const,
      stage: "native_repair_pending" as const,
      taskId,
      attempts: {
        extraction: 0,
        design: 0,
        content: 0,
        materialization: 0,
      },
      nativeSourceContractVersion: 2 as const,
      nativeRepairAttempt: 2,
    };
    const third = startNativeRepairAttemptState({
      state,
      taskId,
      repairAttempt: 3,
      operationToken: "siteops-native-source:operation-1:3",
      errorSignature: "d".repeat(64),
      now: Date.parse("2026-08-29T00:10:00.000Z"),
    });

    expect(JSON.parse(JSON.stringify(third))).toMatchObject({
      nativeRepairAttempt: 3,
      phaseOperationToken: "siteops-native-source:operation-1:3",
      stage: "native_repair_send_unknown",
    });
    expect(() =>
      startNativeRepairAttemptState({
        state: third,
        taskId,
        repairAttempt: 4,
        operationToken: "siteops-native-source:operation-1:4",
        errorSignature: "e".repeat(64),
      }),
    ).toThrow();
  });
});
