export const publisherJobTypes = [
  "import_docx",
  "sync_kol_catalog",
  "archive_publisher_media_logo",
  "submit_publication_item",
  "poll_publication_item",
  "reconcile_publication_unknown",
  "purge_publisher_assets",
] as const;

export type PublisherJobType = (typeof publisherJobTypes)[number];

export interface PublisherJob {
  id: string;
  type: PublisherJobType;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  leasedUntil: Date;
}

export function publisherPayloadId(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Publisher job payload must be an object");
  }
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Publisher job payload.${key} is required`);
  }
  return value;
}
