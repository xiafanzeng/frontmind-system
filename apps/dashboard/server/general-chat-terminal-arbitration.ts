import {
  manusV2EventMatchesGeneralChatRequest,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import { GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE } from "../shared/frontmind-general-chat-terminal";

export type GeneralChatTurnEventBinding = "bound" | "pending" | "ambiguous";

export type GeneralChatResolvedUserEventDisposition = {
  eventId: string;
  kind: "match" | "mismatch" | "unresolved";
};

export type GeneralChatResolvedTurnBinding = {
  binding: GeneralChatTurnEventBinding;
  matchedUserEventId: string | null;
  matchCount: number;
  unresolvedCount: number;
};

export type GeneralChatProjectionWatermarkCandidate = {
  id: string;
  providerEventWatermark: readonly string[];
};

export type GeneralChatProjectionSnapshot = {
  eventIds: readonly string[];
  snapshotHash: string;
  maxProviderTimestampMs: number;
};

export type GeneralChatProjectionClaimState = {
  generation: number;
  status: "idle" | "claimed" | "applied";
  claimToken: string | null;
  claimStartedAtMs: number | null;
  claimedSnapshot: GeneralChatProjectionSnapshot | null;
  appliedSnapshot: GeneralChatProjectionSnapshot | null;
};

export type GeneralChatTurnProviderEvidence = {
  binding: GeneralChatTurnEventBinding;
  events: ManusV2MessageEvent[];
  eventStatus: string | null;
  hasUserStop: boolean;
  errorType: string | null;
  errorContent: string | null;
};

export type GeneralChatSettlementStatus =
  | "running"
  | "result_pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "attention_required";

export type GeneralChatSettlement = {
  status: GeneralChatSettlementStatus;
  providerState: string;
  errorCode: string | null;
  partialResult: boolean;
  resultDeadlineAtMs: number | null;
  conflict: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? [item.text] : [];
    })
    .filter(Boolean)
    .join("\n");
  return text || null;
}

export function generalChatProviderEventEvidence(event: ManusV2MessageEvent) {
  const statusUpdate =
    event.type === "status_update" ? record(event.status_update) : null;
  const errorMessage =
    event.type === "error_message" ? record(event.error_message) : null;
  return {
    agentStatus: boundedString(statusUpdate?.agent_status, 64),
    errorType: boundedString(errorMessage?.error_type, 128),
    errorContent: boundedString(contentText(errorMessage?.content), 4_096),
    userStop: event.type === "user_stop",
  };
}

/**
 * Bind exactly one Provider user event to one Dashboard conversation turn.
 * The watermark first removes every event known before the send. Prompt and
 * Provider attachment identities then establish the unique turn boundary;
 * no status, output, stop, or error beyond the next user event can leak in.
 */
export function currentGeneralChatTurnProviderEvidence(input: {
  events: readonly ManusV2MessageEvent[];
  promptSha256: string;
  providerAttachmentFileIds: readonly string[];
  providerEventWatermark: readonly string[];
  resolvedBinding?: GeneralChatResolvedTurnBinding;
}): GeneralChatTurnProviderEvidence {
  const watermark = new Set(input.providerEventWatermark);
  const ordered = orderManusV2EventsByProviderRank(
    input.events.filter((event) => !watermark.has(event.id)),
    "oldest_first",
  );
  const matchingUserIndexes = input.resolvedBinding
    ? ordered.flatMap((event, index) =>
        event.id === input.resolvedBinding!.matchedUserEventId ? [index] : [],
      )
    : ordered.flatMap((event, index) =>
        manusV2EventMatchesGeneralChatRequest(event, {
          promptSha256: input.promptSha256,
          attachmentFileIds: input.providerAttachmentFileIds,
        })
          ? [index]
          : [],
      );
  const binding = input.resolvedBinding?.binding;
  if ((binding && binding !== "bound") || matchingUserIndexes.length !== 1) {
    return {
      binding:
        binding ?? (matchingUserIndexes.length > 1 ? "ambiguous" : "pending"),
      events: [],
      eventStatus: null,
      hasUserStop: false,
      errorType: null,
      errorContent: null,
    };
  }
  const start = matchingUserIndexes[0]!;
  const nextUserOffset = ordered
    .slice(start + 1)
    .findIndex((event) => event.type === "user_message");
  const end = nextUserOffset < 0 ? ordered.length : start + 1 + nextUserOffset;
  const scoped = ordered.slice(start, end);
  let eventStatus: string | null = null;
  let errorType: string | null = null;
  let errorContent: string | null = null;
  let hasUserStop = false;
  for (const event of scoped) {
    const evidence = generalChatProviderEventEvidence(event);
    if (evidence.agentStatus) eventStatus = evidence.agentStatus;
    if (evidence.errorType) errorType = evidence.errorType;
    if (evidence.errorContent) errorContent = evidence.errorContent;
    if (evidence.userStop) hasUserStop = true;
  }
  return {
    binding: "bound",
    events: scoped,
    eventStatus,
    hasUserStop,
    errorType,
    errorContent,
  };
}

