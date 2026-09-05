import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_RETENTION_MS,
  attachmentExpiresAt,
  isAttachmentExpired,
  localAttachmentPayloadExpiresAt,
} from "./attachment-expiry";

describe("attachment expiry", () => {
  it("uses a 30-day millisecond retention window", () => {
    expect(attachmentExpiresAt(1_000)).toBe(
      1_000 + CHAT_ATTACHMENT_RETENTION_MS,
    );
    expect(localAttachmentPayloadExpiresAt({}, 1_000)).toBe(
      1_000 + CHAT_ATTACHMENT_RETENTION_MS,
    );
  });

  it("honors explicit expiry timestamps and flags", () => {
    expect(isAttachmentExpired({ expiresAt: 2_000 }, 1_999)).toBe(false);
    expect(isAttachmentExpired({ expiresAt: 2_000 }, 2_000)).toBe(true);
    expect(isAttachmentExpired({ expired: true }, 1)).toBe(true);
    expect(localAttachmentPayloadExpiresAt({ expiresAt: 5_000 }, 1_000)).toBe(
      5_000,
    );
  });
});
