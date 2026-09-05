import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";
import {
  KnowledgeBasePollingCoordinator,
  knowledgeBaseObservationAcknowledgesClientRequest,
  observationNeedsPolling,
} from "./knowledge-base-coordinator";

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
  it.each(["activeTurn", "approvedPresentation", "completedTurn"] as const)(
    "accepts an ordinary reply acknowledged by %s",
    (field) => {
      const observation = {
        ...executingObservation(),
        [field]: { clientRequestId: "request-direct" },
      } as unknown as KnowledgeBaseObservationDto;

      expect(
        knowledgeBaseObservationAcknowledgesClientRequest(
          observation,
          "request-direct",
        ),
      ).toBe(true);
    },
  );

  it("does not treat a legacy takeover's pre-existing active turn as acknowledgement", () => {
    const oldActive = {
      ...executingObservation(),
      activeTurn: { clientRequestId: "request-legacy" },
    } as unknown as KnowledgeBaseObservationDto;
    const completed = {
      ...oldActive,
      completedTurn: { clientRequestId: "request-legacy" },
    } as unknown as KnowledgeBaseObservationDto;

    expect(
      knowledgeBaseObservationAcknowledgesClientRequest(
        oldActive,
        "request-legacy",
        { allowActiveTurn: false },
      ),
    ).toBe(false);
    expect(
      knowledgeBaseObservationAcknowledgesClientRequest(
        completed,
        "request-legacy",
        { allowActiveTurn: false },
      ),
    ).toBe(true);
  });

  it("stops polling once a released turn has a server-approved current presentation", () => {
    expect(observationNeedsPolling(awaitingInputObservation())).toBe(false);
  });

  it("does not poll an executing task earlier than three seconds", async () => {
    const setTimer = vi.fn(
      (_callback: () => void, _delayMs?: number) =>
        1 as unknown as ReturnType<typeof setTimeout>,
    );
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe: vi.fn().mockResolvedValue(executingObservation()),
      apply: vi.fn(),
      now: () => 1_000,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 3_000);
    coordinator.dispose();
  });

  it("does not schedule polling for a failed task even when its final ZIP is late", () => {
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

    expect(observationNeedsPolling(observation, now)).toBe(false);
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

  it("stops pending-request polling when a fast final turn is acknowledged without a presentation", async () => {
    const acknowledged = {
      ...executingObservation(),
      interaction: {
        ...executingObservation().interaction,
        interactionState: "ready_to_publish" as const,
      },
      completedTurn: {
        turnId: "final-turn",
        clientRequestId: "request-final",
        messageSequence: 9,
      },
    };
    const setTimer = vi.fn();
    const observe = vi.fn().mockResolvedValue(acknowledged);
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation", "request-final");
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(setTimer).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("polls a completed build until the same-epoch local package becomes ready", async () => {
    let scheduled: (() => void) | undefined;
    const preparing = {
      ...executingObservation(),
      stateEpoch: 9,
      contentState: "completed" as const,
      packageState: "preparing" as const,
      interaction: {
        ...executingObservation().interaction,
        interactionState: "ready_to_publish" as const,
      },
    };
    const ready = {
      ...preparing,
      packageState: "ready" as const,
      package: {
        revision: 3,
        outputItemId: null,
        fileId: null,
        filename: "knowledge-base.zip",
        mimeType: "application/zip" as const,
        sha256: "a".repeat(64),
        sizeBytes: 128,
        downloadPath: "/api/knowledge-base/artifacts/build/package",
      },
    };
    const observe = vi
      .fn()
      .mockResolvedValueOnce(preparing)
      .mockResolvedValueOnce(ready);
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply,
      now: () => 1_000,
      setTimer: ((callback: () => void) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation");
    await Promise.resolve();
    await Promise.resolve();
    expect(observationNeedsPolling(preparing)).toBe(true);
    expect(scheduled).toBeTypeOf("function");

    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(apply).toHaveBeenNthCalledWith(2, "conversation", ready);
    expect(observationNeedsPolling(ready)).toBe(false);
    expect(observe).toHaveBeenCalledTimes(2);
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
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply,
      now: () => now,
      pendingRequestGraceMs: 6_000,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation", "request-pending");
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(
      "conversation",
      expect.objectContaining({
        interaction: expect.objectContaining({
          interactionState: "awaiting_input",
        }),
      }),
    );

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
    // Polling may stop after the six-minute request grace only after the last
    // authoritative observation was applied, so optimistic `running` cannot
    // remain as the visible terminal state.
    expect(apply).toHaveBeenCalledTimes(3);
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

    // Duplicate triggers during an in-flight request do not force a follow-up
    // unless they carry a genuinely new pending request identity.
    expect(observe).toHaveBeenCalledTimes(1);
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