/**
 * A Provider user event is eligible only after every visible watermark event.
 * Missing watermark rows are tolerated because Provider history may be
 * paginated or retained for less time than the Dashboard outbox.
 */
export function generalChatProjectionWatermarkScore(input: {
  providerEventId: string;
  providerEventIndex: ReadonlyMap<string, number>;
  providerEventWatermark: readonly string[];
}): number | null {
  const watermark = new Set(input.providerEventWatermark);
  if (watermark.has(input.providerEventId)) return null;
  const eventIndex = input.providerEventIndex.get(input.providerEventId);
  if (eventIndex === undefined) return null;
  for (const watermarkEventId of watermark) {
    const watermarkIndex = input.providerEventIndex.get(watermarkEventId);
    if (watermarkIndex !== undefined && watermarkIndex >= eventIndex) {
      return null;
    }
  }
  return watermark.size;
}

/**
 * Select the sole candidate whose watermark is a set-superset of every other
 * eligible candidate. Cardinality alone is insufficient: equal or non-nested
 * watermarks are deliberately ambiguous and must not project an answer.
 */
export function selectGeneralChatProjectionCandidate(input: {
  providerEventId: string;
  providerEventIndex: ReadonlyMap<string, number>;
  candidates: readonly GeneralChatProjectionWatermarkCandidate[];
}): GeneralChatProjectionWatermarkCandidate | null {
  const eligible = input.candidates.filter(
    (candidate) =>
      generalChatProjectionWatermarkScore({
        providerEventId: input.providerEventId,
        providerEventIndex: input.providerEventIndex,
        providerEventWatermark: candidate.providerEventWatermark,
      }) !== null,
  );
  const dominant = eligible.filter((candidate) => {
    const candidateWatermark = new Set(candidate.providerEventWatermark);
    return eligible.every((other) =>
      [...new Set(other.providerEventWatermark)].every((eventId) =>
        candidateWatermark.has(eventId),
      ),
    );
  });
  return dominant.length === 1 ? dominant[0]! : null;
}

/**
 * One proven user event binds a turn only when every other plausible event is
 * resolved. This prevents an early URL match from projecting while another
 * signed/descriptor-less Provider event remains unverifiable.
 */
export function generalChatTurnBindingFromDispositions(
  dispositions: readonly GeneralChatResolvedUserEventDisposition[],
): GeneralChatResolvedTurnBinding {
  const matches = dispositions.filter((item) => item.kind === "match");
  const unresolvedCount = dispositions.filter(
    (item) => item.kind === "unresolved",
  ).length;
  if (matches.length > 1) {
    return {
      binding: "ambiguous",
      matchedUserEventId: null,
      matchCount: matches.length,
      unresolvedCount,
    };
  }
  if (matches.length === 1 && unresolvedCount === 0) {
    return {
      binding: "bound",
      matchedUserEventId: matches[0]!.eventId,
      matchCount: 1,
      unresolvedCount: 0,
    };
  }
  return {
    binding: "pending",
    matchedUserEventId: null,
    matchCount: matches.length,
    unresolvedCount,
  };
}

export function generalChatAssistantProjectionShouldBeVisible(input: {
  binding: GeneralChatTurnEventBinding;
  providerEventId: string;
  assignedProviderEventIds: ReadonlySet<string>;
}) {
  return (
    input.binding === "bound" &&
    input.assignedProviderEventIds.has(input.providerEventId)
  );
}

