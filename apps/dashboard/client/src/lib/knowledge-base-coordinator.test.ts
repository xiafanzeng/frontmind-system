import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";
import { KnowledgeBasePollingCoordinator } from "./knowledge-base-coordinator";
import { observationNeedsPolling } from "./knowledge-base-coordinator";

function executingObservation(): KnowledgeBaseObservationDto {
  return {
    stateEpoch: 1,
    generation: 1,
    authoritativeTaskId: "task-1",
    activeTurn: null,
    interaction: {
      progress: null,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: null,
    },
    approvedPresentation: null,
    package: null,
    notice: null,
    conversationVersion: 1,
  };
}

function awaitingInputObservation(
  clientRequestId = "request-completed-turn-1",
): KnowledgeBaseObservationDto {
  const currentProgress = {
    build: {
      id: "build-1",
      conversationId: "conversation",
      companyName: "FrontMind",
      status: "confirming" as const,
      revision: 1,
      currentLeafId: "1.2",
      protocolError: null,
      updatedAt: 1,
    },
    summary: {
      total: 3,
      handled: 1,
      confirmed: 1,
      directPrefilled: 0,
      pending: 1,
      current: 1,
      needsVerification: 0,
      overallPercent: 33,
    },
    branches: [],
    packageAllowed: false,
  };
  return {
    ...executingObservation(),
    stateEpoch: 2,
    activeTurn: null,
    interaction: {
      progress: currentProgress,
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    },
    approvedPresentation: {
      turnId: "completed-turn-1",
      clientRequestId,
      presentationKey: "presentation-1",
      revision: 1,
      leafId: "1.2",
      visibleMarkdown: "## 1.2\n正文",
      contentSha256: "a".repeat(64),
      imageState: "no_eligible_asset",
      resources: [],
    },
  };
}

describe("KnowledgeBasePollingCoordinator", () => {
  it("stops polling once a released turn has a server-approved current presentation", () => {
    expect(observationNeedsPolling(awaitingInputObservation())).toBe(false);
  });

  it("keeps polling the same task when its final ZIP can still arrive late", () => {
    const now = Date.now();
    const observation = {
      ...executingObservation(),
      interaction: {
        ...executingObservation().interaction,
        interactionState: "failed" as const,
      },
      notice: {
        key: "build:turn:final-package-missing",
        code: "FINAL_PACKAGE_MISSING",
        severity: "error" as const,
        message: "最终 ZIP 尚未随当前任务返回",
        retryable: true,
        turnId: "turn-1",
        createdAt: now,
      },
    };

    expect(observationNeedsPolling(observation, now)).toBe(true);
    expect(observationNeedsPolling(observation, now + 5 * 60 * 1000)).toBe(
      false,
    );
    expect(
      observationNeedsPolling({
        ...observation,
        notice: { ...observation.notice, code: "PROGRESS_PROTOCOL_INVALID" },
      }),
    ).toBe(false);
  });

  it("keeps polling an old stable observation until the pending request id is acknowledged", async () => {
    let scheduled: (() => void) | undefined;
    const oldObservation = awaitingInputObservation("request-older");
    const acceptedObservation = awaitingInputObservation("request-pending");
    const observe = vi
      .fn()
      .mockResolvedValueOnce(oldObservation)
      .mockResolvedValueOnce(acceptedObservation);
    const setTimer = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation", "request-pending");
    await Promise.resolve();
    await Promise.resolve();

    expect(observationNeedsPolling(oldObservation)).toBe(false);
    expect(setTimer).toHaveBeenCalledTimes(1);

    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(2);
    expect(setTimer).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it("does not extend the pending-request grace when the same request wakes again", async () => {
    let now = 1_000;
    let scheduled: (() => void) | undefined;
    const observe = vi
      .fn()
      .mockResolvedValue(awaitingInputObservation("request-older"));
    const setTimer = vi.fn((callback: () => void) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      now: () => now,
      pendingRequestGraceMs: 6_000,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation", "request-pending");
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimer).toHaveBeenCalledTimes(1);

    now += 6_001;
    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimer).toHaveBeenCalledTimes(1);

    coordinator.wake("conversation", "request-pending");
    await Promise.resolve();
    await Promise.resolve();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(setTimer).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it("coalesces duplicate focus/wake events and never overlaps requests", async () => {
    let release!: (value: KnowledgeBaseObservationDto) => void;
    let concurrent = 0;
    let maxConcurrent = 0;
    const observe = vi.fn(
      () =>
        new Promise<KnowledgeBaseObservationDto>((resolve) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          release = (value) => {
            concurrent -= 1;
            resolve(value);
          };
        }),
    );
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({ observe, apply });

    coordinator.register("conversation");
    coordinator.wake("conversation");
    coordinator.wake("conversation");
    coordinator.wakeAll();
    expect(observe).toHaveBeenCalledTimes(1);

    release({
      ...executingObservation(),
      interaction: {
        ...executingObservation().interaction,
        interactionState: "failed",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    // All duplicate triggers collapse into at most one follow-up request.
    expect(observe).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    coordinator.dispose();
  });

  it("drops a result after the provider unregisters/aborts its generation", async () => {
    let release!: (value: KnowledgeBaseObservationDto) => void;
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      apply,
    });
    coordinator.wake("conversation");
    coordinator.unregister("conversation");
    release(executingObservation());
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("does not retry a stable client error forever", async () => {
    const permanent = Object.assign(new Error("forbidden"), { status: 403 });
    const observe = vi.fn().mockRejectedValue(permanent);
    const onTransientError = vi.fn();
    const onPermanentError = vi.fn();
    const setTimer = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      onTransientError,
      onPermanentError,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation");
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(onPermanentError).toHaveBeenCalledWith("conversation", permanent);
    expect(onTransientError).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(coordinator.isRegistered("conversation")).toBe(false);
    coordinator.dispose();
  });

  it("gives a racing start a bounded 404 grace period, then settles permanently", async () => {
    let now = 1_000;
    let scheduled: (() => void) | undefined;
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const observe = vi.fn().mockRejectedValue(notFound);
    const onTransientError = vi.fn();
    const onPermanentError = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      onTransientError,
      onPermanentError,
      now: () => now,
      notFoundGraceMs: 15_000,
      setTimer: ((callback: () => void) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    coordinator.wake("conversation");
    await Promise.resolve();
    await Promise.resolve();

    expect(onTransientError).toHaveBeenCalledWith("conversation", notFound);
    expect(onPermanentError).not.toHaveBeenCalled();

    now += 15_001;
    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(2);
    expect(onPermanentError).toHaveBeenCalledWith("conversation", notFound);
    coordinator.dispose();
  });
});
