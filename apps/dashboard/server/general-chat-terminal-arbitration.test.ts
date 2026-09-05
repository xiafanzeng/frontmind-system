import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  currentGeneralChatTurnProviderEvidence,
  generalChatAssistantProjectionShouldBeVisible,
  generalChatProjectionClaimMatches,
  generalChatProjectionSnapshotClaimDecision,
  generalChatTurnBindingFromDispositions,
  generalChatProviderEventEvidence,
  selectGeneralChatProjectionCandidate,
  settleGeneralChatTurn,
} from "./general-chat-terminal-arbitration";
import type { ManusV2MessageEvent } from "./manus-v2-client";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function event(
  id: string,
  type: string,
  providerOriginalRank: number,
  payload: Record<string, unknown>,
): ManusV2MessageEvent {
  return {
    id,
    type,
    timestamp: 1_000,
    providerOriginalRank,
    ...payload,
  };
}

function userEvent(
  id: string,
  providerOriginalRank: number,
  prompt: string,
  fileIds: string[] = [],
) {
  return event(id, "user_message", providerOriginalRank, {
    user_message: {
      content: prompt,
      attachments: fileIds.map((file_id) => ({ file_id })),
    },
  });
}

function statusEvent(
  id: string,
  providerOriginalRank: number,
  agentStatus: string,
) {
  return event(id, "status_update", providerOriginalRank, {
    status_update: { agent_status: agentStatus },
  });
}

const baseSettlement = {
  previousStatus: "running" as const,
  currentTurnAlreadyCompleted: false,
  binding: "bound" as const,
  detailStatus: null,
  eventStatus: null,
  hasUserStop: false,
  hasCurrentOutput: false,
  resultDeadlineAtMs: null,
  nowMs: 10_000,
  graceMs: 1_000,
};

describe("ordinary-chat current-turn Provider evidence", () => {
  it("excludes an old-turn error by watermark and respects Provider rank when timestamps collide", () => {
    const prompt = "相同的多轮问题";
    const events = [
      userEvent("old-user", 0, prompt, ["file-old"]),
      statusEvent("old-error", 1, "error"),
      userEvent("current-user", 2, prompt, ["file-new"]),
      statusEvent("current-running", 3, "running"),
      statusEvent("current-stopped", 4, "stopped"),
    ];

    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [...events].reverse(),
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: ["file-new"],
      providerEventWatermark: ["old-user", "old-error"],
    });

    expect(evidence.binding).toBe("bound");
    expect(evidence.events.map((item) => item.id)).toEqual([
      "current-user",
      "current-running",
      "current-stopped",
    ]);
    expect(evidence.eventStatus).toBe("stopped");
  });

  it("does not consume events after the next Provider user-message boundary", () => {
    const prompt = "current";
    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [
        userEvent("current-user", 0, prompt),
        statusEvent("current-running", 1, "running"),
        userEvent("next-user", 2, "next"),
        statusEvent("next-error", 3, "error"),
      ],
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: [],
      providerEventWatermark: [],
    });

    expect(evidence.events.map((item) => item.id)).toEqual([
      "current-user",
      "current-running",
    ]);
    expect(evidence.eventStatus).toBe("running");
  });

  it("requires a unique prompt-and-attachment match", () => {
    const prompt = "duplicate";
    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [
        userEvent("one", 0, prompt, ["file-1"]),
        userEvent("two", 1, prompt, ["file-1"]),
      ],
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: ["file-1"],
      providerEventWatermark: [],
    });
    expect(evidence.binding).toBe("ambiguous");
    expect(evidence.events).toEqual([]);
  });

  it("uses the same disposition binding for projection and runtime settlement", () => {
    const prompt = "url-only image";
    const events = [
      userEvent("proven", 0, prompt),
      statusEvent("stopped", 1, "stopped"),
      userEvent("descriptor-less", 2, prompt),
    ];
    const pending = generalChatTurnBindingFromDispositions([
      { eventId: "proven", kind: "match" },
      { eventId: "descriptor-less", kind: "unresolved" },
    ]);
    expect(pending).toMatchObject({
      binding: "pending",
      matchCount: 1,
      unresolvedCount: 1,
    });
    expect(
      currentGeneralChatTurnProviderEvidence({
        events,
        promptSha256: sha256(prompt),
        providerAttachmentFileIds: [],
        providerEventWatermark: [],
        resolvedBinding: pending,
      }),
    ).toMatchObject({ binding: "pending", events: [] });

    const recovered = generalChatTurnBindingFromDispositions([
      { eventId: "proven", kind: "match" },
      { eventId: "descriptor-less", kind: "mismatch" },
    ]);
    expect(recovered).toMatchObject({
      binding: "bound",
      matchedUserEventId: "proven",
    });
    expect(
      currentGeneralChatTurnProviderEvidence({
        events,
        promptSha256: sha256(prompt),
        providerAttachmentFileIds: [],
        providerEventWatermark: [],
        resolvedBinding: recovered,
      }),
    ).toMatchObject({
      binding: "bound",
      eventStatus: "stopped",
    });
  });

  it("marks two proven Provider user events ambiguous", () => {
    expect(
      generalChatTurnBindingFromDispositions([
        { eventId: "one", kind: "match" },
        { eventId: "two", kind: "match" },
      ]),
    ).toMatchObject({
      binding: "ambiguous",
      matchedUserEventId: null,
      matchCount: 2,
    });
  });

  it("hides a prior projection while binding regresses and restores it when unique again", () => {
    const assigned = new Set(["assistant-output"]);
    const visibility = (binding: "bound" | "pending" | "ambiguous") =>
      generalChatAssistantProjectionShouldBeVisible({
        binding,
        providerEventId: "assistant-output",
        assignedProviderEventIds: assigned,
      });
    expect(visibility("bound")).toBe(true);
    expect(visibility("pending")).toBe(false);
    expect(visibility("ambiguous")).toBe(false);
    expect(visibility("bound")).toBe(true);
  });

  it("selects only a unique set-superset watermark", () => {
    const indexes = new Map([
      ["old", 0],
      ["middle", 1],
      ["current", 2],
    ]);
    expect(
      selectGeneralChatProjectionCandidate({
        providerEventId: "current",
        providerEventIndex: indexes,
        candidates: [
          { id: "old-turn", providerEventWatermark: ["old"] },
          {
            id: "current-turn",
            providerEventWatermark: ["old", "middle"],
          },
        ],
      })?.id,
    ).toBe("current-turn");
    expect(
      selectGeneralChatProjectionCandidate({
        providerEventId: "current",
        providerEventIndex: indexes,
        candidates: [
          { id: "left", providerEventWatermark: ["old"] },
          { id: "right", providerEventWatermark: ["middle"] },
        ],
      }),
    ).toBeNull();
    expect(
      selectGeneralChatProjectionCandidate({
        providerEventId: "current",
        providerEventIndex: indexes,
        candidates: [
          { id: "left", providerEventWatermark: ["old"] },
          { id: "right", providerEventWatermark: ["old"] },
        ],
      }),
    ).toBeNull();
  });

  it("extracts status, error and user-stop evidence without inventing fields", () => {
    expect(
      generalChatProviderEventEvidence(statusEvent("status", 0, "waiting")),
    ).toMatchObject({ agentStatus: "waiting" });
    expect(
      generalChatProviderEventEvidence(
        event("error", "error_message", 1, {
          error_message: {
            error_type: "provider_timeout",
            content: [{ text: "request timed out" }],
          },
        }),
      ),
    ).toMatchObject({
      errorType: "provider_timeout",
      errorContent: "request timed out",
    });
    expect(
      generalChatProviderEventEvidence(event("stop", "user_stop", 2, {})),
    ).toMatchObject({ userStop: true });
  });
});