function projectionSnapshotRelation(
  candidate: GeneralChatProjectionSnapshot,
  reference: GeneralChatProjectionSnapshot,
) {
  const candidateIds = new Set(candidate.eventIds);
  const referenceIds = new Set(reference.eventIds);
  if (![...referenceIds].every((eventId) => candidateIds.has(eventId))) {
    return "older" as const;
  }
  if (candidate.maxProviderTimestampMs < reference.maxProviderTimestampMs) {
    return "older" as const;
  }
  if (candidate.maxProviderTimestampMs > reference.maxProviderTimestampMs) {
    return "newer" as const;
  }
  return candidateIds.size > referenceIds.size
    ? ("newer" as const)
    : ("equivalent" as const);
}

/**
 * Decide whether a read snapshot may become the task's next projection owner.
 * A strict superset/newer timestamp may supersede an active claim; an equal
 * snapshot waits for that owner unless its lease is stale. Incomparable event
 * sets fail closed as older so a partial Provider read cannot hide new output.
 */
export function generalChatProjectionSnapshotClaimDecision(input: {
  candidate: GeneralChatProjectionSnapshot;
  state: GeneralChatProjectionClaimState;
  nowMs: number;
  staleAfterMs: number;
}):
  | { kind: "claim"; generation: number }
  | { kind: "in_progress" | "stale_candidate"; generation: number } {
  if (
    input.state.appliedSnapshot &&
    projectionSnapshotRelation(input.candidate, input.state.appliedSnapshot) ===
      "older"
  ) {
    return {
      kind: "stale_candidate",
      generation: input.state.generation,
    };
  }
  if (input.state.status === "claimed" && input.state.claimedSnapshot) {
    const relation = projectionSnapshotRelation(
      input.candidate,
      input.state.claimedSnapshot,
    );
    if (relation === "older") {
      return {
        kind: "stale_candidate",
        generation: input.state.generation,
      };
    }
    const claimFresh =
      input.state.claimStartedAtMs !== null &&
      input.nowMs - input.state.claimStartedAtMs < input.staleAfterMs;
    if (relation === "equivalent" && claimFresh) {
      return { kind: "in_progress", generation: input.state.generation };
    }
  }
  return { kind: "claim", generation: input.state.generation + 1 };
}

export function generalChatProjectionClaimMatches(input: {
  expectedGeneration: number;
  expectedClaimToken: string;
  state: GeneralChatProjectionClaimState;
}) {
  return (
    input.state.status === "claimed" &&
    input.state.generation === input.expectedGeneration &&
    input.state.claimToken === input.expectedClaimToken
  );
}

const NATURAL_COMPLETION = new Set([
  "stopped",
  "completed",
  "succeeded",
  "success",
  "finished",
  "done",
]);
const PROVIDER_FAILURE = new Set(["error", "failed"]);
const PROVIDER_CANCEL = new Set(["cancelled", "canceled"]);
const PROVIDER_NON_TERMINAL = new Set([
  "created",
  "pending",
  "queued",
  "running",
  "waiting",
]);

function normalizedStatus(value: string | null) {
  return value?.trim().toLowerCase() || null;
}

function semanticStatus(value: string | null) {
  if (!value) return null;
  if (PROVIDER_NON_TERMINAL.has(value)) return "running";
  if (NATURAL_COMPLETION.has(value)) return "completed";
  if (PROVIDER_FAILURE.has(value)) return "failed";
  if (PROVIDER_CANCEL.has(value)) return "cancelled";
  return `unknown:${value}`;
}

/**
 * Pure current-turn terminal arbitration. A succeeded, already-settled turn
 * is monotonic. A new turn is reopened before this function is called.
 */
