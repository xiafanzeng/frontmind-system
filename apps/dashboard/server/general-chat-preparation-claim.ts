import { randomUUID } from "node:crypto";

export const GENERAL_CHAT_PREPARATION_CLAIM_TTL_MS = 10 * 60_000;

export function createGeneralChatPreparationClaim(nowMs = Date.now()) {
  return {
    claimToken: randomUUID(),
    claimUpdatedAtMs: nowMs,
  };
}

export function generalChatPreparationClaimIsStale(
  claimUpdatedAtMs: unknown,
  nowMs = Date.now(),
) {
  if (
    typeof claimUpdatedAtMs !== "number" ||
    !Number.isFinite(claimUpdatedAtMs)
  ) {
    return true;
  }
  return claimUpdatedAtMs <= nowMs - GENERAL_CHAT_PREPARATION_CLAIM_TTL_MS;
}