describe("ordinary-chat projection snapshot generations", () => {
  const older = {
    eventIds: ["user-1", "assistant-1"],
    snapshotHash: "a".repeat(64),
    maxProviderTimestampMs: 100,
  };
  const newer = {
    eventIds: ["user-1", "assistant-1", "user-2"],
    snapshotHash: "b".repeat(64),
    maxProviderTimestampMs: 200,
  };

  it("lets a newer snapshot supersede an active older generation", () => {
    expect(
      generalChatProjectionSnapshotClaimDecision({
        candidate: newer,
        state: {
          generation: 4,
          status: "claimed",
          claimToken: "old-token",
          claimStartedAtMs: 9_900,
          claimedSnapshot: older,
          appliedSnapshot: older,
        },
        nowMs: 10_000,
        staleAfterMs: 1_000,
      }),
    ).toEqual({ kind: "claim", generation: 5 });
  });

  it("rejects an older or partial snapshot after a newer one applied", () => {
    const state = {
      generation: 5,
      status: "applied" as const,
      claimToken: "new-token",
      claimStartedAtMs: 10_000,
      claimedSnapshot: newer,
      appliedSnapshot: newer,
    };
    for (const candidate of [
      older,
      {
        eventIds: ["user-2", "assistant-2"],
        snapshotHash: "d".repeat(64),
        maxProviderTimestampMs: 300,
      },
    ]) {
      expect(
        generalChatProjectionSnapshotClaimDecision({
          candidate,
          state,
          nowMs: 10_100,
          staleAfterMs: 1_000,
        }),
      ).toEqual({ kind: "stale_candidate", generation: 5 });
    }
  });

  it("reuses a fresh equivalent owner and permits stale takeover", () => {
    const state = {
      generation: 7,
      status: "claimed" as const,
      claimToken: "active",
      claimStartedAtMs: 10_000,
      claimedSnapshot: newer,
      appliedSnapshot: older,
    };
    expect(
      generalChatProjectionSnapshotClaimDecision({
        candidate: { ...newer, snapshotHash: "c".repeat(64) },
        state,
        nowMs: 10_100,
        staleAfterMs: 1_000,
      }),
    ).toEqual({ kind: "in_progress", generation: 7 });
    expect(
      generalChatProjectionSnapshotClaimDecision({
        candidate: newer,
        state,
        nowMs: 11_000,
        staleAfterMs: 1_000,
      }),
    ).toEqual({ kind: "claim", generation: 8 });
  });

  it("allows writes only for the exact current token and generation", () => {
    const state = {
      generation: 9,
      status: "claimed" as const,
      claimToken: "current",
      claimStartedAtMs: 10_000,
      claimedSnapshot: newer,
      appliedSnapshot: older,
    };
    expect(
      generalChatProjectionClaimMatches({
        expectedGeneration: 9,
        expectedClaimToken: "current",
        state,
      }),
    ).toBe(true);
    expect(
      generalChatProjectionClaimMatches({
        expectedGeneration: 8,
        expectedClaimToken: "old",
        state,
      }),
    ).toBe(false);
  });
});

