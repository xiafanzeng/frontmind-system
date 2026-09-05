import { describe, expect, it } from "vitest";

import {
  createGeneralChatPreparationClaim,
  generalChatPreparationClaimIsStale,
  GENERAL_CHAT_PREPARATION_CLAIM_TTL_MS,
} from "./general-chat-preparation-claim";

describe("general-chat preparation claims", () => {
  it("creates unique opaque claims with the supplied update timestamp", () => {
    const first = createGeneralChatPreparationClaim(1_000);
    const second = createGeneralChatPreparationClaim(1_000);

    expect(first.claimUpdatedAtMs).toBe(1_000);
    expect(first.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second.claimToken).not.toBe(first.claimToken);
  });

  it("allows takeover only at or beyond the bounded TTL", () => {
    const now = 2_000_000;
    expect(
      generalChatPreparationClaimIsStale(
        now - GENERAL_CHAT_PREPARATION_CLAIM_TTL_MS + 1,
        now,
      ),
    ).toBe(false);
    expect(
      generalChatPreparationClaimIsStale(
        now - GENERAL_CHAT_PREPARATION_CLAIM_TTL_MS,
        now,
      ),
    ).toBe(true);
    expect(generalChatPreparationClaimIsStale(undefined, now)).toBe(true);
    expect(generalChatPreparationClaimIsStale(now + 1, now)).toBe(false);
  });
});
