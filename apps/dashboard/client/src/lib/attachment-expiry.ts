export const CHAT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ExpiringAttachment {
  expiresAt?: number;
  expired?: boolean;
}

/** Return the default absolute expiry for a newly-created chat attachment. */
export function attachmentExpiresAt(createdAt = Date.now()): number {
  return createdAt + CHAT_ATTACHMENT_RETENTION_MS;
}

/** Explicit server/browser expiry is authoritative. */
export function isAttachmentExpired(
  attachment: ExpiringAttachment,
  now = Date.now(),
): boolean {
  return (
    attachment.expired === true ||
    (typeof attachment.expiresAt === "number" &&
      Number.isFinite(attachment.expiresAt) &&
      attachment.expiresAt <= now)
  );
}

/**
 * Older browser messages predate expiresAt. Their in-memory payload still gets
 * the same retention window, anchored to the containing message timestamp.
 */
export function localAttachmentPayloadExpiresAt(
  attachment: ExpiringAttachment,
  messageTimestamp: number,
): number | undefined {
  if (
    typeof attachment.expiresAt === "number" &&
    Number.isFinite(attachment.expiresAt)
  ) {
    return attachment.expiresAt;
  }
  return Number.isFinite(messageTimestamp)
    ? attachmentExpiresAt(messageTimestamp)
    : undefined;
}