describe("ordinary-chat current-turn terminal arbitration", () => {
  it("keeps running and waiting non-terminal", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "running",
        eventStatus: "running",
      }).status,
    ).toBe("running");
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "waiting",
        eventStatus: "waiting",
      }).status,
    ).toBe("running");
  });

  it("treats running/waiting and stopped/completed as semantic equivalents", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "running",
        eventStatus: "waiting",
      }),
    ).toMatchObject({ status: "running", conflict: false });
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "completed",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({ status: "succeeded", conflict: false });
  });

  it("settles natural stopped with authoritative current-turn output", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({
      status: "succeeded",
      errorCode: null,
      partialResult: false,
    });
  });

  it("allows an earlier error observation to recover to stopped", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "failed",
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasCurrentOutput: true,
      }).status,
    ).toBe("succeeded");
  });

  it("preserves partial output on a real error", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "error",
        eventStatus: "error",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "PARTIAL_RESULT_PRESERVED",
      partialResult: true,
    });
  });

  it("fails a real error without output", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "error",
        eventStatus: "error",
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "PROVIDER_TASK_FAILED",
      partialResult: false,
    });
  });

  it("treats user_stop as cancellation rather than natural stopped", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasUserStop: true,
        hasCurrentOutput: true,
      }),
    ).toMatchObject({ status: "cancelled", errorCode: "USER_STOPPED" });
  });

  it("uses a bounded result_pending window for detail/event conflict and then settles by detail", () => {
    const first = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "stopped",
      eventStatus: "error",
      hasCurrentOutput: true,
    });
    expect(first).toMatchObject({
      status: "result_pending",
      conflict: true,
      resultDeadlineAtMs: 11_000,
    });
    const settled = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "stopped",
      eventStatus: "error",
      hasCurrentOutput: true,
      resultDeadlineAtMs: first.resultDeadlineAtMs,
      nowMs: 11_000,
    });
    expect(settled).toMatchObject({
      status: "succeeded",
      conflict: true,
      resultDeadlineAtMs: null,
    });
  });

  it("does not restart an expired conflict window on later observations", () => {
    const first = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "running",
      eventStatus: "error",
    });
    const second = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "running",
      eventStatus: "error",
      resultDeadlineAtMs: first.resultDeadlineAtMs,
      nowMs: 11_000,
    });
    const third = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "running",
      eventStatus: "error",
      resultDeadlineAtMs: second.resultDeadlineAtMs,
      nowMs: 12_000,
    });
    expect(first.status).toBe("result_pending");
    expect(second).toMatchObject({
      status: "running",
      conflict: true,
      resultDeadlineAtMs: 11_000,
    });
    expect(third).toMatchObject({
      status: "running",
      conflict: true,
      resultDeadlineAtMs: 11_000,
    });
  });

  it("keeps a completed current turn monotonic under a later out-of-order error", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "succeeded",
        currentTurnAlreadyCompleted: true,
        detailStatus: "error",
        eventStatus: "error",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("allows a newly reserved current turn to reopen a previously successful task", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "succeeded",
        currentTurnAlreadyCompleted: false,
        detailStatus: "running",
        eventStatus: "running",
      }),
    ).toMatchObject({ status: "running", errorCode: null });
  });

  it("keeps stopped without output in the existing result grace", () => {
    const first = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "stopped",
      eventStatus: "stopped",
    });
    expect(first.status).toBe("result_pending");
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        resultDeadlineAtMs: first.resultDeadlineAtMs,
        nowMs: 11_000,
      }),
    ).toMatchObject({ status: "failed", errorCode: "RESULT_MISSING" });
  });
});
