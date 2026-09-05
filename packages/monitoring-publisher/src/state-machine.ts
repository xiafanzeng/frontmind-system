import type {
  PublicationBatchStatus,
  PublicationFundsStatus,
  PublicationItemStatus,
} from "./types.js";

const TRANSITIONS: Readonly<
  Record<PublicationItemStatus, readonly PublicationItemStatus[]>
> = {
  queued: ["submitting", "auth_blocked", "action_required"],
  submitting: [
    "processing",
    "failed",
    "auth_blocked",
    "submission_unknown",
    "action_required",
  ],
  processing: ["success", "failed", "action_required"],
  success: [],
  failed: [],
  auth_blocked: ["queued"],
  submission_unknown: ["processing", "action_required"],
  action_required: ["queued", "processing", "success", "failed"],
};

export class InvalidPublicationTransitionError extends Error {
  constructor(from: PublicationItemStatus, to: PublicationItemStatus) {
    super(`Invalid publication item transition: ${from} -> ${to}`);
    this.name = "InvalidPublicationTransitionError";
  }
}

export function canTransitionPublicationItem(
  from: PublicationItemStatus,
  to: PublicationItemStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertPublicationItemTransition(
  from: PublicationItemStatus,
  to: PublicationItemStatus,
): void {
  if (!canTransitionPublicationItem(from, to)) {
    throw new InvalidPublicationTransitionError(from, to);
  }
}

export function derivePublicationBatchStatus(
  statuses: readonly PublicationItemStatus[],
): PublicationBatchStatus {
  if (
    statuses.length === 0 ||
    statuses.every((status) => status === "queued")
  ) {
    return "queued";
  }
  if (
    statuses.some((status) =>
      ["auth_blocked", "submission_unknown", "action_required"].includes(
        status,
      ),
    )
  ) {
    return "action_required";
  }
  if (statuses.every((status) => status === "success")) return "success";
  if (statuses.every((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "success" || status === "failed")) {
    return "partial_success";
  }
  return "processing";
}

export function fundsStatusForPublicationItem(
  status: PublicationItemStatus,
  actionRequiredFundsStatus?: Extract<
    PublicationFundsStatus,
    "frozen" | "released"
  >,
): PublicationFundsStatus {
  if (status === "success") return "consumed";
  if (status === "failed" || status === "auth_blocked") return "released";
  if (status === "submission_unknown") return "frozen";
  if (status === "action_required") {
    if (!actionRequiredFundsStatus) {
      throw new TypeError(
        "action_required funds depend on whether the provider send window was entered",
      );
    }
    return actionRequiredFundsStatus;
  }
  return "reserved";
}