export function settleGeneralChatTurn(input: {
  previousStatus: GeneralChatSettlementStatus | "queued";
  currentTurnAlreadyCompleted: boolean;
  binding: GeneralChatTurnEventBinding;
  detailStatus: string | null;
  eventStatus: string | null;
  hasUserStop: boolean;
  hasCurrentOutput: boolean;
  resultDeadlineAtMs: number | null;
  nowMs: number;
  graceMs: number;
}): GeneralChatSettlement {
  if (
    input.previousStatus === "succeeded" &&
    input.currentTurnAlreadyCompleted
  ) {
    return {
      status: "succeeded",
      providerState: "stopped",
      errorCode: null,
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: false,
    };
  }

  const detailStatus = normalizedStatus(input.detailStatus);
  const eventStatus = normalizedStatus(input.eventStatus);
  if (input.hasUserStop) {
    return {
      status: "cancelled",
      providerState: "stopped",
      errorCode: "USER_STOPPED",
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: false,
    };
  }

  const detailEventConflict = Boolean(
    detailStatus &&
      eventStatus &&
      semanticStatus(detailStatus) !== semanticStatus(eventStatus),
  );
  let resultDeadlineAtMs = input.resultDeadlineAtMs;
  if (detailEventConflict) {
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    if (input.nowMs < resultDeadlineAtMs) {
      return {
        status: "result_pending",
        providerState: "result_pending",
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs,
        conflict: true,
      };
    }
  }

  // A terminal task.detail cannot settle a turn that has not been uniquely
  // bound to its Provider user event. Eventual list consistency gets the same
  // bounded grace; persistent ambiguity is surfaced for operator attention.
  const detailTerminal = Boolean(
    detailStatus &&
      (NATURAL_COMPLETION.has(detailStatus) ||
        PROVIDER_FAILURE.has(detailStatus) ||
        PROVIDER_CANCEL.has(detailStatus)),
  );
  if (input.binding !== "bound" && detailTerminal) {
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    if (input.nowMs < resultDeadlineAtMs) {
      return {
        status: "result_pending",
        providerState: "result_pending",
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs,
        conflict: false,
      };
    }
    return {
      status: "attention_required",
      providerState: "attention_required",
      errorCode:
        input.binding === "ambiguous"
          ? "CURRENT_TURN_BINDING_AMBIGUOUS"
          : "CURRENT_TURN_BINDING_MISSING",
      partialResult: false,
      resultDeadlineAtMs,
      conflict: false,
    };
  }

  // After the bounded conflict window, task.detail is authoritative. With no
  // conflict, the current-turn event status is preferred and detail is the
  // read-model fallback when listMessages has not emitted a status yet.
  const selectedState =
    (detailEventConflict ? detailStatus : (eventStatus ?? detailStatus)) ??
    "running";
  if (selectedState === "running" || selectedState === "waiting") {
    return {
      status: "running",
      providerState: selectedState,
      errorCode: null,
      partialResult: false,
      // Preserve an expired conflict deadline while the same contradictory
      // evidence remains. Clearing it here would restart the grace window on
      // the next GET and make settlement oscillate forever.
      resultDeadlineAtMs: detailEventConflict ? resultDeadlineAtMs : null,
      conflict: detailEventConflict,
    };
  }
  if (PROVIDER_CANCEL.has(selectedState)) {
    return {
      status: "cancelled",
      providerState: selectedState,
      errorCode: "PROVIDER_TASK_CANCELLED",
      partialResult: false,
      resultDeadlineAtMs: detailEventConflict ? resultDeadlineAtMs : null,
      conflict: detailEventConflict,
    };
  }
  if (PROVIDER_FAILURE.has(selectedState)) {
    return input.hasCurrentOutput
      ? {
          status: "failed",
          providerState: selectedState,
          errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
          partialResult: true,
          resultDeadlineAtMs: detailEventConflict ? resultDeadlineAtMs : null,
          conflict: detailEventConflict,
        }
      : {
          status: "failed",
          providerState: selectedState,
          errorCode: "PROVIDER_TASK_FAILED",
          partialResult: false,
          resultDeadlineAtMs: detailEventConflict ? resultDeadlineAtMs : null,
          conflict: detailEventConflict,
        };
  }
  if (NATURAL_COMPLETION.has(selectedState)) {
    if (input.hasCurrentOutput) {
      return {
        status: "succeeded",
        providerState: selectedState,
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs: null,
        conflict: detailEventConflict,
      };
    }
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    return input.nowMs >= resultDeadlineAtMs
      ? {
          status: "failed",
          providerState: selectedState,
          errorCode: "RESULT_MISSING",
          partialResult: false,
          resultDeadlineAtMs,
          conflict: detailEventConflict,
        }
      : {
          status: "result_pending",
          providerState: "result_pending",
          errorCode: null,
          partialResult: false,
          resultDeadlineAtMs,
          conflict: detailEventConflict,
        };
  }
  return {
    status: "running",
    providerState: selectedState,
    errorCode: null,
    partialResult: false,
    resultDeadlineAtMs: detailEventConflict ? resultDeadlineAtMs : null,
    conflict: detailEventConflict,
  };
}
