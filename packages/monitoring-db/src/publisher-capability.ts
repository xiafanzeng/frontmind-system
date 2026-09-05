export type PublisherImageCapabilityEvidence = {
  imageSupport?: "unknown" | "verified" | "unsupported" | null;
  evidenceUrl?: string | null;
  verifiedAt?: Date | null;
};

/**
 * "verified" is a security-sensitive state: it is valid only when backed by
 * a durable HTTPS evidence URL and a real verification timestamp.
 */
export function publisherImageCapabilityEvidenceBlocker(
  capability: PublisherImageCapabilityEvidence | undefined,
): string | null {
  if (capability?.imageSupport !== "verified") {
    return "Media image capability is not verified";
  }
  if (
    !capability.verifiedAt ||
    !Number.isFinite(capability.verifiedAt.getTime())
  ) {
    return "Media image capability has no verification evidence timestamp";
  }
  if (!isSafeHttpsEvidenceUrl(capability.evidenceUrl)) {
    return "Media image capability has no valid HTTPS evidence URL";
  }
  return null;
}

function isSafeHttpsEvidenceUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
